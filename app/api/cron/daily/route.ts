import { runCronRoute, runDaily } from "@/lib/cron-jobs-internal";

export const runtime = "nodejs";
// Nunca estático ni cacheado: un cron que responde desde cache no corre el job.
export const dynamic = "force-dynamic";
// Presupuesto de trabajo 45 s (`DAILY_BUDGET_MS`) dentro del techo de Vercel Hobby (60 s; también en vercel.json).
export const maxDuration = 60;

/**
 * PL-2b (H-PL4, PL-D18) · `GET /api/cron/daily`: el ÚNICO cron de `vercel.json` (diario 11:00 UTC = 08:00 AR).
 * Cobros de la suscripción (precios con vigencia, cargos del período, vencidos/al día, mails) y después los jobs de
 * BO5-A (invitaciones, recordatorios de prueba, resumen de salud). Cada etapa es idempotente: un reintento de Vercel
 * o un disparo a mano no duplica cargos ni mails. Auth: `Authorization: Bearer CRON_SECRET`.
 */
export function GET(req: Request): Promise<Response> {
  return runCronRoute(req, "daily", runDaily);
}
