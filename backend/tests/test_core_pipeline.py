import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
os.environ["SLATEMATCH_DATA_DIR"] = os.path.join(os.path.dirname(__file__), "v2_data")
from fastapi.testclient import TestClient
from api import app

c = TestClient(app)

PAY_CSV = """Payment ID,Payer,Amount,Remittance
X1,Cascade Chemicals,135000.00,"INV-1009"
X2,BluePeak Electronics,930.00,BluePeak Electronics wire less discount and deduction
"""

def test_payments_csv_import_runs_batch():
    c.post("/api/v1/seed")
    r = c.post("/api/v1/payments/import", json={"csv_text": PAY_CSV, "idempotency_key": "v2-test-1"})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["imported"] == 2 and not d["errors"], d
    # v22: an import run reconciles the workspace's whole staged set
    # (the 16 seeded wires + these 2), never just the imported file
    assert d["run"]["payments"] == 18
    res = {x["payment_id"]: x for x in d["run"]["results"]}
    assert res["X1"]["status"] == "OPTIMAL_EXACT_MATCH"

def test_scenarios_all_pass():
    lst = c.get("/api/v1/scenarios").json()
    assert len(lst) == 10
    for s in lst:
        r = c.post(f"/api/v1/scenarios/{s['id']}/run")
        assert r.status_code == 200, (s["id"], r.text)
        d = r.json()
        assert d["all_pass"], (s["id"], [x for x in d["checks"] if not x["pass"]])

def test_runs_list():
    runs = c.get("/api/v1/runs").json()
    assert any(r["kind"] == "batch_reconciliation" for r in runs)


def test_custom_case_builder():
    payload = {
        "invoices": [
            {"invoice_id": "C-1", "customer": "Apex Manufacturing", "gross_cents": 50000, "po_number": "PO-1", "age_days": 30},
            {"invoice_id": "C-2", "customer": "Apex Manufacturing", "gross_cents": 50000, "po_number": "PO-2", "age_days": 10},
        ],
        "payments": [
            {"payment_id": "CP-1", "payer_raw": "Apex Manufacturing", "amount_cents": 50000, "references": ["PO-2"]},
        ],
    }
    r = c.post("/api/v1/scenarios/custom/run", json=payload)
    assert r.status_code == 200, r.text
    res = r.json()["run"]["results"][0]
    assert res["status"] == "OPTIMAL_EXACT_MATCH"
    assert [l["invoice_id"] for l in res["lines"]] == ["C-2"]  # PO evidence beats age
    assert res["derivation"]["equation"]["balances"]
