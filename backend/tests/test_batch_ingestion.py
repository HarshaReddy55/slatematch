import sys, os, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'app'))
from domain import Invoice, Payment, Policy
from repository import Repository
from ingestion import parse_invoices_csv
from batch import run_batch

CSV = """Inv No,Client,Entity,Amount,PO No,Disc %,Age
INV-1,Apex Manufacturing,Apex Manufacturing,120.00,PO-1,0,40
INV-2,Apex Manufacturing,Apex Manufacturing,80.00,PO-2,0,5
INV-3,Apex Manufacturing,Apex Manufacturing,200.00,PO-3,0,30
INV-4,BluePeak Electronics,BluePeak Electronics,50.00,PO-4,0,2
"""

def test_ingestion_synonym_mapping():
    out = parse_invoices_csv(CSV)
    assert len(out["invoices"]) == 4 and not out["errors"]
    assert out["invoices"][0].gross_cents == 12000
    assert out["mapping"]["invoice_id"] == "Inv No"

def test_batch_consumes_invoices_and_flags_duplicate():
    repo = Repository(os.path.join(tempfile.mkdtemp(), "t.db"))
    for inv in parse_invoices_csv(CSV)["invoices"]:
        repo.add_invoice(inv)
    p1 = Payment(payment_id="P1", payer_raw="Apex Manufacturing", amount_cents=20000)
    p2 = Payment(payment_id="P2", payer_raw="Apex Manufacturing", amount_cents=20000)  # duplicate fingerprint of P1
    p3 = Payment(payment_id="P3", payer_raw="BluePeak Electronics", amount_cents=5000)
    r = run_batch(repo, [p1, p2, p3], Policy(), idempotency_key="k1")
    assert r["status"] == "COMPLETED"
    assert any(e["kind"] == "DUPLICATE_PAYMENT" for e in r["exceptions"])
    first = [x for x in r["results"] if x["payment_id"] == "P1"][0]
    assert first["status"] == "OPTIMAL_EXACT_MATCH" and first["residual_cents"] == 0
    # idempotent replay
    r2 = run_batch(repo, [p1], Policy(), idempotency_key="k1")
    assert r2.get("idempotent_replay") is True
