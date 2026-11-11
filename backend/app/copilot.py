"""Grounded copilot: answers only from product records, with citations.
Actions are typed tools requiring confirmation; nothing executes silently.

The copilot reads the same records the UI shows - the latest run's matches
(with their stored decision reasons and reasoning trails), its exceptions,
the open ledger, and the labelled evaluations - and refuses anything those
records cannot answer. Payment ids are matched flexibly: a question may
use the full id (S7-P1) or the short form (P1) as long as it resolves to
exactly one payment in the run."""
import re


def _usd(cents):
    c = cents or 0
    return f"-${abs(c) / 100:,.2f}" if c < 0 else f"${c / 100:,.2f}"


def _latest_run(repo):
    rows = repo.list_runs(1)
    return rows[0] if rows else None


def _find_id(question, ids):
    """Resolve a payment id mentioned in the question. Longest known id
    contained in the text wins; otherwise a short token (P6) resolves when
    exactly one known id carries it as its suffix."""
    q = question.upper()
    hits = [i for i in ids if i.upper() in q]
    if hits:
        return max(hits, key=len)
    m = re.search(r"\b([A-Z]{0,3}\d+)\b", q)
    if m:
        tok = m.group(1)
        suffix = [i for i in ids if i.upper().split("-")[-1] == tok or i.upper() == tok]
        if len(suffix) == 1:
            return suffix[0]
    return None


def _accuracy():
    """MILP vs greedy on the labelled seed ground truth - the same numbers
    the Evaluations page shows, recomputed from the solvers themselves."""
    from seed import seed_invoices, seed_payments, GROUND_TRUTH
    from batch import resolve_candidates
    from solvers import solve_milp, solve_greedy
    from domain import Policy
    invs = seed_invoices()
    pays = {p.payment_id: p for p in seed_payments()}
    mc = gc = exact = 0
    for pid, truth in GROUND_TRUTH.items():
        pay = pays[pid]
        cands, _ = resolve_candidates(pay, invs, {})
        m = solve_milp(pay, cands, Policy())
        g = solve_greedy(pay, cands, Policy())
        mc += ({l.invoice_id for l in m.lines} == truth)
        gc += ({l.invoice_id for l in g.lines} == truth)
        exact += (m.residual_cents == 0)
    n = max(len(GROUND_TRUTH), 1)
    return {"milp": mc / n, "greedy": gc / n, "exact": exact / n, "n": len(GROUND_TRUTH)}


def answer(repo, question, delay_model=None):
    q = question.lower()
    run = _latest_run(repo)
    run_id = run["run_id"] if run else None
    matches = repo.matches_for_run(run_id) if run_id else []
    exceptions = repo.exceptions_for_run(run_id) if run_id else []
    by_id = {m["payment_id"]: m for m in matches}
    ex_by_id = {e["payment_id"]: e for e in exceptions}
    pid = _find_id(question, list(by_id) + list(ex_by_id))

    # --- workspace summary: answerable with or without a run ---
    if any(k in q for k in ("what case", "what is loaded", "what's loaded", "in this workspace",
                            "what is in", "workspace summary", "summarise the workspace",
                            "summarize the workspace", "what data")):
        case = repo.get_meta("active_case") or {}
        invs = repo.open_invoices()
        staged = repo.pending_payments()
        total = sum(i.gross_cents for i in invs)
        overdue = sum(i.gross_cents for i in invs if i.due_in_days < 0)
        name = case.get("name") or case.get("id") or "no case loaded"
        return {"answer": f"Workspace: {name}. {len(invs)} open invoices totalling {_usd(total)} "
                          f"({_usd(overdue)} of it overdue), {len(staged)} payment(s) staged and not yet run."
                          + (f" Latest run {run_id}: {run.get('payments', 0)} payments, {run.get('auto_posted', 0)} auto-posted."
                             if run else " No run yet - load a case and run a batch."),
                "citations": ["workspace:case"] + ([f"run:{run_id}"] if run_id else []), "action": None}

    # --- solver accuracy: answerable any time ---
    if ("solver" in q or "greedy" in q or "milp" in q) and any(
            k in q for k in ("accurate", "accuracy", "better", "compare", "best")):
        a = _accuracy()
        return {"answer": f"On the {a['n']} labelled test payments (the demo case's marked answers), the MILP solver "
                          f"is right {a['milp'] * 100:.0f}% of the time and leaves $0.00 unexplained "
                          f"{a['exact'] * 100:.0f}% of the time. The greedy first-fit baseline is right "
                          f"{a['greedy'] * 100:.0f}% of the time. That gap is why this product's matching uses MILP.",
                "citations": ["evaluations:seed-ground-truth"], "action": None}

    # --- overdue / late payers from the open ledger (no run needed) ---
    if "overdue" in q or "late" in q:
        invs = [i for i in repo.open_invoices() if i.due_in_days < 0]
        invs.sort(key=lambda i: -i.gross_cents)
        if invs:
            parts = "; ".join(f"{i.invoice_id} ({i.customer}) {_usd(i.gross_cents)}, {-i.due_in_days} days overdue"
                              for i in invs[:4])
            return {"answer": f"{len(invs)} invoice(s) are overdue in the open ledger, "
                              f"{_usd(sum(i.gross_cents for i in invs))} in total. Largest: {parts}.",
                    "citations": ["ledger:open-invoices"], "action": None}
        return {"answer": "Nothing in the open ledger is overdue right now.",
                "citations": ["ledger:open-invoices"], "action": None}

    if not run_id:
        return {"answer": "No reconciliation run exists yet. Load a case and run a batch first, then ask me about it - "
                          "or ask what is in this workspace.",
                "citations": [], "action": None}

    # --- per-payment questions ---
    if pid and ("why" in q or "held" in q or "not posted" in q or "not matched" in q or "unmatched" in q):
        m = by_id.get(pid)
        e = ex_by_id.get(pid)
        if "not matched" in q or "unmatched" in q:
            if m and m["status"] == "AUTO_POSTED":
                lines = ", ".join(l["invoice_id"] for l in (m["result"] or {}).get("lines", []))
                return {"answer": f"{pid} was matched - it auto-posted to {lines}. It is not in exceptions.",
                        "citations": [f"match:{pid}", f"run:{run_id}"], "action": None}
            if e:
                d = e.get("detail") or {}
                amt = f" of {_usd(d.get('amount_cents'))}" if d.get("amount_cents") else ""
                return {"answer": f"{pid}{amt} is in exceptions as {e['kind']}. Unexplained residual: "
                                  f"{_usd(d.get('residual_cents', 0))}. Recommended action: {e['recommended_action']}.",
                        "citations": [f"exception:{pid}:{e['kind']}", f"run:{run_id}"], "action": None}
        if m:
            r = m["result"] or {}
            lines = ", ".join(l["invoice_id"] for l in r.get("lines", [])) or "no invoices"
            reason = r.get("decision_reason") or ""
            steps = (r.get("reasoning") or {}).get("steps") or []
            proof = steps[2] if len(steps) > 2 else ""
            return {"answer": f"{pid}: decision {m['status']} - {reason} Matched invoices: {lines}. "
                              + (f"{proof}" if proof else ""),
                    "citations": [f"match:{pid}", f"run:{run_id}"], "action": None}
        if e:
            return {"answer": f"{pid} never reached matching: it is in exceptions as {e['kind']}. "
                              f"Recommended action: {e['recommended_action']}.",
                    "citations": [f"exception:{pid}:{e['kind']}", f"run:{run_id}"], "action": None}

    # --- unmatched, no specific payment ---
    if "not matched" in q or "unmatched" in q or "matched nothing" in q:
        ex = [e for e in exceptions if e["kind"] in ("NO_MATCH", "UNRESOLVED_RESIDUAL")]
        if ex:
            parts = "; ".join(f"{e['payment_id']} ({e['kind']}, residual {_usd((e.get('detail') or {}).get('residual_cents', 0))})"
                              for e in ex[:6])
            return {"answer": f"{len(ex)} payment(s) did not fully match in the latest run: {parts}.",
                    "citations": [f"run:{run_id}"] + [f"exception:{e['payment_id']}" for e in ex[:6]], "action": None}
        return {"answer": "Every payment in the latest run matched. There are no unmatched payments to explain.",
                "citations": [f"run:{run_id}"], "action": None}

    # --- held / approvals list ---
    # The queue is a LIVE state, not a run fact: decisions change it. Read
    # the same source the approvals endpoint serves (current PROPOSED
    # records), never the run snapshot - a decided match must disappear
    # from this answer the moment it leaves the queue.
    if "held" in q or "approval" in q or "approve" in q or "waiting" in q:
        held = repo.list_proposed()
        if held:
            parts = "; ".join(f"{m['payment_id']} ({(m.get('decision_reason') or 'held for review').split(' - ')[0]})"
                              for m in held[:6])
            return {"answer": f"{len(held)} match(es) are waiting on a person: {parts}. "
                              f"They sit in the approvals queue on the Run page.",
                    "citations": [f"run:{run_id}"] + [f"match:{m['payment_id']}" for m in held[:6]], "action": None}
        return {"answer": "Nothing is waiting on a person - the approvals queue is empty.",
                "citations": [f"run:{run_id}"], "action": None}

    # --- disputes and recovery ---
    disputes = []
    for m in matches:
        d = (m["result"] or {}).get("deduction") or {}
        if d.get("autonomous_action") == "AUTO_GENERATE_DISPUTE_CLAIM":
            disputes.append((m["payment_id"], d))
    if "dispute" in q or "recover" in q:
        if disputes:
            total = sum(float(d.get("expected_recovery_value_usd") or 0) for _, d in disputes)
            parts = "; ".join(f"{pid}: claim {_usd(d.get('claimed_cents', 0))}, win probability "
                              f"{d.get('win_probability', 'n/a')}, expected recovery "
                              f"${float(d.get('expected_recovery_value_usd') or 0):,.2f}" for pid, d in disputes[:5])
            return {"answer": f"{len(disputes)} dispute(s) open from the latest run, expected recovery "
                              f"${total:,.2f} in total. {parts}. Drafts are in the dispute desk on the Run page.",
                    "citations": [f"run:{run_id}"] + [f"match:{pid}" for pid, _ in disputes[:5]], "action": None}
        return {"answer": "No disputes were opened in the latest run - no deduction met the expected-value rule.",
                "citations": [f"run:{run_id}"], "action": None}

    # --- deductions list ---
    if "deduction" in q:
        deds = [(m["payment_id"], (m["result"] or {}).get("deduction")) for m in matches
                if (m["result"] or {}).get("deduction")]
        if deds:
            parts = "; ".join(f"{pid}: {_usd(d.get('claimed_cents', 0))} claimed, classified "
                              f"{(d.get('classification') or {}).get('label', '')} ({d.get('assigned_erp_reason_code', '')}), "
                              f"action {d.get('autonomous_action', '')}" for pid, d in deds[:6])
            return {"answer": f"{len(deds)} deduction(s) judged in the latest run: {parts}.",
                    "citations": [f"run:{run_id}"] + [f"match:{pid}" for pid, _ in deds[:6]], "action": None}
        return {"answer": "No payment in the latest run claimed a deduction.",
                "citations": [f"run:{run_id}"], "action": None}

    # --- exceptions list ---
    if "exception" in q:
        thr = re.search(r"above \$?([0-9,]+)", q)
        items = exceptions
        if thr:
            t = int(thr.group(1).replace(",", "")) * 100
            items = [e for e in items if abs((e.get("detail") or {}).get("residual_cents", 0)) >= t]
        if items:
            parts = "; ".join(f"{e['payment_id']} {e['kind']} ({e['severity']})" for e in items[:8])
            return {"answer": f"{len(items)} open exception(s) in the latest run: {parts}.",
                    "citations": [f"run:{run_id}"] + [f"exception:{e['payment_id']}" for e in items[:8]], "action": None}
        return {"answer": "No open exceptions in the latest run.",
                "citations": [f"run:{run_id}"], "action": None}

    # --- auto-posted cash ---
    if "cash" in q and ("auto" in q or "posted" in q or "applied" in q):
        posted = [m for m in matches if m["status"] in ("AUTO_POSTED", "APPROVED_POSTED")]
        cash = sum(sum(l.get("net_cents", 0) for l in (m["result"] or {}).get("lines", [])) for m in posted)
        return {"answer": f"Auto-posted cash in the latest run: {_usd(cash)}, across "
                          f"{len(posted)} payment(s) that posted with no human touch.",
                "citations": [f"run:{run_id}"] + [f"match:{m['payment_id']}" for m in posted[:6]], "action": None}

    # --- touchless ---
    if "touchless" in q or "automation" in q:
        auto = sum(1 for x in matches if x["status"] == "AUTO_POSTED")
        total = run.get("payments") or (len(matches) + sum(1 for e in exceptions if e["payment_id"] not in by_id))
        return {"answer": f"Touchless rate in the latest run: {auto} of {total} payments auto-posted "
                          f"({(auto / max(total, 1)) * 100:.1f}%). Counted over every payment in the run, "
                          f"including any the duplicate guard stopped before matching.",
                "citations": [f"run:{run_id}"], "action": None}

    # --- biggest payments ---
    if "biggest" in q or "largest" in q:
        def amt(m):
            eq = ((m["result"] or {}).get("derivation") or {}).get("equation") or {}
            return eq.get("payment_cents") or sum(l.get("net_cents", 0) for l in (m["result"] or {}).get("lines", []))
        top = sorted(matches, key=amt, reverse=True)[:3]
        parts = "; ".join(f"{m['payment_id']} {_usd(amt(m))} ({m['status']})" for m in top)
        return {"answer": f"Biggest payments in the latest run: {parts}.",
                "citations": [f"run:{run_id}"] + [f"match:{m['payment_id']}" for m in top], "action": None}

    # --- run action (typed tool, confirmation required) ---
    if "run" in q and ("solver" in q or "batch" in q or "reconciliation" in q):
        return {"answer": "I can start a batch reconciliation run. This is an action, so it needs your confirmation.",
                "citations": [], "action": {"tool": "run_batch", "requires_confirmation": True, "args": {}}}

    # --- grounded refusal: say what the records CAN answer right now ---
    can = ["the auto-posted cash", "the touchless rate", "the exceptions"]
    held = [m for m in matches if m["status"] != "AUTO_POSTED"
            and (m["result"] or {}).get("status") != "NO_MATCH"]
    if held:
        can.append(f"why {held[0]['payment_id']} was held")
    nm = [e for e in exceptions if e["kind"] == "NO_MATCH"]
    if nm:
        can.append(f"why {nm[0]['payment_id']} was not matched")
    if disputes:
        can.append("the open disputes and expected recovery")
    return {"answer": "The data in this workspace does not contain an answer to that. "
                      f"From the latest run I can answer about: {', '.join(can)} - and about any payment by its ID.",
            "citations": [f"run:{run_id}"], "action": None}
