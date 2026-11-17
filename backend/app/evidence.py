"""Evidence fusion: one payment's evidence rarely arrives in one
place. A bank line, an email and a PDF remittance disagree - the
bank says $10,000 landed, the email claims $10,400 was sent. This
module fuses the sources into one evidence bundle per payment,
with per-field provenance and an explicit conflict rule, so the
disagreement is resolved by a stated rule and shown, never
silently averaged.

Priority (stated, not hidden): for the amount and the payer, the
bank's record beats a document, and a document beats an email
claim - bank > pdf > email. References are unioned (a reference
any source states is evidence), each keeping its provenance.
Deductions follow the same priority among sources that state
one.
"""
from ai import deterministic_parse
from ingestion import extract_references

_PRIORITY = {"bank": 3, "pdf": 2, "email": 1}
_KINDS = ("bank", "email", "pdf")


def _parse_source(kind, text):
    f = deterministic_parse(text or "")
    refs = list(f.get("invoice_refs") or []) + list(f.get("po_refs") or [])
    for r in extract_references(text or ""):
        if r not in refs:
            refs.append(r)
    return {"kind": kind, "payer": f.get("payer") or "",
            "amount_cents": int(f.get("amount_cents") or 0),
            "references": refs,
            "deduction_cents": int(f.get("deduction_cents") or 0),
            "deduction_reason": f.get("deduction_reason") or ""}


def fuse_sources(sources):
    """sources: [{kind: bank|email|pdf, text}]. Returns the fused
    bundle: winning fields, where each field came from, and every
    conflict with the rule that settled it."""
    parsed = []
    for s in sources or []:
        kind = (s.get("kind") or "").lower()
        if kind not in _KINDS:
            raise ValueError(f"unknown evidence kind {kind!r} (use bank, email or pdf)")
        parsed.append(_parse_source(kind, s.get("text") or ""))
    if not parsed:
        raise ValueError("at least one evidence source is required")
    parsed.sort(key=lambda p: -_PRIORITY[p["kind"]])

    conflicts = []

    def pick(field, rule):
        stated = [(p["kind"], p[field]) for p in parsed if p[field]]
        if not stated:
            return None, ""
        winner_kind, winner_val = stated[0]
        distinct = {v for _, v in stated}
        if len(distinct) > 1:
            conflicts.append({
                "field": field,
                "values": {k: v for k, v in stated},
                "winner": winner_kind, "winning_value": winner_val,
                "rule": rule})
        return winner_val, winner_kind

    amount, amount_src = pick(
        "amount_cents",
        "The bank's record of what landed beats any claim about what was sent.")
    payer, payer_src = pick(
        "payer",
        "The bank's payer record beats the name a document or email asserts.")
    ded, ded_src = pick(
        "deduction_cents",
        "A deduction is taken from the highest-priority source that states one.")

    refs, prov = [], {}
    for p in parsed:
        for r in p["references"]:
            if r not in refs:
                refs.append(r)
            prov.setdefault(r, []).append(p["kind"])
    ded_reason = ""
    for p in parsed:
        if p["deduction_cents"] and p["kind"] == ded_src:
            ded_reason = p["deduction_reason"]
            break

    return {
        "fields": {"payer": payer or "", "amount_cents": amount or 0,
                   "references": refs,
                   "deduction_cents": ded or 0,
                   "deduction_reason": ded_reason},
        "provenance": {"amount_cents": amount_src, "payer": payer_src,
                       "deduction_cents": ded_src,
                       "references": prov},
        "conflicts": conflicts,
        "sources_seen": [p["kind"] for p in parsed],
        "rule": "bank > pdf > email for amount and payer; references unioned "
                "with provenance; the disagreement is shown, never averaged.",
    }
