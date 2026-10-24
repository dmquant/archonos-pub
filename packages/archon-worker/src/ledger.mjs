// ArchonOS Worker Policy & Hash-Chained Charge Ledger (Pillar 3c & 3d)
// Bridges @trade's pure-function policy & append-only SHA-256 charge ledger (ARC-141 / 092b73e9)
// into the Cloudflare Worker & WorkspaceOrchestratorDO runtime.
// Invariants:
// 1. Default deny: a seat with no grant for an engine or unknown/stale input is refused or held.
// 2. Spend is ALWAYS derived by replaying the ledger, never a stored counter, so a restart cannot refill a budget.
// 3. Absent stays absent: usage an engine did not report (null or unmetered) is charged at task.budget_cap ('unmetered_cap').
// 4. Amounts are integer micro-units (or integer tokens/units); no floats.
// 5. Hands-Up approval rail refuses non-interactive origins and refuses author == grantee self-grants.

import { createHash } from 'node:crypto';
import { authorizeAuthorityWrite } from '../../archon-registry/registry.mjs';

export const GENESIS_HASH = '0'.repeat(64);
export const DENY = 'deny';
export const HOLD = 'hold';
export const ALLOW = 'allow';

export function canonicalJson(obj) {
  if (obj === undefined) throw new Error('canonicalJson: undefined is not allowed');
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

export function computeRowHash(prevHash, body) {
  return createHash('sha256').update(prevHash + canonicalJson(body)).digest('hex');
}

export function isNonNegInt(x) {
  return typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
}

export function isPosInt(x) {
  return typeof x === 'number' && Number.isSafeInteger(x) && x > 0;
}

export function spentForSeat(rows, seatId) {
  let total = 0;
  for (const r of rows) {
    if (r.body && r.body.seat === seatId) {
      total += r.body.charged;
    }
  }
  return total;
}

export function decidePolicy(policy, rows, seatId, engine, taskCap) {
  const p = policy ? policy[seatId] : undefined;
  if (!p) return { decision: DENY, reason: 'seat_unknown' };
  if (p.stale === true) return { decision: HOLD, reason: 'policy_stale' };
  if (!Array.isArray(p.engines) || !p.engines.includes(engine)) {
    return { decision: DENY, reason: 'engine_not_granted' };
  }
  if (!isPosInt(taskCap)) {
    return { decision: DENY, reason: 'cap_invalid' };
  }
  if (!isNonNegInt(p.budget)) {
    return { decision: HOLD, reason: 'budget_missing' };
  }
  if (spentForSeat(rows, seatId) + taskCap > p.budget) {
    return { decision: DENY, reason: 'budget_exceeded' };
  }
  return { decision: ALLOW, reason: 'ok' };
}

export function chargeAmount(usage, taskCap) {
  if (!isPosInt(taskCap)) {
    throw new Error('taskCap must be a positive safe integer');
  }
  if (!usage || typeof usage !== 'object') {
    return { charged: taskCap, basis: 'unmetered_cap', metered: 0, quantity: null };
  }
  // Support both direct { tokens: int } (@trade fixture) and normalized @local-fabric usage dict
  if ('tokens' in usage) {
    const t = usage.tokens;
    if (isNonNegInt(t)) {
      if (t <= taskCap) return { charged: t, basis: 'metered', metered: 1, quantity: t };
      return { charged: taskCap, basis: 'metered_clamped_to_cap', metered: 1, quantity: t };
    }
    return { charged: taskCap, basis: 'unmetered_cap', metered: 0, quantity: null };
  }
  // @local-fabric normalized usage dict: { input_uncached: {value}|{state:'unmetered'}, output: ... }
  const inUnc = usage.input_uncached?.value;
  const outTok = usage.output?.value;
  const cacheRead = usage.cache_read?.value ?? 0;
  const cacheWrite = usage.cache_write?.value ?? 0;
  if (isNonNegInt(inUnc) && isNonNegInt(outTok) && isNonNegInt(cacheRead) && isNonNegInt(cacheWrite)) {
    const total = inUnc + outTok + cacheRead + cacheWrite;
    if (total <= taskCap) {
      return { charged: total, basis: 'metered', metered: 1, quantity: total };
    }
    return { charged: taskCap, basis: 'metered_clamped_to_cap', metered: 1, quantity: total };
  }
  return { charged: taskCap, basis: 'unmetered_cap', metered: 0, quantity: null };
}

export function appendCharge(rows, seatId, taskId, engine, taskCap, usage) {
  const { charged, basis } = chargeAmount(usage, taskCap);
  const body = {
    cap: taskCap,
    charged,
    basis,
    engine,
    seat: seatId,
    task: taskId,
  };
  const prev = rows.length > 0 ? rows[rows.length - 1].hash : GENESIS_HASH;
  const hash = computeRowHash(prev, body);
  return [...rows, { prev, body, hash }];
}

export function verifyLedgerChain(rows) {
  let prev = GENESIS_HASH;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.prev !== prev || r.hash !== computeRowHash(prev, r.body)) {
      return { ok: false, failedIndex: i };
    }
    prev = r.hash;
  }
  return { ok: true, failedIndex: null };
}

export function isPrefixExtension(oldRows, newRows) {
  if (!Array.isArray(oldRows) || !Array.isArray(newRows)) return false;
  if (newRows.length < oldRows.length) return false;
  for (let i = 0; i < oldRows.length; i++) {
    if (oldRows[i].hash !== newRows[i].hash || oldRows[i].prev !== newRows[i].prev) {
      return false;
    }
  }
  return true;
}

// Hands-Up Approval Rail (@trade 903e0848):
// 1. Only interactive origin can clear an authority write.
// 2. author === grantee is strictly forbidden (cannot widen own authority).
export function evaluateHandsUpRail({ origin, author, grantee, actionKind }) {
  const originCheck = authorizeAuthorityWrite(origin);
  if (!originCheck.allow) {
    return { allow: false, status: 'refused', reason: originCheck.reason };
  }
  if (!author || typeof author !== 'string') {
    return { allow: false, status: 'refused', reason: 'missing-author' };
  }
  if (grantee && author === grantee) {
    return { allow: false, status: 'refused', reason: 'self-grant-forbidden' };
  }
  return { allow: true, status: 'approved', reason: `interactive-human-ack:${actionKind ?? 'authority_write'}` };
}
