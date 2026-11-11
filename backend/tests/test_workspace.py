import os, sys, tempfile, importlib.util
APP_DIR = os.path.join(os.path.dirname(__file__), "..", "app")
sys.path.insert(0, APP_DIR)
# Hermetic private app instance (same pattern as test_enterprise.py).
os.environ["SLATEMATCH_DATA_DIR"] = tempfile.mkdtemp(prefix="ac_ws_")
_spec = importlib.util.spec_from_file_location("api_workspace", os.path.join(APP_DIR, "api.py"))
_mod = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(_mod)
from fastapi.testclient import TestClient
c = TestClient(_mod.app)

def test_case_load_makes_one_shared_workspace():
    out = c.post("/api/v1/cases/split-exact/load").json()
    ws = out["workspace"]
    assert ws["case"]["id"] == "split-exact"
    assert ws["open_invoices"] == 18
    # v31: loading stages the case - everything pending, nothing run yet
    assert ws["run_status"] == "staged" and ws["latest_run"] is None
    assert len(ws["pending_payments"]) == 12 and out["run"] is None
    # every view reads the same workspace
    invs = c.get("/api/v1/invoices").json()
    assert {"S1-INV-1", "S1-INV-2", "S1-INV-3"} <= {i["invoice_id"] for i in invs}
    assert len(invs) == 18
    # run the staged payment through the normal batch path
    b = c.post("/api/v1/batches", json={"idempotency_key": "ws-1", "payments": out["payments"]}).json()
    # v39: results arrive in evidence (processing) order, not submission
    # order - select the hero payment by id, not by position.
    hero = next(r for r in b["results"] if r["payment_id"] == out["payments"][0]["payment_id"])
    assert hero["status"] == "OPTIMAL_EXACT_MATCH"
    assert {l["invoice_id"] for l in hero["lines"]} == {"S1-INV-1", "S1-INV-2"}
    ws2 = c.get("/api/v1/workspace").json()
    assert ws2["latest_run"]["run_id"] == b["run_id"]
    assert ws2["pending_payments"] == []

def test_load_replaces_previous_case():
    c.post("/api/v1/cases/seed/load")
    ws = c.get("/api/v1/workspace").json()
    assert ws["case"]["id"] == "seed" and ws["open_invoices"] == 19
    c.post("/api/v1/cases/seed/load")
    c.post("/api/v1/workspace/run")
    c.post("/api/v1/cases/duplicate-guard/load")
    ws = c.get("/api/v1/workspace").json()
    assert ws["case"]["id"] == "duplicate-guard" and ws["open_invoices"] == 16
    # loading a new case clears the previous case AND its run (v31 staged)
    assert ws["run_status"] == "staged" and ws["latest_run"] is None
    assert len(ws["pending_payments"]) == ws["staged_payments"]

def test_reset_empties_workspace():
    c.post("/api/v1/cases/seed/load")
    ws = c.post("/api/v1/workspace/reset").json()
    assert ws["case"] is None and ws["open_invoices"] == 0 and ws["pending_payments"] == []

def test_stream_can_run_workspace_pending():
    out = c.post("/api/v1/cases/po-wins/load").json()
    assert len(out["payments"]) == 11
    with c.stream("POST", "/api/v1/runs/stream", json={"use_workspace": True}) as r:
        assert r.status_code == 200
        body = "".join(r.iter_lines())
    assert "batch_done" in body
    ws = c.get("/api/v1/workspace").json()
    assert ws["latest_run"] is not None and ws["pending_payments"] == []

def test_unknown_case_404():
    assert c.post("/api/v1/cases/nope/load").status_code == 404

def test_custom_case_loads_into_workspace():
    out = c.post("/api/v1/workspace/load-custom", json={
        "invoices": [{"invoice_id": "C-1", "customer": "Apex Manufacturing", "gross_cents": 30000, "po_number": "PO-1", "age_days": 40},
                     {"invoice_id": "C-2", "customer": "Apex Manufacturing", "gross_cents": 20000, "po_number": "PO-2", "age_days": 10}],
        "payments": [{"payment_id": "C-P1", "payer_raw": "Apex Manufacturing", "amount_cents": 50000}]}).json()
    ws = out["workspace"]
    # Loading a builder case runs it in the same call; the single wire
    # exactly covers both invoices and auto-posts, settling them - so
    # the open book is empty afterwards and nothing is left pending.
    assert ws["case"]["id"] == "custom" and ws["open_invoices"] == 0 and len(ws["pending_payments"]) == 0
    assert {l["invoice_id"] for l in out["run"]["results"][0]["lines"]} == {"C-1", "C-2"}
    # Re-submitting the same payments must not solve them twice.
    b = c.post("/api/v1/batches", json={"idempotency_key": "ws-custom-1", "payments": out["payments"]}).json()
    assert b["results"] == [] and b["skipped_existing"] == 1

def test_stage_payment_endpoint():
    r = c.post("/api/v1/workspace/stage-payment", json={
        "payer": "Apex Manufacturing", "amount_cents": 20000,
        "references": ["INV-1001"], "remittance_text": "wire for INV-1001"})
    assert r.status_code == 200
    body = r.json()
    assert body["staged"].startswith("WIRE-")
    assert body["workspace"]["pending_payments"], "staged wire must be pending"
    bad = c.post("/api/v1/workspace/stage-payment", json={"amount_cents": 0})
    assert bad.status_code == 422
