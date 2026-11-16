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
    no composite step pages, no stepper, no next-step tour bar.
    Stage 4 note: the flip moved the vanilla app to /vanilla/ (React is
    the root now), so this and the other vanilla contracts below fetch
    the vanilla surface at its new path; assertions are unchanged."""
    import re
    html = client.get("/vanilla/").text
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
    html = client.get("/vanilla/").text
    assert 'id="loadbar"' in html and 'class="boot"' in html
    assert "<small>Loading" not in html
    js = client.get("/vanilla/js/state.js").text
    for token in ["slate-brief", "Escape", "jumpToApprovals", "LOADED_GEN",
                  "busyBtn", "bumpGen", "row-highlight-flash"]:
        assert token in js, token
    assist = client.get("/vanilla/js/assist.js").text
    assert "document staged for SAP" in assist and "Parked in suspense" in assist
    css = client.get("/vanilla/css/livecube.css").text
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


def test_sections_live_inside_main():
    # Regression (fix pack, 13 Nov 2026): two stray </div> closers at the
    # end of the Policy Studio section closed <main> and its wrapper div
    # in the browser's tree construction, so every section from
    # Evaluations onward was re-parented outside <main>. go() toggles
    # only "main section" elements, so Methodology, Architecture and
    # Product Thinking could never display. The sibling test above cannot
    # see this class: the sections stay siblings of each other, just
    # under the wrong parent. Assert the parsed ancestor chain of every
    # section includes <main>.
    from html.parser import HTMLParser
    VOID = {"meta", "link", "br", "hr", "img", "input", "source", "wbr",
            "col", "area", "base", "embed", "track", "param"}

    class P(HTMLParser):
        def __init__(self):
            super().__init__()
            self.stack = []
            self.inside = {}

        def handle_starttag(self, tag, attrs):
            if tag in VOID:
                return
            if tag == "section":
                self.inside[dict(attrs).get("id")] = "main" in self.stack
            self.stack.append(tag)

        def handle_startendtag(self, tag, attrs):
            if tag == "section":
                self.inside[dict(attrs).get("id")] = "main" in self.stack

        def handle_endtag(self, tag):
            if tag in VOID or tag not in self.stack:
                return
            while self.stack and self.stack[-1] != tag:
                self.stack.pop()
            self.stack.pop()

    p = P()
    p.feed(client.get("/vanilla/").text)
    expected = ["dash", "cases", "upload", "run", "sap", "mail", "ledger",
                "forecast", "policy", "eval", "health", "method", "arch",
                "product"]
    assert sorted(p.inside) == sorted(expected), sorted(p.inside)
    outside = [sid for sid, ok in p.inside.items() if not ok]
    assert outside == [], f"sections parsed outside <main>: {outside}"


def test_v31_staged_lifecycle_contract():
    """v31: loading stages, execution is explicit and visible. The shell
    carries the readiness/gate helpers, the persistent agent strip with
    per-agent counts, the live-proof mutation, the quota-safe AI framing,
    and the current cache-bust stamps (v58 since the palette pass)."""
    html = client.get("/vanilla/").text
    assert 'css/livecube.css?v=58' in html and 'js/state.js?v=58' in html
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


def test_v58_palette_and_motion_tokens_contract():
    """v58: beUI motion tokens live in the stylesheet as one easing family,
    and the command palette is the upgraded build - fuzzy ranked matching
    with matched-character highlighting, the full action set (export, save,
    restore, access key, docs, reset), and Home/End cursor keys - not the
    old substring filter over views plus three actions."""
    html = client.get("/vanilla/").text
    assert 'css/livecube.css?v=58' in html and 'js/assist.js?v=58' in html
    css = client.get("/vanilla/css/livecube.css").text
    assert "--ease-out:cubic-bezier(0.16, 1, 0.3, 1)" in css
    assert "--ease-drawer:cubic-bezier(0.32, 0.72, 0, 1)" in css
    assert "@keyframes cmdkIn" in css and "prefers-reduced-motion" in css
    assist = client.get("/vanilla/js/assist.js").text
    assert "function cmdkFuzzy" in assist and "function cmdkHi" in assist
    for label in ("Export audit and SAP bundle (PDF)", "Export matches as CSV",
                  "Save this session", "Restore a saved session",
                  "Set the workspace access key", "Open the product documents",
                  "Reset workspace to empty"):
        assert label in assist, label
    assert 'e.key==="Home"' in assist and 'e.key==="End"' in assist


def test_v58_run_visualisation_contract():
    """v58 run page: every run draws its own outcome path and per-payment
    explanation share from the stored results - the cumulative chart in
    the run summary (live and stored paths), the segmented outcome bar in
    each match row, and the measured-time footer on the agent strip."""
    operate = client.get("/js/operate.js").text
    assert "function runClassify" in operate
    assert "function outcomeBarHtml" in operate and "function runChartHtml" in operate
    assert operate.count("runChartHtml(") >= 3  # helper + live + stored summaries
    assert operate.count("outcomeBarHtml(") >= 3  # helper + both match tables
    assert "pipefoot" in operate and "MS MEASURED ACROSS THE PIPELINE" in operate
    css = client.get("/css/livecube.css").text
    assert ".outbar" in css and ".runchart" in css and ".pipefoot" in css


def test_v58_thinking_orbs_contract():
    """v58 agent states: the thinking-orbs engine is vendored (MIT) and
    bridged in vanilla JS - the module loads the engine, exposes orbSync,
    and the three working moments carry an orb canvas: Matching while a
    run streams (solving), the Copilot while it answers (listening), and
    the remittance parse while it reads (searching)."""
    html = client.get("/vanilla/").text
    assert 'js/orbs.js?v=58' in html and 'type="module"' in html
    bridge = client.get("/vanilla/js/orbs.js").text
    assert "orbs-engine.js" in bridge and "orbSync" in bridge
    # density rule: the bridge always draws the engine's large (64) preset
    # and scales down, so the dot field never thins out at display size
    assert "RENDER = 64" in bridge and "resolvePreset(state, RENDER)" in bridge
    engine = client.get("/vanilla/js/vendor/orbs-engine.js")
    assert engine.status_code == 200 and "MODE_FRAMES" in engine.text
    operate = client.get("/vanilla/js/operate.js").text
    assert '["solving","Solving"]' in operate  # Matching's orb, via AGENT_ORBS
    # the live agent strip puts each running agent's orb at the right of
    # its card header, with a state matched to that agent's work
    assert "AGENT_ORBS" in operate and 'class="anode-top"' in operate
    assist = client.get("/vanilla/js/assist.js").text
    assert 'data-orb="listening"' in assist and 'data-orb="searching"' in assist
    # the pending states use the reference composition: orb + state word
    # inside one pill, styled on platform tokens
    assert assist.count('class="orbpill"') >= 2
    assert "orbpend" in assist  # the pending pill sits on the panel ground, no bubble
    css = client.get("/vanilla/css/livecube.css").text
    assert ".orbpill" in css and "border-radius:999px" in css
    # finish pass: luminous orbs, gradient fills, elevated palette
    assert "drop-shadow" in css and "linearGradient" in operate
    assert ".anode-top" in css and "justify-content:space-between" in css
    assert "backdrop-filter:blur(6px)" in css


def test_v58_approval_and_upload_states_contract():
    """v58 states: approval rows carry their kind and decision lifecycle
    (held vs refusal accent, deciding dim, decided flash, restored on
    error), and a file import shows a queue row with a reading orb and a
    busy dropzone from the moment the file is routed until it settles."""
    assist = client.get("/js/assist.js").text
    assert 'class="appr-row ${refusal?"refusal":"held"}' in assist
    assert 'classList.add("deciding")' in assist and "decided-ok" in assist
    operate = client.get("/js/operate.js").text
    assert 'class="upq"' in operate and 'dropEl.classList.add("busy")' in operate
    assert 'Import failed' in operate
    css = client.get("/css/livecube.css").text
    assert ".appr-row" in css and ".upq" in css and ".drop.busy" in css


# ---- Stage 3 (React operate core) contracts ----
# The Stage 3 views live in web/src; these contracts pin the wiring
# that parity depends on: the shell registers the six views with
# their vanilla nav numbers, every view talks to the same endpoints
# with the same payloads as the vanilla frontend, run execution uses
# the SSE stream, and no em dash ships in the new sources.

def _web_src(rel):
    p = os.path.join(os.path.dirname(__file__), "..", "..", "web", "src", *rel.split("/"))
    with open(p, encoding="utf-8") as f:
        return f.read()


def test_stage3_shell_registers_operate_views():
    app = _web_src("App.tsx")
    for num, label in (("02", "Use Cases"), ("03", "Upload Center"),
                       ("04", "Run Reconciliation"), ("05", "SAP BAPI & EBRR"),
                       ("08", "Outbound Mail Hub")):
        assert f'num: "{num}"' in app and label in app, (num, label)


def test_stage3_run_execution_contract():
    run = _web_src("views/Run.tsx")
    assert '"/api/v1/runs/stream"' in run and "use_workspace: true" in run
    assert '"/api/v1/batches"' in run and "idempotency_key" in run
    assert "authHeaders()" in run  # the stream fetch carries the session contract
    for etype in ("batch_start", "payment_start", "resolved", "solved",
                  "deduction", "decision", "batch_done"):
        assert f'"{etype}"' in run, etype


def test_stage3_approvals_decision_contract():
    appr = _web_src("views/Approvals.tsx")
    assert "/api/v1/matches/" in appr and "/decision" in appr
    assert '"approve"' in appr and '"reject"' in appr
    # refusals are never bulk-decided: selection exists only on solved rows
    assert "refusal" in appr and "selected" in appr


def test_stage3_upload_endpoints_contract():
    up = _web_src("views/Upload.tsx")
    for path in ("/api/v1/invoices/import", "/api/v1/payments/import",
                 "/api/v1/import/file", "/api/v1/parse",
                 "/api/v1/workspace/stage-payment",
                 "/api/v1/invoices/seed-referenced"):
        assert path in up, path


def test_stage3_sap_and_mail_endpoints_contract():
    sap = _web_src("views/Sap.tsx")
    assert "/api/v1/erp/run-documents" in sap
    mail = _web_src("views/Mail.tsx")
    assert "/api/v1/mail/hub" in mail and "/api/v1/mail/reminder" in mail
    lib = _web_src("lib/operate.ts")
    assert '"/api/v1/mail/send"' in lib
    for kind in ("dispute_claim", "chase", "settlement_confirmation",
                 "collection_reminder"):
        assert kind in lib, kind


def test_stage3_cases_endpoints_contract():
    cases = _web_src("views/Cases.tsx")
    assert "/api/v1/scenarios" in cases
    assert "/load" in cases and "/api/v1/workspace/load-custom" in cases


def test_stage3_sources_have_no_em_dashes():
    for rel in ("App.tsx", "lib/operate.ts", "ui/SlideOver.tsx",
                "ui/Stage3.tsx", "views/Run.tsx", "views/Approvals.tsx",
                "views/Upload.tsx", "views/Sap.tsx", "views/Cases.tsx",
                "views/Mail.tsx", "views/MatchDetail.tsx", "views/Desk.tsx"):
        assert "\u2014" not in _web_src(rel), rel


# ---- Stage 4 (React chrome + the default flip) contracts ----
# The Stage 4 surfaces live in web/src/ui + views/Policy.tsx; the
# flip lives in frontend/ (root entry + vanilla/). These contracts
# pin: the shell mounts the chrome, the palette keeps exactly two
# groups, policy money is dollars at the surface and exact cents
# on the wire, the access-key copy follows the true auth state,
# the React views link to vanilla at /vanilla/, and the flipped
# frontend tree keeps both entries intact.

def _frontend(rel):
    p = os.path.join(os.path.dirname(__file__), "..", "..", "frontend", *rel.split("/"))
    with open(p, encoding="utf-8") as f:
        return f.read()


def test_stage4_shell_mounts_chrome_and_policy():
    app = _web_src("App.tsx")
    for comp in ("Casebar", "Palette", "Copilot", "DocsDrawer", "KeyModal"):
        assert comp in app, comp
    assert '"09"' in app and '"Policy Studio"' in app
    assert "slate:ws-refresh" in _web_src("lib/chrome.ts")


def test_stage4_casebar_full_ids_and_verdict_only_brief():
    # Stage 6 supersedes the Stage 4 half of this contract (Harsha's
    # Item 2): the verdict-only strip inside the casebar is gone -
    # vanilla's casebar carries no verdict - and the full brief is
    # its own panel (ui/CaseBrief.tsx) directly under the strip,
    # with the mini tiles, the shutter toggle and the slate-brief
    # persistence. The Stage 4 run-id rule below is unchanged.
    bar = _web_src("ui/Casebar.tsx")
    # the run id is never sliced in the React casebar
    assert "run_id" in bar and ".slice(0, 13)" not in bar
    # the verdict no longer lives in the casebar (no duplication:
    # the brief panel below it carries the verdict in both modes)
    assert 'aria-label="Case brief"' not in bar
    for tile in ("AUTO-POSTED CASH", "EXPECTED BACK FROM DISPUTES"):
        assert tile not in bar, tile
    brief = _web_src("ui/CaseBrief.tsx")
    assert 'aria-label="Case brief"' in brief
    assert "Full brief" in brief and "Minimize" in brief
    assert '"slate-brief"' in brief or "'slate-brief'" in brief or "slate-brief" in brief
    for tile in ("Auto-posted cash", "Expected back from disputes", "Held for a person"):
        assert tile in brief, tile
    assert "Staged portfolio readiness" in brief
    assert "Not run yet - run this case from Run Reconciliation" in brief
    lib = _web_src("lib/brief.ts")
    assert "posted themselves" in lib and "waiting for a person" in lib


def test_stage6_vanilla_fidelity_restoration():
    # Item 1: every view that reads workspace/run state reloads on
    # slate:ws-refresh (vanilla blanks and re-reads on load; React
    # views otherwise kept the previous case's figures standing).
    chrome = _web_src("lib/chrome.ts")
    assert "useWsRefresh" in chrome and "slate:ws-refresh" in chrome
    for view in ("Dashboard", "Sap", "Ledger", "Forecast", "Mail",
                 "Policy", "Eval", "Health", "Upload"):
        assert "useWsRefresh" in _web_src(f"views/{view}.tsx"), view
    # Item 1: the Dashboard gate is vanilla's stagedGateHtml via the
    # shared component; the invented Stage 1-5 gate copy is gone.
    dash = _web_src("views/Dashboard.tsx")
    assert "StagedGate" in dash
    assert "Case staged, waiting to run" not in dash
    assert "The run settles them against the live ledger" not in dash
    # Item 1: bootAuto restored in the casebar (stage the demo on a
    # first visit to an empty workspace; respect a deliberate reset).
    bar = _web_src("ui/Casebar.tsx")
    assert "/api/v1/cases/seed/load" in bar and "slate-empty" in bar
    # Item 5: the tenant selector and session chip live in the
    # sidebar workspace block, not the casebar.
    assert "/api/v1/tenants/demo" not in bar
    wb = _web_src("ui/WorkspaceBlock.tsx")
    assert "/api/v1/tenants/demo" in wb and "SESSION " in wb
    # Item 7c: vanilla's nav group labels on the sidebar nav, and
    # the shell order is casebar, brief, run-diff (vanilla's DOM).
    app = _web_src("App.tsx")
    for grp in ("OPERATE", "INSIGHT & GOVERNANCE", "EVALS & ARCHITECTURE"):
        assert grp in app, grp
    assert app.index("<Casebar") < app.index("<CaseBrief") < app.index("{diffOpen && <RunDiff")
    # Item 4: vanilla's exact palette is back; the Stage 5B/5C
    # lifted tones are gone from the theme.
    css = _web_src("index.css")
    for token in ("--color-blue: #3d75e8", "--color-mut: #a7a49d",
                  "--color-mut2: #7e7c77", "--color-ok: #34bf71",
                  "--color-bad: #e5484d"):
        assert token in css, token
    for lifted in ("#3570e0", "#c4c1ba", "#c2c0ba", "#5eeaa0", "#ff9ea0"):
        assert lifted not in css, lifted
    # Item 6: the Draft reminder takes the measured white .mini-btn
    # face in Forecast.
    assert ".mini-btn" in css and "#efefef" in css
    assert 'className="mini-btn"' in _web_src("views/Forecast.tsx")
    # Item 7: "Stage Case (Inspect Before Run)" lands on the
    # Dashboard, as vanilla's loadCase does.
    assert 'goView("dash")' in _web_src("views/Cases.tsx")


def test_stage4_palette_two_groups():
    pal = _web_src("ui/Palette.tsx")
    assert '"Go to"' in pal and '"Actions"' in pal
    assert "cmdkFuzzy" in _web_src("lib/chrome.ts")


def test_stage4_policy_groups_and_money():
    pol = _web_src("views/Policy.tsx")
    for group in ("Posting", "Disputes", "Governance"):
        assert group in pol, group
    # cents fields display in dollars, the wire body stays exact cents
    assert "Tolerance write-off ($)" in pol and "centsToDisplay" in pol
    assert "Math.round(n * 100)" in pol
    assert "/api/v1/policy/preview" in pol and '"/api/v1/policy"' in pol
    # the spec sentence survives verbatim (JSX line wraps normalised)
    assert "Changing this value changes the next run's behaviour; the run records the policy it used." in " ".join(pol.split())


def test_stage4_access_key_copy_follows_auth_state():
    km = _web_src("ui/KeyModal.tsx")
    assert "This deployment is open - no API key is in force" in km
    assert "This deployment is locked with API keys" in km
    assert "/health" in km and "dev-open" not in km or "api-key" in km


def test_stage4_sessions_and_copilot_endpoints():
    sess = _web_src("ui/SessionsPanel.tsx")
    for path in ("/api/v1/session/save", "/api/v1/session/restore", "/api/v1/session/saves"):
        assert path in sess, path
    cop = _web_src("ui/Copilot.tsx")
    assert "/api/v1/copilot" in cop


def test_stage4_vanilla_links_point_at_vanilla_path():
    for rel in ("ui/ViewHead.tsx", "views/Dashboard.tsx"):
        src = _web_src(rel)
        assert 'href="/vanilla/"' in src, rel
        assert 'href="/"' not in src, rel


def test_stage4_flip_files():
    root = _frontend("index.html")
    assert "/react/assets/" in root
    assert "SlateMatch - Autonomous Cash Application Agent" in root
    assert "livecube.css" not in root
    van = _frontend("vanilla/index.html")
    assert "livecube.css" in van and "js/state.js" in van
    assert "slatematch_session_id" in _frontend("vanilla/js/state.js")


def test_stage4_sources_have_no_em_dashes():
    for rel in ("lib/chrome.ts", "ui/Casebar.tsx", "ui/Copilot.tsx",
                "ui/Palette.tsx", "ui/KeyModal.tsx", "ui/DocsDrawer.tsx",
                "ui/SessionsPanel.tsx", "ui/Markdown.tsx", "views/Policy.tsx"):
        assert "\u2014" not in _web_src(rel), rel
