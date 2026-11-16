// =================================================================
// standard-movement.js — 標準動作辨識（v2.7）
//   高低肩（正面）、頭部前傾 CVA（側面）、肩外展（正面，左右同時）、
//   肩前屈（側面，左右各一次）。
//   ・與演奏動作評估共用同一個 MediaPipe Pose 實例（detection.js 的 initCvaPose）。
//   ・角度一律以「像素座標」計算（先把 normalized 座標乘上影像寬高），避免 4:3 畫面造成角度偏差。
//   ・判讀標準尚未定案（待研究者提供標準測量影片）：目前只記錄角度，不判定正常／異常，
//     紀錄的 score、level、judgment 皆為 null。
//   ・進入頁面先顯示引導頁（測量項目與步驟），按「開始測量」才進入測量畫面。
// =================================================================

// ── 測量流程參數（暫定，待標準測量影片確認後調整） ────────────────
const SM_PROTOCOL = {
  VERSION: 1,
  PREP_SEC: 3,            // 按下「開始測量」後的準備倒數
  STATIC_SEC: 3,          // 靜態項目（高低肩、頭部前傾）保持不動的測量秒數，取平均
  PEAK_SEC: 6,            // 動態項目（外展、前屈）測量秒數，取最大角度
  PEAK_SMOOTH: 5,         // 取最大值前先做 5 幀移動平均，避免單幀雜訊
  MIN_VIS: 0.5,           // 特徵點 visibility 低於此值的幀不採用
  MIN_VALID_RATIO: 0.6,   // 有效幀比例低於 60% 視為測量失敗
  MIN_VALID_FRAMES: 5,
  FRONT_RATIO_MIN: 0.45,  // 正面判定：肩寬 / 軀幹長 ≥ 0.45
  SIDE_RATIO_MAX: 0.30,   // 側面判定：肩寬 / 軀幹長 ≤ 0.30
  MAX_STORED_FRAMES: 300
};
// 判讀標準：待研究者提供標準測量影片後填入（null ＝ 不判讀）
const SM_JUDGMENT = null;

const SM_ITEMS = [
  { id: 'shoulderLevel', view: 'front', kind: 'static', icon: 'align-vertical-space-around' },
  { id: 'abduction',     view: 'front', kind: 'peak',   icon: 'move-vertical' },
  { id: 'forwardHead',   view: 'side',  kind: 'static', icon: 'scan-face' },
  { id: 'flexionRight',  view: 'side',  kind: 'peak',   icon: 'arrow-up-right', side: 'right' },
  { id: 'flexionLeft',   view: 'side',  kind: 'peak',   icon: 'arrow-up-left',  side: 'left' }
];
// MediaPipe Pose 特徵點（左右為受測者本人的左右）
const SM_IDX = {
  left:  { ear: 7, shoulder: 11, elbow: 13, wrist: 15, hip: 23 },
  right: { ear: 8, shoulder: 12, elbow: 14, wrist: 16, hip: 24 }
};

const SM = {
  active: false, stream: null, camera: null,
  current: 'shoulderLevel', phase: 'idle', phaseStart: 0,
  buf: null, results: {}, saving: false,
  guideDone: false   // 本次進入頁面是否已看過引導頁
};
const smItem = id => SM_ITEMS.find(i => i.id === id);

// ── 計算函式（與資料存取分開，未來換模型只改偵測來源） ─────────────
function smPt(lm, i, W, H) { return { x: lm[i].x * W, y: lm[i].y * H, v: lm[i].visibility ?? 1 }; }
const smVisOk = (...pts) => pts.every(p => p.v >= SM_PROTOCOL.MIN_VIS);

/** 高低肩：雙肩連線與水平線夾角；signed > 0 代表左肩較高 */
function smCalcShoulderLevel(lm, W, H) {
  const ls = smPt(lm, 11, W, H), rs = smPt(lm, 12, W, H);
  const angle = Math.atan2(Math.abs(ls.y - rs.y), Math.abs(ls.x - rs.x)) * 180 / Math.PI;
  return { ok: smVisOk(ls, rs), signed: ls.y < rs.y ? angle : -angle };
}

/** 頭部前傾 CVA（側面）：耳—肩連線與水平線夾角，自動選擇面向鏡頭（visibility 較高）的一側 */
function smCalcCVASide(lm, W, H) {
  const vis = s => (lm[SM_IDX[s].ear].visibility ?? 1) + (lm[SM_IDX[s].shoulder].visibility ?? 1);
  const side = vis('left') >= vis('right') ? 'left' : 'right';
  const ear = smPt(lm, SM_IDX[side].ear, W, H), sh = smPt(lm, SM_IDX[side].shoulder, W, H);
  const cva = Math.atan2(Math.abs(sh.y - ear.y), Math.abs(ear.x - sh.x)) * 180 / Math.PI;
  return { ok: smVisOk(ear, sh) && ear.y < sh.y, cva, side };
}

/** 肩關節角度：髖—肩—肘三點夾角（0° 手臂貼身，180° 手臂垂直上舉）；外展、前屈共用 */
function smCalcArmAngle(lm, side, W, H) {
  const ix = SM_IDX[side];
  const hip = smPt(lm, ix.hip, W, H), sh = smPt(lm, ix.shoulder, W, H), el = smPt(lm, ix.elbow, W, H);
  const angle = calcElbowAngle(hip, sh, el); // 通用三點夾角 arccos(A·B / |A||B|)
  return { ok: smVisOk(hip, sh, el) && !isNaN(angle), angle };
}

/** 視角判斷：肩寬 / 軀幹長（正面約 0.6 以上，側面約 0.3 以下） */
function smViewRatio(lm, W, H) {
  const ls = smPt(lm, 11, W, H), rs = smPt(lm, 12, W, H), lh = smPt(lm, 23, W, H), rh = smPt(lm, 24, W, H);
  const torso = Math.hypot((ls.x + rs.x) / 2 - (lh.x + rh.x) / 2, (ls.y + rs.y) / 2 - (lh.y + rh.y) / 2);
  return torso > 0 ? Math.hypot(ls.x - rs.x, ls.y - rs.y) / torso : null;
}
function smViewOk(view, ratio) {
  if (ratio === null || ratio === undefined) return null;
  return view === 'front' ? ratio >= SM_PROTOCOL.FRONT_RATIO_MIN : ratio <= SM_PROTOCOL.SIDE_RATIO_MAX;
}

/** 單幀計算（依項目） */
function smComputeFrame(item, lm, W, H) {
  const viewRatio = smViewRatio(lm, W, H);
  if (item.id === 'shoulderLevel') { const r = smCalcShoulderLevel(lm, W, H); return { ok: r.ok, v: { signed: r.signed }, viewRatio }; }
  if (item.id === 'forwardHead') { const r = smCalcCVASide(lm, W, H); return { ok: r.ok, v: { cva: r.cva, side: r.side }, viewRatio }; }
  if (item.id === 'abduction') {
    const l = smCalcArmAngle(lm, 'left', W, H), r = smCalcArmAngle(lm, 'right', W, H);
    return { ok: l.ok && r.ok, v: { left: l.angle, right: r.angle }, viewRatio };
  }
  const r = smCalcArmAngle(lm, item.side, W, H);
  return { ok: r.ok, v: { angle: r.angle }, viewRatio };
}

// ── 統計工具 ─────────────────────────────────────────────────────
const smSd = a => { if (a.length < 2) return null; const m = _avg(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
function smSmoothPeak(arr) {
  const k = SM_PROTOCOL.PEAK_SMOOTH;
  if (arr.length < k) return _max(arr);
  let best = -Infinity;
  for (let i = 0; i + k <= arr.length; i++) best = Math.max(best, _avg(arr.slice(i, i + k)));
  return best;
}

/** 測量結束：彙整單一項目的結果 */
function smFinalize(item, buf) {
  const frames = buf.frames;
  const validPct = _pct(frames.length, buf.total);
  if (frames.length < SM_PROTOCOL.MIN_VALID_FRAMES || frames.length / Math.max(1, buf.total) < SM_PROTOCOL.MIN_VALID_RATIO) {
    return { error: true, validPct };
  }
  const ratios = frames.map(f => f.viewRatio).filter(v => v !== null);
  const viewRatio = _avg(ratios);
  const base = {
    view: item.view, kind: item.kind, measuredAtMs: Date.now(),
    durationSec: item.kind === 'static' ? SM_PROTOCOL.STATIC_SEC : SM_PROTOCOL.PEAK_SEC,
    frameCount: buf.total, validFrames: frames.length, validPct,
    viewRatio: _r(viewRatio, 2), viewOk: smViewOk(item.view, viewRatio)
  };
  const ds = a => downsample(a, SM_PROTOCOL.MAX_STORED_FRAMES);
  if (item.id === 'shoulderLevel') {
    const s = frames.map(f => f.v.signed), m = _avg(s);
    return { ...base, angle: _r(Math.abs(m)), signedLeftHigher: _r(m), higherSide: m > 0 ? 'left' : (m < 0 ? 'right' : 'level'),
      sd: _r(smSd(s)), min: _r(_min(s)), max: _r(_max(s)), frames: ds(s) };
  }
  if (item.id === 'forwardHead') {
    const c = frames.map(f => f.v.cva);
    const leftN = frames.filter(f => f.v.side === 'left').length;
    return { ...base, cva: _r(_avg(c)), sd: _r(smSd(c)), min: _r(_min(c)), max: _r(_max(c)),
      side: leftN >= frames.length / 2 ? 'left' : 'right', frames: ds(c) };
  }
  if (item.id === 'abduction') {
    const l = frames.map(f => f.v.left), r = frames.map(f => f.v.right);
    return { ...base, left: _r(smSmoothPeak(l), 1), right: _r(smSmoothPeak(r), 1), leftFrames: ds(l), rightFrames: ds(r) };
  }
  const a = frames.map(f => f.v.angle);
  return { ...base, side: item.side, angle: _r(smSmoothPeak(a), 1), frames: ds(a) };
}

// ── 偵測來源：由 detection.js 的 onPoseResults 轉送 ───────────────
function smOnPoseResults(results) {
  const video = document.getElementById('sm-video');
  const canvas = document.getElementById('sm-overlay');
  if (!video || !canvas) return;
  const W = (results.image && results.image.width) || video.videoWidth || 640;
  const H = (results.image && results.image.height) || video.videoHeight || 480;
  const lm = results.poseLandmarks;
  const item = smItem(SM.current);
  const fr = lm ? smComputeFrame(item, lm, W, H) : null;

  syncOverlaySize(canvas);
  smDrawOverlay(canvas, lm, item, fr, W, H);
  smUpdateLive(item, fr);

  if (SM.phase === 'idle') return;
  const now = performance.now();
  const el = (now - SM.phaseStart) / 1000;
  if (SM.phase === 'prep') {
    const left = Math.ceil(SM_PROTOCOL.PREP_SEC - el);
    smSetPrompt(left > 0 ? `<span class="sm-count">${left}</span>${tApp('sm_prompt_ready')}` : '', 'prep');
    if (el >= SM_PROTOCOL.PREP_SEC) { SM.phase = 'measure'; SM.phaseStart = now; }
    return;
  }
  // 測量中
  const dur = item.kind === 'static' ? SM_PROTOCOL.STATIC_SEC : SM_PROTOCOL.PEAK_SEC;
  SM.buf.total++;
  if (fr && fr.ok) SM.buf.frames.push(fr);
  smSetPrompt(`${tApp(item.kind === 'static' ? 'sm_prompt_hold' : 'sm_prompt_raise')}<div class="sm-progress"><div style="width:${Math.min(100, el / dur * 100)}%"></div></div>`, 'measure');
  if (el >= dur) smFinishMeasure();
}

function smFinishMeasure() {
  const item = smItem(SM.current);
  const res = smFinalize(item, SM.buf);
  SM.phase = 'idle';
  SM.buf = null;
  smSetPrompt('', '');
  if (res.error) {
    showToast(tApp('sm_toast_fail', { pct: fmtNum(res.validPct, 0) }), 'danger');
  } else {
    SM.results[item.id] = res;
    showToast(tApp('sm_toast_done', { item: tApp('sm_item_' + item.id), v: smValueText(item.id, res) }), 'success');
    if (res.viewOk === false) showToast(tApp(item.view === 'front' ? 'sm_view_warn_front' : 'sm_view_warn_side'), 'warning');
    const next = SM_ITEMS.find(i => !SM.results[i.id]);
    if (next) SM.current = next.id;
  }
  renderStandardPage();
}

// ── 疊圖 ─────────────────────────────────────────────────────────
function smDrawOverlay(canvas, lm, item, fr, W, H) {
  const ctx = canvas.getContext('2d');
  const cw = canvas.width, ch = canvas.height;
  ctx.clearRect(0, 0, cw, ch);
  if (!lm) return;
  // video 使用 object-fit: contain → 計算顯示區域
  const s = Math.min(cw / W, ch / H), ox = (cw - W * s) / 2, oy = (ch - H * s) / 2;
  const P = i => ({ x: ox + lm[i].x * W * s, y: oy + lm[i].y * H * s, v: lm[i].visibility ?? 1 });
  const line = (a, b, color, w = 3) => { ctx.strokeStyle = color; ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); };
  const dot = (p, color) => { ctx.fillStyle = p.v < SM_PROTOCOL.MIN_VIS ? '#91989F' : color; ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke(); };
  const label = (text, p, dy = -16) => {
    ctx.save(); ctx.translate(p.x, p.y + dy); ctx.scale(-1, 1); // 畫布鏡像，文字反向繪製
    ctx.font = 'bold 12px monospace';
    const tw = ctx.measureText(text).width + 10;
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(-tw / 2, -12, tw, 19);
    ctx.fillStyle = '#E5ECE4'; ctx.textAlign = 'center'; ctx.fillText(text, 0, 2);
    ctx.restore();
  };
  // 淡色全身骨架
  [[11, 12], [11, 23], [12, 24], [23, 24], [11, 13], [13, 15], [12, 14], [14, 16]].forEach(([a, b]) => line(P(a), P(b), 'rgba(229,236,228,0.35)', 2));

  const AI = '#0D5661', MURA = '#77428D', MOEGI = '#7BA23F', CHA = '#6C6024';
  if (item.id === 'shoulderLevel') {
    const a = P(11), b = P(12);
    line(a, b, MURA, 3);
    ctx.setLineDash([5, 4]); line({ x: Math.min(a.x, b.x) - 30, y: (a.y + b.y) / 2 }, { x: Math.max(a.x, b.x) + 30, y: (a.y + b.y) / 2 }, 'rgba(145,152,159,0.8)', 1.5); ctx.setLineDash([]);
    dot(a, MURA); dot(b, MURA);
    if (fr) label(`${Math.abs(fr.v.signed).toFixed(1)}°`, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  } else if (item.id === 'forwardHead') {
    const side = fr ? fr.v.side : 'left';
    const e = P(SM_IDX[side].ear), sh = P(SM_IDX[side].shoulder);
    line(e, sh, AI, 3);
    ctx.setLineDash([5, 4]); line({ x: sh.x - 70, y: sh.y }, { x: sh.x + 70, y: sh.y }, 'rgba(145,152,159,0.8)', 1.5); ctx.setLineDash([]);
    dot(e, AI); dot(sh, AI);
    if (fr) label(`CVA ${fr.v.cva.toFixed(1)}°`, { x: (e.x + sh.x) / 2, y: (e.y + sh.y) / 2 });
  } else {
    const sides = item.id === 'abduction' ? ['left', 'right'] : [item.side];
    sides.forEach(sd => {
      const ix = SM_IDX[sd], color = sd === 'left' ? MOEGI : CHA;
      const hp = P(ix.hip), sh = P(ix.shoulder), el = P(ix.elbow);
      line(hp, sh, color, 3); line(sh, el, color, 3);
      dot(hp, color); dot(sh, color); dot(el, color);
      const v = fr ? (item.id === 'abduction' ? fr.v[sd] : fr.v.angle) : NaN;
      if (!isNaN(v)) label(`${sd === 'left' ? 'L' : 'R'} ${v.toFixed(0)}°`, sh, -22);
    });
  }
}

function smUpdateLive(item, fr) {
  const live = document.getElementById('sm-live');
  const warn = document.getElementById('sm-view-warn');
  if (!live) return;
  if (!fr) { live.textContent = tApp('sm_no_person'); if (warn) warn.style.display = 'none'; return; }
  live.textContent = `${tApp('sm_item_' + item.id)} ${smLiveValueText(item, fr)}${fr.ok ? '' : ' · ' + tApp('sm_low_vis')}`;
  const ok = smViewOk(item.view, fr.viewRatio);
  if (warn) {
    warn.style.display = ok === false ? 'block' : 'none';
    warn.textContent = tApp(item.view === 'front' ? 'sm_view_warn_front' : 'sm_view_warn_side');
  }
}
function smLiveValueText(item, fr) {
  const v = fr.v;
  if (item.id === 'shoulderLevel') return `${Math.abs(v.signed).toFixed(1)}°`;
  if (item.id === 'forwardHead') return `${v.cva.toFixed(1)}°`;
  if (item.id === 'abduction') return `L ${isNaN(v.left) ? '--' : v.left.toFixed(0)}° / R ${isNaN(v.right) ? '--' : v.right.toFixed(0)}°`;
  return `${isNaN(v.angle) ? '--' : v.angle.toFixed(0)}°`;
}
function smSetPrompt(html, cls) {
  const el = document.getElementById('sm-prompt');
  if (!el) return;
  el.innerHTML = html;
  el.className = 'sm-prompt' + (html ? ' show ' + cls : '');
}

// ── 攝影機 ───────────────────────────────────────────────────────
async function smToggleCamera() { if (SM.stream) { smStopCamera(); renderStandardPage(); } else await smStartCamera(); }

async function smStartCamera() {
  if (!App.profile || !App.profile.instrument) { showToast(tApp('toast_need_profile'), 'warning'); switchSection('profile'); return; }
  if (typeof cvaState !== 'undefined' && cvaState.activeStage) closeCamera();
  const btn = document.getElementById('sm-cam-btn');
  btn.disabled = true; btn.textContent = tApp('loading');
  const ready = await initCvaPose().catch(err => { console.error(err); return false; });
  if (!ready) { btn.disabled = false; renderStandardPage(); return; }
  try {
    SM.stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
  } catch (err) {
    showToast(tApp('toast_camera_denied'), 'danger');
    btn.disabled = false; renderStandardPage(); return;
  }
  // 使用者在等待權限時已離開頁面 → 立即關閉
  if (App.currentSection !== 'standard-movement') { SM.stream.getTracks().forEach(t => t.stop()); SM.stream = null; btn.disabled = false; return; }
  const video = document.getElementById('sm-video');
  video.srcObject = SM.stream;
  video.style.display = 'block';
  document.getElementById('sm-overlay').style.display = 'block';
  document.getElementById('sm-placeholder').style.display = 'none';
  document.getElementById('sm-live').style.display = 'block';
  SM.active = true;
  SM.camera = new Camera(video, {
    onFrame: async () => { if (SM.active && cvaState.pose) await cvaState.pose.send({ image: video }); },
    width: 640, height: 480
  });
  SM.camera.start();
  btn.disabled = false;
  renderStandardPage();
}

function smStopCamera() {
  SM.active = false;
  SM.phase = 'idle'; SM.buf = null;
  if (SM.camera) { try { SM.camera.stop(); } catch (e) {} SM.camera = null; }
  if (SM.stream) { SM.stream.getTracks().forEach(t => t.stop()); SM.stream = null; }
  const video = document.getElementById('sm-video');
  if (!video) return;
  video.style.display = 'none'; video.srcObject = null;
  const ov = document.getElementById('sm-overlay');
  ov.style.display = 'none'; ov.getContext('2d').clearRect(0, 0, ov.width, ov.height);
  document.getElementById('sm-placeholder').style.display = 'flex';
  ['sm-live', 'sm-view-warn'].forEach(id => { document.getElementById(id).style.display = 'none'; });
  smSetPrompt('', '');
}
function onLeaveStandard() {
  if (SM.stream) smStopCamera();
  // 已測但未儲存的結果保留；下次進入若沒有暫存結果，重新顯示引導頁
  if (!Object.keys(SM.results).length) SM.guideDone = false;
}

// ── 測量控制 ─────────────────────────────────────────────────────
function smSelect(id) { if (SM.phase !== 'idle') return; SM.current = id; renderStandardPage(); }

function smStartMeasure(id, event) {
  if (event) event.stopPropagation();
  if (!SM.stream) { showToast(tApp('sm_toast_need_camera'), 'warning'); return; }
  if (SM.phase !== 'idle') return;
  SM.current = id;
  SM.phase = 'prep';
  SM.phaseStart = performance.now();
  SM.buf = { total: 0, frames: [] };
  renderStandardPage();
}

function smCancelMeasure() {
  SM.phase = 'idle'; SM.buf = null; smSetPrompt('', '');
  renderStandardPage();
}

// ── 引導頁 ───────────────────────────────────────────────────────
function smStartFromGuide() {
  SM.guideDone = true;
  renderStandardPage();
  const main = document.getElementById('sm-main');
  if (main) main.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function smShowGuide() {
  if (SM.phase !== 'idle') return;
  if (SM.stream) smStopCamera();
  SM.guideDone = false;
  renderStandardPage();
}

function renderStandardGuide() {
  const el = document.getElementById('sm-guide-items');
  if (!el) return;
  const prm = { prep: SM_PROTOCOL.PREP_SEC, s: SM_PROTOCOL.STATIC_SEC, p: SM_PROTOCOL.PEAK_SEC };
  const group = view => `
    <div class="sm-guide-group">
      <div class="sm-view-head"><i data-lucide="${view === 'front' ? 'user' : 'user-round'}"></i>${tApp('sm_view_group_' + view)}</div>
      <p class="muted small" style="margin:0 0 0.6rem;">${tApp('sm_guide_pos_' + view)}</p>
      ${SM_ITEMS.filter(i => i.view === view).map(it => `
        <div class="sm-guide-item">
          <div class="step-icon"><i data-lucide="${it.icon}"></i></div>
          <div>
            <div class="sm-step-title">${SM_ITEMS.indexOf(it) + 1}. ${tApp('sm_item_' + it.id)}
              <span class="badge badge-muted">${tApp(it.kind === 'static' ? 'sm_kind_static' : 'sm_kind_peak', prm)}</span></div>
            <div class="muted small">${tApp('sm_ins_' + it.id, prm)}</div>
          </div>
        </div>`).join('')}
    </div>`;
  el.innerHTML = group('front') + group('side');
  document.getElementById('sm-guide-steps').innerHTML = [1, 2, 3, 4, 5].map(n => `<li>${tApp('sm_guide_step' + n, prm)}</li>`).join('');
}

// ── 頁面渲染 ─────────────────────────────────────────────────────
function renderStandardPage() {
  const guide = document.getElementById('sm-guide');
  const main = document.getElementById('sm-main');
  if (!guide || !main) return;
  guide.style.display = SM.guideDone ? 'none' : 'block';
  main.style.display = SM.guideDone ? 'block' : 'none';
  if (!SM.guideDone) { renderStandardGuide(); lucide.createIcons(); return; }

  const list = document.getElementById('sm-step-list');
  const busy = SM.phase !== 'idle';
  const camBtn = document.getElementById('sm-cam-btn');
  camBtn.innerHTML = SM.stream ? `<i data-lucide="video-off"></i>${tApp('btn_close_camera')}` : `<i data-lucide="video"></i>${tApp('btn_open_camera')}`;
  camBtn.disabled = busy;
  document.getElementById('sm-guide-btn').disabled = busy;
  setText('sm-status-text', SM.stream ? (busy ? `● ${tApp('sm_measuring')}` : 'CAMERA ON') : 'CAMERA OFF');
  document.getElementById('sm-status-dot').style.background = SM.stream ? (busy ? '#8E354A' : '#36563C') : '';

  let lastView = null;
  list.innerHTML = SM_ITEMS.map((it, i) => {
    const res = SM.results[it.id];
    const head = it.view !== lastView ? `<div class="sm-view-head"><i data-lucide="${it.view === 'front' ? 'user' : 'user-round'}"></i>${tApp('sm_view_group_' + it.view)}</div>` : '';
    lastView = it.view;
    const isCur = SM.current === it.id;
    const measuringThis = busy && isCur;
    return `${head}<div class="sm-step ${isCur ? 'active' : ''} ${res ? 'captured' : ''}" onclick="smSelect('${it.id}')">
      <div class="step-icon"><i data-lucide="${res ? 'check' : it.icon}"></i></div>
      <div class="sm-step-main">
        <div class="sm-step-title">${i + 1}. ${tApp('sm_item_' + it.id)}</div>
        <div class="muted small">${res ? `${smValueText(it.id, res)}${res.viewOk === false ? ' · <span class="sm-warn-text">' + tApp('sm_view_mismatch') + '</span>' : ''}` : tApp('sm_not_measured')}</div>
      </div>
      ${measuringThis
        ? `<button class="btn btn-outline btn-sm" onclick="event.stopPropagation(); smCancelMeasure()">${tApp('sm_btn_cancel')}</button>`
        : `<button class="btn ${res ? 'btn-outline' : 'btn-primary'} btn-sm" onclick="smStartMeasure('${it.id}', event)" ${(!SM.stream || busy) ? 'disabled' : ''}><i data-lucide="${res ? 'refresh-cw' : 'play'}"></i>${tApp(res ? 'sm_btn_remeasure' : 'sm_btn_measure')}</button>`}
    </div>`;
  }).join('');

  // 目前項目說明
  const cur = smItem(SM.current);
  document.getElementById('sm-ins-title').textContent = tApp('sm_item_' + cur.id);
  document.getElementById('sm-ins-view').textContent = tApp('sm_view_' + cur.view);
  document.getElementById('sm-ins-text').textContent = tApp('sm_ins_' + cur.id, { prep: SM_PROTOCOL.PREP_SEC, s: SM_PROTOCOL.STATIC_SEC, p: SM_PROTOCOL.PEAK_SEC });
  document.getElementById('sm-ins-def').textContent = tApp('sm_def_' + (cur.id.startsWith('flexion') ? 'flexion' : cur.id));

  // 本次結果
  const n = Object.keys(SM.results).length;
  document.getElementById('sm-result-body').innerHTML = SM_ITEMS.map(it => {
    const r = SM.results[it.id];
    return `<tr><td>${tApp('sm_item_' + it.id)}</td><td>${r ? smValueText(it.id, r) : '--'}</td><td class="muted small">${r ? `${fmtNum(r.validPct, 0)}%` : ''}</td></tr>`;
  }).join('');
  document.getElementById('sm-save-btn').disabled = n === 0 || busy || SM.saving;
  document.getElementById('sm-reset-btn').disabled = n === 0 || busy;
  lucide.createIcons();
}
function setText(id, t) { const el = document.getElementById(id); if (el) el.textContent = t; }

// ── 顯示用文字（歷史紀錄、照護端、Excel 共用） ─────────────────────
function smSideLabel(side) { return tApp(side === 'left' ? 'sm_left' : (side === 'right' ? 'sm_right' : 'sm_level')); }
function smValueText(id, r) {
  if (!r) return '--';
  if (id === 'shoulderLevel') return `${fmtNum(r.angle)}°（${r.higherSide === 'level' ? smSideLabel('level') : tApp('sm_higher', { side: smSideLabel(r.higherSide) })}）`;
  if (id === 'forwardHead') return `CVA ${fmtNum(r.cva)}°`;
  if (id === 'abduction') return `L ${fmtNum(r.left, 0)}° / R ${fmtNum(r.right, 0)}°`;
  return `${fmtNum(r.angle, 0)}°`;
}

/** 由紀錄取出摘要數值（舊資料或缺項回傳 null） */
function standardSummary(r) {
  const it = (r && r.details && r.details.items) || {};
  const g = (o, k) => (o && typeof o[k] === 'number') ? o[k] : null;
  return {
    shoulderTilt: g(it.shoulderLevel, 'angle'), shoulderSigned: g(it.shoulderLevel, 'signedLeftHigher'),
    higherSide: it.shoulderLevel ? it.shoulderLevel.higherSide : null,
    cva: g(it.forwardHead, 'cva'), cvaSide: it.forwardHead ? it.forwardHead.side : null,
    abdLeft: g(it.abduction, 'left'), abdRight: g(it.abduction, 'right'),
    flexLeft: g(it.flexionLeft, 'angle'), flexRight: g(it.flexionRight, 'angle'),
    viewMismatch: SM_ITEMS.filter(i => it[i.id] && it[i.id].viewOk === false).map(i => i.id)
  };
}
function standardSummaryText(r) {
  const it = (r.details && r.details.items) || {};
  return SM_ITEMS.filter(i => it[i.id]).map(i => `${tApp('sm_short_' + i.id)} ${smValueText(i.id, it[i.id])}`).join(' · ');
}

/** 單筆詳細內容（modal） */
function standardDetailHtml(r) {
  const it = (r.details && r.details.items) || {};
  const rows = SM_ITEMS.map(i => {
    const x = it[i.id];
    return `<tr>
      <td><strong>${tApp('sm_item_' + i.id)}</strong></td>
      <td>${tApp('sm_view_' + i.view)}</td>
      <td>${x ? smValueText(i.id, x) : '--'}</td>
      <td>${x && x.sd !== undefined && x.sd !== null ? '±' + fmtNum(x.sd) + '°' : '--'}</td>
      <td>${x ? `${x.validFrames}/${x.frameCount}（${fmtNum(x.validPct, 0)}%）` : '--'}</td>
      <td>${x ? (x.viewOk === false ? `<span class="badge badge-warning">${tApp('sm_view_mismatch')}</span>` : `<span class="badge badge-muted">${fmtNum(x.viewRatio, 2)}</span>`) : '--'}</td>
    </tr>`;
  }).join('');
  return `
    <span class="badge badge-info">${tApp('type_standard')}</span>
    <h2 class="modal-title" style="margin-top:0.5rem;">${tApp('sm_detail_title')}</h2>
    <p class="muted">${fmtDateTime(docTimeMs(r))} · ${escapeHtml(instrumentLabel(r.instrument))}</p>
    <div class="sample-flag" style="margin-top:1rem;">${tApp('sm_judgment_pending')}</div>
    <div class="card" style="padding:0; overflow:hidden;"><div class="table-wrap"><table>
      <thead><tr><th>${tApp('sm_th_item')}</th><th>${tApp('sm_th_view')}</th><th>${tApp('sm_th_value')}</th><th>${tApp('sm_th_sd')}</th><th>${tApp('sm_th_valid')}</th><th>${tApp('sm_th_viewratio')}</th></tr></thead>
      <tbody>${rows}</tbody></table></div></div>
    <p class="muted small" style="margin-top:0.8rem; line-height:1.6;">${tApp('sm_def_all')}</p>`;
}

// ── 儲存 ─────────────────────────────────────────────────────────
async function saveStandardRecord() {
  if (!Object.keys(SM.results).length || SM.saving) return;
  SM.saving = true;
  renderStandardPage();
  const now = Date.now();
  const record = {
    id: now,
    timestamp: new Date(now).toLocaleString('zh-TW', { hour12: false }),
    createdAtMs: now, dateKey: dateKeyOf(now), version: 2,
    username: App.profile.username, instrument: App.profile.instrument,
    type: 'standard', projectName: '標準動作辨識',
    score: null, level: null,            // 判讀標準待定，不評分
    judgment: SM_JUDGMENT,
    protocol: { ...SM_PROTOCOL, model: 'MediaPipe Pose 0.5 (modelComplexity 1)', coords: 'pixel' },
    details: { items: { ...SM.results } }
  };
  try {
    await DataAPI.addSub(App.user.uid, 'records', record);
    await refreshPerformerSub('records', 'records');
    showToast(tApp('sm_toast_saved'), 'success');
    smStopCamera();
    SM.results = {};
    SM.current = SM_ITEMS[0].id;
    SM.guideDone = false;
    setTimeout(() => switchSection('history'), 400);
  } catch (err) {
    console.error('標準動作辨識儲存失敗：', err);
    showToast(tApp('toast_save_fail'), 'danger');
  } finally {
    SM.saving = false;
    renderStandardPage();
  }
}

function resetStandard() {
  if (SM.phase !== 'idle') return;
  if (Object.keys(SM.results).length && !confirm(tApp('sm_confirm_reset'))) return;
  SM.results = {};
  SM.current = SM_ITEMS[0].id;
  renderStandardPage();
}
