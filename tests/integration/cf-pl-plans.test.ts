/**
 * [CF-PL1..3] CF (§28, decisión 1 del 30-oct, ADR-032, CF-D4 / CF-D12, enmienda C2 (1d)) — Planes con la regla
 * «no atiende servicios distintos a la vez» (`Practitioner.allowParallelServices = false`, default de M20), contra
 * Postgres real en los dos roles (`kinesoft_app` con RLS y el owner BYPASSRLS = prod).
 *
 * Qué se prueba y por qué:
 *   - [CF-PL1] el motor (`classifyPlanRows` con `exclusiveService`) ve el turno de OTRO servicio del profesional (otro
 *     paciente): la fila queda `capacityFull` + `otherServiceBusy` (clase "otro-servicio", CF-D4: se pliega en el
 *     sobreturno). Sin forzar, «crear tal cual» es stale y no se escribe nada; con `force.capacity` se crea con
 *     `isOverbooked` (`PlanForceFlags` NO cambia). Antes de CF-PL el motor no recibía la regla: la fila salía libre y el
 *     plan pisaba el otro servicio en silencio.
 *   - [CF-PL2] «este y los siguientes» sobre otro servicio: el core (`applyBookingUpdateInTx` con `capLocksHeld`) aplica
 *     la regla igual (CF-D12) y devuelve `other-service`; si la serie forzada solo mandaba `allowOverbooking`, el commit
 *     moría en `MoveSeriesConflict(…, "other-service")`. Con `force.capacity` tiene que mover todo.
 *   - [CF-PL3] carrera plan ∥ alta suelta de otro servicio en el mismo horario: la clave de cupo lleva el servicio y
 *     Planes no toma hora, así que sin `pday` en el superconjunto del plan las dos leían «0 de otro servicio» y entraban
 *     las dos. Con `pday` (misma sentencia que el cupo, después de él) entra exactamente uno y no hay 40P01.
 *   - Toggle prendido (`allowParallelServices = true`) → conducta de antes (la fila es libre, nada de sobreturno).
 *
 * Carrera sin falso verde: un holder toma el `pday` exacto, cada competidor se lanza recién cuando el anterior quedó
 * en la cola de ESA clave (`waitForAdvisoryWaiter`, filtra por clave, no un conteo global) y se suelta; la cola de un
 * advisory exclusivo es FIFO, así que el orden de llegada es determinista y se afirman los dos lados.
 *
 * Símbolos reales (`previewPlan`/`createPlan`, `previewMovePlanSeries`/`movePlanSeries`, `createBooking`); se mockean
 * la sesión (`asUser`) y `next/cache` (setup). Fechas en 2031/2032: nada depende del reloj. TZ=UTC: 10:00 AR = 13:00Z.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { createPlan, previewPlan } from "@/lib/plans";
import { movePlanSeries, previewMovePlanSeries } from "@/lib/plans-move";
import type { CreatePlanResult, PlanCreateInput, PlanPreview, PlanRowResolution } from "@/lib/plans-types";
import { createBooking } from "@/lib/bookings";
import { practitionerDayLockKey } from "@/lib/booking-cap-lock";
import { dayKeyOf } from "@/lib/availability/day";
import { waitForAdvisoryWaiter } from "@/tests/helpers/advisory-wait";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addService,
  sweepOrphanTestTenants,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

/** Lunes 10:00 AR (C6: 0=Dom). */
const LUN_10 = { v: 1 as const, frequency: "weekly" as const, slots: [{ dow: 1 as const, startMin: 600 }] };

/** Las resoluciones por defecto del preview, como las mandaría el editor. */
function acceptDefaults(p: PlanPreview): PlanRowResolution[] {
  return p.rows.map((r) =>
    r.defaultResolution === "move"
      ? { index: r.index, kind: "move", at: r.suggestion }
      : r.defaultResolution === "adopt"
        ? { index: r.index, kind: "adopt", bookingId: r.flags.duplicate!.bookingId, expectedUpdatedAt: r.flags.duplicate!.updatedAt }
        : { index: r.index, kind: r.defaultResolution }
  );
}

/** Una tx del owner que toma un advisory y lo retiene hasta `release()`. */
function hold(db: PrismaClient, key: string) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let ready!: () => void;
  const readyP = new Promise<void>((r) => (ready = r));
  const done = db.$transaction(
    async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      ready();
      await gate;
    },
    { timeout: 30_000, maxWait: 10_000 }
  );
  return { ready: readyP, release, done };
}

/** Ninguna promesa tiró (un 40P01 tira o sale enmascarado; las dos cosas se miran). */
function allFulfilled<T extends readonly unknown[]>(settled: { [K in keyof T]: PromiseSettledResult<T[K]> }): T {
  const reasons = (settled as readonly PromiseSettledResult<unknown>[])
    .filter((s): s is PromiseRejectedResult => s.status === "rejected")
    .map((s) => String((s.reason as Error)?.message ?? s.reason));
  expect(reasons).toEqual([]);
  return (settled as readonly PromiseSettledResult<unknown>[]).map((s) => (s as PromiseFulfilledResult<unknown>).value) as unknown as T;
}

/**
 * Carrera con orden de llegada fijo detrás de `key` (mismo patrón que `plans-concurrency.test.ts`): cada competidor se
 * lanza cuando el anterior ya espera ESA clave. Si alguno no llega a esperarla (hoy: el plan no toma `pday`), tira:
 * una carrera que no se armó no probó nada.
 */
async function raceBehind<T extends readonly unknown[]>(
  db: PrismaClient,
  key: string,
  racers: { [K in keyof T]: () => Promise<T[K]> }
): Promise<T> {
  const h = hold(db, key);
  await h.ready;
  const started: Promise<unknown>[] = [];
  try {
    for (const run of racers as readonly (() => Promise<unknown>)[]) {
      const p = run();
      p.catch(() => {});
      started.push(p);
      await waitForAdvisoryWaiter(db, key, { minWaiters: started.length, timeoutMs: 8_000 });
    }
  } finally {
    h.release();
    await h.done;
  }
  return allFulfilled<T>((await Promise.allSettled(started)) as never);
}

/** Mensajes con los que las acciones enmascaran una excepción (un 40P01 incluido). */
const GENERIC_ERRORS = ["No pudimos crear el turno.", "No pudimos guardar el plan.", "No pudimos mover los turnos."];

describe.skipIf(!RUN)("[CF-PL] Planes con «no atiende servicios distintos a la vez»", () => {
  let db: PrismaClient;
  /** Regla por defecto (exclusivo). */
  let K: EphemeralTenant;
  /** Toggle prendido: `allowParallelServices = true` (conducta de antes). */
  let KP: EphemeralTenant;
  /** «Evaluación» 60' del consultorio (sin PractitionerService: habilitado para todos), cupo ilimitado. */
  let otherK: string;
  let otherKP: string;

  const planInput = (T: EphemeralTenant, patientId: string, over: Partial<PlanCreateInput> = {}): PlanCreateInput => ({
    idempotencyKey: randomUUID(),
    patientId,
    discipline: "KINESIOLOGY",
    practitionerId: T.practitionerId,
    serviceId: T.serviceId,
    locationId: null,
    schedule: LUN_10,
    startDayKey: "2031-03-03",
    totalSessions: 2,
    pricing: null,
    rows: [],
    stateToken: "x",
    ...over,
  });

  async function preview(input: PlanCreateInput): Promise<PlanPreview> {
    const r = await previewPlan(input);
    if (!r.ok) throw new Error(`preview: ${r.error}`);
    return r.preview;
  }

  /** Turno suelto de OTRO servicio y OTRO paciente (insert directo del owner: el estado que dejaría la agenda). */
  async function otherServiceBooking(T: EphemeralTenant, serviceId: string, when: Date) {
    const patientId = await addPatient(db, T);
    return db.booking.create({
      data: {
        tenantId: T.tenantId,
        patientId,
        practitionerId: T.practitionerId,
        serviceId,
        scheduledFor: when,
        durationMin: 60,
        idempotencyKey: randomUUID(),
        status: "CONFIRMED",
      },
      select: { id: true },
    });
  }

  const activeAt = (T: EphemeralTenant, when: Date) =>
    db.booking.findMany({
      where: { tenantId: T.tenantId, practitionerId: T.practitionerId, scheduledFor: when, status: { not: "CANCELLED" } },
      select: { id: true, patientId: true, serviceId: true, programId: true, isOverbooked: true },
      orderBy: { id: "asc" },
    });

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    K = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "PRO" });
    KP = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "PRO", allowParallelServices: true });
    otherK = await addService(db, K, { name: "Evaluación", durationMin: 60 });
    otherKP = await addService(db, KP, { name: "Evaluación", durationMin: 60 });
    // No vacuo: la regla de K es el default de la columna (M20); la de KP, el toggle prendido.
    const rules = await db.practitioner.findMany({
      where: { id: { in: [K.practitionerId, KP.practitionerId] } },
      select: { id: true, allowParallelServices: true },
    });
    expect(Object.fromEntries(rules.map((r) => [r.id, r.allowParallelServices]))).toEqual({
      [K.practitionerId]: false,
      [KP.practitionerId]: true,
    });
  });

  afterAll(async () => {
    await K?.cleanup();
    await KP?.cleanup();
    await db?.$disconnect();
  });

  // ─── [CF-PL1] crear ────────────────────────────────────────────────────────

  describe("[CF-PL1] crear un plan cuya fila pisa otro servicio del profesional", () => {
    beforeEach(() => asUser(K.userId));

    it("[CF-PL1] sin forzar la fila sale «otro-servicio» (sobreturno) y no se crea; con force.capacity se crea con isOverbooked", async () => {
      const patientId = await addPatient(db, K);
      const input = planInput(K, patientId, { startDayKey: "2031-03-03" });
      const slot = new Date("2031-03-03T13:00:00.000Z"); // lunes 10:00 AR
      const other = await otherServiceBooking(K, otherK, slot);

      const p = await preview(input);
      expect(p.rows[0].at).toBe(slot.toISOString());
      expect(p.rows[0].flags).toMatchObject({ capacityFull: true, otherServiceBusy: true });
      expect(p.rows[0].defaultResolution).not.toBe("create");
      expect(p.rows[0].allowedResolutions).toContain("force");
      expect(p.rows[1].flags).toMatchObject({ capacityFull: false, otherServiceBusy: false });

      // Sin forzar: «crear tal cual» sobre el otro servicio es stale y no escribe nada.
      const asIs = acceptDefaults(p).map((r) => (r.index === p.rows[0].index ? { index: r.index, kind: "create" as const } : r));
      const stale = await createPlan({ ...input, stateToken: p.stateToken, rows: asIs });
      expect(stale).toMatchObject({ ok: false, kind: "stale-preview" });
      expect(await db.treatmentProgram.count({ where: { tenantId: K.tenantId, patientId } })).toBe(0);
      expect((await activeAt(K, slot)).map((b) => b.id)).toEqual([other.id]);

      // Con force.capacity (PlanForceFlags de siempre): se crea encima, como sobreturno.
      const forced = acceptDefaults(p).map((r) =>
        r.index === p.rows[0].index ? { index: r.index, kind: "force" as const, force: { capacity: true as const } } : r
      );
      const ok = await createPlan({ ...input, stateToken: p.stateToken, rows: forced });
      expect(ok).toMatchObject({ ok: true });
      const rows = await activeAt(K, slot);
      expect(rows).toHaveLength(2);
      const mine = rows.find((b) => b.patientId === patientId)!;
      expect(mine.serviceId).toBe(K.serviceId);
      expect(mine.isOverbooked).toBe(true);
      expect(rows.find((b) => b.id === other.id)!.isOverbooked).toBe(false);
    });

    it("[CF-PL1] el turno de otro servicio del MISMO paciente no cuenta (CF-D3): la fila es libre", async () => {
      const patientId = await addPatient(db, K);
      const slot = new Date("2031-04-07T13:00:00.000Z");
      await db.booking.create({
        data: {
          tenantId: K.tenantId,
          patientId,
          practitionerId: K.practitionerId,
          serviceId: otherK,
          scheduledFor: slot,
          durationMin: 60,
          idempotencyKey: randomUUID(),
          status: "CONFIRMED",
        },
      });
      const p = await preview(planInput(K, patientId, { startDayKey: "2031-04-07" }));
      expect(p.rows[0].flags.otherServiceBusy).toBe(false);
      expect(p.rows[0].flags.capacityFull).toBe(false);
    });

    it("[CF-PL1] toggle prendido → conducta de antes: la fila es libre y el turno nace sin sobreturno", async () => {
      asUser(KP.userId);
      const patientId = await addPatient(db, KP);
      const input = planInput(KP, patientId, { startDayKey: "2031-03-03" });
      const slot = new Date("2031-03-03T13:00:00.000Z");
      await otherServiceBooking(KP, otherKP, slot);
      const p = await preview(input);
      expect(p.rows[0].flags.capacityFull).toBe(false);
      expect(p.rows[0].flags.otherServiceBusy).toBeUndefined(); // sin la regla, el informativo no existe
      expect(p.rows[0].defaultResolution).toBe("create");
      const r = await createPlan({ ...input, stateToken: p.stateToken, rows: acceptDefaults(p) });
      expect(r).toMatchObject({ ok: true });
      const mine = (await activeAt(KP, slot)).find((b) => b.patientId === patientId)!;
      expect(mine.isOverbooked).toBe(false);
    });
  });

  // ─── [CF-PL2] «este y los siguientes» ──────────────────────────────────────

  describe("[CF-PL2] «este y los siguientes» sobre otro servicio", () => {
    async function planOf(T: EphemeralTenant, startDayKey: string) {
      const patientId = await addPatient(db, T);
      const input = planInput(T, patientId, { startDayKey, totalSessions: 3 });
      const p = await preview(input);
      const r = await createPlan({ ...input, stateToken: p.stateToken, rows: acceptDefaults(p) });
      if (!r.ok) throw new Error(`createPlan: ${JSON.stringify(r)}`);
      const sessions = await db.session.findMany({ where: { programId: r.programId }, orderBy: { index: "asc" } });
      return { programId: r.programId, sessions };
    }

    const bookingsOf = (programId: string) =>
      db.booking.findMany({ where: { programId }, orderBy: { scheduledFor: "asc" }, select: { scheduledFor: true, isOverbooked: true } });

    it("[CF-PL2] con force.capacity mueve las 3 y no da MoveSeriesConflict; la que pisa queda sobreturno", async () => {
      asUser(K.userId);
      const { programId, sessions } = await planOf(K, "2031-05-05");
      // La 2 cae sobre una «Evaluación» de otro paciente a las 11:00 AR del 12-may.
      const clash = new Date("2031-05-12T14:00:00.000Z");
      await otherServiceBooking(K, otherK, clash);
      const at = "2031-05-05T14:00:00.000Z"; // +1 h desde la 1
      const pv = await previewMovePlanSeries({ programId, fromSessionId: sessions[0].id, at });
      if (!pv.ok) throw new Error(`preview: ${pv.error}`);
      const row = pv.preview.rows.find((r) => r.at === clash.toISOString())!;
      expect(row.flags).toMatchObject({ capacityFull: true, otherServiceBusy: true });
      const rows = acceptDefaults(pv.preview).map((r) =>
        r.index === row.index ? { index: r.index, kind: "force" as const, force: { capacity: true as const } } : r
      );
      const r = await movePlanSeries({ programId, fromSessionId: sessions[0].id, at, rows, stateToken: pv.preview.stateToken });
      expect(r).toMatchObject({ ok: true, data: { movedBookings: 3 } });
      expect((await bookingsOf(programId)).map((b) => [b.scheduledFor.toISOString(), b.isOverbooked])).toEqual([
        ["2031-05-05T14:00:00.000Z", false],
        ["2031-05-12T14:00:00.000Z", true],
        ["2031-05-19T14:00:00.000Z", false],
      ]);
    });

    it("[CF-PL2] toggle prendido → conducta de antes: mueve con las resoluciones por defecto, sin sobreturno", async () => {
      asUser(KP.userId);
      const { programId, sessions } = await planOf(KP, "2031-05-05");
      await otherServiceBooking(KP, otherKP, new Date("2031-05-12T14:00:00.000Z"));
      const at = "2031-05-05T14:00:00.000Z";
      const pv = await previewMovePlanSeries({ programId, fromSessionId: sessions[0].id, at });
      if (!pv.ok) throw new Error(`preview: ${pv.error}`);
      expect(pv.preview.rows.every((r) => r.defaultResolution === "create")).toBe(true);
      const r = await movePlanSeries({
        programId,
        fromSessionId: sessions[0].id,
        at,
        rows: acceptDefaults(pv.preview),
        stateToken: pv.preview.stateToken,
      });
      expect(r).toMatchObject({ ok: true, data: { movedBookings: 3 } });
      expect((await bookingsOf(programId)).every((b) => !b.isOverbooked)).toBe(true);
    });
  });

  // ─── [CF-PL3] carrera ──────────────────────────────────────────────────────

  describe("[CF-PL3] plan ∥ alta suelta de otro servicio en el mismo horario", () => {
    beforeEach(() => asUser(K.userId));

    it.each([
      { first: "plan" as const, start: "2031-06-02" },
      // Lejos del anterior: su plan de 2 sesiones ocupa también el lunes siguiente.
      { first: "booking" as const, start: "2031-09-01" },
    ])("[CF-PL3] entra uno solo y sin 40P01 (llega primero: $first)", async ({ first, start }) => {
      const patientId = await addPatient(db, K);
      const other = await addPatient(db, K);
      const input = planInput(K, patientId, { startDayKey: start });
      const p = await preview(input);
      expect(p.rows.map((r) => r.defaultResolution)).toEqual(["create", "create"]);
      const slot = new Date(p.rows[0].at);
      const key = practitionerDayLockKey({ tenantId: K.tenantId, practitionerId: K.practitionerId, dayKey: dayKeyOf(slot) });

      const runPlan = () => createPlan({ ...input, stateToken: p.stateToken, rows: acceptDefaults(p) });
      const runBooking = () =>
        createBooking({
          patientId: other,
          serviceId: otherK,
          practitionerId: K.practitionerId,
          scheduledFor: slot.toISOString(),
          durationMin: 60,
          idempotencyKey: randomUUID(),
          allowOutOfHours: true,
        });
      type BookingR = Awaited<ReturnType<typeof createBooking>>;
      let plan: CreatePlanResult;
      let booking: BookingR;
      if (first === "plan") [plan, booking] = await raceBehind<[CreatePlanResult, BookingR]>(db, key, [runPlan, runBooking]);
      else [booking, plan] = await raceBehind<[BookingR, CreatePlanResult]>(db, key, [runBooking, runPlan]);

      expect(GENERIC_ERRORS).not.toContain(booking.ok ? "" : booking.error);
      if (!plan.ok) expect(GENERIC_ERRORS).not.toContain("error" in plan ? plan.error : "");
      const rows = await activeAt(K, slot);
      expect(rows).toHaveLength(1);
      expect(rows[0].isOverbooked).toBe(false);
      if (first === "plan") {
        expect(plan).toMatchObject({ ok: true });
        expect(booking).toMatchObject({ ok: false, otherService: expect.anything() });
        expect(rows[0].patientId).toBe(patientId);
      } else {
        expect(booking.ok).toBe(true);
        expect(plan).toMatchObject({ ok: false, kind: "stale-preview" });
        if (!plan.ok && "preview" in plan) expect(plan.preview.rows[0].flags).toMatchObject({ capacityFull: true, otherServiceBusy: true });
        expect(rows[0].patientId).toBe(other);
        expect(await db.treatmentProgram.count({ where: { tenantId: K.tenantId, patientId } })).toBe(0);
      }
    });
  });
});
