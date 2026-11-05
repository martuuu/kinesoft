/**
 * CF2 (§29, D-CF2-8/9; M21) — lógica pura de los ajustes propios del profesional (`lib/practitioner-self-settings.ts`,
 * T-S3). Sin DB ni `next/*`: la testea `tests/unit/cf2-self-logic.test.ts` y la reusa la UI de «Mi agenda» para el copy.
 *
 * Contacto dentro de la anticipación (D-CF2-9, Ley 25.326): el número es un dato personal que se publica en una
 * superficie pública, así que lo carga y lo PRENDE solo el propio profesional, aceptando el texto de
 * `LEAD_CONTACT_CONSENT_COPY`; el consentimiento se sella con fecha + versión (`LEAD_CONTACT_CONSENT_VERSION`). Reglas:
 *   • Prender exige un celular AR válido (`normalizeArMobile`; el CHECK de M21 es `^\+549…`) y el consentimiento.
 *   • Seguir prendido con el MISMO número y la versión vigente no lo vuelve a pedir (guardar sin cambios = no-op).
 *     Cambiar el número estando prendido, o una versión vieja del texto, sí: lo aceptado fue mostrar ESE número con
 *     ESE texto.
 *   • Apagar conserva el número y el sello (para volver a prender sin tipearlo; el sello es el registro de lo que se
 *     aceptó, no se borra). Vacío al apagar = borrar el número.
 *   • El titular (`hidePractitionerLeadContact`) solo apaga: nunca prende ni toca el número.
 *   • El audit lleva solo los últimos 4 dígitos.
 */
import { normalizeArMobile, type ArPhoneRejectReason } from "@/lib/phone-e164";
import { LEAD_CONTACT_CONSENT_VERSION, consentCoversLeadContact } from "@/lib/public-lead-contact";

export const SELF_SETTINGS_COPY = {
  notFound: "Profesional no encontrado.",
  invalid: "Datos inválidos",
  leadForbidden:
    "Solo el propio profesional o quien tiene permiso de «Configuración» puede cambiar la anticipación del turnero.",
  /** Actor sin profesional (Secretaria, Facturación, un Administrador/a que no atiende). */
  ownOnly: "Esto lo configura cada profesional desde su usuario.",
  /** Soporte nunca toca lo personal del profesional (su número, sus avisos): no es Configuración del consultorio. */
  supportDenied: "Soporte no puede cambiar el contacto ni los avisos de un profesional.",
  hideForbidden: "Solo el propio profesional, el titular o el administrador pueden ocultar el contacto del profesional.",
  consentRequired: "Para mostrar tu número en el turnero tenés que aceptar el texto de consentimiento.",
  /** CF3 (D-CF3-5): el switch de OS reusa el número de arriba; sin número no hay qué mostrar. */
  // CF3 ZF2: la tarjeta de Mi agenda se llama «Si te piden un turno antes» (mi-agenda-logic.ts), no «Contacto en el turnero».
  insuredNeedsPhone: "Cargá tu celular en «Si te piden un turno antes» para poder mostrarlo a pacientes con obra social.",
  insuredConsentRequired:
    "Para mostrar tu WhatsApp a pacientes con obra social tenés que aceptar el texto de consentimiento.",
  insuredHideForbidden:
    "Solo el propio profesional, el titular o el administrador pueden ocultar el WhatsApp para pacientes con obra social.",
} as const;

/** Copy del número propio (el de `lib/booking-share.ts` habla del teléfono del paciente «en su ficha»). */
export const LEAD_CONTACT_PHONE_COPY: Record<ArPhoneRejectReason, string> = {
  empty: "Cargá tu celular para mostrarlo en el turnero.",
  landline: "Ese número es un fijo: el turnero solo muestra un celular con WhatsApp.",
  missing_area_code: "Al número le falta el código de área (por ejemplo, 11 o 351).",
  not_ar: "El número tiene que ser un celular de Argentina.",
  invalid: "Revisá el número: no parece un celular de Argentina.",
};

/**
 * Las 4 columnas de M21 del contacto (`Practitioner`) + el switch de OS de M22 (CF3, D-CF3-5). Opcional a propósito:
 * ausente = estado de CF2 (sin el switch), así los llamadores y tests de antes siguen igual.
 */
export type LeadContactState = {
  contactWhatsapp: string | null;
  showContactInLeadWindow: boolean;
  contactConsentAt: Date | null;
  contactConsentVersion: string | null;
  showContactForInsured?: boolean;
};

export type LeadContactInput = { contactWhatsapp: string | null; show: boolean; acceptConsent?: boolean };

export type LeadContactPlan =
  | { ok: true; kind: "same" }
  | { ok: true; kind: "write"; next: LeadContactState; consented: boolean }
  | { ok: false; error: string; field: "contactWhatsapp" | "acceptConsent" };

const sameState = (a: LeadContactState, b: LeadContactState) =>
  a.contactWhatsapp === b.contactWhatsapp &&
  a.showContactInLeadWindow === b.showContactInLeadWindow &&
  (a.contactConsentAt?.getTime() ?? null) === (b.contactConsentAt?.getTime() ?? null) &&
  a.contactConsentVersion === b.contactConsentVersion &&
  (a.showContactForInsured ?? false) === (b.showContactForInsured ?? false);

export function planLeadContactWrite(prev: LeadContactState, input: LeadContactInput, now: Date): LeadContactPlan {
  const raw = (input.contactWhatsapp ?? "").trim();
  let e164: string | null = null;
  if (raw) {
    const n = normalizeArMobile(raw);
    if (!n.ok) return { ok: false, error: LEAD_CONTACT_PHONE_COPY[n.reason], field: "contactWhatsapp" };
    e164 = n.e164;
  } else if (input.show) {
    return { ok: false, error: LEAD_CONTACT_PHONE_COPY.empty, field: "contactWhatsapp" };
  }

  let next: LeadContactState = { ...prev, contactWhatsapp: e164, showContactInLeadWindow: input.show };
  let consented = false;
  // CF3 (D-CF3-5): el switch de OS publica ESTE mismo número. Borrarlo apaga también ese switch (si no, el CHECK
  // `Practitioner_insuredContact_check` de M22 rebota como 500), y cambiarlo con el switch prendido pide el
  // consentimiento aunque la anticipación esté apagada: lo aceptado fue mostrar el número de antes.
  const insuredOn = prev.showContactForInsured === true;
  if (insuredOn && e164 === null) next = { ...next, showContactForInsured: false };
  const insuredNumberChanged = insuredOn && e164 !== null && e164 !== prev.contactWhatsapp;
  const leadStillValid =
    prev.showContactInLeadWindow &&
    prev.contactWhatsapp === e164 &&
    prev.contactConsentAt != null &&
    // CF3 (PR-P): el v1 sigue cubriendo la anticipación; solo el switch de OS exige el v2 (`hasCurrentContactConsent`).
    consentCoversLeadContact(prev.contactConsentVersion);
  if ((input.show && !leadStillValid) || insuredNumberChanged) {
    if (input.acceptConsent !== true) {
      return { ok: false, error: SELF_SETTINGS_COPY.consentRequired, field: "acceptConsent" };
    }
    next = { ...next, contactConsentAt: now, contactConsentVersion: LEAD_CONTACT_CONSENT_VERSION };
    consented = true;
  }
  if (sameState(prev, next)) return { ok: true, kind: "same" };
  return { ok: true, kind: "write", next, consented };
}

export function planHideLeadContact(
  prev: LeadContactState
): { kind: "same" } | { kind: "write"; next: LeadContactState } {
  if (!prev.showContactInLeadWindow) return { kind: "same" };
  return { kind: "write", next: { ...prev, showContactInLeadWindow: false } };
}

/** «…6789»: alcanza para reconocer el número en el historial sin dejarlo entero en `AuditEvent.payload`. */
export function maskE164(e164: string | null): string | null {
  if (!e164) return null;
  return `…${e164.replace(/\D/g, "").slice(-4)}`;
}

export function leadContactAuditPayload(
  from: LeadContactState,
  to: LeadContactState,
  consented: boolean
): { from: { show: boolean; phone: string | null }; to: { show: boolean; phone: string | null }; consentVersion?: string } {
  return {
    from: { show: from.showContactInLeadWindow, phone: maskE164(from.contactWhatsapp) },
    to: { show: to.showContactInLeadWindow, phone: maskE164(to.contactWhatsapp) },
    ...(consented && to.contactConsentVersion ? { consentVersion: to.contactConsentVersion } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CF3 (§30, D-CF3-5): WhatsApp del profesional para pacientes con obra social
// ─────────────────────────────────────────────────────────────────────────────

/** Las columnas que decide `setOwnInsuredContact` (el número y el sello son los del contacto de CF2). */
export type InsuredContactState = LeadContactState & { showContactForInsured: boolean };

export type InsuredContactPlan =
  | { ok: true; kind: "same" }
  | { ok: true; kind: "write"; next: InsuredContactState; consented: boolean }
  | { ok: false; error: string; field: "contactWhatsapp" | "acceptConsent" };

/** El sello sirve solo si es del texto VIGENTE (PR-P lo sube a v2 para cubrir los dos usos del número). */
export function hasCurrentContactConsent(s: Pick<LeadContactState, "contactConsentAt" | "contactConsentVersion">): boolean {
  return s.contactConsentAt != null && s.contactConsentVersion === LEAD_CONTACT_CONSENT_VERSION;
}

/**
 * Prender exige el número ya cargado (celular AR válido: se re-normaliza por si quedó uno viejo fuera de forma) y el
 * consentimiento vigente; si es viejo o no hay, `acceptConsent` lo sella de nuevo (fecha + versión vigente). Apagar
 * conserva número y sello. Lo mismo que respalda el CHECK de M22, pero con copy en vez de un 500.
 */
export function planInsuredContactWrite(
  prev: InsuredContactState,
  input: { show: boolean; acceptConsent?: boolean },
  now: Date
): InsuredContactPlan {
  if (!input.show) {
    if (!prev.showContactForInsured) return { ok: true, kind: "same" };
    return { ok: true, kind: "write", next: { ...prev, showContactForInsured: false }, consented: false };
  }
  const phone = prev.contactWhatsapp ? normalizeArMobile(prev.contactWhatsapp) : null;
  if (!phone || !phone.ok) return { ok: false, error: SELF_SETTINGS_COPY.insuredNeedsPhone, field: "contactWhatsapp" };
  if (hasCurrentContactConsent(prev)) {
    if (prev.showContactForInsured) return { ok: true, kind: "same" };
    return { ok: true, kind: "write", next: { ...prev, showContactForInsured: true }, consented: false };
  }
  if (input.acceptConsent !== true) {
    return { ok: false, error: SELF_SETTINGS_COPY.insuredConsentRequired, field: "acceptConsent" };
  }
  return {
    ok: true,
    kind: "write",
    next: { ...prev, showContactForInsured: true, contactConsentAt: now, contactConsentVersion: LEAD_CONTACT_CONSENT_VERSION },
    consented: true,
  };
}

export function insuredContactAuditPayload(
  from: InsuredContactState,
  to: InsuredContactState,
  consented: boolean
): { from: { show: boolean }; to: { show: boolean }; phone: string | null; consentVersion?: string } {
  return {
    from: { show: from.showContactForInsured },
    to: { show: to.showContactForInsured },
    phone: maskE164(to.contactWhatsapp),
    ...(consented && to.contactConsentVersion ? { consentVersion: to.contactConsentVersion } : {}),
  };
}
