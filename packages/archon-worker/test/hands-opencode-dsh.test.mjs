import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_HAND_SPECS,
  getInvocationSpec,
  handRunSucceeded,
  mergeHandConfig,
  parseHandStreamOutput,
  probeAllHands,
  selectFirstAvailableHand,
} from '../src/local-hands-runner.mjs';

const ndjson = (rows) => rows.map((r) => JSON.stringify(r)).join('\n');

test('opencode and dsh are first-class hand specs in discovery order', () => {
  assert.deepEqual(DEFAULT_HAND_SPECS.opencode.headlessArgs, ['run', '--format', 'json', '--auto', '{{prompt}}']);
  assert.deepEqual(DEFAULT_HAND_SPECS.dsh.headlessArgs, ['--profile', 'headless', '--json', '{{prompt}}']);
  assert.equal(DEFAULT_HAND_SPECS.opencode.enabled, true);
  assert.equal(DEFAULT_HAND_SPECS.dsh.enabled, true);
  assert.equal(selectFirstAvailableHand({ opencode: { installed: true, enabled: true } }), 'opencode');
  assert.equal(selectFirstAvailableHand({ dsh: { installed: true, enabled: true } }), 'dsh');
});

test('opencode NDJSON projects the final assistant message, tool steps, and summed usage', () => {
  const parsed = parseHandStreamOutput(
    'opencode',
    ndjson([
      { type: 'step_start', sessionID: 'ses_1' },
      { type: 'tool_use', sessionID: 'ses_1', part: { tool: 'shell' } },
      { type: 'step_finish', sessionID: 'ses_1', part: { reason: 'tool-calls', tokens: { input: 100, output: 10, cache: { read: 5, write: 0 } } } },
      { type: 'text', sessionID: 'ses_1', part: { messageID: 'm2', text: 'hello ' } },
      { type: 'text', sessionID: 'ses_1', part: { messageID: 'm2', text: 'world' } },
      { type: 'step_finish', sessionID: 'ses_1', part: { reason: 'stop', tokens: { input: 200, output: 20, cache: { read: 7, write: 1 } } } },
    ])
  );
  assert.equal(parsed.replyText, 'hello world');
  assert.equal(parsed.firstMessage, 'hello ');
  assert.equal(parsed.nativeSessionId, 'ses_1');
  assert.equal(parsed.turnCompleted, true);
  assert.equal(parsed.stepsCount, 1);
  assert.equal(parsed.metered, true);
  assert.equal(parsed.usage.input_uncached.value, 300);
  assert.equal(parsed.usage.output.value, 30);
  assert.equal(parsed.usage.cache_read.value, 12);
  assert.equal(parsed.usage.cache_write.value, 1);
});

test('opencode step without tokens never publishes a partial usage sum', () => {
  const parsed = parseHandStreamOutput(
    'opencode',
    ndjson([
      { type: 'step_finish', sessionID: 'ses_2', part: { reason: 'tool-calls', tokens: { input: 100, output: 10, cache: { read: 0, write: 0 } } } },
      { type: 'text', sessionID: 'ses_2', part: { messageID: 'm1', text: 'done' } },
      { type: 'step_finish', sessionID: 'ses_2', part: { reason: 'stop' } },
    ])
  );
  assert.equal(parsed.replyText, 'done');
  assert.equal(parsed.metered, false);
  assert.equal(parsed.usage, null);
});

test('dsh NDJSON treats final text as authoritative and sums step_end usage', () => {
  const parsed = parseHandStreamOutput(
    'dsh',
    ndjson([
      { type: 'session', sessionId: 'session-abc', cwd: '/tmp' },
      { type: 'status', phase: 'step_end', usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 0 } },
      { type: 'text', text: 'intermediate' },
      { type: 'tool_call', callId: 'c1', tool: 'shell', input: {} },
      { type: 'status', phase: 'step_end', usage: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 7, cacheWriteTokens: 1 } },
      { type: 'status', phase: 'turn_end', reason: { kind: 'completed' } },
      { type: 'final', sessionId: 'session-abc', reason: { kind: 'completed' }, text: 'final answer' },
    ])
  );
  assert.equal(parsed.replyText, 'final answer');
  assert.equal(parsed.nativeSessionId, 'session-abc');
  assert.equal(parsed.turnCompleted, true);
  assert.equal(parsed.stepsCount, 1);
  assert.equal(parsed.metered, true);
  assert.equal(parsed.usage.input_uncached.value, 300);
  assert.equal(parsed.usage.output.value, 30);
  assert.equal(parsed.usage.cache_read.value, 12);
  assert.equal(parsed.usage.cache_write.value, 1);
});

test('dsh falls back to text events and never publishes partial usage', () => {
  const parsed = parseHandStreamOutput(
    'dsh',
    ndjson([
      { type: 'session', sessionId: 'session-def' },
      { type: 'status', phase: 'step_end', usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      { type: 'status', phase: 'step_end', usage: { inputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      { type: 'text', text: 'streamed answer' },
    ])
  );
  assert.equal(parsed.replyText, 'streamed answer');
  assert.equal(parsed.turnCompleted, false);
  assert.equal(parsed.metered, false);
  assert.equal(parsed.usage, null);
});

test('dsh absent cache buckets count as zero, not unmetered', () => {
  const parsed = parseHandStreamOutput(
    'dsh',
    ndjson([
      { type: 'session', sessionId: 'session-min' },
      { type: 'status', phase: 'step_end', usage: { inputTokens: 5143, outputTokens: 20, totalTokens: 5163 } },
      { type: 'final', sessionId: 'session-min', reason: { kind: 'completed' }, text: 'PONG' },
    ])
  );
  assert.equal(parsed.metered, true);
  assert.equal(parsed.usage.input_uncached.value, 5143);
  assert.equal(parsed.usage.output.value, 20);
  assert.equal(parsed.usage.cache_read.value, 0);
  assert.equal(parsed.usage.cache_write.value, 0);
});

test('dsh empty final never falls back to earlier partial text', () => {  const parsed = parseHandStreamOutput(
    'dsh',
    ndjson([
      { type: 'session', sessionId: 'session-xyz' },
      { type: 'text', text: 'partial' },
      { type: 'final', sessionId: 'session-xyz', reason: null, text: '' },
    ])
  );
  assert.equal(parsed.replyText, '');
  assert.equal(parsed.turnCompleted, false);
  assert.equal(parsed.engineError, 'dsh_no_terminal_turn');
  assert.equal(handRunSucceeded('dsh', parsed, 0), false);
});

test('probeAllHands exposes the new engines with their invocation specs', () => {
  const hands = probeAllHands();
  for (const engine of ['opencode', 'dsh']) {
    assert.ok(hands[engine], `${engine} is probed`);
    assert.equal(hands[engine].enabled, true);
    assert.ok(
      hands[engine].invocation.includes(engine === 'opencode' ? 'run --format json --auto' : '--profile headless --json'),
      `${engine} invocation: ${hands[engine].invocation}`
    );
    assert.ok(hands[engine].label);
  }
});

test('invocation specs keep native session continuation flags for both hands', () => {
  const opencode = getInvocationSpec('opencode', '/usr/local/bin/opencode', 'PROMPT', {
    handSessionId: 'ses_1',
    isResumeTurn: true,
  });
  assert.equal(opencode.args[opencode.args.length - 1], 'PROMPT');
  // The session pair is inserted immediately before the positional task, never after it.
  assert.deepEqual(opencode.args.slice(-3, -1), ['--session', 'ses_1']);
  assert.ok(opencode.args.includes('run'));

  const dsh = getInvocationSpec('dsh', '/usr/local/bin/dsh', 'PROMPT', {
    handSessionId: 'session-abc',
    isResumeTurn: true,
  });
  assert.equal(dsh.args[dsh.args.length - 1], 'PROMPT');
  assert.deepEqual(dsh.args.slice(-3, -1), ['--session-id', 'session-abc']);
  assert.ok(dsh.args.includes('--profile'));
});

test('engine error rows fail the run even when text arrived first', () => {
  const dsh = parseHandStreamOutput(
    'dsh',
    ndjson([
      { type: 'session', sessionId: 'session-err' },
      { type: 'text', text: 'partial answer' },
      { type: 'status', phase: 'turn_end', reason: { kind: 'error', error: { message: 'upstream exploded', code: 'SERVER' } } },
      { type: 'final', sessionId: 'session-err', reason: { kind: 'error', error: { message: 'upstream exploded' } }, text: 'partial answer' },
    ])
  );
  assert.equal(dsh.turnCompleted, false);
  assert.match(dsh.engineError, /upstream exploded/);
  assert.equal(handRunSucceeded('dsh', dsh, 0), false);

  const opencode = parseHandStreamOutput(
    'opencode',
    ndjson([
      { type: 'text', sessionID: 'ses_e', part: { messageID: 'm1', text: 'doing it' } },
      { type: 'error', sessionID: 'ses_e', error: { type: 'provider.auth', message: 'rate limited' } },
    ])
  );
  assert.match(opencode.engineError, /rate limited/);
  assert.equal(handRunSucceeded('opencode', opencode, 0), false);
});

test('handRunSucceeded keeps legacy engines permissive and strict engines honest', () => {
  const okParsed = { replyText: 'hello', turnCompleted: true, engineError: null };
  assert.equal(handRunSucceeded('opencode', okParsed, 0), true);
  assert.equal(handRunSucceeded('dsh', okParsed, 1), false, 'non-zero exit means the turn failed');
  assert.equal(handRunSucceeded('dsh', { ...okParsed, turnCompleted: false }, 0), true, 'completed turn text is enough');
  assert.equal(
    handRunSucceeded('claude', { replyText: 'hello', turnCompleted: false, engineError: null }, 3),
    true,
    'legacy engines keep their historical exit-code-agnostic behavior'
  );
  assert.equal(handRunSucceeded('dsh', okParsed, 0, true), true);
  assert.equal(handRunSucceeded('dsh', { ...okParsed, turnCompleted: false }, 0, true), false);
  assert.equal(handRunSucceeded('dsh', { replyText: '' }, 0), false);
});

test('mergeHandConfig migrates shipped legacy args but preserves operator edits', () => {
  const migrated = mergeHandConfig('opencode', {
    engine: 'opencode',
    enabled: false,
    headlessArgs: ['run', '--format', 'json', '{{prompt}}'],
  });
  assert.equal(migrated.enabled, true);
  assert.deepEqual(migrated.headlessArgs, DEFAULT_HAND_SPECS.opencode.headlessArgs);

  const custom = mergeHandConfig('opencode', {
    engine: 'opencode',
    headlessArgs: ['run', '--model', 'example/one', '{{prompt}}'],
  });
  assert.deepEqual(custom.headlessArgs, ['run', '--model', 'example/one', '{{prompt}}']);
  assert.equal(custom.migratedFromLegacyArgs, undefined);
});
