# Postgres cutover - runbook

SlateMatch serves from SQLite by default. When the environment
variable SLATEMATCH_DATABASE_URL points at a Postgres database,
the same code serves from Postgres instead - one schema per
tenant, translated by the storage seam in backend/app/db.py.
No code change is involved in the cutover; it is an environment
change plus a data copy.

## Verified state (17 Nov 2026)

- The full test suite passes on SQLite (default mode).
- The full test suite passes against a real PostgreSQL 18
  server with SLATEMATCH_DATABASE_URL set (a module-scoped
  fixture in backend/tests/conftest.py truncates application
  tables between test files in PG mode, mirroring the SQLite
  suite's clean-store semantics).
- The migration below was rehearsed end to end: a seeded demo
  workspace (run completed, 10 auto-posted of 16) was copied
  from SQLite files into Postgres and the service then served
  the migrated workspace from Postgres - same staged payments,
  same open invoices, same approvals queue.

## Steps

1. Provision the database (RDS or any Postgres 15+). Note the
   connection URL:
   postgresql://USER:PASSWORD@HOST:5432/DBNAME
2. Add the URL to the task definition as the environment
   variable SLATEMATCH_DATABASE_URL. Do NOT redeploy yet if you
   want zero-downtime rehearsal - the variable only takes
   effect on the next deployment.
3. Copy the data from the EFS data directory:
   SLATEMATCH_DATABASE_URL=<url> \
     python backend/scripts/migrate_to_postgres.py /mnt/slatematch-data
   The script reads the SQLite files read-only, creates one
   schema per tenant file, builds tables from the app's own
   schema, copies every row, and advances the serial sequences.
4. Deploy (Update service, Force new deployment). The service
   now reads and writes Postgres.
5. Verify: /health, the canonical demo run in a fresh session
   (10 auto-posted of 16), the approvals queue, one SAP
   transmit, one portal link.

## Rollback

Unset SLATEMATCH_DATABASE_URL and force a new deployment: the
service returns to the SQLite files on EFS exactly as they were
at migration time. Writes made while on Postgres do not flow
back - treat the cutover as one-way once real traffic lands,
or re-run the migration in reverse after a quiet window.

## Notes

- Scratch repositories (in-memory run previews, temp-file
  replays) stay on SQLite in both modes by design; they are
  throwaway.
- Session workspaces keep working: each session tenant is its
  own schema, reaped by the same 7-day rule at the file layer
  for SQLite; on Postgres, stale session schemas can be dropped
  with DROP SCHEMA "<tenant>--<uuid>" CASCADE.
- psycopg[binary] is pinned in backend/requirements.txt.
