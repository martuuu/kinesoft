/**
 * Backfill: structured tags from the deprecated free-text columns.
 *
 * Converts every exercise's comma-separated `muscleGroups` / `equipment`
 * strings into managed MUSCLE_GROUP / EQUIPMENT `Tag` rows + `ExerciseTag`
 * links. Covers BOTH the global catalog AND tenant-private rows so no exercise
 * loses its muscle/equipment facets once /biblioteca filters read tags.
 *
 * Idempotent — safe to re-run (upserts tags, skipDuplicates on links). Run
 * against LOCAL with the owner (BYPASSRLS) connection:
 *
 *   DATABASE_URL="postgresql://kinesoft:kinesoft@localhost:5433/kinesoft?schema=public" \
 *     npx tsx prisma/backfill-exercise-tags.ts
 */
import { PrismaClient, type TagKind } from "@prisma/client";

const url =
  process.env.BACKFILL_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://kinesoft:kinesoft@localhost:5433/kinesoft?schema=public";
const db = new PrismaClient({ datasources: { db: { url } } });

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

async function ensureTag(label: string, kind: TagKind): Promise<string | null> {
  const trimmed = label.trim();
  const slug = slugify(trimmed);
  if (!trimmed || !slug) return null;
  await db.tag.upsert({ where: { slug }, create: { slug, label: trimmed, kind }, update: {} });
  return slug;
}

async function tagsFrom(text: string | null, kind: TagKind): Promise<string[]> {
  if (!text) return [];
  const out: string[] = [];
  for (const label of text.split(",").map((s) => s.trim()).filter(Boolean)) {
    const slug = await ensureTag(label, kind);
    if (slug && !out.includes(slug)) out.push(slug);
  }
  return out;
}

async function main() {
  const exercises = await db.exercise.findMany({
    select: { id: true, slug: true, muscleGroups: true, equipment: true },
  });
  let tagged = 0;
  let links = 0;
  const seenTags = new Set<string>();
  for (const ex of exercises) {
    const slugs = [
      ...(await tagsFrom(ex.muscleGroups, "MUSCLE_GROUP")),
      ...(await tagsFrom(ex.equipment, "EQUIPMENT")),
    ];
    slugs.forEach((s) => seenTags.add(s));
    if (slugs.length === 0) continue;
    const tags = await db.tag.findMany({ where: { slug: { in: slugs } }, select: { id: true } });
    const res = await db.exerciseTag.createMany({
      data: tags.map((t) => ({ exerciseId: ex.id, tagId: t.id })),
      skipDuplicates: true,
    });
    links += res.count;
    if (slugs.length) tagged++;
  }
  const muscle = await db.tag.count({ where: { kind: "MUSCLE_GROUP" } });
  const equip = await db.tag.count({ where: { kind: "EQUIPMENT" } });
  console.log(
    `Backfill OK · ${exercises.length} ejercicios revisados · ${tagged} con tags · ` +
      `${links} links nuevos · ${muscle} tags MUSCLE_GROUP · ${equip} tags EQUIPMENT · ` +
      `${seenTags.size} tags únicos tocados`,
  );
}

main()
  .then(() => db.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await db.$disconnect();
    process.exit(1);
  });
