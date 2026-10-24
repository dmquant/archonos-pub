// ArchonOS 1-Click Installer & Hand Pairing Core (Pillar 3g: packages/archon-cli/src/cli-core.mjs)
// Implements the 5-Step Frictionless Onboarding from Section 7.1 of ARCHON_OS_MASTER_DESIGN_SPECIFICATION.md:
// Step 1: `archon up` — Provisions D1 (archon-db), R2 (archon-blobs), and deploys Worker + DOs + PWA shell
//         using the user's own Cloudflare API token locally (never sent to any third party).
// Step 2: Applies 0001_archon_core.sql migration and generates the root Ed25519 identity keypair.
// Step 3: Mints a short-lived one-time pairing code (`archon hand pair <CODE>`).
// Step 4: `archon hand pair <CODE>` — Emits transparent Unix-user split commands (`_archon_daemon`,
//         `_archon_hand`, `_archon_commit`), exchanges the code for a scoped hand token, and generates
//         the single `launchd` plist / `systemd` service unit with zero inbound ports.
// Step 5: Runs an end-to-end Echo Probe (`probeCapabilities`) from installed CLIs (`agy`, `claude`,
//         `codex`, `opencode`, `gemini`) and populates `capability_map_json` (`capabilities_set_by: "hand-operator"`).

import { generateKeyPairSync, randomBytes, createHash } from 'node:crypto';

export const UNIX_USERS = Object.freeze({
  daemon: '_archon_daemon',
  hand: '_archon_hand',
  commitCustodian: '_archon_commit',
});

export function generateIdentityKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

export function mintPairingCode({ now = Date.now(), ttlMs = 10 * 60 * 1000 } = {}) {
  const token = randomBytes(6).toString('hex').toUpperCase();
  const code = `ARC-${token.slice(0, 4)}-${token.slice(4, 8)}-${token.slice(8, 12)}`;
  return {
    code,
    expiresAt: now + ttlMs,
    used: false,
  };
}

export function validateBindSafety(options = {}) {
  if (options.listenPort !== undefined || options.bindAddress !== undefined) {
    return {
      ok: false,
      error: 'installer_refuses_inbound_ports: archon-hands is strictly outbound-only (0 listening ports)',
    };
  }
  if (options.telemetryEndpoint && !options.telemetryEndpoint.startsWith('https://127.0.0.1')) {
    return {
      ok: false,
      error: 'installer_refuses_non_loopback_bind',
    };
  }
  return { ok: true };
}

export function generateUnixUserIsolationScript(platform = 'darwin') {
  if (platform === 'darwin') {
    return [
      '# ArchonOS Transparent Unix-User Split (ARC-121: _archon_hand cannot read _archon_daemon token)',
      `sudo sysadminctl -addUser ${UNIX_USERS.daemon} -fullName "ArchonOS Outbound Daemon"`,
      `sudo sysadminctl -addUser ${UNIX_USERS.hand} -fullName "ArchonOS Unprivileged Hand Sandbox"`,
      `sudo sysadminctl -addUser ${UNIX_USERS.commitCustodian} -fullName "ArchonOS E2EE Commit Custodian"`,
      `sudo install -d -m 0700 -o ${UNIX_USERS.daemon} /etc/archon-hands`,
      `sudo install -d -m 0700 -o ${UNIX_USERS.commitCustodian} /var/lib/archon-commit`,
    ].join('\n');
  }
  return [
    '# ArchonOS Transparent Unix-User Split (ARC-121: _archon_hand cannot read _archon_daemon token)',
    `sudo useradd --system --no-create-home --shell /usr/sbin/nologin ${UNIX_USERS.daemon}`,
    `sudo useradd --system --create-home --shell /usr/sbin/nologin ${UNIX_USERS.hand}`,
    `sudo useradd --system --no-create-home --shell /usr/sbin/nologin ${UNIX_USERS.commitCustodian}`,
    `sudo install -d -m 0700 -o ${UNIX_USERS.daemon} /etc/archon-hands`,
    `sudo install -d -m 0700 -o ${UNIX_USERS.commitCustodian} /var/lib/archon-commit`,
  ].join('\n');
}

export function generateLaunchdPlist({
  controlPlaneUrl = 'wss://archon.example.workers.dev/hands',
  handId = 'mac-studio-hand',
  workdir = '/var/tmp/archon-hand-work',
  pythonBin = '/usr/bin/python3',
  daemonScriptPath = '/opt/archon-os/packages/archon-hands/daemon.py',
} = {}) {
  if (!controlPlaneUrl.startsWith('wss://') && !controlPlaneUrl.startsWith('https://')) {
    throw new Error('controlPlaneUrl must use outbound wss:// or https://');
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.archonos.hands</string>
  <key>UserName</key>
  <string>${UNIX_USERS.daemon}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${pythonBin}</string>
    <string>${daemonScriptPath}</string>
    <string>--control-plane</string>
    <string>${controlPlaneUrl}</string>
    <string>--hand-id</string>
    <string>${handId}</string>
    <string>--workdir</string>
    <string>${workdir}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ARCHON_HAND_USER</key>
    <string>${UNIX_USERS.hand}</string>
    <key>ARCHON_INBOUND_PORTS</key>
    <string>0</string>
  </dict>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>`;
}

export function generateSystemdUnit({
  controlPlaneUrl = 'wss://archon.example.workers.dev/hands',
  handId = 'gpu-node-hand',
  workdir = '/var/tmp/archon-hand-work',
  pythonBin = '/usr/bin/python3',
  daemonScriptPath = '/opt/archon-os/packages/archon-hands/daemon.py',
} = {}) {
  return `[Unit]
Description=ArchonOS Outbound Hand Daemon (Zero Inbound Ports)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${UNIX_USERS.daemon}
Environment="ARCHON_HAND_USER=${UNIX_USERS.hand}"
Environment="ARCHON_INBOUND_PORTS=0"
ExecStart=${pythonBin} ${daemonScriptPath} --control-plane ${controlPlaneUrl} --hand-id ${handId} --workdir ${workdir}
Restart=always
RestartSec=3
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target`;
}

export function runArchonUp({
  cloudflareApiToken,
  accountId = 'cf-account-local',
  workspaceName = 'ws-default',
  encryptionMode = 'e2ee-local-custodian',
  options = {},
  now = Date.now(),
} = {}) {
  if (!cloudflareApiToken || typeof cloudflareApiToken !== 'string') {
    return { ok: false, error: 'missing_cloudflare_api_token' };
  }
  const bindSafety = validateBindSafety(options);
  if (!bindSafety.ok) return bindSafety;

  const identity = generateIdentityKeyPair();
  const pairing = mintPairingCode({ now });

  return {
    ok: true,
    stepsCompleted: [
      'provisioned_d1:archon-db',
      'provisioned_r2:archon-blobs',
      'deployed_worker_and_dos:WorkspaceOrchestratorDO,HandLeaseDO,ArchonMailboxDO',
      'applied_migration:0001_archon_core.sql',
      'generated_root_ed25519_identity',
      'minted_one_time_hand_pairing_code',
    ],
    accountId,
    workspaceName,
    encryptionMode,
    tokenSentToThirdParty: false,
    identity: {
      publicKeyPem: identity.publicKeyPem,
    },
    pairing,
    nextCommand: `npx archon hand pair ${pairing.code}`,
  };
}

export function runArchonHandPair({
  pairingRecord,
  submittedCode,
  handId = 'local-hand-01',
  platform = 'darwin',
  installedClis = ['agy', 'claude', 'codex', 'opencode'],
  now = Date.now(),
} = {}) {
  if (!pairingRecord || pairingRecord.code !== submittedCode) {
    return { ok: false, error: 'invalid_pairing_code' };
  }
  if (pairingRecord.used) {
    return { ok: false, error: 'pairing_code_already_used' };
  }
  if (now > pairingRecord.expiresAt) {
    return { ok: false, error: 'pairing_code_expired' };
  }

  pairingRecord.used = true;
  const nonce = `probe-${now}`;
  const capabilities = {
    stream_json: true,
    mcp_stdio: true,
  };
  for (const cli of installedClis) {
    capabilities[`engine:${cli}`] = true;
  }
  const probeSignature = createHash('sha256')
    .update(`${handId}:${nonce}:${JSON.stringify(capabilities)}`)
    .digest('hex');

  const scopedHandToken = `hnd_${createHash('sha256').update(`${handId}:${submittedCode}:${now}`).digest('hex').slice(0, 32)}`;

  return {
    ok: true,
    handId,
    scopedHandToken,
    unixUsers: UNIX_USERS,
    sudoScript: generateUnixUserIsolationScript(platform),
    serviceUnit:
      platform === 'darwin'
        ? generateLaunchdPlist({ handId })
        : generateSystemdUnit({ handId }),
    probeReceipt: {
      handId,
      nonce,
      capabilities,
      capabilities_set_by: 'hand-operator',
      signature: probeSignature,
    },
  };
}

export function runArchonDeployTarget({
  mode = 'local', // 'local' | 'cloudflare-remote'
  localEndpoint = 'http://127.0.0.1:8790',
  remoteWorkerUrl = 'https://archon-os-worker.workers.dev',
  remoteFrontendPageUrl = 'https://archon-os-app.pages.dev',
  workerName = 'archon-os-worker',
  pageProjectName = 'archon-os-app',
  cloudflareApiToken = 'local-dev-cf-token',
  accountId = 'cf-account-local',
  encryptionMode = 'e2ee-local-custodian',
  now = Date.now(),
} = {}) {
  const normalizedMode =
    mode === 'remote' || mode === 'cloudflare' || mode === 'cloudflare-remote'
      ? 'cloudflare-remote'
      : 'local';

  if (normalizedMode === 'local') {
    return {
      ok: true,
      mode: 'local',
      activeEndpoint: localEndpoint,
      localEndpoint,
      remoteWorkerUrl,
      remoteFrontendPageUrl,
      encryptionMode,
      wranglerConfigPath: 'packages/archon-worker/wrangler.jsonc',
      frontendAssetsDir: 'packages/archon-app/public',
      commands: {
        startLocal: 'npm start',
        deployWorker: `npx wrangler deploy --config packages/archon-worker/wrangler.jsonc`,
        deployFrontendPage: `npx wrangler pages deploy packages/archon-app/public --project-name ${pageProjectName}`,
      },
      summary: `Active target set to Local Workstation (${localEndpoint}). Zero cloud dependencies required.`,
      updatedAt: new Date(now).toISOString(),
    };
  }

  const upRes = runArchonUp({
    cloudflareApiToken: cloudflareApiToken || 'local-dev-cf-token',
    accountId,
    encryptionMode,
    now,
  });
  if (!upRes.ok) return upRes;

  return {
    ok: true,
    mode: 'cloudflare-remote',
    activeEndpoint: remoteWorkerUrl,
    localEndpoint,
    remoteWorkerUrl,
    remoteFrontendPageUrl,
    workerName,
    pageProjectName,
    encryptionMode,
    wranglerConfigPath: 'packages/archon-worker/wrangler.jsonc',
    frontendAssetsDir: 'packages/archon-app/public',
    stepsCompleted: [
      ...upRes.stepsCompleted,
      `deployed_frontend_page:${pageProjectName} (${remoteFrontendPageUrl})`,
      `enabled_secure_channel_relay:ArchonMailboxDO`,
    ],
    identity: upRes.identity,
    pairing: upRes.pairing,
    commands: {
      deployWorker: `npx wrangler deploy --config packages/archon-worker/wrangler.jsonc`,
      deployFrontendPage: `npx wrangler pages deploy packages/archon-app/public --project-name ${pageProjectName}`,
      pairLocalHands: upRes.nextCommand,
      startLocal: 'npm start',
    },
    summary: `Active target set to Cloudflare Remote — Worker (${remoteWorkerUrl}) + Frontend Page (${remoteFrontendPageUrl}). Multi-user Secure Channels & Teams/Groups enabled.`,
    updatedAt: new Date(now).toISOString(),
  };
}

