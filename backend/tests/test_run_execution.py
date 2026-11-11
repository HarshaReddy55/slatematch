"""v17: the run paths must never dead-end on an already-run case, and
the workspace payload must carry every staged payment (the frontend
replay uses it). The stream endpoint falls back to all payments when
none are pending - the exact flow behind 'Run the active case live'."""
import os, sys, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
os.environ.setdefault("SLATEMATCH_DATA_DIR", os.path.join(os.path.dirname(__file__), "api_data"))
from fastapi.testclient import TestClient
import api as api_mod

client = TestClient(api_mod.app, raise_server_exceptions=False)


def test_workspace_carries_all_payments_after_a_run():
    client.post("/api/v1/workspace/reset")
    client.post("/api/v1/cases/seed/load")
    client.post("/api/v1/workspace/run")  # v31: execution is explicit
    ws = client.get("/api/v1/workspace").json()
    # v21: the load itself runs the case, so nothing is pending - and
    # the full staged set survives as the replay set.
    assert ws["pending_payments"] == []
    assert ws["latest_run"] is not None
    assert len(ws["all_payments"]) == 16  # the replay set survives the run


def test_stream_replays_an_already_run_case():
    events = []
    with client.stream("POST", "/api/v1/runs/stream",
                       json={"use_workspace": True}) as resp:
        assert resp.status_code == 200
        for line in resp.iter_lines():
            if line and line.startswith("data: "):
                e = json.loads(line[6:])
                events.append(e)
                if e.get("type") == "batch_done":
                    break
    start = next(e for e in events if e["type"] == "batch_start")
    assert start["payments"] == 16, events[:3]
    done = next(e for e in events if e["type"] == "batch_done")
    assert done["payments"] == 16
    assert done["auto_posted"] == 10
