import { useCallback, useEffect, useState } from "react";
import { api, money, type MatchRecord } from "../lib/api";
import {
  disputeClaims,
  drillRows,
  fanChart,
  fmtDelta,
  type CollectionRow,
  type DisputeClaim,
  type ForecastData,
  type WhatifResult,
  type WorkspaceFull,
} from "../lib/insight";
import Panel from "../ui/Panel";
import StatCard from "../ui/StatCard";
import DataTable, { Row, Td, Th } from "../ui/DataTable";
import ViewHead, { LoadError, Loading } from "../ui/ViewHead";
import { RefreshFade, Reveal, Rise } from "../ui/motion";

/* Stage 2: Forecast and Collections, migrated. Endpoints, KPI rules,
   fan-chart geometry, drill, customers, collections and what-if all
   mirror loadForecast() / fcDrill() / fcWhatif() / renderFcDisputes()
   in the vanilla insight.js and assist.js (lib/insight.ts). The
   collections row's Draft reminder mail composer stays in the vanilla
   app in this stage; every figure here is the vanilla figure. */

interface FcData {
  f: ForecastData;
  c: CollectionRow[];
  claims: DisputeClaim[];
  ws: WorkspaceFull;
}

export default function Forecast() {
  const [data, setData] = useState<FcData | null>(null);
  const [error, setError] = useState("");
  const [drill, setDrill] = useState<number | null>(null);
  const [wiCust, setWiCust] = useState("");
  const [wiShift, setWiShift] = useState(0);
  const [wi, setWi] = useState<WhatifResult | null>(null);
  const [wiError, setWiError] = useState("");

  const load = useCallback(() => {
    setError("");
    setDrill(null);
    (async () => {
      const [f, c, ws] = await Promise.all([
        api<ForecastData>("/api/v1/forecast"),
        api<CollectionRow[]>("/api/v1/collections"),
        api<WorkspaceFull>("/api/v1/workspace"),
      ]);
      let claims: DisputeClaim[] = [];
      if (ws.latest_run) {
        const raw = await api<MatchRecord[] | { matches: MatchRecord[] }>(
          `/api/v1/runs/${ws.latest_run.run_id}/matches`
        );
        claims = disputeClaims(Array.isArray(raw) ? raw : raw.matches || []);
      }
      setData({ f, c, ws, claims });
      setWiCust((cur) => cur || (f.customers || [])[0]?.customer || "");
    })().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(load, [load]);

  const runWhatif = useCallback((cust: string, shift: number) => {
    if (!cust) return;
    setWiError("");
    api<WhatifResult>("/api/v1/forecast/whatif", {
      method: "POST",
      body: JSON.stringify({ customer: cust, shift_days: shift }),
    })
      .then(setWi)
      .catch((e) => {
        setWi(null);
        setWiError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  const f = data?.f;
  const gated = f && (f.state === "empty" || f.state === "loaded_not_run");
  const ready = f && !gated && f.weeks && f.weeks.length > 0;
  const s = f?.summary || {
    open_ar_cents: 0,
    expected_30_cents: 0,
    expected_horizon_cents: 0,
    at_risk_cents: 0,
    at_risk_count: 0,
  };
  const chart = ready ? fanChart(f) : null;
  const drillData = data && drill !== null ? drillRows(data.f, drill) : [];

  return (
    <>
      <ViewHead
        eyebrow="INSIGHT & GOVERNANCE - 07 / FORECAST AND COLLECTIONS"
        title="Forecast and Collections"
        purpose="Expected cash timing and collections priority from the post-reconciliation ledger."
        onRefresh={load}
      />
      {!data && !error && <Loading label="LOADING THE FORECAST..." />}
      {error && <LoadError error={error} />}

      {data && (
        <Rise i={0}>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
          <StatCard
            label="Open receivables"
            value={gated ? null : s.open_ar_cents}
            format={(v) => money(Math.round(v))}
            note="Every invoice still open after the latest reconciliation, at its remaining balance"
          />
          <StatCard
            label="Expected in 30 days"
            value={gated ? null : s.expected_30_cents}
            format={(v) => money(Math.round(v))}
            note="Each invoice weighted by its chance of landing in 30 days"
          />
          <StatCard
            label="Expected in 8 weeks"
            value={gated ? null : s.expected_horizon_cents}
            format={(v) => money(Math.round(v))}
            note="The full horizon, same weighting"
          />
          <StatCard
            label="At risk"
            value={gated ? null : s.at_risk_cents}
            format={(v) => `${money(Math.round(v))} (${s.at_risk_count})`}
            note="Expected beyond 45 days, or under a 50% chance inside the horizon"
            sparkColor="#e5484d"
          />
        </div>
        </Rise>
      )}

      {data && f?.state === "empty" && (
        <Rise i={1}>
        <Panel>
          <p className="text-sm m-0">
            <b>No active ledger loaded.</b>{" "}
            <span className="text-mut">
              Load a case or upload CSVs to compute cash forecast.
            </span>
          </p>
        </Panel>
        </Rise>
      )}
      {data && f?.state === "loaded_not_run" && data.ws.case && (
        <Rise i={1}>
        <Panel title="Waiting for the reconciliation run">
          <p className="text-sm text-mut mt-1 mb-0">
            The forecast for <b className="text-ink">{data.ws.case.name}</b>{" "}
            is generated by the run itself, nothing here is pre-computed. The
            case is staged: {data.ws.open_invoices} open invoices (
            {money(data.ws.open_invoice_total_cents || 0)}) and{" "}
            {data.ws.staged_payments} wires (
            {money(data.ws.staged_payment_total_cents || 0)}) are waiting. Run
            the case from Run Reconciliation in the vanilla app, then refresh
            here.
          </p>
        </Panel>
        </Rise>
      )}

      {data && !gated && f && !ready && (
        <Rise i={1}>
        <Panel>
          <p className="text-sm text-mut m-0">
            Every invoice in the book is settled, nothing left to forecast.
          </p>
        </Panel>
        </Rise>
      )}

      {data && ready && chart && f && (
        <>
          <Rise i={1}>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
            <Panel title="Cash-in forecast - next 8 weeks">
              <svg
                viewBox="0 0 640 220"
                className="w-full mt-2"
                style={{
                  background: "var(--color-bg2)",
                  border: "1px solid var(--color-line)",
                }}
                role="img"
                aria-label="Forecast fan chart, P10 to P90 band with P50 line"
              >
                <polygon points={chart.band} fill="#3d75e8" opacity={0.22} />
                <polyline
                  points={chart.line}
                  fill="none"
                  stroke="#7fa6f2"
                  strokeWidth={2.5}
                />
                {chart.pts.map((p, i) => (
                  <g key={i}>
                    <circle cx={p[0]} cy={p[1]} r={4} fill="#3d75e8" />
                    <text x={p[0] - 16} y={212} fontSize={11} fill="#a7a49d">
                      Week {i + 1}
                    </text>
                  </g>
                ))}
              </svg>
              <DataTable
                head={
                  <>
                    <Th>Week</Th>
                    <Th>P10 (cautious)</Th>
                    <Th>P50 (expected)</Th>
                    <Th>P90 (optimistic)</Th>
                    <Th>Cumulative P50</Th>
                    <Th>Invoices</Th>
                  </>
                }
              >
                {(f.weeks || []).map((w) => (
                  <Row key={w.week}>
                    <Td>Week {w.week}</Td>
                    <Td className="font-mono text-[12px]">{money(w.p10_cents)}</Td>
                    <Td className="font-mono text-[12px]">
                      <b>{money(w.p50_cents)}</b>
                    </Td>
                    <Td className="font-mono text-[12px]">{money(w.p90_cents)}</Td>
                    <Td className="font-mono text-[12px]">
                      {money(w.cumulative_p50_cents)}
                    </Td>
                    <Td>
                      {w.invoice_ids.length ? (
                        <button
                          className="text-blue2 underline bg-transparent border-0 p-0 cursor-pointer text-[13px]"
                          onClick={() => setDrill(w.week)}
                        >
                          {w.invoice_ids.length} - view
                        </button>
                      ) : (
                        "0"
                      )}
                    </Td>
                  </Row>
                ))}
                {f.beyond && f.beyond.count > 0 && (
                  <Row>
                    <Td>
                      <button
                        className="text-blue2 underline bg-transparent border-0 p-0 cursor-pointer text-[13px]"
                        onClick={() => setDrill(0)}
                      >
                        Beyond week 8
                      </button>
                    </Td>
                    <Td colSpan={3}>
                      <small className="text-mut">
                        Expected after the horizon, counted in Open
                        receivables, not in the weekly bands.
                      </small>
                    </Td>
                    <Td className="font-mono text-[12px]">
                      <b>{money(f.beyond.cents)}</b>
                    </Td>
                    <Td>
                      <button
                        className="text-blue2 underline bg-transparent border-0 p-0 cursor-pointer text-[13px]"
                        onClick={() => setDrill(0)}
                      >
                        {f.beyond.count} - view
                      </button>
                    </Td>
                  </Row>
                )}
              </DataTable>
              <p className="text-[12px] text-mut mb-0 mt-3">
                P10 to P90 across 400 simulated payment timings per invoice.
                Click a week's invoice count to see the invoices in it.
                Horizon {f.horizon_days} days.
              </p>
              <Reveal open={drill !== null} revealKey={`drill-${drill}`}>
                <div className="pt-4">
                  <h4 className="font-display text-[14px] font-semibold m-0">
                    {drill === 0
                      ? "Beyond the 8-week horizon"
                      : `Week ${drill} - the invoices inside it`}{" "}
                    ({drillData.length})
                  </h4>
                  {drillData.length ? (
                    <DataTable
                      head={
                        <>
                          <Th>Invoice</Th>
                          <Th>Customer</Th>
                          <Th>Amount</Th>
                          <Th>Expected in</Th>
                          <Th>Chance in 30d</Th>
                          <Th>Chance in horizon</Th>
                        </>
                      }
                    >
                      {drillData.map((d) => (
                        <Row key={d.invoice_id}>
                          <Td className="font-mono text-[12px] whitespace-nowrap">{d.invoice_id}</Td>
                          <Td className="whitespace-nowrap">{d.customer}</Td>
                          <Td className="font-mono text-[12px]">
                            {money(d.gross_cents)}
                          </Td>
                          <Td>
                            {d.expected_in_days <= 0
                              ? "Due now"
                              : `${Math.round(d.expected_in_days)}d`}
                          </Td>
                          <Td>{Math.round(d.prob_within_30 * 100)}%</Td>
                          <Td>{Math.round(d.prob_within_horizon * 100)}%</Td>
                        </Row>
                      ))}
                    </DataTable>
                  ) : (
                    <p className="text-sm text-mut mb-0 mt-2">
                      No invoice is expected in this bucket.
                    </p>
                  )}
                </div>
              </Reveal>
            </Panel>

            <Panel
              title="Collections priority queue"
              sub="Priority = gross x (1 + overdue days / 30) x (1 + max(predicted delay, 0) / 20), sorted descending. That formula is the whole ranking rule."
            >
              {data.c.length ? (
                <RefreshFade
                  signature={`${data.c.length}:${data.c[0]?.invoice_id ?? ""}:${data.c[0]?.priority_score ?? ""}`}
                >
                <DataTable
                  head={
                    <>
                      <Th>Invoice</Th>
                      <Th>Customer</Th>
                      <Th>Amount</Th>
                      <Th>Overdue</Th>
                      <Th>Pred. delay</Th>
                      <Th>Priority</Th>
                    </>
                  }
                >
                  {data.c.map((r) => (
                    <Row key={r.invoice_id}>
                      <Td className="font-mono text-[12px] whitespace-nowrap">{r.invoice_id}</Td>
                      <Td className="whitespace-nowrap">{r.customer}</Td>
                      <Td className="font-mono text-[12px]">
                        {money(r.gross_cents)}
                      </Td>
                      <Td>{r.overdue_days}d</Td>
                      <Td>{r.predicted_delay_days}d</Td>
                      <Td>
                        <b>{r.priority_score}</b>
                      </Td>
                    </Row>
                  ))}
                </DataTable>
                </RefreshFade>
              ) : (
                <p className="text-sm text-mut mb-0 mt-2">Nothing to collect.</p>
              )}
            </Panel>
          </div>
          </Rise>

          {data.claims.length > 0 && (
            <Rise i={2}>
            <Panel
              title="Dispute priority - from the active run"
              sub="The Deduction Agent flagged these short-pays during reconciliation. Expected recovery is win probability x claim, minus the cost of fighting. The claim itself is dispatched from the Dispute desk in the vanilla app."
            >
              <DataTable
                head={
                  <>
                    <Th>Payment</Th>
                    <Th>Payer</Th>
                    <Th>Claim</Th>
                    <Th>Reason</Th>
                    <Th>Win probability</Th>
                    <Th>Expected recovery</Th>
                  </>
                }
              >
                {data.claims.map((cl) => (
                  <Row key={cl.payment_id}>
                    <Td className="font-mono text-[12px]">{cl.payment_id}</Td>
                    <Td>{cl.payer}</Td>
                    <Td className="font-mono text-[12px]">
                      {money(cl.claimed_cents)}
                    </Td>
                    <Td>{cl.reason}</Td>
                    <Td>{cl.win_probability}</Td>
                    <Td className="font-mono text-[12px]">
                      <b>
                        $
                        {cl.expected_recovery_usd.toLocaleString("en-US", {
                          maximumFractionDigits: 2,
                        })}
                      </b>
                    </Td>
                  </Row>
                ))}
              </DataTable>
            </Panel>
            </Rise>
          )}

          <Rise i={3}>
          <Panel title="Expected cash by customer">
            {(f.customers || []).length ? (
              <DataTable
                head={
                  <>
                    <Th>Customer</Th>
                    <Th>Invoices</Th>
                    <Th>Open</Th>
                    <Th>Overdue</Th>
                    <Th>Expected 30d</Th>
                    <Th>Expected 8 wks</Th>
                    <Th>Avg pred. delay</Th>
                  </>
                }
              >
                {(f.customers || []).map((r) => (
                  <Row key={r.customer}>
                    <Td>{r.customer}</Td>
                    <Td>{r.invoices}</Td>
                    <Td className="font-mono text-[12px]">{money(r.open_cents)}</Td>
                    <Td className="font-mono text-[12px]">
                      {money(r.overdue_cents)}
                    </Td>
                    <Td className="font-mono text-[12px]">
                      {money(r.expected_30_cents)}
                    </Td>
                    <Td className="font-mono text-[12px]">
                      {money(r.expected_horizon_cents)}
                    </Td>
                    <Td>{r.avg_predicted_delay_days}d</Td>
                  </Row>
                ))}
              </DataTable>
            ) : (
              <p className="text-sm text-mut mb-0 mt-2">No customers.</p>
            )}
          </Panel>
          </Rise>

          <Rise i={4}>
          <Panel title="What-if - a customer pays earlier or later">
            <div className="flex gap-4 items-end flex-wrap mt-2">
              <label className="text-[12px] text-mut">
                Customer
                <select
                  value={wiCust}
                  onChange={(e) => {
                    setWiCust(e.target.value);
                    runWhatif(e.target.value, wiShift);
                  }}
                  className="block mt-1 bg-bg2 border border-line rounded-[3px] px-2 py-2 text-[13px] text-ink"
                >
                  {(f.customers || []).map((r) => (
                    <option key={r.customer} value={r.customer}>
                      {r.customer}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-[12px] text-mut flex-1 min-w-[220px]">
                Shift: <b className="text-ink">{wiShift} days</b> (negative =
                pays earlier)
                <input
                  type="range"
                  min={-21}
                  max={21}
                  step={1}
                  value={wiShift}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setWiShift(v);
                    runWhatif(wiCust, v);
                  }}
                  className="w-full block mt-1 accent-[#3d75e8]"
                />
              </label>
            </div>
            {wiError && (
              <p className="text-sm text-bad mb-0 mt-3 break-words">{wiError}</p>
            )}
            <Reveal open={!!wi} revealKey="whatif">
              <div className="pt-3">
                {wi && (
                <>
                <p className="text-sm leading-relaxed m-0">
                  If <b>{wi.customer}</b> pays{" "}
                  <b>
                    {wi.shift_days === 0
                      ? "on the current prediction"
                      : `${Math.abs(wi.shift_days)} days ${wi.shift_days < 0 ? "earlier" : "later"}`}
                  </b>
                  : expected cash in 30 days moves by{" "}
                  <b>{fmtDelta(wi.delta_30_cents, money)}</b> (to{" "}
                  {money(wi.shifted_expected_30_cents)}), and across the 8
                  weeks by <b>{fmtDelta(wi.delta_cents, money)}</b> (to{" "}
                  {money(wi.shifted_expected_horizon_cents)}).
                  {wi.delta_30_cents === 0 &&
                    wi.delta_cents === 0 &&
                    wi.weeks.some(
                      (w) => w.shifted_p50_cents !== w.base_p50_cents
                    ) &&
                    " The 30-day and 8-week totals do not change - the cash moves between weeks, which is what the table below shows."}
                </p>
                <DataTable
                  head={
                    <>
                      <Th>Week</Th>
                      <Th>P50 now</Th>
                      <Th>P50 shifted</Th>
                      <Th>Move</Th>
                    </>
                  }
                >
                  {wi.weeks.map((w) => (
                    <Row key={w.week}>
                      <Td>Week {w.week}</Td>
                      <Td className="font-mono text-[12px]">
                        {money(w.base_p50_cents)}
                      </Td>
                      <Td className="font-mono text-[12px]">
                        {money(w.shifted_p50_cents)}
                      </Td>
                      <Td className="font-mono text-[12px]">
                        {fmtDelta(w.shifted_p50_cents - w.base_p50_cents, money)}
                      </Td>
                    </Row>
                  ))}
                </DataTable>
                </>
                )}
              </div>
            </Reveal>
            {!wi && !wiError && (
              <p className="text-[12px] text-mut mb-0 mt-3">
                Pick a customer and move the slider. The forecast is
                recomputed from the same model and the same ledger, nothing
                is saved.
              </p>
            )}
          </Panel>
          </Rise>
        </>
      )}
    </>
  );
}
