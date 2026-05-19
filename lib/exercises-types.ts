export type ExerciseRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  difficulty: number;
  defaultSets: number;
  defaultReps: number;
  equipment: string | null;
  muscleGroups: string | null;
  cues: string | null;
  instructions: string | null;
  videoUrl: string | null;
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
};

export type FilterFacets = {
  muscleGroups: string[];
  equipment: string[];
  difficulties: number[];
  conditions: { slug: string; name: string }[];
};
