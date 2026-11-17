"""Storage seam: SQLite by default, Postgres when
SLATEMATCH_DATABASE_URL points at one.

The repository layer speaks a small sqlite3-shaped dialect
(? placeholders, INSERT OR IGNORE, AUTOINCREMENT ids, PRAGMA
probes). This module translates that dialect for Postgres and
hands back a connection object with the same surface
(execute / executescript / commit / rollback / close, cursors
with fetchone / fetchall / lastrowid / rowcount), so no caller
changes. Tenancy maps to one Postgres schema per tenant file
(demo.db -> schema "demo", the control store -> "control").

Scratch repositories (in-memory and temp-file previews) always
stay on SQLite, in both modes: they are throwaway by design.
"""
import os
import re

# Tables whose `id` is an AUTOINCREMENT primary key in the SQLite
# schema (BIGSERIAL in Postgres). INSERTs into them get a
# RETURNING id so the cursor can offer sqlite-style lastrowid.
SERIAL_TABLES = {"run_steps", "exceptions", "audit_log", "outbox",
                 "promises", "eval_snapshots", "webhook_deliveries",
                 "feed_events", "portal_responses"}


def database_url():
    return os.environ.get("SLATEMATCH_DATABASE_URL") or None


def pg_enabled():
    u = database_url()
    return bool(u) and u.startswith(("postgres://", "postgresql://"))


def schema_for_path(path):
    base = os.path.basename(path or "tenant")
    if base.endswith(".db"):
        base = base[:-3]
    s = re.sub(r"[^a-z0-9_]", "_", base.lower()) or "tenant"
    if s[0].isdigit():
        s = "t_" + s
    return s


# INSERT OR REPLACE needs the primary key and, for the
# column-list-free forms, the table's column order.
_REPLACE_TABLES = {
    "invoices": ("invoice_id", ["invoice_id", "customer", "subsidiary",
                                "gross_cents", "currency", "po_number",
                                "discount_rate", "age_days", "due_in_days",
                                "predicted_delay_days", "status",
                                "original_gross_cents"]),
    "aliases": ("raw_name", ["raw_name", "customer", "source"]),
    "workspace_meta": ("key", ["key", "value"]),
    "payments": ("payment_id", None),  # the one call site lists columns
    "tenant_policies": ("tenant_id", ["tenant_id", "policy_json"]),
    "tenant_settings": ("key", ["key", "value_json"]),
}


def _translate_or_replace(s):
    m = re.match(r"INSERT OR REPLACE INTO\s+(\w+)\s*(\(([^)]*)\))?\s*VALUES\s*(.*)",
                 s, re.I | re.S)
    if not m:
        return s
    table = m.group(1).lower()
    pk, known_cols = _REPLACE_TABLES.get(table, (None, None))
    if pk is None:
        return s
    cols = [c.strip() for c in m.group(3).split(",")] if m.group(3) else known_cols
    if not cols:
        return s
    updates = ", ".join(f"{c}=EXCLUDED.{c}" for c in cols if c != pk)
    return (f"INSERT INTO {table} ({', '.join(cols)}) VALUES {m.group(4)} "
            f"ON CONFLICT ({pk}) DO UPDATE SET {updates}")


def translate(sql):
    """sqlite3 dialect -> Postgres dialect. Returns None for
    statements that are no-ops on Postgres (PRAGMA tuning)."""
    s = (sql or "").strip()
    if not s:
        return None
    if s.upper().startswith("PRAGMA"):
        return None
    s = s.replace("?", "%s")
    s = s.replace("INTEGER PRIMARY KEY AUTOINCREMENT",
                  "BIGSERIAL PRIMARY KEY")
    if s.upper().startswith("INSERT OR IGNORE INTO"):
        s = "INSERT INTO" + s[len("INSERT OR IGNORE INTO"):] + \
            " ON CONFLICT DO NOTHING"
    if s.upper().startswith("INSERT OR REPLACE INTO"):
        s = _translate_or_replace(s)
    if s.upper().startswith("BEGIN"):
        s = "BEGIN"
    # SQLite's rowid is insertion order; Postgres' ctid is the
    # closest physical analogue. Queries that must not depend on
    # physical position at all (latest match, approvals queue)
    # order by the owning run's created_at first and use the row
    # position only as a tiebreak - those reach here in the
    # qualified form (m.rowid), translated the same way.
    s = s.replace(".rowid", ".ctid")
    s = s.replace("ORDER BY rowid", "ORDER BY ctid")
    return s


class _EmptyCursor:
    lastrowid = None
    rowcount = 0
    description = None

    def fetchone(self):
        return None

    def fetchall(self):
        return []

    def __iter__(self):
        return iter([])


class _PgCursor:
    def __init__(self, cur, lastrowid=None):
        self._cur = cur
        self.lastrowid = lastrowid

    @property
    def rowcount(self):
        return self._cur.rowcount

    @property
    def description(self):
        return self._cur.description

    def fetchone(self):
        return self._cur.fetchone()

    def fetchall(self):
        return self._cur.fetchall()

    def __iter__(self):
        return iter(self._cur.fetchall())


class PgConnection:
    def __init__(self, url, schema):
        import psycopg
        self._conn = psycopg.connect(url, autocommit=False)
        self._schema = schema
        # Transaction bookkeeping for the read-release below:
        # _dirty = uncommitted writes pending; _explicit = an
        # explicit BEGIN from the repository's transaction().
        self._dirty = False
        self._explicit = False
        cur = self._conn.execute(
            f'CREATE SCHEMA IF NOT EXISTS "{schema}"')
        cur.close()
        self._conn.execute(f'SET search_path TO "{schema}"')
        self._conn.commit()

    def execute(self, sql, params=()):
        # On error, roll back before re-raising: Postgres aborts
        # the whole transaction on any statement error, so without
        # this the connection stays unusable ("current transaction
        # is aborted") and can hold locks that stall later work on
        # the shared control connection. SQLite has no such state;
        # this keeps the seam's behaviour identical across modes.
        head = (sql or "").strip().split(None, 1)[0].upper() \
            if (sql or "").strip() else ""
        try:
            out = self._execute_inner(sql, params)
        except Exception:
            try:
                self._conn.rollback()
            except Exception:
                pass
            self._dirty = False
            self._explicit = False
            raise
        # Read-release: a read-only transaction on Postgres holds
        # AccessShare locks until it ends, and this seam's callers
        # read far more often than they commit (SQLite never holds
        # such locks, so the behaviour was invisible there). Left
        # open, a pooled connection sits "idle in transaction"
        # holding locks that can block writers and DDL
        # indefinitely. So: after a successful read, if no writes
        # are pending and no explicit transaction is open, end the
        # transaction at once. Writes are never auto-committed,
        # so multi-statement atomicity is untouched.
        if head == "BEGIN":
            self._explicit = True
        elif head in ("COMMIT", "ROLLBACK"):
            self._explicit = False
            self._dirty = False
        elif head in ("SELECT", "WITH", "PRAGMA"):
            if not self._dirty and not self._explicit:
                try:
                    self._conn.commit()
                except Exception:
                    pass
        elif head in ("INSERT", "UPDATE", "DELETE", "CREATE",
                      "ALTER", "DROP", "TRUNCATE", "REPLACE"):
            self._dirty = True
        return out

    def _execute_inner(self, sql, params=()):
        raw = (sql or "").strip()
        m = re.match(r"PRAGMA table_info\((\w+)\)", raw, re.I)
        if m:
            cur = self._conn.execute(
                "SELECT 0, column_name FROM information_schema.columns "
                "WHERE table_schema = %s AND table_name = %s "
                "ORDER BY ordinal_position",
                (self._schema, m.group(1)))
            return _PgCursor(cur)
        s = translate(raw)
        if s is None:
            return _EmptyCursor()
        lastrowid = None
        im = re.match(r"INSERT INTO\s+(\w+)", s, re.I)
        if im and im.group(1).lower() in SERIAL_TABLES \
                and "RETURNING" not in s.upper():
            s = s + " RETURNING id"
            cur = self._conn.execute(s, tuple(params or ()))
            row = cur.fetchone()
            lastrowid = row[0] if row else None
            return _PgCursor(cur, lastrowid)
        cur = self._conn.execute(s, tuple(params or ()))
        return _PgCursor(cur)

    def executescript(self, script):
        for part in (script or "").split(";"):
            s = translate(part)
            if s:
                cur = self._conn.execute(s)
                cur.close()
                self._dirty = True

    def commit(self):
        self._conn.commit()
        self._dirty = False
        self._explicit = False

    def rollback(self):
        self._conn.rollback()
        self._dirty = False
        self._explicit = False

    def close(self):
        try:
            self._conn.close()
        except Exception:
            pass


def _is_temp_path(path):
    """True when the file lives under the system temp directory.
    Temp-file repositories are scratch by construction (tests and
    previews build them in mkdtemp directories); two different
    temp files that share a basename would otherwise collide in
    one Postgres schema, where separate SQLite files never see
    each other. Scratch stays on SQLite in both modes, exactly
    as the module docstring states."""
    import tempfile
    try:
        real = os.path.realpath(path)
        tmp = os.path.realpath(tempfile.gettempdir())
        return real == tmp or real.startswith(tmp + os.sep)
    except Exception:
        return False


def connect(path, force_sqlite=False):
    """A connection for the repository at `path`: Postgres (one
    schema per tenant file) when a database URL is configured,
    SQLite otherwise. Scratch repositories pass force_sqlite,
    and temp-directory files are scratch by construction."""
    import sqlite3
    if pg_enabled() and not force_sqlite and path != ":memory:" \
            and not _is_temp_path(path):
        return PgConnection(database_url(), schema_for_path(path))
    return sqlite3.connect(path, check_same_thread=False)
