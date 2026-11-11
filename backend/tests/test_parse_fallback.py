"""v19: the AI fallback must never become an error. Live evidence
(1 Nov 2026): with gemini-3.8-flash accepted but slow from the ECS
container, /api/v1/parse returned 500 - the Gemini call timed out and
the deterministic fallback then crashed on the probe text itself (the
Rs currency regex matched the 'rs,' inside 'dollars,' and _cents got a
bare comma). These tests lock both behaviours: a hanging Gemini
degrades to a labelled 200, and the parser survives hostile text."""
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


def test_parser_survives_dollars_comma_text():
    out = ai_mod.deterministic_parse(
        "Payment from Northgate Foods, 96,400 dollars, invoice INV-1007")
    assert out["payer"].startswith("Northgate")
    assert out["invoice_refs"] == ["INV-1007"]
    out2 = ai_mod.deterministic_parse(
        "Wire from Acme Corp Ltd, amount USD 52,000.00, invoices INV-1001 and INV-1002")
    assert out2["amount_cents"] == 5_200_000
    assert ai_mod._cents(",") == 0 and ai_mod._cents("") == 0


def test_parse_endpoint_degrades_under_hanging_gemini(monkeypatch):
    monkeypatch.setattr(api_mod, "GeminiClient", lambda *a, **k: _hanging_client())
    r = client.post("/api/v1/parse", json={
        "text": "Payment from Northgate Foods, 96,400 dollars, invoice INV-1007"})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["source"] == "deterministic_fallback" and d["degraded"] is True
    assert d["ai_mode"] == "deterministic"
    assert ai_mod.LAST_GEMINI_ERROR["error"] and "ReadTimeout" in ai_mod.LAST_GEMINI_ERROR["error"]


def test_draft_endpoint_degrades_under_hanging_gemini(monkeypatch):
    monkeypatch.setattr(api_mod, "GeminiClient", lambda *a, **k: _hanging_client())
    r = client.post("/api/v1/ai/draft", json={
        "kind": "dispute_email", "tone": "firm",
        "facts": {"payer": "Northgate Foods", "payment_id": "P3",
                  "deduction_cents": 215000, "reason_code": "RC-02"}})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["source"] != "gemini"  # the grounded template answered, labelled
    assert d["text"]
