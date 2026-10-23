import "server-only";
import { prismaService } from "@/lib/db";
import { auditSecurityEvent } from "@/lib/audit";
import { toARDateKey } from "@/lib/datetime-ar";
import { whatsappMode } from "@/lib/env";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/rate-limit";
import { loadPatientDocumentPdfForDelivery, PATIENT_NOTIFY_RATE_LIMIT, patientNotifyRateKey } from "@/lib/patient-documents-delivery-internal";
import type { DocumentDeliveryOutcome } from "@/lib/patient-documents-types";
import { getLiveAccountCached } from "@/lib/whatsapp/account-internal";
import { maskPhone, phoneHash } from "@/lib/whatsapp/crypto";
import { GRAPH_INLINE_TIMEOUT_MS, uploadMedia } from "@/lib/whatsapp/graph";
import { idemKey, patientChannel } from "@/lib/whatsapp/logic";
import { dispatch, enqueue, type DispatchResult, type WaDocumentPreparer } from "@/lib/whatsapp/outbox-internal";
import { TEMPLATE_SPECS } from "@/lib/whatsapp/templates";

/**
 * WA-S6 (T6, brief §26.5 «Compartir ficha») · La ficha compartida con el paciente, por WhatsApp, con el PDF adjunto.
 *
 * Dos piezas:
 *   - `deliverDocumentWhatsApp`: lo llama `deliverPatientDocument` (canal `whatsapp`) DESPUÉS del commit de compartir,
 *     solo si el staff marcó «El paciente pidió recibirlo por WhatsApp». Re-chequea cuenta, plantilla y consentimiento,
 *     cuenta el cupo de avisos del paciente (el MISMO que el mail: el tope protege a la persona, no al canal), audita
 *     (`patientDocument.whatsapp`, FALLA CERRADO) y recién ahí encola `doc:<documentId>:<key>` y despacha inline.
 *   - `prepareWhatsAppDocument` (el `WaDocumentPreparer` de C-WA7): baja los bytes con
 *     `loadPatientDocumentPdfForDelivery` (clave derivada + SHA contra `pdfSha256`; revocado → null) y los sube como
 *     MEDIA del número. Lo usan el despacho inline y los drenados (cron / webhook de estados): un mensaje que esperó en
 *     la cola vuelve a pasar por el re-chequeo, así un documento revocado o un objeto cambiado en el bucket no sale.
 *
 * Por qué media y nunca un link: una URL (firmada o no) en un chat de WhatsApp queda en el teléfono, en los servidores
 * de Meta y se reenvía; con el media, lo que sale es la copia que se compartió y nada más (decisión de §26.5).
 *
 * Por qué el audit va FUERA de la tx de compartir y falla cerrado: la cola escribe por el canal service después del
 * commit (Graph nunca dentro de una tx), así que no hay write al que atarlo. Sacar PHI a un tercero sin rastro no es
 * aceptable: si el audit no se escribe, no se encola.
 *
 * Nada de PHI fuera: los parámetros salen de `buildTemplateParams` (nombre y consultorio, WA-D16); el nombre del archivo
 * es genérico con la fecha (el título de una ficha puede ser clínico: «Lumbalgia»); los logs llevan ids.
 */

/** Un documento compartido que no salió en 24 h ya no es «lo que te acabo de compartir»: vence (el portal lo sigue mostrando). */
const DOCUMENT_TTL_MS = 24 * 3600_000;
/** Inline: dos llamadas a Graph (media + mensaje) de ≤ 2,5 s cada una, dentro del tope de 5 s del aviso. */
const INLINE_BUDGET_MS = 4_500;

export type WaDocumentShareInput = {
  tenantId: string;
  documentId: string;
  /** La clave de idempotencia del compartir: arma `doc:<documentId>:<key>`. */
  shareKey: string;
  actorUserId: string;
};

const out = (status: DocumentDeliveryOutcome["status"]): DocumentDeliveryOutcome => ({ channel: "whatsapp", status });

function outcomeOf(r: DispatchResult): DocumentDeliveryOutcome {
  switch (r.outcome) {
    case "sent":
      return out("sent");
    case "skipped":
    case "expired":
      return out("skipped");
    case "failed":
      return out("failed");
    // Timeout, rate limit de Meta o sin presupuesto: está en la cola y lo despacha el próximo drenado.
    default:
      return out("queued");
  }
}

export async function deliverDocumentWhatsApp(i: WaDocumentShareInput): Promise<DocumentDeliveryOutcome> {
  // Modo apagado: cero queries (regla de T6 para los write paths).
  const mode = whatsappMode();
  if (mode === "off") return out("skipped");

  const acc = await getLiveAccountCached(i.tenantId);
  if (!acc || acc.status !== "ACTIVE" || acc.mode !== mode) return out("skipped");

  const doc = await prismaService.patientDocument.findFirst({
    where: { id: i.documentId, tenantId: i.tenantId, revokedAt: null },
    select: { id: true, patientId: true, patient: { select: { phone: true, waConsent: true, waPhoneE164: true } } },
  });
  if (!doc) return out("skipped");
  const tpl = await prismaService.whatsAppTemplate.findFirst({
    where: { tenantId: i.tenantId, accountId: acc.id, key: "DOCUMENT_SHARED" },
    select: { status: true },
  });
  const ch = patientChannel({ accountActive: true, templateApproved: tpl?.status === "APPROVED", patient: doc.patient });
  // Sin consentimiento, revocado, número cambiado o plantilla sin aprobar: no se encola (no hay a quién ni con qué).
  if (ch.state !== "ready" || !doc.patient.waPhoneE164) {
    logger.info("whatsapp.document.not_queued", { tenantId: i.tenantId, documentId: i.documentId, reason: ch.state === "blocked" ? ch.reason : "no_consent" });
    return out("skipped");
  }
  const e164 = doc.patient.waPhoneE164;

  // T4Z-M2: el cupo es del PACIENTE y lo comparten el mail y WhatsApp (misma clave y tope que `lib/patient-documents.ts`).
  if (!(await rateLimit(patientNotifyRateKey(doc.patientId), PATIENT_NOTIFY_RATE_LIMIT)).ok) {
    logger.info("whatsapp.document.notify_capped", { tenantId: i.tenantId, documentId: i.documentId });
    return out("skipped");
  }

  let toHash: string;
  try {
    toHash = phoneHash(e164);
  } catch (err) {
    logger.error("whatsapp.document.hash_failed", { tenantId: i.tenantId, error: (err as Error)?.name });
    return out("failed");
  }

  // FALLA CERRADO: sin audit no hay envío.
  try {
    await auditSecurityEvent({
      tenantId: i.tenantId,
      actorId: i.actorUserId,
      action: "patientDocument.whatsapp",
      entity: "Patient",
      entityId: doc.patientId,
      payload: { documentId: doc.id, attested: true, mode },
    });
  } catch (err) {
    logger.error("whatsapp.document.audit_failed", { tenantId: i.tenantId, documentId: i.documentId, error: (err as Error)?.name });
    return out("failed");
  }

  const [id] = await enqueue([
    {
      tenantId: i.tenantId,
      accountId: acc.id,
      kind: "DOCUMENT_SHARED",
      trigger: "MANUAL",
      idempotencyKey: idemKey({ t: "doc", documentId: doc.id, key: i.shareKey }),
      patientId: doc.patientId,
      documentId: doc.id,
      templateName: TEMPLATE_SPECS.DOCUMENT_SHARED.name,
      toHash,
      toMasked: maskPhone(e164),
      expiresAt: new Date(Date.now() + DOCUMENT_TTL_MS),
      createdByUserId: i.actorUserId,
    },
  ]);
  // Ya estaba encolado (doble envío de la misma clave): lo despacha quien lo encoló o el drenado.
  if (!id) return out("queued");
  const r = await dispatch(id, { tenantId: i.tenantId, inline: true, budgetMs: INLINE_BUDGET_MS, prepareDocument: prepareWhatsAppDocument });
  return outcomeOf(r);
}

/**
 * C-WA7 `WaDocumentPreparer`. `skip: "document_changed"` = revocado, de otro paciente o consultorio, sin Storage, no
 * bajó o el SHA no coincide (todo eso es «no es el documento que se compartió»). Un error de Graph vuelve tal cual: la
 * cola decide reintento o FAILED (`classifyGraphError`).
 */
export const prepareWhatsAppDocument: WaDocumentPreparer = async ({ message, token, phoneNumberId, timeoutMs }) => {
  if (!message.documentId || !message.patientId) return { ok: false, skip: "document_changed" };
  const doc = await prismaService.patientDocument.findFirst({
    where: { id: message.documentId, tenantId: message.tenantId, patientId: message.patientId, revokedAt: null },
    select: { sharedAt: true },
  });
  if (!doc) return { ok: false, skip: "document_changed" };
  const bytes = await loadPatientDocumentPdfForDelivery(message.tenantId, message.documentId);
  if (!bytes) return { ok: false, skip: "document_changed" };
  const filename = `ficha-${toARDateKey(doc.sharedAt)}.pdf`;
  const up = await uploadMedia(token, phoneNumberId, { bytes, filename, mimeType: "application/pdf" }, { timeoutMs: Math.min(timeoutMs, GRAPH_INLINE_TIMEOUT_MS * 2) });
  if (!up.ok) return { ok: false, error: up };
  return { ok: true, mediaId: up.data.id, filename };
};
