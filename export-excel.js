// =================================================================
// export-excel.js — 匯出 Excel（.xlsx）供統計分析
//   演奏者：歷史紀錄頁「匯出 Excel」→ 匯出自己的資料
//   照護端：個案儀表板「紀錄明細」→ 匯出該個案（目前查看期間）
// 每次評估一列；另有練習時間、問卷、就醫用藥、筆記、基本資料等工作表
// 使用 SheetJS（第一次按下按鈕時才從 CDN 載入）
// =================================================================

const SHEETJS_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';

function loadScriptOnce(url) {
  if (window.__loadedScripts && window.__loadedScripts[url]) return window.__loadedScripts[url];
  window.__loadedScripts = window.__loadedScripts || {};
  window.__loadedScripts[url] = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = resolve;
    s.onerror = () => { delete window.__loadedScripts[url]; reject(new Error('load failed: ' + url)); };
    document.head.appendChild(s);
  });
  return window.__loadedScripts[url];
}

// 數值：保留小數，空值輸出空白（Excel 才不會把 null 當 0）
const xNum = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v)) ? '' : +(+v).toFixed(d);
const xDate = ms => ms ? dateKeyOf(ms) : '';
const xTime = ms => {
  if (!ms) return '';
  const t = new Date(ms);
  return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
};

/** 評估紀錄 → 每筆一列 */
function buildAssessmentRows(records, bodyMaps) {
  return records.filter(r => r.type === 'playing').slice().sort((a, b) => docTimeMs(a) - docTimeMs(b)).map(r => {
    const m = recordMetrics(r);
    const pre = bodyMaps.find(x => x.recordId === m.id && x.context === 'pre');
    const post = bodyMaps.find(x => x.recordId === m.id && x.context === 'post');
    const st = s => m.stages[s] || {};
    const row = {};
    row[tApp('xl_date')] = xDate(m.ms);
    row[tApp('xl_time')] = xTime(m.ms);
    row[tApp('label_instrument')] = instrumentLabel(r.instrument);
    row[tApp('score_label')] = xNum(r.score, 0);
    row[tApp('th_level')] = tApp('level_' + m.level);
    row[tApp('xl_cva_avg')] = xNum(m.cvaAvg);
    row[tApp('xl_cva_below')] = xNum(m.cvaBelowPct);
    row[tApp('xl_sh_avg')] = xNum(m.shoulderAvg);
    row[tApp('xl_sh_over')] = xNum(m.shoulderOverPct);
    row[tApp('xl_le_avg')] = xNum(m.leftElbowAvg);
    row[tApp('xl_re_avg')] = xNum(m.rightElbowAvg);
    row[tApp('xl_el_over')] = xNum(m.elbowOverPct);
    row[tApp('xl_any_over')] = xNum(m.overAnyPct);
    ['relax', 'prepare'].forEach(s => {
      row[tApp('xl_stage_cva', { stage: tApp('stage_' + s + '_short') })] = xNum(st(s).cvaAvg);
      row[tApp('xl_stage_cva_below', { stage: tApp('stage_' + s + '_short') })] = xNum(st(s).cvaBelowPct);
    });
    row[tApp('xl_practice_min')] = xNum(m.practiceSec / 60);
    row[tApp('xl_bad_min')] = xNum(m.badSec / 60);
    row[tApp('ps_alerts')] = m.alertCount;
    row[tApp('xl_pre_parts')] = pre ? BodyMap.summarize(pre.marks) : '';
    row[tApp('xl_post_parts')] = post ? BodyMap.summarize(post.marks) : '';
    row[tApp('xl_post_count')] = post ? (post.marks || []).length : '';
    row[tApp('xl_version')] = r.details && r.details.summary ? 'v2' : tApp('xl_legacy');
    row['recordId'] = m.id;
    return row;
  });
}

/** 標準動作辨識 → 每筆一列（判讀標準未定，只列角度） */
function buildStandardRows(records) {
  return records.filter(r => r.type === 'standard').slice().sort((a, b) => docTimeMs(a) - docTimeMs(b)).map(r => {
    const ms = docTimeMs(r);
    const s = standardSummary(r);
    return {
      [tApp('xl_date')]: xDate(ms),
      [tApp('xl_time')]: xTime(ms),
      [tApp('label_instrument')]: instrumentLabel(r.instrument),
      [tApp('xl_sm_shoulder')]: xNum(s.shoulderTilt),
      [tApp('xl_sm_higher')]: s.higherSide ? smSideLabel(s.higherSide) : '',
      [tApp('xl_sm_abd_l')]: xNum(s.abdLeft),
      [tApp('xl_sm_abd_r')]: xNum(s.abdRight),
      [tApp('xl_sm_cva')]: xNum(s.cva),
      [tApp('xl_sm_cva_side')]: s.cvaSide ? smSideLabel(s.cvaSide) : '',
      [tApp('xl_sm_flex_r')]: xNum(s.flexRight),
      [tApp('xl_sm_flex_l')]: xNum(s.flexLeft),
      [tApp('xl_sm_mismatch')]: s.viewMismatch.map(id => tApp('sm_short_' + id)).join('、'),
      recordId: r.firestoreId || ''
    };
  });
}

function buildPracticeRows(logs) {
  return logs.slice().sort((a, b) => docTimeMs(a) - docTimeMs(b)).map(p => ({
    [tApp('xl_date')]: p.dateKey || xDate(docTimeMs(p)),
    [tApp('xl_practice_min')]: xNum((p.durationSec || 0) / 60),
    [tApp('xl_source')]: tApp(p.source === 'detection' ? 'source_detection' : 'source_manual'),
    [tApp('xl_bad_min')]: p.source === 'detection' ? xNum((p.badPostureSec || 0) / 60) : '',
    [tApp('ps_alerts')]: p.source === 'detection' ? (p.alertCount || 0) : '',
    [tApp('label_note_short')]: p.note || '',
    recordId: p.recordId || ''
  }));
}

function buildQuestionnaireRows(list) {
  return list.slice().sort((a, b) => docTimeMs(a) - docTimeMs(b)).map(q => {
    const row = {
      [tApp('xl_date')]: xDate(docTimeMs(q)),
      [tApp('xl_q_type')]: q.type === 'ipaq' ? 'IPAQ-SF' : tApp('scale_title'),
      [tApp('label_phase')]: phaseLabel(q.phase),
      [tApp('xl_score')]: q.score ?? '',
      [tApp('xl_max_score')]: q.maxScore ?? '',
      [tApp('xl_ipaq_cat')]: q.result ? tApp('ipaq_cat_' + q.result.category) : '',
      [tApp('xl_sample')]: q.isSample ? tApp('opt_yes') : ''
    };
    Object.keys(q.answers || {}).forEach(k => { row[k] = q.answers[k]; });
    return row;
  });
}

function buildMedicalRows(list) {
  return list.slice().sort((a, b) => docTimeMs(a) - docTimeMs(b)).map(m => ({
    [tApp('xl_date')]: m.date || '',
    [tApp('label_department')]: m.department || '',
    [tApp('label_reason')]: m.reason || '',
    [tApp('label_medication')]: m.medication || ''
  }));
}

function buildNoteRows(list) {
  return list.slice().sort((a, b) => docTimeMs(a) - docTimeMs(b)).map(n => ({
    [tApp('xl_date')]: n.date || xDate(docTimeMs(n)),
    [tApp('label_content')]: n.content || ''
  }));
}

function buildProfileRows(p, baseline) {
  const age = ageFromBirthdate(p.birthdate) ?? p.age;
  const rows = [
    ['label_name', p.username], ['label_gender', optionLabel(GENDER_KEYS, p.gender)],
    ['label_birthdate', p.birthdate], ['xl_age', age], ['label_identity', optionLabel(IDENTITY_KEYS, p.identity)],
    ['label_height', p.height], ['label_weight', p.weight], ['label_instrument', instrumentLabel(p.instrument)],
    ['label_years', p.yearsOfStudy], ['label_days', p.practiceDaysPerWeek], ['label_minutes', p.practiceMinutesPerSession],
    ['label_pt', p.hadPhysicalTherapy ? `${tApp('opt_yes')} ${p.physicalTherapyNote || ''}` : tApp('opt_no')],
    ['label_painmap', baseline ? BodyMap.summarize(baseline.marks) : ''],
    ['label_msk', p.mskHistory], ['label_surgery', p.surgeryHistory], ['label_meds', p.currentMedication],
    ['label_allergy', p.allergies], ['label_referral', optionLabel(REFERRAL_KEYS, p.referralSource)]
  ];
  return rows.map(([k, v]) => ({ [tApp('xl_field')]: tApp(k), [tApp('xl_value')]: v === null || v === undefined || v === '--' ? '' : v }));
}

function buildInfoRows(meta) {
  const T = ALERT_THRESHOLDS;
  return [
    [tApp('xl_exported_at'), fmtDateTime(Date.now())],
    [tApp('xl_period'), meta.periodText || tApp('period_all')],
    [tApp('xl_note_cva'), tApp('xl_note_cva_text', { v: T.CVA_MIN })],
    [tApp('xl_note_sh'), tApp('xl_note_sh_text', { v: T.SHOULDER_DELTA_MAX })],
    [tApp('xl_note_el'), tApp('xl_note_el_text', { a: T.ELBOW_MIN, b: T.ELBOW_MAX })],
    [tApp('xl_note_score'), tApp('xl_note_score_text')],
    [tApp('xl_note_sm'), tApp('xl_note_sm_text', { s: SM_PROTOCOL.STATIC_SEC })],
    [tApp('xl_note_legacy'), tApp('xl_note_legacy_text')]
  ].map(([a, b]) => ({ [tApp('xl_field')]: a, [tApp('xl_value')]: b }));
}

function addSheet(wb, rows, name, emptyMsg) {
  const data = rows.length ? rows : [{ [name]: emptyMsg || tApp('empty_list') }];
  const ws = XLSX.utils.json_to_sheet(data);
  // 依內容估算欄寬
  const keys = Object.keys(data[0]);
  ws['!cols'] = keys.map(k => {
    const len = Math.max(String(k).length, ...data.map(r => String(r[k] ?? '').length));
    return { wch: Math.min(40, Math.max(8, len * 1.6)) };
  });
  XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
}

/**
 * 匯出 Excel
 * @param {object} src  { profile, records, bodyMaps, practiceLogs, questionnaires, medicalLogs, notes }
 * @param {object} meta { fileName, periodText }
 */
async function exportExcelWorkbook(src, meta = {}) {
  try {
    showToast(tApp('toast_excel_preparing'), 'info');
    await loadScriptOnce(SHEETJS_URL);
  } catch (e) {
    console.error(e);
    showToast(tApp('toast_excel_fail'), 'danger');
    return;
  }
  const wb = XLSX.utils.book_new();
  addSheet(wb, buildAssessmentRows(src.records, src.bodyMaps), tApp('xl_sheet_assess'));
  addSheet(wb, buildStandardRows(src.records), tApp('xl_sheet_standard'));
  addSheet(wb, buildPracticeRows(src.practiceLogs), tApp('xl_sheet_practice'));
  addSheet(wb, buildQuestionnaireRows(src.questionnaires), tApp('xl_sheet_quest'));
  addSheet(wb, buildMedicalRows(src.medicalLogs), tApp('xl_sheet_medical'));
  addSheet(wb, buildNoteRows(src.notes), tApp('xl_sheet_notes'));
  addSheet(wb, buildProfileRows(src.profile || {}, latestBodyMap('baseline', src.bodyMaps)), tApp('xl_sheet_profile'));
  addSheet(wb, buildInfoRows(meta), tApp('xl_sheet_info'));
  const safe = String(meta.fileName || 'performer_care').replace(/[\\/:*?"<>|\s]+/g, '_');
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${safe}_${todayStr()}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  showToast(tApp('toast_excel_done'), 'success');
}

// 演奏者：歷史紀錄頁
function exportHistoryExcel() {
  if (!App.records.length && !App.practiceLogs.length && !App.questionnaires.length) {
    showToast(tApp('toast_nothing_export'), 'warning');
    return;
  }
  exportExcelWorkbook({
    profile: App.profile, records: App.records, bodyMaps: App.bodyMaps, practiceLogs: App.practiceLogs,
    questionnaires: App.questionnaires, medicalLogs: App.medicalLogs, notes: App.notes
  }, { fileName: 'performer_care' });
}

// 照護端：個案（目前查看期間）
function exportCaseExcel() {
  if (!Prov.data) return;
  const d = Prov.data;
  const per = getCasePeriod();
  const f = key => filterByPeriod(d[key], per.from, per.to);
  exportExcelWorkbook({
    profile: d.profile, records: f('records'), bodyMaps: d.bodyMaps, practiceLogs: f('practiceLogs'),
    questionnaires: f('questionnaires'), medicalLogs: f('medicalLogs'), notes: f('notes')
  }, {
    fileName: `case_${d.profile.username || d.uid}`,
    periodText: per.from ? `${fmtDate(per.from)} ~ ${fmtDate(per.to)}` : tApp('period_all')
  });
}
