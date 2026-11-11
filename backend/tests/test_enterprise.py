import os, sys, uuid, json, tempfile, importlib.util
APP_DIR = os.path.join(os.path.dirname(__file__), "..", "app")
sys.path.insert(0, APP_DIR)
# Hermetic: load a private copy of the API app against a fresh data dir, so
# tenant keys created by other test files can never flip this app out of
# dev-open mode (and this file never poisons theirs).
os.environ["SLATEMATCH_DATA_DIR"] = tempfile.mkdtemp(prefix="ac_ent_")
_spec = importlib.util.spec_from_file_location("api_enterprise", os.path.join(APP_DIR, "api.py"))
_mod = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(_mod)
from fastapi.testclient import TestClient
c = TestClient(_mod.app)

def _seed():
    return c.post("/api/v1/seed").json()

def test_live_event_sequence():
    s = _seed()
    with c.stream("POST", "/api/v1/runs/stream", json={"payments": s["payments"]}) as r:
        assert r.status_code == 200
        types, done = [], None
        for line in r.iter_lines():
            if line.startswith("data: "):
                e = json.loads(line[6:])
                types.append(e["type"])
                if e["type"] == "batch_done": done = e
    assert types[0] == "batch_start" and done is not None
    assert types.count("payment_start") == len(s["payments"])
    assert "resolved" in types and "solved" in types and "decision" in types
    assert done["payments"] == len(s["payments"])

def test_maker_checker_and_approval_flow():
    s = _seed()
    # threshold $100: every exact match above it must wait for an approver.
    # Policy is set through the policy endpoint - an inline policy on
    # /batches is not honoured (previewing one is /policy/preview's job).
    prior = c.get("/api/v1/policy").json()
    c.put("/api/v1/policy", json={"policy": {"maker_checker_threshold_cents": 10000}})
    try:
        b = c.post("/api/v1/batches", json={"idempotency_key": "mc-" + uuid.uuid4().hex[:8],
                                            "payments": s["payments"]}).json()
    finally:
        c.put("/api/v1/policy", json={"policy": prior})
    held = [r for r in b["results"] if r["auto_posted"] is False and r["status"] == "OPTIMAL_EXACT_MATCH"]
    assert held, "expected at least one exact match held by maker-checker"
    assert all("Maker-checker" in (r["decision_reason"] or "") for r in held)
    appr = c.get("/api/v1/approvals").json()
    mine = [a for a in appr if a["run_id"] == b["run_id"]]
    assert mine, "held matches must appear in the approvals queue"
    # The queue is newest-first and its head can be the zero-line
    # refusal (approving that one parks it, by design). This test
    # approves a real held match - one that carries invoices.
    mid = next(a["match_id"] for a in mine if a["invoices"])
    out = c.post(f"/api/v1/matches/{mid}/decision", json={"decision": "approve"}).json()
    assert out["status"] == "APPROVED_POSTED"
    again = c.post(f"/api/v1/matches/{mid}/decision", json={"decision": "approve"})
    assert again.status_code == 409
    audit = c.get("/api/v1/audit").json()
    actions = [a["action"] for a in audit]
    assert "match_approved" in actions and "batch_run_completed" in actions

def test_parse_pipeline_stages():
    _seed()
    out = c.post("/api/v1/parse", json={"text": "Wire from Apex Manufacturing for $200.00 against INV-1001 and INV-9999"}).json()
    stages = [p["stage"] for p in out["pipeline"]]
    assert stages == ["1. Extract", "2. Schema check", "3. Verify references", "4. Trust decision"]
    assert out["ai_mode"] in ("deterministic", "gemini")
    verify_stage = out["pipeline"][2]
    assert "flagged" in verify_stage["detail"]  # INV-9999 does not exist in the ledger
