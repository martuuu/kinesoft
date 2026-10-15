import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { env } from "@/lib/env";
import { PLATFORM_REAUTH_TTL_S } from "@/lib/platform-mfa-logic";

/**
 * Re-verificación reciente del superadmin (BO4, plan §19.5): «el último código TOTP bien puesto tiene menos de
 * 10 minutos». La exigen las acciones de riesgo `high` de `PLATFORM_ACTION_POLICY` con `PLATFORM_MFA_ENFORCEMENT=
 * enforce` (cortar acceso, dar superadmin, entrar como soporte…): una sesión AAL2 robada o una pestaña olvidada
 * abierta no alcanza para hacerlas.
 *
 * Molde de `lib/recovery-cookie.ts`:
 *   - nombre `kine_platform_reauth`; valor `<userId>.<expEpochSeconds>.<hmac>`, firmado: un flag suelto
 *     (`=1`) lo fabricaría cualquiera con la sesión desde la consola del browser;
 *   - ligada al userId: si en el mismo browser entra otro superadmin, la cookie del anterior no le sirve;
 *   - httpOnly, `secure` en prod, `sameSite=strict` (las actions son POST same-origin; nada cross-site tiene por qué
 *     llevarla), `path=/plataforma` (las server actions postean a la URL de la página: todas las de Plataforma
 *     caen bajo ese path; ningún otro request la lleva), TTL 10 min = `PLATFORM_REAUTH_TTL_S`.
 *   - la setean SOLO las actions de `lib/platform-mfa-actions.ts` después de un `verify` exitoso de GoTrue.
 *
 * Por qué una cookie y no el `amr` del JWT (`{ method: "totp", timestamp }`): el timestamp del amr depende de cómo
 * GoTrue lo reescribe en cada refresh/verify, que no está en el contrato público de supabase-js; la cookie es
 * nuestra, su vencimiento es exacto y el test la cubre entera.
 *
 * Clave del HMAC: derivada de `SUPABASE_SERVICE_ROLE_KEY` con una etiqueta PROPIA (distinta de la de recovery: una
 * cookie de una no valida como la otra). Sin service key (dev local), clave aleatoria por proceso.
 */
export const PLATFORM_REAUTH_COOKIE = "kine_platform_reauth";

let devKey: Buffer | null = null;
function hmacKey(): Buffer {
  const base = env.SUPABASE_SERVICE_ROLE_KEY;
  if (base) return createHmac("sha256", base).update("kinesoft:platform-reauth:v1").digest();
  devKey ??= randomBytes(32);
  return devKey;
}

function sign(userId: string, exp: number): string {
  return createHmac("sha256", hmacKey()).update(`${userId}.${exp}`).digest("base64url");
}

export function makePlatformReauthValue(userId: string, nowMs = Date.now()): string {
  const exp = Math.floor(nowMs / 1000) + PLATFORM_REAUTH_TTL_S;
  return `${userId}.${exp}.${sign(userId, exp)}`;
}

/**
 * true solo si la cookie es de ESTE usuario, está firmada por nosotros y no venció. El userId de Supabase es un UUID
 * (sin puntos); uno con puntos no se puede partir sin ambigüedad y se rechaza.
 */
export function verifyPlatformReauthValue(value: string | null | undefined, userId: string, nowMs = Date.now()): boolean {
  if (!value) return false;
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  const [uid, expRaw, mac] = parts;
  if (uid !== userId) return false;
  const exp = Number(expRaw);
  if (!Number.isInteger(exp) || exp * 1000 <= nowMs) return false;
  // Un exp más lejos que el TTL no lo emitimos nunca: si aparece, la clave se filtró o es otra versión. Fuera.
  if (exp * 1000 > nowMs + PLATFORM_REAUTH_TTL_S * 1000 + 5_000) return false;
  const expected = Buffer.from(sign(uid, exp));
  const got = Buffer.from(mac);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

/** ¿Este request trae una re-verificación vigente de `userId`? Fuera de un request (`cookies()` tira) → false. */
export function hasFreshPlatformReauth(userId: string): boolean {
  try {
    return verifyPlatformReauthValue(cookies().get(PLATFORM_REAUTH_COOKIE)?.value, userId);
  } catch {
    return false;
  }
}

/** Solo desde una server action (en un server component `cookies().set` tira). */
export function setPlatformReauthCookie(userId: string): void {
  cookies().set(PLATFORM_REAUTH_COOKIE, makePlatformReauthValue(userId), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/plataforma",
    maxAge: PLATFORM_REAUTH_TTL_S,
  });
}
