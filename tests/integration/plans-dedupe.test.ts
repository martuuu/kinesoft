/**
 * S02x · dedupe de `Session(programId, index)` contra el Postgres local.
 *
 * Planes P1 (S10, M1 `plans_booking_link`): con M1 aplicada existe el único
 * parcial `Session_programId_index_live_key` (programId, index) WHERE
 * archivedAt IS NULL, así que no puede haber duplicados vivos: el dry-run
 * reporta 0 y no escribe. El apply con duplicados quedó probado en ES1 (antes de
 * M1, cuando las fixtures todavía podían meter repetidos) y en el unit del
 * planificador (`planSessionIndexDedupe`).
 *
 * Corre el símbolo REAL que usa el script (`runSessionIndexDedupe`) con el canal
 * owner/BYPASSRLS, igual que en prod. Con el rol de la app (RLS) tiene que
 * negarse. Ya no se autosaltea: si M1 no está aplicada, la suite falla fuerte.
 *
 * Post-M1 (P1.Z): una sesión archivada puede repetir el index de una viva (M1 lo
 * permite: archivar no renumera). Si existe `Session.archivedAt`, el dedupe agrupa
 * solo sesiones vivas, así que esa archivada no es un "repetido". Lo fija el test
 * "archivada con el mismo index…". Igual es una herramienta pre-M1 (RUNBOOK).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { runSessionIndexDedupe } from "@/lib/plans-dedupe-internal";
import {
  addPatient,
  createEphemeralTenant,
  ownerClient,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { appRoleBypassesRls } from "@/tests/helpers/db-role";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("plans-dedupe · Session(programId, index) con M1 aplicada (S02x → S10)", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;

  /** Programa con sesiones vivas en los `indexes` dados (sin repetir: M1 lo impide). */
  async function makeProgram(t: EphemeralTenant, indexes: number[]) {
    const patientId = await addPatient(db, t);
    const program = await db.treatmentProgram.create({
      data: {
        tenantId: t.tenantId,
        patientId,
        title: `Plan ${uniqueSuffix()}`,
        totalSessions: 10,
        frequency: 2,
        startDate: new Date("2026-10-06T12:00:00Z"),
      },
    });
    for (const index of indexes) {
      await db.session.create({
        data: { programId: program.id, practitionerId: t.practitionerId, index, scheduledFor: new Date() },
      });
    }
    return program.id;
  }

  /** Estado observable de las sesiones: id, index y updatedAt (un write lo movería). */
  const snapshot = async (programId: string) =>
    (
      await db.session.findMany({
        where: { programId },
        select: { id: true, index: true, updatedAt: true },
        orderBy: { id: "asc" },
      })
    ).map((s) => [s.id, s.index, s.updatedAt.toISOString()] as const);

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
  });

  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await db?.$disconnect();
  });

  it("M1 aplicada: existe el único parcial y rechaza un index vivo repetido", async () => {
    const [idx] = await db.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'Session_programId_index_live_key'`;
    expect(idx?.indexdef).toMatch(/UNIQUE INDEX .* WHERE \("archivedAt" IS NULL\)/);

    const programId = await makeProgram(A, [1]);
    await expect(
      db.session.create({
        data: { programId, practitionerId: A.practitionerId, index: 1, scheduledFor: new Date() },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("dry-run: reporta 0 movimientos y no escribe", async () => {
    const pa = await makeProgram(A, [1, 2, 3, 5]);
    const pb = await makeProgram(B, [1, 2]);
    const beforeA = await snapshot(pa);
    const beforeB = await snapshot(pb);

    const r = await runSessionIndexDedupe({ db, tenantIds: [A.tenantId, B.tenantId], apply: false });

    expect(r.applied).toBe(false);
    expect(r.updated).toBe(0);
    expect(r.plan.moves).toEqual([]);
    expect(await snapshot(pa)).toEqual(beforeA);
    expect(await snapshot(pb)).toEqual(beforeB);
  });

  it("archivada con el mismo index que una viva: dry-run 0 movimientos y no escribe (P1.Z)", async () => {
    const pa = await makeProgram(A, [1, 2]);
    // Archivar no renumera: la archivada conserva index 1 y entra una viva nueva con index 1.
    const first = await db.session.findFirstOrThrow({ where: { programId: pa, index: 1 } });
    await db.session.update({ where: { id: first.id }, data: { archivedAt: new Date() } });
    await db.session.create({
      data: { programId: pa, practitionerId: A.practitionerId, index: 1, scheduledFor: new Date() },
    });
    // Precondición: en la tabla hay un (programId, index) repetido si se cuentan las archivadas.
    const [dup] = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM "Session" WHERE "programId" = ${pa} AND "index" = 1`;
    expect(Number(dup?.n)).toBe(2);
    const before = await snapshot(pa);

    const r = await runSessionIndexDedupe({ db, tenantIds: [A.tenantId], apply: false });

    expect(r.applied).toBe(false);
    expect(r.updated).toBe(0);
    expect(r.plan.duplicateGroups).toBe(0);
    expect(r.plan.moves).toEqual([]);
    expect(await snapshot(pa)).toEqual(before);
  });

  it("con el rol de la app (RLS, sin BYPASSRLS) se niega", async (ctx) => {
    if (await appRoleBypassesRls()) ctx.skip();
    const app = new PrismaClient();
    try {
      await expect(runSessionIndexDedupe({ db: app, tenantIds: [A.tenantId], apply: false })).rejects.toThrow(/BYPASSRLS/);
    } finally {
      await app.$disconnect();
    }
  });

  it("tenantIds vacío se rechaza (no es 'todos')", async () => {
    await expect(runSessionIndexDedupe({ db, tenantIds: [], apply: false })).rejects.toThrow(/tenantIds vacío/);
  });
});
