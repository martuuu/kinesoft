import { describe, expect, it } from "vitest";
import * as W from "@/lib/public-wizard-state";
import type { PublicClinic } from "@/lib/public-booking-types";
import { decideOnlineCharge } from "@/lib/online-charge-logic";
import { particularQuoteCents, resolveBookingCopagoCents } from "@/lib/copago";

// CF3 (§30, D-CF3-1/3/4/5/12) · contratos del turnero (PR-T). El server (PR-P) arma `particularQuotes` con
// `particularQuoteCents` (lib/copago.ts) por (profesional, servicio) y OMITE al profesional con `showPublicPrice=false`.
// Acá se fija lo que el wizard hace con eso; sin el campo (payload viejo) todo queda como antes.

const PART = "PART";
const OS = "OSDE";

function base(over: Partial<PublicClinic> = {}): PublicClinic {
  return {
    slug: "tmp",
    name: "TMP",
    legalName: null,
    palette: "sky",
    practitioners: [
      { id: "A", name: "Lic. Ana", specialty: null, licenseNumber: null, yearsExp: null },
      { id: "B", name: "Lic. Beto", specialty: null, licenseNumber: null, yearsExp: null },
      { id: "H", name: "Lic. Oculto", specialty: null, licenseNumber: null, yearsExp: null },
    ],
    services: [
      { id: "S", name: "Sesión", description: null, durationMin: 45, priceCents: 1_000_000, practitionerId: null, practitionerIds: ["A", "B", "H"] },
    ],
    insurers: [
      { id: PART, name: "Particular", isParticular: true },
      { id: OS, name: "OSDE", isParticular: false },
    ],
    // A cobra $ 15.000, B hereda (Particular $ 8.000), H tiene el precio oculto: no viaja.
    particularQuotes: { A: { S: 1_500_000 }, B: { S: 800_000 } },
    insuredContactAvailable: { A: true, B: false },
    ...over,
  };
}

const withCharge = (over: Partial<NonNullable<PublicClinic["onlinePayment"]>> = {}, clinicOver: Partial<PublicClinic> = {}) =>
  base({
    onlinePayment: {
      mode: "REQUIRED", chargeKind: "COPAGO", fixedCents: null, percentBps: null, cancellationNote: null,
      practitionerIds: ["A", "B", "H"], particularCopagoCents: 800_000, ...over,
    },
    ...clinicOver,
  });

describe("[CF3-PRT1] particularQuoteFor: precio del profesional en el paso de servicio", () => {
  it("[CF3-PRT1] cotización por profesional (cada uno su precio)", () => {
    const c = base();
    expect(W.particularQuoteFor(c, "A", "S")).toBe(1_500_000);
    expect(W.particularQuoteFor(c, "B", "S")).toBe(800_000);
  });

  it("[CF3-PRT2] precio oculto (showPublicPrice=false → ausente del mapa) → null", () => {
    expect(W.particularQuoteFor(base(), "H", "S")).toBeNull();
    expect(W.particularQuoteFor(base(), "A", "OTRO")).toBeNull();
  });

  it("[CF3-PRT3] «cualquier profesional» (D-CF3-4) → null en el paso de servicio", () => {
    expect(W.particularQuoteFor(base(), null, "S")).toBeNull();
  });

  it("[CF3-PRT4] sin `particularQuotes` (payload viejo) = conducta de hoy: el precio del servicio, aun en «cualquiera»", () => {
    const c = base({ particularQuotes: undefined });
    expect(W.particularQuoteFor(c, "A", "S")).toBe(1_000_000);
    expect(W.particularQuoteFor(c, null, "S")).toBe(1_000_000);
    expect(W.particularQuoteFor(c, "A", "NOPE")).toBeNull();
  });
});

describe("[CF3-PRT5] resumen (checkoutPricingFor + checkoutCopyFor) sin cobro online", () => {
  it("[CF3-PRT5] particular: el valor del turno es el del profesional elegido", () => {
    const c = base();
    for (const [pro, cents] of [["A", 1_500_000], ["B", 800_000]] as const) {
      const pricing = W.checkoutPricingFor(c, pro, "S", { insurerId: PART });
      expect(pricing).toEqual({ priceCents: cents });
      const copy = W.checkoutCopyFor({ payment: null, ...pricing });
      expect(copy).toMatchObject({ online: false, totalLabel: "Valor del turno", totalCents: cents, showTotal: true });
      expect(copy.insured).toBeUndefined();
    }
  });

  it("[CF3-PRT6] «cualquier profesional»: en el resumen ya se sabe con quién es y el precio aparece", () => {
    // El wizard en modo «any» setea `practitionerId` con el de `findFirstPublicSlot` antes del resumen.
    expect(W.particularQuoteFor(base(), null, "S")).toBeNull();
    const pricing = W.checkoutPricingFor(base(), "A", "S", undefined);
    expect(W.checkoutCopyFor({ payment: null, ...pricing })).toMatchObject({ totalCents: 1_500_000, showTotal: true });
  });

  it("[CF3-PRT7] precio oculto: sin fila de total (el server no mandó el precio)", () => {
    const pricing = W.checkoutPricingFor(base(), "H", "S", undefined);
    expect(pricing).toEqual({ priceCents: null });
    const copy = W.checkoutCopyFor({ payment: null, ...pricing });
    expect(copy).toMatchObject({ online: false, showTotal: false, note: "Lo pagás en el consultorio." });
  });

  it("[CF3-PRT8] con obra social → variante insured, sin precio; copy con el nombre si hay opt-in", () => {
    for (const cov of [{ insurerId: OS }, { insurerId: null, coverageInsurer: "IOMA" }]) {
      const a = W.checkoutPricingFor(base(), "A", "S", cov);
      expect(a.insured).toEqual({ contactAvailable: true, practitionerName: "Lic. Ana" });
      const copyA = W.checkoutCopyFor({ payment: null, ...a });
      expect(copyA.showTotal).toBe(false);
      expect(copyA.insured).toEqual({
        kind: "insured",
        contactAvailable: true,
        text: "El valor depende de tu cobertura. Consultá con Lic. Ana si tiene convenio con tu obra social y cuánto te cubre.",
      });
      expect(JSON.stringify(copyA)).not.toMatch(/15\.000|10\.000/);
    }
    // Sin opt-in (B false, H ausente): el consultorio.
    for (const pro of ["B", "H"]) {
      const copy = W.checkoutCopyFor({ payment: null, ...W.checkoutPricingFor(base(), pro, "S", { insurerId: OS }) });
      expect(copy.insured).toEqual({ kind: "insured", contactAvailable: false, text: "Consultá tu cobertura con el consultorio." });
      expect(copy.showTotal).toBe(false);
    }
    expect(W.insuredCoverageText(null, true)).toBe("Consultá tu cobertura con el consultorio.");
  });

  it("[CF3-ZF2-8] si la action del contacto falló, el texto del consultorio no nombra al profesional", () => {
    const named = "El valor depende de tu cobertura. Consultá con Lic. Ana si tiene convenio con tu obra social y cuánto te cubre.";
    expect(W.insuredCoverageTextAfterContact("Lic. Ana", true, false)).toBe(named);
    expect(W.insuredCoverageTextAfterContact("Lic. Ana", true, true)).toBe("Consultá tu cobertura con el consultorio.");
    expect(W.insuredCoverageTextAfterContact("Lic. Ana", false, false)).toBe("Consultá tu cobertura con el consultorio.");
    expect(W.insuredCoverageTextAfterContact(null, true, false)).toBe("Consultá tu cobertura con el consultorio.");
  });

  it("[CF3-PRT9] sin `particularQuotes` = hoy: precio del servicio, con OS también y sin variante insured", () => {
    const c = base({ particularQuotes: undefined, insuredContactAvailable: undefined });
    expect(W.checkoutPricingFor(c, "A", "S", { insurerId: OS })).toEqual({ priceCents: 1_000_000 });
    expect(W.checkoutPricingFor(c, "A", "S", undefined)).toEqual({ priceCents: 1_000_000 });
    expect(W.checkoutPricingFor(c, "A", null, undefined)).toEqual({ priceCents: 0 });
  });
});

describe("[CF3-PRT10] cobro online con el precio del profesional (paridad con el server)", () => {
  it("[CF3-PRT10] particular: cotiza con la cotización del profesional, no con Particular", () => {
    const c = withCharge();
    const a = W.wizardOnlinePaymentFor(c, "A", 1_000_000, { insurerId: PART }, "S");
    expect(a).toMatchObject({ quote: { amountCents: 1_500_000, chargeKind: "FULL" }, baseCents: 1_500_000 });
    const copy = W.checkoutCopyFor({ payment: a, ...W.checkoutPricingFor(c, "A", "S", { insurerId: PART }) });
    expect(copy).toMatchObject({ online: true, totalLabel: "Total a pagar", totalCents: 1_500_000, showTotal: true });
    expect(W.quotedForInterstitial(a, copy.online)).toBe(1_500_000);
    // Sin serviceId (llamador viejo) = hoy: Particular.
    expect(W.wizardOnlinePaymentFor(c, "A", 1_000_000, { insurerId: PART })?.quote.amountCents).toBe(800_000);
  });

  it("[CF3-PRT11] precio oculto + cobro online: no promete número y el interstitial muestra el monto siempre (D-CF3-3)", () => {
    const c = withCharge();
    const h = W.wizardOnlinePaymentFor(c, "H", 1_000_000, undefined, "S");
    expect(h).not.toBeNull();
    expect(h!.amountHidden).toBe(true);
    expect(W.paymentAmountText(h!)).toBe("Ves el monto antes de ir a pagar");
    const copy = W.checkoutCopyFor({ payment: h, ...W.checkoutPricingFor(c, "H", "S", undefined) });
    expect(copy).toMatchObject({ online: true, cta: "Pagar y reservar", showTotal: false, split: null });
    expect(copy.note).toMatch(/^Ves el monto antes de ir a pagar\. El pago se hace en Mercado Pago/);
    const q = W.quotedForInterstitial(h, copy.online);
    expect(W.amountDiffers({ next: "checkout", amountCents: 1_200_000 }, q)).toBe(true);
    expect(W.reservesWithoutOnlinePayment(c, "H", undefined, "S")).toBe(false);
  });

  it("[CF3-PRT12] Particular $ 0 pero el profesional cobra: hay pago (antes decía «sin pago online»)", () => {
    const c = withCharge({ particularCopagoCents: 0 });
    expect(W.reservesWithoutOnlinePayment(c, "A", undefined, "S")).toBe(false);
    expect(W.wizardOnlinePaymentFor(c, "A", 1_000_000, undefined, "S")?.quote.amountCents).toBe(1_500_000);
    // El que hereda $ 0: no hay cobro y se avisa.
    const zero = withCharge({ particularCopagoCents: 0 }, { particularQuotes: { A: { S: 1_500_000 }, B: { S: 0 } } });
    expect(W.wizardOnlinePaymentFor(zero, "B", 1_000_000, undefined, "S")).toBeNull();
    expect(W.reservesWithoutOnlinePayment(zero, "B", undefined, "S")).toBe(true);
  });

  it("[CF3-PRT13] con obra social: el cobro sigue sin número (el server cobra el copago de la OS)", () => {
    const c = withCharge();
    const p = W.wizardOnlinePaymentFor(c, "A", 1_000_000, { insurerId: OS }, "S");
    expect(p?.coverageDependent).toBe(true);
    const copy = W.checkoutCopyFor({ payment: p, ...W.checkoutPricingFor(c, "A", "S", { insurerId: OS }) });
    expect(copy).toMatchObject({ online: true, showTotal: false });
    expect(copy.insured?.contactAvailable).toBe(true);
    expect(W.quotedForInterstitial(p, copy.online)).toBe("coverage");
  });

  it("[CF3-PRT14] paridad con decideOnlineCharge sobre la escalera de un particular nuevo, por profesional", () => {
    const policies = [
      { chargeKind: "COPAGO" as const, fixedCents: null, percentBps: null },
      { chargeKind: "FIXED" as const, fixedCents: 300_000, percentBps: null },
      { chargeKind: "PERCENT" as const, fixedCents: null, percentBps: 3000 },
    ];
    const proPrices = [null, 0, 50, 1_500_000];
    const particulars = [null, 0, 800_000];
    const servicePrices = [0, 1_000_000];
    let n = 0;
    for (const pol of policies)
      for (const proPrice of proPrices)
        for (const part of particulars)
          for (const sp of servicePrices) {
            const server = decideOnlineCharge({
              connectMode: "fake",
              policy: { mode: "REQUIRED", ...pol },
              account: { kind: "PRACTITIONER" },
              payNow: undefined,
              copagoCents: resolveBookingCopagoCents({
                bookingOverride: null, coverageOverride: null, hasCoverage: false, insurerCopago: null,
                particularCopago: part, servicePriceCents: sp, practitionerPriceCents: proPrice,
              }),
            });
            const quote = particularQuoteCents({ practitionerPriceCents: proPrice, particularCopagoCents: part, servicePriceCents: sp });
            const c: PublicClinic = {
              ...base({ particularQuotes: { A: { S: quote } } }),
              services: [{ ...base().services[0], priceCents: sp }],
              onlinePayment: { mode: "REQUIRED", ...pol, cancellationNote: null, practitionerIds: ["A"], particularCopagoCents: part },
            };
            const wiz = W.wizardOnlinePaymentFor(c, "A", sp, undefined, "S");
            const tag = JSON.stringify({ pol, proPrice, part, sp });
            if (server.kind === "charge") {
              expect(wiz?.quote, tag).toEqual({ amountCents: server.amountCents, chargeKind: server.chargeKind });
              expect(W.reservesWithoutOnlinePayment(c, "A", undefined, "S"), tag).toBe(false);
            } else {
              expect(wiz, tag).toBeNull();
            }
            n++;
          }
    expect(n).toBe(72);
  });
});

describe("[CF3-PRT15] entryPractitionerHeading (D-CF3-12)", () => {
  it("[CF3-PRT15] entrada por ?pro= válido → «Turnos con {Nombre}»; si no, null", () => {
    expect(W.entryPractitionerHeading(base(), "A")).toBe("Turnos con Lic. Ana");
    expect(W.entryPractitionerHeading(base(), "ZZZ")).toBeNull();
    expect(W.entryPractitionerHeading(base(), null)).toBeNull();
    expect(W.entryPractitionerHeading(base(), "")).toBeNull();
  });
});

describe("[CF3-PRT16] insuredContactAvailableFor", () => {
  it("[CF3-PRT16] solo true explícito; «cualquier profesional» (sin elegido) nunca", () => {
    expect(W.insuredContactAvailableFor(base(), "A")).toBe(true);
    expect(W.insuredContactAvailableFor(base(), "B")).toBe(false);
    expect(W.insuredContactAvailableFor(base(), "H")).toBe(false);
    expect(W.insuredContactAvailableFor(base(), null)).toBe(false);
    expect(W.insuredContactAvailableFor(base({ insuredContactAvailable: undefined }), "A")).toBe(false);
  });
});

// CF3 ZF3 (revisor de UI, B6): obra social + cobro online + `Service.priceCents` 0 (precio oculto o servicio propio sin
// precio). `quoteTurnero(op, 0)` da null y el wizard decía «Lo pagás en el consultorio», pero el server cobra el copago
// de la OS. Ahora el cobro se ofrece sin número y el interstitial muestra el monto real.
describe("[CF3-ZF3-1] obra social con precio del servicio en 0", () => {
  const policies = [
    { chargeKind: "COPAGO" as const, fixedCents: null, percentBps: null },
    { chargeKind: "FIXED" as const, fixedCents: 300_000, percentBps: null },
    { chargeKind: "PERCENT" as const, fixedCents: null, percentBps: 3000 },
  ];

  it("[CF3-ZF3-1a] el cobro sigue online, sin número, y el interstitial va siempre", () => {
    for (const pol of policies) {
      const c = withCharge(pol);
      const p = W.wizardOnlinePaymentFor(c, "A", 0, { insurerId: OS }, "S");
      expect(p?.coverageDependent, pol.chargeKind).toBe(true);
      const copy = W.checkoutCopyFor({ payment: p, ...W.checkoutPricingFor(c, "A", "S", { insurerId: OS }) });
      expect(copy.online, pol.chargeKind).toBe(true);
      expect(copy.cta).toBe("Pagar y reservar");
      expect(copy.note).toContain("depende de tu cobertura");
      expect(copy.note).not.toContain("Lo pagás en el consultorio.");
      expect(W.quotedForInterstitial(p, copy.online)).toBe("coverage");
    }
  });

  it("[CF3-ZF3-1b] paridad: si el server cobra el copago de la OS, el wizard ofrece cobro; política rota → nada", () => {
    for (const pol of policies)
      for (const insurerCopago of [0, 50, 500_000]) {
        const server = decideOnlineCharge({
          connectMode: "fake",
          policy: { mode: "REQUIRED", ...pol },
          account: { kind: "PRACTITIONER" },
          payNow: undefined,
          copagoCents: resolveBookingCopagoCents({
            bookingOverride: null, coverageOverride: null, hasCoverage: true, insurerCopago,
            particularCopago: 800_000, servicePriceCents: 0, practitionerPriceCents: null,
          }),
        });
        const wiz = W.wizardOnlinePaymentFor(withCharge(pol), "A", 0, { insurerId: OS }, "S");
        // El wizard no conoce el copago de la OS: si el server cobra, tiene que haber cobro ofrecido (sin número).
        if (server.kind === "charge") expect(wiz?.coverageDependent, JSON.stringify({ pol, insurerCopago })).toBe(true);
      }
    // Política mal formada: el server nunca cobra; el wizard tampoco lo ofrece.
    expect(W.wizardOnlinePaymentFor(withCharge({ chargeKind: "FIXED", fixedCents: null }), "A", 0, { insurerId: OS }, "S")).toBeNull();
    expect(W.wizardOnlinePaymentFor(withCharge({ chargeKind: "PERCENT", percentBps: 0 }), "A", 0, { insurerId: OS }, "S")).toBeNull();
  });
});
