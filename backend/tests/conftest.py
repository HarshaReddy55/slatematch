"""Suite-wide environment.

The product rate limiter allows 300 requests per minute per API key
(SLATEMATCH_RATE_LIMIT_PER_MIN, read per request). Every unauthenticated
test request shares the single "anon" bucket, and the suite issues
well over 300 requests: on a slow machine they spread across several
one-minute windows and pass, while on a fast CI runner they land
inside one window and the tail of the suite fails with 429s. That is
exactly how the v41 CI run failed on code that passed locally.

The suite therefore runs with a high ceiling. The limiter itself is
still exercised by test_ops.test_rate_limit, which sets its own limit
of 3 per minute via monkeypatch.
"""
import os

os.environ["SLATEMATCH_RATE_LIMIT_PER_MIN"] = "100000"

import pytest


@pytest.fixture(scope="module", autouse=True)
def _pg_clean_store_between_modules():
    """Postgres-mode suite isolation. On SQLite the suite's
    shared data directory is deleted by test_api at import,
    which incidentally gives later files a clean store.
    Postgres schemas persist, so in PG mode every application
    table is truncated between test modules - the same
    clean-store semantics, without dropping schemas under live
    connections. On SQLite this does nothing."""
    url = os.environ.get("SLATEMATCH_DATABASE_URL") or ""
    if url.startswith(("postgres://", "postgresql://")):
        try:
            import psycopg
            with psycopg.connect(url, autocommit=True) as conn:
                schemas = [r[0] for r in conn.execute(
                    "SELECT schema_name FROM information_schema.schemata "
                    "WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'public')")]
                for schema in schemas:
                    tables = [r[0] for r in conn.execute(
                        "SELECT table_name FROM information_schema.tables "
                        "WHERE table_schema = %s", (schema,))]
                    for t in tables:
                        conn.execute(f'TRUNCATE TABLE "{schema}"."{t}" CASCADE')
        except Exception:
            pass
    yield
