# SlateMatch consolidated pack - 16 Nov 2026

**Deploy this pack ONLY.** Version 2 revises the Upload Center
layout (remittance moved down, per the owner) and supersedes
slatematch-consolidated-pack-v1.zip plus three packs that were
never deployed: slatematch-phase3-pack-v2.zip,
slatematch-logo-run-pack-v2.zip and slatematch-logo-pack-v1.zip.
Do not deploy any of those.

## What is in it

**Phase 3 hardening (backend)** - the residuals pack, unchanged:
kernel CLI errors without unwrap, rightmost X-Forwarded-For hop,
per-IP anonymous rate-limit bucket with dictionary pruning,
session snapshot cap (20 per tenant) plus the ephemeral
workspace reaper (7 days, 256-file cap), Unicode PDF fonts with
transliterating fallback, model warm-up on a daemon thread, and
the Section E subsidiary boundary in candidate resolution.
Detail: PHASE3.md.

**Interconnection optimizations (backend, new)** - from the
analysis in ANALYSIS.md, measured before and after:
- PDF audit export renders once per identical bundle and serves
  repeats from memory (was 2.44 s on every download; the bundle's
  only volatile field, generated_at, is excluded from the cache
  key, proven by a two-build diff, so a repeat download returns
  the same file and any new run or decision re-renders once).
- Evaluations compute once per process (the result is a pure
  function of the code: fixed seed scenarios, default policy).
- The workspace endpoint queries the open-invoice and payment
  lists once instead of twice.

**Logo and brand (frontend)** - Harsha's mark wired in: cleaned
HQ glass at 60 px in the sidebar, bold 28 px slash wordmark with
the taller L at original spacing, tagline on one line, favicon
tiles. Design unchanged from the approved set.

**Run Reconciliation orders (frontend)**:
- Cumulative outcome chart removed (owner override, React only;
  vanilla keeps its own) and the dead chart helpers deleted.
- During-run agent strip matches vanilla: animated orb on the
  running agent, blue pulse card, dimmed queued cards, same
  counts, words and pills.
- Audit detail panel under Exceptions: one line per payment -
  POSTED, HELD or NOT POSTED - with matched invoices, allocated
  and unapplied amounts, and the reason from the run record,
  plus a Copy button (plain text). Verified line-for-line
  against the API record on the demo run (16 payments: 10
  posted, 5 held, 1 not posted) and screenshotted in the real
  app before packing.

**Upload Center (frontend)** - the two file streams (AR ledger,
payments) sit side by side; the remittance input sits below
them at full width (owner revision: it is a working surface,
not a file option). Every dropzone, paste area, sample,
template and import action kept; the remittance analysis and
the staged table stay full width below.

## Verification before packing

- Full test suite: **194 passed** on a clean solo run (192
  previous + 2 new optimization tests). Note: the suite's
  session tests share one on-disk data folder, so two suites
  running at the same time corrupt each other - the failures
  seen earlier today were exactly that, two chats testing
  simultaneously. Run the suite once, alone.
- Web build clean (TypeScript + Vite); frontend/index.html
  re-copied from the fresh build.
- Real-app screenshots inspected: Run view (no chart, agent
  strip, canonical figures), Audit detail panel, Upload Center
  side-by-side, brand block.

## Deploy

Copy every file into the GitHub Desktop clone at the same path,
commit, push, then Update service **slatematch-app** with
**Force new deployment**. Part B stays parked; this pack changes
no auth behaviour.

Suggested commit message:

```
Consolidated: Phase 3 hardening, optimizations, logo, Run orders, Upload side-by-side

- Phase 3: kernel errors, IP trust + per-IP anon bucket, bounded
  sessions, Unicode PDF, warm-up, subsidiary boundary
- Optimizations: PDF render cache, evaluations cache, workspace
  single-query (suite 194)
- Logo: 60px glass mark, bold slash wordmark, favicons
- Run: chart removed, vanilla agent strip, audit detail + Copy
- Upload: three input streams side by side
```
