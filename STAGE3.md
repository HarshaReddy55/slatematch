# SlateMatch React migration, Stage 3: the operate core

Six views migrated to React in the existing glass and motion kit:
Run Reconciliation (04) with the maker-checker Approvals queue and
the Dispute Desk in-page, Upload Center (03), SAP BAPI and EBRR
(05), Use Cases (02), and the Outbound Mail Hub (08). Same
endpoints, same payloads, same maker-checker semantics as vanilla.
No backend changes. The only pre-existing web source file touched
is App.tsx (routing); every Stage 3 view is a new file.

Verification stack, all on the final build:

- Parity: 77 of 77 checks against the vanilla ground truth
  workspace (verify-parity-final.json in the evidence folder).
- Actions: 36 of 36 checks on fresh seeded workspaces
  (verify-actions-final.json).
- Adversarial supplement: 10 checks, 2 initial failures, both
  traced to one real defect, fixed and re-verified 5 of 5
  (verify-adversarial-final.json, verify-adv3-rerun.json).
- Full suite: 159 passed (152 baseline plus 7 new Stage 3 UI
  contract tests, now merged into backend/tests/
  test_ui_contracts.py and included in this pack).
- TypeScript strict build clean. Vanilla tree byte-identical to
  its pre-Stage-3 checksums (all 9 files).

## The 16:50 action failures: verdict

The 16:50 verify-actions.json showed 12 failures, all in the
Approvals decision checks. Verdict: harness artefacts, not app
defects. Evidence:

- The 16:50 harness located decision buttons inside a <div>
  wrapper (the React Panel renders a <section>), read invoice
  state from a wrapped shape the API does not return (GET
  /api/v1/invoices returns a bare array), and expected a bulk
  button label the app never rendered.
- The follow-up runs confirm it: run 2 died on a harness
  ReferenceError (gotoView undefined), run 3 never connected
  (local server down, ECONNREFUSED on port 8158).
- With the harness corrected and fresh workspaces, every one of
  the 16:50 failures passes: approve P16 (decided label, queue
  5 to 4, INV-1007 settled out of the open ledger), park P6
  (parked label, queue 5 to 4, no invoice settled), bulk
  (bar at 2 selected, note reports 2 posted with the refusal
  left, queue drops to 3), reject P4 (queue 5 to 4, INV-1005
  still open), double-click (exactly one decision).

## Two real defects found in this completion run, both fixed

1. Upload Center: the payments textarea import never showed its
   result. The /api/v1/payments/import response carries no route
   field (the file endpoint's does), and the React result region
   keys off route, so a pasted-CSV import landed, reconciled and
   navigated to Run with no confirmation, no mapping chips and
   no run summary ever rendered. Vanilla renders the result
   unconditionally. Fix: the textarea import tags its result as
   the csv route, exactly what it is. One line plus a comment in
   Upload.tsx. Re-verified: result region renders (screenshot
   react-upload-result-final.png), action F green.
2. Run Reconciliation: a double-click on a run button started
   two runs (2 runs stored, 10 approvals instead of 5). The
   guard read React state, which two clicks in one tick both
   see as not-running; vanilla disables the button
   synchronously (busyBtn). Fix: a synchronous ref guard on
   both run paths and on the live-proof mutation button, the
   same pattern the Approvals queue already uses. Re-verified:
   exactly one run and 5 approvals under a same-tick
   double-click on each button (verify-adv3-rerun.json).

## Per view

### Run Reconciliation (Run.tsx, Approvals.tsx, Desk.tsx, MatchDetail.tsx)

Adaptations: Obsidian Outcomes Cumulative Chart for the run
record (cumulative outcome area series, hand-rolled SVG, zero
dependencies); Obsidian Analytics agent-payload inspection;
kit DataTables throughout. Sources: blueprints 01 and 02.

Parity (ground truth run, executed once): run id and the line
"15 matches, 4 exceptions"; chart legend 10 auto-posted, 5 held,
0 needs investigation; agent strip figures (16 wires in, 20
candidates, 15 wires solved, 3 claims judged, 10 auto-posted
5 held, 10 drafts composed); verdict line; brief headline
"10 of 16 payments posted themselves; 5 need a human"; queue
title "5 waiting"; dispute claim $4,200.00 with win probability
0.94 and expected recovery $3,903.00; match detail slide-over
figures for P2 and P6.

Actions: streaming run completes with batch_done summary
"10 of 16 auto-posted" and stores a run with 5 approvals;
non-streaming run same totals; Approvals A to D and L above;
live-proof mutation and exception parking covered by parity
state checks.

Adversarial: empty state verbatim; API-down LoadError; reduced
motion renders fully; run double-click defect found and fixed
(see above); approvals double-click exactly one decision.

Weakest element: page length. The view carries the full vanilla
surface (record, agents, staged gate, verdict, brief, matches,
exceptions, queue, desk) and is long. It mirrors vanilla's own
structure deliberately; splitting it is a Stage 4 chrome
question, not a Stage 3 change.

### Upload Center (Upload.tsx)

Adaptations: the long-queued Stack Glass drop-zone lighting
(intake item 5) lands here: on drag-over the zone takes the
brand blue border and glow on the kit motion tokens, clearing
on leave and drop; upload queue rows with real progress to
Done. Sources: blueprint 03, ledger intake item 5.

Parity: sample invoices import shows "4 invoices imported"
with the replaced-ledger line and fingerprint; open table
shows INV-2001 to INV-2004; sample payments result shows the
imported and reconciled line with run figures; capture parse
shows the remittance fields and verification notes; stage wire
adds exactly one staged payment and one pending row.

Actions: E, F, G green (36 of 36 run). F was the real defect
above; it now passes with the result region rendered.

Adversarial: empty textarea import shows the paste-first error
and the view survives; a corrupt PDF on the invoices dropzone
lands in the queue as Import failed with the server error in
the row note, view intact; API-down and reduced-motion states
covered in parity.

Weakest element: the payments result sits below the fold after
a long invoices panel, so the confirmation is easy to miss in
the 900ms before the shell moves to Run. The result now
renders (the defect fix); whether it should also hold the
navigation longer is a product call, left as vanilla timing.

### SAP BAPI and EBRR (Sap.tsx)

Adaptations: Obsidian Analytics slide-over for the raw BAPI
payload (kept raw for evidence, Copy payload button); kit
StatCards and DataTable. Source: blueprint 04.

Parity: 10 documents; balanced journal total $414,050.00;
ASC 606 reserve $4,200.00; P1 grouped GL total $52,000.00 and
balanced; payload in the slide-over byte-equal to the API's
JSON.stringify of bapi_payload.

Actions: document chip switching drives the GL table; payload
slide-over opens from the selected document. No mutations
exist on this view in vanilla or React.

Adversarial: empty workspace shows the vanilla empty copy with
no fake-zero cards; staged-not-run gate; API-down LoadError;
reduced-motion slide-over instant.

Weakest element: the document chips row is a long wrap at 10
documents; acceptable at this count, worth a select control if
document counts grow.

### Use Cases (Cases.tsx)

Adaptations: Refero and Linear density for the scenario cards
(story clamped to three lines, full text in the DOM, per-card
Reveal expand); the Custom Case Builder promoted above the
grid per the audit. Source: blueprint 05.

Parity: card chips equal scenarios.json per pack; "What it
proves" byte-equal; verdict panel for split-exact all-pass;
builder defaults identical to vanilla.

Actions: staging split-exact lands 12 staged payments and the
shell moves to Run; builder auto-calculate shows the $1,000.00
wire on defaults and the custom case runs with CUSTOM-1
matched (actions J and K green).

Adversarial: long stories clamp and expand without layout
break; API-down LoadError; empty scenarios line; rapid stage
clicks disabled while loading (same busy pattern as vanilla).

Weakest element: the verdict panel renders below the grid, so
running a pack's checks from a top card scrolls the result out
of view. Vanilla has the same placement; noted, not changed.

### Outbound Mail Hub (Mail.tsx)

Adaptations: EasyUI Activity Feed for the Outbox (timestamp
first, kind chip, honest status pill, feed slide-in on first
load, RefreshFade on refetch); fixed-footer preview pane so
Send and the true status line stay pinned while a draft
scrolls. Source: blueprint 06.

Parity: tab counts equal the hub payload (disputes 1, chases
4, settlements 10, dunning 7, outbox 20 on the ground truth
workspace); dispute card figures equal the hub payload;
mailbox truth pill shows "No mailbox configured - sends are
recorded, not sent".

Actions: H green. Drafting the dispute claim and sending it
shows the true status "Recorded - not sent (no mailbox
configured)" and the outbox grows by exactly 1 with kind
dispute_claim. No send is ever dressed up as sent.

Adversarial: empty workspace hub copy; loaded-not-run gate
line; API-down LoadError; long subjects wrap in feed rows.

Weakest element: the preview pane and the stream list compete
for width at narrower viewports; fine at the console's working
width, worth a stacked layout pass if the console ever targets
small screens.

## Pack contents and deploy

- web/src/ complete (all views, lib, ui, App.tsx, index.css).
- backend/tests/test_ui_contracts.py with the 7 Stage 3
  contract tests merged in.
- This file at the pack root.

Deploy is the established flow: copy into the GitHub clone,
commit, push, force-deploy the slatematch-app ECS service,
then verify from the served ALB endpoints (health, /react/
bundle hash against a fresh local build, one view per Stage 3
surface). Nothing in this pack needs a backend or
infrastructure change.
