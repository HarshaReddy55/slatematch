import { useCallback, useEffect, useState } from "react";
import { api, money } from "../lib/api";
import { useWsRefresh } from "../lib/chrome";
import {
  goView,
  setIntent,
  type ErpRunDocuments,
  type WorkspaceOperate,
} from "../lib/operate";
import Panel from "../ui/Panel";
import StatCard from "../ui/StatCard";
import Pill from "../ui/Pill";
import ViewHead, { LoadError } from "../ui/ViewHead";
import ViewSkeleton from "../ui/Skeleton";
import { Rise } from "../ui/motion";
import { GhostBtn, GlTable, JsonBox, StagedGate } from "../ui/Stage3";
import DataTable, { Row, Td, Th } from "../ui/DataTable";

interface Transmission {
  transmission_id: string;
  payment_id: string;
  document_number: string;
  mode: string;
  status: string;
  sap_document_number: string | null;
  detail: string;
  created_at: string;
}

/* Stage 3: SAP BAPI & EBRR (05). One source, GET
   /api/v1/erp/run-documents, exactly as vanilla loadSap(). Document
   chips select the posting; the GL table groups the journal by
   account (erpGlTable); the ASC 606 reserve journals sit below; the
   BAPI payload opens in the evidence slide-over, kept raw
   (Obsidian Analytics pattern). */

export default function Sap() {
  const [docs, setDocs] = useState<ErpRunDocuments | null>(null);
  const [ws, setWs] = useState<WorkspaceOperate | null>(null);
  const [error, setError] = useState("");
  const [sel, setSel] = useState(0);
  const [copied, setCopied] = useState(false);
  const [settings, setSettings] = useState<{ sap_mode: string; sap_endpoint: string } | null>(null);
  const [transmissions, setTransmissions] = useState<Transmission[]>([]);
  const [txBusy, setTxBusy] = useState(false);
  const [txNote, setTxNote] = useState("");

  const load = useCallback(() => {
    setError("");
    Promise.all([
      api<ErpRunDocuments>("/api/v1/erp/run-documents"),
      api<WorkspaceOperate>("/api/v1/workspace"),
      api<{ sap_mode: string; sap_endpoint: string }>("/api/v1/integrations/settings").catch(() => null),
      api<{ transmissions: Transmission[] }>("/api/v1/erp/transmissions").catch(() => ({ transmissions: [] })),
    ])
      .then(([d, w, s, t]) => {
        setDocs(d);
        setWs(w);
        if (s) setSettings(s);
        setTransmissions(t.transmissions || []);
        setSel((s2) => (s2 >= (d.documents || []).length ? 0 : s2));
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const transmit = async (paymentId: string) => {
    setTxBusy(true);
    setTxNote("");
    try {
      const d = await api<{ status: string; sap_document_number: string | null; detail: string }>(
        "/api/v1/erp/transmit", { method: "POST", body: JSON.stringify({ payment_id: paymentId }) }
      );
      setTxNote(`${paymentId}: ${d.status}${d.sap_document_number ? ` - ${d.sap_document_number}` : ""} (${d.detail})`);
      const t = await api<{ transmissions: Transmission[] }>("/api/v1/erp/transmissions");
      setTransmissions(t.transmissions || []);
    } catch (e) {
      setTxNote(e instanceof Error ? e.message : String(e));
    } finally {
      setTxBusy(false);
    }
  };
  useEffect(load, [load]);
  /* Stage 6 (Item 1): reload when the workspace is replaced. */
  useWsRefresh(load, () => {
    setDocs(null);
    setWs(null);
  });

  const ready = docs && docs.run_id && docs.documents.length > 0;
  const staged = !ready && ws?.run_status === "staged";
  const cur = ready ? docs.documents[sel] : null;

  const copyPayload = () => {
    if (!cur) return;
    navigator.clipboard
      ?.writeText(JSON.stringify(cur.document.bapi_payload, null, 2))
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  return (
    <>
      <ViewHead
        eyebrow="OPERATE - 05 / SAP BAPI & EBRR"
        title="SAP BAPI & EBRR"
        purpose="The posting documents the ERP would receive for the latest run: balanced DZ journals per cleared payment, and the ASC 606 dispute reserve."
        onRefresh={load}
      />
      {!docs && !error && <ViewSkeleton kind="table" />}
      {error && <LoadError error={error} />}

      {docs && staged && ws && (
        <Rise i={0}>
          <StagedGate
            where="SAP clearing documents"
            ws={ws}
            onExecute={() => {
              setIntent("slate-run-live", "1");
              goView("run");
            }}
          />
        </Rise>
      )}

      {docs && !ready && !staged && (
        <Rise i={0}>
          <div className="glass-card rounded-none border border-line p-4">
            <b>No posting documents yet.</b>
            <p className="text-[13px] text-mut m-0 mt-1">
              The latest run has no cleared payments. Load a case, run it,
              and every cleared payment's DZ document is generated here.
            </p>
          </div>
        </Rise>
      )}

      {docs && (
        <>
          <Rise i={staged ? 1 : 0}>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
              <StatCard
                label="Documents generated"
                value={ready ? docs.totals.documents : 0}
                format={(v) => String(Math.round(v))}
                note="One DZ clearing document per cleared payment in the latest run"
              />
              <StatCard
                label="Balanced journal total"
                value={ready ? docs.totals.debit_cents : 0}
                format={(v) => money(Math.round(v))}
                note="Total debits across those documents - credits equal debits to the cent"
              />
              <div className="glass-card rounded-none border border-line p-4 flex flex-col gap-1 min-w-0">
                <span className="font-mono text-[10.5px] tracking-[0.07em] uppercase text-mut">
                  SAP S/4HANA BAPI &amp; EBRR
                </span>
                <div className="font-display text-[22px] leading-tight font-semibold text-ink mt-1">
                  DZ clearing
                </div>
                <p className="text-[12px] text-mut leading-snug m-0 mt-1">
                  Balanced DZ clearing + ASC 606 dispute reserve ready -
                  document type of every posting here
                </p>
              </div>
              <StatCard
                label="ASC 606 dispute reserve"
                value={docs.reserve ? docs.reserve.claimed_cents : 0}
                format={(v) => money(Math.round(v))}
                note="Claims reclassified as disputed receivables until the dispute closes"
                sparkColor="#f2c14e"
              />
            </div>
          </Rise>

          {ready && cur && (
            <>
              <Rise i={1}>
                <Panel title="Posting documents">
                  <div className="flex gap-2 flex-wrap mt-3">
                    {docs.documents.map((x, i) => (
                      <button
                        key={x.payment_id}
                        className={`font-sans text-[12.5px] px-3 py-1.5 rounded-none border cursor-pointer pressable ${
                          i === sel
                            ? "border-blue text-ink bg-[#2e3d5e]"
                            : "border-line text-mut bg-panel2 hover:text-ink"
                        }`}
                        onClick={() => setSel(i)}
                      >
                        {x.payment_id}
                        {x.document.document_number
                          ? ` · ${x.document.document_number}`
                          : ""}{" "}
                        - {x.payer || ""}
                      </button>
                    ))}
                  </div>
                </Panel>
              </Rise>

              <Rise i={2}>
                <Panel title="Debit vs credit - the GL posting table">
                  <p className="text-[13px] m-0 mt-2">
                    <b>{cur.payment_id}</b> - {cur.payer || ""} - status{" "}
                    {cur.status} - document{" "}
                    {cur.document.document_number ||
                      "preview (a number is issued when a match is approved)"}{" "}
                    -{" "}
                    {cur.document.balanced ? (
                      <Pill kind="ok">Balanced</Pill>
                    ) : (
                      <Pill kind="bad">Out of balance</Pill>
                    )}
                  </p>
                  <GlTable journal={cur.document.journal} />
                  {cur.document.note && (
                    <p className="text-[12px] text-mut m-0 mt-2">
                      {cur.document.note}
                    </p>
                  )}
                </Panel>
              </Rise>

              <Rise i={3}>
                {/* Vanilla shows the payload as an inline panel
                    (index.html:153), not behind a button: title,
                    the ERP sentence, Copy payload, the jsonbox. */}
                <Panel
                  title="BAPI_ACC_DOCUMENT_POST payload"
                  sub="The exact JSON the ERP would receive for the selected payment."
                >
                  <div className="mt-3 mb-3">
                    <GhostBtn onClick={copyPayload}>
                      {copied ? "Copied" : "Copy payload"}
                    </GhostBtn>
                  </div>
                  <JsonBox
                    text={JSON.stringify(cur.document.bapi_payload, null, 2)}
                  />
                </Panel>
              </Rise>

              <Rise i={3}>
                <Panel
                  title="Write-back - transmit to SAP"
                  sub="Simulated mode validates the payload exactly as a receiving system would (header, lines, amounts netting to zero) and assigns a SAPSIM document number - the record says SIMULATED in plain words; no real SAP system is claimed. HTTP mode posts the payload to the configured endpoint and records the real answer."
                >
                  <div className="flex items-center gap-3 flex-wrap mt-2">
                    {settings?.sap_mode === "http" ? (
                      <Pill kind="info">HTTP - {settings.sap_endpoint}</Pill>
                    ) : (
                      <Pill kind="warn">SIMULATED CONNECTION</Pill>
                    )}
                    <GhostBtn onClick={() => transmit(cur.payment_id)} disabled={txBusy}>
                      {txBusy ? "Transmitting..." : `Transmit ${cur.payment_id} to SAP`}
                    </GhostBtn>
                    {txNote && <span className="text-[12.5px] text-mut">{txNote}</span>}
                  </div>
                  {transmissions.length > 0 && (
                    <DataTable
                      head={
                        <>
                          <Th>Payment</Th>
                          <Th>Document</Th>
                          <Th>Mode</Th>
                          <Th>Status</Th>
                          <Th>SAP document</Th>
                        </>
                      }
                    >
                      {transmissions.map((t) => (
                        <Row key={t.transmission_id}>
                          <Td className="font-mono text-[12px]">{t.payment_id}</Td>
                          <Td className="font-mono text-[12px]">{t.document_number}</Td>
                          <Td>{t.mode}</Td>
                          <Td>
                            <Pill kind={t.status === "FAILED" ? "bad" : t.status === "SENT" ? "ok" : "warn"}>
                              {t.status}
                            </Pill>
                          </Td>
                          <Td className="font-mono text-[12px]">{t.sap_document_number || "-"}</Td>
                        </Row>
                      ))}
                    </DataTable>
                  )}
                </Panel>
              </Rise>
            </>
          )}

          <Rise i={4}>
            <Panel title="ASC 606 / IFRS 15 EBRR - dispute reserve journal">
              {docs.reserve && docs.reserve.journals.length ? (
                <div className="flex flex-col gap-4 mt-2">
                  {docs.reserve.journals.map((j) => (
                    <div key={j.payment_id}>
                      <p className="text-[13px] m-0">
                        <b>{j.payment_id}</b> - claim of{" "}
                        {money(j.claimed_cents)} reclassified under ASC 606 /
                        IFRS 15:
                      </p>
                      <GlTable journal={j.journal.journal} />
                      {j.journal.note && (
                        <p className="text-[12px] text-mut m-0 mt-1.5">
                          {j.journal.note}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[13px] text-mut m-0 mt-2">
                  No dispute claims in the latest run.
                </p>
              )}
            </Panel>
          </Rise>
        </>
      )}

    </>
  );
}
