/**
 * Composer de la historia clínica (FC-3c, §24.7): lógica PURA del chip del turno. NEUTRAL: no nombra el modelo de
 * notas (el candidato tiene la MISMA forma que el `ComposerBookingCandidate` de la lectura de la HC, declarada acá en
 * estructural para no importar ese módulo).
 *
 * FC-1b3 deja solo los tipos y la firma; FC-3c implementa `pickDefaultComposerBooking`: el turno de HOY (día AR, vía
 * `lib/datetime-ar.ts`) sin ficha viva, el del propio profesional primero; sin turno hoy → null.
 */
import type { BookingStatus } from "@prisma/client";

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

export function pickDefaultComposerBooking(input: PickDefaultComposerBookingInput): HcComposerBookingCandidate | null {
  void input;
  throw new Error("pickDefaultComposerBooking: no implementado (FC-3c).");
}
