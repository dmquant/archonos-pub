// ArchonOS Per-Hand Lease Durable Object (Pillar 1 & Pillar 2: HandLeaseDO)
// Separated from ArchonMailboxDO (@local-fabric, a7a2dfdd) so P2P mesh traffic
// can never starve local hand lease heartbeats.
// Enforces:
// - 4 MB prompt bound (413 on overflow, never silently truncated)
// - Pull hands out no more tasks than free slots (maxConcurrent - activeLeases)
// - Single lease-expiry mechanism with zombie single-requeue (queued -> leased -> done|failed|no_result,
//   expired once -> queued, expired twice -> failed 'lost_in_flight')
// - Per-(node, hand) circuit breaker where wall-clock timeout does NOT trip the breaker
// - Capability echo probe (capabilities_set_by: 'hand-operator')
// - Local Stdio-MCP JSON-RPC 2.0 tunnel frame routing gated by authorizeToolCall

import { createHash } from 'node:crypto';
import { authorizeToolCall } from '../../archon-registry/registry.mjs';

export const MAX_PROMPT_BYTES = 4 * 1024 * 1024; // 4 MB bound (682446b)
export const TERMINAL_STATES = new Set(['done', 'failed', 'no_result', 'unclaimed', 'skipped']);
export const RESULT_STATES = new Set(['done', 'failed', 'no_result']);

export class HandLeaseDO {
  constructor(state, env = {}) {
    this.state = state;
    this.env = env;
    this.leaseTtlMs = env.LEASE_TTL_MS ?? 60_000;
    this.maxRequeue = env.MAX_REQUEUE ?? 1;
    this.circuitFailureThreshold = env.CIRCUIT_FAILURE_THRESHOLD ?? 3;
    this.leaseSeq = 0;

    // In-memory mirrored to DO storage on transitions
    this.tasks = new Map(); // taskId -> task record
    this.nodes = new Map(); // handId -> { maxConcurrent, lastHeartbeat, capabilities, circuit: { consecutiveFailures, openUntil } }
    this.mcpTunnelFrames = []; // queued JSON-RPC frames for local stdio-MCP bridge
    this.mcpResponses = new Map(); // jsonrpc id -> result/error
  }

  registerHand(handId, { maxConcurrent = 2, engine = 'claude', now = Date.now() } = {}) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error('maxConcurrent must be a positive integer');
    }
    const existing = this.nodes.get(handId) ?? {
      handId,
      engine,
      maxConcurrent,
      lastHeartbeat: now,
      capabilities: {},
      capabilitiesSetBy: null,
      circuit: { consecutiveFailures: 0, open: false },
    };
    existing.maxConcurrent = maxConcurrent;
    existing.engine = engine;
    existing.lastHeartbeat = now;
    this.nodes.set(handId, existing);
    return existing;
  }

  enqueueTask({
    taskId,
    prompt,
    engine = 'claude',
    seatId,
    startDeadline = Number.MAX_SAFE_INTEGER,
    catchUp = 'run_late',
    now = Date.now(),
  }) {
    const promptBytes = Buffer.byteLength(String(prompt ?? ''), 'utf8');
    if (promptBytes > MAX_PROMPT_BYTES) {
      return {
        ok: false,
        status: 413,
        error: `prompt exceeds 4MB bound (${promptBytes} > ${MAX_PROMPT_BYTES})`,
      };
    }
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return { ok: false, status: 400, error: 'prompt must be a non-empty string' };
    }
    if (this.tasks.has(taskId)) {
      return { ok: true, status: 200, inserted: false, task: this.tasks.get(taskId) };
    }
    const row = {
      taskId,
      prompt,
      engine,
      seatId,
      state: 'queued',
      startDeadline,
      catchUp,
      leaseId: null,
      leasedBy: null,
      leaseUntil: null,
      requeues: 0,
      reason: null,
      usage: null,
      output: null,
      lastHeartbeat: null,
      insertedAt: now,
    };
    this.tasks.set(taskId, row);
    return { ok: true, status: 201, inserted: true, task: row };
  }

  activeLeaseCount(handId) {
    let count = 0;
    for (const t of this.tasks.values()) {
      if ((t.state === 'leased' || t.state === 'running') && t.leasedBy === handId) {
        count++;
      }
    }
    return count;
  }

  pollTasks(handId, { maxConcurrent, now = Date.now() } = {}) {
    this.sweep(now);
    let node = this.nodes.get(handId);
    if (!node) {
      node = this.registerHand(handId, { maxConcurrent: maxConcurrent ?? 1, now });
    } else if (Number.isInteger(maxConcurrent) && maxConcurrent >= 1) {
      node.maxConcurrent = maxConcurrent;
      node.lastHeartbeat = now;
    }
    if (node.circuit.open) {
      return { ok: false, status: 503, error: 'circuit_breaker_open', leased: [], freeSlots: 0 };
    }

    const active = this.activeLeaseCount(handId);
    const freeSlots = Math.max(0, node.maxConcurrent - active);
    const leased = [];

    if (freeSlots === 0) {
      return { ok: true, status: 200, leased, freeSlots: 0, retryJitterMs: 1000 + (now % 450) };
    }

    for (const t of this.tasks.values()) {
      if (leased.length >= freeSlots) break;
      if (t.state === 'queued' && now <= t.startDeadline) {
        this.leaseSeq += 1;
        t.state = 'leased';
        t.leaseId = `L${this.leaseSeq}`;
        t.leasedBy = handId;
        t.leaseUntil = now + this.leaseTtlMs;
        t.lastHeartbeat = now;
        leased.push({ ...t });
      }
    }

    return {
      ok: true,
      status: 200,
      leased,
      freeSlots: node.maxConcurrent - (active + leased.length),
      retryJitterMs: 1000 + (now % 450),
    };
  }

  heartbeat(taskId, leaseId, now = Date.now()) {
    const t = this._holder(taskId, leaseId, now);
    t.leaseUntil = now + this.leaseTtlMs;
    t.lastHeartbeat = now;
    if (t.leasedBy && this.nodes.has(t.leasedBy)) {
      this.nodes.get(t.leasedBy).lastHeartbeat = now;
    }
    return { ok: true, leaseUntil: t.leaseUntil };
  }

  reportResult(taskId, leaseId, { state, usage = null, reason = null, output = null, timedOutByWallClock = false, now = Date.now() }) {
    if (!RESULT_STATES.has(state)) {
      throw new Error(`bad result state: ${state}`);
    }
    if ((state === 'failed' || state === 'no_result') && !reason) {
      throw new Error('reason required for failed or no_result state');
    }
    const t = this._holder(taskId, leaseId, now);
    const handId = t.leasedBy;

    // Oversized result diff-elision guard (40ba9a7)
    let safeOutput = output;
    if (typeof safeOutput === 'string' && Buffer.byteLength(safeOutput, 'utf8') > 512 * 1024) {
      safeOutput = safeOutput.slice(0, 256 * 1024) + '\n... [diff elided by HandLeaseDO bound] ...';
    }

    t.state = state;
    t.usage = usage;
    t.reason = reason;
    t.output = safeOutput;
    t.leaseId = null;
    t.leaseUntil = null;

    // Circuit breaker rule (f6eb917): wall-clock kill does NOT trip the circuit breaker
    if (handId && this.nodes.has(handId)) {
      const node = this.nodes.get(handId);
      if (state === 'done') {
        node.circuit.consecutiveFailures = 0;
        node.circuit.open = false;
      } else if (state === 'failed' && !timedOutByWallClock) {
        node.circuit.consecutiveFailures += 1;
        if (node.circuit.consecutiveFailures >= this.circuitFailureThreshold) {
          node.circuit.open = true;
        }
      }
    }

    return { ok: true, task: { ...t } };
  }

  sweep(now = Date.now()) {
    const changed = {};
    for (const t of this.tasks.values()) {
      if (t.state === 'queued' && now > t.startDeadline) {
        t.state = t.catchUp === 'skip' ? 'skipped' : 'unclaimed';
        t.reason = `start_deadline passed, last_heartbeat=${t.lastHeartbeat}`;
        changed[t.taskId] = t.state;
      } else if ((t.state === 'leased' || t.state === 'running') && now > t.leaseUntil) {
        if (t.requeues < this.maxRequeue) {
          t.state = 'queued';
          t.requeues += 1;
          t.leaseId = null;
          t.leaseUntil = null;
          t.reason = 'lease expired, requeued';
          t.startDeadline = Math.max(t.startDeadline, now + this.leaseTtlMs);
        } else {
          t.state = 'failed';
          t.leaseId = null;
          t.leaseUntil = null;
          t.reason = 'lease expired twice (lost_in_flight)';
        }
        changed[t.taskId] = t.state;
      }
    }
    return changed;
  }

  // Capability Echo Probe (@epistates 9188fc7d):
  // Verifies the hand binary echo receipt and sets capabilities_set_by = 'hand-operator'
  verifyCapabilityProbe(handId, { nonce, expectedNonce, capabilities, signature }) {
    if (!nonce || nonce !== expectedNonce) {
      return { ok: false, error: 'probe_nonce_mismatch' };
    }
    if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
      return { ok: false, error: 'capabilities_invalid' };
    }
    const expectedSig = createHash('sha256')
      .update(`${handId}:${nonce}:${JSON.stringify(capabilities)}`)
      .digest('hex');
    if (signature && signature !== expectedSig) {
      return { ok: false, error: 'probe_signature_invalid' };
    }
    const node = this.nodes.get(handId) ?? this.registerHand(handId);
    node.capabilities = { ...capabilities };
    node.capabilitiesSetBy = 'hand-operator';
    return {
      ok: true,
      handId,
      capabilities: node.capabilities,
      capabilities_set_by: 'hand-operator',
    };
  }

  // Local Stdio-MCP Tunnel over Outbound Connection (Section 2.3):
  // Dual Enforcement: Worker checks mcp_grants per seat before queueing frame for daemon.
  enqueueStdioMcpCall(registry, { subject, server, tool, params = {}, requestId }) {
    const auth = authorizeToolCall(registry, subject, server, tool);
    if (!auth.allow) {
      return {
        ok: false,
        status: 403,
        reason: auth.reason,
        error: `MCP tool call denied by default-deny grant gate: ${auth.reason}`,
      };
    }
    const frame = {
      jsonrpc: '2.0',
      id: requestId ?? `rpc-${Date.now()}-${this.mcpTunnelFrames.length + 1}`,
      method: 'tools/call',
      params: {
        server,
        name: tool,
        arguments: params,
        subject,
      },
    };
    this.mcpTunnelFrames.push(frame);
    return { ok: true, status: 200, frame };
  }

  drainStdioMcpFrames() {
    const frames = [...this.mcpTunnelFrames];
    this.mcpTunnelFrames.length = 0;
    return frames;
  }

  recordStdioMcpResponse(responseFrame) {
    if (!responseFrame || responseFrame.jsonrpc !== '2.0' || !responseFrame.id) {
      return { ok: false, error: 'invalid_jsonrpc_response' };
    }
    this.mcpResponses.set(responseFrame.id, responseFrame);
    return { ok: true };
  }

  _holder(taskId, leaseId, now) {
    const t = this.tasks.get(taskId);
    if (!t) throw new Error('unknown task_id');
    if ((t.state !== 'leased' && t.state !== 'running') || t.leaseId !== leaseId) {
      throw new Error('not the current lease');
    }
    if (now > t.leaseUntil) {
      throw new Error('lease expired');
    }
    return t;
  }
}
