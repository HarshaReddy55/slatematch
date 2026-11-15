import { api, type MatchRecord } from "./api";
import type { CaseMeta } from "./insight";

/* Stage 3 (Operate core) figures and payload shapes, ported from the
   vanilla operate.js / assist.js / state.js / insight.js with the
   same rules. If a number here ever disagrees with the vanilla view
   on the same workspace, that is a bug in this file. Sources are
   named per section. */

/* ---------------- shared navigation ---------------- */

/** Switch the shell view (hash routing in App.tsx). */
export function goView(key: string) {
  if (window.location.hash !== `#/${key}`) window.location.hash = `/${key}`;
}

/** One-shot intents across views, the React equivalent of vanilla's
    go() + setTimeout calls (executeActiveCase, openChaseFor). */
export function setIntent(key: string, value: string) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* private mode: the intent is a nicety, never a blocker */
  }
}
export function takeIntent(key: string): string | null {
  try {
    const v = sessionStorage.getItem(key);
    if (v) sessionStorage.removeItem(key);
    return v;
  } catch {
    return null;
  }
}

/* ---------------- workspace payments ---------------- */

export interface PaymentFull {
  payment_id: string;
  payer_raw: string;
  amount_cents: number;
  references?: string[];
  claimed_deduction_cents?: number;
  deduction_reason_raw?: string;
  pod_verified_clean?: boolean;
  remittance_text?: string;
}

export interface WorkspaceOperate {
  run_status?: string;
  staged_payments?: number;
  staged_payment_total_cents?: number;
  open_invoices?: number;
  open_invoice_total_cents?: number;
  pending_payments?: PaymentFull[];
  all_payments?: PaymentFull[];
  approvals_pending?: number;
  latest_run?: { run_id: string; payments?: number; auto_posted?: number } | null;
  case?: CaseMeta | null;
}

/* ---------------- runs, matches, exceptions ---------------- */

export interface MatchLineFull {
  invoice_id: string;
  gross_cents: number;
  discount_cents: number;
  net_cents: number;
}

export interface DeductionFull {
  classification?: { label?: string };
  assigned_erp_reason_code?: string;
  z_score?: number;
  win_probability?: number | null;
  expected_recovery_value_usd?: number;
  autonomous_action?: string;
  win_probability_basis?: string;
  note?: string;
  derivation?: string[];
  claimed_cents?: number;
  payer?: string;
  is_anomalous_spike?: boolean;
}

export interface DerivationData {
  equation?: {
    net_applied_cents?: number;
    deduction_applied_cents?: number;
    residual_cents?: number;
    payment_cents?: number;
    balances?: boolean;
  };
  candidates_considered?: number;
  objective_total?: number;
  objective_terms?: { term: string; formula: string; value: number }[];
  confidence_derivation?: { base?: number; base_rule?: string };
  greedy_comparison?: {
    invoices?: string[];
    residual_cents?: number;
    status?: string;
    reading?: string;
  };
}

export interface ReasoningData {
  steps?: string[];
  rejections?: { text: string; invoice_id?: string; amount_cents?: number }[];
  close_calls?: { text: string }[];
}

export interface StoredMatch extends MatchRecord {
  solver?: string;
  confidence?: number;
  result?: MatchRecord["result"] & {
    lines?: MatchLineFull[];
    matched_by?: string;
    solver?: string;
    deduction_applied?: boolean;
    deduction?: DeductionFull;
    derivation?: DerivationData;
    reasoning?: ReasoningData;
    payment?: PaymentFull;
    approval?: { erp_document_id?: string };
  };
}

export interface BatchResultItem {
  payment_id: string;
  status: string;
  matched_by?: string;
  lines: MatchLineFull[];
  residual_cents: number;
  confidence: number;
  auto_posted: boolean;
  latency_ms?: number;
  deduction?: DeductionFull;
  derivation?: DerivationData;
  reasoning?: ReasoningData;
}

export interface RunException {
  payment_id: string;
  kind: string;
  severity: string;
  recommended_action: string;
  detail?: { payer?: string; amount_cents?: number };
}

export interface BatchResponse {
  run_id: string;
  payments: number;
  auto_posted: number;
  touchless_rate: number;
  results: BatchResultItem[];
  exceptions: RunException[];
}

/** runClassify() from operate.js: 0 auto-posted, 1 held for a
    person, 2 needs investigation. */
export function runClassify(it: {
  auto_posted?: boolean;
  status?: string;
}): 0 | 1 | 2 {
  if (it.auto_posted === true || it.status === "AUTO_POSTED") return 0;
  if (
    it.status === "PROPOSED" ||
    it.status === "OPTIMAL_EXACT_MATCH" ||
    it.status === "PARTIAL_MATCH"
  )
    return 1;
  return 2;
}

export const CHART_COLS = ["#34bf71", "#f2c14e", "#e5484d"];
export const CHART_LABELS = [
  "Auto-posted",
  "Held for a person",
  "Needs investigation",
];

/** runChartHtml()'s geometry, point for point: cumulative step paths
    over the run's items in order, 600x116 viewBox. */
export function runChartGeometry(
  items: { auto_posted?: boolean; status?: string }[]
) {
  const W = 600,
    H = 116,
    PL = 4,
    PR = 6,
    PT = 10,
    PB = 8,
    n = items.length;
  const cum: number[][] = [[0, 0, 0]];
  const cur = [0, 0, 0];
  items.forEach((it) => {
    cur[runClassify(it)]++;
    cum.push([...cur]);
  });
  const maxY = Math.max(1, ...cur);
  const X = (i: number) => PL + ((W - PL - PR) * i) / n;
  const Y = (v: number) => H - PB - (v / maxY) * (H - PT - PB);
  const step = (c: number) =>
    cum
      .map((v, i) =>
        i === 0
          ? `M${X(0).toFixed(1)} ${Y(v[c]).toFixed(1)}`
          : `H${X(i).toFixed(1)} V${Y(v[c]).toFixed(1)}`
      )
      .join(" ");
  const series = [0, 1, 2].map((c) => {
    const d = step(c);
    const fill = `${d} L${X(n).toFixed(1)} ${Y(0).toFixed(1)} L${X(0).toFixed(1)} ${Y(0).toFixed(1)} Z`;
    return { d, fill, endX: X(n), endY: Y(cur[c]), count: cur[c] };
  });
  const grid = [0.25, 0.5, 0.75].map((f) => Y(maxY * f));
  return { series, grid, W, H };
}

/** outcomeBarHtml(): share of the wire explained by allocated cash. */
export function outcomeShare(alloc: number, resid: number): number {
  const total = Math.abs(alloc) + Math.abs(resid || 0);
  return total > 0 ? Math.max(0, Math.min(1, Math.abs(alloc) / total)) : 0;
}

/* ---------------- grading without an answer key ---------------- */

export interface InvariantRow {
  payment_id: string;
  alloc: number;
  ded: number;
  residual: number;
  wire: number;
  holds: boolean;
}

/** invariantGradeHtml(): allocated + claimed deduction + residual
    must equal the wire amount, payment by payment. */
export function invariantGrade(
  results: {
    payment_id: string;
    lines?: { net_cents: number }[];
    residual_cents: number;
    payment?: PaymentFull | null;
  }[],
  payments: PaymentFull[]
): { rows: InvariantRow[]; pass: number } {
  let pass = 0;
  const rows = results.map((r) => {
    const p =
      r.payment || payments.find((x) => x.payment_id === r.payment_id) || null;
    const alloc = (r.lines || []).reduce((a, l) => a + l.net_cents, 0);
    const ded = p?.claimed_deduction_cents || 0;
    const total = alloc + ded + (r.residual_cents || 0);
    const wire = p?.amount_cents || 0;
    const holds = wire > 0 && total === wire;
    if (holds) pass++;
    return {
      payment_id: r.payment_id,
      alloc,
      ded,
      residual: r.residual_cents || 0,
      wire,
      holds,
    };
  });
  return { rows, pass };
}

/* ---------------- agents ---------------- */

export interface AgentRecord {
  agent: string;
  status: string;
  latency_ms: number;
  evidence: Record<string, unknown>;
}

export const AGENT_SHORT: Record<string, string> = {
  "Capture Agent": "Capture",
  "Linking Agent": "Linking",
  "Matching Agent": "Matching",
  "Deduction Agent": "Deduction",
  "Policy Agent": "Policy",
  "Briefing Agent": "Briefing",
};

/** renderAgentPipe()'s per-agent evidence line. */
export function agentCountLine(a: AgentRecord): string {
  const e = a.evidence || {};
  const v = (k: string) => (e[k] ?? "-") as string | number;
  if (a.agent === "Capture Agent") return `${v("payments_received")} wires in`;
  if (a.agent === "Linking Agent") return `${v("candidates_total")} candidates`;
  if (a.agent === "Matching Agent") return `${v("payments_solved")} wires solved`;
  if (a.agent === "Deduction Agent") return `${v("claims_judged")} claims judged`;
  if (a.agent === "Policy Agent")
    return `${v("auto_posted")} auto-posted, ${e.held_for_approval ?? e.proposed_for_review ?? "-"} held`;
  if (a.agent === "Briefing Agent")
    return `${v("settlement_drafts_recorded")} drafts composed`;
  return "";
}

export const AGENT_ALGORITHMS: [string, string, string][] = [
  [
    "Capture Agent",
    "LLM extraction (Gemini when keyed) + deterministic fallback, then a ledger verifier",
    "References verified, zero invented",
  ],
  [
    "Linking Agent",
    "Exact references, PO match, OCR repair, amount-plus-payer, Jaro-Winkler fuzzy (0.88), whole-ledger fallback",
    "Payments linked to the right customer",
  ],
  [
    "Matching Agent",
    "MILP under a cash conservation equation (HiGHS), Rust subset-sum kernel",
    "Exact-match rate, residual zero",
  ],
  [
    "Deduction Agent",
    "Reason-code classification + z-score anomaly detection",
    "Spikes caught, codes assigned",
  ],
  [
    "Policy Agent",
    "Expected-value dispute rule, maker-checker thresholds, tolerance write-off",
    "Nothing posts past policy",
  ],
  [
    "Briefing Agent",
    "Grounded generation over run records (Gemini when keyed)",
    "Every run ends with a brief and next actions",
  ],
];

export interface BriefData {
  headline: string;
  body?: string[];
  next_actions?: string[];
  source?: string;
}

/* ---------------- approvals ---------------- */

export interface ApprovalEntry {
  match_id: string;
  payment_id: string;
  run_id: string;
  amount_cents: number | null;
  invoices: string[];
  confidence: number;
  decision_reason?: string;
}

export interface DecideResponse {
  status?: string;
  erp_document_id?: string;
  settled_invoices?: string[];
  fingerprint?: string;
}

/* ---------------- ERP documents ---------------- */

export interface JournalLine {
  gl_account: string;
  account: string;
  debit_cents: number;
  credit_cents: number;
}

export interface ErpDocument {
  document_number?: string;
  journal: JournalLine[];
  total_debits_cents: number;
  total_credits_cents: number;
  balanced: boolean;
  bapi_payload: unknown;
  note?: string;
}

export interface ErpDocEntry {
  payment_id: string;
  payer?: string;
  status: string;
  document: ErpDocument;
}

export interface ErpRunDocuments {
  run_id?: string | null;
  documents: ErpDocEntry[];
  totals: { documents: number; debit_cents: number; credit_cents?: number; balanced?: boolean };
  reserve?: {
    claimed_cents: number;
    journals: {
      payment_id: string;
      claimed_cents: number;
      journal: { journal: JournalLine[]; note?: string };
    }[];
  } | null;
}

export interface ErpPaymentDocument {
  document: ErpDocument;
  revrec_accrual?: { note: string; journal: JournalLine[] } | null;
}

export interface GlGroup {
  gl: string;
  name: string;
  dr: number;
  cr: number;
}

/** erpGlTable(): group journal lines by GL account + name, summing
    debits and credits. */
export function glGroups(journal: JournalLine[]): { rows: GlGroup[]; td: number; tc: number } {
  const by: Record<string, GlGroup> = {};
  (journal || []).forEach((l) => {
    const k = l.gl_account + "|" + l.account;
    const g = (by[k] = by[k] || { gl: l.gl_account, name: l.account, dr: 0, cr: 0 });
    g.dr += l.debit_cents;
    g.cr += l.credit_cents;
  });
  const rows = Object.values(by);
  return {
    rows,
    td: rows.reduce((a, r) => a + r.dr, 0),
    tc: rows.reduce((a, r) => a + r.cr, 0),
  };
}

/* ---------------- scenarios ---------------- */

export interface ScenarioFull {
  id: string;
  title: string;
  story: string;
  shows: string;
  invoices: number;
  payments: number;
  customers: number;
  open_cents: number;
  batch_cents: number;
}

export interface ScenarioRunData {
  scenario: { title: string };
  checks: { label: string; expected: unknown; actual: unknown; pass: boolean }[];
  all_pass: boolean;
  run: { run_id: string; payments: number; auto_posted: number; exceptions: unknown[] };
}

/* ---------------- upload + parse ---------------- */

export const SAMPLE_INV = `invoice_id,customer,amount,po_number,discount_rate,age_days,due_in_days
INV-2001,Apex Manufacturing,120.00,PO-11,0,40,-40
INV-2002,Apex Manufacturing,80.00,PO-12,0,5,-5
INV-2003,Apex Manufacturing,200.00,PO-13,0,30,-30
INV-2004,Northwind Traders,1000.00,PO-21,0.02,25,-25`;

export const SAMPLE_PAY = `payment_id,payer,amount,remittance,deduction,deduction_reason
Y1,Apex Manufacturing,200.00,"Wire for INV-2001 and INV-2002",,
Y2,Northwind Traders,930.00,"Northwind Traders wire less 2% discount less deduction",50.00,shortage on delivery`;

export const TPL_INV = "invoice_id,customer,amount,po_number,discount_rate,age_days,due_in_days\n";
export const TPL_PAY = "payment_id,payer,amount,remittance,deduction,deduction_reason\n";

/** The Capture Agent textarea's pre-filled sample, verbatim from
    frontend/index.html. */
export const PARSE_SAMPLE =
  "Hi team, remittance from Apex Manufacturing. Wire of $47,000.00 against INV-1001 and INV 1002. Less deduction $5,000.00 for shortage on delivery. PO-11 referenced.";

export interface ImportResult {
  imported: number;
  mode?: string;
  fingerprint?: string;
  mapping?: Record<string, string>;
  errors?: { row: number; error: string }[];
  route?: string;
  run?: BatchResponse | null;
  fields?: ParseFields;
  verification?: Verification;
  extracted_via?: string;
  staged?: string;
  source?: string;
}

export interface ParseFields {
  payer?: string;
  amount_cents?: number | null;
  deduction_cents?: number | null;
  deduction_reason?: string;
  invoice_refs?: string[];
  po_refs?: string[];
}

export interface Verification {
  verified: boolean;
  issues?: string[];
  unknown_refs?: string[];
}

export interface ParseResult {
  fields: ParseFields;
  verification?: Verification;
  pipeline?: {
    stage: string;
    engine: string;
    ms?: number;
    detail: string;
    issues?: string[];
  }[];
  source?: string;
  degraded?: boolean;
  ai_state?: string;
}

/* ---------------- mail ---------------- */

export interface DisputeItem {
  payment_id: string;
  payer: string;
  claimed_cents: number;
  win_probability: number;
  expected_recovery_usd: number;
  reason_code?: string;
  classification?: string;
  invoices?: string[];
  pod_clean?: boolean;
}

export interface ChaseItem {
  payment_id: string;
  payer?: string;
  amount_cents: number;
  kind: string;
  residual_cents?: number;
  recommended_action?: string;
}

export interface SettlementItem {
  payment_id: string;
  payer: string;
  net_cents: number;
  status: string;
  erp_document_id?: string;
  invoices: { invoice_id: string }[];
  discount_cents?: number;
}

export interface DunningItem {
  invoice_id: string;
  customer: string;
  gross_cents: number;
  due_in_days: number;
  tone?: string;
  tone_label?: string;
}

export interface OutboxMail {
  created_at?: string;
  to: string;
  subject: string;
  kind: string;
  status: string;
  body?: string;
  ref_id?: string;
}

export interface MailHub {
  state: string;
  disputes: DisputeItem[];
  chases: ChaseItem[];
  settlements: SettlementItem[];
  dunning: DunningItem[];
  outbox: OutboxMail[];
  configured: boolean;
  from?: string;
}

export interface DraftResult {
  text?: string;
  body?: string;
  subject?: string;
  tone_label?: string;
  source?: string;
  ai_state?: string;
}

/** aiWhy() from assist.js. */
export function aiWhy(d: { ai_state?: string } | null | undefined): string {
  const s = (d || {}).ai_state;
  return s === "no_key"
    ? "Gemini not configured"
    : s === "call_failed"
      ? "Gemini did not answer"
      : s === "unverified"
        ? "Gemini draft failed the fact check"
        : "grounded template";
}

/** splitSubject() from assist.js. */
export function splitSubject(text: string): { subject: string; body: string } {
  const t = (text || "").trim();
  const m = t.match(/^Subject:\s*(.+)\n\n?/);
  if (m) return { subject: m[1].trim(), body: t.slice(m[0].length).trim() };
  const lines = t.split("\n");
  return { subject: (lines[0] || "").slice(0, 120), body: t };
}

export type MailKind = "dispute_claim" | "chase" | "settlement_confirmation" | "collection_reminder";

export interface SendResult {
  status: string;
}

/** sendMailGeneric()'s request: same endpoint, same payload, same
    status wording at the call site. */
export async function sendMail(
  kind: MailKind,
  refId: string,
  to: string,
  rawText: string,
  presetSubject?: string
): Promise<SendResult> {
  let subject: string, body: string;
  if (presetSubject !== undefined) {
    subject = presetSubject;
    body = rawText;
  } else {
    const s = splitSubject(rawText);
    subject = s.subject;
    body = s.body;
  }
  return api<SendResult>("/api/v1/mail/send", {
    method: "POST",
    body: JSON.stringify({ to: to.trim(), subject, body, kind, ref_id: refId }),
  });
}

export function sendStatusText(status: string): string {
  return status === "sent"
    ? "Sent"
    : status === "failed"
      ? "Send failed - see Outbox"
      : "Recorded - not sent (no mailbox configured)";
}

export function outboxStatusText(status: string): string {
  return status === "sent"
    ? "Sent"
    : status === "failed"
      ? "Failed"
      : status === "draft"
        ? "Draft - generated"
        : "Recorded - not sent";
}

/* ---------------- dispute desk facts ---------------- */

export interface DeskFact {
  payment_id: string;
  payer: string;
  claimed_cents: number;
  reason_code?: string;
  classification_label: string;
  win_probability?: number | null;
  expected_recovery_usd?: number;
  tone: string;
}

export interface ChaseFact {
  payment_id: string;
  payer: string;
  amount_cents: number;
}
