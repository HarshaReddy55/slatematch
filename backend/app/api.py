"""SlateMatch API. Run: uvicorn api:app --app-dir backend/app --port 8080
Env: SLATEMATCH_DB (default ./slatematch.db), GEMINI_API_KEY (optional)."""
import os, json, uuid, hashlib
from dataclasses import asdict
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from typing import List, Optional

from domain import Invoice, Payment, Policy
from repository import Repository
from ingestion import parse_invoices_csv, parse_payments_csv
from scenarios import SCENARIOS, get_scenario
from methodology import SECTIONS as METHODOLOGY
from batch import run_batch
from anomaly import payment_fingerprint
from solvers import solve_milp, solve_greedy, why_not_invoice
from ai import parse_remittance, GeminiClient, AI_BUDGET, deterministic_parse
from briefing import run_brief, draft_message
from copilot import answer as copilot_answer
from seed import seed_invoices, seed_payments, GROUND_TRUTH
import ml as mlmod
from forecast import forecast_cash_in, prioritise_collections
from mail import mail_config, mail_config_public, reminder_draft, reminder_tone, send_mail, settlement_draft
from erp_sap import build_posting_document, document_for_match, dispute_accrual_journal, document_number_for
import rust_bridge

def _env(name, default=""):
    v = os.environ.get("SLATEMATCH_" + name)
    return default if v is None else v

DATA_DIR = _env("DATA_DIR", os.path.join(os.path.dirname(__file__), "..", "data"))
from tenants import TenantStore, ROLE_CAPS
store = TenantStore(os.path.abspath(DATA_DIR))
BOOTSTRAP_KEY = _env("BOOTSTRAP_KEY", "")
from collections import OrderedDict as _OrderedDict
_repos = _OrderedDict()
_REPO_CACHE_MAX = 128  # session workspaces held open at once; base tenants are never evicted
_models = {}

def _now_iso():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()

import threading as _repos_threading
_repos_lock = _repos_threading.Lock()

def repo_for(tenant_id):
    # Locked lazy creation: two threads meeting a cold tenant at the same
    # moment must not both run the repository's schema build against the
    # same new database file (the loser can fail with 'database is
    # locked' and surface a 500). Every new browser session is a cold
    # tenant in the public demo, so this race is on the hot path.
    repo = _repos.get(tenant_id)
    if repo is not None:
        _repos.move_to_end(tenant_id)
        return repo
    with _repos_lock:
        repo = _repos.get(tenant_id)
        if repo is None:
            repo = Repository(store.db_path(tenant_id))
            _repos[tenant_id] = repo
            _maybe_reap()  # a new workspace is the natural housekeeping moment (hourly-throttled)
            # Anonymous demo sessions each open a repository (and a
            # database file). Cap the open set so a busy public link
            # cannot exhaust connections or memory; the least recently
            # used SESSION workspaces are closed first. Their data is
            # ephemeral demo state and reloads in one action.
            while len(_repos) > _REPO_CACHE_MAX:
                victim = next((k for k in _repos if "--" in k and k != tenant_id), None)
                if victim is None:
                    break
                old = _repos.pop(victim)
                try: old.conn.close()
                except Exception: pass
    return repo

from fastapi import Header, HTTPException, Depends, Request
from fastapi.responses import StreamingResponse, JSONResponse, PlainTextResponse, Response
import queue as _queue, threading as _threading, time as _time

DEMO_TENANTS = [
    {"id": "demo", "name": "Demo workspace - US", "erp": "SAP S/4HANA"},
    {"id": "demo-eu", "name": "Demo workspace - EU", "erp": "Oracle NetSuite"},
]

import re as _re
_SESSION_RE = _re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

def auth_context(x_api_key: str = Header(default=""), x_tenant_id: str = Header(default=""),
                 x_workspace_session: str = Header(default="")):
    """Returns {tenant_id, role}. Dev mode: when no bootstrap key and no keys
    exist yet for the store, requests map to the built-in demo tenant so the
    product runs locally without setup. In production set SLATEMATCH_BOOTSTRAP_KEY
    and issue tenant keys; dev mode then disables automatically once any key exists.
    The X-Tenant-Id header is honoured ONLY in dev-open mode, and only for the
    two demo tenants, so the UI can demonstrate database-per-tenant isolation.
    The X-Workspace-Session header (a per-tab UUID the frontend generates) is
    also dev-open only: it clones the demo tenant's workspace per browser
    session, so two people opening the public link at the same time never
    wipe each other's screen. With real API keys both headers are ignored
    and the key alone decides the tenant."""
    any_keys = store.key_count() > 0
    if not any_keys and not BOOTSTRAP_KEY:
        chosen = next((t for t in DEMO_TENANTS if t["id"] == x_tenant_id), DEMO_TENANTS[0])
        store.ensure_tenant(chosen["id"], chosen["name"])
        effective = chosen["id"]
        if _SESSION_RE.match(x_workspace_session or ""):
            # The full validated UUID keys the session workspace. A
            # truncated prefix (the earlier 8-hex form) let two
            # visitors whose UUIDs shared a prefix share one workspace.
            effective = f"{chosen['id']}--{x_workspace_session}"
        return {"tenant_id": effective, "base_tenant": chosen["id"],
                "session": x_workspace_session if effective != chosen["id"] else None,
                "role": "admin", "mode": "dev-open"}
    ctx = store.resolve(x_api_key)
    if ctx is None:
        raise HTTPException(401, "invalid or missing API key")
    ctx["mode"] = "key"
    ctx["base_tenant"] = ctx["tenant_id"]
    ctx["session"] = None
    return ctx

def need(ctx, cap):
    if cap not in ROLE_CAPS[ctx["role"]]:
        raise HTTPException(403, f"role {ctx['role']} lacks capability {cap}")
    return ctx

import threading as _threading
_models_lock = _threading.Lock()

def models():
    # Trained once, then cached. The lock stops two concurrent first
    # callers training twice.
    if "m" not in _models:
        with _models_lock:
            if "m" not in _models:
                _models["m"] = mlmod.train_all()
    return _models["m"]

def _warm_models():
    # The first /health or /ready probe used to pay the full training
    # cost inside the request path (two GradientBoosting fits). Warm
    # the cache on a background thread at startup instead; a probe
    # that arrives early simply waits on the lock once.
    try: models()
    except Exception: pass

_threading.Thread(target=_warm_models, daemon=True, name="slatematch-model-warmup").start()

app = FastAPI(title="SlateMatch - Autonomous Cash Application Agent")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

class PaymentIn(BaseModel):
    payment_id: str; payer_raw: str; amount_cents: int; currency: str = "USD"
    claimed_deduction_cents: int = 0; deduction_reason_raw: str = ""
    pod_verified_clean: bool = False; remittance_text: str = ""; references: List[str] = []
    subsidiary: Optional[str] = None

class BatchIn(BaseModel):
    idempotency_key: str
    payments: List[PaymentIn]
    policy: Optional[dict] = None

class ParseIn(BaseModel):
    # A remittance advice is a page of text, not a document dump: the
    # cap keeps a pasted file (or a runaway client) from pushing an
    # unbounded string through the AI parser and the prompt. 20k
    # characters is roughly ten pages of remittance text.
    text: str = Field(..., max_length=20_000)

class CopilotIn(BaseModel):
    question: str

class WhyNotIn(BaseModel):
    payment: PaymentIn
    invoice_id: str

def _pay(p: PaymentIn) -> Payment:
    return Payment(**p.model_dump())

@app.get("/health")
def health():
    from ai import LAST_GEMINI_ERROR
    return {"status": "ok", "gemini_configured": GeminiClient().available,
            "gemini_last_error": LAST_GEMINI_ERROR["error"],
            "model_metrics": models()["metrics"], "data_dir": os.path.basename(DATA_DIR),
            "auth": "api-key" if (BOOTSTRAP_KEY or store.key_count()) else "dev-open"}

@app.post("/api/v1/seed")
def seed(ctx=Depends(auth_context)):
    need(ctx, "run"); repo = repo_for(ctx["tenant_id"])
    # Seeding stages a FRESH labelled workspace: prior run records from
    # an earlier evaluation must not leak into this one (a payment that
    # was reconciled in a previous seed is not "already reconciled"
    # here - it was never staged here).
    repo.clear_workspace()
    invs = seed_invoices()
    for inv in invs: repo.add_invoice(inv)
    pays = seed_payments()
    for p in pays: repo.add_payment(p, payment_fingerprint(p))
    if not repo.get_meta("active_case"):
        repo.set_meta("active_case", {"id": "seed", "name": "Demo seed workspace", "source": "demo-seed",
                                      "loaded_at": _now_iso(),
                                      "expect": {pid: {"invoices": sorted(s)} for pid, s in GROUND_TRUTH.items()},
                                      "expect_exceptions": {}})
    return {"invoices": len(invs), "payments": [asdict(p) for p in pays],
            "note": "Synthetic labelled workspace for evaluation. Payments are returned for review, then submitted to /api/v1/batches."}

def _workspace_state(repo):
    """The one shared truth every view reads: the active case, what is staged,
    what the latest run did, and what is waiting for a human."""
    pending = repo.pending_payments()
    runs = repo.list_runs(1)
    case = repo.get_meta("active_case")
    open_invs = repo.open_invoices()
    all_pays = repo.all_payments()
    # v31 two-stage lifecycle: a loaded case is STAGED until an explicit
    # run executes it. Loading a case clears prior runs, so the state is
    # exact: case + no run = staged; case + run = executed.
    run_status = "empty" if not case else ("executed" if runs else "staged")
    return {"case": case,
            "run_status": run_status,
            "open_invoice_total_cents": sum(i.gross_cents for i in open_invs),
            "staged_payment_total_cents": sum(pp.amount_cents for pp in all_pays),
            "open_invoices": len(open_invs),
            "staged_payments": len(all_pays),
            "all_payments": [asdict(p) for p in all_pays],
            "pending_payments": [asdict(p) for p in pending],
            "latest_run": runs[0] if runs else None,
            "approvals_pending": len(repo.list_proposed())}

@app.get("/api/v1/workspace")
def workspace(ctx=Depends(auth_context)):
    need(ctx, "read"); return _workspace_state(repo_for(ctx["tenant_id"]))

def _policy_for(repo, tenant_id, body_policy):
    """Effective run policy: an explicit request body wins; otherwise the
    tenant's stored policy, with the active use-case pack's grading override
    (if any) applied on top. A body policy MERGES over the stored one:
    a client that posts only the fields it knows (the vanilla Policy
    Studio predates newer fields) must not silently reset the rest to
    defaults."""
    stored = store.get_policy(tenant_id)
    base = dict(stored) if stored else {}
    if body_policy:
        merged = {**base, **body_policy}
        return Policy(**merged)
    case = repo.get_meta("active_case") or {}
    for k, v in (case.get("policy") or {}).items(): base[k] = v
    return Policy(**base) if base else Policy()

def _load_case(repo, cid, actor):
    """Replace the workspace with one case, so every view works on the same
    data: dashboard, ledger, run, approvals, forecast and copilot all read
    this one workspace."""
    if cid == "seed":
        invs, pays = seed_invoices(), seed_payments()
        name, source = "Demo case - one realistic day of receipts", "demo-seed"
        expect = {pid: {"invoices": sorted(s)} for pid, s in GROUND_TRUTH.items()}
        expect_exc = {}
    else:
        sc = get_scenario(cid)
        if not sc: raise HTTPException(404, f"unknown case {cid}")
        invs, pays = sc["build"]()
        name, source = sc["title"], "use-case"
        raw = dict(sc.get("expect") or {})
        expect_exc = raw.pop("exceptions", {}) if isinstance(raw.get("exceptions"), dict) else {}
        expect = {}
        for pid, e in raw.items():
            if isinstance(e, dict):
                expect[pid] = {k: (sorted(v) if isinstance(v, (set, list)) and k == "invoices" else v)
                               for k, v in e.items()}
    repo.clear_workspace()
    for inv in invs: repo.add_invoice(inv)
    for p in pays: repo.add_payment(p, payment_fingerprint(p))
    meta = {"id": cid, "name": name, "source": source,
            "loaded_at": _now_iso(), "expect": expect,
            "expect_exceptions": expect_exc}
    if source == "demo-seed":
        # The demo day is judged the way a real book would be: the
        # maker-checker hold sits at $60,000 so exactly the two clean big
        # wires wait for an approver and the rest of the day flows.
        meta["policy"] = {"maker_checker_threshold_cents": 6000000}
        meta["policy_note"] = "Demo policy: the maker-checker hold is $60,000 for this case (the product default is $100,000 - change it in Policy Studio), so two clean big wires wait for an approver and everything else flows."
    if source == "use-case":
        # Same grading policy as the scenario endpoint: the maker-checker
        # threshold is raised while a pack is the active case, so the run's
        # verdict isolates matching correctness on enterprise amounts.
        # Approval gating itself lives in Policy Studio and its own flow.
        meta["policy"] = {"maker_checker_threshold_cents": 10**12}
        meta["policy_note"] = "Maker-checker threshold is raised for this use case, so its verdict isolates matching correctness (the same grading policy the pack states). Policy Studio still governs uploaded and demo data."
    repo.set_meta("active_case", meta)
    repo.audit(actor, "case_loaded", "workspace", cid,
               {"invoices": len(invs), "payments": len(pays)}, _now_iso())
    return pays

def _record_settlement_drafts(repo, run):
    """Category-3 mail, generated by the run itself: every payment the
    solver cleared on its own earns a settlement confirmation draft in
    the outbox (status draft - composed, not sent), ready to review in
    the Outbound Mail Hub. Drafting must never fail a run, so errors
    are swallowed here and only here."""
    try:
        run_id = (run or {}).get("run_id")
        if not run_id:
            return
        existing = {m["ref_id"] for m in repo.list_outbox(300)
                    if m["kind"] == "settlement_confirmation"}
        for m in repo.matches_for_run(run_id):
            if m["status"] != "AUTO_POSTED":
                continue
            ref = f"{run_id}:{m['payment_id']}"
            if ref in existing:
                continue
            res = m["result"] or {}
            pay = res.get("payment") or {}
            d = settlement_draft(pay.get("payer_raw") or "Customer", m["payment_id"],
                                 res.get("lines") or [],
                                 (res.get("approval") or {}).get("erp_document_id"))
            repo.add_outbox(pay.get("payer_raw") or "Customer", d["subject"], d["body"],
                            "settlement_confirmation", ref, "draft",
                            f"Auto-generated by run {run_id} - review and send from the Outbound Mail Hub",
                            _now_iso())
    except Exception:
        pass

def _finish_run_outputs(repo, run):
    """The sixth pipeline stage, measured where it happens: composing the
    run's outputs (settlement drafts in the outbox; SAP clearing documents
    and the brief compose from the same stored facts). The Briefing Agent's
    step is updated with the real elapsed time and what it produced, so
    the agent strip never shows an invented number."""
    import time as _t
    run_id = (run or {}).get("run_id")
    if not run_id: return
    before = len(repo.list_outbox(1000))
    _t0 = _t.perf_counter()
    # The drafts and the Briefing step that reports them are one unit:
    # they land together or not at all.
    with repo.transaction():
        _record_settlement_drafts(repo, run)
        ms = round((_t.perf_counter() - _t0) * 1000, 2)
        try:
            steps = {st["agent"]: st for st in repo.steps_for_run(run_id)}
            ev = dict((steps.get("Briefing Agent") or {}).get("evidence") or {})
            ev["settlement_drafts_recorded"] = len(repo.list_outbox(1000)) - before
            ev["reading"] = ("Settlement drafts were composed and timed here; SAP clearing "
                             "documents and the case brief compose on read from this run's "
                             "stored facts - nothing pre-written, nothing cached.")
            repo.update_step(run_id, "Briefing Agent", "COMPLETED", ms, ev)
        except Exception:
            pass
    # Bounded post-run automation, under the policy snapshot the run
    # itself ran with: the autopilot pass (a no-op at autonomy level
    # 0, the default) and the dispute lifecycle records for the run's
    # generated claims. Each is guarded separately: a failure in
    # either must never fail the run's outputs, and every autopilot
    # resolution is its own transaction inside autonomy.py.
    try:
        _run_row = repo.get_run(run_id)
        _pol = Policy(**(_run_row.get("policy") or {})) if _run_row else Policy()
        from autonomy import run_autopilot
        run_autopilot(repo, run_id, _pol, "system:autopilot", _now_iso)
    except Exception:
        pass
    try:
        for m in repo.matches_for_run(run_id):
            ded = (m["result"] or {}).get("deduction") or {}
            if ded.get("autonomous_action") == "AUTO_GENERATE_DISPUTE_CLAIM":
                repo.upsert_dispute(
                    "DSP-" + m["match_id"].replace("m_", ""), m["match_id"],
                    m["payment_id"],
                    ded.get("payer") or ((m["result"] or {}).get("payment") or {}).get("payer_raw") or "",
                    ded.get("claimed_cents") or 0,
                    ded.get("expected_recovery_value_usd") or 0,
                    ded.get("assigned_erp_reason_code") or "", _now_iso())
    except Exception:
        pass
    # Integrations fan-out (guarded inside _fire_webhooks): the
    # run is complete and its outputs are composed.
    _fire_webhooks(repo, "run.completed",
                   {"run_id": run_id, "payments": (run or {}).get("payments"),
                    "auto_posted": (run or {}).get("auto_posted"),
                    "held": (run or {}).get("held")})

@app.post("/api/v1/cases/{cid}/load")
def load_case(cid: str, ctx=Depends(auth_context)):
    need(ctx, "run"); repo = repo_for(ctx["tenant_id"])
    pays = _load_case(repo, cid, f"api:{ctx['role']}")
    # v31: loading STAGES the case only. Execution is an explicit act
    # (POST /api/v1/workspace/run or the Run page's live stream), so a
    # reviewer sees the staged portfolio first and watches it solve.
    return {"workspace": _workspace_state(repo), "payments": [asdict(p) for p in pays],
            "run": None}

@app.post("/api/v1/workspace/run")
def workspace_run(ctx=Depends(auth_context)):
    """Execute the staged workspace: every staged payment through the
    batch engine under the effective policy (the case's own overrides
    included), with the run's outputs composed and timed."""
    need(ctx, "run"); repo = repo_for(ctx["tenant_id"])
    pays = repo.all_payments()
    if not pays:
        raise HTTPException(409, "nothing staged - load a case or stage payments first")
    if not repo.pending_payments():
        runs = repo.list_runs(1)
        if runs:
            # Every staged payment is already reconciled. Executing
            # again must not solve them twice: return the standing run.
            return {"run": {"run_id": runs[0]["run_id"], "status": runs[0]["status"],
                            "idempotent_replay": True,
                            "note": "every staged payment is already reconciled - nothing was solved twice"},
                    "workspace": _workspace_state(repo)}
    run = run_batch(repo, repo.pending_payments(), _policy_for(repo, ctx["tenant_id"], None),
                    "wsrun-" + uuid.uuid4().hex[:10], actor=f"api:{ctx['role']}")
    _finish_run_outputs(repo, run)
    return {"run": run, "workspace": _workspace_state(repo)}

@app.post("/api/v1/workspace/reset")
def workspace_reset(ctx=Depends(auth_context)):
    need(ctx, "run"); repo = repo_for(ctx["tenant_id"])
    repo.clear_workspace()
    repo.audit(f"api:{ctx['role']}", "workspace_reset", "workspace", "", {}, _now_iso())
    return _workspace_state(repo)

class StagePaymentIn(BaseModel):
    payment_id: str = ""; payer: str = ""; amount_cents: int = 0
    references: List[str] = []; claimed_deduction_cents: int = 0
    deduction_reason: str = ""; pod_verified_clean: bool = False
    remittance_text: str = ""

@app.post("/api/v1/workspace/stage-payment")
def stage_payment(body: StagePaymentIn, ctx=Depends(auth_context)):
    """Stage one parsed wire into the shared workspace (parsed in Upload,
    reconciled in Run - the same flow as files and cases)."""
    need(ctx, "run"); repo = repo_for(ctx["tenant_id"])
    if int(body.amount_cents or 0) <= 0:
        raise HTTPException(422, "amount_cents must be positive - parse the remittance first")
    pid = (body.payment_id or "").strip() or ("WIRE-" + uuid.uuid4().hex[:8].upper())
    repo.add_payment(Payment(payment_id=pid, payer_raw=body.payer or "Unknown payer",
                             amount_cents=int(body.amount_cents),
                             claimed_deduction_cents=int(body.claimed_deduction_cents or 0),
                             deduction_reason_raw=body.deduction_reason or "",
                             pod_verified_clean=bool(body.pod_verified_clean),
                             remittance_text=body.remittance_text or "",
                             references=list(body.references or [])))
    if not repo.get_meta("active_case"):
        repo.set_meta("active_case", {"id": "ingested", "name": "Ingested remittance",
                                      "source": "Remittance paste in Upload Center",
                                      "loaded_at": _now_iso()})
    repo.audit(f"api:{ctx['role']}", "payment_staged", "payment", pid,
               {"amount_cents": int(body.amount_cents)}, _now_iso())
    return {"staged": pid, "workspace": _workspace_state(repo)}

class SeedRefsIn(BaseModel):
    refs: List[str]
    payer: str = ""
    wire_amount_cents: int = 0
    remittance_text: str = ""

@app.post("/api/v1/invoices/seed-referenced")
def seed_referenced(body: SeedRefsIn, ctx=Depends(auth_context)):
    """One-click test-data seeding for the Capture Agent. A pasted
    remittance cites invoices this ledger has never seen, and without
    them the wire can only ever NO_MATCH. Seed exactly the missing
    refs, at amounts the evidence supports: the wire amount itself when
    the remittance cites one invoice, or the per-line amounts the
    remittance lists. A ref whose amount cannot be determined from the
    evidence is reported unresolved - never invented."""
    need(ctx, "run"); repo = repo_for(ctx["tenant_id"])
    from ai import amounts_for_refs
    from domain import Invoice as _Inv
    refs = [str(r).strip() for r in (body.refs or []) if str(r).strip()]
    if not refs: raise HTTPException(422, "no references to seed")
    missing = [r for r in refs if repo.get_invoice_row(r) is None]
    skipped = [r for r in refs if r not in missing]
    priced = {}
    if len(missing) == 1 and int(body.wire_amount_cents or 0) > 0:
        priced[missing[0]] = int(body.wire_amount_cents)
    elif missing:
        priced = amounts_for_refs(body.remittance_text or "", missing)
    seeded, unresolved = [], []
    for ref in missing:
        amt = priced.get(ref)
        if not amt or amt <= 0:
            unresolved.append(ref); continue
        repo.add_invoice(_Inv(invoice_id=ref, customer=body.payer or "Unknown payer",
                              subsidiary=body.payer or "Unknown payer",
                              gross_cents=amt, age_days=15, due_in_days=10))
        seeded.append({"invoice_id": ref, "gross_cents": amt})
    if seeded and not repo.get_meta("active_case"):
        repo.set_meta("active_case", {"id": "ingested", "name": "Ingested remittance",
                                      "source": "Remittance paste in Upload Center",
                                      "loaded_at": _now_iso()})
    if seeded:
        repo.audit(f"api:{ctx['role']}", "seed_referenced_invoices", "invoice", "",
                   {"seeded": seeded, "unresolved": unresolved}, _now_iso())
    return {"seeded": seeded, "skipped_existing": skipped, "unresolved": unresolved,
            "workspace": _workspace_state(repo)}

@app.get("/api/v1/invoices")
def invoices(ctx=Depends(auth_context)):
    need(ctx, "read"); repo = repo_for(ctx["tenant_id"])
    return _attach_partials(repo, [asdict(i) for i in repo.open_invoices()])

class InvoiceEdit(BaseModel):
    gross_cents: Optional[int] = None
    discount_rate: Optional[float] = None

@app.patch("/api/v1/invoices/{invoice_id}")
def edit_invoice(invoice_id: str, body: InvoiceEdit, ctx=Depends(auth_context)):
    """LiveCube inline edit of an OPEN invoice. A settled invoice belongs
    to a posted document and refuses - that refusal is the control."""
    need(ctx, "run"); repo = repo_for(ctx["tenant_id"])
    row = repo.get_invoice_row(invoice_id)
    if not row: raise HTTPException(404, "no such invoice in this workspace")
    # Settled has two doors in this system and both lock the invoice:
    # the status flag (flipped when a held match is approved) and the
    # match-derived set (invoices inside AUTO_POSTED/APPROVED_POSTED
    # matches, which is what the forecast and candidate pools read).
    if row["status"] != "OPEN" or invoice_id in repo.settled_invoice_ids():
        raise HTTPException(409, "invoice already settled by a posted match - settled invoices cannot be edited")
    if body.gross_cents is not None and body.gross_cents <= 0:
        raise HTTPException(422, "amount must be positive")
    if body.discount_rate is not None and not (0 <= body.discount_rate <= 0.9):
        raise HTTPException(422, "discount rate must be between 0 and 90 percent")
    if body.gross_cents is None and body.discount_rate is None:
        raise HTTPException(422, "nothing to change")
    repo.update_invoice_fields(invoice_id, gross_cents=body.gross_cents,
                               discount_rate=body.discount_rate)
    # A PROPOSED match that allocated this invoice was computed from
    # its old value: withdraw those proposals (their payments return
    # to staged) so the next run re-solves them against the new value.
    restaged = []
    for a in repo.list_proposed(500):
        if invoice_id in (a.get("invoices") or []):
            repo.delete_payment_run_records(a["payment_id"])
            restaged.append(a["payment_id"])
    repo.audit("workspace-ui", "edit_invoice", "invoice", invoice_id,
               {"gross_cents": body.gross_cents, "discount_rate": body.discount_rate,
                "restaged_payments": restaged}, _now_iso())
    inv = next(i for i in repo.open_invoices() if i.invoice_id == invoice_id)
    return {"invoice": asdict(inv), "restaged_payments": restaged,
            "note": ("Proposals that allocated this invoice were withdrawn - those payments "
                     "are staged again and will re-solve on the next run.") if restaged else
                    "Open invoice updated."}

class PaymentEdit(BaseModel):
    amount_cents: Optional[int] = None
    remittance_text: Optional[str] = None
    references: Optional[List[str]] = None

@app.patch("/api/v1/payments/{payment_id}")
def edit_payment(payment_id: str, body: PaymentEdit, ctx=Depends(auth_context)):
    """LiveCube inline edit of a staged payment. A payment a posted match
    already settled refuses. Editing the remittance text re-extracts its
    references deterministically, so fixing a garbled OCR reference in
    the text fixes the structured refs the solver reads."""
    need(ctx, "run"); repo = repo_for(ctx["tenant_id"])
    pay = next((p for p in repo.all_payments() if p.payment_id == payment_id), None)
    if not pay: raise HTTPException(404, "no such payment in this workspace")
    m = repo.latest_match_for_payment(payment_id)
    if m and m["status"] in ("AUTO_POSTED", "APPROVED_POSTED"):
        raise HTTPException(409, "payment already posted - settled payments cannot be edited")
    if body.amount_cents is not None and body.amount_cents <= 0:
        raise HTTPException(422, "amount must be positive")
    refs = body.references
    if body.remittance_text is not None and refs is None:
        invs = repo.open_invoices()
        f = deterministic_parse(body.remittance_text)
        refs = list(f.get("invoice_refs") or []) + list(f.get("po_refs") or [])
    if refs is not None:
        refs = [str(r).strip() for r in refs if str(r).strip()]
    if body.amount_cents is None and body.remittance_text is None and body.references is None:
        raise HTTPException(422, "nothing to change")
    repo.update_payment_fields(payment_id, amount_cents=body.amount_cents,
                               remittance_text=body.remittance_text, references=refs)
    restaged = False
    if m:  # a PROPOSED match exists (posted matches refused above)
        repo.delete_payment_run_records(payment_id)
        restaged = True
    repo.audit("workspace-ui", "edit_payment", "payment", payment_id,
               {"amount_cents": body.amount_cents, "references": refs, "restaged": restaged}, _now_iso())
    pay = next(p for p in repo.all_payments() if p.payment_id == payment_id)
    return {"payment": asdict(pay), "references": pay.references,
            "note": ("Its earlier proposal was withdrawn by this edit - the payment is staged "
                     "again and will re-solve on the next run.") if restaged else
                    "Staged payment updated."}

def _uploaded_story(repo, lead):
    """The brief's situation line for uploaded data, built from the live
    workspace itself - never a previous case's authored text."""
    invs = repo.open_invoices()
    customers = len({i.customer for i in invs})
    total = sum(i.gross_cents for i in invs)
    staged = len(repo.all_payments())
    return (f"{lead}: {len(invs)} open invoice{'s' if len(invs) != 1 else ''} from "
            f"{customers} customer{'s' if customers != 1 else ''} totalling ${total / 100:,.2f}"
            + (f", with {staged} payment{'s' if staged != 1 else ''} staged against them" if staged else "")
            + ". Every figure in this workspace comes from the uploaded data.")

@app.post("/api/v1/invoices/import")
def import_invoices(payload: dict, ctx=Depends(auth_context)):
    """An Open Invoices CSV defines a ledger. 'replace' (the default)
    starts a fresh workspace from the file; 'append' adds its rows to
    the active ledger. Either way the workspace stops claiming to be a
    previous case: identity, grading expectations and the brief's
    situation line are regenerated from the uploaded data itself."""
    need(ctx, "run"); repo = repo_for(ctx["tenant_id"])
    mode = str(payload.get("mode") or "replace").lower()
    if mode not in ("replace", "append"):
        raise HTTPException(422, "mode must be 'replace' or 'append'")
    if not str(payload.get("csv_text") or "").strip():
        raise HTTPException(422, "csv_text is required - an import with no content changes nothing and must not report success")
    out = parse_invoices_csv(payload.get("csv_text", ""))
    if mode == "replace":
        repo.clear_workspace()
    skipped_settled = []
    if mode == "append":
        # A settled invoice belongs to a posted document. Re-importing
        # it must not silently reopen it: those rows are skipped and
        # reported, never overwritten.
        settled_ids = repo.settled_invoice_ids() | {
            r[0] for r in repo.conn.execute("SELECT invoice_id FROM invoices WHERE status='SETTLED'").fetchall()}
        keep = []
        for inv in out["invoices"]:
            if inv.invoice_id in settled_ids:
                skipped_settled.append(inv.invoice_id)
            else:
                keep.append(inv)
        out["invoices"] = keep
    for inv in out["invoices"]: repo.add_invoice(inv)
    if out["invoices"]:
        lead = ("An uploaded ledger replaced the workspace" if mode == "replace"
                else "Uploaded invoices were added to the workspace ledger")
        repo.set_meta("active_case", {"id": "upload", "name": "Uploaded ledger", "source": "upload",
                                      "loaded_at": _now_iso(), "expect": {}, "expect_exceptions": {},
                                      "story": _uploaded_story(repo, lead)})
    return {"imported": len(out["invoices"]), "mapping": out["mapping"], "errors": out["errors"],
            "skipped_settled": skipped_settled,
            "fingerprint": out["fingerprint"], "mode": mode, "workspace": _workspace_state(repo)}

@app.post("/api/v1/batches")
def batches(body: BatchIn, ctx=Depends(auth_context)):
    need(ctx, "run"); repo = repo_for(ctx["tenant_id"])
    # A batch run executes under the tenant's stored policy. An inline
    # policy in the request body is NOT honoured here - previewing a
    # candidate policy is what /api/v1/policy/preview exists for.
    pol = _policy_for(repo, ctx["tenant_id"], None)
    pays = [_pay(p) for p in body.payments]
    for p in pays: repo.add_payment(p, payment_fingerprint(p))
    run = run_batch(repo, pays, pol, body.idempotency_key, actor=f"api:{ctx['role']}")
    _finish_run_outputs(repo, run)
    return run

@app.post("/api/v1/payments/import")
def import_payments(payload: dict, ctx=Depends(auth_context)):
    """Upload a payments CSV: parse it, then reconcile it as a batch."""
    need(ctx, "run"); repo = repo_for(ctx["tenant_id"])
    if not str(payload.get("csv_text") or "").strip():
        raise HTTPException(422, "csv_text is required - an import with no content changes nothing and must not report success")
    out = parse_payments_csv(payload.get("csv_text", ""))
    for p in out["payments"]: repo.add_payment(p, payment_fingerprint(p))
    if out["payments"] and not repo.get_meta("active_case"):
        repo.set_meta("active_case", {"id": "upload", "name": "Uploaded files", "source": "upload",
                                      "loaded_at": _now_iso(), "expect": {}, "expect_exceptions": {},
                                      "story": _uploaded_story(repo, "Payments were uploaded into an empty workspace")})
    pol = _policy_for(repo, ctx["tenant_id"], None)
    import uuid as _uuid
    # A run reconciles the workspace's whole staged payment set: the new
    # wires join the active case's run, they never overwrite it.
    all_pays = repo.all_payments()
    run = run_batch(repo, all_pays, pol, payload.get("idempotency_key") or ("csv-" + _uuid.uuid4().hex[:10]),
                    actor=f"api:{ctx['role']}") if all_pays else None
    if run:
        _finish_run_outputs(repo, run)
    return {"imported": len(out["payments"]), "mapping": out["mapping"], "errors": out["errors"],
            "fingerprint": out["fingerprint"], "run": run}

def _extract_file_text(raw, filename):
    """Read an uploaded file into text, or say honestly why we cannot.
    PDFs give up their text layer; images go through OCR when the
    tesseract binary is present; anything else must decode as text."""
    name = (filename or "").lower()
    if raw[:4] == b"%PDF" or name.endswith(".pdf"):
        try:
            from pypdf import PdfReader
        except ImportError:
            raise HTTPException(422, "PDF reading is not installed in this deployment - paste the remittance text into the Capture Agent instead")
        import io as _io
        try:
            reader = PdfReader(_io.BytesIO(raw))
            text = "\n".join((p.extract_text() or "") for p in reader.pages)
        except Exception:
            raise HTTPException(422, "this PDF could not be read - if it is a scanned image, upload the page as a PNG or JPG so OCR can read it")
        if not text.strip():
            raise HTTPException(422, "this PDF has no readable text layer - it looks like a scan; upload the page as a PNG or JPG so OCR can read it")
        return text, "pdf-text"
    if raw[:8] == b"\x89PNG\r\n\x1a\n" or raw[:3] == b"\xff\xd8\xff" or name.endswith((".png", ".jpg", ".jpeg")):
        import shutil as _shutil
        if not _shutil.which("tesseract"):
            raise HTTPException(422, "image OCR is not available in this deployment - paste the text into the Capture Agent, or upload the PDF or CSV version")
        try:
            import io as _io
            from PIL import Image
            import pytesseract
            text = pytesseract.image_to_string(Image.open(_io.BytesIO(raw)))
        except Exception:
            raise HTTPException(422, "OCR could not read this image - try a sharper screenshot, or paste the text into the Capture Agent")
        if not text.strip():
            raise HTTPException(422, "OCR found no text in this image - try a sharper screenshot, or paste the text into the Capture Agent")
        return text, "ocr"
    try:
        return raw.decode("utf-8"), "text"
    except UnicodeDecodeError:
        raise HTTPException(422, "this file is not readable as text, PDF or image - upload a .csv, .txt, .eml, .pdf, .png or .jpg")

class FileImportIn(BaseModel):
    kind: str = "payments"; filename: str = ""; content_b64: str = ""; mode: str = "replace"

@app.post("/api/v1/import/file")
def import_file(body: FileImportIn, request: Request, ctx=Depends(auth_context)):
    """The Upload Center's single file door. CSV content runs the CSV
    importers; a remittance advice (pasted email file, PDF letter, OCR
    screenshot) runs the Capture Agent and stages the one payment it
    finds, verified against the open ledger. A file we cannot read is
    refused with the reason - never silently dropped."""
    need(ctx, "run"); repo = repo_for(ctx["tenant_id"])
    import base64 as _b64
    try:
        raw = _b64.b64decode(body.content_b64 or "", validate=True)
    except Exception:
        raise HTTPException(422, "the uploaded content is not valid base64")
    if not raw:
        raise HTTPException(422, "the file is empty")
    if len(raw) > 8 * 1024 * 1024:
        raise HTTPException(413, "file too large - the limit is 8 MB")
    text, how = _extract_file_text(raw, body.filename)
    kind = (body.kind or "payments").lower()
    if kind == "invoices":
        if parse_invoices_csv(text)["invoices"]:
            r = import_invoices({"csv_text": text, "mode": body.mode or "replace"}, ctx)
            r["route"] = "csv"; r["extracted_via"] = how
            return r
        raise HTTPException(422, "no invoice rows could be read from this file - invoices need CSV columns (invoice id, customer, amount, age). Extracted text begins: " + " ".join(text.split())[:240])
    if kind == "payments":
        # Bank lockbox / statement files (BAI2, MT940, camt.054) are
        # sniffed before the CSV reader: their lines are not CSV and
        # must never fall through to the single-wire Capture Agent.
        from lockbox import sniff_lockbox_format, PARSERS
        fmt = sniff_lockbox_format(text, body.filename)
        if fmt:
            pays = PARSERS[fmt](text)
            if not pays:
                raise HTTPException(422, f"this file looks like a {fmt} bank file but no credit entries could be read from it")
            for p in pays: repo.add_payment(p, payment_fingerprint(p))
            if not repo.get_meta("active_case"):
                repo.set_meta("active_case", {"id": "upload", "name": "Uploaded files", "source": "upload",
                                              "loaded_at": _now_iso(), "expect": {}, "expect_exceptions": {},
                                              "story": _uploaded_story(repo, "A bank lockbox file was uploaded into an empty workspace")})
            pol = _policy_for(repo, ctx["tenant_id"], None)
            run = run_batch(repo, repo.all_payments(), pol,
                            "lockbox-" + uuid.uuid4().hex[:10], actor=f"api:{ctx['role']}")
            _finish_run_outputs(repo, run)
            return {"route": "lockbox", "format": fmt, "extracted_via": how,
                    "imported": len(pays), "run": run}
    if parse_payments_csv(text)["payments"]:
        r = import_payments({"csv_text": text}, ctx)
        r["route"] = "csv"; r["extracted_via"] = how
        return r
    invs = repo.open_invoices()
    client, _budget = _gemini_for(request)
    parsed = parse_remittance(text, {i.invoice_id for i in invs},
                              {i.po_number for i in invs if i.po_number}, client=client)
    f = parsed["fields"]
    if not f.get("amount_cents"):
        raise HTTPException(422, "the Capture Agent could not find a payment amount in this file. Extracted text begins: " + " ".join(text.split())[:240])
    pid = "WIRE-" + uuid.uuid4().hex[:8].upper()
    p = Payment(payment_id=pid, payer_raw=f.get("payer") or "Unknown payer",
                amount_cents=int(f["amount_cents"]),
                claimed_deduction_cents=int(f.get("deduction_cents") or 0),
                deduction_reason_raw=str(f.get("deduction_reason") or ""),
                remittance_text=text[:4000],
                references=list(f.get("invoice_refs") or []) + list(f.get("po_refs") or []))
    repo.add_payment(p, payment_fingerprint(p))
    if not repo.get_meta("active_case"):
        repo.set_meta("active_case", {"id": "upload", "name": "Uploaded files", "source": "upload",
                                      "loaded_at": _now_iso(), "expect": {}, "expect_exceptions": {},
                                      "story": _uploaded_story(repo, "A remittance file was uploaded into an empty workspace")})
    return {"route": "remittance", "extracted_via": how, "staged": pid, "fields": f,
            "verification": parsed["verification"], "source": parsed["source"],
            "ai_state": parsed.get("ai_state"), "workspace": _workspace_state(repo)}

@app.get("/api/v1/runs")
def list_runs(ctx=Depends(auth_context)):
    need(ctx, "read"); return repo_for(ctx["tenant_id"]).list_runs()

@app.get("/api/v1/methodology")
def methodology():
    """How every number is computed - served with the code it describes."""
    return {"sections": METHODOLOGY}

@app.get("/api/v1/scenarios")
def scenarios():
    out = []
    for s in SCENARIOS:
        invs, pays = s["build"]()
        out.append({"id": s["id"], "title": s["title"], "story": s["story"], "shows": s["shows"],
                    "invoices": len(invs), "payments": len(pays),
                    "customers": len({i.customer for i in invs}),
                    "open_cents": sum(i.gross_cents for i in invs),
                    "batch_cents": sum(p.amount_cents for p in pays)})
    return out

@app.post("/api/v1/scenarios/custom/run")
def run_custom_case(payload: dict, ctx=Depends(auth_context)):
    """Build-your-own case: caller-supplied invoices and payments, run in a
    clean room against the production engine. Every result carries the full
    derivation, so a reviewer can test the engine on their own numbers."""
    need(ctx, "run")
    from domain import Invoice as _Inv, Payment as _Pay
    invs = [_Inv(invoice_id=str(i["invoice_id"]), customer=str(i.get("customer", "UNKNOWN")),
                 subsidiary=str(i.get("customer", "UNKNOWN")), gross_cents=int(i["gross_cents"]),
                 po_number=i.get("po_number") or None, discount_rate=float(i.get("discount_rate", 0) or 0),
                 age_days=int(i.get("age_days", 0) or 0)) for i in payload.get("invoices", [])]
    pays = [_Pay(payment_id=str(p["payment_id"]), payer_raw=str(p.get("payer_raw", "UNKNOWN")),
                 amount_cents=int(p["amount_cents"]), claimed_deduction_cents=int(p.get("claimed_deduction_cents", 0) or 0),
                 deduction_reason_raw=str(p.get("deduction_reason_raw", "") or ""),
                 pod_verified_clean=bool(p.get("pod_verified_clean", False)),
                 remittance_text=str(p.get("remittance_text", "") or ""),
                 references=list(p.get("references", []) or [])) for p in payload.get("payments", [])]
    if not invs or not pays: raise HTTPException(400, "a case needs at least one invoice and one payment")
    mem = Repository(":memory:")
    for inv in invs: mem.add_invoice(inv)
    run = run_batch(mem, pays, Policy(), "custom-" + uuid.uuid4().hex[:8], actor="custom-case")
    return {"run": run}

@app.post("/api/v1/workspace/load-custom")
def load_custom_case(payload: dict, ctx=Depends(auth_context)):
    """Builder cases join the same shared workspace as every other case:
    staged here, they run from Run Reconciliation like anything else."""
    need(ctx, "run"); repo = repo_for(ctx["tenant_id"])
    from domain import Invoice as _Inv, Payment as _Pay
    invs = [_Inv(invoice_id=str(i["invoice_id"]), customer=str(i.get("customer", "UNKNOWN")),
                 subsidiary=str(i.get("customer", "UNKNOWN")), gross_cents=int(i["gross_cents"]),
                 po_number=i.get("po_number") or None, discount_rate=float(i.get("discount_rate", 0) or 0),
                 age_days=int(i.get("age_days", 0) or 0)) for i in payload.get("invoices", [])]
    pays = [_Pay(payment_id=str(p["payment_id"]), payer_raw=str(p.get("payer_raw", "UNKNOWN")),
                 amount_cents=int(p["amount_cents"]), claimed_deduction_cents=int(p.get("claimed_deduction_cents", 0) or 0),
                 deduction_reason_raw=str(p.get("deduction_reason_raw", "") or ""),
                 pod_verified_clean=bool(p.get("pod_verified_clean", False)),
                 remittance_text=str(p.get("remittance_text", "") or ""),
                 references=list(p.get("references", []) or [])) for p in payload.get("payments", [])]
    if not invs or not pays: raise HTTPException(400, "a case needs at least one invoice and one payment")
    repo.clear_workspace()
    for inv in invs: repo.add_invoice(inv)
    for p in pays: repo.add_payment(p, payment_fingerprint(p))
    repo.set_meta("active_case", {"id": "custom", "name": "Custom case (builder)", "source": "custom",
                                  "loaded_at": _now_iso(), "expect": {}, "expect_exceptions": {},
                                  "story": _uploaded_story(repo, "A custom case built in the Case Builder")})
    repo.audit(f"api:{ctx['role']}", "case_loaded", "workspace", "custom",
               {"invoices": len(invs), "payments": len(pays)}, _now_iso())
    # Same rule as a named case: loading runs it in the same call.
    run = run_batch(repo, pays, _policy_for(repo, ctx["tenant_id"], None),
                    "autorun-" + uuid.uuid4().hex[:10], actor=f"api:{ctx['role']}")
    _finish_run_outputs(repo, run)
    return {"workspace": _workspace_state(repo), "payments": [asdict(p) for p in pays],
            "run": run}

@app.post("/api/v1/scenarios/{sid}/run")
def run_scenario(sid: str, ctx=Depends(auth_context)):
    """Clean-room scenario run: a fresh in-memory ledger, so use cases never
    pollute the workspace. The outcome is verified against the pack's stated
    expectations and every check is reported, pass or fail."""
    need(ctx, "run")
    sc = get_scenario(sid)
    if not sc: raise HTTPException(404, "unknown scenario")
    invs, pays = sc["build"]()
    mem = Repository(":memory:")
    for inv in invs: mem.add_invoice(inv)
    # Grading policy: identical to production except the maker-checker
    # threshold is raised, so a pack's verdict isolates matching correctness.
    # Approval gating itself is covered by the approvals queue and its tests.
    run = run_batch(mem, pays, Policy(maker_checker_threshold_cents=10**12),
                    f"scenario-{sid}", actor="scenario")
    by_pid = {r["payment_id"]: r for r in run["results"]}
    ex_by_pid = {e["payment_id"]: e["kind"] for e in run["exceptions"]}
    checks = []
    for pid, exp in sc["expect"].items():
        if pid == "exceptions":
            for epid, kind in exp.items():
                actual = ex_by_pid.get(epid)
                checks.append({"label": f"{epid} flagged {kind}", "expected": kind, "actual": actual, "pass": actual == kind})
            continue
        r = by_pid.get(pid, {})
        if "status" in exp:
            checks.append({"label": f"{pid} status", "expected": exp["status"], "actual": r.get("status"), "pass": r.get("status") == exp["status"]})
        if "auto_posted" in exp:
            checks.append({"label": f"{pid} auto-posted", "expected": exp["auto_posted"], "actual": r.get("auto_posted"), "pass": r.get("auto_posted") == exp["auto_posted"]})
        if "invoices" in exp:
            got = {l["invoice_id"] for l in r.get("lines", [])}
            checks.append({"label": f"{pid} matched invoices", "expected": sorted(exp["invoices"]), "actual": sorted(got), "pass": got == exp["invoices"]})
        if "residual_cents" in exp:
            checks.append({"label": f"{pid} residual", "expected": exp["residual_cents"], "actual": r.get("residual_cents"), "pass": r.get("residual_cents") == exp["residual_cents"]})
        if "deduction_action" in exp:
            ded = r.get("deduction") or {}
            checks.append({"label": f"{pid} deduction decision", "expected": exp["deduction_action"], "actual": ded.get("autonomous_action"), "pass": ded.get("autonomous_action") == exp["deduction_action"]})
            checks.append({"label": f"{pid} ERP reason code", "expected": exp["erp_reason_code"], "actual": ded.get("assigned_erp_reason_code"), "pass": ded.get("assigned_erp_reason_code") == exp["erp_reason_code"]})
        if "spike" in exp:
            ded = r.get("deduction") or {}
            checks.append({"label": f"{pid} anomaly spike flagged", "expected": exp["spike"], "actual": ded.get("is_anomalous_spike"), "pass": ded.get("is_anomalous_spike") == exp["spike"]})
    return {"policy_note": "Graded under the production policy with the maker-checker threshold raised, so the verdict isolates matching correctness; approval gating is exercised separately in the approvals queue.",
            "scenario": {"id": sc["id"], "title": sc["title"], "story": sc["story"], "shows": sc["shows"]},
            "run": run, "checks": checks, "all_pass": all(c["pass"] for c in checks)}


class StreamIn(BaseModel):
    seed: bool = False
    payments: list[PaymentIn] = []
    policy: dict | None = None
    use_workspace: bool = False

@app.post("/api/v1/runs/stream")
def run_stream(body: StreamIn, ctx=Depends(auth_context)):
    """Live run: the batch engine streams every mechanism step as it happens
    (resolve -> solve -> deduction -> decision) over server-sent events."""
    need(ctx, "run"); repo = repo_for(ctx["tenant_id"])
    if body.seed:
        payments = _load_case(repo, "seed", f"api:{ctx['role']}")
    elif body.payments:
        payments = [_pay(p) for p in body.payments]
        for p in payments: repo.add_payment(p, payment_fingerprint(p))
    elif body.use_workspace:
        payments = repo.pending_payments()
        if not payments:
            # Replay for show: every staged payment is already
            # reconciled, so the stream re-runs the case on a scratch
            # copy of the workspace (the policy-preview pattern). The
            # live lanes animate the real engine; the real workspace -
            # its matches, decisions and drafts - is never touched.
            import tempfile, shutil as _sh2
            _td2 = tempfile.mkdtemp(prefix="slatematch-replay-")
            trepo = Repository(os.path.join(_td2, "replay.db"))
            for inv in repo.all_invoices(): trepo.add_invoice(inv)
            for p0 in repo.all_payments(): trepo.add_payment(p0, "")
            for row in repo.conn.execute("SELECT raw_name, customer, source FROM aliases").fetchall():
                trepo.conn.execute("INSERT OR REPLACE INTO aliases VALUES (?,?,?)", row)
            trepo.conn.commit()
            pol = _policy_for(repo, ctx["tenant_id"], None)
            q0 = _queue.Queue()
            try:
                r0 = run_batch(trepo, trepo.all_payments(), pol, "replay-" + uuid.uuid4().hex[:10],
                               actor="stream-replay", on_event=q0.put)
            finally:
                trepo.conn.close(); _sh2.rmtree(_td2, ignore_errors=True)
            events = []
            while not q0.empty(): events.append(q0.get())
            def _replay_gen():
                for e in events:
                    yield f"data: {json.dumps(e)}\n\n"
                yield f"data: {json.dumps({'type': 'batch_done', 'run_id': r0['run_id'], 'payments': r0['payments'], 'auto_posted': r0['auto_posted'], 'replay': True})}\n\n"
            return StreamingResponse(_replay_gen(), media_type="text/event-stream")
    else:
        payments = []
    pol = _policy_for(repo, ctx["tenant_id"], None)
    q = _queue.Queue()
    def _run():
        try:
            run = run_batch(repo, payments, pol, "live-" + uuid.uuid4().hex[:10],
                            actor=f"api:{ctx['role']}", on_event=q.put)
            _finish_run_outputs(repo, run)
        except Exception as e:
            q.put({"type": "error", "message": str(e)})
        finally:
            q.put(None)
    _threading.Thread(target=_run, daemon=True).start()
    def gen():
        while True:
            item = q.get()
            if item is None: break
            yield f"data: {json.dumps(item)}\n\n"
    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

@app.get("/api/v1/approvals")
def approvals(ctx=Depends(auth_context)):
    need(ctx, "read"); return repo_for(ctx["tenant_id"]).list_proposed()

class DecisionIn(BaseModel):
    decision: str

@app.post("/api/v1/matches/{match_id}/decision")
def match_decision(match_id: str, body: DecisionIn, ctx=Depends(auth_context)):
    need(ctx, "approve"); repo = repo_for(ctx["tenant_id"])
    m = repo.get_match(match_id)
    if not m: raise HTTPException(404, "match not found")
    if m["status"] != "PROPOSED": raise HTTPException(409, f"match is {m['status']}, not PROPOSED")
    if body.decision not in ("approve", "reject"): raise HTTPException(422, "decision must be approve or reject")
    res = m["result"]
    decided_at = _now_iso()
    # A content fingerprint over the decision record: anyone holding the
    # audit entry can recompute it and prove the entry was not altered.
    fingerprint = hashlib.sha256(
        f"{match_id}|{m['payment_id']}|{body.decision}|{ctx['role']}|{decided_at}".encode()
    ).hexdigest()
    lines = res.get("lines") or []
    # A record with no lines is not a match at all - it is the solver's
    # refusal verdict (nothing in the ledger explains this wire). There
    # is nothing to post: issuing a clearing document for it would put a
    # DZ number on money no invoice supports and corrupt the ledger. The
    # only honest approval for a refusal is to accept the verdict and
    # park the wire in unapplied suspense, which is what approve means
    # for a zero-line record - no document, no settlement, no mail.
    refusal = not lines
    erp_document_id = None
    settled = []
    partials = []
    parked = False
    alloc_mode_used = None
    alloc_note = None
    if body.decision == "approve" and not refusal:
        # The posting document reference for this approval, derived from
        # the decision fingerprint - the ERP preview on the match shows
        # the same id, so the approval and the document can be tied
        # together by anyone holding either one.
        erp_document_id = "DZ-" + fingerprint[:10].upper()
        residual_cents = res.get("residual_cents")
        if residual_cents is None:
            # Stored match results carry the residual inside the
            # derivation equation, not as a top-level field.
            residual_cents = ((res.get("derivation") or {}).get("equation") or {}).get("residual_cents") or 0
        if residual_cents >= 0:
            # Fully covered - exact, or overpaid with the excess carried
            # as an on-account credit in the clearing document: every
            # line invoice is settled in full.
            settled = [l["invoice_id"] for l in lines]
        else:
            # Partial payment: the applied cash is spread across the
            # lines by the tenant policy's allocation mode (pro-rata,
            # the long-standing default; oldest-first; or the
            # remittance's own per-invoice amounts). A line the cash
            # covers in full settles; every other line stays OPEN
            # with its balance reduced by what was actually applied.
            # Settling a part-paid invoice in full would erase a live
            # receivable from the ledger and the forecast.
            from batch import allocate_partial_payment
            from ai import amounts_for_refs
            total_net = sum(l.get("net_cents") or 0 for l in lines)
            applied_total = total_net + residual_cents
            pol = _policy_for(repo, ctx["tenant_id"], None)
            _meta = {i.invoice_id: i for i in repo.all_invoices()}
            _pay_rec = res.get("payment") or {}
            _specified = (amounts_for_refs(_pay_rec.get("remittance_text") or "",
                                           [l["invoice_id"] for l in lines])
                          if pol.partial_allocation_mode == "explicit_line" else {})
            _allocs, alloc_mode_used, alloc_note = allocate_partial_payment(
                lines, applied_total, pol.partial_allocation_mode, _meta, _specified)
            for l in lines:
                applied_i = _allocs.get(l["invoice_id"], 0)
                if applied_i >= (l.get("gross_cents") or 0):
                    settled.append(l["invoice_id"])
                else:
                    partials.append({"invoice_id": l["invoice_id"],
                                     "applied_cents": applied_i,
                                     "remaining_cents": (l.get("gross_cents") or 0) - applied_i})
    elif body.decision == "approve" and refusal:
        parked = True
    res["approval"] = {"decision": body.decision, "by_role": ctx["role"],
                       "at": decided_at, "fingerprint": fingerprint,
                       "erp_document_id": erp_document_id,
                       "settled_invoices": settled,
                       "partial_application": partials,
                       "allocation_mode": alloc_mode_used,
                       "allocation_note": alloc_note,
                       "parked_in_suspense": parked}
    if body.decision == "reject":
        new_status = "REJECTED"
    elif parked:
        new_status = "PARKED_SUSPENSE"
    else:
        new_status = "APPROVED_POSTED"
    # Unit of work: the compare-and-set status flip, the invoice
    # settlements or reductions, the learned alias, the audit entry
    # and the settlement draft are one decision - they land together
    # or not at all. A concurrent-decision 409 raised inside rolls
    # back cleanly (the CAS wrote nothing) and still propagates.
    repo.begin()
    try:
        if not repo.update_match_if_proposed(match_id, new_status, res):
            raise HTTPException(409, "match was decided by a concurrent request - refresh and review")
        if settled:
            repo.settle_invoices(settled)
        for _pa in partials:
            repo.reduce_invoice_gross(_pa["invoice_id"], _pa["remaining_cents"])
        if new_status == "APPROVED_POSTED":
            # Learn the payer's alias from a human-confirmed match: the
            # name on the wire now maps to this customer in future runs.
            pay0 = res.get("payment") or {}
            cust0 = None
            _first_iid = settled[0] if settled else (partials[0]["invoice_id"] if partials else None)
            if _first_iid:
                row0 = repo.get_invoice_row(_first_iid)
                cust0 = (row0 or {}).get("customer")
            if pay0.get("payer_raw") and cust0 and pay0["payer_raw"].strip().lower() != cust0.strip().lower():
                repo.add_alias(pay0["payer_raw"], cust0, "approval")
        repo.audit(f"api:{ctx['role']}",
                   "match_parked_suspense" if parked else f"match_{body.decision}d",
                   "match", match_id,
                   {"payment_id": m["payment_id"], "run_id": m["run_id"],
                    "fingerprint": fingerprint, "erp_document_id": erp_document_id,
                    "settled_invoices": settled,
                    "partial_application": partials}, decided_at)
        if body.decision == "approve" and not parked:
            # The approval itself generates the Category-3 settlement
            # confirmation in the Mail Hub, citing the clearing document
            # this decision just issued.
            pay = res.get("payment") or {}
            d = settlement_draft(pay.get("payer_raw") or "Customer", m["payment_id"],
                                 res.get("lines") or [], erp_document_id,
                                 {p["invoice_id"]: p["remaining_cents"] for p in partials})
            repo.add_outbox(pay.get("payer_raw") or "Customer", d["subject"], d["body"],
                            "settlement_confirmation", f"{m['run_id']}:{m['payment_id']}", "draft",
                            "Generated by the maker-checker approval - review and send from the Outbound Mail Hub",
                            decided_at)
    except Exception:
        repo.rollback()
        raise
    repo.commit()
    _fire_webhooks(repo, "approval.decided",
                   {"match_id": match_id, "payment_id": m["payment_id"],
                    "decision": body.decision, "status": new_status})
    return {"match_id": match_id, "status": new_status, "fingerprint": fingerprint,
            "erp_document_id": erp_document_id, "settled_invoices": settled,
            "parked_in_suspense": parked}

@app.get("/api/v1/audit")
def audit_trail(ctx=Depends(auth_context)):
    need(ctx, "read"); return repo_for(ctx["tenant_id"]).audit_list()

@app.get("/api/v1/runs/{run_id}/matches")
def run_matches(run_id: str, ctx=Depends(auth_context)):
    need(ctx, "read"); return repo_for(ctx["tenant_id"]).matches_for_run(run_id)

@app.get("/api/v1/runs/{run_id}/exceptions")
def run_exceptions(run_id: str, ctx=Depends(auth_context)):
    need(ctx, "read"); return repo_for(ctx["tenant_id"]).exceptions_for_run(run_id)

AGENT_ORDER = ["Capture Agent", "Linking Agent", "Matching Agent",
               "Deduction Agent", "Policy Agent", "Briefing Agent"]

@app.get("/api/v1/runs/{run_id}/agents")
def run_agents(run_id: str, ctx=Depends(auth_context)):
    """The six-agent pipeline for one run, from the steps the engine
    recorded while it worked - status, measured latency, and the
    evidence payload each agent handed to the next."""
    need(ctx, "read"); repo = repo_for(ctx["tenant_id"])
    steps = repo.steps_for_run(run_id)
    by_agent = {s["agent"]: s for s in steps}
    agents = [by_agent[a] for a in AGENT_ORDER if a in by_agent]
    legacy = [s for s in steps if s["agent"] not in AGENT_ORDER]
    return {"run_id": run_id, "agents": agents, "legacy_steps": legacy}

@app.post("/api/v1/parse")
def parse(body: ParseIn, request: Request, ctx=Depends(auth_context)):
    need(ctx, "parse"); invs = repo_for(ctx["tenant_id"]).open_invoices()
    client, budget = _gemini_for(request)
    t0 = _time.perf_counter()
    out = parse_remittance(body.text, {i.invoice_id for i in invs}, {i.po_number for i in invs if i.po_number},
                           client=client)
    extract_ms = round((_time.perf_counter() - t0) * 1000, 1)
    f = out["fields"]; v = out["verification"]
    checked = len(f.get("invoice_refs", [])) + len(f.get("po_refs", []))
    out["ai_mode"] = "gemini" if out["source"] == "gemini" else "deterministic"
    out["ai_budget"] = budget
    if budget == "exhausted":
        out["ai_note"] = ("This address has used its per-minute AI budget on the "
                          "public demo, so the deterministic parser answered. "
                          "Nothing is blocked - the same fields, verified the same way.")
    out["pipeline"] = [
        {"stage": "1. Extract", "engine": out["source"], "ms": extract_ms,
         "detail": "AI reads the free text and proposes structured fields" if out["source"] == "gemini"
                   else "Deterministic extractor proposes structured fields (Gemini did not answer - the backup answered)" if out.get("ai_state") == "call_failed"
                   else "Deterministic extractor proposes structured fields (Gemini activates when a server key is configured)"},
        {"stage": "2. Schema check", "engine": "validator", "ms": 0,
         "detail": "Required fields present: payer, amount, invoice refs, PO refs, deduction"},
        {"stage": "3. Verify references", "engine": "ledger check", "ms": 0,
         "detail": f"{checked} reference(s) checked against the open ledger; {len(v['issues'])} flagged",
         "issues": v["issues"]},
        {"stage": "4. Trust decision", "engine": "policy", "ms": 0,
         "detail": "Verified - safe to reconcile" if v["verified"] else "Not fully verified - flagged references must be resolved by a human first"}]
    return out

@app.get("/api/v1/runs/{run_id}/brief")
def run_brief_ep(run_id: str, request: Request, ctx=Depends(auth_context)):
    """The agent's own brief of a finished run - what it posted, what it
    held and why, and what a human should do next."""
    need(ctx, "read"); repo = repo_for(ctx["tenant_id"])
    if run_id not in {r["run_id"] for r in repo.list_runs(50)}:
        raise HTTPException(404, "unknown run")
    client, _budget = _gemini_for(request)
    return run_brief(repo, run_id, client=client)

class DraftIn(BaseModel):
    kind: str = "dispute_email"; tone: str = "strict"; facts: dict = {}

@app.post("/api/v1/ai/draft")
def ai_draft(body: DraftIn, request: Request, ctx=Depends(auth_context)):
    """Draft a dispute email or a negotiation rebuttal from case facts.
    Gemini rewrites when a key is configured; the grounded template is
    the fallback and the source is always returned."""
    need(ctx, "run")
    if body.kind not in ("dispute_email", "rebuttal", "chase_email"):
        raise HTTPException(422, "kind must be dispute_email, rebuttal or chase_email")
    facts = dict(body.facts or {})
    if body.kind in ("dispute_email", "rebuttal") and facts.get("payment_id"):
        # Proof-of-delivery state is a fact of record, not a drafting
        # choice: take it from the stored match so no draft can claim a
        # clean signed POD the record does not support.
        repo = repo_for(ctx["tenant_id"])
        m = repo.latest_match_for_payment(str(facts["payment_id"]))
        if m:
            facts["pod_clean"] = bool((m["result"].get("payment") or {}).get("pod_verified_clean"))
    client, _budget = _gemini_for(request)
    return draft_message(body.kind, body.tone, facts, client=client)

@app.get("/api/v1/tenants/demo")
def demo_tenants(ctx=Depends(auth_context)):
    return {"switching_enabled": ctx.get("mode") == "dev-open",
            "active": ctx.get("base_tenant", ctx["tenant_id"]),
            "session": ctx.get("session"),
            "tenants": DEMO_TENANTS,
            "note": ("Each tenant has its own database - invoices, payments, runs, "
                     "policy and keys never cross. On top of that, every browser "
                     "session gets its own clone of the demo workspace, so two "
                     "people opening the public link at the same time never wipe "
                     "each other's screen. Switching and sessions are enabled in "
                     "this open demo; with API keys issued, the key decides the "
                     "tenant and both headers are ignored.")}

def _client_ip(request):
    # Behind the ALB, the proxy APPENDS the real client IP as the LAST
    # X-Forwarded-For hop. The first hop is whatever the client claimed
    # and is spoofable, so keying the AI budget on it let one caller
    # mint a fresh "IP" per request. Trust the last hop.
    fwd = request.headers.get("x-forwarded-for", "")
    if fwd:
        hops = [h.strip() for h in fwd.split(",") if h.strip()]
        if hops:
            return hops[-1]
    return request.client.host if request.client else ""

def _gemini_for(request):
    """(client, budget_state) for one request. When this IP is over its
    Gemini budget, the client is disabled and every AI feature answers
    from its deterministic path instead of erroring."""
    if AI_BUDGET.allow(_client_ip(request)):
        return GeminiClient(), "ok"
    return GeminiClient(api_key=""), "exhausted"

@app.get("/api/v1/payments/{payment_id}/erp-document")
def erp_document(payment_id: str, ctx=Depends(auth_context)):
    need(ctx, "read"); repo = repo_for(ctx["tenant_id"])
    m = repo.latest_match_for_payment(payment_id)
    if not m: raise HTTPException(404, "no match recorded for this payment yet")
    res = m["result"]
    # A document number exists once a match has CLEARED (auto-posted
    # or approved). A merely proposed match gets a preview: no number.
    doc_id = (res.get("approval") or {}).get("erp_document_id") or (
        document_number_for(m["match_id"]) if m["status"] in ("AUTO_POSTED", "APPROVED_POSTED") else None)
    customers = {i.invoice_id: i.customer for i in repo.all_invoices()}
    doc = document_for_match(res, res.get("payment") or {"payment_id": payment_id},
                                 document_number=doc_id, customers=customers)
    out = {"match_id": m["match_id"], "run_id": m["run_id"], "status": m["status"],
           "document": doc}
    ded = res.get("deduction") or {}
    if ded.get("autonomous_action") == "AUTO_GENERATE_DISPUTE_CLAIM":
        out["revrec_accrual"] = dispute_accrual_journal(ded)
    return out

@app.get("/api/v1/erp/run-documents")
def erp_run_documents(ctx=Depends(auth_context)):
    """Step 4's stage data: every posting document the latest run's
    cleared payments generated, with run-level totals, plus the
    ASC 606 / IFRS 15 dispute-reserve journals for its claims. Built
    with the same erp_sap functions as the per-payment document, from
    the same stored match records - nothing re-derived."""
    need(ctx, "read"); repo = repo_for(ctx["tenant_id"])
    runs = repo.list_runs(1)
    if not runs:
        return {"run_id": None, "documents": [], "reserve": None,
                "totals": {"documents": 0, "debit_cents": 0, "credit_cents": 0, "balanced": True}}
    run = runs[0]
    docs, claims = [], []
    customers = {i.invoice_id: i.customer for i in repo.all_invoices()}
    total_dr = total_cr = 0
    for m in repo.matches_for_run(run["run_id"]):
        res = m["result"] or {}
        if m["status"] in ("AUTO_POSTED", "APPROVED_POSTED") and res.get("lines"):
            doc_id = (res.get("approval") or {}).get("erp_document_id") or document_number_for(m["match_id"])
            doc = document_for_match(res, res.get("payment") or {"payment_id": m["payment_id"]},
                                         document_number=doc_id, customers=customers)
            docs.append({"payment_id": m["payment_id"], "status": m["status"],
                         "payer": (res.get("payment") or {}).get("payer_raw", ""),
                         "document": doc})
            total_dr += doc["total_debits_cents"]; total_cr += doc["total_credits_cents"]
        ded = res.get("deduction") or {}
        if ded.get("autonomous_action") == "AUTO_GENERATE_DISPUTE_CLAIM":
            claims.append({"payment_id": m["payment_id"],
                           "claimed_cents": ded.get("claimed_cents", 0),
                           "journal": dispute_accrual_journal(ded)})
    docs.sort(key=lambda d: d["payment_id"])
    reserve = None
    if claims:
        reserve = {"claims": len(claims),
                   "claimed_cents": sum(c["claimed_cents"] for c in claims),
                   "journals": claims}
    return {"run_id": run["run_id"], "documents": docs, "reserve": reserve,
            "totals": {"documents": len(docs), "debit_cents": total_dr,
                       "credit_cents": total_cr, "balanced": total_dr == total_cr}}

@app.get("/api/v1/diagnostics")
def diagnostics(ctx=Depends(auth_context)):
    need(ctx, "read")
    import random
    binpath = _env("KERNEL_BIN", "")
    kernel_present = bool(binpath and os.path.exists(binpath))
    probe = {"cases": 0, "agree": 0, "status": "kernel_absent"}
    if kernel_present:
        rng = random.Random(20261101)
        cases = agree = 0
        for _ in range(24):
            invs = [{"invoice_id": f"I{i}", "gross_cents": rng.randrange(500, 90000),
                     "age_days": rng.randrange(1, 120)} for i in range(rng.randrange(3, 9))]
            target = sum(i["gross_cents"] for i in invs[:2]) + rng.randrange(0, 5000)
            py = rust_bridge.best_subset_py(target, invs)
            rs = rust_bridge.best_subset_rust(target, invs)
            cases += 1
            if rs and rs["selected_ids"] == py["selected_ids"] \
               and rs["selected_sum_cents"] == py["selected_sum_cents"]:
                agree += 1
        probe = {"cases": cases, "agree": agree,
                 "status": "pass" if agree == cases else "fail"}
    tests_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tests")
    modules = []
    if os.path.isdir(tests_dir):
        modules = sorted(f[:-3] for f in os.listdir(tests_dir)
                         if f.startswith("test_") and f.endswith(".py"))
    from ai import LAST_GEMINI_ERROR
    return {
        "rust_kernel": {"binary": binpath or None, "present": kernel_present,
                        "bridge": "rust_bridge.py - the Rust binary is called over stdio with a JSON payload",
                        "equivalence_probe": probe,
                        "equivalence_suite": "test_rust_equivalence.py compares the Rust kernel with the Python reference on 203 generated cases; it runs in the repository suite and in CI"},
        "milp": {"solver": "HiGHS, via scipy.optimize.milp",
                 "exact_recheck": "every MILP result is re-verified in exact integer cents before it is used; a set that is even one cent off is rejected"},
        "test_suite": {"modules": modules, "module_count": len(modules),
                       "ci": "GitHub Actions runs pytest and cargo test before every image build"},
        "ai": {"gemini_configured": GeminiClient().available,
               "gemini_last_error": LAST_GEMINI_ERROR["error"]},
        "mail": mail_config_public(),
    }

def _build_bundle(ctx):
    """The month-end bundle data: the active case, the
    latest run with every match's full MILP derivation, the exceptions,
    the maker-checker audit trail (fingerprints included), and the SAP
    posting document for every match, built by erp_sap."""
    repo = repo_for(ctx["tenant_id"])
    ws = _workspace_state(repo)
    if not ws.get("latest_run"):
        raise HTTPException(409, "nothing to export yet - this workspace has no run. Load a case or run the staged payments first")
    bundle = {"product": "SlateMatch",
              "kind": "executive-audit-and-sap-clearing-bundle",
              "generated_at": _now_iso(),
              "tenant": ctx.get("base_tenant", ctx["tenant_id"]),
              "case": ws.get("case"),
              "workspace": {"open_invoices": ws["open_invoices"],
                            "staged_payments": ws["staged_payments"],
                            "pending_payments": len(ws["pending_payments"]),
                            "approvals_pending": ws["approvals_pending"]},
              "model_metrics": models()["metrics"]}
    runs = repo.list_runs(1)
    if runs:
        run = runs[0]
        matches = repo.matches_for_run(run["run_id"])
        docs = {}
        customers = {i.invoice_id: i.customer for i in repo.all_invoices()}
        for m in matches:
            res = m["result"]
            if res.get("lines"):
                docs[m["payment_id"]] = document_for_match(
                    res, res.get("payment") or {"payment_id": m["payment_id"]},
                    document_number=(res.get("approval") or {}).get("erp_document_id") or (
                        document_number_for(m["match_id"]) if m["status"] in ("AUTO_POSTED", "APPROVED_POSTED") else None),
                    customers=customers)
        bundle["run"] = run
        bundle["matches"] = matches
        bundle["exceptions"] = repo.exceptions_for_run(run["run_id"])
        bundle["sap_documents"] = docs
    bundle["audit_trail"] = repo.audit_list(300)
    return bundle


@app.get("/api/v1/export/bundle")
def export_bundle(ctx=Depends(auth_context)):
    need(ctx, "read")
    return JSONResponse(_build_bundle(ctx), headers={
        "Content-Disposition": 'attachment; filename="slatematch-audit-bundle.json"'})


_pdf_cache = {}

@app.get("/api/v1/export/bundle.pdf")
def export_bundle_pdf(ctx=Depends(auth_context)):
    """The same bundle as a clean, print-ready PDF (bundle_pdf.py).

    Rendering is the slowest call in the product (seconds, against
    single-digit milliseconds elsewhere), and controllers routinely
    download the same bundle twice. The bundle dict is assembled
    fresh on every call (cheap) and hashed with its one volatile
    field (generated_at) excluded; the rendered bytes are served
    from memory while the underlying bundle is identical, so any
    new run, decision or audit entry re-renders exactly once, and
    a repeat download returns the same file, stamp included."""
    need(ctx, "read")
    bundle = _build_bundle(ctx)
    stable = {k: v for k, v in bundle.items() if k != "generated_at"}
    key = hashlib.sha256(json.dumps(stable, sort_keys=True, default=str).encode()).hexdigest()
    cache_key = (ctx["tenant_id"], key)
    pdf = _pdf_cache.get(cache_key)
    if pdf is None:
        from bundle_pdf import render_bundle_pdf
        pdf = render_bundle_pdf(bundle)
        if len(_pdf_cache) > 8:
            _pdf_cache.clear()
        _pdf_cache[cache_key] = pdf
    return Response(pdf, media_type="application/pdf", headers={
        "Content-Disposition": 'attachment; filename="slatematch-audit-bundle.pdf"'})

@app.get("/api/v1/export/matches.csv")
def export_matches_csv(ctx=Depends(auth_context)):
    need(ctx, "read"); repo = repo_for(ctx["tenant_id"])
    import csv as _csv, io as _io
    buf = _io.StringIO(); w = _csv.writer(buf)
    w.writerow(["run_id", "payment_id", "status", "solver", "invoices",
                "gross_cents", "discount_cents", "net_applied_cents",
                "residual_cents", "confidence", "erp_document_id"])
    runs = repo.list_runs(1)
    if runs:
        for m in repo.matches_for_run(runs[0]["run_id"]):
            res = m["result"]; lines = res.get("lines") or []
            w.writerow([runs[0]["run_id"], m["payment_id"], m["status"], m.get("solver") or res.get("solver", ""),
                        " ".join(l["invoice_id"] for l in lines),
                        sum(l["gross_cents"] for l in lines),
                        sum(l.get("discount_cents") or 0 for l in lines),
                        sum(l["net_cents"] for l in lines),
                        m["residual_cents"], m["confidence"],
                        (res.get("approval") or {}).get("erp_document_id") or ""])
    return PlainTextResponse(buf.getvalue(), media_type="text/csv", headers={
        "Content-Disposition": 'attachment; filename="slatematch-matches.csv"'})

def _docs_dir():
    env = _env("DOCS_DIR", "")
    cands = [env] if env else []
    here = os.path.dirname(os.path.abspath(__file__))
    cands += [os.path.join(here, "..", "..", "docs"), "/app/docs"]
    for c in cands:
        if c and os.path.isdir(c): return c
    return None

@app.get("/api/v1/docs")
def docs_list(ctx=Depends(auth_context)):
    need(ctx, "read")
    d = _docs_dir()
    if not d: return {"docs": [], "note": "docs directory not present in this deployment"}
    # The pack reads in a fixed flow: requirements first, then the evidence
    # behind them, then design, build, deployment, market, and finally the
    # builder's own account of what went wrong and how it was put right.
    # Files not in this list keep alphabetical order after the named pack.
    DOC_ORDER = ["PRD.md", "RESEARCH_SEGMENT.md", "ARCHITECTURE.md",
                 "IMPLEMENTATION_GUIDE.md", "DEPLOY.md", "AWS_DEPLOY.md",
                 "GO_TO_MARKET.md", "CHALLENGES.md"]
    names = [f for f in os.listdir(d) if f.endswith(".md")]
    names.sort(key=lambda f: (DOC_ORDER.index(f) if f in DOC_ORDER else len(DOC_ORDER), f))
    out = []
    for f in names:
        path = os.path.join(d, f)
        title = f[:-3].replace("_", " ")
        try:
            with open(path) as fh:
                for line in fh:
                    if line.startswith("# "):
                        title = line[2:].strip(); break
        except OSError:
            pass
        out.append({"name": f, "title": title, "bytes": os.path.getsize(path)})
    return {"docs": out}

@app.get("/api/v1/docs/{name}")
def docs_read(name: str, ctx=Depends(auth_context)):
    need(ctx, "read")
    d = _docs_dir()
    if not d or "/" in name or "\\" in name or not name.endswith(".md"):
        raise HTTPException(404, "unknown document")
    path = os.path.join(d, name)
    if not os.path.isfile(path): raise HTTPException(404, "unknown document")
    with open(path) as fh:
        return {"name": name, "markdown": fh.read()}

@app.post("/api/v1/copilot")
def copilot(body: CopilotIn, ctx=Depends(auth_context)):
    need(ctx, "read"); return copilot_answer(repo_for(ctx["tenant_id"]), body.question, models()["delay_model"])

def _current_month():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).month


def _attach_partials(repo, rows):
    """Mark invoices an approved partial payment has paid down: the
    row's gross is the remaining balance, and the partial record says
    how much was applied and what the invoice originally stood at."""
    applied = repo.partial_applications()
    for r in rows:
        n = applied.get(r["invoice_id"])
        if n:
            r["partial"] = {"applied_cents": n,
                            "original_cents": r["gross_cents"] + n}
    return rows


def _residual_invoices(repo):
    """The post-reconciliation ledger: open invoices no run has cleared
    yet. Forecast, collections and dunning all read this one state, so
    a settled invoice leaves every downstream view at the same moment."""
    settled = repo.settled_invoice_ids()
    return [i for i in repo.open_invoices() if i.invoice_id not in settled]

@app.get("/api/v1/forecast")
def forecast(ctx=Depends(auth_context)):
    """The strict state rule: no case loaded, or a case loaded but not
    yet run, means NO forecast at all - the model never runs on a
    pre-reconciliation ledger and presents it as expected cash. Once a
    run exists, the forecast is computed on the residual ledger only."""
    need(ctx, "read"); repo = repo_for(ctx["tenant_id"])
    if not repo.get_meta("active_case"):
        return {"state": "empty", "weeks": [], "invoices": [], "customers": [], "summary": None}
    if not repo.list_runs(1):
        return {"state": "loaded_not_run", "weeks": [], "invoices": [], "customers": [], "summary": None}
    invs = _residual_invoices(repo)
    if not invs:
        return {"state": "ready", "weeks": [], "invoices": [], "customers": [], "summary": None}
    out = forecast_cash_in(invs, models()["delay_model"], current_month=_current_month())
    out["state"] = "ready"
    return out

class WhatifIn(BaseModel):
    customer: str; shift_days: int = 0

@app.post("/api/v1/forecast/whatif")
def forecast_whatif(body: WhatifIn, ctx=Depends(auth_context)):
    """What-if: what happens to expected cash if one customer pays N days
    earlier or later? Recomputed from the same model and the same ledger -
    a planning answer, not a saved scenario."""
    need(ctx, "read"); repo = repo_for(ctx["tenant_id"])
    if not repo.get_meta("active_case") or not repo.list_runs(1):
        raise HTTPException(404, "no forecast until a case is loaded and run")
    invs = _residual_invoices(repo)
    if not invs:
        raise HTTPException(404, "no open invoices in this workspace")
    if body.customer not in {i.customer for i in invs}:
        raise HTTPException(422, f"unknown customer {body.customer}")
    shift = max(-21, min(21, body.shift_days))
    base = forecast_cash_in(invs, models()["delay_model"], current_month=_current_month())
    moved = forecast_cash_in(invs, models()["delay_model"], current_month=_current_month(),
                             shift_customer=body.customer, shift_days=shift)
    return {"customer": body.customer, "shift_days": shift,
            "base_expected_horizon_cents": base["summary"]["expected_horizon_cents"],
            "shifted_expected_horizon_cents": moved["summary"]["expected_horizon_cents"],
            "delta_cents": moved["summary"]["expected_horizon_cents"] - base["summary"]["expected_horizon_cents"],
            "base_expected_30_cents": base["summary"]["expected_30_cents"],
            "shifted_expected_30_cents": moved["summary"]["expected_30_cents"],
            "delta_30_cents": moved["summary"]["expected_30_cents"] - base["summary"]["expected_30_cents"],
            "weeks": [{"week": b["week"], "base_p50_cents": b["p50_cents"],
                       "shifted_p50_cents": m["p50_cents"]}
                      for b, m in zip(base["weeks"], moved["weeks"])]}

@app.get("/api/v1/collections")
def collections(ctx=Depends(auth_context)):
    """Same state rule as the forecast: the queue exists only once a
    case is loaded and run, and it scores the residual ledger."""
    need(ctx, "read"); repo = repo_for(ctx["tenant_id"])
    if not repo.get_meta("active_case") or not repo.list_runs(1):
        return []
    return prioritise_collections(_residual_invoices(repo), models()["delay_model"],
                                  current_month=_current_month())

# ---- Autonomy, behaviour, collections actions, disputes, predictions ----

@app.post("/api/v1/matches/{match_id}/reverse")
def reverse_match(match_id: str, ctx=Depends(auth_context)):
    """One-click reversal of an autopilot resolution, from the
    pre-state snapshot the resolution recorded. Human decisions and
    solver auto-posts are not reversible here - they stand as
    posted, as an ERP's would."""
    need(ctx, "approve"); repo = repo_for(ctx["tenant_id"])
    from autonomy import reverse_autopilot
    try:
        out = reverse_autopilot(repo, match_id, f"api:{ctx['role']}", _now_iso)
    except ValueError as e:
        raise HTTPException(409, str(e))
    _fire_webhooks(repo, "match.reversed",
                   {"match_id": match_id, "restored_invoices": out.get("restored_invoices")})
    return out

@app.get("/api/v1/behaviour-profiles")
def behaviour_profiles(ctx=Depends(auth_context)):
    """What this workspace's decided history says about each payer:
    bundle habits, partial and deduction rates, duplicates. Triage
    evidence and analytics - the solver reads none of it."""
    need(ctx, "read"); repo = repo_for(ctx["tenant_id"])
    from behaviour import build_profiles
    return {"profiles": build_profiles(repo)}

class CollectionActIn(BaseModel):
    invoice_id: str; action: str; promised_date: str = ""; note: str = ""

@app.post("/api/v1/collections/act")
def collections_act(body: CollectionActIn, ctx=Depends(auth_context)):
    """The collections agent acts on one queue row: 'remind' composes
    the reminder from the ledger row and records it as an outbox
    draft (the Mail Hub sends it once an address is supplied);
    'promise' logs a promise to pay, whose kept/broken status is
    derived from the ledger, never asserted by hand."""
    need(ctx, "run"); repo = repo_for(ctx["tenant_id"])
    inv = next((i for i in repo.open_invoices() if i.invoice_id == body.invoice_id), None)
    if inv is None:
        raise HTTPException(404, f"invoice {body.invoice_id} is not open in this workspace")
    if body.action == "remind":
        d = reminder_draft(inv)
        oid = repo.add_outbox(inv.customer, d["subject"], d["body"],
                              "collection_reminder", inv.invoice_id, "draft",
                              "Composed by the collections agent from the ledger "
                              "row; add the customer's email address in the Mail "
                              "Hub to send.", _now_iso())
        repo.audit(f"api:{ctx['role']}", "collection_reminder_drafted", "invoice",
                   inv.invoice_id, {"outbox_id": oid, "tone": d["tone"]}, _now_iso())
        return {"action": "remind", "outbox_id": oid, "status": "draft",
                "tone": d["tone"], "subject": d["subject"]}
    if body.action == "promise":
        from datetime import datetime as _dt
        try:
            _dt.strptime(body.promised_date, "%Y-%m-%d")
        except (ValueError, TypeError):
            raise HTTPException(422, "promised_date must be YYYY-MM-DD")
        pid = repo.add_promise(inv.invoice_id, inv.customer, inv.gross_cents,
                               body.promised_date, body.note, _now_iso())
        repo.audit(f"api:{ctx['role']}", "promise_logged", "invoice", inv.invoice_id,
                   {"promise_id": pid, "promised_date": body.promised_date}, _now_iso())
        return {"action": "promise", "promise_id": pid, "status": "OPEN",
                "invoice_id": inv.invoice_id, "promised_date": body.promised_date}
    raise HTTPException(422, "action must be 'remind' or 'promise'")

@app.get("/api/v1/collections/promises")
def collections_promises(ctx=Depends(auth_context)):
    """Promises to pay with derived status: KEPT when the invoice has
    settled, BROKEN when the promised date has passed with the
    invoice still open, OPEN otherwise."""
    need(ctx, "read"); repo = repo_for(ctx["tenant_id"])
    from datetime import datetime, timezone
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    settled = {i.invoice_id for i in repo.all_invoices()
               if i.invoice_id not in {o.invoice_id for o in repo.open_invoices()}}
    out = []
    for p in repo.list_promises():
        if p["invoice_id"] in settled:
            status = "KEPT"
        elif p["promised_date"] < today:
            status = "BROKEN"
        else:
            status = "OPEN"
        out.append({**p, "status": status})
    return {"promises": out}

@app.get("/api/v1/disputes")
def disputes(ctx=Depends(auth_context)):
    """The dispute lifecycle: every claim a run generated, with its
    status and whether it is due for escalation (open 14+ days
    without resolution)."""
    need(ctx, "read"); repo = repo_for(ctx["tenant_id"])
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    out = []
    for d in repo.list_disputes():
        try:
            created = datetime.fromisoformat(d["created_at"].replace("Z", "+00:00"))
            age_days = (now - created).days
        except Exception:
            age_days = 0
        due = d["status"] in ("OPEN", "SENT", "ACKNOWLEDGED") and age_days >= 14
        out.append({**d, "age_days": age_days, "escalation_due": due})
    return {"disputes": out}

class DisputeTransitionIn(BaseModel):
    status: str; note: str = ""

@app.post("/api/v1/disputes/{dispute_id}/transition")
def dispute_transition(dispute_id: str, body: DisputeTransitionIn,
                       ctx=Depends(auth_context)):
    """Move a dispute along its lifecycle. SENT also records the
    claim letter as an outbox draft; WON and LOST are terminal -
    the outcome is booked into the record and its history."""
    need(ctx, "run"); repo = repo_for(ctx["tenant_id"])
    d = repo.get_dispute(dispute_id)
    if not d:
        raise HTTPException(404, "dispute not found")
    target = (body.status or "").upper()
    if target not in ("SENT", "ACKNOWLEDGED", "ESCALATED", "WON", "LOST"):
        raise HTTPException(422, "status must be SENT, ACKNOWLEDGED, ESCALATED, WON or LOST")
    if d["status"] in ("WON", "LOST"):
        raise HTTPException(409, f"dispute is {d['status']} - the outcome is booked and final")
    ts = _now_iso()
    history = list(d.get("history") or [])
    history.append({"status": target, "at": ts, "note": body.note or "",
                    "by_role": ctx["role"]})
    repo.update_dispute(dispute_id, target, history, ts)
    repo.audit(f"api:{ctx['role']}", "dispute_" + target.lower(), "dispute",
               dispute_id, {"claimed_cents": d["claimed_cents"]}, ts)
    _fire_webhooks(repo, "dispute.transitioned",
                   {"dispute_id": dispute_id, "payment_id": d["payment_id"],
                    "status": target, "claimed_cents": d["claimed_cents"]})
    if target == "SENT":
        subject = (f"Dispute claim {dispute_id} - deduction of "
                   f"${d['claimed_cents'] / 100:,.2f} under reason {d['reason_code'] or 'review'}")
        body_text = (f"Dear Accounts Payable team,\n\nWe are disputing a deduction of "
                     f"${d['claimed_cents'] / 100:,.2f} taken against payment "
                     f"{d['payment_id']} (reason code {d['reason_code'] or 'unclassified'}). "
                     f"Our expected recovery on this claim is "
                     f"${float(d['expected_recovery_usd'] or 0):,.2f}. The supporting "
                     "proof of delivery and invoice copies are held in our dispute "
                     "record and available on request.\n\nAccounts Receivable")
        repo.add_outbox(d["payer"] or "Customer", subject, body_text,
                        "dispute_claim", dispute_id, "draft",
                        "Composed at the SENT transition; add the customer's "
                        "email address in the Mail Hub to send.", ts)
    return {"dispute_id": dispute_id, "status": target, "history": history}

@app.get("/api/v1/predictions")
def predictions(ctx=Depends(auth_context)):
    """Pre-arrival view: what the residual ledger is expected to pay,
    per invoice, from the same forecast computation the Forecast
    view bands - expected date, probability inside 30 days, and a
    next-14-days flag. Same state rule as the forecast."""
    need(ctx, "read"); repo = repo_for(ctx["tenant_id"])
    if not repo.get_meta("active_case"):
        return {"state": "empty", "expected": []}
    if not repo.list_runs(1):
        return {"state": "loaded_not_run", "expected": []}
    invs = _residual_invoices(repo)
    if not invs:
        return {"state": "ready", "expected": []}
    from datetime import datetime, timedelta, timezone
    out = forecast_cash_in(invs, models()["delay_model"], current_month=_current_month())
    today = datetime.now(timezone.utc).date()
    rows = []
    for d in out.get("invoices") or []:
        exp_date = today + timedelta(days=max(0, round(d["expected_in_days"])))
        rows.append({**d, "expected_date": exp_date.isoformat(),
                     "within_14d": d["expected_in_days"] <= 14})
    rows.sort(key=lambda r: r["expected_in_days"])
    return {"state": "ready", "expected": rows,
            "expected_14d_cents": sum(r["gross_cents"] for r in rows if r["within_14d"])}

@app.get("/api/v1/evaluations/trend")
def evaluations_trend(ctx=Depends(auth_context)):
    """Continuous evaluation: each day's evaluations computation is
    snapshotted for this tenant, and the latest is compared with
    the first snapshot in the window. A drop of 2+ accuracy points
    flags drift - the same numbers the Evaluations view shows,
    watched over time instead of admired once."""
    need(ctx, "read"); repo = repo_for(ctx["tenant_id"])
    payload = evaluations()
    from datetime import datetime, timezone
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    snaps = repo.list_eval_snapshots()
    if not snaps or not str(snaps[-1]["ts"]).startswith(today):
        repo.add_eval_snapshot(_now_iso(), payload["milp_accuracy"],
                               payload["greedy_accuracy"], payload["milp_exact_rate"],
                               len(payload["cases"]))
        snaps = repo.list_eval_snapshots()
    baseline = snaps[0]["milp_accuracy"] if snaps else payload["milp_accuracy"]
    latest = snaps[-1]["milp_accuracy"] if snaps else payload["milp_accuracy"]
    drift = round((latest - baseline) * 100, 2)
    return {"snapshots": snaps, "baseline_accuracy": baseline,
            "latest_accuracy": latest, "drift_points": drift,
            "drift_flag": drift <= -2.0,
            "basis": "One snapshot per day per tenant, taken from the live "
                     "evaluations computation (labelled synthetic scenarios)."}

# ---- Proof: replay, evidence pack, success criteria ----

@app.post("/api/v1/runs/{run_id}/replay")
def replay_run(run_id: str, ctx=Depends(auth_context)):
    """Re-run one past run's payments in a scratch session under the
    CURRENT engine and policy, and diff the outcomes payment by
    payment. The scratch ledger is the current ledger with the
    source run's own settlements undone from its records (posted
    lines reopen at their recorded gross); invoices settled by
    other runs stay settled. The source workspace is never touched:
    the scratch session is an ephemeral tenant the session reaper
    clears like any other."""
    need(ctx, "run"); repo = repo_for(ctx["tenant_id"])
    src_matches = repo.matches_for_run(run_id)
    src_exceptions = repo.exceptions_for_run(run_id)
    if not src_matches and not src_exceptions:
        raise HTTPException(404, "run not found in this workspace")
    payment_ids = {m["payment_id"] for m in src_matches} | \
                  {e["payment_id"] for e in src_exceptions}
    payments = [p for p in repo.all_payments() if p.payment_id in payment_ids]
    then = {}
    for m in src_matches:
        then[m["payment_id"]] = {"status": m["status"],
                                 "residual_cents": m["residual_cents"]}
    for e in src_exceptions:
        then.setdefault(e["payment_id"], {"status": e["kind"],
                                          "residual_cents": None})
    restore = {}
    for m in src_matches:
        if m["status"] in ("AUTO_POSTED", "APPROVED_POSTED"):
            pre = {p["invoice_id"]: p["gross_cents"]
                   for p in ((m["result"] or {}).get("approval") or {}).get("pre_state") or []}
            for l in (m["result"] or {}).get("lines") or []:
                restore[l["invoice_id"]] = pre.get(l["invoice_id"], l.get("gross_cents"))
    import uuid as _uuid
    from domain import Invoice as _Invoice
    scratch = repo_for(f"{ctx['tenant_id']}--{_uuid.uuid4()}")
    settled_now = {i.invoice_id for i in repo.all_invoices()} - \
                  {i.invoice_id for i in repo.open_invoices()}
    for inv in repo.all_invoices():
        scratch.add_invoice(_Invoice(
            invoice_id=inv.invoice_id, customer=inv.customer,
            subsidiary=inv.subsidiary,
            gross_cents=restore.get(inv.invoice_id, inv.gross_cents),
            currency=inv.currency, po_number=inv.po_number,
            discount_rate=inv.discount_rate, age_days=inv.age_days,
            due_in_days=inv.due_in_days))
    keep_settled = [i for i in settled_now if i not in restore]
    if keep_settled:
        scratch.settle_invoices(keep_settled)
    for p in payments:
        scratch.add_payment(p)
    policy = _policy_for(repo, ctx["tenant_id"], None)
    run = run_batch(scratch, payments, policy,
                    idempotency_key=f"replay:{run_id}:{_uuid.uuid4().hex[:8]}",
                    actor=f"api:{ctx['role']}")
    # A replay mirrors a real run end to end, including its output
    # composition (settlement drafts, the autopilot pass under the
    # current policy, dispute records) - inside the scratch tenant
    # only, so the diff reflects the full current pipeline.
    try:
        _finish_run_outputs(scratch, run)
    except Exception:
        pass
    now = {}
    for m in scratch.matches_for_run(run["run_id"]):
        now[m["payment_id"]] = {"status": m["status"],
                                "residual_cents": m["residual_cents"]}
    for e in scratch.exceptions_for_run(run["run_id"]):
        now.setdefault(e["payment_id"], {"status": e["kind"],
                                         "residual_cents": None})
    rows = []
    for pid in sorted(payment_ids):
        t, n = then.get(pid, {}), now.get(pid, {})
        rows.append({"payment_id": pid, "then_status": t.get("status"),
                     "now_status": n.get("status"),
                     "then_residual_cents": t.get("residual_cents"),
                     "now_residual_cents": n.get("residual_cents"),
                     "changed": t.get("status") != n.get("status")})
    repo.audit(f"api:{ctx['role']}", "run_replayed", "run", run_id,
               {"replay_run_id": run["run_id"],
                "changed": sum(1 for r in rows if r["changed"])}, _now_iso())
    return {"source_run_id": run_id, "replay_run_id": run["run_id"],
            "results": rows,
            "changed_count": sum(1 for r in rows if r["changed"]),
            "policy_name": policy.name,
            "basis": "Payments re-run in a scratch session under the policy "
                     "a fresh run would use now (the stored policy with any "
                     "active case overrides, exactly as a live run resolves "
                     "it); the ledger is the current one with the source "
                     "run's settlements undone from its own records. The "
                     "source workspace is unchanged."}

@app.get("/api/v1/runs/{run_id}/evidence")
def run_evidence(run_id: str, ctx=Depends(auth_context)):
    """The auditor's evidence pack for one run: everything needed to
    re-derive every decision in it - the policy snapshot, each
    match with its lines and derivation, the exceptions, the SAP
    documents, and the audit entries that touch the run - closed
    with a SHA-256 manifest over the pack's own contents, so any
    later edit to the pack is detectable."""
    need(ctx, "read"); repo = repo_for(ctx["tenant_id"])
    run_row = repo.get_run(run_id)
    if not run_row:
        raise HTTPException(404, "run not found in this workspace")
    customers = {i.invoice_id: i.customer for i in repo.all_invoices()}
    matches, documents = [], []
    for m in repo.matches_for_run(run_id):
        res = m["result"] or {}
        matches.append({"payment_id": m["payment_id"], "status": m["status"],
                        "solver": m["solver"], "confidence": m["confidence"],
                        "residual_cents": m["residual_cents"], "result": res})
        if m["status"] in ("AUTO_POSTED", "APPROVED_POSTED") and res.get("lines"):
            doc_id = (res.get("approval") or {}).get("erp_document_id") or \
                     document_number_for(m["match_id"])
            documents.append({"payment_id": m["payment_id"],
                              "document": document_for_match(
                                  res, res.get("payment") or {"payment_id": m["payment_id"]},
                                  document_number=doc_id, customers=customers)})
    match_ids = {m["match_id"] for m in repo.matches_for_run(run_id)}
    audit = [a for a in repo.audit_list(500)
             if a["entity_id"] == run_id or a["entity_id"] in match_ids]
    pack = {"run": {"run_id": run_id, "kind": run_row["kind"],
                    "status": run_row["status"], "created_at": run_row["created_at"],
                    "policy": run_row["policy"]},
            "matches": matches,
            "exceptions": repo.exceptions_for_run(run_id),
            "sap_documents": documents,
            "audit_entries": audit,
            "generated_at": _now_iso(), "generated_by_role": ctx["role"]}
    import hashlib as _hl
    canonical = json.dumps({k: v for k, v in pack.items() if k != "generated_at"},
                           sort_keys=True)
    pack["manifest_sha256"] = _hl.sha256(canonical.encode()).hexdigest()
    pack["manifest_covers"] = "every field above except generated_at"
    return pack

@app.get("/api/v1/success-criteria")
def success_criteria(ctx=Depends(auth_context)):
    """The contract dashboard: the criteria an enterprise buyer
    would hold this product to, computed from the workspace's own
    stored records - never from claims. Each row states its target,
    the measured actual, and the basis it was measured on."""
    need(ctx, "read"); repo = repo_for(ctx["tenant_id"])
    runs = repo.list_runs(200)
    matches, exceptions = [], []
    for r in runs:
        matches.extend(repo.matches_for_run(r["run_id"]))
        exceptions.extend(repo.exceptions_for_run(r["run_id"]))
    decided_payments = {m["payment_id"] for m in matches} | \
                       {e["payment_id"] for e in exceptions}
    posted = [m for m in matches if m["status"] in ("AUTO_POSTED", "APPROVED_POSTED")]
    auto = [m for m in matches if m["status"] == "AUTO_POSTED"]
    dup_ids = {e["payment_id"] for e in exceptions if e["kind"] == "DUPLICATE_PAYMENT"}
    dup_posted = [m for m in posted if m["payment_id"] in dup_ids]
    with_derivation = [m for m in matches
                       if ((m["result"] or {}).get("derivation") or {}).get("equation")]
    customers = {i.invoice_id: i.customer for i in repo.all_invoices()}
    docs_balanced = docs_total = 0
    for m in posted:
        res = m["result"] or {}
        if not res.get("lines"):
            continue
        doc_id = (res.get("approval") or {}).get("erp_document_id") or \
                 document_number_for(m["match_id"])
        doc = document_for_match(res, res.get("payment") or {"payment_id": m["payment_id"]},
                                 document_number=doc_id, customers=customers)
        docs_total += 1
        if doc["total_debits_cents"] == doc["total_credits_cents"]:
            docs_balanced += 1
    n = max(len(decided_payments), 1)
    rows = [
        {"criterion": "Touchless posting rate", "target": ">= 70% (industry median, Hackett Group)",
         "actual": round(len(auto) / n, 3), "unit": "share of decided payments",
         "status": "pass" if len(auto) / n >= 0.70 else "watch",
         "basis": f"{len(auto)} of {len(decided_payments)} decided payments posted with no human touch"},
        {"criterion": "Duplicate leakage", "target": "0 duplicates posted",
         "actual": len(dup_posted), "unit": "payments",
         "status": "pass" if not dup_posted else "fail",
         "basis": f"{len(dup_ids)} duplicate(s) detected and held; none may reach the ledger"},
        {"criterion": "Decisions carrying a full derivation", "target": "100%",
         "actual": round(len(with_derivation) / max(len(matches), 1), 3),
         "unit": "share of match records",
         "status": "pass" if matches and len(with_derivation) == len(matches) else "watch",
         "basis": "Every match record stores its equation; an auditor can re-derive each figure"},
        {"criterion": "SAP documents balanced", "target": "100%",
         "actual": round(docs_balanced / max(docs_total, 1), 3),
         "unit": "share of posting documents",
         "status": "pass" if docs_total and docs_balanced == docs_total else "watch",
         "basis": f"{docs_balanced} of {docs_total} generated documents balance debit = credit"},
        {"criterion": "Exceptions carrying a recommended action", "target": "100%",
         "actual": round(sum(1 for e in exceptions if e.get("recommended_action")) / max(len(exceptions), 1), 3),
         "unit": "share of exceptions",
         "status": "pass" if exceptions and all(e.get("recommended_action") for e in exceptions) else "watch",
         "basis": "No exception is a dead end; each names the next human action"},
    ]
    return {"criteria": rows, "runs_counted": len(runs),
            "note": "Measured over every run stored in this workspace, "
                    "including the seeded demo case, which is deliberately "
                    "adversarial (duplicates, short-pays, a refusal) - it "
                    "exercises the exception paths rather than maximising "
                    "the touchless rate."}

# ---- Integrations: SAP write-back, webhooks, feeds ----

_WEBHOOK_EVENTS = {"run.completed", "approval.decided",
                   "dispute.transitioned", "match.reversed"}

def _guard_public_url(url):
    from urllib.parse import urlparse
    import ipaddress
    u = urlparse(url or "")
    if u.scheme not in ("http", "https") or not u.hostname:
        raise HTTPException(422, "url must be an http(s) URL with a host")
    host = u.hostname.lower()
    if host == "localhost":
        raise HTTPException(422, "url must not target localhost")
    try:
        ip = ipaddress.ip_address(host)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            raise HTTPException(422, "url must not target a private or loopback address")
    except ValueError:
        pass  # a hostname, not an IP literal

def _deliver_webhook(repo, hook, event, data):
    import httpx
    try:
        r = httpx.post(hook["url"], timeout=5.0,
                       json={"event": event, "data": data, "sent_at": _now_iso()})
        repo.add_delivery(hook["webhook_id"], event, r.status_code,
                          200 <= r.status_code < 300, "", _now_iso())
    except Exception as e:
        repo.add_delivery(hook["webhook_id"], event, None, False,
                          str(e)[:200], _now_iso())

def _fire_webhooks(repo, event, data):
    """Best-effort event fan-out. A webhook can never fail the
    operation that fired it; every delivery attempt is recorded."""
    try:
        for hook in repo.list_webhooks():
            events = {e.strip() for e in (hook["events"] or "").split(",")}
            if hook["active"] and (event in events or "all" in events):
                _threading.Thread(target=_deliver_webhook,
                                  args=(repo, hook, event, data),
                                  daemon=True).start()
    except Exception:
        pass

def _integration_settings(repo):
    s = repo.get_setting("integrations", {}) or {}
    return {"sap_mode": s.get("sap_mode", "simulated"),
            "sap_endpoint": s.get("sap_endpoint", "")}

@app.get("/api/v1/integrations/settings")
def get_integration_settings(ctx=Depends(auth_context)):
    need(ctx, "read")
    return _integration_settings(repo_for(ctx["tenant_id"]))

class IntegrationSettingsIn(BaseModel):
    sap_mode: str = "simulated"
    sap_endpoint: str = ""

@app.put("/api/v1/integrations/settings")
def put_integration_settings(body: IntegrationSettingsIn, ctx=Depends(auth_context)):
    need(ctx, "approve"); repo = repo_for(ctx["tenant_id"])
    if body.sap_mode not in ("simulated", "http"):
        raise HTTPException(422, "sap_mode must be 'simulated' or 'http'")
    if body.sap_mode == "http":
        if not body.sap_endpoint.startswith(("http://", "https://")):
            raise HTTPException(422, "http mode needs an http(s) endpoint URL")
    repo.set_setting("integrations", {"sap_mode": body.sap_mode,
                                      "sap_endpoint": body.sap_endpoint})
    return _integration_settings(repo)

def _sap_simulator(payload):
    """The connection point, honestly labelled: validates the BAPI
    payload the way SAP's own checks would (header present, G/L
    lines present, CURRENCYAMOUNT nets to zero) and returns the
    document number a real system would assign. Nothing here
    claims a real SAP system was reached."""
    import hashlib as _hl
    header = payload.get("DOCUMENTHEADER") or {}
    if not (header.get("DOCUMENT_TYPE") or header.get("DOC_TYPE")):
        return None, "payload rejected: DOCUMENTHEADER document type missing"
    if not payload.get("ACCOUNTGL") and not payload.get("ACCOUNTRECEIVABLE"):
        return None, "payload rejected: no posting lines"
    net = sum(r.get("AMT_DOCCUR", 0) for r in payload.get("CURRENCYAMOUNT") or [])
    if net != 0:
        return None, f"payload rejected: CURRENCYAMOUNT nets to {net}, not zero"
    digest = _hl.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    return "SAPSIM-" + digest[:8].upper(), "payload valid; simulated posting accepted"

class TransmitIn(BaseModel):
    payment_id: str

@app.post("/api/v1/erp/transmit")
def erp_transmit(body: TransmitIn, ctx=Depends(auth_context)):
    """Transmit one cleared payment's BAPI document. In simulated
    mode (the default) the built-in simulator validates the
    payload and assigns a SAPSIM number - the transmission record
    says SIMULATED in plain words. In http mode the payload is
    POSTed to the configured endpoint and the real response is
    recorded, whatever it is."""
    need(ctx, "approve"); repo = repo_for(ctx["tenant_id"])
    m = repo.latest_match_for_payment(body.payment_id)
    if not m or m["status"] not in ("AUTO_POSTED", "APPROVED_POSTED"):
        raise HTTPException(409, "only a cleared (posted) payment has a document to transmit")
    res = m["result"] or {}
    doc_id = (res.get("approval") or {}).get("erp_document_id") or \
             document_number_for(m["match_id"])
    customers = {i.invoice_id: i.customer for i in repo.all_invoices()}
    doc = document_for_match(res, res.get("payment") or {"payment_id": body.payment_id},
                             document_number=doc_id, customers=customers)
    payload = doc.get("bapi_payload") or {}
    settings = _integration_settings(repo)
    mode = settings["sap_mode"]
    if mode == "http":
        import httpx
        try:
            r = httpx.post(settings["sap_endpoint"], json=payload, timeout=8.0)
            ok = 200 <= r.status_code < 300
            status = "SENT" if ok else "FAILED"
            sap_no = (r.json().get("document_number") if ok and
                      r.headers.get("content-type", "").startswith("application/json")
                      else None)
            detail = f"endpoint answered HTTP {r.status_code}"
        except Exception as e:
            status, sap_no, detail = "FAILED", None, f"endpoint unreachable: {str(e)[:160]}"
    else:
        sap_no, detail = _sap_simulator(payload)
        status = "SIMULATED_POSTED" if sap_no else "FAILED"
    tid = "TRX-" + uuid.uuid4().hex[:10].upper()
    repo.add_transmission(tid, body.payment_id, doc_id, mode, status,
                          sap_no, detail, _now_iso())
    repo.audit(f"api:{ctx['role']}", "sap_transmitted", "payment", body.payment_id,
               {"document_number": doc_id, "mode": mode, "status": status,
                "sap_document_number": sap_no}, _now_iso())
    return {"transmission_id": tid, "payment_id": body.payment_id,
            "document_number": doc_id, "mode": mode, "status": status,
            "sap_document_number": sap_no, "detail": detail}

@app.get("/api/v1/erp/transmissions")
def erp_transmissions(ctx=Depends(auth_context)):
    need(ctx, "read")
    return {"transmissions": repo_for(ctx["tenant_id"]).list_transmissions()}

class WebhookIn(BaseModel):
    url: str
    events: str = "run.completed"

@app.post("/api/v1/webhooks")
def create_webhook(body: WebhookIn, ctx=Depends(auth_context)):
    need(ctx, "approve"); repo = repo_for(ctx["tenant_id"])
    _guard_public_url(body.url)
    events = {e.strip() for e in body.events.split(",") if e.strip()}
    if not events or not events <= (_WEBHOOK_EVENTS | {"all"}):
        raise HTTPException(422, f"events must be chosen from {sorted(_WEBHOOK_EVENTS)} or 'all'")
    wid = "WH-" + uuid.uuid4().hex[:10].upper()
    repo.add_webhook(wid, body.url, ",".join(sorted(events)), _now_iso())
    return {"webhook_id": wid, "url": body.url, "events": sorted(events), "active": True}

@app.get("/api/v1/webhooks")
def list_webhooks_ep(ctx=Depends(auth_context)):
    need(ctx, "read"); repo = repo_for(ctx["tenant_id"])
    return {"webhooks": repo.list_webhooks(),
            "deliveries": repo.list_deliveries(20),
            "events_available": sorted(_WEBHOOK_EVENTS)}

@app.delete("/api/v1/webhooks/{webhook_id}")
def delete_webhook_ep(webhook_id: str, ctx=Depends(auth_context)):
    need(ctx, "approve"); repo = repo_for(ctx["tenant_id"])
    if not repo.delete_webhook(webhook_id):
        raise HTTPException(404, "webhook not found")
    return {"deleted": webhook_id}

class RemittanceFeedIn(BaseModel):
    sender: str = ""
    subject: str = ""
    body: str

@app.post("/api/v1/feeds/remittance")
def remittance_feed(body: RemittanceFeedIn, ctx=Depends(auth_context)):
    """The remittance mailbox connection point, in the shape an
    inbound-email service (SES, Postmark, a mailroom scanner)
    would POST: parse the advice with the same pipeline as the
    Upload Center, stage the payment into the workspace for the
    next run, and record the feed event. Staging is not matching:
    the wire reconciles when a run includes it."""
    need(ctx, "run"); repo = repo_for(ctx["tenant_id"])
    invs = repo.open_invoices()
    out = parse_remittance(body.body, {i.invoice_id for i in invs},
                           {i.po_number for i in invs if i.po_number})
    f = out["fields"]
    amount = int(f.get("amount_cents") or 0)
    if amount <= 0:
        repo.add_feed_event("remittance_mail",
                            f"from {body.sender or 'unknown'}: no amount read, nothing staged",
                            _now_iso())
        raise HTTPException(422, "no payment amount could be read from the advice")
    from domain import Payment as _Payment
    pid = "MAIL-" + uuid.uuid4().hex[:8].upper()
    refs = list(f.get("invoice_refs") or []) + list(f.get("po_refs") or [])
    # The parser reads standard reference shapes; a mailbox triage
    # also matches this workspace's own open invoice ids verbatim,
    # so a house id format the regex does not know still links.
    for inv in invs:
        if inv.invoice_id in body.body and inv.invoice_id not in refs:
            refs.append(inv.invoice_id)
    repo.add_payment(_Payment(payment_id=pid, payer_raw=f.get("payer") or body.sender or "Unknown payer",
                              amount_cents=amount, currency="USD",
                              references=refs, remittance_text=body.body))
    repo.add_feed_event("remittance_mail",
                        f"from {body.sender or 'unknown'}: staged {pid} "
                        f"${amount / 100:,.2f} from {f.get('payer') or 'unknown payer'} "
                        f"via {out['source']} parse", _now_iso())
    return {"staged_payment_id": pid, "amount_cents": amount,
            "payer": f.get("payer"), "references": refs,
            "parse_source": out["source"], "verified": out["verification"]["verified"]}

@app.get("/api/v1/feeds/events")
def feed_events(ctx=Depends(auth_context)):
    need(ctx, "read")
    return {"events": repo_for(ctx["tenant_id"]).list_feed_events()}

# ---- Payer portal: token-scoped, one customer, nothing else ----

def _portal_scope(token):
    """A portal link resolves to exactly one tenant and one
    customer. The raw token is never stored (SHA-256 hash only,
    in the control store, like API keys), and revocation is
    immediate. Every portal query below filters to that customer
    and nothing else in the tenant is reachable through it."""
    info = store.resolve_portal_token(token)
    if not info:
        raise HTTPException(401, "this portal link is invalid or has been revoked")
    return info

def _portal_payments(repo, customer):
    """The customer's payments: any payment whose match touches
    one of the customer's invoices, plus payments carrying the
    customer's own name as payer. Status is given raw and in
    plain words for the payer."""
    cust_invoices = {i.invoice_id for i in repo.all_invoices()
                     if i.customer == customer}
    norm = " ".join(customer.lower().split())
    out = []
    for p in repo.all_payments():
        m = repo.latest_match_for_payment(p.payment_id)
        touches = bool(m and any(l.get("invoice_id") in cust_invoices
                                 for l in (m["result"] or {}).get("lines") or []))
        if not touches and " ".join((p.payer_raw or "").lower().split()) != norm:
            continue
        status = m["status"] if m else "RECEIVED"
        label = {"AUTO_POSTED": "Posted", "APPROVED_POSTED": "Posted",
                 "PROPOSED": "With our team for approval",
                 "REVERSED": "Reversed",
                 "RECEIVED": "Received - awaiting reconciliation"}.get(status, status)
        exc = [e for e in repo.exceptions_for_payment(p.payment_id)] \
            if hasattr(repo, "exceptions_for_payment") else []
        if any(e["kind"] == "DUPLICATE_PAYMENT" for e in exc):
            label = "Held - looks like a duplicate of another payment"
        out.append({"payment_id": p.payment_id, "amount_cents": p.amount_cents,
                    "status": status, "status_label": label,
                    "references": p.references or []})
    return out

@app.get("/api/v1/portal/{token}/summary")
def portal_summary(token: str):
    info = _portal_scope(token); repo = repo_for(info["tenant_id"])
    customer = info["customer"]
    invoices = [{"invoice_id": r["invoice_id"], "amount_due_cents": r["gross_cents"],
                 "due_in_days": r["due_in_days"], "po_number": r.get("po_number"),
                 "partial": r.get("partial")}
                for r in _attach_partials(repo, [asdict(i) for i in repo.open_invoices()])
                if r["customer"] == customer]
    payments = _portal_payments(repo, customer)
    pay_ids = {p["payment_id"] for p in payments}
    disputes = [{"dispute_id": d["dispute_id"], "payment_id": d["payment_id"],
                 "claimed_cents": d["claimed_cents"], "reason_code": d["reason_code"],
                 "status": d["status"],
                 "responses": repo.list_portal_responses(d["dispute_id"])}
                for d in repo.list_disputes() if d["payment_id"] in pay_ids]
    return {"customer": customer, "open_invoices": invoices,
            "payments": payments, "disputes": disputes,
            "note": "This link shows only your company's invoices, payments "
                    "and disputes with us. It cannot see anything else."}

class PortalRemittanceIn(BaseModel):
    text: str

@app.post("/api/v1/portal/{token}/remittance")
def portal_remittance(token: str, body: PortalRemittanceIn):
    info = _portal_scope(token); repo = repo_for(info["tenant_id"])
    customer = info["customer"]
    invs = [i for i in repo.open_invoices() if i.customer == customer]
    out = parse_remittance(body.text, {i.invoice_id for i in invs},
                           {i.po_number for i in invs if i.po_number})
    f = out["fields"]
    amount = int(f.get("amount_cents") or 0)
    if amount <= 0:
        raise HTTPException(422, "we could not read a payment amount from that advice")
    from domain import Payment as _Payment
    pid = "PORTAL-" + uuid.uuid4().hex[:8].upper()
    refs = list(f.get("invoice_refs") or []) + list(f.get("po_refs") or [])
    for inv in invs:
        if inv.invoice_id in body.text and inv.invoice_id not in refs:
            refs.append(inv.invoice_id)
    repo.add_payment(_Payment(payment_id=pid, payer_raw=customer,
                              amount_cents=amount, currency="USD",
                              references=refs, remittance_text=body.text))
    repo.add_feed_event("portal_remittance",
                        f"{customer} via portal: staged {pid} ${amount / 100:,.2f}",
                        _now_iso())
    return {"staged_payment_id": pid, "amount_cents": amount, "references": refs,
            "message": "Thank you - your remittance advice is with our team and "
                       "will be reconciled on the next payment run."}

class PortalPromiseIn(BaseModel):
    invoice_id: str
    promised_date: str
    note: str = ""

@app.post("/api/v1/portal/{token}/promise")
def portal_promise(token: str, body: PortalPromiseIn):
    info = _portal_scope(token); repo = repo_for(info["tenant_id"])
    customer = info["customer"]
    inv = next((i for i in repo.open_invoices()
                if i.invoice_id == body.invoice_id and i.customer == customer), None)
    if inv is None:
        raise HTTPException(404, "that invoice is not open for your company")
    import re as _re2
    if not _re2.fullmatch(r"\d{4}-\d{2}-\d{2}", body.promised_date or ""):
        raise HTTPException(422, "promised_date must be YYYY-MM-DD")
    repo.add_promise(inv.invoice_id, customer, inv.gross_cents,
                     body.promised_date, body.note or "Promised via the payer portal",
                     _now_iso())
    repo.add_feed_event("portal_promise",
                        f"{customer} via portal: promised {inv.invoice_id} by {body.promised_date}",
                        _now_iso())
    return {"invoice_id": inv.invoice_id, "promised_date": body.promised_date,
            "message": "Thank you - your promise to pay has been recorded."}

class PortalRespondIn(BaseModel):
    stance: str
    note: str = ""

@app.post("/api/v1/portal/{token}/disputes/{dispute_id}/respond")
def portal_respond(token: str, dispute_id: str, body: PortalRespondIn):
    info = _portal_scope(token); repo = repo_for(info["tenant_id"])
    customer = info["customer"]
    pay_ids = {p["payment_id"] for p in _portal_payments(repo, customer)}
    d = next((x for x in repo.list_disputes()
              if x["dispute_id"] == dispute_id and x["payment_id"] in pay_ids), None)
    if d is None:
        raise HTTPException(404, "that dispute is not one of your company's")
    if body.stance not in ("accepted", "evidence", "question"):
        raise HTTPException(422, "stance must be accepted, evidence or question")
    repo.add_portal_response(dispute_id, body.stance, body.note, _now_iso())
    repo.add_feed_event("portal_dispute_response",
                        f"{customer} via portal: responded to {dispute_id} ({body.stance})",
                        _now_iso())
    return {"dispute_id": dispute_id,
            "message": "Thank you - your response is recorded and will be "
                       "reviewed by our team. The claim status itself is "
                       "decided by our team, not by this form."}

class PortalLinkIn(BaseModel):
    customer: str

@app.post("/api/v1/portal-links")
def create_portal_link(body: PortalLinkIn, ctx=Depends(auth_context)):
    need(ctx, "approve")
    if not (body.customer or "").strip():
        raise HTTPException(422, "customer name is required")
    raw, link_id = store.create_portal_token(ctx["tenant_id"], body.customer.strip())
    return {"link_id": link_id, "customer": body.customer.strip(),
            "url": f"/portal/{raw}",
            "note": "This link is shown once. Anyone holding it sees this "
                    "customer's invoices, payments and disputes - share it "
                    "only with that customer."}

@app.get("/api/v1/portal-links")
def list_portal_links(ctx=Depends(auth_context)):
    need(ctx, "read")
    return {"links": store.list_portal_tokens(ctx["tenant_id"])}

@app.delete("/api/v1/portal-links/{link_id}")
def revoke_portal_link(link_id: str, ctx=Depends(auth_context)):
    need(ctx, "approve")
    if not store.revoke_portal_token(ctx["tenant_id"], link_id):
        raise HTTPException(404, "link not found or already revoked")
    return {"revoked": link_id}

from fastapi.responses import FileResponse as _FileResponse

@app.get("/portal/{token}")
def portal_page(token: str):
    path = os.path.join(os.path.dirname(__file__), "..", "..", "frontend", "portal.html")
    if not os.path.isfile(path):
        raise HTTPException(404, "portal page not installed")
    return _FileResponse(os.path.abspath(path), media_type="text/html")

# ---- Mail: send the product's drafts, with an honest outbox ----
class MailSendIn(BaseModel):
    to: str; subject: str; body: str; kind: str = "other"; ref_id: str = ""

class ReminderIn(BaseModel):
    invoice_id: str

@app.post("/api/v1/mail/reminder")
def mail_reminder(body: ReminderIn, ctx=Depends(auth_context)):
    """A collection reminder drafted from the ledger row itself."""
    need(ctx, "read"); repo = repo_for(ctx["tenant_id"])
    inv = next((i for i in repo.open_invoices() if i.invoice_id == body.invoice_id), None)
    if inv is None:
        raise HTTPException(404, f"invoice {body.invoice_id} is not open in this workspace")
    return reminder_draft(inv)

@app.post("/api/v1/mail/send")
def mail_send(body: MailSendIn, ctx=Depends(auth_context)):
    """Send (or, until a mailbox is configured, record) one mail.
    The outbox record always carries the true status."""
    need(ctx, "run"); repo = repo_for(ctx["tenant_id"])
    try:
        return send_mail(repo, f"api:{ctx['role']}", body.to, body.subject,
                         body.body, body.kind, body.ref_id)
    except ValueError as e:
        raise HTTPException(422, str(e))

@app.get("/api/v1/mail/outbox")
def mail_outbox(ctx=Depends(auth_context)):
    need(ctx, "read"); repo = repo_for(ctx["tenant_id"])
    cfg = mail_config()
    return {"configured": cfg["configured"], "from": cfg["from"],
            "mails": repo.list_outbox(50)}

@app.get("/api/v1/mail/hub")
def mail_hub(ctx=Depends(auth_context)):
    """The Outbound Mail & Dispute Hub: every agent outcome that should
    leave the building, in four categories, all read from the same
    workspace state as every other view. Categories 1-3 come from the
    latest run's records; category 4 is the residual ledger segmented
    into dunning tones. The state rule matches the forecast: no case,
    or a case with no run yet, means no mail at all."""
    need(ctx, "read"); repo = repo_for(ctx["tenant_id"])
    case = repo.get_meta("active_case")
    runs = repo.list_runs(1)
    state = "empty" if not case else ("loaded_not_run" if not runs else "ready")
    out = {"state": state, "configured": mail_config()["configured"],
           "disputes": [], "chases": [], "settlements": [], "dunning": [],
           "outbox": repo.list_outbox(50)}
    if state != "ready":
        return out
    run = runs[0]
    matches = repo.matches_for_run(run["run_id"])
    excs = repo.exceptions_for_run(run["run_id"])
    pays = {p.payment_id: p for p in repo.all_payments()}
    for m in matches:
        res = m["result"] or {}
        ded = res.get("deduction") or {}
        pay = res.get("payment") or {}
        if ded.get("autonomous_action") == "AUTO_GENERATE_DISPUTE_CLAIM":
            out["disputes"].append({
                "payment_id": m["payment_id"], "payer": ded.get("payer") or pay.get("payer_raw") or "",
                "claimed_cents": ded.get("claimed_cents", 0),
                "reason_code": ded.get("assigned_erp_reason_code", ""),
                "classification": (ded.get("classification") or {}).get("label", ""),
                "win_probability": ded.get("win_probability"),
                "expected_recovery_usd": ded.get("expected_recovery_value_usd", 0),
                "invoices": [l.get("invoice_id") for l in res.get("lines") or []],
                "pod_clean": pay.get("pod_verified_clean")})
        if m["status"] in ("AUTO_POSTED", "APPROVED_POSTED"):
            lines = res.get("lines") or []
            out["settlements"].append({
                "payment_id": m["payment_id"], "payer": pay.get("payer_raw") or "",
                "status": m["status"], "invoices": lines,
                "gross_cents": sum(l.get("gross_cents", 0) for l in lines),
                "discount_cents": sum(l.get("discount_cents", 0) or 0 for l in lines),
                "net_cents": sum(l.get("net_cents", 0) for l in lines),
                "erp_document_id": (res.get("approval") or {}).get("erp_document_id")})
    out["disputes"].sort(key=lambda d: -float(d["expected_recovery_usd"] or 0))
    out["settlements"].sort(key=lambda s: s["payment_id"])
    for e in excs:
        if e["kind"] in ("NO_MATCH", "DUPLICATE_PAYMENT", "UNRESOLVED_RESIDUAL"):
            p = pays.get(e["payment_id"])
            detail = e.get("detail") or {}
            out["chases"].append({
                "payment_id": e["payment_id"], "kind": e["kind"],
                "severity": e.get("severity", ""),
                "payer": p.payer_raw if p else "",
                "amount_cents": detail.get("amount_cents") or (p.amount_cents if p else 0),
                "residual_cents": detail.get("residual_cents", 0),
                "recommended_action": e.get("recommended_action", "")})
    for inv in _residual_invoices(repo):
        tone, tone_label = reminder_tone(inv)
        out["dunning"].append({
            "invoice_id": inv.invoice_id, "customer": inv.customer,
            "gross_cents": inv.gross_cents, "due_in_days": inv.due_in_days,
            "tone": tone, "tone_label": tone_label})
    out["dunning"].sort(key=lambda d: d["due_in_days"])
    return out

@app.post("/api/v1/why-not")
def why_not(body: WhyNotIn, ctx=Depends(auth_context)):
    need(ctx, "read"); invs = repo_for(ctx["tenant_id"]).open_invoices()
    return why_not_invoice(_pay(body.payment), invs, body.invoice_id, Policy())

_evaluations_cache = {}

@app.get("/api/v1/evaluations")
def evaluations():
    """Live evaluation on the labelled seed scenarios (fresh temp DB per call
    is unnecessary: scenarios run in-memory against the seed ledger).

    The result is a pure function of the code - fixed seed scenarios,
    default policy, no workspace input - so it is computed once per
    process and then served from memory (~44ms of MILP/greedy solves
    per call became ~0ms for every view after the first)."""
    if "payload" in _evaluations_cache:
        return _evaluations_cache["payload"]
    invs = seed_invoices(); pays = {p.payment_id: p for p in seed_payments()}
    from batch import resolve_candidates

    def _one(item):
        pid, truth = item
        pay = pays[pid]
        cands, _src = resolve_candidates(pay, invs, {})
        m = solve_milp(pay, cands, Policy())
        g = solve_greedy(pay, cands, Policy())
        got = {l.invoice_id for l in m.lines}
        return {"payment_id": pid, "expected": sorted(truth), "milp_got": sorted(got),
                "milp_residual_cents": m.residual_cents, "milp_correct": got == truth,
                "greedy_correct": {l.invoice_id for l in g.lines} == truth}

    # The cases are independent pure solves over shared read-only seed
    # data, so they run on a small bounded pool instead of one after
    # another; executor.map preserves the ground-truth order, so the
    # response is identical to the sequential computation.
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=4) as pool:
        rows = list(pool.map(_one, GROUND_TRUTH.items()))
    correct = sum(r["milp_correct"] for r in rows)
    exact = sum(r["milp_residual_cents"] == 0 for r in rows)
    greedy_correct = sum(r["greedy_correct"] for r in rows)
    n = len(GROUND_TRUTH)
    payload = {"cases": rows, "milp_accuracy": round(correct / n, 4), "greedy_accuracy": round(greedy_correct / n, 4),
            "milp_exact_rate": round(exact / n, 4),
            "basis": "Labelled synthetic seed scenarios (split, PO-won, discount+deduction, OCR-repaired reference, amount-only, multi-invoice, exact). Computed by this server's solver code from the fixed scenario set."}
    _evaluations_cache["payload"] = payload
    return payload




# ---- Session save & retrieve -------------------------------------------
# A workspace session can be snapshotted under a short session ID and
# restored later, byte for byte, by entering that ID. Snapshots are
# SQLite VACUUM INTO copies of the session's database file, kept in
# <data_dir>/saved_sessions/ for the life of the deployment (the data
# dir is ephemeral by design, and the UI says so).
import sqlite3 as _sqlite3, shutil as _shutil, secrets as _secrets

_SAVE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

def _saved_dir():
    d = os.path.join(store.base_dir, "saved_sessions")
    os.makedirs(d, exist_ok=True)
    return d

def _save_key(raw):
    s = _re.sub(r"[^A-Za-z0-9]", "", raw or "").upper()
    if s.startswith("SM"): s = s[2:]
    return s

def _manifest():
    p = os.path.join(_saved_dir(), "index.json")
    try:
        with open(p) as f: return json.load(f)
    except Exception:
        return {}

def _manifest_put(key, meta):
    m = _manifest(); m[key] = meta
    p = os.path.join(_saved_dir(), "index.json")
    tmp = p + ".tmp"
    with open(tmp, "w") as f: json.dump(m, f)
    os.replace(tmp, p)

def _manifest_drop(keys):
    if not keys: return
    m = _manifest()
    for k in keys: m.pop(k, None)
    p = os.path.join(_saved_dir(), "index.json")
    tmp = p + ".tmp"
    with open(tmp, "w") as f: json.dump(m, f)
    os.replace(tmp, p)

_SAVE_CAP_PER_TENANT = 20

def _prune_saves(base_tenant):
    """Keep at most _SAVE_CAP_PER_TENANT snapshots per tenant; the
    oldest are deleted (file + manifest entry). Snapshots used to
    accumulate for the life of the deployment with no bound."""
    mine = [(k, m) for k, m in _manifest().items() if m.get("tenant") == base_tenant]
    if len(mine) <= _SAVE_CAP_PER_TENANT: return
    mine.sort(key=lambda km: km[1].get("saved_at", ""))
    drop = [k for k, _ in mine[:len(mine) - _SAVE_CAP_PER_TENANT]]
    for k in drop:
        try: os.remove(os.path.join(_saved_dir(), k + ".db"))
        except OSError: pass
    _manifest_drop(drop)

_SESSION_DB_RE = _re.compile(r"^.+--[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.db$")
_SESSION_TTL_DAYS = 7
_last_reap = [0.0]

def _reap_session_dbs():
    """Delete ephemeral per-tab workspace databases (tenant files of
    the form <base>--<uuid>.db) untouched for _SESSION_TTL_DAYS.
    Every browser tab used to leave one file behind forever. Base
    tenant databases never match the pattern, snapshots live in a
    subdirectory, and workspaces currently open are never touched."""
    cutoff = _time.time() - _SESSION_TTL_DAYS * 86400
    with _repos_lock:
        open_tenants = set(_repos.keys())
    try: names = os.listdir(store.base_dir)
    except OSError: return
    for name in names:
        if not _SESSION_DB_RE.match(name): continue
        if name[:-3] in open_tenants: continue
        path = os.path.join(store.base_dir, name)
        try:
            if os.path.getmtime(path) >= cutoff: continue
        except OSError: continue
        for suffix in ("", "-wal", "-shm"):
            try: os.remove(path + suffix)
            except OSError: pass
    # Hard bound: even inside the TTL window, a flood of fresh
    # sessions must not grow the directory without limit. Evict the
    # oldest files beyond the cap (open workspaces excluded above).
    remaining = []
    for name in names:
        if not _SESSION_DB_RE.match(name): continue
        if name[:-3] in open_tenants: continue
        if not os.path.exists(os.path.join(store.base_dir, name)): continue  # reaped above
        remaining.append(name)
    if len(remaining) > _SESSION_FILE_CAP:
        remaining.sort(key=lambda n: os.path.getmtime(os.path.join(store.base_dir, n)))
        for name in remaining[:len(remaining) - _SESSION_FILE_CAP]:
            path = os.path.join(store.base_dir, name)
            for suffix in ("", "-wal", "-shm"):
                try: os.remove(path + suffix)
                except OSError: pass

_SESSION_FILE_CAP = 256

def _maybe_reap():
    now = _time.time()
    if now - _last_reap[0] < 3600: return
    _last_reap[0] = now
    try: _reap_session_dbs()
    except Exception: pass

def _db_counts(path):
    out = {}
    con = _sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        for t in ("invoices", "payments", "runs", "matches"):
            try: out[t] = con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
            except Exception: out[t] = 0
    finally:
        con.close()
    return out

@app.post("/api/v1/session/save")
def session_save(body: dict = None, ctx=Depends(auth_context)):
    need(ctx, "run")
    repo = repo_for(ctx["tenant_id"])
    while True:
        body10 = "".join(_secrets.choice(_SAVE_ALPHABET) for _ in range(10))
        save_id = f"SM-{body10[:5]}-{body10[5:]}"
        dest = os.path.join(_saved_dir(), body10 + ".db")
        if not os.path.exists(dest): break
    repo.audit(f"api:{ctx['role']}", "session_saved", "session", save_id,
               {"tenant": ctx["base_tenant"]}, _now_iso())
    con = _sqlite3.connect(repo.path)
    try:
        con.execute("VACUUM INTO ?", (dest,))
    finally:
        con.close()
    meta = {"save_id": save_id, "saved_at": _now_iso(), "tenant": ctx["base_tenant"],
            "label": ((body or {}).get("label") or "").strip()[:80],
            "counts": _db_counts(dest)}
    _manifest_put(body10, meta)
    _prune_saves(ctx["base_tenant"])
    _maybe_reap()
    return {"save_id": save_id, "saved_at": meta["saved_at"], "counts": meta["counts"],
            "storage": "Snapshots live on this server for the life of the deployment; a redeploy clears them."}

@app.get("/api/v1/session/saves")
def session_saves(ctx=Depends(auth_context)):
    need(ctx, "read")
    saves = sorted(_manifest().values(), key=lambda m: m.get("saved_at", ""), reverse=True)
    return {"saves": saves}

@app.post("/api/v1/session/restore")
def session_restore(body: dict, ctx=Depends(auth_context)):
    need(ctx, "run")
    key = _save_key((body or {}).get("save_id") or (body or {}).get("session_id") or "")
    src = os.path.join(_saved_dir(), key + ".db")
    if len(key) != 10 or not os.path.exists(src):
        raise HTTPException(404, "No saved session with that ID. Check the ID and try again - IDs look like SM-7K2QX-9M4TD.")
    repo = repo_for(ctx["tenant_id"])
    target = repo.path
    if os.path.abspath(src) == os.path.abspath(target):
        raise HTTPException(409, "That snapshot is this workspace's own file; nothing to restore.")
    tmp = target + ".restore-tmp"
    _shutil.copyfile(src, tmp)
    with _repos_lock:
        _repos.pop(ctx["tenant_id"], None)
    for suffix in ("-wal", "-shm"):
        try: os.remove(target + suffix)
        except OSError: pass
    os.replace(tmp, target)
    meta = _manifest().get(key, {})
    fresh = repo_for(ctx["tenant_id"])
    fresh.audit(f"api:{ctx['role']}", "session_restored", "session", meta.get("save_id", key),
                {"saved_at": meta.get("saved_at")}, _now_iso())
    return {"restored": True, "save_id": meta.get("save_id", key),
            "saved_at": meta.get("saved_at"), "counts": _db_counts(target)}

# ---- Admin / tenancy ----
class TenantIn(BaseModel):
    name: str
class KeyIn(BaseModel):
    role: str; label: str = ""
class PolicyIn(BaseModel):
    policy: dict

def _bootstrap(x_api_key: str = Header(default="")):
    if not BOOTSTRAP_KEY or x_api_key != BOOTSTRAP_KEY:
        raise HTTPException(401, "bootstrap key required")
    return True

@app.post("/admin/tenants")
def admin_create_tenant(body: TenantIn, ok=Depends(_bootstrap)):
    tid = store.create_tenant(body.name)
    return {"tenant_id": tid, "name": body.name}

@app.post("/admin/tenants/{tenant_id}/keys")
def admin_issue_key(tenant_id: str, body: KeyIn, ok=Depends(_bootstrap)):
    if not store.tenant_exists(tenant_id): raise HTTPException(404, "tenant not found")
    raw = store.issue_key(tenant_id, body.role, body.label)
    return {"api_key": raw, "tenant_id": tenant_id, "role": body.role,
            "note": "Shown once. Store it in your secrets manager; only its hash is kept here."}

@app.get("/api/v1/policy")
def get_policy(ctx=Depends(auth_context)):
    need(ctx, "read")
    return {"policy": store.get_policy(ctx["tenant_id"]) or asdict(Policy()), "source": "tenant" if store.get_policy(ctx["tenant_id"]) else "default"}

@app.put("/api/v1/policy")
def put_policy(body: PolicyIn, ctx=Depends(auth_context)):
    need(ctx, "admin")
    before = store.get_policy(ctx["tenant_id"])
    # Merge over the stored policy (see _policy_for): a partial post
    # updates the fields it names and preserves the rest.
    merged = {**(before or {}), **body.policy}
    try:
        Policy(**merged)  # field names AND value ranges (Policy.__post_init__)
    except (TypeError, ValueError) as e:
        raise HTTPException(422, f"invalid policy: {e}")
    store.set_policy(ctx["tenant_id"], merged)
    repo = repo_for(ctx["tenant_id"])
    repo.audit(f"api:{ctx['role']}", "policy_updated", "policy", ctx["tenant_id"],
               {"before": before, "after": merged}, _now_iso())
    return {"saved": True}

@app.post("/api/v1/policy/preview")
def policy_preview(body: PolicyIn, ctx=Depends(auth_context)):
    """Dry-run the workspace's full book and batch under a candidate
    policy on a throwaway copy of the ledger, and diff the outcome
    against the latest stored run. Nothing in the real workspace is
    written: this answers 'what would this policy change do to the
    run I already have?' with the real engine, not an estimate."""
    need(ctx, "run")
    repo = repo_for(ctx["tenant_id"])
    try:
        Policy(**body.policy)  # validate
    except (TypeError, ValueError) as e:
        raise HTTPException(422, f"invalid policy: {e}")
    candidate = dict(body.policy)
    # The active case's disclosed override normally sits on top of the
    # tenant policy - but a key the user has just EDITED in the form is
    # the change being previewed, so edited keys win over the override.
    stored = store.get_policy(ctx["tenant_id"]) or {}
    edited = {k for k, v in body.policy.items() if stored.get(k) != v}
    case = repo.get_meta("active_case") or {}
    for k, v in (case.get("policy") or {}).items():
        if k not in edited:
            candidate[k] = v
    runs = repo.list_runs(1)
    if not runs:
        return {"base_run_id": None, "note": "No run yet - nothing to diff against."}
    base_run = runs[0]
    before = {m["payment_id"]: m["status"] for m in repo.matches_for_run(base_run["run_id"])}
    amounts = {p.payment_id: p.amount_cents for p in repo.all_payments()}
    import tempfile, shutil as _sh
    tmpdir = tempfile.mkdtemp(prefix="slatematch-preview-")
    try:
        trepo = Repository(os.path.join(tmpdir, "preview.db"))
        for inv in repo.all_invoices():
            trepo.add_invoice(inv)
        for pay in repo.all_payments():
            trepo.add_payment(pay, "")
        for row in repo.conn.execute("SELECT raw_name, customer, source FROM aliases").fetchall():
            trepo.conn.execute("INSERT OR REPLACE INTO aliases VALUES (?,?,?)", row)
        trepo.conn.commit()
        out = run_batch(trepo, trepo.all_payments(), Policy(**candidate),
                        "preview-" + uuid.uuid4().hex[:10], actor="policy-preview")
        after = {m["payment_id"]: m["status"] for m in trepo.matches_for_run(out["run_id"])}
        exc_after = len(trepo.exceptions_for_run(out["run_id"]))
        trepo.conn.close()
    finally:
        _sh.rmtree(tmpdir, ignore_errors=True)
    posted = ("AUTO_POSTED", "APPROVED_POSTED")
    moved_hold = [{"payment_id": pid, "amount_cents": amounts.get(pid, 0)}
                  for pid in before if before[pid] in posted and after.get(pid) not in posted]
    moved_auto = [{"payment_id": pid, "amount_cents": amounts.get(pid, 0)}
                  for pid in after if after[pid] in posted and before.get(pid) not in posted]
    return {"base_run_id": base_run["run_id"],
            "evaluated_payments": len(after),
            "auto_before": sum(1 for s in before.values() if s in posted),
            "auto_after": sum(1 for s in after.values() if s in posted),
            "posted_value_before_cents": sum(amounts.get(p, 0) for p, s in before.items() if s in posted),
            "posted_value_after_cents": sum(amounts.get(p, 0) for p, s in after.items() if s in posted),
            "moved_to_approvals": moved_hold, "moved_to_auto": moved_auto,
            "exceptions_after": exc_after,
            "note": "Computed by re-running the real engine on a scratch copy of this workspace. The stored policy and the workspace were not changed."}


# ---- Observability: request ids, structured logs, metrics, readiness, rate limits ----
import time as _time, uuid as _uuid, collections as _collections
from fastapi import Request
from fastapi.responses import JSONResponse, PlainTextResponse

_metrics = {"counts": _collections.Counter(), "latency_ms": _collections.Counter()}
_rate_windows = _collections.defaultdict(list)

def _rate_limit_per_min():
    try: return int(_env("RATE_LIMIT_PER_MIN", "300"))
    except Exception: return 300

@app.middleware("http")
async def ops_middleware(request: Request, call_next):
    rid = request.headers.get("x-request-id") or str(_uuid.uuid4())
    key_id = request.headers.get("x-api-key", "anon")
    # Anonymous traffic is bucketed per client IP: a single shared
    # "anon" bucket let one heavy visitor rate-limit every other
    # visitor on the public demo.
    bucket = hashlib.sha256(key_id.encode()).hexdigest()[:12] if key_id != "anon" else f"anon:{_client_ip(request)}"
    now = _time.time()
    win = [t for t in _rate_windows[bucket] if now - t < 60]
    limit = _rate_limit_per_min()
    if len(win) >= limit and request.url.path.startswith("/api/"):
        return JSONResponse({"detail": "rate limit exceeded", "request_id": rid}, status_code=429,
                            headers={"Retry-After": "60", "X-Request-Id": rid})
    win.append(now); _rate_windows[bucket] = win
    _maybe_reap()  # hourly-throttled housekeeping for ephemeral session DBs
    if len(_rate_windows) > 256:  # sweep buckets whose window has fully expired
        for b in [b for b, w in _rate_windows.items() if not w or now - max(w) >= 60]:
            _rate_windows.pop(b, None)
    start = _time.time()
    response = await call_next(request)
    dur_ms = round((_time.time() - start) * 1000, 2)
    route = request.url.path
    _metrics["counts"][(route, str(response.status_code))] += 1
    _metrics["latency_ms"][route] += dur_ms
    response.headers["X-Request-Id"] = rid
    print(json.dumps({"ts": round(now, 3), "request_id": rid, "method": request.method,
                      "path": route, "status": response.status_code, "duration_ms": dur_ms,
                      "key_bucket": bucket}), flush=True)
    return response

@app.get("/metrics")
def metrics():
    lines = ["# HELP slatematch_requests_total Requests by path and status", "# TYPE slatematch_requests_total counter"]
    for (path, status), n in sorted(_metrics["counts"].items()):
        lines.append(f'slatematch_requests_total{{path="{path}",status="{status}"}} {n}')
    lines += ["# HELP slatematch_request_latency_ms_total Cumulative latency per path", "# TYPE slatematch_request_latency_ms_total counter"]
    for path, ms in sorted(_metrics["latency_ms"].items()):
        lines.append(f'slatematch_request_latency_ms_total{{path="{path}"}} {ms}')
    return PlainTextResponse("\n".join(lines) + "\n", media_type="text/plain")

@app.get("/ready")
def ready():
    checks = {}
    try:
        with store.lock:
            store.conn.execute("SELECT 1").fetchone()
        checks["control_db"] = "ok"
    except Exception as e: checks["control_db"] = f"error: {type(e).__name__}"
    checks["data_dir_writable"] = "ok" if os.access(DATA_DIR, os.W_OK) else "error"
    try:
        models(); checks["models"] = "ok"
    except Exception as e: checks["models"] = f"error: {type(e).__name__}"
    ok = all(v == "ok" for v in checks.values())
    return JSONResponse({"ready": ok, "checks": checks}, status_code=200 if ok else 503)

FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "frontend")
if os.path.isdir(FRONTEND_DIR):
    app.mount("/", StaticFiles(directory=os.path.abspath(FRONTEND_DIR), html=True), name="frontend")
