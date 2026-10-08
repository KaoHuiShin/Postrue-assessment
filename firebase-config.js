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
