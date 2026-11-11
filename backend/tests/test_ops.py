import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'app'))
os.environ.setdefault("SLATEMATCH_DATA_DIR", os.path.join(os.path.dirname(__file__), "ops_data"))
from fastapi.testclient import TestClient
from api import app
client = TestClient(app, raise_server_exceptions=False)

def test_request_id_metrics_ready():
    r = client.get("/health")
    assert r.headers.get("x-request-id")
    r2 = client.get("/ready")
    assert r2.status_code == 200 and r2.json()["ready"] is True
    m = client.get("/metrics")
    assert "slatematch_requests_total" in m.text and 'path="/health"' in m.text

def test_rate_limit(monkeypatch):
    monkeypatch.setenv("SLATEMATCH_RATE_LIMIT_PER_MIN", "3")
    codes = [client.get("/api/v1/invoices").status_code for _ in range(6)]
    assert 429 in codes, codes
