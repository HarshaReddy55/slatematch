import { useCallback, useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import Dashboard from "./views/Dashboard";
import Cases from "./views/Cases";
import Upload from "./views/Upload";
import Run from "./views/Run";
import Sap from "./views/Sap";
import Ledger from "./views/Ledger";
import Forecast from "./views/Forecast";
import Mail from "./views/Mail";
import Policy from "./views/Policy";
import Eval from "./views/Eval";
import Health from "./views/Health";
import { NAV_SPRING } from "./ui/motion";
import Casebar from "./ui/Casebar";
import Palette, { type PaletteActions } from "./ui/Palette";
import Copilot from "./ui/Copilot";
import DocsDrawer from "./ui/DocsDrawer";
import KeyModal, { storedKey } from "./ui/KeyModal";
import { api } from "./lib/api";
import { downloadExport, requestShellRefresh } from "./lib/chrome";
import { setIntent } from "./lib/operate";

/* The shell. Stages 0-3: one /react/ entry, hash routing across the
   migrated views, the spring nav pill and the glass tab bar (Stack
   Glass pass). Stage 4 adds the chrome around the same shell: the
   casebar with the verdict-only brief strip, the command palette,
   the Copilot, the docs drawer and the access-key modal, plus the
   Policy Studio view (09). The pill and the tab bar are untouched.
   With the Stage 4 flip this shell is also the default at /; the
   vanilla app stays reachable at /vanilla/ and both stacks share
   the session contract (sessionStorage slatematch_session_id,
   localStorage slate-key / slate-tenant, identical API headers). */

export type ViewKey =
  | "dash"
  | "cases"
  | "upload"
  | "run"
  | "sap"
  | "ledger"
  | "forecast"
  | "mail"
  | "policy"
  | "eval"
  | "health";

const VIEWS: { key: ViewKey; num: string; label: string }[] = [
  { key: "dash", num: "01", label: "Dashboard" },
  { key: "cases", num: "02", label: "Use Cases" },
  { key: "upload", num: "03", label: "Upload Center" },
  { key: "run", num: "04", label: "Run Reconciliation" },
  { key: "sap", num: "05", label: "SAP BAPI & EBRR" },
  { key: "ledger", num: "06", label: "Ledger" },
  { key: "forecast", num: "07", label: "Forecast and Collections" },
  { key: "mail", num: "08", label: "Outbound Mail Hub" },
  { key: "policy", num: "09", label: "Policy Studio" },
  { key: "eval", num: "10", label: "Evaluations" },
  { key: "health", num: "11", label: "Agent Health" },
];

function fromHash(): ViewKey {
  const h = window.location.hash.replace(/^#\/?/, "");
  return (VIEWS.some((v) => v.key === h) ? h : "dash") as ViewKey;
}

const shellBtn =
  "font-sans text-[11px] font-medium tracking-[0.04em] px-2.5 py-1.5 rounded-[3px] border border-line2 text-ink bg-transparent hover:border-blue cursor-pointer whitespace-nowrap self-center";

export default function App() {
  const [view, setView] = useState<ViewKey>(fromHash);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [docsOpen, setDocsOpen] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);
  const [hasKey, setHasKey] = useState(() => !!storedKey());
  const [toastMsg, setToastMsg] = useState("");
  const toastTimer = useRef<number | null>(null);
  const reduce = useReducedMotion();
  const pillTransition = reduce ? { duration: 0 } : NAV_SPRING;

  const toast = useCallback((m: string) => {
    setToastMsg(m);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastMsg(""), 3400);
  }, []);

  useEffect(() => {
    const on = () => setView(fromHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  useEffect(() => {
    const on = () => setHasKey(!!storedKey());
    window.addEventListener("slate:key-changed", on);
    return () => window.removeEventListener("slate:key-changed", on);
  }, []);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", on);
    return () => document.removeEventListener("keydown", on);
  }, []);

  const go = useCallback((k: ViewKey) => {
    if (window.location.hash !== `#/${k}`) window.location.hash = `/${k}`;
    setView(k);
  }, []);

  const paletteActions: PaletteActions = {
    go: (k) => go(k as ViewKey),
    seedAndRun: () => {
      api("/api/v1/seed", { method: "POST" })
        .then(() => {
          setIntent("slate-run-live", "1");
          go("run");
          requestShellRefresh(true);
        })
        .catch((e) =>
          toast(e instanceof Error ? e.message : String(e))
        );
    },
    runLive: () => {
      setIntent("slate-run-live", "1");
      go("run");
    },
    jumpApprovals: () => go("run"),
    exportPdf: () => {
      downloadExport("/api/v1/export/bundle.pdf", "slatematch-audit-bundle.pdf").then(
        (r) => toast(r.message)
      );
    },
    exportCsv: () => {
      downloadExport("/api/v1/export/matches.csv", "slatematch-matches.csv").then(
        (r) => toast(r.message)
      );
    },
    saveSession: () => {
      api<{ save_id: string }>("/api/v1/session/save", {
        method: "POST",
        body: JSON.stringify({}),
      })
        .then((r) => {
          toast(`Session saved - ID ${r.save_id}`);
          requestShellRefresh();
        })
        .catch((e) =>
          toast("Save failed: " + (e instanceof Error ? e.message : String(e)))
        );
    },
    restoreSession: () => {
      go("dash");
      setTimeout(
        () => window.dispatchEvent(new Event("slate:focus-session-input")),
        60
      );
    },
    openKey: () => setKeyOpen(true),
    openDocs: () => setDocsOpen(true),
    resetWorkspace: () => {
      api("/api/v1/workspace/reset", { method: "POST" })
        .then(() => {
          toast("Workspace cleared - nothing is staged. Load a case to begin.");
          requestShellRefresh(true);
        })
        .catch((e) =>
          toast("Reset failed: " + (e instanceof Error ? e.message : String(e)))
        );
    },
  };

  return (
    <main className="min-h-screen text-ink font-sans">
      <div className="max-w-[1180px] mx-auto px-5 py-6 flex flex-col gap-4">
        <nav
          aria-label="Views"
          className="flex gap-1 flex-wrap border-b border-white/[0.10] pb-3 sticky top-0 z-30"
          style={{
            background: "rgba(28, 28, 29, 0.72)",
            backdropFilter: "blur(16px) saturate(1.2)",
            WebkitBackdropFilter: "blur(16px) saturate(1.2)",
            boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.06)",
          }}
        >
          {VIEWS.map((v) => {
            const active = view === v.key;
            return (
              <button
                key={v.key}
                onClick={() => go(v.key)}
                aria-current={active ? "page" : undefined}
                className={`relative font-sans text-[13px] px-3 py-2 rounded-[3px] border cursor-pointer bg-transparent ${
                  active
                    ? "border-blue text-white font-medium"
                    : "border-transparent text-mut hover:text-ink"
                }`}
              >
                {active && (
                  <motion.span
                    layoutId="view-pill"
                    className="absolute inset-0 bg-blue rounded-[3px]"
                    transition={pillTransition}
                  />
                )}
                <span className="relative z-10 flex items-baseline">
                  <motion.span
                    className="font-mono text-[10.5px] mr-1.5 inline-block"
                    initial={false}
                    animate={{
                      scale: active ? 1.18 : 1,
                      opacity: active ? 0.95 : 0.7,
                    }}
                    transition={pillTransition}
                  >
                    {v.num}
                  </motion.span>
                  {v.label}
                </span>
              </button>
            );
          })}
          <span className="flex-1" />
          <button className={shellBtn} onClick={() => setDocsOpen(true)} title="Read the product documents that ship in the repository (PRD, architecture, go-to-market)">
            PRODUCT DOCS
          </button>
          <button className={shellBtn} onClick={() => setKeyOpen(true)} title="Set the API key this browser uses when this deployment is locked with keys">
            {hasKey ? "ACCESS KEY: SET" : "ACCESS KEY"}
          </button>
          <button
            className={shellBtn}
            onClick={() => setPaletteOpen(true)}
            title="Menu - jump to any view or action (Ctrl or Cmd + K)"
            aria-label="Open menu"
          >
            MENU
          </button>
          <span className="font-mono text-[10.5px] text-mut2 self-center tracking-[0.06em] hidden xl:inline">
            AUTONOMOUS CASH APPLICATION AGENT
          </span>
        </nav>

        <Casebar view={view} toast={toast} />

        {view === "dash" && <Dashboard toast={toast} />}
        {view === "cases" && <Cases />}
        {view === "upload" && <Upload />}
        {view === "run" && <Run />}
        {view === "sap" && <Sap />}
        {view === "ledger" && <Ledger />}
        {view === "forecast" && <Forecast />}
        {view === "mail" && <Mail />}
        {view === "policy" && <Policy toast={toast} />}
        {view === "eval" && <Eval />}
        {view === "health" && <Health />}

        <p className="font-mono text-[11px] text-mut2 m-0">
          Every figure is computed live from this workspace's API responses.
        </p>
      </div>

      <Palette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        views={VIEWS}
        actions={paletteActions}
      />
      <DocsDrawer open={docsOpen} onClose={() => setDocsOpen(false)} />
      <KeyModal open={keyOpen} onClose={() => setKeyOpen(false)} toast={toast} />
      <Copilot />

      {toastMsg && (
        <div
          className="glass-panel fixed left-1/2 bottom-6 z-[80] rounded-full border border-white/[0.11] px-4 py-2 text-[13px] text-ink"
          style={{ transform: "translateX(-50%)" }}
          role="status"
        >
          {toastMsg}
        </div>
      )}
    </main>
  );
}
