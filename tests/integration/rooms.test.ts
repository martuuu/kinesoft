/**
 * SR1b · CRUD de salas (`lib/rooms.ts`) contra la DB real, en los dos roles
 * (`kinesoft_app` con RLS y owner BYPASSRLS = prod).
 *
 * Lo que se protege:
 *   • authz: escribir exige `schedule.configure` (OWNER/ADMIN); leer las salas
 *     ACTIVAS puede cualquier miembro (la agenda las necesita en todos los
 *     roles); `includeArchived` exige `schedule.configure`;
 *   • IDOR: sede / sala de OTRO tenant → rechazo y ninguna fila escrita. Las FK
 *     compuestas de M4 frenan una sala de B en una sede de A, pero el `where
 *     tenantId` a mano es la barrera que da el error legible (y la única en
 *     owner para los updates por id);
 *   • SR-D9: nombre único por sede entre activas (índice parcial) → error en
 *     `fieldErrors.name`, también con dos altas en carrera;
 *   • SR-D8: archivar se niega con conteos (franjas vigentes, turnos futuros,
 *     excepciones futuras); sin bloqueantes archiva y soft-borra los bloqueos
 *     FUTUROS de la sala en la misma tx (§17.5);
 *   • restaurar con el nombre tomado → error de nombre; sede archivada → error.
 * Cada caso afirma el efecto observable en la base, no solo el `ok`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { listRooms, listRoomOptions, createRoom, updateRoom, archiveRoom, restoreRoom } from "@/lib/rooms";
import { ROOM_NAME_TAKEN_ERROR } from "@/lib/rooms-constants";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  addPatient,
  addRoom,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";
const FORBIDDEN = "Solo OWNER/ADMIN pueden configurar las salas.";
const DAY = 86_400_000;

describe.skipIf(!RUN)("salas: CRUD (SR1b)", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let prac: { userId: string; practitionerId: string };
  let asst: { userId: string; practitionerId: string };
  let locA1: string; // principal de A
  let locA2: string;
  let locB: string;
  let roomB: string;

  async function mustCreate(locationId: string, name: string, extra: { capacity?: number } = {}): Promise<string> {
    const r = await createRoom({ locationId, name, ...extra });
    if (!r.ok) throw new Error(`${r.error} ${JSON.stringify(r.fieldErrors)}`);
    return r.data.id;
  }

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
    prac = await addPractitioner(db, A, "PRACTITIONER");
    asst = await addPractitioner(db, A, "ASSISTANT");
    locA1 = (await db.location.create({ data: { tenantId: A.tenantId, name: "Centro", isPrimary: true } })).id;
    locA2 = (await db.location.create({ data: { tenantId: A.tenantId, name: "Palermo", sortOrder: 1 } })).id;
    ({ roomId: roomB, locationId: locB } = await addRoom(db, B, { name: "Consultorio B" }));
  });

  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await db?.$disconnect();
  });

  it("tenant sin salas: listRooms y listRoomOptions → [] sin error", async () => {
    asUser(A.userId);
    expect(await listRooms()).toEqual([]);
    expect(await listRooms({ includeArchived: true })).toEqual([]);
    expect(await listRoomOptions()).toEqual([]);
  });

  it("CRUD feliz: crea (sortOrder al final de la sede), edita, lista con scheduleCount y audita", async () => {
    asUser(A.userId);
    const c1 = await mustCreate(locA1, "  Consultorio 1 ");
    const c2 = await mustCreate(locA1, "Gimnasio", { capacity: 4 });
    const p1 = await mustCreate(locA2, "Consultorio 1"); // mismo nombre, otra sede: permitido

    const rows = await db.room.findMany({ where: { tenantId: A.tenantId }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.id, r.locationId, r.name, r.kind, r.capacity, r.active, r.sortOrder])).toEqual([
      [c1, locA1, "Consultorio 1", "CONSULTORIO", 1, true, 0],
      [c2, locA1, "Gimnasio", "CONSULTORIO", 4, true, 1],
      [p1, locA2, "Consultorio 1", "CONSULTORIO", 1, true, 0],
    ]);

    const u = await updateRoom({ id: c2, kind: "GIMNASIO", capacity: "6" as unknown as number });
    expect(u).toEqual({ ok: true, data: undefined });
    const c2row = await db.room.findUniqueOrThrow({ where: { id: c2 } });
    expect([c2row.kind, c2row.capacity, c2row.name, c2row.locationId]).toEqual(["GIMNASIO", 6, "Gimnasio", locA1]);

    // scheduleCount = franjas VIGENTES con la sala (una vencida no cuenta).
    await db.practitionerSchedule.createMany({
      data: [
        { tenantId: A.tenantId, practitionerId: prac.practitionerId, locationId: locA1, roomId: c1, dow: 1, startMin: 480, endMin: 720 },
        { tenantId: A.tenantId, practitionerId: prac.practitionerId, locationId: locA1, roomId: c1, dow: 2, startMin: 480, endMin: 720 },
        {
          tenantId: A.tenantId,
          practitionerId: prac.practitionerId,
          locationId: locA1,
          roomId: c1,
          dow: 3,
          startMin: 480,
          endMin: 720,
          validUntil: new Date("2020-01-31T00:00:00Z"),
        },
      ],
    });

    const list = await listRooms();
    expect(list).toEqual([
      { id: c1, locationId: locA1, name: "Consultorio 1", kind: "CONSULTORIO", capacity: 1, active: true, sortOrder: 0, scheduleCount: 2 },
      { id: c2, locationId: locA1, name: "Gimnasio", kind: "GIMNASIO", capacity: 6, active: true, sortOrder: 1, scheduleCount: 0 },
      { id: p1, locationId: locA2, name: "Consultorio 1", kind: "CONSULTORIO", capacity: 1, active: true, sortOrder: 0, scheduleCount: 0 },
    ]);
    expect((await listRooms({ locationId: locA2 })).map((r) => r.id)).toEqual([p1]);
    expect(await listRoomOptions()).toEqual([
      { id: c1, locationId: locA1, name: "Consultorio 1", kind: "CONSULTORIO", capacity: 1 },
      { id: c2, locationId: locA1, name: "Gimnasio", kind: "GIMNASIO", capacity: 6 },
      { id: p1, locationId: locA2, name: "Consultorio 1", kind: "CONSULTORIO", capacity: 1 },
    ]);

    // [PL-A2] Salas = configuración operativa (como sedes): sin AuditEvent (§20.5.9).
    expect(await db.auditEvent.count({ where: { tenantId: A.tenantId, entity: "Room" } })).toBe(0);
  });

  it("PRACTITIONER y ASSISTANT: leen las activas; escrituras e includeArchived rechazados sin escribir", async () => {
    asUser(A.userId);
    const [some] = await listRooms();
    const before = await db.room.findMany({ where: { tenantId: A.tenantId }, orderBy: { id: "asc" } });

    for (const u of [prac, asst]) {
      asUser(u.userId);
      expect((await listRooms()).map((r) => r.id).sort()).toEqual(before.filter((r) => r.active).map((r) => r.id).sort());
      expect((await listRoomOptions()).length).toBe(before.filter((r) => r.active).length);
      await expect(listRooms({ includeArchived: true })).rejects.toThrow(FORBIDDEN);
      await expect(createRoom({ locationId: locA1, name: "Intrusa" })).rejects.toThrow(FORBIDDEN);
      await expect(updateRoom({ id: some.id, name: "Intrusa" })).rejects.toThrow(FORBIDDEN);
      await expect(archiveRoom({ id: some.id })).rejects.toThrow(FORBIDDEN);
      await expect(restoreRoom({ id: some.id })).rejects.toThrow(FORBIDDEN);
    }

    const after = await db.room.findMany({ where: { tenantId: A.tenantId }, orderBy: { id: "asc" } });
    expect(after).toEqual(before);
  });

  it("cross-tenant: sede, sala e id de otro tenant → rechazo y ninguna fila escrita", async () => {
    asUser(A.userId);
    const beforeA = await db.room.count({ where: { tenantId: A.tenantId } });
    const roomBBefore = await db.room.findUniqueOrThrow({ where: { id: roomB } });

    const crossLoc = await createRoom({ locationId: locB, name: "En sede ajena" });
    expect(crossLoc.ok).toBe(false);
    if (!crossLoc.ok) expect(crossLoc.fieldErrors).toEqual({ locationId: ["La sede no existe o está archivada."] });

    expect(await updateRoom({ id: roomB, name: "Hackeada" })).toEqual({ ok: false, error: "Sala no encontrada." });
    expect(await archiveRoom({ id: roomB })).toEqual({ ok: false, error: "Sala no encontrada." });
    expect(await restoreRoom({ id: roomB })).toEqual({ ok: false, error: "Sala no encontrada." });
    expect(await listRooms({ locationId: locB })).toEqual([]);
    expect((await listRooms()).map((r) => r.id)).not.toContain(roomB);

    expect(await db.room.count({ where: { tenantId: A.tenantId } })).toBe(beforeA);
    expect(await db.room.count({ where: { locationId: locB } })).toBe(1);
    expect(await db.room.findUniqueOrThrow({ where: { id: roomB } })).toEqual(roomBBefore);
    expect(await db.auditEvent.count({ where: { tenantId: B.tenantId, entity: "Room" } })).toBe(0);
  });

  it("sede archivada → rechazo del alta en fieldErrors.locationId", async () => {
    asUser(A.userId);
    const arch = (await db.location.create({ data: { tenantId: A.tenantId, name: "Vieja", active: false } })).id;
    const r = await createRoom({ locationId: arch, name: "X" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fieldErrors).toEqual({ locationId: ["La sede no existe o está archivada."] });
    expect(await db.room.count({ where: { locationId: arch } })).toBe(0);
  });

  it("nombre repetido en la misma sede (sin mayúsculas ni bordes) → fieldErrors.name; en otra sede, permitido", async () => {
    asUser(A.userId);
    const before = await db.room.count({ where: { tenantId: A.tenantId } });
    const dup = await createRoom({ locationId: locA1, name: " consultorio 1  " });
    expect(dup).toEqual({ ok: false, error: ROOM_NAME_TAKEN_ERROR, fieldErrors: { name: [ROOM_NAME_TAKEN_ERROR] } });

    // Renombrar a un nombre tomado también.
    const gym = (await db.room.findFirstOrThrow({ where: { tenantId: A.tenantId, name: "Gimnasio" } })).id;
    const ren = await updateRoom({ id: gym, name: "CONSULTORIO 1" });
    expect(ren).toEqual({ ok: false, error: ROOM_NAME_TAKEN_ERROR, fieldErrors: { name: [ROOM_NAME_TAKEN_ERROR] } });
    expect((await db.room.findUniqueOrThrow({ where: { id: gym } })).name).toBe("Gimnasio");

    const other = await createRoom({ locationId: locA2, name: "Gimnasio" });
    expect(other.ok).toBe(true);
    expect(await db.room.count({ where: { tenantId: A.tenantId } })).toBe(before + 1);
  });

  it("concurrencia: dos createRoom simultáneos con el mismo nombre → entra uno solo", async () => {
    asUser(A.userId);
    const results = await Promise.all([
      createRoom({ locationId: locA2, name: "Box Carrera" }),
      createRoom({ locationId: locA2, name: "box carrera" }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const loser = results.find((r) => !r.ok);
    expect(loser).toEqual({ ok: false, error: ROOM_NAME_TAKEN_ERROR, fieldErrors: { name: [ROOM_NAME_TAKEN_ERROR] } });
    const rows = await db.room.findMany({ where: { tenantId: A.tenantId, locationId: locA2 } });
    expect(rows.filter((r) => r.name.toLowerCase() === "box carrera")).toHaveLength(1);
  });

  it("archiveRoom (SR-D8): bloqueado con conteos de franja, turno futuro y excepción; nada cambia", async () => {
    asUser(A.userId);
    const { roomId } = await addRoom(db, A, { locationId: locA1, name: "Bloqueada" });
    const now = Date.now();
    const patientId = await addPatient(db, A);
    const svc = () => ({
      tenantId: A.tenantId,
      patientId,
      practitionerId: prac.practitionerId,
      serviceId: A.serviceId,
      durationMin: 45,
      idempotencyKey: `test-${uniqueSuffix()}`,
    });

    await db.practitionerSchedule.createMany({
      data: [
        // vigente sin fin
        { tenantId: A.tenantId, practitionerId: prac.practitionerId, locationId: locA1, roomId, dow: 4, startMin: 480, endMin: 600 },
        // vigente con fin futuro
        {
          tenantId: A.tenantId,
          practitionerId: prac.practitionerId,
          locationId: locA1,
          roomId,
          dow: 5,
          startMin: 480,
          endMin: 600,
          validUntil: new Date("2099-12-31T00:00:00Z"),
        },
        // vencida: no bloquea
        {
          tenantId: A.tenantId,
          practitionerId: prac.practitionerId,
          locationId: locA1,
          roomId,
          dow: 6,
          startMin: 480,
          endMin: 600,
          validUntil: new Date("2020-01-01T00:00:00Z"),
        },
      ],
    });
    await db.booking.createMany({
      data: [
        { ...svc(), roomId, locationId: locA1, scheduledFor: new Date(now + 3 * DAY) }, // futuro: bloquea
        { ...svc(), roomId, locationId: locA1, scheduledFor: new Date(now + 4 * DAY), status: "CANCELLED" }, // cancelado: no
        { ...svc(), roomId, locationId: locA1, scheduledFor: new Date(now - 3 * DAY) }, // pasado: no
      ],
    });
    await db.scheduleException.createMany({
      data: [
        {
          tenantId: A.tenantId,
          practitionerId: prac.practitionerId,
          date: new Date(new Date(now + 10 * DAY).toISOString().slice(0, 10) + "T00:00:00Z"),
          kind: "CUSTOM_HOURS",
          ranges: [{ startMin: 540, endMin: 720, locationId: locA1, roomId }],
          createdById: A.userId,
        },
        {
          // pasada: no bloquea
          tenantId: A.tenantId,
          practitionerId: null,
          date: new Date("2020-02-03T00:00:00Z"),
          kind: "CUSTOM_HOURS",
          ranges: [{ startMin: 540, endMin: 720, locationId: locA1, roomId }],
          createdById: A.userId,
        },
        {
          // futura pero de OTRA sala: no cuenta
          tenantId: A.tenantId,
          practitionerId: null,
          date: new Date(new Date(now + 11 * DAY).toISOString().slice(0, 10) + "T00:00:00Z"),
          kind: "CUSTOM_HOURS",
          ranges: [{ startMin: 540, endMin: 720, locationId: locA1 }],
          createdById: A.userId,
        },
      ],
    });
    const blockId = (
      await db.timeBlock.create({
        data: {
          tenantId: A.tenantId,
          locationId: locA1,
          roomId,
          startsAt: new Date(now + 5 * DAY),
          endsAt: new Date(now + 5 * DAY + 3_600_000),
          createdById: A.userId,
        },
      })
    ).id;

    const r = await archiveRoom({ id: roomId });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.blockers).toEqual({ activeSchedules: 2, futureBookings: 1, futureExceptions: 1 });
      expect(r.error).toBe(
        "No se puede archivar: la sala todavía tiene 2 franjas de horario, 1 turno a futuro, 1 día con horario especial. Sacala de esos horarios y turnos primero."
      );
    }
    expect((await db.room.findUniqueOrThrow({ where: { id: roomId } })).active).toBe(true);
    expect((await db.timeBlock.findUniqueOrThrow({ where: { id: blockId } })).deletedAt).toBeNull();
    expect(await db.auditEvent.count({ where: { tenantId: A.tenantId, action: "room.archive", entityId: roomId } })).toBe(0);
  });

  it("archiveRoom sin bloqueantes: archiva, soft-borra los bloqueos futuros (no los pasados ni los de otra sala), sin audit; restore", async () => {
    asUser(A.userId);
    const { roomId } = await addRoom(db, A, { locationId: locA1, name: "Archivable" });
    const { roomId: otherRoom } = await addRoom(db, A, { locationId: locA1, name: "Vecina" });
    const now = Date.now();
    const mk = (room: string, start: number, end: number) =>
      db.timeBlock.create({
        data: {
          tenantId: A.tenantId,
          locationId: locA1,
          roomId: room,
          startsAt: new Date(start),
          endsAt: new Date(end),
          reason: "Mantenimiento",
          createdById: A.userId,
        },
      });
    const future = await mk(roomId, now + 2 * DAY, now + 2 * DAY + 3_600_000);
    const ongoing = await mk(roomId, now - 3_600_000, now + 3_600_000);
    const past = await mk(roomId, now - 2 * DAY, now - 2 * DAY + 3_600_000);
    const neighbor = await mk(otherRoom, now + 2 * DAY, now + 2 * DAY + 3_600_000);
    // Turno pasado en la sala: no bloquea (es historia).
    const patientId = await addPatient(db, A);
    await db.booking.create({
      data: {
        tenantId: A.tenantId,
        patientId,
        practitionerId: prac.practitionerId,
        serviceId: A.serviceId,
        durationMin: 45,
        idempotencyKey: `test-${uniqueSuffix()}`,
        roomId,
        locationId: locA1,
        scheduledFor: new Date(now - DAY),
      },
    });

    expect(await archiveRoom({ id: roomId })).toEqual({ ok: true, data: undefined });
    expect((await db.room.findUniqueOrThrow({ where: { id: roomId } })).active).toBe(false);
    const blocks = await db.timeBlock.findMany({
      where: { id: { in: [future.id, ongoing.id, past.id, neighbor.id] } },
      select: { id: true, deletedAt: true },
    });
    const deleted = Object.fromEntries(blocks.map((b) => [b.id, b.deletedAt !== null]));
    expect(deleted).toEqual({ [future.id]: true, [ongoing.id]: true, [past.id]: false, [neighbor.id]: false });

    // Archivada: fuera de las activas; visible con includeArchived (OWNER).
    expect((await listRooms()).map((r) => r.id)).not.toContain(roomId);
    expect((await listRoomOptions()).map((r) => r.id)).not.toContain(roomId);
    const all = await listRooms({ includeArchived: true });
    expect(all.find((r) => r.id === roomId)).toMatchObject({ active: false, name: "Archivable" });

    // Idempotente.
    expect(await archiveRoom({ id: roomId })).toEqual({ ok: true, data: undefined });

    // Restore feliz.
    expect(await restoreRoom({ id: roomId })).toEqual({ ok: true, data: undefined });
    expect((await db.room.findUniqueOrThrow({ where: { id: roomId } })).active).toBe(true);
    // [PL-A2] sin audit en archivar/restaurar (§20.5.9).
    expect(await db.auditEvent.count({ where: { tenantId: A.tenantId, entity: "Room", entityId: roomId } })).toBe(0);
    // Los bloqueos borrados no vuelven.
    expect((await db.timeBlock.findUniqueOrThrow({ where: { id: future.id } })).deletedAt).not.toBeNull();
  });

  it("restoreRoom: nombre tomado por otra activa → fieldErrors.name; sede archivada → error; nada cambia", async () => {
    asUser(A.userId);
    const old = await mustCreate(locA2, "Kinesio");
    expect((await archiveRoom({ id: old })).ok).toBe(true);
    await mustCreate(locA2, "KINESIO"); // la archivada liberó el nombre
    const r = await restoreRoom({ id: old });
    expect(r).toEqual({ ok: false, error: ROOM_NAME_TAKEN_ERROR, fieldErrors: { name: [ROOM_NAME_TAKEN_ERROR] } });
    expect((await db.room.findUniqueOrThrow({ where: { id: old } })).active).toBe(false);

    // Sede archivada.
    const locOld = (await db.location.create({ data: { tenantId: A.tenantId, name: "Cerrada" } })).id;
    const { roomId } = await addRoom(db, A, { locationId: locOld, name: "Box viejo", active: false });
    await db.location.update({ where: { id: locOld }, data: { active: false } });
    const r2 = await restoreRoom({ id: roomId });
    expect(r2).toEqual({ ok: false, error: "La sede de esta sala está archivada. Restaurá la sede primero." });
    expect((await db.room.findUniqueOrThrow({ where: { id: roomId } })).active).toBe(false);
  });

  it("listRoomOptions: excluye las salas de sedes archivadas", async () => {
    asUser(A.userId);
    const locGone = (await db.location.create({ data: { tenantId: A.tenantId, name: "Sede cerrada" } })).id;
    const { roomId } = await addRoom(db, A, { locationId: locGone, name: "Huérfana" });
    await db.location.update({ where: { id: locGone }, data: { active: false } });
    expect((await listRoomOptions()).map((r) => r.id)).not.toContain(roomId);
  });

  it("validación zod: id vacío, capacidad fuera de rango y update sin campos → error sin escribir", async () => {
    asUser(A.userId);
    const before = await db.room.count({ where: { tenantId: A.tenantId } });
    const cap = await createRoom({ locationId: locA1, name: "Grande", capacity: 51 });
    expect(cap.ok).toBe(false);
    if (!cap.ok) expect(Object.keys(cap.fieldErrors ?? {})).toEqual(["capacity"]);
    const empty = await updateRoom({ id: "x" } as never);
    expect(empty.ok).toBe(false);
    expect(await archiveRoom({ id: "" })).toEqual({ ok: false, error: "Sala no encontrada." });
    expect(await db.room.count({ where: { tenantId: A.tenantId } })).toBe(before);
  });

  // SR-D8 · concurrencia archiveRoom ↔ createBooking con sala (gate de SR1b,
  // lo da vuelta SR3a). `createBooking` valida la sala (`lockActiveRoomInTx`)
  // DESPUÉS del lock COMPARTIDO de sedes, y `archiveRoom` cuenta los turnos
  // futuros con el EXCLUSIVO: se serializan. Sin eso, el alta leía "sala
  // activa", el archivado contaba "0 turnos" y quedaba un turno en una sala
  // archivada. Se fuerza la carrera reteniendo el lock de sedes desde una
  // tercera conexión hasta que las dos esperan; los dos órdenes son válidos.
  it("[SR-gate] archiveRoom contra createBooking con esa sala → nunca queda un turno activo en sala archivada", async () => {
    asUser(A.userId);
    const { waitForAdvisoryWaiter } = await import("@/tests/helpers/advisory-wait");
    const { createBooking } = await import("@/lib/bookings");
    const roomId = await mustCreate(locA1, `Carrera ${uniqueSuffix()}`);
    const patientId = await addPatient(db, A);
    const key = `kinesoft:locations:${A.tenantId}`;
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
      { timeout: 20_000 }
    );
    await got;
    try {
      const pBook = createBooking({
        patientId,
        serviceId: A.serviceId,
        practitionerId: A.practitionerId,
        scheduledFor: new Date(Date.now() + 30 * DAY).toISOString(),
        durationMin: 45,
        roomId,
        locationId: locA1,
        allowOutOfHours: true,
        allowBlocked: true,
      });
      const pArchive = archiveRoom({ id: roomId });
      // Alta (compartido) y archivado (exclusivo) esperando la MISMA clave de sedes.
      await waitForAdvisoryWaiter(probe, key, { minWaiters: 2, timeoutMs: 10_000 });
      release();
      await held;
      const [book, arch] = await Promise.all([pBook, pArchive]);
      const room = await db.room.findUniqueOrThrow({ where: { id: roomId } });
      const active = await db.booking.count({
        where: { tenantId: A.tenantId, roomId, status: { not: "CANCELLED" } },
      });
      if (book.ok) {
        // El alta ganó: el archivado ve el turno futuro y se niega (SR-D8).
        expect(arch).toMatchObject({ ok: false, blockers: { futureBookings: 1 } });
        expect(room.active).toBe(true);
        expect(active).toBe(1);
      } else {
        // El archivado ganó: el alta ve la sala archivada → BAD_ROOM_ERROR sin escribir.
        expect(arch).toEqual({ ok: true, data: undefined });
        expect(book).toEqual({ ok: false, error: "Esa sala no está disponible en esa sede." });
        expect(room.active).toBe(false);
        expect(active).toBe(0);
      }
    } finally {
      release();
      await held.catch(() => {});
      await Promise.all([holder.$disconnect(), probe.$disconnect()]);
    }
  });
});
