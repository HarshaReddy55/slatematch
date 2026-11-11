"""Mail: the drafts the product creates can be sent from inside the
product - dispute claims, remittance chases, collection reminders.

Transport is SMTP, configured by environment:
  SLATEMATCH_SMTP_HOST, SLATEMATCH_SMTP_PORT (default 587),
  SLATEMATCH_SMTP_USER, SLATEMATCH_SMTP_PASSWORD,
  SLATEMATCH_MAIL_FROM, SLATEMATCH_SMTP_TLS (default on).

Honesty rule: until a mailbox is configured, a "send" is RECORDED in
the tenant's outbox with status recorded_not_sent and a plain reason.
The product never reports a mail as sent when nothing left the
building. Failures are recorded too, with the transport's error."""
import os

def _env(name, default=""):
    v = os.environ.get("SLATEMATCH_" + name)
    return default if v is None else v


import re
import smtplib
import ssl
from datetime import datetime, timezone
from email.message import EmailMessage

KINDS = ("dispute_claim", "chase", "collection_reminder", "settlement_confirmation", "other")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _money(cents):
    c = cents or 0
    return f"-${abs(c) / 100:,.2f}" if c < 0 else f"${c / 100:,.2f}"


def mail_config():
    host = _env("SMTP_HOST", "").strip()
    sender = _env("MAIL_FROM", "").strip()
    try:
        port = int(_env("SMTP_PORT", "587") or 587)
    except ValueError:
        port = 587
    return {"host": host, "port": port,
            "user": _env("SMTP_USER", "").strip(),
            "password": _env("SMTP_PASSWORD", ""),
            "from": sender,
            "tls": _env("SMTP_TLS", "1") != "0",
            "configured": bool(host and sender)}

def mail_config_public():
    """mail_config() for API responses: everything a diagnostic view
    legitimately shows, with the SMTP password replaced by the fact of
    its presence. The raw config (with the password) is for the mail
    sender's own use inside this process only."""
    cfg = mail_config()
    return {**cfg, "password": None,
            "password_configured": bool(cfg.get("password"))}


def reminder_tone(inv):
    """Dunning is segmented by where the invoice sits against its due
    date: a gentle pre-due notice, a firm past-due reminder, and a final
    credit-hold escalation for the long-overdue tail."""
    if inv.due_in_days >= 0:
        return "gentle", "Gentle pre-due notice"
    if inv.due_in_days >= -14:
        return "firm", "Firm past-due reminder"
    return "escalation", "Final credit-hold escalation"


def reminder_draft(inv):
    """A collection reminder grounded in one ledger row - the amounts
    and dates come from the invoice itself, never from a template. The
    tone follows the dunning segment the invoice is in."""
    overdue = max(0, -inv.due_in_days)
    if overdue:
        when = f"is {overdue} days past its due date"
    elif inv.due_in_days == 0:
        when = "falls due today"
    else:
        when = f"falls due in {inv.due_in_days} days"
    tone, tone_label = reminder_tone(inv)
    facts = (f"Invoice: {inv.invoice_id}\n"
             f"Amount: {_money(inv.gross_cents)}\n"
             + (f"Purchase order: {inv.po_number}\n" if inv.po_number else ""))
    if tone == "gentle":
        subject = f"Payment reminder - invoice {inv.invoice_id} for {_money(inv.gross_cents)}"
        body = (f"Dear Accounts Payable team,\n\n"
                f"A polite reminder that invoice {inv.invoice_id} for {_money(inv.gross_cents)} "
                f"{when}.\n\n"
                f"If payment is already on its way, thank you - no action is needed. "
                f"If anything on the invoice needs clarification, reply to this mail and we will "
                f"resolve it with you directly. If payment will be later than planned, a short note "
                f"with the expected date helps us plan on our side.\n\n"
                f"{facts}"
                f"\nThank you,\nAccounts Receivable")
    elif tone == "firm":
        subject = f"Past due - invoice {inv.invoice_id} for {_money(inv.gross_cents)}, {overdue} days overdue"
        body = (f"Dear Accounts Payable team,\n\n"
                f"Invoice {inv.invoice_id} for {_money(inv.gross_cents)} {when}, and we have "
                f"not yet received payment or a remittance advice for it.\n\n"
                f"Please arrange payment this week, or reply with the payment date and the "
                f"remittance breakdown so we can apply the cash when it lands. If a document "
                f"is missing from our side - a signed proof of delivery, a corrected invoice - "
                f"tell us and we will send it straight away.\n\n"
                f"{facts}"
                f"\nAccounts Receivable")
    else:
        subject = f"Final notice - invoice {inv.invoice_id} for {_money(inv.gross_cents)}, {overdue} days overdue"
        body = (f"Dear Accounts Payable team,\n\n"
                f"Invoice {inv.invoice_id} for {_money(inv.gross_cents)} {when}, and it remains "
                f"unpaid, with no dispute raised against it.\n\n"
                f"Please treat this as urgent: payment, or a written dispute, is needed now, and "
                f"unresolved balances may affect future order releases. If payment is already "
                f"in transit, send the remittance "
                f"advice today so we can apply it on arrival.\n\n"
                f"{facts}"
                f"\nAccounts Receivable - Collections")
    return {"subject": subject, "body": body, "tone": tone, "tone_label": tone_label}


def settlement_draft(payer, payment_id, lines, erp_document_id=None,
                     remaining_by_invoice=None):
    """Category-3 mail: the settlement advice for one cleared payment.
    Every figure comes from the match's own record: the applied amount
    per invoice, and the balance each invoice is genuinely left with -
    a part-paid invoice stays open at its reduced balance and the draft
    says so. remaining_by_invoice carries the approval decision's own
    partial-application facts when the draft follows an approval; for
    an auto-posted (exact) match every balance is $0.00 by definition.
    The clearing reference is SlateMatch's own staged posting pack for
    SAP S/4HANA, and the draft names it as such."""
    gross = sum(l.get("gross_cents", 0) for l in lines)
    disc = sum(l.get("discount_cents", 0) or 0 for l in lines)

    def _applied(l):
        # A stored line's net_cents is the invoice's full net; for a
        # part-paid invoice the decision's remaining balance is the
        # truth, and the applied part is what is left of the line.
        if remaining_by_invoice and l["invoice_id"] in remaining_by_invoice:
            return max(0, l.get("gross_cents", 0) - (l.get("discount_cents", 0) or 0)
                       - remaining_by_invoice[l["invoice_id"]])
        return l.get("net_cents", 0)

    net = sum(_applied(l) for l in lines)

    def _remaining(l):
        if remaining_by_invoice and l["invoice_id"] in remaining_by_invoice:
            return remaining_by_invoice[l["invoice_id"]]
        return max(0, l.get("gross_cents", 0) - (l.get("discount_cents", 0) or 0)
                   - l.get("net_cents", 0))

    rows = "\n".join(
        f"- {l['invoice_id']}: {_money(l.get('gross_cents', 0))} gross"
        + (f", {_money(l.get('discount_cents', 0) or 0)} early-payment discount applied"
           if l.get("discount_cents") else "")
        + f", {_money(_applied(l))} applied - remaining balance {_money(_remaining(l))}"
        for l in lines)
    open_lines = [l for l in lines if _remaining(l) > 0]
    doc = (f"SlateMatch clearing document: {erp_document_id} (document type DZ, customer payment) - "
           "a staged posting pack for SAP S/4HANA, balanced debits = credits"
           if erp_document_id else
           "The balanced posting document (type DZ) for this payment is generated "
           "in SlateMatch as a staged pack for SAP S/4HANA and opens from the match "
           "evidence and the Outbound Mail Hub.")
    if open_lines:
        subject = (f"Settlement advice - payment {payment_id} applied in part, "
                   f"{_money(net)}; {len(open_lines)} invoice(s) remain open")
        head = (f"Your payment {payment_id} has been applied as follows. Invoices "
                f"with a balance remaining stay open for that amount:\n\n")
    else:
        subject = (f"Settlement advice - payment {payment_id} applied, "
                   f"{len(lines)} invoice(s) closed, {_money(net)}")
        head = (f"Your payment {payment_id} has been applied in full. The invoices below are "
                f"closed, each with a remaining balance of $0.00:\n\n")
    body = (f"Dear {payer} Accounts Payable team,\n\n"
            f"{head}"
            f"{rows}\n\n"
            f"Total applied: {_money(net)} against {_money(gross)} gross"
            + (f", including {_money(disc)} of agreed early-payment discount.\n" if disc else ".\n")
            + f"{doc}\n\n"
            f"If any line does not agree with your records, reply to this mail quoting "
            f"payment {payment_id} and we will reconcile it with you directly.\n\n"
            f"Thank you,\nAccounts Receivable - SlateMatch")
    return {"subject": subject, "body": body}


def _now():
    return datetime.now(timezone.utc).isoformat()


def send_mail(repo, actor, to_addr, subject, body, kind, ref_id):
    """Record first, then transport. Returns the outbox record with its
    true status: sent / failed / recorded_not_sent."""
    to_addr = (to_addr or "").strip()
    subject = (subject or "").strip()
    body = (body or "").strip()
    if not EMAIL_RE.match(to_addr):
        raise ValueError("recipient is not a valid email address")
    if not subject or not body:
        raise ValueError("subject and body are required - draft the message first")
    if kind not in KINDS:
        kind = "other"
    cfg = mail_config()
    if not cfg["configured"]:
        detail = ("No mailbox configured (set SLATEMATCH_SMTP_HOST and SLATEMATCH_MAIL_FROM). "
                  "Recorded in the outbox; nothing was sent.")
        oid = repo.add_outbox(to_addr, subject, body, kind, ref_id or "",
                              "recorded_not_sent", detail, _now())
        repo.audit(actor, "mail_recorded", "outbox", str(oid),
                   {"to": to_addr, "kind": kind, "ref": ref_id or ""}, _now())
        return {"id": oid, "to": to_addr, "subject": subject, "kind": kind,
                "ref_id": ref_id or "", "status": "recorded_not_sent",
                "detail": detail, "configured": False}
    msg = EmailMessage()
    msg["From"] = cfg["from"]
    msg["To"] = to_addr
    msg["Subject"] = subject
    msg.set_content(body)
    try:
        with smtplib.SMTP(cfg["host"], cfg["port"], timeout=20) as s:
            if cfg["tls"]:
                s.starttls(context=ssl.create_default_context())
            if cfg["user"]:
                s.login(cfg["user"], cfg["password"])
            s.send_message(msg)
        detail = f"Accepted by SMTP server {cfg['host']}"
        status = "sent"
    except Exception as e:
        detail = f"{type(e).__name__}: {str(e)[:240]}"
        status = "failed"
    oid = repo.add_outbox(to_addr, subject, body, kind, ref_id or "",
                          status, detail, _now())
    repo.audit(actor, "mail_" + status, "outbox", str(oid),
               {"to": to_addr, "kind": kind, "ref": ref_id or ""}, _now())
    return {"id": oid, "to": to_addr, "subject": subject, "kind": kind,
            "ref_id": ref_id or "", "status": status, "detail": detail,
            "configured": True}
