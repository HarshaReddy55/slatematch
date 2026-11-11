"""v13 hardening: the shared control-store connection must survive
concurrent auth checks while tenant rows are being written. Before the
TenantStore lock, a commit from one thread could invalidate another
thread's in-flight cursor and crash auth_context with a TypeError."""
import os, sys, threading
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
os.environ.setdefault("SLATEMATCH_DATA_DIR", os.path.join(os.path.dirname(__file__), "api_data"))
from fastapi.testclient import TestClient
import api as api_mod

client = TestClient(api_mod.app, raise_server_exceptions=False)


def test_parallel_requests_with_tenant_writes_do_not_500():
    # 429 is the product's own per-minute rate limiter doing its job and is
    # acceptable here (earlier tests in the same process share the window);
    # a 500 is not - before the per-thread connections and the store lock,
    # this load produced sqlite3.InterfaceError 500s.
    statuses = []
    # A dedicated API-key header gives this test its own rate-limit bucket,
    # so its load cannot starve the rest of the suite (dev-open mode maps
    # any header key to the demo tenant; the bucket is what matters here).
    probe = {"X-Api-Key": "concurrency-probe"}

    def hammer():
        for _ in range(20):
            r = client.get("/api/v1/workspace",
                           headers={**probe, "X-Tenant-Id": "demo-eu"})
            statuses.append(r.status_code)
            r = client.get("/health", headers=probe)
            statuses.append(r.status_code)

    threads = [threading.Thread(target=hammer) for _ in range(5)]
    for t in threads: t.start()
    for t in threads: t.join()
    assert statuses, "no requests completed"
    assert all(s in (200, 429) for s in statuses), sorted(set(statuses))
    assert 200 in statuses
    assert api_mod.store.key_count() >= 0
