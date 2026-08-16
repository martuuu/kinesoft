import "server-only";
import type { TagKind } from "@prisma/client";
import { prismaService } from "@/lib/db";

/**
 * Global-catalog tag helpers (platform superadmin + backfill).
 *
 * The `Tag` table + the global `Exercise` catalog (`tenantId IS NULL`) are
 * curated centrally, so every write here goes through `prismaService`
 * (BYPASSRLS) — the RLS-forced app role physically can't touch global rows.
 * Callers must already have passed `requireSuperAdmin()` (or be the backfill).
 */

/** URL-safe slug from a human label. Mirrors lib/exercises.ts + lib/conditions.ts. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

/** Ensure a global tag exists (by slug derived from label+kind); returns its
 *  slug, or null when the label is empty. Idempotent. */
export async function ensureTagByKind(label: string, kind: TagKind): Promise<string | null> {
  const trimmed = label.trim();
  if (!trimmed) return null;
  const slug = slugify(trimmed);
  if (!slug) return null;
  await prismaService.tag.upsert({
    where: { slug },
    create: { slug, label: trimmed, kind },
    update: {},
  });
  return slug;
}

/** Split a comma-separated free-text field ("Glúteo medio, Cadera") into
 *  ensured tags of `kind`, returning their (deduped) slugs. */
export async function tagsFromFreeText(
  text: string | null | undefined,
  kind: TagKind,
): Promise<string[]> {
  if (!text) return [];
  const out: string[] = [];
  for (const label of text.split(",").map((s) => s.trim()).filter(Boolean)) {
    const slug = await ensureTagByKind(label, kind);
    if (slug && !out.includes(slug)) out.push(slug);
  }
  return out;
}

/**
 * Replace an exercise's tag links (for a given set of kinds, or all) with
 * exactly `tagSlugs`. Unknown slugs are ignored. When `kinds` is provided, only
 * links whose tag is of one of those kinds are cleared before re-linking — so a
 * caller managing MUSCLE_GROUP/EQUIPMENT tags doesn't wipe GOAL/ZONE links.
 */
export async function setExerciseTags(
  exerciseId: string,
  tagSlugs: string[],
  kinds?: TagKind[],
): Promise<void> {
  const unique = [...new Set(tagSlugs)];
  const tags = unique.length
    ? await prismaService.tag.findMany({ where: { slug: { in: unique } }, select: { id: true } })
    : [];
  const clearWhere = kinds
    ? { exerciseId, tag: { kind: { in: kinds } } }
    : { exerciseId };
  await prismaService.$transaction([
    prismaService.exerciseTag.deleteMany({ where: clearWhere }),
    prismaService.exerciseTag.createMany({
      data: tags.map((t) => ({ exerciseId, tagId: t.id })),
      skipDuplicates: true,
    }),
  ]);
}

/**
 * Denormalize a set of tag slugs back into the deprecated free-text
 * `muscleGroups` / `equipment` columns (comma-joined labels), so the biblioteca
 * cards — which still render those strings — keep working while the catalog is
 * authored via structured tags. Null when the kind has no tags.
 */
export async function freeTextFromTags(
  tagSlugs: string[],
): Promise<{ muscleGroups: string | null; equipment: string | null }> {
  if (!tagSlugs.length) return { muscleGroups: null, equipment: null };
  const tags = await prismaService.tag.findMany({
    where: { slug: { in: [...new Set(tagSlugs)] } },
    select: { kind: true, label: true },
  });
  const m = tags.filter((t) => t.kind === "MUSCLE_GROUP").map((t) => t.label);
  const e = tags.filter((t) => t.kind === "EQUIPMENT").map((t) => t.label);
  return {
    muscleGroups: m.length ? m.join(", ") : null,
    equipment: e.length ? e.join(", ") : null,
  };
}

/**
 * Backfill: ensure MUSCLE_GROUP + EQUIPMENT tags for an exercise from its
 * deprecated free-text `muscleGroups`/`equipment` columns, and link them
 * (additively — existing links of other kinds are untouched). Idempotent.
 * Returns the slugs linked.
 */
export async function syncExerciseFreeTextTags(ex: {
  id: string;
  muscleGroups: string | null;
  equipment: string | null;
}): Promise<string[]> {
  const muscleSlugs = await tagsFromFreeText(ex.muscleGroups, "MUSCLE_GROUP");
  const equipSlugs = await tagsFromFreeText(ex.equipment, "EQUIPMENT");
  const all = [...muscleSlugs, ...equipSlugs];
  if (all.length === 0) return [];
  const tags = await prismaService.tag.findMany({
    where: { slug: { in: all } },
    select: { id: true },
  });
  await prismaService.exerciseTag.createMany({
    data: tags.map((t) => ({ exerciseId: ex.id, tagId: t.id })),
    skipDuplicates: true,
  });
  return all;
}
