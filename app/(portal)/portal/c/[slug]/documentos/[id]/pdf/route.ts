import { clientIp } from "@/lib/client-ip";
import { logger } from "@/lib/logger";
import { requirePortalPatient } from "@/lib/portal-identity-internal";
import {
  loadPortalDocumentPdf,
  PortalDocumentAuditError,
  PortalDocumentIntegrityError,
} from "@/lib/portal-documents-internal";
import { hashKeyPart, rateLimit } from "@/lib/rate-limit";

/**
 * T4 (C-FC8, FC-D28) · `GET /portal/c/{slug}/documentos/{id}/pdf`: el PDF de un documento compartido, PROXEADO por el
 * server. No hay URL firmada al paciente: una URL firmada se reenvía, queda en el historial y no deja rastro de quién
 * bajó qué. Acá cada descarga pasa por la sesión del portal y deja `patientDocument.download` con ip/ua.
 *
 * Respuestas (sin cuerpo útil salvo el 200, así nadie aprende por qué falló):
 *   - 404: sin sesión, staff, slug inexistente, ficha sin vincular, documento ajeno, revocado o de otro consultorio.
 *     No se distingue «no existe» de «no es tuyo» y no se audita (un 404 no es una descarga).
 *   - 429: más de 30 pedidos en 10 min desde la misma IP (el render del snapshot cuesta CPU).
 *   - 500: sha256 del objeto distinto del guardado, snapshot ilegible o error inesperado.
 *   - 503: el audit no se pudo escribir. Sin rastro no hay bytes.
 *
 * El portal no tiene contexto de request (`lib/request-context.ts`), así que ip/ua salen de ESTE Request y van
 * explícitos al audit. El user-agent se recorta a 300: es texto del cliente.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE = { limit: 30, windowMs: 10 * 60_000 };
const UA_MAX = 300;

function empty(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { "cache-control": "no-store", ...headers } });
}

/**
 * `filename` ASCII (sin tildes ni comillas) para clientes viejos + `filename*` UTF-8 (RFC 6266) con el nombre real.
 * El nombre lleva apellido, fecha y título: va solo en el header de ESTA respuesta, que ya es del paciente.
 */
function attachment(filename: string): string {
  const ascii =
    filename
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\x20-\x7e]/g, "_")
      .replace(/["\\]/g, "_") || "documento.pdf";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function GET(req: Request, { params }: { params: { slug: string; id: string } }): Promise<Response> {
  const ip = clientIp(req.headers, null);
  const rl = await rateLimit(`portal-document-pdf:ip:${hashKeyPart(ip ?? "unknown")}`, RATE);
  if (!rl.ok) return empty(429, { "retry-after": String(Math.ceil(rl.retryAfterMs / 1000)) });

  const ref = await requirePortalPatient(params.slug);
  if (!ref) return empty(404);

  const userAgent = req.headers.get("user-agent")?.slice(0, UA_MAX) || null;
  let file: Awaited<ReturnType<typeof loadPortalDocumentPdf>>;
  try {
    file = await loadPortalDocumentPdf(ref, params.id, { ip, userAgent });
  } catch (e) {
    if (e instanceof PortalDocumentAuditError) {
      logger.error("patientDocument.download_audit_failed", { tenantId: ref.tenantId });
      return empty(503, { "retry-after": "30" });
    }
    if (!(e instanceof PortalDocumentIntegrityError)) {
      logger.error("patientDocument.download_failed", { tenantId: ref.tenantId, error: e instanceof Error ? e.name : "unknown" });
    }
    return empty(500);
  }
  if (!file) return empty(404);

  // `new Uint8Array(…)` copia a un `Uint8Array<ArrayBuffer>`: con el lib de TS 5.7+ el de react-pdf/Storage no es
  // `BodyInit` y `next build` falla en el typecheck (lo midió el spike de FC-1c).
  return new Response(new Uint8Array(file.bytes), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-length": String(file.bytes.byteLength),
      "content-disposition": attachment(file.filename),
      "cache-control": "no-store, private",
      "x-content-type-options": "nosniff",
    },
  });
}
