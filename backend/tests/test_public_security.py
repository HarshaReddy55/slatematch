"""v14 public-demo hardening: per-session workspace isolation, the
export bundle, the per-IP AI budget, and Gemini failure degradation."""
import os, sys, uuid
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
os.environ.setdefault("SLATEMATCH_DATA_DIR", os.path.join(os.path.dirname(__file__), "api_data"))
from fastapi.testclient import TestClient
import api as api_mod
from ai import AiBudget, GeminiClient, parse_remittance

client = TestClient(api_mod.app, raise_server_exceptions=False)


def _sess():
    return {"X-Workspace-Session": str(uuid.uuid4())}


def test_session_workspaces_are_isolated():
    a, b = _sess(), _sess()
    client.post("/api/v1/workspace/reset", headers=a)
    client.post("/api/v1/cases/seed/load", headers=a)
    assert len(client.get("/api/v1/invoices", headers=a).json()) == 19
    # a second visitor's session starts empty and cannot see or wipe A's data
    assert client.get("/api/v1/invoices", headers=b).json() == []
    client.post("/api/v1/workspace/reset", headers=b)
    assert len(client.get("/api/v1/invoices", headers=a).json()) == 19
    # a malformed session header is ignored (falls back to the base tenant)
    base = client.get("/api/v1/invoices").json()
    bad = client.get("/api/v1/invoices", headers={"X-Workspace-Session": "abc"}).json()
    assert len(bad) == len(base)


def test_export_bundle_and_csv():
    client.post("/api/v1/workspace/reset")
    client.post("/api/v1/cases/seed/load")  # v31: loading stages the case
    client.post("/api/v1/workspace/run")
    resp = client.get("/api/v1/export/bundle")
    assert resp.status_code == 200
    assert "attachment" in resp.headers.get("content-disposition", "")
    bundle = resp.json()
    assert bundle["kind"] == "executive-audit-and-sap-clearing-bundle"
    doc = bundle["sap_documents"]["P1"]
    assert doc["balanced"] is True
    assert doc["bapi_payload"]["DOCUMENTHEADER"]["DOCUMENT_TYPE"] == "DZ"
    m1 = next(m for m in bundle["matches"] if m["payment_id"] == "P1")
    assert m1["result"]["derivation"]["equation"]  # the MILP derivation rides along
    assert isinstance(bundle["audit_trail"], list) and bundle["audit_trail"]
    csv_resp = client.get("/api/v1/export/matches.csv")
    assert csv_resp.status_code == 200
    assert "payment_id" in csv_resp.text and "P1" in csv_resp.text


def test_ai_budget_unit():
    budget = AiBudget(limit_per_min=2)
    assert budget.allow("1.2.3.4") is True
    assert budget.allow("1.2.3.4") is True
    assert budget.allow("1.2.3.4") is False
    assert budget.allow("5.6.7.8") is True


def test_parse_degrades_when_budget_exhausted():
    original = api_mod.AI_BUDGET
    api_mod.AI_BUDGET = AiBudget(limit_per_min=0)
    try:
        r = client.post("/api/v1/parse", json={"text": "Wire from Acme Corp $52,000 ref INV-1001 INV-1002"})
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["ai_budget"] == "exhausted"
        assert d["source"] in ("deterministic", "deterministic_fallback")
        assert d["fields"]["amount_cents"] == 5200000
    finally:
        api_mod.AI_BUDGET = original


def test_gemini_failure_falls_back_deterministically():
    def boom(payload):
        raise RuntimeError("simulated quota spike")
    client_g = GeminiClient(api_key="test", transport=boom)
    out = parse_remittance("Payment of $1,250.00 from Globex ref INV-2001",
                           {"INV-2001"}, set(), client=client_g)
    assert out["source"] == "deterministic_fallback"
    assert out["degraded"] is True
    assert out["fields"]["amount_cents"] == 125000
