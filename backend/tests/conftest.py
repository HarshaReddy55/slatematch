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
