import "server-only";
/**
 * BO3-E · ping a la base que usan `GET /api/health` (BO1-D) y `/plataforma/sistema`.
 *
 * Extraído de `app/api/health/route.ts` para que el panel de Sistema llame a LA MISMA función que el monitor externo
 * (no a una copia que diverja, ni por HTTP a sí mismo: en Vercel eso es otra lambda y el rate limit por IP del
 * endpoint público). Un `route.ts` no puede exportar helpers (Next solo acepta los handlers y la config de la ruta).
 *
 * - `SELECT 1` por el `prisma` de la app (el mismo pool que usan las requests reales; no toca tablas, así que no
 *   depende de RLS ni del tenant).
 * - Timeout de 2 s con `Promise.race`: con la base colgada (pool agotado, Supabase pausado) el `$queryRaw` puede
 *   esperar hasta el `connect_timeout` del pool; el monitor tiene que ver 503 rápido.
 * - `reason` es el mensaje del error: va al log del server, NUNCA a una respuesta ni a un DTO (puede traer el host).
 */
import { prisma } from "@/lib/db";

export const DB_PING_TIMEOUT_MS = 2_000;

export type DbPing = { up: true; ms: number } | { up: false; ms: number; reason: string };

export async function pingDb(): Promise<DbPing> {
  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("db_timeout")), DB_PING_TIMEOUT_MS);
  });
  try {
    await Promise.race([prisma.$queryRaw`SELECT 1`, timeout]);
    return { up: true, ms: Date.now() - t0 };
  } catch (err) {
    return { up: false, ms: Date.now() - t0, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
