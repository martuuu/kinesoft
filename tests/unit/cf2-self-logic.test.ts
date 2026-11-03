/**
 * [CF2-TS3-U*] CF2 (§29, D-CF2-8/9) — lógica pura de los ajustes propios del profesional (T-S3):
 *   - `parsePublicMinLead` (extraído de `parseTenantAgendaRules`, que no cambia: lo siguen fijando sus tests de CF-K);
 *   - `planLeadContactWrite`: prender exige celular AR válido + consentimiento y sella fecha + versión; apagar conserva
 *     el número; el mismo estado = no-op; cambiar el número estando prendido vuelve a pedir el consentimiento;
 *   - `planHideLeadContact`: solo apaga (el titular nunca prende ni toca el número);
 *   - `leadContactAuditPayload`: el audit nunca lleva el número completo.
 * Símbolos reales, sin mocks.
 */
import { describe, it, expect } from "vitest";
import { AGENDA_RULES_COPY, PUBLIC_MIN_LEAD_MAX_MINUTES, parsePublicMinLead, parseTenantAgendaRules } from "@/lib/agenda-rules-config";
import {
  LEAD_CONTACT_PHONE_COPY,
  SELF_SETTINGS_COPY,
  leadContactAuditPayload,
  maskE164,
  planHideLeadContact,
  planLeadContactWrite,
  type LeadContactState,
} from "@/lib/practitioner-self-settings-logic";
import { LEAD_CONTACT_CONSENT_VERSION } from "@/lib/public-lead-contact";

const NOW = new Date("2027-11-02T13:00:00.000Z");
const EARLIER = new Date("2027-10-01T12:00:00.000Z");
const OFF: LeadContactState = {
  contactWhatsapp: null,
  showContactInLeadWindow: false,
  contactConsentAt: null,
  contactConsentVersion: null,
};
const ON: LeadContactState = {
  contactWhatsapp: "+5491123456789",
  showContactInLeadWindow: true,
  contactConsentAt: EARLIER,
  contactConsentVersion: LEAD_CONTACT_CONSENT_VERSION,
};

describe("[CF2-TS3-U1] parsePublicMinLead", () => {
  it("vacío = null (hereda); enteros 0..8 semanas en número o dígitos", () => {
    for (const v of [null, undefined, ""]) expect(parsePublicMinLead(v)).toEqual({ ok: true, value: null });
    expect(parsePublicMinLead(0)).toEqual({ ok: true, value: 0 });
    expect(parsePublicMinLead("180")).toEqual({ ok: true, value: 180 });
    expect(parsePublicMinLead(PUBLIC_MIN_LEAD_MAX_MINUTES)).toEqual({ ok: true, value: PUBLIC_MIN_LEAD_MAX_MINUTES });
  });
  it("fuera de rango o no entero → copy de la anticipación", () => {
    for (const v of [-1, 1.5, "1e3", "2h", PUBLIC_MIN_LEAD_MAX_MINUTES + 1, true, {}]) {
      expect(parsePublicMinLead(v), String(v)).toEqual({ ok: false, error: AGENDA_RULES_COPY.minLead });
    }
  });
  it("parseTenantAgendaRules sigue igual (mismo copy y campo)", () => {
    expect(parseTenantAgendaRules({ publicMinLeadMinutes: "abc" })).toEqual({
      ok: false,
      error: AGENDA_RULES_COPY.minLead,
      field: "publicMinLeadMinutes",
    });
    expect(parseTenantAgendaRules({ publicMinLeadMinutes: "90" })).toEqual({
      ok: true,
      data: { agendaSlotStepMin: null, publicSlotStepMin: null, publicMinLeadMinutes: 90 },
    });
  });
});

describe("[CF2-TS3-U2] planLeadContactWrite", () => {
  it("prender sin consentimiento → error en acceptConsent, nada escrito", () => {
    expect(planLeadContactWrite(OFF, { contactWhatsapp: "011 15 2345-6789", show: true }, NOW)).toEqual({
      ok: false,
      error: SELF_SETTINGS_COPY.consentRequired,
      field: "acceptConsent",
    });
  });
  it("prender con consentimiento normaliza el número y sella fecha + versión", () => {
    expect(
      planLeadContactWrite(OFF, { contactWhatsapp: "011 15 2345-6789", show: true, acceptConsent: true }, NOW)
    ).toEqual({
      ok: true,
      kind: "write",
      consented: true,
      next: {
        contactWhatsapp: "+5491123456789",
        showContactInLeadWindow: true,
        contactConsentAt: NOW,
        contactConsentVersion: LEAD_CONTACT_CONSENT_VERSION,
      },
    });
  });
  it("prender sin número o con un fijo → error en contactWhatsapp con su copy", () => {
    expect(planLeadContactWrite(OFF, { contactWhatsapp: "  ", show: true, acceptConsent: true }, NOW)).toEqual({
      ok: false,
      error: LEAD_CONTACT_PHONE_COPY.empty,
      field: "contactWhatsapp",
    });
    expect(planLeadContactWrite(OFF, { contactWhatsapp: "011 4321-5678", show: true, acceptConsent: true }, NOW)).toEqual({
      ok: false,
      error: LEAD_CONTACT_PHONE_COPY.landline,
      field: "contactWhatsapp",
    });
    expect(planLeadContactWrite(OFF, { contactWhatsapp: "+598 99 123 456", show: false }, NOW)).toMatchObject({
      ok: false,
      error: LEAD_CONTACT_PHONE_COPY.not_ar,
    });
  });
  it("mismo estado (número en otro formato) = same; prendido y mismo número no vuelve a pedir consentimiento", () => {
    expect(planLeadContactWrite(ON, { contactWhatsapp: "+54 9 11 2345 6789", show: true }, NOW)).toEqual({
      ok: true,
      kind: "same",
    });
  });
  it("cambiar el número estando prendido vuelve a pedir el consentimiento", () => {
    expect(planLeadContactWrite(ON, { contactWhatsapp: "0351 155 123456", show: true }, NOW)).toMatchObject({
      ok: false,
      field: "acceptConsent",
    });
    const r = planLeadContactWrite(ON, { contactWhatsapp: "0351 155 123456", show: true, acceptConsent: true }, NOW);
    expect(r).toMatchObject({ ok: true, kind: "write", consented: true });
    if (r.ok && r.kind === "write") expect(r.next.contactConsentAt).toBe(NOW);
  });
  it("versión vieja del consentimiento → prendido igual lo vuelve a pedir", () => {
    const old = { ...ON, contactConsentVersion: "v0" };
    expect(planLeadContactWrite(old, { contactWhatsapp: ON.contactWhatsapp, show: true }, NOW)).toMatchObject({
      ok: false,
      field: "acceptConsent",
    });
  });
  it("apagar conserva el número y el sello; vacío al apagar borra el número", () => {
    expect(planLeadContactWrite(ON, { contactWhatsapp: ON.contactWhatsapp, show: false }, NOW)).toEqual({
      ok: true,
      kind: "write",
      consented: false,
      next: { ...ON, showContactInLeadWindow: false },
    });
    expect(planLeadContactWrite(ON, { contactWhatsapp: null, show: false }, NOW)).toMatchObject({
      ok: true,
      kind: "write",
      next: { contactWhatsapp: null, showContactInLeadWindow: false, contactConsentAt: EARLIER },
    });
  });
  it("acceptConsent apagado no sella nada", () => {
    expect(planLeadContactWrite(OFF, { contactWhatsapp: "11 2345 6789", show: false, acceptConsent: true }, NOW)).toEqual({
      ok: true,
      kind: "write",
      consented: false,
      next: { ...OFF, contactWhatsapp: "+5491123456789" },
    });
  });
});

describe("[CF2-TS3-U3] planHideLeadContact y audit", () => {
  it("solo apaga: prendido → write con el número intacto; apagado → same", () => {
    expect(planHideLeadContact(ON)).toEqual({ kind: "write", next: { ...ON, showContactInLeadWindow: false } });
    expect(planHideLeadContact({ ...ON, showContactInLeadWindow: false })).toEqual({ kind: "same" });
  });
  it("el audit no lleva el número completo", () => {
    expect(maskE164("+5491123456789")).toBe("…6789");
    expect(maskE164(null)).toBeNull();
    const p = leadContactAuditPayload(OFF, ON, true);
    expect(p).toEqual({
      from: { show: false, phone: null },
      to: { show: true, phone: "…6789" },
      consentVersion: LEAD_CONTACT_CONSENT_VERSION,
    });
    expect(JSON.stringify(p)).not.toContain("23456789");
    expect(leadContactAuditPayload(ON, { ...ON, showContactInLeadWindow: false }, false)).not.toHaveProperty("consentVersion");
  });
});
