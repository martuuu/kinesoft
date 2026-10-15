/**
 * PL-2f · salas y Sala de Espera por plan (C-PL1, plan §20.5.2; PL-D6 / PL-D7) contra Postgres real, en los dos
 * roles (`test:integration` = kinesoft_app con RLS; `:owner` = BYPASSRLS como prod).
 *
 * Un consultorio en plan Consultorio (sin los módulos `salas` / `salaEspera`) que TIENE datos de salas cargados
 * cuando era Clínica (sala, franjas con sala, turnos con sala). Lo que se fija:
 *   - CRUD de salas → 403 con el copy de upsell, sin escribir; las lecturas dan `[]`;
 *   - sala ELEGIDA en un alta, un lote, una edición, una franja, una excepción o un bloqueo → 403 sin escribir;
 *   - las salas «duermen»: la sala de la franja no se estampa, no hay «sala ocupada», y lo que ya tenía sala la
 *     conserva (editar notas, mover el horario, guardar la semana) — datos intactos para cuando vuelva a Clínica;
 *   - «Llamar» → 403 (Sala de Espera); «Llegó» sigue andando (núcleo); token realtime → 403.
 * Clínica sin cambios: lo cubren las suites SR/SV (sus tenants nacen `saasPlan: "CLINICA"`).
 *
 * Símbolos reales; se mockean la sesión (helper `asUser`) y `next/cache` (setup de integración). Fixtures por
 * owner. Fechas en nov 2027 (lun = 2027-11-01).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { createBooking, createBookingsBatch, markReceptionAction, updateBooking } from "@/lib/bookings";
import { archiveRoom, createRoom, listRoomOptions, listRooms, restoreRoom, updateRoom } from "@/lib/rooms";
import { savePractitionerWeek, upsertException } from "@/lib/practitioner-schedule";
import { createTimeBlock, listTimeBlocks } from "@/lib/time-blocks";
import { mintRealtimeToken } from "@/lib/realtime-token";
import { MODULE_DENIED_COPY } from "@/lib/tenant-modules";
import { toARDateKey } from "@/lib/datetime-ar";
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

const RUN = process.env.INTEGRATION === "1";
const SALAS = MODULE_DENIED_COPY.salas;

/** Pared AR → instante. */
const ar = (local: string) => new Date(`${local}:00-03:00`);

describe.skipIf(!RUN)("PL-2f · salas y Sala de Espera sin el plan Clínica", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let svc: string;
  let L1: string;
  let L2: string;
  let R1: string; // sala dormida (cargada en Clínica), capacidad 1
  let R2: string; // otra sala dormida de la misma sede
  let B: { userId: string; practitionerId: string };

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    T = await createEphemeralTenant(db, { saasPlan: "CONSULTORIO" });
    svc = (
      await db.service.create({
        data: { tenantId: T.tenantId, practitionerId: null, name: "Kine", durationMin: 45, priceCents: 0 },
      })
    ).id;
    L1 = (await db.location.create({ data: { tenantId: T.tenantId, name: "Centro", isPrimary: true } })).id;
    L2 = (await db.location.create({ data: { tenantId: T.tenantId, name: "Norte", sortOrder: 1 } })).id;
    R1 = (await addRoom(db, T, { locationId: L1, name: "Consultorio 1", capacity: 1 })).roomId;
    R2 = (await addRoom(db, T, { locationId: L1, name: "Consultorio 2", capacity: 1 })).roomId;
    B = await addPractitioner(db, T, "PRACTITIONER");
    const week = [1, 2, 3, 4, 5];
    // Los dos en el Consultorio 1 a la misma hora (lo que en Clínica sería «sala ocupada»).
    await db.practitionerSchedule.createMany({
      data: [T.practitionerId, B.practitionerId].flatMap((practitionerId) =>
        week.map((dow) => ({ tenantId: T.tenantId, practitionerId, locationId: L1, roomId: R1, dow, startMin: 540, endMin: 1080 }))
      ),
    });
  });

  beforeEach(() => asUser(T.userId));

  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });

  /** Turno cargado directo (owner), con la sede explícita si lleva sala. */
  async function mk(o: { prac?: string; when: Date; room?: string | null }) {
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
        locationId: L1,
        roomId: o.room ?? null,
        idempotencyKey: randomUUID(),
      },
    });
  }

  const roomOf = async (id: string) => (await db.booking.findUniqueOrThrow({ where: { id } })).roomId;

  it("CRUD de salas → 403 con el copy de upsell, sin escribir; las lecturas dan []", async () => {
    const before = await db.room.findMany({ where: { tenantId: T.tenantId }, orderBy: { id: "asc" } });
    await expect(createRoom({ locationId: L1, name: "Gimnasio" })).rejects.toThrow(SALAS);
    await expect(updateRoom({ id: R1, name: "Otro" })).rejects.toThrow(SALAS);
    await expect(archiveRoom({ id: R1 })).rejects.toThrow(SALAS);
    await expect(restoreRoom({ id: R1 })).rejects.toThrow(SALAS);
    expect(await db.room.findMany({ where: { tenantId: T.tenantId }, orderBy: { id: "asc" } })).toEqual(before);

    // Las salas existen (duermen), pero la agenda, `/sala` y Configuración no las ven.
    expect(await listRoomOptions()).toEqual([]);
    expect(await listRooms()).toEqual([]);
    expect(await listRooms({ includeArchived: true })).toEqual([]);
  });

  it("createBooking con sala elegida → 403 sin escribir; «Sin sala» (null) pasa", async () => {
    const patientId = await addPatient(db, T);
    const key = randomUUID();
    await expect(
      createBooking({
        patientId,
        serviceId: svc,
        practitionerId: T.practitionerId,
        scheduledFor: ar("2027-11-01T09:00").toISOString(),
        durationMin: 45,
        idempotencyKey: key,
        roomId: R1,
      })
    ).rejects.toThrow(SALAS);
    expect(await db.booking.findUnique({ where: { idempotencyKey: key } })).toBeNull();

    const key2 = randomUUID();
    const ok = await createBooking({
      patientId,
      serviceId: svc,
      practitionerId: T.practitionerId,
      scheduledFor: ar("2027-11-01T09:00").toISOString(),
      durationMin: 45,
      idempotencyKey: key2,
      roomId: null,
    });
    expect(ok).toMatchObject({ ok: true });
    expect(await db.booking.findUniqueOrThrow({ where: { idempotencyKey: key2 } })).toMatchObject({ roomId: null });
  });

  it("la sala de la franja se ignora: sin estampar y sin «sala ocupada» aunque otro profesional la tenga", async () => {
    // B está en el Consultorio 1 (capacidad 1) a las 10: en Clínica esto es room-busy.
    await mk({ prac: B.practitionerId, when: ar("2027-11-02T10:00"), room: R1 });
    const patientId = await addPatient(db, T);
    const key = randomUUID();
    const r = await createBooking({
      patientId,
      serviceId: svc,
      practitionerId: T.practitionerId,
      scheduledFor: ar("2027-11-02T10:00").toISOString(),
      durationMin: 45,
      idempotencyKey: key,
    });
    expect(r).toMatchObject({ ok: true });
    expect(r).not.toHaveProperty("roomBusy");
    const row = await db.booking.findUniqueOrThrow({ where: { idempotencyKey: key } });
    expect(row).toMatchObject({ roomId: null, isOverbooked: false });
  });

  it("createBookingsBatch con sala elegida → 403 sin escribir (ni el preflight)", async () => {
    const patientId = await addPatient(db, T);
    const base = {
      patientId,
      serviceId: svc,
      practitionerId: T.practitionerId,
      scheduledFor: ar("2027-11-03T09:00").toISOString(),
      durationMin: 45,
      count: 2,
      roomId: R1,
    };
    await expect(createBookingsBatch({ ...base, dryRun: true })).rejects.toThrow(SALAS);
    await expect(createBookingsBatch({ ...base, idempotencyKey: randomUUID() })).rejects.toThrow(SALAS);
    expect(await db.booking.count({ where: { tenantId: T.tenantId, patientId } })).toBe(0);

    // Sin elegir: la sala de la franja no se estampa en ninguna fecha.
    const { roomId: _r, ...noRoom } = base;
    void _r;
    const run = await createBookingsBatch({ ...noRoom, idempotencyKey: randomUUID() });
    if (!run.ok) throw new Error(run.error);
    expect(run.data).toMatchObject({ created: 2 });
    const rows = await db.booking.findMany({ where: { tenantId: T.tenantId, patientId } });
    expect(rows.map((b) => b.roomId)).toEqual([null, null]);
  });

  it("edición: la sala dormida se conserva (notas, mover de hora); otra sala → 403; cambiar de sede la suelta", async () => {
    const b = await mk({ when: ar("2027-11-04T09:00"), room: R1 });
    // B ocupa el Consultorio 1 a las 11: mover ahí no da room-busy (la sala duerme).
    await mk({ prac: B.practitionerId, when: ar("2027-11-04T11:00"), room: R1 });

    // El drawer reenvía la sala que ya tenía al guardar notas.
    expect(await updateBooking({ id: b.id, roomId: R1, notes: "control" })).toMatchObject({ ok: true });
    expect(await roomOf(b.id)).toBe(R1);

    const moved = await updateBooking({ id: b.id, scheduledFor: ar("2027-11-04T11:00").toISOString() });
    expect(moved).toMatchObject({ ok: true });
    expect(moved).not.toHaveProperty("roomBusy");
    expect(await db.booking.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({
      roomId: R1,
      locationId: L1,
      scheduledFor: ar("2027-11-04T11:00"),
    });

    const before = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    await expect(updateBooking({ id: b.id, roomId: R2 })).rejects.toThrow(SALAS);
    expect(await db.booking.findUniqueOrThrow({ where: { id: b.id } })).toEqual(before);

    // Otra sede: la FK compuesta (roomId, locationId) no admite la sala vieja → queda sin sala (sin 23503).
    expect(await updateBooking({ id: b.id, locationId: L2, allowOutOfHours: true })).toMatchObject({ ok: true });
    expect(await db.booking.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({ roomId: null, locationId: L2 });
  });

  it("Recepción: «Llamar» → 403 sin escribir; «Llegó» (núcleo) anda; token realtime → 403", async () => {
    const now = new Date();
    // Un turno de hoy AR, empezando ahora (redondeado al minuto).
    const b = await mk({ when: new Date(Math.floor(now.getTime() / 60_000) * 60_000) });
    expect(toARDateKey(b.scheduledFor)).toBe(toARDateKey(now));

    const llego = await markReceptionAction(b.id, "llego", b.updatedAt.toISOString());
    expect(llego).toMatchObject({ ok: true });
    if (!llego.ok) return;
    const arrived = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(arrived.arrivedAt).not.toBeNull();

    expect(await markReceptionAction(b.id, "llamar", llego.data.updatedAt)).toEqual({
      ok: false,
      error: MODULE_DENIED_COPY.salaEspera,
    });
    expect(await db.booking.findUniqueOrThrow({ where: { id: b.id } })).toEqual(arrived);

    // «En atención» también es núcleo.
    expect(await markReceptionAction(b.id, "en-atencion", llego.data.updatedAt)).toMatchObject({ ok: true });

    expect(await mintRealtimeToken()).toEqual({ ok: false, error: MODULE_DENIED_COPY.salaEspera });
  });

  it("horarios: sala nueva en una franja → 403 sin escribir; la dormida se conserva; cambiar la sede la suelta", async () => {
    const rows = () =>
      db.practitionerSchedule.findMany({
        where: { tenantId: T.tenantId, practitionerId: B.practitionerId },
        orderBy: [{ dow: "asc" }, { startMin: "asc" }],
        select: { dow: true, startMin: true, endMin: true, locationId: true, roomId: true },
      });
    const before = await rows();

    await expect(
      savePractitionerWeek(B.practitionerId, [{ dow: 1, startMin: 540, endMin: 780, locationId: L1, roomId: R2 }])
    ).rejects.toThrow(SALAS);
    expect(await rows()).toEqual(before);

    // El editor (sin selector de sala) reenvía la sala que la franja ya tenía: se guarda tal cual, sin validar
    // choques contra el titular (que en Clínica serían un error duro de capacidad).
    const ok = await savePractitionerWeek(B.practitionerId, [
      { dow: 1, startMin: 540, endMin: 780, locationId: L1, roomId: R1 },
      { dow: 2, startMin: 540, endMin: 780, locationId: L2, roomId: R1 },
      { dow: 3, startMin: 540, endMin: 780, locationId: L1 },
    ]);
    expect(ok).toMatchObject({ ok: true });
    expect(await rows()).toEqual([
      { dow: 1, startMin: 540, endMin: 780, locationId: L1, roomId: R1 },
      { dow: 2, startMin: 540, endMin: 780, locationId: L2, roomId: null },
      { dow: 3, startMin: 540, endMin: 780, locationId: L1, roomId: null },
    ]);
  });

  it("excepciones: sala nueva → 403 sin escribir; la que la excepción ya tenía se conserva", async () => {
    const date = new Date("2027-11-08T00:00:00Z");
    await expect(
      upsertException({
        practitionerId: B.practitionerId,
        date: "2027-11-08",
        kind: "CUSTOM_HOURS",
        ranges: [{ startMin: 540, endMin: 600, locationId: L1, roomId: R1 }],
      })
    ).rejects.toThrow(SALAS);
    await expect(
      upsertException({
        practitionerId: null,
        date: "2027-11-08",
        kind: "CUSTOM_HOURS",
        ranges: [{ startMin: 540, endMin: 600, locationId: L1, roomId: R1 }],
      })
    ).rejects.toThrow(SALAS);
    expect(await db.scheduleException.count({ where: { tenantId: T.tenantId, date } })).toBe(0);

    // Excepción cargada en Clínica (directo), editada sin el módulo reenviando su sala.
    await db.scheduleException.create({
      data: {
        tenantId: T.tenantId,
        practitionerId: B.practitionerId,
        date,
        kind: "CUSTOM_HOURS",
        ranges: [{ startMin: 540, endMin: 600, locationId: L1, roomId: R1 }],
        createdById: T.userId,
      },
    });
    const r = await upsertException({
      practitionerId: B.practitionerId,
      date: "2027-11-08",
      kind: "CUSTOM_HOURS",
      ranges: [{ startMin: 540, endMin: 660, locationId: L1, roomId: R1 }],
      reason: "Más largo",
    });
    expect(r).toMatchObject({ ok: true });
    const exc = await db.scheduleException.findFirstOrThrow({ where: { tenantId: T.tenantId, date } });
    expect(exc.ranges).toEqual([{ startMin: 540, endMin: 660, locationId: L1, roomId: R1 }]);
  });

  it("bloqueo de sala → 403 sin escribir; leer bloqueos de sala da []", async () => {
    await expect(
      createTimeBlock({
        roomId: R1,
        startsAt: ar("2027-11-05T09:00").toISOString(),
        endsAt: ar("2027-11-05T13:00").toISOString(),
        reason: "Pintura",
      })
    ).rejects.toThrow(SALAS);
    expect(await db.timeBlock.count({ where: { tenantId: T.tenantId, roomId: R1 } })).toBe(0);

    // Un bloqueo de sala de cuando era Clínica: duerme (no se lista ni bloquea a nadie).
    await db.timeBlock.create({
      data: {
        tenantId: T.tenantId,
        roomId: R1,
        locationId: L1,
        startsAt: ar("2027-11-05T09:00"),
        endsAt: ar("2027-11-05T13:00"),
        createdById: T.userId,
      },
    });
    expect(await listTimeBlocks({ from: "2027-11-05", to: "2027-11-05", roomIds: [R1] })).toEqual({ ok: true, data: [] });
    const patientId = await addPatient(db, T);
    const key = randomUUID();
    const r = await createBooking({
      patientId,
      serviceId: svc,
      practitionerId: T.practitionerId,
      scheduledFor: ar("2027-11-05T10:00").toISOString(),
      durationMin: 45,
      idempotencyKey: key,
    });
    expect(r).toMatchObject({ ok: true });
    expect(r).not.toHaveProperty("roomBusy");
    expect(await db.booking.findUniqueOrThrow({ where: { idempotencyKey: key } })).toMatchObject({ roomId: null });
  });
});
