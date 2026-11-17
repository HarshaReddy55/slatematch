#!/usr/bin/env python3
"""Copy a SlateMatch SQLite data directory into Postgres.

Usage:
    SLATEMATCH_DATABASE_URL=postgresql://user:pass@host:5432/db \
        python migrate_to_postgres.py /path/to/data-dir

For every SQLite file in the data directory (the control store
and one file per tenant), the matching Postgres schema is
created (db.schema_for_path), the tables are built from the
application's own schema through the same dialect translation
the live seam uses, and every row is copied. Serial sequences
are advanced past the copied ids. The SQLite files are only
read - the migration is safe to rehearse.

After it completes, run the service with the same
SLATEMATCH_DATABASE_URL and it serves from Postgres; unset the
variable and it serves from the SQLite files again (rollback
is an env change, until new writes land in Postgres).
"""
import os
import sqlite3
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

import db as dbmod  # noqa: E402
import repository  # noqa: E402


def _tables(sqlite_conn):
    rows = sqlite_conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' "
        "AND name NOT LIKE 'sqlite_%' ORDER BY name").fetchall()
    return [r[0] for r in rows]


def _columns(sqlite_conn, table):
    return [r[1] for r in sqlite_conn.execute(f"PRAGMA table_info({table})")]


def migrate_file(pg, sqlite_path):
    schema = dbmod.schema_for_path(sqlite_path)
    src = sqlite3.connect(f"file:{sqlite_path}?mode=ro", uri=True)
    pg.execute(f'CREATE SCHEMA IF NOT EXISTS "{schema}"')
    pg.execute(f'SET search_path TO "{schema}"')
    # Build the tenant schema from the app's own DDL, translated.
    for stmt in repository.SCHEMA.split(";"):
        s = dbmod.translate(stmt)
        if s:
            pg.execute(s)
    # The two columns the app adds by ALTER at startup (the base
    # SCHEMA predates them; live SQLite files carry them).
    if schema != "_control":
        pg.execute("ALTER TABLE payments ADD COLUMN IF NOT EXISTS references_json TEXT DEFAULT '[]'")
        pg.execute("ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS fingerprint TEXT")
    if schema == "_control":
        # The control store's tables live in tenants.py, not in
        # repository.SCHEMA; create them with the same DDL.
        for stmt in (
            "CREATE TABLE IF NOT EXISTS tenants (tenant_id TEXT PRIMARY KEY, name TEXT, created_at REAL)",
            "CREATE TABLE IF NOT EXISTS api_keys (key_hash TEXT PRIMARY KEY, tenant_id TEXT, role TEXT, label TEXT, created_at REAL, revoked INTEGER DEFAULT 0)",
            "CREATE TABLE IF NOT EXISTS tenant_policies (tenant_id TEXT PRIMARY KEY, policy_json TEXT)",
            "CREATE TABLE IF NOT EXISTS portal_tokens (token_hash TEXT PRIMARY KEY, link_id TEXT, tenant_id TEXT, customer TEXT, created_at REAL, revoked INTEGER DEFAULT 0)",
        ):
            pg.execute(dbmod.translate(stmt))
    total = 0
    for table in _tables(src):
        cols = _columns(src, table)
        if not cols:
            continue
        rows = src.execute(f"SELECT {', '.join(cols)} FROM {table}").fetchall()
        if not rows:
            continue
        placeholders = ", ".join(["%s"] * len(cols))
        for row in rows:
            pg.execute(
                f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({placeholders}) "
                f"ON CONFLICT DO NOTHING", tuple(row))
        total += len(rows)
        if table in dbmod.SERIAL_TABLES:
            pg.execute(
                f"SELECT setval(pg_get_serial_sequence('{table}', 'id'), "
                f"COALESCE((SELECT MAX(id) FROM {table}), 1))")
    pg.commit()
    src.close()
    return schema, total


def main():
    url = dbmod.database_url()
    if not url:
        print("SLATEMATCH_DATABASE_URL is not set", file=sys.stderr)
        return 2
    data_dir = sys.argv[1] if len(sys.argv) > 1 else "."
    import psycopg
    pg = psycopg.connect(url, autocommit=False)
    files = sorted(f for f in os.listdir(data_dir) if f.endswith(".db"))
    if not files:
        print(f"no .db files in {data_dir}", file=sys.stderr)
        return 2
    for f in files:
        schema, n = migrate_file(pg, os.path.join(data_dir, f))
        print(f"{f} -> schema {schema}: {n} rows")
    print("migration complete")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
