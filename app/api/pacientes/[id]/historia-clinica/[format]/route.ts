import { exportClinicalRecordPdf, hcExportResponse, hcPlain } from "@/lib/hc-export-internal";
import { HC_EXPORT_COPY, HC_EXPORT_RATE_LIMIT, isRouteId, parseRecordFormat } from "@/lib/hc-export-logic";
import { rateLimit } from "@/lib/rate-limit";
import { tryGetActor } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Sin `maxDuration` acá a propósito: el límite vive en UN solo lugar, vercel.json, con una clave propia para esta ruta
// (60 s, FC-D31) ANTES de `app/**/*` (30 s): el orden de las claves importa cuando un archivo matchea dos globs. 300
// fichas tardan 6-7 s en local (FC-1c); el margen es para el arranque en frío de react-pdf y la red de Storage.

/**
 * FC-2g (C-FC7, FC-D31) · `GET /api/pacientes/[id]/historia-clinica/pdf` — la HC completa, SOLO en PDF, con las 300
 * fichas más recientes. Mismo esquema que la ficha suelta: 401 / soporte 403 / rate limit (más corto: es el render
 * caro) / `canRead` o 404 / audit `clinicalRecord.download` antes del primer byte o 503 sin cuerpo. Si el PDF pasa de
 * 4 MB → 413 con «Usá Imprimir historia clínica» (la página imprimible no tiene ese tope).
 */
export async function GET(_req: Request, { params }: { params: { id: string; format: string } }): Promise<Response> {
  const actor = await tryGetActor();
  if (!actor) return hcPlain(401, "Unauthorized");
  if (actor.support) return hcPlain(403, "Forbidden");

  if (!parseRecordFormat(params.format) || !isRouteId(params.id)) return hcPlain(404, "Not found");

  const rl = await rateLimit(`hc-export:record:${actor.userId}`, HC_EXPORT_RATE_LIMIT.record);
  if (!rl.ok) return hcPlain(429, HC_EXPORT_COPY.rateLimited, { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) });

  const result = await exportClinicalRecordPdf(actor, params.id);
  return hcExportResponse(result, HC_EXPORT_COPY.recordTooLarge);
}
