import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceCanvas } from './revision-gate.mjs';
const scope = { workspaceId: 'synthetic-workspace', artifactId: 'synthetic-canvas' };
const event = (patch = {}) => ({ schemaVersion: 1, ...scope, streamId: 'epoch-a',
  sequence: 1, revision: 1, manifestSha256: 'a'.repeat(64), type: 'snapshot', ...patch });
const apply = (state, patch) => advanceCanvas(state, event(patch), scope);
test('complete publication advances once and late events cannot roll it back', () => {
  const initial = apply(null, {});
  const next = apply(initial, { type: 'published', sequence: 2, revision: 2, manifestSha256: 'b'.repeat(64) });
  assert.equal(next.revision, 2);
  assert.strictEqual(apply(next, { type: 'published', sequence: 2, revision: 2, manifestSha256: 'b'.repeat(64) }), next);
  assert.strictEqual(apply(next, { type: 'published' }), next);
  assert.strictEqual(apply(next, {}), next);
});
test('gap freezes the view until a complete snapshot; restart requires snapshot', () => {
  const initial = apply(null, {});
  const gap = apply(initial, { type: 'published', sequence: 3, revision: 3, manifestSha256: 'c'.repeat(64) });
  assert.equal(gap.needsSnapshot, true);
  assert.equal(gap.revision, 1);
  assert.equal(apply(gap, { type: 'published', sequence: 2, revision: 2, manifestSha256: 'b'.repeat(64) }).revision, 1);
  const recovered = apply(gap, { sequence: 3, revision: 3, manifestSha256: 'c'.repeat(64) });
  assert.equal(recovered.needsSnapshot, false);
  assert.equal(apply(recovered, { type: 'published', streamId: 'epoch-b', sequence: 4, revision: 3, manifestSha256: 'c'.repeat(64) }).needsSnapshot, true);
  assert.equal(apply(recovered, { streamId: 'epoch-b', sequence: 1, revision: 3, manifestSha256: 'c'.repeat(64) }).streamId, 'epoch-b');
  assert.equal(apply(null, { type: 'published' }), null);
});
test('scope, schema, invalid counters and immutable conflicts fail closed', () => {
  const state = apply(null, {});
  for (const patch of [{ workspaceId: 'other' }, { artifactId: 'other' }, { schemaVersion: 2 },
    { sequence: 1.5 }, { revision: 0 }, { manifestSha256: 'missing' }, { manifestSha256: 'b'.repeat(64) },
    { type: 'published', revision: 2, manifestSha256: 'b'.repeat(64) }])
    assert.throws(() => apply(state, patch), TypeError);
  assert.throws(() => apply({ ...state, workspaceId: 'other' }, {}), TypeError);
});
test('view metadata never copies credentials, arbitrary URLs or vendor bodies', () => {
  const state = apply(null, { secret: 'synthetic-secret', url: 'https://invalid.example', vendor: { body: 'synthetic-only' } });
  assert.deepEqual(Object.keys(state).sort(), ['workspaceId', 'artifactId', 'streamId', 'sequence', 'revision', 'manifestSha256', 'needsSnapshot'].sort());
});
