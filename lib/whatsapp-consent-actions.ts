"use server";

/**
 * WA-S5 (T6, C-WA9, WA-D17/D25, brief §26.5) · Consentimiento de WhatsApp registrado por el equipo del consultorio.
 *
 * Gate: el de las escrituras administrativas de la ficha (`adminEditDenied` de `lib/patients.ts`, T3c-1b): acceso
 * `full` al paciente, o `admin` con `patients.editAdmin` (Titular sin agenda, Administración, Secretaría). Facturación
 * es `admin` sin `editAdmin` y queda afuera; el profesional que ve al paciente en `basic`, también. El brief dice
 * «`patients.editAdmin` (incluye a la Secretaría)»; el código ya resolvía «quién edita el contacto» con ese gate y el
 * consentimiento está anclado al contacto (`waPhoneE164`): si un profesional con `full` puede cambiar el teléfono,
 * tiene que poder registrar el consentimiento de ese teléfono. Soporte nunca (`memberCapabilitiesForActor` le saca
 * `patients.editAdmin`; además escribe en solo lectura).
 *
 * Reglas:
 *   - GRANTED exige que el teléfono ACTUAL de la ficha sea un celular válido (`normalizeArMobile`) y ancla
 *     `waPhoneE164` a esa normalización (WA-D17: si después cambia el teléfono, el canal queda `phone_changed` y no se
 *     manda nada hasta volver a consentir). Nunca se toma un número del cliente: el staff consiente lo que está cargado.
 *   - La versión que manda el cliente tiene que ser la vigente (`WA_CONSENT_VERSION`): si el texto legal cambió y el
 *     drawer quedó abierto con el viejo, se rechaza (se consiente un texto, no un booleano).
 *   - H-1 (default propuesto por WA-S8, aplicado acá): un REVOKED (BAJA) lo revierten solo el paciente respondiendo
 *     ALTA, el portal o el equipo del consultorio (esta action). El turnero anónimo no (handoff a su dueño).
 *   - Repetir el mismo estado (mismo número y versión) no escribe ni audita: el drawer puede reenviar.
 *   - `runWithRls` (Patient es tabla normal) + `where: { tenantId }` a mano (en prod la conexión tiene BYPASSRLS);
 *     audit `patient.whatsapp_consent` en la MISMA tx, con estado/origen/versión y NUNCA el número. La escritura es
 *     `writeWaConsentInTx` (`lib/whatsapp/consent-internal.ts`), la misma que usa el portal.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getActor } from "@/lib/session";
import { runWithRls } from "@/lib/rls";
import { memberCapabilitiesForActor } from "@/lib/authz";
import { patientAccessFor } from "@/lib/visibility";
import { withReadOnlyResult } from "@/lib/read-only-result";
import { writeWaConsentInTx } from "@/lib/whatsapp/consent-internal";
import { WA_CHANNEL_BLOCK_LABEL } from "@/lib/whatsapp/copy";
import { WA_CONSENT_VERSION, type WaConsentStatus } from "@/lib/whatsapp/types";
import type { ActionResult } from "@/lib/validation";

const Input = z
  .object({
    patientId: z.string().min(1).max(64),
    granted: z.boolean(),
    // CHECK `Patient_wa_consent_check`: `^[a-z0-9.-]{1,32}$`.
    version: z.string().regex(/^[a-z0-9.-]{1,32}$/),
  })
  .strict();

const COPY = {
  invalid: "Pedido inválido.",
  notFound: "Paciente no encontrado.",
  noEditAdmin: "Tu rol no edita los datos de los pacientes.",
  basic: "No tenés acceso completo a este paciente: solo podés verlo.",
  staleVersion: "El texto del consentimiento cambió. Recargá la página y volvé a leerlo con el paciente.",
  invalidPhone: `${WA_CHANNEL_BLOCK_LABEL.invalid_phone} Corregilo en los datos del paciente antes de registrar el consentimiento.`,
} as const;

export async function setPatientWhatsAppConsent(input: {
  patientId: string;
  granted: boolean;
  version: string;
}): Promise<ActionResult<{ status: WaConsentStatus }>> {
  const actor = await getActor();
  const parsed = Input.safeParse(input);
  if (!parsed.success) return { ok: false, error: COPY.invalid };
  const { patientId, granted, version } = parsed.data;
  if (granted && version !== WA_CONSENT_VERSION) return { ok: false, error: COPY.staleVersion };
  const caps = await memberCapabilitiesForActor(actor);

  return withReadOnlyResult(async (): Promise<ActionResult<{ status: WaConsentStatus }>> => {
    const r = await runWithRls(actor.tenantId, async (tx): Promise<ActionResult<{ status: WaConsentStatus }>> => {
      // `patientAccessFor` devuelve `none` para un id inexistente o de otro consultorio.
      const access = await patientAccessFor(actor, patientId, tx);
      if (access === "none") return { ok: false, error: COPY.notFound };
      if (access === "admin" && !caps.has("patients.editAdmin")) return { ok: false, error: COPY.noEditAdmin };
      if (access !== "full" && access !== "admin") return { ok: false, error: COPY.basic };
      const w = await writeWaConsentInTx(tx, {
        tenantId: actor.tenantId,
        patientId,
        granted,
        version,
        source: "STAFF",
        byUserId: actor.userId,
        actorId: actor.userId,
      });
      if (!w.ok) return { ok: false, error: w.reason === "invalid_phone" ? COPY.invalidPhone : COPY.notFound };
      return { ok: true, data: { status: w.status } };
    });
    if (r.ok) revalidatePath(`/pacientes/${patientId}`);
    return r;
  });
}
