# SlateMatch - interconnection analysis and optimization plan

16 Nov 2026, core chat, at the owner's request: "Are the
interconnections between elements good? What improvements,
optimizations do you think are required... Analyze to the very
last elements in depth, with accurate analysis and plan for
optimization."

Method: the connection fabric was mapped from the code (every
fetch call site, every intent writer/reader, every storage key,
the backend module graph and the run pipeline), and the hot
paths were measured on a warm local server running the canonical
demo case. Verdicts below cite the measurement or the code, not
impressions.

## Verdict

The interconnections are fundamentally sound - unusually so for
a product assembled this fast. Every view reads one shared
workspace truth, the run pipeline is a single linear flow with
transactional writes, and the read models (forecast, mail,
collections) compute only from the post-run residual ledger, so
views cannot disagree with each other about money. The measured
hot paths are single-digit milliseconds at demo scale. The
weaknesses are not correctness; they are (a) one slow endpoint
(PDF export), (b) repeated identical computation (evaluations),
(c) a frontend that refetches everything per view with no shared
cache, in one 618 KB bundle, and (d) four overlapping refresh
mechanisms where one would do - the plurality that caused the
Stage 6 stale-figures bug. Items (a) and (b) are fixed in the
consolidated pack that carries this note; (c) and (d) are
scheduled below with owners.

## Measured evidence (warm server, canonical demo case)

| Call | Time | Payload | Note |
|---|---|---|---|
| POST /api/v1/workspace/run (16 payments) | 379 ms | - | full MILP batch |
| GET /api/v1/workspace | 7.6 ms | 5.4 KB | every view's base fetch |
| GET /api/v1/matches | 4.7 ms | - | |
| GET /api/v1/approvals | 5.7 ms | 1.3 KB | |
| GET /api/v1/runs | 6.1 ms | - | |
| GET /api/v1/mail/hub | 11.7 ms | 15.7 KB | largest JSON payload |
| GET /api/v1/collections | 12.6 ms | 1.1 KB | |
| GET /api/v1/forecast | 18.5 ms | 3.8 KB | Monte Carlo, 400 sims |
| GET /api/v1/evaluations | 44 ms | 1.6 KB | was per-call; now cached |
| GET /api/v1/export/bundle.pdf | 2.44 s | 49.6 KB | the outlier; now cached |
| GET /health | 4.9 ms | - | after Phase 3 warm-up |

Bundle assembly alone measures 0.02 s; the PDF cost is the
render. A two-build diff proved the bundle's only volatile field
is generated_at, which is what makes the render cache exact.

## The connection map

1. **Shell <-> views.** The casebar and every view read
   GET /api/v1/workspace (12 fetch call sites). A shared
   useWsRefresh hook reloads nine views on the slate:ws-refresh
   event; Approvals reloads on a parent prop (reloadSignal);
   Run guards the event during streams and reloads on completion;
   MatchDetail is purely prop-fed. One truth, several doors.
2. **View <-> view.** 27 setIntent call sites write typed intents
   (jump-to-approvals, open-run, run filter, ledger target, live
   run); since Phase 2 these dispatch the slate:intent window
   event instead of the old 600 ms polling. The brief system
   persists in sessionStorage (slate-brief); identity lives in
   sessionStorage (slatematch_session_id) + localStorage
   (slate-key, slate-tenant) - the same contract as vanilla, so a
   user can cross stacks mid-session.
3. **Frontend <-> backend.** One client (web/src/lib/api.ts)
   attaches the session and key headers to every call and
   surfaces errors as text. No request cache, no dedup: each view
   mount and each refresh event refetches its full payload set.
4. **Run pipeline (backend).** POST /api/v1/workspace/run and the
   SSE stream (/api/v1/runs/stream) both drive batch.run_batch:
   candidate restriction (references -> OCR -> payer -> fuzzy,
   with currency and now subsidiary as hard boundaries) ->
   solvers (MILP with self-verification, kernel for provably
   unique exact sets) -> deduction intelligence -> policy
   decision -> repository unit of work -> run outputs (settlement
   drafts, briefing) in a second transaction. Approvals flip the
   same matches through a compare-and-set and issue the SAP
   documents; export renders the same records.
5. **Read models.** Forecast, Collections and Mail Hub hold the
   state rule: before a run they show nothing computed; after a
   run they compute only from the residual ledger. Copilot
   answers are grounded on the same workspace with citations.
   Gemini is a bounded dependency (per-IP budget, deterministic
   fallback, labelled), SMTP is record-only until configured.

## Findings, element by element

FIXED IN THIS PACK (core):
- **F1. Evaluations recomputed per call.** The result is a pure
  function of the code (fixed seed scenarios, default policy, no
  workspace input). Now computed once per process and served
  from memory: 44 ms -> ~0 ms after the first call.
- **F2. PDF export re-rendered per download.** Rendered bytes are
  now cached per tenant, keyed by a hash of the bundle with
  generated_at excluded (proven the only volatile field). A
  repeat download returns the identical file; any new run,
  decision or audit entry changes the bundle and re-renders
  exactly once.
- **F3. Workspace state double queries.** _workspace_state ran
  open_invoices() and all_payments() twice each per call - the
  most-called endpoint in the product. Now computed once.

FIXED IN THIS PACK (frontend, consolidated here per the owner):
- **F4. Run cumulative chart.** Removed (owner override), and
  the dead geometry helpers (runChartGeometry, CHART_COLS,
  CHART_LABELS) deleted from lib/operate.ts.
- **F5. Post-run audit detail.** One section per run - posted /
  held / not posted with the reason from the run record - with a
  Copy button producing the same lines as plain text.
- **F6. Live agent strip.** Verified element by element against
  vanilla's AGENT_LIVE/agentStripHtml: same six agents, same
  count strings ("N wires in", "N resolved", "N of M solved",
  "N judged", "N of M decided"), same status words, same pills,
  orbs on the running agent, same closing note. At parity.
- **F7. Upload Center layout.** The two file streams (AR ledger,
  payments) now sit side by side (2-up on large screens, stacked
  only on small); the remittance input sits below them at full
  width (owner revision, 17:44 - it is a working surface, not a
  file option), with its analysis and the staged table also full
  width below. No function moved or lost. Verified geometrically
  and by screenshot in the running app.

SCHEDULED (frontend fabric, next UI pass):
- **F8. No shared workspace cache.** Twelve call sites fetch
  /api/v1/workspace independently; a shell-level store with
  stale-while-revalidate would cut a view transition from 3-6
  requests to the 1-2 that actually changed. Behaviour risk is
  low but real (the Stage 6 bug class lives here), so it ships
  with the refresh consolidation, not alone.
- **F9. One 618 KB JS bundle, no route splitting.** First load
  on the public link pays for every view. React.lazy per view
  plus a vendor split takes the initial payload to roughly the
  shell + Dashboard (~40%). The logo glass PNG is 316 KB as
  shipped; a web-sized derivative at the same 52 px display size
  removes most of that without touching the design.
- **F10. Four refresh mechanisms** (ws-refresh hook, reloadSignal
  prop, slate:intent events, storage events). They work, and
  each is load-bearing somewhere, but the plurality is the
  fragility: consolidate to the hook + intents, with Approvals
  migrated onto the hook, in the same pass as F8.

ROADMAP (unchanged, post-referral):
- **F11.** api.py is a 105 KB monolith with 61 endpoints and the
  process-global state (_repos, caches, rate windows). It is a
  maintainability ceiling, not a performance one: split by
  domain when the PostgreSQL move happens, not before.
- **F12.** Kernel subprocess per payment (~1.5-4 ms overhead per
  call, 10 ms at the maximum gate): PyO3 in-process binding
  removes it; irrelevant at demo scale, real at batch scale.
- **F13.** Single-worker serving: correct for one demo link;
  the queue + multi-worker item already sits on the roadmap.

## The plan

1. This pack: F1-F7, with tests (suite target: full green) and a
   rebuilt frontend bundle.
2. Next UI pass: F8 + F10 together (one fabric change, one
   verification), then F9 (splitting + image derivative).
3. Roadmap: F11-F13 with the Phase 3 dispositions note
   (slatematch-audit-dispositions-v3.md), which remains the
   single source for what is fixed, parked and open.
