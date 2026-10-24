import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maritimeWindow, validateMaritimeSnapshot } from '../src/vortexa-freshness.mjs';

function sample(now) {
  const { start, end } = maritimeWindow(now);
  const dailyDates = Array.from({ length: 20 }, (_, i) => new Date(Date.parse(start) + i * 86400000).toISOString().slice(0, 10));
  return { source: 'Vortexa MCP', sourceRetrievedAt: now.toISOString(), windowStart: start, windowEnd: end, dailyDates,
    chokepoints: ['hormuz', 'malacca'].map(id => ({ id, source: [{ body: { filter_time_max: end } }, { body: { time_max: end } }],
      daily_mbd: Array(20).fill(0), daily_cargoes: Array(20).fill(0), daily_transits: Array(20).fill(0) })),
    corridors: [{ period: 'start..' + end, mbd: 1, source: [{ body: { filter_time_max: end } }] }],
  };
}
test('rollover uses the last closed UTC day across month, year, leap-day boundaries', () => {
  assert.deepEqual(maritimeWindow(new Date('2026-10-24T00:30:00Z')), { start: '2026-10-04', end: '2026-10-23' });
  assert.equal(maritimeWindow(new Date('2027-01-01T00:00:00Z')).end, '2026-12-31');
  assert.equal(maritimeWindow(new Date('2028-03-01T00:00:00Z')).end, '2028-02-29');
});
test('new publication time cannot make old observations fresh; zeros remain valid reported observations', () => {
  const now = new Date('2026-10-24T08:00:00Z');
  const data = sample(now);
  assert.equal(validateMaritimeSnapshot(data, now), null);
  assert.equal(validateMaritimeSnapshot({ ...data, windowEnd: '2026-10-21' }, now), 'stale_observation_window');
  assert.equal(validateMaritimeSnapshot({ ...data, source: 'fixture' }, now), 'missing_source_provenance');
  const relabelled = sample(now); relabelled.chokepoints[0].source[0].body.filter_time_max = '2026-10-21';
  assert.equal(validateMaritimeSnapshot(relabelled, now), 'stale_source_query');
  data.dailyDates[19] = data.dailyDates[18];
  assert.equal(validateMaritimeSnapshot(data, now), 'non_contiguous_dates');
});
test('missing daily values and stale corridor dates fail validation', () => {
  const now = new Date('2026-10-24T08:00:00Z'), data = sample(now);
  data.chokepoints[0].daily_mbd.pop();
  assert.equal(validateMaritimeSnapshot(data, now), 'invalid_daily_values');
  const other = sample(now); other.corridors[0].period = 'start..2026-10-21';
  assert.equal(validateMaritimeSnapshot(other, now), 'invalid_corridor_window');
});
