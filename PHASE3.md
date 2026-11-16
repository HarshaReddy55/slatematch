# Phase 3 pack - residuals from the second external review (16 Nov 2026)

PACK v2 (supersedes v1): adds the Section E subsidiary fix and four
guardrail refinements (per-IP anonymous rate-limit bucket, a hard
256-file cap in the session reaper with a repo-creation trigger,
and PDF fallback transliteration). Suite: 192 passed.

The second external review was verified claim by claim against the
current code. Most of it re-raised items already fixed in Phases 1-2,
parked with Part B, or on the roadmap (see
slatematch-audit-dispositions-v2.md, which supersedes v1). Five
findings were genuinely new and verified real. This pack fixes
those five, the four refinements above, and the one acknowledged
open item from the first review (Section E, subsidiary filtering).
Full suite: 192 passed (180 + 12 new), cargo tests 4/4, canonical
demo outcome unchanged.

## What changed

1. **Kernel CLI errors** (rust-kernel/src/main.rs). The two unwrap()
   calls on stdin input are gone: malformed input now prints
   {"error": "..."} on stdout and exits with status 2. The Python
   bridge already treats a non-zero exit as a clean fallback to the
   Python solver, so behaviour on bad input is now a graceful
   decline instead of a Rust panic backtrace.

2. **Client-IP trust + rate-limit memory** (backend/app/api.py,
   backend/app/ai.py). _client_ip keyed the Gemini budget on the
   FIRST X-Forwarded-For hop, which is whatever the client claims -
   one caller could mint a fresh "IP" per request and never hit the
   budget. Behind the ALB the proxy appends the real client IP as
   the LAST hop; that is now the one used. Both rate-limit maps
   (the request limiter's _rate_windows and the AI budget's _hits)
   also sweep fully-expired keys once they grow past a threshold,
   instead of accumulating one entry per key/IP forever.

3. **Bounded session storage** (backend/app/api.py). Saved
   snapshots are capped at 20 per tenant: on save, the oldest
   beyond the cap are deleted (file and manifest entry). Ephemeral
   per-tab workspace databases (<tenant>--<uuid>.db) are reaped
   after 7 days untouched, checked hourly from the request
   middleware; workspaces currently open and base tenant databases
   are never touched. This bounds the disk growth the review
   flagged without gating session creation (that stays with the
   parked Part B flip).

4. **Unicode PDF export** (backend/app/bundle_pdf.py, Dockerfile).
   The audit bundle degraded every non-Latin-1 character (€, ₹,
   international names) to "?" because fpdf2's core fonts are
   Latin-1. The renderer now registers the DejaVu Sans TTFs when
   present and writes real Unicode; the production image installs
   fonts-dejavu-core (added to the existing apt line). Without the
   fonts (bare local checkouts) the previous Latin-1 behaviour
   remains as fallback. Verified by rendering a bundle containing
   € and ₹ and extracting the text back.

5. **Model warm-up at startup** (backend/app/api.py). models() used
   to train both GradientBoosting models lazily inside the first
   /health or /ready probe. Training now runs on a background
   thread at process start, behind a lock (which also stops two
   concurrent first callers training twice); a probe that arrives
   early waits on the lock once, then hits the cache.

6. **Subsidiary boundary** (backend/app/domain.py,
   backend/app/api.py, backend/app/batch.py). Payment and
   PaymentIn gain an optional subsidiary (legal entity / company
   code), defaulting to None. When a payment states one,
   resolve_candidates hard-filters the ledger to that subsidiary
   immediately after the currency filter - the same boundary
   treatment, so not even an explicit remittance reference can pull
   another entity's invoice into the candidate set. When it states
   none (every seed, scenario and legacy upload), resolution is
   byte-for-byte the old behaviour; all 10 scenario packs and the
   canonical demo outcome pass unchanged. The subsidiary is a
   matching-time boundary taken from the submitted payment; it is
   not persisted on the payment row.

Refinements folded into items 2-4 in this revision: the anonymous
rate-limit bucket is now per client IP (one heavy visitor can no
longer 429 every other visitor on the public demo); the session
reaper also enforces a hard cap of 256 session files (oldest
first) and is triggered when a new workspace repository is
created; and the PDF fallback (no Unicode font available)
transliterates EUR/INR/GBP signs and typographic dashes instead
of emitting "?".

## Files in this pack

- Dockerfile (fonts-dejavu-core in the runtime apt install)
- backend/app/api.py (client-IP hop, per-IP anon bucket, limiter
  sweep, snapshot cap, session reaper + file cap, model warm-up,
  PaymentIn subsidiary)
- backend/app/ai.py (budget map sweep)
- backend/app/batch.py (subsidiary hard filter)
- backend/app/bundle_pdf.py (Unicode font registration +
  transliterating fallback)
- backend/app/domain.py (Payment subsidiary field)
- backend/tests/test_phase3_residuals.py (12 new tests)
- rust-kernel/src/main.rs (structured CLI errors)

## Deploy

Same flow as Phases 1 and 2: copy the files into your clone at the
same paths, commit, push, then Update service slatematch-app with
Force new deployment (the Rust CLI ships inside the image build,
and the Dockerfile change pulls the font package). After it is
live I will verify from the ALB: health, the canonical run, a PDF
export, and the kernel error path via the why-not/kernel-backed
flow.
