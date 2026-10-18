import { exportFichaDocument, hcExportResponse, hcPlain } from "@/lib/hc-export-internal";
import { HC_EXPORT_COPY, HC_EXPORT_RATE_LIMIT, isRouteId, parseFichaFormat } from "@/lib/hc-export-logic";
import { rateLimit } from "@/lib/rate-limit";
import { tryGetActor } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Sin `maxDuration` acá: el límite vive en vercel.json (la ficha suelta entra en el default de 30 s de `app/**/*`).

/**
 * FC-2g (C-FC7) · `GET /api/pacientes/[id]/fichas/[noteId]/[pdf|docx]` — una ficha (raíz + enmiendas) del paciente.
 *
 * Sin sesión (o con la 2FA pendiente: `tryGetActor` da null) → 401. Soporte → 403: soporte nunca baja datos del
 * consultorio (BO2-E), y una ficha es PHI en un archivo que sale de la plataforma. Rate limit por usuario ANTES de la
 * base. Formato o id inválidos, sin `canRead`, ajeno, enmienda u otra ficha en la URL → 404 sin distinguir.
 * El audit va antes del primer byte (`lib/hc-export-internal.ts`); si falla → 503 sin cuerpo.
 */
export async function GET(_req: Request, { params }: { params: { id: string; noteId: string; format: string } }): Promise<Response> {
  const actor = await tryGetActor();
  if (!actor) return hcPlain(401, "Unauthorized");
  if (actor.support) return hcPlain(403, "Forbidden");

  const format = parseFichaFormat(params.format);
  if (!format || !isRouteId(params.id) || !isRouteId(params.noteId)) return hcPlain(404, "Not found");

  const rl = await rateLimit(`hc-export:ficha:${actor.userId}`, HC_EXPORT_RATE_LIMIT.ficha);
  if (!rl.ok) return hcPlain(429, HC_EXPORT_COPY.rateLimited, { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) });

  const result = await exportFichaDocument(actor, { patientId: params.id, noteId: params.noteId, format });
  return hcExportResponse(result, HC_EXPORT_COPY.fichaTooLarge);
}
