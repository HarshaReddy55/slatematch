# Integrations pack v1 - SAP write-back, webhooks, remittance feed

Applies on top of the proof pack (live). Suite: 242 passed on
a clean solo run (234 + 8 new). Demo outcome unchanged.
Logo untouched (logo-glass-ygqXbPkV). Vanilla untouched.

## What is inside

1. SAP write-back, built to the connection point (SAP view
   gains a Write-back panel). POST /api/v1/erp/transmit sends
   one cleared payment's BAPI document:
   - Simulated mode (default): a built-in simulator validates
     the payload the way a receiving system would - header
     present, posting lines present, CURRENCYAMOUNT netting
     to zero - and assigns a SAPSIM document number. Every
     record and the UI say SIMULATED in plain words; no real
     SAP system is claimed anywhere.
   - HTTP mode: PUT /api/v1/integrations/settings with an
     endpoint URL posts the real payload there and records
     the real response, including failures ("endpoint
     unreachable" is a recorded outcome, not a hidden one).
   Transmissions are recorded per workspace (payment, document,
   mode, status, SAP number) and clear with the workspace.
   Only cleared payments can transmit; a held payment is 409.
2. Webhooks (Agent Health gains an Integrations panel).
   Per-tenant subscriptions (POST/GET/DELETE /api/v1/webhooks)
   fire on run.completed, approval.decided,
   dispute.transitioned and match.reversed. Delivery is
   asynchronous and best-effort by design - a webhook can
   never block or fail the operation that fired it - and every
   attempt is logged with its HTTP status or error.
   Registration refuses private, loopback and link-local URLs.
3. Remittance mailbox feed. POST /api/v1/feeds/remittance, in
   the shape an inbound-email service (SES, Postmark, a
   mailroom scanner) would POST: the advice is parsed with the
   Upload Center's pipeline, the workspace's open invoice ids
   are additionally matched verbatim (a house id format the
   parser's regex does not know still links), the payment is
   staged into the workspace, and a feed event is recorded
   (GET /api/v1/feeds/events, shown on Agent Health). Staging
   is not matching: the wire reconciles when a run includes
   it - the tests prove a mailed advice auto-posts on the
   next run.

## Files

Backend: api.py, repository.py (four new tables:
transmissions, webhooks, webhook_deliveries, feed_events,
plus tenant_settings for connection config - all
CREATE IF NOT EXISTS, safe on existing databases).
Tests: test_integrations_pack.py (new).
Frontend source: views/Sap.tsx, views/Health.tsx.
Built frontend: frontend/react/ (bundle index-LQNBkEcN.js)
+ frontend/index.html re-copied.

## Deploy

Copy in at the same paths, commit, push, Update service
slatematch-app with Force new deployment. Standing reminder,
if still pending in your clone: delete the six dead files
(frontend/css/livecube.css and the five loose
frontend/js/*.js) - never frontend/js/vendor/.
