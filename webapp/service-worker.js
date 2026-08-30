// AURA service worker — minimal by design.
// Caches only the static app shell (HTML/icons) for offline resilience.
// It deliberately does NOT cache /api/messages — chat replies must
// always be live, never served stale.
//
// IMPORTANT: this uses a network-first strategy for the shell files
// (try the network, fall back to cache only if offline). An earlier
// version used cache-first, which meant updates to index.html never
// showed up for returning visitors — they kept seeing whatever was
// cached on their very first visit, forever, even after real fixes
// were deployed. Network-first fixes that: online visitors always get
// the current version; offline visitors still get *something*.

const CACHE_NAME = 'aura-shell-v2'; // bumped so old (v1) cached files are discarded
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Never cache API calls — always go to the network for real, live replies.
  if (url.pathname.startsWith('/api/')) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
