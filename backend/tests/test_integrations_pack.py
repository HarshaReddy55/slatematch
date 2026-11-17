"""Integrations pack: SAP write-back to the connection point
(simulated by default, honestly labelled; HTTP mode records the
real response), webhooks with a public-URL guard and a delivery
log, and the remittance mailbox feed.

Deliveries are asynchronous by design (a webhook can never block
or fail the operation that fired it), so the delivery assertions
poll the log with a deadline instead of assuming immediacy.
"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
os.environ.setdefault("SLATEMATCH_DATA_DIR", os.path.join(os.path.dirname(__file__), "api_data"))
from fastapi.testclient import TestClient
import api as api_mod

client = TestClient(api_mod.app, raise_server_exceptions=False)


def _demo_run():
    client.post("/api/v1/workspace/reset")
    client.post("/api/v1/cases/seed/load")
    return client.post("/api/v1/workspace/run").json()["run"]


def _wait_delivery(event, webhook_id=None, timeout=15.0):
    """The delivery log is a tenant record shared across this
    file's tests, so match on the webhook that must have fired,
    not merely on the latest row for the event."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        d = client.get("/api/v1/webhooks").json()
        rows = [x for x in d["deliveries"] if x["event"] == event
                and (webhook_id is None or x["webhook_id"] == webhook_id)]
        if rows:
            return rows[0]
        time.sleep(0.3)
    return None


def test_transmit_simulated_validates_and_records():
    _demo_run()
    r = client.post("/api/v1/erp/transmit", json={"payment_id": "P1"})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["mode"] == "simulated" and d["status"] == "SIMULATED_POSTED"
    assert d["sap_document_number"].startswith("SAPSIM-")
    listed = client.get("/api/v1/erp/transmissions").json()["transmissions"]
    assert any(t["payment_id"] == "P1" for t in listed)


def test_transmit_unposted_payment_refused():
    _demo_run()
    r = client.post("/api/v1/erp/transmit", json={"payment_id": "P4"})
    assert r.status_code == 409


def test_transmit_http_mode_records_failure_honestly():
    _demo_run()
    r = client.put("/api/v1/integrations/settings",
                   json={"sap_mode": "http", "sap_endpoint": "http://127.0.0.1:9/sap"})
    assert r.status_code == 200, r.text
    try:
        d = client.post("/api/v1/erp/transmit", json={"payment_id": "P1"}).json()
        assert d["mode"] == "http" and d["status"] == "FAILED"
        assert "unreachable" in d["detail"]
    finally:
        client.put("/api/v1/integrations/settings",
                   json={"sap_mode": "simulated", "sap_endpoint": ""})


def test_webhook_guard_and_crud():
    r = client.post("/api/v1/webhooks",
                    json={"url": "http://127.0.0.1:8080/hook", "events": "run.completed"})
    assert r.status_code == 422
    r = client.post("/api/v1/webhooks",
                    json={"url": "https://example.com/hook", "events": "bogus.event"})
    assert r.status_code == 422
    r = client.post("/api/v1/webhooks",
                    json={"url": "https://example.com/hook", "events": "run.completed"})
    assert r.status_code == 200, r.text
    wid = r.json()["webhook_id"]
    listed = client.get("/api/v1/webhooks").json()["webhooks"]
    assert any(w["webhook_id"] == wid for w in listed)
    assert client.delete(f"/api/v1/webhooks/{wid}").status_code == 200
    assert client.delete(f"/api/v1/webhooks/{wid}").status_code == 404


def test_webhook_fires_on_run_completed():
    r = client.post("/api/v1/webhooks",
                    json={"url": "https://example.com/hook", "events": "run.completed"})
    assert r.status_code == 200
    try:
        _demo_run()
        row = _wait_delivery("run.completed", r.json()["webhook_id"])
        assert row is not None, "no delivery recorded for run.completed"
    finally:
        client.delete(f"/api/v1/webhooks/{r.json()['webhook_id']}")


def test_webhook_fires_on_approval():
    r = client.post("/api/v1/webhooks",
                    json={"url": "https://example.com/hook", "events": "approval.decided"})
    assert r.status_code == 200
    try:
        _demo_run()
        queue = client.get("/api/v1/approvals").json()
        matches = queue if isinstance(queue, list) else queue.get("matches", [])
        target = next(m for m in matches if m["payment_id"] == "P16")
        resp = client.post(f"/api/v1/matches/{target['match_id']}/decision",
                           json={"decision": "approve"})
        assert resp.status_code == 200, resp.text
        row = _wait_delivery("approval.decided", r.json()["webhook_id"])
        assert row is not None
    finally:
        client.delete(f"/api/v1/webhooks/{r.json()['webhook_id']}")


def test_remittance_feed_stages_payment():
    client.post("/api/v1/workspace/reset")
    client.post("/api/v1/invoices/import", json={
        "csv_text": "invoice_id,customer,amount,po_number,discount_rate,age_days,due_in_days\n"
                    "INV-A1,Acme Widgets,1000.00,,0,10,30\n", "mode": "replace"})
    r = client.post("/api/v1/feeds/remittance", json={
        "sender": "ap@acme.example", "subject": "Remittance advice",
        "body": "Payment from Acme Widgets: $1,000.00 against invoice INV-A1. Thank you."})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["staged_payment_id"].startswith("MAIL-")
    assert d["amount_cents"] == 100000
    assert "INV-A1" in d["references"]
    events = client.get("/api/v1/feeds/events").json()["events"]
    assert any(e["kind"] == "remittance_mail" and "MAIL-" in e["summary"] for e in events)
    # And the staged wire actually reconciles on the next run.
    run = client.post("/api/v1/workspace/run").json()["run"]
    assert run["auto_posted"] == 1


def test_remittance_feed_rejects_amountless_advice():
    r = client.post("/api/v1/feeds/remittance", json={
        "sender": "x@y.example", "subject": "Hello", "body": "No payment in this mail."})
    assert r.status_code == 422
