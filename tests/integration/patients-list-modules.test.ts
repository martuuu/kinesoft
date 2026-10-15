/**
 * EV1-B · `listPatients` por módulos + ILIKE escapado.
 *
 * Contrato:
 *  - Sin `planes` (vertical GENERAL): `filter: "active" | "no-program"` se
 *    ignora (devuelve lo mismo que "all"), no se hace el include de programs
 *    (un paciente con un plan ACTIVE heredado sale con `activeProgramTitle`
 *    null y 0 sesiones: el efecto observable de no consultar la relación) y
 *    "última visita" sale del último turno COMPLETED.
 *  - Sin `diagnostico`: `diagnosisSlug` se ignora.
 *  - Búsqueda (`q`) y obra social (`insurer`): `%` y `_` son literales. Prisma 5
 *    no escapa `contains` (param `"%%%"` medido contra el Docker).
 *  - Control Kine: los filtros de plan y diagnóstico siguen filtrando.
 *
 * Símbolo real (`listPatients`) contra la DB; solo se mockea la sesión.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { listPatients } from "@/lib/patients";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

/** Paciente con plan ACTIVE + diagnóstico + turno COMPLETED, y otro sin nada. */
async function seed(db: PrismaClient, T: EphemeralTenant, tag: string) {
  const s = uniqueSuffix();
  const withPlan = await addPatient(db, T, { lastName: `ConPlan ${tag} ${s}` });
  const plain = await addPatient(db, T, { lastName: `Plain ${tag} ${s}` });
  const condSlug = `ev1b-${tag}-${s}`;
  const cond = await db.condition.create({ data: { slug: condSlug, name: `Cond ${tag}`, tenantId: T.tenantId } });
  const kase = await db.clinicalCase.create({
    data: { tenantId: T.tenantId, authorId: T.practitionerId, selectedZones: [], refinements: {}, patientId: withPlan },
  });
  await db.diagnosis.create({ data: { caseId: kase.id, conditionId: cond.id, matchScore: 0.9, rank: 1 } });
  await db.treatmentProgram.create({
    data: {
      tenantId: T.tenantId,
      patientId: withPlan,
      caseId: kase.id,
      title: `Plan ${tag}`,
      startDate: new Date("2030-01-01T12:00:00Z"),
      status: "ACTIVE",
    },
  });
  const visitAt = new Date("2026-03-10T13:00:00Z");
  await db.booking.create({
    data: {
      tenantId: T.tenantId,
      patientId: plain,
      practitionerId: T.practitionerId,
      serviceId: T.serviceId,
      scheduledFor: visitAt,
      durationMin: 45,
      status: "COMPLETED",
      idempotencyKey: randomUUID(),
    },
  });
  return { withPlan, plain, condSlug, visitAt };
}

describe.skipIf(!RUN)("EV1-B · listPatients por módulos + ILIKE", () => {
  let db: PrismaClient;
  let G: EphemeralTenant;
  let K: EphemeralTenant;
  let g: Awaited<ReturnType<typeof seed>>;
  let k: Awaited<ReturnType<typeof seed>>;
  let pPct: string;
  let pUnderscore: string;
  let pLookalike: string;
  let sfx: string;

  beforeAll(async () => {
    db = ownerClient();
    G = await createEphemeralTenant(db, { vertical: "GENERAL" });
    K = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "PRO" });
    g = await seed(db, G, "gen");
    k = await seed(db, K, "kine");

    sfx = uniqueSuffix();
    pPct = await addPatient(db, K, { firstName: "Cien%", lastName: `Pct ${sfx}` });
    pUnderscore = await addPatient(db, K, { lastName: `Ruiz_Diaz ${sfx}` });
    pLookalike = await addPatient(db, K, { lastName: `RuizXDiaz ${sfx}` });
    await db.coverage.create({ data: { patientId: pUnderscore, insurer: `OS_${sfx}` } });
    await db.coverage.create({ data: { patientId: pLookalike, insurer: `OSX${sfx}` } });
  });

  afterAll(async () => {
    await G?.cleanup();
    await K?.cleanup();
    await db?.$disconnect();
  });

  it("[EV1-B] GENERAL: «con plan / sin plan» se ignora y devuelve lo mismo que todos", async () => {
    asUser(G.userId);
    const all = ids(await listPatients({}));
    expect(all).toEqual(expect.arrayContaining([g.withPlan, g.plain].sort()));
    expect(ids(await listPatients({ filter: "active" }))).toEqual(all);
    expect(ids(await listPatients({ filter: "no-program" }))).toEqual(all);
  });

  it("[EV1-B] GENERAL: sin include de programs (plan ACTIVE heredado no aparece)", async () => {
    asUser(G.userId);
    const row = (await listPatients({})).find((r) => r.id === g.withPlan);
    expect(row).toBeDefined();
    expect(row!.access).toBe("full");
    expect(row!.activeProgramTitle).toBeNull();
    expect(row!.sessionsTotal).toBe(0);
  });

  it("[EV1-B] GENERAL: «última visita» = último turno COMPLETED", async () => {
    asUser(G.userId);
    const rows = await listPatients({ sort: "lastVisit.desc" });
    const plain = rows.find((r) => r.id === g.plain);
    expect(plain!.lastVisit?.toISOString()).toBe(g.visitAt.toISOString());
    expect(rows[0].id).toBe(g.plain);
  });

  it("[EV1-B] GENERAL: `diagnosisSlug` se ignora", async () => {
    asUser(G.userId);
    const all = ids(await listPatients({}));
    expect(ids(await listPatients({ diagnosisSlug: g.condSlug }))).toEqual(all);
    expect(ids(await listPatients({ diagnosisSlug: "no-existe" }))).toEqual(all);
  });

  it("[EV1-B] control Kine: plan y diagnóstico siguen filtrando y el plan se muestra", async () => {
    asUser(K.userId);
    expect(ids(await listPatients({ filter: "active" }))).toEqual([k.withPlan]);
    const noProgram = ids(await listPatients({ filter: "no-program" }));
    expect(noProgram).toContain(k.plain);
    expect(noProgram).not.toContain(k.withPlan);
    expect(ids(await listPatients({ diagnosisSlug: k.condSlug }))).toEqual([k.withPlan]);
    const row = (await listPatients({})).find((r) => r.id === k.withPlan);
    expect(row!.activeProgramTitle).toBe("Plan kine");
  });

  it("[EV1-B] búsqueda: «%» es literal (no trae todo el directorio)", async () => {
    asUser(K.userId);
    expect(ids(await listPatients({ q: "%" }))).toEqual([pPct]);
  });

  it("[EV1-B] búsqueda: «_» es literal (no matchea cualquier carácter)", async () => {
    asUser(K.userId);
    expect(ids(await listPatients({ q: `Ruiz_Diaz ${sfx}` }))).toEqual([pUnderscore]);
    // Sin comodines la búsqueda sigue siendo "contiene", sin mayúsculas.
    expect(ids(await listPatients({ q: `ruiz` })).filter((id) => id === pUnderscore || id === pLookalike)).toEqual(
      [pUnderscore, pLookalike].sort()
    );
  });

  it("[EV1-B] obra social: «_» es literal", async () => {
    asUser(K.userId);
    expect(ids(await listPatients({ insurer: `OS_${sfx}` }))).toEqual([pUnderscore]);
  });
});
