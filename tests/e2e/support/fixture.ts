import { readFileSync } from "node:fs";
import { E2E_FIXTURE_FILE } from "./e2e-constants.mjs";

/** Lo que el global-setup dejó armado en el Docker local para esta corrida (ids reales del tenant efímero). */
export type E2EFixture = {
  tenantId: string;
  slug: string;
  owner: { id: string; email: string; password: string; fullName: string };
  practitionerId: string;
  serviceId: string;
  serviceName: string;
  locationId: string;
  /** Paciente con teléfono (turnos, Recepción, cobro, WhatsApp). */
  patient: { id: string; firstName: string; lastName: string; phone: string };
  /** Paciente para la ficha/evolución. */
  chartPatient: { id: string; firstName: string; lastName: string };
  /** Paciente para el plan de tratamiento. */
  planPatient: { id: string; firstName: string; lastName: string };
  /** Servicio con `maxConcurrent: 1` (el de la factory es ilimitado y no da conflicto). */
  cappedService: { id: string; name: string };
  conflictPatient: Person;
  /** Hoy en Argentina (YYYY-MM-DD) y el turno de Lucía de hoy a las 18:00 (Recepción, WhatsApp). */
  today: string;
  todayBookingId: string;
  /** Turno de mañana 09:00 AR para reprogramar. */
  movePatient: Person;
  moveDay: string;
  moveBookingId: string;
  /** Turno confirmado de ayer con copago sin cobrar. */
  payPatient: Person;
  payBookingId: string;
  /** Evolución de hace 3 días de `chartPatient` (fuera de la ventana de edición → enmienda). */
  oldNoteId: string;
  /** Usuaria del portal (sin Membership), vinculada por `Patient.userId`, con un turno de mañana. */
  portal: { userId: string; email: string; password: string; patientId: string; bookingAt: string };
};

type Person = { id: string; firstName: string; lastName: string };

export function readFixture(): E2EFixture {
  return JSON.parse(readFileSync(E2E_FIXTURE_FILE, "utf8")) as E2EFixture;
}
