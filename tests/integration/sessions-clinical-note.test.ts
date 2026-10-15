/**
 * EV2-2d · «Sin evolución» de Seguimiento con evoluciones de HC (brief EV2 §0 R3, EV2-D18, C-EV2-7).
 *
 * EV2-D18 (literal): «Sin evolución» (Seguimiento) y `touched` (reabrir al «Deshacer Atendido» / «Cargar evolución»
 * de sesión) cuentan una evolución **viva raíz** del turno ACTIVO de la sesión. «Deshacer Atendido» no reabre esa
 * sesión.
 *
 * El predicado va como `EXISTS` en la MISMA sentencia que ya decidía «untouched» (`sinEvRows` en `lib/sessions.ts`,
 * `lockSessionEvolutionStateInTx` en `lib/sessions-internal.ts`): esta última corre dentro de `updateBooking` /
 * Recepción, con techo estricto de sentencias. Acá se afirma además que «Deshacer Atendido» cuesta las mismas
 * sentencias con evolución que sin ella (el techo absoluto lo fijan los tests de `bookings-*-rooms` y
 * `tests/perf/compare.ts`).
 *
 * Las notas las siembra el owner con SQL (las actions de evoluciones son de EV2-2a). Se mockean la sesión de
 * Supabase, `next/cache` y la instrumentación de `@/lib/db` (un listener de `query`); las actions corren reales en
 * los dos roles (kinesoft_app y owner). La limpieza va por deleteTenantDeep (notas en modo réplica).
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { installQueryCounter } = await import("@/tests/helpers/query-counter");
  return { ...actual, ...installQueryCounter() };
});

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { markReceptionAction } from "@/lib/bookings";
import { listOpenSessions } from "@/lib/sessions";
import { reopenSessionIfUntouchedInTx } from "@/lib/sessions-internal";
import { runWithRls } from "@/lib/rls";
import { dayWindow } from "@/lib/availability/day";
import { toARDateKey } from "@/lib/datetime-ar";
import {
  ownerClient,
  createEphemeralTenant,
  sweepOrphanTestTenants,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { createPlan, addPlanBooking } from "@/tests/helpers/plan-factory";
import { asUser } from "@/tests/helpers/actor";
import { measure } from "@/tests/helpers/query-counter";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("EV2-2d · «Sin evolución» cuenta la evolución de HC del turno activo", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    T = await createEphemeralTenant(db);
  });

  beforeEach(() => asUser(T.userId));

  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });

  const session = (id: string) => db.session.findUniqueOrThrow({ where: { id } });
  const ver = async (id: string) => (await db.booking.findUniqueOrThrow({ where: { id } })).updatedAt.toISOString();

  /** Un instante de HOY AR (Recepción solo marca turnos del día). Piso = inicio del día AR (ver plans-sync-bookings). */
  let todayMinute = 0;
  const todaySlot = () => {
    todayMinute += 1;
    const dayStart = +dayWindow(toARDateKey(new Date())).start;
    const d = new Date(Math.max(Date.now() - 60 * 60_000, dayStart) + todayMinute * 60_000);
    d.setUTCSeconds(0, 0);
    return d;
  };

  /** Evolución sembrada por el owner; `amendsNoteId` para una enmienda. Devuelve el id. */
  async function seedNote(o: { patientId: string; bookingId: string; amendsNoteId?: string }): Promise<string> {
    const id = `ev2-2d-${uniqueSuffix()}`;
    await db.$executeRaw`
      INSERT INTO "ClinicalNote" (id, "tenantId", "patientId", "bookingId", "amendsNoteId", body, "occurredAt",
                                  "authorUserId", "authorPractitionerId", "authorName", "idempotencyKey",
                                  "createdAt", "updatedAt")
      VALUES (${id}, ${T.tenantId}, ${o.patientId}, ${o.bookingId}, ${o.amendsNoteId ?? null}, 'Evolución de prueba',
              now() AT TIME ZONE 'UTC', ${T.userId}, ${T.practitionerId}, 'Kine Test', ${randomUUID()},
              now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')`;
    return id;
  }

  const voidNote = (id: string) =>
    db.$executeRaw`
      UPDATE "ClinicalNote" SET "voidedAt" = now() AT TIME ZONE 'UTC', "voidedByUserId" = ${T.userId},
        "voidReason" = 'Cargada en el paciente equivocado'
      WHERE id = ${id}`;

  const sinEvolucionIds = async () => ((await listOpenSessions()).realizadasSinEvolucion?.rows ?? []).map((r) => r.id);

  it("una sesión realizada cuyo turno activo tiene evolución viva sale de «Sin evolución»; anulada, vuelve", async () => {
    // 4 sesiones realizadas hoy (dentro de los 14 días de «Realizadas»), cada una con su turno COMPLETED.
    const p = await createPlan(db, T, { sessions: 4, bookings: 4, bookingStatus: "COMPLETED" });
    await db.session.updateMany({ where: { id: { in: p.sessionIds } }, data: { completedAt: new Date() } });
    const [s0, s1, s2, s3] = p.sessionIds;
    const [b0, , b2, b3] = p.bookingIds;

    const live = await seedNote({ patientId: p.patientId, bookingId: b0 }); // [0] evolución viva
    // [1] sin nada.
    // [2] raíz anulada + su enmienda: la enmienda NO cuenta (EV2-D18: raíz viva).
    const voidedRoot = await seedNote({ patientId: p.patientId, bookingId: b2 });
    await seedNote({ patientId: p.patientId, bookingId: b2, amendsNoteId: voidedRoot });
    await voidNote(voidedRoot);
    // [3] evolución viva en un turno que ya NO es el activo (cancelado): no cuenta.
    await seedNote({ patientId: p.patientId, bookingId: b3 });
    await db.booking.update({ where: { id: b3 }, data: { status: "CANCELLED" } });

    let ids = await sinEvolucionIds();
    expect(ids).not.toContain(s0);
    expect(ids).toContain(s1);
    expect(ids).toContain(s2);
    expect(ids).toContain(s3);

    await voidNote(live);
    ids = await sinEvolucionIds();
    expect(ids).toContain(s0);
    expect((await session(s0)).completedAt).not.toBeNull();
  });

  it("«Deshacer Atendido» con evolución de HC viva no reabre la sesión, avisa y cuesta las mismas sentencias", async () => {
    // Testigo: el mismo camino («touched», no reabre) con la evolución de siempre (notas de la sesión).
    const w = await createPlan(db, T, { sessions: 2, bookings: 0 });
    const wb = await addPlanBooking(db, T, {
      patientId: w.patientId,
      programId: w.programId,
      sessionId: w.sessionIds[0],
      scheduledFor: todaySlot(),
      status: "COMPLETED",
    });
    await db.session.update({ where: { id: w.sessionIds[0] }, data: { completedAt: new Date(), notes: "Evolución" } });
    const wVer = await ver(wb);
    const witness = await measure(() => markReceptionAction(wb, "deshacer", wVer));
    expect(witness.result.ok).toBe(true);
    expect((await session(w.sessionIds[0])).completedAt).not.toBeNull();

    const p = await createPlan(db, T, { sessions: 2, bookings: 0 });
    const b = await addPlanBooking(db, T, {
      patientId: p.patientId,
      programId: p.programId,
      sessionId: p.sessionIds[0],
      scheduledFor: todaySlot(),
      status: "COMPLETED",
    });
    await db.session.update({ where: { id: p.sessionIds[0] }, data: { completedAt: new Date() } });
    await seedNote({ patientId: p.patientId, bookingId: b });

    const v = await ver(b);
    const undo = await measure(() => markReceptionAction(b, "deshacer", v));
    expect(undo.result.ok).toBe(true);
    if (undo.result.ok) expect(undo.result.data.notice).toMatch(/evolución/i);
    expect((await db.booking.findUniqueOrThrow({ where: { id: b } })).status).toBe("CONFIRMED");
    expect((await session(p.sessionIds[0])).completedAt).not.toBeNull();
    // Mismo `EXISTS` en la misma sentencia: ni una sentencia más que el testigo.
    expect(undo.m.statements).toBe(witness.m.statements);
  });

  it("reopenSessionIfUntouchedInTx: evolución viva → «touched»; anulada → reabre", async () => {
    const p = await createPlan(db, T, { sessions: 2, bookings: 1, bookingStatus: "COMPLETED" });
    const [s0] = p.sessionIds;
    await db.session.update({ where: { id: s0 }, data: { completedAt: new Date() } });
    const note = await seedNote({ patientId: p.patientId, bookingId: p.bookingIds[0] });

    const reopen = () =>
      runWithRls(T.tenantId, (tx) => reopenSessionIfUntouchedInTx(tx, { tenantId: T.tenantId, sessionId: s0, now: new Date() }));

    expect(await reopen()).toEqual({ reopened: false, reason: "touched" });
    expect((await session(s0)).completedAt).not.toBeNull();

    await voidNote(note);
    expect(await reopen()).toEqual({ reopened: true });
    expect((await session(s0)).completedAt).toBeNull();
  });
});
