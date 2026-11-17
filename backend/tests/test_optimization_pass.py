"""Optimization pass (17 Nov 2026): the success-criteria cache.

The criteria endpoint scans every stored run and rebuilds every
posting document; it is cached per tenant behind a runs stamp.
The behaviours pinned here: a repeat read returns the same
payload, and a decision - the one post-run mutation of match
status - is reflected on the very next read (the cache is
popped by the decision path, never left stale)."""
import os, sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
os.environ["SLATEMATCH_DATA_DIR"] = os.path.join(os.path.dirname(__file__), "api_data")

from fastapi.testclient import TestClient  # noqa: E402
import api  # noqa: E402

c = TestClient(api.app)
H = {"X-API-Key": "dev-key", "Content-Type": "application/json"}


def _criteria():
    r = c.get("/api/v1/success-criteria", headers=H)
    assert r.status_code == 200, r.text
    return r.json()


def _row(payload, name):
    return next(x for x in payload["criteria"] if x["criterion"] == name)


def test_criteria_cache_reflects_decisions():
    c.post("/api/v1/workspace/reset", headers=H)
    c.post("/api/v1/cases/seed/load", headers=H)
    c.post("/api/v1/workspace/run", headers=H)

    first = _criteria()
    second = _criteria()
    assert first == second  # cached read is stable
    docs_before = _row(first, "SAP documents balanced")["basis"]
    assert "10 of 10" in docs_before, docs_before

    # Approve the held Cascade wire P7: an eleventh document is
    # issued, and the next criteria read must show it.
    approvals = c.get("/api/v1/approvals", headers=H).json()
    p7 = next(a for a in approvals if a["payment_id"] == "P7")
    r = c.post(f"/api/v1/matches/{p7['match_id']}/decision", headers=H,
               json={"decision": "approve"})
    assert r.status_code == 200, r.text

    third = _criteria()
    docs_after = _row(third, "SAP documents balanced")["basis"]
    assert "11 of 11" in docs_after, docs_after
    touch = _row(third, "Touchless posting rate")
    assert touch["basis"].startswith("10 of 16"), touch["basis"]
