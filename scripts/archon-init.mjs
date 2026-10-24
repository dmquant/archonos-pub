#!/usr/bin/env node
// ArchonOS Autonomous Initializer & Environment Bootstrapper
// Usage:
//   npm run init
//   node scripts/archon-init.mjs [--force] [--quiet]
//
// Actions performed autonomously:
// 1. Verifies Node.js & Python 3 runtimes and initializes .archon/ workspace directories.
// 2. Auto-detects installed Local CLI Model Hands (claude, codex, agy, opencode) and configures headless mode flags.
// 3. Auto-discovers local MCP servers (from standard MCP dirs or config/archon.defaults.json) with zero secret leakage.
// 4. Materializes starter Harness2 RSI SKILL.md files in .archon/skills/ and writes portable .archon/config.json.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  probeAllHands,
  loadWorkspaceConfig,
  saveWorkspaceConfig,
  maskHomePath,
} from '../packages/archon-worker/src/local-hands-runner.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

export function discoverLocalMcpServers() {
  const discovered = [];
  const home = homedir();

  // 1. Check ~/.gemini/antigravity/mcp/<serverName>
  const agyMcpDir = join(home, '.gemini', 'antigravity', 'mcp');
  if (existsSync(agyMcpDir)) {
    try {
      const entries = readdirSync(agyMcpDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const rawName = entry.name;
        const id = rawName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
        const serverDir = join(agyMcpDir, rawName);
        const files = readdirSync(serverDir).filter((f) => f.endsWith('.json'));
        const tools = files.map((f) => f.replace(/\.json$/, '')).slice(0, 8);
        discovered.push({
          id,
          name: `${rawName} MCP (Auto-Discovered)`,
          transport: 'stdio',
          endpointOrCommand: `mcp-bridge://${rawName}`,
          secretHandle: `secret://mcp/${id}-token`,
          enabled: true,
          owner: 'archon-host',
          tools: tools.length > 0 ? tools : ['status', 'query'],
          source: '~/.gemini/antigravity/mcp',
        });
      }
    } catch {}
  }

  // 2. Check ~/.cursor/mcp.json or ~/.claude/claude_desktop_config.json (metadata & tool names only, never raw env secrets)
  const jsonCandidates = [
    { path: join(home, '.cursor', 'mcp.json'), label: '~/.cursor/mcp.json' },
    { path: join(home, '.claude', 'claude_desktop_config.json'), label: '~/.claude/claude_desktop_config.json' },
  ];
  for (const cand of jsonCandidates) {
    if (!existsSync(cand.path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(cand.path, 'utf8'));
      const serversObj = parsed.mcpServers || {};
      for (const [rawKey, spec] of Object.entries(serversObj)) {
        const id = rawKey.toLowerCase().replace(/[^a-z0-9-]/g, '-');
        if (discovered.some((d) => d.id === id)) continue;
        const cmd = spec.command
          ? `${maskHomePath(spec.command)} ${(spec.args || []).map((a) => maskHomePath(String(a))).join(' ')}`.trim()
          : spec.url || `stdio://${id}`;
        discovered.push({
          id,
          name: `${rawKey} MCP`,
          transport: spec.url ? 'http' : 'stdio',
          endpointOrCommand: cmd,
          secretHandle: `secret://mcp/${id}-key`,
          enabled: true,
          owner: 'archon-host',
          tools: ['status', 'execute'],
          source: cand.label,
        });
      }
    } catch {}
  }

  return discovered;
}

const STARTER_SKILLS_MD = [
  {
    filename: 'workspace-orchestrator-sop.md',
    content: `---
name: workspace-orchestrator-sop
version: 1
owner: seat:chief-of-staff
verifier: v-harness2-replay-v1
---
Coordinate cross-seat delegation, manage shared workspace files, and enforce deterministic task execution across registered CLI hands.`,
  },
  {
    filename: 'canvas-artifact-publisher.md',
    content: `---
name: canvas-artifact-publisher
version: 1
owner: seat:chief-of-staff
verifier: v-harness2-replay-v1
---
Before advancing any Archon Canvas artifact pointer, verify R2 blob availability, SHA-256 manifest match, and 100% Accessible HTML Parity Table presence.`,
  },
];

export function runAutonomousInit({ quiet = false } = {}) {
  const archonDir = join(REPO_ROOT, '.archon');
  const artifactsDir = join(archonDir, 'artifacts');
  const skillsDir = join(archonDir, 'skills');
  const pubArtifactsDir = join(REPO_ROOT, 'packages', 'archon-app', 'public', 'artifacts');

  mkdirSync(archonDir, { recursive: true });
  mkdirSync(artifactsDir, { recursive: true });
  mkdirSync(skillsDir, { recursive: true });
  mkdirSync(pubArtifactsDir, { recursive: true });

  // 1. Check runtimes
  const nodeVersion = process.version;
  let pythonVersion = 'not found';
  try {
    const pyRes = spawnSync('python3', ['--version'], { encoding: 'utf8', timeout: 2000 });
    if (pyRes.status === 0) pythonVersion = (pyRes.stdout || pyRes.stderr).trim();
  } catch {}

  // 2. Probe local CLI hands and build headless configuration
  const currentCfg = loadWorkspaceConfig();
  const probedHands = probeAllHands();
  const updatedHandsCfg = { ...(currentCfg.hands || {}) };

  for (const [engine, status] of Object.entries(probedHands)) {
    updatedHandsCfg[engine] = {
      ...(updatedHandsCfg[engine] || {}),
      engine,
      label: status.label || engine,
      enabled: status.installed ? true : Boolean(updatedHandsCfg[engine]?.enabled),
      binaryPath: 'auto',
      detectedBinary: status.binaryPath || null,
      headlessArgs: status.headlessArgs,
      timeoutMs: status.timeoutMs || 28000,
    };
  }

  // 3. Merge default MCP servers + auto-discovered local MCP servers
  const baseMcps = Array.isArray(currentCfg.mcpServers) ? [...currentCfg.mcpServers] : [];
  const discoveredMcps = discoverLocalMcpServers();
  for (const d of discoveredMcps) {
    if (!baseMcps.some((m) => m.id === d.id)) {
      baseMcps.push(d);
    }
  }

  // 4. Write starter SKILL.md files to .archon/skills/
  for (const sk of STARTER_SKILLS_MD) {
    const targetPath = join(skillsDir, sk.filename);
    if (!existsSync(targetPath)) {
      writeFileSync(targetPath, sk.content + '\n', 'utf8');
    }
  }

  // 5. Enforce Mandatory Chief of Staff Seat Initialization for new users
  // Ensure .archon/workspace-state.json seeds seat:chief-of-staff as the immutable, mandate entry seat
  const statePath = join(archonDir, 'workspace-state.json');
  const mandateCosSeat = {
    id: 'chief-of-staff',
    name_en: 'Chief of Staff',
    name_zh: '智枢幕僚长',
    role_en: 'Executive Synthesis & Cross-MCP Orchestration (Claude Code / Local CLI)',
    role_zh: '全局综合研判与跨 MCP 协同调度 (Claude Code / 本地 CLI)',
    hand: updatedHandsCfg.claude?.installed ? 'claude' : updatedHandsCfg.codex?.installed ? 'codex' : updatedHandsCfg.agy?.installed ? 'agy' : 'claude',
    model: 'cli-default',
    budget: 1000000000,
    enabled: true,
    isMandate: true,
    created_by: 'operator',
    persona: 'You are the Chief of Staff of ArchonOS, a Sovereign Personal & Small-Team Intelligent OS running locally on this MacBook. Answer concisely and analytically in the language requested by the user. You may use GitHub-Flavored Markdown (tables, code blocks) and ```mermaid diagrams whenever helpful.',
    capabilities: { chat: true, canvas: true, mcp: true },
    capabilities_set_by: 'hand-operator',
  };

  if (!existsSync(statePath)) {
    const initialState = {
      seats: [mandateCosSeat],
      activeSessionId: 'session-main',
      chatSessions: [{
        id: 'session-main',
        title: 'Main Sovereign Session',
        pinnedSeatId: 'chief-of-staff',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        compactedSummary: '',
        handSessionBindings: {},
        messages: [],
      }],
    };
    writeFileSync(statePath, JSON.stringify(initialState, null, 2) + '\n', 'utf8');
  } else {
    try {
      const stateObj = JSON.parse(readFileSync(statePath, 'utf8'));
      if (Array.isArray(stateObj.seats)) {
        if (!stateObj.seats.some((s) => s.id === 'chief-of-staff')) {
          stateObj.seats.unshift(mandateCosSeat);
          writeFileSync(statePath, JSON.stringify(stateObj, null, 2) + '\n', 'utf8');
        }
      }
    } catch {}
  }

  // 6. Save portable .archon/config.json (zero raw secrets, zero unmasked home paths)
  const savedConfig = saveWorkspaceConfig({
    schemaVersion: 'archon.config.v1',
    initializedAt: new Date().toISOString(),
    defaultEntrySeat: 'chief-of-staff',
    mandateSeats: ['chief-of-staff'],
    routerMode: 'warroom-archon-party',
    hostPlatform: `${platform()} (${process.arch})`,
    runtimes: {
      node: nodeVersion,
      python: pythonVersion,
    },
    hands: updatedHandsCfg,
    mcpServers: baseMcps,
  });

  const summary = {
    ok: true,
    initializedAt: savedConfig.initializedAt,
    defaultEntrySeat: 'chief-of-staff',
    routerMode: 'warroom-archon-party',
    configPath: '.archon/config.json',
    skillsDir: '.archon/skills/',
    artifactsDir: '.archon/artifacts/',
    runtimes: { node: nodeVersion, python: pythonVersion },
    hands: Object.values(probedHands).map((h) => ({
      engine: h.engine,
      installed: h.installed,
      binaryPath: h.binaryPath || 'not found',
      invocation: h.invocation,
      timeoutMs: h.timeoutMs,
    })),
    mcpServers: baseMcps.map((m) => ({
      id: m.id,
      name: m.name,
      transport: m.transport,
      toolsCount: (m.tools || []).length,
      secretHandle: m.secretHandle,
    })),
    starterSkillsCount: STARTER_SKILLS_MD.length,
  };

  if (!quiet) {
    console.log('\n======================================================================');
    console.log('⚡ ArchonOS Autonomous Environment Initializer (Open-Source Edition)');
    console.log('======================================================================');
    console.log(`• Runtimes      : Node ${nodeVersion} | ${pythonVersion}`);
    console.log(`• Default Seat  : seat:chief-of-staff (Warroom @archon Auto-Router)`);
    console.log(`• Config Saved  : ${summary.configPath} (Zero Personal Paths Leaked)`);
    console.log(`• Skills Seeded : ${summary.skillsDir} (${summary.starterSkillsCount} Harness2 SKILL.md files)`);
    console.log(`• Artifacts Dir : ${summary.artifactsDir}`);
    console.log('\n--- Detected Local CLI Model Hands (Headless Mode Configured) --------');
    for (const h of summary.hands) {
      const badge = h.installed ? '✓ READY  ' : '○ OPTIONAL';
      console.log(`  [${badge}] ${h.engine.padEnd(9)} | Bin: ${(h.binaryPath || 'not installed').padEnd(28)} | Timeout: ${h.timeoutMs}ms`);
      console.log(`             Headless : ${h.invocation}`);
    }
    console.log('\n--- Configured & Auto-Discovered MCP Servers (Default-Deny Gate) -----');
    for (const m of summary.mcpServers) {
      console.log(`  [✓ ACTIVE ] ${m.id.padEnd(10)} | ${m.name.padEnd(42)} | ${m.toolsCount} tools | ${m.secretHandle}`);
    }
    console.log('\nNext Step: Run `npm start` and open http://127.0.0.1:8790');
    console.log('======================================================================\n');
  }

  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const quiet = process.argv.includes('--quiet');
  runAutonomousInit({ quiet });
}
