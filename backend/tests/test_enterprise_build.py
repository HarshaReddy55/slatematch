"""Enterprise build (one-go pack): full-shape SAP BAPI payloads,
bank lockbox parsers (BAI2 / MT940 / camt.054), and FX conversion
with realised gain/loss posting.

FX arithmetic used below, worked by hand: rate EUR = 1.087 USD.
A $1,000.00 USD invoice converts to round(100000 / 1.087) = 91996
EUR cents. For the end-to-end document, a $223.33 invoice converts
to round(22333 / 1.087) = 20546 EUR cents; a wire of exactly that
settles it, and the wire's book value is round(20546 x 1.087) =
22334 USD cents - a realised FX GAIN of 1 cent, credited to
GL 710100. The document balances: DR cash 22334 = CR AR 22333 +
CR FX gain 1.
"""
import base64
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
os.environ.setdefault("SLATEMATCH_DATA_DIR", os.path.join(os.path.dirname(__file__), "api_data"))
from fastapi.testclient import TestClient
import api as api_mod
from lockbox import parse_bai2, parse_camt054, parse_mt940, sniff_lockbox_format
from batch import resolve_candidates
from domain import Invoice, Payment, Policy

client = TestClient(api_mod.app, raise_server_exceptions=False)

BAI2 = """01,LOCKBOX,RECEIVER,260102,1200,1,,,2/
02,RECEIVER,ORIGINATOR,1,260102,1200,USD,,/
03,123456789,USD,010,500000,,,015,600000/
16,115,100000,S,CHK001,CUSTREF,/
88,Remittance for INV-2001 from Acme Widgets/
49,100000,1/
98,100000,1,3/
99,100000,1,5/
"""

MT940 = """:20:STARTUMS
:25:12345678
:28C:1/1
:60F:C260101USD5000,00
:61:2601020102C1000,00NTRF//BANKREF1
:86:Payment for INV-2001 from Acme Widgets
:61:2601020102D250,00NCHK//FEE
:86:Bank charges
:62F:C260102USD5750,00
"""

CAMT = """<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.054.001.02">
<BkToCstmrDbtCdtNtfctn><Ntfctn><Ntry>
<Amt Ccy="USD">1000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd>
<NtryRef>REF-9</NtryRef>
<RltdPties><Dbtr><Nm>Acme Widgets</Nm></Dbtr></RltdPties>
<RmtInf><Ustrd>Payment for INV-2001</Ustrd></RmtInf>
</Ntry><Ntry>
<Amt Ccy="USD">40.00</Amt><CdtDbtInd>DBIT</CdtDbtInd>
<RmtInf><Ustrd>Bank fee</Ustrd></RmtInf>
</Ntry></Ntfctn></BkToCstmrDbtCdtNtfctn></Document>
"""


# -------------------------------------------------------------------
# BAPI payload shape
# -------------------------------------------------------------------

def test_bapi_payload_full_shape():
    client.post("/api/v1/workspace/reset")
    client.post("/api/v1/cases/seed/load")
    client.post("/api/v1/workspace/run")
    d = client.get("/api/v1/payments/P1/erp-document").json()
    doc = d["document"]
    b = doc["bapi_payload"]
    h = b["DOCUMENTHEADER"]
    assert len(h["DOC_DATE"]) == 8 and h["PSTNG_DATE"] == h["DOC_DATE"]
    assert h["FISC_YEAR"] == h["DOC_DATE"][:4] and h["FIS_PERIOD"] == h["DOC_DATE"][4:6]
    # RW602: the AR reconciliation account never sits in ACCOUNTGL.
    assert all(l["GL_ACCOUNT"] != "121000" for l in b["ACCOUNTGL"])
    assert any(l["GL_ACCOUNT"] == "121000" for l in b["ACCOUNTRECEIVABLE"])
    # CURRENCYAMOUNT mirrors every posting line, signed, netting to 0.
    lines = b["ACCOUNTGL"] + b["ACCOUNTRECEIVABLE"]
    ca = b["CURRENCYAMOUNT"]
    assert len(ca) == len(lines)
    assert {r["ITEMNO_ACC"] for r in ca} == {l["ITEMNO_ACC"] for l in lines}
    assert sum(r["AMT_DOCCUR"] for r in ca) == 0
    assert all(r["CURR_TYPE"] == "00" for r in ca)
    assert doc["balanced"] is True


# -------------------------------------------------------------------
# Lockbox parsers
# -------------------------------------------------------------------

def test_parse_bai2():
    pays = parse_bai2(BAI2)
    assert len(pays) == 1
    p = pays[0]
    assert p.amount_cents == 100000 and p.currency == "USD"
    assert "INV-2001" in p.references
    assert sniff_lockbox_format(BAI2, "x.txt") == "bai2"


def test_parse_mt940_credits_only():
    pays = parse_mt940(MT940)
    assert len(pays) == 1  # the debit line is not a payment
    assert pays[0].amount_cents == 100000
    assert "INV-2001" in pays[0].references
    assert sniff_lockbox_format(MT940, "x.txt") == "mt940"


def test_parse_camt054_credits_only():
    pays = parse_camt054(CAMT)
    assert len(pays) == 1  # the DBIT entry is excluded
    p = pays[0]
    assert p.amount_cents == 100000 and p.payer_raw == "Acme Widgets"
    assert "INV-2001" in p.references
    assert sniff_lockbox_format(CAMT, "x.xml") == "camt054"


def test_lockbox_file_import_reconciles():
    client.post("/api/v1/workspace/reset")
    inv_csv = ("invoice_id,customer,amount,po_number,discount_rate,age_days,due_in_days\n"
               "INV-2001,Acme Widgets,1000.00,,0,10,30\n")
    r = client.post("/api/v1/invoices/import", json={"csv_text": inv_csv, "mode": "replace"})
    assert r.status_code == 200, r.text
    body = {"kind": "payments", "filename": "lockbox.bai",
            "content_b64": base64.b64encode(BAI2.encode()).decode()}
    d = client.post("/api/v1/import/file", json=body).json()
    assert d["route"] == "lockbox" and d["format"] == "bai2"
    assert d["imported"] == 1
    assert d["run"]["auto_posted"] == 1


# -------------------------------------------------------------------
# FX conversion
# -------------------------------------------------------------------

def _inv(inv_id, cents, ccy="USD", customer="Acme Widgets"):
    return Invoice(inv_id, customer, customer, cents, currency=ccy, age_days=10)


def test_fx_candidates_need_rates():
    inv = _inv("INV-FX1", 100000)
    pay = Payment("W-EUR", "Acme Widgets", 92006, currency="EUR",
                  references=["INV-FX1"])
    cands, _src = resolve_candidates(pay, [inv], {})
    assert cands == []  # no rates: currency stays a hard boundary
    cands, _src = resolve_candidates(pay, [inv], {},
                                     Policy(fx_rates={"EUR": 1.087}))
    assert len(cands) == 1
    c = cands[0]
    assert c.gross_cents == 91996 and c.currency == "EUR"
    assert c.fx_book_gross_cents == 100000 and c.fx_book_currency == "USD"


def test_fx_policy_validation():
    r = client.put("/api/v1/policy", json={"policy": {"fx_rates": {"eur": 1.087}}})
    assert r.status_code == 422
    r = client.put("/api/v1/policy", json={"policy": {"fx_rates": {"EUR": -1}}})
    assert r.status_code == 422


def test_fx_end_to_end_document():
    client.post("/api/v1/workspace/reset")
    inv_csv = ("invoice_id,customer,amount,po_number,discount_rate,age_days,due_in_days\n"
               "INV-FX1,Acme Widgets,223.33,,0,10,30\n")
    client.post("/api/v1/invoices/import", json={"csv_text": inv_csv, "mode": "replace"})
    try:
        r = client.put("/api/v1/policy", json={"policy": {"fx_rates": {"EUR": 1.087}}})
        assert r.status_code == 200, r.text
        body = {"idempotency_key": "fx-e2e-1",
                "payments": [{"payment_id": "W-EUR", "payer_raw": "Acme Widgets",
                              "amount_cents": 20546, "currency": "EUR",
                              "references": ["INV-FX1"]}]}
        run = client.post("/api/v1/batches", json=body).json()
        assert run["auto_posted"] == 1, run
        d = client.get("/api/v1/payments/W-EUR/erp-document").json()
        doc = d["document"]
        assert doc["balanced"] is True
        gls = {l["gl_account"]: l for l in doc["journal"]}
        assert gls["113100"]["debit_cents"] == 22334        # cash at book value
        assert gls["121000"]["credit_cents"] == 22333       # AR at book gross
        assert gls["710100"]["credit_cents"] == 1           # realised FX gain
        assert doc["fx"]["variance_cents"] == 1
        assert doc["fx"]["payment_currency"] == "EUR"
    finally:
        client.put("/api/v1/policy", json={"policy": {"fx_rates": {}}})
