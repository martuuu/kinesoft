/* Service worker de la app (MB-0a). El nombre del cache (`VERSION`) NO cambia con la marca: renombrarlo dejaría
 * cachés huérfanos en cada instalación. Solo instalación + página sin conexión. NO cachea navegaciones, RSC, /api ni actions:
 * en una PC compartida de recepción quedarían datos de pacientes en disco. Los estáticos de /_next/static ya son
 * inmutables y los cachea el navegador: el SW no los toca (cache-first acá = deploys viejos pegados).
 * CF2 (D-CF2-11) suma `push` y `notificationclick` (avisos de turnos online al profesional): no cachean nada ni piden
 * datos a la red; el payload ya trae lo que se muestra. Por eso `VERSION` no cambia. */
const VERSION = "ks-sw-v2";
const OFFLINE_URL = "/offline.html";
// [CF-UI1 · H] `?v=2` = el mismo ícono que declara `app/manifest.ts`: una URL nueva fuerza a bajar el PNG con la marca
// actual sin tocar `VERSION` (preservado [BR-9]); el activate igual no borra nada porque el nombre del cache no cambia,
// así que la entrada vieja queda huérfana pero inofensiva (un PNG de 192 px) hasta que el navegador la desaloje.
const PRECACHE = [OFFLINE_URL, "/icons/icon-192.png?v=2"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      // MB-Z (revisor de código, L2): navigation preload para que la navegación no espere al arranque del SW.
      .then(() => (self.registration && self.registration.navigationPreload ? self.registration.navigationPreload.enable() : undefined))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || req.mode !== "navigate") return; // todo lo demás va directo a la red
  if (new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    (async () => {
      try {
        return (await event.preloadResponse) || (await fetch(req));
      } catch {
        // Si la caché se purgó, error de red del navegador en vez de `undefined` (que rompe el respondWith).
        return (await caches.match(OFFLINE_URL)) || Response.error();
      }
    })()
  );
});

// ── Avisos push (CF2, D-CF2-11) ─────────────────────────────────────────────────────────────────────────────────────
// El server (`lib/web-push-internal.ts`) manda `{ title, body, url, tag? }` armado por `bookingPushPayload`
// (`lib/booking-pro-notify-logic.ts`): sin el nombre del paciente, porque la notificación se ve en la pantalla bloqueada.
const PUSH_ICON = "/icons/icon-192.png?v=2"; // el mismo del precache y del manifest
const PUSH_FALLBACK_URL = "/dashboard";
// Título genérico si el payload viene roto. Sin la marca a propósito: el literal vive solo en `lib/brand.ts`
// (`tests/unit/brand-literal.test.ts` escanea `public/`) y el SW no puede importarlo.
const PUSH_FALLBACK_TITLE = "Tenés un aviso nuevo";

/** Texto de afuera en una línea, recortado a `max` con «…». Lo que no es string queda vacío. */
function pushText(v, max) {
  if (typeof v !== "string") return "";
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, max - 1).join("").trimEnd() + "…";
}

/**
 * Solo un path del MISMO origen; si no, `/dashboard`. `//host` y `/\host` el navegador los lee como otro host
 * (protocol-relative), y un control en el medio puede partir la URL: los tres se rechazan antes de resolver, y después
 * se confirma el origen. Así un payload adulterado no manda al profesional a una página de phishing con un click.
 */
function safePushUrl(raw) {
  if (typeof raw !== "string" || raw.charAt(0) !== "/" || raw.charAt(1) === "/" || /[\\\u0000-\u001f\u007f]/.test(raw)) {
    return PUSH_FALLBACK_URL;
  }
  try {
    const u = new URL(raw, self.location.origin);
    return u.origin === self.location.origin ? u.pathname + u.search + u.hash : PUSH_FALLBACK_URL;
  } catch {
    return PUSH_FALLBACK_URL;
  }
}

self.addEventListener("push", (event) => {
  // SIEMPRE una notificación, aunque el payload venga roto: la suscripción es `userVisibleOnly` y un push sin nada
  // visible lo penaliza el navegador (Chrome muestra un aviso genérico propio; Safari revoca la suscripción).
  let data = null;
  try {
    data = event.data ? event.data.json() : null;
  } catch {
    data = null;
  }
  if (!data || typeof data !== "object") data = {};
  const options = {
    body: pushText(data.body, 160),
    icon: PUSH_ICON,
    data: { url: safePushUrl(data.url) },
  };
  const tag = pushText(data.tag, 64);
  if (tag) options.tag = tag; // mismo turno = mismo tag: un reintento reemplaza el aviso en vez de duplicarlo
  event.waitUntil(self.registration.showNotification(pushText(data.title, 80) || PUSH_FALLBACK_TITLE, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // Se vuelve a sanear: `data` lo escribió este mismo SW, pero no cuesta nada y cubre notificaciones de una versión vieja.
  const url = safePushUrl(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of windows) {
        let sameOrigin = false;
        try {
          sameOrigin = new URL(w.url).origin === self.location.origin;
        } catch {
          sameOrigin = false;
        }
        if (!sameOrigin) continue;
        // Enfocar primero (el gesto del click habilita el foco solo dentro de este handler) y después navegar.
        // `navigate` falla si la ventana no está controlada por este SW (abierta antes de instalarlo): ahí, ventana nueva.
        try {
          const focused = (await w.focus()) || w;
          await focused.navigate(url);
          return;
        } catch {
          break;
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(url);
    })()
  );
});
