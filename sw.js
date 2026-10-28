// 最小化的 Service Worker：只為了讓 Android 能「安裝應用程式」。
// 不做任何快取，所有請求都直接走網路，因此上傳新版程式後使用者會立即拿到新版。
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* 不攔截，交給瀏覽器正常連網 */ });
