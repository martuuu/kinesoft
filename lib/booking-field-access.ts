/**
 * Qué campos de texto de un turno puede leer/escribir el actor (Planes E1, C8).
 *
 * Puro (sin DB ni `server-only`): lo usan la agenda, el ICS, el alta, el
 * batch, `updateBooking` y el core de turnos, y también la UI para decidir qué
 * inputs mostrar. La barrera real sigue siendo el server.
 *
 * **Un campo se escribe si y solo si se puede leer.** Antes de E1 la lectura
 * (`listAgendaBookings`) ya ocultaba title/description/notes sin
 * `clinical.read`, pero la escritura no miraba nada: la Secretaria con
 * `sharedPatientView` podía pisar campos que ni veía, y el drawer con los
 * campos ocultos (null) llegaba a borrar el diagnóstico. Una sola regla para
 * las dos direcciones evita que vuelvan a divergir.
 *
 * Misma regla que la lectura de `listAgendaBookings` (`lib/bookings.ts`,
 * `showClinical`/`showNotes`), escrita en forma positiva (`=== "full"`) para
 * que el nivel `admin` de PD-13 no habilite nada:
 * - turno CON paciente: los tres campos solo con `clinical.read` y acceso full;
 * - turno guest (sin paciente): title y description solo con `clinical.read`;
 *   las notas quedan, porque en un guest las escribe el staff (son
 *   administrativas). Con paciente, en cambio, la nota puede ser clínica (la
 *   del turnero trae el texto libre del paciente).
 */
import type { PatientAccessLevel } from "@/lib/capabilities";

export type BookingFieldMode = "rw" | "hidden";

export type BookingFieldAccess = {
  title: BookingFieldMode;
  description: BookingFieldMode;
  notes: BookingFieldMode;
};

export function bookingFieldAccess(input: {
  /** `caps.has("clinical.read")` del actor. */
  clinical: boolean;
  /** Acceso del actor al paciente del turno. Se ignora si `hasPatient` es false. */
  access: PatientAccessLevel;
  /** El turno tiene `patientId` (false = guest). */
  hasPatient: boolean;
}): BookingFieldAccess {
  const { clinical, access, hasPatient } = input;
  if (hasPatient) {
    const m: BookingFieldMode = clinical && access === "full" ? "rw" : "hidden";
    return { title: m, description: m, notes: m };
  }
  const m: BookingFieldMode = clinical ? "rw" : "hidden";
  return { title: m, description: m, notes: "rw" };
}
