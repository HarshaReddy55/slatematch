//! SlateMatch matching kernel - pure functions, no mutation of inputs.
//! Semantics mirror the Python enumeration reference (rust_bridge.py):
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

/// Subset enumeration over the candidates. The old DP over cents
/// allocated one state per cent of the target - at the engine's
/// $250,000 gate that is 25,000,000 states, each carrying a selection
/// vector - to choose among at most 18 invoices. Enumeration is 2^n
/// in the candidate count and independent of the amount: each subset's
/// sum and score are accumulated from its lowest set bit. Selection
/// rule, shared verbatim with the Python reference: maximise (sum,
/// then score); break exact ties by fewer invoices, then by the
/// lexicographically smaller selected-id list. Bounded to 20
/// candidates (the engine gates at 18); beyond the bound the kernel
/// declines with an empty selection rather than allocating 2^n states.
pub fn best_subset(target_cents: i64, invoices: &[KernelInvoice], age_weight_milli: i64) -> KernelResult {
    let cap = target_cents.max(0);
    let items: Vec<&KernelInvoice> = invoices.iter()
        .filter(|inv| inv.gross_cents > 0 && inv.gross_cents <= cap)
        .collect();
    let n = items.len();
    if n > 20 {
        return KernelResult { selected_ids: vec![], selected_sum_cents: 0,
                              residual_cents: target_cents, score_milli: 0 };
    }
    let size = 1usize << n;
    let mut sums = vec![0i64; size];
    let mut scores = vec![0i64; size];
    let mut counts = vec![0u32; size];
    for mask in 1..size {
        let bit = mask.trailing_zeros() as usize;
        let prev = mask ^ (1usize << bit);
        sums[mask] = sums[prev] + items[bit].gross_cents;
        scores[mask] = scores[prev] + 1000 + items[bit].age_days * age_weight_milli;
        counts[mask] = counts[prev] + 1;
    }
    fn ids_of(items: &[&KernelInvoice], mask: usize) -> Vec<String> {
        items.iter().enumerate()
            .filter(|(b, _)| mask >> b & 1 == 1)
            .map(|(_, inv)| inv.invoice_id.clone()).collect()
    }
    let mut best = 0usize;
    for mask in 1..size {
        if sums[mask] > cap { continue; }
        let better = (sums[mask], scores[mask]) > (sums[best], scores[best])
            || ((sums[mask], scores[mask]) == (sums[best], scores[best])
                && (counts[mask] < counts[best]
                    || (counts[mask] == counts[best]
                        && ids_of(&items, mask) < ids_of(&items, best))));
        if better { best = mask; }
    }
    KernelResult {
        selected_ids: ids_of(&items, best),
        selected_sum_cents: sums[best],
        residual_cents: target_cents - sums[best],
        score_milli: scores[best],
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
