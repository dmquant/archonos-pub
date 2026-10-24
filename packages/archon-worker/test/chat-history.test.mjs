import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createArchonEdgeRuntime } from '../src/index.mjs';
import { CHAT_SNAPSHOT_KEY } from '../src/chat-history.mjs';

function bucket() {
  const rows = new Map(); let version = 0;
  return {
    async head(key) { return rows.get(key) || null; },
    async get(key) { const row = rows.get(key); return row ? { ...row, json: async () => JSON.parse(row.body) } : null; },
    async put(key, body, options) {
      const old = rows.get(key), c = options.onlyIf;
      if ((c.etagMatches && old?.etag !== c.etagMatches) || (c.etagDoesNotMatch === '*' && old)) return null;
      const row = { body, etag: String(++version), customMetadata: options.customMetadata };
      rows.set(key, row); return row;
    },
  };
}
const snapshot = { sourceUpdatedAt: '2026-10-23T12:00:00Z', activeSessionId: 'main', chatSessions: [
  { id: 'main', title: 'Main', handSessionBindings: { secret: 'local-only' }, messages: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'World' }] },
  { id: 'other', title: 'Other', messages: [{ role: 'user', content: 'Another conversation' }] },
] };
const req = (path, method = 'GET', body, auth = true) => new Request('https://archon.test' + path, {
  method, headers: { ...(auth ? { authorization: 'Bearer test-token' } : {}), 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test('history is authenticated and stored outside static assets; survives runtime restart', async () => {
  const BLOBS = bucket(), env = { ARCHON_ADMIN_TOKEN: 'test-token', BLOBS };
  let runtime = createArchonEdgeRuntime(env);
  assert.equal((await runtime.fetch(req('/api/chat/sync', 'PUT', snapshot, false))).status, 401);
  assert.equal(await BLOBS.get(CHAT_SNAPSHOT_KEY), null);
  const saved = await (await runtime.fetch(req('/api/chat/sync', 'PUT', snapshot))).json();
  assert.equal(saved.messages, 3);
  runtime = createArchonEdgeRuntime(env);
  const sessions = await (await runtime.fetch(req('/api/chat/sessions'))).json();
  assert.equal(sessions.sessions[0].messageCount, 2);
  assert.equal(sessions.sessions[0].userPromptCount, 1);
  assert.equal(sessions.sessions[0].handSessionBindings, undefined);
  const history = await (await runtime.fetch(req('/api/chat/history?sessionId=main'))).json();
  assert.deepEqual(history.messages, snapshot.chatSessions[0].messages);
  assert.equal((await runtime.fetch(req('/api/chat/history', 'GET', undefined, false))).status, 401);
});

test('stale or invalid snapshots cannot erase history; unknown sessions return 404', async () => {
  const runtime = createArchonEdgeRuntime({ ARCHON_ADMIN_TOKEN: 'test-token', BLOBS: bucket() });
  await runtime.fetch(req('/api/chat/sync', 'PUT', snapshot));
  assert.equal((await runtime.fetch(req('/api/chat/sync', 'PUT', { ...snapshot, sourceUpdatedAt: '2026-10-22T00:00:00Z' }))).status, 409);
  assert.equal((await runtime.fetch(req('/api/chat/sync', 'PUT', { ...snapshot, chatSessions: [] }))).status, 400);
  assert.equal((await runtime.fetch(req('/api/chat/history?sessionId=missing'))).status, 404);
  assert.equal((await runtime.fetch(req('/api/chat/history', 'DELETE'))).status, 501);
});

test('remote session selection persists in a secure cookie without changing local history', async () => {
  const runtime = createArchonEdgeRuntime({ ARCHON_ADMIN_TOKEN: 'test-token', BLOBS: bucket() });
  await runtime.fetch(req('/api/chat/sync', 'PUT', snapshot));
  const switched = await runtime.fetch(req('/api/chat/sessions', 'POST', { action: 'switch', sessionId: 'other' }));
  const cookie = switched.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly; Secure; SameSite=Strict/);
  const request = req('/api/chat/sessions'); request.headers.set('cookie', cookie.split(';')[0]);
  const sessions = await (await runtime.fetch(request)).json();
  assert.equal(sessions.activeSessionId, 'other');
});

test('local bridge chat-history sync watcher tracks connection state, sync failures, local/remote parity, and separate local-hand execution readiness', async () => {
  const { runChatHistoryEdgeSync, CHAT_HISTORY_SYNC_STATE } = await import('../src/dev-server.mjs');
  const BLOBS = bucket();
  const runtime = createArchonEdgeRuntime({ ARCHON_ADMIN_TOKEN: 'test-token', BLOBS });
  const prevToken = process.env.ARCHON_ADMIN_TOKEN;
  process.env.ARCHON_ADMIN_TOKEN = 'test-token';
  CHAT_HISTORY_SYNC_STATE.remoteUrl = 'https://archon.test';
  try {
    // 1. Successful sync establishes local/remote message parity and reports local-hand readiness separately
    const okStatus = await runChatHistoryEdgeSync(
      { updatedAt: '2026-10-23T14:00:00Z', activeSessionId: 'main', chatSessions: snapshot.chatSessions },
      { force: true, fetchImpl: (url, init) => runtime.fetch(new Request(url, init)) }
    );
    assert.equal(okStatus.connectionState, 'connected');
    assert.equal(okStatus.syncedSessions, 2);
    assert.equal(okStatus.syncedMessages, 3);
    assert.equal(okStatus.parityPass, true);
    assert.equal(okStatus.lastError, null);
    assert.equal(typeof okStatus.localHandExecution?.ready, 'boolean');
    assert.equal(okStatus.localHandExecution?.mode, 'local-cli-custodian');

    // Remote Worker reports history sync separately from custodian-only hand execution
    const remoteSessions = await (await runtime.fetch(req('/api/chat/sessions'))).json();
    assert.equal(remoteSessions.sync.connectionState, 'connected');
    assert.equal(remoteSessions.sync.localHandExecution.ready, false);
    assert.equal(remoteSessions.sync.localHandExecution.mode, 'remote-bridge-custodian-only');

    // 2. Simulated network/auth failure records lastError and increments failureCount while keeping last syncedAt
    const prevSyncedAt = okStatus.syncedAt;
    const failStatus = await runChatHistoryEdgeSync(
      { updatedAt: '2026-10-23T14:05:00Z', activeSessionId: 'main', chatSessions: snapshot.chatSessions },
      { force: true, fetchImpl: async () => new Response(JSON.stringify({ ok: false, error: 'gateway_timeout' }), { status: 504 }) }
    );
    assert.equal(failStatus.connectionState, 'error');
    assert.match(failStatus.lastError, /504/);
    assert.equal(failStatus.syncedAt, prevSyncedAt);
    assert.ok(failStatus.failureCount >= 1);
  } finally {
    if (prevToken === undefined) delete process.env.ARCHON_ADMIN_TOKEN;
    else process.env.ARCHON_ADMIN_TOKEN = prevToken;
  }
});

test('remote dispatch persists, claims exclusively, fences result writers and deduplicates submissions', async () => {
  const BLOBS = bucket(), env = { ARCHON_ADMIN_TOKEN: 'test-token', BLOBS };
  let runtime = createArchonEdgeRuntime(env);
  await runtime.fetch(req('/api/chat/sync', 'PUT', snapshot));
  assert.equal((await runtime.fetch(req('/api/chat', 'POST', { prompt: 'hi', sessionId: 'main' }, false))).status, 401);
  assert.equal((await runtime.fetch(req('/api/chat', 'POST', { prompt: 'hi', sessionId: 'missing' }))).status, 404);
  const submit = () => { const r = req('/api/chat', 'POST', { prompt: 'hi', sessionId: 'main' }); r.headers.set('idempotency-key', 'turn-one'); return r; };
  const queued = await (await runtime.fetch(submit())).json();
  assert.equal(queued.queued, true);
  assert.equal((await (await runtime.fetch(submit())).json()).taskId, queued.taskId);
  runtime = createArchonEdgeRuntime(env);
  const claims = await Promise.all([runtime.fetch(req('/api/chat/bridge/claim', 'POST', {})), runtime.fetch(req('/api/chat/bridge/claim', 'POST', {}))]);
  const tasks = (await Promise.all(claims.map(r => r.json()))).filter(r => r.task);
  assert.equal(tasks.length, 1);
  const task = tasks[0].task;
  assert.equal(task.payload.prompt, 'hi');
  assert.equal((await runtime.fetch(req('/api/chat/bridge/result', 'POST', { taskId: task.id, claim: 'wrong', result: { ok: true } }))).status, 409);
  const cookieClaim = req('/api/chat/bridge/claim', 'POST', {}, false);
  cookieClaim.headers.set('cookie', 'archon_token=test-token');
  assert.equal((await runtime.fetch(cookieClaim)).status, 401);
  const result = { ok: true, reply: 'local reply' };
  assert.equal((await runtime.fetch(req('/api/chat/bridge/result', 'POST', { taskId: task.id, claim: task.claim, result }))).status, 200);
  const status = await (await runtime.fetch(req('/api/chat/bridge/status?taskId=' + task.id))).json();
  assert.equal(status.state, 'done');
  assert.deepEqual(status.result, result);
});
