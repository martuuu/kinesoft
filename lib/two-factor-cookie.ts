import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { env } from "@/lib/env";
import { SESSION_PROOF_TTL_S, STEP_UP_TTL_S } from "@/lib/two-factor-logic";

/**
 * Pruebas de 2FA propias (PL-1e, C-PL6; molde `lib/platform-reauth.ts`).
 *
 * - `kine_2fa` («prueba de sesión»): la sesión pasó el segundo factor por un camino que NO sube el `aal` de Supabase
 *   (código por email o código de recuperación). La lee la foto de acceso (`lib/session.ts`) en cada request en el
 *   que el usuario tiene la 2FA prendida; sin ella (y sin AAL2) el actor no se arma.
 * - `kine_stepup` (step-up, 10 min, PL-D11): re-verificación reciente para las acciones de riesgo (cambiar plan,
 *   débito, titularidad, permisos, apagar 2FA). La consulta `requireStepUp` (PL-2a).
 *
 * Valor `<kind>.<userId>.<sessionId>.<expEpochSeconds>.<hmac>`:
 *  - firmado (un flag suelto lo fabricaría cualquiera desde la consola del browser);
 *  - ligado al userId Y al `session_id` del JWT: otro usuario en el mismo browser, o un nuevo login del mismo
 *    usuario (sesión nueva), no hereda la prueba. Cerrar sesión la invalida aunque la cookie quede;
 *  - el `kind` va dentro del HMAC: una cookie de un tipo nunca valida como la otra (y la clave tiene etiqueta propia,
 *    distinta de recovery y de platform-reauth);
 *  - comparación en tiempo constante; un `exp` más lejos que el TTL no lo emitimos nunca → se rechaza.
 *
 * Por qué cookie y no el `amr` del JWT: mismo motivo que platform-reauth (el timestamp del `amr` depende de cómo
 * GoTrue lo reescribe en cada refresh; la cookie es nuestra, vence exacto y el test la cubre entera).
 */
export const TWO_FACTOR_COOKIE = "kine_2fa";
export const STEP_UP_COOKIE = "kine_stepup";

export type TwoFactorProofKind = "session" | "step_up";

const TTL_S: Record<TwoFactorProofKind, number> = { session: SESSION_PROOF_TTL_S, step_up: STEP_UP_TTL_S };
const TAG: Record<TwoFactorProofKind, string> = { session: "2fa", step_up: "stepup" };
const COOKIE_OF: Record<TwoFactorProofKind, string> = { session: TWO_FACTOR_COOKIE, step_up: STEP_UP_COOKIE };

let devKey: Buffer | null = null;
function hmacKey(): Buffer {
  const base = env.SUPABASE_SERVICE_ROLE_KEY;
  if (base) return createHmac("sha256", base).update("kinesoft:two-factor:v1").digest();
  // Dev local sin service key: clave aleatoria por proceso (reiniciar el server pide la 2FA de nuevo).
  devKey ??= randomBytes(32);
  return devKey;
}

function sign(tag: string, userId: string, sessionId: string, exp: number): string {
  return createHmac("sha256", hmacKey()).update(`${tag}.${userId}.${sessionId}.${exp}`).digest("base64url");
}

/** Ids de Supabase (UUID) sin puntos: uno con puntos no se puede partir sin ambigüedad. */
function okId(v: string): boolean {
  return v.length > 0 && v.length <= 128 && !v.includes(".");
}

export function makeTwoFactorProofValue(
  kind: TwoFactorProofKind,
  userId: string,
  sessionId: string,
  nowMs = Date.now()
): string {
  if (!okId(userId) || !okId(sessionId)) throw new Error("[two-factor-cookie] id inválido");
  const exp = Math.floor(nowMs / 1000) + TTL_S[kind];
  return `${TAG[kind]}.${userId}.${sessionId}.${exp}.${sign(TAG[kind], userId, sessionId, exp)}`;
}

/**
 * true solo si la cookie es del `kind` pedido, de ESTE usuario y de ESTA sesión, firmada por nosotros y vigente.
 * Sin `sessionId` (no se pudo leer del token) → false: la prueba no se puede ligar a nada.
 */
export function verifySessionProof(
  value: string | null | undefined,
  userId: string,
  sessionId: string | null,
  kind: TwoFactorProofKind,
  nowMs = Date.now()
): boolean {
  if (!value || !sessionId) return false;
  const parts = value.split(".");
  if (parts.length !== 5) return false;
  const [tag, uid, sid, expRaw, mac] = parts;
  if (tag !== TAG[kind] || uid !== userId || sid !== sessionId) return false;
  const exp = Number(expRaw);
  if (!Number.isInteger(exp) || exp * 1000 <= nowMs) return false;
  if (exp * 1000 > nowMs + TTL_S[kind] * 1000 + 5_000) return false;
  const expected = Buffer.from(sign(tag, uid, sid, exp));
  const got = Buffer.from(mac);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

function readCookie(name: string): string | undefined {
  try {
    return cookies().get(name)?.value;
  } catch {
    return undefined; // fuera de un request
  }
}

/** ¿Este request trae la prueba de sesión de 2FA de `userId` en `sessionId`? */
export function hasSessionProof(userId: string, sessionId: string | null): boolean {
  return verifySessionProof(readCookie(TWO_FACTOR_COOKIE), userId, sessionId, "session");
}

/** ¿Este request trae un step-up vigente (< 10 min) de `userId` en `sessionId`? Fuera de un request → false. */
export function hasFreshStepUp(userId: string, sessionId: string | null): boolean {
  return verifySessionProof(readCookie(STEP_UP_COOKIE), userId, sessionId, "step_up");
}

function setProof(kind: TwoFactorProofKind, userId: string, sessionId: string): void {
  cookies().set(COOKIE_OF[kind], makeTwoFactorProofValue(kind, userId, sessionId), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    // `kine_2fa` tiene que viajar en la navegación top-level que llega de un link externo (mail de un turno, etc.):
    // con `strict` el layout no la vería y mandaría a /verificar-acceso aunque ya se verificó. El step-up solo lo
    // leen server actions (POST same-origin): `strict`.
    sameSite: kind === "session" ? "lax" : "strict",
    // Toda la app: el gate de `(app)`, /cuenta/seguridad y las actions de Configuración y Plataforma.
    path: "/",
    maxAge: TTL_S[kind],
  });
}

/** Solo desde una server action / route handler (en un server component `cookies().set` tira). */
export function setSessionProofCookie(userId: string, sessionId: string): void {
  setProof("session", userId, sessionId);
}

/** Solo desde una server action / route handler. */
export function setStepUpCookie(userId: string, sessionId: string): void {
  setProof("step_up", userId, sessionId);
}

/** Logout, reset de la 2FA o apagarla: borra las dos. Nunca tira (fuera de una action `delete` puede tirar). */
export function clearTwoFactorCookies(): void {
  for (const name of [TWO_FACTOR_COOKIE, STEP_UP_COOKIE]) {
    try {
      cookies().delete(name);
    } catch {
      // server component o fuera de un request: nada que borrar desde acá.
    }
  }
}
