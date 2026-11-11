/* insight.js - INSIGHT views: Ledger, Forecast and Collections,
   Evaluations, Agent Health, diagnostics, tenants and the in-app
   product-document reader. */
/* ---------- Ledger / forecast / evaluations / health ---------- */
async function loadLedger(){
  try{const [inv,fc]=await Promise.all([api("/api/v1/invoices"),api("/api/v1/forecast")]);
    const fmap={};(fc.invoices||[]).forEach(d=>fmap[d.invoice_id]=d);
    $("l-count").textContent=inv.length;
    $("l-total").textContent=money(inv.reduce((a,i)=>a+i.gross_cents,0));
    $("l-over").textContent=money(inv.filter(i=>i.due_in_days<0).reduce((a,i)=>a+i.gross_cents,0));
    LEDGER_INVS=inv;
    $("ledger-t").innerHTML=inv.length?`<table><tr><th>Invoice <span data-info="invid"></span></th><th>Customer <span data-info="cust"></span></th><th>Subsidiary <span data-info="cust"></span></th><th>PO <span data-info="po"></span></th><th>Amount <span data-info="amt"></span></th><th>Discount <span data-info="disc"></span></th><th>Age (d) <span data-info="age"></span></th><th>Due in (d) <span data-info="due"></span></th><th>Pred. delay <span data-info="preddelay"></span></th><th>Expected in</th><th>State <span data-info="state"></span></th></tr>${inv.map((i,ix)=>{const d=fmap[i.invoice_id];const risk=d&&(d.expected_in_days>45||d.prob_within_horizon<0.5);return `<tr><td>${esc(i.invoice_id)}</td><td>${esc(i.customer)}</td><td>${esc(i.subsidiary||"-")}</td><td>${esc(i.po_number||"-")}</td><td class="editcell" title="Click to correct this invoice's amount in place" onclick="editInvAmount(${ix},this)">${money(i.gross_cents)}${i.partial?`<br><small>Partial: ${money(i.partial.applied_cents)} applied of ${money(i.partial.original_cents)}</small>`:""}</td><td class="editcell" title="Click to correct the discount % in place" onclick="editInvDiscount(${ix},this)">${i.discount_rate? (i.discount_rate*100)+"%":"-"}</td><td>${i.age_days}</td><td>${i.due_in_days}</td><td>${d?d.predicted_delay_days+"d":"-"}</td><td>${d?(d.expected_week?(d.expected_in_days<=0?"Due now":Math.round(d.expected_in_days)+"d")+" - Wk "+d.expected_week:"Beyond 8 wks"):"-"}</td><td>${i.partial?pill("Partially paid","info")+" ":""}${i.due_in_days<0?pill("Overdue "+Math.abs(i.due_in_days)+"d","warn"):pill("Open","grey")}${risk?" "+pill("At risk","bad"):""}</td></tr>`}).join("")}</table><small>LiveCube grid: click an Amount or Discount % cell to correct it in place, then re-run the solver from the staged payments panel below. An invoice a posted match already settled refuses the edit - that refusal is the control.</small>`:"<small>The ledger is empty. Load a case or import invoices from the Upload Center.</small>";
    renderCube(inv);
    renderLedgerStaged();
  }catch(e){toast(e.message)}
}
async function renderLedgerStaged(){
  const el=$("ledger-staged"); if(!el) return;
  const ws=WS||await refreshWorkspace(); if(!ws){ el.innerHTML="<small>No workspace.</small>"; return }
  const pays=ws.all_payments||[];
  if(!pays.length){ el.innerHTML="<small>Nothing staged. Load a case or import payments in the Upload Center and they appear here, ready to run.</small>"; return }
  const pend=new Set((ws.pending_payments||[]).map(p=>p.payment_id));
  LEDGER_PAYS=pays;
  el.innerHTML=`<table class="staged-t"><tr><th>Payment</th><th>Payer</th><th>Amount</th><th>References</th><th>Remittance text</th><th>State</th></tr>${pays.map((p,ix)=>`<tr><td>${esc(p.payment_id)}</td><td>${esc(p.payer_raw)}</td><td class="editcell" title="Click to correct this wire's amount in place" onclick="editPayAmount(${ix},this)">${money(p.amount_cents)}</td><td class="editcell" title="Click to correct the references in place" onclick="editPayRefs(${ix},this)">${(p.references||[]).map(esc).join(", ")||"<small>none</small>"}</td><td class="editcell" title="Click to correct the remittance text - on save, its references are re-extracted from the text" onclick="editPayRemit(${ix},this)"><small>${esc((p.remittance_text||"").slice(0,90))||"<small>none</small>"}</small></td><td>${pend.has(p.payment_id)?pill("Staged - waiting to run","warn"):pill("Run - results on the Run page","ok")}</td></tr>`).join("")}</table>${LEDGER_DIRTY?`<p><button class="btn" onclick="updateAndRerun(this)">Update &amp; Re-Run Solver</button> <small>${LEDGER_DIRTY} edit(s) saved to the ledger - the matches still reflect the old values until you re-run.</small></p>`:""}<small>${pays.length} payments in the active case: ${pend.size} waiting to run, ${pays.length-pend.size} already run. Click an Amount, References or Remittance cell to correct it in place; a payment a posted match settled refuses the edit.</small>`;
}
/* ---- v25: LiveCube inline editing ----
   Click a value, correct it, save. The save goes to the PATCH endpoints
   (which refuse settled records), the grid re-renders, and the Re-Run
   bar appears: matches recompute only when the solver re-runs, and the
   UI says so rather than pretending the edit changed history. */
let LEDGER_DIRTY=0, LEDGER_INVS=[], LEDGER_PAYS=[];
function cellEdit(td, value, save, area){
  if(td.dataset.editing) return; td.dataset.editing="1";
  const old=td.innerHTML; td.innerHTML="";
  const inp=document.createElement(area?"textarea":"input");
  inp.value=value; inp.style.width=area?"280px":"120px"; if(area) inp.rows=3;
  const saveB=document.createElement("button"); saveB.className="btn small"; saveB.textContent="Save";
  const cxB=document.createElement("button"); cxB.className="btn small ghost"; cxB.textContent="Cancel";
  td.append(inp, document.createTextNode(" "), saveB, document.createTextNode(" "), cxB);
  inp.focus(); if(inp.select) inp.select();
  cxB.onclick=ev=>{ ev.stopPropagation(); td.innerHTML=old; delete td.dataset.editing; };
  saveB.onclick=async ev=>{ ev.stopPropagation(); saveB.disabled=true;
    try{ await save(inp.value); LEDGER_DIRTY++; toast("Saved to the ledger. Re-run the solver to recompute the matches on the corrected values."); delete td.dataset.editing; loadLedger(); }
    catch(e){ toast("Edit refused: "+e.message); td.innerHTML=old; delete td.dataset.editing; } };
}
function editInvAmount(ix,td){ const i=LEDGER_INVS[ix]; if(!i) return;
  cellEdit(td,(i.gross_cents/100).toFixed(2), async v=>{ const c=Math.round(parseFloat(v)*100); if(!(c>0)) throw new Error("amount must be positive");
    await api(`/api/v1/invoices/${encodeURIComponent(i.invoice_id)}`,{method:"PATCH",body:JSON.stringify({gross_cents:c})}); }); }
function editInvDiscount(ix,td){ const i=LEDGER_INVS[ix]; if(!i) return;
  cellEdit(td, String(Math.round((i.discount_rate||0)*1000)/10), async v=>{ const p=parseFloat(v); if(isNaN(p)||p<0||p>90) throw new Error("discount must be between 0 and 90 percent");
    await api(`/api/v1/invoices/${encodeURIComponent(i.invoice_id)}`,{method:"PATCH",body:JSON.stringify({discount_rate:p/100})}); }); }
function editPayAmount(ix,td){ const p=LEDGER_PAYS[ix]; if(!p) return;
  cellEdit(td,(p.amount_cents/100).toFixed(2), async v=>{ const c=Math.round(parseFloat(v)*100); if(!(c>0)) throw new Error("amount must be positive");
    await api(`/api/v1/payments/${encodeURIComponent(p.payment_id)}`,{method:"PATCH",body:JSON.stringify({amount_cents:c})}); }); }
function editPayRefs(ix,td){ const p=LEDGER_PAYS[ix]; if(!p) return;
  cellEdit(td,(p.references||[]).join(", "), async v=>{ const refs=v.split(",").map(s=>s.trim()).filter(Boolean);
    await api(`/api/v1/payments/${encodeURIComponent(p.payment_id)}`,{method:"PATCH",body:JSON.stringify({references:refs})}); }); }
function editPayRemit(ix,td){ const p=LEDGER_PAYS[ix]; if(!p) return;
  cellEdit(td,p.remittance_text||"", async v=>{ await api(`/api/v1/payments/${encodeURIComponent(p.payment_id)}`,{method:"PATCH",body:JSON.stringify({remittance_text:v})}); }, true); }
async function updateAndRerun(btn){ LEDGER_DIRTY=0; await runStagedNow(btn); }
let FC=null;
async function loadForecast(){ fillInfo(); renderFcDisputes();
  try{const f=await api("/api/v1/forecast");const c=await api("/api/v1/collections");
    const stEl=$("fc-state");
    if(f.state==="empty"||f.state==="loaded_not_run"){
      if(stEl) stEl.innerHTML=f.state==="empty"?`<div class="msg"><b>No active ledger loaded.</b> Load a case or upload CSVs to compute cash forecast.</div>`:stagedGateHtml("forecast");
      $("fc").innerHTML=""; $("col").innerHTML=""; $("fc-cust").innerHTML=""; $("fc-drill").innerHTML="";
      ["fc-k-open","fc-k-30","fc-k-hz","fc-k-risk"].forEach(id=>{const e=$(id); if(e)e.textContent="-"});
      return;
    }
    if(stEl) stEl.innerHTML="";
    if(!f.weeks||!f.weeks.length){$("fc").innerHTML="<small>Every invoice in the book is settled - nothing left to forecast.</small>";$("col").innerHTML="";$("fc-cust").innerHTML="";return}
    FC=f;
    const s=f.summary||{};
    $("fc-k-open").textContent=money(s.open_ar_cents||0);
    $("fc-k-30").textContent=money(s.expected_30_cents||0);
    $("fc-k-hz").textContent=money(s.expected_horizon_cents||0);
    $("fc-k-risk").textContent=money(s.at_risk_cents||0)+" ("+(s.at_risk_count||0)+")";
    const max=Math.max(...f.weeks.map(w=>w.p90_cents),1);
    const step=(640-92)/Math.max(f.weeks.length-1,1);
    const X=i=>46+i*step, Y=v=>190-(v/max)*160;
    const pts=f.weeks.map((w,i)=>[X(i), Y(w.p50_cents)]);
    const top=f.weeks.map((w,i)=>X(i)+","+Y(w.p90_cents));
    const bot=f.weeks.slice().reverse().map(w2=>{const i=f.weeks.indexOf(w2);return X(i)+","+Y(w2.p10_cents)});
    const band=top.concat(bot).join(" ");
    const line=pts.map(p=>p.join(",")).join(" ");
    const beyondRow=f.beyond&&f.beyond.count?`<tr><td><a href="#" onclick="fcDrill(0);return false">Beyond week 8</a></td><td colspan="3"><small>Expected after the horizon - counted in Open receivables, not in the weekly bands.</small></td><td><b>${money(f.beyond.cents)}</b></td><td>-</td><td>${f.beyond.count} - view</td></tr>`:"";
    $("fc").innerHTML=`<svg viewBox="0 0 640 220" style="width:100%;background:var(--bg2);border:1px solid var(--line);border-radius:0"><polygon class="fband" points="${band}" fill="#3d75e8" opacity="0.22"></polygon><polyline class="fdraw" pathLength="1" points="${line}" fill="none" stroke="#7fa6f2" stroke-width="2.5"></polyline>${pts.map((p,i)=>`<circle class="fdot" style="animation-delay:${0.75+i*0.12}s" cx="${p[0]}" cy="${p[1]}" r="4" fill="#3d75e8"></circle><text x="${p[0]-16}" y="212" font-size="11" fill="#a7a49d">Week ${i+1}</text>`).join("")}</svg>
    <table class="fctab"><tr><th>Week <span data-info="week"></span></th><th>P10 (cautious) <span data-info="p10"></span></th><th>P50 (expected) <span data-info="p50"></span></th><th>P90 (optimistic) <span data-info="p90"></span></th><th>Cumulative P50 <span data-info="cump50"></span></th><th>Invoices <span data-info="weekinv"></span></th></tr>${f.weeks.map(w=>`<tr><td>Week ${w.week}</td><td>${money(w.p10_cents)}</td><td><b>${money(w.p50_cents)}</b></td><td>${money(w.p90_cents)}</td><td>${money(w.cumulative_p50_cents)}</td><td>${w.invoice_ids.length?`<a href="#" onclick="fcDrill(${w.week});return false">${w.invoice_ids.length} - view</a>`:"0"}</td></tr>`).join("")}${beyondRow}</table><p><small>Band = P10 to P90 across 400 simulated payment timings per invoice from the delay model (each invoice lands whole in one week per simulation). Click a week's invoice count to see exactly which invoices build that week. Horizon ${f.horizon_days} days.</small></p>`;
    $("fc-drill").innerHTML="";
    $("fc-cust").innerHTML=(f.customers||[]).length?`<table><tr><th>Customer</th><th>Invoices <span data-info="custinv"></span></th><th>Open <span data-info="custopen"></span></th><th>Overdue <span data-info="custover"></span></th><th>Expected 30d <span data-info="exp30"></span></th><th>Expected 8 wks <span data-info="exp8w"></span></th><th>Avg pred. delay <span data-info="avgdelay"></span></th></tr>${f.customers.map(r=>`<tr><td>${esc(r.customer)}</td><td>${r.invoices}</td><td>${money(r.open_cents)}</td><td>${money(r.overdue_cents)}</td><td>${money(r.expected_30_cents)}</td><td>${money(r.expected_horizon_cents)}</td><td>${r.avg_predicted_delay_days}d</td></tr>`).join("")}</table>`:"<small>No customers.</small>";
    const sel=$("wi-cust"); const cur=sel.value;
    sel.innerHTML=(f.customers||[]).map(r=>`<option value="${esc(r.customer)}">${esc(r.customer)}</option>`).join("");
    if(cur)sel.value=cur;
    $("col").innerHTML=c.length?`<table class="fctab"><tr><th>Invoice <span data-info="invid"></span></th><th>Customer <span data-info="cust"></span></th><th>Amount <span data-info="amt"></span></th><th>Overdue <span data-info="overdue"></span></th><th>Pred. delay <span data-info="preddelay"></span></th><th>Priority <span data-info="prio"></span></th><th></th></tr>${c.map(r=>`<tr><td>${esc(r.invoice_id)}</td><td>${esc(r.customer)}</td><td>${money(r.gross_cents)}</td><td>${r.overdue_days}d</td><td>${r.predicted_delay_days}d</td><td><b>${r.priority_score}</b></td><td><button class="mini" data-iid="${esc(r.invoice_id)}" onclick="draftReminder(this.dataset.iid)">Draft reminder</button></td></tr>`).join("")}</table>`:"<small>Nothing to collect.</small>";
  }catch(e){toast(e.message)}
}
function fcDrill(w){
  if(!FC)return;
  const rows=(FC.invoices||[]).filter(d=>w===0?d.expected_week===null:d.expected_week===w)
    .sort((a,b)=>a.expected_in_days-b.expected_in_days);
  $("fc-drill").innerHTML=`<div style="margin-top:12px"><h4>${w===0?"Beyond the 8-week horizon":"Week "+w+" - the invoices inside it"} (${rows.length})</h4>${rows.length?`<table><tr><th>Invoice</th><th>Customer</th><th>Amount</th><th>Expected in</th><th>Chance in 30d <span data-info="chance30"></span></th><th>Chance in horizon <span data-info="chancehz"></span></th></tr>${rows.map(d=>`<tr><td>${esc(d.invoice_id)}</td><td>${esc(d.customer)}</td><td>${money(d.gross_cents)}</td><td>${d.expected_in_days<=0?"Due now":Math.round(d.expected_in_days)+"d"}</td><td>${Math.round(d.prob_within_30*100)}%</td><td>${Math.round(d.prob_within_horizon*100)}%</td></tr>`).join("")}</table>`:"<small>No invoice is expected in this bucket.</small>"}</div>`;
  $("fc-drill").scrollIntoView({behavior:"smooth",block:"nearest"});
  fillInfo();
}
let MC_REF="";
async function draftReminder(invId){
  try{ const d=await api("/api/v1/mail/reminder",{method:"POST",body:JSON.stringify({invoice_id:invId})});
    MC_REF=invId; $("mc-subject").value=d.subject; $("mc-body").value=d.body; $("mc-to").value=""; $("mc-status").innerHTML="";
    const p=$("mail-composer"); p.style.display=""; p.scrollIntoView({behavior:"smooth",block:"nearest"});
  }catch(e){ toast(e.message) }
}
function sendComposerMail(btn){ sendMailGeneric("collection_reminder", MC_REF, $("mc-to").value, $("mc-body").value, "mc-status", btn, $("mc-subject").value) }
async function fcWhatif(){
  const cust=$("wi-cust").value; if(!cust)return;
  const shift=+$("wi-shift").value;
  try{const r=await api("/api/v1/forecast/whatif",{method:"POST",body:JSON.stringify({customer:cust,shift_days:shift})});
    const d30=r.delta_30_cents, dhz=r.delta_cents;
    const fmt=v=>(v>0?"+":v<0?"-":"")+money(Math.abs(v)).replace(".00","");
    const redistributed = (d30===0&&dhz===0&&r.weeks.some(w=>w.shifted_p50_cents!==w.base_p50_cents))?" The 30-day and 8-week totals do not change - the cash moves between weeks, which is what the table below shows.":"";
    $("wi-out").innerHTML=`<p>If <b>${esc(r.customer)}</b> pays <b>${r.shift_days===0?"on the current prediction":Math.abs(r.shift_days)+" days "+(r.shift_days<0?"earlier":"later")}</b>: expected cash in 30 days moves by <b>${fmt(d30)}</b> (to ${money(r.shifted_expected_30_cents)}), and across the 8 weeks by <b>${fmt(dhz)}</b> (to ${money(r.shifted_expected_horizon_cents)}).${redistributed}</p><table><tr><th>Week</th><th>P50 now <span data-info="whatifp50"></span></th><th>P50 shifted <span data-info="whatifp50"></span></th><th>Move <span data-info="whatifmove"></span></th></tr>${r.weeks.map(w=>`<tr><td>Week ${w.week}</td><td>${money(w.base_p50_cents)}</td><td>${money(w.shifted_p50_cents)}</td><td>${fmt(w.shifted_p50_cents-w.base_p50_cents)}</td></tr>`).join("")}</table>`;
    fillInfo();
  }catch(e){toast(e.message)}
}
async function loadEval(){ fillInfo();
  await refreshWorkspace();
  if(WS&&WS.run_status==="staged"){ $("eval-out").innerHTML=stagedGateHtml("evaluations"); return }
  try{const ev=await api("/api/v1/evaluations");
    let caseGrade="";
    const ws=await refreshWorkspace();
    if(ws&&ws.case&&ws.case.expect&&Object.keys(ws.case.expect).length){
      const d=await caseRunData();
      if(d){ caseGrade=gradeHtml(ws.case,normalisedStored(d.matches),d.exceptions,d.run.run_id) }
      else { caseGrade=`<div class="panel"><h3>Case verdict - ${esc(ws.case.name)} <span data-info="verdict"></span></h3><div class="d">This case states its expected outcomes up front, but its payments have not been run in this workspace yet. Run it from Run Reconciliation and the graded verdict will appear here.</div></div>` }
    }
    $("eval-out").innerHTML=caseGrade+`<div class="cards" style="grid-template-columns:repeat(3,1fr)">
    <div class="card"><div class="k">MILP accuracy <span data-info="milpacc"></span></div><div class="v">${(ev.milp_accuracy*100).toFixed(0)}%</div><div class="n">Agreement with human-labelled answers</div></div>
    <div class="card"><div class="k">Greedy accuracy <span data-info="greedyacc"></span></div><div class="v">${(ev.greedy_accuracy*100).toFixed(0)}%</div><div class="n">The fast heuristic baseline</div></div>
    <div class="card"><div class="k">MILP exact rate <span data-info="exactrate"></span></div><div class="v">${(ev.milp_exact_rate*100).toFixed(0)}%</div><div class="n">Solutions reconciling to $0.00 residual</div></div></div>
    <div class="panel"><table><tr><th>Payment <span data-info="payid"></span></th><th>Expected <span data-info="expct"></span></th><th>MILP got <span data-info="milpgot"></span></th><th>Residual <span data-info="resid"></span></th><th>MILP <span data-info="milpcol"></span></th><th>Greedy <span data-info="greedycol"></span></th></tr>
    ${ev.cases.map(c=>`<tr><td>${esc(c.payment_id)}</td><td>${c.expected.join(", ")}</td><td>${c.milp_got.join(", ")}</td><td>${money(c.milp_residual_cents)}</td><td class="${c.milp_correct?"p":"f"}" style="color:${c.milp_correct?"var(--ok)":"var(--bad)"};font-weight:650">${c.milp_correct?"correct":"miss"}</td><td>${c.greedy_correct?"correct":"miss"}</td></tr>`).join("")}</table>
    <p><small>${esc(ev.basis||"")}</small></p></div>
    <div class="panel"><h3>Scenario pack suite <span data-info="scenpack"></span></h3><div class="d">Ten full pipeline cases with their expectations stated up front. Each runs the real pipeline on its own clean ledger - a pack passes only when every stated check passes.</div><div id="eval-scenarios"><small>Running the ten packs...</small></div></div>`;
    renderEvalScenarios();
  }catch(e){toast(e.message)}
}
async function renderEvalScenarios(){
  const el=$("eval-scenarios"); if(!el) return;
  try{
    const packs=await api("/api/v1/scenarios");
    const rows=[];
    for(const p of packs){
      try{
        const r=await api(`/api/v1/scenarios/${encodeURIComponent(p.id)}/run`,{method:"POST"});
        const passed=(r.checks||[]).filter(c=>c.pass).length, total=(r.checks||[]).length;
        rows.push(`<tr><td>${esc(p.title||p.id)}</td><td>${pill(r.all_pass?"Pass":"Fail", r.all_pass?"ok":"bad")}</td><td>${passed} / ${total} checks</td></tr>`);
      }catch(e){ rows.push(`<tr><td>${esc(p.title||p.id)}</td><td colspan="2"><small>Could not run: ${esc(e.message)}</small></td></tr>`); }
    }
    el.innerHTML=`<table><tr><th>Pack</th><th>Verdict</th><th>Checks</th></tr>${rows.join("")}</table>`;
    fillInfo();
  }catch(e){ el.innerHTML="<small>The scenario packs could not be loaded.</small>"; }
}
async function loadHealth(){ fillInfo();
  try{const h=await api("/health");const r=await api("/ready");const m=h.model_metrics||{};
    const imp=m.delay_baseline_mae_days?(((m.delay_baseline_mae_days-m.delay_mae_days)/m.delay_baseline_mae_days)*100).toFixed(0):"-";
    $("health-out").innerHTML=`<div class="cards">
    <div class="card"><div class="k">Service status <span data-info="svcstatus"></span></div><div class="v" style="font-size:20px;padding-top:5px">${pill(h.status==="ok"?"Healthy":"Degraded",h.status==="ok"?"ok":"bad")} ${pill(r.ready?"Ready":"Not ready",r.ready?"ok":"bad")}</div><div class="n">Readiness gate checked live</div></div>
    <div class="card"><div class="k">Auth mode <span data-info="authmode"></span></div><div class="v" style="font-size:20px;padding-top:5px">${esc(h.auth)}</div><div class="n">${h.auth==="dev-open"?"Demo posture: no keys issued yet":"API keys enforced per tenant"}</div></div>
    <div class="card"><div class="k">AI layer <span data-info="ailayer"></span></div><div class="v" style="font-size:15.5px;padding-top:7px;line-height:1.35">${aiModeLabel(h.gemini_configured,h.gemini_last_error)}</div><div class="n">Parser mode is always labelled in its output; the raw provider state stays in diagnostics below</div></div>
    <div class="card"><div class="k">Data directory <span data-info="datadir"></span></div><div class="v" style="font-size:20px;padding-top:5px">${esc(h.data_dir)}</div><div class="n">Per-tenant SQLite stores</div></div></div>
    <div class="panel"><h3>Model quality (held-out, time-ordered) <span data-info="modelq"></span></h3><div class="d">Trained on synthetic history with a learnable signal; graded on rows the models never trained on.</div>
    <table><tr><th>Model <span data-info="model"></span></th><th>Metric <span data-info="metric"></span></th><th>Value <span data-info="mval"></span></th><th>Reference <span data-info="ref"></span></th></tr>
    <tr><td>Payment-delay regressor</td><td>MAE (days) <span data-info="mae"></span></td><td><b>${m.delay_mae_days}</b></td><td>Naive baseline ${m.delay_baseline_mae_days} days - a ${imp}% improvement</td></tr>
    <tr><td>Deduction-validity classifier</td><td>ROC AUC <span data-info="auc"></span></td><td><b>${m.validity_auc}</b></td><td>0.5 is chance; 1.0 is perfect</td></tr>
    <tr><td>Training set</td><td>Rows</td><td>${m.train_rows} train / ${m.test_rows} test</td><td>Time-ordered 80/20 split</td></tr></table>
    <p><small>Data basis: ${esc(m.data_basis||"")}</small></p></div>
    <div class="panel"><h3>Readiness checks <span data-info="ready"></span></h3><table><tr><th>Check <span data-info="chk"></span></th><th>State <span data-info="state"></span></th></tr>${Object.entries(r.checks||{}).map(([k,v])=>`<tr><td>${esc(k)}</td><td>${pill(String(v),v==="ok"?"ok":"bad")}</td></tr>`).join("")}</table></div>
    <div class="panel"><h3>Kernel and test suite health <span data-info="kernelhealth"></span></h3><div id="diag-body"><div class="note">Loading live diagnostics...</div></div></div>`;
    loadDiag();
  }catch(e){toast(e.message)}
}

/* ---------- Diagnostics (kernel, solvers, suite) ---------- */
let DIAG=null;
async function loadDiag(){
  const targets=["diag-body","diag-body-arch"].map(id=>document.getElementById(id)).filter(Boolean);
  if(!targets.length) return;
  try{
    if(!DIAG) DIAG=await api("/api/v1/diagnostics");
    const d=DIAG,k=d.rust_kernel,p=k.equivalence_probe;
    const probe=p.status==="pass"?`Live probe on this server just now: <b>${p.agree} of ${p.cases}</b> cases agree exactly with the Python reference`:p.status==="fail"?`Live probe: ${p.agree} of ${p.cases} cases agree - investigate`:"Skipped on this server - the kernel binary is not present here, so the Python reference path is serving (same results, slower)";
    const html=`
    <div class="diagrow"><b>Rust kernel (rust-kernel, via rust_bridge.py)</b><span>${k.present?pill("ACTIVE","ok"):pill("NOT IN THIS DEPLOYMENT","warn")}</span></div>
    <div class="diagrow"><b>Kernel equivalence</b><span>${probe}</span></div>
    <div class="diagrow"><b>Equivalence suite</b><span>${esc(k.equivalence_suite)}</span></div>
    <div class="diagrow"><b>MILP solver</b><span>${esc(d.milp.solver)} - ${esc(d.milp.exact_recheck)}</span></div>
    <div class="diagrow"><b>Repository test suite</b><span><b>${d.test_suite.module_count}</b> test modules - ${esc(d.test_suite.ci)}</span></div>
    <div class="diagrow"><b>Document store</b><span>The product documents in the header are read live from <span class="mono">docs/</span> in this deployment</span></div>`;
    targets.forEach(t=>t.innerHTML=html);
  }catch(e){targets.forEach(t=>t.innerHTML=`<div class="note">Diagnostics unavailable: ${esc(e.message)}</div>`)}
}

/* ---------- Tenants + product docs ---------- */
async function loadTenants(){
  const sel=$("tenant-switch"); if(!sel) return;
  try{ const d=await api("/api/v1/tenants/demo");
    const chip=$("session-chip"); if(chip) chip.textContent="SESSION "+(d.session||sessionId()).slice(0,8).toUpperCase();
    sel.innerHTML=d.tenants.map(t=>`<option value="${t.id}" ${t.id===d.active?"selected":""}>${esc(t.name)} - ${esc(t.erp)}</option>`).join("");
    sel.disabled=!d.switching_enabled;
    if(!d.switching_enabled) sel.title="Tenant switching is off when API keys are issued - the key decides the tenant";
  }catch(e){ sel.innerHTML=`<option value="demo">Demo workspace - US - SAP S/4HANA</option>`; }
}
async function switchTenant(id){
  if(!id) return;
  localStorage.setItem("slate-tenant",id);
  WS_GEN++;
  WS=null; /* the stale-read guard in refreshWorkspace must not carry the old tenant's state across */
  const sel=$("tenant-switch"); if(sel) sel.value=id;
  sessionStorage.removeItem("slate-empty");
  BRIEF_RUN=null; BRIEF_PROMISE=null; DIAG=null;
  closeApprDrawer(); closeDocs();
  toast("Tenant switched - each tenant has its own database, so this workspace shows only that tenant's data");
  await refreshWorkspace();
  go("dash");
  if(!(WS&&WS.staged_payments>0)) bootAuto();
}
let DOCS_LIST=null;
function openDocs(){ $("docs-drawer").classList.add("on"); if(!DOCS_LIST) loadDocsList(); }
function closeDocs(){ const d=$("docs-drawer"); if(d) d.classList.remove("on"); }
async function loadDocsList(){
  try{ const d=await api("/api/v1/docs"); DOCS_LIST=d.docs||[];
    $("docs-list").innerHTML=DOCS_LIST.map(x=>`<button class="doclink" data-doc="${esc(x.name)}" onclick="readDoc(this.dataset.doc)">${esc(x.title)} <small>${esc(x.name)} - ${(x.bytes/1024).toFixed(1)} KB</small></button>`).join("")||`<div class="note">${esc(d.note||"No documents found in this deployment.")}</div>`;
    if(DOCS_LIST.length) readDoc(DOCS_LIST[0].name);
  }catch(e){ $("docs-list").innerHTML=`<div class="note">${esc(e.message)}</div>`; }
}
async function readDoc(name){
  document.querySelectorAll(".doclink").forEach(b=>b.classList.toggle("on",b.dataset.doc===name));
  $("docs-body").innerHTML='<div class="skl"><i></i><i></i><i></i></div>';
  try{ const d=await api(`/api/v1/docs/${encodeURIComponent(name)}`); $("docs-body").innerHTML=mdRender(d.markdown); }
  catch(e){ $("docs-body").innerHTML=`<div class="note">${esc(e.message)}</div>`; }
}
function mdRender(md){
  const escH=s=>s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  const inline=s=>s.replace(/`([^`]+)`/g,"<code>$1</code>").replace(/\*\*([^*]+)\*\*/g,"<b>$1</b>").replace(/\*([^*\n]+)\*/g,"<i>$1</i>").replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
  const lines=String(md).split("\n"); let html="",i=0;
  const isRow=s=>/^\s*\|.*\|\s*$/.test(s);
  while(i<lines.length){
    const ln=lines[i];
    if(/^```/.test(ln)){ const buf=[]; i++; while(i<lines.length&&!/^```/.test(lines[i])){buf.push(lines[i]);i++;} i++; html+=`<pre><code>${escH(buf.join("\n"))}</code></pre>`; continue; }
    if(isRow(ln)&&i+1<lines.length&&/^\s*\|[\s:|-]+\|\s*$/.test(lines[i+1])){
      const cells=s=>s.trim().replace(/^\||\|$/g,"").split("|").map(c=>inline(escH(c.trim())));
      let t=`<table><tr>${cells(ln).map(c=>`<th>${c}</th>`).join("")}</tr>`; i+=2;
      while(i<lines.length&&isRow(lines[i])){ t+=`<tr>${cells(lines[i]).map(c=>`<td>${c}</td>`).join("")}</tr>`; i++; }
      html+=t+"</table>"; continue; }
    const h=ln.match(/^(#{1,4})\s+(.*)$/);
    if(h){ const lv=h[1].length; html+=`<h${lv}>${inline(escH(h[2]))}</h${lv}>`; i++; continue; }
    if(/^\s*(-{3,}|\*{3,})\s*$/.test(ln)){ html+="<hr>"; i++; continue; }
    if(/^\s*>\s?/.test(ln)){ html+=`<blockquote>${inline(escH(ln.replace(/^\s*>\s?/,"")))}</blockquote>`; i++; continue; }
    if(/^\s*[-*]\s+/.test(ln)){ let it=""; while(i<lines.length&&/^\s*[-*]\s+/.test(lines[i])){ it+=`<li>${inline(escH(lines[i].replace(/^\s*[-*]\s+/,"")))}</li>`; i++; } html+=`<ul>${it}</ul>`; continue; }
    if(/^\s*\d+\.\s+/.test(ln)){ let it=""; while(i<lines.length&&/^\s*\d+\.\s+/.test(lines[i])){ it+=`<li>${inline(escH(lines[i].replace(/^\s*\d+\.\s+/,"")))}</li>`; i++; } html+=`<ol>${it}</ol>`; continue; }
    if(!ln.trim()){ i++; continue; }
    const para=[ln]; i++;
    while(i<lines.length&&lines[i].trim()&&!/^(#{1,4})\s/.test(lines[i])&&!/^\s*[-*]\s+/.test(lines[i])&&!/^```/.test(lines[i])&&!isRow(lines[i])){ para.push(lines[i]); i++; }
    html+=`<p>${inline(escH(para.join(" ")))}</p>`;
  }
  return html;
}


/* ===== v23 tour: Step 4 SAP stage + Step 6 scorecard ===== */
let SAP_DOCS=null, SAP_SEL=0;
async function loadSap(){
  const st=$("sap-state"); if(!st) return;
  try{
    const d=await api("/api/v1/erp/run-documents");
    SAP_DOCS=d;
    if(!d.run_id||!d.documents.length){
      if(WS&&WS.run_status==="staged"){ st.innerHTML=stagedGateHtml("SAP clearing documents"); $("sap-t-docs").textContent="0"; $("sap-t-total").textContent="$0.00"; $("sap-t-reserve").textContent="$0.00"; $("sap-chips").innerHTML=""; $("sap-table").innerHTML=""; $("sap-payload").textContent=""; $("sap-reserve").innerHTML=""; return }
      st.innerHTML=`<div class="emptycase"><b>No posting documents yet.</b><br>The latest run has no cleared payments. Load a case, run it, and every cleared payment's DZ document is generated here.</div>`;
      $("sap-t-docs").textContent="0"; $("sap-t-total").textContent="$0.00";
      $("sap-t-reserve").textContent="$0.00";
      $("sap-chips").innerHTML=""; $("sap-table").innerHTML="<small>No documents.</small>";
      $("sap-payload").textContent="No document selected yet."; $("sap-reserve").innerHTML="<small>No dispute claims in the latest run.</small>";
      return;
    }
    st.innerHTML="";
    $("sap-t-docs").textContent=d.totals.documents;
    $("sap-t-total").textContent=money(d.totals.debit_cents);
    $("sap-t-reserve").textContent=d.reserve?money(d.reserve.claimed_cents):"$0.00";
    $("sap-chips").innerHTML=d.documents.map((x,i)=>`<button class="sapchip ${i===SAP_SEL?"on":""}" onclick="selectSapDoc(${i})">${esc(x.payment_id)}${x.document.document_number?` · ${esc(x.document.document_number)}`:""} - ${esc(x.payer||"")}</button>`).join("");
    if(SAP_SEL>=d.documents.length) SAP_SEL=0;
    renderSapDoc();
    const rv=$("sap-reserve");
    if(d.reserve){
      rv.innerHTML=d.reserve.journals.map(j=>`<p><b>${esc(j.payment_id)}</b> - claim of ${money(j.claimed_cents)} reclassified under ASC 606 / IFRS 15:</p>`+erpGlTable(j.journal.journal)+`<small>${esc(j.journal.note||"")}</small>`).join("");
    } else rv.innerHTML="<small>No dispute claims in the latest run.</small>";
  }catch(e){ st.innerHTML=`<small>Could not load the posting documents: ${esc(e.message)}</small>` }
}
function erpGlTable(journal){
  const byGl={};
  (journal||[]).forEach(l=>{ const k=l.gl_account+"|"+l.account; byGl[k]=byGl[k]||{gl:l.gl_account,name:l.account,dr:0,cr:0}; byGl[k].dr+=l.debit_cents; byGl[k].cr+=l.credit_cents; });
  const rows=Object.values(byGl);
  const td=rows.reduce((a,r)=>a+r.dr,0), tc=rows.reduce((a,r)=>a+r.cr,0);
  return `<table><tr><th>GL account</th><th>Account</th><th>Debit</th><th>Credit</th></tr>${rows.map(r=>`<tr><td>${esc(r.gl)}</td><td>${esc(r.name)}</td><td>${r.dr?money(r.dr):"-"}</td><td>${r.cr?money(r.cr):"-"}</td></tr>`).join("")}<tr><td colspan="2"><b>Total - ${td===tc?"balanced to the cent":"OUT OF BALANCE"}</b></td><td><b>${money(td)}</b></td><td><b>${money(tc)}</b></td></tr></table>`;
}
function renderSapDoc(){
  if(!SAP_DOCS||!SAP_DOCS.documents.length) return;
  const x=SAP_DOCS.documents[SAP_SEL], doc=x.document;
  document.querySelectorAll(".sapchip").forEach((c,i)=>c.classList.toggle("on",i===SAP_SEL));
  $("sap-table").innerHTML=`<p><b>${esc(x.payment_id)}</b> - ${esc(x.payer||"")} - status ${esc(x.status)} - document ${esc(doc.document_number||"preview (a number is issued when a match is approved)")} - ${doc.balanced?pill("Balanced","ok"):pill("Out of balance","bad")}</p>`+erpGlTable(doc.journal);
  $("sap-payload").textContent=JSON.stringify(doc.bapi_payload,null,2);
  $("sap-note").innerHTML=`<small>${esc(doc.note||"")}</small>`;
}
function selectSapDoc(i){ SAP_SEL=i; renderSapDoc(); }
function copySapPayload(btn){
  const t=$("sap-payload").textContent;
  if(navigator.clipboard) navigator.clipboard.writeText(t).then(()=>toast("SAP payload copied"));
  btn.textContent="Copied"; setTimeout(()=>btn.textContent="Copy payload",1500);
}

async function loadScore(){
  const el=$("score-kpis"); if(!el) return;
  const w=WS||await refreshWorkspace();
  if(!w||!w.case){
    el.innerHTML=`<div class="emptycase"><b>Empty workspace.</b><br>This page reports only what the agent has actually done. Load a case and this scorecard fills from its stored runs - it never shows placeholder numbers.</div>`;
    return;
  }
  try{
    const runs=await api("/api/v1/runs");
    if(!runs.length){ el.innerHTML=`<div class="emptycase"><b>No runs yet.</b><br>The case is staged; run it from Run Reconciliation and the scorecard computes from the stored run.</div>`; return }
    const latest=runs[0];
    const matches=await api(`/api/v1/runs/${latest.run_id}/matches`);
    const decided=matches.length, staged=Math.max(w.staged_payments, decided);
    const resolution=staged?Math.round(decided/staged*1000)/10:0;
    const auto=matches.filter(m=>m.status==="AUTO_POSTED");
    const cash=auto.reduce((a,m)=>a+((m.result||{}).lines||[]).reduce((x,l)=>x+l.net_cents,0),0);
    let ev=0; try{ const hub=await api("/api/v1/mail/hub"); ev=(hub.disputes||[]).reduce((a,x)=>a+(x.expected_recovery_usd||0),0); }catch(e){}
    const hours=(auto.length*12/60).toFixed(1);
    el.innerHTML=`<div class="scoregrid">
      <div class="card"><div class="k">Autonomous resolution rate</div><div class="v">${resolution}%</div><div class="n">${decided} of ${staged} wires received a stored decision in the latest run (posted, held or refused with a reason); any wire left without a stored decision (for example the duplicate the guard blocked before matching) is the remainder</div></div>
      <div class="card"><div class="k">Touchless auto-post rate</div><div class="v">${(latest.touchless_rate*100).toFixed(1)}%</div><div class="n">Payments posted with no human touch, of all payments in the run</div></div>
      <div class="card"><div class="k">Cash posted by the agent</div><div class="v">${money(cash)}</div><div class="n">Net applied on auto-posted matches in the latest run</div></div>
      <div class="card"><div class="k">Recovery in flight (EV)</div><div class="v">$${ev.toLocaleString("en-US",{maximumFractionDigits:0})}</div><div class="n">Expected value of the dispute claims the Deduction Agent opened</div></div>
      <div class="card"><div class="k">Analyst hours returned</div><div class="v">${hours} h</div><div class="n">${auto.length} auto-posted payments x 12 minutes manual benchmark (a labelled assumption)</div></div>
    </div>`;
  }catch(e){ el.innerHTML=`<small>Could not compute the scorecard: ${esc(e.message)}</small>` }
}
