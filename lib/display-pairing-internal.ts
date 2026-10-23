import "server-only";
/**
 * Vínculo de una pantalla de Sala de espera (T7 · TV-1a, contrato C-TV «Vínculo», plan §26.4; M17).
 *
 * Piezas puras de cripto, sin DB: las usan `lib/display-device-internal.ts` (sesión de la TV) y
 * `lib/reception-displays.ts` (el staff genera el código).
 *
 * - **Código de vinculación** (8 caracteres Crockford, lo genera el staff y se tipea en la TV, TV-D6): son 40 bits.
 *   Un sha256 pelado se revierte offline recorriendo 2^40 en minutos con una GPU, así que con un dump de la tabla
 *   alcanzaría para vincular una TV ajena. Por eso el hash es un HMAC con clave del server, derivada de
 *   `SUPABASE_SERVICE_ROLE_KEY` con su propia etiqueta (`kinesoft:tv-pair:v1`), igual que lib/support-session-internal.ts
 *   y lib/recovery-cookie.ts: la clave de un uso no sirve para otro. Sale en base64url de 43 caracteres, que es lo
 *   que exige el CHECK `ReceptionDisplay_pairing_check`. El índice único parcial de M17 busca por este hash SIN
 *   tenant, así que el hash tiene que ser determinista (sin sal).
 * - **Secreto del dispositivo**: 32 bytes aleatorios; la base guarda solo su sha256 (CHECK `_device_check`). Con 256
 *   bits no hace falta HMAC: no hay espacio que recorrer.
 * - **Cookie** `v1.<id>.<secret>.<día>`: el `id` evita buscar por hash (y el timing de esa búsqueda), el `día`
 *   (YYYY-MM-DD AR de la emisión) le permite al server la renovación deslizante a los 30 días sin escribir en cada
 *   request. La comparación del secreto es en tiempo constante (`timingSafeEqual`).
 *
 * Sin `SUPABASE_SERVICE_ROLE_KEY` (dev sin Supabase) la clave es aleatoria por proceso, como en support-session: los
 * códigos generados valen mientras viva ese server, que es lo que importa en dev.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

/** Alfabeto Crockford base32 (sin I, L, O, U: no se confunden al tipearlos con el control remoto). */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LEN = 8;

const COOKIE_VERSION = "v1";
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** 32 bytes en base64url sin padding = 43 caracteres. */
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
/** v1 + id (≤64) + secreto (43) + día (10) + 3 puntos: más que esto no es nuestra cookie. */
const COOKIE_MAX = 128;

export type DisplayCookie = { id: string; secret: string; issuedDay: string };

let devKey: Buffer | null = null;
function pairingKey(): Buffer {
  const base = env.SUPABASE_SERVICE_ROLE_KEY;
  if (base) return createHmac("sha256", base).update("kinesoft:tv-pair:v1").digest();
  devKey ??= randomBytes(32);
  return devKey;
}

/**
 * 8 caracteres Crockford. Cada byte aleatorio se recorta a 5 bits (`& 31`): 256 es múltiplo de 32, así que no hay
 * sesgo de módulo.
 */
export function generatePairingCode(): string {
  const bytes = randomBytes(CODE_LEN);
  let out = "";
  for (let i = 0; i < CODE_LEN; i++) out += CROCKFORD[bytes[i] & 31];
  return out;
}

/**
 * HMAC-SHA256 del código en base64url (43). Recibe el código YA normalizado (`normalizePairingCode` de
 * lib/reception-displays-types.ts: mayúsculas, sin guion, O→0, I/L→1): el hash es de los bytes tal cual llegan.
 */
export function hashPairingCode(code: string): string {
  return createHmac("sha256", pairingKey()).update(code).digest("base64url");
}

export function newDeviceSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function hashDeviceSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("base64url");
}

/** `issuedDay` = día AR de emisión (`toARDateKey` de lib/datetime-ar.ts). Tira si una parte rompería el formato. */
export function makeDisplayCookie(id: string, secret: string, issuedDay: string): string {
  if (!ID_RE.test(id)) throw new Error("display cookie: id inválido");
  if (!SECRET_RE.test(secret)) throw new Error("display cookie: secreto inválido");
  if (!DAY_RE.test(issuedDay)) throw new Error("display cookie: día inválido");
  return `${COOKIE_VERSION}.${id}.${secret}.${issuedDay}`;
}

/** Cookie ajena, alterada o de otra versión → `null` (nunca tira: la TV cae a la pantalla de vincular). */
export function parseDisplayCookie(value: string | null | undefined): DisplayCookie | null {
  if (typeof value !== "string" || !value || value.length > COOKIE_MAX) return null;
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const [version, id, secret, issuedDay] = parts;
  if (version !== COOKIE_VERSION || !ID_RE.test(id) || !SECRET_RE.test(secret) || !DAY_RE.test(issuedDay)) {
    return null;
  }
  return { id, secret, issuedDay };
}

/** El secreto de la cookie contra el hash guardado, en tiempo constante. Hash nulo (revocada/sin vincular) → false. */
export function secretMatches(secret: string, storedHash: string | null | undefined): boolean {
  if (typeof secret !== "string" || !secret || typeof storedHash !== "string" || !storedHash) return false;
  const a = Buffer.from(hashDeviceSecret(secret));
  const b = Buffer.from(storedHash);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
