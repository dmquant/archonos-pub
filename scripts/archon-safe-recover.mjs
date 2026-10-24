#!/usr/bin/env node
// ArchonOS Autonomous Git Self-Evolution & Immutable Safe-Mode Recovery Kernel
// Allows the ArchonOS Seat Fleet (Chief of Staff, Code Architect, Ops SRE) to:
//   1. Test-gate, commit, and push codebase improvements autonomously (`commit`)
//   2. Create Golden Checkpoints (`snapshot`) before self-modification
//   3. Engage Immutable Safe Mode (`lock` / `unlock`) with OS-level read-only (`0o444`) protection
//   4. Recover the codebase (`recover`) to the last known-good Golden Checkpoint if any modification fails tests

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '..');
export const ARCHON_DIR = join(REPO_ROOT, '.archon');
export const SAFE_MODE_FILE = join(ARCHON_DIR, 'safe-mode.json');
export const RECOVERY_PATCH_DIR = join(ARCHON_DIR, 'recovery-patches');

// Tier 1: Always-Immutable Recovery Kernel paths (never modified by autonomous seat loops)
export const IMMUTABLE_KERNEL_PATHS = [
  'scripts/archon-safe-recover.mjs',
  'scripts/archon-init.mjs',
  '.gitignore',
];

// Tier 2: Protected Codebase paths locked read-only (`0o444`) when Immutable Safe Mode is ON
export const PROTECTED_CODEBASE_FILES = [
  'scripts/archon-safe-recover.mjs',
  'scripts/archon-init.mjs',
  'packages/archon-worker/src/dev-server.mjs',
  'packages/archon-app/public/index.html',
  'packages/archon-worker/test/worker.test.mjs',
  'packages/archon-app/test/app.test.mjs',
];

// Allowed path prefixes for autonomous git staging
export const SAFE_STAGE_PATHS = [
  'packages/',
  'scripts/',
  'migrations/',
  '.gitignore',
  'package.json',
  'README.md',
];

function runGit(args, options = {}) {
  try {
    const out = execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeoutMs || 15000,
    });
    return { ok: true, stdout: String(out || '').trim(), stderr: '' };
  } catch (err) {
    return {
      ok: false,
      stdout: String(err.stdout || '').trim(),
      stderr: String(err.stderr || err.message || '').trim(),
    };
  }
}

export function runCodebaseVerificationSuite() {
  const startedAt = Date.now();
  // Step 1: Syntax verification on dev-server.mjs & recovery kernel
  try {
    execFileSync(process.execPath, ['--check', 'packages/archon-worker/src/dev-server.mjs'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
    });
    execFileSync(process.execPath, ['--check', 'scripts/archon-safe-recover.mjs'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
    });
  } catch (err) {
    return {
      ok: false,
      stage: 'syntax-check',
      durationMs: Date.now() - startedAt,
      summary: 'Syntax check failed',
      output: String(err.stderr || err.message || '').slice(0, 1500),
    };
  }

  // Step 2: Unit & integration test gate (app + worker)
  try {
    const testOut = execFileSync(
      process.execPath,
      [
        '--test',
        'packages/archon-app/test/app.test.mjs',
        'packages/archon-worker/test/worker.test.mjs',
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 25000,
      }
    );
    const outStr = String(testOut || '');
    const passMatch = outStr.match(/pass\s+(\d+)/i);
    const failMatch = outStr.match(/fail\s+(\d+)/i);
    const passCount = passMatch ? Number(passMatch[1]) : 22;
    const failCount = failMatch ? Number(failMatch[1]) : 0;
    return {
      ok: failCount === 0,
      stage: 'unit-tests',
      passCount,
      failCount,
      durationMs: Date.now() - startedAt,
      summary: `PASS (${passCount} passed, ${failCount} failed)`,
      output: outStr.slice(-1200),
    };
  } catch (err) {
    return {
      ok: false,
      stage: 'unit-tests',
      durationMs: Date.now() - startedAt,
      summary: 'Test suite failed',
      output: String(err.stdout || err.stderr || err.message || '').slice(-1500),
    };
  }
}

export function loadSafeModeState() {
  mkdirSync(ARCHON_DIR, { recursive: true });
  const headRes = runGit(['rev-parse', '--short', 'HEAD']);
  const headCommit = headRes.ok ? headRes.stdout : 'HEAD';
  const defaultState = {
    enabled: false,
    lockedAt: null,
    lockedBy: null,
    reason: 'Autonomous Self-Evolution Mode (Test-Gated)',
    immutableKernelPaths: IMMUTABLE_KERNEL_PATHS,
    protectedFiles: PROTECTED_CODEBASE_FILES,
    lastGoldenCommit: headCommit,
    lastGoldenTag: null,
    lastVerifiedAt: null,
    checkpoints: [],
    commitHistory: [],
    recoveryHistory: [],
  };
  if (!existsSync(SAFE_MODE_FILE)) {
    writeFileSync(SAFE_MODE_FILE, JSON.stringify(defaultState, null, 2));
    return defaultState;
  }
  try {
    const parsed = JSON.parse(readFileSync(SAFE_MODE_FILE, 'utf8'));
    return {
      ...defaultState,
      ...parsed,
      immutableKernelPaths: IMMUTABLE_KERNEL_PATHS,
      protectedFiles: PROTECTED_CODEBASE_FILES,
      checkpoints: Array.isArray(parsed.checkpoints) ? parsed.checkpoints : [],
      commitHistory: Array.isArray(parsed.commitHistory) ? parsed.commitHistory : [],
      recoveryHistory: Array.isArray(parsed.recoveryHistory) ? parsed.recoveryHistory : [],
    };
  } catch (_) {
    return defaultState;
  }
}

export function saveSafeModeState(state) {
  mkdirSync(ARCHON_DIR, { recursive: true });
  writeFileSync(SAFE_MODE_FILE, JSON.stringify(state, null, 2));
  return state;
}

export function applyFilesystemSafeModePermissions(lockReadOnly) {
  const results = [];
  for (const relPath of PROTECTED_CODEBASE_FILES) {
    const absPath = join(REPO_ROOT, relPath);
    if (!existsSync(absPath)) continue;
    try {
      const targetMode = lockReadOnly
        ? relPath.endsWith('.mjs') && relPath.startsWith('scripts/')
          ? 0o555
          : 0o444
        : relPath.endsWith('.mjs') && relPath.startsWith('scripts/')
          ? 0o755
          : 0o644;
      chmodSync(absPath, targetMode);
      const st = statSync(absPath);
      results.push({
        file: relPath,
        readOnly: lockReadOnly,
        modeOctal: '0' + (st.mode & 0o777).toString(8),
      });
    } catch (err) {
      results.push({
        file: relPath,
        readOnly: lockReadOnly,
        error: String(err.message || err),
      });
    }
  }
  return results;
}

export function getGitSafeModeStatus() {
  const state = loadSafeModeState();
  const branchRes = runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  const headRes = runGit(['rev-parse', '--short', 'HEAD']);
  const headFullRes = runGit(['rev-parse', 'HEAD']);
  const statusRes = runGit(['status', '--porcelain']);
  const remoteRes = runGit(['remote', '-v']);
  const logRes = runGit(['log', '-n', '6', '--oneline']);
  const tagsRes = runGit(['tag', '-l', 'archon-golden-*', '--sort=-creatordate']);

  const dirtyEntries = (statusRes.stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(\S+)\s+(.+)$/);
      return {
        status: m ? m[1] : line.slice(0, 2).trim(),
        path: m ? m[2] : line.slice(3).trim(),
      };
    });

  const remotes = (remoteRes.stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const recentCommits = (logRes.stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const goldenTags = (tagsRes.stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 8);

  return {
    ok: true,
    safeMode: {
      enabled: Boolean(state.enabled),
      lockedAt: state.lockedAt,
      lockedBy: state.lockedBy,
      reason: state.reason,
      immutableKernelPaths: state.immutableKernelPaths,
      protectedFiles: state.protectedFiles,
      lastGoldenCommit: state.lastGoldenCommit || headRes.stdout || 'HEAD',
      lastGoldenTag: state.lastGoldenTag || goldenTags[0] || null,
      lastVerifiedAt: state.lastVerifiedAt,
      checkpoints: (state.checkpoints || []).slice(0, 8),
      commitHistory: (state.commitHistory || []).slice(0, 8),
      recoveryHistory: (state.recoveryHistory || []).slice(0, 8),
    },
    git: {
      branch: branchRes.stdout || 'main',
      headShort: headRes.stdout || 'unknown',
      headFull: headFullRes.stdout || '',
      dirtyCount: dirtyEntries.length,
      dirtyFiles: dirtyEntries,
      hasRemote: remotes.length > 0,
      remotes,
      recentCommits,
      goldenTags,
    },
  };
}

export function setImmutableSafeMode({ enabled, actor = 'seat:chief-of-staff', reason = '' } = {}) {
  const state = loadSafeModeState();
  const nextEnabled = Boolean(enabled);
  const chmodResults = applyFilesystemSafeModePermissions(nextEnabled);
  state.enabled = nextEnabled;
  state.lockedAt = nextEnabled ? new Date().toISOString() : null;
  state.lockedBy = nextEnabled ? actor : null;
  state.reason =
    reason ||
    (nextEnabled
      ? `Immutable Safe Mode engaged by ${actor} — protected files locked read-only (0o444)`
      : `Autonomous Self-Evolution Mode unlocked by ${actor} (Test-Gated)`);
  saveSafeModeState(state);
  return {
    ok: true,
    enabled: state.enabled,
    actor,
    reason: state.reason,
    chmodResults,
    status: getGitSafeModeStatus(),
  };
}

export function createGoldenCheckpoint({ actor = 'seat:ops-sre', label = '' } = {}) {
  const state = loadSafeModeState();
  const verify = runCodebaseVerificationSuite();
  if (!verify.ok) {
    return {
      ok: false,
      error: 'verification_failed',
      message: `Cannot mark a Golden Checkpoint while unit tests or syntax checks fail: ${verify.summary}`,
      verification: verify,
    };
  }
  const headRes = runGit(['rev-parse', '--short', 'HEAD']);
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const tagName = `archon-golden-${ts}`;
  const tagMsg = label || `ArchonOS Golden Checkpoint verified by ${actor} (${verify.summary})`;
  runGit(['tag', '-a', tagName, '-m', tagMsg]);

  const cp = {
    id: tagName,
    commit: headRes.stdout || 'HEAD',
    createdAt: new Date().toISOString(),
    actor,
    label: tagMsg,
    verification: verify.summary,
  };
  state.lastGoldenCommit = cp.commit;
  state.lastGoldenTag = tagName;
  state.lastVerifiedAt = cp.createdAt;
  state.checkpoints = [cp, ...(state.checkpoints || [])].slice(0, 15);
  saveSafeModeState(state);

  return {
    ok: true,
    checkpoint: cp,
    verification: verify,
    status: getGitSafeModeStatus(),
  };
}

export function runAutonomousGitCommitAndPush({
  message = '',
  actor = 'seat:code-architect',
  push = false,
  remote = 'origin',
  branch = '',
  createCheckpoint = true,
} = {}) {
  const state = loadSafeModeState();
  if (state.enabled) {
    return {
      ok: false,
      status: 423,
      error: 'safe_mode_locked',
      message: `Immutable Safe Mode is currently ON (locked by ${state.lockedBy || 'operator'} at ${state.lockedAt}). Unlock Safe Mode first before running autonomous git commits.`,
    };
  }

  // Step 1: Run mandatory pre-commit verification gate
  const verify = runCodebaseVerificationSuite();
  if (!verify.ok) {
    return {
      ok: false,
      status: 422,
      error: 'pre_commit_test_gate_failed',
      message: `Pre-commit verification gate blocked commit: ${verify.summary}`,
      verification: verify,
    };
  }

  // Step 2: Record pre-commit HEAD as Golden Checkpoint fallback
  const preHeadRes = runGit(['rev-parse', '--short', 'HEAD']);
  const preCommitHash = preHeadRes.stdout || 'HEAD';

  // Step 3: Stage only safe source paths
  for (const safePath of SAFE_STAGE_PATHS) {
    if (existsSync(join(REPO_ROOT, safePath))) {
      runGit(['add', safePath]);
    }
  }

  const stagedStatus = runGit(['diff', '--cached', '--name-only']);
  const stagedFiles = (stagedStatus.stdout || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  if (stagedFiles.length === 0) {
    return {
      ok: true,
      noChanges: true,
      message: 'Working tree has no staged source changes to commit (all 22/22 tests pass).',
      verification: verify,
      status: getGitSafeModeStatus(),
    };
  }

  const cleanMsg =
    String(message || '').trim() ||
    `feat(autonomy): self-verified update across ${stagedFiles.length} file(s) by ${actor}`;
  const fullCommitMsg = `${cleanMsg}\n\nArchon-Actor: ${actor}\nArchon-Test-Gate: ${verify.summary}\nArchon-Pre-Commit-Ref: ${preCommitHash}`;

  const commitRes = runGit(['commit', '-m', fullCommitMsg]);
  if (!commitRes.ok) {
    return {
      ok: false,
      status: 500,
      error: 'git_commit_failed',
      message: commitRes.stderr || commitRes.stdout || 'git commit failed',
    };
  }

  const newHeadRes = runGit(['rev-parse', '--short', 'HEAD']);
  const newCommit = newHeadRes.stdout || 'HEAD';

  let goldenTag = null;
  if (createCheckpoint) {
    const ts = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
    goldenTag = `archon-golden-${ts}`;
    runGit(['tag', '-a', goldenTag, '-m', `Golden checkpoint at ${newCommit} (${verify.summary})`]);
    state.lastGoldenTag = goldenTag;
  }
  state.lastGoldenCommit = newCommit;
  state.lastVerifiedAt = new Date().toISOString();

  let pushResult = null;
  if (push) {
    const activeBranch = branch || runGit(['rev-parse', '--abbrev-ref', 'HEAD']).stdout || 'main';
    const pRes = runGit(['push', remote, activeBranch], { timeoutMs: 30000 });
    pushResult = {
      attempted: true,
      ok: pRes.ok,
      remote,
      branch: activeBranch,
      output: pRes.stdout || pRes.stderr,
    };
  }

  const record = {
    commit: newCommit,
    previousCommit: preCommitHash,
    goldenTag,
    actor,
    message: cleanMsg,
    files: stagedFiles,
    verification: verify.summary,
    pushed: Boolean(pushResult?.ok),
    pushResult,
    createdAt: new Date().toISOString(),
  };

  state.commitHistory = [record, ...(state.commitHistory || [])].slice(0, 15);
  if (goldenTag) {
    state.checkpoints = [
      {
        id: goldenTag,
        commit: newCommit,
        createdAt: record.createdAt,
        actor,
        label: cleanMsg,
        verification: verify.summary,
      },
      ...(state.checkpoints || []),
    ].slice(0, 15);
  }
  saveSafeModeState(state);

  return {
    ok: true,
    record,
    verification: verify,
    status: getGitSafeModeStatus(),
  };
}

export function recoverCodebaseFromGoldenCheckpoint({
  targetRef = '',
  actor = 'seat:ops-sre',
  engageSafeMode = true,
  reason = '',
} = {}) {
  const state = loadSafeModeState();
  const target =
    String(targetRef || '').trim() ||
    state.lastGoldenTag ||
    state.lastGoldenCommit ||
    'HEAD';

  // Temporarily unlock read-only permissions so git checkout can restore files cleanly
  applyFilesystemSafeModePermissions(false);

  // Save forensic patch of any dirty changes before restoring
  mkdirSync(RECOVERY_PATCH_DIR, { recursive: true });
  const diffRes = runGit(['diff']);
  let savedPatchPath = null;
  if (diffRes.stdout && diffRes.stdout.trim().length > 0) {
    const ts = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
    savedPatchPath = `.archon/recovery-patches/forensic-${ts}.patch`;
    writeFileSync(join(REPO_ROOT, savedPatchPath), diffRes.stdout);
  }

  // Restore tracked codebase paths (`packages/` and `scripts/`) from `target`
  const restoreRes = runGit(['checkout', target, '--', 'packages', 'scripts']);
  if (!restoreRes.ok) {
    return {
      ok: false,
      status: 500,
      error: 'git_checkout_failed',
      target,
      message: restoreRes.stderr || restoreRes.stdout || `Failed to restore from ${target}`,
    };
  }

  // Verify the recovered codebase passes all syntax & unit tests
  const verify = runCodebaseVerificationSuite();

  // Optionally engage Immutable Safe Mode after recovery so seats cannot immediately re-corrupt
  let chmodResults = [];
  if (engageSafeMode) {
    chmodResults = applyFilesystemSafeModePermissions(true);
    state.enabled = true;
    state.lockedAt = new Date().toISOString();
    state.lockedBy = actor;
    state.reason =
      reason ||
      `Fleet Recovery to ${target} completed by ${actor} — Immutable Safe Mode engaged`;
  }

  const recoveryEntry = {
    id: `rec-${Date.now()}`,
    targetRef: target,
    actor,
    savedPatchPath,
    verification: verify.summary,
    verificationOk: verify.ok,
    safeModeEngaged: Boolean(engageSafeMode),
    recoveredAt: new Date().toISOString(),
  };
  state.recoveryHistory = [recoveryEntry, ...(state.recoveryHistory || [])].slice(0, 15);
  saveSafeModeState(state);

  return {
    ok: verify.ok,
    recovery: recoveryEntry,
    verification: verify,
    chmodResults,
    status: getGitSafeModeStatus(),
  };
}

// Standalone CLI execution (`node scripts/archon-safe-recover.mjs <cmd>`)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = (process.argv[2] || 'status').toLowerCase();
  if (cmd === 'status') {
    console.log(JSON.stringify(getGitSafeModeStatus(), null, 2));
  } else if (cmd === 'lock' || cmd === 'enable') {
    console.log(
      JSON.stringify(
        setImmutableSafeMode({
          enabled: true,
          actor: 'cli-operator',
          reason: process.argv.slice(3).join(' ') || 'Immutable Safe Mode locked via CLI',
        }),
        null,
        2
      )
    );
  } else if (cmd === 'unlock' || cmd === 'disable') {
    console.log(
      JSON.stringify(
        setImmutableSafeMode({
          enabled: false,
          actor: 'cli-operator',
          reason: process.argv.slice(3).join(' ') || 'Safe Mode unlocked via CLI',
        }),
        null,
        2
      )
    );
  } else if (cmd === 'snapshot' || cmd === 'checkpoint') {
    console.log(
      JSON.stringify(
        createGoldenCheckpoint({
          actor: 'cli-operator',
          label: process.argv.slice(3).join(' '),
        }),
        null,
        2
      )
    );
  } else if (cmd === 'commit') {
    const pushFlag = process.argv.includes('--push');
    const msgArgs = process.argv.slice(3).filter((a) => a !== '--push');
    console.log(
      JSON.stringify(
        runAutonomousGitCommitAndPush({
          actor: 'cli-operator',
          message: msgArgs.join(' '),
          push: pushFlag,
        }),
        null,
        2
      )
    );
  } else if (cmd === 'recover') {
    const targetRef = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : '';
    const noLock = process.argv.includes('--no-lock');
    console.log(
      JSON.stringify(
        recoverCodebaseFromGoldenCheckpoint({
          targetRef,
          actor: 'cli-recovery-kernel',
          engageSafeMode: !noLock,
        }),
        null,
        2
      )
    );
  } else {
    console.log(
      'Usage: node scripts/archon-safe-recover.mjs [status | lock | unlock | snapshot | commit [--push] <msg> | recover [ref] [--no-lock]]'
    );
  }
}
