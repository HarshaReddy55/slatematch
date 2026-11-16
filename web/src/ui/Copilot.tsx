import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import {
  copilotSuggestions,
  splitFacts,
  type CopilotReply,
} from "../lib/chrome";
import Orb from "./Orb";

/* Stage 4: the Copilot (assist.js ask / renderSuggestions /
   toggleChat). Same FAB, same panel shape, same header line, same
   suggested questions built from the current data, same endpoint.
   Audit row 10 fixes: answers render one fact per line (vanilla
   prints one dense paragraph) and citations sit under the answer
   as quiet mono lines instead of debug-style pills. The Thinking
   Orbs pending state stays exactly as it was - the kit Orb in a
   pill with "Thinking...". The composer takes the EasyUI Prompt
   Input pattern: one bordered row, the send control inside it. */

interface Entry {
  who: "You" | "Copilot";
  facts: string[];
  citations?: string[];
}

export default function Copilot() {
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [sugg, setSugg] = useState<string[]>([]);
  const pendingRef = useRef(false);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      copilotSuggestions().then(setSugg).catch(() => setSugg([]));
      setTimeout(() => inputRef.current?.focus(), 40);
    }
  }, [open ]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log, pending, open]);

  const ask = async (raw?: string) => {
    const q = (raw ?? input).trim();
    if (!q || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setInput("");
    setLog((l) => [...l, { who: "You", facts: [q] }]);
    try {
      const a = await api<CopilotReply>("/api/v1/copilot", {
        method: "POST",
        body: JSON.stringify({ question: q }),
      });
      setLog((l) => [
        ...l,
        {
          who: "Copilot",
          facts: splitFacts(a.answer || ""),
          citations: a.citations || [],
        },
      ]);
    } catch (e) {
      setLog((l) => [
        ...l,
        {
          who: "Copilot",
          facts: [
            "I could not answer that: " +
              (e instanceof Error ? e.message : String(e)),
          ],
        },
      ]);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setOpen((o) => !o)}
        title="Ask the assistant - answers only from this workspace's records"
        aria-label="Open assistant chat"
        className="fixed right-[22px] bottom-[22px] z-[60] w-[52px] h-[52px] rounded-full bg-blue border-0 cursor-pointer flex items-center justify-center shadow-[0_10px_28px_rgba(0,0,0,0.45)] pressable"
      >
        <svg
          width="26"
          height="26"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#fff"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
        </svg>
      </button>

      {open && (
        <div
          className="glass-pop fixed right-[22px] bottom-[86px] z-[60] w-[392px] max-w-[calc(100vw-32px)] max-h-[min(72vh,640px)] rounded-md border border-white/[0.11] flex flex-col"
          role="dialog"
          aria-label="Assistant"
        >
          <div className="flex items-center gap-2.5 px-3.5 py-3 border-b border-white/[0.08]">
            <b className="font-display text-[15px]">Assistant</b>
            <span className="text-mut text-[11.5px] leading-snug">
              Answers only from this workspace's records - runs, matches,
              exceptions, evaluations. If the records cannot answer, it
              says so.
            </span>
            <button
              onClick={() => setOpen(false)}
              aria-label="Close assistant chat"
              className="ml-auto shrink-0 w-[26px] h-[26px] bg-transparent border border-line2 text-ink cursor-pointer rounded-[3px]"
            >
              ✕
            </button>
          </div>

          <div className="px-3.5 pt-2.5">
            <span className="font-mono text-[10px] tracking-[0.06em] text-mut">
              SUGGESTED - FROM YOUR CURRENT DATA
            </span>
            <div className="flex flex-wrap gap-1.5 mt-1.5" data-sugg="1">
              {sugg.map((q) => (
                <button
                  key={q}
                  onClick={() => ask(q)}
                  className="font-sans text-[12px] px-2.5 py-1.5 rounded-full border border-line2 text-ink bg-transparent hover:border-blue cursor-pointer text-left"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>

          <div ref={logRef} className="overflow-y-auto px-3.5 py-2.5 flex-1">
            <div className="flex flex-col gap-3">
              {log.map((e, i) => (
                <div key={i} className="text-[13px] leading-relaxed">
                  <b>{e.who}:</b>{" "}
                  {e.who === "You" ? (
                    <span>{e.facts[0]}</span>
                  ) : (
                    <>
                      <span className="flex flex-col gap-1 mt-0.5">
                        {e.facts.map((f, j) => (
                          <span key={j} className="block">
                            {f}
                          </span>
                        ))}
                      </span>
                      {e.citations && e.citations.length > 0 && (
                        <span className="flex flex-col mt-1.5">
                          {e.citations.map((c) => (
                            <span
                              key={c}
                              className="font-mono text-[10.5px] text-mut2 leading-relaxed"
                            >
                              {c}
                            </span>
                          ))}
                        </span>
                      )}
                    </>
                  )}
                </div>
              ))}
              {pending && (
                <div className="flex">
                  <span className="inline-flex items-center gap-2 border border-line2 rounded-full pl-1.5 pr-3 py-1 text-[12.5px] text-mut">
                    <Orb state="listening" size={30} label="Thinking" />
                    Thinking...
                  </span>
                </div>
              )}
            </div>
          </div>

          <div className="p-3 border-t border-white/[0.08]">
            <div className="flex items-center gap-2 glass-input border border-line rounded-[6px] px-3 py-1.5 focus-within:border-blue">
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") ask();
                }}
                placeholder="Ask about runs, matches, exceptions, accuracy..."
                className="flex-1 bg-transparent border-0 outline-none text-[13.5px] text-ink py-1.5"
              />
              <button
                onClick={() => ask()}
                title="Ask"
                aria-label="Ask"
                className="shrink-0 w-[30px] h-[30px] rounded-[4px] bg-blue text-white border-0 cursor-pointer text-[15px] leading-none pressable"
              >
                ↑
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
