// Documentation contracts for the user-facing install guides.
// These drift silently otherwise: README once advertised `archon status`,
// `archon hands probe` and `npm run init:force` long before any of them existed,
// and linked `packages/archon-skills` while the directory was `archon-skills-rsi`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../../', import.meta.url).pathname;
const BIN = join(ROOT, 'packages/archon-cli/bin/archon.mjs');
const GUIDES = ['README.md', 'README.zh-CN.md', 'docs/en/QUICKSTART.md', 'docs/zh-CN/QUICKSTART.md'];
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const pkg = JSON.parse(read('package.json'));
const help = execFileSync(process.execPath, [BIN, 'help'], { encoding: 'utf8' });

// `npx archon init`, `archon hands probe`, `archon hand pair <CODE>`
const CLI_MENTION = /\barchon\s+((?:hands?\s+)?[a-z][a-z-]*)/g;

function documentedCliCommands(source) {
  const found = new Set();
  for (const match of source.matchAll(CLI_MENTION)) {
    const phrase = match[1].trim();
    // Skip prose like "archon CLI" or "archon OS".
    if (phrase === 'cli' || phrase === 'os') continue;
    found.add(phrase);
  }
  return found;
}

test('every CLI command named in the guides exists in `archon help`', () => {
  const missing = [];
  for (const guide of GUIDES) {
    for (const command of documentedCliCommands(read(guide))) {
      if (!help.includes(`archon ${command}`)) missing.push(`${guide}: archon ${command}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('every `npm run <script>` named in the guides exists in package.json', () => {
  const missing = [];
  for (const guide of GUIDES) {
    for (const match of read(guide).matchAll(/npm run ([a-z][a-z:-]*)/g)) {
      if (!pkg.scripts[match[1]]) missing.push(`${guide}: npm run ${match[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('every package linked from the guides resolves to a directory', () => {
  const missing = [];
  for (const guide of GUIDES) {
    for (const match of read(guide).matchAll(/\]\(\.\/(packages\/[a-z0-9-]+)\)/g)) {
      if (!existsSync(join(ROOT, match[1]))) missing.push(`${guide}: ${match[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('the guides describe the nine views the console actually ships', () => {
  const html = readFileSync(join(ROOT, 'packages/archon-app/public/index.html'), 'utf8');
  const viewIds = new Set([...html.matchAll(/switchView\('([a-z]+)'/g)].map((m) => m[1]));
  for (const view of ['workbench', 'seats', 'artifacts', 'skills', 'schedules', 'architect', 'mcps', 'hands', 'mesh']) {
    assert.ok(viewIds.has(view), `console is missing view: ${view}`);
  }
  for (const guide of ['docs/en/QUICKSTART.md', 'docs/zh-CN/QUICKSTART.md']) {
    assert.doesNotMatch(read(guide), /6-view|六大核心视图|6 大工作台/, `${guide} still advertises six views`);
  }
});