/**
 * [CF-W2] CF (§28, decisiones 1 y 2 del 30-oct, ADR-032) — la regla «el profesional no atiende servicios distintos a
 * la vez» en la EDICIÓN de un turno (mover, alargar, reactivar, reprogramar la sesión, Planes con `capLocksHeld`),
 * contra Postgres real en los dos roles.
 *
 * El bug (feedback del cliente): el cupo es por servicio (`countCapacityOverlaps`, §5), así que mover una Evaluación
 * encima de la Kinesiología del mismo profesional entraba sin aviso aunque el profesional no puede atender las dos.
 *
 * Contratos que fija (brief CF A.5, literal):
 *   - `countAgendaOccupancy` suma `exclusiveService` / `patientId` y devuelve `otherService: { count, first }` en la
 *     MISMA sentencia (el where pierde `serviceId`); `overlap` sigue siendo el cupo del servicio (paridad con
 *     `countCapacityOverlaps`, que no cambia).
 *   - `BookingUpdateTxOutcome` + `other-service` (`otherServiceId`, `existingAt`), orden cupo → otro servicio → tope
 *     → sala, forzable SOLO con `allowOtherService` (no con `allowOverbooking`) y forzado = `isOverbooked`.
 *   - `updateBooking` / `setBookingStatus` devuelven `otherService: BookingOtherServicePrompt` + `OTHER_SERVICE_ERROR`.
 *   - Mismo servicio hasta el cupo: sin aviso. Mismo paciente (no nulo, CF-D3): sin aviso; un guest no se exime.
 *   - `allowParallelServices = true` = la conducta de antes, leída DESPUÉS del lock (un cambio en caliente se ve).
 *   - `rescheduleSession` respeta la regla (`RescheduleForce.allowOtherService`).
 *   - `capLocksHeld` (Planes): el core igual chequea la regla (CF-D12) y no vuelve a tomar locks.
 *   - La edición que cambia la ventana o reactiva toma `kinesoft:pday:` (enmienda C2 (1d)); editar notas no.
 *
 * Arrancaron como `it.fails` (CF-W2) y se dieron vuelta al implementar. Símbolos reales; se mockean la sesión
 * (`asUser`) y `next/cache` (setup). Fixtures por owner. Servicios del consultorio (sin fila PractitionerService),
 * sin tope por intervalo, sin franjas (fallback lun-sáb 08-19). Fechas de dic 2027 (lun = 2027-12-06).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { BookingStatus, PrismaClient } from "@prisma/client";
import { setBookingStatus, updateBooking } from "@/lib/bookings";
import { rescheduleSession } from "@/lib/sessions";
import {
  applyBookingUpdateInTx,
  countAgendaOccupancy,
  countCapacityOverlaps,
  type BookingUpdateTxOutcome,
} from "@/lib/bookings-core";
import {
  capacityKeysForWindow,
  lockAgendaKeysMany,
  practitionerDayKeysForWindow,
  practitionerDayLockKey,
} from "@/lib/booking-cap-lock";
import { otherServiceConflicts } from "@/lib/availability/exclusive-service";
import { OTHER_SERVICE_ERROR, isOtherServiceError } from "@/lib/bookings-constants";
import type { BookingOtherServicePrompt } from "@/lib/bookings-types";
import type { ForceFlags } from "@/lib/booking-force-flags";
import { BookingUpdate, type BookingUpdateInput } from "@/lib/validation";
import { runWithRls } from "@/lib/rls";
import { getActor } from "@/lib/session";
import { localToARIso } from "@/lib/datetime-ar";
import { createPlan } from "@/tests/helpers/plan-factory";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  sweepOrphanTestTenants,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { countAdvisoryWaiters, waitForAdvisoryWaiter } from "@/tests/helpers/advisory-wait";

const RUN = process.env.INTEGRATION === "1";

/** Pared AR → instante. */
const at = (day: string, hhmm: string) => new Date(localToARIso(`${day}T${hhmm}:00`));

/** Lo que CF-W2 le suma al resultado de `updateBooking` / `setBookingStatus`. */
type WithOther = { ok: boolean; error?: string; otherService?: BookingOtherServicePrompt; conflict?: unknown };
const asOther = (r: unknown) => r as WithOther;

/** El core dentro de una tx propia, con el actor de la sesión mockeada (como lo llama Planes). */
async function core(
  patch: BookingUpdateInput,
  o: { expectedUpdatedAt?: string; force?: ForceFlags; capLocksHeld?: boolean; before?: (tx: never) => Promise<void> } = {}
): Promise<BookingUpdateTxOutcome> {
  const actor = await getActor();
  return runWithRls(actor.tenantId, async (tx) => {
    if (o.before) await o.before(tx as never);
    return applyBookingUpdateInTx(
      tx,
      actor,
      { patch: BookingUpdate.parse(patch), expectedUpdatedAt: o.expectedUpdatedAt, force: o.force ?? {} },
      { now: new Date(), capLocksHeld: o.capLocksHeld }
    );
  });
}

describe.skipIf(!RUN)("[CF-W2] edición con «no atiende servicios distintos a la vez»", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let svcA: string; // «Kine», 60', ilimitado
  let svcB: string; // «Evaluación», 60', ilimitado
  let svcC: string; // «Grupo», 60', cupo 2
  let PPar: { userId: string; practitionerId: string }; // allowParallelServices = true

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    T = await createEphemeralTenant(db);
    const mkSvc = async (name: string, maxConcurrent: number | null) =>
      (
        await db.service.create({
          data: { tenantId: T.tenantId, practitionerId: null, name, durationMin: 60, priceCents: 0, maxConcurrent },
        })
      ).id;
    svcA = await mkSvc("Kine", null);
    svcB = await mkSvc("Evaluación", null);
    svcC = await mkSvc("Grupo", 2);
    PPar = await addPractitioner(db, T, "PRACTITIONER", { allowParallelServices: true });
    // No vacuo: el titular tiene la regla por defecto (M20) y el otro la tiene apagada.
    const rules = await db.practitioner.findMany({
      where: { id: { in: [T.practitionerId, PPar.practitionerId] } },
      select: { id: true, allowParallelServices: true },
    });
    expect(Object.fromEntries(rules.map((r) => [r.id, r.allowParallelServices]))).toEqual({
      [T.practitionerId]: false,
      [PPar.practitionerId]: true,
    });
    const tenant = await db.tenant.findUniqueOrThrow({ where: { id: T.tenantId }, select: { bookingCapCount: true } });
    expect(tenant.bookingCapCount).toBeNull();
  });

  beforeEach(() => asUser(T.userId));

  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });

  /** Turno cargado directo (owner). `patientId: null` = guest. */
  async function mk(o: {
    when: Date;
    svc: string;
    prac?: string;
    dur?: number;
    patientId?: string | null;
    status?: BookingStatus;
  }) {
    const patientId = o.patientId === undefined ? await addPatient(db, T) : o.patientId;
    return db.booking.create({
      data: {
        tenantId: T.tenantId,
        practitionerId: o.prac ?? T.practitionerId,
        serviceId: o.svc,
        patientId,
        scheduledFor: o.when,
        durationMin: o.dur ?? 60,
        status: o.status ?? "CONFIRMED",
        idempotencyKey: randomUUID(),
      },
    });
  }

  const row = (id: string) => db.booking.findUniqueOrThrow({ where: { id } });

  it("[CF-W2] mover sobre otro servicio del mismo profesional avisa sin escribir; allowOverbooking no lo fuerza; allowOtherService → sobreturno", async () => {
    const day = "2027-12-06";
    const A = await mk({ when: at(day, "10:00"), svc: svcA });
    const X = await mk({ when: at(day, "14:00"), svc: svcB });
    const to = at(day, "10:30").toISOString();

    const r = asOther(await updateBooking({ id: X.id, scheduledFor: to, expectedUpdatedAt: X.updatedAt.toISOString() }));
    expect(r.ok).toBe(false);
    expect(r.otherService).toEqual({
      practitionerName: expect.any(String),
      serviceName: "Kine",
      existingISO: A.scheduledFor.toISOString(),
      nextFreeISO: r.otherService?.nextFreeISO ?? null,
    });
    expect(r.error).toBe(OTHER_SERVICE_ERROR({ practitionerName: r.otherService!.practitionerName, serviceName: "Kine" }));
    expect(isOtherServiceError(r.error)).toBe(true);
    expect(r.conflict ?? null).toBeNull();
    expect(await row(X.id)).toMatchObject({ scheduledFor: X.scheduledFor, isOverbooked: false });

    // Flag propio: aceptar «ya tiene un turno» (mismo servicio) no tapa el de otro servicio.
    const ov = asOther(
      await updateBooking({ id: X.id, scheduledFor: to, expectedUpdatedAt: X.updatedAt.toISOString(), allowOverbooking: true })
    );
    expect(ov.ok).toBe(false);
    expect(ov.otherService?.serviceName).toBe("Kine");
    expect(await row(X.id)).toMatchObject({ scheduledFor: X.scheduledFor });

    const forced = await updateBooking({
      id: X.id,
      scheduledFor: to,
      expectedUpdatedAt: X.updatedAt.toISOString(),
      allowOtherService: true,
    } as Parameters<typeof updateBooking>[0]);
    expect(forced).toMatchObject({ ok: true });
    const moved = await row(X.id);
    expect(moved).toMatchObject({ scheduledFor: new Date(to), isOverbooked: true });

    // Movido a un hueco libre deja de ser sobreturno (B3.1: `isOverbooked` refleja el horario NUEVO).
    const free = await updateBooking({ id: X.id, scheduledFor: at(day, "16:00").toISOString(), expectedUpdatedAt: moved.updatedAt.toISOString() });
    expect(free).toMatchObject({ ok: true });
    expect(await row(X.id)).toMatchObject({ isOverbooked: false });
  });

  it("[CF-W2] alargar un turno hasta pisar otro servicio avisa; forzado queda sobreturno", async () => {
    const day = "2027-12-07";
    await mk({ when: at(day, "10:00"), svc: svcA });
    const X = await mk({ when: at(day, "09:00"), svc: svcB });

    const r = asOther(await updateBooking({ id: X.id, durationMin: 90, expectedUpdatedAt: X.updatedAt.toISOString() }));
    expect(r.ok).toBe(false);
    expect(r.otherService).toMatchObject({ serviceName: "Kine", existingISO: at(day, "10:00").toISOString() });
    expect(await row(X.id)).toMatchObject({ durationMin: 60 });

    const forced = await updateBooking({
      id: X.id,
      durationMin: 90,
      expectedUpdatedAt: X.updatedAt.toISOString(),
      allowOtherService: true,
    } as Parameters<typeof updateBooking>[0]);
    expect(forced).toMatchObject({ ok: true });
    expect(await row(X.id)).toMatchObject({ durationMin: 90, isOverbooked: true });
  });

  it("[CF-W2] reactivar un cancelado sobre otro servicio avisa (setBookingStatus); forzado queda sobreturno", async () => {
    const day = "2027-12-08";
    await mk({ when: at(day, "10:00"), svc: svcA });
    const Z = await mk({ when: at(day, "10:30"), svc: svcB, status: "CANCELLED" });

    const r = asOther(await setBookingStatus(Z.id, "CONFIRMED", Z.updatedAt.toISOString()));
    expect(r.ok).toBe(false);
    expect(r.otherService).toMatchObject({ serviceName: "Kine" });
    expect(await row(Z.id)).toMatchObject({ status: "CANCELLED" });

    const forced = await setBookingStatus(Z.id, "CONFIRMED", Z.updatedAt.toISOString(), { allowOtherService: true });
    expect(forced).toMatchObject({ ok: true });
    expect(await row(Z.id)).toMatchObject({ status: "CONFIRMED", isOverbooked: true });
  });

  it("[CF-W2] mismo servicio hasta el cupo: sin aviso (y el de otro profesional no cuenta); pasado el cupo es `conflict`, no otro servicio", async () => {
    const day = "2027-12-09";
    await mk({ when: at(day, "10:00"), svc: svcC });
    await mk({ when: at(day, "10:00"), svc: svcA, prac: PPar.practitionerId }); // otro profesional
    const X = await mk({ when: at(day, "14:00"), svc: svcC });
    const Y = await mk({ when: at(day, "15:00"), svc: svcC });

    const r = asOther(await updateBooking({ id: X.id, scheduledFor: at(day, "10:00").toISOString(), expectedUpdatedAt: X.updatedAt.toISOString() }));
    expect(r).toMatchObject({ ok: true });
    expect(r.otherService ?? null).toBeNull();
    expect(await row(X.id)).toMatchObject({ isOverbooked: false });

    const full = asOther(await updateBooking({ id: Y.id, scheduledFor: at(day, "10:00").toISOString(), expectedUpdatedAt: Y.updatedAt.toISOString() }));
    expect(full.ok).toBe(false);
    expect(full.conflict).toBeTruthy();
    expect(full.otherService ?? null).toBeNull();
  });

  it("[CF-W2] mismo paciente (CF-D3): otro servicio suyo no avisa; un guest no se exime", async () => {
    const day = "2027-12-10";
    const p = await addPatient(db, T);
    await mk({ when: at(day, "10:00"), svc: svcA, patientId: p });
    const X = await mk({ when: at(day, "14:00"), svc: svcB, patientId: p });
    // Su propia superposición la pregunta el guard del paciente (ortogonal); aceptada, no hay aviso de otro servicio.
    const r = asOther(
      await updateBooking({
        id: X.id,
        scheduledFor: at(day, "10:30").toISOString(),
        expectedUpdatedAt: X.updatedAt.toISOString(),
        allowPatientOverlap: true,
      })
    );
    expect(r).toMatchObject({ ok: true });
    expect(r.otherService ?? null).toBeNull();
    expect(await row(X.id)).toMatchObject({ scheduledFor: at(day, "10:30"), isOverbooked: false });

    // Dos guests: no sabemos si son la misma persona → avisa.
    await mk({ when: at(day, "16:00"), svc: svcA, patientId: null });
    const G = await mk({ when: at(day, "18:00"), svc: svcB, patientId: null, status: "PENDING" });
    const g = asOther(await updateBooking({ id: G.id, scheduledFor: at(day, "16:30").toISOString(), expectedUpdatedAt: G.updatedAt.toISOString() }));
    expect(g.ok).toBe(false);
    expect(g.otherService).toMatchObject({ serviceName: "Kine" });
  });

  it("[CF-W2] toggle prendido = conducta vieja (y se lee después del lock: un cambio en caliente se ve)", async () => {
    const day = "2027-12-13";
    // Con el interruptor prendido desde el alta del profesional: mueve sin aviso ni sobreturno.
    await mk({ when: at(day, "10:00"), svc: svcA, prac: PPar.practitionerId });
    const X = await mk({ when: at(day, "14:00"), svc: svcB, prac: PPar.practitionerId });
    const r = asOther(await updateBooking({ id: X.id, scheduledFor: at(day, "10:30").toISOString(), expectedUpdatedAt: X.updatedAt.toISOString() }));
    expect(r).toMatchObject({ ok: true });
    expect(r.otherService ?? null).toBeNull();
    expect(await row(X.id)).toMatchObject({ isOverbooked: false });

    // Un profesional con la regla: avisa; prendido el interruptor, el MISMO pedido entra sin forzar.
    const PX = await addPractitioner(db, T, "PRACTITIONER");
    await mk({ when: at(day, "10:00"), svc: svcA, prac: PX.practitionerId });
    const Y = await mk({ when: at(day, "14:00"), svc: svcB, prac: PX.practitionerId });
    const req = { id: Y.id, scheduledFor: at(day, "10:30").toISOString(), expectedUpdatedAt: Y.updatedAt.toISOString() };
    expect(asOther(await updateBooking(req)).otherService).toMatchObject({ serviceName: "Kine" });
    await db.practitioner.update({ where: { id: PX.practitionerId }, data: { allowParallelServices: true } });
    const on = asOther(await updateBooking(req));
    expect(on).toMatchObject({ ok: true });
    expect(await row(Y.id)).toMatchObject({ scheduledFor: at(day, "10:30"), isOverbooked: false });
  });

  it("[CF-W2] rescheduleSession: mover el turno de la sesión sobre otro servicio se rechaza; con allowOtherService entra como sobreturno", async () => {
    const day = "2027-12-14";
    await mk({ when: at(day, "10:00"), svc: svcA });
    const p = await createPlan(db, T, { sessions: 1, bookings: 1 });
    const [b] = p.bookingIds;
    const was = (await row(b)).scheduledFor;
    await db.session.update({ where: { id: p.sessionIds[0] }, data: { scheduledFor: was } });
    const to = at(day, "10:30").toISOString();
    const FORCE = { allowOutOfHours: true, allowBlocked: true, allowPatientOverlap: true, allowOverbooking: true };

    const r = await rescheduleSession({ sessionId: p.sessionIds[0], scheduledFor: to, force: FORCE });
    expect(r).toMatchObject({ ok: false, error: OTHER_SERVICE_ERROR({}) });
    expect(isOtherServiceError((r as { error?: string }).error)).toBe(true);
    expect(+(await row(b)).scheduledFor).toBe(+was);

    const ok = await rescheduleSession({
      sessionId: p.sessionIds[0],
      scheduledFor: to,
      force: { ...FORCE, allowOtherService: true } as typeof FORCE,
    });
    expect(ok).toMatchObject({ ok: true });
    expect(await row(b)).toMatchObject({ scheduledFor: new Date(to), isOverbooked: true });
  });

  it("[CF-W2] capLocksHeld (Planes, CF-D12): el core igual chequea la regla con los locks del caller; forzado queda sobreturno", async () => {
    const day = "2027-12-15";
    const A = await mk({ when: at(day, "10:00"), svc: svcA });
    const X = await mk({ when: at(day, "14:00"), svc: svcB });
    const start = at(day, "10:30");
    const end = new Date(start.getTime() + 60 * 60_000);
    // Lo que toma el caller de Planes (superconjunto: cupo + día, sin hora).
    const callerLocks = async (tx: never) => {
      const w = { tenantId: T.tenantId, practitionerId: T.practitionerId, start, end };
      await lockAgendaKeysMany(tx, {
        cap: capacityKeysForWindow({ ...w, serviceId: svcB }),
        pday: practitionerDayKeysForWindow(w),
      });
    };
    const patch = { id: X.id, scheduledFor: start.toISOString() } as BookingUpdateInput;

    const out = await core(patch, { expectedUpdatedAt: X.updatedAt.toISOString(), capLocksHeld: true, before: callerLocks });
    expect(out).toMatchObject({ kind: "other-service", otherServiceId: svcA, existingAt: A.scheduledFor });
    expect(await row(X.id)).toMatchObject({ scheduledFor: X.scheduledFor });

    const forced = await core(patch, {
      expectedUpdatedAt: X.updatedAt.toISOString(),
      capLocksHeld: true,
      before: callerLocks,
      force: { allowOverbooking: true, allowOtherService: true },
    });
    expect(forced.kind).toBe("ok");
    expect(await row(X.id)).toMatchObject({ scheduledFor: start, isOverbooked: true });
  });

  it("[CF-W2] locks: mover y reactivar esperan el `pday` del día nuevo; editar notas y `capLocksHeld` no lo piden", async () => {
    const day = "2027-12-16";
    const X = await mk({ when: at(day, "14:00"), svc: svcB });
    const Z = await mk({ when: at(day, "16:00"), svc: svcA, status: "CANCELLED" });
    const N = await mk({ when: at(day, "17:00"), svc: svcA });
    const C = await mk({ when: at(day, "11:00"), svc: svcA });
    const key = practitionerDayLockKey({ tenantId: T.tenantId, practitionerId: T.practitionerId, dayKey: day });

    const holder = ownerClient();
    const probe = ownerClient();
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let acquired!: () => void;
    const got = new Promise<void>((r) => (acquired = r));
    const held = holder.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
        acquired();
        await released;
      },
      { timeout: 30_000 }
    );
    const TIMEOUT = Symbol("timeout");
    const within = <R>(p: Promise<R>, ms: number) =>
      Promise.race([p, new Promise<typeof TIMEOUT>((r) => setTimeout(() => r(TIMEOUT), ms))]);
    try {
      await got;
      // Sin cambio de ventana: no toma el día (no espera al holder).
      const notes = await within(
        updateBooking({ id: N.id, notes: "Trae estudios", expectedUpdatedAt: N.updatedAt.toISOString() }),
        4_000
      );
      expect(notes).toMatchObject({ ok: true });
      // Planes ya tomó cupo y día: el core no los vuelve a pedir.
      const planes = await within(
        core({ id: C.id, scheduledFor: at(day, "11:30").toISOString() } as BookingUpdateInput, {
          expectedUpdatedAt: C.updatedAt.toISOString(),
          capLocksHeld: true,
        }),
        4_000
      );
      expect(planes).toMatchObject({ kind: "ok" });

      const move = updateBooking({ id: X.id, scheduledFor: at(day, "09:00").toISOString(), expectedUpdatedAt: X.updatedAt.toISOString() });
      const react = setBookingStatus(Z.id, "CONFIRMED", Z.updatedAt.toISOString());
      await waitForAdvisoryWaiter(probe, key, { minWaiters: 2, timeoutMs: 8_000 });
      release();
      expect(await move).toMatchObject({ ok: true });
      expect(await react).toMatchObject({ ok: true });
      expect(await countAdvisoryWaiters(probe, key)).toBe(0);
    } finally {
      release();
      await held.catch(() => undefined);
      await holder.$disconnect();
      await probe.$disconnect();
    }
  });

  // ── ZF1 (cierre CF, hallazgo M1 del revisor ZA): cambiar el PACIENTE también puede romper la regla ─────────────────
  // Ana tiene Evaluación 10:00 y Kine 10:15 con el mismo profesional: permitido, es la misma persona (CF-D3). Pasarle el
  // Kine a Beto sin tocar horario ni duración dejaba dos pacientes distintos en servicios distintos a la vez, sin aviso:
  // el conteo con `exclusiveService` (y el `pday`) corrían solo con `windowChanged`.

  /** Ana con Evaluación 10:00 y Kine 10:15 (60' c/u, se pisan) del profesional `prac`; devuelve el Kine. */
  async function anaTwoServices(day: string, prac = T.practitionerId) {
    const ana = await addPatient(db, T);
    const E = await mk({ when: at(day, "10:00"), svc: svcB, patientId: ana, prac });
    const K = await mk({ when: at(day, "10:15"), svc: svcA, patientId: ana, prac });
    return { ana, E, K };
  }

  it("[ZF1] cambiar el paciente sobre otro servicio pisado → aviso sin escribir; forzado → isOverbooked", async () => {
    const { ana, E, K } = await anaTwoServices("2027-12-20");
    const beto = await addPatient(db, T);

    const r = asOther(await updateBooking({ id: K.id, patientId: beto, expectedUpdatedAt: K.updatedAt.toISOString() }));
    expect(r.ok).toBe(false);
    expect(r.otherService).toMatchObject({ serviceName: "Evaluación", existingISO: E.scheduledFor.toISOString() });
    expect(isOtherServiceError(r.error)).toBe(true);
    expect(r.conflict ?? null).toBeNull();
    expect(await row(K.id)).toMatchObject({ patientId: ana, isOverbooked: false, updatedAt: K.updatedAt });

    // Mismo flag propio que al mover: `allowOverbooking` (cupo del servicio) no lo tapa.
    const ov = asOther(
      await updateBooking({ id: K.id, patientId: beto, expectedUpdatedAt: K.updatedAt.toISOString(), allowOverbooking: true })
    );
    expect(ov.otherService?.serviceName).toBe("Evaluación");
    expect(await row(K.id)).toMatchObject({ patientId: ana });

    const forced = await updateBooking({
      id: K.id,
      patientId: beto,
      expectedUpdatedAt: K.updatedAt.toISOString(),
      allowOtherService: true,
    } as Parameters<typeof updateBooking>[0]);
    expect(forced).toMatchObject({ ok: true });
    expect(await row(K.id)).toMatchObject({ patientId: beto, scheduledFor: K.scheduledFor, isOverbooked: true });
  });

  it("[ZF1] cambiar el paciente al MISMO del otro servicio → sin aviso (CF-D3); el sobreturno no se toca", async () => {
    const day = "2027-12-21";
    const ana = await addPatient(db, T);
    await mk({ when: at(day, "10:00"), svc: svcB, patientId: ana });
    const K = await mk({ when: at(day, "10:15"), svc: svcA }); // de otro paciente
    // Su propia superposición la pregunta el guard del paciente (ortogonal); aceptada, no hay aviso de otro servicio.
    const r = asOther(
      await updateBooking({ id: K.id, patientId: ana, expectedUpdatedAt: K.updatedAt.toISOString(), allowPatientOverlap: true })
    );
    expect(r).toMatchObject({ ok: true });
    expect(r.otherService ?? null).toBeNull();
    expect(await row(K.id)).toMatchObject({ patientId: ana, isOverbooked: false });
  });

  it("[ZF1] toggle prendido → conducta vieja: cambiar el paciente sobre otro servicio entra sin aviso ni sobreturno", async () => {
    const { K } = await anaTwoServices("2027-12-22", PPar.practitionerId);
    const beto = await addPatient(db, T);
    const r = asOther(await updateBooking({ id: K.id, patientId: beto, expectedUpdatedAt: K.updatedAt.toISOString() }));
    expect(r).toMatchObject({ ok: true });
    expect(r.otherService ?? null).toBeNull();
    expect(await row(K.id)).toMatchObject({ patientId: beto, isOverbooked: false });
  });

  it("[ZF1] cambiar el paciente sin choque → ok; un cupo del MISMO servicio ya pasado no se re-pregunta", async () => {
    const day = "2027-12-23";
    await mk({ when: at(day, "10:00"), svc: svcB });
    const X = await mk({ when: at(day, "14:00"), svc: svcA });
    const r = asOther(await updateBooking({ id: X.id, patientId: await addPatient(db, T), expectedUpdatedAt: X.updatedAt.toISOString() }));
    expect(r).toMatchObject({ ok: true });
    expect(await row(X.id)).toMatchObject({ isOverbooked: false });

    // «Grupo» (cupo 2) con 3 a las 16:00 (uno ya forzado): cambiar el paciente de uno no es `conflict` (el cupo no se
    // mueve: el turno sigue ocupando el mismo lugar) ni otro servicio (son todos del mismo).
    await mk({ when: at(day, "16:00"), svc: svcC });
    await mk({ when: at(day, "16:00"), svc: svcC });
    const G = await mk({ when: at(day, "16:00"), svc: svcC });
    const g = asOther(await updateBooking({ id: G.id, patientId: await addPatient(db, T), expectedUpdatedAt: G.updatedAt.toISOString() }));
    expect(g).toMatchObject({ ok: true });
    expect(g.conflict ?? null).toBeNull();
    expect(g.otherService ?? null).toBeNull();
    expect(await row(G.id)).toMatchObject({ isOverbooked: false });
  });

  it("[ZF1] lock: cambiar el paciente espera el `pday` del día del turno (serializa con un alta de otro servicio)", async () => {
    const day = "2027-12-24";
    const X = await mk({ when: at(day, "10:00"), svc: svcA });
    const to = await addPatient(db, T);
    const key = practitionerDayLockKey({ tenantId: T.tenantId, practitionerId: T.practitionerId, dayKey: day });
    const holder = ownerClient();
    const probe = ownerClient();
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let acquired!: () => void;
    const got = new Promise<void>((r) => (acquired = r));
    const held = holder.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
        acquired();
        await released;
      },
      { timeout: 30_000 }
    );
    try {
      await got;
      const change = updateBooking({ id: X.id, patientId: to, expectedUpdatedAt: X.updatedAt.toISOString() });
      await waitForAdvisoryWaiter(probe, key, { minWaiters: 1, timeoutMs: 8_000 });
      release();
      expect(await change).toMatchObject({ ok: true });
    } finally {
      release();
      await held.catch(() => undefined);
      await holder.$disconnect();
      await probe.$disconnect();
    }
  });

  it("[CF-W2] countAgendaOccupancy con exclusiveService: overlap === countCapacityOverlaps; otherService = otherServiceConflicts", async () => {
    const PZ = await addPractitioner(db, T, "PRACTITIONER");
    const day = "2027-12-17";
    const now = new Date();
    const same = await addPatient(db, T);
    // Servicios mezclados, una sesión larga que viene de antes (≤ 480'), un cancelado, una reserva pública impaga
    // vencida (no retiene), un guest y uno del paciente de la consulta (exento por CF-D3).
    const fixtures: { when: string; svc: string; dur: number; status?: BookingStatus; pub?: boolean; patientId?: string | null }[] = [
      { when: "07:30", svc: svcA, dur: 180 },
      { when: "10:00", svc: svcA, dur: 60 },
      { when: "10:05", svc: svcB, dur: 30 },
      { when: "10:20", svc: svcB, dur: 45, status: "CANCELLED" },
      { when: "10:25", svc: svcB, dur: 30, status: "PENDING", pub: true },
      { when: "10:40", svc: svcC, dur: 45, patientId: null },
      { when: "11:00", svc: svcB, dur: 30, patientId: same },
    ];
    const ids: string[] = [];
    for (const f of fixtures) {
      const patientId = f.patientId === undefined ? await addPatient(db, T) : f.patientId;
      const b = await db.booking.create({
        data: {
          tenantId: T.tenantId,
          practitionerId: PZ.practitionerId,
          serviceId: f.svc,
          patientId,
          scheduledFor: at(day, f.when),
          durationMin: f.dur,
          status: f.status ?? "CONFIRMED",
          paymentStatus: "UNPAID",
          idempotencyKey: f.pub ? `pub:${randomUUID()}:x` : randomUUID(),
          ...(f.pub ? { createdAt: new Date(now.getTime() - 3 * 60 * 60_000) } : {}),
        },
      });
      ids.push(b.id);
    }
    const all = await db.booking.findMany({
      where: { tenantId: T.tenantId, practitionerId: PZ.practitionerId, status: { not: "CANCELLED" } },
      orderBy: { scheduledFor: "asc" },
    });
    let checked = 0;
    let sawOther = 0;
    for (const hhmm of ["09:00", "10:00", "10:30", "10:50", "11:15", "12:00"])
      for (const dur of [5, 45, 120])
        for (const svc of [svcA, svcB, svcC])
          for (const patientId of [null, same])
            for (const excludeId of [undefined, ids[1]]) {
              const start = at(day, hhmm);
              const end = new Date(start.getTime() + dur * 60_000);
              const o = { tenantId: T.tenantId, practitionerId: PZ.practitionerId, serviceId: svc, start, end, now, excludeId };
              const [legacy, occ, off] = await runWithRls(T.tenantId, async (tx) => [
                await countCapacityOverlaps(tx, o),
                await countAgendaOccupancy(tx, { ...o, exclusiveService: true, patientId }),
                await countAgendaOccupancy(tx, { ...o, patientId }),
              ] as const);
              expect(occ.overlap).toBe(legacy);
              const expected = otherServiceConflicts(all, {
                practitionerId: PZ.practitionerId,
                serviceId: svc,
                patientId,
                start,
                end,
                now,
                excludeBookingId: excludeId,
              });
              expect(occ.otherService.count).toBe(expected.length);
              const first = expected.length
                ? expected.reduce((m, b) => (b.scheduledFor < m.scheduledFor ? b : m))
                : null;
              expect(occ.otherService.first).toEqual(first ? { serviceId: first.serviceId, scheduledFor: first.scheduledFor } : null);
              // Sin la regla no se cuenta (y el cupo es el de siempre).
              expect(off).toMatchObject({ overlap: legacy, otherService: { count: 0, first: null } });
              if (expected.length) sawOther++;
              checked++;
            }
    expect(checked).toBe(6 * 3 * 3 * 2 * 2);
    expect(sawOther).toBeGreaterThan(20); // no vacuo
  });
});
