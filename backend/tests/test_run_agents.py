"""Agent pipeline steps + approval fingerprints (v8)."""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
os.environ.setdefault("SLATEMATCH_DATA_DIR", os.path.join(os.path.dirname(__file__), "api_data"))
from fastapi.testclient import TestClient
import api as api_mod

client = TestClient(api_mod.app)


def _seed_run():
    client.post("/api/v1/workspace/reset")
    r = client.post("/api/v1/cases/seed/load")  # v31: loading stages the case
    assert r.status_code == 200, r.text
    assert r.json()["run"] is None
    rr = client.post("/api/v1/workspace/run")
    assert rr.status_code == 200, rr.text
    return rr.json()["run"]


def test_run_agents_pipeline_recorded():
    b = _seed_run()
    r = client.get(f"/api/v1/runs/{b['run_id']}/agents")
    assert r.status_code == 200, r.text
    agents = r.json()["agents"]
    names = [a["agent"] for a in agents]
    assert names == ["Capture Agent", "Linking Agent", "Matching Agent",
                     "Deduction Agent", "Policy Agent", "Briefing Agent"], names
    by = {a["agent"]: a for a in agents}
    assert by["Capture Agent"]["evidence"]["payments_received"] == 16
    assert by["Capture Agent"]["evidence"]["duplicates_blocked"] == 1  # P5 duplicates P1
    assert by["Matching Agent"]["evidence"]["exact_matches"] >= 10
    assert by["Matching Agent"]["evidence"]["milp_latency_ms_total"] > 0
    assert by["Policy Agent"]["evidence"]["held_for_maker_checker"] == 2  # P7 + P16
    # v31: the briefing/output stage is measured at run completion
    assert by["Briefing Agent"]["status"] == "COMPLETED"
    assert by["Briefing Agent"]["evidence"]["settlement_drafts_recorded"] == 10


def test_approval_decision_carries_fingerprint():
    _seed_run()
    appr = client.get("/api/v1/approvals").json()
    assert appr, "seed run must leave held matches"
    # Newest-first queue: skip the zero-line refusal (its approval
    # parks it) and take a real held match.
    mid = next(a["match_id"] for a in appr if a["invoices"])
    r = client.post(f"/api/v1/matches/{mid}/decision", json={"decision": "approve"})
    assert r.status_code == 200, r.text
    fp = r.json()["fingerprint"]
    assert len(fp) == 64 and all(c in "0123456789abcdef" for c in fp)
    audit = client.get("/api/v1/audit").json()
    entry = next(a for a in audit if a["entity_id"] == mid and a["action"] == "match_approved")
    assert entry["payload"]["fingerprint"] == fp
    r2 = client.post(f"/api/v1/matches/{mid}/decision", json={"decision": "approve"})
    assert r2.status_code == 409
