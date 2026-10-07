import type {
  PatientCore,
  PatientBookingSummary,
  PatientBookingFull,
} from "@/lib/patients-types";
import type { EvaScore } from "@prisma/client";

export type PractitionerOption = { id: string; name: string };

/**
 * `payerId` (B1, catálogo): prestadora del catálogo global vinculada a la OS
 * del consultorio. Con prestadora, el plan de la ficha se elige de sus planes
 * (`listPayerPlans`); sin ella, el plan sigue siendo texto libre.
 */
export type InsurerOption = { id: string; name: string; payerId?: string | null };

/**
 * Composite patient prop shape consumed by the views. Built from the
 * initial server payload (`patientCore + recentBookings + evaScores`) plus
 * lazy slices fetched on tab activation. `bookings` is replaced with the
 * full list after Turnos/Facturación opens.
 *
 * S22b (ES3): ya no lleva `programs` (`PatientProgramLite[]` de
 * `getPatientProgramsLite`). Los planes viajan aparte, como `PlanDTO[]` de
 * `getPatientPlans` (S14), en las props de cada vista (`PlanViewProps`,
 * `SesionesViewProps`, `ResumenViewProps`, `PatientHeroProps` de
 * `components/planes/plan-editor-types.ts`). Así el título del plan, las notas
 * y la autorización de la OS solo existen donde el server los proyectó para
 * ese actor, y no hay dos fuentes de "los planes del paciente" en el perfil.
 */
export type PatientWithRelations = PatientCore & {
  bookings: PatientBookingSummary[] | PatientBookingFull[];
  evaScores: EvaScore[];
};

/**
 * Pestañas del perfil. S22b: `plan` → `planes` (C10: `?tab=planes`, con el
 * alias `plan` resuelto por `normalizeProfileTab` de `lib/plans-deeplink.ts`).
 * Las que dependen de un módulo se filtran con `isProfileTabAllowed`
 * (`lib/tenant-modules.ts`).
 */
export type Tab =
  | "resumen"
  | "turnos"
  | "sesiones"
  | "planes"
  | "archivos"
  | "antec"
  | "evol"
  | "fact"
  | "actividad";

/** Todas, en el orden de la barra. */
export const PROFILE_TABS: readonly Tab[] = [
  "resumen",
  "turnos",
  "sesiones",
  "planes",
  "archivos",
  "antec",
  "evol",
  "fact",
  "actividad",
];
