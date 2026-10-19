import "server-only";
/**
 * Portal «Documentos» (T4, C-FC8; brief §24.5). Lo que el profesional COMPARTIÓ con el paciente: la foto HcPrintable
 * v1 de `PatientDocument`, ya resuelta en texto. Nunca la historia clínica: el portal deshace EV2-D5 solo para esto.
 *
 * Por qué este archivo es así:
 *   - Canal `prismaService` (BYPASSRLS, sin Actor ni GUC), igual que el resto del portal: la ÚNICA barrera es el par
 *     `tenantId` + `patientId` del ref que resolvió `requirePortalPatient` (vínculo `Patient.userId`, ES4). Cada query
 *     lleva los dos a mano; un id de documento de otra ficha o de otro consultorio da null, no un error distinguible.
 *   - `select` explícito con solo lo que se muestra. Las columnas que identifican el origen, la clave del objeto en
 *     Storage, la clave de idempotencia y quién compartió NO se leen (guard `tests/unit/portal-documents-guard.test.ts`
 *     barre este archivo entero, comentarios incluidos): si no se leen, no pueden viajar en un payload del RSC.
 *   - Solo los vivos (`revokedAt: null`): revocar (a mano, al reemplazar o al anular) es la forma de sacarle algo al
 *     paciente, y tiene que valer en la lista, la vista y el PDF por igual.
 *   - La clave del PDF se DERIVA `{tenantId}/{patientId}/{documentId}.pdf` (decisión del orquestador, handoff «De
 *     FC-1e»; la misma con la que sube la action de compartir) y los bytes se verifican contra `pdfSha256`: un objeto
 *     cambiado en el bucket no le llega nunca al paciente (→ 500).
 *   - Sin Storage (dev, integración) o con el objeto ausente (documento compartido sin Storage, el `stub:` de dev) el
 *     PDF se re-renderiza desde el snapshot con `renderHcPdf`. El snapshot es la fuente de verdad del documento (el PDF
 *     guardado es su render); lo que se pierde es el logo y la firma escaneada, porque las imágenes viven en otro
 *     bucket y cargarlas exigiría un módulo fuera de la allow-list del portal.
 *   - FC-D28: la descarga se audita (`patientDocument.download`, con ip/ua explícitos porque el portal no tiene
 *     contexto de request) DESPUÉS de verificar los bytes y ANTES de devolverlos. Si el audit falla, tira
 *     `PortalDocumentAuditError` y la ruta responde 503 sin bytes. La vista en pantalla no se audita.
 */
import { createHash } from "node:crypto";
import { prismaService as prisma } from "@/lib/db";
import { auditSecurityEvent } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { validateHcDoc } from "@/lib/hc-doc";
import { hcFileBase } from "@/lib/hc-print-model";
import type { HcPrintableContentV1, HcPrintableV1 } from "@/lib/hc-print-types";
import { portalSectionsFor } from "@/lib/portal-nav";
import type { PortalPatientRef } from "@/lib/portal-identity-internal";
import { isStorageConfigured, storageDownload } from "@/lib/storage-internal";

export type PortalDocumentListItem = { id: string; title: string; occurredAt: string; sharedAt: string };
export type PortalDocumentView = {
  id: string;
  title: string;
  sharedAt: string;
  content: HcPrintableContentV1;
  verificationCode: string;
};

/** El audit de la descarga no se pudo escribir: sin rastro no hay bytes (la ruta responde 503). */
export class PortalDocumentAuditError extends Error {
  constructor(cause: unknown) {
    super("patientDocument.download: audit no escrito");
    this.name = "PortalDocumentAuditError";
    this.cause = cause;
  }
}

/** Los bytes no se pueden entregar con garantía (sha256 distinto, snapshot ilegible, PDF fuera de tope): 500. */
export class PortalDocumentIntegrityError extends Error {
  constructor(reason: "sha-mismatch" | "snapshot" | "too-large") {
    super(`patientDocument.pdf: ${reason}`);
    this.name = "PortalDocumentIntegrityError";
  }
}

/** C-FC8: «vivos, ≤200». Un paciente con más de 200 documentos compartidos vivos no es un caso real hoy. */
const LIST_MAX = 200;
const PATIENT_DOCUMENTS_BUCKET = "patient-documents" as const;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** `documentos` es CORE (sale en las 16 combinaciones), pero la fuente única del gate es `portalSectionsFor`. */
const allowed = (ref: PortalPatientRef) => portalSectionsFor(ref.modules).has("documentos");

/** Filtro común: del consultorio y de la ficha del ref, y vivo. El id del documento se suma por llamada. */
const ownLive = (ref: PortalPatientRef) => ({ tenantId: ref.tenantId, patientId: ref.patientId, revokedAt: null });

export async function listPortalDocuments(ref: PortalPatientRef): Promise<PortalDocumentListItem[]> {
  if (!allowed(ref)) return [];
  const rows = await prisma.patientDocument.findMany({
    where: ownLive(ref),
    select: { id: true, title: true, occurredAt: true, sharedAt: true },
    // Índice (tenantId, patientId, sharedAt desc). El id desempata dos compartidos en el mismo milisegundo.
    orderBy: [{ sharedAt: "desc" }, { id: "desc" }],
    take: LIST_MAX,
  });
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    occurredAt: r.occurredAt.toISOString(),
    sharedAt: r.sharedAt.toISOString(),
  }));
}

/**
 * Lee el snapshot con una validación de FORMA: lo escribió el server, pero es un `Json` y la vista y el render lo
 * recorren sin más chequeos. Un snapshot que no es v1 o con un cuerpo que no es un HcDoc válido no se muestra.
 */
function parseSnapshot(raw: unknown, version: number): HcPrintableV1 | null {
  if (version !== 1 || !raw || typeof raw !== "object") return null;
  const s = raw as Partial<HcPrintableV1>;
  const c = s.content as Partial<HcPrintableContentV1> | undefined;
  if (s.v !== 1 || !c || typeof c !== "object" || !s.meta || typeof s.meta !== "object") return null;
  if (typeof s.meta.verificationCode !== "string" || typeof s.meta.generatedAt !== "string") return null;
  if (!c.letterhead || !c.patient || !Array.isArray(c.fichas)) return null;
  for (const f of c.fichas) {
    if (!f || !Array.isArray(f.amendments)) return null;
    for (const e of [f.main, ...f.amendments]) {
      if (!e || typeof e.label !== "string" || !Array.isArray(e.diagnoses) || !e.signature || !e.marks) return null;
      if (!validateHcDoc(e.body).ok) return null;
    }
  }
  return s as HcPrintableV1;
}

const VIEW_SELECT = {
  id: true,
  title: true,
  occurredAt: true,
  sharedAt: true,
  snapshot: true,
  snapshotVersion: true,
} as const;

export async function getPortalDocument(ref: PortalPatientRef, id: string): Promise<PortalDocumentView | null> {
  if (!allowed(ref) || !ID_RE.test(id)) return null;
  const row = await prisma.patientDocument.findFirst({ where: { ...ownLive(ref), id }, select: VIEW_SELECT });
  if (!row) return null;
  const snap = parseSnapshot(row.snapshot, row.snapshotVersion);
  if (!snap) {
    logger.error("patientDocument.snapshot_invalid", { tenantId: ref.tenantId, documentId: row.id });
    return null;
  }
  return {
    id: row.id,
    title: row.title,
    sharedAt: row.sharedAt.toISOString(),
    content: snap.content,
    verificationCode: snap.meta.verificationCode,
  };
}

const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * Bytes del PDF compartido (C-FC8). null = no existe para este paciente (ajeno, revocado, otro consultorio): la ruta
 * lo trata como 404 y no deja rastro. Tira `PortalDocumentIntegrityError` (500) o `PortalDocumentAuditError` (503).
 */
export async function loadPortalDocumentPdf(
  ref: PortalPatientRef,
  id: string,
  ctx: { ip: string | null; userAgent: string | null },
): Promise<{ bytes: Uint8Array; filename: string } | null> {
  if (!allowed(ref) || !ID_RE.test(id)) return null;
  const row = await prisma.patientDocument.findFirst({
    where: { ...ownLive(ref), id },
    select: { ...VIEW_SELECT, pdfSha256: true },
  });
  if (!row) return null;

  // `import()` y no estático: las PÁGINAS de «Documentos» importan este módulo para la lista y la vista, y un import
  // estático del render les arrastraba react-pdf al grafo (`hc-heavy-deps` #8). Solo la ruta del PDF llega acá.
  const { HC_PDF_MAX_BYTES, renderHcPdf } = await import("@/lib/hc-pdf/render-internal");

  let bytes: Uint8Array | null = null;
  if (isStorageConfigured()) {
    const key = `${ref.tenantId}/${ref.patientId}/${row.id}.pdf`;
    const r = await storageDownload(PATIENT_DOCUMENTS_BUCKET, key, HC_PDF_MAX_BYTES);
    if (r.ok) {
      if (sha256Hex(r.data) !== row.pdfSha256) {
        // Nunca se loguea la clave ni el contenido: ids alcanzan para ir a mirar el bucket.
        logger.error("patientDocument.pdf_sha_mismatch", { tenantId: ref.tenantId, documentId: row.id });
        throw new PortalDocumentIntegrityError("sha-mismatch");
      }
      bytes = r.data;
    } else {
      // Objeto ausente (compartido sin Storage) o Storage caído: el snapshot alcanza para entregar el documento.
      logger.warn("patientDocument.pdf_fallback_render", { tenantId: ref.tenantId, documentId: row.id, reason: r.reason });
    }
  }
  if (!bytes) {
    const snap = parseSnapshot(row.snapshot, row.snapshotVersion);
    if (!snap) {
      logger.error("patientDocument.snapshot_invalid", { tenantId: ref.tenantId, documentId: row.id });
      throw new PortalDocumentIntegrityError("snapshot");
    }
    bytes = await renderHcPdf(snap, { logo: null, signatures: {} });
    // El cuerpo de una función de Vercel corta en 4,5 MB: mejor un 500 claro que una respuesta truncada.
    if (bytes.byteLength > HC_PDF_MAX_BYTES) throw new PortalDocumentIntegrityError("too-large");
  }

  try {
    await auditSecurityEvent({
      action: "patientDocument.download",
      tenantId: ref.tenantId,
      actorId: ref.userId,
      // T4 (FC-2i): con `entity: "Patient"` la descarga aparece en la Actividad del paciente (que lee por paciente),
      // igual que las descargas del equipo (FC-2g); el documento va en el payload.
      entity: "Patient",
      entityId: ref.patientId,
      payload: { documentId: row.id },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  } catch (e) {
    throw new PortalDocumentAuditError(e);
  }

  const filename = hcFileBase({
    lastName: ref.patient.lastName,
    firstName: ref.patient.firstName,
    occurredAt: row.occurredAt,
    title: row.title,
    shortId: row.id.slice(-6),
  });
  return { bytes, filename: `${filename}.pdf` };
}
