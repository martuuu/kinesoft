/**
 * B1.3 CAT-admin — curado del catálogo global desde Plataforma, contra la DB
 * real. Se llaman las server actions reales de `lib/catalog-admin.ts` con el
 * `requirePlatformAdmin` real (BO2-F; solo se mockea la sesión de Supabase): un no-superadmin tiene
 * que rebotar en CADA action, y los merges/promoción tienen que repuntar las
 * FKs de filas de varios consultorios en una sola transacción.
 *
 * Fixtures con el cliente owner (BYPASSRLS): el catálogo es global y el rol app
 * no lo puede escribir (RLS solo con policy de lectura).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  listCatalogForAdmin,
  getCatalogDetail,
  searchMergeTargets,
  listPayerPlanProposals,
  listCatalogImportRuns,
  updatePayer,
  updatePractice,
  updateSpecialty,
  setCatalogArchived,
  mergePayer,
  mergePractice,
  promotePayerPlan,
  refreshCatalogCache,
} from "@/lib/catalog-admin";
import { tags } from "@/lib/cache-tags";
import { revalidateTagSpy } from "@/tests/helpers/integration-setup";
import { ForbiddenError } from "@/lib/session";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addService,
  addInsurer,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";
const SRC_DATE = new Date("2026-09-01T00:00:00Z");

describe.skipIf(!RUN)("catalog-admin · Plataforma curado del catálogo", () => {
  let db: PrismaClient;
  let S: EphemeralTenant; // superadmin
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  const payerIds: string[] = [];
  const practiceIds: string[] = [];
  const specialtyIds: string[] = [];

  async function newPayer(name: string, aliases: string[] = []) {
    const s = uniqueSuffix();
    const p = await db.payer.create({
      data: {
        slug: `test-payer-${s}`,
        name,
        matchKey: `test payer ${s}`,
        kind: "OBRA_SOCIAL",
        aliases,
        source: "RNOS",
        sourceDate: SRC_DATE,
      },
    });
    payerIds.push(p.id);
    return p;
  }
  async function newPractice(name: string, extra: { code?: string } = {}) {
    const s = uniqueSuffix();
    const p = await db.practice.create({
      data: {
        slug: `test-practice-${s}`,
        name,
        matchKey: `test practice ${s}`,
        aliases: [],
        code: extra.code,
        source: "NOMENCLADOR_NACIONAL",
        sourceDate: SRC_DATE,
      },
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
  async function newPlan(payerId: string, slug: string, tenantId: string | null = null) {
    return db.payerPlan.create({
      data: { payerId, tenantId, slug, name: slug.toUpperCase(), source: tenantId ? "TENANT" : "CURATED", sourceDate: SRC_DATE },
    });
  }
  async function newCoverage(t: EphemeralTenant, payerPlanId: string) {
    const patientId = await addPatient(db, t);
    const c = await db.coverage.create({ data: { patientId, insurer: "OS test", payerPlanId } });
    return c.id;
  }

  beforeAll(async () => {
    db = ownerClient();
    S = await createEphemeralTenant(db);
    await db.userProfile.update({ where: { id: S.userId }, data: { isPlatformAdmin: true } });
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
  });

  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await S?.cleanup();
    if (db) {
      // Planes globales (tenantId null) no caen con el tenant; PayerPlan.payerId es RESTRICT.
      await db.payerPlan.deleteMany({ where: { payerId: { in: payerIds } } });
      await db.payer.deleteMany({ where: { id: { in: payerIds } } });
      await db.practice.deleteMany({ where: { id: { in: practiceIds } } });
      await db.specialty.deleteMany({ where: { id: { in: specialtyIds } } });
      // BO2-F: las escrituras dejan filas globales en PlatformAuditEvent (solo inserción → modo réplica).
      if (S) {
        await db.$transaction([
          db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
          db.$executeRaw`DELETE FROM "PlatformAuditEvent" WHERE "actorId" = ${S.userId}`,
        ]);
      }
      await db.$disconnect();
    }
  });

  it("no-superadmin (OWNER de un consultorio): Forbidden en cada action y no escribe nada", async () => {
    const payer = await newPayer("Forbidden OS");
    const other = await newPayer("Forbidden OS 2");
    const practice = await newPractice("Forbidden práctica");
    const practice2 = await newPractice("Forbidden práctica 2");
    const spec = await newSpecialty("Forbidden especialidad");
    const proposal = await newPlan(payer.id, `forb-${uniqueSuffix()}`, A.tenantId);

    asUser(A.userId);
    const calls: [string, () => Promise<unknown>][] = [
      ["listCatalogForAdmin", () => listCatalogForAdmin({ entity: "payer" })],
      ["getCatalogDetail", () => getCatalogDetail("payer", payer.id)],
      ["searchMergeTargets", () => searchMergeTargets("payer", "Forbidden", payer.id)],
      ["listPayerPlanProposals", () => listPayerPlanProposals()],
      ["listCatalogImportRuns", () => listCatalogImportRuns()],
      ["updatePayer", () => updatePayer({ id: payer.id, name: "Hackeada", kind: "PREPAGA", aliases: [] })],
      ["updatePractice", () => updatePractice({ id: practice.id, name: "Hackeada", aliases: [] })],
      ["updateSpecialty", () => updateSpecialty({ id: spec.id, name: "Hackeada", aliases: [] })],
      ["setCatalogArchived", () => setCatalogArchived({ entity: "payer", id: payer.id, archived: true })],
      ["mergePayer", () => mergePayer({ fromId: payer.id, intoId: other.id })],
      ["mergePractice", () => mergePractice({ fromId: practice.id, intoId: practice2.id })],
      ["promotePayerPlan", () => promotePayerPlan({ planId: proposal.id })],
      ["refreshCatalogCache", () => refreshCatalogCache()],
    ];
    for (const [name, call] of calls) {
      const err = await call().then(
        () => null,
        (e) => e,
      );
      expect(err, name).toBeInstanceOf(ForbiddenError);
    }

    const after = await db.payer.findUniqueOrThrow({ where: { id: payer.id } });
    expect(after.name).toBe("Forbidden OS");
    expect(after.archivedAt).toBeNull();
    expect(after.curatedAt).toBeNull();
    expect((await db.practice.findUniqueOrThrow({ where: { id: practice.id } })).archivedAt).toBeNull();
    expect((await db.specialty.findUniqueOrThrow({ where: { id: spec.id } })).name).toBe("Forbidden especialidad");
    const plan = await db.payerPlan.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(plan.tenantId).toBe(A.tenantId);
    expect(plan.promotedAt).toBeNull();
  });

  it("editar prestadora marca curatedAt, guarda el nombre viejo como alias y audita", async () => {
    const payer = await newPayer("OSDEPYM", ["Osdepym"]);
    asUser(S.userId);
    const before = Date.now();
    const r = await updatePayer({
      id: payer.id,
      name: "OSDEPYM (Obra Social de Empresarios)",
      kind: "OBRA_SOCIAL",
      registryCode: "4-0080-0",
      province: "",
      aliases: ["osdepym", "  ", "Empresarios"],
    });
    expect(r).toEqual({ ok: true, data: undefined });
    const row = await db.payer.findUniqueOrThrow({ where: { id: payer.id } });
    expect(row.name).toBe("OSDEPYM (Obra Social de Empresarios)");
    expect(row.registryCode).toBe("4-0080-0");
    expect(row.province).toBeNull();
    expect(row.curatedAt).not.toBeNull();
    expect(row.curatedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    // matchKey es la identidad del import: no se recalcula al renombrar.
    expect(row.matchKey).toBe(payer.matchKey);
    // Sin duplicados (case/acentos) y con el nombre anterior como alias.
    expect(row.aliases).toEqual(["osdepym", "Empresarios"]);
    // BO2-F: el catálogo es global → registro de plataforma (tenantId null), NO el log del consultorio del
    // superadmin (antes `ev.tenantId` era S.tenantId: ruido en el log de su OWNER).
    const ev = await db.platformAuditEvent.findFirst({ where: { action: "platform.catalog.payer.update", entityId: payer.id } });
    expect(ev?.tenantId).toBeNull();
    expect(ev?.actorId).toBe(S.userId);
    expect(ev?.payload).toMatchObject({ platform: { actorHomeTenantId: S.tenantId } });
    expect(await db.auditEvent.count({ where: { tenantId: S.tenantId, entityId: payer.id } })).toBe(0);
  });

  it("editar práctica y especialidad también marcan curatedAt; zod rechaza nombre vacío", async () => {
    const practice = await newPractice("Fisiokinesioterapia", { code: "25.01.01" });
    const spec = await newSpecialty("Kinesiologia");
    asUser(S.userId);
    expect((await updatePractice({ id: practice.id, name: "Fisiokinesioterapia", code: "25.01.01", defaultDurationMin: "45", aliases: ["FKT"] })).ok).toBe(true);
    const pr = await db.practice.findUniqueOrThrow({ where: { id: practice.id } });
    expect(pr.curatedAt).not.toBeNull();
    expect(pr.defaultDurationMin).toBe(45);
    expect(pr.aliases).toEqual(["FKT"]);

    expect((await updateSpecialty({ id: spec.id, name: "Kinesiología", aliases: [] })).ok).toBe(true);
    const sp = await db.specialty.findUniqueOrThrow({ where: { id: spec.id } });
    expect(sp.curatedAt).not.toBeNull();
    // "Kinesiologia" sin tilde = mismo alias que el nombre nuevo: no se agrega.
    expect(sp.aliases).toEqual([]);

    const bad = await updateSpecialty({ id: spec.id, name: " ", aliases: [] });
    expect(bad.ok).toBe(false);
  });

  it("listar busca por substring de alias y por código; archivar/desarchivar filtra y marca curatedAt", async () => {
    const tag = uniqueSuffix().replace(/[^a-z0-9]/g, "");
    const payer = await newPayer(`Mutual ${tag}`, [`Alias raro ${tag}`]);
    asUser(S.userId);
    const byAlias = await listCatalogForAdmin({ entity: "payer", q: `raro ${tag}` });
    expect(byAlias.rows.map((r) => r.id)).toEqual([payer.id]);

    const practice = await newPractice(`Práctica ${tag}`, { code: `C-${tag}` });
    const byCode = await listCatalogForAdmin({ entity: "practice", q: `C-${tag}` });
    expect(byCode.rows.map((r) => r.id)).toEqual([practice.id]);

    expect((await setCatalogArchived({ entity: "payer", id: payer.id, archived: true })).ok).toBe(true);
    const archivedRow = await db.payer.findUniqueOrThrow({ where: { id: payer.id } });
    expect(archivedRow.archivedAt).not.toBeNull();
    expect(archivedRow.curatedAt).not.toBeNull();
    expect((await listCatalogForAdmin({ entity: "payer", q: `raro ${tag}` })).rows).toHaveLength(0);
    expect((await listCatalogForAdmin({ entity: "payer", q: `raro ${tag}`, archived: "archived" })).rows).toHaveLength(1);

    expect((await setCatalogArchived({ entity: "payer", id: payer.id, archived: false })).ok).toBe(true);
    expect((await db.payer.findUniqueOrThrow({ where: { id: payer.id } })).archivedAt).toBeNull();
  });

  it("mergePayer repunta Insurer, planes y coberturas de VARIOS consultorios y archiva el origen", async () => {
    const from = await newPayer("O.S. Petroleros", ["OSPe"]);
    const into = await newPayer("OSPE");
    // Plan global gemelo (mismo slug) en ambos + uno solo en el origen + uno de tenant.
    const fromTwin = await newPlan(from.id, "integral");
    const intoTwin = await newPlan(into.id, "integral");
    const fromOnly = await newPlan(from.id, "plan-a");
    const fromTenantPlan = await newPlan(from.id, "propio", A.tenantId);

    const insA = await addInsurer(db, A, { name: `Petroleros ${uniqueSuffix()}` });
    const insB = await addInsurer(db, B, { name: `Petroleros ${uniqueSuffix()}` });
    await db.insurer.updateMany({ where: { id: { in: [insA, insB] } }, data: { payerId: from.id } });
    const covA = await newCoverage(A, fromTwin.id);
    const covB = await newCoverage(B, fromTwin.id);
    const covB2 = await newCoverage(B, fromOnly.id);

    asUser(S.userId);
    const r = await mergePayer({ fromId: from.id, intoId: into.id });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.moved).toMatchObject({ insurers: 2, plans: 2, plansMerged: 1, coverages: 2 });

    const insurers = await db.insurer.findMany({ where: { id: { in: [insA, insB] } }, select: { payerId: true } });
    expect(insurers.every((i) => i.payerId === into.id)).toBe(true);
    // Coberturas del gemelo → plan del destino; el gemelo del origen se borró.
    const covs = await db.coverage.findMany({ where: { id: { in: [covA, covB, covB2] } } });
    expect(covs.find((c) => c.id === covA)?.payerPlanId).toBe(intoTwin.id);
    expect(covs.find((c) => c.id === covB)?.payerPlanId).toBe(intoTwin.id);
    expect(covs.find((c) => c.id === covB2)?.payerPlanId).toBe(fromOnly.id);
    expect(await db.payerPlan.findUnique({ where: { id: fromTwin.id } })).toBeNull();
    expect((await db.payerPlan.findUniqueOrThrow({ where: { id: fromOnly.id } })).payerId).toBe(into.id);
    const tenantPlan = await db.payerPlan.findUniqueOrThrow({ where: { id: fromTenantPlan.id } });
    expect(tenantPlan.payerId).toBe(into.id);
    expect(tenantPlan.tenantId).toBe(A.tenantId);
    expect(await db.payerPlan.count({ where: { payerId: from.id } })).toBe(0);

    const intoRow = await db.payer.findUniqueOrThrow({ where: { id: into.id } });
    // "OSPe" = "OSPE" (el nombre del destino) sin distinguir mayúsculas: no se repite.
    expect(intoRow.aliases).toEqual(["O.S. Petroleros"]);
    expect(intoRow.curatedAt).not.toBeNull();
    const fromRow = await db.payer.findUniqueOrThrow({ where: { id: from.id } });
    expect(fromRow.archivedAt).not.toBeNull();
    expect(fromRow.curatedAt).not.toBeNull();

    const ev = await db.platformAuditEvent.findFirst({ where: { action: "platform.catalog.payer.merge", entityId: into.id } });
    expect(ev?.payload).toMatchObject({ fromId: from.id, intoId: into.id, insurers: 2 });
  });

  it("mergePayer: misma prestadora o destino archivado → error, sin cambios", async () => {
    const a = await newPayer("Merge self");
    const b = await newPayer("Merge archived");
    await db.payer.update({ where: { id: b.id }, data: { archivedAt: new Date() } });
    asUser(S.userId);
    expect((await mergePayer({ fromId: a.id, intoId: a.id })).ok).toBe(false);
    expect((await mergePayer({ fromId: a.id, intoId: b.id })).ok).toBe(false);
    expect((await db.payer.findUniqueOrThrow({ where: { id: a.id } })).archivedAt).toBeNull();
  });

  // Fixer final de B-pre (pendiente de B1): `Coverage.planName` es el cache de
  // display del plan → sigue al gemelo en la misma tx; un gemelo destino
  // archivado se restaura (como en promote) si el plan absorbido estaba vivo.
  it("mergePayer con gemelo: Coverage.planName pasa al nombre del gemelo y un gemelo archivado se restaura", async () => {
    const from = await newPayer("Merge nombres origen");
    const into = await newPayer("Merge nombres destino");
    const fromPlan = await db.payerPlan.create({
      data: { payerId: from.id, slug: "oro", name: "Oro (viejo)", source: "CURATED", sourceDate: SRC_DATE },
    });
    const intoPlan = await db.payerPlan.create({
      data: { payerId: into.id, slug: "oro", name: "Plan Oro", source: "CURATED", sourceDate: SRC_DATE, archivedAt: new Date() },
    });
    const cov = await newCoverage(A, fromPlan.id);
    await db.coverage.update({ where: { id: cov }, data: { planName: "Oro (viejo)" } });

    asUser(S.userId);
    const r = await mergePayer({ fromId: from.id, intoId: into.id });
    if (!r.ok) throw new Error(r.error);
    expect(await db.coverage.findUniqueOrThrow({ where: { id: cov } })).toMatchObject({
      payerPlanId: intoPlan.id,
      planName: "Plan Oro",
    });
    expect((await db.payerPlan.findUniqueOrThrow({ where: { id: intoPlan.id } })).archivedAt).toBeNull();
  });

  it("mergePayer: plan absorbido archivado + gemelo archivado → el gemelo sigue archivado", async () => {
    const from = await newPayer("Merge arch origen");
    const into = await newPayer("Merge arch destino");
    await db.payerPlan.create({
      data: { payerId: from.id, slug: "x", name: "X", source: "CURATED", sourceDate: SRC_DATE, archivedAt: new Date() },
    });
    const intoPlan = await db.payerPlan.create({
      data: { payerId: into.id, slug: "x", name: "X", source: "CURATED", sourceDate: SRC_DATE, archivedAt: new Date() },
    });
    asUser(S.userId);
    expect((await mergePayer({ fromId: from.id, intoId: into.id })).ok).toBe(true);
    expect((await db.payerPlan.findUniqueOrThrow({ where: { id: intoPlan.id } })).archivedAt).not.toBeNull();
  });

  it("mergePractice repunta Service.practiceId de varios consultorios y une PracticeSpecialty", async () => {
    const from = await newPractice("Kinesio motora", { code: "25.01.02" });
    const into = await newPractice("Kinesiología motora");
    const s1 = await newSpecialty("Esp 1");
    const s2 = await newSpecialty("Esp 2");
    await db.practiceSpecialty.createMany({
      data: [
        { practiceId: from.id, specialtyId: s1.id },
        { practiceId: from.id, specialtyId: s2.id },
        { practiceId: into.id, specialtyId: s1.id },
      ],
    });
    const svcA = await addService(db, A, { name: "Motora A" });
    const svcB = await addService(db, B, { name: "Motora B" });
    await db.service.updateMany({ where: { id: { in: [svcA, svcB] } }, data: { practiceId: from.id } });

    asUser(S.userId);
    const r = await mergePractice({ fromId: from.id, intoId: into.id });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.moved).toEqual({ services: 2, specialties: 1 });

    const svcs = await db.service.findMany({ where: { id: { in: [svcA, svcB] } }, select: { practiceId: true } });
    expect(svcs.every((s) => s.practiceId === into.id)).toBe(true);
    const links = await db.practiceSpecialty.findMany({ where: { practiceId: { in: [from.id, into.id] } } });
    expect(links.filter((l) => l.practiceId === from.id)).toHaveLength(0);
    expect(links.filter((l) => l.practiceId === into.id).map((l) => l.specialtyId).sort()).toEqual([s1.id, s2.id].sort());
    const intoRow = await db.practice.findUniqueOrThrow({ where: { id: into.id } });
    expect(intoRow.code).toBe("25.01.02"); // completa el vacío del destino
    expect(intoRow.aliases).toEqual(["Kinesio motora"]);
    expect((await db.practice.findUniqueOrThrow({ where: { id: from.id } })).archivedAt).not.toBeNull();
  });

  it("promotePayerPlan sin gemelo global: el plan pasa a global y aparece/desaparece de propuestas", async () => {
    const payer = await newPayer("Prepaga promo");
    const plan = await newPlan(payer.id, `plan-${uniqueSuffix()}`, A.tenantId);
    const cov = await newCoverage(A, plan.id);
    asUser(S.userId);
    expect((await listPayerPlanProposals()).some((p) => p.id === plan.id && p.globalMatch === null)).toBe(true);

    const r = await promotePayerPlan({ planId: plan.id });
    expect(r).toEqual({ ok: true, data: { planId: plan.id, merged: false } });
    const row = await db.payerPlan.findUniqueOrThrow({ where: { id: plan.id } });
    expect(row.tenantId).toBeNull();
    expect(row.promotedAt).not.toBeNull();
    expect((await db.coverage.findUniqueOrThrow({ where: { id: cov } })).payerPlanId).toBe(plan.id);
    expect((await listPayerPlanProposals()).some((p) => p.id === plan.id)).toBe(false);
    // Ya global: promover de nuevo es error.
    expect((await promotePayerPlan({ planId: plan.id })).ok).toBe(false);
  });

  it("promotePayerPlan con gemelo global: repunta Coverage.payerPlanId al global y archiva la propuesta", async () => {
    const payer = await newPayer("Prepaga gemela");
    const slug = `p-${uniqueSuffix()}`;
    const global = await newPlan(payer.id, slug);
    const proposal = await newPlan(payer.id, slug, B.tenantId);
    const cov1 = await newCoverage(B, proposal.id);
    const cov2 = await newCoverage(B, proposal.id);
    asUser(S.userId);
    expect((await listPayerPlanProposals()).find((p) => p.id === proposal.id)?.globalMatch?.id).toBe(global.id);

    await db.coverage.update({ where: { id: cov1 }, data: { planName: "nombre propuesto" } });
    const r = await promotePayerPlan({ planId: proposal.id });
    expect(r).toEqual({ ok: true, data: { planId: global.id, merged: true } });
    const covs = await db.coverage.findMany({ where: { id: { in: [cov1, cov2] } } });
    expect(covs.every((c) => c.payerPlanId === global.id)).toBe(true);
    // planName (cache de display) sigue al plan global en la misma tx.
    expect(covs.every((c) => c.planName === global.name)).toBe(true);
    const prop = await db.payerPlan.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(prop.archivedAt).not.toBeNull();
    expect(prop.promotedAt).not.toBeNull();
    expect(prop.tenantId).toBe(B.tenantId);
    const ev = await db.platformAuditEvent.findFirst({ where: { action: "platform.catalog.payerPlan.promote", entityId: proposal.id } });
    expect(ev?.payload).toMatchObject({ globalPlanId: global.id, merged: true, proposedBy: B.tenantId, coveragesMoved: 2 });
    expect(ev?.tenantId).toBeNull();
  });

  // Integración B1 (handoff de B1.1): el import corre fuera de Next y no puede
  // invalidar el cache de los consultorios; el botón "Refrescar catálogo" sí.
  it("refreshCatalogCache: superadmin invalida tags.catalog() y audita; no-superadmin no invalida nada", async () => {
    revalidateTagSpy.mockClear();
    asUser(A.userId);
    await expect(refreshCatalogCache()).rejects.toBeInstanceOf(ForbiddenError);
    expect(revalidateTagSpy).not.toHaveBeenCalled();

    asUser(S.userId);
    expect(await refreshCatalogCache()).toEqual({ ok: true, data: undefined });
    expect(revalidateTagSpy).toHaveBeenCalledWith(tags.catalog());
    const ev = await db.platformAuditEvent.findFirst({
      where: { action: "platform.catalog.refreshCache", actorId: S.userId },
    });
    expect(ev?.tenantId).toBeNull();
  });

  it("toda escritura de Plataforma invalida tags.catalog()", async () => {
    const payer = await newPayer("Invalida cache OS");
    asUser(S.userId);
    revalidateTagSpy.mockClear();
    await updatePayer({ id: payer.id, name: "Invalida cache OS 2", kind: "OBRA_SOCIAL", aliases: [] });
    expect(revalidateTagSpy).toHaveBeenCalledWith(tags.catalog());
    revalidateTagSpy.mockClear();
    await setCatalogArchived({ entity: "payer", id: payer.id, archived: true });
    expect(revalidateTagSpy).toHaveBeenCalledWith(tags.catalog());
  });

  it("listCatalogImportRuns devuelve las corridas más recientes primero", async () => {
    const run = await db.catalogImportRun.create({
      data: { file: "payers.csv", sha256: "x".repeat(64), kind: "payers", created: 3, updated: 1, skipped: 2, conflicts: [{ slug: "a" }], ranBy: "test" },
    });
    try {
      asUser(S.userId);
      const runs = await listCatalogImportRuns(5);
      const mine = runs.find((r) => r.id === run.id);
      expect(mine).toMatchObject({ kind: "payers", created: 3, conflictCount: 1 });
    } finally {
      await db.catalogImportRun.delete({ where: { id: run.id } });
    }
  });
});
