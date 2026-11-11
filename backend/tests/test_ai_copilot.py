import sys, os, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'app'))
from ai import deterministic_parse, parse_remittance, GeminiClient
from domain import Invoice, Payment, Policy
from repository import Repository
from batch import run_batch
from copilot import answer

TEXT = """Hi team, remittance from Apex Manufacturing Inc. Wire of $200.00 against INV-1023 and INV 1024.
Less deduction $50.00 for shortage on delivery. PO-77 referenced. Thanks"""

def test_deterministic_parse():
    f = deterministic_parse(TEXT)
    assert f["amount_cents"] == 20000, f
    assert "INV-1023" in f["invoice_refs"] and "INV-1024" in f["invoice_refs"]
    assert f["deduction_cents"] == 5000 and f["deduction_reason"] == "shortage"

def test_gemini_path_and_verifier_flags_unknown_ref():
    fake = lambda payload: {"candidates": [{"content": {"parts": [{"text":
        '{"payer":"Apex Manufacturing Corp","amount_cents":20000,"invoice_refs":["INV-1023","INV-9999"],"po_refs":["PO-77"],"deduction_cents":5000,"deduction_reason":"shortage"}'}]}}]}
    out = parse_remittance(TEXT, known_invoice_ids={"INV-1023", "INV-1024"}, known_po_numbers={"PO-77"},
                           client=GeminiClient(api_key="test", transport=fake))
    assert out["source"] == "gemini"
    assert out["verification"]["verified"] is False
    assert any("INV-9999" in i for i in out["verification"]["issues"])

def test_gemini_garbage_falls_back():
    fake = lambda payload: {"candidates": [{"content": {"parts": [{"text": "not json"}]}}]}
    out = parse_remittance(TEXT, client=GeminiClient(api_key="test", transport=fake))
    assert out["source"] == "deterministic_fallback" and out["degraded"] is True
    assert out["fields"]["amount_cents"] == 20000

def test_copilot_grounded_and_refuses():
    repo = Repository(os.path.join(tempfile.mkdtemp(), "c.db"))
    repo.add_invoice(Invoice("INV-1", "Apex Manufacturing", "Apex Manufacturing", 12000, age_days=40))
    repo.add_invoice(Invoice("INV-2", "Apex Manufacturing", "Apex Manufacturing", 8000, age_days=5))
    run_batch(repo, [Payment("P1", "Apex Manufacturing", 20000), Payment("P9", "TransGlobal Trading", 77700)], Policy(), idempotency_key="ck1")
    a = answer(repo, "Why was P9 not matched?")
    assert "P9" in a["answer"] and a["citations"]
    a2 = answer(repo, "What is the CEO's home address?")
    assert "does not contain" in a2["answer"]
    a3 = answer(repo, "What is the touchless automation rate?")
    assert "Touchless rate" in a3["answer"]

def test_gemini_key_normalised_and_error_recorded():
    import ai as ai_mod
    c = GeminiClient(api_key="  test-key-123\n")
    assert c.api_key == "test-key-123"
    def boom(payload):
        raise RuntimeError("connection refused by upstream")
    bad = GeminiClient(api_key="k", transport=boom)
    try:
        bad.generate_text("hello")
        raise AssertionError("expected failure")
    except RuntimeError:
        pass
    assert ai_mod.LAST_GEMINI_ERROR["error"] and "RuntimeError" in ai_mod.LAST_GEMINI_ERROR["error"]
    # and the deterministic fallback still answers when Gemini fails
    out = parse_remittance(TEXT, client=bad)
    assert out["source"] == "deterministic_fallback" and out["degraded"] is True


def test_copilot_approvals_reflect_decisions():
    # Regression (2 Nov 2026 strict audit): after a match was approved, the
    # copilot still listed it as waiting - it filtered the run snapshot
    # (status != AUTO_POSTED) instead of reading the live queue. The
    # approvals answer must mirror repo.list_proposed() at all times.
    repo = Repository(os.path.join(tempfile.mkdtemp(), "c.db"))
    repo.add_invoice(Invoice("INV-9", "NorthPeak Industrial", "NorthPeak Industrial", 9640000, age_days=12))
    pol = Policy(maker_checker_threshold_cents=5_000_000)
    run_batch(repo, [Payment("P7", "NorthPeak Industrial", 9640000, references=["INV-9"])], pol, idempotency_key="cq1")
    a = answer(repo, "Which payments are waiting for my approval?")
    assert a["answer"].startswith("1 match"), a["answer"]
    assert "P7" in a["answer"]
    q = repo.list_proposed()
    assert len(q) == 1
    repo.update_match(q[0]["match_id"], "APPROVED_POSTED", repo.get_match(q[0]["match_id"])["result"])
    a2 = answer(repo, "Which payments are waiting for my approval?")
    assert "Nothing is waiting" in a2["answer"], a2["answer"]


def test_money_format_sign():
    # Negative amounts render -$16,750.00, never $-16,750.00, in every
    # backend formatter and in the held-match decision reason end to end.
    from batch import _usd as b_usd
    from briefing import _money as br_money
    from mail import _money as m_money
    from copilot import _usd as c_usd
    for f in (b_usd, br_money, m_money, c_usd):
        assert f(-1675000) == "-$16,750.00", (f.__module__, f(-1675000))
        assert f(52000) == "$520.00" and f(0) == "$0.00"
    repo = Repository(os.path.join(tempfile.mkdtemp(), "c.db"))
    repo.add_invoice(Invoice("INV-5", "BluePeak Electronics", "BluePeak Electronics", 3675000, age_days=20))
    run_batch(repo, [Payment("P4", "BluePeak Electronics", 2000000, references=["INV-5"])], Policy(), idempotency_key="mq1")
    q = repo.list_proposed()
    assert len(q) == 1
    reason = q[0]["decision_reason"] or ""
    assert "-$16,750.00" in reason and "$-" not in reason, reason
