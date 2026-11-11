"""v21: the connected-workflow contract (owner spec, 1 Nov 2026).
Loading a case runs it in the same call, so no page can sit on a
loaded-but-unrun case. Forecast, collections and the Mail Hub obey
one state rule: nothing before a case is loaded and run, and after a
run they read only the post-reconciliation residual ledger. Every
cleared payment generates its settlement confirmation in the Mail
Hub - the run's auto-posts and each maker-checker approval alike."""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
os.environ.setdefault("SLATEMATCH_DATA_DIR", os.path.join(os.path.dirname(__file__), "api_data"))
from fastapi.testclient import TestClient
import api as api_mod

client = TestClient(api_mod.app, raise_server_exceptions=False)


def _load():
    client.post("/api/v1/workspace/reset")
    r = client.post("/api/v1/cases/seed/load")
    assert r.status_code == 200, r.text
    return r.json()


def test_load_stages_then_explicit_run_executes():
    # v31 two-stage lifecycle: loading stages the case (nothing solved,
    # nothing pending decision), execution is a separate explicit act.
    d = _load()
    assert d["run"] is None
    ws = d["workspace"]
    assert ws["run_status"] == "staged"
    assert ws["latest_run"] is None
    assert len(ws["pending_payments"]) == 16
    assert ws["approvals_pending"] == 0
    rr = client.post("/api/v1/workspace/run")
    assert rr.status_code == 200, rr.text
    run = rr.json()["run"]
    assert run["auto_posted"] == 10
    ws = rr.json()["workspace"]
    assert ws["run_status"] == "executed"
    assert ws["latest_run"] is not None
    assert ws["pending_payments"] == []
    assert ws["approvals_pending"] == 5


def _load_and_run():
    _load()
    rr = client.post("/api/v1/workspace/run")
    assert rr.status_code == 200, rr.text
    return rr.json()["run"]


def test_forecast_state_rule_and_residual_basis():
    client.post("/api/v1/workspace/reset")
    f = client.get("/api/v1/forecast").json()
    assert f["state"] == "empty" and f["weeks"] == [] and f["summary"] is None
    assert client.post("/api/v1/forecast/whatif", json={
        "customer": "Cascade Chemicals", "shift_days": -7}).status_code == 404
    assert client.get("/api/v1/collections").json() == []
    _load()
    f = client.get("/api/v1/forecast").json()
    assert f["state"] == "loaded_not_run"  # v31: staged is a first-class state
    client.post("/api/v1/workspace/run")
    f = client.get("/api/v1/forecast").json()
    assert f["state"] == "ready" and f["weeks"]
    ids = {d["invoice_id"] for d in f["invoices"]}
    # P1 auto-posted against INV-1001: settled money leaves the forecast
    assert "INV-1001" not in ids
    # P7 is only PROPOSED (maker-checker hold): its invoice is still open
    assert "INV-1006" in ids
    # the forecast basis is the residual ledger, not the full $1,004,030 book
    assert f["summary"]["open_ar_cents"] < 100_403_000
    col = client.get("/api/v1/collections").json()
    assert col and "INV-1001" not in {r["invoice_id"] for r in col}


def test_mail_hub_four_categories_from_one_run():
    run_id = _load_and_run()["run_id"]
    h = client.get("/api/v1/mail/hub").json()
    assert h["state"] == "ready"
    assert any(d["payment_id"] == "P3" for d in h["disputes"])
    chase = next((c for c in h["chases"] if c["payment_id"] == "P6"), None)
    assert chase and chase["kind"] == "NO_MATCH"
    st = next((s for s in h["settlements"] if s["payment_id"] == "P1"), None)
    assert st and st["status"] == "AUTO_POSTED" and st["net_cents"] == 5_200_000
    assert h["dunning"] and all("tone_label" in d for d in h["dunning"])
    # the run itself generated the settlement confirmation drafts
    # (the outbox is a ledger and survives resets, so count this run's)
    drafts = [m for m in h["outbox"]
              if m["kind"] == "settlement_confirmation" and m["status"] == "draft"
              and m["ref_id"].startswith(run_id + ":")]
    assert len(drafts) == 10  # one per auto-posted payment


def test_mail_hub_empty_state():
    client.post("/api/v1/workspace/reset")
    h = client.get("/api/v1/mail/hub").json()
    assert h["state"] == "empty"
    assert h["disputes"] == [] and h["chases"] == [] and h["dunning"] == []


def test_approval_generates_its_settlement_confirmation():
    _load_and_run()
    appr = client.get("/api/v1/approvals").json()
    p7 = next(a for a in appr if a["payment_id"] == "P7")
    r = client.post(f"/api/v1/matches/{p7['match_id']}/decision",
                    json={"decision": "approve"})
    assert r.status_code == 200, r.text
    out = client.get("/api/v1/mail/outbox").json()["mails"]
    mine = [m for m in out if m["kind"] == "settlement_confirmation"
            and m["ref_id"].endswith(":P7")]
    assert mine and mine[0]["status"] == "draft"
    # and P7's invoice has now left the forecast basis too
    f = client.get("/api/v1/forecast").json()
    assert "INV-1006" not in {d["invoice_id"] for d in f["invoices"]}
