// Service worker: guarda la app para abrirla al instante y sin conexión. Los datos siempre se piden a la red.
const VERSION = 'mc-v27';
const SHELL = ['./', 'index.html', 'styles.css?v=27', 'core.js?v=27', 'app.js?v=27', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin === location.origin) {
    // Red primero saltándose la caché HTTP del navegador (evita mezclar versiones); copia local si no hay conexión
    e.respondWith(fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' })
      .then((r) => { if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); } return r; })
      .catch(() => caches.match(e.request).then((r) => r || caches.match(e.request, { ignoreSearch: true })).then((r) => r || caches.match('index.html'))));
  } else if (url.hostname.endsWith('fonts.googleapis.com') || url.hostname.endsWith('fonts.gstatic.com')) {
    e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request).then((res) => { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); return res; })));
  }
  // Las peticiones a Google Apps Script no se tocan.
});
