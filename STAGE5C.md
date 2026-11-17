# STAGE 5C - Fix pack v3: the casebar returns to the content strip, the black font is root-caused, and a full visual audit

Date: 16 Nov 2026. Tree: ~/workspace/slatematch. This pack supersedes
the Stage 5B pack (slatematch-stage5-pack-v2.zip), which Harsha
rejected on inspection, as he had v1. Neither v1 nor v2 was deployed.
v3 keeps everything in v2 that was right (the lifted surface tiers,
the 0.98-alpha opaque floating surfaces, the static skeletons, every
Stage 5 restoration and drill) and fixes what he found. Nothing in
this pack was deployed by Muse; Harsha pushes and force-deploys.

Harsha's verdict on v2, in his words: "The sidebar must contain the
contents not the demo case details itself, the font is black still,
check it and the demo case isn't expanding on clicking like our
vanilla and every page needs to have the case details as in vanilla.
There are so many clear visual problems, I don't know what you are
hiding underneath, I can't even trust the capabilities of the
platform now." Each finding is answered below with the reproduction,
the root cause, the fix, and the verification. The full visual
problems register (section 6) lists everything the frames showed,
including what was left open and why.

## 1. Structure: the sidebar is navigation only, the case details are back on every page

What changed: `web/src/App.tsx` no longer mounts the Casebar inside
the sidebar. The sidebar now holds exactly the contents: the brand
block, the vertical view navigation with the spring pill, and the
footer shell actions (PRODUCT DOCS / ACCESS KEY / MENU), which are
shell actions, not case details. `web/src/ui/Casebar.tsx` was
rewritten as the slim strip from v1 and is mounted at the top of the
content column, so it appears identically on all 11 views, as in
vanilla: ACTIVE CASE identity, the four stats (open invoices,
payments staged, latest run, approvals waiting), the verdict line,
the workspace and case selectors, Export audit & SAP bundle, and the
More menu.

Measured geometry on the settled demo workspace (1600x1000): strip
height 109px with the two-line verdict; the Dashboard's first stat
card starts at y=219. Honest cost, recorded not hidden: v2's sidebar
layout put the first card at y=94. The strip on every page is what
was asked for, and it costs about 125px of above-the-fold height
against the rejected layout. On phone (390px) the strip stacks: the
stats become a 2x2 grid, the verdict takes the full width, the
selectors take the full width, and there is no horizontal scroll
(measured scrollWidth 390 = innerWidth 390).

The strip's internals kept every v2 behaviour: the stat cells are
still buttons with their drills, the run id is rendered in full,
never sliced, the verdict keeps its "Case brief" aria label, and the
More menu keeps its opaque glass surface (re-verified in its new
position, section 5).

## 2. The black font: root cause, and a programmatic audit that now gates it

Harsha's four values ("5", "16 staged", "run_3cdff1bdf80f", "3")
rendered as rgb(0,0,0), pure black, at 2.39:1 on the sidebar. They
were not a casebar bug. They were one product-wide root cause with
three parts, all in what the React stylesheet never ported from
vanilla:

1. No base colour rule for form controls. Vanilla's livecube.css
   (line 83) gives every select, input and textarea an opaque
   background and the ink colour. The React stylesheet has no
   preflight and never declared an equivalent. Any text node inside
   a `<button>` without an explicit colour utility inherited the
   browser's default button text colour, which is near-black. That
   is why the casebar's stat values (rendered inside stat buttons)
   were black while their labels, which carry a colour class, were
   light. The same defect made the Run view's six agent names
   (Capture, Linking, Matching, Deduction, Policy, Briefing, a `<b>`
   inside buttons) render pure black at 2.15:1, and the Mail Hub's
   case title "P3 - BluePeak Electronics" black at 2.20:1.
2. No `color-scheme` declaration. The browser therefore painted
   native control surfaces, including the opened list of a
   `<select>`, in the light scheme (finding 4 below).
3. Dead token references. `.glass-input` referenced `var(--ink)`,
   `var(--mut2)` and `var(--blue)`, which do not exist (the theme
   tokens are `--color-*`). Those declarations were silently
   invalid, so the glass treatment on inputs partially never
   applied.

The fix is at the root, in `web/src/index.css`, not at the nodes: an
explicit layer order (`theme, base, utilities`), a base rule giving
button, input, select and textarea `font: inherit; color: inherit`,
`:root { color-scheme: dark }`, and the `.glass-input` token
references corrected with a solid background under the gradient.

The audit gate (new, `audit-contrast.cjs` in the evidence folder):
walk every visible text node in the shell and all 11 views on the
settled demo workspace, compute each node's effective colour
(compositing any opacity chain) against its effective background
(ancestor backgrounds and the glass tiers composited over the
#232323 ground), compute the WCAG luminance ratio, and fail on
anything under 4.5:1. One stated limitation: backgrounds painted by
absolutely-positioned sibling overlays (the nav pill under the
active label) are not ancestors and are not composited; the pill's
pairing was verified by frame inspection instead.

Before the fix: 1,843 text nodes walked, 375 offender nodes, 106
distinct offenders. The worst 20:

| # | Ratio | Colour on background | Where | Text |
|---|-------|----------------------|-------|------|
| 1-6 | 2.15 | rgb(0,0,0) on rgb(68,68,71) | Run | Capture / Linking / Matching / Deduction / Policy / Briefing |
| 7 | 2.20 | rgb(0,0,0) on rgb(64,69,83) | Mail | P3 - BluePeak Electronics |
| 8-10 | 2.29 | #e5484d on its tint | Upload | invoice reference INV-1001 / INV-1002 / PO reference PO-11 not found in open ledger |
| 11 | 2.39 | rgb(0,0,0) on rgb(74,74,79) | Dashboard strip | 5 |
| 12 | 2.39 | rgb(0,0,0) on rgb(74,74,79) | Dashboard strip | 16 staged |
| 13 | 2.39 | rgb(0,0,0) on rgb(74,74,79) | Dashboard strip | run_3cdff1bdf80f |
| 14 | 2.39 | rgb(0,0,0) on rgb(74,74,79) | Dashboard strip | 3 |
| 15 | 2.40 | #e5484d on its tint | Ledger | At risk |
| 16 | 2.64 | #e5484d on panel | Run | Needs investigation 0 (chart legend) |
| 17-20 | 3.26 | muted ink at 0.7 opacity on sidebar | Dashboard | nav numbers 02 / 03 / 04 / 05 |

Below those sat the rest of the family: the ok, warn and blue2
status tones used as text (3.41 to 4.48), white on the primary blue
(4.28), blue2 links (4.24), the muted tagline on the sidebar (4.06),
and the Mail count badge dimmed by an opacity utility (3.33).

Fixes beyond the base rule, all React-theme only (vanilla's tokens
are untouched): the text tones were lifted one step each
(ok #34bf71 to #5eeaa0, warn #f2c14e to #f5cb5f, bad #e5484d to
#ff9ea0, blue2 #7fa6f2 to #a3c0f7, mut2 #b3b0a9 to #c2c0ba) and the
primary blue was deepened one step (#3d75e8 to #3570e0) so white on
it clears the line; the pill background tints did not change, so the
colour coding reads the same, only lighter on the text side. The
nav pill animation no longer animates a 0.7 opacity leg (the scale
pop stays). The Mail badge's opacity utility was removed. The Run
chart's legend colours (CHART_COLS in `web/src/lib/operate.ts`)
were aligned to the same lifted tones.

After the fix, on the final build: 1,849 text nodes walked, ZERO
offenders. Every text node in the product is at or above 4.5:1 by
measurement, not by eyeball.

## 3. The selectors: glass treatment, full faces

The workspace and case selectors now carry the same glass-input
treatment as every other form control (they are the `.glass-select`
class in Casebar.tsx, given the identical recipe: solid #3a3a3d base
under the lit gradient, explicit ink colour, the standard border).
With `color-scheme: dark` their opened lists render dark (section
4). Their closed faces are not truncated at desktop width: the
tenant selector is 264px and the case selector 288px, and both
faces show in full in the frames ("Demo workspace - US - SAP
S/4HANA", "Demo case - one realistic day of receipts").

Two honest details. First, the tenant face only fits because a
leftover `font-mono` on its label wrapper was removed: the mono
face made the 33-character name about 40px wider than the same text
in Inter, and keeping mono at full width pushed the strip from
109px to 131px (measured). The two selectors now share one font,
which is also the more consistent presentation; vanilla's mono
tenant pill truncates far more than this ever did. Second, the
verdict's wrap depends on the column width: two lines at the full
1600px width, three when a page scrollbar narrows the column. The
strip is minimum-height, not fixed, so nothing ever clips; its
height ranges 109 to 131px accordingly.

## 4. The demo case expansion: reproduction, cause, click-verified fix

Reproduction (before any fix, current v2 build and vanilla side by
side, real mouse clicks in a headless browser): in React the case
selector DID receive the click (mousedown, focus and click all
fired on it; the hit test at its centre returned the select itself;
it was not disabled; no overlay intercepted it). The native list
opened, but it painted as a white popup whose option text was
near-white: only the single highlighted row was readable. To anyone
using it, the case list does not expand. Vanilla's identical native
select opens a dark, fully legible list. So the sidebar placement
was not the mechanical cause; it was the same missing-base-rule
family as the black font: with no `color-scheme` declared and a
transparent background on the select, the browser chose the light
scheme for the popup while the options took the app's light ink
colour. White on white.

Fix: `color-scheme: dark` on `:root` plus the opaque glass face on
`.glass-select` (section 3). Click-verified end to end on the final
build, on throwaway sessions so the ground-truth workspace was
never mutated: a real click opens the list, which renders dark with
every option legible (frame: after-select-open.png); choosing the
Demo case loads it (toast "Case loaded: Demo case - one realistic
day of receipts - 19 invoices, 16 payments staged", identity and
selector update); choosing the scenario "split-exact" loads that
case (identity becomes "Split payment across two invoices", toast
confirms 18 invoices, 12 payments staged; frame:
after-case-switched.png).

## 5. What else the visual audit caught: the box-sizing contract

The full-frame pass (section 6) found one more defect with the same
shape: in Policy Studio, the first one or two characters of every
field explanation were clipped ("inimum solver confidence", "ow
strongly the solver prefers"). Root cause: the React stylesheet
also never ported vanilla's global `*{box-sizing:border-box}`.
Under the default content-box sizing, each padded full-width input
is padding-plus-border wider than its column; Policy's rigid
180px input column overflowed by 22px into the explanation column.
The same cause is why Stage 5B's More flyout measured 234px
against its styled 216. Fix: the border-box rule added to the same
base layer. Verified in frames: every Policy explanation now reads
in full, and the More menu measures exactly 216px. The More menu's
opacity acceptance was re-run in its new strip position: the same
in-menu point samples rgb(81,81,85) over the page and rgb(80,82,89)
over a saturated blue probe placed beneath it, deltas (1, 1, 4)
inside the 6-point limit; in the probe frame the blue rings the
menu's edges and never shows through its surface.

## 6. VISUAL PROBLEMS register

Every frame was inspected at full size: all 11 views in the new
layout, the More menu open (normal and over the blue probe), the
command palette over the Run view, the case list open, the strip at
2x, and the phone layout collapsed and expanded. Severity is the
user-visible harm. Disposition is fixed in v3 unless stated.

| # | Defect | Severity | Disposition |
|---|--------|----------|-------------|
| R1 | Case details lived in the sidebar; most pages showed no case context at the top (Harsha finding 1) | Critical | Fixed: nav-only sidebar, case strip on every view (section 1) |
| R2 | Black text: casebar stat values, Run agent names, Mail case title, all rgb(0,0,0) at 2.15 to 2.39:1 (finding 2) | Critical | Fixed at the root: base colour rule; audit at zero (section 2) |
| R3 | Selectors rendered as near-black slabs with truncated faces (finding 3) | High | Fixed: glass treatment, dark scheme, widths sized to full faces (section 3) |
| R4 | Case list opened white with near-white option text; effectively unusable (finding 4) | High | Fixed: color-scheme dark + opaque face; click-verified end to end (section 4) |
| R5 | Policy Studio explanations clipped at their left edge by overflowing inputs | High | Fixed: border-box base rule; explanations read in full (section 5) |
| R6 | Status tones (ok, warn, bad, blue2) and white-on-blue sat between 2.29 and 4.48:1 as text | Medium | Fixed: React-theme tone lifts, blue deepened, tints unchanged (section 2) |
| R7 | Run chart legend labels used the raw status hexes (2.64 and 4.34:1) | Medium | Fixed: CHART_COLS aligned to the lifted tones |
| R8 | Nav item numbers dimmed to 3.26:1 by an opacity leg in the pill animation | Low | Fixed: opacity leg removed, scale pop kept |
| R9 | Mail category count badge dimmed by an opacity utility over blue (3.33:1) | Low | Fixed: opacity removed |
| R10 | Upload Center step cards 1 to 3 are mostly empty space; the row stretches to the tallest card (Trust decision) | Low | LEFT OPEN: pre-existing Stage 3 panel layout, content complete and legible; rebalancing view internals is outside this pack's findings. Named here so it is a decision, not an oversight; it is also this pack's weakest element |
| R11 | Forecast fan-chart plot area and the Run payload well are near-black surfaces | Info | By design: data wells, matching vanilla; every text node on or around them passes the audit. Not the defect class Harsha reported |
| R12 | Verdict wraps to 3 lines when a page scrollbar narrows the content column | Info | Accepted: strip is minimum-height and adapts (109 to 131px); nothing clips (section 3) |
| R13 | Use Cases card bodies end mid-sentence behind "Read the full story" | Info | By design: expandable story, same as vanilla |
| R14 | Evaluations has no record-level drill | Info | Known since Stage 5 and true in vanilla too; left open |
| R15 | Sidebar footer actions carry visible bordered boxes, heavier than the nav rows | Low | Accepted: they are shell actions, deliberately distinct from navigation rows |

Weakest element, named plainly: R10, the empty middles of the
Upload step cards. It is cosmetic and pre-existing, but it is the
one place a cold reader could still call unfinished. Second: the
strip's above-the-fold cost on the Dashboard (section 1), which is
the required layout's price, recorded rather than hidden.

## 7. Gates, all on the final build

- Test suite: 168 passed (baseline 168; zero contract changes were
  needed - the Casebar's contract pins, including the unsliced run
  id and the "Case brief" aria label, are source-level and the
  component still carries them; the App still mounts the Casebar,
  now in the content column).
- TypeScript strict: clean (the build runs tsc before vite).
- Figure parity: ALL 22 checks passed against the ground-truth
  workspace (Dashboard figures, strip values read from the strip,
  Run figures), plus two new structural checks: the sidebar contains
  no case name, no approvals count and no run id.
- Dark-on-dark audit: 1,849 text nodes, zero under 4.5:1.
- Spot checks: Dashboard exceptions drill lands on "4 of 15 matches
  shown"; hover immobility (box and transform unchanged); skeletons
  render statically in the new shell and settle to the real figures;
  the Draft reminder flow end to end on a fresh session (the outbox
  gains the collection_reminder for INV-1009 with the true status
  recorded_not_sent).
- More menu opacity acceptance in the strip position: deltas
  (1, 1, 4), limit 6 per channel.
- Vanilla byte-identical: frontend/vanilla/index.html md5
  73b0874b216bc87dd96180a5ecb93683, unchanged.
- Flip rule: frontend/index.html copied from
  frontend/react/index.html after the rebuild; md5s equal
  (d7f5f83671b915ce9c4c153a06b499f0).
- No em dashes anywhere in web/src (grep count 0). Hover stays
  transform-free in the core workspace.

## 8. Files changed in this pack

- web/src/index.css: layer order declared; base rules for form
  controls (font and colour inherit), color-scheme dark, and
  border-box sizing; React-theme tone lifts (mut2, blue, blue2, ok,
  warn, bad); glass-input token references fixed with a solid base;
  glass-select given the same treatment.
- web/src/App.tsx: sidebar is brand, nav and footer actions only;
  the Casebar mounts at the top of the content column; nav pill
  animation without the opacity leg.
- web/src/ui/Casebar.tsx: rewritten as the slim content strip (all
  handlers, intents, titles and aria labels carried over); selects
  sized 264px and 288px; the More menu drops below its button,
  right-aligned and viewport-clamped, same opaque surface.
- web/src/views/Mail.tsx: count badge opacity removed.
- web/src/lib/operate.ts: CHART_COLS aligned to the lifted tones.

## 9. Deletions in your clone (unchanged from v1 and v2)

The pack cannot delete files from your clone. Before committing,
delete exactly these, with md5s so you can confirm you are removing
the right files:

- frontend/css/livecube.css (md5 3cc7387d082f4cd5b7fd596d33669b30)
- frontend/js/assist.js (md5 9907daae9ea24b5e44cd37c4019c1e36)
- frontend/js/insight.js (md5 8801a238db8bd9d5949b20c3a3b25300)
- frontend/js/operate.js (md5 a279043694fc401f6dbb856cb09827b9)
- frontend/js/orbs.js (md5 89b3636d6889a7832289f69ac7147176)
- frontend/js/state.js (md5 ef4f82110c30413aac79025c2098eb46)

Do NOT delete frontend/js/vendor/. The React build imports
orbs-engine.js from it (web/src/ui/Orb.tsx) and the Dockerfile
copies it; deleting it breaks the build.

## 10. Deploy

Copy the pack contents over your clone (web/src, frontend/index.html
and this file at the root), delete the six files in section 9 if you
have not already, commit, push, and force a new ECS deployment.
Live verification happens from the ALB after your deploy, as with
every stage. Nothing was deployed from this side.
