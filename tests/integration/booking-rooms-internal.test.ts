/**
 * SR1d — `lib/booking-rooms-internal.ts` contra Postgres real, en los dos roles
 * (`test:integration` = kinesoft_app con RLS; `:owner` = BYPASSRLS como prod).
 *
 * Qué se fija:
 *   1. `lockActiveRoomInTx`: null para sala archivada, de otra sede, de otro
 *      tenant o de una sede archivada (→ outcome `bad-room` del core). Una query.
 *   2. `countRoomOverlapsInTx` (capacity = PROFESIONALES a la vez, SR-D1):
 *      profesionales distintos suman, el mismo no; CANCELLED y la reserva
 *      pública vencida (§5.18) no cuentan; tocarse en el borde no cuenta; el
 *      lookback (480 min, `ROOM_LOOKBACK_MIN`) sí agarra un turno largo previo; el bloqueo de sala
 *      (§17.5) devuelve `blocked` y llena la sala; `excludeId`/`excludeKey`
 *      excluyen. UNA sentencia (contador del harness).
 *   3. `loadRoomBookingsInTx`: una sola carga para varias fechas (batch).
 *   4. Concurrencia: dos tx que toman `lockCapacityAndRoomsMany` sobre la misma
 *      sala se serializan, y la segunda cuenta DESPUÉS del commit de la primera
 *      (ve su turno: sin el lock era un TOCTOU de dos altas en una sala de 1).
 *
 * Se corre el símbolo real dentro de `runWithRls` (la tx de prod). `@/lib/db`
 * solo se instrumenta con `installQueryCounter` (un listener de `query`).
 * Fixtures por owner. Fechas en 2027, lejos de "hoy": nada depende del reloj
 * salvo `now`, que se pasa explícito.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { installQueryCounter } = await import("@/tests/helpers/query-counter");
  return { ...actual, ...installQueryCounter() };
});

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  addPatient,
  addRoom,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { measure } from "@/tests/helpers/query-counter";
import { waitForAdvisoryWaiter } from "@/tests/helpers/advisory-wait";
import { runWithRls } from "@/lib/rls";
import {
  lockActiveRoomInTx,
  countRoomOverlapsInTx,
  loadRoomBookingsInTx,
} from "@/lib/booking-rooms-internal";
import { lockCapacityAndRoomsMany, roomKeysForWindow, roomLockKey } from "@/lib/booking-cap-lock";
import { roomOccupancyAt } from "@/lib/availability/rooms";

const RUN = process.env.INTEGRATION === "1";

/** Pared AR → instante. */
const ar = (local: string) => new Date(`${local}:00-03:00`);
const NOW = ar("2027-01-01T00:00");

describe.skipIf(!RUN)("ocupación de sala server-only (SR1d)", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let P1: string;
  let P2: string;
  let P3: string;
  let mainLoc: string;

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
    P1 = A.practitionerId;
    P2 = (await addPractitioner(db, A)).practitionerId;
    P3 = (await addPractitioner(db, A)).practitionerId;
    mainLoc = (await addRoom(db, A, { name: "Semilla" })).locationId;
  });
  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await db?.$disconnect();
  });

  async function room(capacity = 1, data: { locationId?: string; active?: boolean } = {}) {
    return addRoom(db, A, { capacity, locationId: data.locationId ?? mainLoc, active: data.active });
  }

  async function book(o: {
    roomId: string;
    practitionerId: string;
    at: Date;
    durationMin?: number;
    status?: "PENDING" | "CONFIRMED" | "CANCELLED";
    paymentStatus?: "UNPAID" | "PAID";
    patientId?: string | null;
    idempotencyKey?: string;
    createdAt?: Date;
  }) {
    const b = await db.booking.create({
      data: {
        tenantId: A.tenantId,
        practitionerId: o.practitionerId,
        serviceId: A.serviceId,
        patientId: o.patientId ?? null,
        guestName: o.patientId ? null : "Invitado",
        scheduledFor: o.at,
        durationMin: o.durationMin ?? 60,
        status: o.status ?? "CONFIRMED",
        paymentStatus: o.paymentStatus ?? "UNPAID",
        idempotencyKey: o.idempotencyKey ?? randomUUID(),
        locationId: mainLoc,
        roomId: o.roomId,
        ...(o.createdAt ? { createdAt: o.createdAt } : {}),
      },
      select: { id: true, idempotencyKey: true },
    });
    return b;
  }

  async function blockRoom(roomId: string, from: Date, to: Date, reason: string | null, deleted = false) {
    const k = await db.timeBlock.create({
      data: {
        tenantId: A.tenantId,
        locationId: mainLoc,
        roomId,
        startsAt: from,
        endsAt: to,
        reason,
        createdById: A.userId,
        deletedAt: deleted ? new Date() : null,
      },
      select: { id: true },
    });
    return k.id;
  }

  const count = (o: {
    roomId: string;
    practitionerId: string;
    start: Date;
    end: Date;
    capacity: number;
    now?: Date;
    excludeId?: string;
    excludeKey?: string | null;
  }) => runWithRls(A.tenantId, (tx) => countRoomOverlapsInTx(tx, { tenantId: A.tenantId, now: NOW, ...o }));

  // ── lockActiveRoomInTx ───────────────────────────────────────────────────
  describe("lockActiveRoomInTx", () => {
    const lookup = (tenantId: string, roomId: string, locationId: string) =>
      runWithRls(tenantId, (tx) => lockActiveRoomInTx(tx, { tenantId, roomId, locationId }));

    it("sala activa de una sede activa → { id, capacity, name, locationId }, en 1 query", async () => {
      const r = await addRoom(db, A, { name: "Box activo", capacity: 3, locationId: mainLoc });
      const { result, m } = await measure(() => lookup(A.tenantId, r.roomId, mainLoc));
      expect(result).toEqual({ id: r.roomId, capacity: 3, name: "Box activo", locationId: mainLoc });
      expect(m.statements).toBe(1);
    });

    it("sala archivada → null", async () => {
      const r = await room(1, { active: false });
      expect(await lookup(A.tenantId, r.roomId, mainLoc)).toBeNull();
    });

    it("sala de OTRA sede del mismo tenant → null", async () => {
      const other = await db.location.create({ data: { tenantId: A.tenantId, name: `Sede 2 ${randomUUID()}` } });
      const r = await room(1, { locationId: other.id });
      expect(await lookup(A.tenantId, r.roomId, mainLoc)).toBeNull();
      // Con su sede sí aparece (el null de arriba es por la sede, no por otra cosa).
      expect(await lookup(A.tenantId, r.roomId, other.id)).not.toBeNull();
    });

    it("sala de OTRO tenant → null (aunque se pase su sede)", async () => {
      const rb = await addRoom(db, B, { name: "Ajeno" });
      expect(await lookup(A.tenantId, rb.roomId, rb.locationId)).toBeNull();
    });

    it("sala activa de una sede ARCHIVADA → null", async () => {
      const loc = await db.location.create({ data: { tenantId: A.tenantId, name: `Sede cerrada ${randomUUID()}` } });
      const r = await room(1, { locationId: loc.id });
      expect(await lookup(A.tenantId, r.roomId, loc.id)).not.toBeNull();
      await db.location.update({ where: { id: loc.id }, data: { active: false } });
      expect(await lookup(A.tenantId, r.roomId, loc.id)).toBeNull();
    });
  });

  // ── countRoomOverlapsInTx ────────────────────────────────────────────────
  describe("countRoomOverlapsInTx", () => {
    it("profesionales DISTINTOS que solapan suman `used` (y se listan, sin repetir)", async () => {
      const r = await room(2);
      await book({ roomId: r.roomId, practitionerId: P2, at: ar("2027-03-01T10:00") });
      await book({ roomId: r.roomId, practitionerId: P2, at: ar("2027-03-01T10:30"), durationMin: 30 });
      await book({ roomId: r.roomId, practitionerId: P3, at: ar("2027-03-01T10:30") });
      const q = { roomId: r.roomId, practitionerId: P1, start: ar("2027-03-01T10:30"), end: ar("2027-03-01T11:00") };
      const occ = await count({ ...q, capacity: 2 });
      expect(occ).toEqual({
        used: 2,
        capacity: 2,
        atCapacity: true,
        practitionerIds: [P2, P3].sort(),
        blocked: null,
      });
      expect((await count({ ...q, capacity: 3 })).atCapacity).toBe(false);
    });

    it("el MISMO profesional no suma (no choca consigo mismo)", async () => {
      const r = await room(1);
      await book({ roomId: r.roomId, practitionerId: P1, at: ar("2027-03-02T10:00") });
      await book({ roomId: r.roomId, practitionerId: P1, at: ar("2027-03-02T10:15") });
      const occ = await count({
        roomId: r.roomId,
        practitionerId: P1,
        start: ar("2027-03-02T10:00"),
        end: ar("2027-03-02T11:00"),
        capacity: 1,
      });
      expect(occ).toMatchObject({ used: 0, atCapacity: false, practitionerIds: [] });
    });

    it("un CANCELLED no cuenta", async () => {
      const r = await room(1);
      await book({ roomId: r.roomId, practitionerId: P2, at: ar("2027-03-03T10:00"), status: "CANCELLED" });
      const occ = await count({
        roomId: r.roomId,
        practitionerId: P1,
        start: ar("2027-03-03T10:00"),
        end: ar("2027-03-03T11:00"),
        capacity: 1,
      });
      expect(occ).toMatchObject({ used: 0, atCapacity: false });
    });

    it("una reserva pública impaga VENCIDA no cuenta; vigente sí (§5.18)", async () => {
      const r = await room(1);
      const patientId = await addPatient(db, A);
      const createdAt = ar("2027-02-20T09:00");
      await book({
        roomId: r.roomId,
        practitionerId: P2,
        at: ar("2027-03-04T10:00"),
        status: "PENDING",
        paymentStatus: "UNPAID",
        patientId,
        idempotencyKey: `pub:${A.tenantId}:${randomUUID()}`,
        createdAt,
      });
      const q = {
        roomId: r.roomId,
        practitionerId: P1,
        start: ar("2027-03-04T10:00"),
        end: ar("2027-03-04T11:00"),
        capacity: 1,
      };
      const vencida = await count({ ...q, now: new Date(createdAt.getTime() + 31 * 60_000) });
      expect(vencida).toMatchObject({ used: 0, atCapacity: false });
      const vigente = await count({ ...q, now: new Date(createdAt.getTime() + 10 * 60_000) });
      expect(vigente).toMatchObject({ used: 1, atCapacity: true, practitionerIds: [P2] });
    });

    it("tocarse en el borde no cuenta (semiabierto), en los dos lados", async () => {
      const r = await room(1);
      await book({ roomId: r.roomId, practitionerId: P2, at: ar("2027-03-05T09:00") }); // 9-10
      await book({ roomId: r.roomId, practitionerId: P3, at: ar("2027-03-05T11:00") }); // 11-12
      const occ = await count({
        roomId: r.roomId,
        practitionerId: P1,
        start: ar("2027-03-05T10:00"),
        end: ar("2027-03-05T11:00"),
        capacity: 1,
      });
      expect(occ).toMatchObject({ used: 0, atCapacity: false });
    });

    it("lookback de 240 min: un turno largo que arrancó antes sigue ocupando", async () => {
      const r = await room(1);
      await book({ roomId: r.roomId, practitionerId: P2, at: ar("2027-03-06T07:00"), durationMin: 240 }); // 7-11
      const occ = await count({
        roomId: r.roomId,
        practitionerId: P1,
        start: ar("2027-03-06T10:30"),
        end: ar("2027-03-06T11:30"),
        capacity: 1,
      });
      expect(occ).toMatchObject({ used: 1, atCapacity: true, practitionerIds: [P2] });
    });

    it("[SR-FX1] lookback de 480 min: un servicio de 6 h de otro profesional (8:00) ocupa la sala a las 12:30", async () => {
      // `Service.durationMin` admite hasta 480 (lib/validation.ts): con el
      // lookback heredado de 240 el turno de las 8:00 quedaba fuera de la carga
      // y la sala de capacidad 1 se veía libre a las 12:30 (revisión (a) de SR).
      const r = await room(1);
      await book({ roomId: r.roomId, practitionerId: P2, at: ar("2027-03-13T08:00"), durationMin: 360 }); // 8-14
      const occ = await count({
        roomId: r.roomId,
        practitionerId: P1,
        start: ar("2027-03-13T12:30"),
        end: ar("2027-03-13T13:30"),
        capacity: 1,
      });
      expect(occ).toMatchObject({ used: 1, atCapacity: true, practitionerIds: [P2] });
      // Y en el borde de 8 h: uno de 480 min que arrancó a las 6:00 todavía ocupa a las 13:30.
      await book({ roomId: r.roomId, practitionerId: P3, at: ar("2027-03-14T06:00"), durationMin: 480 }); // 6-14
      const edge = await count({
        roomId: r.roomId,
        practitionerId: P1,
        start: ar("2027-03-14T13:30"),
        end: ar("2027-03-14T14:30"),
        capacity: 1,
      });
      expect(edge).toMatchObject({ used: 1, atCapacity: true, practitionerIds: [P3] });
    });

    it("turnos de OTRA sala no cuentan", async () => {
      const r = await room(1);
      const other = await room(1);
      await book({ roomId: other.roomId, practitionerId: P2, at: ar("2027-03-07T10:00") });
      const occ = await count({
        roomId: r.roomId,
        practitionerId: P1,
        start: ar("2027-03-07T10:00"),
        end: ar("2027-03-07T11:00"),
        capacity: 1,
      });
      expect(occ.used).toBe(0);
    });

    it("bloqueo de sala → `blocked` y sala llena aunque haya lugar (§17.5); borde, borrado y otra sala no", async () => {
      const r = await room(5);
      const other = await room(5);
      const kId = await blockRoom(r.roomId, ar("2027-03-08T10:30"), ar("2027-03-08T12:00"), "Mantenimiento");
      await blockRoom(r.roomId, ar("2027-03-08T10:00"), ar("2027-03-08T10:45"), "Borrado", true);
      await blockRoom(r.roomId, ar("2027-03-08T08:00"), ar("2027-03-08T10:00"), "Antes"); // toca el borde
      await blockRoom(other.roomId, ar("2027-03-08T09:00"), ar("2027-03-08T13:00"), "Otra sala");
      const q = { roomId: r.roomId, practitionerId: P1, capacity: 5 };
      const occ = await count({ ...q, start: ar("2027-03-08T10:00"), end: ar("2027-03-08T11:00") });
      expect(occ).toEqual({
        used: 0,
        capacity: 5,
        atCapacity: true,
        practitionerIds: [],
        blocked: { blockId: kId, reason: "Mantenimiento" },
      });
      const before = await count({ ...q, start: ar("2027-03-08T09:30"), end: ar("2027-03-08T10:00") });
      expect(before.blocked?.reason).toBe("Antes");
      const after = await count({ ...q, start: ar("2027-03-08T12:00"), end: ar("2027-03-08T13:00") });
      expect(after).toMatchObject({ atCapacity: false, blocked: null });
    });

    it("excludeId y excludeKey excluyen la fila propia (edición / reintento idempotente)", async () => {
      const r = await room(1);
      const mine = await book({ roomId: r.roomId, practitionerId: P2, at: ar("2027-03-09T10:00") });
      const q = {
        roomId: r.roomId,
        practitionerId: P1,
        start: ar("2027-03-09T10:00"),
        end: ar("2027-03-09T11:00"),
        capacity: 1,
      };
      expect((await count(q)).used).toBe(1);
      expect(await count({ ...q, excludeId: mine.id })).toMatchObject({ used: 0, atCapacity: false });
      expect(await count({ ...q, excludeKey: mine.idempotencyKey })).toMatchObject({ used: 0, atCapacity: false });
    });

    it("tenantId a mano: con el tenant de otro no ve nada (owner = BYPASSRLS)", async () => {
      const r = await room(1);
      await book({ roomId: r.roomId, practitionerId: P2, at: ar("2027-03-10T10:00") });
      await blockRoom(r.roomId, ar("2027-03-10T10:00"), ar("2027-03-10T11:00"), "X");
      const occ = await runWithRls(B.tenantId, (tx) =>
        countRoomOverlapsInTx(tx, {
          tenantId: B.tenantId,
          roomId: r.roomId,
          practitionerId: B.practitionerId,
          start: ar("2027-03-10T10:00"),
          end: ar("2027-03-10T11:00"),
          now: NOW,
          capacity: 1,
        })
      );
      expect(occ).toMatchObject({ used: 0, atCapacity: false, blocked: null });
    });

    it("UNA sentencia (turnos + bloqueos), con y sin excludes", async () => {
      const r = await room(1);
      await book({ roomId: r.roomId, practitionerId: P2, at: ar("2027-03-11T10:00") });
      await blockRoom(r.roomId, ar("2027-03-11T10:00"), ar("2027-03-11T11:00"), "X");
      const q = {
        roomId: r.roomId,
        practitionerId: P1,
        start: ar("2027-03-11T10:00"),
        end: ar("2027-03-11T11:00"),
        capacity: 1,
      };
      const a = await measure(() => count(q));
      expect(a.result).toMatchObject({ used: 1, blocked: { reason: "X" } });
      expect(a.m.statements).toBe(1);
      const b = await measure(() => count({ ...q, excludeId: "x", excludeKey: "y" }));
      expect(b.m.statements).toBe(1);
    });
  });

  // ── loadRoomBookingsInTx ─────────────────────────────────────────────────
  describe("loadRoomBookingsInTx", () => {
    it("una carga para todas las fechas del batch: lookback, sin CANCELLED, bloqueos vigentes, 1 sentencia", async () => {
      const r = await room(1);
      const early = await book({ roomId: r.roomId, practitionerId: P2, at: ar("2027-04-04T23:00"), durationMin: 240 });
      const d1 = await book({ roomId: r.roomId, practitionerId: P2, at: ar("2027-04-05T10:00") });
      const d2 = await book({ roomId: r.roomId, practitionerId: P3, at: ar("2027-04-12T10:00") });
      await book({ roomId: r.roomId, practitionerId: P3, at: ar("2027-04-12T12:00"), status: "CANCELLED" });
      await book({ roomId: r.roomId, practitionerId: P3, at: ar("2027-04-20T10:00") }); // después de `to`
      await book({ roomId: r.roomId, practitionerId: P3, at: ar("2027-04-04T15:00") }); // antes del lookback de 480 (9 h antes de `from`)
      const k = await blockRoom(r.roomId, ar("2027-04-19T09:00"), ar("2027-04-19T12:00"), "Pintura");
      await blockRoom(r.roomId, ar("2027-04-19T09:00"), ar("2027-04-19T12:00"), "Borrado", true);

      const from = ar("2027-04-05T00:00");
      const to = ar("2027-04-20T00:00");
      const { result, m } = await measure(() =>
        runWithRls(A.tenantId, (tx) => loadRoomBookingsInTx(tx, { tenantId: A.tenantId, roomId: r.roomId, from, to }))
      );
      expect(m.statements).toBe(1);
      expect(result.bookings.map((b) => b.id)).toEqual([early.id, d1.id, d2.id]);
      expect(result.bookings[1]).toMatchObject({
        practitionerId: P2,
        serviceId: A.serviceId,
        scheduledFor: ar("2027-04-05T10:00"),
        durationMin: 60,
        status: "CONFIRMED",
        paymentStatus: "UNPAID",
        locationId: mainLoc,
        roomId: r.roomId,
      });
      expect(result.bookings[1].createdAt).toBeInstanceOf(Date);
      expect(result.blocks).toEqual([
        { id: k, roomId: r.roomId, startsAt: ar("2027-04-19T09:00"), endsAt: ar("2027-04-19T12:00"), reason: "Pintura" },
      ]);

      // Paridad batch ↔ alta suelta: `roomOccupancyAt` por fecha sobre la carga
      // única da lo mismo que `countRoomOverlapsInTx` fecha por fecha.
      for (const startLocal of ["2027-04-05T00:30", "2027-04-05T10:30", "2027-04-12T10:00", "2027-04-19T11:00", "2027-04-19T13:00"]) {
        const start = ar(startLocal);
        const end = new Date(start.getTime() + 60 * 60_000);
        const fromBatch = roomOccupancyAt(
          result.bookings,
          { roomId: r.roomId, practitionerId: P1, when: start, durationMin: 60, capacity: 1, now: NOW },
          result.blocks
        );
        const single = await count({ roomId: r.roomId, practitionerId: P1, start, end, capacity: 1 });
        expect({ startLocal, occ: fromBatch }).toEqual({ startLocal, occ: single });
      }
    });

    it("[SR-FX1] lookback de 480 min en la carga del batch: un turno de 6 h que arrancó 4,5 h antes de `from` entra", async () => {
      const r = await room(1);
      const long = await book({ roomId: r.roomId, practitionerId: P2, at: ar("2027-04-25T08:00"), durationMin: 360 }); // 8-14
      await book({ roomId: r.roomId, practitionerId: P3, at: ar("2027-04-25T04:00"), durationMin: 60 }); // antes de 480
      const from = ar("2027-04-25T12:30");
      const to = ar("2027-04-25T13:30");
      const { result, m } = await measure(() =>
        runWithRls(A.tenantId, (tx) => loadRoomBookingsInTx(tx, { tenantId: A.tenantId, roomId: r.roomId, from, to }))
      );
      expect(m.statements).toBe(1);
      expect(result.bookings.map((b) => b.id)).toEqual([long.id]);
      expect(
        roomOccupancyAt(
          result.bookings,
          { roomId: r.roomId, practitionerId: P1, when: from, durationMin: 60, capacity: 1, now: NOW },
          result.blocks
        )
      ).toMatchObject({ used: 1, atCapacity: true, practitionerIds: [P2] });
    });
  });

  // ── Concurrencia ─────────────────────────────────────────────────────────
  describe("concurrencia: lockCapacityAndRoomsMany sobre la misma sala", () => {
    it("la segunda tx espera la clave de sala y cuenta DESPUÉS del commit de la primera", async () => {
      const r = await room(1);
      const start = ar("2027-05-03T10:00");
      const end = ar("2027-05-03T11:00");
      const roomKeys = roomKeysForWindow({ tenantId: A.tenantId, roomId: r.roomId, start, end });
      const key = roomLockKey(roomKeys[0]);

      let release!: () => void;
      const released = new Promise<void>((res) => (release = res));
      let firstCounted!: () => void;
      const firstReady = new Promise<void>((res) => (firstCounted = res));

      // T1: lock → cuenta (0) → escribe su turno (P2) → se queda abierta.
      const t1 = runWithRls(
        A.tenantId,
        async (tx) => {
          await lockCapacityAndRoomsMany(tx, [], roomKeys);
          const occ = await countRoomOverlapsInTx(tx, {
            tenantId: A.tenantId,
            roomId: r.roomId,
            practitionerId: P2,
            start,
            end,
            now: NOW,
            capacity: 1,
          });
          await tx.booking.create({
            data: {
              tenantId: A.tenantId,
              practitionerId: P2,
              serviceId: A.serviceId,
              guestName: "T1",
              scheduledFor: start,
              durationMin: 60,
              status: "CONFIRMED",
              idempotencyKey: randomUUID(),
              locationId: mainLoc,
              roomId: r.roomId,
            },
          });
          firstCounted();
          await released;
          return occ;
        },
        { timeout: 20_000 }
      );
      await firstReady;

      // T2: misma sala, otro profesional. Tiene que quedar esperando la clave.
      let t2Done = false;
      const t2 = runWithRls(
        A.tenantId,
        async (tx) => {
          await lockCapacityAndRoomsMany(tx, [], roomKeys);
          return countRoomOverlapsInTx(tx, {
            tenantId: A.tenantId,
            roomId: r.roomId,
            practitionerId: P3,
            start,
            end,
            now: NOW,
            capacity: 1,
          });
        },
        { timeout: 20_000 }
      ).finally(() => (t2Done = true));

      try {
        await waitForAdvisoryWaiter(db, key);
        expect(t2Done).toBe(false);
      } finally {
        release();
      }
      const occ1 = await t1;
      const occ2 = await t2;
      expect(occ1).toMatchObject({ used: 0, atCapacity: false });
      // Sin el lock, T2 habría leído 0 (el turno de T1 sin commitear) y escrito igual.
      expect(occ2).toMatchObject({ used: 1, atCapacity: true, practitionerIds: [P2] });
    });
  });
});
