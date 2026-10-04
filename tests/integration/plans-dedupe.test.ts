/**
 * S02x · dedupe de `Session(programId, index)` contra el Postgres local.
 *
 * Corre el símbolo REAL que usa el script (`runSessionIndexDedupe`) con el
 * canal owner/BYPASSRLS, igual que en prod, y afirma el efecto en las filas:
 * el dry-run no escribe, dos `--apply` dan el mismo resultado, otro tenant
 * queda intacto y no se tocan SessionExercise ni `totalSessions`. Con el rol
 * de la app (RLS) tiene que negarse.
 *
 * Las fixtures meten repetidos a propósito: eso solo es posible ANTES de M1.
 * Cuando M1 cree `Session_programId_index_live_key` la suite se saltea sola
 * (el script ya no tiene nada que hacer después de M1).
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

describe.skipIf(!RUN)("plans-dedupe · Session(programId, index) (S02x)", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let uniqueExists = false;

  /** Programa con sesiones en los `indexes` dados (pueden repetirse). */
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
    const ids: string[] = [];
    for (const index of indexes) {
      const s = await db.session.create({
        data: { programId: program.id, practitionerId: t.practitionerId, index, scheduledFor: new Date() },
      });
      ids.push(s.id);
    }
    return { programId: program.id, ids };
  }

  const snapshot = async (programId: string) =>
    (await db.session.findMany({ where: { programId }, select: { id: true, index: true }, orderBy: { id: "asc" } })).map(
      (s) => [s.id, s.index] as const,
    );

  beforeAll(async () => {
    db = ownerClient();
    const [r] = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM pg_indexes WHERE indexname = 'Session_programId_index_live_key'`;
    uniqueExists = Number(r?.n ?? 0) > 0;
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
  });

  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await db?.$disconnect();
  });

  it("dry-run: planifica pero no escribe", async (ctx) => {
    if (uniqueExists) ctx.skip();
    const { programId, ids } = await makeProgram(A, [1, 2, 2, 3]);
    const before = await snapshot(programId);

    const r = await runSessionIndexDedupe({ db, tenantIds: [A.tenantId], apply: false });

    expect(r.applied).toBe(false);
    expect(r.updated).toBe(0);
    const sortedDup = [ids[1], ids[2]].sort();
    expect(r.plan.moves.filter((m) => m.programId === programId)).toEqual([
      { sessionId: sortedDup[1], programId, tenantId: A.tenantId, from: 2, to: 4 },
    ]);
    expect(await snapshot(programId)).toEqual(before);
  });

  it("apply: renumera, conserva el id menor, no toca SessionExercise ni totalSessions; un segundo apply no cambia nada", async (ctx) => {
    if (uniqueExists) ctx.skip();
    const { programId, ids } = await makeProgram(A, [1, 1, 1, 2, 2, 5]);
    const ex = await db.exercise.create({
      data: { slug: `test-ex-${uniqueSuffix()}`, name: "Puente", tenantId: A.tenantId },
    });
    for (const sessionId of ids) {
      await db.sessionExercise.create({ data: { sessionId, exerciseId: ex.id, order: 1, sets: 3, reps: 10 } });
    }

    const first = await runSessionIndexDedupe({ db, tenantIds: [A.tenantId], apply: true });
    expect(first.applied).toBe(true);
    expect(first.updated).toBe(first.plan.moves.length);

    const g1 = [ids[0], ids[1], ids[2]].sort();
    const g2 = [ids[3], ids[4]].sort();
    const after = new Map(await snapshot(programId));
    expect(after.get(g1[0])).toBe(1);
    expect(after.get(g1[1])).toBe(6);
    expect(after.get(g1[2])).toBe(7);
    expect(after.get(g2[0])).toBe(2);
    expect(after.get(g2[1])).toBe(8);
    expect(after.get(ids[5])).toBe(5);
    expect(new Set(after.values()).size).toBe(ids.length);

    // Nada se borra ni se re-cuelga: los ejercicios siguen en su sesión.
    const exRows = await db.sessionExercise.findMany({ where: { sessionId: { in: ids } }, select: { sessionId: true } });
    expect(exRows.map((e) => e.sessionId).sort()).toEqual([...ids].sort());
    const prog = await db.treatmentProgram.findUniqueOrThrow({ where: { id: programId }, select: { totalSessions: true } });
    expect(prog.totalSessions).toBe(10);

    const snap = await snapshot(programId);
    const second = await runSessionIndexDedupe({ db, tenantIds: [A.tenantId], apply: true });
    expect(second.plan.moves).toEqual([]);
    expect(second.updated).toBe(0);
    expect(await snapshot(programId)).toEqual(snap);
  });

  it("otro tenant queda intacto", async (ctx) => {
    if (uniqueExists) ctx.skip();
    const a = await makeProgram(A, [3, 3]);
    const b = await makeProgram(B, [1, 1, 2]);
    const bBefore = await snapshot(b.programId);

    const r = await runSessionIndexDedupe({ db, tenantIds: [A.tenantId], apply: true });

    expect(r.plan.moves.every((m) => m.tenantId === A.tenantId)).toBe(true);
    expect(new Set((await snapshot(a.programId)).map(([, i]) => i)).size).toBe(2);
    expect(await snapshot(b.programId)).toEqual(bBefore);
  });

  it("con el rol de la app (RLS, sin BYPASSRLS) se niega", async (ctx) => {
    if (uniqueExists || (await appRoleBypassesRls())) ctx.skip();
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
