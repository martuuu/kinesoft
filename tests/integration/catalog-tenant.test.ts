/**
 * B1.4 CAT-tenant — adopción del catálogo global desde el consultorio, contra
 * la DB real (rol app con RLS y owner BYPASSRLS = prod).
 *
 * Lo que se protege: las FK de `Insurer.payerId`, `Service.practiceId` y
 * `Coverage.payerPlanId` SALTEAN RLS, así que la única barrera para no colgar
 * una prestadora/práctica archivada o el plan propuesto por OTRO consultorio
 * es la validación explícita de las actions (`lib/catalog-validate.ts`). Cada
 * caso de IDOR afirma el efecto observable: la fila quedó igual / no se creó.
 *
 * Fixtures de catálogo (globales) con el owner client; se borran al final en
 * orden (PayerPlan es RESTRICT sobre Payer).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  createInsurer,
  updateInsurer,
  addInsurerFromCatalog,
  linkInsurerToPayer,
} from "@/lib/insurers";
import { createService, updateService } from "@/lib/services";
import {
  searchPayers,
  searchPractices,
  listPayerPlans,
  suggestPayerForInsurer,
  listInsurerPayerSuggestions,
  proposePayerPlan,
} from "@/lib/catalog";
import { findUsablePayerPlan } from "@/lib/catalog-validate";
import { setPatientCoverage } from "@/lib/patients";
import { matchKey } from "@/lib/catalog/normalize";
import { runWithRls } from "@/lib/rls";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  addInsurer,
  addPatient,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("catálogo global · adopción desde el consultorio (B1.4)", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let pracUserA: string;
  const s = uniqueSuffix().replace(/[^a-z0-9]/g, "");
  const payerIds: string[] = [];
  const practiceIds: string[] = [];

  // Prestadoras / prácticas / planes globales de la corrida.
  let payer: { id: string; name: string };
  let archivedPayer: { id: string; name: string };
  let practice: { id: string; name: string };
  let archivedPractice: { id: string; name: string };
  let globalPlan: string;
  let archivedPlan: string;
  let planOfB: string;

  async function newPayer(name: string, extra: { archived?: boolean; aliases?: string[] } = {}) {
    const p = await db.payer.create({
      data: {
        slug: `test-payer-${uniqueSuffix()}`,
        name,
        kind: "OBRA_SOCIAL",
        matchKey: matchKey(name),
        aliases: extra.aliases ?? [],
        source: "CURATED",
        sourceDate: new Date("2026-09-01"),
        archivedAt: extra.archived ? new Date() : null,
      },
      select: { id: true, name: true },
    });
    payerIds.push(p.id);
    return p;
  }

  async function newPractice(name: string, extra: { archived?: boolean; duration?: number } = {}) {
    const p = await db.practice.create({
      data: {
        slug: `test-practice-${uniqueSuffix()}`,
        name,
        matchKey: matchKey(name),
        aliases: [],
        defaultDurationMin: extra.duration ?? null,
        source: "CURATED",
        sourceDate: new Date("2026-09-01"),
        archivedAt: extra.archived ? new Date() : null,
      },
      select: { id: true, name: true },
    });
    practiceIds.push(p.id);
    return p;
  }

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
    pracUserA = (await addPractitioner(db, A, "PRACTITIONER")).userId;

    payer = await newPayer(`Prestadora Catalogo ${s}`, { aliases: [`P.C.T. ${s}`] });
    archivedPayer = await newPayer(`Prestadora Archivada ${s}`, { archived: true });
    practice = await newPractice(`Practica Catalogo ${s}`, { duration: 40 });
    archivedPractice = await newPractice(`Practica Archivada ${s}`, { archived: true });

    globalPlan = (
      await db.payerPlan.create({
        data: { payerId: payer.id, name: "Plan 210", slug: `plan-210-${s}`, source: "CURATED", sourceDate: new Date() },
      })
    ).id;
    archivedPlan = (
      await db.payerPlan.create({
        data: {
          payerId: payer.id,
          name: "Plan Viejo",
          slug: `plan-viejo-${s}`,
          source: "CURATED",
          sourceDate: new Date(),
          archivedAt: new Date(),
        },
      })
    ).id;
    planOfB = (
      await db.payerPlan.create({
        data: {
          payerId: payer.id,
          tenantId: B.tenantId,
          name: "Plan de B",
          slug: `plan-de-b-${s}`,
          source: "TENANT",
          sourceDate: new Date(),
        },
      })
    ).id;
  });

  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup(); // sus PayerPlan propuestos caen en cascada con el Tenant
    if (db) {
      await db.payerPlan.deleteMany({ where: { payerId: { in: payerIds } } });
      await db.insurer.updateMany({ where: { payerId: { in: payerIds } }, data: { payerId: null } });
      await db.payer.deleteMany({ where: { id: { in: payerIds } } });
      await db.service.updateMany({ where: { practiceId: { in: practiceIds } }, data: { practiceId: null } });
      await db.practice.deleteMany({ where: { id: { in: practiceIds } } });
      await db.$disconnect();
    }
  });

  // ── authz: requireTenantAdmin adoptado con el mensaje literal ────────────
  it("PRACTITIONER no crea obras sociales ni servicios (mensaje de siempre) y no se escribe nada", async () => {
    asUser(pracUserA);
    await expect(createInsurer({ name: `Hack ${s}`, copagoCents: 0, fixedFeeCents: 0 })).rejects.toThrow(
      "Solo OWNER/ADMIN pueden modificar el catálogo de obras sociales."
    );
    await expect(addInsurerFromCatalog(payer.id)).rejects.toThrow(
      "Solo OWNER/ADMIN pueden modificar el catálogo de obras sociales."
    );
    await expect(createService({ name: `Hack ${s}`, durationMin: 30, priceCents: 0 })).rejects.toThrow(
      "Solo OWNER/ADMIN pueden modificar el catálogo de servicios."
    );
    expect(await db.insurer.count({ where: { tenantId: A.tenantId, name: { contains: "Hack" } } })).toBe(0);
    expect(await db.insurer.count({ where: { tenantId: A.tenantId, payerId: payer.id } })).toBe(0);
    expect(await db.service.count({ where: { tenantId: A.tenantId, name: { contains: "Hack" } } })).toBe(0);
  });

  // ── lecturas ────────────────────────────────────────────────────────────
  it("searchPayers / searchPractices: encuentran por nombre y matchKey; nunca archivados", async () => {
    asUser(A.userId);
    const payers = await searchPayers(`prestadora catálogo ${s}`);
    expect(payers.map((p) => p.id)).toContain(payer.id);
    const all = await searchPayers(s);
    expect(all.map((p) => p.id)).not.toContain(archivedPayer.id);

    const practices = await searchPractices(`Practica ${s}`);
    expect(practices.map((p) => p.id)).toContain(practice.id);
    expect(practices.map((p) => p.id)).not.toContain(archivedPractice.id);
    expect(practices.find((p) => p.id === practice.id)?.defaultDurationMin).toBe(40);
  });

  it("listPayerPlans: globales + propios; ni archivados ni los propuestos por OTRO consultorio", async () => {
    asUser(A.userId);
    const ownProposed = await db.payerPlan.create({
      data: {
        payerId: payer.id,
        tenantId: A.tenantId,
        name: "Plan de A",
        slug: `plan-de-a-${s}`,
        source: "TENANT",
        sourceDate: new Date(),
      },
    });
    const ids = (await listPayerPlans(payer.id)).map((p) => p.id);
    expect(ids).toContain(globalPlan);
    expect(ids).toContain(ownProposed.id);
    expect(ids).not.toContain(archivedPlan);
    expect(ids).not.toContain(planOfB);
    const own = (await listPayerPlans(payer.id)).find((p) => p.id === ownProposed.id);
    expect(own?.proposed).toBe(true);
    // Prestadora archivada: sin planes.
    expect(await listPayerPlans(archivedPayer.id)).toEqual([]);
  });

  it("suggestPayerForInsurer: por matchKey del nombre y por alias; nunca una archivada", async () => {
    asUser(A.userId);
    expect((await suggestPayerForInsurer(`  PRESTADORA  catálogo ${s} `))?.id).toBe(payer.id);
    expect((await suggestPayerForInsurer(`PCT ${s}`))?.id).toBe(payer.id); // alias "P.C.T. …"
    expect(await suggestPayerForInsurer(`Prestadora Archivada ${s}`)).toBeNull();
    expect(await suggestPayerForInsurer("")).toBeNull();
  });

  // ── Obras sociales ──────────────────────────────────────────────────────
  it("listInsurerPayerSuggestions sugiere sin vincular (sin auto-link) y nunca a Particular", async () => {
    asUser(A.userId);
    const insId = await addInsurer(db, A, { name: `prestadora catalogo ${s}` });
    const sug = await listInsurerPayerSuggestions();
    expect(sug[insId]?.id).toBe(payer.id);
    expect(sug[A.particularInsurerId]).toBeUndefined();
    expect((await db.insurer.findUniqueOrThrow({ where: { id: insId } })).payerId).toBeNull();

    // Vincular, y desvincular sin tocar nombre ni montos.
    expect((await linkInsurerToPayer(insId, payer.id)).ok).toBe(true);
    expect((await db.insurer.findUniqueOrThrow({ where: { id: insId } })).payerId).toBe(payer.id);
    expect((await listInsurerPayerSuggestions())[insId]).toBeUndefined();
    expect((await linkInsurerToPayer(insId, null)).ok).toBe(true);
    const after = await db.insurer.findUniqueOrThrow({ where: { id: insId } });
    expect(after.payerId).toBeNull();
    expect(after.name).toBe(`prestadora catalogo ${s}`);
    await db.insurer.delete({ where: { id: insId } });
  });

  it("addInsurerFromCatalog crea la OS con nombre y payerId; copago/monto en 0; la segunda vez avisa que existe", async () => {
    asUser(A.userId);
    const r = await addInsurerFromCatalog(payer.id);
    expect(r.ok).toBe(true);
    if (!r.ok || r.data.status !== "created") throw new Error("esperaba created");
    const row = await db.insurer.findUniqueOrThrow({ where: { id: r.data.insurerId } });
    expect(row).toMatchObject({ tenantId: A.tenantId, name: payer.name, payerId: payer.id, copagoCents: 0, fixedFeeCents: 0 });

    const again = await addInsurerFromCatalog(payer.id);
    expect(again).toEqual({ ok: true, data: { status: "exists", insurerId: row.id, linkedPayerId: payer.id } });
    expect(await db.insurer.count({ where: { tenantId: A.tenantId, name: payer.name } })).toBe(1);
    await db.insurer.delete({ where: { id: row.id } });
  });

  it("addInsurerFromCatalog con una OS manual del mismo nombre: no duplica ni pisa, ofrece vincular", async () => {
    asUser(A.userId);
    const manual = await addInsurer(db, A, { name: payer.name, copagoCents: 123_400 });
    const r = await addInsurerFromCatalog(payer.id);
    expect(r).toEqual({ ok: true, data: { status: "exists", insurerId: manual, linkedPayerId: null } });
    const row = await db.insurer.findUniqueOrThrow({ where: { id: manual } });
    expect(row.payerId).toBeNull();
    expect(row.copagoCents).toBe(123_400);
    await db.insurer.delete({ where: { id: manual } });
  });

  it("IDOR payerId: archivada / inexistente → rechazo en las 4 vías, nada escrito", async () => {
    asUser(A.userId);
    const insId = await addInsurer(db, A, { name: `OS libre ${s}` });

    for (const bad of [archivedPayer.id, "no-existe-payer-id"]) {
      const add = await addInsurerFromCatalog(bad);
      expect(add.ok).toBe(false);
      const link = await linkInsurerToPayer(insId, bad);
      expect(link.ok).toBe(false);
      const upd = await updateInsurer(insId, { payerId: bad });
      expect(upd.ok).toBe(false);
      const created = await createInsurer({ name: `Con payer malo ${s}`, copagoCents: 0, fixedFeeCents: 0, payerId: bad });
      expect(created.ok).toBe(false);
    }
    expect((await db.insurer.findUniqueOrThrow({ where: { id: insId } })).payerId).toBeNull();
    expect(await db.insurer.count({ where: { tenantId: A.tenantId, name: `Con payer malo ${s}` } })).toBe(0);
    expect(await db.insurer.count({ where: { tenantId: A.tenantId, name: archivedPayer.name } })).toBe(0);

    // OS de OTRO consultorio: no se vincula desde A.
    const insOfB = await addInsurer(db, B, { name: `OS de B ${s}` });
    expect((await linkInsurerToPayer(insOfB, payer.id)).ok).toBe(false);
    expect((await db.insurer.findUniqueOrThrow({ where: { id: insOfB } })).payerId).toBeNull();

    // Particular no es una prestadora.
    expect((await linkInsurerToPayer(A.particularInsurerId, payer.id)).ok).toBe(false);
    expect((await updateInsurer(A.particularInsurerId, { payerId: payer.id })).ok).toBe(false);
    expect((await db.insurer.findUniqueOrThrow({ where: { id: A.particularInsurerId } })).payerId).toBeNull();
    await db.insurer.delete({ where: { id: insId } });
  });

  it("prestadora archivada DESPUÉS de vincular: editar el copago sigue andando", async () => {
    asUser(A.userId);
    const late = await newPayer(`Prestadora Tardia ${s}`);
    const created = await createInsurer({ name: `OS tardía ${s}`, copagoCents: 0, fixedFeeCents: 0, payerId: late.id });
    if (!created.ok) throw new Error(created.error);
    await db.payer.update({ where: { id: late.id }, data: { archivedAt: new Date() } });
    const r = await updateInsurer(created.data.id, { copagoCents: 50_000, payerId: late.id });
    expect(r.ok).toBe(true);
    const row = await db.insurer.findUniqueOrThrow({ where: { id: created.data.id } });
    expect(row.copagoCents).toBe(50_000);
    expect(row.payerId).toBe(late.id);
    await db.insurer.delete({ where: { id: created.data.id } });
  });

  // ── Servicios ───────────────────────────────────────────────────────────
  it("createService/updateService con práctica: válida se guarda; archivada/inexistente → rechazo sin escribir", async () => {
    asUser(A.userId);
    const ok = await createService({ name: `Svc cat ${s}`, durationMin: 40, priceCents: 1000, practiceId: practice.id });
    if (!ok.ok) throw new Error(ok.error);
    expect((await db.service.findUniqueOrThrow({ where: { id: ok.data.id } })).practiceId).toBe(practice.id);

    for (const bad of [archivedPractice.id, "no-existe-practice-id"]) {
      const c = await createService({ name: `Svc malo ${s}`, durationMin: 30, priceCents: 0, practiceId: bad });
      expect(c.ok).toBe(false);
      const u = await updateService(ok.data.id, { practiceId: bad });
      expect(u.ok).toBe(false);
    }
    expect(await db.service.count({ where: { tenantId: A.tenantId, name: `Svc malo ${s}` } })).toBe(0);
    expect((await db.service.findUniqueOrThrow({ where: { id: ok.data.id } })).practiceId).toBe(practice.id);

    // Quitar la práctica ("" = sin práctica).
    expect((await updateService(ok.data.id, { practiceId: "" })).ok).toBe(true);
    expect((await db.service.findUniqueOrThrow({ where: { id: ok.data.id } })).practiceId).toBeNull();
    await db.service.delete({ where: { id: ok.data.id } });
  });

  it("práctica archivada DESPUÉS de asignarla: editar el precio (mandando el mismo practiceId) sigue andando", async () => {
    asUser(A.userId);
    const late = await newPractice(`Practica Tardia ${s}`);
    const c = await createService({ name: `Svc tardío ${s}`, durationMin: 30, priceCents: 0, practiceId: late.id });
    if (!c.ok) throw new Error(c.error);
    await db.practice.update({ where: { id: late.id }, data: { archivedAt: new Date() } });
    const u = await updateService(c.data.id, { priceCents: 9_900, practiceId: late.id });
    expect(u.ok).toBe(true);
    expect((await db.service.findUniqueOrThrow({ where: { id: c.data.id } })).priceCents).toBe(9_900);
    await db.service.delete({ where: { id: c.data.id } });
  });

  // ── Planes propuestos ───────────────────────────────────────────────────
  it("proposePayerPlan crea un PayerPlan del tenant (source=TENANT), idempotente; si ya existe global devuelve ese", async () => {
    asUser(pracUserA); // cualquier miembro puede proponer (picker de la ficha)
    const r = await proposePayerPlan(payer.id, `Plan Nuevo ${s}`);
    if (!r.ok) throw new Error(r.error);
    expect(r.data.created).toBe(true);
    const row = await db.payerPlan.findUniqueOrThrow({ where: { id: r.data.id } });
    expect(row).toMatchObject({ payerId: payer.id, tenantId: A.tenantId, source: "TENANT", promotedAt: null });

    const again = await proposePayerPlan(payer.id, `  plan nuevo ${s} `);
    expect(again).toEqual({ ok: true, data: { id: r.data.id, created: false } });

    const dupGlobal = await proposePayerPlan(payer.id, "PLAN 210");
    expect(dupGlobal).toEqual({ ok: true, data: { id: globalPlan, created: false } });

    // B no ve lo que propuso A.
    asUser(B.userId);
    expect((await listPayerPlans(payer.id)).map((p) => p.id)).not.toContain(r.data.id);
  });

  it("proposePayerPlan: prestadora archivada / inexistente → rechazo, nada escrito", async () => {
    asUser(A.userId);
    const before = await db.payerPlan.count({ where: { tenantId: A.tenantId } });
    expect((await proposePayerPlan(archivedPayer.id, "Plan X")).ok).toBe(false);
    expect((await proposePayerPlan("no-existe-payer-id", "Plan X")).ok).toBe(false);
    expect((await proposePayerPlan(payer.id, "   ")).ok).toBe(false);
    expect(await db.payerPlan.count({ where: { tenantId: A.tenantId } })).toBe(before);
  });

  // ── Validador de payerPlanId (lo usa setPatientCoverage vía handoff) ───────
  it("findUsablePayerPlan: global sí; propio sí; de OTRO tenant / archivado / inexistente / de otra prestadora → null", async () => {
    const own = await db.payerPlan.findFirstOrThrow({ where: { tenantId: A.tenantId, payerId: payer.id } });
    const other = await newPayer(`Otra Prestadora ${s}`);
    const check = (id: string, payerId?: string) =>
      runWithRls(A.tenantId, (tx) => findUsablePayerPlan(tx, A.tenantId, id, payerId));

    expect((await check(globalPlan))?.id).toBe(globalPlan);
    expect((await check(globalPlan, payer.id))?.id).toBe(globalPlan);
    expect((await check(own.id))?.id).toBe(own.id);
    expect(await check(planOfB)).toBeNull();
    expect(await check(archivedPlan)).toBeNull();
    expect(await check("no-existe-plan-id")).toBeNull();
    expect(await check(globalPlan, other.id)).toBeNull();
  });
  // ── Búsqueda por alias con matchKey del lado de la app (handoff de B1.1) ──
  it("searchPayers / searchPractices encuentran por la matchKey de un alias (no solo la escritura exacta)", async () => {
    asUser(A.userId);
    // Alias "P.C.T. <s>": el nombre no contiene "pct" y `aliases has` exigía
    // la escritura literal con puntos.
    expect((await searchPayers(`pct ${s}`)).map((p) => p.id)).toContain(payer.id);
    expect((await searchPayers(`P.C.T. ${s}`)).map((p) => p.id)).toContain(payer.id);

    const aliased = await db.practice.create({
      data: {
        slug: `test-practice-${uniqueSuffix()}`,
        name: `Practica Con Alias ${s}`,
        matchKey: matchKey(`Practica Con Alias ${s}`),
        aliases: [`R.P.G. Postural ${s}`],
        source: "CURATED",
        sourceDate: new Date("2026-09-01"),
      },
      select: { id: true },
    });
    practiceIds.push(aliased.id);
    expect((await searchPractices(`rpg ${s}`)).map((p) => p.id)).toContain(aliased.id);
    // Un alias de una práctica archivada no la resucita.
    await db.practice.update({ where: { id: aliased.id }, data: { archivedAt: new Date() } });
    expect((await searchPractices(`rpg ${s}`)).map((p) => p.id)).not.toContain(aliased.id);
  });

  // ── Ficha del paciente: plan del catálogo (Coverage.payerPlanId) ───────────
  describe("setPatientCoverage con payerPlanId (IDOR: la FK saltea RLS)", () => {
    let linkedIns: string;
    let unlinkedIns: string;
    let patientId: string;
    let ownPlan: string;
    let otherPayerPlan: string;

    beforeAll(async () => {
      linkedIns = await addInsurer(db, A, { name: `OS Vinculada ${s}` });
      await db.insurer.update({ where: { id: linkedIns }, data: { payerId: payer.id } });
      unlinkedIns = await addInsurer(db, A, { name: `OS Sin Catalogo ${s}` });
      patientId = await addPatient(db, A);
      ownPlan = (
        await db.payerPlan.create({
          data: {
            payerId: payer.id,
            tenantId: A.tenantId,
            name: "Plan Propio Cobertura",
            slug: `plan-propio-cob-${s}`,
            source: "TENANT",
            sourceDate: new Date(),
          },
        })
      ).id;
      const other = await newPayer(`Prestadora Ajena ${s}`);
      otherPayerPlan = (
        await db.payerPlan.create({
          data: { payerId: other.id, name: "Plan Ajeno", slug: `plan-ajeno-${s}`, source: "CURATED", sourceDate: new Date() },
        })
      ).id;
    });

    const coverage = () =>
      db.coverage.findFirst({
        where: { patientId },
        orderBy: { id: "desc" },
        select: { insurerId: true, payerPlanId: true, planName: true, memberId: true },
      });

    it("plan global de la prestadora vinculada: guarda payerPlanId y planName = nombre del plan", async () => {
      asUser(A.userId);
      const r = await setPatientCoverage({
        patientId,
        insurerId: linkedIns,
        payerPlanId: globalPlan,
        planName: "texto ignorado",
        memberId: "111",
      });
      expect(r).toEqual({ ok: true, data: undefined });
      expect(await coverage()).toEqual({ insurerId: linkedIns, payerPlanId: globalPlan, planName: "Plan 210", memberId: "111" });
    });

    it("plan propuesto por el mismo consultorio también vale", async () => {
      asUser(A.userId);
      expect((await setPatientCoverage({ patientId, insurerId: linkedIns, payerPlanId: ownPlan, memberId: "111" })).ok).toBe(true);
      expect(await coverage()).toMatchObject({ payerPlanId: ownPlan, planName: "Plan Propio Cobertura" });
    });

    it("plan de OTRO consultorio / archivado / de otra prestadora / inexistente / OS sin catálogo / Particular → rechazo, Coverage intacta", async () => {
      asUser(A.userId);
      const before = await coverage();
      const attempts = [
        { insurerId: linkedIns, payerPlanId: planOfB },
        { insurerId: linkedIns, payerPlanId: archivedPlan },
        { insurerId: linkedIns, payerPlanId: otherPayerPlan },
        { insurerId: linkedIns, payerPlanId: "no-existe-plan-id" },
        { insurerId: unlinkedIns, payerPlanId: globalPlan },
        { insurerName: `Colada ${s}`, payerPlanId: globalPlan },
        { payerPlanId: globalPlan },
      ];
      for (const a of attempts) {
        const r = await setPatientCoverage({ patientId, memberId: "999", ...a });
        expect(r, JSON.stringify(a)).toEqual({ ok: false, error: "Plan no encontrado para esta obra social." });
      }
      expect(await coverage()).toEqual(before);
    });

    it("sin payerPlanId (texto libre u OS nueva) el vínculo se limpia; pasar a Particular sin copago borra la fila", async () => {
      asUser(A.userId);
      await setPatientCoverage({ patientId, insurerId: linkedIns, payerPlanId: globalPlan });
      expect((await setPatientCoverage({ patientId, insurerId: unlinkedIns, planName: "Libre" })).ok).toBe(true);
      expect(await coverage()).toMatchObject({ insurerId: unlinkedIns, payerPlanId: null, planName: "Libre" });

      await setPatientCoverage({ patientId, insurerId: linkedIns, payerPlanId: globalPlan });
      expect((await setPatientCoverage({ patientId })).ok).toBe(true);
      expect(await coverage()).toBeNull();
    });

    it("Particular con copago propio conservado: la fila queda Particular sin plan", async () => {
      asUser(A.userId);
      await setPatientCoverage({ patientId, insurerId: linkedIns, payerPlanId: globalPlan });
      await db.coverage.updateMany({ where: { patientId }, data: { copagoCents: 5_000_00 } });
      expect((await setPatientCoverage({ patientId })).ok).toBe(true);
      expect(await coverage()).toMatchObject({ payerPlanId: null, planName: null });
    });
  });
});
