import { useEffect, useMemo, useRef, useState } from "react";
import { cmdkFuzzy } from "../lib/chrome";

/* Stage 4: the command palette (assist.js cmdkAll / renderCmdk),
   with audit row 11's fix and the Stage 4 scope: two labelled
   groups, "Go to" and "Actions", compact Raycast-style rows so the
   Actions group is visible without scrolling on open (vanilla's
   first screen shows views only). The fuzzy matcher, its scoring,
   the group re-ranking while filtering, the highlight spans and
   the keyboard set are vanilla's, ported exactly. Vanilla's third
   group ("Workspace": key, docs, reset) folds into Actions; the
   reference views (Methodology, Architecture, Product Thinking)
   are not React views and stay reachable in the vanilla app, so
   they are not listed. */

export interface PaletteView {
  key: string;
  num: string;
  label: string;
}

export interface PaletteActions {
  go: (key: string) => void;
  seedAndRun: () => void;
  runLive: () => void;
  jumpApprovals: () => void;
  exportPdf: () => void;
  exportCsv: () => void;
  saveSession: () => void;
  restoreSession: () => void;
  openKey: () => void;
  openDocs: () => void;
  resetWorkspace: () => void;
}

interface Item {
  grp: string;
  num: string;
  label: string;
  run: () => void;
}

export default function Palette({
  open,
  onClose,
  views,
  actions,
}: {
  open: boolean;
  onClose: () => void;
  views: PaletteView[];
  actions: PaletteActions;
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const all = useMemo<Item[]>(() => {
    const goItems: Item[] = views.map((v) => ({
      grp: "Go to",
      num: v.num,
      label: v.label,
      run: () => actions.go(v.key),
    }));
    const acts: Item[] = [
      { grp: "Actions", num: "RUN", label: "Load the demo case and run it live", run: actions.seedAndRun },
      { grp: "Actions", num: "LIVE", label: "Run the active case live (streamed)", run: actions.runLive },
      { grp: "Actions", num: "APR", label: "Jump to the approvals queue", run: actions.jumpApprovals },
      { grp: "Actions", num: "EXP", label: "Export audit and SAP bundle (PDF)", run: actions.exportPdf },
      { grp: "Actions", num: "CSV", label: "Export matches as CSV", run: actions.exportCsv },
      { grp: "Actions", num: "SAV", label: "Save this session", run: actions.saveSession },
      { grp: "Actions", num: "RST", label: "Restore a saved session", run: actions.restoreSession },
      { grp: "Actions", num: "KEY", label: "Set the workspace access key", run: actions.openKey },
      { grp: "Actions", num: "DOC", label: "Open the product documents", run: actions.openDocs },
      { grp: "Actions", num: "CLR", label: "Reset workspace to empty", run: actions.resetWorkspace },
    ];
    return goItems.concat(acts);
  }, [views, actions]);

  const shown = useMemo(() => {
    const query = q.trim();
    if (!query)
      return all.map((it) => ({ ...it, pos: null as number[] | null }));
    const scored: (Item & { score: number; pos: number[] })[] = [];
    for (const it of all) {
      const m = cmdkFuzzy(query, it.label);
      if (m) scored.push({ ...it, score: m.score, pos: m.pos });
    }
    const grpBest = new Map<string, number>();
    for (const it of scored)
      grpBest.set(it.grp, Math.max(grpBest.get(it.grp) ?? -1, it.score));
    const grpOrder = [...grpBest.keys()].sort(
      (a, b) => (grpBest.get(b) ?? 0) - (grpBest.get(a) ?? 0)
    );
    return grpOrder.flatMap((g) =>
      scored
        .filter((it) => it.grp === g)
        .sort((a, b) => b.score - a.score)
    );
  }, [all, q]);

  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open ]);

  useEffect(() => {
    setSel((s) => Math.min(s, Math.max(shown.length - 1, 0)));
  }, [shown.length]);

  useEffect(() => {
    const el = listRef.current?.querySelector('[data-sel="1"]');
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [sel, shown]);

  if (!open) return null;

  const pick = (i: number) => {
    const it = shown[i];
    if (!it) return;
    onClose();
    it.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel(Math.min(sel + 1, shown.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel(Math.max(sel - 1, 0));
    } else if (e.key === "Home") {
      e.preventDefault();
      setSel(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setSel(shown.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(sel);
    }
  };

  let lastGrp = "";
  return (
    <div
      className="fixed inset-0 z-[65]"
      role="dialog"
      aria-label="Menu"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{ background: "rgba(10,10,10,0.55)", backdropFilter: "blur(3px)" }}
    >
      <div className="glass-pop rounded-none border border-line max-w-[580px] mx-auto mt-[9vh] overflow-hidden">
        <input
          ref={inputRef}
          type="text"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Jump to a view, or run an action..."
          autoComplete="off"
          className="w-full bg-transparent border-0 border-b border-white/[0.1] outline-none text-[15px] text-ink px-4 py-3.5"
        />
        <div ref={listRef} className="overflow-y-auto max-h-[68vh] py-1.5">
          {shown.length === 0 && (
            <p className="text-[13px] text-mut px-4 py-3 m-0">
              No view or action matches "{q.trim()}".
            </p>
          )}
          {shown.map((it, i) => {
            const gh = it.grp !== lastGrp ? it.grp : null;
            lastGrp = it.grp;
            const posSet = it.pos ? new Set(it.pos) : null;
            return (
              <div key={it.grp + it.num + it.label}>
                {gh && (
                  <div className="font-mono text-[9.5px] tracking-[0.12em] uppercase text-mut2 px-4 pt-2 pb-1">
                    {gh}
                  </div>
                )}
                <button
                  data-sel={i === sel ? "1" : undefined}
                  onMouseMove={() => {
                    if (sel !== i) setSel(i);
                  }}
                  onClick={() => pick(i)}
                  className={`flex items-baseline gap-3 w-full text-left bg-transparent border-0 px-4 py-[6px] cursor-pointer text-[13.5px] ${
                    i === sel ? "bg-blue/25 text-white" : "text-ink"
                  }`}
                >
                  <span className="font-mono text-[10.5px] text-blue2 w-[26px] shrink-0">
                    {it.num}
                  </span>
                  <span>
                    {posSet
                      ? [...it.label].map((ch, j) =>
                          posSet.has(j) ? (
                            <b key={j} className="text-blue2 font-semibold">
                              {ch}
                            </b>
                          ) : (
                            <span key={j}>{ch}</span>
                          )
                        )
                      : it.label}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
        <div className="px-4 py-2 border-t border-white/[0.08] font-mono text-[10px] tracking-[0.08em] text-mut2">
          ↑↓ NAVIGATE · ENTER SELECT · ESC CLOSE
        </div>
      </div>
    </div>
  );
}
