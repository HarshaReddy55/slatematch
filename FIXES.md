# SlateMatch defect fix pack v1 (13 Nov 2026)

Four defects from the product surface audit (~/workspace/slatematch-audit/PRODUCT_SURFACE_AUDIT.md), fixed at the cause. The logo work is not in this pack.

Files in this pack (repo-relative paths):

- frontend/js/insight.js (Fix 1)
- frontend/index.html (Fixes 2 and 3)
- backend/tests/test_ui_contracts.py (Fix 3, new contract test)
- web/src/App.tsx, web/src/views/Dashboard.tsx (Fix 4)

No other files changed. A checksum pass over frontend/, web/src/ and backend/tests/ before and after confirms only these five files differ. The React bundle under frontend/react/ is a build artifact: the Dockerfile rebuilds it from web/src at image build, so it is not in the pack.

## Fix 1: Dashboard Touchless Auto-Post Rate showed NaN%

Root cause: the vanilla scorecard in loadScore() (frontend/js/insight.js) rendered latest.touchless_rate from GET /api/v1/runs. That endpoint is served by repository.list_runs(), which returns only counts (run_id, kind, status, created_at, finished_at, matches, auto_posted, exceptions, payments). It has no touchless_rate field, so the card computed undefined x 100 and rendered a literal NaN%. The batch execution result does carry touchless_rate, which is why the Run view figures were always correct; only the runs-list consumer was broken. The React dashboard never reads the field: it derives the rate from the run summary counts.

Change: loadScore() now derives the rate exactly the way React does, from the same source fields, with the same zero guard:

    const touchless = latest.payments ? ((latest.auto_posted || 0) / latest.payments * 100) : 0;

and renders touchless.toFixed(1). No display masking: the value is computed from the run's real counts. The existing honest states are untouched and sit upstream of the computation: an empty workspace shows the empty-workspace message, and a staged case with no runs shows "No runs yet."

Verification (local server, demo case seeded via API, workspace run exactly once, run_15bca3f87b12):

- Batch execution result for the run: payments 16, auto_posted 10, touchless_rate 0.625.
- GET /api/v1/runs for the same run: auto_posted 10, payments 16, no touchless_rate key (root cause confirmed live). Derived rate: 10 / 16 = 62.5%.
- Browser, same session: the Touchless auto-post rate card renders 62.5%. Screenshot: ~/workspace/slatematch-fixpack/fix1-scorecard-crop.png (full page: fix1-dashboard.png). The React dashboard on the same workspace also reads 62.5%, so vanilla, React and the API now agree.
- Second session, case seeded but never run: the scorecard shows the honest "No runs yet." state, no number and no NaN.

## Fix 2: SAP view rendered header-only

Root cause: the SAP section of frontend/index.html contained only the section header. Every container loadSap() writes to was missing (sap-state, sap-t-docs, sap-t-total, sap-t-reserve, sap-chips, sap-table, sap-payload, sap-note, sap-reserve), and loadSap() returns silently when sap-state is absent, so the view showed the header and nothing else while the API served the documents correctly.

Change: added the missing containers inside the SAP section, using the exact ids loadSap() and renderSapDoc() query, following the surrounding sections' markup patterns (the .cards stat row and .panel blocks used by Ledger and Forecast): a four-card strip (Documents generated, Balanced journal total, Document type, ASC 606 dispute reserve), the GL posting table panel with the payment chips container and the derivation note slot, the BAPI_ACC_DOCUMENT_POST payload panel with the Copy payload button wired to copySapPayload(this) and a pre.jsonbox, and the dispute reserve journal panel. The copy follows the product's original SAP section wording from the AutoCash predecessor tree, adapted to the current file's conventions (no how-it-works toggle, no next-step bar, both retired in v58).

Verification (same run as Fix 1):

- API ground truth, GET /api/v1/erp/run-documents: 10 documents, totals debit_cents 41,405,000 = credit_cents 41,405,000, balanced true, reserve claimed_cents 420,000, first document P1 / DZ-1400258778, balanced.
- Browser: the SAP view renders 10 documents, $414,050.00 balanced journal total, $4,200.00 reserve tile, 10 payment chips, P1's GL table (113100 Cash $52,000.00 debit, 121000 Trade receivables $52,000.00 credit, total balanced to the cent), the BAPI payload JSON for the selected payment, and the ASC 606 reserve journal for P3 ($4,200.00 reclassified to GL 121500). Every figure matches the API response exactly. Screenshot: ~/workspace/slatematch-fixpack/fix2-sap.png.

## Fix 3: Methodology, Architecture and Product Thinking never displayed

Root cause: two stray closing div tags at the end of the Policy Studio section in frontend/index.html (a lone "</div></div>" line after the policy panel). Per-section div accounting over the file: every section is internally balanced except Policy Studio at net -2. In the browser's tree construction those extra closers pop the wrapper div and main itself, so the sections that follow are re-parented outside main. go() only toggles "main section" elements, so the re-parented pages can never be shown. The audit attributed this to an unclosed purpose div in the Agent Health header; that header is in fact balanced (Agent Health section div balance is 0). The audit's symptom list stands: its browser probe found method, arch and product outside main; a token-stream parse puts eval and health outside as well. The cause is the same either way: the two stray closers in Policy Studio. The existing test_sections_are_siblings_never_nested could not catch this class, because the sections remain siblings of each other, just under the wrong parent.

Change: removed the two stray closing tags. The file's div balance is now exact: every section internally balanced, 354 opens and 354 closes overall. Added test_sections_live_inside_main to backend/tests/test_ui_contracts.py: it parses the served page, records the ancestor chain of every section, and asserts all 14 sections land inside main. Run against the pre-fix markup it fails; against the fixed markup it passes.

Verification (same run as Fix 1):

- Browser DOM probe: all 14 sections report closest('main') present and parent MAIN.
- Browser navigation: Methodology displays (8,516 chars of content), Architecture displays (9,907 chars), Product Thinking displays (3,155 chars), each with the active class and computed display block. Screenshots: ~/workspace/slatematch-fixpack/fix3-method.png, fix3-arch.png, fix3-product.png.

## Fix 4: React staging narration on user-facing surfaces

Root cause: the React shell carried build-process narration into the product: the nav group label "REACT STAGE 2 - INSIGHT VIEWS", the footer "React Stage 2 - Dashboard plus the Insight views...", the dashboard footer "React Stage 1 - Dashboard...", the nav aria-label "Migrated views", and the Run history sub-line "...The Run view itself migrates in Stage 3; until then a run opens in the vanilla app." (also inaccurate: run rows are not clickable in React).

Change (copy only; no routes, behaviour or figures touched):

- Nav label replaced with the product's own sub-brand line: "AUTONOMOUS CASH APPLICATION AGENT" (the same line the vanilla topbar carries).
- App footer replaced with: "Every figure is computed live from this workspace's API responses."
- Dashboard footer paragraph removed (the app-level footer covers it).
- Nav aria-label: "Migrated views" to "Views".
- Run history sub-line replaced with: "Every batch executed in this workspace, newest first."

Verification: tsc --noEmit passes under TypeScript strict and vite build succeeds; the built bundle contains no "React Stage" or "migrates in Stage" text and contains the new label and footer. The rebuilt bundle was also rendered against the live local API: no staging narration anywhere on the page, nav shows the new label, footer shows the new line. Screenshot: ~/workspace/slatematch-fixpack/fix4-react-dashboard.png (top crop: fix4-react-top.png).

## Test suite

Full backend suite after the fixes: 152 passed (baseline 151, plus the new test_sections_live_inside_main). The UI contract file alone: 15 passed.

## Verification method

Established recipe: backend run locally (uvicorn, backend/app) with a throwaway SLATEMATCH_DATA_DIR and one fixed X-Workspace-Session header; demo case seeded via the API; the workspace run exactly once (run_15bca3f87b12); a headless Chromium sharing that session captured the dashboard, SAP, Methodology, Architecture and Product Thinking views and probed the DOM. Full machine-readable results: ~/workspace/slatematch-fixpack/verify-report.json; capture script: ~/workspace/slatematch-fixpack/verify.cjs.
