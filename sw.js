// Service worker: aplikacja działa bez internetu.
// Po każdej zmianie plików aplikacji zwiększ numer wersji.
const VERSION = 'pellet-v12';
const SDK_CACHE = 'firebase-sdk'; // nie kasujemy przy aktualizacji aplikacji
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/store.js',
  './js/forecast.js',
  './js/weather.js',
  './js/cloud.js',
  './js/piec.js',
  './js/firebase-config.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== SDK_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Pliki aplikacji: najpierw sieć (świeża wersja), przy braku sieci – bufor.
// Zapytania do Open-Meteo obsługuje sama aplikacja (ma własny bufor).
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // biblioteki Firebase (wersjonowane, niezmienne) – z bufora, żeby działało bez internetu
  if (e.request.method === 'GET' && url.origin === 'https://www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(SDK_CACHE).then(c => c.put(e.request, copy)); }
      return res;
    })));
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    // no-cache: zawsze pytamy serwer o świeżą wersję (omijamy 10-min bufor HTTP GitHub Pages)
    fetch(e.request.url, { cache: 'no-cache' })
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./index.html')))
  );
});
