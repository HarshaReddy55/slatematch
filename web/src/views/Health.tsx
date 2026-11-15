import { useCallback, useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  api,
  aiModeLabel,
  type MatchRecord,
  type RunSummary,
} from "../lib/api";
import {
  barOutcome,
  cleanRunShare,
  heldCount,
  maeImprovement,
  probeText,
  runResolutionPct,
  type AuditEntry,
  type Diagnostics,
  type HealthFull,
  type ReadyData,
} from "../lib/insight";
import Panel from "../ui/Panel";
import Pill, { type PillKind } from "../ui/Pill";
import DataTable, { Row, Td, Th } from "../ui/DataTable";
import ViewHead, { LoadError, Loading } from "../ui/ViewHead";
import { EASE_OUT, RefreshFade, Reveal, Rise } from "../ui/motion";

/* Stage 2: Agent Health, migrated. Cards, model quality, readiness
   and diagnostics mirror loadHealth() + loadDiag() in the vanilla
   insight.js; the audit trail mirrors loadAudit() in assist.js.
   New here, per the migration plan: the Obsidian Status Bars built
   natively over GET /api/v1/runs (real run records only), and the
   audit trail presented as an Activity Feed (the EasyUI pattern) over
   the same first-30 records the vanilla table shows. */

interface HealthData {
  h: HealthFull;
  r: ReadyData;
  diag: Diagnostics | null;
  audit: AuditEntry[];
  runs: RunSummary[];
  heldByRun: Record<string, number>;
}

const BAR_BG: Record<string, string> = {
  ok: "var(--color-ok)",
  warn: "var(--color-warn)",
  bad: "var(--color-bad)",
};

function MiniCard({
  label,
  children,
  note,
}: {
  label: string;
  children: React.ReactNode;
  note: string;
}) {
  return (
    <div className="glass-card rounded-md border border-white/[0.11] p-4 min-w-0">
      <div className="font-mono text-[10.5px] tracking-[0.07em] uppercase text-mut">
        {label}
      </div>
      <div className="mt-2">{children}</div>
      <p className="text-[12px] text-mut leading-snug m-0 mt-2">{note}</p>
    </div>
  );
}

export default function Health() {
  const [data, setData] = useState<HealthData | null>(null);
  const [error, setError] = useState("");
  const [selRun, setSelRun] = useState<number | null>(null);
  const reduce = useReducedMotion();

  const load = useCallback(() => {
    setError("");
    (async () => {
      const [h, r] = await Promise.all([
        api<HealthFull>("/health"),
        api<ReadyData>("/ready"),
      ]);
      const [diag, audit, runs] = await Promise.all([
        api<Diagnostics>("/api/v1/diagnostics").catch(() => null),
        api<AuditEntry[]>("/api/v1/audit").catch(() => [] as AuditEntry[]),
        api<RunSummary[]>("/api/v1/runs").catch(() => [] as RunSummary[]),
      ]);
      // Held counts come from each run's own matches payload (PROPOSED
      // rows), the same records the Status Bar colour rule reads.
      const heldByRun: Record<string, number> = {};
      await Promise.all(
        runs.map(async (run) => {
          try {
            const d = await api<MatchRecord[] | { matches: MatchRecord[] }>(
              `/api/v1/runs/${run.run_id}/matches`
            );
            heldByRun[run.run_id] = heldCount(
              Array.isArray(d) ? d : d.matches || []
            );
          } catch {
            heldByRun[run.run_id] = 0;
          }
        })
      );
      setData({ h, r, diag, audit, runs, heldByRun });
    })().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(load, [load]);

  const h = data?.h;
  const m = h?.model_metrics || {};
  const chrono = data ? [...data.runs].reverse() : [];
  const heldOf = (r: RunSummary) => data?.heldByRun[r.run_id] || 0;
  const share = data ? cleanRunShare(data.runs, data.heldByRun) : null;
  const sel = selRun !== null ? chrono[selRun] : null;

  return (
    <>
      <ViewHead
        eyebrow="EVALS & ARCHITECTURE - 11 / AGENT HEALTH"
        title="Agent Health"
        purpose="Service readiness, model quality, diagnostics and audit trail."
        onRefresh={load}
      />
      {!data && !error && <Loading label="LOADING AGENT HEALTH..." />}
      {error && <LoadError error={error} />}
      {data && h && (
        <>
          <Rise i={0}>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
            <MiniCard label="Service status" note="Readiness gate checked live">
              <span className="flex gap-2">
                <Pill kind={h.status === "ok" ? "ok" : "bad"}>
                  {h.status === "ok" ? "Healthy" : "Degraded"}
                </Pill>
                <Pill kind={data.r.ready ? "ok" : "bad"}>
                  {data.r.ready ? "Ready" : "Not ready"}
                </Pill>
              </span>
            </MiniCard>
            <MiniCard
              label="Auth mode"
              note={
                h.auth === "dev-open"
                  ? "Demo posture: no keys issued yet"
                  : "API keys enforced per tenant"
              }
            >
              <span className="font-display text-[20px] font-semibold">
                {h.auth}
              </span>
            </MiniCard>
            <MiniCard
              label="AI layer"
              note="Parser mode is always labelled in its output; the raw provider state stays in diagnostics below"
            >
              <span className="text-[15.5px] font-medium leading-snug">
                {aiModeLabel(h.gemini_configured, h.gemini_last_error)}
              </span>
            </MiniCard>
            <MiniCard label="Data directory" note="Per-tenant SQLite stores">
              <span className="font-display text-[20px] font-semibold break-all">
                {h.data_dir}
              </span>
            </MiniCard>
          </div>
          </Rise>

          <Rise i={1}>
          <Panel
            title="Run history - status bars"
            sub="One bar per run in this workspace, oldest to newest, coloured by the run's own outcome. Select a bar for its detail. Green (up): completed, nothing held, no exceptions. Amber (degraded): completed with held items or exceptions. Red (down): failed or incomplete."
          >
            {chrono.length ? (
              <>
                <RefreshFade
                  signature={`${chrono.length}:${chrono[chrono.length - 1]?.run_id ?? ""}`}
                >
                <div
                  className="flex items-stretch gap-[3px] mt-3 p-[3px] rounded-[3px]"
                  role="list"
                  style={{ background: "rgba(255,255,255,0.03)" }}
                >
                  {chrono.map((r, i) => {
                    const o = barOutcome(r, heldOf(r));
                    return (
                      <button
                        key={r.run_id}
                        role="listitem"
                        onClick={() => setSelRun(i)}
                        title={`${r.run_id} - ${(r.created_at || "").replace("T", " ").slice(0, 19)} UTC - ${r.payments ?? "-"} payments, ${r.matches ?? "-"} matches, ${r.auto_posted ?? "-"} auto-posted, ${heldOf(r)} held, ${r.exceptions ?? 0} exceptions`}
                        aria-label={`Run ${r.run_id}, outcome ${o}`}
                        className="pressable flex-1 min-w-[6px] border-0 cursor-pointer p-0 hover:brightness-110"
                        style={{
                          height: 30,
                          maxWidth: 34,
                          background: BAR_BG[o],
                          opacity: selRun === null || selRun === i ? 1 : 0.45,
                          borderRadius: 2,
                          outline:
                            selRun === i ? "2px solid #f2f0ea" : "none",
                          outlineOffset: 1,
                        }}
                      />
                    );
                  })}
                </div>
                <div className="flex justify-between items-baseline mt-2 flex-wrap gap-2">
                  <p className="font-mono text-[11px] text-mut m-0">
                    {share !== null
                      ? `${share.toFixed(1)}% up (${chrono.filter((r) => barOutcome(r, heldOf(r)) === "ok").length} of ${chrono.length} runs completed with nothing held and no exceptions)`
                      : ""}
                  </p>
                  <p className="font-mono text-[11px] text-mut m-0">
                    {chrono.length} run{chrono.length === 1 ? "" : "s"} in this
                    workspace
                  </p>
                </div>
                </RefreshFade>
                <Reveal open={!!sel} revealKey={sel ? sel.run_id : "none"}>
                  {sel && (
                  <p className="text-[13px] text-mut mb-0 mt-2 leading-relaxed">
                    <b className="text-ink font-mono text-[12px]">
                      {sel.run_id}
                    </b>{" "}
                    - {(sel.created_at || "").replace("T", " ").slice(0, 19)}{" "}
                    UTC - status {sel.status || "COMPLETED"} - {sel.payments}{" "}
                    payments, {sel.matches} matches, {sel.auto_posted}{" "}
                    auto-posted, {heldOf(sel)} held, {sel.exceptions || 0}{" "}
                    exceptions
                    {runResolutionPct(sel) !== null &&
                      ` - resolution ${runResolutionPct(sel)!.toFixed(1)}%`}
                  </p>
                  )}
                </Reveal>
              </>
            ) : (
              <p className="text-sm text-mut mb-0 mt-2">
                No runs in this workspace yet. The bars appear from real run
                records once a batch has executed.
              </p>
            )}
          </Panel>
          </Rise>

          <Rise i={2}>
          <Panel
            title="Model quality (held-out, time-ordered)"
            sub="Trained on synthetic history with a learnable signal; graded on rows the models never trained on."
          >
            <DataTable
              head={
                <>
                  <Th>Model</Th>
                  <Th>Metric</Th>
                  <Th>Value</Th>
                  <Th>Reference</Th>
                </>
              }
            >
              <Row>
                <Td>Payment-delay regressor</Td>
                <Td>MAE (days)</Td>
                <Td>
                  <b>{m.delay_mae_days}</b>
                </Td>
                <Td>
                  Naive baseline {m.delay_baseline_mae_days} days, a{" "}
                  {maeImprovement(m)}% improvement
                </Td>
              </Row>
              <Row>
                <Td>Deduction-validity classifier</Td>
                <Td>ROC AUC</Td>
                <Td>
                  <b>{m.validity_auc}</b>
                </Td>
                <Td>0.5 is chance; 1.0 is perfect</Td>
              </Row>
              <Row>
                <Td>Training set</Td>
                <Td>Rows</Td>
                <Td>
                  {m.train_rows} train / {m.test_rows} test
                </Td>
                <Td>Time-ordered 80/20 split</Td>
              </Row>
            </DataTable>
            <p className="text-[12px] text-mut mb-0 mt-3">
              Data basis: {m.data_basis || ""}
            </p>
          </Panel>
          </Rise>

          <Rise i={3}>
          <Panel title="Readiness checks">
            <DataTable
              head={
                <>
                  <Th>Check</Th>
                  <Th>State</Th>
                </>
              }
            >
              {Object.entries(data.r.checks || {}).map(([k, v]) => (
                <Row key={k}>
                  <Td>{k}</Td>
                  <Td>
                    <Pill kind={v === "ok" ? "ok" : "bad"}>{String(v)}</Pill>
                  </Td>
                </Row>
              ))}
            </DataTable>
          </Panel>
          </Rise>

          <Rise i={4}>
          <Panel title="Kernel and test suite health">
            {data.diag ? (
              <div className="mt-2 flex flex-col">
                {(
                  [
                    [
                      "Rust kernel (rust-kernel, via rust_bridge.py)",
                      data.diag.rust_kernel.present ? (
                        <Pill kind="ok">ACTIVE</Pill>
                      ) : (
                        <Pill kind="warn">NOT IN THIS DEPLOYMENT</Pill>
                      ),
                    ],
                    ["Kernel equivalence", probeText(data.diag)],
                    [
                      "Equivalence suite",
                      data.diag.rust_kernel.equivalence_suite,
                    ],
                    [
                      "MILP solver",
                      `${data.diag.milp.solver} - ${data.diag.milp.exact_recheck}`,
                    ],
                    [
                      "Repository test suite",
                      <>
                        <b>{data.diag.test_suite.module_count}</b> test modules
                        - {data.diag.test_suite.ci}
                      </>,
                    ],
                    [
                      "Document store",
                      <>
                        The product documents in the header are read live from{" "}
                        <span className="font-mono">docs/</span> in this
                        deployment
                      </>,
                    ],
                  ] as [string, React.ReactNode][]
                ).map(([k, v]) => (
                  <div
                    key={k}
                    className="flex justify-between gap-4 py-2 border-t border-white/[0.05] first:border-t-0 text-[13px]"
                  >
                    <b className="shrink-0">{k}</b>
                    <span className="text-mut text-right">{v}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-mut mb-0 mt-2">
                Diagnostics unavailable on this server.
              </p>
            )}
          </Panel>
          </Rise>

          <Rise i={5}>
          <Panel
            title="Audit trail"
            sub="Runs, approvals, rejections and policy changes, written by the server when they occur. Entries cannot be edited from this interface."
          >
            {data.audit.length ? (
              <RefreshFade
                signature={`${data.audit.length}:${data.audit[0]?.created_at ?? ""}`}
              >
              <ul className="m-0 mt-2 p-0 list-none">
                {data.audit.slice(0, 30).map((a, i) => (
                  <motion.li
                    key={i}
                    initial={reduce ? false : { opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{
                      duration: 0.25,
                      delay: Math.min(i * 0.03, 0.3),
                      ease: EASE_OUT,
                    }}
                    className="flex gap-3 py-2 border-t border-white/[0.05] first:border-t-0 items-start"
                  >
                    <span className="font-mono text-[11px] text-mut whitespace-nowrap pt-[2px]">
                      {String(a.created_at).replace("T", " ").slice(0, 19)}
                    </span>
                    <span className="flex flex-col gap-1 min-w-0">
                      <span className="flex gap-2 items-center flex-wrap">
                        <Pill kind={"info" as PillKind}>{a.action}</Pill>
                        <span className="text-[13px]">
                          {a.actor} - {a.entity} {a.entity_id}
                        </span>
                      </span>
                      <small className="text-mut break-all">
                        {JSON.stringify(a.payload)}
                      </small>
                    </span>
                  </motion.li>
                ))}
              </ul>
              </RefreshFade>
            ) : (
              <p className="text-sm text-mut mb-0 mt-2">
                No audit entries yet. Run a batch to create the first one.
              </p>
            )}
          </Panel>
          </Rise>
        </>
      )}
    </>
  );
}
