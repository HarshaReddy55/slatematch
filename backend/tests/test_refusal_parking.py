"""v26: a zero-line record in the sign-off queue is the solver's refusal
verdict, not a match. Approving it must never issue a clearing document
or post anything - it parks the wire in unapplied suspense. Real held
matches keep the full posting path."""
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
    return client.get("/api/v1/approvals").json()


def test_queue_shape_seed_has_one_refusal():
    lst = _seed()
    assert len(lst) == 5
    p6 = next(a for a in lst if a["payment_id"] == "P6")
    assert p6["invoices"] == []
    real = [a for a in lst if a["invoices"]]
    assert len(real) == 4


def test_approving_a_refusal_parks_it_without_a_document():
    lst = _seed()
    hub_before = client.get("/api/v1/mail/hub").json()
    settle_before = len(hub_before["settlements"])
    p6 = next(a for a in lst if a["payment_id"] == "P6")
    r = client.post(f"/api/v1/matches/{p6['match_id']}/decision", json={"decision": "approve"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "PARKED_SUSPENSE", body
    assert body["erp_document_id"] is None
    assert body["settled_invoices"] == []
    # Gone from the queue; the four real matches remain
    after = client.get("/api/v1/approvals").json()
    assert len(after) == 4 and all(a["invoices"] for a in after)
    # No settlement confirmation was generated for the parked wire
    hub_after = client.get("/api/v1/mail/hub").json()
    assert len(hub_after["settlements"]) == settle_before
    # The parking is in the audit trail under its own action name
    audit = client.get("/api/v1/audit").json()
    assert any(e["action"] == "match_parked_suspense" for e in audit)


def test_rejecting_a_refusal_sends_it_back():
    lst = _seed()
    p6 = next(a for a in lst if a["payment_id"] == "P6")
    r = client.post(f"/api/v1/matches/{p6['match_id']}/decision", json={"decision": "reject"})
    assert r.status_code == 200 and r.json()["status"] == "REJECTED"


def test_real_match_still_posts_with_a_document():
    lst = _seed()
    p7 = next(a for a in lst if a["payment_id"] == "P7")
    r = client.post(f"/api/v1/matches/{p7['match_id']}/decision", json={"decision": "approve"})
    body = r.json()
    assert body["status"] == "APPROVED_POSTED"
    assert body["erp_document_id"] and body["erp_document_id"].startswith("DZ-")
    assert body["settled_invoices"]
