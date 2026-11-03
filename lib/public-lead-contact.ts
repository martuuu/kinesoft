/**
 * CF2 (§29, D-CF2-10; M21) — contacto del profesional DENTRO de la anticipación. Puro (sin DB ni `next/*`): lo usa
 * `listPublicSlotWindow` (server) para armar `PublicSlotWindow.leadContact` y lo testea `tests/unit/cf2-lead.test.ts`.
 *
 * Por qué existe: con una anticipación larga (p. ej. 3 h) el turnero no deja reservar un hueco libre de dentro de una
 * hora, y el paciente se iba creyendo que no había lugar. Ahora, si HOY hay lugar libre dentro de la anticipación
 * (`publicLeadWindowHasFree`) y el profesional lo habilitó con su consentimiento, el wizard ofrece escribirle o llamarlo.
 *
 * Reglas que viven acá:
 *   • El texto prearmado NUNCA lleva horarios: el turnero no le dice al paciente qué hueco hay (D-CF2-10), solo que
 *     puede preguntar. Coordinar es del profesional.
 *   • El número llega ya normalizado (E.164 AR móvil, CHECK `Practitioner_contactWhatsapp_check` de M21); igual se
 *     sanea a dígitos antes de meterlo en un href: es dato de la base pintado en una superficie pública.
 *   • Solo links armados + nombre (`PublicLeadContact`): el número no viaja en una clave suelta.
 */
import { whatsAppShareUrl } from "@/lib/booking-share";
import type { PublicLeadContact } from "@/lib/public-booking-types";

/**
 * Versión del texto de consentimiento que el profesional acepta al prender el contacto (se sella en
 * `Practitioner.contactConsentVersion` junto con `contactConsentAt`; CHECK de M21: 1..32 caracteres). Si cambia
 * `LEAD_CONTACT_CONSENT_COPY` en algo de fondo, se sube la versión: el consentimiento registrado es el de ESE texto
 * (Ley 25.326: el número es un dato personal publicado en una superficie pública).
 */
export const LEAD_CONTACT_CONSENT_VERSION = "cf2-lead-contact-v1";

/** Lo que el profesional acepta (checkbox de «Mi agenda»). Voseo, sin jerga. */
export const LEAD_CONTACT_CONSENT_COPY =
  "Acepto que mi número de WhatsApp se muestre en el turnero online a quienes buscan un turno para hoy, solo cuando " + // claim-ok: prisma/schema.prisma:425
  "tengo lugar libre dentro de mi anticipación. Lo puedo desactivar cuando quiera.";

/** «Hola {nombre}, te escribo desde el turnero online de {Consultorio}. ¿Tenés algún turno disponible antes?» */
export function leadContactMessage(p: { name: string; tenantName: string }): string {
  return `Hola ${p.name.trim()}, te escribo desde el turnero online de ${p.tenantName.trim()}. ¿Tenés algún turno disponible antes?`;
}

/**
 * Links de WhatsApp (con destinatario y el texto prearmado, `whatsAppShareUrl` de WA-0) y de llamada (`tel:+…`, mismo
 * patrón que `clinicContactChannels` del directorio). `e164` = `Practitioner.contactWhatsapp`.
 */
export function buildLeadContact(p: { name: string; e164: string; tenantName: string }): PublicLeadContact {
  const digits = p.e164.replace(/\D/g, "");
  return {
    name: p.name.trim(),
    waUrl: whatsAppShareUrl(leadContactMessage(p), `+${digits}`),
    telUrl: `tel:+${digits}`,
  };
}
