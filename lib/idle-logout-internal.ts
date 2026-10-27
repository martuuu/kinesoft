import "server-only";
import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { IDLE_COOKIE, idlePolicyFor, idleSignOutAction, isIdleExpiredOnServer } from "@/lib/idle-logout";
import { getSessionUser } from "@/lib/session-user";
import { SESSION_MODE_COOKIE } from "@/lib/supabase/session-mode";

/**
 * IN (§27): la parte SERVER del cierre por inactividad. Lo puro (cookie, fases, URL del sign-out) está en
 * `lib/idle-logout.ts`, que también corre en el cliente; acá va solo lo que necesita `node:crypto` o decide qué
 * renderiza el layout `(app)`.
 *
 * Por qué un tag y no el `session_id` crudo: la cookie `kine_idle` la escribe JS (no es httpOnly) y queda legible por
 * cualquier script de la página; el `session_id` de GoTrue es un identificador de la sesión que no tiene por qué
 * quedar expuesto. Con un hash recortado alcanza para distinguir «esta sesión» de «una cookie vieja de otro login en
 * este navegador» (lo único para lo que se usa) sin poder volver al id. La sal `kinesoft:idle:v1:` es fija y
 * versionada (no es un secreto: el objetivo no es autenticar, es no filtrar el id); NUNCA se renombra (§27, D-BR).
 */
export function idleSessionTag(sessionId: string): string {
  return createHash("sha256").update(`kinesoft:idle:v1:${sessionId}`).digest("hex").slice(0, 12);
}

/**
 * ¿La cookie dice que ESTA sesión venció (con la gracia de `IDLE_SERVER_GRACE_MS`)? Sin `sessionId` no hay a quién
 * atribuirle la cookie → "ok" (el server nunca echa por una cookie que no puede atribuir; ver `isIdleExpiredOnServer`).
 */
export function idleGate(p: { cookieRaw: string | null | undefined; sessionId: string | null | undefined; now: number }): "ok" | "expired" {
  if (!p.sessionId) return "ok";
  return isIdleExpiredOnServer(p.cookieRaw, p.now, idleSessionTag(p.sessionId)) ? "expired" : "ok";
}

export type IdleShellProps = { minutes: number; sessionTag: string; serverNowMs: number };

export type IdleShellState = { kind: "off" } | { kind: "expired"; minutes: number } | { kind: "on"; idle: IdleShellProps };

/**
 * Lo que decide el layout `(app)` (extraído para el unit test; el layout solo lee las cookies y el `sessionId`):
 *  - `off`: sesión persistente («Mantenerme conectado» tildado, el default) o sin `sessionId` (actor demo, token sin
 *    `session_id`): sin cierre por inactividad, como antes de IN;
 *  - `expired`: la cookie de esta sesión venció → el layout redirige a `idleLoginHref(path)` antes de cualquier loader,
 *    y el login (que ve el mismo estado) pinta `IdleExpired`, que cierra la sesión;
 *  - `on`: `AppShell` monta `IdleLogout` con los minutos, el tag y la hora del server (el cliente escribe la cookie
 *    en hora del server: si escribiera con su reloj, un equipo atrasado vencería antes en el chequeo del server).
 */
export function idleShellState(p: {
  sessionMode: string | null | undefined;
  cookieRaw: string | null | undefined;
  sessionId: string | null | undefined;
  now: number;
}): IdleShellState {
  const policy = idlePolicyFor({ sessionMode: p.sessionMode });
  if (!policy || !p.sessionId) return { kind: "off" };
  if (idleGate({ cookieRaw: p.cookieRaw, sessionId: p.sessionId, now: p.now }) === "expired") {
    return { kind: "expired", minutes: policy.minutes };
  }
  return { kind: "on", idle: { minutes: policy.minutes, sessionTag: idleSessionTag(p.sessionId), serverNowMs: p.now } };
}

/**
 * El estado de ESTE request (cookies + `sessionId` del token). `getSessionUser()` es la verificación local del JWT
 * (sin red, memoizada por request: el `tryGetActor` del layout reusa la misma), no `getVerifiedSessionUser()`: eso
 * sumaba una ida y vuelta a GoTrue a cada página con la sesión «de navegador». Solo con la política prendida se lee
 * la sesión: la persistente no paga nada.
 */
export async function readIdleShellState(now: number = Date.now()): Promise<IdleShellState> {
  const jar = cookies();
  const sessionMode = jar.get(SESSION_MODE_COOKIE)?.value;
  if (!idlePolicyFor({ sessionMode })) return { kind: "off" };
  const user = await getSessionUser();
  return idleShellState({ sessionMode, cookieRaw: jar.get(IDLE_COOKIE)?.value, sessionId: user?.sessionId ?? null, now });
}

/**
 * `/login?reason=idle&next=<path>`: el `next` interno de `idleSignOutAction` (mismas reglas de path seguro: nada de
 * `/login`, `/api/` ni externos). Es adonde redirige el layout `(app)` cuando la sesión venció.
 */
export function idleLoginHref(nextPath?: string | null): string {
  return new URL(idleSignOutAction(nextPath), "http://idle.invalid").searchParams.get("next") ?? "/login?reason=idle";
}
