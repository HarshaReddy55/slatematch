"""Autonomy build: autopilot resolutions with reversal, payer
behaviour profiles, collections actions and promises, the dispute
lifecycle, pre-arrival predictions, and evaluation drift snapshots.

The autopilot cases are small partial wires against one staged
invoice: a $990 wire on a $1,000 invoice leaves a $10 shortfall -
inside the $25 tolerance at autonomy level 1, outside it at $30.
Maker-checker holds are never the autopilot's business, at any
level.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
os.environ.setdefault("SLATEMATCH_DATA_DIR", os.path.join(os.path.dirname(__file__), "api_data"))
from fastapi.testclient import TestClient
import api as api_mod

client = TestClient(api_mod.app, raise_server_exceptions=False)

INV = ("invoice_id,customer,amount,po_number,discount_rate,age_days,due_in_days\n"
       "INV-A1,Acme Widgets,{amount},,0,10,30\n")


def _stage(amount="1000.00"):
    client.post("/api/v1/workspace/reset")
    r = client.post("/api/v1/invoices/import",
                    json={"csv_text": INV.format(amount=amount), "mode": "replace"})
    assert r.status_code == 200, r.text


def _batch(pid, cents, key, refs=("INV-A1",)):
    body = {"idempotency_key": key,
            "payments": [{"payment_id": pid, "payer_raw": "Acme Widgets",
                          "amount_cents": cents, "references": list(refs)}]}
    return client.post("/api/v1/batches", json=body).json()


def _set_policy(**kw):
    r = client.put("/api/v1/policy", json={"policy": kw})
    assert r.status_code == 200, r.text


def _match_status(pid):
    d = client.get(f"/api/v1/payments/{pid}/erp-document").json()
    return d["match_id"], d["status"], d["document"]


def test_autopilot_off_by_default():
    _stage()
    run = _batch("W-990", 99000, "auto-off-1")
    assert run["auto_posted"] == 0
    _mid, status, _doc = _match_status("W-990")
    assert status == "PROPOSED"  # a human still decides


def test_autopilot_level1_resolves_and_reverses():
    _stage()
    try:
        _set_policy(autonomy_level=1)
        _batch("W-990", 99000, "auto-l1-1")
        mid, status, _doc = _match_status("W-990")
        assert status == "APPROVED_POSTED"  # autopilot resolved it
        invs = client.get("/api/v1/invoices").json()
        inv = next(i for i in invs if i["invoice_id"] == "INV-A1")
        assert inv["gross_cents"] == 1000  # $10 shortfall stays open
        r = client.post(f"/api/v1/matches/{mid}/reverse")
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "REVERSED"
        invs = client.get("/api/v1/invoices").json()
        inv = next(i for i in invs if i["invoice_id"] == "INV-A1")
        assert inv["gross_cents"] == 100000  # pre-state restored
        r2 = client.post(f"/api/v1/matches/{mid}/reverse")
        assert r2.status_code == 409  # not reversible twice
    finally:
        _set_policy(autonomy_level=0)


def test_autopilot_cap_and_maker_checker():
    _stage()
    try:
        _set_policy(autonomy_level=1)
        _batch("W-970", 97000, "auto-cap-1")  # $30 shortfall > $25 tolerance
        _mid, status, _doc = _match_status("W-970")
        assert status == "PROPOSED"
    finally:
        _set_policy(autonomy_level=0)
    _stage("100020.00")
    try:
        _set_policy(autonomy_level=2)
        _batch("W-BIG", 10001000, "auto-mc-1")  # $10 short, but over the $100k maker-checker line
        _mid, status, _doc = _match_status("W-BIG")
        assert status == "PROPOSED"  # maker-checker holds stay human
    finally:
        _set_policy(autonomy_level=0)


def test_autonomy_policy_validation():
    r = client.put("/api/v1/policy", json={"policy": {"autonomy_level": 3}})
    assert r.status_code == 422
    r = client.put("/api/v1/policy", json={"policy": {"autopilot_max_residual_cents": -5}})
    assert r.status_code == 422


def _demo_run():
    client.post("/api/v1/workspace/reset")
    client.post("/api/v1/cases/seed/load")
    client.post("/api/v1/workspace/run")


def test_behaviour_profiles_and_hint():
    _demo_run()
    d = client.get("/api/v1/behaviour-profiles").json()
    apex = next(p for p in d["profiles"] if p["payer"] == "Apex Manufacturing")
    # Apex carries two match records in the demo (P1, P2); the third
    # Apex wire (P5) is a duplicate and never becomes a match.
    assert apex["payments"] >= 2 and apex["posted"] >= 2
    body = {"idempotency_key": "behav-1",
            "payments": [{"payment_id": "W-UNKNOWN", "payer_raw": "Apex Manufacturing",
                          "amount_cents": 12345, "references": []}]}
    run = client.post("/api/v1/batches", json=body).json()
    excs = client.get(f"/api/v1/runs/{run['run_id']}/exceptions").json()
    exc = next(e for e in excs if e["payment_id"] == "W-UNKNOWN")
    assert exc["kind"] == "NO_MATCH"
    # Apex has a decided history in this workspace, so the exception
    # carries the payer's behaviour hint for triage.
    assert "Payer history" in (exc["detail"].get("behaviour_hint") or "")
    hub = client.get("/api/v1/mail/hub").json()
    chase = next(c for c in hub["chases"] if c["payment_id"] == "W-UNKNOWN")
    assert chase["kind"] == "NO_MATCH"


def test_collections_actions_and_promises():
    _demo_run()
    q = client.get("/api/v1/collections").json()
    assert q, "collections queue must be non-empty after the demo run"
    inv_id = q[0]["invoice_id"]
    r = client.post("/api/v1/collections/act",
                    json={"invoice_id": inv_id, "action": "remind"})
    assert r.status_code == 200 and r.json()["status"] == "draft"
    out = client.get("/api/v1/mail/outbox").json()
    assert any(m["kind"] == "collection_reminder" and m["ref_id"] == inv_id
               for m in out["mails"])
    r = client.post("/api/v1/collections/act",
                    json={"invoice_id": inv_id, "action": "promise",
                          "promised_date": "2999-01-01", "note": "confirmed on call"})
    assert r.status_code == 200 and r.json()["status"] == "OPEN"
    r = client.post("/api/v1/collections/act",
                    json={"invoice_id": inv_id, "action": "promise",
                          "promised_date": "2000-01-01"})
    assert r.status_code == 200
    ps = client.get("/api/v1/collections/promises").json()["promises"]
    mine = [p for p in ps if p["invoice_id"] == inv_id]
    assert any(p["status"] == "OPEN" for p in mine)
    assert any(p["status"] == "BROKEN" for p in mine)  # past date, still open
    r = client.post("/api/v1/collections/act",
                    json={"invoice_id": inv_id, "action": "promise",
                          "promised_date": "01/01/2030"})
    assert r.status_code == 422


def test_dispute_lifecycle():
    _demo_run()
    ds = client.get("/api/v1/disputes").json()["disputes"]
    assert ds, "the demo run generates a dispute claim (P3)"
    d0 = ds[0]
    assert d0["status"] == "OPEN" and d0["escalation_due"] is False
    r = client.post(f"/api/v1/disputes/{d0['dispute_id']}/transition",
                    json={"status": "SENT"})
    assert r.status_code == 200 and r.json()["status"] == "SENT"
    out = client.get("/api/v1/mail/outbox").json()
    assert any(m["kind"] == "dispute_claim" and m["ref_id"] == d0["dispute_id"]
               for m in out["mails"])
    r = client.post(f"/api/v1/disputes/{d0['dispute_id']}/transition",
                    json={"status": "WON", "note": "customer accepted"})
    assert r.status_code == 200
    r = client.post(f"/api/v1/disputes/{d0['dispute_id']}/transition",
                    json={"status": "ESCALATED"})
    assert r.status_code == 409  # terminal: the outcome is booked
    r = client.post("/api/v1/disputes/DSP-nope/transition", json={"status": "WON"})
    assert r.status_code == 404


def test_predictions_state_and_content():
    client.post("/api/v1/workspace/reset")
    d = client.get("/api/v1/predictions").json()
    assert d["state"] == "empty" and d["expected"] == []
    _demo_run()
    d = client.get("/api/v1/predictions").json()
    assert d["state"] == "ready" and d["expected"]
    row = d["expected"][0]
    assert row["expected_date"] and "prob_within_30" in row
    assert d["expected_14d_cents"] >= 0


def test_evaluations_trend_snapshot():
    d = client.get("/api/v1/evaluations/trend").json()
    assert d["snapshots"], "first call records a snapshot"
    assert d["latest_accuracy"] == d["snapshots"][-1]["milp_accuracy"]
    assert d["drift_flag"] is False  # a single baseline cannot drift
    n = len(d["snapshots"])
    d2 = client.get("/api/v1/evaluations/trend").json()
    assert len(d2["snapshots"]) == n  # one snapshot per day, not per call
