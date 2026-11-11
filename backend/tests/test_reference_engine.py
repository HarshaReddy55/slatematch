import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'app'))
from reference_engine import AutonomousCashAppAgent, InvoiceRecord, ReconciliationRequest

def inv(i, amt, disc=0.0, age=10):
    return InvoiceRecord(invoice_id=i, subsidiary="ACME", gross_cents=amt, discount_rate=disc, age_days=age, predicted_delay_days=2.0)

def test_exact_split_match():
    agent = AutonomousCashAppAgent()
    invoices = [inv("INV-1", 10000), inv("INV-2", 25000), inv("INV-3", 40000)]
    r = agent.solve_milp_reconciliation(35000, 0, invoices)
    assert r["solver_status"] == "OPTIMAL_EXACT_MATCH", r
    assert {m["invoice_id"] for m in r["matched_invoices"]} == {"INV-1", "INV-2"}
    assert r["residual_variance_dollars"] == 0.0

def test_discount_and_deduction():
    agent = AutonomousCashAppAgent()
    invoices = [inv("INV-9", 100000, disc=0.02, age=30)]
    # wire = 100000 - 2000 discount - 5000 deduction = 93000
    r = agent.solve_milp_reconciliation(93000, 5000, invoices)
    assert r["solver_status"] == "OPTIMAL_EXACT_MATCH", r
    assert r["deduction_matched"] is True
    assert r["matched_invoices"][0]["discount_taken"] is True

def test_anomaly_dispute_rule():
    agent = AutonomousCashAppAgent()
    req = ReconciliationRequest(wire_amount_cents=93000, claimed_deduction_cents=5000,
        deduction_reason_raw="shortage claim", pod_verified_clean=True,
        historical_deduction_mean_cents=1000, historical_deduction_std_cents=500,
        invoices=[])
    d = agent.evaluate_deduction_anomaly_and_dispute(req)
    assert d["is_anomalous_spike"] is True and d["anomaly_z_score"] > 2.5
    # expected recovery = 0.94*5000/100... deduction $50 -> 0.94*50-45 = 2.0, not > 100 -> route
    assert d["autonomous_action"] == "ROUTE_TO_ANALYST"
