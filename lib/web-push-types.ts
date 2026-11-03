/**
 * CF2 (§29, D-CF2-12, brief T.C «Push»): tipos, constantes y lógica PURA del push web al profesional.
 *
 * Sin imports a propósito: lo usan el sender (`lib/web-push-internal.ts`, server-only), las actions de dispositivos, el
 * cliente de «Mi agenda» (botón «Activar en este dispositivo») y los tests. Nada de acá puede arrastrar Prisma, `web-push`
 * ni `lib/env.ts` a un bundle de cliente.
 */

/** Lo que viaja cifrado al service worker (`public/sw.js` lo vuelve a recortar: el SW no confía en el server). */
export type PushPayload = { title: string; body: string; url: string; tag?: string };

/** Resultado de `sendPushToUser`. `removed` cuenta filas borradas (404/410 o la 5.ª falla seguida, que también suma a `failed`). */
export type PushSendResult = { sent: number; removed: number; failed: number };

/** Lo que guarda `savePushSubscription` (la forma de `PushSubscription.toJSON()` del navegador, sin `expirationTime`). */
export type PushSubscriptionInput = { endpoint: string; keys: { p256dh: string; auth: string } };

/** Un dispositivo en «Mi agenda › Avisos de turnos online». `current` = el de la cookie `ks_push_sub` de este navegador. */
export type PushDeviceView = {
  id: string;
  label: string | null;
  createdAt: string;
  lastSuccessAt: string | null;
  current: boolean;
};

// Un aviso de turno vale mientras el turno no pasó, pero uno de hace horas confunde: si el teléfono estuvo apagado más
// de una hora, el push service lo descarta y queda el mail.
export const PUSH_TTL_SECONDS = 3600;
// El sender corre DESPUÉS del commit de la reserva y el submit lo espera antes de responder (brief T.C «Orden»): un
// push service lento no puede demorar la pantalla de «Turno reservado» más que esto.
export const PUSH_SEND_TIMEOUT_MS = 2500;
/** D-CF2-12: con 5 fallas seguidas (≠ 404/410) el dispositivo se descarta. */
export const PUSH_MAX_FAILURES = 5;
/** D-CF2-12: hasta 10 dispositivos por usuario (lo aplica `savePushSubscription`). */
export const PUSH_MAX_DEVICES_PER_USER = 10;
/** Cookie httpOnly con el id del dispositivo de este navegador: la usa el sign-out para borrarlo (D-CF2-12). */
export const PUSH_SUB_COOKIE = "ks_push_sub";
/** CHECKs de M21 (`PushSubscription_endpoint_check` / `_label_check`). */
export const PUSH_ENDPOINT_MAX = 1024;
export const PUSH_LABEL_MAX = 60;

const PUSH_TITLE_MAX = 80;
// Igual que el recorte del service worker (`public/sw.js`, `pushText(data.body, 160)`): lo que se manda es lo que se ve.
const PUSH_BODY_MAX = 160;
const PUSH_TAG_MAX = 64;
export const PUSH_FALLBACK_URL = "/dashboard";

// Mismas expresiones que `PushSubscription_keys_check` (M21): lo que pasa acá entra a la base sin 23514.
const P256DH_SHAPE = /^[A-Za-z0-9_-]{80,100}={0,2}$/;
const AUTH_SHAPE = /^[A-Za-z0-9_-]{16,32}={0,2}$/;

/**
 * Servicios push de los navegadores que soportamos (Chrome/Edge/Opera/Samsung → FCM, Firefox → Mozilla, Safari →
 * Apple, Edge legado → WNS). Por qué una lista: el server le hace un POST al `endpoint` que manda el navegador; sin
 * lista, cualquier usuario logueado podría registrar `https://10.0.0.5/…` o un host suyo y hacer que la lambda pegue
 * donde él quiera (SSRF ciego). Un navegador con otro servicio queda sin push (le sigue llegando el mail).
 */
const PUSH_HOSTS_EXACT = new Set(["fcm.googleapis.com", "android.googleapis.com", "push.services.mozilla.com"]);
const PUSH_HOST_SUFFIXES = [".push.services.mozilla.com", ".push.apple.com", ".notify.windows.com"];

export function isKnownPushServiceHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return PUSH_HOSTS_EXACT.has(h) || PUSH_HOST_SUFFIXES.some((s) => h.endsWith(s) && h.length > s.length);
}

export type ParsedPushSubscription =
  | { ok: true; value: PushSubscriptionInput }
  | { ok: false; reason: "shape" | "endpoint" | "keys" };

/**
 * Valida lo que manda el cliente (`subscription.toJSON()`): no confía en nada. `shape` = no tiene la forma;
 * `endpoint` = no es https, pasa de 1024, trae credenciales o no es de un servicio push conocido; `keys` = no pasan el
 * CHECK de M21. Devuelve solo los campos que se guardan.
 */
export function parsePushSubscriptionInput(raw: unknown): ParsedPushSubscription {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "shape" };
  const r = raw as { endpoint?: unknown; keys?: unknown };
  const keys = r.keys as { p256dh?: unknown; auth?: unknown } | null | undefined;
  if (typeof r.endpoint !== "string" || !keys || typeof keys !== "object") return { ok: false, reason: "shape" };
  if (typeof keys.p256dh !== "string" || typeof keys.auth !== "string") return { ok: false, reason: "shape" };

  const endpoint = r.endpoint.trim();
  if (endpoint.length > PUSH_ENDPOINT_MAX || !endpoint.startsWith("https://")) return { ok: false, reason: "endpoint" };
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, reason: "endpoint" };
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || !isKnownPushServiceHost(url.hostname)) {
    return { ok: false, reason: "endpoint" };
  }
  if (!P256DH_SHAPE.test(keys.p256dh) || !AUTH_SHAPE.test(keys.auth)) return { ok: false, reason: "keys" };
  return { ok: true, value: { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } } };
}

/**
 * Etiqueta legible del dispositivo para la lista de «Mi agenda» («Chrome en Android»). Solo orientativa (el UA se
 * puede falsear y no decide nada). El orden de los navegadores importa: Edge, Opera y Samsung también dicen «Chrome»,
 * y todos dicen «Safari». En iOS todos son WebKit, pero el usuario reconoce la marca (CriOS → Chrome).
 */
export function pushDeviceLabel(ua: string | null | undefined): string {
  const s = (ua ?? "").slice(0, 1024);
  const browser = /EdgiOS|EdgA\/|Edg\//.test(s)
    ? "Edge"
    : /OPR\/|OPiOS|Opera/.test(s)
      ? "Opera"
      : /SamsungBrowser/.test(s)
        ? "Samsung Internet"
        : /FxiOS|Firefox\//.test(s)
          ? "Firefox"
          : /CriOS|Chrome\/|Chromium\//.test(s)
            ? "Chrome"
            : /AppleWebKit/.test(s) && /iPhone|iPad|iPod|Macintosh/.test(s)
              ? "Safari"
              : null;
  const os = /Android/.test(s)
    ? "Android"
    : /iPhone|iPod/.test(s)
      ? "iPhone"
      : /iPad/.test(s)
        ? "iPad"
        : /CrOS/.test(s)
          ? "ChromeOS"
          : /Windows/.test(s)
            ? "Windows"
            : /Macintosh|Mac OS X/.test(s)
              ? "Mac"
              : /Linux/.test(s)
                ? "Linux"
                : null;
  const label = browser && os ? `${browser} en ${os}` : browser ? browser : os ? `Navegador en ${os}` : "Navegador";
  return label.slice(0, PUSH_LABEL_MAX);
}

/** iPhone/iPod/iPad, incluido iPadOS ≥ 13, que se presenta como Mac de escritorio (lo delata el táctil). */
export function isIosDevice(userAgent: string, maxTouchPoints = 0): boolean {
  if (/iPhone|iPad|iPod/.test(userAgent)) return true;
  return /Macintosh/.test(userAgent) && maxTouchPoints > 1;
}

export type PushPermission = "default" | "granted" | "denied";
export type PushSupportState = "ready" | "needs-install-ios" | "unsupported" | "denied" | "granted";

/** Lo que el cliente lee del navegador (`navigator`, `window`, `Notification.permission`); acá no se toca ningún global. */
export type PushSupportInput = {
  userAgent: string;
  maxTouchPoints?: number;
  /** `matchMedia("(display-mode: standalone)").matches || navigator.standalone`. */
  standalone: boolean;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  permission: PushPermission | null;
};

/**
 * Qué puede mostrar «Avisos de turnos online › Este dispositivo».
 *   needs-install-ios = iPhone/iPad en una pestaña: Safari solo da push a la app instalada (iOS ≥ 16.4), y en la
 *                       pestaña ni siquiera existe `PushManager`; por eso va ANTES del chequeo de soporte (si no, le
 *                       diríamos «no soportado» a alguien que con instalar la app lo tiene).
 *   unsupported       = falta service worker, PushManager o Notification (o iOS instalado pero viejo).
 *   denied / granted  = el permiso ya se decidió (denied solo se cambia desde el navegador).
 *   ready             = se puede pedir el permiso al tocar «Activar en este dispositivo».
 */
export function pushSupportState(i: PushSupportInput): PushSupportState {
  if (isIosDevice(i.userAgent, i.maxTouchPoints) && !i.standalone) return "needs-install-ios";
  if (!i.hasServiceWorker || !i.hasPushManager || !i.hasNotification) return "unsupported";
  if (i.permission === "denied") return "denied";
  if (i.permission === "granted") return "granted";
  return "ready";
}

/** Solo rutas del mismo origen: `/x`, nunca `//host`, `/\host` (los navegadores lo leen como `//`) ni un esquema. */
function sameOriginPath(url: string): string {
  return url.startsWith("/") && !url.startsWith("//") && !url.startsWith("/\\") ? url : PUSH_FALLBACK_URL;
}

/**
 * Recorte antes de cifrar: el payload cifrado tiene un techo de ~4 KB en los push services (413 si se pasa) y la
 * notificación del sistema corta igual. La URL fuera del origen cae al panel (el SW repite el chequeo).
 */
export function clampPushPayload(p: PushPayload): PushPayload {
  const out: PushPayload = {
    title: p.title.slice(0, PUSH_TITLE_MAX),
    body: p.body.slice(0, PUSH_BODY_MAX),
    url: sameOriginPath(p.url.slice(0, 512)),
  };
  if (p.tag) out.tag = p.tag.slice(0, PUSH_TAG_MAX);
  return out;
}
