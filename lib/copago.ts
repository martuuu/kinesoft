/**
 * Pure copago resolution — no I/O, no framework. Extracted from
 * `billing-internal.ts` (which is `server-only` + imports prisma) so it can be
 * unit-tested directly (docs/TESTING.md capa 1). `billing-internal` re-exports
 * it, so existing callers are unaffected. Fuente única del copago (AUDIT §5.5):
 * no duplicar el cálculo en otro lado.
 *
 * Resolve what a patient pays for one turno, in cents, honouring overrides.
 *
 * Precedencia (D-CF3-1, enmienda §5.5 de CF3, 04-nov):
 *   1. bookingOverride        — this turno only (Booking.copagoCents)
 *   2. Con OS real (hasCoverage && !insurerIsParticular):
 *        coverageOverride → insurerCopago → practitionerPriceCents → servicePriceCents
 *   3. Particular (sin cobertura, o cobertura a la fila «Particular»):
 *        coverageOverride (solo con cobertura) → practitionerPriceCents →
 *        insurerCopago (con cobertura: es el copago de la fila «Particular») →
 *        particularCopago (solo sin cobertura) → servicePriceCents
 * 0 is a valid value at every level (means "charge nothing").
 *
 * POR QUÉ el precio del profesional: feedback de TMP (04-nov) — el Titular y
 * el otro profesional atienden el mismo servicio y cobran distinto. Antes la
 * escalera no recibía al profesional y el particular pagaba el copago de la
 * fila «Particular» (nace en $0) para cualquiera. En la OS real el profesional
 * va DESPUÉS del copago de la OS (lo fija el convenio, no el kine) y solo
 * reemplaza al precio del servicio como último recurso; en el particular va
 * ANTES de «Particular», porque es justamente su arancel.
 *
 * Invariante (testeado por barrido en tests/unit/cf3-copago-ladder.test.ts):
 * con practitionerPriceCents null/undefined el resultado es idéntico al de la
 * escalera previa a CF3 para toda entrada. Por eso, con cobertura a la fila
 * «Particular», `particularCopago` NO se consulta: la escalera vieja con
 * cobertura caía de insurerCopago directo al precio del servicio, y meter
 * `particularCopago` en el medio cambiaría montos ya cotizados.
 */
export function resolveBookingCopagoCents(args: {
  bookingOverride: number | null;
  coverageOverride: number | null;
  hasCoverage: boolean;
  insurerCopago: number | null;
  particularCopago: number | null;
  servicePriceCents: number;
  /** CF3 (D-CF3-1): PractitionerService.priceCents del profesional del turno; null/undefined = hereda (idéntico a hoy). */
  practitionerPriceCents?: number | null;
  /** CF3: la cobertura apunta a la fila «Particular» del consultorio (Insurer.isParticular). */
  insurerIsParticular?: boolean;
}): number {
  if (args.bookingOverride != null) return args.bookingOverride;
  const practitioner = args.practitionerPriceCents ?? null;

  if (args.hasCoverage) {
    if (args.coverageOverride != null) return args.coverageOverride;
    if (args.insurerIsParticular === true) {
      // Cobertura a la fila «Particular»: el arancel del profesional manda
      // sobre el copago de esa fila.
      if (practitioner != null) return practitioner;
      if (args.insurerCopago != null) return args.insurerCopago;
      return args.servicePriceCents;
    }
    // OS real: el copago del convenio manda; el profesional solo reemplaza
    // al precio del servicio (free-form OS with no configured row).
    if (args.insurerCopago != null) return args.insurerCopago;
    if (practitioner != null) return practitioner;
    return args.servicePriceCents;
  }

  return particularQuoteCents({
    practitionerPriceCents: practitioner,
    particularCopagoCents: args.particularCopago,
    servicePriceCents: args.servicePriceCents,
  });
}

/**
 * Lo que paga un paciente particular sin overrides (sin monto del turno ni
 * copago propio): profesional → «Particular» del consultorio → servicio.
 * Lo usan el turnero y la sede para mostrar el precio sin repetir la escalera;
 * es la misma rama que `resolveBookingCopagoCents` sin cobertura.
 */
export function particularQuoteCents(args: {
  practitionerPriceCents?: number | null;
  particularCopagoCents: number | null;
  servicePriceCents: number;
}): number {
  if (args.practitionerPriceCents != null) return args.practitionerPriceCents;
  if (args.particularCopagoCents != null) return args.particularCopagoCents;
  return args.servicePriceCents;
}
