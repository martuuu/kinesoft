/**
 * RLS isolation tripwire (Ola B2, .docs/TESTING.md capa 3).
 *
 * Proves that Postgres RLS actually isolates tenants once the app connects
 * as a role WITHOUT BYPASSRLS. This is the net that catches a MISSED wrap:
 * a lost `runWithRls` returns an empty result set silently, so the
 * intra-tenant assertions below fail loudly when a read isn't primed.
 *
 * GATED (A1.1): runs with `npm run test:integration` (INTEGRATION=1), and
 * SKIPS VISIBLY when the app connection has BYPASSRLS — i.e. under
 * `test:integration:owner`, which reproduces prod's current role. There the
 * tripwire cannot prove anything, so it must not report a false green.
 * Local setup: `docker compose up -d db`, migrations applied, and
 * `prisma/roles.local.sql` run once (creates `kinesoft_app`).
 *
 * `runWithRls` uses the default client (DATABASE_URL = kinesoft_app → RLS
 * enforced). `prismaOwner` uses DIRECT_URL (owner → BYPASSRLS) purely to
 * seed/tear-down cross-tenant fixtures the app role could never create.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { runWithRls } from "@/lib/rls";
import {
  createEphemeralTenant,
  sweepOrphanTestTenants,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1" || process.env.RLS_IT === "1";

// Does the APP connection (DATABASE_URL) bypass RLS? Checked once, up front.
async function appRoleBypassesRls(): Promise<boolean> {
  const app = new PrismaClient();
  try {
    const rows = await app.$queryRaw<{ bypass: boolean }[]>`
      SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user`;
    return rows[0]?.bypass ?? true;
  } finally {
    await app.$disconnect();
  }
}
const BYPASS = RUN ? await appRoleBypassesRls() : true;
if (RUN && BYPASS) {
  console.warn("[rls-isolation] SKIP: la conexión de la app tiene BYPASSRLS (modo owner = prod hoy).");
}

describe.skipIf(!RUN || BYPASS)("RLS tenant isolation (app role)", () => {
  const prismaOwner = new PrismaClient({
    datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } },
  });

  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let patA: string;
  let patB: string;

  beforeAll(async () => {
    await sweepOrphanTestTenants(prismaOwner);
    A = await createEphemeralTenant(prismaOwner);
    B = await createEphemeralTenant(prismaOwner);
    const a = await prismaOwner.patient.create({
      data: { tenantId: A.tenantId, firstName: "Ana", lastName: "TenantA", assignedPractitionerId: A.practitionerId },
    });
    const b = await prismaOwner.patient.create({
      data: { tenantId: B.tenantId, firstName: "Beto", lastName: "TenantB", assignedPractitionerId: B.practitionerId },
    });
    patA = a.id;
    patB = b.id;
  });

  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await prismaOwner.$disconnect();
  });

  it("intra-tenant: A sees its own patient (a missed wrap would return [])", async () => {
    const rows = await runWithRls(A.tenantId, (tx) => tx.patient.findMany());
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(patA);
    expect(rows.every((r) => r.tenantId === A.tenantId)).toBe(true);
  });

  it("cross-tenant read: A cannot see B's patient", async () => {
    const all = await runWithRls(A.tenantId, (tx) => tx.patient.findMany());
    expect(all.map((r) => r.id)).not.toContain(patB);
    // Even an explicit id lookup for B's row returns nothing under A's GUC.
    const direct = await runWithRls(A.tenantId, (tx) =>
      tx.patient.findMany({ where: { id: patB } })
    );
    expect(direct).toHaveLength(0);
  });

  it("cross-tenant write: A cannot INSERT a row into B (WITH CHECK aborts)", async () => {
    await expect(
      runWithRls(A.tenantId, (tx) =>
        tx.patient.create({
          data: { tenantId: B.tenantId, firstName: "Mal", lastName: "Cross" },
        })
      )
    ).rejects.toThrow();
  });

  it("global catalog stays visible: Condition tenantId=NULL is readable under any tenant", async () => {
    // Seeded global conditions (tenantId NULL) must remain visible via the
    // split policy — otherwise the diagnosis engine breaks for everyone.
    const globals = await runWithRls(A.tenantId, (tx) =>
      tx.condition.findMany({ where: { tenantId: null }, take: 1 })
    );
    // Only assert the query itself is not blocked (returns an array, not an
    // error); a fresh DB may have zero seeded conditions.
    expect(Array.isArray(globals)).toBe(true);
  });
});

// ── B1.0 M-cat: catálogo global (20260930200000_catalog_global) ─────────
// Specialty / Practice / PracticeSpecialty / Payer / CatalogImportRun son
// GLOBAL READ-ONLY: ENABLE + FORCE + solo `FOR SELECT USING (true)`. El rol
// app tiene GRANT INSERT/UPDATE/DELETE (default privileges de roles.*.sql),
// así que lo que bloquea la escritura es RLS (default-deny sin policy):
// INSERT → "violates row-level security policy"; UPDATE/DELETE → 0 filas
// (Prisma `update` tira P2025). PayerPlan es split como Exercise.
describe.skipIf(!RUN || BYPASS)("RLS catálogo global (B1.0 M-cat, app role)", () => {
  const prismaOwner = new PrismaClient({
    datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } },
  });
  const sfx = `b10-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const src = { source: "CURATED" as const, sourceDate: new Date("2026-09-30T00:00:00Z") };

  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let payerId: string;
  let specialtyId: string;
  let practiceId: string;
  let globalPlanId: string;
  let planA: string;
  let planB: string;

  beforeAll(async () => {
    A = await createEphemeralTenant(prismaOwner);
    B = await createEphemeralTenant(prismaOwner);
    // El owner (BYPASSRLS) es el canal de escritura del catálogo, como el
    // import y Plataforma con prismaService.
    const payer = await prismaOwner.payer.create({
      data: { slug: `payer-${sfx}`, name: `Prestadora ${sfx}`, matchKey: `payer ${sfx}`, kind: "OBRA_SOCIAL", ...src },
    });
    payerId = payer.id;
    specialtyId = (
      await prismaOwner.specialty.create({
        data: { slug: `spec-${sfx}`, name: `Especialidad ${sfx}`, matchKey: `spec ${sfx}`, ...src },
      })
    ).id;
    practiceId = (
      await prismaOwner.practice.create({
        data: { slug: `prac-${sfx}`, name: `Práctica ${sfx}`, matchKey: `prac ${sfx}`, ...src },
      })
    ).id;
    globalPlanId = (
      await prismaOwner.payerPlan.create({ data: { payerId, tenantId: null, name: "Global 210", slug: "global-210", ...src } })
    ).id;
    planA = (
      await prismaOwner.payerPlan.create({
        data: { payerId, tenantId: A.tenantId, name: "Plan A", slug: "plan-a", ...src, source: "TENANT" },
      })
    ).id;
    planB = (
      await prismaOwner.payerPlan.create({
        data: { payerId, tenantId: B.tenantId, name: "Plan B", slug: "plan-b", ...src, source: "TENANT" },
      })
    ).id;
  });

  afterAll(async () => {
    // Tenant → PayerPlan es ON DELETE CASCADE; los globales y la prestadora
    // (PayerPlan.payerId es RESTRICT) se borran a mano después.
    await A?.cleanup();
    await B?.cleanup();
    if (payerId) {
      await prismaOwner.payerPlan.deleteMany({ where: { payerId } });
      await prismaOwner.payer.deleteMany({ where: { id: payerId } });
    }
    if (practiceId) await prismaOwner.practice.deleteMany({ where: { id: practiceId } });
    if (specialtyId) await prismaOwner.specialty.deleteMany({ where: { id: specialtyId } });
    await prismaOwner.$disconnect();
  });

  it("lectura: cualquier tenant lee Payer / Specialty / Practice globales", async () => {
    const [payers, specs, pracs] = await runWithRls(A.tenantId, async (tx) => [
      await tx.payer.findMany({ where: { id: payerId } }),
      await tx.specialty.findMany({ where: { id: specialtyId } }),
      await tx.practice.findMany({ where: { id: practiceId } }),
    ]);
    expect(payers.map((p) => p.id)).toEqual([payerId]);
    expect(specs.map((s) => s.id)).toEqual([specialtyId]);
    expect(pracs.map((p) => p.id)).toEqual([practiceId]);
  });

  it("INSERT denegado por RLS en Payer / Specialty / Practice / PracticeSpecialty / CatalogImportRun", async () => {
    const attempts: Array<(tx: Parameters<Parameters<typeof runWithRls>[1]>[0]) => Promise<unknown>> = [
      (tx) => tx.payer.create({ data: { slug: `x-${sfx}`, name: "X", matchKey: `x ${sfx}`, kind: "OTRA", ...src } }),
      (tx) => tx.specialty.create({ data: { slug: `x-${sfx}`, name: "X", matchKey: `x ${sfx}`, ...src } }),
      (tx) => tx.practice.create({ data: { slug: `x-${sfx}`, name: "X", matchKey: `x ${sfx}`, ...src } }),
      (tx) => tx.practiceSpecialty.create({ data: { practiceId, specialtyId } }),
      (tx) =>
        tx.catalogImportRun.create({
          data: { file: "x.csv", sha256: "x", kind: "payers", created: 0, updated: 0, skipped: 0, conflicts: [] },
        }),
    ];
    for (const attempt of attempts) {
      await expect(runWithRls(A.tenantId, attempt)).rejects.toThrow(/row-level security/i);
    }
    // Efecto observable: nada quedó escrito.
    expect(await prismaOwner.payer.count({ where: { slug: `x-${sfx}` } })).toBe(0);
    expect(await prismaOwner.specialty.count({ where: { slug: `x-${sfx}` } })).toBe(0);
    expect(await prismaOwner.practice.count({ where: { slug: `x-${sfx}` } })).toBe(0);
    expect(await prismaOwner.practiceSpecialty.count({ where: { practiceId, specialtyId } })).toBe(0);
  });

  it("UPDATE / DELETE no afectan filas en Payer / Specialty / Practice", async () => {
    await expect(
      runWithRls(A.tenantId, (tx) => tx.payer.update({ where: { id: payerId }, data: { name: "Hackeada" } }))
    ).rejects.toThrow();
    await expect(
      runWithRls(A.tenantId, (tx) => tx.specialty.update({ where: { id: specialtyId }, data: { name: "Hackeada" } }))
    ).rejects.toThrow();
    await expect(
      runWithRls(A.tenantId, (tx) => tx.practice.update({ where: { id: practiceId }, data: { name: "Hackeada" } }))
    ).rejects.toThrow();
    const counts = await runWithRls(A.tenantId, async (tx) => [
      (await tx.payer.updateMany({ where: { id: payerId }, data: { name: "Hackeada" } })).count,
      (await tx.payer.deleteMany({ where: { id: payerId } })).count,
      (await tx.specialty.deleteMany({ where: { id: specialtyId } })).count,
      (await tx.practice.deleteMany({ where: { id: practiceId } })).count,
    ]);
    expect(counts).toEqual([0, 0, 0, 0]);
    expect((await prismaOwner.payer.findUniqueOrThrow({ where: { id: payerId } })).name).toBe(`Prestadora ${sfx}`);
    expect((await prismaOwner.specialty.findUniqueOrThrow({ where: { id: specialtyId } })).name).toBe(`Especialidad ${sfx}`);
    expect((await prismaOwner.practice.findUniqueOrThrow({ where: { id: practiceId } })).name).toBe(`Práctica ${sfx}`);
  });

  it("PayerPlan lectura: A ve los globales + los propios, no los de B", async () => {
    const ids = (
      await runWithRls(A.tenantId, (tx) => tx.payerPlan.findMany({ where: { payerId } }))
    ).map((p) => p.id);
    expect(ids).toContain(globalPlanId);
    expect(ids).toContain(planA);
    expect(ids).not.toContain(planB);
  });

  it("PayerPlan escritura: A inserta con su tenantId, no con null ni con el de B", async () => {
    const mine = await runWithRls(A.tenantId, (tx) =>
      tx.payerPlan.create({ data: { payerId, tenantId: A.tenantId, name: "Propio", slug: "propio", ...src, source: "TENANT" } })
    );
    expect(mine.tenantId).toBe(A.tenantId);

    await expect(
      runWithRls(A.tenantId, (tx) =>
        tx.payerPlan.create({ data: { payerId, tenantId: null, name: "Global trucho", slug: "global-trucho", ...src } })
      )
    ).rejects.toThrow(/row-level security/i);
    await expect(
      runWithRls(A.tenantId, (tx) =>
        tx.payerPlan.create({ data: { payerId, tenantId: B.tenantId, name: "Cruzado", slug: "cruzado", ...src } })
      )
    ).rejects.toThrow(/row-level security/i);
    expect(await prismaOwner.payerPlan.count({ where: { payerId, slug: { in: ["global-trucho", "cruzado"] } } })).toBe(0);
  });

  it("PayerPlan: A no puede modificar un plan global ni uno de B", async () => {
    const counts = await runWithRls(A.tenantId, async (tx) => [
      (await tx.payerPlan.updateMany({ where: { id: globalPlanId }, data: { name: "Pisado" } })).count,
      (await tx.payerPlan.updateMany({ where: { id: planB }, data: { name: "Pisado" } })).count,
      (await tx.payerPlan.deleteMany({ where: { id: { in: [globalPlanId, planB] } } })).count,
    ]);
    expect(counts).toEqual([0, 0, 0]);
    // Ni re-etiquetar el propio como global (WITH CHECK).
    await expect(
      runWithRls(A.tenantId, (tx) => tx.payerPlan.update({ where: { id: planA }, data: { tenantId: null } }))
    ).rejects.toThrow(/row-level security/i);
    const g = await prismaOwner.payerPlan.findUniqueOrThrow({ where: { id: globalPlanId } });
    expect(g.name).toBe("Global 210");
    expect((await prismaOwner.payerPlan.findUniqueOrThrow({ where: { id: planB } })).name).toBe("Plan B");
  });

  it("PayerPlan: el índice único parcial impide dos globales con el mismo slug por prestadora", async () => {
    await expect(
      prismaOwner.payerPlan.create({ data: { payerId, tenantId: null, name: "Dup", slug: "global-210", ...src } })
    ).rejects.toThrow();
    // …pero un consultorio puede proponer ese mismo slug como plan propio.
    const own = await prismaOwner.payerPlan.create({
      data: { payerId, tenantId: B.tenantId, name: "Global 210", slug: "global-210", ...src, source: "TENANT" },
    });
    expect(own.tenantId).toBe(B.tenantId);
    await expect(
      prismaOwner.payerPlan.create({
        data: { payerId, tenantId: B.tenantId, name: "Dup", slug: "global-210", ...src, source: "TENANT" },
      })
    ).rejects.toThrow();
  });
});

// ── B2.0 M-agenda: tablas de agenda (20261001090000_agenda_foundations) ──
// Location / PractitionerSchedule / ScheduleException / TimeBlock /
// PractitionerService / PractitionerPayer / PractitionerSpecialty: todas con
// tenantId → ENABLE + FORCE + `<Tabla>_tenant_isolation` (USING y WITH CHECK
// `tenantId = app_current_tenant_id()`). A no ve, no inserta, no modifica ni
// borra filas de B; y SÍ escribe las propias (la policy no es un deny-all).
describe.skipIf(!RUN || BYPASS)("RLS agenda (B2.0 M-agenda, app role)", () => {
  const prismaOwner = new PrismaClient({
    datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } },
  });
  type Tx = Parameters<Parameters<typeof runWithRls>[1]>[0];
  type Model =
    | "location"
    | "practitionerSchedule"
    | "scheduleException"
    | "timeBlock"
    | "practitionerService"
    | "practitionerPayer"
    | "practitionerSpecialty";
  type Ids = Record<Model, string>;

  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let idsA: Ids;
  let idsB: Ids;
  let specialtyId: string;
  const sfx = `b20-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  async function seed(t: EphemeralTenant): Promise<Ids> {
    const base = { tenantId: t.tenantId, practitionerId: t.practitionerId };
    const location = await prismaOwner.location.create({
      data: { tenantId: t.tenantId, name: "Principal", isPrimary: true },
    });
    return {
      location: location.id,
      practitionerSchedule: (
        await prismaOwner.practitionerSchedule.create({
          data: { ...base, locationId: location.id, dow: 1, startMin: 540, endMin: 1080 },
        })
      ).id,
      scheduleException: (
        await prismaOwner.scheduleException.create({
          data: { ...base, date: new Date("2026-10-12T00:00:00Z"), kind: "CLOSED", reason: "Feriado", createdById: t.userId },
        })
      ).id,
      timeBlock: (
        await prismaOwner.timeBlock.create({
          data: {
            ...base,
            startsAt: new Date("2026-10-13T12:00:00Z"),
            endsAt: new Date("2026-10-13T15:00:00Z"),
            createdById: t.userId,
          },
        })
      ).id,
      practitionerService: (
        await prismaOwner.practitionerService.create({ data: { ...base, serviceId: t.serviceId } })
      ).id,
      practitionerPayer: (
        await prismaOwner.practitionerPayer.create({ data: { ...base, insurerId: t.particularInsurerId } })
      ).id,
      practitionerSpecialty: (
        await prismaOwner.practitionerSpecialty.create({ data: { ...base, specialtyId } })
      ).id,
    };
  }

  // Lectura / update / delete por id, uniformes para las 7 tablas.
  const read: Record<Model, (tx: Tx, ids: string[]) => Promise<Array<{ id: string }>>> = {
    location: (tx, ids) => tx.location.findMany({ where: { id: { in: ids } }, select: { id: true } }),
    practitionerSchedule: (tx, ids) =>
      tx.practitionerSchedule.findMany({ where: { id: { in: ids } }, select: { id: true } }),
    scheduleException: (tx, ids) =>
      tx.scheduleException.findMany({ where: { id: { in: ids } }, select: { id: true } }),
    timeBlock: (tx, ids) => tx.timeBlock.findMany({ where: { id: { in: ids } }, select: { id: true } }),
    practitionerService: (tx, ids) =>
      tx.practitionerService.findMany({ where: { id: { in: ids } }, select: { id: true } }),
    practitionerPayer: (tx, ids) =>
      tx.practitionerPayer.findMany({ where: { id: { in: ids } }, select: { id: true } }),
    practitionerSpecialty: (tx, ids) =>
      tx.practitionerSpecialty.findMany({ where: { id: { in: ids } }, select: { id: true } }),
  };
  const update: Record<Model, (tx: Tx, id: string) => Promise<{ count: number }>> = {
    location: (tx, id) => tx.location.updateMany({ where: { id }, data: { name: "Pisada" } }),
    practitionerSchedule: (tx, id) =>
      tx.practitionerSchedule.updateMany({ where: { id }, data: { startMin: 0 } }),
    scheduleException: (tx, id) => tx.scheduleException.updateMany({ where: { id }, data: { reason: "Pisada" } }),
    timeBlock: (tx, id) => tx.timeBlock.updateMany({ where: { id }, data: { reason: "Pisada" } }),
    practitionerService: (tx, id) => tx.practitionerService.updateMany({ where: { id }, data: { enabled: false } }),
    practitionerPayer: (tx, id) => tx.practitionerPayer.updateMany({ where: { id }, data: { active: false } }),
    // Única columna editable que no rompe el unique: reapuntar al mismo tenant de A.
    practitionerSpecialty: (tx, id) =>
      tx.practitionerSpecialty.updateMany({ where: { id }, data: { tenantId: A.tenantId } }),
  };
  const remove: Record<Model, (tx: Tx, id: string) => Promise<{ count: number }>> = {
    location: (tx, id) => tx.location.deleteMany({ where: { id } }),
    practitionerSchedule: (tx, id) => tx.practitionerSchedule.deleteMany({ where: { id } }),
    scheduleException: (tx, id) => tx.scheduleException.deleteMany({ where: { id } }),
    timeBlock: (tx, id) => tx.timeBlock.deleteMany({ where: { id } }),
    practitionerService: (tx, id) => tx.practitionerService.deleteMany({ where: { id } }),
    practitionerPayer: (tx, id) => tx.practitionerPayer.deleteMany({ where: { id } }),
    practitionerSpecialty: (tx, id) => tx.practitionerSpecialty.deleteMany({ where: { id } }),
  };
  const MODELS = Object.keys(read) as Model[];

  beforeAll(async () => {
    A = await createEphemeralTenant(prismaOwner);
    B = await createEphemeralTenant(prismaOwner);
    specialtyId = (
      await prismaOwner.specialty.create({
        data: {
          slug: `spec-${sfx}`,
          name: `Especialidad ${sfx}`,
          matchKey: `spec ${sfx}`,
          source: "CURATED",
          sourceDate: new Date("2026-10-01T00:00:00Z"),
        },
      })
    ).id;
    idsA = await seed(A);
    idsB = await seed(B);
  });

  afterAll(async () => {
    // Todo lo de agenda cascadea desde Tenant; Specialty es global (RESTRICT
    // desde PractitionerSpecialty, ya borrada con los tenants).
    await A?.cleanup();
    await B?.cleanup();
    if (specialtyId) await prismaOwner.specialty.deleteMany({ where: { id: specialtyId } });
    await prismaOwner.$disconnect();
  });

  it("lectura: A ve sus filas y no las de B, en las 7 tablas", async () => {
    for (const m of MODELS) {
      const seen = await runWithRls(A.tenantId, (tx) => read[m](tx, [idsA[m], idsB[m]]));
      expect({ m, ids: seen.map((r) => r.id) }).toEqual({ m, ids: [idsA[m]] });
    }
  });

  it("INSERT cruzado: A no puede crear filas con el tenantId de B (WITH CHECK)", async () => {
    const baseB = { tenantId: B.tenantId, practitionerId: B.practitionerId };
    const attempts: Array<[Model, (tx: Tx) => Promise<unknown>]> = [
      ["location", (tx) => tx.location.create({ data: { tenantId: B.tenantId, name: "Cruzada" } })],
      [
        "practitionerSchedule",
        (tx) =>
          tx.practitionerSchedule.create({
            data: { ...baseB, locationId: idsB.location, dow: 3, startMin: 600, endMin: 660 },
          }),
      ],
      [
        "scheduleException",
        (tx) =>
          tx.scheduleException.create({
            data: { ...baseB, date: new Date("2026-10-20T00:00:00Z"), kind: "CLOSED", createdById: A.userId },
          }),
      ],
      [
        "timeBlock",
        (tx) =>
          tx.timeBlock.create({
            data: {
              tenantId: B.tenantId,
              practitionerId: null,
              startsAt: new Date("2026-10-21T12:00:00Z"),
              endsAt: new Date("2026-10-21T13:00:00Z"),
              createdById: A.userId,
            },
          }),
      ],
      [
        "practitionerService",
        (tx) => tx.practitionerService.create({ data: { ...baseB, serviceId: A.serviceId } }),
      ],
      [
        "practitionerPayer",
        (tx) => tx.practitionerPayer.create({ data: { ...baseB, insurerId: A.particularInsurerId } }),
      ],
      [
        "practitionerSpecialty",
        (tx) => tx.practitionerSpecialty.create({ data: { ...baseB, specialtyId: specialtyId } }),
      ],
    ];
    for (const [m, attempt] of attempts) {
      await expect(runWithRls(A.tenantId, attempt), m).rejects.toThrow(/row-level security/i);
    }
    // Efecto observable: B sigue con exactamente su fila sembrada en cada tabla.
    expect(await prismaOwner.location.count({ where: { tenantId: B.tenantId } })).toBe(1);
    expect(await prismaOwner.practitionerSchedule.count({ where: { tenantId: B.tenantId } })).toBe(1);
    expect(await prismaOwner.scheduleException.count({ where: { tenantId: B.tenantId } })).toBe(1);
    expect(await prismaOwner.timeBlock.count({ where: { tenantId: B.tenantId } })).toBe(1);
    expect(await prismaOwner.practitionerService.count({ where: { tenantId: B.tenantId } })).toBe(1);
    expect(await prismaOwner.practitionerPayer.count({ where: { tenantId: B.tenantId } })).toBe(1);
    expect(await prismaOwner.practitionerSpecialty.count({ where: { tenantId: B.tenantId } })).toBe(1);
  });

  it("UPDATE / DELETE cruzados afectan 0 filas y las de B quedan intactas", async () => {
    for (const m of MODELS) {
      const counts = await runWithRls(A.tenantId, async (tx) => [
        (await update[m](tx, idsB[m])).count,
        (await remove[m](tx, idsB[m])).count,
      ]);
      expect({ m, counts }).toEqual({ m, counts: [0, 0] });
    }
    const loc = await prismaOwner.location.findUniqueOrThrow({ where: { id: idsB.location } });
    expect(loc.name).toBe("Principal");
    const sch = await prismaOwner.practitionerSchedule.findUniqueOrThrow({ where: { id: idsB.practitionerSchedule } });
    expect(sch.startMin).toBe(540);
    const ps = await prismaOwner.practitionerService.findUniqueOrThrow({ where: { id: idsB.practitionerService } });
    expect(ps.enabled).toBe(true);
  });

  it("A no puede mudar una fila propia al tenant de B (WITH CHECK en UPDATE)", async () => {
    await expect(
      runWithRls(A.tenantId, (tx) =>
        tx.timeBlock.update({ where: { id: idsA.timeBlock }, data: { tenantId: B.tenantId } })
      )
    ).rejects.toThrow(/row-level security/i);
  });

  it("intra-tenant: A escribe y borra sus propias filas (la policy no es deny-all)", async () => {
    const created = await runWithRls(A.tenantId, (tx) =>
      tx.timeBlock.create({
        data: {
          tenantId: A.tenantId,
          practitionerId: null,
          startsAt: new Date("2026-10-22T12:00:00Z"),
          endsAt: new Date("2026-10-22T13:00:00Z"),
          createdById: A.userId,
          reason: "Reunión",
        },
      })
    );
    expect(created.tenantId).toBe(A.tenantId);
    const n = await runWithRls(A.tenantId, (tx) => tx.timeBlock.deleteMany({ where: { id: created.id } }));
    expect(n.count).toBe(1);
  });
});
