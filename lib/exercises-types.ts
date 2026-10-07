import type { ExerciseKind, TagKind } from "@prisma/client";
import { DISCIPLINE_TAG_SLUGS } from "@/lib/plans-constants";

export type ExerciseRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  difficulty: number;
  // Series/reps/tiempo son opcionales (un ejercicio puede ser solo lectura o
  // por tiempo). null = no aplica; el consumidor decide fallback/omisión.
  defaultSets: number | null;
  defaultReps: number | null;
  durationSeconds: number | null;
  equipment: string | null;
  muscleGroups: string | null;
  cues: string | null;
  instructions: string | null;
  videoUrl: string | null;
  kind: ExerciseKind;
  isPrivate: boolean;
  isBasic: boolean;
  isFavourite: boolean;
  conditionsCount: number;
  conditions: { slug: string; name: string; relation: string }[];
};

export type ExerciseFilters = {
  q?: string;
  difficulty?: number;
  muscleGroup?: string;
  equipment?: string;
  conditionSlug?: string;
  /** When true, restrict to exercises the actor has favourited. */
  favouritesOnly?: boolean;
  /** When true, restrict to exercises this tenant created. */
  privateOnly?: boolean;
  /** Filter by kind. When omitted, returns EXERCISE only (the default
   * library). Pass `MANUAL_THERAPY` for the maniobras page, or `"all"`
   * for the unified picker used in session modals. */
  kind?: ExerciseKind | "all";
  /** Planes P2 (S13x): slug de un tag `DISCIPLINE` (`kinesiologia` /
   * `osteopatia`, ver `DISCIPLINE_TAG_SLUGS`). Devuelve los ejercicios con ese
   * tag **o** sin ninguno de los dos (los genéricos sirven para ambas
   * disciplinas). Un slug que no es un tag DISCIPLINE existente no filtra. */
  disciplineSlug?: string;
};

/**
 * Kinds de tag que un consultorio puede crear en la tabla GLOBAL `Tag` (S13x):
 * los que usa la UI de la biblioteca (`ensureTag` → GOAL, auto-tags de
 * `createExercise` → MUSCLE_GROUP / EQUIPMENT). Afuera quedan DISCIPLINE (lo
 * curan M1 / Plataforma: filtra la biblioteca de todos) y los de diagnóstico
 * (ZONE, SYMPTOM, …), que alimentan el wizard de todos los consultorios.
 */
export const TENANT_CREATABLE_TAG_KINDS = ["GOAL", "MUSCLE_GROUP", "EQUIPMENT"] as const satisfies readonly TagKind[];

/**
 * Slugs reservados: los de los tags DISCIPLINE del catálogo global. Si un
 * consultorio creara "Kinesiología" como GOAL antes de M1, el INSERT del tag de
 * disciplina chocaba con el slug; y si ya existe, el upsert sin update lo
 * vincularía como disciplina desde un campo de texto libre.
 */
export function isReservedTagSlug(slug: string): boolean {
  return (Object.values(DISCIPLINE_TAG_SLUGS) as string[]).includes(slug);
}

export type FilterFacets = {
  muscleGroups: string[];
  equipment: string[];
  difficulties: number[];
  conditions: { slug: string; name: string }[];
};
