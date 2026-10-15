"use server";

/**
 * Tag taxonomy authoring — platform superadmin only.
 *
 * `Tag` is a GLOBAL, un-RLS'd table (shared catalog). Mutations go through
 * `prismaService` + `requirePlatformAdmin()` (one call per export) so only platform admins can shape the
 * categories (MUSCLE_GROUP / EQUIPMENT / DISCIPLINE / GOAL / ...). Reads used by
 * the tag combobox stay in lib/exercises.ts (`listAllTags`).
 *
 * BO2-F (plan §19.5): la auditoría va al registro de plataforma (`auditPlatformGlobalInTx`, `tenantId` null)
 * en la tx del write, y no al `AuditEvent` del consultorio «casa» del superadmin (`actor.tenantId` de
 * `requireSuperAdmin` se usaba solo para eso, y un superadmin sin consultorio no podía editar tags).
 */
import { revalidatePath, revalidateTag } from "next/cache";
import { Prisma, type TagKind } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { requirePlatformAdmin } from "@/lib/platform-actor";
import { auditPlatformGlobalInTx } from "@/lib/audit";
import { tags as cacheTags } from "@/lib/cache-tags";
import { TagAdminCreate, type ActionResult } from "@/lib/validation";
import { slugify } from "@/lib/catalog-tags";
import { isReservedTagSlug } from "@/lib/exercises-types";

function revalidateCatalog() {
  revalidatePath("/plataforma/tags");
  revalidatePath("/plataforma/ejercicios");
  revalidatePath("/biblioteca");
  revalidatePath("/terapia-manual");
  revalidateTag(cacheTags.catalog());
}

export type TagAdminRow = {
  slug: string;
  label: string;
  kind: TagKind;
  exerciseCount: number;
  conditionCount: number;
};

/** Tags of a kind (or all) with usage counts, for the admin panel. */
export async function listTagsForAdmin(kind?: TagKind): Promise<TagAdminRow[]> {
  await requirePlatformAdmin("platform.read");
  const rows = await prismaService.tag.findMany({
    where: kind ? { kind } : undefined,
    orderBy: [{ kind: "asc" }, { label: "asc" }],
    select: {
      slug: true,
      label: true,
      kind: true,
      _count: { select: { exercises: true, conditions: true } },
    },
  });
  return rows.map((t) => ({
    slug: t.slug,
    label: t.label,
    kind: t.kind,
    exerciseCount: t._count.exercises,
    conditionCount: t._count.conditions,
  }));
}

export async function createTag(raw: unknown): Promise<ActionResult<{ slug: string }>> {
  const actor = await requirePlatformAdmin("catalog.write");
  const parsed = TagAdminCreate.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Datos inválidos", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const { label, kind, parentSlug } = parsed.data;
  const slug = slugify(label);
  if (!slug) return { ok: false, error: "Etiqueta inválida." };

  const existing = await prismaService.tag.findUnique({ where: { slug }, select: { slug: true } });
  if (existing) return { ok: false, error: "Ya existe una categoría con ese nombre." };

  const parent = parentSlug
    ? await prismaService.tag.findUnique({ where: { slug: parentSlug }, select: { id: true } })
    : null;

  const tag = await prismaService.$transaction(async (tx) => {
    const created = await tx.tag.create({
      data: { slug, label, kind, parentId: parent?.id ?? null },
      select: { slug: true },
    });
    await auditPlatformGlobalInTx(tx, {
      actor,
      action: "platform.catalog.tag.create",
      entity: "Tag",
      entityId: created.slug,
      payload: { label, kind },
    });
    return created;
  });
  revalidateCatalog();
  return { ok: true, data: { slug: tag.slug } };
}

/**
 * BO3-E (handoff de BO3-A) · «crear categoría» desde el combo de tags del editor de ejercicios de Plataforma.
 *
 * El bug: el drawer usaba `ensureTag` de `lib/exercises.ts`, que pasa por `getActor` (Actor de CONSULTORIO) y el
 * gate de módulos del consultorio. Un superadmin sin consultorio propio no tiene Actor → «no_membership» al crear un
 * tag; y el que sí tiene uno lo creaba con los permisos y el modo (solo lectura, módulo `ejercicios`) de SU
 * consultorio, sin dejar rastro en el registro de plataforma.
 *
 * Misma semántica que `ensureTag` para no cambiar lo que ve el editor: kind GOAL, idempotente por slug (si ya existe
 * se devuelve el existente y NO se audita: no se creó nada), slugs de disciplina reservados y un DISCIPLINE existente
 * nunca se entrega como tag creable. Con `requirePlatformAdmin("catalog.write")` + auditoría global en la tx del
 * insert (patrón BO2-F). Carrera de dos creaciones con el mismo slug: el P2002 se resuelve devolviendo la fila ganadora.
 */
export async function ensurePlatformTag(raw: unknown): Promise<ActionResult<{ slug: string; label: string }>> {
  const actor = await requirePlatformAdmin("catalog.write");
  const label = typeof raw === "string" ? raw.trim() : "";
  if (!label || label.length > 80) return { ok: false, error: "Escribí un nombre de hasta 80 caracteres." };
  const slug = slugify(label);
  if (!slug) return { ok: false, error: "Etiqueta inválida." };
  if (isReservedTagSlug(slug)) return { ok: false, error: "Ese nombre está reservado para las disciplinas." };

  const found = await prismaService.tag.findUnique({ where: { slug }, select: { slug: true, label: true, kind: true } });
  if (found) {
    if (found.kind === "DISCIPLINE") return { ok: false, error: "Ese nombre está reservado para las disciplinas." };
    return { ok: true, data: { slug: found.slug, label: found.label } };
  }

  try {
    const created = await prismaService.$transaction(async (tx) => {
      const row = await tx.tag.create({ data: { slug, label, kind: "GOAL" }, select: { slug: true, label: true } });
      await auditPlatformGlobalInTx(tx, {
        actor,
        action: "platform.catalog.tag.create",
        entity: "Tag",
        entityId: row.slug,
        payload: { kind: "GOAL", via: "exercise_drawer" },
      });
      return row;
    });
    revalidateCatalog();
    return { ok: true, data: created };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const winner = await prismaService.tag.findUnique({ where: { slug }, select: { slug: true, label: true, kind: true } });
      if (winner && winner.kind !== "DISCIPLINE") return { ok: true, data: { slug: winner.slug, label: winner.label } };
      return { ok: false, error: "Ese nombre está reservado para las disciplinas." };
    }
    throw e;
  }
}

export async function renameTag(slug: string, label: string): Promise<ActionResult> {
  const actor = await requirePlatformAdmin("catalog.write");
  const trimmed = label.trim();
  if (!trimmed) return { ok: false, error: "Etiqueta requerida." };
  const existing = await prismaService.tag.findUnique({ where: { slug }, select: { slug: true } });
  if (!existing) return { ok: false, error: "Categoría no encontrada." };
  await prismaService.$transaction(async (tx) => {
    await tx.tag.update({ where: { slug }, data: { label: trimmed } });
    await auditPlatformGlobalInTx(tx, {
      actor,
      action: "platform.catalog.tag.rename",
      entity: "Tag",
      entityId: slug,
      payload: { label: trimmed },
    });
  });
  revalidateCatalog();
  return { ok: true, data: undefined };
}

/**
 * Delete a category: detaches it from every exercise/condition, then removes it.
 * Refuses when the tag has child tags (reparent or delete them first).
 */
export async function deleteTag(slug: string): Promise<ActionResult> {
  const actor = await requirePlatformAdmin("catalog.write");
  const tag = await prismaService.tag.findUnique({
    where: { slug },
    select: { id: true, _count: { select: { children: true } } },
  });
  if (!tag) return { ok: false, error: "Categoría no encontrada." };
  if (tag._count.children > 0) {
    return { ok: false, error: "Tiene subcategorías: borralas o reasignalas primero." };
  }
  try {
    await prismaService.$transaction(async (tx) => {
      await tx.exerciseTag.deleteMany({ where: { tagId: tag.id } });
      await tx.conditionTag.deleteMany({ where: { tagId: tag.id } });
      await tx.tag.delete({ where: { id: tag.id } });
      await auditPlatformGlobalInTx(tx, { actor, action: "platform.catalog.tag.delete", entity: "Tag", entityId: slug });
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      return { ok: false, error: "No se pudo borrar la categoría (está referenciada)." };
    }
    throw e;
  }
  revalidateCatalog();
  return { ok: true, data: undefined };
}
