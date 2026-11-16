# SlateMatch enterprise hardening - Phase 2 pack v1 (16 Nov 2026)

Built and verified in the HighRadius / SlateMatch core chat, from the
verified triage of the external enterprise review. Phase 2 is the
integrity phase: atomic writes, a bounded kernel, a stronger duplicate
guard, exact money parsing. One review item is held by a standing
product decision (see "Held" below) - everything else is in.

## What is in this pack

1. **Atomic unit of work** (backend/app/repository.py, batch.py,
   api.py). Repository writes still commit per statement by default,
   but callers can now bracket a unit of work with begin()/commit()/
   rollback() or the transaction() context manager (per-thread depth,
   nested begins join the outer transaction). Three callers use it:
   - POST /matches/{id}/decision: the compare-and-set status flip,
     invoice settlements/reductions, the learned payer alias, the
     audit entry and the settlement draft now land together or not
     at all. A concurrent-decision 409 raised inside rolls back
     cleanly and still propagates.
   - run_batch: the run record is created on its own (the FAILED
     marker must be able to land on it); everything the run writes -
     matches, exceptions, steps, settlements, the COMPLETED finish -
     commits as one transaction. On any failure the writes roll back
     and the run is marked FAILED on the committed record, as before.
     WAL readers never see a partial batch. Streamed progress events
     still fire during the run; they are notifications, not state.
   - _finish_run_outputs: settlement drafts and the Briefing step
     that reports them land together.

2. **Secondary indexes** (repository.py schema): matches(run_id),
   matches(payment_id), matches(status), exceptions(run_id),
   exceptions(payment_id), run_steps(run_id), audit_log(entity,
   entity_id), payments(fingerprint), invoices(status),
   outbox(status). The schema previously had none beyond primary
   keys; the indexes are created by the same CREATE ... IF NOT
   EXISTS script that runs on every open, so existing workspace
   databases pick them up with no migration.

3. **Tiered duplicate guard** (anomaly.py, batch.py, repository.py).
   The v1 fingerprint hashed only payer|amount|currency, truncated
   to 16 hex chars: two genuinely different wires from one payer for
   the same amount blocked each other. v2 binds the normalised
   payer, amount, currency, claimed deduction and the sorted
   remittance references, at full digest length. The guard is
   tiered: a strong collision is the same wire; a core collision
   (same minus references) also counts when at least one side
   carried no references - a resend that lost its remittance is the
   dangerous duplicate, and the duplicate-guard scenario (S4) pins
   exactly that case. When both sides name different references
   they are different wires and never block each other. The guard
   now also looks ACROSS runs: the batch seeds its duplicate index
   with every payment earlier runs already reconciled (recomputed
   from stored rows, so the v1->v2 format change strands no
   workspace), and a re-imported wire under a fresh payment id is
   held as DUPLICATE_PAYMENT of the original. Note: the canonical
   payment schema has no value-date field, so none is hashed; the
   references are the strongest wire identity the schema carries.

4. **Kernel enumeration** (rust-kernel/src/lib.rs,
   backend/app/rust_bridge.py). The subset-sum DP allocated one
   state per cent of the target: at the engine's $250,000 gate that
   was 25,000,000 states, each carrying a selection vector, to
   choose among at most 18 invoices. Both implementations now
   enumerate subsets (2^n, scored incrementally from the lowest set
   bit), bounded at 20 candidates and independent of the amount.
   The selection rule is unchanged - maximise (sum, then
   age-weighted score) - with one documented refinement: exact
   (sum, score) ties now break deterministically by fewer invoices,
   then the lexicographically smaller id list, identically in Rust
   and Python (the old DP's tie outcome depended on discovery
   order). The kernel's production use is unaffected by ties: it
   only ever decides provably unique exact sets, re-counted in the
   engine. Measured at the max gate (18 candidates, $250,000):
   Python 0.18s / 33MB peak, Rust 0.01s, identical results.

5. **Exact money parsing + currency mapping** (ingestion.py).
   Money cells are parsed with Decimal and rounded half-up to the
   cent; the float path mis-rounded at the half-cent boundary
   (2.675 came out 267 instead of 268) and lost cents on very large
   amounts. A currency column (currency/ccy/curr/invoice_currency/
   payment_currency) is now mapped for both invoice and payment
   CSVs and validated as a 3-letter code (blank = USD default);
   currency is a hard candidate filter in the engine, so a misread
   code would have stranded real money as an invisible USD.

6. **ParseIn cap** (api.py): POST /api/v1/parse text is capped at
   20,000 characters (roughly ten pages of remittance text); longer
   input is a 422, not an unbounded pass through the AI parser.

7. **Evaluations concurrency** (api.py): GET /api/v1/evaluations
   runs its independent seed-scenario solves on a bounded pool
   (4 workers); executor.map preserves ground-truth order, so the
   response is identical to the sequential computation.

8. **No more intent polling** (web/src/lib/operate.ts,
   web/src/views/Ledger.tsx, web/src/views/Run.tsx). setIntent now
   also dispatches a window event (slate:intent); the Ledger and
   Run views react to it (plus the cross-tab 'storage' event)
   instead of polling sessionStorage every 600ms. All intent
   writers already go through setIntent; the mount-time takeIntent
   reads are unchanged, so nothing fires twice or gets missed.

9. **Dead code retired** (ml.py): predict_validity() had no caller
   anywhere in the API, engine or UI (deduction win probability is
   the transparent 0.94/0.35 heuristic in anomaly.py, labelled as
   such). The function is removed; the validity MODEL stays -
   train_all still trains it and reports its AUC.

## Held, deliberately

- **Delay-model features** (the review's "replace the 6-customer
  one-hot with behavioural features"): NOT done. The trained model
  and its published metrics (MAE 2.948 vs 7.665, AUC 0.846) are a
  validated artifact quoted in the referral pack and the film, and
  Harsha's standing decision (2 Nov 2026) is to keep the validated
  model exactly as is; feature replacement means retraining and
  re-validating, which is model-v2 roadmap work. The one-hot is
  also honest about its world: the generator's six profiled
  customers are the labelled history the model was trained on, and
  predict_delay handles other customers through the amount, terms
  and seasonality features with a zero one-hot.

## Verification (all run 16 Nov 2026)

- Full backend suite: **180 passed** (170 before + 10 new Phase 2
  regressions in backend/tests/test_phase2_hardening.py covering
  transaction rollback/commit, the context manager, index
  presence, cross-run duplicates under a new id, the
  lost-remittance resend, distinct wires with different
  references, Decimal boundaries, currency mapping/validation,
  the kernel bound, and the parse cap).
- Cargo tests: 4/4. Rust/Python equivalence: 203 cases pass,
  plus a max-gate parity check at $250,000 / 18 candidates.
- Web build: clean; frontend/index.html re-synced from the build.
- The canonical demo outcome is unchanged (the suite's full-flow
  and scenario tests assert it: 10 auto / 5 held / 1 duplicate).

## Deploy

Independent of the Stage 6 / Phase 1 deploy (already live). Copy
the files over your clone at the same paths, commit, push, then
Update service with Force new deployment on slatematch-app. The
index creation runs automatically on first open of each workspace
database. No data migration: fingerprints are recomputed from
stored rows wherever they are compared.
