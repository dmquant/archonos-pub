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
} from '../src/app-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

