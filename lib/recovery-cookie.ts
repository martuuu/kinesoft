import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

/**
 * Cookie "recovery" (A3b-S-auth → la consume A3c-S-signup en /reset).
 *
 * Contrato:
 *   - nombre: `RECOVERY_COOKIE` = `ks_recovery`;
 *   - la setea `/auth/confirm` SOLO tras un `verifyOtp` exitoso de tipo
 *     `recovery` (el link del mail de "olvidé mi clave");
 *   - httpOnly, `secure` en prod, `sameSite=lax`, path `/`, TTL
 *     `RECOVERY_TTL_S` = 15 min;
 *   - valor = `<userId>.<expEpochSeconds>.<hmac>`, firmado: una sesión robada
 *     NO puede fabricársela (si fuera un flag suelto, cualquiera con la
 *     sesión podría setear `ks_recovery=1` en su browser y cambiar la clave
 *     sin conocer la actual);
 *   - el reset llama a `verifyRecoveryCookie(valor, user.id)` y, si da true,
 *     acepta la clave nueva sin pedir la actual; después la borra
 *     (`cookies().delete(RECOVERY_COOKIE)`): es de un solo uso.
 *
 * Clave del HMAC: derivada de `SUPABASE_SERVICE_ROLE_KEY` con una etiqueta
 * propia (no hay otro secreto de servidor en `lib/env.ts` y no se agrega uno
 * nuevo en esta ola). Sin service key (dev local sin Supabase) se usa una
 * clave aleatoria por proceso: la cookie deja de valer al reiniciar, que en
 * dev da igual.
 */
export const RECOVERY_COOKIE = "ks_recovery";
export const RECOVERY_TTL_S = 15 * 60;

let devKey: Buffer | null = null;
function hmacKey(): Buffer {
  const base = env.SUPABASE_SERVICE_ROLE_KEY;
  if (base) return createHmac("sha256", base).update("kinesoft:recovery-cookie:v1").digest();
  devKey ??= randomBytes(32);
  return devKey;
}

function sign(userId: string, exp: number): string {
  return createHmac("sha256", hmacKey()).update(`${userId}.${exp}`).digest("base64url");
}

export function makeRecoveryCookieValue(userId: string, nowMs = Date.now()): string {
  const exp = Math.floor(nowMs / 1000) + RECOVERY_TTL_S;
  return `${userId}.${exp}.${sign(userId, exp)}`;
}

/** true solo si la cookie es de ESTE usuario, está firmada por nosotros y no venció. */
export function verifyRecoveryCookie(
  value: string | null | undefined,
  userId: string,
  nowMs = Date.now()
): boolean {
  if (!value) return false;
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  const [uid, expRaw, mac] = parts;
  if (uid !== userId) return false;
  const exp = Number(expRaw);
  if (!Number.isInteger(exp) || exp * 1000 < nowMs) return false;
  const expected = Buffer.from(sign(uid, exp));
  const got = Buffer.from(mac);
  return expected.length === got.length && timingSafeEqual(expected, got);
}
