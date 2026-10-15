import { runCronRoute, runHealthDigest } from "@/lib/cron-jobs-internal";

export const runtime = "nodejs";
// Nunca estático ni cacheado: un cron que responde desde cache no corre el job.
export const dynamic = "force-dynamic";

/**
 * BO5-A · `GET /api/cron/health-digest` (Vercel Cron, diario 11:00 UTC = 08:00 AR). Detectores de
 * /plataforma/salud → fila `platform.cron.health_digest` y, si hay algo, mail a los superadmins. Una vez por día AR.
 * Auth: `Authorization: Bearer CRON_SECRET`.
 */
export function GET(req: Request): Promise<Response> {
  return runCronRoute(req, "health-digest", runHealthDigest);
}
