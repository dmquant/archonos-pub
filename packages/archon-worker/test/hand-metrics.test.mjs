// Hand telemetry must be measured, never seeded. Before a hand has actually run
// the console shows zero runs and no health verdict; only recordHandTelemetry
// advances the counters.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HAND_METRICS,
  createIdleHandMetrics,
  recordHandTelemetry,
  probeAllHands,
} from '../src/local-hands-runner.mjs';

test('a fresh process reports zero runs and no invented latency', () => {
  for (const engine of ['claude', 'codex', 'agy', 'opencode', 'dsh']) {
    const m = HAND_METRICS[engine];
    assert.ok(m, `${engine} metrics missing`);
    assert.equal(m.runs, 0, `${engine} runs`);
    assert.equal(m.successes, 0, `${engine} successes`);
    assert.equal(m.failures, 0, `${engine} failures`);
    assert.equal(m.timeouts, 0, `${engine} timeouts`);
    assert.equal(m.lastLatencyMs, 0, `${engine} lastLatencyMs`);
    assert.equal(m.avgLatencyMs, 0, `${engine} avgLatencyMs`);
    assert.equal(m.lastStatus, 'idle', `${engine} lastStatus`);
    assert.equal(m.circuitState, 'IDLE', `${engine} circuitState`);
  }
  assert.deepEqual(createIdleHandMetrics(), {
    runs: 0,
    successes: 0,
    failures: 0,
    timeouts: 0,
    lastLatencyMs: 0,
    avgLatencyMs: 0,
    latencySamples: 0,
    totalLatencyMs: 0,
    lastStatus: 'idle',
    circuitState: 'IDLE',
  });
});

test('probeAllHands exposes the live metrics object instead of a fabricated one', () => {
  const hands = probeAllHands();
  const entries = Object.entries(hands);
  assert.ok(entries.length >= 5);
  for (const [engine, hand] of entries) {
    assert.equal(hand.metrics, HAND_METRICS[engine], `${engine} must share the live metrics object`);
  }
});

test('one real run moves the counters and the average off zero', () => {
  HAND_METRICS.claude = createIdleHandMetrics();
  recordHandTelemetry('claude', true, 1200);
  const m = HAND_METRICS.claude;
  assert.equal(m.runs, 1);
  assert.equal(m.successes, 1);
  assert.equal(m.failures, 0);
  assert.equal(m.lastLatencyMs, 1200);
  assert.equal(m.avgLatencyMs, 1200);
  assert.equal(m.lastStatus, 'ok');
  assert.equal(m.circuitState, 'CLOSED (HEALTHY)');
});

test('latency averages only the runs that actually produced a duration', () => {
  HAND_METRICS.codex = createIdleHandMetrics();
  recordHandTelemetry('codex', true, 1000);
  recordHandTelemetry('codex', false, 0); // instant failure: no duration sample
  recordHandTelemetry('codex', true, 3000);
  const m = HAND_METRICS.codex;
  assert.equal(m.runs, 3);
  assert.equal(m.failures, 1);
  assert.equal(m.latencySamples, 2);
  assert.equal(m.lastLatencyMs, 3000);
  assert.equal(m.avgLatencyMs, 2000);
});

test('rounding the displayed latency does not affect future averages', () => {
  HAND_METRICS.codex = createIdleHandMetrics();
  for (const duration of [1000, 1001, 1000]) recordHandTelemetry('codex', true, duration);
  assert.equal(HAND_METRICS.codex.avgLatencyMs, 1000);
});

test('repeated failures open the fallback guard and flag timeouts honestly', () => {
  HAND_METRICS.agy = createIdleHandMetrics();
  recordHandTelemetry('agy', false, 0, true);
  assert.equal(HAND_METRICS.agy.timeouts, 1);
  assert.equal(HAND_METRICS.agy.lastStatus, 'timeout_fallback');
  recordHandTelemetry('agy', false, 0);
  recordHandTelemetry('agy', false, 0);
  assert.equal(HAND_METRICS.agy.failures, 3);
  assert.equal(HAND_METRICS.agy.circuitState, 'HALF-OPEN (FALLBACK GUARD)');
});

test('an unknown engine starts from idle metrics rather than undefined fields', () => {
  recordHandTelemetry('gemini', true, 50);
  assert.equal(HAND_METRICS.gemini.runs, 1);
  assert.equal(HAND_METRICS.gemini.successes, 1);
  assert.equal(HAND_METRICS.gemini.avgLatencyMs, 50);
  assert.equal(HAND_METRICS.gemini.circuitState, 'CLOSED (HEALTHY)');
});