/**
 * SR2a — el core de turnos (`applyBookingUpdateInTx`) con SALA, contra
 * Postgres real en los dos roles (`test:integration` = kinesoft_app con RLS;
 * `:owner` = BYPASSRLS como prod).
 *
 * Qué se fija (contratos literales de SR-C, plan §17 / §17.5):
 *   - mover el horario o cambiar la sede RECALCULA la sala por defecto
 *     (`defaultRoomFor`) en la sede final, con la sede explícita (SR-D6), y un
 *     cambio de sede nunca deja la sala vieja (23503 de la FK compuesta);
 *   - sala elegida de otra sede, de otro consultorio o archivada → `bad-room`
 *     sin escribir;
 *   - sala llena por OTRO profesional (capacity = profesionales a la vez,
 *     SR-D1) o bloqueada (§17.5) → `room-busy`; forzar con `allowRoomConflict`
 *     escribe y NO marca `isOverbooked` (SR-D2); el mismo profesional no choca
 *     consigo mismo;
 *   - `capLocksHeld` (Planes, "este y los siguientes"; SR-D3) estampa la sala
 *     sin chequear ni tomar la clave de sala;
 *   - el optimistic lock y `updatedAt` siguen igual;
 *   - concurrencia: dos ediciones de profesionales distintos a la misma sala de
 *     capacidad 1 → exactamente una pasa (clave de sala, C2 (1b));
 *   - perf: sin sala, los statements de la edición quedan IGUAL que antes de
 *     SR; con sala, +2.
 *
 * Se corre el símbolo real (el core dentro de `runWithRls`, como lo llaman
 * `updateBooking`, `rescheduleSession` y Planes; y `updateBooking` donde el
 * wrapper ya alcanza). Se mockean solo la sesión, `next/cache` y la
 * instrumentación de `@/lib/db` (un listener de `query`). Fixtures por owner.
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
import { updateBooking } from "@/lib/bookings";
import { applyBookingUpdateInTx, type BookingUpdateTxOutcome } from "@/lib/bookings-core";
import { BookingUpdate, type BookingUpdateInput } from "@/lib/validation";
import type { ForceFlags } from "@/lib/booking-force-flags";
import { roomLockKey } from "@/lib/booking-cap-lock";
import { dayKeyOf } from "@/lib/availability";
import { runWithRls } from "@/lib/rls";
import { getActor } from "@/lib/session";
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
 * Statements de la edición "mover de horario a la franja de la sede principal,
 * sin sala" medidos con el core de HEAD `ad50059` (antes de SR) en el mismo
 * escenario (`tests/integration` con el contador de este archivo). El techo
 * estricto de `updateBooking` (tests/perf/compare.ts) exige que no se mueva.
 */
const HEAD_MOVE_STATEMENTS = 25;

async function core(
  patch: BookingUpdateInput,
  o: { expectedUpdatedAt?: string; force?: ForceFlags; capLocksHeld?: boolean } = {}
): Promise<BookingUpdateTxOutcome> {
  const actor = await getActor();
  return runWithRls(actor.tenantId, (tx) =>
    applyBookingUpdateInTx(
      tx,
      actor,
      { patch: BookingUpdate.parse(patch), expectedUpdatedAt: o.expectedUpdatedAt, force: o.force ?? {} },
      { now: new Date(), capLocksHeld: o.capLocksHeld }
    )
  );
}

describe.skipIf(!RUN)("core de turnos con sala (SR2a)", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let U: EphemeralTenant;
  /** Servicio del consultorio (cupo ilimitado: el cupo no se mete en los casos de sala). */
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
    T = await createEphemeralTenant(db);
    U = await createEphemeralTenant(db);
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
        // B: 9-13 Consultorio 1 (la validación de Configuración lo frenaría contra
        // A; acá se carga directo para forzar el choque en la agenda).
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
  async function mk(o: {
    prac?: string;
    when: Date;
    dur?: number;
    loc?: string | null;
    room?: string | null;
    status?: "CONFIRMED" | "CANCELLED";
  }) {
    const patientId = await addPatient(db, T);
    return db.booking.create({
      data: {
        tenantId: T.tenantId,
        practitionerId: o.prac ?? T.practitionerId,
        serviceId: svc,
        patientId,
        scheduledFor: o.when,
        durationMin: o.dur ?? 45,
        status: o.status ?? "CONFIRMED",
        locationId: o.loc === undefined ? L1 : o.loc,
        roomId: o.room ?? null,
        idempotencyKey: randomUUID(),
      },
    });
  }

  const row = (id: string) => db.booking.findUniqueOrThrow({ where: { id } });

  // ── Sala por defecto al mover ─────────────────────────────────────────────
  describe("mover recalcula la sala por defecto", () => {
    it("10:00 (Consultorio 1) → 11:30 (Consultorio 2) → 15:00 (Box Norte, otra sede), por updateBooking", async () => {
      const b = await mk({ when: ar("2027-11-01T10:00"), room: R1 });
      const r1 = await updateBooking({ id: b.id, scheduledFor: ar("2027-11-01T11:30").toISOString() });
      expect(r1).toMatchObject({ ok: true });
      expect(await row(b.id)).toMatchObject({ roomId: R2, locationId: L1, isOverbooked: false });

      const r2 = await updateBooking({ id: b.id, scheduledFor: ar("2027-11-01T15:00").toISOString() });
      expect(r2).toMatchObject({ ok: true });
      // Sede y sala de la franja, en el MISMO UPDATE (si no, 23503).
      expect(await row(b.id)).toMatchObject({ roomId: R3, locationId: L2 });
    });

    it("sin sede (null = principal) y sin sala → al moverlo toma la sala con la sede EXPLÍCITA (SR-D6)", async () => {
      const b = await mk({ when: ar("2027-11-01T12:00"), loc: null });
      const o = await core({ id: b.id, scheduledFor: ar("2027-11-01T09:00").toISOString() });
      expect(o.kind).toBe("ok");
      expect(await row(b.id)).toMatchObject({ roomId: R1, locationId: L1 });
      if (o.kind !== "ok") return;
      expect(o.roomId).toBe(R1);
      expect(o.refs[0]).toMatchObject({
        roomId: R1,
        prev: { practitionerId: T.practitionerId, scheduledFor: ar("2027-11-01T12:00"), roomId: null },
      });
    });

    it("sala elegida en un turno sin sede → estampa la sede principal (SR-D6), sin mover", async () => {
      const b = await mk({ when: ar("2027-11-01T16:00"), loc: null });
      const o = await core({ id: b.id, roomId: R2 });
      expect(o.kind).toBe("ok");
      expect(await row(b.id)).toMatchObject({ roomId: R2, locationId: L1 });
    });

    it("'Sin sala' explícito (null): al moverlo NO recupera la de la franja", async () => {
      const b = await mk({ when: ar("2027-11-01T09:00"), room: R1 });
      const o = await core({ id: b.id, scheduledFor: ar("2027-11-01T11:15").toISOString(), roomId: null });
      expect(o.kind).toBe("ok");
      expect((await row(b.id)).roomId).toBeNull();
    });

    it("editar sin mover (notas) no toca la sala ni pide prev", async () => {
      const b = await mk({ when: ar("2027-11-01T09:00"), room: R2 });
      const o = await core({ id: b.id, notes: "control" });
      expect(o.kind).toBe("ok");
      expect((await row(b.id)).roomId).toBe(R2);
      if (o.kind !== "ok") return;
      expect(o.roomId).toBeUndefined();
      expect(o.refs[0]).toMatchObject({ roomId: R2, prev: null });
      // El drawer reenvía la misma sala al guardar notas: ni valida ni escribe de más.
      const plain = await measure(() => core({ id: b.id, notes: "a" }));
      const same = await measure(() => core({ id: b.id, notes: "b", roomId: R2 }));
      expect(same.result.kind).toBe("ok");
      expect(same.m.statements).toBe(plain.m.statements);
    });
  });

  // ── Cambio de sede ────────────────────────────────────────────────────────
  describe("cambiar la sede nunca deja la sala vieja (sin 23503)", () => {
    it("misma hora, otra sede sin franja con sala → la sala se limpia", async () => {
      const b = await mk({ when: ar("2027-11-02T10:00"), room: R1 });
      const o = await core({ id: b.id, locationId: L2 }, { force: { allowOutOfHours: true } });
      expect(o.kind).toBe("ok");
      expect(await row(b.id)).toMatchObject({ locationId: L2, roomId: null });
    });

    it("horario + sede → la sala de la franja de la sede nueva", async () => {
      const b = await mk({ when: ar("2027-11-02T10:00"), room: R1 });
      const o = await core({ id: b.id, locationId: L2, scheduledFor: ar("2027-11-02T15:00").toISOString() });
      expect(o.kind).toBe("ok");
      expect(await row(b.id)).toMatchObject({ locationId: L2, roomId: R3 });
    });

    it("turno CANCELADO con sala que cambia de sede → sala null", async () => {
      const b = await mk({ when: ar("2027-11-02T12:00"), room: R2, status: "CANCELLED" });
      const o = await core({ id: b.id, locationId: L2 });
      expect(o.kind).toBe("ok");
      expect(await row(b.id)).toMatchObject({ locationId: L2, roomId: null, status: "CANCELLED" });
    });
  });

  // ── bad-room ──────────────────────────────────────────────────────────────
  describe("sala elegida inválida → bad-room sin escribir", () => {
    it.each([
      ["de otra sede", () => R3],
      ["de otro consultorio", () => RForeign],
      ["archivada", () => RArch],
    ])("%s", async (_label, room) => {
      const b = await mk({ when: ar("2027-11-03T10:00"), room: R1 });
      const o = await core({ id: b.id, roomId: room(), scheduledFor: ar("2027-11-03T10:30").toISOString() });
      expect(o).toEqual({ kind: "bad-room" });
      const after = await row(b.id);
      expect(after).toMatchObject({ roomId: R1, locationId: L1 });
      expect(+after.updatedAt).toBe(+b.updatedAt);
      expect(+after.scheduledFor).toBe(+b.scheduledFor);
    });
  });

  // ── room-busy ─────────────────────────────────────────────────────────────
  describe("sala ocupada por otro profesional (capacidad 1)", () => {
    it("mover a la sala ocupada → room-busy sin escribir; forzando escribe con isOverbooked=false", async () => {
      await mk({ prac: B.practitionerId, when: ar("2027-11-04T10:00"), room: R1 });
      const a = await mk({ when: ar("2027-11-04T12:00"), room: R2 });
      const to = ar("2027-11-04T10:15").toISOString();

      const o = await core({ id: a.id, scheduledFor: to });
      expect(o).toEqual({ kind: "room-busy", roomName: "Consultorio 1", used: 1, capacity: 1, blocked: null });
      const same = await row(a.id);
      expect(same).toMatchObject({ roomId: R2 });
      expect(+same.updatedAt).toBe(+a.updatedAt);

      const f = await core({ id: a.id, scheduledFor: to }, { force: { allowRoomConflict: true } });
      expect(f.kind).toBe("ok");
      // SR-D2: forzar la sala NO es sobreturno.
      expect(await row(a.id)).toMatchObject({ roomId: R1, isOverbooked: false, scheduledFor: new Date(to) });
    });

    it("cambiar SOLO la sala (mismo horario) a una ocupada → room-busy", async () => {
      await mk({ prac: B.practitionerId, when: ar("2027-11-08T10:00"), room: R1 });
      const a = await mk({ when: ar("2027-11-08T10:00"), room: R2 });
      const o = await core({ id: a.id, roomId: R1 });
      expect(o).toMatchObject({ kind: "room-busy", roomName: "Consultorio 1", used: 1, capacity: 1 });
      expect((await row(a.id)).roomId).toBe(R2);
    });

    it("alargar un turno que pasa a pisar a otro profesional en su sala → room-busy", async () => {
      await mk({ prac: B.practitionerId, when: ar("2027-11-08T12:00"), room: R2 });
      const a = await mk({ when: ar("2027-11-08T11:00"), room: R2, dur: 45 });
      const o = await core({ id: a.id, durationMin: 90 });
      expect(o).toMatchObject({ kind: "room-busy", roomName: "Consultorio 2" });
      expect((await row(a.id)).durationMin).toBe(45);
    });

    it("mismo profesional, dos turnos en su sala → no choca", async () => {
      await mk({ when: ar("2027-11-09T10:00"), room: R1 });
      const a2 = await mk({ when: ar("2027-11-09T12:00"), room: R2 });
      const o = await core({ id: a2.id, scheduledFor: ar("2027-11-09T10:00").toISOString() });
      expect(o.kind).toBe("ok");
      expect(await row(a2.id)).toMatchObject({ roomId: R1, isOverbooked: false });
    });
  });

  describe("bloqueo de sala (§17.5)", () => {
    it("cuenta como sala llena: room-busy con blocked y motivo; forzable sin sobreturno", async () => {
      await db.timeBlock.create({
        data: {
          tenantId: T.tenantId,
          locationId: L1,
          roomId: R2,
          practitionerId: null,
          startsAt: ar("2027-11-05T11:00"),
          endsAt: ar("2027-11-05T13:00"),
          reason: "Mantenimiento",
          createdById: T.userId,
        },
      });
      const a = await mk({ when: ar("2027-11-05T09:30"), room: R1 });
      const to = ar("2027-11-05T11:30").toISOString();
      const o = await core({ id: a.id, scheduledFor: to });
      // Ni `blocked` de profesional (el bloqueo de sala no bloquea gente) ni conflicto: sala llena.
      expect(o).toEqual({
        kind: "room-busy",
        roomName: "Consultorio 2",
        used: 0,
        capacity: 1,
        blocked: { reason: "Mantenimiento" },
      });
      const f = await core({ id: a.id, scheduledFor: to }, { force: { allowRoomConflict: true } });
      expect(f.kind).toBe("ok");
      expect(await row(a.id)).toMatchObject({ roomId: R2, isOverbooked: false });
    });
  });

  // ── capLocksHeld (SR-D3) ──────────────────────────────────────────────────
  describe("capLocksHeld (Planes, 'este y los siguientes')", () => {
    it("estampa la sala por defecto sin chequear ocupación ni tomar la clave de sala", async () => {
      await mk({ prac: B.practitionerId, when: ar("2027-11-10T10:00"), room: R1 });
      const a = await mk({ when: ar("2027-11-10T12:00"), room: R2 });
      const to = ar("2027-11-10T10:00");
      // Alguien tiene la clave de sala de ese día: si el core la pidiera, se colgaría.
      const holder = ownerClient();
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      let acquired!: () => void;
      const got = new Promise<void>((r) => (acquired = r));
      const k = roomLockKey({ tenantId: T.tenantId, roomId: R1, dayKey: dayKeyOf(to) });
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
        const o = await core({ id: a.id, scheduledFor: to.toISOString() }, { capLocksHeld: true });
        expect(o.kind).toBe("ok");
        expect(await row(a.id)).toMatchObject({ roomId: R1, locationId: L1, isOverbooked: false });
      } finally {
        release();
        await held.catch(() => {});
        await holder.$disconnect();
      }
    });
  });

  // ── Optimistic lock ───────────────────────────────────────────────────────
  describe("optimistic lock y updatedAt", () => {
    it("versión vieja → stale sin escribir la sala; versión actual → escribe y devuelve el updatedAt de la fila", async () => {
      const a = await mk({ when: ar("2027-11-11T09:00"), room: R1 });
      const old = new Date(a.updatedAt.getTime() - 1000).toISOString();
      const s = await core({ id: a.id, roomId: R2 }, { expectedUpdatedAt: old });
      expect(s).toEqual({ kind: "stale" });
      expect((await row(a.id)).roomId).toBe(R1);

      const o = await core({ id: a.id, roomId: R2 }, { expectedUpdatedAt: a.updatedAt.toISOString() });
      expect(o.kind).toBe("ok");
      const after = await row(a.id);
      expect(after.roomId).toBe(R2);
      if (o.kind !== "ok") return;
      expect(+after.updatedAt).toBe(+o.updatedAt);
      expect(+after.updatedAt).toBeGreaterThan(+a.updatedAt);
      expect(o.roomId).toBe(R2);
      expect(o.refs[0].prev).toMatchObject({ roomId: R1 });
      // Con el updatedAt viejo (el de antes de cambiar la sala) → stale.
      expect(await core({ id: a.id, notes: "x" }, { expectedUpdatedAt: a.updatedAt.toISOString() })).toEqual({
        kind: "stale",
      });
    });
  });

  // ── Concurrencia ──────────────────────────────────────────────────────────
  describe("concurrencia: dos profesionales a la misma sala de capacidad 1", () => {
    async function race(day: string, patchOf: (id: string) => BookingUpdateInput) {
      const a = await mk({ when: ar(`${day}T15:00`), loc: L2, room: R3 });
      const b = await mk({ prac: B.practitionerId, when: ar(`${day}T12:00`), room: R1 });
      const k = roomLockKey({ tenantId: T.tenantId, roomId: R1, dayKey: day });
      const holder = ownerClient();
      const appDb = ownerClient();
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
        const pa = core(patchOf(a.id));
        const pb = core(patchOf(b.id));
        // Las dos tienen su cupo (claves distintas) y esperan la MISMA clave de sala.
        await waitForAdvisoryWaiter(appDb, k, { minWaiters: 2 });
        expect(await countAdvisoryWaiters(appDb, k)).toBe(2);
        release();
        await held;
        const outs = await Promise.all([pa, pb]);
        const kinds = outs.map((o) => o.kind).sort();
        expect(kinds).toEqual(["ok", "room-busy"]);
        const rows = await db.booking.findMany({
          where: { id: { in: [a.id, b.id] }, roomId: R1, scheduledFor: ar(`${day}T10:00`) },
        });
        expect(rows).toHaveLength(1);
      } finally {
        release();
        await held.catch(() => {});
        await Promise.all([holder.$disconnect(), appDb.$disconnect()]);
      }
    }

    it("sala por defecto (clave de sala en su sentencia, después del cupo)", async () => {
      await race("2027-11-12", (id) => ({ id, scheduledFor: ar("2027-11-12T10:00").toISOString() }));
    });

    it("sala elegida (cupo + sala fusionados en UNA sentencia)", async () => {
      await race("2027-11-15", (id) => ({
        id,
        scheduledFor: ar("2027-11-15T10:00").toISOString(),
        locationId: L1,
        roomId: R1,
      }));
    });
  });

  // ── Perf ──────────────────────────────────────────────────────────────────
  describe("statements (techo estricto de updateBooking)", () => {
    it("sin sala: igual que antes de SR; con sala por defecto: +2", async () => {
      const actor = await getActor();
      const run = (id: string, when: string) =>
        measure(() =>
          runWithRls(actor.tenantId, (tx) =>
            applyBookingUpdateInTx(
              tx,
              actor,
              { patch: BookingUpdate.parse({ id, scheduledFor: ar(when).toISOString() }), force: {} },
              { now: new Date() }
            )
          )
        );
      const c = await mk({ prac: C.practitionerId, when: ar("2027-11-16T10:00") });
      const noRoom = await run(c.id, "2027-11-16T11:00");
      expect(noRoom.result.kind).toBe("ok");
      const a = await mk({ when: ar("2027-11-16T09:00"), room: R1 });
      const withRoom = await run(a.id, "2027-11-16T10:00");
      expect(withRoom.result.kind).toBe("ok");
      console.info(`[SR2a] mover sin sala: ${noRoom.m.statements} statements; con sala: ${withRoom.m.statements}`);
      expect(noRoom.m.statements).toBe(HEAD_MOVE_STATEMENTS);
      expect(withRoom.m.statements).toBe(HEAD_MOVE_STATEMENTS + 2);
    });
  });
});
