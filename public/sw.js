/* KineSoft SW (MB-0a). Solo instalación + página sin conexión. NO cachea navegaciones, RSC, /api ni actions:
 * en una PC compartida de recepción quedarían datos de pacientes en disco. Los estáticos de /_next/static ya son
 * inmutables y los cachea el navegador: el SW no los toca (cache-first acá = deploys viejos pegados). */
const VERSION = "ks-sw-v1";
const OFFLINE_URL = "/offline.html";
const PRECACHE = [OFFLINE_URL, "/icons/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || req.mode !== "navigate") return; // todo lo demás va directo a la red
  if (new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(fetch(req).catch(() => caches.match(OFFLINE_URL)));
});
