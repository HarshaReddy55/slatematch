"""Proof pack: run replay in a scratch session, the auditor
evidence pack with its SHA-256 manifest, and the success-criteria
contract dashboard computed from stored records.

The demo case's maker-checker override ($60,000) lives in the run's
policy snapshot; the replay tests first align the stored policy
with that snapshot (read back through the evidence pack itself),
so an unchanged-policy replay must diff to zero, and raising the
threshold must flip exactly the two maker-checker holds, P7 and
P16, in the scratch session only.
"""
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
os.environ.setdefault("SLATEMATCH_DATA_DIR", os.path.join(os.path.dirname(__file__), "api_data"))
from fastapi.testclient import TestClient
import api as api_mod

client = TestClient(api_mod.app, raise_server_exceptions=False)


def _demo_run():
    client.post("/api/v1/workspace/reset")
    client.post("/api/v1/cases/seed/load")
    run = client.post("/api/v1/workspace/run").json()["run"]
    return run["run_id"]


def _align_policy_to_snapshot(run_id):
    pack = client.get(f"/api/v1/runs/{run_id}/evidence").json()
    pol = pack["run"]["policy"]
    keep = {k: pol[k] for k in ("maker_checker_threshold_cents",
                                 "automation_threshold",
                                 "tolerance_writeoff_cents") if k in pol}
    r = client.put("/api/v1/policy", json={"policy": keep})
    assert r.status_code == 200, r.text
    return pol


def test_replay_unchanged_policy_diffs_to_zero():
    run_id = _demo_run()
    _align_policy_to_snapshot(run_id)
    r = client.post(f"/api/v1/runs/{run_id}/replay")
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["changed_count"] == 0, d["results"]
    assert len(d["results"]) == 16
    assert all(not row["changed"] for row in d["results"])


def test_replay_policy_change_flips_autopilot_candidate():
    """A small partial wire is PROPOSED at autonomy level 0. Raise
    the level and replay that run: the scratch session's autopilot
    pass resolves it there - and only there. (No demo-case match
    can serve here: P4's confidence is 0.3, P14 is an overpayment,
    P7 and P16 are maker-checker holds - the autopilot's guards
    exclude every one, which the zero-diff replay above relies on
    indirectly.)"""
    client.post("/api/v1/workspace/reset")
    client.post("/api/v1/invoices/import", json={
        "csv_text": "invoice_id,customer,amount,po_number,discount_rate,age_days,due_in_days\n"
                    "INV-A1,Acme Widgets,1000.00,,0,10,30\n", "mode": "replace"})
    run = client.post("/api/v1/batches", json={
        "idempotency_key": "replay-flip-1",
        "payments": [{"payment_id": "W-990", "payer_raw": "Acme Widgets",
                      "amount_cents": 99000, "references": ["INV-A1"]}]}).json()
    run_id = run["run_id"]
    try:
        r = client.put("/api/v1/policy", json={"policy": {"autonomy_level": 1}})
        assert r.status_code == 200
        d = client.post(f"/api/v1/runs/{run_id}/replay").json()
        changed = {row["payment_id"] for row in d["results"] if row["changed"]}
        assert changed == {"W-990"}, d["results"]
        row = d["results"][0]
        assert row["then_status"] == "PROPOSED"
        assert row["now_status"] == "APPROVED_POSTED"
        # Isolation: in the source workspace the match is still held.
        doc = client.get("/api/v1/payments/W-990/erp-document").json()
        assert doc["status"] == "PROPOSED"
    finally:
        client.put("/api/v1/policy", json={"policy": {"autonomy_level": 0}})


def test_replay_unknown_run_404():
    r = client.post("/api/v1/runs/run_nope/replay")
    assert r.status_code == 404


def test_evidence_pack_manifest_verifies():
    run_id = _demo_run()
    pack = client.get(f"/api/v1/runs/{run_id}/evidence").json()
    assert pack["run"]["run_id"] == run_id
    assert len(pack["matches"]) == 15  # 16 payments, the duplicate has none
    assert len(pack["exceptions"]) >= 1
    assert pack["sap_documents"], "posted matches carry their documents"
    body = {k: v for k, v in pack.items()
            if k not in ("generated_at", "manifest_sha256", "manifest_covers")}
    digest = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()
    assert digest == pack["manifest_sha256"]


def test_success_criteria_from_records():
    _demo_run()
    d = client.get("/api/v1/success-criteria").json()
    rows = {r["criterion"]: r for r in d["criteria"]}
    assert rows["Duplicate leakage"]["actual"] == 0
    assert rows["Duplicate leakage"]["status"] == "pass"
    assert rows["SAP documents balanced"]["actual"] == 1.0
    assert rows["Touchless posting rate"]["actual"] == 0.625  # 10 of 16
    assert rows["Decisions carrying a full derivation"]["actual"] == 1.0
