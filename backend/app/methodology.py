"""Methodology: how every number in SlateMatch is computed.

This document is served by the API and rendered in the product, so the
explanation an interviewer reads is versioned with the code it describes.
Values in brackets are the shipped defaults from the Policy dataclass;
a tenant policy can change them, and each run records the policy it used.
"""

SECTIONS = [
    {
        "id": "milp",
        "title": "The matching optimiser (MILP)",
        "what": "For each payment, choose which open invoices it settles, whether each invoice's early-pay discount is taken, and whether the claimed deduction is accepted - so that the cash conservation equation holds exactly.",
        "formulae": [
            {"name": "Decision variables", "expr": "x_i in {0,1} select invoice i; d_i in {0,1} take its discount (d_i <= x_i); y in {0,1} accept the claimed deduction; r+ , r- >= 0 the residual split"},
            {"name": "Cash conservation (hard equality)", "expr": "SUM_i (gross_i * x_i - discount_amount_i * d_i) - claimed_deduction * y + r+ - r- = payment_amount"},
            {"name": "Objective (minimise)", "expr": "SUM_i [ -(1 + age_days_i * age_weight) * x_i ] + discount_penalty * SUM_i d_i + deduction_penalty * y + residual_penalty * (r+ + r-)"},
            {"name": "Why this shape", "expr": "The negative age term rewards settling older invoices first (FIFO). Penalties price the assumptions: taking a discount costs 50, accepting a deduction costs 10, and every unexplained residual cent costs 1,000,000 - so the solver would rather propose nothing than hide a discrepancy. Solved with scipy.optimize.milp (HiGHS); money is integer cents end to end, so results are exact, never rounded. A Rust subset-sum kernel runs inside the solve path for plain payments and decides only a provably unique exact set (at most 18 candidates); every set the MILP returns is re-verified in exact integer cents before it is believed - a set whose true residual differs is cut and the solve repeats, at most 6 attempts, before an honest no-match."},
        ],
        "meaning": "OPTIMAL_EXACT_MATCH means a set of invoices was found whose total, after discounts and the accepted deduction, equals the payment to the cent. A partial solution is held as PROPOSED for a person's approval: approving it applies only what was paid, and the unpaid remainder stays open on the invoice, collectable and inside the forecast. A wire nothing can explain becomes a NO_MATCH exception. A residual is never quietly absorbed.",
    },
    {
        "id": "candidates",
        "title": "Candidate resolution (what the solver is allowed to see)",
        "what": "Brute-forcing the whole ledger would be slow and wrong. Candidates narrow in a fixed order, and the path that produced them is recorded on every match as matched_by.",
        "formulae": [
            {"name": "Order", "expr": "Payments are processed in evidence order - strongest evidence first - and each payment's candidates narrow by rung: 0) explicit invoice references and purchase order references in the remittance -> 1) OCR-repaired references (confusion-table variants retried: 0/O, 1/I, 5/S, 8/B) -> 2) amount-plus-payer (an exact amount on the payer's own ledger; saved payer aliases resolve who the payer is) -> 3) fuzzy payer match, Jaro-Winkler at 0.88 or above, labelled fuzzy_payer -> 4) the customer's whole open ledger (all_ledger). Candidates are hard-filtered to the payment's own currency before any rung runs."},
            {"name": "Consumption", "expr": "An invoice matched inside a batch is removed from the candidate pool for the remaining payments in that batch, so one invoice can never settle two wires."},
            {"name": "Duplicate defence", "expr": "fingerprint = SHA-256(payer | amount | currency); a second payment with the same fingerprint in one batch is stopped as DUPLICATE_PAYMENT before matching."},
        ],
        "meaning": "matched_by records which rung found the match. Reference and PO matches rest on direct evidence from the remittance. Weaker rungs are capped (fuzzy_payer and all_ledger at 0.78), a second exact set for the same wire caps the match at 0.75 as an ambiguous tie, and any set spanning two customers is capped at 0.75 - so weak or ambiguous evidence can never auto-post, however exact its arithmetic. Every match carries the full worked calculation.",
    },
    {
        "id": "confidence",
        "title": "Confidence and the auto-post decision",
        "what": "Confidence is a deterministic function of the outcome, not a model score - so it can be recomputed by hand from the derivation on any match.",
        "formulae": [
            {"name": "Base", "expr": "confidence = 1.0 if residual = 0, else max(0.3, 1 - |residual| / payment_amount)"},
            {"name": "Bonus", "expr": "+0.03 (capped at 1.0) when the match was found on reference or PO evidence; the derivation stored on every match records the bonus actually applied"},
            {"name": "Auto-post rule", "expr": "auto-posted iff status = OPTIMAL_EXACT_MATCH and confidence >= policy.automation_threshold [0.90]. Two holds sit above the rule: an exact match over the maker-checker threshold [$100,000] is held PROPOSED for a second approver at any confidence, and the rung caps (0.78 / 0.75) keep weak-evidence or ambiguous matches below the bar by construction"},
        ],
        "meaning": "An exact match scores 1.0, so in practice the threshold separates exact matches (posted alone) from partial ones (a person reviews). The threshold is a policy setting, so a cautious company can raise it and force more human review without changing any code.",
    },
    {
        "id": "deductions",
        "title": "Deduction intelligence",
        "what": "A short payment is a claim, and claims get judged: classified, checked for anomaly, and either written off, disputed automatically, or routed to an analyst - by arithmetic, not vibes.",
        "formulae": [
            {"name": "Reason classification", "expr": "keyword evidence over the deduction text maps to an ERP taxonomy: RC-02 shortage/damage, RC-05 pricing, RC-07 promotional, RC-09 freight, RC-11 tax, RC-12 unearned discount (taken after the discount window closed; detected from the ledger dates, not the text), RC-99 other; confidence = 0.65 + 0.15 per keyword hit, capped 0.95"},
            {"name": "Anomaly z-score", "expr": "z = (claimed - history_mean) / history_std over the payer's own judged claims in this workspace; flagged anomalous when z > 2.5. With fewer than 3 judged claims there is no history to score against, so a labelled baseline prior (mean $1,000, std $400) is used and the record states which basis applied"},
            {"name": "Tolerance rule", "expr": "claimed <= tolerance [$25.00] -> WRITE_OFF_TOLERANCE: disputing costs more than the claim is worth"},
            {"name": "Win probability", "expr": "0.94 when proof of delivery is verified clean, else 0.35 - a transparent heuristic, labelled as such in the product; it is not a trained model"},
            {"name": "Dispute decision", "expr": "expected_recovery = win_probability x claimed - processing_cost [$45]; AUTO_GENERATE_DISPUTE_CLAIM iff POD clean and expected_recovery > threshold [$100], else ROUTE_TO_ANALYST"},
        ],
        "meaning": "Every deduction on a match shows its worked calculation: why it was classified that way, the z-score arithmetic, and the expected-value comparison behind the decision. Anyone can redo the sums from the numbers shown.",
    },
    {
        "id": "forecast",
        "title": "Cash-in forecast and collections priority",
        "what": "The delay model predicts days-to-pay per invoice; the forecast turns those predictions into planning bands, and collections turns them into a work queue. Both work only from the post-reconciliation residual ledger - invoices the latest run settled drop out, and part-paid invoices enter at their reduced balance.",
        "formulae": [
            {"name": "Delay model", "expr": "gradient-boosted regressor over customer, amount and seasonality features; graded on a time-ordered 80/20 holdout: MAE 2.95 days vs 7.67 for the naive baseline (shown live on Agent Health)"},
            {"name": "Bands", "expr": "per invoice, payment timing is sampled around its predicted date (400 simulations); weekly totals across the samples give P10 / P50 / P90 - the band is the honest output, a single date would be false precision"},
            {"name": "Collections score", "expr": "score = amount x (1 + overdue_days / 30) x (1 + max(predicted_delay, 0) / 20) - value at risk, so big, late, slow-paying invoices surface first"},
        ],
        "meaning": "The forecast and the collections queue use the same model, so the number a treasurer plans with and the queue an analyst works from always agree about an invoice.",
    },
    {
        "id": "evaluation",
        "title": "Evaluation and the touchless rate",
        "what": "Quality claims are computed from labelled data and stored outcomes, by formulas fixed in code.",
        "formulae": [
            {"name": "Solver accuracy", "expr": "cases where the solver's invoice set equals the human-labelled set / total labelled cases; exact rate = cases reconciling to $0 residual / total. MILP and greedy see identical candidate sets"},
            {"name": "Touchless rate", "expr": "auto_posted payments / total payments in the run - duplicates and no-matches count in the denominator, so the rate cannot be flattered by excluding hard payments"},
            {"name": "Use-case verdicts", "expr": "each of the ten scenario packs states its expected status, auto-post flag, invoice set, residual and deduction decision up front; the API compares the real run field by field and reports pass or fail per check"},
        ],
        "meaning": "Rule: if a number in this product cannot be recomputed from records the product itself shows, it does not belong here. Market figures from vendors are labelled as background context wherever they appear.",
    },
]
