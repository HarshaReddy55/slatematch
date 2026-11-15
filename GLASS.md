# SlateMatch glass system - the recipe and the legibility evidence

Companion to MOTION.md. The motion pack (15 Nov 2026) kept glass on
the sticky tab bar only. Harsha then chose "Push the glass design
further", widening glass to every surface in the React build. This
document is the recipe that shipped in
slatematch-stage2-fixes-glass-v1.zip, per surface, with the
legibility evidence the widening was gated on. Vanilla is untouched:
every rule below lives in the React-only stylesheet
(web/src/index.css) or in React components.

## The ground (what the glass sits on)

React shell only, via a React-scoped token; the vanilla --bg is not
touched.

- Ground colour: #1e1e1f (token --color-ground), one step deeper
  than the product's #232323, so translucent surfaces read against
  a darker field.
- A static light source: radial-gradient(1100px 520px at 50% -160px,
  rgba(61,117,232,0.13), rgba(61,117,232,0.05) 42%,
  rgba(61,117,232,0) 70%) - the product blue at 13 percent, centred
  above the viewport, falling to nothing by 70 percent of its
  radius. STATIC by rule: no breathing, pulsing, drifting or any
  animation of the glow, ever. background-attachment: fixed, so
  the light stays at the top of the viewport while content scrolls.
- The vanilla vertical hairline texture stays, layered under the
  glow: repeating-linear-gradient(90deg, rgba(255,255,255,0.025)
  0 1px, transparent 1px 9px).

## Panels (.glass-panel - Panel, and every table inside one)

- Background: linear-gradient(180deg, rgba(45,45,46,0.88),
  rgba(39,39,39,0.91)). The gradient stops are the flat build's own
  panel colours (#2d2d2e to #272727) at 0.88 to 0.91 alpha.
- Backdrop: blur(12px) saturate(1.12) - the hairline texture and
  the glow soften visibly beneath the surface.
- Top-edge light line: inset box-shadow 0 1px 0
  rgba(255,255,255,0.08).
- Depth shadow: 0 12px 32px rgba(0,0,0,0.36).
- Border: rgba(255,255,255,0.11), one step brighter than the flat
  build's white/8.
- Hover (pointer surfaces): translateY(-2px), shadow deepens to
  0 18px 44px rgba(0,0,0,0.46), 0.22s on the motion system's
  EASE_OUT curve.

## Cards (.glass-card - StatCard, Health MiniCard, Eval accuracy)

- Background: linear-gradient(180deg, rgba(46,46,47,0.87),
  rgba(37,37,38,0.90)). Again the flat build's own card colours
  (#2e2e2f to #252526) at 0.87 to 0.90 alpha.
- Backdrop: blur(10px) saturate(1.12).
- Top-edge light line: inset 0 1px 0 rgba(255,255,255,0.07).
- Depth shadow: 0 10px 28px rgba(0,0,0,0.34); hover -2px and
  0 16px 38px rgba(0,0,0,0.44), same transition as panels.
- The LoadError surface uses .glass-card too, so an error state
  sits on the same glass as the content it replaces.

## Tab bar (sticky navigation)

Deepened to the same family: background rgba(28,28,29,0.72),
backdrop blur(16px) saturate(1.2), inset top light line
0 1px 0 rgba(255,255,255,0.06), border rgba(255,255,255,0.10).
Content scrolling beneath it blurs through; the bar's own labels
stay crisp (verified in glass-scroll.png).

## Interaction depth (.pressable and table rows)

- .pressable: transform transition 0.15s EASE_OUT; :active scale
  0.97. Applied where a press should feel physical: the Agent
  Health status-bar buttons (which also get hover:brightness-110).
- Panels and cards lift on hover as above. Table rows keep their
  existing hover and gain only a whisper: transition-colors with
  hover white at 2 percent. No glow effects on hover, anywhere.

## The legibility gate (how the alphas were chosen)

First recipe (lighter stops, 0.83 to 0.89 alpha) was measured and
found wanting, then rebuilt before packing:

- Method: a probe page rendering the real built CSS, with the same
  12px muted note (#a7a49d, the smallest standard text) inside a
  glass panel over the glow (worst case position) and inside the
  old flat panel; pixel-measured contrast from the screenshot.
- First recipe: glass 5.29:1 vs flat 5.53:1. A real softening, so
  the alphas went up and the gradient stops became the flat
  build's own colours.
- Final recipe: glass 5.76:1 vs flat 5.53:1. The settled composite
  (measured background (42,42,44)) is a touch darker than the flat
  panel (45,45,46), so small text on glass now reads at least as
  clean as the flat build, in the worst position on the page.
- Texture softening: scanline luminance spread (stdev) on bare
  ground 2.52 (hairlines visible); inside a glass panel 0.43 to
  0.50, identical to the flat panel's 0.50. The blur erases the
  texture as a pattern under content while the ground between
  panels keeps it.
- Panel interior luminance: glass mean 39.5 to 40.8 vs flat 42.8 -
  within about 3 grey levels everywhere.
- Full-size screenshots of all five views were inspected on the
  final build (glass-dash, glass-ledger, glass-forecast-drill,
  glass-health, glass-eval): panel notes, table secondary text and
  mono sub-lines all read flat-build clean. No figure, word or
  layout order changed anywhere (parity protocol in NOTES.md).

## Reduced motion

Under prefers-reduced-motion, the CSS kills the hover lift, the
press response and all glass transitions; the glow is static in
every mode, so there is nothing ambient to disable.

## Boundaries kept

- Animated ambience still refused: no breathing beam, no drifting
  specks, no looping motion of any kind. The glow never moves.
- The Upload drop-zone lighting from the template remains Stage 3;
  no React Upload view exists yet.
- Glass lives in the design kit and the shared classes; views do
  not hand-scatter glass styles.
