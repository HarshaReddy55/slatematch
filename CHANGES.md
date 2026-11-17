# SlateMatch deploy pack - Kiln adaptation v1 (18 Nov 2026)

## What this pack is

The COMPLETE current SlateMatch tree, packed as one deploy. It supersedes
two packs that were built but never deployed:

- slatematch-fix-pack-v7.zip (audit panel rework, remittance rebuilt in
  vanilla order, replay banner, case-switch flash fixes, logo reverted to
  the v2 asset)
- the optimisation pack v3 (77 files: cumulative nav pack, moat features,
  Postgres dual-mode, optimisation)

Both are already inside this tree, together with everything else the core
chat built after them. Deploy THIS pack only. Do not deploy v7 or the
optimisation pack separately.

## Part B: the Kiln adaptation (new in this pack)

The Kiln Workspace design (Sean Galt, uberdesigner.ai), approved by the
owner on 18 Nov 2026, applied to the React stack as presentation only.
Every control, flow, figure and behaviour is the platform's own; where
skin and function conflicted, the skin yielded. No data was removed,
reworded or re-routed: the adaptation touched only the presentation
seams listed below, verified by a line-by-line diff audit.

Changed files:

- web/index.html - Geist font loaded (JetBrains Mono kept)
- web/src/index.css - Kiln palette tokens (ground #070709, panel #151518,
  raised #1a1a1e, white-alpha hairlines, cool greys; product blue and
  semantic colours unchanged), Geist stacks, ground glow, corner-radius
  discipline (square utility resolves to 12px; fields 8px)
- web/src/App.tsx - the app sits in one floating rounded panel (28px) on
  the near-black ground; rail is label-only with a soft active pill
  (numbers and group caps hidden by CSS, still in the DOM); content
  runs full width
- web/src/ui/Panel.tsx, web/src/ui/StatCard.tsx - 18px radius
- web/src/ui/Button.tsx - 9px radius
- web/src/ui/Casebar.tsx - borderless, hairline top and bottom
- web/src/views/Cases.tsx - additive only: each scenario card gains a
  muted marble band whose frosted strip prints the card's figures in
  mono from the same bindings the chips row uses; the chips row, story,
  proves line and both actions are untouched
- web/src/assets/kiln-art/card-01..11.png - the 11 card artworks (new)
- backend/tests/test_ui_contracts.py - the Stage 6 palette contract now
  asserts the Kiln muted tones (owner-approved supersession, React stack
  only); all other assertions unchanged

Untouched, deliberately:

- The logo: the built bundle ships logo-glass-ygqXbPkV.png, the identical
  v2 asset (same content hash as the v7 pack). Per the owner's order of
  16 Nov 2026 the logo is closed.
- The vanilla stack under frontend/ (its own CSS and palette), except
  frontend/index.html, which was re-copied from the fresh React build
  per the standing maintenance rule.
- Every backend file, every API contract, every other view's logic.

## Verification (run on this exact tree, 18 Nov 2026)

- Frontend build: clean. Bundle index-Dx259ceX.js.
- Backend suite: 265 passed, 1 failed (see Known issue). The UI contract
  suite passes 32/32 with the updated palette contract.
- Live local run of the packed tree: demo case staged, run executed -
  10 of 16 payments auto-posted, 5 held (P4, P6, P7, P14, P16), 4
  exceptions, cash applied $411,800.00, dispute recovery $3,903.00,
  brief headline in the canonical form. All figures match ground truth.
- Visual inspection at full size: Dashboard, Use Cases (all 11 cards
  with art bands and figure strips), Run Reconciliation (full 16-row
  staged table), Upload Center (remittance in vanilla order), Forecast.
  Nothing missing, nothing clipped.

## Known issue (pre-existing, not from the adaptation)

backend/tests/test_moat_pack.py::test_collections_escalation_drafts_and_idempotent
fails on this tree: a second collections escalation in the same day is
not suppressed. The defect sits in the undeployed moat work from the
core chat; the adaptation changed no backend code (the failure is
identical with and without it). Tests do not run in production, so the
deploy is not blocked by it, but the collections escalation behaviour
should be fixed in the core chat before that feature is relied on.

## Deploy

1. Unzip over your GitHub clone of the repo (paths are repo-root
   relative: backend/, web/, frontend/, Dockerfile, ...).
2. Commit and push.
3. Force new deployment on the slatematch-app ECS service.
4. Post-deploy check from the UI chat: /health, the React bundle hash,
   one canonical run, remittance order, audit counts line.
