"""The audit and SAP clearing bundle as a clean, print-ready PDF.

Renders the same bundle dict the JSON export returns (api._bundle_for)
into an organised document a controller can read and file: run summary,
model metrics, every match, the SAP clearing documents with their
journal lines, the exceptions, and the audit trail with each entry's
SHA-256 content fingerprint.
"""
from fpdf import FPDF


def _s(x):
    """Latin-1 safe text for the core PDF fonts."""
    return str(x if x is not None else "-").encode("latin-1", "replace").decode("latin-1")


def money(cents):
    if cents is None:
        return "-"
    cents = int(cents)
    sign = "-" if cents < 0 else ""
    return f"{sign}${abs(cents) / 100:,.2f}"


def _nat(pid):
    s = str(pid)
    num = "".join(ch for ch in s if ch.isdigit())
    return (s.rstrip("0123456789"), int(num) if num else 0)


class _Bundle(FPDF):
    def footer(self):
        self.set_y(-12)
        self.set_font("helvetica", "I", 7.5)
        self.set_text_color(120, 120, 120)
        self.cell(0, 8, _s(f"SlateMatch - Audit & SAP Clearing Bundle - page {self.page_no()} of {{nb}}"), align="C")


def _section(pdf, title):
    if pdf.get_y() > pdf.page_break_trigger - 42:
        pdf.add_page()
    pdf.ln(4)
    pdf.set_font("helvetica", "B", 12)
    pdf.set_fill_color(35, 35, 35)
    pdf.set_text_color(255, 255, 255)
    pdf.cell(0, 8, "  " + _s(title), new_x="LMARGIN", new_y="NEXT", fill=True)
    pdf.set_text_color(20, 20, 20)
    pdf.ln(2)


def _kv(pdf, pairs):
    pdf.set_font("helvetica", "", 9.5)
    for k, v in pairs:
        pdf.set_font("helvetica", "B", 9.5)
        pdf.cell(52, 5.6, _s(k), new_x="RIGHT")
        pdf.set_font("helvetica", "", 9.5)
        pdf.multi_cell(0, 5.6, _s(v), new_x="LMARGIN", new_y="NEXT")


def _table(pdf, headers, rows, widths, aligns=None):
    pdf.set_font("helvetica", "", 8.6)
    pdf.set_fill_color(255, 255, 255)
    pdf.set_text_color(20, 20, 20)
    pdf.set_draw_color(150, 150, 150)
    from fpdf.fonts import FontFace
    with pdf.table(col_widths=widths, first_row_as_headings=True,
                   line_height=5.2, text_align=aligns or "LEFT",
                   cell_fill_color=(255, 255, 255),
                   headings_style=FontFace(emphasis="BOLD", size_pt=8.6, fill_color=(228, 228, 228))) as table:
        for data in [headers] + rows:
            row = table.row()
            for cell in data:
                row.cell(_s(cell))


def render_bundle_pdf(bundle):
    pdf = _Bundle(orientation="P", unit="mm", format="A4")
    pdf.set_margins(14, 14, 14)
    pdf.set_auto_page_break(True, margin=16)
    pdf.add_page()

    run = bundle.get("run") or {}
    matches = bundle.get("matches") or []
    ws = bundle.get("workspace") or {}
    case = bundle.get("case") or {}
    metrics = bundle.get("model_metrics") or {}

    pdf.set_font("helvetica", "B", 20)
    pdf.cell(0, 10, "SlateMatch", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("helvetica", "B", 13)
    pdf.cell(0, 7, "Audit & SAP Clearing Bundle", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("helvetica", "", 9.5)
    pdf.cell(0, 6, _s(f"Generated {bundle.get('generated_at', '')} - tenant {bundle.get('tenant', '')}"), new_x="LMARGIN", new_y="NEXT")

    total_value = sum(int((m.get("result") or {}).get("payment", {}).get("amount_cents") or 0) for m in matches)
    auto_value = sum(int((m.get("result") or {}).get("payment", {}).get("amount_cents") or 0)
                     for m in matches if m.get("status") == "AUTO_POSTED")
    _section(pdf, "1. Run summary")
    _kv(pdf, [
        ("Case", case.get("name") or "Workspace data (no named case)"),
        ("Run ID", run.get("run_id")),
        ("Run status", run.get("status")),
        ("Run window (UTC)", f"{run.get('created_at', '')} to {run.get('finished_at', '')}"),
        ("Payments processed", run.get("payments")),
        ("Matches decided", run.get("matches")),
        ("Auto-posted", f"{run.get('auto_posted')} ({money(auto_value)} of {money(total_value)} matched value)"),
        ("Exceptions raised", run.get("exceptions")),
        ("Open invoices now", ws.get("open_invoices")),
        ("Approvals pending", ws.get("approvals_pending")),
    ])

    _section(pdf, "2. Model metrics (as reported by the product)")
    _kv(pdf, [
        ("Payment-delay MAE", f"{metrics.get('delay_mae_days')} days (naive baseline {metrics.get('delay_baseline_mae_days')} days)"),
        ("Deduction validity AUC", metrics.get("validity_auc")),
        ("Training / test rows", f"{metrics.get('train_rows')} / {metrics.get('test_rows')}"),
        ("Data basis", metrics.get("data_basis")),
    ])

    _section(pdf, "3. Matches")
    if matches:
        rows = []
        for m in sorted(matches, key=lambda x: _nat(x.get("payment_id"))):
            res = m.get("result") or {}
            pay = res.get("payment") or {}
            invoices = ", ".join(l.get("invoice_id", "") for l in res.get("lines") or []) or "-"
            rows.append([m.get("payment_id"), pay.get("payer_raw") or "-",
                         money(pay.get("amount_cents")), m.get("status"),
                         f"{m.get('confidence')}", invoices, money(m.get("residual_cents"))])
        _table(pdf, ["Payment", "Payer", "Amount", "Status", "Conf.", "Invoices applied", "Residual"],
               rows, (12, 34, 20, 26, 12, 48, 30),
               aligns=("LEFT", "LEFT", "RIGHT", "LEFT", "CENTER", "LEFT", "RIGHT"))
    else:
        pdf.set_font("helvetica", "", 9.5)
        pdf.cell(0, 6, "No matches on this run.", new_x="LMARGIN", new_y="NEXT")

    _section(pdf, "4. SAP clearing documents")
    docs = bundle.get("sap_documents") or {}
    if docs:
        for pid in sorted(docs, key=_nat):
            doc = docs[pid] or {}
            # Keep each document together: header, balance line and its
            # journal table never split across a page break.
            needed = 6.2 + 5.6 + 5.2 + 5.2 * len(doc.get("journal") or []) + 2
            if pdf.get_y() + needed > pdf.page_break_trigger:
                pdf.add_page()
            number = doc.get("document_number") or "preview - number issued on approval"
            pdf.set_font("helvetica", "B", 10)
            pdf.multi_cell(0, 6.2, _s(f"{pid} - document type {doc.get('document_type')} - {number}"),
                           new_x="LMARGIN", new_y="NEXT")
            pdf.set_font("helvetica", "", 9.5)
            pdf.cell(0, 5.6, _s(f"Balanced: {'YES' if doc.get('balanced') else 'NO'} - "
                                f"total debits {money(doc.get('total_debits_cents'))} = "
                                f"total credits {money(doc.get('total_credits_cents'))}"),
                     new_x="LMARGIN", new_y="NEXT")
            rows = [[l.get("gl_account"), l.get("account"), money(l.get("debit_cents")) if l.get("debit_cents") else "",
                     money(l.get("credit_cents")) if l.get("credit_cents") else ""]
                    for l in doc.get("journal") or []]
            _table(pdf, ["GL account", "Account", "Debit", "Credit"], rows, (22, 92, 34, 34),
                   aligns=("LEFT", "LEFT", "RIGHT", "RIGHT"))
            pdf.ln(2)
    else:
        pdf.set_font("helvetica", "", 9.5)
        pdf.cell(0, 6, "No clearing documents on this run.", new_x="LMARGIN", new_y="NEXT")

    _section(pdf, "5. Exceptions")
    exceptions = bundle.get("exceptions") or []
    if exceptions:
        rows = [[e.get("payment_id"), e.get("kind"), e.get("severity"),
                 e.get("recommended_action") or "-", e.get("status")] for e in exceptions]
        _table(pdf, ["Payment", "Kind", "Severity", "Recommended action", "Status"],
               rows, (18, 38, 18, 82, 26))
    else:
        pdf.set_font("helvetica", "", 9.5)
        pdf.cell(0, 6, "No exceptions on this run.", new_x="LMARGIN", new_y="NEXT")

    _section(pdf, "6. Audit trail")
    trail = bundle.get("audit_trail") or []
    if trail:
        rows = []
        for e in trail:
            payload = e.get("payload") or {}
            details = ", ".join(f"{k}={v}" for k, v in list(payload.items())[:4])[:70] or "-"
            fp = (e.get("fingerprint") or "")[:12] or "-"
            when = str(e.get("created_at") or "")[5:16].replace("T", " ")
            rows.append([when, e.get("actor"), e.get("action"), e.get("entity_id") or e.get("entity"), details, fp])
        _table(pdf, ["Time (UTC)", "Actor", "Action", "Entity", "Details", "SHA-256"],
               rows, (24, 24, 32, 32, 42, 28))
    else:
        pdf.set_font("helvetica", "", 9.5)
        pdf.cell(0, 6, "No audit entries.", new_x="LMARGIN", new_y="NEXT")

    _section(pdf, "Notes")
    pdf.set_font("helvetica", "", 9)
    for note in [
        "The SAP documents in this bundle are posting packs in SAP BAPI_ACC_DOCUMENT_POST shape. No ERP is connected; a document marked preview receives its number when the match is approved.",
        "Every figure in this bundle is computed from the workspace's stored records at generation time. The same data is available as raw JSON from the bundle endpoint.",
        "Deduction win probabilities are stated heuristics (0.94 with a verified clean proof of delivery, 0.35 otherwise) and are labelled as such in the product; they are not trained probabilities.",
        "Audit entries written before content fingerprinting was introduced show '-' in the SHA-256 column.",
    ]:
        pdf.multi_cell(0, 5, "- " + _s(note), new_x="LMARGIN", new_y="NEXT")
        pdf.ln(0.6)

    return bytes(pdf.output())
