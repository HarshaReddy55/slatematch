"""v25: LiveCube inline edits. The ledger is a working grid: open
invoices and unsettled payments can be corrected in place, settled
records refuse (that refusal is the control), a remittance-text edit
re-extracts the references the solver reads, and a re-run after an
edit re-solves the case on the corrected values."""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
os.environ.setdefault("SLATEMATCH_DATA_DIR", os.path.join(os.path.dirname(__file__), "api_data"))
from fastapi.testclient import TestClient
import api as api_mod

client = TestClient(api_mod.app, raise_server_exceptions=False)


def _seed():
    client.post("/api/v1/workspace/reset")
    client.post("/api/v1/cases/seed/load")
    client.post("/api/v1/workspace/run")  # v31: execution is explicit


def test_edit_open_invoice_amount_and_discount():
    _seed()
    r = client.patch("/api/v1/invoices/INV-1019", json={"gross_cents": 1234500})
    assert r.status_code == 200, r.text
    assert r.json()["invoice"]["gross_cents"] == 1234500
    r = client.patch("/api/v1/invoices/INV-1019", json={"discount_rate": 0.03})
    assert r.status_code == 200 and abs(r.json()["invoice"]["discount_rate"] - 0.03) < 1e-9


def test_edit_settled_invoice_refused():
    _seed()
    # INV-1001 is settled by P1's auto-posted match in the canonical run
    r = client.patch("/api/v1/invoices/INV-1001", json={"gross_cents": 1})
    assert r.status_code == 409, r.text


def test_edit_invoice_validation():
    _seed()
    assert client.patch("/api/v1/invoices/INV-9999", json={"gross_cents": 5}).status_code == 404
    assert client.patch("/api/v1/invoices/INV-1019", json={"gross_cents": -5}).status_code == 422
    assert client.patch("/api/v1/invoices/INV-1019", json={"discount_rate": 0.95}).status_code == 422
    assert client.patch("/api/v1/invoices/INV-1019", json={}).status_code == 422


def test_edit_payment_amount_and_posted_guard():
    _seed()
    # P7 is solved but only PROPOSED (maker-checker hold) - editable
    r = client.patch("/api/v1/payments/P7", json={"amount_cents": 9600000})
    assert r.status_code == 200, r.text
    assert r.json()["payment"]["amount_cents"] == 9600000
    # P1 is AUTO_POSTED - settled money refuses edits
    r = client.patch("/api/v1/payments/P1", json={"amount_cents": 5})
    assert r.status_code == 409, r.text
    assert client.patch("/api/v1/payments/NOPE", json={"amount_cents": 5}).status_code == 404


def test_remittance_text_edit_reextracts_references():
    _seed()
    # P6 matched nothing; fixing its remittance text fixes the refs
    r = client.patch("/api/v1/payments/P6",
                     json={"remittance_text": "Wire for INV-1001 and INV-1002, thank you"})
    assert r.status_code == 200, r.text
    assert r.json()["references"] == ["INV-1001", "INV-1002"], r.json()


def test_edit_then_rerun_resolves_the_partial():
    _seed()
    ws = client.get("/api/v1/workspace").json()
    p4 = next(p for p in ws["all_payments"] if p["payment_id"] == "P4")
    # Make INV-1005 exactly what P4's money explains: payment + claimed
    # deduction, no discount on that invoice in the seed.
    target = p4["amount_cents"] + (p4.get("claimed_deduction_cents") or 0)
    r = client.patch("/api/v1/invoices/INV-1005", json={"gross_cents": target})
    assert r.status_code == 200, r.text
    b = client.post("/api/v1/batches", json={"idempotency_key": "edit-rerun-1",
                                              "payments": ws["all_payments"]})
    assert b.status_code == 200, b.text
    run_id = b.json()["run_id"]
    matches = client.get(f"/api/v1/runs/{run_id}/matches").json()
    m4 = next(m for m in matches if m["payment_id"] == "P4")
    assert m4["residual_cents"] == 0, m4
    assert any(l["invoice_id"] == "INV-1005" for l in (m4["result"] or {}).get("lines", []))
