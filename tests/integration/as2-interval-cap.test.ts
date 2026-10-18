/**
 * [AS-2w] / [AS-2l] T3 (C-AS3, decisión 6 del 19-oct) — tope «N turnos cada X min» en los write-paths y el turnero,
 * contra Postgres real en los dos roles. Arrancó en `it.fails` (T3b-2k publicó los contratos); T3c-2l dio vuelta el
 * del turnero y T3d-2w los de `lib/bookings.ts` / `lib/bookings-core.ts`, y sumó la edición, la reactivación,
 * `rescheduleSession` y la paridad `countAgendaOccupancy` ↔ `countCapacityOverlaps`.
 *
 * Contratos que estos tests fijan (C-AS3 literal, `wip-20/brief-t3.md`):
 *   - Regla: cuentan los turnos que retienen cupo (`isHoldingCapacity`, §5.18), de CUALQUIER servicio, del
 *     profesional, que EMPIEZAN en el mismo intervalo AR alineado a la hora (`intervalStartsUsed`,
 *     `lib/availability/interval-cap.ts`). Tope efectivo con `effectiveIntervalCap` (INHERIT / NONE / CUSTOM).
 *   - `createBooking` (`ok: true`) devuelve `intervalCapNotice: BookingIntervalCapNotice` cuando ya hay ≥ 1 y no se
 *     llegó al tope («Ya hay 1 turno de {Profesional} a las 10:00.», sin confirmar).
 *   - Con el tope lleno: `ok: false` + `intervalCap: BookingIntervalCapPrompt` (`{practitionerName, used, cap,
 *     fromTime, toTime, nextFreeISO}`), sin escribir; con `allowIntervalCap: true` escribe y el turno queda
 *     `isOverbooked` (es sobreturno).
 *   - Lock `kinesoft:phour:<t>:<prac>:<hora AR>` en la MISMA sentencia que el cupo (`lockAgendaKeysMany`, orden
 *     cupo → hora → sala): dos altas concurrentes de servicios distintos con tope 1 → entra una.
 *   - Turnero: duro (el horario no se ofrece). Lote: la fecha sale `intervalCapped: true` y se OMITE sin
 *     `allowIntervalCap`; con el flag entra como sobreturno.
 *   - Edición (T3d-2w): pregunta solo si el turno cambia de intervalo AR o se reactiva; cambiar la duración o
 *     moverlo dentro del mismo intervalo no pregunta (y un sobreturno por tope sigue `isOverbooked`).
 *
 * Símbolos reales; se mockean la sesión, `next/cache` y el rate-limit del turnero (red). Fixtures por owner. Fechas
 * de nov 2027 (lun = 2027-11-01) y una fecha futura cercana para el turnero (anticipación/horizonte).
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...actual, rateLimit: async () => ({ ok: true, remaining: 99, retryAfterMs: 0 }) };
});

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { createBooking, createBookingsBatch, setBookingStatus, updateBooking } from "@/lib/bookings";
import { rescheduleSession } from "@/lib/sessions";
import { countAgendaOccupancy, countCapacityOverlaps } from "@/lib/bookings-core";
import { intervalStartsUsed, type IntervalCap } from "@/lib/availability/interval-cap";
import { runWithRls } from "@/lib/rls";
import { createPlan } from "@/tests/helpers/plan-factory";
import { listPublicSlots } from "@/lib/public-booking";
import { hourKeyForStart, hourLockKey } from "@/lib/booking-cap-lock";
import type { BookingIntervalCapNotice, BookingIntervalCapPrompt } from "@/lib/bookings-types";
import { localToARIso, toARDateKey, toARDow, toARMinutes } from "@/lib/datetime-ar";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  sweepOrphanTestTenants,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { waitForAdvisoryWaiter } from "@/tests/helpers/advisory-wait";

const RUN = process.env.INTEGRATION === "1";

/** Pared AR → instante. */
const ar = (local: string) => new Date(`${local}:00-03:00`);

/** El próximo `dow` (0=Dom) entre 7 y 13 días adelante, en calendario AR (dentro del horizonte del turnero). */
function futureDow(dow: number): string {
  for (let d = 7; ; d++) {
    const key = toARDateKey(new Date(Date.now() + d * 86_400_000));
    if (toARDow(new Date(localToARIso(`${key}T12:00:00`))) === dow) return key;
  }
}

type CreateInput = Parameters<typeof createBooking>[0];
/** Lo que T3d-2w le suma al resultado de `createBooking` (C-AS3). Cast local: el tipo real lo amplía 2w. */
type CreateResultT3 = Awaited<ReturnType<typeof createBooking>> & {
  intervalCap?: BookingIntervalCapPrompt;
  intervalCapNotice?: BookingIntervalCapNotice;
};

describe.skipIf(!RUN)("[AS-2w] tope de turnos por intervalo (C-AS3)", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let svcA: string; // 45', ilimitado, del consultorio
  let svcB: string; // 30', ilimitado, del consultorio
  let PB: { userId: string; practitionerId: string }; // lote: INHERIT del consultorio (2 cada 15')
  let PC: { userId: string; practitionerId: string }; // concurrencia: propio 1 cada 60'
  let PP: { userId: string; practitionerId: string }; // turnero: propio 1 cada 60'

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    T = await createEphemeralTenant(db);
    // Cupo ilimitado y del consultorio (sin fila PractitionerService = habilitado y PUBLIC para todos): el cupo
    // por servicio no se mete; lo que frena es solo el tope por intervalo.
    svcA = (
      await db.service.create({
        data: { tenantId: T.tenantId, practitionerId: null, name: "Kine", durationMin: 45, priceCents: 0 },
      })
    ).id;
    svcB = (
      await db.service.create({
        data: { tenantId: T.tenantId, practitionerId: null, name: "Evaluación", durationMin: 30, priceCents: 0 },
      })
    ).id;
    PB = await addPractitioner(db, T, "PRACTITIONER");
    PC = await addPractitioner(db, T, "PRACTITIONER");
    PP = await addPractitioner(db, T, "PRACTITIONER");
    // Consultorio: 2 cada 15' (default de INHERIT). El titular: el mismo, pero propio (CUSTOM).
    await db.tenant.update({ where: { id: T.tenantId }, data: { bookingCapCount: 2, bookingCapIntervalMin: 15 } });
    await db.practitioner.update({
      where: { id: T.practitionerId },
      data: { bookingCapMode: "CUSTOM", bookingCapCount: 2, bookingCapIntervalMin: 15 },
    });
    for (const p of [PC, PP]) {
      await db.practitioner.update({
        where: { id: p.practitionerId },
        data: { bookingCapMode: "CUSTOM", bookingCapCount: 1, bookingCapIntervalMin: 60 },
      });
    }
    // Sin franjas: todos con el fallback del consultorio (lun-sáb en su horario).
  });

  beforeEach(() => asUser(T.userId));

  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });

  /** Turno cargado directo (owner). */
  async function mk(o: { prac: string; when: Date; svc?: string; dur?: number }) {
    const patientId = await addPatient(db, T);
    return db.booking.create({
      data: {
        tenantId: T.tenantId,
        practitionerId: o.prac,
        serviceId: o.svc ?? svcA,
        patientId,
        scheduledFor: o.when,
        durationMin: o.dur ?? 45,
        status: "CONFIRMED",
        idempotencyKey: randomUUID(),
      },
    });
  }

  /** Alta por la action real. */
  async function alta(o: { prac: string; when: Date; svc?: string; patientId?: string; key?: string; force?: boolean }) {
    const patientId = o.patientId ?? (await addPatient(db, T));
    const idempotencyKey = o.key ?? randomUUID();
    const svc = o.svc ?? svcA;
    const r = (await createBooking({
      patientId,
      serviceId: svc,
      practitionerId: o.prac,
      scheduledFor: o.when.toISOString(),
      durationMin: svc === svcB ? 30 : 45,
      idempotencyKey,
      ...(o.force ? { allowIntervalCap: true } : {}),
    } as CreateInput)) as CreateResultT3;
    const row = await db.booking.findUnique({ where: { idempotencyKey } });
    return { r, row, patientId, idempotencyKey };
  }

  it("[AS-2w] tope 2 cada 15': el 2.º turno del intervalo entra con aviso informativo (sin confirmar)", async () => {
    await mk({ prac: T.practitionerId, when: ar("2027-11-02T10:00") });
    // Otro servicio, 10:05: mismo intervalo [10:00, 10:15).
    const a = await alta({ prac: T.practitionerId, when: ar("2027-11-02T10:05"), svc: svcB });
    expect(a.r).toMatchObject({ ok: true });
    expect(a.row).toMatchObject({ isOverbooked: false });
    expect(a.r.intervalCapNotice).toEqual({ practitionerName: expect.any(String), used: 1, time: "10:00", to: "10:15", intervalMin: 15 });
    // El intervalo siguiente arranca de cero: sin aviso.
    const b = await alta({ prac: T.practitionerId, when: ar("2027-11-02T10:15") });
    expect(b.r).toMatchObject({ ok: true });
    expect(b.r.intervalCapNotice ?? null).toBeNull();
  });

  it("[AS-2w] tope 2 cada 15': el 3.º pide sobreturno sin escribir; forzado queda isOverbooked", async () => {
    await mk({ prac: T.practitionerId, when: ar("2027-11-03T10:00") });
    await mk({ prac: T.practitionerId, when: ar("2027-11-03T10:10"), svc: svcB, dur: 30 });
    const patientId = await addPatient(db, T);
    const key = randomUUID();
    const a = await alta({ prac: T.practitionerId, when: ar("2027-11-03T10:12"), patientId, key });
    expect(a.r).toMatchObject({ ok: false });
    expect(a.r.intervalCap).toMatchObject({ used: 2, cap: 2, fromTime: "10:00", toTime: "10:15" });
    expect(a.row).toBeNull();

    const forced = await alta({ prac: T.practitionerId, when: ar("2027-11-03T10:12"), patientId, key, force: true });
    expect(forced.r).toMatchObject({ ok: true });
    expect(forced.row).toMatchObject({ isOverbooked: true });
  });

  it("[AS-2w] concurrencia con tope 1 cada 60': dos altas de servicios distintos en la misma hora → entra una", async () => {
    const day = "2027-11-04";
    const hk = hourLockKey(hourKeyForStart({ tenantId: T.tenantId, practitionerId: PC.practitionerId, start: ar(`${day}T11:00`) }));
    const holder = ownerClient();
    const probe = ownerClient();
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let acquired!: () => void;
    const got = new Promise<void>((r) => (acquired = r));
    const held = holder.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${hk}, 0))`;
        acquired();
        await released;
      },
      { timeout: 20_000 }
    );
    await got;
    // Servicios distintos = claves de cupo distintas: solo la clave de HORA las serializa.
    const pa = alta({ prac: PC.practitionerId, when: ar(`${day}T11:00`), svc: svcA });
    const pb = alta({ prac: PC.practitionerId, when: ar(`${day}T11:20`), svc: svcB });
    try {
      await waitForAdvisoryWaiter(probe, hk, { minWaiters: 2, timeoutMs: 5_000 });
      release();
      await held;
      const outs = await Promise.all([pa, pb]);
      expect(outs.filter((o) => o.r.ok)).toHaveLength(1);
      const capped = outs.filter((o) => !o.r.ok);
      expect(capped).toHaveLength(1);
      expect(capped[0].r.intervalCap).toMatchObject({ used: 1, cap: 1, fromTime: "11:00", toTime: "12:00" });
      expect(capped[0].row).toBeNull();
      expect(
        await db.booking.count({
          where: { tenantId: T.tenantId, practitionerId: PC.practitionerId, scheduledFor: { gte: ar(`${day}T11:00`), lt: ar(`${day}T12:00`) } },
        })
      ).toBe(1);
    } finally {
      release();
      await held.catch(() => {});
      await Promise.allSettled([pa, pb]);
      await Promise.all([holder.$disconnect(), probe.$disconnect()]);
    }
  });

  it("[AS-2l] turnero: el intervalo con el tope lleno no se ofrece (duro)", async () => {
    const day = futureDow(2); // martes
    await mk({ prac: PP.practitionerId, when: new Date(localToARIso(`${day}T10:00:00`)) });
    const slots = await listPublicSlots({ tenantSlug: T.slug, practitionerId: PP.practitionerId, serviceId: svcA, date: day });
    const hourOf = (iso: string) => Math.floor(toARMinutes(new Date(iso)) / 60);
    // No vacuo: el día ofrece horarios fuera de esa hora.
    expect(slots.some((s) => s.available && hourOf(s.iso) >= 12)).toBe(true);
    // Ningún horario libre que EMPIECE en [10:00, 11:00): el tope (1 cada 60') ya está lleno.
    expect(slots.filter((s) => s.available && hourOf(s.iso) === 10)).toEqual([]);
  });

  it("[AS-2w] lote: la fecha que pasa el tope sale marcada y se omite; con allowIntervalCap entra como sobreturno", async () => {
    // PB hereda del consultorio: 2 cada 15'. El lun 08/11 a las 10 ya tiene 2; el 15/11 está libre.
    await mk({ prac: PB.practitionerId, when: ar("2027-11-08T10:00") });
    await mk({ prac: PB.practitionerId, when: ar("2027-11-08T10:05"), svc: svcB, dur: 30 });
    const patientId = await addPatient(db, T);
    const base = {
      patientId,
      serviceId: svcA,
      practitionerId: PB.practitionerId,
      scheduledFor: ar("2027-11-08T10:00").toISOString(),
      durationMin: 45,
      count: 2,
    };
    const dry = await createBookingsBatch({ ...base, dryRun: true });
    if (!dry.ok) throw new Error(dry.error);
    expect(dry.data.dates.map((d) => [d.iso, d.intervalCapped ?? false])).toEqual([
      [ar("2027-11-08T10:00").toISOString(), true],
      [ar("2027-11-15T10:00").toISOString(), false],
    ]);

    const run = await createBookingsBatch({ ...base, idempotencyKey: randomUUID() });
    if (!run.ok) throw new Error(run.error);
    expect(run.data).toMatchObject({ created: 1, omitted: 1 });
    const rows = await db.booking.findMany({ where: { tenantId: T.tenantId, patientId }, orderBy: { scheduledFor: "asc" } });
    expect(rows.map((r) => [r.scheduledFor.toISOString(), r.isOverbooked])).toEqual([
      [ar("2027-11-15T10:00").toISOString(), false],
    ]);

    const forced = await createBookingsBatch({
      ...base,
      idempotencyKey: randomUUID(),
      allowIntervalCap: true,
    } as Parameters<typeof createBookingsBatch>[0]);
    if (!forced.ok) throw new Error(forced.error);
    const after = await db.booking.findMany({ where: { tenantId: T.tenantId, patientId }, orderBy: { scheduledFor: "asc" } });
    expect(after.map((r) => [r.scheduledFor.toISOString(), r.isOverbooked])).toEqual([
      [ar("2027-11-08T10:00").toISOString(), true],
      [ar("2027-11-15T10:00").toISOString(), false],
    ]);
  });
  // ── Edición (T3d-2w) ───────────────────────────────────────────────────────

  it("[AS-2w] edición: mover a otro intervalo lleno pide sobreturno; forzado queda isOverbooked", async () => {
    await mk({ prac: T.practitionerId, when: ar("2027-11-05T10:00") });
    await mk({ prac: T.practitionerId, when: ar("2027-11-05T10:05"), svc: svcB, dur: 30 });
    const x = await mk({ prac: T.practitionerId, when: ar("2027-11-05T11:00") });

    const r = await updateBooking({ id: x.id, scheduledFor: ar("2027-11-05T10:07").toISOString(), expectedUpdatedAt: x.updatedAt.toISOString() });
    expect(r).toMatchObject({ ok: false, intervalCap: { used: 2, cap: 2, fromTime: "10:00", toTime: "10:15" } });
    expect(r.intervalCap?.practitionerName).toEqual(expect.any(String));
    // Sin escribir.
    expect(await db.booking.findUniqueOrThrow({ where: { id: x.id } })).toMatchObject({ scheduledFor: ar("2027-11-05T11:00"), isOverbooked: false });

    const forced = await updateBooking({
      id: x.id,
      scheduledFor: ar("2027-11-05T10:07").toISOString(),
      expectedUpdatedAt: x.updatedAt.toISOString(),
      allowIntervalCap: true,
    });
    expect(forced).toMatchObject({ ok: true });
    const moved = await db.booking.findUniqueOrThrow({ where: { id: x.id } });
    expect(moved).toMatchObject({ scheduledFor: ar("2027-11-05T10:07"), isOverbooked: true });

    // Cambiar la duración NO pregunta, y el sobreturno por tope no se pierde.
    const dur = await updateBooking({ id: x.id, durationMin: 30, expectedUpdatedAt: moved.updatedAt.toISOString() });
    expect(dur).toMatchObject({ ok: true });
    expect(dur.intervalCap ?? null).toBeNull();
    const after = await db.booking.findUniqueOrThrow({ where: { id: x.id } });
    expect(after).toMatchObject({ durationMin: 30, isOverbooked: true });

    // Moverlo dentro del MISMO intervalo tampoco pregunta (no le suma un inicio a nadie).
    const same = await updateBooking({ id: x.id, scheduledFor: ar("2027-11-05T10:12").toISOString(), expectedUpdatedAt: after.updatedAt.toISOString() });
    expect(same).toMatchObject({ ok: true });
    expect(same.intervalCap ?? null).toBeNull();
  });

  it("[AS-2w] edición: mover al 2.º lugar de un intervalo devuelve el aviso informativo", async () => {
    await mk({ prac: T.practitionerId, when: ar("2027-11-05T15:30") });
    const y = await mk({ prac: T.practitionerId, when: ar("2027-11-05T17:00") });
    const r = await updateBooking({ id: y.id, scheduledFor: ar("2027-11-05T15:35").toISOString(), expectedUpdatedAt: y.updatedAt.toISOString() });
    expect(r).toMatchObject({ ok: true });
    expect(r.intervalCapNotice).toMatchObject({ used: 1, time: "15:30", intervalMin: 15 });
    expect(await db.booking.findUniqueOrThrow({ where: { id: y.id } })).toMatchObject({ isOverbooked: false });
  });

  it("[T3Z-s2] edición: alargar o mover dentro del intervalo un turno normal en un intervalo ya pasado de tope NO lo marca sobreturno", async () => {
    // Tres turnos normales en [10:00, 10:15) con tope 2: pasa si el tope se bajó después (T3e-2c) o si el 3.º se
    // cargó antes del tope. Ninguno es sobreturno; tocarles la duración no los convierte en uno (B2 de T3-Z: antes
    // `intervalFull` sin mover de intervalo marcaba `isOverbooked` a cualquiera).
    await mk({ prac: T.practitionerId, when: ar("2027-11-16T10:00") });
    await mk({ prac: T.practitionerId, when: ar("2027-11-16T10:05"), svc: svcB, dur: 30 });
    const x = await mk({ prac: T.practitionerId, when: ar("2027-11-16T10:10") });

    const dur = await updateBooking({ id: x.id, durationMin: 30, expectedUpdatedAt: x.updatedAt.toISOString() });
    expect(dur).toMatchObject({ ok: true });
    expect(dur.intervalCap ?? null).toBeNull();
    const longer = await db.booking.findUniqueOrThrow({ where: { id: x.id } });
    expect(longer).toMatchObject({ durationMin: 30, isOverbooked: false });

    const same = await updateBooking({ id: x.id, scheduledFor: ar("2027-11-16T10:12").toISOString(), expectedUpdatedAt: longer.updatedAt.toISOString() });
    expect(same).toMatchObject({ ok: true });
    expect(await db.booking.findUniqueOrThrow({ where: { id: x.id } })).toMatchObject({
      scheduledFor: ar("2027-11-16T10:12"),
      isOverbooked: false,
    });

    // Moverlo a OTRO intervalo lleno sí: forzado queda sobreturno.
    await mk({ prac: T.practitionerId, when: ar("2027-11-16T11:00") });
    await mk({ prac: T.practitionerId, when: ar("2027-11-16T11:05"), svc: svcB, dur: 30 });
    const cur = await db.booking.findUniqueOrThrow({ where: { id: x.id } });
    const moved = await updateBooking({
      id: x.id,
      scheduledFor: ar("2027-11-16T11:07").toISOString(),
      expectedUpdatedAt: cur.updatedAt.toISOString(),
      allowIntervalCap: true,
    });
    expect(moved).toMatchObject({ ok: true });
    expect(await db.booking.findUniqueOrThrow({ where: { id: x.id } })).toMatchObject({ isOverbooked: true });
  });

  it("[AS-2w] reactivar un cancelado en un intervalo lleno pide sobreturno (setBookingStatus)", async () => {
    await mk({ prac: T.practitionerId, when: ar("2027-11-09T10:00") });
    await mk({ prac: T.practitionerId, when: ar("2027-11-09T10:05"), svc: svcB, dur: 30 });
    const z = await mk({ prac: T.practitionerId, when: ar("2027-11-09T10:10") });
    const cancelled = await db.booking.update({ where: { id: z.id }, data: { status: "CANCELLED" } });

    const r = await setBookingStatus(z.id, "CONFIRMED", cancelled.updatedAt.toISOString());
    expect(r).toMatchObject({ ok: false, intervalCap: { used: 2, cap: 2, fromTime: "10:00", toTime: "10:15" } });
    expect(await db.booking.findUniqueOrThrow({ where: { id: z.id } })).toMatchObject({ status: "CANCELLED" });

    const forced = await setBookingStatus(z.id, "CONFIRMED", cancelled.updatedAt.toISOString(), { allowIntervalCap: true });
    expect(forced).toMatchObject({ ok: true });
    expect(await db.booking.findUniqueOrThrow({ where: { id: z.id } })).toMatchObject({ status: "CONFIRMED", isOverbooked: true });
  });

  it("[AS-2w] rescheduleSession: mover el turno de la sesión a un intervalo lleno se rechaza; con allowIntervalCap entra como sobreturno", async () => {
    await mk({ prac: T.practitionerId, when: ar("2027-11-10T10:00") });
    await mk({ prac: T.practitionerId, when: ar("2027-11-10T10:05"), svc: svcB, dur: 30 });
    const p = await createPlan(db, T, { sessions: 1, bookings: 1 });
    const [b] = p.bookingIds;
    const at = (await db.booking.findUniqueOrThrow({ where: { id: b } })).scheduledFor;
    await db.session.update({ where: { id: p.sessionIds[0] }, data: { scheduledFor: at } });
    const to = ar("2027-11-10T10:07").toISOString();
    const FORCE = { allowOutOfHours: true, allowBlocked: true, allowPatientOverlap: true };

    const r = await rescheduleSession({ sessionId: p.sessionIds[0], scheduledFor: to, force: FORCE });
    expect(r).toMatchObject({ ok: false, error: "El profesional ya tiene 2 turnos entre las 10:00 y las 10:15 (tope: 2)." });
    expect(+(await db.booking.findUniqueOrThrow({ where: { id: b } })).scheduledFor).toBe(+at);

    const ok = await rescheduleSession({ sessionId: p.sessionIds[0], scheduledFor: to, force: { ...FORCE, allowIntervalCap: true } });
    expect(ok).toMatchObject({ ok: true });
    expect(await db.booking.findUniqueOrThrow({ where: { id: b } })).toMatchObject({ scheduledFor: new Date(to), isOverbooked: true });
  });

  // ── Paridad del conteo plegado (C-AS3: «Test de paridad overlap === countCapacityOverlaps») ─────────────────

  it("[AS-2w] countAgendaOccupancy: overlap === countCapacityOverlaps con y sin tope; intervalStarts = intervalStartsUsed", async () => {
    const PX = await addPractitioner(db, T, "PRACTITIONER");
    const day = "2027-11-11";
    const now = new Date();
    // Cualquier servicio, solapes largos que vienen de antes (≤ 240'), un cancelado, una reserva pública impaga
    // vencida (no retiene cupo) y una que cruza la medianoche AR.
    const fixtures: { when: string; svc: string; dur: number; status?: "CANCELLED" | "PENDING"; pub?: boolean }[] = [
      { when: `${day}T07:30`, svc: svcA, dur: 180 },
      { when: `${day}T10:00`, svc: svcA, dur: 45 },
      { when: `${day}T10:05`, svc: svcB, dur: 30 },
      { when: `${day}T10:20`, svc: svcA, dur: 45, status: "CANCELLED" },
      { when: `${day}T10:25`, svc: svcB, dur: 30, status: "PENDING", pub: true },
      { when: `${day}T10:40`, svc: svcA, dur: 45 },
      { when: `${day}T10:59`, svc: svcB, dur: 30 },
      { when: `${day}T23:30`, svc: svcA, dur: 60 },
    ];
    const ids: string[] = [];
    for (const f of fixtures) {
      const patientId = await addPatient(db, T);
      const row = await db.booking.create({
        data: {
          tenantId: T.tenantId,
          practitionerId: PX.practitionerId,
          serviceId: f.svc,
          patientId,
          scheduledFor: ar(f.when),
          durationMin: f.dur,
          status: f.status ?? "CONFIRMED",
          paymentStatus: "UNPAID",
          idempotencyKey: f.pub ? `pub:${randomUUID()}:x` : randomUUID(),
          ...(f.pub ? { createdAt: new Date(now.getTime() - 3 * 60 * 60_000) } : {}),
        },
      });
      ids.push(row.id);
    }
    const all = await db.booking.findMany({
      where: { tenantId: T.tenantId, practitionerId: PX.practitionerId, status: { not: "CANCELLED" } },
    });
    const caps: (IntervalCap | null)[] = [null, { count: 2, intervalMin: 15 }, { count: 1, intervalMin: 30 }, { count: 3, intervalMin: 60 }];
    const probes = [`${day}T10:00`, `${day}T10:10`, `${day}T10:30`, `${day}T10:45`, `${day}T09:00`, `${day}T23:45`];
    const durs = [5, 45, 120];
    let checked = 0;
    for (const cap of caps)
      for (const at of probes)
        for (const dur of durs)
          for (const svc of [svcA, svcB])
            for (const excludeId of [undefined, ids[1]]) {
              const start = ar(at);
              const o = {
                tenantId: T.tenantId,
                practitionerId: PX.practitionerId,
                serviceId: svc,
                start,
                end: new Date(start.getTime() + dur * 60_000),
                now,
                excludeId,
              };
              const [legacy, occ] = await runWithRls(T.tenantId, async (tx) => [
                await countCapacityOverlaps(tx, o),
                await countAgendaOccupancy(tx, { ...o, cap }),
              ] as const);
              expect(occ.overlap).toBe(legacy);
              const expected = cap
                ? intervalStartsUsed(all, { practitionerId: PX.practitionerId, when: start, intervalMin: cap.intervalMin, now, excludeId })
                : 0;
              expect(occ.intervalStarts).toBe(expected);
              checked++;
            }
    expect(checked).toBe(caps.length * probes.length * durs.length * 2 * 2);
    // No vacuo: hay sondas con solapes y con inicios en el intervalo.
    const [busy] = await runWithRls(T.tenantId, async (tx) => [
      await countAgendaOccupancy(tx, {
        tenantId: T.tenantId,
        practitionerId: PX.practitionerId,
        serviceId: svcA,
        start: ar(`${day}T10:00`),
        end: ar(`${day}T10:45`),
        now,
        cap: { count: 3, intervalMin: 60 },
      }),
    ]);
    // De A solapan [10:00, 10:45): 07:30 (180'), 10:00 y 10:40 (el cancelado de 10:20 no). Inicios en [10:00, 11:00)
    // de cualquier servicio: 10:00, 10:05, 10:40, 10:59 (no el cancelado ni el público vencido).
    expect(busy).toEqual({ overlap: 3, intervalStarts: 4 });
  });
});
