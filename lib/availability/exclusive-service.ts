/**
 * «El profesional ya atiende OTRO servicio en ese horario» (CF, §28; decisiones 1 y 2 de Martin del 30-oct) — puro.
 *
 * Predicado ÚNICO para el motor (`classify`/`slots`/`next-free`/`plan`), los write-paths del staff y el turnero, así
 * no pueden decir cosas distintas. Solo aplica con `PractitionerAgendaRules.exclusiveService` (lo decide el caller):
 * con `allowParallelServices` el profesional vuelve a la regla de antes (cupo por servicio solamente).
 *
 * Cuenta igual que el cupo (CF-D5, AUDIT §5.18): no CANCELLED ∧ `isHoldingCapacity` (una reserva pública impaga
 * vencida no retiene; NO_SHOW y COMPLETED sí). Solape SEMIABIERTO: un turno que termina 10:00 no pisa uno que empieza
 * 10:00. El mismo servicio no cuenta acá (lo decide el cupo, `overlapBlocks`).
 *
 * CF-D3: otro servicio del MISMO paciente (no nulo) no cuenta: es el mismo paciente pasando de Evaluación a
 * Kinesiología con el mismo profesional, no dos pacientes a la vez. Un guest (pedido sin paciente) nunca está exento:
 * no sabemos quién es. Solo el staff manda paciente; el turnero al listar no lo conoce.
 */
import { isHoldingCapacity } from "@/lib/booking-capacity";

/** Lo mínimo de un turno no cancelado que hace falta para decidir (subconjunto de `AvailabilityBooking`). */
export type OtherServiceBooking = {
  serviceId: string;
  patientId: string | null;
  scheduledFor: Date;
  durationMin: number;
  status: string;
  paymentStatus: string;
  createdAt: Date;
  idempotencyKey: string;
};

export type OtherServiceQuery = {
  serviceId: string;
  /** null/undefined = guest: sin exención por paciente. */
  patientId?: string | null;
  /** [start, end) del turno pedido. */
  start: Date;
  end: Date;
  now: Date;
};

const MIN_MS = 60_000;

/** Otro servicio ∧ isHoldingCapacity ∧ solape semiabierto ∧ ¬(mismo paciente no nulo, CF-D3). El caller ya filtró profesional y CANCELLED. */
export function isOtherServiceConflict(b: OtherServiceBooking, q: OtherServiceQuery): boolean {
  if (b.serviceId === q.serviceId) return false;
  // El caller ya filtra CANCELLED en la query; se repite porque es gratis y un CANCELLED que se cuele
  // `isHoldingCapacity` lo retendría (su contrato deja ese filtro al caller).
  if (b.status === "CANCELLED") return false;
  if (q.patientId != null && b.patientId === q.patientId) return false;
  const start = b.scheduledFor.getTime();
  if (!(start < q.end.getTime() && start + b.durationMin * MIN_MS > q.start.getTime())) return false;
  return isHoldingCapacity(b, q.now);
}

/** Los turnos del profesional que chocan, en el orden de entrada (el primero da el `otherServiceId` del aviso). */
export function otherServiceConflicts<B extends OtherServiceBooking & { id: string; practitionerId: string }>(
  bookings: ReadonlyArray<B>,
  q: OtherServiceQuery & { practitionerId: string; excludeBookingId?: string | null }
): B[] {
  return bookings.filter(
    (b) =>
      b.practitionerId === q.practitionerId &&
      (q.excludeBookingId == null || b.id !== q.excludeBookingId) &&
      isOtherServiceConflict(b, q)
  );
}
