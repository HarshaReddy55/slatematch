import { useCallback, useEffect, useState } from "react";
import { motion } from "motion/react";
import {
  api,
  aiModeLabel,
  money,
  type Health,
  type MatchRecord,
  type RunSummary,
  type WorkspaceState,
} from "./lib/api";
import {
  computeImpact,
  computeRibbon,
  computeSeries,
  lastDelta,
  type Impact,
  type Ribbon,
  type Series,
} from "./lib/dashboard";
import { useRollUp } from "./lib/useRollUp";
import Panel from "./ui/Panel";
import Pill from "./ui/Pill";
import StatCard from "./ui/StatCard";
import Button from "./ui/Button";
import Orb from "./ui/Orb";

/* Stage 1: the Dashboard, migrated. Same endpoints, same computation
   rules as the vanilla dashboard (lib/dashboard.ts mirrors them line
   for line); the finish is the Obsidian pattern - metric cards with
   roll-up numbers, delta pills and sparklines over the real per-run
   series. Everything else still lives in the vanilla app at /. */

const pct1 = (v: number) => v.toFixed(1) + "%";
const int = (v: number) => String(Math.round(v));
const moneyRoll = (v: number) => money(Math.round(v));

function MiniStat({
  label,
  value,
  format,
  note,
}: {
  label: string;
  value: number | null;
  format: (v: number) => string;
  note: string;
}) {
  const rolled = useRollUp(value ?? 0, format);
  return (
    <div className="min-w-0">
      <div className="font-mono text-[10.5px] tracking-[0.07em] uppercase text-mut">
        {label}
      </div>
      <div className="font-display text-[24px] font-semibold text-ink mt-1">
        {value == null ? "-" : rolled}
      </div>
      <p className="text-[12px] text-mut leading-snug m-0 mt-1">{note}</p>
    </div>
  );
}

interface DashData {
  ws: WorkspaceState;
  health: Health;
  runs: RunSummary[];
  ribbon: Ribbon | null;
  impact: Impact | null;
  series: Series | null;
}

async function loadDashboard(): Promise<DashData> {
  const [ws, health, runsRaw] = await Promise.all([
    api<WorkspaceState>("/api/v1/workspace"),
    api<Health>("/health"),
    api<RunSummary[]>("/api/v1/runs"),
  ]);
  const runs = Array.isArray(runsRaw) ? runsRaw : [];
  const getMatches = async (id: string): Promise<MatchRecord[]> => {
    const d = await api<MatchRecord[] | { matches: MatchRecord[] }>(
      `/api/v1/runs/${id}/matches`
    );
    return Array.isArray(d) ? d : d.matches || [];
  };
  const head = runs.slice(0, 5);
  const matchesByRun = await Promise.all(head.map((r) => getMatches(r.run_id)));
  const r0 = runs.find((r) => !r.status || r.status === "COMPLETED") || null;
  let ribbon: Ribbon | null = null;
  if (r0) {
    const idx = head.indexOf(r0);
    const ms = idx >= 0 ? matchesByRun[idx] : await getMatches(r0.run_id);
    ribbon = computeRibbon(r0, ms);
  }
  return {
    ws,
    health,
    runs,
    ribbon,
    impact: runs.length ? computeImpact(head, matchesByRun) : null,
    series: runs.length ? computeSeries(head, matchesByRun) : null,
  };
}

export default function App() {
  const [data, setData] = useState<DashData | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setError("");
    loadDashboard()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(load, [load]);

  const dRes = data?.series ? lastDelta(data.series.resolution) : null;
  const dTouch = data?.series ? lastDelta(data.series.touchless) : null;
  const dCash = data?.series ? lastDelta(data.series.cash) : null;
  const dExc = data?.series ? lastDelta(data.series.exceptions) : null;
  const staged = data?.ws.run_status === "staged";

  return (
    <main className="min-h-screen bg-bg text-ink font-sans">
      <div className="max-w-[1180px] mx-auto px-5 py-6 flex flex-col gap-4">
        <header className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <p className="font-mono text-[11px] tracking-[0.08em] text-blue2 m-0">
              OPERATE - 01 / DASHBOARD
            </p>
            <h1 className="font-display text-[28px] font-semibold m-0 mt-1">
              Dashboard
            </h1>
          </div>
          <div className="flex gap-2">
            <Button ghost href="/">
              Vanilla dashboard
            </Button>
            <Button onClick={load}>Refresh</Button>
          </div>
        </header>

        {!data && !error && (
          <Panel>
            <div className="flex items-center gap-3 py-2">
              <Orb state="listening" size={30} label="Loading" />
              <span className="text-mut text-sm">Loading this workspace...</span>
            </div>
          </Panel>
        )}
        {error && (
          <Panel title="Could not load the dashboard">
            <p className="text-sm text-bad mt-2 break-words">{error}</p>
            <p className="text-sm text-mut">
              If this workspace is locked with an API key, set it in the
              vanilla app first (ACCESS KEY, top right); both stacks share
              the same browser key.
            </p>
          </Panel>
        )}

        {data && staged && (
          <Panel title="Case staged, waiting to run">
            <p className="text-sm text-mut mt-1">
              {data.ws.staged_payments || 0} wires waiting to run,{" "}
              {money(data.ws.staged_payment_total_cents || 0)} staged. Run
              the batch from Run Reconciliation in the vanilla app, then
              refresh here.
            </p>
          </Panel>
        )}

        {data && !staged && !data.ribbon && (
          <Panel title="No runs yet in this workspace">
            <p className="text-sm text-mut mt-1">
              This workspace is empty on purpose, nothing is preloaded.
              Load the demo case or upload files in the vanilla app, run a
              batch, and this dashboard fills with the same figures.
            </p>
          </Panel>
        )}

        {data?.ribbon && data.series && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3"
          >
            <StatCard
              label="Autonomous resolution (last run)"
              value={data.ribbon.resolutionPct}
              format={pct1}
              note={data.ribbon.tiers}
              spark={data.series.resolution}
              delta={dRes}
              deltaGood={(dRes ?? 0) >= 0}
              deltaText={
                dRes != null
                  ? `${dRes >= 0 ? "+" : ""}${dRes.toFixed(1)} pp vs prior run`
                  : undefined
              }
            />
            <StatCard
              label="Touchless rate (last run)"
              value={data.ribbon.touchlessPct}
              format={pct1}
              note="Payments posted with no human touch, out of all payments in the run"
              spark={data.series.touchless}
              sparkColor="#34bf71"
              delta={dTouch}
              deltaGood={(dTouch ?? 0) >= 0}
              deltaText={
                dTouch != null
                  ? `${dTouch >= 0 ? "+" : ""}${dTouch.toFixed(1)} pp vs prior run`
                  : undefined
              }
            />
            <StatCard
              label="Cash posted by the agent"
              value={data.impact?.cashCents ?? null}
              format={moneyRoll}
              note={`Net applied on auto-posted matches across the last ${data.impact?.runsCounted ?? 0} run${(data.impact?.runsCounted ?? 0) === 1 ? "" : "s"}`}
              spark={data.series.cash}
              sparkColor="#7fa6f2"
              delta={dCash}
              deltaGood={(dCash ?? 0) >= 0}
              deltaText={
                dCash != null
                  ? `${dCash >= 0 ? "+" : ""}${money(Math.round(dCash))} vs prior run`
                  : undefined
              }
            />
            <StatCard
              label="Open exceptions (last run)"
              value={data.ribbon.exceptions}
              format={int}
              note="Duplicates, no-match and unresolved residual rows from the last run"
              spark={data.series.exceptions}
              sparkColor="#f2c14e"
              delta={dExc}
              deltaGood={(dExc ?? 0) <= 0}
              deltaText={
                dExc != null
                  ? `${dExc > 0 ? "+" : ""}${Math.round(dExc)} vs prior run`
                  : undefined
              }
            />
          </motion.div>
        )}

        {data?.impact && data.ribbon && (
          <Panel title="What SlateMatch has done for you">
            <div className="grid grid-cols-2 xl:grid-cols-4 gap-4 mt-3">
              <MiniStat
                label="Analyst hours returned"
                value={data.impact.hoursReturned}
                format={(v) => v.toFixed(1) + " h"}
                note="Auto-posted payments x 12 minutes manual benchmark (a labelled assumption)"
              />
              <MiniStat
                label="Invoice-line touchless"
                value={data.impact.lineTouchlessPct}
                format={(v) => Math.round(v) + "%"}
                note="Lines posted with no human touch, of all matched lines. The market median auto-match rate is 70% (Hackett, 2025)"
              />
              <MiniStat
                label="Recovery in flight"
                value={data.impact.recoveryUsd}
                format={(v) =>
                  "$" + Math.round(v).toLocaleString("en-US")
                }
                note="Expected value of the dispute claims the agent has opened"
              />
              <MiniStat
                label="Unapplied cash in suspense"
                value={data.ribbon.suspenseCents}
                format={moneyRoll}
                note="Absolute residual across the last run's matches, parked until resolved"
              />
            </div>
            <div className="grid grid-cols-2 xl:grid-cols-4 gap-4 mt-4 pt-4 border-t border-white/[0.06]">
              <MiniStat
                label="Avg solver latency"
                value={data.ribbon.avgLatencyMs}
                format={(v) => v.toFixed(1) + " ms"}
                note="Mean per-match solve time in the last run"
              />
              <MiniStat
                label="Invoices settled (last run)"
                value={data.ribbon.settledLines}
                format={int}
                note="Invoice lines cleared by the last run"
              />
              <div className="min-w-0">
                <div className="font-mono text-[10.5px] tracking-[0.07em] uppercase text-mut">
                  Agent mode
                </div>
                <div className="text-[15px] font-medium text-ink mt-2 leading-snug">
                  {aiModeLabel(
                    data.health.gemini_configured,
                    data.health.gemini_last_error
                  )}
                </div>
                <p className="text-[12px] text-mut leading-snug m-0 mt-1">
                  AI suggests; fixed rules decide.
                </p>
              </div>
              <div className="min-w-0">
                <div className="font-mono text-[10.5px] tracking-[0.07em] uppercase text-mut">
                  Solver engine
                </div>
                <div className="text-[15px] font-medium text-ink mt-2 leading-snug">
                  HiGHS MILP + Rust
                </div>
                <p className="text-[12px] text-mut leading-snug m-0 mt-1">
                  Subset-sum kernel, 0-cent residual rule.
                </p>
              </div>
            </div>
          </Panel>
        )}

        {data && data.runs.length > 0 && (
          <Panel
            title="Run history"
            sub="Every batch executed in this workspace. The Run view itself migrates in Stage 3; until then a run opens in the vanilla app."
          >
            <div className="overflow-x-auto mt-2">
              <table className="w-full text-[13px] border-collapse">
                <thead>
                  <tr className="text-left text-mut font-mono text-[10.5px] tracking-[0.06em] uppercase">
                    <th className="py-2 pr-3 font-medium">Run</th>
                    <th className="py-2 pr-3 font-medium">When (UTC)</th>
                    <th className="py-2 pr-3 font-medium">Status</th>
                    <th className="py-2 pr-3 font-medium">Matches</th>
                    <th className="py-2 pr-3 font-medium">Auto-posted</th>
                    <th className="py-2 font-medium">Exceptions</th>
                  </tr>
                </thead>
                <tbody>
                  {data.runs.map((r) => (
                    <tr key={r.run_id} className="border-t border-white/[0.05]">
                      <td className="py-2 pr-3 font-mono text-[11.5px] text-mut">
                        {r.run_id}
                      </td>
                      <td className="py-2 pr-3 text-mut">
                        {(r.created_at || "").replace("T", " ").slice(0, 19)}
                      </td>
                      <td className="py-2 pr-3">
                        <Pill kind="ok">{r.status || "COMPLETED"}</Pill>
                      </td>
                      <td className="py-2 pr-3">{r.matches ?? "-"}</td>
                      <td className="py-2 pr-3">{r.auto_posted ?? "-"}</td>
                      <td className="py-2">{r.exceptions ?? "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        )}

        <p className="font-mono text-[11px] text-mut2 m-0">
          React Stage 1 - Dashboard. Figures are computed from the same API
          responses with the same rules as the vanilla dashboard.
        </p>
      </div>
    </main>
  );
}
