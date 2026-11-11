/* state.js - shared helpers, the API client, navigation, and the one
   shared workspace (case bar, case brief) every view reads from.
   Loaded first; the other modules build on these globals. */
const $=id=>document.getElementById(id);
const money=c=>{c=c||0; const v=(Math.abs(c)/100).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}); return c<0?"-$"+v:"$"+v};
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function sessionId(){let s=sessionStorage.getItem("slatematch_session_id");if(!s){s=(crypto.randomUUID?crypto.randomUUID():"xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,c=>{const r=Math.random()*16|0,v=c==="x"?r:(r&0x3|0x8);return v.toString(16)}));sessionStorage.setItem("slatematch_session_id",s);}return s}
function apiKey(){try{return localStorage.getItem("slate-key")||""}catch(e){return ""}}
function authHeaders(){const tn=localStorage.getItem("slate-tenant")||"";const k=apiKey();return {"Content-Type":"application/json","X-Workspace-Session":sessionId(),...(tn?{"X-Tenant-Id":tn}:{}),...(k?{"X-API-Key":k}:{})}}
let __apiN=0;
async function api(path,opts={}){__apiN++;const lb=$("loadbar");if(lb)lb.classList.add("on");try{let r=await fetch(path,{headers:authHeaders(),...opts});if(r.status===401){const got=await ensureApiKey();if(got)r=await fetch(path,{headers:authHeaders(),...opts})}if(!r.ok){throw new Error((await r.text()).slice(0,300))}return r.json()}finally{__apiN--;if(__apiN<=0){__apiN=0;const lb2=$("loadbar");if(lb2)setTimeout(()=>lb2.classList.remove("on"),250)}}}
function bumpGen(){WS_GEN++}
function busyBtn(btn,label){if(!btn)return()=>{};const old=btn.innerHTML;btn.disabled=true;btn.innerHTML=`<span class="spin"></span>${label}`;return()=>{btn.disabled=false;btn.innerHTML=old}}
function flashEl(el){if(!el)return;el.scrollIntoView({behavior:"smooth",block:"center"});el.classList.remove("row-highlight-flash");void el.offsetWidth;el.classList.add("row-highlight-flash");setTimeout(()=>el.classList.remove("row-highlight-flash"),2100)}
function jumpToApprovals(){ if(WS&&WS.run_status==="staged"){ go("run"); setTimeout(()=>{ const b=$("live-btn"); if(b) flashEl(b); },520); return } go("run");let n=0,last="",stable=0;const t=setInterval(()=>{const out=$("appr-out");if(!out){if(++n>44)clearInterval(t);return}const html=out.innerHTML;if(html===last)stable++;else{stable=0;last=html}const r=[...out.querySelectorAll("tr")].find(x=>x.querySelector("button"));if(r&&stable>=2){clearInterval(t);flashEl(r)}else if(++n>44)clearInterval(t)},160)}
function toggleActsMenu(ev){ ev.stopPropagation(); const m=$("acts-menu"); const open=m.classList.toggle("open");
  if(open){ const close=(e)=>{ if(!m.contains(e.target)){ m.classList.remove("open"); document.removeEventListener("click",close); } }; setTimeout(()=>document.addEventListener("click",close),0); } }
async function downloadExport(path,fname){
  try{ const r=await fetch(path,{headers:authHeaders()});
    if(!r.ok) throw new Error("Export failed ("+r.status+") - run a case first, then export");
    const b=await r.blob(); const u=URL.createObjectURL(b); const a=document.createElement("a");
    a.href=u; a.download=fname; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(u),4000);
    toast("Downloaded "+fname);
  }catch(e){ toast(e.message) }
}
function toast(m){const t=$("toast");t.textContent=m;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),3400)}
/* Production access: when the deployment is locked with API keys, the
   server answers 401 and the UI asks for the workspace key once, then
   retries. The key lives only in this browser (localStorage); the server
   keeps just a hash of every key it issues. Parallel 401s share one
   prompt through KEY_WAITERS. The bootstrap key never belongs here - it
   only mints workspace keys through the admin endpoints. */
let KEY_WAITERS=null;
function refreshKeyBtn(){const b=$("key-btn");if(b)b.textContent=apiKey()?"ACCESS KEY: SET":"ACCESS KEY"}
function openKeyModal(cb){
  const m=$("keymodal"); if(!m){ if(cb)cb(!!apiKey()); return }
  if(cb){ (KEY_WAITERS=KEY_WAITERS||[]).push(cb) }
  const inp=$("key-input"); if(inp) inp.value=apiKey();
  const rm=$("key-remove"); if(rm) rm.style.display=apiKey()?"":"none";
  m.classList.add("open"); if(inp){ inp.focus(); inp.select() }
}
function closeKeyModal(saved){
  const m=$("keymodal"); if(m)m.classList.remove("open");
  const w=KEY_WAITERS; KEY_WAITERS=null; if(w) w.forEach(f=>f(saved));
}
function ensureApiKey(){ return new Promise(res=>{ openKeyModal(res) }) }
function saveApiKey(){
  const inp=$("key-input"); const v=(inp?inp.value:"").trim();
  if(!v){ toast("Paste the API key first"); return }
  try{localStorage.setItem("slate-key",v)}catch(e){}
  refreshKeyBtn(); closeKeyModal(true); toast("Access key saved - this browser will use it for every request");
}
function removeApiKey(){
  try{localStorage.removeItem("slate-key")}catch(e){}
  refreshKeyBtn(); closeKeyModal(false); toast("Access key removed from this browser");
}
refreshKeyBtn();
/* v23 tour: the six steps are the product. Older view names stay as
   aliases so every existing link, chip and command keeps working. */
const VIEW_ALIAS={gov:"run"};
const VIEW_ANCHOR={};
const LOADED_GEN={};
const REF_VIEWS=["eval","health","method","arch","product"];
function go(s){s=VIEW_ALIAS[s]||s;CURVIEW=s;applyBriefMode();document.querySelectorAll("nav button").forEach(x=>x.classList.toggle("active",x.dataset.s===s));document.querySelectorAll("main section").forEach(x=>x.classList.toggle("active",x.id===s));const ab=document.querySelector(".navrow button.active");if(ab)ab.scrollIntoView({inline:"center",block:"nearest",behavior:"smooth"});window.scrollTo({top:0});refreshWorkspace();const gen=WS_GEN;if(LOADERS[s]&&LOADED_GEN[s]!==gen){const p=LOADERS[s]();const done=()=>{LOADED_GEN[s]=gen;fillInfo();initReveal()};if(p&&p.then)p.then(done);else done()}}
document.querySelectorAll("nav button").forEach(b=>b.onclick=()=>go(b.dataset.s));
document.addEventListener("click",()=>setTimeout(()=>{fillInfo();initReveal()},60));
function toggleHow(s){$("how-"+s).classList.toggle("open")}
function pill(txt,kind){return `<span class="pill ${kind}">${esc(txt)}</span>`}
function statusPill(st){return st==="OPTIMAL_EXACT_MATCH"?pill(st,"ok"):st==="PARTIAL_MATCH"?pill(st,"warn"):pill(st,"bad")}
let lastRun=null,seedPayments=null,lastMatches=null;

/* ---------- One shared workspace: the case bar and everything that reads it ---------- */
let WS=null, casePayments=[];
let WS_GEN=0; // bumped by every explicit case load/reset/tenant switch
async function refreshWorkspace(){ const g=WS_GEN; try{ const d=await api("/api/v1/workspace");
  // A refresh that was in flight across a case switch still carries the
  // OLD case - dropping it stops the case bar and brief flip-flopping
  // back to the previous case for a few seconds after a switch.
  if(g!==WS_GEN) return WS;
  // A workspace response generated before the latest run existed (its
  // request was in flight while a batch completed) must not regress the
  // shared state - it would blank the case bar, the brief and the KPIs
  // until the next refresh. Only same-case or pre-case snapshots are
  // guarded; explicit loads and resets assign WS directly, not via here.
  if(WS&&WS.latest_run&&!d.latest_run&&(!d.case||(WS.case&&d.case.id===WS.case.id))) return WS;
  WS=d; renderCasebar(); return WS }catch(e){ return null } }
function renderCasebar(){
  if(!WS) return; const c=WS.case;
  $("cb-case").innerHTML=c?`${esc(c.name)} <small>- ${esc(c.source||"")} - loaded ${esc((c.loaded_at||"").slice(0,16).replace("T"," "))} UTC</small>`:"No case loaded <small>- load the demo, a use case, the builder, or your own files</small>";
  $("cb-inv").textContent=WS.open_invoices;
  $("cb-pay").textContent=`${WS.staged_payments} staged`;
  $("cb-run").innerHTML=WS.latest_run?`${esc(String(WS.latest_run.run_id).slice(0,13))}... <small>${esc(WS.latest_run.status)}</small>`:WS.case?"Pending":"-";
  $("cb-appr").textContent=WS.run_status==="staged"?"0 held":String(WS.approvals_pending);
  { const sk=$("r-susp-k"); if(sk) sk.textContent=WS.run_status==="staged"?"Staged wire volume (ready)":"Unapplied cash in suspense"; }
  const eb=$("export-btn"); if(eb){ const has=!!WS.latest_run; eb.disabled=!has; eb.title=has?"Download the month-end bundle as a clean PDF: the latest run, its matches and exceptions, the SAP posting documents, and the fingerprinted audit trail":"Nothing to export yet - this workspace has no run"; }
  const sb=$("sb-case"); if(sb) sb.textContent="CASE "+(c?String(c.name).toUpperCase():"NONE");
  const sw=$("cb-switch"); if(sw&&c&&[...sw.options].some(o=>o.value===c.id)) sw.value=c.id;
  renderStaged(); renderUpStaged(); renderCaseBrief(); showHandoff(); if(window.renderLedgerStaged)renderLedgerStaged();
}
let CASELIST=null;
async function ensureCaseList(){
  if(CASELIST) return CASELIST;
  try{ const sc=await api("/api/v1/scenarios");
    CASELIST=[{id:"seed",title:"Demo case - one realistic day of receipts"},...sc.map(x=>({id:x.id,title:x.title,story:x.story,shows:x.shows}))];
    const sw=$("cb-switch");
    if(sw){ sw.innerHTML=`<option value="">Switch case...</option>`+CASELIST.map(x=>`<option value="${esc(x.id)}">${esc(x.title)}</option>`).join("")+`<option value="__builder">Custom Case Builder (Use Cases page)</option><option value="__upload">Upload my own files</option>`;
      if(WS&&WS.case&&[...sw.options].some(o=>o.value===WS.case.id)) sw.value=WS.case.id; }
  }catch(e){ CASELIST=[] }
  return CASELIST;
}
function switchCase(sel){
  const v=sel.value; if(!v) return;
  if(v==="__builder"){ go("cases"); setTimeout(()=>{const p=[...document.querySelectorAll("#cases .panel")].find(x=>x.innerText.includes("Custom Case Builder")); if(p)p.scrollIntoView({behavior:"smooth"})},450); }
  else if(v==="__upload"){ go("upload"); }
  else loadCase(v);
}
let RUN_FILTER=null;
function gotoLedgerInvoices(){
  go("ledger");
  setTimeout(()=>{ const t=$("ledger-t"); const p=t?t.closest(".panel"):null; if(p){ p.scrollIntoView({behavior:"smooth",block:"start"}); p.classList.remove("flash"); void p.offsetWidth; p.classList.add("flash"); } },480);
}
function gotoLedgerStaged(){
  go("ledger");
  setTimeout(()=>{ const p=$("ledger-staged-panel"); if(p){ p.scrollIntoView({behavior:"smooth",block:"start"}); p.classList.remove("flash"); void p.offsetWidth; p.classList.add("flash"); } },480);
}
function openRunExceptions(){
  RUN_FILTER="exceptions";
  if(WS&&WS.latest_run){ openRun(WS.latest_run.run_id) }
  else { go("run"); toast("No run yet - load a case and its exceptions appear here") }
}
function clearRunFilter(){ RUN_FILTER=null; if(WS&&WS.latest_run) openRun(WS.latest_run.run_id); }
function goMailDisputes(){
  if(window.goMailFor) goMailFor("disputes",null); else { if(window.setHubCat) setHubCat("disputes"); go("mail"); }
}
function openApprovals(){ go("run"); }
let BRIEF_RUN=null, BRIEF_SEQ=0, BRIEF_PROMISE=null;
/* Shutter brief: the Dashboard shows the full brief; every other view
   shows a minimized strip (verdict + the three outcome boxes) with a
   toggle that drops the full brief down when wanted. Switching views
   resets to that view's default. */
let CURVIEW="dash", BRIEF_OPEN=null;
function briefEffectiveOpen(){ try{const bp=sessionStorage.getItem("slate-brief"); if(bp!==null) return bp==="1"}catch(e){} return BRIEF_OPEN===null ? CURVIEW==="dash" : BRIEF_OPEN }
function applyBriefMode(){
  const full=$("brief-full"), mini=$("brief-mini"), t=$("brief-toggle"), p=$("brief-panel");
  if(!full||!mini||!t) return;
  const open=briefEffectiveOpen();
  full.style.display=open?"":"none"; mini.style.display=open?"none":"";
  t.textContent=open?"Minimize ▴":"Full brief ▾";
  if(p) p.classList.toggle("mini", !open);
}
function toggleBrief(){ BRIEF_OPEN=!briefEffectiveOpen(); try{sessionStorage.setItem("slate-brief",BRIEF_OPEN?"1":"0")}catch(e){} applyBriefMode(); }
function fillBriefMini(){
  const m=$("brief-mini"); if(!m||!WS) return;
  const lr=WS.latest_run;
  if(!lr){ m.innerHTML=`<div class="briefmini"><span class="bm-verdict">Not run yet - run this case from Run Reconciliation and the outcome appears here.</span></div>`; return }
  const d=(BRIEF_RUN&&BRIEF_RUN.run_id===lr.run_id)?BRIEF_RUN.data:null;
  if(!d){ m.innerHTML=`<div class="briefmini"><span class="bm-verdict">Counting this run's outcomes...</span></div>`; return }
  m.innerHTML=`<div class="briefmini"><span class="bm-verdict"><b>${esc(d.verdictShort)}</b></span><span class="btile"><span class="bk">Auto-posted cash</span><span class="bv">${money(d.cash)}</span></span><span class="btile btilelink" onclick="goMailDisputes()" title="Open these dispute claims in the Outbound Mail Hub"><span class="bk">Expected back from disputes</span><span class="bv">$${d.rec.toLocaleString("en-US",{maximumFractionDigits:0})}</span></span><span class="btile"><span class="bk">Held for a person</span><span class="bv">${d.held} - ${money(d.heldAmt)}</span></span></div>`;
}
async function briefOutcome(runId){
  if(BRIEF_RUN&&BRIEF_RUN.run_id===runId) return BRIEF_RUN.html;
  if(!BRIEF_PROMISE||BRIEF_PROMISE.run_id!==runId){
    BRIEF_PROMISE={run_id:runId, promise:(async()=>{
      // Case-wide outcome: merge the matches of EVERY run in this
      // workspace, one entry per payment, most recent decision wins -
      // so a small extra run (one staged wire) adds to the case totals
      // instead of replacing them.
      const runs=await api("/api/v1/runs");
      const target=runs.find(r=>r.run_id===runId);
      if(target&&target.status&&target.status!=="COMPLETED"){
        // A run still executing has only some of its matches written.
        // An outcome computed now would present a partial run as the
        // case result - and it would be cached as this run's brief.
        // Show the wait state and cache nothing.
        BRIEF_PROMISE=null;
        return `<div class="d">This run is still executing - the case outcome lands here when it completes.</div>`;
      }
      const byPay=new Map(), excByPay=new Map();
      // Fetch every run's matches and exceptions in parallel - doing
      // this sequentially cost 20+ round trips and made the brief (and
      // every page waiting on it) look frozen on the small live box.
      const fetched=await Promise.all([...runs].filter(r=>!r.status||r.status==="COMPLETED").reverse().slice(-10).map(async run=>{
        const [ms,xs]=await Promise.all([api(`/api/v1/runs/${run.run_id}/matches`),api(`/api/v1/runs/${run.run_id}/exceptions`)]);
        return {ms,xs};
      }));
      for(const {ms,xs} of fetched){
        for(const m of ms) byPay.set(m.payment_id, m);
        for(const x of xs) excByPay.set(x.payment_id, x);
      }
      let cash=0, held=0, heldAmt=0, rec=0, auto=0;
      for(const m of byPay.values()){ const r=m.result||{}; const eq=(r.derivation||{}).equation||{};
        if(m.status==="AUTO_POSTED"||m.status==="APPROVED_POSTED"){ auto++; cash+=(r.lines||[]).reduce((a,l)=>a+l.net_cents,0); }
        if(m.status==="PROPOSED"){ held++; heldAmt+=eq.payment_cents||0; }
        const d=r.deduction||{}; if(d.autonomous_action==="AUTO_GENERATE_DISPUTE_CLAIM") rec+=Number(d.expected_recovery_value_usd||0); }
      const stopped=[...excByPay.entries()].filter(([pid])=>!byPay.has(pid));
      const KINDLBL={DUPLICATE_PAYMENT:"a duplicate wire",NO_MATCH:"no matching invoices",UNRESOLVED_RESIDUAL:"an unexplained remainder"};
      const stoppedTxt=stopped.length?` ${stopped.length} ${stopped.length===1?"was":"were"} stopped before matching (${stopped.map(([,x])=>KINDLBL[x.kind]||"an exception").join(", ")}).`:"";
      const total=new Set([...byPay.keys(),...excByPay.keys()]).size;
      const verdict=`<p style="margin:0 0 10px;font-size:14.5px;line-height:1.55"><b>${total} payments came in: ${auto} posted themselves, ${held} ${held===1?"is":"are"} waiting for a person's decision.${stoppedTxt}</b></p>`;
      const decided=byPay.size;
      const resLine=total?`<p style="margin:0 0 10px;font-size:13.5px;line-height:1.5">Autonomous resolution: <b>${(decided/total*100).toFixed(1)}%</b> - the agent reached the decision on ${decided} of ${total} wires itself: posted, solved and queued for sign-off, or refused with a reason. Governance signs; it does not research.</p>`:"";
      const html=verdict+resLine+`<div class="cards" style="grid-template-columns:repeat(3,minmax(0,1fr));margin:0">
        <div class="card"><div class="k">Auto-posted cash</div><div class="v">${money(cash)}</div><div class="n">${auto} payments posted with no human touch</div></div>
        <div class="card cardlink" onclick="goMailDisputes()" title="Open these dispute claims in the Outbound Mail Hub"><div class="k">Expected back from disputes</div><div class="v">$${rec.toLocaleString("en-US",{maximumFractionDigits:0})}</div><div class="n">What the agent expects to win back from the claims it has opened</div></div>
        <div class="card"><div class="k">Held for a person</div><div class="v">${held}</div><div class="n">${money(heldAmt)} waiting - decide them from Approvals waiting in the top bar</div></div></div>
        <p style="margin:10px 0 0"><button class="btn small" onclick="go('sap')">View SAP S/4HANA BAPI &amp; EBRR Payloads &#8594;</button> <small>Every cleared payment's balanced DZ clearing journal and the ASC 606 dispute reserve, generated live by erp_sap.py from this case's matches.</small></p>
        <small>Totals for the whole case, across all of its runs - each payment counted once, by its latest decision. Time saved for the analyst: <b>${(auto*12/60).toFixed(1)} hours</b> (${auto} auto-posted payments x 12 minutes each, the stated manual benchmark).</small>`;
      const verdictShort=`${total} payments in: ${auto} posted themselves, ${held} waiting for a person${stopped.length?`, ${stopped.length} stopped before matching`:""}.`;
      BRIEF_RUN={run_id:runId, html, data:{verdictShort, cash, rec, held, heldAmt, auto}};
      return html;
    })()};
  }
  return BRIEF_PROMISE.promise;
}
/* v31: the one execution path every CTA shares - land on Run
   Reconciliation and fire the live solver stream. */
function executeActiveCase(){ go("run"); setTimeout(()=>{ const b=$("live-btn"); if(b) runLive(b); },520); }
function stagedGateHtml(where){
  if(!WS||!WS.case) return "";
  return `<div class="gatecard"><b>Waiting for the reconciliation run.</b><div class="d" style="margin:6px 0 10px">The ${esc(where)} for <b>${esc(WS.case.name)}</b> are generated by the run itself - nothing here is pre-computed. The case is staged: ${WS.open_invoices} open invoices (${money(WS.open_invoice_total_cents||0)}) and ${WS.staged_payments} wires (${money(WS.staged_payment_total_cents||0)}) are waiting.</div><button class="btn" onclick="executeActiveCase()">&#9654; Execute 6-Agent Run Now &#8594;</button></div>`;
}
/* v31: a Gemini quota window is a designed operating mode, never an
   error badge. The raw error stays visible in diagnostics detail. */
function aiQuotaSafe(){ try{ const e=(window.__AI_LAST_ERROR||""); return /429|quota|rate limit/i.test(e) }catch(_){ return false } }
function aiModeLabel(configured,lastErr){
  if(!configured) return "Deterministic Verifier Fallback Active (No AI Key)";
  if(lastErr) return /429|quota|rate limit/i.test(lastErr) ? "Deterministic Verifier Fallback Active (Quota-Safe Mode)" : "Gemini configured - last call failed (see diagnostics)";
  return "Gemini live";
}
const SEED_STORY="A normal day at a mid-size supplier. 16 payments arrive against 19 open invoices from 9 customers. Most are routine. Hidden among them: one payment split across two invoices, one that gives only a PO number, one with a wrong character in the invoice reference, one that takes an early-payment discount and deducts extra for a claimed shortage, one duplicate of an earlier wire, and one from a payer nobody recognises.";
function renderCaseBrief(){
  const el=$("case-brief"); if(!el||!WS) return;
  const c=WS.case;
  if(!c){ el.innerHTML=""; return }
  if(!CASELIST){ ensureCaseList().then(()=>renderCaseBrief()); }
  const meta=(CASELIST||[]).find(x=>x.id===c.id)||{};
  const story=c.story||(c.id==="seed"?SEED_STORY:(meta.story||""));
  const shows=meta.shows||"";
  const lr=WS.latest_run;
  const cached=(lr&&BRIEF_RUN&&BRIEF_RUN.run_id===lr.run_id)?BRIEF_RUN.html:null;
  const outcomeHtml=lr?(cached||`<div class="d">Counting this run's outcomes...</div>`):`<div class="readybox"><div class="k" style="font-family:var(--mono);font-size:9.5px;color:var(--mut);text-transform:uppercase;letter-spacing:.1em">Staged portfolio readiness</div><p style="margin:8px 0 6px"><b>${money(WS.open_invoice_total_cents||0)}</b> across ${WS.open_invoices} open invoices &nbsp;vs&nbsp; <b>${money(WS.staged_payment_total_cents||0)}</b> across ${WS.staged_payments} incoming wires</p><p style="margin:0"><b>Status:</b> ${WS.staged_payments} wires staged &amp; verified - ready for 6-agent MILP reconciliation. Nothing has been solved yet; the outcome appears here after the run.</p></div>`;
  // The shell writes synchronously from the current workspace snapshot -
  // no await stands between reading WS and writing, so no stale async
  // invocation can ever land last. The outcome fills its own container
  // when its fetch resolves, and only if that run is still the latest.
  el.innerHTML=`<div class="panel briefpanel" id="brief-panel" style="margin-bottom:18px"><div class="briefhead"><h3 style="margin:0">Case brief - ${esc(c.name)} <span data-info="impact"></span></h3><button class="btn small ghost" id="brief-toggle" onclick="toggleBrief()"></button></div><div id="brief-mini"></div><div id="brief-full"><div class="grid2">
    <div><div class="k" style="font-family:var(--mono);font-size:9.5px;color:var(--mut);text-transform:uppercase;letter-spacing:.1em">The situation - what came in</div>
    <p style="margin:8px 0">${esc(story||"A working dataset loaded into the shared workspace.")}</p>
    ${shows?`<small><b>What this case tests:</b> ${esc(shows)}</small><br>`:""}
    <small>Open invoices in the ledger: <b>${WS.open_invoices}</b><br>Payments in this case: <b>${WS.staged_payments}</b>${WS.pending_payments.length===0?" - all of them have been run":WS.pending_payments.length===WS.staged_payments?" - all still waiting to run":` - <b>${WS.pending_payments.length}</b> of them still waiting to run`}${lr?`<br>The latest run processed <b>${lr.payments}</b> payments`:""}</small></div>
    <div><div class="k" style="font-family:var(--mono);font-size:9.5px;color:var(--mut);text-transform:uppercase;letter-spacing:.1em">The outcome - what the agent did</div><div id="cb-outcome" style="margin-top:8px">${outcomeHtml}</div>${WS.pending_payments.length?`<p style="margin:10px 0 0"><button class="btn" onclick="runStagedNow(this)">&#9654; Run reconciliation on ${WS.pending_payments.length} staged payment${WS.pending_payments.length===1?"":"s"} &#8594;</button></p>`:""}</div>
    </div></div></div>`;
  fillBriefMini(); applyBriefMode();
  if(lr&&!cached){
    briefOutcome(lr.run_id).then(html=>{ const t=$("cb-outcome"); if(t&&WS&&WS.latest_run&&WS.latest_run.run_id===lr.run_id){ t.innerHTML=html; fillBriefMini(); } }).catch(()=>{});
  }
}
function stagedTable(pays){
  if(!pays.length) return "";
  return `<table class="staged-t"><tr><th>Payment <span data-info="payid"></span></th><th>Payer <span data-info="cust"></span></th><th>Amount <span data-info="amt"></span></th><th>References <span data-info="lines"></span></th><th>Claimed deduction <span data-info="disc"></span></th><th>Deduction reason <span data-info="held"></span></th><th>POD <span data-info="state"></span></th><th>Remittance <span data-info="detail"></span></th></tr>${pays.map(p=>`<tr><td>${esc(p.payment_id)}</td><td>${esc(p.payer_raw)}</td><td>${money(p.amount_cents)}</td><td>${(p.references||[]).map(esc).join(", ")||"<small>none</small>"}</td><td>${p.claimed_deduction_cents?money(p.claimed_deduction_cents):"-"}</td><td>${esc(p.deduction_reason_raw||"-")}</td><td>${p.pod_verified_clean?pill("clean","ok"):pill("not verified","grey")}</td><td><small>${esc(p.remittance_text||"-")}</small></td></tr>`).join("")}</table>`;
}
function renderStaged(){
  const el=$("staged-box"); if(!el||!WS) return;
  const p=WS.pending_payments;
  if(!WS.case && !WS.staged_payments){ el.innerHTML=`<small>No case is loaded. Load the demo case or a use case, build one in Use Cases, or upload files - the staged payments will appear here, ready to run.</small>`; return }
  if(!p.length){ el.innerHTML=`<small>All ${WS.staged_payments} staged payments of this case have been run${WS.latest_run?` - latest run <b>${esc(WS.latest_run.run_id)}</b> is in the history below and on the Dashboard`:""}. Load another case or reset the workspace to run again.</small>`; return }
  el.innerHTML=stagedTable(p)+`<div class="mutbar"><b>Live proof:</b> <button class="btn small ghost" onclick="mutateFirstWire(this)">&#9889; Test Live Mutation: Short-Pay ${esc(p[0].payment_id)} by $500</button> <small>Edits that wire in the real ledger (amount ${money(p[0].amount_cents)} &#8594; ${money(p[0].amount_cents-50000)}), then run the solver and watch its verdict change. Amount and remittance are also editable per wire in the Ledger (06).</small></div><small>${p.length} of ${WS.staged_payments} staged payments are waiting to run.</small>`;
}
function renderUpStaged(){
  const el=$("up-staged"); if(!el||!WS) return;
  const p=WS.pending_payments, settled=WS.staged_payments-p.length;
  if(!WS.staged_payments){ el.innerHTML=`<small>Nothing staged yet. Import payments above and they are staged here, untouched, until you run them from Run Reconciliation.</small>`; return }
  el.innerHTML=(p.length?stagedTable(p):"")+`${p.length?`<p style="margin:10px 0 0"><button class="btn" onclick="go('run')">&#10003; Staged in Workspace - Go to 04 Run Reconciliation to Solve &#8594;</button></p>`:""}<small>${WS.staged_payments} payments staged in the active case${WS.case?` (${esc(WS.case.name)})`:""}: ${p.length} pending, ${settled} already run.</small>`;
}
async function mutateFirstWire(btn){
  const p=(WS&&WS.pending_payments)||[]; if(!p.length){ toast("No staged wire to mutate"); return }
  const w=p[0]; if(w.amount_cents<=50000){ toast("That wire is too small to short-pay by $500"); return }
  const __busy=busyBtn(btn,"Mutating the wire...");
  try{
    await api(`/api/v1/payments/${w.payment_id}`,{method:"PATCH",body:JSON.stringify({amount_cents:w.amount_cents-50000})});
    bumpGen(); await refreshWorkspace();
    toast(`${w.payment_id} short-paid by $500 in the ledger - now run the solver and watch its verdict change`);
    const lb=$("live-btn"); if(lb) flashEl(lb);
  }catch(e){ toast("Mutation failed: "+e.message) }finally{ __busy() }
}
async function loadCase(cid,btn,opts={}){
  const __busy=busyBtn(btn,"Staging the case...");
  WS_GEN++;
  // The new case has no runs yet - clear every run-derived panel NOW,
  // synchronously, so no page can present the previous case's figures
  // as this case's data while the fresh reads are in flight.
  BRIEF_RUN=null; BRIEF_PROMISE=null;
  ["r-stp","r-susp","r-lat","r-settled","r-exc"].forEach(id=>{const el=$(id); if(el)el.innerHTML="-"});
  { const ss=$("r-stp-sub"); if(ss) ss.textContent=""; }
  { const kt=$("k-touch"); if(kt)kt.textContent="-"; const ib=$("impact-body"); if(ib)ib.innerHTML="";
    const g=$("grade-out"); if(g)g.innerHTML="";
    ["run-summary","matches","exceptions","match-detail","dispute-desk","run-brief","live-out","agent-pipe","agent-inspect"].forEach(id=>{const el=$(id); if(el)el.innerHTML=""});
    const ap=$("approvals"); if(ap)ap.innerHTML=""; const ac=$("appr-count"); if(ac)ac.style.display="none"; }
  try{
    sessionStorage.removeItem("slate-empty");
    const d=await api(`/api/v1/cases/${cid}/load`,{method:"POST"});
    WS=d.workspace; casePayments=d.payments; seedPayments=d.payments; lastRun=d.run||null; renderCasebar();
    toast(d.run?`Case loaded and run: ${d.run.auto_posted} of ${d.run.payments} payments auto-posted`:`Case loaded: ${d.workspace.case.name} - ${d.workspace.open_invoices} invoices, ${d.payments.length} payments staged`);
    if(d.workspace.case.policy_note) setTimeout(()=>toast(d.workspace.case.policy_note),600);
    if(!opts.stay){ go("dash"); refreshDash() } else { refreshDash() }
  }catch(e){ toast("Load failed: "+e.message) }finally{ __busy() }
}
async function loadCaseAndRun(cid,btn){
  await loadCase(cid,btn,{stay:true}); go("run"); setTimeout(()=>runLive($("live-btn")),450);
}
async function resetWorkspace(btn){
  if(btn)btn.disabled=true;
  try{
    sessionStorage.setItem("slate-empty","1"); BRIEF_RUN=null; WS_GEN++;
    WS=await api("/api/v1/workspace/reset",{method:"POST"}); casePayments=[]; seedPayments=null; lastRun=null; lastMatches=[];
    DESK=[]; CHASE=[];
    renderCasebar(); const g=$("grade-out"); if(g)g.innerHTML="";
    // Back to the original state everywhere: no run, no matches, no desk,
    // no approvals from the previous case may stay on any page.
    ["run-summary","matches","exceptions","match-detail","dispute-desk","run-brief","live-log","impact-body","agent-pipe","agent-inspect"].forEach(id=>{const el=$(id); if(el)el.innerHTML=""});
    const ap=$("approvals"); if(ap)ap.innerHTML=""; const ac=$("appr-count"); if(ac)ac.style.display="none";
    toast("Workspace cleared - nothing is staged. Load a case to begin.");
    await refreshDash(); loadApprovals(); renderSuggestions();
  }catch(e){ toast("Reset failed: "+e.message) }finally{ if(btn)btn.disabled=false }
}

document.addEventListener("keydown",e=>{if(e.key!=="Escape")return;try{closeApprDrawer()}catch(_){} try{closeDocs()}catch(_){} try{closeCmdk()}catch(_){} try{closeKeyModal(false)}catch(_){} const m=$("acts-menu");if(m)m.classList.remove("open")});
