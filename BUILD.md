# SlateMatch - optimization pass: connections, performance,
# organization, clarity

One deploy, on top of the consolidated moat pack (v1). It
changes no product behaviour and no outcome: the demo case
still runs 10 auto-posted of 16, and every figure is computed
the same way. What changes is how the product is wired and
how fast it moves.

Suite: 261 tests passing on SQLite AND on PostgreSQL 18
(full suite, solo, fresh database in each mode; section G
lists the three Postgres-only defects the gate caught).
New served entry bundle: index-BkAzZ547.js, with per-view
chunks.

## A. Connections - one workspace truth, one fetch (F8)

Fourteen call sites used to fetch /api/v1/workspace
independently, so one view transition fired three to six
identical requests (casebar, brief, the view, the copilot).
lib/chrome.ts now holds a shared workspace store:
concurrent reads collapse into one in-flight request, a
two-second stale-while-revalidate window serves repeat
reads, and every mutation path (they all fire
requestShellRefresh) plus any session, tenant or key switch
invalidates it immediately. No surface can sit on a
replaced workspace - the forced-refresh reset behaviour
from the Stage 6 fix round is unchanged.

## B. Connections - one refresh mechanism (F10)

Four refresh mechanisms coexisted; two remain, by design:
the ws-refresh hook (data) and slate:intent events
(navigation signals). The reloadSignal counter props are
gone - Approvals and Desk subscribe to the shell refresh
themselves, exactly like every other view. Every former
increment site already fired requestShellRefresh, so
behaviour is identical with one less bespoke channel.

## C. Performance - bundle splitting (F9)

The single 679 KB bundle is now an entry chunk (348 KB:
shell + Dashboard + shared libraries) plus a vendor chunk
(react, react-dom, motion, 107 KB) plus one chunk per view,
loaded on first navigation behind the standard skeleton.
First load on the public link drops by a third; the Run
view's 53 KB, Upload's 26 KB and the rest arrive only when
opened. The logo asset is untouched (owner-closed).

## D. Performance - success-criteria cache (backend)

GET /api/v1/success-criteria scanned every stored run and
rebuilt every posting document on every Agent Health load -
the product's most expensive read. It is now cached per
tenant behind a runs stamp (count + latest run), and the
only post-run mutations of match status - decisions,
reversals, workspace replacement, session restore - pop
the cache explicitly. A new test pins the behaviour: a
repeat read is stable, and approving P7 moves the SAP
documents row from 10 of 10 to 11 of 11 on the next read.

## E. Organization - Forecast and Collections

The forecast chart and the collections priority queue sat
two-up, and the queue's action cell (Draft reminder,
promise date, Log promise) clipped at the panel edge -
content cut off mid-button. Both panels now stack at full
width; nothing clips. Priority scores render as rounded,
comma-formatted numbers (1,095,502, not 1095502.4).

## F. Clarity - three wording fixes

1. The Mail Hub dispute letter said "classified it as
   unexplained" for a claim the same screen correctly
   labelled Damaged/Shortage Claim: Mail.tsx never passed
   the classification into the draft facts, so the template
   fell back to a wrong word. The fact is passed now, and
   the template's fallback no longer contradicts a known
   reason code.
2. Product Thinking's roadmap paragraph listed Postgres
   storage as a gap; dual-mode Postgres shipped in the moat
   build. The paragraph now names the real remaining gaps:
   a live ERP on the other end of the write-back, SOC 2,
   job queue and multi-worker serving.
3. Architecture's data lines said SQLite-only with
   Postgres-compatible discipline; they now describe the
   dual-mode storage as shipped. Agent Health's data card
   note matches.

## G. Seam fixes found by the Postgres verification

Re-running the suite against PostgreSQL caught two defects
the SQLite runs cannot see:

1. Isolation: scratch repositories built on temp files
   (tests and previews create them in mkdtemp directories)
   all mapped to one Postgres schema per basename, so
   separate scratch stores leaked state into each other.
   The seam's own design says scratch stays on SQLite;
   db.connect now keeps temp-directory files on SQLite in
   both modes. Real tenant stores (the data directory) map
   to Postgres schemas exactly as before, and the
   migration mapping is unchanged.

2. Policy writes: the INSERT OR REPLACE translation
   registry was missing tenant_policies and tenant_settings,
   so PUT /api/v1/policy (and the integration settings
   writes) reached Postgres untranslated and returned 500.
   Both tables are registered now, and a failed statement
   rolls its transaction back before the error propagates,
   so one bad statement can no longer poison the shared
   control connection.

3. Read locks: on Postgres a plain SELECT leaves its
   transaction open holding locks until a commit, which
   SQLite never does; pooled seam connections sat idle in
   transaction and could block writers indefinitely. The
   seam now ends a transaction right after a read when no
   writes are pending and no explicit transaction is open.
   Writes are never auto-committed, so the unit-of-work
   atomicity is untouched.

4. Session snapshots: Save and Restore were file
   operations (VACUUM INTO, file swap), so on Postgres a
   snapshot silently captured an empty file. On Postgres
   the snapshot is now the same portable SQLite file,
   built by copying every tenant table through the seam,
   and a restore loads it back inside one transaction
   with the serial sequences advanced.

Verified on a fresh PostgreSQL 18 database, solo: the
full suite passes, 261 tests, the same count as SQLite.

## H. Assessed and deliberately not done

- Splitting api.py (3,394 lines) into routers: internal
  structure only, fully covered by the suite either way;
  the churn risk on a working product outweighs the
  tidiness. Revisit with the job-queue work.
- The logo PNG (317 KB): a web-sized derivative would cut
  first-load weight, but the logo is owner-closed - not
  touched.
- Job queue, multi-worker serving, PyO3: roadmap, as
  recorded in the dispositions.

## Files

backend/app/{api,briefing}.py
backend/tests/test_optimization_pass.py
frontend/{index.html,react/}
web/vite.config.ts
web/src/App.tsx
web/src/lib/chrome.ts
web/src/ui/{Casebar,CaseBrief}.tsx
web/src/views/{Approvals,Architecture,Dashboard,Desk,Eval,
Forecast,Health,Ledger,Mail,Policy,Product,Run,Sap,
Upload}.tsx

## Deploy

Copy the files into the clone at the same paths, commit
("Optimization pass: shared workspace store, bundle
splitting, criteria cache, layout and clarity fixes"),
push, then Update service slatematch-app with Force new
deployment.

Standing reminder (unchanged): delete the six dead files
in the clone if still present - frontend/css/livecube.css
and the five loose frontend/js/*.js. Never
frontend/js/vendor/.
