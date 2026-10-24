"""5-engine usage parser for archon-hands (ARC-141 / ARC-139B rules).

parse(engine, lines) -> dict of field -> {"value": n} or {"state": "unmetered", "reason": str}.
A figure that cannot be read is never 0 and never omitted (ARC-138 s2).
Normalised fields: input_uncached, cache_read, cache_write, output, wall_ms, tool_calls.
input_uncached excludes cache for every engine, so the columns can be added across engines.
Tool-call counting is UNTESTED against real streams (no run made a tool call), so it is always
unmetered here rather than guessed.
"""
import json

ENGINES = ("claude", "codex", "opencode", "agy", "gemini")
FIELDS = ("input_uncached", "cache_read", "cache_write", "output", "wall_ms", "tool_calls")


def _um(reason):
    return {"state": "unmetered", "reason": reason}


def _blank(reason):
    return {f: _um(reason) for f in FIELDS}


def _rows(lines):
    for l in lines:
        l = l.strip()
        if not l:
            continue
        try:
            o = json.loads(l)
        except ValueError:
            continue
        if isinstance(o, dict):
            yield o


def _int(v):
    return v if isinstance(v, int) and not isinstance(v, bool) and v >= 0 else None


def _fill(out, **kw):
    for k, v in kw.items():
        v = _int(v)
        if v is not None:
            out[k] = {"value": v}
    return out


def _claude(rows):
    res = [r for r in rows if r.get("type") == "result" and isinstance(r.get("usage"), dict)]
    if not res:
        return _blank("no claude result row with usage")
    r, u = res[-1], res[-1]["usage"]
    out = _blank("field absent from claude result row")
    # input_tokens excludes cache
    return _fill(out, input_uncached=u.get("input_tokens"), cache_read=u.get("cache_read_input_tokens"),
                 cache_write=u.get("cache_creation_input_tokens"), output=u.get("output_tokens"),
                 wall_ms=r.get("duration_ms"))


def _codex(rows):
    done = [r for r in rows if r.get("type") == "turn.completed" and isinstance(r.get("usage"), dict)]
    if not done:
        return _blank("no codex turn.completed with usage")
    u = done[-1]["usage"]
    out = _blank("field absent from codex turn.completed")
    cached, tot = _int(u.get("cached_input_tokens")), _int(u.get("input_tokens"))
    # input_tokens INCLUDES cached_input_tokens
    unc = tot - cached if tot is not None and cached is not None and cached <= tot else None
    _fill(out, input_uncached=unc, cache_read=cached, cache_write=u.get("cache_write_input_tokens"),
          output=u.get("output_tokens"))
    out["wall_ms"] = _um("codex stream has no duration")
    return out


def _opencode(rows):
    fin = [r for r in rows if r.get("type") == "step_finish"
           and isinstance((r.get("part") or {}).get("tokens"), dict)]
    if not fin:
        return _blank("no opencode step_finish with tokens")
    out = _blank("field absent from opencode step_finish")
    inp = out_t = rd = wr = 0
    ok = True
    for r in fin:  # one row per step: sum steps
        t = r["part"]["tokens"]
        c = t.get("cache") if isinstance(t.get("cache"), dict) else {}
        vals = [_int(t.get("input")), _int(t.get("output")), _int(c.get("read")), _int(c.get("write"))]
        if None in vals:
            ok = False
            break
        inp, out_t, rd, wr = inp + vals[0], out_t + vals[1], rd + vals[2], wr + vals[3]
    if ok:  # input excludes cache
        _fill(out, input_uncached=inp, output=out_t, cache_read=rd, cache_write=wr)
    starts = [r["timestamp"] for r in rows if r.get("type") == "step_start" and _int(r.get("timestamp")) is not None]
    ends = [r["timestamp"] for r in fin if _int(r.get("timestamp")) is not None]
    if starts and ends and max(ends) >= min(starts):
        out["wall_ms"] = {"value": max(ends) - min(starts)}
    else:
        out["wall_ms"] = _um("no step timestamps")
    return out


def _agy(rows):
    res = [r for r in rows if r.get("event") == "result" and isinstance(r.get("result"), dict)
           and isinstance(r["result"].get("usage"), dict)]
    if not res:
        return _blank("no agy result event with usage")
    body = res[-1]["result"]
    u = body["usage"]
    out = _blank("field absent from agy result")
    _fill(out, input_uncached=u.get("input_tokens"), cache_read=u.get("cache_read_tokens"), output=u.get("output_tokens"))
    # agy reports no cache write; input_tokens/cache_read relation unverified (cache_read was 0 in the only sample)
    out["cache_write"] = _um("agy reports no cache write")
    d = body.get("duration_seconds")
    if isinstance(d, (int, float)) and not isinstance(d, bool) and d >= 0:
        out["wall_ms"] = {"value": int(round(d * 1000))}
    return out


def _gemini(rows):
    return _blank("gemini emits no usage stream (IneligibleTierError seen)")


_PARSERS = {"claude": _claude, "codex": _codex, "opencode": _opencode, "agy": _agy, "gemini": _gemini}


def parse(engine, lines):
    if engine not in _PARSERS:
        raise ValueError("unknown engine %r" % (engine,))
    out = _PARSERS[engine](list(_rows(lines)))
    out["tool_calls"] = _um("tool-call event type untested per engine")
    return out


def total_input(u):
    """uncached + cache_read + cache_write, or None if any part is unmetered."""
    parts = [u[k].get("value") for k in ("input_uncached", "cache_read", "cache_write")]
    return None if None in parts else sum(parts)
