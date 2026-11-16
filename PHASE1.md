# SlateMatch enterprise hardening - Phase 1 pack v2 (16 Nov 2026)

Built and verified in the HighRadius / SlateMatch core chat, from the
verified triage of the external enterprise review. Four items were in
scope; two needed code, one was dropped by Harsha's decision, and one
turned out to be already fixed.

## What is in this pack

1. **Dockerfile** - the web-builder stage's React entry is now copied
   over the root `frontend/index.html` in the image. Since the Stage 4
   flip the React build is the root app; until now the served entry
   stayed correct only because every pack kept the committed root
   entry in sync by hand. The built entry is now authoritative.

2. **backend/app/solvers.py + both why-not consumers** -
   `why_not_invoice` now genuinely re-solves with the invoice forced
   in: the invoice is committed (both discount variants), the
   remaining amount is re-solved over the other candidates with
   solve_milp itself, and the API returns forced_residual_cents,
   forced_invoice_ids, base_residual_cents and residual_delta_cents
   alongside the legacy solo_residual_cents. The React MatchDetail
   (web/src/views/MatchDetail.tsx) and the vanilla drawer
   (frontend/js/operate.js) now present the forced re-solve's numbers
   and say so. A regression test
   (backend/tests/test_milp_solvers.py::
   test_why_not_genuinely_resolves_with_invoice_forced) locks the
   behaviour: forcing INV-3 re-solves to {INV-3, INV-4} at residual 0
   where the old solo arithmetic reported 5000.

3. **Run view casebar refresh - NO CODE CHANGE, already fixed.**
   Verified empirically against this tree (Stage 6 source) in a real
   browser: staged case shows LATEST RUN Pending; after clicking
   "Run the active case live" and the stream completing, the casebar
   reads the new run id + COMPLETED in place, no reload. The Stage 6
   shell-refresh rewrite fixed the Stage 5D defect. The fix reaches
   production when the Stage 6 pack is deployed; the live site still
   runs Stage 5 v4, where the defect is present.

## Dropped from v1 at Harsha's decision (16 Nov 2026)

The GEMINI_MODEL default change (backend/app/ai.py) is NOT in this
pack. Production sets GEMINI_MODEL explicitly in the task definition
(gemini-3.5-flash-lite) and Gemini has worked perfectly on it; the
audit's item concerned only the code default used when no env setting
exists. Harsha's call: leave it as it is. ai.py is unchanged.

## Verification (all run 16 Nov 2026)

- Full backend suite: **170 passed** (169 before + the new test),
  run with the v1 contents; the ai.py revert in v2 is covered by the
  targeted re-run of the solver, parse-fallback and copilot tests
  (15 passed) - ai.py is byte-identical to the pre-Phase-1 file.
- Web build: clean; the served bundle contains the forced-residual
  consumer code.
- API smoke on a live local server, demo case: why-not for P1 vs
  INV-1019 returns forced residual $5,400 with set {INV-1019,
  INV-1005} and delta $2,630 - the old code reported a solo figure of
  $42,150 for the same question.
- Browser test for item 3 as described above.

## Deploy

Apply AFTER the Stage 6 pack (slatematch-stage6-pack-v1.zip), or
together with it in the same commit - this pack's MatchDetail.tsx is
written against the Stage 6 tree. Copy the files over your clone at
the same paths, commit, push, then Update service with Force new
deployment on slatematch-app. CI failing would block a bad build; the
running service is untouched until the new deployment succeeds.
