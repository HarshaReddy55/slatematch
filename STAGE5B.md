# SlateMatch Stage 5B - fix pack v2 (sidebar shell, surface tiers, opaque floating surfaces)

Built 16 Nov 2026 on the Stage 5 v1 tree. **Stage 5 v1
(`slatematch-stage5-pack-v1.zip`) was REJECTED by Harsha on
inspection and must NOT ship.** This pack supersedes it; every
Stage 5 restoration, skeleton, drill and fix from v1 is carried
over unchanged (the gap register in STAGE5.md still stands).
Pack: `slatematch-stage5-pack-v2.zip` (web/src complete,
frontend/index.html, this file at the root). Evidence lives in
`~/workspace/slatematch-stage5b/` (screenshots, verify-*.json,
sample points). Suite: **168 passed** (baseline held exactly;
**zero contract-test changes** - see below). TypeScript strict
build clean. Flip rule applied: `frontend/index.html` md5 equals
`frontend/react/index.html` md5 (5540787b12b8f0e3a10bab61c1db149).
Vanilla untouched: `frontend/vanilla/index.html` md5
73b0874b216bc87dd96180a5ecb93683, the Stage 4 baseline. Final
bundle JS 603,824 bytes (v1: 601,940).

Harsha's verdict on v1, in his words: "The black isnt fixed and
the contents wasnt shifted from top to sidebar as per template",
and on the v1 More menu frame: "the dropdown is behind something
and the content isnt visible". Three fixes follow.

## Fix 1 - The sidebar shell (the Stack Glass template layout)

The template (uberdesigner.ai/t/stack-glass, intake section 9) is
a frosted sidebar app; v1 had slimmed the top strip instead of
adopting the layout. The shell is restructured:

- The left sidebar (`.glass-side`, frosted glass with backdrop
  blur 18px over the lit ground) carries, top to bottom: the
  SlateMatch brand block with the AUTONOMOUS CASH APPLICATION
  AGENT tagline; the view navigation as a vertical list with the
  existing spring pill (same Motion spring, layoutId "view-pill")
  gliding vertically between items, number pop included; the
  casebar's contents stacked in reading order (ACTIVE CASE
  identity, the verdict under `aria-label="Case brief"`, the four
  stat cells in a two-column grid with Latest run spanning both
  columns so the full run id never wraps mid-token, then the
  tenant and case selectors, Export audit & SAP bundle and the
  More trigger, all full-width); and a pinned footer with the
  PRODUCT DOCS / ACCESS KEY / MENU ghost actions.
- The middle of the sidebar is its own scroll region; brand and
  footer never scroll. At 1600x1000 the region fits with no
  scroll at all (scrollHeight 820 = clientHeight 820, harness-
  measured; the fit is exact - see weakest elements).
- The content column starts at the very top with the view's own
  head. No top casebar strip remains. **Dashboard first stat
  card: y=322 (v1) -> y=94**; the view title sits at y=40.
  Sidebar width: **272px** (273 with its border).
- The More menu is a fixed-position flyout anchored to its
  button, portalled to the document body (the sidebar's backdrop
  filter would otherwise become its fixed-position containing
  block): it flies right of the sidebar on desktop, drops under
  the button on phone widths, clamps inside the viewport once
  measured, and closes on outside click, Escape, scroll or
  resize. Harness-verified to anchor to the button's viewport
  rect exactly (left = button right + 8) before and after a
  page scroll.
- Phone (390x844, harness-verified with real taps): the sidebar
  collapses to a top bar - brand, the MENU toggle and the ACTIVE
  CASE identity stay visible; the toggle opens nav, the rest of
  the casebar and the footer; tapping a nav row navigates (and
  settles the bar); the More menu opens inside the viewport
  (left 16, right 250, bottom 815 of 844); no horizontal scroll
  collapsed or expanded (scrollWidth 390).
- Preserved, verified by the unchanged suite plus the parity
  harness: every Stage 4/5 function, aria label and behaviour -
  More menu items and their exact handlers, both selectors and
  their titles, Export (disabled state and titles), palette,
  session saves (Dashboard panel), docs drawer, access-key
  modal, Copilot, all casebar cell intents (Ledger flash
  landings, run comparison, approvals jump).
- One copy correction the move forced: the LoadError helper now
  says "set it with ACCESS KEY in the sidebar" (was "in the
  shell above"). No other copy changed.

## Fix 2 - Surfaces must not read black (three tiers)

v1's lift (#414143 floating, panels near #2B2B2C) was too small
to see. The tiers are now separated decisively, all measured by
PIL patch samples of the settled Dashboard on the ground-truth
workspace (verify-tiers.json, after-tiers.png):

| Tier | Floor | Measured | Sample |
|------|-------|----------|--------|
| Page ground | #232323 (exact) | **#232323** rgb(35,35,35) | content margin |
| Workspace panel | at or lighter than #3B3B3E | **#3d3d40** rgb(61,61,64) | outcome panel |
| Workspace card | at or lighter than #3B3B3E | **#424245** rgb(66,66,69) | first stat card |
| Floating (sidebar) | at or lighter than #48484C | **#4c4c51** rgb(76,76,81) | brand row |
| Floating (menu) | at or lighter than #48484C | **#4e4e52** rgb(78,78,82) | menu interior |
| Floating (palette) | at or lighter than #48484C | **#515155** rgb(81,81,85) | palette interior |
| Floating (bulk bar) | at or lighter than #48484C | **#515155** rgb(81,81,85) | bar surface |
| Floating (key modal) | at or lighter than #48484C | **#555559** rgb(85,85,89) | modal interior |

How: the React ground token returns to vanilla's #232323 (the
Stage 2 pass had deepened it to #1e1e1f; the tiers now separate
by lifting surfaces, not darkening the page); .glass-panel and
.glass-card stops lifted to the panel tier; .glass-input and
.glass-select lifted with them; the static lit radial ground
stays (centre shifted to 40% so the sidebar has light to frost;
no animation, the breathing beam stays refused).

Text contrast on the new tiers (WCAG, computed from the sampled
surfaces): body text (ink #f2f0ea) measures **13.79:1 on the
ground, 9.50:1 on panels, 8.79:1 on cards, 7.49:1 on the
sidebar, 7.27:1 on the menu, 6.93:1 on the palette and bulk
bar, 6.51:1 on the key modal - at or above 5.5:1 everywhere**,
as required. Secondary text: the muted tones were lifted one
step in the React theme only (--color-mut #a7a49d -> #c4c1ba,
--color-mut2 #7e7c77 -> #b3b0a9; vanilla keeps its own values)
so muted measures 6.02:1 on panels and 5.57:1 on cards; on the
sidebar it measures 4.75:1 (see weakest elements).

## Fix 3 - Floating surfaces are effectively opaque

The v1 defect, visible in its after-moremenu.png: the More menu
was translucent - the blue Refresh button and page text bled
through it and its items lost their edge. `.glass-pop` is now
effectively opaque: both gradient stops at **0.98 alpha** over
the lifted tint, so the backdrop contributes at most 2 percent;
the 16px blur remains as enhancement only. Every floating
surface rides the one recipe (More menu, command palette, both
slide-overs, docs drawer, access-key modal, Copilot, approvals
bulk bar, toast), so the fix is product-wide by construction.

Acceptance evidence (verify-opacity.cjs, after-moremenu.png,
after-moremenu-probe.png): the menu opened over the Dashboard
with a real mouse click; all five items crisp, nothing from
beneath discernible. A probe of full-saturation product blue
(#3D75E8, the Refresh button's own colour) was then placed
directly beneath the menu's lower half and the same in-menu
point sampled in both frames: **over page rgb(78,78,82), over
blue rgb(79,80,87) - per-channel deltas (1, 2, 5), inside the
6-point limit**. One geometry note, stated plainly: in the v1
frame the menu overlapped the Refresh button because the
casebar sat at the top right; in the sidebar shell that button
lives in the content head, out of the flyout's reach, so the
probe puts the same saturated blue beneath the menu instead -
the physical property under test (no bleed-through of a
saturated blue element) is identical, and the probe frame shows
the blue ringing the menu's edges while its surface stays an
even grey. Second surface: the command palette over the busy
Run view (after-palette-run.png) - every row crisp over the
chart, feed and code well; this also closes Stage 5's named
weakest element (the palette's show-through bottom edge). The
docs drawer and Copilot are framed in after-docsdrawer.png and
after-copilot.png; the bulk bar in after-bulkbar.png.

## Gates

- Suite: **168 passed**, baseline exact. **Contract-test
  changes: none.** Every Stage 3/4 assertion is a string or
  behaviour pin and the restructure preserved them all: App.tsx
  still mounts Casebar, Palette, Copilot, DocsDrawer, KeyModal
  and registers Policy Studio as view 09 with the vanilla nav
  numbers; Casebar.tsx still carries the full unsliced run_id
  and `aria-label="Case brief"` with no mini tiles; the palette
  keeps exactly two groups. No assertion was weakened, moved or
  deleted, so the pack needs no tests file.
- TypeScript strict build clean; flip rule re-applied after the
  rebuild (md5s above); vanilla byte-identical.
- Figure parity on the ground-truth workspace, exact (same
  needles as Stage 5's harness): Dashboard 93.8%, 75.0%,
  $597,100.00, exceptions 4, $22,120.00, $3,903, 9.3 ms, 88%;
  sidebar 16 staged, run_3cdff1bdf80f in full, approvals 3,
  verdict lines; Run "15 matches, 4 exceptions", AUTO_POSTED,
  the brief headline, "sign-off queue - 3 waiting".
- Two needles in MY parity harness were corrected during the
  run (harness artefacts, not app defects, the Stage 5 H-needle
  class): innerText applies the CSS uppercase transform to the
  kit's labels, so the Dashboard needles compare
  case-insensitively; and the queue's actual line is
  "sign-off queue - 3 waiting", not the "waiting for sign-off"
  I first wrote. Run.tsx is untouched by this stage.
- Hover stays transform-free (Stage 5 gate re-run on the new
  surfaces: stat card box (347,94) identical under a real hover,
  computed transform none).
- Skeletons still mount in the new shell (37 Dashboard blocks
  under a 1400ms API delay, computed animation-name none) and
  settle to the real figures.
- Spot-checks after the shell change, end to end:
  (a) Dashboard drill - the Open exceptions card opens Run
  Reconciliation filtered, banner "4 of 15 matches shown";
  (b) Draft reminder on a FRESH session - load the demo case
  from the empty Dashboard, execute the staged batch (Forecast
  is post-reconciliation by design; its collections gate on a
  completed run), draft from INV-1009's row in Forecast, send,
  and the Mail Hub outbox gains kind `collection_reminder`,
  ref_id INV-1009, status `recorded_not_sent` with the true
  status line shown.
- No em dashes anywhere in web/src (grep, 0 hits).

## DELETIONS - carried over from Stage 5 unchanged

For Harsha to delete in his clone before committing -
byte-identical duplicates of the vanilla copies, referenced by
nothing served:

- `frontend/css/livecube.css` (md5 3cc7387d082f4cd5b7fd596d33669b30)
- `frontend/js/assist.js` (md5 9907daae9ea24b5e44cd37c4019c1e36)
- `frontend/js/insight.js` (md5 8801a238db8bd9d5949b20c3a3b25300)
- `frontend/js/operate.js` (md5 a279043694fc401f6dbb856cb09827b9)
- `frontend/js/orbs.js` (md5 89b3636d6889a7832289f69ac7147176)
- `frontend/js/state.js` (md5 ef4f82110c30413aac79025c2098eb46)

**DO NOT DELETE `frontend/js/vendor/`**: `web/src/ui/Orb.tsx`
imports `frontend/js/vendor/orbs-engine.js` and the Dockerfile
copies it into the web build; deleting it breaks the React
build. Keep it (and THINKING-ORBS-LICENSE.txt) intact. The
`/react/` path also stays, per the standing decision.
`frontend/vanilla/` and the backend are untouched.

## Weakest elements, honestly

1. **Sidebar muted micro-labels.** Muted text on the sidebar
   measures 4.75:1 and mut2 3.94:1 - the 13px inactive nav
   labels clear WCAG AA, but the 9.5px brand tagline and the
   casebar's kickers are the least contrasty text in the
   product. Lifting them further compresses the ink-to-muted
   hierarchy the whole console reads by; recorded, not hidden.
2. **The sidebar fit is exact, not roomy.** At 1600x1000 the
   scroll region fits with zero slack (820 of 820). A longer
   case name or a longer verdict wraps taller and the region
   scrolls a few pixels to the Export and More controls -
   graceful, and the footer actions never scroll, but the
   common case has no headroom.
3. **Select faces truncate.** At the sidebar's 240px inner
   width the tenant and case selects clip their selected
   option's text ("Demo workspace - US - SAP S/4HAI...").
   Native select behaviour, better than v1's 178/188px strip
   selects, and the full names live in the option list and the
   control titles - but the closed face does not show the
   whole tenant name.
4. **The flyout is 234px wide, not 216.** This stack has no
   preflight, so content-box sizing adds the menu's padding
   and border to its styled width. Cosmetic only; its
   position is measured and clamped after mount.

## Not verified

- The locked branch of the access-key copy (no live locked
  server; unchanged from Stages 4 and 5, contract-tested, text
  verbatim).
- Nothing in this stage was deployed by me: Harsha pushes and
  force-deploys, and the parent verifies from the ALB
  afterwards.
