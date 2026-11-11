import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'app'))
from ml import train_all, generate_history
from forecast import forecast_cash_in, prioritise_collections
from domain import Invoice

def test_models_beat_baselines():
    out = train_all(generate_history(n=900, seed=11))
    m = out["metrics"]
    assert m["delay_mae_days"] < m["delay_baseline_mae_days"], m
    assert m["validity_auc"] > 0.65, m

def test_forecast_and_priorities():
    out = train_all(generate_history(n=900, seed=11))
    invs = [Invoice("I1", "Northgate Foods", "E", 100000, due_in_days=-20),
            Invoice("I2", "HarborView Pharma", "Z", 100000, due_in_days=-20),
            Invoice("I3", "Apex Manufacturing", "A", 50000, due_in_days=10)]
    fc = forecast_cash_in(invs, out["delay_model"], horizon_days=30)
    assert "weeks" in fc and len(fc["invoices"]) == 3
    pr = prioritise_collections(invs, out["delay_model"])
    # Northgate Foods (chronic late payer, overdue) should outrank HarborView Pharma (prompt payer) at equal amount/overdue
    assert pr[0]["customer"] == "Northgate Foods", pr
