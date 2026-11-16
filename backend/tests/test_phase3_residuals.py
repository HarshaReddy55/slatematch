"""Phase 3 residuals (16 Nov 2026, second external review): the five
genuinely new findings - kernel CLI panics, spoofable client-IP
keying and unbounded rate-limit maps, unbounded session/snapshot
disk growth, Latin-1 mangling in the PDF export, and ML training
inside the first health probe."""
import json
import os
import subprocess
import sys
import time
import types

HERE = os.path.dirname(__file__)
APP = os.path.join(HERE, "..", "app")
sys.path.insert(0, APP)

import pytest

BIN = os.path.join(HERE, "..", "..", "rust-kernel", "target", "release",
                   "slatematch-kernel")


@pytest.mark.skipif(not os.path.exists(BIN), reason="rust kernel binary not built")
def test_kernel_cli_rejects_garbage_without_panicking():
    out = subprocess.run([BIN], input="this is not json", capture_output=True,
                         text=True, timeout=10)
    assert out.returncode == 2
    assert "error" in json.loads(out.stdout)
    assert "panicked" not in (out.stderr or "")


@pytest.mark.skipif(not os.path.exists(BIN), reason="rust kernel binary not built")
def test_kernel_cli_still_solves_valid_requests():
    payload = json.dumps({"target_cents": 52000, "age_weight_milli": 50,
                          "invoices": [{"invoice_id": "A", "gross_cents": 30000, "age_days": 5},
                                       {"invoice_id": "B", "gross_cents": 22000, "age_days": 9}]})
    out = subprocess.run([BIN], input=payload, capture_output=True, text=True, timeout=10)
    assert out.returncode == 0
    r = json.loads(out.stdout)
    assert r["selected_ids"] == ["A", "B"] and r["residual_cents"] == 0


def test_client_ip_trusts_last_forwarded_hop():
    import api
    req = types.SimpleNamespace(
        headers={"x-forwarded-for": "1.2.3.4, 5.6.7.8, 9.9.9.9"},
        client=types.SimpleNamespace(host="10.0.0.1"))
    # the first hop is client-claimed and spoofable; the ALB appends
    # the real client IP last
    assert api._client_ip(req) == "9.9.9.9"
    req2 = types.SimpleNamespace(headers={}, client=types.SimpleNamespace(host="10.0.0.1"))
    assert api._client_ip(req2) == "10.0.0.1"


def test_ai_budget_prunes_expired_ips():
    import ai as aimod
    b = aimod.AiBudget(limit_per_min=100000)
    old = time.time() - 3600
    for i in range(600):
        b._hits[f"198.51.100.{i}"] = [old]
    assert b.allow("203.0.113.7") is True
    assert len(b._hits) <= 2  # the 600 expired entries were swept


def test_prune_saves_keeps_newest_per_tenant():
    import api
    tenant = "phase3-prune-test"
    keys = []
    try:
        for i in range(api._SAVE_CAP_PER_TENANT + 3):
            key = f"P3T{i:07d}X"[:10].ljust(10, "0")
            keys.append(key)
            path = os.path.join(api._saved_dir(), key + ".db")
            with open(path, "wb") as f:
                f.write(b"sqlite")
            api._manifest_put(key, {"save_id": f"SM-{key[:5]}-{key[5:]}",
                                    "saved_at": f"2026-11-16T00:{i:02d}:00",
                                    "tenant": tenant, "label": "", "counts": {}})
        api._prune_saves(tenant)
        mine = [k for k, m in api._manifest().items() if m.get("tenant") == tenant]
        assert len(mine) == api._SAVE_CAP_PER_TENANT
        # the three oldest are gone, file and manifest entry alike
        for k in keys[:3]:
            assert k not in api._manifest()
            assert not os.path.exists(os.path.join(api._saved_dir(), k + ".db"))
        assert keys[-1] in api._manifest()
    finally:
        api._manifest_drop([k for k, m in api._manifest().items()
                            if m.get("tenant") == tenant])
        for k in keys:
            try: os.remove(os.path.join(api._saved_dir(), k + ".db"))
            except OSError: pass


def test_reaper_deletes_only_stale_session_dbs():
    import api
    base = api.store.base_dir
    stale = "demo--123e4567-e89b-42d3-a456-426614174000.db"
    fresh = "demo--123e4567-e89b-42d3-a456-426614174001.db"
    keep = "phase3-base-tenant.db"
    old = time.time() - 30 * 86400
    for name, when in ((stale, old), (fresh, time.time()), (keep, old)):
        p = os.path.join(base, name)
        with open(p, "wb") as f:
            f.write(b"x")
        os.utime(p, (when, when))
    try:
        api._reap_session_dbs()
        assert not os.path.exists(os.path.join(base, stale))
        assert os.path.exists(os.path.join(base, fresh))
        assert os.path.exists(os.path.join(base, keep))  # not a session file
    finally:
        for name in (stale, fresh, keep):
            try: os.remove(os.path.join(base, name))
            except OSError: pass


def test_pdf_text_unicode_when_font_available():
    import bundle_pdf
    sample = "Café €1,234 ₹5,678 — naïve"
    if bundle_pdf._UNICODE:
        assert bundle_pdf._s(sample) == sample
        # and the glyphs actually survive rendering + text extraction
        from fpdf import FPDF
        pdf = FPDF()
        bundle_pdf._register_fonts(pdf)
        pdf.add_page()
        pdf.set_font(bundle_pdf._FAM, "", 12)
        pdf.cell(0, 10, bundle_pdf._s(sample))
        from pypdf import PdfReader
        import io
        text = PdfReader(io.BytesIO(pdf.output())).pages[0].extract_text()
        assert "€" in text and "₹" in text
    else:
        assert "?" in bundle_pdf._s(sample)  # documented fallback


def test_models_are_trained_once_and_cached():
    import api
    assert api.models() is api.models()


# ---- Pack v2 additions: guardrail refinements + Section E ----

def _inv(iid, subsidiary, cents=10000):
    from domain import Invoice
    return Invoice(invoice_id=iid, customer="Acme Corp", subsidiary=subsidiary,
                   gross_cents=cents, currency="USD", age_days=10)


def test_subsidiary_filter_blocks_cross_entity_candidates():
    from batch import resolve_candidates
    from domain import Payment
    ledger = [_inv("INV-A", "IN01"), _inv("INV-B", "DE01")]
    pay = Payment(payment_id="P1", payer_raw="Acme Corp", amount_cents=10000,
                  subsidiary="IN01")
    cands, _rung = resolve_candidates(pay, ledger, {})
    assert [i.invoice_id for i in cands] == ["INV-A"]
    # the boundary is hard: even an explicit reference to the other
    # entity's invoice cannot pull it into the candidate set
    pay2 = Payment(payment_id="P2", payer_raw="Acme Corp", amount_cents=10000,
                   references=["INV-B"], subsidiary="IN01")
    cands2, _ = resolve_candidates(pay2, ledger, {})
    assert all(i.subsidiary == "IN01" for i in cands2)


def test_subsidiary_absent_leaves_resolution_unchanged():
    from batch import resolve_candidates
    from domain import Payment
    ledger = [_inv("INV-A", "IN01"), _inv("INV-B", "DE01")]
    pay = Payment(payment_id="P3", payer_raw="Acme Corp", amount_cents=10000)
    assert pay.subsidiary is None
    cands, _rung = resolve_candidates(pay, ledger, {})
    assert {i.invoice_id for i in cands} == {"INV-A", "INV-B"}


def test_anonymous_rate_limit_bucket_is_per_ip(monkeypatch):
    os.environ.setdefault("SLATEMATCH_DATA_DIR",
                          os.path.join(HERE, "phase3_data"))
    from fastapi.testclient import TestClient
    import api
    monkeypatch.setenv("SLATEMATCH_RATE_LIMIT_PER_MIN", "3")
    client = TestClient(api.app, raise_server_exceptions=False)
    a = {"x-forwarded-for": "203.0.113.10"}
    b = {"x-forwarded-for": "203.0.113.11"}
    codes_a = [client.get("/api/v1/invoices", headers=a).status_code for _ in range(5)]
    assert 429 in codes_a, codes_a
    # a different visitor is not limited by the first visitor's burst
    assert client.get("/api/v1/invoices", headers=b).status_code != 429


def test_reaper_enforces_session_file_cap(monkeypatch):
    import api
    monkeypatch.setattr(api, "_SESSION_FILE_CAP", 5)
    base = api.store.base_dir
    names = [f"demo--123e4567-e89b-42d3-a456-4266141741{i:02d}.db" for i in range(8)]
    try:
        for j, name in enumerate(names):
            p = os.path.join(base, name)
            with open(p, "wb") as f:
                f.write(b"x")
            t = time.time() - (100 - j) * 60  # staggered, all fresh (inside TTL)
            os.utime(p, (t, t))
        api._reap_session_dbs()
        left = [n for n in names if os.path.exists(os.path.join(base, n))]
        assert left == names[3:]  # oldest three evicted, newest five kept
    finally:
        for name in names:
            try: os.remove(os.path.join(base, name))
            except OSError: pass
