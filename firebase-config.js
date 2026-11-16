// ── Firebase 設定（login.html 與 index.html 共用）────────────────
// 未來搬到實驗室伺服器時，只需替換此檔與 app.js 中的 DataAPI 區塊
const firebaseConfig = {
  apiKey: "AIzaSyD8oyp3qrsZ0lF6a4n20-TVzDCJLvpuelw",
  authDomain: "posture-assessment.firebaseapp.com",
  projectId: "posture-assessment",
  storageBucket: "posture-assessment.firebasestorage.app",
  messagingSenderId: "354726206119",
  appId: "1:354726206119:web:b78eb4f044236caeafd982",
  measurementId: "G-X26QMQHVVR"
};
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db   = firebase.firestore();

// ── 基本資料選項（login.html 與 index.html 共用） ─────────────────
// 職業類別：選項為暫定，之後可能調整
const OCCUPATION_OPTIONS = [
  { value: '職業樂團團員', zh: '職業樂團團員', en: 'Professional orchestra member' },
  { value: '音樂系學生',   zh: '音樂系學生',   en: 'Music student' },
  { value: '音樂教師',     zh: '音樂教師',     en: 'Music teacher' },
  { value: '業餘演奏者',   zh: '業餘演奏者',   en: 'Amateur player' },
  { value: '其他',         zh: '其他（請填寫）', en: 'Other (please specify)' }
];
// 慢性病／其他疾病：【示意選項】正式項目待研究者依初診單、新進人員健康調查表提供後替換
const COMORBIDITY_OPTIONS = [
  { value: 'hypertension', zh: '高血壓',         en: 'High blood pressure' },
  { value: 'diabetes',     zh: '糖尿病',         en: 'Diabetes' },
  { value: 'heart',        zh: '心臟疾病',       en: 'Heart disease' },
  { value: 'asthma',       zh: '氣喘',           en: 'Asthma' },
  { value: 'thyroid',      zh: '甲狀腺疾病',     en: 'Thyroid disease' },
  { value: 'ra',           zh: '類風濕性關節炎', en: 'Rheumatoid arthritis' },
  { value: 'osteoporosis', zh: '骨質疏鬆',       en: 'Osteoporosis' }
];
/** 舊版「身分」對應到新的職業類別（讀取舊資料時當預設值） */
function occupationFromLegacy(p) {
  if (!p) return { occupation: '', occupationOther: '' };
  if (p.occupation) return { occupation: p.occupation, occupationOther: p.occupationOther || '' };
  const id = p.identity || '';
  if (!id) return { occupation: '', occupationOther: '' };
  if (OCCUPATION_OPTIONS.some(o => o.value === id && o.value !== '其他')) return { occupation: id, occupationOther: '' };
  return { occupation: '其他', occupationOther: id === '其他' ? '' : id };
}
/** 依目前語言輸出勾選清單 HTML（name 用於 querySelectorAll 取值） */
function comorbidityChecksHtml(name, selected, lang) {
  const sel = new Set(selected || []);
  return COMORBIDITY_OPTIONS.map(o => `<label class="check-row"><input type="checkbox" name="${name}" value="${o.value}" ${sel.has(o.value) ? 'checked' : ''}> <span>${lang === 'en' ? o.en : o.zh}</span></label>`).join('');
}
function comorbidityLabel(v, lang) { const o = COMORBIDITY_OPTIONS.find(x => x.value === v); return o ? (lang === 'en' ? o.en : o.zh) : v; }

// 共用小工具
function dateKeyOf(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function makeInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function ageFromBirthdate(birthdate) {
  if (!birthdate) return null;
  const b = new Date(birthdate);
  if (isNaN(b)) return null;
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  const m = now.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age--;
  return age >= 0 && age < 130 ? age : null;
}
