import { runCronRoute, runTrialReminders } from "@/lib/cron-jobs-internal";

export const runtime = "nodejs";
// Nunca estático ni cacheado: un cron que responde desde cache no corre el job.
export const dynamic = "force-dynamic";

/**
 * BO5-A · `GET /api/cron/trial-reminders` (Vercel Cron, diario 12:00 UTC = 09:00 AR: el mail llega en horario de
 * consultorio). Recordatorio de fin de prueba a los OWNER (7/3/1 días y al vencer), una vez por etapa y prueba.
 * Auth: `Authorization: Bearer CRON_SECRET`.
 */
export function GET(req: Request): Promise<Response> {
  return runCronRoute(req, "trial-reminders", runTrialReminders);
}
