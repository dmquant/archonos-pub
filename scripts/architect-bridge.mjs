#!/usr/bin/env node
// Antigravity (Codebase Session) ⇄ ArchonOS Seats Closed-Loop CLI Bridge
// Usage:
//   node scripts/architect-bridge.mjs inbox
//   node scripts/architect-bridge.mjs guide --seat deep-research --rounds 2 --goal "Audit 3 subgraphs and summarize key defeaters"
//   node scripts/architect-bridge.mjs feedback --seat chief-of-staff --request "Add 1-click export of session memory"
//   node scripts/architect-bridge.mjs reply --ticket fb-xxx --status resolved --files "packages/archon-app/public/index.html" --message "Implemented feature..."

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const BRIDGE_FILE = join(REPO_ROOT, '.archon', 'architect-bridge.json');
const BASE_URL = process.env.ARCHON_BASE_URL || 'http://127.0.0.1:8790';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const eqIdx = token.indexOf('=');
      if (eqIdx > 0) {
        args[token.slice(2, eqIdx)] = token.slice(eqIdx + 1);
      } else {
        const key = token.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          args[key] = next;
          i += 1;
        } else {
          args[key] = true;
        }
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

async function fetchBridgeApi(pathname, options = {}) {
  const res = await fetch(`${BASE_URL}${pathname}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  return res.json();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = (args._[0] || 'inbox').toLowerCase();

  if (cmd === 'inbox' || cmd === 'status') {
    try {
      const data = await fetchBridgeApi('/api/architect/bridge');
      console.log(`=== 🔗 Antigravity ⇄ ArchonOS Seats Closed-Loop Bridge ===`);
      console.log(`Bridge File : ${data.bridgeFile || '.archon/architect-bridge.json'}`);
      console.log(
        `Open Tickets: ${data.openCount} / ${data.totalTickets} total • Guided Loops: ${data.totalLoops} • Infinite RSI Ticks: ${data.rsiTickCount || 0} (Cron: ${data.rsiCronSpec || '0 */2 * * *'})`
      );
      if ((data.rsiTicks || []).length > 0) {
        const latestTick = data.rsiTicks[0];
        console.log(
          `Latest RSI  : Tick #${latestTick.tickNumber} -> seat:${latestTick.seatId} (@skill:${latestTick.skillAudited}) @ ${latestTick.createdAt}`
        );
      }
      console.log(`\n--- 📥 Seat ➔ Antigravity Feature / Feedback Inbox ---`);
      for (const t of (data.feedbackInbox || []).slice(0, 10)) {
        console.log(
          `• [${t.status.toUpperCase()}] ${t.id} (${t.seatId}/${t.engine} • ${t.priority}): ${t.title}`
        );
        if (t.seatFeedbackSpec) {
          console.log(`  Spec: ${String(t.seatFeedbackSpec).replace(/\s+/g, ' ').slice(0, 220)}...`);
        }
        if (Array.isArray(t.architectReplies) && t.architectReplies.length > 0) {
          const lastRep = t.architectReplies[t.architectReplies.length - 1];
          console.log(`  ↳ Antigravity Reply: ${String(lastRep.message).replace(/\s+/g, ' ').slice(0, 200)}`);
        }
      }
      if ((data.guidedLoops || []).length > 0) {
        console.log(`\n--- 🔄 Recent Antigravity ⇄ Seat Guided Loops ---`);
        for (const l of (data.guidedLoops || []).slice(0, 5)) {
          console.log(
            `• [${l.status.toUpperCase()}] ${l.loopId} -> seat:${l.seatId} (${l.engine}) • Rounds: ${l.rounds?.length || 0}/${l.maxRounds} • Goal: ${l.goal}`
          );
        }
      }
      return;
    } catch (_) {
      if (existsSync(BRIDGE_FILE)) {
        console.log(readFileSync(BRIDGE_FILE, 'utf8'));
        return;
      }
      console.error('Could not reach ArchonOS server at', BASE_URL);
      process.exit(1);
    }
  }

  if (cmd === 'rsi-tick' || cmd === 'rsi') {
    const seatId = args.seat || undefined;
    const liveHand = Boolean(args['live-hand'] || args.liveHand);
    const data = await fetchBridgeApi('/api/architect/rsi-tick', {
      method: 'POST',
      body: JSON.stringify({
        seatId,
        liveHand,
      }),
    });
    console.log(data.summaryMd || JSON.stringify(data, null, 2));
    return;
  }

  if (cmd === 'guide' || cmd === 'loop') {
    const seatId = args.seat || 'deep-research';
    const maxRounds = Number(args.rounds || 2);
    const goal = args.goal || args.prompt || args._.slice(1).join(' ');
    const checklist = args.checklist || '';
    if (!goal) {
      console.error('Usage: node scripts/architect-bridge.mjs guide --seat <seatId> --rounds 2 --goal "<task>"');
      process.exit(1);
    }
    console.log(`🤖 Dispatching Antigravity ⇄ seat:${seatId} Guided Loop (${maxRounds} round(s))...`);
    const data = await fetchBridgeApi('/api/architect/loop/run', {
      method: 'POST',
      body: JSON.stringify({
        seatId,
        maxRounds,
        goal,
        refinementChecklist: checklist || undefined,
        waitMs: Number(args.waitMs || 180000),
      }),
    });
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (cmd === 'feedback') {
    const seatId = args.seat || 'chief-of-staff';
    const request = args.request || args.prompt || args._.slice(1).join(' ');
    if (!request) {
      console.error('Usage: node scripts/architect-bridge.mjs feedback --seat <seatId> --request "<enhancement>"');
      process.exit(1);
    }
    const data = await fetchBridgeApi('/api/architect/feedback', {
      method: 'POST',
      body: JSON.stringify({
        seatId,
        request,
        synthesizeViaSeat: Boolean(args.synthesize),
        priority: args.priority || 'high',
        category: args.category || 'feature-enhancement',
      }),
    });
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (cmd === 'reply') {
    const ticketId = args.ticket || '';
    const message = args.message || args._.slice(1).join(' ');
    const status = args.status || 'resolved';
    const filesModified = args.files
      ? String(args.files)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    if (!message) {
      console.error('Usage: node scripts/architect-bridge.mjs reply --ticket <id> --message "<resolution>"');
      process.exit(1);
    }
    const data = await fetchBridgeApi('/api/architect/reply', {
      method: 'POST',
      body: JSON.stringify({
        ticketId,
        message,
        status,
        filesModified,
      }),
    });
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  console.error(`Unknown command: ${cmd}. Use: inbox | rsi-tick | guide | feedback | reply`);
  process.exit(1);
}

main().catch((err) => {
  console.error('Architect Bridge CLI error:', err.message);
  process.exit(1);
});
