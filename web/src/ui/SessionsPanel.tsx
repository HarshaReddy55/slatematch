import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import {
  countsLine,
  fmtSavedAt,
  requestShellRefresh,
  type SaveCounts,
  type SaveRow,
} from "../lib/chrome";
import Panel from "./Panel";

/* Stage 4: session saves (assist.js saveSession / restoreSession /
   loadSaves), in the Dashboard panel vanilla keeps them in, with
   the Obsidian Active Sessions row pattern from the ledger: a
   status dot, the mono session id, saved-at and counts on one
   quiet line, Retrieve at the row's edge. Panel copy, endpoints
   and result sentences are vanilla's verbatim. The pattern's
   fold-away remove is NOT ported: vanilla has no delete endpoint
   for saves and inventing one is out of scope (recorded in the
   ledger). The panel carries id="sessions" so the palette's
   restore action can land on the input. */

interface SaveResponse {
  save_id: string;
  counts: SaveCounts;
  saved_at?: string;
}

export default function SessionsPanel({
  toast,
}: {
  toast: (m: string) => void;
}) {
  const [saves, setSaves] = useState<SaveRow[] | null>(null);
  const [idIn, setIdIn] = useState("");
  const [out, setOut] = useState("");
  const [busy, setBusy] = useState("");
  const busyRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadSaves = useCallback(() => {
    api<{ saves?: SaveRow[] }>("/api/v1/session/saves")
      .then((d) => setSaves((d.saves || []).slice(0, 6)))
      .catch(() => setSaves([]));
  }, []);
  useEffect(loadSaves, [loadSaves]);

  // The palette's RST action lands here: focus the ID input.
  useEffect(() => {
    const on = () => {
      document
        .getElementById("sessions")
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
      setTimeout(() => inputRef.current?.focus(), 350);
    };
    window.addEventListener("slate:focus-session-input", on);
    return () => window.removeEventListener("slate:focus-session-input", on);
  }, []);

  const save = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy("save");
    try {
      const r = await api<SaveResponse>("/api/v1/session/save", {
        method: "POST",
        body: JSON.stringify({}),
      });
      setOut(
        `Session saved. Your session ID is ${r.save_id} - enter it in the box above on any visit to restore this exact state (${countsLine(r.counts)}).`
      );
      setIdIn(r.save_id);
      toast("Session saved - ID " + r.save_id);
      loadSaves();
    } catch (e) {
      toast("Save failed: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      busyRef.current = false;
      setBusy("");
    }
  };

  const restore = async (presetId?: string) => {
    const id = (presetId || idIn || "").trim();
    if (!id) {
      toast("Enter a session ID first - it looks like SM-7K2QX-9M4TD");
      inputRef.current?.focus();
      return;
    }
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy("restore");
    try {
      const r = await api<SaveResponse>("/api/v1/session/restore", {
        method: "POST",
        body: JSON.stringify({ save_id: id }),
      });
      setOut(
        `Session ${r.save_id} restored - saved ${
          r.saved_at ? fmtSavedAt(r.saved_at) + " UTC" : ""
        }, now live in this workspace: ${countsLine(r.counts)}.`
      );
      toast("Session restored exactly as saved");
      loadSaves();
      requestShellRefresh(true);
    } catch (e) {
      toast("Retrieve failed: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      busyRef.current = false;
      setBusy("");
    }
  };

  const btn =
    "font-sans text-[13px] font-medium px-3.5 py-2 rounded-none cursor-pointer disabled:opacity-60";
  const btnPrimary = `${btn} border border-blue text-white bg-blue hover:bg-[#2b5cd7]`;
  const btnGhost = `${btn} border border-line2 text-ink bg-transparent hover:border-blue`;

  return (
    <div id="sessions">
      <Panel
        title="Save & retrieve this session"
        sub="Save a snapshot of this workspace and restore it later with the session ID. Snapshots are stored in the workspace data volume."
      >
        <div className="flex gap-2 flex-wrap items-center mt-3">
          <button className={btnPrimary} onClick={save} disabled={!!busy}>
            {busy === "save" ? "Saving session..." : "Save this session"}
          </button>
          <input
            ref={inputRef}
            type="text"
            value={idIn}
            onChange={(e) => setIdIn(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") restore();
            }}
            placeholder="Enter session ID - e.g. SM-7K2QX-9M4TD"
            autoComplete="off"
            spellCheck={false}
            className="flex-1 min-w-[240px] glass-input border border-line rounded-none px-3 py-2 text-[13.5px] text-ink font-mono"
          />
          <button className={btnGhost} onClick={() => restore()} disabled={!!busy}>
            {busy === "restore" ? "Restoring session..." : "Retrieve session"}
          </button>
        </div>
        {out && <p className="text-[13px] leading-relaxed mt-2.5 mb-0">{out}</p>}
        <div className="mt-2">
          {saves === null && (
            <p className="font-mono text-[11px] text-mut tracking-[0.04em] m-0 py-1">
              LOADING SAVED SESSIONS...
            </p>
          )}
          {saves !== null &&
            (saves.length ? (
              <>
                <small className="text-mut">Saved sessions on this server:</small>
                <div className="flex flex-col">
                  {saves.map((s) => (
                    <div
                      key={s.save_id}
                      className="flex items-center gap-2.5 flex-wrap py-2 border-b border-white/[0.05] last:border-b-0"
                    >
                      <span
                        className="inline-block w-[7px] h-[7px] rounded-[50%] bg-ok shrink-0"
                        title="Saved and restorable"
                      />
                      <b className="font-mono text-[12.5px]">{s.save_id}</b>
                      <small className="text-mut">
                        {fmtSavedAt(s.saved_at)} UTC -{" "}
                        {s.counts
                          ? `${s.counts.invoices} invoices, ${s.counts.payments} payments, ${s.counts.runs} runs`
                          : ""}
                        {s.label ? ` - ${s.label}` : ""}
                      </small>
                      <button
                        className="ml-auto font-sans text-[12px] font-medium px-2.5 py-1.5 rounded-none border border-line2 text-ink bg-transparent hover:border-blue cursor-pointer disabled:opacity-60"
                        onClick={() => restore(s.save_id)}
                        disabled={!!busy}
                      >
                        Retrieve
                      </button>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <small className="text-mut">No saved sessions yet on this server.</small>
            ))}
        </div>
      </Panel>
    </div>
  );
}
