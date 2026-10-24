"""archon-hands adapter interface: one engine behind one contract. Pure; the subprocess is injected.

An adapter turns a leased fire into an argv, runs it through an injected `runner`, and returns a
terminal result + usage. It never touches the lease: the caller posts the result with its lease_id.
Wall time is measured by the daemon (always known); engine tokens come from usage.parse.
"""
import usage as usage_mod


class Adapter:
    engine = None

    def argv(self, task):
        raise NotImplementedError

    def run(self, task, runner, clock):
        """runner(argv) -> (exit_code, stdout_lines). Returns (state, reason, usage)."""
        t0 = clock()
        try:
            code, lines = runner(self.argv(task))
        except Exception as e:  # runner failure is a failed fire, not a silent drop
            return "failed", "runner raised %s" % type(e).__name__, self._usage([], clock() - t0)
        u = self._usage(lines, clock() - t0)
        if code != 0:
            return "failed", "exit code %s" % code, u
        if not any(l.strip() for l in lines):
            return "no_result", "engine produced no output", u
        return "done", None, u

    def _usage(self, lines, wall_s):
        u = usage_mod.parse(self.engine, lines)
        u["daemon_wall_s"] = {"value": wall_s}  # measured by daemon, independent of the engine
        return u


class _Simple(Adapter):
    def __init__(self, engine, base):
        self.engine, self._base = engine, list(base)

    def argv(self, task):
        if not isinstance(task, str) or not task:
            raise ValueError("task must be a non-empty prompt string")
        return self._base + [task]


# base argv per engine is a prototype assumption, not verified against installed CLIs
ADAPTERS = {
    "claude": _Simple("claude", ["claude", "-p", "--output-format", "stream-json", "--verbose"]),
    "codex": _Simple("codex", ["codex", "exec", "--json"]),
    "opencode": _Simple("opencode", ["opencode", "run", "--format", "json"]),
    "agy": _Simple("agy", ["agy", "--json"]),
    "gemini": _Simple("gemini", ["gemini", "-p"]),
}


def get(engine):
    if engine not in ADAPTERS:
        raise ValueError("unknown engine %r" % (engine,))
    return ADAPTERS[engine]
