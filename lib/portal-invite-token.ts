import "server-only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

/**
 * Token de invitación al portal (ES4 S24t, brief §3.3; molde `lib/recovery-cookie.ts` y `lib/two-factor-cookie.ts`).
 *
 * El consultorio invita a un paciente a vincular su cuenta: el link lleva este token en el parámetro `t` y
 * `/portal/vincular` (S24v) lo lee para saber qué ficha (`patientId`) de qué consultorio (`tenantId`) se ofrece, y a
 * qué email se mandó (`emailHash`, para comparar contra el email de la sesión sin guardar el email en claro en la URL).
 *
 * Valor: `base64url(JSON{p,t,e,x})` + "." + HMAC-SHA256 en base64url.
 *  - Firmado: sin la firma cualquiera fabricaría un link a la ficha de otro paciente.
 *  - Clave derivada de `SUPABASE_SERVICE_ROLE_KEY` con etiqueta propia `kinesoft:portal-invite:v1`, distinta de la
 *    de recovery (`kinesoft:recovery-cookie:v1`) y de la 2FA (`kinesoft:two-factor:v1`): un valor firmado para una
 *    nunca valida en la otra aunque alguien le acomode el formato (lo cubre el test).
 *  - Comparación del MAC en tiempo constante (`timingSafeEqual`).
 *  - Un `exp` más lejos que el TTL no lo emitimos nunca → se rechaza (mismo criterio que two-factor-cookie).
 *  - Este módulo NO mira la base: el «un solo uso» lo da el CAS del vínculo (S24a/S24v), sin tabla nueva.
 *  - Nadie loguea el token: el log de rechazo de S24v lleva `reason`, nunca `t`.
 *
 * Sin service key (dev local sin Supabase) se usa una clave aleatoria por proceso: los links dejan de valer al
 * reiniciar, que en dev da igual.
 */
export const PORTAL_INVITE_TTL_S = 7 * 24 * 3600;

export type PortalInviteClaims = { patientId: string; tenantId: string; emailHash: string; exp: number };

const LABEL = "kinesoft:portal-invite:v1";
/** Tope de largo antes de decodificar: un `t` gigante en la query no debería costar un JSON.parse de megas. */
const MAX_TOKEN_LEN = 1024;
const MAX_ID_LEN = 128;
const HASH_RE = /^[0-9a-f]{64}$/;

let devKey: Buffer | null = null;
function hmacKey(): Buffer {
  const base = env.SUPABASE_SERVICE_ROLE_KEY;
  if (base) return createHmac("sha256", base).update(LABEL).digest();
  devKey ??= randomBytes(32);
  return devKey;
}

function sign(payload: string): string {
  return createHmac("sha256", hmacKey()).update(payload).digest("base64url");
}

/** sha256(lower(trim(email))) en hex: `Ana@X.com ` y `ana@x.com` dan lo mismo. */
export function portalEmailHash(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

function okId(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_ID_LEN;
}

export function makePortalInviteToken(
  o: { patientId: string; tenantId: string; email: string },
  nowMs = Date.now()
): string {
  if (!okId(o.patientId) || !okId(o.tenantId)) throw new Error("[portal-invite-token] id inválido");
  if (!o.email.trim()) throw new Error("[portal-invite-token] email vacío");
  const x = Math.floor(nowMs / 1000) + PORTAL_INVITE_TTL_S;
  const payload = Buffer.from(
    JSON.stringify({ p: o.patientId, t: o.tenantId, e: portalEmailHash(o.email), x })
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** null si firma inválida (timingSafeEqual), vencido o mal formado. No mira la base. */
export function readPortalInviteToken(token: string | null | undefined, nowMs = Date.now()): PortalInviteClaims | null {
  if (!token || token.length > MAX_TOKEN_LEN) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, mac] = parts;
  if (!payload || !mac) return null;

  // Firma primero: no se parsea nada que no hayamos firmado nosotros.
  const expected = Buffer.from(sign(payload));
  const got = Buffer.from(mac);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const { p, t, e, x } = raw as Record<string, unknown>;
  if (!okId(p) || !okId(t) || typeof e !== "string" || !HASH_RE.test(e)) return null;
  if (typeof x !== "number" || !Number.isInteger(x)) return null;
  if (x * 1000 <= nowMs) return null;
  if (x * 1000 > nowMs + PORTAL_INVITE_TTL_S * 1000 + 5_000) return null;
  return { patientId: p, tenantId: t, emailHash: e, exp: x };
}
