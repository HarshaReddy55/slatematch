"""Seed scenario: one realistic day of receipts, at enterprise scale.

Deliberately NOT a perfect book. Of 16 payments, 10 post themselves,
4 are held for a human with a stated reason (a partial, an overpayment,
and two clean wires above the maker-checker limit), 1 is a duplicate the
guard blocks, and 1 arrives from an unknown payer with no remittance and
matches nothing - the exception a chase email exists for. Two deductions
ride along: one clean-POD shortage worth disputing, one inside tolerance
that is written off. Touchless lands near the market median on purpose -
the product's value is visible in what it does with the other payments.
"""
from domain import Invoice, Payment

def seed_invoices():
    return [
        Invoice("INV-1001", "Apex Manufacturing", "Apex Manufacturing", 3000000, po_number="PO-11", age_days=40, due_in_days=-40),
        Invoice("INV-1002", "Apex Manufacturing", "Apex Manufacturing", 2200000, po_number="PO-12", age_days=5, due_in_days=-5),
        Invoice("INV-1003", "Apex Manufacturing", "Apex Manufacturing", 5140000, po_number="PO-13", age_days=30, due_in_days=-30),
        Invoice("INV-1004", "BluePeak Electronics", "BluePeak Electronics", 5850000, po_number="PO-21", discount_rate=0.02, age_days=25, due_in_days=5),
        Invoice("INV-1005", "BluePeak Electronics", "BluePeak Electronics", 3675000, po_number="PO-22", age_days=12, due_in_days=-12),
        Invoice("INV-1006", "Cascade Chemicals", "Cascade Chemicals", 9640000, po_number="PO-31", age_days=18, due_in_days=-18),
        Invoice("INV-1007", "Cascade Chemicals", "Cascade Chemicals", 8890000, po_number="PO-32", age_days=50, due_in_days=-50),
        Invoice("INV-1008", "Summit Logistics", "Summit Logistics", 4480000, po_number="PO-41", age_days=8, due_in_days=6),
        Invoice("INV-1009", "Cascade Chemicals", "Cascade Chemicals", 13500000, po_number="PO-33", age_days=52, due_in_days=-52),
        Invoice("INV-1010", "HarborView Pharma", "HarborView Pharma", 1825000, po_number="PO-51", age_days=15, due_in_days=-3),
        Invoice("INV-1011", "Northgate Foods", "Northgate Foods", 5400000, po_number="PO-61", discount_rate=0.02, age_days=22, due_in_days=9),
        Invoice("INV-1012", "Vertex Industrial", "Vertex Industrial", 3860000, po_number="PO-77", age_days=33, due_in_days=-21),
        Invoice("INV-1013", "Silverline Apparel", "Silverline Apparel", 2990000, po_number="PO-71", age_days=14, due_in_days=-2),
        Invoice("INV-1014", "Keystone Healthcare", "Keystone Healthcare", 2140000, po_number="PO-81", age_days=27, due_in_days=-13),
        Invoice("INV-1015", "Keystone Healthcare", "Keystone Healthcare", 1790000, po_number="PO-82", age_days=9, due_in_days=3),
        Invoice("INV-1016", "Pacific Rim Components", "Pacific Rim Components", 1248000, po_number="PO-91", age_days=6, due_in_days=9),
        Invoice("INV-1017", "Atlas Building Materials", "Atlas Building Materials", 2730000, po_number="PO-95", age_days=19, due_in_days=-7),
        Invoice("INV-1018", "Northgate Foods", "Northgate Foods", 21000000, po_number="PO-62", age_days=4, due_in_days=25),
        Invoice("INV-1019", "Vertex Industrial", "Vertex Industrial", 985000, po_number="PO-78", age_days=61, due_in_days=-44),
    ]

def seed_payments():
    return [
        # split: 30000 + 22000 = 52000 across two invoices, references given
        Payment("P1", "Apex Manufacturing", 5200000, remittance_text="Wire from Apex Manufacturing for INV-1001 and INV-1002"),
        # PO rescue: the mail's invoice ref was wrong; PO-13 points at INV-1003
        Payment("P2", "Apex Manufacturing", 5140000, references=["PO-13"], remittance_text="Payment ref PO-13 (invoice ref in mail was wrong)"),
        # discount + disputable deduction: 58500 - 1170 (2%) - 4200 shortage, POD clean
        Payment("P3", "BluePeak Electronics", 5313000, claimed_deduction_cents=420000, deduction_reason_raw="shortage on delivery",
                pod_verified_clean=True, remittance_text="BluePeak wire less 2% discount, less deduction $4,200 shortage"),
        # partial: pays 20000 of a 36750 invoice - held, residual explained
        Payment("P4", "BluePeak Electronics", 2000000, references=["INV-1005"]),
        # duplicate of P1 (same payer + amount fingerprint) - blocked by the guard
        Payment("P5", "Apex Manufacturing", 5200000),
        # unknown payer, no remittance, matches nothing - chase email territory.
        # The amount is deliberately smaller than every open invoice: with a
        # seven-figure wire the solver would propose some partial subset of
        # strangers' invoices, which is exactly what must not happen here.
        Payment("P6", "TransGlobal Trading", 485000),
        # clean big wire: exact, but above the $60,000 maker-checker hold - approval
        Payment("P7", "Cascade Chemicals", 9640000, references=["INV-1006"]),
        # no-remittance exact amount for Summit Logistics (payer + amount path)
        Payment("P8", "Summit Logistics", 4480000),
        # tolerance deduction: $15 rounding claim on an $18,250 invoice - written off
        Payment("P9", "HarborView Pharma", 1823500, claimed_deduction_cents=1500, deduction_reason_raw="rounding difference",
                references=["INV-1010"], remittance_text="Wire for INV-1010 less $15 rounding"),
        # discount taken correctly: 54000 less 2%
        Payment("P10", "Northgate Foods", 5292000, references=["INV-1011"], remittance_text="Wire for INV-1011 less 2% early-pay discount"),
        # OCR rescue: the scanned PO reads P0-77 (zero) for PO-77
        Payment("P11", "Vertex Industrial", 3860000, references=["P0-77"], remittance_text="Scanned remittance: P0-77 (OCR)"),
        # unearned discount claim: $600 taken, no discount terms - routed to an analyst
        Payment("P12", "Silverline Apparel", 2930000, claimed_deduction_cents=60000, deduction_reason_raw="discount taken at dock",
                references=["INV-1013"], remittance_text="Wire for INV-1013 less $600 discount taken at dock"),
        # clean multi-invoice wire
        Payment("P13", "Keystone Healthcare", 3930000, references=["INV-1014", "INV-1015"], remittance_text="Wire for INV-1014 and INV-1015"),
        # overpayment: 13000 against a 12480 invoice - held with the residual shown
        Payment("P14", "Pacific Rim Components", 1300000, references=["INV-1016"]),
        # clean single wire
        Payment("P15", "Atlas Building Materials", 2730000, references=["INV-1017"]),
        # blind big wire from a known payer: exact, above the hold - approval
        Payment("P16", "Cascade Chemicals", 8890000),
    ]

GROUND_TRUTH = {  # payment_id -> set of invoice_ids a correct matcher should select (primary case)
    "P1": {"INV-1001", "INV-1002"}, "P2": {"INV-1003"}, "P3": {"INV-1004"},
    "P7": {"INV-1006"}, "P8": {"INV-1008"}, "P10": {"INV-1011"}, "P11": {"INV-1012"},
    "P13": {"INV-1014", "INV-1015"}, "P15": {"INV-1017"}, "P16": {"INV-1007"},
}
