import sys, os
_D = os.path.join(os.path.dirname(__file__), "api_data")
os.environ["SLATEMATCH_DATA_DIR"] = _D
import shutil
if os.path.exists(_D): shutil.rmtree(_D)
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'app'))
from fastapi.testclient import TestClient
from api import app

client = TestClient(app)

def test_full_flow():
    h = client.get("/health").json()
    assert h["status"] == "ok" and "validity_auc" in h["model_metrics"]
    s = client.post("/api/v1/seed").json()
    assert s["invoices"] == 19 and len(s["payments"]) == 16
    pays = s["payments"]
    b = client.post("/api/v1/batches", json={"idempotency_key": "api-test-1", "payments": pays}).json()
    assert b["status"] == "COMPLETED" and b["payments"] == 16
    res = {r["payment_id"]: r for r in b["results"]}
    assert res["P1"]["status"] == "OPTIMAL_EXACT_MATCH"
    assert {l["invoice_id"] for l in res["P1"]["lines"]} == {"INV-1001", "INV-1002"}
    assert res["P3"]["deduction"]["autonomous_action"] in ("AUTO_GENERATE_DISPUTE_CLAIM", "ROUTE_TO_ANALYST")
    assert any(e["kind"] == "DUPLICATE_PAYMENT" for e in b["exceptions"])
    ev = client.get("/api/v1/evaluations").json()
    assert ev["milp_accuracy"] >= ev["greedy_accuracy"], ev
    assert ev["milp_accuracy"] >= 0.8, ev
    p = client.post("/api/v1/parse", json={"text": "Wire $300.00 from Cascade Chemicals against INV-1006"}).json()
    assert p["fields"]["amount_cents"] == 30000 and "INV-1006" in p["fields"]["invoice_refs"]
    c = client.post("/api/v1/copilot", json={"question": "What is the touchless automation rate?"}).json()
    assert "Touchless" in c["answer"]
    f = client.get("/api/v1/forecast").json()
    assert "weeks" in f
    col = client.get("/api/v1/collections").json()
    assert isinstance(col, list)
