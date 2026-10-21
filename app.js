const db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $ = s => document.querySelector(s), app = $('#app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let me, progs = [], profs = [], asg = [], subs = [], selId = null, F = {ay:'2026-2027', sem:'1', q:'', prog:'', comp:''};
const toast = (m, bad) => { const t = $('#toast'); t.textContent = m; t.className = bad ? 'bad show' : 'show'; setTimeout(() => t.className = '', 4500); };
const tag = s => `<span class="tag ${/Deficiency|Held|Returned/.test(s) ? 'bad' : /Pending|Not Eval/.test(s) ? 'mid' : ''}">${esc(s)}</span>`;
const fmt = d => new Date(d).toLocaleString('en-PH', {timeZone:'Asia/Manila'});
const rpc = async (fn, args, ok) => { const {error} = await db.rpc(fn, args); error ? toast(error.message, true) : (toast(ok), await load()); };

async function boot() {
  const {data:{session}} = await db.auth.getSession();
  if (!session) return loginView();
  const {data} = await db.from('profiles').select('*').eq('auth_id', session.user.id).maybeSingle();
  me = data; if (!me) return toast('No profile found', true);
  $('#who').innerHTML = `${esc(me.full_name)} · ${me.role} <button class="alt" id="out">Sign out</button>`;
  $('#out').onclick = async () => { await db.auth.signOut(); location.reload(); };
  await load();
}
function loginView() {
  app.innerHTML = `<div class="card login"><h2>Sign in</h2><input id="em" type="email" placeholder="Email"><input id="pw" type="password" placeholder="Password (min 6)">
  <div class="row"><button id="in">Sign in</button><button class="alt" id="up">Sign up as scholar</button></div>
  <small>Scholars: sign up with the email staff registered for you.</small></div>`;
  const cred = () => ({email: $('#em').value.trim(), password: $('#pw').value});
  $('#in').onclick = async () => { const {error} = await db.auth.signInWithPassword(cred()); error ? toast(error.message, true) : boot(); };
  $('#up').onclick = async () => { const {error} = await db.auth.signUp(cred()); error ? toast(error.message, true) : (toast('Account created. Sign in now.')); };
}
async function load() {
  const [a, b, c, d] = await Promise.all([db.from('programs').select('*').order('id'), db.from('profiles').select('*').eq('role','scholar').order('student_id'),
    db.from('assignments').select('*'), db.from('submissions').select('*').order('submitted_at', {ascending:false})]);
  progs = a.data || []; profs = b.data || []; asg = c.data || []; subs = d.data || [];
  me.role === 'staff' ? staffView() : scholarView();
}
const progOf = pid => progs.find(p => p.id === asg.find(x => x.scholar_id === pid)?.program_id);
const hist = async id => { const {data} = await db.from('history').select('*').eq('submission_id', id).order('created_at'); return data || []; };
const nums = () => ['gwa','units','failed','inc','drop'];
function readForm() {
  const v = {g: parseFloat($('#gwa').value), u: +$('#units').value, f: +$('#failed').value, i: +$('#inc').value, d: +$('#drop').value, ev: $('#ev').value.trim()};
  if (!(v.g >= 1 && v.g <= 5)) return toast('GWA must be between 1.00 and 5.00', true), null;
  if ([v.u, v.f, v.i, v.d].some(n => !Number.isInteger(n) || n < 0)) return toast('Units and counts must be non-negative whole numbers', true), null;
  if (!v.ev) return toast('Grade-document reference is required', true), null;
  return v;
}
const formHTML = (s = {}) => `<div class="row">
 <label>GWA<input id="gwa" type="number" step="0.01" value="${s.gwa ?? ''}"></label><label>Enrolled units<input id="units" type="number" value="${s.units ?? ''}"></label>
 <label>Failed<input id="failed" type="number" value="${s.failed_count ?? 0}"></label><label>Incomplete<input id="inc" type="number" value="${s.inc_count ?? 0}"></label>
 <label>Dropped<input id="drop" type="number" value="${s.dropped_count ?? 0}"></label><label>Grade-document reference<input id="ev" value="${esc(s.evidence_ref ?? '')}"></label></div>`;

function scholarView() {
  const ret = subs.find(s => s.verification_status === 'Returned');
  app.innerHTML = `<div class="card"><h2>${ret ? 'Correct returned submission' : 'Submit semester grades'}</h2>
  ${ret ? `<p>${tag('Returned')} Reason: <b>${esc(ret.verification_reason)}</b> (${ret.academic_year} Sem ${ret.semester})</p>` :
  `<div class="row"><label>Academic year<input id="ay" value="2026-2027"></label><label>Semester<select id="sem"><option>1</option><option>2</option></select></label></div>`}
  ${formHTML(ret)}<button id="go">${ret ? 'Resubmit' : 'Submit'}</button></div>
  <div class="card"><h2>My submissions</h2>${subTable(subs, false)}</div>`;
  $('#go').onclick = async () => {
    const v = readForm(); if (!v) return;
    if (ret) return rpc('resubmit_submission', {sid: ret.id, g: v.g, u: v.u, f: v.f, i: v.i, d: v.d, ev: v.ev}, 'Resubmitted. Pending verification.');
    const ay = $('#ay').value.trim(); if (!/^\d{4}-\d{4}$/.test(ay)) return toast('Academic year format: 2026-2027', true);
    const {error} = await db.from('submissions').insert({scholar_id: me.id, academic_year: ay, semester: +$('#sem').value, gwa: v.g, units: v.u,
      failed_count: v.f, inc_count: v.i, dropped_count: v.d, evidence_ref: v.ev});
    error ? toast(error.code === '23505' ? 'Duplicate: a submission for this academic year and semester already exists' : error.message, true) : (toast('Submitted'), load());
  };
}
function subTable(list, staff) {
  return `<table><thead><tr>${staff ? '<th>Student</th><th>Program</th>' : ''}<th>Term</th><th>GWA</th><th>Units</th><th>F/INC/D</th><th>Submitted</th><th>Verification</th><th>Compliance</th><th>Renewal</th></tr></thead><tbody>` +
  list.map(s => { const p = profs.find(x => x.id === s.scholar_id);
    return `<tr data-id="${s.id}" class="${s.id === selId ? 'sel' : ''}">${staff ? `<td>${esc(p?.student_id)} ${esc(p?.full_name)}</td><td>${esc(progOf(s.scholar_id)?.name || '—')}</td>` : ''}
    <td>${s.academic_year} S${s.semester}</td><td>${s.gwa}</td><td>${s.units}</td><td>${s.failed_count}/${s.inc_count}/${s.dropped_count}</td><td>${fmt(s.submitted_at)}</td>
    <td>${tag(s.verification_status)}</td><td>${tag(s.compliance_result)}</td><td>${tag(s.renewal_decision)}</td></tr>`; }).join('') + '</tbody></table>' || '';
}
function staffView() {
  const term = subs.filter(s => s.academic_year === F.ay && String(s.semester) === F.sem);
  const sch = profs.filter(p => asg.some(a => a.scholar_id === p.id)).length;
  const list = term.filter(s => { const p = profs.find(x => x.id === s.scholar_id), q = F.q.toLowerCase();
    return (!q || (p?.student_id + ' ' + p?.full_name).toLowerCase().includes(q)) && (!F.prog || progOf(s.scholar_id)?.name === F.prog) && (!F.comp || s.compliance_result === F.comp); });
  const n = r => term.filter(s => s.compliance_result === r).length;
  app.innerHTML = `<div class="card"><h2>Dashboard</h2><div class="row"><label>Academic year<input id="fay" value="${F.ay}"></label>
   <label>Semester<select id="fsem"><option ${F.sem==='1'?'selected':''}>1</option><option ${F.sem==='2'?'selected':''}>2</option></select></label></div>
   <div class="stats"><div class="stat"><b>${sch}</b>Assigned scholars</div><div class="stat"><b>${term.filter(s => s.verification_status === 'Pending').length}</b>Pending verification</div>
   <div class="stat"><b>${n('Compliant')}</b>Compliant</div><div class="stat"><b>${n('With Deficiency')}</b>With deficiency</div></div></div>
  <div class="card"><h2>Submissions</h2><div class="row"><label>Search ID or name<input id="q" value="${esc(F.q)}"></label>
   <label>Program<select id="fp"><option value="">All</option>${progs.map(p => `<option ${F.prog===p.name?'selected':''}>${p.name}</option>`).join('')}</select></label>
   <label>Compliance<select id="fc"><option value="">All</option>${['Not Evaluated','Compliant','With Deficiency'].map(x => `<option ${F.comp===x?'selected':''}>${x}</option>`).join('')}</select></label></div>
   ${subTable(list, true)}</div><div id="detail"></div>
  <div class="card"><h2>Register scholar</h2><div class="row"><label>Full name<input id="rn"></label><label>Student ID<input id="rs"></label><label>Email<input id="re" type="email"></label>
   <label>Program<select id="rp">${progs.map(p => `<option value="${p.id}">${p.name}</option>`).join('')}</select></label><button id="reg">Register &amp; assign</button></div>
   <small>The scholar signs up with this email to get access. Policy thresholds are stored in the programs table.</small>
   <table><thead><tr><th>Program</th><th>Max GWA</th><th>Min units</th><th>Failed</th><th>INC</th><th>Drop</th><th>Deadline (Manila)</th></tr></thead><tbody>
   ${progs.map(p => `<tr><td>${p.name}</td><td>${p.max_gwa}</td><td>${p.min_units}</td><td>${p.max_failed}</td><td>${p.max_inc}</td><td>${p.max_drop}</td><td>${fmt(p.deadline)}</td></tr>`).join('')}</tbody></table></div>`;
  $('#fay').onchange = e => { F.ay = e.target.value.trim(); staffView(); }; $('#fsem').onchange = e => { F.sem = e.target.value; staffView(); };
  $('#q').oninput = e => { F.q = e.target.value; staffView(); $('#q').focus(); $('#q').setSelectionRange(F.q.length, F.q.length); };
  $('#fp').onchange = e => { F.prog = e.target.value; staffView(); }; $('#fc').onchange = e => { F.comp = e.target.value; staffView(); };
  app.querySelectorAll('tbody tr[data-id]').forEach(tr => tr.onclick = () => { selId = tr.dataset.id; staffView(); });
  $('#reg').onclick = register; if (selId) detail();
}
async function register() {
  const name = $('#rn').value.trim(), sid = $('#rs').value.trim(), em = $('#re').value.trim().toLowerCase();
  if (!name || !sid || !em) return toast('Name, student ID and email are required', true);
  const {data, error} = await db.from('profiles').insert({full_name: name, student_id: sid, email: em, role: 'scholar'}).select().single();
  if (error) return toast(error.message, true);
  const r = await db.from('assignments').insert({scholar_id: data.id, program_id: +$('#rp').value});
  r.error ? toast(r.error.message, true) : (toast('Scholar registered and assigned'), load());
}
async function detail() {
  const s = subs.find(x => x.id === selId); if (!s) return;
  const p = profs.find(x => x.id === s.scholar_id), h = await hist(s.id);
  $('#detail').innerHTML = `<div class="card"><h2>${esc(p?.student_id)} ${esc(p?.full_name)} · ${s.academic_year} S${s.semester}</h2>
  <p>Evidence: <b>${esc(s.evidence_ref)}</b> ${s.verification_reason ? '· Reason: ' + esc(s.verification_reason) : ''}</p>
  <div class="row"><input id="vr" placeholder="Reason (required to return)"><button id="ver">Verify</button><button class="warn" id="retn">Return</button>
   <button id="ev">Evaluate</button></div>
  ${s.compliance_checks ? `<p>${tag(s.compliance_result)}</p><ul>${s.compliance_checks.map(c => `<li class="${c.ok ? 'ok' : 'no'}">${c.ok ? '✔' : '✘'} ${esc(c.name)}: ${esc(c.detail)}</li>`).join('')}</ul>` : ''}
  <div class="row"><input id="note" placeholder="Decision note" value="${esc(s.decision_note || '')}"><button id="apr">Approve renewal</button><button class="warn" id="hold">Hold renewal</button></div>
  <h2>History</h2><table><tbody>${h.map(x => `<tr><td>${fmt(x.created_at)}</td><td>${esc(x.actor)}</td><td>${esc(x.action)}</td><td>${esc(x.detail)}</td></tr>`).join('')}</tbody></table></div>`;
  $('#ver').onclick = () => rpc('verify_submission', {sid: s.id, status: 'Verified', reason: $('#vr').value || null}, 'Verified');
  $('#retn').onclick = () => rpc('verify_submission', {sid: s.id, status: 'Returned', reason: $('#vr').value}, 'Returned');
  $('#ev').onclick = () => rpc('evaluate_submission', {sid: s.id}, 'Evaluated');
  $('#apr').onclick = () => rpc('decide_renewal', {sid: s.id, decision: 'Approved', note: $('#note').value}, 'Renewal approved');
  $('#hold').onclick = () => rpc('decide_renewal', {sid: s.id, decision: 'Held', note: $('#note').value}, 'Renewal held');
}
boot();
