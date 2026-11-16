# Enterprise build pack v1 - all four items in one go

Built and verified 16 Nov 2026. Suite: 220 passed on a clean solo
run (212 + 8 new in backend/tests/test_enterprise_build.py). Demo
outcome unchanged. Logo untouched (served asset is the same
logo-glass build as before).

## 1. SAP BAPI full compliance (backend/app/erp_sap.py)

The BAPI_ACC_DOCUMENT_POST payload is now the full table shape:
- DOCUMENTHEADER gains USERNAME, DOC_DATE, PSTNG_DATE, FISC_YEAR
  and FIS_PERIOD from the posting date.
- ACCOUNTGL carries only true G/L lines. The AR reconciliation
  account (121000) never appears there (the RW602 rejection);
  customer clearing posts through ACCOUNTRECEIVABLE with the
  account as the line's assigned G/L, per invoice, plus
  special-G/L-style customer lines for residual receivables
  (121600) and on-account amounts (121900). Credit memos clear as
  debit customer lines.
- Every posting line has an ITEMNO_ACC, and CURRENCYAMOUNT
  mirrors every ACCOUNTGL and ACCOUNTRECEIVABLE line under the
  same number (CURR_TYPE "00", signed S/H, nets to zero).
- EXTENSION2 carries the SlateMatch payment reference.
The human-readable journal is unchanged.

## 2. Bank lockbox parsers (backend/app/lockbox.py, api.py)

BAI2, SWIFT MT940 and ISO 20022 camt.054 files uploaded in the
Upload Center (payments) are sniffed by extension or content
before the CSV reader and parsed into staged payments that
reconcile exactly like a payments CSV (response route "lockbox"
with the format named). Credit entries only; amounts are exact
(BAI2 integer cents, MT940 comma decimals, camt decimals);
references come from the same extractor the CSV path uses. A
file that looks like a bank file but yields no credits is
refused with the reason, never silently dropped.

## 3. FX conversion with gain/loss posting (domain.py, batch.py, erp_sap.py, Policy)

- Policy Studio (Governance) gains "FX rates (USD value of
  1 unit)", e.g. EUR=1.087. Stored on the tenant policy
  (fx_rates), validated (3-letter codes, positive rates), and
  merged on save like every other field.
- With no rates (the default everywhere), currency remains a
  hard matching boundary, exactly as before.
- With rates for both sides, foreign-currency invoices enter a
  payment's candidate pool as converted copies (Decimal half-up)
  that keep their book gross and currency. Subsidiary filtering
  still applies first.
- When a cross-currency set balances exactly, the match records
  its book-currency view, and its SAP document posts in BOOK
  currency: cash at the wire's book value, AR at book gross, and
  the realised difference on GL 710100 (FX gain) / 710200
  (FX loss). Worked example in the tests: a $223.33 invoice
  settled by a EUR 205.46 wire at 1.087 posts DR cash 22334 =
  CR AR 22333 + CR FX gain 1.
- Non-exact or mixed-book-currency FX matches keep the standard
  payment-currency document.

## 4. React views 12-14 (web/src, App.tsx)

Methodology, Architecture and Product Thinking are React views
now; the migration is complete and the sidebar lists all 14.
- Methodology reads GET /api/v1/methodology - the same endpoint
  vanilla renders from - so the two stacks cannot drift.
- Architecture carries vanilla's panels and tables plus the live
  diagnostics panel from /api/v1/diagnostics. Lines that
  described the pre-React, pre-hardening system (the vanilla UI,
  the old test count, ECS Express, container-local data, the
  pre-diet explainer count) are corrected to the current system
  rather than copied stale; the request-path text also covers
  the lockbox formats and the FX exception.
- Product Thinking ports the success criteria and thesis; its
  roadmap line no longer lists bank-file ingestion as a gap,
  because item 2 above shipped it.
Vanilla stays byte-identical at /vanilla/ as the reference.

## Deploy

1. Copy the pack contents into your GitHub clone at the same
   paths (backend/, web/, frontend/), overwriting.
2. Standing reminder, still outstanding: delete the six dead
   files in the clone if not yet done - frontend/css/livecube.css
   and the five loose frontend/js/*.js files. Never
   frontend/js/vendor/.
3. Commit (suggested message: "Enterprise build: BAPI full
   payload, lockbox parsers, FX conversion, React views 12-14"),
   push.
4. Update service slatematch-app with Force new deployment.
