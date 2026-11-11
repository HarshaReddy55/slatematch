"""v20: AI source labels must say WHY the backup answered, and the
copilot must answer the most obvious money question. Live evidence
(1 Nov 2026): the dispute desk labelled its template draft 'Gemini not
configured' while a key WAS configured and the call had timed out -
three different states blurred into one wrong label. And the copilot
refused 'What is the auto-posted cash for this case?' although the
figure sits in the run records it reads."""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
os.environ.setdefault("SLATEMATCH_DATA_DIR", os.path.join(os.path.dirname(__file__), "api_data"))
import httpx
import ai as ai_mod
import api as api_mod
from fastapi.testclient import TestClient

client = TestClient(api_mod.app, raise_server_exceptions=False)


def _hanging_client():
    def hang(payload):
        raise httpx.ReadTimeout("The read operation timed out",
                                request=httpx.Request("POST", "https://x"))
    return ai_mod.GeminiClient(api_key="test-key", transport=hang)


def test_draft_ai_state_distinguishes_failure_from_no_key(monkeypatch):
    monkeypatch.setattr(api_mod, "GeminiClient", lambda *a, **k: _hanging_client())
    r = client.post("/api/v1/ai/draft", json={
        "kind": "dispute_email", "tone": "firm",
        "facts": {"payer": "Northgate Foods", "payment_id": "P3",
                  "claimed_cents": 215000, "reason_code": "RC-02"}})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["source"] == "template" and d["ai_state"] == "call_failed"
    monkeypatch.setattr(api_mod, "GeminiClient",
                        lambda *a, **k: ai_mod.GeminiClient(api_key=""))
    r = client.post("/api/v1/ai/draft", json={
        "kind": "dispute_email", "tone": "firm",
        "facts": {"payer": "Northgate Foods", "payment_id": "P3",
                  "claimed_cents": 215000, "reason_code": "RC-02"}})
    assert r.json()["ai_state"] == "no_key"


def test_brief_ai_state_under_hanging_gemini(monkeypatch):
    client.post("/api/v1/workspace/reset")
    client.post("/api/v1/cases/seed/load")  # v31: load stages it
    b = client.post("/api/v1/workspace/run").json()["run"]
    monkeypatch.setattr(api_mod, "GeminiClient", lambda *a, **k: _hanging_client())
    r = client.get(f"/api/v1/runs/{b['run_id']}/brief")
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["source"] == "deterministic" and d["ai_state"] == "call_failed"


def test_copilot_answers_auto_posted_cash():
    client.post("/api/v1/workspace/reset")
    client.post("/api/v1/cases/seed/load")
    client.post("/api/v1/workspace/run")  # v31: execution is explicit
    r = client.post("/api/v1/copilot", json={
        "question": "What is the auto-posted cash for this case?"})
    assert r.status_code == 200, r.text
    d = r.json()
    assert "$411,800.00" in d["answer"], d["answer"]
    assert d["citations"]


def test_gemini_client_waits_long_enough_and_caps_output():
    """v34: the live blocker was never only quota - the client gave up at
    20s while the model was still answering (a timed live probe died at
    21.2s). The client must wait at least 45s by default, and the JSON
    generation must cap its output so a reasoning model cannot think
    forever before answering a small parse request."""
    import ai
    # long enough for a healthy model, short enough that the route can
    # still return its graceful fallback before the platform ingress
    # kills the request at ~60s (a 60s client wait earned a live 504)
    assert 30 <= ai.GEMINI_TIMEOUT_S <= 45
    seen = {}

    def fake_transport(payload):
        seen.update(payload)
        return {"candidates": [{"content": {"parts": [{"text": '{"ok": true}'}]}}]}

    client = ai.GeminiClient(api_key="test-key", transport=fake_transport)
    assert client.generate_json("parse this") == {"ok": True}
    assert seen["generationConfig"]["maxOutputTokens"] == 1024
