import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ArchonMailboxDO, createArchonEdgeRuntime } from '../src/index.mjs';

const request = (path, body) => new Request(`https://relay.test/api/mesh/${path}`, {
  method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
});

test('durable relay retains peer joins and messages after restart and stale sync', async () => {
  const records = new Map();
  const state = { storage: {
    get: async key => structuredClone(records.get(key)),
    put: async (key, value) => records.set(key, structuredClone(value)),
  } };
  let mailbox = new ArchonMailboxDO(state);
  const created = await (await mailbox.fetch(request('teams', { name: 'Relay test' }))).json();
  const stale = { channels: [structuredClone(created.secureChannel)], teams: [structuredClone(created.team)] };
  const teamId = created.team.teamId;
  await mailbox.fetch(request('teams/join', { inviteToken: created.team.inviteToken, userId: 'peer' }));
  await Promise.all(['hello', 'world'].map(content => mailbox.fetch(request('teams/messages', { teamId, senderId: 'peer', content }))));
  mailbox = new ArchonMailboxDO(state);
  const synced = await mailbox.fetch(new Request('https://relay.test/api/mesh/sync', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(stale),
  }));
  const data = await synced.json();
  const team = data.teams.find(t => t.teamId === teamId);
  assert.ok(team.members.some(m => m.userId === 'peer'));
  for (const content of ['hello', 'world']) assert.ok(team.messages.some(m => m.content === content));
  assert.equal(team.messages.length, new Set(team.messages.map(m => m.messageId)).size);
});

test('edge routes mesh requests to durable namespace only after authentication', async () => {
  let calls = 0;
  const runtime = createArchonEdgeRuntime({ ARCHON_ADMIN_TOKEN: 'test-secret', ARCHON_MAILBOX: {
    idFromName: name => name, get: () => ({ fetch: async () => { calls++; return Response.json({ ok: true }); } }),
  } });
  assert.equal((await runtime.fetch(request('teams'))).status, 401);
  const authorized = request('teams'); authorized.headers.set('authorization', 'Bearer test-secret');
  assert.equal((await runtime.fetch(authorized)).status, 200);
  assert.equal(calls, 1);
});

test('invite-token redemption issues room-scoped peer session without ARCHON_ADMIN_TOKEN, clamps elevated roles, and enforces membership on reads/posts', async () => {
  const runtime = createArchonEdgeRuntime({ ARCHON_ADMIN_TOKEN: 'operator-passkey-secret' });

  // 1. Admin creates two teams (Team Alpha & Team Beta)
  const createTeamReq = (name) => {
    const req = request('teams', { name, ownerId: 'operator:owner' });
    req.headers.set('authorization', 'Bearer operator-passkey-secret');
    return req;
  };
  const alphaData = await (await runtime.fetch(createTeamReq('Team Alpha'))).json();
  const betaData = await (await runtime.fetch(createTeamReq('Team Beta'))).json();
  assert.equal(alphaData.ok, true);
  assert.equal(betaData.ok, true);

  // 2. Joining without a valid 1-80 char peer identity is rejected
  const emptyIdJoin = await runtime.fetch(
    request('teams/join', { inviteToken: alphaData.team.inviteToken, userId: '   ' })
  );
  assert.equal(emptyIdJoin.status, 400);

  const longIdJoin = await runtime.fetch(
    request('teams/join', { inviteToken: alphaData.team.inviteToken, userId: 'x'.repeat(81) })
  );
  assert.equal(longIdJoin.status, 400);

  // 3. Colleague redeems Team Alpha invite token WITHOUT ARCHON_ADMIN_TOKEN and attempts self-assigned 'owner' role
  const joinRes = await runtime.fetch(
    request('teams/join', {
      inviteToken: alphaData.team.inviteToken,
      userId: '  colleague:maya  ',
      role: 'owner',
    })
  );
  assert.equal(joinRes.status, 200);
  const joinData = await joinRes.json();
  assert.equal(joinData.ok, true);
  assert.ok(joinData.peerSessionToken?.startsWith('peer:'));
  assert.ok((joinRes.headers.get('set-cookie') || '').includes('archon_mesh_peer_session='));

  const mayaMember = joinData.team.members.find((m) => m.userId === 'colleague:maya');
  assert.ok(mayaMember, 'Trimmed peer handle is persisted');
  assert.equal(mayaMember.role, 'member', 'Self-assigned owner role is clamped to member');
  assert.equal(mayaMember.identityModel, 'self-declared-display-handle');

  // 4. Using the room-scoped peer session token, Maya can read ONLY Team Alpha (not Team Beta)
  const peerTeamsReq = request('teams');
  peerTeamsReq.headers.set('authorization', `Bearer ${joinData.peerSessionToken}`);
  const peerTeamsRes = await runtime.fetch(peerTeamsReq);
  assert.equal(peerTeamsRes.status, 200);
  const peerTeamsData = await peerTeamsRes.json();
  assert.equal(peerTeamsData.teams.length, 1);
  assert.equal(peerTeamsData.teams[0].teamId, alphaData.team.teamId);

  // 5. Maya can post to Team Alpha under her own handle
  const postOkReq = request('teams/messages', {
    teamId: alphaData.team.teamId,
    senderId: 'colleague:maya',
    content: 'Hello from Maya in Team Alpha!',
  });
  postOkReq.headers.set('authorization', `Bearer ${joinData.peerSessionToken}`);
  const postOkRes = await runtime.fetch(postOkReq);
  assert.equal(postOkRes.status, 201);
  const postOkData = await postOkRes.json();
  assert.equal(postOkData.message.senderId, 'colleague:maya');

  // 6. Maya CANNOT spoof another user's identity in Team Alpha
  const spoofReq = request('teams/messages', {
    teamId: alphaData.team.teamId,
    senderId: 'operator:owner',
    content: 'Attempted spoof',
  });
  spoofReq.headers.set('authorization', `Bearer ${joinData.peerSessionToken}`);
  assert.equal((await runtime.fetch(spoofReq)).status, 403);

  // 7. Maya CANNOT post to or read messages from Team Beta (cross-room isolation)
  const crossTeamPost = request('teams/messages', {
    teamId: betaData.team.teamId,
    senderId: 'colleague:maya',
    content: 'Cross-room post attempt',
  });
  crossTeamPost.headers.set('authorization', `Bearer ${joinData.peerSessionToken}`);
  assert.equal((await runtime.fetch(crossTeamPost)).status, 403);

  const crossChanRead = new Request(
    `https://relay.test/api/mesh/channels/${encodeURIComponent(betaData.team.secureChannelId)}/messages`,
    { headers: { authorization: `Bearer ${joinData.peerSessionToken}` } }
  );
  assert.equal((await runtime.fetch(crossChanRead)).status, 403);

  // 8. Non-member cannot post or read even when admin-authenticated if senderId/viewerId is not a room member
  const nonMemberPost = request('teams/messages', {
    teamId: alphaData.team.teamId,
    senderId: 'stranger:unjoined',
    content: 'Not a member',
  });
  nonMemberPost.headers.set('authorization', 'Bearer operator-passkey-secret');
  assert.equal((await runtime.fetch(nonMemberPost)).status, 403);

  const nonMemberRead = new Request(
    `https://relay.test/api/mesh/channels/${encodeURIComponent(alphaData.team.secureChannelId)}/messages?viewerId=stranger:unjoined`,
    { headers: { authorization: 'Bearer operator-passkey-secret' } }
  );
  assert.equal((await runtime.fetch(nonMemberRead)).status, 403);
});

test('mesh chat-to-seat execution: authorized dispatch, observer/ungranted-seat/spoofing denial, room isolation, deduplication, bot-loop prevention, offline recovery, and reply routing', async () => {
  const { processMeshRoomSeatExecutions } = await import('../src/dev-server.mjs');
  const runtime = createArchonEdgeRuntime({ ARCHON_ADMIN_TOKEN: 'operator-passkey-secret' });

  // Register seats on the host runtime: chief-of-staff (enabled), code-architect (enabled), maritime-quant (enabled), ops-sre (disabled)
  runtime.sharedStore.seats.set('chief-of-staff', {
    id: 'chief-of-staff',
    name: 'Chief of Staff',
    hand: 'claude',
    enabled: true,
    capabilities: ['room-coordination', 'executive-summary'],
  });
  runtime.sharedStore.seats.set('code-architect', {
    id: 'code-architect',
    name: 'Code Architect',
    hand: 'codex',
    enabled: true,
    capabilities: ['architecture-review'],
  });
  runtime.sharedStore.seats.set('maritime-quant', {
    id: 'maritime-quant',
    name: 'Maritime Quant',
    hand: 'codex',
    enabled: true,
    capabilities: ['chokepoint-analytics'],
  });
  runtime.sharedStore.seats.set('ops-sre', {
    id: 'ops-sre',
    name: 'Ops SRE',
    hand: 'claude',
    enabled: false,
    capabilities: ['sre-ops'],
  });

  // Seed two artifacts in sharedStore: one shared with the room, one private to the host workspace
  runtime.sharedStore.artifacts.set('art-shared-room-doc', {
    artifactId: 'art-shared-room-doc',
    title: 'Shared Room Brief',
    latestRevision: 1,
    metadata: { summary: 'Authorized team brief' },
  });
  runtime.sharedStore.artifacts.set('art-private-host-secret', {
    artifactId: 'art-private-host-secret',
    title: 'Private Host Dossier',
    latestRevision: 1,
    metadata: { summary: 'Top secret operator host artifact' },
  });

  const adminReq = (path, body, method = body ? 'POST' : 'GET') => {
    const req = new Request(`https://relay.test/api/mesh/${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer operator-passkey-secret',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return req;
  };

  // 1. Create Team Room with explicit seatExecutionGrants (only chief-of-staff & code-architect granted; maritime-quant NOT granted)
  const createRes = await (
    await runtime.fetch(
      adminReq('teams', {
        name: 'Quant Strategy Room',
        ownerId: 'operator:owner',
        seatExecutionGrants: ['seat:chief-of-staff', 'seat:code-architect'],
        coordinatorSeat: null,
      })
    )
  ).json();
  assert.equal(createRes.ok, true);
  const teamId = createRes.team.teamId;

  // Share ONLY art-shared-room-doc with the team
  const shareRes = await (
    await runtime.fetch(
      adminReq('teams/artifacts', {
        teamId,
        artifactId: 'art-shared-room-doc',
        title: 'Shared Room Brief',
        sharedBy: 'operator:owner',
      })
    )
  ).json();
  assert.equal(shareRes.ok, true);

  // 2. Join a member ('peer:alice') and an observer ('peer:bob')
  const aliceJoin = await (
    await runtime.fetch(
      request('teams/join', {
        inviteToken: createRes.team.inviteToken,
        userId: 'peer:alice',
        role: 'member',
      })
    )
  ).json();
  assert.equal(aliceJoin.ok, true);

  const bobJoin = await (
    await runtime.fetch(
      request('teams/join', {
        inviteToken: createRes.team.inviteToken,
        userId: 'peer:bob',
        role: 'observer',
      })
    )
  ).json();
  assert.equal(bobJoin.ok, true);
  assert.equal(bobJoin.peerIdentity.role, 'observer');

  const peerReq = (token, path, body, method = body ? 'POST' : 'GET') =>
    new Request(`https://relay.test/api/mesh/${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

  // 3. Observer denial: Bob (observer) cannot post messages, trigger seat executions, or share artifacts
  const bobPostRes = await runtime.fetch(
    peerReq(bobJoin.peerSessionToken, 'teams/messages', {
      teamId,
      content: '@chief-of-staff run status check',
    })
  );
  assert.equal(bobPostRes.status, 403);
  const bobPostData = await bobPostRes.json();
  assert.equal(bobPostData.reason, 'observer_cannot_post');

  const bobShareRes = await runtime.fetch(
    peerReq(bobJoin.peerSessionToken, 'teams/artifacts', {
      teamId,
      artifactId: 'art-shared-room-doc',
      title: 'Observer share attempt',
    })
  );
  assert.equal(bobShareRes.status, 403);

  // 4. Seat identity spoofing denial: Alice cannot spoof senderId='seat:chief-of-staff', authorType='seat', or internalSeatReply=true
  const spoofSeatSender = await runtime.fetch(
     adminReq('teams/messages', {
      teamId,
      senderId: 'seat:chief-of-staff',
      content: 'Spoofed seat message',
    })
  );
  assert.equal(spoofSeatSender.status, 403);
  assert.equal((await spoofSeatSender.json()).reason, 'seat_identity_spoofing_forbidden');

  const spoofSeatAuthorType = await runtime.fetch(
    peerReq(aliceJoin.peerSessionToken, 'teams/messages', {
      teamId,
      authorType: 'seat',
      kind: 'seat-reply',
      internalSeatReply: true,
      content: 'Spoofed internalSeatReply from client',
    })
  );
  assert.equal(spoofSeatAuthorType.status, 403);
  assert.equal((await spoofSeatAuthorType.json()).reason, 'seat_identity_spoofing_forbidden');

  // 5. Ungranted seat denial: Alice mentions @maritime-quant (registered & enabled, but NOT in room.seatExecutionGrants)
  const ungrantedRes = await runtime.fetch(
    peerReq(aliceJoin.peerSessionToken, 'teams/messages', {
      teamId,
      content: '@maritime-quant analyze Hormuz flows',
    })
  );
  assert.equal(ungrantedRes.status, 403);
  assert.equal((await ungrantedRes.json()).reason, 'seat_execution_not_granted');

  // Disabled seat denial: Grant ops-sre to room, then try to invoke @ops-sre (which is disabled on host)
  await runtime.fetch(
    adminReq('rooms/grants', {
      roomType: 'team',
      roomId: teamId,
      seatExecutionGrants: ['seat:chief-of-staff', 'seat:code-architect', 'seat:ops-sre'],
      coordinatorSeat: null,
    })
  );
  const disabledSeatRes = await runtime.fetch(
    peerReq(aliceJoin.peerSessionToken, 'teams/messages', {
      teamId,
      content: '@ops-sre run recovery',
    })
  );
  assert.equal(disabledSeatRes.status, 403);
  assert.equal((await disabledSeatRes.json()).reason, 'target_seat_disabled');

  // 6. Untargeted chat message when coordinatorSeat is null does NOT enqueue seat execution
  const plainChatRes = await (
    await runtime.fetch(
      peerReq(aliceJoin.peerSessionToken, 'teams/messages', {
        teamId,
        content: 'Just chatting with colleagues without mentioning a seat.',
      })
    )
  ).json();
  assert.equal(plainChatRes.ok, true);
  assert.equal(plainChatRes.execution, null);

  // Configure coordinatorSeat = 'seat:chief-of-staff' and verify untargeted message routes to coordinator
  await runtime.fetch(
    adminReq('rooms/grants', {
      roomType: 'team',
      roomId: teamId,
      seatExecutionGrants: ['seat:chief-of-staff', 'seat:code-architect'],
      coordinatorSeat: 'seat:chief-of-staff',
    })
  );
  const coordMsgRes = await (
    await runtime.fetch(
      peerReq(aliceJoin.peerSessionToken, 'teams/messages', {
        teamId,
        content: 'Untargeted question handled by room coordinator.',
      })
    )
  ).json();
  assert.equal(coordMsgRes.ok, true);
  assert.ok(coordMsgRes.execution);
  assert.equal(coordMsgRes.execution.targetSeat, 'seat:chief-of-staff');

  // 7. Offline host queueing & explicit alias (@architect -> seat:code-architect)
  await runtime.fetch(adminReq('host/status', { online: false, hostId: 'test-host' }));
  const offlinePostRes = await (
    await runtime.fetch(
      peerReq(aliceJoin.peerSessionToken, 'teams/messages', {
        teamId,
        content: '@architect please review the relay schema',
      })
    )
  ).json();
  assert.equal(offlinePostRes.ok, true);
  assert.equal(offlinePostRes.execution.targetSeat, 'seat:code-architect');
  assert.equal(offlinePostRes.execution.status, 'queued');
  assert.equal(offlinePostRes.execution.hostAvailability, 'offline-queued');

  // 8. Execute queued runs via processMeshRoomSeatExecutions; verify room-scoped context isolation & bot-loop prevention
  const capturedPrompts = [];
  const execOutcome1 = await processMeshRoomSeatExecutions(runtime, {
    handRunner: async ({ engine, prompt, systemPersona }) => {
      capturedPrompts.push({ engine, prompt, systemPersona });
      return {
        ok: true,
        engine,
        // Seat reply intentionally contains @chief-of-staff and @code-architect mentions to test bot-loop prevention!
        reply: `**Architecture Review Complete** by \`${engine}\`.\ncc @chief-of-staff @code-architect — no recursive loop should trigger!`,
        latencyMs: 42,
      };
    },
  });
  assert.equal(execOutcome1.ok, true);
  assert.equal(execOutcome1.processed, 2);
  assert.equal(capturedPrompts.length, 2);

  // Verify room-scoped prompt includes room transcript & shared artifact, and NEVER leaks private host artifact
  assert.ok(capturedPrompts[0].systemPersona.includes('art-shared-room-doc'));
  assert.ok(!capturedPrompts[0].systemPersona.includes('art-private-host-secret'));
  assert.ok(!capturedPrompts[0].prompt.includes('art-private-host-secret'));

  // Verify correlated seat replies were posted to the room and did NOT trigger recursive executions (bot-loop prevention)
  const teamAfterExec = runtime.mailbox.teamGroups.get(teamId);
  const seatReplies = teamAfterExec.messages.filter((m) => m.kind === 'seat-reply' && m.authorType === 'seat');
  assert.equal(seatReplies.length, 2);
  const archReply = seatReplies.find((m) => m.senderSeat === 'seat:code-architect');
  assert.ok(archReply);
  assert.equal(archReply.senderId, 'seat:code-architect');
  assert.equal(archReply.replyToMessageId, offlinePostRes.message.messageId);
  assert.equal(archReply.executionId, offlinePostRes.execution.executionId);

  // Running processor again claims 0 executions (seat replies did not enqueue new executions)
  const secondRun = await processMeshRoomSeatExecutions(runtime, {
    handRunner: async () => {
      throw new Error('Should not be invoked');
    },
  });
  assert.equal(secondRun.processed, 0);

  // 9. Duplicate sync delivery & restart recovery deduplication: stale snapshot with 'queued' status must NOT revert 'completed' execution
  const staleSnapshot = {
    teams: [
      {
        ...structuredClone(teamAfterExec),
        seatExecutions: [
          {
            ...structuredClone(offlinePostRes.execution),
            status: 'queued',
            replyMessageId: null,
          },
        ],
      },
    ],
  };
  await runtime.fetch(adminReq('sync', staleSnapshot, 'PUT'));
  const postSyncCheck = await processMeshRoomSeatExecutions(runtime, {
    handRunner: async () => {
      throw new Error('Duplicate sync must not re-trigger completed execution');
    },
  });
  assert.equal(postSyncCheck.processed, 0);

  // 10. Timeout & bounded retry recovery + error sanitization (strips /Users/... paths and Bearer tokens)
  const retryMsgRes = await (
    await runtime.fetch(
      peerReq(aliceJoin.peerSessionToken, 'teams/messages', {
        teamId,
        targetSeat: 'seat:code-architect',
        content: 'Test timeout and sanitized failure',
      })
    )
  ).json();
  assert.equal(retryMsgRes.ok, true);
  const retryExecId = retryMsgRes.execution.executionId;

  // Attempt 1 fails with sensitive path & token -> requeued because maxAttempts=2
  await processMeshRoomSeatExecutions(runtime, {
    handRunner: async () => ({
      ok: false,
      engine: 'codex',
      error: 'Fatal error at /Users/operator/archon-os/secret.key with Bearer sk-secret-1234567890',
    }),
  });
  const afterAttempt1 = runtime.mailbox.teamGroups.get(teamId).seatExecutions.find((e) => e.executionId === retryExecId);
  assert.equal(afterAttempt1.status, 'queued', 'First transient failure re-queues for bounded retry');
  assert.equal(afterAttempt1.attempts, 1);

  // Attempt 2 fails -> terminal 'failed' state and posts sanitized error reply to room
  await processMeshRoomSeatExecutions(runtime, {
    handRunner: async () => ({
      ok: false,
      engine: 'codex',
      error: 'Fatal error at /Users/operator/archon-os/secret.key with Bearer sk-secret-1234567890',
    }),
  });
  const afterAttempt2 = runtime.mailbox.teamGroups.get(teamId).seatExecutions.find((e) => e.executionId === retryExecId);
  assert.equal(afterAttempt2.status, 'failed');
  assert.ok(!afterAttempt2.lastError.includes('/Users/operator'));
  assert.ok(!afterAttempt2.lastError.includes('sk-secret-1234567890'));
  assert.ok(afterAttempt2.lastError.includes('[redacted-path]'));
  assert.ok(afterAttempt2.lastError.includes('[redacted-secret]'));

  // 11. Shared artifact room authorization: Alice can read art-shared-room-doc, but is denied art-private-host-secret
  const allowedArtRes = await runtime.fetch(
    peerReq(aliceJoin.peerSessionToken, `teams/${teamId}/artifacts/art-shared-room-doc`, null, 'GET')
  );
  assert.equal(allowedArtRes.status, 200);
  const allowedArtData = await allowedArtRes.json();
  assert.equal(allowedArtData.ok, true);
  assert.equal(allowedArtData.artifactData.artifactId, 'art-shared-room-doc');

  const deniedArtRes = await runtime.fetch(
    peerReq(aliceJoin.peerSessionToken, `teams/${teamId}/artifacts/art-private-host-secret`, null, 'GET')
  );
  assert.equal(deniedArtRes.status, 403);
  assert.equal((await deniedArtRes.json()).reason, 'artifact_not_shared_with_room');
});

test('Agora-Style Mesh Federation: Team Shared Workspace, Topic Rooms inheritance, Access Key minting & @mcp:archon-mesh', async () => {
  const adminToken = 'archon-agora-mesh-secret';
  const runtime = createArchonEdgeRuntime({
    ARCHON_ADMIN_TOKEN: adminToken,
    ARCHON_REMOTE: 'true',
  });

  const callMcp = async (tool, args = {}, bearer = adminToken) => {
    const res = await runtime.fetch(
      new Request('https://archon.example/api/mcp/archon-mesh', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
        body: JSON.stringify({ tool, args }),
      })
    );
    return { status: res.status, data: await res.json() };
  };

  // 1. Create a Team
  const createRes = await runtime.fetch(
    new Request('https://archon.example/api/mesh/teams', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        kind: 'team',
        name: 'Global Maritime Alpha Team',
        ownerId: 'operator:lead',
      }),
    })
  );
  const created = await createRes.json();
  assert.equal(created.ok, true);
  const teamId = created.team.teamId;
  assert.equal(created.team.topicRooms.length, 1);
  assert.equal(created.team.topicRooms[0].topic, 'general');

  // 2. Operator mints a scoped Access Key (ARCHON-KEY-...) for colleague via @mcp:archon-mesh
  const mintRes = await callMcp('mesh_mint_access_key', {
    teamId,
    colleagueHandle: 'peer:colleague-bob',
    role: 'member',
  });
  assert.equal(mintRes.status, 201);
  assert.equal(mintRes.data.ok, true);
  assert.match(mintRes.data.accessKey, /^ARCHON-KEY-/);
  const bobAccessKey = mintRes.data.accessKey;

  // 3. Colleague Bob joins the Team using his minted ARCHON-KEY-... via @mcp:archon-mesh
  const joinRes = await callMcp(
    'mesh_join_team',
    {
      accessKey: bobAccessKey,
      userId: 'peer:colleague-bob',
      seatId: 'seat:maritime-quant',
    },
    bobAccessKey
  );
  assert.equal(joinRes.status, 200);
  assert.equal(joinRes.data.ok, true);
  assert.equal(joinRes.data.team.teamId, teamId);

  // 4. Operator shares a Skill and an Artifact to the Team Shared Workspace
  const shareSkillRes = await callMcp('mesh_share_skill', {
    teamId,
    name: 'vlcc-ton-mile-alpha',
    version: 1,
    title: 'VLCC Ton-Mile Alpha SOP',
    skillMd: '# VLCC Ton-Mile Alpha SOP\nCompute ballast vs laden ratios.',
  });
  assert.equal(shareSkillRes.data.ok, true);
  assert.equal(shareSkillRes.data.visibleTeamWorkspace.skills.length, 1);

  const shareArtRes = await callMcp('mesh_share_artifact', {
    teamId,
    artifactId: 'art-hormuz-flow-q4',
    title: 'Hormuz Flow Q4 Brief',
    revision: 2,
    markdownContent: '# Hormuz Flow Q4\nDaily transit 20.4 mbd.',
  });
  assert.equal(shareArtRes.data.ok, true);
  assert.equal(shareArtRes.data.visibleTeamWorkspace.artifacts.length, 1);

  // 5. Colleague Bob opens a Topic Room under the Team using his ARCHON-KEY-... and posts a message
  const openRoomRes = await callMcp(
    'mesh_open_room',
    {
      teamId,
      topic: 'vlcc-freight-arb',
      title: 'VLCC Freight Arbitrage Room',
    },
    bobAccessKey
  );
  assert.equal(openRoomRes.status, 201);
  assert.equal(openRoomRes.data.ok, true);
  assert.match(openRoomRes.data.room.roomId, /^room:.*:vlcc-freight-arb$/);
  // Team shared workspace is immediately visible to the new topic room!
  assert.equal(openRoomRes.data.visibleTeamWorkspace.skills.length, 1);
  assert.equal(openRoomRes.data.visibleTeamWorkspace.artifacts.length, 1);

  const postRoomRes = await callMcp(
    'mesh_post_message',
    {
      teamId,
      topic: 'vlcc-freight-arb',
      content: 'Processed MEG -> China fixtures locally in my Archon instance using @skill:vlcc-ton-mile-alpha.',
    },
    bobAccessKey
  );
  assert.equal(postRoomRes.status, 201);
  assert.equal(postRoomRes.data.ok, true);
  assert.equal(postRoomRes.data.message.senderId, 'peer:colleague-bob');
  assert.equal(postRoomRes.data.localProcessingGuarantee.mode, 'sovereign-peer-instance');

  // 6. Reading the Topic Room returns both room messages and the inherited Team Shared Workspace
  const readRoomRes = await callMcp(
    'mesh_read_room',
    {
      teamId,
      topic: 'vlcc-freight-arb',
    },
    bobAccessKey
  );
  assert.equal(readRoomRes.status, 200);
  assert.equal(readRoomRes.data.ok, true);
  assert.equal(readRoomRes.data.room.messages.length, 2); // init + Bob's message
  assert.equal(readRoomRes.data.visibleTeamWorkspace.skills[0].name, 'vlcc-ton-mile-alpha');
  assert.equal(readRoomRes.data.visibleTeamWorkspace.artifacts[0].artifactId, 'art-hormuz-flow-q4');

  // 7. Colleague Bob fetches the shared skill via mesh_import_shared_resource for local execution
  const importRes = await callMcp(
    'mesh_import_shared_resource',
    {
      teamId,
      resourceType: 'skill',
      resourceId: 'vlcc-ton-mile-alpha@1',
    },
    bobAccessKey
  );
  assert.equal(importRes.status, 200);
  assert.equal(importRes.data.ok, true);
  assert.equal(importRes.data.resourceType, 'skill');
  assert.ok(importRes.data.resource.skillMd.includes('VLCC Ton-Mile Alpha SOP'));

  // 8. Verify ARCHON_MAILBOX Durable Object binding persists accessKeys, topicRooms, and sharedSkills across cold restarts
  const doStorage = new Map();
  const state = {
    storage: {
      get: async (k) => structuredClone(doStorage.get(k)),
      put: async (k, v) => doStorage.set(k, structuredClone(v)),
    },
  };
  let doInstance = new ArchonMailboxDO(state, { ARCHON_ADMIN_TOKEN: adminToken });
  const makeEdgeRuntime = () =>
    createArchonEdgeRuntime({
      ARCHON_ADMIN_TOKEN: adminToken,
      ARCHON_REMOTE: 'true',
      ARCHON_MAILBOX: {
        idFromName: (n) => n,
        get: () => doInstance,
      },
    });

  let edge = makeEdgeRuntime();
  const edgeCreate = await (
    await edge.fetch(
      new Request('https://archon.example/api/mesh/teams', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ name: 'Cloudflare DO Federated Team', ownerId: 'operator:cf' }),
      })
    )
  ).json();
  assert.equal(edgeCreate.ok, true);

  const edgeMint = await (
    await edge.fetch(
      new Request('https://archon.example/api/mcp/archon-mesh', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({
          tool: 'mesh_mint_access_key',
          args: { teamId: edgeCreate.team.teamId, colleagueHandle: 'peer:cf-colleague' },
        }),
      })
    )
  ).json();
  assert.equal(edgeMint.ok, true);

  // Cold-restart both the outer Worker isolate AND the ArchonMailboxDO instance
  doInstance = new ArchonMailboxDO(state, { ARCHON_ADMIN_TOKEN: adminToken });
  edge = makeEdgeRuntime();

  // Colleague uses only ARCHON-KEY-... against the fresh outer Worker isolate -> routed to DO -> verified against storage!
  const edgeJoin = await edge.fetch(
    new Request('https://archon.example/api/mcp/archon-mesh', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${edgeMint.accessKey}` },
      body: JSON.stringify({
        tool: 'mesh_join_team',
        args: { accessKey: edgeMint.accessKey, userId: 'peer:cf-colleague' },
      }),
    })
  );
  assert.equal(edgeJoin.status, 200);
  const edgeRead = await edge.fetch(
    new Request(`https://archon.example/api/mesh/teams/rooms?teamId=${encodeURIComponent(edgeCreate.team.teamId)}`, {
      headers: { authorization: `Bearer ${edgeMint.accessKey}` },
    })
  );
  assert.equal(edgeRead.status, 200);
  const edgeReadData = await edgeRead.json();
  assert.equal(edgeReadData.ok, true);
  assert.equal(edgeReadData.teamId, edgeCreate.team.teamId);
});




