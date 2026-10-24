// ArchonOS Mesh Mailbox Durable Object (Pillar 3g: ArchonMailboxDO)
// Implements:
// 1. Outbound-only P2P / Small-Team Mesh relay accepting signed bundle manifests (@rho, 7ba8d94b)
// 2. DO-level size and rate caps enforced as explicit refusals
// 3. Four Mandatory Provenance Fields on every imported claim (@epistates, 48875c08):
//    - basis: { locator, content_sha256, n }
//    - defeaters_at_export: { open: [...], absence: 'none_held' | 'outside_share' | 'could_not_read' }
//    - peer_as_of: { graphVersion, observedAt }
//    - canonical_id_join: explicit mapping from peer kind:shortid to local canonical ID;
//      unmapped imports stay in quarantine view to prevent twinned-entity double counting.
// 4. Key Custody Honesty badge: encryption_mode ('e2ee-local-custodian' | 'cloudflare-managed')
// 5. Cross-Archon Shared Seat Capability Leasing (scoped seat_grant, non-transferable, quota-capped in grantor ledger)

import { createHash } from 'node:crypto';
import { validateBundle, signManifest } from '../../archon-mesh/mesh-bundle.mjs';
import { evaluateHandsUpRail, appendCharge, spentForSeat } from './ledger.mjs';

export const MAX_BUNDLE_BYTES = 2 * 1024 * 1024; // 2 MB manifest + inline payload cap
export const MAX_BUNDLES_PER_WINDOW = 30;
export const VALID_ABSENCE_STATES = new Set(['none_held', 'outside_share', 'could_not_read']);

export const SEAT_ALIAS_MAP = {
  'chief-of-staff': 'seat:chief-of-staff',
  cos: 'seat:chief-of-staff',
  chief: 'seat:chief-of-staff',
  'seat-archon': 'seat:chief-of-staff',
  archon: 'seat:chief-of-staff',
  'code-architect': 'seat:code-architect',
  architect: 'seat:code-architect',
  code: 'seat:code-architect',
  'deep-research': 'seat:deep-research',
  research: 'seat:deep-research',
  researcher: 'seat:deep-research',
  'maritime-quant': 'seat:maritime-quant',
  maritime: 'seat:maritime-quant',
  quant: 'seat:maritime-quant',
  'creative-studio': 'seat:creative-studio',
  creative: 'seat:creative-studio',
  studio: 'seat:creative-studio',
  'ops-sre': 'seat:ops-sre',
  'ops-guardian': 'seat:ops-guardian',
  ops: 'seat:ops-sre',
  sre: 'seat:ops-sre',
};

export function normalizeMeshSeatId(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const clean = raw.trim().toLowerCase().replace(/^@+/, '').replace(/^seat:/, '');
  if (!clean) return null;
  if (SEAT_ALIAS_MAP[clean]) return SEAT_ALIAS_MAP[clean];
  if (/^[a-z0-9][a-z0-9_-]{1,48}$/.test(clean)) return `seat:${clean}`;
  return null;
}

export function extractMeshMemberMentions(content = '') {
  const text = String(content || '');
  const matches = [...text.matchAll(/(?:^|\s)@([a-zA-Z0-9][a-zA-Z0-9_.:-]{0,63})/g)];
  const members = [];
  for (const m of matches) {
    const raw = m[1];
    const lower = raw.toLowerCase();
    if (/^(?:seat|skill|artifact|mcp|file|room|team):/i.test(raw)) continue;
    if (SEAT_ALIAS_MAP[lower]) continue;
    if (!members.includes(raw)) members.push(raw);
  }
  return members;
}

export function resolveMeshTargetSeat({
  content = '',
  targetSeat = null,
  coordinatorSeat = null,
  registeredSeats = null,
} = {}) {
  let candidate = null;
  let source = null;

  const seatList =
    registeredSeats instanceof Map
      ? [...registeredSeats.values()]
      : Array.isArray(registeredSeats)
        ? registeredSeats
        : [];

  if (targetSeat && String(targetSeat).trim()) {
    const cleanTarget = String(targetSeat).trim();
    if (!cleanTarget.startsWith('@') || cleanTarget.startsWith('@seat:') || SEAT_ALIAS_MAP[cleanTarget.replace(/^@+/, '').toLowerCase()]) {
      candidate = normalizeMeshSeatId(cleanTarget);
      source = 'explicit-selector';
    }
  }
  if (!candidate) {
    const text = String(content || '');
    const explicitSeatMatch = text.match(/(?:^|\s)@seat:([a-z0-9][a-z0-9_-]{1,48})\b/i);
    if (explicitSeatMatch) {
      candidate = normalizeMeshSeatId(explicitSeatMatch[1]);
      source = 'mention';
    } else {
      const mentionMatches = [...text.matchAll(/(?:^|\s)@(?!(?:skill|artifact|mcp|file|room|team):)([a-z0-9][a-z0-9_-]{1,48})(?!:)\b/gi)];
      for (const mm of mentionMatches) {
        const token = mm[1].toLowerCase();
        const isKnownAlias = Boolean(SEAT_ALIAS_MAP[token]);
        const isRegisteredSeat = seatList.some(
          (s) => String(s.id || '').replace(/^seat:/, '').toLowerCase() === token
        );
        if (isKnownAlias || isRegisteredSeat) {
          candidate = normalizeMeshSeatId(token);
          source = 'mention';
          break;
        }
      }
      if (!candidate && coordinatorSeat && String(coordinatorSeat).trim()) {
        candidate = normalizeMeshSeatId(String(coordinatorSeat));
        source = 'room-coordinator';
      }
    }
  }

  if (!candidate) {
    return { targeted: false, targetSeat: null, source: null, valid: true };
  }

  const bareId = candidate.replace(/^seat:/, '');
  if (seatList.length > 0) {
    const matched = seatList.find((s) => {
      const sid = String(s.id || '').replace(/^seat:/, '').toLowerCase();
      return sid === bareId || (bareId === 'chief-of-staff' && sid === 'seat-archon');
    });
    if (!matched || matched.enabled === false) {
      return {
        targeted: true,
        targetSeat: candidate,
        source,
        valid: false,
        reason: !matched ? 'target_seat_not_registered' : 'target_seat_disabled',
      };
    }
  }

  return { targeted: true, targetSeat: candidate, source, valid: true };
}

export function sanitizeMeshExecutionError(errInput) {
  const raw = String(errInput || 'Seat execution failed').trim();
  return (
    raw
      .replace(/\/Users\/[^\s"']+/g, '[redacted-path]')
      .replace(/\/home\/[^\s"']+/g, '[redacted-path]')
      .replace(/(?:Bearer|sk-|rk-|token=)\s*[A-Za-z0-9._-]+/gi, '[redacted-secret]')
      .slice(0, 280) || 'Seat execution failed'
  );
}

const EXEC_STATUS_RANK = { queued: 1, running: 2, failed: 3, completed: 4 };

export class ArchonMailboxDO {
  constructor(state, env = {}) {
    this.state = state;
    this.env = env;
    this.encryptionMode = env.ENCRYPTION_MODE ?? 'e2ee-local-custodian';
    this.maxBundleBytes = env.MAX_BUNDLE_BYTES ?? MAX_BUNDLE_BYTES;
    this.maxBundlesPerWindow = env.MAX_BUNDLES_PER_WINDOW ?? MAX_BUNDLES_PER_WINDOW;
    this.maxPeerExecutionsPerWindow = Number(env.MESH_PEER_EXEC_RATE_LIMIT ?? 6);
    this.maxRoomExecutionsPerWindow = Number(env.MESH_ROOM_EXEC_RATE_LIMIT ?? 12);
    this.maxConcurrentPerRoom = Number(env.MESH_ROOM_MAX_CONCURRENT ?? 2);

    this.trustedKeys = new Map(); // senderKey -> publicKeyPem
    this.committedObjects = new Map(); // `${canonicalId}@${version}` -> committed record
    this.quarantine = []; // quarantined object records
    this.seatGrants = new Map(); // seatGrantId -> grant
    this.grantLedgerRows = []; // hash-chained charge ledger for shared-seat leases
    this.rateCounter = new Map(); // senderKey -> count in current window
    this.peerExecutionRateMap = new Map(); // `${roomId}:${userId}` -> number[] timestamps
    this.roomExecutionRateMap = new Map(); // `${roomId}` -> number[] timestamps
    this.secureChannels = new Map(); // channelId -> SecureChannel record
    this.teamGroups = new Map(); // teamId -> Team/Group record
    this.hostStatus = {
      online: env.ARCHON_HOST_ONLINE !== 'false',
      hostId: 'local-custodian',
      lastHeartbeatAt: new Date().toISOString(),
    };
  }

  // Serialize requests across awaits as well as across Worker isolates.
  async fetch(request) {
    const previous = this.pendingRequest || Promise.resolve();
    let release;
    this.pendingRequest = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      const snapshot = await this.state.storage.get('mesh-state');
      if (snapshot) this.mergeMeshSnapshot(snapshot);
      const { createArchonEdgeRuntime } = await import('./index.mjs');
      const runtime = createArchonEdgeRuntime({ ...this.env, ARCHON_REMOTE: 'false',
        ARCHON_MAILBOX: undefined, MAILBOX_INSTANCE: this });
      const response = await runtime.fetch(request);
      if (response.ok && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
        await this.state.storage.put('mesh-state', {
          channels: this.listSecureChannels(), teams: this.listTeamGroups(),
          hostStatus: this.hostStatus,
        });
      }
      return response;
    } finally { release(); }
  }

  mergeMeshSnapshot({ channels = [], teams = [], hostStatus = null } = {}) {
    if (hostStatus && typeof hostStatus === 'object') {
      this.hostStatus = { ...this.hostStatus, ...hostStatus };
    }
    const pickAdvancedExec = (a, b) => {
      if (!a) return structuredClone(b);
      if (!b) return structuredClone(a);
      const rankA = EXEC_STATUS_RANK[a.status] || 0;
      const rankB = EXEC_STATUS_RANK[b.status] || 0;
      if (rankB > rankA) return structuredClone(b);
      if (rankA > rankB) return structuredClone(a);
      if ((b.attempts || 0) > (a.attempts || 0)) return structuredClone(b);
      if ((a.attempts || 0) > (b.attempts || 0)) return structuredClone(a);
      return (b.updatedAt || '') > (a.updatedAt || '') ? structuredClone(b) : structuredClone(a);
    };
    const merge = (store, records, key) => {
      for (const incoming of records) {
        if (!incoming || typeof incoming[key] !== 'string') continue;
        const current = store.get(incoming[key]);
        if (!current) { store.set(incoming[key], structuredClone(incoming)); continue; }
        // Existing authority metadata and tokens win. Union append-only data so
        // a stale workstation cannot erase edge joins, peer messages, or completed seat runs.
        for (const [field, identity] of [
          ['members', 'userId'],
          ['messages', 'messageId'],
          ['accessKeys', 'keyId'],
          ['sharedArtifacts', 'artifactId'],
          ['sharedSkills', 'skillId'],
          ['sharedResources', 'resourceId'],
          ['topicRooms', 'roomId'],
          ['seatExecutions', 'executionId'],
        ]) {
          const entries = new Map((current[field] || []).map((item) => [item[identity], item]));
          for (const item of incoming[field] || []) {
            if (!item || !item[identity]) continue;
            if (!entries.has(item[identity])) {
              entries.set(item[identity], structuredClone(item));
            } else if (field === 'seatExecutions') {
              entries.set(item[identity], pickAdvancedExec(entries.get(item[identity]), item));
            } else if (field === 'messages') {
              const existingMsg = entries.get(item[identity]);
              if (item.execution || existingMsg.execution) {
                existingMsg.execution = pickAdvancedExec(existingMsg.execution, item.execution);
              }
            } else if (field === 'topicRooms') {
              const existingRoom = entries.get(item[identity]);
              const msgMap = new Map((existingRoom.messages || []).map((m) => [m.messageId, m]));
              for (const rm of item.messages || []) {
                if (rm && rm.messageId && !msgMap.has(rm.messageId)) {
                  msgMap.set(rm.messageId, structuredClone(rm));
                }
              }
              existingRoom.messages = [...msgMap.values()];
              existingRoom.updatedAt = [existingRoom.updatedAt, item.updatedAt].filter(Boolean).sort().at(-1);
            } else if (field === 'sharedArtifacts' || field === 'sharedSkills' || field === 'sharedResources') {
              entries.set(item[identity], structuredClone(item));
            }
          }
          if (current[field] || incoming[field]) current[field] = [...entries.values()];
        }
        if (Array.isArray(incoming.seatExecutionGrants)) {
          current.seatExecutionGrants = Array.from(
            new Set([...(current.seatExecutionGrants || []), ...incoming.seatExecutionGrants])
          );
        }
        if (incoming.coordinatorSeat !== undefined && current.coordinatorSeat === undefined) {
          current.coordinatorSeat = incoming.coordinatorSeat;
        }
        current.updatedAt = [current.updatedAt, incoming.updatedAt].filter(Boolean).sort().at(-1);
      }
    };
    merge(this.secureChannels, channels, 'channelId');
    merge(this.teamGroups, teams, 'teamId');
  }

  getCustodyMetadata() {
    return {
      encryption_mode: this.encryptionMode,
      plaintext_visible_to_cloudflare: this.encryptionMode === 'cloudflare-managed',
      custodian_unix_user: this.encryptionMode === 'e2ee-local-custodian' ? '_archon_commit' : null,
    };
  }

  registerTrustedPeer(senderKey, publicKeyPem) {
    this.trustedKeys.set(senderKey, publicKeyPem);
  }

  receiveBundle(bundle, { now = Date.now() } = {}) {
    const rawSize = Buffer.byteLength(JSON.stringify(bundle?.manifest ?? {}), 'utf8');
    if (rawSize > this.maxBundleBytes) {
      return {
        ok: false,
        refusal: 'bundle-exceeds-size-cap',
        accepted: [],
        quarantined: [],
        custody: this.getCustodyMetadata(),
      };
    }

    const senderKey = bundle?.manifest?.senderKey ?? 'unknown';
    const count = (this.rateCounter.get(senderKey) ?? 0) + 1;
    this.rateCounter.set(senderKey, count);
    if (count > this.maxBundlesPerWindow) {
      return {
        ok: false,
        refusal: 'rate-limit-exceeded',
        accepted: [],
        quarantined: [],
        custody: this.getCustodyMetadata(),
      };
    }

    const trustedObj = Object.fromEntries(this.trustedKeys.entries());
    const baseResult = validateBundle(bundle, { trustedKeys: trustedObj });
    if (!baseResult.ok) {
      return {
        ...baseResult,
        custody: this.getCustodyMetadata(),
      };
    }

    const committed = [];
    const quarantined = [...baseResult.quarantined];

    for (const item of baseResult.accepted) {
      const p = item.payload ?? {};
      const provCheck = this._checkFourProvenanceFields(p);
      if (!provCheck.ok) {
        quarantined.push({ objectId: item.objectId, reason: provCheck.reason });
        this.quarantine.push({
          quarantineId: `q-${this.quarantine.length + 1}`,
          bundleId: bundle.manifest.bundleId,
          senderKey: bundle.manifest.senderKey,
          objectId: item.objectId,
          reason: provCheck.reason,
          rawObject: item,
          quarantinedAt: now,
        });
        continue;
      }

      // If canonical_id_join is unmapped, hold in quarantine view to prevent twinned-entity double counting
      if (p.canonical_id_join === 'unmapped' || !p.canonical_id_join.startsWith('local:')) {
        const reason = 'canonical-id-unmapped-quarantined';
        quarantined.push({ objectId: item.objectId, reason });
        this.quarantine.push({
          quarantineId: `q-${this.quarantine.length + 1}`,
          bundleId: bundle.manifest.bundleId,
          senderKey: bundle.manifest.senderKey,
          objectId: item.objectId,
          reason,
          rawObject: item,
          quarantinedAt: now,
        });
        continue;
      }

      const record = {
        objectId: item.objectId,
        canonicalId: p.canonical_id_join,
        version: item.version,
        payload: p,
        truncated: item.truncated,
        basis: p.basis,
        defeaters_at_export: p.defeaters_at_export,
        peer_as_of: p.peer_as_of,
        canonical_id_join: p.canonical_id_join,
        provenance: item.provenance,
        committedAt: now,
      };
      this.committedObjects.set(`${record.canonicalId}@${record.version}`, record);
      committed.push(record);
    }

    // Also persist base quarantined items into the DO quarantine list
    for (const qItem of baseResult.quarantined) {
      this.quarantine.push({
        quarantineId: `q-${this.quarantine.length + 1}`,
        bundleId: bundle.manifest.bundleId,
        senderKey: bundle.manifest.senderKey,
        objectId: qItem.objectId,
        reason: qItem.reason,
        rawObject: qItem,
        quarantinedAt: now,
      });
    }

    return {
      ok: true,
      refusal: null,
      accepted: committed,
      quarantined,
      counts: {
        value: committed.length,
        of: bundle.manifest.objects.length,
        population: 'objects-in-manifest',
      },
      custody: this.getCustodyMetadata(),
    };
  }

  _checkFourProvenanceFields(payload) {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, reason: 'payload-missing' };
    }
    // 1. basis: { locator, content_sha256, n }
    const b = payload.basis;
    if (!b || typeof b.locator !== 'string' || !/^[a-f0-9]{64}$/.test(b.content_sha256 ?? '') || !Number.isInteger(b.n) || b.n < 0) {
      return { ok: false, reason: 'provenance-basis-invalid' };
    }
    // 2. defeaters_at_export: { open: Array, absence: 'none_held' | 'outside_share' | 'could_not_read' }
    const d = payload.defeaters_at_export;
    if (!d || !Array.isArray(d.open) || !VALID_ABSENCE_STATES.has(d.absence)) {
      return { ok: false, reason: 'provenance-defeaters-at-export-invalid' };
    }
    // 3. peer_as_of: { graphVersion, observedAt }
    const p = payload.peer_as_of;
    if (!p || !Number.isInteger(p.graphVersion) || typeof p.observedAt !== 'string') {
      return { ok: false, reason: 'provenance-peer-as-of-invalid' };
    }
    // 4. canonical_id_join: string
    if (typeof payload.canonical_id_join !== 'string' || !payload.canonical_id_join) {
      return { ok: false, reason: 'provenance-canonical-id-join-missing' };
    }
    return { ok: true };
  }

  // Sharing Seats as Scoped Capabilities (Section 7.2.4):
  // Alice clears a Hands-Up approval on her console to mint a non-transferable seat_grant for Bob.
  mintSeatGrant({
    seatGrantId,
    seatId,
    granteePubkey,
    allowedTemplates,
    budgetQuota,
    expiresAt,
    transferable = false,
    author,
    origin,
    now = Date.now(),
  }) {
    const rail = evaluateHandsUpRail({
      origin,
      author,
      grantee: granteePubkey,
      actionKind: 'mesh_share',
    });
    if (!rail.allow) {
      return { ok: false, status: 403, reason: rail.reason };
    }
    if (transferable === true) {
      return { ok: false, status: 400, reason: 'seat_grant_non_transferable' };
    }
    if (!Array.isArray(allowedTemplates) || allowedTemplates.length === 0) {
      return { ok: false, status: 400, reason: 'allowed_templates_required' };
    }
    if (!Number.isSafeInteger(budgetQuota) || budgetQuota <= 0) {
      return { ok: false, status: 400, reason: 'budget_quota_must_be_positive_int' };
    }

    const grant = {
      seatGrantId,
      seatId,
      granteePubkey,
      allowedTemplates,
      budgetQuota,
      expiresAt,
      transferable: false,
      approvedBy: author,
      createdAt: now,
      signature: createHash('sha256')
        .update(`${seatGrantId}:${seatId}:${granteePubkey}:${budgetQuota}:${expiresAt}`)
        .digest('hex'),
    };
    this.seatGrants.set(seatGrantId, grant);
    return { ok: true, status: 201, grant };
  }

  // Execute a delegated task on a shared seat without exposing credentials:
  // Checks seat_grant, charges usage against grantee's sub-budget in grantor's hash-chained ledger.
  executeSharedSeatLease({
    seatGrantId,
    requesterPubkey,
    templateKey,
    taskId,
    engine = 'claude',
    taskCap,
    usage,
    now = Date.now(),
  }) {
    const grant = this.seatGrants.get(seatGrantId);
    if (!grant) return { ok: false, status: 404, reason: 'seat_grant_not_found' };
    if (grant.granteePubkey !== requesterPubkey) {
      return { ok: false, status: 403, reason: 'grantee_mismatch_non_transferable' };
    }
    if (now > grant.expiresAt) {
      return { ok: false, status: 403, reason: 'seat_grant_expired' };
    }
    if (!grant.allowedTemplates.includes(templateKey)) {
      return { ok: false, status: 403, reason: 'template_not_allowed_by_grant' };
    }
    if (!Number.isSafeInteger(taskCap) || taskCap <= 0) {
      return { ok: false, status: 400, reason: 'invalid_task_cap' };
    }

    const subSeatKey = `${grant.seatId}::grantee:${requesterPubkey}`;
    const alreadySpent = spentForSeat(this.grantLedgerRows, subSeatKey);
    if (alreadySpent + taskCap > grant.budgetQuota) {
      return { ok: false, status: 402, reason: 'grant_budget_quota_exceeded' };
    }

    this.grantLedgerRows = appendCharge(
      this.grantLedgerRows,
      subSeatKey,
      taskId,
      engine,
      taskCap,
      usage
    );
    const latestReceipt = this.grantLedgerRows[this.grantLedgerRows.length - 1];

    return {
      ok: true,
      status: 200,
      receipt: {
        seatGrantId,
        seatId: grant.seatId,
        taskId,
        charged: latestReceipt.body.charged,
        basis: latestReceipt.body.basis,
        ledgerRowHash: latestReceipt.hash,
        remainingQuota: grant.budgetQuota - spentForSeat(this.grantLedgerRows, subSeatKey),
        credentialsExposed: false,
      },
    };
  }

  // ===========================================================================
  // Phase 3: Multi-User Secure Channels via Cloudflare Remote
  // ===========================================================================
  createSecureChannel({
    channelId,
    name = 'Secure Coordination Channel',
    creatorId = 'operator:local',
    creatorPubkey = '',
    creatorSeat = 'seat:chief-of-staff',
    coordinatorSeat = null,
    seatExecutionGrants = null,
    remoteRelayUrl = 'https://archon-os-worker.workers.dev',
    encryptionMode = this.encryptionMode,
    now = Date.now(),
  } = {}) {
    const cleanName = String(name || 'Secure Coordination Channel').trim();
    if (!cleanName) {
      return { ok: false, status: 400, reason: 'channel_name_required' };
    }
    const id =
      channelId ||
      `sec-chan-${createHash('sha256')
        .update(`${cleanName}:${creatorId}:${now}`)
        .digest('hex')
        .slice(0, 12)}`;
    const tokenHash = createHash('sha256')
      .update(`${id}:${creatorId}:${creatorPubkey}:${now}`)
      .digest('hex')
      .toUpperCase();
    const inviteToken = `ARC-CHAN-${tokenHash.slice(0, 4)}-${tokenHash.slice(4, 8)}-${tokenHash.slice(8, 12)}`;
    const fingerprint = `sha256:${tokenHash.slice(0, 32).toLowerCase()}`;

    if (creatorPubkey) {
      this.registerTrustedPeer(creatorId, creatorPubkey);
    }

    const normalizedCreatorSeat = normalizeMeshSeatId(creatorSeat) || 'seat:chief-of-staff';
    const normalizedCoordinator = coordinatorSeat ? normalizeMeshSeatId(coordinatorSeat) : null;
    const defaultGrants = Array.isArray(seatExecutionGrants)
      ? seatExecutionGrants.map((s) => normalizeMeshSeatId(s)).filter(Boolean)
      : [normalizedCreatorSeat];

    const channel = {
      channelId: id,
      name: cleanName,
      creatorId,
      creatorSeat: normalizedCreatorSeat,
      coordinatorSeat: normalizedCoordinator,
      seatExecutionGrants: Array.from(new Set([...defaultGrants, ...(normalizedCoordinator ? [normalizedCoordinator] : [])])),
      seatExecutions: [],
      remoteRelayUrl,
      encryptionMode,
      inviteToken,
      fingerprint,
      custody: {
        encryption_mode: encryptionMode,
        plaintext_visible_to_cloudflare: encryptionMode === 'cloudflare-managed',
        custodian_unix_user: encryptionMode === 'e2ee-local-custodian' ? '_archon_commit' : null,
        transport_security: 'tls-invite-gated-durable-relay',
        storage_model: 'durable-object-relay-snapshot',
        identity_verification: 'self-declared-display-handle',
        message_integrity: 'sha256-content-digest',
      },
      sovereignIsolationPolicy: {
        modelHands: 'isolated-per-user-device',
        seatsAndSkills: 'isolated-per-user-workspace',
        mcpAndCredentials: 'isolated-default-deny-never-shared',
        settingsAndMemory: 'isolated-local-custody',
        crossUserBridge: 'invite-gated-channel-messages-and-bundles-only',
      },
      members: [
        {
          userId: creatorId,
          seatId: normalizedCreatorSeat,
          role: 'owner',
          identityModel: 'self-declared-display-handle',
          nodeRuntime: 'sovereign-user-node',
          isolatedHandsAndMcps: true,
          pubkeyFingerprint: creatorPubkey
            ? createHash('sha256').update(creatorPubkey).digest('hex').slice(0, 16)
            : fingerprint.slice(7, 23),
          joinedAt: new Date(now).toISOString(),
        },
      ],
      messages: [
        {
          messageId: `msg-${now}-init`,
          channelId: id,
          senderId: creatorId,
          senderSeat: normalizedCreatorSeat,
          authorType: 'system',
          kind: 'channel-genesis',
          content: `Secure Channel "${cleanName}" established via Cloudflare Remote durable relay (${encryptionMode}). Each member retains sovereign isolation of their own Model Hands, Seats, MCPs, and Settings. Invite Token: ${inviteToken}`,
          digestSha256: tokenHash.slice(0, 32).toLowerCase(),
          signature: tokenHash.slice(0, 32).toLowerCase(),
          createdAt: new Date(now).toISOString(),
        },
      ],
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };

    this.secureChannels.set(id, channel);
    return { ok: true, status: 201, channel };
  }

  joinSecureChannel({
    channelId,
    inviteToken,
    userId,
    seatId = 'seat:chief-of-staff',
    role = 'peer',
    nodeRuntime = 'sovereign-user-node',
    pubkeyPem = '',
    now = Date.now(),
  } = {}) {
    const cleanUserId = String(userId ?? '').trim();
    if (!cleanUserId || cleanUserId.length > 80) {
      return {
        ok: false,
        status: 400,
        reason: 'invalid_peer_identity',
        error: 'Peer identity (1-80 characters) is required to join.',
      };
    }

    let channel = channelId ? this.secureChannels.get(channelId) : null;
    if (!channel && inviteToken) {
      for (const ch of this.secureChannels.values()) {
        if (ch.inviteToken === inviteToken) {
          channel = ch;
          break;
        }
      }
    }
    if (!channel) {
      return { ok: false, status: 404, reason: 'secure_channel_not_found', error: 'Secure channel not found for invite token.' };
    }
    if (inviteToken && channel.inviteToken !== inviteToken) {
      return { ok: false, status: 403, reason: 'invalid_channel_invite_token', error: 'Invalid channel invite token.' };
    }
    if (pubkeyPem) {
      this.registerTrustedPeer(cleanUserId, pubkeyPem);
    }

    const allowedChannelRoles = new Set(['peer', 'member', 'observer']);
    const normalizedRole = allowedChannelRoles.has(role) ? role : 'peer';
    const existing = channel.members.find((m) => m.userId === cleanUserId);
    if (!existing) {
      channel.members.push({
        userId: cleanUserId,
        seatId,
        role: normalizedRole,
        identityModel: 'self-declared-display-handle',
        nodeRuntime,
        isolatedHandsAndMcps: true,
        pubkeyFingerprint: createHash('sha256')
          .update(pubkeyPem || `${cleanUserId}:${now}`)
          .digest('hex')
          .slice(0, 16),
        joinedAt: new Date(now).toISOString(),
      });
      const joinDigest = createHash('sha256').update(`${channel.channelId}:${cleanUserId}:${now}`).digest('hex').slice(0, 32);
      channel.messages.push({
        messageId: `msg-${now}-join`,
        channelId: channel.channelId,
        senderId: cleanUserId,
        senderSeat: seatId,
        authorType: 'system',
        kind: 'peer-joined',
        content: `${cleanUserId} (${seatId}) joined Secure Channel "${channel.name}" (self-declared display handle; local Model Hands, Seats, MCPs & Settings kept private).`,
        digestSha256: joinDigest,
        signature: joinDigest,
        createdAt: new Date(now).toISOString(),
      });
      channel.updatedAt = new Date(now).toISOString();
    }

    return { ok: true, status: 200, channel };
  }

  listSecureChannels() {
    return [...this.secureChannels.values()];
  }

  _checkAndRecordExecutionRate(roomId, userId, now = Date.now()) {
    const windowMs = 60000;
    const peerKey = `${roomId}:${userId}`;
    const peerTimes = (this.peerExecutionRateMap.get(peerKey) || []).filter((t) => now - t < windowMs);
    if (peerTimes.length >= this.maxPeerExecutionsPerWindow) {
      return {
        ok: false,
        status: 429,
        reason: 'peer_rate_limit_exceeded',
        error: `Rate limit exceeded: max ${this.maxPeerExecutionsPerWindow} seat executions per minute per peer.`,
      };
    }
    const roomTimes = (this.roomExecutionRateMap.get(roomId) || []).filter((t) => now - t < windowMs);
    if (roomTimes.length >= this.maxRoomExecutionsPerWindow) {
      return {
        ok: false,
        status: 429,
        reason: 'room_rate_limit_exceeded',
        error: `Rate limit exceeded: max ${this.maxRoomExecutionsPerWindow} seat executions per minute per room.`,
      };
    }
    peerTimes.push(now);
    roomTimes.push(now);
    this.peerExecutionRateMap.set(peerKey, peerTimes);
    this.roomExecutionRateMap.set(roomId, roomTimes);
    return { ok: true };
  }

  _enqueueRoomSeatExecution({
    room,
    roomId,
    roomKind,
    channelId,
    teamId = null,
    message,
    targetSeat,
    requestedBy,
    requesterRole,
    now = Date.now(),
  }) {
    if (!Array.isArray(room.seatExecutions)) {
      room.seatExecutions = [];
    }
    const executionId = `mexec-${message.messageId}`;
    const existing = room.seatExecutions.find(
      (ex) => ex.executionId === executionId || ex.originMessageId === message.messageId
    );
    if (existing) {
      message.execution = existing;
      return existing;
    }

    const execution = {
      executionId,
      originMessageId: message.messageId,
      roomId,
      roomKind,
      roomType: teamId ? 'team' : 'channel',
      channelId,
      teamId,
      targetSeat,
      requestedBy,
      requesterId: requestedBy,
      requesterRole,
      prompt: message.content,
      status: 'queued',
      hostAvailability: this.hostStatus.online ? 'online' : 'offline-queued',
      attempts: 0,
      maxAttempts: 2,
      leaseId: null,
      claimedByHost: null,
      replyMessageId: null,
      error: null,
      lastError: null,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      startedAt: null,
      completedAt: null,
    };
    room.seatExecutions.push(execution);
    message.execution = execution;
    return execution;
  }

  postChannelMessage({
    channelId,
    senderId = 'operator:local',
    senderSeat = 'seat:chief-of-staff',
    targetSeat = null,
    kind = 'cos-coordination',
    authorType = 'human',
    replyToMessageId = null,
    executionId = null,
    internalSeatReply = false,
    skipChannelExecution = false,
    registeredSeats = null,
    content = '',
    artifactRef = null,
    bundleId = null,
    now = Date.now(),
  } = {}) {
    const channel = this.secureChannels.get(channelId);
    if (!channel) {
      return { ok: false, status: 404, reason: 'secure_channel_not_found', error: 'Secure channel not found.' };
    }
    const cleanSenderId = String(senderId || '').trim();
    if (!internalSeatReply) {
      if (cleanSenderId.startsWith('seat:') || authorType === 'seat' || kind === 'seat-reply') {
        return {
          ok: false,
          status: 403,
          reason: 'seat_identity_spoofing_forbidden',
          error: 'Client messages cannot impersonate a seat identity or seat-reply.',
        };
      }
      const member = (channel.members || []).find((m) => m.userId === cleanSenderId);
      if (!member) {
        return {
          ok: false,
          status: 403,
          reason: 'membership_required',
          error: 'Sender must be a member of this channel to post messages.',
        };
      }
      if (member.role === 'observer') {
        return {
          ok: false,
          status: 403,
          reason: 'observer_cannot_post',
          error: 'Observers have read-only access and cannot post or trigger seat execution.',
        };
      }
    }

    const cleanContent = String(content || '').trim();
    if (!cleanContent) {
      return { ok: false, status: 400, reason: 'empty_channel_message', error: 'Message content cannot be empty.' };
    }

    const memberEntry = (channel.members || []).find((m) => m.userId === cleanSenderId);
    const resolvedRole = internalSeatReply ? 'seat' : memberEntry?.role || 'peer';

    // Resolve seat targeting for human messages when not mirrored from a team post
    let resolvedTargetSeat = targetSeat ? normalizeMeshSeatId(targetSeat) : null;
    let shouldEnqueueExec = false;

    if (!internalSeatReply && !skipChannelExecution && kind !== 'artifact-share') {
      const targetInfo = resolveMeshTargetSeat({
        content: cleanContent,
        targetSeat,
        coordinatorSeat: channel.coordinatorSeat || null,
        registeredSeats,
      });
      if (targetInfo.targeted) {
        if (!targetInfo.valid) {
          return {
            ok: false,
            status: 403,
            reason: targetInfo.reason || 'target_seat_unavailable',
            error: `Target seat ${targetInfo.targetSeat} is not registered or enabled.`,
          };
        }
        const grants = Array.isArray(channel.seatExecutionGrants)
          ? channel.seatExecutionGrants
          : [normalizeMeshSeatId(channel.creatorSeat) || 'seat:chief-of-staff'];
        if (!grants.includes(targetInfo.targetSeat)) {
          return {
            ok: false,
            status: 403,
            reason: 'seat_execution_not_granted',
            error: `Channel has not granted execution access to ${targetInfo.targetSeat}.`,
          };
        }
        const rateCheck = this._checkAndRecordExecutionRate(channel.channelId, cleanSenderId, now);
        if (!rateCheck.ok) return rateCheck;
        resolvedTargetSeat = targetInfo.targetSeat;
        shouldEnqueueExec = true;
      }
    }

    const msgHash = createHash('sha256')
      .update(`${channelId}:${cleanSenderId}:${senderSeat}:${cleanContent}:${now}`)
      .digest('hex');

    const message = {
      messageId: `msg-${now}-${msgHash.slice(0, 6)}`,
      channelId,
      senderId: cleanSenderId,
      senderSeat: internalSeatReply ? cleanSenderId : senderSeat,
      role: resolvedRole,
      authorType: internalSeatReply ? 'seat' : 'human',
      targetSeat: resolvedTargetSeat || 'seat:chief-of-staff',
      targetedSeat: resolvedTargetSeat,
      replyToMessageId: replyToMessageId || null,
      executionId: executionId || null,
      kind,
      content: cleanContent,
      artifactRef,
      bundleId,
      encryptedEnvelope: channel.encryptionMode === 'e2ee-local-custodian',
      transportSecurity: 'tls-durable-relay',
      identityModel: internalSeatReply ? 'authenticated-local-seat' : 'self-declared-display-handle',
      digestSha256: msgHash.slice(0, 32),
      signature: msgHash.slice(0, 32),
      createdAt: new Date(now).toISOString(),
    };

    let execution = null;
    if (shouldEnqueueExec && resolvedTargetSeat) {
      execution = this._enqueueRoomSeatExecution({
        room: channel,
        roomId: channel.channelId,
        roomKind: 'channel',
        channelId: channel.channelId,
        teamId: null,
        message,
        targetSeat: resolvedTargetSeat,
        requestedBy: cleanSenderId,
        requesterRole: resolvedRole,
        now,
      });
    }

    channel.messages.push(message);
    channel.updatedAt = new Date(now).toISOString();

    return {
      ok: true,
      status: 201,
      message,
      execution,
      hostStatus: this.hostStatus,
      channel,
    };
  }

  readChannelMessages(channelId, { limit = 50, viewerId = null } = {}) {
    const channel = this.secureChannels.get(channelId);
    if (!channel) {
      return { ok: false, status: 404, reason: 'secure_channel_not_found', error: 'Secure channel not found.' };
    }
    if (viewerId !== null && viewerId !== undefined) {
      const cleanViewer = String(viewerId).trim();
      const isMember = (channel.members || []).some((m) => m.userId === cleanViewer);
      if (!isMember) {
        return {
          ok: false,
          status: 403,
          reason: 'membership_required',
          error: 'Viewer must be a member of this channel to read messages.',
        };
      }
    }
    return {
      ok: true,
      status: 200,
      channelId: channel.channelId,
      name: channel.name,
      encryptionMode: channel.encryptionMode,
      coordinatorSeat: channel.coordinatorSeat || null,
      seatExecutionGrants: channel.seatExecutionGrants || [],
      seatExecutions: channel.seatExecutions || [],
      hostStatus: this.hostStatus,
      members: channel.members,
      messages: channel.messages.slice(-limit),
    };
  }

  // ===========================================================================
  // Phase 3: Multi-User Teams & Groups Coordination (team:<id> / group:<id>)
  // ===========================================================================
  createTeamGroup({
    teamId,
    kind = 'team', // 'team' or 'group'
    name = 'Archon Coordination Team',
    description = '',
    ownerId = 'operator:local',
    ownerSeat = 'seat:chief-of-staff',
    coordinatorSeat = null,
    seatExecutionGrants = null,
    remoteRelayUrl = 'https://archon-os-worker.workers.dev',
    encryptionMode = this.encryptionMode,
    now = Date.now(),
  } = {}) {
    const normalizedKind = kind === 'group' ? 'group' : 'team';
    const cleanName = String(name || 'Archon Coordination Team').trim();
    if (!cleanName) {
      return { ok: false, status: 400, reason: 'team_name_required' };
    }
    const slug = cleanName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24);
    const id =
      teamId ||
      `${normalizedKind}:${slug || 'alpha'}-${createHash('sha256')
        .update(`${cleanName}:${ownerId}:${now}`)
        .digest('hex')
        .slice(0, 6)}`;

    const normalizedOwnerSeat = normalizeMeshSeatId(ownerSeat) || 'seat:chief-of-staff';
    const normalizedCoordinator = coordinatorSeat ? normalizeMeshSeatId(coordinatorSeat) : null;
    const defaultGrants = Array.isArray(seatExecutionGrants)
      ? seatExecutionGrants.map((s) => normalizeMeshSeatId(s)).filter(Boolean)
      : [normalizedOwnerSeat];
    const effectiveGrants = Array.from(
      new Set([...defaultGrants, ...(normalizedCoordinator ? [normalizedCoordinator] : [])])
    );

    // Provision a dedicated Cloudflare Remote Secure Channel for this Team / Group
    const chanRes = this.createSecureChannel({
      name: `${cleanName} (${normalizedKind.toUpperCase()} Channel)`,
      creatorId: ownerId,
      creatorSeat: normalizedOwnerSeat,
      coordinatorSeat: normalizedCoordinator,
      seatExecutionGrants: effectiveGrants,
      remoteRelayUrl,
      encryptionMode,
      now,
    });

    const defaultRoomId = `room:${id.replace(/^(?:team|group):/, '')}:general`;
    const defaultGeneralRoom = {
      roomId: defaultRoomId,
      teamId: id,
      topic: 'general',
      title: 'General Coordination',
      description: `Default topic room under ${cleanName}. All team shared workspace resources (skills, artifacts, resources) are visible here.`,
      createdBy: ownerId,
      createdBySeat: normalizedOwnerSeat,
      status: 'OPEN',
      messages: [
        {
          messageId: `rmsg-${now}-init`,
          roomId: defaultRoomId,
          teamId: id,
          topic: 'general',
          senderId: ownerId,
          senderSeat: normalizedOwnerSeat,
          authorType: 'system',
          content: `Opened default topic room #general under ${normalizedKind} "${cleanName}". Team shared workspace resources are visible to all rooms.`,
          createdAt: new Date(now).toISOString(),
        },
      ],
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };

    const team = {
      teamId: id,
      kind: normalizedKind,
      name: cleanName,
      description: String(description || `Multi-user ${normalizedKind} coordinated via Cloudflare Remote Secure Channel.`).trim(),
      ownerId,
      ownerSeat: normalizedOwnerSeat,
      coordinatorSeat: normalizedCoordinator,
      seatExecutionGrants: effectiveGrants,
      seatExecutions: [],
      secureChannelId: chanRes.channel.channelId,
      inviteToken: chanRes.channel.inviteToken,
      accessKeys: [],
      remoteRelayUrl,
      encryptionMode,
      transportSecurity: 'tls-invite-gated-durable-relay',
      identityModel: 'self-declared-display-handle',
      localProcessingGuarantee: {
        mode: 'sovereign-peer-instance',
        remoteRelayExecutesModels: false,
        description: 'Each colleague processes messages and runs models/MCPs in their own sovereign Archon instance.',
      },
      members: [
        {
          userId: ownerId,
          seatId: normalizedOwnerSeat,
          role: 'owner',
          identityModel: 'self-declared-display-handle',
          joinedAt: new Date(now).toISOString(),
        },
      ],
      sharedArtifacts: [],
      sharedSkills: [],
      sharedResources: [],
      topicRooms: [defaultGeneralRoom],
      messages: [
        {
          messageId: `tmsg-${now}-init`,
          teamId: id,
          senderId: ownerId,
          senderSeat: normalizedOwnerSeat,
          authorType: 'system',
          role: 'owner',
          content: `Created ${normalizedKind.toUpperCase()} "${cleanName}" (${id}) backed by Secure Channel ${chanRes.channel.channelId}.`,
          createdAt: new Date(now).toISOString(),
        },
      ],
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };

    this.teamGroups.set(id, team);
    return {
      ok: true,
      status: 201,
      team,
      secureChannel: chanRes.channel,
      visibleTeamWorkspace: this.getTeamWorkspace(team),
    };
  }

  getTeamWorkspace(team) {
    if (!team) return { skills: [], artifacts: [], resources: [] };
    return {
      teamId: team.teamId,
      teamName: team.name,
      skills: team.sharedSkills || [],
      artifacts: team.sharedArtifacts || [],
      resources: team.sharedResources || [],
    };
  }

  mintTeamAccessKey({
    teamId,
    colleagueHandle = 'colleague:peer',
    role = 'member',
    allowedTopics = ['*'],
    mintedBy = 'operator:local',
    now = Date.now(),
  } = {}) {
    const team = this.teamGroups.get(teamId);
    if (!team) {
      return { ok: false, status: 404, reason: 'team_or_group_not_found', error: 'Team or group not found.' };
    }
    const cleanHandle = String(colleagueHandle || 'colleague:peer').trim().slice(0, 80);
    if (!cleanHandle) {
      return { ok: false, status: 400, reason: 'colleague_handle_required', error: 'Colleague handle is required.' };
    }
    const allowedRoles = new Set(['member', 'observer']);
    const normalizedRole = allowedRoles.has(role) ? role : 'member';
    const tokenHash = createHash('sha256')
      .update(`${team.teamId}:${cleanHandle}:${mintedBy}:${now}:${(team.accessKeys || []).length}`)
      .digest('hex')
      .toUpperCase();
    const accessKey = `ARCHON-KEY-${tokenHash.slice(0, 4)}-${tokenHash.slice(4, 8)}-${tokenHash.slice(8, 12)}`;
    const keyRecord = {
      keyId: `ak-${now}-${tokenHash.slice(0, 6).toLowerCase()}`,
      accessKey,
      teamId: team.teamId,
      teamName: team.name,
      colleagueHandle: cleanHandle,
      role: normalizedRole,
      allowedTopics: Array.isArray(allowedTopics) && allowedTopics.length > 0 ? allowedTopics : ['*'],
      mintedBy,
      status: 'active',
      createdAt: new Date(now).toISOString(),
    };
    team.accessKeys = team.accessKeys || [];
    team.accessKeys.unshift(keyRecord);
    team.updatedAt = new Date(now).toISOString();

    return {
      ok: true,
      status: 201,
      accessKey,
      keyRecord,
      teamId: team.teamId,
      teamName: team.name,
      remoteRelayUrl: team.remoteRelayUrl,
      mcpConfigSnippet: {
        mcpServers: {
          'archon-mesh': {
            url: `${team.remoteRelayUrl}/api/mcp/archon-mesh`,
            headers: {
              Authorization: `Bearer ${accessKey}`,
            },
          },
        },
      },
    };
  }

  verifyTeamAccessKey(rawKey) {
    const clean = String(rawKey || '').trim();
    if (!clean || !clean.startsWith('ARCHON-KEY-')) return { ok: false };
    for (const team of this.teamGroups.values()) {
      const found = (team.accessKeys || []).find((k) => k.accessKey === clean && k.status !== 'revoked');
      if (found) {
        return { ok: true, team, keyRecord: found };
      }
    }
    return { ok: false };
  }

  joinTeamGroup({
    teamId,
    inviteToken,
    accessKey,
    userId,
    seatId = 'seat:chief-of-staff',
    role = 'member',
    pubkeyPem = '',
    now = Date.now(),
  } = {}) {
    let matchedKeyRecord = null;
    let team = teamId ? this.teamGroups.get(teamId) : null;

    if (accessKey) {
      const verified = this.verifyTeamAccessKey(accessKey);
      if (!verified.ok) {
        return { ok: false, status: 403, reason: 'invalid_access_key', error: 'Invalid or revoked team access key.' };
      }
      if (team && team.teamId !== verified.team.teamId) {
        return { ok: false, status: 403, reason: 'access_key_team_mismatch', error: 'Access key does not belong to this team.' };
      }
      team = verified.team;
      matchedKeyRecord = verified.keyRecord;
    }

    if (!team && inviteToken) {
      for (const t of this.teamGroups.values()) {
        if (t.inviteToken === inviteToken) {
          team = t;
          break;
        }
        const keyHit = (t.accessKeys || []).find((k) => k.accessKey === inviteToken && k.status !== 'revoked');
        if (keyHit) {
          team = t;
          matchedKeyRecord = keyHit;
          break;
        }
      }
    }

    const cleanUserId = String(userId || matchedKeyRecord?.colleagueHandle || '').trim();
    if (!cleanUserId || cleanUserId.length > 80) {
      return {
        ok: false,
        status: 400,
        reason: 'invalid_peer_identity',
        error: 'Peer identity (1-80 characters) is required to join.',
      };
    }

    if (!team) {
      return { ok: false, status: 404, reason: 'team_or_group_not_found', error: 'Team or group not found for invite token or access key.' };
    }
    if (!matchedKeyRecord && inviteToken && team.inviteToken !== inviteToken) {
      const keyHit = (team.accessKeys || []).find((k) => k.accessKey === inviteToken && k.status !== 'revoked');
      if (keyHit) {
        matchedKeyRecord = keyHit;
      } else {
        return { ok: false, status: 403, reason: 'invalid_team_invite_token', error: 'Invalid team invite token.' };
      }
    }

    // Prevent self-assigned elevated roles (owner/admin) when joining via invite token or access key
    const allowedJoinRoles = new Set(['member', 'observer']);
    const requestedRole = matchedKeyRecord?.role || role;
    const normalizedRole = allowedJoinRoles.has(requestedRole) ? requestedRole : 'member';

    // Also join the underlying Secure Channel with the same clamped role
    this.joinSecureChannel({
      channelId: team.secureChannelId,
      inviteToken: team.inviteToken,
      userId: cleanUserId,
      seatId,
      role: normalizedRole,
      pubkeyPem,
      now,
    });

    const existing = team.members.find((m) => m.userId === cleanUserId);
    if (!existing) {
      team.members.push({
        userId: cleanUserId,
        seatId,
        role: normalizedRole,
        joinedVia: matchedKeyRecord ? `access-key:${matchedKeyRecord.keyId}` : 'invite-token',
        identityModel: 'self-declared-display-handle',
        joinedAt: new Date(now).toISOString(),
      });
      team.messages.push({
        messageId: `tmsg-${now}-join`,
        teamId: team.teamId,
        senderId: cleanUserId,
        senderSeat: seatId,
        authorType: 'system',
        role: normalizedRole,
        content: `${cleanUserId} (${seatId}) joined ${team.kind} "${team.name}" as ${normalizedRole} (self-declared display handle).`,
        createdAt: new Date(now).toISOString(),
      });
      team.updatedAt = new Date(now).toISOString();
    }

    return {
      ok: true,
      status: 200,
      team,
      visibleTeamWorkspace: this.getTeamWorkspace(team),
      topicRooms: team.topicRooms || [],
      localProcessingGuarantee: team.localProcessingGuarantee || {
        mode: 'sovereign-peer-instance',
        remoteRelayExecutesModels: false,
      },
    };
  }

  ensureTeamGroupDefaults(team) {
    if (!team) return team;
    team.kind = team.kind || 'team';
    team.accessKeys = Array.isArray(team.accessKeys) ? team.accessKeys : [];
    team.sharedSkills = Array.isArray(team.sharedSkills) ? team.sharedSkills : [];
    team.sharedArtifacts = Array.isArray(team.sharedArtifacts) ? team.sharedArtifacts : [];
    team.sharedResources = Array.isArray(team.sharedResources) ? team.sharedResources : [];
    team.localProcessingGuarantee = team.localProcessingGuarantee || {
      mode: 'sovereign-peer-instance',
      remoteRelayExecutesModels: false,
      description: 'Each colleague processes messages and runs models/MCPs in their own sovereign Archon instance.',
    };
    const defaultRoomId = `room:${String(team.teamId || 'alpha').replace(/^(?:team|group):/, '')}:general`;
    if (!Array.isArray(team.topicRooms) || team.topicRooms.length === 0) {
      team.topicRooms = [
        {
          roomId: defaultRoomId,
          teamId: team.teamId,
          topic: 'general',
          title: 'General Coordination',
          description: `Default topic room under ${team.name || team.teamId}. All team shared workspace resources (skills, artifacts, resources) are visible here.`,
          createdBy: team.ownerId || 'operator:local',
          createdBySeat: team.ownerSeat || 'seat:chief-of-staff',
          status: 'OPEN',
          messages:
            Array.isArray(team.messages) && team.messages.length > 0
              ? team.messages.map((m) => ({
                  ...m,
                  roomId: m.roomId || defaultRoomId,
                  topic: m.topic || 'general',
                }))
              : [
                  {
                    messageId: `rmsg-init-${team.teamId}`,
                    roomId: defaultRoomId,
                    teamId: team.teamId,
                    topic: 'general',
                    senderId: team.ownerId || 'operator:local',
                    senderSeat: team.ownerSeat || 'seat:chief-of-staff',
                    authorType: 'system',
                    content: `Opened default topic room #general under ${team.kind} "${team.name || team.teamId}". Team shared workspace resources are visible to all rooms.`,
                    createdAt: team.createdAt || new Date().toISOString(),
                  },
                ],
          createdAt: team.createdAt || new Date().toISOString(),
          updatedAt: team.updatedAt || new Date().toISOString(),
        },
      ];
    } else if (Array.isArray(team.messages) && team.messages.length > 0) {
      const generalRoom =
        team.topicRooms.find((r) => r.topic === 'general' || r.roomId === defaultRoomId) ||
        team.topicRooms[0];
      if (generalRoom) {
        generalRoom.messages = Array.isArray(generalRoom.messages) ? generalRoom.messages : [];
        const byId = new Map(generalRoom.messages.map((m) => [m.messageId, m]));
        let addedOrUpdated = false;
        for (const tm of team.messages) {
          if (!tm || !tm.messageId) continue;
          const belongsToOtherRoom =
            tm.roomId && tm.roomId !== generalRoom.roomId && tm.topic && tm.topic !== 'general';
          if (belongsToOtherRoom) continue;
          if (!byId.has(tm.messageId)) {
            byId.set(tm.messageId, {
              ...tm,
              roomId: generalRoom.roomId,
              topic: generalRoom.topic || 'general',
            });
            addedOrUpdated = true;
          } else {
            const existing = byId.get(tm.messageId);
            if (tm.execution && (!existing.execution || existing.execution.status !== tm.execution.status)) {
              existing.execution = tm.execution;
              addedOrUpdated = true;
            }
          }
        }
        if (addedOrUpdated) {
          generalRoom.messages = [...byId.values()].sort((a, b) =>
            String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
          );
        }
      }
    }
    return team;
  }

  listTeamGroups() {
    return [...this.teamGroups.values()].map((t) => this.ensureTeamGroupDefaults(t));
  }

  openTeamTopicRoom({
    teamId,
    topic,
    title = '',
    description = '',
    createdBy = 'operator:local',
    createdBySeat = 'seat:chief-of-staff',
    now = Date.now(),
  } = {}) {
    const team = this.teamGroups.get(teamId);
    if (!team) {
      return { ok: false, status: 404, reason: 'team_or_group_not_found', error: 'Team or group not found.' };
    }
    const cleanCreator = String(createdBy || 'operator:local').trim();
    const member = (team.members || []).find((m) => m.userId === cleanCreator);
    if (!member) {
      return {
        ok: false,
        status: 403,
        reason: 'membership_required',
        error: 'Must be a team member to open a topic room.',
      };
    }
    if (member.role === 'observer') {
      return {
        ok: false,
        status: 403,
        reason: 'observer_cannot_open_room',
        error: 'Observers have read-only access and cannot open topic rooms.',
      };
    }

    const rawTopic = String(topic || title || '').trim();
    if (!rawTopic) {
      return { ok: false, status: 400, reason: 'topic_required', error: 'Room topic is required.' };
    }
    const topicSlug =
      rawTopic
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 48) || 'general';
    const roomId = `room:${team.teamId.replace(/^(?:team|group):/, '')}:${topicSlug}`;

    team.topicRooms = team.topicRooms || [];
    const existing = team.topicRooms.find((r) => r.roomId === roomId || r.topic === topicSlug);
    if (existing) {
      return {
        ok: true,
        status: 200,
        alreadyExisted: true,
        teamId: team.teamId,
        room: existing,
        visibleTeamWorkspace: this.getTeamWorkspace(team),
      };
    }

    const room = {
      roomId,
      teamId: team.teamId,
      topic: topicSlug,
      title: String(title || rawTopic).trim(),
      description: String(
        description || `Topic room #${topicSlug} under team "${team.name}". Team shared workspace resources are visible here.`
      ).trim(),
      createdBy: cleanCreator,
      createdBySeat,
      status: 'OPEN',
      messages: [
        {
          messageId: `rmsg-${now}-init`,
          roomId,
          teamId: team.teamId,
          topic: topicSlug,
          senderId: cleanCreator,
          senderSeat: createdBySeat,
          authorType: 'system',
          content: `Opened topic room #${topicSlug} ("${String(title || rawTopic).trim()}") under team "${team.name}". Team shared workspace (skills, artifacts, resources) is visible to this room.`,
          createdAt: new Date(now).toISOString(),
        },
      ],
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };

    team.topicRooms.push(room);
    team.updatedAt = new Date(now).toISOString();

    return {
      ok: true,
      status: 201,
      teamId: team.teamId,
      room,
      visibleTeamWorkspace: this.getTeamWorkspace(team),
    };
  }

  readTeamTopicRoom({
    teamId = null,
    roomId = null,
    topic = null,
    viewerId = null,
    limit = 50,
  } = {}) {
    let team = teamId ? this.teamGroups.get(teamId) : null;
    if (!team && roomId) {
      for (const t of this.teamGroups.values()) {
        this.ensureTeamGroupDefaults(t);
        if ((t.topicRooms || []).some((r) => r.roomId === roomId)) {
          team = t;
          break;
        }
      }
    }
    if (!team) {
      return { ok: false, status: 404, reason: 'team_or_group_not_found', error: 'Team or topic room not found.' };
    }
    this.ensureTeamGroupDefaults(team);
    if (viewerId !== null && viewerId !== undefined) {
      const cleanViewer = String(viewerId).trim();
      const isMember = (team.members || []).some((m) => m.userId === cleanViewer);
      if (!isMember) {
        return {
          ok: false,
          status: 403,
          reason: 'membership_required',
          error: 'Viewer must be a member of this team to read topic rooms and team workspace resources.',
        };
      }
    }

    const rooms = team.topicRooms || [];
    const visibleTeamWorkspace = this.getTeamWorkspace(team);
    const localProcessingGuarantee = team.localProcessingGuarantee || {
      mode: 'sovereign-peer-instance',
      remoteRelayExecutesModels: false,
    };

    if (!roomId && !topic) {
      return {
        ok: true,
        status: 200,
        teamId: team.teamId,
        teamName: team.name,
        topicRooms: rooms,
        visibleTeamWorkspace,
        localProcessingGuarantee,
      };
    }

    const topicSlug = topic
      ? String(topic).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '')
      : null;
    const room = rooms.find((r) => (roomId && r.roomId === roomId) || (topicSlug && r.topic === topicSlug));
    if (!room) {
      return { ok: false, status: 404, reason: 'topic_room_not_found', error: 'Topic room not found under team.' };
    }

    const cappedLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    return {
      ok: true,
      status: 200,
      teamId: team.teamId,
      teamName: team.name,
      room: {
        ...room,
        messages: (room.messages || []).slice(-cappedLimit),
      },
      visibleTeamWorkspace,
      localProcessingGuarantee,
    };
  }

  postTeamTopicRoomMessage({
    teamId = null,
    roomId = null,
    topic = null,
    senderId = 'operator:local',
    senderSeat = 'seat:chief-of-staff',
    targetSeat = null,
    kind = 'topic-message',
    content = '',
    artifactId = null,
    skillId = null,
    resourceId = null,
    registeredSeats = null,
    now = Date.now(),
  } = {}) {
    let team = teamId ? this.teamGroups.get(teamId) : null;
    if (!team && roomId) {
      for (const t of this.teamGroups.values()) {
        this.ensureTeamGroupDefaults(t);
        if ((t.topicRooms || []).some((r) => r.roomId === roomId)) {
          team = t;
          break;
        }
      }
    }
    if (!team) {
      return { ok: false, status: 404, reason: 'team_or_group_not_found', error: 'Team not found for topic room.' };
    }
    this.ensureTeamGroupDefaults(team);
    team.topicRooms = team.topicRooms || [];
    const topicSlug = topic
      ? String(topic).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '')
      : null;
    let room = team.topicRooms.find(
      (r) => (roomId && r.roomId === roomId) || (topicSlug && r.topic === topicSlug)
    );
    if (!room && topicSlug) {
      const opened = this.openTeamTopicRoom({
        teamId: team.teamId,
        topic: topicSlug,
        title: topic,
        createdBy: senderId,
        createdBySeat: senderSeat,
        now,
      });
      if (!opened.ok) return opened;
      room = opened.room;
    }
    if (!room) {
      room = team.topicRooms[0];
    }
    if (!room) {
      return { ok: false, status: 404, reason: 'topic_room_not_found', error: 'Topic room not found.' };
    }

    const teamPost = this.postTeamMessage({
      teamId: team.teamId,
      senderId,
      senderSeat,
      targetSeat,
      kind,
      registeredSeats,
      content,
      artifactId,
      skillId,
      now,
    });
    if (!teamPost.ok) return teamPost;

    const roomMsg = {
      ...teamPost.message,
      roomId: room.roomId,
      topic: room.topic,
      resourceId: resourceId || null,
    };
    room.messages = room.messages || [];
    const existingIdx = room.messages.findIndex((m) => m.messageId === roomMsg.messageId);
    if (existingIdx >= 0) {
      room.messages[existingIdx] = roomMsg;
    } else {
      room.messages.push(roomMsg);
    }
    room.updatedAt = new Date(now).toISOString();

    return {
      ok: true,
      status: 201,
      teamId: team.teamId,
      roomId: room.roomId,
      topic: room.topic,
      message: roomMsg,
      execution: teamPost.execution || null,
      visibleTeamWorkspace: this.getTeamWorkspace(team),
      localProcessingGuarantee: team.localProcessingGuarantee || {
        mode: 'sovereign-peer-instance',
        remoteRelayExecutesModels: false,
      },
      team,
    };
  }

  postTeamMessage({
    teamId,
    senderId = 'operator:local',
    senderSeat = 'seat:chief-of-staff',
    targetSeat = null,
    targetMember = null,
    kind = null,
    authorType = 'human',
    replyToMessageId = null,
    executionId = null,
    internalSeatReply = false,
    registeredSeats = null,
    content = '',
    artifactId = null,
    skillId = null,
    now = Date.now(),
  } = {}) {
    const team = this.teamGroups.get(teamId);
    if (!team) {
      return { ok: false, status: 404, reason: 'team_or_group_not_found', error: 'Team or group not found.' };
    }
    const cleanSenderId = String(senderId || '').trim();
    let role = 'seat';

    if (!internalSeatReply) {
      if (cleanSenderId.startsWith('seat:') || authorType === 'seat' || kind === 'seat-reply') {
        return {
          ok: false,
          status: 403,
          reason: 'seat_identity_spoofing_forbidden',
          error: 'Client messages cannot impersonate a seat identity or seat-reply.',
        };
      }
      const member = (team.members || []).find((m) => m.userId === cleanSenderId);
      if (!member) {
        return {
          ok: false,
          status: 403,
          reason: 'membership_required',
          error: 'Sender must be a member of this team or group to post messages.',
        };
      }
      if (member.role === 'observer') {
        return {
          ok: false,
          status: 403,
          reason: 'observer_cannot_post',
          error: 'Observers have read-only access and cannot post or trigger seat execution.',
        };
      }
      role = member.role || 'member';
    }

    const cleanContent = String(content || '').trim();
    if (!cleanContent) {
      return { ok: false, status: 400, reason: 'empty_team_message', error: 'Message content cannot be empty.' };
    }

    const mentionedMembers = extractMeshMemberMentions(cleanContent);
    const resolvedTargetMember = targetMember
      ? String(targetMember).replace(/^@+/, '').trim()
      : mentionedMembers[0] || null;

    let resolvedTargetSeat = null;
    if (targetSeat && (!String(targetSeat).startsWith('@') || String(targetSeat).startsWith('@seat:') || SEAT_ALIAS_MAP[String(targetSeat).replace(/^@+/, '').toLowerCase()])) {
      resolvedTargetSeat = normalizeMeshSeatId(targetSeat);
    }
    let shouldEnqueueExec = false;

    if (!internalSeatReply && kind !== 'artifact-share' && kind !== 'skill-share' && kind !== 'resource-share') {
      const targetInfo = resolveMeshTargetSeat({
        content: cleanContent,
        targetSeat,
        coordinatorSeat: team.coordinatorSeat || null,
        registeredSeats,
      });
      if (targetInfo.targeted) {
        if (!targetInfo.valid) {
          return {
            ok: false,
            status: 403,
            reason: targetInfo.reason || 'target_seat_unavailable',
            error: `Target seat ${targetInfo.targetSeat} is not registered or enabled.`,
          };
        }
        const grants = Array.isArray(team.seatExecutionGrants)
          ? team.seatExecutionGrants
          : [normalizeMeshSeatId(team.ownerSeat) || 'seat:chief-of-staff'];
        if (!grants.includes(targetInfo.targetSeat)) {
          return {
            ok: false,
            status: 403,
            reason: 'seat_execution_not_granted',
            error: `Team has not granted execution access to ${targetInfo.targetSeat}.`,
          };
        }
        const rateCheck = this._checkAndRecordExecutionRate(team.teamId, cleanSenderId, now);
        if (!rateCheck.ok) return rateCheck;
        resolvedTargetSeat = targetInfo.targetSeat;
        shouldEnqueueExec = true;
      }
    }

    // Mirror to the underlying Secure Channel for durable relay audit trail
    const chanPost = this.postChannelMessage({
      channelId: team.secureChannelId,
      senderId: cleanSenderId,
      senderSeat: internalSeatReply ? cleanSenderId : senderSeat,
      targetSeat: resolvedTargetSeat || undefined,
      kind: kind || (internalSeatReply ? 'seat-reply' : `${team.kind}-message`),
      authorType: internalSeatReply ? 'seat' : 'human',
      replyToMessageId,
      executionId,
      internalSeatReply,
      skipChannelExecution: true,
      content: cleanContent,
      artifactRef: artifactId,
      now,
    });

    const msg = {
      messageId: chanPost.ok ? chanPost.message.messageId : `tmsg-${now}`,
      teamId: team.teamId,
      secureChannelId: team.secureChannelId,
      senderId: cleanSenderId,
      senderSeat: internalSeatReply ? cleanSenderId : senderSeat,
      authorType: internalSeatReply ? 'seat' : 'human',
      kind: kind || (internalSeatReply ? 'seat-reply' : `${team.kind}-message`),
      targetMember: resolvedTargetMember,
      mentionedMembers,
      targetSeat: resolvedTargetSeat,
      targetedSeat: resolvedTargetSeat,
      replyToMessageId: replyToMessageId || null,
      executionId: executionId || null,
      role,
      content: cleanContent,
      artifactId,
      skillId,
      digestSha256: chanPost.ok ? chanPost.message.digestSha256 : null,
      signature: chanPost.ok ? chanPost.message.signature : null,
      createdAt: new Date(now).toISOString(),
    };

    let execution = null;
    if (shouldEnqueueExec && resolvedTargetSeat) {
      execution = this._enqueueRoomSeatExecution({
        room: team,
        roomId: team.teamId,
        roomKind: team.kind,
        channelId: team.secureChannelId,
        teamId: team.teamId,
        message: msg,
        targetSeat: resolvedTargetSeat,
        requestedBy: cleanSenderId,
        requesterRole: role,
        now,
      });
      if (chanPost.ok && chanPost.message) {
        chanPost.message.execution = execution;
      }
    }

    team.messages.push(msg);
    team.updatedAt = new Date(now).toISOString();

    return {
      ok: true,
      status: 201,
      message: msg,
      execution,
      hostStatus: this.hostStatus,
      visibleTeamWorkspace: this.getTeamWorkspace(team),
      team,
    };
  }

  shareTeamArtifact({
    teamId,
    artifactId,
    title = '',
    kind = 'markdown-report',
    revision = 1,
    markdownContent = '',
    data = null,
    sharedBy = 'operator:local',
    sharedBySeat = 'seat:chief-of-staff',
    now = Date.now(),
  } = {}) {
    const team = this.teamGroups.get(teamId);
    if (!team) {
      return { ok: false, status: 404, reason: 'team_or_group_not_found', error: 'Team or group not found.' };
    }
    const cleanSharedBy = String(sharedBy || '').trim();
    const member = (team.members || []).find((m) => m.userId === cleanSharedBy);
    if (!member) {
      return {
        ok: false,
        status: 403,
        reason: 'membership_required',
        error: 'Sender must be a member of this team or group to share artifacts.',
      };
    }
    if (member.role === 'observer') {
      return {
        ok: false,
        status: 403,
        reason: 'observer_cannot_post',
        error: 'Observers have read-only access and cannot share artifacts.',
      };
    }
    if (!artifactId) {
      return { ok: false, status: 400, reason: 'artifact_id_required' };
    }
    const entry = {
      artifactId,
      title: title || artifactId,
      kind: kind || 'markdown-report',
      revision: Number(revision || 1),
      markdownContent: String(markdownContent || ''),
      data: data || null,
      sharedBy: cleanSharedBy,
      sharedBySeat,
      sharedAt: new Date(now).toISOString(),
    };
    team.sharedArtifacts = (team.sharedArtifacts || []).filter((a) => a.artifactId !== artifactId);
    team.sharedArtifacts.unshift(entry);
    this.postTeamMessage({
      teamId,
      senderId: cleanSharedBy,
      senderSeat: sharedBySeat,
      kind: 'artifact-share',
      content: `Shared Canvas artifact "${entry.title}" (${artifactId} @ r${entry.revision}) to ${team.kind} "${team.name}" workspace (visible to all topic rooms).`,
      artifactId,
      now,
    });
    return {
      ok: true,
      status: 200,
      artifact: entry,
      visibleTeamWorkspace: this.getTeamWorkspace(team),
      team,
    };
  }

  shareTeamSkill({
    teamId,
    skillId,
    name = '',
    version = 1,
    title = '',
    description = '',
    skillMd = '',
    config = {},
    sharedBy = 'operator:local',
    sharedBySeat = 'seat:chief-of-staff',
    now = Date.now(),
  } = {}) {
    const team = this.teamGroups.get(teamId);
    if (!team) {
      return { ok: false, status: 404, reason: 'team_or_group_not_found', error: 'Team or group not found.' };
    }
    const cleanSharedBy = String(sharedBy || '').trim();
    const member = (team.members || []).find((m) => m.userId === cleanSharedBy);
    if (!member) {
      return {
        ok: false,
        status: 403,
        reason: 'membership_required',
        error: 'Sender must be a member of this team or group to share skills.',
      };
    }
    if (member.role === 'observer') {
      return {
        ok: false,
        status: 403,
        reason: 'observer_cannot_post',
        error: 'Observers have read-only access and cannot share skills.',
      };
    }
    const cleanName = String(name || skillId || '')
      .trim()
      .replace(/@\d+$/, '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-');
    if (!cleanName) {
      return { ok: false, status: 400, reason: 'skill_id_required', error: 'Skill name or skillId is required.' };
    }
    const numVer = Number(version || 1);
    const resolvedSkillId = skillId || `${cleanName}@${numVer}`;
    const entry = {
      skillId: resolvedSkillId,
      name: cleanName,
      version: numVer,
      title: String(title || cleanName).trim(),
      description: String(description || `Shared skill ${resolvedSkillId}`).trim(),
      skillMd: String(skillMd || `# ${title || cleanName}\n\nShared via Archon Mesh team "${team.name}".`),
      config: config && typeof config === 'object' ? config : {},
      sharedBy: cleanSharedBy,
      sharedBySeat,
      sharedAt: new Date(now).toISOString(),
    };
    team.sharedSkills = (team.sharedSkills || []).filter((s) => s.skillId !== resolvedSkillId);
    team.sharedSkills.unshift(entry);
    this.postTeamMessage({
      teamId,
      senderId: cleanSharedBy,
      senderSeat: sharedBySeat,
      kind: 'skill-share',
      content: `Shared Skill "${entry.title}" (${resolvedSkillId}) to ${team.kind} "${team.name}" workspace (visible to all topic rooms).`,
      skillId: resolvedSkillId,
      now,
    });
    return {
      ok: true,
      status: 200,
      skill: entry,
      visibleTeamWorkspace: this.getTeamWorkspace(team),
      team,
    };
  }

  getTeamSharedResource({
    teamId,
    resourceType = 'all',
    resourceId = null,
    viewerId = null,
  } = {}) {
    const team = this.teamGroups.get(teamId);
    if (!team) {
      return { ok: false, status: 404, reason: 'team_or_group_not_found', error: 'Team or group not found.' };
    }
    if (viewerId !== null && viewerId !== undefined) {
      const cleanViewer = String(viewerId).trim();
      const isMember = (team.members || []).some((m) => m.userId === cleanViewer);
      if (!isMember) {
        return {
          ok: false,
          status: 403,
          reason: 'membership_required',
          error: 'Viewer must be a member of this team to read shared workspace resources.',
        };
      }
    }
    const workspace = this.getTeamWorkspace(team);
    if (!resourceId) {
      return {
        ok: true,
        status: 200,
        teamId: team.teamId,
        visibleTeamWorkspace: workspace,
      };
    }
    if (resourceType === 'skill' || resourceType === 'all') {
      const skill = (team.sharedSkills || []).find(
        (s) => s.skillId === resourceId || s.name === resourceId
      );
      if (skill) {
        return { ok: true, status: 200, teamId: team.teamId, resourceType: 'skill', resource: skill, visibleTeamWorkspace: workspace };
      }
    }
    if (resourceType === 'artifact' || resourceType === 'all') {
      const artifact = (team.sharedArtifacts || []).find((a) => a.artifactId === resourceId);
      if (artifact) {
        return { ok: true, status: 200, teamId: team.teamId, resourceType: 'artifact', resource: artifact, visibleTeamWorkspace: workspace };
      }
    }
    if (resourceType === 'resource' || resourceType === 'all') {
      const res = (team.sharedResources || []).find((r) => r.resourceId === resourceId);
      if (res) {
        return { ok: true, status: 200, teamId: team.teamId, resourceType: 'resource', resource: res, visibleTeamWorkspace: workspace };
      }
    }
    return {
      ok: false,
      status: 404,
      reason: 'shared_resource_not_found',
      error: `Shared resource "${resourceId}" (${resourceType}) was not found in team "${team.name}" workspace.`,
    };
  }

  readTeamSharedArtifact({ teamId, artifactId, viewerId = null } = {}) {
    const team = this.teamGroups.get(teamId);
    if (!team) {
      return { ok: false, status: 404, reason: 'team_or_group_not_found', error: 'Team or group not found.' };
    }
    if (viewerId !== null && viewerId !== undefined) {
      const cleanViewer = String(viewerId).trim();
      const isMember = (team.members || []).some((m) => m.userId === cleanViewer);
      if (!isMember) {
        return {
          ok: false,
          status: 403,
          reason: 'membership_required',
          error: 'Viewer must be a member of this team or group to access shared artifacts.',
        };
      }
    }
    const shared = (team.sharedArtifacts || []).find((a) => a.artifactId === artifactId);
    if (!shared) {
      return {
        ok: false,
        status: 403,
        reason: 'artifact_not_shared_with_room',
        error: 'Artifact has not been shared with this room.',
      };
    }
    return {
      ok: true,
      status: 200,
      teamId: team.teamId,
      artifact: shared,
      visibleTeamWorkspace: this.getTeamWorkspace(team),
    };
  }

  configureRoomSeatExecution({
    roomId,
    coordinatorSeat,
    seatExecutionGrants,
    actorId = 'operator:local',
    isAdmin = true,
    now = Date.now(),
  } = {}) {
    const team = this.teamGroups.get(roomId);
    const channel = team ? this.secureChannels.get(team.secureChannelId) : this.secureChannels.get(roomId);
    const targetRoom = team || channel;
    if (!targetRoom) {
      return { ok: false, status: 404, reason: 'room_not_found', error: 'Room not found.' };
    }

    if (!isAdmin) {
      const member = (targetRoom.members || []).find((m) => m.userId === actorId);
      if (!member || (member.role !== 'owner' && member.role !== 'admin')) {
        return {
          ok: false,
          status: 403,
          reason: 'owner_or_admin_required',
          error: 'Only room owner or admin can configure room-to-seat execution grants.',
        };
      }
    }

    if (coordinatorSeat !== undefined) {
      const normCoord = coordinatorSeat ? normalizeMeshSeatId(coordinatorSeat) : null;
      targetRoom.coordinatorSeat = normCoord;
      if (channel && channel !== targetRoom) channel.coordinatorSeat = normCoord;
    }

    if (Array.isArray(seatExecutionGrants)) {
      const normGrants = Array.from(
        new Set(seatExecutionGrants.map((s) => normalizeMeshSeatId(s)).filter(Boolean))
      );
      targetRoom.seatExecutionGrants = normGrants;
      if (channel && channel !== targetRoom) channel.seatExecutionGrants = normGrants;
    }

    targetRoom.updatedAt = new Date(now).toISOString();
    return {
      ok: true,
      status: 200,
      roomId,
      coordinatorSeat: targetRoom.coordinatorSeat || null,
      seatExecutionGrants: targetRoom.seatExecutionGrants || [],
    };
  }

  setHostAvailability({ online = true, hostId = 'local-custodian', now = Date.now() } = {}) {
    this.hostStatus = {
      online: Boolean(online),
      hostId,
      lastHeartbeatAt: new Date(now).toISOString(),
    };
    const allRooms = [...this.teamGroups.values(), ...this.secureChannels.values()];
    for (const room of allRooms) {
      for (const ex of room.seatExecutions || []) {
        if (ex.status === 'queued') {
          ex.hostAvailability = this.hostStatus.online ? 'online' : 'offline-queued';
        }
      }
    }
    return { ok: true, status: 200, hostStatus: this.hostStatus };
  }

  claimMeshSeatExecutions({
    hostId = 'local-custodian',
    maxConcurrent = 2,
    leaseTimeoutMs = 30000,
    now = Date.now(),
  } = {}) {
    this.setHostAvailability({ online: true, hostId, now });

    const claimed = [];
    const allRooms = [...this.teamGroups.values(), ...this.secureChannels.values()];
    let globalRunning = 0;

    // 1. Recover timed-out running leases (re-queue if attempts < maxAttempts, else fail)
    for (const room of allRooms) {
      for (const ex of room.seatExecutions || []) {
        if (ex.status === 'running') {
          const startedMs = ex.startedAt ? Date.parse(ex.startedAt) : 0;
          if (startedMs && now - startedMs > leaseTimeoutMs) {
            if ((ex.attempts || 0) < (ex.maxAttempts || 2)) {
              ex.status = 'queued';
              ex.leaseId = null;
              ex.error = 'Lease timed out; re-queued for retry.';
              ex.updatedAt = new Date(now).toISOString();
            } else {
              this.completeMeshSeatExecution({
                executionId: ex.executionId,
                leaseId: ex.leaseId,
                status: 'failed',
                error: 'Seat execution timed out after maximum retry attempts.',
                forceTimeoutFail: true,
                now,
              });
            }
          } else {
            globalRunning += 1;
          }
        }
      }
    }

    // 2. Claim queued executions respecting per-room and global concurrency caps
    for (const room of allRooms) {
      const execList = room.seatExecutions || [];
      let roomRunning = execList.filter((e) => e.status === 'running').length;

      for (const ex of execList) {
        if (globalRunning >= maxConcurrent) break;
        if (roomRunning >= this.maxConcurrentPerRoom) break;
        if (ex.status !== 'queued') continue;

        ex.status = 'running';
        ex.attempts = (ex.attempts || 0) + 1;
        ex.claimedByHost = hostId;
        ex.leaseId = `lease-${ex.executionId}-${ex.attempts}`;
        ex.hostAvailability = 'online';
        ex.startedAt = new Date(now).toISOString();
        ex.updatedAt = new Date(now).toISOString();

        const origMsg = (room.messages || []).find((m) => m.messageId === ex.originMessageId);
        if (origMsg) origMsg.execution = ex;

        roomRunning += 1;
        globalRunning += 1;
        claimed.push(structuredClone(ex));
      }
    }

    return {
      ok: true,
      status: 200,
      hostStatus: this.hostStatus,
      claimed,
    };
  }

  completeMeshSeatExecution({
    executionId,
    leaseId = null,
    status = 'completed',
    replyContent = '',
    error = null,
    retryable = true,
    forceTimeoutFail = false,
    latencyMs = 0,
    engine = 'local-hand',
    now = Date.now(),
  } = {}) {
    let targetRoom = null;
    let isTeam = false;
    let exec = null;

    for (const team of this.teamGroups.values()) {
      const found = (team.seatExecutions || []).find((e) => e.executionId === executionId);
      if (found) {
        targetRoom = team;
        isTeam = true;
        exec = found;
        break;
      }
    }
    if (!exec) {
      for (const chan of this.secureChannels.values()) {
        const found = (chan.seatExecutions || []).find((e) => e.executionId === executionId);
        if (found) {
          targetRoom = chan;
          isTeam = false;
          exec = found;
          break;
        }
      }
    }

    if (!exec || !targetRoom) {
      return { ok: false, status: 404, reason: 'execution_not_found', error: 'Seat execution not found.' };
    }

    // Idempotent duplicate delivery check
    if (exec.status === 'completed') {
      return {
        ok: true,
        status: 200,
        idempotentDuplicate: true,
        execution: exec,
      };
    }

    if (!forceTimeoutFail && leaseId && exec.leaseId && exec.leaseId !== leaseId) {
      return {
        ok: false,
        status: 409,
        reason: 'stale_execution_lease',
        error: 'Stale execution lease rejected.',
      };
    }

    // Bounded retry on transient failure
    if (
      status !== 'completed' &&
      !forceTimeoutFail &&
      retryable !== false &&
      (exec.attempts || 1) < (exec.maxAttempts || 2)
    ) {
      exec.status = 'queued';
      exec.leaseId = null;
      exec.error = sanitizeMeshExecutionError(error);
      exec.lastError = exec.error;
      exec.updatedAt = new Date(now).toISOString();
      const origMsg = (targetRoom.messages || []).find((m) => m.messageId === exec.originMessageId);
      if (origMsg) origMsg.execution = exec;
      return {
        ok: true,
        status: 200,
        requeued: true,
        execution: exec,
      };
    }

    const finalStatus = status === 'completed' ? 'completed' : 'failed';
    const sanitizedErr = finalStatus === 'failed' ? sanitizeMeshExecutionError(error) : null;
    const finalReplyText =
      finalStatus === 'completed'
        ? String(replyContent || '').trim() || `[${exec.targetSeat}] Completed task.`
        : `⚠️ [${exec.targetSeat}] Seat execution failed: ${sanitizedErr}`;

    const postRes = isTeam
      ? this.postTeamMessage({
          teamId: targetRoom.teamId,
          senderId: exec.targetSeat,
          senderSeat: exec.targetSeat,
          kind: 'seat-reply',
          authorType: 'seat',
          replyToMessageId: exec.originMessageId,
          executionId: exec.executionId,
          internalSeatReply: true,
          content: finalReplyText,
          now,
        })
      : this.postChannelMessage({
          channelId: targetRoom.channelId,
          senderId: exec.targetSeat,
          senderSeat: exec.targetSeat,
          kind: 'seat-reply',
          authorType: 'seat',
          replyToMessageId: exec.originMessageId,
          executionId: exec.executionId,
          internalSeatReply: true,
          content: finalReplyText,
          now,
        });

    exec.status = finalStatus;
    exec.error = sanitizedErr;
    exec.lastError = sanitizedErr;
    exec.replyMessageId = postRes.ok ? postRes.message.messageId : null;
    exec.latencyMs = Number(latencyMs || 0);
    exec.engine = engine;
    exec.completedAt = new Date(now).toISOString();
    exec.updatedAt = new Date(now).toISOString();

    const origMsg = (targetRoom.messages || []).find((m) => m.messageId === exec.originMessageId);
    if (origMsg) origMsg.execution = exec;

    if (isTeam && postRes.ok && postRes.message) {
      this.ensureTeamGroupDefaults(targetRoom);
      const topicRooms = Array.isArray(targetRoom.topicRooms) ? targetRoom.topicRooms : [];
      const matchingTopicRoom =
        topicRooms.find((r) => (r.messages || []).some((m) => m.messageId === exec.originMessageId)) ||
        topicRooms.find((r) => r.topic === 'general') ||
        topicRooms[0];
      if (matchingTopicRoom) {
        matchingTopicRoom.messages = Array.isArray(matchingTopicRoom.messages) ? matchingTopicRoom.messages : [];
        const origTopicMsg = matchingTopicRoom.messages.find((m) => m.messageId === exec.originMessageId);
        if (origTopicMsg) origTopicMsg.execution = exec;
        if (!matchingTopicRoom.messages.some((m) => m.messageId === postRes.message.messageId)) {
          matchingTopicRoom.messages.push({
            ...postRes.message,
            roomId: matchingTopicRoom.roomId,
            topic: matchingTopicRoom.topic || 'general',
          });
        }
        matchingTopicRoom.updatedAt = new Date(now).toISOString();
      }
    }

    return {
      ok: true,
      status: 200,
      execution: exec,
      replyMessage: postRes.ok ? postRes.message : null,
    };
  }

  getArchonMeshMcpManifest() {
    return {
      id: 'archon-mesh',
      name: 'Archon Mesh Federation MCP (Agora-Style Teams & Topic Rooms)',
      version: '1.0.0',
      transport: 'http+stdio',
      endpoint: '/api/mcp/archon-mesh',
      architecture: {
        hierarchy: 'Team -> Shared Workspace (skills, artifacts, resources) -> Topic Rooms (room:<team_id>:<topic>)',
        localProcessingGuarantee:
          'Peers fetch room messages and shared resources via MCP and process them in their own sovereign Archon instances.',
      },
      tools: [
        {
          name: 'mesh_mint_access_key',
          description: 'Mint a scoped access key (ARCHON-KEY-...) for a colleague to join a Team and its Topic Rooms via MCP.',
          inputSchema: {
            type: 'object',
            properties: {
              teamId: { type: 'string', description: 'Team ID (e.g., team:alpha)' },
              colleagueHandle: { type: 'string', description: 'Colleague handle (e.g., peer:alice)' },
              role: { type: 'string', enum: ['member', 'observer'], default: 'member' },
              allowedTopics: { type: 'array', items: { type: 'string' } },
            },
            required: ['teamId', 'colleagueHandle'],
          },
        },
        {
          name: 'mesh_join_team',
          description: 'Join an Archon Mesh Team using a minted accessKey (ARCHON-KEY-...) or inviteToken.',
          inputSchema: {
            type: 'object',
            properties: {
              teamId: { type: 'string' },
              accessKey: { type: 'string', description: 'Minted colleague access key (ARCHON-KEY-...)' },
              inviteToken: { type: 'string', description: 'Team invite token (ARC-CHAN-...)' },
              userId: { type: 'string', description: 'Peer handle (e.g., peer:alice)' },
              seatId: { type: 'string', default: 'seat:chief-of-staff' },
            },
          },
        },
        {
          name: 'mesh_list_teams_and_rooms',
          description: 'List Archon Mesh Teams, their Shared Workspaces (skills, artifacts, resources), and Topic Rooms.',
          inputSchema: {
            type: 'object',
            properties: {
              teamId: { type: 'string', description: 'Optional Team ID filter' },
            },
          },
        },
        {
          name: 'mesh_open_room',
          description: 'Open or join a Topic Room (room:<team_id>:<topic>) under a Team. Team shared workspace resources are visible to all rooms.',
          inputSchema: {
            type: 'object',
            properties: {
              teamId: { type: 'string' },
              topic: { type: 'string', description: 'Room topic slug or title (e.g., vlcc-freight-arb)' },
              title: { type: 'string' },
              description: { type: 'string' },
            },
            required: ['teamId', 'topic'],
          },
        },
        {
          name: 'mesh_read_room',
          description: 'Read messages in a Topic Room along with the inherited Team Shared Workspace (skills, artifacts, resources) for local sovereign processing.',
          inputSchema: {
            type: 'object',
            properties: {
              teamId: { type: 'string' },
              roomId: { type: 'string' },
              topic: { type: 'string' },
              limit: { type: 'number', default: 50 },
            },
          },
        },
        {
          name: 'mesh_post_message',
          description: 'Post a message or synthesis to a Topic Room under a Team.',
          inputSchema: {
            type: 'object',
            properties: {
              teamId: { type: 'string' },
              roomId: { type: 'string' },
              topic: { type: 'string' },
              content: { type: 'string' },
              targetSeat: { type: 'string' },
              artifactId: { type: 'string' },
              skillId: { type: 'string' },
            },
            required: ['content'],
          },
        },
        {
          name: 'mesh_share_skill',
          description: 'Share a Skill (SKILL.md + config) into the Team Shared Workspace so all Topic Rooms under the Team can see and import it.',
          inputSchema: {
            type: 'object',
            properties: {
              teamId: { type: 'string' },
              skillId: { type: 'string' },
              name: { type: 'string' },
              version: { type: 'number', default: 1 },
              title: { type: 'string' },
              description: { type: 'string' },
              skillMd: { type: 'string' },
              config: { type: 'object' },
            },
            required: ['teamId', 'name'],
          },
        },
        {
          name: 'mesh_share_artifact',
          description: 'Share an Artifact into the Team Shared Workspace so all Topic Rooms under the Team can see and import it.',
          inputSchema: {
            type: 'object',
            properties: {
              teamId: { type: 'string' },
              artifactId: { type: 'string' },
              title: { type: 'string' },
              kind: { type: 'string' },
              revision: { type: 'number', default: 1 },
              markdownContent: { type: 'string' },
              data: { type: 'object' },
            },
            required: ['teamId', 'artifactId'],
          },
        },
        {
          name: 'mesh_import_shared_resource',
          description: 'Fetch a shared Skill, Artifact, or Resource from the Team Shared Workspace to import into the local Archon instance.',
          inputSchema: {
            type: 'object',
            properties: {
              teamId: { type: 'string' },
              resourceType: { type: 'string', enum: ['skill', 'artifact', 'resource', 'all'], default: 'all' },
              resourceId: { type: 'string' },
            },
            required: ['teamId'],
          },
        },
      ],
    };
  }

  executeMcpMeshTool({
    tool,
    args = {},
    callerId = 'operator:local',
    callerSeat = 'seat:chief-of-staff',
    scopedTeamId = null,
    isAdmin = true,
    registeredSeats = null,
    now = Date.now(),
  } = {}) {
    const cleanTool = String(tool || '').trim();
    const effectiveTeamId = scopedTeamId || args.teamId || null;
    const targetTeam = effectiveTeamId ? this.teamGroups.get(effectiveTeamId) : null;
    const defaultCaller = isAdmin && (!callerId || callerId === 'operator:local')
      ? targetTeam?.ownerId || 'operator:local'
      : callerId || 'operator:local';
    const effectiveUser =
      (!isAdmin && callerId ? callerId : null) ||
      args.userId ||
      args.senderId ||
      args.sharedBy ||
      args.createdBy ||
      defaultCaller;
    const effectiveSeat = args.seatId || args.senderSeat || args.sharedBySeat || callerSeat || 'seat:chief-of-staff';

    if (scopedTeamId && args.teamId && args.teamId !== scopedTeamId) {
      return {
        ok: false,
        status: 403,
        reason: 'room_scope_violation',
        error: `Scoped access key or peer session is restricted to team ${scopedTeamId}.`,
      };
    }

    switch (cleanTool) {
      case 'mesh_mint_access_key': {
        if (!isAdmin) {
          return {
            ok: false,
            status: 403,
            reason: 'admin_required',
            error: 'Only the team owner or operator can mint colleague access keys.',
          };
        }
        return this.mintTeamAccessKey({
          teamId: effectiveTeamId,
          colleagueHandle: args.colleagueHandle || args.userId,
          role: args.role || 'member',
          allowedTopics: args.allowedTopics,
          mintedBy: effectiveUser,
          now,
        });
      }
      case 'mesh_join_team': {
        return this.joinTeamGroup({
          teamId: effectiveTeamId,
          accessKey: args.accessKey,
          inviteToken: args.inviteToken,
          userId: args.userId || effectiveUser,
          seatId: effectiveSeat,
          role: args.role || 'member',
          now,
        });
      }
      case 'mesh_list_teams_and_rooms': {
        const allTeams = this.listTeamGroups();
        const filtered = scopedTeamId
          ? allTeams.filter((t) => t.teamId === scopedTeamId)
          : effectiveTeamId
            ? allTeams.filter((t) => t.teamId === effectiveTeamId)
            : allTeams;
        return {
          ok: true,
          status: 200,
          teams: filtered.map((t) => ({
            teamId: t.teamId,
            name: t.name,
            description: t.description,
            remoteRelayUrl: t.remoteRelayUrl,
            memberCount: (t.members || []).length,
            members: t.members || [],
            sharedWorkspace: this.getTeamWorkspace(t),
            topicRooms: (t.topicRooms || []).map((r) => ({
              roomId: r.roomId,
              topic: r.topic,
              title: r.title,
              description: r.description,
              status: r.status,
              messageCount: (r.messages || []).length,
              updatedAt: r.updatedAt,
            })),
            localProcessingGuarantee: t.localProcessingGuarantee,
          })),
        };
      }
      case 'mesh_open_room': {
        return this.openTeamTopicRoom({
          teamId: effectiveTeamId,
          topic: args.topic,
          title: args.title,
          description: args.description,
          createdBy: effectiveUser,
          createdBySeat: effectiveSeat,
          now,
        });
      }
      case 'mesh_read_room': {
        return this.readTeamTopicRoom({
          teamId: effectiveTeamId,
          roomId: args.roomId,
          topic: args.topic,
          viewerId: isAdmin ? null : effectiveUser,
          limit: args.limit || 50,
        });
      }
      case 'mesh_post_message': {
        return this.postTeamTopicRoomMessage({
          teamId: effectiveTeamId,
          roomId: args.roomId,
          topic: args.topic || 'general',
          senderId: effectiveUser,
          senderSeat: effectiveSeat,
          targetSeat: args.targetSeat || null,
          content: args.content,
          artifactId: args.artifactId || null,
          skillId: args.skillId || null,
          registeredSeats,
          now,
        });
      }
      case 'mesh_share_skill': {
        return this.shareTeamSkill({
          teamId: effectiveTeamId,
          skillId: args.skillId,
          name: args.name,
          version: args.version || 1,
          title: args.title,
          description: args.description,
          skillMd: args.skillMd,
          config: args.config,
          sharedBy: effectiveUser,
          sharedBySeat: effectiveSeat,
          now,
        });
      }
      case 'mesh_share_artifact': {
        return this.shareTeamArtifact({
          teamId: effectiveTeamId,
          artifactId: args.artifactId,
          title: args.title,
          kind: args.kind,
          revision: args.revision || 1,
          markdownContent: args.markdownContent,
          data: args.data,
          sharedBy: effectiveUser,
          sharedBySeat: effectiveSeat,
          now,
        });
      }
      case 'mesh_import_shared_resource': {
        return this.getTeamSharedResource({
          teamId: effectiveTeamId,
          resourceType: args.resourceType || 'all',
          resourceId: args.resourceId || args.skillId || args.artifactId || null,
          viewerId: isAdmin ? null : effectiveUser,
        });
      }
      default:
        return {
          ok: false,
          status: 400,
          reason: 'unknown_mesh_mcp_tool',
          error: `Unknown @mcp:archon-mesh tool "${cleanTool}".`,
          availableTools: this.getArchonMeshMcpManifest().tools.map((t) => t.name),
        };
    }
  }
}

export { signManifest };


