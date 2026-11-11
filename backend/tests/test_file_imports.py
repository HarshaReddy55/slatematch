"""v22: the two-sided-equation traps (owner audit, 1 Nov 2026).
Uploading against an active case must never (1) let a one-wire run
overwrite the case's results, (2) silently mix an unrelated ledger
into the active one, (3) leave a previous case's story on the brief,
or (4) refuse every file that is not a CSV."""
import base64, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
os.environ.setdefault("SLATEMATCH_DATA_DIR", os.path.join(os.path.dirname(__file__), "api_data"))
from fastapi.testclient import TestClient
import api as api_mod

client = TestClient(api_mod.app, raise_server_exceptions=False)

PAY_CSV = ("payment_id,payer,amount,remittance,deduction,deduction_reason\n"
           "X1,TransGlobal Trading,1000.00,Wire for INV-9999,,\n")
INV_CSV = ("invoice_id,customer,amount,po_number,discount_rate,age_days,due_in_days\n"
           "U-1,Zeta Components,5000.00,PO-Z1,0,20,10\n"
           "U-2,Yotta Systems,7500.00,PO-Y1,0,5,25\n")


def _load():
    client.post("/api/v1/workspace/reset")
    r = client.post("/api/v1/cases/seed/load")
    assert r.status_code == 200, r.text
    return r.json()


def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode()


def test_payments_csv_import_joins_the_run_never_replaces_it():
    _load()
    r = client.post("/api/v1/payments/import", json={"csv_text": PAY_CSV})
    assert r.status_code == 200, r.text
    d = r.json()
    # the whole staged set reconciled: 16 case wires + the new one
    assert d["run"]["payments"] == 17
    assert d["run"]["auto_posted"] == 10  # the case's results survive
    ws = client.get("/api/v1/workspace").json()
    assert ws["latest_run"]["auto_posted"] == 10
    matches = client.get(f"/api/v1/runs/{d['run']['run_id']}/matches").json()
    x1 = next(m for m in matches if m["payment_id"] == "X1")
    # honestly unmatched, not forced: no invoice lines, a NO_MATCH
    # verdict in the result, and a NO_MATCH exception - the record
    # itself waits in the human queue, exactly like the demo case's P6
    assert x1["result"]["status"] == "NO_MATCH" and x1["result"]["lines"] == []
    excs = client.get(f"/api/v1/runs/{d['run']['run_id']}/exceptions").json()
    assert any(e["payment_id"] == "X1" and e["kind"] == "NO_MATCH" for e in excs)


def test_invoices_import_replace_starts_a_fresh_ledger():
    _load()
    r = client.post("/api/v1/invoices/import", json={"csv_text": INV_CSV, "mode": "replace"})
    assert r.status_code == 200, r.text
    ws = r.json()["workspace"]
    assert ws["open_invoices"] == 2
    assert ws["case"]["id"] == "upload" and ws["case"]["source"] == "upload"
    assert ws["case"]["expect"] == {}  # no stale grading contract
    assert "2 open invoices" in ws["case"]["story"]
    assert "realistic" not in ws["case"]["story"]


def test_invoices_import_append_is_explicit_and_relabels_the_case():
    _load()
    r = client.post("/api/v1/invoices/import", json={"csv_text": INV_CSV, "mode": "append"})
    assert r.status_code == 200, r.text
    ws = r.json()["workspace"]
    assert ws["open_invoices"] == 21  # 19 demo + 2 uploaded, by choice
    assert ws["case"]["source"] == "upload"
    assert "21 open invoices" in ws["case"]["story"]


def test_invoices_import_rejects_unknown_mode():
    r = client.post("/api/v1/invoices/import", json={"csv_text": INV_CSV, "mode": "merge"})
    assert r.status_code == 422


def test_file_import_reads_a_remittance_email_file():
    _load()
    text = "Remittance advice\nFrom: TransGlobal Trading\nWire of $1,000.00 for INV-9999 attached.\n"
    r = client.post("/api/v1/import/file", json={
        "kind": "payments", "filename": "wire.txt", "content_b64": _b64(text.encode())})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["route"] == "remittance" and d["extracted_via"] == "text"
    assert d["staged"].startswith("WIRE-")
    assert d["fields"]["amount_cents"] == 100000
    # the ledger verifier flags the reference that does not exist
    assert d["verification"]["verified"] is False
    assert d["workspace"]["staged_payments"] == 17


def _minimal_pdf(text: str) -> bytes:
    """A small but well-formed PDF: real xref table with byte offsets,
    so any strict reader (pypdf included) accepts it."""
    stream = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode()
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
        b"/Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = b"%PDF-1.4\n"
    offsets = []
    for i, body in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref_at = len(out)
    out += f"xref\n0 {len(objs) + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += (f"trailer << /Size {len(objs) + 1} /Root 1 0 R >>\n"
            f"startxref\n{xref_at}\n%%EOF").encode()
    return out


def test_file_import_reads_a_pdf_remittance():
    _load()
    pdf = _minimal_pdf("Payment of $2,500.00 from Apex Manufacturing for INV-1001")
    r = client.post("/api/v1/import/file", json={
        "kind": "payments", "filename": "advice.pdf", "content_b64": _b64(pdf)})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["route"] == "remittance" and d["extracted_via"] == "pdf-text"
    assert d["fields"]["amount_cents"] == 250000
    assert "INV-1001" in d["fields"]["invoice_refs"]


def test_file_import_invoices_csv_through_the_file_door():
    client.post("/api/v1/workspace/reset")
    r = client.post("/api/v1/import/file", json={
        "kind": "invoices", "filename": "ledger.txt", "content_b64": _b64(INV_CSV.encode())})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["route"] == "csv" and d["imported"] == 2
    assert d["workspace"]["open_invoices"] == 2


def test_file_import_image_without_ocr_is_an_honest_refusal(monkeypatch):
    monkeypatch.setattr("shutil.which", lambda _: None)
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
    r = client.post("/api/v1/import/file", json={
        "kind": "payments", "filename": "wire.png", "content_b64": _b64(png)})
    assert r.status_code == 422
    assert "OCR is not available" in r.json()["detail"]


def test_import_without_csv_text_is_refused_not_silent():
    # A missing csv_text used to return imported: 0 as if it had worked.
    r = client.post("/api/v1/invoices/import", json={"csv": "invoice_id,customer,amount\nX,Y,1"})
    assert r.status_code == 422, r.text
    r = client.post("/api/v1/payments/import", json={})
    assert r.status_code == 422, r.text
