"""Ingestion + transform layer: messy uploads -> canonical schema.
Column mapping: deterministic synonym map first; corrections can be stored
per source fingerprint and are reapplied (the 'learning' transform memory)."""
import csv, io, hashlib, json, re
from domain import Invoice, Payment

HEADER_SYNONYMS = {
    "invoice_id": ["invoice", "invoice_id", "invoice_no", "invoice_number", "inv_no", "inv", "bill_no", "document_no"],
    "customer": ["customer", "customer_name", "client", "buyer", "payer_name", "sold_to"],
    "subsidiary": ["subsidiary", "entity", "company", "business_unit", "plant"],
    "gross_cents": ["amount", "gross", "gross_amount", "invoice_amount", "amount_due", "total_due", "due_amount", "invoice_total", "total_amount", "total", "value", "amt"],
    "po_number": ["po", "po_number", "po_no", "purchase_order", "order_no"],
    "discount_rate": ["discount_rate", "discount", "disc_pct", "early_pay_discount"],
    "age_days": ["age_days", "age", "days_outstanding", "aging"],
    "due_in_days": ["due_in_days", "days_to_due"],
    "predicted_delay_days": ["predicted_delay_days", "pred_delay", "expected_delay"],
}

def _norm(h): return re.sub(r"[^a-z0-9]", "_", h.strip().lower()).strip("_")

def propose_mapping(headers):
    mapping, used = {}, set()
    normed = {h: _norm(h) for h in headers}
    for field, syns in HEADER_SYNONYMS.items():
        for h, nh in normed.items():
            if nh in syns and h not in used:
                mapping[field] = h; used.add(h); break
    return mapping

def source_fingerprint(headers):
    return hashlib.sha256("|".join(sorted(_norm(h) for h in headers)).encode()).hexdigest()[:16]

def _money_to_cents(v):
    """Parse a money cell in either convention: 1,234.56 (US) or
    1.234,56 (European) or 1234,56 (decimal comma). The last separator
    present is the decimal one; a lone comma followed by three digits
    is a thousands separator."""
    if v is None or str(v).strip() == "": return 0
    s = str(v).replace("$", "").strip()
    if "," in s and "." in s:
        if s.rfind(",") > s.rfind("."): s = s.replace(".", "").replace(",", ".")
        else: s = s.replace(",", "")
    elif "," in s:
        parts = s.split(",")
        if len(parts) == 2 and len(parts[1]) == 2: s = s.replace(",", ".")
        else: s = s.replace(",", "")
    return int(round(float(s) * 100))

def _rate(v):
    """The discount column is a PERCENT column: 2 means 2%, 0.5 means
    0.5%, 1 means 1%. (The earlier dual reading - values <= 1 treated
    as decimal fractions - turned a 1% discount into 100% and a 0.5%
    discount into 50%.) Anything outside 0-50% is rejected as a data
    error rather than silently reinterpreted."""
    if v is None or str(v).strip() == "": return 0.0
    s = str(v).strip().replace("%", "")
    f = float(s)
    if f < 0 or f > 50: raise ValueError(f"discount percent {s} outside 0-50")
    return f / 100.0

def parse_invoices_csv(text):
    rdr = csv.DictReader(io.StringIO(text))
    headers = rdr.fieldnames or []
    mapping = propose_mapping(headers)
    rows, errors = [], []
    for i, row in enumerate(rdr, start=2):
        try:
            def g(f, default=""):
                h = mapping.get(f)
                return row.get(h, default) if h else default
            inv_id = str(g("invoice_id")).strip()
            if not inv_id: raise ValueError("missing invoice id")
            if not _ID_RE.match(inv_id): raise ValueError("invoice id contains characters that are not allowed")
            if _money_to_cents(g("gross_cents")) <= 0: raise ValueError("invoice amount must be positive")
            rows.append(Invoice(
                invoice_id=inv_id, customer=str(g("customer", "UNKNOWN")).strip() or "UNKNOWN",
                subsidiary=str(g("subsidiary", "MAIN")).strip() or "MAIN",
                gross_cents=_money_to_cents(g("gross_cents")),
                po_number=(str(g("po_number")).strip() or None),
                discount_rate=_rate(g("discount_rate")),
                age_days=int(float(g("age_days", 0) or 0)), due_in_days=int(float(g("due_in_days", 0) or 0)),
                predicted_delay_days=float(g("predicted_delay_days", 0) or 0)))
        except Exception as e:
            errors.append({"row": i, "error": str(e)})
    return {"invoices": rows, "mapping": mapping, "errors": errors, "fingerprint": source_fingerprint(headers)}

PAYMENT_HEADER_SYNONYMS = {
    "payment_id": ["payment_id", "payment", "payment_no", "payment_ref", "payment_reference", "txn_id", "transaction_id", "wire_id", "utr"],
    "payer_raw": ["payer", "payer_name", "customer", "customer_name", "remitter", "from"],
    "amount_cents": ["amount", "payment_amount", "paid", "value", "amt", "total"],
    "claimed_deduction_cents": ["deduction", "claimed_deduction", "deduction_amount", "short_pay"],
    "deduction_reason_raw": ["deduction_reason", "reason", "deduction_note"],
    "pod_verified_clean": ["pod_verified_clean", "pod_clean", "pod_verified", "proof_of_delivery_clean"],
    "remittance_text": ["remittance", "remittance_text", "notes", "reference_text", "memo"],
}

_REF_RE = re.compile(r"\b(?:([A-Za-z]{1,4})-)?(INV|PO|SI|BILL|DOC)[-\s]?(\d+)\b", re.IGNORECASE)

_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]+$")

def extract_references(text):
    out = []
    for prefix, kind, num in _REF_RE.findall(text or ""):
        bare = f"{kind.upper()}-{num}"
        if prefix:
            # A ledger whose ids carry a house prefix (U-INV-3, ACME-PO-9):
            # keep the full token so it can link to that ledger, and the
            # bare form too, so a prefix that was only prose costs nothing.
            full = f"{prefix.upper()}-{bare}"
            if full not in out: out.append(full)
        if bare not in out: out.append(bare)
    return out

def _truthy(v):
    return str(v).strip().lower() in ("true", "yes", "y", "1", "clean")

def parse_payments_csv(text):
    rdr = csv.DictReader(io.StringIO(text))
    headers = rdr.fieldnames or []
    normed = {h: _norm(h) for h in headers}
    mapping, used = {}, set()
    for field, syns in PAYMENT_HEADER_SYNONYMS.items():
        for h, nh in normed.items():
            if nh in syns and h not in used:
                mapping[field] = h; used.add(h); break
    rows, errors = [], []
    for i, row in enumerate(rdr, start=2):
        try:
            def g(f, default=""):
                h = mapping.get(f)
                return row.get(h, default) if h else default
            pid = str(g("payment_id")).strip()
            if not pid: raise ValueError("missing payment id")
            if not _ID_RE.match(pid): raise ValueError("payment id contains characters that are not allowed")
            if _money_to_cents(g("amount_cents")) <= 0: raise ValueError("payment amount must be positive")
            if _money_to_cents(g("claimed_deduction_cents")) < 0: raise ValueError("claimed deduction cannot be negative")
            remit = str(g("remittance_text", "")).strip()
            rows.append(Payment(
                payment_id=pid,
                payer_raw=str(g("payer_raw", "UNKNOWN")).strip() or "UNKNOWN",
                amount_cents=_money_to_cents(g("amount_cents")),
                claimed_deduction_cents=_money_to_cents(g("claimed_deduction_cents")),
                deduction_reason_raw=str(g("deduction_reason_raw", "")).strip(),
                pod_verified_clean=_truthy(g("pod_verified_clean")),
                remittance_text=remit,
                references=extract_references(remit)))
        except Exception as e:
            errors.append({"row": i, "error": str(e)})
    return {"payments": rows, "mapping": mapping, "errors": errors, "fingerprint": source_fingerprint(headers)}
