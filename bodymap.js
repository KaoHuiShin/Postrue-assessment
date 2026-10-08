// =================================================================
// 人體圖（疼痛／不適部位標記）共用模組 — login.html 與 index.html 皆會載入
// 使用方式：
//   const map = BodyMap.create(containerEl, { marks: [], editable: true, gender: '女' });
//   map.getMarks()  → [{ region, x, y, note }]   x / y 為 0–1 相對座標
//   map.setMarks(marks)
// 左右定義：圖面左側＝演奏者右側（正面圖）
// 換成研究者提供的男女正面輪廓圖：把圖檔路徑填入 BODY_MAP_IMAGES，
// 圖片會以 200×440 的比例鋪在 SVG 底層，部位判定仍依 BODY_REGIONS 的座標框。
// =================================================================

const BODY_MAP_IMAGES = {
  male: null,    // 例：'images/body_male_front.png'
  female: null   // 例：'images/body_female_front.png'
};

// 部位清單（座標系 viewBox 0 0 200 440；box = [x1, y1, x2, y2]）
// 部位清單與左右定義仍待研究者確認，可直接在此增修
const BODY_REGIONS = [
  { id: 'head',        zh: '頭部',       en: 'Head',             box: [72, 8, 128, 66] },
  { id: 'neck',        zh: '頸部',       en: 'Neck',             box: [86, 64, 114, 90] },
  { id: 'r_shoulder',  zh: '右肩',       en: 'Right shoulder',   box: [50, 86, 86, 114] },
  { id: 'l_shoulder',  zh: '左肩',       en: 'Left shoulder',    box: [114, 86, 150, 114] },
  { id: 'chest',       zh: '胸部／上背', en: 'Chest / upper back', box: [80, 92, 120, 150] },
  { id: 'abdomen',     zh: '腹部／下背', en: 'Abdomen / lower back', box: [78, 150, 122, 200] },
  { id: 'r_upper_arm', zh: '右上臂',     en: 'Right upper arm',  box: [42, 112, 72, 172] },
  { id: 'l_upper_arm', zh: '左上臂',     en: 'Left upper arm',   box: [128, 112, 158, 172] },
  { id: 'r_elbow',     zh: '右手肘',     en: 'Right elbow',      box: [36, 170, 68, 196] },
  { id: 'l_elbow',     zh: '左手肘',     en: 'Left elbow',       box: [132, 170, 164, 196] },
  { id: 'r_forearm',   zh: '右前臂',     en: 'Right forearm',    box: [30, 194, 62, 244] },
  { id: 'l_forearm',   zh: '左前臂',     en: 'Left forearm',     box: [138, 194, 170, 244] },
  { id: 'r_wrist',     zh: '右手腕／手', en: 'Right wrist / hand', box: [20, 242, 58, 292] },
  { id: 'l_wrist',     zh: '左手腕／手', en: 'Left wrist / hand',  box: [142, 242, 180, 292] },
  { id: 'r_hip',       zh: '右髖',       en: 'Right hip',        box: [74, 200, 100, 236] },
  { id: 'l_hip',       zh: '左髖',       en: 'Left hip',         box: [100, 200, 126, 236] },
  { id: 'r_thigh',     zh: '右大腿',     en: 'Right thigh',      box: [72, 236, 100, 316] },
  { id: 'l_thigh',     zh: '左大腿',     en: 'Left thigh',       box: [100, 236, 128, 316] },
  { id: 'r_knee',      zh: '右膝',       en: 'Right knee',       box: [72, 316, 100, 344] },
  { id: 'l_knee',      zh: '左膝',       en: 'Left knee',        box: [100, 316, 128, 344] },
  { id: 'r_leg',       zh: '右小腿／足', en: 'Right lower leg / foot', box: [70, 344, 100, 436] },
  { id: 'l_leg',       zh: '左小腿／足', en: 'Left lower leg / foot',  box: [100, 344, 130, 436] }
];

const BODYMAP_I18N = {
  zh: {
    caption: '正面圖｜圖面左側＝您的右側',
    hint: '點選身體上不適或曾受傷的部位，即可新增標記並填寫備註',
    empty: '尚未標記任何部位',
    note_ph: '備註（例如：開始時間、疼痛程度 0–10、何時加劇）',
    none: '無標記',
    other: '其他部位',
    del: '刪除',
    right: '右', left: '左'
  },
  en: {
    caption: 'Front view | left side of image = your RIGHT side',
    hint: 'Click a body area that hurts or was injured to add a mark and a note',
    empty: 'No areas marked yet',
    note_ph: 'Note (e.g. onset, pain 0–10, what makes it worse)',
    none: 'No marks',
    other: 'Other area',
    del: 'Delete',
    right: 'R', left: 'L'
  }
};

const BodyMap = (() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function lang() {
    try { return localStorage.getItem('lang') === 'en' ? 'en' : 'zh'; } catch { return 'zh'; }
  }
  function t(key) { return BODYMAP_I18N[lang()][key] || key; }

  function regionLabel(id) {
    const r = BODY_REGIONS.find(r => r.id === id);
    if (!r) return t('other');
    return lang() === 'en' ? r.en : r.zh;
  }

  // 依座標找最小的符合部位框
  function findRegion(px, py) {
    let best = null, bestArea = Infinity;
    BODY_REGIONS.forEach(r => {
      const [x1, y1, x2, y2] = r.box;
      if (px >= x1 && px <= x2 && py >= y1 && py <= y2) {
        const area = (x2 - x1) * (y2 - y1);
        if (area < bestArea) { best = r; bestArea = area; }
      }
    });
    return best ? best.id : null;
  }

  function isFemale(gender) {
    return gender === '女' || gender === 'female' || gender === 'F';
  }

  // 示意輪廓（研究者提供正式圖檔前使用）
  function silhouetteMarkup(gender) {
    const fill = '#E4E2DC', stroke = '#91989F';
    const waist = isFemale(gender) ? 'M80,150 Q74,176 78,200' : 'M80,150 Q78,176 78,200';
    const waistR = isFemale(gender) ? 'M120,150 Q126,176 122,200' : 'M120,150 Q122,176 122,200';
    return `
      <g fill="${fill}" stroke="${stroke}" stroke-width="1.4" stroke-linejoin="round">
        <ellipse cx="100" cy="38" rx="24" ry="29"/>
        <rect x="90" y="62" width="20" height="26" rx="6"/>
        <path d="M58,96 Q100,82 142,96 L136,120 Q128,140 122,150 L122,200 L78,200 L78,150 Q72,140 64,120 Z"/>
        <path d="${waist}" fill="none"/>
        <path d="${waistR}" fill="none"/>
        <rect x="44" y="102" width="26" height="76" rx="12" transform="rotate(8 57 140)"/>
        <rect x="130" y="102" width="26" height="76" rx="12" transform="rotate(-8 143 140)"/>
        <rect x="34" y="176" width="24" height="70" rx="11" transform="rotate(10 46 210)"/>
        <rect x="142" y="176" width="24" height="70" rx="11" transform="rotate(-10 154 210)"/>
        <ellipse cx="36" cy="266" rx="13" ry="22" transform="rotate(10 36 266)"/>
        <ellipse cx="164" cy="266" rx="13" ry="22" transform="rotate(-10 164 266)"/>
        <path d="M78,198 L122,198 L126,232 L100,240 L74,232 Z"/>
        <rect x="74" y="228" width="25" height="118" rx="12"/>
        <rect x="101" y="228" width="25" height="118" rx="12"/>
        <rect x="76" y="338" width="21" height="86" rx="10"/>
        <rect x="103" y="338" width="21" height="86" rx="10"/>
        <ellipse cx="85" cy="428" rx="14" ry="8"/>
        <ellipse cx="115" cy="428" rx="14" ry="8"/>
      </g>
      <line x1="100" y1="70" x2="100" y2="236" stroke="${stroke}" stroke-width="0.6" stroke-dasharray="3 3" opacity="0.6"/>
      <text x="12" y="20" font-size="11" fill="${stroke}" font-family="sans-serif">${t('right')}</text>
      <text x="180" y="20" font-size="11" fill="${stroke}" font-family="sans-serif">${t('left')}</text>`;
  }

  function create(container, opts = {}) {
    const state = {
      marks: Array.isArray(opts.marks) ? opts.marks.map(m => ({ ...m })) : [],
      editable: opts.editable !== false,
      gender: opts.gender || '',
      compact: !!opts.compact,
      onChange: typeof opts.onChange === 'function' ? opts.onChange : null
    };

    container.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = state.compact ? '' : 'bodymap-wrap';

    const fig = document.createElement('div');
    fig.className = 'bodymap-figure' + (state.editable ? '' : ' readonly');

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 200 440');
    svg.setAttribute('role', 'img');

    const imgSrc = isFemale(state.gender) ? BODY_MAP_IMAGES.female : BODY_MAP_IMAGES.male;
    if (imgSrc) {
      svg.innerHTML = `<image href="${imgSrc}" x="0" y="0" width="200" height="440" preserveAspectRatio="xMidYMid meet"/>`;
    } else {
      svg.innerHTML = silhouetteMarkup(state.gender);
    }
    const markLayer = document.createElementNS(SVG_NS, 'g');
    svg.appendChild(markLayer);
    fig.appendChild(svg);

    const cap = document.createElement('div');
    cap.className = 'bodymap-caption';
    cap.textContent = t('caption');
    fig.appendChild(cap);
    wrap.appendChild(fig);

    let notesEl = null;
    if (!state.compact) {
      const side = document.createElement('div');
      if (state.editable) {
        const hint = document.createElement('p');
        hint.className = 'muted small';
        hint.style.marginBottom = '0.6rem';
        hint.textContent = t('hint');
        side.appendChild(hint);
      }
      notesEl = document.createElement('div');
      notesEl.className = 'bodymap-notes';
      side.appendChild(notesEl);
      wrap.appendChild(side);
    }
    container.appendChild(wrap);

    function emit() { if (state.onChange) state.onChange(getMarks()); }

    function renderMarks() {
      markLayer.innerHTML = '';
      state.marks.forEach((m, i) => {
        const cx = m.x * 200, cy = m.y * 440;
        const g = document.createElementNS(SVG_NS, 'g');
        g.innerHTML = `<circle cx="${cx}" cy="${cy}" r="8" fill="#8E354A" stroke="#fff" stroke-width="1.5" opacity="0.92"/>
          <text x="${cx}" y="${cy + 3.5}" text-anchor="middle" font-size="9.5" font-weight="700" fill="#fff" font-family="sans-serif">${i + 1}</text>`;
        markLayer.appendChild(g);
      });
      if (!notesEl) return;
      notesEl.innerHTML = '';
      if (state.marks.length === 0) {
        const e = document.createElement('div');
        e.className = 'bodymap-empty';
        e.textContent = state.editable ? t('empty') : t('none');
        notesEl.appendChild(e);
        return;
      }
      state.marks.forEach((m, i) => {
        const row = document.createElement('div');
        row.className = 'bodymap-note';
        const num = document.createElement('div');
        num.className = 'bodymap-num';
        num.textContent = i + 1;
        const body = document.createElement('div');
        const reg = document.createElement('div');
        reg.className = 'bodymap-note-region';
        reg.textContent = regionLabel(m.region);
        body.appendChild(reg);
        if (state.editable) {
          const ta = document.createElement('textarea');
          ta.placeholder = t('note_ph');
          ta.value = m.note || '';
          ta.addEventListener('input', () => { state.marks[i].note = ta.value; emit(); });
          body.appendChild(ta);
        } else if (m.note) {
          const p = document.createElement('div');
          p.className = 'list-item-sub';
          p.textContent = m.note;
          body.appendChild(p);
        }
        row.appendChild(num);
        row.appendChild(body);
        if (state.editable) {
          const del = document.createElement('button');
          del.type = 'button';
          del.className = 'del';
          del.title = t('del');
          del.innerHTML = '✕';
          del.addEventListener('click', () => { state.marks.splice(i, 1); renderMarks(); emit(); });
          row.appendChild(del);
        } else {
          row.appendChild(document.createElement('span'));
        }
        notesEl.appendChild(row);
      });
    }

    svg.addEventListener('click', (ev) => {
      if (!state.editable) return;
      const pt = svg.createSVGPoint();
      pt.x = ev.clientX; pt.y = ev.clientY;
      const ctm = svg.getScreenCTM();
      if (!ctm) return;
      const p = pt.matrixTransform(ctm.inverse());
      const region = findRegion(p.x, p.y);
      if (!region) return; // 點在身體以外的地方不加標記
      state.marks.push({ region, x: +(p.x / 200).toFixed(4), y: +(p.y / 440).toFixed(4), note: '' });
      renderMarks();
      emit();
      if (notesEl) {
        const last = notesEl.querySelector('.bodymap-note:last-child textarea');
        if (last) last.focus();
      }
    });

    function getMarks() { return state.marks.map(m => ({ region: m.region, x: m.x, y: m.y, note: (m.note || '').trim() })); }
    function setMarks(marks) { state.marks = Array.isArray(marks) ? marks.map(m => ({ ...m })) : []; renderMarks(); }
    renderMarks();
    return { getMarks, setMarks, rerender: renderMarks };
  }

  // 摘要字串，例如「右肩、頸部」
  function summarize(marks) {
    if (!marks || !marks.length) return '';
    const names = [];
    marks.forEach(m => { const n = regionLabel(m.region); if (!names.includes(n)) names.push(n); });
    return names.join(lang() === 'en' ? ', ' : '、');
  }

  return { create, regionLabel, summarize, regions: BODY_REGIONS };
})();
