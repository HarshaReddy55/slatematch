import { useCallback, useEffect, useMemo, useState } from "react";
import { api, money } from "../lib/api";
import {
  cubeRows,
  ledgerKpis,
  type ForecastData,
  type ForecastInvoice,
  type Invoice,
  type WorkspaceFull,
} from "../lib/insight";
import Panel from "../ui/Panel";
import Pill from "../ui/Pill";
import StatCard from "../ui/StatCard";
import DataTable, { Row, Td, Th } from "../ui/DataTable";
import ViewHead, { LoadError, Loading } from "../ui/ViewHead";
import { RefreshFade, Rise } from "../ui/motion";

/* Stage 2: the Ledger, migrated. Endpoints and figures mirror
   loadLedger() + renderCube() + renderLedgerStaged() in the vanilla
   insight.js / assist.js line for line (lib/insight.ts). Read-only:
   the vanilla in-place cell editing is an Operate action and stays
   in the vanilla app in this stage. */

interface LedgerData {
  inv: Invoice[];
  fc: ForecastData;
  ws: WorkspaceFull;
}

type SortKey = "invoice" | "customer" | "amount" | "due" | null;

export default function Ledger() {
  const [data, setData] = useState<LedgerData | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>(null);
  const [sortDir, setSortDir] = useState<1 | -1>(1);

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
      {!data && !error && <Loading label="LOADING THE LEDGER..." />}
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
              className="w-full sm:w-[320px] bg-bg2 border border-line rounded-[3px] px-3 py-2 text-[13px] text-ink placeholder:text-mut2 outline-none focus:border-blue mt-2"
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
                        {money(i.gross_cents)}
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
                        {i.discount_rate ? `${i.discount_rate * 100}%` : "-"}
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
          </Panel>
          </Rise>

          <Rise i={3}>
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
                        {money(p.amount_cents)}
                      </Td>
                      <Td>
                        {(p.references || []).join(", ") || (
                          <small className="text-mut">none</small>
                        )}
                      </Td>
                      <Td>
                        <small className="text-mut">
                          {(p.remittance_text || "").slice(0, 90) || "none"}
                        </small>
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
                <p className="text-[12px] text-mut mb-0 mt-3">
                  {pays.length} payments in the active case: {pend.size}{" "}
                  waiting to run, {pays.length - pend.size} already run.
                </p>
              </>
            ) : (
              <p className="text-sm text-mut mt-3 mb-0">
                Nothing staged. Load a case or import payments in the Upload
                Center and they appear here, ready to run.
              </p>
            )}
          </Panel>
          </Rise>
        </>
      )}
    </>
  );
}
