/**
 * Pure copago resolution — no I/O, no framework. Extracted from
 * `billing-internal.ts` (which is `server-only` + imports prisma) so it can be
 * unit-tested directly (docs/TESTING.md capa 1). `billing-internal` re-exports
 * it, so existing callers are unaffected.
 *
 * Resolve what a patient pays for one turno, in cents, honouring overrides.
 * Precedence (highest first):
 *   1. bookingOverride   — this turno only (Booking.copagoCents)
 *   2. coverageOverride  — this patient's default (Coverage.copagoCents)
 *   3. insurerCopago     — the obra social's configured copago
 *   4. particularCopago  — the tenant's Particular price (uninsured patients)
 *   5. servicePriceCents — last-resort fallback
 * 0 is a valid value at every level (means "charge nothing").
 */
export function resolveBookingCopagoCents(args: {
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
