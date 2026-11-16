"""Anomaly + deduction intelligence. Extends Harsha's original z-score rule
with duplicate detection, tolerance coding and reason classification hooks."""
import re
from domain import Policy

REASON_TAXONOMY = [
    ("RC-12", "Unearned Discount", ["unearned discount", "discount window"]),
    ("RC-02", "Damaged/Shortage Claim", ["short", "damage", "damaged", "missing", "broken", "shortage"]),
    ("RC-05", "Pricing Discrepancy", ["price", "pricing", "rate", "quoted"]),
    ("RC-07", "Promotional Allowance", ["promo", "promotion", "allowance", "rebate", "deal"]),
    ("RC-09", "Freight Claim", ["freight", "shipping", "transport", "delivery charge"]),
    ("RC-11", "Tax Withholding", ["tax", "tds", "withhold", "gst", "vat"]),
]

def classify_reason(text):
    t = (text or "").lower()
    scored = []
    for code, label, kws in REASON_TAXONOMY:
        hits = sum(1 for k in kws if k in t)
        if hits: scored.append((hits, code, label))
    if not scored:
        return {"code": "RC-99", "label": "Other/Unclassified", "confidence": 0.3, "candidates": ["RC-99"]}
    scored.sort(reverse=True)
    top = scored[0]
    conf = round(min(0.65 + 0.15 * top[0], 0.95), 2)
    cands = [s[1] for s in scored[:2]]
    return {"code": top[1], "label": top[2], "confidence": conf, "candidates": cands}

def deduction_intelligence(payment, hist_mean_cents, hist_std_cents, policy: Policy):
    claimed = payment.claimed_deduction_cents
    if claimed <= 0:
        return None
    z = (claimed - hist_mean_cents) / max(hist_std_cents, 1.0)
    cls = classify_reason(payment.deduction_reason_raw)
    if claimed <= policy.tolerance_writeoff_cents:
        return {"z_score": round(z, 2), "is_anomalous_spike": False, "classification": cls,
                "assigned_erp_reason_code": cls["code"], "autonomous_action": "WRITE_OFF_TOLERANCE",
                "expected_recovery_value_usd": 0.0, "win_probability": None,
                "derivation": [f"claimed deduction ${claimed/100:.2f} <= tolerance ${policy.tolerance_writeoff_cents/100:.2f}, so the policy writes it off without a dispute",
                               f"z-score = (claimed - history mean) / history std = ({claimed} - {hist_mean_cents}) / {hist_std_cents} = {z:.2f} (spike only above 2.5)"],
                "note": f"Claimed ${claimed/100:.2f} is within the ${policy.tolerance_writeoff_cents/100:.2f} tolerance policy; write off, do not dispute."}
    win_prob = 0.94 if payment.pod_verified_clean else 0.35
    expected = round(win_prob * (claimed / 100.0) - policy.dispute_processing_cost_usd, 2)
    action = "AUTO_GENERATE_DISPUTE_CLAIM" if (payment.pod_verified_clean and expected > policy.auto_dispute_min_recovery_usd) else "ROUTE_TO_ANALYST"
    return {"z_score": round(z, 2), "is_anomalous_spike": z > 2.5, "classification": cls,
            "assigned_erp_reason_code": cls["code"], "autonomous_action": action,
            "derivation": [f"reason classified {cls['code']} ({cls['label']}) from the deduction text by keyword evidence, confidence {cls['confidence']}",
                           f"z-score = (claimed - history mean) / history std = ({claimed} - {hist_mean_cents}) / {hist_std_cents} = {z:.2f}; anomalous spike only if z > 2.5",
                           f"win probability = {win_prob} because proof of delivery is {'verified clean' if payment.pod_verified_clean else 'not clean'} (transparent heuristic, not a trained model)",
                           f"expected recovery = win_probability x claimed - processing cost = {win_prob} x ${claimed/100:.2f} - ${policy.dispute_processing_cost_usd:.2f} = ${expected:.2f}",
                           f"decision: " + (f"expected recovery ${expected:.2f} > threshold ${policy.auto_dispute_min_recovery_usd:.2f} and POD is clean, so a dispute claim is generated automatically" if action == "AUTO_GENERATE_DISPUTE_CLAIM" else (f"expected recovery ${expected:.2f} does not exceed the ${policy.auto_dispute_min_recovery_usd:.2f} threshold, so a human analyst takes it" if expected <= policy.auto_dispute_min_recovery_usd else "POD is not clean, so despite the expected value a human analyst takes it"))],
            "expected_recovery_value_usd": expected, "win_probability": win_prob,
            "win_probability_basis": "transparent heuristic: 0.94 if POD verified clean else 0.35 (demo rule, not a trained model)"}

def payment_fingerprint(payment):
    """Duplicate identity of a wire. v1 hashed only payer|amount|currency,
    which false-positives two genuinely different wires from the same
    payer for the same amount (a monthly rent-style payment would block
    its own successor). v2 also binds the claimed deduction and the
    sorted remittance references, and normalises the payer name, so the
    fingerprint identifies THE wire, not the amount: a true resend
    (same references, same claim) still collides; a distinct wire that
    merely shares an amount does not. The full hex digest is kept -
    the v1 16-char truncation was a 64-bit collision budget. Payments
    carry no value-date field in the canonical schema, so none is
    hashed; references are the strongest wire identity the schema has.
    Callers recompute fingerprints from stored rows rather than
    trusting the stored column, so the v1->v2 change strands nothing."""
    import hashlib, re
    payer = re.sub(r"\s+", " ", (payment.payer_raw or "").strip().lower())
    refs = ",".join(sorted({str(r).strip().upper() for r in (getattr(payment, "references", None) or []) if str(r).strip()}))
    raw = "|".join([payer, str(int(payment.amount_cents)), (payment.currency or "").strip().upper(),
                    str(int(payment.claimed_deduction_cents or 0)), refs])
    return hashlib.sha256(raw.encode()).hexdigest()


def payment_core_fingerprint(payment):
    """The v1-strength identity: normalised payer|amount|currency|claim,
    WITHOUT the remittance references. The batch duplicate guard tiers
    the two: a strong-fingerprint collision is the same wire; a core
    collision is the same wire only when at least one side carries no
    references (a resend that lost its remittance is exactly the
    dangerous duplicate). When both sides name DIFFERENT references,
    they are demonstrably different wires that merely share an amount,
    and neither may block the other."""
    import hashlib, re
    payer = re.sub(r"\s+", " ", (payment.payer_raw or "").strip().lower())
    raw = "|".join([payer, str(int(payment.amount_cents)), (payment.currency or "").strip().upper(),
                    str(int(payment.claimed_deduction_cents or 0))])
    return hashlib.sha256(raw.encode()).hexdigest()
