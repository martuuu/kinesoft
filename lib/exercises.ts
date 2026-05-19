"use server";

/**
 * Exercise library — global catalog with practitioner-create support.
 *
 * Reads (`listExercises`, `getExercise`, `loadFilterFacets`) plus
 * mutations: `createExercise` for new custom exercises and `ensureTag`
 * for the tag-combobox create-on-the-fly flow.
 */
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { Prisma, TagKind } from "@prisma/client";
import { getActor } from "@/lib/session";
import { audit } from "@/lib/audit";
import { gatingForActor } from "@/lib/plan-gating";
import type { ActionResult } from "@/lib/validation";

import type {
  ExerciseRow,
  ExerciseFilters,
  FilterFacets,
} from "@/lib/exercises-types";

export async function listExercises(f: ExerciseFilters = {}): Promise<ExerciseRow[]> {
  const actor = await getActor();
  const gate = await gatingForActor();
  const q = f.q?.trim();

  const where: Prisma.ExerciseWhereInput = {
    AND: [
      gate.visibility,
      q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { description: { contains: q, mode: "insensitive" } },
              { muscleGroups: { contains: q, mode: "insensitive" } },
              { tags: { some: { tag: { label: { contains: q, mode: "insensitive" } } } } },
            ],
          }
        : {},
      f.difficulty != null ? { difficulty: f.difficulty } : {},
      f.muscleGroup ? { muscleGroups: { contains: f.muscleGroup, mode: "insensitive" } } : {},
      f.equipment ? { equipment: { contains: f.equipment, mode: "insensitive" } } : {},
      f.conditionSlug
        ? { conditions: { some: { condition: { slug: f.conditionSlug } } } }
        : {},
      f.privateOnly ? { tenantId: actor.tenantId } : {},
      f.favouritesOnly && actor.userId
        ? { favorites: { some: { userId: actor.userId, tenantId: actor.tenantId } } }
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
      favorites: actor.userId
        ? { where: { userId: actor.userId }, select: { id: true }, take: 1 }
        : false,
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
    isPrivate: e.tenantId === actor.tenantId,
    isBasic: e.isBasic,
    isFavourite: Array.isArray(e.favorites) ? e.favorites.length > 0 : false,
    conditionsCount: e._count.conditions,
    conditions: e.conditions.map((c) => ({
      slug: c.condition.slug,
      name: c.condition.name,
      relation: c.relation,
    })),
  }));
}

export async function getExercise(slug: string) {
  const gate = await gatingForActor();
  return prisma.exercise.findFirst({
    where: { AND: [{ slug }, gate.visibility] },
    include: {
      conditions: {
        include: { condition: true },
        orderBy: { weight: "desc" },
      },
      tags: { include: { tag: true } },
    },
  });
}

export async function loadFilterFacets(): Promise<FilterFacets> {
  const gate = await gatingForActor();
  const exercises = await prisma.exercise.findMany({
    where: gate.visibility,
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

// ──────────────────────────────────────────────────────────────────────
// Practitioner CRUD — custom exercises + on-the-fly tags
// ──────────────────────────────────────────────────────────────────────

function slugify(s: string) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

/**
 * Ensure a tag exists by label; returns the canonical slug + label.
 * Used by the TagCombobox's "create new" affordance.
 *
 * Requires an authenticated actor — the global `Tag` table is shared
 * across tenants, so anonymous callers could otherwise pre-empt arbitrary
 * slugs and pollute the catalog.
 */
export async function ensureTag(
  label: string,
  kind: TagKind = "GOAL"
): Promise<{ slug: string; label: string }> {
  await getActor(); // auth gate — throws if no session
  const trimmed = label.trim();
  if (!trimmed) throw new Error("Tag label empty");
  const slug = slugify(trimmed);
  const row = await prisma.tag.upsert({
    where: { slug },
    create: { slug, label: trimmed, kind },
    update: {},
    select: { slug: true, label: true },
  });
  return row;
}

export async function listAllTags(): Promise<{ slug: string; label: string }[]> {
  await getActor();
  const rows = await prisma.tag.findMany({
    orderBy: [{ kind: "asc" }, { label: "asc" }],
    select: { slug: true, label: true },
  });
  return rows;
}

export async function createExercise(input: {
  name: string;
  description?: string;
  difficulty?: number;
  defaultSets?: number;
  defaultReps?: number;
  equipment?: string;
  muscleGroups?: string;
  cues?: string;
  instructions?: string;
  tagSlugs?: string[];
  /** `private` = visible only to this tenant. Custom-created exercises
   * default to `private`. */
  visibility?: "private";
}): Promise<ActionResult<{ id: string; slug: string }>> {
  const actor = await getActor();
  const name = input.name.trim();
  if (!name) return { ok: false, error: "Nombre requerido." };

  const baseSlug = slugify(name);
  // Append a short suffix until unique.
  let slug = baseSlug;
  for (let i = 1; i < 50; i++) {
    const taken = await prisma.exercise.findUnique({ where: { slug }, select: { id: true } });
    if (!taken) break;
    slug = `${baseSlug}-${i}`;
  }

  try {
    const ex = await prisma.exercise.create({
      data: {
        slug,
        name,
        description: input.description?.trim() || null,
        difficulty: Math.min(5, Math.max(1, input.difficulty ?? 1)),
        defaultSets: Math.min(10, Math.max(1, input.defaultSets ?? 3)),
        defaultReps: Math.min(100, Math.max(1, input.defaultReps ?? 12)),
        equipment: input.equipment?.trim() || null,
        muscleGroups: input.muscleGroups?.trim() || null,
        cues: input.cues?.trim() || null,
        instructions: input.instructions?.trim() || null,
        // Practitioner-authored exercises always belong to their tenant
        // — the global catalog is curated centrally.
        tenantId: actor.tenantId,
        createdById: actor.userId ?? null,
        tags: input.tagSlugs?.length
          ? {
              create: input.tagSlugs.map((slug) => ({
                tag: { connect: { slug } },
              })),
            }
          : undefined,
      },
    });
    await audit({
      tenantId: actor.tenantId,
      actorId: actor.userId ?? undefined,
      action: "exercise.create",
      entity: "Exercise",
      entityId: ex.id,
      payload: { name },
    });
    revalidatePath("/biblioteca");
    return { ok: true, data: { id: ex.id, slug: ex.slug } };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, error: "Ya existe un ejercicio con ese nombre." };
    }
    return { ok: false, error: "No pudimos crear el ejercicio." };
  }
}
