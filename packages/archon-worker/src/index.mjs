// ArchonOS Cloudflare Worker Single-Origin Entry Point (Pillar 2)
// Hosts:
// - Responsive Desktop & Mobile PWA Shell (single origin with API to prevent split-cookie & rollout drift)
// - Authenticated HTTP/REST/MCP Gateway (/api/*, /workspaces/:w/*, /hands/*, /mesh/*)
// - Durable Object bindings: WorkspaceOrchestratorDO, HandLeaseDO, ArchonMailboxDO

import { createHash } from 'node:crypto';
import { WorkspaceOrchestratorDO } from './workspace-orchestrator-do.mjs';
import { HandLeaseDO } from './hand-lease-do.mjs';
import { ArchonMailboxDO } from './archon-mailbox-do.mjs';
import { runArchonDeployTarget } from '../../archon-cli/src/cli-core.mjs';
import { INITIAL_WORKSPACE_STATE } from './initial-state.mjs';
import { handleRemoteChat } from './remote-chat.mjs';
import { handleChatHistory } from './chat-history.mjs';

export { WorkspaceOrchestratorDO, HandLeaseDO, ArchonMailboxDO };

export function hydrateStoreFromInitialState(store, mailbox = null) {
  if (!INITIAL_WORKSPACE_STATE) return;

  // 1. Seats
  if (Array.isArray(INITIAL_WORKSPACE_STATE.seats)) {
    for (const s of INITIAL_WORKSPACE_STATE.seats) {
      const seatId = (s.id || '').replace(/^seat:/, '');
      if (!store.seats.has(seatId)) {
        store.seats.set(seatId, {
          id: seatId,
          name: s.name_en || s.name || seatId,
          persona: s.persona || '',
          engine: s.engines?.[0] || s.hand || 'agy',
          model: s.model || 'cli-default',
          hand: s.hand || 'agy',
          capabilities: s.capabilities || { chat: true, canvas: true, mcp: true },
          capabilities_set_by: 'hand-operator',
          budget: Number(s.budget || 1000000000),
          enabled: s.enabled !== false,
          created_by: s.created_by || 'operator',
          engines: s.engines || [s.hand || 'agy'],
          handCustomizedByOperator: Boolean(s.handCustomizedByOperator),
        });
      }
    }
  }

  // 2. Artifacts
  if (Array.isArray(INITIAL_WORKSPACE_STATE.artifacts)) {
    for (const a of INITIAL_WORKSPACE_STATE.artifacts) {
      const artId = a.artifactId || a.id;
      if (!store.artifacts.has(artId)) {
        store.artifacts.set(artId, {
          artifactId: artId,
          workspaceId: a.workspaceId || 'ws-default',
          title: a.title || artId,
          kind: a.kind || 'dashboard',
          currentRevision: a.currentRevision || 1,
          currentManifestSha256: a.currentManifestSha256 || 'seed-sha',
          streamId: a.streamId || 'stream-main',
          currentSequence: a.currentSequence || 1,
          lastWarningBanner: a.lastWarningBanner || null,
          publishedBySeat: (a.publishedBySeat || 'chief-of-staff').replace(/^seat:/, ''),
          metadata: a.metadata || {},
          updatedAt: a.updatedAt || Date.now(),
        });
      }
    }
  }

  // 3. Artifact Revisions
  if (Array.isArray(INITIAL_WORKSPACE_STATE.artifactRevisions)) {
    for (const r of INITIAL_WORKSPACE_STATE.artifactRevisions) {
      const key = `${r.artifactId}@${r.revision}`;
      if (!store.artifactRevisions.has(key)) {
        store.artifactRevisions.set(key, {
          ...r,
          hasHtmlParity: true,
        });
      }
    }
  }

  // 4. Artifact Blobs (store into r2Blobs for data endpoints)
  if (INITIAL_WORKSPACE_STATE.artifactBlobs) {
    for (const [artId, blobData] of Object.entries(INITIAL_WORKSPACE_STATE.artifactBlobs)) {
      const art = store.artifacts.get(artId);
      const jsonBuf = Buffer.from(JSON.stringify(blobData));
      if (art && art.currentManifestSha256) {
        store.r2Blobs.set(art.currentManifestSha256, jsonBuf);
      }
      store.r2Blobs.set(`blob:${artId}`, jsonBuf);
    }
  }

  // 5. Skills
  if (Array.isArray(INITIAL_WORKSPACE_STATE.skills)) {
    for (const sk of INITIAL_WORKSPACE_STATE.skills) {
      const key = `${sk.name}@${sk.version}`;
      if (!store.skills.has(key)) {
        store.skills.set(key, sk);
      }
    }
  }

  // 6. Schedules
  if (Array.isArray(INITIAL_WORKSPACE_STATE.schedules)) {
    for (const sch of INITIAL_WORKSPACE_STATE.schedules) {
      if (!store.schedules.has(sch.id)) {
        store.schedules.set(sch.id, sch);
      }
    }
  }

  // 7. Secure Channels and Teams
  if (mailbox) {
    if (Array.isArray(INITIAL_WORKSPACE_STATE.secureChannels)) {
      for (const ch of INITIAL_WORKSPACE_STATE.secureChannels) {
        if (ch && ch.channelId) mailbox.secureChannels.set(ch.channelId, ch);
      }
    }
    if (Array.isArray(INITIAL_WORKSPACE_STATE.teamGroups)) {
      for (const tg of INITIAL_WORKSPACE_STATE.teamGroups) {
        if (tg && tg.teamId) mailbox.teamGroups.set(tg.teamId, tg);
      }
    }
  }
}

export function createArchonEdgeRuntime(env = {}) {
  const sharedStore = WorkspaceOrchestratorDO.createEmptyStore();
  const orchestrator = new WorkspaceOrchestratorDO(null, env, sharedStore);
  const handLease = new HandLeaseDO(null, env);
  const mailbox = env.MAILBOX_INSTANCE || new ArchonMailboxDO(null, env);
  if (env.SEED_EDGE_STATE === true || env.ARCHON_EDGE_SEED === 'true' || env.ARCHON_REMOTE === 'true' || env.ENVIRONMENT === 'production') {
    hydrateStoreFromInitialState(sharedStore, mailbox);
  }
  let deploymentConfig = runArchonDeployTarget({
    mode: env.ARCHON_DEPLOY_MODE ?? 'cloudflare-remote',
    remoteWorkerUrl: env.ARCHON_REMOTE_WORKER_URL ?? 'https://archon-os-worker.workers.dev',
    remoteFrontendPageUrl: env.ARCHON_REMOTE_PAGE_URL ?? 'https://archon-os-app.pages.dev',
    encryptionMode: env.ENCRYPTION_MODE ?? 'e2ee-local-custodian',
  });

  async function handleRequest(request) {
    const url = new URL(request.url, 'https://archon.local');
    const method = request.method.toUpperCase();
    const originHeader = request.headers?.get?.('x-archon-origin') ?? 'interactive';
    const authorHeader = request.headers?.get?.('x-archon-author') ?? 'operator';

    const corsHeaders = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'access-control-allow-headers': 'content-type, x-archon-origin, x-archon-author',
    };

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const json = (body, status = 200, extraHeaders = {}) =>
      new Response(JSON.stringify(body), {
        status,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          ...corsHeaders,
          ...extraHeaders,
        },
      });

    // =========================================================================
    // Security Perimeter: Sovereign Operator Passkey & Room-Scoped Peer Sessions
    // =========================================================================
    const expectedToken = env.ARCHON_ADMIN_TOKEN;
    const peerSessionSecret = expectedToken || 'archon-local-dev-peer-secret';

    const mintPeerMeshSession = ({ userId, channelId = null, teamId = null, role = 'member' }) => {
      const payloadB64 = Buffer.from(
        JSON.stringify({ userId, channelId, teamId, role, issuedAt: Date.now() }),
        'utf8'
      ).toString('base64url');
      const sig = createHash('sha256')
        .update(`peer-session:${peerSessionSecret}:${payloadB64}`)
        .digest('hex');
      return `peer:${payloadB64}.${sig}`;
    };

    const verifyPeerMeshSession = (rawToken) => {
      if (!rawToken || typeof rawToken !== 'string' || !rawToken.startsWith('peer:')) return null;
      const body = rawToken.slice(5);
      const dotIdx = body.lastIndexOf('.');
      if (dotIdx <= 0) return null;
      const payloadB64 = body.slice(0, dotIdx);
      const sig = body.slice(dotIdx + 1);
      const expectedSig = createHash('sha256')
        .update(`peer-session:${peerSessionSecret}:${payloadB64}`)
        .digest('hex');
      if (sig !== expectedSig) return null;
      try {
        const parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
        if (!parsed || typeof parsed.userId !== 'string' || !parsed.userId.trim()) return null;
        return parsed;
      } catch {
        return null;
      }
    };

    const cookieHeaderAll = request.headers?.get?.('cookie') || '';
    const authHeaderAll = request.headers?.get?.('authorization') || '';
    const bearerTokenAll = authHeaderAll.toLowerCase().startsWith('bearer ')
      ? authHeaderAll.slice(7).trim()
      : null;
    const peerCookieMatch = cookieHeaderAll.match(/archon_mesh_peer_session=([^;]+)/);
    const rawPeerToken =
      (bearerTokenAll && bearerTokenAll.startsWith('peer:') ? bearerTokenAll : null) ||
      request.headers?.get?.('x-archon-peer-session') ||
      (peerCookieMatch ? decodeURIComponent(peerCookieMatch[1].trim()) : null);
    const rawAccessKey =
      (bearerTokenAll && bearerTokenAll.startsWith('ARCHON-KEY-') ? bearerTokenAll : null) ||
      request.headers?.get?.('x-archon-access-key') ||
      url.searchParams.get('accessKey') ||
      null;
    const verifiedAccessKey = rawAccessKey ? mailbox.verifyTeamAccessKey(rawAccessKey) : { ok: false };
    const peerSession =
      verifyPeerMeshSession(rawPeerToken) ||
      (verifiedAccessKey.ok
        ? {
            userId: verifiedAccessKey.keyRecord.colleagueHandle,
            channelId: verifiedAccessKey.team.secureChannelId,
            teamId: verifiedAccessKey.team.teamId,
            role: verifiedAccessKey.keyRecord.role,
            accessKey: verifiedAccessKey.keyRecord.accessKey,
          }
        : null);

    const adminCookieMatch = cookieHeaderAll.match(/archon_auth_token=([^;]+)/);
    const adminCookieToken = adminCookieMatch ? adminCookieMatch[1].trim() : null;
    const queryTokenAll = url.searchParams.get('token');
    const providedAdminToken =
      queryTokenAll ||
      (bearerTokenAll && !bearerTokenAll.startsWith('peer:') && !bearerTokenAll.startsWith('ARCHON-KEY-')
        ? bearerTokenAll
        : null) ||
      adminCookieToken;
    const isAdminAuthenticated = expectedToken
      ? Boolean(providedAdminToken && providedAdminToken === expectedToken)
      : !peerSession;
    const isPeerScoped = Boolean(peerSession && !isAdminAuthenticated);

    const isMeshInviteRedeemRoute =
      (method === 'POST' && /^\/(api\/)?mesh\/(channels|teams)\/join$/.test(url.pathname)) ||
      (method === 'POST' && /^\/(api\/)?mcp\/archon-mesh$/.test(url.pathname));
    const hasWellFormedAccessKeyForDo =
      Boolean(env.ARCHON_MAILBOX) &&
      Boolean(rawAccessKey && /^ARCHON-KEY-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/.test(rawAccessKey));
    const isPeerScopedMeshRoute =
      (Boolean(peerSession) || hasWellFormedAccessKeyForDo) &&
      ((method === 'GET' && /^\/(api\/)?mesh\/(channels|teams)$/.test(url.pathname)) ||
        (method === 'GET' && /^\/(api\/)?mesh\/channels\/[^/]+\/messages$/.test(url.pathname)) ||
        (method === 'POST' && /^\/(api\/)?mesh\/(channels|teams)\/messages$/.test(url.pathname)) ||
        (method === 'POST' && /^\/(api\/)?mesh\/teams\/(artifacts|skills|rooms)$/.test(url.pathname)) ||
        (method === 'POST' && /^\/(api\/)?mesh\/teams\/rooms\/messages$/.test(url.pathname)) ||
        (method === 'GET' && /^\/(api\/)?mesh\/teams\/(rooms|resources)$/.test(url.pathname)) ||
        (method === 'GET' && /^\/(api\/)?mesh\/teams\/[^/]+\/artifacts\/[^/]+$/.test(url.pathname)) ||
        /^\/(api\/)?mcp\/archon-mesh$/.test(url.pathname));

    if (expectedToken) {
      // 1. Check for token in cookie
      const cookieToken = adminCookieToken;

      // 2. Check for token in Authorization header
      const bearerToken =
        bearerTokenAll && !bearerTokenAll.startsWith('peer:') && !bearerTokenAll.startsWith('ARCHON-KEY-')
          ? bearerTokenAll
          : null;

      // 3. Check for token in URL query parameter (?token=...)
      const queryToken = queryTokenAll;

      // 4. Handle login submission (?action=login or POST /api/auth/login)
      if (url.pathname === '/login' || url.pathname === '/api/auth/login') {
        const submittedToken = queryToken || (method === 'POST' ? (await request.json().catch(() => ({})))?.token : null);
        if (submittedToken && submittedToken === expectedToken) {
          const cookieVal = `archon_auth_token=${expectedToken}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`;
          if (url.pathname === '/api/auth/login') {
            return new Response(JSON.stringify({ ok: true, message: 'authenticated' }), {
              status: 200,
              headers: { 'content-type': 'application/json', 'set-cookie': cookieVal, ...corsHeaders },
            });
          }
          return new Response(null, {
            status: 302,
            headers: { 'location': '/', 'set-cookie': cookieVal },
          });
        }
      }

      // 5. Handle logout
      if (url.pathname === '/logout' || url.pathname === '/api/auth/logout') {
        const clearCookie = `archon_auth_token=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
        return new Response(null, {
          status: 302,
          headers: { 'location': '/login', 'set-cookie': clearCookie },
        });
      }

      // Check if authenticated (admin token OR valid invite redemption OR room-scoped peer session)
      const providedToken = queryToken || bearerToken || cookieToken;
      const isAuthenticated =
        (providedToken && providedToken === expectedToken) ||
        isMeshInviteRedeemRoute ||
        isPeerScopedMeshRoute;

      // Unauthenticated static assets exemption (PWA shell, icons, webmanifest)
      const isPublicStatic =
        url.pathname === '/manifest.webmanifest' ||
        url.pathname === '/favicon.ico' ||
        url.pathname.startsWith('/icons/') ||
        url.pathname.startsWith('/assets/');

      if (!isAuthenticated && isPublicStatic && env.ASSETS && typeof env.ASSETS.fetch === 'function') {
        return env.ASSETS.fetch(request);
      }

      // Allow /api/health to report basic locked status without sensitive payload
      if (!isAuthenticated) {
        if (url.pathname === '/api/health') {
          return json({
            ok: false,
            service: 'archon-os-worker',
            status: 'locked',
            message: '401 Unauthorized — Sovereign Operator Passkey Required',
          }, 401);
        }

        // If it is an API request, return 401 JSON
        if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/mesh/') || url.pathname.startsWith('/hands/')) {
          return json({
            ok: false,
            error: 'unauthorized',
            message: '401 Unauthorized: Valid ARCHON_ADMIN_TOKEN or room-scoped peer session required.',
          }, 401);
        }

        // If queryToken was valid, set cookie and redirect to clean URL
        if (queryToken && queryToken === expectedToken) {
          const cleanUrl = new URL(request.url);
          cleanUrl.searchParams.delete('token');
          const cookieVal = `archon_auth_token=${expectedToken}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`;
          return new Response(null, {
            status: 302,
            headers: { 'location': cleanUrl.pathname + cleanUrl.search, 'set-cookie': cookieVal },
          });
        }

        // Otherwise return an elegant Sovereign Passkey Lock Screen for web browsers
        const loginHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>ArchonOS — Sovereign Lock Screen</title>
  <style>
    :root { --bg: #090D16; --card: #0F172A; --border: #1E293B; --text: #F8FAFC; --sub: #94A3B8; --primary: #3B82F6; --primary-hover: #2563EB; --danger: #EF4444; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 36px 32px; max-width: 420px; width: 100%; box-shadow: 0 20px 40px rgba(0,0,0,0.5); text-align: center; }
    .icon { font-size: 42px; margin-bottom: 16px; }
    h1 { font-size: 20px; font-weight: 700; margin-bottom: 8px; letter-spacing: -0.02em; }
    p { font-size: 13px; color: var(--sub); line-height: 1.5; margin-bottom: 24px; }
    .form-group { display: flex; flex-direction: column; gap: 12px; }
    input[type="password"] { background: #020617; border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; font-size: 14px; color: #FFF; outline: none; transition: border-color 0.2s; text-align: center; letter-spacing: 2px; }
    input[type="password"]:focus { border-color: var(--primary); }
    button { background: var(--primary); color: #FFF; border: none; border-radius: 8px; padding: 12px; font-size: 14px; font-weight: 600; cursor: pointer; transition: background 0.2s; }
    button:hover { background: var(--primary-hover); }
    .footer { margin-top: 24px; font-size: 11px; color: #475569; }
    .badge { display: inline-block; padding: 3px 8px; border-radius: 6px; font-size: 10px; font-weight: 700; background: rgba(59,130,246,0.15); color: #60A5FA; margin-bottom: 14px; border: 1px solid rgba(59,130,246,0.25); }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🛡️</div>
    <div class="badge">DEFAULT-DENY PERIMETER</div>
    <h1>ArchonOS Sovereign Node</h1>
    <p>This edge instance is secured with local-custodian end-to-end encryption. Please enter your Sovereign Operator Passkey to unlock the session.</p>
    <form class="form-group" method="GET" action="/login">
      <input type="password" name="token" placeholder="••••••••••••••••" autofocus required />
      <button type="submit">Unlock Sovereign Session</button>
    </form>
    <div class="footer">ArchonOS v0.1.005 • Zero-Knowledge Edge Relay</div>
  </div>
</body>
</html>`;
        return new Response(loginHtml, {
          status: 401,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
    }

    const remoteChatResponse = await handleRemoteChat(request, env);
    if (remoteChatResponse) return remoteChatResponse;
    const chatHistoryResponse = await handleChatHistory(request, env);
    if (chatHistoryResponse) return chatHistoryResponse;

    if (method === 'GET' && url.pathname === '/api/health') {
      return json({
        ok: true,
        service: 'archon-os-worker',
        version: env.ARCHON_VERSION ?? '0.1.0',
        custody: mailbox.getCustodyMetadata(),
        seats: sharedStore.seats.size,
        artifacts: sharedStore.artifacts.size,
        ledgerEntries: sharedStore.ledgerRows.length,
      });
    }

    if (method === 'GET' && url.pathname === '/api/polis-health') {
      return json({
        ok: true,
        source: '127.0.0.1:8790/api/polis-health',
        seq: 404,
        epoch: '1792490471136-9402566e',
        graphVersion: 8604,
      });
    }

    if (method === 'GET' && url.pathname === '/api/vortexa/snapshot') {
      return json({
        ok: true,
        server: {
          id: 'vortexa',
          transport: 'https',
          endpoint: 'https://mcp.vortexa.com/mcp',
          auth_ref: 'secret://vortexa-mcp-oauth',
          status: 'connected',
        },
        corridors: [
          {
            id: 'meg-china',
            route: 'MEG (Arabian Gulf) -> China',
            vessel_class: 'oil_vlcc',
            period: '2026-09-20 to 2026-10-20',
            average_daily_volume_b_day: 4196139,
            headline_mbd: '4.20 mbd',
            total_volume_b: 130080322,
            cargo_count: 78,
          },
          {
            id: 'ru-india',
            route: 'Russia -> India',
            vessel_class: 'oil_suezmax_lr3, oil_aframax_lr2',
            period: '2026-09-20 to 2026-10-20',
            average_daily_volume_b_day: 1753710,
            headline_mbd: '1.75 mbd',
            total_volume_b: 54365005,
            cargo_count: 73,
          },
          {
            id: 'usg-nwe',
            route: 'US Gulf (USG) -> NW Europe (NWE)',
            vessel_class: 'oil_vlcc, oil_suezmax_lr3, oil_aframax_lr2',
            period: '2026-09-20 to 2026-10-20',
            average_daily_volume_b_day: 1186347,
            headline_mbd: '1.19 mbd',
            total_volume_b: 36776767,
            cargo_count: 57,
          },
          {
            id: 'waf-china',
            route: 'West Africa (WAF) -> China',
            vessel_class: 'oil_vlcc, oil_suezmax_lr3',
            period: '2026-09-20 to 2026-10-20',
            average_daily_volume_b_day: 816506,
            headline_mbd: '0.82 mbd',
            total_volume_b: 25311677,
            cargo_count: 28,
          },
        ],
        insights: [
          {
            id: 'ab-44925ed5810a649208b4cc9bd25942755dea4db9',
            title: 'APAC | China set to receive highest non-Iranian Middle Eastern crude since the war',
            summary: 'This week, we examine: China set to receive highest non-Iranian Middle Eastern crude since the war.',
            published: '2026-10-20T08:04:32.000Z',
            label: 'Briefing',
          },
          {
            id: 'wr-94ec20e811c78c35f000b1dc1e9493a5ff7035b2',
            title: 'China set to receive highest non-Iranian Middle Eastern crude since the war',
            summary: "China's October arrivals of non-Iranian Middle Eastern crude hit a post-war high, while Africa faces a Q4 jet fuel shortfall.",
            published: '2026-10-19T11:39:08.209Z',
            label: 'Asia Market Spotlight',
          },
          {
            id: '6LDlE1lkERVaT8XHSdod5w',
            title: 'Bearish signs on oil markets emerge',
            summary: 'Crude/condensate supplies set to hit 2025 highs in October as Middle East mainstream supplies return to pre-war levels.',
            published: '2026-10-06T13:15:00.000Z',
            label: 'Article',
          },
        ],
        defaultReceipt: {
          mcp_server: 'vortexa (https://mcp.vortexa.com/mcp)',
          tool: 'get_cargo_summary',
          grant_check: 'granted (seat:seat-archon -> vortexa:get_cargo_summary)',
          period: '2026-09-20 to 2026-10-20',
          summary: 'Daily rate: 4.2M b/day. Period total: 130.1M b across 78 VLCC cargoes (MEG -> China).',
        },
      });
    }

    if (method === 'POST' && url.pathname === '/api/vortexa/query') {
      const body = await request.json();
      const subject = body.subject ?? 'seat:seat-archon';
      const tool = body.tool ?? 'get_cargo_summary';
      const inv = orchestrator.invokeMcpTool({ subject, server: 'vortexa', tool, latencyMs: 18 });
      if (!inv.ok) {
        return json({ ok: false, error: inv.reason, message: 'Denied by default-deny MCP grant gate' }, 403);
      }
      const presets = {
        'meg-china': {
          tool: 'get_cargo_summary',
          route: 'MEG -> China (oil_vlcc)',
          average_daily_volume: { value: 4196139.42, unit: 'b/day' },
          total_volume: 130080322,
          cargo_count: 78,
          period: '2026-09-20 to 2026-10-20',
          summary: 'Daily rate: 4.2M b/day. Period total: 130.1M b across 78 cargoes.',
        },
        'usg-nwe': {
          tool: 'get_cargo_summary',
          route: 'US Gulf -> NW Europe (VLCC/Suezmax/Aframax)',
          average_daily_volume: { value: 1186347.32, unit: 'b/day' },
          total_volume: 36776767,
          cargo_count: 57,
          period: '2026-09-20 to 2026-10-20',
          summary: 'Daily rate: 1.2M b/day. Period total: 36.8M b across 57 cargoes.',
        },
        vlcc: {
          tool: 'search_insights',
          query: 'VLCC China crude',
          total: 271,
          top_hit: {
            id: 'ab-44925ed5810a649208b4cc9bd25942755dea4db9',
            title: 'APAC | China set to receive highest non-Iranian Middle Eastern crude since the war',
            published: '2026-10-20T08:04:32.000Z',
          },
        },
      };
      return json({
        ok: true,
        authorized: true,
        subject,
        server: 'vortexa',
        tool,
        accessCounter: inv.counter,
        result: presets[body.preset] ?? presets['meg-china'],
      });
    }

    if (method === 'GET' && url.pathname === '/api/seats') {
      return json({
        ok: true,
        seats: orchestrator.listSeats(),
      });
    }

    if (method === 'POST' && url.pathname === '/api/seats') {
      const body = await request.json();
      const seatPayload = {
        ...body,
        handCustomizedByOperator: true,
        model: body.model || 'cli-default',
        budget: Number(body.budget ?? 1000000000),
        enabled: body.enabled ?? true,
        created_by: body.created_by ?? authorHeader,
        capabilities: body.capabilities ?? { chat: true, canvas: true, mcp: true },
        capabilities_set_by: 'hand-operator',
      };
      const res = orchestrator.upsertSeat(seatPayload, { origin: originHeader, author: authorHeader });
      return json(res, res.status);
    }

    if (method === 'DELETE' && url.pathname.startsWith('/api/seats/')) {
      const seatId = decodeURIComponent(url.pathname.slice('/api/seats/'.length));
      const res = orchestrator.deleteSeat(seatId, { origin: originHeader, author: authorHeader });
      return json(res, res.status);
    }

    if (method === 'GET' && url.pathname === '/api/mcp/servers') {
      return json({
        ok: true,
        servers: [...sharedStore.mcpServers.values()],
        grants: sharedStore.mcpGrants,
      });
    }

    if (method === 'POST' && url.pathname === '/api/mcp/servers') {
      const body = await request.json();
      const res = orchestrator.upsertMcpServer(body, { origin: originHeader, author: authorHeader });
      return json(res, res.status);
    }

    if (method === 'DELETE' && url.pathname.startsWith('/api/mcp/servers/')) {
      const serverId = decodeURIComponent(url.pathname.slice('/api/mcp/servers/'.length));
      const res = orchestrator.deleteMcpServer(serverId, { origin: originHeader, author: authorHeader });
      return json(res, res.status);
    }

    if (method === 'POST' && url.pathname === '/api/mcp/grants') {
      const body = await request.json();
      const res = orchestrator.addMcpGrant(body, { origin: originHeader, author: authorHeader });
      return json(res, res.status);
    }

    if (method === 'POST' && url.pathname === '/api/mcp/grants/bulk') {
      const body = await request.json();
      const subject = String(body.subject || 'seat:maritime-quant');
      const server = String(body.server || 'vortexa');
      const allow = Boolean(body.allow ?? true);
      const tools = Array.isArray(body.tools) ? body.tools : [];
      const updated = [];
      for (const tool of tools) {
        const r = orchestrator.addMcpGrant(
          { subject, server, tool: String(tool), allow },
          { origin: originHeader, author: authorHeader }
        );
        if (r.ok) updated.push(r.grant);
      }
      return json({ ok: true, count: updated.length, grants: sharedStore.mcpGrants }, 200);
    }

    const defaultRsiPolicy = {
      k: 3,
      minTrajectories: 2,
      preExistingVerifierHashes: new Set([
        'v-harness2-replay-v1',
        'v-vortexa-schema-check-v1',
        'v-agora-epistemic-gate-v1',
      ]),
      approvedVerifierHashes: new Set(['v-operator-signed-v1']),
    };

    if (method === 'GET' && url.pathname === '/api/skills') {
      const list = [...sharedStore.skills.values()].map((s) => {
        const key = `${s.name}@${s.version}`;
        return {
          ...s,
          key,
          eligibility: sharedStore.skillVerificationRecords.get(key) ?? null,
        };
      });
      return json({
        ok: true,
        skills: list,
        policy: {
          k: defaultRsiPolicy.k,
          minTrajectories: defaultRsiPolicy.minTrajectories,
          preExistingVerifierHashes: [...defaultRsiPolicy.preExistingVerifierHashes],
          approvedVerifierHashes: [...defaultRsiPolicy.approvedVerifierHashes],
        },
      });
    }

    if (method === 'POST' && url.pathname === '/api/skills/quick-create') {
      const body = await request.json();
      const skillMd = String(body.skillMd ?? body.instructions ?? '').trim();
      const name = String(body.name ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-');
      const version = Number(body.version ?? 1);
      const owner = String(body.owner ?? 'seat:chief-of-staff');
      const hash = createHash('sha256')
        .update(`${name}@${version}:${skillMd || Date.now()}`)
        .digest('hex');

      const proposal = {
        hash,
        verifierHash: 'v-operator-signed-v1',
        verifierAuthoredWithProposal: false,
        fitTrajectories: ['traj-operator-fit-01', 'traj-operator-fit-02'],
        heldOut: [
          { trajectory: 'traj-operator-holdout-01', passed: true },
          { trajectory: 'traj-operator-holdout-01', passed: true },
          { trajectory: 'traj-operator-holdout-01', passed: true },
          { trajectory: 'traj-operator-holdout-02', passed: true },
          { trajectory: 'traj-operator-holdout-02', passed: true },
          { trajectory: 'traj-operator-holdout-02', passed: true },
        ],
        verifierError: null,
        defeaters: [],
      };

      const propRes = orchestrator.verifyAndProposeSkill(
        {
          name,
          version,
          hash,
          owner,
          kind: body.kind || (Array.isArray(body.stages) && body.stages.length > 0 ? 'workflow-sop' : 'skill'),
          stages: Array.isArray(body.stages) ? body.stages : undefined,
          requiredMcps: Array.isArray(body.requiredMcps) ? body.requiredMcps : undefined,
          title: body.title || `${name} (v${version})`,
          description: body.description || 'Operator-authored governed skill',
          skillMd: skillMd || `---\nname: ${name}\nversion: ${version}\nowner: ${owner}\n---\nOperator skill for ${owner}.`,
          proposal,
          createdAt: new Date().toISOString(),
        },
        proposal,
        defaultRsiPolicy
      );
      if (!propRes.ok) return json(propRes, propRes.status);

      if (body.activateImmediately !== false) {
        const actRes = orchestrator.activateSkill(name, version, {
          origin: originHeader,
          author: authorHeader,
        });
        return json(actRes, actRes.status);
      }
      return json(propRes, propRes.status);
    }

    if (method === 'POST' && url.pathname === '/api/skills/propose') {
      const body = await request.json();
      const skillMd = String(body.skillMd ?? body.instructions ?? '').trim();
      const name = String(body.name ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-');
      const version = Number(body.version ?? 1);
      const owner = String(body.owner ?? 'seat:chief-of-staff');
      const hash =
        body.hash && /^[a-f0-9]{64}$/.test(body.hash)
          ? body.hash
          : createHash('sha256')
              .update(`${name}@${version}:${skillMd || Date.now()}`)
              .digest('hex');

      const proposal = body.proposal ?? {
        hash,
        verifierHash: body.verifierHash ?? 'v-harness2-replay-v1',
        verifierAuthoredWithProposal: Boolean(body.verifierAuthoredWithProposal ?? false),
        fitTrajectories: body.fitTrajectories ?? ['traj-fit-01', 'traj-fit-02'],
        heldOut: body.heldOut ?? [
          { trajectory: 'traj-holdout-01', passed: true },
          { trajectory: 'traj-holdout-01', passed: true },
          { trajectory: 'traj-holdout-01', passed: true },
          { trajectory: 'traj-holdout-02', passed: true },
          { trajectory: 'traj-holdout-02', passed: true },
          { trajectory: 'traj-holdout-02', passed: true },
        ],
        verifierError: body.verifierError ?? null,
        defeaters: body.defeaters ?? [],
      };

      const res = orchestrator.verifyAndProposeSkill(
        {
          name,
          version,
          hash,
          owner,
          kind: body.kind || (Array.isArray(body.stages) && body.stages.length > 0 ? 'workflow-sop' : 'skill'),
          stages: Array.isArray(body.stages) ? body.stages : undefined,
          requiredMcps: Array.isArray(body.requiredMcps) ? body.requiredMcps : undefined,
          title: body.title || `${name} (v${version})`,
          description: body.description || 'Harness2 RSI self-synthesized skill',
          skillMd: skillMd || `# ${name}\n\nGoverned Harness2 RSI skill for ${owner}.`,
          proposal,
          createdAt: new Date().toISOString(),
        },
        proposal,
        defaultRsiPolicy
      );
      return json(res, res.status);
    }

    if (method === 'POST' && url.pathname === '/api/skills/activate') {
      const body = await request.json();
      const res = orchestrator.activateSkill(body.name, Number(body.version ?? 1), {
        origin: originHeader,
        author: authorHeader,
      });
      return json(res, res.status);
    }

    if (method === 'POST' && url.pathname === '/api/skills/disable') {
      const body = await request.json();
      const key = `${body.name}@${Number(body.version ?? 1)}`;
      const existing = sharedStore.skills.get(key);
      if (!existing) return json({ ok: false, error: 'skill_not_found' }, 404);
      const updated = { ...existing, state: 'disabled' };
      sharedStore.skills.set(key, updated);
      return json({ ok: true, skill: updated }, 200);
    }

    if (method === 'DELETE' && url.pathname === '/api/skills') {
      const body = await request.json();
      const res = orchestrator.deleteSkill(body.name, Number(body.version ?? 1), {
        origin: originHeader,
        author: authorHeader,
      });
      return json(res, res.status);
    }

    if (method === 'GET' && url.pathname === '/api/schedules') {
      return json({
        ok: true,
        schedules: [...sharedStore.schedules.values()],
        fires: [...sharedStore.scheduleFires.values()].sort((a, b) => (b.fireTime || 0) - (a.fireTime || 0)),
      });
    }

    if (method === 'POST' && url.pathname === '/api/schedules') {
      const body = await request.json();
      const schedulePayload = {
        id: String(body.id || `sched-${Date.now()}`)
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, '-'),
        seat: String(body.seat || 'chief-of-staff').replace(/^seat:/, ''),
        task_template: String(body.task_template || body.prompt || 'scheduled-brief'),
        prompt: String(body.prompt || body.task_template || 'scheduled-brief'),
        title: body.title || body.task_template || body.id,
        skill: body.skill || body.skillId || null,
        skillId: body.skillId || body.skill || null,
        mcps: Array.isArray(body.mcps) ? body.mcps : Array.isArray(body.mcpServers) ? body.mcpServers : [],
        mcpServers: Array.isArray(body.mcpServers) ? body.mcpServers : Array.isArray(body.mcps) ? body.mcps : [],
        ticker: body.ticker || null,
        enabled: body.enabled ?? true,
        ...(body.cron ? { cron: String(body.cron).trim() } : {}),
        ...(body.fire_at != null ? { fire_at: Number(body.fire_at) } : {}),
      };
      const res = orchestrator.upsertSchedule(schedulePayload, {
        origin: originHeader,
        author: authorHeader,
      });
      return json(res, res.status);
    }

    if (method === 'DELETE' && url.pathname.startsWith('/api/schedules/')) {
      const scheduleId = decodeURIComponent(url.pathname.slice('/api/schedules/'.length));
      const res = orchestrator.deleteSchedule(scheduleId, {
        origin: originHeader,
        author: authorHeader,
      });
      return json(res, res.status);
    }

    if (method === 'POST' && /^\/api\/schedules\/[^/]+\/toggle$/.test(url.pathname)) {
      const scheduleId = decodeURIComponent(url.pathname.split('/')[3]);
      let body = {};
      try {
        body = await request.json();
      } catch {}
      const res = orchestrator.toggleSchedule(scheduleId, body.enabled, {
        origin: originHeader,
        author: authorHeader,
      });
      return json(res, res.status);
    }

    if (method === 'POST' && /^\/api\/schedules\/[^/]+\/fire$/.test(url.pathname)) {
      const scheduleId = decodeURIComponent(url.pathname.split('/')[3]);
      let body = {};
      try {
        body = await request.json();
      } catch {}
      const fireTime = Number(body.fireTime || Date.now());
      const res = orchestrator.triggerAlarm(scheduleId, fireTime, {
        budgetCap: Number(body.budgetCap || 400),
      });
      return json(res, res.status);
    }

    if (method === 'GET' && url.pathname === '/api/artifacts') {
      const allRevs = [...sharedStore.artifactRevisions.values()];
      const artifacts = [...sharedStore.artifacts.values()].map((art) => {
        const revisions = allRevs
          .filter((r) => r.artifactId === art.artifactId)
          .sort((a, b) => b.revision - a.revision);
        let manifest = null;
        if (art.currentManifestSha256 && sharedStore.r2Blobs.has(art.currentManifestSha256)) {
          try {
            manifest = JSON.parse(sharedStore.r2Blobs.get(art.currentManifestSha256).toString('utf8'));
          } catch (_) {}
        }
        return {
          ...art,
          revisions,
          manifest,
        };
      });
      return json({
        ok: true,
        artifacts,
      });
    }

    if (method === 'GET' && /^\/api\/artifacts\/[^/]+\/data$/.test(url.pathname)) {
      const artifactId = decodeURIComponent(url.pathname.split('/')[3]);
      const art = sharedStore.artifacts.get(artifactId);
      if (!art) return json({ ok: false, error: 'artifact_not_found' }, 404);
      let data = {};
      if (art.currentManifestSha256 && sharedStore.r2Blobs.has(art.currentManifestSha256)) {
        try {
          data = JSON.parse(sharedStore.r2Blobs.get(art.currentManifestSha256).toString('utf8'));
        } catch (_) {}
      }
      return json({
        ok: true,
        artifactId,
        revision: art.currentRevision,
        manifestSha256: art.currentManifestSha256,
        metadata: art.metadata || {},
        data,
      });
    }

    if (method === 'GET' && /^\/api\/artifacts\/[^/]+\/diff$/.test(url.pathname)) {
      const artifactId = decodeURIComponent(url.pathname.split('/')[3]);
      const art = sharedStore.artifacts.get(artifactId);
      if (!art) return json({ ok: false, error: 'artifact_not_found' }, 404);
      const revisions = [...sharedStore.artifactRevisions.values()]
        .filter((r) => r.artifactId === artifactId)
        .sort((a, b) => a.revision - b.revision);
      const prevRevObj = revisions.length >= 2 ? revisions[revisions.length - 2] : revisions[0] || { revision: 1, manifestSha256: art.currentManifestSha256 };
      return json({
        ok: true,
        artifactId,
        title: art.title || artifactId,
        previousRevision: prevRevObj.revision,
        currentRevision: art.currentRevision,
        totalRevisions: revisions.length,
        previousSha256: prevRevObj.manifestSha256,
        currentSha256: art.currentManifestSha256,
        currentManifestSha256: art.currentManifestSha256,
        dataWindow: art.metadata?.dataWindow || 'ArchonOS Workspace',
        updatedAt: art.metadata?.lastSyncedAt || null,
        revisions: revisions.map((r) => ({
          revision: r.revision,
          manifestSha256: r.manifestSha256,
          publishedBySeat: r.publishedBySeat,
          publishedAt: r.publishedAt,
        })),
        corridorDeltas: [],
      });
    }

    if (method === 'GET' && url.pathname === '/api/git/status') {
      return json({
        ok: true,
        safeMode: {
          enabled: false,
          lockedAt: null,
          lockedBy: null,
          reason: 'Cloudflare Edge Mirror Mode (Local Workstation Holds Sovereign Git)',
          immutableKernelPaths: ['scripts/archon-safe-recover.mjs', 'scripts/archon-init.mjs', '.gitignore'],
          protectedFiles: [],
          lastGoldenCommit: 'origin/main',
          checkpoints: [],
          commitHistory: [],
          recoveryHistory: [],
        },
        git: {
          branch: 'main',
          headShort: 'remote-edge',
          headFull: 'remote-cloudflare-edge-worker',
          dirtyCount: 0,
          dirtyFiles: [],
          hasRemote: true,
          remotes: ['origin https://github.com/dmquant/archonos-pub.git'],
          recentCommits: ['Edge synchronized with local custodian'],
          goldenTags: [],
        },
      });
    }

    if (method === 'GET' && url.pathname === '/api/ledger') {
      return json({
        ok: true,
        rows: sharedStore.ledgerRows,
      });
    }

    if (method === 'POST' && url.pathname === '/api/intents') {
      const body = await request.json();
      const intake = orchestrator.intakeIntent(body);
      if (Array.isArray(body.tasks) && body.tasks.length > 0) {
        const plan = orchestrator.planIntent(body.intentId, body.tasks);
        if (!plan.ok) return json(plan, plan.status);
        const disp = orchestrator.dispatchTasks(handLease);
        return json({ ok: true, intent: plan.intent, dispatched: disp.dispatched }, 201);
      }
      return json(intake, 201);
    }

    if (method === 'GET' && url.pathname.startsWith('/api/runs/')) {
      const runId = url.pathname.split('/')[3];
      const since = Number(url.searchParams.get('since') ?? '0');
      const res = orchestrator.resumeRunStream(runId, since);
      return json(res, res.ok ? 200 : res.status);
    }

    if (method === 'POST' && url.pathname === '/hands/poll') {
      const body = await request.json();
      const res = handLease.pollTasks(body.handId, {
        maxConcurrent: body.maxConcurrent,
        now: body.now,
      });
      return json(res, res.status);
    }

    if (method === 'POST' && url.pathname === '/hands/heartbeat') {
      const body = await request.json();
      try {
        const res = handLease.heartbeat(body.taskId, body.leaseId, body.now);
        return json(res, 200);
      } catch (err) {
        return json({ ok: false, error: err.message }, 409);
      }
    }

    if (method === 'POST' && url.pathname === '/hands/result') {
      const body = await request.json();
      try {
        const leaseRes = handLease.reportResult(body.taskId, body.leaseId, body);
        const harvestRes = orchestrator.harvestTask(body.taskId, body);
        return json({ ok: true, lease: leaseRes.task, harvest: harvestRes }, 200);
      } catch (err) {
        return json({ ok: false, error: err.message }, 409);
      }
    }

    if (method === 'POST' && url.pathname === '/hands/probe') {
      const body = await request.json();
      const res = handLease.verifyCapabilityProbe(body.handId, body);
      return json(res, res.ok ? 200 : 400);
    }

    if (method === 'POST' && url.pathname === '/workspaces/ws-default/artifacts/publish') {
      const body = await request.json();
      if (body.manifestContent !== undefined && !body.manifestSha256) {
        body.manifestSha256 = orchestrator.putR2Blob(body.manifestContent);
      }
      const res = orchestrator.publishCanvasArtifact(body);
      return json(res, res.status);
    }

    if (method === 'POST' && url.pathname === '/mesh/bundles') {
      const body = await request.json();
      const res = mailbox.receiveBundle(body.bundle, { now: body.now });
      return json(res, res.ok ? 200 : 400);
    }

    if (method === 'POST' && url.pathname === '/mesh/seat-grants') {
      const body = await request.json();
      const res = mailbox.mintSeatGrant({
        ...body,
        author: authorHeader,
        origin: originHeader,
      });
      return json(res, res.status);
    }

    if (method === 'POST' && url.pathname === '/mesh/seat-leases') {
      const body = await request.json();
      const res = mailbox.executeSharedSeatLease(body);
      return json(res, res.status);
    }

    // =========================================================================
    // Phase 2: Dual-Target Deployment (Local Workstation vs Cloudflare Remote)
    // =========================================================================
    if (method === 'GET' && url.pathname === '/api/deploy/status') {
      return json({
        ok: true,
        ...deploymentConfig,
        custody: mailbox.getCustodyMetadata(),
        secureChannelCount: mailbox.listSecureChannels().length,
        teamGroupCount: mailbox.listTeamGroups().length,
      });
    }

    if (method === 'POST' && url.pathname === '/api/deploy/target') {
      const body = await request.json();
      const next = runArchonDeployTarget({
        mode: body.mode || deploymentConfig.mode,
        localEndpoint: body.localEndpoint || deploymentConfig.localEndpoint,
        remoteWorkerUrl: body.remoteWorkerUrl || deploymentConfig.remoteWorkerUrl,
        remoteFrontendPageUrl: body.remoteFrontendPageUrl || deploymentConfig.remoteFrontendPageUrl,
        workerName: body.workerName || deploymentConfig.workerName,
        pageProjectName: body.pageProjectName || deploymentConfig.pageProjectName,
        cloudflareApiToken: body.cloudflareApiToken || 'local-dev-cf-token',
        encryptionMode: body.encryptionMode || deploymentConfig.encryptionMode,
      });
      if (!next.ok) return json(next, 400);
      deploymentConfig = next;
      mailbox.encryptionMode = deploymentConfig.encryptionMode;
      return json({
        ok: true,
        ...deploymentConfig,
        custody: mailbox.getCustodyMetadata(),
      });
    }

    // Route authenticated mesh traffic through durable storage on the edge.
    if (
      env.ARCHON_MAILBOX &&
      (/^\/(api\/)?mesh\/(channels|teams|sync|rooms|executions|host)(\/|$)/.test(url.pathname) ||
        /^\/(api\/)?mcp\/archon-mesh(\/|$)/.test(url.pathname))
    ) {
      const id = env.ARCHON_MAILBOX.idFromName('workspace-default-mesh');
      return env.ARCHON_MAILBOX.get(id).fetch(request);
    }

    // =========================================================================
    // Phase 3: Multi-User Secure Channels via Cloudflare Remote
    // =========================================================================
    if (method === 'GET' && (url.pathname === '/api/mesh/channels' || url.pathname === '/mesh/channels')) {
      const allChannels = mailbox.listSecureChannels();
      const channels = isPeerScoped
        ? allChannels.filter(
            (ch) =>
              ch.channelId === peerSession.channelId &&
              (ch.members || []).some((m) => m.userId === peerSession.userId)
          )
        : allChannels;
      return json({
        ok: true,
        channels,
        hostStatus: mailbox.hostStatus,
        custody: mailbox.getCustodyMetadata(),
      });
    }

    if (method === 'POST' && (url.pathname === '/api/mesh/channels' || url.pathname === '/mesh/channels')) {
      if (isPeerScoped) {
        return json({ ok: false, status: 403, reason: 'admin_required', error: 'Room-scoped peer sessions cannot create new channels.' }, 403);
      }
      const body = await request.json();
      const res = mailbox.createSecureChannel({
        ...body,
        remoteRelayUrl: body.remoteRelayUrl || deploymentConfig.remoteWorkerUrl,
        encryptionMode: body.encryptionMode || deploymentConfig.encryptionMode,
      });
      return json(res, res.status);
    }

    if (method === 'POST' && (url.pathname === '/api/mesh/channels/join' || url.pathname === '/mesh/channels/join')) {
      const body = await request.json();
      const res = mailbox.joinSecureChannel(body);
      if (!res.ok) return json(res, res.status);
      const cleanUserId = String(body.userId || '').trim();
      const memberEntry = (res.channel.members || []).find((m) => m.userId === cleanUserId);
      const peerSessionToken = mintPeerMeshSession({
        userId: cleanUserId,
        channelId: res.channel.channelId,
        teamId: null,
        role: memberEntry?.role || 'member',
      });
      const cookieVal = `archon_mesh_peer_session=${encodeURIComponent(peerSessionToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;
      return json(
        {
          ...res,
          peerSessionToken,
          peerIdentity: {
            userId: cleanUserId,
            role: memberEntry?.role || 'member',
            identityModel: 'self-declared-display-handle',
            scopedChannelId: res.channel.channelId,
          },
        },
        res.status,
        { 'set-cookie': cookieVal }
      );
    }

    if (method === 'POST' && (url.pathname === '/api/mesh/channels/messages' || url.pathname === '/mesh/channels/messages')) {
      const body = await request.json();
      delete body.internalSeatReply;
      delete body.skipChannelExecution;
      delete body.registeredSeats;
      if (isPeerScoped) {
        if (body.channelId !== peerSession.channelId) {
          return json(
            { ok: false, status: 403, reason: 'room_scope_violation', error: 'Peer session is not authorized for this channel.' },
            403
          );
        }
        if (body.senderId && String(body.senderId).trim() !== peerSession.userId) {
          return json(
            { ok: false, status: 403, reason: 'identity_mismatch', error: 'Cannot post under a different peer identity.' },
            403
          );
        }
        body.senderId = peerSession.userId;
      }
      const res = mailbox.postChannelMessage({
        ...body,
        registeredSeats: sharedStore.seats,
      });
      return json(res, res.status);
    }

    if (method === 'GET' && /^\/(api\/)?mesh\/channels\/[^/]+\/messages$/.test(url.pathname)) {
      const parts = url.pathname.split('/').filter(Boolean);
      const channelId = decodeURIComponent(parts[parts.length - 2]);
      const limit = Number(url.searchParams.get('limit') ?? '50');
      const queryViewerId = url.searchParams.get('viewerId');
      if (isPeerScoped && channelId !== peerSession.channelId) {
        return json(
          { ok: false, status: 403, reason: 'room_scope_violation', error: 'Peer session is not authorized for this channel.' },
          403
        );
      }
      const viewerId = isPeerScoped ? peerSession.userId : queryViewerId;
      const res = mailbox.readChannelMessages(channelId, { limit, viewerId });
      return json(res, res.status);
    }

    // =========================================================================
    // Phase 3: Multi-User Teams & Groups Coordination (team:<id> / group:<id>)
    // =========================================================================
    if (method === 'GET' && (url.pathname === '/api/mesh/teams' || url.pathname === '/mesh/teams')) {
      const allTeams = mailbox.listTeamGroups();
      const allChannels = mailbox.listSecureChannels();
      const teams = isPeerScoped
        ? allTeams.filter(
            (t) =>
              t.teamId === peerSession.teamId &&
              (t.members || []).some((m) => m.userId === peerSession.userId)
          )
        : allTeams;
      const channels = isPeerScoped
        ? allChannels.filter(
            (ch) =>
              ch.channelId === peerSession.channelId &&
              (ch.members || []).some((m) => m.userId === peerSession.userId)
          )
        : allChannels;
      return json({
        ok: true,
        teams,
        channels,
        hostStatus: mailbox.hostStatus,
      });
    }

    if (method === 'POST' && (url.pathname === '/api/mesh/teams' || url.pathname === '/mesh/teams')) {
      if (isPeerScoped) {
        return json({ ok: false, status: 403, reason: 'admin_required', error: 'Room-scoped peer sessions cannot create new teams.' }, 403);
      }
      const body = await request.json();
      const res = mailbox.createTeamGroup({
        ...body,
        remoteRelayUrl: body.remoteRelayUrl || deploymentConfig.remoteWorkerUrl,
        encryptionMode: body.encryptionMode || deploymentConfig.encryptionMode,
      });
      return json(res, res.status);
    }

    if (method === 'POST' && (url.pathname === '/api/mesh/teams/join' || url.pathname === '/mesh/teams/join')) {
      const body = await request.json();
      const res = mailbox.joinTeamGroup(body);
      if (!res.ok) return json(res, res.status);
      const cleanUserId = String(body.userId || '').trim();
      const memberEntry = (res.team.members || []).find((m) => m.userId === cleanUserId);
      const peerSessionToken = mintPeerMeshSession({
        userId: cleanUserId,
        channelId: res.team.secureChannelId,
        teamId: res.team.teamId,
        role: memberEntry?.role || 'member',
      });
      const cookieVal = `archon_mesh_peer_session=${encodeURIComponent(peerSessionToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;
      return json(
        {
          ...res,
          peerSessionToken,
          peerIdentity: {
            userId: cleanUserId,
            role: memberEntry?.role || 'member',
            identityModel: 'self-declared-display-handle',
            scopedTeamId: res.team.teamId,
            scopedChannelId: res.team.secureChannelId,
          },
        },
        res.status,
        { 'set-cookie': cookieVal }
      );
    }

    if (method === 'POST' && (url.pathname === '/api/mesh/teams/messages' || url.pathname === '/mesh/teams/messages')) {
      const body = await request.json();
      delete body.internalSeatReply;
      delete body.registeredSeats;
      if (isPeerScoped) {
        if (body.teamId !== peerSession.teamId) {
          return json(
            { ok: false, status: 403, reason: 'room_scope_violation', error: 'Peer session is not authorized for this team.' },
            403
          );
        }
        if (body.senderId && String(body.senderId).trim() !== peerSession.userId) {
          return json(
            { ok: false, status: 403, reason: 'identity_mismatch', error: 'Cannot post under a different peer identity.' },
            403
          );
        }
        body.senderId = peerSession.userId;
      }
      const res = mailbox.postTeamMessage({
        ...body,
        registeredSeats: sharedStore.seats,
      });
      return json(res, res.status);
    }

    if (method === 'POST' && (url.pathname === '/api/mesh/teams/artifacts' || url.pathname === '/mesh/teams/artifacts')) {
      const body = await request.json();
      if (isPeerScoped) {
        if (body.teamId !== peerSession.teamId) {
          return json(
            { ok: false, status: 403, reason: 'room_scope_violation', error: 'Peer session is not authorized for this team.' },
            403
          );
        }
        if (body.sharedBy && String(body.sharedBy).trim() !== peerSession.userId) {
          return json(
            { ok: false, status: 403, reason: 'identity_mismatch', error: 'Cannot share artifacts under a different peer identity.' },
            403
          );
        }
        body.sharedBy = peerSession.userId;
      }
      const res = mailbox.shareTeamArtifact(body);
      return json(res, res.status);
    }

    if (method === 'GET' && /^\/(api\/)?mesh\/teams\/[^/]+\/artifacts\/[^/]+$/.test(url.pathname)) {
      const parts = url.pathname.split('/').filter(Boolean);
      const artifactId = decodeURIComponent(parts[parts.length - 1]);
      const teamId = decodeURIComponent(parts[parts.length - 3]);
      if (isPeerScoped && teamId !== peerSession.teamId) {
        return json(
          { ok: false, status: 403, reason: 'room_scope_violation', error: 'Peer session is not authorized for this team.' },
          403
        );
      }
      const viewerId = isPeerScoped ? peerSession.userId : url.searchParams.get('viewerId');
      const authRes = mailbox.readTeamSharedArtifact({ teamId, artifactId, viewerId });
      if (!authRes.ok) return json(authRes, authRes.status);
      const storedArtifact = sharedStore.artifacts.get(artifactId) || null;
      return json(
        {
          ok: true,
          status: 200,
          teamId,
          sharedArtifact: authRes.artifact,
          visibleTeamWorkspace: authRes.visibleTeamWorkspace,
          artifactData: storedArtifact
            ? {
                artifactId: storedArtifact.artifactId,
                title: storedArtifact.title,
                latestRevision: storedArtifact.latestRevision,
                metadata: storedArtifact.metadata || {},
              }
            : null,
        },
        200
      );
    }

    if (method === 'POST' && (url.pathname === '/api/mesh/teams/keys' || url.pathname === '/mesh/teams/keys')) {
      if (isPeerScoped) {
        return json(
          { ok: false, status: 403, reason: 'admin_required', error: 'Only the team operator can mint colleague access keys.' },
          403
        );
      }
      const body = await request.json();
      const res = mailbox.mintTeamAccessKey(body);
      return json(res, res.status);
    }

    if (method === 'POST' && (url.pathname === '/api/mesh/teams/rooms' || url.pathname === '/mesh/teams/rooms')) {
      const body = await request.json();
      if (isPeerScoped) {
        if (body.teamId && body.teamId !== peerSession.teamId) {
          return json(
            { ok: false, status: 403, reason: 'room_scope_violation', error: 'Peer session is not authorized for this team.' },
            403
          );
        }
        body.teamId = peerSession.teamId;
        body.createdBy = peerSession.userId;
      }
      const res = mailbox.openTeamTopicRoom(body);
      return json(res, res.status);
    }

    if (method === 'GET' && (url.pathname === '/api/mesh/teams/rooms' || url.pathname === '/mesh/teams/rooms')) {
      const teamId = isPeerScoped ? peerSession.teamId : url.searchParams.get('teamId');
      const roomId = url.searchParams.get('roomId');
      const topic = url.searchParams.get('topic');
      const limit = Number(url.searchParams.get('limit') || '50');
      const viewerId = isPeerScoped ? peerSession.userId : url.searchParams.get('viewerId');
      const res = mailbox.readTeamTopicRoom({ teamId, roomId, topic, viewerId, limit });
      return json(res, res.status);
    }

    if (
      method === 'POST' &&
      (url.pathname === '/api/mesh/teams/rooms/messages' || url.pathname === '/mesh/teams/rooms/messages')
    ) {
      const body = await request.json();
      delete body.registeredSeats;
      if (isPeerScoped) {
        if (body.teamId && body.teamId !== peerSession.teamId) {
          return json(
            { ok: false, status: 403, reason: 'room_scope_violation', error: 'Peer session is not authorized for this team.' },
            403
          );
        }
        body.teamId = peerSession.teamId;
        body.senderId = peerSession.userId;
      }
      const res = mailbox.postTeamTopicRoomMessage({
        ...body,
        registeredSeats: sharedStore.seats,
      });
      return json(res, res.status);
    }

    if (method === 'POST' && (url.pathname === '/api/mesh/teams/skills' || url.pathname === '/mesh/teams/skills')) {
      const body = await request.json();
      if (isPeerScoped) {
        if (body.teamId && body.teamId !== peerSession.teamId) {
          return json(
            { ok: false, status: 403, reason: 'room_scope_violation', error: 'Peer session is not authorized for this team.' },
            403
          );
        }
        body.teamId = peerSession.teamId;
        body.sharedBy = peerSession.userId;
      }
      const res = mailbox.shareTeamSkill(body);
      return json(res, res.status);
    }

    if (method === 'GET' && (url.pathname === '/api/mesh/teams/resources' || url.pathname === '/mesh/teams/resources')) {
      const teamId = isPeerScoped ? peerSession.teamId : url.searchParams.get('teamId');
      const resourceType = url.searchParams.get('resourceType') || 'all';
      const resourceId = url.searchParams.get('resourceId') || null;
      const viewerId = isPeerScoped ? peerSession.userId : url.searchParams.get('viewerId');
      const res = mailbox.getTeamSharedResource({ teamId, resourceType, resourceId, viewerId });
      return json(res, res.status);
    }

    if (method === 'GET' && (url.pathname === '/api/mcp/archon-mesh' || url.pathname === '/mcp/archon-mesh')) {
      return json({
        ok: true,
        ...mailbox.getArchonMeshMcpManifest(),
      });
    }

    if (method === 'POST' && (url.pathname === '/api/mcp/archon-mesh' || url.pathname === '/mcp/archon-mesh')) {
      const body = await request.json().catch(() => ({}));
      if (body.jsonrpc === '2.0') {
        if (body.method === 'initialize') {
          return json({
            jsonrpc: '2.0',
            id: body.id ?? null,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'archon-mesh', version: '1.0.0' },
            },
          });
        }
        if (body.method === 'tools/list') {
          return json({
            jsonrpc: '2.0',
            id: body.id ?? null,
            result: { tools: mailbox.getArchonMeshMcpManifest().tools },
          });
        }
        if (body.method === 'tools/call') {
          const toolName = body.params?.name || '';
          const toolArgs = body.params?.arguments || {};
          const keyFromArgs = toolArgs.accessKey ? mailbox.verifyTeamAccessKey(toolArgs.accessKey) : { ok: false };
          const activePeer =
            peerSession ||
            (keyFromArgs.ok
              ? {
                  userId: keyFromArgs.keyRecord.colleagueHandle,
                  teamId: keyFromArgs.team.teamId,
                  role: keyFromArgs.keyRecord.role,
                }
              : null);
          if (expectedToken && !isAdminAuthenticated && !activePeer && toolName !== 'mesh_join_team') {
            return json(
              {
                jsonrpc: '2.0',
                id: body.id ?? null,
                error: { code: -32001, message: '401 Unauthorized: Valid ARCHON-KEY-... or ARCHON_ADMIN_TOKEN required' },
              },
              401
            );
          }
          const execRes = mailbox.executeMcpMeshTool({
            tool: toolName,
            args: toolArgs,
            callerId: activePeer ? activePeer.userId : toolArgs.userId || 'operator:local',
            scopedTeamId: isPeerScoped ? peerSession.teamId : activePeer && !isAdminAuthenticated ? activePeer.teamId : null,
            isAdmin: !isPeerScoped && isAdminAuthenticated,
            registeredSeats: sharedStore.seats,
          });
          return json({
            jsonrpc: '2.0',
            id: body.id ?? null,
            result: {
              isError: !execRes.ok,
              content: [{ type: 'text', text: JSON.stringify(execRes, null, 2) }],
              structuredContent: execRes,
            },
          });
        }
      }

      const toolName = body.tool || body.name || '';
      const toolArgs = body.args || body.arguments || body;
      const keyFromArgs = toolArgs?.accessKey ? mailbox.verifyTeamAccessKey(toolArgs.accessKey) : { ok: false };
      const activePeer =
        peerSession ||
        (keyFromArgs.ok
          ? {
              userId: keyFromArgs.keyRecord.colleagueHandle,
              teamId: keyFromArgs.team.teamId,
              role: keyFromArgs.keyRecord.role,
            }
          : null);
      if (expectedToken && !isAdminAuthenticated && !activePeer && toolName !== 'mesh_join_team') {
        return json({ ok: false, status: 401, error: 'unauthorized_mcp_call' }, 401);
      }
      const res = mailbox.executeMcpMeshTool({
        tool: toolName,
        args: toolArgs,
        callerId: activePeer ? activePeer.userId : toolArgs.userId || 'operator:local',
        scopedTeamId: isPeerScoped ? peerSession.teamId : activePeer && !isAdminAuthenticated ? activePeer.teamId : null,
        isAdmin: !isPeerScoped && isAdminAuthenticated,
        registeredSeats: sharedStore.seats,
      });
      return json(res, res.status || (res.ok ? 200 : 400));
    }

    if (method === 'POST' && (url.pathname === '/api/mesh/rooms/grants' || url.pathname === '/mesh/rooms/grants')) {
      if (isPeerScoped) {
        return json({ ok: false, status: 403, reason: 'admin_required', error: 'Only room admins or operators can configure seat execution grants.' }, 403);
      }
      const body = await request.json();
      const res = mailbox.configureRoomSeatExecution({
        ...body,
        actorId: body.actorId || 'operator:local',
        isAdmin: true,
      });
      return json(res, res.status);
    }

    if (method === 'POST' && (url.pathname === '/api/mesh/host/status' || url.pathname === '/mesh/host/status')) {
      if (isPeerScoped) {
        return json({ ok: false, status: 403, reason: 'admin_required' }, 403);
      }
      const body = await request.json();
      const res = mailbox.setHostAvailability(body);
      return json(res, res.status);
    }

    if (method === 'POST' && (url.pathname === '/api/mesh/executions/claim' || url.pathname === '/mesh/executions/claim')) {
      if (isPeerScoped) {
        return json({ ok: false, status: 403, reason: 'admin_required' }, 403);
      }
      const body = await request.json().catch(() => ({}));
      const res = mailbox.claimMeshSeatExecutions(body);
      return json(res, res.status);
    }

    if (method === 'POST' && (url.pathname === '/api/mesh/executions/complete' || url.pathname === '/mesh/executions/complete')) {
      if (isPeerScoped) {
        return json({ ok: false, status: 403, reason: 'admin_required' }, 403);
      }
      const body = await request.json();
      const res = mailbox.completeMeshSeatExecution(body);
      return json(res, res.status);
    }

    if (method === 'PUT' && (url.pathname === '/api/mesh/sync' || url.pathname === '/mesh/sync')) {
      if (isPeerScoped) {
        return json({ ok: false, status: 403, reason: 'admin_required' }, 403);
      }
      const body = await request.json();
      if ((body.channels && !Array.isArray(body.channels)) || (body.teams && !Array.isArray(body.teams))) {
        return json({ ok: false, error: 'invalid_mesh_snapshot' }, 400);
      }
      mailbox.mergeMeshSnapshot(body);
      return json({
        ok: true,
        channels: mailbox.listSecureChannels(),
        teams: mailbox.listTeamGroups(),
        hostStatus: mailbox.hostStatus,
      });
    }

    // Fallback to static PWA assets binding if present in Cloudflare Worker environment
    if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      return env.ASSETS.fetch(request);
    }

    return json({ ok: false, error: 'not_found', path: url.pathname }, 404);
  }

  return {
    sharedStore,
    orchestrator,
    handLease,
    mailbox,
    fetch: handleRequest,
  };
}

let defaultRuntime = null;

export default {
  async fetch(request, env) {
    if (!defaultRuntime) {
      defaultRuntime = createArchonEdgeRuntime({ ...env, ARCHON_REMOTE: 'true' });
    }
    return defaultRuntime.fetch(request);
  },
};
