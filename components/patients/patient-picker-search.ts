/**
 * Qué action usa el `PatientPicker` según para qué elige paciente (P2-FX1).
 *
 * Vive fuera del .tsx para testear el despacho real contra la DB (el bug era
 * justamente el despacho: la agenda llamaba a la búsqueda del Plan Builder).
 *
 *  - `"booking"` (default, agenda: modal y drawer de turnos) →
 *    `searchPatientsForBooking`: nombre + DNI, cualquier rol que opere turnos,
 *    todas las verticales.
 *  - `"assignment"` (Planes/Diagnóstico) → `searchPatientsForAssignment` con
 *    `requireFull: true`: solo pacientes con acceso `full` y módulo
 *    `diagnostico` (H-b4 / S17d), porque asignar un plan exige `full`.
 */
import { searchPatientsForBooking } from "@/lib/patient-search";
import { searchPatientsForAssignment } from "@/lib/diagnosis";

export type PatientPickerSource = "booking" | "assignment";

/** Fila que pinta el dropdown: nombre + una etiqueta secundaria (DNI / HC). */
export type PatientPickerHit = { id: string; name: string; hc: string };

export async function searchForPicker(
  source: PatientPickerSource,
  term: string
): Promise<PatientPickerHit[]> {
  if (source === "assignment") {
    const r = await searchPatientsForAssignment(term, { requireFull: true });
    return r.map((p) => ({ id: p.id, name: p.name, hc: p.hc ?? "" }));
  }
  // La búsqueda de la agenda exige término (zod 1..80): con vacío no se llama.
  if (!term.trim()) return [];
  const r = await searchPatientsForBooking(term);
  return r.map((p) => ({
    id: p.id,
    name: `${p.firstName} ${p.lastName}`,
    hc: p.documentId ? `DNI ${p.documentId}` : "",
  }));
}
