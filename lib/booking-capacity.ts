/**
 * Booking overlap capacity — pure, framework-free, unit-testable
 * (docs/TESTING.md capa 1).
 *
 * `Service.maxConcurrent` decides how many patients may share a time window:
 *   - null / undefined  → UNLIMITED. Overlaps are the norm — a kinesiólogo
 *     attends several patients in parallel in one franja. Never blocks.
 *   - 1                 → single-occupancy (osteopatía: uno por horario).
 *   - N                 → up to N simultaneous.
 *
 * These are the ONLY two axes of the booking-overlap rule, kept here so the
 * decision is testable without a DB and shared by every create/update/batch
 * path in `lib/bookings.ts` and the public turnero.
 */

/**
 * Given how many existing (non-cancelled, SAME-service) turnos already overlap
 * the new one, would adding one more exceed the service's capacity?
 *
 * Adding the new turno makes the concurrency `overlapCount + 1`, so it is
 * blocked when `overlapCount + 1 > maxConcurrent`, i.e. `overlapCount >=
 * maxConcurrent`. Unlimited (`null`) never blocks.
 */
export function overlapBlocks(
  overlapCount: number,
  maxConcurrent: number | null | undefined
): boolean {
  if (maxConcurrent == null) return false; // unlimited → overlaps allowed freely
  return overlapCount >= maxConcurrent;
}
