"""Fire lease state machine (ARC-138 s1). Pure and clock-injected; no I/O.

States: queued -> leased -> done | failed | no_result(terminal, with reason)
        queued -> unclaimed (past start_deadline, never leased; terminal)
        leased -> expired (lease ran out, no result) -> queued ONCE (zombie rule) -> else failed
        queued -> skipped (catch_up=skip and late)
Rules: inserting an existing fire_id is a no-op; a second lease on one fire_id is refused;
only the current lease_id may heartbeat or post a result; a result after expiry is refused;
terminal states never change. A fire with no result stage is never 'done'.
"""
import itertools

TERMINAL = ("done", "failed", "no_result", "unclaimed", "skipped")
RESULTS = ("done", "failed", "no_result")


class LeaseError(Exception):
    pass


class Fires:
    def __init__(self, lease_ttl=60, max_requeue=1):
        self.ttl, self.max_requeue = lease_ttl, max_requeue
        self.rows = {}
        self._n = itertools.count(1)

    @staticmethod
    def fire_id(schedule_id, fire_time):
        return "%s@%s" % (schedule_id, fire_time)

    def insert(self, fire_id, start_deadline, run_deadline=None, catch_up="run_late", now=0):
        if fire_id in self.rows:
            return False  # at-least-once alarm: no-op
        self.rows[fire_id] = {"fire_id": fire_id, "state": "queued", "start_deadline": start_deadline,
                              "run_deadline": run_deadline, "catch_up": catch_up, "lease_id": None,
                              "lease_until": None, "requeues": 0, "reason": None, "usage": None,
                              "last_heartbeat": None, "inserted": now}
        return True

    def _get(self, fire_id):
        if fire_id not in self.rows:
            raise LeaseError("unknown fire_id")
        return self.rows[fire_id]

    def lease(self, fire_id, now):
        r = self._get(fire_id)
        if r["state"] == "leased":
            raise LeaseError("already leased")
        if r["state"] != "queued":
            raise LeaseError("not leasable: " + r["state"])
        if now > r["start_deadline"]:
            raise LeaseError("past start_deadline")
        r.update(state="leased", lease_id="L%d" % next(self._n), lease_until=now + self.ttl, last_heartbeat=now)
        return r["lease_id"], r["lease_until"]

    def _holder(self, fire_id, lease_id, now):
        r = self._get(fire_id)
        if r["state"] != "leased" or r["lease_id"] != lease_id:
            raise LeaseError("not the current lease")
        if now > r["lease_until"]:
            raise LeaseError("lease expired")
        return r

    def heartbeat(self, fire_id, lease_id, now):
        r = self._holder(fire_id, lease_id, now)
        r["lease_until"] = now + self.ttl
        r["last_heartbeat"] = now
        return r["lease_until"]

    def result(self, fire_id, lease_id, state, now, usage=None, reason=None):
        if state not in RESULTS:
            raise LeaseError("bad result state")
        if state in ("failed", "no_result") and not reason:
            raise LeaseError("reason required")
        r = self._holder(fire_id, lease_id, now)
        r.update(state=state, usage=usage, reason=reason, lease_id=None, lease_until=None)

    def sweep(self, now):
        """Apply deadlines; returns {fire_id: new_state} for rows changed."""
        ch = {}
        for r in self.rows.values():
            if r["state"] == "queued" and now > r["start_deadline"]:
                r["state"] = "skipped" if r["catch_up"] == "skip" else "unclaimed"
                r["reason"] = "start_deadline passed, last_heartbeat=%s" % r["last_heartbeat"]
            elif r["state"] == "leased" and now > r["lease_until"]:
                if r["requeues"] < self.max_requeue:
                    r.update(state="queued", requeues=r["requeues"] + 1, lease_id=None, lease_until=None,
                             reason="lease expired, requeued")
                    r["start_deadline"] = max(r["start_deadline"], now + self.ttl)
                else:
                    r.update(state="failed", lease_id=None, lease_until=None, reason="lease expired twice (lost_in_flight)")
            else:
                continue
            ch[r["fire_id"]] = r["state"]
        return ch
