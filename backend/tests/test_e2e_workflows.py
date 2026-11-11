"""v9 connectivity: approval settlement + ERP document id, policy preview."""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
os.environ.setdefault("SLATEMATCH_DATA_DIR", os.path.join(os.path.dirname(__file__), "api_data"))
from fastapi.testclient import TestClient
import api as api_mod

client = TestClient(api_mod.app)


def _seed_run(key):
    client.post("/api/v1/workspace/reset")
    r = client.post("/api/v1/cases/seed/load")  # v31: loading stages the case
    assert r.status_code == 200, r.text
    assert r.json()["run"] is None
    rr = client.post("/api/v1/workspace/run")
    assert rr.status_code == 200, rr.text
    return rr.json()["run"]


def _open_count():
    return len(client.get("/api/v1/invoices").json())


def test_approval_settles_invoices_and_issues_erp_document():
    _seed_run("v9-settle-1")
    # Auto-posted matches settle their invoices in the run itself (12 of
    # 19 invoices sit inside the 10 auto-posted matches), so the open
    # ledger after a run is the residual book, not the full case.
    assert _open_count() == 7
    appr = client.get("/api/v1/approvals").json()
    p7 = next(a for a in appr if a["payment_id"] == "P7")
    r = client.post(f"/api/v1/matches/{p7['match_id']}/decision",
                    json={"decision": "approve"})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["erp_document_id"] and d["erp_document_id"].startswith("DZ-"), d
    assert d["settled_invoices"], d
    # the settled invoices have left the open ledger
    assert _open_count() == 7 - len(d["settled_invoices"])
    open_ids = {i["invoice_id"] for i in client.get("/api/v1/invoices").json()}
    assert not (set(d["settled_invoices"]) & open_ids)
    # the decision record on the match carries the same document id
    run_id = client.get("/api/v1/workspace").json()["latest_run"]["run_id"]
    m = next(x for x in client.get(f"/api/v1/runs/{run_id}/matches").json()
             if x["payment_id"] == "P7")
    assert m["result"]["approval"]["erp_document_id"] == d["erp_document_id"]


def test_reject_settles_nothing():
    _seed_run("v9-settle-2")
    appr = client.get("/api/v1/approvals").json()
    p4 = next(a for a in appr if a["payment_id"] == "P4")
    r = client.post(f"/api/v1/matches/{p4['match_id']}/decision",
                    json={"decision": "reject"})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["erp_document_id"] is None and d["settled_invoices"] == []
    assert _open_count() == 7  # auto-posts settled theirs in the run; a rejection settles nothing


def test_policy_preview_diffs_without_touching_the_workspace():
    b = _seed_run("v9-preview-1")
    runs_before = len(client.get("/api/v1/runs").json())
    pol = client.get("/api/v1/policy").json()["policy"]
    pol["maker_checker_threshold_cents"] = 40000_00  # $40,000 cap
    r = client.post("/api/v1/policy/preview", json={"policy": pol})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["base_run_id"] == b["run_id"]
    moved = {m["payment_id"] for m in d["moved_to_approvals"]}
    # P1 ($52,000) and P2 ($51,400) auto-posted before, held under a $40k cap
    assert {"P1", "P2"} <= moved, d
    assert d["auto_after"] < d["auto_before"]
    assert d["posted_value_after_cents"] < d["posted_value_before_cents"]
    # the dry run wrote nothing: no new run, policy untouched, queue intact
    assert len(client.get("/api/v1/runs").json()) == runs_before
    assert len(client.get("/api/v1/approvals").json()) == 5
    assert _open_count() == 7
