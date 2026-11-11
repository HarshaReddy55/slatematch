"""v54: Save & Retrieve by Session ID. The workspace can be
snapshotted under a short session ID and restored byte for byte by
entering that ID - the state after a restore is the state at the
save, not a re-import or a replay."""
import os, re, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
os.environ.setdefault("SLATEMATCH_DATA_DIR", os.path.join(os.path.dirname(__file__), "api_data"))
from fastapi.testclient import TestClient
import api as api_mod

client = TestClient(api_mod.app, raise_server_exceptions=False)
SID_RE = re.compile(r"^SM-[A-Z2-9]{5}-[A-Z2-9]{5}$")


def _seed_and_run():
    client.post("/api/v1/workspace/reset")
    assert client.post("/api/v1/cases/seed/load").status_code == 200
    r = client.post("/api/v1/workspace/run")
    assert r.status_code == 200, r.text
    return r.json()


def test_save_returns_a_session_id_and_counts():
    _seed_and_run()
    r = client.post("/api/v1/session/save", json={})
    assert r.status_code == 200, r.text
    d = r.json()
    assert SID_RE.match(d["save_id"]), d["save_id"]
    assert d["counts"]["invoices"] == 19, d["counts"]
    assert d["counts"]["matches"] == 15, d["counts"]


def _open_invoice_count():
    inv = client.get("/api/v1/invoices").json()
    inv = inv["invoices"] if isinstance(inv, dict) else inv
    return len(inv)


def test_restore_brings_back_the_exact_saved_state():
    _seed_and_run()
    # /invoices is the open (residual) ledger: the seed run settles the
    # book down to the invoices still open. That exact figure is what
    # must come back - not the 19 rows in the table at save time.
    open_at_save = _open_invoice_count()
    assert open_at_save == 7, open_at_save
    sid = client.post("/api/v1/session/save", json={}).json()["save_id"]
    client.post("/api/v1/workspace/reset")
    assert _open_invoice_count() == 0
    r = client.post("/api/v1/session/restore", json={"save_id": sid})
    assert r.status_code == 200, r.text
    assert r.json()["restored"] is True
    assert _open_invoice_count() == open_at_save
    runs = client.get("/api/v1/runs").json()
    runs = runs["runs"] if isinstance(runs, dict) else runs
    assert len(runs) >= 1
    m = client.get(f"/api/v1/runs/{runs[0]['run_id']}/matches").json()
    rows = m["matches"] if isinstance(m, dict) else m
    assert len(rows) == 15, len(rows)


def test_restore_accepts_the_id_without_dashes_or_prefix():
    sid = client.post("/api/v1/session/save", json={}).json()["save_id"]
    bare = sid.replace("-", "").replace("AC", "", 1).lower()
    r = client.post("/api/v1/session/restore", json={"session_id": bare})
    assert r.status_code == 200, r.text


def test_restore_unknown_id_is_a_clean_404():
    r = client.post("/api/v1/session/restore", json={"save_id": "SM-ZZZZZ-ZZZZZ"})
    assert r.status_code == 404, r.status_code


def test_saves_list_shows_the_save():
    sid = client.post("/api/v1/session/save", json={"label": "reviewer handover"}).json()["save_id"]
    saves = client.get("/api/v1/session/saves").json()["saves"]
    mine = [s for s in saves if s["save_id"] == sid]
    assert mine and mine[0]["label"] == "reviewer handover", saves[:2]
