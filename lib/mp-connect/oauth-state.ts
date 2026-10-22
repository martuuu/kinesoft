import "server-only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { MP_OAUTH_COOKIE_PATH } from "@/lib/mp-connect/constants";

/**
 * State del OAuth de Mercado Pago + PKCE (T5 TP-P2; brief §25.4 «Conectar (C-TP4)», Anexo B C-TP3; molde
 * `lib/portal-invite-token.ts` y `lib/recovery-cookie.ts`).
 *
 * Flujo: `startMpConnect` (TP-2b) llama a `makeOAuthState` → setea la cookie `kine_mp_oauth` con `cookie` y manda
 * `state` + `code_challenge` a MP; el callback recibe `?state=` y `?code=`, lee la cookie con `readOAuthState` y canjea
 * el código con `pkceVerifierFrom(claims.nonce)`.
 *
 * Por qué así:
 *  - La cookie está FIRMADA (HMAC-SHA256, clave derivada de `SUPABASE_SERVICE_ROLE_KEY` con etiqueta propia
 *    `kinesoft:mp-oauth-state:v1`): sin firma, quien tenga una sesión podría fabricarse una cookie que dice «conectá
 *    esta cuenta MP al consultorio X» o como «clinic». Un valor firmado con la etiqueta de otra cookie del repo
 *    (portal-invite, recovery, two-factor) no valida acá (lo cubre el test).
 *  - Ligada a usuario + sesión + consultorio + target + nonce: el callback exige el MISMO usuario, la MISMA sesión y el
 *    MISMO consultorio activo. Así un código obtenido en otra pestaña/cuenta, o después de cambiar de consultorio, no
 *    conecta la cuenta MP en el lugar equivocado.
 *  - El `state` que viaja a MP (y vuelve en la URL, que queda en historial y logs de proxies) NO lleva ids ni el nonce
 *    en claro: es `HMAC(clave, "state\0" + nonce)`. Comparar el `state` de la URL con el derivado de la cookie es la
 *    defensa contra el CSRF de login (alguien que hace que tu navegador termine SU autorización: su `state` no es el
 *    de tu cookie).
 *  - El `code_verifier` de PKCE también se deriva del nonce con la clave (`"pkce\0" + nonce`), así no se guarda aparte
 *    y no se puede deducir del `state` ni del nonce sin la clave: quien intercepte el `code` no lo puede canjear.
 *  - Comparaciones en tiempo constante (`timingSafeEqual`), firma antes de parsear, y un `exp` más lejos que el TTL no
 *    lo emitimos nunca → se rechaza.
 *  - Este módulo no mira la base ni la sesión: el callback pasa el contexto del actor actual (`ctx`) y borra la cookie
 *    al terminar (un solo uso práctico; el `code` de MP de por sí es de un solo uso y vence a los 10 min).
 *
 * Sin service key: en local (sin `VERCEL_ENV`/`VERCEL`) la clave es determinista; a diferencia de portal-invite no se
 * usa una aleatoria por proceso porque la server action que setea la cookie y el route handler del callback pueden
 * cargar instancias distintas de este módulo en `next dev`, y el flujo se rompería. En Vercel sin service key (no
 * debería pasar: el ENV la exige en Production) queda una clave aleatoria por proceso: falla cerrado.
 */
export const MP_OAUTH_COOKIE = "kine_mp_oauth";
export const MP_OAUTH_STATE_TTL_S = 10 * 60;

export type MpOAuthTarget = "own" | "clinic";

export type MpOAuthStateInput = {
  userId: string;
  sessionId: string;
  tenantId: string;
  target: MpOAuthTarget;
  /** `own` → el profesional del actor; `clinic` → null. */
  practitionerId: string | null;
  nonce: string;
  /** Epoch en segundos (`mpOAuthStateExp(nowMs)`). */
  exp: number;
};
export type MpOAuthStateClaims = MpOAuthStateInput;

export type MpOAuthStateError =
  | "bad_mac"
  | "state_mismatch"
  | "other_user"
  | "other_session"
  | "other_tenant"
  | "expired";

export type MpOAuthStateContext = { userId: string; sessionId: string; tenantId: string; nowMs?: number };

const LABEL = "kinesoft:mp-oauth-state:v1";
/** Tope antes de decodificar: una cookie gigante no debería costar un JSON.parse de megas. */
const MAX_COOKIE_LEN = 2048;
const MAX_STATE_LEN = 256;
const MAX_ID_LEN = 128;
/** 32 bytes en base64url = 43 caracteres; se aceptan nonces más largos pero nunca más cortos (entropía ≥ 128 bits). */
const NONCE_RE = /^[A-Za-z0-9_-]{22,128}$/;
/** Holgura de reloj para el tope superior del `exp` (mismo criterio que portal-invite / two-factor). */
const EXP_SKEW_S = 5;

let processKey: Buffer | null = null;
function hmacKey(): Buffer {
  const onVercel = Boolean(process.env.VERCEL_ENV || process.env.VERCEL);
  const base = env.SUPABASE_SERVICE_ROLE_KEY || (onVercel ? null : "kinesoft-local-dev");
  if (base) return createHmac("sha256", base).update(LABEL).digest();
  processKey ??= randomBytes(32);
  return processKey;
}

function mac(domain: string, data: string): string {
  return createHmac("sha256", hmacKey()).update(`${domain}\0${data}`).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  // Largo distinto → false sin llamar a timingSafeEqual (tira con largos distintos); el largo no es secreto.
  return x.length === y.length && timingSafeEqual(x, y);
}

function okId(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_ID_LEN;
}

/** Nonce nuevo por intento de conexión (256 bits, base64url). */
export function newOAuthNonce(): string {
  return randomBytes(32).toString("base64url");
}

/** `exp` en segundos epoch para una cookie emitida ahora. */
export function mpOAuthStateExp(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000) + MP_OAUTH_STATE_TTL_S;
}

/**
 * Opciones de la cookie. `SameSite=Lax` y no `Strict`: la vuelta de MP es una navegación GET cross-site y con
 * `Strict` el navegador no mandaría la cookie al callback. `secure` en prod (mismo criterio que two-factor-cookie).
 */
export function mpOAuthCookieOptions(): {
  httpOnly: true;
  sameSite: "lax";
  path: string;
  maxAge: number;
  secure: boolean;
} {
  return {
    httpOnly: true,
    sameSite: "lax",
    path: MP_OAUTH_COOKIE_PATH,
    maxAge: MP_OAUTH_STATE_TTL_S,
    secure: process.env.NODE_ENV === "production",
  };
}

function stateFor(nonce: string): string {
  return mac("state", nonce);
}

function validShape(o: MpOAuthStateInput): boolean {
  if (!okId(o.userId) || !okId(o.sessionId) || !okId(o.tenantId)) return false;
  if (typeof o.nonce !== "string" || !NONCE_RE.test(o.nonce)) return false;
  if (typeof o.exp !== "number" || !Number.isInteger(o.exp)) return false;
  if (o.target === "own") return okId(o.practitionerId);
  if (o.target === "clinic") return o.practitionerId === null;
  return false;
}

/** Firma la cookie y deriva el `state` para MP. Tira ante una entrada que nunca debería firmarse (bug del caller). */
export function makeOAuthState(o: MpOAuthStateInput): { cookie: string; state: string } {
  if (!validShape(o)) throw new Error("[mp-oauth-state] entrada inválida");
  const payload = Buffer.from(
    JSON.stringify({ u: o.userId, s: o.sessionId, t: o.tenantId, g: o.target, p: o.practitionerId, n: o.nonce, x: o.exp })
  ).toString("base64url");
  return { cookie: `${payload}.${mac("cookie", payload)}`, state: stateFor(o.nonce) };
}

/**
 * Valida cookie + `state` contra el actor actual. Orden: firma → forma → vencimiento → state → usuario → sesión →
 * consultorio. Nunca tira.
 */
export function readOAuthState(
  cookie: string | null | undefined,
  stateParam: string | null | undefined,
  ctx: MpOAuthStateContext
): MpOAuthStateClaims | { error: MpOAuthStateError } {
  const nowMs = ctx.nowMs ?? Date.now();
  if (!cookie || cookie.length > MAX_COOKIE_LEN) return { error: "bad_mac" };
  const parts = cookie.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { error: "bad_mac" };
  const [payload, sig] = parts;

  // Firma primero: no se parsea nada que no hayamos firmado nosotros.
  if (!safeEqual(mac("cookie", payload), sig)) return { error: "bad_mac" };

  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { error: "bad_mac" };
  }
  if (!raw || typeof raw !== "object") return { error: "bad_mac" };
  const r = raw as Record<string, unknown>;
  const claims = {
    userId: r.u,
    sessionId: r.s,
    tenantId: r.t,
    target: r.g,
    practitionerId: r.p,
    nonce: r.n,
    exp: r.x,
  } as MpOAuthStateClaims;
  // Bien firmada pero con otra forma: solo pasaría con un bug nuestro o la clave filtrada; se trata como no firmada.
  if (!validShape(claims)) return { error: "bad_mac" };

  if (claims.exp * 1000 <= nowMs) return { error: "expired" };
  if (claims.exp * 1000 > nowMs + (MP_OAUTH_STATE_TTL_S + EXP_SKEW_S) * 1000) return { error: "expired" };

  if (!stateParam || stateParam.length > MAX_STATE_LEN || !safeEqual(stateFor(claims.nonce), stateParam)) {
    return { error: "state_mismatch" };
  }
  if (!safeEqual(claims.userId, ctx.userId)) return { error: "other_user" };
  if (!safeEqual(claims.sessionId, ctx.sessionId)) return { error: "other_session" };
  if (!safeEqual(claims.tenantId, ctx.tenantId)) return { error: "other_tenant" };
  return claims;
}

/**
 * `code_verifier` de PKCE (RFC 7636 §4.1): 43 caracteres base64url (32 bytes), determinista por nonce y dependiente
 * de la clave del servidor, así el callback lo recalcula desde la cookie sin guardarlo.
 */
export function pkceVerifierFrom(nonce: string): string {
  return mac("pkce", nonce);
}

/** `code_challenge` S256 = BASE64URL(SHA256(ASCII(verifier))), sin padding (RFC 7636 §4.2). */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/**
 * URL de autorización (pura). La usa `authorizationUrl` de `oauth-client.ts` (TP-P4) con los hosts del modo y el
 * client id del ENV. `platform_id=mp` lo pide la doc de MP para el OAuth de vendedores.
 */
export function buildAuthorizationUrl(o: {
  authUrl: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const u = new URL(o.authUrl);
  u.searchParams.set("client_id", o.clientId);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("platform_id", "mp");
  u.searchParams.set("state", o.state);
  u.searchParams.set("redirect_uri", o.redirectUri);
  u.searchParams.set("code_challenge", o.codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}
