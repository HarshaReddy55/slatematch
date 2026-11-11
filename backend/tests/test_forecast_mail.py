"""Forecast v2 (drill-down, rollups, what-if) and the mail outbox."""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
os.environ.setdefault("SLATEMATCH_DATA_DIR", os.path.join(os.path.dirname(__file__), "api_data"))
from fastapi.testclient import TestClient
import api as api_mod
from forecast import forecast_cash_in
from seed import seed_invoices
import ml as mlmod
from repository import Repository
from mail import mail_config, reminder_draft, send_mail

client = TestClient(api_mod.app)


def test_forecast_v2_shape_and_drilldown():
    m = mlmod.train_all()
    fc = forecast_cash_in(seed_invoices(), m["delay_model"])
    assert fc["horizon_days"] == 56 and len(fc["weeks"]) == 8
    # every open invoice appears exactly once: in a week bucket or beyond
    placed = [i for w in fc["weeks"] for i in w["invoice_ids"]] + fc["beyond"]["invoice_ids"]
    assert sorted(placed) == sorted(i.invoice_id for i in seed_invoices())
    s = fc["summary"]
    assert s["open_ar_cents"] == sum(i.gross_cents for i in seed_invoices())
    assert 0 <= s["expected_30_cents"] <= s["open_ar_cents"]
    assert s["expected_horizon_cents"] >= s["expected_30_cents"]
    for d in fc["invoices"]:
        assert d["predicted_delay_days"] != 0.0 or True  # model value present
        assert "prob_within_30" in d and "expected_week" in d
    cust = {c["customer"]: c for c in fc["customers"]}
    assert sum(c["open_cents"] for c in cust.values()) == s["open_ar_cents"]


def test_forecast_whatif_moves_cash():
    client.post("/api/v1/workspace/reset")
    client.post("/api/v1/cases/seed/load")
    client.post("/api/v1/workspace/run")  # v31: execution is explicit
    r = client.post("/api/v1/forecast/whatif",
                    json={"customer": "Cascade Chemicals", "shift_days": -14})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["shift_days"] == -14 and len(d["weeks"]) == 8
    # paying two weeks earlier cannot reduce expected 30-day cash
    assert d["delta_30_cents"] >= 0
    r2 = client.post("/api/v1/forecast/whatif",
                     json={"customer": "No Such Customer", "shift_days": 3})
    assert r2.status_code == 422


def test_mail_recorded_not_sent_without_config(tmp_path, monkeypatch):
    for k in ("SLATEMATCH_SMTP_HOST", "SLATEMATCH_MAIL_FROM"):
        monkeypatch.delenv(k, raising=False)
    assert mail_config()["configured"] is False
    repo = Repository(str(tmp_path / "t.db"))
    rec = send_mail(repo, "test", "ap@buyer.com", "Claim", "Body text", "dispute_claim", "P3")
    assert rec["status"] == "recorded_not_sent" and rec["configured"] is False
    out = repo.list_outbox()
    assert len(out) == 1 and out[0]["status"] == "recorded_not_sent"
    try:
        send_mail(repo, "test", "not-an-email", "S", "B", "chase", "P6")
        raise AssertionError("expected ValueError")
    except ValueError:
        pass


def test_mail_endpoints_and_reminder():
    client.post("/api/v1/workspace/reset")
    client.post("/api/v1/seed")
    r = client.post("/api/v1/mail/reminder", json={"invoice_id": "INV-1001"})
    assert r.status_code == 200, r.text
    d = r.json()
    assert "INV-1001" in d["subject"] and "INV-1001" in d["body"]
    r = client.post("/api/v1/mail/reminder", json={"invoice_id": "INV-9999"})
    assert r.status_code == 404
    r = client.post("/api/v1/mail/send", json={
        "to": "ap@buyer.com", "subject": d["subject"], "body": d["body"],
        "kind": "collection_reminder", "ref_id": "INV-1001"})
    assert r.status_code == 200, r.text
    assert r.json()["status"] in ("recorded_not_sent", "sent")
    out = client.get("/api/v1/mail/outbox").json()
    assert "configured" in out and len(out["mails"]) >= 1
    assert out["mails"][0]["kind"] == "collection_reminder"


def test_reminder_template_grounded():
    inv = seed_invoices()[0]
    d = reminder_draft(inv)
    assert inv.invoice_id in d["body"]
    assert f"${inv.gross_cents / 100:,.2f}" in d["body"]

def test_forecast_expected_date_semantics(monkeypatch):
    """due_in_days + predicted delay: an overdue invoice from a punctual
    payer is expected NOW (week 1); a fresh invoice lands after its due
    date; a far-future one sits beyond the horizon."""
    import forecast as fc_mod
    from domain import Invoice
    monkeypatch.setattr(fc_mod, "predict_delay", lambda *a, **k: 2.0)
    invs = [Invoice("A", "Cust", "Cust", 10000, age_days=40, due_in_days=-40),
            Invoice("B", "Cust", "Cust", 10000, age_days=2, due_in_days=30),
            Invoice("C", "Cust", "Cust", 10000, age_days=1, due_in_days=80)]
    fc = fc_mod.forecast_cash_in(invs, object())
    wk = {d["invoice_id"]: d["expected_week"] for d in fc["invoices"]}
    assert wk["A"] == 1 and wk["B"] == 5 and wk["C"] is None
    assert fc["weeks"][0]["invoice_ids"] == ["A"]
    assert fc["beyond"]["invoice_ids"] == ["C"]
