import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * WA-P3 (T6, C-WA3, brief §26.5) · Cripto de WhatsApp: firma del webhook de Meta, verify token, hash y máscara del
 * teléfono y la cookie del alta (Embedded Signup). Sin I/O ni base: lo usan la ruta del webhook (WA-S3), las actions de
 * la cuenta (WA-S1/S5), la cola (el hash y la máscara del destinatario) y el simulador (`signMetaPayload`).
 *
 * La credencial (token del system user y PIN del número) NO se sella acá: va por `lib/secret-box.ts` con
 * `waCredentialAad(accountId, "token"|"pin")`, propósito `wa-credential`, que no abre una caja de MP (AAD distinta).
 */

// ── Firma del webhook ──────────────────────────────────────────────────────────────────────────────────────────

const SIG_RE = /^sha256=([0-9a-f]{64})$/i;

/**
 * `X-Hub-Signature-256` de Meta: `sha256=<hex>` = HMAC-SHA256(App Secret, cuerpo CRUDO). Sobre los bytes tal cual
 * llegaron, nunca sobre un `JSON.stringify` del body parseado: Meta escapa unicode (`á`) y el orden/espaciado
 * de la re-serialización no es el suyo, así que una firma válida no verificaría (y peor, verificar sobre lo parseado
 * invita a aceptar lo que no se firmó). Comparación en tiempo constante sobre los 32 bytes; nunca tira.
 */
export function verifyMetaSignature(
  raw: Buffer,
  header: string | null | undefined,
  appSecret: string | null | undefined
): boolean {
  if (!appSecret || typeof header !== "string" || !Buffer.isBuffer(raw)) return false;
  const m = SIG_RE.exec(header.trim());
  if (!m) return false;
  const given = Buffer.from(m[1].toLowerCase(), "hex");
  const expected = createHmac("sha256", appSecret).update(raw).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** La firma que pondría Meta. SOLO la usa el simulador (`fake-graph.ts`) y los tests: el server nunca firma webhooks. */
export function signMetaPayload(raw: Buffer | string, appSecret: string): string {
  return `sha256=${createHmac("sha256", appSecret).update(raw).digest("hex")}`;
}

function safeEqualStr(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  // Largos distintos → false sin llamar a timingSafeEqual (tira con largos distintos); el largo no es secreto.
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * GET del webhook (`hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`): ¿el token que mandó Meta es el nuestro?
 * Vacío contra vacío es false: un `WHATSAPP_WEBHOOK_VERIFY_TOKEN` sin configurar no puede validar un GET sin token.
 */
export function verifyTokenMatches(given: string | null | undefined, expected: string | null | undefined): boolean {
  if (!given || !expected) return false;
  return safeEqualStr(given, expected);
}

// ── Claves derivadas ───────────────────────────────────────────────────────────────────────────────────────────

const PHONE_LABEL = "kinesoft:wa-phone:v1";
const SIGNUP_LABEL = "kinesoft:wa-signup:v1";
const LOCAL_BASE = "kinesoft-local-dev";

const onVercel = () => Boolean(process.env.VERCEL_ENV || process.env.VERCEL);

/**
 * Clave HMAC derivada de `SUPABASE_SERVICE_ROLE_KEY` con una etiqueta propia (WA-D29: no hay una env más; misma
 * familia que `oauth-state`, `support-session`, `display-pairing`). Se lee `process.env` en cada llamada (los tests
 * la cambian en caliente) con memo por base.
 *
 * Sin service key: en local, una base determinista (el hash del teléfono se GUARDA en la base y el webhook lo
 * recalcula en otro proceso de `next dev`: una clave aleatoria por proceso rompería el ruteo de las respuestas). En
 * Vercel sin service key (el ENV la exige en Production) → tira: falla cerrado, nada se encola con un hash que después
 * no se puede volver a calcular.
 */
const memo = new Map<string, { base: string; key: Buffer }>();
function derivedKey(label: string): Buffer {
  const base = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || (onVercel() ? null : LOCAL_BASE);
  if (!base) throw new Error(`[${label}] falta SUPABASE_SERVICE_ROLE_KEY`);
  const hit = memo.get(label);
  if (hit && hit.base === base) return hit.key;
  const key = createHmac("sha256", base).update(label).digest();
  memo.set(label, { base, key });
  return key;
}

// ── Teléfono ───────────────────────────────────────────────────────────────────────────────────────────────────

const E164_RE = /^\+[1-9][0-9]{6,14}$/;

/**
 * `toHash` / `fromHash` de M15 (CHECK `^[0-9a-f]{64}$`): HMAC-SHA256 con clave derivada (label
 * `kinesoft:wa-phone:v1`) del E.164. Un SHA-256 pelado no sirve: los celulares de AR son ~10^10, se revierten por
 * fuerza bruta en minutos y la tabla de mensajes quedaría con los teléfonos de todos los pacientes. Con la clave, sin
 * la service role no hay forma de pasar del hash al número. Tira si no es E.164 (bug del caller: el número viene de
 * `normalizeArMobile` o del `from` de Meta con `+`).
 */
export function phoneHash(e164: string): string {
  if (typeof e164 !== "string" || !E164_RE.test(e164)) throw new RangeError("[wa-phone] el número no es E.164");
  return createHmac("sha256", derivedKey(PHONE_LABEL)).update(e164, "utf8").digest("hex");
}

/**
 * Número enmascarado para el historial y la UI (`toMasked`, CHECK 4..32): `+54 9 11 ****-6789`. Celular de AR:
 * país, el 9, los 2 primeros dígitos del área y los últimos 4 (lo que necesita la Secretaría para reconocer «es el de
 * la madre»). Otro país: los 2 primeros dígitos y los últimos 4. Algo que no es E.164 → `****` (nunca el valor).
 */
export function maskPhone(e164: string): string {
  if (typeof e164 !== "string" || !E164_RE.test(e164)) return "****";
  const d = e164.slice(1);
  if (d.startsWith("549") && d.length === 13) return `+54 9 ${d.slice(3, 5)} ****-${d.slice(-4)}`;
  return `+${d.slice(0, 2)} ****-${d.slice(-4)}`;
}

// ── Cookie del alta (Embedded Signup) ──────────────────────────────────────────────────────────────────────────

/**
 * `kine_wa_signup`: la emite `startWhatsAppConnect` y la exige `completeWhatsAppConnect` (C-WA6 paso 1). Molde
 * `lib/mp-connect/oauth-state.ts`, con dos diferencias:
 *   - no hay `state` que viaje a Meta: el Embedded Signup v4 devuelve el `code` por el callback de `FB.login` en el
 *     MISMO navegador (no por una redirección), así que la defensa es la cookie atada a usuario + sesión + consultorio
 *     + nonce. El nonce vuelve del cliente en la action de completar (`ctx.nonce`): un `code` que llega de otra pestaña
 *     o de un intento anterior no conecta la cuenta;
 *   - `SameSite=Strict` y `path=/configuracion`: la action de completar es un POST same-origin desde esa página (no
 *     hay vuelta cross-site como en el OAuth de MP), y la cookie no viaja en ninguna otra ruta.
 * Firmada con su propia etiqueta (`kinesoft:wa-signup:v1`): una cookie del OAuth de MP no valida acá (lo cubre el test).
 */
export const WA_SIGNUP_COOKIE = "kine_wa_signup";
export const WA_SIGNUP_TTL_S = 10 * 60;
export const WA_SIGNUP_COOKIE_PATH = "/configuracion";

export type WaSignupStateInput = {
  userId: string;
  sessionId: string;
  tenantId: string;
  nonce: string;
  /** Epoch en segundos (`waSignupExp(nowMs)`). */
  exp: number;
};
export type WaSignupStateClaims = WaSignupStateInput;
export type WaSignupStateError = "bad_mac" | "expired" | "other_user" | "other_session" | "other_tenant" | "nonce_mismatch";
export type WaSignupStateContext = { userId: string; sessionId: string; tenantId: string; nonce: string; nowMs?: number };

const MAX_COOKIE_LEN = 2048;
const MAX_ID_LEN = 128;
const NONCE_RE = /^[A-Za-z0-9_-]{22,128}$/;
const EXP_SKEW_S = 5;

function okId(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_ID_LEN;
}

function validShape(o: WaSignupStateInput): boolean {
  return (
    okId(o.userId) &&
    okId(o.sessionId) &&
    okId(o.tenantId) &&
    typeof o.nonce === "string" &&
    NONCE_RE.test(o.nonce) &&
    typeof o.exp === "number" &&
    Number.isInteger(o.exp)
  );
}

function signupMac(payload: string): string {
  return createHmac("sha256", derivedKey(SIGNUP_LABEL)).update(`cookie\0${payload}`).digest("base64url");
}

/** Nonce por intento de alta (256 bits). */
export function newSignupNonce(): string {
  return randomBytes(32).toString("base64url");
}

export function waSignupExp(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000) + WA_SIGNUP_TTL_S;
}

export function waSignupCookieOptions(): {
  httpOnly: true;
  sameSite: "strict";
  path: string;
  maxAge: number;
  secure: boolean;
} {
  return {
    httpOnly: true,
    sameSite: "strict",
    path: WA_SIGNUP_COOKIE_PATH,
    maxAge: WA_SIGNUP_TTL_S,
    secure: process.env.NODE_ENV === "production",
  };
}

/** Firma la cookie. Tira ante una entrada que nunca debería firmarse (bug del caller). */
export function makeSignupState(o: WaSignupStateInput): string {
  if (!validShape(o)) throw new Error("[wa-signup] entrada inválida");
  const payload = Buffer.from(
    JSON.stringify({ u: o.userId, s: o.sessionId, t: o.tenantId, n: o.nonce, x: o.exp })
  ).toString("base64url");
  return `${payload}.${signupMac(payload)}`;
}

/**
 * Valida la cookie contra el actor actual. Orden: firma → forma → vencimiento → usuario → sesión → consultorio →
 * nonce. Nunca tira (salvo la falla cerrada de la clave en Vercel sin service key).
 */
export function readSignupState(
  cookie: string | null | undefined,
  ctx: WaSignupStateContext
): WaSignupStateClaims | { error: WaSignupStateError } {
  const nowMs = ctx.nowMs ?? Date.now();
  if (!cookie || cookie.length > MAX_COOKIE_LEN) return { error: "bad_mac" };
  const parts = cookie.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { error: "bad_mac" };
  const [payload, sig] = parts;
  // Firma primero: no se parsea nada que no hayamos firmado nosotros.
  if (!safeEqualStr(signupMac(payload), sig)) return { error: "bad_mac" };

  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { error: "bad_mac" };
  }
  if (!raw || typeof raw !== "object") return { error: "bad_mac" };
  const r = raw as Record<string, unknown>;
  const claims = { userId: r.u, sessionId: r.s, tenantId: r.t, nonce: r.n, exp: r.x } as WaSignupStateClaims;
  if (!validShape(claims)) return { error: "bad_mac" };

  if (claims.exp * 1000 <= nowMs) return { error: "expired" };
  // Un exp más lejos que el TTL no lo emitimos nunca: solo con la clave filtrada o un bug → se rechaza.
  if (claims.exp * 1000 > nowMs + (WA_SIGNUP_TTL_S + EXP_SKEW_S) * 1000) return { error: "expired" };
  if (!okId(ctx.userId) || !safeEqualStr(claims.userId, ctx.userId)) return { error: "other_user" };
  if (!okId(ctx.sessionId) || !safeEqualStr(claims.sessionId, ctx.sessionId)) return { error: "other_session" };
  if (!okId(ctx.tenantId) || !safeEqualStr(claims.tenantId, ctx.tenantId)) return { error: "other_tenant" };
  if (typeof ctx.nonce !== "string" || !safeEqualStr(claims.nonce, ctx.nonce)) return { error: "nonce_mismatch" };
  return claims;
}
