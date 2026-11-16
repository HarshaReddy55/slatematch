import { useCallback, useEffect, useState } from "react";
import {
  api,
  aiModeLabel,
  money,
  type Health,
  type MatchRecord,
  type RunSummary,
  type WorkspaceState,
} from "../lib/api";
import {
  computeImpact,
  computeRibbon,
  computeSeries,
  lastDelta,
  type Impact,
  type Ribbon,
  type Series,
} from "../lib/dashboard";
import { useRollUp } from "../lib/useRollUp";
import { goView, setIntent, type WorkspaceOperate } from "../lib/operate";
import { requestShellRefresh, useWsRefresh } from "../lib/chrome";
import { StagedGate } from "../ui/Stage3";
import Panel from "../ui/Panel";
import Pill from "../ui/Pill";
import StatCard from "../ui/StatCard";
import Button from "../ui/Button";
import SessionsPanel from "../ui/SessionsPanel";
import ViewSkeleton from "../ui/Skeleton";
import { RefreshFade, Rise, TitleRise } from "../ui/motion";

/* Stage 1: the Dashboard, migrated. Same endpoints, same computation
   rules as the vanilla dashboard (lib/dashboard.ts mirrors them line
   for line); the finish is the Obsidian pattern - metric cards with
   roll-up numbers, delta pills and sparklines over the real per-run
   series. Stage 4 adds the session saves panel below the run
   history, in the same place vanilla keeps it. */

const pct1 = (v: number) => v.toFixed(1) + "%";
const int = (v: number) => String(Math.round(v));
const moneyRoll = (v: number) => money(Math.round(v));

function MiniStat({
  label,
  value,
  format,
  note,
  onClick,
  title,
}: {
  label: string;
  value: number | null;
  format: (v: number) => string;
  note: string;
  /** Stage 5: a figure that drills to its underlying records. */
  onClick?: () => void;
  title?: string;
}) {
  const rolled = useRollUp(value ?? 0, format);
  return (
    <div
      className={`min-w-0 ${onClick ? "cursor-pointer" : ""}`}
      onClick={onClick}
      title={title}
      role={onClick ? "button" : undefined}
    >
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

export default function Dashboard({
  toast,
}: {
  toast: (m: string) => void;
}) {
  const [data, setData] = useState<DashData | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setError("");
    loadDashboard()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(load, [load]);
  /* Stage 6 (Item 1): reload when the workspace is replaced -
     the missing half that let a switched case keep the previous
     case's figures on this view. */
  useWsRefresh(load);

  const dRes = data?.series ? lastDelta(data.series.resolution) : null;
  const dTouch = data?.series ? lastDelta(data.series.touchless) : null;
  const dCash = data?.series ? lastDelta(data.series.cash) : null;
  const dExc = data?.series ? lastDelta(data.series.exceptions) : null;
  const staged = data?.ws.run_status === "staged";

  return (
    <>
      <div className="flex flex-col gap-4">
        <header className="flex items-end justify-between gap-4 flex-wrap">
          <TitleRise>
            <p className="font-mono text-[11px] tracking-[0.08em] text-blue2 m-0">
              OPERATE - 01 / DASHBOARD
            </p>
            <h1 className="font-display text-[28px] font-semibold m-0 mt-1">
              Dashboard
            </h1>
          </TitleRise>
          <div className="flex gap-2">
            <Button ghost href="/vanilla/">
              Vanilla dashboard
            </Button>
            <Button onClick={load}>Refresh</Button>
          </div>
        </header>

        {!data && !error && <ViewSkeleton kind="stats" />}
        {error && (
          <Panel title="Could not load the dashboard">
            <p className="text-sm text-bad mt-2 break-words">{error}</p>
            <p className="text-sm text-mut">
              If this workspace is locked with an API key, set it with
              ACCESS KEY in the shell above; both stacks share the same
              browser key.
            </p>
          </Panel>
        )}

        {data && staged && (
          <Rise i={0}>
            {/* Stage 6 (Item 1): vanilla's stagedGateHtml, the
                shared StagedGate - the Stage 1-5 Panel that stood
                here carried invented copy and dropped the
                open-invoices figure and the nothing-is-pre-computed
                statement, so it was not vanilla's gate. The gate
                is the primary content of the staged Dashboard; no
                ribbon, impact or history figures render in this
                state (the loader finds no runs, so none can). */}
            <StagedGate
              where="dashboard figures"
              ws={data.ws as unknown as WorkspaceOperate}
              onExecute={() => {
                setIntent("slate-run-live", "1");
                goView("run");
              }}
            />
          </Rise>
        )}

        {data && !staged && !data.ribbon && (
          <Rise i={0}>
            <Panel title="No runs yet in this workspace">
              <p className="text-sm text-mut mt-1">
                This workspace is empty on purpose, nothing is preloaded.
                Load the demo case or upload files, run a batch, and this
                dashboard fills with the same figures.
              </p>
              <div className="mt-3">
                <Button
                  onClick={async () => {
                    try {
                      /* Stage 6: the same load path vanilla's
                         loadCase('seed') takes, so the staged
                         case carries vanilla's identity ("Demo
                         case - one realistic day of receipts"),
                         not the seed endpoint's workspace name. */
                      await api("/api/v1/cases/seed/load", {
                        method: "POST",
                      });
                      try {
                        sessionStorage.removeItem("slate-empty");
                      } catch {
                        /* ignore */
                      }
                      requestShellRefresh();
                      load();
                    } catch (e) {
                      toast(
                        "Load failed: " +
                          (e instanceof Error ? e.message : String(e))
                      );
                    }
                  }}
                >
                  Load demo case
                </Button>
              </div>
            </Panel>
          </Rise>
        )}

        {data?.ribbon && data.series && (
          <Rise i={0}>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
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
              note="Duplicates, no-match and unresolved residual rows from the last run. Click to open the run filtered to exactly these rows."
              onClick={() => {
                setIntent("slate-run-filter", "exceptions");
                goView("run");
              }}
              title="Open Run Reconciliation filtered to the exception and disputed rows"
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
            </div>
          </Rise>
        )}

        {data?.impact && data.ribbon && (
          <Rise i={1}>
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
                note="Expected value of the dispute claims the agent has opened. Click to open the claims."
                onClick={() => {
                  setIntent("slate-mail-cat", "disputes");
                  goView("mail");
                }}
                title="Open these dispute claims in the Outbound Mail Hub"
              />
              <MiniStat
                label="Unapplied cash in suspense"
                value={data.ribbon.suspenseCents}
                format={moneyRoll}
                note="Absolute residual across the last run's matches, parked until resolved. Click to see the rows it is parked on."
                onClick={() => {
                  setIntent("slate-run-filter", "exceptions");
                  goView("run");
                }}
                title="Open the run filtered to the rows this cash is parked on"
              />
            </div>
            <div className="grid grid-cols-2 xl:grid-cols-4 gap-4 mt-4 pt-4 border-t border-line">
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
                note="Invoice lines cleared by the last run. Click to see them in the run's matches, line by line."
                onClick={() => goView("run")}
                title="Open the run - its matches list every settled line and the payment that settled it"
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
          </Rise>
        )}

        {data && data.runs.length > 0 && (
          <Rise i={2}>
          <Panel
            title="Run history"
            sub="Every batch executed in this workspace, newest first."
          >
            <RefreshFade
              className="overflow-x-auto mt-2"
              signature={`${data.runs.length}:${data.runs[0]?.run_id ?? ""}`}
            >
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
                    <tr
                      key={r.run_id}
                      className="border-t border-white/[0.05] cursor-pointer hover:bg-white/[0.03]"
                      title="Open this run in Run Reconciliation"
                      onClick={() => {
                        setIntent("slate-open-run", r.run_id);
                        goView("run");
                      }}
                    >
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
            </RefreshFade>
          </Panel>
          </Rise>
        )}

        {data && staged && data.runs.length === 0 && (
          <Rise i={2}>
            {/* Vanilla's staged Dashboard still shows the run
                history panel, with its empty line - the panel's
                presence is part of the page's organisation. */}
            <Panel title="Run history" sub="Every batch executed in this workspace, newest first.">
              <p className="text-[13px] text-mut mt-2 m-0">
                No runs yet. Load a case or upload payments to create
                the first run.
              </p>
            </Panel>
          </Rise>
        )}

        <Rise i={3}>
          <SessionsPanel toast={toast} />
        </Rise>

      </div>
    </>
  );
}
