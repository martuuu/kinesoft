/**
 * Redacción de PII y secretos para logs y eventos de Sentry (A3b-S-obs).
 *
 * Módulo PURO (sin imports): lo usan `lib/logger.ts` (Node), `lib/observability.ts`
 * y los `sentry.{server,edge}.config.ts`. El de edge no puede arrastrar
 * `lib/logger.ts` (→ `lib/env` + `node:async_hooks`), por eso la redacción vive
 * acá y el logger la re-exporta.
 *
 * Dos capas:
 *   1. Por CLAVE: cualquier campo cuyo nombre contenga password/secret/token/
 *      authorization/cookie/apikey/dni/documentId/cuit/cuil/phone se reemplaza
 *      entero, sin mirar el valor (un header `cookie` o un `tokenHash` no se
 *      filtra "a medias").
 *   2. Por VALOR (en todo string, a cualquier profundidad): emails, JWTs,
 *      `Bearer …`, tokens de Mercado Pago (`APP_USR-…`/`TEST-…`), parámetros de
 *      query sensibles (`?token=`, `access_token=`, `code=`…) y DNIs con puntos
 *      o precedidos de "DNI".
 *
 * Qué NO se redacta a propósito: ids (cuid/uuid), montos en centavos y números
 * sueltos de 7-8 dígitos — son la materia prima para debuggear y un regex de
 * "DNI pelado" se comería cualquier monto. El DNI pelado se cubre por clave
 * (`documentId`, `dni`).
 */

export const REDACTED = "[redacted]";

// Se compara contra la clave en minúsculas y sin `-`/`_`: `access_token`,
// `Set-Cookie`, `x-api-key`, `documentId` → `accesstoken`, `setcookie`, …
const SENSITIVE_KEY =
  /(password|passwd|secret|token|authorization|cookie|apikey|dni|documentid|cuit|cuil|phone|whatsapp)/;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key.toLowerCase().replace(/[-_]/g, ""));
}

const STRING_RULES: Array<[RegExp, string]> = [
  // JWT (Supabase access/refresh tokens, links de invitación firmados).
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, "[token]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [token]"],
  // API keys nuevas de Supabase (SV: el publisher usa la secret key; si un error la arrastra, que Sentry no la vea).
  [/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, "[token]"],
  // Access tokens de Mercado Pago.
  [/\b(APP_USR|TEST)-[A-Za-z0-9-]{16,}/g, "[token]"],
  // Parámetros de URL/form con secretos (`/invite?token=…`, callbacks OAuth `code=`).
  [
    /([?&#](?:token|access_token|refresh_token|id_token|code|password|secret|key|sentry_key|token_hash)=)[^&#\s"']+/gi,
    "$1[redacted]",
  ],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  // DNI explícito ("DNI 30.123.456", "dni: 30123456") o con formato de puntos.
  [/\bDNI\s*:?\s*[\d.]{7,11}/gi, "DNI [redacted]"],
  [/\b\d{1,2}\.\d{3}\.\d{3}\b/g, "[dni]"],
];

export function redactString(s: string): string {
  let out = s;
  for (const [re, rep] of STRING_RULES) out = out.replace(re, rep);
  return out;
}

const MAX_DEPTH = 12;

/**
 * Devuelve una COPIA redactada (nunca muta la entrada: el objeto puede ser el
 * `ctx` del caller o el evento de Sentry que después se reusa). Tolera ciclos
 * y corta a `MAX_DEPTH`. Los `Error` se aplanan a `{ name, message, stack }`
 * redactados, porque JSON.stringify de un Error da `{}`.
 */
export function redact<T>(value: T): T {
  return walk(value, 0, new WeakSet()) as T;
}

function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[depth]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (value instanceof Date) return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    };
  }
  if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1, seen));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSensitiveKey(k) && v != null && v !== "" ? REDACTED : walk(v, depth + 1, seen);
  }
  return out;
}
