import { useCallback, useEffect, useRef, useState } from "react";
import { api, money, type MatchRecord } from "../lib/api";
import { useWsRefresh } from "../lib/chrome";
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
import {
  goView,
  sendMail,
  sendStatusText,
  setIntent,
  type WorkspaceOperate,
} from "../lib/operate";
import Panel from "../ui/Panel";
import Pill from "../ui/Pill";
import StatCard from "../ui/StatCard";
import DataTable, { Row, Td, Th } from "../ui/DataTable";
import ViewHead, { LoadError } from "../ui/ViewHead";
import ViewSkeleton from "../ui/Skeleton";
import { GhostBtn, PrimaryBtn, StagedGate } from "../ui/Stage3";
import { RefreshFade, Reveal, Rise } from "../ui/motion";

/* Stage 2: Forecast and Collections, migrated. Endpoints, KPI rules,
   fan-chart geometry, drill, customers, collections and what-if all
   mirror loadForecast() / fcDrill() / fcWhatif() / renderFcDisputes()
   in the vanilla insight.js and assist.js (lib/insight.ts).
   Stage 5: the Draft reminder flow is restored IN this view, as
   vanilla has it - a per-row button on the collections queue, the
   composer panel in the Forecast section (draftReminder() +
   sendComposerMail(), kind collection_reminder, the true-status
   pill), plus the dispute rows' Dispatch button and the staged
   gate's Execute action. */

interface FcData {
  f: ForecastData;
  c: CollectionRow[];
  claims: DisputeClaim[];
  ws: WorkspaceFull;
}

interface McState {
  invoiceId: string;
  to: string;
  subject: string;
  body: string;
  status: string | null;
  busy: boolean;
}

export default function Forecast({
  toast,
}: {
  toast: (m: string) => void;
}) {
  const [data, setData] = useState<FcData | null>(null);
  const [error, setError] = useState("");
  const [drill, setDrill] = useState<number | null>(null);
  const [wiCust, setWiCust] = useState("");
  const [wiShift, setWiShift] = useState(0);
  const [wi, setWi] = useState<WhatifResult | null>(null);
  const [wiError, setWiError] = useState("");
  const [mc, setMc] = useState<McState | null>(null);
  const mcRef = useRef<HTMLDivElement>(null);

  /* draftReminder() (insight.js): the draft is composed by the
     server from the ledger row itself, then reviewed and sent from
     this view's own composer. */
  const draftReminder = async (invoiceId: string) => {
    try {
      const d = await api<{ subject: string; body: string }>(
        "/api/v1/mail/reminder",
        {
          method: "POST",
          body: JSON.stringify({ invoice_id: invoiceId }),
        }
      );
      setMc({
        invoiceId,
        to: "",
        subject: d.subject || "",
        body: d.body || "",
        status: null,
        busy: false,
      });
      setTimeout(
        () =>
          mcRef.current?.scrollIntoView({
            behavior: "smooth",
            block: "nearest",
          }),
        90
      );
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  /* sendComposerMail() -> sendMailGeneric("collection_reminder"). */
  const sendReminder = async () => {
    if (!mc) return;
    if (!mc.to.trim()) {
      toast("Add the recipient's email first");
      return;
    }
    if (!mc.body.trim()) {
      toast("Draft the message first");
      return;
    }
    setMc({ ...mc, busy: true });
    try {
      const r = await sendMail(
        "collection_reminder",
        mc.invoiceId,
        mc.to,
        mc.body,
        mc.subject
      );
      setMc((cur) => cur && { ...cur, busy: false, status: r.status });
      toast(
        r.status === "sent"
          ? "Mail sent"
          : r.status === "failed"
            ? "Send failed - recorded in the Outbox"
            : "Recorded in the Outbox - no mailbox configured, nothing was sent"
      );
    } catch (e) {
      setMc((cur) => cur && { ...cur, busy: false });
      toast(e instanceof Error ? e.message : String(e));
    }
  };

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
  /* Stage 6 (Item 1): reload when the workspace is replaced. */
  useWsRefresh(load);

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
      {!data && !error && <ViewSkeleton kind="chart" />}
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
          <StagedGate
            where="forecast"
            ws={data.ws as unknown as WorkspaceOperate}
            onExecute={() => {
              setIntent("slate-run-live", "1");
              goView("run");
            }}
          />
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
              <div className="flex gap-4 flex-wrap mt-2 text-[12px] text-mut">
                <span>
                  <span className="inline-block w-2.5 h-2.5 rounded-[2px] mr-1.5 bg-blue opacity-40" />
                  Shaded band: P10 to P90 range for the week
                </span>
                <span>
                  <span className="inline-block w-2.5 h-2.5 rounded-[2px] mr-1.5 bg-[#7fa6f2]" />
                  Line and dots: P50, the expected week
                </span>
                <span>Height is cash expected that week</span>
              </div>
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

            <div className="flex flex-col gap-4 min-w-0">
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
                      <Th>{""}</Th>
                    </>
                  }
                >
                  {data.c.map((r) => (
                    <Row key={r.invoice_id}>
                      <Td className="font-mono text-[12px] whitespace-nowrap">{r.invoice_id}</Td>
                      <Td>{r.customer}</Td>
                      <Td className="font-mono text-[12px]">
                        {money(r.gross_cents)}
                      </Td>
                      <Td>{r.overdue_days}d</Td>
                      <Td>{r.predicted_delay_days}d</Td>
                      <Td>
                        <b>{r.priority_score}</b>
                      </Td>
                      <Td className="whitespace-nowrap">
                        {/* Stage 6 (Item 6): vanilla's Draft
                            reminder is a white button - a plain
                            <button class="mini"> with no .mini
                            rule in livecube.css, so it renders as
                            the browser's light button face (measured
                            #efefef on black, radius 0) and stands
                            out as the highlightable element. The
                            Stage 5 compact ghost button is retired;
                            .mini-btn in index.css reproduces the
                            measured face. */}
                        <button
                          className="mini-btn"
                          onClick={() => draftReminder(r.invoice_id)}
                        >
                          Draft reminder
                        </button>
                      </Td>
                    </Row>
                  ))}
                </DataTable>
                </RefreshFade>
              ) : (
                <p className="text-sm text-mut mb-0 mt-2">Nothing to collect.</p>
              )}
            </Panel>
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
                  className="block mt-1 glass-select border border-line rounded-none px-2 py-2 text-[13px] text-ink"
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
            </div>
          </div>
          </Rise>

          {mc && (
            <Rise i={2}>
            <div ref={mcRef}>
            <Panel title="Mail - collection reminder">
              <p className="text-sm text-mut mt-1">
                Drafted from the ledger row itself, so the amount and dates
                are the invoice's own. Review it, add the recipient, and
                send it from here. The send is recorded in the Outbox in
                the Outbound Mail Hub with its true status.
              </p>
              <label className="block text-[12px] text-mut mt-3">
                To (accounts payable email)
                <input
                  className="w-full glass-input border border-line rounded-none px-3 py-2 text-[13.5px] text-ink mt-1 block"
                  placeholder="ap@customer.com"
                  value={mc.to}
                  onChange={(e) => setMc({ ...mc, to: e.target.value })}
                />
              </label>
              <label className="block text-[12px] text-mut mt-2.5">
                Subject
                <input
                  className="w-full glass-input border border-line rounded-none px-3 py-2 text-[13.5px] text-ink mt-1 block"
                  value={mc.subject}
                  onChange={(e) => setMc({ ...mc, subject: e.target.value })}
                />
              </label>
              <textarea
                className="w-full glass-input border border-line rounded-none px-3 py-2 text-[13.5px] text-ink mt-2.5 block"
                rows={9}
                value={mc.body}
                onChange={(e) => setMc({ ...mc, body: e.target.value })}
              />
              <div className="flex items-center gap-3 mt-3">
                <PrimaryBtn disabled={mc.busy} onClick={sendReminder}>
                  Send reminder
                </PrimaryBtn>
                {mc.status && (
                  <Pill
                    kind={
                      mc.status === "sent"
                        ? "ok"
                        : mc.status === "failed"
                          ? "bad"
                          : "warn"
                    }
                  >
                    {sendStatusText(mc.status)}
                  </Pill>
                )}
              </div>
            </Panel>
            </div>
            </Rise>
          )}

          {data.claims.length > 0 && (
            <Rise i={2}>
            <Panel
              title="Dispute priority - from the active run"
              sub="The Deduction Agent flagged these short-pays during reconciliation. They sit at the top of the collections work because the money is recoverable: expected recovery is win probability x claim, minus the cost of fighting. One click takes you to the claim on the Dispute desk, draft ready."
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
                    <Th>{""}</Th>
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
                    <Td>
                      <GhostBtn
                        onClick={() => {
                          setIntent("slate-mail-cat", "disputes");
                          setIntent("slate-mail-focus", cl.payment_id);
                          goView("mail");
                        }}
                      >
                        Dispatch dispute email →
                      </GhostBtn>
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

        </>
      )}
    </>
  );
}
