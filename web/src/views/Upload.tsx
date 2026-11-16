import { useCallback, useEffect, useRef, useState } from "react";
import { api, authHeaders, money } from "../lib/api";
import {
  PARSE_SAMPLE,
  SAMPLE_INV,
  SAMPLE_PAY,
  TPL_INV,
  TPL_PAY,
  goView,
  setIntent,
  type ImportResult,
  type ParseResult,
  type WorkspaceOperate,
} from "../lib/operate";
import type { Invoice } from "../lib/insight";
import Panel from "../ui/Panel";
import DataTable, { Row, Td, Th } from "../ui/DataTable";
import Pill from "../ui/Pill";
import ViewHead, { LoadError } from "../ui/ViewHead";
import ViewSkeleton from "../ui/Skeleton";
import { Rise } from "../ui/motion";
import { GhostBtn, PrimaryBtn, StagedTable } from "../ui/Stage3";

/* Stage 3: Upload Center (03). Three import streams stay separate,
   one Dawood single-purpose dropzone card per stream, one primary
   action per panel. The drop-zone lighting is the long-queued Stack
   Glass item: on drag-over the zone brightens with the product blue
   over the glass and settles back on drop or leave. Every file goes
   into the upload queue with real upload progress to Done. The
   Capture Agent's verifier flags appear once, in the trust-decision
   card (blueprint 3 dedup), and the pre-filled sample carries a
   true-status line once its references are settled. All endpoints
   and the parsing pipeline are vanilla's. */

interface QueueItem {
  id: number;
  name: string;
  stream: string;
  size: number;
  progress: number | null;
  status: "uploading" | "processing" | "done" | "failed";
  note: string;
}

let queueSeq = 0;

function fileToB64(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] || "");
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

function xhrImport(
  file: File,
  kind: string,
  b64: string,
  onProgress: (pct: number) => void
): Promise<ImportResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/v1/import/file");
    const headers = authHeaders();
    Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      try {
        const d = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(d);
        else reject(new Error((xhr.responseText || "").slice(0, 300)));
      } catch {
        reject(new Error((xhr.responseText || "").slice(0, 300)));
      }
    };
    xhr.onerror = () => reject(new Error("Upload failed - network error"));
    xhr.send(
      JSON.stringify({
        kind,
        filename: file.name,
        content_b64: b64,
        mode: "replace",
      })
    );
  });
}

function DropZone({
  label,
  onFile,
  inputRef,
}: {
  label: string;
  onFile: (f: File) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const [over, setOver] = useState(false);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      className={`border border-dashed rounded-md p-5 text-center cursor-pointer text-[13px] text-mut select-none ${
        over
          ? "border-blue bg-[rgba(61,117,232,0.12)] text-ink shadow-[0_0_0_1px_#3d75e8,0_12px_32px_rgba(61,117,232,0.28)]"
          : "border-line2 hover:border-blue2"
      }`}
      style={{
        transition:
          "background-color 0.22s cubic-bezier(0.16,1,0.3,1), border-color 0.22s cubic-bezier(0.16,1,0.3,1), box-shadow 0.22s cubic-bezier(0.16,1,0.3,1)",
      }}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files[0];
        if (f) onFile(f);
      }}
    >
      {label}
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}

function MappingChips({ mapping }: { mapping?: Record<string, string> }) {
  const e = Object.entries(mapping || {});
  if (!e.length) return <span className="text-[12px] text-mut">No headers mapped.</span>;
  return (
    <span className="inline-flex gap-1.5 flex-wrap">
      {e.map(([k, v]) => (
        <Pill key={k} kind="info">
          {v} → {k}
        </Pill>
      ))}
    </span>
  );
}

function Quarantine({ errors }: { errors?: { row: number; error: string }[] }) {
  if (!errors?.length) return null;
  return (
    <div className="mt-2">
      <p className="text-[13px] m-0">
        <b>Quarantined rows ({errors.length}):</b>
      </p>
      <DataTable
        head={
          <>
            <Th>Row</Th>
            <Th>Error</Th>
          </>
        }
      >
        {errors.map((e, i) => (
          <Row key={i}>
            <Td>{e.row}</Td>
            <Td>{e.error}</Td>
          </Row>
        ))}
      </DataTable>
    </div>
  );
}

export default function Upload() {
  const [ws, setWs] = useState<WorkspaceOperate | null>(null);
  const [error, setError] = useState("");
  const [queue, setQueue] = useState<QueueItem[]>([]);

  // invoices stream
  const [invText, setInvText] = useState("");
  const [invBusy, setInvBusy] = useState(false);
  const [invResult, setInvResult] = useState<{
    d: ImportResult;
    inv: Invoice[];
  } | null>(null);
  const [invError, setInvError] = useState("");
  const invFileRef = useRef<HTMLInputElement>(null);

  // payments stream
  const [payText, setPayText] = useState("");
  const [payBusy, setPayBusy] = useState(false);
  const [payResult, setPayResult] = useState<ImportResult | null>(null);
  const [payError, setPayError] = useState("");
  const payFileRef = useRef<HTMLInputElement>(null);

  // capture agent
  const [parseText, setParseText] = useState(PARSE_SAMPLE);
  const [parse, setParse] = useState<ParseResult | null>(null);
  const [parseNote, setParseNote] = useState("");
  const [settledRefs, setSettledRefs] = useState<string[]>([]);
  const [stageNote, setStageNote] = useState("");
  const [stageBusy, setStageBusy] = useState(false);
  const parseSeq = useRef(0);
  const parseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadWs = useCallback(() => {
    api<WorkspaceOperate>("/api/v1/workspace")
      .then(setWs)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(loadWs, [loadWs]);

  const pushQueue = (item: Omit<QueueItem, "id">) => {
    const id = ++queueSeq;
    setQueue((q) => [{ ...item, id }, ...q].slice(0, 12));
    return id;
  };
  const patchQueue = (id: number, p: Partial<QueueItem>) =>
    setQueue((q) => q.map((x) => (x.id === id ? { ...x, ...p } : x)));

  /* ---------------- file routing (routeFile) ---------------- */
  const sendFileImport = useCallback(
    async (file: File, kind: "invoices" | "payments") => {
      const qid = pushQueue({
        name: file.name,
        stream: kind === "invoices" ? "Invoices" : "Payments",
        size: file.size,
        progress: 0,
        status: "uploading",
        note: "",
      });
      try {
        const b64 = await fileToB64(file);
        const d = await xhrImport(file, kind, b64, (pct) =>
          patchQueue(qid, { progress: pct })
        );
        patchQueue(qid, { status: "processing", progress: 100 });
        if (kind === "invoices") {
          setInvResult(null);
          setInvError("");
          patchQueue(qid, {
            status: "done",
            note: `${d.imported} invoices imported - the workspace was replaced with this ledger.`,
          });
          setInvResult({ d, inv: [] });
        } else if (d.route === "csv") {
          setPayResult(d);
          setPayError("");
          patchQueue(qid, {
            status: "done",
            note: d.run
              ? `Reconciled as run ${d.run.run_id}: ${d.run.auto_posted} of ${d.run.payments} auto-posted.`
              : `${d.imported} payments imported.`,
          });
          if (d.run) setTimeout(() => goView("run"), 900);
        } else {
          const f = d.fields || {};
          const refs = [
            ...(f.invoice_refs || []),
            ...(f.po_refs || []),
          ];
          patchQueue(qid, {
            status: "done",
            note: `Remittance read (${d.extracted_via}) and staged as ${d.staged}: ${f.payer || "Unknown payer"}, ${money(f.amount_cents || 0)}, references ${refs.length ? refs.join(", ") : "none found"}.`,
          });
          setPayResult(d);
          setPayError("");
        }
        loadWs();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        patchQueue(qid, { status: "failed", note: msg });
        if (kind === "invoices") setInvError(msg);
        else setPayError(msg);
      }
    },
    [loadWs]
  );

  const routeFile = useCallback(
    (file: File, kind: "invoices" | "payments") => {
      const name = (file.name || "").toLowerCase();
      if (kind === "invoices" && /\.(csv|txt)$/.test(name)) {
        const r = new FileReader();
        r.onload = () => setInvText(String(r.result || ""));
        r.readAsText(file);
        return;
      }
      sendFileImport(file, kind);
    },
    [sendFileImport]
  );

  /* ---------------- textarea imports ---------------- */
  const importInvoices = async (mode: "replace" | "append") => {
    const text = invText.trim();
    if (!text) {
      setInvError("Paste or drop an invoices CSV first");
      return;
    }
    setInvBusy(true);
    setInvError("");
    try {
      const d = await api<ImportResult>("/api/v1/invoices/import", {
        method: "POST",
        body: JSON.stringify({ csv_text: text, mode }),
      });
      const inv = await api<Invoice[]>("/api/v1/invoices");
      setInvResult({ d, inv });
      loadWs();
    } catch (e) {
      setInvError(e instanceof Error ? e.message : String(e));
    } finally {
      setInvBusy(false);
    }
  };

  const importPayments = async () => {
    const text = payText.trim();
    if (!text) {
      setPayError("Paste or drop a payments CSV first");
      return;
    }
    setPayBusy(true);
    setPayError("");
    try {
      const d = await api<ImportResult>("/api/v1/payments/import", {
        method: "POST",
        body: JSON.stringify({ csv_text: text }),
      });
      /* The textarea endpoint returns no route field (the file
         endpoint does); a pasted CSV is the csv route by definition,
         and the result region keys off it - without this the import
         landed and navigated with no result ever shown. */
      setPayResult({ ...d, route: "csv" });
      loadWs();
      if (d.run) setTimeout(() => goView("run"), 900);
    } catch (e) {
      setPayError(e instanceof Error ? e.message : String(e));
    } finally {
      setPayBusy(false);
    }
  };

  const downloadTemplate = (k: "inv" | "pay") => {
    const blob = new Blob([k === "inv" ? TPL_INV : TPL_PAY], {
      type: "text/csv",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download =
      k === "inv"
        ? "slatematch_invoices_template.csv"
        : "slatematch_payments_template.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  /* ---------------- capture agent (runParse / wireAutoParse) ------ */
  const runParse = useCallback(
    async (text: string) => {
      const seq = ++parseSeq.current;
      try {
        const out = await api<ParseResult>("/api/v1/parse", {
          method: "POST",
          body: JSON.stringify({ text }),
        });
        if (seq !== parseSeq.current) return;
        setParse(out);
        setParseNote("");
        // True-status check for the pre-filled sample: are its flagged
        // references in fact settled by this workspace's run?
        const unknown = out.verification?.unknown_refs || [];
        if (text === PARSE_SAMPLE && unknown.length) {
          try {
            const w = await api<WorkspaceOperate>("/api/v1/workspace");
            if (w.latest_run) {
              const ms = await api<{ result?: { lines?: { invoice_id: string }[] } }[]>(
                `/api/v1/runs/${w.latest_run.run_id}/matches`
              );
              const settled = new Set<string>();
              ms.forEach((m) =>
                (m.result?.lines || []).forEach((l) => settled.add(l.invoice_id))
              );
              setSettledRefs(unknown.filter((r) => settled.has(r)));
            } else setSettledRefs([]);
          } catch {
            setSettledRefs([]);
          }
        } else setSettledRefs([]);
      } catch (e) {
        if (seq !== parseSeq.current) return;
        setParseNote(
          "Analysis failed - edit the text and it retries automatically. (" +
            (e instanceof Error ? e.message : String(e)) +
            ")"
        );
      }
    },
    []
  );

  useEffect(() => {
    if (parseTimer.current) clearTimeout(parseTimer.current);
    const text = parseText;
    if (!text.trim() || !/\d/.test(text)) {
      parseSeq.current++;
      setParse(null);
      setParseNote(
        "Paste a remittance and it is analyzed automatically - the extracted wire appears here."
      );
      setSettledRefs([]);
      return;
    }
    parseTimer.current = setTimeout(() => runParse(text), 550);
    return () => {
      if (parseTimer.current) clearTimeout(parseTimer.current);
    };
  }, [parseText, runParse]);

  const stageParsed = async (thenRun: boolean) => {
    if (!parse) return;
    const f = parse.fields || {};
    setStageBusy(true);
    try {
      const refs = [...(f.invoice_refs || []), ...(f.po_refs || [])];
      const out = await api<{ staged: string }>("/api/v1/workspace/stage-payment", {
        method: "POST",
        body: JSON.stringify({
          payer: f.payer || "",
          amount_cents: f.amount_cents || 0,
          references: refs,
          claimed_deduction_cents: f.deduction_cents || 0,
          deduction_reason: f.deduction_reason || "",
          remittance_text: parseText,
        }),
      });
      setStageNote(`Wire staged as ${out.staged} - find it in Run Reconciliation`);
      loadWs();
      if (thenRun) {
        setIntent("slate-run-live", "1");
        goView("run");
      }
    } catch (e) {
      setStageNote(e instanceof Error ? e.message : String(e));
    } finally {
      setStageBusy(false);
    }
  };

  const seedRefsAndStage = async () => {
    if (!parse) return;
    const f = parse.fields || {};
    const refs = parse.verification?.unknown_refs || [];
    if (!refs.length) return;
    setStageBusy(true);
    try {
      const d = await api<{
        seeded: { invoice_id: string }[];
        unresolved?: string[];
      }>("/api/v1/invoices/seed-referenced", {
        method: "POST",
        body: JSON.stringify({
          refs,
          payer: f.payer || "",
          wire_amount_cents: f.amount_cents || 0,
          remittance_text: parseText,
        }),
      });
      if (d.unresolved && d.unresolved.length) {
        setStageNote(
          `Seeded ${(d.seeded || []).length} invoice(s), but no amount could be determined for ${d.unresolved.join(", ")} from the remittance - add those in the Ledger or the Case Builder, then stage the wire`
        );
        return;
      }
      setStageNote(
        `Seeded ${d.seeded.map((s) => s.invoice_id).join(", ")} into the ledger - staging the wire against them`
      );
      loadWs();
      await stageParsed(false);
      runParse(parseText);
    } catch (e) {
      setStageNote("Seeding failed: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setStageBusy(false);
    }
  };

  const pf = parse?.fields || {};
  const pRefs = [...(pf.invoice_refs || []), ...(pf.po_refs || [])];
  // The verifier's flags live in two places in the payload
  // (verification.issues and the pipeline steps) - vanilla prints
  // them twice over. Here they are deduplicated by text and shown
  // once, in the trust-decision card only.
  const allIssues = [
    ...new Set([
      ...((parse?.verification?.issues || []) as string[]),
      ...((parse?.pipeline || []).flatMap((p) => p.issues || [])),
    ]),
  ];
  const unknownRefs = parse?.verification?.unknown_refs || [];
  const pending = ws?.pending_payments || [];
  const settledCount = (ws?.staged_payments || 0) - pending.length;

  const taCls =
    "w-full box-border font-mono text-[12.5px] leading-relaxed px-3 py-2.5 rounded-[3px] border border-line2 glass-input text-ink mt-3";

  return (
    <>
      <ViewHead
        eyebrow="OPERATE - 03 / UPLOAD CENTER"
        title="Upload Center"
        purpose="Bring your own ledger and wires. Every import is fingerprinted, mapped and quarantined row by row - nothing is silently dropped."
        onRefresh={loadWs}
      />
      {!ws && !error && <ViewSkeleton kind="panels" />}
      {error && <LoadError error={error} />}

      {/* showHandoff() (assist.js): while payments wait, the way
          forward is one click, at the top of this view. */}
      {pending.length > 0 && (
        <Rise i={0}>
          <div className="glass-card rounded-md border border-blue/50 px-4 py-3 flex items-center gap-3 flex-wrap">
            <span className="text-[13.5px]">
              ✓ <b>{pending.length} payments staged ({money(pending.reduce((a, p) => a + p.amount_cents, 0))})</b>{" "}
              - ready to reconcile.
            </span>
            <PrimaryBtn
              onClick={() => {
                setIntent(
                  "slate-hl-rows",
                  pending.map((p) => p.payment_id).join(",")
                );
                setIntent("slate-run-live", "1");
                goView("run");
              }}
            >
              Execute reconciliation →
            </PrimaryBtn>
            <span className="text-[12px] text-mut">
              The staged payments are highlighted at the top of the Run
              page.
            </span>
          </div>
        </Rise>
      )}

      {queue.length > 0 && (
        <Rise i={0}>
          <Panel title="Upload queue">
            <div className="flex flex-col gap-2 mt-3">
              {queue.map((q) => (
                <div
                  key={q.id}
                  className="glass-card rounded-md border border-white/[0.11] px-3 py-2.5"
                >
                  <div className="flex items-center gap-3 flex-wrap">
                    <b className="text-[13px] break-all">{q.name}</b>
                    <span className="text-[12px] text-mut">
                      {(q.size / 1024).toFixed(1)} KB · {q.stream}
                    </span>
                    {q.status === "done" && <Pill kind="ok">Done</Pill>}
                    {q.status === "failed" && <Pill kind="bad">Import failed</Pill>}
                    {q.status === "uploading" && (
                      <Pill kind="info">Uploading {q.progress ?? 0}%</Pill>
                    )}
                    {q.status === "processing" && (
                      <Pill kind="info">Reading and importing</Pill>
                    )}
                  </div>
                  {(q.status === "uploading" || q.status === "processing") && (
                    <div className="h-[5px] rounded bg-white/[0.07] overflow-hidden mt-2">
                      <div
                        className="h-full bg-blue transition-all"
                        style={{
                          width: `${q.status === "processing" ? 100 : q.progress || 0}%`,
                        }}
                      />
                    </div>
                  )}
                  {q.note && (
                    <p className="text-[12.5px] text-mut leading-relaxed m-0 mt-1.5 break-words">
                      {q.note}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </Panel>
        </Rise>
      )}

      <Rise i={1}>
        <Panel
          title="1. Open invoices (AR ledger)"
          sub="Drop a CSV, TXT export from your ERP, or paste rows. The ledger is the solver's world - every invoice here can be matched."
        >
          <div className="mt-3">
            <DropZone
              label="Drop an invoices file here, or click to choose"
              onFile={(f) => routeFile(f, "invoices")}
              inputRef={invFileRef}
            />
          </div>
          <textarea
            id="csv-inv"
            className={taCls}
            rows={7}
            placeholder="invoice_id,customer,amount,po_number,discount_rate,age_days,due_in_days"
            value={invText}
            onChange={(e) => setInvText(e.target.value)}
          />
          <div className="flex gap-2 flex-wrap mt-2">
            <GhostBtn onClick={() => setInvText(SAMPLE_INV)}>
              Load sample invoices
            </GhostBtn>
            <GhostBtn onClick={() => downloadTemplate("inv")}>
              Download template
            </GhostBtn>
          </div>
          <div className="flex gap-2 flex-wrap mt-3">
            <PrimaryBtn
              onClick={() => importInvoices("replace")}
              disabled={invBusy}
            >
              Import as new workspace
            </PrimaryBtn>
            <GhostBtn onClick={() => importInvoices("append")} disabled={invBusy}>
              Add to current ledger
            </GhostBtn>
          </div>
          {invError && (
            <p className="text-[13px] text-bad m-0 mt-2.5 break-words">{invError}</p>
          )}
          {invResult && (
            <div className="mt-3">
              <p className="text-[13px] leading-relaxed m-0">
                <b>{invResult.d.imported} invoices imported</b>
                {invResult.inv.length
                  ? ` - ${invResult.d.mode === "replace" ? "the workspace was replaced with this ledger" : "the rows were added to the active ledger"}; the workspace now holds ${invResult.inv.length} open invoices. Source fingerprint ${invResult.d.fingerprint}.`
                  : ` from the file - the workspace was replaced with this ledger. The full book is on the Ledger page.`}
              </p>
              <div className="mt-2">
                <MappingChips mapping={invResult.d.mapping} />
              </div>
              <Quarantine errors={invResult.d.errors} />
              {invResult.inv.length > 0 && (
                <>
                  <DataTable
                    head={
                      <>
                        <Th>Invoice</Th>
                        <Th>Customer</Th>
                        <Th>Subsidiary</Th>
                        <Th>PO</Th>
                        <Th>Gross</Th>
                        <Th>Discount</Th>
                        <Th>Age (d)</Th>
                        <Th>State</Th>
                        <Th>Pred. delay</Th>
                      </>
                    }
                  >
                    {invResult.inv.slice(0, 10).map((i) => (
                      <Row key={i.invoice_id}>
                        <Td>{i.invoice_id}</Td>
                        <Td>{i.customer}</Td>
                        <Td>{i.subsidiary || "-"}</Td>
                        <Td>{i.po_number || "-"}</Td>
                        <Td>{money(i.gross_cents)}</Td>
                        <Td>
                          {i.discount_rate ? `${i.discount_rate * 100}%` : "-"}
                        </Td>
                        <Td>{i.age_days}</Td>
                        <Td>
                          {i.due_in_days < 0 ? (
                            <Pill kind="warn">
                              Overdue {Math.abs(i.due_in_days)}d
                            </Pill>
                          ) : (
                            <Pill kind="grey">Open</Pill>
                          )}
                        </Td>
                        <Td>
                          {(i as Invoice & { predicted_delay_days?: number })
                            .predicted_delay_days ?? "-"}
                        </Td>
                      </Row>
                    ))}
                  </DataTable>
                  <p className="text-[12px] text-mut m-0 mt-1.5">
                    First 10 shown - the full ledger is on the Ledger page.
                    Now import payments, or run what is staged.
                  </p>
                </>
              )}
            </div>
          )}
        </Panel>
      </Rise>

      <Rise i={2}>
        <Panel
          title="2. Payments (bank / lockbox)"
          sub="CSV payments reconcile immediately. A remittance file (EML, PDF, image) is read by the Capture Agent and staged as one wire."
        >
          <div className="mt-3">
            <DropZone
              label="Drop a payments file here, or click to choose"
              onFile={(f) => routeFile(f, "payments")}
              inputRef={payFileRef}
            />
          </div>
          <textarea
            id="csv-pay"
            className={taCls}
            rows={7}
            placeholder="payment_id,payer,amount,remittance,deduction,deduction_reason"
            value={payText}
            onChange={(e) => setPayText(e.target.value)}
          />
          <div className="flex gap-2 flex-wrap mt-2">
            <GhostBtn onClick={() => setPayText(SAMPLE_PAY)}>
              Load sample payments
            </GhostBtn>
            <GhostBtn onClick={() => downloadTemplate("pay")}>
              Download template
            </GhostBtn>
          </div>
          <div className="flex gap-2 flex-wrap mt-3">
            <PrimaryBtn onClick={importPayments} disabled={payBusy}>
              Import and reconcile payments
            </PrimaryBtn>
          </div>
          {payError && (
            <p className="text-[13px] text-bad m-0 mt-2.5 break-words">{payError}</p>
          )}
          {payResult && payResult.route === "csv" && (
            <div className="mt-3">
              <p className="text-[13px] leading-relaxed m-0">
                <b>{payResult.imported} payments imported and reconciled.</b>{" "}
                Source fingerprint {payResult.fingerprint}.
              </p>
              <div className="mt-2">
                <MappingChips mapping={payResult.mapping} />
              </div>
              <Quarantine errors={payResult.errors} />
              {payResult.run ? (
                <p className="text-[13px] m-0 mt-2">
                  Reconciled as run <b>{payResult.run.run_id}</b>:{" "}
                  {payResult.run.auto_posted} of {payResult.run.payments}{" "}
                  auto-posted, touchless{" "}
                  <b>{(payResult.run.touchless_rate * 100).toFixed(1)}%</b>.
                  Taking you to Run Reconciliation to inspect every match and
                  exception.
                </p>
              ) : (
                <p className="text-[13px] text-mut m-0 mt-2">
                  No valid payment rows to reconcile.
                </p>
              )}
            </div>
          )}
          {payResult && payResult.route !== "csv" && payResult.fields && (
            <div className="mt-3">
              <p className="text-[13px] leading-relaxed m-0">
                <b>Remittance read</b> ({payResult.extracted_via}) and staged
                as <b>{payResult.staged}</b>:{" "}
                {payResult.fields.payer || "Unknown payer"},{" "}
                <b>{money(payResult.fields.amount_cents || 0)}</b>, references{" "}
                {[
                  ...(payResult.fields.invoice_refs || []),
                  ...(payResult.fields.po_refs || []),
                ].length
                  ? [
                      ...(payResult.fields.invoice_refs || []),
                      ...(payResult.fields.po_refs || []),
                    ].join(", ")
                  : "none found"}
                .{" "}
                {payResult.verification?.verified ? (
                  <Pill kind="ok">References verified against the ledger</Pill>
                ) : (
                  <Pill kind="warn">
                    Some references are not in the ledger - flagged, never guessed
                  </Pill>
                )}{" "}
                <Pill kind="info">
                  {payResult.source === "gemini"
                    ? "Extracted by Gemini"
                    : "Deterministic extraction"}
                </Pill>
              </p>
              <p className="text-[13px] text-mut m-0 mt-1.5">
                Staged in the workspace - run it from Run Reconciliation,
                with the rest of the case.
              </p>
            </div>
          )}
        </Panel>
      </Rise>

      <Rise i={3}>
        <Panel
          title="Remittance and wire input - the Capture Agent"
          sub="Paste a remittance email or lockbox text. The Capture Agent extracts the wire, verifies every reference against the open ledger, and only then may it be staged."
        >
          <textarea
            id="parse-in"
            className={taCls}
            rows={5}
            value={parseText}
            onChange={(e) => setParseText(e.target.value)}
          />
          {parseNote && (
            <p className="text-[12.5px] text-mut m-0 mt-2">{parseNote}</p>
          )}
          {settledRefs.length > 0 && (
            <p className="text-[13px] leading-relaxed m-0 mt-2.5 border border-blue/40 bg-[rgba(61,117,232,0.10)] rounded-md px-3 py-2">
              True status: {settledRefs.join(" and ")} are flagged below
              because they are no longer open - the run on this workspace
              already settled them. The flags are the verifier comparing
              against what is still open, not a problem with this wire.
            </p>
          )}
          {parse && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 mt-3.5">
                {(parse.pipeline || []).map((p, i, arr) => {
                  const isTrust = i === arr.length - 1;
                  return (
                    <div
                      key={i}
                      className="glass-card rounded-md border border-white/[0.11] p-3.5"
                    >
                      <div className="font-display text-[13.5px] font-semibold">
                        {p.stage}
                      </div>
                      <div className="font-mono text-[11px] text-blue2 mt-0.5">
                        {p.engine}
                        {p.ms ? ` - ${p.ms} ms` : ""}
                      </div>
                      <p className="text-[12.5px] text-mut leading-relaxed m-0 mt-1.5">
                        {p.detail}
                      </p>
                      {isTrust && allIssues.length > 0 && (
                        <div className="flex flex-col gap-1 mt-2">
                          {allIssues.map((x, j) => (
                            <span
                              key={j}
                              className="font-mono text-[10.5px] font-medium px-2 py-[3px] rounded-[2px] tracking-[0.02em] text-bad bg-badbg break-words"
                            >
                              {x}
                            </span>
                          ))}
                        </div>
                      )}
                      {isTrust && unknownRefs.length > 0 && (
                        <div className="mt-2.5">
                          <GhostBtn onClick={seedRefsAndStage} disabled={stageBusy}>
                            + Auto-Seed Referenced Invoices into Ledger &amp;
                            Stage Wire ({unknownRefs.join(", ")})
                          </GhostBtn>
                          <p className="text-[12px] text-mut leading-relaxed m-0 mt-1.5">
                            Creates exactly those missing invoices in the
                            ledger - at the wire amount for a single
                            reference, or the amounts this remittance itself
                            lists - then stages the wire against them.
                          </p>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mt-4 items-start">
                <div className="glass-card rounded-md border border-white/[0.11] p-4">
                  <h4 className="font-display text-[14px] font-semibold m-0">
                    Structured result
                  </h4>
                  <p className="text-[13px] leading-relaxed m-0 mt-2">
                    Parser: <b>{parse.source || "deterministic"}</b>{" "}
                    {parse.degraded && (
                      <Pill kind="warn">
                        {parse.ai_state === "no_key"
                          ? "Deterministic Verifier Fallback Active (No AI Key)"
                          : "Deterministic fallback - Gemini did not answer (diagnostics on Agent Health)"}
                      </Pill>
                    )}
                    <br />
                    Amount:{" "}
                    <b>{pf.amount_cents != null ? money(pf.amount_cents) : "-"}</b>{" "}
                    - Payer: <b>{pf.payer || "-"}</b> - Claimed deduction:{" "}
                    <b>
                      {pf.deduction_cents != null
                        ? money(pf.deduction_cents)
                        : "-"}
                    </b>
                    {pf.deduction_reason ? ` (${pf.deduction_reason})` : ""}
                    <br />
                    References extracted:{" "}
                    {pRefs.length ? (
                      <span className="inline-flex gap-1.5 flex-wrap">
                        {pRefs.map((r) => (
                          <Pill key={r} kind="info">
                            {r}
                          </Pill>
                        ))}
                      </span>
                    ) : (
                      <span className="text-mut">none</span>
                    )}
                  </p>
                  <details className="mt-2.5">
                    <summary className="text-[12px] text-mut cursor-pointer">
                      Raw response
                    </summary>
                    <pre className="font-mono text-[11.5px] leading-relaxed bg-[#0f172a] text-[#dbeafe] p-3.5 rounded-md overflow-auto mt-2 whitespace-pre-wrap break-words">
                      {JSON.stringify(parse, null, 2)}
                    </pre>
                  </details>
                </div>

                <div className="glass-card rounded-md border border-white/[0.11] p-4">
                  <div className="font-mono text-[10.5px] tracking-[0.07em] uppercase text-mut">
                    The wire
                  </div>
                  <div className="font-display text-[30px] leading-none font-semibold mt-1.5">
                    {pf.amount_cents ? money(pf.amount_cents) : "not parsed yet"}
                  </div>
                  <p className="text-[13px] leading-relaxed m-0 mt-2">
                    Payer: <b>{pf.payer || "-"}</b> - read by{" "}
                    <b>{parse.source || "deterministic"}</b>
                    {parse.degraded
                      ? ` (deterministic fallback - ${parse.ai_state === "no_key" ? "no Gemini key configured" : "Gemini unavailable for this parse"})`
                      : ""}{" "}
                    -{" "}
                    {parse.verification?.verified ? (
                      <span className="text-ok">
                        every reference verified in the ledger
                      </span>
                    ) : (
                      <span className="text-warn">
                        some references flagged - see the trust decision above
                      </span>
                    )}
                  </p>
                  {!!pf.deduction_cents && (
                    <p className="text-[13px] leading-relaxed m-0 mt-2 border border-warn/40 bg-warnbg rounded-md px-3 py-2">
                      Claimed deduction: <b>-{money(pf.deduction_cents)}</b>
                      {pf.deduction_reason ? ` - ${pf.deduction_reason}` : ""} -
                      the Deduction Agent classifies it at reconcile time, and
                      the expected-value rule decides whether to dispute it.
                    </p>
                  )}
                  <div className="flex gap-2 flex-wrap mt-3">
                    <PrimaryBtn
                      onClick={() => runParse(parseText)}
                      disabled={stageBusy}
                    >
                      Re-run analysis
                    </PrimaryBtn>
                    <GhostBtn
                      onClick={() => stageParsed(false)}
                      disabled={stageBusy || !(pf.amount_cents && pf.amount_cents > 0)}
                    >
                      Stage this wire into the workspace
                    </GhostBtn>
                    <GhostBtn
                      onClick={() => stageParsed(true)}
                      disabled={stageBusy || !(pf.amount_cents && pf.amount_cents > 0)}
                    >
                      Stage and reconcile now
                    </GhostBtn>
                  </div>
                  {stageNote && (
                    <p className="text-[12.5px] text-mut m-0 mt-2">{stageNote}</p>
                  )}
                </div>
              </div>
            </>
          )}
        </Panel>
      </Rise>

      <Rise i={4}>
        <Panel title="Staged in this workspace">
          {!ws?.staged_payments ? (
            <p className="text-[13px] text-mut m-0 mt-2">
              Nothing staged yet. Import payments above and they are staged
              here, untouched, until you run them from Run Reconciliation.
            </p>
          ) : (
            <>
              <StagedTable pays={pending} />
              {pending.length > 0 && (
                <div className="mt-3">
                  <PrimaryBtn onClick={() => goView("run")}>
                    ✓ Staged in Workspace - Go to 04 Run Reconciliation to
                    Solve →
                  </PrimaryBtn>
                </div>
              )}
              <p className="text-[12px] text-mut m-0 mt-2">
                {ws.staged_payments} payments staged in the active case
                {ws.case ? ` (${ws.case.name})` : ""}: {pending.length}{" "}
                pending, {settledCount} already run.
              </p>
            </>
          )}
        </Panel>
      </Rise>
    </>
  );
}
