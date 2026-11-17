import Panel from "../ui/Panel";
import ViewHead from "../ui/ViewHead";
import DataTable, { Row, Td, Th } from "../ui/DataTable";
import { Rise } from "../ui/motion";

/* Product Thinking (view 14): the React port of vanilla's Product
   Thinking section - success criteria, the four-cell product
   thesis, and the honestly labelled roadmap. One roadmap line is
   updated from vanilla: bank-file ingestion (BAI2, MT940,
   camt.054) shipped in the enterprise build, so it no longer
   reads as a gap. */

const CRITERIA: [string, string, string][] = [
  [
    "Invoice-line touchless rate",
    "Above 80% (top third of the market)",
    "Dashboard impact panel, from stored runs",
  ],
  [
    "Median market band (Hackett 2025)",
    "70% auto-match is the market median - the line to beat",
    "Shown beside our measured rate, never blended with it",
  ],
  [
    "Exception ageing",
    "Every exception carries an owner action the day it appears",
    "Run view exception panel + agent brief",
  ],
  [
    "Deduction net recovery",
    "Auto-dispute only when proof of delivery is clean and expected recovery clears the $100 minimum; the rest route to an analyst",
    "Dispute desk, expected recovery per claim",
  ],
  [
    "Cost per remittance",
    "Vendor claim for manual processing is up to $7.82 - automation must cost a fraction",
    "Impact panel hours-returned estimate",
  ],
];

const THESIS: [string, string, string][] = [
  [
    "01/",
    "The problem",
    "Cash application is a conservation problem with an information problem on top: every cent received must land somewhere auditable, but the evidence arrives as messy remittance text, short pays and silent deductions. Incumbent platforms advertise 85 to 99 percent auto-match, yet implementations run for months and the exception tail still eats the analyst day. The tail is the product opportunity.",
  ],
  [
    "02/",
    "The design rule",
    "AI proposes, math decides. Probabilistic components (LLM parsing, ML delay and validity models) extract and score; deterministic components (the MILP solver under a cash conservation equation, the policy engine, the expected-value dispute rule) make every posting decision. Anything unreconciled becomes a tracked exception with counterfactuals - never a silent write-off.",
  ],
  [
    "03/",
    "The wedge",
    "A pilot called the replay: send us your last 90 days of payments and open invoices as CSV. SlateMatch replays them and shows, cent by cent, what would have auto-posted, what would have been disputed, and what your team touched that it should not have had to. Proof before platform.",
  ],
  [
    "04/",
    "North-star metric",
    "Touchless cash rate at $0 residual. Supporting: match accuracy on labelled evaluations, residual dollars, exception ageing, dispute recovery value, solver latency.",
  ],
];

export default function Product() {
  return (
    <div className="flex flex-col gap-4">
      <ViewHead
        eyebrow="EVALS & ARCHITECTURE — 14 / PRODUCT THINKING"
        title="Product Thinking"
        purpose="Product rationale, success criteria and roadmap."
        onRefresh={() => window.location.reload()}
      />

      <Rise i={0}>
        <Panel
          title="Success criteria this product would contract on"
          sub="HighRadius now sells on outcomes, settled against Mutually Agreed Success Criteria. These are the criteria SlateMatch would sign, each measurable inside this product today:"
        >
          <DataTable
            head={
              <>
                <Th>Criterion</Th>
                <Th>Target</Th>
                <Th>Where it is measured</Th>
              </>
            }
          >
            {CRITERIA.map(([c, t, w]) => (
              <Row key={c}>
                <Td>{c}</Td>
                <Td>{t}</Td>
                <Td>{w}</Td>
              </Row>
            ))}
          </DataTable>
        </Panel>
      </Rise>

      <Rise i={1}>
        <Panel title="Product thesis" className="max-w-[860px]">
          <div className="grid gap-4 sm:grid-cols-2 mt-2">
            {THESIS.map(([num, label, body]) => (
              <div key={num}>
                <div className="font-mono text-[12px] text-blue2">{num}</div>
                <div className="font-display text-[14px] font-semibold mt-1">
                  {label}
                </div>
                <p className="text-[13.5px] leading-[1.65] text-mut mt-1 mb-0">
                  {body}
                </p>
              </div>
            ))}
          </div>
          <p className="text-[13.5px] leading-[1.65] mt-4">
            <b>Roadmap, honestly labelled.</b> A live ERP on the other
            end of the write-back (the SAP, Oracle and NetSuite
            envelopes are built and validated against a simulated
            connection), SOC 2, and a background job queue with
            multi-worker serving are the known table-stakes gaps for
            enterprise sale. Bank-file ingestion (BAI2, MT940,
            camt.054) shipped in the enterprise build, and dual-mode
            Postgres storage shipped with the moat build - neither is
            a gap any longer. This build covers the decision core
            those integrations feed: matching, deductions, forecast,
            collections, evaluation and audit.
          </p>
          <p className="text-[13.5px] leading-[1.65] mb-0">
            <b>Honesty labels.</b> All data in this workspace is synthetic
            and labelled as such. Market figures quoted anywhere in this
            product are vendor claims used as context, never this
            product's results. Win probabilities in deduction intelligence
            are transparent heuristics, and the UI says so where they
            appear.
          </p>
        </Panel>
      </Rise>

      <p className="text-[12px] text-mut m-0">
        SlateMatch is an independent product built by C. Harsha Vardhana
        Reddy. It is not affiliated with any ERP or receivables vendor.
      </p>
    </div>
  );
}
