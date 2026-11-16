"""Bank lockbox and statement file parsers: BAI2, SWIFT MT940 and
ISO 20022 camt.054.

Enterprise treasury does not export wires to CSV by hand - banks
deliver these files over SFTP overnight. Each parser is
deterministic and total: it either produces Payment objects in the
same shape the CSV importer produces, or an empty list (never a
half-parsed file silently treated as success). References are
extracted with the same extractor the CSV path uses, and the payer
name, where the format carries one, with the deterministic parser's
payer rule - the matching engine's rungs do the rest.
"""
import re
import xml.etree.ElementTree as ET
from decimal import Decimal, ROUND_HALF_UP

from domain import Payment
from ingestion import extract_references


def _payer_from_text(text):
    from ai import deterministic_parse
    return deterministic_parse(text or "").get("payer") or ""


def _payment(pid, payer, amount_cents, currency, remittance):
    refs = extract_references(remittance or "")
    return Payment(payment_id=pid, payer_raw=payer or "",
                   amount_cents=int(amount_cents), currency=currency or "USD",
                   claimed_deduction_cents=0, deduction_reason_raw="",
                   pod_verified_clean=False,
                   remittance_text=(remittance or "")[:4000],
                   references=refs)


# -------------------------------------------------------------------
# BAI2
# -------------------------------------------------------------------

def parse_bai2(text):
    """BAI2 records: 01 file header, 02 group, 03 account, 16 detail,
    88 continuation, 49/98/99 trailers. Amounts on a 16 record are
    already integer cents. A 16 record is a payment when its type
    code is a credit code (100-399, excluding 100 itself, which is
    the total-credits summary) and the amount is positive."""
    payments = []
    currency = "USD"
    pending = None  # (fields, [continuation texts])

    def flush():
        nonlocal pending
        if pending is None:
            return
        fields, conts = pending
        pending = None
        try:
            type_code = int(fields[1])
            amount = int(fields[2])
        except (IndexError, ValueError):
            return
        if not (100 < type_code < 400) or amount <= 0:
            return
        bank_ref = fields[4].strip() if len(fields) > 4 else ""
        cust_ref = fields[5].strip() if len(fields) > 5 else ""
        remit = " ".join(c for c in conts if c).strip()
        if cust_ref:
            remit = (cust_ref + " " + remit).strip()
        pid = "BAI2-" + (bank_ref or cust_ref or f"{len(payments) + 1:04d}")
        payments.append(_payment(pid, _payer_from_text(remit), amount,
                                 currency, remit))

    for raw_line in (text or "").splitlines():
        line = raw_line.strip().rstrip("/")
        if not line:
            continue
        code = line[:2]
        if code == "88":
            if pending is not None:
                pending[1].append(line[3:].strip())
            continue
        if code == "16":
            flush()
            pending = (line.split(","), [])
            continue
        flush()
        fields = line.split(",")
        if code == "03" and len(fields) > 2 and fields[2].strip():
            currency = fields[2].strip().upper()
        elif code == "02" and len(fields) > 6 and fields[6].strip():
            currency = fields[6].strip().upper()
    flush()
    return payments


# -------------------------------------------------------------------
# SWIFT MT940
# -------------------------------------------------------------------

_TAG_RE = re.compile(r"(?m)^:(\d{2}[A-Z]?):")
_61_RE = re.compile(
    r"^(\d{6})(?:\d{4})?(RC|C|RD|D)[A-Z]?([0-9]+,[0-9]{1,2})([A-Z0-9]{4})"
    r"(?:\n|//)?(.*)$", re.S)


def _tag_blocks(text):
    """Split an MT940 message into {tag: [block, ...]} preserving order
    as a list of (tag, body) pairs."""
    parts = []
    matches = list(_TAG_RE.finditer(text or ""))
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        parts.append((m.group(1), text[m.end():end].strip()))
    return parts


def parse_mt940(text):
    """Customer statement message: :61: statement lines with their
    :86: remittance blocks. Credit lines (C / RC) are payments;
    amounts use the SWIFT comma decimal separator."""
    blocks = _tag_blocks(text)
    currency = "USD"
    for tag, body in blocks:
        if tag in ("60F", "60M", "62F", "62M"):
            m = re.search(r"[CD]\d{6}([A-Z]{3})", body)
            if m:
                currency = m.group(1)
                break
    stmt_ref = next((b.split()[0] for t, b in blocks if t == "20"), "STMT")
    payments = []
    pending = None  # dict for the current :61:

    def flush():
        nonlocal pending
        if pending is None:
            return
        p, pending = pending, None
        remit = (p["ref"] + " " + p["info"]).strip()
        pid = f"MT940-{stmt_ref}-{len(payments) + 1:03d}"
        payments.append(_payment(pid, _payer_from_text(remit),
                                 p["amount_cents"], currency, remit))

    for tag, body in blocks:
        if tag == "61":
            flush()
            m = _61_RE.match(body.replace("\r", ""))
            if not m:
                continue
            _date, mark, amount_s, _ttype, rest = m.groups()
            if mark not in ("C", "RC"):
                continue
            cents = int((Decimal(amount_s.replace(",", ".")) * 100)
                        .quantize(Decimal("1"), rounding=ROUND_HALF_UP))
            ref = ""
            if rest:
                ref = rest.split("\n")[0].strip()
            pending = {"amount_cents": cents, "ref": ref, "info": ""}
        elif tag == "86" and pending is not None:
            pending["info"] = " ".join(body.split())
    flush()
    return payments


# -------------------------------------------------------------------
# ISO 20022 camt.054 (debit/credit notification)
# -------------------------------------------------------------------

def _local(tag):
    return tag.rsplit("}", 1)[-1]


def _children(el, name):
    return [c for c in el.iter() if _local(c.tag) == name]


def _first_text(el, name):
    for c in el.iter():
        if _local(c.tag) == name and c.text:
            return c.text.strip()
    return ""


def parse_camt054(text):
    """Bank-to-customer debit/credit notification. Each credit entry
    (CdtDbtInd = CRDT) is a payment; the debtor name is the payer and
    the unstructured remittance plus instruction references carry
    the invoice references. Namespace-agnostic: camt files vary
    their ISO namespace URIs by version."""
    try:
        root = ET.fromstring(text or "")
    except ET.ParseError:
        return []
    payments = []
    for ntry in _children(root, "Ntry"):
        if _first_text(ntry, "CdtDbtInd") != "CRDT":
            continue
        amt_el = next((c for c in ntry.iter() if _local(c.tag) == "Amt"), None)
        if amt_el is None or not amt_el.text:
            continue
        cents = int((Decimal(amt_el.text.strip()) * 100)
                    .quantize(Decimal("1"), rounding=ROUND_HALF_UP))
        if cents <= 0:
            continue
        currency = (amt_el.get("Ccy") or "USD").upper()
        payer = _first_text(ntry, "Nm")
        ustrd = " ".join(t.strip() for t in
                         (c.text or "" for c in _children(ntry, "Ustrd")) if t.strip())
        instr = _first_text(ntry, "InstrRef")
        remit = (ustrd + " " + instr).strip()
        ref = (_first_text(ntry, "AcctSvcrRef") or _first_text(ntry, "NtryRef")
               or f"{len(payments) + 1:04d}")
        payments.append(_payment("CAMT-" + ref, payer, cents, currency, remit))
    return payments


PARSERS = {"bai2": parse_bai2, "mt940": parse_mt940, "camt054": parse_camt054}


def sniff_lockbox_format(text, filename=""):
    """Name the bank-file format of an upload, or None. Extension
    first, then content signatures - a treasury file renamed to
    .txt still parses."""
    name = (filename or "").lower()
    if name.endswith((".bai", ".bai2")):
        return "bai2"
    if name.endswith((".940", ".sta", ".mt940")):
        return "mt940"
    head = (text or "")[:1500]
    if head.lstrip().startswith("<") and ("camt.054" in head
                                          or "BkToCstmrDbtCdtNtfctn" in head):
        return "camt054"
    if re.search(r"(?m)^01,", head) and re.search(r"(?m)^03,", head):
        return "bai2"
    if ":20:" in head and ":61:" in head:
        return "mt940"
    return None
