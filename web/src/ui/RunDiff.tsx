import { useCallback, useEffect, useState } from "react";
import { api, type RunSummary } from "../lib/api";
import type { StoredMatch } from "../lib/operate";
import Panel from "./Panel";
import DataTable, { Row, Td, Th } from "./DataTable";
import { GhostBtn } from "./Stage3";

/* Stage 5 restoration: the run comparison, vanilla toggleRunDiff()
   (assist.js). Two runs side by side: straight-through rate,
   auto-posted, exceptions, and the payments whose decision changed
   between them.
   Stage 5D: the panel is mounted by the SHELL, directly under
   the casebar strip - vanilla's #run-diff position - and toggled
   from the casebar's Latest run cell or the Run view's Compare
   runs button; the Run view renders no copy of it. The loading
   line and the fewer-than-two-runs states are vanilla's text
   verbatim, and (as in vanilla) the run selectors and Close
   appear only when there are two runs to compare. */

interface RunSide {
  run: RunSummary;
  matches: StoredMatch[];
}

const stp = (r: RunSummary) =>
  r.payments ? (100 * (r.auto_posted || 0)) / r.payments : 0;

export default function RunDiff({ onClose }: { onClose: () => void }) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [curId, setCurId] = useState("");
  const [prevId, setPrevId] = useState("");
  const [sides, setSides] = useState<{ cur: RunSide; prev: RunSide } | null>(
    null
  );
  const [error, setError] = useState("");

  useEffect(() => {
    api<RunSummary[]>("/api/v1/runs")
      .then((rs) => {
        const list = Array.isArray(rs) ? rs : [];
        setRuns(list);
        if (list.length >= 2) {
          setCurId(list[0].run_id);
          setPrevId(list[1].run_id);
        } else if (list.length === 1) {
          setCurId(list[0].run_id);
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const loadSides = useCallback(async () => {
    if (!runs || !curId || !prevId) return;
    const cur = runs.find((r) => r.run_id === curId);
    const prev = runs.find((r) => r.run_id === prevId);
    if (!cur || !prev) return;
    try {
      const [cm, pm] = await Promise.all([
        api<StoredMatch[]>(`/api/v1/runs/${curId}/matches`),
        api<StoredMatch[]>(`/api/v1/runs/${prevId}/matches`),
      ]);
      setSides({
        cur: { run: cur, matches: cm },
        prev: { run: prev, matches: pm },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [runs, curId, prevId]);

  useEffect(() => {
    loadSides();
  }, [loadSides]);

  const selCls =
    "glass-select border border-line rounded-[3px] px-2 py-1.5 text-[12.5px] text-ink max-w-[280px]";

  let changed: { pid: string; from: string; to: string }[] = [];
  if (sides) {
    const pm = new Map(sides.prev.matches.map((m) => [m.payment_id, m.status]));
    changed = sides.cur.matches
      .filter((m) => pm.has(m.payment_id) && pm.get(m.payment_id) !== m.status)
      .map((m) => ({
        pid: m.payment_id,
        from: pm.get(m.payment_id) || "",
        to: m.status,
      }));
  }

  return (
    <Panel title="Run comparison">
      {error && (
        <p className="text-[13px] text-bad m-0 mt-2 break-words">{error}</p>
      )}
      {!runs && !error && (
        <p className="text-[12.5px] text-mut m-0 mt-2">
          Loading run comparison...
        </p>
      )}
      {runs && runs.length === 0 && (
        <p className="text-[13px] text-mut m-0 mt-3">
          No runs yet - load a case and run the batch first.
        </p>
      )}
      {runs && runs.length === 1 && (
        <p className="text-[13px] text-mut m-0 mt-3">
          Only one run exists so far - run the batch again (or load another
          case and run it) and this compares the two.
        </p>
      )}
      {runs && runs.length >= 2 && (
        <div className="flex gap-2 items-center flex-wrap mt-2">
          <label className="text-[12px] text-mut">
            Current{" "}
            <select
              className={selCls}
              value={curId}
              onChange={(e) => setCurId(e.target.value)}
            >
              {runs.map((r) => (
                <option key={r.run_id} value={r.run_id}>
                  {r.run_id} - {(r.created_at || "").slice(0, 10)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[12px] text-mut">
            Previous{" "}
            <select
              className={selCls}
              value={prevId}
              onChange={(e) => setPrevId(e.target.value)}
            >
              {runs.map((r) => (
                <option key={r.run_id} value={r.run_id}>
                  {r.run_id} - {(r.created_at || "").slice(0, 10)}
                </option>
              ))}
            </select>
          </label>
          <GhostBtn onClick={onClose}>Close</GhostBtn>
        </div>
      )}
      {runs && runs.length >= 2 && !sides && !error && (
        <p className="text-[12.5px] text-mut m-0 mt-3">
          Loading run comparison...
        </p>
      )}
      {sides && (
        <>
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 mt-3">
            <DiffCard
              label="Straight-through rate"
              main={`${stp(sides.prev.run).toFixed(1)}% → ${stp(sides.cur.run).toFixed(1)}%`}
              sub={
                stp(sides.cur.run) - stp(sides.prev.run) === 0
                  ? "no change"
                  : `${stp(sides.cur.run) - stp(sides.prev.run) > 0 ? "+" : ""}${(stp(sides.cur.run) - stp(sides.prev.run)).toFixed(1)} pts`
              }
              good={stp(sides.cur.run) >= stp(sides.prev.run)}
            />
            <DiffCard
              label="Auto-posted"
              main={`${sides.prev.run.auto_posted ?? 0} → ${sides.cur.run.auto_posted ?? 0}`}
              sub={`of ${sides.prev.run.payments ?? 0} → ${sides.cur.run.payments ?? 0} payments`}
            />
            <DiffCard
              label="Exceptions"
              main={`${sides.prev.run.exceptions ?? 0} → ${sides.cur.run.exceptions ?? 0}`}
              sub={
                (sides.cur.run.exceptions ?? 0) <= (sides.prev.run.exceptions ?? 0)
                  ? "fewer or equal"
                  : "more than the previous run"
              }
              good={(sides.cur.run.exceptions ?? 0) <= (sides.prev.run.exceptions ?? 0)}
            />
            <DiffCard
              label="Decision changes"
              main={String(changed.length)}
              sub="payments whose decision differs"
            />
          </div>
          {changed.length ? (
            <DataTable
              head={
                <>
                  <Th>Payment</Th>
                  <Th>Previous decision</Th>
                  <Th>Current decision</Th>
                </>
              }
            >
              {changed.map((c) => (
                <Row key={c.pid}>
                  <Td>{c.pid}</Td>
                  <Td>{c.from}</Td>
                  <Td>{c.to}</Td>
                </Row>
              ))}
            </DataTable>
          ) : (
            <p className="text-[13px] text-mut m-0 mt-3">
              No payment changed decision between these two runs.
            </p>
          )}
        </>
      )}
    </Panel>
  );
}

function DiffCard({
  label,
  main,
  sub,
  good,
}: {
  label: string;
  main: string;
  sub: string;
  good?: boolean;
}) {
  return (
    <div className="glass-card rounded-md border border-white/[0.11] p-3.5">
      <div className="font-mono text-[10px] tracking-[0.08em] uppercase text-mut">
        {label}
      </div>
      <div className="font-display text-[19px] font-semibold mt-1">{main}</div>
      <div
        className={`text-[12px] mt-0.5 ${good === undefined ? "text-mut" : good ? "text-ok" : "text-bad"}`}
      >
        {sub}
      </div>
    </div>
  );
}
