"use server";

/**
 * FC-2d (T4, C-FC6, brief §24.5) · Compartir una ficha con el paciente y dejar de compartirla.
 *
 * `shareClinicalNoteWithPatient`, en orden (literal de §24.5):
 *   1. gate `canWrite` (FC-D8: comparte cualquier profesional con escritura clínica sobre el paciente), raíz viva y
 *      replay por clave, todo en la tx1, que además arma la fuente DESDE LA BASE (el cliente solo manda el id);
 *   2. FUERA de toda tx: `buildHcPrintableContent("shared")` → `renderHcPdf` (≤ 4 MB) → `storageUpload` con la clave
 *      derivada `{tenantId}/{patientId}/{documentId}.pdf` (la que el portal re-deriva). Render y subida tardan
 *      segundos: con una tx abierta retendrían una conexión del pool y el lock de la nota todo ese tiempo;
 *   3. tx2: `SELECT … FROM "ClinicalNote" … FOR SHARE` PRIMERO (§24.2 hallazgo 8: mismo orden nota → documentos que
 *      anular, sin deadlock) → re-gate → relee la versión (cambió → `changed`) → revoca el vivo (`REPLACED`) → crea el
 *      documento → `auditInTx("patientDocument.share")`;
 *   4. después del commit: `revalidatePath` y `deliverPatientDocument` (≤ 5 s, nunca tira).
 *   Toda salida por error después de subir BORRA el objeto: un PDF de HC sin fila que lo referencie es PHI huérfana en
 *   el bucket, sin forma de encontrarla. 23505 (doble envío concurrente o alguien compartió recién) y P0001 (la ficha
 *   se anuló en el medio) se deciden releyendo en una tx nueva: replay / `raced` / `voided`.
 *
 * Los PDF reemplazados NO se borran: son copia de lo que el paciente recibió (HC, Ley 26.529). Anular la ficha revoca
 * por trigger (M14), no acá.
 *
 * T4-Z (revisor a):
 *   - M-2: rate limit por usuario ANTES de la tx1 (30 envíos / 10 min: cada envío es un render de segundos y un PDF de
 *     HC nuevo en el bucket; sin tope, un script con una sesión robada llenaba Storage y la cola de render) y tope de
 *     AVISO por paciente (3 / h): pasado el tope se comparte igual pero sin mail (`skipped`), así nadie usa «compartir»
 *     para bombardear el buzón de un paciente con mails que salen con el nombre del consultorio.
 *   - M-3: `getPatientPortalShareInfo` le da al diálogo el email ENMASCARADO de la cuenta vinculada antes de confirmar.
 *   - B-6: un replay cuyo documento ya no está vivo (la ficha se anuló, se reemplazó o se dejó de compartir) no se
 *     devuelve como vigente: antes el doble click después de anular decía «Listo: el paciente ya lo ve».
 *
 * Archivo `"use server"`: exporta solo las actions. La lógica chica va en `lib/patient-documents-internal.ts`.
 */
import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { assertModule } from "@/lib/authz";
import { auditInTx } from "@/lib/audit";
import { clinicalNoteGateInTx } from "@/lib/clinical-notes-internal";
import { loadHcAssets, type HcRenderAssets } from "@/lib/hc-assets-internal";
import { HC_PDF_MAX_BYTES, renderHcPdf } from "@/lib/hc-pdf/render-internal";
import { finalizeHcPrintable, loadHcPrintSourceInTx } from "@/lib/hc-print-internal";
import { buildHcPrintableContent, type HcPrintSource } from "@/lib/hc-print-model";
import type { HcPrintableV1 } from "@/lib/hc-print-types";
import { deliverPatientDocument } from "@/lib/patient-documents-delivery-internal";
import {
  PATIENT_DOCUMENTS_BUCKET,
  SHARED_DOCUMENT_SELECT,
  isTriggerRejection,
  isUniqueViolation,
  lockNoteForShareInTx,
  patientDocumentPdfKey,
  patientDocumentTitle,
  pgErrorCode,
  readShareEntryRowsInTx,
  readShareRootStateInTx,
  replayDecision,
  sha256OfBytes,
  stubPdfKey,
  toSharedDocumentDTO,
  type ShareRootState,
} from "@/lib/patient-documents-internal";
import {
  PATIENT_DOCUMENT_COPY as COPY,
  type DocumentDeliveryOutcome,
  type PatientPortalShareInfo,
  type SharedDocumentDTO,
} from "@/lib/patient-documents-types";
import { withReadOnlyResult } from "@/lib/read-only-result";
import { runWithRls, type DbClient } from "@/lib/rls";
import { ForbiddenError, getActor, requireActorPractitionerId, writableError, type Actor } from "@/lib/session";
import { isStorageConfigured, storageRemove, storageUpload } from "@/lib/storage-internal";
import type { ActionResult } from "@/lib/validation";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/rate-limit";
import { maskEmail } from "@/lib/email/transport";

type Fail = { ok: false; error: string };
type ShareData = {
  document: SharedDocumentDTO;
  replayed: boolean;
  replacedDocumentId: string | null;
  patientPortal: "linked" | "not-linked";
  delivery: DocumentDeliveryOutcome | null;
};

// ─── Actions ─────────────────────────────────────────────────────────────────

export async function shareClinicalNoteWithPatient(input: {
  noteId: string;
  idempotencyKey: string;
  notify: boolean;
}): Promise<ActionResult<ShareData>> {
  return withReadOnlyResult(() => shareImpl(input));
}

export async function revokePatientDocument(input: {
  documentId: string;
}): Promise<ActionResult<{ documentId: string; revokedAt: string }>> {
  return withReadOnlyResult(() => revokeImpl(input));
}

/**
 * T4Z-M3 · ¿A qué cuenta del portal le llega el aviso? Lectura liviana para el diálogo de compartir, ANTES de confirmar.
 * Mismo gate que compartir (escritura clínica sobre el paciente: soporte, Secretaria y Facturación → forbidden). El
 * email sale de la cuenta VINCULADA (`Patient.userId` → `UserProfile.email`, el mismo destinatario que usa
 * `deliverPatientDocument`) y viaja enmascarado: el email completo nunca llega al cliente.
 */
export async function getPatientPortalShareInfo(input: {
  patientId: string;
}): Promise<{ ok: true; data: PatientPortalShareInfo } | { ok: false; error: string }> {
  try {
    const actor = await getActor();
    assertModule(actor, "evoluciones");
    if (typeof input?.patientId !== "string" || !ID_RE.test(input.patientId)) return fail(COPY.patientNotFound);
    const tenantId = actor.tenantId;
    const patientId = input.patientId;
    return await runWithRls(tenantId, async (tx) => {
      const patient = await tx.patient.findFirst({
        where: { id: patientId, tenantId },
        select: { userId: true, user: { select: { email: true } } },
      });
      if (!patient) return fail(COPY.patientNotFound);
      const gate = await clinicalNoteGateInTx(tx, actor, patientId);
      if (!gate.canWrite) return fail(COPY.forbidden);
      if (!patient.userId || !patient.user?.email) return { ok: true as const, data: { portal: "not-linked" as const, maskedEmail: null } };
      return { ok: true as const, data: { portal: "linked" as const, maskedEmail: maskEmail(patient.user.email) } };
    });
  } catch (e) {
    return forbiddenResult(e);
  }
}

// ─── Compartir ───────────────────────────────────────────────────────────────

/** T4Z-M2: envíos por usuario (cualquier ficha, cualquier paciente). Ver la cabecera. */
const SHARE_RATE_LIMIT = { limit: 30, windowMs: 10 * 60_000 } as const;
/** T4Z-M2: avisos por mail por paciente. Pasado el tope se comparte igual, sin mail. */
const NOTIFY_RATE_LIMIT = { limit: 3, windowMs: 60 * 60_000 } as const;

/** Mismo formato que la clave de `PatientDocument_idempotencyKey_check` (8..100); el cliente manda un UUID. */
const KEY_RE = /^[A-Za-z0-9_-]{8,100}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Lo que la tx1 deja para el armado fuera de tx. */
type Prepared = {
  kind: "prepared";
  root: ShareRootState;
  source: HcPrintSource;
  patientPortal: "linked" | "not-linked";
};

async function shareImpl(input: { noteId: string; idempotencyKey: string; notify: boolean }): Promise<ActionResult<ShareData>> {
  try {
    const actor = await getActor();
    assertModule(actor, "evoluciones");
    if (
      typeof input?.noteId !== "string" ||
      !ID_RE.test(input.noteId) ||
      typeof input.idempotencyKey !== "string" ||
      !KEY_RE.test(input.idempotencyKey)
    ) {
      return fail(COPY.notFound);
    }
    const noteId = input.noteId;
    const key = input.idempotencyKey;
    const notify = input.notify === true;
    const tenantId = actor.tenantId;

    // T4Z-M2: antes de la tx1, el render y Storage. Va por usuario (no por consultorio): un consultorio grande con
    // varios profesionales compartiendo a la vez no se frena entre sí.
    const rl = await rateLimit(`patient-document:share:user:${actor.userId}`, SHARE_RATE_LIMIT);
    if (!rl.ok) return fail(COPY.rateLimited);

    // ── 1. tx1: gate, raíz viva, replay y fuente desde la base ──
    const step1 = await runWithRls(tenantId, async (tx): Promise<Fail | { kind: "replay"; data: ShareData } | Prepared> => {
      const root = await readShareRootStateInTx(tx, tenantId, noteId);
      if (!root) return fail(COPY.notFound);
      const gate = await clinicalNoteGateInTx(tx, actor, root.patientId);
      if (!gate.canWrite) return fail(COPY.forbidden);
      // Solo lectura (deuda) o soporte: rechazo ANTES de render y Storage (no se sube nada que después no se pueda
      // escribir). Va después del gate: al soporte (sin clínico) le corresponde «no tenés acceso».
      const ro = writableError(actor);
      if (ro) return fail(ro);

      const replay = await replayInTx(tx, actor, noteId, key);
      if (replay) return replay;
      if (root.amendsNoteId !== null) return fail(COPY.notRoot);
      if (root.voidedAt) return fail(COPY.voided);

      const { rows, locationId } = await readShareEntryRowsInTx(tx, tenantId, noteId);
      const source = await loadHcPrintSourceInTx(tx, actor, { patientId: root.patientId, rows, locationId });
      if (!source || source.entries.length === 0) return fail(COPY.notFound);
      const patient = await tx.patient.findFirst({ where: { id: root.patientId, tenantId }, select: { userId: true } });
      return { kind: "prepared", root, source, patientPortal: patient?.userId ? "linked" : "not-linked" };
    });
    if ("ok" in step1) return step1;
    if (step1.kind === "replay") return { ok: true, data: step1.data };

    // ── 2. Fuera de tx: contenido, PDF y subida ──
    const { root, source } = step1;
    const sharerPractitionerId = requireActorPractitionerId(actor);
    let printable: HcPrintableV1;
    let snapshotSha256: string;
    let pdf: Uint8Array;
    try {
      const built = buildHcPrintableContent(source, "shared");
      const fin = finalizeHcPrintable(built.content, {
        generatedAt: new Date().toISOString(),
        purpose: "shared",
        generatedByName: actor.practitionerName,
        truncated: source.truncated,
      });
      printable = fin.printable;
      snapshotSha256 = fin.sha256;
      const assets = await loadAssetsSoft(source, built.signatureOwners);
      pdf = await renderHcPdf(printable, assets);
    } catch (e) {
      logger.error("patientDocument.render_failed", { tenantId, error: e instanceof Error ? e.name : "unknown" });
      return fail(COPY.pdfFailed);
    }
    if (pdf.byteLength === 0) return fail(COPY.pdfFailed);
    if (pdf.byteLength > HC_PDF_MAX_BYTES) return fail(COPY.tooLarge);

    const documentId = randomBytes(12).toString("hex");
    let uploadedKey: string | null = null;
    let pdfStorageKey = stubPdfKey(documentId);
    if (isStorageConfigured()) {
      pdfStorageKey = patientDocumentPdfKey(tenantId, root.patientId, documentId);
      const up = await storageUpload(PATIENT_DOCUMENTS_BUCKET, pdfStorageKey, pdf, "application/pdf");
      if (!up.ok) return fail(COPY.storageFailed);
      uploadedKey = pdfStorageKey;
    }
    const sourceEntry = source.entries[0].root;
    const title = patientDocumentTitle({ title: sourceEntry.title, label: sourceEntry.label });

    // ── 3. tx2: nota primero, re-gate, versión, revocar, crear, audit ──
    let result: Fail | { ok: true; data: ShareData; patientId: string };
    try {
      result = await runWithRls(tenantId, async (tx): Promise<Fail | { ok: true; data: ShareData; patientId: string }> => {
        if (!(await lockNoteForShareInTx(tx, tenantId, noteId))) return fail(COPY.notFound);
        const gate = await clinicalNoteGateInTx(tx, actor, root.patientId);
        if (!gate.canWrite) return fail(COPY.forbidden);
        const now = await readShareRootStateInTx(tx, tenantId, noteId);
        if (!now) return fail(COPY.notFound);
        if (now.voidedAt) return fail(COPY.voided);
        if (now.revision !== root.revision || now.digest !== root.digest) return fail(COPY.changed);

        const live = await tx.patientDocument.findFirst({
          where: { tenantId, noteId, revokedAt: null },
          select: { id: true },
        });
        const sharedAt = new Date();
        if (live) {
          await tx.patientDocument.updateMany({
            where: { id: live.id, tenantId, revokedAt: null },
            data: { revokedAt: sharedAt, revokedByUserId: actor.userId, revokeReason: "REPLACED" },
          });
        }
        const row = await tx.patientDocument.create({
          data: {
            id: documentId,
            tenantId,
            patientId: root.patientId,
            kind: "FICHA",
            noteId,
            noteRevision: now.revision,
            sourceDigest: now.digest,
            title,
            occurredAt: sourceEntry.occurredAt,
            snapshot: printable as unknown as Prisma.InputJsonValue,
            snapshotVersion: 1,
            snapshotSha256,
            pdfStorageKey,
            pdfSha256: sha256OfBytes(pdf),
            pdfSizeBytes: pdf.byteLength,
            sharedByUserId: actor.userId,
            sharedByPractitionerId: sharerPractitionerId,
            sharedAt,
            idempotencyKey: key,
          },
          select: SHARED_DOCUMENT_SELECT,
        });
        // Sin título ni contenido: el título de una ficha puede ser clínico («Lumbalgia»).
        await auditInTx(tx, {
          tenantId,
          actorId: actor.userId,
          action: "patientDocument.share",
          entity: "Patient",
          entityId: root.patientId,
          payload: { documentId: row.id, noteId, noteRevision: row.noteRevision, replacedDocumentId: live?.id ?? null },
        });
        return {
          ok: true,
          patientId: root.patientId,
          data: {
            document: toSharedDocumentDTO(row),
            replayed: false,
            replacedDocumentId: live?.id ?? null,
            patientPortal: step1.patientPortal,
            delivery: null,
          },
        };
      });
    } catch (e) {
      await removeUploaded(uploadedKey);
      // 23514: el snapshot pasó el tope del CHECK (2 MB de JSON); mismo remedio que un PDF pesado.
      if (pgErrorCode(e) === "23514") return fail(COPY.tooLarge);
      if (!isUniqueViolation(e) && !isTriggerRejection(e)) throw e;
      // La tx quedó abortada: se decide por los datos en una nueva (precedente: `createClinicalNote`).
      return await runWithRls(tenantId, async (tx): Promise<ActionResult<ShareData>> => {
        const replay = await replayInTx(tx, actor, noteId, key);
        if (replay && "kind" in replay) return { ok: true, data: replay.data };
        if (replay) return replay;
        const now = await readShareRootStateInTx(tx, tenantId, noteId);
        if (!now || now.amendsNoteId !== null) return fail(COPY.notFound);
        if (now.voidedAt) return fail(COPY.voided);
        // 23505 del parcial «un vivo por ficha»: otra persona compartió entre nuestra revocación y el INSERT.
        return isUniqueViolation(e) ? fail(COPY.raced) : fail(COPY.notFound);
      });
    }
    if (!result.ok) {
      await removeUploaded(uploadedKey);
      return result;
    }

    // ── 4. Después del commit ──
    revalidatePath(`/pacientes/${result.patientId}`);
    revalidatePath(`/portal/c/${actor.tenantSlug}/documentos`);
    let delivery: DocumentDeliveryOutcome | null = null;
    // T4Z-M2: el tope de avisos es por PACIENTE (el buzón que se protege), se cuenta solo cuando se pidió avisar y
    // después del commit: el documento ya está compartido y el paciente lo ve en su portal aunque no llegue el mail.
    const notifyAllowed = notify && (await rateLimit(`patient-document:notify:patient:${result.patientId}`, NOTIFY_RATE_LIMIT)).ok;
    if (notify && !notifyAllowed) {
      logger.info("patientDocument.notify_capped", { tenantId, documentId: result.data.document.id });
      delivery = { channel: "email", status: "skipped" };
    } else if (notify) {
      delivery = await deliverPatientDocument({
        tenantId,
        documentId: result.data.document.id,
        actorUserId: actor.userId,
        channel: "email",
        replaced: result.data.replacedDocumentId !== null,
      });
    }
    return { ok: true, data: { ...result.data, delivery } };
  } catch (e) {
    return forbiddenResult(e);
  }
}

/**
 * Replay de la clave dentro de una tx. Un replay no vuelve a mandar el mail (`delivery: null`): el primer envío ya avisó.
 * El gate ya pasó (canWrite) en quien llama, salvo en la tx de resolución de un 23505, donde la clave solo puede ser de
 * este mismo actor sobre esta misma ficha (si no → `keyReused`).
 */
async function replayInTx(
  tx: DbClient,
  actor: Actor,
  noteId: string,
  key: string,
): Promise<Fail | { kind: "replay"; data: ShareData } | null> {
  const prev = await tx.patientDocument.findFirst({
    where: { tenantId: actor.tenantId, idempotencyKey: key },
    select: { ...SHARED_DOCUMENT_SELECT, revokeReason: true, patient: { select: { userId: true } } },
  });
  const d = replayDecision(prev, { noteId, userId: actor.userId });
  if (d === "free" || !prev) return null;
  if (d === "key-reused") return fail(COPY.keyReused);
  // T4Z-B6: el mismo envío, pero su documento ya no está vivo. Devolverlo como `ok` hacía que la UI dijera «el paciente
  // ya lo ve» de un documento que el portal ya no muestra.
  if (prev.revokedAt) return fail(prev.revokeReason === "NOTE_VOIDED" ? COPY.voided : COPY.notLive);
  // ¿Qué reemplazó? El que quedó REPLACED en el mismo instante por este actor (revokedAt = sharedAt del nuevo).
  const replaced = await tx.patientDocument.findFirst({
    where: {
      tenantId: actor.tenantId,
      noteId,
      revokeReason: "REPLACED",
      revokedAt: prev.sharedAt,
      revokedByUserId: actor.userId,
      id: { not: prev.id },
    },
    select: { id: true },
  });
  return {
    kind: "replay",
    data: {
      document: toSharedDocumentDTO(prev),
      replayed: true,
      replacedDocumentId: replaced?.id ?? null,
      patientPortal: prev.patient.userId ? "linked" : "not-linked",
      delivery: null,
    },
  };
}

/** Falla blanda (C-FC5): un logo o una firma que no baja no impide compartir; el PDF sale sin esa imagen. */
async function loadAssetsSoft(source: HcPrintSource, signatureOwners: Record<string, string>): Promise<HcRenderAssets> {
  // Las claves salen de las filas (`assetKeys` del loader), nunca del cliente. La firma de cada entrada es la de SU
  // autor (FC-D26), no la de quien comparte.
  const keys = source.assetKeys ?? { logoKey: null, signatureKeys: {} };
  try {
    return await loadHcAssets({
      logoKey: keys.logoKey,
      signatures: Object.entries(signatureOwners).map(([ref, practitionerId]) => ({ ref, key: keys.signatureKeys[practitionerId] ?? null })),
    });
  } catch (e) {
    logger.warn("patientDocument.assets_failed", { error: e instanceof Error ? e.name : "unknown" });
    return { logo: null, signatures: {} };
  }
}

async function removeUploaded(key: string | null): Promise<void> {
  if (!key) return;
  // Best-effort: un remove fallido queda logueado por `storage-internal` (sin la clave, que lleva ids).
  await storageRemove(PATIENT_DOCUMENTS_BUCKET, [key]);
}

// ─── Dejar de compartir ──────────────────────────────────────────────────────

async function revokeImpl(input: { documentId: string }): Promise<ActionResult<{ documentId: string; revokedAt: string }>> {
  try {
    const actor = await getActor();
    assertModule(actor, "evoluciones");
    if (typeof input?.documentId !== "string" || !ID_RE.test(input.documentId)) return fail(COPY.docNotFound);
    const tenantId = actor.tenantId;
    const documentId = input.documentId;

    const result = await runWithRls(tenantId, async (tx): Promise<ActionResult<{ documentId: string; revokedAt: string; patientId: string }>> => {
      const doc = await tx.patientDocument.findFirst({
        where: { id: documentId, tenantId },
        select: { id: true, patientId: true, revokedAt: true },
      });
      if (!doc) return fail(COPY.docNotFound);
      const gate = await clinicalNoteGateInTx(tx, actor, doc.patientId);
      if (!gate.canWrite) return fail(COPY.forbidden);
      // Idempotente: ya revocado (por quien sea y por el motivo que sea) → ok con su fecha, sin audit nuevo.
      if (doc.revokedAt) return { ok: true, data: { documentId: doc.id, revokedAt: doc.revokedAt.toISOString(), patientId: doc.patientId } };
      const ro = writableError(actor);
      if (ro) return fail(ro);

      const revokedAt = new Date();
      const n = await tx.patientDocument.updateMany({
        where: { id: doc.id, tenantId, revokedAt: null },
        data: { revokedAt, revokedByUserId: actor.userId, revokeReason: "MANUAL" },
      });
      if (n.count === 0) {
        // Otra tx (anulación, reemplazo, otro «dejar de compartir») ganó en el medio: ya no está vivo, que es lo pedido.
        const now = await tx.patientDocument.findFirstOrThrow({ where: { id: doc.id, tenantId }, select: { revokedAt: true } });
        return { ok: true, data: { documentId: doc.id, revokedAt: (now.revokedAt ?? revokedAt).toISOString(), patientId: doc.patientId } };
      }
      await auditInTx(tx, {
        tenantId,
        actorId: actor.userId,
        action: "patientDocument.revoke",
        entity: "Patient",
        entityId: doc.patientId,
        payload: { documentId: doc.id, reason: "MANUAL" },
      });
      return { ok: true, data: { documentId: doc.id, revokedAt: revokedAt.toISOString(), patientId: doc.patientId } };
    });
    if (!result.ok) return result;
    revalidatePath(`/pacientes/${result.data.patientId}`);
    revalidatePath(`/portal/c/${actor.tenantSlug}/documentos`);
    return { ok: true, data: { documentId: result.data.documentId, revokedAt: result.data.revokedAt } };
  } catch (e) {
    return forbiddenResult(e);
  }
}

// ─── Helpers (no exportados: el archivo es "use server") ─────────────────────

function fail(error: string): Fail {
  return { ok: false, error };
}

/** `assertModule` / `requireActorPractitionerId` tiran ForbiddenError con su copy; el resto se propaga. */
function forbiddenResult(e: unknown): Fail {
  if (e instanceof ForbiddenError) return fail(e.message);
  throw e;
}
