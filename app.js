// =================================================================
// 演奏者智能照護系統 — 核心程式（app.js）
//   ・語言切換（APP_I18N 定義於 i18n.js）
//   ・資料存取層 DataAPI（所有 Firestore 讀寫集中於此，未來換伺服器只改這裡）
//   ・登入驗證、角色（profile.roles）與角色切換
//   ・頁面路由、共用 UI 工具、分析計算
//   ・演奏者：基本資料、儀表板、歷史紀錄
// 其他模組：detection.js（偵測／警示／評估報告）、features.js（問卷、紀錄、
// 衛教、授權）、provider.js（照護端）
// =================================================================

// ── 系統門檻（集中管理；標「待定」者為示意值，待研究團隊確認） ─────
const SYSTEM_RULES = {
  DAY_OVER_FRAME_PCT: 20,     // 某天「演奏中」超過警戒值的幀數比例 ≥ 此值，該天記為「超過警戒值」（待定）
  CONCERN_DAY_PCT: 30,        // 超過警戒值天數比例 ≥ 此值，照護端標示「需關注」（待定）
  OVER_DAY_DENOMINATOR: 'recorded', // 'recorded'＝以有錄製的天數為分母；'calendar'＝以期間日曆天數為分母（待討論）
  REMINDER_OVER_PCT: 30,      // 單次評估某參數超過比例 ≥ 此值時產生提醒（待定）
  SCORE_GOOD: 90,             // 健康度評分 ≥ 90 → 良好
  SCORE_CAUTION: 75           // 健康度評分 ≥ 75 → 注意；以下 → 警示
};

// ── 語言 ─────────────────────────────────────────────────────────
let currentLang = localStorage.getItem('lang') || 'zh';

function tApp(key, params) {
  const dict = APP_I18N[currentLang] || APP_I18N.zh;
  let s = dict[key];
  if (s === undefined) s = APP_I18N.zh[key];
  if (s === undefined) return key;
  if (params) Object.keys(params).forEach(k => { s = s.split(`{${k}}`).join(params[k]); });
  return s;
}

function setLang(lang) {
  currentLang = lang;
  localStorage.setItem('lang', lang);
  document.documentElement.lang = lang === 'zh' ? 'zh-Hant' : 'en';
  const zhBtn = document.getElementById('nav-lang-zh');
  const enBtn = document.getElementById('nav-lang-en');
  if (zhBtn) zhBtn.classList.toggle('active', lang === 'zh');
  if (enBtn) enBtn.classList.toggle('active', lang === 'en');

  const dict = APP_I18N[lang];
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (dict[key] !== undefined) el.innerHTML = dict[key];
  });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => {
    const key = el.getAttribute('data-i18n-ph');
    if (dict[key]) el.placeholder = dict[key];
  });
  document.title = dict.brand_name || document.title;

  // 重新繪製 JS 動態產生的文字
  if (App.ready) refreshCurrentView();
}

// ── 全域狀態 ─────────────────────────────────────────────────────
const App = {
  ready: false,
  user: null,
  userDoc: null,          // users/{uid} 文件內容
  profile: null,          // users/{uid}.profile
  roles: [],
  activeRole: 'performer',
  providerDoc: null,      // providers/{uid}
  currentSection: 'dashboard',
  // 演奏者資料快取
  records: [],
  bodyMaps: [],
  questionnaires: [],
  practiceLogs: [],
  medicalLogs: [],
  notes: [],
  advice: [],
  bindings: []
};

// =================================================================
// DataAPI — Firestore 存取集中處
// =================================================================
const TS = () => firebase.firestore.FieldValue.serverTimestamp();

function docTimeMs(d) {
  if (!d) return 0;
  if (typeof d.createdAtMs === 'number') return d.createdAtMs;
  if (d.createdAt && typeof d.createdAt.toMillis === 'function') return d.createdAt.toMillis();
  if (typeof d.id === 'number') return d.id;
  return 0;
}

const DataAPI = {
  async getUserDoc(uid) {
    const snap = await db.collection('users').doc(uid).get();
    return snap.exists ? snap.data() : null;
  },
  async setUserDoc(uid, data) {
    await db.collection('users').doc(uid).set({ ...data, updatedAt: TS() }, { merge: true });
  },
  async updateProfile(uid, profile) {
    await db.collection('users').doc(uid).set({ profile, updatedAt: TS() }, { merge: true });
  },
  async listSub(uid, sub) {
    const snap = await db.collection('users').doc(uid).collection(sub).get();
    const rows = snap.docs.map(d => ({ firestoreId: d.id, ...d.data() }));
    rows.sort((a, b) => docTimeMs(b) - docTimeMs(a));
    return rows;
  },
  async addSub(uid, sub, data) {
    const now = data.createdAtMs || Date.now();
    const ref = await db.collection('users').doc(uid).collection(sub)
      .add({ ...data, createdAtMs: now, dateKey: data.dateKey || dateKeyOf(now), createdAt: TS() });
    return ref.id;
  },
  async updateSub(uid, sub, id, data) {
    await db.collection('users').doc(uid).collection(sub).doc(id).set(data, { merge: true });
  },
  async deleteSub(uid, sub, id) {
    await db.collection('users').doc(uid).collection(sub).doc(id).delete();
  },
  async clearSub(uid, sub) {
    const snap = await db.collection('users').doc(uid).collection(sub).get();
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
  },
  // 照護端
  async getProvider(uid) {
    const snap = await db.collection('providers').doc(uid).get();
    return snap.exists ? snap.data() : null;
  },
  async setProvider(uid, data) {
    await db.collection('providers').doc(uid).set({ ...data, updatedAt: TS() }, { merge: true });
  },
  async findProvider(field, value) {
    const snap = await db.collection('providers').where(field, '==', value).limit(2).get();
    return snap.docs.map(d => ({ uid: d.id, ...d.data() }));
  },
  async listProviderSub(pid, sub, patientUid) {
    let q = db.collection('providers').doc(pid).collection(sub);
    if (patientUid) q = q.where('patientUid', '==', patientUid);
    const snap = await q.get();
    const rows = snap.docs.map(d => ({ firestoreId: d.id, ...d.data() }));
    rows.sort((a, b) => docTimeMs(b) - docTimeMs(a));
    return rows;
  },
  async addProviderSub(pid, sub, data) {
    const now = Date.now();
    const ref = await db.collection('providers').doc(pid).collection(sub).add({ ...data, createdAtMs: now, createdAt: TS() });
    return ref.id;
  },
  // 授權綁定：bindings/{performerUid}_{providerUid}
  bindingId(perf, prov) { return `${perf}_${prov}`; },
  async getBinding(perf, prov) {
    const snap = await db.collection('bindings').doc(this.bindingId(perf, prov)).get();
    return snap.exists ? snap.data() : null;
  },
  async setBinding(perf, prov, data) {
    await db.collection('bindings').doc(this.bindingId(perf, prov)).set({ ...data, updatedAtMs: Date.now() }, { merge: true });
  },
  async listBindings(field, uid) {
    const snap = await db.collection('bindings').where(field, '==', uid).get();
    return snap.docs.map(d => ({ bindingId: d.id, ...d.data() }));
  }
};

// ── 與舊版相容的存取函式名稱 ─────────────────────────────────────
function checkAuth() {
  return new Promise(resolve => {
    const unsub = auth.onAuthStateChanged(user => {
      unsub();
      if (!user) { window.location.href = 'login.html'; resolve(null); }
      else resolve(user);
    });
  });
}

function handleLogout() {
  if (typeof stopAllDetection === 'function') stopAllDetection();
  sessionStorage.removeItem('activeRole');
  auth.signOut().then(() => { window.location.href = 'login.html'; });
}

async function getHistoryFromStorage(uid) {
  try {
    return await DataAPI.listSub(uid || App.user.uid, 'records');
  } catch (err) {
    console.error('讀取評估紀錄失敗：', err);
    return [];
  }
}

async function saveHistoryToStorage(record) {
  return DataAPI.addSub(App.user.uid, 'records', record);
}

// =================================================================
// 初始化
// =================================================================
document.addEventListener('DOMContentLoaded', async () => {
  const user = await checkAuth();
  if (!user) return;
  App.user = user;

  setLang(currentLang);
  lucide.createIcons();

  try {
    await loadAccount();
  } catch (err) {
    console.error('帳號資料載入失敗：', err);
    showToast(tApp('toast_load_fail'), 'danger');
  }

  const loading = document.getElementById('loading-screen');
  if (loading) { loading.style.opacity = '0'; setTimeout(() => { loading.style.display = 'none'; }, 400); }

  App.ready = true;

  const saved = sessionStorage.getItem('activeRole');
  if (saved && App.roles.includes(saved)) {
    await enterRole(saved);
  } else if (App.roles.length > 1) {
    await enterRole(App.roles[0], true);
    openRoleSwitcher(true);
  } else {
    await enterRole(App.roles[0] || 'performer');
  }
});

async function loadAccount() {
  const uid = App.user.uid;
  let doc = await DataAPI.getUserDoc(uid);
  if (!doc) doc = {};
  let profile = doc.profile || null;
  let roles = (profile && Array.isArray(profile.roles)) ? profile.roles.slice() : [];

  // 舊帳號（尚無 roles）：預設為演奏者
  if (roles.length === 0) {
    roles = ['performer'];
    profile = { ...(profile || {}), username: (profile && profile.username) || App.user.displayName || '', email: App.user.email, roles };
    try { await DataAPI.updateProfile(uid, profile); } catch (e) { console.warn(e); }
  }
  App.userDoc = doc;
  App.profile = profile;
  App.roles = roles;

  if (roles.includes('provider')) {
    App.providerDoc = await DataAPI.getProvider(uid);
    if (!App.providerDoc) {
      App.providerDoc = { profile: { name: profile.username || App.user.displayName || '', email: App.user.email, emailLower: (App.user.email || '').toLowerCase() }, inviteCode: makeInviteCode() };
      try { await DataAPI.setProvider(uid, App.providerDoc); } catch (e) { console.warn(e); }
    }
  }
  App.alertSettings = doc.alertSettings || { visual: true, vibrate: true };
}

// ── 角色 ─────────────────────────────────────────────────────────
async function enterRole(role, silent) {
  App.activeRole = role;
  sessionStorage.setItem('activeRole', role);
  document.body.classList.toggle('role-provider', role === 'provider');
  document.body.classList.toggle('role-performer', role === 'performer');
  document.getElementById('nav-performer').hidden = role !== 'performer';
  document.getElementById('nav-provider').hidden = role !== 'provider';
  updateRoleChip();

  if (role === 'performer') {
    if (typeof stopAllDetection === 'function') stopAllDetection();
    await loadPerformerData();
    const incomplete = !App.profile || !App.profile.instrument;
    switchSection(incomplete ? 'profile' : 'dashboard');
    if (incomplete && !silent) showToast(tApp('toast_complete_profile'), 'info');
  } else {
    if (typeof stopAllDetection === 'function') stopAllDetection();
    await loadProviderData();
    switchSection('provider-cases');
  }
}

function updateRoleChip() {
  document.getElementById('role-chip-name').textContent = tApp(App.activeRole === 'provider' ? 'role_provider' : 'role_performer');
  const btn = document.getElementById('btn-switch-role');
  btn.style.display = 'inline-block';
  btn.textContent = App.roles.length > 1 ? tApp('btn_switch_role') : tApp('btn_add_role');
}

function openRoleSwitcher() {
  const modal = document.getElementById('role-modal');
  const perfBtn = modal.querySelector('.role-option.performer');
  const provBtn = modal.querySelector('.role-option.provider');
  perfBtn.style.display = App.roles.includes('performer') ? '' : 'none';
  provBtn.style.display = App.roles.includes('provider') ? '' : 'none';
  const add = document.getElementById('role-add-area');
  add.innerHTML = '';
  if (!App.roles.includes('performer')) {
    add.innerHTML += `<button class="btn btn-outline" onclick="addRole('performer')"><i data-lucide="plus"></i>${tApp('btn_add_performer_role')}</button> `;
  }
  if (!App.roles.includes('provider')) {
    add.innerHTML += `<button class="btn btn-outline" onclick="addRole('provider')"><i data-lucide="plus"></i>${tApp('btn_add_provider_role')}</button>`;
  }
  add.innerHTML += `<div style="margin-top:0.75rem;"><button class="link-btn btn btn-sm btn-outline" onclick="closeRoleSwitcher()">${tApp('btn_close')}</button></div>`;
  modal.classList.add('show');
  lucide.createIcons();
}
function closeRoleSwitcher() { document.getElementById('role-modal').classList.remove('show'); }

async function chooseRole(role) {
  closeRoleSwitcher();
  if (role !== App.activeRole) await enterRole(role);
}

async function addRole(role) {
  if (!confirm(tApp(role === 'performer' ? 'confirm_add_performer' : 'confirm_add_provider'))) return;
  const uid = App.user.uid;
  const roles = Array.from(new Set([...App.roles, role]));
  App.profile = { ...(App.profile || {}), roles };
  try {
    await DataAPI.updateProfile(uid, App.profile);
    if (role === 'provider' && !App.providerDoc) {
      App.providerDoc = {
        profile: { name: App.profile.username || App.user.displayName || '', email: App.user.email, emailLower: (App.user.email || '').toLowerCase() },
        inviteCode: makeInviteCode(), createdAtMs: Date.now()
      };
      await DataAPI.setProvider(uid, App.providerDoc);
    }
    App.roles = roles;
    closeRoleSwitcher();
    showToast(tApp('toast_role_added'), 'success');
    await enterRole(role);
    switchSection(role === 'performer' ? 'profile' : 'provider-profile');
  } catch (err) {
    console.error(err);
    showToast(tApp('toast_save_fail'), 'danger');
  }
}

// =================================================================
// 路由與共用 UI
// =================================================================
function switchSection(sectionId) {
  const target = document.getElementById(`section-${sectionId}`);
  if (!target) return;
  if (target.dataset.role && target.dataset.role !== App.activeRole) return;

  if (App.currentSection === 'playing' && sectionId !== 'playing' && typeof onLeavePlaying === 'function') onLeavePlaying();

  document.querySelectorAll('main > section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
  target.classList.add('active');
  const nav = document.getElementById(`nav-${sectionId}`);
  if (nav) nav.classList.add('active');
  App.currentSection = sectionId;
  renderSection(sectionId);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderSection(id) {
  switch (id) {
    case 'dashboard': renderDashboard(); break;
    case 'profile': fillProfileForm(); break;
    case 'playing': if (typeof renderPlayingPage === 'function') renderPlayingPage(); break;
    case 'history': filterHistory(); break;
    case 'records': if (typeof renderRecordsPage === 'function') renderRecordsPage(); break;
    case 'education': if (typeof renderEducationPage === 'function') renderEducationPage(); break;
    case 'authorization': if (typeof renderAuthorizationPage === 'function') renderAuthorizationPage(); break;
    case 'provider-cases': if (typeof renderCaseList === 'function') renderCaseList(); break;
    case 'provider-case': if (typeof renderCaseDashboard === 'function') renderCaseDashboard(); break;
    case 'provider-advice': if (typeof renderAdvicePage === 'function') renderAdvicePage(); break;
    case 'provider-profile': if (typeof fillProviderProfileForm === 'function') fillProviderProfileForm(); break;
  }
  lucide.createIcons();
}

function refreshCurrentView() {
  updateRoleChip();
  updateHeaderNames();
  renderSection(App.currentSection);
  if (typeof refreshStageCards === 'function') refreshStageCards();
}

function switchTab(groupId, tabId) {
  const group = document.getElementById(groupId);
  if (!group) return;
  group.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
  const container = group.parentElement;
  group.querySelectorAll('.tab-btn').forEach(b => {
    const panel = container.querySelector(`#${b.dataset.tab}`);
    if (panel) panel.classList.toggle('active', b.dataset.tab === tabId);
  });
  if (typeof onTabSwitched === 'function') onTabSwitched(groupId, tabId);
  lucide.createIcons();
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icon = { success: 'check-circle', warning: 'alert-triangle', danger: 'alert-circle' }[type] || 'info';
  toast.innerHTML = `<i data-lucide="${icon}"></i><span></span>`;
  toast.querySelector('span').textContent = message;
  container.appendChild(toast);
  lucide.createIcons();
  setTimeout(() => {
    toast.style.animation = 'slideIn 0.2s reverse forwards';
    setTimeout(() => toast.remove(), 200);
  }, 3800);
}

function openModal(html) {
  document.getElementById('modal-content').innerHTML = html;
  document.getElementById('detail-modal').classList.add('show');
  lucide.createIcons();
}
function closeDetailModal() {
  document.getElementById('detail-modal').classList.remove('show');
  ChartRegistry.destroyGroup('modal');
}

// 頁面上方警示條
let pageAlertTimer = null;
function showPageAlert(text, kind = 'danger', ms = 8000) {
  const bar = document.getElementById('page-alert-bar');
  document.getElementById('page-alert-text').textContent = text;
  bar.classList.toggle('rest', kind === 'rest');
  bar.classList.add('show');
  clearTimeout(pageAlertTimer);
  if (ms) pageAlertTimer = setTimeout(dismissPageAlert, ms);
}
function dismissPageAlert() { document.getElementById('page-alert-bar').classList.remove('show'); }

// ── 格式化工具 ───────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtDateTime(ms) {
  if (!ms) return '--';
  return new Date(ms).toLocaleString(currentLang === 'en' ? 'en-GB' : 'zh-TW', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function fmtDate(ms) {
  if (!ms) return '--';
  return new Date(ms).toLocaleDateString(currentLang === 'en' ? 'en-GB' : 'zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' });
}
function fmtClock(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function fmtMinutes(sec) { return Math.round((sec || 0) / 60); }
function fmtNum(v, d = 1) { return (v === null || v === undefined || Number.isNaN(v)) ? '--' : Number(v).toFixed(d); }
function todayStr() { return dateKeyOf(Date.now()); }
function dateInputToMs(str, endOfDay) {
  if (!str) return null;
  const [y, m, d] = str.split('-').map(Number);
  return endOfDay ? new Date(y, m - 1, d, 23, 59, 59, 999).getTime() : new Date(y, m - 1, d).getTime();
}
function instrumentLabel(v) {
  if (v === '小提琴' || v === 'violin') return tApp('opt_violin');
  if (v === '大提琴' || v === 'cello') return tApp('opt_cello');
  return v || '--';
}
function optionLabel(map, v) { return map[v] ? tApp(map[v]) : (v || '--'); }
const GENDER_KEYS = { '男': 'opt_male', '女': 'opt_female', '其他': 'opt_other', '不便透露': 'opt_na' };
const IDENTITY_KEYS = { '音樂系學生': 'id_student', '職業演奏者': 'id_pro', '業餘演奏者': 'id_amateur', '其他': 'opt_other' };
const TITLE_KEYS = { '醫師': 'title_doctor', '物理治療師': 'title_pt', '其他': 'opt_other' };
const SPECIALTY_KEYS = { '骨科': 'sp_ortho', '復健科': 'sp_rehab', '運動醫學科': 'sp_sports', '一般物理治療': 'sp_pt', '其他': 'opt_other' };
const REFERRAL_KEYS = { '自行報名': 'ref_self', '醫師轉介': 'ref_doctor', '教師推薦': 'ref_teacher', '其他': 'opt_other' };

function providerTitleText(p) {
  if (!p) return '';
  return p.title === '其他' ? (p.titleOther || tApp('opt_other')) : optionLabel(TITLE_KEYS, p.title);
}

// ── 健康等級 ─────────────────────────────────────────────────────
function normalizeLevel(level) {
  if (level === '良好' || level === 'good') return 'good';
  if (level === '注意' || level === 'caution' || level === 'Caution') return 'caution';
  if (level === '警示' || level === 'alert' || level === 'Alert') return 'alert';
  return 'good';
}
function levelFromScore(score) {
  if (score >= SYSTEM_RULES.SCORE_GOOD) return 'good';
  if (score >= SYSTEM_RULES.SCORE_CAUTION) return 'caution';
  return 'alert';
}
function levelBadge(level) {
  const l = normalizeLevel(level);
  const cls = { good: 'badge-success', caution: 'badge-warning', alert: 'badge-danger' }[l];
  return `<span class="badge ${cls}">${tApp('level_' + l)}</span>`;
}

// ── 圖表管理 ─────────────────────────────────────────────────────
const ChartRegistry = {
  charts: {},
  // factory：回傳 new Chart(...) 的函式；先銷毀舊圖再建立，避免 canvas 重複使用錯誤
  set(id, factory, group = 'page') {
    this.destroy(id);
    const chart = factory();
    this.charts[id] = { chart, group };
    return chart;
  },
  destroy(id) {
    if (this.charts[id]) { try { this.charts[id].chart.destroy(); } catch (e) {} delete this.charts[id]; }
  },
  destroyGroup(group) {
    Object.keys(this.charts).forEach(id => { if (this.charts[id].group === group) this.destroy(id); });
  }
};
const CHART_COLORS = {
  cva: '#0D5661', shoulder: '#77428D', leftElbow: '#7BA23F', rightElbow: '#6C6024',
  threshold: '#8E354A', relax: '#91989F', prepare: '#0D5661', playing: '#77428D',
  score: '#36563C', grid: 'rgba(112,124,116,0.15)', tick: '#707C74', text: '#2F2E2B'
};
function baseChartOptions(extra = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { labels: { color: CHART_COLORS.text, font: { family: 'Noto Sans TC', size: 11 }, boxWidth: 14 } } },
    scales: {
      x: { grid: { display: false }, ticks: { color: CHART_COLORS.tick, font: { family: 'Noto Sans TC', size: 11 } } },
      y: { grid: { color: CHART_COLORS.grid }, ticks: { color: CHART_COLORS.tick } }
    },
    ...extra
  };
}

// =================================================================
// 分析計算（演奏者與照護端共用）
// =================================================================
function recordTimeMs(r) { return docTimeMs(r); }

/** 將一筆評估紀錄轉成統一的分析指標（相容舊版紀錄） */
function recordMetrics(r) {
  const ms = recordTimeMs(r);
  const out = {
    id: r.firestoreId || r.id, ms, dateKey: r.dateKey || dateKeyOf(ms), type: r.type,
    score: typeof r.score === 'number' ? r.score : null, level: normalizeLevel(r.level),
    cvaAvg: null, cvaBelowPct: null, shoulderAvg: null, shoulderOverPct: null,
    leftElbowAvg: null, rightElbowAvg: null, elbowOverPct: null, overAnyPct: null,
    practiceSec: r.practice ? r.practice.durationSec || 0 : 0,
    badSec: r.practice ? r.practice.badPostureSec || 0 : 0,
    alertCount: r.practice ? r.practice.alertCount || 0 : 0,
    stages: {}
  };
  if (r.type !== 'playing' || !r.details) return out;
  const d = r.details;
  if (d.summary) {
    Object.assign(out, {
      cvaAvg: d.summary.cvaAvg, cvaBelowPct: d.summary.cvaBelowPct,
      shoulderAvg: d.summary.shoulderAvg, shoulderOverPct: d.summary.shoulderOverPct,
      leftElbowAvg: d.summary.leftElbowAvg, rightElbowAvg: d.summary.rightElbowAvg,
      elbowOverPct: d.summary.elbowOverPct, overAnyPct: d.summary.overAnyPct
    });
    if (d.stages) {
      ['relax', 'prepare', 'playing'].forEach(s => {
        const st = d.stages[s];
        if (st && st.summary) out.stages[s] = st.summary;
      });
    }
  } else {
    // 舊版：只有 CVA Δ 與手肘真實資料
    const pc = d.cva && d.cva.playing;
    if (pc) out.cvaAvg = (pc.referenceAngle || 0) + (pc.avg || 0);
    if (d.raw && d.raw.playing && d.raw.playing.elbowData) {
      out.leftElbowAvg = d.raw.playing.elbowData.leftAvg;
      out.rightElbowAvg = d.raw.playing.elbowData.rightAvg;
    } else {
      out.leftElbowAvg = typeof d.leftElbow === 'number' ? d.leftElbow : null;
      out.rightElbowAvg = typeof d.rightElbow === 'number' ? d.rightElbow : null;
    }
    if (d.raw && d.raw.playing && d.raw.playing.shoulderData) out.shoulderAvg = d.raw.playing.shoulderData.avg;
  }
  return out;
}

function filterByPeriod(rows, fromMs, toMs) {
  return rows.filter(r => {
    const t = docTimeMs(r);
    return (!fromMs || t >= fromMs) && (!toMs || t <= toMs);
  });
}

/** 期間內異常統計：超過警戒值天數百分比等 */
function computeAbnormalStats(records, fromMs, toMs) {
  const playing = records.filter(r => r.type === 'playing').map(recordMetrics);
  const byDay = {};
  playing.forEach(m => {
    if (m.overAnyPct === null) return;
    (byDay[m.dateKey] = byDay[m.dateKey] || []).push(m);
  });
  const days = Object.keys(byDay).sort();
  const mean = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const dayStats = days.map(k => {
    const list = byDay[k];
    return {
      dateKey: k,
      overAny: mean(list.map(x => x.overAnyPct)),
      cva: mean(list.map(x => x.cvaBelowPct).filter(v => v !== null)),
      shoulder: mean(list.map(x => x.shoulderOverPct).filter(v => v !== null)),
      elbow: mean(list.map(x => x.elbowOverPct).filter(v => v !== null))
    };
  });
  let denom = dayStats.length;
  if (SYSTEM_RULES.OVER_DAY_DENOMINATOR === 'calendar' && fromMs && toMs) {
    denom = Math.max(1, Math.round((toMs - fromMs) / 86400000));
  }
  const th = SYSTEM_RULES.DAY_OVER_FRAME_PCT;
  const pctDays = key => denom ? dayStats.filter(d => d[key] !== null && d[key] >= th).length / denom * 100 : null;

  // 最常發生的階段
  const stageMeans = {};
  ['relax', 'prepare', 'playing'].forEach(s => {
    const vals = playing.map(m => m.stages[s] && m.stages[s].overAnyPct).filter(v => typeof v === 'number');
    stageMeans[s] = mean(vals);
  });
  // 最常發生的時段
  const slotOf = ms => { const h = new Date(ms).getHours(); return h < 12 ? 'morning' : (h < 18 ? 'afternoon' : 'evening'); };
  const slots = { morning: [], afternoon: [], evening: [] };
  playing.forEach(m => { if (m.overAnyPct !== null) slots[slotOf(m.ms)].push(m.overAnyPct); });
  const slotMeans = {};
  Object.keys(slots).forEach(k => { slotMeans[k] = mean(slots[k]); });
  const argmax = obj => {
    let best = null, val = -1;
    Object.keys(obj).forEach(k => { if (obj[k] !== null && obj[k] > val) { val = obj[k]; best = k; } });
    return best;
  };
  const paramMeans = {
    cva: mean(playing.map(m => m.cvaBelowPct).filter(v => v !== null)),
    shoulder: mean(playing.map(m => m.shoulderOverPct).filter(v => v !== null)),
    elbow: mean(playing.map(m => m.elbowOverPct).filter(v => v !== null))
  };
  return {
    recordedDays: dayStats.length, denom, dayStats,
    overDaysPct: pctDays('overAny'),
    overDaysPctByParam: { cva: pctDays('cva'), shoulder: pctDays('shoulder'), elbow: pctDays('elbow') },
    stageMeans, worstStage: argmax(stageMeans),
    slotMeans, worstSlot: argmax(slotMeans),
    paramMeans, worstParam: argmax(paramMeans),
    meanOverAny: mean(playing.map(m => m.overAnyPct).filter(v => v !== null))
  };
}

// =================================================================
// 演奏者：資料載入
// =================================================================
async function loadPerformerData() {
  const uid = App.user.uid;
  const safe = async (sub) => { try { return await DataAPI.listSub(uid, sub); } catch (e) { console.warn(sub, e); return []; } };
  const [records, bodyMaps, questionnaires, practiceLogs, medicalLogs, notes, advice] = await Promise.all([
    safe('records'), safe('bodyMaps'), safe('questionnaires'), safe('practiceSessions'),
    safe('medicalLogs'), safe('notes'), safe('notesFromProviders')
  ]);
  Object.assign(App, { records, bodyMaps, questionnaires, practiceLogs, medicalLogs, notes, advice });
  try { App.bindings = await DataAPI.listBindings('performerUid', uid); } catch (e) { console.warn(e); App.bindings = []; }
  updateHeaderNames();
}

async function refreshPerformerSub(sub, key) {
  try { App[key] = await DataAPI.listSub(App.user.uid, sub); } catch (e) { console.warn(e); }
}

function updateHeaderNames() {
  const p = App.profile || {};
  const name = p.username || App.user.displayName || App.user.email || tApp('guest');
  const inst = p.instrument ? ` · ${instrumentLabel(p.instrument)}` : '';
  const ch = (name || '?').charAt(0).toUpperCase();
  [['header-username', 'header-avatar'], ['playing-username', 'playing-avatar']].forEach(([n, a]) => {
    const ne = document.getElementById(n), ae = document.getElementById(a);
    if (ne) ne.textContent = name + inst;
    if (ae) ae.textContent = ch;
  });
  const pv = App.providerDoc && App.providerDoc.profile;
  if (pv) {
    const pn = document.getElementById('provider-username'), pa = document.getElementById('provider-avatar');
    if (pn) pn.textContent = `${pv.name || name} · ${providerTitleText(pv)}`;
    if (pa) pa.textContent = (pv.name || name || '?').charAt(0).toUpperCase();
  }
}

// =================================================================
// 演奏者：基本資料
// =================================================================
let profileBodyMap = null;

function latestBodyMap(context, maps = App.bodyMaps) {
  return maps.filter(m => m.context === context).sort((a, b) => docTimeMs(b) - docTimeMs(a))[0] || null;
}

function fillProfileForm() {
  const p = App.profile || {};
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = (v === null || v === undefined) ? '' : v; };
  set('pf-username', p.username || App.user.displayName || '');
  set('pf-gender', p.gender);
  set('pf-birthdate', p.birthdate);
  set('pf-identity', p.identity);
  set('pf-phone', p.phone);
  set('pf-height', p.height);
  set('pf-weight', p.weight);
  set('pf-emergency', p.emergencyContact);
  set('pf-instrument', p.instrument);
  set('pf-years', p.yearsOfStudy);
  set('pf-days', p.practiceDaysPerWeek);
  set('pf-minutes', p.practiceMinutesPerSession);
  set('pf-pt-note', p.physicalTherapyNote);
  set('pf-msk', p.mskHistory);
  set('pf-surgery', p.surgeryHistory);
  set('pf-meds', p.currentMedication);
  set('pf-allergy', p.allergies);
  set('pf-referral', p.referralSource);
  document.querySelectorAll('input[name="pf-pt"]').forEach(r => { r.checked = (r.value === 'yes') === !!p.hadPhysicalTherapy; });
  document.getElementById('pf-consent-research').checked = !!p.consentResearch;
  document.getElementById('pf-consent-data').checked = !!p.consentDataUse;

  const hint = document.getElementById('pf-age-hint');
  const age = ageFromBirthdate(p.birthdate) ?? p.age;
  hint.textContent = age !== null && age !== undefined ? tApp('age_hint', { age }) : '';

  const baseline = latestBodyMap('baseline');
  profileBodyMap = BodyMap.create(document.getElementById('profile-bodymap'), {
    marks: baseline ? baseline.marks : [], editable: true, gender: p.gender
  });
  document.getElementById('profile-bodymap-meta').textContent = baseline ? tApp('bodymap_updated_at', { date: fmtDateTime(docTimeMs(baseline)) }) : '';
}

async function saveProfile(event) {
  event.preventDefault();
  const v = id => document.getElementById(id).value.trim();
  const n = id => { const x = v(id); return x === '' ? null : Number(x); };
  const consentResearch = document.getElementById('pf-consent-research').checked;
  const consentDataUse = document.getElementById('pf-consent-data').checked;
  if (!consentResearch || !consentDataUse) { showToast(tApp('toast_consent_required'), 'warning'); return; }

  const birthdate = v('pf-birthdate');
  const pt = document.querySelector('input[name="pf-pt"]:checked');
  const old = App.profile || {};
  const profile = {
    ...old,
    username: v('pf-username'),
    email: old.email || App.user.email,
    roles: App.roles,
    gender: v('pf-gender'),
    birthdate,
    age: ageFromBirthdate(birthdate),
    identity: v('pf-identity'),
    phone: v('pf-phone'),
    height: n('pf-height'),
    weight: n('pf-weight'),
    emergencyContact: v('pf-emergency'),
    instrument: v('pf-instrument'),
    yearsOfStudy: n('pf-years'),
    practiceDaysPerWeek: n('pf-days'),
    practiceMinutesPerSession: n('pf-minutes'),
    hadPhysicalTherapy: pt ? pt.value === 'yes' : false,
    physicalTherapyNote: v('pf-pt-note'),
    mskHistory: v('pf-msk'),
    surgeryHistory: v('pf-surgery'),
    currentMedication: v('pf-meds'),
    allergies: v('pf-allergy'),
    referralSource: v('pf-referral'),
    consentResearch, consentDataUse,
    consentAt: old.consentAt || Date.now()
  };
  try {
    await DataAPI.updateProfile(App.user.uid, profile);
    App.profile = profile;

    // 人體圖有變動時新增一筆 baseline（保留歷史）
    const marks = profileBodyMap ? profileBodyMap.getMarks() : [];
    const baseline = latestBodyMap('baseline');
    if (JSON.stringify(marks) !== JSON.stringify(baseline ? baseline.marks : [])) {
      await DataAPI.addSub(App.user.uid, 'bodyMaps', { context: 'baseline', recordId: null, marks, gender: profile.gender });
      await refreshPerformerSub('bodyMaps', 'bodyMaps');
    }
    updateHeaderNames();
    showToast(tApp('toast_profile_saved'), 'success');
    fillProfileForm();
  } catch (err) {
    console.error('個資寫入失敗：', err);
    showToast(tApp('toast_save_fail'), 'danger');
  }
}

async function saveAlertSettings() {
  const vibrate = document.getElementById('alert-vibrate-toggle').checked;
  App.alertSettings = { visual: true, vibrate };
  try { await DataAPI.setUserDoc(App.user.uid, { alertSettings: App.alertSettings }); } catch (e) { console.warn(e); }
}

// =================================================================
// 演奏者：個人儀表板
// =================================================================
function renderDashboard() {
  const records = App.records;
  const playing = records.filter(r => r.type === 'playing');
  document.getElementById('stat-total-count').textContent = records.length;
  document.getElementById('stat-last-score').textContent = playing.length ? playing[0].score : '--';
  const weekAgo = Date.now() - 7 * 86400000;
  const weekSec = App.practiceLogs.filter(p => docTimeMs(p) >= weekAgo).reduce((a, p) => a + (p.durationSec || 0), 0);
  document.getElementById('stat-week-practice').textContent = fmtMinutes(weekSec);
  document.getElementById('stat-providers').textContent = App.bindings.filter(b => b.status === 'active').length;

  renderDashboardTrendChart();

  // 照護建議（最新 3 則）
  const adviceEl = document.getElementById('dashboard-advice');
  adviceEl.innerHTML = App.advice.length
    ? App.advice.slice(0, 3).map(adviceItemHtml).join('')
    : `<p class="empty-state">${tApp('dash_no_advice')}</p>`;

  // 提醒
  const remEl = document.getElementById('dashboard-reminders');
  const reminders = typeof generateReminders === 'function' ? generateReminders() : [];
  remEl.innerHTML = reminders.length
    ? reminders.slice(0, 4).map(reminderItemHtml).join('')
    : `<p class="empty-state">${tApp('dash_no_reminders')}</p>`;
}

function adviceItemHtml(a) {
  const who = `${escapeHtml(a.providerName || '')} ${escapeHtml(a.providerTitleText || '')}`.trim();
  return `<div class="tip-item">
    <strong>${escapeHtml(a.recommendation || '')}</strong>
    ${a.diagnosis ? `<p>${tApp('label_assessment_note')}：${escapeHtml(a.diagnosis)}</p>` : ''}
    <div class="tip-meta">${who} · ${fmtDateTime(docTimeMs(a))}</div>
  </div>`;
}

function reminderItemHtml(r) {
  return `<div class="tip-item ${r.level || ''}"><strong>${escapeHtml(r.title)}</strong><p>${escapeHtml(r.text)}</p></div>`;
}

function renderDashboardTrendChart() {
  const canvas = document.getElementById('dashboardTrendChart');
  const empty = document.getElementById('dashboard-trend-empty');
  const list = App.records.filter(r => r.type === 'playing').slice(0, 10).reverse().map(recordMetrics);
  if (!list.length) {
    ChartRegistry.destroy('dashTrend');
    canvas.parentElement.style.display = 'none';
    empty.style.display = 'block';
    return;
  }
  canvas.parentElement.style.display = 'block';
  empty.style.display = 'none';
  const labels = list.map(m => fmtDate(m.ms).slice(5));
  ChartRegistry.set('dashTrend', () => new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: tApp('chart_score'), data: list.map(m => m.score), borderColor: CHART_COLORS.score, backgroundColor: 'rgba(54,86,60,0.08)', borderWidth: 2.5, tension: 0.25, fill: true, yAxisID: 'y', pointRadius: 4 },
        { label: tApp('chart_cva_below_pct'), data: list.map(m => m.cvaBelowPct), borderColor: CHART_COLORS.threshold, borderDash: [5, 4], borderWidth: 2, tension: 0.25, yAxisID: 'y1', pointRadius: 3, spanGaps: true }
      ]
    },
    options: baseChartOptions({
      scales: {
        x: { grid: { display: false }, ticks: { color: CHART_COLORS.tick } },
        y: { min: 0, max: 100, grid: { color: CHART_COLORS.grid }, ticks: { color: CHART_COLORS.tick }, title: { display: true, text: tApp('chart_score'), color: CHART_COLORS.tick } },
        y1: { min: 0, max: 100, position: 'right', grid: { display: false }, ticks: { color: CHART_COLORS.tick, callback: v => v + '%' } }
      }
    })
  }));
}

// =================================================================
// 演奏者：歷史紀錄
// =================================================================
let selectedRecordIds = new Set();

function recordSummaryText(r) {
  if (r.type === 'static') return escapeHtml(r.details && r.details.textSummary || '');
  const m = recordMetrics(r);
  const parts = [];
  if (m.cvaAvg !== null) parts.push(`CVA ${fmtNum(m.cvaAvg)}°`);
  if (m.cvaBelowPct !== null) parts.push(tApp('summary_cva_below', { pct: fmtNum(m.cvaBelowPct, 0) }));
  if (m.leftElbowAvg !== null) parts.push(`${tApp('elbow_short')} ${fmtNum(m.leftElbowAvg, 0)}° / ${fmtNum(m.rightElbowAvg, 0)}°`);
  return parts.join(' · ');
}

function typeLabel(r) {
  return r.type === 'playing' ? tApp('type_playing') : tApp('type_static');
}

function filterHistory() {
  const search = (document.getElementById('search-name').value || '').toLowerCase().trim();
  const level = document.getElementById('filter-level').value;
  const type = document.getElementById('filter-type').value;
  const rows = App.records.filter(r => {
    const text = `${fmtDateTime(docTimeMs(r))} ${r.projectName || ''} ${r.instrument || ''} ${recordSummaryText(r)}`.toLowerCase();
    return (!search || text.includes(search)) &&
      (level === 'All' || normalizeLevel(r.level) === level) &&
      (type === 'All' || r.type === type);
  });
  updateHistoryTable(rows);
}

function updateHistoryTable(records) {
  const tbody = document.getElementById('history-table-body');
  const checkAll = document.getElementById('check-all-records');
  if (checkAll) checkAll.checked = false;
  selectedRecordIds.clear();
  updateComparisonButton();

  if (!records.length) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state"><i data-lucide="inbox"></i>${tApp('history_empty')}</div></td></tr>`;
    lucide.createIcons();
    return;
  }
  tbody.innerHTML = records.map(r => {
    const rid = r.firestoreId;
    const practice = r.practice ? `${fmtMinutes(r.practice.durationSec)} ${tApp('unit_min')}` : '--';
    return `<tr>
      <td style="text-align:center;"><input type="checkbox" class="record-checkbox" data-id="${rid}" onchange="toggleRecordSelection('${rid}', this.checked)" ${r.type !== 'playing' ? 'disabled' : ''}></td>
      <td>${fmtDateTime(docTimeMs(r))}</td>
      <td><span class="badge badge-info">${escapeHtml(instrumentLabel(r.instrument))}</span></td>
      <td>${typeLabel(r)}</td>
      <td><div style="font-weight:600;">${r.score ?? '--'}</div><div class="muted small">${recordSummaryText(r)}</div></td>
      <td>${practice}</td>
      <td>${levelBadge(r.level)}</td>
      <td class="actions-cell">
        <button class="btn btn-outline btn-sm" onclick="viewHistoryDetail('${rid}')"><i data-lucide="eye"></i>${tApp('btn_view')}</button>
        <button class="btn btn-danger-outline btn-sm" onclick="deleteHistoryRecord('${rid}')" title="${tApp('btn_delete')}"><i data-lucide="trash-2"></i></button>
      </td>
    </tr>`;
  }).join('');
  lucide.createIcons();
}

function toggleRecordSelection(id, checked) {
  if (checked) selectedRecordIds.add(id); else selectedRecordIds.delete(id);
  updateComparisonButton();
}
function toggleSelectAll(box) {
  document.querySelectorAll('.record-checkbox:not(:disabled)').forEach(cb => {
    cb.checked = box.checked;
    toggleRecordSelection(cb.dataset.id, box.checked);
  });
}
function updateComparisonButton() {
  const btn = document.getElementById('btn-compare-records');
  document.getElementById('selected-count').textContent = selectedRecordIds.size;
  btn.style.display = selectedRecordIds.size >= 2 ? 'inline-flex' : 'none';
}

async function deleteHistoryRecord(id) {
  if (!confirm(tApp('confirm_delete_record'))) return;
  try {
    await DataAPI.deleteSub(App.user.uid, 'records', id);
    // 一併刪除該次評估的練習前後人體圖與練習時間紀錄
    for (const m of App.bodyMaps.filter(m => m.recordId === id)) await DataAPI.deleteSub(App.user.uid, 'bodyMaps', m.firestoreId);
    for (const p of App.practiceLogs.filter(p => p.recordId === id)) await DataAPI.deleteSub(App.user.uid, 'practiceSessions', p.firestoreId);
    await Promise.all([refreshPerformerSub('records', 'records'), refreshPerformerSub('bodyMaps', 'bodyMaps'), refreshPerformerSub('practiceSessions', 'practiceLogs')]);
    showToast(tApp('toast_deleted'), 'info');
    filterHistory();
  } catch (err) {
    console.error(err);
    showToast(tApp('toast_delete_fail'), 'danger');
  }
}

async function clearAllHistory() {
  if (!confirm(tApp('confirm_clear_records'))) return;
  try {
    await DataAPI.clearSub(App.user.uid, 'records');
    await refreshPerformerSub('records', 'records');
    showToast(tApp('toast_cleared'), 'warning');
    filterHistory();
  } catch (err) {
    showToast(tApp('toast_delete_fail'), 'danger');
  }
}

function exportHistoryData() {
  if (!App.records.length) { showToast(tApp('toast_nothing_export'), 'warning'); return; }
  const data = {
    exportedAt: new Date().toISOString(),
    profile: App.profile,
    records: App.records,
    bodyMaps: App.bodyMaps,
    questionnaires: App.questionnaires,
    practiceSessions: App.practiceLogs,
    medicalLogs: App.medicalLogs,
    notes: App.notes
  };
  const blob = new Blob([JSON.stringify(data, (k, v) => (v && typeof v.toMillis === 'function') ? v.toMillis() : v, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `performer_care_${todayStr()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  showToast(tApp('toast_exported'), 'success');
}

// ── 單筆詳細內容（演奏者與照護端共用） ───────────────────────────
function viewHistoryDetail(id, ctx) {
  const records = ctx ? ctx.records : App.records;
  const maps = ctx ? ctx.bodyMaps : App.bodyMaps;
  const gender = ctx ? (ctx.profile && ctx.profile.gender) : (App.profile && App.profile.gender);
  const r = records.find(x => x.firestoreId === id);
  if (!r) return;
  const m = recordMetrics(r);

  if (r.type !== 'playing') {
    openModal(`
      <span class="badge badge-muted">${tApp('type_static')}</span>
      <h2 class="modal-title" style="margin-top:0.5rem;">${escapeHtml(r.projectName || '')}</h2>
      <p class="muted">${fmtDateTime(m.ms)}</p>
      <div class="sample-flag" style="margin-top:1rem;">${tApp('legacy_static_note')}</div>
      <div class="card"><p>${escapeHtml(r.details && r.details.textSummary || '')}</p></div>`);
    return;
  }

  const pre = maps.find(x => x.recordId === id && x.context === 'pre');
  const post = maps.find(x => x.recordId === id && x.context === 'post');
  const scoreCls = { good: 'optimal', caution: 'warning', alert: 'danger' }[m.level];
  const pct = v => v === null ? '--' : `${fmtNum(v, 0)}%`;
  openModal(`
    <span class="badge badge-info">${tApp('type_playing')}</span>
    <h2 class="modal-title" style="margin-top:0.5rem;">${tApp('detail_title')}</h2>
    <p class="muted">${fmtDateTime(m.ms)} · ${escapeHtml(instrumentLabel(r.instrument))}${r.details && !r.details.summary ? ' · ' + tApp('legacy_record') : ''}</p>
    <div class="grid-2" style="margin-top:1.25rem;">
      <div class="card" style="display:flex; align-items:center; gap:1.25rem;">
        <div class="score-badge-large ${scoreCls}"><span class="score-value">${r.score ?? '--'}</span><span class="score-label">${tApp('score_label')}</span></div>
        <div>
          <div style="margin-bottom:0.4rem;">${levelBadge(r.level)}</div>
          <div class="muted small">${tApp('ps_duration')}：${r.practice ? fmtClock(r.practice.durationSec) : '--'}</div>
          <div class="muted small">${tApp('ps_bad')}：${r.practice ? fmtClock(r.practice.badPostureSec) : '--'}</div>
          <div class="muted small">${tApp('ps_alerts')}：${r.practice ? r.practice.alertCount : '--'}</div>
        </div>
      </div>
      <div class="card">
        <h4 style="color:var(--primary); margin-bottom:0.6rem; font-size:0.92rem;">${tApp('metrics_title')}</h4>
        <ul style="list-style:none; display:flex; flex-direction:column; gap:0.4rem; font-size:0.87rem;">
          <li><strong>CVA</strong>：${fmtNum(m.cvaAvg)}°（${tApp('below_threshold_ratio')} ${pct(m.cvaBelowPct)}）</li>
          <li><strong>${tApp('metric_shoulder')}</strong>：Δ ${fmtNum(m.shoulderAvg)}°（${tApp('over_ratio')} ${pct(m.shoulderOverPct)}）</li>
          <li><strong>${tApp('metric_left_elbow')} / ${tApp('metric_right_elbow')}</strong>：${fmtNum(m.leftElbowAvg, 0)}° / ${fmtNum(m.rightElbowAvg, 0)}°（${tApp('over_ratio')} ${pct(m.elbowOverPct)}）</li>
          <li class="muted small">${tApp('metrics_pending_note')}</li>
        </ul>
      </div>
    </div>
    <div class="card" style="margin-top:1.25rem;">
      <h4 style="color:var(--primary); margin-bottom:0.8rem; font-size:0.92rem;">${tApp('discomfort_title')}</h4>
      <div class="bodymap-pair">
        <div><h4>${tApp('sbm_pre')}</h4><div id="modal-map-pre"></div></div>
        <div><h4>${tApp('sbm_post')}</h4><div id="modal-map-post"></div></div>
      </div>
    </div>
    <div class="card" style="margin-top:1.25rem;">
      <h4 style="color:var(--primary); margin-bottom:0.6rem; font-size:0.92rem;">${tApp('chart_cva_title')}</h4>
      <div style="height:230px; position:relative;"><canvas id="modalCvaChart"></canvas></div>
    </div>`);
  BodyMap.create(document.getElementById('modal-map-pre'), { marks: pre ? pre.marks : [], editable: false, gender });
  BodyMap.create(document.getElementById('modal-map-post'), { marks: post ? post.marks : [], editable: false, gender });
  if (typeof renderCvaFrameChart === 'function') renderCvaFrameChart('modalCvaChart', r.details, 'modal');
}

function showComparisonModal() {
  const selected = App.records.filter(r => selectedRecordIds.has(r.firestoreId)).sort((a, b) => docTimeMs(a) - docTimeMs(b));
  if (selected.length < 2) { showToast(tApp('toast_select_two'), 'warning'); return; }
  const metrics = selected.map(recordMetrics);
  const rows = [
    ['score_label', m => m.score ?? '--'],
    ['metric_cva_avg', m => fmtNum(m.cvaAvg) + '°'],
    ['below_threshold_ratio', m => m.cvaBelowPct === null ? '--' : fmtNum(m.cvaBelowPct, 0) + '%'],
    ['metric_shoulder', m => 'Δ ' + fmtNum(m.shoulderAvg) + '°'],
    ['metric_left_elbow', m => fmtNum(m.leftElbowAvg, 0) + '°'],
    ['metric_right_elbow', m => fmtNum(m.rightElbowAvg, 0) + '°'],
    ['ps_duration', m => fmtClock(m.practiceSec)],
    ['ps_bad', m => fmtClock(m.badSec)]
  ];
  openModal(`
    <span class="badge badge-info">${tApp('compare_badge')}</span>
    <h2 class="modal-title" style="margin-top:0.5rem;">${tApp('compare_title')}</h2>
    <p class="muted">${tApp('compare_selected', { n: selected.length })}</p>
    <div class="card" style="margin-top:1.25rem;"><div class="chart-container-large"><canvas id="comparisonLineChart"></canvas></div></div>
    <div class="card" style="margin-top:1.25rem;"><div class="table-wrap"><table>
      <thead><tr><th></th>${metrics.map(m => `<th>${fmtDate(m.ms)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(([k, f]) => `<tr><td><strong>${tApp(k)}</strong></td>${metrics.map(m => `<td>${f(m)}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div></div>`);
  const labels = metrics.map(m => fmtDate(m.ms));
  ChartRegistry.set('cmpLine', () => new Chart(document.getElementById('comparisonLineChart').getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: tApp('metric_cva_avg'), data: metrics.map(m => m.cvaAvg), borderColor: CHART_COLORS.cva, tension: 0.2, borderWidth: 2.5 },
        { label: tApp('metric_left_elbow'), data: metrics.map(m => m.leftElbowAvg), borderColor: CHART_COLORS.leftElbow, tension: 0.2, borderWidth: 2 },
        { label: tApp('metric_right_elbow'), data: metrics.map(m => m.rightElbowAvg), borderColor: CHART_COLORS.rightElbow, tension: 0.2, borderWidth: 2 },
        { label: tApp('below_threshold_ratio') + ' (%)', data: metrics.map(m => m.cvaBelowPct), borderColor: CHART_COLORS.threshold, borderDash: [5, 4], tension: 0.2, borderWidth: 2 }
      ]
    },
    options: baseChartOptions()
  }), 'modal');
}
