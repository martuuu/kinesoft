import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * PF-0b · verificación LOCAL del access token de Supabase (lógica pura, sin red ni `next/*`).
 *
 * Por qué existe: `getUser()` es una ida y vuelta HTTP a GoTrue en CADA request y en cada server action (PF-0a la
 * midió en ~35 ms con Supabase en la misma región y ~150 ms cruzado: un tercio del TTFB). El access token es un JWT
 * firmado por el proyecto: verificado acá (firma + `exp` + `iss` + `aud` + `role` + `sub` + `session_id`) da la
 * misma identidad sin red. Lo que se pierde es la revocación inmediata: un token robado o de una sesión cerrada vale
 * hasta su `exp` (≤ 1 h en Supabase). Lo cubren `UserProfile.disabledAt` (se sigue leyendo en cada request) y
 * `getStrictSessionUser()` (GoTrue) en los puntos sensibles. Ver SECURITY.md «PF-0b».
 *
 * Qué decide este módulo y qué no:
 *  - `reject`: el token es inválido sin importar la clave (malformado, vencido, sin `sub` de usuario).
 *    Rechazar siempre es seguro: `getUser()` también lo rechazaría.
 *  - `fallback`: no se pudo PROBAR acá (otro algoritmo, sin secreto configurado, firma que no coincide con NUESTRO
 *    secreto, `iss` distinto). El caller cae a `getUser()`: si el problema es de configuración (secreto rotado, clave
 *    nueva del sistema de signing keys, dominio propio de Supabase, un hook que cambie `role`/`aud`) la app sigue
 *    andando como antes de PF-0b en vez de
 *    desloguear a todos; si el token es falso, GoTrue lo rechaza. Nunca se acepta un token por descarte.
 *  - `asymmetric`: ES256/RS256 con `kid` (sistema nuevo de signing keys). El caller verifica con `getClaims()` de
 *    supabase-js (JWKS cacheado 10 min por proceso) y vuelve a pasar los claims por `checkSessionClaims`.
 *
 * Por qué `node:crypto` y no `jose`: sin dependencia nueva; HS256 es trivial (molde `lib/realtime-token-internal.ts`).
 */

/** Claims que la app usa de un access token de GoTrue. El resto se ignora. */
export type SessionClaims = {
  sub: string;
  email: string | null;
  sessionId: string;
  aal: string | null;
  exp: number;
  fullName: string | null;
  avatarUrl: string | null;
};

export type LocalVerifyResult =
  | { kind: "ok"; claims: SessionClaims }
  | { kind: "reject"; reason: "malformed" | "expired" | "subject" }
  | { kind: "fallback"; reason: "no_secret" | "alg" | "signature" | "issuer" | "claims" }
  | { kind: "asymmetric"; payload: Record<string, unknown> };

/** Tolerancia de reloj para `exp`/`nbf`/`iat` (Vercel y GoTrue con NTP; 30 s es lo usual en librerías JWT). */
const CLOCK_SKEW_SEC = 30;
const ASYMMETRIC_ALGS = new Set(["ES256", "RS256"]);

/** `iss` que GoTrue pone en los tokens del proyecto: `<SUPABASE_URL>/auth/v1`. */
export function supabaseIssuer(supabaseUrl: string | undefined | null): string | null {
  if (!supabaseUrl) return null;
  return `${supabaseUrl.replace(/\/+$/, "")}/auth/v1`;
}

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Claims de una sesión de USUARIO de GoTrue, ya con la firma probada (o antes, solo para rechazar). Rechaza el token
 * del canal realtime (`lib/realtime-token-internal.ts`: `sub` = `rt:<uuid>`, sin `session_id`), la service key
 * (`role: service_role`) y la anon key (`role: anon`), que firman con el mismo secreto: nunca salen `ok`.
 */
export function checkSessionClaims(
  c: Record<string, unknown>,
  nowSec: number
): { ok: true; claims: SessionClaims } | { ok: false; reason: "expired" | "subject" | "claims" } {
  // Sin `exp`, vencido o «emitido en el futuro»: cualquier verificador JWT (GoTrue incluido) lo rechaza.
  if (typeof c.exp !== "number" || !Number.isFinite(c.exp)) return { ok: false, reason: "expired" };
  if (c.exp + CLOCK_SKEW_SEC <= nowSec) return { ok: false, reason: "expired" };
  if (typeof c.nbf === "number" && c.nbf - CLOCK_SKEW_SEC > nowSec) return { ok: false, reason: "expired" };
  if (typeof c.iat === "number" && c.iat - CLOCK_SKEW_SEC > nowSec) return { ok: false, reason: "expired" };
  // `sub` = id de `auth.users`. El token de realtime (`rt:<uuid>`) y las keys anon/service (sin `sub`) caen acá.
  // No se exige formato UUID: lo que prueba la identidad es la firma + `iss`; quien tiene el secreto puede firmar
  // cualquier `sub`, así que el formato no agrega seguridad, y los perfiles de dev (`demo-lucia`) no son UUID.
  if (typeof c.sub !== "string" || c.sub.length === 0 || c.sub.length > 128 || c.sub.startsWith("rt:")) {
    return { ok: false, reason: "subject" };
  }
  // De acá en más, lo que GoTrue emite con la config estándar; distinto = `claims` → el caller cae a `getUser()`.
  if (c.role !== "authenticated") return { ok: false, reason: "claims" };
  const aud = c.aud;
  const audOk = aud === "authenticated" || (Array.isArray(aud) && aud.includes("authenticated"));
  if (!audOk) return { ok: false, reason: "claims" };
  // GoTrue pone `session_id` en todo access token de una sesión desde 2023: sin él no es un token de login.
  if (typeof c.session_id !== "string" || c.session_id.length === 0) return { ok: false, reason: "claims" };
  const meta = (c.user_metadata && typeof c.user_metadata === "object" ? c.user_metadata : {}) as Record<string, unknown>;
  return {
    ok: true,
    claims: {
      sub: c.sub,
      email: typeof c.email === "string" && c.email.length > 0 ? c.email : null,
      sessionId: c.session_id,
      aal: typeof c.aal === "string" ? c.aal : null,
      exp: c.exp,
      fullName: typeof meta.full_name === "string" ? meta.full_name : null,
      avatarUrl: typeof meta.avatar_url === "string" ? meta.avatar_url : null,
    },
  };
}

/**
 * Verifica un access token de Supabase sin red. `secret` = `SUPABASE_JWT_SECRET` (el secreto HS256 legacy del
 * proyecto, el mismo con el que firma el token de realtime); `issuer` = `supabaseIssuer(NEXT_PUBLIC_SUPABASE_URL)`.
 * Nunca tira.
 */
export function verifySupabaseAccessToken(
  token: string,
  opts: { secret: string | undefined | null; issuer: string | null; nowSec: number }
): LocalVerifyResult {
  if (typeof token !== "string") return { kind: "reject", reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) return { kind: "reject", reason: "malformed" };
  const [h, p, s] = parts;
  const header = decodeJson(h);
  const payload = decodeJson(p);
  if (!header || !payload) return { kind: "reject", reason: "malformed" };

  // Primero lo que invalida SIN importar la clave (rechazar sin firma probada es seguro; aceptar no).
  const pre = checkSessionClaims(payload, opts.nowSec);
  if (!pre.ok) return pre.reason === "claims" ? { kind: "fallback", reason: "claims" } : { kind: "reject", reason: pre.reason };

  const alg = header.alg;
  if (typeof alg === "string" && ASYMMETRIC_ALGS.has(alg) && typeof header.kid === "string" && header.kid) {
    return { kind: "asymmetric", payload };
  }
  // `none`, HS384/512, PS*, etc.: GoTrue no los emite con la config de Supabase. Que decida GoTrue.
  if (alg !== "HS256") return { kind: "fallback", reason: "alg" };
  if (!opts.secret) return { kind: "fallback", reason: "no_secret" };

  const expected = createHmac("sha256", opts.secret).update(`${h}.${p}`).digest();
  let got: Buffer;
  try {
    got = Buffer.from(s, "base64url");
  } catch {
    return { kind: "reject", reason: "malformed" };
  }
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return { kind: "fallback", reason: "signature" };

  // Con la firma probada: el `iss` tiene que ser el de ESTE proyecto (un token de otro proyecto con el mismo secreto
  // sería un error de configuración grave; que lo decida GoTrue).
  if (!opts.issuer || payload.iss !== opts.issuer) return { kind: "fallback", reason: "issuer" };
  return { kind: "ok", claims: pre.claims };
}
