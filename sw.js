// Lamnian service worker (PWA)
// - App shell opens instantly and works offline
// - Firebase scripts and Google Fonts are saved after the first visit
// - Weather, posts and sign-in always go to the network (the app keeps its own saved copy)
const V = 'lamnian-v9';
const LIBS = 'lamnian-libs-v1';
const SHELL = ['/', '/offline', '/manifest.webmanifest', '/ur.js', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/favicon-32.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== V && k !== LIBS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// The page asks for the new version to take over when the person taps "Reload".
self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

// saved copy first, refreshed in the background
function swr(req, cacheName) {
  return caches.open(cacheName).then((cache) =>
    cache.match(req).then((hit) => {
      const net = fetch(req)
        .then((res) => {
          if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
          return res;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
}

self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);

  if (u.origin !== location.origin) {
    const lib = (u.hostname === 'www.gstatic.com' && u.pathname.startsWith('/firebasejs/')) ||
                u.hostname === 'fonts.googleapis.com' || u.hostname === 'fonts.gstatic.com';
    if (lib) e.respondWith(swr(r, LIBS));
    return; // everything else (Firestore, Auth, weather APIs) goes straight to the network
  }
  if (u.pathname.startsWith('/api/') || u.pathname.startsWith('/admin')) return;
  if (u.pathname.endsWith('.apk')) return; // downloads go straight to the network

  if (r.mode === 'navigate') {
    if (u.pathname === '/' || u.pathname === '/index.html') {
      // the app itself: open the saved copy instantly, update it in the background
      e.respondWith(
        caches.open(V).then((cache) =>
          cache.match('/').then((hit) => {
            const net = fetch(r).then((res) => {
              if (res.ok && !res.redirected) cache.put('/', res.clone());
              return res;
            });
            if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
            return net.catch(() => caches.match('/offline'));
          })
        )
      );
    } else {
      e.respondWith(fetch(r).catch(() => caches.match('/offline')));
    }
    return;
  }

  e.respondWith(swr(r, V));
});
