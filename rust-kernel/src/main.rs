//! CLI bridge: reads one JSON object on stdin:
//! {"target_cents": int, "age_weight_milli": int,
//!  "invoices": [{"invoice_id": str, "gross_cents": int, "age_days": int}]}
//! Writes one JSON object: {"selected_ids": [...], "selected_sum_cents": int,
//! "residual_cents": int, "score_milli": int}
//!
//! Malformed input never panics: it prints {"error": "..."} on stdout
//! and exits with status 2, so the caller can fall back cleanly.
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

fn run() -> Result<String, String> {
    let mut buf = String::new();
    std::io::stdin().read_to_string(&mut buf)
        .map_err(|e| format!("stdin read failed: {e}"))?;
    let req: Req = serde_json::from_str(&buf)
        .map_err(|e| format!("invalid request JSON: {e}"))?;
    let invs: Vec<KernelInvoice> = req.invoices.iter().map(|i| KernelInvoice {
        invoice_id: i.invoice_id.clone(), gross_cents: i.gross_cents, age_days: i.age_days,
    }).collect();
    let r = best_subset(req.target_cents, &invs, req.age_weight_milli);
    Ok(serde_json::json!({
        "selected_ids": r.selected_ids,
        "selected_sum_cents": r.selected_sum_cents,
        "residual_cents": r.residual_cents,
        "score_milli": r.score_milli,
    }).to_string())
}

fn main() {
    match run() {
        Ok(out) => println!("{out}"),
        Err(e) => {
            println!("{}", serde_json::json!({"error": e}));
            std::process::exit(2);
        }
    }
}
