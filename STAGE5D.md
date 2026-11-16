# Stage 5D - fix pack v4 (16 Nov 2026): the run option near the case, and the case expansion, restored to the shell

Supersedes the v3 pack (slatematch-stage5-pack-v3.zip), which was
never deployed. Everything in v3 stands except the one behaviour
below. Deploy is Harsha's push and force-deploy; live verification
from the ALB follows.

## 1. The gap, in Harsha's words

"Where is run option near the case as in vanilla and where is
case expansion?"

Verified against the vanilla source before designing:

- In vanilla, the casebar's four stat cells are all clickable
  controls (class cclink). Open invoices opens the Ledger at
  those invoices, Payments staged opens the Ledger at the
  staged payments table, Approvals waiting jumps to the
  sign-off queue, and Latest run is the run option near the
  case.
- Clicking Latest run calls toggleRunDiff
  (frontend/vanilla/js/assist.js): it navigates to the Run
  view AND expands the run comparison panel in the shell
  directly under the casebar, comparing the latest run with
  the previous one. Clicking again collapses it. With fewer
  than two runs it shows vanilla's explanatory text instead
  ("Only one run exists so far - run the batch again (or load
  another case and run it) and this compares the two." /
  "No runs yet - load a case and run the batch first.").

In React v3 the comparison existed but rendered inside the Run
view, reached through a slate-run-diff intent, and the Latest
run cell carried no visible sign of being clickable. On the
frames, and in use, both the run option and the expansion read
as absent. On the live site (still the Stage 4 build at the
time) the restored panel was not present at all.

## 2. The fix: the comparison moves to the shell

- RunDiff now renders in the shell directly under the casebar
  strip (under the brief row), on top of whichever view is
  showing, exactly where vanilla's #run-diff sits. App.tsx owns
  the open state ({diffOpen && <RunDiff onClose=...>}); the
  slate-run-diff intent is gone from Casebar.tsx and Run.tsx
  (grep count 0).
- Clicking the Latest run cell navigates to the Run view and
  expands the panel; clicking it again collapses it. Vanilla's
  empty states are preserved verbatim in behaviour (the one-run
  text above; the no-runs text likewise).
- The Run view no longer renders a second copy. Its own
  "Compare runs" button toggles the same single shell panel.
- All four stat cells read as controls, as vanilla's cclink
  cells do: pointer cursor, a hover state (background lift and
  the label turning blue2, no transform), and vanilla's title
  texts carried over word for word:
  - Open invoices: "Open the LiveCube AR Ledger - it lists
    exactly these open invoices"
  - Payments staged: "Open Ledger & Staged Wires at the staged
    payments table"
  - Latest run: "Compare the latest run with the previous one"
  - Approvals waiting: "Jump to the sign-off queue on Run
    Reconciliation"
- The Active case cell stays non-clickable, as in vanilla.

## 3. Click-verification, all four cells (verify-cells.cjs, 28/28)

Part A, ground-truth session, read-only, real mouse clicks:

- Titles and pointer cursor on all four cells: pass.
- Hover on Latest run: background lifts (transparent to
  rgba(255,255,255,0.07)) and the label turns blue2
  rgb(163,192,247); no transform.
- Open invoices: lands on Ledger, the invoices panel is
  flashed (frame after-cell-ledger-invoices.png).
- Payments staged: lands on Ledger, the staged payments table
  is flashed (frame after-cell-ledger-staged.png).
- Approvals waiting: lands on Run, the maker-checker sign-off
  queue is flashed (frame after-cell-approvals.png).
- Latest run: expands exactly ONE shell panel, sitting
  directly under the strip (panel top 171px, strip bottom
  155px); with one run in the workspace it shows vanilla's
  one-run text verbatim (frame after-rundiff-onerun.png);
  a second click on the cell collapses it.
- The Run view's Compare runs button opens the same shell
  panel (count stays 1) and closes it again.

Part B, throwaway session, two real runs (see section 4):

- Latest run expands the panel under the strip with both runs
  named (Current run_c902da73fc08, Previous run_2f62757fbae6
  in the recorded run of the script) and real figures:
  straight-through rate 75.0% to 100.0% (+25.0 pts),
  auto-posted 12 to 3 (of 16 to 3 payments), exceptions 4 to
  0, decision changes 0 with its line "No payment changed
  decision between these two runs."
- THE KEY FRAME: screenshots/after-rundiff-expanded.png in
  the evidence folder - the comparison expanded directly
  under the casebar strip over the Run view.
- The open panel persists when navigating to the Dashboard
  (shell state, as in vanilla); a second click on the cell
  collapses it there too.

## 4. How the two runs were created (verification recipe, for the record)

Both runs are real executions on a throwaway workspace
session; the ground-truth workspace was never mutated.

- Run 1: the Dashboard's own flow - Load demo case, then the
  staged panel's Execute 6-Agent Run Now (the streamed run).
- Run 2: three invoices appended to the ledger and a payments
  CSV imported against them through the product's own import
  endpoints (the Upload Center's APIs); the payments import
  reconciles as a batch, which is run 2. Its three payments
  settled the three appended invoices exactly.

Why not the obvious recipes (found during verification,
recorded so nobody re-tries them blind):

- Loading another case wipes the workspace run history
  (verified at the API level: after a case load the runs list
  is empty), so two runs from two cases can never coexist.
- Re-running an already-executed case through the stream
  creates no second run, and a batch posted against an
  executed workspace processes 0 payments. A second real run
  needs newly staged payments in the same workspace lifetime,
  which is what the import provides.
- A completed streamed run does not refresh the casebar's
  Latest run cell in place; the cell shows the new run after
  a reload, when the shell refetches the workspace. Run
  completion in the script is therefore polled on
  GET /api/v1/runs, and each run id is read from the casebar
  after a reload. This stale-cell behaviour predates this
  pack, is outside its scope, and is named here as this
  pack's weakest adjacent element rather than left hidden.

Two harness artefacts, also recorded: the panel's figure
labels are CSS-uppercased, so innerText reads them in caps
and the script's needles are case-insensitive; and one Part A
click flaked when it landed mid view-enter choreography, so
that click carries one retry with a recomputed point.

## 5. Gates, all on the final build

- Test suite: 168 passed (baseline 168). ZERO contract
  changes: no test was edited and no assertion weakened. The
  Casebar's standing pins (unsliced run id, "Case brief"
  aria label) still hold; the removed slate-run-diff intent
  was an internal hand-off, replaced by shell state in
  App.tsx, and no contract named it.
- TypeScript strict: clean (the build runs tsc before vite).
- Figure parity: ALL 22 checks passed against the
  ground-truth workspace (verify-parity.json), including the
  casebar values read from the strip and the two structural
  checks that the sidebar holds no case details.
- Dark-on-dark audit: 1,843 text nodes, ZERO under 4.5:1
  (verify-contrast-final.json).
- Spot-checks (verify-spotchecks.json): hover immobility;
  the Dashboard exceptions drill lands on "4 of 15 matches
  shown"; skeletons render statically in the shell (37
  blocks) and settle to the real figures; the Draft reminder
  flow end to end on a fresh session (outbox gains the
  collection_reminder for INV-1009 with the true status
  recorded_not_sent).
- Cell click-verification: 28/28 (verify-cells.json),
  sections 3 and 4 above.
- Vanilla byte-identical: frontend/vanilla/index.html md5
  73b0874b216bc87dd96180a5ecb93683.
- Flip rule re-applied after the rebuild: frontend/index.html
  copied from frontend/react/index.html, md5s equal
  (e0b53bdeaa19413061860c9112a04ce7).
- No em dashes in web/src.

## 6. Deletions in your clone (unchanged from v1, v2 and v3)

The pack cannot delete files from your clone. Before
committing, delete exactly these, with md5s so you can
confirm you are removing the right files:

- frontend/css/livecube.css (md5 3cc7387d082f4cd5b7fd596d33669b30)
- frontend/js/assist.js (md5 9907daae9ea24b5e44cd37c4019c1e36)
- frontend/js/insight.js (md5 8801a238db8bd9d5949b20c3a3b25300)
- frontend/js/operate.js (md5 a279043694fc401f6dbb856cb09827b9)
- frontend/js/orbs.js (md5 89b3636d6889a7832289f69ac7147176)
- frontend/js/state.js (md5 ef4f82110c30413aac79025c2098eb46)

WARNING, unchanged: never delete frontend/js/vendor/. The
React build imports the orbs engine from it (Orb.tsx imports
orbs-engine.js) and the Dockerfile copies it; deleting it
breaks the build.

## 7. Pack

slatematch-stage5-pack-v4.zip: full web/src,
frontend/index.html, STAGE5D.md at the root. Nothing in this
pack touches the backend, the vanilla tree, or any test.
