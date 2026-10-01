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

/**
 * Cuánto sostiene el cupo una reserva pública impaga (decisión del dueño,
 * 30-sep): pasado este plazo deja de contar para la disponibilidad y se ve como
 * "Pendiente de pago · vencida". Sin cron ni migración: se aplica al calcular.
 */
export const PENDING_PUBLIC_HOLD_MS = 30 * 60_000;

/**
 * Formato de key de la reserva pública ACTUAL (A2b-S-pub):
 * `pub:<tenantId>:<uuid del wizard>` — exactamente dos `:`.
 */
const PUBLIC_KEY_RE = /^pub:[^:]+:[^:]+$/;
/**
 * Formato de key de la reserva pública PRE-A2 (la que ya está en prod):
 * `<tenantId>:<practitionerId>:<ISO del turno>:<patientId>` (a550972). El
 * último segmento tiene que ser el `patientId` de la fila.
 */
const LEGACY_PUBLIC_KEY_RE = /^[^:]+:[^:]+:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z:([^:]+)$/;

/**
 * ¿Esta fila la creó el turnero público? Se decide por la `idempotencyKey`,
 * que ningún write de la recepción puede imitar:
 *   - agenda (createBooking): UUID del modal o 32 hex al azar, sin `:`; una key
 *     de cliente con prefijo `pub:` se descarta (lib/bookings.ts), y además
 *     `pub:<cuid>:<uuid>` no entra en el tope de 64 caracteres;
 *   - batch: `<base>:<ISO>` — termina en la fecha, nunca en un patientId, y
 *     tiene más de dos `:`;
 *   - agenda PRE-af74e2c: usaba el MISMO formato determinístico que la pública
 *     vieja (`tenant:prof:ISO:identity`). Con paciente nacía CONFIRMED y la
 *     agenda no vuelve un turno a PENDING (BookingUpdate ya no lo acepta), así
 *     que solo podría confundirse una fila que alguien pasó a PENDING a mano
 *     antes de A2: el precheck de prod lo cuenta (ver reporte de A2-fix). Con
 *     guest la identity es el email/teléfono, no un patientId → no matchea.
 * Exige además paciente: la reserva pública siempre crea o vincula ficha (H4).
 */
export function isPublicReservation(b: {
  idempotencyKey: string;
  patientId: string | null;
}): boolean {
  if (b.patientId == null) return false;
  if (PUBLIC_KEY_RE.test(b.idempotencyKey)) return true;
  const legacy = LEGACY_PUBLIC_KEY_RE.exec(b.idempotencyKey);
  return legacy != null && legacy[1] === b.patientId;
}

/**
 * ¿Este turno (no cancelado) sigue ocupando cupo en `now`?
 *
 * Contrato (lo consumen create/update/batch/suggestNextFreeSlot de
 * `lib/bookings.ts`, el turnero público y el webhook de MP; el caller ya
 * filtró `status != CANCELLED` en la query y trae `idempotencyKey` en el select):
 *   - Deja de contar SOLO la reserva pública impaga y vencida:
 *     `isPublicReservation` (por la key, ver arriba) && `status === "PENDING"`
 *     && `paymentStatus ∈ {UNPAID, FAILED}` && `createdAt` quedó hace MÁS de
 *     30 min (`now - createdAt > 30 min`; exactamente 30 min todavía sostiene).
 *   - Todo lo demás sostiene el cupo, incluido un CANCELLED que llegara igual
 *     (ese filtro es del caller, no de acá).
 *
 * Por qué la key y no solo `patientId != null` (fix de la revisión de A2):
 * el turno GUEST de la recepción también nace PENDING/UNPAID, y bastaba
 * asignarle paciente desde el drawer (o destildar el copago de un PENDING viejo)
 * para que quedara idéntico a una reserva pública: dejaba de contar para el
 * cupo y se rotulaba "vencida". Ante la duda el predicado RETIENE: una key
 * desconocida nunca libera cupo.
 *
 * FAILED cuenta igual que UNPAID (A2b): una tarjeta rechazada deja el turno
 * PENDING/FAILED y, si solo venciera UNPAID, retenía el cupo para siempre.
 *
 * Puro y sin reloj propio: `now` lo pasa el caller (tests en TZ=UTC).
 */
export function isHoldingCapacity(
  b: {
    status: string;
    paymentStatus: string;
    createdAt: Date;
    patientId: string | null;
    idempotencyKey: string;
  },
  now: Date
): boolean {
  return !publicHoldExpired({ ...b, publicReservation: isPublicReservation(b) }, now);
}

/**
 * ¿Es una reserva pública todavía impaga (PENDING + UNPAID/FAILED)? La mitad
 * "sin reloj" de `isHoldingCapacity`, con el discriminante ya resuelto
 * (`publicReservation`): la agenda la usa para rotular sin recibir la key.
 */
export function isUnpaidPublicPending(b: {
  status: string;
  paymentStatus: string;
  publicReservation: boolean;
}): boolean {
  return (
    b.publicReservation &&
    b.status === "PENDING" &&
    (b.paymentStatus === "UNPAID" || b.paymentStatus === "FAILED")
  );
}

/** Reserva pública impaga cuyo plazo de 30 min ya pasó (no retiene cupo). */
export function publicHoldExpired(
  b: { status: string; paymentStatus: string; publicReservation: boolean; createdAt: Date },
  now: Date
): boolean {
  return isUnpaidPublicPending(b) && now.getTime() - b.createdAt.getTime() > PENDING_PUBLIC_HOLD_MS;
}
