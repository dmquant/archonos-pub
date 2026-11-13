import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import adapter  # noqa: E402
import lease  # noqa: E402
import usage  # noqa: E402

S = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures") + "/"


def stream(name):
    with open(S + name + ".jsonl", encoding="utf-8") as fh:
        return fh.read().splitlines()


def val(u, k):
    return u[k].get("value")


class UsageReal(unittest.TestCase):
    """Expected numbers are the ones in ARC-139B, read from the raw rows."""

    def test_claude(self):
        u = usage.parse("claude", stream("claude"))
        self.assertEqual([val(u, k) for k in ("input_uncached", "cache_read", "cache_write", "output", "wall_ms")],
                         [2, 10096, 17506, 4, 1504])
        self.assertEqual(usage.total_input(u), 2 + 10096 + 17506)

    def test_codex_input_includes_cache(self):
        u = usage.parse("codex", stream("codex"))
        self.assertEqual(val(u, "input_uncached"), 17124 - 13312)
        self.assertEqual(val(u, "cache_read"), 13312)
        self.assertEqual(usage.total_input(u), 17124)
        self.assertEqual(u["wall_ms"]["state"], "unmetered")

    def test_opencode(self):
        u = usage.parse("opencode", stream("opencode"))
        self.assertEqual((val(u, "input_uncached"), val(u, "cache_read"), val(u, "output")), (11579, 1792, 3))
        self.assertEqual(val(u, "wall_ms"), 350)

    def test_dsh(self):
        # Captured from dsh 0.2.2-rc.1: step 1 has no cache bucket (omitted), step 2
        # reports a 5120-token cache read; totalTokens is cumulative and is not summed.
        u = usage.parse("dsh", stream("dsh"))
        self.assertEqual([val(u, k) for k in ("input_uncached", "cache_read", "cache_write", "output")],
                         [5150 + 78, 5120, 0, 41 + 3])
        self.assertEqual(val(u, "tool_calls"), 1)
        self.assertEqual(u["wall_ms"]["state"], "unmetered")

    def test_agy(self):
        u = usage.parse("agy", stream("agy"))
        self.assertEqual((val(u, "input_uncached"), val(u, "output"), val(u, "wall_ms")), (15325, 1, 16163))
        self.assertEqual(u["cache_write"]["state"], "unmetered")
        self.assertIsNone(usage.total_input(u))

    def test_gemini_all_unmetered_never_zero(self):
        u = usage.parse("gemini", [])
        for k in usage.FIELDS:
            self.assertEqual(u[k]["state"], "unmetered")
            self.assertNotIn("value", u[k])

    def test_tool_calls_counted_where_the_event_is_verified(self):
        self.assertEqual(val(usage.parse("dsh", stream("dsh")), "tool_calls"), 1)
        self.assertEqual(val(usage.parse("opencode", stream("opencode")), "tool_calls"), 0)
        for e in ("claude", "codex", "agy"):
            self.assertEqual(usage.parse(e, stream(e))["tool_calls"]["state"], "unmetered")


class UsageEdges(unittest.TestCase):
    def test_empty_and_garbage_unmetered(self):
        for e in usage.ENGINES:
            u = usage.parse(e, ["not json", "", "[1]"])
            self.assertEqual(set(u), set(usage.FIELDS))
            # opencode/dsh can count tool calls from a parsed stream (zero here);
            # every other metric must stay unmetered rather than reporting a fake 0.
            for k, v in u.items():
                if k == "tool_calls" and e in ("opencode", "dsh"):
                    self.assertEqual(v, {"value": 0})
                else:
                    self.assertIn("state", v, "%s/%s" % (e, k))

    def test_unknown_engine(self):
        with self.assertRaises(ValueError):
            usage.parse("nope", [])

    def test_negative_and_bool_rejected(self):
        row = '{"type":"turn.completed","usage":{"input_tokens":-1,"cached_input_tokens":true,"output_tokens":5}}'
        u = usage.parse("codex", [row])
        self.assertEqual(u["input_uncached"]["state"], "unmetered")
        self.assertEqual(u["cache_read"]["state"], "unmetered")
        self.assertEqual(val(u, "output"), 5)

    def test_codex_cached_exceeds_input_not_negative(self):
        row = '{"type":"turn.completed","usage":{"input_tokens":5,"cached_input_tokens":9}}'
        self.assertEqual(usage.parse("codex", [row])["input_uncached"]["state"], "unmetered")

    def test_opencode_sums_steps(self):
        r = '{"type":"step_finish","timestamp":%d,"part":{"tokens":{"input":10,"output":1,"cache":{"read":2,"write":3}}}}'
        s = '{"type":"step_start","timestamp":100}'
        u = usage.parse("opencode", [s, r % 150, r % 400])
        self.assertEqual((val(u, "input_uncached"), val(u, "cache_write"), val(u, "wall_ms")), (20, 6, 300))

    def test_dsh_incomplete_step_not_partial_sum(self):
        a = '{"type":"status","phase":"step_end","usage":{"inputTokens":10,"outputTokens":1,"cacheReadTokens":2,"cacheWriteTokens":0}}'
        b = '{"type":"status","phase":"step_end","usage":{"inputTokens":20,"cacheReadTokens":4,"cacheWriteTokens":0}}'
        u = usage.parse("dsh", [a, b])
        self.assertEqual(val(u, "input_uncached"), 30)
        self.assertEqual(val(u, "cache_read"), 6)
        self.assertEqual(u["output"]["state"], "unmetered")

    def test_dsh_step_without_usage_is_never_zero(self):
        rows = ['{"type":"status","phase":"step_end"}',
                '{"type":"status","phase":"step_end","usage":{"inputTokens":5,"outputTokens":1}}']
        u = usage.parse("dsh", rows)
        for k in ("input_uncached", "cache_read", "cache_write", "output"):
            self.assertEqual(u[k]["state"], "unmetered")

    def test_opencode_missing_field_in_one_step_unmeters_only_that_field(self):
        rows = ['{"type":"step_finish","part":{"tokens":{"input":10,"output":2,"cache":{"read":1,"write":0}}}}',
                '{"type":"step_finish","part":{"tokens":{"input":20,"cache":{"read":3,"write":0}}}}']
        u = usage.parse("opencode", rows)
        self.assertEqual(val(u, "input_uncached"), 30)
        self.assertEqual(val(u, "cache_read"), 4)
        self.assertEqual(u["output"]["state"], "unmetered")

    def test_dsh_absent_cache_buckets_are_zero_not_unmetered(self):
        row = '{"type":"status","phase":"step_end","usage":{"inputTokens":5143,"outputTokens":20,"totalTokens":5163}}'
        u = usage.parse("dsh", [row])
        self.assertEqual(val(u, "input_uncached"), 5143)
        self.assertEqual(val(u, "output"), 20)
        self.assertEqual(val(u, "cache_read"), 0)
        self.assertEqual(val(u, "cache_write"), 0)


class LeaseTests(unittest.TestCase):
    def mk(self):
        f = lease.Fires(lease_ttl=10)
        f.insert("s@1", start_deadline=100)
        return f

    def test_insert_idempotent(self):
        f = self.mk()
        self.assertFalse(f.insert("s@1", 999))
        self.assertEqual(f.rows["s@1"]["start_deadline"], 100)

    def test_double_lease_refused(self):
        f = self.mk()
        f.lease("s@1", 0)
        with self.assertRaises(lease.LeaseError):
            f.lease("s@1", 1)

    def test_happy_path_and_terminal_frozen(self):
        f = self.mk()
        lid, _ = f.lease("s@1", 0)
        f.heartbeat("s@1", lid, 5)
        f.result("s@1", lid, "done", 8, usage={"x": 1})
        self.assertEqual(f.rows["s@1"]["state"], "done")
        with self.assertRaises(lease.LeaseError):
            f.result("s@1", lid, "failed", 9, reason="r")
        self.assertEqual(f.sweep(10**6), {})

    def test_no_result_stage_is_not_done(self):
        f = self.mk()
        f.lease("s@1", 0)
        f.sweep(50)
        self.assertNotEqual(f.rows["s@1"]["state"], "done")

    def test_wrong_lease_cannot_heartbeat_or_post(self):
        f = self.mk()
        f.lease("s@1", 0)
        with self.assertRaises(lease.LeaseError):
            f.heartbeat("s@1", "Lbogus", 1)
        with self.assertRaises(lease.LeaseError):
            f.result("s@1", "Lbogus", "done", 1)

    def test_result_after_expiry_refused(self):
        f = self.mk()
        lid, _ = f.lease("s@1", 0)
        with self.assertRaises(lease.LeaseError):
            f.result("s@1", lid, "done", 11)

    def test_failed_needs_reason(self):
        f = self.mk()
        lid, _ = f.lease("s@1", 0)
        with self.assertRaises(lease.LeaseError):
            f.result("s@1", lid, "failed", 1)

    def test_expiry_requeues_once_then_fails(self):
        f = self.mk()
        f.lease("s@1", 0)
        self.assertEqual(f.sweep(11), {"s@1": "queued"})
        lid2, _ = f.lease("s@1", 12)
        self.assertEqual(f.sweep(30), {"s@1": "failed"})
        with self.assertRaises(lease.LeaseError):
            f.result("s@1", lid2, "done", 31)

    def test_old_lease_id_dead_after_requeue(self):
        f = self.mk()
        old, _ = f.lease("s@1", 0)
        f.sweep(11)
        f.lease("s@1", 12)
        with self.assertRaises(lease.LeaseError):
            f.result("s@1", old, "done", 13)

    def test_unclaimed_and_skipped(self):
        f = lease.Fires()
        f.insert("a", 5)
        f.insert("b", 5, catch_up="skip")
        self.assertEqual(f.sweep(6), {"a": "unclaimed", "b": "skipped"})
        with self.assertRaises(lease.LeaseError):
            f.lease("a", 7)

    def test_lease_past_start_deadline_refused(self):
        f = self.mk()
        with self.assertRaises(lease.LeaseError):
            f.lease("s@1", 101)

    def test_unknown_fire(self):
        with self.assertRaises(lease.LeaseError):
            lease.Fires().lease("zz", 0)


class AdapterTests(unittest.TestCase):
    def run_a(self, engine, code, lines, raises=False):
        def runner(argv):
            if raises:
                raise OSError("boom")
            return code, lines
        t = iter([0, 7])
        return adapter.get(engine).run("hi", runner, lambda: next(t))

    def test_done_with_real_stream(self):
        st, why, u = self.run_a("codex", 0, stream("codex"))
        self.assertEqual((st, why), ("done", None))
        self.assertEqual(val(u, "output"), 5)
        self.assertEqual(val(u, "daemon_wall_s"), 7)

    def test_nonzero_exit_failed_with_reason(self):
        st, why, _ = self.run_a("claude", 2, ["x"])
        self.assertEqual((st, why), ("failed", "exit code 2"))

    def test_empty_output_no_result(self):
        self.assertEqual(self.run_a("agy", 0, ["", " "])[0], "no_result")

    def test_runner_exception_failed_not_dropped(self):
        st, why, u = self.run_a("opencode", 0, [], raises=True)
        self.assertEqual(st, "failed")
        self.assertEqual(u["output"]["state"], "unmetered")

    def test_gemini_done_but_usage_unmetered(self):
        st, _, u = self.run_a("gemini", 0, ["hello"])
        self.assertEqual(st, "done")
        self.assertEqual(u["output"]["state"], "unmetered")

    def test_dsh_argv(self):
        self.assertEqual(adapter.get("dsh").argv("hello"),
                         ["dsh", "--profile", "headless", "--json", "hello"])
        with self.assertRaises(ValueError):
            adapter.get("nope")

    def test_bad_task_and_engine(self):
        with self.assertRaises(ValueError):
            adapter.get("claude").argv("")
        with self.assertRaises(ValueError):
            adapter.get("nope")


if __name__ == "__main__":
    unittest.main()
