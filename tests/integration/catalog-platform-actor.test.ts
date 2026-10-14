/**
 * BO2-F · catálogo global al actor de plataforma (plan §19.5, contratos C-BO2 y C-BO5).
 *
 * El bug (§19.1): las actions del catálogo global (ejercicios, tags, media, obras sociales/prácticas/
 * especialidades) pedían `requireSuperAdmin()`, que arma un Actor por `buildActor`: un superadmin SIN consultorio
 * propio no podía curar el catálogo, y el que sí tenía uno dejaba cada edición del catálogo GLOBAL en el log de
 * auditoría de SU consultorio (ruido para su OWNER y nada en el visor de Plataforma).
 *
 * Se fija contra Postgres real, con los símbolos REALES (solo se mockea la sesión de Supabase y `next/cache`):
 *   - un superadmin sin membresías (perfil `isPlatformAdmin`) puede escribir en los cuatro módulos;
 *   - cada escritura deja UNA fila en `PlatformAuditEvent` con `tenantId` null, y ningún `AuditEvent`;
 *   - el payload es de catálogo (lista cerrada de claves, sin texto libre largo);
 *   - un no superadmin rebota con `ForbiddenError` en cada export de escritura y no escribe nada.
 *
 * `PlatformAuditEvent` es solo inserción (trigger): la limpieza usa el modo réplica, igual que platform-audit.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { ForbiddenError } from "@/lib/session";
import {
  createGlobalExercise,
  updateGlobalExercise,
  archiveGlobalExercise,
  restoreGlobalExercise,
  hardDeleteGlobalExercise,
  upsertExerciseArticle,
} from "@/lib/exercises-admin";
import { createTag, renameTag, deleteTag } from "@/lib/tags-admin";
import { addExerciseMedia, deleteExerciseMedia, reorderExerciseMedia } from "@/lib/exercise-media";
import {
  updatePayer,
  updatePractice,
  updateSpecialty,
  setCatalogArchived,
  mergePayer,
  mergePractice,
  promotePayerPlan,
  refreshCatalogCache,
} from "@/lib/catalog-admin";
import { asUser } from "@/tests/helpers/actor";
import { ownerClient, createEphemeralTenant, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const SRC_DATE = new Date("2026-09-01T00:00:00Z");

describe.skipIf(!RUN)("[BO2-F] catálogo global con requirePlatformAdmin + registro de plataforma", () => {
  let db: PrismaClient;
  /** Superadmin SIN consultorio (sin membresías). */
  let superId: string;
  /** OWNER de un consultorio, no superadmin. */
  let A: EphemeralTenant;
  const exerciseIds: string[] = [];
  const tagSlugs: string[] = [];
  const payerIds: string[] = [];
  const practiceIds: string[] = [];
  const specialtyIds: string[] = [];

  beforeAll(async () => {
    db = ownerClient();
    superId = `test-user-${uniqueSuffix()}`;
    await db.userProfile.create({
      data: { id: superId, email: `${superId}@test.local`, fullName: "Super Sin Consultorio", isPlatformAdmin: true },
    });
    A = await createEphemeralTenant(db);
  });

  afterAll(async () => {
    if (!db) return;
    await db.exercise.deleteMany({ where: { id: { in: exerciseIds } } });
    await db.tag.deleteMany({ where: { slug: { in: tagSlugs } } });
    await db.payerPlan.deleteMany({ where: { payerId: { in: payerIds } } });
    await db.payer.deleteMany({ where: { id: { in: payerIds } } });
    await db.practice.deleteMany({ where: { id: { in: practiceIds } } });
    await db.specialty.deleteMany({ where: { id: { in: specialtyIds } } });
    await db.$transaction([
      db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
      db.$executeRaw`DELETE FROM "PlatformAuditEvent" WHERE "actorId" = ANY(${[superId, A.userId]})`,
    ]);
    await A?.cleanup();
    await db.userProfile.deleteMany({ where: { id: superId } });
    await db.$disconnect();
  });

  /** Filas globales del superadmin para una entidad, en orden de escritura. */
  const platformRows = (entityId: string) =>
    db.platformAuditEvent.findMany({ where: { actorId: superId, entityId }, orderBy: { createdAt: "asc" } });
  /** Ningún AuditEvent de consultorio con el superadmin como actor (no tiene consultorio donde escribirlo). */
  const tenantAuditCount = () => db.auditEvent.count({ where: { actorId: superId } });

  async function newPayer(name: string) {
    const s = uniqueSuffix();
    const p = await db.payer.create({
      data: { slug: `test-payer-${s}`, name, matchKey: `test payer ${s}`, kind: "OBRA_SOCIAL", aliases: [], source: "RNOS", sourceDate: SRC_DATE },
    });
    payerIds.push(p.id);
    return p;
  }
  async function newPractice(name: string) {
    const s = uniqueSuffix();
    const p = await db.practice.create({
      data: { slug: `test-practice-${s}`, name, matchKey: `test practice ${s}`, aliases: [], source: "NOMENCLADOR_NACIONAL", sourceDate: SRC_DATE },
    });
    practiceIds.push(p.id);
    return p;
  }
  async function newSpecialty(name: string) {
    const s = uniqueSuffix();
    const sp = await db.specialty.create({
      data: { slug: `test-spec-${s}`, name, matchKey: `test spec ${s}`, aliases: [], source: "REFEPS", sourceDate: SRC_DATE },
    });
    specialtyIds.push(sp.id);
    return sp;
  }
  async function newGlobalExercise(name: string) {
    const ex = await db.exercise.create({ data: { slug: `test-ex-${uniqueSuffix()}`, name, tenantId: null } });
    exerciseIds.push(ex.id);
    return ex;
  }

  it("[BO2-F] superadmin sin consultorio: ejercicios (crear/editar/archivar/restaurar/artículo/borrar) → registro global", async () => {
    asUser(superId);
    const created = await createGlobalExercise({ name: `BO2F ejercicio ${uniqueSuffix()}`, kind: "EXERCISE", difficulty: 2 });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.data.id;
    exerciseIds.push(id);
    expect((await db.exercise.findUniqueOrThrow({ where: { id } })).createdById).toBe(superId);

    expect((await updateGlobalExercise({ id, difficulty: 3, description: "Texto libre que no va al registro" })).ok).toBe(true);
    expect((await archiveGlobalExercise(id)).ok).toBe(true);
    expect((await db.exercise.findUniqueOrThrow({ where: { id } })).archivedAt).not.toBeNull();
    expect((await restoreGlobalExercise(id)).ok).toBe(true);
    expect((await upsertExerciseArticle({ exerciseId: id, title: "Artículo", bodyMarkdown: "# cuerpo" })).ok).toBe(true);
    expect((await hardDeleteGlobalExercise(id)).ok).toBe(true);
    expect(await db.exercise.findUnique({ where: { id } })).toBeNull();

    const rows = await platformRows(id);
    expect(rows.map((r) => r.action)).toEqual([
      "platform.catalog.exercise.create",
      "platform.catalog.exercise.update",
      "platform.catalog.exercise.archive",
      "platform.catalog.exercise.restore",
      "platform.catalog.exercise.article",
      "platform.catalog.exercise.delete",
    ]);
    for (const r of rows) {
      expect(r.tenantId).toBeNull();
      expect(r.entity).toBe("Exercise");
      expect(r.actorEmail).toBe(`${superId}@test.local`);
      expect(r.payload).toMatchObject({ platform: { actorHomeTenantId: null } });
    }
    // Lista cerrada: el update registra QUÉ campos cambió, nunca el texto.
    expect(Object.keys(rows[0].payload as object).sort()).toEqual(["kind", "name", "platform"]);
    expect(rows[1].payload).toMatchObject({ changed: expect.arrayContaining(["description", "difficulty"]) });
    expect(JSON.stringify(rows[1].payload)).not.toContain("Texto libre");
    expect(await tenantAuditCount()).toBe(0);
  });

  it("[BO2-F] superadmin sin consultorio: tags (crear/renombrar/borrar) → registro global", async () => {
    asUser(superId);
    const label = `BO2F tag ${uniqueSuffix()}`;
    const created = await createTag({ label, kind: "EQUIPMENT" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const slug = created.data.slug;
    tagSlugs.push(slug);
    expect((await renameTag(slug, `${label} bis`)).ok).toBe(true);
    expect((await deleteTag(slug)).ok).toBe(true);
    expect(await db.tag.findUnique({ where: { slug } })).toBeNull();

    const rows = await platformRows(slug);
    expect(rows.map((r) => r.action)).toEqual([
      "platform.catalog.tag.create",
      "platform.catalog.tag.rename",
      "platform.catalog.tag.delete",
    ]);
    expect(rows.every((r) => r.tenantId === null && r.entity === "Tag")).toBe(true);
    expect(await tenantAuditCount()).toBe(0);
  });

  it("[BO2-F] superadmin sin consultorio: media (agregar YouTube/reordenar/borrar) → registro global", async () => {
    asUser(superId);
    const ex = await newGlobalExercise(`BO2F media ${uniqueSuffix()}`);
    const add = async (v: string) => {
      const fd = new FormData();
      fd.set("exerciseId", ex.id);
      fd.set("type", "YOUTUBE");
      fd.set("url", `https://www.youtube.com/watch?v=${v}`);
      const res = await addExerciseMedia(fd);
      expect(res.ok).toBe(true);
      return res.ok ? res.data.id : "";
    };
    const m1 = await add("dQw4w9WgXcQ");
    const m2 = await add("9bZkp7q19f0");
    expect((await reorderExerciseMedia(ex.id, [m2, m1])).ok).toBe(true);
    expect((await db.exerciseMedia.findUniqueOrThrow({ where: { id: m2 } })).order).toBe(0);
    expect((await deleteExerciseMedia(m1)).ok).toBe(true);
    expect(await db.exerciseMedia.findUnique({ where: { id: m1 } })).toBeNull();

    expect((await platformRows(m1)).map((r) => r.action)).toEqual([
      "platform.catalog.exercise.media.add",
      "platform.catalog.exercise.media.delete",
    ]);
    const reorder = await platformRows(ex.id);
    expect(reorder.map((r) => r.action)).toEqual(["platform.catalog.exercise.media.reorder"]);
    expect(reorder[0].payload).toMatchObject({ count: 2 });
    const all = await db.platformAuditEvent.findMany({ where: { actorId: superId, entityId: { in: [m1, m2, ex.id] } } });
    expect(all.every((r) => r.tenantId === null)).toBe(true);
    // La URL del video no va al registro (payload de lista cerrada).
    expect(JSON.stringify(all.map((r) => r.payload))).not.toContain("youtube.com");
    expect(await tenantAuditCount()).toBe(0);
  });

  it("[BO2-F] superadmin sin consultorio: catálogo de obras sociales/prácticas/especialidades → registro global", async () => {
    asUser(superId);
    const payer = await newPayer("BO2F OS");
    const from = await newPayer("BO2F OS origen");
    const practice = await newPractice("BO2F práctica");
    const practiceFrom = await newPractice("BO2F práctica origen");
    const spec = await newSpecialty("BO2F especialidad");
    const proposal = await db.payerPlan.create({
      data: { payerId: payer.id, tenantId: A.tenantId, slug: `bo2f-${uniqueSuffix()}`, name: "PROP", source: "TENANT", sourceDate: SRC_DATE },
    });

    expect((await updatePayer({ id: payer.id, name: "BO2F OS editada", kind: "OBRA_SOCIAL", aliases: [] })).ok).toBe(true);
    expect((await updatePractice({ id: practice.id, name: "BO2F práctica editada", aliases: [] })).ok).toBe(true);
    expect((await updateSpecialty({ id: spec.id, name: "BO2F especialidad editada", aliases: [] })).ok).toBe(true);
    expect((await setCatalogArchived({ entity: "specialty", id: spec.id, archived: true })).ok).toBe(true);
    expect((await mergePayer({ fromId: from.id, intoId: payer.id })).ok).toBe(true);
    expect((await mergePractice({ fromId: practiceFrom.id, intoId: practice.id })).ok).toBe(true);
    expect((await promotePayerPlan({ planId: proposal.id })).ok).toBe(true);
    expect((await refreshCatalogCache()).ok).toBe(true);

    expect((await platformRows(payer.id)).map((r) => r.action)).toEqual([
      "platform.catalog.payer.update",
      "platform.catalog.payer.merge",
    ]);
    expect((await platformRows(practice.id)).map((r) => r.action)).toEqual([
      "platform.catalog.practice.update",
      "platform.catalog.practice.merge",
    ]);
    expect((await platformRows(spec.id)).map((r) => r.action)).toEqual([
      "platform.catalog.specialty.update",
      "platform.catalog.specialty.archive",
    ]);
    const promo = await platformRows(proposal.id);
    expect(promo.map((r) => r.action)).toEqual(["platform.catalog.payerPlan.promote"]);
    // El consultorio que propuso va en el payload, NO en `tenantId` (la FK es RESTRICT: una fila global con
    // tenantId bloquearía borrar ese consultorio; y la acción es sobre el catálogo, no sobre él).
    expect(promo[0].tenantId).toBeNull();
    expect(promo[0].payload).toMatchObject({ proposedBy: A.tenantId });
    expect((await platformRows("global")).map((r) => r.action)).toContain("platform.catalog.refreshCache");

    const all = await db.platformAuditEvent.findMany({ where: { actorId: superId, action: { startsWith: "platform.catalog." } } });
    expect(all.every((r) => r.tenantId === null)).toBe(true);
    expect(await tenantAuditCount()).toBe(0);
  });

  it("no superadmin (OWNER de un consultorio): ForbiddenError en cada escritura del catálogo y no escribe nada", async () => {
    const ex = await newGlobalExercise(`BO2F forbidden ${uniqueSuffix()}`);
    const payer = await newPayer("BO2F forbidden OS");
    const payer2 = await newPayer("BO2F forbidden OS 2");
    const practice = await newPractice("BO2F forbidden práctica");
    const practice2 = await newPractice("BO2F forbidden práctica 2");
    const spec = await newSpecialty("BO2F forbidden especialidad");
    const tagSlug = `bo2f-forbidden-${uniqueSuffix()}`;
    await db.tag.create({ data: { slug: tagSlug, label: "BO2F forbidden", kind: "EQUIPMENT" } });
    tagSlugs.push(tagSlug);
    const media = await db.exerciseMedia.create({
      data: { exerciseId: ex.id, type: "YOUTUBE", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", order: 0 },
    });
    const fd = new FormData();
    fd.set("exerciseId", ex.id);
    fd.set("type", "YOUTUBE");
    fd.set("url", "https://www.youtube.com/watch?v=9bZkp7q19f0");

    asUser(A.userId);
    const calls: [string, () => Promise<unknown>][] = [
      ["createGlobalExercise", () => createGlobalExercise({ name: "X" })],
      ["updateGlobalExercise", () => updateGlobalExercise({ id: ex.id, name: "Pisado" })],
      ["archiveGlobalExercise", () => archiveGlobalExercise(ex.id)],
      ["restoreGlobalExercise", () => restoreGlobalExercise(ex.id)],
      ["hardDeleteGlobalExercise", () => hardDeleteGlobalExercise(ex.id)],
      ["upsertExerciseArticle", () => upsertExerciseArticle({ exerciseId: ex.id, title: "X" })],
      ["createTag", () => createTag({ label: `BO2F nope ${uniqueSuffix()}`, kind: "EQUIPMENT" })],
      ["renameTag", () => renameTag(tagSlug, "Pisado")],
      ["deleteTag", () => deleteTag(tagSlug)],
      ["addExerciseMedia", () => addExerciseMedia(fd)],
      ["deleteExerciseMedia", () => deleteExerciseMedia(media.id)],
      ["reorderExerciseMedia", () => reorderExerciseMedia(ex.id, [media.id])],
      ["updatePayer", () => updatePayer({ id: payer.id, name: "Pisado", kind: "OBRA_SOCIAL", aliases: [] })],
      ["updatePractice", () => updatePractice({ id: practice.id, name: "Pisado", aliases: [] })],
      ["updateSpecialty", () => updateSpecialty({ id: spec.id, name: "Pisado", aliases: [] })],
      ["setCatalogArchived", () => setCatalogArchived({ entity: "payer", id: payer.id, archived: true })],
      ["mergePayer", () => mergePayer({ fromId: payer2.id, intoId: payer.id })],
      ["mergePractice", () => mergePractice({ fromId: practice2.id, intoId: practice.id })],
      ["refreshCatalogCache", () => refreshCatalogCache()],
    ];
    for (const [name, call] of calls) {
      await expect(call(), name).rejects.toBeInstanceOf(ForbiddenError);
    }

    expect((await db.exercise.findUniqueOrThrow({ where: { id: ex.id } })).name).toMatch(/^BO2F forbidden/);
    expect((await db.exercise.findUniqueOrThrow({ where: { id: ex.id } })).archivedAt).toBeNull();
    expect(await db.exerciseArticle.findUnique({ where: { exerciseId: ex.id } })).toBeNull();
    expect(await db.exerciseMedia.count({ where: { exerciseId: ex.id } })).toBe(1);
    expect((await db.tag.findUniqueOrThrow({ where: { slug: tagSlug } })).label).toBe("BO2F forbidden");
    expect((await db.payer.findUniqueOrThrow({ where: { id: payer.id } })).name).toBe("BO2F forbidden OS");
    expect((await db.payer.findUniqueOrThrow({ where: { id: payer2.id } })).archivedAt).toBeNull();
    expect((await db.practice.findUniqueOrThrow({ where: { id: practice.id } })).curatedAt).toBeNull();
    expect((await db.specialty.findUniqueOrThrow({ where: { id: spec.id } })).name).toBe("BO2F forbidden especialidad");
    expect(await db.platformAuditEvent.count({ where: { actorId: A.userId } })).toBe(0);
  });
});
