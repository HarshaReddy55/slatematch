import { motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, money } from "../lib/api";
import {
  aiWhy,
  goView,
  outboxStatusText,
  sendMail,
  sendStatusText,
  setIntent,
  takeIntent,
  type DraftResult,
  type DunningItem,
  type MailHub,
  type OutboxMail,
} from "../lib/operate";
import { ErpServerDoc } from "./MatchDetail";
import type { ErpPaymentDocument } from "../lib/operate";
import Panel from "../ui/Panel";
import Pill, { type PillKind } from "../ui/Pill";
import ViewHead, { LoadError } from "../ui/ViewHead";
import ViewSkeleton from "../ui/Skeleton";
import { EASE_OUT, RefreshFade, Rise } from "../ui/motion";
import { GhostBtn, StagedGate } from "../ui/Stage3";
import type { WorkspaceOperate } from "../lib/operate";

/* Stage 3: Outbound Mail Hub (08). Stream tabs keep vanilla's
   counts; the preview pane carries a fixed footer with Send and the
   true status; the Outbox is an EasyUI Activity Feed (timestamp
   first, kind chip, honest status). Drafts use the same endpoints
   and facts payloads as the vanilla hub; sending uses the shared
   send with vanilla's kinds, refs and preset subjects. The mailbox
   truth line is always visible: with no SMTP configured, sends are
   recorded, not sent, and the UI says so. */

type Cat = "disputes" | "chases" | "settlements" | "dunning" | "outbox";

const CATS: [Cat, string][] = [
  ["disputes", "Dispute & Short-Pay Claims"],
  ["chases", "Exception & Unidentified Wire Inquiries"],
  ["settlements", "SAP Settlement Confirmations"],
  ["dunning", "Overdue Dunning Reminders"],
  ["outbox", "Outbox"],
];

const TONES: [string, string][] = [
  ["strict", "Standard Audit"],
  ["contract", "Contract Cap"],
  ["escalate", "VP Escalate"],
];

const EMPTY_COPY: Record<string, string> = {
  disputes:
    "No dispute claims in the latest run - no deduction met the expected-value rule.",
  chases:
    "No wires are waiting on identification or a missing amount in the latest run.",
  settlements: "No cleared payments in the latest run yet.",
  dunning: "Nothing open after the run - the whole book is settled.",
};

interface PreviewState {
  to: string;
  text: string;
  src: string | null;
  subject?: string;
  busy: boolean;
  drafting: boolean;
}

const blankPreview = (): PreviewState => ({
  to: "",
  text: "",
  src: null,
  busy: false,
  drafting: false,
});

export default function Mail() {
  const [hub, setHub] = useState<MailHub | null>(null);
  const [ws, setWs] = useState<WorkspaceOperate | null>(null);
  const [error, setError] = useState("");
  const [cat, setCat] = useState<Cat>("disputes");
  const [sel, setSel] = useState<Record<string, number>>({
    disputes: 0,
    chases: 0,
    settlements: 0,
    dunning: 0,
  });
  const [tone, setTone] = useState("strict");
  const [preview, setPreview] = useState<PreviewState>(blankPreview());
  const [mailNote, setMailNote] = useState<{
    key: string;
    text: string;
    kind: PillKind;
  } | null>(null);
  const [sapDoc, setSapDoc] = useState<ErpPaymentDocument | null>(null);
  const [sapOpen, setSapOpen] = useState(false);
  const reduce = useReducedMotion();
  const seq = useRef(0);
  const focusDone = useRef(false);

  const load = useCallback(() => {
    setError("");
    Promise.all([
      api<MailHub>("/api/v1/mail/hub"),
      api<WorkspaceOperate>("/api/v1/workspace").catch(() => null),
    ])
      .then(([h, w]) => {
        setHub(h);
        setWs(w);
        if (!focusDone.current) {
          focusDone.current = true;
          /* goMailFor(cat, ref): land on the named category with the
             named item selected. Callers: the Run exceptions chase,
             the Forecast dispute Dispatch, the Dashboard recovery
             figure, the Desk. A bare focus with no category keeps
             the original chase behaviour, then tries the rest. */
          const focus = takeIntent("slate-mail-focus");
          const namedCat = takeIntent("slate-mail-cat") as Cat | null;
          if (focus || namedCat) {
            const keyOf = (c: Cat, d: unknown): string =>
              c === "dunning"
                ? (d as DunningItem).invoice_id
                : (d as { payment_id: string }).payment_id;
            const cats: Cat[] =
              namedCat && namedCat !== "outbox"
                ? [namedCat]
                : ["chases", "disputes", "settlements", "dunning"];
            let landed = false;
            if (focus) {
              for (const c of cats) {
                const ix = ((h[c] || []) as unknown[]).findIndex(
                  (d) => keyOf(c, d) === focus
                );
                if (ix >= 0) {
                  setCat(c);
                  setSel((s) => ({ ...s, [c]: ix }));
                  landed = true;
                  break;
                }
              }
            }
            if (!landed && namedCat && namedCat !== "outbox")
              setCat(namedCat);
            else if (!landed && !namedCat && focus) setCat("chases");
          }
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(load, [load]);

  const items = hub
    ? cat === "outbox"
      ? []
      : hub[cat] || []
    : [];
  const idx = Math.min(sel[cat] || 0, Math.max(items.length - 1, 0));
  const item = items[idx];

  /* ---------- drafting (hubDraft*Into equivalents) ---------- */
  const draftInto = useCallback(
    async (c: Cat, h: MailHub, i: number, t: string) => {
      const my = ++seq.current;
      setPreview({ ...blankPreview(), drafting: true });
      setSapDoc(null);
      setSapOpen(false);
      try {
        if (c === "disputes") {
          const d = h.disputes[i];
          if (!d) return;
          const r = await api<DraftResult>("/api/v1/ai/draft", {
            method: "POST",
            body: JSON.stringify({
              kind: "dispute_email",
              tone: t,
              facts: {
                payment_id: d.payment_id,
                payer: d.payer,
                claimed_cents: d.claimed_cents,
                reason_code: d.reason_code,
                win_probability: d.win_probability,
                expected_recovery_usd: d.expected_recovery_usd,
                pod_clean: !!d.pod_clean,
              },
            }),
          });
          if (seq.current !== my) return;
          setPreview({
            ...blankPreview(),
            text: r.text || "",
            src:
              r.source === "gemini"
                ? "Written by Gemini"
                : `Grounded template - ${aiWhy(r)}`,
          });
        } else if (c === "chases") {
          const d = h.chases[i];
          if (!d) return;
          const r = await api<DraftResult>("/api/v1/ai/draft", {
            method: "POST",
            body: JSON.stringify({
              kind: "chase_email",
              facts: {
                payment_id: d.payment_id,
                payer: d.payer || "Payer",
                amount_cents: d.amount_cents,
              },
            }),
          });
          if (seq.current !== my) return;
          setPreview({
            ...blankPreview(),
            text: r.text || "",
            src:
              r.source === "gemini"
                ? "Written by Gemini"
                : `Grounded template - ${aiWhy(r)}`,
          });
        } else if (c === "dunning") {
          const d = h.dunning[i];
          if (!d) return;
          const r = await api<DraftResult>("/api/v1/mail/reminder", {
            method: "POST",
            body: JSON.stringify({ invoice_id: d.invoice_id }),
          });
          if (seq.current !== my) return;
          setPreview({
            ...blankPreview(),
            text: r.body || r.text || "",
            subject: r.subject,
            src: `${r.tone_label || ""} - subject: ${r.subject || ""}`,
          });
        } else if (c === "settlements") {
          const d = h.settlements[i];
          if (!d) return;
          const draft = (h.outbox || []).find(
            (m) =>
              m.kind === "settlement_confirmation" &&
              (m.ref_id || "").endsWith(":" + d.payment_id)
          );
          if (seq.current !== my) return;
          setPreview({
            ...blankPreview(),
            text: draft?.body || "",
            subject: draft?.subject,
            src: draft
              ? `Draft generated automatically when the cash posted - subject: ${draft.subject || ""}`
              : null,
          });
        }
      } catch (e) {
        if (seq.current !== my) return;
        setPreview({
          ...blankPreview(),
          src: "Draft failed: " + (e instanceof Error ? e.message : String(e)),
        });
      }
    },
    []
  );

  // Draft whenever the selection, category or tone changes.
  useEffect(() => {
    if (!hub || hub.state !== "ready" || cat === "outbox") return;
    if (!items.length) {
      setPreview(blankPreview());
      return;
    }
    draftInto(cat, hub, idx, tone);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hub, cat, idx, tone]);

  const send = async () => {
    if (!hub || !item) return;
    const kind =
      cat === "disputes"
        ? "dispute_claim"
        : cat === "chases"
          ? "chase"
          : cat === "settlements"
            ? "settlement_confirmation"
            : "collection_reminder";
    const ref =
      cat === "dunning"
        ? (item as { invoice_id: string }).invoice_id
        : (item as { payment_id: string }).payment_id;
    const noteKey = `${cat}:${ref}`;
    if (!preview.to.trim()) {
      setMailNote({
        key: noteKey,
        text: "Add the recipient's email first",
        kind: "warn",
      });
      return;
    }
    if (!preview.text) {
      setMailNote({
        key: noteKey,
        text: "Draft the message first",
        kind: "warn",
      });
      return;
    }
    const preset =
      cat === "settlements" || cat === "dunning" ? preview.subject : undefined;
    setPreview((p) => ({ ...p, busy: true }));
    try {
      const r = await sendMail(
        kind as Parameters<typeof sendMail>[0],
        ref,
        preview.to,
        preview.text,
        preset
      );
      setPreview((p) => ({ ...p, busy: false }));
      setMailNote({
        key: noteKey,
        text: sendStatusText(r.status),
        kind: r.status === "sent" ? "ok" : r.status === "failed" ? "bad" : "warn",
      });
      load();
    } catch (e) {
      setPreview((p) => ({ ...p, busy: false }));
      setMailNote({
        key: noteKey,
        text: e instanceof Error ? e.message : String(e),
        kind: "bad",
      });
    }
  };

  const viewSap = async () => {
    if (sapDoc) {
      setSapOpen(!sapOpen);
      return;
    }
    if (cat !== "settlements" || !item) return;
    try {
      const doc = await api<ErpPaymentDocument>(
        `/api/v1/payments/${encodeURIComponent((item as { payment_id: string }).payment_id)}/erp-document`
      );
      setSapDoc(doc);
      setSapOpen(true);
    } catch (e) {
      setPreview((p) => ({
        ...p,
        src: e instanceof Error ? e.message : String(e),
      }));
    }
  };

  const counts: Record<Cat, number> = hub
    ? {
        disputes: hub.disputes.length,
        chases: hub.chases.length,
        settlements: hub.settlements.length,
        dunning: hub.dunning.length,
        outbox: hub.outbox.length,
      }
    : { disputes: 0, chases: 0, settlements: 0, dunning: 0, outbox: 0 };

  const outboxPill = (m: OutboxMail): PillKind =>
    m.status === "sent"
      ? "ok"
      : m.status === "failed"
        ? "bad"
        : m.status === "draft"
          ? "info"
          : "warn";

  return (
    <>
      <ViewHead
        eyebrow="INSIGHT & GOVERNANCE - 08 / OUTBOUND MAIL HUB"
        title="Outbound Mail Hub"
        purpose="Every stream the run generates: claims, inquiries, confirmations and reminders, with the outbox recording each send's true status."
        onRefresh={load}
      />
      {!hub && !error && <ViewSkeleton kind="panels" />}
      {error && <LoadError error={error} />}

      {hub && (
        <>
          <Rise i={0}>
            <div className="flex items-center gap-2 flex-wrap">
              {hub.configured ? (
                <Pill kind="ok">
                  Mailbox configured - sends go out from {hub.from}
                </Pill>
              ) : (
                <Pill kind="warn">
                  No mailbox configured - sends are recorded, not sent
                </Pill>
              )}
              <span className="text-[12.5px] text-mut">
                A mail is only ever shown as sent when the mail server
                accepted it.
              </span>
            </div>
          </Rise>

          {hub.state === "empty" && (
            <Rise i={1}>
              <div className="glass-card rounded-md border border-white/[0.11] p-4">
                <b>No active ledger loaded.</b>
                <p className="text-[13px] text-mut m-0 mt-1">
                  Load a case or upload CSVs and the mail that case generates
                  appears here.
                </p>
              </div>
            </Rise>
          )}
          {hub.state === "loaded_not_run" && ws && (
            <Rise i={1}>
              <StagedGate
                where="mail streams"
                ws={ws}
                onExecute={() => {
                  setIntent("slate-run-live", "1");
                  goView("run");
                }}
              />
            </Rise>
          )}

          {(hub.state === "ready" || hub.state === "loaded_not_run" || hub.state === "empty") && (
            <Rise i={2}>
              <div className="flex gap-1.5 flex-wrap">
                {CATS.map(([k, label]) => (
                  <button
                    key={k}
                    className={`font-sans text-[12.5px] px-3 py-2 rounded-full border cursor-pointer pressable ${
                      cat === k
                        ? "border-blue text-white bg-blue"
                        : "border-line2 text-mut bg-transparent hover:text-ink"
                    }`}
                    onClick={() => { setCat(k); setMailNote(null); }}
                  >
                    {label}
                    <span className="font-mono text-[11px] ml-1.5">
                      {counts[k]}
                    </span>
                  </button>
                ))}
              </div>
            </Rise>
          )}

          {hub.state === "ready" && cat !== "outbox" && (
            <Rise i={3}>
              <div className="grid grid-cols-1 xl:grid-cols-[380px_1fr] gap-4 items-start">
                {/* item list */}
                <Panel title={CATS.find(([k]) => k === cat)?.[1]}>
                  {!items.length ? (
                    <p className="text-[13px] text-mut m-0 mt-2">
                      {EMPTY_COPY[cat]}
                    </p>
                  ) : (
                    <div className="flex flex-col gap-1.5 mt-2">
                      {items.map((d, i) => {
                        const active = i === idx;
                        const cls = `text-left w-full rounded-md border px-3 py-2.5 cursor-pointer pressable ${
                          active
                            ? "border-blue bg-[rgba(61,117,232,0.10)]"
                            : "border-white/[0.08] bg-white/[0.02] hover:border-line2"
                        }`;
                        if (cat === "disputes") {
                          const x = d as MailHub["disputes"][number];
                          return (
                            <button key={x.payment_id} className={cls} onClick={() => { setSel((s) => ({ ...s, [cat]: i })); setMailNote(null); }}>
                              <div className="text-[13px] font-medium">{x.payment_id} - {x.payer}</div>
                              <div className="text-[12px] text-mut">
                                Claim {money(x.claimed_cents)} · win probability {x.win_probability} · expected recovery ${Number(x.expected_recovery_usd || 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}
                              </div>
                            </button>
                          );
                        }
                        if (cat === "chases") {
                          const x = d as MailHub["chases"][number];
                          return (
                            <button key={x.payment_id} className={cls} onClick={() => { setSel((s) => ({ ...s, [cat]: i })); setMailNote(null); }}>
                              <div className="text-[13px] font-medium">{x.payment_id} - {x.payer || "Unknown payer"}</div>
                              <div className="text-[12px] text-mut">
                                {money(x.amount_cents)} · {x.kind}
                                {x.residual_cents ? ` · residual ${money(x.residual_cents)}` : ""}
                              </div>
                            </button>
                          );
                        }
                        if (cat === "settlements") {
                          const x = d as MailHub["settlements"][number];
                          return (
                            <button key={x.payment_id} className={cls} onClick={() => { setSel((s) => ({ ...s, [cat]: i })); setMailNote(null); }}>
                              <div className="text-[13px] font-medium">{x.payment_id} - {x.payer}</div>
                              <div className="text-[12px] text-mut">
                                {money(x.net_cents)} applied · {x.status === "AUTO_POSTED" ? "auto-posted" : "approved & posted"}
                                {x.erp_document_id ? ` · SAP ${x.erp_document_id}` : ""}
                              </div>
                            </button>
                          );
                        }
                        const x = d as MailHub["dunning"][number];
                        return (
                          <button key={x.invoice_id} className={cls} onClick={() => { setSel((s) => ({ ...s, [cat]: i })); setMailNote(null); }}>
                            <div className="text-[13px] font-medium">{x.invoice_id} - {x.customer}</div>
                            <div className="text-[12px] text-mut">
                              {money(x.gross_cents)} · {x.due_in_days < 0 ? `${Math.abs(x.due_in_days)}d overdue` : x.due_in_days === 0 ? "due today" : `in ${x.due_in_days}d`} · {x.tone_label || ""}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </Panel>

                {/* preview pane with fixed footer */}
                <section className="glass-panel rounded-md border border-white/[0.11] p-4 sm:p-5 flex flex-col max-h-[760px]">
                  {!item ? (
                    <p className="text-[13px] text-mut m-0">
                      Nothing in this stream for the latest run.
                    </p>
                  ) : (
                    <>
                      <div className="overflow-y-auto pr-1 flex-1 min-h-0">
                        {cat === "disputes" && (() => {
                          const d = item as MailHub["disputes"][number];
                          return (
                            <>
                              <div className="flex items-center justify-between gap-2 flex-wrap">
                                <b className="text-[14px]">{d.payment_id} - {d.payer}</b>
                                <Pill kind="warn">{(d.reason_code || "") + " - " + (d.classification || "deduction")}</Pill>
                              </div>
                              <p className="text-[13px] m-0 mt-2">
                                Claim <b>{money(d.claimed_cents)}</b> · win probability <b>{d.win_probability}</b> · expected recovery <b>${Number(d.expected_recovery_usd || 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}</b> · invoices {(d.invoices || []).join(", ") || "-"}
                              </p>
                              <p className="m-0 mt-2">
                                <Pill kind={d.pod_clean ? "ok" : "warn"}>
                                  {d.pod_clean ? "POD trace: clean proof of delivery on file" : "POD trace: proof of delivery not verified"}
                                </Pill>{" "}
                                <span className="text-[12px] text-mut">
                                  Source: payment {d.payment_id} and its deduction record in the latest run.
                                </span>
                              </p>
                              <div className="flex gap-1.5 flex-wrap mt-3">
                                {TONES.map(([t, l]) => (
                                  <button
                                    key={t}
                                    className={`font-sans text-[12px] px-2.5 py-1 rounded-full border cursor-pointer pressable ${tone === t ? "border-blue text-white bg-blue" : "border-line2 text-mut bg-transparent hover:text-ink"}`}
                                    onClick={() => { setTone(t); setMailNote(null); }}
                                  >
                                    {l}
                                  </button>
                                ))}
                              </div>
                            </>
                          );
                        })()}
                        {cat === "chases" && (() => {
                          const d = item as MailHub["chases"][number];
                          return (
                            <>
                              <div className="flex items-center justify-between gap-2 flex-wrap">
                                <b className="text-[14px]">{d.payment_id} - {d.payer || "Unknown payer"}</b>
                                <Pill kind="warn">{d.kind}</Pill>
                              </div>
                              <p className="text-[13px] m-0 mt-2">
                                <b>{money(d.amount_cents)}</b>
                                {d.residual_cents ? ` · unexplained residual ${money(d.residual_cents)}` : ""} · {d.recommended_action || ""}
                              </p>
                            </>
                          );
                        })()}
                        {cat === "settlements" && (() => {
                          const d = item as MailHub["settlements"][number];
                          return (
                            <>
                              <div className="flex items-center justify-between gap-2 flex-wrap">
                                <b className="text-[14px]">{d.payment_id} - {d.payer}</b>
                                <Pill kind="ok">{d.status === "AUTO_POSTED" ? "Auto-posted" : "Approved & posted"}</Pill>
                              </div>
                              <p className="text-[13px] m-0 mt-2">
                                {money(d.net_cents)} applied · invoices {d.invoices.map((l) => l.invoice_id).join(", ")}
                                {d.discount_cents ? ` · discount ${money(d.discount_cents)} applied` : ""}
                                {d.erp_document_id ? <> · SAP clearing document <b>{d.erp_document_id}</b></> : " · SAP document is the posting preview below"}
                              </p>
                              {!preview.text && !preview.drafting && (
                                <p className="text-[13px] text-mut m-0 mt-2">
                                  No generated draft found for this payment - the SAP payload below is its posting record.
                                </p>
                              )}
                              <div className="mt-3">
                                <GhostBtn onClick={viewSap}>View SAP posting document</GhostBtn>
                              </div>
                              {sapOpen && sapDoc && (
                                <div className="mt-3">
                                  <ErpServerDoc d={sapDoc} />
                                </div>
                              )}
                            </>
                          );
                        })()}
                        {cat === "dunning" && (() => {
                          const d = item as MailHub["dunning"][number];
                          return (
                            <>
                              <div className="flex items-center justify-between gap-2 flex-wrap">
                                <b className="text-[14px]">{d.invoice_id} - {d.customer}</b>
                                <Pill kind={d.tone === "escalation" ? "bad" : d.tone === "firm" ? "warn" : "info"}>{d.tone_label || ""}</Pill>
                              </div>
                              <p className="text-[13px] m-0 mt-2">
                                {money(d.gross_cents)} · {d.due_in_days < 0 ? `${Math.abs(d.due_in_days)} days overdue` : d.due_in_days === 0 ? "due today" : `due in ${d.due_in_days} days`} · still open after the latest run, so it stays on the dunning list until a run or an approval settles it.
                              </p>
                            </>
                          );
                        })()}

                        <div className="mt-3">
                          {preview.drafting ? (
                            <p className="font-mono text-[12px] text-mut m-0 py-2">
                              DRAFTING FROM THE RECORD...
                            </p>
                          ) : (
                            <>
                              <input
                                className="w-full box-border font-sans text-[13px] px-3 py-2 rounded-[3px] border border-line2 glass-input text-ink"
                                placeholder="ap@customer.com"
                                value={preview.to}
                                onChange={(e) => setPreview((p) => ({ ...p, to: e.target.value }))}
                              />
                              <textarea
                                className="w-full box-border font-sans text-[13px] leading-relaxed px-3 py-2 rounded-[3px] border border-line2 glass-input text-ink mt-2"
                                rows={10}
                                value={preview.text}
                                onChange={(e) => setPreview((p) => ({ ...p, text: e.target.value }))}
                              />
                              {preview.src && (
                                <p className="m-0 mt-1.5">
                                  <Pill kind="info">{preview.src}</Pill>
                                </p>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2.5 flex-wrap border-t border-white/[0.08] pt-3 mt-3 shrink-0">
                        <button
                          className="font-sans text-[13px] font-medium px-3.5 py-2 rounded-[3px] border border-blue text-white bg-blue hover:bg-[#2f66d6] cursor-pointer disabled:opacity-50 pressable"
                          disabled={preview.busy || preview.drafting}
                          onClick={send}
                        >
                          {cat === "disputes"
                            ? "Send claim"
                            : cat === "chases"
                              ? "Send inquiry"
                              : cat === "settlements"
                                ? "Send confirmation"
                                : "Send reminder"}
                        </button>
                        {mailNote &&
                          item &&
                          mailNote.key ===
                            `${cat}:${cat === "dunning" ? (item as { invoice_id: string }).invoice_id : (item as { payment_id: string }).payment_id}` && (
                            <Pill kind={mailNote.kind}>{mailNote.text}</Pill>
                          )}
                        <span className="text-[12px] text-mut">
                          {hub.configured
                            ? `Sends go out from ${hub.from}`
                            : "No mailbox configured - this send will be recorded, not sent"}
                        </span>
                      </div>
                    </>
                  )}
                </section>
              </div>
            </Rise>
          )}

          {hub.state === "ready" && cat === "outbox" && (
            <Rise i={3}>
              <Panel title="Outbox - generated, recorded and sent">
                <RefreshFade signature={hub.outbox.map((m) => m.created_at + m.subject).join("|")}>
                  {!hub.outbox.length ? (
                    <p className="text-[13px] text-mut m-0 mt-2">
                      Nothing generated or sent yet.
                    </p>
                  ) : (
                    <div className="flex flex-col mt-2">
                      {hub.outbox.map((m, i) => (
                        <motion.div
                          key={i}
                          initial={reduce ? false : { opacity: 0, x: -10 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{
                            duration: 0.25,
                            delay: Math.min(i * 0.03, 0.3),
                            ease: EASE_OUT,
                          }}
                          className="flex items-baseline gap-3 flex-wrap py-2 border-t border-white/[0.05] first:border-0"
                        >
                          <span className="font-mono text-[11.5px] text-mut whitespace-nowrap">
                            {(m.created_at || "").slice(5, 16).replace("T", " ")}
                          </span>
                          <Pill kind="info">{m.kind}</Pill>
                          <span className="text-[13px] font-medium break-all">
                            {m.to || "(no recipient - generated draft)"}
                          </span>
                          <span className="text-[13px] text-mut flex-1 min-w-[200px]">
                            {m.subject}
                          </span>
                          <Pill kind={outboxPill(m)}>
                            {outboxStatusText(m.status)}
                          </Pill>
                        </motion.div>
                      ))}
                    </div>
                  )}
                </RefreshFade>
              </Panel>
            </Rise>
          )}

          {(hub.state === "loaded_not_run" || hub.state === "empty") && (
            <Rise i={3}>
              <Panel title="Streams">
                <p className="text-[13px] text-mut m-0 mt-1">
                  {hub.state === "empty"
                    ? "Nothing yet."
                    : "The four streams fill from the run: claims from deductions, inquiries from exceptions, confirmations from settlements, reminders from what is still open."}
                </p>
              </Panel>
            </Rise>
          )}
        </>
      )}
    </>
  );
}
