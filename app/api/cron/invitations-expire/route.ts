import { runCronRoute, runInvitationsExpire } from "@/lib/cron-jobs-internal";

export const runtime = "nodejs";
// Nunca estático ni cacheado: un cron que responde desde cache no corre el job.
export const dynamic = "force-dynamic";

/**
 * BO5-A · `GET /api/cron/invitations-expire` (Vercel Cron, diario 06:00 UTC = 03:00 AR). Solo cuenta: el estado
 * «vencida» se deriva de `expiresAt` (decisión en `runInvitationsExpire`). Auth: `Authorization: Bearer CRON_SECRET`.
 *
 * PL-2b (PL-D18): ya NO está en `vercel.json`; Vercel corre este job dentro de `/api/cron/daily` (`runDaily`). La
 * ruta queda como disparo manual de este job suelto (mismo secreto), útil para reintentar uno solo.
 */
export function GET(req: Request): Promise<Response> {
  return runCronRoute(req, "invitations-expire", runInvitationsExpire);
}
