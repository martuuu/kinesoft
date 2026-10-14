import { prisma } from "@/lib/db";
import { clientIp } from "@/lib/client-ip";
import { rateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
// Nunca estático ni cacheado: un health que responde desde cache dice «ok» con la base caída.
export const dynamic = "force-dynamic";

/**
 * BO1-D — `GET /api/health` para el monitor externo (§19.9: «monitor externo de /api/health» antes de
 * vender).
 *
 * - `SELECT 1` por el `prisma` de la app (el mismo pool que usan las requests reales; no toca tablas, así
 *   que no depende de RLS ni del tenant).
 * - Timeout de 2 s con `Promise.race`: con la base colgada (pool agotado, Supabase pausado) el `$queryRaw`
 *   puede esperar hasta el `connect_timeout` del pool; el monitor tiene que ver 503 rápido, no un timeout
 *   suyo que no distingue «base caída» de «app caída».
 * - Respuesta mínima `{ ok, db, time }`: SIN entorno, versión, commit ni mensaje de error. Es un endpoint
 *   público; el detalle de la falla va al log del server.
 * - Rate limit por IP (60/min): un monitor pega cada 30-60 s; más que eso es abuso (cada hit abre una
 *   query a la base).
 */
const DB_TIMEOUT_MS = 2_000;
const RATE = { limit: 60, windowMs: 60_000 };

async function pingDb(): Promise<{ up: true } | { up: false; reason: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("db_timeout")), DB_TIMEOUT_MS);
  });
  try {
    await Promise.race([prisma.$queryRaw`SELECT 1`, timeout]);
    return { up: true };
  } catch (err) {
    return { up: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function GET(req: Request): Promise<Response> {
  const noStore = { "cache-control": "no-store, max-age=0" };

  const rl = await rateLimit(`health:ip:${clientIp(req.headers)}`, RATE);
  if (!rl.ok) {
    return new Response(null, {
      status: 429,
      headers: { ...noStore, "retry-after": String(Math.ceil(rl.retryAfterMs / 1000)) },
    });
  }

  const db = await pingDb();
  if (!db.up) logger.error("health.db_down", { reason: db.reason });

  return Response.json(
    { ok: db.up, db: db.up ? "ok" : "down", time: new Date().toISOString() },
    { status: db.up ? 200 : 503, headers: noStore }
  );
}
