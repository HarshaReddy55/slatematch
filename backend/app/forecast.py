"""Forecasting + collections prioritisation on top of the delay model.

One model, two views: the Ledger shows the invoices, this module turns the
same invoices into expected cash by week. Every weekly total can be traced
back to the invoices whose expected payment date lands in that week - the
drill-down list is part of the payload, not an afterthought.

Bands come from Monte Carlo over the model's holdout residual spread: each
invoice lands whole in exactly one simulated week, weekly totals are
aggregated per simulation, and P10/P50/P90 are read off the simulated
totals. Honest uncertainty, not decorative percentages."""
import math

import numpy as np
from ml import predict_delay


def _terms_days(inv):
    """The invoice's own payment terms, derived from its dates: it was
    issued age_days ago and falls due in due_in_days, so the contractual
    window between issue and due is the sum. Clamped to the delay
    model's training support (15 to 60 days) so an unusual upload
    cannot push the model outside the range it was validated on."""
    return max(15, min(60, (inv.age_days or 0) + (inv.due_in_days or 0)))


def _delay(delay_model, inv, current_month):
    return float(predict_delay(delay_model, inv.customer, _terms_days(inv),
                               inv.gross_cents, current_month))


def forecast_cash_in(open_invoices, delay_model, horizon_days=56, residual_std=3.5,
                     current_month=10, n_sims=400, seed=3, shift_customer=None, shift_days=0):
    rng = np.random.default_rng(seed)
    n_weeks = max(1, math.ceil(horizon_days / 7))
    detail = []
    gross = np.zeros(len(open_invoices))
    landing = np.zeros((len(open_invoices), n_sims))
    for k, inv in enumerate(open_invoices):
        delay = _delay(delay_model, inv, current_month)
        # due_in_days is days until the due date (negative = already
        # overdue); the model predicts days from the due date to payment
        # (negative = pays early). Cash lands due_in_days + delay from
        # today - an overdue invoice from a punctual payer is expected
        # now, not weeks from now.
        expected_in = inv.due_in_days + delay
        if shift_customer and inv.customer == shift_customer:
            expected_in += shift_days
        sims = expected_in + rng.normal(0, residual_std, n_sims)
        landing[k] = np.maximum(sims, 0.0)  # already-due cash lands now, not in the past
        gross[k] = inv.gross_cents
        if expected_in < 7:
            exp_week = 1  # due now or within the first week
        elif expected_in < horizon_days:
            exp_week = int(expected_in // 7) + 1
        else:
            exp_week = None
        detail.append({"invoice_id": inv.invoice_id, "customer": inv.customer,
                       "gross_cents": inv.gross_cents, "due_in_days": inv.due_in_days,
                       "predicted_delay_days": round(delay, 1),
                       "expected_in_days": round(float(expected_in), 1),
                       "expected_week": exp_week,
                       "prob_within_30": round(float(np.mean(landing[k] <= 30)), 3),
                       "prob_within_horizon": round(float(np.mean(landing[k] <= horizon_days)), 3)})
    weeks = []
    cumulative = 0
    for w in range(n_weeks):
        lo, hi = w * 7, (w + 1) * 7
        in_week = (landing >= lo) & (landing < hi)
        totals = (in_week * gross[:, None]).sum(axis=0)
        p50 = int(np.percentile(totals, 50))
        cumulative += p50
        weeks.append({"week": w + 1, "from_day": lo, "to_day": hi - 1,
                      "p10_cents": int(np.percentile(totals, 10)), "p50_cents": p50,
                      "p90_cents": int(np.percentile(totals, 90)),
                      "cumulative_p50_cents": cumulative,
                      "invoice_ids": [d["invoice_id"] for d in detail if d["expected_week"] == w + 1]})
    beyond_ids = [d["invoice_id"] for d in detail if d["expected_week"] is None]
    beyond = {"invoice_ids": beyond_ids,
              "count": len(beyond_ids),
              "cents": int(sum(d["gross_cents"] for d in detail if d["expected_week"] is None))}
    at_risk = [d for d in detail if d["expected_in_days"] > 45 or d["prob_within_horizon"] < 0.5]
    summary = {"open_ar_cents": int(sum(d["gross_cents"] for d in detail)),
               "overdue_cents": int(sum(d["gross_cents"] for d in detail if d["due_in_days"] < 0)),
               "expected_30_cents": int(sum(d["gross_cents"] * d["prob_within_30"] for d in detail)),
               "expected_horizon_cents": int(sum(d["gross_cents"] * d["prob_within_horizon"] for d in detail)),
               "at_risk_cents": int(sum(d["gross_cents"] for d in at_risk)),
               "at_risk_count": len(at_risk)}
    by_cust = {}
    for d in detail:
        c = by_cust.setdefault(d["customer"], {"customer": d["customer"], "invoices": 0,
                                               "open_cents": 0, "overdue_cents": 0,
                                               "expected_30_cents": 0, "expected_horizon_cents": 0,
                                               "_delay_sum": 0.0})
        c["invoices"] += 1
        c["open_cents"] += d["gross_cents"]
        if d["due_in_days"] < 0:
            c["overdue_cents"] += d["gross_cents"]
        c["expected_30_cents"] += int(d["gross_cents"] * d["prob_within_30"])
        c["expected_horizon_cents"] += int(d["gross_cents"] * d["prob_within_horizon"])
        c["_delay_sum"] += d["predicted_delay_days"]
    customers = []
    for c in by_cust.values():
        c["avg_predicted_delay_days"] = round(c.pop("_delay_sum") / max(c["invoices"], 1), 1)
        customers.append(c)
    customers.sort(key=lambda c: -c["open_cents"])
    return {"horizon_days": horizon_days, "weeks": weeks, "beyond": beyond,
            "invoices": detail, "summary": summary, "customers": customers}


def prioritise_collections(open_invoices, delay_model, current_month=10):
    scored = []
    for inv in open_invoices:
        delay = _delay(delay_model, inv, current_month)
        overdue = max(0, -inv.due_in_days)
        # expected value at risk: amount x lateness pressure; delay raises urgency
        score = (inv.gross_cents / 100.0) * (1 + overdue / 30.0) * (1 + max(delay, 0) / 20.0)
        scored.append({"invoice_id": inv.invoice_id, "customer": inv.customer,
                       "gross_cents": inv.gross_cents, "overdue_days": overdue,
                       "predicted_delay_days": round(float(delay), 1), "priority_score": round(float(score), 2)})
    return sorted(scored, key=lambda r: -r["priority_score"])
