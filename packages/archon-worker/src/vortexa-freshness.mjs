// Observation dates, not publication revisions, determine maritime freshness.
export function maritimeWindow(now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 86400000);
  const start = new Date(end.getTime() - 19 * 86400000);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

export function validateMaritimeSnapshot(data, now = new Date()) {
  const target = maritimeWindow(now);
  if (!data || data.source !== 'Vortexa MCP' || !Number.isFinite(Date.parse(data.sourceRetrievedAt))) return 'missing_source_provenance';
  if (Date.parse(data.sourceRetrievedAt) > now.getTime() + 60000) return 'future_source_timestamp';
  if (data.windowEnd !== target.end || data.windowStart !== target.start) return 'stale_observation_window';
  if (!Array.isArray(data.dailyDates) || data.dailyDates.length !== 20) return 'invalid_daily_dates';
  for (let i = 0; i < 20; i++) {
    if (data.dailyDates[i] !== new Date(Date.parse(target.start) + i * 86400000).toISOString().slice(0, 10)) return 'non_contiguous_dates';
  }
  if (!Array.isArray(data.chokepoints) || !['hormuz', 'malacca'].every(id => data.chokepoints.some(c => c.id === id))) return 'missing_chokepoints';
  for (const cp of data.chokepoints) {
    if (!Array.isArray(cp.source) || !cp.source.length) return 'missing_source_provenance';
    if (!cp.source.some(s => s.body?.filter_time_max?.startsWith(target.end)) ||
        !cp.source.some(s => s.body?.time_max?.startsWith(target.end))) return 'stale_source_query';
    for (const key of ['daily_mbd', 'daily_cargoes', 'daily_transits']) {
      if (!Array.isArray(cp[key]) || cp[key].length !== 20 || cp[key].some(v => !Number.isFinite(v) || v < 0)) return 'invalid_daily_values';
    }
  }
  if (!Array.isArray(data.corridors) || !data.corridors.length || data.corridors.some(c => !c.period?.endsWith(target.end) || !Number.isFinite(c.mbd) || !c.source?.length)) return 'invalid_corridor_window';
  if (data.corridors.some(c => !c.source.some(s => s.body?.filter_time_max?.startsWith(target.end)))) return 'stale_source_query';
  return null;
}
