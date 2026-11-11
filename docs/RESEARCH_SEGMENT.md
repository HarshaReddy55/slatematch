# Market and Segment Research

SlateMatch product pack, document 2 of 8. Previous: Product Requirements Document. Next: Architecture and System Design.

## 2.1 Target Market Definition
SlateMatch is designed for B2B manufacturers, wholesale distributors, medical device suppliers, and industrial equipment vendors with $100M to $2B in annual revenue. 

In this segment, order-to-cash complexity is driven by three operational realities:
1. **Complex Buyer Remittance Behavior:** Retail and industrial buyers pay multiple invoices in a single wire, deduct early-payment discounts after the discount deadline has passed, and deduct unilateral debit memos for alleged shipping shortages or damaged cartons.
2. **Split Information Channels:** Bank funds arrive via ACH, Fedwire, or lockbox files (`CSV`, `BAI2`, `MT940`), while remittance details arrive separately in unstructured emails, scanned PDFs, or vendor portals.
3. **High Cost of Manual Exception Handling:** A typical mid-market supplier processes 3,000 to 25,000 payments per month. The Hackett Group's 2025 benchmarking puts the median auto-match rate at 70%, with the top third of performers above 80% - and the manual remainder consumes a disproportionate share of the AR team's labor hours.

## 2.2 The Core Cash Application Failure Modes
SlateMatch's ten benchmark case packs and flagship demo dataset are built around the failure modes that break legacy ERP rules engines:

| Failure Mode | Real-World Scenario | Why Legacy ERP Rules Fail | SlateMatch Resolution |
| :--- | :--- | :--- | :--- |
| **1. Multi-Invoice Split Wire** | Buyer sends one lump-sum wire covering 2 to 8 open invoices without listing individual invoice amounts. | A customer with 25 open invoices has 2^{25} (33.5 million) possible combinations, stalling simple rules. | Rust subset-sum kernel and HiGHS MILP find the exact cent combination and check for alternative ties. |
| **2. PO-Only Reference** | Buyer's AP system prints only the purchase order number (`PO-8841`) on the wire memo, omitting the supplier's invoice number. | Rules looking strictly for `INV-` prefixes fail to link the wire and dump it into suspense. | Linking Agent resolves `PO-` tokens directly against the open AR ledger's purchase order index. |
| **3. OCR Character Corruption** | Scanned lockbox check or manual entry swaps `0` and `O` or `1` and `I` (for example, `INV-10O4` instead of `INV-1004`). | Exact string lookup misses the invoice and flags a false exception. | The Linking Agent generates confusion-table variants of the corrupted reference (0/O, 1/I, 5/S, 8/B) and verifies each variant against active open invoices for that payer. |
| **4. Unearned Discount + Shortage** | Buyer takes a 2% early-pay discount on a 40-day-old invoice and deducts an extra $1,500 for alleged damaged goods. | Net wire amount does not match gross or discounted invoice totals; analysts often write off the difference to clear the queue. | MILP isolates the exact discount and shortage cents; Deduction Agent flags both, checks carrier POD, and drafts a recovery claim. |
| **5. Duplicate Bank Wire** | Buyer treasury transmits the same wire twice on consecutive days. | Second wire either clears other open invoices by coincidence or sits unapplied. | A SHA-256 fingerprint (payer, amount, currency) identifies the repeat wire before solver allocation and blocks it as an exception with its own record - never a second posting - and surfaces it for a buyer inquiry. |
| **6. Unrecognized Payer Name** | A parent holding company or third-party payment processor wires funds on behalf of a billed operating subsidiary. | Exact customer name lookup fails to find open invoices. | Fuzzy entity linker checks saved aliases and Jaro-Winkler similarity (0.88), routing new entity links to human approval; once approved, the alias is saved for future runs. |
| **7. Partial Payment** | Buyer pays part of a large invoice (in the flagship case, $20,000 against a $36,750 invoice) with no explanation. | Rules either reject the wire as unmatched or force-clear the invoice, destroying the remaining receivable. | Approving the partial match applies only what was paid, records the partial application, and keeps the remaining balance open, collectable, and inside the forecast. |
| **8. Overpayment** | Buyer overpays an invoice (in the flagship case, $13,000 against a $12,480 invoice). | The excess is written off, dumped into suspense, or netted against unrelated invoices. | The invoice clears and the $520 excess posts as the customer's on-account credit (GL 121900), visible and applicable to future invoices. |
| **9. The Silent Wire** | A wire arrives with no remittance reference at all - no invoice ID, no purchase order, sometimes an unfamiliar payer name. | There is nothing to key on; the wire sits in unapplied cash until someone investigates manually. | The engine falls back through payer and amount evidence to a per-customer whole-ledger solve, and any exact tie or weak-evidence result is held for human review instead of being guessed. |

## 2.3 Competitive Positioning: Why Hybrid Math Beats Pure Rules and Pure LLMs
* **Why Legacy Rules Engines Plateau (an estimated 55% to 65% automation):** Deterministic string-matching templates break as soon as a buyer combines an OCR typo, an early-payment discount, and a partial short-pay in the same wire.
* **Why Pure LLM Matching Is Unsafe for Finance:** Asking a generative AI model to pick which invoices match a payment introduces hallucinated invoice IDs, arithmetic rounding errors, and non-reproducible postings that fail SOX audits.
* **The SlateMatch Advantage:** SlateMatch confines LLMs to unstructured language tasks (parsing messy remittance text and drafting polite collection emails) while executing 100% of invoice linking, subset-sum optimization, policy gating, and SAP journal construction in deterministic, auditable integer math. One calibration note: the segment leader markets 90%+ straight-through cash posting. That figure is a vendor claim; the analyst-measured reality above is the benchmark this product is honest about.

---

Version 3.1 | 3 Nov 2026 | Owner: C. Harsha Vardhana Reddy
