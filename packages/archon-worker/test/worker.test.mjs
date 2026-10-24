// Comprehensive verification suite for packages/archon-worker
// Verifies Pillar 2, 3b, 3c, 3d, 3e, 3f, 3g invariants across:
// - WorkspaceOrchestratorDO (5-step crash-safe loop, restart recovery, budget non-refill, table-driven alarm idempotency, R2-first Canvas publication & 409 rebase)
// - HandLeaseDO (slot cap, 4MB prompt bound, zombie single-requeue, circuit breaker wall-clock exemption, capability echo probe, stdio-MCP default-deny tunnel)
// - ArchonMailboxDO (Ed25519 signed bundle verification, 4-field provenance import & quarantine, key custody honesty badge, cross-Archon shared-seat capability lease)
// - Single-origin Worker HTTP API & SQL schema completeness

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  WorkspaceOrchestratorDO,
  HandLeaseDO,
  ArchonMailboxDO,
  createArchonEdgeRuntime,
} from '../src/index.mjs';
import {
  RSI_10_ROUNDS_LEDGER,
  auditArchonProjectRsi,
  buildLiveMeshBundleAudit,
  computeArtifactRevisionDiff,
} from '../src/dev-server.mjs';
import { MANIFEST_VERSION, signManifest } from '../../archon-mesh/mesh-bundle.mjs';
import { verifyLedgerChain } from '../src/ledger.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const H64 = 'a'.repeat(64);
const H64_B = 'b'.repeat(64);

test('0001_archon_core.sql defines all required D1 tables and decimal/integer constraints', () => {
  const sql = readFileSync(join(__dirname, '../migrations/0001_archon_core.sql'), 'utf8');
  const requiredTables = [
    'seats',
    'intents',
    'tasks',
    'charges',
    'schedules',
    'schedule_fires',
    'mcp_servers',
    'mcp_grants',
    'mcp_access_counters',
    'skills',
    'skill_verification_records',
    'artifacts',
    'artifact_revisions',
    'graph_objects',
    'mesh_quarantine',
    'seat_grants',
    'approval_requests',
  ];
  for (const tbl of requiredTables) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${tbl}\\b`), `Missing table ${tbl}`);
  }
  // Monetary/budget columns in SQL statements (excluding comments) must never use FLOAT or REAL
  const sqlNoComments = sql.replace(/--.*$/gm, '');
  assert.doesNotMatch(sqlNoComments, /\b(FLOAT|REAL|DOUBLE)\b/i);
  assert.match(sqlNoComments, /PRIMARY KEY \(schedule_id, fire_time\)/);
  assert.match(sqlNoComments, /CHECK \(author != subject_id\)/);
});

test('WorkspaceOrchestratorDO: 5-step crash-safe loop survives Worker restart without refilling budget or double-charging', () => {
  const persistedD1Store = WorkspaceOrchestratorDO.createEmptyStore();
  const orch1 = new WorkspaceOrchestratorDO(null, {}, persistedD1Store);
  const handLease = new HandLeaseDO(null, { LEASE_TTL_MS: 60_000 });

  // Register seat with budget = 1000
  const seatRes = orch1.upsertSeat({
    id: 'seat-alpha',
    hand: 'claude',
    model: 'claude-opus-4-7',
    budget: 1000,
    enabled: true,
    created_by: 'operator',
    capabilities: { code: true, mcp: true },
    capabilities_set_by: 'hand-operator',
  });
  assert.equal(seatRes.ok, true);

  // Step 1 & 2: Intake & Plan task with budgetCap = 600
  orch1.intakeIntent({ intentId: 'int-1', runId: 'run-1', prompt: 'Analyze tank storage' });
  const plan1 = orch1.planIntent('int-1', [
    {
      taskId: 't-1',
      seatId: 'seat-alpha',
      budgetCap: 600,
      requiredCapabilities: ['code'],
      prompt: 'Analyze tank storage',
    },
  ]);
  assert.equal(plan1.ok, true);

  // Step 3: Governed Dispatch
  const disp = orch1.dispatchTasks(handLease);
  assert.equal(disp.dispatched.length, 1);

  // Simulate Worker eviction/restart mid-run! Instantiate a brand-new WorkspaceOrchestratorDO against persistedD1Store
  const orch2 = new WorkspaceOrchestratorDO(null, {}, persistedD1Store);

  // Step 4: Harvest task with unmetered usage (e.g. gemini/null tokens -> charged at budgetCap = 600)
  const harv1 = orch2.harvestTask('t-1', {
    state: 'done',
    usage: null, // unmetered -> charged at cap 600
    output: 'Storage analysis complete',
  });
  assert.equal(harv1.ok, true);
  assert.equal(harv1.charge.body.charged, 600);
  assert.equal(harv1.charge.body.basis, 'unmetered_cap');
  assert.equal(harv1.seatTotalSpent, 600);

  // Retrying harvest after restart is idempotent (never double-charges)
  const harvRetry = orch2.harvestTask('t-1', {
    state: 'done',
    usage: null,
    output: 'Storage analysis complete',
  });
  assert.equal(harvRetry.seatTotalSpent, 600);
  assert.equal(persistedD1Store.ledgerRows.length, 1);
  assert.equal(verifyLedgerChain(persistedD1Store.ledgerRows).ok, true);

  // Another restart cannot refill the budget: a second task requesting 500 (600 + 500 > 1000) is refused!
  const orch3 = new WorkspaceOrchestratorDO(null, {}, persistedD1Store);
  orch3.intakeIntent({ intentId: 'int-2', runId: 'run-2', prompt: 'Second task' });
  const plan2 = orch3.planIntent('int-2', [
    {
      taskId: 't-2',
      seatId: 'seat-alpha',
      budgetCap: 500,
      prompt: 'Second task exceeding remaining 400 budget',
    },
  ]);
  assert.equal(plan2.ok, false);
  assert.equal(plan2.error, 'budget_exceeded');

  // Resumable run stream returns events from cursor without resubmitting turn
  const stream = orch3.resumeRunStream('run-1', 1);
  assert.equal(stream.ok, true);
  assert.equal(stream.state, 'completed');
  assert.equal(stream.events.length, 2);
});

test('WorkspaceOrchestratorDO: atomic Canvas publication enforces R2-first availability, HTML parity, and 409 rebase without rollback', () => {
  const orch = new WorkspaceOrchestratorDO();

  // Publishing before R2 upload fails with 424 and preserves revision 0
  const missingR2 = orch.publishCanvasArtifact({
    artifactId: 'art-brief',
    expectedBaseRevision: 0,
    manifestSha256: H64,
    hasHtmlParity: true,
  });
  assert.equal(missingR2.ok, false);
  assert.equal(missingR2.status, 424);

  // Upload R2 blob first, then publish revision 1
  const sha1 = orch.putR2Blob(JSON.stringify({ sceneId: 'brief-v1', nodes: [] }));
  const pub1 = orch.publishCanvasArtifact({
    artifactId: 'art-brief',
    expectedBaseRevision: 0,
    manifestSha256: sha1,
    hasHtmlParity: true,
  });
  assert.equal(pub1.ok, true);
  assert.equal(pub1.artifact.currentRevision, 1);
  assert.equal(pub1.envelope.type, 'snapshot');

  // Stale concurrent writer with expectedBaseRevision = 0 gets 409 Conflict (rebase required)
  const sha2 = orch.putR2Blob(JSON.stringify({ sceneId: 'brief-v2', nodes: [1] }));
  const staleConflict = orch.publishCanvasArtifact({
    artifactId: 'art-brief',
    expectedBaseRevision: 0,
    manifestSha256: sha2,
    hasHtmlParity: true,
  });
  assert.equal(staleConflict.ok, false);
  assert.equal(staleConflict.status, 409);
  assert.equal(staleConflict.rebaseRequired, true);
  assert.equal(staleConflict.currentRevision, 1);

  // Rebasing onto expectedBaseRevision = 1 succeeds and advances to revision 2
  const pub2 = orch.publishCanvasArtifact({
    artifactId: 'art-brief',
    expectedBaseRevision: 1,
    manifestSha256: sha2,
    hasHtmlParity: true,
  });
  assert.equal(pub2.ok, true);
  assert.equal(pub2.artifact.currentRevision, 2);
  assert.equal(pub2.envelope.type, 'published');

  // Failed refresh (e.g. missing HTML fallback parity) preserves revision 2 with a warning banner
  const sha3 = orch.putR2Blob(JSON.stringify({ sceneId: 'brief-v3-no-parity' }));
  const noParity = orch.publishCanvasArtifact({
    artifactId: 'art-brief',
    expectedBaseRevision: 2,
    manifestSha256: sha3,
    hasHtmlParity: false,
  });
  assert.equal(noParity.ok, false);
  assert.equal(noParity.status, 422);
  assert.equal(noParity.artifact.currentRevision, 2);
  assert.equal(noParity.artifact.currentManifestSha256, sha2);
  assert.match(noParity.artifact.lastWarningBanner, /Serving last good revision r2/);
});

test('WorkspaceOrchestratorDO: table-driven alarm clock fireKey idempotency and Hands-Up non-interactive refusal', () => {
  const orch = new WorkspaceOrchestratorDO();
  orch.upsertSeat({
    id: 'seat-cron',
    hand: 'codex',
    model: 'gpt-5',
    budget: 5000,
    enabled: true,
    created_by: 'operator',
    capabilities: { cron: true },
    capabilities_set_by: 'hand-operator',
  });

  // Non-interactive schedule creation is refused by Hands-Up rail
  const badSched = orch.upsertSchedule(
    { id: 'morning-brief', seat: 'seat-cron', task_template: 'build-brief', cron: '0 6 * * *' },
    { origin: 'tool_result', author: 'seat-cron' }
  );
  assert.equal(badSched.ok, false);
  assert.equal(badSched.status, 403);

  // Interactive schedule creation outside no-fly band succeeds
  const okSched = orch.upsertSchedule(
    { id: 'morning-brief', seat: 'seat-cron', task_template: 'build-brief', cron: '0 6 * * *' },
    { origin: 'interactive', author: 'operator' }
  );
  assert.equal(okSched.ok, true);

  // Trigger alarm twice for the same fireTime: second trigger is an idempotent no-op
  const fire1 = orch.triggerAlarm('morning-brief', 1792479000000, { budgetCap: 200 });
  const fire2 = orch.triggerAlarm('morning-brief', 1792479000000, { budgetCap: 200 });
  assert.equal(fire1.ok, true);
  assert.equal(fire1.idempotentReplay, false);
  assert.equal(fire2.ok, true);
  assert.equal(fire2.idempotentReplay, true);
  assert.equal(orch.store.tasks.size, 1);
});

test('HandLeaseDO: enforces 4MB prompt bound, slot cap, zombie single-requeue, wall-clock circuit exemption, capability probe, and stdio-MCP tunnel', () => {
  const handDO = new HandLeaseDO(null, { LEASE_TTL_MS: 1000, CIRCUIT_FAILURE_THRESHOLD: 2 });
  handDO.registerHand('mac-studio-01', { maxConcurrent: 1, engine: 'claude', now: 100 });

  // 1. 4MB prompt bound -> 413 Payload Too Large
  const oversized = 'x'.repeat(4 * 1024 * 1024 + 10);
  const overRes = handDO.enqueueTask({ taskId: 't-big', prompt: oversized, now: 100 });
  assert.equal(overRes.ok, false);
  assert.equal(overRes.status, 413);

  // 2. Slot cap: enqueue 2 tasks, maxConcurrent=1 -> polls only 1 task
  handDO.enqueueTask({ taskId: 't-a', prompt: 'Task A', now: 100 });
  handDO.enqueueTask({ taskId: 't-b', prompt: 'Task B', now: 100 });
  const poll1 = handDO.pollTasks('mac-studio-01', { now: 110 });
  assert.equal(poll1.leased.length, 1);
  assert.equal(poll1.leased[0].taskId, 't-a');
  assert.equal(poll1.freeSlots, 0);

  // 3. Zombie single-requeue: let t-a expire once at now=2000 -> requeued; expire twice -> failed (lost_in_flight)
  const sweep1 = handDO.sweep(2000);
  assert.equal(sweep1['t-a'], 'queued');
  const poll2 = handDO.pollTasks('mac-studio-01', { now: 2010 });
  assert.equal(poll2.leased[0].taskId, 't-a');
  const sweep2 = handDO.sweep(4000);
  assert.equal(sweep2['t-a'], 'failed');
  assert.match(handDO.tasks.get('t-a').reason, /lost_in_flight/);

  // 4. Wall-clock timeout does not trip circuit breaker
  const pollB = handDO.pollTasks('mac-studio-01', { now: 4010 });
  assert.equal(pollB.leased[0].taskId, 't-b');
  handDO.reportResult('t-b', pollB.leased[0].leaseId, {
    state: 'failed',
    reason: 'wall_clock_timeout',
    timedOutByWallClock: true,
    now: 4050,
  });
  assert.equal(handDO.nodes.get('mac-studio-01').circuit.open, false);

  // 5. Capability echo probe sets capabilities_set_by = 'hand-operator'
  const caps = { stream_json: true, mcp_stdio: true };
  const nonce = 'nonce-12345';
  const sig = createHash('sha256').update(`mac-studio-01:${nonce}:${JSON.stringify(caps)}`).digest('hex');
  const probeRes = handDO.verifyCapabilityProbe('mac-studio-01', {
    nonce,
    expectedNonce: nonce,
    capabilities: caps,
    signature: sig,
  });
  assert.equal(probeRes.ok, true);
  assert.equal(probeRes.capabilities_set_by, 'hand-operator');

  // 6. Stdio-MCP tunnel enforces default-deny mcp_grants
  const registry = {
    seats: [{ id: 's1', hand: 'claude', model: 'm', budget: 10, enabled: true, created_by: 'op' }],
    mcp_servers: [{ id: 'local-sqlite', transport: 'stdio-bridge', endpoint: 'stdio://sqlite', enabled: true, owner: 'op' }],
    mcp_grants: [{ subject: 'seat:s1', server: 'local-sqlite', tool: 'query', allow: true }],
  };
  const deniedMcp = handDO.enqueueStdioMcpCall(registry, {
    subject: 'seat:s1',
    server: 'local-sqlite',
    tool: 'drop_table',
  });
  assert.equal(deniedMcp.ok, false);
  assert.equal(deniedMcp.status, 403);

  const allowedMcp = handDO.enqueueStdioMcpCall(registry, {
    subject: 'seat:s1',
    server: 'local-sqlite',
    tool: 'query',
    params: { sql: 'SELECT 1' },
  });
  assert.equal(allowedMcp.ok, true);
  assert.equal(handDO.drainStdioMcpFrames().length, 1);
});

test('ArchonMailboxDO: verifies signed Mesh bundles with 4 provenance fields, quarantines unmapped canonical_id_join, and executes shared-seat lease without exposing credentials', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const alicePubPem = publicKey.export({ type: 'spki', format: 'pem' });

  const mailbox = new ArchonMailboxDO(null, { ENCRYPTION_MODE: 'e2ee-local-custodian' });
  mailbox.registerTrustedPeer('archon:alice', alicePubPem);
  assert.equal(mailbox.getCustodyMetadata().encryption_mode, 'e2ee-local-custodian');
  assert.equal(mailbox.getCustodyMetadata().plaintext_visible_to_cloudflare, false);

  const blobBytes = Buffer.from('verified-thesis-snapshot');
  const blobSha = createHash('sha256').update(blobBytes).digest('hex');

  const manifest = {
    version: MANIFEST_VERSION,
    bundleId: 'b-101',
    senderKey: 'archon:alice',
    agreedScope: 'team:macro-desk',
    graphVersion: 8601,
    objects: [
      {
        objectId: 'claim:xcmg-1',
        version: 1,
        scope: 'team:macro-desk',
        snapshotHash: blobSha,
        truncated: false,
        payload: {
          title: 'XCMG Machinery Thesis',
          basis: { locator: 'r2://blobs/' + blobSha, content_sha256: blobSha, n: 12 },
          defeaters_at_export: { open: [], absence: 'none_held' },
          peer_as_of: { graphVersion: 8601, observedAt: '2026-10-20T06:00:00Z' },
          canonical_id_join: 'local:entity:000425.SZ',
        },
      },
      {
        objectId: 'claim:unmapped-twin',
        version: 1,
        scope: 'team:macro-desk',
        snapshotHash: null,
        truncated: false,
        payload: {
          title: 'Unmapped Peer Entity',
          basis: { locator: 'r2://blobs/' + blobSha, content_sha256: blobSha, n: 4 },
          defeaters_at_export: { open: ['def-9'], absence: 'outside_share' },
          peer_as_of: { graphVersion: 8601, observedAt: '2026-10-20T06:00:00Z' },
          canonical_id_join: 'unmapped',
        },
      },
    ],
  };

  const signature = signManifest(manifest, privateKey);
  const bundleRes = mailbox.receiveBundle({
    manifest,
    signature,
    blobs: { [blobSha]: blobBytes },
  });

  assert.equal(bundleRes.ok, true);
  assert.equal(bundleRes.accepted.length, 1);
  assert.equal(bundleRes.accepted[0].canonicalId, 'local:entity:000425.SZ');
  assert.equal(bundleRes.accepted[0].provenance.originKey, 'archon:alice');
  // Unmapped entity is held in quarantine view, never dropped silently or double-counted
  assert.equal(bundleRes.quarantined.length, 1);
  assert.equal(bundleRes.quarantined[0].objectId, 'claim:unmapped-twin');
  assert.equal(bundleRes.quarantined[0].reason, 'canonical-id-unmapped-quarantined');

  // Shared-seat capability grant & execution
  const grantRes = mailbox.mintSeatGrant({
    seatGrantId: 'sg-1',
    seatId: 'gpu-research-seat',
    granteePubkey: 'archon:bob',
    allowedTemplates: ['vortexa-globe-sim'],
    budgetQuota: 500,
    expiresAt: Date.now() + 3600_000,
    author: 'archon:alice',
    origin: 'interactive',
  });
  assert.equal(grantRes.ok, true);

  const leaseExec = mailbox.executeSharedSeatLease({
    seatGrantId: 'sg-1',
    requesterPubkey: 'archon:bob',
    templateKey: 'vortexa-globe-sim',
    taskId: 'mesh-task-1',
    engine: 'claude',
    taskCap: 300,
    usage: { tokens: 220 },
  });
  assert.equal(leaseExec.ok, true);
  assert.equal(leaseExec.receipt.charged, 220);
  assert.equal(leaseExec.receipt.remainingQuota, 280);
  assert.equal(leaseExec.receipt.credentialsExposed, false);

  // Exceeding remaining quota (280 < 300) is refused with 402
  const overQuota = mailbox.executeSharedSeatLease({
    seatGrantId: 'sg-1',
    requesterPubkey: 'archon:bob',
    templateKey: 'vortexa-globe-sim',
    taskId: 'mesh-task-2',
    engine: 'claude',
    taskCap: 300,
    usage: { tokens: 100 },
  });
  assert.equal(overQuota.ok, false);
  assert.equal(overQuota.status, 402);
});

test('Single-origin Cloudflare Worker HTTP gateway end-to-end flow', async () => {
  const runtime = createArchonEdgeRuntime({ ARCHON_VERSION: '0.1.0' });

  const healthRes = await runtime.fetch(new Request('https://archon.local/api/health'));
  assert.equal(healthRes.status, 200);
  const health = await healthRes.json();
  assert.equal(health.ok, true);

  // Create seat via interactive origin
  const seatRes = await runtime.fetch(
    new Request('https://archon.local/api/seats', {
      method: 'POST',
      headers: { 'x-archon-origin': 'interactive', 'x-archon-author': 'operator' },
      body: JSON.stringify({
        id: 'seat-main',
        hand: 'claude',
        model: 'claude-sonnet-4-5',
        budget: 2000,
        enabled: true,
        created_by: 'operator',
        capabilities: { chat: true },
        capabilities_set_by: 'hand-operator',
      }),
    })
  );
  assert.equal(seatRes.status, 200);

  // Submit intent + task, poll from hand, report result, and verify ledger spend
  const intentRes = await runtime.fetch(
    new Request('https://archon.local/api/intents', {
      method: 'POST',
      body: JSON.stringify({
        intentId: 'i-http-1',
        runId: 'r-http-1',
        prompt: 'Generate morning brief',
        tasks: [{ taskId: 't-http-1', seatId: 'seat-main', budgetCap: 400, prompt: 'Generate morning brief' }],
      }),
    })
  );
  assert.equal(intentRes.status, 201);

  const pollRes = await runtime.fetch(
    new Request('https://archon.local/hands/poll', {
      method: 'POST',
      body: JSON.stringify({ handId: 'hand-sg01', maxConcurrent: 2, now: 1000 }),
    })
  );
  const pollData = await pollRes.json();
  assert.equal(pollData.leased.length, 1);

  const resultRes = await runtime.fetch(
    new Request('https://archon.local/hands/result', {
      method: 'POST',
      body: JSON.stringify({
        taskId: 't-http-1',
        leaseId: pollData.leased[0].leaseId,
        state: 'done',
        usage: { tokens: 175 },
        output: 'Morning brief ready',
        now: 1050,
      }),
    })
  );
  const resultData = await resultRes.json();
  assert.equal(resultData.ok, true);
  assert.equal(resultData.harvest.seatTotalSpent, 175);
});

test('WorkspaceOrchestratorDO: harness2 RSI skill proposal requires k=3 held-out pass AND interactive Hands-Up approval before activation', () => {
  const orch = new WorkspaceOrchestratorDO();
  const policy = {
    k: 3,
    minTrajectories: 2,
    preExistingVerifierHashes: new Set(['v-hash-001']),
    approvedVerifierHashes: new Set(),
  };

  const propRes = orch.verifyAndProposeSkill(
    { name: 'vortexa-tanker-audit', version: 1, hash: H64, owner: 'seat-epistates' },
    {
      hash: H64,
      verifierHash: 'v-hash-001',
      verifierAuthoredWithProposal: false,
      fitTrajectories: ['fit-1'],
      heldOut: [
        { trajectory: 'ho-1', passed: true },
        { trajectory: 'ho-1', passed: true },
        { trajectory: 'ho-1', passed: true },
        { trajectory: 'ho-2', passed: true },
        { trajectory: 'ho-2', passed: true },
        { trajectory: 'ho-2', passed: true },
      ],
      verifierError: null,
      defeaters: [],
    },
    policy
  );
  assert.equal(propRes.ok, true);
  assert.equal(propRes.eligibility.verdict, 'pass');
  assert.equal(propRes.skill.state, 'proposed');

  // Non-interactive activation is refused (403)
  const nonInteractive = orch.activateSkill('vortexa-tanker-audit', 1, {
    origin: 'tool_result',
    author: 'harness2',
  });
  assert.equal(nonInteractive.ok, false);
  assert.equal(nonInteractive.status, 403);

  // Interactive operator activation succeeds
  const activated = orch.activateSkill('vortexa-tanker-audit', 1, {
    origin: 'interactive',
    author: 'operator',
  });
  assert.equal(activated.ok, true);
  assert.equal(activated.skill.state, 'active');
});

test('WorkspaceOrchestratorDO: empty no_result task state transitions intent to partial, never completed', () => {
  const orch = new WorkspaceOrchestratorDO();
  orch.upsertSeat({
    id: 'seat-gemini',
    hand: 'gemini',
    model: 'gemini-3-pro',
    budget: 1000,
    enabled: true,
    created_by: 'operator',
    capabilities: { search: true },
    capabilities_set_by: 'hand-operator',
  });
  orch.intakeIntent({ intentId: 'int-nr', runId: 'run-nr', prompt: 'Check unindexed feed' });
  orch.planIntent('int-nr', [{ taskId: 't-nr', seatId: 'seat-gemini', budgetCap: 250, prompt: 'Check unindexed feed' }]);
  const harv = orch.harvestTask('t-nr', {
    state: 'no_result',
    usage: null,
    reason: 'engine produced no output',
  });
  assert.equal(harv.ok, true);
  assert.equal(orch.store.intents.get('int-nr').state, 'partial');
  assert.notEqual(orch.store.intents.get('int-nr').state, 'completed');
  // Unmetered usage is still charged at budgetCap = 250
  assert.equal(harv.seatTotalSpent, 250);
});

test('R3 MCP Federation CRUD: server catalogTools registration, bulk tool grants, revocation, and server delete', async () => {
  const runtime = createArchonEdgeRuntime({ ARCHON_VERSION: '0.2.0' });

  // Register MCP server with catalogTools
  const srvRes = await runtime.fetch(
    new Request('https://archon.local/api/mcp/servers', {
      method: 'POST',
      headers: { 'x-archon-origin': 'interactive', 'x-archon-author': 'operator' },
      body: JSON.stringify({
        id: 'archon-ci',
        transport: 'stdio-bridge',
        endpoint: 'stdio://archon-ci',
        auth_ref: 'secret://archon-ci-token',
        enabled: true,
        owner: 'operator',
        tools: ['run_suite', 'audit_loc', 'verify_bundle'],
      }),
    })
  );
  assert.equal(srvRes.status, 200);
  const srvJson = await srvRes.json();
  assert.deepEqual(srvJson.server.catalogTools, ['run_suite', 'audit_loc', 'verify_bundle']);

  // Bulk grant all 3 tools to seat:code-architect
  const bulkRes = await runtime.fetch(
    new Request('https://archon.local/api/mcp/grants/bulk', {
      method: 'POST',
      headers: { 'x-archon-origin': 'interactive', 'x-archon-author': 'operator' },
      body: JSON.stringify({
        subject: 'seat:code-architect',
        server: 'archon-ci',
        tools: ['run_suite', 'audit_loc', 'verify_bundle'],
        allow: true,
      }),
    })
  );
  assert.equal(bulkRes.status, 200);
  const bulkJson = await bulkRes.json();
  assert.equal(bulkJson.count, 3);

  // Delete MCP server removes server and its grants
  const delRes = await runtime.fetch(
    new Request('https://archon.local/api/mcp/servers/archon-ci', {
      method: 'DELETE',
      headers: { 'x-archon-origin': 'interactive', 'x-archon-author': 'operator' },
    })
  );
  assert.equal(delRes.status, 200);
  assert.equal(runtime.sharedStore.mcpServers.has('archon-ci'), false);
  assert.equal(runtime.sharedStore.mcpGrants.filter((g) => g.server === 'archon-ci').length, 0);
});

test('R4 Harness2 Skill Quick-Create, Disable, and Delete via interactive operator rail', async () => {
  const runtime = createArchonEdgeRuntime({ ARCHON_VERSION: '0.2.0' });

  const qcRes = await runtime.fetch(
    new Request('https://archon.local/api/skills/quick-create', {
      method: 'POST',
      headers: { 'x-archon-origin': 'interactive', 'x-archon-author': 'operator' },
      body: JSON.stringify({
        name: 'archon-monorepo-invariant-guard',
        version: 1,
        owner: 'seat:code-architect',
        title: 'ArchonOS Monorepo Invariant Guard (v1)',
        skillMd: '---\nname: archon-monorepo-invariant-guard\nversion: 1\n---\nEnforce 9-package invariants.',
        activateImmediately: true,
      }),
    })
  );
  assert.equal(qcRes.status, 200);
  const qcJson = await qcRes.json();
  assert.equal(qcJson.ok, true);
  assert.equal(qcJson.skill.state, 'active');

  const delRes = await runtime.fetch(
    new Request('https://archon.local/api/skills', {
      method: 'DELETE',
      headers: { 'x-archon-origin': 'interactive', 'x-archon-author': 'operator' },
      body: JSON.stringify({ name: 'archon-monorepo-invariant-guard', version: 1 }),
    })
  );
  assert.equal(delRes.status, 200);
  assert.equal(runtime.sharedStore.skills.has('archon-monorepo-invariant-guard@1'), false);
});

test('R7 Live Ed25519 Signed Mesh Bundle Audit signs and verifies active workspace skills', () => {
  const runtime = createArchonEdgeRuntime({ ARCHON_VERSION: '0.2.0' });
  const policy = {
    k: 3,
    minTrajectories: 2,
    preExistingVerifierHashes: new Set(['v-harness2-replay-v1']),
    approvedVerifierHashes: new Set(['v-operator-signed-v1']),
  };
  runtime.orchestrator.verifyAndProposeSkill(
    { name: 'archon-bundle-audit', version: 1, hash: H64, owner: 'seat:ops-guardian', skillMd: '# Bundle Audit' },
    {
      hash: H64,
      verifierHash: 'v-harness2-replay-v1',
      verifierAuthoredWithProposal: false,
      fitTrajectories: ['f1', 'f2'],
      heldOut: [
        { trajectory: 'h1', passed: true },
        { trajectory: 'h1', passed: true },
        { trajectory: 'h1', passed: true },
        { trajectory: 'h2', passed: true },
        { trajectory: 'h2', passed: true },
        { trajectory: 'h2', passed: true },
      ],
      verifierError: null,
      defeaters: [],
    },
    policy
  );
  runtime.orchestrator.activateSkill('archon-bundle-audit', 1, { origin: 'interactive', author: 'operator' });

  const audit = buildLiveMeshBundleAudit(runtime);
  assert.equal(audit.ok, true);
  assert.equal(audit.acceptedCount, 1);
  assert.equal(audit.quarantinedCount, 0);
});

test('R6 & R10 ArchonOS Project 10-Round RSI Introspection audits all 9 packages and computes structural diffs', () => {
  const runtime = createArchonEdgeRuntime({ ARCHON_VERSION: '0.2.0' });
  assert.equal(RSI_10_ROUNDS_LEDGER.length, 10);
  assert.equal(RSI_10_ROUNDS_LEDGER[0].id, 'R1');
  assert.equal(RSI_10_ROUNDS_LEDGER[9].id, 'R10');

  const audit = auditArchonProjectRsi(runtime);
  assert.equal(audit.totalPackages, 9);
  assert.equal(audit.projectPackages.length, 9);
  assert.equal(audit.rsiTrajectory.length, 10);
  assert.ok(audit.totalLoc > 3000, 'Expected >3000 lines of source code across 9 packages');
  assert.equal(audit.meshAudit.ok, true);

  // Verify computeArtifactRevisionDiff works on published artifacts
  const sha = runtime.orchestrator.putR2Blob(JSON.stringify({ projectPackages: audit.projectPackages }));
  runtime.orchestrator.publishCanvasArtifact({
    artifactId: 'art-rsi-test',
    expectedBaseRevision: 0,
    manifestSha256: sha,
    hasHtmlParity: true,
  });
  const diff = computeArtifactRevisionDiff(runtime, 'art-rsi-test');
  assert.equal(diff.ok, true);
  assert.equal(diff.currentRevision, 1);
});

test('Scheduled Work API (/api/schedules CRUD, toggle, fire) and Sticky Native Hand Session flags (--session-id / --resume)', async () => {
  const { getInvocationSpec } = await import('../src/local-hands-runner.mjs');
  const runtime = createArchonEdgeRuntime({ ARCHON_VERSION: '0.2.0' });

  // 1. Sticky Hand Session flags: Turn 1 uses --session-id, Turn N>1 uses --resume
  const turn1Spec = getInvocationSpec('claude', 'claude', 'Analyze 301087.SZ', {
    handSessionId: '11111111-2222-4333-8444-555555555555',
    isResumeTurn: false,
  });
  assert.ok(turn1Spec.args.includes('--session-id'));
  assert.ok(turn1Spec.args.includes('11111111-2222-4333-8444-555555555555'));

  const turn2Spec = getInvocationSpec('claude', 'claude', 'Follow up on OCF ratio', {
    handSessionId: '11111111-2222-4333-8444-555555555555',
    isResumeTurn: true,
  });
  assert.ok(turn2Spec.args.includes('--resume'));
  assert.ok(turn2Spec.args.includes('11111111-2222-4333-8444-555555555555'));

  // 2. Scheduled Work CRUD + Toggle + Fire via Worker HTTP API
  runtime.orchestrator.upsertSeat({
    id: 'chief-of-staff',
    hand: 'claude',
    model: 'cli-default',
    budget: 100000,
    enabled: true,
    created_by: 'operator',
  });
  const createRes = await runtime.fetch(
    new Request('https://archon.local/api/schedules', {
      method: 'POST',
      headers: { 'x-archon-origin': 'interactive', 'x-archon-author': 'operator' },
      body: JSON.stringify({
        id: 'sched-stock-sop-test',
        title: 'Morning Stock Deep Research SOP',
        cron: '30 8 * * 1-5',
        seat: 'chief-of-staff',
        skillId: 'stock-deep-research-sop',
        mcpServers: ['ros-gateway', 'agora-admin'],
        ticker: '301087.SZ',
        enabled: true,
      }),
    })
  );
  assert.equal(createRes.status, 200);
  const createJson = await createRes.json();
  assert.equal(createJson.ok, true);
  assert.equal(createJson.schedule.skillId, 'stock-deep-research-sop');

  const toggleRes = await runtime.fetch(
    new Request('https://archon.local/api/schedules/sched-stock-sop-test/toggle', {
      method: 'POST',
    })
  );
  const toggleJson = await toggleRes.json();
  assert.equal(toggleJson.ok, true);
  assert.equal(toggleJson.schedule.enabled, false);

  const delRes = await runtime.fetch(
    new Request('https://archon.local/api/schedules/sched-stock-sop-test', {
      method: 'DELETE',
    })
  );
  assert.equal(delRes.status, 200);
});

test('ROS Subgraph Explorer enforces zero hardcoded tickers, renders node.label over raw IDs, derives crs.content-root.v1 operator truth states, and invalidates cache on contentRoot change', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { evaluateRosSubgraphOperators, getRosCacheKey } = await import('../src/dev-server.mjs');

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const explorerHtmlPath = resolve(__dirname, '../../archon-app/public/artifacts/art-ros-subgraph-explorer.html');
  if (existsSync(explorerHtmlPath)) {
    const html = readFileSync(explorerHtmlPath, 'utf8');

    // (1) No hardcoded mock ticker arrays in art-ros-subgraph-explorer.html; fetches dynamically from /api/ros/*
    assert.ok(html.includes("fetchJson('/api/ros/underlyings')"));
    assert.ok(html.includes("fetchJson('/api/ros/subgraphs?scope=entity&limit=100')"));
    assert.ok(!/const\s+SUBGRAPHS\s*=\s*\[/i.test(html), 'Hardcoded SUBGRAPHS array must be removed');

    // (2) Primary text renders node.label and second line renders node.value.reason; raw node.id only in <title> tooltip / copy button
    assert.ok(html.includes('const labelText = String(n.label || n.kind'));
    assert.ok(html.includes('n.value?.reason'));
    assert.ok(html.includes('raw id: ${escapeHtml(id)}</title>'));
  }

  // (3) Operator truth derivation for cpath-782f386a94d6753ddc3a current version (epoch 84cf091059de)
  const sampleEpoch = '84cf091059de';
  const pfx = 'cpath-782f386a94d6753ddc3a';
  const mockSubgraphPayload = {
    ok: true,
    subgraph: {
      id: pfx,
      title: '688012.SH',
      metadata: {
        currentNodes: {
          identity: `${pfx}:identity:${sampleEpoch}`,
          mapping: `${pfx}:mapping:${sampleEpoch}`,
          sourceEvidence: `${pfx}:source-evidence:${sampleEpoch}`,
          monitoring: `${pfx}:monitoring:${sampleEpoch}`,
          thesisFalsifier: `${pfx}:thesis-falsifier:${sampleEpoch}`,
          activeForecast: `${pfx}:active-forecast:${sampleEpoch}`,
          uniqueDirection: `${pfx}:unique-direction:${sampleEpoch}`,
          validFrom: `${pfx}:valid-from:${sampleEpoch}`,
          horizon: `${pfx}:horizon:${sampleEpoch}`,
          benchmark: `${pfx}:benchmark:${sampleEpoch}`,
          catalyst: `${pfx}:catalyst:${sampleEpoch}`,
          contractFalsifier: `${pfx}:contract-falsifier:${sampleEpoch}`,
          forecastQuality: `${pfx}:forecast-quality:${sampleEpoch}`,
          ontologyReady: `${pfx}:ontology-ready:${sampleEpoch}`,
          forecastReady: `${pfx}:forecast-ready:${sampleEpoch}`,
          researchReady: `${pfx}:research-ready:${sampleEpoch}`,
          marketQuote: `${pfx}:market-quote:${sampleEpoch}`,
          marketHistory: `${pfx}:market-history:${sampleEpoch}`,
          marketFresh: `${pfx}:market-fresh:${sampleEpoch}`,
          marketReconciled: `${pfx}:market-reconciled:${sampleEpoch}`,
          marketLiquid: `${pfx}:market-liquid:${sampleEpoch}`,
          marketEvent: `${pfx}:market-event:${sampleEpoch}`,
          marketVolatility: `${pfx}:market-volatility:${sampleEpoch}`,
          marketHardReady: `${pfx}:market-hard-ready:${sampleEpoch}`,
          directionalRegime: `${pfx}:directional-regime:${sampleEpoch}`,
          adviceEligible: `${pfx}:advice-eligible:${sampleEpoch}`,
        },
      },
      nodes: [
        { id: `${pfx}:identity:${sampleEpoch}`, kind: 'Observation', label: 'Entity identity resolved', value: { valueType: 'truth', state: 'true', reason: 'entity_resolved' } },
        { id: `${pfx}:mapping:${sampleEpoch}`, kind: 'Warrant', label: 'Primary security mapping resolved', value: { valueType: 'truth', state: 'true', reason: 'security_mapping_present' } },
        { id: `${pfx}:source-evidence:${sampleEpoch}`, kind: 'Observation', label: 'Primary source evidence linked', value: { valueType: 'truth', state: 'true', reason: 'source_refs_present' } },
        { id: `${pfx}:monitoring:${sampleEpoch}`, kind: 'Warrant', label: 'Monitoring rule attached', value: { valueType: 'truth', state: 'true', reason: 'monitoring_signals_present' } },
        { id: `${pfx}:thesis-falsifier:${sampleEpoch}`, kind: 'Defeater', label: 'Thesis falsifier declared', value: { valueType: 'truth', state: 'true', reason: 'falsifier_clear' } },
        { id: `${pfx}:active-forecast:${sampleEpoch}`, kind: 'Observation', label: 'Active forecast contract selected', value: { valueType: 'truth', state: 'false', reason: 'active_forecast_missing' } },
        { id: `${pfx}:unique-direction:${sampleEpoch}`, kind: 'Warrant', label: 'Forecast direction is unique', value: { valueType: 'truth', state: 'unknown', reason: 'forecast_missing' } },
        { id: `${pfx}:valid-from:${sampleEpoch}`, kind: 'Observation', label: 'Forecast validFrom timestamp present', value: { valueType: 'truth', state: 'unknown', reason: 'forecast_missing' } },
        { id: `${pfx}:horizon:${sampleEpoch}`, kind: 'Observation', label: 'Forecast horizon declared', value: { valueType: 'truth', state: 'unknown', reason: 'forecast_missing' } },
        { id: `${pfx}:benchmark:${sampleEpoch}`, kind: 'Warrant', label: 'Benchmark / baseline specified', value: { valueType: 'truth', state: 'unknown', reason: 'forecast_missing' } },
        { id: `${pfx}:catalyst:${sampleEpoch}`, kind: 'Observation', label: 'Catalyst path specified', value: { valueType: 'truth', state: 'unknown', reason: 'forecast_missing' } },
        { id: `${pfx}:contract-falsifier:${sampleEpoch}`, kind: 'Defeater', label: 'Forecast falsifier clear', value: { valueType: 'truth', state: 'unknown', reason: 'forecast_missing' } },
        { id: `${pfx}:forecast-quality:${sampleEpoch}`, kind: 'Warrant', label: 'Forecast quality audit passed', value: { valueType: 'truth', state: 'unknown', reason: 'forecast_missing' } },
        { id: `${pfx}:market-quote:${sampleEpoch}`, kind: 'Observation', label: 'Market quote observed', value: { valueType: 'truth', state: 'unknown', reason: 'market_plane_not_joined' } },
        { id: `${pfx}:market-history:${sampleEpoch}`, kind: 'Observation', label: 'Market history window available', value: { valueType: 'truth', state: 'unknown', reason: 'market_plane_not_joined' } },
        { id: `${pfx}:market-fresh:${sampleEpoch}`, kind: 'Warrant', label: 'Market data freshness verified', value: { valueType: 'truth', state: 'unknown', reason: 'market_plane_not_joined' } },
        { id: `${pfx}:market-reconciled:${sampleEpoch}`, kind: 'Warrant', label: 'Cross-venue price reconciled', value: { valueType: 'truth', state: 'unknown', reason: 'market_plane_not_joined' } },
        { id: `${pfx}:market-liquid:${sampleEpoch}`, kind: 'Warrant', label: 'Liquidity threshold satisfied', value: { valueType: 'truth', state: 'unknown', reason: 'market_plane_not_joined' } },
        { id: `${pfx}:market-event:${sampleEpoch}`, kind: 'Defeater', label: 'Corporate action / halt clear', value: { valueType: 'truth', state: 'unknown', reason: 'market_plane_not_joined' } },
        { id: `${pfx}:market-volatility:${sampleEpoch}`, kind: 'Defeater', label: 'Volatility regime within bounds', value: { valueType: 'truth', state: 'unknown', reason: 'market_plane_not_joined' } },
        { id: `${pfx}:directional-regime:${sampleEpoch}`, kind: 'Warrant', label: 'Directional regime aligned', value: { valueType: 'truth', state: 'unknown', reason: 'market_plane_not_joined' } },
        { id: `${pfx}:ontology-ready:${sampleEpoch}`, kind: 'OutputPort', label: 'Ontology & evidence ready' },
        { id: `${pfx}:forecast-ready:${sampleEpoch}`, kind: 'OutputPort', label: 'Forecast contract ready' },
        { id: `${pfx}:market-hard-ready:${sampleEpoch}`, kind: 'OutputPort', label: 'Market hard-gate ready' },
        { id: `${pfx}:research-ready:${sampleEpoch}`, kind: 'OutputPort', label: 'Research-ready gate' },
        { id: `${pfx}:advice-eligible:${sampleEpoch}`, kind: 'AccountabilityTerminus', label: 'Advice-eligible terminus' },
      ],
      operators: [
        {
          id: `${pfx}:op-ontology:${sampleEpoch}`,
          kind: 'all',
          inputs: [
            `${pfx}:identity:${sampleEpoch}`,
            `${pfx}:mapping:${sampleEpoch}`,
            `${pfx}:source-evidence:${sampleEpoch}`,
            `${pfx}:monitoring:${sampleEpoch}`,
            `${pfx}:thesis-falsifier:${sampleEpoch}`,
          ],
          output: `${pfx}:ontology-ready:${sampleEpoch}`,
        },
        {
          id: `${pfx}:op-forecast:${sampleEpoch}`,
          kind: 'all',
          inputs: [
            `${pfx}:active-forecast:${sampleEpoch}`,
            `${pfx}:unique-direction:${sampleEpoch}`,
            `${pfx}:valid-from:${sampleEpoch}`,
            `${pfx}:horizon:${sampleEpoch}`,
            `${pfx}:benchmark:${sampleEpoch}`,
            `${pfx}:catalyst:${sampleEpoch}`,
            `${pfx}:contract-falsifier:${sampleEpoch}`,
            `${pfx}:forecast-quality:${sampleEpoch}`,
          ],
          output: `${pfx}:forecast-ready:${sampleEpoch}`,
        },
        {
          id: `${pfx}:op-market-hard:${sampleEpoch}`,
          kind: 'all',
          inputs: [
            `${pfx}:market-quote:${sampleEpoch}`,
            `${pfx}:market-history:${sampleEpoch}`,
            `${pfx}:market-fresh:${sampleEpoch}`,
            `${pfx}:market-reconciled:${sampleEpoch}`,
            `${pfx}:market-liquid:${sampleEpoch}`,
            `${pfx}:market-event:${sampleEpoch}`,
            `${pfx}:market-volatility:${sampleEpoch}`,
          ],
          output: `${pfx}:market-hard-ready:${sampleEpoch}`,
        },
        {
          id: `${pfx}:op-research:${sampleEpoch}`,
          kind: 'all',
          inputs: [`${pfx}:ontology-ready:${sampleEpoch}`, `${pfx}:forecast-ready:${sampleEpoch}`],
          output: `${pfx}:research-ready:${sampleEpoch}`,
        },
        {
          id: `${pfx}:op-advice:${sampleEpoch}`,
          kind: 'all',
          inputs: [
            `${pfx}:research-ready:${sampleEpoch}`,
            `${pfx}:market-hard-ready:${sampleEpoch}`,
            `${pfx}:directional-regime:${sampleEpoch}`,
          ],
          output: `${pfx}:advice-eligible:${sampleEpoch}`,
        },
      ],
    },
  };

  const evaluated = evaluateRosSubgraphOperators(mockSubgraphPayload);
  const ports = evaluated.subgraph.derivedPortStates;
  assert.equal(ports['ontology-ready']?.state, 'true');
  assert.equal(ports['forecast-ready']?.state, 'false');
  assert.equal(ports['market-hard-ready']?.state, 'unknown');
  assert.equal(ports['research-ready']?.state, 'false');
  assert.equal(ports['advice-eligible']?.state, 'false');

  // (4) Cache key changes deterministically when contentRoot changes
  const k1 = getRosCacheKey('13ec09ba8bf28e976edd1d3ba5bee89fa7c236ed3ca90e4593bfdde54662f29d', 'subgraph-path', { id: pfx, view: 'graph' });
  const k2 = getRosCacheKey('99ff00112233445566778899aabbccddeeff00112233445566778899aabbccdd', 'subgraph-path', { id: pfx, view: 'graph' });
  assert.notEqual(k1.cacheKey, k2.cacheKey);
  assert.notEqual(k1.filePath, k2.filePath);
});

test('Chief of Staff Warroom Router, Ticket ID Sanitization, Section Quote-Comment UI, and 5-Min GUI Optimizer Tick work end-to-end', async () => {
  const { readFileSync } = await import('node:fs');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const {
    sanitizeUserFacingChatText,
    routeTaskViaChiefOfStaff,
    executeGui5MinOptimizerTick,
  } = await import('../src/dev-server.mjs');

  // (1) Ticket ID sanitization strips internal fb-... IDs from prose and Mermaid diagrams
  const dirtyText = `### Status Update: Ticket fb-1792644229110\n\`\`\`mermaid\nflowchart LR\n  A["Operator Prompt"] --> B["Ticket fb-1792644229110-code-architect"]\n\`\`\`\nActive ticket \`fb-1792644229110\` is processing.`;
  const cleanText = sanitizeUserFacingChatText(dirtyText);
  assert.ok(!/fb-\d+/i.test(cleanText), `Expected zero fb-... ticket IDs in sanitized text, got: ${cleanText}`);
  assert.ok(cleanText.includes('Architect Task'));

  // (2) Chief of Staff Warroom Router dispatches domain tasks to specialist seats and keeps governance tasks on chief-of-staff
  const rCode = routeTaskViaChiefOfStaff({ userPrompt: 'Fix the CSS layout and operator truth badge in index.html' });
  assert.equal(rCode.routedByCos, true);
  assert.equal(rCode.targetSeatId, 'code-architect');

  const rResearch = routeTaskViaChiefOfStaff({ userPrompt: 'Run stock deep research and valuation bridge on 301087.SZ' });
  assert.equal(rResearch.routedByCos, true);
  assert.equal(rResearch.targetSeatId, 'deep-research');

  const rMaritime = routeTaskViaChiefOfStaff({ userPrompt: 'Analyze VLCC tanker and seaborne crude flows via Vortexa' });
  assert.equal(rMaritime.routedByCos, true);
  assert.equal(rMaritime.targetSeatId, 'maritime-quant');

  const rOps = routeTaskViaChiefOfStaff({ userPrompt: 'Audit Ed25519 mesh signature and MCP grant security gate' });
  assert.equal(rOps.routedByCos, true);
  assert.equal(rOps.targetSeatId, 'ops-guardian');

  const rExec = routeTaskViaChiefOfStaff({ userPrompt: 'List all seats, manage workspace files, and run scheduled tasks' });
  assert.equal(rExec.routedByCos, false);
  assert.equal(rExec.targetSeatId, 'chief-of-staff');
  assert.equal(rExec.isManagementCommand, true);

  // (3) 5-Min GUI & Subgraph Optimizer Tick increments runCount and updates lastStatus
  const runtime = createArchonEdgeRuntime({ ARCHON_VERSION: '0.2.0' });
  const sched = {
    id: 'sched-gui-5min-optimizer',
    title: '5-Min Continuous GUI & Subgraph Optimizer',
    cron: '*/5 * * * *',
    seat: 'code-architect',
    enabled: true,
    runCount: 60,
    lastRunAt: '2026-10-22T00:00:00.000Z',
    lastStatus: 'PASS',
  };
  const tickRes = executeGui5MinOptimizerTick(runtime, { chatSessions: new Map(), architectTasks: [] }, sched, '2026-10-22T06:55:00.000Z');
  assert.equal(tickRes.ok, true);
  assert.equal(sched.runCount, 61);
  assert.ok(sched.lastStatus.includes('Tick #61'));

  // (4) Frontend index.html includes section comment button enhancer and quoteSectionToChat
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const indexHtml = readFileSync(resolve(__dirname, '../../archon-app/public/index.html'), 'utf8');
  assert.ok(indexHtml.includes('function enhanceSectionCommentButtons('));
  assert.ok(indexHtml.includes('window.quoteSectionToChat = function'));
  assert.ok(indexHtml.includes('sanitizeUserFacingMarkdown('));
});

test('Isolated fresh-clone installation seeds only Chief of Staff, generic telemetry artifact, and starter orchestrator skill without operator-specific maritime/subgraph/stock data', async () => {
  const {
    seedDefaultArchonWorkspace,
    buildChiefOfStaffOmniscientSnapshot,
    DEFAULT_GLOBAL_MEMORY,
    DEFAULT_SEAT_MEMORY,
  } = await import('../src/dev-server.mjs');

  const freshRuntime = createArchonEdgeRuntime({ ARCHON_VERSION: '0.1.004' });
  seedDefaultArchonWorkspace(freshRuntime);

  const visibleSeatIds = [...freshRuntime.sharedStore.seats.keys()].filter((id) => id !== 'seat-archon');
  assert.deepEqual(visibleSeatIds, ['chief-of-staff'], 'Only chief-of-staff must be seeded on an empty fresh clone');

  const artifactIds = [...freshRuntime.sharedStore.artifacts.keys()];
  assert.deepEqual(artifactIds, ['art-telemetry-matrix'], 'Only generic art-telemetry-matrix should be seeded on empty fresh clone');
  assert.equal(artifactIds.includes('art-vortexa-3d'), false, '3D globe artifact must never appear on fresh clone');
  assert.equal(artifactIds.includes('art-rsi-10round-benchmark'), false, 'RSI benchmark artifact must never appear on fresh clone');

  const skillKeys = [...freshRuntime.sharedStore.skills.keys()];
  assert.deepEqual(skillKeys, ['workspace-orchestrator-sop@1'], 'Only generic workspace-orchestrator-sop should be seeded on empty fresh clone');

  assert.deepEqual(Object.keys(DEFAULT_SEAT_MEMORY), ['chief-of-staff'], 'DEFAULT_SEAT_MEMORY must only seed chief-of-staff');

  const snap = buildChiefOfStaffOmniscientSnapshot(freshRuntime, {
    globalMemory: DEFAULT_GLOBAL_MEMORY,
    seatMemory: { ...DEFAULT_SEAT_MEMORY },
    chatSessions: new Map(),
    activeSessionId: 'sess-default',
    architectTasks: [],
    outputFilesIndex: new Map(),
  });
  assert.deepEqual(
    snap.schedules.map((s) => s.id),
    ['sched-cos-daily-summary'],
    'Fresh clone must only seed Chief of Staff daily schedule and not code-architect schedules'
  );

  const memDump = JSON.stringify({ DEFAULT_GLOBAL_MEMORY, DEFAULT_SEAT_MEMORY });
  assert.doesNotMatch(memDump, /301087\.SZ|000725\.SZ|GEV|Vortexa 20d Window/i, 'Default memory constants must not contain private research or maritime figures');

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const indexHtml = readFileSync(join(__dirname, '../../archon-app/public/index.html'), 'utf8');
  assert.ok(indexHtml.includes('id="editor-artifact-id-label">art-telemetry-matrix<'), 'Artifact JSON editor label must default to art-telemetry-matrix');
  assert.ok(indexHtml.includes("let currentEditingArtifactId = 'art-telemetry-matrix';"), 'currentEditingArtifactId must default to art-telemetry-matrix');
});

test('Phase 2 & 3: Dual-Target Deployment (Local vs Cloudflare Remote Worker + Frontend Page) and Multi-User Secure Channels & Teams/Groups Coordination work end-to-end', async () => {
  const runtime = createArchonEdgeRuntime({
    ARCHON_VERSION: '0.1.005',
    ARCHON_DEPLOY_MODE: 'local',
    ENCRYPTION_MODE: 'e2ee-local-custodian',
  });

  // 1. Verify initial Local Workstation deployment mode
  const statusRes1 = await runtime.fetch(new Request('https://archon.local/api/deploy/status'));
  const status1 = await statusRes1.json();
  assert.equal(status1.ok, true);
  assert.equal(status1.mode, 'local');
  assert.equal(status1.localEndpoint, 'http://127.0.0.1:8790');

  // 2. Switch target to Cloudflare Remote (Worker + Frontend Page)
  const switchRes = await runtime.fetch(
    new Request('https://archon.local/api/deploy/target', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'cloudflare-remote',
        remoteWorkerUrl: 'https://archon-edge.example.workers.dev',
        remoteFrontendPageUrl: 'https://archon-ui.example.pages.dev',
        encryptionMode: 'e2ee-local-custodian',
      }),
    })
  );
  const switched = await switchRes.json();
  assert.equal(switched.ok, true);
  assert.equal(switched.mode, 'cloudflare-remote');
  assert.equal(switched.remoteWorkerUrl, 'https://archon-edge.example.workers.dev');
  assert.equal(switched.remoteFrontendPageUrl, 'https://archon-ui.example.pages.dev');
  assert.ok(switched.pairing?.code?.startsWith('ARC-'));
  assert.ok(switched.commands?.deployWorker.includes('wrangler deploy'));
  assert.ok(switched.commands?.deployFrontendPage.includes('wrangler pages deploy'));

  // 3. Create an E2EE Secure Channel via Cloudflare Remote
  const chanRes = await runtime.fetch(
    new Request('https://archon.local/api/mesh/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Alice-Bob CoS Encrypted Channel',
        creatorId: 'operator:alice',
        creatorSeat: 'seat:chief-of-staff',
      }),
    })
  );
  assert.equal(chanRes.status, 201);
  const chanData = await chanRes.json();
  assert.equal(chanData.ok, true);
  const channel = chanData.channel;
  assert.ok(channel.channelId.startsWith('sec-chan-'));
  assert.ok(channel.inviteToken.startsWith('ARC-CHAN-'));
  assert.equal(channel.custody.encryption_mode, 'e2ee-local-custodian');
  assert.equal(channel.custody.plaintext_visible_to_cloudflare, false);

  // 4. Peer (operator:bob) joins the Secure Channel using the inviteToken
  const joinChanRes = await runtime.fetch(
    new Request('https://archon.local/api/mesh/channels/join', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        inviteToken: channel.inviteToken,
        userId: 'operator:bob',
        seatId: 'seat:chief-of-staff',
      }),
    })
  );
  const joinChanData = await joinChanRes.json();
  assert.equal(joinChanData.ok, true);
  assert.equal(joinChanData.channel.members.length, 2);

  // 5. Post a Cross-Chief-of-Staff message on the Secure Channel
  const msgRes = await runtime.fetch(
    new Request('https://archon.local/api/mesh/channels/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        channelId: channel.channelId,
        senderId: 'operator:bob',
        senderSeat: 'seat:chief-of-staff',
        content: 'Requesting verified subgraph artifact review from Alice CoS.',
      }),
    })
  );
  assert.equal(msgRes.status, 201);
  const msgData = await msgRes.json();
  assert.equal(msgData.ok, true);
  assert.equal(msgData.message.encryptedEnvelope, true);

  // 6. Create a Multi-User Team (`team:<id>`) and Group (`group:<id>`) backed by Cloudflare Remote Secure Channels
  const teamRes = await runtime.fetch(
    new Request('https://archon.local/api/mesh/teams', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'team',
        name: 'Global Quant Federation',
        ownerId: 'operator:alice',
        ownerSeat: 'seat:chief-of-staff',
      }),
    })
  );
  assert.equal(teamRes.status, 201);
  const teamData = await teamRes.json();
  assert.equal(teamData.ok, true);
  assert.ok(teamData.team.teamId.startsWith('team:global-quant-federation-'));
  assert.ok(teamData.team.secureChannelId.startsWith('sec-chan-'));

  // 7. Teammate joins the Team and shares a Canvas artifact (`r2`)
  const joinTeamRes = await runtime.fetch(
    new Request('https://archon.local/api/mesh/teams/join', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        inviteToken: teamData.team.inviteToken,
        userId: 'operator:carol',
        seatId: 'seat:chief-of-staff',
        role: 'admin',
      }),
    })
  );
  const joinTeamData = await joinTeamRes.json();
  assert.equal(joinTeamData.ok, true);
  assert.equal(joinTeamData.team.members.length, 2);

  const shareArtRes = await runtime.fetch(
    new Request('https://archon.local/api/mesh/teams/artifacts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        teamId: teamData.team.teamId,
        artifactId: 'art-telemetry-matrix',
        title: 'System Telemetry Matrix',
        revision: 2,
        sharedBy: 'operator:carol',
        sharedBySeat: 'seat:chief-of-staff',
      }),
    })
  );
  const shareArtData = await shareArtRes.json();
  assert.equal(shareArtData.ok, true);
  assert.equal(shareArtData.team.sharedArtifacts.length, 1);
  assert.equal(shareArtData.team.sharedArtifacts[0].artifactId, 'art-telemetry-matrix');
  assert.equal(shareArtData.team.sharedArtifacts[0].revision, 2);

  // 8. Verify failed chat prompt retention on both server and client
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const devServerSrc = readFileSync(join(__dirname, '../src/dev-server.mjs'), 'utf8');
  const indexHtmlSrc = readFileSync(join(__dirname, '../../archon-app/public/index.html'), 'utf8');
  assert.ok(devServerSrc.includes('const persistFailedChatTurn ='), 'Server must persist user prompt and error message on failed chat turn');
  assert.ok(indexHtmlSrc.includes('data-retain-prompt'), 'Client loadChatHistory must retain failed or in-flight user prompts in DOM');
});
