import "server-only";
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

/**
 * Secret box (C-TP1, TP-P1): cifrado en reposo de secretos de terceros que la
 * app tiene que poder volver a usar (tokens OAuth de Mercado Pago por cuenta,
 * y en T6 las credenciales de WhatsApp, enmienda WA-D2).
 *
 * Por qué existe (brief T5 §25.2, hallazgo 7): hasta T5 no había cifrado en
 * reposo; todas las claves del server eran HMAC derivados de la service role
 * (`portal-invite-token`, `recovery-cookie`). Eso alcanza para FIRMAR, pero un
 * access/refresh token de MP es plata ajena: un dump de la base (backup, réplica,
 * un SELECT de soporte) no puede alcanzar para cobrar en nombre del profesional.
 * Y la clave no puede ser la service role: rotar esa (que pasa por otros
 * motivos) dejaría todas las cuentas sin poder abrirse.
 *
 * Diseño:
 *  - AES-256-GCM, IV aleatorio de 96 bits por sello (el tamaño que GCM procesa
 *    sin GHASH extra; con IV aleatorio el límite seguro es ~2^32 sellos por
 *    clave, muy por encima de lo que vamos a sellar entre rotaciones).
 *  - `SECRET_BOX_KEYS="k2:<b64 32 B>,k1:<b64>"`: la PRIMERA sella, TODAS
 *    abren. Rotar = anteponer una clave nueva, deployar, correr
 *    `scripts/secret-box-rotate.ts --apply` y recién después retirar la vieja.
 *  - Formato `v1.<kid>.<iv>.<ct>.<tag>` en base64url sin padding. Es el mismo
 *    que valida el CHECK `MpCredential_box_check` de M18 (IV 16 chars, tag 22),
 *    así que una fila con un token en claro no puede ni insertarse.
 *  - AAD `kinesoft:secret-box:v1|<propósito>|<recordId>|<campo>`: un sobre
 *    copiado a otra fila, a otro campo (access ↔ refresh) o a otro propósito
 *    no abre. Por eso ningún componente de la AAD puede tener `|`.
 *  - Clave dev determinista (HMAC de la service role, o de una constante) SOLO
 *    fuera de Vercel: en local se puede conectar el MP falso sin configurar
 *    nada, y la clave sobrevive reinicios (a diferencia del fallback aleatorio
 *    de `recovery-cookie`, acá perderla obligaría a reconectar). En Vercel
 *    (cualquier entorno, también Preview) la clave dev no sella ni abre: un
 *    sobre `dev` que llegue a prod (dump local restaurado) se rechaza con
 *    `dev_key_on_vercel` en vez de abrirse con una clave derivable.
 *  - Errores con `code` y mensaje FIJO: nunca un pedazo de la variable (si
 *    alguien pega la clave sin `kid:`, la "entrada" ES la clave), del texto en
 *    claro ni del sobre.
 *  - Sistema muestra huellas (HMAC truncado de la clave), nunca la clave.
 *
 * Lee `process.env` directo (no `lib/env.ts`, que valida la variable al boot
 * con `parseSecretBoxKeys`, C-TP2): así lo usa también el script de rotación
 * sin arrastrar la validación completa del entorno, y los tests cambian la
 * variable con `vi.stubEnv`. El parseo se memoiza por valor crudo.
 */

export type SecretBoxPurpose = "mp-credential" | "wa-credential";
export type SecretBoxAad = { purpose: SecretBoxPurpose; recordId: string; field: string }; // AAD `kinesoft:secret-box:v1|purpose|recordId|field`
export type SecretBoxErrorCode = "no_keys" | "bad_keys" | "format" | "unknown_kid" | "auth" | "dev_key_on_vercel";

const ERROR_MESSAGES: Record<SecretBoxErrorCode, string> = {
  no_keys: "secret-box: falta SECRET_BOX_KEYS (en Vercel no hay clave de desarrollo).",
  bad_keys: "secret-box: SECRET_BOX_KEYS mal formada. Formato: \"k2:<base64 de 32 bytes>,k1:<base64>\" con kid [a-z0-9_-]{1,16}, sin repetir y sin \"dev\".",
  format: "secret-box: sobre o AAD con formato inválido.",
  unknown_kid: "secret-box: el sobre se selló con una clave que no está en SECRET_BOX_KEYS.",
  auth: "secret-box: el sobre no autentica (alterado, de otra fila/campo/propósito o de otra clave con el mismo kid).",
  dev_key_on_vercel: "secret-box: un sobre sellado con la clave de desarrollo no se abre en Vercel.",
};

export class SecretBoxError extends Error {
  constructor(public code: SecretBoxErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "SecretBoxError";
  }
}

export const SECRET_BOX_VERSION = "v1";
export const SECRET_BOX_DEV_KID = "dev";

const PURPOSES: ReadonlySet<string> = new Set<SecretBoxPurpose>(["mp-credential", "wa-credential"]);
const KID_RE = /^[a-z0-9_-]{1,16}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const DEV_LABEL = "kinesoft:secret-box:dev:v1";
const FINGERPRINT_LABEL = "kinesoft:secret-box:fingerprint:v1";

type KeyEntry = { kid: string; key: Buffer };

/** Vercel en cualquier entorno. `VERCEL=1` también cuenta: es más conservador que mirar solo `VERCEL_ENV`. */
function onVercel(): boolean {
  return Boolean(process.env.VERCEL_ENV || process.env.VERCEL);
}

/** Decodifica base64 o base64url de forma ESTRICTA: `Buffer.from` ignora basura en silencio. */
function decodeStrictB64(s: string): Buffer | null {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) return null;
  const buf = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const canon = buf.toString("base64").replace(/=+$/, "");
  const given = s.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  return canon === given ? buf : null;
}

/** base64url sin padding, canónico (el último carácter no puede traer bits de relleno distintos de 0). */
function decodeB64Url(s: string, expectedBytes?: number): Buffer | null {
  if (!B64URL_RE.test(s)) return null;
  const buf = Buffer.from(s, "base64url");
  if (buf.toString("base64url") !== s) return null;
  if (expectedBytes !== undefined && buf.length !== expectedBytes) return null;
  return buf;
}

/**
 * `"k2:<b64 32B>,k1:<b64>"` → `[{kid:"k2",key}, {kid:"k1",key}]`; la 1.ª sella.
 * Vacía o ausente → `[]`. Cualquier error → `bad_keys` con mensaje fijo (sin la
 * entrada: si falta el `kid:`, la entrada entera es la clave).
 */
export function parseSecretBoxKeys(raw: string | undefined): { kid: string; key: Buffer }[] {
  if (raw === undefined || raw.trim() === "") return [];
  const out: KeyEntry[] = [];
  const seen = new Set<string>();
  for (const entry of raw.split(",")) {
    const parts = entry.trim().split(":");
    if (parts.length !== 2) throw new SecretBoxError("bad_keys");
    const [kid, b64] = parts;
    if (!KID_RE.test(kid) || kid === SECRET_BOX_DEV_KID || seen.has(kid)) throw new SecretBoxError("bad_keys");
    const key = decodeStrictB64(b64);
    if (!key || key.length !== KEY_BYTES) throw new SecretBoxError("bad_keys");
    seen.add(kid);
    out.push({ kid, key });
  }
  return out;
}

let memo: { raw: string | undefined; keys: KeyEntry[] } | null = null;

function configuredKeys(): KeyEntry[] {
  const raw = process.env.SECRET_BOX_KEYS;
  if (memo && memo.raw === raw) return memo.keys;
  const keys = parseSecretBoxKeys(raw); // tira bad_keys: no se memoiza un error
  memo = { raw, keys };
  return keys;
}

let devMemo: { base: string; key: Buffer } | null = null;

function devKey(): Buffer {
  const base = process.env.SUPABASE_SERVICE_ROLE_KEY || "kinesoft-local-dev";
  if (devMemo && devMemo.base === base) return devMemo.key;
  const key = createHmac("sha256", base).update(DEV_LABEL).digest();
  devMemo = { base, key };
  return key;
}

/** Clave que sella hoy, o error si no hay ninguna utilizable. */
function sealingKey(): KeyEntry {
  const keys = configuredKeys();
  if (keys.length > 0) return keys[0];
  if (onVercel()) throw new SecretBoxError("no_keys");
  return { kid: SECRET_BOX_DEV_KID, key: devKey() };
}

function aadBytes(aad: SecretBoxAad): Buffer {
  const ok =
    aad != null &&
    PURPOSES.has(aad.purpose) &&
    typeof aad.recordId === "string" &&
    typeof aad.field === "string" &&
    aad.recordId.length > 0 &&
    aad.field.length > 0 &&
    !aad.recordId.includes("|") &&
    !aad.field.includes("|");
  if (!ok) throw new SecretBoxError("format");
  return Buffer.from(`kinesoft:secret-box:${SECRET_BOX_VERSION}|${aad.purpose}|${aad.recordId}|${aad.field}`, "utf8");
}

type ParsedBox = { kid: string; iv: Buffer; ct: Buffer; tag: Buffer };

function parseBox(sealed: string): ParsedBox | null {
  if (typeof sealed !== "string") return null;
  const parts = sealed.split(".");
  if (parts.length !== 5 || parts[0] !== SECRET_BOX_VERSION || !KID_RE.test(parts[1])) return null;
  const iv = decodeB64Url(parts[2], IV_BYTES);
  const ct = decodeB64Url(parts[3]);
  const tag = decodeB64Url(parts[4], TAG_BYTES);
  if (!iv || !ct || ct.length === 0 || !tag) return null;
  return { kid: parts[1], iv, ct, tag };
}

/** AES-256-GCM, IV 96 bits, `v1.<kid>.<iv>.<ct>.<tag>`. Texto vacío → `format` (el CHECK de M18 exige ct no vacío). */
export function sealSecret(plaintext: string, aad: SecretBoxAad): string {
  if (typeof plaintext !== "string" || plaintext.length === 0) throw new SecretBoxError("format");
  const aadBuf = aadBytes(aad);
  const { kid, key } = sealingKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aadBuf);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [SECRET_BOX_VERSION, kid, iv.toString("base64url"), ct.toString("base64url"), tag.toString("base64url")].join(".");
}

/** Abre un sobre con la clave de su kid. Errores: format, bad_keys, no_keys, unknown_kid, dev_key_on_vercel, auth. */
export function openSecret(sealed: string, aad: SecretBoxAad): string {
  const box = parseBox(sealed);
  if (!box) throw new SecretBoxError("format");
  const aadBuf = aadBytes(aad);
  let key: Buffer;
  if (box.kid === SECRET_BOX_DEV_KID) {
    if (onVercel()) throw new SecretBoxError("dev_key_on_vercel");
    configuredKeys(); // una variable rota se reporta igual, aunque este sobre sea dev
    key = devKey();
  } else {
    const keys = configuredKeys();
    const hit = keys.find((k) => k.kid === box.kid);
    if (!hit) throw new SecretBoxError(keys.length === 0 && onVercel() ? "no_keys" : "unknown_kid");
    key = hit.key;
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, box.iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aadBuf);
    decipher.setAuthTag(box.tag);
    const pt = Buffer.concat([decipher.update(box.ct), decipher.final()]);
    return pt.toString("utf8");
  } catch {
    // El error de node ("Unsupported state or unable to authenticate data") no
    // trae material, pero se reemplaza igual: el llamador solo necesita `auth`.
    throw new SecretBoxError("auth");
  }
}

/** kid de un sobre bien formado, o null. No abre nada (sirve para listar qué rotar). */
export function sealedKid(sealed: string): string | null {
  return parseBox(sealed)?.kid ?? null;
}

/**
 * true si el sobre no está sellado con la clave que sella hoy (o está roto:
 * hay que mirarlo). Sin ninguna clave que selle (Vercel sin claves) → false:
 * no hay a qué re-sellar. Una variable rota tira `bad_keys`.
 */
export function needsReseal(sealed: string): boolean {
  const keys = configuredKeys();
  const primary = keys[0]?.kid ?? (onVercel() ? null : SECRET_BOX_DEV_KID);
  if (primary === null) return false;
  return sealedKid(sealed) !== primary;
}

function fingerprint(key: Buffer): string {
  // HMAC con la clave y una etiqueta fija, truncado a 48 bits: identifica qué
  // clave hay en cada entorno (comparar Vercel vs el gestor de contraseñas) sin
  // revelar nada utilizable de la clave.
  return createHmac("sha256", key).update(FINGERPRINT_LABEL).digest("hex").slice(0, 12);
}

/** Para Sistema (C-TP13): cantidad, kid primario, huellas y fallback dev. Nunca tira. */
export function secretBoxStatus(): {
  configured: boolean;
  devFallback: boolean;
  primaryKid: string | null;
  kids: string[];
  fingerprints: Record<string, string>;
} {
  let keys: KeyEntry[];
  try {
    keys = configuredKeys();
  } catch {
    // Variable rota: el panel no se cae; se ve "no configurada" sin fallback
    // (sellar tiraría bad_keys, así que decir "usa dev" sería mentir).
    return { configured: false, devFallback: false, primaryKid: null, kids: [], fingerprints: {} };
  }
  if (keys.length > 0) {
    return {
      configured: true,
      devFallback: false,
      primaryKid: keys[0].kid,
      kids: keys.map((k) => k.kid),
      fingerprints: Object.fromEntries(keys.map((k) => [k.kid, fingerprint(k.key)])),
    };
  }
  if (onVercel()) return { configured: false, devFallback: false, primaryKid: null, kids: [], fingerprints: {} };
  return {
    configured: false,
    devFallback: true,
    primaryKid: SECRET_BOX_DEV_KID,
    kids: [],
    fingerprints: { [SECRET_BOX_DEV_KID]: fingerprint(devKey()) },
  };
}

// ── MpCredential ─────────────────────────────────────────────────────────
// Extensión de C-TP1 (no está en el contrato literal): la AAD de los tokens de
// MP vive acá para que el callback OAuth, el refresh del cron y la rotación
// sellen y abran EXACTAMENTE con la misma AAD ("por cuenta y campo", §25.3).
// recordId = MpAccount.id (no MpCredential.id): la credencial es 1:1 con la
// cuenta y se puede recrear sin re-sellar.
export type MpCredentialField = "accessToken" | "refreshToken";

export function mpCredentialAad(mpAccountId: string, field: MpCredentialField): SecretBoxAad {
  return { purpose: "mp-credential", recordId: mpAccountId, field };
}

// ── WhatsApp (WA, C-WA3) ─────────────────────────────────────────────────
// Igual que `mpCredentialAad`: el alta (Embedded Signup), el envío y la rotación sellan y abren con la MISMA AAD.
// recordId = id de la cuenta de WhatsApp del consultorio (no de la fila de credencial: se puede recrear sin re-sellar).
//   token = token de negocio de la WABA (lo devuelve el canje del `code`, vive mientras no se revoque).
//   pin   = PIN de 6 dígitos con el que se registró el número en la Cloud API (aleatorio, hace falta para re-registrar).
export type WaCredentialField = "token" | "pin";

export function waCredentialAad(waAccountId: string, field: WaCredentialField): SecretBoxAad {
  return { purpose: "wa-credential", recordId: waAccountId, field };
}
