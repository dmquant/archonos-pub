#!/usr/bin/env node
// ArchonOS CLI Entry Point (`npx archon init` | `npx archon up` | `npx archon deploy` | `npx archon hand pair <CODE>`)

import { runArchonUp, runArchonHandPair, runArchonDeployTarget } from '../src/cli-core.mjs';
import { runAutonomousInit } from '../../../scripts/archon-init.mjs';

const args = process.argv.slice(2);
const cmd = args[0] ?? 'help';

if (cmd === 'init' || cmd === 'setup') {
  runAutonomousInit({ quiet: args.includes('--quiet') });
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
  console.log(JSON.stringify(res, null, 2));
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
  console.log(JSON.stringify(res, null, 2));
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
  console.log(JSON.stringify(res, null, 2));
} else {
  console.log(
    'ArchonOS CLI v0.1.005 — Commands:\n  archon init                      Auto-detect CLI hands, headless flags, MCP servers & skills\n  archon deploy [--local|--remote] Switch or provision Local Workstation vs Cloudflare Remote (Worker + Frontend Page)\n  archon up                        Provision Cloudflare Worker + D1/R2 stack\n  archon hand pair <CODE>          Pair a local CLI hand daemon'
  );
}
