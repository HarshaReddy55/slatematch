import { useCallback, useEffect, useRef, useState } from "react";
import { api, money } from "../lib/api";
import { requestShellRefresh, type WorkspaceFull } from "../lib/chrome";
import { goView } from "../lib/operate";
import Panel from "../ui/Panel";
import ViewHead, { LoadError, Loading } from "../ui/ViewHead";
import { Rise } from "../ui/motion";

/* Stage 4: Policy Studio, migrated. Same endpoints, same body shape,
   same save flow as vanilla assist.js (preview, PUT, then a full
   batch re-run of the active case via /api/v1/batches). Every label,
   formula line and consequence sentence is vanilla's, verbatim.
   Audit row 12 fixes: the ten rows are grouped (Posting, Disputes,
   Governance) and the two cent fields display in dollars - the
   stored value and the API body stay in cents, exact; the raw cent
   value is one hover away in the input's title. */

type FieldType = "text" | "number" | "cents";
interface Field {
  key: string;
  label: string;
  why: string;
  formula: string;
  type: FieldType;
}

const GROUPS: { title: string; fields: Field[] }[] = [
  {
    title: "Posting",
    fields: [
      {
        key: "automation_threshold",
        label: "Automation threshold (0-1)",
        why: "Minimum solver confidence for a match to auto-post without a human. Higher is safer and slower; 0.90 is the conservative default.",
        formula: "auto-post iff OPTIMAL_EXACT_MATCH and confidence >= threshold",
        type: "number",
      },
      {
        key: "age_weight",
        label: "Age weight (FIFO pressure)",
        why: "How strongly the solver prefers settling older invoices first. Protects DSO and audit narratives.",
        formula: "objective term per invoice: -(1 + age_days x age_weight)",
        type: "number",
      },
      {
        key: "discount_penalty",
        label: "Discount penalty",
        why: "Cost assigned to assuming an early-pay discount. Stops the solver inventing discounts to force a fit.",
        formula: "objective cost of setting d_i = 1 (taking a discount)",
        type: "number",
      },
      {
        key: "residual_penalty",
        label: "Residual penalty",
        why: "Penalty per unexplained cent. Set astronomically high (1,000,000) so the optimiser would rather propose nothing than hide a residual.",
        formula: "objective cost per residual cent - dominates all other terms",
        type: "number",
      },
      {
        key: "deduction_penalty",
        label: "Deduction penalty",
        why: "Cost of accepting a claimed deduction inside a match. Works with the tolerance and dispute rules below.",
        formula: "objective cost of setting y = 1 (accepting the claim)",
        type: "number",
      },
    ],
  },
  {
    title: "Disputes",
    fields: [
      {
        key: "tolerance_writeoff_cents",
        label: "Tolerance write-off ($)",
        why: "Variances at or below this amount (default $25) are written off automatically - disputing them costs more than they are worth.",
        formula: "claimed <= tolerance -> WRITE_OFF_TOLERANCE",
        type: "cents",
      },
      {
        key: "auto_dispute_min_recovery_usd",
        label: "Auto-dispute min recovery ($)",
        why: "A dispute claim is generated automatically only when expected recovery (win probability x claim - $45 processing cost) exceeds this.",
        formula: "dispute iff win_prob x claimed - processing_cost > threshold",
        type: "number",
      },
      {
        key: "dispute_processing_cost_usd",
        label: "Dispute processing cost ($)",
        why: "The fully-loaded cost of working one dispute. Feeds the expected-value rule honestly instead of disputing everything.",
        formula: "subtracted in the expected-recovery computation",
        type: "number",
      },
    ],
  },
  {
    title: "Governance",
    fields: [
      {
        key: "name",
        label: "Policy name",
        why: "A label for this behaviour profile. Tenants can run several (for example a stricter month-end profile).",
        formula: "profile label only - no mathematical role",
        type: "text",
      },
      {
        key: "maker_checker_threshold_cents",
        label: "Maker-checker threshold ($)",
        why: "Matches above this value ($100,000 default) require a second human approver even at full solver confidence.",
        formula: "match value above this requires a second approver",
        type: "cents",
      },
    ],
  },
];

const ALL_FIELDS = GROUPS.flatMap((g) => g.fields);

interface PreviewData {
  base_run_id?: string | null;
  auto_before?: number;
  auto_after?: number;
  posted_value_before_cents?: number;
  posted_value_after_cents?: number;
  moved_to_approvals?: { payment_id: string; amount_cents: number }[];
  moved_to_auto?: { payment_id: string; amount_cents: number }[];
  note?: string;
}

function centsToDisplay(cents: number): string {
  return (cents / 100).toFixed(2);
}

export default function Policy({
  toast,
}: {
  toast: (m: string) => void;
}) {
  const [values, setValues] = useState<Record<string, string> | null>(null);
  const [source, setSource] = useState("");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [previewNote, setPreviewNote] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [busy, setBusy] = useState("");
  const busyRef = useRef(false);

  const load = useCallback(() => {
    setError("");
    api<{ policy: Record<string, unknown>; source?: string }>("/api/v1/policy")
      .then((d) => {
        const p = d.policy || {};
        const v: Record<string, string> = {};
        for (const f of ALL_FIELDS) {
          const raw = p[f.key];
          if (raw == null) v[f.key] = "";
          else if (f.type === "cents") v[f.key] = centsToDisplay(Number(raw));
          else v[f.key] = String(raw);
        }
        setValues(v);
        setSource("Source: " + (d.source || "tenant"));
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(load, [load]);

  /** The request body, identical in shape and values to vanilla's
      policyFormBody: numbers as numbers, cents fields back in exact
      cents. Returns null (and names the field) on a non-number. */
  const buildBody = (): Record<string, unknown> | null => {
    if (!values) return null;
    const body: Record<string, unknown> = {};
    for (const f of ALL_FIELDS) {
      const raw = (values[f.key] ?? "").trim();
      if (f.type === "text") {
        body[f.key] = raw;
        continue;
      }
      const n = parseFloat(raw);
      if (raw === "" || Number.isNaN(n)) {
        setFieldError(`${f.label} needs a number before this can run.`);
        return null;
      }
      body[f.key] = f.type === "cents" ? Math.round(n * 100) : n;
    }
    setFieldError("");
    return body;
  };

  const runPreview = async (
    body: Record<string, unknown>
  ): Promise<PreviewData | null> => {
    try {
      const d = await api<PreviewData>("/api/v1/policy/preview", {
        method: "POST",
        body: JSON.stringify({ policy: body }),
      });
      setPreview(d);
      setPreviewNote("");
      return d;
    } catch (e) {
      setPreview(null);
      setPreviewNote(
        "Preview failed: " + (e instanceof Error ? e.message : String(e))
      );
      return null;
    }
  };

  const onPreview = async () => {
    if (busyRef.current) return;
    const body = buildBody();
    if (!body) return;
    busyRef.current = true;
    setBusy("preview");
    await runPreview(body);
    busyRef.current = false;
    setBusy("");
  };

  const onSave = async () => {
    if (busyRef.current) return;
    const body = buildBody();
    if (!body) return;
    busyRef.current = true;
    setBusy("save");
    try {
      await runPreview(body);
      await api("/api/v1/policy", {
        method: "PUT",
        body: JSON.stringify({ policy: body }),
      });
      setSource("Source: tenant (just saved)");
      const ws = await api<WorkspaceFull>("/api/v1/workspace");
      if (ws && ws.case) {
        toast("Policy saved - re-running the active case under it");
        await api("/api/v1/batches", {
          method: "POST",
          body: JSON.stringify({
            idempotency_key: "ui-case-" + Date.now(),
            payments: ws.all_payments || [],
          }),
        });
        requestShellRefresh();
        goView("run");
      } else {
        toast("Policy saved - the next batch run uses it (impact preview above)");
      }
    } catch (e) {
      toast("Save failed: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      busyRef.current = false;
      setBusy("");
    }
  };

  const movedSum = (rows?: { amount_cents: number }[]) =>
    (rows || []).reduce((a, m) => a + m.amount_cents, 0);

  return (
    <div className="flex flex-col gap-4">
      <ViewHead
        eyebrow="INSIGHT & GOVERNANCE - 09 / POLICY STUDIO"
        title="Policy Studio"
        purpose="The approval queue and the thresholds that govern automatic posting."
        onRefresh={load}
      />
      {!values && !error && <Loading label="LOADING POLICY..." />}
      {error && <LoadError error={error} />}
      {values && (
        <Rise i={0}>
          <Panel>
            <p className="text-[12.5px] text-mut m-0 leading-relaxed">
              Changing this value changes the next run's behaviour; the run
              records the policy it used.
            </p>
            <div className="flex flex-col gap-6 mt-4">
              {GROUPS.map((g) => (
                <fieldset key={g.title} className="border-0 m-0 p-0">
                  <legend className="font-mono text-[10.5px] tracking-[0.1em] uppercase text-blue2 p-0 mb-2">
                    {g.title}
                  </legend>
                  <div className="flex flex-col">
                    {g.fields.map((f) => (
                      <div
                        key={f.key}
                        className="py-3 border-t border-white/[0.06] first:border-t-0 grid grid-cols-1 lg:grid-cols-[minmax(220px,340px)_180px_1fr] gap-2 lg:gap-4 items-start"
                      >
                        <div>
                          <label
                            htmlFor={`pol-${f.key}`}
                            className="text-[13.5px] font-medium"
                          >
                            {f.label}
                          </label>
                          <div className="font-mono text-[11px] text-mut2 mt-1 leading-relaxed">
                            {f.formula}
                          </div>
                        </div>
                        <input
                          id={`pol-${f.key}`}
                          type={f.type === "text" ? "text" : "number"}
                          step="any"
                          value={values[f.key]}
                          title={
                            f.type === "cents" &&
                            values[f.key] &&
                            !Number.isNaN(parseFloat(values[f.key]))
                              ? `${Math.round(parseFloat(values[f.key]) * 100)} cents`
                              : undefined
                          }
                          onChange={(e) =>
                            setValues((v) =>
                              v ? { ...v, [f.key]: e.target.value } : v
                            )
                          }
                          className="bg-bg2 border border-line rounded-[3px] px-2.5 py-2 text-[13.5px] text-ink w-full font-mono"
                        />
                        <p className="text-[12.5px] text-mut leading-relaxed m-0">
                          {f.why}
                        </p>
                      </div>
                    ))}
                  </div>
                </fieldset>
              ))}
            </div>

            {fieldError && (
              <p className="text-sm text-bad mb-0 mt-3">{fieldError}</p>
            )}

            <div className="flex items-center gap-2 flex-wrap mt-4">
              <button
                className="font-sans text-[13px] font-medium px-3.5 py-2 rounded-[3px] border border-blue text-white bg-blue hover:bg-[#2f66d6] cursor-pointer disabled:opacity-60"
                onClick={onSave}
                disabled={!!busy}
              >
                {busy === "save"
                  ? "Saving policy & re-running the case..."
                  : "Save policy"}
              </button>
              <button
                className="font-sans text-[13px] font-medium px-3.5 py-2 rounded-[3px] border border-line2 text-ink bg-transparent hover:border-blue cursor-pointer disabled:opacity-60"
                onClick={onPreview}
                disabled={!!busy}
              >
                Preview impact on the active run
              </button>
              <small className="text-mut">{source}</small>
            </div>

            {previewNote && (
              <p className="text-sm text-mut mb-0 mt-3">{previewNote}</p>
            )}
            {preview &&
              (preview.base_run_id ? (
                <div
                  className="rounded-md border border-blue mt-4 p-3.5"
                  style={{ background: "rgba(61,117,232,.14)" }}
                >
                  <p className="m-0 text-[13.5px] leading-relaxed">
                    <b>Policy impact preview</b> - re-evaluated run{" "}
                    <span className="font-mono text-[12px]">
                      {preview.base_run_id}
                    </span>{" "}
                    with these values: auto-posted {preview.auto_before} →{" "}
                    {preview.auto_after} (
                    {money(preview.posted_value_before_cents)}) →{" "}
                    {money(preview.posted_value_after_cents)}).
                  </p>
                  {(preview.moved_to_approvals || []).length > 0 && (
                    <p className="mb-0 mt-1.5 text-[13.5px] leading-relaxed">
                      <b>
                        {preview.moved_to_approvals!.length} formerly
                        auto-posted match
                        {preview.moved_to_approvals!.length > 1 ? "es" : ""} (
                        {money(movedSum(preview.moved_to_approvals))}) move to
                        Approvals Waiting:
                      </b>{" "}
                      {preview.moved_to_approvals!
                        .map((m) => `${m.payment_id} (${money(m.amount_cents)})`)
                        .join(", ")}
                    </p>
                  )}
                  {(preview.moved_to_auto || []).length > 0 && (
                    <p className="mb-0 mt-1.5 text-[13.5px] leading-relaxed">
                      <b>
                        {preview.moved_to_auto!.length} held match
                        {preview.moved_to_auto!.length > 1 ? "es" : ""} (
                        {money(movedSum(preview.moved_to_auto))}) would
                        auto-post:
                      </b>{" "}
                      {preview.moved_to_auto!
                        .map((m) => `${m.payment_id} (${money(m.amount_cents)})`)
                        .join(", ")}
                    </p>
                  )}
                  {!(preview.moved_to_approvals || []).length &&
                    !(preview.moved_to_auto || []).length && (
                      <p className="mb-0 mt-1.5 text-[13.5px]">
                        No match changes decision under these values.
                      </p>
                    )}
                  {preview.note && (
                    <p className="mb-0 mt-1.5">
                      <small className="text-mut">{preview.note}</small>
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-mut mb-0 mt-3">
                  {preview.note || "No run to preview against."}
                </p>
              ))}
          </Panel>
        </Rise>
      )}
    </div>
  );
}
