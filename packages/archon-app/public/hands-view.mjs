// Presentation mapping for /api/hands/status telemetry.
//
// A freshly installed hand that has never run reports runs:0, avgLatencyMs:0 and
// circuitState:'IDLE'. That is a neutral "not measured yet" state, not a fault.
// Only OFFLINE (binary missing) is an error; HEALTHY and HALF-OPEN keep their
// green/amber meaning. Kept pure so the app tests can exercise every branch.

const STATES = Object.freeze({
  healthy: { tone: 'healthy', color: 'var(--emerald)', label: 'CLOSED (HEALTHY)' },
  fallback: { tone: 'fallback', color: 'var(--amber)', label: 'HALF-OPEN (FALLBACK GUARD)' },
  offline: { tone: 'offline', color: 'var(--crimson)', label: 'OFFLINE' },
  idle: { tone: 'idle', color: 'var(--text-muted)', label: 'IDLE' },
});

export function deriveHandTelemetryView(metrics = {}, installed = true) {
  const runs = Number(metrics.runs) || 0;
  const avgLatencyMs = Number(metrics.avgLatencyMs) || 0;
  const circuitState = String(metrics.circuitState || '').trim();
  const upper = circuitState.toUpperCase();

  let state;
  if (installed === false || upper.includes('OFFLINE')) state = 'offline';
  else if (upper.includes('HALF-OPEN')) state = 'fallback';
  else if (upper.includes('HEALTHY')) state = 'healthy';
  else state = 'idle';

  const preset = STATES[state];
  return {
    state,
    tone: preset.tone,
    color: preset.color,
    // Normalise known states so the existing bilingual rules match; unknown
    // circuit strings are shown unchanged rather than hidden.
    label: state === 'idle' && circuitState && upper !== 'IDLE' ? circuitState : preset.label,
    runs,
    avgLatencyMs,
    hasRuns: runs > 0,
    runsLabel: runs > 0 ? `${runs} ${runs === 1 ? 'run' : 'runs'}` : 'no runs yet',
    latencyLabel: avgLatencyMs > 0 ? `${avgLatencyMs}ms avg` : '—',
  };
}