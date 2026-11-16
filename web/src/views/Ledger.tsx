import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, money } from "../lib/api";
import { useWsRefresh } from "../lib/chrome";
import {
  cubeRows,
  ledgerKpis,
  type ForecastData,
  type ForecastInvoice,
  type Invoice,
  type PaymentStaged,
  type WorkspaceFull,
} from "../lib/insight";
import {
  flashTarget,
  goView,
  setIntent,
  takeIntent,
} from "../lib/operate";
import Panel from "../ui/Panel";
import Pill from "../ui/Pill";
import StatCard from "../ui/StatCard";
import DataTable, { Row, Td, Th } from "../ui/DataTable";
import ViewHead, { LoadError } from "../ui/ViewHead";
import ViewSkeleton from "../ui/Skeleton";
import { GhostBtn, PrimaryBtn } from "../ui/Stage3";
import { RefreshFade, Rise } from "../ui/motion";

/* Stage 2: the Ledger, migrated. Endpoints and figures mirror
   loadLedger() + renderCube() + renderLedgerStaged() in the vanilla
   insight.js / assist.js line for line (lib/insight.ts).
   Stage 5: the vanilla in-place cell editing is restored (invoice
   amount and discount, payment amount, references and remittance -
   cellEdit() in insight.js, same PATCH endpoints, same validation,
   same toasts, and the Update & Re-Run Solver action once edits
   exist), and the casebar's ledger cells land here with the
   scroll + flash vanilla gives them. */

interface LedgerData {
  inv: Invoice[];
  fc: ForecastData;
  ws: WorkspaceFull;
}

/** cellEdit() (insight.js): click a cell, correct it in place, Save
    or Cancel. The save callback owns validation, the PATCH, the
    toast and the reload; a refusal simply closes the editor with
    the old value back in place, as vanilla restores the cell. */
function EditCell({
  display,
  initial,
  area,
  title,
  onSave,
}: {
  display: React.ReactNode;
  initial: string;
  area?: boolean;
  title: string;
  onSave: (v: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(initial);
  const [busy, setBusy] = useState(false);
  if (!editing) {
    return (
      <span
        className="cursor-pointer"
        title={title}
        onClick={() => {
          setVal(initial);
          setEditing(true);
        }}
      >
        {display}
      </span>
    );
  }
  const save = async () => {
    setBusy(true);
    try {
      await onSave(val);
    } catch {
      /* the refusal toast already fired; the old value stays */
    } finally {
      setBusy(false);
      setEditing(false);
    }
  };
  const fieldCls =
    "glass-input border border-line rounded-none px-2 py-1.5 text-[12.5px] text-ink";
  return (
    <span className="inline-flex gap-1.5 items-start flex-wrap">
      {area ? (
        <textarea
          className={fieldCls}
          rows={3}
          style={{ width: 280 }}
          value={val}
          autoFocus
          onChange={(e) => setVal(e.target.value)}
        />
      ) : (
        <input
          className={fieldCls}
          style={{ width: 120 }}
          value={val}
          autoFocus
          onChange={(e) => setVal(e.target.value)}
        />
      )}
      <GhostBtn disabled={busy} onClick={save}>
        Save
      </GhostBtn>
      <GhostBtn disabled={busy} onClick={() => setEditing(false)}>
        Cancel
      </GhostBtn>
    </span>
  );
}

type SortKey = "invoice" | "customer" | "amount" | "due" | null;

export default function Ledger({
  toast,
}: {
  toast: (m: string) => void;
}) {
  const [data, setData] = useState<LedgerData | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>(null);
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [dirty, setDirty] = useState(0);
  const jumpDone = useRef(false);

  const load = useCallback(() => {
    setError("");
    Promise.all([
      api<Invoice[]>("/api/v1/invoices"),
      api<ForecastData>("/api/v1/forecast"),
      api<WorkspaceFull>("/api/v1/workspace"),
    ])
      .then(([inv, fc, ws]) => setData({ inv, fc, ws }))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(load, [load]);
  /* Stage 6 (Item 1): reload when the workspace is replaced. */
  useWsRefresh(load);

  // The casebar cells land on their panel (vanilla gotoLedger*).
  useEffect(() => {
    if (!data || jumpDone.current) return;
    const target = takeIntent("slate-ledger-target");
    if (target) {
      jumpDone.current = true;
      setTimeout(() => {
        flashTarget(
          document.getElementById(
            target === "staged" ? "ledger-staged" : "ledger-invoices"
          )
        );
      }, 350);
    }
  }, [data]);

  // Same-view case: the casebar cell clicked while the Ledger is
  // already active sets the intent without a remount or reload, so
  // poll for it and flash the panel the same way.
  useEffect(() => {
    const t = setInterval(() => {
      const target = sessionStorage.getItem("slate-ledger-target");
      if (!target) return;
      takeIntent("slate-ledger-target");
      setTimeout(() => {
        flashTarget(
          document.getElementById(
            target === "staged" ? "ledger-staged" : "ledger-invoices"
          )
        );
      }, 350);
    }, 600);
    return () => clearInterval(t);
  }, []);

  /* cellEdit()'s save contract: on success the edit counts towards
     the re-run prompt and the ledger reloads; on refusal the toast
     carries the server's (or the validator's) reason. */
  const savedEdit = useCallback(() => {
    setDirty((d) => d + 1);
    toast(
      "Saved to the ledger. Re-run the solver to recompute the matches on the corrected values."
    );
    load();
  }, [load, toast]);

  const patch = useCallback(
    async (path: string, body: Record<string, unknown>) => {
      try {
        await api(path, { method: "PATCH", body: JSON.stringify(body) });
        savedEdit();
      } catch (e) {
        toast(
          "Edit refused: " + (e instanceof Error ? e.message : String(e))
        );
        throw e;
      }
    },
    [savedEdit, toast]
  );

  const saveInvAmount = async (inv: Invoice, v: string) => {
    const c = Math.round(parseFloat(v) * 100);
    if (!(c > 0)) {
      toast("Edit refused: amount must be positive");
      throw new Error("amount must be positive");
    }
    await patch(`/api/v1/invoices/${encodeURIComponent(inv.invoice_id)}`, {
      gross_cents: c,
    });
  };
  const saveInvDiscount = async (inv: Invoice, v: string) => {
    const p = parseFloat(v);
    if (isNaN(p) || p < 0 || p > 90) {
      toast("Edit refused: discount must be between 0 and 90 percent");
      throw new Error("discount range");
    }
    await patch(`/api/v1/invoices/${encodeURIComponent(inv.invoice_id)}`, {
      discount_rate: p / 100,
    });
  };
  const savePayAmount = async (p: PaymentStaged, v: string) => {
    const c = Math.round(parseFloat(v) * 100);
    if (!(c > 0)) {
      toast("Edit refused: amount must be positive");
      throw new Error("amount must be positive");
    }
    await patch(`/api/v1/payments/${encodeURIComponent(p.payment_id)}`, {
      amount_cents: c,
    });
  };
  const savePayRefs = async (p: PaymentStaged, v: string) => {
    const refs = v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    await patch(`/api/v1/payments/${encodeURIComponent(p.payment_id)}`, {
      references: refs,
    });
  };
  const savePayRemit = async (p: PaymentStaged, v: string) => {
    await patch(`/api/v1/payments/${encodeURIComponent(p.payment_id)}`, {
      remittance_text: v,
    });
  };

  const fmap = useMemo(() => {
    const m: Record<string, ForecastInvoice> = {};
    (data?.fc.invoices || []).forEach((d) => (m[d.invoice_id] = d));
    return m;
  }, [data]);

  const rows = useMemo(() => {
    let r = data?.inv || [];
    if (filter) {
      const q = filter.toLowerCase();
      r = r.filter(
        (i) =>
          i.invoice_id.toLowerCase().includes(q) ||
          i.customer.toLowerCase().includes(q) ||
          (i.po_number || "").toLowerCase().includes(q)
      );
    }
    if (sortKey) {
      const k = {
        invoice: (i: Invoice) => i.invoice_id,
        customer: (i: Invoice) => i.customer,
        amount: (i: Invoice) => i.gross_cents,
        due: (i: Invoice) => i.due_in_days,
      }[sortKey];
      r = [...r].sort((a, b) => {
        const x = k(a);
        const y = k(b);
        return (x < y ? -1 : x > y ? 1 : 0) * sortDir;
      });
    }
    return r;
  }, [data, filter, sortKey, sortDir]);

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(k);
      setSortDir(1);
    }
  };
  const sortState = (k: SortKey) =>
    sortKey === k ? (sortDir === 1 ? "asc" : "desc") : null;

  const kpis = data ? ledgerKpis(data.inv) : null;
  const cube = data ? cubeRows(data.inv) : [];
  const pays = data?.ws.all_payments || [];
  const pend = new Set(
    (data?.ws.pending_payments || []).map((p) => p.payment_id)
  );

  return (
    <>
      <ViewHead
        eyebrow="INSIGHT & GOVERNANCE - 06 / LEDGER"
        title="Ledger"
        purpose="The two sides of the equation: open AR ledger and staged wires."
        onRefresh={load}
      />
      {!data && !error && <ViewSkeleton kind="table" />}
      {error && <LoadError error={error} />}
      {data && kpis && (
        <>
          <Rise i={0}>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <StatCard
              label="Open invoices"
              value={kpis.count}
              format={(v) => String(Math.round(v))}
              note="Across all customers"
            />
            <StatCard
              label="Open value"
              value={kpis.totalCents}
              format={(v) => money(Math.round(v))}
              note="Gross receivables awaiting cash"
            />
            <StatCard
              label="Overdue value"
              value={kpis.overdueCents}
              format={(v) => money(Math.round(v))}
              note="Due date already passed"
              sparkColor="#e5484d"
            />
          </div>
          </Rise>

          {cube.length > 0 && (
            <Rise i={1}>
            <Panel title="Cube view - open AR by customer">
              <DataTable
                head={
                  <>
                    <Th>Customer</Th>
                    <Th>Open invoices</Th>
                    <Th>Open AR</Th>
                    <Th>Overdue</Th>
                  </>
                }
              >
                {cube.map((r) => (
                  <Row key={r.customer}>
                    <Td>{r.customer}</Td>
                    <Td>{r.n}</Td>
                    <Td className="font-mono text-[12px]">{money(r.total)}</Td>
                    <Td className="font-mono text-[12px]">{money(r.over)}</Td>
                  </Row>
                ))}
              </DataTable>
            </Panel>
            </Rise>
          )}

          <Rise i={2}>
          <div id="ledger-invoices">
          <Panel
            title="Open invoices (AR ledger)"
            sub={
              filter
                ? `Filter is presentational only: ${rows.length} of ${data.inv.length} rows shown. The figures above are computed from the full ledger, as in the vanilla view.`
                : undefined
            }
          >
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by invoice, customer or PO"
              className="w-full sm:w-[320px] glass-input border border-line rounded-none px-3 py-2 text-[13px] text-ink placeholder:text-mut2 outline-none focus:border-blue mt-2"
            />
            <RefreshFade
              signature={`${data.inv.length}:${kpis.totalCents}:${kpis.overdueCents}`}
            >
            {data.inv.length ? (
              <DataTable
                head={
                  <>
                    <Th onSort={() => toggleSort("invoice")} sorted={sortState("invoice")}>
                      Invoice
                    </Th>
                    <Th onSort={() => toggleSort("customer")} sorted={sortState("customer")}>
                      Customer
                    </Th>
                    <Th>Subsidiary</Th>
                    <Th>PO</Th>
                    <Th onSort={() => toggleSort("amount")} sorted={sortState("amount")}>
                      Amount
                    </Th>
                    <Th>Discount</Th>
                    <Th>Age (d)</Th>
                    <Th onSort={() => toggleSort("due")} sorted={sortState("due")}>
                      Due in (d)
                    </Th>
                    <Th>Pred. delay</Th>
                    <Th>Expected in</Th>
                    <Th>State</Th>
                  </>
                }
              >
                {rows.map((i) => {
                  const d = fmap[i.invoice_id];
                  const risk =
                    d && (d.expected_in_days > 45 || d.prob_within_horizon < 0.5);
                  return (
                    <Row key={i.invoice_id}>
                      <Td className="font-mono text-[12px]">{i.invoice_id}</Td>
                      <Td>{i.customer}</Td>
                      <Td>{i.subsidiary || "-"}</Td>
                      <Td>{i.po_number || "-"}</Td>
                      <Td className="font-mono text-[12px]">
                        <EditCell
                          display={money(i.gross_cents)}
                          initial={(i.gross_cents / 100).toFixed(2)}
                          title="Click to correct this invoice's amount in place"
                          onSave={(v) => saveInvAmount(i, v)}
                        />
                        {i.partial && (
                          <>
                            <br />
                            <small className="text-mut">
                              Partial: {money(i.partial.applied_cents)} applied
                              of {money(i.partial.original_cents)}
                            </small>
                          </>
                        )}
                      </Td>
                      <Td>
                        <EditCell
                          display={
                            i.discount_rate ? `${i.discount_rate * 100}%` : "-"
                          }
                          initial={String(
                            Math.round((i.discount_rate || 0) * 1000) / 10
                          )}
                          title="Click to correct the discount % in place"
                          onSave={(v) => saveInvDiscount(i, v)}
                        />
                      </Td>
                      <Td>{i.age_days}</Td>
                      <Td>{i.due_in_days}</Td>
                      <Td>{d ? `${d.predicted_delay_days}d` : "-"}</Td>
                      <Td>
                        {d
                          ? d.expected_week
                            ? `${d.expected_in_days <= 0 ? "Due now" : Math.round(d.expected_in_days) + "d"} - Wk ${d.expected_week}`
                            : "Beyond 8 wks"
                          : "-"}
                      </Td>
                      <Td>
                        <span className="flex gap-1 flex-wrap">
                          {i.partial && <Pill kind="info">Partially paid</Pill>}
                          {i.due_in_days < 0 ? (
                            <Pill kind="warn">
                              Overdue {Math.abs(i.due_in_days)}d
                            </Pill>
                          ) : (
                            <Pill kind="grey">Open</Pill>
                          )}
                          {risk && <Pill kind="bad">At risk</Pill>}
                        </span>
                      </Td>
                    </Row>
                  );
                })}
              </DataTable>
            ) : (
              <p className="text-sm text-mut mt-3 mb-0">
                The ledger is empty. Load a case or import invoices from the
                Upload Center.
              </p>
            )}
            </RefreshFade>
            {data.inv.length > 0 && (
              <p className="text-[12px] text-mut mb-0 mt-2">
                Click an Amount or Discount % cell to correct it in place,
                then re-run. Settled invoices cannot be edited.
              </p>
            )}
          </Panel>
          </div>
          </Rise>

          <Rise i={3}>
          <div id="ledger-staged">
          <Panel
            title="Staged payments - wires waiting to run"
            sub="The payments staged in the active case, which the next run reconciles against the ledger above. Once they have run, their matches and exceptions are on the Run page."
          >
            {pays.length ? (
              <>
                <DataTable
                  head={
                    <>
                      <Th>Payment</Th>
                      <Th>Payer</Th>
                      <Th>Amount</Th>
                      <Th>References</Th>
                      <Th>Remittance text</Th>
                      <Th>State</Th>
                    </>
                  }
                >
                  {pays.map((p) => (
                    <Row key={p.payment_id}>
                      <Td className="font-mono text-[12px]">{p.payment_id}</Td>
                      <Td>{p.payer_raw}</Td>
                      <Td className="font-mono text-[12px]">
                        <EditCell
                          display={money(p.amount_cents)}
                          initial={(p.amount_cents / 100).toFixed(2)}
                          title="Click to correct this wire's amount in place"
                          onSave={(v) => savePayAmount(p, v)}
                        />
                      </Td>
                      <Td>
                        <EditCell
                          display={
                            (p.references || []).join(", ") || (
                              <small className="text-mut">none</small>
                            )
                          }
                          initial={(p.references || []).join(", ")}
                          title="Click to correct the references in place"
                          onSave={(v) => savePayRefs(p, v)}
                        />
                      </Td>
                      <Td>
                        <EditCell
                          display={
                            <small className="text-mut">
                              {(p.remittance_text || "").slice(0, 90) || "none"}
                            </small>
                          }
                          initial={p.remittance_text || ""}
                          area
                          title="Click to correct the remittance text - on save, its references are re-extracted from the text"
                          onSave={(v) => savePayRemit(p, v)}
                        />
                      </Td>
                      <Td>
                        {pend.has(p.payment_id) ? (
                          <Pill kind="warn">Staged - waiting to run</Pill>
                        ) : (
                          <Pill kind="ok">Run - results on the Run page</Pill>
                        )}
                      </Td>
                    </Row>
                  ))}
                </DataTable>
                {dirty > 0 && (
                  <div className="flex items-center gap-3 flex-wrap mt-3">
                    <PrimaryBtn
                      onClick={() => {
                        setDirty(0);
                        setIntent("slate-run-live", "1");
                        goView("run");
                      }}
                    >
                      Update &amp; Re-Run Solver
                    </PrimaryBtn>
                    <span className="text-[12px] text-mut">
                      {dirty} edit(s) saved to the ledger - the matches still
                      reflect the old values until you re-run.
                    </span>
                  </div>
                )}
                <p className="text-[12px] text-mut mb-0 mt-3">
                  {pays.length} payments in the active case: {pend.size}{" "}
                  waiting to run, {pays.length - pend.size} already run. Click
                  an Amount, References or Remittance cell to correct it in
                  place; a payment a posted match settled refuses the edit.
                </p>
              </>
            ) : (
              <p className="text-sm text-mut mt-3 mb-0">
                Nothing staged. Load a case or import payments in the Upload
                Center and they appear here, ready to run.
              </p>
            )}
          </Panel>
          </div>
          </Rise>
        </>
      )}
    </>
  );
}
