/**
 * Tipos de `lib/patient-search.ts` (un archivo "use server" exporta solo
 * funciones async: los tipos viven acá).
 */

/**
 * Fila del buscador de pacientes de la agenda (P2-FX1).
 *
 * Exactamente estas 4 claves: es lo que ve cualquier rol que opera turnos
 * (nivel `basic` y `admin`, PD-13). Nada clínico, ni edad, ni plan, ni
 * contacto: el test `patient-search-booking` fija las claves.
 */
export type BookingPatientHit = {
  id: string;
  firstName: string;
  lastName: string;
  documentId: string | null;
};
