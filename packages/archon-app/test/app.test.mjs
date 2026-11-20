// Verification suite for packages/archon-app (Pillar 3a & 3b)
// Tests:
// 1. Service Worker cache policy caches ONLY the public shell, never private /api/*, /workspaces/*, /hands/*, or /mesh/*
// 2. Explicit UI run states distinguish queued | running | awaiting_approval | partial | failed | completed
//    and never render an empty no_result as completed
// 3. ResumableRunClient resumes from last sequence cursor on mobile cellular handoff without duplicating events
// 4. Safe allowlisted Generative UI renderer accepts valid components and rejects <script>, inline on*, javascript: URLs, and unlisted types
// 5. 3D Scene Accessible HTML Parity builder outputs 100% node/edge/transcript parity and strips raw reference_quote on public scenes (@trade rule)
// 6. 3D viewport mobile DPR cap, hidden-tab pause, sandbox="allow-scripts" (never allow-same-origin), and size/nonce-checked postMessage
// 7. Desktop Split-View & Mobile PWA HTML shell integrity

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  shouldCacheInServiceWorker,
  deriveRunUiState,
  ResumableRunClient,
  renderAllowlistedGenUI,
  buildSceneAccessibleParity,
  compute3dViewportPolicy,
  validateEmbedPostMessage,
  APP_VIEWS,
  APP_VIEW_IDS,
  mobileNavGroups,
  mobileNavActiveTab,
  deriveHandTelemetryView,
} from '../src/app-core.mjs';
import { escapeHtml, sanitizeMarkdownHtml } from '../public/console-sanitize.mjs';
import { overrides } from '../public/ui-copy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function readShell(relativePath) {
  return readFileSync(join(__dirname, relativePath), 'utf8');
}

function sliceBetween(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `expected marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `expected end marker after ${start}: ${end}`);
  return source.slice(from, to);
}

const mobileNavMarkup = (html) => sliceBetween(html, 'id="mobile-nav"', '<!-- /mobile navigation -->');
const navSpineMarkup = (html) => sliceBetween(html, '<aside class="nav-spine">', '</aside>');

test('Service Worker cache guard caches only public shell and never private API/workspace/mesh responses', () => {
  assert.equal(shouldCacheInServiceWorker('https://archon.local/'), true);
  assert.equal(shouldCacheInServiceWorker('https://archon.local/index.html'), true);
  assert.equal(shouldCacheInServiceWorker('https://archon.local/manifest.webmanifest'), true);
  assert.equal(shouldCacheInServiceWorker('https://archon.local/polis-studio.html'), true);

  // Non-GET or private endpoints must never be cached
  assert.equal(shouldCacheInServiceWorker('https://archon.local/index.html', 'POST'), false);
  assert.equal(shouldCacheInServiceWorker('https://archon.local/api/health'), false);
  assert.equal(shouldCacheInServiceWorker('https://archon.local/api/runs/run-1'), false);
  assert.equal(shouldCacheInServiceWorker('https://archon.local/workspaces/ws-default/artifacts/1'), false);
  assert.equal(shouldCacheInServiceWorker('https://archon.local/hands/poll'), false);
  assert.equal(shouldCacheInServiceWorker('https://archon.local/mesh/bundles'), false);
});

test('Explicit UI run states never collapse no_result into completed and resumable stream deduplicates on reconnect', () => {
  const noResState = deriveRunUiState('no_result', 'engine produced no output');
  assert.equal(noResState.uiState, 'partial');
  assert.equal(noResState.isCompleted, false);

  const holdState = deriveRunUiState('awaiting_approval', 'needs human-ack');
  assert.equal(holdState.uiState, 'awaiting_approval');
  assert.equal(holdState.isCompleted, false);

  const doneState = deriveRunUiState('done');
  assert.equal(doneState.uiState, 'completed');
  assert.equal(doneState.isCompleted, true);

  const client = new ResumableRunClient('run-mobile-1');
  assert.equal(client.getResumeUrl('https://archon.local'), 'https://archon.local/api/runs/run-mobile-1?since=0');

  client.applyBatch([
    { seq: 1, state: 'queued', data: {} },
    { seq: 2, state: 'running', data: {} },
  ]);
  assert.equal(client.lastSeq, 2);
  assert.equal(client.uiState.uiState, 'running');
  assert.equal(client.getResumeUrl('https://archon.local'), 'https://archon.local/api/runs/run-mobile-1?since=2');

  // Reconnect receives overlapping seq=2 and final seq=3 (no_result)
  client.applyBatch([
    { seq: 2, state: 'running', data: {} },
    { seq: 3, state: 'no_result', data: { reason: 'empty stream' } },
  ]);
  assert.equal(client.eventCount, 3);
  assert.equal(client.uiState.uiState, 'partial');
  assert.equal(client.uiState.isCompleted, false);
});

test('Safe Allowlisted Generative UI renders allowlisted components and blocks script tags, inline handlers, javascript: URLs, and unknown types', () => {
  const okCard = renderAllowlistedGenUI({
    schemaVersion: 1,
    type: 'card',
    props: { title: 'Vortexa Tanker Flow', body: 'Middle East -> Ningbo +6.4% WoW' },
  });
  assert.equal(okCard.ok, true);
  assert.match(okCard.html, /Vortexa Tanker Flow/);

  const okChain = renderAllowlistedGenUI({
    schemaVersion: 1,
    type: 'chain_badge',
    props: { from: 'gpu-capex', relation: 'chain:constrains', to: 'grid-transformers' },
  });
  assert.equal(okChain.ok, true);
  assert.match(okChain.html, /#b45309/);

  // Reject unknown component type
  const unknownType = renderAllowlistedGenUI({
    schemaVersion: 1,
    type: 'raw_html_iframe',
    props: {},
  });
  assert.equal(unknownType.ok, false);
  assert.match(unknownType.error, /genui_component_not_allowlisted/);

  // Reject <script> injection
  const scriptAttempt = renderAllowlistedGenUI({
    schemaVersion: 1,
    type: 'card',
    props: { title: 'Hi', body: '<script>alert(1)</script>' },
  });
  assert.equal(scriptAttempt.ok, false);
  assert.match(scriptAttempt.error, /raw_script_tag/);

  // Reject inline event handler property
  const handlerAttempt = renderAllowlistedGenUI({
    schemaVersion: 1,
    type: 'card',
    props: { title: 'Hi', onclick: 'stealToken()' },
  });
  assert.equal(handlerAttempt.ok, false);
  assert.match(handlerAttempt.error, /event_handler_prop/);

  // Reject javascript: URL
  const jsUrlAttempt = renderAllowlistedGenUI({
    schemaVersion: 1,
    type: 'card',
    props: { title: 'javascript:evil()', body: 'test' },
  });
  assert.equal(jsUrlAttempt.ok, false);
  assert.match(jsUrlAttempt.error, /javascript_url/);
});

test('3D Scene Accessible HTML Parity builder preserves 100% node/edge/caption parity and redacts reference_quote on public scenes', () => {
  const scene = {
    schemaVersion: 'ros.scene.v0.1',
    sceneId: 'ethos-morning-brief-2026-10-20-scene',
    revision: 2,
    audience: 'public',
    graphVersion: 8601,
    nodes: [
      {
        id: 'node-xcmg',
        kind: 'epistate_subject',
        props: {
          label: '徐工机械 (XCMG Machinery)',
          presence: 'held',
          thesisTruth: 'U',
          thesisWhy: 'conflicted',
          resolvedFrom: '000425.SZ (verdict walked from 000425.SZ, 1:1 primary listing)',
          reference_quote: { price: 8.47, vendor: 'raw-feed-secret' },
        },
      },
    ],
    edges: [
      {
        id: 'edge-ai-power-1',
        from: 'chain:gpu-cluster-capex',
        to: 'chain:grid-transformer-delivery',
        relation: 'chain:constrains',
      },
    ],
    captions: [
      {
        zh: '徐工机械当前处于证据冲突态（U: conflicted）。',
        en: 'XCMG Machinery is currently in an evidence-conflicted state (U: conflicted).',
      },
    ],
  };

  const parity = buildSceneAccessibleParity(scene);
  assert.equal(parity.nodeCount, 1);
  assert.equal(parity.edgeCount, 1);
  assert.equal(parity.captionCount, 1);
  // Public audience must strip reference_quote (@trade rule)
  assert.equal('reference_quote' in parity.sanitizedNodes[0], false);
  assert.match(parity.html, /DECISION PIT: ADVISORY ONLY/);
  assert.match(parity.html, /000425\.SZ/);
  assert.match(parity.html, /chain:constrains/);
  assert.match(parity.html, /徐工机械当前处于证据冲突态/);
});

test('3D viewport safeguards and sandboxed embed postMessage validation', () => {
  // Lazy-loads only when userEntered3D is true and tab is visible; mobile DPR capped at 1.5 and 30fps
  const beforeEntry = compute3dViewportPolicy({ isMobile: true, devicePixelRatio: 3, documentHidden: false, userEntered3D: false });
  assert.equal(beforeEntry.shouldMountWebGL, false);
  assert.equal(beforeEntry.effectiveDpr, 1.5);
  assert.equal(beforeEntry.targetFps, 30);
  assert.equal(beforeEntry.iframeSandboxAttr, 'allow-scripts');
  assert.doesNotMatch(beforeEntry.iframeSandboxAttr, /allow-same-origin/);

  const hiddenTab = compute3dViewportPolicy({ isMobile: false, devicePixelRatio: 2, documentHidden: true, userEntered3D: true });
  assert.equal(hiddenTab.isPaused, true);

  // Nonce-checked and size-bounded postMessage
  const badNonce = validateEmbedPostMessage({ nonce: 'wrong', action: 'selectNode' }, { expectedNonce: 'n-1' });
  assert.equal(badNonce.ok, false);
  assert.equal(badNonce.reason, 'embed_message_nonce_mismatch');

  const oversized = validateEmbedPostMessage({ nonce: 'n-1', data: 'x'.repeat(70_000) }, { expectedNonce: 'n-1', maxBytes: 64 * 1024 });
  assert.equal(oversized.ok, false);
  assert.equal(oversized.reason, 'embed_message_exceeds_size_bound');

  const validMsg = validateEmbedPostMessage({ nonce: 'n-1', nodeId: 'node-xcmg' }, { expectedNonce: 'n-1' });
  assert.equal(validMsg.ok, true);
});

test('Desktop Split-View & Mobile PWA HTML shell embeds sandboxed 3D Polis/Studio and Accessible HTML Parity Table', () => {
  const html = readFileSync(join(__dirname, '../public/index.html'), 'utf8');
  assert.match(html, /Archon Chat/);
  assert.match(html, /Archon Canvas/);
  assert.match(html, /Hands-Up Approval Rail/);
  assert.match(html, /sandbox="allow-scripts"/);
  assert.doesNotMatch(html, /allow-same-origin/);
  assert.match(html, /DECISION PIT: ADVISORY ONLY — NO ORDERS PLACED/);
  // Round 1-10 RSI verifications
  assert.match(html, /rsi-loop-panel/);
  assert.match(html, /mcp-playground-output/);
  assert.match(html, /artifact-diff-box/);

  const globePath = join(__dirname, '../public/vortexa-globe.html');
  if (existsSync(globePath)) {
    const globeHtml = readFileSync(globePath, 'utf8');
    assert.match(globeHtml, /2026-10-21/);
    assert.match(globeHtml, /Day 20\/20/);
  }
});


test('Console escaping covers every quote style used by the shell', () => {
  assert.equal(escapeHtml("a'b"), 'a&#39;b', "single quotes must not survive into single-quoted attributes");
  assert.equal(escapeHtml('a"b<c>&d'), 'a&quot;b&lt;c&gt;&amp;d');
  // Note: this is the HTML text/attribute context. Values interpolated into the
  // JS argument of an inline on* handler need a JS-string encoder, which is a
  // separate change (the HTML parser decodes &#39; back to ' before evaluating).
});

test('Markdown sanitiser removes every handler/URL variant, not just double-quoted ones', () => {
  const vectors = [
    '<img src=x onerror=alert(1)>',
    "<img src=x onerror='alert(1)'>",
    '<div onmouseover="alert(1)">x</div>',
    '<svg onload=alert(1)></svg>',
    '<a href="javascript:alert(1)">x</a>',
    "<a href='vbscript:msgbox(1)'>x</a>",
    '<a href="java&#115;cript:alert(1)">x</a>',
    '<a href="JaVaScRiPt:alert(1)">x</a>',
    '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
    '<script>alert(1)</script>',
    '<style>body{display:none}</style>',
    '<!--<img src=x onerror=alert(1)>-->',
  ];
  for (const vector of vectors) {
    const out = sanitizeMarkdownHtml(vector);
    assert.doesNotMatch(out, /on[a-z]+\s*=/i, vector);
    assert.doesNotMatch(out, /(?:javascript|vbscript)\s*:/i, vector);
    assert.doesNotMatch(out, /<(?:script|iframe|style)\b/i, vector);
  }
  assert.equal(sanitizeMarkdownHtml('<img src=x onerror=alert(1)>'), '<img src=x>');
});

test('Markdown sanitiser preserves ordinary rendered markup', () => {
  const benign = '<p>see <strong>this</strong> and <a href="https://example.com/a?b=1">link</a></p><pre><code>&lt;script&gt;</code></pre>';
  assert.equal(sanitizeMarkdownHtml(benign), benign);
});

test('Model-authored artifact iframes are sandboxed without same-origin access', () => {
  const html = readFileSync(join(__dirname, '../public/index.html'), 'utf8');
  for (const id of ['vortexa-artifact-iframe', 'polis-artifact-iframe', 'custom-artifact-iframe']) {
    const tag = html.split(`id="${id}"`)[1]?.split('>')[0] || '';
    assert.match(tag, /sandbox="allow-scripts"/, `${id} must be sandboxed`);
    assert.doesNotMatch(tag, /allow-same-origin/, `${id} must not share the console origin`);
  }
});

test('Hand selectors expose every supported local CLI engine', () => {
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../public/index.html'), 'utf8');
  for (const selectId of ['chat-engine-select', 'crud-seat-hand', 'cfg-hand-engine', 'synth-skill-engine']) {
    const block = html.split(`id="${selectId}"`)[1]?.split('</select>')[0] || '';
    assert.ok(block, `${selectId} exists`);
    for (const engine of ['claude', 'codex', 'agy', 'opencode', 'dsh']) {
      assert.match(block, new RegExp(`value="${engine}"`), `${selectId} offers ${engine}`);
    }
  }
});

test('Mobile navigation exposes every registered view exactly once from the shared registry', () => {
  const html = readShell('../public/index.html');

  // One registry drives the desktop spine, the mobile bar and switchView().
  assert.equal(APP_VIEW_IDS.length, 9);
  assert.deepEqual(APP_VIEW_IDS, [
    'workbench',
    'seats',
    'artifacts',
    'skills',
    'schedules',
    'architect',
    'mcps',
    'hands',
    'mesh',
  ]);
  const { primary, more } = mobileNavGroups();
  assert.deepEqual(primary, ['workbench', 'seats', 'artifacts', 'skills']);
  assert.deepEqual(more, ['schedules', 'architect', 'mcps', 'hands', 'mesh']);
  assert.deepEqual([...primary, ...more], APP_VIEW_IDS);
  assert.equal(new Set([...primary, ...more]).size, 9);

  const mobile = mobileNavMarkup(html);
  const mobileViewIds = [...mobile.matchAll(/data-nav-view="([a-z-]+)"/g)].map((match) => match[1]);
  assert.equal(mobileViewIds.length, 9, 'the mobile nav lists all nine views, no duplicates or gaps');
  assert.deepEqual(mobileViewIds, APP_VIEW_IDS);

  for (const view of APP_VIEWS) {
    assert.match(
      mobile,
      new RegExp(`onclick="switchView\\('${view.id}'\\)"`),
      `${view.id} uses the shared switchView contract`
    );
    assert.match(
      mobile,
      new RegExp(`data-i18n="${view.mobileLabelKey || view.labelKey}"`),
      `${view.id} label is translated through the existing i18n mechanism`
    );
  }

  // The desktop spine must offer the same destinations.
  const spine = navSpineMarkup(html);
  for (const id of APP_VIEW_IDS) {
    assert.match(spine, new RegExp(`id="nav-${id}"`), `desktop spine exposes ${id}`);
  }

  // switchView must consume the registry rather than keeping a second copy.
  const switchViewSource = sliceBetween(
    html,
    'window.switchView = function',
    'let currentPreviewPairedArtifactId'
  );
  assert.match(switchViewSource, /APP_VIEWS/);
  assert.doesNotMatch(switchViewSource, /\['workbench',\s*'seats'/);
});

test('Mobile navigation lives outside the hidden desktop spine and stays visible at <=960px', () => {
  const html = readShell('../public/index.html');
  const spine = navSpineMarkup(html);
  assert.doesNotMatch(spine, /mobile-tabbar/);
  assert.doesNotMatch(spine, /mobile-nav-sheet/);
  assert.doesNotMatch(spine, /id="mobile-nav"/);

  const mobileIndex = html.indexOf('id="mobile-nav"');
  assert.ok(mobileIndex > html.indexOf('</aside>'), 'mobile nav is not nested in the desktop spine');
  assert.ok(mobileIndex > html.indexOf('id="view-mesh"'), 'mobile nav comes after the view containers');
  assert.ok(mobileIndex < html.indexOf('<script type="module">'), 'mobile nav markup is static, not injected by script');

  const css = readShell('../public/ui-shell.css');
  const phone = css.slice(css.indexOf('@media (max-width:960px)'));
  assert.match(phone, /\.nav-spine\s*\{[^}]*display:none/, 'the desktop spine is hidden on phones');
  assert.match(phone, /\.mobile-tabbar\s*\{[^}]*display:grid/, 'the tab bar is shown on phones');
  assert.doesNotMatch(phone, /\.mobile-tabbar\s*\{[^}]*display:none/);
  assert.doesNotMatch(phone, /\.mobile-nav-sheet\s*\{[^}]*display:none/);
  assert.match(
    css,
    /\.mobile-tabbar,\s*\.mobile-nav-sheet,\s*\.mobile-nav-backdrop\s*\{\s*display:none/
  );
});

test('Mobile navigation is accessible, safe-area aware, and dismisses on navigate, backdrop and Esc', () => {
  const html = readShell('../public/index.html');
  const mobile = mobileNavMarkup(html);

  assert.match(mobile, /<nav class="mobile-tabbar" id="mobile-tabbar" aria-label="Main navigation"/);
  assert.match(mobile, /<button type="button" class="mobile-tab active" data-nav-view="workbench" aria-current="page"/);
  assert.match(mobile, /aria-haspopup="dialog"/);
  assert.match(mobile, /aria-expanded="false"/);
  assert.match(mobile, /aria-controls="mobile-nav-sheet"/);
  assert.match(mobile, /id="mobile-nav-sheet" role="dialog" aria-modal="true" aria-labelledby="mobile-nav-sheet-title"/);
  assert.match(mobile, /class="mobile-nav-backdrop" id="mobile-nav-backdrop" hidden onclick="closeMobileNav\(\)"/);
  assert.match(mobile, /data-i18n="mobile_nav_more"/);

  // Every interactive item is a real button with a translated label.
  for (const tag of mobile.match(/<button\b[^>]*>/g) || []) {
    assert.match(tag, /type="button"/);
  }
  for (const key of ['mobile_nav_workbench', 'mobile_nav_seats', 'mobile_nav_artifacts', 'mobile_nav_skills', 'mobile_nav_more', 'mobile_nav_all_views']) {
    assert.ok(key in overrides, `${key} is in the ui-copy overrides map`);
    assert.match(html, new RegExp(`${key}:`), `${key} is in the inline i18n map`);
  }

  // nav_architect_loop used to render only in English in ZH mode.
  assert.deepEqual(overrides.nav_architect_loop, ['Architect Loop', '架构闭环']);
  assert.match(html, /nav_architect_loop: 'Architect Loop'/);
  assert.match(html, /nav_architect_loop: '架构闭环'/);

  // Active-state wiring sets aria-current="page" on the current destination.
  const syncSource = sliceBetween(html, 'function syncNavState', 'window.openMobileNav');
  assert.match(syncSource, /aria-current', 'page'/);

  const css = readShell('../public/ui-shell.css');
  assert.match(css, /\.mobile-nav \{ display:contents;? \}/, 'the tab bar takes part in the body flex layout');
  assert.match(css, /\.mobile-tabbar \{[^}]*flex:none/, 'the tab bar keeps its height instead of covering content');
  assert.doesNotMatch(css, /\.mobile-tabbar \{[^}]*position:fixed/, 'the bar is not an overlay over the composer');
  assert.match(
    css,
    /\.mobile-tabbar \{[^}]*min-height:calc\(var\(--mobile-nav-height\) \+ env\(safe-area-inset-bottom, 0px\)\)/s,
    'tab bar respects the iOS home-indicator inset'
  );
  assert.match(css, /padding:4px 6px calc\(4px \+ env\(safe-area-inset-bottom, 0px\)\)/);

  // The mobile surfaces stay in the project's flat, shared-radius language: a
  // plain 2px indicator (no decorative glow) and the same 12px as cards.
  assert.doesNotMatch(
    css,
    /\.mobile-tab\[aria-current="page"\]::before \{[^}]*box-shadow/,
    'the active indicator must stay flat like the rest of the interface'
  );
  assert.match(css, /\.mobile-nav-sheet \{[^}]*border-radius:12px 12px 0 0/, 'sheet uses the card radius');

  // Dismissal paths: navigation, backdrop tap and Escape all close the sheet.
  assert.match(html, /window\.switchView = function[\s\S]{0,1200}?window\.closeMobileNav\(\)/);
  assert.match(html, /event\.key === 'Escape'[\s\S]{0,160}?closeMobileNav\(true\)/);
});

test('Hand telemetry keeps IDLE neutral, OFFLINE unavailable, and measured verdicts coloured', () => {
  const idle = deriveHandTelemetryView({ runs: 0, avgLatencyMs: 0, circuitState: 'IDLE' }, true);
  assert.equal(idle.state, 'idle');
  assert.equal(idle.tone, 'idle');
  assert.equal(idle.color, 'var(--text-muted)');
  assert.equal(idle.runsLabel, 'no runs yet');
  assert.equal(idle.latencyLabel, '—');
  assert.equal(idle.hasRuns, false);
  assert.doesNotMatch(idle.latencyLabel, /0ms/, 'never-run hand must not report 0ms');

  const offline = deriveHandTelemetryView({ runs: 0, avgLatencyMs: 0, circuitState: 'IDLE' }, false);
  assert.equal(offline.state, 'offline');
  assert.equal(offline.color, 'var(--crimson)');
  assert.notEqual(offline.tone, idle.tone, 'missing binary is distinct from never-run');

  const healthy = deriveHandTelemetryView({ runs: 4, avgLatencyMs: 812, circuitState: 'CLOSED (HEALTHY)' }, true);
  assert.equal(healthy.state, 'healthy');
  assert.equal(healthy.color, 'var(--emerald)');
  assert.equal(healthy.latencyLabel, '812ms avg');
  assert.equal(healthy.runsLabel, '4 runs');

  const fallback = deriveHandTelemetryView(
    { runs: 3, avgLatencyMs: 1200, circuitState: 'HALF-OPEN (FALLBACK GUARD)' },
    true
  );
  assert.equal(fallback.state, 'fallback');
  assert.equal(fallback.color, 'var(--amber)');
  assert.equal(fallback.runsLabel, '3 runs');
});

test('Hands panel renders the derived state rather than treating IDLE as an error', () => {
  const html = readShell('../public/index.html');
  const panel = sliceBetween(
    html,
    "const tbody = document.getElementById('hands-status-tbody')",
    '// Load portable .archon/config.json'
  );
  assert.match(panel, /deriveHandTelemetryView\(m, h\.installed\)/);
  assert.match(panel, /handView\.state/);
  assert.match(panel, /handView\.latencyLabel/);
  assert.doesNotMatch(panel, /avgLatencyMs \|\| 0\)\}ms avg/, 'the panel no longer prints 0ms for an unrun hand');
  assert.doesNotMatch(panel, /isHealthy/);

  const presenter = readShell('../public/hands-view.mjs');
  assert.match(presenter, /state = 'idle'/);
  assert.match(presenter, /state = 'offline'/);
  assert.match(presenter, /state = 'fallback'/);
  assert.match(presenter, /'—'/);
  assert.deepEqual(overrides.hand_no_runs, ['no runs yet', '尚未执行']);
});

test('Data tables keep legible column geometry and scroll inside their own container', () => {
  const css = readShell('../public/ui-shell.css');
  const tableCss = css.slice(css.indexOf('Data-table legibility'));
  assert.ok(tableCss, 'the table legibility block exists');

  // Headers never break mid-word; identifiers, mono values and row actions stay whole.
  assert.match(tableCss, /\.ui-table-scroll th \{ white-space:nowrap; \}/);
  assert.match(tableCss, /\.ui-table-scroll td\.mono \{ overflow-wrap:normal; \}/);
  assert.match(tableCss, /\.ui-table-scroll td:first-child \{ white-space:nowrap; \}/);
  assert.match(
    tableCss,
    /\.ui-table-scroll td button,\s*\.ui-table-scroll td \.btn,\s*\.ui-table-scroll td \.mini-btn \{ white-space:nowrap; overflow-wrap:normal; \}/
  );

  // Phones get a real minimum width; the scroll wrapper owns the overflow.
  assert.match(
    tableCss,
    /@media \(max-width:960px\) \{\s*\/\*[^*]*\*\/\s*\.ui-table-scroll table \{ min-width:680px; \}/
  );
  assert.match(css, /\.ui-table-scroll \{ width:100%; max-width:100%; overflow-x:auto;/);

  // Chat-message tables already scroll themselves; only their typography changes.
  assert.match(tableCss, /\.msg-body table th,\s*\.msg-body table td \{ white-space:nowrap; \}/);
  assert.match(
    readShell('../public/ui-shell.mjs'),
    /table\.closest\('\.ui-table-scroll,\.msg-body,\.file-preview-rendered'\)/
  );
  assert.doesNotMatch(tableCss, /\.file-preview-rendered table/);
});

test('Exactly one mobile tab is current and hover styling is pointer-fine only', () => {
  // Primary views own their tab; overflow views are represented by "More".
  assert.equal(mobileNavActiveTab('workbench'), 'workbench');
  assert.equal(mobileNavActiveTab('skills'), 'skills');
  assert.equal(mobileNavActiveTab('schedules'), 'more');
  assert.equal(mobileNavActiveTab('mesh'), 'more');
  assert.equal(mobileNavActiveTab('not-a-view'), null);

  const html = readShell('../public/index.html');
  const sync = sliceBetween(html, 'function syncNavState', 'window.openMobileNav');
  // Strict equality clears every other tab; nothing is additive.
  assert.match(sync, /el\.classList\.toggle\('active', isActive\)/);
  assert.match(sync, /setAttribute\('aria-current', 'page'\)/);
  assert.match(sync, /mobileNavActiveTab\(viewName\) === 'more'/);

  // Hover is a pointer affordance only; touch/coarse pointers never keep a pill.
  const css = readShell('../public/ui-shell.css');
  assert.equal((css.match(/@media \(hover:hover\) and \(pointer:fine\) \{/g) || []).length, 2);
  assert.doesNotMatch(css, /@media \(hover:hover\) \{/);
});

test('Phone canvas column scrolls instead of clipping cards and keeps its telemetry table legible', () => {
  const css = readShell('../public/ui-shell.css');
  const block = css.slice(css.indexOf('Phone canvas column'));
  assert.ok(block, 'the phone canvas block exists');
  assert.match(block, /@media \(max-width:960px\) \{/);
  // The canvas body scrolls its own content and leaves clearance above the bar.
  assert.match(
    block,
    /\.canvas-body \{\s*overflow-y:auto;\s*overflow-x:hidden;\s*padding-bottom:14px;/
  );
  // The telemetry stage no longer traps content in a second fixed-height scroller.
  assert.match(block, /#stage-art-telemetry-matrix \{ overflow:visible; \}/);
  assert.match(
    block,
    /#stage-art-telemetry-matrix::after \{ content:''; display:block; flex:none; height:14px; \}/
  );
  // Fixed layout + nowrap headers overlapped; auto layout scrolls instead.
  assert.match(
    block,
    /#stage-art-telemetry-matrix table \{ min-width:680px; table-layout:auto; \}/
  );
  // Desktop keeps the original clipping/fixed-layout behaviour.
  assert.match(readShell('../public/index.html'), /\.canvas-body \{[^}]*overflow: hidden;/);
  assert.match(css, /#stage-art-telemetry-matrix table \{ min-width:0; table-layout:fixed; \}/);
});

test('Inactive navigation omits aria-current instead of setting aria-current="false"', () => {
  const shell = readShell('../public/ui-shell.mjs');
  assert.doesNotMatch(shell, /aria-current',\s*'false'/);
  assert.match(shell, /if \(button\.classList\.contains\('active'\)\) button\.setAttribute\('aria-current', 'page'\);/);
  assert.match(shell, /else button\.removeAttribute\('aria-current'\);/);

  const html = readShell('../public/index.html');
  assert.doesNotMatch(html, /aria-current="false"/);
  assert.match(html, /else el\.removeAttribute\('aria-current'\);/);
});
