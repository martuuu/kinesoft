/**
 * SR3a — `lib/availability-actions.ts` con SALA, contra Postgres real en los
 * dos roles.
 *
 *   - `getAgendaAvailability`: `days[].roomAssignments` (quién tiene cada sala
 *     ese día, de las franjas CRUDAS con sala: `roomAssignmentsFor` de SR1a) y
 *     `roomBlocks` (bloqueos de sala, §17.5) sin mezclarlos con `blocks` (que
 *     son de profesionales/consultorio). Sin sentencias nuevas: salen del mismo
 *     `loadAvailabilityInputs`.
 *   - `classifyBookingInstant`: `defaultRoomId` (`defaultRoomFor` sobre la sede
 *     resuelta) y `roomBusy` (otro profesional en la sala o bloqueo de sala).
 *     El loader solo trae los turnos de los profesionales pedidos, así que la
 *     ocupación sale de `loadRoomBookingsInTx` + `roomOccupancyAt`, y SOLO si
 *     hay sala (sin sala, 0 sentencias nuevas).
 *   - `roomId`: ausente = la por defecto; null / "" = "Sin sala" (no chequea);
 *     una sala ajena, archivada o de otra sede → error explícito.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { installQueryCounter } = await import("@/tests/helpers/query-counter");
  return { ...actual, ...installQueryCounter() };
});

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { classifyBookingInstant, getAgendaAvailability } from "@/lib/availability-actions";
import { BAD_ROOM_ERROR } from "@/lib/bookings-constants";
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

const RUN = process.env.INTEGRATION === "1";
const ar = (local: string) => new Date(`${local}:00-03:00`);
const iso = (local: string) => `${local}:00-03:00`;

describe.skipIf(!RUN)("disponibilidad de la agenda con sala (SR3a)", () => {
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
        ...week.map((dow) => ({ tenantId: T.tenantId, practitionerId: T.practitionerId, locationId: L1, roomId: R1, dow, startMin: 540, endMin: 660 })),
        ...week.map((dow) => ({ tenantId: T.tenantId, practitionerId: T.practitionerId, locationId: L1, roomId: R2, dow, startMin: 660, endMin: 780 })),
        ...week.map((dow) => ({ tenantId: T.tenantId, practitionerId: T.practitionerId, locationId: L2, roomId: R3, dow, startMin: 840, endMin: 1080 })),
        ...week.map((dow) => ({ tenantId: T.tenantId, practitionerId: B.practitionerId, locationId: L1, roomId: R1, dow, startMin: 540, endMin: 780 })),
        ...week.map((dow) => ({ tenantId: T.tenantId, practitionerId: C.practitionerId, locationId: L1, dow, startMin: 540, endMin: 1080 })),
      ],
    });
    // Bloqueo de sala el 03/11 y uno de profesional (C) el mismo día.
    await db.timeBlock.create({
      data: {
        tenantId: T.tenantId,
        locationId: L1,
        roomId: R2,
        practitionerId: null,
        startsAt: ar("2027-11-03T11:00"),
        endsAt: ar("2027-11-03T13:00"),
        reason: "Mantenimiento",
        createdById: T.userId,
      },
    });
    await db.timeBlock.create({
      data: {
        tenantId: T.tenantId,
        practitionerId: C.practitionerId,
        startsAt: ar("2027-11-03T15:00"),
        endsAt: ar("2027-11-03T16:00"),
        reason: "Trámite",
        createdById: T.userId,
      },
    });
  });

  beforeEach(() => asUser(T.userId));

  afterAll(async () => {
    await T?.cleanup();
    await U?.cleanup();
    await db?.$disconnect();
  });

  async function mk(o: { prac?: string; when: Date; room?: string | null; loc?: string | null }) {
    const patientId = await addPatient(db, T);
    return db.booking.create({
      data: {
        tenantId: T.tenantId,
        practitionerId: o.prac ?? T.practitionerId,
        serviceId: svc,
        patientId,
        scheduledFor: o.when,
        durationMin: 45,
        status: "CONFIRMED",
        locationId: o.loc === undefined ? L1 : o.loc,
        roomId: o.room ?? null,
        idempotencyKey: randomUUID(),
      },
    });
  }

  describe("getAgendaAvailability", () => {
    it("roomAssignments por día (franjas crudas con sala) y roomBlocks aparte de blocks", async () => {
      const r = await getAgendaAvailability({ from: "2027-11-03", to: "2027-11-03" });
      if (!r.ok) throw new Error(r.error);
      const day = r.data.days[0];
      expect(day.dayKey).toBe("2027-11-03");
      // Orden del contrato: (startMin, practitionerId).
      const r1 = [
        { practitionerId: T.practitionerId, startMin: 540, endMin: 660 },
        { practitionerId: B.practitionerId, startMin: 540, endMin: 780 },
      ].sort((a, b) => a.practitionerId.localeCompare(b.practitionerId));
      expect(day.roomAssignments).toEqual({
        [R1]: r1,
        [R2]: [{ practitionerId: T.practitionerId, startMin: 660, endMin: 780 }],
        [R3]: [{ practitionerId: T.practitionerId, startMin: 840, endMin: 1080 }],
      });
      expect(r.data.roomBlocks).toEqual([
        {
          id: expect.any(String),
          roomId: R2,
          startsAt: ar("2027-11-03T11:00").toISOString(),
          endsAt: ar("2027-11-03T13:00").toISOString(),
          reason: "Mantenimiento",
        },
      ]);
      // El bloqueo de sala no es de "todos": no está en `blocks` ni cierra el día
      // de nadie (A atiende en el Consultorio 2 a esa hora y su día sigue abierto).
      expect(r.data.blocks.map((b) => b.reason)).toEqual(["Trámite"]);
      expect(day.byPractitioner[T.practitionerId].dayLockState.status).toBe("open");
    });

    it("con sede: solo las salas y bloqueos de esa sede", async () => {
      const r = await getAgendaAvailability({ from: "2027-11-03", to: "2027-11-03", locationId: L2 });
      if (!r.ok) throw new Error(r.error);
      expect(Object.keys(r.data.days[0].roomAssignments ?? {})).toEqual([R3]);
      expect(r.data.roomBlocks ?? []).toEqual([]);
    });

    it("tenant sin salas: sin roomAssignments ni roomBlocks (la agenda se ve igual que hoy)", async () => {
      asUser(U.userId);
      const r = await getAgendaAvailability({ from: "2027-11-03", to: "2027-11-03" });
      if (!r.ok) throw new Error(r.error);
      expect(r.data.days[0].roomAssignments ?? {}).toEqual({});
      expect(r.data.roomBlocks ?? []).toEqual([]);
    });

    it("sin sentencias nuevas: un día con salas y bloqueo de sala cuesta lo mismo que un día sin nada", async () => {
      // Mismo tenant (la cantidad de sentencias del loader depende de los datos
      // del consultorio, no de las salas): miércoles con salas + bloqueo de sala
      // contra sábado sin franjas ni bloqueos.
      const withRooms = await measure(() => getAgendaAvailability({ from: "2027-11-03", to: "2027-11-03" }));
      const without = await measure(() => getAgendaAvailability({ from: "2027-11-06", to: "2027-11-06" }));
      if (!without.result.ok) throw new Error("setup");
      expect(without.result.data.days[0].roomAssignments).toBeUndefined();
      expect(without.result.data.roomBlocks).toBeUndefined();
      expect(withRooms.m.statements).toBe(without.m.statements);
    });
  });

  describe("classifyBookingInstant", () => {
    const q = (o: { prac?: string; at: string; roomId?: string | null; locationId?: string; excludeBookingId?: string }) => ({
      practitionerId: o.prac ?? T.practitionerId,
      serviceId: svc,
      scheduledFor: iso(o.at),
      durationMin: 45,
      ...(o.roomId !== undefined ? { roomId: o.roomId } : {}),
      ...(o.locationId ? { locationId: o.locationId } : {}),
      ...(o.excludeBookingId ? { excludeBookingId: o.excludeBookingId } : {}),
    });

    it("defaultRoomId de la franja; libre → roomBusy null", async () => {
      const r = await classifyBookingInstant(q({ at: "2027-11-08T10:00" }));
      if (!r.ok) throw new Error(r.error);
      expect(r.data).toMatchObject({ class: "libre", defaultRoomId: R1, roomBusy: null });
      const n = await classifyBookingInstant(q({ at: "2027-11-08T15:00" }));
      if (!n.ok) throw new Error(n.error);
      expect(n.data.defaultRoomId).toBe(R3);
    });

    it("otro profesional en la sala por defecto → roomBusy; 'Sin sala' (null o '') no chequea; otra sala libre no", async () => {
      await mk({ prac: B.practitionerId, when: ar("2027-11-09T10:00"), room: R1 });
      const r = await classifyBookingInstant(q({ at: "2027-11-09T10:15" }));
      if (!r.ok) throw new Error(r.error);
      expect(r.data).toMatchObject({ defaultRoomId: R1, roomBusy: { roomName: "Consultorio 1", blocked: null } });
      for (const roomId of [null, ""]) {
        const s = await classifyBookingInstant(q({ at: "2027-11-09T10:15", roomId }));
        if (!s.ok) throw new Error(s.error);
        expect(s.data).toMatchObject({ defaultRoomId: R1, roomBusy: null });
      }
      const other = await classifyBookingInstant(q({ at: "2027-11-09T10:15", roomId: R2 }));
      if (!other.ok) throw new Error(other.error);
      expect(other.data.roomBusy).toBeNull();
    });

    it("el mismo profesional no choca; el turno que se edita no cuenta contra sí mismo", async () => {
      const own = await mk({ when: ar("2027-11-10T10:00"), room: R1 });
      const r = await classifyBookingInstant(q({ at: "2027-11-10T10:00" }));
      if (!r.ok) throw new Error(r.error);
      expect(r.data.roomBusy).toBeNull();
      const theirs = await mk({ prac: B.practitionerId, when: ar("2027-11-10T12:00"), room: R1 });
      const e = await classifyBookingInstant(q({ prac: B.practitionerId, at: "2027-11-10T12:00", roomId: R1, excludeBookingId: theirs.id }));
      if (!e.ok) throw new Error(e.error);
      expect(e.data.roomBusy).toBeNull();
      expect(own.id).toBeTruthy();
    });

    it("bloqueo de sala → roomBusy con el motivo (no es `blocked` de profesional)", async () => {
      const r = await classifyBookingInstant(q({ at: "2027-11-03T11:30" }));
      if (!r.ok) throw new Error(r.error);
      expect(r.data).toMatchObject({
        blocked: false,
        defaultRoomId: R2,
        roomBusy: { roomName: "Consultorio 2", blocked: { reason: "Mantenimiento" } },
      });
    });

    it("franja sin sala → defaultRoomId null y roomBusy null, sin sentencias nuevas", async () => {
      const r = await classifyBookingInstant(q({ prac: C.practitionerId, at: "2027-11-11T10:00" }));
      if (!r.ok) throw new Error(r.error);
      expect(r.data).toMatchObject({ defaultRoomId: null, roomBusy: null });
      const noRoom = await measure(() => classifyBookingInstant(q({ prac: C.practitionerId, at: "2027-11-11T10:00" })));
      const explicitNone = await measure(() => classifyBookingInstant(q({ at: "2027-11-11T10:00", roomId: null })));
      const withRoom = await measure(() => classifyBookingInstant(q({ at: "2027-11-11T10:00" })));
      expect(explicitNone.m.statements).toBe(noRoom.m.statements);
      expect(withRoom.m.statements).toBe(noRoom.m.statements + 2);
    });

    it("sala elegida ajena, archivada o de otra sede → BAD_ROOM_ERROR", async () => {
      for (const roomId of [RForeign, RArch, R3]) {
        expect(await classifyBookingInstant(q({ at: "2027-11-12T10:00", roomId }))).toEqual({ ok: false, error: BAD_ROOM_ERROR });
      }
    });
  });
});
