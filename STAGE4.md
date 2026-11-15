# SlateMatch React Migration - Stage 4: the chrome, plus the flip

Stage 4 finishes the migration's chrome and makes React the
default experience. Seven chrome surfaces, one layout fix, and
the flip. All work is in the frontend layer. No backend code,
no Dockerfile, no infrastructure changed.

Verification ran against a locally served copy of this exact
tree (uvicorn on the app's own backend, a supervised server,
one fixed ground-truth workspace: the demo seed case with one
completed run, run_f8247b5c94cb). Vanilla ground truth was
captured before any surface was built. Evidence lives in
~/workspace/slatematch-stage4/ (blueprints, screenshots,
ground-truth, verify-chrome.json, verify-actions.json,
verify-adversarial.json, verify-flip.json).

Results at a glance:

- Parity and design checks: 64 of 64.
- Action tests on fresh seeded workspaces: 22 of 22.
- Adversarial checks: 14 of 14.
- Flip checks: 13 of 13.
- Full test suite: 168 passed (159 baseline plus 9 new Stage 4
  contract tests).
- TypeScript strict build: clean.

## 1. Shell and casebar

Adaptations. EasyUI Sidebar discipline for the shell row
(audit row 9): the view tabs keep the existing spring pill
(not rebuilt), and PRODUCT DOCS, ACCESS KEY and MENU join
them as quiet ghost buttons. The casebar is a glass strip
whose cells never slice a value mid-token (row 10): the
latest run shows its full run id in mono with break-all, the
case name is never truncated, and the case switcher reflects
the active case, as vanilla's does. The brief mini-strip
keeps ONLY the verdict line; the three mini tiles (auto-posted
cash, expected back, held) are not carried over. Tenant
switching, case loading, exports and the More menu are all
live, with vanilla's toast sentences.

Parity. Casebar cells character-exact against the vanilla
capture on the same workspace (case line, 5 open invoices,
16 staged, full run id, 3 approvals waiting). Brief verdict
string exact: "16 payments in: 12 posted themselves, 3 waiting
for a person, 1 stopped before matching." Dashboard regression
figures hold (93.8% resolution, 75.0% touchless, $597,100.00).

Actions. Scenario case load via the switcher with the vanilla
toast, PDF and CSV exports fire the real endpoints, session
save via the More menu.

Weakest element. The casebar's second row (tenant, switcher,
export, More) leaves dead space at its left, because the cells
row above it is wide. It reads as one panel, but the row
alignment is the least resolved part of the shell.

## 2. Copilot

Adaptations. EasyUI Prompt Input for the composer (audit
row 12): one bordered row with the input and the send button
inside it. Answers render one fact per line, split on sentence
ends (a split never lands inside a decimal or an amount), with
citations as quiet mono lines under the facts. The header
sentence, placeholder and suggestion logic are vanilla's,
ported line for line. Thinking Orbs are unchanged.

Parity. Both ground-truth questions return the ground-truth
answers as separate fact lines with the exact citation strings
(run:run_f8247b5c94cb; exception:P6:NO_MATCH). The five
suggestion chips equal vanilla's on the same workspace, and
the empty-workspace fallback equals vanilla's single chip.

Actions and adversarial. Ask via chip and via typed question;
a triple-click on send submits exactly once (synchronous
pending guard); an out-of-scope question is answered by the
backend's own refusal path without a crash.

Weakest element. The first answer in a long log can scroll
its "Copilot:" label out of view, so an answer block can
appear label-less at the top of the visible area. The label
is present in the log; the scroll window crops it.

## 3. Command palette

Adaptations. Raycast discipline (audit row 11): two labelled
groups only, Go to and Actions. Vanilla's third group
(Workspace) is folded into Actions; nothing is lost. Rows are
compact enough that the Actions header (y=463 at a 1000px
viewport) and every one of the 21 items, including the last
(Reset workspace to empty), are visible without scrolling.
Vanilla's fuzzy scorer and its group re-ranking while
filtering are ported exactly. Views 12 to 14 (Methodology,
Architecture, Product Thinking) are not palette items: they
are reference pages, not React views, and stay reachable in
vanilla at /vanilla/.

Parity. All 11 view labels and all 10 action labels match
vanilla's. Fuzzy probe "run" ranks Run Reconciliation first,
then the two run actions, as vanilla does.

Deliberate difference. Vanilla's APR action also switched
the Run page's queue tab; in React the approvals queue is
in-page on Run Reconciliation, so APR is navigation only.

Weakest element. With a filter typed, group order follows
the best score, which can put Actions above Go to. That is
vanilla's own ranking rule, kept, but it means the group
order is not stable while searching.

## 4. Policy Studio (new React view, nav 09)

Adaptations. Rows grouped under Posting, Disputes,
Governance (audit row 13). Grouping: Posting holds the five
solver terms (automation threshold, age weight, discount,
residual and deduction penalties); Disputes holds the three
money rules for claims (tolerance write-off, minimum
recovery, processing cost); Governance holds the profile
name and the maker-checker threshold. Cent fields display
and edit in dollars, with the raw cents in the input title;
the API body stays exact cents. Every consequence sentence
and every formula line is verbatim from vanilla, and the
spec sentence appears once: "Changing this value changes
the next run's behaviour; the run records the policy it
used." The save flow is vanilla's: preview, PUT, source
line, then a re-run of the active case.

Parity. All 10 field values, all 10 consequence lines, all
10 formula lines and the source line match the vanilla
ground truth. The preview banner carries the full run id
and figures equal to the API's own preview answer.

Actions. Preview with a changed threshold, save (source
line flips to "Source: tenant (just saved)", the API holds
the saved value, the case re-runs), then the ground-truth
policy was restored through the API and re-verified.
Preview with no run behind the case says so honestly.

Adversarial. Emptying a number field stops preview and
save and names the field ("Tolerance write-off ($) needs
a number before this can run."); no request is sent. With
the API unreachable, the view shows the kit error surface
with the access-key guidance.

Weakest element. The consequence text column sits far from
its input on wide screens; the row reads label, input, then
a gap, then the explanation. It matches vanilla's layout,
but the association is weaker than it should be.

## 5. Session saves

Adaptations. Obsidian Active Sessions rows (audit row 14):
a status dot, the mono session id, saved-at and counts at a
glance, Retrieve at the right edge. The panel copy, the save
and restore result sentences and the empty line are
vanilla's verbatim. The panel lives on the Dashboard, where
vanilla keeps it.

Parity. Panel copy exact; the rendered list equals the
API's list (first row id and counts checked against
GET /api/v1/session/saves).

Actions. Save (a double-click saves exactly once), reset
the workspace away, restore by id from the panel: the
result sentence matches vanilla's format and the casebar
follows the restored workspace.

Not ported. Obsidian's fold-away remove. Vanilla has no
delete endpoint for saves, so there is nothing honest to
wire a remove control to in a UI stage.

Weakest element. The restore box and the saves list are in
one panel with the save button; on a long list the panel
grows tall on the Dashboard. Acceptable, but it is the
plainest surface in the stage.

## 6. Product Docs drawer

Adaptations. The kit slide-over narrowed to a reading
column, 560px overall (audit row 15). Content unchanged:
the drawer intro is verbatim, the list shows all 8 documents
with vanilla's titles and sizes, and the markdown renderer
is a one-for-one port of vanilla's mdRender.

Parity. The PRD's rendered text equals vanilla's render
exactly after whitespace normalisation (10,923 characters).
Drawer width measured at 561px on a 1600px viewport,
against vanilla's roughly 804px.

Adversarial. Escape closes the drawer; an unknown document
shows an error line instead of a blank panel.

Weakest element. The document list and the open document
share one scroll column, so opening a long document
scrolls the list away. Vanilla has the same pattern; a
pinned list would be better and is a small future fix.

## 7. Access-key copy

Adaptations. The modal reads /health when it opens and
shows copy for the deployment's TRUE auth state (audit
row 15). While the deployment is dev-open, the copy says
so: "This deployment is open - no API key is in force, and
this browser does not need one to work here." It never
claims a lock that is not in force. The locked-state copy
is vanilla's text, kept verbatim for the day the
deployment is actually locked. Save and remove write the
shared localStorage key and the shell button flips between
ACCESS KEY and ACCESS KEY: SET, as vanilla's does.

Scope guard. Copy only. No auth behaviour changed. Part B
(the auth flip) stays parked until Harsha says "final".

Parity and actions. On the dev-open local server the open
copy renders and the locked claim is absent (string
assertions in the harness). Save, reopen, remove were
exercised end to end; the key lands in the same
localStorage slot vanilla uses. The locked branch cannot
be exercised against a live locked server locally without
changing auth state, which is out of scope; it is covered
by a contract test on the copy function instead.

Weakest element. The state is carried by the first
sentence of a single paragraph; there is no separate
status line. The sentence is unambiguous, but a dedicated
state line would scan faster.

## 8. THE FLIP - INCLUDED, frontend only

Investigation. backend/app/api.py mounts one StaticFiles
app at "/" over the whole frontend/ tree with html=True.
So / serves frontend/index.html, /react/ serves
frontend/react/index.html, and /vanilla/ serves
frontend/vanilla/index.html, with no backend change. The
React build references its assets by absolute /react/
paths, so the same built entry works at the root. The
vanilla page references its assets relatively, so a
complete copy of its file set runs at /vanilla/ untouched.

What the flip changes, file by file:

- web/index.html: the title becomes "SlateMatch -
  Autonomous Cash Application Agent" (vanilla's title), so
  every future build carries it.
- frontend/index.html: replaced by the freshly built React
  entry, byte-identical to frontend/react/index.html of the
  same build (md5 543e0909a6251d00f2389de80a618831 for
  both, this build).
- frontend/vanilla/: new directory holding byte-identical
  copies of the nine vanilla files (index.html, css/
  livecube.css, js/state.js, js/operate.js, js/insight.js,
  js/assist.js, js/orbs.js, js/vendor/orbs-engine.js,
  js/vendor/THINKING-ORBS-LICENSE.txt). Every copy's md5
  equals the Stage 3 baseline in vanilla-md5-before.txt.
- web/src/ui/ViewHead.tsx and web/src/views/Dashboard.tsx:
  the "Vanilla app" links now point at /vanilla/. Two stale
  "in the vanilla app" sentences in Forecast and
  Evaluations were corrected, because the actions they
  point at (Run Reconciliation, the Dispute desk) are
  React surfaces now.

Left in place, deliberately. The original frontend/css/
and frontend/js/ files stay where they are: a pack zip
cannot delete files, and they are unreferenced duplicates
once /vanilla/ exists. Stage 5 cleanup can remove them.
The six pre-existing vanilla contract tests were repointed
from / to /vanilla/ (and their asset paths likewise) with
every assertion unchanged; they pass.

Maintenance rule. The Docker build writes the React build
to frontend/react/ only. After ANY future React rebuild,
frontend/index.html must be re-copied from
frontend/react/index.html, or the root will serve a stale
entry. This is the one manual step the flip adds.

Verification (verify-flip.json, 13 of 13, against the
locally served flipped tree):

- GET / returns the React entry (product title, /react/
  asset paths, no vanilla stylesheet).
- GET /vanilla/ returns bytes md5-identical to the
  pre-flip vanilla index (73b0874b216bc87dd96180a5ecb93683).
- A browser at / renders the React Dashboard on the
  ground-truth session; deep links /#/run and /#/policy
  land on the right views.
- The React "Vanilla app" link points at /vanilla/, and
  following it renders vanilla on the SAME session: same
  case, same run, same figures, and the brief outcome
  matches in both its full and minimised forms. The shared
  session contract (sessionStorage slatematch_session_id,
  localStorage slate-key and slate-tenant, identical API
  headers) is used by both stacks; vanilla's own source
  reads the same keys.

Weakest element. The root entry is a copy, not a symlink
or a build output, so it can drift if the maintenance
rule is skipped after a rebuild. The rule is one line and
is stated above and in the pack notes; a Stage 5 build
step could automate it.

## 9. Forecast layout balance (secondary item)

The What-if panel moved from full width below the grid
into the right column, stacked under Collections. No
figure or copy changed. Measured on the ground-truth
workspace: the old layout left 358px of dead space under
Collections (reconstruction on the same page state); the
chart column is 690px and the right stack is now 519px,
so the columns land within a panel of each other and no
dead block remains. Below the grid, Dispute priority and
Expected cash by customer keep their full-width order.

## 10. One real defect found and fixed

The actions pass caught a casebar staleness bug. Vanilla's
stale-read guard discards a workspace snapshot that lacks
a run once a run has been seen. That guard is correct for
races, but the palette reset, reseed and session restore
refreshed the casebar through it, so after clearing the
workspace the casebar kept showing the cleared case.
Vanilla's own reset never hits this, because it writes the
cleared state directly. Fix: shell refresh events now
carry a force flag for authoritative replacements (reset,
restore, reseed), and the casebar drops the guard only for
those. The guard itself is unchanged for ordinary
refreshes. Covered by the actions suite (CLR check) and
by the restore check.

## Deliberate differences from vanilla, all recorded

- Tenant switching reloads the page after writing the
  shared localStorage tenant (vanilla re-renders in
  place). The stored state and the toast sentence are
  vanilla's; only the mechanism differs.
- Palette APR is navigation only (see section 3).
- Palette does not list reference views 12 to 14 (see
  section 3).
- Sessions remove is not ported (see section 5).

## Pack contents

- web/src/ complete, plus web/index.html (title).
- frontend/index.html (the flip) and frontend/vanilla/
  (the nine vanilla files, byte-identical).
- backend/tests/test_ui_contracts.py: 9 new Stage 4
  contract tests, plus the six repointed vanilla
  contracts. Suite total 168 passed.
- STAGE4.md (this file) at the pack root.

Deploy is the established flow: Harsha pushes and
force-deploys, then the live ALB is verified (root serves
React, /vanilla/ serves vanilla, /react/ unchanged).
