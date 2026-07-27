import type {
  PatientCore,
  PatientProgramLite,
  PatientBookingSummary,
  PatientBookingFull,
} from "@/lib/patients-types";
import type { EvaScore } from "@prisma/client";

export type PractitionerOption = { id: string; name: string };

export type InsurerOption = { id: string; name: string };

/**
 * Composite patient prop shape consumed by the views. Built from the
 * initial server payload (`patientCore + programsLite + recentBookings
 * + evaScores`) plus lazy slices fetched on tab activation.
 *
 * `programs[].sessions` come pre-loaded (with `_count.exercises` only —
 * no full Exercise rows) because every tab uses session metadata.
 * `bookings` is replaced with the full list after Facturación opens.
 */
export type PatientWithRelations = PatientCore & {
  programs: PatientProgramLite[];
  bookings: PatientBookingSummary[] | PatientBookingFull[];
  evaScores: EvaScore[];
};

export type Tab =
  | "resumen"
  | "turnos"
  | "sesiones"
  | "plan"
  | "archivos"
  | "antec"
  | "evol"
  | "fact"
  | "actividad";
