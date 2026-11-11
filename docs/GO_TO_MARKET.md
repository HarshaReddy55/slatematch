# Go-To-Market Plan

SlateMatch product pack, document 7 of 8. Previous: AWS Deployment Runbook. Next: Build Challenges and How Each Was Resolved.

## 7.1 Target Customer Profile
SlateMatch targets mid-market and enterprise B2B suppliers (USD 100M to 2B annual revenue) in manufacturing, wholesale distribution, medical supplies, and CPG that run SAP S/4HANA, SAP ECC, Oracle NetSuite, or Microsoft Dynamics. (The product's clearing pack is built for SAP today; the other platforms name where the same finance teams sit, not shipped integrations.)

### Buying Triggers
1. **High Month-End Unapplied Cash:** More than $500,000 sitting in unapplied cash suspense at month-end because analysts cannot keep up with complex lockbox remittances.
2. **Revenue Leakage from Unchallenged Buyer Deductions:** Retail and wholesale buyers taking 1% to 3% in expired early-payment discounts or unverified shortage deductions that get written off because manual investigation costs too much analyst time.
3. **ERP Migration or Shared-Services Consolidation:** Finance teams upgrading to SAP S/4HANA looking to automate manual `FB05` / `F-28` clearing entries with clean `BAPI_ACC_DOCUMENT_POST` payloads and ASC 606 EBRR compliance.

## 7.2 Sales Motion: The 14-Day Shadow Lockbox Replay
Instead of pitching abstract slides, SlateMatch uses a 14-day proof-of-value built on the prospect's own historical data:
* **Step 1 (Day 1 - CSV Export):** The prospect provides a 30-day export of historical open invoices and lockbox payments (no IT integration or ERP credentials required).
* **Step 2 (Day 3 - Live Workspace Replay):** We ingest their files into an isolated SlateMatch tenant using the synonym CSV mapper and run the six-agent solver against their real remittances.
* **Step 3 (Day 10 - Executive Value Readout):** We walk the CFO and Controller through their own transactions inside SlateMatch, showing:
  * Exact touchless auto-post rate achieved vs. their historical manual baseline.
  * Exact dollar value of unearned discounts and invalid short-pays caught by the Deduction Agent.
  * Balanced SAP S/4HANA `Doc Type DZ` clearing journals ready for posting.
  * The payment-delay model's measured accuracy, with its basis stated plainly (MAE 2.95 days against a 7.67-day naive baseline, AUC 0.846, trained on a disclosed synthetic generator until real history exists).

## 7.3 Commercial Packaging and Pricing
1. **Core Platform (Autonomous Cash Application & SAP Clearing):** Annual subscription tiered by monthly payment volume, justified by immediate FTE time savings and faster working-capital velocity. Controller-grade governance is part of the pitch: maker-checker approvals with atomic compare-and-set decisions, SHA-256 audit fingerprints, and a one-click month-end export bundle. Pricing is a platform fee plus per-payment pricing, being validated with design partners; no published price list exists yet, and none is quoted here.
2. **Deduction Recovery Module:** Automated short-pay dispute packaging, carrier POD cross-checking, and multi-tone buyer recovery emails. Its value case is the recovery of deductions that would otherwise be written off unexamined; no recovery figure is promised before a prospect's own replay (section 7.2) measures it.
3. **Treasury Cash Forecasting & Collections Module:** Live 8-week post-reconciliation inflow forecasting - Monte Carlo bands (P10/P50/P90) over the residual ledger, a what-if view (a customer paying X days earlier or later), and expected-value (EV) collector worklists. The honesty posture is part of the product: mail is recorded as recorded_not_sent until a mailbox exists, and win probabilities are labelled heuristics in-product.

---

Version 3.1 | 3 Nov 2026 | Owner: C. Harsha Vardhana Reddy
