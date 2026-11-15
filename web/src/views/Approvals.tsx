import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, money } from "../lib/api";
import type { ApprovalEntry, DecideResponse } from "../lib/operate";
import Panel from "../ui/Panel";
import DataTable, { Row, Td, Th } from "../ui/DataTable";
import Pill from "../ui/Pill";
import { NAV_SPRING, RefreshFade } from "../ui/motion";
import { GhostBtn, PrimaryBtn } from "../ui/Stage3";

/* The maker-checker sign-off queue: ONE queue, in-page (blueprint 2).
   Vanilla keeps this queue twice (Run panel + header drawer); here
   the drawer dies and its one real job, evidence for a single match,
   survives as the slide-over the parent Run view opens. Row states
   follow the beUI approval pattern (pending, deciding, decided);
   decisions call POST /api/v1/matches/:id/decision with vanilla's
   payloads, and refusals (no invoices) are never bulk-decided -
   vanilla's approveAllHeld rule, kept. The floating bulk bar is the
   Obsidian Dashboard Shell pattern: glass surface, spring entrance,
   shown only while solved rows are selected. */

type RowState = { kind: "deciding" | "ok" | "no"; label: string };

export default function Approvals({
  reloadSignal,
  onEvidence,
  onDecided,
}: {
  reloadSignal: number;
  onEvidence: (a: ApprovalEntry) => void;
  onDecided: () => void;
}) {
  const [list, setList] = useState<ApprovalEntry[] | null>(null);
  const [error, setError] = useState("");
  const [states, setStates] = useState<Record<string, RowState>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkNote, setBulkNote] = useState("");
  const reduce = useReducedMotion();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    api<ApprovalEntry[]>("/api/v1/approvals")
      .then((l) => {
        setList(l);
        setError("");
        setSelected((cur) => {
          const ids = new Set(l.map((a) => a.match_id));
          return new Set([...cur].filter((id) => ids.has(id)));
        });
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(load, [load, reloadSignal]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const solved = (list || []).filter((a) => (a.invoices || []).length);
  const refusals = (list || []).length - solved.length;

  const inFlight = useRef<Set<string>>(new Set());
  const decide = useCallback(
    async (a: ApprovalEntry, decision: "approve" | "reject") => {
      // Synchronous in-flight guard: two clicks in the same tick both
      // see the pre-click React state, so the state check alone would
      // let a double-click post two decisions. The ref closes that.
      if (inFlight.current.has(a.match_id)) return;
      inFlight.current.add(a.match_id);
      setStates((s) => ({
        ...s,
        [a.match_id]: { kind: "deciding", label: "" },
      }));
      try {
        const r = await api<DecideResponse>(
          `/api/v1/matches/${a.match_id}/decision`,
          { method: "POST", body: JSON.stringify({ decision }) }
        );
        const label =
          r.status === "PARKED_SUSPENSE"
            ? "✓ Parked in suspense"
            : decision === "approve"
              ? "✓ Approved - document staged for SAP"
              : "Rejected";
        setStates((s) => ({
          ...s,
          [a.match_id]: {
            kind: r.status === "PARKED_SUSPENSE" || decision === "approve" ? "ok" : "no",
            label,
          },
        }));
        onDecided();
        timer.current = setTimeout(() => {
          setStates((s) => {
            const n = { ...s };
            delete n[a.match_id];
            return n;
          });
          load();
        }, 1000);
      } catch (e) {
        inFlight.current.delete(a.match_id);
        setStates((s) => {
          const n = { ...s };
          delete n[a.match_id];
          return n;
        });
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [load, onDecided]
  );

  const bulk = useCallback(
    async (decision: "approve" | "reject") => {
      const targets = solved.filter(
        (a) =>
          selected.has(a.match_id) &&
          !states[a.match_id] &&
          !inFlight.current.has(a.match_id)
      );
      if (!targets.length || bulkBusy) return;
      targets.forEach((a) => inFlight.current.add(a.match_id));
      setBulkBusy(true);
      setBulkNote("");
      let ok = 0;
      try {
        for (const a of targets) {
          await api(`/api/v1/matches/${a.match_id}/decision`, {
            method: "POST",
            body: JSON.stringify({ decision }),
          });
          ok++;
        }
        setBulkNote(
          decision === "approve"
            ? `Approved and posted ${ok} held match${ok === 1 ? "" : "es"} - SAP documents issued, invoices settled, settlement drafts generated${refusals ? `. ${refusals} refusal${refusals === 1 ? "" : "s"} left in the queue - a refusal is never bulk-posted; park or send it back individually` : ""}`
            : `Rejected ${ok} held match${ok === 1 ? "" : "es"} - nothing in the ledger changed for them.`
        );
        setSelected(new Set());
        onDecided();
        load();
      } catch (e) {
        setBulkNote(
          `Bulk ${decision === "approve" ? "approval" : "rejection"} stopped partway: ${e instanceof Error ? e.message : String(e)}`
        );
        load();
      } finally {
        targets.forEach((a) => inFlight.current.delete(a.match_id));
        setBulkBusy(false);
      }
    },
    [solved, selected, states, bulkBusy, refusals, load, onDecided]
  );

  const approveAll = useCallback(async () => {
    if (bulkBusy) return;
    setBulkBusy(true);
    setBulkNote("");
    try {
      const fresh = await api<ApprovalEntry[]>("/api/v1/approvals");
      const real = fresh.filter(
        (a) => (a.invoices || []).length && !inFlight.current.has(a.match_id)
      );
      const refs = fresh.filter((a) => !(a.invoices || []).length).length;
      real.forEach((a) => inFlight.current.add(a.match_id));
      let ok = 0;
      for (const a of real) {
        await api(`/api/v1/matches/${a.match_id}/decision`, {
          method: "POST",
          body: JSON.stringify({ decision: "approve" }),
        });
        inFlight.current.delete(a.match_id);
        ok++;
      }
      setBulkNote(
        `Approved and posted ${ok} held match${ok === 1 ? "" : "es"} - SAP documents issued, invoices settled, settlement drafts generated${refs ? `. ${refs} refusal${refs === 1 ? "" : "s"} left in the queue - a refusal is never bulk-posted; park or send it back individually` : ""}`
      );
      onDecided();
      load();
    } catch (e) {
      setBulkNote(
        `Bulk approval stopped partway: ${e instanceof Error ? e.message : String(e)}`
      );
    } finally {
      setBulkBusy(false);
    }
  }, [bulkBusy, load, onDecided]);

  const toggle = (id: string) =>
    setSelected((cur) => {
      const n = new Set(cur);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const selSolved = solved.filter((a) => selected.has(a.match_id));

  return (
    <Panel
      title={`Maker-checker sign-off queue${list && list.length ? ` - ${list.length} waiting${refusals ? ` (${refusals} refusal${refusals === 1 ? "" : "s"} - park or send back individually)` : ""}` : ""}`}
      sub="Full width, on the page - approve individually, or post every solved held match in one action (an unmatched wire in the queue is decided on its own)."
    >
      <div className="flex items-center gap-3 flex-wrap mt-3">
        <PrimaryBtn onClick={approveAll} disabled={bulkBusy || !solved.length}>
          {solved.length
            ? `Approve & post all ${solved.length} held matches`
            : "Approve & post all held matches"}
        </PrimaryBtn>
        {list && list.length > 0 && (
          <Pill kind="warn">{list.length} waiting</Pill>
        )}
      </div>
      {bulkNote && (
        <p className="text-[13px] text-mut leading-relaxed m-0 mt-2">{bulkNote}</p>
      )}
      {error && (
        <p className="text-[13px] text-bad m-0 mt-2 break-words">
          Could not load approvals: {error}
        </p>
      )}
      {!list && !error && (
        <p className="font-mono text-[12px] text-mut m-0 py-3">
          LOADING THE QUEUE...
        </p>
      )}
      {list && list.length === 0 && (
        <p className="text-[13px] text-mut m-0 mt-3">
          Nothing waiting. Matches appear here when policy holds one - lower
          the maker-checker threshold in Policy Studio and run a batch to see
          it work.
        </p>
      )}
      {list && list.length > 0 && (
        <RefreshFade signature={list.map((a) => a.match_id).join(",")}>
          <DataTable
            head={
              <>
                <Th className="w-[30px]">{null}</Th>
                <Th>Payment</Th>
                <Th>Amount</Th>
                <Th>Matched invoices</Th>
                <Th>Conf.</Th>
                <Th>Why it is held</Th>
                <Th>Decision</Th>
              </>
            }
          >
            {list.map((a) => {
              const refusal = !(a.invoices || []).length;
              const st = states[a.match_id];
              return (
                <Row key={a.match_id}>
                  <Td>
                    {!refusal && (
                      <input
                        type="checkbox"
                        aria-label={`Select ${a.payment_id} for bulk decision`}
                        checked={selected.has(a.match_id)}
                        disabled={!!st || bulkBusy}
                        onChange={() => toggle(a.match_id)}
                        className="accent-[#3d75e8] w-4 h-4 cursor-pointer"
                      />
                    )}
                  </Td>
                  <Td>
                    <button
                      className="bg-transparent border-0 p-0 font-sans text-[13px] text-blue2 cursor-pointer hover:underline"
                      onClick={() => onEvidence(a)}
                      title="Open this match's evidence"
                    >
                      {a.payment_id}
                    </button>
                    <br />
                    <span className="text-[11.5px] text-mut">{a.run_id}</span>
                  </Td>
                  <Td>{a.amount_cents == null ? "-" : money(a.amount_cents)}</Td>
                  <Td>
                    {refusal ? (
                      <Pill kind="warn">Refusal - no invoices matched</Pill>
                    ) : (
                      a.invoices.join(", ")
                    )}
                  </Td>
                  <Td>{Number(a.confidence).toFixed(2)}</Td>
                  <Td>
                    <span className="block max-w-[340px]">
                      {a.decision_reason || "Held for review"}
                    </span>
                  </Td>
                  <Td>
                    {st ? (
                      st.kind === "deciding" ? (
                        <span className="text-mut">Posting...</span>
                      ) : (
                        <span
                          className={
                            st.kind === "ok"
                              ? "text-ok font-medium whitespace-nowrap"
                              : "text-mut whitespace-nowrap"
                          }
                        >
                          {st.label}
                        </span>
                      )
                    ) : refusal ? (
                      <span className="whitespace-nowrap">
                        <GhostBtn onClick={() => decide(a, "approve")}>
                          Park in suspense GL
                        </GhostBtn>{" "}
                        <GhostBtn onClick={() => decide(a, "reject")}>
                          Send back
                        </GhostBtn>
                      </span>
                    ) : (
                      <span className="whitespace-nowrap">
                        <GhostBtn onClick={() => decide(a, "approve")}>
                          Approve and post
                        </GhostBtn>{" "}
                        <GhostBtn onClick={() => decide(a, "reject")}>
                          Reject
                        </GhostBtn>
                      </span>
                    )}
                  </Td>
                </Row>
              );
            })}
          </DataTable>
          {refusals > 0 && (
            <p className="text-[12px] text-mut leading-relaxed m-0 mt-2">
              A refusal is the solver's verdict that nothing in the ledger
              explains the wire. It can never be posted - there is no document
              behind it. Park it in unapplied suspense (the remittance chase
              is already drafted in the Mail Hub) or send it back for manual
              allocation.
            </p>
          )}
        </RefreshFade>
      )}

      <AnimatePresence>
        {selSolved.length > 0 && (
          <motion.div
            className="fixed bottom-6 left-1/2 z-40 flex items-center gap-3 pl-5 pr-2 py-2 rounded-full border border-white/[0.14]"
            style={{
              background: "rgba(28, 28, 29, 0.82)",
              backdropFilter: "blur(16px) saturate(1.2)",
              WebkitBackdropFilter: "blur(16px) saturate(1.2)",
              boxShadow:
                "inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 40px rgba(0,0,0,0.5)",
              x: "-50%",
            }}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 24 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: 24 }}
            transition={reduce ? { duration: 0 } : NAV_SPRING}
            role="region"
            aria-label="Bulk actions"
          >
            <span className="font-mono text-[12px] text-mut whitespace-nowrap">
              {selSolved.length} selected
            </span>
            <PrimaryBtn onClick={() => bulk("approve")} disabled={bulkBusy}>
              Approve &amp; post {selSolved.length}
            </PrimaryBtn>
            <GhostBtn onClick={() => bulk("reject")} disabled={bulkBusy}>
              Reject {selSolved.length}
            </GhostBtn>
            <GhostBtn onClick={() => setSelected(new Set())} disabled={bulkBusy}>
              Clear
            </GhostBtn>
          </motion.div>
        )}
      </AnimatePresence>
    </Panel>
  );
}
