// =================================================================
// features.js — 演奏者端：問卷與紀錄、提醒與衛教、資料授權管理
// =================================================================

// ── 肩背適能自我檢核量表 ─────────────────────────────────────────
// ⚠ 目前為「示意題目」，正式題目、選項與計分方式待研究者提供後替換。
//    每題 options 的 value 即為分數；total = 各題加總。
const SHOULDER_BACK_SCALE = {
  id: 'shoulderBack',
  isSample: true,
  options: [
    { value: 0, zh: '從不', en: 'Never' },
    { value: 1, zh: '很少', en: 'Rarely' },
    { value: 2, zh: '有時', en: 'Sometimes' },
    { value: 3, zh: '經常', en: 'Often' },
    { value: 4, zh: '總是', en: 'Always' }
  ],
  items: [
    { id: 'q1', zh: '（示意）練習後肩頸感到緊繃或痠痛', en: '(Sample) My neck/shoulders feel tight or sore after practice' },
    { id: 'q2', zh: '（示意）練習中需要停下來放鬆肩膀', en: '(Sample) I need to stop and relax my shoulders during practice' },
    { id: 'q3', zh: '（示意）上背部在久坐或久站後感到疲勞', en: '(Sample) My upper back feels tired after long sitting or standing' },
    { id: 'q4', zh: '（示意）抬手或轉頭時感到受限', en: '(Sample) Raising my arms or turning my head feels restricted' }
  ]
};

// ── IPAQ 短版（IPAQ-SF）────────────────────────────────────────
// 計分：MET-min/週 = 8.0×激烈 + 4.0×中等 + 3.3×步行（每日上限 180 分鐘）
const IPAQ_ITEMS = [
  { id: 'vigDays',  type: 'days',    key: 'ipaq_vig_days' },
  { id: 'vigMin',   type: 'minutes', key: 'ipaq_vig_min' },
  { id: 'modDays',  type: 'days',    key: 'ipaq_mod_days' },
  { id: 'modMin',   type: 'minutes', key: 'ipaq_mod_min' },
  { id: 'walkDays', type: 'days',    key: 'ipaq_walk_days' },
  { id: 'walkMin',  type: 'minutes', key: 'ipaq_walk_min' },
  { id: 'sitMin',   type: 'minutes', key: 'ipaq_sit_min' }
];

function scoreIPAQ(a) {
  const cap = m => Math.min(180, Math.max(0, m || 0));
  const days = d => Math.min(7, Math.max(0, d || 0));
  const vig = days(a.vigDays) * cap(a.vigMin);
  const mod = days(a.modDays) * cap(a.modMin);
  const walk = days(a.walkDays) * cap(a.walkMin);
  const vigMET = 8.0 * vig, modMET = 4.0 * mod, walkMET = 3.3 * walk;
  const total = Math.round(vigMET + modMET + walkMET);
  const totalDays = days(a.vigDays) + days(a.modDays) + days(a.walkDays);
  let category = 'low';
  if ((days(a.vigDays) >= 3 && total >= 1500) || (totalDays >= 7 && total >= 3000)) category = 'high';
  else if ((days(a.vigDays) >= 3 && cap(a.vigMin) >= 20) ||
           ((days(a.modDays) + days(a.walkDays)) >= 5 && (cap(a.modMin) >= 30 || cap(a.walkMin) >= 30)) ||
           (totalDays >= 5 && total >= 600)) category = 'moderate';
  return { total, vigMET: Math.round(vigMET), modMET: Math.round(modMET), walkMET: Math.round(walkMET), category, sittingMin: a.sitMin || 0 };
}

// =================================================================
// 問卷與紀錄頁
// =================================================================
function renderRecordsPage() {
  ['pr-date', 'md-date', 'nt-date'].forEach(id => { const el = document.getElementById(id); if (el && !el.value) el.value = todayStr(); });
  renderScaleForm();
  renderIPAQForm();
  renderScaleHistory();
  renderIPAQHistory();
  renderPracticeHistory();
  renderMedicalHistory();
  renderNotesHistory();
}

function onTabSwitched(groupId, tabId) {
  if (groupId === 'records-tabs' && tabId === 'rec-practice') renderPracticeHistory();
  if (groupId === 'case-tabs' && typeof onCaseTabSwitched === 'function') onCaseTabSwitched(tabId);
}

function renderScaleForm() {
  const L = currentLang === 'en' ? 'en' : 'zh';
  document.getElementById('scale-sample-flag').style.display = SHOULDER_BACK_SCALE.isSample ? 'block' : 'none';
  const el = document.getElementById('scale-items');
  const prev = {};
  el.querySelectorAll('input:checked').forEach(i => { prev[i.name] = i.value; });
  el.innerHTML = SHOULDER_BACK_SCALE.items.map((it, i) => `
    <div class="q-item">
      <div class="q-text">${i + 1}. ${escapeHtml(it[L])}</div>
      <div class="q-scale">${SHOULDER_BACK_SCALE.options.map(o => `
        <label><input type="radio" name="scale-${it.id}" value="${o.value}" ${prev['scale-' + it.id] == o.value ? 'checked' : ''}> ${escapeHtml(o[L])}</label>`).join('')}
      </div>
    </div>`).join('');
}

async function submitScale() {
  const answers = {};
  for (const it of SHOULDER_BACK_SCALE.items) {
    const c = document.querySelector(`input[name="scale-${it.id}"]:checked`);
    if (!c) { showToast(tApp('toast_answer_all'), 'warning'); return; }
    answers[it.id] = Number(c.value);
  }
  const score = Object.values(answers).reduce((a, b) => a + b, 0);
  const max = SHOULDER_BACK_SCALE.items.length * Math.max(...SHOULDER_BACK_SCALE.options.map(o => o.value));
  try {
    await DataAPI.addSub(App.user.uid, 'questionnaires', {
      type: 'shoulderBack', phase: document.getElementById('scale-phase').value,
      answers, score, maxScore: max, isSample: SHOULDER_BACK_SCALE.isSample
    });
    await refreshPerformerSub('questionnaires', 'questionnaires');
    document.querySelectorAll('#scale-items input').forEach(i => { i.checked = false; });
    renderScaleHistory();
    showToast(tApp('toast_submitted_score', { score, max }), 'success');
  } catch (e) { console.error(e); showToast(tApp('toast_save_fail'), 'danger'); }
}

function phaseLabel(p) { return tApp('phase_' + (p || 'routine')); }

function renderScaleHistory() {
  const list = App.questionnaires.filter(q => q.type === 'shoulderBack');
  document.getElementById('scale-history').innerHTML = list.length ? list.map(q => `
    <div class="list-item">
      <div class="list-item-main">
        <div class="list-item-title">${phaseLabel(q.phase)} · ${tApp('score_text', { score: q.score, max: q.maxScore || '--' })} ${q.isSample ? `<span class="badge badge-warning">${tApp('badge_sample')}</span>` : ''}</div>
        <div class="list-item-sub">${fmtDateTime(docTimeMs(q))}</div>
      </div>
      <button class="btn btn-danger-outline btn-sm" onclick="deletePerformerItem('questionnaires','questionnaires','${q.firestoreId}', renderScaleHistory)"><i data-lucide="trash-2"></i></button>
    </div>`).join('') : `<p class="empty-state">${tApp('empty_list')}</p>`;
  lucide.createIcons();
}

function renderIPAQForm() {
  const el = document.getElementById('ipaq-items');
  if (el.dataset.lang === currentLang) return;
  const keep = {};
  el.querySelectorAll('input').forEach(i => { keep[i.id] = i.value; });
  el.dataset.lang = currentLang;
  el.innerHTML = IPAQ_ITEMS.map(it => `
    <div class="form-group">
      <label for="ipaq-${it.id}">${tApp(it.key)}</label>
      <input type="number" id="ipaq-${it.id}" class="form-control" style="max-width:220px;" min="0" max="${it.type === 'days' ? 7 : 1440}" placeholder="${tApp(it.type === 'days' ? 'ph_days' : 'ph_minutes')}" value="${keep['ipaq-' + it.id] || ''}">
    </div>`).join('');
}

async function submitIPAQ() {
  const a = {};
  for (const it of IPAQ_ITEMS) {
    const v = document.getElementById(`ipaq-${it.id}`).value;
    if (v === '') { showToast(tApp('toast_answer_all'), 'warning'); return; }
    a[it.id] = Number(v);
  }
  const result = scoreIPAQ(a);
  try {
    await DataAPI.addSub(App.user.uid, 'questionnaires', {
      type: 'ipaq', version: 'IPAQ-SF', phase: document.getElementById('ipaq-phase').value,
      answers: a, score: result.total, result
    });
    await refreshPerformerSub('questionnaires', 'questionnaires');
    document.querySelectorAll('#ipaq-items input').forEach(i => { i.value = ''; });
    renderIPAQHistory();
    showToast(tApp('toast_ipaq_done', { met: result.total, cat: tApp('ipaq_cat_' + result.category) }), 'success');
  } catch (e) { console.error(e); showToast(tApp('toast_save_fail'), 'danger'); }
}

function renderIPAQHistory() {
  const list = App.questionnaires.filter(q => q.type === 'ipaq');
  document.getElementById('ipaq-history').innerHTML = list.length ? list.map(q => `
    <div class="list-item">
      <div class="list-item-main">
        <div class="list-item-title">${phaseLabel(q.phase)} · ${q.score} MET-min/${tApp('unit_week')} · ${tApp('ipaq_cat_' + (q.result ? q.result.category : 'low'))}</div>
        <div class="list-item-sub">${fmtDateTime(docTimeMs(q))}${q.result ? ` · ${tApp('ipaq_sitting')} ${q.result.sittingMin} ${tApp('unit_min')}/${tApp('unit_day')}` : ''}</div>
      </div>
      <button class="btn btn-danger-outline btn-sm" onclick="deletePerformerItem('questionnaires','questionnaires','${q.firestoreId}', renderIPAQHistory)"><i data-lucide="trash-2"></i></button>
    </div>`).join('') : `<p class="empty-state">${tApp('empty_list')}</p>`;
  lucide.createIcons();
}

// ── 練習時間 ─────────────────────────────────────────────────────
async function submitPracticeLog() {
  const date = document.getElementById('pr-date').value;
  const minutes = Number(document.getElementById('pr-minutes').value);
  if (!date || !minutes || minutes <= 0) { showToast(tApp('toast_fill_required'), 'warning'); return; }
  const ms = dateInputToMs(date) + 12 * 3600000;
  try {
    await DataAPI.addSub(App.user.uid, 'practiceSessions', {
      source: 'manual', durationSec: minutes * 60, note: document.getElementById('pr-note').value.trim(),
      createdAtMs: ms, dateKey: date
    });
    await refreshPerformerSub('practiceSessions', 'practiceLogs');
    document.getElementById('pr-minutes').value = '';
    document.getElementById('pr-note').value = '';
    renderPracticeHistory();
    showToast(tApp('toast_added'), 'success');
  } catch (e) { console.error(e); showToast(tApp('toast_save_fail'), 'danger'); }
}

function renderPracticeHistory() {
  const list = App.practiceLogs;
  document.getElementById('practice-history').innerHTML = list.length ? list.slice(0, 50).map(p => `
    <div class="list-item">
      <div class="list-item-main">
        <div class="list-item-title">${p.dateKey || fmtDate(docTimeMs(p))} · ${fmtMinutes(p.durationSec)} ${tApp('unit_min')}
          <span class="badge ${p.source === 'detection' ? 'badge-info' : 'badge-muted'}">${tApp(p.source === 'detection' ? 'source_detection' : 'source_manual')}</span></div>
        <div class="list-item-sub">${p.source === 'detection' ? `${tApp('ps_bad')} ${fmtClock(p.badPostureSec)} · ${tApp('ps_alerts')} ${p.alertCount || 0}` : escapeHtml(p.note || '')}</div>
      </div>
      ${p.source === 'manual' ? `<button class="btn btn-danger-outline btn-sm" onclick="deletePerformerItem('practiceSessions','practiceLogs','${p.firestoreId}', renderPracticeHistory)"><i data-lucide="trash-2"></i></button>` : ''}
    </div>`).join('') : `<p class="empty-state">${tApp('empty_list')}</p>`;
  lucide.createIcons();
  renderPracticeChart();
}

function practiceByDay(logs, days = 14) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const k = dateKeyOf(Date.now() - i * 86400000);
    const sec = logs.filter(p => (p.dateKey || dateKeyOf(docTimeMs(p))) === k).reduce((a, p) => a + (p.durationSec || 0), 0);
    out.push({ k, min: Math.round(sec / 60) });
  }
  return out;
}

function renderPracticeChart() {
  const canvas = document.getElementById('practiceChart');
  if (!canvas || !canvas.offsetParent) return;
  const data = practiceByDay(App.practiceLogs);
  ChartRegistry.set('practice', () => new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: { labels: data.map(d => d.k.slice(5)), datasets: [{ label: tApp('chart_practice_min'), data: data.map(d => d.min), backgroundColor: 'rgba(13,86,97,0.7)', borderRadius: 4 }] },
    options: baseChartOptions({ plugins: { legend: { display: false } } })
  }));
}

// ── 就醫及用藥 ───────────────────────────────────────────────────
async function submitMedicalLog() {
  const date = document.getElementById('md-date').value;
  const department = document.getElementById('md-dept').value.trim();
  const reason = document.getElementById('md-reason').value.trim();
  const medication = document.getElementById('md-meds').value.trim();
  if (!date || (!department && !reason && !medication)) { showToast(tApp('toast_fill_required'), 'warning'); return; }
  try {
    await DataAPI.addSub(App.user.uid, 'medicalLogs', { date, department, reason, medication, createdAtMs: dateInputToMs(date) + 12 * 3600000, dateKey: date });
    await refreshPerformerSub('medicalLogs', 'medicalLogs');
    ['md-dept', 'md-reason', 'md-meds'].forEach(id => { document.getElementById(id).value = ''; });
    renderMedicalHistory();
    showToast(tApp('toast_added'), 'success');
  } catch (e) { console.error(e); showToast(tApp('toast_save_fail'), 'danger'); }
}

function medicalItemHtml(m, deletable) {
  return `<div class="list-item">
    <div class="list-item-main">
      <div class="list-item-title">${escapeHtml(m.date || '')} · ${escapeHtml(m.department || '--')}</div>
      <div class="list-item-sub">${m.reason ? tApp('label_reason') + '：' + escapeHtml(m.reason) + '\n' : ''}${m.medication ? tApp('label_medication') + '：' + escapeHtml(m.medication) : ''}</div>
    </div>
    ${deletable ? `<button class="btn btn-danger-outline btn-sm" onclick="deletePerformerItem('medicalLogs','medicalLogs','${m.firestoreId}', renderMedicalHistory)"><i data-lucide="trash-2"></i></button>` : ''}
  </div>`;
}
function renderMedicalHistory() {
  document.getElementById('medical-history').innerHTML = App.medicalLogs.length
    ? App.medicalLogs.map(m => medicalItemHtml(m, true)).join('') : `<p class="empty-state">${tApp('empty_list')}</p>`;
  lucide.createIcons();
}

// ── 筆記 ─────────────────────────────────────────────────────────
async function submitNote() {
  const date = document.getElementById('nt-date').value;
  const content = document.getElementById('nt-content').value.trim();
  if (!date || !content) { showToast(tApp('toast_fill_required'), 'warning'); return; }
  try {
    const ms = date === todayStr() ? Date.now() : dateInputToMs(date) + 12 * 3600000;
    await DataAPI.addSub(App.user.uid, 'notes', { date, content, createdAtMs: ms, dateKey: date });
    await refreshPerformerSub('notes', 'notes');
    document.getElementById('nt-content').value = '';
    renderNotesHistory();
    showToast(tApp('toast_added'), 'success');
  } catch (e) { console.error(e); showToast(tApp('toast_save_fail'), 'danger'); }
}
function noteItemHtml(n, deletable) {
  return `<div class="list-item">
    <div class="list-item-main"><div class="list-item-title">${escapeHtml(n.date || fmtDate(docTimeMs(n)))}</div><div class="list-item-sub">${escapeHtml(n.content || '')}</div></div>
    ${deletable ? `<button class="btn btn-danger-outline btn-sm" onclick="deletePerformerItem('notes','notes','${n.firestoreId}', renderNotesHistory)"><i data-lucide="trash-2"></i></button>` : ''}
  </div>`;
}
function renderNotesHistory() {
  document.getElementById('notes-history').innerHTML = App.notes.length
    ? App.notes.map(n => noteItemHtml(n, true)).join('') : `<p class="empty-state">${tApp('empty_list')}</p>`;
  lucide.createIcons();
}

async function deletePerformerItem(sub, key, id, rerender) {
  if (!confirm(tApp('confirm_delete'))) return;
  try {
    await DataAPI.deleteSub(App.user.uid, sub, id);
    await refreshPerformerSub(sub, key);
    if (typeof rerender === 'function') rerender();
    showToast(tApp('toast_deleted'), 'info');
  } catch (e) { console.error(e); showToast(tApp('toast_delete_fail'), 'danger'); }
}

// =================================================================
// 提醒（依規則觸發；LLM「提醒」功能的規則版）
// =================================================================
function generateReminders() {
  const out = [];
  const now = Date.now();
  const playing = App.records.filter(r => r.type === 'playing');
  const latest = playing[0] ? recordMetrics(playing[0]) : null;
  const th = SYSTEM_RULES.REMINDER_OVER_PCT;

  if (!playing.length || now - docTimeMs(playing[0]) > 7 * 86400000) {
    out.push({ level: 'warning', title: tApp('rem_no_assess_title'), text: tApp('rem_no_assess_text') });
  }
  if (latest) {
    if (latest.cvaBelowPct !== null && latest.cvaBelowPct >= th) out.push({ level: 'danger', title: tApp('rem_cva_title'), text: tApp('rem_cva_text', { pct: fmtNum(latest.cvaBelowPct, 0) }) });
    if (latest.shoulderOverPct !== null && latest.shoulderOverPct >= th) out.push({ level: 'danger', title: tApp('rem_shoulder_title'), text: tApp('rem_shoulder_text', { pct: fmtNum(latest.shoulderOverPct, 0) }) });
    if (latest.elbowOverPct !== null && latest.elbowOverPct >= th) out.push({ level: 'warning', title: tApp('rem_elbow_title'), text: tApp('rem_elbow_text', { pct: fmtNum(latest.elbowOverPct, 0) }) });
    const pre = App.bodyMaps.find(m => m.recordId === latest.id && m.context === 'pre');
    const post = App.bodyMaps.find(m => m.recordId === latest.id && m.context === 'post');
    if (post && (post.marks || []).length > ((pre && pre.marks) || []).length) {
      out.push({ level: 'warning', title: tApp('rem_discomfort_title'), text: tApp('rem_discomfort_text', { parts: BodyMap.summarize(post.marks) }) });
    }
  }
  const p = App.profile || {};
  const weekSec = App.practiceLogs.filter(x => docTimeMs(x) >= now - 7 * 86400000).reduce((a, x) => a + (x.durationSec || 0), 0);
  const usual = (p.practiceDaysPerWeek || 0) * (p.practiceMinutesPerSession || 0) * 60;
  if (usual > 0 && weekSec > usual * 1.3) {
    out.push({ level: 'warning', title: tApp('rem_practice_title'), text: tApp('rem_practice_text', { min: fmtMinutes(weekSec) }) });
  }
  if (!App.questionnaires.some(q => q.type === 'shoulderBack' && q.phase === 'pre')) {
    out.push({ level: '', title: tApp('rem_scale_title'), text: tApp('rem_scale_text') });
  }
  if (!App.questionnaires.some(q => q.type === 'ipaq')) {
    out.push({ level: '', title: tApp('rem_ipaq_title'), text: tApp('rem_ipaq_text') });
  }
  const order = { danger: 0, warning: 1, '': 2, success: 3 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

// =================================================================
// 衛教與問答
// =================================================================
// 衛教主題（內容待研究團隊審核；可納入文獻、照護專業建議與音樂教師建議）
const EDU_TOPICS = [
  { icon: 'flame', key: 'warmup' },
  { icon: 'coffee', key: 'rest' },
  { icon: 'scan-face', key: 'neck' },
  { icon: 'move', key: 'shoulder' },
  { icon: 'hand', key: 'arm' },
  { icon: 'siren', key: 'redflag' }
];

function renderEducationPage() {
  const rem = generateReminders();
  document.getElementById('edu-reminders').innerHTML = rem.length ? rem.map(reminderItemHtml).join('') : `<p class="empty-state">${tApp('dash_no_reminders')}</p>`;
  document.getElementById('edu-advice').innerHTML = App.advice.length ? App.advice.map(adviceItemHtml).join('') : `<p class="empty-state">${tApp('dash_no_advice')}</p>`;
  document.getElementById('edu-topics').innerHTML = EDU_TOPICS.map(t => `
    <div class="tip-item ${t.key === 'redflag' ? 'danger' : ''}">
      <strong style="display:flex; align-items:center; gap:0.4rem;"><i data-lucide="${t.icon}" style="width:16px;height:16px;"></i>${tApp('edu_' + t.key + '_title')}</strong>
      <p>${tApp('edu_' + t.key + '_text')}</p>
    </div>`).join('');
  lucide.createIcons();
}

// =================================================================
// 資料授權管理（演奏者端）
// =================================================================
function bindingStatusBadge(status) {
  const cls = { pending: 'badge-warning', active: 'badge-success', revoked: 'badge-muted', declined: 'badge-danger' }[status] || 'badge-muted';
  return `<span class="badge ${cls}">${tApp('binding_' + status)}</span>`;
}

async function renderAuthorizationPage() {
  try { App.bindings = await DataAPI.listBindings('performerUid', App.user.uid); } catch (e) { console.warn(e); }
  const el = document.getElementById('auth-binding-list');
  const list = App.bindings.slice().sort((a, b) => (b.updatedAtMs || 0) - (a.updatedAtMs || 0));
  el.innerHTML = list.length ? list.map(b => `
    <div class="list-item">
      <div class="list-item-main">
        <div class="list-item-title">${escapeHtml(b.providerName || '--')} <span class="muted small">${escapeHtml(b.providerTitleText || '')}</span> ${bindingStatusBadge(b.status)}</div>
        <div class="list-item-sub">${escapeHtml(b.providerInstitution || '')}${b.providerInstitution ? ' · ' : ''}${tApp('binding_since', { date: fmtDate(b.createdAtMs) })}${b.status === 'revoked' && b.revokedAtMs ? ' · ' + tApp('binding_revoked_at', { date: fmtDate(b.revokedAtMs) }) : ''}</div>
      </div>
      <div style="display:flex; gap:0.4rem;">
        ${b.status === 'active' || b.status === 'pending'
          ? `<button class="btn btn-danger-outline btn-sm" onclick="revokeBinding('${b.providerUid}')"><i data-lucide="user-x"></i>${tApp(b.status === 'pending' ? 'btn_cancel_invite' : 'btn_revoke')}</button>`
          : `<button class="btn btn-outline btn-sm" onclick="reinviteBinding('${b.providerUid}')"><i data-lucide="rotate-ccw"></i>${tApp('btn_reinvite')}</button>`}
      </div>
    </div>`).join('') : `<p class="empty-state">${tApp('auth_empty')}</p>`;
  lucide.createIcons();
}

async function requestBinding() {
  const raw = document.getElementById('auth-input').value.trim();
  if (!raw) { showToast(tApp('toast_fill_required'), 'warning'); return; }
  try {
    let found;
    if (raw.includes('@')) {
      found = await DataAPI.findProvider('profile.emailLower', raw.toLowerCase());
      if (!found.length) found = await DataAPI.findProvider('profile.email', raw);
    } else {
      found = await DataAPI.findProvider('inviteCode', raw.toUpperCase());
    }
    if (!found.length) { showToast(tApp('toast_provider_not_found'), 'warning'); return; }
    if (found.length > 1) { showToast(tApp('toast_provider_ambiguous'), 'warning'); return; }
    const prov = found[0];
    if (prov.uid === App.user.uid) { showToast(tApp('toast_cannot_self'), 'warning'); return; }
    const existing = App.bindings.find(b => b.providerUid === prov.uid);
    if (existing && existing.status === 'active') { showToast(tApp('toast_already_bound'), 'info'); return; }
    const pp = prov.profile || {};
    if (!confirm(tApp('confirm_invite', { name: pp.name || '', title: providerTitleText(pp), inst: pp.institution || '' }))) return;
    await DataAPI.setBinding(App.user.uid, prov.uid, {
      performerUid: App.user.uid, providerUid: prov.uid,
      performerName: App.profile.username || '', performerInstrument: App.profile.instrument || '',
      providerName: pp.name || '', providerTitleText: providerTitleText(pp), providerInstitution: pp.institution || '',
      status: 'pending', createdAtMs: Date.now(), revokedAtMs: null
    });
    document.getElementById('auth-input').value = '';
    showToast(tApp('toast_invite_sent'), 'success');
    renderAuthorizationPage();
  } catch (e) {
    console.error(e);
    showToast(tApp('toast_save_fail'), 'danger');
  }
}

async function revokeBinding(providerUid) {
  if (!confirm(tApp('confirm_revoke'))) return;
  try {
    await DataAPI.setBinding(App.user.uid, providerUid, { status: 'revoked', revokedAtMs: Date.now() });
    showToast(tApp('toast_revoked'), 'info');
    renderAuthorizationPage();
  } catch (e) { console.error(e); showToast(tApp('toast_save_fail'), 'danger'); }
}

async function reinviteBinding(providerUid) {
  try {
    await DataAPI.setBinding(App.user.uid, providerUid, {
      status: 'pending', createdAtMs: Date.now(), revokedAtMs: null,
      performerName: App.profile.username || '', performerInstrument: App.profile.instrument || ''
    });
    showToast(tApp('toast_invite_sent'), 'success');
    renderAuthorizationPage();
  } catch (e) { console.error(e); showToast(tApp('toast_save_fail'), 'danger'); }
}
