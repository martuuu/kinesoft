/**
 * PV (§27, IN; contrato de PV-K): cierre de sesión por inactividad, la parte PURA.
 *
 * Política: quien destildó «Mantenerme conectado» (`kine_session_mode=ephemeral`, `lib/supabase/session-mode.ts`) está
 * en una compu compartida; la cookie de navegador no alcanza (Chrome «Continuar donde lo dejaste» la restaura y la
 * pestaña puede quedar abierta horas en la recepción). A los 15 min sin uso se cierra la sesión.
 *
 * Cookie `kine_idle = "<lastSec>.<minutes>.<tag>"`: la escribe el cliente (no httpOnly) en hora del SERVER, la leen las
 * otras pestañas (sincronización) y el layout `(app)` en el server (si venció, no se renderiza `AppShell` ni datos).
 * `tag` lo calcula el server a partir del `sessionId` (`lib/idle-logout-internal.ts`): una cookie vieja de OTRA sesión
 * (otro login en el mismo navegador) no puede cerrar la actual.
 *
 * PURO y SIN imports: lo usa el cliente (`components/layout/idle-logout.tsx`) y el server, y el chequeo del path de
 * `idleSignOutAction` replica `safeNext` (`lib/safe-next.ts`) en vez de importarlo para mantener el módulo sin
 * dependencias; `tests/unit/pv-k-idle.test.ts` verifica que la ruta de sign-out acepte lo que se arma acá.
 */

export const IDLE_COOKIE = "kine_idle";
export const IDLE_DEFAULT_MINUTES = 15;
/** El aviso «¿Seguís ahí?» aparece 60 s antes del cierre. */
export const IDLE_WARNING_MS = 60_000;
/**
 * Gracia del chequeo del server: el cliente cierra en T; el server recién bloquea en T+60 s. Cubre el desfase entre la
 * última escritura de la cookie (como mucho cada 5 s) y un request que sale justo en el borde: nunca le tiramos la
 * pantalla a alguien que el cliente todavía considera activo.
 */
export const IDLE_SERVER_GRACE_MS = 60_000;
/** `BroadcastChannel` entre pestañas: solo acelera, la verdad es la cookie. */
export const IDLE_CHANNEL = "kine-idle";

/** Límites de `minutes` al leer la cookie: la escribe el cliente, así que un valor editado a mano se acota. */
const MIN_MINUTES = 5;
const MAX_MINUTES = 480;

/** Mismo modo que `SessionMode` de `lib/supabase/session-mode.ts` (sin importarlo: este módulo no tiene imports). */
type IdleSessionMode = "persistent" | "ephemeral";

/** Solo la sesión «de navegador» se cierra por inactividad; la persistente (default) sigue como siempre. */
export function idlePolicyFor(p: { sessionMode: IdleSessionMode | string | null | undefined }): { minutes: number } | null {
  return p.sessionMode === "ephemeral" ? { minutes: IDLE_DEFAULT_MINUTES } : null;
}

function clampMinutes(m: number): number {
  return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.trunc(m)));
}

const TAG_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** `lastMs` se guarda en segundos (la cookie es más corta y la resolución de 1 s alcanza). */
export function serializeIdleCookie(lastMs: number, minutes: number, tag: string): string {
  return `${Math.floor(lastMs / 1000)}.${clampMinutes(minutes)}.${tag}`;
}

export type IdleCookie = { lastMs: number; minutes: number; tag: string };

/** Cookie cruda → valor. Cualquier cosa que no tenga exactamente la forma `<entero>.<entero>.<tag>` → null. */
export function parseIdleCookie(raw: string | null | undefined): IdleCookie | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 128) return null;
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const [secS, minS, tag] = parts;
  if (!/^\d{1,12}$/.test(secS) || !/^\d{1,6}$/.test(minS) || !TAG_RE.test(tag)) return null;
  const sec = Number(secS);
  if (sec <= 0) return null;
  return { lastMs: sec * 1000, minutes: clampMinutes(Number(minS)), tag };
}

function deadlineOf(lastMs: number, minutes: number): number {
  return lastMs + minutes * 60_000;
}

/** `warning` desde T−60 s inclusive; `expired` en T (inclusive). */
export function idlePhase(nowMs: number, lastMs: number, minutes: number): "active" | "warning" | "expired" {
  const deadline = deadlineOf(lastMs, minutes);
  if (nowMs >= deadline) return "expired";
  return nowMs >= deadline - IDLE_WARNING_MS ? "warning" : "active";
}

/** Segundos que faltan para el cierre, redondeado hacia arriba (el contador muestra 60 en T−60 s y nunca 0 antes de T). */
export function secondsLeft(nowMs: number, lastMs: number, minutes: number): number {
  return Math.max(0, Math.ceil((deadlineOf(lastMs, minutes) - nowMs) / 1000));
}

/**
 * Chequeo del server. Solo cierra si la cookie es de ESTA sesión (`tag`) y venció con la gracia. Sin cookie, ilegible
 * o de otra sesión → false: el server nunca echa a alguien por una cookie que no puede atribuirle (el cliente la
 * reescribe en el primer tick).
 */
export function isIdleExpiredOnServer(raw: string | null | undefined, nowMs: number, tag: string): boolean {
  const c = parseIdleCookie(raw);
  if (!c || c.tag !== tag) return false;
  return nowMs >= deadlineOf(c.lastMs, c.minutes) + IDLE_SERVER_GRACE_MS;
}

/**
 * Path al que volver después de ingresar. Mismas reglas que `safeNext` (open redirect) y, además, nada de `/login` ni
 * `/api/` (volver al login o a una ruta de API después de loguearse no tiene sentido y el sign-out podría encadenarse).
 */
function isSafeReturnPath(p: string): boolean {
  if (p.length === 0 || p.length > 1024) return false;
  if (!p.startsWith("/") || p.startsWith("//") || p.includes("\\")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f-\u009f]/.test(p)) return false;
  if (p === "/login" || p.startsWith("/login?") || p.startsWith("/login/") || p.startsWith("/api/")) return false;
  try {
    const base = "http://idle.invalid";
    return new URL(p, base).origin === base;
  } catch {
    return false;
  }
}

/**
 * URL del POST de sign-out por inactividad. La ruta (`app/api/auth/sign-out/route.ts`) hace
 * `safeNext(searchParams.get("next"), "/login")`, así que el `next` externo es `/login?reason=idle&next=<path>` con el
 * path encodeado adentro y todo encodeado otra vez afuera. Path inseguro o ausente → sin `next` interno.
 */
export function idleSignOutAction(nextPath?: string | null): string {
  const login =
    typeof nextPath === "string" && isSafeReturnPath(nextPath)
      ? `/login?reason=idle&next=${encodeURIComponent(nextPath)}`
      : "/login?reason=idle";
  return `/api/auth/sign-out?next=${encodeURIComponent(login)}`;
}
