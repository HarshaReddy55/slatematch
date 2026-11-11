import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
os.environ["SLATEMATCH_DATA_DIR"] = os.path.join(os.path.dirname(__file__), "deriv_data")
from fastapi.testclient import TestClient
from api import app

c = TestClient(app)

import uuid
def _seed_batch():
    s = c.post("/api/v1/seed").json()
    return c.post("/api/v1/batches", json={"idempotency_key": "deriv-" + uuid.uuid4().hex[:8], "payments": s["payments"]}).json()

def test_equation_balances_for_every_match():
    b = _seed_batch()
    assert b["results"], "no results"
    for r in b["results"]:
        d = r["derivation"]; eq = d["equation"]
        assert eq["balances"], (r["payment_id"], eq)
        assert eq["net_applied_cents"] - eq["deduction_applied_cents"] + eq["residual_cents"] == eq["payment_cents"]
        assert d["greedy_comparison"]["status"]
        if r["lines"]:
            assert d["objective_terms"], r["payment_id"]
            assert abs(sum(t["value"] for t in d["objective_terms"]) - d["objective_total"]) < 1e-6

def test_deduction_derivation_arithmetic():
    b = _seed_batch()
    p3 = next(r for r in b["results"] if r["payment_id"] == "P3")
    steps = " ".join(p3["deduction"]["derivation"])
    assert "0.94" in steps and "45" in steps  # win prob and processing cost shown with values
    assert p3["deduction"]["autonomous_action"] in ("AUTO_GENERATE_DISPUTE_CLAIM", "ROUTE_TO_ANALYST")

def test_methodology_complete():
    d = c.get("/api/v1/methodology").json()
    ids = {s["id"] for s in d["sections"]}
    assert {"milp", "candidates", "confidence", "deductions", "forecast", "evaluation"} <= ids
    for s in d["sections"]:
        assert s["formulae"] and s["meaning"]


def test_fuzzy_and_ocr_resolution():
    import sys
    sys.path.insert(0, "backend/app")
    from batch import resolve_candidates
    from domain import Invoice, Payment
    invs = [Invoice("A-1", "Apex Manufacturing", "Apex Manufacturing", 75000, po_number="PO-51"),
            Invoice("A-2", "Apex Manufacturing", "Apex Manufacturing", 41000, po_number="PO-52")]
    cands, how = resolve_candidates(Payment("X", "APEX MANUFACTURING INC.", 75000, references=["P0-51"]), invs, {})
    assert how == "ocr_reference" and [i.invoice_id for i in cands] == ["A-1"]
    cands, how = resolve_candidates(Payment("Y", "APEX MANUFACTURING INC.", 41000), invs, {})
    assert how == "fuzzy_payer" and len(cands) == 2
    from fuzzy import jaro_winkler
    assert jaro_winkler("APEX MANUFACTURING INC.", "Apex Manufacturing") >= 0.88
    assert jaro_winkler("Apex Manufacturing", "BluePeak Electronics") < 0.88
