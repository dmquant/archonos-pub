// ArchonOS Workspace & Orchestrator Durable Object (Pillar 2, 3b, 3c, 3d: WorkspaceOrchestratorDO)
// Owns:
// 1. 5-Step Crash-Safe Orchestrator Loop (Intake -> Plan -> Governed Dispatch -> Harvest -> Verify & Publish)
//    with lock_token concurrency guards so Worker eviction/restart resumes cleanly from D1 state
//    without refilling budgets or double-dispatching.
// 2. Table-Driven Durable Object Alarm Clock (schedules & schedule_fires with fireKey idempotency).
// 3. 5-Stage Atomic Canvas Publication Pipeline (R2-first availability check, 409 Conflict rebase on
//    expectedBaseRevision mismatch, preservation of last good revision on failure, and Revision Gate
//    streaming via advanceCanvas from packages/archon-canvas/revision-gate.mjs).
// 4. Resumable chat run streaming with stable runId and sequence cursors.

import { createHash } from 'node:crypto';
import {
  validateSeat,
  validateSchedule,
  validateMcpServer,
  validateGrant,
  validateSkill,
  authorizeToolCall,
  canRoute,
  fireKey,
} from '../../archon-registry/registry.mjs';
import { advanceCanvas } from '../../archon-canvas/revision-gate.mjs';
import {
  decidePolicy,
  appendCharge,
  spentForSeat,
  verifyLedgerChain,
  isPrefixExtension,
  evaluateHandsUpRail,
} from './ledger.mjs';
import { evaluateSkillProposal } from './skill-gate.mjs';

export class WorkspaceOrchestratorDO {
  constructor(state, env = {}, backingStore = null) {
    this.state = state;
    this.env = env;
    // Allow injecting an external D1/R2 backing store so restarting a Worker/DO instance
    // resumes cleanly from the exact same persisted store (crash-safe recovery invariant).
    this.store = backingStore ?? WorkspaceOrchestratorDO.createEmptyStore();
  }

  static createEmptyStore() {
    return {
      workspaceId: 'ws-default',
      seats: new Map(),           // seatId -> seat record
      intents: new Map(),         // intentId -> intent record
      tasks: new Map(),           // taskId -> task record
      ledgerRows: [],             // append-only hash-chained charges
      schedules: new Map(),       // scheduleId -> schedule record
      scheduleFires: new Map(),   // fireKey -> fire record
      mcpServers: new Map(),      // serverId -> server record
      mcpGrants: [],              // grant records
      mcpAccessCounters: new Map(), // `${subject}:${server}:${tool}` -> { count, latencyMs }
      skills: new Map(),          // `${name}@${version}` -> skill record
      skillVerificationRecords: new Map(), // `${name}@${version}` -> verification record
      r2Blobs: new Map(),         // sha256 -> Buffer | string
      artifacts: new Map(),       // artifactId -> artifact pointer
      artifactRevisions: new Map(), // `${artifactId}@${revision}` -> revision record
      canvasClientViews: new Map(), // `${clientId}:${artifactId}` -> advanceCanvas view state
      runStreams: new Map(),      // runId -> { runId, state, events: [{ seq, type, data }] }
    };
  }

  // =========================================================================
  // 1. Authority-Gated Registry Operations (Seats, Schedules, MCPs, Skills)
  // =========================================================================

  upsertSeat(seatInput, { origin = 'interactive', author = 'operator' } = {}) {
    const rail = evaluateHandsUpRail({ origin, author, grantee: `seat:${seatInput.id}`, actionKind: 'seat_update' });
    if (!rail.allow) return { ok: false, status: 403, errors: [rail.reason] };

    const check = validateSeat(seatInput);
    if (!check.ok) return { ok: false, status: 400, errors: check.errors };

    this.store.seats.set(seatInput.id, {
      ...seatInput,
      engines: [seatInput.hand],
    });
    return { ok: true, status: 200, seat: this.store.seats.get(seatInput.id) };
  }

  deleteSeat(seatId, { origin = 'interactive', author = 'operator' } = {}) {
    const rail = evaluateHandsUpRail({ origin, author, grantee: `seat:${seatId}`, actionKind: 'seat_delete' });
    if (!rail.allow) return { ok: false, status: 403, errors: [rail.reason] };
    if (!this.store.seats.has(seatId)) return { ok: false, status: 404, errors: ['seat_not_found'] };
    this.store.seats.delete(seatId);
    return { ok: true, status: 200, deleted: seatId };
  }

  listSeats() {
    const out = [];
    for (const [id, seat] of this.store.seats.entries()) {
      const spent = spentForSeat(this.store.ledgerRows, id);
      const grants = this.store.mcpGrants.filter((g) => g.subject === `seat:${id}` && g.allow);
      out.push({
        ...seat,
        spent,
        remaining: Math.max(0, (seat.budget ?? 0) - spent),
        grants: grants.map((g) => `${g.server}:${g.tool}`),
      });
    }
    return out;
  }

  upsertMcpServer(serverInput, { origin = 'interactive', author = 'operator' } = {}) {
    const rail = evaluateHandsUpRail({ origin, author, actionKind: 'mcp_server_upsert' });
    if (!rail.allow) return { ok: false, status: 403, errors: [rail.reason] };

    const { tools, ...cleanInput } = serverInput || {};
    const catalogTools = Array.isArray(tools)
      ? tools
      : Array.isArray(serverInput?.catalogTools)
        ? serverInput.catalogTools
        : undefined;

    const check = validateMcpServer(cleanInput);
    if (!check.ok) return { ok: false, status: 400, errors: check.errors };

    const stored = {
      ...cleanInput,
      ...(catalogTools ? { catalogTools } : {}),
    };
    this.store.mcpServers.set(cleanInput.id, stored);
    return { ok: true, status: 200, server: stored };
  }

  deleteMcpServer(serverId, { origin = 'interactive', author = 'operator' } = {}) {
    const rail = evaluateHandsUpRail({ origin, author, actionKind: 'mcp_server_delete' });
    if (!rail.allow) return { ok: false, status: 403, errors: [rail.reason] };
    if (!this.store.mcpServers.has(serverId)) return { ok: false, status: 404, errors: ['mcp_server_not_found'] };
    this.store.mcpServers.delete(serverId);
    this.store.mcpGrants = this.store.mcpGrants.filter((g) => g.server !== serverId);
    return { ok: true, status: 200, deleted: serverId };
  }

  addMcpGrant(grantInput, { origin = 'interactive', author = 'operator' } = {}) {
    const rail = evaluateHandsUpRail({
      origin,
      author,
      grantee: grantInput.subject,
      actionKind: 'grant_create',
    });
    if (!rail.allow) return { ok: false, status: 403, errors: [rail.reason] };

    const check = validateGrant(grantInput);
    if (!check.ok) return { ok: false, status: 400, errors: check.errors };

    // Replace existing grant for the same (subject, server, tool) so toggling allow true/false is idempotent
    this.store.mcpGrants = this.store.mcpGrants.filter(
      (g) => !(g.subject === grantInput.subject && g.server === grantInput.server && g.tool === grantInput.tool)
    );
    this.store.mcpGrants.push({ ...grantInput, author });
    return { ok: true, status: 201, grant: grantInput };
  }

  invokeMcpTool({ subject, server, tool, latencyMs = 12 }) {
    const registrySnapshot = this._getRegistrySnapshot();
    const decision = authorizeToolCall(registrySnapshot, subject, server, tool);
    if (!decision.allow) {
      return { ok: false, status: 403, reason: decision.reason };
    }
    const key = `${subject}:${server}:${tool}`;
    const prev = this.store.mcpAccessCounters.get(key) ?? { count: 0, latencyMs: 0 };
    prev.count += 1;
    prev.latencyMs += latencyMs;
    this.store.mcpAccessCounters.set(key, prev);
    return { ok: true, status: 200, counter: prev };
  }

  verifyAndProposeSkill(skillInput, proposal, policy) {
    const eligibility = evaluateSkillProposal(proposal, policy);
    const key = `${skillInput.name}@${skillInput.version}`;
    this.store.skillVerificationRecords.set(key, eligibility);

    const record = {
      ...skillInput,
      state: 'proposed',
      proposed_by_harness: true,
      replay_check: eligibility.verdict,
      approved_by: null,
      approved_via_interactive: false,
    };
    const check = validateSkill(record);
    if (!check.ok) return { ok: false, status: 400, errors: check.errors, eligibility };

    this.store.skills.set(key, record);
    return { ok: true, status: 201, skill: record, eligibility };
  }

  activateSkill(name, version, { origin = 'interactive', author = 'operator' } = {}) {
    const rail = evaluateHandsUpRail({ origin, author, actionKind: 'skill_activate' });
    if (!rail.allow) return { ok: false, status: 403, errors: [rail.reason] };

    const key = `${name}@${version}`;
    const existing = this.store.skills.get(key);
    if (!existing) return { ok: false, status: 404, errors: ['skill_not_found'] };

    const verification = this.store.skillVerificationRecords.get(key);
    if (existing.proposed_by_harness && (!verification || verification.verdict !== 'pass')) {
      return {
        ok: false,
        status: 409,
        errors: [`skill verification verdict is ${verification?.verdict ?? 'missing'}, cannot activate`],
      };
    }

    const candidate = {
      ...existing,
      state: 'active',
      approved_by: author,
      approved_via_interactive: origin === 'interactive',
    };
    const check = validateSkill(candidate);
    if (!check.ok) return { ok: false, status: 400, errors: check.errors };

    this.store.skills.set(key, candidate);
    return { ok: true, status: 200, skill: candidate };
  }

  deleteSkill(name, version, { origin = 'interactive', author = 'operator' } = {}) {
    const rail = evaluateHandsUpRail({ origin, author, actionKind: 'skill_delete' });
    if (!rail.allow) return { ok: false, status: 403, errors: [rail.reason] };
    const key = `${name}@${Number(version ?? 1)}`;
    if (!this.store.skills.has(key)) return { ok: false, status: 404, errors: ['skill_not_found'] };
    this.store.skills.delete(key);
    this.store.skillVerificationRecords.delete(key);
    return { ok: true, status: 200, deleted: key };
  }

  // =========================================================================
  // 2. Five-Step Crash-Safe Orchestrator Loop (Section 5.1)
  // =========================================================================

  // Step 1: Intake (creates intent + resumable run stream)
  intakeIntent({
    intentId,
    runId,
    author = 'user',
    origin = 'interactive',
    prompt,
    pinnedArtifactId = null,
    pinnedRevision = null,
    lockToken = `lock-${Date.now()}`,
    now = Date.now(),
  }) {
    if (this.store.intents.has(intentId)) {
      const existing = this.store.intents.get(intentId);
      return { ok: true, resumed: true, intent: existing };
    }
    const intent = {
      intentId,
      workspaceId: this.store.workspaceId,
      runId: runId ?? `run-${intentId}`,
      author,
      origin,
      prompt,
      pinnedArtifactId,
      pinnedRevision,
      state: 'intake',
      lockToken,
      createdAt: now,
      updatedAt: now,
    };
    this.store.intents.set(intentId, intent);
    this._appendRunEvent(intent.runId, 'queued', { intentId, prompt, pinnedArtifactId, pinnedRevision });
    return { ok: true, resumed: false, intent };
  }

  // Step 2: Plan (decomposes intent into tasks bound to seat_id, capability check, and budget_cap)
  planIntent(intentId, taskSpecs, { lockToken, now = Date.now() } = {}) {
    const intent = this.store.intents.get(intentId);
    if (!intent) return { ok: false, status: 404, error: 'intent_not_found' };
    if (lockToken && intent.lockToken && intent.lockToken !== lockToken) {
      return { ok: false, status: 409, error: 'lock_token_mismatch' };
    }

    const createdTasks = [];
    for (const spec of taskSpecs) {
      if (this.store.tasks.has(spec.taskId)) {
        createdTasks.push(this.store.tasks.get(spec.taskId));
        continue;
      }
      const seat = this.store.seats.get(spec.seatId);
      if (!seat) return { ok: false, status: 400, error: `unknown_seat:${spec.seatId}` };

      const routeCheck = canRoute(seat, spec.requiredCapabilities ?? []);
      if (!routeCheck.ok) {
        return {
          ok: false,
          status: 400,
          error: `missing_capabilities:${routeCheck.missing.join(',')}`,
        };
      }

      const policyMap = this._buildPolicyMap();
      const policyDecision = decidePolicy(
        policyMap,
        this.store.ledgerRows,
        spec.seatId,
        seat.hand,
        spec.budgetCap
      );
      if (policyDecision.decision !== 'allow') {
        const refusedTask = {
          taskId: spec.taskId,
          intentId,
          seatId: spec.seatId,
          templateKey: spec.templateKey ?? 'default',
          kind: spec.kind ?? 'work',
          priority: spec.priority ?? 5,
          budgetCap: spec.budgetCap,
          prompt: spec.prompt ?? intent.prompt,
          state: 'refused',
          noResultReason: policyDecision.reason,
          createdAt: now,
          updatedAt: now,
        };
        this.store.tasks.set(spec.taskId, refusedTask);
        return { ok: false, status: 402, error: policyDecision.reason, task: refusedTask };
      }

      const task = {
        taskId: spec.taskId,
        intentId,
        seatId: spec.seatId,
        templateKey: spec.templateKey ?? 'default',
        kind: spec.kind ?? 'work',
        priority: spec.priority ?? 5,
        budgetCap: spec.budgetCap,
        prompt: spec.prompt ?? intent.prompt,
        lockToken: lockToken ?? intent.lockToken,
        state: 'queued',
        noResultReason: null,
        createdAt: now,
        updatedAt: now,
      };
      this.store.tasks.set(spec.taskId, task);
      createdTasks.push(task);
    }

    intent.state = 'planned';
    intent.lockToken = lockToken ?? intent.lockToken;
    intent.updatedAt = now;
    this._appendRunEvent(intent.runId, 'running', { step: 'planned', taskIds: createdTasks.map((t) => t.taskId) });
    return { ok: true, status: 200, intent, tasks: createdTasks };
  }

  // Step 3: Governed Dispatch (allocates headroom by priority 0..10 into HandLeaseDO)
  dispatchTasks(handLeaseDO, { maxDispatch = 10, now = Date.now() } = {}) {
    const queued = [...this.store.tasks.values()]
      .filter((t) => t.state === 'queued')
      .sort((a, b) => b.priority - a.priority);

    const dispatched = [];
    for (const t of queued.slice(0, maxDispatch)) {
      const seat = this.store.seats.get(t.seatId);
      const enq = handLeaseDO.enqueueTask({
        taskId: t.taskId,
        prompt: t.prompt,
        engine: seat?.hand ?? 'claude',
        seatId: t.seatId,
        now,
      });
      if (!enq.ok) {
        t.state = 'refused';
        t.noResultReason = enq.error;
        t.updatedAt = now;
        continue;
      }
      t.state = 'leased';
      t.updatedAt = now;
      const intent = this.store.intents.get(t.intentId);
      if (intent) {
        intent.state = 'dispatching';
        intent.updatedAt = now;
      }
      dispatched.push(t);
    }
    return { ok: true, dispatched };
  }

  // Step 4: Harvest (records usage report, appends hash-chained charge row, never double-charges on restart)
  harvestTask(taskId, { state, usage, reason = null, output = null, now = Date.now() }) {
    const task = this.store.tasks.get(taskId);
    if (!task) return { ok: false, status: 404, error: 'task_not_found' };

    // Idempotency guard on crash recovery: if already charged in ledger, do not double-charge or duplicate stream events
    const alreadyCharged = this.store.ledgerRows.some((r) => r.body.task === taskId);
    const seat = this.store.seats.get(task.seatId);

    if (alreadyCharged) {
      const chargeRow = this.store.ledgerRows.find((r) => r.body.task === taskId);
      return {
        ok: true,
        idempotentReplay: true,
        task,
        charge: chargeRow,
        seatTotalSpent: spentForSeat(this.store.ledgerRows, task.seatId),
      };
    }

    const beforeRows = [...this.store.ledgerRows];
    const nextRows = appendCharge(
      this.store.ledgerRows,
      task.seatId,
      task.taskId,
      seat?.hand ?? 'claude',
      task.budgetCap,
      usage
    );
    if (!isPrefixExtension(beforeRows, nextRows) || !verifyLedgerChain(nextRows).ok) {
      throw new Error('Ledger hash-chain integrity check failed');
    }
    this.store.ledgerRows = nextRows;

    task.state = state;
    task.noResultReason = reason;
    task.output = output;
    task.updatedAt = now;

    const intent = this.store.intents.get(task.intentId);
    if (intent) {
      // Explicit UI states: never render an empty no_result as completed (Section 4.1)
      if (state === 'done') {
        intent.state = 'completed';
        this._appendRunEvent(intent.runId, 'completed', { taskId, output });
      } else if (state === 'no_result') {
        intent.state = 'partial';
        this._appendRunEvent(intent.runId, 'partial', { taskId, reason: reason ?? 'no_result' });
      } else {
        intent.state = 'failed';
        this._appendRunEvent(intent.runId, 'failed', { taskId, reason });
      }
      intent.updatedAt = now;
    }

    const chargeRow = this.store.ledgerRows.find((r) => r.body.task === taskId);
    return {
      ok: true,
      task,
      charge: chargeRow,
      seatTotalSpent: spentForSeat(this.store.ledgerRows, task.seatId),
    };
  }

  // =========================================================================
  // 3. Five-Stage Atomic Canvas Publication Pipeline (Section 4.2)
  // =========================================================================

  putR2Blob(content) {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    this.store.r2Blobs.set(sha256, bytes);
    return sha256;
  }

  // Step 5: Verify & Publish Canvas Artifact
  // Invariants:
  // - Blobs must exist in R2 FIRST before D1 pointer advances.
  // - Accessible HTML parity fallback is mandatory (hasHtmlParity === true).
  // - expectedBaseRevision mismatch returns 409 Conflict (triggers rebase, never rolls back).
  // - Failed refresh preserves last good revision with a visible warning banner.
  publishCanvasArtifact({
    artifactId,
    title = 'Living Artifact',
    kind = 'dashboard',
    expectedBaseRevision = 0,
    idempotencyKey,
    manifestSha256,
    publishedBySeat = 'seat-vibe',
    sourceHashes = [],
    hasHtmlParity = true,
    streamId = 'stream-main',
    metadata = {},
    now = Date.now(),
  }) {
    const existing = this.store.artifacts.get(artifactId) ?? {
      artifactId,
      workspaceId: this.store.workspaceId,
      title,
      kind,
      currentRevision: 0,
      currentManifestSha256: null,
      streamId,
      currentSequence: 0,
      lastWarningBanner: null,
      publishedBySeat,
      metadata: { ...metadata },
      updatedAt: now,
    };

    // 1. Verify R2 blob availability first (no cross-R2/D1 transaction assumed)
    if (!manifestSha256 || !this.store.r2Blobs.has(manifestSha256)) {
      existing.lastWarningBanner = `Refresh failed at ${new Date(now).toISOString()}: R2 manifest blob ${manifestSha256 ?? 'null'} unavailable. Serving last good revision r${existing.currentRevision}.`;
      this.store.artifacts.set(artifactId, existing);
      return {
        ok: false,
        status: 424,
        error: 'r2_blob_missing',
        artifact: existing,
      };
    }

    // 2. Verify accessible HTML fallback parity
    if (hasHtmlParity !== true) {
      existing.lastWarningBanner = `Refresh rejected: missing accessible HTML table/transcript fallback parity. Serving last good revision r${existing.currentRevision}.`;
      this.store.artifacts.set(artifactId, existing);
      return {
        ok: false,
        status: 422,
        error: 'html_parity_required',
        artifact: existing,
      };
    }

    // 3. Check expectedBaseRevision (409 Conflict on base mismatch triggers rebase)
    if (expectedBaseRevision !== existing.currentRevision) {
      return {
        ok: false,
        status: 409,
        error: 'base_revision_conflict',
        rebaseRequired: true,
        currentRevision: existing.currentRevision,
        currentManifestSha256: existing.currentManifestSha256,
      };
    }

    // 4. Advance pointer atomically
    const nextRevision = existing.currentRevision + 1;
    const nextSequence = existing.currentSequence + 1;
    const eventType = existing.currentRevision === 0 ? 'snapshot' : 'published';

    const envelope = {
      schemaVersion: 1,
      type: eventType,
      workspaceId: this.store.workspaceId,
      artifactId,
      streamId: existing.streamId,
      sequence: nextSequence,
      revision: nextRevision,
      manifestSha256,
    };

    // Verify through @vibe's advanceCanvas Revision Gate reducer
    const currentView = existing.currentRevision === 0
      ? null
      : {
          workspaceId: this.store.workspaceId,
          artifactId,
          streamId: existing.streamId,
          sequence: existing.currentSequence,
          revision: existing.currentRevision,
          manifestSha256: existing.currentManifestSha256,
          needsSnapshot: false,
        };

    const nextView = advanceCanvas(currentView, envelope, {
      workspaceId: this.store.workspaceId,
      artifactId,
    });

    existing.currentRevision = nextView.revision;
    existing.currentManifestSha256 = nextView.manifestSha256;
    existing.currentSequence = nextView.sequence;
    existing.publishedBySeat = publishedBySeat || existing.publishedBySeat || 'seat-vibe';
    if (metadata && Object.keys(metadata).length > 0) {
      existing.metadata = { ...(existing.metadata || {}), ...metadata };
    }
    existing.lastWarningBanner = null;
    existing.updatedAt = now;

    this.store.artifacts.set(artifactId, existing);
    const revisionRecord = {
      artifactId,
      revision: nextRevision,
      manifestSha256,
      baseRevision: expectedBaseRevision,
      idempotencyKey: idempotencyKey ?? `${artifactId}-r${nextRevision}`,
      publishedBySeat,
      sourceHashes,
      hasHtmlParity: true,
      publishedAt: now,
    };
    this.store.artifactRevisions.set(`${artifactId}@${nextRevision}`, revisionRecord);

    return {
      ok: true,
      status: 200,
      artifact: existing,
      revisionRecord,
      envelope,
      view: nextView,
    };
  }

  // =========================================================================
  // 4. Table-Driven Durable Object Alarm Clock (Schedules & Fires)
  // =========================================================================

  upsertSchedule(scheduleInput, { origin = 'interactive', author = 'operator', policy = {} } = {}) {
    const rail = evaluateHandsUpRail({ origin, author, actionKind: 'schedule_upsert' });
    if (!rail.allow) return { ok: false, status: 403, errors: [rail.reason] };

    const check = validateSchedule(scheduleInput, policy);
    if (!check.ok) return { ok: false, status: 400, errors: check.errors };
    if (!this.store.seats.has(scheduleInput.seat)) {
      return { ok: false, status: 400, errors: [`unknown seat ${scheduleInput.seat}`] };
    }

    this.store.schedules.set(scheduleInput.id, {
      ...scheduleInput,
      enabled: scheduleInput.enabled ?? true,
      createdAt: scheduleInput.createdAt ?? new Date().toISOString(),
    });
    return { ok: true, status: 200, schedule: this.store.schedules.get(scheduleInput.id) };
  }

  deleteSchedule(scheduleId, { origin = 'interactive', author = 'operator' } = {}) {
    const rail = evaluateHandsUpRail({ origin, author, actionKind: 'schedule_delete' });
    if (!rail.allow) return { ok: false, status: 403, errors: [rail.reason] };
    if (!this.store.schedules.has(scheduleId)) return { ok: false, status: 404, errors: ['schedule_not_found'] };
    this.store.schedules.delete(scheduleId);
    return { ok: true, status: 200, deleted: scheduleId };
  }

  toggleSchedule(scheduleId, enabled, { origin = 'interactive', author = 'operator' } = {}) {
    const rail = evaluateHandsUpRail({ origin, author, actionKind: 'schedule_upsert' });
    if (!rail.allow) return { ok: false, status: 403, errors: [rail.reason] };
    const existing = this.store.schedules.get(scheduleId);
    if (!existing) return { ok: false, status: 404, errors: ['schedule_not_found'] };
    existing.enabled = typeof enabled === 'boolean' ? enabled : !existing.enabled;
    this.store.schedules.set(scheduleId, existing);
    return { ok: true, status: 200, schedule: existing };
  }

  triggerAlarm(scheduleId, fireTime, { budgetCap = 100 } = {}) {
    const sched = this.store.schedules.get(scheduleId);
    if (!sched || !sched.enabled) {
      return { ok: false, status: 404, error: 'schedule_not_found_or_disabled' };
    }
    const key = fireKey(scheduleId, fireTime);
    // Idempotency key: retried DO alarm cannot double-dispatch or double-charge
    if (this.store.scheduleFires.has(key)) {
      return {
        ok: true,
        status: 200,
        idempotentReplay: true,
        fire: this.store.scheduleFires.get(key),
      };
    }

    const intentId = `intent-${key}`;
    const taskId = `task-${key}`;
    this.intakeIntent({
      intentId,
      runId: `run-${key}`,
      author: 'schedule-alarm',
      origin: 'schedule',
      prompt: sched.task_template,
      now: fireTime,
    });

    const planRes = this.planIntent(
      intentId,
      [
        {
          taskId,
          seatId: sched.seat,
          templateKey: sched.task_template,
          kind: 'work',
          budgetCap,
          prompt: sched.task_template,
        },
      ],
      { now: fireTime }
    );

    const fireRecord = {
      fireKey: key,
      scheduleId,
      fireTime,
      intentId,
      taskId,
      state: planRes.ok ? 'queued' : 'failed',
    };
    this.store.scheduleFires.set(key, fireRecord);
    return {
      ok: planRes.ok,
      status: planRes.status,
      idempotentReplay: false,
      fire: fireRecord,
    };
  }

  // =========================================================================
  // 5. Resumable Run Stream (Mobile Cellular Handoff Recovery)
  // =========================================================================

  resumeRunStream(runId, sinceSeq = 0) {
    const stream = this.store.runStreams.get(runId);
    if (!stream) return { ok: false, status: 404, error: 'run_not_found' };
    return {
      ok: true,
      runId,
      state: stream.state,
      events: stream.events.filter((e) => e.seq > sinceSeq),
    };
  }

  _appendRunEvent(runId, state, data) {
    const stream = this.store.runStreams.get(runId) ?? { runId, state, events: [] };
    stream.state = state;
    const seq = stream.events.length + 1;
    stream.events.push({ seq, state, data });
    this.store.runStreams.set(runId, stream);
  }

  _buildPolicyMap() {
    const map = {};
    for (const [id, seat] of this.store.seats.entries()) {
      map[id] = {
        engines: [seat.hand],
        budget: seat.budget,
      };
    }
    return map;
  }

  _getRegistrySnapshot() {
    return {
      seats: [...this.store.seats.values()],
      mcp_servers: [...this.store.mcpServers.values()],
      mcp_grants: this.store.mcpGrants,
      schedules: [...this.store.schedules.values()],
      skills: [...this.store.skills.values()],
    };
  }
}
