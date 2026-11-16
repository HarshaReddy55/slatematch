import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { api } from "../lib/api";
import {
  downloadExport,
  fmtLoadedAt,
  requestShellRefresh,
  type WorkspaceFull,
} from "../lib/chrome";
import { invalidateBrief } from "../lib/brief";
import { goView, setIntent, toggleRunDiffPanel } from "../lib/operate";

/* Stage 4 shell: the casebar and the brief mini-strip, ported from
   vanilla state.js (renderCasebar, fillBriefMini) with the audit
   row 9 fixes: the latest run id is shown IN FULL (vanilla slices
   it to 13 characters), the case switcher carries full case names,
   and the brief strip keeps ONLY the verdict line (the three tiles
   stay on the Dashboard, where they already live as impact stats).
   Cells, click targets, option lists and toast sentences are
   vanilla's.
   Stage 5: the two stacked blocks became ONE slim strip (Harsha:
   the Stage 4 block pushed the Dashboard down). Same panel, same
   cells and controls; the verdict is now a hairline-separated row
   inside the strip instead of a second card below it. The cells
   also regained vanilla's landings: the ledger cells scroll to
   their panel and flash it, Latest run opens the run comparison,
   and Approvals waiting jumps to the queue (all via intents).
   Stage 5B moved the casebar's contents into the shell's sidebar;
   Stage 5C reverses that (Harsha: "The sidebar must contain the
   contents not the demo case details itself" and "every page
   needs to have the case details as in vanilla"). The strip is
   back at the top of the content column, present identically on
   every view: identity and the four stat cells on the first row,
   the verdict and the controls (tenant and case selectors,
   Export, More) on the second. Every cell, control, title, intent
   and aria label is unchanged from 5B. Two layout deltas from the
   v1 strip, both from Harsha's findings: the selectors are wider
   (264 / 288px) so their closed faces truncate far less, and the
   More menu keeps the 5B body-portalled fixed flyout (the strip
   panel's backdrop filter would otherwise become its containing
   block), now dropping below its button, right-aligned, clamped
   to the viewport once measured, closing on outside click,
   Escape, scroll or resize.
   Stage 5D (Harsha: "Where is run option near the case as in
   vanilla and where is case expansion?"): the four stat cells
   are vanilla's cclink controls and now read as controls -
   pointer cursor, a hover lift on the cell and the label
   turning blue2, exactly vanilla's .cclink:hover treatment -
   and Latest run toggles the run comparison in the SHELL,
   directly under this strip (vanilla's #run-diff position),
   instead of opening a copy inside the Run view. The Active
   case cell stays non-clickable, as in vanilla.
   Stage 6 (vanilla fidelity restoration): three returns to the
   vanilla arrangement. (1) The tenant selector moves OUT of the
   strip into the sidebar's workspace block (ui/WorkspaceBlock),
   where vanilla's wide layout keeps it; the strip's second row
   is vanilla's bar2 again - case selector, Export, More.
   (2) The verdict row leaves the strip: vanilla's casebar
   carries no verdict, and the brief panel now sits directly
   under the strip (ui/CaseBrief) carrying the verdict in both
   its modes - keeping it here too would show it twice.
   (3) bootAuto is restored: a first visit to an empty workspace
   stages the demo case (staged only, never run), as vanilla's
   assist.js bootAuto does; a deliberate Reset sets slate-empty
   and is respected, and any case load clears it. */

interface ScenarioLite {
  id: string;
  title: string;
}

const cellK =
  "font-mono text-[9.5px] tracking-[0.1em] uppercase text-mut flex items-center gap-1.5";
/* Vanilla .cc.cclink: the cell lifts on hover and its label
   turns blue2 (the .cc-link / .cc-k rules in index.css, hand-
   written like vanilla's - Tailwind gates its hover utilities
   behind @media (hover:hover)). The negative margins absorb
   the padding so the strip's layout does not move. */
const cellBtn =
  "cc-link text-left bg-transparent border-0 px-2 py-1 -mx-2 -my-1 rounded-none cursor-pointer min-w-0";
const cellKLink = cellK + " cc-k";
const ghostBtn =
  "font-sans text-[12px] font-medium px-2.5 py-1.5 rounded-none border border-line2 text-ink bg-transparent hover:border-blue cursor-pointer whitespace-nowrap";
const selectCls =
  "glass-select border border-line rounded-none px-2 py-1.5 text-[12.5px] text-ink";

export default function Casebar({
  view,
  toast,
}: {
  view: string;
  toast: (m: string) => void;
}) {
  const [ws, setWs] = useState<WorkspaceFull | null>(null);
  const [cases, setCases] = useState<ScenarioLite[] | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(
    null
  );
  const runSeen = useRef<string | null>(null);
  const bootDone = useRef(false);
  const menuWrapRef = useRef<HTMLDivElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const menuElRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const d = await api<WorkspaceFull>("/api/v1/workspace");
      // Vanilla's stale-read guard: a snapshot that predates the
      // latest known run must not regress the strip.
      if (
        runSeen.current &&
        !d.latest_run &&
        (!d.case || (ws?.case && d.case.id === ws.case.id))
      )
        return;
      if (d.latest_run) runSeen.current = d.latest_run.run_id;
      setWs(d);
    } catch {
      /* the views surface their own load errors */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
  }, [load, view]);
  useEffect(() => {
    const on = (e: Event) => {
      // A forced refresh follows an authoritative state replacement
      // (workspace reset, session restore, reseed): the vanilla
      // stale-read guard must not discard the replacement snapshot,
      // exactly as vanilla's own reset writes the cleared state
      // directly instead of going through the guarded fetch.
      if ((e as CustomEvent).detail?.force) runSeen.current = null;
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
    api<ScenarioLite[]>("/api/v1/scenarios")
      .then((sc) => setCases(Array.isArray(sc) ? sc : []))
      .catch(() => setCases([]));
  }, []);

  /* bootAuto (assist.js): an empty workspace greets a first-time
     visitor with a wall of dashes in vanilla too - so vanilla
     stages the demo case on first visit, for real, and every
     number afterwards is counted from that staged portfolio. It
     NEVER runs it: execution stays an explicit act. A deliberate
     Reset to empty (slate-empty) is respected for the session. */
  useEffect(() => {
    if (!ws || bootDone.current) return;
    bootDone.current = true;
    try {
      if (sessionStorage.getItem("slate-empty") === "1") return;
    } catch {
      /* ignore */
    }
    if (ws.case || ws.latest_run || (ws.open_invoices ?? 0) > 0) return;
    (async () => {
      try {
        await api("/api/v1/cases/seed/load", { method: "POST" });
        invalidateBrief();
        await load();
        requestShellRefresh();
        toast(
          "Demo case staged - the readiness panel shows the real portfolio. One click on Execute runs the six-agent solver in front of you. Reset to empty (case bar) starts clean."
        );
      } catch {
        /* the views surface their own load errors */
      }
    })();
  }, [ws, load, toast]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuWrapRef.current && menuWrapRef.current.contains(t)) return;
      if (menuElRef.current && menuElRef.current.contains(t)) return;
      setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    const onMove = () => setMenuOpen(false);
    document.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [menuOpen]);

  /* The flyout's first position is estimated from the button's
     rect (below the button, right-aligned with it); once the menu
     has mounted, its measured size clamps it inside the viewport. */
  const toggleMenu = () => {
    if (menuOpen) {
      setMenuOpen(false);
      return;
    }
    const r = menuBtnRef.current?.getBoundingClientRect();
    if (r) {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const W = 216;
      const H = 200;
      let left = r.right - W;
      if (left < 8) left = 8;
      if (left + W > vw - 8) left = Math.max(8, vw - W - 8);
      let top = r.bottom + 6;
      if (top + H > vh - 8) top = Math.max(8, r.top - H - 6);
      setMenuPos({ left, top });
    }
    setMenuOpen(true);
  };

  useLayoutEffect(() => {
    if (!menuOpen || !menuElRef.current || !menuPos) return;
    const m = menuElRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let { left, top } = menuPos;
    if (m.right > vw - 8) left = Math.max(8, vw - m.width - 8);
    if (m.bottom > vh - 8) top = Math.max(8, vh - m.height - 8);
    if (left !== menuPos.left || top !== menuPos.top)
      setMenuPos({ left, top });
  }, [menuOpen, menuPos]);

  const c = ws?.case;
  const lr = ws?.latest_run;
  const staged = ws?.run_status === "staged";

  const doExport = async (path: string, fname: string) => {
    const r = await downloadExport(path, fname);
    toast(r.message);
  };

  const saveSession = async () => {
    setMenuOpen(false);
    try {
      const r = await api<{ save_id: string; counts: never }>(
        "/api/v1/session/save",
        { method: "POST", body: JSON.stringify({}) }
      );
      toast(`Session saved - ID ${r.save_id}`);
      requestShellRefresh();
    } catch (e) {
      toast("Save failed: " + (e instanceof Error ? e.message : String(e)));
    }
  };

  const resetWorkspace = async () => {
    setMenuOpen(false);
    try {
      await api("/api/v1/workspace/reset", { method: "POST" });
      runSeen.current = null;
      // Vanilla resetWorkspace: the deliberate empty is respected
      // by bootAuto for the rest of the session.
      try {
        sessionStorage.setItem("slate-empty", "1");
      } catch {
        /* ignore */
      }
      invalidateBrief();
      toast("Workspace cleared - nothing is staged. Load a case to begin.");
      requestShellRefresh(true);
      load();
    } catch (e) {
      toast("Reset failed: " + (e instanceof Error ? e.message : String(e)));
    }
  };

  const switchCase = async (v: string) => {
    if (!v) return;
    if (v === "__builder") {
      goView("cases");
      setTimeout(() => {
        const p = [...document.querySelectorAll("section")].find((x) =>
          /Custom Case Builder/.test(x.textContent || "")
        );
        if (p) p.scrollIntoView({ behavior: "smooth" });
      }, 450);
      return;
    }
    if (v === "__upload") {
      goView("upload");
      return;
    }
    try {
      const d = await api<{
        workspace: WorkspaceFull;
        payments: unknown[];
        run: { auto_posted: number; payments: number } | null;
      }>(`/api/v1/cases/${v}/load`, { method: "POST" });
      runSeen.current = null;
      // Vanilla loadCase: a load ends the deliberate-empty state
      // and invalidates the brief.
      try {
        sessionStorage.removeItem("slate-empty");
      } catch {
        /* ignore */
      }
      invalidateBrief();
      toast(
        d.run
          ? `Case loaded and run: ${d.run.auto_posted} of ${d.run.payments} payments auto-posted`
          : `Case loaded: ${d.workspace.case?.name} - ${d.workspace.open_invoices} invoices, ${d.payments.length} payments staged`
      );
      goView("dash");
      requestShellRefresh();
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div
      className="bg-panel2 rounded-none border border-line px-4 py-2.5"
      aria-label="Case bar"
    >
      <div className="flex flex-col gap-2">
        <div className="flex flex-col lg:flex-row lg:items-center gap-x-4 gap-y-2">
          <div className="flex-1 min-w-0">
            <div className={cellK}>
              <span className="inline-block w-[7px] h-[7px] rounded-[50%] bg-ok" />
              Active case
            </div>
            <div className="text-[13px] font-medium mt-0.5 leading-snug lg:whitespace-nowrap lg:overflow-hidden lg:text-ellipsis">
              {c ? (
                <>
                  {c.name}{" "}
                  <span className="text-mut font-normal">
                    - {c.source || ""} - loaded {fmtLoadedAt(c.loaded_at)} UTC
                  </span>
                </>
              ) : ws ? (
                <>
                  No case loaded{" "}
                  <span className="text-mut font-normal">
                    - load the demo, a use case, the builder, or your own
                    files
                  </span>
                </>
              ) : (
                "Loading workspace..."
              )}
            </div>
          </div>

          <div className="flex items-center gap-3 flex-wrap shrink-0">
            <button
              className={cellBtn}
              onClick={() => {
                setIntent("slate-ledger-target", "invoices");
                goView("ledger");
              }}
              title="Open the LiveCube AR Ledger - it lists exactly these open invoices"
            >
              <div className={cellKLink}>Open invoices</div>
              <div className="font-display text-[15px] font-semibold mt-0.5">
                {ws ? ws.open_invoices ?? "-" : "-"}
              </div>
            </button>

            <button
              className={cellBtn}
              onClick={() => {
                setIntent("slate-ledger-target", "staged");
                goView("ledger");
              }}
              title="Open Ledger & Staged Wires at the staged payments table"
            >
              <div className={cellKLink}>Payments staged</div>
              <div className="font-display text-[15px] font-semibold mt-0.5">
                {ws ? `${ws.staged_payments ?? 0} staged` : "-"}
              </div>
            </button>

            <button
              className={cellBtn}
              onClick={() => {
                // Vanilla toggleRunDiff(): land on Run, and the
                // comparison expands in the shell under this
                // strip; a second click collapses it.
                toggleRunDiffPanel();
                goView("run");
              }}
              title="Compare the latest run with the previous one"
            >
              <div className={cellKLink}>Latest run</div>
              <div className="mt-0.5">
                {lr ? (
                  <>
                    <span className="font-mono text-[12.5px] break-all">
                      {lr.run_id}
                    </span>{" "}
                    <span className="text-mut text-[12px]">{lr.status || ""}</span>
                  </>
                ) : (
                  <span className="font-display text-[15px] font-semibold">
                    {c ? "Pending" : "-"}
                  </span>
                )}
              </div>
            </button>

            <button
              className={cellBtn}
              onClick={() => {
                setIntent("slate-jump-approvals", "1");
                goView("run");
              }}
              title="Jump to the sign-off queue on Run Reconciliation"
            >
              <div className={cellKLink}>Approvals waiting</div>
              <div className="font-display text-[15px] font-semibold mt-0.5">
                {ws ? (staged ? "0 held" : String(ws.approvals_pending ?? 0)) : "-"}
              </div>
            </button>
          </div>
        </div>

        <div className="flex flex-col lg:flex-row lg:items-end gap-x-4 gap-y-2">
          <div className="flex items-center gap-2 flex-wrap shrink-0">
            <select
              className={selectCls + " w-full lg:w-[288px]"}
              value={
                c && (c.id === "seed" || (cases || []).some((s) => s.id === c.id))
                  ? c.id
                  : ""
              }
              title={c ? c.name : "Switch the active case"}
              onChange={(e) => switchCase(e.target.value)}
            >
              <option value="">Switch case...</option>
              <option value="seed">Demo case - one realistic day of receipts</option>
              {(cases || []).map((s) => (
                <option key={s.id} value={s.id} title={s.title}>
                  {s.title}
                </option>
              ))}
              <option value="__builder">Custom Case Builder (Use Cases page)</option>
              <option value="__upload">Upload my own files</option>
            </select>
            <button
              className={ghostBtn}
              disabled={!lr}
              title={
                lr
                  ? "Download the month-end bundle as a clean PDF: the latest run, its matches and exceptions, the SAP posting documents, and the fingerprinted audit trail"
                  : "Nothing to export yet - this workspace has no run"
              }
              onClick={() =>
                doExport("/api/v1/export/bundle.pdf", "slatematch-audit-bundle.pdf")
              }
            >
              Export audit &amp; SAP bundle
            </button>
            <div ref={menuWrapRef}>
              <button
                className={ghostBtn}
                ref={menuBtnRef}
                onClick={toggleMenu}
                aria-expanded={menuOpen}
              >
                More ▾
              </button>
              {menuOpen &&
                createPortal(
                  <div
                    ref={menuElRef}
                    className="glass-menu fixed z-[62] flex flex-col gap-1 border border-line rounded-none p-2"
                    style={{
                      left: menuPos?.left ?? 0,
                      top: menuPos?.top ?? 0,
                      width: 216,
                    }}
                  >
                    <button
                      className={ghostBtn + " text-left border-0"}
                      onClick={() => {
                        setMenuOpen(false);
                        goView("cases");
                      }}
                    >
                      Use cases
                    </button>
                    <button
                      className={ghostBtn + " text-left border-0"}
                      onClick={() => {
                        setMenuOpen(false);
                        doExport("/api/v1/export/bundle", "slatematch-audit-bundle.json");
                      }}
                    >
                      Bundle JSON (raw data)
                    </button>
                    <button
                      className={ghostBtn + " text-left border-0"}
                      onClick={() => {
                        setMenuOpen(false);
                        doExport("/api/v1/export/matches.csv", "slatematch-matches.csv");
                      }}
                    >
                      Matches CSV
                    </button>
                    <button
                      className={ghostBtn + " text-left border-0"}
                      title="Snapshot this workspace under a session ID - restore it exactly, from the Dashboard, on any visit"
                      onClick={saveSession}
                    >
                      Save this session
                    </button>
                    <button
                      className={ghostBtn + " text-left border-0"}
                      onClick={resetWorkspace}
                    >
                      Reset to empty
                    </button>
                  </div>,
                  document.body
                )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
