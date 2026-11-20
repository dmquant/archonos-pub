// The workspace state file is the only durable copy of seats, sessions, memory
// and artifacts. It used to be written with writeFileSync directly over the
// target, so a crash mid-write left truncated JSON that the loader silently
// replaced with seed defaults.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeJsonAtomic } from '../src/dev-server.mjs';

test('atomic state write replaces the file without leaving temp artifacts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'archon-state-'));
  const file = join(dir, 'workspace-state.json');
  try {
    writeJsonAtomic(file, { revision: 1, seats: ['chief-of-staff'] });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { revision: 1, seats: ['chief-of-staff'] });

    writeJsonAtomic(file, { revision: 2, seats: [] });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { revision: 2, seats: [] });

    assert.deepEqual(
      readdirSync(dir),
      ['workspace-state.json'],
      'no partial file survives a successful write'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed serialization leaves the previous state intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'archon-state-'));
  const file = join(dir, 'workspace-state.json');
  try {
    writeJsonAtomic(file, { revision: 7 });
    const circular = { revision: 8 };
    circular.self = circular;
    assert.throws(() => writeJsonAtomic(file, circular), /circular/i);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { revision: 7 });
    assert.deepEqual(readdirSync(dir), ['workspace-state.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('replacing state keeps its contents private', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'archon-state-'));
  const file = join(dir, 'workspace-state.json');
  try {
    writeJsonAtomic(file, { revision: 1 });
    writeJsonAtomic(file, { revision: 2 });
    assert.equal(statSync(file).mode & 0o077, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed rename removes the temporary state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'archon-state-'));
  const file = join(dir, 'workspace-state.json');
  try {
    mkdirSync(file);
    assert.throws(() => writeJsonAtomic(file, { revision: 1 }));
    assert.ok(statSync(file).isDirectory());
    assert.deepEqual(readdirSync(dir), ['workspace-state.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
