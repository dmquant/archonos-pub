// ArchonOS registry prototype (ARC-138 s4-s7 / ARC-141): seats, schedules,
// mcp_servers, mcp_grants, skills. Pure functions, no I/O. Not deployed.

const HAND_ALIASES = {
  "claude-api": "claude",
  "codex-api": "codex",
  "gemini-api": "gemini",
  "opencode": "codex",
  "agy": "claude",
};
const HANDS = new Set(["claude", "codex", "gemini"]);
const TRANSPORTS = new Set(["http", "sse", "stdio-bridge"]);
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
// auth_ref must be a secret-store handle ("secret://name"), never a value.
const HANDLE = /^secret:\/\/[a-z0-9][a-z0-9._\/-]{0,80}$/;
const CRON5 = /^(\S+\s+){4}\S+$/;
const HASH = /^[0-9a-f]{64}$/;
// Only the user's interactive channel may change authority.
const AUTHORITY_ORIGINS = new Set(["interactive"]);
const NO_FLY = { start: 11 * 60, end: 15 * 60 }; // SGT minutes, default policy

export const normalizeHand = (h) => HANDS.has(h) ? h : (HAND_ALIASES[h] ?? h);

const res = (errors) => ({ ok: errors.length === 0, errors });

export function validateSeat(s) {
  const e = [];
  if (!s || typeof s !== "object") return res(["seat: not an object"]);
  if (!SLUG.test(s.id ?? "")) e.push("seat.id: invalid slug");
  if (!HANDS.has(normalizeHand(s.hand))) e.push("seat.hand: unknown hand");
  if (typeof s.model !== "string" || !s.model) e.push("seat.model: required");
  if (!(Number.isFinite(s.budget) && s.budget >= 0)) e.push("seat.budget: must be a finite number >= 0");
  if (typeof s.enabled !== "boolean") e.push("seat.enabled: boolean required");
  if (typeof s.created_by !== "string" || !s.created_by) e.push("seat.created_by: required");
  // capability map is set by the hand operator, not claimed by the seat
  if (s.capabilities !== undefined) {
    if (!s.capabilities || typeof s.capabilities !== "object" || Array.isArray(s.capabilities)
      || Object.values(s.capabilities).some((v) => typeof v !== "boolean")) e.push("seat.capabilities: map of boolean");
    else if (s.capabilities_set_by !== "hand-operator") e.push("seat.capabilities_set_by: must be hand-operator");
  }
  return res(e);
}

export function validateSchedule(s, policy = {}) {
  const e = [];
  if (!s || typeof s !== "object") return res(["schedule: not an object"]);
  if (!SLUG.test(s.id ?? "")) e.push("schedule.id: invalid slug");
  if (!SLUG.test(s.seat ?? "")) e.push("schedule.seat: invalid slug");
  if (typeof s.task_template !== "string" || !s.task_template) e.push("schedule.task_template: required");
  const hasCron = s.cron != null, hasFire = s.fire_at != null;
  if (hasCron === hasFire) e.push("schedule: exactly one of cron or fire_at");
  if (hasCron && !CRON5.test(s.cron)) e.push("schedule.cron: need 5 fields");
  if (hasFire && !Number.isFinite(s.fire_at)) e.push("schedule.fire_at: epoch ms required");
  if (hasCron && CRON5.test(s.cron)) {
    const [min, hour] = s.cron.split(/\s+/);
    const band = policy.noFly ?? NO_FLY;
    if (/^\d+$/.test(min) && /^\d+$/.test(hour)) {
      const m = Number(hour) * 60 + Number(min);
      if (m >= band.start && m < band.end) e.push("schedule.cron: inside no-fly band");
    } else if (policy.strictNoFly) e.push("schedule.cron: non-literal time not provable outside no-fly band");
  }
  return res(e);
}

// Idempotency key: a retried alarm cannot double-dispatch.
export const fireKey = (scheduleId, fireTime) => `${scheduleId}@${fireTime}`;

export function validateMcpServer(s) {
  const e = [];
  if (!s || typeof s !== "object") return res(["mcp_server: not an object"]);
  if (!SLUG.test(s.id ?? "")) e.push("mcp_server.id: invalid slug");
  if (!TRANSPORTS.has(s.transport)) e.push("mcp_server.transport: unknown");
  try {
    if (new URL(s.endpoint).protocol !== "https:" && s.transport !== "stdio-bridge") e.push("mcp_server.endpoint: https required");
  } catch { e.push("mcp_server.endpoint: invalid url"); }
  if (s.auth_ref != null && !HANDLE.test(s.auth_ref)) e.push("mcp_server.auth_ref: must be a secret:// handle, not a value");
  if (typeof s.enabled !== "boolean") e.push("mcp_server.enabled: boolean required");
  if (typeof s.owner !== "string" || !s.owner) e.push("mcp_server.owner: required");
  if ("tools" in s) e.push("mcp_server.tools: servers expose no tools until granted");
  return res(e);
}

export function validateGrant(g) {
  const e = [];
  if (!g || typeof g !== "object") return res(["grant: not an object"]);
  if (!/^(archon|seat:[a-z0-9-]+)$/.test(g.subject ?? "")) e.push("grant.subject: archon or seat:<id>");
  if (!SLUG.test(g.server ?? "")) e.push("grant.server: invalid slug");
  if (typeof g.tool !== "string" || !g.tool) e.push("grant.tool: required");
  if (typeof g.allow !== "boolean") e.push("grant.allow: boolean required");
  if (g.transferable === true) e.push("grant.transferable: grants are non-transferable");
  return res(e);
}

export function validateSkill(s) {
  const e = [];
  if (!s || typeof s !== "object") return res(["skill: not an object"]);
  if (!SLUG.test(s.name ?? "")) e.push("skill.name: invalid slug");
  if (!Number.isInteger(s.version) || s.version < 1) e.push("skill.version: integer >= 1");
  if (!HASH.test(s.hash ?? "")) e.push("skill.hash: sha256 hex required");
  if (typeof s.owner !== "string" || !s.owner) e.push("skill.owner: required");
  if (!["proposed", "active", "disabled"].includes(s.state)) e.push("skill.state: proposed|active|disabled");
  // self-written skills never auto-activate: need replay pass plus approval
  if (s.state === "active" && s.proposed_by_harness) {
    if (s.replay_check !== "pass") e.push("skill: harness-proposed skill needs replay_check=pass to be active");
    if (!s.approved_by || !s.approved_via_interactive) e.push("skill: harness-proposed skill needs interactive approval");
  }
  return res(e);
}

export function validateRegistry(r) {
  const e = [];
  const seats = new Map(), servers = new Map();
  for (const s of r.seats ?? []) {
    e.push(...validateSeat(s).errors);
    if (seats.has(s.id)) e.push(`seat ${s.id}: duplicate`);
    seats.set(s.id, s);
  }
  for (const s of r.mcp_servers ?? []) {
    e.push(...validateMcpServer(s).errors);
    if (servers.has(s.id)) e.push(`mcp_server ${s.id}: duplicate`);
    servers.set(s.id, s);
  }
  for (const s of r.schedules ?? []) {
    e.push(...validateSchedule(s).errors);
    if (!seats.has(s.seat)) e.push(`schedule ${s.id}: unknown seat ${s.seat}`);
  }
  for (const g of r.mcp_grants ?? []) {
    e.push(...validateGrant(g).errors);
    if (!servers.has(g.server)) e.push(`grant: unknown server ${g.server}`);
    const m = /^seat:(.+)$/.exec(g.subject ?? "");
    if (m && !seats.has(m[1])) e.push(`grant: unknown seat ${m[1]}`);
  }
  for (const s of r.skills ?? []) e.push(...validateSkill(s).errors);
  return res(e);
}

// Default deny. Explicit deny beats allow. Disabled server or seat denies.
export function authorizeToolCall(r, subject, server, tool) {
  const srv = (r.mcp_servers ?? []).find((s) => s.id === server);
  if (!srv) return { allow: false, reason: "unknown-server" };
  if (!srv.enabled) return { allow: false, reason: "server-disabled" };
  const m = /^seat:(.+)$/.exec(subject ?? "");
  if (m) {
    const seat = (r.seats ?? []).find((s) => s.id === m[1]);
    if (!seat) return { allow: false, reason: "unknown-seat" };
    if (!seat.enabled) return { allow: false, reason: "seat-disabled" };
  } else if (subject !== "archon") return { allow: false, reason: "unknown-subject" };
  const rows = (r.mcp_grants ?? []).filter((g) => g.subject === subject && g.server === server && g.tool === tool);
  if (rows.some((g) => g.allow === false)) return { allow: false, reason: "explicit-deny" };
  if (rows.some((g) => g.allow === true)) return { allow: true, reason: "granted" };
  return { allow: false, reason: "no-grant" };
}

// Authority writes (grants, seats, schedules, skills) only from the interactive
// channel; messages, tool results and peer posts are refused.
export function authorizeAuthorityWrite(origin) {
  return AUTHORITY_ORIGINS.has(origin)
    ? { allow: true, reason: "interactive" }
    : { allow: false, reason: `refused-origin:${origin ?? "unknown"}` };
}

// Capability routing: refuse tasks needing a capability the seat lacks.
export function canRoute(seat, needs = []) {
  const caps = seat?.capabilities ?? {};
  const missing = needs.filter((c) => caps[c] !== true);
  return { ok: missing.length === 0, missing };
}
