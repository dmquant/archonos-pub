// ArchonOS Local Install Diagnostics (`archon doctor` / `archon status` / `archon hands probe`)
//
// Read-only preflight for a self-hosted workstation install. It re-checks the
// invariants the README promises instead of trusting them:
//   - loopback-only console bind (no inbound public surface)
//   - zero plaintext secrets in operator state (`secret://` handles only)
//   - private `.archon/` state ignored by git
//   - at least one enabled local CLI hand actually resolvable on this host
//   - workspace state / config parse and keep the mandatory Chief of Staff seat
//
// Nothing here writes to disk. Every check is a pure function of the state
// directory except the server probe and the hand binary lookup, which are
// injectable so the suite never touches the network or the host PATH.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const DOCTOR_SCHEMA = 'archon.doctor.v1';
export const MIN_NODE_MAJOR = 20;
export const LOCAL_ENGINES = ['claude', 'codex', 'agy', 'opencode', 'dsh'];

const MANDATORY_SEAT = 'chief-of-staff';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const MAX_SCANNED_JSON_BYTES = 4 * 1024 * 1024;
const MAX_SCAN_DEPTH = 12;

// Key names that must never carry a literal value in persisted operator state.
const SECRET_KEY =
  /(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?ref|client[_-]?secret|password|passwd|authorization|bearer)$/i;
const BARE_SECRET_KEY = /^(token|secret|cookie|credential)s?$/i;

const TITLES = {
  'node-runtime': 'Node runtime',
  'workspace-dir': 'Workspace dir',
  'workspace-state': 'Workspace state',
  'workspace-config': 'Workspace config',
  'plaintext-secrets': 'Plaintext secrets',
  'gitignore-coverage': 'Git ignore',
  'seat-integrity': 'Seat integrity',
  server: 'Local console',
  hands: 'CLI hands',
  'safe-mode': 'Safe mode',
  'state-permissions': 'State permissions',
};

const makeCheck = (id, status, summary, extra = {}) => ({
  id,
  title: TITLES[id] || id,
  status,
  summary,
  ...extra,
});

export function maskPath(p) {
  if (typeof p !== 'string' || !p) return p;
  const home = homedir();
  if (home && home !== '/' && p.startsWith(home)) return `~${p.slice(home.length)}`;
  return p;
}

function isOpaqueSecretReference(value) {
  return (
    typeof value !== 'string' ||
    value.length === 0 ||
    /^secret:\/\//.test(value) ||
    /^env:/.test(value) ||
    /^\$\{[^}]*\}$/.test(value) ||
    /^<[^>]*>$/.test(value) ||
    /^auto$/.test(value)
  );
}

function readJsonFile(file) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (error) {
    const reason = error instanceof SyntaxError ? 'malformed document' : error.code || 'could not read the file';
    return { ok: false, error: reason };
  }
}

// Scan persisted JSON for literal credentials. Values are never returned.
export function scanPlaintextSecrets(value, file, path = '$', findings = [], depth = 0) {
  if (!value || typeof value !== 'object' || depth > MAX_SCAN_DEPTH) return findings;
  for (const [key, child] of Object.entries(value)) {
    const at = `${path}.${key}`;
    if (typeof child === 'string' && (SECRET_KEY.test(key) || BARE_SECRET_KEY.test(key)) && !isOpaqueSecretReference(child)) {
      findings.push({ file, path: at, key, preview: '***' });
    } else if (child && typeof child === 'object') {
      scanPlaintextSecrets(child, file, at, findings, depth + 1);
    }
  }
  return findings;
}

function listTopLevelJson(stateDir) {
  try {
    return readdirSync(stateDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => join(stateDir, name))
      .filter((file) => {
        try {
          return statSync(file).isFile() && statSync(file).size <= MAX_SCANNED_JSON_BYTES;
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

export function findExecutableOnPath(engine, pathValue) {
  if (!pathValue) return null;
  for (const dir of String(pathValue).split(':')) {
    if (!dir) continue;
    const candidate = join(dir, engine);
    try {
      const info = statSync(candidate);
      if (info.isFile()) return candidate;
    } catch {}
  }
  return null;
}

function localConsoleUrl(host, port) {
  const hostname = host === '::1' ? '[::1]' : host;
  return `http://${hostname}:${port}`;
}

const isLocalPort = (port) => Number.isInteger(port) && port >= 1 && port <= 65535;

// Default probe: ask the local edge server for its health payload. A closed
// port is a normal state (console not started), not an error.
export async function probeLocalServer({ host = '127.0.0.1', port = 8790 } = {}) {
  if (!LOOPBACK_HOSTS.has(host) || !isLocalPort(port)) {
    return { state: 'unknown', detail: 'invalid local console address' };
  }
  const url = `${localConsoleUrl(host, port)}/api/health`;
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(1200) });
    let body = null;
    try {
      body = await res.json();
    } catch {}
    if (res.ok && body?.ok === true && body.service === 'archon-os-worker') {
      return { state: 'running', url, status: res.status };
    }
    return { state: 'foreign', url, status: res.status };
  } catch (error) {
    const code = error?.cause?.code || error?.code || '';
    if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET/.test(code) || error?.name === 'TimeoutError') {
      return { state: 'stopped', url };
    }
    return { state: 'unknown', url, detail: error?.message || String(error) };
  }
}

function checkNodeRuntime(nodeVersion) {
  const major = Number.parseInt(String(nodeVersion).split('.')[0], 10);
  if (!Number.isFinite(major)) {
    return makeCheck('node-runtime', 'warn', `Unknown Node version ${nodeVersion}`);
  }
  return major >= MIN_NODE_MAJOR
    ? makeCheck('node-runtime', 'pass', `v${nodeVersion} (requires >= ${MIN_NODE_MAJOR})`)
    : makeCheck('node-runtime', 'fail', `v${nodeVersion} is below the supported major ${MIN_NODE_MAJOR}`, {
        fix: `install Node ${MIN_NODE_MAJOR} or newer (nvm install ${MIN_NODE_MAJOR})`,
      });
}

function checkWorkspaceDir(stateDir) {
  if (!existsSync(stateDir)) {
    return makeCheck('workspace-dir', 'warn', `${maskPath(stateDir)} does not exist`, {
      fix: 'npm run init',
    });
  }
  try {
    if (!statSync(stateDir).isDirectory()) {
      return makeCheck('workspace-dir', 'fail', `${maskPath(stateDir)} is not a directory`);
    }
  } catch (error) {
    return makeCheck('workspace-dir', 'fail', `cannot stat ${maskPath(stateDir)}: ${error.message}`);
  }
  return makeCheck('workspace-dir', 'pass', maskPath(stateDir));
}

function readWorkspaceState(stateDir) {
  const file = join(stateDir, 'workspace-state.json');
  if (!existsSync(file)) {
    return {
      state: null,
      check: makeCheck('workspace-state', 'warn', 'not initialized', { fix: 'npm run init' }),
    };
  }
  const parsed = readJsonFile(file);
  if (!parsed.ok) {
    return {
      state: null,
      check: makeCheck('workspace-state', 'fail', `invalid JSON: ${parsed.error}`, {
        fix: 'restore from a golden checkpoint or re-run `npm run init`',
      }),
    };
  }
  if (!Array.isArray(parsed.value?.seats)) {
    return {
      state: parsed.value,
      check: makeCheck('workspace-state', 'fail', 'missing `seats` array'),
    };
  }
  const sessions = Array.isArray(parsed.value.chatSessions) ? parsed.value.chatSessions.length : 0;
  return {
    state: parsed.value,
    check: makeCheck(
      'workspace-state',
      'pass',
      `${parsed.value.seats.length} seats · ${sessions} chat sessions · ${Array.isArray(parsed.value.artifacts) ? parsed.value.artifacts.length : 0} artifacts`,
    ),
  };
}

const isJsonObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function readWorkspaceConfig(repoRoot, stateDir) {
  const defaultsPath = join(repoRoot, 'config', 'archon.defaults.json');
  const userPath = join(stateDir, 'config.json');
  const defaults = existsSync(defaultsPath) ? readJsonFile(defaultsPath) : { ok: true, value: null };
  if (existsSync(userPath)) {
    const user = readJsonFile(userPath);
    const validShape = isJsonObject(user.value) &&
      (user.value.server === undefined || isJsonObject(user.value.server));
    if (!user.ok || !validShape) {
      const reason = user.ok ? 'expected a JSON object with optional server settings' : user.error;
      return {
        config: defaults.value,
        check: makeCheck('workspace-config', 'fail', `${maskPath(userPath)}: ${reason}`, {
          fix: 'fix or delete .archon/config.json, then run `npm run init`',
        }),
      };
    }
    const merged = {
      ...(defaults.value || {}),
      ...user.value,
      server: { ...(defaults.value?.server || {}), ...(user.value.server || {}) },
      hands: { ...(defaults.value?.hands || {}), ...(user.value.hands || {}) },
    };
    return { config: merged, check: validateConfig(merged, userPath) };
  }
  if (!defaults.value) {
    return {
      config: null,
      check: makeCheck('workspace-config', 'fail', 'no config/archon.defaults.json in the repository'),
    };
  }
  return { config: defaults.value, check: validateConfig(defaults.value, defaultsPath) };
}

function validateConfig(config, file) {
  const problems = [];
  if (!isJsonObject(config) || (config.server !== undefined && !isJsonObject(config.server))) {
    return makeCheck('workspace-config', 'fail', 'expected a JSON object with optional server settings');
  }
  const host = config.server?.host;
  if (host !== undefined && !LOOPBACK_HOSTS.has(host)) {
    problems.push('server.host must be a loopback address');
  }
  const port = config.server?.port;
  if (port !== undefined && !isLocalPort(port)) {
    problems.push('server.port must be an integer from 1..65535');
  }
  if (problems.length) {
    return makeCheck('workspace-config', 'fail', problems.join('; '), {
      fix: 'set server.host to 127.0.0.1 in .archon/config.json',
    });
  }
  const name = config.workspaceName || 'unnamed workspace';
  const hands = Object.keys(config.hands || {}).length;
  return makeCheck('workspace-config', 'pass', `${name} · ${hands} hand profiles · ${maskPath(file)}`);
}

function checkPlaintextSecrets(stateDir) {
  const findings = [];
  for (const file of listTopLevelJson(stateDir)) {
    const parsed = readJsonFile(file);
    if (parsed.ok) scanPlaintextSecrets(parsed.value, file, '$', findings);
  }
  if (!findings.length) {
    return makeCheck('plaintext-secrets', 'pass', 'no literal credentials in .archon/*.json');
  }
  const first = findings[0];
  return makeCheck(
    'plaintext-secrets',
    'fail',
    `${findings.length} literal credential value(s), first at ${maskPath(first.file)} ${first.path} = ${first.preview}`,
    {
      fix: 'replace the value with a secret:// handle and keep the real secret in your OS keychain',
      findings: findings.map((f) => ({ ...f, file: maskPath(f.file) })),
    },
  );
}

function checkGitignoreCoverage(repoRoot) {
  const file = join(repoRoot, '.gitignore');
  if (!existsSync(file)) {
    return makeCheck('gitignore-coverage', 'fail', 'no .gitignore — private .archon state could be committed', {
      fix: 'restore .gitignore with `.archon/` and `.env`',
    });
  }
  const lines = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\//, '').replace(/\/$/, ''))
    .filter((line) => line && !line.startsWith('#'));
  const covers = (target) => lines.includes(target);
  const dotenv = lines.some((line) => line === '.env' || line.startsWith('.env.') || line === '.env*');
  const missing = [];
  if (!covers('.archon')) missing.push('.archon/');
  if (!dotenv) missing.push('.env');
  if (missing.length) {
    return makeCheck('gitignore-coverage', 'warn', `not ignored: ${missing.join(', ')}`, {
      fix: `add ${missing.join(' and ')} to .gitignore`,
    });
  }
  return makeCheck('gitignore-coverage', 'pass', '.archon/ and .env are ignored');
}

function checkSeatIntegrity(state) {
  if (!state || !Array.isArray(state.seats)) {
    return makeCheck('seat-integrity', 'info', 'skipped (no parsed workspace state)');
  }
  const ids = state.seats.map((seat) => String(seat?.id ?? ''));
  const duplicates = [...new Set(ids.filter((id, index) => id && ids.indexOf(id) !== index))];
  const hasChief = ids.some((id) => id === MANDATORY_SEAT || id === `seat:${MANDATORY_SEAT}`);
  const unknownHands = [
    ...new Set(
      state.seats
        .map((seat) => seat?.hand)
        .filter((hand) => typeof hand === 'string' && hand && !LOCAL_ENGINES.includes(hand)),
    ),
  ];
  const problems = [];
  if (!hasChief) problems.push(`mandatory ${MANDATORY_SEAT} seat is missing`);
  if (duplicates.length) problems.push(`duplicate seat ids: ${duplicates.join(', ')}`);
  if (problems.length) {
    return makeCheck('seat-integrity', 'fail', problems.join('; '), { fix: 'npm run init' });
  }
  if (unknownHands.length) {
    return makeCheck('seat-integrity', 'warn', `unknown hand(s) on seats: ${unknownHands.join(', ')}`);
  }
  return makeCheck('seat-integrity', 'pass', `${state.seats.length} seats incl. ${MANDATORY_SEAT}`);
}

async function checkServer(config, probeServer) {
  const host = config?.server?.host || '127.0.0.1';
  const port = config?.server?.port || 8790;
  let result;
  try {
    result = await probeServer({ host, port });
  } catch (error) {
    result = { state: 'unknown', detail: error?.message || String(error) };
  }
  const url = localConsoleUrl(host, port);
  if (result?.state === 'running') {
    return makeCheck('server', 'pass', `running at ${url}`);
  }
  if (result?.state === 'stopped') {
    return makeCheck('server', 'info', `not running at ${url}`, { fix: 'npm start' });
  }
  if (result?.state === 'foreign') {
    return makeCheck('server', 'warn', `${url} answers but not with an ArchonOS health payload`, {
      fix: 'check for another process on this port, or set server.port in .archon/config.json',
    });
  }
  return makeCheck('server', 'warn', `probe failed for ${url}: ${result?.detail || 'unknown error'}`);
}

function checkHands(config, env) {
  const declared = config?.hands || {};
  const entries = Object.entries(declared).filter(([engine]) => LOCAL_ENGINES.includes(engine));
  if (!entries.length) {
    return makeCheck('hands', 'warn', 'no local hand profiles configured', { fix: 'npm run init' });
  }
  const installed = [];
  const missing = [];
  for (const [engine, spec] of entries) {
    const explicit = spec?.binaryPath && spec.binaryPath !== 'auto' ? spec.binaryPath : null;
    const found = explicit && existsSync(explicit) ? explicit : findExecutableOnPath(engine, env?.PATH);
    if (found) installed.push(engine);
    else missing.push(engine);
  }
  const enabledMissing = entries
    .filter(([engine, spec]) => spec?.enabled !== false && missing.includes(engine))
    .map(([engine]) => engine);
  if (!installed.length) {
    return makeCheck('hands', 'fail', `none of ${entries.map(([e]) => e).join(', ')} resolve on PATH`, {
      fix: 'install one CLI hand (e.g. `npm i -g @anthropic-ai/claude-code`) or fix binaryPath in .archon/config.json',
    });
  }
  if (enabledMissing.length) {
    return makeCheck('hands', 'warn', `${installed.join(', ')} installed · enabled but missing: ${enabledMissing.join(', ')}`, {
      fix: `install ${enabledMissing.join(', ')} or disable it in .archon/config.json (\`hands.${enabledMissing[0]}.enabled = false\`)`,
    });
  }
  return makeCheck('hands', 'pass', `${installed.length}/${entries.length} installed: ${installed.join(', ')}`);
}

function checkSafeMode(stateDir) {
  const file = join(stateDir, 'safe-mode.json');
  if (!existsSync(file)) return makeCheck('safe-mode', 'pass', 'off');
  const parsed = readJsonFile(file);
  if (!parsed.ok) return makeCheck('safe-mode', 'warn', `unreadable ${maskPath(file)}: ${parsed.error}`);
  const locked = parsed.value?.enabled === true || parsed.value?.locked === true || parsed.value?.immutable === true;
  return locked
    ? makeCheck('safe-mode', 'warn', 'immutable safe mode is ACTIVE — writes are refused', {
        fix: 'npm run safe:unlock',
      })
    : makeCheck('safe-mode', 'pass', 'off');
}

function checkStatePermissions(stateDir, platformName) {
  if (platformName === 'win32') return makeCheck('state-permissions', 'info', 'skipped on Windows');
  if (!existsSync(stateDir)) return makeCheck('state-permissions', 'info', 'skipped (no workspace dir)');
  try {
    const mode = statSync(stateDir).mode & 0o777;
    if (mode & 0o007) {
      return makeCheck('state-permissions', 'warn', `${maskPath(stateDir)} is ${mode.toString(8)} — readable by other users`, {
        fix: `chmod 700 ${maskPath(stateDir)}`,
      });
    }
    return makeCheck('state-permissions', 'pass', `mode ${mode.toString(8)}`);
  } catch (error) {
    return makeCheck('state-permissions', 'warn', `cannot read mode: ${error.message}`);
  }
}

export async function collectDiagnostics({
  repoRoot,
  stateDir = join(repoRoot, '.archon'),
  env = process.env,
  nodeVersion = process.versions.node,
  platformName = process.platform,
  probeServer = probeLocalServer,
  now = new Date(),
} = {}) {
  if (!repoRoot) throw new TypeError('collectDiagnostics requires repoRoot');

  const checks = [checkNodeRuntime(nodeVersion), checkWorkspaceDir(stateDir)];
  const { state, check: stateCheck } = readWorkspaceState(stateDir);
  checks.push(stateCheck);
  const { config, check: configCheck } = readWorkspaceConfig(repoRoot, stateDir);
  checks.push(configCheck);
  checks.push(checkPlaintextSecrets(stateDir));
  checks.push(checkGitignoreCoverage(repoRoot));
  checks.push(checkSeatIntegrity(state));
  const serverCheck = configCheck.status === 'pass'
    ? await checkServer(config, probeServer)
    : makeCheck('server', 'info', 'skipped because the workspace config is invalid');
  checks.push(serverCheck);
  checks.push(checkHands(config, env));
  checks.push(checkSafeMode(stateDir));
  checks.push(checkStatePermissions(stateDir, platformName));

  const counts = { pass: 0, warn: 0, fail: 0, info: 0 };
  for (const item of checks) counts[item.status] += 1;
  const status = counts.fail > 0 ? 'fail' : counts.warn > 0 ? 'warn' : counts.pass > 0 ? 'pass' : 'info';
  const fixes = [...new Set(checks.filter((c) => c.fix).map((c) => c.fix))];

  return {
    schema: DOCTOR_SCHEMA,
    generatedAt: now.toISOString(),
    ok: counts.fail === 0,
    status,
    counts,
    total: checks.length,
    checks,
    fixes,
    workspace: {
      root: maskPath(repoRoot),
      stateDir: maskPath(stateDir),
      name: config?.workspaceName || null,
      seats: Array.isArray(state?.seats) ? state.seats.length : 0,
    },
    server: {
      host: config?.server?.host || '127.0.0.1',
      port: config?.server?.port || 8790,
    },
  };
}

const STATUS_LABEL = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', info: 'INFO' };

export function formatDiagnostics(report, { version = '' } = {}) {
  const head = `ArchonOS doctor${version ? ` v${version}` : ''} · ${report.schema}`;
  const width = Math.max(12, ...report.checks.map((c) => c.title.length));
  const lines = [head, ''];
  for (const item of report.checks) {
    lines.push(`  ${STATUS_LABEL[item.status]}  ${item.title.padEnd(width)}  ${item.summary}`);
  }
  lines.push('');
  const { pass, warn, fail, info } = report.counts;
  lines.push(`  ${report.total} checks · ${pass} pass · ${warn} warn · ${fail} fail${info ? ` · ${info} info` : ''}`);
  if (report.fixes.length) {
    lines.push('');
    for (const fix of report.fixes) lines.push(`  fix: ${fix}`);
  }
  return lines.join('\n');
}

export function formatStatus(report, { version = '' } = {}) {
  const server = report.checks.find((c) => c.id === 'server');
  const hands = report.checks.find((c) => c.id === 'hands');
  const safeMode = report.checks.find((c) => c.id === 'safe-mode');
  return [
    `ArchonOS${version ? ` v${version}` : ''} — ${report.workspace.name || 'uninitialized workspace'}`,
    `  workspace   ${report.workspace.seats} seats · ${report.workspace.stateDir}`,
    `  console     ${server?.summary ?? 'unknown'}`,
    `  hands       ${hands ? hands.summary : 'unknown'}`,
    `  safe mode   ${safeMode ? safeMode.summary : 'unknown'}`,
    `  doctor      ${report.counts.fail} fail · ${report.counts.warn} warn — run \`archon doctor\``,
  ].join('\n');
}

export function formatHandsProbe(report) {
  const hands = report.checks.find((c) => c.id === 'hands');
  if (!hands) return 'No hand inventory available.';
  return `CLI hands — ${STATUS_LABEL[hands.status]}\n  ${hands.summary}`;
}