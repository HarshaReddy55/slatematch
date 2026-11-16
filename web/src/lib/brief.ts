import { api, type MatchRecord } from "./api";
import { asArray } from "./chrome";

/* Stage 6 (Item 2): the case brief's outcome computation, ported
   line for line from vanilla state.js briefOutcome() (the chrome.ts
   briefVerdict port computes the same merge for the verdict line
   only; this one carries every figure the brief renders). If a
   number here ever disagrees with the vanilla brief on the same
   workspace, that is a bug in this file.

   Case-wide outcome: merge the matches of EVERY run in this
   workspace, one entry per payment, most recent decision wins -
   so a small extra run (one staged wire) adds to the case totals
   instead of replacing them. The cache mirrors vanilla's
   BRIEF_RUN / BRIEF_PROMISE: one computed outcome per latest run
   id, invalidated at the same points vanilla invalidates it
   (case load, reset, restore, tenant switch, run completion,
   approval decisions) - in React those all surface as a
   slate:ws-refresh, and CaseBrief calls invalidateBrief() then. */

export interface BriefOutcome {
  verdictShort: string;
  /** "{total} payments came in: ..." bold paragraph parts. */
  total: number;
  auto: number;
  held: number;
  stoppedLabels: string[];
  /** byPay.size - payments the agent reached a decision on. */
  decided: number;
  /** (decided/total*100).toFixed(1), vanilla's formatting. */
  resPct: string;
  cash: number;
  /** Expected dispute recovery, in dollars (a float, as vanilla). */
  rec: number;
  heldAmt: number;
}

interface ExceptionRow {
  payment_id: string;
  kind: string;
}

const KINDLBL: Record<string, string> = {
  DUPLICATE_PAYMENT: "a duplicate wire",
  NO_MATCH: "no matching invoices",
  UNRESOLVED_RESIDUAL: "an unexplained remainder",
};

let BRIEF_RUN: { run_id: string; data: BriefOutcome } | null = null;
let BRIEF_PROMISE: {
  run_id: string;
  promise: Promise<BriefOutcome | "executing">;
} | null = null;

export function invalidateBrief() {
  BRIEF_RUN = null;
  BRIEF_PROMISE = null;
}

/** The brief outcome for the workspace's latest run. Resolves to
    "executing" while that run is still executing (vanilla shows
    the wait state and caches nothing), or null on a failed read. */
export function briefOutcome(
  runId: string
): Promise<BriefOutcome | "executing" | null> {
  if (BRIEF_RUN && BRIEF_RUN.run_id === runId)
    return Promise.resolve(BRIEF_RUN.data);
  if (!BRIEF_PROMISE || BRIEF_PROMISE.run_id !== runId) {
    BRIEF_PROMISE = {
      run_id: runId,
      promise: (async (): Promise<BriefOutcome | "executing"> => {
        const runs = await api<{ run_id: string; status?: string }[]>(
          "/api/v1/runs"
        );
        const target = runs.find((r) => r.run_id === runId);
        if (target && target.status && target.status !== "COMPLETED") {
          // A run still executing has only some of its matches
          // written. An outcome computed now would present a
          // partial run as the case result - and it would be
          // cached as this run's brief. Show the wait state and
          // cache nothing.
          BRIEF_PROMISE = null;
          return "executing";
        }
        const completed = runs
          .filter((r) => !r.status || r.status === "COMPLETED")
          .reverse()
          .slice(-10);
        const fetched = await Promise.all(
          completed.map(async (run) => {
            const [msRaw, xsRaw] = await Promise.all([
              api<MatchRecord[] | Record<string, unknown>>(
                `/api/v1/runs/${run.run_id}/matches`
              ),
              api<ExceptionRow[] | Record<string, unknown>>(
                `/api/v1/runs/${run.run_id}/exceptions`
              ),
            ]);
            return {
              ms: asArray<MatchRecord>(msRaw, "matches"),
              xs: asArray<ExceptionRow>(xsRaw, "exceptions"),
            };
          })
        );
        const byPay = new Map<string, MatchRecord>();
        const excByPay = new Map<string, ExceptionRow>();
        for (const { ms, xs } of fetched) {
          for (const m of ms) byPay.set(m.payment_id, m);
          for (const x of xs) excByPay.set(x.payment_id, x);
        }
        let cash = 0,
          held = 0,
          heldAmt = 0,
          rec = 0,
          auto = 0;
        for (const m of byPay.values()) {
          const r = m.result || {};
          const eq = (r.derivation || {}).equation || {};
          if (m.status === "AUTO_POSTED" || m.status === "APPROVED_POSTED") {
            auto++;
            cash += (r.lines || []).reduce((a, l) => a + (l.net_cents || 0), 0);
          }
          if (m.status === "PROPOSED") {
            held++;
            heldAmt += eq.payment_cents || 0;
          }
          const d = r.deduction || {};
          if (d.autonomous_action === "AUTO_GENERATE_DISPUTE_CLAIM")
            rec += Number(d.expected_recovery_value_usd || 0);
        }
        const stopped = [...excByPay.entries()].filter(
          ([pid]) => !byPay.has(pid)
        );
        const stoppedLabels = stopped.map(
          ([, x]) => KINDLBL[x.kind] || "an exception"
        );
        const total = new Set([...byPay.keys(), ...excByPay.keys()]).size;
        const decided = byPay.size;
        const data: BriefOutcome = {
          verdictShort: `${total} payments in: ${auto} posted themselves, ${held} waiting for a person${
            stopped.length
              ? `, ${stopped.length} stopped before matching`
              : ""
          }.`,
          total,
          auto,
          held,
          stoppedLabels,
          decided,
          resPct: total ? ((decided / total) * 100).toFixed(1) : "0.0",
          cash,
          rec,
          heldAmt,
        };
        BRIEF_RUN = { run_id: runId, data };
        return data;
      })(),
    };
  }
  return BRIEF_PROMISE.promise.catch(() => null);
}

/** vanilla state.js SEED_STORY, verbatim. */
export const SEED_STORY =
  "A normal day at a mid-size supplier. 16 payments arrive against 19 open invoices from 9 customers. Most are routine. Hidden among them: one payment split across two invoices, one that gives only a PO number, one with a wrong character in the invoice reference, one that takes an early-payment discount and deducts extra for a claimed shortage, one duplicate of an earlier wire, and one from a payer nobody recognises.";
