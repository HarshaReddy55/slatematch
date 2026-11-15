import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import {
  briefVerdict,
  downloadExport,
  fmtLoadedAt,
  requestShellRefresh,
  type WorkspaceFull,
} from "../lib/chrome";
import { goView } from "../lib/operate";

/* Stage 4 shell: the casebar and the brief mini-strip, ported from
   vanilla state.js (renderCasebar, fillBriefMini) with the audit
   row 9 fixes: the latest run id is shown IN FULL (vanilla slices
   it to 13 characters), the case switcher carries full case names,
   and the brief strip keeps ONLY the verdict line (the three tiles
   stay on the Dashboard, where they already live as impact stats).
   Cells, click targets, option lists and toast sentences are
   vanilla's. */

interface TenantInfo {
  tenants: { id: string; name: string; erp: string }[];
  active: string;
  switching_enabled: boolean;
  session?: string;
}

interface ScenarioLite {
  id: string;
  title: string;
}

const cellK =
  "font-mono text-[9.5px] tracking-[0.1em] uppercase text-mut flex items-center gap-1.5";
const cellBtn =
  "text-left bg-transparent border-0 p-0 cursor-pointer min-w-0";
const ghostBtn =
  "font-sans text-[12px] font-medium px-2.5 py-1.5 rounded-[3px] border border-line2 text-ink bg-transparent hover:border-blue cursor-pointer whitespace-nowrap";
const selectCls =
  "bg-bg2 border border-line rounded-[3px] px-2 py-1.5 text-[12.5px] text-ink max-w-[300px]";

export default function Casebar({
  view,
  toast,
}: {
  view: string;
  toast: (m: string) => void;
}) {
  const [ws, setWs] = useState<WorkspaceFull | null>(null);
  const [verdict, setVerdict] = useState<string | null>(null);
  const [tenants, setTenants] = useState<TenantInfo | null>(null);
  const [cases, setCases] = useState<ScenarioLite[] | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const runSeen = useRef<string | null>(null);
  const verdictFor = useRef<string | null>(null);
  const menuRef = useRef<HTMLSpanElement>(null);

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
    api<TenantInfo>("/api/v1/tenants/demo")
      .then(setTenants)
      .catch(() => setTenants(null));
    api<ScenarioLite[]>("/api/v1/scenarios")
      .then((sc) => setCases(Array.isArray(sc) ? sc : []))
      .catch(() => setCases([]));
  }, []);

  // Verdict: computed once per (case, latest run) pair.
  useEffect(() => {
    if (!ws) return;
    const key = `${ws.case?.id || "none"}:${ws.latest_run?.run_id || "norun"}`;
    if (verdictFor.current === key) return;
    verdictFor.current = key;
    if (!ws.case) {
      setVerdict(null);
      return;
    }
    if (!ws.latest_run) {
      setVerdict(
        "Not run yet - run this case from Run Reconciliation and the outcome appears here."
      );
      return;
    }
    setVerdict("Counting this run's outcomes...");
    briefVerdict(ws)
      .then((v) => {
        if (verdictFor.current === key) setVerdict(v);
      })
      .catch(() => {
        if (verdictFor.current === key) setVerdict(null);
      });
  }, [ws]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node))
        setMenuOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [menuOpen]);

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
      verdictFor.current = null;
      toast("Workspace cleared - nothing is staged. Load a case to begin.");
      requestShellRefresh();
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
      verdictFor.current = null;
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

  const switchTenant = (id: string) => {
    if (!id) return;
    try {
      localStorage.setItem("slate-tenant", id);
    } catch {
      /* ignore */
    }
    toast(
      "Tenant switched - each tenant has its own database, so this workspace shows only that tenant's data"
    );
    // The React views cache their own reads; a reload is the honest
    // way to guarantee no surface keeps the old tenant's figures.
    setTimeout(() => window.location.reload(), 350);
  };

  const tenantVal =
    tenants?.active ||
    (typeof localStorage !== "undefined"
      ? localStorage.getItem("slate-tenant") || ""
      : "");

  return (
    <div className="flex flex-col gap-2">
      <div
        className="glass-panel rounded-md border border-white/[0.11] px-4 py-3 flex items-stretch gap-4 flex-wrap"
        aria-label="Case bar"
      >
        <div className="min-w-[180px] flex-1">
          <div className={cellK}>
            <span className="inline-block w-[7px] h-[7px] rounded-full bg-ok" />
            Active case
          </div>
          <div className="text-[13.5px] font-medium mt-1 leading-snug">
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

        <button
          className={cellBtn}
          onClick={() => goView("ledger")}
          title="Open the LiveCube AR Ledger - it lists exactly these open invoices"
        >
          <div className={cellK}>Open invoices</div>
          <div className="font-display text-[17px] font-semibold mt-0.5">
            {ws ? ws.open_invoices ?? "-" : "-"}
          </div>
        </button>

        <button
          className={cellBtn}
          onClick={() => goView("ledger")}
          title="Open Ledger & Staged Wires at the staged payments table"
        >
          <div className={cellK}>Payments staged</div>
          <div className="font-display text-[17px] font-semibold mt-0.5">
            {ws ? `${ws.staged_payments ?? 0} staged` : "-"}
          </div>
        </button>

        <button
          className={cellBtn}
          onClick={() => goView("run")}
          title="Open Run Reconciliation - the latest run in full"
        >
          <div className={cellK}>Latest run</div>
          <div className="mt-0.5">
            {lr ? (
              <>
                <span className="font-mono text-[12.5px] break-all">
                  {lr.run_id}
                </span>{" "}
                <span className="text-mut text-[12px]">{lr.status || ""}</span>
              </>
            ) : (
              <span className="font-display text-[17px] font-semibold">
                {c ? "Pending" : "-"}
              </span>
            )}
          </div>
        </button>

        <button
          className={cellBtn}
          onClick={() => goView("run")}
          title="Jump to the sign-off queue on Run Reconciliation"
        >
          <div className={cellK}>Approvals waiting</div>
          <div className="font-display text-[17px] font-semibold mt-0.5">
            {ws ? (staged ? "0 held" : String(ws.approvals_pending ?? 0)) : "-"}
          </div>
        </button>

        <div className="flex items-center gap-2 flex-wrap ml-auto">
          <label className="flex items-center gap-2 text-mut font-mono text-[10px] tracking-[0.08em]">
            TENANT
            <select
              className={selectCls}
              value={tenantVal}
              disabled={tenants ? !tenants.switching_enabled : false}
              title={
                tenants && !tenants.switching_enabled
                  ? "Tenant switching is off when API keys are issued - the key decides the tenant"
                  : "Tenant - every tenant has its own database; nothing crosses"
              }
              onChange={(e) => switchTenant(e.target.value)}
            >
              {(tenants?.tenants || []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} - {t.erp}
                </option>
              ))}
              {!tenants && <option value="demo">Demo workspace - US - SAP S/4HANA</option>}
            </select>
          </label>
          <select
            className={selectCls}
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
          <span className="relative" ref={menuRef}>
            <button className={ghostBtn} onClick={() => setMenuOpen((o) => !o)}>
              More ▾
            </button>
            {menuOpen && (
              <span className="absolute right-0 top-[calc(100%+6px)] z-40 flex flex-col gap-1 glass-panel border border-white/[0.11] rounded-md p-2 min-w-[210px]">
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
              </span>
            )}
          </span>
        </div>
      </div>

      {c && verdict && (
        <div
          className="glass-card rounded-md border border-white/[0.11] px-4 py-2.5"
          aria-label="Case brief"
        >
          <span className="text-[13.5px]">
            <b>{verdict}</b>
          </span>
        </div>
      )}
    </div>
  );
}
