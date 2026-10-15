"use server";

/**
 * Exercise library — global catalog with practitioner-create support.
 *
 * Reads (`listExercises`, `getExercise`, `loadFilterFacets`) plus
 * mutations: `createExercise` for new custom exercises and `ensureTag`
 * for the tag-combobox create-on-the-fly flow.
 */
import { revalidatePath, revalidateTag, unstable_cache } from "next/cache";
import { prisma } from "@/lib/db";
import { runWithRls } from "@/lib/rls";
import { readOnlyFailure, withReadOnlyResult } from "@/lib/read-only-result";
import { escapeLike } from "@/lib/email-match";
import { Prisma, TagKind } from "@prisma/client";
import { getActor, ForbiddenError, assertWritable, writableError } from "@/lib/session";
import { modulesFor, MODULE_DENIED_COPY } from "@/lib/tenant-modules";
import { audit } from "@/lib/audit";
import { gatingForActor } from "@/lib/plan-gating";
import { tags as cacheTags, ttl } from "@/lib/cache-tags";
import type { ActionResult } from "@/lib/validation";

import type {
  ExerciseRow,
  ExerciseFilters,
  FilterFacets,
} from "@/lib/exercises-types";
import { TENANT_CREATABLE_TAG_KINDS, isReservedTagSlug } from "@/lib/exercises-types";
import { DISCIPLINE_TAG_SLUGS } from "@/lib/plans-constants";

/**
 * Planes P2 (S13x): fragmento `where` del filtro por disciplina. Con ese tag
 * **o** sin ninguno de los dos tags DISCIPLINE (un ejercicio genérico sirve
 * para kine y para osteo). Si el slug no es un tag DISCIPLINE existente (M1 no
 * aplicada, slug inventado o de otro kind) no filtra: mejor la biblioteca
 * completa que una vacía por un parámetro roto.
 */
async function disciplineWhere(
  tenantId: string,
  disciplineSlug: string | undefined,
): Promise<Prisma.ExerciseWhereInput> {
  if (!disciplineSlug) return {};
  const all = Object.values(DISCIPLINE_TAG_SLUGS) as string[];
  if (!all.includes(disciplineSlug)) return {};
  const tag = await runWithRls(tenantId, (tx) =>
    tx.tag.findFirst({ where: { slug: disciplineSlug, kind: "DISCIPLINE" }, select: { id: true } }),
  );
  if (!tag) return {};
  return {
    OR: [
      { tags: { some: { tagId: tag.id } } },
      { tags: { none: { tag: { slug: { in: all }, kind: "DISCIPLINE" } } } },
    ],
  };
}

export async function listExercises(f: ExerciseFilters = {}): Promise<ExerciseRow[]> {
  const actor = await getActor();
  const gate = await gatingForActor();
  const q = f.q?.trim();
  const qLike = q ? escapeLike(q) : q;
  const discipline = await disciplineWhere(actor.tenantId, f.disciplineSlug);

  // Default to EXERCISE-only so existing callers (Biblioteca) don't
  // suddenly start seeing manual-therapy maneuvers mixed in. The unified
  // picker in session modals passes `kind: "all"` to opt out.
  const kindFilter: Prisma.ExerciseWhereInput =
    f.kind === "all"
      ? {}
      : f.kind === "MANUAL_THERAPY"
        ? { kind: "MANUAL_THERAPY" }
        : { kind: "EXERCISE" };

  const where: Prisma.ExerciseWhereInput = {
    AND: [
      gate.visibility,
      kindFilter,
      discipline,
      // EV1-E1: Prisma pasa el valor de `contains` tal cual al ILIKE (`'%' || q || '%'`, verificado contra
      // Postgres): sin escapar, buscar «_» o «%» matcheaba cualquier cosa. `escapeLike` (lib/email-match.ts).
      qLike
        ? {
            OR: [
              { name: { contains: qLike, mode: "insensitive" } },
              { description: { contains: qLike, mode: "insensitive" } },
              { muscleGroups: { contains: qLike, mode: "insensitive" } },
              { tags: { some: { tag: { label: { contains: qLike, mode: "insensitive" } } } } },
            ],
          }
        : {},
      { archivedAt: null },
      f.difficulty != null ? { difficulty: f.difficulty } : {},
      f.muscleGroup ? { tags: { some: { tag: { kind: "MUSCLE_GROUP", label: f.muscleGroup } } } } : {},
      f.equipment ? { tags: { some: { tag: { kind: "EQUIPMENT", label: f.equipment } } } } : {},
      f.conditionSlug
        ? { conditions: { some: { condition: { slug: f.conditionSlug } } } }
        : {},
      f.privateOnly ? { tenantId: actor.tenantId } : {},
      f.favouritesOnly && actor.userId
        ? { favorites: { some: { userId: actor.userId, tenantId: actor.tenantId } } }
        : {},
    ],
  };

  const rows = await runWithRls(actor.tenantId, (tx) => tx.exercise.findMany({
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
  }));
  return rows.map((e) => ({
    id: e.id,
    slug: e.slug,
    name: e.name,
    description: e.description,
    difficulty: e.difficulty,
    defaultSets: e.defaultSets,
    defaultReps: e.defaultReps,
    durationSeconds: e.durationSeconds,
    equipment: e.equipment,
    muscleGroups: e.muscleGroups,
    cues: e.cues,
    instructions: e.instructions,
    videoUrl: e.videoUrl,
    kind: e.kind,
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
  const actor = await getActor();
  const gate = await gatingForActor();
  const fetcher = unstable_cache(
    async (s: string) =>
      runWithRls(actor.tenantId, (tx) => tx.exercise.findFirst({
        where: { AND: [{ slug: s }, { archivedAt: null }, gate.visibility] },
        include: {
          conditions: {
            include: { condition: true },
            orderBy: { weight: "desc" },
          },
          tags: { include: { tag: true } },
          media: { orderBy: { order: "asc" } },
          article: true,
        },
      })),
    // Enmienda EV0 (S13x): el alcance de 3 valores. Con `full ? "full" :
    // "basic"`, "none" (General) y "own" (Kine base) compartían slot y tras un
    // cambio de vertical desde /plataforma se servía el del otro alcance.
    ["exercise:slug", slug, actor.tenantId, gate.catalogScope],
    {
      tags: [cacheTags.exercises(actor.tenantId), cacheTags.catalog()],
      revalidate: ttl.long,
    }
  );
  return fetcher(slug);
}

export async function loadFilterFacets(): Promise<FilterFacets> {
  const actor = await getActor();
  const gate = await gatingForActor();
  // The visibility filter (`gate.visibility`) is a Prisma where fragment
  // that can include the tenantId for private exercises. We pass it as
  // a stringified key part so different gate states get distinct cache
  // slots, then re-hand the actual where object via a closure.
  // EV0 V.Z (P1): el combo de condiciones es del módulo `diagnostico`; va en la
  // clave para que un cambio de vertical desde /plataforma no sirva el slot viejo.
  const hasDiagnostico = modulesFor(actor.entitlements).has("diagnostico");
  // S13x: `catalogScope` (none/own/full) en lugar de `hasFullCatalog`, mismo
  // motivo que en `getExercise`.
  const gateKey = JSON.stringify({ p: actor.tenantId, scope: gate.catalogScope, dx: hasDiagnostico });
  const fetcher = unstable_cache(
    async (): Promise<FilterFacets> => {
      // Facets come from the structured MUSCLE_GROUP / EQUIPMENT tags (the
      // free-text columns are deprecated). Difficulty stays a bounded scale.
      const exercises = await runWithRls(actor.tenantId, (tx) => tx.exercise.findMany({
        where: { AND: [gate.visibility, { archivedAt: null }] },
        select: {
          difficulty: true,
          tags: { select: { tag: { select: { kind: true, label: true } } } },
        },
      }));
      const muscle = new Set<string>();
      const equip = new Set<string>();
      const diff = new Set<number>();
      for (const e of exercises) {
        for (const link of e.tags) {
          if (link.tag.kind === "MUSCLE_GROUP") muscle.add(link.tag.label);
          else if (link.tag.kind === "EQUIPMENT") equip.add(link.tag.label);
        }
        diff.add(e.difficulty);
      }
      // EV0 V.Z (P1, preexistente del bloque A): antes era `findMany` sin
      // where y la única barrera era RLS. En prod la conexión tiene BYPASSRLS,
      // así que el filtro de la biblioteca listaba las condiciones custom de
      // TODOS los consultorios (nombre = dato clínico de otro tenant). Ahora:
      // globales + las propias, a mano. Sin `diagnostico` (General), ninguna:
      // es una lectura compartida → vacío (C-EV4).
      const conditions = !hasDiagnostico
        ? []
        : await runWithRls(actor.tenantId, (tx) => tx.condition.findMany({
            where: { OR: [{ tenantId: null }, { tenantId: actor.tenantId }] },
            select: { slug: true, name: true },
            orderBy: { name: "asc" },
          }));
      return {
        muscleGroups: Array.from(muscle).sort(),
        equipment: Array.from(equip).sort(),
        difficulties: Array.from(diff).sort(),
        conditions,
      };
    },
    ["exercise-facets", gateKey],
    {
      tags: [cacheTags.exerciseFacets(actor.tenantId), cacheTags.catalog()],
      revalidate: ttl.long,
    }
  );
  return fetcher();
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
  const actor = await getActor(); // auth gate — throws if no session
  // BO1-A (C-BO3): el upsert de `Tag` (global, sin RLS) va fuera de `runWithRls` → corte explícito.
  assertWritable(actor);
  // EV0 V.Z (N2): crear tags es parte de cargar ejercicios propios (módulo
  // `ejercicios`, `gate.canCreate`). Sin el gate, un consultorio General podía
  // escribir en la tabla GLOBAL de tags por RPC. Escritura → tira (C-EV4).
  const gate = await gatingForActor();
  if (!gate.canCreate) throw new ForbiddenError(MODULE_DENIED_COPY.ejercicios);
  // Planes P2 (S13x): `Tag` es GLOBAL. Solo los kinds que usa la UI de la
  // biblioteca; DISCIPLINE (filtra la biblioteca de todos) y los de
  // diagnóstico los cura Plataforma (`lib/catalog-tags.ts`).
  if (!(TENANT_CREATABLE_TAG_KINDS as readonly TagKind[]).includes(kind)) {
    throw new Error("No se pueden crear etiquetas de ese tipo.");
  }
  const trimmed = label.trim();
  if (!trimmed) throw new Error("Tag label empty");
  const slug = slugify(trimmed);
  if (!slug) throw new Error("Tag label empty");
  // Slugs de disciplina reservados: el upsert sin `update` devolvería el tag
  // DISCIPLINE y la UI lo vincularía como si fuera un objetivo.
  if (isReservedTagSlug(slug)) {
    throw new Error("Ese nombre está reservado para las disciplinas.");
  }
  const row = await prisma.tag.upsert({
    where: { slug },
    create: { slug, label: trimmed, kind },
    update: {},
    select: { slug: true, label: true, kind: true },
  });
  // Un DISCIPLINE ajeno a los 2 de M1 (no debería existir; el post-check (11)
  // del runbook lo busca) tampoco se entrega como tag creable.
  if (row.kind === "DISCIPLINE") {
    throw new Error("Ese nombre está reservado para las disciplinas.");
  }
  return { slug: row.slug, label: row.label };
}

/**
 * Tags para el combo de la biblioteca / terapia manual (y el editor de
 * /plataforma).
 *
 * P2-Z · B-L1: antes era `tag.findMany()` sin where ni gate. `Tag` es GLOBAL
 * (no tiene `tenantId`) y `ensureTag` lo crea desde texto libre de cualquier
 * consultorio: la lista exponía a todos lo que escribió cada uno. Ahora:
 *   - Plataforma (`isPlatformAdmin`): todos — es la superficie de curado.
 *   - Sin el módulo `ejercicios` (consultorio General): `[]`.
 *   - Si no: solo los tags USADOS por contenido que el consultorio puede
 *     tener a la vista — ejercicios globales (curados por la plataforma) o
 *     propios, y condiciones globales o propias. Un tag de texto libre de otro
 *     consultorio solo cuelga de SUS ejercicios privados: no aparece. Un tag
 *     creado y nunca vinculado tampoco (ni siquiera el propio: `ensureTag` ya
 *     se lo devuelve a la UI al crearlo, y al vincularlo pasa a "usado").
 *   Se descartó filtrar por kind (los "no creables" como curados): antes de
 *   S13x `ensureTag` aceptaba cualquier kind, así que el kind no prueba quién
 *   lo creó. Los globales se muestran aunque el scope sea "own" (sin el
 *   catálogo de la plataforma): el label de un tag curado no es contenido
 *   pago ni dato de nadie, y da el vocabulario común para los propios.
 * `tenantId` a mano en cada rama (en prod la conexión es BYPASSRLS).
 */
export async function listAllTags(): Promise<{ slug: string; label: string }[]> {
  const actor = await getActor();
  if (actor.isPlatformAdmin) {
    return prisma.tag.findMany({
      orderBy: [{ kind: "asc" }, { label: "asc" }],
      select: { slug: true, label: true },
    });
  }
  if (!modulesFor(actor.entitlements).has("ejercicios")) return [];
  const mineOrGlobal = { OR: [{ tenantId: null }, { tenantId: actor.tenantId }] };
  return runWithRls(actor.tenantId, (tx) =>
    tx.tag.findMany({
      where: {
        OR: [
          { exercises: { some: { exercise: mineOrGlobal } } },
          { conditions: { some: { condition: mineOrGlobal } } },
        ],
      },
      orderBy: [{ kind: "asc" }, { label: "asc" }],
      select: { slug: true, label: true },
    })
  );
}

// EV1-E1 (readonly-residual-actions): el cuerpo va en `createExerciseImpl`; el wrapper convierte el ReadOnlyModeError
// (modo lectura / soporte) en `{ ok:false, error }` para que en prod Next no redacte el mensaje
// (lib/read-only-result.ts, mismo patrón que BO3-F).
export async function createExercise(...args: Parameters<typeof createExerciseImpl>): ReturnType<typeof createExerciseImpl> {
  return withReadOnlyResult(() => createExerciseImpl(...args));
}

async function createExerciseImpl(input: {
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
  /** EXERCISE (default) or MANUAL_THERAPY. Controls which catalogue
   * page the new row shows up in. */
  kind?: "EXERCISE" | "MANUAL_THERAPY";
  /** `private` = visible only to this tenant. Custom-created exercises
   * default to `private`. */
  visibility?: "private";
}): Promise<ActionResult<{ id: string; slug: string }>> {
  const actor = await getActor();
  // EV0 V.Z (N2): sin el módulo `ejercicios` (consultorio General) no se crean
  // ejercicios propios. Va ANTES de los upserts de tags de abajo, que escriben
  // en la tabla global. Devuelve `ActionResult` (no tira) porque el form de alta
  // ya muestra `error`; el copy es el del módulo.
  const gate = await gatingForActor();
  if (!gate.canCreate) return { ok: false, error: MODULE_DENIED_COPY.ejercicios };
  // BO1-A (C-BO3): los upserts de `Tag` de abajo van fuera de `runWithRls`; sin este corte un consultorio en solo
  // lectura escribiría tags globales antes de que la tx del ejercicio falle.
  const readOnly = writableError(actor);
  if (readOnly) return { ok: false, error: readOnly };
  const name = input.name.trim();
  if (!name) return { ok: false, error: "Nombre requerido." };

  const baseSlug = slugify(name);
  // Append a short suffix until unique.
  let slug = baseSlug;
  for (let i = 1; i < 50; i++) {
    const taken = await runWithRls(actor.tenantId, (tx) => tx.exercise.findUnique({ where: { slug }, select: { id: true } }));
    if (!taken) break;
    slug = `${baseSlug}-${i}`;
  }

  // Auto-tag from the free-text muscle/equipment inputs so the new exercise
  // shows up in the (tag-based) biblioteca facets. Tag is a global, non-RLS
  // table, so the app-role client may upsert into it.
  const autoTagSlugs: string[] = [];
  for (const [text, kind] of [
    [input.muscleGroups, "MUSCLE_GROUP"],
    [input.equipment, "EQUIPMENT"],
  ] as const) {
    for (const label of (text ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      const s = slugify(label);
      // S13x: "Kinesiología" escrito como grupo muscular no crea ni vincula el
      // tag de disciplina (mismo motivo que en `ensureTag`).
      if (!s || isReservedTagSlug(s)) continue;
      await prisma.tag.upsert({ where: { slug: s }, create: { slug: s, label, kind }, update: {} });
      if (!autoTagSlugs.includes(s)) autoTagSlugs.push(s);
    }
  }
  const allTagSlugs = [...new Set([...(input.tagSlugs ?? []), ...autoTagSlugs])];

  try {
    const ex = await runWithRls(actor.tenantId, (tx) => tx.exercise.create({
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
        kind: input.kind ?? "EXERCISE",
        // Practitioner-authored exercises always belong to their tenant
        // — the global catalog is curated centrally.
        tenantId: actor.tenantId,
        createdById: actor.userId ?? null,
        tags: allTagSlugs.length
          ? {
              create: allTagSlugs.map((slug) => ({
                tag: { connect: { slug } },
              })),
            }
          : undefined,
      },
    }));
    await audit({
      tenantId: actor.tenantId,
      actorId: actor.userId ?? undefined,
      action: "exercise.create",
      entity: "Exercise",
      entityId: ex.id,
      payload: { name },
    });
    revalidatePath("/biblioteca");
    revalidatePath("/terapia-manual");
    revalidateTag(cacheTags.exercises(actor.tenantId));
    revalidateTag(cacheTags.exerciseFacets(actor.tenantId));
    return { ok: true, data: { id: ex.id, slug: ex.slug } };
  } catch (e) {
    // EV1-E1: este catch tapaba el ReadOnlyModeError con el copy genérico; el del modo lectura/soporte va primero.
    const ro = readOnlyFailure(e);
    if (ro) return ro;
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, error: "Ya existe un ejercicio con ese nombre." };
    }
    return { ok: false, error: "No pudimos crear el ejercicio." };
  }
}
