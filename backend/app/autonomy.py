"""The autopilot: bounded autonomy over a run's leftovers, and its
reversal.

A run leaves three kinds of work behind: exceptions (duplicates,
unexplained wires), maker-checker holds, and PROPOSED partial
matches - a confident set of invoices the wire underpaid. The first
two are judgement calls and stay human at every autonomy level.
The third is arithmetic: when the shortfall is inside the tenant's
own tolerance, a human approval adds a click, not information.

Policy.autonomy_level gates the pass:
  0  off (default) - nothing in this module ever runs;
  1  assisted - shortfalls within tolerance_writeoff_cents;
  2  autonomous - shortfalls within autopilot_max_residual_cents.

A resolution is the same act as a human approval of that match -
same allocation machinery, same settlement primitives, an approval
record in the same shape - performed by role "autopilot", with the
invoices' pre-state snapshotted into the record first. That
snapshot is what makes every resolution reversible in one call:
restore the grosses, reopen the invoices, mark the match
REVERSED, audit both directions.
"""
import hashlib


def _residual_of(res):
    r = res.get("residual_cents")
    if r is None:
        r = ((res.get("derivation") or {}).get("equation") or {}).get("residual_cents") or 0
    return r


def autopilot_cap_cents(policy):
    if policy.autonomy_level == 1:
        return int(policy.tolerance_writeoff_cents)
    if policy.autonomy_level == 2:
        return int(policy.autopilot_max_residual_cents)
    return None


def eligibility(m, policy):
    """Why this PROPOSED match may be auto-resolved, or None. The
    checks are the safety case, in order: the level is on; the
    record is a real match (a refusal verdict has no lines and is
    never auto-approved - parking cash is a human decision); it is
    not a maker-checker hold; it is a shortfall, not an overpayment
    or an exact hold; the shortfall is inside the level's cap; and
    the solver's confidence clears the tenant's own automation
    threshold."""
    cap = autopilot_cap_cents(policy)
    if cap is None or m.get("status") != "PROPOSED":
        return None
    res = m.get("result") or {}
    lines = res.get("lines") or []
    if not lines:
        return None
    if (res.get("decision_reason") or "").startswith("Maker-checker"):
        return None
    # The maker-checker threshold is the tenant's own statement of
    # where a second person signs. It is written onto exact matches
    # as a hold reason, but a partial this size is PROPOSED anyway
    # and carries no such label - the boundary is the amount, so
    # the autopilot checks the amount itself.
    pay_amt = (res.get("payment") or {}).get("amount_cents") or 0
    if pay_amt > int(policy.maker_checker_threshold_cents):
        return None
    residual = _residual_of(res)
    if residual >= 0 or abs(residual) > cap:
        return None
    if (m.get("confidence") or 0) < policy.automation_threshold:
        return None
    return {"shortfall_cents": abs(residual), "cap_cents": cap,
            "level": policy.autonomy_level}


def run_autopilot(repo, run_id, policy, actor, now_iso):
    """Resolve every eligible PROPOSED match of one run. Called at
    the end of run-output composition, under the policy snapshot
    the run itself ran with. Returns what it did; at level 0 it is
    a no-op and the run record is untouched."""
    resolved = []
    if autopilot_cap_cents(policy) is None:
        return {"resolved": resolved}
    from batch import allocate_partial_payment
    from ai import amounts_for_refs
    for m in repo.matches_for_run(run_id):
        why = eligibility(m, policy)
        if why is None:
            continue
        res = m["result"]
        lines = res.get("lines") or []
        decided_at = now_iso()
        fingerprint = hashlib.sha256(
            f"{m['match_id']}|{m['payment_id']}|approve|autopilot|{decided_at}".encode()
        ).hexdigest()
        # Pre-state snapshot BEFORE anything moves: the reversal
        # restores exactly these grosses.
        pre_state = []
        for l in lines:
            row = repo.get_invoice_row(l["invoice_id"])
            if row:
                pre_state.append({"invoice_id": l["invoice_id"],
                                  "gross_cents": row["gross_cents"],
                                  "status": row["status"]})
        residual = _residual_of(res)
        total_net = sum(l.get("net_cents") or 0 for l in lines)
        applied_total = total_net + residual
        meta = {i.invoice_id: i for i in repo.all_invoices()}
        pay_rec = res.get("payment") or {}
        specified = (amounts_for_refs(pay_rec.get("remittance_text") or "",
                                      [l["invoice_id"] for l in lines])
                     if policy.partial_allocation_mode == "explicit_line" else {})
        allocs, mode_used, note = allocate_partial_payment(
            lines, applied_total, policy.partial_allocation_mode, meta, specified)
        settled, partials = [], []
        for l in lines:
            applied_i = allocs.get(l["invoice_id"], 0)
            if applied_i >= (l.get("gross_cents") or 0):
                settled.append(l["invoice_id"])
            else:
                partials.append({"invoice_id": l["invoice_id"],
                                 "applied_cents": applied_i,
                                 "remaining_cents": (l.get("gross_cents") or 0) - applied_i})
        res["approval"] = {
            "decision": "approve", "by_role": "autopilot", "at": decided_at,
            "fingerprint": fingerprint,
            "erp_document_id": "DZ-" + fingerprint[:10].upper(),
            "settled_invoices": settled, "partial_application": partials,
            "allocation_mode": mode_used, "allocation_note": note,
            "parked_in_suspense": False,
            "autopilot": {"level": why["level"], "cap_cents": why["cap_cents"],
                          "shortfall_cents": why["shortfall_cents"],
                          "rule": "proposed partial match, shortfall within the "
                                  "autonomy cap, confidence at or above the "
                                  "automation threshold, not a maker-checker hold"},
            "pre_state": pre_state}
        with repo.transaction():
            if not repo.update_match_if_proposed(m["match_id"], "APPROVED_POSTED", res):
                continue  # a human decided it first - their call stands
            if settled:
                repo.settle_invoices(settled)
            for pa in partials:
                repo.reduce_invoice_gross(pa["invoice_id"], pa["remaining_cents"])
            repo.audit(actor, "autopilot_resolve", "match", m["match_id"],
                       {"payment_id": m["payment_id"], **why,
                        "erp_document_id": res["approval"]["erp_document_id"]},
                       decided_at)
        resolved.append({"match_id": m["match_id"], "payment_id": m["payment_id"],
                         "shortfall_cents": why["shortfall_cents"]})
    return {"resolved": resolved}


def reverse_autopilot(repo, match_id, actor, now_iso):
    """Reverse one autopilot resolution from its recorded pre-state.
    Refuses, with the reason, when the match was not autopilot's,
    carries no snapshot, or a later posted decision has already
    built on one of its invoices (unwinding then would corrupt
    that decision's ledger)."""
    m = repo.get_match(match_id)
    if not m:
        raise ValueError("match not found")
    res = m.get("result") or {}
    approval = res.get("approval") or {}
    if m["status"] != "APPROVED_POSTED" or not approval.get("autopilot"):
        raise ValueError("only an autopilot resolution can be reversed this way")
    pre_state = approval.get("pre_state") or []
    if not pre_state:
        raise ValueError("this resolution carries no pre-state snapshot")
    touched = {p["invoice_id"] for p in pre_state}
    for other in repo.all_matches():
        if other["match_id"] == match_id or other["status"] not in ("AUTO_POSTED", "APPROVED_POSTED"):
            continue
        for l in (other.get("result") or {}).get("lines") or []:
            if l.get("invoice_id") in touched:
                raise ValueError(
                    f"invoice {l['invoice_id']} was used by a later posted "
                    "decision - reverse that one first")
    res["reversal"] = {"at": now_iso(), "by_role": actor,
                        "of": "autopilot resolution",
                        "restored_invoices": [p["invoice_id"] for p in pre_state]}
    with repo.transaction():
        if not repo.update_match_if_status(match_id, ["APPROVED_POSTED"], "REVERSED", res):
            raise ValueError("match changed while reversing - refresh and review")
        for p in pre_state:
            repo.restore_invoice(p["invoice_id"], p["gross_cents"])
        repo.audit(actor, "match_reversed", "match", match_id,
                   {"payment_id": m["payment_id"],
                    "restored": [p["invoice_id"] for p in pre_state]}, now_iso())
    return {"match_id": match_id, "status": "REVERSED",
            "restored_invoices": [p["invoice_id"] for p in pre_state]}
