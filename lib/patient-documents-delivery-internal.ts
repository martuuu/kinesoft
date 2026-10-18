import "server-only";

/**
 * FC-2d (T4, C-FC6, brief §24.5) · Aviso al paciente de un documento compartido, y la COSTURA de T6 (WhatsApp con el
 * PDF): `deliverPatientDocument` decide por `channel` y `loadPatientDocumentPdfForDelivery` le da los bytes al canal
 * que los necesite. Hoy el único canal es el mail, que NO lleva el PDF ni nada clínico (decisión 4 de Martin).
 *
 * Contrato: nunca tira y nunca tarda más de `DELIVERY_TIMEOUT_MS`. Corre DESPUÉS del commit de compartir: el documento
 * ya existe y el paciente ya lo ve en su portal; un Resend caído o lento no puede convertir eso en un error ni dejar la
 * action colgada (la UI muestra `emailFailed` y listo).
 */
import "@/lib/email/log";
import { sendEmail } from "@/lib/email";
import { portalDocumentEmail } from "@/lib/email/templates";
import { env } from "@/lib/env";
import { HC_PDF_MAX_BYTES } from "@/lib/hc-pdf/render-internal";
import { logger } from "@/lib/logger";
import { PATIENT_DOCUMENTS_BUCKET, patientDocumentPdfKey, sha256OfBytes } from "@/lib/patient-documents-internal";
import type { DocumentDeliveryChannel, DocumentDeliveryOutcome } from "@/lib/patient-documents-types";
import { runWithRls } from "@/lib/rls";
import { isStorageConfigured, storageDownload } from "@/lib/storage-internal";

export type { DocumentDeliveryChannel, DocumentDeliveryOutcome } from "@/lib/patient-documents-types";

/** Tope del aviso (§24.5: «≤5 s, nunca tira ni bloquea»). Pasado el tope se responde `failed`; el envío puede seguir. */
export const DELIVERY_TIMEOUT_MS = 5_000;

export async function deliverPatientDocument(input: {
  tenantId: string;
  documentId: string;
  actorUserId: string;
  channel: DocumentDeliveryChannel;
  replaced: boolean;
}): Promise<DocumentDeliveryOutcome> {
  const channel = input.channel;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<DocumentDeliveryOutcome>((resolve) => {
    timer = setTimeout(() => {
      logger.warn("patientDocument.delivery_timeout", { tenantId: input.tenantId, documentId: input.documentId, channel });
      resolve({ channel, status: "failed" });
    }, DELIVERY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([deliverEmail(input), timeout]);
  } catch (e) {
    // Ni el mensaje (podría traer el email) ni la pila: el id del documento alcanza para buscarlo.
    logger.warn("patientDocument.delivery_failed", {
      tenantId: input.tenantId,
      documentId: input.documentId,
      channel,
      error: e instanceof Error ? e.name : "unknown",
    });
    return { channel, status: "failed" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function deliverEmail(input: {
  tenantId: string;
  documentId: string;
  actorUserId: string;
  replaced: boolean;
}): Promise<DocumentDeliveryOutcome> {
  const channel = "email" as const;
  // Solo lectura: `runWithRls` con el GUC del consultorio y `tenantId` a mano (prod es BYPASSRLS).
  const doc = await runWithRls(input.tenantId, (tx) =>
    tx.patientDocument.findFirst({
      where: { id: input.documentId, tenantId: input.tenantId },
      select: {
        revokedAt: true,
        patient: { select: { userId: true, user: { select: { email: true, disabledAt: true } } } },
        tenant: { select: { name: true, slug: true, publicEmail: true } },
      },
    }),
  );
  // Revocado entre el commit y el aviso (o un id que no es de este consultorio): no se avisa de algo que no está.
  if (!doc || doc.revokedAt) return { channel, status: "skipped" };
  // §24.5: solo al email VERIFICADO de la cuenta del portal vinculada. `Patient.userId` lo escribe únicamente
  // `/portal/vincular` con una sesión de email confirmado (ES4 S24v), así que el email de esa cuenta es el verificado.
  // Nunca `Patient.email`: lo carga el consultorio a mano y puede ser de otra persona (un familiar, un typo).
  if (!doc.patient.userId || !doc.patient.user) return { channel, status: "no-portal-user" };
  // Cuenta deshabilitada a nivel Plataforma (BO0): no puede entrar al portal, el aviso no le sirve.
  if (doc.patient.user.disabledAt) return { channel, status: "skipped" };

  const appUrl = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
  const url = `${appUrl}/portal/c/${encodeURIComponent(doc.tenant.slug)}/documentos`;
  const r = await sendEmail({
    ...portalDocumentEmail({ tenantName: doc.tenant.name, url, replaced: input.replaced }),
    kind: "portal_document",
    to: doc.patient.user.email,
    tenantId: input.tenantId,
    entity: "PatientDocument",
    entityId: input.documentId,
    fromName: doc.tenant.name,
    replyTo: doc.tenant.publicEmail || null,
    actorId: input.actorUserId,
  });
  if (r.ok) return { channel, status: "sent" };
  // `skipped` = el ENTORNO no manda (Preview, dev, Production sin key): no es una falla del proveedor.
  return { channel, status: !r.ok && r.skipped ? "skipped" : "failed" };
}

/**
 * Bytes del PDF compartido para un canal que lo adjunte (T6). La clave se DERIVA (igual que el portal) y los bytes se
 * verifican contra `pdfSha256`: un objeto cambiado en el bucket no sale nunca hacia el paciente. null = revocado, de
 * otro consultorio, sin Storage (`stub:`), no bajó o el hash no coincide.
 */
export async function loadPatientDocumentPdfForDelivery(tenantId: string, documentId: string): Promise<Uint8Array | null> {
  try {
    const doc = await runWithRls(tenantId, (tx) =>
      tx.patientDocument.findFirst({
        where: { id: documentId, tenantId },
        select: { id: true, patientId: true, revokedAt: true, pdfStorageKey: true, pdfSha256: true },
      }),
    );
    if (!doc || doc.revokedAt) return null;
    if (doc.pdfStorageKey.startsWith("stub:") || !isStorageConfigured()) return null;
    const r = await storageDownload(PATIENT_DOCUMENTS_BUCKET, patientDocumentPdfKey(tenantId, doc.patientId, doc.id), HC_PDF_MAX_BYTES);
    if (!r.ok) return null;
    if (sha256OfBytes(r.data) !== doc.pdfSha256) {
      logger.error("patientDocument.pdf_sha_mismatch", { tenantId, documentId });
      return null;
    }
    return r.data;
  } catch (e) {
    logger.warn("patientDocument.pdf_load_failed", { tenantId, documentId, error: e instanceof Error ? e.name : "unknown" });
    return null;
  }
}
