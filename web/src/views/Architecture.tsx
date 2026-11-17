import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { probeText, type Diagnostics } from "../lib/insight";
import Panel from "../ui/Panel";
import Pill from "../ui/Pill";
import ViewHead, { Loading } from "../ui/ViewHead";
import DataTable, { Row, Td, Th } from "../ui/DataTable";
import { Rise } from "../ui/motion";

/* Architecture (view 13): the React port of vanilla's Architecture
   section - the same panels and tables, with the live diagnostics
   panel read from the same /api/v1/diagnostics endpoint Agent
   Health uses. A handful of vanilla lines described the pre-React,
   pre-hardening deployment (the vanilla UI itself, the old test
   count, ECS Express, container-local data); those lines are
   corrected to the current system here rather than copied stale. */

const REQUEST_PATH: [string, string, string][] = [
  [
    "1",
    "Ingestion + transform",
    "CSV, PDF, image or API input is normalised to the canonical schema: synonym header mapping, source fingerprinting, row quarantine with reasons, OCR on image remittances. Bank lockbox and statement files (BAI2, MT940, camt.054) parse straight into staged payments. Remittance text goes to the parser (Gemini when configured, a deterministic parser otherwise, with the mode shown) and every extracted reference is verified against the open ledger.",
  ],
  [
    "2",
    "Candidate resolution",
    "The ledger narrows down an evidence ladder: exact reference, purchase order, OCR-repaired reference, amount-plus-payer, fuzzy payer name, then the customer's whole ledger. Duplicate wires are fingerprinted (payer, amount, currency) and stopped before matching. Candidates are hard-filtered to the payment's own currency and, when the wire states one, its subsidiary - unless the tenant's policy carries FX rates for both currencies, in which case foreign invoices enter as converted copies at those rates.",
  ],
  [
    "3",
    "MILP solver (HiGHS via scipy)",
    "Subset selection under the cash conservation equality with the age-weighted, penalty-priced objective from the Methodology page. A Rust subset-sum kernel runs inside the solve path: it decides a payment only when its exact set is provably unique (bounded at 18 candidates), and every set the MILP returns is re-verified in exact integer cents before it is believed. Kernel and Python path are equivalence-tested on 203 shared cases.",
  ],
  [
    "4",
    "Deduction intelligence",
    "Claims are classified to the ERP reason taxonomy, z-scored against the payer's own judged claim history in the workspace, and decided by the expected-value dispute rule. Unearned discounts are claimed back as their own reason code.",
  ],
  [
    "5",
    "Posting + exceptions",
    "Exact, confident matches auto-post: their invoices settle and their SAP clearing document is issued in the same moment. Everything else becomes a proposed match (which issues its document on approval) or a tracked exception with counterfactuals. Approving an unmatched wire parks it in suspense with no document at all. All of it lands in the audit log with the run's policy snapshot.",
  ],
  [
    "6",
    "Insight layer",
    "Delay and validity models (scikit-learn, time-ordered holdout) work from the post-reconciliation residual ledger only - settled and part-paid money is never double-counted - and feed the forecast bands (400-simulation Monte Carlo, P10/P50/P90) and the collections queue; the copilot answers only from these stored records.",
  ],
];

const COMPONENTS: [string, string][] = [
  [
    "API + product UI",
    "FastAPI (Python 3.12); the UI is a React single-page app (the pre-migration vanilla build remains available at /vanilla/); OpenAPI at /docs",
  ],
  [
    "Solvers",
    "scipy.optimize.milp (HiGHS) + Rust kernel in the solve path for provably-unique exact sets (equivalence-tested on 203 cases)",
  ],
  [
    "Data",
    "Dual-mode storage: SQLite (WAL) database-per-tenant by default; PostgreSQL, one schema per tenant, when SLATEMATCH_DATABASE_URL is set - one code path, the dialect translated at the seam",
  ],
  [
    "Tenancy + security",
    "Hashed API keys (shown once), RBAC viewer / analyst / approver / admin, per-key rate limiting",
  ],
  [
    "Observability",
    "Request IDs, structured JSON logs, Prometheus /metrics, /health and /ready gates",
  ],
  [
    "AI layer",
    "Gemini extraction and drafting when configured by environment (model and timeout set outside the code); a deterministic fallback otherwise, with the active mode and last error shown on the diagnostics panel - never presented as AI when it is not. Bank details are redacted from the copy sent to the model, and its reply is schema-bound.",
  ],
  [
    "Mail",
    "SMTP when a mailbox is configured; until then every send records as recorded_not_sent with the reason, in the Outbox - a mail is shown as sent only when a server accepted it",
  ],
  [
    "Documents + export",
    "The product documentation pack is served in-product from the same files this page links to; the month-end bundle exports as a clean PDF (fpdf2) or raw JSON, generated from stored records",
  ],
  [
    "Explainers",
    "Explanations survive only where they earn their place under the product's explanation diet: a derived number's formula, an action's consequence, a limitation or true status, decision evidence, or a recovery step",
  ],
  [
    "Packaging",
    "Multi-stage Docker (Rust kernel stage, web build stage, slim Python runtime with the test suite and tesseract OCR), non-root; deploys to AWS ECS Fargate behind an Application Load Balancer",
  ],
];

const TOPOLOGY: [string, string][] = [
  [
    "Browser → AWS Application Load Balancer",
    "The web UI and the JSON API are served by the same container; the load balancer fronts the ECS service on its ap-south-1 hostname.",
  ],
  [
    "ALB → ECS task (Fargate, 0.25 vCPU / 1 GB, ap-south-1)",
    "Desired count 1 for this demo posture. The health-check path is /health; /ready gates traffic on the control database, data directory and models.",
  ],
  [
    "Container → per-tenant stores (SQLite files, or Postgres schemas)",
    "One store per tenant - a database file on the EFS volume mounted into the task, or a schema in Postgres - so the ledger survives task replacement; the migration script copies an existing SQLite data directory into Postgres when the deployment cuts over.",
  ],
  [
    "CI: GitHub push → Actions → ECR → Update service",
    "Every push to main first runs the test gate (the full pytest suite plus the Rust kernel's cargo tests); only a green run builds the multi-stage image and pushes it to ECR, tagged with the commit SHA as well as latest, and the service update rolls it out. Logs stream to CloudWatch; /metrics exposes Prometheus counters.",
  ],
];

const DATA_MODEL: [string, string][] = [
  [
    "tenants / api_keys (control DB)",
    "Tenant registry and SHA-256-hashed API keys with roles. Raw keys are shown once at issue and never stored.",
  ],
  [
    "invoices / payments (per tenant)",
    "The canonical ledger and the staged payments of the active case - the shared workspace every view reads.",
  ],
  [
    "runs / run_steps / matches / exceptions",
    "Every batch, its streamed step log, the solver's decisions with full derivations, and the payments the agent refused to settle alone.",
  ],
  [
    "audit_log",
    "Append-only record of consequential actions: runs, approvals, policy changes, case loads. Entries carry a SHA-256 content fingerprint over their own contents; entries recorded before fingerprints shipped show none.",
  ],
  [
    "aliases / column_mappings",
    "Learned payer aliases and remembered CSV header mappings per source fingerprint - the transform layer's memory.",
  ],
  [
    "workspace_meta",
    "The active case: its identity, source, staged expectations for grading, and any case policy override - the record that keeps every page on the same case.",
  ],
  [
    "tenant_policies",
    "Each tenant's governance thresholds (automation bar, maker-checker limit, tolerances, dispute economics, partial-allocation mode, FX rates), versioned into every run's snapshot.",
  ],
  [
    "outbox",
    "Every mail the product composed or sent, with its true status: sent, failed, or recorded_not_sent with the reason.",
  ],
];

const SCALING: [string, string][] = [
  [
    "Why doesn't the MILP explode?",
    "The solver never sees the ledger. Candidate resolution prunes each payment to a payer-scoped shortlist first (references, PO, OCR-repaired references, amount-plus-payer, fuzzy payer, whole ledger), so the NP-hard core runs on a handful of invoices per payment, not thousands.",
  ],
  [
    "Raw vs pruned",
    "A 20-invoice pool has 2^20 (about a million) raw subsets; resolution prunes each payment to a short, payer-scoped shortlist first, and HiGHS branch-and-bound closes the rest. The enumeration and kernel fast paths are bounded at 18 candidates, which keeps the worst case small and provable.",
  ],
  [
    "Latency evidence",
    "Solver time is stored on every match; the Dashboard ribbon averages it for the latest run. The live run streams each payment's solve time as it happens.",
  ],
  [
    "Equivalence",
    "The Rust kernel and the Python solver are proven identical on 203 shared cases; neither is trusted on its own say-so.",
  ],
];

const AI_PLUGS: [string, string][] = [
  [
    "Remittance parser",
    "Gemini extraction with schema-bound JSON when a server key is configured; deterministic extractor otherwise. Either way, a verifier checks every reference against the ledger before anything is trusted.",
  ],
  [
    "Copilot",
    "Answers only from the product's own records, with citations. Questions outside the records are refused, not improvised.",
  ],
  [
    "Delay and validity models",
    "Trained ML (holdout-graded) predicts payment timing and deduction validity; it informs forecasts and triage. It decides nothing about posting.",
  ],
  [
    "Solver and policy",
    "No AI. Posting decisions are exact mathematics under policy. That separation - AI proposes, math decides - is the product's core safety property.",
  ],
  [
    "Current status",
    "Which parser runs is set by the server environment, not the code: Gemini when a key and model are configured - as on the live deployment - and the deterministic parser otherwise. Agent Health and the Upload Center always show the active mode, and switching needs no other change.",
  ],
];

function TwoCol({
  head,
  rows,
  firstW,
}: {
  head: [string, string];
  rows: [string, string][];
  firstW?: string;
}) {
  return (
    <DataTable
      head={
        <>
          <Th className={firstW}>{head[0]}</Th>
          <Th>{head[1]}</Th>
        </>
      }
    >
      {rows.map(([a, b]) => (
        <Row key={a}>
          <Td>{a}</Td>
          <Td>{b}</Td>
        </Row>
      ))}
    </DataTable>
  );
}

export default function Architecture() {
  const [diag, setDiag] = useState<Diagnostics | null>(null);

  const load = useCallback(async () => {
    const d = await api<Diagnostics>("/api/v1/diagnostics").catch(() => null);
    setDiag(d);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="flex flex-col gap-4">
      <ViewHead
        eyebrow="EVALS & ARCHITECTURE — 13 / ARCHITECTURE"
        title="Architecture"
        purpose="The deployed system, layer by layer."
        onRefresh={load}
      />

      <Rise i={0}>
        <Panel
          title="Kernel and test suite health"
          sub="Checked live on this server - the Rust kernel's presence, a live equivalence probe against the Python reference, and the repository suite that CI runs on every push."
        >
          {diag ? (
            <div className="mt-2 flex flex-col">
              {(
                [
                  [
                    "Rust kernel (rust-kernel, via rust_bridge.py)",
                    diag.rust_kernel.present ? (
                      <Pill kind="ok">ACTIVE</Pill>
                    ) : (
                      <Pill kind="warn">NOT IN THIS DEPLOYMENT</Pill>
                    ),
                  ],
                  ["Kernel equivalence", probeText(diag)],
                  ["Equivalence suite", diag.rust_kernel.equivalence_suite],
                  [
                    "MILP solver",
                    `${diag.milp.solver} - ${diag.milp.exact_recheck}`,
                  ],
                  [
                    "Repository test suite",
                    <>
                      <b>{diag.test_suite.module_count}</b> test modules -{" "}
                      {diag.test_suite.ci}
                    </>,
                  ],
                  [
                    "Document store",
                    <>
                      The product documents in the header are read live from{" "}
                      <span className="font-mono">docs/</span> in this
                      deployment
                    </>,
                  ],
                ] as [string, React.ReactNode][]
              ).map(([k, v]) => (
                <div
                  key={k}
                  className="flex justify-between gap-4 py-2 border-t border-white/[0.05] first:border-t-0 text-[13px]"
                >
                  <b className="shrink-0">{k}</b>
                  <span className="text-right">{v}</span>
                </div>
              ))}
            </div>
          ) : (
            <Loading label="Loading live diagnostics" />
          )}
        </Panel>
      </Rise>

      <Rise i={1}>
        <Panel title="Request path of one payment">
          <DataTable
            head={
              <>
                <Th className="w-[60px]">Step</Th>
                <Th className="w-[260px]">Stage</Th>
                <Th>What happens</Th>
              </>
            }
          >
            {REQUEST_PATH.map(([n, stage, what]) => (
              <Row key={n}>
                <Td>{n}</Td>
                <Td>{stage}</Td>
                <Td>{what}</Td>
              </Row>
            ))}
          </DataTable>
        </Panel>
      </Rise>

      <div className="grid gap-4 xl:grid-cols-2 items-start">
        <Rise i={2}>
          <Panel title="Platform components">
            <TwoCol head={["Component", "Technology"]} rows={COMPONENTS} />
          </Panel>
        </Rise>
        <Rise i={3}>
          <Panel title="Design rules that hold the system together">
            <div className="text-[13.5px] leading-[1.7] mt-2 flex flex-col gap-2">
              <p className="m-0">
                <b>1. AI proposes, math decides.</b> No LLM output can post
                cash; it can only propose fields that deterministic
                components verify.
              </p>
              <p className="m-0">
                <b>2. Money is integer cents.</b> No floats anywhere near a
                posting; residuals are exact, never rounding artefacts.
              </p>
              <p className="m-0">
                <b>3. Every decision carries its derivation.</b> If a number
                cannot be recomputed from records the product shows, it is
                not shown.
              </p>
              <p className="m-0">
                <b>4. Exceptions are a workflow, not a failure.</b> The tail
                is where analysts earn their keep, so it is designed
                first-class: counterfactuals, recommended actions, audit
                trail.
              </p>
              <p className="m-0">
                <b>5. Policy is configuration.</b> Thresholds that change
                behaviour live in tenant policy, versioned with each run -
                never buried in code.
              </p>
            </div>
          </Panel>
        </Rise>
      </div>

      <Rise i={4}>
        <Panel title="Deployment topology - this exact demo">
          <TwoCol head={["Hop", "What happens"]} rows={TOPOLOGY} firstW="w-[260px]" />
        </Panel>
      </Rise>

      <Rise i={5}>
        <Panel title="Data model">
          <TwoCol head={["Table", "What it holds"]} rows={DATA_MODEL} firstW="w-[260px]" />
        </Panel>
      </Rise>

      <div className="grid gap-4 xl:grid-cols-2 items-start">
        <Rise i={6}>
          <Panel title="Scaling the solver">
            <TwoCol head={["Question", "Answer"]} rows={SCALING} />
          </Panel>
        </Rise>
        <Rise i={7}>
          <Panel title="Where AI plugs in - and where it never does">
            <TwoCol head={["Component", "Role of AI"]} rows={AI_PLUGS} firstW="w-[170px]" />
          </Panel>
        </Rise>
      </div>
    </div>
  );
}
