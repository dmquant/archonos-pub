// ArchonOS Single-Origin PWA Service Worker (Pillar 2 & 4.1, @vibe 822c90f1)
// Invariant: Caches ONLY the public static shell in production, NEVER private chat, artifact, hand, or mesh responses.
// On localhost / 127.0.0.1 development, purges any legacy caches so updates are always live.

const CACHE_NAME = 'archon-os-public-shell-v7';
const PUBLIC_SHELL_URLS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
];

function isPublicShellRequest(request) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/workspaces/') ||
    url.pathname.startsWith('/hands/') ||
    url.pathname.startsWith('/mesh/')
  ) {
    return false;
  }
  return PUBLIC_SHELL_URLS.includes(url.pathname);
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then((clients) => {
        clients.forEach((client) => client.navigate(client.url));
      })
  );
});

self.addEventListener('fetch', (event) => {
  if (!isPublicShellRequest(event.request)) {
    return;
  }
  event.respondWith(fetch(event.request));
});
