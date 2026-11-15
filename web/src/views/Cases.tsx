import { useCallback, useEffect, useState } from "react";
import { api, money } from "../lib/api";
import {
  goView,
  setIntent,
  type ScenarioFull,
  type WorkspaceOperate,
} from "../lib/operate";
import Panel from "../ui/Panel";
import DataTable, { Row, Td, Th } from "../ui/DataTable";
import Pill from "../ui/Pill";
import ViewHead, { LoadError, Loading } from "../ui/ViewHead";
import { Reveal, Rise } from "../ui/motion";
import { GhostBtn, PrimaryBtn } from "../ui/Stage3";

/* Stage 3: Use Cases (02). Refero/Linear density (blueprint 5): the
   story is cut to three lines with the rest behind the card's own
   expand, "What it proves" stays verbatim, the chips row stays, and
   the Custom Case Builder is promoted above the grid. Staging a case
   posts to the same /cases/:id/load endpoint; running behaves as
   vanilla: load, then the Run view streams the batch. The card keeps
   vanilla's exact two actions - the /scenarios/:id/run check suite
   has no trigger anywhere in the vanilla UI (runCase is defined but
   never invoked), so none is invented here. */

interface CbRow {
  invoice_id: string;
  customer: string;
  amount: string;
  po: string;
  age: string;
  tick: boolean;
}

const cbDefault = (): CbRow[] => [
  { invoice_id: "INV-1", customer: "Apex Manufacturing", amount: "300", po: "PO-1", age: "40", tick: true },
  { invoice_id: "INV-2", customer: "Apex Manufacturing", amount: "200", po: "PO-2", age: "10", tick: true },
  { invoice_id: "INV-3", customer: "Apex Manufacturing", amount: "500", po: "PO-3", age: "25", tick: true },
];

export default function Cases() {
  const [list, setList] = useState<ScenarioFull[] | null>(null);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState("");
  const [note, setNote] = useState("");

  // custom builder
  const [rows, setRows] = useState<CbRow[]>(cbDefault());
  const [payer, setPayer] = useState("Apex Manufacturing");
  const [amount, setAmount] = useState("500");
  const [ded, setDed] = useState("0");
  const [reason, setReason] = useState("");
  const [refs, setRefs] = useState("");
  const [pod, setPod] = useState(false);
  const [cbBusy, setCbBusy] = useState(false);
  const [cbNote, setCbNote] = useState("");

  const load = useCallback(() => {
    setError("");
    api<ScenarioFull[]>("/api/v1/scenarios")
      .then(setList)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(load, [load]);

  const stageCase = async (id: string, run: boolean) => {
    if (busyId) return;
    setBusyId(id);
    setNote("");
    try {
      const d = await api<{
        workspace: WorkspaceOperate;
        payments: unknown[];
        run: { auto_posted: number; payments: number } | null;
      }>(`/api/v1/cases/${id}/load`, { method: "POST" });
      setNote(
        d.run
          ? `Case loaded and run: ${d.run.auto_posted} of ${d.run.payments} payments auto-posted`
          : `Case loaded: ${d.workspace.case?.name} - ${d.workspace.open_invoices} invoices, ${d.payments.length} payments staged`
      );
      if (run && !d.run) setIntent("slate-run-live", "1");
      goView("run");
    } catch (e) {
      setNote("Load failed: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusyId("");
    }
  };

  const cbCalc = () => {
    let sum = 0;
    const ids: string[] = [];
    rows.forEach((r) => {
      if (r.tick) {
        sum += Math.round(parseFloat(r.amount || "0") * 100);
        if (r.invoice_id.trim()) ids.push(r.invoice_id.trim());
      }
    });
    if (!ids.length) {
      setCbNote("Tick at least one invoice row to total");
      return;
    }
    const dedC = Math.round(parseFloat(ded || "0") * 100);
    const wire = Math.max(0, sum - dedC);
    setAmount((wire / 100).toFixed(2));
    setRefs(ids.join(", "));
    setCbNote(
      `Wire total set: ${ids.length} ticked invoice(s) ${money(sum)} minus claimed deduction ${money(dedC)} = ${money(wire)} - an exact, solvable wire`
    );
  };

  const cbRun = async () => {
    const invs = rows
      .map((r) => ({
        invoice_id: r.invoice_id.trim(),
        customer: r.customer.trim() || "UNKNOWN",
        gross_cents: Math.round(parseFloat(r.amount || "0") * 100),
        po_number: r.po.trim() || null,
        age_days: parseInt(r.age || "0", 10),
      }))
      .filter((x) => x.invoice_id && x.gross_cents > 0);
    if (!invs.length) {
      setCbNote("Add at least one invoice with an amount");
      return;
    }
    const pay = {
      payment_id: "CUSTOM-1",
      payer_raw: payer.trim() || "UNKNOWN",
      amount_cents: Math.round(parseFloat(amount || "0") * 100),
      references: refs.split(",").map((x) => x.trim()).filter(Boolean),
      claimed_deduction_cents: Math.round(parseFloat(ded || "0") * 100),
      deduction_reason_raw: reason,
      pod_verified_clean: pod,
      remittance_text: "Custom case from the builder",
    };
    setCbBusy(true);
    try {
      const d = await api<{
        workspace: WorkspaceOperate;
        run: { auto_posted: number; payments: number } | null;
      }>("/api/v1/workspace/load-custom", {
        method: "POST",
        body: JSON.stringify({ invoices: invs, payments: [pay] }),
      });
      setCbNote(
        `Your case is now the active case and it has already run: ${invs.length} invoices and 1 payment${d.run ? `, ${d.run.auto_posted} of ${d.run.payments} auto-posted` : ""}. Taking you to the run - open the match for its full derivation.`
      );
      setTimeout(() => goView("run"), 650);
    } catch (e) {
      setCbNote("Case failed: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setCbBusy(false);
    }
  };

  const inputCls =
    "font-sans text-[13px] px-2.5 py-1.5 rounded-[3px] border border-line2 bg-transparent text-ink w-full box-border";

  return (
    <>
      <ViewHead
        eyebrow="OPERATE - 02 / USE CASES"
        title="Use Cases"
        purpose="Authored scenarios with stated outcomes. Stage one to inspect it, or run it and read the graded verdict."
        onRefresh={load}
      />
      {!list && !error && <Loading label="LOADING THE USE CASES..." />}
      {error && <LoadError error={error} />}
      {note && (
        <p className="text-[13px] m-0 border border-blue/40 bg-[rgba(61,117,232,0.10)] rounded-md px-3 py-2">
          {note}
        </p>
      )}

      {/* ---------- custom case builder, promoted above the grid --- */}
      <Rise i={0}>
        <Panel
          title="Custom Case Builder"
          sub="Build a case the solver can actually solve: invoices on the left, one wire against them. Auto-Calculate sums the ticked invoices minus the claimed deduction."
        >
          <div className="flex flex-col gap-2 mt-3">
            {rows.map((r, i) => (
              <div
                key={i}
                className="grid grid-cols-[1.1fr_1fr_0.8fr_1fr_0.6fr_0.4fr] gap-2 items-center max-lg:grid-cols-2"
              >
                <input
                  className={inputCls}
                  placeholder="Invoice ID"
                  value={r.invoice_id}
                  onChange={(e) =>
                    setRows((rs) =>
                      rs.map((x, j) => (j === i ? { ...x, invoice_id: e.target.value } : x))
                    )
                  }
                />
                <input
                  className={inputCls}
                  placeholder="Customer"
                  value={r.customer}
                  onChange={(e) =>
                    setRows((rs) =>
                      rs.map((x, j) => (j === i ? { ...x, customer: e.target.value } : x))
                    )
                  }
                />
                <input
                  className={inputCls}
                  type="number"
                  placeholder="Amount $"
                  value={r.amount}
                  onChange={(e) =>
                    setRows((rs) =>
                      rs.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x))
                    )
                  }
                />
                <input
                  className={inputCls}
                  placeholder="PO (optional)"
                  value={r.po}
                  onChange={(e) =>
                    setRows((rs) =>
                      rs.map((x, j) => (j === i ? { ...x, po: e.target.value } : x))
                    )
                  }
                />
                <input
                  className={inputCls}
                  type="number"
                  placeholder="Age days"
                  value={r.age}
                  onChange={(e) =>
                    setRows((rs) =>
                      rs.map((x, j) => (j === i ? { ...x, age: e.target.value } : x))
                    )
                  }
                />
                <label
                  className="flex items-center gap-1.5 text-[12px] text-mut cursor-pointer"
                  title="Include this invoice in the auto-calculated wire total"
                >
                  <input
                    type="checkbox"
                    checked={r.tick}
                    onChange={(e) =>
                      setRows((rs) =>
                        rs.map((x, j) => (j === i ? { ...x, tick: e.target.checked } : x))
                      )
                    }
                    className="accent-[#3d75e8] w-4 h-4"
                  />
                  wire
                </label>
              </div>
            ))}
          </div>
          <div className="mt-2">
            <GhostBtn
              onClick={() =>
                setRows((rs) => [
                  ...rs,
                  {
                    invoice_id: `INV-${rs.length + 1}`,
                    customer: "Apex Manufacturing",
                    amount: "",
                    po: "",
                    age: "",
                    tick: true,
                  },
                ])
              }
            >
              Add invoice row
            </GhostBtn>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2.5 mt-4">
            <label className="text-[12px] text-mut flex flex-col gap-1">
              Payer
              <input className={inputCls} value={payer} onChange={(e) => setPayer(e.target.value)} />
            </label>
            <label className="text-[12px] text-mut flex flex-col gap-1">
              Wire amount $
              <input className={inputCls} type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </label>
            <label className="text-[12px] text-mut flex flex-col gap-1">
              Claimed deduction $
              <input className={inputCls} type="number" value={ded} onChange={(e) => setDed(e.target.value)} />
            </label>
            <label className="text-[12px] text-mut flex flex-col gap-1">
              Deduction reason
              <input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            <label className="text-[12px] text-mut flex flex-col gap-1">
              References (comma separated)
              <input className={inputCls} value={refs} onChange={(e) => setRefs(e.target.value)} />
            </label>
            <label className="text-[12px] text-mut flex items-center gap-2 pt-4 cursor-pointer">
              <input
                type="checkbox"
                checked={pod}
                onChange={(e) => setPod(e.target.checked)}
                className="accent-[#3d75e8] w-4 h-4"
              />
              Proof of delivery verified clean
            </label>
          </div>
          <div className="flex gap-2 flex-wrap items-center mt-3.5">
            <GhostBtn onClick={cbCalc}>
              Auto-Calculate Valid Wire Total from Ticked Invoices
            </GhostBtn>
            <span className="text-[12px] text-mut">
              Sums the ticked invoice rows, subtracts the claimed deduction,
              and fills the payment amount and references - so the case you
              build is one the solver can actually solve.
            </span>
          </div>
          <div className="mt-3">
            <PrimaryBtn onClick={cbRun} disabled={cbBusy}>
              Run my case
            </PrimaryBtn>
          </div>
          {cbNote && (
            <p className="text-[13px] text-mut m-0 mt-2.5">{cbNote}</p>
          )}
        </Panel>
      </Rise>

      {/* ---------- scenario grid ---------- */}
      {list && (
        <Rise i={1}>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
            {list.map((s) => {
              const open = expanded.has(s.id);
              return (
                <Panel key={s.id} title={s.title}>
                  <div className="flex gap-1.5 flex-wrap mt-2">
                    <Pill kind="info">{s.invoices} invoices</Pill>
                    <Pill kind="info">{s.payments} payments</Pill>
                    <Pill kind="info">{s.customers} customers</Pill>
                    <Pill kind="grey">{money(s.open_cents)} open AR</Pill>
                    <Pill kind="grey">{money(s.batch_cents)} batch</Pill>
                  </div>
                  {open ? (
                    <Reveal open={open} revealKey={s.id}>
                      <p className="text-[13px] text-mut leading-relaxed m-0 mt-2.5">
                        {s.story}
                      </p>
                    </Reveal>
                  ) : (
                    <p
                      className="text-[13px] text-mut leading-relaxed m-0 mt-2.5"
                      style={{
                        display: "-webkit-box",
                        WebkitLineClamp: 3,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                    >
                      {s.story}
                    </p>
                  )}
                  <button
                    className="bg-transparent border-0 p-0 font-sans text-[12.5px] text-blue2 cursor-pointer hover:underline mt-1"
                    onClick={() =>
                      setExpanded((cur) => {
                        const n = new Set(cur);
                        if (n.has(s.id)) n.delete(s.id);
                        else n.add(s.id);
                        return n;
                      })
                    }
                    aria-expanded={open}
                  >
                    {open ? "Show less" : "Read the full story"}
                  </button>
                  <p className="text-[13px] leading-relaxed m-0 mt-2">
                    <b>What it proves:</b> {s.shows}
                  </p>
                  <div className="flex gap-2 flex-wrap mt-3">
                    <button
                      className="font-sans text-[12.5px] font-medium px-3 py-1.5 rounded-[3px] border border-blue text-white bg-blue hover:bg-[#2f66d6] cursor-pointer disabled:opacity-50 pressable"
                      disabled={!!busyId}
                      onClick={() => stageCase(s.id, false)}
                    >
                      Stage Case (Inspect Before Run)
                    </button>
                    <GhostBtn
                      disabled={!!busyId}
                      onClick={() => stageCase(s.id, true)}
                    >
                      Stage &amp; Run Now
                    </GhostBtn>
                  </div>
                </Panel>
              );
            })}
          </div>
        </Rise>
      )}
      {list && list.length === 0 && (
        <p className="text-[13px] text-mut m-0">No use cases on this server.</p>
      )}
    </>
  );
}
