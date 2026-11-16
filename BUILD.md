# Autonomy build pack v1 - CUMULATIVE (includes the enterprise build)

This pack supersedes the enterprise build pack v1: it contains
every file that pack had, plus the autonomy build. Deploy THIS
one; the earlier enterprise zip can be discarded. If you already
deployed the enterprise pack, this one still applies cleanly on
top (same files, newer frontend bundle).

Suite: 229 passed on a clean solo run (220 enterprise + 9 new).
Demo outcome unchanged: 10 auto-posted of 16. Logo untouched
(logo-glass-ygqXbPkV, byte-identical). Vanilla untouched.

## Part 1 - the enterprise build (from the earlier pack note)

1. SAP BAPI full compliance (erp_sap.py): DOCUMENTHEADER carries
   USERNAME, DOC_DATE, PSTNG_DATE, FISC_YEAR, FIS_PERIOD;
   ACCOUNTGL holds only true G/L lines; AR-family accounts post
   per invoice through ACCOUNTRECEIVABLE; ITEMNO_ACC on every
   line; CURRENCYAMOUNT mirrors all lines, signed, netting to
   zero; EXTENSION2 carries the payment reference.
2. Bank lockbox parsers (new lockbox.py): BAI2, SWIFT MT940 and
   ISO 20022 camt.054 dropped into Upload Center parse into
   payments and reconcile like a CSV import. Credit entries
   only, exact money, shared reference extractor.
3. FX conversion: Policy.fx_rates (EUR=1.087 style) in Policy
   Studio Governance. With rates on both sides a foreign wire
   settles book-currency invoices at the policy rate; exact
   matches post their SAP document in book currency with the
   difference on GL 710100 (gain) / 710200 (loss). No rates =
   the hard currency boundary, exactly as before.
4. React views 12-14: Methodology, Architecture, Product
   Thinking. Migration complete, 14 of 14.

## Part 2 - the autonomy build (new in this pack)

5. Exception autopilot (new autonomy.py; Policy gains
   autonomy_level and autopilot_max_residual_cents, edited in
   Policy Studio Governance). Default level 0 = off: nothing
   changes. Level 1 auto-resolves a run's PROPOSED partial
   matches whose shortfall is within the tolerance write-off;
   level 2 raises the cap to the autopilot cap ($250 default).
   It requires solver confidence at or above the automation
   threshold, and it never touches exceptions, refusal
   verdicts, or any payment above the maker-checker threshold
   (the amount is checked directly - partials carry no
   maker-checker label, which the tests caught). A resolution
   is the same act as a human approval, with the invoices'
   pre-state snapshotted into the record.
6. One-click reversal: POST /api/v1/matches/{id}/reverse,
   surfaced on the match detail. Restores every invoice from
   the snapshot, marks the match REVERSED (it drops out of
   settled sets and ERP documents), audits both directions,
   and refuses if a later posted decision already used one of
   the invoices.
7. Payer behaviour profiles (new behaviour.py): computed on
   read from the workspace's decided history - bundle habits,
   partial and deduction rates, duplicates. Shown on Agent
   Health, and attached to NO_MATCH / residual exceptions as
   a triage hint. The solver reads none of it: learning
   proposes, math decides.
8. Collections agent acts (Forecast & Collections): per-row
   promise-to-pay logging with a date picker, agent reminder
   drafts into the Outbox, and a Promises panel whose status
   is derived from the ledger (KEPT on settlement, BROKEN
   when the date passes). Workspace reset now clears disputes
   and promises with the dataset; eval snapshots and the
   outbox survive as tenant records.
9. Dispute closed loop: every claim a run generates becomes a
   lifecycle record (OPEN), with transitions Sent /
   Acknowledged / Escalated / Won / Lost in the Mail Hub
   dispute pane; Sent also drafts the claim letter; Won and
   Lost are terminal outcome bookings; 14+ days open flags
   escalation due.
10. Pre-arrival predictions: an Expected receipts panel on
    Forecast - per-invoice expected landing date from the
    same forecast computation, next 14 days flagged with the
    window total.
11. Evaluation drift: Agent Health gains a drift panel -
    one snapshot per tenant per day from the live evaluations
    computation, flagged at a drop of 2+ accuracy points.

## Files

Backend: api.py, batch.py, domain.py, repository.py,
erp_sap.py, lockbox.py (new), autonomy.py (new),
behaviour.py (new); tests: test_enterprise_build.py,
test_autonomy_build.py (new).
Frontend source: App.tsx; views Methodology, Architecture,
Product, Policy, Health, Forecast, Mail, MatchDetail;
lib/operate.ts. Built frontend: frontend/react/ (bundle
index-CFBbPZEt.js) + frontend/index.html re-copied.

## Deploy

Copy the files into your clone at the same paths, commit,
push, then Update service slatematch-app with Force new
deployment. Standing reminder, if still pending in your
clone: delete the six dead files (frontend/css/livecube.css
and the five loose frontend/js/*.js) - never
frontend/js/vendor/.
