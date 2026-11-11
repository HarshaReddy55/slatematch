"""Use-case library: full working datasets, not toy rows.

Every pack is a complete case built to be LOADED into the shared workspace:
a realistic open ledger (15-20 invoices across several enterprise customers,
purchase orders, discount terms, overdue and current rows) and a payment
batch (10-14 payments) of the kind a lockbox delivers in a morning. Inside
that ordinary traffic sits one hero payment that exercises the mechanism the
pack exists to prove. The pack states the hero's correct outcome up front in
`expect`; loading the pack puts the whole dataset into the workspace, so the
Dashboard, Ledger, Run, Approvals, Forecast, Collections and Copilot all work
on the same case, and the run is graded against the stated expectations.

Surrounding traffic is ordinary morning traffic for customers OTHER than
the hero payer, so it can never contaminate the hero payment's candidate
pool: mostly exact single-invoice payments with explicit references, plus
its own small mess - a partial payment, a rounding deduction inside the
write-off tolerance, and one wrong invoice reference the payer-plus-amount
rung has to rescue. It exists so the case behaves like a real portfolio
when loaded - a believable touchless rate, a forecast with substance, a
collections queue with real priorities.
"""
from domain import Invoice, Payment

def _inv(sid, n, customer, cents, **kw):
    return Invoice(f"{sid}-INV-{n}", customer, customer, cents, **kw)

def _pay(sid, n, payer, cents, **kw):
    return Payment(f"{sid}-P{n}", payer, cents, **kw)

# Traffic rows: (customer, gross_cents, po, age_days, due_in_days, discount_rate, pay_mode)
# pay_mode: 0 = stays open (forecast/collections substance), 1 = paid in full by
# an exact referenced wire, 2 = paid net of its early-pay discount.
_TRAFFIC_A = [
    ("Northgate Foods", 1845000, "PO-3101", 34, -12, 0.0, 1),
    ("Northgate Foods", 962500, "PO-3102", 12, 6, 0.0, 1),
    ("Northgate Foods", 2730000, "PO-3103", 47, -20, 0.0, 0),
    ("HarborView Pharma", 5120000, "PO-2210", 26, -4, 0.0, 1),
    ("HarborView Pharma", 1275000, "PO-2211", 8, 14, 0.02, 2),
    ("HarborView Pharma", 3340000, "PO-2212", 55, -31, 0.0, 0),
    ("Vertex Industrial", 764000, "PO-1180", 19, 2, 0.0, 1),
    ("Vertex Industrial", 1508000, "PO-1181", 41, -9, 0.0, 1),
]
_TRAFFIC_B = [
    ("Silverline Apparel", 2215000, "PO-5520", 29, -6, 0.0, 1),
    ("Silverline Apparel", 845000, "PO-5521", 6, 18, 0.0, 1),
    ("Silverline Apparel", 1690000, "PO-5522", 63, -40, 0.0, 0),
    ("Keystone Healthcare", 4480000, "PO-6630", 22, -2, 0.0, 1),
    ("Keystone Healthcare", 1132000, "PO-6631", 15, 9, 0.0, 1),
    ("Pacific Rim Components", 2960000, "PO-7740", 38, -15, 0.0, 1),
    ("Pacific Rim Components", 587500, "PO-7741", 4, 21, 0.0, 0),
]
_TRAFFIC_C = [
    ("Atlas Building Materials", 3725000, "PO-9010", 31, -11, 0.0, 1),
    ("Atlas Building Materials", 1940000, "PO-9011", 17, 4, 0.0, 1),
    ("Atlas Building Materials", 6210000, "PO-9012", 52, -27, 0.0, 0),
    ("Northgate Foods", 1260000, "PO-3110", 24, -3, 0.0, 1),
    ("Northgate Foods", 3015000, "PO-3111", 44, -18, 0.0, 1),
    ("HarborView Pharma", 2540000, "PO-2220", 11, 7, 0.0, 1),
    ("HarborView Pharma", 918000, "PO-2221", 58, -36, 0.0, 0),
]

def _traffic(sid, *templates):
    invs, pays = [], []
    n, pn = 11, 21
    for tpl in templates:
        for (cust, cents, po, age, due, disc, mode) in tpl:
            inv = _inv(sid, n, cust, cents, po_number=po, age_days=age, due_in_days=due, discount_rate=disc)
            invs.append(inv)
            if mode:
                amt = cents - round(cents * disc) if mode == 2 else cents
                remit = (f"Wire for {inv.invoice_id} less {int(disc*100)}% early-pay discount" if mode == 2
                         else f"Wire for {inv.invoice_id}")
                pays.append(_pay(sid, pn, cust, amt, references=[inv.invoice_id], remittance_text=remit))
                pn += 1
            n += 1
    # Real mornings are not clean, so the traffic carries ordinary mess of
    # its own (all on traffic customers, never the hero payer): one payer
    # pays only 60% of an invoice, one takes a small rounding deduction
    # inside the write-off tolerance, and one quotes the wrong invoice
    # reference - the first traffic invoice, which its own payment settles
    # earlier in the batch, so the reference is already gone when this wire
    # is processed and the payer-plus-amount rung has to rescue it.
    if len(pays) > 2:
        pays[2].amount_cents = round(pays[2].amount_cents * 0.6)
    if len(pays) > 5:
        pays[5].claimed_deduction_cents = 1200
        pays[5].amount_cents -= 1200
        pays[5].deduction_reason_raw = "rounding"
    if len(pays) > 8 and invs:
        pays[8].references = [invs[0].invoice_id]
    return invs, pays

def _case(hero_invs, hero_pays, *templates):
    ti, tp = _traffic(hero_invs[0].invoice_id.split("-")[0], *templates) if hero_invs else ([], [])
    return (list(hero_invs) + ti, list(hero_pays) + tp)

SCENARIOS = [
    {
        "id": "split-exact",
        "title": "Split payment across two invoices",
        "story": "Apex Manufacturing sends one $20,000 wire that covers two open invoices ($12,000 + $8,000). A single $20,000 invoice from Apex is also open, as a decoy. A simple matcher that looks at amounts alone grabs the decoy. The optimiser must choose the pair instead, because policy settles the oldest work first. The wire arrives inside a normal morning batch: 18 open invoices across seven customers, and eleven other payments that should simply post.",
        "shows": "How the engine picks the right set of invoices for one payment, under a strict rule that every cent must be accounted for - shown inside a realistic batch, not on three toy rows.",
        "build": lambda: _case(
            [_inv("S1", 1, "Apex Manufacturing", 1200000, po_number="PO-11", age_days=40, due_in_days=-40),
             _inv("S1", 2, "Apex Manufacturing", 800000, po_number="PO-12", age_days=5, due_in_days=-5),
             _inv("S1", 3, "Apex Manufacturing", 2000000, po_number="PO-13", age_days=30, due_in_days=-30)],
            [_pay("S1", 1, "Apex Manufacturing", 2000000, remittance_text="Wire covering INV-1 and INV-2")],
            _TRAFFIC_A, _TRAFFIC_B),
        "expect": {"S1-P1": {"status": "OPTIMAL_EXACT_MATCH", "auto_posted": True, "invoices": {"S1-INV-1", "S1-INV-2"}}},
    },
    {
        "id": "po-wins",
        "title": "Wrong invoice reference, right purchase order",
        "story": "A $20,000 Apex wire names the wrong invoice in its remittance, but it carries purchase order PO-13. Matching on the reference alone would post the money against the wrong invoice. The engine checks the PO instead and posts to the invoice that PO belongs to. Around it sits a full working ledger - 16 open invoices, seven customers - and the usual clean wires, which the rescue must not disturb.",
        "shows": "The order the engine tries evidence in: first the reference, then the PO, then payer and amount - and why that order matters, at working scale.",
        "build": lambda: _case(
            [_inv("S2", 1, "Apex Manufacturing", 2000000, po_number="PO-13", age_days=30, due_in_days=-30),
             _inv("S2", 2, "Apex Manufacturing", 2000000, po_number="PO-14", age_days=10, due_in_days=-10)],
            [_pay("S2", 1, "Apex Manufacturing", 2000000, references=["PO-13"], remittance_text="Payment ref PO-13 (invoice ref in mail was wrong)")],
            _TRAFFIC_B, _TRAFFIC_C),
        "expect": {"S2-P1": {"status": "OPTIMAL_EXACT_MATCH", "auto_posted": True, "invoices": {"S2-INV-1"}}},
    },
    {
        "id": "discount-deduction-dispute",
        "title": "Early-pay discount plus a shortage deduction",
        "story": "BluePeak Electronics owes $48,500 on an invoice with 2 percent early-pay terms. It pays $43,330: the $970 discount taken, plus a $4,200 deduction claimed for a shortage. Proof of delivery is clean. The engine must account for every cent AND judge the deduction. On clean proof of delivery the win probability is 0.94, so the expected recovery is $3,903 after the $45 cost of fighting - above the $100 threshold, so the dispute claim is raised on its own. The rest of the batch is an ordinary day: 16 invoices on the ledger, twelve wires, one claim worth fighting among them.",
        "shows": "How deductions are judged: the reason is classified, the evidence sets the win probability, and a simple value test decides whether to dispute.",
        "build": lambda: _case(
            [_inv("S3", 1, "BluePeak Electronics", 4850000, po_number="PO-21", discount_rate=0.02, age_days=25, due_in_days=-25)],
            [_pay("S3", 1, "BluePeak Electronics", 4333000, claimed_deduction_cents=420000,
                  deduction_reason_raw="shortage on delivery", pod_verified_clean=True,
                  remittance_text="Wire less 2% discount, less $4,200 shortage deduction")],
            _TRAFFIC_A, _TRAFFIC_C),
        "expect": {"S3-P1": {"status": "OPTIMAL_EXACT_MATCH", "auto_posted": True, "invoices": {"S3-INV-1"}, "deduction_action": "AUTO_GENERATE_DISPUTE_CLAIM", "erp_reason_code": "RC-02"}},
    },
    {
        "id": "duplicate-guard",
        "title": "The same wire arrives twice",
        "story": "Bank feeds and lockbox files do resend payments. In this batch, Cascade Chemicals' $36,750 wire appears twice. The first copy posts cleanly against its invoice. The second must be stopped as a duplicate and sent to a human - never posted a second time against other invoices. The eleven ordinary wires around it, on a ledger of 16 open invoices, post untouched.",
        "shows": "How each payment is fingerprinted and checked for duplicates inside the batch, before any matching happens.",
        "build": lambda: _case(
            [_inv("S4", 1, "Cascade Chemicals", 3675000, po_number="PO-31", age_days=18, due_in_days=-18)],
            [_pay("S4", 1, "Cascade Chemicals", 3675000, references=["S4-INV-1"]),
             _pay("S4", 2, "Cascade Chemicals", 3675000)],
            _TRAFFIC_A, _TRAFFIC_B),
        "expect": {"S4-P1": {"status": "OPTIMAL_EXACT_MATCH", "auto_posted": True, "invoices": {"S4-INV-1"}},
                   "exceptions": {"S4-P2": "DUPLICATE_PAYMENT"}},
    },
    {
        "id": "partial-residual",
        "title": "Partial payment with an unexplained residual",
        "story": "BluePeak Electronics pays $11,000 against an $18,500 invoice and explains nothing. The engine holds the part it can prove for a person's approval, states the $7,500 still unexplained, and raises a review exception that shows what else this cash could have been - instead of quietly writing it off or forcing a wrong match. Everything else in the batch is ordinary traffic on a 16-invoice ledger: ten further wires, partials, a rounding deduction and a wrong reference among them, worked through while one payment waits for a human.",
        "shows": "Part payments: how the engine holds what it can prove for approval, accounts for the rest, and explains its thinking instead of guessing.",
        "build": lambda: _case(
            [_inv("S5", 1, "BluePeak Electronics", 1850000, po_number="PO-22", age_days=12, due_in_days=-12),
             _inv("S5", 2, "BluePeak Electronics", 625000, po_number="PO-23", age_days=3, due_in_days=3)],
            [_pay("S5", 1, "BluePeak Electronics", 1100000, references=["S5-INV-1"])],
            _TRAFFIC_B, _TRAFFIC_C),
        "expect": {"S5-P1": {"status": "PARTIAL_MATCH", "auto_posted": False, "invoices": {"S5-INV-1"}, "residual_cents": -750000},
                   "exceptions": {"S5-P1": "UNRESOLVED_RESIDUAL"}},
    },
    {
        "id": "silent-exact",
        "title": "No remittance at all, exact amount",
        "story": "A $22,400 Summit Logistics wire lands with no remittance text and no references - only a payer name and an amount that exactly equals one open Summit invoice. The engine falls back to payer plus amount and still posts it without a human touching it, recording how it matched for the audit trail. The rest of the ledger is a normal book: 17 open invoices across seven customers, eleven ordinary wires in the same batch.",
        "shows": "What happens when the remittance is missing entirely: the engine works down its list of evidence and still posts, with the path recorded.",
        "build": lambda: _case(
            [_inv("S6", 1, "Summit Logistics", 2240000, po_number="PO-41", age_days=8, due_in_days=6),
             _inv("S6", 2, "Summit Logistics", 960000, po_number="PO-42", age_days=2, due_in_days=12)],
            [_pay("S6", 1, "Summit Logistics", 2240000)],
            _TRAFFIC_A, _TRAFFIC_C),
        "expect": {"S6-P1": {"status": "OPTIMAL_EXACT_MATCH", "auto_posted": True, "invoices": {"S6-INV-1"}}},
    },
    {
        "id": "blind-lockbox-wire",
        "title": "Blind lockbox wire - $1,145,820.00, zero remittance",
        "story": "A seven-figure wire lands from a lockbox file with no remittance text and no references - only the payer name and the amount. The book is full of traps. Six invoices are open for Continental Foodservice. One is $1,145,819.63 - 37 cents short of the wire. One pair misses by 37 cents. One pair overshoots by 55 cents. Only one set equals the wire to the cent. A seventh invoice, for the exact wire amount, belongs to a different customer with a nearly identical name, Continental Foods Inc, and must never be touched. The engine falls back to payer plus exact amount, checks every combination, rejects each trap for a stated reason, and still posts the wire without human help. The case is a $5.65 million open book: 21 invoices, eight customers, eleven payments.",
        "shows": "The last resort of matching, at full scale: payer plus exact amount, every combination checked, exactly one exact set - and the full reasoning shown on the match, with a clear reason for every invoice that was rejected.",
        "build": lambda: _case(
            [_inv("S7", 1, "Continental Foodservice", 25000000, po_number="PO-771", age_days=22, due_in_days=-22),
             _inv("S7", 2, "Continental Foodservice", 114582000, po_number="PO-772", age_days=35, due_in_days=-35),
             _inv("S7", 3, "Continental Foodservice", 48000055, po_number="PO-773", age_days=9, due_in_days=9),
             _inv("S7", 4, "Continental Foodservice", 114581963, po_number="PO-774", age_days=35, due_in_days=-35),
             _inv("S7", 5, "Continental Foodservice", 66582000, po_number="PO-775", age_days=18, due_in_days=9),
             _inv("S7", 6, "Continental Foodservice", 47999963, po_number="PO-776", age_days=27, due_in_days=-12),
             _inv("S7", 7, "Continental Foods Inc", 114582000, po_number="PO-881", age_days=35, due_in_days=-35)],
            [_pay("S7", 1, "Continental Foodservice", 114582000)],
            _TRAFFIC_B, _TRAFFIC_C),
        "expect": {"S7-P1": {"status": "OPTIMAL_EXACT_MATCH", "auto_posted": True, "invoices": {"S7-INV-2"}}},
    },
    {
        "id": "corrupted-ocr-remittance",
        "title": "Corrupted OCR remittance - the PO survives",
        "story": "A $482,190.50 MegaMart Retail wire arrives with a remittance advice damaged by scanning: the invoice references are unreadable garbage. Two open MegaMart invoices carry the exact same amount. The older one is the tempting wrong answer - a matcher that goes by amount or age would post it. One field survived the scan intact: purchase order PO-8841, and it belongs to the younger invoice. The engine must let the surviving evidence outrank age and amount, inside a full 17-invoice ledger and a twelve-payment batch.",
        "shows": "When the paperwork is damaged, the evidence that survived decides: the PO outranks the age and amount rules.",
        "build": lambda: _case(
            [_inv("S8", 1, "MegaMart Retail", 48219050, po_number="PO-8850", age_days=60, due_in_days=-60),
             _inv("S8", 2, "MegaMart Retail", 48219050, po_number="PO-8841", age_days=15, due_in_days=-15)],
            [_pay("S8", 1, "MegaMart Retail", 48219050, references=["PO-8841"],
                  remittance_text="OCR scan: 1NV-88O2 / 1NV-88S1 illegible - PO-8841 legible")],
            _TRAFFIC_A, _TRAFFIC_B),
        "expect": {"S8-P1": {"status": "OPTIMAL_EXACT_MATCH", "auto_posted": True, "invoices": {"S8-INV-2"}}},
    },
    {
        "id": "promo-deduction-spike",
        "title": "Promotional deduction spike - $9,000 claimed on a $312,400 invoice",
        "story": "ShopLine Retail pays $303,400.00 against a $312,400.00 invoice and claims a $9,000 promotional allowance deduction - twenty standard deviations above this payer's usual deductions in the demo profile (z = 20.0). Proof of delivery is clean. The engine matches the payment exactly, flags the claim as an unusual spike, classifies it RC-07 Promotional Allowance, and runs the dispute sums: 0.94 x $9,000 - $45 = $8,415 expected back, far above the $100 threshold, so the dispute claim creates itself. The claim hides in a normal batch: 16 invoices on the ledger, eleven routine wires around it.",
        "shows": "Spotting a claim that is far outside a payer's normal pattern (z-score), and the value test that turns it into a dispute on its own.",
        "build": lambda: _case(
            [_inv("S9", 1, "ShopLine Retail", 31240000, po_number="PO-991", age_days=28, due_in_days=-28)],
            [_pay("S9", 1, "ShopLine Retail", 30340000, claimed_deduction_cents=900000,
                  deduction_reason_raw="promotional allowance per Q3 deal sheet", pod_verified_clean=True,
                  remittance_text="Wire less promotional allowance deduction $9,000")],
            _TRAFFIC_A, _TRAFFIC_C),
        "expect": {"S9-P1": {"status": "OPTIMAL_EXACT_MATCH", "auto_posted": True, "invoices": {"S9-INV-1"},
                             "deduction_action": "AUTO_GENERATE_DISPUTE_CLAIM", "erp_reason_code": "RC-07", "spike": True}},
    },
    {
        "id": "fuzzy-ocr-evidence",
        "title": "Mangled evidence - OCR reference and a fuzzy payer name",
        "story": "A $75,000 wire was scanned, and the purchase order came out as P0-51 - a zero where the letter O belongs - instead of PO-51. The payer name on the wire reads 'APEX MANUFACTURING INC.' while the ledger customer is 'Apex Manufacturing'. Exact matching fails twice over. The engine retries the reference, reading the zero as the letter O, recovers PO-51, and posts to its invoice. If the reference had been destroyed entirely, the fallback is a fuzzy payer-name match (Jaro-Winkler, threshold 0.88), labelled as a fallback. The case loads a full book around the rescue: 16 invoices, seven customers, eleven payments.",
        "shows": "Recovering damaged evidence: references repaired after scanning errors, and fuzzy name matching as a labelled fallback - never a silent guess.",
        "build": lambda: _case(
            [_inv("S10", 1, "Apex Manufacturing", 7500000, po_number="PO-51", age_days=20, due_in_days=-20),
             _inv("S10", 2, "Apex Manufacturing", 4150000, po_number="PO-52", age_days=44, due_in_days=-44)],
            [_pay("S10", 1, "APEX MANUFACTURING INC.", 7500000, references=["P0-51"], remittance_text="Scanned remittance: P0-51 (OCR)")],
            _TRAFFIC_B, _TRAFFIC_C),
        "expect": {"S10-P1": {"status": "OPTIMAL_EXACT_MATCH", "auto_posted": True, "invoices": {"S10-INV-1"}}},
    },
]

def get_scenario(sid):
    for s in SCENARIOS:
        if s["id"] == sid:
            return s
    return None
