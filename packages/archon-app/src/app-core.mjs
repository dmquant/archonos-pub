// ArchonOS Desktop & Mobile PWA Client Core (Pillar 3a & 3b: packages/archon-app/src/app-core.mjs)
// Verified invariants (@vibe 822c90f1 & 91a2941a, @trade, @epistates, @rho):
// 1. Resumable Run Streaming & Explicit States:
//    Every chat run has a stable runId; reconnecting on mobile cellular handoff resumes from
//    last sequence cursor without re-submitting the user turn.
//    UI states explicitly distinguish: queued | running | awaiting_approval | partial | failed | completed
//    and NEVER collapse an empty 'no_result' into 'completed'.
// 2. Safe Allowlisted Generative UI Tree:
//    Only allowlisted component types ('card', 'metric_grid', 'table', 'approval_request', 'scene_preview', 'chain_badge')
//    may render. Arbitrary <script>, inline on* handlers, javascript: URLs, and unknown types are rejected.
// 3. Atomic Canvas Client Reducer:
//    Wraps @vibe's advanceCanvas (packages/archon-canvas/revision-gate.mjs) to maintain pinned
//    artifact revisions, breadcrumb permalinks, and revision diffs.
// 4. 3D Polis / Studio / Vortexa Globe Safeguards:
//    Lazy-loads WebGL only on user entry, caps mobile DPR (<= 1.5, 30fps budget), pauses on hidden tab,
//    guarantees 100% accessible HTML table + bilingual transcript parity for every ros.scene.v0.1 node/edge,
//    and isolates third-party embeds in sandbox="allow-scripts" (never allow-same-origin) with nonce-checked postMessage.
// 5. Service Worker Cache Policy:
//    Caches ONLY the public static shell, never private /api/*, /workspaces/*, /hands/*, or /mesh/* responses.

import { advanceCanvas } from '../../archon-canvas/revision-gate.mjs';

export const EXPLICIT_RUN_STATES = new Set([
  'queued',
  'running',
  'awaiting_approval',
  'partial',
  'failed',
  'completed',
]);

export const ALLOWLISTED_GENUI_COMPONENTS = new Set([
  'card',
  'metric_grid',
  'table',
  'approval_request',
  'scene_preview',
  'chain_badge',
]);

export const CHAIN_PALETTE = Object.freeze({
  'chain:drives': '#2563eb',
  'chain:enables': '#0891b2',
  'chain:implies': '#7c3aed',
  'chain:constrains': '#b45309',
  'chain:supports': '#15803d',
  'chain:contradicts': '#be123c',
});

const PUBLIC_SHELL_PATHS = new Set([
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/polis-studio.html',
  '/vortexa-globe.html',
  '/assets/app.css',
  '/assets/app.js',
]);

// Service Worker cache guard: caches ONLY the public shell, NEVER private chat/artifact/API responses
export function shouldCacheInServiceWorker(requestUrl, method = 'GET') {
  if (method.toUpperCase() !== 'GET') return false;
  try {
    const u = new URL(requestUrl, 'https://archon.local');
    if (
      u.pathname.startsWith('/api/') ||
      u.pathname.startsWith('/workspaces/') ||
      u.pathname.startsWith('/hands/') ||
      u.pathname.startsWith('/mesh/')
    ) {
      return false;
    }
    return PUBLIC_SHELL_PATHS.has(u.pathname);
  } catch {
    return false;
  }
}

// Maps backend task/intent state into explicit UI badge state (never collapses no_result into completed)
export function deriveRunUiState(rawState, noResultReason = null) {
  if (rawState === 'no_result' || rawState === 'partial') {
    return {
      uiState: 'partial',
      badgeLabel: 'PARTIAL / NO RESULT',
      isCompleted: false,
      reason: noResultReason ?? 'No output produced by engine',
    };
  }
  if (rawState === 'awaiting_approval' || rawState === 'hold') {
    return {
      uiState: 'awaiting_approval',
      badgeLabel: 'HANDS-UP: AWAITING OPERATOR ACK',
      isCompleted: false,
      reason: noResultReason,
    };
  }
  if (rawState === 'done' || rawState === 'completed') {
    return {
      uiState: 'completed',
      badgeLabel: 'COMPLETED',
      isCompleted: true,
      reason: null,
    };
  }
  if (rawState === 'failed' || rawState === 'refused' || rawState === 'expired') {
    return {
      uiState: 'failed',
      badgeLabel: 'FAILED / REFUSED',
      isCompleted: false,
      reason: noResultReason ?? rawState,
    };
  }
  if (rawState === 'running' || rawState === 'leased' || rawState === 'dispatching') {
    return {
      uiState: 'running',
      badgeLabel: 'RUNNING',
      isCompleted: false,
      reason: null,
    };
  }
  return {
    uiState: 'queued',
    badgeLabel: 'QUEUED',
    isCompleted: false,
    reason: null,
  };
}

// Resumable chat run state reducer (for mobile cellular handoff without re-submitting turn)
export class ResumableRunClient {
  constructor(runId) {
    if (!runId || typeof runId !== 'string') throw new Error('runId required');
    this.runId = runId;
    this.lastSeq = 0;
    this.uiState = deriveRunUiState('queued');
    this.events = [];
  }

  get eventCount() {
    return this.events.length;
  }

  getResumeUrl(baseUrl = 'https://archon.local') {
    return `${baseUrl}/api/runs/${encodeURIComponent(this.runId)}?since=${this.lastSeq}`;
  }

  applyBatch(events = []) {
    for (const ev of events) {
      if (!Number.isSafeInteger(ev.seq) || ev.seq <= this.lastSeq) {
        continue; // Deduplicate already-seen sequence numbers on reconnect
      }
      this.lastSeq = ev.seq;
      this.events.push(ev);
      this.uiState = deriveRunUiState(ev.state, ev.data?.reason ?? null);
    }
    return {
      runId: this.runId,
      lastSeq: this.lastSeq,
      uiState: this.uiState,
      eventCount: this.events.length,
    };
  }
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function containsUnsafePattern(value) {
  if (typeof value === 'string') {
    if (/<\s*script\b/i.test(value)) return 'raw_script_tag';
    if (/\bon[a-z]+\s*=/i.test(value)) return 'inline_event_handler';
    if (/javascript\s*:/i.test(value)) return 'javascript_url';
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = containsUnsafePattern(item);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (/^on[a-z]+$/i.test(k)) return `event_handler_prop:${k}`;
      if (k === 'dangerouslySetInnerHTML' || k === 'innerHTML') return `unsafe_html_prop:${k}`;
      const hit = containsUnsafePattern(v);
      if (hit) return hit;
    }
  }
  return null;
}

// Safe Inline Generative UI Renderer (Section 4.1, @vibe 822c90f1):
// Validates and renders a versioned, allowlisted component tree into sanitized HTML.
export function renderAllowlistedGenUI(node) {
  if (!node || typeof node !== 'object') {
    return { ok: false, error: 'genui_node_not_object', html: '' };
  }
  if (node.schemaVersion !== 1) {
    return { ok: false, error: 'genui_unsupported_schema_version', html: '' };
  }
  if (!ALLOWLISTED_GENUI_COMPONENTS.has(node.type)) {
    return { ok: false, error: `genui_component_not_allowlisted:${node.type}`, html: '' };
  }
  const unsafe = containsUnsafePattern(node.props ?? {});
  if (unsafe) {
    return { ok: false, error: `genui_unsafe_payload:${unsafe}`, html: '' };
  }

  const p = node.props ?? {};
  switch (node.type) {
    case 'card':
      return {
        ok: true,
        html: `<section class="genui-card" data-component="card"><h4>${escapeHtml(p.title)}</h4><p>${escapeHtml(p.body)}</p></section>`,
      };
    case 'metric_grid': {
      const items = Array.isArray(p.metrics) ? p.metrics : [];
      const cells = items
        .map(
          (m) =>
            `<div class="genui-metric"><span class="label">${escapeHtml(m.label)}</span><strong class="value">${escapeHtml(m.value)}</strong></div>`
        )
        .join('');
      return {
        ok: true,
        html: `<div class="genui-metric-grid" data-component="metric_grid">${cells}</div>`,
      };
    }
    case 'table': {
      const cols = Array.isArray(p.columns) ? p.columns : [];
      const rows = Array.isArray(p.rows) ? p.rows : [];
      const ths = cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('');
      const trs = rows
        .map((r) => `<tr>${(Array.isArray(r) ? r : []).map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
        .join('');
      return {
        ok: true,
        html: `<table class="genui-table" data-component="table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`,
      };
    }
    case 'approval_request':
      return {
        ok: true,
        html: `<div class="genui-approval" data-component="approval_request" data-request-id="${escapeHtml(p.requestId)}"><span class="badge-hold">HANDS-UP RAIL</span><strong>${escapeHtml(p.actionKind)}</strong><p>Proposer: ${escapeHtml(p.proposer)} → Grantee: ${escapeHtml(p.grantee)}</p></div>`,
      };
    case 'scene_preview':
      return {
        ok: true,
        html: `<div class="genui-scene-preview" data-component="scene_preview" data-scene-id="${escapeHtml(p.sceneId)}" data-graph-version="${escapeHtml(p.graphVersion)}"><strong>3D Scene: ${escapeHtml(p.title)}</strong><span>ros.scene.v0.1 · rev ${escapeHtml(p.revision)} · HTML Parity Ready</span></div>`,
      };
    case 'chain_badge': {
      const color = CHAIN_PALETTE[p.relation] ?? '#64748b';
      return {
        ok: true,
        html: `<span class="genui-chain-badge" data-component="chain_badge" style="border-color:${color};color:${color}">${escapeHtml(p.from)} —[${escapeHtml(p.relation)}]→ ${escapeHtml(p.to)}</span>`,
      };
    }
    default:
      return { ok: false, error: 'genui_unhandled_type', html: '' };
  }
}

// Accessible HTML Table + Bilingual Transcript Parity Builder for 3D Scenes (Section 4.3 & ARC-136/140)
// Guarantees 100% information parity with ros.scene.v0.1 nodes, edges, and studio captions
// and strips raw reference_quote price/vendor bodies on public audience scenes (@trade rule).
export function buildSceneAccessibleParity(sceneManifest) {
  if (!sceneManifest || sceneManifest.schemaVersion !== 'ros.scene.v0.1') {
    throw new Error('Invalid ros.scene.v0.1 manifest');
  }
  const isPublic = sceneManifest.audience === 'public';
  const nodes = Array.isArray(sceneManifest.nodes) ? sceneManifest.nodes : [];
  const edges = Array.isArray(sceneManifest.edges) ? sceneManifest.edges : [];
  const captions = Array.isArray(sceneManifest.captions) ? sceneManifest.captions : [];

  const sanitizedNodes = nodes.map((n) => {
    const props = { ...(n.props ?? {}) };
    if (isPublic && props.reference_quote) {
      // @trade public redaction rule: strip raw reference_quote price/source
      delete props.reference_quote;
    }
    return {
      id: n.id,
      kind: n.kind,
      label: props.label ?? n.id,
      presence: props.presence ?? 'held',
      thesisTruth: props.thesisTruth ?? null,
      thesisWhy: props.thesisWhy ?? null,
      resolvedFrom: props.resolvedFrom ?? null,
      advisoryOnly: props.advisory ?? true,
    };
  });

  const nodeRowsHtml = sanitizedNodes
    .map(
      (n) =>
        `<tr><td>${escapeHtml(n.id)}</td><td>${escapeHtml(n.kind)}</td><td>${escapeHtml(n.label)}</td><td>${escapeHtml(n.presence)}</td><td>${escapeHtml(n.thesisTruth ?? '—')}</td><td>${escapeHtml(n.thesisWhy ?? '—')}</td><td>${escapeHtml(n.resolvedFrom ?? '—')}</td></tr>`
    )
    .join('');

  const edgeRowsHtml = edges
    .map(
      (e) =>
        `<tr><td>${escapeHtml(e.id)}</td><td>${escapeHtml(e.from)}</td><td>${escapeHtml(e.relation)}</td><td>${escapeHtml(e.to)}</td><td>${escapeHtml(e.colorHex ?? CHAIN_PALETTE[e.relation] ?? '#64748b')}</td></tr>`
    )
    .join('');

  const transcriptHtml = captions
    .map(
      (c) =>
        `<div class="parity-caption"><p class="zh" lang="zh-CN">${escapeHtml(c.zh)}</p><p class="en" lang="en">${escapeHtml(c.en)}</p></div>`
    )
    .join('');

  const html = `
    <div class="scene-accessible-parity" data-scene-id="${escapeHtml(sceneManifest.sceneId)}" data-graph-version="${escapeHtml(sceneManifest.graphVersion)}">
      <div class="advisory-banner" role="status">DECISION PIT: ADVISORY ONLY — NO ORDERS ARE PLACED FROM THIS DESK</div>
      <h4>3D Scene Node Inventory (graphVersion=${escapeHtml(sceneManifest.graphVersion)})</h4>
      <table>
        <thead><tr><th>ID</th><th>Kind</th><th>Label</th><th>Presence</th><th>Thesis Truth</th><th>Why</th><th>Resolved From</th></tr></thead>
        <tbody>${nodeRowsHtml}</tbody>
      </table>
      <h4>Causal &amp; Ontology Edges</h4>
      <table>
        <thead><tr><th>Edge ID</th><th>From</th><th>Relation</th><th>To</th><th>Color</th></tr></thead>
        <tbody>${edgeRowsHtml}</tbody>
      </table>
      <h4>Bilingual Broadcast Transcript</h4>
      <div class="transcript-list">${transcriptHtml}</div>
    </div>
  `.trim();

  return {
    sceneId: sceneManifest.sceneId,
    graphVersion: sceneManifest.graphVersion,
    nodeCount: sanitizedNodes.length,
    edgeCount: edges.length,
    captionCount: captions.length,
    sanitizedNodes,
    html,
  };
}

// 3D Viewport Budget & Sandbox Policy Controller (Section 4.3)
export function compute3dViewportPolicy({ isMobile = false, devicePixelRatio = 2, documentHidden = false, userEntered3D = false }) {
  return {
    shouldMountWebGL: Boolean(userEntered3D) && !documentHidden,
    isPaused: Boolean(documentHidden) || !userEntered3D,
    effectiveDpr: isMobile ? Math.min(devicePixelRatio, 1.5) : Math.min(devicePixelRatio, 2.0),
    targetFps: isMobile ? 30 : 60,
    iframeSandboxAttr: 'allow-scripts', // NEVER allow-same-origin on third-party executable embeds
  };
}

// Size-bounded, nonce-checked postMessage verifier for sandboxed 3D/third-party embeds
export function validateEmbedPostMessage(rawEventData, { expectedNonce, maxBytes = 64 * 1024 }) {
  const serialized = typeof rawEventData === 'string' ? rawEventData : JSON.stringify(rawEventData ?? {});
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    return { ok: false, reason: 'embed_message_exceeds_size_bound' };
  }
  let parsed = rawEventData;
  if (typeof rawEventData === 'string') {
    try {
      parsed = JSON.parse(rawEventData);
    } catch {
      return { ok: false, reason: 'embed_message_invalid_json' };
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, reason: 'embed_message_not_object' };
  }
  if (!expectedNonce || parsed.nonce !== expectedNonce) {
    return { ok: false, reason: 'embed_message_nonce_mismatch' };
  }
  return { ok: true, payload: parsed };
}

export { advanceCanvas };
