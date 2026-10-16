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

/**
 * S24e: lo que necesita la página `/portal/c/[slug]/ejercicios` (resultado de `getPortalExercisesView`). Agregado al
 * contrato de P4-C (no cambia los dos tipos de arriba).
 *   - `signedOut`: sin sesión verificada → la página ofrece entrar;
 *   - `notFound`: sin ficha vinculada en ese consultorio, staff, o el consultorio no tiene `planes` ∧ `ejercicios` →
 *     404. `movedSlug` = slug vigente si el slug es un alias viejo y el paciente SÍ está vinculado allá (308);
 *   - `ok`: `data` puede ser `null` (sin plan activo con ejercicios) → vacío, no error.
 */
export type PortalExercisesView =
  | { kind: "signedOut" }
  | { kind: "notFound"; movedSlug: string | null }
  | { kind: "ok"; tenantName: string; vertical: import("@prisma/client").TenantVertical; data: PortalExercisesDTO };
