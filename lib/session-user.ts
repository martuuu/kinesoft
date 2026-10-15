import "server-only";
/**
 * Usuario de la sesión (IAM-3a; PF-0b).
 *
 * Por qué existe: había 7 `auth.getUser()` sueltos (session, onboarding, turnero, auth, /invite x2, portal), cada
 * uno con su manejo de error distinto (algunos tiraban si Supabase no respondía, otros no miraban `error`) y cada
 * uno un round-trip a GoTrue en el MISMO request. Acá hay dos lecturas, las dos nunca tiran (sin sesión = null):
 *
 * - `getSessionUser()` (PF-0b, la de CADA request): verifica el access token LOCALMENTE (`lib/session-jwt.ts`: HS256
 *   con `SUPABASE_JWT_SECRET`, o ES256/RS256 con `getClaims()` y el JWKS cacheado). Sin red. La usa el actor
 *   (`lib/session.ts` → `getAccessSnapshot` → `getActor`), o sea toda página, action y /plataforma. PF-0a midió el
 *   `getUser()` que reemplaza en ~35 ms por request con Supabase en la misma región (~150 ms cruzado).
 * - `getStrictSessionUser()` (= `getVerifiedSessionUser`, el nombre de IAM-3a): `auth.getUser()`, ida y vuelta a
 *   GoTrue, que además detecta una sesión cerrada o un usuario borrado ANTES del `exp` del token y trae
 *   `email_confirmed_at` (que el JWT no tiene). Para los puntos sensibles: contraseña/reset, invitación, alta,
 *   portal y turnero (piden email confirmado), 2FA y Plataforma (handoff de PF-0b). La revocación en el camino
 *   rápido la cubre `UserProfile.disabledAt`, que `getAccessSnapshot` lee en cada request.
 *
 * Si la verificación local no puede PROBAR el token (secreto distinto, otra clave, `iss` de un dominio propio, la
 * API de supabase-js cambió) cae a `getStrictSessionUser()`: degrada a lo de antes de PF-0b, nunca deja entrar por
 * descarte ni desloguea a todos por un error de configuración. Se loguea una vez por proceso y motivo.
 *
 * Memo: por request de Next (store de `requestAsyncStorage`, que envuelve layout, página y server actions; `cache()`
 * de React NO deduplica dentro de una action) y por token: si una action inicia sesión a mitad de camino, el token
 * nuevo no reusa el resultado del viejo.
 */
import { cache } from "react";
import { requestAsyncStorage } from "next/dist/client/components/request-async-storage.external";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { timeAsync } from "@/lib/server-timing";
import { checkSessionClaims, supabaseIssuer, verifySupabaseAccessToken, type SessionClaims } from "@/lib/session-jwt";

export type VerifiedSessionUser = {
  id: string;
  /** Tal cual lo devuelve Supabase (puede ser null en identidades sin email). Normalizar en el caller. */
  email: string | null;
  /** ISO de `email_confirmed_at`, o null si no confirmó. */
  emailConfirmedAt: string | null;
  /** `user_metadata.full_name` (Google lo trae; la activación de invitación lo escribe). */
  fullName: string | null;
  /** `user_metadata.avatar_url` (Google). */
  avatarUrl: string | null;
};

/**
 * Usuario de la verificación rápida. Sin `emailConfirmedAt` A PROPÓSITO (el JWT no lo trae): quien lo necesite usa
 * `getStrictSessionUser()`. `fullName`/`avatarUrl` son los de `user_metadata` al EMITIR el token (hasta 1 h viejos):
 * para mostrar, el nombre sale de `UserProfile`.
 */
export type SessionUser = {
  id: string;
  email: string | null;
  fullName: string | null;
  avatarUrl: string | null;
  /** `session_id` del token (null si vino por GoTrue). */
  sessionId: string | null;
  /** `aal1`/`aal2` del token (null si vino por GoTrue): para el 2FA de PL. */
  aal: string | null;
  /** Cómo se probó: `jwt` = local; `gotrue` = cayó a `getUser()`. */
  verifiedBy: "jwt" | "gotrue";
};

// ── Estricta (GoTrue) ──────────────────────────────────────────────────────────────────────────────────────────

async function readStrictUser(): Promise<VerifiedSessionUser | null> {
  try {
    const { data, error } = await getSupabaseServerClient().auth.getUser();
    // supabase-js no tira: un token vencido o Supabase caído llega como `error`. Se trata como sin sesión.
    if (error || !data?.user?.id) return null;
    const u = data.user;
    const meta = (u.user_metadata ?? {}) as Record<string, unknown>;
    return {
      id: u.id,
      email: u.email ?? null,
      emailConfirmedAt: u.email_confirmed_at ?? null,
      fullName: typeof meta.full_name === "string" ? meta.full_name : null,
      avatarUrl: typeof meta.avatar_url === "string" ? meta.avatar_url : null,
    };
  } catch {
    // Sin configurar (dev sin Supabase) o fuera de un request (cookies() tira): sin sesión.
    return null;
  }
}

// `cache` solo existe en el build react-server que empaqueta Next; en el runner de unit (react 18 pelado) no
// está. Sin él, pass-through: cada llamada lee de nuevo (mismo trato que el mock de integration-setup).
const memo: <T extends (...a: never[]) => unknown>(fn: T) => T =
  typeof cache === "function" ? (cache as never) : (fn) => fn;

/**
 * PF-0a: marca `auth-strict` de `lib/server-timing.ts` (con `PERF_TIMING=1`). Va por debajo de `cache()`: mide la
 * llamada REAL a GoTrue, no los aciertos de la memo.
 */
const readStrictUserTimed = () => timeAsync("auth-strict", readStrictUser);

/** El usuario verificado CONTRA GoTrue (`auth.getUser()`), o null. Nunca tira. Una llamada por request de RSC. */
export const getStrictSessionUser: () => Promise<VerifiedSessionUser | null> = memo(readStrictUserTimed);

/**
 * Nombre de IAM-3a, que siguen usando los puntos sensibles (invitación, alta, portal, turnero, reset, elección de
 * consultorio, fin de soporte). Es la estricta: PF-0b no les cambió nada. Código nuevo: `getStrictSessionUser`.
 */
export const getVerifiedSessionUser: () => Promise<VerifiedSessionUser | null> = getStrictSessionUser;

// ── Rápida (JWT local) ─────────────────────────────────────────────────────────────────────────────────────────

const warned = new Set<string>();
function warnOnce(reason: string): void {
  if (warned.has(reason)) return;
  warned.add(reason);
  // Nunca el token. Es config, no un evento: una vez por proceso y motivo alcanza para verlo en los logs de Vercel.
  logger.warn("session.jwt_local_fallback", { reason });
}

function fromClaims(c: SessionClaims): SessionUser {
  return {
    id: c.sub,
    email: c.email,
    fullName: c.fullName,
    avatarUrl: c.avatarUrl,
    sessionId: c.sessionId,
    aal: c.aal,
    verifiedBy: "jwt",
  };
}

async function viaGoTrue(reason: string): Promise<SessionUser | null> {
  warnOnce(reason);
  const u = await getStrictSessionUser();
  if (!u) return null;
  return { id: u.id, email: u.email, fullName: u.fullName, avatarUrl: u.avatarUrl, sessionId: null, aal: null, verifiedBy: "gotrue" };
}

type AuthClient = ReturnType<typeof getSupabaseServerClient>["auth"];

async function verifyToken(auth: AuthClient, token: string): Promise<SessionUser | null> {
  const issuer = supabaseIssuer(env.NEXT_PUBLIC_SUPABASE_URL);
  const nowSec = Math.floor(Date.now() / 1000);
  const r = verifySupabaseAccessToken(token, { secret: env.SUPABASE_JWT_SECRET, issuer, nowSec });
  if (r.kind === "ok") return fromClaims(r.claims);
  if (r.kind === "reject") return null;
  if (r.kind === "fallback") return viaGoTrue(r.reason);

  // ES256/RS256 (sistema nuevo de signing keys): firma con el JWKS público, cacheado 10 min por proceso en
  // supabase-js (`GLOBAL_JWKS`). `getClaims` no mira `iss` ni `aud`: se repasan los claims abajo.
  const { data, error } = await auth.getClaims(token);
  if (error || !data?.claims) return null;
  const c = data.claims as unknown as Record<string, unknown>;
  const checked = checkSessionClaims(c, nowSec);
  if (!checked.ok) return checked.reason === "claims" ? viaGoTrue("claims") : null;
  if (!issuer || c.iss !== issuer) return viaGoTrue("issuer");
  return fromClaims(checked.claims);
}

/** Memo por request de Next y por token (ver cabecera). Fuera de Next (scripts, unit): sin memo. */
const byRequest = new WeakMap<object, Map<string, Promise<SessionUser | null>>>();

function requestStore(): object | null {
  try {
    return (requestAsyncStorage.getStore() as object | undefined) ?? null;
  } catch {
    return null;
  }
}

async function readSessionUser(): Promise<SessionUser | null> {
  let auth: AuthClient;
  let token: string | null;
  try {
    auth = getSupabaseServerClient().auth;
    // Lee la cookie `sb-…-auth-token` (sin red salvo que el token esté por vencer: entonces refresca, igual que
    // hacía `getUser()`; el middleware ya lo refrescó en este request). El `user` de la sesión NO se usa: viene de
    // la cookie sin verificar; solo el `access_token`, que se verifica abajo.
    const { data, error } = await auth.getSession();
    if (error) return null;
    token = data?.session?.access_token ?? null;
  } catch {
    // Fuera de un request o la API de supabase-js no es la esperada: que decida GoTrue (que también devuelve null
    // fuera de un request). Nunca tira.
    return viaGoTrue("unavailable");
  }
  if (!token) return null;

  const store = requestStore();
  let perToken = store ? byRequest.get(store) : undefined;
  if (store && !perToken) {
    perToken = new Map();
    byRequest.set(store, perToken);
  }
  const hit = perToken?.get(token);
  if (hit) return hit;
  // PF-0a: la marca `auth` sigue midiendo la verificación (ahora local: ~0 ms salvo que caiga a GoTrue).
  const p = timeAsync("auth", () => verifyToken(auth, token as string)).catch(() => null);
  perToken?.set(token, p);
  return p;
}

/**
 * PF-0b: el usuario de esta sesión con el access token verificado localmente, o null. Nunca tira. Sin red en el
 * caso normal. NO trae `emailConfirmedAt`: para eso (y para todo punto sensible) `getStrictSessionUser()`.
 */
export const getSessionUser: () => Promise<SessionUser | null> = readSessionUser;
