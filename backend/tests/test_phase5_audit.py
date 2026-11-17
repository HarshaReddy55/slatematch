"""Phase 5 (fourth external audit, verified items only): the
original billed amount is preserved while the open balance moves;
match ordering no longer depends on physical row position; EDI 820
joins the lockbox parser family; the runs list carries held counts
so the Health view stops fetching matches run by run.
"""
import base64
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
os.environ.setdefault("SLATEMATCH_DATA_DIR", os.path.join(os.path.dirname(__file__), "api_data"))
from fastapi.testclient import TestClient
import api as api_mod

client = TestClient(api_mod.app, raise_server_exceptions=False)
H = {"X-Workspace-Session": "phase5-1111-2222-3333-444455556666"}


def _reset():
    client.post("/api/v1/workspace/reset", headers=H)


def _import_invoices(csv_text):
    r = client.post("/api/v1/invoices/import", headers=H,
                    json={"csv_text": csv_text, "mode": "replace"})
    assert r.status_code == 200, r.text


def _batch(pid, cents, key, refs):
    body = {"idempotency_key": key,
            "payments": [{"payment_id": pid, "payer_raw": "Acme Widgets",
                          "amount_cents": cents, "references": list(refs)}]}
    r = client.post("/api/v1/batches", headers=H, json=body)
    assert r.status_code == 200, r.text
    return r.json()


INV = ("invoice_id,customer,amount,po_number,discount_rate,age_days,due_in_days\n"
       "INV-A1,Acme Widgets,1000.00,,0,10,30\n")


def test_original_gross_survives_partial_and_edit():
    _reset()
    _import_invoices(INV)
    _batch("W-990", 99000, "p5-orig-1", ("INV-A1",))
    approvals = client.get("/api/v1/approvals", headers=H).json()
    m = next(a for a in approvals if a["payment_id"] == "W-990")
    r = client.post(f"/api/v1/matches/{m['match_id']}/decision", headers=H,
                    json={"decision": "approve"})
    assert r.status_code == 200, r.text
    invs = client.get("/api/v1/invoices", headers=H).json()
    inv = next(i for i in invs if i["invoice_id"] == "INV-A1")
    # The $10 shortfall stays open as the working balance; the
    # billed record still says $1,000.
    assert inv["gross_cents"] == 1000, inv
    assert inv["original_gross_cents"] == 100000, inv
    # An inline correction moves the working balance only.
    r = client.patch("/api/v1/invoices/INV-A1", headers=H,
                     json={"gross_cents": 1200})
    assert r.status_code == 200, r.text
    inv = next(i for i in client.get("/api/v1/invoices", headers=H).json()
               if i["invoice_id"] == "INV-A1")
    assert inv["gross_cents"] == 1200, inv
    assert inv["original_gross_cents"] == 100000, inv


def test_latest_match_prefers_the_newer_run():
    from repository import Repository
    repo = Repository(os.path.join(tempfile.mkdtemp(), "t.db"))
    repo.create_run("run_old", "k1", "batch", "{}", "2026-01-01T00:00:00")
    repo.create_run("run_new", "k2", "batch", "{}", "2026-01-02T00:00:00")
    repo.add_match("m_old", "run_old", "P1", "PROPOSED", "milp", 0, 0.9, {})
    repo.add_match("m_new", "run_new", "P1", "PROPOSED", "milp", 0, 0.9, {})
    # Decide the OLD match (an in-place row update - the operation
    # that relocates the row physically on Postgres).
    assert repo.update_match_if_proposed("m_old", "APPROVED_POSTED", {}) == 1
    latest = repo.latest_match_for_payment("P1")
    assert latest["match_id"] == "m_new", latest


EDI_SAMPLE = (
    "ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       "
    "*260101*1200*U*00401*000000001*0*T*>~"
    "GS*RA*SENDER*RECEIVER*20260101*1200*1*X*004010~"
    "ST*820*0001~"
    "BPR*I*52000.00*C*ACH*CTX*01*021000089*DA*987654321*123456789*01*021000089*DA*111222333*20260102~"
    "TRN*1*TRACE99001~"
    "N1*PR*APEX MANUFACTURING~"
    "N1*PE*SLATEMATCH SUPPLIER~"
    "ENT*1~"
    "RMR*IV*INV-1001**30000.00*30000.00~"
    "RMR*IV*INV-1002**22000.00*22000.00~"
    "SE*9*0001~"
    "GE*1*1~"
    "IEA*1*000000001~"
)

EDI_SHORT = (
    "ST*820*0002~"
    "BPR*I*9700.00*C*ACH~"
    "TRN*1*TRACE99002~"
    "N1*PR*ACME WIDGETS~"
    "ENT*1~"
    "RMR*IV*INV-2001**9700.00*10000.00~"
    "ADX*-300.00*52~"
    "SE*8*0002~"
)


def test_edi820_parser_fields():
    from lockbox import parse_edi820, sniff_lockbox_format
    pays = parse_edi820(EDI_SAMPLE)
    assert len(pays) == 1
    p = pays[0]
    assert p.payment_id == "EDI820-TRACE99001"
    assert p.payer_raw == "APEX MANUFACTURING"
    assert p.amount_cents == 5200000
    assert p.references == ["INV-1001", "INV-1002"]
    assert p.claimed_deduction_cents == 0
    short = parse_edi820(EDI_SHORT)
    assert len(short) == 1
    assert short[0].amount_cents == 970000
    assert short[0].claimed_deduction_cents == 30000
    assert "52" in short[0].deduction_reason_raw
    assert sniff_lockbox_format(EDI_SAMPLE, "advice.txt") == "edi820"
    assert sniff_lockbox_format("", "payment.edi") == "edi820"


def test_edi820_import_reconciles():
    _reset()
    _import_invoices(
        "invoice_id,customer,amount,po_number,discount_rate,age_days,due_in_days\n"
        "INV-1001,Apex Manufacturing,30000.00,,0,10,30\n"
        "INV-1002,Apex Manufacturing,22000.00,,0,10,30\n")
    body = {"filename": "advice.edi", "kind": "payments",
            "content_b64": base64.b64encode(EDI_SAMPLE.encode()).decode()}
    r = client.post("/api/v1/import/file", headers=H, json=body)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["route"] == "lockbox" and d["format"] == "edi820", d
    assert d["imported"] == 1, d
    assert d["run"]["auto_posted"] == 1, d["run"]


def test_runs_list_carries_held_counts():
    _reset()
    client.post("/api/v1/cases/seed/load", headers=H)
    r = client.post("/api/v1/workspace/run", headers=H)
    assert r.status_code == 200, r.text
    runs = client.get("/api/v1/runs", headers=H).json()
    latest = runs[0]
    assert latest["auto_posted"] == 10, latest
    assert latest["held"] == 5, latest
    assert latest["payments"] == 16, latest
