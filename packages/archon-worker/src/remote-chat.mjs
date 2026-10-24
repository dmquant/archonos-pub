// Durable, exclusive remote dispatch. Never automatically replay an ambiguous execution.
const KEY = 'workspace/ws-default/remote-chat-queue.json';
const terminal = t => ['done', 'failed'].includes(t.state);
const reply = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function handleRemoteChat(request, env) {
  const url = new URL(request.url), path = url.pathname;
  if (path !== '/api/chat' && !path.startsWith('/api/chat/bridge/')) return null;
  if (path === '/api/chat' && request.method !== 'POST') return null;
  if (!env.BLOBS || !env.ARCHON_ADMIN_TOKEN) return reply({ ok: false, error: 'bridge_unavailable' }, 503);
  const agent = path === '/api/chat/bridge/claim' || path === '/api/chat/bridge/result';
  if (agent && request.headers.get('authorization') !== `Bearer ${env.ARCHON_ADMIN_TOKEN}`) return reply({ ok: false, error: 'bridge_token_required' }, 401);
  let body = {};
  if (request.method === 'POST') {
    const reader = request.body?.getReader();
    const chunks = []; let bytes = 0;
    if (reader) for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > 1024 * 1024) { await reader.cancel(); return reply({ ok: false, error: 'request_too_large' }, 413); }
      chunks.push(value);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    try { body = JSON.parse(raw); } catch { return reply({ ok: false, error: 'invalid_json' }, 400); }
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    const old = await env.BLOBS.get(KEY);
    const queue = old ? await old.json() : { tasks: [] };
    const now = Date.now();
    let response;
    if (path === '/api/chat' && request.method === 'POST') {
      if (typeof body.prompt !== 'string' || !body.prompt.trim()) return reply({ ok: false, error: 'empty_prompt' }, 400);
      const snapshot = await env.BLOBS.get('workspace/ws-default/chat-history.json');
      const history = snapshot ? await snapshot.json() : {};
      if (!history.chatSessions?.some(s => s.id === body.sessionId)) return reply({ ok: false, error: 'session_not_found' }, 404);
      // File paths on a remote device cannot be interpreted as local attachments.
      if (body.attachments?.length) return reply({ ok: false, error: 'remote_attachments_not_supported' }, 400);
      const key = request.headers.get('idempotency-key');
      const existing = key && queue.tasks.find(t => t.key === key);
      if (existing) return reply({ ok: true, queued: true, taskId: existing.id }, 202);
      if (queue.tasks.filter(t => !terminal(t)).length >= 50) return reply({ ok: false, error: 'bridge_queue_full' }, 429);
      const id = crypto.randomUUID();
      const { prompt, sessionId, seatId, lang, selectedSkills, selectedMcps, quotedArtifacts, pinnedArtifactId } = body;
      queue.tasks.push({ id, key, state: 'queued', createdAt: now, payload: { prompt, sessionId, seatId, lang, selectedSkills, selectedMcps, quotedArtifacts, pinnedArtifactId } });
      response = { ok: true, queued: true, taskId: id };
    } else if (path === '/api/chat/bridge/claim' && request.method === 'POST') {
      queue.lastPollAt = now;
      const task = queue.tasks.some(t => t.state === 'running') ? null : queue.tasks.find(t => t.state === 'queued');
      if (task) { task.state = 'running'; task.claim = crypto.randomUUID(); task.startedAt = now; }
      response = { ok: true, task: task || null };
    } else if (path === '/api/chat/bridge/result' && request.method === 'POST') {
      const task = queue.tasks.find(t => t.id === body.taskId);
      if (!task || task.claim !== body.claim) return reply({ ok: false, error: 'invalid_claim' }, 409);
      if (terminal(task)) return reply({ ok: true });
      if (!body.result || typeof body.result.ok !== 'boolean') return reply({ ok: false, error: 'invalid_result' }, 400);
      task.state = body.result.ok ? 'done' : 'failed'; task.result = body.result; task.finishedAt = now;
      response = { ok: true };
    } else if (path === '/api/chat/bridge/status' && request.method === 'GET') {
      const task = queue.tasks.find(t => t.id === url.searchParams.get('taskId'));
      if (!task) return reply({ ok: false, error: 'task_not_found' }, 404);
      return reply({ ok: true, state: task.state, result: task.result || null });
    } else return reply({ ok: false, error: 'method_not_allowed' }, 405);
    const done = queue.tasks.filter(terminal).slice(-50);
    queue.tasks = queue.tasks.filter(t => !terminal(t)).concat(done);
    const saved = await env.BLOBS.put(KEY, JSON.stringify(queue), { onlyIf: old ? { etagMatches: old.etag } : { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' } });
    if (saved) return reply(response, path === '/api/chat' ? 202 : 200);
  }
  return reply({ ok: false, error: 'bridge_busy_retry' }, 409);
}
