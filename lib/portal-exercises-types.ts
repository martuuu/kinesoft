/**
 * P4-C (ES4, brief §3.5): DTO de «Ejercicios» del portal (sección gateada por `planes` ∧ `ejercicios`, ver
 * `lib/portal-nav.ts`). Tipos puros. Solo lo que el paciente necesita para hacer el ejercicio en su casa: nada de notas
 * del profesional ni datos del plan más allá del título.
 */
export type PortalExerciseDTO = {
  name: string;
  sets: number;
  reps: number;
  durationSeconds: number | null;
  instructions: string | null;
  media: { kind: "image" | "video" | "youtube"; url: string } | null;
};

/** `null` = no hay plan activo con ejercicios (la página muestra el vacío, no un error). */
export type PortalExercisesDTO = {
  programTitle: string;
  sessions: { index: number; /** ISO 8601. */ date: string; exercises: PortalExerciseDTO[] }[];
} | null;
