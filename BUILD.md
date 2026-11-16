# Proof pack v1 - replay, evidence packs, success criteria

Applies on top of the autonomy build (live). Suite: 234 passed
on a clean solo run (229 + 5 new). Demo outcome unchanged.
Logo untouched (logo-glass-ygqXbPkV). Vanilla untouched.

## What is inside

1. Run replay (api.py; Run view gains a Proof panel under the
   audit detail). POST /api/v1/runs/{id}/replay re-runs that
   run's payments in an ephemeral scratch session and diffs
   every payment: then vs now. The replay uses the policy a
   fresh run would use now - the stored policy with any active
   case overrides, resolved exactly as a live run resolves it -
   and runs the full pipeline, including the autopilot pass, so
   a policy change shows its true effect before anyone commits
   to it. The scratch ledger is the current ledger with the
   source run's settlements undone from its own records
   (invoices settled by other runs stay settled); the source
   workspace is never touched, and the scratch session is
   reaped like any other ephemeral session.
   Two behaviours the tests pin down: an unchanged-policy
   replay of the demo run diffs to zero on all 16 payments;
   and raising the tenant maker-checker threshold does NOT
   flip the demo holds P7/P16, because the demo case's own
   override governs while the case is active - the lever that
   flips an outcome in replay is a real one (the test flips a
   small partial via autonomy level 1, in the scratch only).
2. Auditor evidence pack (Run view: Download evidence pack).
   GET /api/v1/runs/{id}/evidence returns the run's complete
   record: policy snapshot, every match with lines and
   derivation, exceptions, the SAP documents, and the audit
   entries touching the run - closed with a SHA-256 manifest
   over the contents (every field except generated_at), so
   any later edit to the pack is detectable. The manifest is
   verified byte-for-byte in the tests.
3. Success criteria - the contract view (Agent Health panel;
   GET /api/v1/success-criteria). Five criteria computed from
   the workspace's stored records, each with target, measured
   actual and basis: touchless posting rate (target: the 70%
   Hackett industry median), duplicate leakage (0), decisions
   carrying a full derivation (100%), SAP documents balanced
   (100%), exceptions carrying a recommended action (100%).
   On the seeded demo case the touchless rate measures 62.5%
   and shows WATCH, with an in-product note that the case is
   deliberately adversarial - the criteria are measured, not
   marketed.

## Files

Backend: api.py; tests: test_proof_pack.py (new).
Frontend source: views/Run.tsx, views/Health.tsx.
Built frontend: frontend/react/ (bundle index-C8iWcBhe.js)
+ frontend/index.html re-copied.

## Deploy

Copy in at the same paths, commit, push, Update service
slatematch-app with Force new deployment. Standing reminder,
if still pending in your clone: delete the six dead files
(frontend/css/livecube.css and the five loose
frontend/js/*.js) - never frontend/js/vendor/.
