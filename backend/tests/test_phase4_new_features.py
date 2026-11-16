"""Phase 4 (16 Nov 2026, third external review - the genuinely new
items only): AI-call hardening (PII redaction before Gemini, strict
response schema with a safe fallback), credit-memo netting in the
solver, and policy-selectable partial-payment allocation modes."""
import base64, json, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
os.environ.setdefault("SLATEMATCH_DATA_DIR", os.path.join(os.path.dirname(__file__), "api_data"))

import pytest
from fastapi.testclient import TestClient
import api as api_mod
from ai import GeminiClient, redact_pii, parse_remittance, PARSE_RESPONSE_SCHEMA
from domain import Invoice, Payment, Policy
from solvers import solve_milp
from batch import allocate_partial_payment, _enumerate_subsets
from ingestion import parse_invoices_csv

client = TestClient(api_mod.app, raise_server_exceptions=False)

IBAN = "DE89370400440532013000"
ROUTING_OK = "021000021"      # passes the ABA checksum
ROUTING_BAD = "123456789"     # same shape, fails the checksum


# ------------------------------------------------------------------
# PII redaction
# ------------------------------------------------------------------

def test_redact_iban_routing_and_labelled_account():
    text = (f"Wire from Apex Manufacturing. Our IBAN {IBAN} and routing "
            f"{ROUTING_OK}. Account No: 123456789012. Paid $850.00 for INV-1001.")
    out, n = redact_pii(text)
    assert IBAN not in out and ROUTING_OK not in out and "123456789012" not in out
    assert n == 3
    # the extraction surface is untouched: refs and amounts survive
    assert "INV-1001" in out and "$850.00" in out and "Apex Manufacturing" in out


def test_redact_spaced_iban_and_swift_label():
    out, n = redact_pii("IBAN: DE89 3704 0044 0532 0130 00, SWIFT code: DEUTDEFF500")
    assert "DE89" not in out and "DEUTDEFF500" not in out and n == 2


def test_redact_keeps_checksum_failing_digits_and_plain_words():
    out, n = redact_pii(f"Reference {ROUTING_BAD} noted. STANDARD terms apply.")
    assert ROUTING_BAD in out and "STANDARD" in out and n == 0


def test_parse_remittance_scrubs_only_the_outbound_copy():
    seen = {}

    def transport(payload):
        seen["prompt"] = payload["contents"][0]["parts"][0]["text"]
        seen["schema"] = payload["generationConfig"].get("responseSchema")
        body = {"payer": "Apex Manufacturing", "amount_cents": 85000,
                "invoice_refs": ["INV-1001"], "po_refs": [],
                "deduction_cents": 0, "deduction_reason": ""}
        return {"candidates": [{"content": {"parts": [{"text": json.dumps(body)}]}}]}

    stub = GeminiClient(api_key="test-key", transport=transport)
    text = f"From: Apex Manufacturing. IBAN {IBAN}. Paid $850.00 against INV-1001."
    r = parse_remittance(text, {"INV-1001"}, set(), client=stub)
    assert r["source"] == "gemini" and r["pii_redacted"] == 1
    assert IBAN not in seen["prompt"] and "[REDACTED]" in seen["prompt"]
    assert seen["schema"] == PARSE_RESPONSE_SCHEMA
    assert r["fields"]["amount_cents"] == 85000


# ------------------------------------------------------------------
# Strict response schema, with yesterday's behaviour as the fallback
# ------------------------------------------------------------------

def test_generate_json_schema_rejection_retries_without_schema():
    calls = []

    def transport(payload):
        calls.append(payload)
        if "responseSchema" in payload["generationConfig"]:
            raise RuntimeError("schema rejected by endpoint")
        return {"candidates": [{"content": {"parts": [{"text": "{\"ok\": true}"}]}}]}

    c = GeminiClient(api_key="k", transport=transport)
    out = c.generate_json("prompt", schema=PARSE_RESPONSE_SCHEMA)
    assert out == {"ok": True} and len(calls) == 2
    assert "responseSchema" not in calls[1]["generationConfig"]


def test_generate_json_without_schema_is_one_plain_call():
    calls = []

    def transport(payload):
        calls.append(payload)
        return {"candidates": [{"content": {"parts": [{"text": "{\"ok\": 1}"}]}}]}

    c = GeminiClient(api_key="k", transport=transport)
    assert c.generate_json("p") == {"ok": 1} and len(calls) == 1
    assert "responseSchema" not in calls[0]["generationConfig"]


# ------------------------------------------------------------------
# Credit-memo netting
# ------------------------------------------------------------------

def _inv(iid, gross, age=10):
    return Invoice(iid, "Acme Widgets", "1000", gross, "USD", None, 0.0, age, 30, 0.0)


def test_milp_nets_a_credit_memo_at_face_value():
    cands = [_inv("INV-2001", 100000), _inv("INV-2002", -15000)]
    pay = Payment("W1", "Acme Widgets", 85000, "USD", 0, "", False, "",
                  ["INV-2001", "INV-2002"])
    r = solve_milp(pay, cands, Policy(), "reference")
    assert r.status == "OPTIMAL_EXACT_MATCH" and r.residual_cents == 0
    lines = {l.invoice_id: l for l in r.lines}
    assert set(lines) == {"INV-2001", "INV-2002"}
    assert lines["INV-2002"].net_cents == -15000
    assert lines["INV-2002"].discount_taken is False
    # netting is MILP work: the positive-only kernel must not decide it
    assert r.factors.get("rust_kernel_used") is False


def test_enumeration_declines_a_pool_with_a_credit_memo():
    cands = [_inv("INV-2001", 100000), _inv("INV-2002", -15000)]
    assert _enumerate_subsets(cands, 85000) == (None, None, [])


def test_ingestion_accepts_credit_memos_rejects_zero():
    csv = ("invoice_id,customer,amount,po_number,discount_rate,age_days,due_in_days\n"
           "INV-2001,Acme Widgets,1000.00,,0,10,30\n"
           "INV-2002,Acme Widgets,-150.00,,0,10,30\n")
    out = parse_invoices_csv(csv)
    assert out["errors"] == []
    assert {i.invoice_id: i.gross_cents for i in out["invoices"]} == {"INV-2001": 100000, "INV-2002": -15000}
    out = parse_invoices_csv(csv.replace("-150.00", "0.00"))
    assert [i.invoice_id for i in out["invoices"]] == ["INV-2001"]
    assert out["errors"] and "cannot be zero" in out["errors"][0]["error"]


# ------------------------------------------------------------------
# Partial allocation modes (pure allocation arithmetic)
# ------------------------------------------------------------------

def _lines(*specs):
    return [{"invoice_id": iid, "gross_cents": net, "net_cents": net} for iid, net in specs]


def test_alloc_pro_rata_is_the_legacy_arithmetic():
    allocs, used, note = allocate_partial_payment(
        _lines(("A", 60000), ("B", 40000)), 50000, "pro_rata", {}, {})
    assert allocs == {"A": 30000, "B": 20000} and used == "pro_rata" and note is None


def test_alloc_fifo_oldest_fills_oldest_first():
    meta = {"A": _inv("A", 60000, age=5), "B": _inv("B", 40000, age=40)}
    allocs, used, _ = allocate_partial_payment(
        _lines(("A", 60000), ("B", 40000)), 50000, "fifo_oldest", meta, {})
    assert allocs == {"A": 10000, "B": 40000} and used == "fifo_oldest"


def test_alloc_explicit_line_uses_remittance_amounts():
    allocs, used, note = allocate_partial_payment(
        _lines(("A", 60000), ("B", 40000)), 50000, "explicit_line", {}, {"A": 20000})
    assert allocs == {"A": 20000, "B": 30000} and used == "explicit_line"
    assert note and "pro-rata" in note  # the unpriced line's basis is disclosed


def test_alloc_explicit_line_without_amounts_falls_back_and_says_so():
    allocs, used, note = allocate_partial_payment(
        _lines(("A", 60000), ("B", 40000)), 50000, "explicit_line", {}, {})
    assert allocs == {"A": 30000, "B": 20000} and used == "pro_rata"
    assert note and "no per-invoice amounts" in note


def test_alloc_credit_memo_nets_in_full_in_every_mode():
    lines = _lines(("INV", 100000), ("CM", -15000))
    for mode in ("pro_rata", "fifo_oldest", "explicit_line"):
        allocs, _, _ = allocate_partial_payment(lines, 65000, mode, {"INV": _inv("INV", 100000)}, {})
        assert allocs == {"INV": 80000, "CM": -15000}, mode
        assert sum(allocs.values()) == 65000


def test_policy_rejects_an_unknown_allocation_mode():
    with pytest.raises(ValueError):
        Policy(partial_allocation_mode="sideways")


# ------------------------------------------------------------------
# API end-to-end: policy merge + FIFO approval + credit netting
# ------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _restore_policy():
    yield
    client.put("/api/v1/policy", json={"policy": {
        "partial_allocation_mode": "pro_rata", "name": "Oldest first"}})


def test_policy_put_merges_instead_of_resetting():
    r = client.put("/api/v1/policy", json={"policy": {"partial_allocation_mode": "fifo_oldest"}})
    assert r.status_code == 200, r.text
    r = client.put("/api/v1/policy", json={"policy": {"name": "Month-end profile"}})
    assert r.status_code == 200, r.text
    p = client.get("/api/v1/policy").json()["policy"]
    assert p["name"] == "Month-end profile"
    assert p["partial_allocation_mode"] == "fifo_oldest"  # preserved, not reset


def test_fifo_allocation_at_approval_time():
    client.post("/api/v1/workspace/reset")
    client.put("/api/v1/policy", json={"policy": {"partial_allocation_mode": "fifo_oldest"}})
    inv_csv = ("invoice_id,customer,amount,po_number,discount_rate,age_days,due_in_days\n"
               "OLD-1,Acme Widgets,600.00,,0,40,30\n"
               "NEW-1,Acme Widgets,400.00,,0,5,30\n")
    r = client.post("/api/v1/invoices/import", json={"csv_text": inv_csv, "mode": "replace"})
    assert r.status_code == 200, r.text
    # $950 against $600 + $400: the pair is the solver's closest set
    # (residual -$50), so the partial match carries both lines.
    pay_csv = ("payment_id,payer,amount,remittance,deduction,deduction_reason\n"
               "F1,Acme Widgets,950.00,Payment for OLD-1 and NEW-1,,\n")
    r = client.post("/api/v1/payments/import", json={"csv_text": pay_csv})
    assert r.status_code == 200, r.text
    run_id = r.json()["run"]["run_id"]
    matches = client.get(f"/api/v1/runs/{run_id}/matches").json()
    m = next(x for x in matches if x["payment_id"] == "F1")
    assert m["status"] == "PROPOSED" and m["result"]["status"] == "PARTIAL_MATCH"
    assert {l["invoice_id"] for l in m["result"]["lines"]} == {"OLD-1", "NEW-1"}
    r = client.post(f"/api/v1/matches/{m['match_id']}/decision", json={"decision": "approve"})
    assert r.status_code == 200, r.text
    m2 = client.get(f"/api/v1/runs/{run_id}/matches").json()
    appr = next(x for x in m2 if x["payment_id"] == "F1")["result"]["approval"]
    assert appr["allocation_mode"] == "fifo_oldest"
    # FIFO: the older invoice is settled in full; the shortfall lands
    # entirely on the newest (pro-rata would have split it 57000/38000)
    assert appr["settled_invoices"] == ["OLD-1"]
    parts = {p["invoice_id"]: p for p in appr["partial_application"]}
    assert parts["NEW-1"]["applied_cents"] == 35000 and parts["NEW-1"]["remaining_cents"] == 5000


def test_credit_memo_nets_end_to_end_and_settles():
    client.post("/api/v1/workspace/reset")
    inv_csv = ("invoice_id,customer,amount,po_number,discount_rate,age_days,due_in_days\n"
               "INV-2001,Acme Widgets,1000.00,,0,10,30\n"
               "INV-2002,Acme Widgets,-150.00,,0,10,30\n")
    r = client.post("/api/v1/invoices/import", json={"csv_text": inv_csv, "mode": "replace"})
    assert r.status_code == 200, r.text
    pay_csv = ("payment_id,payer,amount,remittance,deduction,deduction_reason\n"
               "W1,Acme Widgets,850.00,For INV-2001 less credit INV-2002,,\n")
    r = client.post("/api/v1/payments/import", json={"csv_text": pay_csv})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["run"]["auto_posted"] == 1
    matches = client.get(f"/api/v1/runs/{d['run']['run_id']}/matches").json()
    m = next(x for x in matches if x["payment_id"] == "W1")
    assert {l["invoice_id"] for l in m["result"]["lines"]} == {"INV-2001", "INV-2002"}
    ws = client.get("/api/v1/workspace").json()
    assert ws["open_invoices"] == 0  # both the invoice and the memo settled
