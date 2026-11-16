# SlateMatch - cumulative fix pack v7 (16 Nov 2026)

THE ONLY PACK TO DEPLOY. Your last deploy was the consolidated
pack v2; packs v3, v4 and v5 were never deployed. This pack
contains every change since v2 in one set of files and
supersedes all of them (v6 included).

Copy the files into your clone at the same paths, commit,
push, then Update service slatematch-app with Force new
deployment.

Suggested commit message:
Post-v2 fixes: audit layout, seamless transitions, remittance
vanilla organization, logo brand band

## What is in it

Run view
- Audit detail panel at full width below Matches/Exceptions
  (it was squeezed into the two-column grid); reasons wrap in
  full, matched invoices stack one per line, and the counts
  line ("16 payments: 10 posted, 5 held for approval, 1 not
  posted") shows in the panel, not only in the copied text.
- A repeat streamed run is a replay on a scratch copy; the
  banner now says so plainly instead of "undefined ms", and
  the stored run not advancing on a replay is stated, by
  design.
- At run completion the agent strip stays until the stored
  run lands - no blank flash.

Everywhere
- Sections open at the top (the window kept the previous
  section's scroll offset).
- Case switches, restores and reseeds clear the old figures
  instantly instead of flashing the previous case's numbers
  (Dashboard, Run, Ledger, Forecast, Mail, SAP, Upload,
  Health).

Upload Center - remittance, vanilla's organization
- The wire card leads the panel: INBOUND WIRE AMOUNT, the
  meta line, the claimed-deduction card inside it.
- Then the mail and vanilla's tip line, the AI extraction
  layer strip (vanilla's wording, from /health), and the
  actions row.
- Then the output: the pipeline as a compact 4-step strip
  with per-step issues, and the Structured result block
  (verifier line, auto-seed, raw response collapsed).
- The two file streams stay side by side with the remittance
  panel below them, per the 17:44 revision.

Logo
- Untouched. Exactly as deployed in consolidated v2,
  per the owner's instruction: leave the logo as it is.

Backend: unchanged. Suite 194 passed.

## Still yours to do

Delete the six dead files in your clone (they still serve):
frontend/css/livecube.css and the five loose frontend/js/*.js
files. NEVER delete frontend/js/vendor/.
