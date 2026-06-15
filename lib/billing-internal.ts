import "server-only";

import { prisma } from "@/lib/db";

/**
 * The tenant's "Particular" (out-of-pocket) copago in cents — what a patient
 * WITHOUT an obra social is charged per session. "Particular" is a real
 * per-tenant `Insurer` row (`isParticular = true`); the practitioner sets its
 * price in /configuracion → Obras Sociales.
 *
 * Returns the configured copago **as set, including 0** (0 means "charge
 * nothing" — that's a valid, intentional value). Returns `null` only when the
 * tenant has no Particular row at all; callers then fall back to the service
 * price.
 */
export async function getParticularCopagoCents(tenantId: string): Promise<number | null> {
  const ins = await prisma.insurer.findFirst({
    where: { tenantId, isParticular: true },
    select: { copagoCents: true },
  });
  return ins ? ins.copagoCents : null;
}

/**
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
