// Archon Mesh signed-bundle and provenance import validator (prototype, ARC-141).
// Pure functions over a bundle the caller already holds. No I/O, no store writes:
// the result is a verdict per object (accept | quarantine) and the caller proposes
// the accepted ones through its own commit path. Ed25519 via node:crypto only.
import { createHash, createPublicKey, sign, verify } from 'node:crypto';

export const MANIFEST_VERSION = 'archon.mesh.bundle/1';
const SCOPE_RE = /^(private|team:[^\s:]+|link:[^\s:]+)$/;

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Canonical JSON: sorted keys, no whitespace. Refuses undefined so an absent
// field cannot be signed as if it were present.
export function canonical(v) {
  if (v === undefined) throw new Error('canonical: undefined is not signable');
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

export function signManifest(manifest, privateKey) {
  return sign(null, Buffer.from(canonical(manifest)), privateKey).toString('base64');
}

function verifySig(manifest, sigB64, publicKeyPem) {
  try {
    return verify(null, Buffer.from(canonical(manifest)), createPublicKey(publicKeyPem), Buffer.from(sigB64, 'base64'));
  } catch {
    return false;
  }
}

// bundle: { manifest, signature, blobs: { <sha256>: Buffer } }
// manifest: { version, bundleId, senderKey, agreedScope, graphVersion,
//   objects: [{ objectId, version, scope, snapshotHash|null, truncated, payload }] }
// ctx: { trustedKeys: { <senderKey>: publicKeyPem }, nowScopes: [scopes this receiver agreed] }
// Whole-bundle refusals return { ok:false, refusal, objects:[] }; per-object
// failures are quarantined with a named reason and never dropped silently.
export function validateBundle(bundle, ctx) {
  const refuse = (refusal) => ({ ok: false, refusal, accepted: [], quarantined: [], counts: null });
  const m = bundle && bundle.manifest;
  if (!m || typeof m !== 'object') return refuse('manifest-missing');
  if (m.version !== MANIFEST_VERSION) return refuse('manifest-version-unsupported');
  for (const f of ['bundleId', 'senderKey', 'agreedScope', 'graphVersion', 'objects']) {
    if (m[f] === undefined || m[f] === null) return refuse('manifest-field-missing:' + f);
  }
  if (!Array.isArray(m.objects)) return refuse('manifest-objects-not-a-list');
  if (!SCOPE_RE.test(m.agreedScope) || m.agreedScope === 'private') return refuse('agreed-scope-invalid');
  const pub = ctx.trustedKeys && ctx.trustedKeys[m.senderKey];
  if (!pub) return refuse('sender-key-untrusted');
  if (typeof bundle.signature !== 'string' || !verifySig(m, bundle.signature, pub)) return refuse('signature-invalid');
  // The sender filters before signing; a bundle holding anything outside the
  // agreed scope is rejected whole, because the receiver cannot filter for it.
  for (const o of m.objects) {
    if (!SCOPE_RE.test(String(o.scope))) return refuse('object-scope-invalid:' + o.objectId);
    if (o.scope !== m.agreedScope) return refuse('object-outside-agreed-scope:' + o.objectId);
  }
  const accepted = [];
  const quarantined = [];
  const q = (o, reason) => quarantined.push({ objectId: o.objectId, reason });
  for (const o of m.objects) {
    if (typeof o.truncated !== 'boolean') { q(o, 'truncated-flag-missing'); continue; }
    if (o.snapshotHash) {
      const blob = bundle.blobs && bundle.blobs[o.snapshotHash];
      if (!blob) { q(o, 'blob-missing'); continue; }
      if (sha256(blob) !== o.snapshotHash) { q(o, 'blob-hash-mismatch'); continue; }
    } else if (o.snapshotHash !== null) {
      q(o, 'snapshot-hash-absent-not-null'); continue;
    }
    accepted.push({
      objectId: o.objectId,
      version: o.version,
      payload: o.payload,
      truncated: o.truncated,
      // origin lives in its own field and never overwrites local vocabulary
      provenance: { originKey: m.senderKey, bundleId: m.bundleId, originObjectId: o.objectId, originGraphVersion: m.graphVersion, asserted: 'peer' },
    });
  }
  return { ok: true, refusal: null, accepted, quarantined, counts: { value: accepted.length, of: m.objects.length, population: 'objects-in-manifest' } };
}
