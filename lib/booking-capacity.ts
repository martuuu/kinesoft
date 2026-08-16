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

export type PatientDayStatus = "overlap" | "same-day" | null;

/**
 * Patient-level guard for a NEW turno — orthogonal to the professional's
 * capacity (`overlapBlocks`). A patient can't be in two places at once, and a
 * *second* turno the same day is intentional but worth a confirmation.
 *
 * Given the patient's OTHER non-cancelled turnos on the SAME AR day (across all
 * professionals) and the new turno's `[newStart, newEnd)` window:
 *   - "overlap"  → the new turno overlaps one the patient already has → hard stop.
 *   - "same-day" → they share the day but none overlaps → soft confirm.
 *   - null       → no other turno that day → create freely.
 *
 * Pure so the rule is unit-testable without a DB (docs/TESTING.md capa 1); the
 * caller owns the day-window query + the "exclude the row being edited" filter.
 */
export function patientDayStatus(
  sameDayTurnos: ReadonlyArray<{ scheduledFor: Date; durationMin: number }>,
  newStart: Date,
  newEnd: Date
): PatientDayStatus {
  if (sameDayTurnos.length === 0) return null;
  const overlaps = sameDayTurnos.some(
    (t) =>
      t.scheduledFor < newEnd &&
      new Date(t.scheduledFor.getTime() + t.durationMin * 60_000) > newStart
  );
  return overlaps ? "overlap" : "same-day";
}
