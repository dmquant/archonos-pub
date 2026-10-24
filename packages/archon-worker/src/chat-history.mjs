// Local-authoritative chat mirror. Private R2 storage, never bundled into assets.
export const CHAT_SNAPSHOT_KEY = 'workspace/ws-default/chat-history.json';
const MAX_BYTES = 16 * 1024 * 1024;

export function buildChatSnapshot(state) {
  const sessions = Array.isArray(state.chatSessions) ? state.chatSessions : [];
  const chatSessions = sessions.map(s => ({
    id: s.id, title: s.title || 'Conversation', pinnedSeatId: s.pinnedSeatId || 'chief-of-staff',
    createdAt: s.createdAt, updatedAt: s.updatedAt,
    compactedSummary: s.compactedSummary || '',
    // Native hand resume bindings stay on the local custodian.
    messages: Array.isArray(s.messages) ? s.messages : [],
  }));
  return { version: 1, sourceUpdatedAt: state.updatedAt,
    activeSessionId: state.activeSessionId, chatSessions };
}

export async function handleChatHistory(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/chat/') && url.pathname !== '/api/chat') return null;
  const reply = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store', ...extra },
  });
  const supported = ['/api/chat', '/api/chat/sync', '/api/chat/sessions', '/api/chat/history'];
  if (!supported.includes(url.pathname)) return null;
  // Never serve a private history mirror without an enabled perimeter.
  if (!env.ARCHON_ADMIN_TOKEN || !env.BLOBS) return reply({ ok: false, error: 'chat_storage_unavailable' }, 503);

  if (request.method === 'PUT' && url.pathname === '/api/chat/sync') {
    if (Number(request.headers.get('content-length')) > MAX_BYTES) return reply({ ok: false, error: 'snapshot_too_large' }, 413);
    const reader = request.body?.getReader();
    if (!reader) return reply({ ok: false, error: 'invalid_snapshot' }, 400);
    const chunks = []; let bytes = 0;
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) { await reader.cancel(); return reply({ ok: false, error: 'snapshot_too_large' }, 413); }
      chunks.push(value);
    }
    let input;
    try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return reply({ ok: false, error: 'invalid_snapshot' }, 400); }
    if (!Array.isArray(input.chatSessions) || !input.chatSessions.length ||
        !Number.isFinite(Date.parse(input.sourceUpdatedAt)) ||
        input.chatSessions.some(s => !s || typeof s.id !== 'string' || !Array.isArray(s.messages)) ||
        new Set(input.chatSessions.map(s => s.id)).size !== input.chatSessions.length ||
        !input.chatSessions.some(s => s.id === input.activeSessionId)) {
      return reply({ ok: false, error: 'invalid_snapshot' }, 400);
    }
    const old = await env.BLOBS.head(CHAT_SNAPSHOT_KEY);
    if (old && Date.parse(old.customMetadata?.sourceUpdatedAt) > Date.parse(input.sourceUpdatedAt)) {
      return reply({ ok: false, error: 'stale_snapshot' }, 409);
    }
    const snapshot = { ...buildChatSnapshot({ ...input, updatedAt: input.sourceUpdatedAt }), syncedAt: new Date().toISOString() };
    const saved = await env.BLOBS.put(CHAT_SNAPSHOT_KEY, JSON.stringify(snapshot), {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { sourceUpdatedAt: snapshot.sourceUpdatedAt },
      onlyIf: old ? { etagMatches: old.etag } : { etagDoesNotMatch: '*' },
    });
    if (!saved) return reply({ ok: false, error: 'sync_conflict' }, 409);
    return reply({ ok: true, sessions: snapshot.chatSessions.length,
      messages: snapshot.chatSessions.reduce((n, s) => n + s.messages.length, 0), syncedAt: snapshot.syncedAt });
  }
  if (url.pathname === '/api/chat/sync') return reply({ ok: false, error: 'method_not_allowed' }, 405);
  const object = await env.BLOBS.get(CHAT_SNAPSHOT_KEY);
  const snapshot = object ? await object.json() : { chatSessions: [] };
  const cookie = (request.headers.get('cookie') || '').match(/(?:^|;\s*)archon_chat_session=([^;]+)/)?.[1];
  let selected; try { selected = cookie ? decodeURIComponent(cookie) : null; } catch {}
  const requested = url.searchParams.get('sessionId') || selected || snapshot.activeSessionId;
  let session = snapshot.chatSessions.find(s => s.id === requested) || snapshot.chatSessions[0];
  if (request.method === 'POST' && url.pathname === '/api/chat/sessions') {
    const body = await request.json().catch(() => ({}));
    if (body.action !== 'switch') return reply({ ok: false, error: 'local_chat_mirror_read_only' }, 501);
    session = snapshot.chatSessions.find(s => s.id === body.sessionId);
    if (!session) return reply({ ok: false, error: 'session_not_found' }, 404);
    return reply({ ok: true, activeSessionId: session.id }, 200, {
      'set-cookie': `archon_chat_session=${encodeURIComponent(session.id)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`,
    });
  }
  if (request.method !== 'GET') return reply({ ok: false, error: 'local_chat_mirror_read_only' }, 501);
  if (url.searchParams.has('sessionId') && !snapshot.chatSessions.some(s => s.id === requested)) {
    return reply({ ok: false, error: 'session_not_found' }, 404);
  }
  const bridgeObject = await env.BLOBS.get('workspace/ws-default/remote-chat-queue.json');
  const bridge = bridgeObject ? await bridgeObject.json() : {};
  const bridgeReady = Date.now() - (bridge.lastPollAt || 0) < 45000 || bridge.tasks?.some(t => t.state === 'running' && Date.now() - t.startedAt < 30 * 60 * 1000);
  const sync = {
    mode: 'local-history-mirror',
    connectionState: snapshot.syncedAt ? 'connected' : 'awaiting-first-sync',
    syncedAt: snapshot.syncedAt || null,
    sourceUpdatedAt: snapshot.sourceUpdatedAt || null,
    lastError: null,
    localHandExecution: {
      ready: Boolean(bridgeReady),
      mode: 'remote-bridge-custodian-only',
      message: bridgeReady ? 'Remote dispatch connected to local CLI custodian.' : 'Waiting for the MacBook bridge; submitted requests remain queued.',
    },
  };
  if (url.pathname === '/api/chat/sessions') return reply({ ok: true, activeSessionId: session?.id || null, sync,
    sessions: snapshot.chatSessions.map(({ messages, ...s }) => ({ ...s, messageCount: messages.length,
      userPromptCount: messages.filter(m => m.role === 'user').length })) });
  return reply({ ok: true, sessionId: session?.id || null, sessionTitle: session?.title || '',
    compactedSummary: session?.compactedSummary || '', handSessionBindings: {}, messages: session?.messages || [], sync });
}
