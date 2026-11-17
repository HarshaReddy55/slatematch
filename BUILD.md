# Portal pack v1 - the payer portal

Applies on top of the proof pack or the integrations pack
(the backend and Health files are whole-file supersets of
both). Suite: 248 passed on a clean solo run (242 + 6 new).
Demo outcome unchanged. Logo untouched. Vanilla untouched.

## What is inside

The payer portal: a per-customer, token-scoped window into
the workspace, in plain payer language.

Operator side (Agent Health, Integrations panel):
POST /api/v1/portal-links mints a link for one customer
(name exactly as on their invoices). The raw token is shown
ONCE in the console at creation; only its SHA-256 hash is
stored (control store, same pattern as API keys). Links are
listed by id and customer, and revocation is immediate.

Payer side: the link opens /portal/<token>, a standalone
page (frontend/portal.html, no console shell) that shows
exactly that customer's slice:
- Open invoices with amounts due and part-paid notes, each
  with a promise-to-pay date control. A promise lands in the
  same promises ledger the collections view derives KEPT /
  BROKEN status from.
- Their payments with plain-language statuses (Posted /
  With our team for approval / Received - awaiting
  reconciliation / Held - looks like a duplicate).
- Their disputes, with a response form (accept / send
  evidence / ask a question). A response is recorded as
  evidence and shown back to the payer; it never changes
  the claim's status - the decision stays with the operator,
  and the page says so.
- A remittance advice box: parsed with the Upload Center's
  pipeline plus verbatim open-invoice matching, staged as a
  PORTAL- payment that reconciles on the next run.

Scoping is structural, not cosmetic: every portal query
filters to the token's tenant and customer; another
customer's invoice or dispute answers 404 (never a
permission error that confirms it exists). Bad or revoked
tokens answer 401 and the page shows a plain "link not
active" message. Portal activity (remittance, promises,
dispute responses) is recorded as feed events on Agent
Health, so the operator sees it without opening the portal.

## Files

Backend: api.py, repository.py (portal_responses table +
an exceptions_for_payment helper), tenants.py (portal
token store). Tests: test_portal_pack.py (new).
Frontend: frontend/portal.html (new), views/Health.tsx,
frontend/react/ rebuilt (bundle index-DGPU5MJO.js),
frontend/index.html re-copied.

## Deploy

Copy in at the same paths, commit, push, Update service
slatematch-app with Force new deployment. Standing reminder,
if still pending in your clone: delete the six dead files
(frontend/css/livecube.css and the five loose
frontend/js/*.js) - never frontend/js/vendor/.
