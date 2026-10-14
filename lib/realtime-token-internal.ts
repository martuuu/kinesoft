import "server-only";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { REALTIME_TOKEN_TTL_SEC } from "@/lib/realtime-constants";

/**
 * Token corto del canal Broadcast privado de la Sala de Espera (SV04b, C-SV5;
 * plan §18.2 «Token», SV-D6, SV-D15).
 *
 * Qué es: un JWT HS256 firmado con el secreto JWT del proyecto Supabase
 * (`SUPABASE_JWT_SECRET`, o una clave HS256 del sistema nuevo de JWT signing keys
 * con su `kid`). Realtime lo acepta como `authenticated` y la policy de M5
 * (`kinesoft_realtime_can_read`) deja leer SOLO `tenant:<tenant_id>:agenda`.
 *
 * Por qué no usamos el access token de la sesión: está en una cookie httpOnly
 * (A3) y exponerlo al browser rompe esa barrera. Por qué `node:crypto` y no
 * `jose`: no hay dependencia nueva y el formato HS256 es trivial (molde
 * `lib/recovery-cookie.ts`); el unit test re-verifica la firma a mano.
 *
 * Por qué este token NO sirve para otra cosa aunque se filtre (10 min de vida):
 *  - `sub` es `rt:<uuid>`, que no es un UUID: GoTrue (`/auth/v1/user`) lo rechaza
 *    y ninguna policy de `auth.uid()` puede matchearlo (auth.uid() castea a uuid);
 *  - la Data API (PostgREST) está apagada y `anon`/`authenticated` sin grants en
 *    `public` (M2 + precheck R3), así que `role: authenticated` no lee tablas;
 *  - Storage no tiene policies para `authenticated` (precheck 17);
 *  - `purpose`/`iss` propios: la policy exige `purpose = 'kinesoft-realtime'`.
 * V4 de `scripts/realtime-verify.ts` lo comprueba en staging.
 *
 * El token nunca se loguea: con él se lee el canal del consultorio (sin PHI, pero
 * igual es del tenant).
 */

export const REALTIME_CLAIMS = {
  iss: "kinesoft-realtime",
  aud: "authenticated",
  role: "authenticated",
  purpose: "kinesoft-realtime",
} as const;

export type RealtimeTokenClaims = typeof REALTIME_CLAIMS & {
  sub: string;
  tenant_id: string;
  iat: number;
  exp: number;
};

const SUB_RE = /^rt:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function b64urlJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

function hmac(input: string, secret: string): string {
  return createHmac("sha256", secret).update(input).digest("base64url");
}

export function signRealtimeToken(input: {
  tenantId: string;
  now: Date;
  secret: string;
  kid?: string;
  ttlSec?: number;
}): { token: string; expiresAt: Date } {
  // Falla cerrado: un secreto vacío firmaría tokens que cualquiera puede fabricar.
  if (!input.secret) throw new Error("realtime token: falta el secreto");
  if (!input.tenantId) throw new Error("realtime token: falta el tenantId");
  const ttl = input.ttlSec ?? REALTIME_TOKEN_TTL_SEC;
  // `kid` solo si viene con contenido: un `SUPABASE_JWT_KID=""` en Vercel no puede
  // mandar `kid:""`, que Supabase buscaría como clave inexistente (SV-D15).
  const kid = input.kid?.trim();
  const header = kid ? { alg: "HS256", typ: "JWT", kid } : { alg: "HS256", typ: "JWT" };
  const iat = Math.floor(input.now.getTime() / 1000);
  const exp = iat + ttl;
  const payload: RealtimeTokenClaims = {
    ...REALTIME_CLAIMS,
    sub: `rt:${randomUUID()}`,
    tenant_id: input.tenantId,
    iat,
    exp,
  };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  return { token: `${signingInput}.${hmac(signingInput, input.secret)}`, expiresAt: new Date(exp * 1000) };
}

/**
 * Verifica un token nuestro: alg HS256, firma (tiempo constante), `exp` y los
 * claims fijos. Devuelve los claims o `null`; nunca tira. Lo usan los tests y el
 * script de verificación; Supabase hace su propia verificación.
 */
export function verifyRealtimeToken(
  token: string,
  secret: string,
  now: Date = new Date()
): RealtimeTokenClaims | null {
  try {
    if (!secret || typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [h, p, s] = parts;
    const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as Record<string, unknown>;
    if (header?.alg !== "HS256" || header.typ !== "JWT") return null;
    const expected = Buffer.from(hmac(`${h}.${p}`, secret));
    const got = Buffer.from(s);
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
    const c = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Record<string, unknown>;
    for (const [k, v] of Object.entries(REALTIME_CLAIMS)) if (c[k] !== v) return null;
    if (typeof c.sub !== "string" || !SUB_RE.test(c.sub)) return null;
    if (typeof c.tenant_id !== "string" || c.tenant_id.length === 0) return null;
    if (!Number.isInteger(c.iat) || !Number.isInteger(c.exp)) return null;
    if ((c.exp as number) * 1000 <= now.getTime()) return null;
    return c as RealtimeTokenClaims;
  } catch {
    return null;
  }
}
