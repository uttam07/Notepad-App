/* Steno service worker — cache-first, offline capable */
const CACHE = "steno-v19";
const ASSETS = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/app.js",
  "./js/highlighter.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => clients.claim())
  );
});

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  const sameOrigin = url.origin === location.origin;
  // App shell (html/css/js) → network-first so updates land immediately,
  // falling back to cache when offline. Everything else → cache-first.
  const isShell = sameOrigin && /\.(html|css|js|webmanifest)$|\/$/.test(url.pathname);
  if (isShell) {
    e.respondWith(
      fetch(e.request).then(resp => {
        if (resp.ok) { const copy = resp.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
        return resp;
      }).catch(() => caches.match(e.request, { ignoreSearch: true })
        .then(hit => hit || caches.match("./index.html")))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(hit => {
      if (hit) return hit;
      return fetch(e.request).then(resp => {
        if (resp.ok && (sameOrigin || e.request.url.startsWith("https://fonts.g"))) {
          const copy = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return resp;
      });
    })
  );
});
