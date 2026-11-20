#!/usr/bin/env node
// ArchonOS CLI Entry Point
//   npx archon init | up | deploy | status | doctor | hands probe | hand pair <CODE>

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { runArchonUp, runArchonHandPair, runArchonDeployTarget } from '../src/cli-core.mjs';
import {
  collectDiagnostics,
  formatDiagnostics,
  formatHandsProbe,
  formatStatus,
} from '../src/doctor.mjs';
import { runAutonomousInit } from '../../../scripts/archon-init.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PKG = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));

const args = process.argv.slice(2);
const cmd = args[0] ?? 'help';
const wantsJson = args.includes('--json');

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

// Diagnostics read the same state directory the local edge server uses, so a
// test or a second profile can point ARCHON_STATE_DIR somewhere else.
async function diagnostics() {
  return collectDiagnostics({
    repoRoot: REPO_ROOT,
    stateDir: process.env.ARCHON_STATE_DIR ? join(process.env.ARCHON_STATE_DIR) : join(REPO_ROOT, '.archon'),
  });
}

if (cmd === 'init' || cmd === 'setup') {
  runAutonomousInit({ quiet: args.includes('--quiet') });
} else if (cmd === 'doctor') {
  const report = await diagnostics();
  if (wantsJson) {
    printJson({ version: PKG.version, ...report });
  } else {
    console.log(formatDiagnostics(report, { version: PKG.version }));
  }
  const strict = args.includes('--strict');
  const failed = report.counts.fail > 0 || (strict && report.counts.warn > 0);
  process.exitCode = failed ? 1 : 0;
} else if (cmd === 'status') {
  const report = await diagnostics();
  if (wantsJson) {
    printJson({ version: PKG.version, ...report });
  } else {
    console.log(formatStatus(report, { version: PKG.version }));
  }
  process.exitCode = report.counts.fail > 0 ? 1 : 0;
} else if (cmd === 'hands' && args[1] === 'probe') {
  const report = await diagnostics();
  if (wantsJson) {
    const hands = report.checks.find((c) => c.id === 'hands');
    printJson({ version: PKG.version, ok: hands?.status !== 'fail', hands });
  } else {
    console.log(formatHandsProbe(report));
  }
  process.exitCode = report.checks.find((c) => c.id === 'hands')?.status === 'fail' ? 1 : 0;
} else if (cmd === 'deploy') {
  const isRemote = args.includes('--remote') || args.includes('--cloudflare') || args[1] === 'remote';
  const workerIdx = args.indexOf('--worker-url');
  const pageIdx = args.indexOf('--page-url');
  const res = runArchonDeployTarget({
    mode: isRemote ? 'cloudflare-remote' : 'local',
    remoteWorkerUrl: workerIdx >= 0 && args[workerIdx + 1] ? args[workerIdx + 1] : process.env.ARCHON_REMOTE_WORKER_URL || 'https://archon-os-worker.workers.dev',
    remoteFrontendPageUrl: pageIdx >= 0 && args[pageIdx + 1] ? args[pageIdx + 1] : process.env.ARCHON_REMOTE_PAGE_URL || 'https://archon-os-app.pages.dev',
    cloudflareApiToken: process.env.CLOUDFLARE_API_TOKEN ?? 'local-dev-cf-token',
    encryptionMode: process.env.ARCHON_ENCRYPTION_MODE ?? 'e2ee-local-custodian',
  });
  printJson(res);
} else if (cmd === 'up') {
  const token = process.env.CLOUDFLARE_API_TOKEN ?? 'local-dev-cf-token';
  const res = runArchonUp({
    cloudflareApiToken: token,
    encryptionMode: process.env.ARCHON_ENCRYPTION_MODE ?? 'e2ee-local-custodian',
  });
  if (!res.ok) {
    console.error(`[archon up] Refused: ${res.error}`);
    process.exit(1);
  }
  printJson(res);
} else if (cmd === 'hand' && args[1] === 'pair') {
  const code = args[2];
  if (!code) {
    console.error('Usage: archon hand pair <CODE>');
    process.exit(1);
  }
  const pairingRecord = { code, expiresAt: Date.now() + 600_000, used: false };
  const res = runArchonHandPair({
    pairingRecord,
    submittedCode: code,
    handId: process.env.ARCHON_HAND_ID ?? 'local-hand-01',
    platform: process.platform,
  });
  printJson(res);
} else if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
  console.log(PKG.version);
} else {
  console.log(
    `ArchonOS CLI v${PKG.version} — Commands:\n` +
      `  archon init                      Auto-detect CLI hands, headless flags, MCP servers & skills\n` +
      `  archon doctor [--json] [--strict] Preflight the install: state, config, hands, secrets, loopback bind\n` +
      `  archon status [--json]           One-line operational snapshot of workspace, console & hands\n` +
      `  archon hands probe [--json]      Show which local CLI hands resolve on this host\n` +
      `  archon deploy [--local|--remote] Switch or provision Local Workstation vs Cloudflare Remote (Worker + Frontend Page)\n` +
      `  archon up                        Provision Cloudflare Worker + D1/R2 stack\n` +
      `  archon hand pair <CODE>          Pair a local CLI hand daemon\n` +
      `  archon --version                 Print the CLI version`
  );
  process.exit(cmd === 'help' || cmd === '--help' || cmd === '-h' ? 0 : 1);
}