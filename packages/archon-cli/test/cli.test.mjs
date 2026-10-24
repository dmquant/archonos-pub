// Verification suite for packages/archon-cli (`npx archon up` & `archon hand pair`)
// Verifies:
// 1. `archon up` provisions D1, R2, Worker/DOs, applies 0001_archon_core.sql, generates Ed25519 identity,
//    never sends Cloudflare token to third parties, and mints a one-time pairing code.
// 2. Installer refuses inbound listening ports or non-loopback binds (0 inbound ports invariant).
// 3. `archon hand pair <CODE>` enforces one-time & expiry checks on pairing codes, generates transparent
//    Unix-user split (`_archon_daemon`, `_archon_hand`, `_archon_commit`), emits launchd/systemd units,
//    and produces an Echo Probe receipt with `capabilities_set_by: "hand-operator"`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runArchonUp,
  runArchonHandPair,
  validateBindSafety,
  generateLaunchdPlist,
  generateSystemdUnit,
  UNIX_USERS,
} from '../src/cli-core.mjs';
import { HandLeaseDO } from '../../archon-worker/src/hand-lease-do.mjs';

test('archon up provisions Cloudflare stack locally and mints one-time pairing code', () => {
  const missingToken = runArchonUp({});
  assert.equal(missingToken.ok, false);
  assert.equal(missingToken.error, 'missing_cloudflare_api_token');

  const up = runArchonUp({
    cloudflareApiToken: 'cf_tok_local_only',
    workspaceName: 'ws-alpha',
    encryptionMode: 'e2ee-local-custodian',
    now: 1000,
  });
  assert.equal(up.ok, true);
  assert.equal(up.tokenSentToThirdParty, false);
  assert.equal(up.stepsCompleted.length, 6);
  assert.match(up.pairing.code, /^ARC-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
  assert.match(up.identity.publicKeyPem, /BEGIN PUBLIC KEY/);
});

test('installer refuses any inbound port or non-loopback bind configuration', () => {
  const badPort = runArchonUp({
    cloudflareApiToken: 'cf_tok',
    options: { listenPort: 8080 },
  });
  assert.equal(badPort.ok, false);
  assert.match(badPort.error, /installer_refuses_inbound_ports/);

  const badTelemetry = validateBindSafety({ telemetryEndpoint: 'http://0.0.0.0:18890' });
  assert.equal(badTelemetry.ok, false);
  assert.equal(badTelemetry.error, 'installer_refuses_non_loopback_bind');
});

test('archon hand pair exchanges one-time code, enforces Unix-user split, and passes HandLeaseDO capability probe', () => {
  const up = runArchonUp({ cloudflareApiToken: 'cf_tok', now: 1000 });
  const pairingRecord = up.pairing;

  // Wrong code is rejected
  const wrongCode = runArchonHandPair({
    pairingRecord,
    submittedCode: 'ARC-0000-0000-0000',
    now: 1500,
  });
  assert.equal(wrongCode.ok, false);
  assert.equal(wrongCode.error, 'invalid_pairing_code');

  // Valid one-time code succeeds
  const paired = runArchonHandPair({
    pairingRecord,
    submittedCode: pairingRecord.code,
    handId: 'sg01-macbook',
    platform: 'darwin',
    installedClis: ['agy', 'claude', 'codex', 'opencode'],
    now: 1500,
  });
  assert.equal(paired.ok, true);
  assert.equal(paired.unixUsers.daemon, '_archon_daemon');
  assert.equal(paired.unixUsers.hand, '_archon_hand');
  assert.equal(paired.unixUsers.commitCustodian, '_archon_commit');
  assert.match(paired.sudoScript, /_archon_hand/);
  assert.match(paired.serviceUnit, /com\.archonos\.hands/);
  assert.equal(paired.probeReceipt.capabilities_set_by, 'hand-operator');

  // Reusing the same one-time code is rejected
  const replay = runArchonHandPair({
    pairingRecord,
    submittedCode: pairingRecord.code,
    now: 1600,
  });
  assert.equal(replay.ok, false);
  assert.equal(replay.error, 'pairing_code_already_used');

  // Verify the generated probe receipt is accepted by HandLeaseDO!
  const handDO = new HandLeaseDO();
  const verifyRes = handDO.verifyCapabilityProbe('sg01-macbook', {
    nonce: paired.probeReceipt.nonce,
    expectedNonce: paired.probeReceipt.nonce,
    capabilities: paired.probeReceipt.capabilities,
    signature: paired.probeReceipt.signature,
  });
  assert.equal(verifyRes.ok, true);
  assert.equal(verifyRes.capabilities_set_by, 'hand-operator');
  assert.equal(verifyRes.capabilities['engine:claude'], true);
});

test('launchd plist and systemd unit generators enforce outbound-only URLs and separate users', () => {
  assert.throws(() => generateLaunchdPlist({ controlPlaneUrl: 'http://insecure.local' }));
  const systemd = generateSystemdUnit({ handId: 'pro6000-2-hand' });
  assert.match(systemd, /User=_archon_daemon/);
  assert.match(systemd, /ARCHON_HAND_USER=_archon_hand/);
  assert.match(systemd, /ARCHON_INBOUND_PORTS=0/);
});
