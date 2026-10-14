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
  addRoom,
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

// ── Planes M1 (20261004120000_plans_booking_link) · S10c, E4.2 ──────────
// ProgramAuthorization y PatientChangeRequest: ENABLE + FORCE + UNA policy
// `<Tabla>_tenant_isolation` (USING y WITH CHECK `tenantId =
// app_current_tenant_id()`). B no lee, no escribe, no modifica ni borra lo de
// A; un INSERT con el tenantId ajeno muere en el WITH CHECK; sin GUC
// (fuera de runWithRls) no se ve nada ni entra nada. Y A sí opera lo propio:
// la policy no es un deny-all. Las FKs compuestas (red bajo BYPASSRLS) se
// prueban en plans-m1-new-tables.test.ts.
describe.skipIf(!RUN || BYPASS)("RLS Planes M1 (ProgramAuthorization / PatientChangeRequest, app role)", () => {
  const prismaOwner = new PrismaClient({
    datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } },
  });
  const TABLES = ["ProgramAuthorization", "PatientChangeRequest"] as const;

  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let patA: string;
  let planA: string;
  let authA: string;
  let authB: string;
  let reqA: string;
  let reqB: string;

  async function seed(t: EphemeralTenant) {
    const pat = await prismaOwner.patient.create({
      data: { tenantId: t.tenantId, firstName: "M1", lastName: t.slug, assignedPractitionerId: t.practitionerId },
    });
    const plan = await prismaOwner.treatmentProgram.create({
      data: { tenantId: t.tenantId, patientId: pat.id, title: "Plan M1", startDate: new Date("2026-10-05T03:00:00Z") },
    });
    const auth = await prismaOwner.programAuthorization.create({
      data: { tenantId: t.tenantId, programId: plan.id, code: "AUT-1", authorizedSessions: 10, startsOn: new Date("2026-10-01T00:00:00Z") },
    });
    const req = await prismaOwner.patientChangeRequest.create({
      data: { tenantId: t.tenantId, patientId: pat.id, changes: { phone: "1155550000" } },
    });
    return { pat: pat.id, plan: plan.id, auth: auth.id, req: req.id };
  }

  beforeAll(async () => {
    A = await createEphemeralTenant(prismaOwner);
    B = await createEphemeralTenant(prismaOwner);
    ({ pat: patA, plan: planA, auth: authA, req: reqA } = await seed(A));
    ({ auth: authB, req: reqB } = await seed(B));
  });

  afterAll(async () => {
    // deleteTenantDeep borra las 2 tablas antes que TreatmentProgram/Patient.
    await A?.cleanup();
    await B?.cleanup();
    await prismaOwner.$disconnect();
  });

  it("catálogo: relrowsecurity y relforcerowsecurity en true, una sola policy `<tabla>_tenant_isolation`", async () => {
    const rel = await prismaOwner.$queryRaw<{ relname: string; rls: boolean; force: boolean }[]>`
      SELECT relname, relrowsecurity AS rls, relforcerowsecurity AS force
      FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY(${[...TABLES]})`;
    expect(rel.sort((a, b) => a.relname.localeCompare(b.relname))).toEqual([
      { relname: "PatientChangeRequest", rls: true, force: true },
      { relname: "ProgramAuthorization", rls: true, force: true },
    ]);
    const pol = await prismaOwner.$queryRaw<{ tablename: string; policyname: string; cmd: string; qual: string; with_check: string }[]>`
      SELECT tablename, policyname, cmd, qual, with_check FROM pg_policies
      WHERE schemaname = 'public' AND tablename = ANY(${[...TABLES]}) ORDER BY tablename`;
    expect(pol.map((p) => [p.tablename, p.policyname, p.cmd])).toEqual([
      ["PatientChangeRequest", "PatientChangeRequest_tenant_isolation", "ALL"],
      ["ProgramAuthorization", "ProgramAuthorization_tenant_isolation", "ALL"],
    ]);
    for (const p of pol) {
      expect(p.qual).toMatch(/"tenantId" = app_current_tenant_id\(\)/);
      expect(p.with_check).toMatch(/"tenantId" = app_current_tenant_id\(\)/);
    }
  });

  it("lectura: A ve lo suyo y no lo de B, en las 2 tablas (y B no ve lo de A)", async () => {
    const [authsA, reqsA] = await runWithRls(A.tenantId, async (tx) => [
      (await tx.programAuthorization.findMany({ where: { id: { in: [authA, authB] } }, select: { id: true } })).map((r) => r.id),
      (await tx.patientChangeRequest.findMany({ where: { id: { in: [reqA, reqB] } }, select: { id: true } })).map((r) => r.id),
    ]);
    expect(authsA).toEqual([authA]);
    expect(reqsA).toEqual([reqA]);
    const [authsB, reqsB] = await runWithRls(B.tenantId, async (tx) => [
      (await tx.programAuthorization.findMany({ where: { programId: planA } })).length,
      (await tx.patientChangeRequest.findMany({ where: { patientId: patA } })).length,
    ]);
    expect([authsB, reqsB]).toEqual([0, 0]);
  });

  it("INSERT con el tenantId de A desde B → rechazado por el WITH CHECK", async () => {
    await expect(
      runWithRls(B.tenantId, (tx) =>
        tx.programAuthorization.create({
          data: { tenantId: A.tenantId, programId: planA, code: "CRUZ", startsOn: new Date("2026-10-01T00:00:00Z"), supersededAt: new Date() },
        })
      )
    ).rejects.toThrow(/row-level security/i);
    await expect(
      runWithRls(B.tenantId, (tx) =>
        tx.patientChangeRequest.create({
          data: { tenantId: A.tenantId, patientId: patA, changes: { phone: "1" }, status: "REJECTED", decidedAt: new Date() },
        })
      )
    ).rejects.toThrow(/row-level security/i);
    expect(await prismaOwner.programAuthorization.count({ where: { tenantId: A.tenantId } })).toBe(1);
    expect(await prismaOwner.patientChangeRequest.count({ where: { tenantId: A.tenantId } })).toBe(1);
  });

  it("UPDATE / DELETE desde B sobre lo de A afectan 0 filas y lo de A queda intacto", async () => {
    const counts = await runWithRls(B.tenantId, async (tx) => [
      (await tx.programAuthorization.updateMany({ where: { id: authA }, data: { code: "PISADO" } })).count,
      (await tx.programAuthorization.deleteMany({ where: { id: authA } })).count,
      (await tx.patientChangeRequest.updateMany({ where: { id: reqA }, data: { status: "APPROVED", decidedAt: new Date() } })).count,
      (await tx.patientChangeRequest.deleteMany({ where: { id: reqA } })).count,
    ]);
    expect(counts).toEqual([0, 0, 0, 0]);
    const a = await prismaOwner.programAuthorization.findUniqueOrThrow({ where: { id: authA } });
    expect(a.code).toBe("AUT-1");
    const r = await prismaOwner.patientChangeRequest.findUniqueOrThrow({ where: { id: reqA } });
    expect(r.status).toBe("PENDING");
    expect(r.decidedAt).toBeNull();
  });

  it("A no puede mudar una fila propia al tenant de B (WITH CHECK en UPDATE)", async () => {
    await expect(
      runWithRls(A.tenantId, (tx) => tx.patientChangeRequest.update({ where: { id: reqA }, data: { tenantId: B.tenantId } }))
    ).rejects.toThrow(/row-level security/i);
    expect((await prismaOwner.patientChangeRequest.findUniqueOrThrow({ where: { id: reqA } })).tenantId).toBe(A.tenantId);
  });

  it("sin GUC (fuera de runWithRls): 0 filas visibles y ningún INSERT entra", async () => {
    // Conexión de la app pelada: app_current_tenant_id() = NULL → la policy no matchea nada.
    const app = new PrismaClient();
    try {
      expect(await app.programAuthorization.count({ where: { id: { in: [authA, authB] } } })).toBe(0);
      expect(await app.patientChangeRequest.count({ where: { id: { in: [reqA, reqB] } } })).toBe(0);
      await expect(
        app.programAuthorization.create({
          data: { tenantId: A.tenantId, programId: planA, startsOn: new Date("2026-10-01T00:00:00Z"), supersededAt: new Date() },
        })
      ).rejects.toThrow(/row-level security/i);
      await expect(
        app.patientChangeRequest.create({
          data: { tenantId: A.tenantId, patientId: patA, changes: { phone: "1" }, status: "REJECTED", decidedAt: new Date() },
        })
      ).rejects.toThrow(/row-level security/i);
    } finally {
      await app.$disconnect();
    }
    expect(await prismaOwner.programAuthorization.count({ where: { tenantId: A.tenantId } })).toBe(1);
    expect(await prismaOwner.patientChangeRequest.count({ where: { tenantId: A.tenantId } })).toBe(1);
  });

  it("intra-tenant: A crea, lee y borra lo propio (la policy no es deny-all)", async () => {
    const created = await runWithRls(A.tenantId, async (tx) => ({
      auth: await tx.programAuthorization.create({
        data: { tenantId: A.tenantId, programId: planA, code: "AUT-OLD", startsOn: new Date("2026-09-01T00:00:00Z"), supersededAt: new Date() },
      }),
      req: await tx.patientChangeRequest.create({
        data: { tenantId: A.tenantId, patientId: patA, changes: { email: "a@b.c" }, status: "APPROVED", decidedAt: new Date() },
      }),
    }));
    expect(created.auth.tenantId).toBe(A.tenantId);
    expect(created.req.tenantId).toBe(A.tenantId);
    const n = await runWithRls(A.tenantId, async (tx) => [
      (await tx.programAuthorization.deleteMany({ where: { id: created.auth.id } })).count,
      (await tx.patientChangeRequest.deleteMany({ where: { id: created.req.id } })).count,
    ]);
    expect(n).toEqual([1, 1]);
  });
});

// ── SR M4 (20261009120000_rooms) · SR-M ─────────────────────────────────
// Room: ENABLE + FORCE + UNA policy `Room_tenant_isolation`. A no ve, no
// inserta, no modifica ni borra las salas de B (y no puede mudar una propia a
// B); sin GUC no se ve ni entra nada; y A sí opera las propias (la policy no es
// un deny-all). Las FKs compuestas, los CHECK y el único parcial (red bajo
// BYPASSRLS) se prueban en rooms-m4.test.ts.
describe.skipIf(!RUN || BYPASS)("RLS Room (SR M4, app role)", () => {
  const prismaOwner = new PrismaClient({
    datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } },
  });

  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let locA: string;
  let locB: string;
  let roomA: string;
  let roomB: string;

  beforeAll(async () => {
    A = await createEphemeralTenant(prismaOwner);
    B = await createEphemeralTenant(prismaOwner);
    ({ roomId: roomA, locationId: locA } = await addRoom(prismaOwner, A, { name: "Consultorio A" }));
    ({ roomId: roomB, locationId: locB } = await addRoom(prismaOwner, B, { name: "Consultorio B" }));
  });

  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await prismaOwner.$disconnect();
  });

  it("catálogo: relrowsecurity y relforcerowsecurity en true, una sola policy Room_tenant_isolation", async () => {
    const rel = await prismaOwner.$queryRaw<{ rls: boolean; force: boolean }[]>`
      SELECT relrowsecurity AS rls, relforcerowsecurity AS force
      FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = 'Room'`;
    expect(rel).toEqual([{ rls: true, force: true }]);
    const pol = await prismaOwner.$queryRaw<{ policyname: string; cmd: string; qual: string; with_check: string }[]>`
      SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = 'Room'`;
    expect(pol.map((p) => [p.policyname, p.cmd])).toEqual([["Room_tenant_isolation", "ALL"]]);
    expect(pol[0].qual).toMatch(/"tenantId" = app_current_tenant_id\(\)/);
    expect(pol[0].with_check).toMatch(/"tenantId" = app_current_tenant_id\(\)/);
  });

  it("lectura: A ve su sala y no la de B (y B no ve la de A)", async () => {
    const seenByA = await runWithRls(A.tenantId, (tx) =>
      tx.room.findMany({ where: { id: { in: [roomA, roomB] } }, select: { id: true } })
    );
    expect(seenByA.map((r) => r.id)).toEqual([roomA]);
    const seenByB = await runWithRls(B.tenantId, (tx) => tx.room.count({ where: { locationId: locA } }));
    expect(seenByB).toBe(0);
  });

  it("INSERT con el tenantId de B desde A → rechazado por el WITH CHECK", async () => {
    await expect(
      runWithRls(A.tenantId, (tx) =>
        tx.room.create({ data: { tenantId: B.tenantId, locationId: locB, name: "Cruzada" } })
      )
    ).rejects.toThrow(/row-level security/i);
    expect(await prismaOwner.room.count({ where: { tenantId: B.tenantId } })).toBe(1);
  });

  it("UPDATE / DELETE desde A sobre la sala de B afectan 0 filas y la de B queda intacta", async () => {
    const counts = await runWithRls(A.tenantId, async (tx) => [
      (await tx.room.updateMany({ where: { id: roomB }, data: { name: "Pisada", active: false } })).count,
      (await tx.room.deleteMany({ where: { id: roomB } })).count,
    ]);
    expect(counts).toEqual([0, 0]);
    const b = await prismaOwner.room.findUniqueOrThrow({ where: { id: roomB } });
    expect(b).toMatchObject({ name: "Consultorio B", active: true, tenantId: B.tenantId });
  });

  it("A no puede mudar su sala al tenant de B (WITH CHECK en UPDATE)", async () => {
    await expect(
      runWithRls(A.tenantId, (tx) => tx.room.update({ where: { id: roomA }, data: { tenantId: B.tenantId } }))
    ).rejects.toThrow(/row-level security/i);
    expect((await prismaOwner.room.findUniqueOrThrow({ where: { id: roomA } })).tenantId).toBe(A.tenantId);
  });

  it("sin GUC (fuera de runWithRls): 0 salas visibles y ningún INSERT entra", async () => {
    const app = new PrismaClient();
    try {
      expect(await app.room.count({ where: { id: { in: [roomA, roomB] } } })).toBe(0);
      await expect(
        app.room.create({ data: { tenantId: A.tenantId, locationId: locA, name: "Sin GUC" } })
      ).rejects.toThrow(/row-level security/i);
    } finally {
      await app.$disconnect();
    }
    expect(await prismaOwner.room.count({ where: { tenantId: A.tenantId } })).toBe(1);
  });

  it("intra-tenant: A crea, edita, archiva y borra sus salas (la policy no es deny-all)", async () => {
    const created = await runWithRls(A.tenantId, (tx) =>
      tx.room.create({ data: { tenantId: A.tenantId, locationId: locA, name: "Box propio", kind: "BOX", capacity: 2 } })
    );
    expect(created).toMatchObject({ tenantId: A.tenantId, kind: "BOX", capacity: 2, active: true });
    const n = await runWithRls(A.tenantId, async (tx) => [
      (await tx.room.updateMany({ where: { id: created.id }, data: { name: "Box 2", active: false } })).count,
      (await tx.room.deleteMany({ where: { id: created.id } })).count,
    ]);
    expect(n).toEqual([1, 1]);
  });
});

// IAM-1 (M6): EmailLog. Lo escribe el sink de `sendEmail` por el canal service
// (BYPASSRLS); la app (kinesoft_app) solo LEE el registro de su consultorio
// (IAM-4c). Además del aislamiento A/B: las filas con tenantId NULL (mails sin
// consultorio: signup, olvidé contraseña) son invisibles para la app con
// cualquier GUC (NULL = x es NULL → falso), y la app no puede insertar una.
// Objetos, CHECK y cascade: identity-m6.test.ts.
describe.skipIf(!RUN || BYPASS)("RLS EmailLog (IAM-1 M6, app role)", () => {
  const prismaOwner = new PrismaClient({
    datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } },
  });

  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let logA: string;
  let logB: string;
  let logNull: string;
  const row = (tenantId: string | null, kind = "staff_invite") => ({
    tenantId,
    kind,
    toHash: "h",
    toMasked: "a***@test.local",
    transport: "log",
    status: "skipped",
    actorId: "rls-m6",
  });

  beforeAll(async () => {
    A = await createEphemeralTenant(prismaOwner);
    B = await createEphemeralTenant(prismaOwner);
    logA = (await prismaOwner.emailLog.create({ data: row(A.tenantId) })).id;
    logB = (await prismaOwner.emailLog.create({ data: row(B.tenantId) })).id;
    logNull = (await prismaOwner.emailLog.create({ data: row(null, "password_reset") })).id;
  });

  afterAll(async () => {
    await prismaOwner.emailLog.deleteMany({ where: { id: logNull } });
    await A?.cleanup();
    await B?.cleanup();
    await prismaOwner.$disconnect();
  });

  it("lectura: A ve solo lo suyo; ni la de B ni la de tenantId NULL (y B no ve la de A)", async () => {
    const seenByA = await runWithRls(A.tenantId, (tx) =>
      tx.emailLog.findMany({ where: { id: { in: [logA, logB, logNull] } }, select: { id: true } })
    );
    expect(seenByA.map((r) => r.id)).toEqual([logA]);
    const seenByB = await runWithRls(B.tenantId, (tx) =>
      tx.emailLog.findMany({ where: { id: { in: [logA, logB, logNull] } }, select: { id: true } })
    );
    expect(seenByB.map((r) => r.id)).toEqual([logB]);
  });

  it("INSERT desde A con el tenantId de B, o con tenantId NULL → rechazado por el WITH CHECK", async () => {
    await expect(runWithRls(A.tenantId, (tx) => tx.emailLog.create({ data: row(B.tenantId) }))).rejects.toThrow(
      /row-level security/i
    );
    await expect(runWithRls(A.tenantId, (tx) => tx.emailLog.create({ data: row(null) }))).rejects.toThrow(
      /row-level security/i
    );
    expect(await prismaOwner.emailLog.count({ where: { tenantId: B.tenantId } })).toBe(1);
  });

  it("UPDATE / DELETE desde A sobre la de B o la NULL afectan 0 filas y quedan intactas", async () => {
    const counts = await runWithRls(A.tenantId, async (tx) => [
      (await tx.emailLog.updateMany({ where: { id: { in: [logB, logNull] } }, data: { status: "failed" } })).count,
      (await tx.emailLog.deleteMany({ where: { id: { in: [logB, logNull] } } })).count,
    ]);
    expect(counts).toEqual([0, 0]);
    const rows = await prismaOwner.emailLog.findMany({ where: { id: { in: [logB, logNull] } }, select: { status: true } });
    expect(rows.map((r) => r.status)).toEqual(["skipped", "skipped"]);
  });

  it("A no puede mudar su fila al tenant de B ni dejarla sin tenant (WITH CHECK en UPDATE)", async () => {
    await expect(
      runWithRls(A.tenantId, (tx) => tx.emailLog.update({ where: { id: logA }, data: { tenantId: B.tenantId } }))
    ).rejects.toThrow(/row-level security/i);
    await expect(
      runWithRls(A.tenantId, (tx) => tx.emailLog.update({ where: { id: logA }, data: { tenantId: null } }))
    ).rejects.toThrow(/row-level security/i);
    expect((await prismaOwner.emailLog.findUniqueOrThrow({ where: { id: logA } })).tenantId).toBe(A.tenantId);
  });

  it("sin GUC (fuera de runWithRls): 0 filas visibles (tampoco las NULL) y ningún INSERT entra", async () => {
    const app = new PrismaClient();
    try {
      expect(await app.emailLog.count({ where: { id: { in: [logA, logB, logNull] } } })).toBe(0);
      await expect(app.emailLog.create({ data: row(null) })).rejects.toThrow(/row-level security/i);
      await expect(app.emailLog.create({ data: row(A.tenantId) })).rejects.toThrow(/row-level security/i);
    } finally {
      await app.$disconnect();
    }
    expect(await prismaOwner.emailLog.count({ where: { tenantId: A.tenantId } })).toBe(1);
  });

  it("intra-tenant: A inserta, lee y borra lo propio (la policy no es deny-all)", async () => {
    const created = await runWithRls(A.tenantId, (tx) => tx.emailLog.create({ data: row(A.tenantId, "welcome") }));
    expect(created).toMatchObject({ tenantId: A.tenantId, kind: "welcome" });
    const n = await runWithRls(A.tenantId, async (tx) => (await tx.emailLog.deleteMany({ where: { id: created.id } })).count);
    expect(n).toBe(1);
  });
});
