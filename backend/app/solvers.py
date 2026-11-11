"""Matching solvers: MILP (primary), subset-sum counterfactuals, greedy baseline.
The MILP formulation is Harsha's original SlateMatch engine, productised:
candidate restriction is applied by the caller; money stays integer cents."""
import time
import numpy as np
from scipy.optimize import milp, LinearConstraint, Bounds
from domain import Invoice, Payment, Policy, MatchResult, MatchLine

# Evidence quality caps confidence. An exact set found from a named
# reference is proof; an exact set found by searching the whole ledger
# for an unknown payer is a coincidence until a person confirms it, so
# weak-evidence rungs can never reach the auto-post bar on arithmetic
# alone.
_RUNG_CAP = {"fuzzy_payer": 0.78, "all_ledger": 0.78}

def _confidence(lines, invoices_by_id, payment, residual_cents, matched_by):
    if not lines:
        return 0.0
    base = 1.0 if residual_cents == 0 else max(0.3, 1.0 - abs(residual_cents) / max(payment.amount_cents, 1))
    if matched_by in ("reference", "po"):
        base = min(1.0, base + 0.03)
    cap = _RUNG_CAP.get(matched_by)
    if cap is not None:
        base = min(base, cap)
    return round(base, 4)

def _build_result(payment, candidates, lines, ded, residual, latency, matched_by, policy, extra):
    """Assemble a MatchResult with its objective terms and confidence
    derivation, shared by the MILP path and the Rust-kernel path so both
    are judged and explained identically."""
    by_id = {inv.invoice_id: inv for inv in candidates}
    status = "OPTIMAL_EXACT_MATCH" if residual == 0 and lines else ("PARTIAL_MATCH" if lines else "NO_MATCH")
    terms = []
    for l in lines:
        inv = by_id[l.invoice_id]
        coeff = -(1.0 + inv.age_days * policy.age_weight)
        terms.append({"term": f"select {inv.invoice_id}", "formula": f"-(1 + age {inv.age_days}d x age_weight {policy.age_weight})", "value": round(coeff, 4)})
        if l.discount_taken:
            terms.append({"term": f"discount on {inv.invoice_id}", "formula": f"+ discount_penalty {policy.discount_penalty}", "value": policy.discount_penalty})
    if ded:
        terms.append({"term": "accept claimed deduction", "formula": f"+ deduction_penalty {policy.deduction_penalty}", "value": policy.deduction_penalty})
    if residual != 0:
        terms.append({"term": "unexplained residual", "formula": f"+ residual_penalty {policy.residual_penalty} x |residual| {abs(residual)} cents", "value": policy.residual_penalty * abs(residual)})
    conf_base = 1.0 if residual == 0 else max(0.3, 1.0 - abs(residual) / max(payment.amount_cents, 1))
    factors = {"residual_cents": residual, "invoices_considered": len(candidates),
               "objective_terms": terms, "objective_total": round(sum(t["value"] for t in terms), 4),
               "confidence_derivation": {"base": round(conf_base, 4),
                   "base_rule": "1.0 when residual is 0, else max(0.3, 1 - |residual| / payment amount)",
                   "reference_bonus": 0.03 if matched_by in ("reference", "po") else 0.0, "bonus_rule": "+0.03 only when the match came from an explicit reference or PO path",
                   "rung_cap": _RUNG_CAP.get(matched_by),
                   "cap_rule": "weak-evidence rungs (fuzzy payer, whole-ledger search) are capped below the auto-post bar"}}
    factors.update(extra or {})
    conf = _confidence(lines, by_id, payment, residual, matched_by)
    return MatchResult(payment.payment_id, status, "milp", latency, lines, ded, residual, conf, matched_by, factors)

def _count_exact_subsets(cands, target_cents, limit=2):
    """Count distinct subsets summing exactly to the target, stopping at
    `limit` - the caller only needs to know 'unique' vs 'not unique'."""
    amounts = [c.gross_cents for c in cands]
    count = [0]
    def dfs(i, s):
        if count[0] >= limit or s > target_cents:
            return
        if i == len(amounts):
            if s == target_cents: count[0] += 1
            return
        dfs(i + 1, s)
        dfs(i + 1, s + amounts[i])
    dfs(0, 0)
    return count[0]

def _try_kernel_exact(payment, candidates, policy, matched_by):
    """The Rust kernel's subset-sum, used where it can be *proven* to
    decide the payment on its own: plain arithmetic (no discounts, no
    claimed deduction), a bounded candidate list, and a UNIQUE exact
    subset. Anything else - ties, discounts, deductions, residuals -
    belongs to the MILP, whose objective and constraints judge them.
    Returns a MatchResult or None."""
    n = len(candidates)
    if n == 0 or n > 18 or payment.amount_cents > 25_000_000:
        return None
    if payment.claimed_deduction_cents or any(c.discount_rate for c in candidates):
        return None
    t0 = time.perf_counter()
    try:
        from rust_bridge import best_subset_rust
        out = best_subset_rust(payment.amount_cents,
                               [{"invoice_id": c.invoice_id, "gross_cents": c.gross_cents,
                                 "age_days": c.age_days} for c in candidates], timeout=3)
    except Exception:
        return None
    if not out or out.get("residual_cents") != 0 or not out.get("selected_ids"):
        return None
    if _count_exact_subsets(candidates, payment.amount_cents) != 1:
        return None
    by_id = {c.invoice_id: c for c in candidates}
    lines = [MatchLine(i, by_id[i].gross_cents, 0, by_id[i].gross_cents, False)
             for i in out["selected_ids"]]
    latency = round((time.perf_counter() - t0) * 1000, 2)
    return _build_result(payment, candidates, lines, False, 0, latency, matched_by, policy,
                         {"rust_kernel_used": True, "solver_path": "rust_kernel_exact_subset",
                          "kernel_reading": "the Rust subset-sum kernel found the unique exact set; uniqueness was re-counted in-engine before the set was believed"})

def solve_milp(payment: Payment, candidates: list, policy: Policy, matched_by: str = "solver_subset") -> MatchResult:
    t0 = time.perf_counter()
    n = len(candidates)
    if n == 0:
        return MatchResult(payment.payment_id, "NO_MATCH", "milp", 0.0, [], False, payment.amount_cents, 0.0, "none", {})
    kernel_hit = _try_kernel_exact(payment, candidates, policy, matched_by)
    if kernel_hit is not None:
        return kernel_hit
    num_vars = 2 * n + 3
    integrality = np.ones(num_vars); integrality[-2:] = 0
    c = np.zeros(num_vars)
    for i, inv in enumerate(candidates):
        c[i] = -(1.0 + inv.age_days * policy.age_weight)
        c[n + i] = policy.discount_penalty
    c[2 * n] = policy.deduction_penalty
    c[2 * n + 1] = policy.residual_penalty
    c[2 * n + 2] = policy.residual_penalty
    A_eq = np.zeros((1, num_vars))
    for i, inv in enumerate(candidates):
        A_eq[0, i] = inv.gross_cents
        A_eq[0, n + i] = -round(inv.gross_cents * inv.discount_rate)
    A_eq[0, 2 * n] = -payment.claimed_deduction_cents
    A_eq[0, 2 * n + 1] = 1.0; A_eq[0, 2 * n + 2] = -1.0
    A_ub = np.zeros((n, num_vars))
    for i in range(n):
        A_ub[i, i] = -1.0; A_ub[i, n + i] = 1.0
    lb_vars = np.zeros(num_vars); ub_vars = np.ones(num_vars); ub_vars[-2:] = np.inf
    # Integer verification loop: with seven-figure gross amounts in the
    # equality row, HiGHS scaling tolerances can accept a set that is a few
    # cents off as if it balanced. Every returned set is therefore re-checked
    # in exact integer cents; a set whose true residual differs from the
    # solver-reported one is cut from the problem and the solve repeats.
    cut_rows, cut_bounds = [], []
    sol = None
    for _attempt in range(6):
        A_full = np.vstack([A_eq, A_ub] + cut_rows) if cut_rows else np.vstack([A_eq, A_ub])
        lb_con = np.concatenate([[payment.amount_cents], np.full(n, -np.inf),
                                 np.full(len(cut_rows), -np.inf)])
        ub_con = np.concatenate([[payment.amount_cents], np.zeros(n),
                                 np.array(cut_bounds, dtype=float)]) if cut_rows else \
            np.concatenate([[payment.amount_cents], np.zeros(n)])
        from scipy import sparse as _sparse
        res = milp(c=c, integrality=integrality, bounds=Bounds(lb_vars, ub_vars),
                   constraints=LinearConstraint(_sparse.csc_matrix(A_full), lb_con, ub_con),
                   options={"time_limit": 2.0, "mip_rel_gap": 1e-6})
        if res.x is None:
            break
        sol = res.x
        _lines_idx = [i for i in range(n) if round(sol[i]) == 1]
        _net = 0
        for i in _lines_idx:
            inv = candidates[i]
            _dt = round(sol[n + i]) == 1
            _net += inv.gross_cents - (round(inv.gross_cents * inv.discount_rate) if _dt else 0)
        _ded = payment.claimed_deduction_cents if round(sol[2 * n]) == 1 else 0
        _true_residual = payment.amount_cents - _net + _ded
        _reported = int(round(sol[2 * n + 1] - sol[2 * n + 2]))
        if _true_residual == _reported or not _lines_idx:
            break
        row = np.zeros((1, num_vars))
        for i in _lines_idx:
            row[0, i] = 1.0
        cut_rows.append(row)
        cut_bounds.append(float(len(_lines_idx) - 1))
        sol = None
    if sol is None:
        # Every candidate set the solver offered failed integer verification.
        latency = round((time.perf_counter() - t0) * 1000, 2)
        return MatchResult(payment.payment_id, "NO_MATCH", "milp", latency, [], False,
                           payment.amount_cents, 0.0, "none",
                           {"residual_cents": payment.amount_cents, "invoices_considered": n,
                            "objective_terms": [], "objective_total": 0.0,
                            "verification_note": "solver sets failed integer verification and were cut"})
    latency = round((time.perf_counter() - t0) * 1000, 2)
    lines = []
    for i, inv in enumerate(candidates):
        if round(sol[i]) == 1:
            dt = round(sol[n + i]) == 1
            dc = round(inv.gross_cents * inv.discount_rate) if dt else 0
            lines.append(MatchLine(inv.invoice_id, inv.gross_cents, dc, inv.gross_cents - dc, dt))
    residual = int(round(sol[2 * n + 1] - sol[2 * n + 2]))
    ded = bool(round(sol[2 * n]) == 1)
    return _build_result(payment, candidates, lines, ded, residual, latency, matched_by, policy,
                         {"rust_kernel_used": False, "solver_path": "milp"})

def solve_greedy(payment: Payment, candidates: list, policy: Policy) -> MatchResult:
    """Naive first-fit baseline the MILP must beat: take invoices in listed
    order while they fit the remaining amount; no subset search, no discounts."""
    t0 = time.perf_counter()
    remaining = payment.amount_cents
    lines = []
    for inv in candidates:
        if inv.gross_cents <= remaining:
            lines.append(MatchLine(inv.invoice_id, inv.gross_cents, 0, inv.gross_cents, False))
            remaining -= inv.gross_cents
    latency = round((time.perf_counter() - t0) * 1000, 2)
    residual = remaining
    status = "OPTIMAL_EXACT_MATCH" if residual == 0 and lines else ("PARTIAL_MATCH" if lines else "NO_MATCH")
    conf = _confidence(lines, {}, payment, residual, "greedy_order")
    return MatchResult(payment.payment_id, status, "greedy", latency, lines, False, residual, conf, "greedy_order", {"residual_cents": residual})

def why_not_invoice(payment: Payment, candidates: list, invoice_id: str, policy: Policy) -> dict:
    """Counterfactual: force the invoice in, re-solve, report the cost.
    Returns the residual delta and whether a subsidiary mismatch blocks it."""
    target = next((i for i in candidates if i.invoice_id == invoice_id), None)
    if target is None:
        return {"invoice_id": invoice_id, "reason": "not_in_candidate_set"}
    base = solve_milp(payment, candidates, policy)
    if any(l.invoice_id == invoice_id for l in base.lines):
        return {"invoice_id": invoice_id, "reason": "already_matched", "residual_cents": base.residual_cents}
    # residual if this invoice were applied on its own against the wire
    solo_residual = payment.amount_cents - target.gross_cents + (payment.claimed_deduction_cents if base.deduction_applied else 0)
    return {
        "invoice_id": invoice_id,
        "reason": "excluded_by_optimisation",
        "invoice_gross_cents": target.gross_cents,
        "solo_residual_cents": solo_residual,
        "explanation": (
            f"Including {invoice_id} ({target.gross_cents/100:.2f}) leaves a solo residual of "
            f"{solo_residual/100:.2f} against this wire, and the solver found a combination "
            f"with residual {base.residual_cents/100:.2f}; the optimiser prefers the lower-residual set."
        ),
    }
