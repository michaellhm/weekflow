const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>Array.from(r.querySelectorAll(s));
const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
const fmtTime=d=>d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
const fmtDate=d=>d.toLocaleDateString([], {weekday:'short', month:'short', day:'numeric'});
const startOfWeek=date=>{const d=new Date(date);const day=(d.getDay()+6)%7;d.setHours(0,0,0,0);d.setDate(d.getDate()-day);return d};
const addMinutes=(d,m)=>new Date(d.getTime()+m*60000);
const iso=d=>new Date(d).toISOString(); const fromIso=s=>s?new Date(s):null;

const store={
  get(k,f){try{ return JSON.parse(localStorage.getItem(k)) ?? f }catch{ return f }},
  set(k,v){try{ localStorage.setItem(k, JSON.stringify(v)) }catch{}; if(k==='wf_settings'){ fetch('/api/settings',{method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(v)}).catch(()=>{})}}
};

const state={
  tasks: [],
  settings: {workDays:[1,2,3,4,5],workStart:'09:00',workEnd:'17:00',theme:'system',overrides:{},dayOrders:{}},
  weekStart: startOfWeek(new Date()), clarifyQueue: [], notifications:{}
};

function applyTheme(t){document.documentElement.setAttribute('data-theme', t==='system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark':'light') : t); state.settings.theme=t; store.set('wf_settings',state.settings); $('#themeToggle').setAttribute('aria-pressed', t==='dark')}
$('#themeToggle')?.addEventListener('click', ()=>{const c=state.settings.theme; const n=c==='dark'?'light':c==='light'?'system':'dark'; applyTheme(n)}); applyTheme(state.settings.theme||'system');

$$('.tabs button').forEach(btn=> btn.addEventListener('click', ()=>{$$('.tabs button').forEach(b=>{b.classList.remove('active'); b.setAttribute('aria-selected','false')}); btn.classList.add('active'); btn.setAttribute('aria-selected','true'); $$('.tab').forEach(t=> t.classList.remove('active')); $('#tab-'+btn.dataset.tab).classList.add('active')}));

let ocrImageFile=null; $('#ocrFile')?.addEventListener('change',e=>{ocrImageFile=e.target.files[0]; $('#ocrStatus').textContent=ocrImageFile?`Selected: ${ocrImageFile.name}`:'No file selected'});
$('#ocrExtract')?.addEventListener('click', async()=>{ if(!ocrImageFile){$('#ocrStatus').textContent='Please choose an image first.'; return} $('#ocrStatus').textContent='Running OCR…'; try{const {data}=await Tesseract.recognize(ocrImageFile,'eng',{logger:m=>$('#ocrStatus').textContent=`${m.status} ${(m.progress*100|0)}%`}); $('#ocrOut').textContent=(data.text||'').trim(); $('#ocrStatus').textContent='Done.'}catch(err){$('#ocrStatus').textContent='OCR failed: '+err.message}});
$('#ocrToBulk')?.addEventListener('click',()=>{const t=$('#ocrOut').textContent.trim(); if(t){ $('#bulkText').value=( $('#bulkText').value? $('#bulkText').value+'\n':'')+t } });

function saveTasks(){store.set('wf_tasks', state.tasks); fetch('/api/tasks',{method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({tasks:state.tasks})}).catch(()=>{})}
function uid(){return Math.random().toString(36).slice(2,10)}
function addTask(o){const t={id:uid(), title:o.title?.trim()||'Untitled', notes:o.notes||'', category:o.category||'', priority:o.priority||'medium', durationMin:clamp(parseInt(o.durationMin)||30,5,8*60), due:o.due?iso(o.due):o.due||null, reminder:o.reminder?iso(o.reminder):o.reminder||null, batchable:!!o.batchable, status:'pending', createdAt:iso(new Date()), scheduled:[]}; state.tasks.push(t); saveTasks(); scheduleReminders(); renderAll(); return t}
function updateTask(id,patch){const i=state.tasks.findIndex(t=>t.id===id); if(i<0) return; Object.assign(state.tasks[i],patch); saveTasks(); renderAll()}
function deleteTask(id){state.tasks=state.tasks.filter(t=>t.id!==id); saveTasks(); renderAll()}

async function ensurePermission(){if(!('Notification'in window)) return false; if(Notification.permission==='granted') return true; if(Notification.permission!=='denied'){const p=await Notification.requestPermission(); return p==='granted'} return false}
function scheduleReminders(){Object.values(state.notifications).forEach(clearTimeout); state.notifications={}; const now=Date.now(); for(const t of state.tasks){ if(t.status==='completed'||!t.reminder) continue; const at=new Date(t.reminder).getTime(); if(at>now){const ms=at-now; const id=setTimeout(()=>{ensurePermission().then(ok=>{if(ok) new Notification('Reminder',{body:t.title}); else alert('Reminder: '+t.title)})},ms); state.notifications[t.id]=id } } }

function parseLine(line){const res={title:line, priority:'medium', durationMin:30, due:null, category:'', batchable:false}; const m=line.match(/^(.*?)\s*\((.*?)\)\s*$/); if(m){res.title=m[1].trim(); const parts=m[2].split(/,|;/).map(s=>s.trim().toLowerCase()); for(const p of parts){ if(/^(\d+)\s*m(in)?$/.test(p)) res.durationMin=parseInt(RegExp.$1); else if(/^(\d+)\s*h(our)?$/.test(p)) res.durationMin=parseInt(RegExp.$1)*60; else if(/high|urgent|asap/.test(p)) res.priority='high'; else if(/low/.test(p)) res.priority='low'; else if(/medium|med/.test(p)) res.priority='medium'; else if(/^due\b/.test(p)) res.due=new Date(p.replace(/^due\s*/,'')); else if(/batch/.test(p)) res.batchable=true; else if(/cat[:=]/.test(p)) res.category=p.replace(/cat[:=]\s*/,'') } } else { if(/urgent|asap|!/.test(line)) res.priority='high'; if(/call|email/.test(line)) res.durationMin=15; if(/report|write|draft/i.test(line)) res.durationMin=60 } return res}
function classifyHeuristic(lines){return lines.filter(Boolean).map(s=>parseLine(s.trim())).filter(t=>t.title)}

const clarifyDialog=$('#clarifyDialog'); let currentClarify=null; function startClarify(tasks){state.clarifyQueue=tasks.map((t,i)=>({idx:i,task:t,step:0})); nextClarify()} function nextClarify(){if(state.clarifyQueue.length===0){clarifyDialog.close(); renderAll(); return} currentClarify=state.clarifyQueue.shift(); showClarifyStep()} function showClarifyStep(){if(!currentClarify){clarifyDialog.close(); return} const {task,step}=currentClarify; $('#clarifyProgress').textContent=`Task ${currentClarify.idx+1} of ${state.clarifyTotal||1}`; let prompt='',controls=''; if(step===0 && !task.durationMin){prompt=`How long will “${task.title}” take?`; controls=`<input id="clarDur" class="input" type="number" min="5" step="5" placeholder="30" />`} else if((step===0&&task.durationMin)||step===1){prompt=`Priority for “${task.title}”?`; controls=`<div class="btn-group"><button data-p="high" class="btn">High</button><button data-p="medium" class="btn secondary">Medium</button><button data-p="low" class="btn secondary">Low</button></div>`} else if(step===2){prompt=`Due date/time for “${task.title}” (optional)`; controls=`<input id="clarDue" class="input" type="datetime-local" />`} else if(step===3){prompt=`Batch with similar tasks?`; controls=`<div class="btn-group"><button data-b="yes" class="btn">Yes</button><button data-b="no" class="btn secondary">No</button></div>`} else {addTask(task); nextClarify(); return} $('#clarifyPrompt').textContent=prompt; $('#clarifyControls').innerHTML=controls; if(!clarifyDialog.open){clarifyDialog.showModal()}}
$('#clarifyControls')?.addEventListener('click',e=>{const {task}=currentClarify||{}; if(!task) return; if(e.target.matches('button[data-p]')){task.priority=e.target.dataset.p; currentClarify.step=2; showClarifyStep()} if(e.target.matches('button[data-b]')){task.batchable=e.target.dataset.b==='yes'; currentClarify.step=4; showClarifyStep()}});
$('#clarifyNext')?.addEventListener('click',e=>{e.preventDefault(); if(!currentClarify) return; const {task,step}=currentClarify; if(step===0 && $('#clarDur')){const v=parseInt($('#clarDur').value); if(v>0) task.durationMin=v; currentClarify.step=1; showClarifyStep(); return} if(step===2 && $('#clarDue')){const v=$('#clarDue').value; task.due=v?new Date(v):null; currentClarify.step=3; showClarifyStep(); return}});
$('#openClarify')?.addEventListener('click',()=>{const lines=$('#bulkText').value.split(/\n|\r/).map(s=>s.trim()).filter(Boolean); if(!lines.length){showToast('Nothing to clarify. Add some tasks first.'); return} const tasks=classifyHeuristic(lines); state.clarifyTotal=tasks.length; startClarify(tasks)});

$('#parseBtn')?.addEventListener('click',()=>{const bulk=$('#bulkText'); const lines=bulk.value.split(/\n|\r/).map(s=>s.trim()).filter(Boolean); if(!lines.length){showToast('Paste or type some tasks first.'); bulk.focus(); return} const tasks=classifyHeuristic(lines); tasks.forEach(t=>addTask(t)); showToast(`Added ${tasks.length} task${tasks.length!==1?'s':''} to pending.`); bulk.value=''; bulk.focus()});
$('#quickAddForm')?.addEventListener('submit',e=>{e.preventDefault(); const title=$('#qaTitle').value?.trim(); if(!title){$('#qaTitle').focus(); return} const t=addTask({title, durationMin:parseInt($('#qaDuration').value)||30, priority:$('#qaPriority').value, category:$('#qaCategory').value}); e.target.reset(); showToast('Task added to pending.')});
$('#qaAddPending')?.addEventListener('click',()=>{$('#quickAddForm').dispatchEvent(new Event('submit',{cancelable:true}))});
$('#qaAddToday')?.addEventListener('click',()=>{const title=$('#qaTitle').value?.trim(); if(!title){$('#qaTitle').focus(); return} const t=addTask({title, durationMin:parseInt($('#qaDuration').value)||30, priority:$('#qaPriority').value, category:$('#qaCategory').value}); const today=new Date(); today.setHours(0,0,0,0); moveTaskToDay(t.id, today); showToast('Task added to today.')});
$('#qaAddTomorrow')?.addEventListener('click',()=>{const title=$('#qaTitle').value?.trim(); if(!title){$('#qaTitle').focus(); return} const t=addTask({title, durationMin:parseInt($('#qaDuration').value)||30, priority:$('#qaPriority').value, category:$('#qaCategory').value}); const tomorrow=new Date(); tomorrow.setDate(tomorrow.getDate()+1); tomorrow.setHours(0,0,0,0); moveTaskToDay(t.id, tomorrow); showToast('Task added to tomorrow.')});

;['filterQuery','filterStatus','filterPriority','filterFrom','filterTo'].forEach(id=>{$('#'+id)?.addEventListener('input',renderTaskList); $('#'+id)?.addEventListener('change',renderTaskList)});
$('#clearCompleted')?.addEventListener('click',()=>{const before=state.tasks.length; state.tasks=state.tasks.filter(t=>t.status!=='completed'); saveTasks(); renderAll(); showToast(`Cleared ${before-state.tasks.length} completed tasks.`)})

;['filterQuery2','filterStatus2','filterPriority2','filterFrom2','filterTo2'].forEach(id=>{$('#'+id)?.addEventListener('input',renderAllTasksView); $('#'+id)?.addEventListener('change',renderAllTasksView)});
$('#clearCompleted2')?.addEventListener('click',()=>{const before=state.tasks.length; state.tasks=state.tasks.filter(t=>t.status!=='completed'); saveTasks(); renderAll(); showToast(`Cleared ${before-state.tasks.length} completed tasks.`)})

function matchesFilters(t){const q=$('#filterQuery').value.toLowerCase(); const st=$('#filterStatus').value; const pr=$('#filterPriority').value; const from=$('#filterFrom').value?new Date($('#filterFrom').value):null; const to=$('#filterTo').value?new Date($('#filterTo').value):null; if(q && !(t.title.toLowerCase().includes(q)||(t.category||'').toLowerCase().includes(q))) return false; if(st!=='all' && (st==='waiting'? t.status!=='waiting' : t.status!==st)) return false; if(pr!=='all' && t.priority!==pr) return false; if(from && t.due && new Date(t.due) < from) return false; if(to && t.due && new Date(t.due) > addMinutes(new Date(to),24*60)) return false; return true}
function matchesFilters2(t){const q=$('#filterQuery2').value.toLowerCase(); const st=$('#filterStatus2').value; const pr=$('#filterPriority2').value; const from=$('#filterFrom2').value?new Date($('#filterFrom2').value):null; const to=$('#filterTo2').value?new Date($('#filterTo2').value):null; if(q && !(t.title.toLowerCase().includes(q)||(t.category||'').toLowerCase().includes(q))) return false; if(st==='scheduled' && !(t.scheduled&&t.scheduled.length)) return false; if(st==='pending' && (t.status!=='pending' || (t.scheduled&&t.scheduled.length))) return false; if(st==='waiting' && t.status!=='waiting') return false; if(st==='completed' && t.status!=='completed') return false; if(pr!=='all' && t.priority!==pr) return false; if(from && t.due && new Date(t.due) < from) return false; if(to && t.due && new Date(t.due) > addMinutes(new Date(to),24*60)) return false; return true}

function taskItem(t,opts={}){const li=document.createElement('li'); li.className='task'+(t.status==='completed'?' completed':'')+(t.status==='waiting'?' waiting':''); li.setAttribute('draggable','true'); li.dataset.id=t.id; const contextBtns=[]; if(opts.context==='today'){contextBtns.push('<button class="icon-btn" title="Mark waiting" data-act="waiting">⏳</button>'); contextBtns.push('<button class="icon-btn" title="Push to next week" data-act="nextweek">↪️</button>')} if(opts.context==='waiting'){contextBtns.push('<button class="icon-btn" title="Schedule back to today" data-act="backtotoday">🗓️</button>')} if(opts.context==='all'){contextBtns.push('<button class="icon-btn" title="Schedule this task" data-act="schedule">🗓️</button>')} li.innerHTML=`
      <input type="checkbox" ${t.status==='completed'?'checked':''} aria-label="Complete task" />
      <div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <strong>${t.title.replace(/</g,'&lt;')}</strong>
          <span class="badge ${t.priority}">${t.priority}</span>
          ${t.category? `<span class="badge">${t.category}</span>`:''}
          ${t.due? `<span class="muted">Due ${fmtDate(new Date(t.due))} ${fmtTime(new Date(t.due))}</span>`:''}
          <span class="muted">${t.durationMin}m</span>
        </div>
        ${t.notes? `<div class="muted" style="font-size:12px">${t.notes.replace(/</g,'&lt;')}</div>`:''}
      </div>
      <div class="btn-group">
        ${contextBtns.join('')}
        <button class="icon-btn" title="Edit">✏️</button>
        <button class="icon-btn" title="Delete">🗑️</button>
      </div>`;
  li.querySelector('input[type=checkbox]')?.addEventListener('change',e=>{updateTask(t.id,{status:e.target.checked?'completed':'pending'}); if(e.target.checked) motivate()});
  li.querySelector('[title=Delete]')?.addEventListener('click',()=>{if(confirm('Delete this task?')) deleteTask(t.id)});
  li.querySelector('[title=Edit]')?.addEventListener('click',()=>openEdit(t));
  if(li.querySelector('[data-act="nextweek"]')) li.querySelector('[data-act="nextweek"]').addEventListener('click',()=>pushToNextWeek(t.id));
  if(li.querySelector('[data-act="waiting"]')) li.querySelector('[data-act="waiting"]').addEventListener('click',()=>{const reason=prompt('Waiting reason (optional):',''); updateTask(t.id,{status:'waiting', waitingReason: reason||''})});
  if(li.querySelector('[data-act="backtotoday"]')) li.querySelector('[data-act="backtotoday"]').addEventListener('click',()=>{
    // Move to today and set status pending
    const today=new Date(); today.setHours(0,0,0,0);
    updateTask(t.id,{status:'pending'});
    moveTaskToDay(t.id, today);
  });
  if(li.querySelector('[data-act="schedule"]')) li.querySelector('[data-act="schedule"]').addEventListener('click',()=>autoScheduleSingle(t.id));
  li.addEventListener('dragstart',e=>{li.classList.add('dragging'); e.dataTransfer.setData('text/plain',t.id)});
  li.addEventListener('dragend',()=>li.classList.remove('dragging'));
  return li}

const editDialog=$('#editDialog'); function openEdit(t){$('#editId').value=t.id; $('#editTitle').value=t.title; $('#editDuration').value=t.durationMin; $('#editPriority').value=t.priority; $('#editCategory').value=t.category||''; $('#editDue').value=t.due? new Date(t.due).toISOString().slice(0,16):''; $('#editReminder').value=t.reminder? new Date(t.reminder).toISOString().slice(0,16):''; $('#editBatchable').checked=!!t.batchable; editDialog.showModal()}
$('#editSave')?.addEventListener('click',e=>{e.preventDefault(); const id=$('#editId').value; updateTask(id,{title:$('#editTitle').value, durationMin:parseInt($('#editDuration').value)||30, priority:$('#editPriority').value, category:$('#editCategory').value, due:$('#editDue').value? new Date($('#editDue').value).toISOString():null, reminder:$('#editReminder').value? new Date($('#editReminder').value).toISOString():null, batchable:$('#editBatchable').checked}); editDialog.close(); scheduleReminders()});

function weekKey(d){const y=d.getFullYear(); const temp=new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const dayNum=temp.getUTCDay()||7; temp.setUTCDate(temp.getUTCDate()+4-dayNum); const yearStart=new Date(Date.UTC(temp.getUTCFullYear(),0,1)); const weekNo=Math.ceil((((temp-yearStart)/86400000)+1)/7); return `${y}-W${String(weekNo).padStart(2,'0')}`}

function renderWeekView(){const cal=$('#calendar'); cal.innerHTML=''; const ws=state.weekStart; const wk=weekKey(ws); $('#weekLabel').textContent=`${fmtDate(ws)} – ${fmtDate(addMinutes(ws,6*24*60))} (Week ${wk.split('-W')[1]})`; const head=document.createElement('div'); head.className='cal-head'; head.innerHTML=`<div class="cal-time-head"></div>`+Array.from({length:7}).map((_,i)=>{const d=addMinutes(ws,i*24*60); const isToday=new Date().toDateString()===d.toDateString(); return `<div class="cal-day-head" aria-label="${d.toDateString()}" style="${isToday?'color:var(--primary)':''}">${d.toLocaleDateString([], {weekday:'short'})}<br><small class="muted">${d.getDate()}/${d.getMonth()+1}</small></div>`}).join(''); cal.appendChild(head); const body=document.createElement('div'); body.className='cal-body'; const [hs,ms]=state.settings.workStart.split(':').map(Number); const [he,me]=state.settings.workEnd.split(':').map(Number); const dayStart=hs*60+ms, dayEnd=he*60+me; const timeCol=document.createElement('div'); timeCol.className='time-col'; for(let m=dayStart;m<dayEnd;m+=30){const t=new Date(ws); t.setHours(0,m,0,0); const slot=document.createElement('div'); slot.className='time-slot'; slot.textContent=(m%60===0? fmtTime(t): '\u00A0'); timeCol.appendChild(slot)} body.appendChild(timeCol); for(let i=0;i<7;i++){const day=addMinutes(ws,i*24*60); const dayCol=document.createElement('div'); dayCol.className='day-col'; dayCol.dataset.dayIndex=((day.getDay()+6)%7)+1; const blocks=computeScheduledBlocksForDay(day); for(const b of blocks){const top=((b.startMin - dayStart)/(dayEnd-dayStart))*((dayEnd-dayStart)/30*40); const height=(b.durationMin/30)*40-4; const div=document.createElement('div'); div.className=`block ${b.priority}`; div.style.top=`${Math.max(2,top)}px`; div.style.height=`${Math.max(24,height)}px`; div.textContent=`${b.title} (${b.durationMin}m)`; div.title=`${b.title} \n${fmtTime(b.start)}–${fmtTime(b.end)} (${b.priority})`; dayCol.appendChild(div)} body.appendChild(dayCol)} cal.appendChild(body)}
function computeScheduledBlocksForDay(day){const dayStr=day.toDateString(); const blocks=[]; for(const t of state.tasks){for(const s of (t.scheduled||[])){const st=new Date(s.start); if(st.toDateString()===dayStr){blocks.push({title:t.title, priority:t.priority, durationMin:(new Date(s.end)-st)/60000, start:st, end:new Date(s.end), startMin:st.getHours()*60+st.getMinutes(), id:t.id})}}} blocks.sort((a,b)=>a.start-b.start); return blocks}

function setCalView(v){$$('.subtabs button').forEach(b=>{b.classList.toggle('active', b.dataset.view===v); b.setAttribute('aria-selected', String(b.dataset.view===v))}); $$('.subview').forEach(s=> s.classList.remove('active')); $('#view-'+v).classList.add('active'); if(v==='week') renderWeekView(); if(v==='today') renderTodayView(); if(v==='upcoming') renderUpcomingView(); if(v==='alltasks') renderAllTasksView()}
$$('.subtabs button').forEach(btn=> btn.addEventListener('click', ()=> setCalView(btn.dataset.view)));

function renderCalendar(){ if($('#view-week').classList.contains('active')) renderWeekView() }

function renderTodayView(){const today=new Date(); today.setHours(0,0,0,0); $('#todayDate').textContent=today.toDateString(); let todayTasks=state.tasks.filter(t=> t.status!=='waiting' && (t.scheduled?.some(s=> new Date(s.start).toDateString()===today.toDateString()) || (t.due && new Date(t.due).toDateString()===today.toDateString()))); const key=today.toISOString().slice(0,10); const order=(state.settings.dayOrders||{})[key]||[]; if(order.length){todayTasks.sort((a,b)=> order.indexOf(a.id)-order.indexOf(b.id))} else {todayTasks.sort((a,b)=>{const aFirst=a.scheduled?.find(s=> new Date(s.start).toDateString()===today.toDateString()); const bFirst=b.scheduled?.find(s=> new Date(s.start).toDateString()===today.toDateString()); return (aFirst? new Date(aFirst.start): new Date(a.due||today)).getTime() - (bFirst? new Date(bFirst.start): new Date(b.due||today)).getTime()})} const ul=$('#todayTasks'); ul.innerHTML=''; todayTasks.forEach(t=> ul.appendChild(taskItem(t,{context:'today'}))); ul.addEventListener('dragover',e=>{e.preventDefault(); const dragging=$('.task.dragging'); if(!dragging) return; const after=Array.from(ul.querySelectorAll('.task:not(.dragging)')).find(el=>{const r=el.getBoundingClientRect(); return e.clientY <= r.top + r.height/2}); if(after) ul.insertBefore(dragging,after); else ul.appendChild(dragging)}); ul.addEventListener('drop',()=>{const ids=$$('#todayTasks .task').map(el=>el.dataset.id); state.settings.dayOrders=state.settings.dayOrders||{}; state.settings.dayOrders[key]=ids; store.set('wf_settings',state.settings)});
  // Waiting list
  const waitingUl=$('#waitingTasks'); if(waitingUl){waitingUl.innerHTML=''; state.tasks.filter(t=> t.status==='waiting').forEach(t=> waitingUl.appendChild(taskItem(t,{context:'waiting'}))); waitingUl.addEventListener('dragover',e=>{e.preventDefault(); const dragging=$('.task.dragging'); if(!dragging) return}); waitingUl.addEventListener('drop',e=>{e.preventDefault(); const taskId=e.dataTransfer.getData('text/plain'); if(!taskId) return; const today=new Date(); today.setHours(0,0,0,0); updateTask(taskId,{status:'pending'}); moveTaskToDay(taskId, today);});}
}

function renderUpcomingView(){const container=$('#upcomingList'); container.innerHTML=''; const ws=state.weekStart; const today=new Date(); today.setHours(0,0,0,0); const daySections=[]; for(let i=0;i<7;i++){const d=addMinutes(ws,i*24*60); if(d<today) continue; const dayStr=d.toDateString(); const dayTasks=state.tasks.filter(t=> t.scheduled?.some(s=> new Date(s.start).toDateString()===dayStr)); const sec=document.createElement('section'); sec.className='stack'; sec.innerHTML=`<strong>${fmtDate(d)}</strong>`; const list=document.createElement('ul'); list.className='task-list'; list.dataset.day=dayStr; list.addEventListener('dragover',e=>{e.preventDefault(); const dragging=$('.task.dragging'); if(!dragging) return; const after=Array.from(list.querySelectorAll('.task:not(.dragging)')).find(el=>{const r=el.getBoundingClientRect(); return e.clientY <= r.top + r.height/2}); if(after) list.insertBefore(dragging,after); else list.appendChild(dragging)}); list.addEventListener('drop',e=>{e.preventDefault(); const taskId=e.dataTransfer.getData('text/plain'); if(!taskId) return; moveTaskToDay(taskId, new Date(list.dataset.day));}); if(dayTasks.length){dayTasks.forEach(t=> list.appendChild(taskItem(t)))} else {list.innerHTML='<div class="muted">No tasks scheduled.</div>'} sec.appendChild(list); container.appendChild(sec); daySections.push({day:dayStr, list})}}

function renderAllTasksView(){const list=$('#taskList2'); list.innerHTML=''; const tasks=state.tasks.filter(matchesFilters2); tasks.sort((a,b)=> a.status===b.status ? 0 : a.status==='pending' ? -1:1); tasks.forEach(t=> list.appendChild(taskItem(t,{context:'all'}))); list.addEventListener('dragover',e=>{e.preventDefault(); const dragging=$('.task.dragging'); if(!dragging) return; const after=Array.from(list.querySelectorAll('.task:not(.dragging)')).find(el=>{const r=el.getBoundingClientRect(); return e.clientY <= r.top + r.height/2}); if(after) list.insertBefore(dragging,after); else list.appendChild(dragging)}); list.addEventListener('drop',()=>{const ids=$$('#taskList2 .task').map(el=>el.dataset.id); state.tasks.sort((a,b)=> ids.indexOf(a.id)-ids.indexOf(b.id)); saveTasks()})}

function getAvailabilityForWeek(ws){const wk=weekKey(ws); const ovr=state.settings.overrides[wk]||{}; const [hs,ms]=state.settings.workStart.split(':').map(Number); const [he,me]=state.settings.workEnd.split(':').map(Number); const baseStart=hs*60+ms, baseEnd=he*60+me; const days=Array.from({length:7}).map((_,i)=>{const dow=(i+1); if(!state.settings.workDays.includes(i===6?0:(i+1))) return []; let blocks=[{s:baseStart,e:baseEnd}]; const dOvr=ovr[dow]; if(dOvr){ if(dOvr.allDay) return []; for(const blk of dOvr.blocks||[]){const bs=toMin(blk.s), be=toMin(blk.e); blocks=subtractBlock(blocks,{s:bs,e:be}) } } return mergeBlocks(blocks)}); return days; function toMin(t){const [h,m]=t.split(':').map(Number); return h*60+m} function subtractBlock(avail,block){const out=[]; for(const a of avail){if(block.e<=a.s || block.s>=a.e){out.push(a); continue} if(block.s>a.s) out.push({s:a.s,e:block.s}); if(block.e<a.e) out.push({s:block.e,e:a.e})} return out} function mergeBlocks(blks){blks.sort((a,b)=>a.s-b.s); const out=[]; for(const b of blks){if(!out.length || b.s>out.at(-1).e) out.push({...b}); else out.at(-1).e=Math.max(out.at(-1).e,b.e)} return out}}

function buildPerDayTaskSets(ws){const sets=Array.from({length:7},()=> new Set()); for(let i=0;i<7;i++){const d=addMinutes(ws,i*24*60); const dayStr=d.toDateString(); for(const t of state.tasks){if((t.scheduled||[]).some(s=> new Date(s.start).toDateString()===dayStr)) sets[i].add(t.id)}} return sets}
function autoSchedule(){let ws=state.weekStart; const today=new Date(); const todayStart=new Date(today.getFullYear(),today.getMonth(),today.getDate()); const wsEnd=addMinutes(ws,7*24*60); if(todayStart>=ws && todayStart<wsEnd){ ws = ws } else { ws = state.weekStart } const startDayOffset=Math.max(0, Math.floor((todayStart - ws)/ (24*60*60*1000))); const avail=getAvailabilityForWeek(ws); const perDaySets=buildPerDayTaskSets(ws); const candidates=state.tasks.filter(t=> t.status==='pending'); candidates.sort((a,b)=>{const ad=a.due?new Date(a.due).getTime():Infinity; const bd=b.due?new Date(b.due).getTime():Infinity; if(ad!==bd) return ad-bd; const pr={high:0,medium:1,low:2}; if(pr[a.priority]!==pr[b.priority]) return pr[a.priority]-pr[b.priority]; return (b.durationMin||0)-(a.durationMin||0)}); const weekStartMs=ws.getTime(); const weekEndMs=addMinutes(ws,7*24*60).getTime(); for(const t of candidates){ t.scheduled=(t.scheduled||[]).filter(s=>{const st=new Date(s.start).getTime(); return st<weekStartMs || st>=weekEndMs}) } for(const t of candidates){ scheduleTaskInWeek(t,avail,ws,perDaySets,startDayOffset) } saveTasks(); renderAll(); showToast('Auto‑scheduling complete.')}
function autoScheduleSingle(id){const t=state.tasks.find(x=>x.id===id); if(!t) return; const ws=state.weekStart; const avail=getAvailabilityForWeek(ws); const perDaySets=buildPerDayTaskSets(ws); const today=new Date(); const todayStart=new Date(today.getFullYear(),today.getMonth(),today.getDate()); const startDayOffset=Math.max(0, Math.floor((todayStart - ws)/ (24*60*60*1000))); scheduleTaskInWeek(t,avail,ws,perDaySets,startDayOffset); saveTasks(); renderAll(); showToast('Task scheduled.')}
function scheduleTaskInWeek(t,avail,ws,perDaySets,startDayOffset=0){
  let remaining=t.durationMin||30; let placed=false;
  const weekStartMs=ws.getTime(); const weekEndMs=addMinutes(ws,7*24*60).getTime();
  t.scheduled=(t.scheduled||[]).filter(s=>{const st=new Date(s.start).getTime(); return st<weekStartMs || st>=weekEndMs});
  for(let d=startDayOffset; d<7 && remaining>0; d++){
    const dayDate=addMinutes(ws,d*24*60);
    const blocks=avail[d]; if(!blocks||!blocks.length) continue;
    const occupied=computeScheduledBlocksForDay(dayDate).map(x=>({s:x.startMin,e:x.startMin+x.durationMin}));
    const set=perDaySets? perDaySets[d]: null;
    for(const b of blocks){
      let cursor=b.s;
      while(cursor+30<=b.e && remaining>0){
        const next=cursor+30;
        const overlaps=occupied.some(o=> !(next<=o.s || cursor>=o.e));
        const alreadyCounted = !!(set && set.has(t.id));
        const firstSlotToday = !(t.scheduled||[]).some(s=> new Date(s.start).toDateString()===dayDate.toDateString());
        const canStartNewTaskToday = set ? set.size < 5 : true;
        const dayHasCapacity = alreadyCounted || (firstSlotToday ? canStartNewTaskToday : true);
        if(!overlaps && dayHasCapacity){
          const start=new Date(dayDate); start.setHours(0,cursor,0,0);
          const end=new Date(dayDate); end.setHours(0,next,0,0);
          t.scheduled=t.scheduled||[]; t.scheduled.push({start:iso(start), end:iso(end)});
          remaining-=30; placed=true; occupied.push({s:cursor,e:next});
          if(set && firstSlotToday){ set.add(t.id) }
        }
        cursor=next
      }
      if(remaining<=0) break
    }
  }
  if(!placed){ /* couldn't schedule this week */ }
}
function pushToNextWeek(id){const t=state.tasks.find(x=>x.id===id); if(!t) return; const ws=state.weekStart; const weekStartMs=ws.getTime(); const weekEndMs=addMinutes(ws,7*24*60).getTime(); t.scheduled=(t.scheduled||[]).filter(s=>{const st=new Date(s.start).getTime(); return st<weekStartMs || st>=weekEndMs}); t.status='pending'; saveTasks(); renderAll(); showToast('Moved to pending for next week.')}
$('#schedulePending')?.addEventListener('click', autoSchedule);

function renderOverrides(){const ws=state.weekStart; const wk=weekKey(ws); const ovr=state.settings.overrides[wk]||{}; const days=['Sun','Mon','Tue','Wed','Thu','Fri','Sat']; const sel=$('#ovrDay'); sel.innerHTML=''; for(let i=0;i<7;i++){const d=addMinutes(ws,i*24*60); const value=((d.getDay()+6)%7)+1; const opt=document.createElement('option'); opt.value=value; opt.textContent=`${days[d.getDay()]} ${d.getDate()}/${d.getMonth()+1}`; sel.appendChild(opt)} const list=$('#overrideList'); list.innerHTML=''; Object.entries(ovr).forEach(([dayIdx,conf])=>{const div=document.createElement('div'); div.className='task'; div.innerHTML=`<div><strong>Day ${dayIdx}</strong> ${conf.allDay? '<span class="badge high">All day blocked</span>' : ''} ${!conf.allDay && conf.blocks?.length? '<div class="muted">'+conf.blocks.map(b=>`${b.s}–${b.e}`).join(', ')+'</div>':''}</div><div class="btn-group"><button class="icon-btn" data-day="${dayIdx}">🗑️</button></div>`; div.querySelector('button').addEventListener('click',()=>{delete ovr[dayIdx]; state.settings.overrides[wk]=ovr; store.set('wf_settings',state.settings); renderOverrides(); renderCalendar()}); list.appendChild(div)})}
$('#addOverride')?.addEventListener('click',()=>{const wk=weekKey(state.weekStart); const day=$('#ovrDay').value; const s=$('#ovrStart').value; const e=$('#ovrEnd').value; const ovr=state.settings.overrides[wk]||{}; ovr[day]=ovr[day]||{allDay:false, blocks:[]}; ovr[day].blocks.push({s,e}); state.settings.overrides[wk]=ovr; store.set('wf_settings',state.settings); renderOverrides(); renderCalendar()});
$('#blockAllDay')?.addEventListener('click',()=>{const wk=weekKey(state.weekStart); const day=$('#ovrDay').value; const ovr=state.settings.overrides[wk]||{}; ovr[day]={allDay:true, blocks:[]}; state.settings.overrides[wk]=ovr; store.set('wf_settings',state.settings); renderOverrides(); renderCalendar()});
$('#saveDefaults')?.addEventListener('click',()=>{const workDays=$$('.workday:checked').map(cb=> parseInt(cb.dataset.day)); state.settings.workDays=workDays; state.settings.workStart=$('#workStart').value; state.settings.workEnd=$('#workEnd').value; store.set('wf_settings',state.settings); renderCalendar(); showToast('Defaults saved.')});

function jumpWeeks(delta){state.weekStart=addMinutes(state.weekStart, delta*7*24*60); renderAll()}
$('#prevWeek')?.addEventListener('click',()=>jumpWeeks(-1)); $('#nextWeek')?.addEventListener('click',()=>jumpWeeks(+1)); $('#todayBtn')?.addEventListener('click',()=>{state.weekStart=startOfWeek(new Date()); renderAll()});

function renderTaskList(){const list=$('#taskList'); if(!list) return; list.innerHTML=''; const tasks=state.tasks.filter(matchesFilters); tasks.sort((a,b)=> a.status===b.status ? 0 : a.status==='pending' ? -1:1); tasks.forEach(t=> list.appendChild(taskItem(t))); list.addEventListener('dragover',e=>{e.preventDefault(); const dragging=$('.task.dragging'); if(!dragging) return; const after=Array.from(list.querySelectorAll('.task:not(.dragging)')).find(el=>{const r=el.getBoundingClientRect(); return e.clientY <= r.top + r.height/2}); if(after) list.insertBefore(dragging,after); else list.appendChild(dragging)}); list.addEventListener('drop',()=>{const ids=$$('#taskList .task').map(el=>el.dataset.id); state.tasks.sort((a,b)=> ids.indexOf(a.id)-ids.indexOf(b.id)); saveTasks()})}

const messages=['Nice! Progress compounds. 💪','One step closer — keep going! ✨','Great work — momentum looks good. 🚀','Done and dusted. Onwards! ✅','You’re doing brilliantly. 🙌']; function motivate(){showToast(messages[(Math.random()*messages.length)|0])} function showToast(msg){const t=$('#toast'); t.textContent=msg; t.classList.add('show'); setTimeout(()=> t.classList.remove('show'), 2400)}

$('#exportBtn')?.addEventListener('click',()=>{const blob=new Blob([JSON.stringify({tasks:state.tasks, settings:state.settings}, null, 2)],{type:'application/json'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='weekflow-export.json'; a.click(); URL.revokeObjectURL(url)});
$('#importBtn')?.addEventListener('click',()=>{const inp=document.createElement('input'); inp.type='file'; inp.accept='application/json'; inp.onchange=()=>{const f=inp.files[0]; if(!f) return; const r=new FileReader(); r.onload=()=>{try{const data=JSON.parse(r.result); if(data.tasks) state.tasks=data.tasks; if(data.settings) state.settings=data.settings; saveTasks(); store.set('wf_settings',state.settings); renderAll(); showToast('Imported.')}catch{alert('Invalid JSON')}}; r.readAsText(f)}; inp.click()});

function moveTaskToDay(taskId, day){const t=state.tasks.find(x=>x.id===taskId); if(!t) return; const [hs,ms]=state.settings.workStart.split(':').map(Number); const [he,me]=state.settings.workEnd.split(':').map(Number); const dayStartMin=(hs||9)*60+(ms||0); const dayEndMin=(he||17)*60+(me||0); const ws=state.weekStart; const wsStart=ws.getTime(); const wsEnd=addMinutes(ws,7*24*60).getTime(); t.scheduled=(t.scheduled||[]).filter(s=>{const st=new Date(s.start).getTime(); return st<wsStart || st>=wsEnd}); const occupied=computeScheduledBlocksForDay(day).map(x=>({s:x.startMin,e:x.startMin+x.durationMin})); let remaining=t.durationMin||30; let cursor=dayStartMin; while(cursor+30<=dayEndMin && remaining>0){const next=cursor+30; const overlaps=occupied.some(o=> !(next<=o.s || cursor>=o.e)); if(!overlaps){const start=new Date(day); start.setHours(0,cursor,0,0); const end=new Date(day); end.setHours(0,next,0,0); t.scheduled.push({start:iso(start), end:iso(end)}); occupied.push({s:cursor,e:next}); remaining-=30;} cursor=next} saveTasks(); renderAll()}

function renderAll(){renderTaskList(); renderOverrides(); renderCalendar(); renderTodayView(); renderUpcomingView(); renderAllTasksView()}

(async function init(){
  try{
    const [tr,sr]=await Promise.all([
      fetch('/api/tasks').then(r=> r.ok? r.json(): Promise.resolve([])).catch(()=>[]),
      fetch('/api/settings').then(r=> r.ok? r.json(): Promise.resolve(null)).catch(()=>null)
    ]);
    state.tasks = Array.isArray(tr)? tr: [];
    if(sr && typeof sr==='object') state.settings=sr;
  }catch{}
  if(!state.tasks.length){addTask({title:'Plan week', durationMin:30, priority:'high', category:'Planning'}); addTask({title:'Write 2 progress notes', durationMin:60, priority:'medium', category:'Admin', batchable:true})}
  $$('.workday').forEach(cb=>{cb.checked=state.settings.workDays.includes(parseInt(cb.dataset.day))});
  $('#workStart').value=state.settings.workStart||'09:00';
  $('#workEnd').value=state.settings.workEnd||'17:00';
  scheduleReminders();
  renderAll();
  setCalView('today')
})();


