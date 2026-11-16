import { useCallback, useEffect, useRef, useState } from "react";
import { api, money } from "../lib/api";
import type { WorkspaceFull } from "../lib/chrome";
import {
  briefOutcome,
  invalidateBrief,
  SEED_STORY,
  type BriefOutcome,
} from "../lib/brief";
import { goView, setIntent } from "../lib/operate";

/* Stage 6 (Item 2): the case brief, ported from vanilla state.js
   (renderCaseBrief, fillBriefMini, briefOutcome, applyBriefMode)
   and livecube.css (#case-brief / .briefpanel / .briefmini /
   .btile). Until this stage React had no brief system at all -
   Stage 4 kept only the verdict line, inside the casebar; the
   verdict now lives here, in the brief, exactly as vanilla's
   does (vanilla's casebar carries no verdict), and the casebar
   strip no longer duplicates it.

   The shutter: the panel shows EITHER the mini strip (verdict +
   the three outcome tiles) OR the full brief (situation +
   outcome), never both - applyBriefMode swaps the two regions'
   display and the panel's .mini padding. The mode persists in
   sessionStorage key slate-brief; until the user toggles it, the
   default is OPEN on the Dashboard and closed on every other
   view (briefEffectiveOpen, ported verbatim below). Vanilla
   animates nothing here (.briefpanel{animation:none}); the swap
   is a display change, as here. */

let BRIEF_OPEN: boolean | null = null;

function briefEffectiveOpen(view: string): boolean {
  try {
    const bp = sessionStorage.getItem("slate-brief");
    if (bp !== null) return bp === "1";
  } catch {
    /* ignore */
  }
  return BRIEF_OPEN === null ? view === "dash" : BRIEF_OPEN;
}

interface ScenarioMeta {
  id: string;
  story?: string;
  shows?: string;
}

let CASELIST: ScenarioMeta[] | null = null;

const kCls =
  "font-mono text-[9.5px] text-mut uppercase tracking-[0.1em]";
const tileK = "font-mono text-[9px] text-mut uppercase tracking-[0.1em]";
const cardCls = "border border-line bg-panel px-4 py-[15px]";

function Tile({
  label,
  value,
  onClick,
  title,
}: {
  label: string;
  value: string;
  onClick?: () => void;
  title?: string;
}) {
  const inner = (
    <>
      <span className={tileK}>{label}</span>
      <span className="bv text-[17px] font-bold text-white whitespace-nowrap leading-tight">
        {value}
      </span>
    </>
  );
  const cls = "flex flex-col gap-0.5";
  return onClick ? (
    <span className={cls + " btile-link"} onClick={onClick} title={title} role="button">
      {inner}
    </span>
  ) : (
    <span className={cls}>{inner}</span>
  );
}

export default function CaseBrief({ view }: { view: string }) {
  const [ws, setWs] = useState<WorkspaceFull | null>(null);
  const [outcome, setOutcome] = useState<
    BriefOutcome | "executing" | "counting" | null
  >(null);
  const [meta, setMeta] = useState<ScenarioMeta[] | null>(CASELIST);
  const [, setTick] = useState(0);
  const outcomeFor = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api<WorkspaceFull>("/api/v1/workspace");
      setWs(d);
    } catch {
      /* the views surface their own load errors */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, view]);

  useEffect(() => {
    const on = () => {
      // Vanilla invalidates BRIEF_RUN at every mutation point
      // (load, reset, restore, tenant switch, run completion,
      // approval decisions); in React those all surface here.
      invalidateBrief();
      outcomeFor.current = null;
      load();
    };
    window.addEventListener("slate:ws-refresh", on);
    window.addEventListener("focus", on);
    return () => {
      window.removeEventListener("slate:ws-refresh", on);
      window.removeEventListener("focus", on);
    };
  }, [load]);

  useEffect(() => {
    if (CASELIST) return;
    api<ScenarioMeta[]>("/api/v1/scenarios")
      .then((sc) => {
        CASELIST = Array.isArray(sc) ? sc : [];
        setMeta(CASELIST);
      })
      .catch(() => {
        CASELIST = [];
        setMeta([]);
      });
  }, []);

  const lr = ws?.latest_run;
  const lrId = lr?.run_id || null;

  useEffect(() => {
    if (!ws || !ws.case || !lrId) {
      setOutcome(null);
      outcomeFor.current = null;
      return;
    }
    if (outcomeFor.current === lrId) return;
    outcomeFor.current = lrId;
    setOutcome("counting");
    briefOutcome(lrId)
      .then((d) => {
        if (outcomeFor.current === lrId) setOutcome(d ?? "counting");
      })
      .catch(() => {
        if (outcomeFor.current === lrId) setOutcome("counting");
      });
  }, [ws, lrId]);

  if (!ws || !ws.case) return null;
  const c = ws.case;
  const open = briefEffectiveOpen(view);

  const toggle = () => {
    BRIEF_OPEN = !open;
    try {
      sessionStorage.setItem("slate-brief", BRIEF_OPEN ? "1" : "0");
    } catch {
      /* ignore */
    }
    setTick((t) => t + 1);
  };

  const goMailDisputes = () => {
    setIntent("slate-mail-cat", "disputes");
    goView("mail");
  };

  const m = (meta || []).find((x) => x.id === c.id);
  const story =
    c.story || (c.id === "seed" ? SEED_STORY : m?.story || "");
  const shows = m?.shows || "";
  const pending = ws.pending_payments || [];
  const data = outcome && outcome !== "executing" && outcome !== "counting" ? outcome : null;

  const stoppedTxt = data && data.stoppedLabels.length
    ? ` ${data.stoppedLabels.length} ${data.stoppedLabels.length === 1 ? "was" : "were"} stopped before matching (${data.stoppedLabels.join(", ")}).`
    : "";

  return (
    <section
      className={`glass-panel rounded-none border border-line px-[19px] ${
        open ? "py-4" : "py-3"
      }`}
      aria-label="Case brief"
    >
      <div
        className={`flex items-center justify-between gap-3 ${
          open ? "mb-2.5" : "mb-1.5"
        }`}
      >
        <h3 className="font-display text-[15px] font-semibold text-ink m-0">
          Case brief - {c.name}
        </h3>
        <button
          className="font-sans text-[12.5px] font-medium px-3 py-1.5 rounded-none border border-line2 text-ink bg-transparent hover:border-blue cursor-pointer whitespace-nowrap shrink-0"
          onClick={toggle}
          aria-expanded={open}
        >
          {open ? "Minimize ▴" : "Full brief ▾"}
        </button>
      </div>

      {!open && (
        <div>
          {!lr ? (
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              <span className="text-[13.5px] flex-1 min-w-[230px]">
                Not run yet - run this case from Run Reconciliation and
                the outcome appears here.
              </span>
            </div>
          ) : !data ? (
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              <span className="text-[13.5px] flex-1 min-w-[230px]">
                Counting this run's outcomes...
              </span>
            </div>
          ) : (
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              <span className="text-[13.5px] flex-1 min-w-[230px]">
                <b>{data.verdictShort}</b>
              </span>
              <Tile label="Auto-posted cash" value={money(data.cash)} />
              <Tile
                label="Expected back from disputes"
                value={
                  "$" +
                  data.rec.toLocaleString("en-US", {
                    maximumFractionDigits: 0,
                  })
                }
                onClick={goMailDisputes}
                title="Open these dispute claims in the Outbound Mail Hub"
              />
              <Tile
                label="Held for a person"
                value={`${data.held} - ${money(data.heldAmt)}`}
              />
            </div>
          )}
        </div>
      )}

      {open && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-[22px] gap-y-4">
          <div>
            <div className={kCls}>The situation - what came in</div>
            <p className="text-[13.5px] leading-relaxed my-2">
              {story || "A working dataset loaded into the shared workspace."}
            </p>
            {shows && (
              <span className="block text-[12.5px] text-mut mb-1">
                <b className="text-ink">What this case tests:</b> {shows}
              </span>
            )}
            <span className="block text-[12.5px] text-mut leading-relaxed">
              Open invoices in the ledger:{" "}
              <b className="text-ink">{ws.open_invoices ?? 0}</b>
              <br />
              Payments in this case:{" "}
              <b className="text-ink">{ws.staged_payments ?? 0}</b>
              {pending.length === 0
                ? " - all of them have been run"
                : pending.length === ws.staged_payments
                  ? " - all still waiting to run"
                  : <> - <b className="text-ink">{pending.length}</b> of them still waiting to run</>}
              {lr ? (
                <>
                  <br />
                  The latest run processed{" "}
                  <b className="text-ink">{lr.payments ?? 0}</b> payments
                </>
              ) : null}
            </span>
          </div>

          <div>
            <div className={kCls}>The outcome - what the agent did</div>
            <div className="mt-2">
              {!lr ? (
                <div className="border border-line bg-panel px-4 py-[14px]">
                  <div className={kCls}>Staged portfolio readiness</div>
                  <p className="text-[13.5px] leading-relaxed mt-2 mb-1.5">
                    <b>{money(ws.open_invoice_total_cents || 0)}</b>{" "}
                    across {ws.open_invoices ?? 0} open invoices&nbsp;
                    vs&nbsp;
                    <b>{money(ws.staged_payment_total_cents || 0)}</b>{" "}
                    across {ws.staged_payments ?? 0} incoming wires
                  </p>
                  <p className="text-[13.5px] leading-relaxed m-0">
                    <b>Status:</b> {ws.staged_payments ?? 0} wires staged
                    &amp; verified - ready for 6-agent MILP
                    reconciliation. Nothing has been solved yet; the
                    outcome appears here after the run.
                  </p>
                </div>
              ) : outcome === "executing" ? (
                <div className="text-[13.5px] text-mut">
                  This run is still executing - the case outcome lands
                  here when it completes.
                </div>
              ) : !data ? (
                <div className="text-[13.5px] text-mut">
                  Counting this run's outcomes...
                </div>
              ) : (
                <>
                  <p className="text-[14.5px] leading-[1.55] m-0 mb-2.5">
                    <b>
                      {data.total} payments came in: {data.auto} posted
                      themselves, {data.held}{" "}
                      {data.held === 1 ? "is" : "are"} waiting for a
                      person's decision.{stoppedTxt}
                    </b>
                  </p>
                  {data.total > 0 && (
                    <p className="text-[13.5px] leading-[1.5] m-0 mb-2.5">
                      Autonomous resolution: <b>{data.resPct}%</b> - the
                      agent reached the decision on {data.decided} of{" "}
                      {data.total} wires itself: posted, solved and
                      queued for sign-off, or refused with a reason.
                      Governance signs; it does not research.
                    </p>
                  )}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className={cardCls}>
                      <div className={kCls}>Auto-posted cash</div>
                      <div className="text-[21px] font-bold mt-1">
                        {money(data.cash)}
                      </div>
                      <div className="text-[12px] text-mut mt-0.5">
                        {data.auto} payments posted with no human touch
                      </div>
                    </div>
                    <div
                      className={cardCls + " card-link"}
                      onClick={goMailDisputes}
                      title="Open these dispute claims in the Outbound Mail Hub"
                      role="button"
                    >
                      <div className={kCls}>Expected back from disputes</div>
                      <div className="text-[21px] font-bold mt-1">
                        $
                        {data.rec.toLocaleString("en-US", {
                          maximumFractionDigits: 0,
                        })}
                      </div>
                      <div className="text-[12px] text-mut mt-0.5">
                        What the agent expects to win back from the
                        claims it has opened
                      </div>
                    </div>
                    <div className={cardCls}>
                      <div className={kCls}>Held for a person</div>
                      <div className="text-[21px] font-bold mt-1">
                        {data.held}
                      </div>
                      <div className="text-[12px] text-mut mt-0.5">
                        {money(data.heldAmt)} waiting - decide them from
                        Approvals waiting in the top bar
                      </div>
                    </div>
                  </div>
                  <p className="mt-2.5 mb-0 flex items-start gap-2 flex-wrap">
                    <button
                      className="font-sans text-[12.5px] font-medium px-[11px] py-[6px] rounded-none border border-blue text-white bg-blue hover:bg-[#2b5cd7] cursor-pointer whitespace-nowrap"
                      onClick={() => goView("sap")}
                    >
                      View SAP S/4HANA BAPI &amp; EBRR Payloads →
                    </button>
                    <span className="text-[12px] text-mut leading-snug">
                      Every cleared payment's balanced DZ clearing
                      journal and the ASC 606 dispute reserve, generated
                      live by erp_sap.py from this case's matches.
                    </span>
                  </p>
                  <span className="block text-[12px] text-mut leading-relaxed mt-2">
                    Totals for the whole case, across all of its runs -
                    each payment counted once, by its latest decision.
                    Time saved for the analyst:{" "}
                    <b className="text-ink">
                      {((data.auto * 12) / 60).toFixed(1)} hours
                    </b>{" "}
                    ({data.auto} auto-posted payments x 12 minutes each,
                    the stated manual benchmark).
                  </span>
                </>
              )}
            </div>
            {pending.length > 0 && (
              <p className="mt-2.5 mb-0">
                <button
                  className="font-sans text-[13.5px] font-medium px-4 py-2 rounded-none border border-blue text-white bg-blue hover:bg-[#2b5cd7] cursor-pointer"
                  onClick={() => {
                    setIntent("slate-run-live", "1");
                    goView("run");
                  }}
                >
                  ▶ Run reconciliation on {pending.length} staged payment
                  {pending.length === 1 ? "" : "s"} →
                </button>
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
