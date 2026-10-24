"""ArchonOS prototype: pure-function policy + hash-chained charge ledger.

Rules carried over from trade's desk:
- default deny: a seat with no grant for an engine is refused.
- spend is DERIVED by replaying the ledger, never a stored counter, so a
  restart cannot refill a budget.
- absent stays absent: usage an engine did not report is not zero. It is
  charged at the task's cap (unmetered cap charging) and the row says so.
- the chain proves internal consistency only; authorship/time need an anchor.
Amounts are integers; no floats.
"""
import hashlib, json

GENESIS = "0" * 64
DENY, ALLOW = "deny", "allow"


def canon(o):
    return json.dumps(o, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def row_hash(prev, body):
    return hashlib.sha256((prev + canon(body)).encode()).hexdigest()


def _is_int(x):
    return isinstance(x, int) and not isinstance(x, bool)


def spent(rows, seat):
    return sum(r["body"]["charged"] for r in rows if r["body"]["seat"] == seat)


def decide(policy, rows, seat, engine, task_cap):
    """Pure. policy = {seat: {"engines": [...], "budget": int}}."""
    p = policy.get(seat)
    if p is None:
        return DENY, "seat_unknown"
    if engine not in p.get("engines", []):
        return DENY, "engine_not_granted"
    if not _is_int(task_cap) or task_cap <= 0:
        return DENY, "cap_invalid"
    if spent(rows, seat) + task_cap > p["budget"]:
        return DENY, "budget_exceeded"
    return ALLOW, "ok"


def charge_amount(usage, task_cap):
    """Missing or malformed tokens => unmetered: charge the cap, flagged."""
    t = None if usage is None else usage.get("tokens")
    if _is_int(t) and t >= 0:
        if t <= task_cap:
            return t, "metered"
        return task_cap, "metered_clamped_to_cap"
    return task_cap, "unmetered_cap"


def append(rows, seat, task_id, engine, task_cap, usage):
    charged, basis = charge_amount(usage, task_cap)
    body = {"seat": seat, "task": task_id, "engine": engine, "cap": task_cap,
            "charged": charged, "basis": basis}
    prev = rows[-1]["hash"] if rows else GENESIS
    return rows + [{"prev": prev, "body": body, "hash": row_hash(prev, body)}]


def verify(rows):
    prev = GENESIS
    for i, r in enumerate(rows):
        if r["prev"] != prev or r["hash"] != row_hash(prev, r["body"]):
            return False, i
        prev = r["hash"]
    return True, None


def is_prefix_extension(old, new):
    return len(new) >= len(old) and new[:len(old)] == old
