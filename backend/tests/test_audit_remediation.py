"""Regression tests for the Nov 2026 code-audit remediation round.

Each test names the defect it locks against: double-posting on re-runs,
cross-customer and ambiguous auto-posts, the currency boundary, the
discount-percent parsing bug, unmapped POD columns, the diagnostics
password leak, unvalidated policy writes, inline policy overrides, and
null SAP customer/document fields."""
import os, sys, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
os.environ.setdefault("SLATEMATCH_DATA_DIR", os.path.join(os.path.dirname(__file__), "api_data"))
from fastapi.testclient import TestClient
import api as api_mod
from repository import Repository
from domain import Invoice, Payment, Policy
from batch import run_batch
from ingestion import parse_invoices_csv, parse_payments_csv, extract_references

client = TestClient(api_mod.app)


def _repo():
    return Repository(os.path.join(tempfile.mkdtemp(), "c.db"))


def test_rerun_never_double_posts():
    repo = _repo()
    repo.add_invoice(Invoice("INV-1", "Apex", "Apex", 12000))
    repo.add_invoice(Invoice("INV-2", "Apex", "Apex", 8000))
    out = run_batch(repo, [Payment("P1", "Apex", 20000)], Policy(), "k1")
    assert out["auto_posted"] == 1
    again = run_batch(repo, [Payment("P1", "Apex", 20000)], Policy(), "k2")
    assert again["results"] == [] and again["skipped_existing"] == 1
    assert len(repo.list_runs(10)) == 2  # both attempts recorded, one set of matches
    total_matches = sum(len(repo.matches_for_run(r["run_id"])) for r in repo.list_runs(10))
    assert total_matches == 1
    # the auto-post settled its invoices: the open pool is empty
    assert repo.open_invoices() == []


def test_cross_customer_set_never_autoposts():
    repo = _repo()
    repo.add_invoice(Invoice("INV-A", "Cust One", "Cust One", 4000000))
    repo.add_invoice(Invoice("INV-B", "Cust Two", "Cust Two", 2850000))
    out = run_batch(repo, [Payment("PX", "Unknown Payer LLP", 6850000)], Policy(), "k1")
    r = out["results"][0]
    # $68,500 is exactly INV-A + INV-B across two customers: coincidence,
    # not a match. Per-customer solving can only propose partials.
    assert r["status"] != "OPTIMAL_EXACT_MATCH" or not r["auto_posted"]
    assert not r["auto_posted"]


def test_ambiguous_tie_is_proposed_not_posted():
    repo = _repo()
    for iid, amt in (("INV-1", 10000), ("INV-2", 20000), ("INV-3", 30000)):
        repo.add_invoice(Invoice(iid, "Apex", "Apex", amt))
    out = run_batch(repo, [Payment("P1", "Apex", 30000)], Policy(), "k1")
    r = out["results"][0]
    assert r["status"] == "OPTIMAL_EXACT_MATCH" and r["auto_posted"] is False
    assert "Ambiguous" in (r["decision_reason"] or "")
    assert r["derivation"]["ambiguous_tie"] is True


def test_named_tie_still_autoposts():
    repo = _repo()
    for iid, amt in (("INV-1", 10000), ("INV-2", 20000), ("INV-3", 30000)):
        repo.add_invoice(Invoice(iid, "Apex", "Apex", amt))
    out = run_batch(repo, [Payment("P1", "Apex", 30000, references=["INV-1", "INV-2"])], Policy(), "k1")
    r = out["results"][0]
    assert r["auto_posted"] is True
    assert {l["invoice_id"] for l in r["lines"]} == {"INV-1", "INV-2"}


def test_currency_is_a_hard_boundary():
    repo = _repo()
    repo.add_invoice(Invoice("INV-1", "Apex", "Apex", 10000, currency="USD"))
    out = run_batch(repo, [Payment("P1", "Apex", 10000, currency="EUR")], Policy(), "k1")
    assert out["results"][0]["status"] == "NO_MATCH"


def test_fuzzy_payer_confidence_is_capped():
    repo = _repo()
    repo.add_invoice(Invoice("INV-1", "Apex Manufacturing", "Apex Manufacturing", 50000))
    out = run_batch(repo, [Payment("P1", "Apex Manufacturng", 50000)], Policy(), "k1")
    r = out["results"][0]
    assert r["status"] == "OPTIMAL_EXACT_MATCH"
    assert r["confidence"] <= 0.78 and r["auto_posted"] is False


def test_discount_percent_convention():
    csv = ("invoice_id,customer,amount,discount_rate\n"
           "A-1,Apex,100.00,1\nA-2,Apex,100.00,0.5\nA-3,Apex,100.00,2\nA-4,Apex,100.00,60\n")
    out = parse_invoices_csv(csv)
    rates = {i.invoice_id: i.discount_rate for i in out["invoices"]}
    assert rates == {"A-1": 0.01, "A-2": 0.005, "A-3": 0.02}
    assert any("discount" in e["error"] for e in out["errors"])  # 60% rejected, not reinterpreted


def test_nonpositive_amounts_are_quarantined():
    out = parse_invoices_csv("invoice_id,customer,amount\nA-1,Apex,-50.00\n")
    assert out["invoices"] == [] and out["errors"]
    out2 = parse_payments_csv("payment_id,payer,amount\nX1,Apex,0\n")
    assert out2["payments"] == [] and out2["errors"]


def test_pod_column_and_reference_prefixes():
    out = parse_payments_csv(
        "payment_id,payer,amount,pod_verified_clean,remittance\n"
        "X1,Apex,10.00,true,Paid SI-1042 and BILL-77 in full\n")
    assert out["payments"][0].pod_verified_clean is True
    assert {"SI-1042", "BILL-77"} <= set(out["payments"][0].references)
    assert extract_references("see DOC-9") == ["DOC-9"]


def test_diagnostics_never_leaks_smtp_password():
    os.environ["SLATEMATCH_SMTP_PASSWORD"] = "s3cret-value"
    try:
        d = client.get("/api/v1/diagnostics").json()
    finally:
        del os.environ["SLATEMATCH_SMTP_PASSWORD"]
    assert d["mail"]["password"] is None
    assert d["mail"]["password_configured"] is True
    assert "s3cret-value" not in str(d)


def test_policy_write_validates_ranges():
    r = client.put("/api/v1/policy", json={"policy": {"maker_checker_threshold_cents": -5}})
    assert r.status_code == 422
    r = client.put("/api/v1/policy", json={"policy": {"automation_threshold": 1.5}})
    assert r.status_code == 422


def _seed_and_run():
    client.post("/api/v1/workspace/reset")
    client.post("/api/v1/cases/seed/load")
    return client.post("/api/v1/workspace/run").json()["run"]


def test_batches_ignores_inline_policy():
    client.post("/api/v1/workspace/reset")
    s = client.post("/api/v1/seed").json()
    b = client.post("/api/v1/batches", json={
        "idempotency_key": "audit-inline-1", "payments": s["payments"],
        "policy": {"maker_checker_threshold_cents": 100}}).json()
    p7 = next(r for r in b["results"] if r["payment_id"] == "P7")
    # Under the stored (default $100k) policy P7 ($96,400) is not
    # maker-checker held, whatever the request body claimed.
    assert "Maker-checker" not in (p7["decision_reason"] or "")


def test_sap_documents_have_customer_and_numbers():
    _seed_and_run()
    d = client.get("/api/v1/erp/run-documents").json()
    assert d["documents"], "expected cleared documents"
    for doc in d["documents"]:
        payload = doc["document"]["bapi_payload"]
        assert doc["document"]["document_number"]
        assert doc["document"]["status"] == "STAGED_FOR_SAP_POSTING"
        for line in payload["ACCOUNTRECEIVABLE"]:
            assert line["CUSTOMER"] not in (None, "", "UNKNOWN")
    # the same match shows the same number on the per-payment endpoint
    one = client.get("/api/v1/payments/P1/erp-document").json()["document"]
    p1doc = next(x["document"] for x in d["documents"] if x["payment_id"] == "P1")
    assert one["document_number"] == p1doc["document_number"]


def test_approval_learns_payer_alias():
    client.post("/api/v1/workspace/reset")
    client.post("/api/v1/workspace/load-custom", json={
        "invoices": [{"invoice_id": "C-1", "customer": "Apex Manufacturing", "gross_cents": 12000000, "age_days": 10}],
        "payments": [{"payment_id": "C-P1", "payer_raw": "Apex Manufacturng Ltd", "amount_cents": 12000000}]})
    appr = client.get("/api/v1/approvals").json()
    mine = next(a for a in appr if a["payment_id"] == "C-P1")
    r = client.post(f"/api/v1/matches/{mine['match_id']}/decision", json={"decision": "approve"})
    assert r.status_code == 200, r.text
    repo = api_mod.repo_for("demo")
    rows = repo.conn.execute("SELECT customer FROM aliases WHERE raw_name='apex manufacturng ltd'").fetchall()
    assert rows and rows[0][0] == "Apex Manufacturing"


# ---------------------------------------------------------------------------
# Round 2 (same audit, second report): batch ordering, partial settlement,
# unearned discounts, SAP residual lines, dependency pinning.
# ---------------------------------------------------------------------------

def test_evidence_order_protects_referenced_wire():
    """An unreferenced wire staged FIRST must not consume the invoice a
    referenced wire in the same batch was sent to pay."""
    repo = _repo()
    repo.add_invoice(Invoice("INV-A", "Acme Corp", "Acme Corp", 50000, age_days=30))
    repo.add_invoice(Invoice("INV-B", "Acme Corp", "Acme Corp", 50000, age_days=5))
    u = Payment("PU", "Acme Corporation", 50000)                           # no reference (fuzzy payer only; a distinct wire, not a duplicate fingerprint)
    r = Payment("PR", "Acme Corp", 50000, references=["INV-A"])            # names INV-A
    out = run_batch(repo, [u, r], Policy(), "ord1")                        # U staged first
    by_id = {x["payment_id"]: x for x in out["results"]}
    assert [l["invoice_id"] for l in by_id["PR"]["lines"]] == ["INV-A"]
    assert [l["invoice_id"] for l in by_id["PU"]["lines"]] == ["INV-B"]
    steps = {s["agent"]: s for s in repo.steps_for_run(out["run_id"])}
    order = steps["Matching Agent"]["evidence"]["processing_order"]
    assert order.index("PR") < order.index("PU")


def test_partial_approval_keeps_the_residual_receivable():
    """Approving P4 ($20,000 toward a $36,750 invoice) must leave INV-1005
    OPEN at $16,750 - in the ledger and the forecast - not settle it."""
    h = {"X-Tenant-Id": "test-partial-r2"}
    client.post("/api/v1/cases/seed/load", headers=h)
    client.post("/api/v1/workspace/run", headers=h)
    appr = client.get("/api/v1/approvals", headers=h).json()
    p4 = next(a for a in appr if a["payment_id"] == "P4")
    r = client.post(f"/api/v1/matches/{p4['match_id']}/decision",
                    json={"decision": "approve"}, headers=h)
    assert r.status_code == 200
    invs = client.get("/api/v1/invoices", headers=h).json()
    # /invoices lists the OPEN book only: presence here at the reduced
    # balance is exactly "still a live receivable".
    inv = next(i for i in invs if i["invoice_id"] == "INV-1005")
    assert inv["gross_cents"] == 1675000
    fc = client.get("/api/v1/forecast", headers=h).json()
    assert fc["state"] == "ready"
    # the overpayment approval still settles its invoice in full
    p14 = next(a for a in appr if a["payment_id"] == "P14")
    client.post(f"/api/v1/matches/{p14['match_id']}/decision",
                json={"decision": "approve"}, headers=h)
    invs = client.get("/api/v1/invoices", headers=h).json()
    assert all(i["invoice_id"] != "INV-1016" for i in invs)  # settled: off the open book


def test_unearned_discount_becomes_a_claim():
    """A discount taken after its window closed is claimed back (RC-12),
    surfaced in the match's deduction record and the agent evidence."""
    repo = _repo()
    repo.add_invoice(Invoice("INV-U", "Late Payer Co", "Late Payer Co", 1000000,
                             discount_rate=0.02, age_days=20, due_in_days=-3))
    out = run_batch(repo, [Payment("PU", "Late Payer Co", 980000,
                                   references=["INV-U"])], Policy(), "un1")
    r = out["results"][0]
    assert r["lines"][0]["discount_taken"]
    ded = r["deduction"]
    assert ded is not None and ded["unearned_discount"]["total_cents"] == 20000
    assert ded["classification"]["code"] == "RC-12"
    steps = {s["agent"]: s for s in repo.steps_for_run(out["run_id"])}
    assert steps["Deduction Agent"]["evidence"]["unearned_discounts_flagged"] == 1


def test_sap_residual_and_on_account_lines():
    """Underpayments post a residual receivable (GL 121600); overpayments
    post the excess as a customer on-account credit (GL 121900). Both
    documents balance to the cent."""
    from erp_sap import build_posting_document
    under = build_posting_document(
        {"lines": [{"invoice_id": "INV-1", "gross_cents": 2000000, "discount_cents": 0,
                    "net_cents": 2000000}],
         "residual_cents": -52000,
         "derivation": {"equation": {"payment_cents": 1948000, "deduction_applied_cents": 0}}},
        {"payment_id": "PX", "payer_raw": "Cust", "currency": "USD"}, document_number="DZ-1")
    gls = {l["gl_account"]: l for l in under["journal"]}
    assert gls["121600"]["debit_cents"] == 52000 and under["balanced"]
    over = build_posting_document(
        {"lines": [{"invoice_id": "INV-2", "gross_cents": 1248000, "discount_cents": 0,
                    "net_cents": 1248000}],
         "residual_cents": 52000,
         "derivation": {"equation": {"payment_cents": 1300000, "deduction_applied_cents": 0}}},
        {"payment_id": "PY", "payer_raw": "Cust", "currency": "USD"}, document_number="DZ-2")
    gls = {l["gl_account"]: l for l in over["journal"]}
    assert gls["121900"]["credit_cents"] == 52000 and over["balanced"]


def test_requirements_are_pinned():
    req = os.path.join(os.path.dirname(__file__), "..", "requirements.txt")
    lines = [l.strip() for l in open(req) if l.strip() and not l.startswith("#")]
    assert lines and all("==" in l for l in lines)


# ---------------------------------------------------------------------------
# Round 3: evaluations integrity, forecast features, partial visibility,
# inline-handler injection pattern.
# ---------------------------------------------------------------------------

def test_evaluations_endpoint_reports_perfect_milp():
    """The Evaluations page grades the solver against labelled ground
    truth on every call - it must report a perfect MILP score."""
    ev = client.get("/api/v1/evaluations").json()
    assert ev["milp_accuracy"] == 1.0
    assert all(r["milp_correct"] for r in ev["cases"])


def test_forecast_delay_uses_the_invoices_own_terms():
    """Predicted delay must be computed from each invoice's own terms
    (age + due window, clamped to the model's validated range) and the
    month it is asked about - never a constant 30 days."""
    import forecast as fc
    import api as _api
    seen = {}
    orig = fc.predict_delay
    def spy(model, customer, terms, amount, month):
        seen.update(terms=terms, month=month)
        return orig(model, customer, terms, amount, month)
    fc.predict_delay = spy
    try:
        model = _api.models()["delay_model"]
        fc._delay(model, Invoice("T-1", "Apex Manufacturing", "Apex Manufacturing",
                                 5000000, age_days=10, due_in_days=20), 11)
        assert seen == {"terms": 30, "month": 11}
        fc._delay(model, Invoice("T-2", "Apex Manufacturing", "Apex Manufacturing",
                                 5000000, age_days=90, due_in_days=-30), 3)
        assert seen["terms"] == 60 and seen["month"] == 3   # clamped to range
        fc._delay(model, Invoice("T-3", "Apex Manufacturing", "Apex Manufacturing",
                                 5000000, age_days=5, due_in_days=2), 3)
        assert seen["terms"] == 15                          # clamped at floor
    finally:
        fc.predict_delay = orig


def test_partial_payment_shows_on_invoice_and_forecast():
    """After a partial approval, the invoice payload carries the partial
    record (applied vs original), and the forecast carries the invoice
    at its remaining balance - while a fully approved invoice leaves
    the forecast entirely."""
    h = {"X-Tenant-Id": "test-partial-r3"}
    client.post("/api/v1/cases/seed/load", headers=h)
    client.post("/api/v1/workspace/run", headers=h)
    appr = client.get("/api/v1/approvals", headers=h).json()
    p4 = next(a for a in appr if a["payment_id"] == "P4")
    client.post(f"/api/v1/matches/{p4['match_id']}/decision",
                json={"decision": "approve"}, headers=h)
    invs = client.get("/api/v1/invoices", headers=h).json()
    inv = next(i for i in invs if i["invoice_id"] == "INV-1005")
    assert inv["gross_cents"] == 1675000
    assert inv["partial"] == {"applied_cents": 2000000, "original_cents": 3675000}
    fc = client.get("/api/v1/forecast", headers=h).json()
    row = next(r for r in fc["invoices"] if r["invoice_id"] == "INV-1005")
    assert row["gross_cents"] == 1675000
    p7 = next(a for a in appr if a["payment_id"] == "P7")
    assert p7["invoices"] == ["INV-1006"]
    assert any(r["invoice_id"] == "INV-1006" for r in fc["invoices"])
    client.post(f"/api/v1/matches/{p7['match_id']}/decision",
                json={"decision": "approve"}, headers=h)
    fc = client.get("/api/v1/forecast", headers=h).json()
    assert all(r["invoice_id"] != "INV-1006" for r in fc["invoices"])


def test_no_string_interpolation_into_inline_handlers():
    """No inline event handler anywhere in the frontend may receive a
    string built by interpolation: values reach handlers through
    data-* attributes and dataset reads, so a quote in a customer name
    or id can neither break the handler nor escape its string."""
    from pathlib import Path
    js_dir = Path(__file__).resolve().parents[2] / "frontend" / "js"
    bad = []
    for f in sorted(js_dir.glob("*.js")):
        for n, line in enumerate(f.read_text().splitlines(), 1):
            if "onclick=" in line and "'${" in line:
                bad.append(f"{f.name}:{n}")
    assert not bad, bad


# -- Round 4 (found by the v40 LIVE audit, not the report): the SAP
# document builder read the residual from a top-level field the stored
# match record does not carry, so a partial payment's clearing document
# came out unbalanced (Dr cash $20,000 against Cr AR $36,750, no
# residual line), and an overpayment's document missed its on-account
# credit. Exact matches hid it completely: their residual is genuinely
# zero either way, which is why 10 of 11 documents balanced.

def test_posting_documents_balance_for_partial_and_overpayment():
    _seed_and_run()
    appr = client.get("/api/v1/approvals").json()
    for pid in ("P4", "P14"):
        mid = next(a["match_id"] for a in appr if a["payment_id"] == pid)
        assert client.post(f"/api/v1/matches/{mid}/decision",
                           json={"decision": "approve"}).status_code == 200
    erp = client.get("/api/v1/erp/run-documents").json()
    assert erp["totals"]["balanced"] is True
    docs = {d["payment_id"]: d["document"] for d in erp["documents"]}
    p4 = docs["P4"]
    assert p4["balanced"] is True
    gl4 = {l["gl_account"]: l for l in p4["journal"]}
    assert gl4["121600"]["debit_cents"] == 1675000   # residual receivable
    p14 = docs["P14"]
    assert p14["balanced"] is True
    gl14 = {l["gl_account"]: l for l in p14["journal"]}
    assert gl14["121900"]["credit_cents"] == 52000   # on-account credit $520
