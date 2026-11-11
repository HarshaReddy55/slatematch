//! CLI bridge: reads one JSON object on stdin:
//! {"target_cents": int, "age_weight_milli": int,
//!  "invoices": [{"invoice_id": str, "gross_cents": int, "age_days": int}]}
//! Writes one JSON object: {"selected_ids": [...], "selected_sum_cents": int,
//! "residual_cents": int, "score_milli": int}
use slatematch_kernel::{best_subset, KernelInvoice};
use serde::Deserialize;
use std::io::Read;

#[derive(Deserialize)]
struct Req {
    target_cents: i64,
    age_weight_milli: i64,
    invoices: Vec<InvIn>,
}
#[derive(Deserialize)]
struct InvIn { invoice_id: String, gross_cents: i64, age_days: i64 }

fn main() {
    let mut buf = String::new();
    std::io::stdin().read_to_string(&mut buf).unwrap();
    let req: Req = serde_json::from_str(&buf).unwrap();
    let invs: Vec<KernelInvoice> = req.invoices.iter().map(|i| KernelInvoice {
        invoice_id: i.invoice_id.clone(), gross_cents: i.gross_cents, age_days: i.age_days,
    }).collect();
    let r = best_subset(req.target_cents, &invs, req.age_weight_milli);
    println!("{}", serde_json::json!({
        "selected_ids": r.selected_ids,
        "selected_sum_cents": r.selected_sum_cents,
        "residual_cents": r.residual_cents,
        "score_milli": r.score_milli,
    }));
}
