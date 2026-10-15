import { pingDb } from "@/lib/db-ping";
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
 * - El ping (`SELECT 1` con timeout de 2 s) vive en `lib/db-ping.ts` desde BO3-E: lo comparte con el panel de
 *   Sistema de Plataforma, así los dos miden lo mismo.
 * - Respuesta mínima `{ ok, db, time }`: SIN entorno, versión, commit ni mensaje de error. Es un endpoint
 *   público; el detalle de la falla va al log del server.
 * - Rate limit por IP (60/min): un monitor pega cada 30-60 s; más que eso es abuso (cada hit abre una
 *   query a la base).
 */
const RATE = { limit: 60, windowMs: 60_000 };

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
