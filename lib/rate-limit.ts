/**
 * Rate limiter primitive.
 *
 * - **Upstash-backed** fixed window when `UPSTASH_REDIS_REST_URL` + TOKEN are
 *   set — REST pipeline `INCR` + `PEXPIRE NX` + `PTTL`, shared across lambdas.
 * - **In-memory** fixed window otherwise, and as the fallback when Upstash
 *   fails (per process: on Vercel each isolate has its own Map, so it is
 *   advisory only — Upstash is the real limiter in prod, SECURITY.md §8).
 *
 * A3a-S-rl (auditoría 2026-09-23) endureció el camino de Upstash:
 *   - antes un error de red **tiraba** (el `fetch` sin try/catch rompía el
 *     login entero) y un Upstash colgado colgaba la request: ahora hay
 *     try/catch + `AbortSignal.timeout(1500)` y cualquier falla cae a memoria
 *     **con log** (throttleado, para no inundar si Upstash está caído);
 *   - antes se hacía `Number(data[0]?.result ?? 0)`: una respuesta con
 *     `{ error }` (p. ej. token inválido) daba count 0 = "pasa siempre".
 *     Ahora se valida la forma de cada comando y si no cierra → fallback;
 *   - las claves llevan prefijo por entorno (`rl:<VERCEL_ENV|dev>:`) para que
 *     Preview y Production compartiendo la misma base de Upstash no se
 *     consuman el cupo entre sí;
 *   - el Map en memoria se purga (vencidas + tope de tamaño): antes crecía sin
 *     límite con cada IP distinta.
 *
 * Claves con PII: nunca el email crudo — usar `hashKeyPart(email)`.
 *
 * Usage:
 *
 *     const r = await rateLimitAll([
 *       { key: `login:ip:${clientIp(req.headers)}`, limit: 10, windowMs: 60_000 },
 *       { key: `login:email:${hashKeyPart(email)}`, limit: 10, windowMs: 15 * 60_000 },
 *     ]);
 *     if (!r.ok) return { ok: false, error: rateLimitedMessage(r.retryAfterMs) };
 */
import { createHash } from "node:crypto";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

export type RateLimitResult = { ok: boolean; remaining: number; retryAfterMs: number };
export type RateLimitOpts = { limit: number; windowMs: number };
export type RateLimitCheck = RateLimitOpts & { key: string };

/** Timeout del fetch a Upstash. Un rate-limit nunca puede tardar más que eso. */
export const UPSTASH_TIMEOUT_MS = 1500;
/** Tope de claves en el Map en memoria; al pasarlo se purgan vencidas y, si no alcanza, las más viejas. */
export const MEMORY_MAX_KEYS = 10_000;
/** Cada cuántas llamadas se barre el Map buscando entradas vencidas. */
const SWEEP_EVERY = 500;
/** Un log de fallback por minuto como mucho (Upstash caído = una línea, no una por request). */
const FALLBACK_LOG_EVERY_MS = 60_000;

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();
let callsSinceSweep = 0;
let lastFallbackLogAt = 0;

/** Prefijo por entorno: Preview/Production/dev no comparten contadores en Upstash. */
function prefixed(key: string): string {
  return `rl:${env.VERCEL_ENV ?? "dev"}:${key}`;
}

/**
 * Hash corto (sha256, 32 hex) para meter un email u otro dato personal en una
 * clave sin guardarlo en claro en Redis ni en logs. Normaliza trim + lowercase
 * para que `A@x.com` y `a@x.com ` caigan en el mismo bucket.
 */
export function hashKeyPart(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex").slice(0, 32);
}

/** Mensaje uniforme para actions limitadas (A3a-S-rl §4). */
export function rateLimitedMessage(retryAfterMs: number): string {
  const s = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return `Demasiados intentos. Probá de nuevo en ${s} s.`;
}

export async function rateLimit(key: string, opts: RateLimitOpts): Promise<RateLimitResult> {
  const k = prefixed(key);
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    return upstash(k, opts, env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN);
  }
  return memory(k, opts);
}

/**
 * Claves compuestas (IP + email, actor + destinatario): pasa solo si **todas**
 * pasan. Se cuentan todas aunque una ya haya fallado (así un atacante que
 * rota IPs igual consume el cupo del email). `retryAfterMs` = el máximo;
 * `remaining` = el mínimo.
 */
export async function rateLimitAll(checks: RateLimitCheck[]): Promise<RateLimitResult> {
  const results = await Promise.all(
    checks.map((c) => rateLimit(c.key, { limit: c.limit, windowMs: c.windowMs }))
  );
  const ok = results.every((r) => r.ok);
  return {
    ok,
    remaining: results.reduce((m, r) => Math.min(m, r.remaining), Number.POSITIVE_INFINITY),
    retryAfterMs: ok ? 0 : results.reduce((m, r) => Math.max(m, r.retryAfterMs), 0),
  };
}

function sweep(now: number) {
  callsSinceSweep = 0;
  for (const [k, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(k);
  }
  // Todavía lleno (flood de claves vivas): se descartan las más viejas por
  // orden de inserción del Map. Perder un contador vivo solo afloja el límite
  // de esa clave; crecer sin tope tumba el proceso.
  if (buckets.size >= MEMORY_MAX_KEYS) {
    const excess = buckets.size - Math.floor(MEMORY_MAX_KEYS * 0.9);
    let i = 0;
    for (const k of buckets.keys()) {
      if (i++ >= excess) break;
      buckets.delete(k);
    }
  }
}

function memory(key: string, opts: RateLimitOpts): RateLimitResult {
  const now = Date.now();
  if (++callsSinceSweep >= SWEEP_EVERY || buckets.size >= MEMORY_MAX_KEYS) sweep(now);
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    // delete + set: la clave renovada pasa al final del orden de inserción,
    // así la evicción por tope descarta primero las realmente viejas.
    buckets.delete(key);
    b = { count: 0, resetAt: now + opts.windowMs };
    buckets.set(key, b);
  }
  b.count++;
  const ok = b.count <= opts.limit;
  return {
    ok,
    remaining: Math.max(0, opts.limit - b.count),
    retryAfterMs: ok ? 0 : Math.max(0, b.resetAt - now),
  };
}

function fallback(key: string, opts: RateLimitOpts, reason: string, detail?: string): RateLimitResult {
  const now = Date.now();
  if (now - lastFallbackLogAt >= FALLBACK_LOG_EVERY_MS) {
    lastFallbackLogAt = now;
    // Sin la clave: lleva IP / hash de email. El namespace alcanza para ubicar la superficie.
    logger.warn("rate_limit.upstash_fallback", {
      reason,
      detail,
      namespace: key.split(":").slice(2, 3)[0],
    });
  }
  return memory(key, opts);
}

type PipelineItem = { result?: unknown; error?: unknown };

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

async function upstash(
  key: string,
  opts: RateLimitOpts,
  baseUrl: string,
  token: string
): Promise<RateLimitResult> {
  let data: unknown;
  try {
    const res = await fetch(`${baseUrl}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify([
        ["INCR", key],
        ["PEXPIRE", key, String(opts.windowMs), "NX"],
        ["PTTL", key],
      ]),
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTASH_TIMEOUT_MS),
    });
    if (!res.ok) return fallback(key, opts, "http", String(res.status));
    data = await res.json();
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    const reason = name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
    return fallback(key, opts, reason, err instanceof Error ? err.message : String(err));
  }

  // Forma esperada: [{result:int>=1}, {result:0|1}, {result:int}]. Cualquier
  // `{ error }` o tipo raro → fallback (antes daba count 0 = "pasa siempre").
  if (!Array.isArray(data) || data.length !== 3) return fallback(key, opts, "shape");
  const items = data as PipelineItem[];
  if (items.some((i) => !i || typeof i !== "object" || i.error !== undefined)) {
    return fallback(key, opts, "command_error", String(items.find((i) => i?.error)?.error ?? ""));
  }
  const count = items[0].result;
  const ttlRaw = items[2].result;
  if (!isInt(count) || count < 1 || !isInt(ttlRaw)) return fallback(key, opts, "shape");

  // PTTL -1/-2 (sin expiración / no existe) no debería pasar tras PEXPIRE NX;
  // si pasa, se asume la ventana completa en vez de devolver un Retry-After negativo.
  const ttl = ttlRaw > 0 ? ttlRaw : opts.windowMs;
  const ok = count <= opts.limit;
  return {
    ok,
    remaining: Math.max(0, opts.limit - count),
    retryAfterMs: ok ? 0 : ttl,
  };
}

/** Convenience for JSON/API route handlers — returns a 429 Response if the
 * request must be rejected, otherwise null so the caller continues. Los
 * handlers de formulario (login, google) redirigen 303 con
 * `?error=rate_limited` en vez de usar esto. */
export async function rateLimitHandler(key: string, opts: RateLimitOpts) {
  const r = await rateLimit(key, opts);
  if (r.ok) return null;
  return new Response("Too many requests", {
    status: 429,
    headers: {
      "Retry-After": String(Math.ceil(r.retryAfterMs / 1000)),
      "X-RateLimit-Remaining": String(r.remaining),
    },
  });
}

/** Solo tests: estado interno del limitador en memoria. */
export const __rateLimitInternals = {
  reset() {
    buckets.clear();
    callsSinceSweep = 0;
    lastFallbackLogAt = 0;
  },
  size: () => buckets.size,
};
