import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import Dashboard from "./views/Dashboard";
import Ledger from "./views/Ledger";
import Forecast from "./views/Forecast";
import Eval from "./views/Eval";
import Health from "./views/Health";
import { NAV_SPRING } from "./ui/motion";

/* Stage 2 shell: one /react/ entry, hash routing across the migrated
   views (Dashboard from Stage 1 plus the four Insight views). Hash
   routing keeps the single StaticFiles entry and the shared session
   contract: no server change, and a user can cross to the vanilla
   app at / and back mid-workspace. The full chrome (sidebar, topbar,
   palette) is Stage 4; this nav is the minimal Stage 2 form.

   Motion and glass, adapted from the Stack Glass study on 15 Nov
   2026 (see MOTION.md and GLASS.md): the active tab carries a
   spring pill (Motion layoutId, NAV_SPRING physics) that glides
   between tabs, and the tab bar itself is sticky glass: it stays
   at the top of the viewport over scrolling content with a
   translucent ground and backdrop blur. The first pass kept glass
   to this bar alone; later the same day Harsha explicitly chose to
   push the glass further, so the workspace panels and cards are
   glass too, from the one recipe in index.css (.glass-panel /
   .glass-card), over a deepened ground with a static blue glow.
   The tab bar's glass deepens here to match that family. Animated
   ambience (the template's breathing beam, drifting specks) stays
   refused. Reduced motion collapses the spring to zero duration. */

export type ViewKey = "dash" | "ledger" | "forecast" | "eval" | "health";

const VIEWS: { key: ViewKey; num: string; label: string }[] = [
  { key: "dash", num: "01", label: "Dashboard" },
  { key: "ledger", num: "06", label: "Ledger" },
  { key: "forecast", num: "07", label: "Forecast and Collections" },
  { key: "eval", num: "10", label: "Evaluations" },
  { key: "health", num: "11", label: "Agent Health" },
];

function fromHash(): ViewKey {
  const h = window.location.hash.replace(/^#\/?/, "");
  return (VIEWS.some((v) => v.key === h) ? h : "dash") as ViewKey;
}

export default function App() {
  const [view, setView] = useState<ViewKey>(fromHash);
  const reduce = useReducedMotion();
  const pillTransition = reduce ? { duration: 0 } : NAV_SPRING;

  useEffect(() => {
    const on = () => setView(fromHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  const go = (k: ViewKey) => {
    if (window.location.hash !== `#/${k}`) window.location.hash = `/${k}`;
    setView(k);
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
          <span className="font-mono text-[10.5px] text-mut2 self-center tracking-[0.06em]">
            AUTONOMOUS CASH APPLICATION AGENT
          </span>
        </nav>

        {view === "dash" && <Dashboard />}
        {view === "ledger" && <Ledger />}
        {view === "forecast" && <Forecast />}
        {view === "eval" && <Eval />}
        {view === "health" && <Health />}

        <p className="font-mono text-[11px] text-mut2 m-0">
          Every figure is computed live from this workspace's API responses.
        </p>
      </div>
    </main>
  );
}
