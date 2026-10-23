import { runCronRoute, type CronJobName } from "@/lib/cron-jobs-internal";
import { runWhatsAppCron } from "@/lib/whatsapp/reminders-internal";
import { prepareWhatsAppDocument } from "@/lib/whatsapp/document-internal";

export const runtime = "nodejs";
// Nunca estático ni cacheado: un cron que responde desde cache no corre el job.
export const dynamic = "force-dynamic";
// Presupuesto de trabajo 45 s (default de `runWhatsAppCron`) dentro del techo de Vercel Hobby (60 s; también en vercel.json).
export const maxDuration = 60;

/**
 * Handoff a INT: sumar `"whatsapp"` a `CronJobName` (lib/cron-jobs-internal.ts, no es de WA-S4) y sacar este cast. El
 * nombre solo va al log (`cron.done`) y a la respuesta; reusar «daily» haría que el log del cron de las 18:00 se lea
 * como el diario.
 */
const JOB = "whatsapp" as unknown as CronJobName;

/**
 * WA-S4 (T6, C-WA9, WA-D19) · `GET /api/cron/whatsapp`: el segundo cron de `vercel.json`, `0 21 * * *` = 18:00 AR.
 * Recordatorios de los turnos de mañana, drain de la cola, vencidos y sync de plantillas/calidad con Meta
 * (`runWhatsAppCron`). Queda FUERA de `runDaily`: no comparte presupuesto con los cobros de MPS. Con
 * `WHATSAPP_MODE=off` responde 200 con `skipped: "off"` sin tocar la base. Auth: `Authorization: Bearer CRON_SECRET`,
 * igual que el diario (`runCronRoute`: 401 sin el secreto, 503 sin `CRON_SECRET` en Production, 200 «maintenance» en
 * mantenimiento). Cada etapa es idempotente: un reintento de Vercel o un disparo a mano no duplica recordatorios.
 */
export function GET(req: Request): Promise<Response> {
  return runCronRoute(req, JOB, (now) => runWhatsAppCron(now, undefined, { prepareDocument: prepareWhatsAppDocument }));
}
