"""SlateMatch domain models. Money is integer cents everywhere."""
from dataclasses import dataclass, field
from typing import Optional, List, Dict

@dataclass
class Invoice:
    invoice_id: str
    customer: str
    subsidiary: str
    gross_cents: int
    currency: str = "USD"
    po_number: Optional[str] = None
    discount_rate: float = 0.0
    age_days: int = 0
    due_in_days: int = 0            # negative = overdue
    predicted_delay_days: float = 0.0

@dataclass
class Payment:
    payment_id: str
    payer_raw: str
    amount_cents: int
    currency: str = "USD"
    claimed_deduction_cents: int = 0
    deduction_reason_raw: str = ""
    pod_verified_clean: bool = False
    remittance_text: str = ""
    references: List[str] = field(default_factory=list)   # invoice or PO refs found in remittance

@dataclass
class Policy:
    name: str = "Oldest first"
    age_weight: float = 0.05          # FIFO pressure in solver objective
    discount_penalty: float = 50.0    # penalise unearned discount assumptions
    residual_penalty: float = 1e6     # dominant: unexplained cash is the enemy
    deduction_penalty: float = 10.0
    automation_threshold: float = 0.90   # confidence at/above which a match may auto-post
    auto_dispute_min_recovery_usd: float = 100.0
    dispute_processing_cost_usd: float = 45.0
    tolerance_writeoff_cents: int = 2500 # variances <= $25 write off, do not dispute
    maker_checker_threshold_cents: int = 10_000_000  # $100,000

    def __post_init__(self):
        # A policy is accounting judgement expressed as data; nonsense
        # values (a negative hold limit, a confidence bar above 1) must
        # fail loudly at the boundary, never reach the solver.
        if not (0.0 <= float(self.automation_threshold) <= 1.0):
            raise ValueError("automation_threshold must be between 0 and 1")
        for f in ("age_weight", "discount_penalty", "residual_penalty", "deduction_penalty",
                  "auto_dispute_min_recovery_usd", "dispute_processing_cost_usd"):
            if float(getattr(self, f)) < 0:
                raise ValueError(f"{f} must be >= 0")
        for f in ("tolerance_writeoff_cents", "maker_checker_threshold_cents"):
            if int(getattr(self, f)) < 0:
                raise ValueError(f"{f} must be >= 0")

@dataclass
class MatchLine:
    invoice_id: str
    gross_cents: int
    discount_cents: int
    net_cents: int
    discount_taken: bool

@dataclass
class MatchResult:
    payment_id: str
    status: str                       # OPTIMAL_EXACT_MATCH | PARTIAL_MATCH | NO_MATCH
    solver: str                       # milp | greedy
    latency_ms: float
    lines: List[MatchLine]
    deduction_applied: bool
    residual_cents: int
    confidence: float
    matched_by: str                   # reference | po | amount_payer | solver_subset
    factors: Dict[str, float]
