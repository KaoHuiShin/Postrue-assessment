// =================================================================
// provider.js — 照護端（醫師／物理治療師）
//   1. 獲授權的個案名單　2. 個案儀表板及歷史趨勢　3. 多次比較
//   4. 異常狀況及比例統計　5. 照護建議輸入　6. 報告列印及歸檔
// 讀取權限由 Firestore Security Rules 依 bindings 的 status == 'active' 控制
// =================================================================

const Prov = {
  bindings: [],
  caseSummaries: {},     // uid → { lastMs, overDaysPct, concern }
  currentUid: null,
  data: null,            // 目前個案的完整資料
  period: { mode: 'lastVisit', from: null, to: null },
  caseTab: 'case-overview'
};

async function loadProviderData() {
  const me = App.user.uid;
  try { App.providerDoc = await DataAPI.getProvider(me) || App.providerDoc; } catch (e) { console.warn(e); }
  try { Prov.bindings = await DataAPI.listBindings('providerUid', me); } catch (e) { console.warn(e); Prov.bindings = []; }
  const active = Prov.bindings.filter(b => b.status === 'active');
  const since = Date.now() - 30 * 86400000;
  await Promise.all(active.map(async b => {
    try {
      const recs = await DataAPI.listSub(b.performerUid, 'records');
      const playing = recs.filter(r => r.type === 'playing');
      const stats = computeAbnormalStats(filterByPeriod(playing, since, null), since, Date.now());
      Prov.caseSummaries[b.performerUid] = {
        lastMs: playing.length ? docTimeMs(playing[0]) : null,
        overDaysPct: stats.overDaysPct,
        recordedDays: stats.recordedDays,
        concern: stats.overDaysPct !== null && stats.overDaysPct >= SYSTEM_RULES.CONCERN_DAY_PCT
      };
    } catch (e) {
      console.warn('讀取個案資料失敗', b.performerUid, e);
      Prov.caseSummaries[b.performerUid] = { error: true };
    }
  }));
  const pending = Prov.bindings.filter(b => b.status === 'pending').length;
  const badge = document.getElementById('nav-pending-badge');
  badge.style.display = pending ? 'inline-block' : 'none';
  badge.textContent = pending;
  updateHeaderNames();
  updateCaseNavState();
}

function updateCaseNavState() {
  const has = !!Prov.currentUid;
  document.getElementById('nav-provider-case').classList.toggle('disabled', !has);
  document.getElementById('nav-provider-advice').classList.toggle('disabled', !has);
}

// =================================================================
// 1. 個案總覽
// =================================================================
function renderCaseList() {
  const code = App.providerDoc ? App.providerDoc.inviteCode : '------';
  document.getElementById('provider-invite-code').textContent = code || '------';
  document.getElementById('pc-rule-text').textContent = tApp('pc_rule', { day: SYSTEM_RULES.DAY_OVER_FRAME_PCT, concern: SYSTEM_RULES.CONCERN_DAY_PCT });

  // 待確認邀請
  const pending = Prov.bindings.filter(b => b.status === 'pending');
  document.getElementById('pending-invites').innerHTML = pending.length ? pending.map(b => `
    <div class="list-item">
      <div class="list-item-main">
        <div class="list-item-title">${escapeHtml(b.performerName || '--')}</div>
        <div class="list-item-sub">${escapeHtml(instrumentLabel(b.performerInstrument))} · ${fmtDate(b.createdAtMs)}</div>
      </div>
      <div style="display:flex; gap:0.35rem;">
        <button class="btn btn-primary btn-sm" onclick="respondInvite('${b.performerUid}', 'active')">${tApp('btn_accept')}</button>
        <button class="btn btn-outline btn-sm" onclick="respondInvite('${b.performerUid}', 'declined')">${tApp('btn_decline')}</button>
      </div>
    </div>`).join('') : `<p class="empty-state">${tApp('pc_no_pending')}</p>`;

  // 個案表
  const sort = document.getElementById('pc-sort').value;
  const rows = Prov.bindings.filter(b => b.status === 'active').map(b => ({ b, s: Prov.caseSummaries[b.performerUid] || {} }));
  rows.sort((x, y) => {
    if (sort === 'name') return (x.b.performerName || '').localeCompare(y.b.performerName || '');
    if (sort === 'recent') return (y.s.lastMs || 0) - (x.s.lastMs || 0);
    return (y.s.overDaysPct ?? -1) - (x.s.overDaysPct ?? -1);
  });
  const tbody = document.getElementById('case-table-body');
  tbody.innerHTML = rows.length ? rows.map(({ b, s }) => {
    const status = s.error ? `<span class="badge badge-muted">${tApp('pc_no_access')}</span>`
      : (s.overDaysPct === null || s.overDaysPct === undefined) ? `<span class="badge badge-muted">${tApp('pc_no_data')}</span>`
      : s.concern ? `<span class="badge badge-danger">${tApp('pc_concern')}</span>` : `<span class="badge badge-success">${tApp('pc_stable')}</span>`;
    return `<tr>
      <td><strong>${escapeHtml(b.performerName || '--')}</strong></td>
      <td>${escapeHtml(instrumentLabel(b.performerInstrument))}</td>
      <td>${s.lastMs ? fmtDate(s.lastMs) : '--'}</td>
      <td>${s.overDaysPct === null || s.overDaysPct === undefined ? '--' : `${fmtNum(s.overDaysPct, 0)}% <span class="muted small">(${s.recordedDays} ${tApp('unit_days_recorded')})</span>`}</td>
      <td>${status}</td>
      <td><button class="btn btn-outline btn-sm" onclick="openCase('${b.performerUid}')"><i data-lucide="line-chart"></i>${tApp('btn_view')}</button></td>
    </tr>`;
  }).join('') : `<tr><td colspan="6"><div class="empty-state"><i data-lucide="users"></i>${tApp('pc_empty')}</div></td></tr>`;
  lucide.createIcons();
}

async function respondInvite(performerUid, status) {
  try {
    const patch = { status };
    if (status === 'active') patch.acceptedAtMs = Date.now();
    await DataAPI.setBinding(performerUid, App.user.uid, patch);
    showToast(tApp(status === 'active' ? 'toast_invite_accepted' : 'toast_invite_declined'), status === 'active' ? 'success' : 'info');
    await loadProviderData();
    renderCaseList();
  } catch (e) { console.error(e); showToast(tApp('toast_save_fail'), 'danger'); }
}

// =================================================================
// 2–4. 個案儀表板
// =================================================================
async function openCase(uid) {
  if (!uid) return;
  const b = Prov.bindings.find(x => x.performerUid === uid && x.status === 'active');
  if (!b) { showToast(tApp('pc_no_access'), 'warning'); return; }
  Prov.currentUid = uid;
  const me = App.user.uid;
  const safe = async (fn) => { try { return await fn(); } catch (e) { console.warn(e); return []; } };
  try {
    const doc = await DataAPI.getUserDoc(uid);
    const [records, bodyMaps, questionnaires, practiceLogs, medicalLogs, notes, advice, followups, archives] = await Promise.all([
      safe(() => DataAPI.listSub(uid, 'records')), safe(() => DataAPI.listSub(uid, 'bodyMaps')),
      safe(() => DataAPI.listSub(uid, 'questionnaires')), safe(() => DataAPI.listSub(uid, 'practiceSessions')),
      safe(() => DataAPI.listSub(uid, 'medicalLogs')), safe(() => DataAPI.listSub(uid, 'notes')),
      safe(() => DataAPI.listSub(uid, 'notesFromProviders')),
      safe(() => DataAPI.listProviderSub(me, 'followups', uid)), safe(() => DataAPI.listProviderSub(me, 'archives', uid))
    ]);
    Prov.data = { uid, binding: b, profile: (doc && doc.profile) || {}, records, bodyMaps, questionnaires, practiceLogs, medicalLogs, notes, advice, followups, archives };
  } catch (e) {
    console.error(e);
    showToast(tApp('toast_load_fail'), 'danger');
    return;
  }
  Prov.period = { mode: 'lastVisit', from: null, to: null };
  updateCaseNavState();
  switchSection('provider-case');
}

function lastVisitMs() {
  const d = Prov.data;
  if (!d) return null;
  const mine = d.advice.filter(a => a.providerUid === App.user.uid).map(docTimeMs);
  // 只計算「今天以前」的就診，避免當天寫完建議或歸檔後期間被重置為空
  const startOfToday = dateInputToMs(todayStr());
  const all = [...mine, ...d.followups.map(docTimeMs), ...d.archives.map(docTimeMs)].filter(t => t && t < startOfToday);
  return all.length ? Math.max(...all) : null;
}

function getCasePeriod() {
  const now = Date.now();
  const p = Prov.period;
  if (p.mode === 'custom') return { from: p.from, to: p.to, note: '' };
  if (p.mode === 'all') return { from: null, to: null, note: '' };
  if (p.mode === '90') return { from: now - 90 * 86400000, to: now, note: '' };
  if (p.mode === 'lastVisit') {
    const lv = lastVisitMs();
    if (lv) return { from: lv, to: now, note: tApp('period_since_visit', { date: fmtDate(lv) }) };
    return { from: now - 30 * 86400000, to: now, note: tApp('period_no_visit') };
  }
  return { from: now - 30 * 86400000, to: now, note: '' };
}

function setCasePeriod(mode) {
  if (mode === 'custom') {
    const f = document.getElementById('case-from').value, t = document.getElementById('case-to').value;
    if (!f || !t) return;
    Prov.period = { mode, from: dateInputToMs(f), to: dateInputToMs(t, true) };
  } else {
    Prov.period = { mode, from: null, to: null };
  }
  renderCaseDashboard();
}

function caseInPeriod(key) {
  const { from, to } = getCasePeriod();
  return filterByPeriod(Prov.data[key], from, to);
}

function renderCaseDashboard() {
  if (!Prov.data) { switchSection('provider-cases'); return; }
  const d = Prov.data;
  const p = d.profile;
  document.getElementById('case-title-name').textContent = p.username || d.binding.performerName || '--';
  const age = ageFromBirthdate(p.birthdate) ?? p.age;
  document.getElementById('case-title-sub').textContent = [instrumentLabel(p.instrument), optionLabel(GENDER_KEYS, p.gender), age !== null && age !== undefined ? tApp('age_hint', { age }) : null, optionLabel(IDENTITY_KEYS, p.identity)].filter(x => x && x !== '--').join(' · ');

  const sw = document.getElementById('case-switcher');
  sw.innerHTML = Prov.bindings.filter(b => b.status === 'active').map(b => `<option value="${b.performerUid}" ${b.performerUid === d.uid ? 'selected' : ''}>${escapeHtml(b.performerName || b.performerUid)}</option>`).join('');

  document.querySelectorAll('#case-period-bar [data-period]').forEach(btn => btn.classList.toggle('active', btn.dataset.period === Prov.period.mode));
  const per = getCasePeriod();
  if (Prov.period.mode !== 'custom') {
    document.getElementById('case-from').value = per.from ? dateKeyOf(per.from) : '';
    document.getElementById('case-to').value = per.to ? dateKeyOf(per.to) : '';
  }
  document.getElementById('case-period-text').textContent = per.note || (per.from ? `${fmtDate(per.from)} ~ ${fmtDate(per.to)}` : tApp('period_all'));

  // 比較期間預設：B＝目前期間，A＝前一段等長期間
  const now = Date.now();
  const bFrom = per.from || (d.records.length ? docTimeMs(d.records[d.records.length - 1]) : now - 30 * 86400000);
  const bTo = per.to || now;
  const len = Math.max(86400000, bTo - bFrom);
  document.getElementById('cmp-b-from').value = dateKeyOf(bFrom);
  document.getElementById('cmp-b-to').value = dateKeyOf(bTo);
  document.getElementById('cmp-a-from').value = dateKeyOf(bFrom - len);
  document.getElementById('cmp-a-to').value = dateKeyOf(bFrom - 1);

  renderCaseTab(Prov.caseTab);
}

function onCaseTabSwitched(tabId) { Prov.caseTab = tabId; renderCaseTab(tabId); }

function renderCaseTab(tab) {
  if (!Prov.data) return;
  if (tab === 'case-overview') renderCaseOverview();
  if (tab === 'case-compare') renderCaseCompare();
  if (tab === 'case-detail') renderCaseDetail();
  if (tab === 'case-profile') renderCaseProfile();
  lucide.createIcons();
}

function periodMetrics(fromMs, toMs) {
  const d = Prov.data;
  const recs = filterByPeriod(d.records, fromMs, toMs).filter(r => r.type === 'playing');
  const ms = recs.map(recordMetrics);
  const mean = k => { const v = ms.map(m => m[k]).filter(x => x !== null && x !== undefined); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const stats = computeAbnormalStats(recs, fromMs, toMs);
  const practice = filterByPeriod(d.practiceLogs, fromMs, toMs);
  const quest = filterByPeriod(d.questionnaires, fromMs, toMs);
  const ipaq = quest.find(q => q.type === 'ipaq');
  const scale = quest.find(q => q.type === 'shoulderBack');
  const postMaps = filterByPeriod(d.bodyMaps, fromMs, toMs).filter(m => m.context === 'post');
  const marks = postMaps.flatMap(m => m.marks || []);
  const regionCount = {};
  marks.forEach(m => { regionCount[m.region] = (regionCount[m.region] || 0) + 1; });
  return {
    count: recs.length, recs, metrics: ms, stats,
    score: mean('score'), cvaAvg: mean('cvaAvg'), cvaBelowPct: mean('cvaBelowPct'),
    shoulderAvg: mean('shoulderAvg'), shoulderOverPct: mean('shoulderOverPct'),
    leftElbowAvg: mean('leftElbowAvg'), rightElbowAvg: mean('rightElbowAvg'), elbowOverPct: mean('elbowOverPct'),
    practiceMin: Math.round(practice.reduce((a, p) => a + (p.durationSec || 0), 0) / 60),
    badMin: Math.round(practice.reduce((a, p) => a + (p.badPostureSec || 0), 0) / 60),
    ipaq: ipaq ? ipaq.score : null, ipaqCat: ipaq && ipaq.result ? ipaq.result.category : null,
    scale: scale ? scale.score : null, scaleMax: scale ? scale.maxScore : null,
    notes: filterByPeriod(d.notes, fromMs, toMs).length,
    marks, regionCount, postMapsCount: postMaps.length
  };
}

function renderCaseOverview() {
  const per = getCasePeriod();
  const pm = periodMetrics(per.from, per.to);
  const st = pm.stats;
  document.getElementById('cs-count').textContent = pm.count;
  document.getElementById('cs-over-days').textContent = st.overDaysPct === null ? '--' : `${fmtNum(st.overDaysPct, 0)}%`;
  document.getElementById('cs-practice').textContent = pm.practiceMin;
  document.getElementById('cs-bad-ratio').textContent = st.meanOverAny === null ? '--' : `${fmtNum(st.meanOverAny, 0)}%`;

  // 趨勢圖
  const ms = pm.metrics.slice().reverse();
  const canvas = document.getElementById('caseTrendChart');
  ChartRegistry.set('caseTrend', () => new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: ms.map(m => fmtDate(m.ms).slice(5)),
      datasets: [
        { label: tApp('metric_cva_avg') + ' (°)', data: ms.map(m => m.cvaAvg), borderColor: CHART_COLORS.cva, borderWidth: 2.5, tension: 0.2 },
        { label: tApp('metric_shoulder') + ' Δ (°)', data: ms.map(m => m.shoulderAvg), borderColor: CHART_COLORS.shoulder, borderWidth: 2, tension: 0.2 },
        { label: tApp('metric_left_elbow') + ' (°)', data: ms.map(m => m.leftElbowAvg), borderColor: CHART_COLORS.leftElbow, borderWidth: 2, tension: 0.2 },
        { label: tApp('metric_right_elbow') + ' (°)', data: ms.map(m => m.rightElbowAvg), borderColor: CHART_COLORS.rightElbow, borderWidth: 2, tension: 0.2 },
        { label: tApp('threshold_label', { v: ALERT_THRESHOLDS.CVA_MIN }), data: ms.map(() => ALERT_THRESHOLDS.CVA_MIN), borderColor: CHART_COLORS.threshold, borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0 }
      ]
    },
    options: baseChartOptions()
  }));

  // 每日超過警戒比例
  const days = st.dayStats;
  const th = SYSTEM_RULES.DAY_OVER_FRAME_PCT;
  ChartRegistry.set('caseDaily', () => new Chart(document.getElementById('caseDailyChart').getContext('2d'), {
    type: 'bar',
    data: {
      labels: days.map(x => x.dateKey.slice(5)),
      datasets: [
        { label: tApp('daily_over_pct'), data: days.map(x => x.overAny), backgroundColor: days.map(x => x.overAny >= th ? 'rgba(142,53,74,0.75)' : 'rgba(54,86,60,0.6)'), borderRadius: 4 },
        { type: 'line', label: tApp('day_threshold', { v: th }), data: days.map(() => th), borderColor: CHART_COLORS.threshold, borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0 }
      ]
    },
    options: baseChartOptions({ scales: { x: { grid: { display: false }, ticks: { color: CHART_COLORS.tick } }, y: { min: 0, max: 100, grid: { color: CHART_COLORS.grid }, ticks: { color: CHART_COLORS.tick, callback: v => v + '%' } } } })
  }));

  // 異常統計
  const pct = v => v === null || v === undefined ? '--' : `${fmtNum(v, 0)}%`;
  const paramName = { cva: tApp('issue_cva'), shoulder: tApp('issue_shoulder'), elbow: tApp('issue_elbow') };
  document.getElementById('case-abnormal').innerHTML = pm.count ? `
    <div class="table-wrap"><table>
      <thead><tr><th>${tApp('th_param')}</th><th>${tApp('th_over_days_short')}</th><th>${tApp('th_mean_over')}</th></tr></thead>
      <tbody>
        <tr><td>${paramName.cva}</td><td>${pct(st.overDaysPctByParam.cva)}</td><td>${pct(st.paramMeans.cva)}</td></tr>
        <tr><td>${paramName.shoulder}</td><td>${pct(st.overDaysPctByParam.shoulder)}</td><td>${pct(st.paramMeans.shoulder)}</td></tr>
        <tr><td>${paramName.elbow}</td><td>${pct(st.overDaysPctByParam.elbow)}</td><td>${pct(st.paramMeans.elbow)}</td></tr>
        <tr><td><strong>${tApp('any_param')}</strong></td><td><strong>${pct(st.overDaysPct)}</strong></td><td>${pct(st.meanOverAny)}</td></tr>
      </tbody>
    </table></div>
    <div class="stack" style="margin-top:1rem; gap:0.5rem; font-size:0.86rem;">
      <div>${tApp('most_param')}：<strong>${st.worstParam ? paramName[st.worstParam] : '--'}</strong></div>
      <div>${tApp('most_stage')}：<strong>${st.worstStage ? tApp('stage_' + st.worstStage + '_short') : '--'}</strong> ${st.worstStage ? `<span class="muted small">(${pct(st.stageMeans[st.worstStage])})</span>` : ''}</div>
      <div>${tApp('most_slot')}：<strong>${st.worstSlot ? tApp('slot_' + st.worstSlot) : '--'}</strong> ${st.worstSlot ? `<span class="muted small">(${pct(st.slotMeans[st.worstSlot])})</span>` : ''}</div>
      <div class="muted small">${tApp('abnormal_rule', { days: st.recordedDays, denom: st.denom, th: SYSTEM_RULES.DAY_OVER_FRAME_PCT })}</div>
    </div>` : `<p class="empty-state">${tApp('no_records_in_period')}</p>`;
}

function renderCaseCompare() {
  const range = id => document.getElementById(id).value;
  const aFrom = dateInputToMs(range('cmp-a-from')), aTo = dateInputToMs(range('cmp-a-to'), true);
  const bFrom = dateInputToMs(range('cmp-b-from')), bTo = dateInputToMs(range('cmp-b-to'), true);
  const A = periodMetrics(aFrom, aTo), B = periodMetrics(bFrom, bTo);
  const pct = v => v === null || v === undefined ? '--' : `${fmtNum(v, 0)}%`;
  const deg = (v, dgt = 1) => v === null || v === undefined ? '--' : `${fmtNum(v, dgt)}°`;
  const diff = (a, b, unit = '', d = 1) => (a === null || b === null || a === undefined || b === undefined) ? '--' : `${b - a >= 0 ? '+' : ''}${fmtNum(b - a, d)}${unit}`;
  const rows = [
    [tApp('cs_count'), A.count, B.count, diff(A.count, B.count, '', 0)],
    [tApp('cs_over_days'), pct(A.stats.overDaysPct), pct(B.stats.overDaysPct), diff(A.stats.overDaysPct, B.stats.overDaysPct, '%', 0)],
    [tApp('metric_cva_avg'), deg(A.cvaAvg), deg(B.cvaAvg), diff(A.cvaAvg, B.cvaAvg, '°')],
    [tApp('below_threshold_ratio'), pct(A.cvaBelowPct), pct(B.cvaBelowPct), diff(A.cvaBelowPct, B.cvaBelowPct, '%', 0)],
    [tApp('metric_shoulder') + ' Δ', deg(A.shoulderAvg), deg(B.shoulderAvg), diff(A.shoulderAvg, B.shoulderAvg, '°')],
    [tApp('metric_left_elbow'), deg(A.leftElbowAvg, 0), deg(B.leftElbowAvg, 0), diff(A.leftElbowAvg, B.leftElbowAvg, '°', 0)],
    [tApp('metric_right_elbow'), deg(A.rightElbowAvg, 0), deg(B.rightElbowAvg, 0), diff(A.rightElbowAvg, B.rightElbowAvg, '°', 0)],
    [tApp('cs_practice'), A.practiceMin, B.practiceMin, diff(A.practiceMin, B.practiceMin, '', 0)],
    [tApp('ps_bad') + ` (${tApp('unit_min')})`, A.badMin, B.badMin, diff(A.badMin, B.badMin, '', 0)],
    ['IPAQ (MET-min/' + tApp('unit_week') + ')', A.ipaq ?? '--', B.ipaq ?? '--', diff(A.ipaq, B.ipaq, '', 0)],
    [tApp('scale_title'), A.scale === null ? '--' : `${A.scale}/${A.scaleMax}`, B.scale === null ? '--' : `${B.scale}/${B.scaleMax}`, diff(A.scale, B.scale, '', 0)],
    [tApp('discomfort_marks_count'), A.marks.length, B.marks.length, diff(A.marks.length, B.marks.length, '', 0)],
    [tApp('tab_notes'), A.notes, B.notes, diff(A.notes, B.notes, '', 0)]
  ];
  document.getElementById('compare-table').innerHTML = `
    <thead><tr><th>${tApp('th_item_compare')}</th><th>A：${range('cmp-a-from')} ~ ${range('cmp-a-to')}</th><th>B：${range('cmp-b-from')} ~ ${range('cmp-b-to')}</th><th>${tApp('th_change')}</th></tr></thead>
    <tbody>${rows.map(r => `<tr><td><strong>${r[0]}</strong></td><td>${r[1]}</td><td>${r[2]}</td><td>${r[3]}</td></tr>`).join('')}</tbody>`;

  const g = Prov.data.profile.gender;
  const renderAgg = (elId, M) => {
    const el = document.getElementById(elId);
    BodyMap.create(el, { marks: M.marks, editable: false, gender: g, compact: true });
    const counts = Object.keys(M.regionCount).sort((x, y) => M.regionCount[y] - M.regionCount[x])
      .map(k => `${BodyMap.regionLabel(k)} ×${M.regionCount[k]}`).join(currentLang === 'en' ? ', ' : '、');
    const p = document.createElement('p');
    p.className = 'muted small';
    p.style.marginTop = '0.5rem';
    p.textContent = M.postMapsCount ? `${tApp('post_maps_n', { n: M.postMapsCount })}${counts ? '：' + counts : ''}` : tApp('no_records_in_period');
    el.appendChild(p);
    const fig = el.querySelector('.bodymap-figure');
    if (fig) fig.style.maxWidth = '200px';
  };
  renderAgg('compare-map-a', A);
  renderAgg('compare-map-b', B);
}

function renderCaseDetail() {
  const d = Prov.data;
  const recs = caseInPeriod('records');
  const ctx = { records: d.records, bodyMaps: d.bodyMaps, profile: d.profile };
  window._caseCtx = ctx;
  document.getElementById('case-record-body').innerHTML = recs.length ? recs.map(r => {
    const m = recordMetrics(r);
    const post = d.bodyMaps.find(x => x.recordId === r.firestoreId && x.context === 'post');
    return `<tr>
      <td>${fmtDateTime(m.ms)}</td>
      <td>${r.score ?? '--'} ${levelBadge(r.level)}</td>
      <td>${fmtNum(m.cvaAvg)}°${m.cvaBelowPct !== null ? ` <span class="muted small">(${fmtNum(m.cvaBelowPct, 0)}%)</span>` : ''}</td>
      <td>${fmtNum(m.shoulderAvg)}°</td>
      <td>${fmtNum(m.leftElbowAvg, 0)}° / ${fmtNum(m.rightElbowAvg, 0)}°</td>
      <td>${r.practice ? fmtClock(r.practice.durationSec) : '--'}</td>
      <td>${post && post.marks.length ? escapeHtml(BodyMap.summarize(post.marks)) : '--'}</td>
      <td><button class="btn btn-outline btn-sm" onclick="viewHistoryDetail('${r.firestoreId}', window._caseCtx)"><i data-lucide="eye"></i></button></td>
    </tr>`;
  }).join('') : `<tr><td colspan="8"><div class="empty-state">${tApp('no_records_in_period')}</div></td></tr>`;

  const notes = caseInPeriod('notes');
  document.getElementById('case-notes').innerHTML = notes.length ? notes.map(n => noteItemHtml(n, false)).join('') : `<p class="empty-state">${tApp('empty_list')}</p>`;
  const med = caseInPeriod('medicalLogs');
  document.getElementById('case-medical').innerHTML = med.length ? med.map(m => medicalItemHtml(m, false)).join('') : `<p class="empty-state">${tApp('empty_list')}</p>`;
  const q = caseInPeriod('questionnaires');
  document.getElementById('case-questionnaires').innerHTML = q.length ? q.map(x => `
    <div class="list-item"><div class="list-item-main">
      <div class="list-item-title">${x.type === 'ipaq' ? 'IPAQ' : tApp('scale_title')} · ${phaseLabel(x.phase)}</div>
      <div class="list-item-sub">${x.type === 'ipaq' ? `${x.score} MET-min/${tApp('unit_week')} · ${tApp('ipaq_cat_' + (x.result ? x.result.category : 'low'))}` : tApp('score_text', { score: x.score, max: x.maxScore || '--' })} · ${fmtDate(docTimeMs(x))}</div>
    </div></div>`).join('') : `<p class="empty-state">${tApp('empty_list')}</p>`;
}

function renderCaseProfile() {
  const p = Prov.data.profile;
  const row = (k, v) => `<tr><td style="width:40%;" class="muted">${tApp(k)}</td><td>${v === null || v === undefined || v === '' ? '--' : escapeHtml(String(v))}</td></tr>`;
  const age = ageFromBirthdate(p.birthdate) ?? p.age;
  document.getElementById('case-profile-info').innerHTML = `<div class="table-wrap"><table><tbody>
    ${row('label_name', p.username)}
    ${row('label_gender', optionLabel(GENDER_KEYS, p.gender))}
    ${row('label_birthdate', p.birthdate ? `${p.birthdate}（${tApp('age_hint', { age })}）` : (age ?? ''))}
    ${row('label_identity', optionLabel(IDENTITY_KEYS, p.identity))}
    ${row('label_height', p.height)}
    ${row('label_weight', p.weight)}
    ${row('label_instrument', instrumentLabel(p.instrument))}
    ${row('label_years', p.yearsOfStudy)}
    ${row('label_days', p.practiceDaysPerWeek)}
    ${row('label_minutes', p.practiceMinutesPerSession)}
    ${row('label_pt', p.hadPhysicalTherapy ? `${tApp('opt_yes')}${p.physicalTherapyNote ? '：' + p.physicalTherapyNote : ''}` : tApp('opt_no'))}
    ${row('label_referral', optionLabel(REFERRAL_KEYS, p.referralSource))}
  </tbody></table></div>`;
  const base = latestBodyMap('baseline', Prov.data.bodyMaps);
  BodyMap.create(document.getElementById('case-baseline-map'), { marks: base ? base.marks : [], editable: false, gender: p.gender });
  document.getElementById('case-pain-info').innerHTML = `<div class="table-wrap"><table><tbody>
    ${row('label_msk', p.mskHistory)}${row('label_surgery', p.surgeryHistory)}${row('label_meds', p.currentMedication)}${row('label_allergy', p.allergies)}
  </tbody></table></div>`;
}

// =================================================================
// 5–6. 照護建議與報告
// =================================================================
function renderAdvicePage() {
  if (!Prov.data) { switchSection('provider-cases'); return; }
  const d = Prov.data;
  document.getElementById('advice-case-name').textContent = d.profile.username || d.binding.performerName || '--';
  const recs = caseInPeriod('records').filter(r => r.type === 'playing');
  document.getElementById('adv-related').innerHTML = recs.length ? recs.map(r => `
    <label class="check-row" style="margin-bottom:0.35rem;"><input type="checkbox" class="adv-rec" value="${r.firestoreId}">
    <span>${fmtDateTime(docTimeMs(r))} · ${tApp('score_label')} ${r.score ?? '--'} · ${recordSummaryText(r)}</span></label>`).join('')
    : `<p class="muted small">${tApp('no_records_in_period')}</p>`;

  const me = App.user.uid;
  document.getElementById('advice-history').innerHTML = d.advice.length ? d.advice.map(a => `
    <div class="list-item"><div class="list-item-main">
      <div class="list-item-title">${escapeHtml(a.recommendation || '')}</div>
      <div class="list-item-sub">${a.diagnosis ? tApp('label_assessment_note') + '：' + escapeHtml(a.diagnosis) + '\n' : ''}${escapeHtml(a.providerName || '')} ${escapeHtml(a.providerTitleText || '')} · ${fmtDateTime(docTimeMs(a))}${a.providerUid === me ? '' : ' · ' + tApp('by_other_provider')}${(a.relatedRecordIds || []).length ? ' · ' + tApp('related_n', { n: a.relatedRecordIds.length }) : ''}</div>
    </div>
    ${a.providerUid === me ? `<button class="btn btn-danger-outline btn-sm" onclick="deleteAdvice('${a.firestoreId}')"><i data-lucide="trash-2"></i></button>` : ''}
    </div>`).join('') : `<p class="empty-state">${tApp('empty_list')}</p>`;

  document.getElementById('followup-history').innerHTML = d.followups.length ? d.followups.map(f => `
    <div class="list-item"><div class="list-item-main">
      <div class="list-item-title">${escapeHtml(f.recommendation || f.diagnosis || '')}</div>
      <div class="list-item-sub">${f.diagnosis && f.recommendation ? escapeHtml(f.diagnosis) + '\n' : ''}${fmtDateTime(docTimeMs(f))}</div>
    </div></div>`).join('') : `<p class="empty-state">${tApp('empty_list')}</p>`;

  document.getElementById('archive-list').innerHTML = d.archives.length ? `<div class="form-label">${tApp('archive_list_title')}</div>` + d.archives.map(a => `
    <div class="list-item"><div class="list-item-main">
      <div class="list-item-title">${fmtDate(a.periodFrom)} ~ ${fmtDate(a.periodTo)}</div>
      <div class="list-item-sub">${tApp('archived_at', { date: fmtDateTime(docTimeMs(a)) })} · ${tApp('cs_count')} ${a.summary ? a.summary.count : '--'} · ${tApp('cs_over_days')} ${a.summary && a.summary.overDaysPct !== null ? fmtNum(a.summary.overDaysPct, 0) + '%' : '--'}</div>
    </div></div>`).join('') : '';
  lucide.createIcons();
}

async function submitAdvice() {
  const d = Prov.data;
  if (!d) return;
  const diagnosis = document.getElementById('adv-diagnosis').value.trim();
  const recommendation = document.getElementById('adv-recommendation').value.trim();
  const followOnly = document.getElementById('adv-followup-only').checked;
  if (!recommendation && !(followOnly && diagnosis)) { showToast(tApp('toast_fill_required'), 'warning'); return; }
  const relatedRecordIds = Array.from(document.querySelectorAll('.adv-rec:checked')).map(x => x.value);
  const pv = (App.providerDoc && App.providerDoc.profile) || {};
  const me = App.user.uid;
  const now = Date.now();
  const doc = {
    providerUid: me, providerName: pv.name || App.profile.username || '', providerTitleText: providerTitleText(pv),
    timestamp: new Date(now).toLocaleString('zh-TW', { hour12: false }),
    diagnosis, recommendation, relatedRecordIds, createdAtMs: now
  };
  try {
    if (followOnly) {
      await DataAPI.addProviderSub(me, 'followups', { ...doc, patientUid: d.uid, patientName: d.profile.username || '' });
      d.followups = await DataAPI.listProviderSub(me, 'followups', d.uid);
    } else {
      await DataAPI.addSub(d.uid, 'notesFromProviders', doc);
      d.advice = await DataAPI.listSub(d.uid, 'notesFromProviders');
    }
    ['adv-diagnosis', 'adv-recommendation'].forEach(id => { document.getElementById(id).value = ''; });
    document.getElementById('adv-followup-only').checked = false;
    showToast(tApp(followOnly ? 'toast_followup_saved' : 'toast_advice_pushed'), 'success');
    renderAdvicePage();
  } catch (e) { console.error(e); showToast(tApp('toast_save_fail'), 'danger'); }
}

async function deleteAdvice(id) {
  if (!confirm(tApp('confirm_delete'))) return;
  try {
    await DataAPI.deleteSub(Prov.data.uid, 'notesFromProviders', id);
    Prov.data.advice = await DataAPI.listSub(Prov.data.uid, 'notesFromProviders');
    renderAdvicePage();
    showToast(tApp('toast_deleted'), 'info');
  } catch (e) { console.error(e); showToast(tApp('toast_delete_fail'), 'danger'); }
}

function buildCaseReportHtml() {
  const d = Prov.data;
  const p = d.profile;
  const per = getCasePeriod();
  const pm = periodMetrics(per.from, per.to);
  const st = pm.stats;
  const pv = (App.providerDoc && App.providerDoc.profile) || {};
  const pct = v => v === null || v === undefined ? '--' : `${fmtNum(v, 0)}%`;
  const advice = filterByPeriod(d.advice, per.from, null);
  const notes = caseInPeriod('notes');
  const age = ageFromBirthdate(p.birthdate) ?? p.age;
  return `<div class="report-sheet">
    <h1>${tApp('report_title')}</h1>
    <p>${escapeHtml(p.username || '')} · ${escapeHtml(instrumentLabel(p.instrument))} · ${optionLabel(GENDER_KEYS, p.gender)} · ${age ?? '--'} ${tApp('unit_years_old')}</p>
    <p>${tApp('report_period')}：${per.from ? fmtDate(per.from) : '--'} ~ ${per.to ? fmtDate(per.to) : fmtDate(Date.now())}　${tApp('report_by')}：${escapeHtml(pv.name || '')} ${escapeHtml(providerTitleText(pv))} ${escapeHtml(pv.institution || '')}</p>
    <p>${tApp('report_generated')}：${fmtDateTime(Date.now())}</p>
    <h2>${tApp('report_summary')}</h2>
    <table><tbody>
      <tr><td>${tApp('cs_count')}</td><td>${pm.count}</td><td>${tApp('cs_over_days')}</td><td>${pct(st.overDaysPct)}（${st.recordedDays} ${tApp('unit_days_recorded')}）</td></tr>
      <tr><td>${tApp('metric_cva_avg')}</td><td>${fmtNum(pm.cvaAvg)}°</td><td>${tApp('below_threshold_ratio')}</td><td>${pct(pm.cvaBelowPct)}</td></tr>
      <tr><td>${tApp('metric_shoulder')} Δ</td><td>${fmtNum(pm.shoulderAvg)}°</td><td>${tApp('over_ratio')}</td><td>${pct(pm.shoulderOverPct)}</td></tr>
      <tr><td>${tApp('metric_left_elbow')} / ${tApp('metric_right_elbow')}</td><td>${fmtNum(pm.leftElbowAvg, 0)}° / ${fmtNum(pm.rightElbowAvg, 0)}°</td><td>${tApp('over_ratio')}</td><td>${pct(pm.elbowOverPct)}</td></tr>
      <tr><td>${tApp('cs_practice')}</td><td>${pm.practiceMin}</td><td>${tApp('ps_bad')} (${tApp('unit_min')})</td><td>${pm.badMin}</td></tr>
      <tr><td>IPAQ</td><td>${pm.ipaq ?? '--'}${pm.ipaqCat ? '（' + tApp('ipaq_cat_' + pm.ipaqCat) + '）' : ''}</td><td>${tApp('scale_title')}</td><td>${pm.scale === null ? '--' : pm.scale + '/' + pm.scaleMax}</td></tr>
      <tr><td>${tApp('most_stage')}</td><td>${st.worstStage ? tApp('stage_' + st.worstStage + '_short') : '--'}</td><td>${tApp('most_slot')}</td><td>${st.worstSlot ? tApp('slot_' + st.worstSlot) : '--'}</td></tr>
    </tbody></table>
    <p style="font-size:0.75rem;">${tApp('abnormal_rule', { days: st.recordedDays, denom: st.denom, th: SYSTEM_RULES.DAY_OVER_FRAME_PCT })}</p>
    <h2>${tApp('report_discomfort')}</h2>
    <p>${Object.keys(pm.regionCount).length ? Object.keys(pm.regionCount).map(k => `${BodyMap.regionLabel(k)} ×${pm.regionCount[k]}`).join('、') : tApp('none_marked')}</p>
    <h2>${tApp('detail_records')}</h2>
    <table><thead><tr><th>${tApp('th_time')}</th><th>${tApp('score_label')}</th><th>CVA</th><th>${tApp('below_threshold_ratio')}</th><th>${tApp('th_shoulder')}</th><th>${tApp('th_elbow')}</th><th>${tApp('th_practice')}</th></tr></thead>
    <tbody>${pm.metrics.map(m => `<tr><td>${fmtDateTime(m.ms)}</td><td>${m.score ?? '--'}</td><td>${fmtNum(m.cvaAvg)}°</td><td>${pct(m.cvaBelowPct)}</td><td>${fmtNum(m.shoulderAvg)}°</td><td>${fmtNum(m.leftElbowAvg, 0)}° / ${fmtNum(m.rightElbowAvg, 0)}°</td><td>${fmtClock(m.practiceSec)}</td></tr>`).join('') || `<tr><td colspan="7">--</td></tr>`}</tbody></table>
    <h2>${tApp('pa_history_title')}</h2>
    ${advice.length ? `<ul>${advice.map(a => `<li>${fmtDate(docTimeMs(a))}　${escapeHtml(a.recommendation || '')}${a.diagnosis ? `（${escapeHtml(a.diagnosis)}）` : ''}</li>`).join('')}</ul>` : '<p>--</p>'}
    <h2>${tApp('tab_notes')}</h2>
    ${notes.length ? `<ul>${notes.map(n => `<li>${escapeHtml(n.date || '')}　${escapeHtml(n.content || '')}</li>`).join('')}</ul>` : '<p>--</p>'}
    <p style="margin-top:1.5rem; font-size:0.72rem; color:#707C74;">${tApp('report_footer')}</p>
  </div>`;
}

function printCaseReport() {
  if (!Prov.data) return;
  document.getElementById('print-area').innerHTML = buildCaseReportHtml();
  setTimeout(() => window.print(), 100);
}

async function archiveCaseReport() {
  const d = Prov.data;
  if (!d) return;
  const per = getCasePeriod();
  const pm = periodMetrics(per.from, per.to);
  if (!confirm(tApp('confirm_archive'))) return;
  try {
    await DataAPI.addProviderSub(App.user.uid, 'archives', {
      patientUid: d.uid, patientName: d.profile.username || '',
      periodFrom: per.from || (d.records.length ? docTimeMs(d.records[d.records.length - 1]) : Date.now()),
      periodTo: per.to || Date.now(),
      recordIds: pm.recs.map(r => r.firestoreId),
      summary: {
        count: pm.count, overDaysPct: pm.stats.overDaysPct, recordedDays: pm.stats.recordedDays,
        cvaAvg: pm.cvaAvg, cvaBelowPct: pm.cvaBelowPct, shoulderAvg: pm.shoulderAvg, shoulderOverPct: pm.shoulderOverPct,
        leftElbowAvg: pm.leftElbowAvg, rightElbowAvg: pm.rightElbowAvg, elbowOverPct: pm.elbowOverPct,
        practiceMin: pm.practiceMin, badMin: pm.badMin, ipaq: pm.ipaq, scale: pm.scale,
        regionCount: pm.regionCount
      },
      reportHtml: buildCaseReportHtml()
    });
    d.archives = await DataAPI.listProviderSub(App.user.uid, 'archives', d.uid);
    showToast(tApp('toast_archived'), 'success');
    renderAdvicePage();
  } catch (e) { console.error(e); showToast(tApp('toast_save_fail'), 'danger'); }
}

// =================================================================
// 照護者資料
// =================================================================
function fillProviderProfileForm() {
  const pv = (App.providerDoc && App.providerDoc.profile) || {};
  const set = (id, v) => { document.getElementById(id).value = v || ''; };
  set('pp-name', pv.name || (App.profile && App.profile.username));
  set('pp-title', pv.title);
  set('pp-title-other', pv.titleOther);
  document.getElementById('pp-title-other').style.display = pv.title === '其他' ? 'block' : 'none';
  set('pp-specialty', pv.specialty);
  set('pp-institution', pv.institution);
  set('pp-license', pv.licenseNo);
  set('pp-phone', pv.phone);
  document.getElementById('pp-invite-code').textContent = (App.providerDoc && App.providerDoc.inviteCode) || '------';
}

async function saveProviderProfile(event) {
  event.preventDefault();
  const v = id => document.getElementById(id).value.trim();
  const title = v('pp-title');
  if (title === '其他' && !v('pp-title-other')) { showToast(tApp('toast_fill_required'), 'warning'); return; }
  const old = (App.providerDoc && App.providerDoc.profile) || {};
  const profile = {
    ...old, name: v('pp-name'), email: old.email || App.user.email, emailLower: (old.email || App.user.email || '').toLowerCase(),
    title, titleOther: title === '其他' ? v('pp-title-other') : '',
    specialty: v('pp-specialty'), institution: v('pp-institution'), licenseNo: v('pp-license'), phone: v('pp-phone')
  };
  try {
    await DataAPI.setProvider(App.user.uid, { profile });
    App.providerDoc = { ...(App.providerDoc || {}), profile };
    updateHeaderNames();
    showToast(tApp('toast_profile_saved'), 'success');
  } catch (e) { console.error(e); showToast(tApp('toast_save_fail'), 'danger'); }
}

async function regenerateInviteCode() {
  if (!confirm(tApp('confirm_regen_code'))) return;
  const code = makeInviteCode();
  try {
    await DataAPI.setProvider(App.user.uid, { inviteCode: code });
    App.providerDoc = { ...(App.providerDoc || {}), inviteCode: code };
    fillProviderProfileForm();
    showToast(tApp('toast_code_regen'), 'success');
  } catch (e) { console.error(e); showToast(tApp('toast_save_fail'), 'danger'); }
}
