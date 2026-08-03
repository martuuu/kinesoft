import type { ExerciseKind } from "@prisma/client";

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
};

export type FilterFacets = {
  muscleGroups: string[];
  equipment: string[];
  difficulties: number[];
  conditions: { slug: string; name: string }[];
};
