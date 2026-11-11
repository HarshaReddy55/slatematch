//! SlateMatch matching kernel - pure functions, no mutation of inputs.
//! Semantics mirror the Python DP reference (rust_bridge.py):
//! choose the subset of invoices whose gross sums closest to (never above)
//! target + deduction, maximising the age-weighted score
//! sum(1 + age_days * age_weight) among equally-close subsets.

#[derive(Debug, Clone, PartialEq)]
pub struct KernelInvoice {
    pub invoice_id: String,
    pub gross_cents: i64,
    pub age_days: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct KernelResult {
    pub selected_ids: Vec<String>,
    pub selected_sum_cents: i64,
    pub residual_cents: i64,
    pub score_milli: i64, // score * 1000, integer for exact cross-language comparison
}

/// DP over cents. State per reachable sum: best (score_milli, chosen bitset as Vec<bool>).
/// Pure: inputs are borrowed, output is freshly allocated.
pub fn best_subset(target_cents: i64, invoices: &[KernelInvoice], age_weight_milli: i64) -> KernelResult {
    let cap = target_cents.max(0) as usize;
    // dp[sum] = Option<(score_milli, selection)>
    let mut dp: Vec<Option<(i64, Vec<bool>)>> = vec![None; cap + 1];
    dp[0] = Some((0, vec![false; invoices.len()]));
    for (i, inv) in invoices.iter().enumerate() {
        let g = inv.gross_cents;
        if g <= 0 || g as usize > cap { continue; }
        let g = g as usize;
        let w = 1000 + inv.age_days * age_weight_milli;
        // iterate sums descending so each invoice is used at most once
        for s in (0..=cap - g).rev() {
            if let Some((score, sel)) = dp[s].clone() {
                let ns = s + g;
                let nscore = score + w;
                let better = match &dp[ns] {
                    None => true,
                    Some((es, _)) => nscore > *es,
                };
                if better {
                    let mut nsel = sel.clone();
                    nsel[i] = true;
                    dp[ns] = Some((nscore, nsel));
                }
            }
        }
    }
    // best = highest reachable sum; tie-break by score (DP already maximises score per sum)
    let mut best_sum = 0usize;
    for s in (0..=cap).rev() {
        if dp[s].is_some() { best_sum = s; break; }
    }
    let (score, sel) = dp[best_sum].clone().unwrap_or((0, vec![false; invoices.len()]));
    let selected_ids: Vec<String> = invoices.iter().zip(sel.iter())
        .filter(|(_, &b)| b).map(|(inv, _)| inv.invoice_id.clone()).collect();
    KernelResult {
        selected_ids,
        selected_sum_cents: best_sum as i64,
        residual_cents: target_cents - best_sum as i64,
        score_milli: score,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn inv(id: &str, gross: i64, age: i64) -> KernelInvoice {
        KernelInvoice { invoice_id: id.into(), gross_cents: gross, age_days: age }
    }
    #[test]
    fn exact_split_preferred_by_age() {
        let invs = vec![inv("INV-3", 20000, 30), inv("INV-1", 12000, 40), inv("INV-2", 8000, 5)];
        let r = best_subset(20000, &invs, 50);
        assert_eq!(r.residual_cents, 0);
        assert_eq!(r.selected_ids, vec!["INV-1".to_string(), "INV-2".to_string()]);
    }
    #[test]
    fn partial_when_no_exact() {
        let invs = vec![inv("A", 7000, 3), inv("B", 9000, 9)];
        let r = best_subset(10000, &invs, 50);
        assert_eq!(r.selected_sum_cents, 9000);
        assert_eq!(r.residual_cents, 1000);
    }
    #[test]
    fn empty_and_zero() {
        let r = best_subset(5000, &[], 50);
        assert_eq!(r.residual_cents, 5000);
        assert!(r.selected_ids.is_empty());
    }
    #[test]
    fn deterministic_repeat() {
        let invs = vec![inv("A", 3000, 3), inv("B", 4000, 9), inv("C", 7000, 1)];
        assert_eq!(best_subset(7000, &invs, 50), best_subset(7000, &invs, 50));
    }
}
