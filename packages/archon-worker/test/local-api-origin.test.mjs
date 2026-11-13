// The local edge server can spawn coding CLIs, so binding to loopback is not an
// authentication boundary: a page the operator visits must not be able to drive
// /api/chat from another origin. These tests pin the origin guard and the
// preflight handler that runs before any route dispatch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Set before importing dev-server: STATE_DIR is resolved at module load.
const stateDir = mkdtempSync(join(tmpdir(), 'archon-origin-'));
process.env.ARCHON_STATE_DIR = stateDir;
const { evaluateLocalRequestOrigin, startLocalEdgeServer } = await import('../src/dev-server.mjs');

test('origin policy allows CLI clients and same-origin browsers only', () => {
  assert.deepEqual(
    evaluateLocalRequestOrigin({ origin: undefined, host: '127.0.0.1:8790' }),
    { allowed: true, corsOrigin: null },
    'no Origin header (curl, CLI, server-to-server) stays allowed'
  );
  assert.deepEqual(
    evaluateLocalRequestOrigin({ origin: 'http://127.0.0.1:8790', host: '127.0.0.1:8790' }),
    { allowed: true, corsOrigin: 'http://127.0.0.1:8790' }
  );
  assert.equal(
    evaluateLocalRequestOrigin({ origin: 'http://localhost:8790', host: '127.0.0.1:8790' }).allowed,
    false,
    'a different host is a different origin even on loopback'
  );
  assert.equal(
    evaluateLocalRequestOrigin({ origin: 'https://evil.example', host: '127.0.0.1:8790' }).allowed,
    false
  );
  assert.equal(
    evaluateLocalRequestOrigin({ origin: 'javascript:alert(1)', host: '127.0.0.1:8790' }).allowed,
    false,
    'non-http(s) origins are rejected'
  );
  assert.equal(
    evaluateLocalRequestOrigin({ origin: 'https://evil.example', host: '127.0.0.1:8790', secFetchSite: 'cross-site' }).allowed,
    false
  );
  assert.deepEqual(
    evaluateLocalRequestOrigin({
      origin: 'http://localhost:5173',
      host: '127.0.0.1:8790',
      allowedOrigins: ['http://localhost:5173'],
    }),
    { allowed: true, corsOrigin: 'http://localhost:5173' },
    'an explicit operator allowlist is honoured'
  );
});

test('cross-origin requests are refused before any route runs', async () => {
  const server = startLocalEdgeServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    // A page on another origin trying to read state.
    const evilGet = await fetch(`${base}/api/hands/status`, {
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(evilGet.status, 403);
    assert.equal(evilGet.headers.get('access-control-allow-origin'), null, 'no ACAO on a refused request');
    assert.equal((await evilGet.json()).error, 'origin_not_allowed');

    // The preflight a browser would send before POSTing /api/chat.
    const evilPreflight = await fetch(`${base}/api/chat`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    assert.equal(evilPreflight.status, 403, 'preflight must not be answered with a permissive 204');

    // /api/chat itself is refused, so no CLI hand can be spawned.
    const evilChat = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'touch /tmp/should-not-exist', engineOverride: 'dsh' }),
    });
    assert.equal(evilChat.status, 403);

    // Same-origin preflight is answered locally, with the origin echoed.
    const preflight = await fetch(`${base}/api/chat`, {
      method: 'OPTIONS',
      headers: { origin: base, 'access-control-request-method': 'POST' },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), base);
    assert.match(preflight.headers.get('access-control-allow-methods') || '', /POST/);

    // Normal same-origin traffic still works and never gets a wildcard.
    const ok = await fetch(`${base}/api/hands/status`, { headers: { origin: base } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('access-control-allow-origin'), base);
    assert.notEqual(ok.headers.get('access-control-allow-origin'), '*');

    // Non-browser clients (no Origin) are unaffected.
    const cli = await fetch(`${base}/api/hands/status`);
    assert.equal(cli.status, 200);
    assert.equal(cli.headers.get('access-control-allow-origin'), null);
  } finally {
    server.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
