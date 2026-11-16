"""Python reference implementation of the kernel semantics + bridge to the
Rust binary. Subset ENUMERATION here is the specification; the Rust kernel
must match it exactly on shared fixtures (enforced by tests). If the binary
is absent, callers use this reference - same results, slower.

Why enumeration, not the old DP over cents: the DP allocated one state per
cent of the target, so a $250,000 wire meant 25,000,000 states (gigabytes
in this Python form) to choose among at most 18 invoices. Enumeration is
2^n in the candidate count and independent of the amount: at the engine's
n <= 18 gate that is 262,144 subsets, each scored incrementally from its
lowest set bit. Selection rule, shared verbatim with the Rust kernel:
maximise (sum, then age-weighted score); break exact ties by fewer
invoices, then by the lexicographically smaller selected-id tuple."""
import json, os, subprocess

_MAX_KERNEL_CANDIDATES = 20

def _selected_ids(items, mask):
    return tuple(items[b][0] for b in range(len(items)) if mask >> b & 1)

def best_subset_py(target_cents, invoices, age_weight_milli=50):
    """invoices: list of dicts {invoice_id, gross_cents, age_days}"""
    cap = max(int(target_cents), 0)
    items = [(inv["invoice_id"], int(inv["gross_cents"]),
              1000 + int(inv["age_days"]) * age_weight_milli)
             for inv in invoices if 0 < int(inv["gross_cents"]) <= cap]
    n = len(items)
    if n > _MAX_KERNEL_CANDIDATES:
        raise ValueError(f"kernel enumeration is bounded to {_MAX_KERNEL_CANDIDATES} candidates, got {n}")
    size = 1 << n
    sums = [0] * size; scores = [0] * size; counts = [0] * size
    for mask in range(1, size):
        lsb = mask & -mask; bit = lsb.bit_length() - 1; prev = mask ^ lsb
        sums[mask] = sums[prev] + items[bit][1]
        scores[mask] = scores[prev] + items[bit][2]
        counts[mask] = counts[prev] + 1
    best = 0
    for mask in range(1, size):
        if sums[mask] > cap: continue
        if (sums[mask], scores[mask]) > (sums[best], scores[best]):
            best = mask
        elif (sums[mask], scores[mask]) == (sums[best], scores[best]):
            if counts[mask] < counts[best] or (
                    counts[mask] == counts[best]
                    and _selected_ids(items, mask) < _selected_ids(items, best)):
                best = mask
    return {"selected_ids": list(_selected_ids(items, best)),
            "selected_sum_cents": sums[best],
            "residual_cents": cap - sums[best], "score_milli": scores[best]}

def best_subset_rust(target_cents, invoices, age_weight_milli=50, binary=None, timeout=30):
    binary = binary or os.environ.get("SLATEMATCH_KERNEL_BIN", "")
    if not binary or not os.path.exists(binary):
        return None
    payload = json.dumps({"target_cents": target_cents, "age_weight_milli": age_weight_milli,
                          "invoices": invoices})
    try:
        out = subprocess.run([binary], input=payload, capture_output=True, text=True, timeout=timeout)
    except Exception:
        return None
    if out.returncode != 0: return None
    return json.loads(out.stdout)
