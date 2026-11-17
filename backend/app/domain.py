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
    # FX only: when resolve_candidates converts this invoice into a
    # payment's currency, the copy carries its book (original) gross
    # and currency here so settlement and the ERP document can still
    # speak in book values. None on every ordinary invoice.
    fx_book_gross_cents: Optional[int] = None
    fx_book_currency: Optional[str] = None
    # The amount the invoice was originally billed at. gross_cents
    # is the working open balance (partial applications reduce it);
    # this field is written once at ingestion and never mutated, so
    # the original billing record survives every settlement - the
    # audit trail an external reviewer asks for. None on in-memory
    # solver copies that are never persisted.
    original_gross_cents: Optional[int] = None

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
    subsidiary: Optional[str] = None   # paying legal entity / company code, when the wire states one

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
    # How an underpayment is spread across the matched lines when a
    # partial match is approved: pro_rata (today's behaviour, the
    # default), fifo_oldest (fill the oldest invoice in full first,
    # the shortfall lands on the newest), or explicit_line (the
    # amounts the remittance itself specifies per invoice, with any
    # remainder spread pro-rata; falls back to pro_rata when the
    # remittance prices no line).
    partial_allocation_mode: str = "pro_rata"
    collections_escalation_days: int = 14
    # FX conversion rates: {currency: USD value of one unit}, e.g.
    # {"EUR": 1.087} means 1 EUR = 1.087 USD. USD is always 1.0 and
    # needs no entry. Empty (the default) keeps currency a hard
    # matching boundary, exactly as before; with rates present, a
    # payment may settle invoices of ONE other currency at these
    # rates and the difference posts as realised FX gain/loss.
    fx_rates: Dict[str, float] = field(default_factory=dict)
    # Autonomy: 0 = off, every decision is a human's (the long-standing
    # default). 1 = assisted: the autopilot resolves PROPOSED partial
    # matches whose shortfall is within tolerance_writeoff_cents.
    # 2 = autonomous: the cap rises to autopilot_max_residual_cents.
    # Maker-checker holds and exceptions are never autopilot business
    # at any level, and every resolution is reversible from its
    # recorded pre-state.
    autonomy_level: int = 0
    autopilot_max_residual_cents: int = 25000

    def __post_init__(self):
        if self.partial_allocation_mode not in ("pro_rata", "fifo_oldest", "explicit_line"):
            raise ValueError("partial_allocation_mode must be pro_rata, fifo_oldest or explicit_line")
        if int(self.collections_escalation_days) < 1:
            raise ValueError("collections_escalation_days must be at least 1")
        if self.autonomy_level not in (0, 1, 2):
            raise ValueError("autonomy_level must be 0 (off), 1 (assisted) or 2 (autonomous)")
        if int(self.autopilot_max_residual_cents) < 0:
            raise ValueError("autopilot_max_residual_cents cannot be negative")
        for ccy, rate in (self.fx_rates or {}).items():
            if not (isinstance(ccy, str) and len(ccy) == 3 and ccy.isalpha() and ccy == ccy.upper()):
                raise ValueError(f"fx_rates key {ccy!r} must be a 3-letter uppercase currency code")
            if not (isinstance(rate, (int, float)) and float(rate) > 0):
                raise ValueError(f"fx_rates[{ccy}] must be a positive number (USD value of one unit)")
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
