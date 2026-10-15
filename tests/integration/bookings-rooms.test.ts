/**
 * SR3a — los write-paths de `lib/bookings.ts` con SALA (alta suelta, batch,
 * lectura de la agenda), contra Postgres real en los dos roles
 * (`test:integration` = kinesoft_app con RLS; `:owner` = BYPASSRLS como prod).
 *
 * Qué se fija (contratos literales de SR-C, plan §17 / §17.5):
 *   - `createBooking` estampa la sala POR DEFECTO de la franja con la sede
 *     EXPLÍCITA (SR-D6), o la elegida; "Sin sala" (null) no estampa;
 *   - sala elegida de otra sede, de otro consultorio o archivada →
 *     BAD_ROOM_ERROR sin escribir;
 *   - sala llena por OTRO profesional (capacity = profesionales a la vez,
 *     SR-D1) o bloqueada (§17.5) → `roomBusy` sin escribir; forzar con
 *     `allowRoomConflict` escribe SIN `isOverbooked` ni "[SOBRETURNO]" (SR-D2);
 *     el mismo profesional nunca choca consigo mismo;
 *   - batch (SR-D7): flag `roomBusy` por fecha en el preflight; sin forzar la
 *     fecha se omite, forzando se escribe;
 *   - `listAgendaBookings` trae `roomId` y filtra por sala / "none";
 *   - concurrencia: dos altas de profesionales distintos en una sala de
 *     capacidad 1 → exactamente una pasa sin aviso (clave de sala, C2 (1b));
 *   - gate de SR-B: bloqueo de sala contra un alta con esa sala (serializados
 *     por la clave de sala): o el alta entra antes o ve el bloqueo;
 *   - perf: sin sala, `createBooking` / `updateBooking` dan EXACTAMENTE los
 *     statements de HEAD (techo estricto de tests/perf/compare.ts).
 *
 * Símbolos reales; se mockean la sesión, `next/cache` y la instrumentación de
 * `@/lib/db` (un listener de `query`, no reemplaza nada). Fixtures por owner.
 * Fechas en nov/dic 2027 (lun = 2027-11-01), un día por caso.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { installQueryCounter } = await import("@/tests/helpers/query-counter");
  return { ...actual, ...installQueryCounter() };
});

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { createBooking, createBookingsBatch, listAgendaBookings, updateBooking } from "@/lib/bookings";
import { createTimeBlock } from "@/lib/time-blocks";
import { roomLockKey } from "@/lib/booking-cap-lock";
import { BAD_ROOM_ERROR, ROOM_BLOCKED_ERROR, ROOM_BUSY_ERROR } from "@/lib/bookings-constants";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  addRoom,
  sweepOrphanTestTenants,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { measure } from "@/tests/helpers/query-counter";
import { countAdvisoryWaiters, waitForAdvisoryWaiter } from "@/tests/helpers/advisory-wait";

const RUN = process.env.INTEGRATION === "1";

/** Pared AR → instante. */
const ar = (local: string) => new Date(`${local}:00-03:00`);

/**
 * Statements medidos con `lib/bookings.ts` ANTES de SR3a (HEAD `ad50059` + el
 * handoff de SR2a, que no toca el alta) en los MISMOS escenarios de abajo, el
 * 08-oct: alta 34 statements / 5 tx (= `f.createBooking` de agenda-multi.json),
 * edición (mover) 30 / 1. El techo estricto de `createBooking` /
 * `updateBooking` (tests/perf/compare.ts) exige que sin sala no se muevan.
 * PF-0b (15-oct): membresías en una sentencia, 34→31 / 30→27.
 * PL-A (15-oct): el alta y la edición ya no auditan (`booking.create` / `booking.update` eran un INSERT aparte por
 * el canal service), 31→30 / 27→26. El techo baja; no vuelve a subir.
 */
const HEAD_CREATE_STATEMENTS = 30;
const HEAD_UPDATE_STATEMENTS = 26;

describe.skipIf(!RUN)("write-paths de turnos con sala (SR3a)", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let U: EphemeralTenant;
  let svc: string;
  let L1: string;
  let L2: string;
  let R1: string;
  let R2: string;
  let R3: string;
  let RArch: string;
  let RForeign: string;
  let B: { userId: string; practitionerId: string };
  let C: { userId: string; practitionerId: string };

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    // PL-2f (C-PL1): salas y Sala de Espera son de Clínica / Libre; sin el plan, el motor ignora las salas.
    T = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    U = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    // Cupo ilimitado: el cupo del servicio no se mete en los casos de sala.
    svc = (
      await db.service.create({
        data: { tenantId: T.tenantId, practitionerId: null, name: "Kine", durationMin: 45, priceCents: 0 },
      })
    ).id;
    L1 = (await db.location.create({ data: { tenantId: T.tenantId, name: "Centro", isPrimary: true } })).id;
    L2 = (await db.location.create({ data: { tenantId: T.tenantId, name: "Norte" } })).id;
    R1 = (await addRoom(db, T, { locationId: L1, name: "Consultorio 1", capacity: 1 })).roomId;
    R2 = (await addRoom(db, T, { locationId: L1, name: "Consultorio 2", capacity: 1 })).roomId;
    R3 = (await addRoom(db, T, { locationId: L2, name: "Box Norte", capacity: 1 })).roomId;
    RArch = (await addRoom(db, T, { locationId: L1, name: "Viejo", active: false })).roomId;
    RForeign = (await addRoom(db, U, { name: "Ajeno" })).roomId;
    B = await addPractitioner(db, T, "PRACTITIONER");
    C = await addPractitioner(db, T, "PRACTITIONER");
    const week = [1, 2, 3, 4, 5];
    await db.practitionerSchedule.createMany({
      data: [
        // A (el OWNER): 9-11 Consultorio 1, 11-13 Consultorio 2 (Centro), 14-18 Box Norte (Norte).
        ...week.map((dow) => ({ tenantId: T.tenantId, practitionerId: T.practitionerId, locationId: L1, roomId: R1, dow, startMin: 540, endMin: 660 })),
        ...week.map((dow) => ({ tenantId: T.tenantId, practitionerId: T.practitionerId, locationId: L1, roomId: R2, dow, startMin: 660, endMin: 780 })),
        ...week.map((dow) => ({ tenantId: T.tenantId, practitionerId: T.practitionerId, locationId: L2, roomId: R3, dow, startMin: 840, endMin: 1080 })),
        // B: 9-13 Consultorio 1 (Configuración lo frenaría contra A; acá se carga
        // directo para forzar el choque en la agenda).
        ...week.map((dow) => ({ tenantId: T.tenantId, practitionerId: B.practitionerId, locationId: L1, roomId: R1, dow, startMin: 540, endMin: 780 })),
        // C: 9-18 en el Centro, SIN sala (el consultorio de hoy).
        ...week.map((dow) => ({ tenantId: T.tenantId, practitionerId: C.practitionerId, locationId: L1, dow, startMin: 540, endMin: 1080 })),
      ],
    });
  });

  beforeEach(() => asUser(T.userId));

  afterAll(async () => {
    await T?.cleanup();
    await U?.cleanup();
    await db?.$disconnect();
  });

  /** Turno cargado directo (owner): con sala, la sede explícita. */
  async function mk(o: { prac?: string; when: Date; dur?: number; loc?: string | null; room?: string | null }) {
    const patientId = await addPatient(db, T);
    return db.booking.create({
      data: {
        tenantId: T.tenantId,
        practitionerId: o.prac ?? T.practitionerId,
        serviceId: svc,
        patientId,
        scheduledFor: o.when,
        durationMin: o.dur ?? 45,
        status: "CONFIRMED",
        locationId: o.loc === undefined ? L1 : o.loc,
        roomId: o.room ?? null,
        idempotencyKey: randomUUID(),
      },
    });
  }

  /** Alta por la action real, con paciente nuevo y key propia. */
  async function alta(o: {
    prac?: string;
    when: Date;
    roomId?: string | null;
    locationId?: string;
    allowRoomConflict?: boolean;
    allowOutOfHours?: boolean;
  }) {
    const patientId = await addPatient(db, T);
    const idempotencyKey = randomUUID();
    const r = await createBooking({
      patientId,
      serviceId: svc,
      practitionerId: o.prac ?? T.practitionerId,
      scheduledFor: o.when.toISOString(),
      durationMin: 45,
      idempotencyKey,
      ...(o.roomId !== undefined ? { roomId: o.roomId } : {}),
      ...(o.locationId ? { locationId: o.locationId } : {}),
      ...(o.allowRoomConflict ? { allowRoomConflict: true } : {}),
      ...(o.allowOutOfHours ? { allowOutOfHours: true } : {}),
    });
    const row = await db.booking.findUnique({ where: { idempotencyKey } });
    return { r, row, patientId, idempotencyKey };
  }

  // ── Alta: sala por defecto / elegida / "Sin sala" ─────────────────────────
  describe("createBooking: qué sala estampa", () => {
    it("sala por defecto de la franja con la sede explícita (Centro 10:00 → Consultorio 1; Norte 15:00 → Box Norte)", async () => {
      const a = await alta({ when: ar("2027-11-01T10:00") });
      expect(a.r).toMatchObject({ ok: true });
      expect(a.row).toMatchObject({ roomId: R1, locationId: L1, isOverbooked: false });
      const b = await alta({ when: ar("2027-11-01T15:00") });
      expect(b.r).toMatchObject({ ok: true });
      expect(b.row).toMatchObject({ roomId: R3, locationId: L2 });
    });

    it("sala elegida (con su sede) se estampa aunque la franja no tenga sala", async () => {
      const a = await alta({ prac: C.practitionerId, when: ar("2027-11-01T16:00"), roomId: R2, locationId: L1 });
      expect(a.r).toMatchObject({ ok: true });
      expect(a.row).toMatchObject({ roomId: R2, locationId: L1 });
    });

    it("sala elegida SIN sede → la sede por defecto de la franja queda explícita (SR-D6)", async () => {
      const a = await alta({ prac: C.practitionerId, when: ar("2027-11-01T17:00"), roomId: R1 });
      expect(a.r).toMatchObject({ ok: true });
      expect(a.row).toMatchObject({ roomId: R1, locationId: L1 });
    });

    it("'Sin sala' explícito (null) no estampa, aunque la franja tenga sala y esté ocupada", async () => {
      await mk({ prac: B.practitionerId, when: ar("2027-11-02T10:00"), room: R1 });
      const a = await alta({ when: ar("2027-11-02T10:00"), roomId: null });
      expect(a.r).toMatchObject({ ok: true });
      expect(a.row).toMatchObject({ roomId: null, locationId: L1, isOverbooked: false });
    });

    it("franja sin sala → sin sala (el consultorio de hoy)", async () => {
      const a = await alta({ prac: C.practitionerId, when: ar("2027-11-02T12:00") });
      expect(a.r).toMatchObject({ ok: true });
      expect(a.row).toMatchObject({ roomId: null, locationId: L1 });
    });

    it("sala por defecto archivada → el turno queda sin sala (no es error)", async () => {
      const { roomId: tmp } = await addRoom(db, T, { locationId: L1, name: `Temporal ${randomUUID().slice(0, 6)}` });
      const D = await addPractitioner(db, T, "PRACTITIONER");
      await db.practitionerSchedule.create({
        data: { tenantId: T.tenantId, practitionerId: D.practitionerId, locationId: L1, roomId: tmp, dow: 2, startMin: 540, endMin: 780 },
      });
      await db.room.update({ where: { id: tmp }, data: { active: false } });
      const a = await alta({ prac: D.practitionerId, when: ar("2027-11-02T10:00") });
      expect(a.r).toMatchObject({ ok: true });
      expect(a.row).toMatchObject({ roomId: null, locationId: L1 });
    });
  });

  describe("createBooking: sala elegida inválida → BAD_ROOM_ERROR sin escribir", () => {
    it.each([
      ["de otra sede", () => R3],
      ["de otro consultorio", () => RForeign],
      ["archivada", () => RArch],
    ])("%s", async (_label, room) => {
      const a = await alta({ when: ar("2027-11-03T10:00"), roomId: room() });
      expect(a.r).toEqual({ ok: false, error: BAD_ROOM_ERROR });
      expect(a.row).toBeNull();
    });
  });

  // ── Ocupación ─────────────────────────────────────────────────────────────
  describe("createBooking: sala ocupada (capacidad 1 = un profesional a la vez)", () => {
    it("otro profesional en la sala → roomBusy sin escribir; forzando escribe sin sobreturno (SR-D2)", async () => {
      await mk({ prac: B.practitionerId, when: ar("2027-11-04T10:00"), room: R1 });
      const a = await alta({ when: ar("2027-11-04T10:15") });
      expect(a.r).toEqual({
        ok: false,
        error: ROOM_BUSY_ERROR("Consultorio 1"),
        roomBusy: { roomName: "Consultorio 1", nextFreeISO: null, blocked: null },
      });
      expect(a.row).toBeNull();

      const f = await alta({ when: ar("2027-11-04T10:15"), allowRoomConflict: true });
      expect(f.r).toMatchObject({ ok: true });
      expect(f.row).toMatchObject({ roomId: R1, locationId: L1, isOverbooked: false });
      expect(f.row?.notes ?? "").not.toContain("[SOBRETURNO]");
    });

    it("sala elegida ocupada → roomBusy; elegir otra sala libre pasa", async () => {
      await mk({ prac: B.practitionerId, when: ar("2027-11-05T09:00"), room: R1 });
      const busy = await alta({ prac: C.practitionerId, when: ar("2027-11-05T09:00"), roomId: R1, locationId: L1 });
      expect(busy.r).toMatchObject({ ok: false, roomBusy: { roomName: "Consultorio 1" } });
      expect(busy.row).toBeNull();
      const ok = await alta({ prac: C.practitionerId, when: ar("2027-11-05T09:00"), roomId: R2, locationId: L1 });
      expect(ok.row).toMatchObject({ roomId: R2 });
    });

    it("el mismo profesional, dos turnos en su sala → no choca", async () => {
      await mk({ when: ar("2027-11-08T10:00"), room: R1 });
      const a = await alta({ when: ar("2027-11-08T10:00") });
      expect(a.r).toMatchObject({ ok: true });
      expect(a.row).toMatchObject({ roomId: R1, isOverbooked: false });
    });

    it("tocarse en el borde no choca (10:00-10:45 y 10:45)", async () => {
      await mk({ prac: B.practitionerId, when: ar("2027-11-09T10:00"), room: R1 });
      const a = await alta({ when: ar("2027-11-09T10:45") });
      expect(a.r).toMatchObject({ ok: true });
      expect(a.row?.roomId).toBe(R1);
    });

    it("bloqueo de sala (§17.5) → roomBusy con el motivo; forzable sin sobreturno", async () => {
      await db.timeBlock.create({
        data: {
          tenantId: T.tenantId,
          locationId: L1,
          roomId: R2,
          practitionerId: null,
          startsAt: ar("2027-11-10T11:00"),
          endsAt: ar("2027-11-10T13:00"),
          reason: "Mantenimiento",
          createdById: T.userId,
        },
      });
      const a = await alta({ when: ar("2027-11-10T11:30") });
      // Ni `blocked` de profesional (el bloqueo de sala no bloquea gente) ni conflicto: sala llena.
      expect(a.r).toEqual({
        ok: false,
        error: ROOM_BLOCKED_ERROR("Consultorio 2", "Mantenimiento"),
        roomBusy: { roomName: "Consultorio 2", nextFreeISO: null, blocked: { reason: "Mantenimiento" } },
      });
      expect(a.row).toBeNull();
      const f = await alta({ when: ar("2027-11-10T11:30"), allowRoomConflict: true });
      expect(f.row).toMatchObject({ roomId: R2, isOverbooked: false });
    });
  });

  // ── Batch (SR-D7) ─────────────────────────────────────────────────────────
  describe("createBookingsBatch: sala por fecha", () => {
    it("preflight marca roomBusy por fecha; sin forzar la omite; forzando la escribe sin sobreturno", async () => {
      // B ocupa el Consultorio 1 el 15/11 a las 10; el 22/11 está libre.
      await mk({ prac: B.practitionerId, when: ar("2027-11-15T10:00"), room: R1 });
      const patientId = await addPatient(db, T);
      const base = {
        patientId,
        serviceId: svc,
        practitionerId: T.practitionerId,
        scheduledFor: ar("2027-11-15T10:00").toISOString(),
        durationMin: 45,
        count: 2,
      };
      const dry = await createBookingsBatch({ ...base, dryRun: true });
      if (!dry.ok) throw new Error(dry.error);
      expect(dry.data.dates.map((d) => [d.iso, d.status, d.roomBusy ?? false])).toEqual([
        [ar("2027-11-15T10:00").toISOString(), "libre", true],
        [ar("2027-11-22T10:00").toISOString(), "libre", false],
      ]);
      expect(dry.data.created).toBe(0);

      const run = await createBookingsBatch({ ...base, idempotencyKey: randomUUID() });
      if (!run.ok) throw new Error(run.error);
      expect(run.data).toMatchObject({ created: 1, omitted: 1, sobreturnos: 0 });
      const rows = await db.booking.findMany({ where: { tenantId: T.tenantId, patientId }, orderBy: { scheduledFor: "asc" } });
      expect(rows.map((r) => [r.scheduledFor.toISOString(), r.roomId, r.locationId, r.isOverbooked])).toEqual([
        [ar("2027-11-22T10:00").toISOString(), R1, L1, false],
      ]);

      const forced = await createBookingsBatch({ ...base, idempotencyKey: randomUUID(), allowRoomConflict: true });
      if (!forced.ok) throw new Error(forced.error);
      // El 22/11 ya es del paciente (duplicado); el 15/11 entra forzado.
      expect(forced.data).toMatchObject({ created: 1, omitted: 0, sobreturnos: 0 });
      const after = await db.booking.findMany({ where: { tenantId: T.tenantId, patientId }, orderBy: { scheduledFor: "asc" } });
      expect(after.map((r) => [r.scheduledFor.toISOString(), r.roomId, r.isOverbooked, (r.notes ?? "").includes("[SOBRETURNO]")])).toEqual([
        [ar("2027-11-15T10:00").toISOString(), R1, false, false],
        [ar("2027-11-22T10:00").toISOString(), R1, false, false],
      ]);
    });

    it("sala por defecto POR FECHA (lun 10:00 Consultorio 1, mié 12:00 → Consultorio 2) y 'Sin sala' explícito", async () => {
      const patientId = await addPatient(db, T);
      const r = await createBookingsBatch({
        patientId,
        serviceId: svc,
        practitionerId: T.practitionerId,
        scheduledFor: ar("2027-11-29T10:00").toISOString(),
        durationMin: 45,
        count: 1,
        idempotencyKey: randomUUID(),
      });
      if (!r.ok) throw new Error(r.error);
      const r2 = await createBookingsBatch({
        patientId,
        serviceId: svc,
        practitionerId: T.practitionerId,
        scheduledFor: ar("2027-12-01T12:00").toISOString(),
        durationMin: 45,
        count: 1,
        idempotencyKey: randomUUID(),
      });
      if (!r2.ok) throw new Error(r2.error);
      const none = await createBookingsBatch({
        patientId,
        serviceId: svc,
        practitionerId: T.practitionerId,
        scheduledFor: ar("2027-12-02T09:00").toISOString(),
        durationMin: 45,
        count: 1,
        roomId: null,
        idempotencyKey: randomUUID(),
      });
      if (!none.ok) throw new Error(none.error);
      const rows = await db.booking.findMany({ where: { tenantId: T.tenantId, patientId }, orderBy: { scheduledFor: "asc" } });
      expect(rows.map((x) => [x.roomId, x.locationId])).toEqual([
        [R1, L1],
        [R2, L1],
        [null, L1],
      ]);
    });

    it("sala elegida inválida → BAD_ROOM_ERROR sin escribir (también en el preflight)", async () => {
      const patientId = await addPatient(db, T);
      for (const roomId of [RForeign, RArch, R3]) {
        const r = await createBookingsBatch({
          patientId,
          serviceId: svc,
          practitionerId: T.practitionerId,
          scheduledFor: ar("2027-12-06T10:00").toISOString(),
          durationMin: 45,
          count: 2,
          roomId,
          idempotencyKey: randomUUID(),
        });
        expect(r).toEqual({ ok: false, error: BAD_ROOM_ERROR });
      }
      expect(await db.booking.count({ where: { tenantId: T.tenantId, patientId } })).toBe(0);
    });
  });

  // ── Lectura de la agenda ──────────────────────────────────────────────────
  describe("listAgendaBookings: roomId y filtro por sala", () => {
    it("trae roomId (requerido) y filtra por sala, por 'none' y sin filtro", async () => {
      const day = "2027-12-07";
      const a = await mk({ when: ar(`${day}T09:00`), room: R1 });
      const b = await mk({ prac: B.practitionerId, when: ar(`${day}T11:00`), room: R2 });
      const c = await mk({ prac: C.practitionerId, when: ar(`${day}T12:00`) });
      const q = { from: ar(`${day}T00:00`), to: ar(`${day}T23:59`) };
      const all = await listAgendaBookings(q);
      expect(all.map((r) => [r.id, r.roomId])).toEqual([
        [a.id, R1],
        [b.id, R2],
        [c.id, null],
      ]);
      // Requerido: la clave viaja aunque sea null.
      expect(Object.prototype.hasOwnProperty.call(all[2], "roomId")).toBe(true);
      expect((await listAgendaBookings({ ...q, roomId: R1 })).map((r) => r.id)).toEqual([a.id]);
      expect((await listAgendaBookings({ ...q, roomId: "none" })).map((r) => r.id)).toEqual([c.id]);
      expect((await listAgendaBookings({ ...q, roomId: null })).map((r) => r.id)).toEqual([a.id, b.id, c.id]);
      // Una sala de otro consultorio no filtra nada del propio (where tenantId a mano).
      expect(await listAgendaBookings({ ...q, roomId: RForeign })).toEqual([]);
    });

    it("sin queries nuevas: con y sin filtro de sala, mismos statements", async () => {
      const day = "2027-12-08";
      await mk({ when: ar(`${day}T09:00`), room: R1 });
      const q = { from: ar(`${day}T00:00`), to: ar(`${day}T23:59`) };
      const plain = await measure(() => listAgendaBookings(q));
      const byRoom = await measure(() => listAgendaBookings({ ...q, roomId: R1 }));
      const none = await measure(() => listAgendaBookings({ ...q, roomId: "none" }));
      expect(byRoom.m.statements).toBe(plain.m.statements);
      expect(none.m.statements).toBeLessThanOrEqual(plain.m.statements);
    });
  });

  // ── Concurrencia ──────────────────────────────────────────────────────────
  describe("concurrencia: dos altas de profesionales distintos, sala de capacidad 1", () => {
    it("exactamente una pasa sin aviso; la otra recibe roomBusy y no escribe", async () => {
      const day = "2027-12-09";
      const k = roomLockKey({ tenantId: T.tenantId, roomId: R1, dayKey: day });
      const holder = ownerClient();
      const probe = ownerClient();
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      let acquired!: () => void;
      const got = new Promise<void>((r) => (acquired = r));
      const held = holder.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${k}, 0))`;
          acquired();
          await released;
        },
        { timeout: 20_000 }
      );
      await got;
      try {
        // A (9-11) y B (9-13) tienen el Consultorio 1 por defecto a las 10.
        const pa = alta({ when: ar(`${day}T10:00`) });
        const pb = alta({ prac: B.practitionerId, when: ar(`${day}T10:00`) });
        // Cada una tiene su cupo (claves distintas) y espera la MISMA clave de sala.
        await waitForAdvisoryWaiter(probe, k, { minWaiters: 2, timeoutMs: 10_000 });
        expect(await countAdvisoryWaiters(probe, k)).toBe(2);
        release();
        await held;
        const outs = await Promise.all([pa, pb]);
        const oks = outs.filter((o) => o.r.ok);
        const busy = outs.filter((o) => !o.r.ok);
        expect(oks).toHaveLength(1);
        expect(busy).toHaveLength(1);
        expect(busy[0].r).toMatchObject({ roomBusy: { roomName: "Consultorio 1" } });
        expect(busy[0].row).toBeNull();
        expect(
          await db.booking.count({ where: { tenantId: T.tenantId, roomId: R1, scheduledFor: ar(`${day}T10:00`) } })
        ).toBe(1);
      } finally {
        release();
        await held.catch(() => {});
        await Promise.all([holder.$disconnect(), probe.$disconnect()]);
      }
    });
  });

  // Gate de SR-B (quedó documentado en day-lock.test.ts, "E2E (gate SRZ, cuando
  // SR3a implemente el alta con sala)"): el bloqueo de sala y el alta con esa
  // sala toman la MISMA clave de sala, así que se serializan: o el alta entra
  // antes (y el bloqueo se crea igual: no cancela turnos), o ve el bloqueo.
  describe("gate SR-B: bloqueo de sala contra alta con esa sala", () => {
    it("serializados por la clave de sala: nunca un alta sin aviso DESPUÉS del bloqueo", async () => {
      const day = "2027-12-10";
      const k = roomLockKey({ tenantId: T.tenantId, roomId: R2, dayKey: day });
      const holder = ownerClient();
      const probe = ownerClient();
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      let acquired!: () => void;
      const got = new Promise<void>((r) => (acquired = r));
      const held = holder.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${k}, 0))`;
          acquired();
          await released;
        },
        { timeout: 20_000 }
      );
      await got;
      try {
        const pBook = alta({ when: ar(`${day}T11:30`) }); // Consultorio 2 por defecto
        const pBlock = createTimeBlock({
          roomId: R2,
          startsAt: ar(`${day}T11:00`).toISOString(),
          endsAt: ar(`${day}T13:00`).toISOString(),
          reason: "Pintura",
        });
        await waitForAdvisoryWaiter(probe, k, { minWaiters: 2, timeoutMs: 10_000 });
        release();
        await held;
        const [book, block] = await Promise.all([pBook, pBlock]);
        expect(block.ok).toBe(true);
        const blockRow = await db.timeBlock.findFirstOrThrow({
          where: { tenantId: T.tenantId, roomId: R2, reason: "Pintura", deletedAt: null },
        });
        if (book.r.ok) {
          // El alta ganó la clave: entró antes que el bloqueo.
          expect(book.row).toMatchObject({ roomId: R2, isOverbooked: false });
          expect(+book.row!.createdAt).toBeLessThanOrEqual(+blockRow.createdAt);
        } else {
          // El bloqueo ganó: el alta lo ve como sala llena, con el motivo, sin escribir.
          expect(book.r).toMatchObject({ roomBusy: { roomName: "Consultorio 2", blocked: { reason: "Pintura" } } });
          expect(book.row).toBeNull();
        }
      } finally {
        release();
        await held.catch(() => {});
        await Promise.all([holder.$disconnect(), probe.$disconnect()]);
      }
    });
  });

  // ── Perf ──────────────────────────────────────────────────────────────────
  describe("statements (techo estricto de createBooking / updateBooking)", () => {
    it("sin sala: igual que HEAD; con sala: +1 en el alta (lock fusionado) y +2 en la edición", async () => {
      // Alta sin sala: C a las 10 (franja sin sala). Con sala: A a las 10 (Consultorio 1).
      const run = async (prac: string, when: string) => {
        const patientId = await addPatient(db, T);
        return measure(() =>
          createBooking({
            patientId,
            serviceId: svc,
            practitionerId: prac,
            scheduledFor: ar(when).toISOString(),
            durationMin: 45,
            idempotencyKey: randomUUID(),
          })
        );
      };
      const noRoom = await run(C.practitionerId, "2027-12-13T10:00");
      expect(noRoom.result).toMatchObject({ ok: true });
      const withRoom = await run(T.practitionerId, "2027-12-13T10:00");
      expect(withRoom.result).toMatchObject({ ok: true });

      // Edición (mover) por la action: sin sala (C) y con sala (A, 9:00 → 10:00).
      const c = await mk({ prac: C.practitionerId, when: ar("2027-12-14T10:00") });
      const upNoRoom = await measure(() => updateBooking({ id: c.id, scheduledFor: ar("2027-12-14T11:00").toISOString() }));
      expect(upNoRoom.result).toMatchObject({ ok: true });
      const a = await mk({ when: ar("2027-12-14T09:00"), room: R1 });
      const upRoom = await measure(() => updateBooking({ id: a.id, scheduledFor: ar("2027-12-14T10:00").toISOString() }));
      expect(upRoom.result).toMatchObject({ ok: true });

      console.info(
        `[SR3a] createBooking sin sala: ${noRoom.m.statements}/${noRoom.m.transactions}; con sala: ${withRoom.m.statements}/${withRoom.m.transactions}. ` +
          `updateBooking sin sala: ${upNoRoom.m.statements}/${upNoRoom.m.transactions}; con sala: ${upRoom.m.statements}/${upRoom.m.transactions}`
      );
      expect(noRoom.m.statements).toBe(HEAD_CREATE_STATEMENTS);
      expect(noRoom.m.transactions).toBe(5);
      expect(withRoom.m.statements).toBe(HEAD_CREATE_STATEMENTS + 1);
      expect(withRoom.m.transactions).toBe(noRoom.m.transactions);
      expect(upNoRoom.m.statements).toBe(HEAD_UPDATE_STATEMENTS);
      expect(upRoom.m.statements).toBe(HEAD_UPDATE_STATEMENTS + 2);
    });
  });
});
