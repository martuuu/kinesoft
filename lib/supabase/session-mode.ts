import type { CookieOptions } from "@supabase/ssr";

/**
 * «Mantenerme conectado» (tanda B, §22.13 punto 2; reemplaza el «no se implementa ahora» del 15-oct, §20.5).
 *
 * Puro y sin imports de Node: lo usan `lib/supabase/server.ts`, el middleware (Edge) y la ruta de sign-in.
 *
 * - **Tildado (default) = como siempre**: las cookies `sb-<ref>-auth-token*` salen con el `maxAge` de `@supabase/ssr`
 *   (400 días; el refresh token es el que vence de verdad).
 * - **Destildado = sesión de navegador**: las mismas cookies salen SIN `maxAge`/`expires`, así el navegador las borra
 *   al cerrarse. La preferencia viaja en `kine_session_mode=ephemeral` (httpOnly) para que cada reescritura posterior
 *   de la sesión (el refresh del middleware cada hora, `mfa.verify`, etc.) siga siendo de navegador: sin ella, el
 *   primer refresh volvía a escribir los 400 días y la casilla no servía de nada.
 *
 * `@supabase/ssr` 0.5 **pisa** el `maxAge` que se le pase en `cookieOptions` (`setCookieOptions = { …, maxAge:
 * DEFAULT_COOKIE_OPTIONS.maxAge }`, `dist/main/cookies.js`), así que la política no puede ir en `cookieOptions`: se
 * aplica en el `setAll` de cada cliente, cookie por cookie.
 *
 * Decisiones con default:
 *   - `kine_session_mode` es también cookie de sesión (sin `maxAge`), no «corta» con un vencimiento fijo: si venciera
 *     antes de cerrar el navegador, el siguiente refresh volvería a persistir la sesión. Vive exactamente lo mismo que
 *     las cookies de Supabase que gobierna.
 *   - Un POST de login SIN el campo (página de login cacheada de antes del deploy, un cliente viejo) = persistente,
 *     como antes. Por eso el form manda un hidden `remember=0` y el checkbox `remember=1`: «destildado» es ver el `0`
 *     sin el `1`, no la ausencia del campo.
 *   - Google/Facebook (OAuth) siempre persistente (pedido de Martin): no pasan por la casilla.
 *   - Límite conocido: Chrome/Edge con «Continuar donde lo dejaste» restauran las cookies de sesión al reabrir. Es
 *     del navegador; el cierre por inactividad para PCs compartidas sigue en el backlog C.
 */

export const SESSION_MODE_COOKIE = "kine_session_mode";

export type SessionMode = "persistent" | "ephemeral";

/** Valor de la cookie → modo. Cualquier cosa que no sea exactamente `ephemeral` = persistente (falla a lo de antes). */
export function sessionModeFromCookie(value: string | null | undefined): SessionMode {
  return value === "ephemeral" ? "ephemeral" : "persistent";
}

/** Valores del campo `remember` del form de login (hidden `0` + checkbox `1`). */
export function sessionModeFromForm(values: readonly unknown[]): SessionMode {
  const v = values.map((x) => String(x));
  if (v.includes("1")) return "persistent";
  return v.includes("0") ? "ephemeral" : "persistent";
}

/** ¿Estas opciones BORRAN la cookie? (`@supabase/ssr` borra con `maxAge: 0`). Un borrado no se toca. */
function isRemoval(o: Partial<CookieOptions>): boolean {
  if (typeof o.maxAge === "number" && o.maxAge <= 0) return true;
  if (o.expires instanceof Date && o.expires.getTime() <= Date.now()) return true;
  return false;
}

/**
 * Opciones finales de una cookie de sesión de Supabase según el modo. En `ephemeral` saca `maxAge` y `expires` (=
 * cookie de sesión del navegador); los borrados pasan intactos (si se les sacara el `maxAge: 0`, el «borrar» pasaría a
 * ser «dejar vacía hasta cerrar»). En `persistent`, idénticas.
 */
export function applySessionCookiePolicy<T extends Partial<CookieOptions>>(options: T, mode: SessionMode): T {
  if (mode === "persistent" || isRemoval(options)) return options;
  const rest = { ...options };
  delete rest.maxAge;
  delete rest.expires;
  return rest;
}

/**
 * La cookie de preferencia que escribe el login: `ephemeral` la setea (sin vencimiento), `persistent` la borra (por
 * si otra persona usó «no mantener» antes en este navegador). Mismos flags que las de Supabase (`cookie-options.ts`).
 */
export function sessionModeCookie(mode: SessionMode): {
  name: string;
  value: string;
  options: { path: string; httpOnly: true; secure: boolean; sameSite: "lax"; maxAge?: number };
} {
  const base = { path: "/", httpOnly: true as const, secure: process.env.NODE_ENV === "production", sameSite: "lax" as const };
  return mode === "ephemeral"
    ? { name: SESSION_MODE_COOKIE, value: "ephemeral", options: base }
    : { name: SESSION_MODE_COOKIE, value: "", options: { ...base, maxAge: 0 } };
}
