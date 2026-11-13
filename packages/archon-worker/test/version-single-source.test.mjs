// The release version used to live in four places and disagreed: package.json
// 0.5.0, the worker/wrangler var 0.1.005, the CLI banner 0.1.005, and the
// lockfile 0.1.004. This test keeps them pinned to package.json.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { ARCHON_VERSION } from '../src/version.mjs';

const root = new URL('../../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const wrangler = read('packages/archon-worker/wrangler.jsonc');

test('release version has exactly one source of truth', () => {
  assert.equal(ARCHON_VERSION, pkg.version);
  assert.equal(lock.version, pkg.version, 'package-lock must track package.json');
  assert.match(
    wrangler,
    new RegExp(`"ARCHON_VERSION":\\s*"${pkg.version.replace(/\./g, '\\.')}"`),
    'wrangler var must track package.json'
  );
});

test('no source file hardcodes the old release version', () => {
  for (const rel of [
    'packages/archon-worker/src/index.mjs',
    'packages/archon-worker/src/dev-server.mjs',
    'packages/archon-cli/bin/archon.mjs',
  ]) {
    assert.doesNotMatch(read(rel), /\b0\.1\.005\b/, rel);
  }
});

test('the CLI banner reports the package version', async () => {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, ['packages/archon-cli/bin/archon.mjs', 'help'], {
    cwd: new URL('../../../', import.meta.url),
    encoding: 'utf8',
  });
  assert.match(out, new RegExp(`ArchonOS CLI v${pkg.version.replace(/\./g, '\\.')}`));
});
