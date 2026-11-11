# Architecture and System Design

SlateMatch product pack, document 3 of 8. Previous: Market and Segment Research. Next: Implementation Guide.

## 3.1 High-Level System Architecture
SlateMatch is engineered as a modular, four-layer system: a zero-build frontend, a FastAPI service with per-visitor session isolation, a six-agent execution engine with a hybrid Rust and MILP core, and a persistence layer that generates the SAP posting pack. The module map below is the whole system; every later section of this document is a deeper reading of one of these rows.

### Backend modules (`backend/app/`, plus the Rust kernel)

| Module | Responsibility |
| :--- | :--- |
| `api.py` | The FastAPI application: every `/api/v1/*` route, the session and auth context (`X-Workspace-Session`, API keys, role gates), per-key rate limiting, request IDs, and the diagnostics endpoint. |
| `tenants.py` | The tenant registry and the RBAC capability map (viewer, analyst, approver, admin) that the API layer enforces. |
| `batch.py` | Run orchestration: evidence-specificity ordering, candidate resolution, duplicate blocking, policy gating, the six agents' recorded steps, and settlement on auto-post and approval. |
| `solvers.py` | The matching mathematics: `solve_milp` (HiGHS), the `solve_greedy` benchmark, the kernel attempt, exact-subset counting, and integer re-verification of every returned set. |
| `rust_bridge.py` | The bridge to the Rust kernel: invokes the compiled `slatematch-kernel` binary over stdio with a JSON payload, and carries the Python reference implementation the equivalence suite tests it against. |
| `rust-kernel/` | The Rust subset-sum kernel itself: decides provably-unique exact sets on plain payments, inside strict candidate and amount bounds. |
| `domain.py` | The domain model (invoices, payments, matches, in integer cents) and the `Policy` defaults every threshold in this pack comes from. |
| `repository.py` | SQLite persistence in WAL mode: one database per tenant, cloned session workspaces, the audit trail with content fingerprints, compare-and-set match decisions, and partial-application records. |
| `anomaly.py` | Deduction intelligence: the reason-code taxonomy, duplicate payment fingerprinting, history z-scores, and dispute expected-value math. |
| `ai.py` | Remittance parsing: the Gemini client, the deterministic fallback parser, and the ledger verifier that checks every extracted reference before it is used. |
| `ingestion.py` | File and CSV ingestion: header synonym mapping, locale number normalisation, discount validation, and quarantine of malformed rows with reasons. |
| `fuzzy.py` | Payer identity: Jaro-Winkler fuzzy matching at a 0.88 threshold and the OCR confusion-variant generator behind the `ocr_reference` rung. |
| `ml.py` | The payment-delay and deduction-validity models, trained on a disclosed synthetic generator (1,200 rows) until real history exists. |
| `forecast.py` | The 8-week Monte Carlo cash forecast (400 simulations, P10/P50/P90) and the collections ranking, computed only from the post-reconciliation residual ledger. |
| `erp_sap.py` | The SAP posting pack: balanced DZ clearing documents, the separate ASC 606 dispute accrual journal, deterministic document numbers, and the `BAPI_ACC_DOCUMENT_POST` payload. |
| `mail.py` | Outbound mail records and the send path, including the honesty state: a send is recorded as `recorded_not_sent`, with the reason, until an SMTP mailbox is configured. |
| `briefing.py` | The executive run brief and the dispute and chase draft generator, with its three dispute tones (strict, contract, escalate). |
| `copilot.py` | The workspace assistant: answers questions from the live repository state (the same source the approvals queue is served from), never from a snapshot. |
| `methodology.py` | The methodology and JD-mapping content the product serves on its Methodology page. |
| `scenarios.py` | The ten scenario packs the engine is benchmarked against, from split payments to corrupted-OCR remittances. |
| `seed.py` | The flagship demo case: 19 invoices, 16 payments, 9 customers, one realistic day of receipts. |
| `reference_engine.py` | The builder's original engine, preserved in the tree for reference; it is not part of the run path. |

### Frontend modules (`frontend/` - zero-build, classic scripts)

| File | Responsibility |
| :--- | :--- |
| `index.html` | Markup only: the 14 views in three groups (OPERATE, INSIGHT & GOVERNANCE, EVALS & ARCHITECTURE), the top bar, and the docs drawer shell. |
| `css/livecube.css` | The design system: the dark Serro-inspired theme, layout, and components for every view. |
| `js/state.js` | Shared state and the shell: the `api()` helper that carries the session header, the single `esc()` renderer, navigation with lazy per-view loading, the case bar and the executive case brief. |
| `js/operate.js` | The operate views: Use Cases and the Run Reconciliation pipeline, its agent steps, results, and run grading. |
| `js/insight.js` | The insight views: Ledger, Forecast and Collections, the SAP posting pack, Evaluations, Agent Health and diagnostics, and the product docs drawer. |
| `js/assist.js` | The assist surfaces: the Outbound Mail Hub, the approvals queue, Policy Studio, the audit view, the Methodology page, and the copilot. |

```text
+-----------------------------------------------------------------------------+
|                        14-Page Enterprise Workspace                         |
|  OPERATE (01-05)    |    INSIGHT & GOVERNANCE (06-09)    |   EVALS (10-14)  |
+-----------------------------------------------------------------------------+
                                       |
                   HTTPS REST API (/api/v1/*) + X-Workspace-Session
                                       |
+-----------------------------------------------------------------------------+
|            Evidence-Sorted Six-Agent Orchestrator (batch.py)                |
|  [1. Capture] -> [2. Linking] -> [3. Matching] -> [4. Deduction]            |
|                               -> [5. Policy]   -> [6. Briefing]             |
+-----------------------------------------------------------------------------+
         |                             |                             |
+-----------------+         +---------------------+         +-----------------+
| Ingestion & AI  |         | Hybrid Math Engine  |         | ERP & Comms     |
| - Gemini Client |         | - Rust Kernel       |         | - SAP S/4HANA   |
| - Regex Parser  |         |   (stdio binary)    |         |   BAPI + EBRR   |
| - Ledger Check  |         | - Sparse HiGHS MILP |         | - 4-Stream Mail |
+-----------------+         +---------------------+         +-----------------+
                                       |
+-----------------------------------------------------------------------------+
|       SQLite WAL Repository (Per-Session Isolation + Audit Trail)           |
+-----------------------------------------------------------------------------+
```

*The Briefing agent composes on demand from the finished run; the other five execute in sequence during the batch.*

## 3.2 Evidence-Specificity Batch Ordering
In real lockbox batches, multiple wires from the same customer often arrive together. If an unreferenced wire is processed first, FIFO weighting might assign it an open invoice that a later wire in the same batch explicitly names by invoice ID.

To prevent this conflict, `batch.py` sorts the pending payments handed to the run by **evidence specificity** before running the solver loop (payments already reconciled in this workspace are excluded first, and execution is idempotent: re-running returns the standing run). Each payment carries an evidence rung, and the run sorts by it:

| Rung | Evidence | Meaning |
| :--- | :--- | :--- |
| 0 | `reference`, `po` | The wire names its invoices, or its purchase order |
| 1 | `ocr_reference` | The reference was recovered by OCR repair |
| 2 | `amount_payer`, `customer_ledger` | Payer and amount point at the customer's own ledger |
| 3 | `fuzzy_payer` | The payer matched by fuzzy name evidence |
| 4 | `all_ledger` | Nothing but a whole-ledger search |
| 5 | (fallback) | The sort's default key when no rung was assigned |

One entry in the sort map is an alias rather than an evidence value: `customer_ledger` sorts at rung 2 alongside `amount_payer` (it names the same resolution seen from the ledger side). Before any rung is computed, two hard gates apply: a SHA-256 fingerprint of (payer, amount, currency) blocks a duplicate wire as an exception before matching, and the candidate pool is filtered to the payment's own currency, and on the strong rungs to its own customer. The order actually used is recorded in the Matching Agent's evidence for every run, so the processing sequence is itself auditable.

## 3.3 Mathematical Formulation of the Matching Engine

### Variables and Parameters
For a single payment of P cents and a candidate pool of n open invoices belonging to the same customer and currency, the problem has exactly 2n + 3 decision variables:
* I_i: Open balance of candidate invoice i in {1, ..., n} in cents (integer).
* discount_i = round(I_i x discount_rate_i): the early-payment discount available on invoice i, in cents.
* C: Claimed deduction amount on the payment in cents (0 when the payment claims none).
* x_i in {0, 1}: Binary decision variable equal to 1 if invoice i is selected (paid at gross I_i).
* d_i in {0, 1}: Binary decision variable equal to 1 if the discount on invoice i is taken (the invoice then settles for I_i - discount_i).
* take_claim in {0, 1}: Binary decision variable equal to 1 if the claimed deduction is accepted.
* s^+, s^- (continuous, >= 0): Non-negative slack variables in cents. The residual is s^+ - s^-: positive when the payment exceeded the applied invoices (an overpayment, held as on-account credit), negative when it fell short (an underpayment, carried as a residual receivable).

### Linear Constraints
1. **Cash Conservation Equation:**

```text
sum over i of (I_i x x_i - discount_i x d_i) - C x take_claim + s^+ - s^- = P
```

2. **A discount can only be taken on an invoice that is selected:**

```text
d_i <= x_i, for every i in {1, ..., n}
```

3. x_i, d_i and take_claim are binary; the two slacks are continuous and unbounded above, so the problem is always feasible and any unexplained cash is priced into the objective, never hidden.

### Objective Function

```text
minimise   1,000,000 x (s^+ + s^-)
         + 50 x (number of discounts taken)
         + 10 x take_claim
         - sum over i of w_i x x_i
where w_i = 1.0 + 0.05 x age_days_i
```

The residual weight dominates by six orders of magnitude: any set that explains the payment exactly beats every set that leaves a residual, whatever else it selects. The per-invoice reward w_i grows with invoice age, providing FIFO pressure toward older invoices without overriding exact cent conservation. The discount and deduction terms are small positive penalties, so the solver takes a discount or accepts a claim only when the arithmetic genuinely needs it. Every solved match stores its objective terms (the value of each term above, for the set actually chosen) and its confidence derivation, so a result can be explained term by term.

### Hybrid Rust + Sparse HiGHS Execution and Uniqueness Verification
1. **Rust Subset-Sum Kernel (`rust-kernel/`):** A compiled binary (`slatematch-kernel`) invoked by `rust_bridge.py` over stdio with a JSON payload - not a shared library, and nothing is loaded through FFI. On plain payments (no discounts, no claimed deduction) it attempts the exact set first, and it decides the payment only when that set is provably the unique exact set. It works inside strict bounds (at most 18 candidates, a payment of at most 25,000,000 cents, a 3-second subprocess limit) and declines everything outside them to the MILP. Its equivalence to the Python reference implementation is proven on a 203-case generated suite, and the diagnostics endpoint re-probes that equivalence live.
2. **Sparse HiGHS MILP (`solvers.py`):** Formulates the constraint matrix using `scipy.sparse.csc_matrix` with an explicit `time_limit` of 2.0 seconds and a relative gap tolerance of 1e-6, so large candidate pools never block a worker thread. A greedy first-fit matcher is kept permanently as the benchmark the solver must beat; the evaluations endpoint runs both over labelled cases.
3. **Uniqueness and Integrity Verification:** Whenever an unreferenced wire on a plain payment achieves an exact zero-residual match, the batch guard enumerates the exact subsets for that customer (full enumeration; plain payments with at most 18 candidates) to detect a tie. If a second distinct set also yields zero residual, `ambiguous_tie` is recorded, confidence is capped at 0.75, and the match is held as `PROPOSED` for human review. (The kernel path reaches the same question with its own bounded count, which stops at two subsets: unique, or not unique.) Separately, every set the MILP returns is re-verified in exact integer cents before it is believed - with seven-figure amounts, solver scaling tolerances can accept a set that is a few cents short - and a set whose true residual differs from the solver-reported one is cut from the problem and the solve repeats, at most 6 attempts, before an honest no-match is returned with a verification note.

## 3.4 Confidence Scoring and Governance Formula
Confidence is computed from evidence provenance and mathematical precision, never from zero residual alone:

```text
base = 1.0                                    if residual is 0
     = max(0.3, 1 - |residual| / payment)     otherwise

if the match came from an explicit reference or a purchase order:
    base = base + 0.03, at most 1.0

caps, applied last:
    ambiguous exact tie (section 3.3):  at most 0.75
    fuzzy_payer and all_ledger matches: at most 0.78
```

The caps are measured against the policy's automation threshold (0.90 by default): no weak-evidence match can reach the auto-post bar, however exact its arithmetic. Each match stores this derivation (the base, the bonus actually applied, the cap, and the rule behind each) next to its objective terms.

Two further governance rules complete the picture:
* **Maker-checker hold:** an exact match above the policy's maker-checker threshold ($100,000 by default) is held as `PROPOSED` for a second approver, however confident the engine is.
* **Cross-customer cap:** a solved set spanning more than one customer is capped at 0.75 and held, on every rung.

* **Deduction Expected Value (EV) Formula:**

```text
EV = p(win) x Deduction Amount - Processing Cost
```

  where p(win) is a transparent heuristic - 0.94 when carrier Proof of Delivery is verified clean (`pod_verified_clean = True`), 0.35 otherwise - the processing cost is $45 by policy default, a dispute is auto-generated only when the proof of delivery is clean and EV exceeds the $100 minimum expected recovery, and claims at or below the $25 tolerance are written off without a dispute. The Deduction Agent's anomaly score behind these decisions is computed against the payer's own judged claim history in the workspace; with fewer than 3 samples it falls back to a labelled baseline prior (mean $1,000, spread $400), and the record states which basis was used.

## 3.5 SAP S/4HANA (`BAPI_ACC_DOCUMENT_POST`) and ASC 606 EBRR Design
`backend/app/erp_sap.py` builds balanced double-entry clearing documents (`Doc Type DZ`, Company Code `1000`). The BAPI payload expresses each line with a debit/credit indicator (S/H); the journal lines are:

| Side | GL Account | Account Name | Accounting Treatment |
| :--- | :--- | :--- | :--- |
| **Debit** | `113100` | Cash - operating account | Exact cent amount of the incoming bank wire (P). |
| **Debit** | `415000` | Sales discounts allowed | Earned early-payment discount cents (the sum of discount_i over selected invoices). |
| **Debit** | `529000` | Deductions accepted (within policy) | A claimed deduction the policy accepts (within tolerance, or not worth contesting). |
| **Debit** | `121600` | Residual receivable - part-paid invoices | Balances a partial payment so the unpaid balance remains open on the customer account, in the ledger and the forecast; the part-paid invoice stays open at the reduced balance, with the partial application recorded against it. |
| **Credit** | `121000` | Trade receivables - customer control | Gross open invoice cents cleared, each AR line tagged with the resolved `CUSTOMER` ID. |
| **Credit** | `121900` | Unapplied cash - customer on-account | The excess of an overpayment, held as the customer's on-account credit. |

Two related postings are deliberately NOT lines of the DZ document. A contested claim is isolated by a separate dispute accrual journal (document type DR): debit GL `121500` disputed receivables, credit GL `121000` - that journal is the ASC 606 / IFRS 15 reserve, generated alongside each dispute claim. And an unmatched wire that a controller parks is not posted at all: parking records the match status `PARKED_SUSPENSE` (GL `119900`) in the audit trail and issues no document, so suspense never appears as a balancing line.

Every generated document is balanced by construction - its amounts come from the match's derivation equation - and carries a `balanced` flag asserted in integer cents. Document numbers are deterministic: a cleared auto-posted match receives DZ-1400 plus 6 digits derived from the SHA-256 of its match ID, and an approved match receives DZ- plus the first 10 characters of its approval fingerprint, issued at decision time. Cleared documents carry the status STAGED_FOR_SAP_POSTING.

---

Version 3.1 | 3 Nov 2026 | Owner: C. Harsha Vardhana Reddy
