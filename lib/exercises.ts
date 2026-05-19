"use server";

/**
 * Exercise library — global catalog, read-only for practitioners.
 *
 * The Biblioteca page consumes `listExercises` (with the supplied filters)
 * and `loadFilterFacets` (for the sidebar). `getExercise` powers the
 * detail modal.
 */
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";

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
  conditionsCount: number;
  conditions: { slug: string; name: string; relation: string }[];
};

export type ExerciseFilters = {
  q?: string;
  difficulty?: number;
  muscleGroup?: string;
  equipment?: string;
  conditionSlug?: string;
};

export async function listExercises(f: ExerciseFilters = {}): Promise<ExerciseRow[]> {
  const q = f.q?.trim();
  const where: Prisma.ExerciseWhereInput = {
    AND: [
      q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { description: { contains: q, mode: "insensitive" } },
              { muscleGroups: { contains: q, mode: "insensitive" } },
            ],
          }
        : {},
      f.difficulty != null ? { difficulty: f.difficulty } : {},
      f.muscleGroup ? { muscleGroups: { contains: f.muscleGroup, mode: "insensitive" } } : {},
      f.equipment ? { equipment: { contains: f.equipment, mode: "insensitive" } } : {},
      f.conditionSlug
        ? { conditions: { some: { condition: { slug: f.conditionSlug } } } }
        : {},
    ],
  };
  const rows = await prisma.exercise.findMany({
    where,
    orderBy: [{ difficulty: "asc" }, { name: "asc" }],
    include: {
      conditions: {
        include: { condition: { select: { slug: true, name: true } } },
        take: 5,
      },
      _count: { select: { conditions: true } },
    },
  });
  return rows.map((e) => ({
    id: e.id,
    slug: e.slug,
    name: e.name,
    description: e.description,
    difficulty: e.difficulty,
    defaultSets: e.defaultSets,
    defaultReps: e.defaultReps,
    equipment: e.equipment,
    muscleGroups: e.muscleGroups,
    cues: e.cues,
    instructions: e.instructions,
    videoUrl: e.videoUrl,
    conditionsCount: e._count.conditions,
    conditions: e.conditions.map((c) => ({
      slug: c.condition.slug,
      name: c.condition.name,
      relation: c.relation,
    })),
  }));
}

export async function getExercise(slug: string) {
  return prisma.exercise.findUnique({
    where: { slug },
    include: {
      conditions: {
        include: { condition: true },
        orderBy: { weight: "desc" },
      },
      tags: { include: { tag: true } },
    },
  });
}

export type FilterFacets = {
  muscleGroups: string[];
  equipment: string[];
  difficulties: number[];
  conditions: { slug: string; name: string }[];
};

export async function loadFilterFacets(): Promise<FilterFacets> {
  const exercises = await prisma.exercise.findMany({
    select: { difficulty: true, muscleGroups: true, equipment: true },
  });
  const muscle = new Set<string>();
  const equip = new Set<string>();
  const diff = new Set<number>();
  for (const e of exercises) {
    if (e.muscleGroups) {
      for (const m of e.muscleGroups.split(",")) {
        const t = m.trim();
        if (t) muscle.add(t);
      }
    }
    if (e.equipment) {
      for (const m of e.equipment.split(",")) {
        const t = m.trim();
        if (t) equip.add(t);
      }
    }
    diff.add(e.difficulty);
  }
  const conditions = await prisma.condition.findMany({
    select: { slug: true, name: true },
    orderBy: { name: "asc" },
  });
  return {
    muscleGroups: Array.from(muscle).sort(),
    equipment: Array.from(equip).sort(),
    difficulties: Array.from(diff).sort(),
    conditions,
  };
}
