import { useState } from "react";
import { api, money } from "../lib/api";
import type {
  ErpPaymentDocument,
  PaymentFull,
  StoredMatch,
  MatchLineFull,
} from "../lib/operate";
import DataTable, { Row, Td, Th } from "../ui/DataTable";
import Pill from "../ui/Pill";
import { GhostBtn, JsonBox } from "../ui/Stage3";

/* The match evidence, the React form of vanilla storedDetail() +
   detailExtras() + the ERP drawer (operate.js). One component for
   both stored matches and fresh batch results (Run adapts batch
   items into the stored shape), opened inside the evidence
   slide-over from the Run matches table and the Approvals queue.
   Every number is the match record's own. */

interface WhyOut {
  title: string;
  body: string;
  small?: string;
}

export default function MatchDetail({
  match,
  payment,
}: {
  match: StoredMatch;
  payment: PaymentFull | null;
}) {
  const res = match.result || {};
  const lines = (res.lines || []) as MatchLineFull[];
  const ded = res.deduction;
  const [why, setWhy] = useState<WhyOut | null>(null);
  const [whyBusy, setWhyBusy] = useState(false);
  const [whyInv, setWhyInv] = useState("");
  const [erpOpen, setErpOpen] = useState(false);
  const [erpDoc, setErpDoc] = useState<ErpPaymentDocument | null>(null);
  const [erpFailed, setErpFailed] = useState(false);

  const rej = (res.reasoning?.rejections || []).filter((x) => x.invoice_id);

  const runWhyNot = async (invId: string) => {
    if (!payment) return;
    setWhyBusy(true);
    try {
      const o = await api<{
        reason?: string;
        explanation?: string;
        solo_residual_cents?: number;
        invoice_gross_cents?: number;
      }>("/api/v1/why-not", {
        method: "POST",
        body: JSON.stringify({ payment, invoice_id: invId }),
      });
      if (o.reason === "already_matched") {
        setWhy({
          title: invId,
          body: "is part of the set the solver chose.",
        });
      } else if (o.reason === "not_in_candidate_set") {
        setWhy({
          title: invId,
          body: `never entered this payment's candidate shortlist - the Linking Agent's rungs excluded it before the solver ran, so there was nothing to force.`,
          small: o.explanation || "",
        });
      } else {
        const solo = o.solo_residual_cents || 0;
        const pen = Math.abs(solo) * 1000000;
        setWhy({
          title: `Why not ${invId}?`,
          body: `Forcing ${invId} (${money(o.invoice_gross_cents || 0)}) into this payment leaves ${money(solo)} of the wire unexplained. The solver charges 1,000,000 objective units per cent of unexplained cash, so that single choice adds ${pen.toExponential(2)} objective units - against a chosen set that leaves ${money(match.residual_cents)} unexplained. No rearrangement containing ${invId} reaches the chosen set's cost, which is why the optimiser excludes it.`,
          small: o.explanation || "",
        });
      }
    } catch (e) {
      setWhy({ title: "", body: e instanceof Error ? e.message : String(e) });
    } finally {
      setWhyBusy(false);
    }
  };

  const toggleErp = async () => {
    const next = !erpOpen;
    setErpOpen(next);
    if (!next || erpDoc || erpFailed) return;
    try {
      const d = await api<ErpPaymentDocument>(
        `/api/v1/payments/${encodeURIComponent(match.payment_id)}/erp-document`
      );
      setErpDoc(d);
    } catch {
      setErpFailed(true);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] leading-relaxed m-0">
        Decision <b>{match.status}</b> by solver <b>{match.solver || "-"}</b>,
        found via <b>{res.matched_by || "-"}</b>, residual{" "}
        <b>{money(match.residual_cents)}</b>, confidence{" "}
        <b>{Number(match.confidence ?? 0).toFixed(3)}</b>, solver time{" "}
        {res.latency_ms ?? "-"} ms.
        {res.deduction_applied
          ? " A claimed deduction was applied and judged by deduction intelligence."
          : ""}
      </p>

      {ded && (
        <div className="glass-card rounded-md border border-white/[0.11] p-3.5">
          <p className="text-[13px] leading-relaxed m-0">
            <b>Deduction intelligence:</b> classified{" "}
            <b>{ded.classification?.label || ""}</b> (
            {ded.assigned_erp_reason_code || ""}), z-score {ded.z_score}, win
            probability {ded.win_probability ?? "n/a"}, expected recovery $
            {ded.expected_recovery_value_usd} - decision:{" "}
            <b>{ded.autonomous_action}</b>.
          </p>
          {ded.win_probability_basis && (
            <p className="text-[12px] text-mut m-0 mt-1">
              {ded.win_probability_basis}
            </p>
          )}
          {(ded.derivation || []).length > 0 && (
            <p className="text-[13px] leading-relaxed m-0 mt-2">
              <b>Step by step:</b>
              <br />
              {(ded.derivation || []).map((x, i) => (
                <span key={i}>
                  • {x}
                  <br />
                </span>
              ))}
            </p>
          )}
        </div>
      )}

      {res.reasoning && (res.reasoning.steps || []).length > 0 && (
        <div className="glass-card rounded-md border border-white/[0.11] p-3.5">
          <h4 className="font-display text-[14px] font-semibold m-0">
            How this decision was made
          </h4>
          <p className="text-[12px] text-mut m-0 mt-0.5">
            Step by step - every number below comes from this run itself.
          </p>
          {(res.reasoning.steps || []).map((s, i) => (
            <div
              key={i}
              className="flex gap-2.5 py-2 border-b border-white/[0.05] last:border-0"
            >
              <span className="flex-none w-[22px] h-[22px] rounded-full bg-blue text-white font-display font-bold text-[12px] flex items-center justify-center">
                {i + 1}
              </span>
              <span className="text-[13px] leading-relaxed">{s}</span>
            </div>
          ))}
          {(res.reasoning.rejections || []).length > 0 && (
            <div className="mt-3">
              <b className="text-[13px]">Why the other invoices were not picked</b>
              {(res.reasoning.rejections || []).map((j, i) => (
                <div
                  key={i}
                  className="text-[13px] leading-relaxed py-1.5 pl-8 border-b border-white/[0.05] last:border-0"
                >
                  {j.text}
                </div>
              ))}
            </div>
          )}
          {(res.reasoning.close_calls || []).length > 0 && (
            <div className="mt-3">
              <b className="text-[13px]">
                Close calls - combinations that nearly worked
              </b>
              {(res.reasoning.close_calls || []).map((c, i) => (
                <div
                  key={i}
                  className="text-[13px] leading-relaxed py-1.5 pl-8 border-b border-white/[0.05] last:border-0"
                >
                  {c.text}
                </div>
              ))}
              <p className="text-[12px] text-mut m-0 mt-1">
                Near misses are shown so the one exact set can be judged
                against how close everything else came.
              </p>
            </div>
          )}
        </div>
      )}

      {res.derivation && <Derivation d={res.derivation} />}

      {lines.length ? (
        <DataTable
          head={
            <>
              <Th>Invoice</Th>
              <Th>Gross</Th>
              <Th>Discount</Th>
              <Th>Net applied</Th>
            </>
          }
        >
          {lines.map((l) => (
            <Row key={l.invoice_id}>
              <Td>{l.invoice_id}</Td>
              <Td>{money(l.gross_cents)}</Td>
              <Td>{money(l.discount_cents)}</Td>
              <Td>{money(l.net_cents)}</Td>
            </Row>
          ))}
        </DataTable>
      ) : (
        <p className="text-[13px] text-mut m-0">
          No invoice lines - nothing was safe to propose.
        </p>
      )}

      {payment && rej.length > 0 && (
        <div className="glass-card rounded-md border border-white/[0.11] p-3.5">
          <p className="text-[13px] leading-relaxed m-0">
            <b>Counterfactual - why these invoices were not picked.</b> Each
            button re-runs the solver with that invoice forced into the set
            and reports the exact cost of forcing it.
          </p>
          <div className="flex gap-2 flex-wrap mt-2">
            {rej.map((x) => (
              <GhostBtn
                key={x.invoice_id}
                disabled={whyBusy}
                onClick={() => runWhyNot(x.invoice_id!)}
              >
                Why not {x.invoice_id} ({money(x.amount_cents || 0)})?
              </GhostBtn>
            ))}
          </div>
          {why && <WhyResult why={why} />}
        </div>
      )}
      {payment && rej.length === 0 && (
        <div className="glass-card rounded-md border border-white/[0.11] p-3.5">
          <p className="text-[13px] m-0 mb-2">
            Why was another invoice not picked? (counterfactual)
          </p>
          <div className="flex gap-2 items-center flex-wrap">
            <input
              className="font-sans text-[13px] px-3 py-1.5 rounded-[3px] border border-line2 glass-input text-ink box-border"
              placeholder="Invoice ID - e.g. INV-1003"
              value={whyInv}
              onChange={(e) => setWhyInv(e.target.value)}
            />
            <GhostBtn
              disabled={whyBusy || !whyInv.trim()}
              onClick={() => runWhyNot(whyInv.trim())}
            >
              Test it
            </GhostBtn>
          </div>
          {why && <WhyResult why={why} />}
        </div>
      )}

      {lines.length > 0 && (
        <div>
          <GhostBtn onClick={toggleErp}>
            ERP posting document (SAP S/4HANA style, built by erp_sap.py)
          </GhostBtn>
          {erpOpen && (
            <div className="mt-2">
              {!erpDoc && !erpFailed && (
                <p className="text-[12px] text-mut m-0">
                  Loading the posting document from the server...
                </p>
              )}
              {erpDoc && <ErpServerDoc d={erpDoc} />}
              {erpFailed && <ErpClientDoc match={match} />}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function WhyResult({ why }: { why: WhyOut }) {
  return (
    <div className="mt-3 text-[13px] leading-relaxed">
      {why.title && <b>{why.title} </b>}
      {why.body}
      {why.small && (
        <>
          <br />
          <span className="text-[12px] text-mut">{why.small}</span>
        </>
      )}
    </div>
  );
}

function Derivation({ d }: { d: NonNullable<StoredMatch["result"]>["derivation"] }) {
  if (!d) return null;
  const eq = d.equation || {};
  const cd = d.confidence_derivation || {};
  const g = d.greedy_comparison || {};
  return (
    <div className="glass-card rounded-md border border-white/[0.11] p-3.5 text-[13px] leading-relaxed">
      <b>Derivation - how this decision was computed</b>
      <br />
      Cash conservation: net applied {money(eq.net_applied_cents || 0)} -
      deduction accepted {money(eq.deduction_applied_cents || 0)} + residual{" "}
      {money(eq.residual_cents || 0)} = <b>{money(eq.payment_cents || 0)}</b>{" "}
      received{" "}
      {eq.balances ? (
        <Pill kind="ok">equation balances</Pill>
      ) : (
        <Pill kind="bad">does not balance</Pill>
      )}
      <br />
      Invoices the solver was allowed to consider:{" "}
      {d.candidates_considered ?? "-"} - solver score (objective total):{" "}
      <b>{d.objective_total ?? "-"}</b> (lower wins)
      {(d.objective_terms || []).length > 0 && (
        <DataTable
          head={
            <>
              <Th>Objective term</Th>
              <Th>Formula</Th>
              <Th>Value</Th>
            </>
          }
        >
          {(d.objective_terms || []).map((t) => (
            <Row key={t.term}>
              <Td>{t.term}</Td>
              <Td>
                <span className="text-[12px] text-mut">{t.formula}</span>
              </Td>
              <Td>{t.value}</Td>
            </Row>
          ))}
        </DataTable>
      )}
      Confidence: base {cd.base ?? "-"}{" "}
      <span className="text-[12px] text-mut">({cd.base_rule || ""})</span>
      <br />
      Simple baseline on the same shortlist:{" "}
      {(g.invoices || []).join(", ") || "nothing"} - residual{" "}
      {money(g.residual_cents || 0)} ({g.status || ""}).{" "}
      <span className="text-[12px] text-mut">{g.reading || ""}</span>
    </div>
  );
}

/** erpServerHtml(): the server-built posting document. */
export function ErpServerDoc({ d }: { d: ErpPaymentDocument }) {
  const doc = d.document;
  const [showPayload, setShowPayload] = useState(false);
  return (
    <div className="glass-card rounded-md border border-white/[0.11] p-3.5">
      <p className="text-[13px] leading-relaxed m-0">
        <b>
          {doc.document_number
            ? `ERP document ${doc.document_number} - staged for SAP posting; nothing has been posted to an ERP.`
            : "Posting preview - not a posting."}
        </b>{" "}
        Document type DZ (customer payment), generated on the server by{" "}
        <span className="font-mono">erp_sap.py</span> from this match's own
        derivation, so every amount is this payment's real money.
      </p>
      <DataTable
        head={
          <>
            <Th>GL</Th>
            <Th>Account</Th>
            <Th>Debit</Th>
            <Th>Credit</Th>
          </>
        }
      >
        {doc.journal.map((l, i) => (
          <Row key={i}>
            <Td>{l.gl_account}</Td>
            <Td>{l.account}</Td>
            <Td>{l.debit_cents ? money(l.debit_cents) : ""}</Td>
            <Td>{l.credit_cents ? money(l.credit_cents) : ""}</Td>
          </Row>
        ))}
        <Row>
          <Td>{null}</Td>
          <Td>
            <b>Totals</b>
          </Td>
          <Td>
            <b>{money(doc.total_debits_cents)}</b>
          </Td>
          <Td>
            <b>{money(doc.total_credits_cents)}</b>
          </Td>
        </Row>
      </DataTable>
      <div className="mt-2">
        {doc.balanced ? (
          <Pill kind="ok">debits equal credits</Pill>
        ) : (
          <Pill kind="bad">does not balance</Pill>
        )}
      </div>
      {doc.note && (
        <p className="text-[12px] text-mut m-0 mt-2">{doc.note}</p>
      )}
      {d.revrec_accrual && (
        <div className="mt-3">
          <p className="text-[13px] m-0">
            <b>Revenue recognition (ASC 606 / IFRS 15, event-based):</b>{" "}
            {d.revrec_accrual.note}
          </p>
          <DataTable
            head={
              <>
                <Th>GL</Th>
                <Th>Account</Th>
                <Th>Debit</Th>
                <Th>Credit</Th>
              </>
            }
          >
            {d.revrec_accrual.journal.map((l, i) => (
              <Row key={i}>
                <Td>{l.gl_account}</Td>
                <Td>{l.account}</Td>
                <Td>{l.debit_cents ? money(l.debit_cents) : ""}</Td>
                <Td>{l.credit_cents ? money(l.credit_cents) : ""}</Td>
              </Row>
            ))}
          </DataTable>
        </div>
      )}
      <div className="mt-3">
        <GhostBtn onClick={() => setShowPayload(!showPayload)}>
          BAPI_ACC_DOCUMENT_POST payload
        </GhostBtn>
        {showPayload && (
          <div className="mt-2">
            <JsonBox text={JSON.stringify(doc.bapi_payload, null, 2)} />
          </div>
        )}
      </div>
    </div>
  );
}

/** erpClientHtml(): the browser-built fallback for matches the server
    does not store (clean-room use-case runs). */
function ErpClientDoc({ match }: { match: StoredMatch }) {
  const res = match.result || {};
  const lines = (res.lines || []) as MatchLineFull[];
  const gross = lines.reduce((a, l) => a + l.gross_cents, 0);
  const disc = lines.reduce((a, l) => a + (l.discount_cents || 0), 0);
  const net = lines.reduce((a, l) => a + l.net_cents, 0);
  const eq = (res.derivation || {}).equation || {};
  const payAmt = eq.payment_cents != null ? eq.payment_cents : net;
  const dedA = eq.deduction_applied_cents || 0;
  const resid = match.residual_cents || 0;
  const rows: [string, string, number, number][] = [
    ["113100", "Cash - operating account", payAmt, 0],
  ];
  if (disc) rows.push(["415000", "Sales discounts allowed", disc, 0]);
  if (dedA) rows.push(["529000", "Deductions accepted (within policy)", dedA, 0]);
  if (resid < 0)
    rows.push(["121600", "Residual receivable - part-paid invoices", -resid, 0]);
  rows.push(["121000", "Trade receivables - customer control", 0, gross]);
  if (resid > 0)
    rows.push(["121900", "Unapplied cash - customer on-account", 0, resid]);
  const dr = rows.reduce((a, x) => a + x[2], 0);
  const cr = rows.reduce((a, x) => a + x[3], 0);
  const ded = res.deduction;
  const dispute = ded && ded.autonomous_action === "AUTO_GENERATE_DISPUTE_CLAIM";
  const ap = res.approval || {};
  return (
    <div className="glass-card rounded-md border border-white/[0.11] p-3.5">
      <p className="text-[13px] leading-relaxed m-0">
        <b>Posting preview - not a posting.</b> (Built in the browser for
        this view, because this match was produced by a clean-room use-case
        run and is not stored on the server.) Document type DZ (customer
        payment), generated from this match's own derivation, so every
        amount below is this payment's real money.
        {ap.erp_document_id && (
          <>
            {" "}
            <b>Document {ap.erp_document_id}</b> - issued when this match was
            approved, derived from the approval's audit fingerprint, so the
            decision and this document can be tied together.
          </>
        )}{" "}
        The chart of accounts is an illustrative template in SAP style; no
        ERP is connected and nothing has been posted anywhere.
      </p>
      <DataTable
        head={
          <>
            <Th>GL</Th>
            <Th>Account</Th>
            <Th>Debit</Th>
            <Th>Credit</Th>
          </>
        }
      >
        {rows.map((x, i) => (
          <Row key={i}>
            <Td>{x[0]}</Td>
            <Td>{x[1]}</Td>
            <Td>{x[2] ? money(x[2]) : ""}</Td>
            <Td>{x[3] ? money(x[3]) : ""}</Td>
          </Row>
        ))}
        <Row>
          <Td>{null}</Td>
          <Td>
            <b>Totals</b>
          </Td>
          <Td>
            <b>{money(dr)}</b>
          </Td>
          <Td>
            <b>{money(cr)}</b>
          </Td>
        </Row>
      </DataTable>
      <div className="mt-2">
        {dr === cr ? (
          <Pill kind="ok">debits equal credits</Pill>
        ) : (
          <Pill kind="bad">does not balance</Pill>
        )}
      </div>
      {dispute && (
        <p className="text-[13px] leading-relaxed m-0 mt-2.5">
          <b>Revenue recognition note (ASC 606 / IFRS 15, event-based):</b>{" "}
          this match carries a disputed deduction of{" "}
          <b>{money(ded.claimed_cents || 0)}</b> (
          {ded.assigned_erp_reason_code || ""}). The claim is carried as a
          disputed receivable (GL 121500) in the dispute ledger rather than
          netted against revenue, so the transaction price is not
          understated by a deduction whose validity is still being
          contested. The variable consideration resolves when the dispute
          closes - it is not guessed at month-end.
        </p>
      )}
    </div>
  );
}
