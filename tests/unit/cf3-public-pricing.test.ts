// CF3 (§30, D-CF3-1/3/5) · PR-P: lo que el server manda del precio por profesional y la regla del contacto para
// pacientes con obra social (puros de `lib/public-insured-contact.ts` y el consentimiento v2 de
// `lib/public-lead-contact.ts`). La integración (payload real de `getPublicClinic`, submit, status y la action) está en
// `tests/integration/cf3-turnero-price.test.ts`.
import { describe, expect, it } from "vitest";
import {
  INSURED_CONTACT_MESSAGE,
  buildInsuredContact,
  buildPublicPricing,
  insuredContactEligible,
  publicClinicPhone,
  type PublicPricingInput,
} from "@/lib/public-insured-contact";
import {
  LEAD_CONTACT_CONSENT_COPY,
  LEAD_CONTACT_CONSENT_VERSION,
  LEAD_CONTACT_CONSENT_VERSION_V1,
  consentCoversInsuredContact,
  consentCoversLeadContact,
} from "@/lib/public-lead-contact";

const SVC = 10_000_00;
const base = (o: Partial<PublicPricingInput> = {}): PublicPricingInput => ({
  services: [{ id: "s1", priceCents: SVC, offeredBy: ["a", "b"] }],
  practitioners: [
    { id: "a", showPublicPrice: true },
    { id: "b", showPublicPrice: true },
  ],
  practitionerPrices: [],
  particularCopagoCents: null,
  ...o,
});

describe("[CF3-PRP] buildPublicPricing (D-CF3-1/3)", () => {
  it("[CF3-PRP1] cada profesional con su precio; sin precio propio → «Particular» → servicio", () => {
    const withOwn = buildPublicPricing(
      base({ practitionerPrices: [{ practitionerId: "a", serviceId: "s1", priceCents: 15_000_00 }], particularCopagoCents: 8_000_00 })
    );
    expect(withOwn.particularQuotes).toEqual({ a: { s1: 15_000_00 }, b: { s1: 8_000_00 } });
    const noParticular = buildPublicPricing(base());
    expect(noParticular.particularQuotes).toEqual({ a: { s1: SVC }, b: { s1: SVC } });
    // 0 es un precio válido (sesión sin cargo), no «hereda».
    const zero = buildPublicPricing(base({ practitionerPrices: [{ practitionerId: "a", serviceId: "s1", priceCents: 0 }] }));
    expect(zero.particularQuotes.a.s1).toBe(0);
  });

  it("[CF3-PRP2] precio oculto: el profesional no tiene clave y su número no aparece en ningún lado del resultado", () => {
    const r = buildPublicPricing(
      base({
        practitioners: [
          { id: "a", showPublicPrice: true },
          { id: "b", showPublicPrice: false },
        ],
        practitionerPrices: [
          { practitionerId: "a", serviceId: "s1", priceCents: 15_000_00 },
          { practitionerId: "b", serviceId: "s1", priceCents: 9_123_00 },
        ],
        particularCopagoCents: 8_000_00,
      })
    );
    expect(Object.keys(r.particularQuotes)).toEqual(["a"]);
    expect(JSON.stringify(r)).not.toContain(String(9_123_00));
    // Servicio y Particular no son el precio de b → viajan.
    expect(r.servicePriceCents.s1).toBe(SVC);
    expect(r.particularCopagoPublic).toBe(true);
  });

  it("[CF3-PRP3] servicio que solo ofrece un profesional oculto → services[].priceCents = 0", () => {
    const r = buildPublicPricing(
      base({
        services: [{ id: "s1", priceCents: SVC, offeredBy: ["b"] }],
        practitioners: [
          { id: "a", showPublicPrice: true },
          { id: "b", showPublicPrice: false },
        ],
        practitionerPrices: [{ practitionerId: "b", serviceId: "s1", priceCents: 9_000_00 }],
      })
    );
    expect(r.particularQuotes).toEqual({});
    expect(r.servicePriceCents.s1).toBe(0);
  });

  it("[CF3-PRP4] oculto que hereda el precio del servicio (sin propio ni Particular) → el del servicio no viaja", () => {
    const r = buildPublicPricing(
      base({
        practitioners: [
          { id: "a", showPublicPrice: true },
          { id: "b", showPublicPrice: false },
        ],
        practitionerPrices: [{ practitionerId: "a", serviceId: "s1", priceCents: 15_000_00 }],
      })
    );
    expect(r.particularQuotes).toEqual({ a: { s1: 15_000_00 } });
    expect(r.servicePriceCents.s1).toBe(0);
  });

  it("[CF3-PRP5] oculto que hereda «Particular» → onlinePayment.particularCopagoCents no viaja", () => {
    const r = buildPublicPricing(
      base({
        practitioners: [
          { id: "a", showPublicPrice: true },
          { id: "b", showPublicPrice: false },
        ],
        practitionerPrices: [{ practitionerId: "a", serviceId: "s1", priceCents: 15_000_00 }],
        particularCopagoCents: 8_000_00,
      })
    );
    expect(r.particularCopagoPublic).toBe(false);
    expect(r.servicePriceCents.s1).toBe(SVC);
    expect(JSON.stringify(r.particularQuotes)).not.toContain(String(8_000_00));
  });

  it("[CF3-PRP6] todos visibles y sin precios propios = el payload de hoy (servicio y Particular viajan)", () => {
    const r = buildPublicPricing(base({ particularCopagoCents: 0 }));
    expect(r.servicePriceCents.s1).toBe(SVC);
    expect(r.particularCopagoPublic).toBe(true);
    expect(r.particularQuotes).toEqual({ a: { s1: 0 }, b: { s1: 0 } });
  });

  it("[CF3-PRP7] solo cuenta quien ofrece el servicio: un id que no es profesional público se ignora", () => {
    const r = buildPublicPricing(base({ services: [{ id: "s1", priceCents: SVC, offeredBy: ["a", "zz"] }] }));
    expect(Object.keys(r.particularQuotes)).toEqual(["a"]);
  });
});

const NOW = new Date("2026-11-04T12:00:00Z");
const insured = (o: Partial<Parameters<typeof insuredContactEligible>[0]> = {}) => ({
  showContactForInsured: true,
  contactWhatsapp: "+5491123456789",
  contactConsentAt: NOW,
  contactConsentVersion: LEAD_CONTACT_CONSENT_VERSION,
  ...o,
});

describe("[CF3-PRP] consentimiento v2 y contacto para OS (D-CF3-5)", () => {
  it("[CF3-PRP8] v2 vigente; v1 sigue valiendo para la anticipación pero no para OS; otra versión, para nada", () => {
    expect(LEAD_CONTACT_CONSENT_VERSION).toBe("cf3-lead-contact-v2");
    expect(LEAD_CONTACT_CONSENT_VERSION.length).toBeLessThanOrEqual(32); // CHECK de M21
    expect(consentCoversLeadContact(LEAD_CONTACT_CONSENT_VERSION)).toBe(true);
    expect(consentCoversInsuredContact(LEAD_CONTACT_CONSENT_VERSION)).toBe(true);
    expect(consentCoversLeadContact(LEAD_CONTACT_CONSENT_VERSION_V1)).toBe(true);
    expect(consentCoversInsuredContact(LEAD_CONTACT_CONSENT_VERSION_V1)).toBe(false);
    for (const v of [null, undefined, "", "cf0-old", "CF3-LEAD-CONTACT-V2"]) {
      expect(consentCoversLeadContact(v), String(v)).toBe(false);
      expect(consentCoversInsuredContact(v), String(v)).toBe(false);
    }
  });

  it("[CF3-PRP9] el texto v2 cubre los dos usos («turno para hoy» y «obra social») y se puede desactivar", () => {
    expect(LEAD_CONTACT_CONSENT_COPY).toMatch(/turno para hoy/);
    expect(LEAD_CONTACT_CONSENT_COPY).toMatch(/obra social/);
    expect(LEAD_CONTACT_CONSENT_COPY).toMatch(/desactivar/);
  });

  it("[CF3-PRP10] elegible solo con opt-in + fecha + v2 + celular válido", () => {
    expect(insuredContactEligible(insured())).toBe(true);
    expect(insuredContactEligible(insured({ showContactForInsured: false }))).toBe(false);
    expect(insuredContactEligible(insured({ contactConsentAt: null }))).toBe(false);
    expect(insuredContactEligible(insured({ contactConsentVersion: LEAD_CONTACT_CONSENT_VERSION_V1 }))).toBe(false);
    expect(insuredContactEligible(insured({ contactWhatsapp: null }))).toBe(false);
    expect(insuredContactEligible(insured({ contactWhatsapp: "011 4567-8901" }))).toBe(false); // fijo
  });

  it("[CF3-PRP11] links armados con el texto sin PHI; no elegible → null", () => {
    const c = buildInsuredContact({ ...insured(), name: "  Lic. Ana Pérez " });
    expect(c).toEqual({
      ok: true,
      name: "Lic. Ana Pérez",
      waUrl: `https://wa.me/5491123456789?text=${encodeURIComponent(INSURED_CONTACT_MESSAGE)}`,
      telUrl: "tel:+5491123456789",
    });
    expect(INSURED_CONTACT_MESSAGE).toBe("Hola, quería consultar si atendés con mi obra social.");
    expect(buildInsuredContact({ ...insured({ contactConsentVersion: LEAD_CONTACT_CONSENT_VERSION_V1 }), name: "X" })).toBeNull();
  });

  it("[CF3-PRP12] teléfono del consultorio: recortado, vacío → null", () => {
    expect(publicClinicPhone(" 011 4567-8901 ")).toBe("011 4567-8901");
    expect(publicClinicPhone("   ")).toBeNull();
    expect(publicClinicPhone(null)).toBeNull();
  });
});
