// Verification suite for `archon doctor` / `archon status` / `archon hands probe`.
// Every check runs against a temporary workspace fixture, so the suite never
// reads, writes or probes the operator's real .archon state or host PATH.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  collectDiagnostics,
  findExecutableOnPath,
  formatDiagnostics,
  formatHandsProbe,
  formatStatus,
  probeLocalServer,
  scanPlaintextSecrets,
  DOCTOR_SCHEMA,
} from '../src/doctor.mjs';

const BIN = fileURLToPath(new URL('../bin/archon.mjs', import.meta.url));
const ALL_CHECK_IDS = [
  'node-runtime',
  'workspace-dir',
  'workspace-state',
  'workspace-config',
  'plaintext-secrets',
  'gitignore-coverage',
  'seat-integrity',
  'server',
  'hands',
  'safe-mode',
  'state-permissions',
];

const HEALTHY_CONFIG = {
  schemaVersion: 'archon.config.v1',
  workspaceName: 'ws-doctor-fixture',
  server: { host: '127.0.0.1', port: 8790 },
  hands: {
    claude: { engine: 'claude', enabled: true, binaryPath: 'auto' },
    codex: { engine: 'codex', enabled: true, binaryPath: 'auto' },
  },
  mcpServers: [],
};

const HEALTHY_STATE = {
  seats: [
    { id: 'chief-of-staff', hand: 'claude', enabled: true },
    { id: 'seat-archon', hand: 'codex', enabled: true },
  ],
  chatSessions: [{ id: 's1' }],
  artifacts: [],
};

function fixture({
  config = HEALTHY_CONFIG,
  state = HEALTHY_STATE,
  userConfig = null,
  gitignore = '.archon/\n.env\noutputs/\n',
  skipGitignore = false,
  handsOnPath = ['claude', 'codex'],
  stateMode = 0o700,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'archon-doctor-'));
  const stateDir = join(root, '.archon');
  const binDir = join(root, 'bin');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'config', 'archon.defaults.json'), JSON.stringify(config, null, 2));
  if (state !== null) writeFileSync(join(stateDir, 'workspace-state.json'), JSON.stringify(state, null, 2));
  if (userConfig) writeFileSync(join(stateDir, 'config.json'), JSON.stringify(userConfig, null, 2));
  if (!skipGitignore) writeFileSync(join(root, '.gitignore'), gitignore);
  for (const engine of handsOnPath) writeFileSync(join(binDir, engine), '#!/bin/sh\n');
  chmodSync(stateDir, stateMode);
  return { root, stateDir, binDir, env: { PATH: binDir } };
}

const runningProbe = async () => ({ state: 'running', status: 200 });

async function diagnose(fx, options = {}) {
  return collectDiagnostics({
    repoRoot: fx.root,
    stateDir: fx.stateDir,
    env: fx.env,
    nodeVersion: '22.11.0',
    platformName: 'linux',
    probeServer: runningProbe,
    ...options,
  });
}

const byId = (report, id) => report.checks.find((c) => c.id === id);

test('a healthy workspace passes every check and reports a stable schema', async () => {
  const fx = fixture();
  try {
    const report = await diagnose(fx);
    assert.equal(report.schema, DOCTOR_SCHEMA);
    assert.equal(report.ok, true);
    assert.equal(report.status, 'pass');
    assert.equal(report.counts.fail, 0);
    assert.equal(report.counts.warn, 0);
    assert.equal(report.total, ALL_CHECK_IDS.length);
    assert.deepEqual(report.checks.map((c) => c.id), ALL_CHECK_IDS);
    for (const item of report.checks) {
      assert.ok(['pass', 'warn', 'fail', 'info'].includes(item.status), item.id);
      assert.ok(item.summary.length > 0, `${item.id} needs a summary`);
    }
    assert.equal(byId(report, 'server').status, 'pass');
    assert.equal(byId(report, 'hands').status, 'pass');
    assert.equal(byId(report, 'plaintext-secrets').status, 'pass');
    assert.equal(report.workspace.seats, 2);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('a stopped console is informational, not a failure; a foreign listener warns', async () => {
  const fx = fixture();
  try {
    const stopped = await diagnose(fx, { probeServer: async () => ({ state: 'stopped' }) });
    assert.equal(byId(stopped, 'server').status, 'info');
    assert.equal(stopped.ok, true);
    assert.match(byId(stopped, 'server').summary, /not running/);
    assert.ok(stopped.fixes.includes('npm start'));

    const foreign = await diagnose(fx, { probeServer: async () => ({ state: 'foreign', status: 200 }) });
    assert.equal(byId(foreign, 'server').status, 'warn');
    assert.match(byId(foreign, 'server').summary, /not with an ArchonOS health payload/);
    assert.equal(foreign.ok, true);

    const broken = await diagnose(fx, { probeServer: async () => ({ state: 'unknown', detail: 'boom' }) });
    assert.equal(byId(broken, 'server').status, 'warn');
    assert.match(byId(broken, 'server').summary, /boom/);

    // A throwing probe must degrade to a warning, never crash the whole doctor.
    const throwing = await diagnose(fx, {
      probeServer: async () => {
        throw new Error('probe exploded');
      },
    });
    assert.equal(byId(throwing, 'server').status, 'warn');
    assert.match(byId(throwing, 'server').summary, /probe exploded/);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('the live probe identifies the local service without following redirects', async () => {
  let body = { ok: true, service: 'archon-os-worker' };
  let redirect = false;
  let redirectsFollowed = 0;
  const server = createServer((req, res) => {
    if (req.url === '/redirected') {
      redirectsFollowed += 1;
    } else if (redirect) {
      res.writeHead(302, { location: '/redirected' });
    }
    res.end(JSON.stringify(body));
  });
  server.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const { port } = server.address();
    assert.equal((await probeLocalServer({ port })).state, 'running');
    body = { ok: true };
    assert.equal((await probeLocalServer({ port })).state, 'foreign');
    redirect = true;
    assert.equal((await probeLocalServer({ port })).state, 'foreign');
    assert.equal(redirectsFollowed, 0);
  } finally {
    server.close();
  }
});

test('literal credentials fail the security gate while secret:// handles pass', async () => {
  const leaky = fixture({
    userConfig: {
      ...HEALTHY_CONFIG,
      mcpServers: [{ id: 'remote', auth_ref: 'secret://mcp/remote' }],
      hands: { ...HEALTHY_CONFIG.hands, claude: { ...HEALTHY_CONFIG.hands.claude, apiKey: 'sk-live-supersecret-123456' } },
    },
  });
  try {
    const report = await diagnose(leaky);
    const check = byId(report, 'plaintext-secrets');
    assert.equal(check.status, 'fail');
    assert.equal(report.ok, false);
    assert.equal(check.findings.length, 1);
    assert.equal(check.findings[0].path, '$.hands.claude.apiKey');
    // The report must locate the secret without disclosing it.
    assert.doesNotMatch(JSON.stringify(report), /supersecret/);
    assert.equal(check.findings[0].preview, '***');
    assert.match(check.fix, /secret:\/\//);
  } finally {
    rmSync(leaky.root, { recursive: true, force: true });
  }

  const clean = fixture({
    userConfig: {
      ...HEALTHY_CONFIG,
      mcpServers: [{ id: 'remote', auth_ref: 'secret://mcp/remote' }],
    },
  });
  try {
    const report = await diagnose(clean);
    assert.equal(byId(report, 'plaintext-secrets').status, 'pass');
    assert.equal(report.ok, true);
  } finally {
    rmSync(clean.root, { recursive: true, force: true });
  }
});

test('scanner is key-based and depth-bounded, so prose is never mistaken for a secret', () => {
  const findings = scanPlaintextSecrets(
    {
      chatHistory: [{ text: 'my token is hunter2', tokenBudget: 100 }],
      nested: { deep: { authorization: 'Bearer abc123' } },
      env: '${ARCHON_TOKEN}',
      note: '<your-key-here>',
    },
    '/tmp/state.json',
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].path, '$.nested.deep.authorization');
  assert.equal(findings[0].preview, '***');
});

test('config must stay loopback-only with a valid port', async () => {
  for (const [server, pattern] of [
    [{ host: '0.0.0.0', port: 8790 }, /loopback/],
    [{ host: '127.0.0.1', port: 70000 }, /1\.\.65535/],
    [{ host: '127.0.0.1', port: '8790' }, /1\.\.65535/],
  ]) {
    const fx = fixture({ config: { ...HEALTHY_CONFIG, server } });
    try {
      let probes = 0;
      const report = await diagnose(fx, {
        probeServer: async () => {
          probes += 1;
          return runningProbe();
        },
      });
      assert.equal(probes, 0);
      const check = byId(report, 'workspace-config');
      assert.equal(check.status, 'fail', JSON.stringify(server));
      assert.match(check.summary, pattern);
      assert.equal(report.ok, false);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  }

  const fx = fixture({ config: { ...HEALTHY_CONFIG, server: { host: 'localhost', port: 8791 } } });
  try {
    const report = await diagnose(fx);
    assert.equal(byId(report, 'workspace-config').status, 'pass');
    assert.equal(report.server.port, 8791);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('an uninitialized workspace is a warning with a fix hint, while corrupt state is a failure', async () => {
  const empty = fixture({ state: null });
  try {
    const report = await diagnose(empty);
    assert.equal(byId(report, 'workspace-state').status, 'warn');
    assert.equal(report.ok, true);
    assert.ok(report.fixes.includes('npm run init'));
    assert.equal(byId(report, 'seat-integrity').status, 'info');
  } finally {
    rmSync(empty.root, { recursive: true, force: true });
  }

  const corrupt = fixture({ state: null });
  try {
    writeFileSync(join(corrupt.stateDir, 'workspace-state.json'), '{ not json');
    const report = await diagnose(corrupt);
    const check = byId(report, 'workspace-state');
    assert.equal(check.status, 'fail');
    assert.match(check.summary, /invalid JSON/);
    assert.equal(report.ok, false);
  } finally {
    rmSync(corrupt.root, { recursive: true, force: true });
  }

  const noSeats = fixture({ state: { chatSessions: [] } });
  try {
    const report = await diagnose(noSeats);
    assert.equal(byId(report, 'workspace-state').status, 'fail');
    assert.match(byId(report, 'workspace-state').summary, /seats/);
  } finally {
    rmSync(noSeats.root, { recursive: true, force: true });
  }
});

test('seat integrity enforces the mandatory Chief of Staff and unique ids', async () => {
  const noChief = fixture({
    state: { seats: [{ id: 'seat-archon', hand: 'claude' }], chatSessions: [], artifacts: [] },
  });
  try {
    const report = await diagnose(noChief);
    assert.equal(byId(report, 'seat-integrity').status, 'fail');
    assert.match(byId(report, 'seat-integrity').summary, /chief-of-staff seat is missing/);
  } finally {
    rmSync(noChief.root, { recursive: true, force: true });
  }

  const duplicate = fixture({
    state: {
      seats: [
        { id: 'chief-of-staff', hand: 'claude' },
        { id: 'chief-of-staff', hand: 'codex' },
      ],
    },
  });
  try {
    const report = await diagnose(duplicate);
    assert.equal(byId(report, 'seat-integrity').status, 'fail');
    assert.match(byId(report, 'seat-integrity').summary, /duplicate seat ids/);
  } finally {
    rmSync(duplicate.root, { recursive: true, force: true });
  }

  const unknownHand = fixture({
    state: { seats: [{ id: 'chief-of-staff', hand: 'gpt5-ultra' }] },
  });
  try {
    const report = await diagnose(unknownHand);
    assert.equal(byId(report, 'seat-integrity').status, 'warn');
    assert.match(byId(report, 'seat-integrity').summary, /gpt5-ultra/);
  } finally {
    rmSync(unknownHand.root, { recursive: true, force: true });
  }
});

test('private state must be git-ignored, and a missing .gitignore is a failure', async () => {
  const leakyGit = fixture({ gitignore: 'node_modules/\noutputs/\n' });
  try {
    const report = await diagnose(leakyGit);
    const check = byId(report, 'gitignore-coverage');
    assert.equal(check.status, 'warn');
    assert.match(check.summary, /\.archon\//);
  } finally {
    rmSync(leakyGit.root, { recursive: true, force: true });
  }

  const noGitignore = fixture({ skipGitignore: true });
  try {
    const report = await diagnose(noGitignore);
    assert.equal(byId(report, 'gitignore-coverage').status, 'fail');
    assert.equal(report.ok, false);
  } finally {
    rmSync(noGitignore.root, { recursive: true, force: true });
  }
});

test('hand inventory distinguishes installed, enabled-but-missing and none at all', async () => {
  const partial = fixture({ handsOnPath: ['claude'] });
  try {
    const report = await diagnose(partial);
    const check = byId(report, 'hands');
    assert.equal(check.status, 'warn');
    assert.match(check.summary, /claude installed/);
    assert.match(check.summary, /enabled but missing: codex/);
  } finally {
    rmSync(partial.root, { recursive: true, force: true });
  }

  const none = fixture({ handsOnPath: [] });
  try {
    const report = await diagnose(none);
    assert.equal(byId(report, 'hands').status, 'fail');
    assert.equal(report.ok, false);
  } finally {
    rmSync(none.root, { recursive: true, force: true });
  }

  // An explicit binaryPath wins over PATH, as long as the file exists.
  const explicit = fixture({ handsOnPath: [] });
  try {
    const custom = join(explicit.root, 'custom-claude');
    writeFileSync(custom, '#!/bin/sh\n');
    writeFileSync(
      join(explicit.stateDir, 'workspace-state.json'),
      JSON.stringify(HEALTHY_STATE),
    );
    writeFileSync(
      join(explicit.stateDir, 'config.json'),
      JSON.stringify({
        workspaceName: 'explicit',
        server: { host: '127.0.0.1', port: 8790 },
        hands: {
          claude: { engine: 'claude', enabled: true, binaryPath: custom },
          codex: { engine: 'codex', enabled: false, binaryPath: 'auto' },
        },
      }),
    );
    const report = await diagnose(explicit);
    assert.equal(byId(report, 'hands').status, 'pass');
  } finally {
    rmSync(explicit.root, { recursive: true, force: true });
  }
});

test('findExecutableOnPath ignores directories and unknown PATH segments', () => {
  const fx = fixture({ handsOnPath: ['claude'] });
  try {
    mkdirSync(join(fx.binDir, 'codex'));
    assert.equal(findExecutableOnPath('claude', fx.env.PATH), join(fx.binDir, 'claude'));
    assert.equal(findExecutableOnPath('codex', fx.env.PATH), null);
    assert.equal(findExecutableOnPath('claude', ''), null);
    assert.equal(findExecutableOnPath('claude', undefined), null);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('active safe mode and world-readable state are surfaced as warnings', async () => {
  const fx = fixture({ stateMode: 0o755 });
  try {
    writeFileSync(join(fx.stateDir, 'safe-mode.json'), JSON.stringify({ enabled: true }));
    const report = await diagnose(fx);
    const safeMode = byId(report, 'safe-mode');
    assert.equal(safeMode.status, 'warn');
    assert.match(safeMode.summary, /ACTIVE/);
    assert.ok(report.fixes.includes('npm run safe:unlock'));

    const permissions = byId(report, 'state-permissions');
    assert.equal(permissions.status, 'warn');
    assert.match(permissions.summary, /755/);
    assert.equal(report.ok, true);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }

  const healthy = fixture();
  try {
    const report = await diagnose(healthy);
    assert.equal(byId(report, 'safe-mode').status, 'pass');
    assert.equal(byId(report, 'state-permissions').status, 'pass');
  } finally {
    rmSync(healthy.root, { recursive: true, force: true });
  }
});

test('unsupported Node majors fail the runtime gate', async () => {
  const fx = fixture();
  try {
    const report = await diagnose(fx, { nodeVersion: '18.20.4' });
    assert.equal(byId(report, 'node-runtime').status, 'fail');
    assert.equal(report.ok, false);
    assert.match(byId(report, 'node-runtime').fix, /Node 20/);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('formatters render every check and keep the summary line accurate', async () => {
  const fx = fixture({ handsOnPath: ['claude'] });
  try {
    const report = await diagnose(fx);
    const text = formatDiagnostics(report, { version: '9.9.9' });
    assert.match(text, /ArchonOS doctor v9\.9\.9/);
    for (const item of report.checks) assert.match(text, new RegExp(item.title));
    assert.match(text, new RegExp(`${report.total} checks`));
    assert.match(text, /1 warn · 0 fail/);
    assert.match(text, /fix: /);

    const status = formatStatus(report, { version: '9.9.9' });
    assert.match(status, /ws-doctor-fixture/);
    assert.match(status, /running at http:\/\/127\.0\.0\.1:8790/);
    assert.match(status, /hands/);

    assert.match(formatHandsProbe(report), /CLI hands — WARN/);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('the CLI exits 0 on a clean install, 1 on a failure, and keeps --json pure', () => {
  const clean = fixture();
  try {
    const state = JSON.parse(readFileSync(join(clean.stateDir, 'workspace-state.json'), 'utf8'));
    assert.equal(state.seats.length, 2);
    const res = spawnSync(process.execPath, [BIN, 'doctor', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: clean.binDir, ARCHON_STATE_DIR: clean.stateDir },
      timeout: 20000,
    });
    assert.equal(res.status, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.version, JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version);
    assert.equal(payload.schema, DOCTOR_SCHEMA);
    assert.equal(payload.ok, true);
    assert.ok(payload.checks.length >= 10);
  } finally {
    rmSync(clean.root, { recursive: true, force: true });
  }

  const broken = fixture();
  try {
    writeFileSync(
      join(broken.stateDir, 'config.json'),
      JSON.stringify({ server: { host: '0.0.0.0', port: 8790 } }),
    );
    const res = spawnSync(process.execPath, [BIN, 'doctor', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, ARCHON_STATE_DIR: broken.stateDir },
      timeout: 20000,
    });
    assert.equal(res.status, 1, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.ok, false);
    assert.ok(payload.counts.fail >= 1);

    const human = spawnSync(process.execPath, [BIN, 'doctor'], {
      encoding: 'utf8',
      env: { ...process.env, ARCHON_STATE_DIR: broken.stateDir },
      timeout: 20000,
    });
    assert.equal(human.status, 1);
    assert.match(human.stdout, /FAIL/);
    assert.match(human.stdout, /checks ·/);

    const status = spawnSync(process.execPath, [BIN, 'status'], {
      encoding: 'utf8',
      env: { ...process.env, ARCHON_STATE_DIR: broken.stateDir },
      timeout: 20000,
    });
    assert.equal(status.status, 1);
    assert.match(status.stdout, /ArchonOS/);

    const version = spawnSync(process.execPath, [BIN, '--version'], { encoding: 'utf8' });
    assert.equal(version.status, 0);
    assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);

    const probe = spawnSync(process.execPath, [BIN, 'hands', 'probe', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: broken.binDir, ARCHON_STATE_DIR: broken.stateDir },
      timeout: 20000,
    });
    const probePayload = JSON.parse(probe.stdout);
    assert.equal(probePayload.hands.id, 'hands');
    assert.equal(typeof probePayload.ok, 'boolean');
    assert.equal(probe.status, probePayload.ok ? 0 : 1);
  } finally {
    rmSync(broken.root, { recursive: true, force: true });
  }
});

test('invalid config still yields a structured report without printing its raw contents', () => {
  const fx = fixture();
  try {
    for (const invalidConfig of ['null', '[]', '{"apiKey": unquoted-test-value}']) {
      writeFileSync(join(fx.stateDir, 'config.json'), invalidConfig);
      const res = spawnSync(process.execPath, [BIN, 'doctor', '--json'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: fx.binDir, ARCHON_STATE_DIR: fx.stateDir },
        timeout: 20000,
      });
      assert.equal(res.status, 1, res.stderr);
      const report = JSON.parse(res.stdout);
      assert.equal(byId(report, 'workspace-config').status, 'fail');
      assert.equal(byId(report, 'server').status, 'info');
      assert.doesNotMatch(res.stdout, /unquoted-test-value/);
    }
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('help lists the diagnostics commands instead of leaving them undocumented', () => {
  const res = spawnSync(process.execPath, [BIN, 'help'], { encoding: 'utf8', timeout: 20000 });
  assert.equal(res.status, 0);
  for (const command of ['archon doctor', 'archon status', 'archon hands probe', 'archon --version']) {
    assert.ok(res.stdout.includes(command), command);
  }
});