Phase 4 pack v1 - the genuinely new items from the third external
review (16 Nov 2026). Everything else in that review was already
live (Phase 3), parked (Part B), held by the standing model
decision, or roadmap - see the audit dispositions note v4.

CONTENTS
1. AI-call hardening (backend/app/ai.py)
   - redact_pii: IBAN / ABA routing (checksum-verified) /
     label-anchored account numbers / SWIFT-BIC are scrubbed from
     the copy of the remittance sent to Gemini. Local parsing and
     verification keep the original text. Parse results report
     pii_redacted.
   - generate_json takes a strict responseSchema for the parse
     shape; a schema rejection retries once without it.
2. Credit-memo netting (ingestion.py, solvers.py, batch.py)
   - Negative invoice amounts import as credit memos (zero still
     quarantined; negative payments still quarantined).
   - The MILP nets memos at face value; memo discount variables
     are pinned to zero. The Rust kernel path and the subset
     enumerators decline pools containing a memo; the MILP
     decides those.
3. Partial-payment allocation modes (domain.py, batch.py, api.py,
   web/src/views/Policy.tsx)
   - Policy.partial_allocation_mode: pro_rata (default, unchanged
     arithmetic), fifo_oldest, explicit_line (remittance-stated
     amounts, disclosed pro-rata fallback). Set it in Policy
     Studio under Governance.
   - Approval records carry allocation_mode / allocation_note.
   - Policy PUT and run-policy resolution now merge a posted
     policy over the stored one instead of replacing it.
4. Tests: backend/tests/test_phase4_new_features.py (18 tests);
   test_audit_remediation.py updated for the credit-memo
   contract. Full suite: 212 passed on a clean solo run.

DEPLOY: copy into the clone at the same paths, commit, push,
Update service slatematch-app with Force new deployment.

Suggested commit message:
Phase 4: AI-call hardening, credit-memo netting, allocation modes

Standing reminder: the six dead files (frontend/css/livecube.css
and the five loose frontend/js/*.js) still need deleting in the
clone - never frontend/js/vendor/.
