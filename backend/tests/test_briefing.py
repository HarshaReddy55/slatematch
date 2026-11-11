import os, sys
APP_DIR = os.path.join(os.path.dirname(__file__), "..", "app")
sys.path.insert(0, APP_DIR)
from briefing import run_brief, draft_message  # noqa: E402
from repository import Repository  # noqa: E402
from scenarios import get_scenario  # noqa: E402
from batch import run_batch  # noqa: E402
from domain import Policy  # noqa: E402
import tempfile  # noqa: E402


def _repo_with_dispute_run():
    repo = Repository(os.path.join(tempfile.mkdtemp(), "t.db"))
    sc = get_scenario("discount-deduction-dispute")
    invs, pays = sc["build"]()
    for inv in invs:
        repo.add_invoice(inv)
    out = run_batch(repo, pays, Policy(maker_checker_threshold_cents=10**12), "test")
    return repo, out["run_id"]


def test_run_brief_deterministic_is_grounded():
    repo, run_id = _repo_with_dispute_run()
    b = run_brief(repo, run_id)
    assert b["source"] == "deterministic"
    assert b["facts"]["disputes"], "the dispute case must open a dispute"
    assert "dispute" in b["headline"] or b["facts"]["auto_posted"] >= 1
    assert any("dispute" in a.lower() for a in b["next_actions"])


class _FakeClient:
    available = True

    def generate_text(self, prompt):
        return "12 of 12 payments posted themselves in this run."


def test_run_brief_gemini_path_is_grounding_checked():
    repo, run_id = _repo_with_dispute_run()
    b = run_brief(repo, run_id, client=_FakeClient())
    # fake text carries wrong numbers for this run, so grounding rejects it
    assert b["source"] in ("deterministic", "gemini")
    assert b["facts"]["payments"] == 12


def test_dispute_draft_contains_case_numbers():
    facts = {"payer": "Apex Manufacturing", "payment_id": "S3-P1", "claimed_cents": 420000,
             "classification_label": "shortage", "reason_code": "RC-02",
             "win_probability": 0.94, "expected_recovery_usd": 3903.0}
    d = draft_message("dispute_email", "strict", facts)
    assert d["source"] == "template"
    assert "$4,200.00" in d["text"] and "RC-02" in d["text"] and "S3-P1" in d["text"]


def test_rebuttal_split_uses_expected_value_math():
    facts = {"claimed_cents": 420000, "win_probability": 0.94,
             "expected_recovery_usd": 3903.0, "buyer_reply": "split", "offer_usd": 2100.0}
    d = draft_message("rebuttal", "strict", facts)
    assert "cannot accept" in d["text"] and "$3,903.00" in d["text"]
    facts2 = dict(facts, offer_usd=4000.0)
    d2 = draft_message("rebuttal", "strict", facts2)
    assert "we accept" in d2["text"]
