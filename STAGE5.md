# SlateMatch Stage 5 - cleanup plus Harsha's live-feedback fix list

Built 15 Nov 2026 on the Stage 4 live build. One pack: `slatematch-stage5-pack-v1.zip`.
Evidence lives in `~/workspace/slatematch-stage5/` (screenshots, verify-*.json, logs).
Suite: **168 passed** (baseline held exactly; no contract-test changes were needed -
every Stage 4 asserted string survived, including the casebar's full run id and
`aria-label="Case brief"`). TypeScript strict build clean. Flip rule applied:
`frontend/index.html` md5 equals `frontend/react/index.html` md5
(682529f5939698415e577783c0e246e1). Final bundle JS 601,940 bytes (Stage 4: 583,011).

## Item 1 - Black floating surfaces and form controls

Scope was extended mid-stage by Harsha's Policy Studio screenshot: form controls
are covered as well as floating surfaces. Two kit recipes were added to
`web/src/index.css`:

- `.glass-pop` for floating surfaces: a two-stop panel-tone gradient
  (rgba(67,67,69,0.94) to rgba(54,54,56,0.96)), backdrop blur 16px with saturation,
  an inset top light line, the kit border and a deep shadow. The measured problem:
  the old menu composited to #282828 against a #1e1e1f page ground (about 10/255 of
  separation, which is why it read as a black slab). The new recipe samples at
  **#414143** on the rendered page.
- `.glass-input` for text/number inputs, textareas and selects: panel-tone gradient
  (rgba(56,56,58,0.92) to rgba(45,45,47,0.94)), blur, ink text, and a focus state of
  a blue border plus a 3px rgba(61,117,232,0.18) ring. `.glass-select` is the quieter
  stop of the same family for the casebar and diff selects.

Surfaces moved to `.glass-pop`: the casebar More menu, the command palette, both
slide-over variants (match evidence, SAP payload), the docs drawer, the access-key
modal, the Copilot panel, the app toast, and the Approvals bulk bar (which had a
hand-rolled rgba(28,28,29,0.82) inline style, now replaced by the class).
Form fills moved to `.glass-input` (15 swaps): Policy Studio inputs, the Ledger
search, the key-modal input, the sessions input, the Copilot input, the Use Cases
builder inputs, the Upload textareas, the dispute Desk textareas and inputs, the
Mail composer (To field and body), and the match-detail why-not input.

Measured before and after (computed styles plus PIL pixel samples of the served
page, ground-truth workspace):

- More menu centre: #282828 -> **#414143**
- Policy Studio first input: flat rgb(30,30,30) -> glass gradient, samples **#323234**,
  value "0.9" legible in ink rgb(242,240,234); focus ring verified
- Mail composer textarea: literal black at 25% alpha -> glass gradient, samples **#323234**
- Key modal: glass-pop, samples #3f3f41; its input carries the glass gradient
- Copilot panel: samples #414143

Remaining `bg-black` uses are deliberate and audited: modal scrims (bg-black/55),
code wells inside evidence (bg-black/35), and Markdown code chips. Those are
displays and scrims, not controls or floating surfaces.

Evidence: verify-items.json (25 checks across two files, all passing), verify-pixels.json,
after-moremenu.png, after-palette.png, after-docsdrawer.png, after-keymodal.png,
after-copilot.png, after-bulkbar.png, after-slideover.png, after-forms-policy.png,
after-forms-mail.png. Weakest element: the palette's lower rows sample #343436 at
the panel's bottom edge because the list area shows through at lower alpha; the
panel itself is the glass recipe and reads clearly in the screenshot, but it is
the least lifted of the surfaces.

## Item 2 - Hover jiggle removed

All transform-based hover and press motion in the core workspace is gone:
`.glass-panel:hover` and `.glass-card:hover` are shadow-only (transform dropped
from their transitions), and `.pressable` no longer scales on :active. Hover
feedback is border and shadow only. The nav spring pill stays (it is navigation
state, not hover decoration).

Verified on the live build: a Dashboard stat card under a real mouse hover keeps
its bounding box exactly (210,322) -> (210,322) with computed transform `none`
before and during hover; a synthetic `.pressable` element computes transform
`none`. Evidence: verify-items.json, after-hover-card.png.

## Item 3 - Dashboard top restored (casebar slimmed)

The Stage 4 shell spent 161px above the view (casebar 109 + brief strip 44 + gap):
the Dashboard's first stat card sat at **y=376** (1600x1000, ground-truth
workspace). The casebar is now ONE strip in one panel, as a two-column grid:
left column carries the case identity with the verdict line under it; right
column carries the four stat cells with the controls row (tenant select, case
select, Export, More) under them, right-aligned. Nothing was dropped: case
identity, the four stats, tenant and case switching, Export and the More menu
are all present and functional, the full run id is never sliced, and the
aria labels "Case bar" and "Case brief" are unchanged. On small screens the
grid collapses to one column and everything stays reachable (after-casebar-phone.png,
menu opens as glass-pop).

Measured after: the strip is **107px**; the Dashboard's first stat card sits at
**y=322**. 54px of vertical space returned to every view (the strip is shell,
not a Dashboard-only change). Evidence: verify-geometry-before.json (y=376),
verify-geometry-final.json (strip 107, card y=322), after-dashboard-top.png,
after-casebar-phone.png. The Stage 4 chrome contract tests that touch the
casebar still pass unmodified (full run id, verdict-only brief, no mini tiles).

Honest note: a literal single line is arithmetically impossible at the shell's
container width (the four stat cells plus controls measure about 1363px against
1148px available) without truncating the run id or a stat, both of which the
Stage 4 rules forbid. The two-row grid inside one panel is the slim form that
keeps every element whole.

## Item 4 - Full gap audit (inventory-first)

Method: vanilla was inventoried element by element across all eleven views plus
the chrome (features, actions, every data element including secondary figures,
counts, statuses, timestamps, helper and status lines, and clarity elements that
survive the explanation diet), then each element was diffed against React. The
earlier parity harnesses checked named figures and features, which is how
unlisted elements slipped through; this audit enumerated first and checked second.

### Register - restored gaps (19)

| # | View | Element | Vanilla behaviour | React before | Disposition |
|---|------|---------|-------------------|--------------|-------------|
| R1 | Dashboard | Run history rows | Click a row, land on that run in Run Reconciliation | Rows inert | Restored: opens the run; a non-latest run opens in stored mode with the note and Back to latest run (verify-stored.json) |
| R2 | Dashboard | Open exceptions card | Click, land on the run filtered to exception rows | Inert | Restored: Run opens filtered with vanilla's banner ("4 of 15 matches shown, 4 exceptions below") and Clear filter |
| R3 | Dashboard | Staged panel | Execute button runs the staged batch | Text only | Restored: "Execute 6-Agent Run Now" runs via the Run view's streamed runner |
| R4 | Dashboard | Empty panel | Load demo case button | Text only | Restored: seeds the demo case, staged panel appears |
| R5 | Chrome | Casebar Open invoices / Payments staged cells | Jump to the Ledger panel, scrolled and flashed | Navigated only | Restored: intent + flash on #ledger-invoices / #ledger-staged |
| R6 | Chrome | Casebar Approvals cell + palette APR action | Jump to the approvals queue, scrolled and flashed | Navigated only (Stage 4 recorded APR as navigation-only, deliberately) | Restored to vanilla semantics; the Stage 4 recording is superseded by this stage's direction. On a staged case the live run button flashes instead |
| R7 | Run | Run comparison (toggleRunDiff) | Current vs previous run: straight-through, auto-posted, exceptions, decision changes | Missing entirely | Restored as RunDiff with vanilla's exact rules and honesty messages for 0 and 1 runs; casebar Latest run cell opens it |
| R8 | Forecast | Draft reminder (NAMED ROW A) | Per-row button, composer in Forecast, POST /api/v1/mail/reminder then /api/v1/mail/send, recorded in the Mail Hub outbox | Missing (Stage 2 deferred it to the Mail Hub) | Restored end to end and verified: draft from INV-1009's row, composer prefilled with the invoice's own subject, send records outbox kind `collection_reminder`, ref_id INV-1009, status `recorded_not_sent` with the true status line shown |
| R9 | Forecast | Dispute priority dispatch | Per-row button takes the user to the claim on the Dispute desk, draft ready; panel copy states the recovery rule | Button missing, copy shortened | Restored: button lands on Mail disputes with the claim focused and the composer prefilled; vanilla panel copy restored verbatim |
| R10 | Mail | Focus targeting (goMailFor) | Any category's item can be focused from other views | Chases only | Generalized: disputes, settlements and dunning focus by payment or invoice id, with vanilla's fallback order |
| R11 | Forecast | Staged gate | Execute affordance on the gate | Text only | Restored: full StagedGate with Execute |
| R12 | Evaluations | Staged gate | Execute affordance on the gate | Text only | Restored: full StagedGate with Execute |
| R13 | Run | Agent brief links | Brief carries the SAP payloads jump ("View SAP S/4HANA BAPI & EBRR Payloads") with its small print | Missing | Restored under the brief's source pill, small print verbatim |
| R14 | Dashboard | Recovery in flight figure | Click, land on the dispute claims in the Mail Hub | Inert | Restored: opens Mail on the disputes category |
| R15 | Dashboard | Unapplied cash in suspense figure | Click, land on the rows the cash is parked on | Inert | Restored: opens the Run exceptions filter (the residual rows) |
| R16 | Dashboard | Invoices settled figure | Click, land on the settled lines | Inert | Restored: opens the run's matches (settled lines live there; the Ledger serves open invoices only, in both stacks) |
| R17 | Upload | Handoff banner | When payments are pending: banner with count and total, Execute reconciliation button, staged rows highlighted on the Run page | Weakened (no banner flow) | Restored with vanilla's exact trigger (renders whenever pending exist) and semantics. One nuance: React executes via the streamed runner where vanilla's gotoRunStaged used the batch endpoint; same solver, same staged set, and the just-staged rows take the .hl-row wash, which now persists as vanilla's does |
| R18 | Ledger | Inline cell editing + Update & Re-Run | Click a cell, correct it in place (invoice amount and discount; payment amount, references, remittance), refusals carry the validator's reason, saved edits raise the re-run prompt | Missing (Stage 2 deferral; the React Run copy already promised "editable per wire in the Ledger", so its absence was also a truth defect) | Restored with vanilla's endpoints, validators and toast text; verified: -50 refused with "Edit refused: amount must be positive", a valid edit saves and raises "Update & Re-Run Solver" |
| R19 | Agent Health | Status bars | A bar's run opens from its detail | Bars inert below the detail text | Restored: "Open this run" in the selected bar's detail opens that run |

### Register - why-surfaces (NAMED ROW B), one row each

| Surface | Vanilla | React verdict |
|---------|---------|---------------|
| Match detail evidence (candidates, why this set won, derivation, counterfactual why-not) | Full evidence drawer | PRESENT, complete: decision line, deduction derivation steps, reasoning and rejections, cash-conservation derivation, why-not counterfactual both branches |
| Approvals queue why-held | decision_reason per held payment | PRESENT: rendered per row with the "Held for review" fallback |
| Run agent feed, Policy Agent | Counts, held breakdown, thresholds, a reading line | PRESENT: identical content. Vanilla has no per-payment decision lines in the feed itself; the per-payment why lives in the match evidence, which is present |
| Case verdict + agent brief reasoning | Verdict line in the brief strip; brief with reasoning | PRESENT: verdict in the strip, brief follows the displayed run (including stored runs) |
| Per-invoice settlement explanation | The API serves open invoices only; settled trace lives in Run matches, SAP documents and Mail settlements | PRESENT by structure: the Dashboard settled figure now drills to the run's matches (R16), so any payment's "why posted / why held or refused" is answerable from the React UI alone |

### Register - present by recorded decision (3)

- Vanilla's Methodology, Architecture and Product Thinking sections live in the
  React DocsDrawer (Stage 4 decision): present, relocated.
- Vanilla's data-info icon system was dropped globally in Stage 2 under the
  explanation diet: present by decision (the diet is unchanged this stage).
- Health's audit-trail feed is the recorded Stage 2 EasyUI adaptation, and its
  status bars are a React-only addition per the migration plan: present.

### Counts

Inventoried: all eleven views plus chrome. Weakened or missing found: **19, all
restored** (table above). Why-surfaces audited: 5, all present. Present by
recorded decision: 3. **Deferred: 0.** Every restoration was verified by clicking
it in the harness and landing in the right view and state, with API state as the
arbiter (verify-links.json: 28 checks; the single H needle failure in that file
is a harness case-sensitivity artefact, superseded by verify-rundiff.json PASS
on the same session state; stored mode proven separately in verify-stored.json).

A defect the audit surfaced and this stage fixed: shell intents (casebar and
palette jumps) were only consumed on a view's data load, so clicking Approvals
while already on the Run view did nothing. Run and Ledger now also poll for
late intents while mounted, so a jump lands without a remount.

## Item 5 - Skeleton loading states

`web/src/ui/Skeleton.tsx`: static, kit-toned blocks (`.skel`, no animation of any
kind - verified computed animation-name `none`) shaped per view: stat cards for
Dashboard, table for Ledger and SAP, panels for Health, Upload, Cases,
Evaluations and Mail, a run layout for Run, a form for Policy, a chart layout
for Forecast. All eleven views show their skeleton on initial load instead of
the one-line Loading text.

Evidence (API delayed 1600ms in the harness): Dashboard 37 skeleton blocks,
Run 39, Ledger 57, then the settled states on the same views
(verify-skeletons.json, after-skeleton-*.png, after-settled-*.png).

## Item 6 - Cleanup and DELETIONS

Verification (verify-cleanup.json): md5 comparison of the root `frontend/css`
and `frontend/js` against the vanilla copies; the served asset lists of `/`
and `/vanilla/` fetched from the running app; grep of the backend, web/src and
the Dockerfile. The root entry loads only `/react/assets/*`. Vanilla loads its
own copies through relative paths under `/vanilla/`.

### DELETIONS - for Harsha to delete in his clone before committing

Byte-identical duplicates of the vanilla copies, referenced by nothing served:

- `frontend/css/livecube.css` (md5 3cc7387d082f4cd5b7fd596d33669b30)
- `frontend/js/assist.js` (md5 9907daae9ea24b5e44cd37c4019c1e36)
- `frontend/js/insight.js` (md5 8801a238db8bd9d5949b20c3a3b25300)
- `frontend/js/operate.js` (md5 a279043694fc401f6dbb856cb09827b9)
- `frontend/js/orbs.js` (md5 89b3636d6889a7832289f69ac7147176)
- `frontend/js/state.js` (md5 ef4f82110c30413aac79025c2098eb46)

### DO NOT DELETE - a correction to the stage brief

`frontend/js/vendor/` is NOT a duplicate in the operative sense:
`web/src/ui/Orb.tsx` imports `frontend/js/vendor/orbs-engine.js`, and the
Dockerfile copies `frontend/js/vendor` into the web-builder stage for exactly
that import. Deleting it breaks the React build. Keep `frontend/js/vendor/`
(orbs-engine.js and THINKING-ORBS-LICENSE.txt) intact. The `/react/` path also
stays, per the standing decision. `frontend/vanilla/` is untouched
(byte-identical rule), and the backend is untouched.

## Item 7 - Data clarity and data direction pass

Reframed per Harsha's correction: the centre of the pass is the data itself
(what each figure counts, its scope and denominator, units visible, charts
self-explanatory, no orphan numbers), and its direction (headline figures drill
to their composing records; outcomes trace back to inputs; each view shows what
arrived, what the engine did, what is waiting, what happens next). The
layout-hierarchy criteria stayed as support. No figure, copy meaning or
behaviour changed in this pass; presentation and labelling only, plus the
drills restored in item 4 (which are the direction mechanism).

Per-view rationale (headline figures, labels and denominators, drill targets):

- **Dashboard.** Focal: the stat row. Autonomous resolution 93.8% (of the last
  run's payments; the note decomposes it into zero-touch, solved-and-queued and
  refused shares). Touchless 75.0% (of all payments in the run). Cash posted
  $597,100.00 (net applied on auto-posted matches, last run). Open exceptions 4,
  drills to the run filtered to exactly those rows. Outcome panel: hours 2.4 h
  (auto-posted payments x a labelled 12-minute assumption), line touchless 88%
  (of all matched lines), recovery $3,903 drills to the Mail dispute claims,
  suspense $22,120 drills to the residual rows, settled 16 drills to the run's
  matches, latency 9.3 ms (mean per-match solve time).
- **Run Reconciliation.** Focal: the matches grid under the run summary line
  (matches and exceptions counted). Every row opens its evidence; the brief
  carries the verdict with its reasoning and the SAP payloads jump; the
  approvals queue states each held payment's reason; the exceptions filter
  banner states "X of Y matches shown, Z exceptions below".
- **Ledger.** Focal: the open invoices table. Helper lines under both tables
  state the edit semantics and the re-run consequence; the dirty block counts
  saved edits. Direction note: settled invoices leave the open book in both
  stacks by design, and the settled trace runs through Run matches, SAP
  documents and Mail settlements (the Dashboard settled figure drills there).
- **Forecast and Collections.** Focal: the stat row over the fan chart. Open
  receivables $404,080.00 (remaining balance of every invoice still open after
  the latest reconciliation). Expected in 30 days and in 8 weeks are
  probability-weighted, stated on the cards. At risk $210,000.00 (1) states its
  rule (beyond 45 days, or under a 50% chance inside the horizon). The fan
  chart now carries its own legend: the shaded band is the P10 to P90 range
  for the week, the line and dots are P50, and height is cash expected that
  week. Week rows drill to their invoices ("N - view"); collections rows draft
  reminders in place; dispute rows dispatch to the claim.
- **Outbound Mail Hub.** Focal: the category queues, each tab carrying its
  count. Every send lands in the Outbox with its true status (sent, recorded -
  not sent, or failed), so the direction of every message is visible after the
  fact.
- **Upload Center.** Direction is the view's spine: arrive (drop or paste),
  parse (extracted fields shown), stage (staged table), execute (handoff banner
  with count and total). The banner is the focal element whenever payments wait.
- **SAP BAPI & EBRR.** Focal: the posting documents. Each document is a balanced
  DZ clearing journal per cleared payment, traceable back to its match from the
  Run brief's jump.
- **Use Cases.** Focal: the case cards, each carrying its counts and story with
  both stage actions (load, load and run).
- **Policy Studio.** Focal: the three policy groups. The preview is the drill:
  it shows the effect of the values on the standing case before anything is
  saved, and the spec sentence states that a saved value changes the next run.
- **Evaluations.** Focal: the metric cards, which carry their denominators from
  the Stage 2 pass. Weakest view, honestly: the metrics are evaluation
  aggregates, so there is no record-level drill beneath them - the underlying
  records are evaluation cases, not product records. Vanilla has the same
  property; the direction verdict for this view is "partially dead end, by the
  data's nature", recorded rather than papered over.
- **Agent Health.** Focal: the agent cards with the status bars beneath. Bars
  now drill to their run (R19); model quality figures state their denominators.

Before and after full-view screenshots for all eleven views:
before-view-*.png and after-view-*.png in the evidence folder. One defect the
after screenshots caught and this stage fixed: the restored Draft reminder
buttons overflowed the collections panel at desktop width; the customer cell
now wraps and the action uses a compact ghost button, verified fully inside
the panel (button right edge 1374 vs panel 1390).

## Weakest elements, per item, honestly

1. The palette's bottom edge is the least lifted surface (see item 1).
2. Item 2's removal is total; the only motion left on hover anywhere in the
   core workspace is the nav pill's spring, which is state, not decoration.
3. The casebar verdict wraps to two lines in its column; the strip is one
   panel and 54px shorter, but the verdict is not single-line at desktop width.
4. The gap register is only as complete as the inventory; the method was
   inventory-first this time, and every inventoried element has a row or a
   verdict above.
5. Skeletons are shaped approximations, not pixel-perfect ghosts of each view.
6. The deletions still need Harsha's hand in his clone (a zip cannot delete),
   and the vendor correction means `frontend/js/` survives as a directory.
7. Evaluations remains the weakest view for data direction (see item 7).

## Not verified

- The locked branch of the access-key copy (no live locked server; unchanged
  from Stage 4, contract-tested, text verbatim).
- Nothing in this stage was deployed by me: Harsha pushes and force-deploys,
  and the parent verifies from the ALB afterwards.
