#!/usr/bin/env node
// ArchonOS Local Workstation ➔ Cloudflare Remote Edge Sync Utility
// Synchronizes local workspace state, registered seats, skills, and canvas artifacts
// to Cloudflare Remote Worker (D1 SQLite + R2 Storage).

import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildChatSnapshot } from '../packages/archon-worker/src/chat-history.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const STATE_FILE = join(REPO_ROOT, '.archon', 'workspace-state.json');
const ARTIFACTS_DIR = join(REPO_ROOT, '.archon', 'artifacts');

const args = process.argv.slice(2);
const CHAT_ONLY = args.includes('--chat-only');
const MESH_ONLY = args.includes('--mesh-only');
const WATCH = args.includes('--watch');
const remoteUrlIdx = args.indexOf('--remote');
const REMOTE_URL = remoteUrlIdx >= 0 && args[remoteUrlIdx + 1]
  ? args[remoteUrlIdx + 1]
  : process.env.ARCHON_REMOTE_WORKER_URL || 'https://archon-os-worker.workers.dev';

const tokenFile = process.env.ARCHON_ADMIN_TOKEN_FILE || join(REPO_ROOT, '.archon', 'edge-sync-token');
const ADMIN_TOKEN = process.env.ARCHON_ADMIN_TOKEN || (existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '');
if (!ADMIN_TOKEN) throw new Error('Set ARCHON_ADMIN_TOKEN or ARCHON_ADMIN_TOKEN_FILE');
if (new URL(REMOTE_URL).protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(new URL(REMOTE_URL).hostname)) {
  throw new Error('Remote sync requires HTTPS');
}
let lastChatBody = '';

async function syncChatHistory() {
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  const snapshot = buildChatSnapshot(state);
  const content = JSON.stringify({ activeSessionId: snapshot.activeSessionId, chatSessions: snapshot.chatSessions });
  const body = JSON.stringify(snapshot);
  if (content === lastChatBody) return;
  const res = await fetch(`${REMOTE_URL}/api/chat/sync`, {
    method: 'PUT', headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
    body, signal: AbortSignal.timeout(60000),
  });
  const result = await res.json().catch(() => ({}));
  if (!res.ok || !result.ok) throw new Error(`Chat sync failed: HTTP ${res.status} (${result.error || 'invalid_response'})`);
  lastChatBody = content;
  console.log(`Chat history synced: ${result.sessions} conversations, ${result.messages} messages`);
}

async function syncToEdge() {
  console.log(`\n🚀 ArchonOS Edge Sync: Connecting to ${REMOTE_URL}...`);
  if (!existsSync(STATE_FILE)) {
    console.error(`❌ Local state file not found at ${STATE_FILE}`);
    process.exit(1);
  }

  const rawState = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  const headers = {
    'user-agent': 'ArchonOS-Sovereign-Sync/0.1.005 (MacBook Pro; Darwin arm64)',
    'content-type': 'application/json',
    'authorization': `Bearer ${ADMIN_TOKEN}`,
    'x-archon-origin': 'interactive',
    'x-archon-author': 'operator:local',
  };

  // 1. Health & Perimeter Check
  try {
    const healthRes = await fetch(`${REMOTE_URL}/api/health`, { headers });
    const health = await healthRes.json().catch(() => ({}));
    if (healthRes.status === 401) {
      console.error(`❌ 401 Unauthorized: Invalid ARCHON_ADMIN_TOKEN for ${REMOTE_URL}`);
      process.exit(1);
    }
    console.log(`✅ Remote Worker Verified: ArchonOS Edge (${health.service || 'archon-os-worker'} v${health.version || '0.1.005'})`);
  } catch (err) {
    console.error(`❌ Connection failed to ${REMOTE_URL}:`, err.message);
    process.exit(1);
  }

  // 2. Sync Seats
  const localSeats = rawState.seats || [];
  console.log(`\n🪑 Synchronizing ${localSeats.length} Sovereign Seats...`);
  let syncedSeats = 0;
  for (const seat of localSeats) {
    try {
      const res = await fetch(`${REMOTE_URL}/api/seats`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: seat.id.replace(/^seat:/, ''),
          hand: seat.handId || seat.hand || 'agy',
          name: seat.name || seat.id,
          role: seat.role || 'specialist',
          description: seat.description || '',
          capabilities: { chat: true, canvas: true, mcp: true },
          enabled: seat.status !== 'disabled',
          model: seat.model || 'native-cli',
          budget: 1000000000,
        }),
      });
      if (res.ok) syncedSeats++;
    } catch (e) {
      console.warn(`  ⚠️ Failed to sync seat ${seat.id}: ${e.message}`);
    }
  }
  console.log(`✅ Synced ${syncedSeats}/${localSeats.length} seats to remote D1.`);

  // 3. Sync Canvas Artifacts Metadata
  const localArtifacts = rawState.artifacts || [];
  console.log(`\n📦 Synchronizing ${localArtifacts.length} Canvas Artifacts Metadata...`);
  let syncedArts = 0;
  for (const art of localArtifacts) {
    const artId = art.artifactId || art.id;
    try {
      const res = await fetch(`${REMOTE_URL}/workspaces/ws-default/artifacts/publish`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          artifactId: artId,
          title: art.title || artId,
          publishedBySeat: (art.publishedBySeat || art.ownerSeat || 'chief-of-staff').replace(/^seat:/, ''),
          kind: art.kind || 'dashboard',
          expectedBaseRevision: 0,
          idempotencyKey: `sync-${artId}-${Date.now()}`,
          manifestContent: JSON.stringify({
            title: art.title,
            route: art.route || art.metadata?.webEmbedUrl || `/artifacts/${artId}.html`,
            tags: art.tags || art.metadata?.tags || [],
            folder: art.folder || art.metadata?.folderId || 'general',
            summary: art.summary || '',
          }),
          hasHtmlParity: true,
        }),
      });
      if (res.ok) syncedArts++;
      else {
        const errJson = await res.json().catch(() => ({}));
        console.warn(`  ⚠️ Failed to sync artifact ${artId}: HTTP ${res.status}`, errJson);
      }
    } catch (e) {
      console.warn(`  ⚠️ Failed to sync artifact ${artId}: ${e.message}`);
    }
  }
  console.log(`✅ Synced ${syncedArts}/${localArtifacts.length} artifacts metadata to remote edge.`);

  // 4. Sync Multi-User Secure Channels & Teams
  await syncMeshChannels();

  console.log(`\n🎉 Full Edge Sync Completed Successfully!`);
  console.log(`   Remote Dashboard: ${REMOTE_URL}`);
  await syncChatHistory();
}

async function syncMeshChannels() {
  if (!existsSync(STATE_FILE)) return;
  try {
    const rawState = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    const channels = rawState.secureChannels || [];
    const teams = rawState.teamGroups || [];

    const res = await fetch(`${REMOTE_URL}/api/mesh/sync`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ channels, teams }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(`HTTP ${res.status}`);
    // Merge through the running server; never overwrite its state file behind it.
    const local = await fetch(`${LOCAL_URL}/api/mesh/sync`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channels: data.channels, teams: data.teams }),
      signal: AbortSignal.timeout(30000),
    });
    if (!local.ok) throw new Error(`Local merge HTTP ${local.status}`);
  } catch (err) {
    console.warn(`⚠️ Mesh sync failed: ${err.message}`);
  }
}

// Persist completion before upload so network retries never execute the prompt twice.
const RESULT_FILE = join(REPO_ROOT, '.archon', 'bridge-pending-result.json');
const LOCAL_URL = process.env.ARCHON_LOCAL_URL || 'http://127.0.0.1:8790';
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(LOCAL_URL).hostname)) throw new Error('Bridge execution must use loopback');
async function bridgeRequest(path, body) {
  const res = await fetch(`${REMOTE_URL}/api/chat/bridge/${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(`Bridge ${path}: HTTP ${res.status}`);
  return data;
}
function saveResult(value) {
  writeFileSync(RESULT_FILE + '.tmp', JSON.stringify(value), { mode: 0o600 });
  renameSync(RESULT_FILE + '.tmp', RESULT_FILE);
}
async function dispatchRemoteChat() {
  let pending = existsSync(RESULT_FILE) ? JSON.parse(readFileSync(RESULT_FILE, 'utf8')) : null;
  if (pending) {
    // An interrupted local HTTP call may have executed: report uncertainty, never replay it.
    if (!pending.result) pending.result = { ok: false, error: 'Local bridge interrupted; execution outcome uncertain. Check conversation history before retrying.' };
    await bridgeRequest('result', pending);
    saveResult(null);
  }
  const { task } = await bridgeRequest('claim', {});
  if (!task) return;
  pending = { taskId: task.id, claim: task.claim };
  saveResult(pending);
  try {
    const res = await fetch(`${LOCAL_URL}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(task.payload), signal: AbortSignal.timeout(30 * 60 * 1000),
    });
    pending.result = await res.json();
    if (!res.ok) pending.result.ok = false;
    if (pending.result.ok && pending.result.asyncProcessing && pending.result.asyncJob?.jobId) {
      const jobId = pending.result.asyncJob.jobId;
      const deadline = Date.now() + 30 * 60 * 1000;
      for (;;) {
        if (Date.now() > deadline) throw new Error('Local hand still running after bridge wait limit');
        await new Promise(resolve => setTimeout(resolve, 2500));
        const progress = await fetch(`${LOCAL_URL}/api/hand-jobs/${encodeURIComponent(jobId)}`, { signal: AbortSignal.timeout(30000) });
        const update = await progress.json();
        if (!progress.ok || !update.ok) throw new Error('Local job status unavailable');
        if (update.job.status === 'running') { await syncChatHistory().catch(() => {}); continue; }
        const job = update.job;
        pending.result = { ...pending.result, asyncProcessing: false, asyncJob: null,
          ok: job.status === 'completed', reply: job.finalReply || job.reply || '',
          error: job.error, generatedFiles: job.generatedFiles || [], artifactUpdated: job.artifactUpdated };
        break;
      }
    }
  } catch (err) {
    pending.result = { ok: false, error: `Local execution connection failed; check history before retrying: ${err.message}` };
  }
  saveResult(pending);
  await syncChatHistory().catch(err => console.error(err.message));
  await bridgeRequest('result', pending);
  saveResult(null);
}

async function main() {
  if (MESH_ONLY) await syncMeshChannels();
  else if (CHAT_ONLY) await syncChatHistory(); else await syncToEdge();
  if (WATCH) {
    // Serial loop: no overlapping uploads; retry transient failures next tick.
    while (true) {
      await new Promise(resolve => setTimeout(resolve, 2500));
      try {
        await dispatchRemoteChat();
        await syncChatHistory();
        await syncMeshChannels();
      } catch (err) { console.error(err.message); }
    }
  }
}

main().catch((err) => {
  console.error('Fatal Edge Sync Error:', err);
  process.exit(1);
});
