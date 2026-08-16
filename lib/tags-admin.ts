"use server";

/**
 * Tag taxonomy authoring — platform superadmin only.
 *
 * `Tag` is a GLOBAL, un-RLS'd table (shared catalog). Mutations go through
 * `prismaService` + `requireSuperAdmin()` so only platform admins can shape the
 * categories (MUSCLE_GROUP / EQUIPMENT / DISCIPLINE / GOAL / ...). Reads used by
 * the tag combobox stay in lib/exercises.ts (`listAllTags`).
 */
import { revalidatePath, revalidateTag } from "next/cache";
import { Prisma, type TagKind } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { requireSuperAdmin } from "@/lib/session";
import { audit } from "@/lib/audit";
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
  await requireSuperAdmin();
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
  const actor = await requireSuperAdmin();
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

  const tag = await prismaService.tag.create({
    data: { slug, label, kind, parentId: parent?.id ?? null },
    select: { slug: true },
  });
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    action: "admin.tag.create",
    entity: "Tag",
    entityId: tag.slug,
    payload: { label, kind },
  });
  revalidateCatalog();
  return { ok: true, data: { slug: tag.slug } };
}

export async function renameTag(slug: string, label: string): Promise<ActionResult> {
  const actor = await requireSuperAdmin();
  const trimmed = label.trim();
  if (!trimmed) return { ok: false, error: "Etiqueta requerida." };
  const existing = await prismaService.tag.findUnique({ where: { slug }, select: { slug: true } });
  if (!existing) return { ok: false, error: "Categoría no encontrada." };
  await prismaService.tag.update({ where: { slug }, data: { label: trimmed } });
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    action: "admin.tag.rename",
    entity: "Tag",
    entityId: slug,
    payload: { label: trimmed },
  });
  revalidateCatalog();
  return { ok: true, data: undefined };
}

/**
 * Delete a category: detaches it from every exercise/condition, then removes it.
 * Refuses when the tag has child tags (reparent or delete them first).
 */
export async function deleteTag(slug: string): Promise<ActionResult> {
  const actor = await requireSuperAdmin();
  const tag = await prismaService.tag.findUnique({
    where: { slug },
    select: { id: true, _count: { select: { children: true } } },
  });
  if (!tag) return { ok: false, error: "Categoría no encontrada." };
  if (tag._count.children > 0) {
    return { ok: false, error: "Tiene subcategorías: borralas o reasignalas primero." };
  }
  try {
    await prismaService.$transaction([
      prismaService.exerciseTag.deleteMany({ where: { tagId: tag.id } }),
      prismaService.conditionTag.deleteMany({ where: { tagId: tag.id } }),
      prismaService.tag.delete({ where: { id: tag.id } }),
    ]);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      return { ok: false, error: "No se pudo borrar la categoría (está referenciada)." };
    }
    throw e;
  }
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    action: "admin.tag.delete",
    entity: "Tag",
    entityId: slug,
  });
  revalidateCatalog();
  return { ok: true, data: undefined };
}
