# SlateMatch motion and glass pack: Stack Glass adaptations

Built 15 Nov 2026 on top of the Stage 2 + fix pack state, under
Harsha's direction of the same day: adapt the Stack Glass template
(uberdesigner.ai/t/stack-glass), starting from motion and the
transitions, then the design. This pack merges three things into one
deploy: the Stage 2 React Insight views, the four defect fixes
(FIXES.md), and the motion and glass work below. React side only;
the vanilla app is untouched by the motion work.

Updated the same day for the glass pack
(slatematch-stage2-fixes-glass-v1.zip, which supersedes the motion
pack): Harsha chose "Push the glass design further", widening glass
from the tab bar to every surface (section 5 rewritten, GLASS.md
carries the recipe), and asked for the motion side deepened in the
same pack (sections 7 to 9). Sections 1 to 4 and 6 stand as built
in the motion pack and were re-verified unchanged in the glass
pack's parity run.

Source behaviours in Stack Glass, for reference: a frosted-glass
sidebar whose highlight springs to the clicked item and pops its
icon; page titles that roll up and in; cards rising in one after
another; counters that tick up as new rows land; a drop zone that
lights on drag-over; a breathing light beam and drifting specks
behind the glass (refused here, see the last section).

## 1. Spring nav highlight (App.tsx)

- What: the active tab's blue ground is now a Motion layout element
  (layoutId "view-pill") that physically glides between tabs instead
  of the old instant class swap. The tab's number scales from 1 to
  1.18 and brightens (opacity 0.7 to 0.95) on the same spring when
  its tab becomes active: the Stack Glass icon pop, kept subtle.
- Parameters: spring stiffness 500, damping 40, mass 0.9 (exported
  as NAV_SPRING in web/src/ui/motion.tsx). Stiff and heavily damped:
  fast travel, no visible overshoot theatrics.
- Evidence: motion-pill-midflight.png catches the pill stretched
  mid-glide between Evaluations and Agent Health 110ms after the
  click. A rapid-switching pass (7 tab changes at 60ms intervals)
  ends with exactly one pill, on the final tab, with the matching
  view on screen: no stuck or doubled indicators.

## 2. View-enter choreography (web/src/ui/motion.tsx, all five views)

- What: one shared treatment, implemented once in the kit as
  TitleRise and Rise, applied to Dashboard, Ledger, Forecast,
  Evaluations and Agent Health. The ViewHead title block (and the
  Dashboard's own header) rises 16px and fades in over 340ms; each
  top-level panel, card grid and section then follows via Rise:
  12px rise and fade, 240ms, staggered at 45ms steps with the delay
  capped at 270ms, all on the kit's EASE_OUT curve
  cubic-bezier(0.16, 1, 0.3, 1). A typical four-to-five block view
  settles inside roughly 400ms. There are no exit animations, so
  navigation is never delayed by leaving a view.
- Blocks animate when they mount, which for data-driven blocks is
  the moment their data arrives, so the choreography reads as the
  view assembling from its own figures.
- This replaces the Dashboard's one-off 400ms entrance from Stage 1;
  the treatment is now identical on every view.

## 3. Count-up on change (web/src/lib/useRollUp.ts, StatCard)

- What: StatCard headline figures already rolled up on load; the
  hook now also counts when a value changes, animating from the
  previous value to the new one instead of restarting at zero.
  First arrival still rolls from zero, the Stack Glass counter
  behaviour. Scope is unchanged and sparing: StatCard headlines and
  the Dashboard MiniStats only, never table cells.
- Parameters: 650ms, ease-out cubic. The caller's formatter renders
  every frame, and the final frame is set with format(target)
  itself, so the settled text is byte-identical to a static render
  (currency, percents and decimals preserved exactly).
- Evidence: sampled live during a first load, the Touchless figure
  ran 0.0%, 8.5%, 24.1%, 33.7%, 41.4%, 52.5%, 58.8%, 61.9%, 62.4%,
  62.5%: monotonic, settling on the exact static value.

## 4. Feed slide-in (Agent Health audit trail)

- What: audit feed rows are now motion elements that slide in from
  x -10px with a fade when they mount and when new rows arrive on
  refresh: 250ms, EASE_OUT, with a 30ms per-row stagger capped at
  300ms. No looping, no ambient motion; a settled feed is still.
- Why: the feed is the product's record of things happening; a row
  arriving should read as an event landing, the way Stack Glass
  slides a new activity row into its list.

## 5. Glass (all surfaces, widened in the glass pack)

- What: glass now covers every surface in the React build. Panels,
  cards and the tab bar are translucent, backdrop-blurred, carry a
  1px top-edge light line and a soft deep shadow, and sit on a lit
  ground: a deepened React-only ground (#1e1e1f) with a static
  radial glow in the product blue at the top of the viewport. The
  full recipe, per surface, with alphas, blurs and highlights, is
  in GLASS.md.
- Supersession, recorded plainly: the motion pack kept glass on
  the tab bar only (rgba(35,35,35,0.78), blur 14px), on the ground
  that it was the only surface honestly sitting over scrolling
  content. Harsha's explicit choice on 15 Nov 2026 ("Push the glass
  design further") supersedes that boundary. The tab bar glass
  deepened to match the new family (rgba(28,28,29,0.72), blur 16px,
  saturate 1.2, top light line).
- The widening was gated on legibility: the first recipe measured
  softer than the flat build for small text (5.29:1 vs 5.53:1) and
  was rebuilt with the flat build's own colours at higher alpha
  before packing; the shipped recipe measures 5.76:1 vs the flat
  build's 5.53:1. Method and numbers in GLASS.md.
- Still refused inside the widening: animated ambience. The glow
  is static; nothing breathes, pulses or drifts.

## 6. Reduced motion

- Every animation in this document honours prefers-reduced-motion.
  Rise and TitleRise render plain divs at the final state (no
  transform, no stagger), the nav pill's spring and the number pop
  collapse to zero duration, feed rows mount without the slide, and
  useRollUp lands on the final value immediately. Reveals render
  instantly (plain div, or absent when closed), RefreshFade never
  fades, and CSS kills the hover lift, press response and glass
  transitions.
- Evidence: with reduced motion emulated, the first rendered
  Touchless value was already the final 62.5% (re-verified on the
  glass build), the Forecast drill content was present instantly
  with no reveal container, and no element in the view carried an
  enter transform.

## 7. Animated reveals (glass pack)

- What: expandable detail that used to appear instantly now opens
  with a height-and-fade reveal on the shared tokens, and closing
  reverses it. Reveal (web/src/ui/motion.tsx) animates the
  container only: height 0 to auto with opacity, 320ms in and
  200ms out on EASE_OUT, overflow hidden while animating; the
  inner content never moves or reflows.
- Where: the Forecast week drill under the fan chart (switching
  weeks exits the old table and enters the new one), the Forecast
  what-if result (its key is constant, so moving the slider swaps
  the table in place under the open reveal instead of
  re-animating), and the Agent Health status-bar detail readout.
  The other views were checked: Ledger's filter and sort are
  presentational (its rows stay mounted), and Evaluations streams
  pack rows by design; neither has an expand/collapse to animate.
- Evidence: the drill was sampled mid-animation at height 214.4px
  and opacity 0.944 against a settled 223px at opacity 1, settling
  unclipped; the Health readout's height was sampled rising in-page
  (0 to 29.25 to a settled 30.5px, full readout text intact).
  Under reduced motion the drill content is present instantly.

## 8. Press and hover depth (glass pack)

- What: glass panels and cards lift physically on hover:
  translateY(-2px) with a deepening shadow, 0.22s on EASE_OUT, the
  template's folder lift kept subtle and functional. Interactive
  rows that lead somewhere get the same family: the Agent Health
  status-bar buttons brighten on hover and press to scale 0.97
  (.pressable, 0.15s EASE_OUT); table rows keep their hover and
  gain a transition so the change is not a hard switch. No glow
  effects on hover.
- Evidence: the hovered first Dashboard card's computed transform
  measured matrix(1, 0, 0, 1, 0, -2) in the verification run.

## 9. Refresh cross-fade (glass pack)

- What: when a Refresh re-fetch changes a region's data, the
  region fades from opacity 0.3 back to 1 over 280ms instead of
  hard-flashing the new rows in. RefreshFade
  (web/src/ui/motion.tsx) takes a signature describing the data
  (row counts, totals, the latest entry), never UI state, so
  filtering or sorting never triggers it, and a refresh whose
  figures are unchanged does not fade at all (there is nothing new
  to flash). StatCards already count up on change; this covers the
  tables and feeds. No skeleton theatrics.
- Where: Ledger invoices, Forecast collections, the Agent Health
  status strip and audit feed, and the Dashboard run history.
- Evidence: the mechanism was verified in isolation with the real
  component (verify-report-fade.json in the glass evidence folder):
  on a signature change the wrapper opacity sampled 0.3, 0.798,
  0.943, 0.985, 1 across about 290ms while the content swapped;
  under reduced motion it never left 1 and the content still
  swapped. In the app, a refresh of unchanged data was sampled for
  3 seconds and never dipped, which is the signature gate working
  as designed.

## Verification (local, one workspace, run exactly once)

Recipe: uvicorn from the autocash venv, throwaway DATA_DIR, one
fixed X-Workspace-Session, demo case seeded via API, workspace run
exactly once (run_189474847982: 16 payments, 15 matches, 10
auto-posted, 4 exceptions). React figures were asserted in the DOM
against values computed independently in Python from the same
session's API payloads, and against the Stage 2 recorded values.

- Dashboard: resolution 93.8%, touchless 62.5%, cash posted
  $411,800.00, exceptions 4, suspense $22,120.00, hours returned
  2.0 h, line touchless 75%, recovery $3,903, avg latency 6.8 ms,
  settled lines 16. All match the API computation exactly.
- Ledger: 7 open, $589,380.00 open value, $366,900.00 overdue;
  cube and invoice rows match Stage 2 line by line.
- Forecast: expected 30d $379,355.04, horizon $379,380.00, at risk
  $210,000.00 (1); weekly bands and collections priorities match
  Stage 2 (INV-1009 priority 1095502.4 at the top).
- Agent Health: MAE 2.948, AUC 0.846, 62% improvement, 960 train /
  240 test, status summary 0.0% up (0 of 1 runs), audit feed
  rendering both entries.
- Evaluations: MILP 100%, greedy 80%, exact 100%, case verdict all
  PASS. Scenario pack counts match this session's API ground truth
  pack for pack, in order (3/3, 3/3, 5/5, 4/4, 5/5, 3/3, 3/3, 3/3,
  6/6, 3/3). Note: as a multiset that differs from the Stage 2
  session by one pack (Stage 2 recorded three 5-check packs, this
  session has two, with one more 3-check pack). That is server-side
  scenario behaviour between sessions; the React view renders
  exactly what this session's API returned, verified directly
  against it.
- Full test suite: 152 passed (unchanged baseline).
- Vanilla: frontend/index.html, frontend/js and frontend/css are
  byte-identical to the fix-pack state (md5 comparison over the
  tree, excluding the rebuilt frontend/react bundle, which the
  Dockerfile rebuilds from web/src at image build anyway).
- TypeScript strict and the production build pass (bundle
  416.7 kB, 132.1 kB gzip).

Weakest elements, named per the design gate:
- Dashboard: the right-side AUTONOMOUS CASH APPLICATION AGENT label
  is the lowest-contrast element on the glass bar. It is a whisper
  label by design; pass.
- Ledger: at partial scroll a table row can sit half under the
  glass bar with momentarily reduced contrast. Inherent to a sticky
  glass bar; the blur keeps it legible; pass.
- Forecast: the chart column is far taller than the Collections
  panel, leaving dead space under Collections. Pre-existing Stage 2
  layout, untouched by this pack; noted for a later pass.
- Agent Health: a one-run status strip is a single amber segment.
  Known Stage 2 characteristic, capped at 34px; pass.
- Evaluations: raw JSON in the verdict table. Deliberate evidence
  parity with vanilla; kept.
- Found and fixed during this pass: the first build dropped the
  tabs' transparent background class when the pill replaced the old
  active background, and with no CSS preflight in this stack the
  browser's native button face showed through as white tabs.
  Caught on the first screenshot inspection, fixed, rebuilt and
  re-verified (motion-nav-top.png).

## Verification addendum (glass pack, 15 Nov 2026)

Same protocol, new workspace, run exactly once (run_2b023d7da39d:
16 payments, 15 matches, 10 auto-posted, 4 exceptions). DOM figures
were asserted against the same session's API ground truth and the
Stage 2 recorded values: Dashboard 93.8% / 62.5% / $411,800.00 /
$22,120.00 / 2.0 h / 75% / $3,903 / 16 settled; Ledger 7 /
$589,380.00 / $366,900.00; Forecast $379,355.04 / $379,380.00 /
$210,000.00 (1) with INV-1009 priority 1095502.4 on top; Health
MAE 2.948 / AUC 0.846 / 62%; Eval 100 / 80 / 100 with all ten
scenario packs present. 69 of 69 checks passed on the final build
(verify-report-3.json in ~/workspace/slatematch-glass/), plus the
3-check isolated RefreshFade test. Full suite: 152 passed.
TypeScript strict clean (bundle 421.8 kB, 134.0 kB gzip). Vanilla
byte-identical (md5 over the tree; only web/src changed). Glass
legibility evidence is in GLASS.md.

Weakest elements on the glass build, named per the design gate:
- Dashboard: the footer mono line (mut2 on the deepened ground,
  outside any panel) is the lowest-contrast text on the view; a
  footnote by design. Pass.
- Ledger: the filter input's placeholder is the dimmest element;
  de-emphasised by design. The cube panel's wide empty right region
  is pre-existing column spread. Pass.
- Forecast: dead ground under the shorter Collections panel in the
  two-column grid. Pre-existing Stage 2 layout; noted again for a
  later pass.
- Agent Health: a one-run status strip is a single amber segment.
  Known characteristic; pass.
- Evaluations: raw JSON in the verdict table. Deliberate evidence
  parity; kept.

## Refused from Stack Glass, per the intake verdict

The breathing light beam and drifting specks (ambient decoration),
the folder tip-open theatrics, the near-black #040404 ground and
red accent, and the Geist typeface. No new colours, no new fonts,
no ambient loops anywhere in this pack. Glass across the workspace
was refused in the motion pack and then adopted in the glass pack
on Harsha's explicit direction; the ambient parts of that refusal
stand unchanged.

## Still queued

The Upload drop-zone lighting on drag-over (intake item 5) stays
queued for Stage 3: there is no React Upload view yet, and the
vanilla Upload Center is out of this pack's React-only scope. It is
recorded here so it is not silently dropped.
