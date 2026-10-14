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

function revalidateCatalog() {
  revalidatePath("/plataforma/tags");
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
