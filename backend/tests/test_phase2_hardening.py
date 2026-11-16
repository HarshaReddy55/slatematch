"""Phase 2 enterprise-hardening regressions (16 Nov 2026).

Each test locks one behaviour the hardening pass changed:
- repository unit of work: rollback discards, commit lands, the
  transaction() context manager rolls back on exceptions;
- the secondary indexes exist in a fresh schema;
- the tiered duplicate guard across runs: a reconciled wire re-sent
  under a new payment id is held; two wires that name different
  references never block each other;
- money parsing is Decimal-exact at the half-cent boundary;
- the ingestion currency column is mapped and validated;
- the kernel enumeration is bounded in the candidate count, not the
  amount (a max-gate target returns instantly, no per-cent states);
- the parse endpoint rejects unbounded text.
"""
import os, sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

from domain import Invoice, Payment, Policy
from repository import Repository


def _repo(tmp_path):
    return Repository(str(tmp_path / "ws.db"))


def test_transaction_rollback_discards_and_commit_lands(tmp_path):
    repo = _repo(tmp_path)
    repo.add_invoice(Invoice("INV-1", "Acme", "Acme", 10000))
    repo.begin()
    repo.add_invoice(Invoice("INV-2", "Acme", "Acme", 20000))
    repo.add_match("m1", "r1", "P1", "AUTO_POSTED", "milp", 0, 1.0, {})
    repo.rollback()
    assert [i.invoice_id for i in repo.all_invoices()] == ["INV-1"]
    assert repo.list_runs(10) == [] or repo.get_match("m1") is None
    repo.begin()
    repo.add_invoice(Invoice("INV-2", "Acme", "Acme", 20000))
    repo.commit()
    assert {i.invoice_id for i in repo.all_invoices()} == {"INV-1", "INV-2"}


def test_transaction_context_manager_rolls_back_on_error(tmp_path):
    repo = _repo(tmp_path)
    try:
        with repo.transaction():
            repo.add_invoice(Invoice("INV-9", "Acme", "Acme", 5000))
            raise RuntimeError("boom")
    except RuntimeError:
        pass
    assert repo.all_invoices() == []
    with repo.transaction():
        repo.add_invoice(Invoice("INV-9", "Acme", "Acme", 5000))
    assert len(repo.all_invoices()) == 1


def test_secondary_indexes_exist(tmp_path):
    repo = _repo(tmp_path)
    names = {r[1] for r in repo.conn.execute(
        "SELECT type, name FROM sqlite_master WHERE type='index'").fetchall()}
    for idx in ("idx_matches_run", "idx_matches_payment", "idx_matches_status",
                "idx_exceptions_run", "idx_exceptions_payment", "idx_steps_run",
                "idx_audit_entity", "idx_payments_fingerprint",
                "idx_invoices_status", "idx_outbox_status"):
        assert idx in names, idx


def test_cross_run_duplicate_held_under_new_payment_id(tmp_path):
    from batch import run_batch
    from anomaly import payment_fingerprint
    repo = _repo(tmp_path)
    repo.add_invoice(Invoice("INV-1", "Acme", "Acme", 10000))
    p1 = Payment("P1", "Acme", 10000)
    repo.add_payment(p1, payment_fingerprint(p1))
    out1 = run_batch(repo, [p1], Policy(), "k1")
    assert out1["status"] == "COMPLETED" and out1["auto_posted"] == 1
    # The same wire re-imported under a fresh id must not solve again.
    p2 = Payment("P2", "Acme", 10000)
    repo.add_payment(p2, payment_fingerprint(p2))
    out2 = run_batch(repo, [p2], Policy(), "k2")
    dups = [e for e in out2["exceptions"] if e["kind"] == "DUPLICATE_PAYMENT"]
    assert len(dups) == 1 and dups[0]["detail"]["duplicate_of"] == "P1"
    assert out2["auto_posted"] == 0


def test_distinct_wires_with_different_references_do_not_block(tmp_path):
    from batch import run_batch
    from anomaly import payment_fingerprint
    repo = _repo(tmp_path)
    repo.add_invoice(Invoice("INV-1", "Acme", "Acme", 10000))
    repo.add_invoice(Invoice("INV-2", "Acme", "Acme", 10000))
    q1 = Payment("Q1", "Acme", 10000, references=["INV-1"])
    q2 = Payment("Q2", "Acme", 10000, references=["INV-2"])
    for q in (q1, q2):
        repo.add_payment(q, payment_fingerprint(q))
    out = run_batch(repo, [q1, q2], Policy(), "k3")
    assert not [e for e in out["exceptions"] if e["kind"] == "DUPLICATE_PAYMENT"]
    assert out["auto_posted"] == 2


def test_resend_without_references_still_held(tmp_path):
    from batch import run_batch
    from anomaly import payment_fingerprint
    repo = _repo(tmp_path)
    repo.add_invoice(Invoice("INV-1", "Acme", "Acme", 10000))
    p1 = Payment("P1", "Acme", 10000, references=["INV-1"])
    repo.add_payment(p1, payment_fingerprint(p1))
    run_batch(repo, [p1], Policy(), "k4")
    p2 = Payment("P2", "Acme", 10000)  # resend that lost its remittance
    repo.add_payment(p2, payment_fingerprint(p2))
    out = run_batch(repo, [p2], Policy(), "k5")
    assert any(e["kind"] == "DUPLICATE_PAYMENT" for e in out["exceptions"])


def test_money_decimal_half_cent_boundary():
    from ingestion import _money_to_cents
    assert _money_to_cents("2.675") == 268   # float path gave 267
    assert _money_to_cents("0.125") == 13    # float round() gave 12
    assert _money_to_cents("1.234,56") == 123456
    assert _money_to_cents("99999999.99") == 9999999999


def test_ingestion_currency_column_mapped_and_validated():
    from ingestion import parse_payments_csv, parse_invoices_csv
    r = parse_payments_csv("payment_id,payer,amount,currency\nX1,Acme,10.00,EUR\n")
    assert r["payments"][0].currency == "EUR" and not r["errors"]
    r2 = parse_payments_csv("payment_id,payer,amount,currency\nX1,Acme,10.00,XX\n")
    assert not r2["payments"] and len(r2["errors"]) == 1
    r3 = parse_invoices_csv("invoice,customer,amount,currency\nI1,Acme,10.00,gbp\n")
    assert r3["invoices"][0].currency == "GBP" and not r3["errors"]
    r4 = parse_payments_csv("payment_id,payer,amount\nX1,Acme,10.00\n")
    assert r4["payments"][0].currency == "USD"  # blank column = default


def test_kernel_enumeration_bounded_by_candidates_not_amount():
    from rust_bridge import best_subset_py
    invs = [{"invoice_id": f"I{k}", "gross_cents": 1_000_000 + k * 137_000,
             "age_days": k * 3} for k in range(18)]
    r = best_subset_py(25_000_000, invs)  # the engine's max amount gate
    assert r["selected_sum_cents"] <= 25_000_000
    assert r["residual_cents"] == 25_000_000 - r["selected_sum_cents"]
    try:
        best_subset_py(1000, [{"invoice_id": f"J{k}", "gross_cents": 10,
                               "age_days": 1} for k in range(21)])
        raise AssertionError("21 candidates must be refused")
    except ValueError:
        pass


def test_parse_text_capped():
    from fastapi.testclient import TestClient
    from api import app
    c = TestClient(app)
    r = c.post("/api/v1/parse", json={"text": "x" * 20_001})
    assert r.status_code == 422
    r2 = c.post("/api/v1/parse", json={"text": "Remittance for INV-1001, amount 100.00"})
    assert r2.status_code == 200
