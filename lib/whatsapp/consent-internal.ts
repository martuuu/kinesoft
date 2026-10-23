import "server-only";
import type { Prisma } from "@prisma/client";
import { auditInTx } from "@/lib/audit";
import { normalizeArMobile } from "@/lib/phone-e164";
import type { WaConsentStatus } from "@/lib/whatsapp/types";

/**
 * WA-S5 (T6, C-WA9, WA-D17) · Escritura del consentimiento de WhatsApp en la ficha, común al equipo
 * (`lib/whatsapp-consent-actions.ts`, origen STAFF) y al portal (`lib/portal-whatsapp-consent.ts`, origen PORTAL).
 *
 * Por qué vive acá y no en el archivo del portal: el guard de `tests/integration/portal-profile.test.ts` prohíbe
 * `patient.update*` en `lib/portal*.ts` (el portal nunca escribe el CONTACTO ni la cobertura: deja un pedido que el
 * consultorio aprueba). El consentimiento es otra cosa: es una decisión del propio paciente sobre cómo le escriben, y
 * el brief la pide en el portal. Sacarla a un módulo de WhatsApp mantiene el guard tal cual para todo lo demás y deja
 * UNA sola implementación de las reglas para los dos orígenes:
 *   - GRANTED exige que el teléfono ACTUAL de la ficha sea un celular válido y ancla `waPhoneE164` a esa normalización
 *     (WA-D17). Nunca un número que venga del cliente.
 *   - REVOKED conserva `waPhoneE164` (el CHECK lo admite): es el rastro de a qué número se le dijo que no.
 *   - Mismo estado (y para GRANTED, mismo número y versión) → no escribe ni audita.
 *   - Audit `patient.whatsapp_consent` en la MISMA tx (existe si y solo si el write existe), sin el número.
 *
 * El caller ya autorizó y elige el canal: `runWithRls` (staff) o `prismaService` (portal, sin Actor). Cada sentencia
 * lleva `tenantId` (y `userId` en el portal) a mano: en prod la conexión tiene BYPASSRLS.
 */
export type WaConsentWrite = {
  tenantId: string;
  patientId: string;
  /** Portal: la ficha tiene que seguir vinculada a ESTA cuenta (defensa en profundidad sobre `requirePortalPatient`). */
  linkedUserId?: string;
  granted: boolean;
  version: string;
  source: "STAFF" | "PORTAL";
  /** Quién lo registró si fue el staff (`waConsentByUserId`); null desde el portal. */
  byUserId: string | null;
  actorId: string;
  ip?: string | null;
  userAgent?: string | null;
};

export type WaConsentWriteResult =
  | { ok: true; status: WaConsentStatus; changed: boolean }
  | { ok: false; reason: "not_found" | "invalid_phone" };

export async function writeWaConsentInTx(tx: Prisma.TransactionClient, w: WaConsentWrite): Promise<WaConsentWriteResult> {
  const p = await tx.patient.findFirst({
    where: { id: w.patientId, tenantId: w.tenantId, ...(w.linkedUserId ? { userId: w.linkedUserId } : {}) },
    select: { id: true, phone: true, waConsent: true, waPhoneE164: true, waConsentVersion: true },
  });
  if (!p) return { ok: false, reason: "not_found" };
  const now = new Date();
  const status: WaConsentStatus = w.granted ? "GRANTED" : "REVOKED";

  if (w.granted) {
    const n = normalizeArMobile(p.phone);
    if (!n.ok) return { ok: false, reason: "invalid_phone" };
    if (p.waConsent === "GRANTED" && p.waPhoneE164 === n.e164 && p.waConsentVersion === w.version) {
      return { ok: true, status, changed: false };
    }
    await tx.patient.updateMany({
      where: { id: p.id, tenantId: w.tenantId },
      data: {
        waConsent: "GRANTED",
        waConsentAt: now,
        waConsentSource: w.source,
        waConsentByUserId: w.byUserId,
        waConsentVersion: w.version,
        waPhoneE164: n.e164,
      },
    });
  } else {
    if (p.waConsent === "REVOKED") return { ok: true, status, changed: false };
    await tx.patient.updateMany({
      where: { id: p.id, tenantId: w.tenantId },
      data: { waConsent: "REVOKED", waConsentAt: now, waConsentSource: w.source, waConsentByUserId: w.byUserId, waConsentVersion: w.version },
    });
  }
  await auditInTx(tx, {
    tenantId: w.tenantId,
    actorId: w.actorId,
    action: "patient.whatsapp_consent",
    entity: "Patient",
    entityId: p.id,
    ip: w.ip,
    userAgent: w.userAgent,
    payload: { status, from: p.waConsent ?? null, source: w.source, version: w.version },
  });
  return { ok: true, status, changed: true };
}
