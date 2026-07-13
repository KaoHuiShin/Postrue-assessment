// Application State Management
let currentProfile = null;
let playingRecords = {
  relax: null,
  prepare: null,
  playing: null
};
let selectedPlayingStep = 'relax'; // 'relax' | 'prepare' | 'playing'
let selectedDiagnostic = 'uneven-shoulders'; // 'uneven-shoulders' | 'forward-head' | 'arm-raise'
let isDiagnosingStatic = false;

// Chart references
let dashboardTrendChartRef = null;
let playingRadarChartRef = null;
let playingSymmetryChartRef = null;
let cvaTrendChartRef = null;

// Canvas Animation variables
let playingCanvasAnimId = null;
let staticCanvasAnimId = null;

// Multi-record Selection State
let selectedRecordIds = new Set();

// ── CVA Detection State ──────────────────────────────────────────
// Mirrors Python: is_recording, data_cache[], LEFT_EAR=7, RIGHT_EAR=8, LEFT_SHLD=11, RIGHT_SHLD=12
let cvaState = {
  pose: null,          // MediaPipe Pose instance
  camera: null,        // MediaPipe Camera instance
  stream: null,        // Raw MediaStream (for cleanup)
  activeStage: null,   // 'relax' | 'prepare' | 'playing' | null
  isRecording: false,
  isCalibrating: false,     // true during the 3-second calibration window
  referenceAngle: null,     // Baseline CVA captured during calibration (like Python's reference_head)
  calibFrames: [],          // Angles collected during calibration window
  frameBuffers: {           // Per-stage raw *delta* angle arrays
    relax: [],
    prepare: [],
    playing: []
  },
  modelReady: false
};

// Initialize App
document.addEventListener('DOMContentLoaded', () => {
  // Initialize Lucide Icons
  lucide.createIcons();
  
  // Load profile and history from localStorage
  loadProfileFromStorage();
  updateHistoryTable();
  updateDashboardStats();
  renderDashboardTrendChart();
  
  // Start canvas animations
  initCanvasSimulators();
});

// Toast Notification Helper
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  let iconName = 'info';
  if (type === 'success') iconName = 'check-circle';
  if (type === 'warning') iconName = 'alert-triangle';
  if (type === 'danger') iconName = 'alert-circle';
  
  toast.innerHTML = `
    <i data-lucide="${iconName}"></i>
    <span>${message}</span>
  `;
  
  container.appendChild(toast);
  lucide.createIcons();
  
  setTimeout(() => {
    toast.style.animation = 'slideIn 0.2s reverse forwards';
    setTimeout(() => toast.remove(), 200);
  }, 3500);
}

// ----------------------------------------------------
// 1. SPA ROUTING
// ----------------------------------------------------
function switchSection(sectionId) {
  // Hide all sections
  const sections = document.querySelectorAll('section');
  sections.forEach(s => s.classList.remove('active'));
  
  // Deactivate all nav links
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach(item => item.classList.remove('active'));
  
  // Show target section
  const targetSection = document.getElementById(`section-${sectionId}`);
  if (targetSection) {
    targetSection.classList.add('active');
  }
  
  // Activate target nav link
  const targetNav = document.getElementById(`nav-${sectionId}`);
  if (targetNav) {
    targetNav.classList.add('active');
  }
  
  // Stop/Start animations based on active view
  if (sectionId === 'playing') {
    startPlayingCanvas();
    stopStaticCanvas();
  } else if (sectionId === 'static') {
    startStaticCanvas();
    stopPlayingCanvas();
  } else {
    stopPlayingCanvas();
    stopStaticCanvas();
  }
  
  // Refresh charts if needed
  if (sectionId === 'dashboard') {
    updateDashboardStats();
    renderDashboardTrendChart();
  }
  
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ----------------------------------------------------
// 2. PROFILE MANAGEMENT
// ----------------------------------------------------
function loadProfileFromStorage() {
  const stored = localStorage.getItem('musician_profile');
  if (stored) {
    currentProfile = JSON.parse(stored);
    updateProfileUI();
  }
}

function updateProfileUI() {
  if (currentProfile) {
    const avatarChar = currentProfile.username.charAt(0).toUpperCase();
    
    // Update headers
    document.getElementById('header-username').textContent = `${currentProfile.username} (${currentProfile.instrument})`;
    document.getElementById('header-avatar').textContent = avatarChar;
    
    // Update inner pages
    document.getElementById('playing-username').textContent = `${currentProfile.username} - ${currentProfile.instrument}`;
    document.getElementById('playing-avatar').textContent = avatarChar;
    
    document.getElementById('static-username').textContent = `${currentProfile.username} - ${currentProfile.instrument}`;
    document.getElementById('static-avatar').textContent = avatarChar;
    
    // Pre-fill form
    document.getElementById('username').value = currentProfile.username;
    document.getElementById('gender').value = currentProfile.gender;
    document.getElementById('age').value = currentProfile.age;
    document.getElementById('height').value = currentProfile.height;
    document.getElementById('instrument').value = currentProfile.instrument;
  }
}

function saveProfile(event) {
  event.preventDefault();
  
  const username = document.getElementById('username').value.trim();
  const gender = document.getElementById('gender').value;
  const age = parseInt(document.getElementById('age').value);
  const height = parseInt(document.getElementById('height').value);
  const instrument = document.getElementById('instrument').value;
  
  currentProfile = { username, gender, age, height, instrument };
  localStorage.setItem('musician_profile', JSON.stringify(currentProfile));
  
  updateProfileUI();
  showToast('個人資料儲存成功！已為您導航至動作評估。', 'success');
  
  // Navigate to playing assessment
  setTimeout(() => {
    switchSection('playing');
  }, 600);
}

function resetProfileForm() {
  document.getElementById('profile-form').reset();
  currentProfile = null;
  localStorage.removeItem('musician_profile');
  
  document.getElementById('header-username').textContent = 'Guest';
  document.getElementById('header-avatar').textContent = '?';
  document.getElementById('playing-username').textContent = 'Guest';
  document.getElementById('playing-avatar').textContent = '?';
  document.getElementById('static-username').textContent = 'Guest';
  document.getElementById('static-avatar').textContent = '?';
  
  showToast('資料已重設。', 'info');
}

// ----------------------------------------------------
// 3. CANVAS POSTURE SIMULATOR
// ----------------------------------------------------
let playingCanvas, playingCtx;
let staticCanvas, staticCtx;
let animFrameCount = 0;

function initCanvasSimulators() {
  playingCanvas = document.getElementById('playingCanvas');
  playingCtx = playingCanvas.getContext('2d');
  
  staticCanvas = document.getElementById('staticCanvas');
  staticCtx = staticCanvas.getContext('2d');
  
  resizeCanvas(playingCanvas);
  resizeCanvas(staticCanvas);
  
  window.addEventListener('resize', () => {
    resizeCanvas(playingCanvas);
    resizeCanvas(staticCanvas);
  });
}

function resizeCanvas(canvas) {
  if (canvas) {
    // Set internal canvas resolution to match its styling box bounding client rect
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
  }
}

function startPlayingCanvas() {
  if (!playingCanvasAnimId) {
    const render = () => {
      drawPlayingSkeleton();
      animFrameCount++;
      playingCanvasAnimId = requestAnimationFrame(render);
    };
    render();
  }
}

function stopPlayingCanvas() {
  if (playingCanvasAnimId) {
    cancelAnimationFrame(playingCanvasAnimId);
    playingCanvasAnimId = null;
  }
}

function startStaticCanvas() {
  if (!staticCanvasAnimId) {
    const render = () => {
      drawStaticSkeleton();
      staticCanvasAnimId = requestAnimationFrame(render);
    };
    render();
  }
}

function stopStaticCanvas() {
  if (staticCanvasAnimId) {
    cancelAnimationFrame(staticCanvasAnimId);
    staticCanvasAnimId = null;
  }
}

// Draw a stylized pose tracking background grid
function drawHudBackground(ctx, w, h) {
  ctx.fillStyle = '#1c1f24';
  ctx.fillRect(0, 0, w, h);
  
  // Draw grid lines
  ctx.strokeStyle = 'rgba(214, 220, 219, 0.05)'; // #D6DCDB alpha
  ctx.lineWidth = 1;
  const gridSpacing = 40;
  for (let x = 0; x < w; x += gridSpacing) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = 0; y < h; y += gridSpacing) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  
  // Draw tech circular radar ring
  ctx.strokeStyle = 'rgba(192, 176, 162, 0.08)'; // #C0B0A2 alpha
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, Math.min(w, h) * 0.38, 0, Math.PI * 2);
  ctx.stroke();
}

function drawSkeletonJoint(ctx, x, y, size = 6, color = '#A1B0AD') {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, size, 0, Math.PI * 2);
  ctx.fill();
  
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, size + 2, 0, Math.PI * 2);
  ctx.stroke();
}

function drawSkeletonBone(ctx, p1, p2, color = '#82898D', width = 3) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.stroke();
}

// ------------------- PLAYING POSE SIMULATION -------------------
function drawPlayingSkeleton() {
  const w = playingCanvas.width;
  const h = playingCanvas.height;
  if (w === 0 || h === 0) return;
  
  const ctx = playingCtx;
  drawHudBackground(ctx, w, h);
  
  // Breathing/movement factor
  const t = animFrameCount * 0.05;
  const breath = Math.sin(t) * 4;
  const instrument = currentProfile ? currentProfile.instrument : 'Violin';
  
  // Define base coordinates (front view center)
  const neckY = h * 0.35 + breath * 0.2;
  const spineMidX = w / 2;
  const shoulderWidth = w * 0.22;
  
  let head = { x: w / 2, y: h * 0.22 + breath * 0.4 };
  let neck = { x: w / 2, y: neckY };
  
  // Default values
  let lShoulder = { x: w / 2 - shoulderWidth / 2, y: neckY + 5 };
  let rShoulder = { x: w / 2 + shoulderWidth / 2, y: neckY + 5 };
  let lElbow = { x: lShoulder.x - 40, y: lShoulder.y + 80 };
  let rElbow = { x: rShoulder.x + 40, y: rShoulder.y + 80 };
  let lWrist = { x: lElbow.x - 20, y: lElbow.y + 60 };
  let rWrist = { x: rElbow.x + 20, y: rElbow.y + 60 };
  
  let lHip = { x: w / 2 - shoulderWidth * 0.4, y: h * 0.75 };
  let rHip = { x: w / 2 + shoulderWidth * 0.4, y: h * 0.75 };
  
  // Adjust posture based on selected step & instrument
  if (selectedPlayingStep === 'relax') {
    // Relaxation state: Arms rest comfortably down
    lElbow = { x: lShoulder.x - 25, y: lShoulder.y + 90 + breath * 0.3 };
    rElbow = { x: rShoulder.x + 25, y: rShoulder.y + 90 + breath * 0.3 };
    lWrist = { x: lElbow.x + 10, y: lElbow.y + 70 };
    rWrist = { x: rElbow.x - 10, y: rElbow.y + 70 };
  } 
  else if (selectedPlayingStep === 'prepare') {
    if (instrument === 'Violin') {
      // Violin prep: Hold violin with left arm near neck, right arm holding bow down
      lElbow = { x: lShoulder.x - 70, y: lShoulder.y + 30 };
      lWrist = { x: head.x - 35, y: head.y + 15 }; // holding scroll
      
      rElbow = { x: rShoulder.x + 40, y: rShoulder.y + 70 };
      rWrist = { x: rElbow.x - 10, y: rElbow.y + 50 }; // holding bow near waist
    } else {
      // Cello prep: Arms wider, encircling cello
      lElbow = { x: lShoulder.x - 80, y: lShoulder.y + 50 };
      lWrist = { x: w / 2 - 50, y: h * 0.55 };
      
      rElbow = { x: rShoulder.x + 80, y: rShoulder.y + 50 };
      rWrist = { x: w / 2 + 50, y: h * 0.55 };
    }
  } 
  else if (selectedPlayingStep === 'playing') {
    // Dynamic bowing simulation!
    const bowCycle = Math.sin(t * 0.8); // faster bowing movement
    
    if (instrument === 'Violin') {
      // Violin Playing: Left hand fixed at scroll, right arm moving back and forth (bowing)
      lElbow = { x: lShoulder.x - 75, y: lShoulder.y + 25 + Math.sin(t)*2 };
      lWrist = { x: head.x - 30, y: head.y + 10 }; 
      
      // Right bowing arm
      rElbow = { x: rShoulder.x + 50 + bowCycle * 15, y: rShoulder.y + 30 - bowCycle * 8 };
      rWrist = { x: w / 2 - 20 + bowCycle * 45, y: h * 0.38 - bowCycle * 10 };
      
      // Draw violin vector wireframe (very premium aesthetic)
      ctx.strokeStyle = '#8D6B61'; // Instrument color
      ctx.fillStyle = 'rgba(141, 107, 97, 0.15)';
      ctx.lineWidth = 2.5;
      
      // Draw Violin body near shoulder/chin
      ctx.beginPath();
      ctx.ellipse(head.x - 20, head.y + 25, 20, 35, -Math.PI / 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // Neck/fingerboard extending left
      ctx.beginPath();
      ctx.moveTo(head.x - 25, head.y + 28);
      ctx.lineTo(lWrist.x, lWrist.y);
      ctx.stroke();
      
      // Draw Bow line
      ctx.strokeStyle = '#82898D';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(rWrist.x - 50, rWrist.y - 10);
      ctx.lineTo(rWrist.x + 80, rWrist.y + 20);
      ctx.stroke();
    } else {
      // Cello Playing: Left hand on cello fingerboard, right arm bowing across strings
      lElbow = { x: lShoulder.x - 75, y: lShoulder.y + 40 };
      lWrist = { x: w / 2 - 20, y: h * 0.45 + Math.sin(t) * 5 };
      
      // Bowing arm
      rElbow = { x: rShoulder.x + 80 + bowCycle * 10, y: rShoulder.y + 50 + bowCycle * 15 };
      rWrist = { x: w / 2 + 10 + bowCycle * 40, y: h * 0.6 + bowCycle * 5 };
      
      // Draw Cello wireframe
      ctx.strokeStyle = '#8D6B61';
      ctx.fillStyle = 'rgba(141, 107, 97, 0.15)';
      ctx.lineWidth = 3;
      // Body
      ctx.beginPath();
      ctx.ellipse(w / 2 - 5, h * 0.65, 35, 65, 0.08, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // Neck
      ctx.beginPath();
      ctx.moveTo(w / 2 - 5, h * 0.52);
      ctx.lineTo(w / 2 - 15, h * 0.35);
      ctx.stroke();
      
      // Bow line
      ctx.strokeStyle = '#82898D';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(rWrist.x - 90, rWrist.y - 15);
      ctx.lineTo(rWrist.x + 40, rWrist.y + 10);
      ctx.stroke();
    }
  }
  
  // Draw Body Joints and Bones
  // Head
  ctx.strokeStyle = 'rgba(161, 176, 173, 0.8)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(head.x, head.y, 25, 0, Math.PI * 2);
  ctx.stroke();
  
  // Bones
  drawSkeletonBone(ctx, head, neck, '#82898D', 4);
  drawSkeletonBone(ctx, lShoulder, rShoulder, '#8D6B61', 5); // highlighted shoulder line
  drawSkeletonBone(ctx, neck, { x: w/2, y: neckY+5 }, '#82898D', 4);
  drawSkeletonBone(ctx, { x: w/2, y: neckY+5 }, { x: w/2, y: h*0.75 }, '#82898D', 4); // spine
  
  drawSkeletonBone(ctx, lShoulder, lElbow, '#82898D', 3);
  drawSkeletonBone(ctx, lElbow, lWrist, '#82898D', 3);
  drawSkeletonBone(ctx, rShoulder, rElbow, '#82898D', 3);
  drawSkeletonBone(ctx, rElbow, rWrist, '#82898D', 3);
  
  drawSkeletonBone(ctx, lHip, rHip, '#82898D', 4);
  drawSkeletonBone(ctx, { x: w/2, y: h*0.75 }, lHip, '#82898D', 3);
  drawSkeletonBone(ctx, { x: w/2, y: h*0.75 }, rHip, '#82898D', 3);
  
  // Joint Nodes
  drawSkeletonJoint(ctx, head.x, head.y, 5, '#C0B0A2');
  drawSkeletonJoint(ctx, neck.x, neck.y, 6, '#C0B0A2');
  drawSkeletonJoint(ctx, lShoulder.x, lShoulder.y, 7, '#8D6B61');
  drawSkeletonJoint(ctx, rShoulder.x, rShoulder.y, 7, '#8D6B61');
  drawSkeletonJoint(ctx, lElbow.x, lElbow.y, 6, '#A1B0AD');
  drawSkeletonJoint(ctx, rElbow.x, rElbow.y, 6, '#A1B0AD');
  drawSkeletonJoint(ctx, lWrist.x, lWrist.y, 6, '#A1B0AD');
  drawSkeletonJoint(ctx, rWrist.x, rWrist.y, 6, '#A1B0AD');
  
  // Visual indicators Overlay (e.g. angle text on joints)
  ctx.fillStyle = '#C6CCC0';
  ctx.font = '10px monospace';
  ctx.fillText('L_SH: 0.0°', lShoulder.x - 60, lShoulder.y - 10);
  ctx.fillText('R_SH: 0.0°', rShoulder.x + 10, rShoulder.y - 10);
  
  const lElbowAngle = Math.round(Math.abs(Math.atan2(lWrist.y - lElbow.y, lWrist.x - lElbow.x) * 180 / Math.PI));
  ctx.fillText(`ELB_L: ${lElbowAngle}°`, lElbow.x - 30, lElbow.y + 20);
}

// ------------------- STATIC POSE SIMULATION -------------------
function drawStaticSkeleton() {
  const w = staticCanvas.width;
  const h = staticCanvas.height;
  if (w === 0 || h === 0) return;
  
  const ctx = staticCtx;
  drawHudBackground(ctx, w, h);
  
  const t = animFrameCount * 0.03;
  const breath = Math.sin(t) * 3;
  
  ctx.strokeStyle = 'rgba(161, 176, 173, 0.8)';
  
  if (selectedDiagnostic === 'uneven-shoulders') {
    // High-low shoulders simulation (Front view, tilted shoulders)
    const spineX = w / 2;
    const neckY = h * 0.38 + breath * 0.2;
    const shoulderWidth = w * 0.24;
    
    // Tilted shoulders coordinates (Right shoulder is 18px lower than left shoulder)
    const tiltOffset = 18; 
    let head = { x: w / 2, y: h * 0.24 + breath * 0.3 };
    let neck = { x: w / 2, y: neckY };
    
    // Uneven shoulders: Left is higher, Right is lower
    let lShoulder = { x: spineX - shoulderWidth / 2, y: neckY - tiltOffset / 2 };
    let rShoulder = { x: spineX + shoulderWidth / 2, y: neckY + tiltOffset / 2 };
    
    let lElbow = { x: lShoulder.x - 20, y: lShoulder.y + 100 };
    let rElbow = { x: rShoulder.x + 20, y: rShoulder.y + 90 };
    let lWrist = { x: lElbow.x + 5, y: lElbow.y + 80 };
    let rWrist = { x: rElbow.x - 5, y: rElbow.y + 80 };
    
    // Draw bones
    drawSkeletonBone(ctx, head, neck, '#82898D', 4);
    drawSkeletonBone(ctx, lShoulder, rShoulder, '#C39289', 5); // Tilted bone - color-danger
    drawSkeletonBone(ctx, neck, { x: spineX, y: h * 0.78 }, '#82898D', 4);
    
    drawSkeletonBone(ctx, lShoulder, lElbow, '#82898D', 3);
    drawSkeletonBone(ctx, lElbow, lWrist, '#82898D', 3);
    drawSkeletonBone(ctx, rShoulder, rElbow, '#82898D', 3);
    drawSkeletonBone(ctx, rElbow, rWrist, '#82898D', 3);
    
    // Draw Joints
    drawSkeletonJoint(ctx, head.x, head.y, 5, '#C0B0A2');
    drawSkeletonJoint(ctx, neck.x, neck.y, 5, '#C0B0A2');
    drawSkeletonJoint(ctx, lShoulder.x, lShoulder.y, 7, '#C39289'); // Uneven highlight
    drawSkeletonJoint(ctx, rShoulder.x, rShoulder.y, 7, '#C39289'); // Uneven highlight
    
    // Draw Diagnostic Helper Line: Perfectly horizontal dashed guide line
    ctx.strokeStyle = '#C6CCC0'; // green helper line
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(lShoulder.x - 20, lShoulder.y);
    ctx.lineTo(rShoulder.x + 20, lShoulder.y);
    ctx.stroke();
    ctx.setLineDash([]);
    
    // Angle indicator text
    ctx.fillStyle = '#C39289';
    ctx.font = '11px Outfit, Noto Sans TC, monospace';
    ctx.fillText('傾斜偏差: 4.8° (異常)', spineX - 50, neckY - 25);
    ctx.fillText('高度差: 1.4 cm', rShoulder.x + 10, rShoulder.y + 5);
  }
  
  else if (selectedDiagnostic === 'forward-head') {
    // Forward head diagnostic (Side view skeleton)
    const spineX = w / 2 - 20;
    const spineY = h * 0.45;
    
    // Forward Head shifted head position
    const neckX = spineX + 25;
    const neckY = spineY - 30;
    const headX = neckX + 35; // Head shifted forward significantly
    const headY = neckY - 45;
    
    let hip = { x: spineX - 10, y: h * 0.78 };
    let backSpine = { x: spineX, y: spineY };
    let neck = { x: neckX, y: neckY };
    let head = { x: headX, y: headY };
    
    // Side view arms/legs
    let shoulder = { x: neckX - 5, y: neckY + 10 };
    let elbow = { x: shoulder.x - 15, y: shoulder.y + 90 };
    let wrist = { x: elbow.x + 25, y: elbow.y + 50 };
    
    // Draw bones
    drawSkeletonBone(ctx, hip, backSpine, '#82898D', 5);
    drawSkeletonBone(ctx, backSpine, neck, '#82898D', 5);
    drawSkeletonBone(ctx, neck, head, '#C39289', 5); // Head tilt bone - color-danger
    
    drawSkeletonBone(ctx, shoulder, elbow, '#82898D', 3);
    drawSkeletonBone(ctx, elbow, wrist, '#82898D', 3);
    
    // Head circle
    ctx.beginPath();
    ctx.arc(head.x, head.y, 25, 0, Math.PI * 2);
    ctx.stroke();
    
    // Draw Joints
    drawSkeletonJoint(ctx, head.x, head.y, 6, '#C0B0A2');
    drawSkeletonJoint(ctx, neck.x, neck.y, 6, '#C39289');
    drawSkeletonJoint(ctx, shoulder.x, shoulder.y, 7, '#8D6B61');
    
    // Vertical reference line from shoulder/neck root
    ctx.strokeStyle = '#C6CCC0';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(neck.x, neck.y + 100);
    ctx.lineTo(neck.x, neck.y - 70);
    ctx.stroke();
    ctx.setLineDash([]);
    
    // Deviation line
    ctx.strokeStyle = '#C39289';
    ctx.beginPath();
    ctx.moveTo(neck.x, neck.y);
    ctx.lineTo(head.x, head.y);
    ctx.stroke();
    
    ctx.fillStyle = '#C39289';
    ctx.font = '11px Outfit, Noto Sans TC, monospace';
    ctx.fillText('頸椎夾角: 23.5° (標準 < 15°)', head.x + 10, head.y);
    ctx.fillText('前傾偏位 (烏龜頸)', head.x + 10, head.y + 18);
  }
  
  else if (selectedDiagnostic === 'arm-raise') {
    // Arm raise test (Front view raising arms over head)
    const spineX = w / 2;
    const neckY = h * 0.38 + breath * 0.2;
    const shoulderWidth = w * 0.22;
    
    let head = { x: w / 2, y: h * 0.24 + breath * 0.3 };
    let neck = { x: w / 2, y: neckY };
    
    let lShoulder = { x: spineX - shoulderWidth / 2, y: neckY };
    let rShoulder = { x: spineX + shoulderWidth / 2, y: neckY };
    
    // Raised arms (left raised normal, right restricted/lower)
    let lElbow = { x: lShoulder.x - 20, y: lShoulder.y - 75 };
    let lWrist = { x: lElbow.x + 15, y: lElbow.y - 75 }; // Straight up (approx. 170 deg)
    
    let rElbow = { x: rShoulder.x + 40, y: rShoulder.y - 50 };
    let rWrist = { x: rElbow.x - 5, y: rElbow.y - 65 }; // Restricted arm, can't lift straight (approx. 135 deg)
    
    // Draw bones
    drawSkeletonBone(ctx, head, neck, '#82898D', 4);
    drawSkeletonBone(ctx, lShoulder, rShoulder, '#8D6B61', 5);
    drawSkeletonBone(ctx, neck, { x: spineX, y: h * 0.78 }, '#82898D', 4);
    
    // Left arm raised
    drawSkeletonBone(ctx, lShoulder, lElbow, '#C6CCC0', 4); // healthy normal
    drawSkeletonBone(ctx, lElbow, lWrist, '#C6CCC0', 4);
    
    // Right arm restricted
    drawSkeletonBone(ctx, rShoulder, rElbow, '#E1AA8D', 4); // warning
    drawSkeletonBone(ctx, rElbow, rWrist, '#E1AA8D', 4);
    
    // Draw Joints
    drawSkeletonJoint(ctx, head.x, head.y, 5, '#C0B0A2');
    drawSkeletonJoint(ctx, lShoulder.x, lShoulder.y, 7, '#8D6B61');
    drawSkeletonJoint(ctx, rShoulder.x, rShoulder.y, 7, '#8D6B61');
    drawSkeletonJoint(ctx, lElbow.x, lElbow.y, 5, '#C6CCC0');
    drawSkeletonJoint(ctx, rElbow.x, rElbow.y, 5, '#E1AA8D');
    drawSkeletonJoint(ctx, lWrist.x, lWrist.y, 5, '#C6CCC0');
    drawSkeletonJoint(ctx, rWrist.x, rWrist.y, 5, '#E1AA8D');
    
    // Head circle
    ctx.beginPath();
    ctx.arc(head.x, head.y, 25, 0, Math.PI * 2);
    ctx.stroke();
    
    // Helper angles arcs
    ctx.fillStyle = '#C6CCC0';
    ctx.fillText('左手抬起: 172° (良好)', lWrist.x - 90, lWrist.y - 10);
    ctx.fillStyle = '#E1AA8D';
    ctx.fillText('右手抬起: 138° (受限)', rWrist.x + 10, rWrist.y - 10);
  }
}

// ----------------------------------------------------
// 4. CVA DETECTION MODULE
// (JS port of fhp_monitor.py + process_fhp_data.py + visualize_fhp.py)
// ----------------------------------------------------

const CVA_IDX = { LEFT_EAR: 7, RIGHT_EAR: 8, LEFT_SHLD: 11, RIGHT_SHLD: 12 };
const CVA_THRESHOLD = 60;

function cvaMidpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function calcCVA(landmarks) {
  const head = cvaMidpoint(landmarks[CVA_IDX.LEFT_EAR], landmarks[CVA_IDX.RIGHT_EAR]);
  const shld = cvaMidpoint(landmarks[CVA_IDX.LEFT_SHLD], landmarks[CVA_IDX.RIGHT_SHLD]);
  const yDiff = Math.abs(head.y - shld.y);
  const xDiff = Math.abs(head.x - shld.x);
  return Math.atan2(yDiff, xDiff) * (180 / Math.PI);
}

function syncOverlaySize(canvas) {
  const rect = canvas.getBoundingClientRect();
  if (canvas.width !== rect.width || canvas.height !== rect.height) {
    canvas.width  = rect.width;
    canvas.height = rect.height;
  }
}

function drawCvaOverlay(canvas, landmarks, rawAngle, delta) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const head = cvaMidpoint(landmarks[CVA_IDX.LEFT_EAR], landmarks[CVA_IDX.RIGHT_EAR]);
  const shld = cvaMidpoint(landmarks[CVA_IDX.LEFT_SHLD], landmarks[CVA_IDX.RIGHT_SHLD]);
  const hx = head.x * w, hy = head.y * h;
  const sx = shld.x * w, sy = shld.y * h;

  ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(sx, sy); ctx.stroke();

  ctx.strokeStyle = 'rgba(161,176,173,0.6)'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(sx - 70, sy); ctx.lineTo(sx + 70, sy); ctx.stroke();
  ctx.setLineDash([]);

  const isWarning = Math.abs(delta) > 10;
  ctx.fillStyle = isWarning ? '#C39289' : '#C6CCC0';
  ctx.beginPath(); ctx.arc(hx, hy, 7, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(hx, hy, 7, 0, Math.PI * 2); ctx.stroke();

  ctx.fillStyle = '#8D6B61';
  ctx.beginPath(); ctx.arc(sx, sy, 7, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(sx, sy, 7, 0, Math.PI * 2); ctx.stroke();

  const mx = (hx + sx) / 2, my = (hy + sy) / 2;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.beginPath(); ctx.roundRect(mx + 6, my - 11, 90, 20, 4); ctx.fill();
  ctx.fillStyle = isWarning ? '#C39289' : '#C6CCC0';
  ctx.font = 'bold 12px monospace';
  ctx.fillText(`${rawAngle.toFixed(1)}° raw`, mx + 10, my + 3);
}

async function initCvaPose() {
  if (cvaState.modelReady) return true;
  if (typeof Pose === 'undefined') {
    showToast('MediaPipe model loading, please try again shortly…', 'warning');
    return false;
  }
  const pose = new Pose({
    locateFile: (file) =>
      `https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404/${file}`
  });
  pose.setOptions({
    modelComplexity: 1,
    smoothLandmarks: true,
    enableSegmentation: false,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5
  });

  pose.onResults((results) => {
    if (!cvaState.activeStage) return;
    if (!results.poseLandmarks) return;
    const rawAngle = calcCVA(results.poseLandmarks);
    if (isNaN(rawAngle)) return;

    // Always draw overlay while camera is open
    const overlayCanvas = document.getElementById('cva-overlay-canvas');
    if (overlayCanvas) {
      syncOverlaySize(overlayCanvas);
      const delta = cvaState.referenceAngle !== null ? rawAngle - cvaState.referenceAngle : 0;
      drawCvaOverlay(overlayCanvas, results.poseLandmarks, rawAngle, delta);
    }

    // ── Calibration sampling ─────────────────────────────────
    if (cvaState.isCalibrating) {
      cvaState.calibFrames.push(rawAngle);
      return;
    }

    // ── Active recording ─────────────────────────────────────
    if (!cvaState.isRecording) return;
    if (cvaState.referenceAngle === null) return;

    const delta = rawAngle - cvaState.referenceAngle;
    const stage = cvaState.activeStage;
    cvaState.frameBuffers[stage].push(delta);
    const frameCount = cvaState.frameBuffers[stage].length;

    const angleEl  = document.getElementById(`cva-angle-${stage}`);
    const framesEl = document.getElementById(`cva-frames-${stage}`);
    if (angleEl)  angleEl.textContent  = `Δ ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}°`;
    if (framesEl) framesEl.textContent = `${frameCount} 幀`;

    const overlayAngleEl = document.getElementById('cva-live-overlay-angle');
    if (overlayAngleEl) {
      overlayAngleEl.textContent = `CVA Δ: ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}°`;
      overlayAngleEl.style.color = Math.abs(delta) > 10 ? '#C39289' : '#C6CCC0';
    }

    document.getElementById('playing-hud-text').innerHTML =
      `STATUS: RECORDING CVA [${stage.toUpperCase()}]<br>` +
      `DELTA: ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}° | FRAME: ${frameCount}`;
  });

  await pose.initialize();
  cvaState.pose = pose;
  cvaState.modelReady = true;
  return true;
}

// ── ① 啟動攝影機 ──────────────────────────────────────────────────
async function openCamera(stage, event) {
  if (event) event.stopPropagation();
  if (!currentProfile) {
    showToast('Please fill in your personal information first.', 'warning');
    switchSection('profile');
    return;
  }

  // 若另一個 stage 正在使用，先關閉
  if (cvaState.activeStage && cvaState.activeStage !== stage) {
    closeCamera(cvaState.activeStage);
  }

  const openBtn = document.getElementById(`cva-btn-${stage}`);
  if (openBtn) { openBtn.disabled = true; openBtn.innerHTML = 'Loading…'; }

  const ready = await initCvaPose();
  if (!ready) {
    if (openBtn) { openBtn.disabled = false; openBtn.innerHTML = '<i data-lucide="video"></i> Start Camera'; lucide.createIcons(); }
    return;
  }

  try {
    cvaState.stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  } catch {
    showToast('Cannot access camera. Please check browser permissions.', 'danger');
    if (openBtn) { openBtn.disabled = false; openBtn.innerHTML = '<i data-lucide="video"></i> Start Camera'; lucide.createIcons(); }
    return;
  }

  // 嵌入黑色框
  const video = document.getElementById('cva-video');
  const overlayCanvas = document.getElementById('cva-overlay-canvas');
  const simCanvas = document.getElementById('playingCanvas');
  video.srcObject = cvaState.stream;
  video.style.display = 'block';
  overlayCanvas.style.display = 'block';
  simCanvas.style.display = 'none';
  document.getElementById('cva-live-overlay-angle').style.display = 'block';
  document.getElementById('cva-ref-badge').style.display = 'block';
  document.getElementById('video-status-text').textContent = `攝影機 [${stage.toUpperCase()}]`;
  document.getElementById('video-overlay-dot-el').style.background = '#A1B0AD';

  cvaState.activeStage = stage;
  cvaState.isCalibrating = false;
  cvaState.isRecording = false;
  cvaState.frameBuffers[stage] = [];

  cvaState.camera = new Camera(video, {
    onFrame: async () => {
      if (cvaState.pose) await cvaState.pose.send({ image: video });
    },
    width: 640, height: 480
  });
  cvaState.camera.start();

  selectStep(stage);

  // 顯示校準按鈕
  if (openBtn) openBtn.style.display = 'none';
  const calibBtn    = document.getElementById(`cva-calib-btn-${stage}`);
  const calibStatus = document.getElementById(`cva-calib-status-${stage}`);
  const recBtn      = document.getElementById(`cva-rec-btn-${stage}`);
  calibBtn.style.display = 'inline-flex';

  // 若已有基準值（重開攝影機的情況），顯示並解鎖錄製
  if (cvaState.referenceAngle !== null) {
    document.getElementById('cva-ref-badge').textContent = `基準: ${cvaState.referenceAngle.toFixed(1)}°`;
    calibStatus.style.display = 'block';
    calibStatus.textContent = `基準: ${cvaState.referenceAngle.toFixed(1)}° (recalibrate if needed)`;
    recBtn.style.display = 'inline-flex';
    recBtn.innerHTML = '<i data-lucide="circle"></i> Start Recording';
  } else {
    document.getElementById('cva-ref-badge').textContent = 'Baseline: Not calibrated';
    calibStatus.style.display = 'none';
    recBtn.style.display = 'none';
  }

  lucide.createIcons();
  document.getElementById('playing-hud-text').innerHTML =
    `STATUS: CAMERA READY [${stage.toUpperCase()}]<br>Please calibrate before recording`;
}

// ── ② 校準歸零（手動觸發，收集 1.5 秒取平均）────────────────────
async function runCalibration(stage, event) {
  if (event) event.stopPropagation();
  if (cvaState.activeStage !== stage || !cvaState.camera) return;
  if (cvaState.isRecording) {
    showToast('Please stop recording before recalibrating.', 'warning');
    return;
  }

  const calibBtn    = document.getElementById(`cva-calib-btn-${stage}`);
  const calibStatus = document.getElementById(`cva-calib-status-${stage}`);
  const recBtn      = document.getElementById(`cva-rec-btn-${stage}`);

  calibBtn.disabled = true;
  calibBtn.innerHTML = '<i data-lucide="loader"></i> Sampling…';
  if (recBtn) recBtn.style.display = 'none';
  calibStatus.style.display = 'block';
  calibStatus.textContent = 'Sampling baseline posture… (please hold still)';

  document.getElementById('video-status-text').textContent = 'CALIBRATING…';
  document.getElementById('video-overlay-dot-el').style.background = '#E1AA8D';
  document.getElementById('playing-hud-text').innerHTML =
    'STATUS: CALIBRATING…<br>HOLD YOUR NEUTRAL POSTURE STILL';

  cvaState.calibFrames = [];
  cvaState.isCalibrating = true;
  await new Promise(r => setTimeout(r, 1500));
  cvaState.isCalibrating = false;

  if (cvaState.calibFrames.length === 0) {
    showToast('No pose detected. Please check camera angle and try again.', 'danger');
    calibBtn.disabled = false;
    calibBtn.innerHTML = '<i data-lucide="crosshair"></i> Calibrate Zero';
    calibStatus.textContent = 'Calibration failed, please retry';
    lucide.createIcons();
    return;
  }

  cvaState.referenceAngle =
    cvaState.calibFrames.reduce((a, b) => a + b, 0) / cvaState.calibFrames.length;

  const refText = `基準: ${cvaState.referenceAngle.toFixed(1)}° (${cvaState.calibFrames.length} 幀)`;
  calibStatus.textContent = `✓ ${refText}`;
  document.getElementById('cva-ref-badge').textContent = refText;
  document.getElementById('video-status-text').textContent = `攝影機 [${stage.toUpperCase()}]`;
  document.getElementById('video-overlay-dot-el').style.background = '#A1B0AD';
  document.getElementById('playing-hud-text').innerHTML =
    `STATUS: CALIBRATED ✓<br>基準 ${cvaState.referenceAngle.toFixed(1)}° — ready to record`;

  calibBtn.disabled = false;
  calibBtn.innerHTML = '<i data-lucide="crosshair"></i> Recalibrate';
  recBtn.style.display = 'inline-flex';
  recBtn.innerHTML = '<i data-lucide="circle"></i> Start Recording';
  recBtn.style.background = '';
  recBtn.style.borderColor = '';

  lucide.createIcons();
  showToast(`Calibration complete！基準角度 ${cvaState.referenceAngle.toFixed(1)}°，ready to record。`, 'success');
}

// ── ③ 開始 / 停止錄製切換 ────────────────────────────────────────
function toggleRecording(stage, event) {
  if (event) event.stopPropagation();
  if (cvaState.activeStage !== stage) return;

  if (!cvaState.isRecording) {
    // 開始錄製
    if (cvaState.referenceAngle === null) {
      showToast('Please complete calibration before recording.', 'warning');
      return;
    }
    cvaState.frameBuffers[stage] = [];
    cvaState.isRecording = true;

    const recBtn = document.getElementById(`cva-rec-btn-${stage}`);
    recBtn.innerHTML = '<i data-lucide="square"></i> Stop Recording';
    recBtn.style.background = 'var(--color-danger)';
    recBtn.style.borderColor = 'var(--color-danger)';

    document.getElementById(`cva-calib-btn-${stage}`).disabled = true;
    document.getElementById(`cva-live-${stage}`).style.display = 'flex';
    document.getElementById(`label-${stage}`).textContent = 'Recording…';
    document.getElementById('video-status-text').textContent = `● REC [${stage.toUpperCase()}]`;
    document.getElementById('video-overlay-dot-el').style.background = '#C39289';

    lucide.createIcons();
    showToast(`「${getStateChineseName(stage)}」Recording started.`, 'info');

  } else {
    // 停止錄製
    cvaState.isRecording = false;
    const frames = cvaState.frameBuffers[stage];
    const recBtn = document.getElementById(`cva-rec-btn-${stage}`);
    document.getElementById(`cva-calib-btn-${stage}`).disabled = false;
    document.getElementById(`cva-live-${stage}`).style.display = 'none';

    if (frames.length < 5) {
      showToast('Too few frames captured. Please record again.', 'warning');
      recBtn.innerHTML = '<i data-lucide="circle"></i> Start Recording';
      recBtn.style.background = '';
      recBtn.style.borderColor = '';
      document.getElementById(`label-${stage}`).textContent = 'Not recorded';
      document.getElementById('video-status-text').textContent = `攝影機 [${stage.toUpperCase()}]`;
      document.getElementById('video-overlay-dot-el').style.background = '#A1B0AD';
      lucide.createIcons();
      return;
    }

    const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
    const min = Math.min(...frames);
    const max = Math.max(...frames);
    const alertCount = frames.filter(d => d < -10).length;
    const alertPct   = ((alertCount / frames.length) * 100).toFixed(1);

    if (!playingRecords[stage]) {
      playingRecords[stage] = generateMockPoseData(stage, currentProfile?.instrument || 'Violin');
    }
    playingRecords[stage].cva = {
      frames,
      referenceAngle: parseFloat(cvaState.referenceAngle?.toFixed(2) ?? 0),
      avg: parseFloat(avg.toFixed(2)),
      min: parseFloat(min.toFixed(2)),
      max: parseFloat(max.toFixed(2)),
      abovePct: parseFloat(alertPct),
      frameCount: frames.length
    };
    playingRecords[stage].neckAngle = parseFloat(Math.max(0, -avg + 12).toFixed(2));

    recBtn.innerHTML = '<i data-lucide="refresh-cw"></i> Re-record';
    recBtn.style.background = '';
    recBtn.style.borderColor = '';
    document.getElementById(`label-${stage}`).textContent =
      `Done ✓ (${frames.length} 幀, avg Δ${avg >= 0 ? '+' : ''}${avg.toFixed(1)}°)`;
    document.getElementById(`step-${stage}`).classList.add('captured');
    document.getElementById('video-status-text').textContent = `攝影機 [${stage.toUpperCase()}]`;
    document.getElementById('video-overlay-dot-el').style.background = '#A1B0AD';
    document.getElementById('playing-hud-text').innerHTML =
      `STATUS: RECORDED ✓ [${stage.toUpperCase()}]<br>FRAMES: ${frames.length} | AVG Δ${avg >= 0 ? '+' : ''}${avg.toFixed(1)}°`;

    lucide.createIcons();
    showToast(
      `「${getStateChineseName(stage)}」Recording complete.${frames.length} 幀，平均 Δ${avg >= 0 ? '+' : ''}${avg.toFixed(1)}°`,
      'success'
    );
    checkAndRenderPlayingDashboard();
  }
}

// ── 關閉攝影機（不清除已存資料）────────────────────────────────────
function closeCamera(stage) {
  cvaState.isRecording   = false;
  cvaState.isCalibrating = false;
  cvaState.activeStage   = null;
  if (cvaState.camera) { cvaState.camera.stop(); cvaState.camera = null; }
  if (cvaState.stream)  { cvaState.stream.getTracks().forEach(t => t.stop()); cvaState.stream = null; }

  const video = document.getElementById('cva-video');
  const overlayCanvas = document.getElementById('cva-overlay-canvas');
  const simCanvas = document.getElementById('playingCanvas');
  if (video) { video.style.display = 'none'; video.srcObject = null; }
  if (overlayCanvas) overlayCanvas.style.display = 'none';
  if (simCanvas) simCanvas.style.display = 'block';
  const liveAngle = document.getElementById('cva-live-overlay-angle');
  const refBadge  = document.getElementById('cva-ref-badge');
  const calibOv   = document.getElementById('cva-calibration-overlay');
  if (liveAngle) liveAngle.style.display = 'none';
  if (refBadge)  refBadge.style.display  = 'none';
  if (calibOv)   calibOv.style.display   = 'none';
  const statusText = document.getElementById('video-status-text');
  const statusDot  = document.getElementById('video-overlay-dot-el');
  if (statusText) statusText.textContent = 'POSE ESTIMATOR SIMULATOR';
  if (statusDot)  statusDot.style.background = '';
  startPlayingCanvas();
}

// ── 向後相容 ──────────────────────────────────────────────────────
function startCvaRecording(stage, event) { return openCamera(stage, event); }
async function stopCvaRecording(stage, event) {
  if (event) event.stopPropagation();
  if (cvaState.isRecording) toggleRecording(stage);
  closeCamera(stage);
}


// ----------------------------------------------------
// 4-B. CAPTURING / DIAGNOSING (SIMULATED DATA GENERATION)
// (kept for "載入模擬示範數據" fallback)
// ----------------------------------------------------
function captureState(state, event) {
  if (event) event.stopPropagation(); // prevent card click bubbling
  
  if (!currentProfile) {
    showToast('Please complete your personal information before recording.', 'warning');
    switchSection('profile');
    return;
  }
  
  // Set current selecting step card active visual
  selectStep(state);
  
  // Update HUD text
  document.getElementById('playing-hud-text').innerHTML = `
    STATUS: CAPTURING...<br>
    STATE: ${state.toUpperCase()}
  `;
  
  // Visual countdown simulation
  let count = 0;
  const labelId = `label-${state}`;
  const labelEl = document.getElementById(labelId);
  const btn = document.getElementById(`cva-btn-${state}`);
  
  if (btn) btn.disabled = true;
  labelEl.textContent = '計算中...';
  
  const timer = setInterval(() => {
    count += 20;
    document.getElementById('playing-hud-text').innerHTML = `
      STATUS: ESTIMATING POSE ${count}%<br>
      STATE: ${state.toUpperCase()}
    `;
    
    if (count >= 100) {
      clearInterval(timer);
      
      // Generate pose data based on instrument & state
      playingRecords[state] = generateMockPoseData(state, currentProfile.instrument);
      
      labelEl.textContent = '已錄製 ✓';
      document.getElementById(`step-${state}`).classList.add('captured');
      if (btn) { btn.disabled = false; }
      
      document.getElementById('playing-hud-text').innerHTML = `
        STATUS: CAPTURE COMPLETE<br>
        STATE: ${state.toUpperCase()}<br>
        KEYPOINTS: 17 ACTIVE
      `;
      
      showToast(`「${getStateChineseName(state)}」擷取成功！`, 'success');
      
      // Check if all states are captured to render dashboard
      checkAndRenderPlayingDashboard();
    }
  }, 200);
}

function selectStep(step) {
  selectedPlayingStep = step;
  
  // Toggle card class
  document.querySelectorAll('.capture-steps .step-card').forEach(card => {
    card.classList.remove('active');
  });
  document.getElementById(`step-${step}`).classList.add('active');
}

function getStateChineseName(state) {
  if (state === 'relax') return '演奏前放鬆姿勢';
  if (state === 'prepare') return '準備演奏的姿勢';
  if (state === 'playing') return '演奏中的動作';
  return '';
}

function generateMockPoseData(state, instrument) {
  // Base healthy offsets
  let neckAngle = 10 + Math.random() * 4;
  let shoulderTilt = 1 + Math.random() * 2;
  let shoulderSymmetry = 95 + Math.random() * 4;
  let leftElbow = 80 + Math.random() * 10;
  let rightElbow = 90 + Math.random() * 10;
  let wristFlexion = 15 + Math.random() * 10;
  let spineTilt = 1 + Math.random() * 2;
  
  if (state === 'relax') {
    // Relaxed posture is highly symmetric and close to standard
    neckAngle = 8 + Math.random() * 3;
    shoulderTilt = 0.5 + Math.random() * 1.5;
    shoulderSymmetry = 97 + Math.random() * 2.5;
    leftElbow = 150 + Math.random() * 10;
    rightElbow = 150 + Math.random() * 10;
    wristFlexion = 5 + Math.random() * 5;
    spineTilt = 0.5 + Math.random() * 1;
  } 
  else if (state === 'prepare') {
    if (instrument === 'Violin') {
      neckAngle = 14 + Math.random() * 3;
      shoulderTilt = 3.5 + Math.random() * 2;
      shoulderSymmetry = 93 + Math.random() * 3;
      leftElbow = 75 + Math.random() * 8;
      rightElbow = 90 + Math.random() * 8;
      wristFlexion = 25 + Math.random() * 8;
    } else { // Cello
      neckAngle = 11 + Math.random() * 3;
      shoulderTilt = 2 + Math.random() * 1.5;
      shoulderSymmetry = 96 + Math.random() * 2.5;
      leftElbow = 100 + Math.random() * 8;
      rightElbow = 105 + Math.random() * 8;
      wristFlexion = 15 + Math.random() * 8;
    }
  } 
  else if (state === 'playing') {
    if (instrument === 'Violin') {
      // playing violin usually forces some head/neck flexion and shoulder tilt
      neckAngle = 16 + Math.random() * 5; // potential warning
      shoulderTilt = 5.2 + Math.random() * 3; // tilt!
      shoulderSymmetry = 89 + Math.random() * 5; // asymmetrical
      leftElbow = 65 + Math.random() * 12;
      rightElbow = 85 + Math.random() * 12;
      wristFlexion = 32 + Math.random() * 10;
      spineTilt = 3.5 + Math.random() * 2;
    } else { // Cello playing
      neckAngle = 12 + Math.random() * 4;
      shoulderTilt = 3.0 + Math.random() * 2;
      shoulderSymmetry = 94 + Math.random() * 4;
      leftElbow = 95 + Math.random() * 12;
      rightElbow = 110 + Math.random() * 12;
      wristFlexion = 22 + Math.random() * 8;
      spineTilt = 2.8 + Math.random() * 2;
    }
  }
  
  return {
    neckAngle,
    shoulderTilt,
    shoulderSymmetry,
    leftElbow,
    rightElbow,
    wristFlexion,
    spineTilt
  };
}

function checkAndRenderPlayingDashboard() {
  if (playingRecords.relax && playingRecords.prepare && playingRecords.playing) {
    // All 3 states recorded! Calculate and show dashboard.
    calculatePlayingResults();
    
    document.getElementById('playing-waiting-panel').style.display = 'none';
    document.getElementById('playing-results-panel').style.display = 'block';
    document.getElementById('playing-charts-grid').style.display = 'grid';
    
    renderPlayingCharts();
  }
}

function calculatePlayingResults() {
  // Aggregate scores (playing state is the key diagnostic)
  const p = playingRecords.playing;
  
  // Deductions from perfect 100
  let score = 100;
  
  // Neck angle penalty (> 15 deg is bad)
  if (p.neckAngle > 15) score -= (p.neckAngle - 15) * 1.5;
  // Shoulder tilt penalty (> 5 deg is bad)
  if (p.shoulderTilt > 5) score -= (p.shoulderTilt - 5) * 2;
  // Shoulder symmetry penalty (< 90% is bad)
  if (p.shoulderSymmetry < 90) score -= (90 - p.shoulderSymmetry) * 2;
  // Spine tilt (> 3 deg)
  if (p.spineTilt > 3) score -= (p.spineTilt - 3) * 1;
  
  score = Math.max(30, Math.min(100, Math.round(score)));
  
  // Update UI Elements
  document.getElementById('playing-score-val').textContent = score;
  
  const badge = document.getElementById('playing-score-badge');
  const ratingText = document.getElementById('playing-rating-text');
  const descText = document.getElementById('playing-result-desc');
  
  badge.className = 'score-badge-large';
  if (score >= 90) {
    badge.classList.add('optimal');
    ratingText.textContent = '姿勢評定：優良';
    descText.textContent = '您的演奏動作姿態非常優良，肩部對稱性佳，頸椎前傾度小，有助於預防職業肌肉疲勞。';
  } else if (score >= 75) {
    badge.classList.add('warning');
    ratingText.textContent = '姿勢評定：輕微偏位';
    descText.textContent = '演奏中有些微的肌肉代償，左右肩膀有些微高低肩或脊椎側傾現象，建議增加拉伸休息。';
  } else {
    badge.classList.add('danger');
    ratingText.textContent = '姿勢評定：注意警告';
    descText.textContent = '檢測到顯著的高低肩與頭部過度前傾（烏龜頸），極易造成肩頸慢性疼痛。強烈建議調整演奏坐姿與站姿，或尋求物理治療師協助。';
  }
  
  // Set metrics text and fill bars
  updateMetricBar('neck', p.neckAngle, '°', 15, true);
  updateMetricBar('shoulder-tilt', p.shoulderTilt, '°', 5, true);
  updateMetricBar('shoulder-sym', p.shoulderSymmetry, '%', 90, false);
  
  document.getElementById('val-left-elbow').textContent = `${Math.round(p.leftElbow)}°`;
  document.getElementById('bar-left-elbow').style.width = `${Math.min(100, p.leftElbow / 1.8)}%`;
  
  document.getElementById('val-right-elbow').textContent = `${Math.round(p.rightElbow)}°`;
  document.getElementById('bar-right-elbow').style.width = `${Math.min(100, p.rightElbow / 1.8)}%`;
  
  // 模擬產生動態異常姿勢及頻率 statistics
  const anomalies = [];
  if (score < 75) {
    anomalies.push({ name: '頭部過度前傾 (Forward Head)', count: Math.round(12 + Math.random() * 4), frequency: Math.round(35 + Math.random() * 10) });
    anomalies.push({ name: '聳肩/提肩 (Shoulder Shrugging)', count: Math.round(6 + Math.random() * 3), frequency: Math.round(18 + Math.random() * 6) });
    anomalies.push({ name: '駝背/圓肩 (Slouching)', count: Math.round(8 + Math.random() * 4), frequency: Math.round(25 + Math.random() * 8) });
  } else if (score < 90) {
    anomalies.push({ name: '頭部過度前傾 (Forward Head)', count: Math.round(4 + Math.random() * 3), frequency: Math.round(12 + Math.random() * 5) });
    anomalies.push({ name: '聳肩/提肩 (Shoulder Shrugging)', count: Math.round(2 + Math.random() * 2), frequency: Math.round(6 + Math.random() * 4) });
    anomalies.push({ name: '駝背/圓肩 (Slouching)', count: Math.round(3 + Math.random() * 3), frequency: Math.round(9 + Math.random() * 5) });
  } else {
    anomalies.push({ name: '頭部過度前傾 (Forward Head)', count: 0, frequency: 0 });
    anomalies.push({ name: '聳肩/提肩 (Shoulder Shrugging)', count: 1, frequency: 2 });
    anomalies.push({ name: '駝背/圓肩 (Slouching)', count: 0, frequency: 0 });
  }
  
  playingRecords.anomalies = anomalies;
  
  // Render anomalies to DOM list
  const listEl = document.getElementById('playing-anomalies-list');
  if (listEl) {
    listEl.innerHTML = '';
    anomalies.forEach(anomaly => {
      const isNormal = anomaly.count === 0;
      const barColor = isNormal ? 'var(--color-success)' : (anomaly.frequency > 20 ? 'var(--color-danger)' : 'var(--color-warning)');
      const rowEl = document.createElement('div');
      rowEl.style.cssText = 'display: flex; align-items: center; gap: 1rem; font-size: 0.85rem;';
      rowEl.innerHTML = `
        <div style="width: 170px; font-weight: 500; color: var(--text-dark);">${anomaly.name}</div>
        <div style="flex: 1; height: 8px; background-color: var(--bg-secondary); border-radius: 4px; overflow: hidden;">
          <div style="width: ${anomaly.frequency}%; height: 100%; background-color: ${barColor}; border-radius: 4px; transition: width 1s ease-out;"></div>
        </div>
        <div style="width: 90px; text-align: right; color: var(--text-secondary); font-family: monospace;">
          ${anomaly.count} 次 (${anomaly.frequency}%)
        </div>
      `;
      listEl.appendChild(rowEl);
    });
  }
}

function updateMetricBar(id, val, unit, threshold, lesserIsBetter) {
  const roundedVal = Math.round(val * 10) / 10;
  const valEl = document.getElementById(`val-${id}`);
  const barEl = document.getElementById(`bar-${id}`);
  
  valEl.textContent = `${roundedVal}${unit} (標準: ${lesserIsBetter ? '<' : '>'} ${threshold}${unit})`;
  
  // Determine color class based on threshold
  barEl.className = 'metric-bar-fill';
  
  let pct = 0;
  let status = 'success';
  
  if (lesserIsBetter) {
    pct = Math.max(10, 100 - (val / (threshold * 2)) * 100);
    if (val > threshold * 1.5) {
      status = 'danger';
    } else if (val > threshold) {
      status = 'warning';
    }
  } else { // Greater is better (e.g. symmetry)
    pct = val;
    if (val < threshold - 10) {
      status = 'danger';
    } else if (val < threshold) {
      status = 'warning';
    }
  }
  
  barEl.classList.add(status);
  barEl.style.width = `${pct}%`;
}

function resetPlayingCapture() {
  // Stop any active CVA recording
  if (cvaState.isRecording || cvaState.isCalibrating) {
    cvaState.isRecording = false;
    cvaState.isCalibrating = false;
    cvaState.activeStage = null;
    if (cvaState.camera) { cvaState.camera.stop(); cvaState.camera = null; }
    if (cvaState.stream) { cvaState.stream.getTracks().forEach(t => t.stop()); cvaState.stream = null; }

    // Restore black frame
    const video = document.getElementById('cva-video');
    const overlayCanvas = document.getElementById('cva-overlay-canvas');
    const simCanvas = document.getElementById('playingCanvas');
    if (video) { video.style.display = 'none'; video.srcObject = null; }
    if (overlayCanvas) overlayCanvas.style.display = 'none';
    if (simCanvas) simCanvas.style.display = 'block';
    const liveAngle = document.getElementById('cva-live-overlay-angle');
    const refBadge  = document.getElementById('cva-ref-badge');
    const calibOv   = document.getElementById('cva-calibration-overlay');
    if (liveAngle) liveAngle.style.display = 'none';
    if (refBadge)  refBadge.style.display  = 'none';
    if (calibOv)   calibOv.style.display   = 'none';
    const statusText = document.getElementById('video-status-text');
    const statusDot  = document.getElementById('video-overlay-dot-el');
    if (statusText) statusText.textContent = 'POSE ESTIMATOR SIMULATOR';
    if (statusDot)  statusDot.style.background = '';
  }
  // Reset CVA frame buffers
  cvaState.frameBuffers = { relax: [], prepare: [], playing: [] };

  playingRecords = { relax: null, prepare: null, playing: null };
  selectedPlayingStep = 'relax';
  
  // Reset step cards
  document.querySelectorAll('.capture-steps .step-card').forEach(card => {
    card.classList.remove('captured', 'active');
  });
  document.getElementById('step-relax').classList.add('active');
  
  ['relax', 'prepare', 'playing'].forEach(stage => {
    document.getElementById(`label-${stage}`).textContent = 'Not recorded';

    const openBtn    = document.getElementById(`cva-btn-${stage}`);
    const calibBtn   = document.getElementById(`cva-calib-btn-${stage}`);
    const calibStatus = document.getElementById(`cva-calib-status-${stage}`);
    const recBtn     = document.getElementById(`cva-rec-btn-${stage}`);
    const liveBadge  = document.getElementById(`cva-live-${stage}`);

    if (openBtn)    { openBtn.style.display = 'inline-flex'; openBtn.disabled = false; openBtn.innerHTML = '<i data-lucide="video"></i> Start Camera'; }
    if (calibBtn)   { calibBtn.style.display = 'none'; calibBtn.disabled = false; calibBtn.innerHTML = '<i data-lucide="crosshair"></i> Calibrate Zero'; }
    if (calibStatus) calibStatus.style.display = 'none';
    if (recBtn)     { recBtn.style.display = 'none'; recBtn.style.background = ''; recBtn.style.borderColor = ''; recBtn.innerHTML = '<i data-lucide="circle"></i> Start Recording'; }
    if (liveBadge)  liveBadge.style.display = 'none';
  });
  // Also reset referenceAngle so next session starts fresh
  cvaState.referenceAngle = null;
  lucide.createIcons();

  document.getElementById('playing-waiting-panel').style.display = 'flex';
  document.getElementById('playing-results-panel').style.display = 'none';
  document.getElementById('playing-charts-grid').style.display = 'none';
  
  document.getElementById('playing-hud-text').innerHTML = `
    STATUS: WAITING FOR CAPTURE<br>
    KEYPOINTS: 0 ACTIVE
  `;
  
  if (playingRadarChartRef) playingRadarChartRef.destroy();
  if (playingSymmetryChartRef) playingSymmetryChartRef.destroy();
  if (cvaTrendChartRef) { cvaTrendChartRef.destroy(); cvaTrendChartRef = null; }
  
  showToast('Assessment flow has been reset.', 'info');
}

// ----------------------------------------------------
// 5. CHART RENDERING
// ----------------------------------------------------
function renderPlayingCharts() {
  const relax = playingRecords.relax;
  const prep = playingRecords.prepare;
  const play = playingRecords.playing;
  
  if (!relax || !prep || !play) return;
  
  // 1. Line Chart Setup (Comparing joint angles across states)
  const radarCtx = document.getElementById('playingRadarChart').getContext('2d');
  if (playingRadarChartRef) playingRadarChartRef.destroy();
  
  playingRadarChartRef = new Chart(radarCtx, {
    type: 'line',
    data: {
      labels: ['1. Relax', '2. Prepare', '3. Playing'],
      datasets: [
        {
          label: '頸椎前傾角 (°)',
          data: [relax.neckAngle, prep.neckAngle, play.neckAngle],
          borderColor: '#8D6B61',
          backgroundColor: 'rgba(141, 107, 97, 0.1)',
          borderWidth: 3,
          tension: 0.2,
          pointRadius: 4
        },
        {
          label: '雙肩傾斜度 (°)',
          data: [relax.shoulderTilt, prep.shoulderTilt, play.shoulderTilt],
          borderColor: '#82898D',
          backgroundColor: 'rgba(130, 137, 141, 0.1)',
          borderWidth: 3,
          tension: 0.2,
          pointRadius: 4
        },
        {
          label: '左手肘夾角 (°)',
          data: [relax.leftElbow, prep.leftElbow, play.leftElbow],
          borderColor: '#A1B0AD',
          backgroundColor: 'rgba(161, 176, 173, 0.1)',
          borderWidth: 3,
          tension: 0.2,
          pointRadius: 4
        },
        {
          label: '右手肘夾角 (°)',
          data: [relax.rightElbow, prep.rightElbow, play.rightElbow],
          borderColor: '#C0B0A2',
          backgroundColor: 'rgba(192, 176, 162, 0.1)',
          borderWidth: 3,
          tension: 0.2,
          pointRadius: 4
        },
        {
          label: '脊椎傾斜度 (°)',
          data: [relax.spineTilt, prep.spineTilt, play.spineTilt],
          borderColor: '#C39289',
          backgroundColor: 'rgba(195, 146, 137, 0.1)',
          borderWidth: 3,
          tension: 0.2,
          pointRadius: 4
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: {
          grid: { color: 'rgba(130, 137, 141, 0.1)' },
          ticks: { color: '#82898D' }
        },
        x: {
          grid: { display: false },
          ticks: { color: '#82898D', font: { family: 'Noto Sans TC' } }
        }
      },
      plugins: {
        legend: { labels: { color: '#3A3533', font: { family: 'Noto Sans TC' } } }
      }
    }
  });

  // 2. Line Chart for symmetry percentage
  const barCtx = document.getElementById('playingSymmetryChart').getContext('2d');
  if (playingSymmetryChartRef) playingSymmetryChartRef.destroy();
  
  playingSymmetryChartRef = new Chart(barCtx, {
    type: 'line',
    data: {
      labels: ['1. Relax', '2. Prepare', '3. Playing'],
      datasets: [
        {
          label: 'Shoulder Symmetry (%)',
          data: [relax.shoulderSymmetry, prep.shoulderSymmetry, play.shoulderSymmetry],
          borderColor: '#C6CCC0',
          backgroundColor: 'rgba(198, 204, 192, 0.2)',
          borderWidth: 4,
          tension: 0.15,
          fill: true,
          pointRadius: 6,
          pointBackgroundColor: '#C6CCC0',
          pointBorderColor: '#fff',
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: {
          min: 50,
          max: 100,
          grid: { color: 'rgba(130, 137, 141, 0.1)' },
          ticks: { color: '#82898D' }
        },
        x: {
          grid: { display: false },
          ticks: { color: '#82898D', font: { family: 'Noto Sans TC' } }
        }
      },
      plugins: {
        legend: { display: false }
      }
    }
  });

  // 3. CVA trend chart
  renderCvaChart();

/**
 * Render CVA per-frame line chart (equivalent to visualize_fhp.py generate_fhp_report).
 * Three datasets (relax / prepare / playing) concatenated with stage separators.
 * Red background bands mark frames where CVA < CVA_THRESHOLD (60°).
 */
function renderCvaChart() {
  const r = playingRecords.relax?.cva;
  const p = playingRecords.prepare?.cva;
  const pl = playingRecords.playing?.cva;

  // Hide chart card if no CVA data at all
  const card = document.getElementById('cva-chart-card');
  if (!r && !p && !pl) { if (card) card.style.display = 'none'; return; }
  if (card) card.style.display = 'block';

  if (cvaTrendChartRef) cvaTrendChartRef.destroy();

  // Build per-stage datasets; x-axis is a unified frame index with stage labels
  const labels = [];
  const relaxData = [], prepData = [], playData = [];

  const buildDataset = (cva, stageLabel, offset) => {
    if (!cva) return offset;
    cva.frames.forEach((angle, i) => {
      if (i === 0) labels.push(stageLabel);
      else if (i === Math.floor(cva.frames.length / 2)) labels.push(`${stageLabel} 中`);
      else labels.push('');
    });
    return offset + cva.frames.length;
  };

  let offset = 0;
  offset = buildDataset(r, '① Relax', offset);
  const relaxEnd = offset;
  offset = buildDataset(p, '② Prepare', offset);
  const prepEnd = offset;
  buildDataset(pl, '③ Playing', offset);

  // Fill arrays with null outside their own range
  const total = labels.length;
  let ri = 0, pi = relaxEnd, pli = prepEnd;
  for (let i = 0; i < total; i++) {
    relaxData.push(i < relaxEnd ? (r?.frames[ri++] ?? null) : null);
    prepData.push(i >= relaxEnd && i < prepEnd ? (p?.frames[pi++ - relaxEnd] ?? null) : null);
    playData.push(i >= prepEnd ? (pl?.frames[pli++ - prepEnd] ?? null) : null);
  }

  // Background plugin to draw red bands for delta < -10° (forward lean)
  const warningBandPlugin = {
    id: 'cvaWarningBands',
    beforeDraw(chart) {
      const { ctx, chartArea: { top, bottom }, scales: { x, y } } = chart;
      if (!x || !y) return;
      ctx.save();
      const allFrames = [
        ...(r?.frames || []).map((d, i) => ({ i, d })),
        ...(p?.frames || []).map((d, i) => ({ i: i + relaxEnd, d })),
        ...(pl?.frames || []).map((d, i) => ({ i: i + prepEnd, d })),
      ];
      let inBand = false, bandStart = 0;
      ctx.fillStyle = 'rgba(195,146,137,0.18)';
      allFrames.forEach(({ i, d }) => {
        const xPos = x.getPixelForValue(i);
        if (d < -10 && !inBand) { bandStart = xPos; inBand = true; }
        else if (d >= -10 && inBand) {
          ctx.fillRect(bandStart, top, xPos - bandStart, bottom - top); inBand = false;
        }
      });
      if (inBand) {
        const lastX = x.getPixelForValue(total - 1);
        ctx.fillRect(bandStart, top, lastX - bandStart, bottom - top);
      }
      // Threshold dashed line at -10°
      const yPos = chart.scales.y.getPixelForValue(-10);
      ctx.strokeStyle = 'rgba(195,146,137,0.7)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(chart.chartArea.left, yPos); ctx.lineTo(chart.chartArea.right, yPos); ctx.stroke();
      // Zero reference line
      const y0 = chart.scales.y.getPixelForValue(0);
      ctx.strokeStyle = 'rgba(161,176,173,0.5)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(chart.chartArea.left, y0); ctx.lineTo(chart.chartArea.right, y0); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
  };

  const ctx = document.getElementById('cvaTrendChart').getContext('2d');
  cvaTrendChartRef = new Chart(ctx, {
    type: 'line',
    plugins: [warningBandPlugin],
    data: {
      labels,
      datasets: [
        {
          label: 'Relax CVA (°)',
          data: relaxData,
          borderColor: '#A1B0AD',
          backgroundColor: 'rgba(161,176,173,0.08)',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.2,
          spanGaps: false
        },
        {
          label: 'Prepare CVA (°)',
          data: prepData,
          borderColor: '#8D6B61',
          backgroundColor: 'rgba(141,107,97,0.08)',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.2,
          spanGaps: false
        },
        {
          label: 'Playing CVA (°)',
          data: playData,
          borderColor: '#C39289',
          backgroundColor: 'rgba(195,146,137,0.08)',
          borderWidth: 2.5,
          pointRadius: 0,
          tension: 0.2,
          spanGaps: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 600 },
      scales: {
        y: {
          min: -40,
          max: 40,
          grid: { color: 'rgba(130,137,141,0.1)' },
          ticks: { color: '#82898D', callback: v => `${v > 0 ? '+' : ''}${v}°` }
        },
        x: {
          grid: { display: false },
          ticks: {
            color: '#82898D',
            maxRotation: 0,
            font: { family: 'Noto Sans TC', size: 10 },
            autoSkip: false,
            callback(val, idx) { return labels[idx] || ''; }
          }
        }
      },
      plugins: {
        legend: { labels: { color: '#3A3533', font: { family: 'Noto Sans TC', size: 11 }, boxWidth: 16 } },
        tooltip: {
          callbacks: {
            label: ctx => `CVA Δ: ${ctx.raw >= 0 ? '+' : ''}${ctx.raw?.toFixed(1)}°`,
            afterLabel: ctx => ctx.raw < -10 ? '⚠ Forward lean exceeds threshold' : ''
          }
        }
      }
    }
  });

  // Render summary stat chips below chart (mirrors above_pct print in visualize_fhp.py)
  const statsRow = document.getElementById('cva-stats-row');
  if (statsRow) {
    const makeChip = (label, value, sub, color) => `
      <div style="background:var(--bg-secondary);border-radius:8px;padding:0.6rem 1rem;min-width:110px;border-left:3px solid ${color};">
        <div style="font-size:0.7rem;color:var(--text-secondary);margin-bottom:0.15rem;">${label}</div>
        <div style="font-size:1.1rem;font-weight:700;color:var(--text-primary);font-family:monospace;">${value}</div>
        <div style="font-size:0.7rem;color:var(--text-secondary);">${sub}</div>
      </div>`;
    const stages = [
      { key: 'relax', label: 'Relax', cva: r, color: '#A1B0AD' },
      { key: 'prepare', label: 'Prepare', cva: p, color: '#8D6B61' },
      { key: 'playing', label: 'Playing', cva: pl, color: '#C39289' }
    ];
    statsRow.innerHTML = stages
      .filter(s => s.cva)
      .map(s => {
        const warn = s.cva.abovePct > 0 ? `⚠ ${s.cva.abovePct}% 超過警戒` : '✓ No significant lean';
        const sign = s.cva.avg >= 0 ? '+' : '';
        return makeChip(
          `${s.label} — avg CVA Δ`,
          `${sign}${s.cva.avg.toFixed(1)}°`,
          warn,
          s.cva.abovePct > 0 ? '#C39289' : '#C6CCC0'
        );
      })
      .join('');
  }
}
function selectDiag(diagId) {
  selectedDiagnostic = diagId;
  
  // Toggle UI
  document.querySelectorAll('.diag-selector-grid .diag-option').forEach(opt => {
    opt.classList.remove('active');
  });
  document.getElementById(`diag-${diagId}`).classList.add('active');
  
  // Change overlay title
  const overlayTitle = document.getElementById('static-overlay-title');
  const hudText = document.getElementById('static-hud-text');
  
  if (diagId === 'uneven-shoulders') {
    overlayTitle.textContent = 'Uneven Shoulders — Simulating';
    hudText.innerHTML = 'STATUS: WAITING TO DIAGNOSE<br>DIAGNOSTIC: UNEVEN SHOULDERS';
  } else if (diagId === 'forward-head') {
    overlayTitle.textContent = 'Forward Head Posture — Simulating';
    hudText.innerHTML = 'STATUS: WAITING TO DIAGNOSE<br>DIAGNOSTIC: FORWARD HEAD';
  } else if (diagId === 'arm-raise') {
    overlayTitle.textContent = 'Arm Raise Test — Simulating';
    hudText.innerHTML = 'STATUS: WAITING TO DIAGNOSE<br>DIAGNOSTIC: ARM RAISE TEST';
  }
}

function startStaticDiagnosis() {
  if (!currentProfile) {
    showToast('請先完成個資填寫再進行診斷！', 'warning');
    switchSection('profile');
    return;
  }
  
  isDiagnosingStatic = true;
  document.getElementById('btn-start-static').disabled = true;
  document.getElementById('btn-reset-static').disabled = true;
  
  let countdown = 3;
  const overlay = document.getElementById('static-hud-text');
  
  const timer = setInterval(() => {
    overlay.innerHTML = `
      STATUS: DIAGNOSING IN ${countdown}...<br>
      KEEP POSE STEADY
    `;
    
    countdown--;
    
    if (countdown < 0) {
      clearInterval(timer);
      
      overlay.innerHTML = `
        STATUS: ANALYZING IMAGE...<br>
        EXTRACTING POINT VECTORS
      `;
      
      setTimeout(() => {
        // Complete diagnosis
        renderStaticDiagnosticResult();
        
        document.getElementById('btn-start-static').disabled = false;
        document.getElementById('btn-reset-static').disabled = false;
        
        showToast('靜態姿勢Diagnosis complete！', 'success');
      }, 1000);
    }
  }, 1000);
}

// Global cached result for saving
let currentStaticResult = null;

function renderStaticDiagnosticResult() {
  const panelWait = document.getElementById('static-waiting-panel');
  const panelRes = document.getElementById('static-results-panel');
  
  panelWait.style.display = 'none';
  panelRes.style.display = 'block';
  
  const scoreVal = document.getElementById('static-score-val');
  const scoreLabel = document.getElementById('static-score-label');
  const ratingText = document.getElementById('static-rating-text');
  const descText = document.getElementById('static-result-desc');
  const badge = document.getElementById('static-score-badge');
  const adviceText = document.getElementById('static-advice-text');
  
  const detailsTitle = document.getElementById('static-details-title');
  const m1Name = document.getElementById('static-m1-name');
  const m1Val = document.getElementById('static-m1-val');
  const m1Bar = document.getElementById('static-m1-bar');
  
  const m2Name = document.getElementById('static-m2-name');
  const m2Val = document.getElementById('static-m2-val');
  const m2Bar = document.getElementById('static-m2-bar');
  
  // Set different values and text based on type
  badge.className = 'score-badge-large';
  
  const rNum = Math.random(); // Add variance
  
  if (selectedDiagnostic === 'uneven-shoulders') {
    const heightDiff = (1.2 + rNum * 0.5).toFixed(1); // 1.2 to 1.7 cm
    const angle = (4.2 + rNum * 1.5).toFixed(1); // deg
    const symmetry = Math.round(86 + rNum * 4); // 86% to 90%
    
    scoreVal.textContent = symmetry;
    scoreLabel.textContent = 'Symmetry Score';
    
    detailsTitle.textContent = '高低肩檢測指標數值';
    m1Name.textContent = '雙肩水平高度差';
    m1Val.textContent = `${heightDiff} cm (標準 < 1.0 cm)`;
    m1Bar.style.width = `${Math.max(10, 100 - heightDiff * 45)}%`;
    m1Bar.className = 'metric-bar-fill warning';
    
    m2Name.textContent = '左右肩峰斜率夾角';
    m2Val.textContent = `${angle}° (標準 < 3.0°)`;
    m2Bar.style.width = `${Math.max(10, 100 - angle * 12)}%`;
    m2Bar.className = 'metric-bar-fill warning';
    
    badge.classList.add('warning');
    ratingText.textContent = '評定：輕微高低肩';
    descText.textContent = `您的右側肩峰線比左側偏低約 ${heightDiff} cm。可能為演奏習慣（單側偏重）造成的提肩胛肌及斜方肌張力不平衡。`;
    
    adviceText.textContent = '建議每日練習前進行 10 分鐘「落肩伸展操」，並避免長時間維持提琴姿勢。演奏大提琴時，確保大提琴琴身中央對齊胸骨，避免傾斜上半身遷就琴體。';
    
    currentStaticResult = {
      score: symmetry,
      projectName: '高低肩檢測',
      level: 'Caution',
      details: `右側肩峰偏低 ${heightDiff}cm，雙肩夾角 ${angle}°`
    };
  } 
  else if (selectedDiagnostic === 'forward-head') {
    const angle = (22.4 + rNum * 4).toFixed(1); // 22.4 to 26.4 deg
    const score = Math.round(100 - (angle - 15) * 2.5); // 70 to 80
    
    scoreVal.textContent = Math.round(score);
    scoreLabel.textContent = '姿勢評分';
    
    detailsTitle.textContent = '頭部前傾檢測指標';
    m1Name.textContent = '耳垂至肩峰水平距離';
    m1Val.textContent = `${(angle * 0.15).toFixed(1)} cm (標準 < 2.5 cm)`;
    m1Bar.style.width = `${Math.max(10, 100 - angle * 2.5)}%`;
    m1Bar.className = 'metric-bar-fill danger';
    
    m2Name.textContent = '頸椎鉛垂線夾角';
    m2Val.textContent = `${angle}° (標準 < 15.0°)`;
    m2Bar.style.width = `${Math.max(10, 100 - angle * 3)}%`;
    m2Bar.className = 'metric-bar-fill danger';
    
    badge.classList.add('danger');
    ratingText.textContent = '評定：顯著前傾 (烏龜頸)';
    descText.textContent = `您的頸椎前傾夾角達 ${angle}°，長期以此姿勢看譜或演奏，會對頸椎關節與上背部肌群造成三倍的負荷。`;
    
    adviceText.textContent = '請調整譜架至與視線水平高度，避免低頭看譜。日常可進行「收下巴運動」（Chin Tucks）：保持視線水平，向後平行收縮下巴，每次停留 5 秒，重複 10 次以鍛鍊頸椎深層穩定肌群。';
    
    currentStaticResult = {
      score: Math.round(score),
      projectName: '頭部前傾檢測',
      level: 'Alert',
      details: `頸部前傾角 ${angle}°，水偏移 ${(angle * 0.15).toFixed(1)}cm`
    };
  } 
  else if (selectedDiagnostic === 'arm-raise') {
    const lAngle = Math.round(170 + rNum * 5); // 170 to 175 (Good)
    const rAngle = Math.round(135 + rNum * 10); // 135 to 145 (Restricted)
    const score = Math.round((lAngle + rAngle) / 2 - 60); // 90ish
    
    scoreVal.textContent = score;
    scoreLabel.textContent = '活動度分數';
    
    detailsTitle.textContent = '抬手活動度指標';
    m1Name.textContent = '左側肩關節屈曲角度';
    m1Val.textContent = `${lAngle}° (正常活動度 > 165°)`;
    m1Bar.style.width = `${(lAngle / 180) * 100}%`;
    m1Bar.className = 'metric-bar-fill success';
    
    m2Name.textContent = '右側肩關節屈曲角度';
    m2Val.textContent = `${rAngle}° (正常活動度 > 165°)`;
    m2Bar.style.width = `${(rAngle / 180) * 100}%`;
    m2Bar.className = 'metric-bar-fill warning';
    
    badge.classList.add('warning');
    ratingText.textContent = '評定：右肩活動受限';
    descText.textContent = `您的左手能正常上舉，但右手在舉高過頭時，角度受限於 ${rAngle}°，且伴隨輕微的斜肩代償。這可能是肩胛下肌或肩袖肌群緊繃引起。`;
    
    adviceText.textContent = '右手持弓或拉琴長期處於內旋位置，應加強「肩關節外旋拉伸」。站立於牆邊，曲肘 90 度，手臂貼牆壁做水平外展，拉伸胸大肌與肩前側肌肉。每次拉伸 20 秒。';
    
    currentStaticResult = {
      score: score,
      projectName: '抬手檢測',
      level: 'Caution',
      details: `左肩上舉 ${lAngle}°，右肩上舉 ${rAngle}°`
    };
  }
  
  document.getElementById('static-hud-text').innerHTML = `
    STATUS: ANALYSIS DONE<br>
    DIAGNOSTIC: ${selectedDiagnostic.toUpperCase()}<br>
    SCORE: ${scoreVal.textContent}
  `;
}

function resetStaticDiagnosis() {
  document.getElementById('static-waiting-panel').style.display = 'flex';
  document.getElementById('static-results-panel').style.display = 'none';
  document.getElementById('btn-reset-static').disabled = true;
  
  const text = selectedDiagnostic === 'uneven-shoulders' ? 'UNEVEN SHOULDERS' : (selectedDiagnostic === 'forward-head' ? 'FORWARD HEAD' : 'ARM RAISE TEST');
  document.getElementById('static-hud-text').innerHTML = `
    STATUS: WAITING TO DIAGNOSE<br>
    DIAGNOSTIC: ${text}
  `;
  
  currentStaticResult = null;
  showToast('診斷已重置，可重新開始檢測。', 'info');
}

// ----------------------------------------------------
// 7. DATA PERSISTENCE & HISTORY LIST
// ----------------------------------------------------
function savePlayingRecord() {
  if (!currentProfile) return;
  if (!playingRecords.relax || !playingRecords.prepare || !playingRecords.playing) return;
  
  const score = parseInt(document.getElementById('playing-score-val').textContent);
  let level = 'Good';
  if (score < 75) level = 'Alert';
  else if (score < 90) level = 'Caution';
  
  const p = playingRecords.playing;

  // Build CVA summary for storage (compact: store frames + stats per stage)
  const cvaSummary = {};
  ['relax', 'prepare', 'playing'].forEach(stage => {
    const cva = playingRecords[stage]?.cva;
    if (cva) cvaSummary[stage] = cva; // includes frames[], avg, min, max, abovePct
  });
  
  const newRecord = {
    id: Date.now(),
    timestamp: new Date().toLocaleString('zh-TW', { hour12: false }),
    username: currentProfile.username,
    instrument: currentProfile.instrument,
    type: 'playing',
    projectName: 'Playing Assessment',
    score: score,
    level: level,
    details: {
      neckAngle: p.neckAngle,
      shoulderTilt: p.shoulderTilt,
      shoulderSymmetry: p.shoulderSymmetry,
      leftElbow: p.leftElbow,
      rightElbow: p.rightElbow,
      wristFlexion: p.wristFlexion,
      spineTilt: p.spineTilt,
      anomalies: playingRecords.anomalies || [],
      cva: Object.keys(cvaSummary).length > 0 ? cvaSummary : null,
      raw: playingRecords
    }
  };
  
  const records = getHistoryFromStorage();
  records.unshift(newRecord);
  saveHistoryToStorage(records);
  
  showToast('Playing assessment saved to history successfully.', 'success');
  resetPlayingCapture();
  setTimeout(() => { switchSection('history'); }, 500);
}

function saveStaticRecord() {
  if (!currentProfile || !currentStaticResult) return;
  
  const newRecord = {
    id: Date.now(),
    timestamp: new Date().toLocaleString('zh-TW', { hour12: false }),
    username: currentProfile.username,
    instrument: currentProfile.instrument,
    type: 'static',
    projectName: currentStaticResult.projectName,
    score: currentStaticResult.score,
    level: currentStaticResult.level,
    details: {
      textSummary: currentStaticResult.details,
      diagnosticType: selectedDiagnostic
    }
  };
  
  const records = getHistoryFromStorage();
  records.unshift(newRecord);
  saveHistoryToStorage(records);
  
  showToast('靜態動作診斷紀錄已成功儲存！', 'success');
  
  resetStaticDiagnosis();
  
  setTimeout(() => {
    switchSection('history');
  }, 500);
}

function getHistoryFromStorage() {
  const data = localStorage.getItem('musician_records');
  return data ? JSON.parse(data) : [];
}

function saveHistoryToStorage(records) {
  localStorage.setItem('musician_records', JSON.stringify(records));
  updateHistoryTable();
  updateDashboardStats();
}

function updateHistoryTable(filteredRecords = null) {
  const records = filteredRecords || getHistoryFromStorage();
  const tbody = document.getElementById('history-table-body');
  
  // Reset select-all state
  const checkAll = document.getElementById('check-all-records');
  if (checkAll) checkAll.checked = false;
  selectedRecordIds.clear();
  updateComparisonButton();
  
  if (records.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" style="text-align: center; color: var(--text-secondary); padding: 3rem;">
          <i data-lucide="inbox" style="width: 48px; height: 48px; margin: 0 auto 0.5rem auto; opacity: 0.5; display: block;"></i>
          查無歷史評估紀錄。請填寫個資並開始進行評估！
        </td>
      </tr>
    `;
    lucide.createIcons();
    return;
  }
  
  tbody.innerHTML = '';
  
  records.forEach(r => {
    const row = document.createElement('tr');
    
    // Status Badge
    let lvlClass = 'badge-success';
    if (r.level === 'Caution') lvlClass = 'badge-warning';
    if (r.level === 'Alert') lvlClass = 'badge-danger';
    
    // Project type label
    const typeLabel = r.type === 'playing' ? '演奏動作' : '靜態檢測';
    
    row.innerHTML = `
      <td style="text-align: center; vertical-align: middle;">
        <input type="checkbox" class="record-checkbox" data-id="${r.id}" onchange="toggleRecordSelection(${r.id}, this.checked)" style="width: 16px; height: 16px; cursor: pointer;">
      </td>
      <td>${r.timestamp}</td>
      <td><strong>${r.username}</strong></td>
      <td><span class="badge badge-info">${r.instrument}</span></td>
      <td>${typeLabel}</td>
      <td>
        <div style="font-weight:600;">${r.projectName}</div>
        <div style="font-size:0.75rem; color:var(--text-secondary);">${r.type === 'static' ? r.details.textSummary : `綜合健康分數: ${r.score}`}</div>
      </td>
      <td><span class="badge ${lvlClass}">${r.level}</span></td>
      <td class="actions-cell">
        <button class="btn btn-outline" style="padding: 0.35rem 0.75rem; font-size: 0.75rem;" onclick="viewHistoryDetail(${r.id})">
          <i data-lucide="eye" style="width: 14px; height: 14px;"></i> View
        </button>
        <button class="btn btn-outline" style="padding: 0.35rem 0.75rem; font-size: 0.75rem; color:var(--color-danger); border-color:rgba(195,146,137,0.4);" onclick="deleteHistoryRecord(${r.id})">
          <i data-lucide="trash-2" style="width: 14px; height: 14px;"></i>
        </button>
      </td>
    `;
    
    tbody.appendChild(row);
  });
  
  lucide.createIcons();
}

function filterHistory() {
  const searchVal = document.getElementById('search-name').value.toLowerCase().trim();
  const instVal = document.getElementById('filter-instrument').value;
  const typeVal = document.getElementById('filter-type').value;
  
  const allRecords = getHistoryFromStorage();
  
  const filtered = allRecords.filter(r => {
    const matchesSearch = r.username.toLowerCase().includes(searchVal) || r.projectName.toLowerCase().includes(searchVal);
    const matchesInst = instVal === 'All' || r.instrument === instVal;
    const matchesType = typeVal === 'All' || r.type === typeVal;
    return matchesSearch && matchesInst && matchesType;
  });
  
  updateHistoryTable(filtered);
}

function deleteHistoryRecord(id) {
  if (confirm('確定要Delete這筆評估紀錄嗎？')) {
    const records = getHistoryFromStorage();
    const updated = records.filter(r => r.id !== id);
    saveHistoryToStorage(updated);
    showToast('紀錄已成功Delete。', 'info');
  }
}

function clearAllHistory() {
  if (confirm('⚠️ 警告：確定要清空所有的歷史評估紀錄嗎？此動作無法復原！')) {
    saveHistoryToStorage([]);
    showToast('歷史紀錄已全部清空。', 'warning');
  }
}

// ----------------------------------------------------
// 8. DETAIL VIEW MODAL
// ----------------------------------------------------
function viewHistoryDetail(id) {
  const records = getHistoryFromStorage();
  const r = records.find(item => item.id === id);
  if (!r) return;
  
  const modal = document.getElementById('detail-modal');
  const content = document.getElementById('modal-content');
  
  modal.style.display = 'flex';
  
  if (r.type === 'playing') {
    const p = r.details;
    content.innerHTML = `
      <div style="margin-bottom: 1.5rem;">
        <span class="badge badge-info" style="font-size: 0.85rem; margin-bottom: 0.5rem;">演奏動作評估</span>
        <h2 style="color: var(--text-primary); font-size: 1.5rem;">${r.username} 的詳細動作報告</h2>
        <p style="color: var(--text-secondary); font-size: 0.85rem;">評估時間: ${r.timestamp} | 樂器: ${r.instrument}</p>
      </div>
      
      <div class="grid-2" style="margin-bottom: 1.5rem;">
        <div class="card" style="display:flex; flex-direction:column; align-items:center; justify-content:center;">
          <div class="score-badge-large ${r.score >= 90 ? 'optimal' : (r.score >= 75 ? 'warning' : 'danger')}">
            <span class="score-value">${r.score}</span>
            <span class="score-label">健康度評分</span>
          </div>
          <h3 style="color: var(--text-primary); margin-top: 1rem;">姿勢狀態: ${r.level}</h3>
        </div>
        
        <div class="card">
          <h4 style="color: var(--text-primary); margin-bottom: 0.75rem;">量測點位細節 (演奏中)</h4>
          <ul style="list-style:none; display:flex; flex-direction:column; gap:0.5rem; font-size:0.9rem;">
            <li><strong>頸椎前傾角度</strong>: ${Math.round(p.neckAngle)}° (標準 < 15°)</li>
            <li><strong>雙肩傾斜度</strong>: ${Math.round(p.shoulderTilt)}° (標準 < 5°)</li>
            <li><strong>左右肩對稱程度</strong>: ${Math.round(p.shoulderSymmetry)}% (標準 > 90%)</li>
            <li><strong>左肘夾角 / 右肘夾角</strong>: ${Math.round(p.leftElbow)}° / ${Math.round(p.rightElbow)}°</li>
            <li><strong>手腕彎曲度 / 脊椎傾斜</strong>: ${Math.round(p.wristFlexion)}° / ${Math.round(p.spineTilt)}°</li>
          </ul>
        </div>
      </div>
      
      <div class="grid-2">
        <div class="card">
          <h4 style="color: var(--text-primary); margin-bottom: 0.5rem;">Three-State Joint Angle Chart</h4>
          <div style="height: 250px; position:relative;">
            <canvas id="modalRadarChart"></canvas>
          </div>
        </div>
        <div class="card">
          <h4 style="color: var(--text-primary); margin-bottom: 0.5rem;">Shoulder Symmetry Chart</h4>
          <div style="height: 250px; position:relative;">
            <canvas id="modalSymmetryChart"></canvas>
          </div>
        </div>
      </div>

      ${p.cva ? `
      <div class="card" style="margin-top:1.5rem;">
        <div class="card-header">
          <div class="card-title" style="font-size:0.95rem;">
            <i data-lucide="scan-face"></i> CVA Per-Frame Chart (3 Stages)
          </div>
        </div>
        <div style="height:220px; position:relative;">
          <canvas id="modalCvaChart"></canvas>
        </div>
        <div style="display:flex; gap:1rem; margin-top:0.75rem; flex-wrap:wrap;" id="modal-cva-stats">
        </div>
        <p style="font-size:0.75rem;color:var(--text-secondary);margin-top:0.5rem;">
          紅色色帶區間表示 CVA &lt; 60°（頭部前傾警戒）。角度越小，頸椎承受壓力越大。
        </p>
      </div>
      ` : ''}
    `;
    
    // We must wait a tiny bit for the DOM elements inside the modal to render before building charts
    setTimeout(() => {
      const raw = p.raw;
      const modalRadarCtx = document.getElementById('modalRadarChart').getContext('2d');
      new Chart(modalRadarCtx, {
        type: 'line',
        data: {
          labels: ['1. Relax', '2. Prepare', '3. Playing'],
          datasets: [
            {
              label: '頸椎前傾角 (°)',
              data: [raw.relax.neckAngle, raw.prep.neckAngle, p.neckAngle],
              borderColor: '#8D6B61',
              backgroundColor: 'rgba(141, 107, 97, 0.1)',
              borderWidth: 3
            },
            {
              label: '雙肩傾斜度 (°)',
              data: [raw.relax.shoulderTilt, raw.prep.shoulderTilt, p.shoulderTilt],
              borderColor: '#82898D',
              backgroundColor: 'rgba(130, 137, 141, 0.1)',
              borderWidth: 3
            },
            {
              label: '左手肘夾角 (°)',
              data: [raw.relax.leftElbow, raw.prep.leftElbow, p.leftElbow],
              borderColor: '#A1B0AD',
              backgroundColor: 'rgba(161, 176, 173, 0.1)',
              borderWidth: 3
            },
            {
              label: '右手肘夾角 (°)',
              data: [raw.relax.rightElbow, raw.prep.rightElbow, p.rightElbow],
              borderColor: '#C0B0A2',
              backgroundColor: 'rgba(192, 176, 162, 0.1)',
              borderWidth: 3
            },
            {
              label: '脊椎傾斜度 (°)',
              data: [raw.relax.spineTilt, raw.prep.spineTilt, p.spineTilt],
              borderColor: '#C39289',
              backgroundColor: 'rgba(195, 146, 137, 0.1)',
              borderWidth: 3
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            y: { grid: { color: 'rgba(130, 137, 141, 0.1)' } }
          }
        }
      });
      
      const modalSymmetryCtx = document.getElementById('modalSymmetryChart').getContext('2d');
      new Chart(modalSymmetryCtx, {
        type: 'line',
        data: {
          labels: ['Relax', 'Prepare', 'Playing'],
          datasets: [{
            label: 'Shoulder Symmetry (%)',
            data: [raw.relax.shoulderSymmetry, raw.prep.shoulderSymmetry, p.shoulderSymmetry],
            borderColor: '#C6CCC0',
            backgroundColor: 'rgba(198, 204, 192, 0.2)',
            borderWidth: 3,
            fill: true,
            pointRadius: 5
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: { y: { min: 50, max: 100 } }
        }
      });

      // CVA modal chart — rendered only when real CVA data was recorded
      if (p.cva && document.getElementById('modalCvaChart')) {
        const cvaData = p.cva;
        const stageColors = { relax: '#A1B0AD', prepare: '#8D6B61', playing: '#C39289' };
        const stageLabels = { relax: '① Relax', prepare: '② Prepare', playing: '③ Playing' };
        const allLabels = [];
        const datasets = [];

        let offset = 0;
        ['relax', 'prepare', 'playing'].forEach(stage => {
          const stageCva = cvaData[stage];
          if (!stageCva) return;
          const stageData = new Array(allLabels.length).fill(null);
          stageCva.frames.forEach((angle, i) => {
            allLabels.push(i === 0 ? stageLabels[stage] : (i === Math.floor(stageCva.frames.length / 2) ? `${stageLabels[stage]} 中` : ''));
            stageData.push(angle);
          });
          // Pad earlier datasets
          datasets.forEach(ds => { while (ds.data.length < allLabels.length) ds.data.push(null); });
          datasets.push({
            label: `${stageLabels[stage]} CVA`,
            data: stageData,
            borderColor: stageColors[stage],
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.2,
            spanGaps: false
          });
          offset += stageCva.frames.length;
        });

        const cvaWarnPlugin = {
          id: 'modalCvaWarnBands',
          beforeDraw(chart) {
            const { ctx, chartArea: { top, bottom }, scales: { x, y } } = chart;
            if (!x || !y) return;
            ctx.save();
            // Threshold line
            const yPos = y.getPixelForValue(CVA_THRESHOLD);
            ctx.strokeStyle = 'rgba(195,146,137,0.7)'; ctx.lineWidth = 1.5;
            ctx.setLineDash([6,4]);
            ctx.beginPath(); ctx.moveTo(chart.chartArea.left, yPos); ctx.lineTo(chart.chartArea.right, yPos); ctx.stroke();
            ctx.setLineDash([]);
            // Red bands
            ctx.fillStyle = 'rgba(195,146,137,0.15)';
            let inBand = false, bandStart = 0;
            allLabels.forEach((_, i) => {
              const allAngles = datasets.map(ds => ds.data[i]).filter(v => v !== null);
              if (!allAngles.length) return;
              const angle = allAngles[0];
              const xPos = x.getPixelForValue(i);
              if (angle < CVA_THRESHOLD && !inBand) { bandStart = xPos; inBand = true; }
              else if (angle >= CVA_THRESHOLD && inBand) { ctx.fillRect(bandStart, top, xPos - bandStart, bottom - top); inBand = false; }
            });
            if (inBand) { const lx = x.getPixelForValue(allLabels.length - 1); ctx.fillRect(bandStart, top, lx - bandStart, bottom - top); }
            ctx.restore();
          }
        };

        new Chart(document.getElementById('modalCvaChart').getContext('2d'), {
          type: 'line',
          plugins: [cvaWarnPlugin],
          data: { labels: allLabels, datasets },
          options: {
            responsive: true, maintainAspectRatio: false,
            scales: {
              y: { min: 20, max: 90, ticks: { color: '#82898D', callback: v => `${v}°` }, grid: { color: 'rgba(130,137,141,0.1)' } },
              x: { grid: { display: false }, ticks: { color: '#82898D', font: { size: 10 }, autoSkip: false, callback(v, i) { return allLabels[i] || ''; } } }
            },
            plugins: { legend: { labels: { color: '#3A3533', font: { size: 11 } } }, tooltip: { callbacks: { label: ctx => `CVA: ${ctx.raw?.toFixed(1)}°` } } }
          }
        });

        // Stats chips
        const statsEl = document.getElementById('modal-cva-stats');
        if (statsEl) {
          statsEl.innerHTML = ['relax','prepare','playing'].filter(s => cvaData[s]).map(s => {
            const d = cvaData[s];
            const warn = d.abovePct > 0 ? `⚠ ${d.abovePct}% 低於警戒` : '✓ All normal';
            const color = d.abovePct > 0 ? '#C39289' : '#C6CCC0';
            return `<div style="background:var(--bg-secondary);border-radius:8px;padding:0.5rem 0.9rem;border-left:3px solid ${color};min-width:100px;">
              <div style="font-size:0.7rem;color:var(--text-secondary);">${stageLabels[s]} avg CVA</div>
              <div style="font-size:1rem;font-weight:700;color:var(--text-primary);font-family:monospace;">${d.avg.toFixed(1)}°</div>
              <div style="font-size:0.7rem;color:${color};">${warn}</div>
            </div>`;
          }).join('');
        }
        lucide.createIcons();
      }
    }, 100);
    
  } 
  else { // Static Record view
    content.innerHTML = `
      <div style="margin-bottom: 1.5rem;">
        <span class="badge badge-info" style="font-size: 0.85rem; margin-bottom: 0.5rem;">靜態動作診斷</span>
        <h2 style="color: var(--text-primary); font-size: 1.5rem;">${r.projectName} 診斷報告</h2>
        <p style="color: var(--text-secondary); font-size: 0.85rem;">評估時間: ${r.timestamp} | 演奏者: ${r.username} (${r.instrument})</p>
      </div>
      
      <div class="card" style="margin-bottom: 1.5rem; display: flex; align-items: center; justify-content: center; gap: 2rem; padding: 2rem;">
        <div class="score-badge-large ${r.level === 'Good' ? 'optimal' : (r.level === 'Caution' ? 'warning' : 'danger')}">
          <span class="score-value">${r.score}</span>
          <span class="score-label">${r.projectName.includes('頭') || r.projectName.includes('抬') ? '姿勢評分' : 'Symmetry Score'}</span>
        </div>
        <div style="text-align:left;">
          <h3 style="color:var(--text-primary); font-size:1.3rem;">診斷評定: ${r.level}</h3>
          <p style="color:var(--text-dark); margin-top:0.5rem; font-size:0.95rem;">指標數值: <strong>${r.details.textSummary}</strong></p>
        </div>
      </div>
      
      <div class="card" style="background-color: var(--bg-secondary); border-left:4px solid var(--color-interactive); padding: 1.25rem;">
        <h4 style="color:var(--text-primary); display:flex; align-items:center; gap:0.5rem;">
          <i data-lucide="info"></i> 針對您的復健與防護建議
        </h4>
        <p style="margin-top:0.5rem; font-size:0.9rem; line-height:1.5; color:var(--text-dark);">
          ${getAdviceFromDiagnosisType(r.projectName)}
        </p>
      </div>
    `;
    
    setTimeout(() => {
      lucide.createIcons();
    }, 50);
  }
}

function getAdviceFromDiagnosisType(projectName) {
  if (projectName.includes('肩')) {
    return '日常練習前可進行 10 分鐘落肩牽拉，拉伸斜方肌。演奏小提琴每 45 分鐘建議休息 10 分鐘，並做水平轉頭動作放鬆頸部，避免單側重力壓迫導致一側肩胛緊繃。';
  } else if (projectName.includes('頭')) {
    return '演奏時應調整譜架高度與眼睛齊平，防範頭部前傾。可利用「靠牆收下巴」練習，改善烏龜頸與肩頸疲勞。';
  } else if (projectName.includes('抬')) {
    return '加強肩關節外旋拉伸動作（例如靠牆肘對貼）。上舉角度受限的肩膀（多為持弓手或按弦手之肩關節受壓過大）應在演奏前後進行肩袖肌群的低強度熱身與拉伸。';
  }
  return '請保持規律的演奏姿勢檢測，維持身體對稱性。';
}

function closeDetailModal() {
  document.getElementById('detail-modal').style.display = 'none';
}

// ----------------------------------------------------
// 9. IMPORT / EXPORT DATA
// ----------------------------------------------------
function exportHistoryData() {
  const records = getHistoryFromStorage();
  if (records.length === 0) {
    showToast('目前無任何紀錄可供匯出。', 'warning');
    return;
  }
  
  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(records, null, 2));
  const downloadAnchor = document.createElement('a');
  downloadAnchor.setAttribute("href", dataStr);
  downloadAnchor.setAttribute("download", `musician_health_records_${Date.now()}.json`);
  document.body.appendChild(downloadAnchor);
  downloadAnchor.click();
  downloadAnchor.remove();
  
  showToast('歷史紀錄匯出成功！', 'success');
}

function importHistoryData(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const imported = JSON.parse(e.target.result);
      if (!Array.isArray(imported)) {
        throw new Error('資料格式不正確，應為陣列型式。');
      }
      
      // Merge with existing
      const existing = getHistoryFromStorage();
      
      // Filter out duplicates by ID
      const merged = [...imported, ...existing];
      const uniqueMerged = [];
      const idsSeen = new Set();
      
      merged.forEach(r => {
        if (r.id && !idsSeen.has(r.id)) {
          idsSeen.add(r.id);
          uniqueMerged.push(r);
        }
      });
      
      saveHistoryToStorage(uniqueMerged);
      showToast(`成功匯入 ${imported.length} 筆評估紀錄！`, 'success');
      
      // Reset file input
      event.target.value = '';
    } catch (err) {
      showToast(`匯入失敗: ${err.message}`, 'danger');
      event.target.value = '';
    }
  };
  reader.readAsText(file);
}

// ----------------------------------------------------
// 10. WELCOME DASHBOARD TREND CHART & STATS
// ----------------------------------------------------
function updateDashboardStats() {
  const records = getHistoryFromStorage();
  
  // Count
  document.getElementById('stat-total-count').textContent = records.length;
  
  // Last score
  const playingRecordsOnly = records.filter(r => r.type === 'playing');
  if (playingRecordsOnly.length > 0) {
    document.getElementById('stat-last-score').textContent = playingRecordsOnly[0].score;
  } else if (records.length > 0) {
    document.getElementById('stat-last-score').textContent = records[0].score;
  } else {
    document.getElementById('stat-last-score').textContent = '--';
  }
  
  // Instrument
  if (currentProfile) {
    document.getElementById('stat-instrument').textContent = currentProfile.instrument;
  } else {
    document.getElementById('stat-instrument').textContent = '無';
  }
  
  // Render recommendations tips
  const tipsEl = document.getElementById('dashboard-tips');
  if (records.length === 0) {
    tipsEl.innerHTML = `
      <p style="color: var(--text-secondary); font-size: 0.9rem; text-align: center; padding: 2rem 0;">
        暫無足夠的評估紀錄。請至少完成一次動作評估以獲得個人化的健康改善建議。
      </p>
    `;
    return;
  }
  
  // Custom smart recommendations
  const worstRecord = [...records].sort((a,b) => a.score - b.score)[0];
  let tipHtml = '';
  
  if (worstRecord.score < 80) {
    tipHtml += `
      <div style="background-color:rgba(195,146,137,0.1); border-left:4px solid var(--color-danger); padding:1rem; border-radius:4px;">
        <strong style="color:var(--text-primary); font-size:0.9rem;">⚠️ 注意：肌肉骨骼壓力高</strong>
        <p style="font-size:0.8rem; color:var(--text-dark); margin-top:0.25rem;">在您的「${worstRecord.projectName}」檢測中得分偏低 (${worstRecord.score} 分)。這代表肩頸與脊椎代償壓力較大，建議每演奏 40 分鐘即休息並進行肩頸對稱放鬆。</p>
      </div>
    `;
  } else {
    tipHtml += `
      <div style="background-color:rgba(198,204,192,0.15); border-left:4px solid var(--color-success); padding:1rem; border-radius:4px;">
        <strong style="color:#43523f; font-size:0.9rem;">✓ 良好：姿勢維持優良</strong>
        <p style="font-size:0.8rem; color:var(--text-dark); margin-top:0.25rem;">您最近期的動作評估表現良好，請繼續維持標準的視譜高度，並於提琴練習前後進行溫和暖身與伸展。</p>
      </div>
    `;
  }
  
  // Add another general tips
  tipHtml += `
    <div style="background-color:var(--bg-secondary); border-left:4px solid var(--color-accent); padding:1rem; border-radius:4px;">
      <strong style="color:var(--text-primary); font-size:0.9rem;">💡 物理治療小叮嚀</strong>
      <p style="font-size:0.8rem; color:var(--text-dark); margin-top:0.25rem;">
        小提琴演奏者：注意夾琴時下巴不要過度用力向左壓，肩膀應放鬆。
        <br>大提琴演奏者：注意腰椎與骨盆垂直對中，背部不要駝背前傾。
      </p>
    </div>
  `;
  
  tipsEl.innerHTML = tipHtml;
}

function renderDashboardTrendChart() {
  const records = getHistoryFromStorage();
  const canvas = document.getElementById('dashboardTrendChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  
  if (dashboardTrendChartRef) {
    dashboardTrendChartRef.destroy();
  }
  
  // Sort records chronologically (oldest first) for trend line
  const chronological = [...records].reverse().slice(-10); // last 10 records
  
  if (chronological.length === 0) {
    // Draw empty state info in chart placeholder
    ctx.clearRect(0,0, canvas.width, canvas.height);
    ctx.fillStyle = '#82898D';
    ctx.font = '14px Noto Sans TC, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('尚無歷史檢測數據可繪製趨勢圖', canvas.width / 2, canvas.height / 2);
    return;
  }
  
  const labels = chronological.map(r => r.timestamp.split(' ')[0].substring(5)); // Show MM/DD only
  const data = chronological.map(r => r.score);

  dashboardTrendChartRef = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Overall Score Trend',
        data: data,
        borderColor: '#8D6B61',
        backgroundColor: 'rgba(141, 107, 97, 0.1)',
        borderWidth: 3,
        tension: 0.2,
        fill: true,
        pointRadius: 5,
        pointBackgroundColor: '#C0B0A2',
        pointBorderColor: '#8D6B61'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: { min: 40, max: 100, grid: { color: 'rgba(130,137,141,0.1)' }, ticks: { color: '#82898D' } },
        x: { grid: { display: false }, ticks: { color: '#82898D' } }
      },
      plugins: { legend: { display: false } }
    }
  });
}

function showComparisonModal() {
  if (selectedRecordIds.size < 2) {
    showToast('Please select at least 2 records to compare.', 'warning');
    return;
  }

  const records = getHistoryFromStorage();
  const selectedRecords = records.filter(r => selectedRecordIds.has(r.id)).reverse();

  const modal = document.getElementById('detail-modal');
  const content = document.getElementById('modal-content');

  modal.style.display = 'flex';

  const allPlaying = selectedRecords.every(r => r.type === 'playing');
  let mainChartTitle = "多次紀錄對比折線圖";
  let chartDesc = allPlaying
    ? "此折線圖比較了所選不同評估的演奏中（Playing）狀態下各個關鍵點位的關節夾角。"
    : "此折線圖比較了所選不同評估的綜合健康度得分 / 姿勢分數。";
  
  content.innerHTML = `
    <div style="margin-bottom: 1.5rem;">
      <span class="badge badge-info" style="font-size: 0.85rem; margin-bottom: 0.5rem;">多筆紀錄比較分析</span>
      <h2 style="color: var(--text-primary); font-size: 1.5rem;">姿態紀錄對比分析</h2>
      <p style="color: var(--text-secondary); font-size: 0.85rem;">已選取 ${selectedRecords.length} 筆紀錄進行交叉比對</p>
    </div>
    
    <div class="card" style="margin-bottom: 1.5rem;">
      <h4 style="color: var(--text-primary); margin-bottom: 0.5rem;" id="comparison-chart-title">${mainChartTitle}</h4>
      <div style="height: 380px; position:relative;">
        <canvas id="comparisonLineChart"></canvas>
      </div>
      <p style="font-size: 0.75rem; color: var(--text-secondary); text-align: center; margin-top: 0.5rem;">
        ${chartDesc}
      </p>
    </div>
    
    <div class="card">
      <h4 style="color: var(--text-primary); margin-bottom: 0.75rem;">所選紀錄列表</h4>
      <div style="overflow-x: auto;">
        <table style="font-size: 0.85rem; width: 100%; border-collapse: collapse;">
          <thead>
            <tr>
              <th style="padding: 0.75rem;">評估時間</th>
              <th style="padding: 0.75rem;">姓名 / 代號</th>
              <th style="padding: 0.75rem;">樂器</th>
              <th style="padding: 0.75rem;">類型</th>
              <th style="padding: 0.75rem;">評估項目</th>
              <th style="padding: 0.75rem;">綜合得分</th>
              <th style="padding: 0.75rem;">健康等級</th>
            </tr>
          </thead>
          <tbody>
            ${selectedRecords.map(r => `
              <tr>
                <td style="padding: 0.75rem;">${r.timestamp}</td>
                <td style="padding: 0.75rem;"><strong>${r.username}</strong></td>
                <td style="padding: 0.75rem;"><span class="badge badge-info" style="font-size: 0.7rem;">${r.instrument}</span></td>
                <td style="padding: 0.75rem;">${r.type === 'playing' ? '演奏動作' : '靜態檢測'}</td>
                <td style="padding: 0.75rem;">${r.projectName}</td>
                <td style="padding: 0.75rem;"><strong style="color: var(--text-primary);">${r.score}</strong></td>
                <td style="padding: 0.75rem;"><span class="badge ${r.level === 'Good' ? 'badge-success' : (r.level === 'Caution' ? 'badge-warning' : 'badge-danger')}" style="font-size: 0.7rem;">${r.level}</span></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
  
  setTimeout(() => {
    const comparisonCtx = document.getElementById('comparisonLineChart').getContext('2d');
    
    if (allPlaying) {
      const labels = ['頸椎角度', '雙肩傾斜度', '左右肩對稱度', '左手肘夾角', '右手肘夾角', '脊椎傾斜度'];
      const lineColors = [
        '#8D6B61', '#A1B0AD', '#C0B0A2', '#C6CCC0', '#E1AA8D', '#82898D', '#C39289'
      ];
      
      const datasets = selectedRecords.map((r, index) => {
        const p = r.details;
        const color = lineColors[index % lineColors.length];
        return {
          label: `${r.username} (${r.timestamp.split(' ')[0]}) - ${r.instrument}`,
          data: [p.neckAngle, p.shoulderTilt, p.shoulderSymmetry, p.leftElbow, p.rightElbow, p.spineTilt],
          borderColor: color,
          backgroundColor: 'transparent',
          borderWidth: 3,
          tension: 0.15,
          pointRadius: 5,
          pointBackgroundColor: color
        };
      });
      
      new Chart(comparisonCtx, {
        type: 'line',
        data: {
          labels: labels,
          datasets: datasets
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            y: {
              grid: { color: 'rgba(130, 137, 141, 0.1)' },
              ticks: { color: '#82898D' }
            },
            x: {
              grid: { color: 'rgba(130, 137, 141, 0.1)' },
              ticks: { color: '#82898D', font: { family: 'Noto Sans TC' } }
            }
          },
          plugins: {
            legend: { labels: { color: '#3A3533', font: { family: 'Noto Sans TC', size: 11 } } }
          }
        }
      });
    } else {
      const labels = selectedRecords.map(r => `${r.username} (${r.timestamp.split(' ')[0].substring(5)})`);
      const scores = selectedRecords.map(r => r.score);
      
      new Chart(comparisonCtx, {
        type: 'line',
        data: {
          labels: labels,
          datasets: [{
            label: '綜合評分比對',
            data: scores,
            borderColor: '#8D6B61',
            backgroundColor: 'rgba(141, 107, 97, 0.1)',
            borderWidth: 4,
            tension: 0.2,
            fill: true,
            pointRadius: 6,
            pointBackgroundColor: '#C0B0A2',
            pointBorderColor: '#8D6B61'
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            y: {
              min: 40,
              max: 100,
              grid: { color: 'rgba(130, 137, 141, 0.1)' },
              ticks: { color: '#82898D' }
            },
            x: {
              grid: { display: false },
              ticks: { color: '#82898D' }
            }
          },
          plugins: {
            legend: { display: false }
          }
        }
      });
    }
    
    lucide.createIcons();
  }, 100);

}
}