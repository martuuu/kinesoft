import { describe, it, expect } from "vitest";
import { resolveBookingCopagoCents, particularQuoteCents } from "@/lib/copago";

// CF3 (D-CF3-1, enmienda AUDIT §5.5): la escalera suma el precio del
// profesional del turno (PractitionerService.priceCents). Es plata que se le
// cobra al paciente: cada rama tiene su test y, además, un barrido que prueba
// que con el precio del profesional en null/undefined el resultado es
// idéntico al de la escalera vieja para TODAS las entradas.

/** Copia literal de la escalera previa a CF3 (c288e5d, lib/copago.ts:16-31). No tocar. */
function legacyResolve(args: {
  bookingOverride: number | null;
  coverageOverride: number | null;
  hasCoverage: boolean;
  insurerCopago: number | null;
  particularCopago: number | null;
  servicePriceCents: number;
}): number {
  if (args.bookingOverride != null) return args.bookingOverride;
  if (args.hasCoverage) {
    if (args.coverageOverride != null) return args.coverageOverride;
    if (args.insurerCopago != null) return args.insurerCopago;
    return args.servicePriceCents; // free-form OS with no configured row
  }
  return args.particularCopago != null ? args.particularCopago : args.servicePriceCents;
}

const base = {
  bookingOverride: null,
  coverageOverride: null,
  hasCoverage: false,
  insurerCopago: null,
  particularCopago: null,
  servicePriceCents: 5000,
};

describe("[CF3-PRK] escalera con precio del profesional", () => {
  it("[CF3-PRK1] el monto del turno gana también sobre el precio del profesional", () => {
    expect(resolveBookingCopagoCents({ ...base, bookingOverride: 1234, practitionerPriceCents: 9000 })).toBe(1234);
    expect(resolveBookingCopagoCents({ ...base, bookingOverride: 0, practitionerPriceCents: 9000 })).toBe(0);
  });

  it("[CF3-PRK2] particular sin cobertura: el precio del profesional gana sobre «Particular» y el servicio", () => {
    expect(
      resolveBookingCopagoCents({ ...base, particularCopago: 2500, practitionerPriceCents: 9000 })
    ).toBe(9000);
    expect(resolveBookingCopagoCents({ ...base, practitionerPriceCents: 0, particularCopago: 2500 })).toBe(0);
  });

  it("[CF3-PRK3] cobertura a la fila «Particular»: precio del profesional antes que el copago de esa fila", () => {
    expect(
      resolveBookingCopagoCents({
        ...base,
        hasCoverage: true,
        insurerIsParticular: true,
        insurerCopago: 0,
        particularCopago: 0,
        practitionerPriceCents: 9000,
      })
    ).toBe(9000);
  });

  it("[CF3-PRK4] cobertura a la fila «Particular»: el copago propio del paciente gana sobre el profesional", () => {
    expect(
      resolveBookingCopagoCents({
        ...base,
        hasCoverage: true,
        insurerIsParticular: true,
        coverageOverride: 300,
        insurerCopago: 0,
        practitionerPriceCents: 9000,
      })
    ).toBe(300);
  });

  it("[CF3-PRK5] OS real sin copago configurado: precio del profesional antes que el del servicio", () => {
    expect(
      resolveBookingCopagoCents({ ...base, hasCoverage: true, insurerIsParticular: false, practitionerPriceCents: 9000 })
    ).toBe(9000);
    // Sin el flag (callers de antes de W2) también es OS real.
    expect(resolveBookingCopagoCents({ ...base, hasCoverage: true, practitionerPriceCents: 9000 })).toBe(9000);
  });

  it("[CF3-PRK6] OS real con copago: manda la OS, no el profesional", () => {
    expect(
      resolveBookingCopagoCents({ ...base, hasCoverage: true, insurerCopago: 800, practitionerPriceCents: 9000 })
    ).toBe(800);
    expect(
      resolveBookingCopagoCents({ ...base, hasCoverage: true, insurerCopago: 0, practitionerPriceCents: 9000 })
    ).toBe(0);
  });

  it("[CF3-PRK7] OS real con copago propio del paciente: gana el copago propio", () => {
    expect(
      resolveBookingCopagoCents({
        ...base,
        hasCoverage: true,
        coverageOverride: 0,
        insurerCopago: 800,
        practitionerPriceCents: 9000,
      })
    ).toBe(0);
  });

  it("[CF3-PRK8] sin precio del profesional (null/undefined): idéntico a la escalera vieja en todo el espacio", () => {
    const nullish = [null, 0, 1234];
    const bools = [true, false];
    let n = 0;
    for (const bookingOverride of nullish)
      for (const coverageOverride of [null, 0, 300])
        for (const hasCoverage of bools)
          for (const insurerCopago of [null, 0, 800])
            for (const particularCopago of [null, 0, 2500])
              for (const servicePriceCents of [0, 5000])
                for (const insurerIsParticular of [undefined, false, true])
                  for (const practitionerPriceCents of [null, undefined]) {
                    const old = { bookingOverride, coverageOverride, hasCoverage, insurerCopago, particularCopago, servicePriceCents };
                    expect(
                      resolveBookingCopagoCents({ ...old, insurerIsParticular, practitionerPriceCents }),
                      JSON.stringify({ ...old, insurerIsParticular, practitionerPriceCents })
                    ).toBe(legacyResolve(old));
                    n++;
                  }
    expect(n).toBe(3 * 3 * 2 * 3 * 3 * 2 * 3 * 2);
  });

  it("[CF3-PRK9] particularQuoteCents: profesional → «Particular» → servicio, con 0 válido", () => {
    expect(particularQuoteCents({ practitionerPriceCents: 9000, particularCopagoCents: 2500, servicePriceCents: 5000 })).toBe(9000);
    expect(particularQuoteCents({ practitionerPriceCents: 0, particularCopagoCents: 2500, servicePriceCents: 5000 })).toBe(0);
    expect(particularQuoteCents({ practitionerPriceCents: null, particularCopagoCents: 2500, servicePriceCents: 5000 })).toBe(2500);
    expect(particularQuoteCents({ practitionerPriceCents: undefined, particularCopagoCents: 0, servicePriceCents: 5000 })).toBe(0);
    expect(particularQuoteCents({ practitionerPriceCents: null, particularCopagoCents: null, servicePriceCents: 5000 })).toBe(5000);
  });

  it("[CF3-PRK10] particularQuoteCents coincide con la escalera para un particular sin overrides", () => {
    for (const practitionerPriceCents of [null, undefined, 0, 9000])
      for (const particularCopagoCents of [null, 0, 2500])
        for (const servicePriceCents of [0, 5000])
          expect(particularQuoteCents({ practitionerPriceCents, particularCopagoCents, servicePriceCents })).toBe(
            resolveBookingCopagoCents({ ...base, practitionerPriceCents, particularCopago: particularCopagoCents, servicePriceCents })
          );
  });
});
