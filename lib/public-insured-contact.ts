/**
 * CF3 (§30, PR-P) — piezas PURAS del turnero público para el precio por profesional y el contacto de pacientes con
 * obra social. Sin DB ni `next/*`: las usa `lib/public-booking.ts` (server) y las testea
 * `tests/unit/cf3-public-pricing.test.ts`.
 *
 * Por qué existe: TMP tiene dos profesionales que cobran distinto el mismo servicio (D-CF3-1) y uno puede no querer
 * mostrar su precio (D-CF3-3). El payload de `getPublicClinic` viaja entero en el HTML del turnero, así que «ocultar
 * el precio» tiene que ser una regla de QUÉ NÚMEROS SALEN del server, no de qué pinta el wizard. Y a un paciente con
 * obra social el turnero no le muestra precio: le ofrece el WhatsApp del profesional (D-CF3-5), que nunca va en el
 * HTML (lo trae `getInsuredContact`, con rate limit).
 */
import { particularQuoteCents } from "@/lib/copago";
import { phoneActionsFor, whatsAppShareUrl } from "@/lib/booking-share";
import { consentCoversInsuredContact } from "@/lib/public-lead-contact";
import type { PublicInsuredContact } from "@/lib/public-booking-types";

// ─── Precios del payload público (D-CF3-1/3) ────────────────────────────

export type PublicPricingInput = {
  /** Servicios que el turnero ofrece, con quién los ofrece online (`eligiblePractitioners` con `publicOnly`). */
  services: { id: string; priceCents: number; offeredBy: string[] }[];
  /** Profesionales públicos con su flag `showPublicPrice` (M22). */
  practitioners: { id: string; showPublicPrice: boolean }[];
  /** `PractitionerService.priceCents` (M22) de las filas del tenant; sin fila o null = hereda. */
  practitionerPrices: { practitionerId: string; serviceId: string; priceCents: number | null }[];
  /** Copago de la fila «Particular» del consultorio (null = no hay fila). */
  particularCopagoCents: number | null;
};

export type PublicPricing = {
  /** `PublicClinic.particularQuotes`: solo profesionales con el precio visible, solo servicios que ofrecen. */
  particularQuotes: Record<string, Record<string, number>>;
  /** `PublicClinic.services[].priceCents` por servicio (0 = no se manda, ver la regla). */
  servicePriceCents: Record<string, number>;
  /** ¿`onlinePayment.particularCopagoCents` puede viajar? false → se manda null. */
  particularCopagoPublic: boolean;
};

/**
 * Arma los números de plata del payload público. Reglas (D-CF3-3: «ningún precio de un profesional con el precio
 * oculto viaja en el HTML»):
 *
 *   1. `particularQuotes[p][s]` = `particularQuoteCents` (precio del profesional → «Particular» → servicio), la misma
 *      rama sin cobertura de `resolveBookingCopagoCents` que usa el submit. Un profesional con el precio oculto no
 *      tiene clave. El mapa va SIEMPRE (también `{}`): su presencia le dice al wizard que es el contrato de CF3 y que
 *      no caiga al precio del servicio.
 *   2. `services[].priceCents` (que el wizard viejo pintaba y el nuevo solo usa para el flujo de cobro con obra
 *      social): `Service.priceCents` solo si (a) al menos un profesional con el precio visible ofrece el servicio y
 *      (b) ese número no es la cotización de ninguno con el precio oculto que también lo ofrece (cuando un profesional
 *      oculto no tiene precio propio ni hay «Particular», su precio ES el del servicio). Si no, 0: el wizard no pinta
 *      montos ≤ 0 y, con cobro online, el interstitial muestra lo que cobra el server antes de Mercado Pago.
 *   3. `onlinePayment.particularCopagoCents` (fallback del wizard viejo): mismo criterio (b) contra la fila
 *      «Particular»: si es la cotización de algún profesional oculto, null.
 *
 * Por qué (b) compara por valor y no por «de dónde salió»: un profesional oculto cuyo precio propio coincide con el del
 * servicio también quedaría expuesto. El criterio es «este número no puede ser el precio de alguien que lo ocultó».
 */
export function buildPublicPricing(input: PublicPricingInput): PublicPricing {
  const visible = new Set(input.practitioners.filter((p) => p.showPublicPrice).map((p) => p.id));
  const known = new Set(input.practitioners.map((p) => p.id));
  const own = new Map<string, number | null>();
  for (const r of input.practitionerPrices) own.set(`${r.practitionerId}\u0000${r.serviceId}`, r.priceCents);

  const particularQuotes: Record<string, Record<string, number>> = {};
  const servicePriceCents: Record<string, number> = {};
  const hiddenQuotes = new Set<number>();

  for (const s of input.services) {
    let anyVisible = false;
    const hiddenHere = new Set<number>();
    for (const pid of s.offeredBy) {
      if (!known.has(pid)) continue;
      const quote = particularQuoteCents({
        practitionerPriceCents: own.get(`${pid}\u0000${s.id}`) ?? null,
        particularCopagoCents: input.particularCopagoCents,
        servicePriceCents: s.priceCents,
      });
      if (visible.has(pid)) {
        anyVisible = true;
        (particularQuotes[pid] ??= {})[s.id] = quote;
      } else {
        hiddenHere.add(quote);
        hiddenQuotes.add(quote);
      }
    }
    servicePriceCents[s.id] = anyVisible && !hiddenHere.has(s.priceCents) ? s.priceCents : 0;
  }

  return {
    particularQuotes,
    servicePriceCents,
    particularCopagoPublic: input.particularCopagoCents == null || !hiddenQuotes.has(input.particularCopagoCents),
  };
}

// ─── WhatsApp para pacientes con obra social (D-CF3-5) ───────────────────

/** Las columnas de `Practitioner` que decide el opt-in (M21 + M22). */
export type InsuredContactState = {
  showContactForInsured: boolean;
  contactWhatsapp: string | null;
  contactConsentAt: Date | null;
  contactConsentVersion: string | null;
};

/**
 * ¿Se le puede ofrecer el WhatsApp de este profesional a un paciente con obra social? Opt-in propio + consentimiento
 * v2 (el v1 no cubría este uso, `consentCoversInsuredContact`) + un celular AR válido (un fijo abriría «el número no
 * está en WhatsApp»; el CHECK de M21 ya exige `+549…`, esto es la segunda barrera porque se pinta en una superficie
 * pública). Es la MISMA regla para `PublicClinic.insuredContactAvailable` y para `getInsuredContact`: si el booleano
 * dice true, la action devuelve el número.
 */
export function insuredContactEligible(p: InsuredContactState): boolean {
  return (
    p.showContactForInsured &&
    p.contactConsentAt != null &&
    consentCoversInsuredContact(p.contactConsentVersion) &&
    phoneActionsFor(p.contactWhatsapp).waChatHref !== null
  );
}

/**
 * Texto prearmado del WhatsApp. SIN PHI: ni el nombre del paciente, ni su obra social, ni el turno. El paciente lo
 * completa en su teléfono; el link (con el texto) queda en el historial del navegador y en el de WhatsApp.
 */
export const INSURED_CONTACT_MESSAGE = "Hola, quería consultar si atendés con mi obra social.";

/**
 * Links armados para el wizard (`PublicInsuredContact`): WhatsApp con destinatario y el texto, y `tel:`. null si el
 * profesional no es elegible (el caller responde `{ ok: false, reason: "none" }`). `name` ya viene como nombre público
 * (`publicPractitionerName`: nunca el email).
 */
export function buildInsuredContact(p: InsuredContactState & { name: string }): PublicInsuredContact | null {
  if (!insuredContactEligible(p)) return null;
  const actions = phoneActionsFor(p.contactWhatsapp);
  if (!actions.e164 || !actions.telHref) return null;
  return {
    ok: true,
    name: p.name.trim(),
    waUrl: whatsAppShareUrl(INSURED_CONTACT_MESSAGE, actions.e164),
    telUrl: actions.telHref,
  };
}

/** `PublicClinic.clinicPhone`: `Tenant.phone` recortado; vacío → null (el wizard muestra solo el texto). */
export function publicClinicPhone(phone: string | null | undefined): string | null {
  const t = (phone ?? "").trim();
  return t ? t : null;
}
