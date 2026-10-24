import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { validateBundle, signManifest, sha256, canonical, MANIFEST_VERSION } from './mesh-bundle.mjs';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pem = publicKey.export({ type: 'spki', format: 'pem' });
const ctx = { trustedKeys: { 'archon-a': pem } };
const blob = Buffer.from('<html>captured</html>');

function mk(over = {}, objOver = {}) {
  const manifest = {
    version: MANIFEST_VERSION, bundleId: 'b1', senderKey: 'archon-a', agreedScope: 'team:t1', graphVersion: 7,
    objects: [{ objectId: 'claim:aaaa1111', version: 1, scope: 'team:t1', snapshotHash: sha256(blob), truncated: false, payload: { p: 1 }, ...objOver }],
    ...over,
  };
  return { manifest, signature: signManifest(manifest, privateKey), blobs: { [sha256(blob)]: blob } };
}

test('valid bundle is accepted with origin in its own provenance field', () => {
  const r = validateBundle(mk(), ctx);
  assert.equal(r.ok, true);
  assert.equal(r.accepted.length, 1);
  assert.deepEqual(r.accepted[0].provenance, { originKey: 'archon-a', bundleId: 'b1', originObjectId: 'claim:aaaa1111', originGraphVersion: 7, asserted: 'peer' });
  assert.deepEqual(r.counts, { value: 1, of: 1, population: 'objects-in-manifest' });
});

test('control: a tampered manifest is refused by signature', () => {
  const b = mk();
  b.manifest.graphVersion = 8;
  assert.equal(validateBundle(b, ctx).refusal, 'signature-invalid');
});

test('untrusted sender key is refused by name', () => {
  assert.equal(validateBundle(mk(), { trustedKeys: {} }).refusal, 'sender-key-untrusted');
});

test('object outside the agreed scope rejects the whole bundle', () => {
  const r = validateBundle(mk({}, { scope: 'private' }), ctx);
  assert.equal(r.ok, false);
  assert.match(r.refusal, /^object-outside-agreed-scope:/);
  assert.deepEqual(r.accepted, []);
});

test('agreed scope private is not shareable', () => {
  assert.equal(validateBundle(mk({ agreedScope: 'private' }, { scope: 'private' }), ctx).refusal, 'agreed-scope-invalid');
});

test('blob whose bytes do not hash to the address is quarantined, not dropped', () => {
  const b = mk();
  b.blobs[sha256(blob)] = Buffer.from('other bytes');
  const r = validateBundle(b, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.accepted.length, 0);
  assert.deepEqual(r.quarantined, [{ objectId: 'claim:aaaa1111', reason: 'blob-hash-mismatch' }]);
});

test('missing blob is quarantined; an undefined field cannot be canonicalised for signing', () => {
  const b = mk();
  delete b.blobs[sha256(blob)];
  assert.equal(validateBundle(b, ctx).quarantined[0].reason, 'blob-missing');
  assert.throws(() => mk({}, { truncated: undefined }), /undefined is not signable/);
  assert.throws(() => canonical({ objectId: 'claim:aaaa1111', truncated: undefined }), /undefined is not signable/);
});

test('an absent snapshot hash must be an explicit null', () => {
  const r = validateBundle(mk({}, { snapshotHash: null }), ctx);
  assert.equal(r.accepted.length, 1);
  assert.equal(r.accepted[0].truncated, false);
});
