import { useCallback, useEffect, useRef, useState } from "react";
import { api, authHeaders, money } from "../lib/api";
import {
  AGENT_ALGORITHMS,
  AGENT_SHORT,
  agentCountLine,
  flashTarget,
  goView,
  invariantGrade,
  outcomeShare,
  runChartGeometry,
  setIntent,
  takeIntent,
  toggleRunDiffPanel,
  CHART_COLS,
  CHART_LABELS,
  type AgentRecord,
  type ApprovalEntry,
  type BatchResponse,
  type BriefData,
  type PaymentFull,
  type RunException,
  type StoredMatch,
  type WorkspaceOperate,
} from "../lib/operate";
import { gradeCase, normalisedStored } from "../lib/insight";
import Panel from "../ui/Panel";
import DataTable, { Row, Td, Th } from "../ui/DataTable";
import Pill from "../ui/Pill";
import SlideOver from "../ui/SlideOver";
import ViewSkeleton from "../ui/Skeleton";
import ViewHead, { LoadError } from "../ui/ViewHead";
import { RefreshFade, Reveal, Rise } from "../ui/motion";
import { GhostBtn, JsonBox, PrimaryBtn, StagedTable } from "../ui/Stage3";
import Approvals from "./Approvals";
import Desk from "./Desk";
import MatchDetail from "./MatchDetail";

/* Stage 3: Run Reconciliation (04). Structure follows blueprint 1:
   run summary card (Jeet boot-sequence packaging) with the cumulative
   outcome chart (Shawn, v58 language), the agent strip as beUI
   Agent Activity rows with the evidence payload one click down,
   staged panel and run controls, live streaming lanes driven by the
   same SSE events as vanilla runLive(), case verdict, agent brief,
   matches and exceptions, the approvals queue, and the dispute
   desk. Everything vanilla shows exists here, organised into panels
   instead of one endless scroll. */

interface RunData {
  ws: WorkspaceOperate;
  matches: StoredMatch[];
  exceptions: RunException[];
  agents: AgentRecord[];
  brief: BriefData | null;
  grade: { kind: "case"; runId: string } | { kind: "invariant" } | { kind: "notrun" } | null;
  gradeMatches: StoredMatch[];
  gradeExceptions: RunException[];
  zeroInvoiceApprovals: Record<string, ApprovalEntry>;
}

interface Lane {
  pid: string;
  payer: string;
  amount: number;
  chips: { label: string; cls: string }[];
}

interface LogLine {
  stamp: string;
  segs: { t: string; c?: string }[];
}

const LIVE_DEFS: [string, string][] = [
  ["Capture", "wires received"],
  ["Linking", "candidates narrowed"],
  ["Matching", "wires solved"],
  ["Deduction", "claims judged"],
  ["Policy", "decisions made"],
  ["Briefing", "drafts composed"],
];

export default function Run() {
  const [data, setData] = useState<RunData | null>(null);
  const [error, setError] = useState("");
  const [agentSel, setAgentSel] = useState(2);
  const [algoOpen, setAlgoOpen] = useState(false);
  const [detail, setDetail] = useState<{
    match: StoredMatch;
    payment: PaymentFull | null;
  } | null>(null);
  const [apprReload, setApprReload] = useState(0);
  const [deskReload, setDeskReload] = useState(0);

  // live run state
  const [running, setRunning] = useState(false);
  const [lanes, setLanes] = useState<Lane[] | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [liveSummary, setLiveSummary] = useState<string | null>(null);
  const [liveError, setLiveError] = useState("");
  const [liveStages, setLiveStages] = useState<string[] | null>(null);
  const liveCounts = useRef({ total: 0, resolved: 0, solved: 0, judged: 0, decided: 0 });
  /* Synchronous run guard: the `running` state alone cannot stop a
     double-click - two clicks in one tick (or during the workspace
     fetch, before setRunning lands) both see the pre-click state and
     would start two runs. Vanilla closes this by disabling the
     button synchronously (busyBtn); the ref is the React equivalent,
     the same pattern as Approvals' in-flight guard. */
  const runBusy = useRef(false);
  const t0 = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);
  const intentDone = useRef(false);
  /* Stage 5 restorations: viewing a stored run (Dashboard history),
     the exceptions filter (Dashboard exceptions card) and the
     approvals jump (casebar Approvals cell, palette). The run
     comparison is NOT here: Stage 5D moved it back to the shell
     under the casebar (vanilla's #run-diff position); this view's
     Compare runs button toggles that one panel. */
  const [viewRid, setViewRid] = useState<string | null>(null);
  const viewRidRef = useRef<string | null>(null);
  const [excFilter, setExcFilter] = useState(false);
  const storedDone = useRef(false);
  const filterDone = useRef(false);
  const jumpDone = useRef(false);
  const hlAttempts = useRef(0);

  const load = useCallback(async () => {
    setError("");
    try {
      const ws = await api<WorkspaceOperate>("/api/v1/workspace");
      let matches: StoredMatch[] = [];
      let exceptions: RunException[] = [];
      let agents: AgentRecord[] = [];
      let brief: BriefData | null = null;
      const rid = viewRidRef.current || ws.latest_run?.run_id;
      if (rid) {
        const [m, x, ag] = await Promise.all([
          api<StoredMatch[]>(`/api/v1/runs/${rid}/matches`),
          api<RunException[]>(`/api/v1/runs/${rid}/exceptions`),
          api<{ agents: AgentRecord[] }>(`/api/v1/runs/${rid}/agents`).catch(
            () => ({ agents: [] })
          ),
        ]);
        matches = m;
        exceptions = x;
        agents = ag.agents || [];
        brief = await api<BriefData>(`/api/v1/runs/${rid}/brief`).catch(
          () => null
        );
      }
      // grading, renderGradeFromStored()'s decision tree
      let grade: RunData["grade"] = null;
      let gradeMatches = matches;
      let gradeExceptions = exceptions;
      const c = ws.case;
      if (c && c.expect && Object.keys(c.expect).length) {
        const runs = await api<{ run_id: string }[]>("/api/v1/runs").catch(
          () => []
        );
        let found: { run_id: string; m: StoredMatch[]; x: RunException[] } | null =
          null;
        for (const r of runs.slice(0, 8)) {
          const m = await api<StoredMatch[]>(
            `/api/v1/runs/${r.run_id}/matches`
          ).catch(() => [] as StoredMatch[]);
          if (
            m.some((mm) =>
              Object.prototype.hasOwnProperty.call(c.expect!, mm.payment_id)
            )
          ) {
            const x = await api<RunException[]>(
              `/api/v1/runs/${r.run_id}/exceptions`
            ).catch(() => [] as RunException[]);
            found = { run_id: r.run_id, m, x };
            break;
          }
        }
        if (found) {
          grade = { kind: "case", runId: found.run_id };
          gradeMatches = found.m;
          gradeExceptions = found.x;
        } else {
          grade = { kind: "notrun" };
        }
      } else if (rid) {
        grade = { kind: "invariant" };
      }
      const appr = await api<ApprovalEntry[]>("/api/v1/approvals").catch(
        () => [] as ApprovalEntry[]
      );
      const zeroInvoiceApprovals: Record<string, ApprovalEntry> = {};
      appr.forEach((a) => {
        if (!(a.invoices || []).length) zeroInvoiceApprovals[a.payment_id] = a;
      });
      setData({
        ws,
        matches,
        exceptions,
        agents,
        brief,
        grade,
        gradeMatches,
        gradeExceptions,
        zeroInvoiceApprovals,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /* ---------------- live agent strip (AGENT_LIVE semantics) -------- */
  const stamp = () =>
    (((performance.now() - t0.current) / 1000).toFixed(2) + "s").padStart(6, " ");
  const pushLog = (segs: LogLine["segs"]) =>
    setLog((l) => [...l, { stamp: stamp(), segs }]);

  const liveEvent = (kind: string, n?: number) => {
    const st = liveCounts.current;
    setLiveStages((cur) => {
      const s = cur ? [...cur] : ["running", "queued", "queued", "queued", "queued", "queued"];
      if (kind === "batch_start") {
        if (n && !st.total) st.total = n;
        s[0] = "done";
        s[1] = "running";
      } else if (kind === "resolved") {
        st.resolved++;
        s[1] = "running";
        s[2] = "running";
        if (st.total && st.resolved >= st.total) s[1] = "done";
      } else if (kind === "solved") {
        st.solved++;
        if (st.total && st.solved >= st.total) s[2] = "done";
        if (s[3] === "queued") s[3] = "running";
      } else if (kind === "deduction") {
        st.judged++;
      } else if (kind === "decision") {
        st.decided++;
        if (st.judged < st.decided) st.judged = st.decided;
        s[4] = "running";
        if (st.total && st.decided >= st.total) {
          s[3] = "done";
          s[4] = "done";
          s[5] = "running";
        }
      } else if (kind === "batch_done") {
        return ["done", "done", "done", "done", "done", "running"];
      }
      return s;
    });
  };

  const patchChip = (
    pid: string,
    i: number,
    cls: string,
    label?: string
  ) =>
    setLanes((ls) =>
      (ls || []).map((l) =>
        l.pid !== pid
          ? l
          : {
              ...l,
              chips: l.chips.map((c, j) =>
                j === i ? { label: label ?? c.label, cls } : c
              ),
            }
      )
    );

  /* ---------------- run execution (runLive, same SSE contract) ----- */
  const runLive = useCallback(async () => {
    if (runBusy.current) return;
    runBusy.current = true;
    const ws = await api<WorkspaceOperate>("/api/v1/workspace").catch(
      () => null
    );
    if (!ws || !ws.staged_payments) {
      runBusy.current = false;
      setLiveError(
        "Nothing staged to run. Load a case first - the demo case, a use case, the builder, or your uploaded payments - then run it here, live."
      );
      return;
    }
    setRunning(true);
    setLiveError("");
    setLiveSummary(null);
    setLanes([]);
    setLog([]);
    liveCounts.current = {
      total: (ws.all_payments || []).length,
      resolved: 0,
      solved: 0,
      judged: 0,
      decided: 0,
    };
    setLiveStages(["running", "queued", "queued", "queued", "queued", "queued"]);
    t0.current = performance.now();
    const lanesById = new Map<string, boolean>();
    try {
      const res = await fetch("/api/v1/runs/stream", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ use_workspace: true }),
      });
      if (!res.ok || !res.body) throw new Error("stream failed: " + res.status);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (!raw.startsWith("data: ")) continue;
          const e = JSON.parse(raw.slice(6));
          if (e.type === "batch_start") {
            liveEvent("batch_start", e.payments);
            pushLog([
              { t: "BATCH", c: "text-blue2 font-semibold" },
              { t: ` ${e.run_id} - ${e.payments} payments` },
            ]);
          } else if (e.type === "payment_start") {
            if (!lanesById.has(e.payment_id)) {
              lanesById.set(e.payment_id, true);
              setLanes((ls) => [
                ...(ls || []),
                {
                  pid: e.payment_id,
                  payer: e.payer,
                  amount: e.amount_cents,
                  chips: [
                    { label: "1 RESOLVE", cls: "" },
                    { label: "2 SOLVE", cls: "" },
                    { label: "3 DEDUCTION", cls: "" },
                    { label: "4 DECISION", cls: "" },
                  ],
                },
              ]);
            }
            pushLog([
              { t: `${e.payment_id} received - ${money(e.amount_cents)} from ${e.payer}` },
            ]);
          } else if (e.type === "resolved") {
            liveEvent("resolved");
            patchChip(
              e.payment_id,
              0,
              "done",
              `1 RESOLVED - ${e.matched_by} - ${e.candidates} candidate${e.candidates === 1 ? "" : "s"}`
            );
            pushLog([
              { t: `${e.payment_id} Linking Agent narrowed candidates by ` },
              { t: e.matched_by, c: "text-blue2 font-semibold" },
              { t: ` to ${e.candidates}` },
            ]);
          } else if (e.type === "solved") {
            liveEvent("solved");
            patchChip(
              e.payment_id,
              1,
              e.status === "OPTIMAL_EXACT_MATCH" ? "done" : "on",
              `2 SOLVED - ${e.status} - ${e.latency_ms} ms`
            );
            if (!e.invoices.length)
              patchChip(e.payment_id, 2, "", "3 NO DEDUCTION");
            pushLog([
              {
                t: `${e.payment_id} Matching Agent: ${e.status}, residual ${money(e.residual_cents)}, confidence ${Number(e.confidence).toFixed(2)}, ${e.latency_ms} ms`,
              },
            ]);
          } else if (e.type === "deduction") {
            liveEvent("deduction");
            patchChip(
              e.payment_id,
              2,
              "on",
              `3 DEDUCTION - ${e.decision || "judged"} ${e.reason_code || ""}`
            );
            pushLog([
              { t: `${e.payment_id} Deduction Agent judged: ` },
              { t: e.decision || "", c: "text-blue2 font-semibold" },
              {
                t: ` (${e.reason_code || ""}), z ${e.z_score}, expected recovery $${e.expected_recovery}`,
              },
            ]);
          } else if (e.type === "decision") {
            liveEvent("decision");
            setLanes((ls) =>
              (ls || []).map((l) => {
                if (l.pid !== e.payment_id) return l;
                const chips = l.chips.map((c, j) => ({ ...c }));
                const c3 = chips[2];
                if (
                  c3 &&
                  c3.label.includes("DEDUCTION") &&
                  c3.cls !== "on" &&
                  c3.cls !== "done"
                )
                  c3.label = "3 NO CLAIM";
                chips[3] = {
                  label: `4 ${e.decision}`,
                  cls:
                    e.decision === "AUTO_POSTED"
                      ? "done"
                      : e.decision === "EXCEPTION"
                        ? "bad"
                        : "on",
                };
                return { ...l, chips };
              })
            );
            pushLog([
              { t: `${e.payment_id} Policy Agent decision: ` },
              {
                t: e.decision,
                c:
                  e.decision === "AUTO_POSTED"
                    ? "text-ok font-semibold"
                    : e.decision === "EXCEPTION"
                      ? "text-bad font-semibold"
                      : "text-blue2 font-semibold",
              },
              { t: ` - ${e.reason}` },
            ]);
          } else if (e.type === "batch_done") {
            liveEvent("batch_done");
            setLiveSummary(
              `Run ${e.run_id} complete: ${e.auto_posted} of ${e.payments} auto-posted, touchless ${Math.round((100 * e.auto_posted) / Math.max(e.payments, 1))}% - total engine time ${e.ms} ms. Stored - see it in Dashboard run history.`
            );
            pushLog([
              { t: "DONE", c: "text-ok font-semibold" },
              { t: ` ${e.run_id} in ${e.ms} ms` },
            ]);
          } else if (e.type === "error") {
            pushLog([
              { t: "ERROR", c: "text-bad font-semibold" },
              { t: ` ${e.message}` },
            ]);
          }
        }
      }
    } catch (err) {
      setLiveError(
        `Live stream failed: ${err instanceof Error ? err.message : String(err)}. The stored-run path still works - use Run without streaming.`
      );
    }
    setLiveStages(null);
    setRunning(false);
    runBusy.current = false;
    // A fresh run becomes the viewed run (vanilla lands on it too).
    viewRidRef.current = null;
    setViewRid(null);
    setExcFilter(false);
    await load();
    setApprReload((n) => n + 1);
    setDeskReload((n) => n + 1);
  }, [running, load]);

  /* ---------------- non-streaming run (runWorkspaceBatch) ---------- */
  const runBatch = useCallback(async () => {
    if (runBusy.current) return;
    runBusy.current = true;
    const ws = await api<WorkspaceOperate>("/api/v1/workspace").catch(
      () => null
    );
    const pays = ws?.all_payments || [];
    if (!pays.length) {
      runBusy.current = false;
      setLiveError("Nothing staged to run - load a case or upload payments first");
      return;
    }
    setRunning(true);
    setLiveError("");
    setLiveSummary(null);
    setLanes(null);
    setLog([]);
    liveCounts.current = { total: pays.length, resolved: 0, solved: 0, judged: 0, decided: 0 };
    setLiveStages(["running", "queued", "queued", "queued", "queued", "queued"]);
    const timers = [
      setTimeout(
        () =>
          setLiveStages((s) =>
            s ? ["done", "running", "queued", "queued", "queued", "queued"] : s
          ),
        450
      ),
      setTimeout(
        () =>
          setLiveStages((s) =>
            s ? ["done", "done", "running", "queued", "queued", "queued"] : s
          ),
        1050
      ),
    ];
    try {
      const b = await api<BatchResponse>("/api/v1/batches", {
        method: "POST",
        body: JSON.stringify({
          idempotency_key: "ui-case-" + Date.now(),
          payments: pays,
        }),
      });
      setLiveSummary(
        `Run ${b.run_id} - ${b.payments} payments, ${b.auto_posted} auto-posted, touchless ${(b.touchless_rate * 100).toFixed(1)}%.`
      );
    } catch (e) {
      setLiveError(
        "Run failed: " + (e instanceof Error ? e.message : String(e))
      );
    } finally {
      timers.forEach(clearTimeout);
      setLiveStages(null);
      setRunning(false);
      runBusy.current = false;
      viewRidRef.current = null;
      setViewRid(null);
      setExcFilter(false);
      await load();
      setApprReload((n) => n + 1);
      setDeskReload((n) => n + 1);
    }
  }, [running, load]);

  // Cross-view intent: executeActiveCase() equivalent.
  useEffect(() => {
    if (!data || intentDone.current) return;
    if (takeIntent("slate-run-live") === "1") {
      intentDone.current = true;
      runLive();
    }
  }, [data, runLive]);

  // Cross-view intent: openRun() - the Dashboard history row's run.
  useEffect(() => {
    if (!data || storedDone.current) return;
    const rid = takeIntent("slate-open-run");
    if (rid) {
      storedDone.current = true;
      viewRidRef.current = rid;
      setViewRid(rid);
      load();
    }
  }, [data, load]);

  // Cross-view intent: openRunExceptions() - the Dashboard card.
  useEffect(() => {
    if (!data || filterDone.current) return;
    if (takeIntent("slate-run-filter") === "exceptions") {
      filterDone.current = true;
      setExcFilter(true);
    }
  }, [data]);

  // Cross-view intent: gotoRunStaged()'s row highlight - after the
  // Upload handoff's run lands, wash the just-staged payments' rows.
  // The intent is read once and held until the rows exist (the run
  // it triggers replaces the data first).
  const hlIds = useRef<string[] | null>(null);
  useEffect(() => {
    if (!data) return;
    if (hlIds.current === null && hlAttempts.current === 0) {
      const raw = takeIntent("slate-hl-rows");
      if (raw) hlIds.current = raw.split(",").filter(Boolean);
    }
    const ids = hlIds.current;
    if (!ids || !ids.length) return;
    hlAttempts.current += 1;
    const found = ids
      .map((id) => document.getElementById(`match-row-${id}`))
      .filter((el): el is HTMLElement => !!el);
    if (found.length) {
      // Vanilla adds the wash and leaves it (its CSS transition
      // settles the colour); the class stays on the rows.
      found.forEach((el) => el.classList.add("hl-row"));
      found[0].scrollIntoView({ behavior: "smooth", block: "nearest" });
      hlIds.current = null;
    } else if (hlAttempts.current > 6) {
      hlIds.current = null;
    }
  }, [data]);

  // Cross-view intent: jumpToApprovals() - scroll to the queue and
  // flash it; on a staged case, flash the live run button instead.
  useEffect(() => {
    if (!data || jumpDone.current) return;
    if (takeIntent("slate-jump-approvals")) {
      jumpDone.current = true;
      const stagedNow = data.ws.run_status === "staged";
      setTimeout(() => {
        flashTarget(
          document.getElementById(
            stagedNow ? "run-live-btn" : "approvals-queue"
          )
        );
      }, 400);
    }
  }, [data]);

  // Shell intents can also arrive while this view is already active
  // (the casebar and the palette live in the shell; clicking them
  // does not remount the view or reload its data, so the effects
  // above never re-fire). Poll for late intents and honour them the
  // same way; takeIntent has already removed any the effects above
  // consumed, so nothing fires twice.
  const dataRef = useRef(data);
  dataRef.current = data;
  useEffect(() => {
    const t = setInterval(() => {
      const d = dataRef.current;
      if (!d) return;
      if (sessionStorage.getItem("slate-jump-approvals")) {
        takeIntent("slate-jump-approvals");
        const stagedNow = d.ws.run_status === "staged";
        setTimeout(() => {
          flashTarget(
            document.getElementById(
              stagedNow ? "run-live-btn" : "approvals-queue"
            )
          );
        }, 350);
      }
      const rid = sessionStorage.getItem("slate-open-run");
      if (rid) {
        takeIntent("slate-open-run");
        viewRidRef.current = rid;
        setViewRid(rid);
        load();
      }
      if (sessionStorage.getItem("slate-run-filter") === "exceptions") {
        takeIntent("slate-run-filter");
        setExcFilter(true);
      }
      if (sessionStorage.getItem("slate-run-live") === "1") {
        takeIntent("slate-run-live");
        runLive();
      }
    }, 600);
    return () => clearInterval(t);
  }, [load, runLive]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  const ws = data?.ws;
  const pending = ws?.pending_payments || [];
  const staged = ws?.staged_payments || 0;
  const latestRun = ws?.latest_run;
  /* The run this page is showing: the latest, or a stored run opened
     from the Dashboard history. */
  const shownRunId = viewRid || latestRun?.run_id || null;
  const storedMode = !!(
    viewRid &&
    latestRun &&
    viewRid !== latestRun.run_id
  );
  /* openRunExceptions()'s filter: exception rows plus the matches
     whose deduction the agent turned into a dispute claim. */
  const excPids = new Set((data?.exceptions || []).map((e) => e.payment_id));
  const shownMatches =
    excFilter && data
      ? data.matches.filter(
          (m) =>
            excPids.has(m.payment_id) ||
            m.result?.deduction?.autonomous_action ===
              "AUTO_GENERATE_DISPUTE_CLAIM"
        )
      : data?.matches || [];

  const mutateFirstWire = async () => {
    if (runBusy.current) return;
    const w = pending[0];
    if (!w) return;
    if (w.amount_cents <= 50000) {
      setLiveError("That wire is too small to short-pay by $500");
      return;
    }
    runBusy.current = true;
    try {
      await api(`/api/v1/payments/${w.payment_id}`, {
        method: "PATCH",
        body: JSON.stringify({ amount_cents: w.amount_cents - 50000 }),
      });
      await load();
    } catch (e) {
      setLiveError(e instanceof Error ? e.message : String(e));
    } finally {
      runBusy.current = false;
    }
  };

  const parkException = async (pid: string) => {
    const a = data?.zeroInvoiceApprovals[pid];
    if (!a) return;
    try {
      await api(`/api/v1/matches/${a.match_id}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "approve" }),
      });
      await load();
      setApprReload((n) => n + 1);
    } catch (e) {
      setLiveError(e instanceof Error ? e.message : String(e));
    }
  };

  const openEvidence = async (a: ApprovalEntry) => {
    try {
      const ms = await api<StoredMatch[]>(`/api/v1/runs/${a.run_id}/matches`);
      const m = ms.find((x) => x.payment_id === a.payment_id);
      if (m)
        setDetail({
          match: m,
          payment:
            (data?.ws.all_payments || []).find(
              (p) => p.payment_id === a.payment_id
            ) ||
            m.result?.payment ||
            null,
        });
    } catch {
      /* the queue row stays; the error surfaces on next load */
    }
  };

  const chart =
    data && data.matches.length >= 2
      ? runChartGeometry(
          data.matches.map((m) => ({
            status: m.status,
            auto_posted: m.result?.auto_posted,
          }))
        )
      : null;

  const gradeResult =
    data?.grade?.kind === "case" && data.ws.case
      ? gradeCase(
          data.ws.case,
          normalisedStored(data.gradeMatches),
          data.gradeExceptions
        )
      : null;
  const invariant =
    data?.grade?.kind === "invariant"
      ? invariantGrade(
          data.matches.map((m) => ({
            payment_id: m.payment_id,
            lines: m.result?.lines,
            residual_cents: m.residual_cents,
            payment: m.result?.payment || null,
          })),
          data.ws.all_payments || []
        )
      : null;

  const liveCountsNow = liveCounts.current;

  return (
    <>
      <ViewHead
        eyebrow="OPERATE - 04 / RUN RECONCILIATION"
        title="Run Reconciliation"
        purpose="Running settles these payments against the active ledger. Dashboard, Ledger, approvals and forecast update from the same run."
        onRefresh={load}
      />
      {!data && !error && <ViewSkeleton kind="run" />}
      {error && <LoadError error={error} />}

      {data && (
        <>
          {/* ---------- run summary card (Jeet packaging) ---------- */}
          <Rise i={0}>
            <Panel title="Run record">
              {shownRunId ? (
                <>
                  {excFilter ? (
                    <div className="flex items-center gap-3 flex-wrap mt-1">
                      <p className="text-[13px] m-0">
                        Filtered: exception and disputed rows of run{" "}
                        <b className="font-mono">{shownRunId}</b> -{" "}
                        {shownMatches.length} of {data.matches.length} matches
                        shown, {data.exceptions.length} exceptions below.
                      </p>
                      <GhostBtn onClick={() => setExcFilter(false)}>
                        Clear filter
                      </GhostBtn>
                    </div>
                  ) : (
                    <>
                      <p className="text-[13px] m-0 mt-1">
                        Run <b className="font-mono">{shownRunId}</b> -{" "}
                        {data.matches.length} matches, {data.exceptions.length}{" "}
                        exceptions. Select a match for its evidence.
                      </p>
                      <div className="flex gap-2 items-center flex-wrap mt-2">
                        <GhostBtn onClick={() => toggleRunDiffPanel()}>
                          Compare runs
                        </GhostBtn>
                        {storedMode && (
                          <>
                            <span className="text-[12px] text-mut">
                              You are viewing a stored run from the Dashboard
                              history; the workspace's live state is
                              unchanged.
                            </span>
                            <GhostBtn
                              onClick={() => {
                                viewRidRef.current = null;
                                setViewRid(null);
                                load();
                              }}
                            >
                              Back to latest run
                            </GhostBtn>
                          </>
                        )}
                      </div>
                    </>
                  )}
                  {chart && !excFilter && (
                    <div className="mt-3">
                      <svg
                        viewBox={`0 0 ${chart.W} ${chart.H}`}
                        preserveAspectRatio="none"
                        className="w-full h-[116px]"
                        role="img"
                        aria-label="Cumulative run outcomes"
                      >
                        <defs>
                          {CHART_COLS.map((h, c) => (
                            <g key={c}>
                              <linearGradient
                                id={`rcg${c}`}
                                x1="0"
                                y1="0"
                                x2="0"
                                y2="1"
                              >
                                <stop offset="0" stopColor={h} stopOpacity="0.20" />
                                <stop offset="1" stopColor={h} stopOpacity="0" />
                              </linearGradient>
                              <pattern
                                id={`rcd${c}`}
                                width="7"
                                height="7"
                                patternUnits="userSpaceOnUse"
                              >
                                <circle cx="1.6" cy="1.6" r="1.1" fill={h} fillOpacity="0.38" />
                              </pattern>
                            </g>
                          ))}
                        </defs>
                        {chart.grid.map((y, i) => (
                          <line
                            key={i}
                            x1="4"
                            x2="594"
                            y1={y}
                            y2={y}
                            stroke="rgba(255,255,255,.055)"
                            strokeWidth="1"
                            strokeDasharray="2 5"
                          />
                        ))}
                        {chart.series.map((s, c) => (
                          <g key={c}>
                            <path d={s.fill} fill={`url(#rcg${c})`} stroke="none" />
                            <path d={s.fill} fill={`url(#rcd${c})`} stroke="none" />
                            <path
                              d={s.d}
                              fill="none"
                              stroke={CHART_COLS[c]}
                              strokeWidth="2"
                              strokeLinejoin="round"
                              strokeLinecap="round"
                            />
                            <circle cx={s.endX} cy={s.endY} r="7" fill={CHART_COLS[c]} opacity="0.18" />
                            <circle cx={s.endX} cy={s.endY} r="3" fill={CHART_COLS[c]} />
                            <circle cx={s.endX} cy={s.endY} r="1.2" fill="#ffffff" opacity="0.85" />
                          </g>
                        ))}
                      </svg>
                      <div className="flex gap-4 flex-wrap mt-1.5 text-[12px]">
                        {chart.series.map((s, c) => (
                          <span key={c}>
                            <span
                              className="inline-block w-2 h-2 rounded-full mr-1.5"
                              style={{ background: CHART_COLS[c] }}
                            />
                            <b style={{ color: CHART_COLS[c] }}>
                              {CHART_LABELS[c]} {s.count}
                            </b>
                          </span>
                        ))}
                        <span className="text-mut">
                          payments in run order, cumulative
                        </span>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <p className="text-[13px] text-mut m-0 mt-1">
                  {ws?.case
                    ? "No run yet on this workspace. The case is staged below - run it live and every panel on this page fills from the run itself."
                    : "No case is loaded. Load the demo case or a use case, build one, or upload your own files, and this page works on that same data."}
                </p>
              )}
              {liveSummary && (
                <p className="text-[13px] m-0 mt-2.5 border border-ok/40 bg-okbg rounded-md px-3 py-2">
                  {liveSummary}
                </p>
              )}
              {liveError && (
                <p className="text-[13px] m-0 mt-2.5 border border-bad/40 bg-badbg rounded-md px-3 py-2 break-words">
                  {liveError}
                </p>
              )}
            </Panel>
          </Rise>

          {/* ---------- agent strip ---------- */}
          <Rise i={1}>
            <Panel title="The agent team on this run">
              {liveStages ? (
                <>
                  <div className="flex gap-2 flex-wrap items-stretch mt-3">
                    {LIVE_DEFS.map(([name, sub], i) => {
                      const st = liveStages[i];
                      const counts = [
                        liveCountsNow.total
                          ? `${liveCountsNow.total} wires in`
                          : sub,
                        liveCountsNow.resolved
                          ? `${liveCountsNow.resolved} resolved`
                          : sub,
                        liveCountsNow.total
                          ? `${liveCountsNow.solved} of ${liveCountsNow.total} solved`
                          : sub,
                        liveCountsNow.judged
                          ? `${liveCountsNow.judged} judged`
                          : sub,
                        liveCountsNow.total
                          ? `${liveCountsNow.decided} of ${liveCountsNow.total} decided`
                          : sub,
                        sub,
                      ];
                      return (
                        <div key={name} className="flex items-stretch gap-2">
                          {i > 0 && (
                            <span className="self-center text-mut2">→</span>
                          )}
                          <div className="glass-card rounded-md border border-white/[0.11] px-3 py-2.5 min-w-[128px]">
                            <b className="text-[13px]">{name}</b>
                            <div className="text-[12px] text-mut">{counts[i]}</div>
                            <div className="text-[12px] text-mut">
                              {st === "running"
                                ? "working..."
                                : st === "done"
                                  ? "done"
                                  : st === "ondemand"
                                    ? "composes on demand"
                                    : "waiting"}
                            </div>
                            <div className="mt-1">
                              {st === "done" ? (
                                <Pill kind="ok">Completed</Pill>
                              ) : st === "running" ? (
                                <Pill kind="info">Running</Pill>
                              ) : st === "ondemand" ? (
                                <Pill kind="info">On demand</Pill>
                              ) : (
                                <Pill kind="grey">Queued</Pill>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-[12px] text-mut m-0 mt-2">
                    Live progress from the run itself - when the run lands,
                    this strip becomes the run's permanent record with its
                    measured timings.
                  </p>
                </>
              ) : data.agents.length ? (
                <>
                  <div className="flex gap-2 flex-wrap items-stretch mt-3">
                    {data.agents.map((a, i) => (
                      <div key={a.agent} className="flex items-stretch gap-2">
                        {i > 0 && (
                          <span className="self-center text-mut2">→</span>
                        )}
                        <button
                          className={`glass-card text-left rounded-md border px-3 py-2.5 min-w-[128px] cursor-pointer pressable ${
                            agentSel === i
                              ? "border-blue"
                              : "border-white/[0.11]"
                          }`}
                          onClick={() => setAgentSel(i)}
                        >
                          <b className="text-[13px]">
                            {AGENT_SHORT[a.agent] || a.agent}
                          </b>
                          <div className="text-[12px] text-mut">
                            {agentCountLine(a)}
                          </div>
                          <div className="text-[12px] text-mut">
                            {a.status === "ON_DEMAND"
                              ? "composes on demand"
                              : `${a.latency_ms} ms measured`}
                          </div>
                          <div className="mt-1">
                            <Pill
                              kind={a.status === "COMPLETED" ? "ok" : "info"}
                            >
                              {a.status === "COMPLETED"
                                ? "Completed"
                                : a.status === "ON_DEMAND"
                                  ? "On demand"
                                  : a.status}
                            </Pill>
                          </div>
                        </button>
                      </div>
                    ))}
                  </div>
                  <p className="font-mono text-[10.5px] tracking-[0.06em] text-mut m-0 mt-3">
                    RUN RECORD - {data.agents.length} AGENTS -{" "}
                    {data.agents
                      .reduce((a, x) => a + (x.latency_ms || 0), 0)
                      .toFixed(2)}{" "}
                    MS MEASURED ACROSS THE PIPELINE
                  </p>
                  <p className="text-[12px] text-mut m-0 mt-1">
                    This strip is the run's permanent record: timings and
                    payloads are the steps the engine recorded while it
                    executed - click an agent to inspect what it handed on.
                  </p>
                  <Reveal
                    open={!!data.agents[agentSel]}
                    revealKey={data.agents[agentSel]?.agent || "none"}
                  >
                    {data.agents[agentSel] && (
                      <div className="mt-3">
                        <p className="text-[13px] m-0 mb-2">
                          <b>{data.agents[agentSel].agent}</b> - status{" "}
                          {data.agents[agentSel].status}, measured time{" "}
                          {data.agents[agentSel].latency_ms} ms on this run.{" "}
                          <b>The payload it handed to the next agent:</b>
                        </p>
                        <JsonBox
                          text={JSON.stringify(
                            data.agents[agentSel].evidence,
                            null,
                            2
                          )}
                        />
                      </div>
                    )}
                  </Reveal>
                </>
              ) : (
                <p className="text-[13px] text-mut m-0 mt-2">
                  {latestRun
                    ? "This run predates agent pipeline recording. Run the batch again and each agent's timing and payload will be inspectable here."
                    : "The agent team on this run: five agents work in sequence and Briefing composes on demand. Run the case and this strip lights up live, then becomes the run's permanent record with measured timings - click any agent to inspect what it handed on."}
                </p>
              )}
              <div className="mt-3">
                <GhostBtn onClick={() => setAlgoOpen(!algoOpen)}>
                  ⓘ View 6-Agent Algorithms &amp; KPI Definitions {algoOpen ? "▴" : "▾"}
                </GhostBtn>
                <Reveal open={algoOpen} revealKey="algos">
                  <p className="text-[13px] text-mut m-0 mt-2">
                    Six named agents, each with its algorithm and the KPI it
                    is judged on, printed in the open. Watch them work in the
                    live lanes below.
                  </p>
                  <DataTable
                    head={
                      <>
                        <Th>Agent</Th>
                        <Th>Algorithm</Th>
                        <Th>Judged on</Th>
                      </>
                    }
                  >
                    {AGENT_ALGORITHMS.map(([a, alg, kpi]) => (
                      <Row key={a}>
                        <Td>
                          <b>{a}</b>
                        </Td>
                        <Td>{alg}</Td>
                        <Td>{kpi}</Td>
                      </Row>
                    ))}
                  </DataTable>
                </Reveal>
              </div>
            </Panel>
          </Rise>

          {/* ---------- staged panel + run controls + live lanes ----- */}
          <Rise i={2}>
            <Panel
              title="Staged payments - the active case"
              sub="Running settles these payments against the active ledger. Dashboard, Ledger, approvals and forecast update from the same run."
            >
              {!ws?.case && !staged ? (
                <p className="text-[13px] text-mut m-0 mt-2">
                  No case is loaded. Load the demo case or a use case, build
                  one in Use Cases, or upload files - the staged payments
                  will appear here, ready to run.
                </p>
              ) : !pending.length ? (
                <p className="text-[13px] text-mut m-0 mt-2">
                  All {staged} staged payments of this case have been run
                  {latestRun ? (
                    <>
                      {" "}
                      - latest run <b>{latestRun.run_id}</b> is in the record
                      above and on the Dashboard
                    </>
                  ) : (
                    ""
                  )}
                  . Load another case or reset the workspace to run again.
                </p>
              ) : (
                <>
                  <StagedTable pays={pending} />
                  <p className="text-[13px] m-0 mt-3">
                    <b>Live proof:</b>{" "}
                    <GhostBtn onClick={mutateFirstWire} disabled={running}>
                      ⚡ Test Live Mutation: Short-Pay {pending[0].payment_id}{" "}
                      by $500
                    </GhostBtn>{" "}
                    <span className="text-[12px] text-mut">
                      Edits that wire in the real ledger (amount{" "}
                      {money(pending[0].amount_cents)} →{" "}
                      {money(pending[0].amount_cents - 50000)}), then run the
                      solver and watch its verdict change. Amount and
                      remittance are also editable per wire in the Ledger
                      (06).
                    </span>
                  </p>
                  <p className="text-[12px] text-mut m-0 mt-1">
                    {pending.length} of {staged} staged payments are waiting
                    to run.
                  </p>
                </>
              )}
              <div className="flex gap-2 flex-wrap mt-3.5">
                <PrimaryBtn id="run-live-btn" onClick={runLive} disabled={running}>
                  {running ? "Solving MILP & matching payments..." : "Run the active case live"}
                </PrimaryBtn>
                <GhostBtn onClick={runBatch} disabled={running}>
                  Run without streaming
                </GhostBtn>
                <GhostBtn onClick={() => goView("upload")}>
                  Upload different files
                </GhostBtn>
              </div>
              {lanes !== null && (
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 mt-4 items-start">
                  <div className="flex flex-col gap-2">
                    {lanes.map((l) => (
                      <div
                        key={l.pid}
                        className="glass-card rounded-md border border-white/[0.11] px-3 py-2.5"
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-[13px]">
                            <b>{l.pid}</b> - {l.payer}
                          </span>
                          <span className="font-mono text-[12px] text-mut">
                            {money(l.amount)}
                          </span>
                        </div>
                        <div className="flex gap-1.5 flex-wrap mt-2">
                          {l.chips.map((c, j) => (
                            <span
                              key={j}
                              className={`font-mono text-[10.5px] px-2 py-[3px] rounded-[2px] whitespace-nowrap ${
                                c.cls === "done"
                                  ? "text-ok bg-okbg"
                                  : c.cls === "bad"
                                    ? "text-bad bg-badbg"
                                    : c.cls === "on"
                                      ? "text-blue2 bg-[rgba(61,117,232,.13)]"
                                      : "text-mut bg-white/[0.06]"
                              }`}
                            >
                              {c.label}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div
                    ref={logRef}
                    className="font-mono text-[11.5px] leading-[1.7] bg-black/35 border border-white/[0.08] rounded-md p-3 overflow-y-auto max-h-[420px]"
                  >
                    {log.map((l, i) => (
                      <div key={i}>
                        <span className="text-mut2">{l.stamp} </span>
                        {l.segs.map((s, j) => (
                          <span key={j} className={s.c}>
                            {s.t}
                          </span>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Panel>
          </Rise>

          {/* ---------- verdict ---------- */}
          {gradeResult && data.ws.case && (
            <Rise i={3}>
              <Panel title={`Case verdict - ${data.ws.case.name}`}>
                <p
                  className={`text-[13px] font-medium m-0 mt-1 rounded-md px-3 py-2 border ${
                    gradeResult.allPass
                      ? "border-ok/40 bg-okbg text-ok"
                      : "border-bad/40 bg-badbg text-bad"
                  }`}
                >
                  {gradeResult.allPass
                    ? "All checks passed - the workspace run did exactly what this case promises."
                    : "Some checks failed - the evidence below is the honest result."}
                </p>
                {data.grade?.kind === "case" && (
                  <p className="text-[12px] text-mut m-0 mt-2">
                    Graded against run {data.grade.runId} - the run that
                    processed this case's payments.
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
                  {gradeResult.rows.map((r, i) => (
                    <Row key={i}>
                      <Td>{r.label}</Td>
                      <Td>
                        <span className="font-mono text-[12px]">{r.expected}</span>
                      </Td>
                      <Td>
                        <span className="font-mono text-[12px]">{r.actual}</span>
                      </Td>
                      <Td>
                        <span className={r.pass ? "text-ok font-semibold" : "text-bad font-semibold"}>
                          {r.pass ? "PASS" : "FAIL"}
                        </span>
                      </Td>
                    </Row>
                  ))}
                </DataTable>
                {data.ws.case.policy_note && (
                  <p className="text-[12px] text-mut m-0 mt-2">
                    {data.ws.case.policy_note}
                  </p>
                )}
              </Panel>
            </Rise>
          )}
          {data.grade?.kind === "notrun" && data.ws.case && (
            <Rise i={3}>
              <Panel title={`Case verdict - ${data.ws.case.name}`}>
                <p className="text-[13px] text-mut m-0 mt-1">
                  This case states its expected outcomes up front, but its
                  payments have not been run in this workspace yet. Run the
                  active case above and the graded verdict will appear here.
                </p>
              </Panel>
            </Rise>
          )}
          {invariant && invariant.rows.length > 0 && (
            <Rise i={3}>
              <Panel title="Grading - cash conservation invariants">
                <p className="text-[13px] text-mut leading-relaxed m-0 mt-1">
                  This case carries no pre-written answer key (it was
                  uploaded or built, not authored), so it is graded on the
                  invariant every correct cash application must satisfy:
                  allocated invoices + claimed deductions + declared residual
                  = the wire amount, payment by payment.{" "}
                  <b className="text-ink">
                    {invariant.pass} of {invariant.rows.length} payments
                    conserve exactly.
                  </b>
                </p>
                <DataTable
                  head={
                    <>
                      <Th>Payment</Th>
                      <Th>Allocated</Th>
                      <Th>Deduction</Th>
                      <Th>Residual</Th>
                      <Th>Wire</Th>
                      <Th>Invariant</Th>
                    </>
                  }
                >
                  {invariant.rows.map((r) => (
                    <Row key={r.payment_id}>
                      <Td>{r.payment_id}</Td>
                      <Td>{money(r.alloc)}</Td>
                      <Td>{money(r.ded)}</Td>
                      <Td>{money(r.residual)}</Td>
                      <Td>{money(r.wire)}</Td>
                      <Td>
                        {r.holds ? (
                          <Pill kind="ok">Conserves</Pill>
                        ) : (
                          <Pill kind="bad">Does not conserve</Pill>
                        )}
                      </Td>
                    </Row>
                  ))}
                </DataTable>
              </Panel>
            </Rise>
          )}

          {/* ---------- brief ---------- */}
          {data.brief && shownRunId && (
            <Rise i={4}>
              <Panel title={`Agent brief - run ${shownRunId}`}>
                <div className="text-[13px] leading-relaxed mt-1">
                  <b>{data.brief.headline}</b>
                  {(data.brief.body || []).map((x, i) => (
                    <div key={i}>{x}</div>
                  ))}
                  <div className="mt-2.5">
                    <b>Next actions:</b>
                    {(data.brief.next_actions || []).map((a, i) => (
                      <div key={i}>· {a}</div>
                    ))}
                  </div>
                  <div className="mt-2.5">
                    <Pill kind="info">
                      {data.brief.source === "gemini"
                        ? "Written by Gemini from run records"
                        : "Composed from run records - grounded template"}
                    </Pill>
                  </div>
                  <div className="mt-3 flex items-center gap-2.5 flex-wrap">
                    <GhostBtn onClick={() => goView("sap")}>
                      View SAP S/4HANA BAPI &amp; EBRR Payloads →
                    </GhostBtn>
                    <span className="text-[12px] text-mut">
                      Every cleared payment's balanced DZ clearing journal
                      and the ASC 606 dispute reserve, generated live by
                      erp_sap.py from this case's matches.
                    </span>
                  </div>
                </div>
              </Panel>
            </Rise>
          )}

          {/* ---------- matches + exceptions ---------- */}
          {shownRunId && (
            <Rise i={5}>
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
                <Panel title="Matches">
                  {shownMatches.length ? (
                    <RefreshFade
                      signature={shownMatches
                        .map((m) => m.payment_id + m.status)
                        .join(",")}
                    >
                      <DataTable
                        head={
                          <>
                            <Th>Payment</Th>
                            <Th>Decision</Th>
                            <Th>Solver</Th>
                            <Th>Matched invoices</Th>
                            <Th>Allocated cash</Th>
                            <Th>Residual</Th>
                            <Th>Conf.</Th>
                          </>
                        }
                      >
                        {shownMatches.map((m) => {
                          const alloc = (m.result?.lines || []).reduce(
                            (a, l) => a + l.net_cents,
                            0
                          );
                          const share = outcomeShare(alloc, m.residual_cents);
                          const cls = m.status === "AUTO_POSTED" ? 0 : m.status === "PROPOSED" ? 1 : 2;
                          return (
                            <Row key={m.payment_id} id={`match-row-${m.payment_id}`}>
                              <Td>
                                <button
                                  className="bg-transparent border-0 p-0 font-sans text-[13px] text-blue2 cursor-pointer hover:underline"
                                  onClick={() =>
                                    setDetail({
                                      match: m,
                                      payment:
                                        (ws?.all_payments || []).find(
                                          (p) => p.payment_id === m.payment_id
                                        ) ||
                                        m.result?.payment ||
                                        null,
                                    })
                                  }
                                >
                                  {m.payment_id}
                                </button>
                              </Td>
                              <Td>
                                <Pill kind={m.status === "AUTO_POSTED" ? "ok" : "warn"}>
                                  {m.status}
                                </Pill>
                              </Td>
                              <Td>{m.solver || "-"}</Td>
                              <Td>
                                {(m.result?.lines || [])
                                  .map((l) => l.invoice_id)
                                  .join(", ") || "-"}
                              </Td>
                              <Td>
                                {money(alloc)}
                                <div
                                  className="h-[5px] rounded bg-white/[0.07] overflow-hidden flex mt-1"
                                  title={`Explained ${Math.round(share * 100)}% - allocated cash against the residual left open`}
                                >
                                  <span
                                    className={
                                      cls === 0
                                        ? "bg-ok block h-full"
                                        : cls === 1
                                          ? "bg-warn block h-full"
                                          : "bg-blue block h-full"
                                    }
                                    style={{ width: `${Math.round(share * 100)}%` }}
                                  />
                                </div>
                              </Td>
                              <Td>{money(m.residual_cents)}</Td>
                              <Td>{Number(m.confidence ?? 0).toFixed(2)}</Td>
                            </Row>
                          );
                        })}
                      </DataTable>
                    </RefreshFade>
                  ) : (
                    <p className="text-[13px] text-mut m-0 mt-2">
                      No matches stored for this run.
                    </p>
                  )}
                </Panel>
                <Panel title="Exceptions">
                  {data.exceptions.length ? (
                    <DataTable
                      head={
                        <>
                          <Th>Payment</Th>
                          <Th>Kind</Th>
                          <Th>Severity</Th>
                          <Th>Recommended action</Th>
                          <Th>Actions</Th>
                        </>
                      }
                    >
                      {data.exceptions.map((e) => (
                        <Row key={e.payment_id + e.kind}>
                          <Td>{e.payment_id}</Td>
                          <Td>
                            <Pill kind="warn">{e.kind}</Pill>
                          </Td>
                          <Td>{e.severity}</Td>
                          <Td>{e.recommended_action}</Td>
                          <Td>
                            <span className="flex gap-1.5 flex-wrap">
                              {data.zeroInvoiceApprovals[e.payment_id] && (
                                <GhostBtn
                                  onClick={() => parkException(e.payment_id)}
                                >
                                  Park in Unapplied Suspense GL
                                </GhostBtn>
                              )}
                              <GhostBtn
                                onClick={() => {
                                  setIntent("slate-mail-cat", "chases");
                                  setIntent("slate-mail-focus", e.payment_id);
                                  goView("mail");
                                }}
                              >
                                Remittance inquiry
                              </GhostBtn>
                              <GhostBtn onClick={() => goView("ledger")}>
                                Manual split in Ledger
                              </GhostBtn>
                            </span>
                          </Td>
                        </Row>
                      ))}
                    </DataTable>
                  ) : (
                    <p className="text-[13px] text-mut m-0 mt-2">
                      No exceptions. Clean run.
                    </p>
                  )}
                </Panel>
              </div>
            </Rise>
          )}

          {/* ---------- approvals ---------- */}
          <Rise i={6}>
            <div id="approvals-queue">
              <Approvals
                reloadSignal={apprReload}
                onEvidence={openEvidence}
                onDecided={() => {
                  load();
                }}
              />
            </div>
          </Rise>

          {/* ---------- dispute desk ---------- */}
          {shownRunId && (
            <Rise i={7}>
              <Desk
                matches={data.matches}
                exceptions={data.exceptions}
                reloadSignal={deskReload}
              />
            </Rise>
          )}
        </>
      )}

      <SlideOver
        open={!!detail}
        title={detail ? `Match evidence - ${detail.match.payment_id}` : ""}
        onClose={() => setDetail(null)}
      >
        {detail && (
          <MatchDetail match={detail.match} payment={detail.payment} />
        )}
      </SlideOver>
    </>
  );
}
