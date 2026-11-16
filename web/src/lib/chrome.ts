import { useEffect, useRef } from "react";
import { api, authHeaders, type MatchRecord } from "./api";
import type { WorkspaceOperate } from "./operate";

/* Stage 4 (Chrome) shared logic, ported from the vanilla state.js /
   assist.js with the same rules. If a string or number here ever
   disagrees with the vanilla shell on the same workspace, that is a
   bug in this file. Sources are named per section. */

/** The run sub-resources answer with a bare array; normalise the
    wrapped shape too, as the Dashboard loader already does. */
export function asArray<T>(d: T[] | Record<string, unknown>, key: string): T[] {
  if (Array.isArray(d)) return d;
  const v = (d as Record<string, unknown>)[key];
  return Array.isArray(v) ? (v as T[]) : [];
}

/* ---------------- workspace (state.js renderCasebar) ---------------- */

export interface CaseInfo {
  id: string;
  name: string;
  source?: string;
  loaded_at?: string;
  story?: string;
}

export interface WorkspaceFull extends WorkspaceOperate {
  open_invoices?: number;
  open_invoice_total_cents?: number;
  approvals_pending?: number;
  case?: CaseInfo | null;
  latest_run?: {
    run_id: string;
    status?: string;
    payments?: number;
    auto_posted?: number;
  } | null;
}

export function fmtLoadedAt(iso?: string): string {
  return (iso || "").slice(0, 16).replace("T", " ");
}

/** Ask every shell surface that shows workspace state to refresh.
    force = the workspace was authoritatively replaced (reset,
    restore, reseed): listeners must not apply stale-read guards
    to the replacement snapshot. */
export function requestShellRefresh(force = false) {
  try {
    window.dispatchEvent(
      new CustomEvent("slate:ws-refresh", { detail: { force } })
    );
  } catch {
    /* never a blocker */
  }
}

/** Stage 6 (Item 1): the view-side half of the refresh contract.
    Vanilla never lets a mounted page keep a replaced workspace's
    figures: loadCase blanks every run surface synchronously and
    the WS_GEN guard makes each loader re-read. React views load
    once on mount, so until this hook existed a case switched from
    the casebar left the PREVIOUS case's run figures standing on
    the Dashboard of the new, merely-staged case - Harsha's
    "selecting case itself is running the data". Every view that
    reads workspace or run state subscribes its loader here; the
    shell dispatchers (casebar switch / reset / save, palette,
    session restore) already fire the event. */
export function useWsRefresh(load: () => void, onForce?: () => void) {
  const forceRef = useRef(onForce);
  forceRef.current = onForce;
  useEffect(() => {
    const on = (e: Event) => {
      /* A forced refresh means the workspace was authoritatively
         REPLACED (case switch, restore, reseed): the old figures
         must leave the screen synchronously, as vanilla's loadCase
         blanks run surfaces, instead of flashing stale numbers
         until the reload lands (owner + live-pass defect, 16 Nov
         2026). Ordinary refreshes keep stale-while-revalidate. */
      if ((e as CustomEvent).detail?.force && forceRef.current)
        forceRef.current();
      load();
    };
    window.addEventListener("slate:ws-refresh", on);
    return () => window.removeEventListener("slate:ws-refresh", on);
  }, [load]);
}

/* ---------------- case brief (state.js briefOutcome +
   fillBriefMini) ----------------

   Stage 6: the brief computation moved to lib/brief.ts, which
   ports briefOutcome in full (verdict, cash, recovery, held -
   every figure the brief renders), and the brief itself is
   ui/CaseBrief.tsx. The Stage 4 verdict-only port that lived
   here fed the casebar's verdict strip; Stage 6 removes that
   strip (vanilla's casebar carries no verdict - the brief panel
   under it carries the verdict in both its modes), so nothing
   consumes a verdict-only computation any more. copilotSuggestions
   below still uses the ExceptionRow shape; it is declared there. */

/* ---------------- exports (state.js downloadExport) ---------------- */

export async function downloadExport(
  path: string,
  fname: string
): Promise<{ ok: boolean; message: string }> {
  try {
    const r = await fetch(path, { headers: authHeaders() });
    if (!r.ok)
      throw new Error(
        `Export failed (${r.status}) - run a case first, then export`
      );
    const b = await r.blob();
    const u = URL.createObjectURL(b);
    const a = document.createElement("a");
    a.href = u;
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 4000);
    return { ok: true, message: "Downloaded " + fname };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/* ---------------- Copilot (assist.js renderSuggestions + ask) -------- */

interface ExceptionRow {
  payment_id: string;
  kind: string;
}

export interface CopilotReply {
  answer: string;
  citations: string[];
  action?: unknown;
}

/** Suggested questions built from the CURRENT workspace data, ported
    line for line from renderSuggestions (same questions, same order,
    capped at 5). */
export async function copilotSuggestions(): Promise<string[]> {
  const qs: string[] = [];
  try {
    const ws = await api<WorkspaceFull>("/api/v1/workspace");
    const runs = await api<{ run_id: string }[]>("/api/v1/runs");
    if (runs.length) {
      const rid = runs[0].run_id;
      const [msRaw, xsRaw] = await Promise.all([
        api<MatchRecord[] | Record<string, unknown>>(`/api/v1/runs/${rid}/matches`),
        api<ExceptionRow[] | Record<string, unknown>>(`/api/v1/runs/${rid}/exceptions`),
      ]);
      const ms = asArray<MatchRecord>(msRaw, "matches");
      const xs = asArray<ExceptionRow>(xsRaw, "exceptions");
      const nm = xs.find((e) => e.kind === "NO_MATCH");
      if (nm) qs.push(`Why was ${nm.payment_id} not matched?`);
      const held = ms.find(
        (m) => m.status !== "AUTO_POSTED" && (m.result || {}).status !== "NO_MATCH"
      );
      if (held) qs.push(`Why was ${held.payment_id} held for approval?`);
      if (
        ms.some(
          (m) =>
            ((m.result || {}).deduction || {}).autonomous_action ===
            "AUTO_GENERATE_DISPUTE_CLAIM"
        )
      )
        qs.push("How much recovery is expected from the disputes?");
      if (xs.length) qs.push("Show exceptions");
      qs.push("What is the touchless rate?");
    } else {
      if (ws && ws.case) qs.push("What is in this workspace?");
      const inv = await api<{ due_in_days: number }[]>("/api/v1/invoices");
      if (inv.some((i) => i.due_in_days < 0))
        qs.push("Which invoices are overdue?");
    }
    qs.push("Which solver is more accurate?");
  } catch {
    qs.push("What is in this workspace?", "Which solver is more accurate?");
  }
  return qs.slice(0, 5);
}

/** One fact per line: split an answer on sentence boundaries. The
    lookbehind requires a full stop immediately before the space, so
    decimals and amounts ($4,850.00, 75.0%) never split. */
export function splitFacts(answer: string): string[] {
  return (answer || "")
    .split(/(?<=\.)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/* ---------------- command palette (assist.js cmdkFuzzy) -------------- */

export interface FuzzyMatch {
  score: number;
  pos: number[];
}

/** Subsequence matcher with word-start and streak bonuses, ported
    exactly from cmdkFuzzy. Returns null when the query is not a
    subsequence of the label. */
export function cmdkFuzzy(q: string, label: string): FuzzyMatch | null {
  const query = q.toLowerCase();
  const s = label.toLowerCase();
  if (s.includes(query)) {
    const at = s.indexOf(query);
    return {
      score: 1000 - query.length * 2 - at,
      pos: [...query].map((_, i) => at + i),
    };
  }
  let qi = 0;
  let score = 0;
  let streak = 0;
  const pos: number[] = [];
  for (let i = 0; i < s.length && qi < query.length; i++) {
    if (s[i] === query[qi]) {
      pos.push(i);
      streak++;
      score += 1 + streak * 2 + (i === 0 || s[i - 1] === " " ? 4 : 0);
      qi++;
    } else streak = 0;
  }
  return qi === query.length ? { score, pos } : null;
}

/* ---------------- sessions (assist.js save/restore/loadSaves) -------- */

export interface SaveCounts {
  invoices: number;
  payments: number;
  runs: number;
  matches?: number;
}

export interface SaveRow {
  save_id: string;
  saved_at?: string;
  label?: string;
  counts?: SaveCounts;
}

export function fmtSavedAt(iso?: string): string {
  return (iso || "").slice(0, 16).replace("T", " ");
}

export function countsLine(c: SaveCounts): string {
  return `${c.invoices} invoices, ${c.payments} payments, ${c.runs} runs${
    c.matches != null ? `, ${c.matches} matches` : ""
  }`;
}
