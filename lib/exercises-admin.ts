"use server";

/**
 * Global exercise catalog authoring — platform superadmin only.
 *
 * Every mutation here targets the GLOBAL catalog (`tenantId: null`) and runs
 * through `prismaService` (BYPASSRLS): the RLS-forced app role physically can't
 * write `tenantId IS NULL` rows, so `requireSuperAdmin()` is the single
 * enforcement chokepoint. Tenant-private custom exercises keep going through
 * `createExercise` in lib/exercises.ts (app role, runWithRls).
 */
import { revalidatePath, revalidateTag } from "next/cache";
import { Prisma } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { requireSuperAdmin } from "@/lib/session";
import { audit } from "@/lib/audit";
import { tags as cacheTags } from "@/lib/cache-tags";
import {
  ExerciseAdminCreate,
  ExerciseAdminUpdate,
  ExerciseArticleUpsert,
  type ActionResult,
} from "@/lib/validation";
import { slugify, setExerciseTags, freeTextFromTags } from "@/lib/catalog-tags";

export type GlobalExerciseAdminRow = {
  id: string;
  slug: string;
  name: string;
  kind: "EXERCISE" | "MANUAL_THERAPY";
  difficulty: number;
  isBasic: boolean;
  archived: boolean;
  defaultSets: number | null;
  defaultReps: number | null;
  durationSeconds: number | null;
  tags: { slug: string; label: string; kind: string }[];
  mediaCount: number;
  hasArticle: boolean;
};

/** List the GLOBAL catalog for the Plataforma admin (all rows, incl. archived
 *  when asked). Superadmin only. */
export async function listGlobalExercisesForAdmin(opts?: {
  includeArchived?: boolean;
  kind?: "EXERCISE" | "MANUAL_THERAPY";
}): Promise<GlobalExerciseAdminRow[]> {
  await requireSuperAdmin();
  const rows = await prismaService.exercise.findMany({
    where: {
      tenantId: null,
      ...(opts?.kind ? { kind: opts.kind } : {}),
      ...(opts?.includeArchived ? {} : { archivedAt: null }),
    },
    orderBy: [{ archivedAt: "asc" }, { kind: "asc" }, { name: "asc" }],
    select: {
      id: true, slug: true, name: true, kind: true, difficulty: true, isBasic: true,
      archivedAt: true, defaultSets: true, defaultReps: true, durationSeconds: true,
      tags: { select: { tag: { select: { slug: true, label: true, kind: true } } } },
      _count: { select: { media: true } },
      article: { select: { id: true } },
    },
  });
  return rows.map((e) => ({
    id: e.id, slug: e.slug, name: e.name, kind: e.kind, difficulty: e.difficulty,
    isBasic: e.isBasic, archived: e.archivedAt != null,
    defaultSets: e.defaultSets, defaultReps: e.defaultReps, durationSeconds: e.durationSeconds,
    tags: e.tags.map((t) => ({ slug: t.tag.slug, label: t.tag.label, kind: t.tag.kind })),
    mediaCount: e._count.media, hasArticle: e.article != null,
  }));
}

/** Full global exercise (incl. tags, media, article) for the admin editor. */
export async function getGlobalExerciseForAdmin(id: string) {
  await requireSuperAdmin();
  return prismaService.exercise.findFirst({
    where: { id, tenantId: null },
    include: {
      tags: { include: { tag: true } },
      media: { orderBy: { order: "asc" } },
      article: true,
    },
  });
}

/** Invalidate every cached catalog read (getExercise + facets carry the global
 *  `catalog()` tag) and re-render the catalog surfaces. */
function revalidateCatalog() {
  revalidatePath("/biblioteca");
  revalidatePath("/terapia-manual");
  revalidatePath("/plataforma/ejercicios");
  revalidateTag(cacheTags.catalog());
}

async function uniqueGlobalSlug(name: string): Promise<string> {
  const base = slugify(name) || "ejercicio";
  let slug = base;
  for (let i = 1; i < 100; i++) {
    const taken = await prismaService.exercise.findUnique({ where: { slug }, select: { id: true } });
    if (!taken) break;
    slug = `${base}-${i}`;
  }
  return slug;
}

export async function createGlobalExercise(
  raw: unknown,
): Promise<ActionResult<{ id: string; slug: string }>> {
  const actor = await requireSuperAdmin();
  const parsed = ExerciseAdminCreate.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Datos inválidos", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const d = parsed.data;
  const slug = await uniqueGlobalSlug(d.name);
  const tagSlugs = d.tagSlugs ?? [];
  const freeText = await freeTextFromTags(tagSlugs);

  try {
    const ex = await prismaService.exercise.create({
      data: {
        slug,
        name: d.name,
        kind: d.kind,
        description: d.description ?? null,
        difficulty: d.difficulty,
        defaultSets: d.defaultSets ?? null,
        defaultReps: d.defaultReps ?? null,
        durationSeconds: d.durationSeconds ?? null,
        instructions: d.instructions ?? null,
        cues: d.cues ?? null,
        // Deprecated free-text kept as a denormalized cache for the cards.
        muscleGroups: freeText.muscleGroups,
        equipment: freeText.equipment,
        isBasic: d.isBasic ?? false,
        tenantId: null, // global catalog
        createdById: actor.userId,
      },
      select: { id: true, slug: true },
    });
    if (tagSlugs.length) await setExerciseTags(ex.id, tagSlugs);
    await audit({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: "admin.exercise.create",
      entity: "Exercise",
      entityId: ex.id,
      payload: { name: d.name, kind: d.kind },
    });
    revalidateCatalog();
    return { ok: true, data: ex };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, error: "Ya existe un ejercicio con ese slug." };
    }
    return { ok: false, error: "No pudimos crear el ejercicio." };
  }
}

export async function updateGlobalExercise(raw: unknown): Promise<ActionResult> {
  const actor = await requireSuperAdmin();
  const parsed = ExerciseAdminUpdate.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Datos inválidos", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const { id, tagSlugs, ...d } = parsed.data;
  const existing = await prismaService.exercise.findFirst({
    where: { id, tenantId: null },
    select: { id: true },
  });
  if (!existing) return { ok: false, error: "Ejercicio global no encontrado." };

  // Only set fields that were provided (partial update); undefined = leave as is.
  const data: Prisma.ExerciseUpdateInput = {};
  if (d.name !== undefined) data.name = d.name;
  if (d.kind !== undefined) data.kind = d.kind;
  if (d.description !== undefined) data.description = d.description ?? null;
  if (d.difficulty !== undefined) data.difficulty = d.difficulty;
  if (d.defaultSets !== undefined) data.defaultSets = d.defaultSets ?? null;
  if (d.defaultReps !== undefined) data.defaultReps = d.defaultReps ?? null;
  if (d.durationSeconds !== undefined) data.durationSeconds = d.durationSeconds ?? null;
  if (d.instructions !== undefined) data.instructions = d.instructions ?? null;
  if (d.cues !== undefined) data.cues = d.cues ?? null;
  if (d.isBasic !== undefined) data.isBasic = d.isBasic;

  if (tagSlugs !== undefined) {
    await setExerciseTags(id, tagSlugs);
    const freeText = await freeTextFromTags(tagSlugs);
    data.muscleGroups = freeText.muscleGroups;
    data.equipment = freeText.equipment;
  }

  await prismaService.exercise.update({ where: { id }, data });
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    action: "admin.exercise.update",
    entity: "Exercise",
    entityId: id,
  });
  revalidateCatalog();
  return { ok: true, data: undefined };
}

async function setArchived(id: string, archived: boolean): Promise<ActionResult> {
  const actor = await requireSuperAdmin();
  const existing = await prismaService.exercise.findFirst({
    where: { id, tenantId: null },
    select: { id: true },
  });
  if (!existing) return { ok: false, error: "Ejercicio global no encontrado." };
  await prismaService.exercise.update({
    where: { id },
    data: { archivedAt: archived ? new Date() : null },
  });
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    action: archived ? "admin.exercise.archive" : "admin.exercise.restore",
    entity: "Exercise",
    entityId: id,
  });
  revalidateCatalog();
  return { ok: true, data: undefined };
}

export async function archiveGlobalExercise(id: string): Promise<ActionResult> {
  return setArchived(id, true);
}

export async function restoreGlobalExercise(id: string): Promise<ActionResult> {
  return setArchived(id, false);
}

/**
 * Hard delete — only when nothing historical references the exercise. Sessions
 * (PHI plans) and condition links must never be cascade-destroyed, so we refuse
 * and point the caller at archive instead. Favourites / tags / media / article
 * cascade away safely.
 */
export async function hardDeleteGlobalExercise(id: string): Promise<ActionResult> {
  const actor = await requireSuperAdmin();
  const existing = await prismaService.exercise.findFirst({
    where: { id, tenantId: null },
    select: { id: true },
  });
  if (!existing) return { ok: false, error: "Ejercicio global no encontrado." };
  const [sessions, links] = await Promise.all([
    prismaService.sessionExercise.count({ where: { exerciseId: id } }),
    prismaService.conditionExerciseLink.count({ where: { exerciseId: id } }),
  ]);
  if (sessions > 0 || links > 0) {
    return {
      ok: false,
      error:
        "No se puede borrar: está usado en planes o diagnósticos. Archivalo en su lugar (queda oculto pero preserva el historial).",
    };
  }
  await prismaService.exercise.delete({ where: { id } });
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    action: "admin.exercise.delete",
    entity: "Exercise",
    entityId: id,
  });
  revalidateCatalog();
  return { ok: true, data: undefined };
}

/** Create/update the long-form "Ejercicio completo" article (1:1). */
export async function upsertExerciseArticle(raw: unknown): Promise<ActionResult> {
  const actor = await requireSuperAdmin();
  const parsed = ExerciseArticleUpsert.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Datos inválidos", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const { exerciseId, ...d } = parsed.data;
  const ex = await prismaService.exercise.findFirst({
    where: { id: exerciseId, tenantId: null },
    select: { id: true, slug: true },
  });
  if (!ex) return { ok: false, error: "Ejercicio global no encontrado." };

  const fields = {
    title: d.title ?? null,
    subtitle: d.subtitle ?? null,
    focus: d.focus ?? null,
    readingMinutes: d.readingMinutes ?? null,
    bodyMarkdown: d.bodyMarkdown ?? null,
    references: d.references ?? null,
  };
  await prismaService.exerciseArticle.upsert({
    where: { exerciseId },
    create: { exerciseId, ...fields },
    update: fields,
  });
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    action: "admin.exercise.article",
    entity: "Exercise",
    entityId: exerciseId,
  });
  revalidatePath(`/biblioteca/${ex.slug}`);
  revalidateCatalog();
  return { ok: true, data: undefined };
}
