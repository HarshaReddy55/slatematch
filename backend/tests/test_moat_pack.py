"""Moat-completion pack: behaviour priors in the solver,
evidence fusion, credit signals, the treasury view, collections
escalation, ERP targets (Oracle/NetSuite), chat approvals,
virtual accounts, the bank feed pull, period evidence packs,
the drift webhook event and the prospect self-serve replay."""
import os, sys, json

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
os.environ["SLATEMATCH_DATA_DIR"] = os.path.join(os.path.dirname(__file__), "api_data")

from fastapi.testclient import TestClient  # noqa: E402
import api  # noqa: E402

c = TestClient(api.app)
H = {"X-API-Key": "dev-key", "Content-Type": "application/json"}


def _reset_and_run():
    c.post("/api/v1/workspace/reset", headers=H)
    c.post("/api/v1/cases/seed/load", headers=H)
    c.post("/api/v1/workspace/run", headers=H)


def _import(kind, csv, mode=None):
    body = {"csv_text": csv}
    if mode:
        body["mode"] = mode
    return c.post(f"/api/v1/{kind}/import", headers=H, json=body)


HIST_INV = "invoice_id,customer,amount\nINV-901,Bundle Co,500.00\nINV-902,Bundle Co,500.00\n"
HIST_PAY = ("payment_id,payer,amount,remittance_text\n"
            "W1,Bundle Co,500.00,Wire for INV-901\nW2,Bundle Co,500.00,Wire for INV-902\n")
TIE_INV = "invoice_id,customer,amount,age_days\nA1,Bundle Co,100.00,1\nA2,Bundle Co,100.00,1\nA3,Bundle Co,200.00,60\n"
TIE_PAY = "payment_id,payer,amount\nW3,Bundle Co,200.00\n"


def _evidence_for(run_id):
    return c.get(f"/api/v1/runs/{run_id}/evidence", headers=H).json()


def _latest_run_id():
    runs = c.get("/api/v1/runs", headers=H).json()
    rows = runs["runs"] if isinstance(runs, dict) else runs
    return rows[0]["run_id"]


def test_behaviour_prior_resolves_ambiguous_tie():
    c.post("/api/v1/workspace/reset", headers=H)
    assert _import("invoices", HIST_INV).status_code == 200
    assert _import("payments", HIST_PAY).status_code == 200  # history: 2 posted, 1 line each
    # append, not replace: a replace import starts a fresh ledger
    # and would wipe the judged history the prior learns from
    assert _import("invoices", TIE_INV, mode="append").status_code == 200
    assert _import("payments", TIE_PAY).status_code == 200
    pack = _evidence_for(_latest_run_id())
    w3 = [m for m in pack["matches"] if m["payment_id"] == "W3"]
    assert w3, "the tied wire produced no match"
    assert w3[0]["status"] == "AUTO_POSTED", w3[0]["status"]
    deriv = (w3[0]["result"] or {}).get("derivation") or {}
    assert (deriv.get("behaviour_prior") or {}).get("applied") is True


def test_same_tie_without_history_stays_held():
    c.post("/api/v1/workspace/reset", headers=H)
    assert _import("invoices", TIE_INV.replace("Bundle Co", "Stranger Co")).status_code == 200
    assert _import("payments", TIE_PAY.replace("Bundle Co", "Stranger Co")).status_code == 200
    pack = _evidence_for(_latest_run_id())
    w3 = [m for m in pack["matches"] if m["payment_id"] == "W3"]
    assert w3 and w3[0]["status"] == "PROPOSED", w3


def test_evidence_fusion_bank_beats_email_and_stages():
    c.post("/api/v1/workspace/reset", headers=H)
    _import("invoices", "invoice_id,customer,amount\nINV-A1,Acme Widgets,10000.00\n")
    r = c.post("/api/v1/evidence/fuse", headers=H, json={
        "sources": [
            {"kind": "email", "text": "We have paid $10,400.00 against invoice INV-A1. Regards, Acme Widgets"},
            {"kind": "bank", "text": "Wire received $10,000.00 from Acme Widgets"}],
        "stage": True})
    assert r.status_code == 200, r.text
    d = r.json()
    b = d["bundle"]
    assert b["fields"]["amount_cents"] == 1000000  # the bank's figure wins
    assert b["provenance"]["amount_cents"] == "bank"
    amounts = [x for x in b["conflicts"] if x["field"] == "amount_cents"]
    assert amounts and amounts[0]["winner"] == "bank"
    assert d["staged_payment_id"].startswith("FUSE-")


def test_credit_signals_and_treasury_after_demo_run():
    _reset_and_run()
    r = c.get("/api/v1/credit-signals", headers=H)
    assert r.status_code == 200
    rows = r.json()["signals"]
    assert rows and all("signal" in x and "reasons" in x for x in rows)
    t = c.get("/api/v1/treasury", headers=H).json()
    assert t["state"] == "ready" and len(t["weeks"]) == 8
    assert t["open_ar_cents"] > 0


def test_collections_escalation_drafts_and_idempotent():
    # Unique invoice id per run: the outbox is a tenant record that
    # survives workspace resets (by design), and the once-a-day
    # rule must not leak between suite runs sharing a data dir.
    iid = "INV-ESC-" + os.urandom(3).hex().upper()
    c.post("/api/v1/workspace/reset", headers=H)
    _import("invoices",
            f"invoice_id,customer,amount,due_in_days\n{iid},Slow Lane Ltd,5000.00,-30\n")
    r = c.post("/api/v1/collections/escalate", headers=H)
    assert r.status_code == 200, r.text
    esc = r.json()["escalated"]
    assert any(e["invoice_id"] == iid and e["kind"] == "overdue_beyond_window"
               for e in esc), esc
    r2 = c.post("/api/v1/collections/escalate", headers=H).json()
    assert r2["escalated"] == []  # never twice in one day


def test_erp_targets_oracle_and_netsuite():
    _reset_and_run()
    for target, prefix in (("oracle", "ORASIM-"), ("netsuite", "NSSIM-"), ("sap", "SAPSIM-")):
        p = c.put("/api/v1/integrations/settings", headers=H,
                  json={"sap_mode": "simulated", "sap_endpoint": "", "erp_target": target})
        assert p.status_code == 200, p.text
        t = c.post("/api/v1/erp/transmit", headers=H, json={"payment_id": "P1"})
        assert t.status_code == 200, t.text
        d = t.json()
        assert d["status"] == "SIMULATED_POSTED" and d["target"] == target
        assert d["sap_document_number"].startswith(prefix), d


def test_chat_settings_guard_and_test():
    bad = c.put("/api/v1/integrations/chat", headers=H,
                json={"slack_url": "http://127.0.0.1:9000/hook", "teams_url": ""})
    assert bad.status_code == 422
    ok = c.put("/api/v1/integrations/chat", headers=H,
               json={"slack_url": "https://hooks.example.com/hook", "teams_url": ""})
    assert ok.status_code == 200
    t = c.post("/api/v1/integrations/chat/test", headers=H)
    assert t.status_code == 200 and t.json()["sent_to"] == ["slack"]
    c.put("/api/v1/integrations/chat", headers=H, json={"slack_url": "", "teams_url": ""})


def test_virtual_accounts_stable():
    _reset_and_run()
    a = c.get("/api/v1/virtual-accounts", headers=H).json()["accounts"]
    b = c.get("/api/v1/virtual-accounts", headers=H).json()["accounts"]
    assert a == b and any(x["customer"] == "BluePeak Electronics" for x in a)
    assert all(len(x["virtual_account"]) == 10 for x in a)


def test_bank_pull_guards():
    local = c.post("/api/v1/feeds/bank/pull", headers=H,
                   json={"url": "http://127.0.0.1:9/feed.bai2"})
    assert local.status_code == 422
    missing = c.post("/api/v1/feeds/bank/pull", headers=H,
                     json={"url": "https://example.com/nope.bai2"})
    assert missing.status_code == 502


def test_period_evidence_pack():
    _reset_and_run()
    rid = _latest_run_id()
    r = c.get("/api/v1/evidence/period?days=30", headers=H)
    assert r.status_code == 200
    d = r.json()
    assert rid in d["runs"] and len(d["manifest_sha256"]) == 64


def test_drift_webhook_event_is_subscribable():
    w = c.post("/api/v1/webhooks", headers=H,
               json={"url": "https://example.com/hook", "events": "evaluation.drift"})
    assert w.status_code == 200, w.text
    c.delete(f"/api/v1/webhooks/{w.json()['webhook_id']}", headers=H)


def test_public_replay_and_page():
    r = c.post("/api/v1/replay/public", json={
        "invoices_csv": "invoice_id,customer,amount\nINV-1,Acme Widgets,12000.00\n",
        "payments_csv": "payment_id,payer,amount,remittance_text\nW-1,Acme Widgets,12000.00,Wire for INV-1\n"})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["auto_posted"] == 1 and d["touchless_rate"] == 1.0
    bad = c.post("/api/v1/replay/public", json={"invoices_csv": "x", "payments_csv": "y"})
    assert bad.status_code == 422
    page = c.get("/replay")
    assert page.status_code == 200 and "Replay your own ledger" in page.text
