"""Payer portal: token-scoped access to exactly one customer's
slice of the workspace - their open invoices, their payments and
statuses, their disputes - plus three bounded actions (remittance
advice, a promise to pay, a dispute response). The token is
stored hashed, shown once, and revocation is immediate. Every
cross-customer attempt must 404, never leak.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
os.environ.setdefault("SLATEMATCH_DATA_DIR", os.path.join(os.path.dirname(__file__), "api_data"))
from fastapi.testclient import TestClient
import api as api_mod

client = TestClient(api_mod.app, raise_server_exceptions=False)


def _two_customers():
    client.post("/api/v1/workspace/reset")
    client.post("/api/v1/invoices/import", json={
        "csv_text": "invoice_id,customer,amount,po_number,discount_rate,age_days,due_in_days\n"
                    "INV-A1,Acme Widgets,1000.00,,0,10,30\n"
                    "INV-Z1,Zeta Parts,2000.00,,0,5,20\n", "mode": "replace"})


def _link(customer):
    r = client.post("/api/v1/portal-links", json={"customer": customer})
    assert r.status_code == 200, r.text
    return r.json()


def test_link_shown_once_and_scoped_summary():
    _two_customers()
    d = _link("Acme Widgets")
    token = d["url"].split("/portal/")[1]
    s = client.get(f"/api/v1/portal/{token}/summary")
    assert s.status_code == 200, s.text
    body = s.json()
    assert body["customer"] == "Acme Widgets"
    ids = {i["invoice_id"] for i in body["open_invoices"]}
    assert ids == {"INV-A1"}  # Zeta's invoice is invisible


def test_bad_and_revoked_tokens_refused():
    _two_customers()
    d = _link("Acme Widgets")
    token = d["url"].split("/portal/")[1]
    assert client.get("/api/v1/portal/ptk_nope/summary").status_code == 401
    r = client.delete(f"/api/v1/portal-links/{d['link_id']}")
    assert r.status_code == 200
    assert client.get(f"/api/v1/portal/{token}/summary").status_code == 401
    listed = client.get("/api/v1/portal-links").json()["links"]
    row = next(x for x in listed if x["link_id"] == d["link_id"])
    assert row["revoked"] is True


def test_portal_remittance_stages_for_own_customer():
    _two_customers()
    token = _link("Acme Widgets")["url"].split("/portal/")[1]
    r = client.post(f"/api/v1/portal/{token}/remittance",
                    json={"text": "Payment from Acme Widgets: $1,000.00 against invoice INV-A1."})
    assert r.status_code == 200, r.text
    assert r.json()["staged_payment_id"].startswith("PORTAL-")
    s = client.get(f"/api/v1/portal/{token}/summary").json()
    mine = [p for p in s["payments"] if p["payment_id"].startswith("PORTAL-")]
    assert len(mine) == 1 and mine[0]["amount_cents"] == 100000


def test_portal_promise_own_invoice_only():
    _two_customers()
    token = _link("Acme Widgets")["url"].split("/portal/")[1]
    r = client.post(f"/api/v1/portal/{token}/promise",
                    json={"invoice_id": "INV-A1", "promised_date": "2026-12-01"})
    assert r.status_code == 200, r.text
    promises = client.get("/api/v1/collections/promises").json()["promises"]
    assert any(p["invoice_id"] == "INV-A1" for p in promises)
    r = client.post(f"/api/v1/portal/{token}/promise",
                    json={"invoice_id": "INV-Z1", "promised_date": "2026-12-01"})
    assert r.status_code == 404  # another customer's invoice: invisible, not forbidden-looking


def test_portal_dispute_response_scoped_and_not_a_decision():
    client.post("/api/v1/workspace/reset")
    client.post("/api/v1/cases/seed/load")
    client.post("/api/v1/workspace/run")
    token = _link("BluePeak Electronics")["url"].split("/portal/")[1]
    s = client.get(f"/api/v1/portal/{token}/summary").json()
    assert len(s["disputes"]) == 1
    did = s["disputes"][0]["dispute_id"]
    r = client.post(f"/api/v1/portal/{token}/disputes/{did}/respond",
                    json={"stance": "evidence", "note": "POD attached in our system"})
    assert r.status_code == 200, r.text
    s2 = client.get(f"/api/v1/portal/{token}/summary").json()
    assert s2["disputes"][0]["status"] == "OPEN"  # a response is evidence, not a decision
    assert s2["disputes"][0]["responses"][0]["stance"] == "evidence"
    # Another customer cannot even see it, let alone respond.
    token2 = _link("Apex Manufacturing")["url"].split("/portal/")[1]
    r = client.post(f"/api/v1/portal/{token2}/disputes/{did}/respond",
                    json={"stance": "accepted", "note": "not ours"})
    assert r.status_code == 404


def test_portal_page_serves():
    r = client.get("/portal/ptk_anything")
    assert r.status_code == 200
    assert "payer portal" in r.text
