"""ERP posting documents in SAP S/4HANA style.

This module turns a stored match into the posting document an ERP
would receive: a balanced journal built from the match's own
derivation, plus the BAPI_ACC_DOCUMENT_POST-shaped payload that
carries it. It generates documents - it does not post them. No ERP is
connected; the chart of accounts below is an illustrative template in
SAP style, and every amount comes from the match itself.

Revenue recognition (ASC 606 / IFRS 15, event-based): a deduction
under dispute is NOT netted against revenue. The disputed amount is
carried as a disputed receivable until the dispute resolves, so the
transaction price is never understated by a claim whose validity is
still being contested. dispute_accrual_journal() produces that
reclassification document.
"""

GL = {
    "cash": ("113100", "Cash - operating account"),
    "ar_control": ("121000", "Trade receivables - customer control"),
    "disputed_ar": ("121500", "Disputed receivables - deduction claims"),
    "discounts": ("415000", "Sales discounts allowed"),
    "deductions": ("529000", "Deductions accepted (within policy)"),
    "suspense": ("119900", "Unapplied cash suspense"),
    "residual_ar": ("121600", "Residual receivable - part-paid invoices"),
    "on_account": ("121900", "Unapplied cash - customer on-account"),
    "fx_gain": ("710100", "Realised FX gain"),
    "fx_loss": ("710200", "Realised FX loss"),
}

# Accounts that belong to the customer sub-ledger. In a real
# BAPI_ACC_DOCUMENT_POST these may never appear in ACCOUNTGL (SAP
# rejects a reconciliation account there, error RW602); they post
# through ACCOUNTRECEIVABLE with the account as the line's assigned
# G/L (the special-G/L pattern).
AR_FAMILY = {"ar_control", "disputed_ar", "residual_ar", "on_account"}

COMPANY_CODE = "1000"  # illustrative template value

def document_number_for(match_id):
    """A deterministic clearing-document number for a match that has no
    approval-issued number (auto-posted matches): derived from the
    match id, so every surface - the SAP page, the run documents, the
    export - shows the SAME number for the same match, and a cleared
    item never carries a null document number."""
    import hashlib
    n = int(hashlib.sha256(str(match_id).encode()).hexdigest()[:8], 16) % 900000 + 100000
    return f"DZ-1400{n}"


def _line(gl_key, debit_cents=0, credit_cents=0):
    code, name = GL[gl_key]
    return {"gl_account": code, "account": name,
            "debit_cents": debit_cents, "credit_cents": credit_cents}


def build_posting_document(match_result, payment, document_number=None, customers=None):
    """Balanced DZ (customer payment) document for one match.

    Amounts come from the match's derivation equation and its lines -
    the same numbers the reconciliation produced, nothing re-derived
    here. Debits equal credits by construction; the caller can assert
    the `balanced` flag.
    """
    lines = match_result.get("lines") or []
    gross = sum(l.get("gross_cents", 0) for l in lines)
    discounts = sum(l.get("discount_cents", 0) or 0 for l in lines)
    eq = (match_result.get("derivation") or {}).get("equation") or {}
    payment_cents = eq.get("payment_cents")
    if payment_cents is None:
        payment_cents = sum(l.get("net_cents", 0) for l in lines)
    deduction_applied = eq.get("deduction_applied_cents") or 0
    # The stored match record carries the residual inside its derivation
    # equation, not as a top-level field; reading only the top level made
    # every partial or overpaid document come out unbalanced (found by
    # the v40 live audit). Same fallback as the decision handler.
    residual = match_result.get("residual_cents")
    if residual is None:
        residual = eq.get("residual_cents") or 0

    journal = [_line("cash", debit_cents=payment_cents)]
    journal_keys = ["cash"]
    if discounts:
        journal.append(_line("discounts", debit_cents=discounts))
        journal_keys.append("discounts")
    if deduction_applied:
        journal.append(_line("deductions", debit_cents=deduction_applied))
        journal_keys.append("deductions")
    fx = match_result.get("fx") or {}
    fx_variance = fx.get("variance_cents") or 0
    if fx_variance:
        # Realised FX difference on a cross-currency settlement: a
        # gain is a credit, a loss a debit (see the FX builder in
        # api/erp flow; the journal stays balanced because the AR
        # side of an FX document is carried at book value).
        if fx_variance > 0:
            journal.append(_line("fx_gain", credit_cents=fx_variance))
            journal_keys.append("fx_gain")
        else:
            journal.append(_line("fx_loss", debit_cents=-fx_variance))
            journal_keys.append("fx_loss")
    if residual < 0:
        # Underpaid: the unpaid remainder is a residual receivable, not
        # suspense - the customer still owes it and it stays visible.
        journal.append(_line("residual_ar", debit_cents=-residual))
        journal_keys.append("residual_ar")
    journal.append(_line("ar_control", credit_cents=gross))
    journal_keys.append("ar_control")
    if residual > 0:
        # Overpaid: the excess is the customer's on-account credit.
        journal.append(_line("on_account", credit_cents=residual))
        journal_keys.append("on_account")

    debits = sum(l["debit_cents"] for l in journal)
    credits = sum(l["credit_cents"] for l in journal)
    currency = (payment or {}).get("currency") or "USD"

    # ---- BAPI_ACC_DOCUMENT_POST payload, full table shape --------
    # Every posting line gets an ITEMNO_ACC; CURRENCYAMOUNT mirrors
    # every ACCOUNTGL and ACCOUNTRECEIVABLE line under the same
    # number (CURR_TYPE "00", document currency), signed S/H.
    from datetime import datetime, timezone
    today = datetime.now(timezone.utc)
    yyyymmdd = today.strftime("%Y%m%d")
    item_no = [0]

    def _item():
        item_no[0] += 10
        return f"{item_no[0]:010d}"

    def _customer_for(inv):
        return ((customers or {}).get(inv.get("invoice_id"))
                or inv.get("customer")
                or (payment or {}).get("payer_raw")
                or "UNKNOWN")

    accountgl, receivable, amounts = [], [], []

    def _amount(item, cents, indicator):
        amounts.append({"ITEMNO_ACC": item, "CURR_TYPE": "00",
                        "CURRENCY": currency,
                        "AMT_DOCCUR": cents if indicator == "S" else -cents})

    for key, l in zip(journal_keys, journal):
        indicator = "S" if l["debit_cents"] else "H"
        cents = l["debit_cents"] or l["credit_cents"]
        if key in AR_FAMILY:
            continue  # posted below through ACCOUNTRECEIVABLE
        item = _item()
        accountgl.append({"ITEMNO_ACC": item, "GL_ACCOUNT": l["gl_account"],
                          "ITEM_TEXT": l["account"],
                          "DEBIT_CREDIT_INDICATOR": indicator,
                          "AMOUNT_CENTS": cents})
        _amount(item, cents, indicator)
    for inv in lines:
        g = inv.get("gross_cents", 0)
        indicator = "H" if g >= 0 else "S"  # a credit memo clears as a debit
        item = _item()
        receivable.append({"ITEMNO_ACC": item, "CUSTOMER": _customer_for(inv),
                           "COMP_CODE": COMPANY_CODE,
                           "GL_ACCOUNT": GL["ar_control"][0],
                           "INVOICE_ID": inv.get("invoice_id"),
                           "DEBIT_CREDIT_INDICATOR": indicator,
                           "AMOUNT_CENTS": abs(g)})
        _amount(item, abs(g), indicator)
    for key, l in zip(journal_keys, journal):
        if key not in ("residual_ar", "on_account"):
            continue
        indicator = "S" if l["debit_cents"] else "H"
        cents = l["debit_cents"] or l["credit_cents"]
        item = _item()
        receivable.append({"ITEMNO_ACC": item,
                           "CUSTOMER": _customer_for(lines[0] if lines else {}),
                           "COMP_CODE": COMPANY_CODE,
                           "GL_ACCOUNT": l["gl_account"],
                           "ITEM_TEXT": l["account"],
                           "DEBIT_CREDIT_INDICATOR": indicator,
                           "AMOUNT_CENTS": cents})
        _amount(item, cents, indicator)

    bapi = {
        "DOCUMENTHEADER": {
            "USERNAME": "SLATEMATCH",
            "DOCUMENT_TYPE": "DZ",
            "COMPANY_CODE": COMPANY_CODE,
            "CURRENCY": currency,
            "DOCUMENT_NUMBER": document_number,
            "REFERENCE": (payment or {}).get("payment_id"),
            "HEADER_TEXT": "SlateMatch autonomous cash application",
            "DOC_DATE": yyyymmdd,
            "PSTNG_DATE": yyyymmdd,
            "FISC_YEAR": today.strftime("%Y"),
            "FIS_PERIOD": today.strftime("%m"),
        },
        "ACCOUNTGL": accountgl,
        "ACCOUNTRECEIVABLE": receivable,
        "CURRENCYAMOUNT": amounts,
        "EXTENSION2": [
            {"STRUCTURE": "SLATEMATCH_REF",
             "VALUEPART1": (payment or {}).get("payment_id") or "",
             "VALUEPART2": "generated_not_posted"},
        ],
    }
    return {
        "document_type": "DZ",
        "document_number": document_number,
        "status": "STAGED_FOR_SAP_POSTING" if document_number else "preview",
        "journal": journal,
        "total_debits_cents": debits,
        "total_credits_cents": credits,
        "balanced": debits == credits,
        "bapi_payload": bapi,
        "note": ("Generated by erp_sap.build_posting_document from this "
                 "match's own derivation. No ERP is connected and nothing "
                 "has been posted anywhere; the chart of accounts is an "
                 "illustrative template in SAP style."),
    }


def document_for_match(match_result, payment, document_number=None, customers=None):
    """The posting document for a stored match. A cross-currency
    (FX) match carries a book-currency view of itself in
    match_result["fx"] (recorded by the batch when the set balanced
    at the policy rate): its document is then built in BOOK currency
    - cash at the transaction value, AR at book value, and the
    difference on the realised FX gain/loss line - instead of the
    payment-currency document an ordinary match gets."""
    fx = (match_result or {}).get("fx")
    if not fx:
        return build_posting_document(match_result, payment, document_number, customers)
    book_res = {
        "lines": fx["book_lines"],
        "residual_cents": 0,
        "derivation": {"equation": {
            "payment_cents": fx["book_payment_cents"],
            "deduction_applied_cents": fx.get("book_deduction_cents") or 0,
            "residual_cents": 0}},
        "fx": {"variance_cents": fx.get("variance_cents") or 0},
    }
    book_payment = dict(payment or {})
    book_payment["currency"] = fx["book_currency"]
    doc = build_posting_document(book_res, book_payment, document_number, customers)
    doc["fx"] = {"payment_currency": fx["payment_currency"],
                 "book_currency": fx["book_currency"],
                 "rate_text": fx.get("rate_text"),
                 "variance_cents": fx.get("variance_cents") or 0}
    doc["note"] += (" FX: the wire arrived in " + fx["payment_currency"] +
                    "; this document posts in the book currency " +
                    fx["book_currency"] + " at " + (fx.get("rate_text") or "the policy rate") +
                    ", with the realised difference on GL 710100/710200.")
    return doc


def dispute_accrual_journal(deduction):
    """Event-based revenue-recognition handling for a disputed deduction.

    The claim is reclassified out of trade receivables into disputed
    receivables at its claimed amount. Revenue is untouched: under
    ASC 606 / IFRS 15 the variable consideration resolves when the
    dispute closes, not when the claim arrives.
    """
    claimed = deduction.get("claimed_cents") or 0
    journal = [
        _line("disputed_ar", debit_cents=claimed),
        _line("ar_control", credit_cents=claimed),
    ]
    return {
        "document_type": "DR",
        "journal": journal,
        "balanced": sum(l["debit_cents"] for l in journal)
                    == sum(l["credit_cents"] for l in journal),
        "reason_code": deduction.get("assigned_erp_reason_code"),
        "expected_recovery_usd": deduction.get("expected_recovery_value_usd"),
        "note": ("ASC 606 / IFRS 15 (event-based): the disputed amount is "
                 "carried as a disputed receivable (GL 121500) rather than "
                 "netted against revenue, so the transaction price is not "
                 "understated by a deduction whose validity is still being "
                 "contested. It resolves when the dispute closes."),
    }


def build_oracle_payload(document):
    """The same balanced journal in Oracle ERP's journal-import
    shape: a header (source, category, accounting date, currency)
    and lines carrying account, debit and credit in major units.
    The journal is unchanged - only the envelope is Oracle's."""
    from datetime import datetime, timezone
    journal = document.get("journal") or []
    lines = [{"account": l["gl_account"],
              "account_name": l.get("account_name", ""),
              "debit": (l.get("debit_cents") or 0) / 100.0,
              "credit": (l.get("credit_cents") or 0) / 100.0,
              "description": l.get("text", "")}
             for l in journal]
    return {"source": "SlateMatch", "category": "Cash Receipts",
            "accounting_date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            "currency": document.get("currency", "USD"),
            "reference": document.get("document_number"),
            "description": document.get("note", ""),
            "lines": lines}


def build_netsuite_payload(document):
    """The same balanced journal in NetSuite's journal-entry
    record shape (REST record API): tranDate, currency, and a
    line list with account, debit and credit in major units."""
    from datetime import datetime, timezone
    journal = document.get("journal") or []
    lines = [{"account": l["gl_account"],
              "debit": (l.get("debit_cents") or 0) / 100.0,
              "credit": (l.get("credit_cents") or 0) / 100.0,
              "memo": l.get("text", "")}
             for l in journal]
    return {"recordType": "journalentry",
            "tranDate": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            "currency": document.get("currency", "USD"),
            "externalId": document.get("document_number"),
            "memo": document.get("note", ""),
            "lineList": lines}
