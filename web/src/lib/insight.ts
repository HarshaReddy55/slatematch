import type { MatchRecord, RunSummary } from "./api";

/* Stage 2 (Insight views) figures, computed with exactly the vanilla
   rules. Sources: frontend/js/insight.js (loadLedger, loadForecast,
   fcDrill, fcWhatif, loadEval, loadHealth, loadDiag),
   frontend/js/assist.js (renderCube, renderFcDisputes, loadAudit),
   frontend/js/operate.js (caseRunData, gradeHtml, normalisedStored).
   If a number here ever disagrees with the vanilla view on the same
   workspace, that is a bug in this file. The full audit is in
   ~/workspace/slatematch-stage2/AUDIT.md. */

/* ---------------- shared types ---------------- */

export interface Invoice {
  invoice_id: string;
  customer: string;
  subsidiary?: string;
  po_number?: string;
  gross_cents: number;
  discount_rate?: number;
  age_days: number;
  due_in_days: number;
  partial?: { applied_cents: number; original_cents: number } | null;
}

export interface PaymentStaged {
  payment_id: string;
  payer_raw: string;
  amount_cents: number;
  references?: string[];
  remittance_text?: string;
}

export interface WorkspaceFull {
  run_status?: string;
  staged_payments?: number;
  staged_payment_total_cents?: number;
  open_invoices?: number;
  open_invoice_total_cents?: number;
  all_payments?: PaymentStaged[];
  pending_payments?: PaymentStaged[];
  latest_run?: RunSummary | null;
  case?: CaseMeta | null;
}

export interface CaseExpect {
  status?: string;
  auto_posted?: boolean;
  invoices?: string[];
  residual_cents?: number;
  deduction_action?: string;
  erp_reason_code?: string;
  spike?: boolean;
}

export interface CaseMeta {
  id?: string;
  name: string;
  expect?: Record<string, CaseExpect>;
  expect_exceptions?: Record<string, string>;
  policy_note?: string;
}

/* ---------------- Ledger ---------------- */

export interface LedgerKpis {
  count: number;
  totalCents: number;
  overdueCents: number;
}

export function ledgerKpis(inv: Invoice[]): LedgerKpis {
  return {
    count: inv.length,
    totalCents: inv.reduce((a, i) => a + i.gross_cents, 0),
    overdueCents: inv
      .filter((i) => i.due_in_days < 0)
      .reduce((a, i) => a + i.gross_cents, 0),
  };
}

export interface CubeRow {
  customer: string;
  n: number;
  total: number;
  over: number;
}

/** renderCube(): group by customer, sort by open AR descending. */
export function cubeRows(inv: Invoice[]): CubeRow[] {
  const by: Record<string, CubeRow> = {};
  inv.forEach((i) => {
    const b = (by[i.customer] = by[i.customer] || {
      customer: i.customer,
      n: 0,
      total: 0,
      over: 0,
    });
    b.n++;
    b.total += i.gross_cents;
    if (i.due_in_days < 0) b.over += i.gross_cents;
  });
  return Object.values(by).sort((a, b) => b.total - a.total);
}

/* ---------------- Forecast ---------------- */

export interface ForecastInvoice {
  invoice_id: string;
  customer: string;
  gross_cents: number;
  due_in_days: number;
  predicted_delay_days: number;
  expected_in_days: number;
  expected_week: number | null;
  prob_within_30: number;
  prob_within_horizon: number;
}

export interface ForecastWeek {
  week: number;
  p10_cents: number;
  p50_cents: number;
  p90_cents: number;
  cumulative_p50_cents: number;
  invoice_ids: string[];
}

export interface ForecastCustomer {
  customer: string;
  invoices: number;
  open_cents: number;
  overdue_cents: number;
  expected_30_cents: number;
  expected_horizon_cents: number;
  avg_predicted_delay_days: number;
}

export interface ForecastData {
  state?: string;
  weeks?: ForecastWeek[];
  invoices?: ForecastInvoice[];
  customers?: ForecastCustomer[];
  summary?: {
    open_ar_cents: number;
    expected_30_cents: number;
    expected_horizon_cents: number;
    at_risk_cents: number;
    at_risk_count: number;
  } | null;
  beyond?: { count: number; cents: number; invoice_ids: string[] };
  horizon_days?: number;
}

export interface CollectionRow {
  invoice_id: string;
  customer: string;
  gross_cents: number;
  overdue_days: number;
  predicted_delay_days: number;
  priority_score: number;
}

/** The vanilla fan-chart geometry, point for point. */
export function fanChart(f: ForecastData) {
  const weeks = f.weeks || [];
  const max = Math.max(...weeks.map((w) => w.p90_cents), 1);
  const step = (640 - 92) / Math.max(weeks.length - 1, 1);
  const X = (i: number) => 46 + i * step;
  const Y = (v: number) => 190 - (v / max) * 160;
  const pts = weeks.map((w, i) => [X(i), Y(w.p50_cents)] as const);
  const top = weeks.map((w, i) => `${X(i)},${Y(w.p90_cents)}`);
  const bot = weeks
    .slice()
    .reverse()
    .map((w2) => {
      const i = weeks.indexOf(w2);
      return `${X(i)},${Y(w2.p10_cents)}`;
    });
  return {
    band: top.concat(bot).join(" "),
    line: pts.map((p) => p.join(",")).join(" "),
    pts,
  };
}

/** fcDrill(): filter by expected week (0 = beyond horizon), sort by
    expected_in_days ascending. */
export function drillRows(f: ForecastData, w: number): ForecastInvoice[] {
  return (f.invoices || [])
    .filter((d) => (w === 0 ? d.expected_week === null : d.expected_week === w))
    .sort((a, b) => a.expected_in_days - b.expected_in_days);
}

/** The what-if delta formatter: sign, money of the absolute value,
    trailing ".00" stripped. */
export function fmtDelta(v: number, money: (c: number) => string): string {
  return (v > 0 ? "+" : v < 0 ? "-" : "") + money(Math.abs(v)).replace(".00", "");
}

export interface WhatifWeek {
  week: number;
  base_p50_cents: number;
  shifted_p50_cents: number;
}

export interface WhatifResult {
  customer: string;
  shift_days: number;
  delta_30_cents: number;
  delta_cents: number;
  shifted_expected_30_cents: number;
  shifted_expected_horizon_cents: number;
  weeks: WhatifWeek[];
}

/** renderFcDisputes(): dispute claims from a run's matches, sorted by
    expected recovery descending. */
export interface DisputeClaim {
  payment_id: string;
  payer: string;
  claimed_cents: number;
  reason: string;
  win_probability: number;
  expected_recovery_usd: number;
}

interface DeductionFull {
  autonomous_action?: string;
  expected_recovery_value_usd?: number;
  payer?: string;
  claimed_cents?: number;
  assigned_erp_reason_code?: string;
  classification?: { label?: string };
  win_probability?: number;
}

export function disputeClaims(matches: MatchRecord[]): DisputeClaim[] {
  return matches
    .map((m) => ({
      m,
      d: (m.result || {}).deduction as DeductionFull | undefined,
    }))
    .filter((x) => x.d && x.d.autonomous_action === "AUTO_GENERATE_DISPUTE_CLAIM")
    .sort(
      (a, b) =>
        Number(b.d!.expected_recovery_value_usd || 0) -
        Number(a.d!.expected_recovery_value_usd || 0)
    )
    .map(({ m, d }) => ({
      payment_id: m.payment_id,
      payer: d!.payer || "",
      claimed_cents: d!.claimed_cents || 0,
      reason: `${d!.assigned_erp_reason_code || ""} - ${(d!.classification || {}).label || "deduction"}`,
      win_probability: d!.win_probability as number,
      expected_recovery_usd: Number(d!.expected_recovery_value_usd || 0),
    }));
}

/* ---------------- Evaluations ---------------- */

export interface EvalData {
  milp_accuracy: number;
  greedy_accuracy: number;
  milp_exact_rate: number;
  basis?: string;
  cases: {
    payment_id: string;
    expected: string[];
    milp_got: string[];
    milp_residual_cents: number;
    milp_correct: boolean;
    greedy_correct: boolean;
  }[];
}

export interface ScenarioPack {
  id: string;
  title?: string;
}

export interface ScenarioRun {
  all_pass: boolean;
  checks: { pass: boolean }[];
}

export interface NormalisedMatch {
  payment_id: string;
  status?: string;
  auto_posted?: boolean;
  lines: { invoice_id?: string }[];
  residual_cents: number;
  deduction?: unknown;
}

/** normalisedStored() from operate.js. */
export function normalisedStored(m: MatchRecord[]): NormalisedMatch[] {
  return m.map((mm) => {
    const r = mm.result || {};
    return {
      payment_id: mm.payment_id,
      status: r.status,
      auto_posted: r.auto_posted,
      lines: r.lines || [],
      residual_cents: mm.residual_cents,
      deduction: r.deduction,
    } as NormalisedMatch;
  });
}

export interface GradeRow {
  label: string;
  expected: string;
  actual: string;
  pass: boolean;
}

export interface GradeResult {
  rows: GradeRow[];
  allPass: boolean;
}

/** gradeHtml()'s check logic, value for value (JSON.stringify
    equality, exactly as vanilla). */
export function gradeCase(
  c: CaseMeta,
  results: NormalisedMatch[],
  exceptions: { payment_id: string; kind: string }[]
): GradeResult {
  const byPid: Record<string, NormalisedMatch> = {};
  results.forEach((r) => (byPid[r.payment_id] = r));
  const exByPid: Record<string, string> = {};
  (exceptions || []).forEach((e) => (exByPid[e.payment_id] = e.kind));
  const rows: GradeRow[] = [];
  let allPass = true;
  const chk = (label: string, exp: unknown, act: unknown) => {
    const pass = JSON.stringify(exp) === JSON.stringify(act);
    if (!pass) allPass = false;
    rows.push({
      label,
      expected: JSON.stringify(exp),
      actual: JSON.stringify(act),
      pass,
    });
  };
  for (const [pid, exp] of Object.entries(c.expect || {})) {
    const r = byPid[pid] || ({} as NormalisedMatch);
    if ("status" in exp) chk(`${pid} status`, exp.status, r.status);
    if ("auto_posted" in exp) chk(`${pid} auto-posted`, exp.auto_posted, r.auto_posted);
    if ("invoices" in exp)
      chk(
        `${pid} matched invoices`,
        [...(exp.invoices || [])].sort(),
        (r.lines || []).map((l) => l.invoice_id).sort()
      );
    if ("residual_cents" in exp) chk(`${pid} residual`, exp.residual_cents, r.residual_cents);
    if ("deduction_action" in exp) {
      const ded = (r.deduction || {}) as {
        autonomous_action?: string;
        assigned_erp_reason_code?: string;
        is_anomalous_spike?: boolean;
      };
      chk(`${pid} deduction decision`, exp.deduction_action, ded.autonomous_action);
      chk(`${pid} ERP reason code`, exp.erp_reason_code, ded.assigned_erp_reason_code);
    }
    if ("spike" in exp) {
      const ded = (r.deduction || {}) as { is_anomalous_spike?: boolean };
      chk(`${pid} anomaly spike flagged`, exp.spike, ded.is_anomalous_spike);
    }
  }
  for (const [pid, kind] of Object.entries(c.expect_exceptions || {}))
    chk(`${pid} flagged ${kind}`, kind, exByPid[pid]);
  return { rows, allPass };
}

/* ---------------- Agent Health ---------------- */

export interface HealthFull {
  status: string;
  auth: string;
  data_dir: string;
  gemini_configured: boolean;
  gemini_last_error?: string | null;
  model_metrics?: {
    delay_mae_days?: number;
    delay_baseline_mae_days?: number;
    validity_auc?: number;
    train_rows?: number;
    test_rows?: number;
    data_basis?: string;
  };
}

export interface ReadyData {
  ready: boolean;
  checks: Record<string, string>;
}

export interface Diagnostics {
  rust_kernel: {
    present: boolean;
    equivalence_suite: string;
    equivalence_probe: { status: string; agree: number; cases: number };
  };
  milp: { solver: string; exact_recheck: string };
  test_suite: { module_count: number; ci: string };
}

/** The loadDiag() probe sentence. */
export function probeText(d: Diagnostics): string {
  const p = d.rust_kernel.equivalence_probe;
  return p.status === "pass"
    ? `Live probe on this server just now: ${p.agree} of ${p.cases} cases agree exactly with the Python reference`
    : p.status === "fail"
      ? `Live probe: ${p.agree} of ${p.cases} cases agree - investigate`
      : "Skipped on this server - the kernel binary is not present here, so the Python reference path is serving (same results, slower)";
}

/** MAE improvement percentage, as loadHealth() computes it. */
export function maeImprovement(m: HealthFull["model_metrics"]): string {
  if (!m || !m.delay_baseline_mae_days) return "-";
  return (
    ((m.delay_baseline_mae_days - (m.delay_mae_days || 0)) /
      m.delay_baseline_mae_days) *
    100
  ).toFixed(0);
}

export interface AuditEntry {
  created_at: string;
  actor: string;
  action: string;
  entity: string;
  entity_id: string;
  payload: unknown;
}

/* Status Bars (Obsidian shortlist, built natively): one bar per run,
   chronological. Colour rule from the core parity note, using only
   run-record fields: a run that failed or did not complete is down
   (bad); a completed run with held items or exceptions is degraded
   (warn); a completed run with no held items and no exceptions is up
   (ok). Held items are the run's PROPOSED matches, counted from that
   run's own matches payload, the same classification the vanilla Run
   view uses. No incident text is invented: the tooltip and detail
   line carry only fields present in the run and matches payloads. */

export type BarOutcome = "ok" | "warn" | "bad";

/** Held items in one run: matches still PROPOSED (solved, waiting for
    a person's sign-off). */
export function heldCount(matches: MatchRecord[]): number {
  return matches.filter((m) => m.status === "PROPOSED").length;
}

export function barOutcome(r: RunSummary, held = 0): BarOutcome {
  if (r.status && r.status !== "COMPLETED") return "bad";
  if (held > 0 || (r.exceptions || 0) > 0) return "warn";
  return "ok";
}

export function runResolutionPct(r: RunSummary): number | null {
  return r.payments ? ((r.matches || 0) / r.payments) * 100 : null;
}

/** Share of runs that are up (completed, no held, no exceptions). */
export function cleanRunShare(
  runs: RunSummary[],
  heldByRun: Record<string, number> = {}
): number | null {
  if (!runs.length) return null;
  const clean = runs.filter(
    (r) => barOutcome(r, heldByRun[r.run_id] || 0) === "ok"
  ).length;
  return (clean / runs.length) * 100;
}
