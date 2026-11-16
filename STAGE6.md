# STAGE 6 - VANILLA FIDELITY RESTORATION

React had drifted from vanilla's organisation. This stage restores
vanilla as the spec, item by item, on top of the live Stage 5 v4
tree. Frontend only. The backend is untouched: the API already
stages only, and every fix below is in `web/src`.

Pack contents: full `web/src`, `frontend/index.html` (plus
`frontend/react/index.html`, identical), the updated
`backend/tests/test_ui_contracts.py`, and this file. Copy them into
the clone at the same paths, commit, push, force a new deployment.

Nothing in this pack deletes files. The DELETIONS list from Stage 5
is carried over unchanged at the end of this document.

## Item 1 - Run semantics (the huge error)

Vanilla spec. Loading a case stages it only. The workspace reports
`run_status: "staged"` and `latest_run: null`; the runs list is
empty. Vanilla blanks every run surface at load, the Dashboard shows
staged placeholders, the brief shows its readybox ("Status: N wires
staged & verified - ready for 6-agent MILP reconciliation. Nothing
has been solved yet") with the "Run reconciliation on N staged
payments" button, and Forecast, Evaluations, SAP and Mail show the
staged gate card ("Waiting for the reconciliation run... nothing
here is pre-computed") with the "Execute 6-Agent Run Now" button,
which goes to Run and starts the stream.

Reproduction (identical steps in both apps, fresh sessions: seed
load, execute, then switch to "Split payment across two invoices"
from the Dashboard; then an uploaded-ledger case). The backend was
proven clean first: `POST /api/v1/cases/{cid}/load` returns
`run: None`, and after the switch the runs API returned `[]` in
both apps. Vanilla after the switch: staged ribbon, readybox, no
figures. React after the switch: the casebar updated to the new
case, but the Dashboard still showed the previous case's 93.8% and
cash figure, and no gate.

Root cause. Only the casebar listened for the workspace refresh
event. No view did. Views loaded once on mount, so switching a case
from the casebar left the previous case's figures standing as the
new case's results. Vanilla reloads every view keyed on its
workspace generation and blanks run surfaces inside `loadCase`.

Fix. A shared `useWsRefresh` hook (lib/chrome.ts) now reloads every
view on the refresh event: Dashboard, SAP, Ledger, Forecast, Mail,
Policy, Evaluations, Agent Health, Upload. Run reloads too, guarded
so it never interrupts a live stream. The Dashboard's invented gate
copy was replaced by the shared gate with vanilla's structure and
figures. Case staging from Use Cases now dispatches the refresh,
clears the empty flag and invalidates the brief cache; Stage goes
to the Dashboard, Stage & Run goes to Run and starts the stream,
exactly as vanilla. A first visit auto-stages the demo case
(staged only, never executed) with vanilla's toast, unless the
workspace was explicitly reset to empty. Run completion and
approval decisions now dispatch the same refresh vanilla fires, so
the brief and casebar update in place.

Evidence. verify-runsemantics.cjs: 25/25. Boot auto-stages with the
gate primary and an empty runs list; Execute creates exactly one
run; the switch removes 93.8% and $411,800.00, shows the gate with
the new case's totals (18 open invoices, 12 wires, $230,318.00),
the brief readybox and a verdict-free casebar; the Forecast and
Evaluations gates show with no run figures; the uploaded-ledger
path lands staged with an empty runs list and the gate up.

## Item 2 - Full brief and its shutter

Vanilla spec (state.js). The brief panel sits under the casebar, in
DOM order casebar, brief, run-diff. It shows either the full brief
or the mini brief, never both. The toggle reads "Full brief" /
"Minimize". The mode persists in sessionStorage key `slate-brief`;
with nothing stored, the brief is open on Dashboard and mini
elsewhere. The full brief carries the situation column (story,
counts), the outcome column (verdict paragraph, autonomous
resolution line, Auto-posted cash / Expected back / Held cards, the
SAP payloads button, the totals line with time saved), or the
readybox when staged. The mini carries the short verdict and the
same three tiles; Expected back links to Mail Hub disputes.

Divergence. React had no brief system at all. Stage 4 kept only a
verdict line, and it lived in the casebar, where vanilla carries no
verdict.

Fix. lib/brief.ts ports `briefOutcome()` exactly (latest decision
per payment across the last 10 completed runs; auto, held and
stopped sets; recovery from dispute-claim deductions; the
still-executing line when the latest run has not completed).
ui/CaseBrief.tsx renders the panel between the casebar and the
run-diff panel, full XOR mini, with vanilla's toggle labels,
persistence and defaults, the readybox, the staged run button, and
the disputes tile link. The casebar verdict row is removed; the
brief is the only verdict surface, as in vanilla.

Evidence. verify-brief.cjs: 18/18 on the ground-truth workspace.
Full brief open by default on Dashboard; the verdict paragraph,
93.8% autonomous line, $597,100.00 / $3,903 / held $37,850.00 cards
and the 2.4 hours line all exact; Minimize swaps to the mini with
the exact short verdict; the mode persists across views; the
disputes tile lands on Mail Hub disputes; defaults return after
storage is cleared and the page reloaded.

## Item 3 - Strict squares

Vanilla spec (livecube.css). The base rules give panels and cards
3px, buttons and inputs 2px, and the later Serro pass sets
border-radius 0 on panels, cards, buttons, inputs, menus, the
casebar, the brief and the toast. Measured live in vanilla: panel,
card, casebar, brief and menus all compute to 0px. Surviving
exceptions: pills at 2px, dots and the chat button at 50%, the
tenant select and the docs/key buttons at 999px, the key modal box
at 6px.

Fix. Every React surface was swept: panels, cards, buttons, inputs,
selects, menus, modals, the toast, skeletons and the staged gate
are now radius 0; delta pills stay 2px; 999px and 50% remain only
where vanilla uses them for the same element kind. One trap found
and fixed: Tailwind's `rounded-full` computes to a huge pixel
value, so the tenant pill and round buttons now use literal 999px
and 50% values that measure exactly as vanilla's.

Evidence. verify-surfaces.cjs: 15/15, including a radius census of
the Dashboard and shell: after the sweep the only non-zero radii
present are 999px (3), 50% (2) and 2px (1). Panel hover transform
is none (hover stays transform-free).

## Item 4 - Colours back to vanilla's organisation

Vanilla spec. `--bg #232323`, `--bg2 #1e1e1e`, `--panel #2a2a2a`,
`--panel2 #262626`, `--line #3a3a3c`, `--line2 #4c4c4e`,
`--ink #f2f0ea`, `--mut #a7a49d`, `--mut2 #7e7c77`,
`--blue #3d75e8`, `--blue2 #7fa6f2`, `--ok #34bf71`,
`--warn #f2c14e`, `--bad #e5484d`. Menus and drawers are `#0d1117`;
the toast is `#2b2b2b`; the JSON box is `#101014` with `#c3cfe9`
text; inputs sit on `--bg2`; the sidebar ground is
rgba(35,35,35,.92) with blur. The Stage 5B bright-grey tiers are
gone, and so is the radial glow behind the app.

Fix. All tokens reverted to the values above; glass panels and
cards became flat vanilla surfaces (no blur, gradient or shadow);
menus keep vanilla's own `#0d1117`, opaque. Kept, because they do
not alter the palette: the base colour-inherit rule,
`color-scheme: dark`, `box-sizing: border-box`, and the input focus
ring, which matches vanilla's own focus rule exactly.

Contrast audit, reported honestly. On vanilla's exact palette the
audit (2,008 text nodes) finds 217 offending nodes in 4 pairs, and
every one of them is vanilla's own pair, measured identically in
the vanilla app: `--bad` on its tint at 3.23:1, `--mut2` on panel
at 3.44:1, `--mut2` on the sidebar ground at 3.77:1, and white on
`--blue` at 4.28:1. Per this stage's instruction they are reported
here, not lifted: zero offenders is not reachable without changing
vanilla's colours, and changing them was the rejected move.

Evidence. verify-surfaces.cjs colour samples match the vanilla
measurements (panel rgb(42,42,42), casebar rgb(38,38,38), sidebar
rgba(35,35,35,0.92), primary button rgb(61,117,232), menu
rgb(13,17,23)). Full audit output: verify-contrast-stage6.json in
the stage evidence folder.

## Item 5 - Sidebar holds the demo workspace

Vanilla spec. The tenant block (TENANT label, the workspace select,
the SESSION chip) lives in vanilla's left rail, under the brand.
The casebar holds case identity, the four stat cells, the case
selector, Export and More.

Fix. ui/WorkspaceBlock.tsx renders the tenant select (999px pill,
`#1c1c1c` face, muted text, as measured in vanilla) and the SESSION
chip in the sidebar under the brand. The casebar's tenant select is
removed; nothing is duplicated. Tenant switch behaviour is
unchanged (stores the choice, toasts, reloads). The sidebar nav now
carries vanilla's group labels: OPERATE, INSIGHT & GOVERNANCE,
EVALS & ARCHITECTURE.

Evidence. verify-surfaces.cjs: the tenant pill computes to 999px /
rgb(28,28,28) / muted text in the sidebar, the chip reads
"SESSION 55555555" on the ground-truth workspace, and the casebar
contains no tenant control.

## Item 6 - Draft reminder in white

Vanilla spec. In vanilla's Forecast collections table the Draft
reminder is a plain `.mini` button, and vanilla defines no `.mini`
rule, so it renders as the unstyled light button face. Measured in
vanilla: background rgb(239,239,239), black text, radius 0.

Fix. A `.mini-btn` class reproduces that face exactly (#efefef,
black text and border, radius 0, hover #e2e2e2), and Forecast's
Draft reminder uses it. It was the only Draft reminder site in
either app.

Evidence. verify-surfaces.cjs measures rgb(239,239,239) / black /
0px on the shipped build. verify-reminder.cjs: 5/5 end to end on a
throwaway session: Draft reminder opens the composer with the
drafted reminder; Send records a `collection_reminder` entry in
the outbox with the true status `recorded_not_sent` (no mailbox
configured locally); the Mail Hub Outbox shows it.

## Item 7 - Flow, interconnections, missing info

Interlink map (enumerated from vanilla's JS; every link
click-tested in React, verify-links.cjs: 18/18). Casebar cells:
Open invoices to Ledger, Payments staged to Ledger, Latest run to
Run plus the shell run-comparison panel, Approvals waiting to Run.
Dashboard cards: exceptions to Run, recovery to Mail, suspense to
Run. Run history row to Run with the stored run id. Brief: SAP
button to SAP, Expected back tile to Mail disputes, staged run
button to Run with the stream starting. Gates: Execute to Run with
the stream starting. SAP document chips switch the document.
Casebar switcher specials: Upload my own files to Upload, Custom
Case Builder to Use Cases. Use Cases: Stage Case lands on the
Dashboard staged, Stage & Run lands on Run streaming.

Element register (per-view diff, headings and panels inventoried
in both apps on the ground-truth workspace):

- Methodology, Architecture, Product Thinking: vanilla nav views
  12 to 14. Not React views (a Stage 4 scope decision; the content
  stays reachable in the vanilla app at /vanilla/). The React
  sidebar's EVALS & ARCHITECTURE group therefore labels
  Evaluations and Agent Health only. DEFERRED, reason: rebuilding
  three long-form content views was not among this stage's items.
- Run, Outbox strip: vanilla renders the outbox (mailbox status
  line plus the last 10 sends with true statuses) inside the
  Dispute desk panel. React lacked it. RESTORED in Desk.tsx,
  refreshed after every send from the panel
  (verify-restorations.cjs: 6/6 with the SAP item below).
- SAP payload: vanilla shows the BAPI payload as an inline panel
  ("BAPI_ACC_DOCUMENT_POST payload", Copy payload button, JSON
  box). React hid it behind a drawer button. RESTORED as an
  inline panel in vanilla's position, after the GL posting table.
- Dashboard band order: vanilla leads with "What SlateMatch has
  done for you", then Save & retrieve, then the ribbon. React
  leads with the ribbon, then the done-for-you band. All elements
  present in both; order differs. NOTED, not changed: content and
  figures are identical, and reordering was not among the items.
- Staged Dashboard: vanilla shows the staged ribbon (placeholders)
  plus the brief readybox; React shows the staged gate as the
  primary content plus the same readybox. Every staged figure
  (open invoices, totals, wire count and volume) is present in
  both. The placeholder ribbon strip itself is not reproduced in
  staged mode. NOTED.
- Casebar latest run id: shown in full in React; vanilla truncates
  to 13 characters. RETAINED deliberately (a Stage 4 audit fix:
  the full id is the record's identity).
- Run view "Run record" panel and Agent Health "Run history -
  status bars": React additions with no vanilla counterpart.
  NOTED; they present the same run data, nothing vanilla has is
  displaced.
- Brief outcome refresh: the brief recomputes on view change,
  workspace refresh and window focus, matching vanilla's
  invalidation points (case load, reset, tenant switch, run
  completion, approval decisions). A decision taken in Run
  dispatches the refresh, so the brief updates without a reload.

## Gates

- Suite: 169 passed (168 baseline plus the new Stage 6 contract
  test). One existing contract test was updated, with the reason
  recorded in its comment: the Stage 4 casebar-verdict test pinned
  a verdict strip that Item 2 supersedes. It now pins the
  verdict's absence from the casebar and the full brief system.
  The assertions are stronger, not weaker; the full-run-id rule
  is unchanged.
- Figure parity on the ground-truth workspace: exact (93.8%,
  75.0%, $597,100.00, $22,120.00, $3,903, approvals 3, 15 matches,
  4 exceptions). One transient parity failure was observed while
  the contrast audit's browsers were starting in the same minute;
  three consecutive clean passes followed on the final build.
- Contrast: 4 offending pairs, all vanilla's own, reported under
  Item 4, none lifted.
- Vanilla byte-identical: md5 73b0874b216bc87dd96180a5ecb93683.
- Flip rule applied: frontend/index.html and
  frontend/react/index.html md5-identical after the rebuild
  (08e7cf95a97f15bdec52957d6cd93595).
- Brief toggle persistence, staged gates on Dashboard, Forecast
  and Evaluations across all three load paths (seed, switch,
  upload), Draft reminder end to end, hover transform-free: all
  verified above.

## DELETIONS (carried over from Stage 5, unchanged)

Still undeleted from the v4 deploy; delete in the clone whenever
convenient. They are dead duplicates that nothing references:

- frontend/css/livecube.css
- the five loose files directly under frontend/js/ (app.js and
  siblings at that level only)

WARNING: never delete frontend/js/vendor/. The React app imports
orbs-engine.js from it and the Dockerfile copies it. Deleting it
breaks the build.
