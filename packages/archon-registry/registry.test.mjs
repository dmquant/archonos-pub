import test from "node:test";
import assert from "node:assert/strict";
import * as R from "./registry.mjs";

const seat = { id: "s1", hand: "claude-api", model: "m", budget: 5, enabled: true, created_by: "user" };
const srv = { id: "srv", transport: "http", endpoint: "https://mcp.example/x", auth_ref: "secret://srv-key", enabled: true, owner: "user" };
const base = () => ({ seats: [{ ...seat }], mcp_servers: [{ ...srv }], mcp_grants: [], schedules: [], skills: [] });
const allowT = { subject: "seat:s1", server: "srv", tool: "t", allow: true };

test("hand alias normalised and accepted", () => {
  assert.equal(R.normalizeHand("codex-api"), "codex");
  assert.ok(R.validateSeat(seat).ok);
  assert.ok(!R.validateSeat({ ...seat, hand: "grok" }).ok);
});
test("seat capability claim without hand-operator is rejected", () => {
  assert.ok(!R.validateSeat({ ...seat, capabilities: { fetch: true } }).ok);
  assert.ok(R.validateSeat({ ...seat, capabilities: { fetch: true }, capabilities_set_by: "hand-operator" }).ok);
});
test("canRoute refuses missing capability", () => {
  assert.deepEqual(R.canRoute({ capabilities: { fetch: false } }, ["fetch"]), { ok: false, missing: ["fetch"] });
});
test("schedule: cron xor fire_at, no-fly band", () => {
  const s = { id: "a", seat: "s1", task_template: "t", cron: "0 9 * * *" };
  assert.ok(R.validateSchedule(s).ok);
  assert.ok(!R.validateSchedule({ ...s, cron: "30 12 * * 0" }).ok);
  assert.ok(!R.validateSchedule({ ...s, fire_at: 1 }).ok);
  assert.ok(!R.validateSchedule({ ...s, cron: undefined }).ok);
  assert.ok(!R.validateSchedule({ ...s, cron: "0 * * * *" }, { strictNoFly: true }).ok);
});
test("fireKey is stable", () => assert.equal(R.fireKey("a", 5), R.fireKey("a", 5)));
test("mcp server: secret value rejected, handle accepted, no tools field", () => {
  assert.ok(R.validateMcpServer(srv).ok);
  assert.ok(!R.validateMcpServer({ ...srv, auth_ref: "not-a-handle-value" }).ok);
  assert.ok(!R.validateMcpServer({ ...srv, endpoint: "http://x" }).ok);
  assert.ok(!R.validateMcpServer({ ...srv, tools: ["a"] }).ok);
});
test("default deny: new server, no grant => refused", () => {
  assert.deepEqual(R.authorizeToolCall(base(), "seat:s1", "srv", "t"), { allow: false, reason: "no-grant" });
  assert.deepEqual(R.authorizeToolCall(base(), "archon", "srv", "t"), { allow: false, reason: "no-grant" });
});
test("grant allows only the exact subject/server/tool", () => {
  const r = base(); r.mcp_grants.push(allowT);
  assert.equal(R.authorizeToolCall(r, "seat:s1", "srv", "t").allow, true);
  assert.equal(R.authorizeToolCall(r, "seat:s1", "srv", "other").allow, false);
  assert.equal(R.authorizeToolCall(r, "archon", "srv", "t").allow, false);
});
test("explicit deny beats allow; disabled server/seat deny", () => {
  const r = base(); r.mcp_grants.push(allowT, { ...allowT, allow: false });
  assert.equal(R.authorizeToolCall(r, "seat:s1", "srv", "t").reason, "explicit-deny");
  const r2 = base(); r2.mcp_grants.push(allowT);
  r2.mcp_servers[0].enabled = false;
  assert.equal(R.authorizeToolCall(r2, "seat:s1", "srv", "t").reason, "server-disabled");
  r2.mcp_servers[0].enabled = true; r2.seats[0].enabled = false;
  assert.equal(R.authorizeToolCall(r2, "seat:s1", "srv", "t").reason, "seat-disabled");
});
test("unknown server/seat/subject deny", () => {
  assert.equal(R.authorizeToolCall(base(), "seat:s1", "nope", "t").reason, "unknown-server");
  assert.equal(R.authorizeToolCall(base(), "seat:zz", "srv", "t").reason, "unknown-seat");
  assert.equal(R.authorizeToolCall(base(), "peer", "srv", "t").reason, "unknown-subject");
});
test("grants are non-transferable", () => {
  assert.ok(!R.validateGrant({ ...allowT, subject: "archon", transferable: true }).ok);
});
test("authority writes only from interactive channel", () => {
  assert.equal(R.authorizeAuthorityWrite("interactive").allow, true);
  for (const o of ["message", "tool-result", "peer-post", undefined]) assert.equal(R.authorizeAuthorityWrite(o).allow, false);
});
test("harness-proposed skill cannot be active without replay pass and interactive approval", () => {
  const sk = { name: "k", version: 1, hash: "a".repeat(64), owner: "u", state: "active", proposed_by_harness: true };
  assert.ok(!R.validateSkill(sk).ok);
  assert.ok(!R.validateSkill({ ...sk, replay_check: "pass" }).ok);
  assert.ok(R.validateSkill({ ...sk, replay_check: "pass", approved_by: "u", approved_via_interactive: true }).ok);
  assert.ok(R.validateSkill({ ...sk, state: "proposed" }).ok);
});
test("registry cross-reference checks", () => {
  assert.ok(R.validateRegistry(base()).ok);
  const r = base(); r.mcp_grants.push({ subject: "seat:ghost", server: "nope", tool: "t", allow: true });
  assert.equal(R.validateRegistry(r).errors.length, 2);
  const d = base(); d.seats.push({ ...seat });
  assert.ok(!R.validateRegistry(d).ok);
});
