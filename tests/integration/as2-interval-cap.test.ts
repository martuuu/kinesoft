/**
 * [AS-2w] / [AS-2l] T3 (C-AS3, decisión 6 del 19-oct) — tope «N turnos cada X min» en los write-paths y el turnero,
 * contra Postgres real en los dos roles. Arranca en `it.fails` (T3b-2k publica los contratos; la implementación es de
 * T3d-2w en `lib/bookings.ts` / `lib/bookings-core.ts` y de T3c-2l en el turnero): cada sesión da vuelta los suyos.
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
import { createBooking, createBookingsBatch } from "@/lib/bookings";
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

  it.fails("[AS-2w] tope 2 cada 15': el 2.º turno del intervalo entra con aviso informativo (sin confirmar)", async () => {
    await mk({ prac: T.practitionerId, when: ar("2027-11-02T10:00") });
    // Otro servicio, 10:05: mismo intervalo [10:00, 10:15).
    const a = await alta({ prac: T.practitionerId, when: ar("2027-11-02T10:05"), svc: svcB });
    expect(a.r).toMatchObject({ ok: true });
    expect(a.row).toMatchObject({ isOverbooked: false });
    expect(a.r.intervalCapNotice).toEqual({ practitionerName: expect.any(String), used: 1, time: "10:00" });
    // El intervalo siguiente arranca de cero: sin aviso.
    const b = await alta({ prac: T.practitionerId, when: ar("2027-11-02T10:15") });
    expect(b.r).toMatchObject({ ok: true });
    expect(b.r.intervalCapNotice ?? null).toBeNull();
  });

  it.fails("[AS-2w] tope 2 cada 15': el 3.º pide sobreturno sin escribir; forzado queda isOverbooked", async () => {
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

  it.fails("[AS-2w] concurrencia con tope 1 cada 60': dos altas de servicios distintos en la misma hora → entra una", async () => {
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

  it.fails("[AS-2l] turnero: el intervalo con el tope lleno no se ofrece (duro)", async () => {
    const day = futureDow(2); // martes
    await mk({ prac: PP.practitionerId, when: new Date(localToARIso(`${day}T10:00:00`)) });
    const slots = await listPublicSlots({ tenantSlug: T.slug, practitionerId: PP.practitionerId, serviceId: svcA, date: day });
    const hourOf = (iso: string) => Math.floor(toARMinutes(new Date(iso)) / 60);
    // No vacuo: el día ofrece horarios fuera de esa hora.
    expect(slots.some((s) => s.available && hourOf(s.iso) >= 12)).toBe(true);
    // Ningún horario libre que EMPIECE en [10:00, 11:00): el tope (1 cada 60') ya está lleno.
    expect(slots.filter((s) => s.available && hourOf(s.iso) === 10)).toEqual([]);
  });

  it.fails("[AS-2w] lote: la fecha que pasa el tope sale marcada y se omite; con allowIntervalCap entra como sobreturno", async () => {
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
});
