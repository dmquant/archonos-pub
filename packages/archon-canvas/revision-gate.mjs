// ARC-138 local experiment. Proposed downstream protocol, not a network adapter.
// Only complete immutable manifests advance a view. Gaps require a new snapshot.
function validate(event) {
  if (!event || event.schemaVersion !== 1 ||
      !['snapshot', 'published'].includes(event.type) ||
      !['workspaceId', 'artifactId', 'streamId'].every(key => typeof event[key] === 'string' && event[key].length > 0) ||
      !Number.isSafeInteger(event.sequence) || event.sequence < 1 ||
      !Number.isSafeInteger(event.revision) || event.revision < 1 ||
      !/^[a-f0-9]{64}$/.test(event.manifestSha256 || '')) {
    throw new TypeError('Invalid Canvas revision envelope');
  }
}
export function advanceCanvas(current, event, expected) {
  validate(event);
  if (event.workspaceId !== expected.workspaceId || event.artifactId !== expected.artifactId)
    throw new TypeError('Canvas scope mismatch');
  // Allowlist deliberately excludes arbitrary payloads, URLs and source bodies.
  const accept = () => ({
    workspaceId: event.workspaceId, artifactId: event.artifactId,
    streamId: event.streamId, sequence: event.sequence,
    revision: event.revision, manifestSha256: event.manifestSha256, needsSnapshot: false,
  });
  const recover = () => current ? { ...current, needsSnapshot: true } : null;
  if (!current) return event.type === 'snapshot' ? accept() : recover();
  if (current.workspaceId !== expected.workspaceId || current.artifactId !== expected.artifactId)
    throw new TypeError('Canvas state scope mismatch');
  if (event.revision < current.revision) return current;
  if (event.revision === current.revision && event.manifestSha256 !== current.manifestSha256)
    throw new TypeError('Conflicting immutable revision');
  if (event.type === 'snapshot') {
    if (event.streamId === current.streamId && event.sequence < current.sequence) return current;
    return accept();
  }
  if (event.streamId !== current.streamId || current.needsSnapshot) return recover();
  if (event.sequence <= current.sequence) {
    if (event.sequence === current.sequence && event.revision !== current.revision)
      throw new TypeError('Conflicting event sequence');
    return current;
  }
  if (event.sequence !== current.sequence + 1) return recover();
  return accept();
}
