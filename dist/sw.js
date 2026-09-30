const CACHE_NAME = "nagarnetra-assets-v4";
// Do not cache index.html in the service worker. Netlify deploys use hashed
// assets, so a cached HTML document can otherwise reference files removed by a
// newer deployment. The browser's normal HTTP cache still handles those assets.
const APP_SHELL = ["/manifest.webmanifest", "/pwa-icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

// Requests are deliberately not intercepted. This prevents stale HTML and
// avoids cloning a response after its body has been consumed. Netlify's CDN and
// the browser cache continue to cache fingerprinted JavaScript/CSS efficiently.
