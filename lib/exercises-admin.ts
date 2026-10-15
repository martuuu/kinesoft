"use server";

/**
 * Global exercise catalog authoring — platform superadmin only.
 *
 * Every mutation here targets the GLOBAL catalog (`tenantId: null`) and runs
 * through `prismaService` (BYPASSRLS): the RLS-forced app role physically can't
 * write `tenantId IS NULL` rows, so `requirePlatformAdmin()` is the single
 * enforcement chokepoint (one call per export). Tenant-private custom exercises keep going through
 * `createExercise` in lib/exercises.ts (app role, runWithRls).
 *
 * BO2-F (plan §19.5): antes la barrera era `requireSuperAdmin()`, que arma un Actor por `buildActor`: un
 * superadmin sin consultorio propio no podía curar el catálogo, y el que sí tenía uno dejaba cada edición del
 * catálogo GLOBAL en el `AuditEvent` de SU consultorio (`actor.tenantId` se usaba solo para eso). Ahora cada
 * escritura deja su fila en el registro de plataforma (`auditPlatformGlobalInTx`, `tenantId` null) dentro de
 * la misma tx del write. Payload de lista cerrada: nombre/tipo al crear y las CLAVES cambiadas al editar
 * (nunca el texto de descripción/instrucciones/artículo).
 */
import { revalidatePath, revalidateTag } from "next/cache";
import { Prisma } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { requirePlatformAdmin, type PlatformActor } from "@/lib/platform-actor";
import { auditPlatformGlobalInTx, type PlatformAuditAction } from "@/lib/audit";
import { tags as cacheTags } from "@/lib/cache-tags";
import {
  ExerciseAdminCreate,
  ExerciseAdminUpdate,
  ExerciseArticleUpsert,
  type ActionResult,
} from "@/lib/validation";
import { slugify, setExerciseTags, freeTextFromTags } from "@/lib/catalog-tags";
import { escapeLike } from "@/lib/email-match";
import {
  DEFAULT_CATALOG_FILTERS,
  type CatalogFilters,
  type CatalogSortCol,
  type CatalogSortDir,
} from "@/lib/preferences-constants";

export type GlobalExerciseAdminRow = {
  id: string;
  slug: string;
  name: string;
  kind: "EXERCISE" | "MANUAL_THERAPY";
  difficulty: number;
  archived: boolean;
  defaultSets: number | null;
  defaultReps: number | null;
  durationSeconds: number | null;
  tags: { slug: string; label: string; kind: string }[];
  mediaCount: number;
  hasArticle: boolean;
  createdAt: string;
};

export type CatalogPage = {
  rows: GlobalExerciseAdminRow[];
  /** Total matching the filters (not just this page) — drives the pager. */
  total: number;
};

// Every entry ends in `id` so the ordering is a TOTAL order: without a unique
// tiebreaker two rows sharing a name/difficulty could swap places between the
// page-1 and page-2 queries, duplicating one and hiding the other.
const SORT_ORDER: Record<
  CatalogSortCol,
  (dir: CatalogSortDir) => Prisma.ExerciseOrderByWithRelationInput[]
> = {
  name: (dir) => [{ name: dir }, { id: "asc" }],
  difficulty: (dir) => [{ difficulty: dir }, { name: "asc" }, { id: "asc" }],
  kind: (dir) => [{ kind: dir }, { name: "asc" }, { id: "asc" }],
  createdAt: (dir) => [{ createdAt: dir }, { id: "asc" }],
};

/**
 * Paged + filtered + sorted view of the GLOBAL catalog for the Plataforma
 * table. Superadmin only. Tag filters are AND-ed across kinds (muscle AND
 * equipment AND discipline) and OR-ed within a kind, which is what the chip
 * UI implies. Returns `{ rows, total }` so the pager knows the page count.
 */
export async function listGlobalExercisesForAdmin(opts?: {
  filters?: Partial<CatalogFilters>;
  sortCol?: CatalogSortCol;
  sortDir?: CatalogSortDir;
  skip?: number;
  take?: number;
}): Promise<CatalogPage> {
  await requirePlatformAdmin("platform.read");
  const f = { ...DEFAULT_CATALOG_FILTERS, ...(opts?.filters ?? {}) };
  const q = f.q.trim();
  // EV1-D: Prisma NO escapa `%`/`_` en `contains`/`equals` con `mode: "insensitive"` (va como ILIKE '%<texto>%'; medido contra el Docker en EV1-D: buscar «%» traía todas las filas).
  const qLike = escapeLike(q);

  const tagFilter = (kind: "MUSCLE_GROUP" | "EQUIPMENT" | "DISCIPLINE", slugs: string[]) =>
    slugs.length ? [{ tags: { some: { tag: { kind, slug: { in: slugs } } } } }] : [];

  const where: Prisma.ExerciseWhereInput = {
    AND: [
      { tenantId: null },
      f.archived === "active"
        ? { archivedAt: null }
        : f.archived === "archived"
          ? { archivedAt: { not: null } }
          : {},
      f.kind ? { kind: f.kind } : {},
      // EV1-D: no hay filtro Común/Pro (`isBasic` ya no gatea nada desde EV0).
      f.difficulty != null ? { difficulty: f.difficulty } : {},
      ...tagFilter("MUSCLE_GROUP", f.muscle),
      ...tagFilter("EQUIPMENT", f.equipment),
      ...tagFilter("DISCIPLINE", f.discipline),
      q
        ? {
            OR: [
              { name: { contains: qLike, mode: "insensitive" } },
              { description: { contains: qLike, mode: "insensitive" } },
              { tags: { some: { tag: { label: { contains: qLike, mode: "insensitive" } } } } },
            ],
          }
        : {},
    ],
  };

  // EV1: `tier` salió de `CatalogSortCol`; los callers pasan prefs ya saneadas, pero una columna desconocida
  // (pref vieja que entrara sin `sanitizeCatalogPrefs`) cae a nombre en vez de tirar `undefined is not a function`.
  const orderBy = (SORT_ORDER[opts?.sortCol ?? "name"] ?? SORT_ORDER.name)(opts?.sortDir ?? "asc");

  const [rows, total] = await Promise.all([
    prismaService.exercise.findMany({
      where,
      orderBy,
      skip: opts?.skip ?? 0,
      take: opts?.take ?? 30,
      select: {
        id: true, slug: true, name: true, kind: true, difficulty: true,
        archivedAt: true, defaultSets: true, defaultReps: true, durationSeconds: true,
        createdAt: true,
        tags: { select: { tag: { select: { slug: true, label: true, kind: true } } } },
        _count: { select: { media: true } },
        article: { select: { id: true } },
      },
    }),
    prismaService.exercise.count({ where }),
  ]);

  return {
    rows: rows.map((e) => ({
      id: e.id, slug: e.slug, name: e.name, kind: e.kind, difficulty: e.difficulty,
      archived: e.archivedAt != null,
      defaultSets: e.defaultSets, defaultReps: e.defaultReps, durationSeconds: e.durationSeconds,
      tags: e.tags.map((t) => ({ slug: t.tag.slug, label: t.tag.label, kind: t.tag.kind })),
      mediaCount: e._count.media, hasArticle: e.article != null,
      createdAt: e.createdAt.toISOString(),
    })),
    total,
  };
}

/** Tag options grouped by the kinds the catalog table filters on. */
export async function listCatalogTagOptions(): Promise<{
  muscle: { slug: string; label: string }[];
  equipment: { slug: string; label: string }[];
  discipline: { slug: string; label: string }[];
}> {
  await requirePlatformAdmin("platform.read");
  const rows = await prismaService.tag.findMany({
    where: { kind: { in: ["MUSCLE_GROUP", "EQUIPMENT", "DISCIPLINE"] } },
    orderBy: { label: "asc" },
    select: { slug: true, label: true, kind: true },
  });
  const pick = (k: string) => rows.filter((r) => r.kind === k).map(({ slug, label }) => ({ slug, label }));
  return { muscle: pick("MUSCLE_GROUP"), equipment: pick("EQUIPMENT"), discipline: pick("DISCIPLINE") };
}

/** Full global exercise (incl. tags, media, article) for the admin editor. */
export async function getGlobalExerciseForAdmin(id: string) {
  await requirePlatformAdmin("platform.read");
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

function auditExercise(
  tx: Prisma.TransactionClient,
  actor: PlatformActor,
  action: PlatformAuditAction,
  exerciseId: string,
  payload?: Record<string, unknown>,
) {
  return auditPlatformGlobalInTx(tx, { actor, action, entity: "Exercise", entityId: exerciseId, payload });
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
  const actor = await requirePlatformAdmin("catalog.write");
  const parsed = ExerciseAdminCreate.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Datos inválidos", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const d = parsed.data;
  const slug = await uniqueGlobalSlug(d.name);
  const tagSlugs = d.tagSlugs ?? [];
  const freeText = await freeTextFromTags(tagSlugs);

  try {
    const ex = await prismaService.$transaction(async (tx) => {
      const created = await tx.exercise.create({
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
          tenantId: null, // global catalog
          createdById: actor.userId,
        },
        select: { id: true, slug: true },
      });
      if (tagSlugs.length) await setExerciseTags(created.id, tagSlugs, undefined, tx);
      await auditExercise(tx, actor, "platform.catalog.exercise.create", created.id, { name: d.name, kind: d.kind });
      return created;
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
  const actor = await requirePlatformAdmin("catalog.write");
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

  // Claves (no valores) para el registro: qué tocó el superadmin, sin copiar texto libre.
  const changed = Object.keys(d).filter((k) => d[k as keyof typeof d] !== undefined);
  if (tagSlugs !== undefined) changed.push("tags");

  await prismaService.$transaction(async (tx) => {
    if (tagSlugs !== undefined) {
      await setExerciseTags(id, tagSlugs, undefined, tx);
      const freeText = await freeTextFromTags(tagSlugs, tx);
      data.muscleGroups = freeText.muscleGroups;
      data.equipment = freeText.equipment;
    }
    await tx.exercise.update({ where: { id }, data });
    await auditExercise(tx, actor, "platform.catalog.exercise.update", id, { changed: changed.sort() });
  });
  revalidateCatalog();
  return { ok: true, data: undefined };
}

async function setArchived(actor: PlatformActor, id: string, archived: boolean): Promise<ActionResult> {
  const existing = await prismaService.exercise.findFirst({
    where: { id, tenantId: null },
    select: { id: true },
  });
  if (!existing) return { ok: false, error: "Ejercicio global no encontrado." };
  await prismaService.$transaction(async (tx) => {
    await tx.exercise.update({
      where: { id },
      data: { archivedAt: archived ? new Date() : null },
    });
    await auditExercise(tx, actor, archived ? "platform.catalog.exercise.archive" : "platform.catalog.exercise.restore", id);
  });
  revalidateCatalog();
  return { ok: true, data: undefined };
}

// La barrera va en cada export (invariante del bloque BO), no en el helper compartido.
export async function archiveGlobalExercise(id: string): Promise<ActionResult> {
  const actor = await requirePlatformAdmin("catalog.write");
  return setArchived(actor, id, true);
}

export async function restoreGlobalExercise(id: string): Promise<ActionResult> {
  const actor = await requirePlatformAdmin("catalog.write");
  return setArchived(actor, id, false);
}

/**
 * Hard delete — only when nothing historical references the exercise. Sessions
 * (PHI plans) and condition links must never be cascade-destroyed, so we refuse
 * and point the caller at archive instead. Favourites / tags / media / article
 * cascade away safely.
 */
export async function hardDeleteGlobalExercise(id: string): Promise<ActionResult> {
  const actor = await requirePlatformAdmin("catalog.write");
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
  await prismaService.$transaction(async (tx) => {
    await tx.exercise.delete({ where: { id } });
    await auditExercise(tx, actor, "platform.catalog.exercise.delete", id);
  });
  revalidateCatalog();
  return { ok: true, data: undefined };
}

/** Create/update the long-form "Ejercicio completo" article (1:1). */
export async function upsertExerciseArticle(raw: unknown): Promise<ActionResult> {
  const actor = await requirePlatformAdmin("catalog.write");
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
  await prismaService.$transaction(async (tx) => {
    await tx.exerciseArticle.upsert({
      where: { exerciseId },
      create: { exerciseId, ...fields },
      update: fields,
    });
    await auditExercise(tx, actor, "platform.catalog.exercise.article", exerciseId);
  });
  revalidatePath(`/biblioteca/${ex.slug}`);
  revalidateCatalog();
  return { ok: true, data: undefined };
}
