// =================================================================
// install-hint.js — 網頁 App（加入主畫面）支援
//   ・偵測裝置：電腦／手機／平板、iOS／Android、是否已從主畫面開啟
//   ・手機或平板第一次開啟、且不是從主畫面開啟時，顯示「加入主畫面」教學
//   ・註冊 Service Worker（Android 安裝需要）
// login.html 與 index.html 共用，文字自帶中英文
// =================================================================
(function () {
  // ── 裝置判斷 ─────────────────────────────────────────────────
  function detectDevice() {
    const ua = navigator.userAgent || '';
    // iPadOS 13 之後 Safari 會偽裝成 Mac，需用「Mac＋觸控點數 > 1」辨識
    const isIPad = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    const isIPhone = /iPhone|iPod/.test(ua);
    const isIOS = isIPad || isIPhone;
    const isAndroid = /Android/i.test(ua);
    const isAndroidTablet = isAndroid && !/Mobile/i.test(ua);
    const uaMobile = navigator.userAgentData ? navigator.userAgentData.mobile : /Mobi/i.test(ua);
    const isMobileOrTablet = isIOS || isAndroid || !!uaMobile;
    const isTablet = isIPad || isAndroidTablet;
    // 是否從主畫面以 App 方式開啟（全螢幕、無網址列）
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches ||
                         window.matchMedia('(display-mode: fullscreen)').matches ||
                         window.navigator.standalone === true;
    const isIOSSafari = isIOS && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
    return {
      type: !isMobileOrTablet ? 'desktop' : (isTablet ? 'tablet' : 'phone'),
      os: isIOS ? 'ios' : (isAndroid ? 'android' : 'other'),
      isMobileOrTablet, isTablet, isStandalone, isIOSSafari
    };
  }
  window.detectDevice = detectDevice;

  // ── Service Worker ───────────────────────────────────────────
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
  }

  // Android Chrome 的安裝事件
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredPrompt = e;
    const btn = document.getElementById('ih-install-btn');
    if (btn) btn.style.display = 'inline-flex';
  });

  const KEY = 'installHintDismissed';
  const TXT = {
    zh: {
      title: '把系統加入主畫面',
      desc: '加入後可以像 App 一樣從主畫面開啟，畫面全螢幕、不會顯示網址列。',
      ios: ['點瀏覽器下方（iPad 在右上方）的 <b>分享</b> 按鈕 <span class="ih-ic">⬆︎</span>', '往下滑，選 <b>加入主畫面</b>', '右上角按 <b>加入</b>'],
      iosOther: '若沒有看到「加入主畫面」，請改用 <b>Safari</b> 開啟本網址後再操作。',
      android: ['點瀏覽器右上角的 <b>⋮</b> 選單', '選 <b>安裝應用程式</b> 或 <b>加到主畫面</b>', '按 <b>安裝</b>／<b>新增</b>'],
      other: ['開啟瀏覽器選單', '找 <b>加到主畫面</b> 或 <b>安裝</b>'],
      install: '立即安裝', later: '稍後再說', never: '知道了，不再顯示'
    },
    en: {
      title: 'Add this system to your Home Screen',
      desc: 'Open it like an app from your Home Screen — full screen, no address bar.',
      ios: ['Tap the <b>Share</b> button <span class="ih-ic">⬆︎</span> (bottom bar; top right on iPad)', 'Scroll down and choose <b>Add to Home Screen</b>', 'Tap <b>Add</b> in the top-right corner'],
      iosOther: 'If you don’t see “Add to Home Screen”, open this address in <b>Safari</b> first.',
      android: ['Tap the <b>⋮</b> menu at the top right', 'Choose <b>Install app</b> or <b>Add to Home screen</b>', 'Tap <b>Install</b> / <b>Add</b>'],
      other: ['Open the browser menu', 'Choose <b>Add to Home Screen</b> or <b>Install</b>'],
      install: 'Install now', later: 'Later', never: 'Got it, don’t show again'
    }
  };

  function injectCss() {
    const css = `
      .ih-backdrop{position:fixed;inset:0;background:rgba(47,46,43,.45);z-index:10000;display:flex;align-items:flex-end;justify-content:center;padding:12px}
      .ih-sheet{width:100%;max-width:460px;background:#F6F4EF;border-radius:18px;padding:22px 20px 18px;border-top:5px solid #0D5661;
        font-family:'Outfit','Noto Sans TC',sans-serif;color:#2F2E2B;box-shadow:0 -6px 30px rgba(0,0,0,.25);animation:ihUp .25s ease}
      @keyframes ihUp{from{transform:translateY(40px);opacity:0}to{transform:none;opacity:1}}
      .ih-head{display:flex;gap:12px;align-items:center;margin-bottom:10px}
      .ih-head img{width:48px;height:48px;border-radius:11px}
      .ih-title{font-size:1.05rem;font-weight:700;color:#0D5661}
      .ih-desc{font-size:.85rem;color:#707C74;line-height:1.55;margin:0 0 12px}
      .ih-steps{margin:0 0 10px;padding-left:1.3rem;font-size:.9rem;line-height:1.8}
      .ih-steps b{color:#0D5661}
      .ih-ic{display:inline-block;border:1px solid #91989F;border-radius:4px;padding:0 4px;font-size:.8rem}
      .ih-note{font-size:.78rem;color:#6C6024;background:#F0EDDC;border-radius:8px;padding:8px 10px;margin-bottom:10px;line-height:1.5}
      .ih-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;margin-top:6px}
      .ih-btn{border:1px solid #DCDAD3;background:#fff;color:#707C74;border-radius:8px;padding:9px 14px;font-size:.85rem;font-weight:600;cursor:pointer;font-family:inherit}
      .ih-btn.primary{background:#0D5661;color:#fff;border-color:#0D5661}`;
    const st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);
  }

  function showHint(force) {
    const d = detectDevice();
    if (!force) {
      if (!d.isMobileOrTablet || d.isStandalone) return;
      try { if (localStorage.getItem(KEY) === '1' || sessionStorage.getItem(KEY) === '1') return; } catch (e) {}
    }
    const lang = (function () { try { return localStorage.getItem('lang') === 'en' ? 'en' : 'zh'; } catch (e) { return 'zh'; } })();
    const t = TXT[lang];
    const steps = d.os === 'ios' ? t.ios : (d.os === 'android' ? t.android : t.other);
    injectCss();
    const wrap = document.createElement('div');
    wrap.className = 'ih-backdrop';
    wrap.innerHTML = `
      <div class="ih-sheet" role="dialog" aria-label="${t.title}">
        <div class="ih-head"><img src="icons/icon-192.png" alt="" onerror="this.remove()"><div class="ih-title">${t.title}</div></div>
        <p class="ih-desc">${t.desc}</p>
        <ol class="ih-steps">${steps.map(s => `<li>${s}</li>`).join('')}</ol>
        ${d.os === 'ios' && !d.isIOSSafari ? `<div class="ih-note">${t.iosOther}</div>` : ''}
        <div class="ih-actions">
          <button class="ih-btn primary" id="ih-install-btn" style="display:${deferredPrompt ? 'inline-flex' : 'none'}">${t.install}</button>
          <button class="ih-btn" id="ih-later">${t.later}</button>
          <button class="ih-btn" id="ih-never">${t.never}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const close = () => wrap.remove();
    wrap.querySelector('#ih-later').onclick = () => { try { sessionStorage.setItem(KEY, '1'); } catch (e) {} close(); };
    wrap.querySelector('#ih-never').onclick = () => { try { localStorage.setItem(KEY, '1'); } catch (e) {} close(); };
    wrap.querySelector('#ih-install-btn').onclick = async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      try { await deferredPrompt.userChoice; } catch (e) {}
      deferredPrompt = null;
      try { localStorage.setItem(KEY, '1'); } catch (e) {}
      close();
    };
  }
  window.showInstallHint = showHint;

  window.addEventListener('load', () => setTimeout(() => showHint(false), 1200));
})();
