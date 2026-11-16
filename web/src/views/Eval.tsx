import { useCallback, useEffect, useState } from "react";
import { api, money, type MatchRecord, type RunSummary } from "../lib/api";
import {
  gradeCase,
  normalisedStored,
  type CaseMeta,
  type EvalData,
  type GradeResult,
  type ScenarioPack,
  type ScenarioRun,
  type WorkspaceFull,
} from "../lib/insight";
import Panel from "../ui/Panel";
import Pill from "../ui/Pill";
import DataTable, { Row, Td, Th } from "../ui/DataTable";
import ViewHead, { LoadError } from "../ui/ViewHead";
import ViewSkeleton from "../ui/Skeleton";
import { StagedGate } from "../ui/Stage3";
import {
  goView,
  setIntent,
  type WorkspaceOperate,
} from "../lib/operate";
import { Rise } from "../ui/motion";

/* Stage 2: Evaluations, migrated. loadEval() + renderEvalScenarios()
   + gradeHtml() from the vanilla insight.js / operate.js, mirrored in
   lib/insight.ts. The scenario suite runs each pack server-side on
   its own clean ledger, exactly as vanilla does. */

interface EvalState {
  staged: boolean;
  ev: EvalData | null;
  grade: GradeResult | null;
  gradeRunId: string | null;
  caseMeta: CaseMeta | null;
  caseNotRun: boolean;
}

interface PackRow {
  title: string;
  pass: boolean | null;
  text: string;
}

async function getMatches(id: string): Promise<MatchRecord[]> {
  const d = await api<MatchRecord[] | { matches: MatchRecord[] }>(
    `/api/v1/runs/${id}/matches`
  );
  return Array.isArray(d) ? d : d.matches || [];
}

export default function Eval() {
  const [data, setData] = useState<EvalState | null>(null);
  const [error, setError] = useState("");
  const [packs, setPacks] = useState<PackRow[] | null>(null);
  const [wsFull, setWsFull] = useState<WorkspaceFull | null>(null);

  const load = useCallback(() => {
    setError("");
    setPacks(null);
    (async () => {
      const ws = await api<WorkspaceFull>("/api/v1/workspace");
      setWsFull(ws);
      if (ws.run_status === "staged") {
        setData({
          staged: true,
          ev: null,
          grade: null,
          gradeRunId: null,
          caseMeta: ws.case || null,
          caseNotRun: false,
        });
        return;
      }
      const ev = await api<EvalData>("/api/v1/evaluations");
      let grade: GradeResult | null = null;
      let gradeRunId: string | null = null;
      let caseNotRun = false;
      const c = ws.case;
      if (c && c.expect && Object.keys(c.expect).length) {
        // caseRunData(): first of the first 8 runs whose matches cover
        // a payment the case grades.
        const runs = await api<RunSummary[]>("/api/v1/runs");
        let found: {
          run: RunSummary;
          matches: MatchRecord[];
        } | null = null;
        for (const r of runs.slice(0, 8)) {
          const ms = await getMatches(r.run_id);
          if (
            ms.some((mm) =>
              Object.prototype.hasOwnProperty.call(c.expect, mm.payment_id)
            )
          ) {
            found = { run: r, matches: ms };
            break;
          }
        }
        if (found) {
          const ex = await api<{ payment_id: string; kind: string }[]>(
            `/api/v1/runs/${found.run.run_id}/exceptions`
          );
          grade = gradeCase(c, normalisedStored(found.matches), ex);
          gradeRunId = found.run.run_id;
        } else {
          caseNotRun = true;
        }
      }
      setData({
        staged: false,
        ev,
        grade,
        gradeRunId,
        caseMeta: c || null,
        caseNotRun,
      });
      // renderEvalScenarios(): sequential, each pack on its own ledger.
      const list = await api<ScenarioPack[]>("/api/v1/scenarios");
      const rows: PackRow[] = [];
      for (const p of list) {
        try {
          const r = await api<ScenarioRun>(
            `/api/v1/scenarios/${encodeURIComponent(p.id)}/run`,
            { method: "POST" }
          );
          const passed = (r.checks || []).filter((x) => x.pass).length;
          rows.push({
            title: p.title || p.id,
            pass: r.all_pass,
            text: `${passed} / ${(r.checks || []).length} checks`,
          });
        } catch (e) {
          rows.push({
            title: p.title || p.id,
            pass: null,
            text: `Could not run: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
        setPacks([...rows]);
      }
    })().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(load, [load]);

  const ev = data?.ev;

  return (
    <>
      <ViewHead
        eyebrow="EVALS & ARCHITECTURE - 10 / EVALUATIONS"
        title="Evaluations"
        purpose="Solver and scenario checks against answers fixed before each run."
        onRefresh={load}
      />
      {!data && !error && <ViewSkeleton kind="panels" />}
      {error && <LoadError error={error} />}

      {data?.staged && wsFull?.case && (
        <Rise i={0}>
          <StagedGate
            where="evaluations"
            ws={wsFull as unknown as WorkspaceOperate}
            onExecute={() => {
              setIntent("slate-run-live", "1");
              goView("run");
            }}
          />
        </Rise>
      )}

      {data && !data.staged && data.caseNotRun && data.caseMeta && (
        <Rise i={0}>
        <Panel title={`Case verdict - ${data.caseMeta.name}`}>
          <p className="text-sm text-mut mt-1 mb-0">
            This case states its expected outcomes up front, but its payments
            have not been run in this workspace yet. Run it from Run
            Reconciliation and the graded verdict will appear here.
          </p>
        </Panel>
        </Rise>
      )}

      {data && !data.staged && data.grade && data.caseMeta && (
        <Rise i={0}>
        <Panel title={`Case verdict - ${data.caseMeta.name}`}>
          <p
            className={`text-sm font-medium mt-2 mb-0 ${data.grade.allPass ? "text-ok" : "text-bad"}`}
          >
            {data.grade.allPass
              ? "All checks passed - the workspace run did exactly what this case promises."
              : "Some checks failed - the evidence below is the honest result."}
          </p>
          {data.gradeRunId && (
            <p className="text-[12px] text-mut mb-0 mt-1">
              Graded against run {data.gradeRunId} - the run that processed
              this case's payments.
            </p>
          )}
          <DataTable
            head={
              <>
                <Th>Check</Th>
                <Th>Expected</Th>
                <Th>Actual</Th>
                <Th>Verdict</Th>
              </>
            }
          >
            {data.grade.rows.map((r, i) => (
              <Row key={i}>
                <Td>{r.label}</Td>
                <Td className="font-mono text-[11.5px] break-all">{r.expected}</Td>
                <Td className="font-mono text-[11.5px] break-all">{r.actual}</Td>
                <Td>
                  <span
                    className={`font-semibold ${r.pass ? "text-ok" : "text-bad"}`}
                  >
                    {r.pass ? "PASS" : "FAIL"}
                  </span>
                </Td>
              </Row>
            ))}
          </DataTable>
          {data.caseMeta.policy_note && (
            <p className="text-[12px] text-mut mb-0 mt-3">
              {data.caseMeta.policy_note}
            </p>
          )}
        </Panel>
        </Rise>
      )}

      {ev && (
        <>
          <Rise i={1}>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {(
              [
                [
                  "MILP accuracy",
                  ev.milp_accuracy,
                  "Agreement with human-labelled answers",
                ],
                [
                  "Greedy accuracy",
                  ev.greedy_accuracy,
                  "The fast heuristic baseline",
                ],
                [
                  "MILP exact rate",
                  ev.milp_exact_rate,
                  "Solutions reconciling to $0.00 residual",
                ],
              ] as [string, number, string][]
            ).map(([label, v, note]) => (
              <div
                key={label}
                className="glass-card rounded-md border border-white/[0.11] p-4"
              >
                <div className="font-mono text-[10.5px] tracking-[0.07em] uppercase text-mut">
                  {label}
                </div>
                <div className="font-display text-[30px] leading-none font-semibold mt-2">
                  {(v * 100).toFixed(0)}%
                </div>
                <p className="text-[12px] text-mut leading-snug m-0 mt-2">
                  {note}
                </p>
              </div>
            ))}
          </div>
          </Rise>

          <Rise i={2}>
          <Panel>
            <DataTable
              head={
                <>
                  <Th>Payment</Th>
                  <Th>Expected</Th>
                  <Th>MILP got</Th>
                  <Th>Residual</Th>
                  <Th>MILP</Th>
                  <Th>Greedy</Th>
                </>
              }
            >
              {ev.cases.map((c) => (
                <Row key={c.payment_id}>
                  <Td className="font-mono text-[12px]">{c.payment_id}</Td>
                  <Td>{c.expected.join(", ")}</Td>
                  <Td>{c.milp_got.join(", ")}</Td>
                  <Td className="font-mono text-[12px]">
                    {money(c.milp_residual_cents)}
                  </Td>
                  <Td>
                    <span
                      className={`font-semibold ${c.milp_correct ? "text-ok" : "text-bad"}`}
                    >
                      {c.milp_correct ? "correct" : "miss"}
                    </span>
                  </Td>
                  <Td>{c.greedy_correct ? "correct" : "miss"}</Td>
                </Row>
              ))}
            </DataTable>
            <p className="text-[12px] text-mut mb-0 mt-3">{ev.basis || ""}</p>
          </Panel>
          </Rise>

          <Rise i={3}>
          <Panel
            title="Scenario pack suite"
            sub="Ten full pipeline cases with their expectations stated up front. Each runs the real pipeline on its own clean ledger - a pack passes only when every stated check passes."
          >
            {packs === null ? (
              <p className="text-sm text-mut mb-0 mt-2">
                Running the ten packs...
              </p>
            ) : (
              <DataTable
                head={
                  <>
                    <Th>Pack</Th>
                    <Th>Verdict</Th>
                    <Th>Checks</Th>
                  </>
                }
              >
                {packs.map((p, i) => (
                  <Row key={i}>
                    <Td>{p.title}</Td>
                    <Td>
                      {p.pass === null ? (
                        <span className="text-mut">-</span>
                      ) : (
                        <Pill kind={p.pass ? "ok" : "bad"}>
                          {p.pass ? "Pass" : "Fail"}
                        </Pill>
                      )}
                    </Td>
                    <Td>{p.text}</Td>
                  </Row>
                ))}
              </DataTable>
            )}
          </Panel>
          </Rise>
        </>
      )}
    </>
  );
}
