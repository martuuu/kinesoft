/**
 * [AS-2w] T3d-2w (C-AS3, enmienda C2 (1c) de ADR-004) — la clave de HORA del profesional en los write-paths REALES,
 * contra Postgres real en los dos roles. `locks-interval.test.ts` prueba `lockAgendaKeysMany` con claves sintéticas;
 * acá se prueba que las acciones (`createBooking`, `updateBooking`, `movePlanSeries`, `applyDayLock`) la toman en el
 * orden del contrato y que juntas no se esperan en ciclo:
 *
 *   paciente → cupo → HORA → sala → sedes → filas
 *
 *   1. un alta con sala que espera la hora ya tiene TODO su cupo y NINGUNA sala (ni tomada ni pedida);
 *   2. alta con sala elegida ∥ edición con sala por defecto (la clave de sala va en una 2.ª sentencia, después del
 *      cupo + hora): las dos esperan la sala con su cupo y su hora tomados, y terminan con resultado de dominio;
 *   3. «este y los siguientes» (Planes: superconjunto de cupo SIN hora, `capLocksHeld`) ∥ alta en la misma hora y el
 *      mismo servicio: el plan espera el cupo que el alta tiene, el alta espera la hora; sin ciclo, sin 40P01;
 *   4. `applyDayLock` (cupo de profesional × servicios × día, sin hora) ∥ alta que espera la hora: ídem.
 *
 * "Sin 40P01": `createBooking`, `updateBooking` y `applyDayLock` no reintentan y enmascaran cualquier excepción como
 * error genérico («No pudimos …»): que terminen con un resultado de dominio prueba que ningún deadlock los tocó
 * (patrón de `plans-concurrency.test.ts`). Barreras deterministas: un holder retiene la clave y
 * `waitForAdvisoryWaiter` filtra la clave exacta (C14); nada de sleeps.
 *
 * Fechas en mar 2030 (lun = 2030-03-04). TZ=UTC: 10:00 AR = 13:00Z.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { createBooking, updateBooking } from "@/lib/bookings";
import { applyDayLock } from "@/lib/time-blocks";
import { createPlan, previewPlan } from "@/lib/plans";
import { movePlanSeries, previewMovePlanSeries } from "@/lib/plans-move";
import type { PlanCreateInput, PlanPreview, PlanRowResolution } from "@/lib/plans-types";
import {
  capacityKeysForWindow,
  capacityLockKey,
  hourKeyForStart,
  hourLockKey,
  roomLockKey,
} from "@/lib/booking-cap-lock";
import { dayKeyOf } from "@/lib/availability/day";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  addRoom,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { countAdvisoryWaiters, waitForAdvisoryWaiter } from "@/tests/helpers/advisory-wait";

const RUN = process.env.INTEGRATION === "1";

const ar = (local: string) => new Date(`${local}:00-03:00`);

/** Lo que las acciones de agenda devuelven cuando enmascaran una excepción (p. ej. un 40P01). */
const GENERIC = /No pudimos|deadlock|40P01|P2034/i;

function acceptDefaults(p: PlanPreview): PlanRowResolution[] {
  return p.rows.map((r) =>
    r.defaultResolution === "move"
      ? { index: r.index, kind: "move", at: r.suggestion }
      : r.defaultResolution === "adopt"
        ? { index: r.index, kind: "adopt", bookingId: r.flags.duplicate!.bookingId, expectedUpdatedAt: r.flags.duplicate!.updatedAt }
        : { index: r.index, kind: r.defaultResolution }
  );
}

describe.skipIf(!RUN)("[AS-2w] clave de hora en los write-paths: orden cupo → hora → sala, sin ciclos", () => {
  let db: PrismaClient;
  let holderDb: PrismaClient;
  let T: EphemeralTenant;
  let B: { userId: string; practitionerId: string };
  let svc: string; // del consultorio (A y B)
  let L1: string;
  let R1: string;

  beforeAll(async () => {
    db = ownerClient();
    holderDb = ownerClient();
    T = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    B = await addPractitioner(db, T, "PRACTITIONER");
    svc = (
      await db.service.create({
        data: { tenantId: T.tenantId, practitionerId: null, name: "Kine", durationMin: 45, priceCents: 0 },
      })
    ).id;
    L1 = (await db.location.create({ data: { tenantId: T.tenantId, name: "Centro", isPrimary: true } })).id;
    R1 = (await addRoom(db, T, { locationId: L1, name: "Consultorio 1", capacity: 1 })).roomId;
    // Los dos profesionales atienden en el Consultorio 1 de lun a sáb, 08-20: la sala por defecto de cualquier
    // turno es R1.
    const week = [1, 2, 3, 4, 5, 6];
    await db.practitionerSchedule.createMany({
      data: [T.practitionerId, B.practitionerId].flatMap((practitionerId) =>
        week.map((dow) => ({ tenantId: T.tenantId, practitionerId, locationId: L1, roomId: R1, dow, startMin: 480, endMin: 1200 }))
      ),
    });
  });

  beforeEach(() => asUser(T.userId));

  afterAll(async () => {
    await T?.cleanup();
    await Promise.all([db?.$disconnect(), holderDb?.$disconnect()]);
  });

  /** Toma `key` en una tx del owner hasta `release()`. */
  async function hold(key: string) {
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let acquired!: () => void;
    const got = new Promise<void>((r) => (acquired = r));
    const done = holderDb.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
        acquired();
        await released;
      },
      { timeout: 30_000 }
    );
    await got;
    return { release, done };
  }

  /** Pids que esperan (NOT granted) el advisory de `key`. */
  async function waitersOf(key: string): Promise<number[]> {
    const rows = await db.$queryRaw<{ pid: number }[]>`
      WITH k AS (SELECT hashtextextended(${key}, 0) AS v)
      SELECT l.pid FROM pg_locks l, k
      WHERE l.locktype = 'advisory' AND NOT l.granted AND l.objsubid = 1
        AND l.classid = ((k.v >> 32) & 4294967295)::oid
        AND l.objid = (k.v & 4294967295)::oid
      ORDER BY l.pid`;
    return rows.map((r) => r.pid);
  }

  /** ¿La sesión `pid` tiene CONCEDIDO el advisory de `key`? */
  async function grantedTo(pid: number, key: string): Promise<boolean> {
    const rows = await db.$queryRaw<{ n: number }[]>`
      WITH k AS (SELECT hashtextextended(${key}, 0) AS v)
      SELECT count(*)::int AS n FROM pg_locks l, k
      WHERE l.locktype = 'advisory' AND l.granted AND l.pid = ${pid} AND l.objsubid = 1
        AND l.classid = ((k.v >> 32) & 4294967295)::oid
        AND l.objid = (k.v & 4294967295)::oid`;
    return (rows[0]?.n ?? 0) > 0;
  }

  const capKeys = (practitionerId: string, serviceId: string, start: Date, durationMin = 45) =>
    capacityKeysForWindow({ tenantId: T.tenantId, practitionerId, serviceId, start, end: new Date(start.getTime() + durationMin * 60_000) }).map(
      capacityLockKey
    );
  const hourKey = (practitionerId: string, start: Date) => hourLockKey(hourKeyForStart({ tenantId: T.tenantId, practitionerId, start }));
  const roomKey = (when: Date) => roomLockKey({ tenantId: T.tenantId, roomId: R1, dayKey: dayKeyOf(when) });

  const alta = async (o: { prac: string; when: Date; serviceId?: string; room?: boolean }) =>
    createBooking({
      patientId: await addPatient(db, T),
      serviceId: o.serviceId ?? svc,
      practitionerId: o.prac,
      scheduledFor: o.when.toISOString(),
      ...(o.room ? { roomId: R1, locationId: L1 } : {}),
      idempotencyKey: randomUUID(),
    });

  it("alta con sala que espera la HORA: tiene todo su cupo y ninguna sala (ni tomada ni pedida)", async () => {
    const when = ar("2030-03-04T10:00");
    const hk = hourKey(T.practitionerId, when);
    const h = await hold(hk);
    const p = alta({ prac: T.practitionerId, when, room: true });
    try {
      await waitForAdvisoryWaiter(db, hk);
      const [pid] = await waitersOf(hk);
      for (const k of capKeys(T.practitionerId, svc, when)) expect({ k, granted: await grantedTo(pid, k) }).toEqual({ k, granted: true });
      expect(await grantedTo(pid, roomKey(when))).toBe(false);
      expect(await countAdvisoryWaiters(db, roomKey(when))).toBe(0);
    } finally {
      h.release();
      await h.done;
    }
    const r = await p;
    expect(r).toMatchObject({ ok: true });
  });

  it("alta con sala elegida ∥ edición con sala por defecto (otro profesional, misma sala): las dos esperan la sala con su cupo y su hora; sin 40P01", async () => {
    const day = "2030-03-05";
    const rk = roomKey(ar(`${day}T10:00`));
    // Turno de B a las 15 SIN sala: moverlo a las 10:05 le asigna la sala por defecto de la franja (R1), cuya clave
    // la edición toma en una 2.ª sentencia (después del cupo + hora).
    const e = await db.booking.create({
      data: {
        tenantId: T.tenantId,
        practitionerId: B.practitionerId,
        serviceId: svc,
        patientId: await addPatient(db, T),
        scheduledFor: ar(`${day}T15:00`),
        durationMin: 45,
        status: "CONFIRMED",
        locationId: L1,
        idempotencyKey: randomUUID(),
      },
    });
    const h = await hold(rk);
    const pa = alta({ prac: T.practitionerId, when: ar(`${day}T10:00`), room: true });
    let pe: ReturnType<typeof updateBooking> | null = null;
    try {
      await waitForAdvisoryWaiter(db, rk);
      pe = updateBooking({ id: e.id, scheduledFor: ar(`${day}T10:05`).toISOString(), expectedUpdatedAt: e.updatedAt.toISOString() });
      await waitForAdvisoryWaiter(db, rk, { minWaiters: 2 });
      const pids = await waitersOf(rk);
      expect(pids).toHaveLength(2);
      // Cada waiter de la sala ya tiene su cupo y su hora (C2 (1c): sala después de cupo y hora).
      const owned = async (pid: number, prac: string, at: Date) => {
        for (const k of [...capKeys(prac, svc, at), hourKey(prac, at)]) if (!(await grantedTo(pid, k))) return false;
        return true;
      };
      const a = ar(`${day}T10:00`);
      const b = ar(`${day}T10:05`);
      const byPid = await Promise.all(pids.map(async (pid) => ({ A: await owned(pid, T.practitionerId, a), B: await owned(pid, B.practitionerId, b) })));
      expect(byPid.filter((x) => x.A && !x.B)).toHaveLength(1);
      expect(byPid.filter((x) => x.B && !x.A)).toHaveLength(1);
    } finally {
      h.release();
      await h.done;
    }
    const [ra, re] = await Promise.all([pa, pe!]);
    for (const r of [ra, re]) if (!r.ok) expect(r.error).not.toMatch(GENERIC);
    // Sala de capacidad 1 y dos profesionales solapados: entra uno, el otro recibe el aviso de sala (forzable).
    const oks = [ra, re].filter((r) => r.ok);
    expect(oks).toHaveLength(1);
    expect([ra, re].find((r) => !r.ok)).toMatchObject({ ok: false, roomBusy: { roomName: "Consultorio 1" } });
  });

  it("«este y los siguientes» (cupo sin hora) ∥ alta en la misma hora y servicio que espera la hora: sin ciclo, sin 40P01", async () => {
    const patientId = await addPatient(db, T);
    const input: PlanCreateInput = {
      idempotencyKey: randomUUID(),
      patientId,
      discipline: "KINESIOLOGY",
      practitionerId: T.practitionerId,
      serviceId: svc,
      locationId: null,
      schedule: { v: 1, frequency: "weekly", slots: [{ dow: 1, startMin: 9 * 60 }] },
      startDayKey: "2030-03-11",
      totalSessions: 2,
      pricing: null,
      rows: [],
      stateToken: "x",
    };
    const pp = await previewPlan(input);
    if (!pp.ok) throw new Error(pp.error);
    const created = await createPlan({ ...input, stateToken: pp.preview.stateToken, rows: acceptDefaults(pp.preview) });
    if (!created.ok) throw new Error(JSON.stringify(created));
    const sessions = await db.session.findMany({ where: { programId: created.programId }, orderBy: { index: "asc" } });
    const to = ar("2030-03-11T11:00");
    const mp = await previewMovePlanSeries({ programId: created.programId, fromSessionId: sessions[0].id, at: to.toISOString() });
    if (!mp.ok) throw new Error(mp.error);

    const when = ar("2030-03-11T11:05");
    const hk = hourKey(T.practitionerId, when);
    const ck = capKeys(T.practitionerId, svc, when)[0];
    const h = await hold(hk);
    // 1) El alta toma el cupo (A, svc, día) y espera la hora.
    const pa = alta({ prac: T.practitionerId, when });
    let pm: ReturnType<typeof movePlanSeries> | null = null;
    try {
      await waitForAdvisoryWaiter(db, hk);
      // 2) El plan pide su superconjunto de cupo (mismo profesional + servicio + día) y espera al alta. NO pide la hora.
      pm = movePlanSeries({
        programId: created.programId,
        fromSessionId: sessions[0].id,
        at: to.toISOString(),
        rows: acceptDefaults(mp.preview),
        stateToken: mp.preview.stateToken,
      });
      await waitForAdvisoryWaiter(db, ck);
      expect(await countAdvisoryWaiters(db, hk)).toBe(1); // solo el alta: el plan nunca pide la hora
    } finally {
      h.release();
      await h.done;
    }
    const [ra, rm] = await Promise.all([pa, pm!]);
    if (!ra.ok) expect(ra.error).not.toMatch(GENERIC);
    expect(ra).toMatchObject({ ok: true });
    expect(rm).toMatchObject({ ok: true });
  });

  it("applyDayLock (cupo × servicios × día, sin hora) ∥ alta que espera la hora: sin ciclo, sin 40P01", async () => {
    const day = "2030-03-07";
    const when = ar(`${day}T10:00`);
    const hk = hourKey(T.practitionerId, when);
    const ck = capKeys(T.practitionerId, svc, when)[0];
    const h = await hold(hk);
    const pa = alta({ prac: T.practitionerId, when });
    let pl: ReturnType<typeof applyDayLock> | null = null;
    try {
      await waitForAdvisoryWaiter(db, hk);
      pl = applyDayLock({
        dayKey: day,
        practitionerIds: [T.practitionerId],
        allDay: false,
        startMin: 9 * 60,
        endMin: 13 * 60,
        reason: "Congreso",
        bookingsDecision: "keep",
        expectedAffectedIds: [],
      });
      await waitForAdvisoryWaiter(db, ck);
      expect(await countAdvisoryWaiters(db, hk)).toBe(1); // el candado no pide la hora
    } finally {
      h.release();
      await h.done;
    }
    const [ra, rl] = await Promise.all([pa, pl!]);
    expect(ra).toMatchObject({ ok: true });
    // El candado vio el turno nuevo después del lock: «cambió» (dominio), nunca el genérico de un 40P01.
    if (!rl.ok) expect(rl.error).not.toMatch(GENERIC);
  });
});
