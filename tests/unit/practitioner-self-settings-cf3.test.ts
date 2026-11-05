/**
 * [CF3-AUC-U1..6] CF3 AU-C (§30, D-CF3-3/5) — lógica pura de los dos switches nuevos del profesional
 * (`lib/practitioner-self-settings-logic.ts`) y su cruce con el contacto de CF2.
 *
 * Por qué importa: `showContactForInsured` publica el MISMO número que el contacto de la anticipación (D-CF3-5), así
 * que el consentimiento tiene que ser el VIGENTE (`LEAD_CONTACT_CONSENT_VERSION`, que PR-P sube a v2) y cambiar o
 * borrar el número con el switch de OS prendido no puede dejarlo publicando un número sin consentimiento (ni chocar con
 * el CHECK `Practitioner_insuredContact_check` de M22, que sale como 500 sin copy).
 */
import { describe, it, expect } from "vitest";
import {
  SELF_SETTINGS_COPY as COPY,
  insuredContactAuditPayload,
  planInsuredContactWrite,
  planLeadContactWrite,
  type InsuredContactState,
} from "@/lib/practitioner-self-settings-logic";
import { LEAD_CONTACT_CONSENT_VERSION } from "@/lib/public-lead-contact";

const now = new Date("2026-11-05T15:00:00.000Z");
const before = new Date("2026-11-01T13:00:00.000Z");
const base: InsuredContactState = {
  contactWhatsapp: "+5491155550101",
  showContactInLeadWindow: false,
  showContactForInsured: false,
  contactConsentAt: before,
  contactConsentVersion: LEAD_CONTACT_CONSENT_VERSION,
};

describe("[CF3-AUC-U] planInsuredContactWrite", () => {
  it("[CF3-AUC-U1] prender con número y consentimiento vigente: write sin volver a sellar", () => {
    const p = planInsuredContactWrite(base, { show: true }, now);
    expect(p).toEqual({ ok: true, kind: "write", next: { ...base, showContactForInsured: true }, consented: false });
  });

  it("[CF3-AUC-U2] sin número → error de número (campo contactWhatsapp), nunca un write que choque con el CHECK", () => {
    const p = planInsuredContactWrite({ ...base, contactWhatsapp: null }, { show: true, acceptConsent: true }, now);
    expect(p).toEqual({ ok: false, error: COPY.insuredNeedsPhone, field: "contactWhatsapp" });
  });

  it("[CF3-ZF2-7] el copy nombra la tarjeta como se llama en Mi agenda («Si te piden un turno antes»)", () => {
    expect(COPY.insuredNeedsPhone).toBe(
      "Cargá tu celular en «Si te piden un turno antes» para poder mostrarlo a pacientes con obra social."
    );
    expect(COPY.insuredNeedsPhone).not.toContain("Contacto en el turnero");
  });

  it("[CF3-AUC-U3] consentimiento viejo o ausente: sin aceptar → error; aceptando → sella fecha + versión vigente", () => {
    const old = { ...base, contactConsentVersion: "cf2-lead-contact-v0-test" };
    expect(planInsuredContactWrite(old, { show: true }, now)).toEqual({
      ok: false,
      error: COPY.insuredConsentRequired,
      field: "acceptConsent",
    });
    expect(planInsuredContactWrite({ ...base, contactConsentAt: null, contactConsentVersion: null }, { show: true }, now))
      .toMatchObject({ ok: false, field: "acceptConsent" });
    const ok = planInsuredContactWrite(old, { show: true, acceptConsent: true }, now);
    expect(ok).toEqual({
      ok: true,
      kind: "write",
      next: { ...old, showContactForInsured: true, contactConsentAt: now, contactConsentVersion: LEAD_CONTACT_CONSENT_VERSION },
      consented: true,
    });
  });

  it("[CF3-AUC-U4] mismo estado = same; apagar = write que conserva número y sello", () => {
    const on = { ...base, showContactForInsured: true };
    expect(planInsuredContactWrite(on, { show: true }, now)).toEqual({ ok: true, kind: "same" });
    expect(planInsuredContactWrite(base, { show: false }, now)).toEqual({ ok: true, kind: "same" });
    expect(planInsuredContactWrite(on, { show: false }, now)).toEqual({
      ok: true,
      kind: "write",
      next: { ...on, showContactForInsured: false },
      consented: false,
    });
  });

  it("[CF3-AUC-U5] audit sin el número completo", () => {
    const on = { ...base, showContactForInsured: true };
    const payload = insuredContactAuditPayload(base, on, false);
    expect(payload).toEqual({ from: { show: false }, to: { show: true }, phone: "…0101" });
    expect(JSON.stringify(payload)).not.toContain("5491155550101");
  });
});

describe("[CF3-AUC-U6] el contacto de CF2 con el switch de OS prendido", () => {
  const insuredOn = { ...base, showContactForInsured: true };

  it("borrar el número apaga también el de OS (si no, el CHECK de M22 rebota)", () => {
    const p = planLeadContactWrite(insuredOn, { contactWhatsapp: "", show: false }, now);
    expect(p).toMatchObject({ ok: true, kind: "write", next: { contactWhatsapp: null, showContactForInsured: false } });
  });

  it("cambiar el número con OS prendido pide el consentimiento aunque la anticipación esté apagada", () => {
    expect(planLeadContactWrite(insuredOn, { contactWhatsapp: "11 5555 0202", show: false }, now)).toEqual({
      ok: false,
      error: COPY.consentRequired,
      field: "acceptConsent",
    });
    const ok = planLeadContactWrite(insuredOn, { contactWhatsapp: "11 5555 0202", show: false, acceptConsent: true }, now);
    expect(ok).toMatchObject({
      ok: true,
      kind: "write",
      consented: true,
      next: { contactWhatsapp: "+5491155550202", showContactForInsured: true, contactConsentAt: now },
    });
  });

  it("sin el switch de OS (estado de CF2, sin la columna) el comportamiento es el de siempre", () => {
    const { showContactForInsured: _drop, ...cf2 } = base;
    void _drop;
    expect(planLeadContactWrite(cf2, { contactWhatsapp: "11 5555 0202", show: false }, now)).toMatchObject({
      ok: true,
      kind: "write",
      consented: false,
    });
  });
});
