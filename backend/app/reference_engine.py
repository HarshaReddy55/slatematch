# milp_engine.py
from dataclasses import dataclass, asdict
from typing import List, Dict, Optional
import time
import numpy as np
from scipy.optimize import milp, LinearConstraint, Bounds
from pydantic import BaseModel

# This module is the preserved original engine: pure functions and data
# classes only. It once carried its own FastAPI app (a dead second web
# service inside the library, never imported by the product); that app
# was removed so the file is exactly what its tests exercise.


@dataclass
class InvoiceRecord:
    invoice_id: str
    subsidiary: str
    gross_cents: int
    discount_rate: float  # e.g., 0.02 for 2%
    age_days: int
    predicted_delay_days: float


class ReconciliationRequest(BaseModel):
    wire_amount_cents: int
    claimed_deduction_cents: int
    deduction_reason_raw: str
    pod_verified_clean: bool
    historical_deduction_mean_cents: float
    historical_deduction_std_cents: float
    invoices: List[Dict]


class AutonomousCashAppAgent:
    """
    End-to-End Office of the CFO Agent combining Mixed Integer Linear Programming (MILP),
    Statistical Anomaly Detection, and Autonomous Dispute / ERP Payload Generation.
    """

    def __init__(self, penalty_weight: float = 1e6, discount_penalty: float = 50.0):
        self.penalty_weight = penalty_weight
        self.discount_penalty = discount_penalty

    def solve_milp_reconciliation(
        self,
        wire_cents: int,
        deduction_cents: int,
        invoices: List[InvoiceRecord],
    ) -> Dict:
        t0 = time.perf_counter()
        n = len(invoices)

        # Decision variables:
        # [x_0..x_{n-1} (binary: invoice included),
        #  y_0..y_{n-1} (binary: early-pay discount taken),
        #  z_0 (binary: claimed deduction applied),
        #  eps_pos, eps_neg (continuous >= 0: unexplained residual cash in cents)]
        num_vars = 2 * n + 3
        integrality = np.ones(num_vars)
        integrality[-2:] = 0  # eps_pos and eps_neg are continuous slack variables

        # Objective: Minimize Lambda*(eps_pos + eps_neg) - sum(age_weight * x_i) + gamma * sum(y_i)
        c = np.zeros(num_vars)
        for i, inv in enumerate(invoices):
            c[i] = -(1.0 + inv.age_days * 0.05)  # Prioritize clearing older invoices (FIFO)
            c[n + i] = self.discount_penalty     # Penalize unearned discount assumptions
        c[2 * n] = 10.0                          # Small penalty for applying deduction
        c[2 * n + 1] = self.penalty_weight       # eps_pos penalty
        c[2 * n + 2] = self.penalty_weight       # eps_neg penalty

        # Equality Constraint 1: Cash Conservation Equation
        # sum(I_i * x_i) - sum(D_i * y_i) - deduction_cents * z_0 + eps_pos - eps_neg == wire_cents
        A_eq = np.zeros((1, num_vars))
        for i, inv in enumerate(invoices):
            A_eq[0, i] = inv.gross_cents
            A_eq[0, n + i] = -round(inv.gross_cents * inv.discount_rate)
        A_eq[0, 2 * n] = -deduction_cents
        A_eq[0, 2 * n + 1] = 1.0
        A_eq[0, 2 * n + 2] = -1.0

        # Inequality Constraints: y_i - x_i <= 0 (Cannot take discount unless invoice is paid)
        A_ub = np.zeros((n, num_vars))
        for i in range(n):
            A_ub[i, i] = -1.0
            A_ub[i, n + i] = 1.0

        A_full = np.vstack([A_eq, A_ub])
        lb_con = np.concatenate([[wire_cents], np.full(n, -np.inf)])
        ub_con = np.concatenate([[wire_cents], np.zeros(n)])

        lb_vars = np.zeros(num_vars)
        ub_vars = np.ones(num_vars)
        ub_vars[-2:] = np.inf

        res = milp(
            c=c,
            integrality=integrality,
            bounds=Bounds(lb_vars, ub_vars),
            constraints=LinearConstraint(A_full, lb_con, ub_con),
        )

        latency_ms = round((time.perf_counter() - t0) * 1000, 2)
        sol = res.x

        matched_invoices = []
        for i, inv in enumerate(invoices):
            if round(sol[i]) == 1:
                disc_taken = round(sol[n + i]) == 1
                disc_cents = round(inv.gross_cents * inv.discount_rate) if disc_taken else 0
                matched_invoices.append({
                    "invoice_id": inv.invoice_id,
                    "subsidiary": inv.subsidiary,
                    "gross_dollars": inv.gross_cents / 100.0,
                    "discount_taken": disc_taken,
                    "discount_dollars": disc_cents / 100.0,
                    "net_applied_dollars": (inv.gross_cents - disc_cents) / 100.0,
                })

        residual_cents = round(sol[2 * n + 1] - sol[2 * n + 2])
        return {
            "solver_status": "OPTIMAL_EXACT_MATCH" if residual_cents == 0 else "PARTIAL_MATCH",
            "latency_ms": latency_ms,
            "residual_variance_dollars": residual_cents / 100.0,
            "deduction_matched": bool(round(sol[2 * n]) == 1),
            "matched_invoices": matched_invoices,
        }

    def evaluate_deduction_anomaly_and_dispute(
        self, req: ReconciliationRequest
    ) -> Dict:
        z_score = (
            (req.claimed_deduction_cents - req.historical_deduction_mean_cents)
            / max(req.historical_deduction_std_cents, 1.0)
        )
        is_anomalous = z_score > 2.5
        win_prob = 0.94 if req.pod_verified_clean else 0.35
        processing_cost_dollars = 45.0
        deduction_dollars = req.claimed_deduction_cents / 100.0
        expected_recovery_dollars = round(
            (win_prob * deduction_dollars) - processing_cost_dollars, 2
        )

        return {
            "anomaly_z_score": round(z_score, 2),
            "is_anomalous_spike": is_anomalous,
            "assigned_erp_reason_code": "RC-02: Damaged/Shortage Claim",
            "autonomous_action": "AUTO_GENERATE_DISPUTE_CLAIM"
            if (req.pod_verified_clean and expected_recovery_dollars > 100)
            else "ROUTE_TO_ANALYST",
            "expected_recovery_value_usd": expected_recovery_dollars,
            "win_probability": win_prob,
        }


