import json
import unittest

from policy_ledger import (ALLOW, DENY, append, charge_amount, decide,
                           is_prefix_extension, spent, verify)

P = {"s1": {"engines": ["claude"], "budget": 100}}


def fill(n, cap=10, usage=None):
    rows = []
    for i in range(n):
        rows = append(rows, "s1", "t%d" % i, "claude", cap, usage)
    return rows


class T(unittest.TestCase):
    def test_default_deny(self):
        self.assertEqual(decide(P, [], "nope", "claude", 10), (DENY, "seat_unknown"))
        self.assertEqual(decide(P, [], "s1", "codex", 10), (DENY, "engine_not_granted"))
        self.assertEqual(decide({}, [], "s1", "claude", 10)[0], DENY)

    def test_invalid_cap_denied(self):
        for c in (0, -1, 1.5, True, None, "5"):
            self.assertEqual(decide(P, [], "s1", "claude", c), (DENY, "cap_invalid"))

    def test_budget_boundary(self):
        rows = append([], "s1", "t1", "claude", 60, None)
        self.assertEqual(decide(P, rows, "s1", "claude", 40)[0], ALLOW)
        self.assertEqual(decide(P, rows, "s1", "claude", 41), (DENY, "budget_exceeded"))

    def test_unmetered_charges_cap_not_zero(self):
        for u in (None, {}, {"tokens": None}, {"tokens": -3}, {"tokens": 2.5}, {"tokens": True}):
            self.assertEqual(charge_amount(u, 50), (50, "unmetered_cap"))

    def test_metered_and_clamped(self):
        self.assertEqual(charge_amount({"tokens": 7}, 50), (7, "metered"))
        self.assertEqual(charge_amount({"tokens": 0}, 50), (0, "metered"))
        self.assertEqual(charge_amount({"tokens": 90}, 50), (50, "metered_clamped_to_cap"))

    def test_restart_proof_spend(self):
        rows = append([], "s1", "t1", "claude", 100, None)
        reloaded = json.loads(json.dumps(rows))
        self.assertEqual(decide(P, reloaded, "s1", "claude", 1), (DENY, "budget_exceeded"))

    def test_other_seat_not_charged(self):
        rows = append([], "s2", "t1", "claude", 100, None)
        self.assertEqual(spent(rows, "s1"), 0)

    def test_chain_detects_tamper_and_deletion(self):
        rows = fill(3, usage={"tokens": 5})
        self.assertEqual(verify(rows), (True, None))
        bad = json.loads(json.dumps(rows))
        bad[1]["body"]["charged"] = 0
        self.assertEqual(verify(bad), (False, 1))
        self.assertFalse(verify(rows[:1] + rows[2:])[0])

    def test_truncation_verifies_but_is_not_an_extension(self):
        rows = fill(3)
        short = rows[:2]
        self.assertTrue(verify(short)[0])  # internal consistency only
        self.assertFalse(is_prefix_extension(rows, short))
        self.assertTrue(is_prefix_extension(short, rows))
        rewritten = append(append([], "s1", "x", "claude", 10, None), "s1", "t1", "claude", 10, None)
        self.assertTrue(verify(rewritten)[0])
        self.assertFalse(is_prefix_extension(short, rewritten))

    def test_liveness_from_empty(self):
        rows = []
        for i in range(10):
            self.assertEqual(decide(P, rows, "s1", "claude", 10)[0], ALLOW)
            rows = append(rows, "s1", "t%d" % i, "claude", 10, None)
        self.assertEqual(decide(P, rows, "s1", "claude", 10), (DENY, "budget_exceeded"))


if __name__ == "__main__":
    unittest.main()
