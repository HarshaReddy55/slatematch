"""v52: the three recognition gaps from the functional campaign
(3 Nov 2026). (1) Standard CSV headers "Amount Due" / "Payment Ref"
were missing from the synonym lists, so real-world files imported
zero rows. (2) OCR repair generated variants of the alphabetic prefix
only, so a scanner confusion inside the digits (INV-1O05) never fired
the ocr_reference rung. (3) Remittance reference extraction dropped
house prefixes (U-INV-3 read as INV-3), so prefixed ledger ids could
not link or verify."""
import base64, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
os.environ.setdefault("SLATEMATCH_DATA_DIR", os.path.join(os.path.dirname(__file__), "api_data"))
from fastapi.testclient import TestClient
import api as api_mod
from fuzzy import ocr_variants
from ingestion import extract_references

client = TestClient(api_mod.app, raise_server_exceptions=False)


def test_amount_due_and_payment_ref_headers_import():
    client.post("/api/v1/workspace/reset")
    inv = ("Invoice No,Client,Amount Due,PO\n"
           "U-INV-1,Upload Corp,10000.00,PO-U1\n"
           "U-INV-2,Upload Corp,5000.00,PO-U2\n")
    r = client.post("/api/v1/invoices/import", json={"csv_text": inv, "mode": "replace"})
    assert r.status_code == 200, r.text
    assert r.json()["imported"] == 2, r.json()
    pay = ("Payment Ref,Payer,Amount,Remittance\n"
           "U-P1,Upload Corp,10000.00,For invoice U-INV-1\n")
    r = client.post("/api/v1/payments/import", json={"csv_text": pay})
    assert r.status_code == 200, r.text
    assert r.json()["imported"] == 1, r.json()


def test_ocr_variants_cover_prefix_and_digits():
    assert "INV-1005" in ocr_variants("1NV-1005")
    assert "INV-1005" in ocr_variants("INV-1O05")
    assert "INV-1005" in ocr_variants("INV-100S")


def test_garbled_reference_matches_via_ocr_rung():
    client.post("/api/v1/workspace/reset")
    assert client.post("/api/v1/cases/seed/load").status_code == 200
    r = client.post("/api/v1/batches", json={
        "idempotency_key": "v52-ocr-1",
        "payments": [{"payment_id": "X1", "payer_raw": "BluePeak Electronics",
                      "amount_cents": 3675000, "references": ["INV-1O05"]}]})
    assert r.status_code == 200, r.text
    run = r.json().get("run") or r.json()
    m = client.get(f"/api/v1/runs/{run['run_id']}/matches").json()
    rows = m["matches"] if isinstance(m, dict) else m
    x1 = [x for x in rows if x["payment_id"] == "X1"][0]
    assert x1["result"]["matched_by"] == "ocr_reference", x1["result"]["matched_by"]
    assert x1["result"]["status"] == "OPTIMAL_EXACT_MATCH"


def test_prefixed_reference_extraction_keeps_the_full_token():
    refs = extract_references("Payment settles U-INV-3 in full, ref U-INV-3")
    assert "U-INV-3" in refs, refs
    assert extract_references("against INV-1001 and PO-11") == ["INV-1001", "PO-11"]


def test_prefixed_reference_survives_file_import():
    client.post("/api/v1/workspace/reset")
    txt = "Remittance advice\nPayer: Upload Corp\nPayment of 2500.00 settles invoice U-INV-3.\n"
    r = client.post("/api/v1/import/file", json={
        "filename": "remit.txt",
        "content_b64": base64.b64encode(txt.encode()).decode(),
        "kind": "payments", "mode": "stage"})
    assert r.status_code == 200, r.text
    assert "U-INV-3" in (r.json().get("fields") or {}).get("invoice_refs", []), r.json()
