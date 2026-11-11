/* operate.js - OPERATE views: case grading, Dashboard, runs and match
   evidence, Upload Center, Use Cases. */
/* ---------- Grading the workspace run against the case's stated answer ---------- */
async function caseRunData(){
  const c=WS&&WS.case; if(!c||!c.expect||!Object.keys(c.expect).length) return null;
  const runs=await api("/api/v1/runs");
  for(const r of runs.slice(0,8)){
    const m=await api(`/api/v1/runs/${r.run_id}/matches`);
    if(m.some(mm=>Object.prototype.hasOwnProperty.call(c.expect,mm.payment_id))){
      const x=await api(`/api/v1/runs/${r.run_id}/exceptions`);
      return {run:r,matches:m,exceptions:x};
    }
  }
  return null;
}
function gradeHtml(c,results,exceptions,runId){
  const byPid={}; results.forEach(r=>byPid[r.payment_id]=r);
  const exByPid={}; (exceptions||[]).forEach(e=>exByPid[e.payment_id]=e.kind);
  const rows=[]; let allPass=true;
  const chk=(label,exp,act)=>{ const pass=JSON.stringify(exp)===JSON.stringify(act); if(!pass)allPass=false; rows.push(`<tr><td>${esc(label)}</td><td>${esc(JSON.stringify(exp))}</td><td>${esc(JSON.stringify(act))}</td><td class="${pass?"p":"f"}">${pass?"PASS":"FAIL"}</td></tr>`) };
  for(const [pid,exp] of Object.entries(c.expect||{})){
    const r=byPid[pid]||{};
    if("status" in exp) chk(`${pid} status`,exp.status,r.status);
    if("auto_posted" in exp) chk(`${pid} auto-posted`,exp.auto_posted,r.auto_posted);
    if("invoices" in exp) chk(`${pid} matched invoices`,[...exp.invoices].sort(),(r.lines||[]).map(l=>l.invoice_id).sort());
    if("residual_cents" in exp) chk(`${pid} residual`,exp.residual_cents,r.residual_cents);
    if("deduction_action" in exp){ const ded=r.deduction||{}; chk(`${pid} deduction decision`,exp.deduction_action,ded.autonomous_action); chk(`${pid} ERP reason code`,exp.erp_reason_code,ded.assigned_erp_reason_code) }
    if("spike" in exp){ const ded=r.deduction||{}; chk(`${pid} anomaly spike flagged`,exp.spike,ded.is_anomalous_spike) }
  }
  for(const [pid,kind] of Object.entries(c.expect_exceptions||{})) chk(`${pid} flagged ${kind}`,kind,exByPid[pid]);
  if(!rows.length) return "";
  return `<div class="panel"><h3>Case verdict - ${esc(c.name)} <span data-info="verdict"></span></h3><div class="verdict ${allPass?"pass":"fail"}">${allPass?"All checks passed - the workspace run did exactly what this case promises.":"Some checks failed - the evidence below is the honest result."}</div>${runId?`<p><small>Graded against run ${esc(runId)} - the run that processed this case's payments.</small></p>`:""}<table class="checks"><tr><th>Check</th><th>Expected</th><th>Actual</th><th>Verdict <span data-info="verdict"></span></th></tr>${rows.join("")}</table>${c.policy_note?`<p><small>${esc(c.policy_note)}</small></p>`:""}</div>`;
}
function normalisedStored(m){ return m.map(mm=>{ const r=mm.result||{}; return {payment_id:mm.payment_id,status:r.status,auto_posted:r.auto_posted,lines:r.lines||[],residual_cents:mm.residual_cents,deduction:r.deduction,payment:r.payment||null} }) }
async function renderGradeFromStored(){
  const el=$("grade-out"); if(!el) return;
  const c=WS&&WS.case; if(!c||!c.expect||!Object.keys(c.expect).length){
    await refreshWorkspace();
    const rid=WS&&WS.latest_run&&WS.latest_run.run_id;
    if(!rid){ el.innerHTML=""; return }
    const m=await api(`/api/v1/runs/${rid}/matches`).catch(()=>null);
    el.innerHTML=m?invariantGradeHtml({results:normalisedStored(m),run_id:rid}):"";
    return }
  await refreshWorkspace();
  const d=await caseRunData();
  if(!d){ el.innerHTML=`<div class="panel"><h3>Case verdict - ${esc(c.name)} <span data-info="verdict"></span></h3><div class="d">This case states its expected outcomes up front, but its payments have not been run in this workspace yet. Run the active case above and the graded verdict will appear here.</div></div>`; return }
  el.innerHTML=gradeHtml(c,normalisedStored(d.matches),d.exceptions,d.run.run_id);
}
function renderGradeFromResults(b){
  const el=$("grade-out"); if(!el) return;
  const c=WS&&WS.case; if(!c||!c.expect||!Object.keys(c.expect).length){ el.innerHTML=invariantGradeHtml(b); return }
  if(!b.results.some(r=>Object.prototype.hasOwnProperty.call(c.expect,r.payment_id))) return;
  el.innerHTML=gradeHtml(c,b.results,b.exceptions,b.run_id);
}
/* Cases without an authored answer key (uploaded CSVs, builder cases)
   are graded on the invariant every correct cash application must
   satisfy, payment by payment: allocated invoices + claimed deductions
   + declared residual = the wire amount. A solver that invents or
   loses a cent fails it; no ground truth needs to exist. */
function invariantGradeHtml(b){
  if(!b||!b.results||!b.results.length) return "";
  const payOf=r=>r.payment||(casePayments||[]).find(p=>p.payment_id===r.payment_id)||{};
  let pass=0;
  const rows=b.results.map(r=>{ const p=payOf(r); const alloc=(r.lines||[]).reduce((a,l)=>a+l.net_cents,0);
    const ded=p.claimed_deduction_cents||0; const total=alloc+ded+(r.residual_cents||0); const wire=p.amount_cents||0;
    const holds=wire>0&&total===wire; if(holds)pass++;
    return `<tr><td>${esc(r.payment_id)}</td><td>${money(alloc)}</td><td>${money(ded)}</td><td>${money(r.residual_cents||0)}</td><td>${money(wire)}</td><td>${holds?pill("Conserves","ok"):pill("Does not conserve","bad")}</td></tr>` }).join("");
  return `<div class="panel" style="margin-top:14px"><h3>Grading - cash conservation invariants</h3><div class="d">This case carries no pre-written answer key (it was uploaded or built, not authored), so it is graded on the invariant every correct cash application must satisfy: allocated invoices + claimed deductions + declared residual = the wire amount, payment by payment. <b>${pass} of ${b.results.length} payments conserve exactly.</b></div><table><tr><th>Payment</th><th>Allocated</th><th>Deduction</th><th>Residual</th><th>Wire</th><th>Invariant</th></tr>${rows}</table></div>`;
}
/* Exception rows carry the actions an analyst actually takes next.
   The Park button only appears where the queue holds a zero-line
   refusal for that payment (filled in asynchronously from the
   approvals queue); the inquiry and split routes always apply. */
async function decorateExceptionActions(){
  try{ const list=await api("/api/v1/approvals");
    const byPid={}; list.forEach(a=>{ if(!(a.invoices||[]).length) byPid[a.payment_id]=a; });
    document.querySelectorAll(".exc-act").forEach(td=>{ const a=byPid[td.dataset.pid];
      if(a&&!td.querySelector("button")){ const b=document.createElement("button"); b.className="btn small"; b.textContent="Park in Unapplied Suspense GL";
        b.onclick=ev=>decideMatch(a.match_id,"approve",ev.target); td.prepend(b, document.createTextNode(" ")); } });
  }catch(e){}
}
function openChaseFor(pid){ HUB_CAT="chases"; go("mail"); toast("The remittance inquiry for "+pid+" is drafted in this queue - Unapplied / Exception Wire Inquiries"); }
async function runStagedNow(btn){ executeActiveCase(); }
async function runWorkspaceBatch(btn){
  const __busy=btn?busyBtn(btn,"Solving MILP & matching payments..."):null;
  const __stopLive=agentLiveTimed(0);
  try{
    const ws=await refreshWorkspace(); let pays=ws?ws.all_payments:[];
    // One workspace, one payment set: a run always reconciles everything
    // staged - a newly arrived wire joins the case's run, it never
    // becomes a one-payment run that overwrites the case's results.
    if(!pays.length){ toast("Nothing staged to run - load a case or upload payments first"); return }
    const b=await api("/api/v1/batches",{method:"POST",body:JSON.stringify({idempotency_key:"ui-case-"+Date.now(),payments:pays})});
    __stopLive(); agentLiveStop();
    bumpGen(); lastRun=b; casePayments=pays; seedPayments=pays; renderRun(b);
    await refreshWorkspace(); renderGradeFromResults(b); refreshDash(); scheduleApprovalsJump(1200); toast("Run complete");
  }catch(e){ __stopLive(); agentLiveStop(); toast("Run failed: "+e.message) }finally{ if(__busy)__busy() }
}

/* ---------- Dashboard + runs ---------- */
async function refreshDash(){
  const g=WS_GEN;
  try{
    await refreshWorkspace();
    if(g!==WS_GEN) return; // a case switch landed mid-refresh; a fresher pass owns the screen
    // Independent reads in parallel - sequentially they made the
    // dashboard trail the case bar by several seconds on the live box.
    const [h, inv, runs]=await Promise.all([api("/health"), api("/api/v1/invoices"), api("/api/v1/runs")]);
    window.__AI_LAST_ERROR=h.gemini_last_error||"";
    $("k-ai").textContent=aiModeLabel(h.gemini_configured,h.gemini_last_error);
    fillInfo();
    renderImpact();
    const R0=runs.find(r=>!r.status||r.status==="COMPLETED");
    if(R0){
      const m=await api(`/api/v1/runs/${R0.run_id}/matches`);
      if(g!==WS_GEN) return;
      const susp=m.reduce((a,x)=>a+Math.abs(x.residual_cents),0);
      const lats=m.map(x=>(x.result||{}).latency_ms||0).filter(Boolean);
      // Headline framing (v24): the JD asks for 90%+ automation, so the
      // headline is the share of wires the AGENT decided - posted,
      // solved and queued for sign-off, or refused with a reason. The
      // zero-touch rate stays printed underneath as one tier of it,
      // never hidden and never inflated: a held exact match is solved,
      // a refused wire is not, and both say so.
      if(R0.payments){
        const tot=R0.payments, dec=m.length;
        const autoN=m.filter(x=>x.status==="AUTO_POSTED").length;
        const qSol=m.filter(x=>x.status==="PROPOSED"&&((x.result||{}).lines||[]).length).length;
        const qRef=dec-autoN-qSol;
        const pc=n=>(n/tot*100).toFixed(1)+"%";
        $("r-stp").innerHTML=(dec/tot*100).toFixed(1)+"%";
        const sub=$("r-stp-sub");
        if(sub){ const parts=[`${pc(autoN)} zero-touch auto-posted`];
          if(qSol) parts.push(`${pc(qSol)} solved & queued for maker-checker sign-off`);
          if(qRef) parts.push(`${pc(qRef)} refused with a reason, queued for review`);
          sub.textContent=parts.join(" · "); }
      } else $("r-stp").innerHTML="-";
      $("r-susp").innerHTML=money(susp);
      $("r-lat").innerHTML=lats.length?(lats.reduce((a,b)=>a+b,0)/lats.length).toFixed(1)+" <small>ms</small>":"-";
      $("r-settled").innerHTML=m.reduce((a,x)=>a+((x.result||{}).lines||[]).length,0);
      $("r-exc").innerHTML=R0.exceptions;
    } else if(!(WS&&WS.latest_run)) {
      // A stale no-runs snapshot (e.g. the page's first dashboard load,
      // still in flight while the first-visit bootstrap runs a batch)
      // must never erase a ribbon a fresher read already filled.
      $("r-stp").innerHTML="-"; $("r-susp").innerHTML="-"; $("r-lat").innerHTML="-";
      $("r-settled").innerHTML="-"; $("r-exc").innerHTML="-";
    }
    if(R0){const t=R0.payments?R0.auto_posted/R0.payments:0;$("k-touch").textContent=(t*100).toFixed(1)+"%"}
    else{$("k-touch").textContent="-"}
    if(WS&&WS.run_status==="staged"){
      // v32: the readiness panel lives ONCE, in the Case Brief above.
      // The ribbon summarises the staged state; it never duplicates it.
      $("dash-out").innerHTML="";
      $("r-stp").innerHTML="Staged"; { const sub=$("r-stp-sub"); if(sub) sub.textContent=`${WS.staged_payments} wires waiting to run`; }
      $("r-susp").innerHTML=money(WS.staged_payment_total_cents||0); $("r-lat").innerHTML="-"; $("r-settled").innerHTML="0"; $("r-exc").innerHTML="-";
    }
    else if((!WS||!WS.case)&&!runs.length){$("dash-out").innerHTML=`<div class="msg"><b>No case is loaded.</b> This workspace is empty on purpose - nothing is preloaded. Load the demo case, pick a use case, build one, or upload your own files, and every page will work on that same data. <button class="btn" style="margin-left:10px" onclick="loadCase('seed',this,{stay:true})">Load demo case</button></div>`}
    else if(!(WS&&WS.run_status==="staged")){$("dash-out").innerHTML=""}
    $("runs-t").innerHTML=runs.length?`<table><tr><th>Run</th><th>When (UTC)</th><th>Status</th><th>Matches</th><th>Auto-posted</th><th>Exceptions</th></tr>${runs.map(r=>`<tr class="clickable" data-rid="${esc(r.run_id)}" onclick="openRun(this.dataset.rid)"><td><small>${esc(r.run_id)}</small></td><td><small>${esc((r.created_at||"").replace("T"," ").slice(0,19))}</small></td><td>${pill(r.status,"ok")}</td><td>${r.matches}</td><td>${r.auto_posted}</td><td>${r.exceptions}</td></tr>`).join("")}</table>`:"<small>No runs yet. Load a case or upload payments to create the first run.</small>";
  }catch(e){toast("Could not load dashboard: "+e.message)}
}
async function openRun(runId){
  go("run");
  const [m,x]=await Promise.all([api(`/api/v1/runs/${runId}/matches`),api(`/api/v1/runs/${runId}/exceptions`)]);
  renderStoredRun(runId,m,x);
  renderGradeFromStored();
  scheduleApprovalsJump(1200);
}
function renderStoredRun(runId,matches,exceptions){
  lastMatches=matches;
  let shown=matches;
  if(RUN_FILTER==="exceptions"){
    const exIds=new Set(exceptions.map(e=>e.payment_id));
    shown=matches.filter(m=>exIds.has(m.payment_id)||(((m.result||{}).deduction||{}).autonomous_action==="AUTO_GENERATE_DISPUTE_CLAIM"));
  }
  $("run-summary").innerHTML=RUN_FILTER==="exceptions"
    ?`<div class="msg"><span class="runfilter"><b>Filtered: exception and disputed rows</b> of run <b>${esc(runId)}</b> - ${shown.length} of ${matches.length} matches shown, ${exceptions.length} exceptions below. <button class="btn small ghost" onclick="clearRunFilter()">Clear filter</button></span></div>`
    :`<div class="msg">Run <b>${esc(runId)}</b> - ${matches.length} matches, ${exceptions.length} exceptions. Select a match for its evidence.</div>`;
  $("matches").innerHTML=shown.length?`<table><tr><th>Payment</th><th>Decision <span data-info="decision"></span></th><th>Solver</th><th>Matched invoices</th><th>Allocated cash</th><th>Residual <span data-info="resid"></span></th><th>Conf. <span data-info="conf"></span></th></tr>${shown.map(m=>{const i=matches.indexOf(m);const rr=m.result||{};return `<tr class="clickable" onclick="storedDetail(${i})"><td>${esc(m.payment_id)}</td><td>${pill(m.status,m.status==="AUTO_POSTED"?"ok":"warn")}</td><td>${esc(m.solver)}</td><td>${(rr.lines||[]).map(l=>esc(l.invoice_id)).join(", ")||"-"}</td><td>${money((rr.lines||[]).reduce((a,l)=>a+l.net_cents,0))}</td><td>${money(m.residual_cents)}</td><td>${Number(m.confidence).toFixed(2)}</td></tr>`}).join("")}</table>`:"<small>No matches stored for this run.</small>";
  $("exceptions").innerHTML=exceptions.length?`<table><tr><th>Payment</th><th>Kind</th><th>Severity</th><th>Recommended action <span data-info="excact"></span></th><th>Actions</th></tr>${exceptions.map(e=>`<tr><td>${esc(e.payment_id)}</td><td>${pill(e.kind,"warn")}</td><td>${esc(e.severity)}</td><td>${esc(e.recommended_action)}</td><td class="exc-act" data-pid="${esc(e.payment_id)}" style="white-space:nowrap"><button class="btn small ghost" data-pid="${esc(e.payment_id)}" onclick="openChaseFor(this.dataset.pid)">Remittance inquiry</button> <button class="btn small ghost" onclick="go('ledger')">Manual split in Ledger</button></td></tr>`).join("")}</table>`:"<small>No exceptions. Clean run.</small>";
  decorateExceptionActions();
  $("match-detail").innerHTML="";
  loadBrief(runId); renderDisputeDesk(matches, exceptions);
  renderSuggestions();
  renderAgentPipe(runId);
  scheduleHero("stored");
}
let specSeq=0;
function spec(title,what,formula,impact){
  const id="spec"+(++specSeq);
  return `<span class="specwrap"><button class="specbtn" title="How this is computed - hover to read, click to pin" data-sid="${esc(id)}" onclick="toggleSpec(this.dataset.sid,event)">i</button><span class="speccard" id="${id}"><span class="t">${esc(title)}</span><span class="lbl">What it is</span><p>${esc(what)}</p><span class="lbl">How it is calculated</span><p class="fx">${esc(formula)}</p><span class="lbl">Why it matters</span><p>${esc(impact)}</p></span></span>`;
}
function toggleSpec(id,ev){ev.stopPropagation();document.querySelectorAll(".speccard").forEach(c=>{if(c.id!==id)c.classList.remove("open")});document.getElementById(id).classList.toggle("open")}
document.addEventListener("click",()=>document.querySelectorAll(".speccard").forEach(c=>c.classList.remove("open")));

const SPECS={
  touch:["Touchless (straight-through) rate","The share of payments in the run that posted with no human touch.","auto-posted payments / all payments in the run; duplicates and no-matches stay in the denominator","Use it to judge automation honestly: the rate falls when remittance data is poor because the agent asks instead of guessing."],
  mode:["Agent mode","The extraction mode reported by the server for this deployment.","Gemini when configured; deterministic extraction otherwise. References are verified against the open ledger in both modes","The mode is shown on every parse result, so extracted data is never presented as something it is not."],
  sap:["SAP S/4HANA BAPI & EBRR","The posting document the ERP receives for a cleared payment: a balanced DZ journal (cash, discounts, deductions, AR control) with the BAPI_ACC_DOCUMENT_POST payload, plus the ASC 606 / IFRS 15 dispute reserve journal for claims the Deduction Agent opens.","DZ for an exact match: Dr 113100 Cash + Dr 415000 Discounts + Dr 529000 Deductions = Cr 121000 AR Control; a residual adds Dr 121600 (underpayment remainder) or Cr 121900 (overpayment excess) so the document still balances; reserve: Dr 121500 Disputed / Cr 121000 AR","Cash application stops being a demo here: the solver's own numbers arrive in the ERP's document shape, balanced to the cent. Click the card to open a real payload."],
  solver:["Solver Engine - HiGHS MILP + Rust kernel","Exact subset selection under the cash conservation equation. The MILP proves the chosen invoice set is the cheapest complete explanation of the wire; a Rust subset-sum kernel inside the solve path decides a payment only when its exact set is provably unique (at most 18 candidates) and is equivalence-tested against the Python path on 203 shared cases; every set the MILP returns is re-verified in exact integer cents before it is believed.","minimise unexplained cents x 1,000,000 + set penalties, subject to sum(gross) - discounts - deduction - payment = residual; residual must be exactly 0 to auto-post, with confidence at the policy threshold and no maker-checker hold","A 37-cent near-miss on a seven-figure wire is rejected and re-verified in integer cents - never posted as exact. Click the card for the live kernel health."]};
const INFO={
  stp:["Autonomous resolution rate","The share of payments in the latest run that the agent brought to a decision on its own: posted, solved and queued for sign-off, or refused with a stated reason.","decided payments / all payments in the run","It separates automated decision-making from zero-touch posting; the touchless rate is reported separately."],
  susp:["Unapplied cash in suspense","Money from the latest run that the agent could not fully explain - the total of all leftover amounts (residuals) across its matches.","SUM |residual_cents| over the run's stored matches","Money that arrived but is not yet applied to any invoice blocks the month-end close and confuses customers. This is usually the first figure a CFO asks for."],
  lat:["Average solver latency","How long the solver took per payment in the latest run, on average. The time is stored on each match when it is made.","mean(latency_ms) over matches","A batch can hold thousands of payments, so each one must solve in milliseconds. Narrowing the candidate list first is what keeps it fast."],
  setl:["Invoices settled","How many invoices were cleared by the latest run, added up across all its matches.","SUM of matched lines over the run's matches","This counts cleared work. One payment can settle several invoices at once."],
  exc:["Open exceptions","Payments in the latest run that the agent would not post on its own. Each one has a type, a severity, and a suggested next step.","count of exception records on the run","Exceptions are not errors. They are the analyst's work queue, already sorted and explained."],
  claimamt:["The claim","The amount the buyer deducted from this payment - the money being claimed back.","the deduction recorded on the match when the Deduction Agent judged it","A claim is only opened when the expected-value rule says fighting is worth more than it costs."],
  winprob:["Win probability","The chance this claim is recovered if it is fought. It is a stated heuristic, not a trained probability.","0.94 when the carrier proof of delivery is verified clean, 0.35 otherwise","The number is deliberately simple and visible, so a controller can disagree with it. It is never dressed up as a model output."],
  exprec:["Expected recovery","What fighting this claim is worth on average, after the cost of fighting.","win probability x claim - $45 processing cost (policy default)","Only claims with a clean proof of delivery and an expected recovery above the $100 auto-dispute minimum are opened automatically - the rest are written off at tolerance or routed to a person."],
  exp30:["Expected 30d","The cash this customer is expected to actually pay within 30 days.","each open invoice weighted by its simulated chance of landing in 30 days, summed","It is lower than the open balance on purpose: it counts probability, not hope."],
  exp8w:["Expected 8 wks","The same expected cash across the full 8-week horizon.","each open invoice weighted by its simulated chance of landing within 56 days, summed","Comparing 30 days with 8 weeks shows how much of the book is slow rather than lost."],
  avgdelay:["Avg pred. delay","On average, how many days late this customer is predicted to pay, across their open invoices.","mean of the delay model's prediction per invoice, in days beyond terms","The model is graded on held-out data at MAE 2.95 days - treat this as a planning estimate, not a promise."],
  cump50:["Cumulative P50","The running total of the weekly P50 figures up to and including this week.","sum of the weekly P50 medians, week 1 to this week","It answers the treasurer's question: how much cash should have arrived by this week in the expected case."],
  weekinv:["Invoices","How many invoices are expected to land in this week.","count of invoices whose expected week this is; click the count to see them by name","Every dollar in the bands traces to named invoices - nothing is an unexplained lump."],
  chance30:["Chance in 30d","The chance this invoice is paid within 30 days.","share of the 400 simulations in which the invoice lands within 30 days","A low chance here is one of the tests behind the At risk card above."],
  chancehz:["Chance in horizon","The chance this invoice is paid inside the 8-week horizon at all.","share of the 400 simulations in which the invoice lands within 56 days","What is not expected inside the horizon sits in Beyond week 8 - still counted in open receivables."],
  whatifp50:["P50 now / shifted","The median simulated cash-in for this week, before and after the shift.","50th percentile of the week's simulated totals in each run","Cash rarely appears or vanishes in a what-if; it moves between weeks. The Move column shows where it went."],
  whatifmove:["Move","How much this week's expected cash changes under the shift.","P50 shifted - P50 now, per week","The sentence above the table uses expected totals across all simulations, so it need not equal the sum of these weekly median moves."],
  resid:["Residual","The part of the payment that the chosen invoices do not explain, exact to the cent.","residual = payment - (net applied - deduction accepted)","A leftover amount is never quietly hidden. At $0 the match can post on its own; anything else becomes an exception for a person."],
  conf:["Confidence","A score for the match, worked out by a fixed rule. You can recompute it by hand from the derivation shown on the match.","base: 1.0 if residual = 0, else max(0.3, 1 - |residual| / payment); +0.03 on reference or PO evidence; caps: 0.78 on fuzzy or whole-ledger rungs, 0.75 on an ambiguous tie or a cross-customer set","A match posts on its own only if it is exact, its confidence meets the policy threshold (0.90), and no maker-checker hold applies."],
  decision:["Decision","AUTO_POSTED: the engine posted it with no human involved. PROPOSED: the engine is asking a person to approve it first.","auto-posted iff status = OPTIMAL_EXACT_MATCH and confidence >= automation threshold and the amount is under the maker-checker threshold; an exact match over that threshold is held PROPOSED at any confidence","Policy draws this line, and it is the same line every time."],
  excact:["Recommended action","The next step the agent suggests for this exception, based on what kind of problem it is.","duplicate: hold and verify; residual: review counterfactuals; no-match: analyst investigation","Every exception arrives with its next step already worked out."],
  verdict:["Use-case verdict","The answer the scenario promised, compared field by field with what the engine actually did on a fresh ledger.","pass iff status, auto-post flag, invoice set, residual and deduction decision all equal the stated expectation","Green is earned by the run itself - it cannot be typed in."],
  parsefld:["Verified extraction","The fields the parser pulled out of the email. Every invoice or PO reference is checked against the ledger before it is trusted.","verified iff every invoice/PO reference exists in the ledger; invented references are flagged by name","The AI suggests; a fixed check verifies. That split is what makes it safe to post cash from an AI reading."],
  milpacc:["MILP accuracy","On test cases with known answers, how often the optimiser picks exactly the right invoices. Computed live, through the same steps a real payment takes.","correct sets / labelled cases","This is the main quality figure for the solver. It is recomputed on every page load, so it cannot go stale."],
  greedyacc:["Greedy accuracy","The same test cases, run through a simple first-fit method that takes invoices in order while they fit.","correct sets / labelled cases, identical candidate sets","The simple method fails exactly where the choice gets hard - when age, discounts and deductions all matter at once."],
  exactrate:["Exact rate","How often the solver's answer leaves exactly $0.00 unexplained.","zero-residual solutions / labelled cases","Close is not enough to post. A near match is still unapplied cash."],
  mae:["Delay model MAE","On invoices held back from training and predicted later, how far off the predicted payment date was, on average, in days.","MAE = mean |predicted - actual| days over the test split; naive baseline predicts the mean","2.95 days of average error, against 7.67 for a naive guess, is what makes the forecast usable."],
  rung:["Matched by","Which rung of the candidate-resolution cascade produced this match's shortlist: explicit reference, purchase order, OCR-repaired reference, amount-plus-payer, fuzzy payer, or the customer's whole ledger.","recorded on the match at solve time; the cascade order is references, PO, OCR repair, amount-plus-payer, fuzzy payer, then the whole ledger; saved aliases resolve who the payer is inside the rungs, they are not a rung themselves","The rung is the audit trail of the evidence: a match found by a stated reference is stronger than one found by amount alone, and the record says which."],
  ailayer:["AI extraction layer","The extraction mode reported by the server for each parse.","Gemini when a key and model are configured; deterministic extraction otherwise","Extracted references are verified against the open ledger in both modes before anything is staged."],
  prio:["Priority score","The collections ranking figure for this invoice.","score = amount x (1 + overdue/30) x (1 + max(predicted delay,0)/20)","Bigger, later and slower-paying wins - the queue order is this number, descending."],
  preddelay:["Predicted delay","How late this customer is expected to pay this invoice, from the delay model.","predicted days beyond terms; graded at MAE 2.95 days on held-out data","This single prediction feeds both the collections queue and the forecast bands."],
  p10:["P10 (cautious)","The cautious cash-in figure for the week: receipts exceed it in about 90% of simulated outcomes.","10th percentile of simulated weekly totals","Plan commitments against P10; anything above it is upside, not plan."],
  p50:["P50 (expected)","The median simulated cash-in for the week - the single best planning estimate.","50th percentile of simulated weekly totals","Half of simulated outcomes land above, half below - the honest middle."],
  p90:["P90 (optimistic)","The optimistic figure: only about 10% of simulated outcomes exceed it.","90th percentile of simulated weekly totals","Useful for spotting upside, dangerous as a plan - the band exists so nobody has to guess which number a single forecast was."],
  objterm:["Objective term","One line of the solver's objective function, with the run's real values substituted.","objective total = sum of the terms; the solver minimises it","This is the MILP's reasoning made visible: reward for settling old invoices, charges for discounts, deductions, and a dominating charge per residual cent."],
  pex:["Stage 1 - Extract","An extractor reads the free text and proposes structured payment fields.","Gemini when a server key is configured; the deterministic extractor otherwise - the engine used is named on the card","Proposal only: nothing extracted here is trusted until stage 3 verifies it."],
  psch:["Stage 2 - Schema check","The proposed fields are validated against the required shape before anything else happens.","required: payer, amount_cents, invoice_refs, po_refs, deduction_cents, deduction_reason","Malformed output is rejected before it can reach the ledger."],
  pver:["Stage 3 - Verify references","Every invoice and PO reference in the extraction is checked against the open ledger.","a reference is verified iff it exists among open invoices or their POs; invented ones are flagged by name","This is the control that makes an AI front door safe: hallucinated references cannot post cash."],
  ptrust:["Stage 4 - Trust decision","Whether the parsed payment may flow into reconciliation as-is.","verified iff stage 3 flagged nothing; otherwise a human resolves the flags first","The same gate applies in AI and deterministic modes."],
  auc:["Validity classifier AUC","How well the validity model ranks deductions: real ones scored above fake ones, measured on data it never trained on.","ROC AUC: probability a random valid deduction scores above a random invalid one; 0.5 is chance","AUC cannot be flattered by an easy test set - it grades the ranking itself."]};
function fillInfo(){
  document.querySelectorAll(".specslot").forEach(el=>{const sp=SPECS[el.dataset.spec]; if(sp && !el.dataset.filled){el.innerHTML=spec(sp[0],sp[1],sp[2],sp[3]); el.dataset.filled="1"}});
  document.querySelectorAll("[data-info]").forEach(el=>{const sp=INFO[el.dataset.info]||SPECS[el.dataset.info]; if(sp && !el.dataset.filled){el.innerHTML=spec(sp[0],sp[1],sp[2],sp[3]); el.dataset.filled="1"}});
}
function reasoningHtml(x){
  const r=x&&x.reasoning; if(!r||!(r.steps||[]).length) return "";
  const steps=r.steps.map((s,i)=>`<div style="display:flex;gap:10px;padding:7px 0;border-bottom:1px solid var(--line)"><span style="flex:0 0 auto;width:22px;height:22px;border-radius:50%;background:var(--blue);color:#fff;font:700 12px 'Inter Tight';display:flex;align-items:center;justify-content:center">${i+1}</span><span style="line-height:1.55">${esc(s)}</span></div>`).join("");
  const rej=(r.rejections||[]).length?`<div style="margin-top:12px"><b>Why the other invoices were not picked</b>${r.rejections.map(j=>`<div style="padding:6px 0 6px 32px;line-height:1.55;border-bottom:1px solid var(--line)">${esc(j.text)}</div>`).join("")}</div>`:"";
  const close=(r.close_calls||[]).length?`<div style="margin-top:12px"><b>Close calls - combinations that nearly worked</b>${r.close_calls.map(c=>`<div style="padding:6px 0 6px 32px;line-height:1.55;border-bottom:1px solid var(--line)">${esc(c.text)}</div>`).join("")}<small>Near misses are shown so the one exact set can be judged against how close everything else came.</small></div>`:"";
  return `<div class="panel" style="margin:14px 0"><h3>How this decision was made</h3><div class="detail">Step by step - every number below comes from this run itself.</div>${steps}${rej}${close}</div>`;
}
function derivationHtml(d){
  if(!d) return "";
  const eq=d.equation||{};
  const terms=(d.objective_terms||[]).map(t=>`<tr><td>${esc(t.term)}</td><td><small>${esc(t.formula)}</small></td><td>${t.value}</td></tr>`).join("");
  const cd=d.confidence_derivation||{};
  const g=d.greedy_comparison||{};
  return `<div class="detail"><b>Derivation - how this decision was computed</b><br>
  Cash conservation: net applied ${money(eq.net_applied_cents||0)} - deduction accepted ${money(eq.deduction_applied_cents||0)} + residual ${money(eq.residual_cents||0)} = <b>${money(eq.payment_cents||0)}</b> received ${eq.balances?pill("equation balances","ok"):pill("does not balance","bad")}<br>
  Invoices the solver was allowed to consider: ${d.candidates_considered ?? "-"} - solver score (objective total): <b>${d.objective_total ?? "-"}</b> (lower wins)
  ${terms?`<table><tr><th>Objective term <span data-info="objterm"></span></th><th>Formula</th><th>Value</th></tr>${terms}</table>`:""}
  Confidence: base ${cd.base ?? "-"} <small>(${esc(cd.base_rule||"")})</small><br>
  Simple baseline on the same shortlist: ${(g.invoices||[]).join(", ")||"nothing"} - residual ${money(g.residual_cents||0)} (${esc(g.status||"")}). <small>${esc(g.reading||"")}</small></div>`;
}
function storedDetail(i,quiet){
  const m=lastMatches[i];const res=m.result||{};
  CUR_RESID=m.residual_cents||0;
  const lines=(res.lines||[]).map(l=>`<tr><td>${esc(l.invoice_id)}</td><td>${money(l.gross_cents)}</td><td>${money(l.discount_cents)}</td><td>${money(l.net_cents)}</td></tr>`).join("");
  const pay=(seedPayments||[]).find(p=>p.payment_id===m.payment_id)||res.payment||null;
  const norm={payment_id:m.payment_id,lines:res.lines||[],deduction:res.deduction,derivation:res.derivation,reasoning:res.reasoning,residual_cents:m.residual_cents};
  $("match-detail").innerHTML=`<div class="panel"><h3>Match evidence - ${esc(m.payment_id)}</h3><div class="detail">Decision <b>${esc(m.status)}</b> by solver <b>${esc(m.solver)}</b>, found via <b>${esc(res.matched_by||"-")}</b>, residual <b>${money(m.residual_cents)}</b>, confidence <b>${Number(m.confidence).toFixed(3)}</b>, solver time ${res.latency_ms??"-"} ms.${res.deduction_applied?" A claimed deduction was applied and judged by deduction intelligence.":""}</div>${res.deduction?`<div class="detail"><b>Deduction intelligence:</b> classified <b>${esc(res.deduction.classification?.label||"")}</b> (${esc(res.deduction.assigned_erp_reason_code||"")}), z-score ${res.deduction.z_score}, win probability ${res.deduction.win_probability??"n/a"}, expected recovery $${res.deduction.expected_recovery_value_usd} - decision: <b>${esc(res.deduction.autonomous_action)}</b>.<br><small>${esc(res.deduction.win_probability_basis||"")}</small></div>`:""}${reasoningHtml(res)}${derivationHtml(res.derivation)}${lines?`<table><tr><th>Invoice</th><th>Gross</th><th>Discount</th><th>Net applied</th></tr>${lines}</table>`:"<small>No invoice lines - nothing was safe to propose.</small>"}${detailExtras(norm,pay)}</div>`;
  if(!quiet){ $("match-detail").scrollIntoView({behavior:"smooth",block:"nearest"}); scheduleApprovalsJump(2800); }
}

async function openSapShowcase(){
  try{ const ws=await refreshWorkspace();
    if(!ws||!ws.latest_run){ toast("No run yet - load a case and the SAP payload opens from its first cleared payment"); return }
    await openRun(ws.latest_run.run_id);
    const i=(lastMatches||[]).findIndex(m=>((m.result||{}).lines||[]).length);
    if(i<0){ toast("The latest run cleared no payment with invoice lines"); return }
    storedDetail(i);
    setTimeout(()=>{ const b=document.querySelector('#match-detail button[onclick^="erpToggle"]'); if(b) b.click(); },500);
  }catch(e){ toast(e.message) }
}

/* ---------- Seed + batch ---------- */
async function seedAndRun(btn){ await loadCaseAndRun("seed",btn) }
function renderRun(b){
  BRIEF_RUN=null; BRIEF_PROMISE=null; // a finished run invalidates any brief computed while it executed
  RUN_FILTER=null;
  $("run-summary").innerHTML=`<div class="msg">Run <b>${esc(b.run_id)}</b> - ${b.payments} payments, <b>${b.auto_posted} auto-posted</b>, touchless ${(b.touchless_rate*100).toFixed(1)}%. Select a match for lines and counterfactuals.</div>`;
  $("matches").innerHTML=`<table><tr><th>Payment</th><th>Status</th><th>Matched by <span data-info="rung"></span></th><th>Matched invoices</th><th>Allocated cash</th><th>Residual <span data-info="resid"></span></th><th>Conf. <span data-info="conf"></span></th></tr>${b.results.map((r,i)=>`<tr class="clickable" onclick="liveDetail(${i})"><td>${esc(r.payment_id)}</td><td>${statusPill(r.status)}</td><td>${pill(esc(r.matched_by||"-"),"info")}</td><td>${r.lines.map(l=>esc(l.invoice_id)).join(", ")||"-"}</td><td>${money(r.lines.reduce((a,l)=>a+l.net_cents,0))}</td><td>${money(r.residual_cents)}</td><td><div class="confbar"><i style="width:${Math.round(r.confidence*100)}%"></i></div><small>${Number(r.confidence).toFixed(2)}</small></td></tr>`).join("")}</table>`;
  $("exceptions").innerHTML=b.exceptions.length?`<table><tr><th>Payment</th><th>Kind</th><th>Severity</th><th>Recommended action <span data-info="excact"></span></th><th>Actions</th></tr>${b.exceptions.map(e=>`<tr><td>${esc(e.payment_id)}</td><td>${pill(e.kind,"warn")}</td><td>${esc(e.severity)}</td><td>${esc(e.recommended_action)}</td><td class="exc-act" data-pid="${esc(e.payment_id)}" style="white-space:nowrap"><button class="btn small ghost" data-pid="${esc(e.payment_id)}" onclick="openChaseFor(this.dataset.pid)">Remittance inquiry</button> <button class="btn small ghost" onclick="go('ledger')">Manual split in Ledger</button></td></tr>`).join("")}</table>`:"<small>No exceptions. Clean run.</small>";
  decorateExceptionActions();
  $("match-detail").innerHTML="";
  fillInfo();
  renderSuggestions();
  renderAgentPipe(b.run_id);
  scheduleHero("live");
}
const AGENT_SHORT={"Capture Agent":"Capture","Linking Agent":"Linking","Matching Agent":"Matching","Deduction Agent":"Deduction","Policy Agent":"Policy","Briefing Agent":"Briefing"};
let PIPE_DATA=[];
/* The agent team, shown while a run is executing. The strip is driven
   by the run stream's own events (counts of resolved / solved /
   decided wires are the stream's numbers, never invented); when the
   run lands, renderAgentPipe replaces it with the permanent record
   and its measured timings. The non-streaming path advances the
   early stages on timers and holds on Matching, where the time
   genuinely goes, until the response arrives. */
const AGENT_LIVE=[["Capture","wires received"],["Linking","candidates narrowed"],["Matching","wires solved"],["Deduction","claims judged"],["Policy","decisions made"],["Briefing","drafts composed"]];
let AGENT_LIVE_STATE=null;
function agentStripHtml(stages,counts,note){
  const cards=AGENT_LIVE.map((def,i)=>{ const s=stages[i];
    const pl= s==="done"?pill("Completed","ok"): s==="running"?pill("Running","info"): s==="ondemand"?pill("On demand","info"): pill("Queued","grey");
    const sub= s==="running"?"working...": s==="done"?"done": s==="ondemand"?"composes on demand":"waiting";
    return `${i?'<div class="aarr">&#8594;</div>':""}<div class="anode live ${s}"><b>${def[0]}</b><span>${counts[i]||def[1]}</span><span>${sub}</span>${pl}</div>`; }).join("");
  return `<div class="apipe">${cards}</div><small>${note}</small>`;
}
function renderAgentLive(){
  const el=$("agent-pipe"); if(!el||!AGENT_LIVE_STATE) return;
  const st=AGENT_LIVE_STATE;
  const counts=["","","","","",""];
  if(st.total){ counts[0]=`${st.total} wires in`; counts[2]=`${st.solved} of ${st.total} solved`; counts[4]=`${st.decided} of ${st.total} decided`; }
  if(st.resolved) counts[1]=`${st.resolved} resolved`;
  if(st.judged) counts[3]=`${st.judged} judged`;
  el.innerHTML=agentStripHtml(st.stages,counts,"Live progress from the run itself - when the run lands, this strip becomes the run's permanent record with its measured timings.");
}
function agentLiveStart(total){
  AGENT_LIVE_STATE={total:total||0,resolved:0,solved:0,judged:0,decided:0,stages:["running","queued","queued","queued","queued","queued"]};
  renderAgentLive();
}
function agentLiveEvent(kind,n){
  const st=AGENT_LIVE_STATE; if(!st) return;
  if(kind==="batch_start"){ if(n&&!st.total) st.total=n; st.stages[0]="done"; st.stages[1]="running"; }
  else if(kind==="resolved"){ st.resolved++; st.stages[1]="running"; st.stages[2]="running"; if(st.total&&st.resolved>=st.total) st.stages[1]="done"; }
  else if(kind==="solved"){ st.solved++; if(st.total&&st.solved>=st.total) st.stages[2]="done"; if(st.stages[3]==="queued") st.stages[3]="running"; }
  else if(kind==="deduction"){ st.judged++; }
  else if(kind==="decision"){ st.decided++; if(st.judged<st.decided) st.judged=st.decided; st.stages[4]="running"; if(st.total&&st.decided>=st.total){ st.stages[3]="done"; st.stages[4]="done"; st.stages[5]="running"; } }
  else if(kind==="batch_done"){ st.stages=["done","done","done","done","done","running"]; }
  renderAgentLive();
}
function agentLiveStop(){ AGENT_LIVE_STATE=null; }
function agentLiveTimed(total){
  agentLiveStart(0);
  const st=AGENT_LIVE_STATE; if(!st) return ()=>{};
  const t1=setTimeout(()=>{ if(AGENT_LIVE_STATE===st){ st.stages[0]="done"; st.stages[1]="running"; renderAgentLive(); } },450);
  const t2=setTimeout(()=>{ if(AGENT_LIVE_STATE===st){ st.stages[1]="done"; st.stages[2]="running"; renderAgentLive(); } },1050);
  return ()=>{ clearTimeout(t1); clearTimeout(t2); };
}
function orderRunPanels(executed){
  const ap=$("agent-panel"), sp=$("staged-panel"), gr=$("results-grid");
  if(!ap||!sp||!gr) return;
  if(executed){ if(gr.previousElementSibling!==ap) ap.after(gr); }
  else { if(gr.previousElementSibling!==sp) sp.after(gr); }
}
async function renderAgentPipe(runId){
  const el=$("agent-pipe"); if(!el) return;
  if(!runId){ el.innerHTML=agentStripHtml(["queued","queued","queued","queued","queued","ondemand"],["","","","","",""],"The agent team on this run: five agents work in sequence and Briefing composes on demand. Run the case and this strip lights up live, then becomes the run's permanent record with measured timings - click any agent to inspect what it handed on."); const ai=$("agent-inspect"); if(ai)ai.innerHTML=""; return }
  try{ const d=await api(`/api/v1/runs/${runId}/agents`); PIPE_DATA=d.agents||[];
    if(!PIPE_DATA.length){ el.innerHTML="<small>This run predates agent pipeline recording. Run the batch again and each agent's timing and payload will be inspectable here.</small>"; return }
    const cnt=a=>{ const e=a.evidence||{}; if(a.agent==="Capture Agent") return `${e.payments_received??"-"} wires in`; if(a.agent==="Linking Agent") return `${e.candidates_total??"-"} candidates`; if(a.agent==="Matching Agent") return `${e.payments_solved??"-"} wires solved`; if(a.agent==="Deduction Agent") return `${e.claims_judged??"-"} claims judged`; if(a.agent==="Policy Agent") return `${e.auto_posted??"-"} auto-posted, ${(e.held_for_approval??e.proposed_for_review??"-")} held`; if(a.agent==="Briefing Agent") return `${e.settlement_drafts_recorded??"-"} drafts composed`; return "" };
    el.innerHTML=`<div class="apipe">${PIPE_DATA.map((a,i)=>`${i?'<div class="aarr">&#8594;</div>':""}<button class="anode" onclick="inspectAgent(${i})"><b>${esc(AGENT_SHORT[a.agent]||a.agent)}</b><span>${cnt(a)}</span><span>${a.status==="ON_DEMAND"?"composes on demand":a.latency_ms+" ms measured"}</span>${pill(a.status==="COMPLETED"?"Completed":a.status==="ON_DEMAND"?"On demand":a.status, a.status==="COMPLETED"?"ok":"info")}</button>`).join("")}</div><small>This strip is the run's permanent record: timings and payloads are the steps the engine recorded while it executed - click an agent to inspect what it handed on.</small>`;
    setTimeout(autoInspectMatching,80);
  }catch(e){ el.innerHTML=""; }
}
function inspectAgent(i){
  const a=PIPE_DATA[i]; if(!a) return;
  $("agent-inspect").innerHTML=`<div class="detail"><b>${esc(a.agent)}</b> - status ${esc(a.status)}, measured time ${a.latency_ms} ms on this run. <b>The payload it handed to the next agent:</b><pre class="jsonbox">${esc(JSON.stringify(a.evidence,null,2))}</pre></div>`;
  document.querySelectorAll("#agent-pipe .anode").forEach((n,j)=>n.classList.toggle("active",j===i));
  $("agent-inspect").scrollIntoView({behavior:"smooth",block:"nearest"});
}
/* v23 tour, Step 2: the flagship evidence opens itself. The hero match
   (the dispute claim if there is one, else the first exact posting) is
   expanded with its derivation, the first why-not counterfactual is
   run so the proof is on screen, and the Matching Agent's payload is
   open in the swimlane. Guards keep it from ever overriding a person:
   it only fills an EMPTY detail pane, only on the Run view, and never
   under the exceptions filter (that visitor came for the exceptions). */
let HERO_SEQ=0;
function scheduleHero(mode){
  const seq=++HERO_SEQ;
  const d=$("match-detail"); if(d) delete d.dataset.whyrun;
  setTimeout(()=>{ if(seq===HERO_SEQ) autoExpandHero(mode) },420);
  setTimeout(()=>{ if(seq===HERO_SEQ) autoInspectMatching() },1800);
}
function autoExpandHero(mode){
  if(CURVIEW!=="run"||RUN_FILTER) return;
  const detail=$("match-detail"); if(!detail||detail.innerHTML.trim()) return;
  let idx=-1;
  if(mode==="stored"&&lastMatches&&lastMatches.length){
    idx=lastMatches.findIndex(m=>(((m.result||{}).deduction||{}).autonomous_action==="AUTO_GENERATE_DISPUTE_CLAIM"));
    if(idx<0) idx=lastMatches.findIndex(m=>m.status==="AUTO_POSTED"&&(((m.result||{}).lines||[]).length));
    if(idx<0) idx=lastMatches.findIndex(m=>(((m.result||{}).lines||[]).length));
    if(idx<0) return;
    storedDetail(idx,true);
  }else if(mode==="live"&&lastRun&&lastRun.results&&lastRun.results.length){
    const rs=lastRun.results;
    idx=rs.findIndex(r=>((r.deduction||{}).autonomous_action==="AUTO_GENERATE_DISPUTE_CLAIM"));
    if(idx<0) idx=rs.findIndex(r=>r.auto_posted&&(r.lines||[]).length);
    if(idx<0) idx=rs.findIndex(r=>(r.lines||[]).length);
    if(idx<0) return;
    liveDetail(idx,true);
  }else return;
  setTimeout(()=>autoWhyNot(0),520);
}
function autoWhyNot(tries){
  if(CURVIEW!=="run") return;
  const d=$("match-detail"); if(!d||d.dataset.whyrun) return;
  const out=$("why-out");
  if(out&&out.innerHTML.trim()){ d.dataset.whyrun="1"; return }
  const btns=[...d.querySelectorAll("button")];
  const b=btns.find(x=>/^Why not /.test(x.textContent))||btns.find(x=>/^Why was another/.test(x.textContent));
  if(b){ d.dataset.whyrun="1"; b.click(); return }
  if((tries||0)<6) setTimeout(()=>autoWhyNot((tries||0)+1),400);
}
function autoInspectMatching(){
  if(CURVIEW!=="run"||!PIPE_DATA.length) return;
  const ai=$("agent-inspect"); if(!ai||ai.innerHTML.trim()) return;
  const i=PIPE_DATA.findIndex(a=>a.agent==="Matching Agent"); if(i<0) return;
  const a=PIPE_DATA[i];
  ai.innerHTML=`<div class="detail"><b>${esc(a.agent)}</b> - status ${esc(a.status)}, measured time ${a.latency_ms} ms on this run. <b>The payload it handed to the next agent:</b><pre class="jsonbox">${esc(JSON.stringify(a.evidence,null,2))}</pre></div>`;
  document.querySelectorAll("#agent-pipe .anode").forEach((n,j)=>n.classList.toggle("active",j===i));
}
let CUR_RESID=0, CUR_PAY=null;
function detailExtras(r,pay){
  CUR_PAY=pay||null;
  const rej=((r.reasoning||{}).rejections||[]).filter(x=>x.invoice_id);
  let why="";
  if(rej.length&&pay){
    why=`<div class="detail"><b>Counterfactual - why these invoices were not picked.</b> Each button re-runs the solver with that invoice forced into the set and reports the exact cost of forcing it.<br><br>${rej.map(x=>`<button class="btn ghost small" data-pid="${esc(r.payment_id)}" data-iid="${esc(x.invoice_id)}" onclick="whyNotDirect(this.dataset.pid,this.dataset.iid,this)">Why not ${esc(x.invoice_id)} (${money(x.amount_cents)})?</button>`).join(" ")}</div><div id="why-out"></div>`;
  } else if(rej.length){
    why=`<div class="detail"><b>Why the other invoices were not picked</b> - from this match's recorded reasoning:<br>${rej.map(x=>"• "+esc(x.text)).join("<br>")}</div>`;
  } else if(pay){
    why=`<p><button class="btn ghost small" data-pid="${esc(r.payment_id)}" onclick="whyNot(this.dataset.pid,this)">Why was another invoice not picked? (counterfactual)</button> <span id="why-slot"></span></p><div id="why-out"></div>`;
  }
  return why+erpDrawer(r);
}
async function whyNotDirect(pid,invId,btn){
  const pay=(CUR_PAY&&CUR_PAY.payment_id===pid)?CUR_PAY:(seedPayments||[]).find(p=>p.payment_id===pid);
  const out=$("why-out"); if(!pay||!out) return;
  btn.disabled=true;
  try{ const o=await api("/api/v1/why-not",{method:"POST",body:JSON.stringify({payment:pay,invoice_id:invId})});
    if(o.reason==="already_matched"){ out.innerHTML=`<div class="detail"><b>${esc(invId)}</b> is part of the set the solver chose.</div>`; return }
    if(o.reason==="not_in_candidate_set"){ out.innerHTML=`<div class="detail"><b>${esc(invId)}</b> never entered this payment's candidate shortlist - the Linking Agent's rungs excluded it before the solver ran, so there was nothing to force. ${esc(o.explanation||"")}</div>`; return }
    const solo=o.solo_residual_cents||0;
    const pen=Math.abs(solo)*1000000;
    out.innerHTML=`<div class="detail"><b>Why not ${esc(invId)}?</b><br>Forcing ${esc(invId)} (${money(o.invoice_gross_cents||0)}) into this payment leaves <b>${money(solo)}</b> of the wire unexplained. The solver charges <b>1,000,000 objective units per cent</b> of unexplained cash, so that single choice adds <b>${pen.toExponential(2)}</b> objective units - against a chosen set that leaves <b>${money(CUR_RESID)}</b> unexplained. No rearrangement containing ${esc(invId)} reaches the chosen set's cost, which is why the optimiser excludes it.<br><small>${esc(o.explanation||"")}</small></div>`;
  }catch(e){ out.innerHTML=`<div class="detail">${esc(e.message)}</div>` } finally{ btn.disabled=false }
}
let ERP_RES={};
function erpDrawer(r){
  const lines=r.lines||[]; if(!lines.length) return "";
  ERP_RES[r.payment_id]=r;
  return `<p><button class="btn ghost small" data-pid="${esc(r.payment_id)}" onclick="erpToggle(this,this.dataset.pid)">ERP posting document (SAP S/4HANA style, built by erp_sap.py)</button></p><div hidden class="erpbody"><div class="detail"><small>Loading the posting document from the server...</small></div></div>`;
}
async function erpToggle(btn,pid){
  const box=btn.parentElement.nextElementSibling;
  box.hidden=!box.hidden;
  if(box.hidden||box.dataset.done) return;
  box.dataset.done="1";
  try{ const d=await api(`/api/v1/payments/${encodeURIComponent(pid)}/erp-document`); box.innerHTML=erpServerHtml(d); }
  catch(e){ const r=ERP_RES[pid]; box.innerHTML=r?erpClientHtml(r):`<div class="detail">The server document could not be loaded (${esc(e.message)}).</div>`; }
}
function erpServerHtml(d){
  const doc=d.document, j=doc.journal;
  const rows=j.map(l=>`<tr><td>${l.gl_account}</td><td>${esc(l.account)}</td><td>${l.debit_cents?money(l.debit_cents):""}</td><td>${l.credit_cents?money(l.credit_cents):""}</td></tr>`).join("");
  let rev="";
  if(d.revrec_accrual){ const a=d.revrec_accrual;
    rev=`<p style="margin-top:10px"><b>Revenue recognition (ASC 606 / IFRS 15, event-based):</b> ${esc(a.note)}</p><table><tr><th>GL</th><th>Account</th><th>Debit</th><th>Credit</th></tr>${a.journal.map(l=>`<tr><td>${l.gl_account}</td><td>${esc(l.account)}</td><td>${l.debit_cents?money(l.debit_cents):""}</td><td>${l.credit_cents?money(l.credit_cents):""}</td></tr>`).join("")}</table>`; }
  return `<div class="detail"><b>${doc.document_number?`ERP document ${esc(doc.document_number)} - staged for SAP posting; nothing has been posted to an ERP.`:"Posting preview - not a posting."}</b> Document type DZ (customer payment), generated on the server by <span class="mono">erp_sap.py</span> from this match's own derivation, so every amount is this payment's real money.<table><tr><th>GL</th><th>Account</th><th>Debit</th><th>Credit</th></tr>${rows}<tr><td></td><td><b>Totals</b></td><td><b>${money(doc.total_debits_cents)}</b></td><td><b>${money(doc.total_credits_cents)}</b></td></tr></table>${doc.balanced?pill("debits equal credits","ok"):pill("does not balance","bad")}<p style="margin-top:8px"><small>${esc(doc.note)}</small></p>${rev}<p><button class="btn ghost small" onclick="const p=this.nextElementSibling;p.hidden=!p.hidden">BAPI_ACC_DOCUMENT_POST payload</button><pre class="jsonbox" hidden>${esc(JSON.stringify(doc.bapi_payload,null,2))}</pre></p></div>`;
}
function erpClientHtml(r){
  const lines=r.lines||[]; if(!lines.length) return "";
  const gross=lines.reduce((a,l)=>a+l.gross_cents,0), disc=lines.reduce((a,l)=>a+(l.discount_cents||0),0), net=lines.reduce((a,l)=>a+l.net_cents,0);
  const eq=(r.derivation||{}).equation||{};
  const payAmt=eq.payment_cents!=null?eq.payment_cents:net, dedA=eq.deduction_applied_cents||0, resid=r.residual_cents||0;
  const rows=[["113100","Cash - operating account",payAmt,0]];
  if(disc)rows.push(["415000","Sales discounts allowed",disc,0]);
  if(dedA)rows.push(["529000","Deductions accepted (within policy)",dedA,0]);
  if(resid<0)rows.push(["121600","Residual receivable - part-paid invoices",-resid,0]);
  rows.push(["121000","Trade receivables - customer control",0,gross]);
  if(resid>0)rows.push(["121900","Unapplied cash - customer on-account",0,resid]);
  const dr=rows.reduce((a,x)=>a+x[2],0), cr=rows.reduce((a,x)=>a+x[3],0);
  const ded=r.deduction, dispute=ded&&ded.autonomous_action==="AUTO_GENERATE_DISPUTE_CLAIM";
  const ap=r.approval||{};
  return `<div class="detail"><b>Posting preview - not a posting.</b> (Built in the browser for this view, because this match was produced by a clean-room use-case run and is not stored on the server.) Document type DZ (customer payment), generated from this match's own derivation, so every amount below is this payment's real money.${ap.erp_document_id?` <b>Document ${esc(ap.erp_document_id)}</b> - issued when this match was approved, derived from the approval's audit fingerprint, so the decision and this document can be tied together.`:""} The chart of accounts is an illustrative template in SAP style; no ERP is connected and nothing has been posted anywhere.<table><tr><th>GL</th><th>Account</th><th>Debit</th><th>Credit</th></tr>${rows.map(x=>`<tr><td>${x[0]}</td><td>${x[1]}</td><td>${x[2]?money(x[2]):""}</td><td>${x[3]?money(x[3]):""}</td></tr>`).join("")}<tr><td></td><td><b>Totals</b></td><td><b>${money(dr)}</b></td><td><b>${money(cr)}</b></td></tr></table>${dr===cr?pill("debits equal credits","ok"):pill("does not balance","bad")}${dispute?`<p style="margin-top:10px"><b>Revenue recognition note (ASC 606 / IFRS 15, event-based):</b> this match carries a disputed deduction of <b>${money(ded.claimed_cents||0)}</b> (${esc(ded.assigned_erp_reason_code||"")}). The claim is carried as a disputed receivable (GL 121500) in the dispute ledger rather than netted against revenue, so the transaction price is not understated by a deduction whose validity is still being contested. The variable consideration resolves when the dispute closes - it is not guessed at month-end.</p>`:""}</div>`;
}
function liveDetail(i,quiet){
  const r=lastRun.results[i];
  CUR_RESID=r.residual_cents||0;
  const lines=r.lines.map(l=>`<tr><td>${esc(l.invoice_id)}</td><td>${money(l.gross_cents)}</td><td>${money(l.discount_cents)}</td><td>${money(l.net_cents)}</td></tr>`).join("");
  const ded=r.deduction?`<div class="detail"><b>Deduction intelligence:</b> classified <b>${esc(r.deduction.classification?.label||"")}</b> (${esc(r.deduction.assigned_erp_reason_code||"")}), z-score ${r.deduction.z_score}, win probability ${r.deduction.win_probability??"n/a"}, expected recovery $${r.deduction.expected_recovery_value_usd} - decision: <b>${esc(r.deduction.autonomous_action)}</b>.<br><small>${esc(r.deduction.win_probability_basis||r.deduction.note||"")}</small>${(r.deduction.derivation||[]).length?`<br><b>Step by step:</b><br>${r.deduction.derivation.map(x=>"• "+esc(x)).join("<br>")}`:""}</div>`:"";
  const pay=(seedPayments||[]).find(p=>p.payment_id===r.payment_id);
  $("match-detail").innerHTML=`<div class="panel"><h3>Match evidence - ${esc(r.payment_id)}</h3><div class="detail">Status <b>${esc(r.status)}</b>, matched by <b>${esc(r.matched_by)}</b>, auto-posted: <b>${r.auto_posted?"yes":"no"}</b>, residual <b>${money(r.residual_cents)}</b>, confidence <b>${Number(r.confidence).toFixed(3)}</b>.</div>${lines?`<table><tr><th>Invoice</th><th>Gross</th><th>Discount</th><th>Net applied</th></tr>${lines}</table>`:"<small>No invoice lines.</small>"}${reasoningHtml(r)}${derivationHtml(r.derivation)}${ded}${detailExtras(r,pay)}</div>`;
  if(!quiet){ $("match-detail").scrollIntoView({behavior:"smooth",block:"nearest"}); scheduleApprovalsJump(2800); }
}
async function whyNot(pid,btn){
  const pay=(seedPayments||[]).find(p=>p.payment_id===pid); if(!pay)return;
  const inv=await api("/api/v1/invoices");
  const notPicked=inv.find(i=>true);
  const others=prompt("Invoice ID to test (e.g. INV-1003):", notPicked?notPicked.invoice_id:"");
  if(!others)return;
  btn.disabled=true;
  try{const out=await api("/api/v1/why-not",{method:"POST",body:JSON.stringify({payment:pay,invoice_id:others})});
    $("why-out").innerHTML=`<div class="detail"><b>Why not ${esc(others)}?</b><br>${esc(out.explanation||JSON.stringify(out))}</div>`;
  }catch(e){$("why-out").innerHTML=`<div class="detail">${esc(e.message)}</div>`}finally{btn.disabled=false}
}

/* ---------- Upload center ---------- */
const SAMPLE_INV=`invoice_id,customer,amount,po_number,discount_rate,age_days,due_in_days
INV-2001,Apex Manufacturing,120.00,PO-11,0,40,-40
INV-2002,Apex Manufacturing,80.00,PO-12,0,5,-5
INV-2003,Apex Manufacturing,200.00,PO-13,0,30,-30
INV-2004,Northwind Traders,1000.00,PO-21,0.02,25,-25`;
const SAMPLE_PAY=`payment_id,payer,amount,remittance,deduction,deduction_reason
Y1,Apex Manufacturing,200.00,"Wire for INV-2001 and INV-2002",,
Y2,Northwind Traders,930.00,"Northwind Traders wire less 2% discount less deduction",50.00,shortage on delivery`;
const TPL_INV=`invoice_id,customer,amount,po_number,discount_rate,age_days,due_in_days\n`;
const TPL_PAY=`payment_id,payer,amount,remittance,deduction,deduction_reason\n`;
function fillSample(k){$(k==="inv"?"csv-inv":"csv-pay").value=k==="inv"?SAMPLE_INV:SAMPLE_PAY;toast("Sample loaded - now press the import button")}
function downloadTemplate(k){
  const blob=new Blob([k==="inv"?TPL_INV:TPL_PAY],{type:"text/csv"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=k==="inv"?"slatematch_invoices_template.csv":"slatematch_payments_template.csv";a.click();URL.revokeObjectURL(a.href);
}
function wireDrop(dropId,fileId,taId,kind){
  const d=$(dropId),f=$(fileId);
  d.onclick=()=>f.click();
  f.onchange=()=>{if(f.files[0])routeFile(f.files[0],kind,taId)};
  d.ondragover=e=>{e.preventDefault();d.classList.add("over")};
  d.ondragleave=()=>d.classList.remove("over");
  d.ondrop=e=>{e.preventDefault();d.classList.remove("over");if(e.dataTransfer.files[0])routeFile(e.dataTransfer.files[0],kind,taId)};
}
function readFile(file,taId){const r=new FileReader();r.onload=()=>{$(taId).value=r.result;toast("File loaded: "+file.name)};r.readAsText(file)}
function fileToB64(file){return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(String(r.result).split(",")[1]||"");r.onerror=rej;r.readAsDataURL(file)})}
function routeFile(file,kind,taId){
  const name=(file.name||"").toLowerCase();
  if(kind==="invoices"&&/\.(csv|txt)$/.test(name)){ readFile(file,taId); return }
  sendFileImport(file,kind);
}
async function sendFileImport(file,kind){
  const outEl=$(kind==="invoices"?"up-inv-out":"up-pay-out");
  try{
    const b64=await fileToB64(file);
    const d=await api("/api/v1/import/file",{method:"POST",body:JSON.stringify({kind,filename:file.name,content_b64:b64,mode:"replace"})});
    if(kind==="invoices"){
      outEl.innerHTML=`<div class="msg"><b>${d.imported} invoices imported</b> from ${esc(file.name)} - the workspace was replaced with this ledger. The full book is on the Ledger page.</div>${quarantine(d.errors)}`;
      await refreshWorkspace(); toast("Invoices imported into the workspace");
    } else if(d.route==="csv"){
      let runHtml="<small>No valid payment rows to reconcile.</small>";
      if(d.run){lastRun=d.run;runHtml=`<div class="msg">Reconciled as run <b>${esc(d.run.run_id)}</b>: ${d.run.auto_posted} of ${d.run.payments} auto-posted, touchless <b>${(d.run.touchless_rate*100).toFixed(1)}%</b>. Taking you to Run Reconciliation to inspect every match and exception.</div>`}
      outEl.innerHTML=`<div class="msg"><b>${d.imported} payments imported and reconciled</b> from ${esc(file.name)}. Source fingerprint <small>${esc(d.fingerprint)}</small>.<br><br>${mappingChips(d.mapping)}</div>${quarantine(d.errors)}${runHtml}`;
      await refreshWorkspace(); toast("Payments reconciled - opening the run");
      if(d.run){ setTimeout(()=>{ go("run"); renderRun(d.run); renderGradeFromResults(d.run); scheduleApprovalsJump(1400); },700) }
    } else {
      const f=d.fields||{}; const v=d.verification||{};
      const refs=[...(f.invoice_refs||[]),...(f.po_refs||[])];
      outEl.innerHTML=`<div class="msg"><b>Remittance read from ${esc(file.name)}</b> (${esc(d.extracted_via)}) and staged as <b>${esc(d.staged)}</b>: ${esc(f.payer||"Unknown payer")}, <b>${money(f.amount_cents||0)}</b>, references ${refs.length?refs.map(esc).join(", "):"none found"}. ${v.verified?pill("References verified against the ledger","ok"):pill("Some references are not in the ledger - flagged, never guessed","warn")} ${pill(d.source==="gemini"?"Extracted by Gemini":"Deterministic extraction - "+aiWhy(d),"info")}<br><br>Staged in the workspace - run it from the banner above or the Run page, with the rest of the case.</div>`;
      await refreshWorkspace(); showHandoff();
    }
  }catch(e){ outEl.innerHTML=`<div class="msg">${esc(e.message)}</div>` }
}
wireDrop("drop-inv","file-inv","csv-inv","invoices"); wireDrop("drop-pay","file-pay","csv-pay","payments");
function mappingChips(m){const e=Object.entries(m||{});return e.length?e.map(([k,v])=>pill(`${esc(v)} → ${esc(k)}`,"info")).join(" "):"<small>No headers mapped.</small>"}
function quarantine(errs){return errs&&errs.length?`<p><b>Quarantined rows (${errs.length}):</b></p><table><tr><th>Row</th><th>Error</th></tr>${errs.map(e=>`<tr><td>${e.row}</td><td>${esc(e.error)}</td></tr>`).join("")}</table>`:""}
async function importInvoices(btn,mode){
  mode=mode||"replace";
  const text=$("csv-inv").value.trim(); if(!text){toast("Paste or drop an invoices CSV first");return}
  btn.disabled=true;
  try{const d=await api("/api/v1/invoices/import",{method:"POST",body:JSON.stringify({csv_text:text,mode})});
    const inv=await api("/api/v1/invoices");
    const rows=inv.slice(0,10).map(i=>`<tr><td>${esc(i.invoice_id)}</td><td>${esc(i.customer)}</td><td>${esc(i.subsidiary||"-")}</td><td>${esc(i.po_number||"-")}</td><td>${money(i.gross_cents)}</td><td>${i.discount_rate?(i.discount_rate*100)+"%":"-"}</td><td>${i.age_days}</td><td>${i.due_in_days<0?pill("Overdue "+Math.abs(i.due_in_days)+"d","warn"):pill("Open","grey")}</td><td>${i.predicted_delay_days??"-"}</td></tr>`).join("");
    $("up-inv-out").innerHTML=`<div class="msg"><b>${d.imported} invoices imported</b> - ${d.mode==="replace"?"the workspace was replaced with this ledger":"the rows were added to the active ledger"}; the workspace now holds <b>${inv.length} open invoices</b>. Source fingerprint <small>${esc(d.fingerprint)}</small>.<br><br>${mappingChips(d.mapping)}</div>${quarantine(d.errors)}${inv.length?`<table class="staged-t"><tr><th>Invoice</th><th>Customer</th><th>Subsidiary</th><th>PO</th><th>Gross</th><th>Discount</th><th>Age (d)</th><th>State</th><th>Pred. delay <span data-info="preddelay"></span></th></tr>${rows}</table><small>First 10 shown - the full ledger is on the Ledger page. Now import payments, or run what is staged.</small>`:""}`;
    await refreshWorkspace(); toast("Invoices imported into the workspace");
  }catch(e){$("up-inv-out").innerHTML=`<div class="msg">${esc(e.message)}</div>`}finally{btn.disabled=false}
}
async function importPayments(btn){
  const text=$("csv-pay").value.trim(); if(!text){toast("Paste or drop a payments CSV first");return}
  btn.disabled=true;
  try{const d=await api("/api/v1/payments/import",{method:"POST",body:JSON.stringify({csv_text:text})});
    let runHtml="<small>No valid payment rows to reconcile.</small>";
    if(d.run){lastRun=d.run;runHtml=`<div class="msg">Reconciled as run <b>${esc(d.run.run_id)}</b>: ${d.run.auto_posted} of ${d.run.payments} auto-posted, touchless <b>${(d.run.touchless_rate*100).toFixed(1)}%</b>. Taking you to Run Reconciliation to inspect every match and exception.</div>`}
    $("up-pay-out").innerHTML=`<div class="msg"><b>${d.imported} payments imported and reconciled.</b> Source fingerprint <small>${esc(d.fingerprint)}</small>.<br><br>${mappingChips(d.mapping)}</div>${quarantine(d.errors)}${runHtml}`;
    await refreshWorkspace(); toast("Payments reconciled - opening the run");
    if(d.run){ setTimeout(()=>{ go("run"); renderRun(d.run); renderGradeFromResults(d.run); scheduleApprovalsJump(1400); },700) }
  }catch(e){$("up-pay-out").innerHTML=`<div class="msg">${esc(e.message)}</div>`}finally{btn.disabled=false}
}

/* ---------- Use cases ---------- */
async function loadCases(){
  try{const list=await api("/api/v1/scenarios");
    $("case-grid").innerHTML=list.map(s=>`<div class="panel scen"><h3>${esc(s.title)}</h3><div style="margin:2px 0 8px">${pill(`${s.invoices} invoices`,"info")} ${pill(`${s.payments} payments`,"info")} ${pill(`${s.customers} customers`,"info")} ${pill(`${money(s.open_cents)} open AR`,"grey")} ${pill(`${money(s.batch_cents)} batch`,"grey")}</div><div class="story">${esc(s.story)}</div><div class="shows"><b>What it proves:</b> ${esc(s.shows)}</div><p style="margin:8px 0 0"><button class="btn small" data-cid="${esc(s.id)}" onclick="loadCase(this.dataset.cid,this)">Stage Case (Inspect Before Run)</button> <button class="btn small ghost" data-cid="${esc(s.id)}" onclick="loadCaseAndRun(this.dataset.cid,this)">Stage &amp; Run Now</button></p></div>`).join("");
  }catch(e){$("case-grid").innerHTML="<small>Could not load use cases.</small>"}
}
async function runCase(sid,btn){
  btn.disabled=true; btn.textContent="Running...";
  try{const d=await api(`/api/v1/scenarios/${sid}/run`,{method:"POST"});
    const checks=d.checks.map(c=>`<tr><td>${esc(c.label)}</td><td>${esc(JSON.stringify(c.expected))}</td><td>${esc(JSON.stringify(c.actual))}</td><td class="${c.pass?"p":"f"}">${c.pass?"PASS":"FAIL"}</td></tr>`).join("");
    $("case-out").innerHTML=`<div class="panel"><h3>${esc(d.scenario.title)} <span data-info="verdict"></span></h3><div class="verdict ${d.all_pass?"pass":"fail"}">${d.all_pass?"All checks passed - the engine did exactly what this use case promises.":"Some checks failed - the evidence below is the honest result."}</div>
    <table class="checks"><tr><th>Check</th><th>Expected</th><th>Actual</th><th>Verdict <span data-info="verdict"></span></th></tr>${checks}</table>
    <p><small>Run ${esc(d.run.run_id)} - ${d.run.payments} payments, ${d.run.auto_posted} auto-posted, ${d.run.exceptions.length} exceptions.</small></p></div>`;
    fillInfo();
    $("case-out").scrollIntoView({behavior:"smooth"});
  }catch(e){toast("Scenario failed: "+e.message)}finally{btn.disabled=false;btn.textContent="Run this use case"}
}

