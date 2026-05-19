/**
 * Rate limiter primitive.
 *
 * - **In-memory sliding window** by default (per process, fine for dev
 *   and single-replica deploys).
 * - **Upstash-backed** path when `UPSTASH_REDIS_REST_URL` + TOKEN are set
 *   — uses Upstash's REST API with `INCR` + `PEXPIRE` for atomic counts
 *   across replicas. Falls back automatically.
 *
 * Usage:
 *
 *     const { ok, retryAfterMs } = await rateLimit("login:" + ip, { limit: 5, windowMs: 60_000 });
 *     if (!ok) return new Response("too many requests", { status: 429, headers: { "Retry-After": ... } });
 */
import { env } from "@/lib/env";

type Result = { ok: boolean; remaining: number; retryAfterMs: number };

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

export async function rateLimit(
  key: string,
  opts: { limit: number; windowMs: number }
): Promise<Result> {
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    return upstash(key, opts);
  }
  return memory(key, opts);
}

function memory(key: string, opts: { limit: number; windowMs: number }): Result {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
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

async function upstash(
  key: string,
  opts: { limit: number; windowMs: number }
): Promise<Result> {
  // Atomic INCR + (set TTL on first hit). Upstash REST pipeline.
  const url = `${env.UPSTASH_REDIS_REST_URL}/pipeline`;
  const body = [
    ["INCR", key],
    ["PEXPIRE", key, String(opts.windowMs), "NX"],
    ["PTTL", key],
  ];
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    // Fall back to memory on transport errors — never block the request on
    // observability infra.
    return memory(key, opts);
  }
  const data = (await res.json()) as { result: number }[];
  const count = Number(data[0]?.result ?? 0);
  const ttl = Number(data[2]?.result ?? opts.windowMs);
  const ok = count <= opts.limit;
  return {
    ok,
    remaining: Math.max(0, opts.limit - count),
    retryAfterMs: ok ? 0 : Math.max(0, ttl),
  };
}

/** Convenience for Next.js route handlers — returns a Response if the
 * request must be rejected, otherwise null so the caller continues. */
export async function rateLimitHandler(
  key: string,
  opts: { limit: number; windowMs: number }
) {
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
