/**
 * EV2-2b · Presupuesto de `getPatientTimeline` (C-EV2-5; brief EV2 §4 «2b», anti N+1).
 *
 * Contrato: ≤ 4 sentencias de DATOS por página (las que nombran ClinicalNote/Session/Booking), constante entre un
 * paciente con 10 notas y uno con 1.000 notas + 200 sesiones; y la sentencia de raíces sin Seq Scan sobre ClinicalNote
 * (usa el índice (tenantId, patientId, occurredAt DESC, id DESC) de M9), en la primera página y con cursor.
 *
 * `installQueryCounter` (tests/helpers/query-counter.ts) solo le pone un listener a los clientes de `@/lib/db`: corre
 * el símbolo real con `getActor()` real. El EXPLAIN se hace sobre la sentencia EXACTA que se registró (texto +
 * parámetros), con el owner y después de `ANALYZE` (estadísticas reales, como prod).
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { installQueryCounter } = await import("@/tests/helpers/query-counter");
  return { ...actual, ...installQueryCounter() };
});

import type { PrismaClient } from "@prisma/client";
import { getPatientTimeline } from "@/lib/clinical-notes-read";
import { asUser } from "@/tests/helpers/actor";
import { measure, type QueryEvent } from "@/tests/helpers/query-counter";
import { ownerClient, createEphemeralTenant, addPatient, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const DATA_TABLE = /"(ClinicalNote|Session|Booking)"/;
const BASE = Date.parse("2025-01-01T12:00:00.000Z");
const HOUR = 3_600_000;

/** Notas por SQL (1 sentencia): cada 10ª empata con la anterior (desempate por id en el keyset). */
async function seedNotes(db: PrismaClient, t: EphemeralTenant, patientId: string, n: number): Promise<void> {
  await db.$executeRaw`
    INSERT INTO "ClinicalNote" (id, "tenantId", "patientId", body, "occurredAt", "authorUserId", "authorPractitionerId",
      "authorName", "idempotencyKey", "createdAt", "updatedAt")
    SELECT 'perf' || ${patientId} || '-' || g, ${t.tenantId}, ${patientId}, 'Evolución de volumen ' || g,
      ${new Date(BASE).toISOString()}::timestamp + make_interval(hours => g - (g % 10 = 0)::int),
      ${t.userId}, ${t.practitionerId}, 'Perf', gen_random_uuid()::text,
      now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC'
    FROM generate_series(1, ${n}::int) g`;
}

/** Enmiendas de las primeras `n` raíces del paciente (1 sentencia). */
async function seedAmendments(db: PrismaClient, t: EphemeralTenant, patientId: string, n: number): Promise<void> {
  await db.$executeRaw`
    INSERT INTO "ClinicalNote" (id, "tenantId", "patientId", "amendsNoteId", body, "occurredAt", "authorUserId",
      "authorPractitionerId", "authorName", "idempotencyKey", "createdAt", "updatedAt")
    SELECT 'perfam' || ${patientId} || '-' || g, ${t.tenantId}, ${patientId}, 'perf' || ${patientId} || '-' || g,
      'Enmienda ' || g, now() AT TIME ZONE 'UTC', ${t.userId}, ${t.practitionerId}, 'Perf', gen_random_uuid()::text,
      now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC'
    FROM generate_series(1, ${n}::int) g`;
}

/** Plan + `n` sesiones completadas intercaladas con las notas (+ 1 ejercicio por sesión para el agregado). */
async function seedSessions(db: PrismaClient, t: EphemeralTenant, patientId: string, n: number): Promise<void> {
  const program = await db.treatmentProgram.create({
    data: { tenantId: t.tenantId, patientId, title: "Plan perf", startDate: new Date(BASE), practitionerId: t.practitionerId },
    select: { id: true },
  });
  await db.$executeRaw`
    INSERT INTO "Session" (id, "programId", "practitionerId", index, "scheduledFor", "completedAt", notes)
    SELECT 'perfs' || ${program.id} || '-' || g, ${program.id}, ${t.practitionerId}, g,
      ${new Date(BASE).toISOString()}::timestamp + make_interval(hours => g * 5),
      ${new Date(BASE).toISOString()}::timestamp + make_interval(hours => g * 5),
      'sesión ' || g
    FROM generate_series(1, ${n}::int) g`;
  const exercise = await db.exercise.findFirst({ select: { id: true } });
  if (exercise) {
    await db.$executeRaw`
      INSERT INTO "SessionExercise" (id, "sessionId", "exerciseId", "order", sets, reps, status)
      SELECT 'perfx' || s.id, s.id, ${exercise.id}, 1, 3, 10, 'DONE'
      FROM "Session" s WHERE s."programId" = ${program.id}`;
  }
}

const dataStatements = (events: { query: string }[]) => events.filter((e) => DATA_TABLE.test(e.query));

describe.skipIf(!RUN)("EV2-2b · getPatientTimeline: sentencias constantes y sin Seq Scan", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let big: string;
  let small: string;

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", saasPlan: "CONSULTORIO" });
    big = await addPatient(db, T);
    small = await addPatient(db, T);
    await seedNotes(db, T, big, 1000);
    await seedAmendments(db, T, big, 50);
    await seedSessions(db, T, big, 200);
    await seedNotes(db, T, small, 10);
    await seedAmendments(db, T, small, 2);
    await seedSessions(db, T, small, 2);
    await db.$executeRawUnsafe(`ANALYZE "ClinicalNote"`);
    await db.$executeRawUnsafe(`ANALYZE "Session"`);
  }, 120_000);

  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });

  /**
   * Mide una página y copia texto + parámetros de cada sentencia (para contarlas por tabla y para el EXPLAIN).
   * `measure` deja en el recorder global los eventos de la última medición (los limpia al EMPEZAR la siguiente).
   */
  async function capture(patientId: string, cursor: string | null) {
    const g = globalThis as unknown as { __kineQueryRecorder: { events: QueryEvent[] } };
    const { result, m } = await measure(() => getPatientTimeline({ patientId, cursor, limit: 20 }));
    if (!result) throw new Error("timeline null");
    return { result, m, events: [...g.__kineQueryRecorder.events] };
  }

  it("≤ 4 sentencias de datos por página, iguales con 10 y con 1.000 notas + 200 sesiones (1ª página y con cursor)", async () => {
    asUser(T.userId);
    // Calentamiento sin afirmar nada. En la integración completa (un solo fork, clientes contados compartidos entre
    // archivos) la PRIMERA medición daba 8 sentencias y las siguientes 7 (gate EV2-Z): se colaba una sentencia
    // pendiente del archivo anterior o la de un cache de proceso en frío. Solo, el archivo pasaba. Lo que se afirma
    // abajo (constante entre 10 y 1.000 notas) no cambia: se compara en caliente contra caliente.
    await capture(small, null);
    const s1 = await capture(small, null);
    const b1 = await capture(big, null);
    expect(b1.result.items).toHaveLength(20);
    expect(b1.result.nextCursor).not.toBeNull();
    const b2 = await capture(big, b1.result.nextCursor);
    expect(b2.result.items).toHaveLength(20);
    // Sin repetidos entre páginas.
    const k1 = new Set(b1.result.items.map((i) => i.key));
    expect(b2.result.items.some((i) => k1.has(i.key))).toBe(false);

    const d = (x: { events: QueryEvent[] }) => dataStatements(x.events).length;
    expect(d(b1), dataStatements(b1.events).map((e) => e.query).join("\n---\n")).toBeLessThanOrEqual(4);
    expect(d(b2)).toBeLessThanOrEqual(4);
    // Anti-false-green: el filtro por tabla matchea de verdad (raíces + enmiendas + sesiones = 3).
    expect(d(b1)).toBe(3);
    expect(d(b1)).toBe(d(s1));
    expect(d(b2)).toBe(d(s1));
    // Y el total (gate + actor incluidos) tampoco depende del volumen.
    expect(b1.m.statements).toBe(s1.m.statements);
    expect(b2.m.statements).toBe(s1.m.statements);
  });

  it("EXPLAIN de la sentencia de raíces: sin Seq Scan sobre ClinicalNote (1ª página y con cursor)", async () => {
    asUser(T.userId);
    const b1 = await capture(big, null);
    const b2 = await capture(big, b1.result.nextCursor);
    for (const run of [b1, b2]) {
      const roots = run.events.filter((e) => /FROM "ClinicalNote" n/.test(e.query) && /"amendsNoteId" IS NULL/.test(e.query));
      expect(roots).toHaveLength(1);
      const params = JSON.parse(roots[0].params) as unknown[];
      const plan = await db.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(`EXPLAIN ${roots[0].query}`, ...params);
      const text = plan.map((r) => r["QUERY PLAN"]).join("\n");
      expect(text, text).not.toMatch(/Seq Scan on "ClinicalNote"/);
      expect(text, text).toMatch(/Index (Only )?Scan.*"ClinicalNote_tenantId_patientId_occurredAt_id_idx"/);
    }
  });
});
