"""Interconnection optimizations (16 Nov 2026, consolidated pack):
evaluations served from a process cache (the result is a pure
function of the code), and the PDF export rendered once per
identical bundle (rendering is the slowest call in the product)."""
import os
import sys

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, "..", "app"))
os.environ.setdefault("SLATEMATCH_DATA_DIR", os.path.join(HERE, "opt_data"))

from fastapi.testclient import TestClient


def test_evaluations_computed_once_then_cached():
    import api
    api._evaluations_cache.clear()
    first = api.evaluations()
    assert "payload" in api._evaluations_cache
    second = api.evaluations()
    assert second is first  # same object: no recompute
    assert first["milp_accuracy"] >= first["greedy_accuracy"]


def test_pdf_export_cached_per_identical_bundle():
    import api
    api._pdf_cache.clear()
    client = TestClient(api.app, raise_server_exceptions=False)
    h = {"X-Workspace-Session": "33333333-4444-4555-8666-777777777777"}
    client.post("/api/v1/cases/seed/load", headers=h)
    client.post("/api/v1/workspace/run", headers=h)
    r1 = client.get("/api/v1/export/bundle.pdf", headers=h)
    assert r1.status_code == 200 and r1.content[:5] == b"%PDF-"
    assert len(api._pdf_cache) == 1
    r2 = client.get("/api/v1/export/bundle.pdf", headers=h)
    assert r2.content == r1.content
    assert len(api._pdf_cache) == 1  # second download served from cache
    # a new run changes the bundle, so the next export re-renders
    client.post("/api/v1/cases/seed/load", headers=h)
    client.post("/api/v1/workspace/run", headers=h)
    r3 = client.get("/api/v1/export/bundle.pdf", headers=h)
    assert r3.status_code == 200 and r3.content[:5] == b"%PDF-"
