import { useCallback, useEffect, useState } from "react";
import { api, money } from "../lib/api";
import { useWsRefresh } from "../lib/chrome";
import {
  aiWhy,
  sendMail,
  sendStatusText,
  type ChaseFact,
  type DeskFact,
  type DraftResult,
  type RunException,
  type StoredMatch,
} from "../lib/operate";
import Panel from "../ui/Panel";
import Pill from "../ui/Pill";
import { GhostBtn } from "../ui/Stage3";
import DataTable, { Row, Td, Th } from "../ui/DataTable";
import type { OutboxMail } from "../lib/operate";

/* The dispute desk, the React form of renderDisputeDesk() +
   deskCard() / chaseCard() in assist.js. Claims come from the run's
   matches (deduction AUTO_GENERATE_DISPUTE_CLAIM), chases from its
   NO_MATCH exceptions. Drafts compose from the same /ai/draft facts
   payloads, auto-filled on arrival exactly as vanilla fills them;
   sends go through the shared mail send with vanilla's kinds and
   status wording. */

const TONES: [string, string][] = [
  ["strict", "Strict Audit"],
  ["contract", "Contract Cap"],
  ["escalate", "VP Escalate"],
];

interface DeskState {
  tone: string;
  text: string;
  src: string | null;
  to: string;
  mail: { text: string; kind: "ok" | "warn" | "bad" } | null;
  rebText: string;
  rebSrc: string | null;
  busy: boolean;
}

const blankDesk = (): DeskState => ({
  tone: "strict",
  text: "",
  src: null,
  to: "",
  mail: null,
  rebText: "",
  rebSrc: null,
  busy: false,
});

export default function Desk({
  matches,
  exceptions,
}: {
  matches: StoredMatch[];
  exceptions: RunException[];
}) {
  /* F10 (refresh consolidation): the desk used to take a
     reloadSignal counter prop from Run; it now subscribes to
     the shell refresh itself, like every other view. Its items
     arrive as props from Run's own reload; the tick only
     re-reads the outbox strip and re-fills drafts. */
  const [wsTick, setWsTick] = useState(0);
  useWsRefresh(useCallback(() => setWsTick((n) => n + 1), []));
  const desk: DeskFact[] = matches
    .filter(
      (m) =>
        m.result?.deduction?.autonomous_action === "AUTO_GENERATE_DISPUTE_CLAIM"
    )
    .map((m) => {
      const d = m.result!.deduction!;
      return {
        payment_id: m.payment_id,
        payer: d.payer || "Buyer",
        claimed_cents: d.claimed_cents || 0,
        reason_code: d.assigned_erp_reason_code,
        classification_label: d.classification?.label || "deduction",
        win_probability: d.win_probability,
        expected_recovery_usd: d.expected_recovery_value_usd,
        tone: "strict",
      };
    });
  const chase: ChaseFact[] = exceptions
    .filter((e) => e.kind === "NO_MATCH")
    .map((e) => ({
      payment_id: e.payment_id,
      payer: e.detail?.payer || "Unknown payer",
      amount_cents: e.detail?.amount_cents || 0,
    }));

  /* loadOutbox() in assist.js: the outbox strip inside the desk
     panel, refreshed after every send from this panel. */
  const [outbox, setOutbox] = useState<{
    configured: boolean;
    from?: string;
    mails: OutboxMail[];
  } | null>(null);
  const [outboxTick, setOutboxTick] = useState(0);
  useEffect(() => {
    let live = true;
    api<{ configured: boolean; from?: string; mails: OutboxMail[] }>(
      "/api/v1/mail/outbox"
    )
      .then((o) => {
        if (live) setOutbox(o);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [wsTick, outboxTick]);

  const [deskState, setDeskState] = useState<Record<string, DeskState>>({});
  const [chaseState, setChaseState] = useState<
    Record<string, { text: string; src: string | null; to: string; mail: DeskState["mail"]; busy: boolean }>
  >({});

  const fillDesk = useCallback(async (f: DeskFact, tone: string) => {
    try {
      const d = await api<DraftResult>("/api/v1/ai/draft", {
        method: "POST",
        body: JSON.stringify({
          kind: "dispute_email",
          tone,
          facts: { ...f, tone },
        }),
      });
      setDeskState((s) => ({
        ...s,
        [f.payment_id]: {
          ...(s[f.payment_id] || blankDesk()),
          tone,
          text: d.text || "",
          src:
            d.source === "gemini"
              ? "Written by Gemini"
              : `Grounded template - ${aiWhy(d)}`,
        },
      }));
    } catch {
      /* vanilla leaves the box empty on a failed draft */
    }
  }, []);

  const fillChase = useCallback(async (f: ChaseFact) => {
    try {
      const d = await api<DraftResult>("/api/v1/ai/draft", {
        method: "POST",
        body: JSON.stringify({ kind: "chase_email", tone: "strict", facts: f }),
      });
      setChaseState((s) => ({
        ...s,
        [f.payment_id]: {
          ...(s[f.payment_id] || { text: "", src: null, to: "", mail: null, busy: false }),
          text: d.text || "",
          src:
            d.source === "gemini"
              ? "Written by Gemini"
              : `Grounded template - ${aiWhy(d)}`,
        },
      }));
    } catch {
      /* same as vanilla */
    }
  }, []);

  // Auto-fill drafts when the desk's items change (a new run).
  const deskKey = desk.map((f) => f.payment_id).join(",");
  const chaseKey = chase.map((f) => f.payment_id).join(",");
  useEffect(() => {
    desk.forEach((f) => fillDesk(f, "strict"));
    chase.forEach((f) => fillChase(f));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deskKey, chaseKey, wsTick]);

  if (!desk.length && !chase.length) return null;

  const patchDesk = (pid: string, p: Partial<DeskState>) =>
    setDeskState((s) => ({
      ...s,
      [pid]: { ...(s[pid] || blankDesk()), ...p },
    }));

  const sendDesk = async (f: DeskFact) => {
    const st = deskState[f.payment_id] || blankDesk();
    if (!st.to.trim()) return;
    if (!st.text) return;
    patchDesk(f.payment_id, { busy: true });
    try {
      const r = await sendMail("dispute_claim", f.payment_id, st.to, st.text);
      patchDesk(f.payment_id, {
        mail: {
          text: sendStatusText(r.status),
          kind: r.status === "sent" ? "ok" : r.status === "failed" ? "bad" : "warn",
        },
      });
      setOutboxTick((t) => t + 1);
    } catch (e) {
      patchDesk(f.payment_id, {
        mail: { text: e instanceof Error ? e.message : String(e), kind: "bad" },
      });
    } finally {
      patchDesk(f.payment_id, { busy: false });
    }
  };

  const rebuttal = async (f: DeskFact, kind: string) => {
    const st = deskState[f.payment_id] || blankDesk();
    patchDesk(f.payment_id, { busy: true });
    try {
      const facts = {
        ...f,
        tone: st.tone,
        buyer_reply: kind,
        offer_usd: kind === "split" ? Math.round(f.claimed_cents / 2) / 100 : 0,
      };
      const d = await api<DraftResult>("/api/v1/ai/draft", {
        method: "POST",
        body: JSON.stringify({ kind: "rebuttal", tone: st.tone, facts }),
      });
      patchDesk(f.payment_id, {
        rebText: d.text || "",
        rebSrc:
          d.source === "gemini"
            ? "Written by Gemini"
            : `Grounded template - ${aiWhy(d)}`,
      });
    } catch {
      /* vanilla toasts; the box simply stays empty here */
    } finally {
      patchDesk(f.payment_id, { busy: false });
    }
  };

  const sendChase = async (f: ChaseFact) => {
    const st =
      chaseState[f.payment_id] || { text: "", src: null, to: "", mail: null, busy: false };
    if (!st.to.trim() || !st.text) return;
    setChaseState((s) => ({ ...s, [f.payment_id]: { ...st, busy: true } }));
    try {
      const r = await sendMail("chase", f.payment_id, st.to, st.text);
      setOutboxTick((t) => t + 1);
      setChaseState((s) => ({
        ...s,
        [f.payment_id]: {
          ...st,
          busy: false,
          mail: {
            text: sendStatusText(r.status),
            kind: r.status === "sent" ? "ok" : r.status === "failed" ? "bad" : "warn",
          },
        },
      }));
    } catch (e) {
      setChaseState((s) => ({
        ...s,
        [f.payment_id]: {
          ...st,
          busy: false,
          mail: { text: e instanceof Error ? e.message : String(e), kind: "bad" },
        },
      }));
    }
  };

  return (
    <Panel
      title="Dispute desk - deductions worth fighting"
      sub="Claims opened by the expected-value rule. Review the draft, add the buyer's AP email, and send it from here. Every send is recorded in the Outbox with its true status."
    >
      <div className="flex flex-col gap-4 mt-3">
        {desk.map((f) => {
          const st = deskState[f.payment_id] || blankDesk();
          return (
            <div
              key={f.payment_id}
              className="glass-card rounded-none border border-line p-4"
            >
              <p className="text-[13px] leading-relaxed m-0">
                <b>{f.payment_id}</b> - {f.payer} - claim{" "}
                <b>{money(f.claimed_cents)}</b> - {f.reason_code} (
                {f.classification_label}) - win probability {f.win_probability}{" "}
                - expected recovery $
                {Number(f.expected_recovery_usd || 0).toFixed(2)}
              </p>
              <div className="flex gap-1.5 flex-wrap mt-2.5">
                {TONES.map(([t, l]) => (
                  <button
                    key={t}
                    className={`font-sans text-[12px] px-2.5 py-1 rounded-none border cursor-pointer pressable ${
                      st.tone === t
                        ? "border-blue text-white bg-[rgba(61,117,232,0.18)]"
                        : "border-line2 text-ink bg-panel hover:text-ink"
                    }`}
                    onClick={() => {
                      patchDesk(f.payment_id, { tone: t });
                      fillDesk(f, t);
                    }}
                  >
                    {l}
                  </button>
                ))}
                <GhostBtn onClick={() => fillDesk(f, st.tone)}>
                  Draft claim email
                </GhostBtn>
              </div>
              <textarea
                className="w-full box-border font-sans text-[13px] leading-relaxed px-3 py-2 rounded-none border border-line2 glass-input text-ink mt-2.5"
                rows={9}
                placeholder="The claim draft appears here - editable before you send or copy it."
                value={st.text}
                onChange={(e) => patchDesk(f.payment_id, { text: e.target.value })}
              />
              <div className="flex gap-2 items-center flex-wrap mt-1.5">
                <GhostBtn
                  onClick={() =>
                    navigator.clipboard?.writeText(st.text).catch(() => {})
                  }
                >
                  Copy draft
                </GhostBtn>
                {st.src && <Pill kind="info">{st.src}</Pill>}
              </div>
              <div className="flex gap-2 items-center flex-wrap mt-2.5">
                <input
                  className="flex-1 min-w-[200px] box-border font-sans text-[13px] px-3 py-2 rounded-none border border-line2 glass-input text-ink"
                  placeholder="Buyer AP email - e.g. ap@buyer.com"
                  value={st.to}
                  onChange={(e) => patchDesk(f.payment_id, { to: e.target.value })}
                />
                <button
                  className="font-sans text-[12.5px] font-medium px-3 py-1.5 rounded-none border border-blue text-white bg-blue hover:bg-[#2b5cd7] cursor-pointer disabled:opacity-50 pressable"
                  disabled={st.busy}
                  onClick={() => sendDesk(f)}
                >
                  Send claim
                </button>
                {st.mail && <Pill kind={st.mail.kind}>{st.mail.text}</Pill>}
              </div>
              <div className="flex gap-1.5 flex-wrap items-center mt-3">
                <span className="text-[12px] text-mut">Simulate buyer reply:</span>
                <GhostBtn onClick={() => rebuttal(f, "damage")}>
                  Concealed damage
                </GhostBtn>
                <GhostBtn onClick={() => rebuttal(f, "discount_timing")}>
                  Discount timing
                </GhostBtn>
                <GhostBtn onClick={() => rebuttal(f, "split")}>
                  Offers 50% split
                </GhostBtn>
              </div>
              <textarea
                className="w-full box-border font-sans text-[13px] leading-relaxed px-3 py-2 rounded-none border border-line2 glass-input text-ink mt-2"
                rows={5}
                placeholder="The rebuttal draft appears here. The 50% split answer is computed from this claim's expected value."
                value={st.rebText}
                onChange={(e) =>
                  patchDesk(f.payment_id, { rebText: e.target.value })
                }
              />
              <div className="flex gap-2 items-center flex-wrap mt-1.5">
                <GhostBtn
                  onClick={() =>
                    navigator.clipboard?.writeText(st.rebText).catch(() => {})
                  }
                >
                  Copy rebuttal
                </GhostBtn>
                {st.rebSrc && <Pill kind="info">{st.rebSrc}</Pill>}
              </div>
            </div>
          );
        })}

        {chase.length > 0 && (
          <>
            <h4 className="font-display text-[14px] font-semibold m-0 mt-2">
              Unmatched payments - chase the remittance
            </h4>
            <p className="text-[13px] text-mut leading-relaxed m-0">
              These payments matched nothing, so the cash sits unapplied.
              Draft the chase email here; the payer is asked which invoices
              the money was for instead of the platform guessing an
              allocation.
            </p>
            {chase.map((f) => {
              const st = chaseState[f.payment_id] || {
                text: "",
                src: null,
                to: "",
                mail: null,
                busy: false,
              };
              return (
                <div
                  key={f.payment_id}
                  className="glass-card rounded-none border border-line p-4"
                >
                  <p className="text-[13px] leading-relaxed m-0">
                    <b>{f.payment_id}</b> - {f.payer} -{" "}
                    <b>{money(f.amount_cents)}</b> could not be matched to any
                    open invoice - no invoice set on the ledger explains this
                    wire.
                  </p>
                  <div className="mt-2.5">
                    <GhostBtn onClick={() => fillChase(f)}>
                      Draft chase email
                    </GhostBtn>
                  </div>
                  <textarea
                    className="w-full box-border font-sans text-[13px] leading-relaxed px-3 py-2 rounded-none border border-line2 glass-input text-ink mt-2.5"
                    rows={9}
                    placeholder="The chase draft appears here - it asks the payer for the remittance advice and confirms the amount stays unapplied meanwhile."
                    value={st.text}
                    onChange={(e) =>
                      setChaseState((s) => ({
                        ...s,
                        [f.payment_id]: { ...st, text: e.target.value },
                      }))
                    }
                  />
                  <div className="flex gap-2 items-center flex-wrap mt-1.5">
                    <GhostBtn
                      onClick={() =>
                        navigator.clipboard?.writeText(st.text).catch(() => {})
                      }
                    >
                      Copy draft
                    </GhostBtn>
                    {st.src && <Pill kind="info">{st.src}</Pill>}
                  </div>
                  <div className="flex gap-2 items-center flex-wrap mt-2.5">
                    <input
                      className="flex-1 min-w-[200px] box-border font-sans text-[13px] px-3 py-2 rounded-none border border-line2 glass-input text-ink"
                      placeholder="Payer AP email - e.g. ap@payer.com"
                      value={st.to}
                      onChange={(e) =>
                        setChaseState((s) => ({
                          ...s,
                          [f.payment_id]: { ...st, to: e.target.value },
                        }))
                      }
                    />
                    <button
                      className="font-sans text-[12.5px] font-medium px-3 py-1.5 rounded-none border border-blue text-white bg-blue hover:bg-[#2b5cd7] cursor-pointer disabled:opacity-50 pressable"
                      disabled={st.busy}
                      onClick={() => sendChase(f)}
                    >
                      Send chase
                    </button>
                    {st.mail && <Pill kind={st.mail.kind}>{st.mail.text}</Pill>}
                  </div>
                </div>
              );
            })}
          </>
        )}

        {outbox && (
          <>
            <h4 className="font-display text-[14px] font-semibold m-0 mt-2">
              Outbox
            </h4>
            <p className="text-[13px] text-mut leading-relaxed m-0 flex gap-2 items-center flex-wrap">
              {outbox.configured ? (
                <Pill kind="ok">
                  Mailbox configured - sends go out from {outbox.from}
                </Pill>
              ) : (
                <Pill kind="warn">
                  No mailbox configured - sends are recorded, not sent
                </Pill>
              )}
              <span>
                Every send from this product is recorded here with its true
                status - a mail is only ever shown as sent when the mail
                server accepted it.
              </span>
            </p>
            {outbox.mails.length ? (
              <DataTable
                head={
                  <>
                    <Th>When (UTC)</Th>
                    <Th>To</Th>
                    <Th>Subject</Th>
                    <Th>Kind</Th>
                    <Th>Status</Th>
                  </>
                }
              >
                {outbox.mails.slice(0, 10).map((m, i) => (
                  <Row key={i}>
                      <Td>
                        {(m.created_at || "").slice(5, 16).replace("T", " ")}
                      </Td>
                      <Td>{m.to}</Td>
                      <Td>{m.subject}</Td>
                      <Td>{m.kind}</Td>
                      <Td>
                        <Pill
                          kind={
                            m.status === "sent"
                              ? "ok"
                              : m.status === "failed"
                                ? "bad"
                                : "warn"
                          }
                        >
                          {m.status === "sent"
                            ? "Sent"
                            : m.status === "failed"
                              ? "Failed"
                              : "Recorded - not sent"}
                        </Pill>
                      </Td>
                  </Row>
                ))}
              </DataTable>
            ) : (
              <p className="text-[12.5px] text-mut m-0">Nothing sent yet.</p>
            )}
          </>
        )}
      </div>
    </Panel>
  );
}
