/**
 * Composer de la historia clínica (FC-3c, §24.7): lógica PURA del chip del turno y de la fecha de la ficha. NEUTRAL:
 * no nombra el modelo de notas (el candidato tiene la MISMA forma que el `ComposerBookingCandidate` de la lectura de
 * la HC, declarada acá en estructural para no importar ese módulo).
 *
 * Fechas: todo pasa por `lib/datetime-ar.ts`. El composer corre en el navegador (reloj del usuario) pero el mismo
 * código corre en el SSR de Vercel (UTC): un `getDate()`/`toISOString().slice(0,10)` del host haría que un turno de las
 * 23:00 AR visto a las 23:30 AR cayera en «mañana» (en UTC ya son las 02:30 del día siguiente) y el chip quedara vacío.
 */
import type { BookingStatus } from "@prisma/client";
import { isoToARLocalInput, toARDateKey } from "@/lib/datetime-ar";

export type HcComposerBookingCandidate = {
  id: string;
  scheduledFor: string;
  serviceName: string | null;
  status: BookingStatus;
  practitionerId: string | null;
  hasLiveNote: boolean;
};

export type PickDefaultComposerBookingInput = {
  candidates: readonly HcComposerBookingCandidate[];
  /** Practitioner del actor (null para roles no clínicos): sus turnos van primero. */
  ownPractitionerId: string | null;
  now: Date;
};

/**
 * Turno que el chip propone al abrir el composer (§24.7 «Chip del turno»):
 *   1. solo los de HOY en día AR y sin ficha viva (un turno con ficha viva ya está «cargado»: proponerlo terminaría
 *      en el rechazo `bookingTaken` de la action);
 *   2. los del propio profesional antes que los de otro (en un consultorio con varios, la Secretaria no carga fichas
 *      y un profesional casi siempre escribe la de SU paciente de recién);
 *   3. dentro del grupo, el más cercano a `now` (el que acaba de atender o está atendiendo); empate → el anterior,
 *      que es el que ya pasó.
 * Sin turno hoy → null («Sin turno»): nunca se adivina uno de ayer, que se puede elegir a mano.
 *
 * Los candidatos ya llegan filtrados por el server (FC-2b: sin cancelados ni ausentes, 30 días atrás → 12 h adelante,
 * ≤20); acá no se vuelve a filtrar por estado a propósito: la regla de qué turno admite ficha es del server.
 */
export function pickDefaultComposerBooking(input: PickDefaultComposerBookingInput): HcComposerBookingCandidate | null {
  const today = toARDateKey(input.now);
  const nowMs = input.now.getTime();
  const todays = input.candidates.filter((c) => !c.hasLiveNote && toARDateKey(c.scheduledFor) === today);
  if (todays.length === 0) return null;
  const own = input.ownPractitionerId ? todays.filter((c) => c.practitionerId === input.ownPractitionerId) : [];
  const pool = own.length > 0 ? own : todays;
  let best: HcComposerBookingCandidate | null = null;
  let bestDist = Infinity;
  let bestAt = Infinity;
  for (const c of pool) {
    const at = new Date(c.scheduledFor).getTime();
    const dist = Math.abs(at - nowMs);
    if (dist < bestDist || (dist === bestDist && at < bestAt)) {
      best = c;
      bestDist = dist;
      bestAt = at;
    }
  }
  return best;
}

const FIVE_MIN_MS = 5 * 60 * 1000;

/**
 * Fecha que propone el formulario (reloj de pared AR «YYYY-MM-DDTHH:mm», contrato de `DateTime24Picker`): la del
 * turno, o «ahora» redondeado HACIA ABAJO a 5 min sin turno (EV2-Z M6: el picker va de a 5 min; hacia abajo para
 * nunca correr la hora al futuro). Es la misma regla que `defaultOccurredAt` del server (EV2-D24).
 */
export function composerOccurredAtLocal(booking: { scheduledFor: string } | null | undefined, now: Date): string {
  if (booking) return isoToARLocalInput(booking.scheduledFor);
  return isoToARLocalInput(new Date(Math.floor(now.getTime() / FIVE_MIN_MS) * FIVE_MIN_MS));
}

/**
 * «La fecha sigue al turno salvo que la hayan tocado» (§24.7, Anexo C [FC-3c]): al cambiar el chip, si el usuario no
 * tocó la fecha se recalcula; si la tocó, se respeta lo que eligió.
 */
export function occurredAtAfterBookingChange(p: {
  touched: boolean;
  current: string;
  booking: { scheduledFor: string } | null;
  now: Date;
}): string {
  return p.touched ? p.current : composerOccurredAtLocal(p.booking, p.now);
}
