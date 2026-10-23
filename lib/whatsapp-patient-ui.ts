"use server";

/**
 * WA-U3 (T6, brief §26.5) · Lecturas de WhatsApp para la UI del paciente. Se piden DIFERIDAS (al abrir «Editar
 * paciente» o el diálogo de compartir ficha) y solo cuando el consultorio tiene WhatsApp: el primer load de la ficha no
 * paga nada y el estado se lee fresco (el paciente pudo responder BAJA mientras la ficha estaba abierta).
 *
 *   - Modo `off` (o cuenta no ACTIVE): se corta antes de tocar el paciente (`tenantWhatsAppActive`: con `off`, 0
 *     sentencias; con cuenta, cacheada).
 *   - `where: { tenantId }` a mano dentro de `runWithRls` (en prod la conexión tiene BYPASSRLS: es la única barrera).
 *   - Nunca sale el número consentido (`waPhoneE164`) ni el teléfono: solo si lo cargado hoy es ese celular.
 */
import { getActor } from "@/lib/session";
import { runWithRls } from "@/lib/rls";
import { assertModule, memberCapabilitiesForActor } from "@/lib/authz";
import { patientAccessFor } from "@/lib/visibility";
import { clinicalNoteGateInTx } from "@/lib/clinical-notes-internal";
import { normalizeArMobile } from "@/lib/phone-e164";
import { patientChannel } from "@/lib/whatsapp/logic";
import { WA_CONSENT_VERSION } from "@/lib/whatsapp/types";
import { tenantWhatsAppActive } from "@/lib/whatsapp-patient-ui-internal";
import type { PatientWaConsentState, PatientWaShareInfo } from "@/lib/whatsapp-patient-ui-types";

type Res<T> = { ok: true; data: T } | { ok: false; error: string };

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const NOT_FOUND = "No encontramos al paciente.";
const FORBIDDEN = "No tenés acceso a este paciente.";

/**
 * Estado del consentimiento para la fila de «Editar paciente». `data: null` = el consultorio no tiene WhatsApp activo
 * (la fila no se muestra). Gate = el de `setPatientWhatsAppConsent` (acceso `full`, o `admin` con
 * `patients.editAdmin`: la Secretaría registra el consentimiento, es un dato administrativo); Facturación y el `basic`
 * no lo leen, porque tampoco lo pueden cambiar.
 */
export async function getPatientWhatsAppConsentState(input: {
  patientId: string;
}): Promise<Res<PatientWaConsentState | null>> {
  try {
    const actor = await getActor();
    if (typeof input?.patientId !== "string" || !ID_RE.test(input.patientId)) return { ok: false, error: NOT_FOUND };
    if (!(await tenantWhatsAppActive(actor.tenantId))) return { ok: true, data: null };
    const patientId = input.patientId;
    const caps = await memberCapabilitiesForActor(actor);
    return await runWithRls(actor.tenantId, async (tx): Promise<Res<PatientWaConsentState | null>> => {
      const access = await patientAccessFor(actor, patientId, tx);
      if (access === "none") return { ok: false, error: NOT_FOUND };
      if (access === "admin" ? !caps.has("patients.editAdmin") : access !== "full") return { ok: false, error: FORBIDDEN };
      const p = await tx.patient.findFirst({
        where: { id: patientId, tenantId: actor.tenantId },
        select: { phone: true, waConsent: true, waConsentAt: true, waConsentSource: true, waConsentVersion: true, waPhoneE164: true },
      });
      if (!p) return { ok: false, error: NOT_FOUND };
      const n = normalizeArMobile(p.phone);
      return {
        ok: true,
        data: {
          status: p.waConsent ?? null,
          at: p.waConsentAt?.toISOString() ?? null,
          source: p.waConsentSource ?? null,
          phoneValid: n.ok,
          phoneChanged: p.waConsent === "GRANTED" && (!n.ok || n.e164 !== p.waPhoneE164),
          versionOutdated: p.waConsent === "GRANTED" && p.waConsentVersion !== WA_CONSENT_VERSION,
        },
      };
    });
  } catch {
    return { ok: false, error: FORBIDDEN };
  }
}

/**
 * ¿Se le puede ofrecer «Enviar también por WhatsApp» al compartir una ficha? Mismo gate que compartir
 * (`clinicalNoteGateInTx(...).canWrite`, FC-D8): la Secretaría, Facturación y soporte no comparten fichas, así que
 * tampoco ven esto. Es solo para la UI: `shareClinicalNoteWithPatient` re-chequea todo al encolar (y la cola, al
 * despachar). La plantilla del documento no se mira acá (sería otra lectura por apertura): si está en revisión, la
 * action devuelve `skipped` y el diálogo lo dice.
 */
export async function getPatientWhatsAppShareInfo(input: { patientId: string }): Promise<Res<PatientWaShareInfo>> {
  try {
    const actor = await getActor();
    assertModule(actor, "evoluciones");
    if (typeof input?.patientId !== "string" || !ID_RE.test(input.patientId)) return { ok: false, error: NOT_FOUND };
    if (!(await tenantWhatsAppActive(actor.tenantId))) return { ok: true, data: { available: false, reason: "no_account" } };
    const patientId = input.patientId;
    return await runWithRls(actor.tenantId, async (tx): Promise<Res<PatientWaShareInfo>> => {
      const p = await tx.patient.findFirst({
        where: { id: patientId, tenantId: actor.tenantId },
        select: { phone: true, waConsent: true, waPhoneE164: true },
      });
      if (!p) return { ok: false, error: NOT_FOUND };
      const gate = await clinicalNoteGateInTx(tx, actor, patientId);
      if (!gate.canWrite) return { ok: false, error: FORBIDDEN };
      const ch = patientChannel({ accountActive: true, templateApproved: true, patient: p });
      return { ok: true, data: ch.state === "ready" ? { available: true } : { available: false, reason: ch.reason } };
    });
  } catch {
    return { ok: false, error: FORBIDDEN };
  }
}
