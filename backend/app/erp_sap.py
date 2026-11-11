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
}

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
    if discounts:
        journal.append(_line("discounts", debit_cents=discounts))
    if deduction_applied:
        journal.append(_line("deductions", debit_cents=deduction_applied))
    if residual < 0:
        # Underpaid: the unpaid remainder is a residual receivable, not
        # suspense - the customer still owes it and it stays visible.
        journal.append(_line("residual_ar", debit_cents=-residual))
    journal.append(_line("ar_control", credit_cents=gross))
    if residual > 0:
        # Overpaid: the excess is the customer's on-account credit.
        journal.append(_line("on_account", credit_cents=residual))

    debits = sum(l["debit_cents"] for l in journal)
    credits = sum(l["credit_cents"] for l in journal)
    currency = (payment or {}).get("currency") or "USD"

    bapi = {
        "DOCUMENTHEADER": {
            "DOCUMENT_TYPE": "DZ",
            "COMPANY_CODE": COMPANY_CODE,
            "CURRENCY": currency,
            "DOCUMENT_NUMBER": document_number,
            "REFERENCE": (payment or {}).get("payment_id"),
            "HEADER_TEXT": "SlateMatch autonomous cash application",
        },
        "ACCOUNTGL": [
            {"GL_ACCOUNT": l["gl_account"], "ITEM_TEXT": l["account"],
             "DEBIT_CREDIT_INDICATOR": "S" if l["debit_cents"] else "H",
             "AMOUNT_CENTS": l["debit_cents"] or l["credit_cents"]}
            for l in journal
        ],
        "ACCOUNTRECEIVABLE": [
            {"CUSTOMER": (customers or {}).get(inv.get("invoice_id"))
                         or inv.get("customer")
                         or (payment or {}).get("payer_raw")
                         or "UNKNOWN",
             "INVOICE_ID": inv.get("invoice_id"),
             "AMOUNT_CENTS": inv.get("gross_cents", 0)}
            for inv in lines
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
