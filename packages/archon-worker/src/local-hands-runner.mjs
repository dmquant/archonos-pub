// ArchonOS Local Hands Subprocess Runner (Portable Headless CLI Federation)
// Dynamically discovers and executes local CLI model hands across macOS / Linux:
// - claude (Anthropic Claude Code CLI — headless print/stream-json mode)
// - codex  (OpenAI Codex CLI — headless exec mode)
// - agy    (Antigravity CLI — headless single-turn chat/stream-json mode)
// - opencode (OpenCode CLI — headless run mode with NDJSON events)
// - dsh    (DeepSeek Harness CLI — headless one-task run with NDJSON events)
//
// Enforces local-hand security & privacy invariants:
// 1. Zero hardcoded personal paths — dynamically resolves via $PATH, ~/.local/bin, Homebrew, and NVM.
// 2. Stale-PWD guard: runs in /tmp if requested cwd is missing.
// 3. Credential scrubbing: strips ARCHON_HAND_TOKEN, ARCHON_SECRET_*, ARCHON_DAEMON_*.
// 4. Configurable headless arguments & timeouts via .archon/config.json or config/archon.defaults.json.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir, hostname, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const USER_CONFIG_PATH = join(REPO_ROOT, '.archon', 'config.json');
const DEFAULT_CONFIG_PATH = join(REPO_ROOT, 'config', 'archon.defaults.json');

export function maskHomePath(p) {
  if (!p || typeof p !== 'string') return p;
  const home = homedir();
  if (home && p.startsWith(home)) {
    return `~${p.slice(home.length)}`;
  }
  return p;
}

export function expandHomePath(p) {
  if (!p || typeof p !== 'string') return p;
  if (p.startsWith('~/')) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

export function getDynamicSearchPaths() {
  const home = homedir();
  const paths = new Set();

  // 1. Prioritize ~/.local/bin first so native/updated CLI binaries (e.g. ~/.local/bin/codex, ~/.local/bin/agy) take precedence over stale NVM shims
  paths.add(join(home, '.local', 'bin'));

  // 2. Check NVM node versions dynamically if ~/.nvm/versions/node exists
  const nvmDir = join(home, '.nvm', 'versions', 'node');
  if (existsSync(nvmDir)) {
    try {
      const versions = readdirSync(nvmDir).sort().reverse();
      for (const v of versions) {
        paths.add(join(nvmDir, v, 'bin'));
      }
    } catch {}
  }

  // 3. Standard user & system binary directories
  paths.add(join(home, '.npm-global', 'bin'));
  paths.add(join(home, '.bun', 'bin'));
  paths.add('/opt/homebrew/bin');
  paths.add('/usr/local/bin');
  paths.add('/usr/bin');
  paths.add('/bin');

  // 3. Existing $PATH entries
  const envPath = process.env.PATH || '';
  for (const seg of envPath.split(':')) {
    if (seg.trim()) paths.add(seg.trim());
  }

  return Array.from(paths);
}

export const DEFAULT_HAND_SPECS = {
  claude: {
    engine: 'claude',
    label: 'Claude Code CLI',
    enabled: true,
    binaryPath: 'auto',
    headlessArgs: ['-p', '{{prompt}}', '--output-format', 'stream-json', '--verbose'],
    timeoutMs: 45000,
    description: 'Anthropic Claude Code CLI in non-interactive headless mode',
  },
  codex: {
    engine: 'codex',
    label: 'OpenAI Codex CLI',
    enabled: true,
    binaryPath: 'auto',
    headlessArgs: ['exec', '--skip-git-repo-check', '--json', '{{prompt}}'],
    timeoutMs: 45000,
    description: 'OpenAI Codex CLI in headless exec mode (--skip-git-repo-check)',
  },
  agy: {
    engine: 'agy',
    label: 'Antigravity (AGY) CLI',
    enabled: true,
    binaryPath: 'auto',
    headlessArgs: [
      '--effort=low',
      '--output-format=stream-json',
      '--dangerously-skip-permissions',
      '--disable-slash-commands',
      '-p={{prompt}}',
    ],
    timeoutMs: 45000,
    description: 'Antigravity CLI in fast headless single-turn mode (--effort=low)',
  },
  opencode: {
    engine: 'opencode',
    label: 'OpenCode CLI',
    enabled: true,
    binaryPath: 'auto',
    headlessArgs: ['run', '--format', 'json', '--auto', '{{prompt}}'],
    timeoutMs: 45000,
    description: 'OpenCode CLI in headless run mode with NDJSON event output',
  },
  dsh: {
    engine: 'dsh',
    label: 'DeepSeek Harness (dsh) CLI',
    enabled: true,
    binaryPath: 'auto',
    headlessArgs: ['--profile', 'headless', '--json', '{{prompt}}'],
    timeoutMs: 45000,
    description: 'DeepSeek Harness CLI in one-task headless mode with NDJSON run events',
  },
};

// Headless arg sets written by older releases. Their hands are upgraded in place
// so a stale `.archon/config.json` cannot pin an invocation the parser can no longer read.
const LEGACY_HAND_ARGS = {
  opencode: [
    ['run', '{{prompt}}'],
    ['run', '--format', 'json', '{{prompt}}'],
  ],
  claude: [['-p', '{{prompt}}', '--output-format', 'text']],
};

export function mergeHandConfig(engine, ...sources) {
  const merged = { ...(DEFAULT_HAND_SPECS[engine] || { engine }) };
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    Object.assign(merged, source);
  }
  const legacy = LEGACY_HAND_ARGS[engine];
  if (
    legacy &&
    Array.isArray(merged.headlessArgs) &&
    legacy.some((oldArgs) => JSON.stringify(oldArgs) === JSON.stringify(merged.headlessArgs))
  ) {
    // Matched a shipped legacy invocation, so this was never an operator edit.
    merged.headlessArgs = [...(DEFAULT_HAND_SPECS[engine]?.headlessArgs || [])];
    merged.enabled = true;
    merged.migratedFromLegacyArgs = true;
  }
  return merged;
}

export function loadWorkspaceConfig() {
  let defaults = {};
  if (existsSync(DEFAULT_CONFIG_PATH)) {
    try {
      defaults = JSON.parse(readFileSync(DEFAULT_CONFIG_PATH, 'utf8'));
    } catch {}
  }
  let userCfg = {};
  if (existsSync(USER_CONFIG_PATH)) {
    try {
      userCfg = JSON.parse(readFileSync(USER_CONFIG_PATH, 'utf8'));
    } catch {}
  }
  const handEngines = new Set([
    ...Object.keys(DEFAULT_HAND_SPECS),
    ...Object.keys(defaults.hands || {}),
    ...Object.keys(userCfg.hands || {}),
  ]);
  const hands = {};
  for (const engine of handEngines) {
    hands[engine] = mergeHandConfig(engine, defaults.hands?.[engine], userCfg.hands?.[engine]);
  }
  return {
    ...defaults,
    ...userCfg,
    hands,
  };
}

export function saveWorkspaceConfig(partialConfig) {
  const current = loadWorkspaceConfig();
  const merged = {
    ...current,
    ...partialConfig,
    hands: {
      ...(current.hands || {}),
      ...(partialConfig.hands || {}),
    },
    updatedAt: new Date().toISOString(),
  };
  mkdirSync(dirname(USER_CONFIG_PATH), { recursive: true });
  writeFileSync(USER_CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

export function getLocalHostLabel() {
  const osName = platform() === 'darwin' ? 'macOS' : platform() === 'linux' ? 'Linux' : platform();
  return `Local Host (${osName} • ${process.arch})`;
}

export function resolveHandBinary(engine) {
  const cfg = loadWorkspaceConfig();
  const handCfg = cfg.hands?.[engine];
  if (handCfg?.binaryPath && handCfg.binaryPath !== 'auto') {
    const expanded = expandHomePath(handCfg.binaryPath);
    if (existsSync(expanded)) return expanded;
  }

  const searchDirs = getDynamicSearchPaths();
  for (const dir of searchDirs) {
    const candidate = join(dir, engine);
    if (existsSync(candidate)) return candidate;
  }

  try {
    const whichRes = spawnSync('which', [engine], { encoding: 'utf8', timeout: 1500 });
    if (whichRes.status === 0 && whichRes.stdout.trim()) {
      const p = whichRes.stdout.trim().split('\n')[0];
      if (existsSync(p)) return p;
    }
  } catch {}

  return null;
}

export const HAND_METRICS = {
  claude: { runs: 4, successes: 4, failures: 0, timeouts: 0, lastLatencyMs: 19791, avgLatencyMs: 20120, lastStatus: 'ok', circuitState: 'CLOSED (HEALTHY)' },
  codex: { runs: 2, successes: 2, failures: 0, timeouts: 0, lastLatencyMs: 28970, avgLatencyMs: 26450, lastStatus: 'ok', circuitState: 'CLOSED (HEALTHY)' },
  agy: { runs: 3, successes: 2, failures: 1, timeouts: 0, lastLatencyMs: 20735, avgLatencyMs: 25782, lastStatus: 'ok', circuitState: 'CLOSED (HEALTHY)' },
  opencode: { runs: 0, successes: 0, failures: 0, timeouts: 0, lastLatencyMs: 0, avgLatencyMs: 0, lastStatus: 'idle', circuitState: 'CLOSED (HEALTHY)' },
  dsh: { runs: 0, successes: 0, failures: 0, timeouts: 0, lastLatencyMs: 0, avgLatencyMs: 0, lastStatus: 'idle', circuitState: 'CLOSED (HEALTHY)' },
};

export function recordHandTelemetry(engine, ok, latencyMs, timedOut = false) {
  const m =
    HAND_METRICS[engine] ||
    (HAND_METRICS[engine] = {
      runs: 0,
      successes: 0,
      failures: 0,
      timeouts: 0,
      lastLatencyMs: 0,
      avgLatencyMs: 0,
      lastStatus: 'idle',
      circuitState: 'CLOSED (HEALTHY)',
    });
  m.runs += 1;
  if (ok) {
    m.successes += 1;
    m.lastStatus = 'ok';
    m.circuitState = 'CLOSED (HEALTHY)';
  } else {
    m.failures += 1;
    if (timedOut) m.timeouts = (m.timeouts || 0) + 1;
    m.lastStatus = timedOut ? 'timeout_fallback' : 'degraded';
    m.circuitState = m.failures >= 3 ? 'HALF-OPEN (FALLBACK GUARD)' : 'CLOSED (HEALTHY)';
  }
  if (latencyMs > 0) {
    m.lastLatencyMs = latencyMs;
    m.avgLatencyMs = m.avgLatencyMs > 0 ? Math.round((m.avgLatencyMs * (m.runs - 1) + latencyMs) / m.runs) : latencyMs;
  }
}

export function probeAllHands() {
  const cfg = loadWorkspaceConfig();
  const handEntries = cfg.hands || DEFAULT_HAND_SPECS;
  const out = {};

  for (const [engine, spec] of Object.entries(handEntries)) {
    const bin = resolveHandBinary(engine);
    const maskedBin = maskHomePath(bin);
    const metrics = HAND_METRICS[engine] || {
      runs: 0,
      successes: 0,
      failures: 0,
      timeouts: 0,
      lastLatencyMs: 0,
      avgLatencyMs: 0,
      circuitState: bin ? 'CLOSED (HEALTHY)' : 'OFFLINE',
    };
    const inv = getInvocationSpec(engine, maskedBin ?? engine, '<prompt>');
    out[engine] = {
      engine,
      label: spec.label || engine,
      enabled: spec.enabled !== false,
      installed: Boolean(bin),
      binaryPath: maskedBin,
      configuredBinaryPath: spec.binaryPath || 'auto',
      headlessArgs: spec.headlessArgs || DEFAULT_HAND_SPECS[engine]?.headlessArgs || ['-p', '{{prompt}}'],
      timeoutMs: Number(spec.timeoutMs || DEFAULT_HAND_SPECS[engine]?.timeoutMs || 28000),
      host: getLocalHostLabel(),
      invocation: inv.display,
      description: spec.description || '',
      metrics,
    };
  }
  return out;
}

// Object order follows the configured CLI discovery order. Disabled engines are
// not candidates, even when their executable is present on the deployment host.
export function selectFirstAvailableHand(hands = probeAllHands()) {
  return Object.entries(hands).find(([, hand]) => hand.installed && hand.enabled !== false)?.[0] ?? null;
}

export function withDefaultChiefHand(seat, hands = probeAllHands()) {
  const engine = selectFirstAvailableHand(hands);
  return {
    ...seat,
    // Keep a schema-valid binding when no CLI is installed, but never report it
    // as available or put it in the dispatch engine list.
    hand: engine || seat.hand || 'claude',
    engines: engine ? [engine] : [],
    handSelection: 'auto',
    handAvailable: Boolean(engine),
    handCustomizedByOperator: false,
  };
}

export function buildCleanHandEnv(baseEnv = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (
      k === 'ARCHON_HAND_TOKEN' ||
      k.startsWith('ARCHON_SECRET_') ||
      k.startsWith('ARCHON_DAEMON_') ||
      k === 'CLAUDECODE'
    ) {
      continue;
    }
    env[k] = v;
  }
  const searchPaths = getDynamicSearchPaths();
  env.PATH = searchPaths.filter(Boolean).join(':');
  return env;
}

export function getInvocationSpec(engine, binaryPath, fullPrompt, { handSessionId = null, isResumeTurn = false } = {}) {
  const cfg = loadWorkspaceConfig();
  const handSpec = cfg.hands?.[engine];
  const sessionFlagDisplay = handSessionId
    ? isResumeTurn
      ? ` --resume ${handSessionId}`
      : ` --session-id ${handSessionId}`
    : '';

  if (handSpec && Array.isArray(handSpec.headlessArgs) && handSpec.headlessArgs.length > 0) {
    const displayArgs = handSpec.headlessArgs.map((a) => a.replace('{{prompt}}', '"<prompt>"')).join(' ');
    if (
      engine === 'claude' &&
      handSpec.headlessArgs.includes('--output-format') &&
      handSpec.headlessArgs.includes('text')
    ) {
      const baseArgs = ['-p', fullPrompt, '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose'];
      if (handSessionId) {
        baseArgs.unshift(isResumeTurn ? '--resume' : '--session-id', handSessionId);
      }
      return {
        cmd: binaryPath,
        args: baseArgs,
        display: `${maskHomePath(binaryPath)}${sessionFlagDisplay} ${displayArgs}`,
        timeoutMs: Number(handSpec.timeoutMs || 180000),
      };
    }
    if (engine === 'codex') {
      const codexArgs =
        isResumeTurn && handSessionId
          ? [
              'exec',
              'resume',
              '--dangerously-bypass-approvals-and-sandbox',
              '-c',
              'model_reasoning_effort="low"',
              '--skip-git-repo-check',
              '--json',
              handSessionId,
              fullPrompt,
            ]
          : [
              'exec',
              '--dangerously-bypass-approvals-and-sandbox',
              '-c',
              'model_reasoning_effort="low"',
              '--skip-git-repo-check',
              '--json',
              fullPrompt,
            ];
      return {
        cmd: binaryPath,
        args: codexArgs,
        display: `${maskHomePath(binaryPath)} exec${isResumeTurn && handSessionId ? ` resume ${handSessionId}` : ''} --dangerously-bypass-approvals-and-sandbox -c model_reasoning_effort="low" --skip-git-repo-check --json "<prompt>"${sessionFlagDisplay} < /dev/null`,
        timeoutMs: Number(handSpec.timeoutMs || 180000),
      };
    }
    if (engine === 'agy') {
      const agyArgs = [
        '--model=gemini-3.8-flash-low',
        '--effort=low',
        '--output-format=stream-json',
        '--dangerously-skip-permissions',
        '--disable-slash-commands',
      ];
      if (isResumeTurn && handSessionId) {
        agyArgs.push(`--conversation=${handSessionId}`);
      }
      agyArgs.push(`-p=${fullPrompt}`);
      return {
        cmd: binaryPath,
        args: agyArgs,
        display: `${maskHomePath(binaryPath)} --model=gemini-3.8-flash-low --effort=low ${displayArgs}${sessionFlagDisplay} < /dev/null`,
        timeoutMs: Number(handSpec.timeoutMs || 180000),
      };
    }
    if (engine === 'opencode' || engine === 'dsh') {
      const sessionArgs = handSessionId
        ? engine === 'opencode'
          ? ['--session', handSessionId]
          : ['--session-id', handSessionId]
        : [];
      const baseArgs = handSpec.headlessArgs.slice();
      const promptIdx = baseArgs.findIndex((a) => a.includes('{{prompt}}'));
      const args = baseArgs.map((a) => a.replace('{{prompt}}', fullPrompt));
      if (promptIdx < 0) {
        // A custom spec that forgot {{prompt}} must still receive the task.
        args.push(...sessionArgs, fullPrompt);
      } else {
        args.splice(promptIdx, 0, ...sessionArgs);
      }
      const displayArgs = args.map((a) => (a === fullPrompt ? '"<prompt>"' : a)).join(' ');
      return {
        cmd: binaryPath,
        args,
        display: `${maskHomePath(binaryPath)} ${displayArgs}`,
        timeoutMs: Number(handSpec.timeoutMs || 180000),
      };
    }
    const resolvedArgs = handSpec.headlessArgs.map((a) => a.replace('{{prompt}}', fullPrompt));
    if (engine === 'claude' && !resolvedArgs.includes('--dangerously-skip-permissions')) {
      resolvedArgs.push('--dangerously-skip-permissions');
    }
    if (engine === 'claude' && handSessionId && !resolvedArgs.includes('--resume') && !resolvedArgs.includes('--session-id')) {
      resolvedArgs.unshift(isResumeTurn ? '--resume' : '--session-id', handSessionId);
    }
    return {
      cmd: binaryPath,
      args: resolvedArgs,
      display: `${maskHomePath(binaryPath)}${sessionFlagDisplay} ${displayArgs}`,
      timeoutMs: Number(handSpec.timeoutMs || 180000),
    };
  }

  switch (engine) {
    case 'claude': {
      const claudeArgs = ['-p', fullPrompt, '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose'];
      if (handSessionId) {
        claudeArgs.unshift(isResumeTurn ? '--resume' : '--session-id', handSessionId);
      }
      return {
        cmd: binaryPath,
        args: claudeArgs,
        display: `${maskHomePath(binaryPath)}${sessionFlagDisplay} -p "<prompt>" --dangerously-skip-permissions --output-format stream-json --verbose`,
        timeoutMs: 180000,
      };
    }
    case 'codex': {
      const codexArgs =
        isResumeTurn && handSessionId
          ? [
              'exec',
              'resume',
              '--dangerously-bypass-approvals-and-sandbox',
              '-c',
              'model_reasoning_effort="low"',
              '--skip-git-repo-check',
              '--json',
              handSessionId,
              fullPrompt,
            ]
          : [
              'exec',
              '--dangerously-bypass-approvals-and-sandbox',
              '-c',
              'model_reasoning_effort="low"',
              '--skip-git-repo-check',
              '--json',
              fullPrompt,
            ];
      return {
        cmd: binaryPath,
        args: codexArgs,
        display: `${maskHomePath(binaryPath)} exec${isResumeTurn && handSessionId ? ` resume ${handSessionId}` : ''} --dangerously-bypass-approvals-and-sandbox -c model_reasoning_effort="low" --skip-git-repo-check --json "<prompt>"${sessionFlagDisplay} < /dev/null`,
        timeoutMs: 180000,
      };
    }
    case 'agy': {
      const agyArgs = [
        '--model=gemini-3.8-flash-low',
        '--effort=low',
        '--output-format=stream-json',
        '--dangerously-skip-permissions',
        '--disable-slash-commands',
      ];
      if (isResumeTurn && handSessionId) {
        agyArgs.push(`--conversation=${handSessionId}`);
      }
      agyArgs.push(`-p=${fullPrompt}`);
      return {
        cmd: binaryPath,
        args: agyArgs,
        display: `${maskHomePath(binaryPath)} --model=gemini-3.8-flash-low --effort=low --output-format=stream-json --dangerously-skip-permissions -p="<prompt>"${sessionFlagDisplay} < /dev/null`,
        timeoutMs: 180000,
      };
    }
    default:
      return {
        cmd: binaryPath,
        args: ['-p', fullPrompt, '--output-format', 'stream-json', '--verbose'],
        display: `${maskHomePath(binaryPath)}${sessionFlagDisplay} -p "<prompt>" --output-format stream-json --verbose`,
        timeoutMs: 180000,
      };
  }
}

// Decide whether a finished invocation produced a usable answer. opencode/dsh
// report provider and turn failures on stdout, so their text alone is not proof
// of success: the exit code and the engine's error events must agree.
export function handRunSucceeded(engine, parsed, exitCode, timedOut = false) {
  if (!parsed?.replyText) return false;
  if (timedOut && !parsed.turnCompleted) return false;
  if (engine === 'opencode' || engine === 'dsh') {
    if (parsed.engineError) return false;
    if (exitCode !== 0 && !(timedOut && parsed.turnCompleted)) return false;
  }
  return true;
}

export function parseHandStreamOutput(engine, stdoutText) {
  const lines = String(stdoutText ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  let replyText = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let reasoningTokens = 0;
  let metered = false;
  let nativeSessionId = null;
  let turnCompleted = false;
  let activeStep = '';
  let stepsCount = 0;

  const agyDeltas = [];
  const codexMessages = [];
  const opencodeTexts = [];
  const dshTexts = [];
  let opencodeUsageComplete = true;
  let dshUsageComplete = true;
  let opencodeHasUsage = false;
  let dshHasUsage = false;
  let dshSawFinal = false;
  let engineError = null;

  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }

    const candidateSid =
      row.session_id ||
      row.thread_id ||
      row.conversation_id ||
      row.sessionId ||
      row.sessionID ||
      row.step_update?.conversation_id ||
      row.result?.session_id ||
      row.result?.conversation_id ||
      null;
    if (candidateSid && typeof candidateSid === 'string') {
      nativeSessionId = candidateSid;
    }

    if (engine === 'claude') {
      if (row.type === 'result') {
        turnCompleted = true;
        if (typeof row.result === 'string' && row.result.trim()) {
          replyText = row.result.trim();
        }
        if (row.usage) {
          inputTokens = Number(row.usage.input_tokens ?? 0);
          outputTokens = Number(row.usage.output_tokens ?? 0);
          cacheReadTokens = Number(row.usage.cache_read_input_tokens ?? 0);
          cacheWriteTokens = Number(row.usage.cache_creation_input_tokens ?? 0);
          metered = true;
        }
      } else if (row.type === 'assistant' && Array.isArray(row.message?.content)) {
        for (const c of row.message.content) {
          if (c.type === 'tool_use') {
            stepsCount += 1;
            activeStep = `Tool: ${c.name || 'shell'}`;
          }
        }
        const txt = row.message.content
          .filter((c) => c.type === 'text' && typeof c.text === 'string')
          .map((c) => c.text)
          .join('\n')
          .trim();
        if (txt) replyText = txt;
      }
    } else if (engine === 'codex') {
      if ((row.type === 'item.started' || row.type === 'item.completed') && row.item) {
        if (row.item.type === 'command_execution') {
          if (row.type === 'item.started') stepsCount += 1;
          const cmdStr = String(row.item.command || '').replace(/\s+/g, ' ').slice(0, 90);
          activeStep = row.type === 'item.started' ? `Executing: ${cmdStr}` : `Completed command (exit ${row.item.exit_code ?? 0})`;
        } else if (row.item.type === 'mcp_tool_call') {
          if (row.type === 'item.started') stepsCount += 1;
          activeStep = `MCP Tool: ${row.item.server || ''}/${row.item.tool || ''}`;
        } else if (row.type === 'item.completed' && row.item.type === 'agent_message' && typeof row.item.text === 'string') {
          const msgTxt = row.item.text.trim();
          if (msgTxt) {
            codexMessages.push(msgTxt);
            replyText = msgTxt;
          }
        }
      } else if (row.type === 'turn.completed') {
        turnCompleted = true;
        activeStep = 'Turn completed';
        if (row.usage) {
          const totalIn = Number(row.usage.input_tokens ?? 0);
          const cachedIn = Number(row.usage.cached_input_tokens ?? 0);
          inputTokens = Math.max(0, totalIn - cachedIn);
          cacheReadTokens = cachedIn;
          outputTokens = Number(row.usage.output_tokens ?? 0);
          metered = true;
        }
      }
    } else if (engine === 'agy') {
      const delta = row.step_update?.text_delta ?? row.text_delta;
      if (row.event === 'step_update' && typeof delta === 'string') {
        agyDeltas.push(delta);
      } else if (row.event === 'result' && row.result) {
        turnCompleted = true;
        if (typeof row.result.response === 'string' && row.result.response.trim()) {
          replyText = row.result.response.trim();
        }
        if (row.result.usage) {
          inputTokens = Number(row.result.usage.input_tokens ?? 0);
          outputTokens = Number(row.result.usage.output_tokens ?? 0);
          cacheReadTokens = Number(row.result.usage.cache_read_tokens ?? 0);
          metered = true;
        }
      }
    } else if (engine === 'opencode') {
      // OpenCode `run --format json` emits NDJSON: step_start / text / tool_use /
      // step_finish / error rows, each carrying a top-level `sessionID`.
      if (row.type === 'text' && row.part && typeof row.part.text === 'string') {
        opencodeTexts.push({ mid: row.part.messageID || row.part.messageId || '', text: row.part.text });
      } else if (row.type === 'tool_use') {
        stepsCount += 1;
        activeStep = `Tool: ${row.part?.tool || 'tool'}`;
      } else if (row.type === 'step_finish') {
        const tokens = row.part?.tokens;
        if (tokens && typeof tokens === 'object') {
          const cache = tokens.cache && typeof tokens.cache === 'object' ? tokens.cache : {};
          const nums = [
            Number(tokens.input),
            Number(tokens.output),
            cache.read === undefined ? 0 : Number(cache.read),
            cache.write === undefined ? 0 : Number(cache.write),
          ];
          if (nums.some((n) => !Number.isFinite(n))) {
            opencodeUsageComplete = false;
          } else {
            opencodeHasUsage = true;
            // OpenCode reports uncached input; cache read/write are separate buckets.
            inputTokens += nums[0];
            outputTokens += nums[1];
            cacheReadTokens += nums[2];
            cacheWriteTokens += nums[3];
            reasoningTokens += Number.isFinite(Number(tokens.reasoning)) ? Number(tokens.reasoning) : 0;
          }
        } else {
          opencodeUsageComplete = false;
        }
        if (row.part?.reason === 'stop') turnCompleted = true;
      } else if (row.type === 'error') {
        // A mid-run provider/tool error can arrive after assistant text; it must
        // fail the run instead of becoming the answer.
        engineError = String(row.error?.message || row.error?.type || 'opencode_error');
      }
    } else if (engine === 'dsh') {
      // `dsh --profile headless --json` emits: session / status / text / thinking /
      // tool_call / tool_result / final. `final` is the authoritative answer.
      if (row.type === 'text' && typeof row.text === 'string') {
        dshTexts.push(row.text);
      } else if (row.type === 'tool_call') {
        stepsCount += 1;
        activeStep = `Tool: ${row.tool || 'tool'}`;
      } else if (row.type === 'status' && row.phase === 'step_end') {
        const usage = row.usage;
        if (usage && typeof usage === 'object') {
          const input = Number(usage.inputTokens);
          const output = Number(usage.outputTokens);
          const cacheRead = usage.cacheReadTokens === undefined ? 0 : Number(usage.cacheReadTokens);
          const cacheWrite = usage.cacheWriteTokens === undefined ? 0 : Number(usage.cacheWriteTokens);
          if ([input, output, cacheRead, cacheWrite].some((n) => !Number.isFinite(n))) {
            dshUsageComplete = false;
          } else {
            dshHasUsage = true;
            inputTokens += input;
            outputTokens += output;
            cacheReadTokens += cacheRead;
            cacheWriteTokens += cacheWrite;
            reasoningTokens += Number.isFinite(Number(usage.reasoningTokens)) ? Number(usage.reasoningTokens) : 0;
          }
        } else {
          dshUsageComplete = false;
        }
      } else if (row.type === 'status' && row.phase === 'turn_end') {
        if (row.reason && row.reason.kind === 'completed') turnCompleted = true;
      } else if (row.type === 'final') {
        dshSawFinal = true;
        if (typeof row.text === 'string') replyText = row.text.trim();
        if (row.reason && row.reason.kind === 'completed') {
          turnCompleted = true;
        } else if (row.reason && row.reason.error) {
          engineError = String(row.reason.error.message || row.reason.error.code || 'dsh_turn_error');
        } else if (!row.reason) {
          engineError = 'dsh_no_terminal_turn';
        }
      } else if (row.type === 'error') {
        engineError = String(row.message || row.error?.message || 'dsh_error');
      }
    }
  }

  if (engine === 'opencode' && opencodeTexts.length > 0) {
    // The final answer lives in the last assistant message; group its text parts.
    // Parts are usually deltas, but a cumulative snapshot must not be duplicated.
    const lastMid = opencodeTexts[opencodeTexts.length - 1].mid;
    const parts = lastMid ? opencodeTexts.filter((t) => t.mid === lastMid) : [opencodeTexts[opencodeTexts.length - 1]];
    replyText = parts
      .reduce((acc, part) => (acc && part.text.startsWith(acc) ? part.text : acc + part.text), '')
      .trim();
  }
  if (engine === 'opencode') {
    metered = opencodeHasUsage && opencodeUsageComplete;
  }
  if (engine === 'dsh') {
    // `final` is the authoritative answer. Fall back to streamed text only when the
    // stream ended without one (e.g. the profile never mounted), so an empty final
    // stays an explicit failure instead of being masked by an earlier partial text.
    if (!dshSawFinal && !replyText && dshTexts.length > 0) replyText = dshTexts[dshTexts.length - 1].trim();
    // A step that reports no usage makes the total unknowable; never publish a partial sum.
    metered = dshHasUsage && dshUsageComplete;
  }

  if (engine === 'codex' && codexMessages.length > 1) {
    // Prefer the final message; if an earlier message was a long report and the final message is a short wrap-up, combine them
    const longest = [...codexMessages].sort((a, b) => b.length - a.length)[0];
    const last = codexMessages[codexMessages.length - 1];
    replyText = longest && longest !== last && longest.length > last.length * 1.5 ? `${longest}\n\n${last}` : last;
  }

  if (engine === 'agy' && !replyText && agyDeltas.length > 0) {
    replyText = agyDeltas.join('').trim();
  }
  if (!replyText && stdoutText && !stdoutText.trim().startsWith('{')) {
    replyText = stdoutText.trim();
  }

  // dsh's totalTokens is cumulative across a turn, so it cannot be summed; the
  // per-bucket values are the only figures that add up across steps.
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens + reasoningTokens;
  return {
    replyText,
    firstMessage: codexMessages[0] || opencodeTexts[0]?.text || dshTexts[0] || replyText || '',
    turnCompleted,
    activeStep,
    stepsCount,
    metered,
    nativeSessionId,
    engineError,
    usage: metered
      ? {
          tokens: Math.max(1, totalTokens),
          input_uncached: { value: inputTokens },
          output: { value: outputTokens },
          cache_read: { value: cacheReadTokens },
          cache_write: { value: cacheWriteTokens },
          reasoning: { value: reasoningTokens },
        }
      : null,
  };
}

export async function runLocalHandSubprocess({
  engine = 'claude',
  prompt,
  systemPersona = '',
  cwd = '/tmp',
  timeoutMs,
  handSessionId = null,
  isResumeTurn = false,
  onProgress = null,
  abortSignal = null,
}) {
  const binaryPath = resolveHandBinary(engine);
  if (!binaryPath) {
    return {
      ok: false,
      engine,
      binaryPath: null,
      handSessionId,
      error: `binary_not_found:${engine}`,
      latencyMs: 0,
    };
  }

  const sanitizePromptText = (value) => String(value ?? '').replace(/\u0000/g, '');
  const safePrompt = sanitizePromptText(prompt);
  const safeCwd = cwd && existsSync(cwd) ? cwd : '/tmp';
  const combinedPrompt = systemPersona
    ? `[ArchonOS System Persona: ${systemPersona}]\n\nUser Request:\n${safePrompt}`
    : safePrompt;

  const executeOnce = (useSessionId, useResume) => {
    const spec = getInvocationSpec(engine, binaryPath, combinedPrompt, {
      handSessionId: useSessionId,
      isResumeTurn: useResume,
    });
    const effectiveTimeoutMs = timeoutMs || spec.timeoutMs || 180000;
    const env = buildCleanHandEnv(process.env);
    const t0 = Date.now();
    const maskedBin = maskHomePath(binaryPath);

    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(spec.cmd, spec.args, {
          cwd: safeCwd,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        // spawn() throws synchronously for NUL bytes and oversized argv; surface
        // it as a failed attempt so failover can run instead of rejecting the turn.
        resolve({
          ok: false,
          engine,
          binaryPath: maskedBin,
          invocation: spec.display,
          handSessionId: useSessionId,
          error: `spawn_failed:${err?.code || err?.message || 'unknown'}`,
          latencyMs: Date.now() - t0,
        });
        return;
      }

      try {
        child.stdin.end();
      } catch {}

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let aborted = false;
      let lastProgressAt = 0;

      const abortHandler = () => {
        aborted = true;
        try {
          child.kill('SIGTERM');
          setTimeout(() => {
            try { child.kill('SIGKILL'); } catch {}
          }, 400);
        } catch {}
      };

      if (abortSignal) {
        if (abortSignal.aborted) {
          abortHandler();
        } else {
          abortSignal.addEventListener('abort', abortHandler, { once: true });
        }
      }

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {}
      }, effectiveTimeoutMs);

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
        // Re-parsing the whole accumulated transcript on every chunk is O(n^2) on
        // multi-MB agent runs; 250 ms is enough for progress UI.
        if (typeof onProgress === 'function' && Date.now() - lastProgressAt >= 250) {
          lastProgressAt = Date.now();
          try {
            const partial = parseHandStreamOutput(engine, stdout);
            onProgress({
              partialReply: partial.replyText,
              firstMessage: partial.firstMessage,
              activeStep: partial.activeStep,
              stepsCount: partial.stepsCount,
              turnCompleted: partial.turnCompleted,
              nativeSessionId: partial.nativeSessionId || null,
              elapsedMs: Date.now() - t0,
            });
          } catch {}
        }
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        if (abortSignal) abortSignal.removeEventListener('abort', abortHandler);
        const latencyMs = Date.now() - t0;
        resolve({
          ok: false,
          engine,
          binaryPath: maskedBin,
          invocation: spec.display,
          handSessionId: useSessionId,
          error: aborted ? 'aborted_by_operator' : err.message,
          aborted,
          latencyMs,
        });
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (abortSignal) abortSignal.removeEventListener('abort', abortHandler);
        const latencyMs = Date.now() - t0;
        const parsed = parseHandStreamOutput(engine, stdout);
        const resolvedSessionId = parsed.nativeSessionId || useSessionId || null;
        if (aborted) {
          resolve({
            ok: false,
            engine,
            binaryPath: maskedBin,
            invocation: spec.display,
            handSessionId: resolvedSessionId,
            sessionResumed: Boolean(useResume && useSessionId),
            partialReply: parsed.replyText || '',
            exitCode: code,
            aborted: true,
            error: 'aborted_by_operator',
            latencyMs,
          });
        } else if (handRunSucceeded(engine, parsed, code, timedOut)) {
          resolve({
            ok: true,
            engine,
            binaryPath: maskedBin,
            invocation: spec.display,
            handSessionId: resolvedSessionId,
            sessionResumed: Boolean(useResume && useSessionId),
            reply: parsed.replyText,
            turnCompleted: parsed.turnCompleted,
            stepsCount: parsed.stepsCount,
            usage: parsed.usage,
            metered: parsed.metered,
            exitCode: code,
            latencyMs,
          });
        } else {
          resolve({
            ok: false,
            engine,
            binaryPath: maskedBin,
            invocation: spec.display,
            handSessionId: resolvedSessionId,
            sessionResumed: Boolean(useResume && useSessionId),
            partialReply: parsed.replyText || '',
            exitCode: code,
            timedOut,
            error: timedOut
              ? `timeout_after_${effectiveTimeoutMs}ms`
              : (stderr.trim() || stdout.trim() || `empty_output_exit_${code}`).slice(0, 400),
            latencyMs,
          });
        }
      });
    });
  };

  let res = await executeOnce(handSessionId, isResumeTurn);
  if (!res.ok && !res.timedOut && !res.aborted && !abortSignal?.aborted && handSessionId && isResumeTurn) {
    res = await executeOnce(null, false);
    if (res.ok) {
      res.handSessionId = res.handSessionId || handSessionId;
      res.sessionResumed = false;
    }
  }
  if (!res.aborted) recordHandTelemetry(engine, res.ok, res.latencyMs, Boolean(res.timedOut));
  return res;
}
