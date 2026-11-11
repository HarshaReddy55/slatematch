"""v13 surfacing: ERP documents from erp_sap, diagnostics, in-app docs,
and demo tenant switching with real database isolation."""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
os.environ.setdefault("SLATEMATCH_DATA_DIR", os.path.join(os.path.dirname(__file__), "api_data"))
from fastapi.testclient import TestClient
import api as api_mod

client = TestClient(api_mod.app)


def _seed_run(key):
    client.post("/api/v1/workspace/reset")
    client.post("/api/v1/cases/seed/load")
    ws = client.get("/api/v1/workspace").json()
    r = client.post("/api/v1/batches", json={
        "idempotency_key": key, "payments": ws["pending_payments"]})
    assert r.status_code == 200, r.text
    return r.json()


def test_erp_document_is_balanced_and_built_from_the_match():
    _seed_run("v13-erp-1")
    r = client.get("/api/v1/payments/P1/erp-document")
    assert r.status_code == 200, r.text
    d = r.json()["document"]
    assert d["balanced"] is True
    assert d["total_debits_cents"] == d["total_credits_cents"] > 0
    assert d["bapi_payload"]["DOCUMENTHEADER"]["DOCUMENT_TYPE"] == "DZ"
    # P1 auto-posted: a cleared match always carries a deterministic
    # document number (never null), staged for SAP - not a preview.
    assert d["status"] == "STAGED_FOR_SAP_POSTING" and d["document_number"].startswith("DZ-1400")
    # P3 carries a dispute claim: the revrec accrual must ride along
    r3 = client.get("/api/v1/payments/P3/erp-document")
    assert r3.status_code == 200, r3.text
    acc = r3.json().get("revrec_accrual")
    assert acc and acc["balanced"] is True
    assert acc["journal"][0]["gl_account"] == "121500"


def test_erp_document_unknown_payment_404():
    assert client.get("/api/v1/payments/NOPE/erp-document").status_code == 404


def test_diagnostics_reports_kernel_and_suite():
    d = client.get("/api/v1/diagnostics").json()
    assert "present" in d["rust_kernel"]
    assert d["rust_kernel"]["equivalence_probe"]["status"] in (
        "pass", "fail", "kernel_absent")
    assert d["test_suite"]["module_count"] >= 15
    assert "test_rust_equivalence" in d["test_suite"]["modules"]
    assert "test_milp_solvers" in d["test_suite"]["modules"]
    assert "test_reference_engine" in d["test_suite"]["modules"]


def test_docs_list_and_read():
    d = client.get("/api/v1/docs").json()
    names = {x["name"] for x in d["docs"]}
    assert {"PRD.md", "ARCHITECTURE.md", "GO_TO_MARKET.md"} <= names
    # The pack reads in flow order, PRD first, challenges last.
    ordered = [x["name"] for x in d["docs"]]
    assert ordered[0] == "PRD.md" and ordered[-1] == "CHALLENGES.md", ordered
    assert ordered.index("ARCHITECTURE.md") < ordered.index("GO_TO_MARKET.md")
    r = client.get("/api/v1/docs/PRD.md")
    assert r.status_code == 200 and len(r.json()["markdown"]) > 500
    assert client.get("/api/v1/docs/NOPE.md").status_code == 404
    assert client.get("/api/v1/docs/requirements.txt").status_code == 404


def test_demo_tenant_switch_isolates_data():
    client.post("/api/v1/workspace/reset")
    client.post("/api/v1/cases/seed/load")
    assert len(client.get("/api/v1/invoices").json()) == 19
    eu = {"X-Tenant-Id": "demo-eu"}
    assert client.get("/api/v1/invoices", headers=eu).json() == []
    info = client.get("/api/v1/tenants/demo", headers=eu).json()
    assert info["switching_enabled"] is True and info["active"] == "demo-eu"
    assert {t["id"] for t in info["tenants"]} == {"demo", "demo-eu"}
    # an unknown tenant id falls back to the default demo tenant
    bad = client.get("/api/v1/tenants/demo", headers={"X-Tenant-Id": "acme"}).json()
    assert bad["active"] == "demo"
    # the default tenant still holds the seed case
    assert len(client.get("/api/v1/invoices").json()) == 19


def test_navigation_is_the_fourteen_page_structure():
    """v28: the 6-step tour is retired. The shell carries Harsha's 14 pages
    in three named groups, in his order, and every page is its own section -
    no composite step pages, no stepper, no next-step tour bar."""
    import re
    html = client.get("/").text
    nav = re.findall(r'data-s="([a-z]+)"', html)
    assert nav == ["dash", "cases", "upload", "run", "sap", "ledger", "forecast", "mail",
                   "policy", "eval", "health",
                   "method", "arch", "product"], nav
    for grp in ["OPERATE", "INSIGHT &amp; GOVERNANCE", "EVALS &amp; ARCHITECTURE"]:
        assert grp in html, grp
    for sid in nav:
        assert f'<section id="{sid}"' in html, sid
    assert 'id="stepper"' not in html and 'id="tourbar"' not in html
    assert 'id="step1"' not in html and 'id="gov"' not in html and 'id="score"' not in html
    # the maker-checker queue lives on the Run page now, not in Policy Studio
    run_sec = html[html.index('<section id="run"'):html.index('<section id="sap"')]
    assert 'id="appr-out"' in run_sec
    pol_sec = html[html.index('<section id="policy"'):html.index('<section id="eval"')]
    assert 'id="policy-form"' in pol_sec and 'id="appr-out"' not in pol_sec


def test_smooth_layer_contract():
    """v29: the feel layer - loadbar + boot skeletons in the shell, no raw
    'Loading...' text placeholders, brief preference + Escape + gen-cached
    navigation + optimistic decisions wired in the scripts, and the CSS
    primitives (spinner, skeleton, row flash) present."""
    html = client.get("/").text
    assert 'id="loadbar"' in html and 'class="boot"' in html
    assert "<small>Loading" not in html
    js = client.get("/js/state.js").text
    for token in ["slate-brief", "Escape", "jumpToApprovals", "LOADED_GEN",
                  "busyBtn", "bumpGen", "row-highlight-flash"]:
        assert token in js, token
    assist = client.get("/js/assist.js").text
    assert "document staged for SAP" in assist and "Parked in suspense" in assist
    css = client.get("/css/livecube.css").text
    for token in [".skeleton-line", ".skeleton-card", ".spin",
                  ".row-highlight-flash", "#loadbar", "prefers-reduced-motion"]:
        assert token in css, token


def test_sections_are_siblings_never_nested():
    # Regression (v30): the v28 Policy Studio move dropped the section's
    # closing tag, so Evaluations..Product Thinking nested INSIDE Policy
    # Studio and could never display - every ancestor is display:none
    # unless Policy itself is active. Sections must be siblings.
    from html.parser import HTMLParser
    class P(HTMLParser):
        def __init__(self):
            super().__init__()
            self.open_sections = []
            self.nested = []
        def handle_starttag(self, tag, attrs):
            if tag == "section":
                if self.open_sections:
                    self.nested.append(dict(attrs).get("id"))
                self.open_sections.append(dict(attrs).get("id"))
        def handle_endtag(self, tag):
            if tag == "section" and self.open_sections:
                self.open_sections.pop()
    p = P()
    p.feed(client.get("/").text)
    assert p.nested == [], f"sections nested inside another section: {p.nested}"
    assert p.open_sections == [], f"unclosed sections: {p.open_sections}"


def test_v31_staged_lifecycle_contract():
    """v31: loading stages, execution is explicit and visible. The shell
    carries the readiness/gate helpers, the persistent agent strip with
    per-agent counts, the live-proof mutation, the quota-safe AI framing,
    and the current cache-bust stamps (v57 since the explanation pass)."""
    html = client.get("/").text
    assert 'css/livecube.css?v=57' in html and 'js/state.js?v=57' in html
    # v32 declutter: no standalone Load demo case button anywhere, and the
    # author credit sits above the nav so it can never clip items 12-14
    assert '>Load demo case</button>' not in html
    # v33: the credit is back at the sidebar bottom, after the nav; the
    # nav is its own scroll box (visible styled scrollbar), so items
    # 12-14 are reachable and can never sit under the credit
    assert html.index('</nav>') < html.index('builtby') < html.index('</header>')
    assert '<details class="agentref">' in html
    # v57 explanation pass: the Next Step tour footers are gone.
    assert html.count('class="nextstep"') == 0
    js = ""
    import os
    fe = os.path.join(os.path.dirname(__file__), "..", "..", "frontend", "js")
    for f in ("state.js", "operate.js", "insight.js", "assist.js"):
        js += open(os.path.join(fe, f)).read()
    for token in ("run_status", "stagedGateHtml", "executeActiveCase",
                  "Staged portfolio readiness", "mutateFirstWire",
                  "Deterministic Verifier Fallback Active (Quota-Safe Mode",
                  "goMailFor", "MAIL_FOCUS", "payments_received"):
        assert token in js, token
    # the backend stages on load: no run, explicit execution endpoint
    import importlib
    out = client.post("/api/v1/cases/seed/load").json()
    assert out["run"] is None and out["workspace"]["run_status"] == "staged"
    assert out["workspace"]["open_invoice_total_cents"] == 100_343_000
    rr = client.post("/api/v1/workspace/run").json()
    assert rr["workspace"]["run_status"] == "executed"
    # v32: the Policy step reports the same held total as the top bar and
    # the brief (5), with the maker-checker share broken out, and the
    # Matching payload carries the rust kernel telemetry block
    agents = {a["agent"]: a for a in client.get(
        f"/api/v1/runs/{rr['run']['run_id']}/agents").json()["agents"]}
    pol = agents["Policy Agent"]["evidence"]
    assert pol["held_for_approval"] == 5
    assert pol["held_breakdown"] == {"maker_checker_cap": 2, "other_proposed": 3}
    mat = agents["Matching Agent"]["evidence"]
    assert "rust_kernel" in mat and mat["rust_kernel"]["bridge"] == "rust_bridge.py"


def test_v57_explanation_diet_contract():
    """v57: production screens keep only explanations that change a
    decision, explain a derived number, disclose a limitation or show
    decision evidence. Tour and hiring surfaces are gone: no How panels,
    no component guides, no JD banners or lens, no Next Step footers.
    Info icons survive only on metric, model, decision and evidence
    keys - never on ordinary nouns like payment, invoice or amount."""
    html = client.get("/").text
    for token in ('class="how"', 'class="howbtn"', 'class="guide"',
                  'class="gcol"', 'class="gbody"', "What it is",
                  'class="jdnote"', 'class="nextstep"', 'id="lens-btn"',
                  "JD LINK", "How this works",
                  "Built against the Agent Product Builder JD"):
        assert token not in html, token
    js = ""
    for f in ("state.js", "operate.js", "insight.js", "assist.js"):
        js += client.get(f"/js/{f}").text
    combined = html + js
    # kept: decision and metric explanations still resolve in the UI
    for key in ("conf", "resid", "decision", "rung", "winprob", "exprec",
                "p10", "p50", "p90", "parsefld", "milpacc", "mae", "auc"):
        assert f'data-info="{key}"' in combined, key
    # removed: noun and JD explanations never come back
    for key in ("payid", "invid", "cust", "amt", "gross", "disc",
                "jdreq", "jdsee", "masc", "impact", "savesess"):
        assert f'data-info="{key}"' not in combined, key
    # the dictionary itself is pruned, and the four dashboard SPECS
    # (including the SAP and solver cards) all survive
    operate = client.get("/js/operate.js").text
    for key in ("touch", "mode", "sap", "solver"):
        assert f"\n  {key}:[" in operate, key
    assert "Solver Engine - HiGHS MILP" in operate
    for key in ("payid", "jdreq", "masc", "agents", "cube"):
        assert f"\n  {key}:[" not in operate, key
