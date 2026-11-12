import type { MatchRecord, RunSummary } from "./api";

/* Dashboard figures, computed with exactly the vanilla dashboard's
   rules (refreshDash + renderImpact in the classic frontend), from the
   same endpoints. If a number here ever disagrees with the vanilla
   dashboard on the same workspace, that is a bug in this file. */

export interface Ribbon {
  resolutionPct: number;
  tiers: string;
  autoN: number;
  qSol: number;
  qRef: number;
  suspenseCents: number;
  avgLatencyMs: number | null;
  settledLines: number;
  exceptions: number;
  touchlessPct: number;
}

export interface Impact {
  cashCents: number;
  hoursReturned: number;
  lineTouchlessPct: number;
  recoveryUsd: number;
  runsCounted: number;
}

export interface Series {
  resolution: number[];
  touchless: number[];
  cash: number[];
  exceptions: number[];
}

export function computeRibbon(r0: RunSummary, matches: MatchRecord[]): Ribbon {
  const tot = r0.payments || 0;
  const dec = matches.length;
  const autoN = matches.filter((x) => x.status === "AUTO_POSTED").length;
  const qSol = matches.filter(
    (x) => x.status === "PROPOSED" && ((x.result || {}).lines || []).length > 0
  ).length;
  const qRef = dec - autoN - qSol;
  const pc = (n: number) => (tot ? ((n / tot) * 100).toFixed(1) + "%" : "-%");
  const parts = [`${pc(autoN)} zero-touch auto-posted`];
  if (qSol) parts.push(`${pc(qSol)} solved & queued for maker-checker sign-off`);
  if (qRef) parts.push(`${pc(qRef)} refused with a reason, queued for review`);
  const susp = matches.reduce((a, x) => a + Math.abs(x.residual_cents || 0), 0);
  const lats = matches
    .map((x) => (x.result || {}).latency_ms || 0)
    .filter(Boolean);
  return {
    resolutionPct: tot ? (dec / tot) * 100 : 0,
    tiers: parts.join(" · "),
    autoN,
    qSol,
    qRef,
    suspenseCents: susp,
    avgLatencyMs: lats.length
      ? lats.reduce((a, b) => a + b, 0) / lats.length
      : null,
    settledLines: matches.reduce(
      (a, x) => a + ((x.result || {}).lines || []).length,
      0
    ),
    exceptions: r0.exceptions || 0,
    touchlessPct: tot ? ((r0.auto_posted || 0) / tot) * 100 : 0,
  };
}

export function computeImpact(
  runs: RunSummary[],
  matchesByRun: MatchRecord[][]
): Impact {
  let cash = 0,
    auto = 0,
    totLines = 0,
    autoLines = 0,
    rec = 0;
  for (const ms of matchesByRun) {
    for (const m of ms) {
      const res = m.result || {};
      const lines = res.lines || [];
      totLines += lines.length;
      if (res.auto_posted || m.status === "APPROVED_POSTED") {
        auto++;
        autoLines += lines.length;
        cash += lines.reduce((a, l) => a + l.net_cents, 0);
      }
      const d = res.deduction || {};
      if (d.autonomous_action === "AUTO_GENERATE_DISPUTE_CLAIM")
        rec += Number(d.expected_recovery_value_usd || 0);
    }
  }
  return {
    cashCents: cash,
    hoursReturned: (auto * 12) / 60,
    lineTouchlessPct: totLines ? Math.round((100 * autoLines) / totLines) : 0,
    recoveryUsd: rec,
    runsCounted: matchesByRun.length,
  };
}

/** Per-run series in chronological order (the API lists newest first),
    from the same fetched matches the impact panel uses. */
export function computeSeries(
  runs: RunSummary[],
  matchesByRun: MatchRecord[][]
): Series {
  const chrono = runs
    .map((r, i) => ({ r, ms: matchesByRun[i] || [] }))
    .reverse();
  return {
    resolution: chrono.map(({ r, ms }) =>
      r.payments ? (ms.length / r.payments) * 100 : 0
    ),
    touchless: chrono.map(({ r }) =>
      r.payments ? ((r.auto_posted || 0) / r.payments) * 100 : 0
    ),
    cash: chrono.map(({ ms }) =>
      ms.reduce((a, m) => {
        const res = m.result || {};
        if (!(res.auto_posted || m.status === "APPROVED_POSTED")) return a;
        return a + (res.lines || []).reduce((x, l) => x + l.net_cents, 0);
      }, 0)
    ),
    exceptions: chrono.map(({ r }) => r.exceptions || 0),
  };
}

export function lastDelta(series: number[]): number | null {
  if (series.length < 2) return null;
  return series[series.length - 1] - series[series.length - 2];
}
