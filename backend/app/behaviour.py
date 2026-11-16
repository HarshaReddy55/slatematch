"""Payer behaviour profiles: what the workspace's own decided
history says about how each payer pays.

Computed on read from stored match and exception records - no new
tracking, no invented signals. The profile's engine-facing roles
are deliberately narrow, under the product's design rule (learning
proposes, math decides): it annotates NO_MATCH and residual
exceptions with the payer's history so triage starts from evidence,
and it is published as an analytics surface. It never changes a
posting decision: candidate resolution, the solver and the policy
engine read none of it.
"""


def _key(name):
    return (name or "").strip().lower()


def build_profiles(repo):
    """One profile per payer seen in any match record, plus their
    duplicate count from the exception log."""
    acc = {}
    for m in repo.all_matches():
        res = m.get("result") or {}
        pay = res.get("payment") or {}
        raw = pay.get("payer_raw") or ""
        k = _key(raw)
        if not k:
            continue
        p = acc.setdefault(k, {"payer": raw, "payments": 0, "posted": 0,
                               "auto_posted": 0, "with_lines": 0,
                               "lines_total": 0, "partials": 0,
                               "deductions": 0, "claimed_cents": 0,
                               "amount_cents": 0, "duplicates": 0,
                               "rungs": {}})
        p["payments"] += 1
        p["amount_cents"] += pay.get("amount_cents") or 0
        lines = res.get("lines") or []
        if lines:
            p["with_lines"] += 1
            p["lines_total"] += len(lines)
        if m["status"] in ("AUTO_POSTED", "APPROVED_POSTED"):
            p["posted"] += 1
            if m["status"] == "AUTO_POSTED":
                p["auto_posted"] += 1
            residual = res.get("residual_cents")
            if residual is None:
                residual = ((res.get("derivation") or {}).get("equation") or {}).get("residual_cents") or 0
            if residual < 0:
                p["partials"] += 1
        ded = res.get("deduction") or {}
        if ded.get("claimed_cents"):
            p["deductions"] += 1
            p["claimed_cents"] += ded.get("claimed_cents") or 0
        rung = res.get("matched_by")
        if rung:
            p["rungs"][rung] = p["rungs"].get(rung, 0) + 1
    pays = {p.payment_id: p for p in repo.all_payments()}
    seen_runs = set()
    for run in repo.list_runs(200):
        seen_runs.add(run["run_id"])
        for e in repo.exceptions_for_run(run["run_id"]):
            if e.get("kind") != "DUPLICATE_PAYMENT":
                continue
            pay = pays.get(e.get("payment_id"))
            if pay and _key(pay.payer_raw) in acc:
                acc[_key(pay.payer_raw)]["duplicates"] += 1
    out = []
    for p in acc.values():
        n = p["payments"]
        posted = p["posted"]
        top_rung = max(p["rungs"].items(), key=lambda kv: kv[1])[0] if p["rungs"] else None
        out.append({
            "payer": p["payer"], "payments": n, "posted": posted,
            "auto_posted_share": round(p["auto_posted"] / n, 3) if n else 0,
            "avg_bundle_size": round(p["lines_total"] / p["with_lines"], 2) if p["with_lines"] else 0,
            "typical_bundle": int(round(p["lines_total"] / p["with_lines"])) if p["with_lines"] else 0,
            "partial_share": round(p["partials"] / posted, 3) if posted else 0,
            "deduction_share": round(p["deductions"] / n, 3) if n else 0,
            "avg_payment_cents": int(p["amount_cents"] / n) if n else 0,
            "duplicates": p["duplicates"], "top_rung": top_rung,
            "basis": "this workspace's stored match and exception records only",
        })
    out.sort(key=lambda p: -p["payments"])
    return out


def hint_for(payer_raw, profiles):
    """A triage hint for an unmatched wire from a known payer, or
    None. Only payers with at least two decided payments have a
    pattern worth quoting; a first-time payer gets no hint rather
    than a fabricated one."""
    k = _key(payer_raw)
    for p in profiles:
        if _key(p["payer"]) != k:
            continue
        if p["payments"] < 2:
            return None
        bundle = (f"typically {p['typical_bundle']} invoice(s) per payment"
                  if p["typical_bundle"] else "no settled bundle pattern yet")
        return (f"Payer history in this workspace: {p['payments']} payments seen, "
                f"{int(p['auto_posted_share'] * 100)}% posted without a human touch, "
                f"{bundle}, averaging ${p['avg_payment_cents'] / 100:,.2f}. "
                "When this payer's wire does not match, the usual cause is a "
                "missing or mistyped remittance reference - check the wire text "
                "against the open ledger before reassigning.")
    return None
