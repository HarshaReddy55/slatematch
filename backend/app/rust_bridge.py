"""Python reference implementation of the kernel semantics + bridge to the
Rust binary. The DP here is the specification; the Rust kernel must match it
exactly on shared fixtures (enforced by tests). If the binary is absent,
callers use this reference - same results, slower."""
import json, os, subprocess

def best_subset_py(target_cents, invoices, age_weight_milli=50):
    """invoices: list of dicts {invoice_id, gross_cents, age_days}"""
    cap = max(int(target_cents), 0)
    dp = [None] * (cap + 1)
    dp[0] = (0, ())
    for inv in invoices:
        g = int(inv["gross_cents"])
        if g <= 0 or g > cap: continue
        w = 1000 + int(inv["age_days"]) * age_weight_milli
        for s in range(cap - g, -1, -1):
            if dp[s] is not None:
                ns = s + g
                nscore = dp[s][0] + w
                if dp[ns] is None or nscore > dp[ns][0]:
                    dp[ns] = (nscore, dp[s][1] + (inv["invoice_id"],))
    best = 0
    for s in range(cap, -1, -1):
        if dp[s] is not None: best = s; break
    score, ids = dp[best]
    return {"selected_ids": list(ids), "selected_sum_cents": best,
            "residual_cents": cap - best, "score_milli": score}

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
