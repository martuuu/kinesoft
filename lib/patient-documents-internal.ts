import "server-only";

/**
 * FC-2d (T4, C-FC6, brief §24.5) · Núcleo server-only de «compartir con el paciente»: la clave del PDF, la huella de la
 * versión, el lock de la nota, la proyección del documento y el parseo de los errores de la base. Lo usan
 * `lib/patient-documents.ts` (las actions) y `lib/patient-documents-delivery-internal.ts` (el aviso y la costura de
 * WhatsApp de T6). El portal NO importa este módulo: lee `lib/portal-documents-internal.ts`, que no puede nombrar el
 * modelo de notas (guard de §24.2 hallazgo 2).
 */
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { hcSourceVersion, verificationCodeFromSha256 } from "@/lib/hc-print-model";
import { CLINICAL_NOTE_KIND_LABEL } from "@/lib/clinical-notes-types";
import { sha256Hex, type HcPrintEntryRow } from "@/lib/hc-print-internal";
import type { SharedDocumentDTO } from "@/lib/patient-documents-types";
import type { DbClient } from "@/lib/rls";
import type { StorageBucket } from "@/lib/storage-internal";

export const PATIENT_DOCUMENTS_BUCKET: StorageBucket = "patient-documents";

/**
 * Clave del PDF en el bucket privado `patient-documents`. DERIVADA, nunca leída de la fila (decisión del orquestador en
 * T4, handoff «De FC-1e»): el portal re-deriva la misma clave desde `tenantId`/`patientId` de su sesión y el id del
 * documento, así un `pdfStorageKey` adulterado en la base no puede apuntar el proxy del portal al PDF de otro paciente.
 * Los ids salen de la base (cuid / hex): igual se rechaza cualquier cosa con `/` o `..`, porque una clave con barra
 * escribiría en la carpeta de otro paciente.
 */
export function patientDocumentPdfKey(tenantId: string, patientId: string, documentId: string): string {
  for (const part of [tenantId, patientId, documentId]) {
    if (!part || !/^[A-Za-z0-9_-]+$/.test(part)) throw new Error("patientDocumentPdfKey: id inválido.");
  }
  return `${tenantId}/${patientId}/${documentId}.pdf`;
}

/** sha256 en hex de los bytes del PDF (`pdfSha256`; el portal lo verifica antes de entregar). */
export function sha256OfBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** `pdfStorageKey` sin Storage configurado (dev y tests sin bucket): mismo convenio que `PatientFile` (comentario de M14). */
export function stubPdfKey(documentId: string): string {
  return `stub:${documentId}`;
}

/**
 * Huella de la versión compartida: `sha256(hcSourceVersion(raíz, TODAS sus enmiendas))`, anuladas incluidas (el flag
 * `voided` entra en la huella). Es lo que `PatientDocument.sourceDigest` guarda y lo que FC-2b compara para mostrar
 * «Compartida · desactualizada» (`tests/integration/fichas-reads.test.ts` siembra exactamente esto). Si FC-2d y FC-2b
 * calcularan la huella con fuentes distintas, recién compartida ya se vería desactualizada.
 */
export function sourceDigestOf(
  root: { revision: number },
  amendments: { id: string; revision: number; voidedAt: Date | null }[],
): string {
  return sha256Hex(hcSourceVersion(root, amendments.map((a) => ({ id: a.id, revision: a.revision, voided: a.voidedAt !== null }))));
}

/** Lo que compartir necesita de la raíz para decidir (y lo que se relee en la tx2 para ver si cambió). */
export type ShareRootState = {
  id: string;
  patientId: string;
  amendsNoteId: string | null;
  revision: number;
  voidedAt: Date | null;
  digest: string;
};

/**
 * Raíz + enmiendas → estado y huella. 2 sentencias, ambas con `tenantId` a mano (prod es BYPASSRLS). null = la ficha no
 * existe en este consultorio. Es la MISMA huella en la tx1 (armado) y en la tx2 (escritura): «cambió» = las dos
 * huellas difieren.
 */
export async function readShareRootStateInTx(tx: DbClient, tenantId: string, noteId: string): Promise<ShareRootState | null> {
  const root = await tx.clinicalNote.findFirst({
    where: { id: noteId, tenantId },
    select: { id: true, patientId: true, amendsNoteId: true, revision: true, voidedAt: true },
  });
  if (!root) return null;
  // Una enmienda nunca tiene enmiendas (las enmiendas apuntan a la raíz): con una enmienda se corta antes de leer.
  const amendments =
    root.amendsNoteId === null
      ? await tx.clinicalNote.findMany({
          where: { tenantId, amendsNoteId: root.id },
          select: { id: true, revision: true, voidedAt: true },
        })
      : [];
  return { ...root, digest: sourceDigestOf(root, amendments) };
}

const ENTRY_SELECT = {
  id: true,
  amendsNoteId: true,
  revision: true,
  kind: true,
  title: true,
  occurredAt: true,
  createdAt: true,
  body: true,
  bodyDoc: true,
  diagnoses: true,
  authorName: true,
  authorPractitionerId: true,
  authorLicense: true,
  importSource: true,
  voidedAt: true,
  voidReason: true,
  booking: { select: { locationId: true } },
} as const satisfies Prisma.ClinicalNoteSelect;

/**
 * Filas de la raíz y TODAS sus enmiendas para `loadHcPrintSourceInTx` (FC-2e: el loader neutral recibe las filas; quien
 * puede nombrar el modelo las lee). Anuladas incluidas: `buildHcPrintableContent("shared")` las saca del contenido y
 * la huella las cuenta. `label` sale resuelto (el enum del tipo nunca viaja al contenido, §24.2 hallazgo 2).
 * `locationId` = la sede del turno de la raíz, para el membrete. 1 sentencia (la raíz ya se validó en
 * `readShareRootStateInTx`).
 */
export async function readShareEntryRowsInTx(
  tx: DbClient,
  tenantId: string,
  noteId: string,
): Promise<{ rows: HcPrintEntryRow[]; locationId: string | null }> {
  const notes = await tx.clinicalNote.findMany({
    where: { tenantId, OR: [{ id: noteId }, { amendsNoteId: noteId }] },
    select: ENTRY_SELECT,
  });
  const rows = notes.map(
    (n): HcPrintEntryRow => ({
      id: n.id,
      parentId: n.amendsNoteId,
      revision: n.revision,
      label: CLINICAL_NOTE_KIND_LABEL[n.kind],
      title: n.title,
      occurredAt: n.occurredAt,
      createdAt: n.createdAt,
      body: n.body,
      bodyDoc: n.bodyDoc,
      diagnoses: n.diagnoses,
      authorName: n.authorName,
      authorPractitionerId: n.authorPractitionerId,
      authorLicense: n.authorLicense,
      importSource: n.importSource,
      voidedAt: n.voidedAt,
      voidReason: n.voidReason,
    }),
  );
  const root = notes.find((n) => n.id === noteId);
  return { rows, locationId: root?.booking?.locationId ?? null };
}

/**
 * Brief §24.2 hallazgo 8: la tx de compartir toma PRIMERO la nota (`FOR SHARE`) y recién después toca documentos.
 * Anular hace nota → documentos (el UPDATE de la nota y, en su trigger, la revocación). Si compartir revocara el
 * documento vivo antes de tocar la nota, el `FOR SHARE` del trigger de INSERT esperaría a la anulación mientras la
 * anulación espera el documento que compartir ya tiene: deadlock (40P01). Mismo orden en los dos caminos = sin ciclo.
 * `false` = la ficha no está en este consultorio (con RLS, tampoco la ve).
 */
export async function lockNoteForShareInTx(tx: DbClient, tenantId: string, noteId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ one: number }[]>`
    SELECT 1 AS one FROM "ClinicalNote" WHERE id = ${noteId} AND "tenantId" = ${tenantId} FOR SHARE`;
  return rows.length > 0;
}

export const SHARED_DOCUMENT_SELECT = {
  id: true,
  patientId: true,
  noteId: true,
  noteRevision: true,
  title: true,
  sharedAt: true,
  snapshotSha256: true,
  sharedByUserId: true,
  revokedAt: true,
} as const satisfies Prisma.PatientDocumentSelect;

export type SharedDocumentRow = Prisma.PatientDocumentGetPayload<{ select: typeof SHARED_DOCUMENT_SELECT }>;

/**
 * Fila → DTO del equipo. El código de verificación sale del `snapshotSha256` (es el mismo que el PDF imprime:
 * `finalizeHcPrintable` lo deriva del sha256 de `canonicalJson(content)`), así un replay lo devuelve sin releer el
 * snapshot de 2 MB.
 */
export function toSharedDocumentDTO(row: SharedDocumentRow): SharedDocumentDTO {
  return {
    id: row.id,
    noteId: row.noteId,
    noteRevision: row.noteRevision,
    title: row.title,
    sharedAt: row.sharedAt.toISOString(),
    verificationCode: verificationCodeFromSha256(row.snapshotSha256),
  };
}

/** CHECK `PatientDocument_title_check`: 1..200 sin blancos. Sin título → la etiqueta del tipo («Evolución», «Ficha»). */
export function patientDocumentTitle(root: { title: string | null; label: string }): string {
  const t = (root.title ?? "").replace(/\s+/g, " ").trim() || root.label.trim() || "Ficha";
  return Array.from(t).slice(0, 200).join("").trim();
}

/**
 * Replay por clave de idempotencia (UUID por instancia del diálogo «Compartir»). Es el mismo envío solo si es la misma
 * ficha y la misma persona; si no, la clave se reusó → `keyReused`. null = la clave está libre.
 */
export function replayDecision(
  prev: Pick<SharedDocumentRow, "noteId" | "sharedByUserId"> | null,
  expected: { noteId: string; userId: string },
): "free" | "replay" | "key-reused" {
  if (!prev) return "free";
  return prev.noteId === expected.noteId && prev.sharedByUserId === expected.userId ? "replay" : "key-reused";
}

export function isUniqueViolation(e: unknown): boolean {
  return (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") || pgErrorCode(e) === "23505";
}

/**
 * RAISE del trigger `patient_document_guard` (P0001 «no es una raíz vigente»). Llega P0001 y no 42501 también con la
 * ficha de OTRO consultorio: el BEFORE INSERT corre antes del WITH CHECK de RLS y su `FOR SHARE` pasa por RLS, así que
 * no la encuentra (handoff «De FC-0»).
 */
export function isTriggerRejection(e: unknown): boolean {
  return pgErrorCode(e) === "P0001";
}

/**
 * SQLSTATE de un error de Postgres que atraviesa Prisma. Un RAISE de trigger en una query de modelo no tiene código
 * Prisma propio: llega como Unknown (o Known con `meta.code`) y el SQLSTATE solo aparece en el mensaje; mismo parseo que
 * `lib/clinical-notes.ts` (no se importa de ahí: es un archivo `"use server"` y no exporta helpers síncronos).
 */
export function pgErrorCode(e: unknown): string | null {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = (e.meta as { code?: unknown } | undefined)?.code;
    if (typeof meta === "string") return meta;
  }
  if (e instanceof Prisma.PrismaClientKnownRequestError || e instanceof Prisma.PrismaClientUnknownRequestError) {
    const m = /SQLSTATE[: ]+([0-9A-Z]{5})|code: "([0-9A-Z]{5})"/.exec(e.message);
    return m?.[1] ?? m?.[2] ?? null;
  }
  return null;
}
