/**
 * S16a · "Este y los siguientes" (D23, mismo desfase) — `lib/plans-move.ts`
 * → `previewMovePlanSeries` / `movePlanSeries` (ES2b P2.2).
 *
 * Contra la base real con el `getActor()` real (se mockean la sesión de
 * Supabase, `next/headers` y el runtime de cache). Corre con los dos roles
 * (`kinesoft_app` y el owner BYPASSRLS = prod). Los planes se crean con el
 * motor real (`createPlan`, S11e) para que el vínculo, las keys y el I3 sean
 * los de producción. Fechas en 2030 (nada depende del reloj); TZ=UTC: 10:00 AR
 * = 13:00Z, y un `setHours` del host correría la hora.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { installQueryCounter } = await import("@/tests/helpers/query-counter");
  return { ...actual, ...installQueryCounter() };
});

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { createPlan, previewPlan } from "@/lib/plans";
import { movePlanSeries, previewMovePlanSeries } from "@/lib/plans-move";
import type { PlanCreateInput, PlanPreview, PlanRowResolution } from "@/lib/plans-types";
import { dayKeyOf } from "@/lib/availability/day";
import { planPatientLockKey } from "@/lib/plan-lock";
import { PLAN_FORBIDDEN_COPY } from "@/lib/plan-authz-internal";
import { ownerClient, createEphemeralTenant, addPatient, addPractitioner, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { measure } from "@/tests/helpers/query-counter";
import { waitForAdvisoryWaiter } from "@/tests/helpers/advisory-wait";

const RUN = process.env.INTEGRATION === "1";

/** Lunes 10:00 AR. */
const LUN_10 = { v: 1 as const, frequency: "weekly" as const, slots: [{ dow: 1 as const, startMin: 600 }] };
/** Miércoles 10:00 AR. */
const MIE_10 = { v: 1 as const, frequency: "weekly" as const, slots: [{ dow: 3 as const, startMin: 600 }] };

function acceptDefaults(p: PlanPreview): PlanRowResolution[] {
  return p.rows.map((r) => {
    switch (r.defaultResolution) {
      case "move":
        return { index: r.index, kind: "move", at: r.suggestion };
      case "adopt":
        return { index: r.index, kind: "adopt", bookingId: r.flags.duplicate!.bookingId, expectedUpdatedAt: r.flags.duplicate!.updatedAt };
      default:
        return { index: r.index, kind: r.defaultResolution };
    }
  });
}

describe.skipIf(!RUN)("S16a · mover en serie (D23)", () => {
  let db: PrismaClient;
  let K: EphemeralTenant;
  let assistant: { userId: string; practitionerId: string };

  const planInput = (patientId: string, over: Partial<PlanCreateInput> = {}): PlanCreateInput => ({
    idempotencyKey: randomUUID(),
    patientId,
    discipline: "KINESIOLOGY",
    practitionerId: K.practitionerId,
    serviceId: K.serviceId,
    locationId: null,
    schedule: LUN_10,
    startDayKey: "2030-01-07",
    totalSessions: 5,
    pricing: null,
    rows: [],
    stateToken: "x",
    ...over,
  });

  async function newPlan(patientId: string, over: Partial<PlanCreateInput> = {}) {
    const input = planInput(patientId, over);
    const p = await previewPlan(input);
    if (!p.ok) throw new Error(p.error);
    const r = await createPlan({ ...input, stateToken: p.preview.stateToken, rows: acceptDefaults(p.preview) });
    if (!r.ok) throw new Error(`createPlan: ${JSON.stringify(r)}`);
    const sessions = await db.session.findMany({ where: { programId: r.programId }, orderBy: { index: "asc" } });
    return { programId: r.programId, sessions };
  }

  async function bookingsOf(programId: string) {
    return db.booking.findMany({ where: { programId }, orderBy: { scheduledFor: "asc" }, include: { session: true } });
  }

  async function previewMove(programId: string, fromSessionId: string, at: string) {
    const p = await previewMovePlanSeries({ programId, fromSessionId, at });
    if (!p.ok) throw new Error(`preview: ${p.error}`);
    return p.preview;
  }

  beforeAll(async () => {
    db = ownerClient();
    K = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "PRO" });
    assistant = await addPractitioner(db, K, "ASSISTANT");
    asUser(K.userId);
  });

  afterAll(async () => {
    await K?.cleanup();
    await db?.$disconnect();
  });

  it("+1 h desde la sesión 2 en una tx: 4 turnos y sus sesiones (I3), la 1 queda; un solo audit", async () => {
    const patientId = await addPatient(db, K);
    const { programId, sessions } = await newPlan(patientId);
    const at = "2030-01-14T14:00:00.000Z"; // 11:00 AR (era 10:00)
    const p = await previewMove(programId, sessions[1].id, at);
    expect(p.rows.map((r) => r.at)).toEqual(["14", "21", "28"].map((d) => `2030-01-${d}T14:00:00.000Z`).concat(["2030-02-04T14:00:00.000Z"]));
    const { result: r, m } = await measure(() =>
      movePlanSeries({ programId, fromSessionId: sessions[1].id, at, rows: acceptDefaults(p), stateToken: p.stateToken })
    );
    expect(r).toMatchObject({ ok: true, data: { movedBookings: 4, movedSessions: 0 } });
    // Presupuesto informativo (sin techo en el plan): se reporta para la revisión.
    console.info(`[S16a] move 4 filas: ${m.statements} statements`);

    const bs = await bookingsOf(programId);
    expect(bs.map((b) => b.scheduledFor.toISOString())).toEqual([
      "2030-01-07T13:00:00.000Z",
      "2030-01-14T14:00:00.000Z",
      "2030-01-21T14:00:00.000Z",
      "2030-01-28T14:00:00.000Z",
      "2030-02-04T14:00:00.000Z",
    ]);
    for (const b of bs) {
      expect(+b.session!.scheduledFor).toBe(+b.scheduledFor); // I3
      expect(b.status).toBe("CONFIRMED");
    }
    // Mismo día AR que antes (TZ=UTC no corre el día).
    expect(bs.map((b) => dayKeyOf(b.scheduledFor))).toEqual(["2030-01-07", "2030-01-14", "2030-01-21", "2030-01-28", "2030-02-04"]);
    const audits = await db.auditEvent.findMany({ where: { tenantId: K.tenantId, entityId: programId, action: "program.move_series" } });
    expect(audits).toHaveLength(1);

    // Reenvío del mismo commit: desfase 0 → no-op idempotente.
    const again = await movePlanSeries({ programId, fromSessionId: sessions[1].id, at, rows: acceptDefaults(p), stateToken: p.stateToken });
    expect(again).toMatchObject({ ok: true, data: { movedBookings: 0, movedSessions: 0 } });
  });

  it("mismo desfase en días y minutos AR: +1 día −30 min, y una sesión sin turno solo corre su fecha", async () => {
    const patientId = await addPatient(db, K);
    const { programId, sessions } = await newPlan(patientId, { startDayKey: "2030-02-11", totalSessions: 3 });
    // La 3 queda "sin turno" (cancelado): se mueve solo la fecha planificada.
    const b3 = await db.booking.findFirstOrThrow({ where: { sessionId: sessions[2].id } });
    await db.booking.update({ where: { id: b3.id }, data: { status: "CANCELLED" } });
    const at = "2030-02-12T12:30:00.000Z"; // martes 09:30 AR (era lunes 10:00)
    const p = await previewMove(programId, sessions[0].id, at);
    expect(p.rows).toHaveLength(2);
    const r = await movePlanSeries({ programId, fromSessionId: sessions[0].id, at, rows: acceptDefaults(p), stateToken: p.stateToken });
    expect(r).toMatchObject({ ok: true, data: { movedBookings: 2, movedSessions: 1 } });
    const ss = await db.session.findMany({ where: { programId }, orderBy: { index: "asc" } });
    expect(ss.map((s) => s.scheduledFor.toISOString())).toEqual([
      "2030-02-12T12:30:00.000Z",
      "2030-02-19T12:30:00.000Z",
      "2030-02-26T12:30:00.000Z",
    ]);
    expect((await db.booking.findUniqueOrThrow({ where: { id: b3.id } })).scheduledFor.toISOString()).toBe("2030-02-25T13:00:00.000Z");
  });

  it("un conflicto → stale entero: un bloqueo en el destino de la fila 3 y no se mueve ningún turno", async () => {
    const patientId = await addPatient(db, K);
    const { programId, sessions } = await newPlan(patientId, { startDayKey: "2030-03-04", totalSessions: 4 });
    const at = "2030-03-04T14:00:00.000Z";
    const p = await previewMove(programId, sessions[0].id, at);
    await db.timeBlock.create({
      data: {
        tenantId: K.tenantId,
        practitionerId: K.practitionerId,
        startsAt: new Date("2030-03-18T13:30:00Z"),
        endsAt: new Date("2030-03-18T16:00:00Z"),
        reason: "Congreso",
        createdById: K.userId,
      },
    });
    const r = await movePlanSeries({ programId, fromSessionId: sessions[0].id, at, rows: acceptDefaults(p), stateToken: p.stateToken });
    expect(r).toMatchObject({ ok: false, kind: "stale-preview" });
    if (!r.ok && "preview" in r) expect(r.preview.rows.find((x) => x.at === "2030-03-18T14:00:00.000Z")?.flags.blocked).toBe(true);
    const bs = await bookingsOf(programId);
    expect(bs.every((b) => b.scheduledFor.getUTCHours() === 13)).toBe(true);
    expect(await db.auditEvent.count({ where: { entityId: programId, action: "program.move_series" } })).toBe(0);
  });

  it("el cobrado queda intacto: el turno con cobro se mueve con su copago y su estado de pago", async () => {
    const patientId = await addPatient(db, K);
    const { programId, sessions } = await newPlan(patientId, { startDayKey: "2030-04-01", totalSessions: 3 });
    const paid = await db.booking.findFirstOrThrow({ where: { sessionId: sessions[1].id } });
    await db.booking.update({ where: { id: paid.id }, data: { copagoCents: 450_000, paymentStatus: "PAID" } });
    const at = "2030-04-01T15:00:00.000Z";
    const p = await previewMove(programId, sessions[0].id, at);
    const r = await movePlanSeries({ programId, fromSessionId: sessions[0].id, at, rows: acceptDefaults(p), stateToken: p.stateToken });
    expect(r).toMatchObject({ ok: true, data: { movedBookings: 3 } });
    const after = await db.booking.findUniqueOrThrow({ where: { id: paid.id } });
    expect(after.scheduledFor.toISOString()).toBe("2030-04-08T15:00:00.000Z");
    expect(after.copagoCents).toBe(450_000);
    expect(after.paymentStatus).toBe("PAID");
    expect(after.status).toBe("CONFIRMED");
  });

  it("la Secretaria mueve (plans.schedule); un token de otro pedido → stale-preview sin escribir", async () => {
    const patientId = await addPatient(db, K);
    const { programId, sessions } = await newPlan(patientId, { startDayKey: "2030-05-06", totalSessions: 2 });
    asUser(assistant.userId);
    try {
      const at = "2030-05-06T14:00:00.000Z";
      const p = await previewMove(programId, sessions[0].id, at);
      // Mismo token, otro destino: el pedido cambió desde el preview.
      const bad = await movePlanSeries({
        programId,
        fromSessionId: sessions[0].id,
        at: "2030-05-06T15:00:00.000Z",
        rows: acceptDefaults(p),
        stateToken: p.stateToken,
      });
      expect(bad).toMatchObject({ ok: false, kind: "stale-preview" });
      expect((await bookingsOf(programId)).every((b) => b.scheduledFor.getUTCHours() === 13)).toBe(true);
      const ok = await movePlanSeries({ programId, fromSessionId: sessions[0].id, at, rows: acceptDefaults(p), stateToken: p.stateToken });
      expect(ok).toMatchObject({ ok: true, data: { movedBookings: 2 } });
    } finally {
      asUser(K.userId);
    }
  });

  it("paciente de otro consultorio / sesión ajena → rechazo", async () => {
    const O = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "PRO" });
    try {
      const patientId = await addPatient(db, K);
      const { programId } = await newPlan(patientId, { startDayKey: "2030-06-03", totalSessions: 2 });
      const foreignProgram = await db.treatmentProgram.create({
        data: { tenantId: O.tenantId, patientId: await addPatient(db, O), title: "Ajeno", startDate: new Date(), totalSessions: 1 },
      });
      const r1 = await previewMovePlanSeries({ programId: foreignProgram.id, fromSessionId: "x".repeat(10), at: "2030-06-03T14:00:00.000Z" });
      expect(r1.ok).toBe(false);
      const otherSession = (await newPlan(await addPatient(db, K), { startDayKey: "2030-06-05", schedule: MIE_10, totalSessions: 1 })).sessions[0];
      const r2 = await previewMovePlanSeries({ programId, fromSessionId: otherSession.id, at: "2030-06-03T14:00:00.000Z" });
      expect(r2.ok).toBe(false);
    } finally {
      await O.cleanup();
    }
  });

  it("básico (PRACTITIONER sin el paciente) → Forbidden", async () => {
    const pro = await addPractitioner(db, K, "PRACTITIONER");
    const patientId = await addPatient(db, K);
    const { programId, sessions } = await newPlan(patientId, { startDayKey: "2030-06-10", totalSessions: 1 });
    asUser(pro.userId);
    try {
      const r = await previewMovePlanSeries({ programId, fromSessionId: sessions[0].id, at: "2030-06-10T14:00:00.000Z" });
      expect(r).toMatchObject({ ok: false, error: PLAN_FORBIDDEN_COPY.schedule });
    } finally {
      asUser(K.userId);
    }
  });

  it("sin deadlock contra un commit de plan del mismo paciente: los dos esperan el lock del paciente y terminan", async () => {
    const patientId = await addPatient(db, K);
    const { programId, sessions } = await newPlan(patientId, { startDayKey: "2030-07-01", totalSessions: 3 });
    const at = "2030-07-01T14:00:00.000Z";
    const p = await previewMove(programId, sessions[0].id, at);
    const second = planInput(patientId, { schedule: MIE_10, startDayKey: "2030-07-03", totalSessions: 3 });
    const pp = await previewPlan(second);
    if (!pp.ok) throw new Error(pp.error);

    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const key = planPatientLockKey({ tenantId: K.tenantId, patientId });
    const holder = db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
        await gate;
      },
      { timeout: 20_000 }
    );
    const move = movePlanSeries({ programId, fromSessionId: sessions[0].id, at, rows: acceptDefaults(p), stateToken: p.stateToken });
    const create = createPlan({ ...second, stateToken: pp.preview.stateToken, rows: acceptDefaults(pp.preview) });
    await waitForAdvisoryWaiter(db, key, { minWaiters: 2, timeoutMs: 10_000 });
    release();
    await holder;
    const [rm, rc] = await Promise.all([move, create]);
    expect(rm).toMatchObject({ ok: true, data: { movedBookings: 3 } });
    expect(rc).toMatchObject({ ok: true });
    expect(await db.booking.count({ where: { patientId, status: "CONFIRMED" } })).toBe(6);
  });
});
