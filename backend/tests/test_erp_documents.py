"""v23: the SAP stage's data contract. Step 4 renders the latest run's
posting documents straight from this endpoint, so what it returns must
be the run's cleared payments, balanced, with the dispute reserve."""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
os.environ.setdefault("SLATEMATCH_DATA_DIR", os.path.join(os.path.dirname(__file__), "api_data"))
from fastapi.testclient import TestClient
import api as api_mod

client = TestClient(api_mod.app, raise_server_exceptions=False)


def test_run_documents_empty_before_any_case():
    client.post("/api/v1/workspace/reset")
    d = client.get("/api/v1/erp/run-documents").json()
    assert d["run_id"] is None and d["documents"] == [] and d["reserve"] is None


def test_run_documents_for_the_demo_case():
    client.post("/api/v1/workspace/reset")
    client.post("/api/v1/cases/seed/load")
    client.post("/api/v1/workspace/run")  # v31: execution is explicit
    d = client.get("/api/v1/erp/run-documents").json()
    assert d["run_id"]
    # one document per auto-posted payment of the canonical run
    assert len(d["documents"]) == 10
    assert d["totals"]["documents"] == 10 and d["totals"]["balanced"] is True
    assert d["totals"]["debit_cents"] == d["totals"]["credit_cents"] > 0
    p1 = next(x for x in d["documents"] if x["payment_id"] == "P1")
    doc = p1["document"]
    assert doc["document_type"] == "DZ" and doc["balanced"] is True
    assert doc["bapi_payload"]["DOCUMENTHEADER"]["DOCUMENT_TYPE"] == "DZ"
    gls = {l["gl_account"] for l in doc["journal"]}
    assert "113100" in gls and "121000" in gls  # cash and AR control
    # the P3 dispute claim carries its ASC 606 reserve journal
    assert d["reserve"] is not None and d["reserve"]["claims"] >= 1
    assert d["reserve"]["claimed_cents"] == 420000
    j = d["reserve"]["journals"][0]["journal"]
    assert j["journal"][0]["gl_account"] == "121500"
