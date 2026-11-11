"""SQLite repository layer (WAL). Services never touch SQL directly.
Schema is Postgres-compatible in spirit: plain types, integer cents."""
import sqlite3, json, os, threading, hashlib

SCHEMA = """
CREATE TABLE IF NOT EXISTS invoices(
  invoice_id TEXT PRIMARY KEY, customer TEXT, subsidiary TEXT, gross_cents INTEGER,
  currency TEXT, po_number TEXT, discount_rate REAL, age_days INTEGER, due_in_days INTEGER,
  predicted_delay_days REAL, status TEXT DEFAULT 'OPEN');
CREATE TABLE IF NOT EXISTS payments(
  payment_id TEXT PRIMARY KEY, payer_raw TEXT, payer_customer TEXT, amount_cents INTEGER,
  currency TEXT, claimed_deduction_cents INTEGER, deduction_reason_raw TEXT,
  pod_verified_clean INTEGER, remittance_text TEXT, fingerprint TEXT);
CREATE TABLE IF NOT EXISTS runs(
  run_id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE, kind TEXT, status TEXT,
  policy_json TEXT, created_at TEXT, finished_at TEXT);
CREATE TABLE IF NOT EXISTS run_steps(
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, agent_name TEXT, status TEXT,
  latency_ms REAL, evidence_json TEXT, confidence REAL);
CREATE TABLE IF NOT EXISTS matches(
  match_id TEXT PRIMARY KEY, run_id TEXT, payment_id TEXT, status TEXT,
  solver TEXT, residual_cents INTEGER, confidence REAL, result_json TEXT);
CREATE TABLE IF NOT EXISTS exceptions(
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, payment_id TEXT, kind TEXT,
  severity TEXT, recommended_action TEXT, detail_json TEXT, status TEXT DEFAULT 'OPEN');
CREATE TABLE IF NOT EXISTS audit_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT, action TEXT, entity TEXT,
  entity_id TEXT, payload_json TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS aliases(
  raw_name TEXT PRIMARY KEY, customer TEXT, source TEXT);
CREATE TABLE IF NOT EXISTS column_mappings(
  source_fingerprint TEXT PRIMARY KEY, mapping_json TEXT);
CREATE TABLE IF NOT EXISTS workspace_meta(
  key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS outbox(
  id INTEGER PRIMARY KEY AUTOINCREMENT, to_addr TEXT, subject TEXT, body TEXT,
  kind TEXT, ref_id TEXT, status TEXT, detail TEXT, created_at TEXT);
"""

class Repository:
    def __init__(self, path):
        self.path = path
        self._lock = threading.Lock()
        self._local = threading.local()
        conn = self.conn  # the creating thread's connection; builds the schema
        # Retry the schema build briefly: another process opening the
        # same fresh database at the same moment can hold the write lock
        # for a few milliseconds, and a cold start must never fail on it.
        import time as _time
        for attempt in range(10):
            try:
                conn.execute("PRAGMA journal_mode=WAL")
                conn.executescript(SCHEMA)
                cols = [r[1] for r in conn.execute("PRAGMA table_info(payments)").fetchall()]
                if "references_json" not in cols:
                    conn.execute("ALTER TABLE payments ADD COLUMN references_json TEXT DEFAULT '[]'")
                acols = [r[1] for r in conn.execute("PRAGMA table_info(audit_log)").fetchall()]
                if "fingerprint" not in acols:
                    conn.execute("ALTER TABLE audit_log ADD COLUMN fingerprint TEXT")
                conn.commit()
                break
            except sqlite3.OperationalError:
                if attempt == 9:
                    raise
                _time.sleep(0.05 * (attempt + 1))

    @property
    def conn(self):
        """One SQLite connection per thread. A single shared connection
        corrupts under concurrent requests (sqlite3.InterfaceError: bad
        parameter or other API misuse) because cursors interleave on it.
        WAL mode plus a busy timeout makes per-thread connections to the
        same file safe, and in-memory repositories stay inside the one
        request thread that created them."""
        c = getattr(self._local, "conn", None)
        if c is None:
            c = sqlite3.connect(self.path, check_same_thread=False)
            c.execute("PRAGMA journal_mode=WAL")
            c.execute("PRAGMA busy_timeout=5000")
            self._local.conn = c
        return c

    def _x(self, sql, params=()):
        with self._lock:
            cur = self.conn.execute(sql, params)
            self.conn.commit()
            return cur

    def add_invoice(self, inv):
        self._x("INSERT OR REPLACE INTO invoices VALUES (?,?,?,?,?,?,?,?,?,?, 'OPEN')",
                (inv.invoice_id, inv.customer, inv.subsidiary, inv.gross_cents, inv.currency,
                 inv.po_number, inv.discount_rate, inv.age_days, inv.due_in_days, inv.predicted_delay_days))

    def add_payment(self, pay, fingerprint=""):
        self._x("INSERT OR REPLACE INTO payments(payment_id, payer_raw, payer_customer, amount_cents,"
                " currency, claimed_deduction_cents, deduction_reason_raw, pod_verified_clean,"
                " remittance_text, fingerprint, references_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (pay.payment_id, pay.payer_raw, None, pay.amount_cents, pay.currency,
                 pay.claimed_deduction_cents, pay.deduction_reason_raw,
                 1 if pay.pod_verified_clean else 0, pay.remittance_text, fingerprint,
                 json.dumps(list(getattr(pay, "references", []) or []))))

    def all_payments(self):
        rows = self.conn.execute(
            "SELECT payment_id, payer_raw, amount_cents, currency, claimed_deduction_cents,"
            " deduction_reason_raw, pod_verified_clean, remittance_text, references_json"
            " FROM payments ORDER BY rowid").fetchall()
        from domain import Payment
        out = []
        for r in rows:
            try: refs = json.loads(r[8] or "[]")
            except Exception: refs = []
            out.append(Payment(payment_id=r[0], payer_raw=r[1], amount_cents=r[2], currency=r[3],
                               claimed_deduction_cents=r[4], deduction_reason_raw=r[5] or "",
                               pod_verified_clean=bool(r[6]), remittance_text=r[7] or "",
                               references=refs))
        return out

    def pending_payments(self):
        """Staged payments no run has touched yet (not in matches or exceptions)."""
        done = {r[0] for r in self.conn.execute("SELECT payment_id FROM matches").fetchall()}
        done |= {r[0] for r in self.conn.execute("SELECT payment_id FROM exceptions").fetchall()}
        return [p for p in self.all_payments() if p.payment_id not in done]

    def clear_workspace(self):
        with self._lock:
            for t in ("invoices", "payments", "runs", "run_steps", "matches", "exceptions", "workspace_meta"):
                self.conn.execute(f"DELETE FROM {t}")
            self.conn.commit()

    def set_meta(self, key, value):
        self._x("INSERT OR REPLACE INTO workspace_meta VALUES (?,?)", (key, json.dumps(value)))

    def get_meta(self, key):
        r = self.conn.execute("SELECT value FROM workspace_meta WHERE key=?", (key,)).fetchone()
        if not r: return None
        try: return json.loads(r[0])
        except Exception: return None

    def open_invoices(self, customer=None, subsidiary=None):
        q = "SELECT invoice_id, customer, subsidiary, gross_cents, currency, po_number, discount_rate, age_days, due_in_days, predicted_delay_days FROM invoices WHERE status='OPEN'"
        rows = self.conn.execute(q).fetchall()
        from domain import Invoice
        out = []
        for r in rows:
            inv = Invoice(invoice_id=r[0], customer=r[1], subsidiary=r[2], gross_cents=r[3], currency=r[4],
                          po_number=r[5], discount_rate=r[6], age_days=r[7], due_in_days=r[8], predicted_delay_days=r[9])
            if customer and inv.customer != customer: continue
            if subsidiary and inv.subsidiary != subsidiary: continue
            out.append(inv)
        return out

    def all_invoices(self):
        """Every invoice in the workspace, any status (open or settled)."""
        rows = self.conn.execute(
            "SELECT invoice_id, customer, subsidiary, gross_cents, currency, po_number,"
            " discount_rate, age_days, due_in_days, predicted_delay_days, status FROM invoices").fetchall()
        from domain import Invoice
        return [Invoice(invoice_id=r[0], customer=r[1], subsidiary=r[2], gross_cents=r[3],
                        currency=r[4], po_number=r[5], discount_rate=r[6], age_days=r[7],
                        due_in_days=r[8], predicted_delay_days=r[9]) for r in rows]

    def settled_invoice_ids(self):
        """Invoices a run has already cleared: any invoice in the lines of
        an AUTO_POSTED or APPROVED_POSTED match, across every run in this
        workspace. The forecast and the collections queue are computed on
        what is left after reconciliation - never on the pre-run ledger."""
        rows = self.conn.execute(
            "SELECT result_json FROM matches WHERE status IN ('AUTO_POSTED','APPROVED_POSTED')"
        ).fetchall()
        out = set()
        for (rj,) in rows:
            try:
                res = json.loads(rj)
            except Exception:
                continue
            residual = res.get("residual_cents")
            if residual is None:
                residual = ((res.get("derivation") or {}).get("equation") or {}).get("residual_cents") or 0
            handler_settled = set((res.get("approval") or {}).get("settled_invoices") or [])
            for l in res.get("lines") or []:
                iid = l.get("invoice_id")
                if not iid:
                    continue
                # Fully covered matches (exact, or overpaid with the
                # excess carried as an on-account credit) settle every
                # line. A PARTIALLY paid invoice is settled only where
                # the decision itself recorded it - a part-paid invoice
                # stays in the residual book at its reduced balance.
                if residual >= 0 or iid in handler_settled:
                    out.add(iid)
        return out

    def partial_applications(self):
        """invoice_id -> total cents applied by approved partial payments,
        read from the approval records on cleared matches, so the figure
        always agrees with the decisions that produced it."""
        out = {}
        rows = self.conn.execute(
            "SELECT result_json FROM matches WHERE status='APPROVED_POSTED'").fetchall()
        for (rj,) in rows:
            try:
                res = json.loads(rj)
            except Exception:
                continue
            for pa in (res.get("approval") or {}).get("partial_application") or []:
                iid = pa.get("invoice_id")
                if iid:
                    out[iid] = out.get(iid, 0) + (pa.get("applied_cents") or 0)
        return out

    def reduce_invoice_gross(self, invoice_id, new_gross_cents):
        """Partial application: a payment covered part of this invoice.
        The invoice stays OPEN with its balance reduced to what is still
        owed - it leaves neither the ledger nor the forecast until the
        remaining balance itself is paid."""
        self._x("UPDATE invoices SET gross_cents=? WHERE invoice_id=?",
                (max(0, int(new_gross_cents)), invoice_id))

    def settle_invoices(self, invoice_ids):
        """Mark invoices settled (posted against an approved match). They
        leave the open ledger, the forecast and future candidate pools."""
        for iid in invoice_ids:
            self._x("UPDATE invoices SET status='SETTLED' WHERE invoice_id=?", (iid,))

    def create_run(self, run_id, idem_key, kind, policy_json, created_at):
        self._x("INSERT INTO runs VALUES (?,?,?,?,?,?,NULL)",
                (run_id, idem_key, kind, 'RUNNING', policy_json, created_at))
    def finish_run(self, run_id, status, finished_at):
        self._x("UPDATE runs SET status=?, finished_at=? WHERE run_id=?", (status, finished_at, run_id))
    def find_run_by_idempotency(self, key):
        r = self.conn.execute("SELECT run_id, status FROM runs WHERE idempotency_key=?", (key,)).fetchone()
        return r
    def steps_for_run(self, run_id):
        rows = self.conn.execute(
            "SELECT agent_name, status, latency_ms, evidence_json, confidence FROM run_steps "
            "WHERE run_id=? ORDER BY id", (run_id,)).fetchall()
        return [{"agent": r[0], "status": r[1], "latency_ms": r[2],
                 "evidence": json.loads(r[3]) if r[3] else {}, "confidence": r[4]} for r in rows]
    def update_step(self, run_id, agent, status, latency_ms, evidence):
        self._x("UPDATE run_steps SET status=?, latency_ms=?, evidence_json=? WHERE run_id=? AND agent_name=?",
                (status, latency_ms, json.dumps(evidence), run_id, agent))

    def add_step(self, run_id, agent, status, latency_ms, evidence, confidence):
        self._x("INSERT INTO run_steps(run_id, agent_name, status, latency_ms, evidence_json, confidence) VALUES (?,?,?,?,?,?)",
                (run_id, agent, status, latency_ms, json.dumps(evidence), confidence))
    def add_match(self, match_id, run_id, payment_id, status, solver, residual, confidence, result):
        self._x("INSERT INTO matches VALUES (?,?,?,?,?,?,?,?)",
                (match_id, run_id, payment_id, status, solver, residual, confidence, json.dumps(result)))
    def add_exception(self, run_id, payment_id, kind, severity, action, detail):
        self._x("INSERT INTO exceptions(run_id, payment_id, kind, severity, recommended_action, detail_json) VALUES (?,?,?,?,?,?)",
                (run_id, payment_id, kind, severity, action, json.dumps(detail)))
    def audit(self, actor, action, entity, entity_id, payload, ts):
        payload_json = json.dumps(payload, sort_keys=True)
        fingerprint = hashlib.sha256(
            f"{actor}|{action}|{entity}|{entity_id}|{payload_json}|{ts}".encode()).hexdigest()
        self._x("INSERT INTO audit_log(actor, action, entity, entity_id, payload_json, created_at, fingerprint) VALUES (?,?,?,?,?,?,?)",
                (actor, action, entity, entity_id, payload_json, ts, fingerprint))
    def exceptions_for_run(self, run_id):
        rows = self.conn.execute("SELECT payment_id, kind, severity, recommended_action, detail_json, status FROM exceptions WHERE run_id=?", (run_id,)).fetchall()
        return [{"payment_id": r[0], "kind": r[1], "severity": r[2], "recommended_action": r[3], "detail": json.loads(r[4]), "status": r[5]} for r in rows]
    def matches_for_run(self, run_id):
        rows = self.conn.execute("SELECT match_id, payment_id, status, solver, residual_cents, confidence, result_json FROM matches WHERE run_id=?", (run_id,)).fetchall()
        return [{"match_id": r[0], "payment_id": r[1], "status": r[2], "solver": r[3], "residual_cents": r[4], "confidence": r[5], "result": json.loads(r[6])} for r in rows]

    def list_runs(self, limit=20):
        rows = self.conn.execute(
            "SELECT r.run_id, r.kind, r.status, r.created_at, r.finished_at, "
            "(SELECT COUNT(*) FROM matches m WHERE m.run_id=r.run_id) AS match_count, "
            "(SELECT COUNT(*) FROM matches m WHERE m.run_id=r.run_id AND m.status='AUTO_POSTED') AS auto_posted, "
            "(SELECT COUNT(*) FROM exceptions e WHERE e.run_id=r.run_id) AS exception_count, "
            "(SELECT COUNT(*) FROM (SELECT payment_id FROM matches WHERE run_id=r.run_id UNION SELECT payment_id FROM exceptions WHERE run_id=r.run_id)) AS payment_count "
            "FROM runs r ORDER BY r.created_at DESC LIMIT ?", (limit,)).fetchall()
        return [{"run_id": r[0], "kind": r[1], "status": r[2], "created_at": r[3], "finished_at": r[4],
                 "matches": r[5], "auto_posted": r[6], "exceptions": r[7], "payments": r[8]} for r in rows]


    def get_match(self, match_id):
        row = self.conn.execute("SELECT match_id, run_id, payment_id, status, result_json FROM matches WHERE match_id=?",
                                (match_id,)).fetchone()
        if not row: return None
        return {"match_id": row[0], "run_id": row[1], "payment_id": row[2], "status": row[3],
                "result": json.loads(row[4])}

    def latest_match_for_payment(self, payment_id):
        row = self.conn.execute(
            "SELECT match_id, run_id, payment_id, status, result_json FROM matches "
            "WHERE payment_id=? ORDER BY rowid DESC LIMIT 1", (payment_id,)).fetchone()
        if not row: return None
        return {"match_id": row[0], "run_id": row[1], "payment_id": row[2],
                "status": row[3], "result": json.loads(row[4])}

    def get_invoice_row(self, invoice_id):
        r = self.conn.execute("SELECT invoice_id, status, gross_cents, discount_rate, customer FROM invoices WHERE invoice_id=?",
                              (invoice_id,)).fetchone()
        return {"invoice_id": r[0], "status": r[1], "gross_cents": r[2], "discount_rate": r[3], "customer": r[4]} if r else None

    def update_invoice_fields(self, invoice_id, gross_cents=None, discount_rate=None):
        """LiveCube inline edit. Only OPEN invoices can change - a settled
        invoice is part of a posted document and is immutable here."""
        sets, vals = [], []
        if gross_cents is not None: sets.append("gross_cents=?"); vals.append(gross_cents)
        if discount_rate is not None: sets.append("discount_rate=?"); vals.append(discount_rate)
        if not sets: return False
        vals.append(invoice_id)
        cur = self._x(f"UPDATE invoices SET {', '.join(sets)} WHERE invoice_id=? AND status='OPEN'", tuple(vals))
        return cur.rowcount > 0

    def update_payment_fields(self, payment_id, amount_cents=None, remittance_text=None, references=None):
        sets, vals = [], []
        if amount_cents is not None: sets.append("amount_cents=?"); vals.append(amount_cents)
        if remittance_text is not None: sets.append("remittance_text=?"); vals.append(remittance_text)
        if references is not None: sets.append("references_json=?"); vals.append(json.dumps(list(references)))
        if not sets: return False
        vals.append(payment_id)
        cur = self._x(f"UPDATE payments SET {', '.join(sets)} WHERE payment_id=?", tuple(vals))
        return cur.rowcount > 0

    def update_match(self, match_id, status, result):
        self._x("UPDATE matches SET status=?, result_json=? WHERE match_id=?",
                (status, json.dumps(result), match_id))

    def update_match_if_proposed(self, match_id, status, result):
        """Compare-and-set decision claim: the status change lands only
        if the match is still PROPOSED. Two approvers clicking at the
        same moment cannot both win - the loser gets False and the
        caller answers 409, so no duplicate settlement, audit entry or
        mail can be generated by a race."""
        cur = self._x("UPDATE matches SET status=?, result_json=? WHERE match_id=? AND status='PROPOSED'",
                      (status, json.dumps(result), match_id))
        return cur.rowcount == 1

    def add_alias(self, raw_name, customer, source="approval"):
        self._x("INSERT OR REPLACE INTO aliases VALUES (?,?,?)",
                ((raw_name or "").strip().lower(), customer, source))

    def delete_payment_run_records(self, payment_id):
        """Withdraw a payment's run records (its match and exceptions),
        returning it to the staged, unreconciled state. Used when a
        staged payment is edited: the edit must be able to re-solve."""
        self._x("DELETE FROM matches WHERE payment_id=?", (payment_id,))
        self._x("DELETE FROM exceptions WHERE payment_id=?", (payment_id,))

    def list_proposed(self, limit=50):
        rows = self.conn.execute(
            "SELECT match_id, run_id, payment_id, confidence, result_json FROM matches "
            "WHERE status='PROPOSED' ORDER BY rowid DESC LIMIT ?", (limit,)).fetchall()
        out = []
        for r in rows:
            res = json.loads(r[4])
            eq = (res.get("derivation") or {}).get("equation") or {}
            out.append({"match_id": r[0], "run_id": r[1], "payment_id": r[2], "confidence": r[3],
                        "amount_cents": eq.get("payment_cents"),
                        "invoices": [l.get("invoice_id") for l in res.get("lines", [])],
                        "decision_reason": res.get("decision_reason")})
        return out

    def add_outbox(self, to_addr, subject, body, kind, ref_id, status, detail, ts):
        cur = self._x("INSERT INTO outbox(to_addr, subject, body, kind, ref_id, status, detail, created_at) VALUES (?,?,?,?,?,?,?,?)",
                      (to_addr, subject, body, kind, ref_id, status, detail, ts))
        return cur.lastrowid
    def list_outbox(self, limit=50):
        rows = self.conn.execute(
            "SELECT id, to_addr, subject, body, kind, ref_id, status, detail, created_at FROM outbox "
            "ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return [{"id": r[0], "to": r[1], "subject": r[2], "body": r[3], "kind": r[4],
                 "ref_id": r[5], "status": r[6], "detail": r[7], "created_at": r[8]} for r in rows]

    def audit_list(self, limit=100):
        rows = self.conn.execute(
            "SELECT actor, action, entity, entity_id, payload_json, created_at, fingerprint FROM audit_log "
            "ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return [{"actor": r[0], "action": r[1], "entity": r[2], "entity_id": r[3],
                 "payload": json.loads(r[4]), "created_at": r[5], "fingerprint": r[6]} for r in rows]
