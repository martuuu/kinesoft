/**
 * BO1-D — reporte de errores del navegador SIN el SDK de Sentry en el bundle (AUDIT §5.23: el SDK de
 * cliente no entra sin pasar por el presupuesto de bundle de C1).
 *
 * Los error boundaries (`RouteError`, `global-error`) llaman `reportClientError` una vez por error y esto
 * manda un JSON chico a `POST /api/client-errors` con `navigator.sendBeacon`; el server lo redacta y lo
 * pasa a `captureException` (logger + Sentry server si hay `SENTRY_DSN`). Así un error de render en el
 * navegador deja rastro aunque Sentry de cliente no exista.
 *
 * Reglas de este módulo:
 *   - **Nunca tira.** Se llama desde un boundary que ya está mostrando un error: si reportar rompe, el
 *     usuario queda sin la pantalla de «Reintentar».
 *   - **Sin dependencias** (ni `lib/redact`, ni zod): va al bundle de cada boundary. La redacción fuerte
 *     la hace el server; acá solo se recorta y se saca lo obvio (query string y token de `/invite/<t>`)
 *     para que ni siquiera viaje.
 *   - Lo usa también el route handler (`scrubTokenPaths`, `CLIENT_ERROR_LIMITS`, `CLIENT_ERROR_KINDS`):
 *     un solo lugar para los topes y la lista de `kind`.
 *
 * Beacon con `text/plain` y no `application/json`: Chrome rechazó durante años `sendBeacon` con un Blob de
 * tipo no «CORS-safelisted» (tira o devuelve false), y el server parsea el texto como JSON de todos modos.
 */

export const CLIENT_ERROR_ENDPOINT = "/api/client-errors";

/** Topes en caracteres. El stack a 4 KB alcanza para las primeras ~30 frames minificadas. */
export const CLIENT_ERROR_LIMITS = { message: 1024, stack: 4096, digest: 128, path: 512 } as const;

/** Qué boundary reportó. Lista cerrada: el server rechaza cualquier otro valor. */
export const CLIENT_ERROR_KINDS = [
  "global",
  "route",
  "app",
  "portal",
  "booking",
  "auth",
  "onboarding",
  "invite",
] as const;
export type ClientErrorKind = (typeof CLIENT_ERROR_KINDS)[number];

export type ClientErrorPayload = {
  message: string;
  stack?: string;
  digest?: string;
  path?: string;
  kind: ClientErrorKind;
};

/**
 * El token de invitación viaja en el PATH (`/invite/<token>`), no en la query: `redact()` cubre `?token=`
 * pero no un segmento de ruta. Se tapa acá (cliente y server) en paths, mensajes y stacks.
 */
export function scrubTokenPaths(s: string): string {
  return s.replace(/\/invite\/[^/\s?#"'`)]+/g, "/invite/[token]");
}

/** Solo el pathname, sin query ni hash, con el token tapado y recortado. */
export function scrubClientPath(path: string): string {
  const bare = path.split(/[?#]/, 1)[0] ?? "";
  return scrubTokenPaths(bare).slice(0, CLIENT_ERROR_LIMITS.path);
}

function cut(s: unknown, max: number): string | undefined {
  return typeof s === "string" && s.length > 0 ? s.slice(0, max) : undefined;
}

export function buildClientErrorPayload(
  error: unknown,
  kind: ClientErrorKind,
  pathname: string | undefined
): ClientErrorPayload {
  const e = error as { message?: unknown; stack?: unknown; digest?: unknown } | null | undefined;
  const rawMessage = e && typeof e === "object" ? e.message : error;
  const message =
    scrubTokenPaths(String(rawMessage ?? "Error desconocido")).slice(0, CLIENT_ERROR_LIMITS.message);
  const stack = cut(typeof e?.stack === "string" ? scrubTokenPaths(e.stack) : undefined, CLIENT_ERROR_LIMITS.stack);
  const digest = cut(e && typeof e === "object" ? e.digest : undefined, CLIENT_ERROR_LIMITS.digest);
  const path = pathname ? scrubClientPath(pathname) : undefined;
  const out: ClientErrorPayload = { message, kind };
  if (stack) out.stack = stack;
  if (digest) out.digest = digest;
  if (path) out.path = path;
  return out;
}

// StrictMode monta dos veces el efecto en dev y un mismo Error puede re-renderizar el boundary: un solo
// reporte por objeto de error. WeakSet: no retiene errores viejos.
let reported = new WeakSet<object>();

/** Solo tests. */
export function __resetReportedForTests(): void {
  reported = new WeakSet<object>();
}

export function reportClientError(error: unknown, context: { kind: ClientErrorKind }): void {
  try {
    if (typeof navigator === "undefined" || !navigator) return;
    if (error && typeof error === "object") {
      if (reported.has(error)) return;
      reported.add(error);
    }
    const pathname = typeof location !== "undefined" && location ? location.pathname : undefined;
    const body = JSON.stringify(buildClientErrorPayload(error, context.kind, pathname));

    let sent = false;
    try {
      if (typeof navigator.sendBeacon === "function") {
        sent = navigator.sendBeacon(
          CLIENT_ERROR_ENDPOINT,
          new Blob([body], { type: "text/plain;charset=UTF-8" })
        );
      }
    } catch {
      sent = false;
    }
    if (!sent && typeof fetch === "function") {
      // keepalive: sobrevive a que el usuario recargue justo después (lo que el boundary le sugiere).
      void fetch(CLIENT_ERROR_ENDPOINT, {
        method: "POST",
        body,
        headers: { "content-type": "text/plain;charset=UTF-8" },
        keepalive: true,
        credentials: "same-origin",
      }).catch(() => {});
    }
  } catch {
    // Reportar nunca puede romper el boundary que ya está mostrando un error.
  }
}
