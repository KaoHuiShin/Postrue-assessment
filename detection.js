// =================================================================
// detection.js — 姿勢偵測、即時警示、練習時間、單次評估報告
// 計算函式（calcCVA / calcShoulderTilt / calcElbowAngle）與資料存取分開，
// 未來替換姿勢模型時只需改「偵測來源」區塊。
// 依定案：只用 MediaPipe；手腕彎曲、脊椎傾斜尚未接偵測 → 不產生模擬數據、欄位留空。
// =================================================================

// ── 警戒值（系統預設，不提供個人化調整） ─────────────────────────
const ALERT_THRESHOLDS = {
  CVA_MIN: 52,            // CVA 原始角度 < 52° 視為頭部前傾（Mylonas 2022；Kim 2018）
  SHOULDER_DELTA_MAX: 3,  // 雙肩傾斜相對基準 |Δ| > 3°（暫定，待文獻／Delphi）
  ELBOW_MIN: 70,          // 手肘角度 < 70° 或 > 160°（暫定，待文獻／Delphi）
  ELBOW_MAX: 160
};
const CVA_THRESHOLD = ALERT_THRESHOLDS.CVA_MIN; // 舊程式相容

// 即時警示：連續不良姿勢 SUSTAIN_MS 後觸發；兩次警示至少間隔 COOLDOWN_MS
const ALERT_RULES = { SUSTAIN_MS: 2000, COOLDOWN_MS: 8000, CLEAR_MS: 1000, VIBRATE_PATTERN: [200, 100, 200] };
// 練習時間提醒（示意門檻，待定）
const PRACTICE_RULES = { REST_AFTER_MIN: 45, BAD_POSTURE_LIMIT_SEC: 300 };
// 是否三個階段都錄完才產生報告
const REQUIRE_ALL_STAGES = true;
const STAGES = ['relax', 'prepare', 'playing'];
const MAX_STORED_FRAMES = 600; // 每階段每參數最多存 600 點（降採樣，避免 Firestore 單筆 1MB 上限）

const CVA_IDX = { LEFT_EAR: 7, RIGHT_EAR: 8, LEFT_SHLD: 11, RIGHT_SHLD: 12 };

// ── 計算函式 ─────────────────────────────────────────────────────
function cvaMidpoint(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

/** CVA：arctan2(|head_y − shld_y|, |head_x − shld_x|) × 180/π */
function calcCVA(landmarks) {
  const head = cvaMidpoint(landmarks[CVA_IDX.LEFT_EAR], landmarks[CVA_IDX.RIGHT_EAR]);
  const shld = cvaMidpoint(landmarks[CVA_IDX.LEFT_SHLD], landmarks[CVA_IDX.RIGHT_SHLD]);
  return Math.atan2(Math.abs(head.y - shld.y), Math.abs(head.x - shld.x)) * (180 / Math.PI);
}

/** 雙肩傾斜：arctan2(|LS.y − RS.y|, |LS.x − RS.x|) × 180/π（Rodríguez-Gude；Piatek 2018） */
function calcShoulderTilt(landmarks) {
  const ls = landmarks[11], rs = landmarks[12];
  return Math.atan2(Math.abs(ls.y - rs.y), Math.abs(ls.x - rs.x)) * (180 / Math.PI);
}

/** 手肘三點夾角：arccos(A·B / |A||B|) × 180/π（Yagisan 2009） */
function calcElbowAngle(shoulder, elbow, wrist) {
  const ax = shoulder.x - elbow.x, ay = shoulder.y - elbow.y;
  const bx = wrist.x - elbow.x, by = wrist.y - elbow.y;
  const magA = Math.hypot(ax, ay), magB = Math.hypot(bx, by);
  if (magA === 0 || magB === 0) return NaN;
  return Math.acos(Math.min(1, Math.max(-1, (ax * bx + ay * by) / (magA * magB)))) * (180 / Math.PI);
}

function calcAllParams(lm) {
  return {
    cva: calcCVA(lm),
    shoulderTilt: calcShoulderTilt(lm),
    leftElbow: calcElbowAngle(lm[11], lm[13], lm[15]),
    rightElbow: calcElbowAngle(lm[12], lm[14], lm[16])
  };
}

/** 單幀是否超過警戒值 */
function evaluateFrame(rawCva, shDelta, le, re) {
  const T = ALERT_THRESHOLDS;
  const elbowOut = v => !isNaN(v) && (v < T.ELBOW_MIN || v > T.ELBOW_MAX);
  const cva = rawCva < T.CVA_MIN;
  const shoulder = Math.abs(shDelta) > T.SHOULDER_DELTA_MAX;
  const elbow = elbowOut(le) || elbowOut(re);
  return { cva, shoulder, elbow, any: cva || shoulder || elbow };
}

/** 健康度評分：100 −（0.4×CVA 低於警戒比例 + 0.3×肩傾斜超過比例 + 0.3×手肘超過比例） */
function calcHealthScore(summary) {
  const p = v => (typeof v === 'number' ? v : 0);
  const score = 100 - (0.4 * p(summary.cvaBelowPct) + 0.3 * p(summary.shoulderOverPct) + 0.3 * p(summary.elbowOverPct));
  return Math.max(0, Math.min(100, Math.round(score)));
}

// ── 偵測狀態 ─────────────────────────────────────────────────────
let cvaState = newCvaState();
function newCvaState() {
  return {
    pose: null, camera: null, stream: null, modelReady: false,
    activeStage: null, isRecording: false, isCalibrating: false,
    referenceAngle: null, refShoulderTilt: null,
    calibFrames: [], calibShoulderFrames: [],
    frameBuffers: { relax: [], prepare: [], playing: [] },
    stageDuration: { relax: 0, prepare: 0, playing: 0 },
    stageDone: { relax: false, prepare: false, playing: false },
    lastFrameT: null
  };
}
let practiceSession = newPracticeSession();
function newPracticeSession() {
  return { durationSec: 0, badSec: 0, alertCount: 0, restReminded: false, badReminded: false, lastUiT: 0 };
}
let alertState = { badSince: null, goodSince: null, lastAlertAt: -Infinity, showing: false };
let playingResult = null;          // 計算完的報告
let sessionMaps = { pre: [], post: [], done: false };
let sbmPre = null, sbmPost = null; // 人體圖元件

// ── 頁面渲染 ─────────────────────────────────────────────────────
function renderPlayingPage() {
  if (!document.querySelector('.capture-steps .step-card')) renderStageCards();
  document.getElementById('alert-vibrate-toggle').checked = !App.alertSettings || App.alertSettings.vibrate !== false;
  document.getElementById('practice-rule-text').textContent = tApp('practice_rule', {
    min: PRACTICE_RULES.REST_AFTER_MIN, bad: Math.round(PRACTICE_RULES.BAD_POSTURE_LIMIT_SEC / 60)
  }) + (navigator.vibrate ? '' : ' ' + tApp('vibrate_unsupported'));
  document.getElementById('cva-threshold-label').textContent = tApp('threshold_label', { v: ALERT_THRESHOLDS.CVA_MIN });
  document.getElementById('cva-desc').innerHTML = tApp('cva_desc', { v: ALERT_THRESHOLDS.CVA_MIN });
  refreshStageCards();
  updatePracticeUI(true);
  if (playingResult && document.getElementById('playing-results-panel').style.display !== 'none') renderPlayingResults();
}

function renderStageCards() {
  const icons = { relax: 'wind', prepare: 'user-check', playing: 'music-4' };
  document.querySelector('.capture-steps').innerHTML = STAGES.map((s, i) => `
    <div class="step-card ${i === 0 ? 'active' : ''}" id="step-${s}" onclick="selectStep('${s}')">
      <div class="step-icon"><i data-lucide="${icons[s]}"></i></div>
      <strong style="font-size:0.88rem;" data-i18n="stage_${s}">${tApp('stage_' + s)}</strong>
      <span class="muted small" id="label-${s}"></span>
      <div class="cva-step-controls" onclick="event.stopPropagation()">
        <button class="btn btn-interactive" id="cva-btn-${s}" onclick="openCamera('${s}', event)"></button>
        <button class="btn btn-warning-outline" id="cva-calib-btn-${s}" onclick="runCalibration('${s}', event)" style="display:none;"></button>
        <div class="calib-status" id="cva-calib-status-${s}" style="display:none;"></div>
        <button class="btn btn-primary" id="cva-rec-btn-${s}" onclick="toggleRecording('${s}', event)" style="display:none;"></button>
        <button class="btn btn-outline btn-sm" id="cva-close-btn-${s}" onclick="closeCamera(); refreshStageCards();" style="display:none;"></button>
        <div class="cva-live-badge" id="cva-live-${s}" style="display:none;"><span class="cva-live-dot"></span><span id="cva-angle-${s}">--</span><span id="cva-frames-${s}" style="font-size:0.7rem; opacity:0.7;"></span></div>
      </div>
    </div>`).join('');
  lucide.createIcons();
}

/** 依目前狀態更新三個階段卡片的按鈕與文字 */
function refreshStageCards() {
  if (!document.getElementById('cva-btn-relax')) return;
  STAGES.forEach(s => {
    const isActive = cvaState.activeStage === s;
    const openBtn = document.getElementById(`cva-btn-${s}`);
    const calibBtn = document.getElementById(`cva-calib-btn-${s}`);
    const calibStatus = document.getElementById(`cva-calib-status-${s}`);
    const recBtn = document.getElementById(`cva-rec-btn-${s}`);
    const closeBtn = document.getElementById(`cva-close-btn-${s}`);
    const live = document.getElementById(`cva-live-${s}`);
    const label = document.getElementById(`label-${s}`);
    const strong = document.querySelector(`#step-${s} strong`);
    if (strong) strong.textContent = tApp('stage_' + s);

    openBtn.style.display = isActive ? 'none' : 'inline-flex';
    openBtn.innerHTML = `<i data-lucide="video"></i>${tApp('btn_open_camera')}`;
    closeBtn.style.display = isActive && !cvaState.isRecording ? 'inline-flex' : 'none';
    closeBtn.innerHTML = `<i data-lucide="video-off"></i>${tApp('btn_close_camera')}`;

    calibBtn.style.display = isActive ? 'inline-flex' : 'none';
    calibBtn.disabled = cvaState.isCalibrating || cvaState.isRecording;
    calibBtn.innerHTML = cvaState.isCalibrating && isActive
      ? `<i data-lucide="loader"></i>${tApp('calib_sampling')}`
      : `<i data-lucide="crosshair"></i>${tApp(cvaState.referenceAngle !== null ? 'btn_recalibrate' : 'btn_calibrate')}`;

    calibStatus.style.display = isActive && (cvaState.referenceAngle !== null || cvaState.isCalibrating) ? 'block' : 'none';
    calibStatus.textContent = cvaState.isCalibrating ? tApp('calib_hold') :
      (cvaState.referenceAngle !== null ? tApp('baseline_text', { v: cvaState.referenceAngle.toFixed(1) }) : '');

    const canRecord = isActive && cvaState.referenceAngle !== null && !cvaState.isCalibrating;
    recBtn.style.display = canRecord ? 'inline-flex' : 'none';
    if (cvaState.isRecording && isActive) {
      recBtn.innerHTML = `<i data-lucide="square"></i>${tApp('btn_stop_rec')}`;
      recBtn.classList.add('btn-danger'); recBtn.classList.remove('btn-primary');
    } else {
      recBtn.innerHTML = `<i data-lucide="${cvaState.stageDone[s] ? 'refresh-cw' : 'circle'}"></i>${tApp(cvaState.stageDone[s] ? 'btn_re_rec' : 'btn_start_rec')}`;
      recBtn.classList.remove('btn-danger'); recBtn.classList.add('btn-primary');
    }
    live.style.display = cvaState.isRecording && isActive ? 'flex' : 'none';

    if (cvaState.isRecording && isActive) label.textContent = tApp('recording_now');
    else if (cvaState.stageDone[s]) label.textContent = tApp('stage_done', { n: cvaState.frameBuffers[s].length, t: fmtClock(cvaState.stageDuration[s]) });
    else label.textContent = tApp('not_recorded');

    const card = document.getElementById(`step-${s}`);
    card.classList.toggle('captured', cvaState.stageDone[s]);
  });
  lucide.createIcons();
}

function selectStep(step) {
  document.querySelectorAll('.capture-steps .step-card').forEach(c => c.classList.remove('active'));
  const el = document.getElementById(`step-${step}`);
  if (el) el.classList.add('active');
}

function setVideoStatus(text, color) {
  document.getElementById('video-status-text').textContent = text;
  document.getElementById('video-overlay-dot-el').style.background = color || '';
}
function setHud(html) { document.getElementById('playing-hud-text').innerHTML = html; }

// ── 偵測來源：MediaPipe Pose ─────────────────────────────────────
async function initCvaPose() {
  if (cvaState.modelReady) return true;
  if (typeof Pose === 'undefined') { showToast(tApp('toast_model_loading'), 'warning'); return false; }
  const pose = new Pose({ locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404/${f}` });
  pose.setOptions({ modelComplexity: 1, smoothLandmarks: true, enableSegmentation: false, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
  pose.onResults(onPoseResults);
  await pose.initialize();
  cvaState.pose = pose;
  cvaState.modelReady = true;
  return true;
}

function onPoseResults(results) {
  if (!cvaState.activeStage || !results.poseLandmarks) return;
  const params = calcAllParams(results.poseLandmarks);
  if (isNaN(params.cva)) return;

  const shDelta = cvaState.refShoulderTilt !== null ? params.shoulderTilt - cvaState.refShoulderTilt : 0;
  const flags = evaluateFrame(params.cva, shDelta, params.leftElbow, params.rightElbow);

  const overlay = document.getElementById('cva-overlay-canvas');
  if (overlay) { syncOverlaySize(overlay); drawCvaOverlay(overlay, results.poseLandmarks, params, shDelta, flags); }

  if (cvaState.isCalibrating) {
    cvaState.calibFrames.push(params.cva);
    cvaState.calibShoulderFrames.push(params.shoulderTilt);
    return;
  }

  const live = document.getElementById('cva-live-overlay-angle');
  if (live) {
    live.textContent = `CVA ${params.cva.toFixed(1)}°  ${tApp('shoulder_short')} Δ${shDelta >= 0 ? '+' : ''}${shDelta.toFixed(1)}°`;
    live.style.color = flags.cva ? '#FEDFE1' : '#E5ECE4';
  }

  if (!cvaState.isRecording || cvaState.referenceAngle === null) { cvaState.lastFrameT = null; return; }

  // ── 錄製中 ───────────────────────────────────────────────────
  const now = performance.now();
  const dt = cvaState.lastFrameT === null ? 0 : Math.min(0.25, (now - cvaState.lastFrameT) / 1000);
  cvaState.lastFrameT = now;
  const stage = cvaState.activeStage;
  cvaState.stageDuration[stage] += dt;
  practiceSession.durationSec += dt;
  if (flags.any) practiceSession.badSec += dt;

  cvaState.frameBuffers[stage].push({
    cva: params.cva - cvaState.referenceAngle, raw: params.cva, sh: shDelta,
    le: params.leftElbow, re: params.rightElbow,
    bc: flags.cva, bs: flags.shoulder, be: flags.elbow, b: flags.any
  });
  const n = cvaState.frameBuffers[stage].length;
  const angleEl = document.getElementById(`cva-angle-${stage}`);
  const framesEl = document.getElementById(`cva-frames-${stage}`);
  if (angleEl) angleEl.textContent = `CVA ${params.cva.toFixed(1)}°`;
  if (framesEl) framesEl.textContent = `${n} ${tApp('frames_unit')}`;

  setHud(`REC [${stage.toUpperCase()}] · ${fmtClock(cvaState.stageDuration[stage])} · ${n} ${tApp('frames_unit')}<br>` +
    `CVA ${params.cva.toFixed(1)}° | ${tApp('shoulder_short')} Δ${shDelta.toFixed(1)}° | ` +
    `L ${isNaN(params.leftElbow) ? '--' : params.leftElbow.toFixed(0)}° R ${isNaN(params.rightElbow) ? '--' : params.rightElbow.toFixed(0)}°`);

  handlePostureAlert(flags, now);
  checkPracticeReminders();
  if (now - practiceSession.lastUiT > 250) { practiceSession.lastUiT = now; updatePracticeUI(); }
}

// ── 即時警示（畫面＋震動，不使用聲音） ───────────────────────────
function handlePostureAlert(flags, now) {
  if (flags.any) {
    alertState.goodSince = null;
    if (alertState.badSince === null) alertState.badSince = now;
    if (now - alertState.badSince >= ALERT_RULES.SUSTAIN_MS && now - alertState.lastAlertAt >= ALERT_RULES.COOLDOWN_MS) {
      triggerPostureAlert(flags);
      alertState.lastAlertAt = now;
    }
  } else if (alertState.badSince !== null || alertState.showing) {
    if (alertState.goodSince === null) alertState.goodSince = now;
    if (now - alertState.goodSince >= ALERT_RULES.CLEAR_MS) {
      alertState.badSince = null;
      hidePostureAlert();
    }
  }
}

function triggerPostureAlert(flags) {
  const issues = [];
  if (flags.cva) issues.push(tApp('issue_cva'));
  if (flags.shoulder) issues.push(tApp('issue_shoulder'));
  if (flags.elbow) issues.push(tApp('issue_elbow'));
  const el = document.getElementById('posture-alert');
  document.getElementById('posture-alert-text').textContent = tApp('alert_text', { issues: issues.join(currentLang === 'en' ? ', ' : '、') });
  el.classList.add('show');
  alertState.showing = true;
  practiceSession.alertCount++;
  if (App.alertSettings && App.alertSettings.vibrate !== false && navigator.vibrate) {
    try { navigator.vibrate(ALERT_RULES.VIBRATE_PATTERN); } catch (e) {}
  }
  updatePracticeUI(true);
}
function hidePostureAlert() {
  document.getElementById('posture-alert').classList.remove('show');
  alertState.showing = false;
}

function checkPracticeReminders() {
  if (!practiceSession.restReminded && practiceSession.durationSec >= PRACTICE_RULES.REST_AFTER_MIN * 60) {
    practiceSession.restReminded = true;
    showPageAlert(tApp('remind_rest', { min: PRACTICE_RULES.REST_AFTER_MIN }), 'rest', 15000);
    if (App.alertSettings.vibrate !== false && navigator.vibrate) navigator.vibrate([300, 150, 300]);
  }
  if (!practiceSession.badReminded && practiceSession.badSec >= PRACTICE_RULES.BAD_POSTURE_LIMIT_SEC) {
    practiceSession.badReminded = true;
    showPageAlert(tApp('remind_bad_posture', { min: Math.round(PRACTICE_RULES.BAD_POSTURE_LIMIT_SEC / 60) }), 'danger', 15000);
    if (App.alertSettings.vibrate !== false && navigator.vibrate) navigator.vibrate([300, 150, 300]);
  }
}

function updatePracticeUI() {
  const d = document.getElementById('ps-duration');
  if (!d) return;
  d.textContent = fmtClock(practiceSession.durationSec);
  document.getElementById('ps-bad').textContent = fmtClock(practiceSession.badSec);
  document.getElementById('ps-alerts').textContent = practiceSession.alertCount;
  document.getElementById('ps-duration-box').classList.toggle('warn', practiceSession.durationSec >= PRACTICE_RULES.REST_AFTER_MIN * 60);
  document.getElementById('ps-bad-box').classList.toggle('warn', practiceSession.badSec >= PRACTICE_RULES.BAD_POSTURE_LIMIT_SEC);
}

// ── 骨架疊圖 ─────────────────────────────────────────────────────
function syncOverlaySize(canvas) {
  const rect = canvas.getBoundingClientRect();
  if (canvas.width !== Math.round(rect.width) || canvas.height !== Math.round(rect.height)) {
    canvas.width = Math.round(rect.width);
    canvas.height = Math.round(rect.height);
  }
}

function drawCvaOverlay(canvas, lm, params, shDelta, flags) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const OK = '#E5ECE4', BAD = '#FEDFE1', BADSTROKE = '#8E354A', NEUTRAL = '#91989F';

  const head = cvaMidpoint(lm[CVA_IDX.LEFT_EAR], lm[CVA_IDX.RIGHT_EAR]);
  const shld = cvaMidpoint(lm[CVA_IDX.LEFT_SHLD], lm[CVA_IDX.RIGHT_SHLD]);
  const hx = head.x * w, hy = head.y * h, sx = shld.x * w, sy = shld.y * h;

  ctx.strokeStyle = flags.cva ? BADSTROKE : 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(sx, sy); ctx.stroke();
  ctx.strokeStyle = 'rgba(145,152,159,0.7)'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(sx - 70, sy); ctx.lineTo(sx + 70, sy); ctx.stroke();
  ctx.setLineDash([]);
  [[hx, hy, flags.cva ? BADSTROKE : '#0D5661'], [sx, sy, '#0D5661']].forEach(([x, y, c]) => {
    ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
  });

  // 肩線
  const ls = lm[11], rs = lm[12];
  ctx.strokeStyle = flags.shoulder ? BADSTROKE : '#77428D'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(ls.x * w, ls.y * h); ctx.lineTo(rs.x * w, rs.y * h); ctx.stroke();

  // 手肘
  [[lm[11], lm[13], lm[15], params.leftElbow], [lm[12], lm[14], lm[16], params.rightElbow]].forEach(([sh, el, wr, ang]) => {
    if (isNaN(ang)) return;
    const out = ang < ALERT_THRESHOLDS.ELBOW_MIN || ang > ALERT_THRESHOLDS.ELBOW_MAX;
    ctx.strokeStyle = out ? BADSTROKE : '#7BA23F'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(sh.x * w, sh.y * h); ctx.lineTo(el.x * w, el.y * h); ctx.lineTo(wr.x * w, wr.y * h); ctx.stroke();
    ctx.fillStyle = out ? BADSTROKE : '#7BA23F';
    ctx.beginPath(); ctx.arc(el.x * w, el.y * h, 5, 0, Math.PI * 2); ctx.fill();
  });

  // 文字標籤（畫布有鏡像，文字需反向繪製才不會左右顛倒）
  const label = (text, x, y, bad) => {
    ctx.save();
    ctx.translate(x, y); ctx.scale(-1, 1);
    ctx.font = 'bold 11px monospace';
    const tw = ctx.measureText(text).width + 10;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(-tw / 2, -11, tw, 18);
    ctx.fillStyle = bad ? BAD : OK;
    ctx.textAlign = 'center';
    ctx.fillText(text, 0, 2);
    ctx.restore();
  };
  label(`CVA ${params.cva.toFixed(1)}°`, (hx + sx) / 2, (hy + sy) / 2, flags.cva);
  label(`Δ${shDelta.toFixed(1)}°`, (ls.x + rs.x) / 2 * w, ((ls.y + rs.y) / 2) * h - 16, flags.shoulder);
  if (!isNaN(params.leftElbow)) label(`${params.leftElbow.toFixed(0)}°`, lm[13].x * w, lm[13].y * h + 16, params.leftElbow < ALERT_THRESHOLDS.ELBOW_MIN || params.leftElbow > ALERT_THRESHOLDS.ELBOW_MAX);
  if (!isNaN(params.rightElbow)) label(`${params.rightElbow.toFixed(0)}°`, lm[14].x * w, lm[14].y * h + 16, params.rightElbow < ALERT_THRESHOLDS.ELBOW_MIN || params.rightElbow > ALERT_THRESHOLDS.ELBOW_MAX);
  void NEUTRAL;
}

// ── ① 啟動攝影機 ─────────────────────────────────────────────────
async function openCamera(stage, event) {
  if (event) event.stopPropagation();
  if (!App.profile || !App.profile.instrument) {
    showToast(tApp('toast_need_profile'), 'warning');
    switchSection('profile');
    return;
  }
  if (cvaState.isRecording) { showToast(tApp('toast_stop_first'), 'warning'); return; }

  const openBtn = document.getElementById(`cva-btn-${stage}`);
  openBtn.disabled = true;
  openBtn.textContent = tApp('loading');

  const ready = await initCvaPose().catch(err => { console.error(err); return false; });
  if (!ready) { openBtn.disabled = false; refreshStageCards(); return; }

  if (!cvaState.stream) {
    try {
      cvaState.stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    } catch (err) {
      showToast(tApp('toast_camera_denied'), 'danger');
      openBtn.disabled = false;
      refreshStageCards();
      return;
    }
    const video = document.getElementById('cva-video');
    video.srcObject = cvaState.stream;
    video.style.display = 'block';
    document.getElementById('cva-overlay-canvas').style.display = 'block';
    document.getElementById('video-placeholder').style.display = 'none';
    document.getElementById('cva-live-overlay-angle').style.display = 'block';
    document.getElementById('cva-ref-badge').style.display = 'block';
    cvaState.camera = new Camera(video, {
      onFrame: async () => { if (cvaState.pose) await cvaState.pose.send({ image: video }); },
      width: 640, height: 480
    });
    cvaState.camera.start();
  }
  openBtn.disabled = false;
  cvaState.activeStage = stage;
  cvaState.isCalibrating = false;
  cvaState.isRecording = false;
  selectStep(stage);
  setVideoStatus(`CAMERA [${stage.toUpperCase()}]`, '#36563C');
  updateRefBadge();
  setHud(cvaState.referenceAngle === null ? tApp('hud_need_calib') : tApp('hud_ready'));
  refreshStageCards();
}

function updateRefBadge() {
  const b = document.getElementById('cva-ref-badge');
  b.textContent = cvaState.referenceAngle === null ? tApp('baseline_none') : tApp('baseline_text', { v: cvaState.referenceAngle.toFixed(1) });
}

// ── ② 校準歸零（收集 1.5 秒取平均） ──────────────────────────────
async function runCalibration(stage, event) {
  if (event) event.stopPropagation();
  if (cvaState.activeStage !== stage || !cvaState.camera) return;
  if (cvaState.isRecording) { showToast(tApp('toast_stop_first'), 'warning'); return; }
  cvaState.calibFrames = [];
  cvaState.calibShoulderFrames = [];
  cvaState.isCalibrating = true;
  setVideoStatus('CALIBRATING…', '#6C6024');
  setHud(tApp('calib_hold'));
  refreshStageCards();
  await new Promise(r => setTimeout(r, 1500));
  cvaState.isCalibrating = false;

  if (!cvaState.calibFrames.length) {
    showToast(tApp('toast_calib_fail'), 'danger');
    setVideoStatus(`CAMERA [${stage.toUpperCase()}]`, '#36563C');
    refreshStageCards();
    return;
  }
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
  cvaState.referenceAngle = avg(cvaState.calibFrames);
  cvaState.refShoulderTilt = avg(cvaState.calibShoulderFrames);
  setVideoStatus(`CAMERA [${stage.toUpperCase()}]`, '#36563C');
  updateRefBadge();
  setHud(tApp('hud_ready'));
  refreshStageCards();
  showToast(tApp('toast_calib_done', { v: cvaState.referenceAngle.toFixed(1) }), 'success');
}

// ── ③ 開始／停止錄製 ─────────────────────────────────────────────
function toggleRecording(stage, event) {
  if (event) event.stopPropagation();
  if (cvaState.activeStage !== stage) return;

  if (!cvaState.isRecording) {
    if (cvaState.referenceAngle === null) { showToast(tApp('toast_need_calib'), 'warning'); return; }
    // 重新錄製：扣回該階段先前累計的練習時間
    if (cvaState.stageDone[stage]) {
      practiceSession.durationSec = Math.max(0, practiceSession.durationSec - cvaState.stageDuration[stage]);
      const prevBad = cvaState.frameBuffers[stage].filter(f => f.b).length / Math.max(1, cvaState.frameBuffers[stage].length) * cvaState.stageDuration[stage];
      practiceSession.badSec = Math.max(0, practiceSession.badSec - prevBad);
    }
    cvaState.frameBuffers[stage] = [];
    cvaState.stageDuration[stage] = 0;
    cvaState.stageDone[stage] = false;
    cvaState.isRecording = true;
    cvaState.lastFrameT = null;
    alertState = { badSince: null, goodSince: null, lastAlertAt: -Infinity, showing: false };
    setVideoStatus(`● REC [${stage.toUpperCase()}]`, '#8E354A');
    refreshStageCards();
    showToast(tApp('toast_rec_start', { stage: tApp('stage_' + stage + '_name') }), 'info');
    return;
  }

  // 停止
  cvaState.isRecording = false;
  hidePostureAlert();
  const frames = cvaState.frameBuffers[stage];
  setVideoStatus(`CAMERA [${stage.toUpperCase()}]`, '#36563C');
  if (frames.length < 5) {
    practiceSession.durationSec = Math.max(0, practiceSession.durationSec - cvaState.stageDuration[stage]);
    cvaState.frameBuffers[stage] = [];
    cvaState.stageDuration[stage] = 0;
    showToast(tApp('toast_too_few_frames'), 'warning');
    refreshStageCards();
    updatePracticeUI();
    return;
  }
  cvaState.stageDone[stage] = true;
  const st = summarizeStage(stage);
  setHud(`RECORDED ✓ [${stage.toUpperCase()}] · ${frames.length} ${tApp('frames_unit')}<br>CVA ${fmtNum(st.summary.cvaAvg)}° · ${tApp('below_threshold_ratio')} ${fmtNum(st.summary.cvaBelowPct, 0)}%`);
  refreshStageCards();
  updatePracticeUI();
  showToast(tApp('toast_rec_done', { stage: tApp('stage_' + stage + '_name'), v: fmtNum(st.summary.cvaAvg) }), 'success');

  // 自動前往下一個未完成階段的卡片
  const next = STAGES.find(s => !cvaState.stageDone[s]);
  if (next) selectStep(next);
  checkAndRenderPlayingDashboard();
}

// ── 關閉攝影機 ───────────────────────────────────────────────────
function closeCamera() {
  if (cvaState.isRecording) toggleRecording(cvaState.activeStage);
  cvaState.isCalibrating = false;
  cvaState.activeStage = null;
  if (cvaState.camera) { try { cvaState.camera.stop(); } catch (e) {} cvaState.camera = null; }
  if (cvaState.stream) { cvaState.stream.getTracks().forEach(t => t.stop()); cvaState.stream = null; }
  const video = document.getElementById('cva-video');
  if (video) { video.style.display = 'none'; video.srcObject = null; }
  const ov = document.getElementById('cva-overlay-canvas');
  if (ov) { ov.style.display = 'none'; ov.getContext('2d').clearRect(0, 0, ov.width, ov.height); }
  const ph = document.getElementById('video-placeholder');
  if (ph) ph.style.display = 'flex';
  ['cva-live-overlay-angle', 'cva-ref-badge'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
  hidePostureAlert();
  setVideoStatus('CAMERA OFF', '');
  setHud('STATUS: WAITING');
}

function stopAllDetection() {
  if (!document.getElementById('cva-video')) return;
  closeCamera();
  refreshStageCards();
}

function onLeavePlaying() {
  if (cvaState.activeStage) { closeCamera(); refreshStageCards(); }
}

// ── 統計摘要 ─────────────────────────────────────────────────────
function downsample(arr, max = MAX_STORED_FRAMES) {
  if (arr.length <= max) return arr.map(v => +(+v).toFixed(2));
  const out = [];
  const step = arr.length / max;
  for (let i = 0; i < max; i++) out.push(+(+arr[Math.floor(i * step)]).toFixed(2));
  return out;
}
const _avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const _min = a => a.length ? Math.min(...a) : null;
const _max = a => a.length ? Math.max(...a) : null;
const _r = (v, d = 2) => v === null || v === undefined || Number.isNaN(v) ? null : +v.toFixed(d);
const _pct = (n, d) => d ? +(n / d * 100).toFixed(1) : null;

function summarizeStage(stage) {
  const frames = cvaState.frameBuffers[stage];
  const n = frames.length;
  const deltas = frames.map(f => f.cva), raws = frames.map(f => f.raw), sh = frames.map(f => f.sh);
  const le = frames.map(f => f.le).filter(v => !isNaN(v)), re = frames.map(f => f.re).filter(v => !isNaN(v));
  const cvaBelow = _pct(frames.filter(f => f.bc).length, n);
  const shOver = _pct(frames.filter(f => f.bs).length, n);
  const elOver = _pct(frames.filter(f => f.be).length, n);
  const anyOver = _pct(frames.filter(f => f.b).length, n);
  return {
    durationSec: _r(cvaState.stageDuration[stage], 1),
    frameCount: n,
    cva: {
      frames: downsample(deltas), rawFrames: downsample(raws),
      referenceAngle: _r(cvaState.referenceAngle),
      avg: _r(_avg(deltas)), min: _r(_min(deltas)), max: _r(_max(deltas)),
      rawAvg: _r(_avg(raws)), rawMin: _r(_min(raws)), rawMax: _r(_max(raws)),
      threshold: ALERT_THRESHOLDS.CVA_MIN, belowPct: cvaBelow, abovePct: cvaBelow, frameCount: n
    },
    shoulderData: {
      frames: downsample(sh), referenceAngle: _r(cvaState.refShoulderTilt),
      avg: _r(_avg(sh)), min: _r(_min(sh)), max: _r(_max(sh)),
      threshold: ALERT_THRESHOLDS.SHOULDER_DELTA_MAX, abovePct: shOver, frameCount: n
    },
    elbowData: {
      leftFrames: downsample(le), rightFrames: downsample(re),
      leftAvg: _r(_avg(le), 1), rightAvg: _r(_avg(re), 1),
      leftMin: _r(_min(le), 1), rightMin: _r(_min(re), 1),
      leftMax: _r(_max(le), 1), rightMax: _r(_max(re), 1),
      range: [ALERT_THRESHOLDS.ELBOW_MIN, ALERT_THRESHOLDS.ELBOW_MAX], overPct: elOver, frameCount: n
    },
    summary: {
      cvaAvg: _r(_avg(raws)), cvaBelowPct: cvaBelow,
      shoulderAvg: _r(_avg(sh)), shoulderOverPct: shOver,
      leftElbowAvg: _r(_avg(le), 1), rightElbowAvg: _r(_avg(re), 1), elbowOverPct: elOver,
      overAnyPct: anyOver
    }
  };
}

function checkAndRenderPlayingDashboard() {
  const ready = REQUIRE_ALL_STAGES ? STAGES.every(s => cvaState.stageDone[s]) : cvaState.stageDone.playing;
  if (!ready) return;
  computePlayingResult();
  if (!sessionMaps.done) openSessionBodyMap();
  else showPlayingResults();
}

function computePlayingResult() {
  const stages = {};
  STAGES.forEach(s => { if (cvaState.stageDone[s]) stages[s] = summarizeStage(s); });
  const summary = stages.playing ? stages.playing.summary : null;
  const score = summary ? calcHealthScore(summary) : null;
  playingResult = { stages, summary, score, level: levelFromScore(score ?? 0) };
}

// ── 評估結束：練習前後人體圖 ─────────────────────────────────────
function openSessionBodyMap() {
  const g = App.profile && App.profile.gender;
  sbmPre = BodyMap.create(document.getElementById('sbm-pre'), { marks: sessionMaps.pre, editable: true, gender: g });
  sbmPost = BodyMap.create(document.getElementById('sbm-post'), { marks: sessionMaps.post, editable: true, gender: g });
  document.getElementById('session-bodymap-modal').classList.add('show');
  lucide.createIcons();
}

function finishSessionBodyMap() {
  sessionMaps.pre = sbmPre ? sbmPre.getMarks() : [];
  sessionMaps.post = sbmPost ? sbmPost.getMarks() : [];
  sessionMaps.done = true;
  document.getElementById('session-bodymap-modal').classList.remove('show');
  if (playingResult) showPlayingResults();
}

// ── 報告呈現 ─────────────────────────────────────────────────────
function showPlayingResults() {
  document.getElementById('playing-waiting-panel').style.display = 'none';
  document.getElementById('playing-results-panel').style.display = 'block';
  document.getElementById('playing-charts-grid').style.display = 'grid';
  renderPlayingResults();
  document.getElementById('playing-results-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function metricRowHtml(name, valueText, pct, status) {
  return `<div class="metric-row">
    <div class="metric-info"><span class="metric-name">${name}</span><span class="metric-value">${valueText}</span></div>
    <div class="metric-bar-bg"><div class="metric-bar-fill ${status}" style="width:${Math.max(4, Math.min(100, pct))}%"></div></div>
  </div>`;
}
function statusFromPct(p) {
  if (p === null || p === undefined) return 'success';
  if (p >= SYSTEM_RULES.REMINDER_OVER_PCT) return 'danger';
  if (p >= 10) return 'warning';
  return 'success';
}

function renderPlayingResults() {
  if (!playingResult) return;
  const { summary: s, score, level } = playingResult;
  const badge = document.getElementById('playing-score-badge');
  badge.className = 'score-badge-large ' + { good: 'optimal', caution: 'warning', alert: 'danger' }[level];
  document.getElementById('playing-score-val').textContent = score ?? '--';
  document.getElementById('playing-rating-text').textContent = tApp('rating_' + level);
  document.getElementById('playing-result-desc').textContent = tApp('rating_desc_' + level);

  const T = ALERT_THRESHOLDS;
  document.getElementById('playing-metrics').innerHTML = s ? [
    metricRowHtml(tApp('metric_cva_avg'), `${fmtNum(s.cvaAvg)}°（${tApp('norm_cva', { v: T.CVA_MIN })}）`, 100 - (s.cvaBelowPct || 0), statusFromPct(s.cvaBelowPct)),
    metricRowHtml(tApp('metric_shoulder'), `Δ ${fmtNum(s.shoulderAvg)}°（${tApp('norm_shoulder', { v: T.SHOULDER_DELTA_MAX })}）`, 100 - (s.shoulderOverPct || 0), statusFromPct(s.shoulderOverPct)),
    metricRowHtml(tApp('metric_left_elbow'), `${fmtNum(s.leftElbowAvg, 0)}°（${tApp('norm_elbow', { a: T.ELBOW_MIN, b: T.ELBOW_MAX })}）`, (s.leftElbowAvg || 0) / 1.8, statusFromPct(s.elbowOverPct)),
    metricRowHtml(tApp('metric_right_elbow'), `${fmtNum(s.rightElbowAvg, 0)}°（${tApp('norm_elbow', { a: T.ELBOW_MIN, b: T.ELBOW_MAX })}）`, (s.rightElbowAvg || 0) / 1.8, statusFromPct(s.elbowOverPct))
  ].join('') : `<p class="muted">${tApp('no_playing_stage')}</p>`;

  // 超過警戒值比例（依階段）
  const rows = [];
  STAGES.forEach(st => {
    const ss = playingResult.stages[st];
    if (!ss) return;
    const p = ss.summary;
    rows.push(`<div style="font-size:0.82rem;">
      <div style="display:flex; justify-content:space-between; margin-bottom:0.25rem;"><strong>${tApp('stage_' + st + '_short')}</strong><span class="muted">${fmtClock(ss.durationSec)} · ${ss.frameCount} ${tApp('frames_unit')}</span></div>
      <div class="chip-row" style="gap:0.5rem;">
        ${overChip('CVA', p.cvaBelowPct)}${overChip(tApp('shoulder_short'), p.shoulderOverPct)}${overChip(tApp('elbow_short'), p.elbowOverPct)}
      </div></div>`);
  });
  document.getElementById('playing-over-list').innerHTML = rows.join('');

  // 不適部位
  const pre = BodyMap.summarize(sessionMaps.pre), post = BodyMap.summarize(sessionMaps.post);
  document.getElementById('playing-discomfort-summary').innerHTML =
    `<div>${tApp('sbm_pre')}：${pre ? escapeHtml(pre) : tApp('none_marked')}</div><div>${tApp('sbm_post')}：${post ? escapeHtml(post) : tApp('none_marked')}</div>`;

  // 建議（依規則）
  const tip = document.getElementById('playing-tip');
  const issues = [];
  if (s && s.cvaBelowPct >= SYSTEM_RULES.REMINDER_OVER_PCT) issues.push(tApp('tip_cva'));
  if (s && s.shoulderOverPct >= SYSTEM_RULES.REMINDER_OVER_PCT) issues.push(tApp('tip_shoulder'));
  if (s && s.elbowOverPct >= SYSTEM_RULES.REMINDER_OVER_PCT) issues.push(tApp('tip_elbow'));
  if (sessionMaps.post.length > sessionMaps.pre.length) issues.push(tApp('tip_more_discomfort'));
  tip.className = 'tip-item ' + (issues.length ? 'warning' : 'success');
  tip.innerHTML = `<strong>${tApp(issues.length ? 'tip_title_attention' : 'tip_title_good')}</strong><p>${issues.length ? issues.map(escapeHtml).join('<br>') : tApp('tip_good')}</p>`;

  renderPlayingCharts();
  lucide.createIcons();
}

function overChip(label, pct) {
  const cls = statusFromPct(pct);
  const color = { success: 'var(--color-success)', warning: 'var(--color-warning)', danger: 'var(--color-danger)' }[cls];
  return `<div class="stat-chip" style="border-left-color:${color}; min-width:90px; padding:0.35rem 0.7rem;"><div class="lbl">${label}</div><div class="val" style="font-size:0.92rem;">${pct === null ? '--' : fmtNum(pct, 0) + '%'}</div></div>`;
}

// ── 圖表 ─────────────────────────────────────────────────────────
function renderPlayingCharts() {
  if (!playingResult) return;
  const stages = STAGES.filter(s => playingResult.stages[s]);
  const labels = stages.map(s => tApp('stage_' + s + '_short'));
  const get = k => stages.map(s => playingResult.stages[s].summary[k]);

  ChartRegistry.set('playJoint', () => new Chart(document.getElementById('playingJointChart').getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: tApp('metric_cva_avg') + ' (°)', data: get('cvaAvg'), borderColor: CHART_COLORS.cva, borderWidth: 2.5, tension: 0.2, pointRadius: 4 },
        { label: tApp('metric_shoulder') + ' Δ (°)', data: get('shoulderAvg'), borderColor: CHART_COLORS.shoulder, borderWidth: 2.5, tension: 0.2, pointRadius: 4 },
        { label: tApp('metric_left_elbow') + ' (°)', data: get('leftElbowAvg'), borderColor: CHART_COLORS.leftElbow, borderWidth: 2.5, tension: 0.2, pointRadius: 4 },
        { label: tApp('metric_right_elbow') + ' (°)', data: get('rightElbowAvg'), borderColor: CHART_COLORS.rightElbow, borderWidth: 2.5, tension: 0.2, pointRadius: 4 }
      ]
    },
    options: baseChartOptions()
  }));

  ChartRegistry.set('playOver', () => new Chart(document.getElementById('playingOverChart').getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'CVA', data: get('cvaBelowPct'), backgroundColor: 'rgba(13,86,97,0.75)' },
        { label: tApp('shoulder_short'), data: get('shoulderOverPct'), backgroundColor: 'rgba(119,66,141,0.7)' },
        { label: tApp('elbow_short'), data: get('elbowOverPct'), backgroundColor: 'rgba(108,96,36,0.7)' }
      ]
    },
    options: baseChartOptions({ scales: { x: { grid: { display: false }, ticks: { color: CHART_COLORS.tick } }, y: { min: 0, max: 100, grid: { color: CHART_COLORS.grid }, ticks: { color: CHART_COLORS.tick, callback: v => v + '%' } } } })
  }));

  renderCvaFrameChart('cvaTrendChart', { stages: playingResult.stages }, 'page');

  // 下方統計
  document.getElementById('cva-stats-row').innerHTML = stages.map(s => {
    const c = playingResult.stages[s].cva;
    const color = (c.belowPct || 0) > 0 ? CHART_COLORS.threshold : CHART_COLORS.score;
    return `<div class="stat-chip" style="border-left-color:${color};">
      <div class="lbl">${tApp('stage_' + s + '_short')} — ${tApp('metric_cva_avg')}</div>
      <div class="val">${fmtNum(c.rawAvg)}°</div>
      <div class="sub">${tApp('below_threshold_ratio')} ${fmtNum(c.belowPct, 0)}% · Δ ${c.avg >= 0 ? '+' : ''}${fmtNum(c.avg)}°</div>
    </div>`;
  }).join('');
}

/**
 * CVA 逐幀折線圖（三階段串接）。新版紀錄畫原始 CVA 並以 52° 為警戒線；
 * 舊版紀錄只有 Δ 值，改畫 Δ 並以 −10° 為參考線。
 */
function renderCvaFrameChart(canvasId, details, group) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !details) return;
  const isNew = !!details.stages;
  const series = {};
  STAGES.forEach(s => {
    if (isNew) { const st = details.stages[s]; if (st && st.cva) series[s] = st.cva.rawFrames || []; }
    else if (details.cva && details.cva[s]) series[s] = details.cva[s].frames || [];
  });
  const labels = [], datasets = [];
  const th = isNew ? ALERT_THRESHOLDS.CVA_MIN : -10;
  const allPoints = [];
  STAGES.forEach(s => {
    const arr = series[s];
    if (!arr || !arr.length) return;
    const start = labels.length;
    arr.forEach((v, i) => { labels.push(i === 0 ? tApp('stage_' + s + '_short') : ''); allPoints.push(v); });
    const data = new Array(labels.length).fill(null);
    arr.forEach((v, i) => { data[start + i] = v; });
    datasets.push({
      label: tApp('stage_' + s + '_short'), data, borderColor: CHART_COLORS[s],
      borderWidth: s === 'playing' ? 2.4 : 1.8, pointRadius: 0, tension: 0.2, spanGaps: false
    });
  });
  datasets.forEach(ds => { while (ds.data.length < labels.length) ds.data.push(null); });
  if (!labels.length) { ChartRegistry.destroy(canvasId); return; }

  const bandPlugin = {
    id: 'cvaBands_' + canvasId,
    beforeDraw(chart) {
      const { ctx, chartArea, scales: { x, y } } = chart;
      if (!x || !y) return;
      ctx.save();
      ctx.fillStyle = 'rgba(254,223,225,0.55)';
      let inBand = false, start = 0;
      allPoints.forEach((v, i) => {
        const px = x.getPixelForValue(i);
        if (v < th && !inBand) { start = px; inBand = true; }
        else if (v >= th && inBand) { ctx.fillRect(start, chartArea.top, px - start, chartArea.bottom - chartArea.top); inBand = false; }
      });
      if (inBand) ctx.fillRect(start, chartArea.top, x.getPixelForValue(allPoints.length - 1) - start, chartArea.bottom - chartArea.top);
      const yp = y.getPixelForValue(th);
      ctx.strokeStyle = 'rgba(142,53,74,0.8)'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(chartArea.left, yp); ctx.lineTo(chartArea.right, yp); ctx.stroke();
      ctx.restore();
    }
  };
  const vals = allPoints.filter(v => typeof v === 'number');
  const lo = Math.min(th, ...vals), hi = Math.max(th, ...vals);
  ChartRegistry.set(canvasId, () => new Chart(canvas.getContext('2d'), {
    type: 'line',
    plugins: [bandPlugin],
    data: { labels, datasets },
    options: baseChartOptions({
      animation: { duration: 400 },
      scales: {
        x: { grid: { display: false }, ticks: { color: CHART_COLORS.tick, autoSkip: false, maxRotation: 0, callback: (v, i) => labels[i] || '' } },
        y: { suggestedMin: Math.floor(lo - 5), suggestedMax: Math.ceil(hi + 5), grid: { color: CHART_COLORS.grid }, ticks: { color: CHART_COLORS.tick, callback: v => `${v}°` } }
      },
      plugins: {
        legend: { display: group === 'modal', labels: { color: CHART_COLORS.text, font: { family: 'Noto Sans TC', size: 11 }, boxWidth: 14 } },
        tooltip: { callbacks: { label: c => `${isNew ? 'CVA' : 'CVA Δ'} ${c.raw === null ? '--' : (+c.raw).toFixed(1)}°`, afterLabel: c => (c.raw !== null && c.raw < th) ? tApp('below_threshold_flag') : '' } }
      }
    })
  }), group);
}

// ── 儲存 ─────────────────────────────────────────────────────────
async function savePlayingRecord() {
  if (!playingResult || !playingResult.summary) return;
  const btn = document.getElementById('btn-save-playing');
  btn.disabled = true;
  const uid = App.user.uid;
  const now = Date.now();
  const r = playingResult;
  const cvaByStage = {};
  STAGES.forEach(s => { if (r.stages[s]) cvaByStage[s] = r.stages[s].cva; });
  const record = {
    id: now,
    timestamp: new Date(now).toLocaleString('zh-TW', { hour12: false }),
    createdAtMs: now, dateKey: dateKeyOf(now), version: 2,
    username: App.profile.username, instrument: App.profile.instrument,
    type: 'playing', projectName: '演奏動作評估',
    score: r.score, level: r.level,
    thresholds: { cvaMin: ALERT_THRESHOLDS.CVA_MIN, shoulderDeltaMax: ALERT_THRESHOLDS.SHOULDER_DELTA_MAX, elbowMin: ALERT_THRESHOLDS.ELBOW_MIN, elbowMax: ALERT_THRESHOLDS.ELBOW_MAX },
    practice: { durationSec: _r(practiceSession.durationSec, 1), badPostureSec: _r(practiceSession.badSec, 1), alertCount: practiceSession.alertCount },
    details: {
      stages: r.stages,
      summary: r.summary,
      cva: cvaByStage,                              // 相容舊結構 details.cva.{stage}
      shoulderData: r.stages.playing ? r.stages.playing.shoulderData : null,
      elbowData: r.stages.playing ? r.stages.playing.elbowData : null,
      // 尚未接真實偵測的參數：留空
      shoulderSymmetry: null, wristFlexion: null, spineTilt: null
    }
  };
  try {
    const recordId = await DataAPI.addSub(uid, 'records', record);
    const g = App.profile.gender;
    await DataAPI.addSub(uid, 'bodyMaps', { context: 'pre', recordId, marks: sessionMaps.pre, gender: g, createdAtMs: now, dateKey: record.dateKey });
    await DataAPI.addSub(uid, 'bodyMaps', { context: 'post', recordId, marks: sessionMaps.post, gender: g, createdAtMs: now + 1, dateKey: record.dateKey });
    await DataAPI.addSub(uid, 'practiceSessions', {
      source: 'detection', recordId, durationSec: record.practice.durationSec,
      badPostureSec: record.practice.badPostureSec, alertCount: record.practice.alertCount,
      createdAtMs: now, dateKey: record.dateKey
    });
    await Promise.all([
      refreshPerformerSub('records', 'records'), refreshPerformerSub('bodyMaps', 'bodyMaps'),
      refreshPerformerSub('practiceSessions', 'practiceLogs')
    ]);
    showToast(tApp('toast_assessment_saved'), 'success');
    resetPlayingCapture(true);
    setTimeout(() => switchSection('history'), 400);
  } catch (err) {
    console.error('評估儲存失敗：', err);
    showToast(tApp('toast_save_fail'), 'danger');
  } finally {
    btn.disabled = false;
  }
}

function resetPlayingCapture(silent) {
  closeCamera();
  const keep = { pose: cvaState.pose, modelReady: cvaState.modelReady };
  cvaState = Object.assign(newCvaState(), keep);
  practiceSession = newPracticeSession();
  alertState = { badSince: null, goodSince: null, lastAlertAt: -Infinity, showing: false };
  playingResult = null;
  sessionMaps = { pre: [], post: [], done: false };
  dismissPageAlert();
  document.getElementById('playing-waiting-panel').style.display = 'flex';
  document.getElementById('playing-results-panel').style.display = 'none';
  document.getElementById('playing-charts-grid').style.display = 'none';
  ['playJoint', 'playOver', 'cvaTrendChart'].forEach(id => ChartRegistry.destroy(id));
  selectStep('relax');
  refreshStageCards();
  updatePracticeUI();
  if (!silent) showToast(tApp('toast_reset'), 'info');
}
