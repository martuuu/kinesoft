import { runCronRoute, runInvitationsExpire } from "@/lib/cron-jobs-internal";

export const runtime = "nodejs";
// Nunca estático ni cacheado: un cron que responde desde cache no corre el job.
export const dynamic = "force-dynamic";

/**
 * BO5-A · `GET /api/cron/invitations-expire` (Vercel Cron, diario 06:00 UTC = 03:00 AR). Solo cuenta: el estado
 * «vencida» se deriva de `expiresAt` (decisión en `runInvitationsExpire`). Auth: `Authorization: Bearer CRON_SECRET`.
 */
export function GET(req: Request): Promise<Response> {
  return runCronRoute(req, "invitations-expire", runInvitationsExpire);
}
