/**
 * SR1c — horarios con sala y vigencia contra la DB real (rol app con RLS y
 * owner BYPASSRLS = prod).
 *
 * Lo que se protege (plan §17.5, SR-D1 / SR-D4):
 *   • choque DURO entre franjas de profesionales distintos en la misma sala →
 *     `fieldErrors["ranges.<i>"]` con el copy literal y NADA escrito;
 *   • `capacity` = profesionales a la vez (gimnasio de 2: entran 2, el 3.º choca);
 *   • sala ajena, de otra sede o archivada → rechazo por fila;
 *   • la vigencia y la sala se persisten y se leen (con `roomUsage` de los demás);
 *   • excepción con sala contra el día EFECTIVO de los demás; plantilla contra
 *     excepciones futuras de otros → solo aviso;
 *   • concurrencia: dos guardados simultáneos sobre una sala de capacidad 1 →
 *     uno falla (lock `kinesoft:room-schedule:<t>`), probado con el waiter
 *     filtrado por clave (`advisory-wait`), no con un sleep;
 *   • (SRZ/FX1) una franja VENCIDA con sala archivada no bloquea guardar la
 *     semana; un consultorio sin salas no paga la query de `roomUsage`.
 *
 * `@/lib/db` solo se instrumenta con `installQueryCounter` (un listener de
 * `query`) para contar sentencias; nada del código bajo test se reemplaza.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { installQueryCounter } = await import("@/tests/helpers/query-counter");
  return { ...actual, ...installQueryCounter() };
});

import { PrismaClient } from "@prisma/client";
import { measure, type QueryEvent } from "@/tests/helpers/query-counter";
import { getPractitionerSchedule, savePractitionerWeek, upsertException } from "@/lib/practitioner-schedule";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  addRoom,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { waitForAdvisoryWaiter } from "@/tests/helpers/advisory-wait";

const RUN = process.env.INTEGRATION === "1";
const BAD_ROOM = "Esa sala no está disponible en esa sede.";
const MONDAY = "2030-03-04";

describe.skipIf(!RUN)("horarios con sala y vigencia (SR1c)", () => {
  let db: PrismaClient;
  let appDb: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let locA: string;
  let locA2: string;
  let ana: { userId: string; practitionerId: string };
  let beto: { userId: string; practitionerId: string };
  let carla: { userId: string; practitionerId: string };

  async function prac(t: EphemeralTenant, fullName: string) {
    const p = await addPractitioner(db, t, "PRACTITIONER");
    await db.userProfile.update({ where: { id: p.userId }, data: { fullName } });
    return p;
  }

  const rowsOf = (practitionerId: string) =>
    db.practitionerSchedule.findMany({ where: { practitionerId }, orderBy: [{ dow: "asc" }, { startMin: "asc" }] });

  beforeAll(async () => {
    db = ownerClient();
    appDb = new PrismaClient();
    // PL-2f (C-PL1): salas y Sala de Espera son de Clínica / Libre; sin el plan, el motor ignora las salas.
    A = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    B = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    locA = (await db.location.create({ data: { tenantId: A.tenantId, name: "Centro", isPrimary: true } })).id;
    locA2 = (await db.location.create({ data: { tenantId: A.tenantId, name: "Palermo" } })).id;
    ana = await prac(A, "Ana Pérez");
    beto = await prac(A, "Beto Gómez");
    carla = await prac(A, "Carla Díaz");
  });

  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await Promise.all([db?.$disconnect(), appDb?.$disconnect()]);
  });

  it("choque entre profesionales (capacidad 1): error en la fila correcta y nada escrito", async () => {
    const { roomId } = await addRoom(db, A, { locationId: locA, name: "Consultorio 1", capacity: 1 });
    asUser(A.userId);
    const okAna = await savePractitionerWeek(ana.practitionerId, [
      { dow: 1, startMin: 540, endMin: 780, locationId: locA, roomId },
    ]);
    expect(okAna).toMatchObject({ ok: true });

    const before = await rowsOf(beto.practitionerId);
    const r = await savePractitionerWeek(beto.practitionerId, [
      { dow: 2, startMin: 540, endMin: 780, locationId: locA, roomId }, // martes: libre
      { dow: 1, startMin: 780, endMin: 900, locationId: locA, roomId }, // borde 13:00: no choca
      { dow: 1, startMin: 600, endMin: 660, locationId: locA, roomId }, // choca
    ]);
    expect(r).toEqual({
      ok: false,
      error: "Revisá las franjas marcadas.",
      fieldErrors: {
        "ranges.2": ["Esa sala ya la usa Ana Pérez los lunes de 9:00 a 13:00. Elegí otra sala o cambiá el horario."],
      },
    });
    expect(await rowsOf(beto.practitionerId)).toEqual(before);

    // El mismo profesional no choca consigo mismo: Ana re-guarda su semana.
    const again = await getPractitionerSchedule(ana.practitionerId);
    expect(
      (
        await savePractitionerWeek(
          ana.practitionerId,
          [
            { dow: 1, startMin: 540, endMin: 780, locationId: locA, roomId },
            { dow: 1, startMin: 780, endMin: 840, locationId: locA, roomId },
          ],
          again!.version
        )
      ).ok
    ).toBe(true);
    // Limpieza para los demás casos.
    await db.practitionerSchedule.deleteMany({ where: { tenantId: A.tenantId } });
  });

  it("gimnasio con capacidad 2: entran 2 profesionales y el tercero choca", async () => {
    const { roomId } = await addRoom(db, A, { locationId: locA, name: "Gimnasio", kind: "GIMNASIO", capacity: 2 });
    asUser(A.userId);
    const w = (s: number, e: number) => [{ dow: 3, startMin: s, endMin: e, locationId: locA, roomId }];
    expect((await savePractitionerWeek(ana.practitionerId, w(540, 720))).ok).toBe(true);
    expect((await savePractitionerWeek(beto.practitionerId, w(600, 780))).ok).toBe(true);
    const third = await savePractitionerWeek(carla.practitionerId, w(660, 700));
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.fieldErrors).toEqual({
        "ranges.0": [
          "Esa sala ya la usan Ana Pérez y Beto Gómez los miércoles de 10:00 a 12:00. Elegí otra sala o cambiá el horario.",
        ],
      });
    }
    expect(await rowsOf(carla.practitionerId)).toEqual([]);
    // Cuando Ana ya se fue (12:00), Carla entra.
    expect((await savePractitionerWeek(carla.practitionerId, w(720, 780))).ok).toBe(true);
    await db.practitionerSchedule.deleteMany({ where: { tenantId: A.tenantId } });
  });

  it("sala de otra sede, de otro consultorio o archivada → rechazo por fila, nada escrito", async () => {
    const other = await addRoom(db, A, { locationId: locA2, name: "Box Palermo" });
    const archived = await addRoom(db, A, { locationId: locA, name: "Vieja", active: false });
    const foreign = await addRoom(db, B, { name: "Consultorio de B" });
    asUser(A.userId);
    const r = await savePractitionerWeek(ana.practitionerId, [
      { dow: 1, startMin: 540, endMin: 600, locationId: locA, roomId: other.roomId },
      { dow: 2, startMin: 540, endMin: 600, locationId: locA, roomId: archived.roomId },
      { dow: 3, startMin: 540, endMin: 600, locationId: locA, roomId: foreign.roomId },
      { dow: 4, startMin: 540, endMin: 600, locationId: locA, roomId: null },
    ]);
    expect(r).toEqual({
      ok: false,
      error: "Revisá las franjas marcadas.",
      fieldErrors: { "ranges.0": [BAD_ROOM], "ranges.1": [BAD_ROOM], "ranges.2": [BAD_ROOM] },
    });
    expect(await rowsOf(ana.practitionerId)).toEqual([]);

    const exc = await upsertException({
      practitionerId: ana.practitionerId,
      date: MONDAY,
      kind: "CUSTOM_HOURS",
      ranges: [{ startMin: 540, endMin: 600, locationId: locA, roomId: foreign.roomId }],
    });
    expect(exc).toMatchObject({ ok: false, fieldErrors: { "ranges.0": [BAD_ROOM] } });
    expect(await db.scheduleException.count({ where: { tenantId: { in: [A.tenantId, B.tenantId] } } })).toBe(0);
  });

  it("persiste sala y vigencia; la lectura devuelve roomId, vigencia y roomUsage de los demás", async () => {
    const { roomId } = await addRoom(db, A, { locationId: locA, name: "Consultorio 2" });
    asUser(A.userId);
    // Reemplazo por unas semanas: misma franja, vigencias disjuntas, sin solape propio.
    const s = await savePractitionerWeek(ana.practitionerId, [
      { dow: 1, startMin: 540, endMin: 780, locationId: locA, roomId, validFrom: null, validUntil: "2030-03-31" },
      { dow: 1, startMin: 540, endMin: 780, locationId: locA, roomId: null, validFrom: "2030-04-01", validUntil: null },
    ]);
    expect(s.ok).toBe(true);
    const rows = await rowsOf(ana.practitionerId);
    expect(
      rows.map((r) => [r.roomId, r.validFrom?.toISOString().slice(0, 10) ?? null, r.validUntil?.toISOString().slice(0, 10) ?? null])
    ).toEqual([
      [roomId, null, "2030-03-31"],
      [null, "2030-04-01", null],
    ]);

    const view = await getPractitionerSchedule(ana.practitionerId);
    expect(view?.ranges.map((r) => [r.roomId, r.validFrom, r.validUntil])).toEqual([
      [roomId, null, "2030-03-31"],
      [null, "2030-04-01", null],
    ]);
    expect(view?.roomUsage).toEqual([]); // nadie más usa salas

    // Beto lee el de Ana como uso ajeno (con nombre, sin datos clínicos).
    const betoView = await getPractitionerSchedule(beto.practitionerId);
    expect(betoView?.roomUsage).toEqual([
      {
        roomId,
        practitionerId: ana.practitionerId,
        practitionerName: "Ana Pérez",
        dow: 1,
        startMin: 540,
        endMin: 780,
        validFrom: null,
        validUntil: "2030-03-31",
      },
    ]);
    // Beto en esa sala DESDE el 1/4 no choca (vigencias disjuntas); antes sí.
    expect(
      (
        await savePractitionerWeek(beto.practitionerId, [
          { dow: 1, startMin: 540, endMin: 780, locationId: locA, roomId, validFrom: "2030-04-01" },
        ])
      ).ok
    ).toBe(true);
    const clash = await savePractitionerWeek(beto.practitionerId, [
      { dow: 1, startMin: 540, endMin: 780, locationId: locA, roomId, validFrom: "2030-03-25" },
    ]);
    expect(clash.ok).toBe(false);

    // Fin antes del inicio → error de la fila.
    const bad = await savePractitionerWeek(beto.practitionerId, [
      { dow: 2, startMin: 540, endMin: 780, locationId: locA, validFrom: "2030-03-10", validUntil: "2030-03-01" },
    ]);
    expect(bad).toMatchObject({
      ok: false,
      fieldErrors: { "ranges.0": ["La fecha de fin tiene que ser igual o posterior a la de inicio."] },
    });
    await db.practitionerSchedule.deleteMany({ where: { tenantId: A.tenantId } });
  });

  it("excepción con sala contra el día efectivo de los demás; aviso de plantilla contra excepción futura", async () => {
    const { roomId } = await addRoom(db, A, { locationId: locA, name: "Consultorio 3" });
    const free = await addRoom(db, A, { locationId: locA, name: "Consultorio 4" });
    asUser(A.userId);
    expect(
      (await savePractitionerWeek(ana.practitionerId, [{ dow: 1, startMin: 540, endMin: 780, locationId: locA, roomId }])).ok
    ).toBe(true);

    // Beto, el lunes 4/3, en la sala que Ana usa por plantilla → choque.
    const exc = (ranges: Array<{ startMin: number; endMin: number; roomId: string }>) =>
      upsertException({
        practitionerId: beto.practitionerId,
        date: MONDAY,
        kind: "CUSTOM_HOURS",
        ranges: ranges.map((r) => ({ ...r, locationId: locA })),
      });
    const clash = await exc([{ startMin: 600, endMin: 660, roomId }]);
    expect(clash).toEqual({
      ok: false,
      error: "Revisá las franjas marcadas.",
      fieldErrors: {
        "ranges.0": ["Esa sala ya la usa Ana Pérez ese día de 9:00 a 13:00. Elegí otra sala o cambiá el horario."],
      },
    });
    expect(await db.scheduleException.count({ where: { tenantId: A.tenantId } })).toBe(0);

    // Ana cierra ese día → su plantilla no rige → Beto entra.
    expect((await upsertException({ practitionerId: ana.practitionerId, date: MONDAY, kind: "CLOSED" })).ok).toBe(true);
    const ok = await exc([{ startMin: 600, endMin: 660, roomId }]);
    expect(ok.ok).toBe(true);
    const stored = await db.scheduleException.findFirstOrThrow({ where: { practitionerId: beto.practitionerId } });
    expect(stored.ranges).toEqual([{ startMin: 600, endMin: 660, locationId: locA, roomId }]);

    // Excepción del consultorio entero con sala → rechazo.
    const tw = await upsertException({
      practitionerId: null,
      date: "2030-03-05",
      kind: "CUSTOM_HOURS",
      ranges: [{ startMin: 540, endMin: 600, locationId: locA, roomId: free.roomId }],
    });
    expect(tw.ok).toBe(false);

    // Carla guarda una plantilla de lunes en esa sala: choca con Ana (duro).
    expect(
      (await savePractitionerWeek(carla.practitionerId, [{ dow: 1, startMin: 600, endMin: 660, locationId: locA, roomId }])).ok
    ).toBe(false);
    // En la sala libre, pero Beto tiene una excepción futura ahí → se guarda con aviso.
    expect((await exc([{ startMin: 600, endMin: 660, roomId: free.roomId }])).ok).toBe(true);
    const warned = await savePractitionerWeek(carla.practitionerId, [
      { dow: 1, startMin: 540, endMin: 720, locationId: locA, roomId: free.roomId },
    ]);
    expect(warned).toEqual({
      ok: true,
      data: {
        version: expect.any(String),
        warnings: ["El 04/03, Consultorio 4 ya la usa Beto Gómez de 10:00 a 11:00 (horario especial). Revisá ese día."],
      },
    });
    expect((await rowsOf(carla.practitionerId)).map((r) => r.roomId)).toEqual([free.roomId]);
    await db.practitionerSchedule.deleteMany({ where: { tenantId: A.tenantId } });
    await db.scheduleException.deleteMany({ where: { tenantId: A.tenantId } });
  });

  it("[SR-FX1] una franja VENCIDA con sala archivada no bloquea guardar la semana", async () => {
    // El editor re-manda TODAS las franjas (reemplazo atómico): una franja vieja
    // (validUntil < hoy AR) cuya sala se archivó después dejaba la semana sin
    // poder guardarse nunca más con "Esa sala no está disponible en esa sede.".
    const old = await addRoom(db, A, { locationId: locA, name: "Consultorio viejo" });
    const live = await addRoom(db, A, { locationId: locA, name: "Consultorio 6" });
    asUser(A.userId);
    const expired = {
      dow: 2,
      startMin: 540,
      endMin: 780,
      locationId: locA,
      roomId: old.roomId,
      validFrom: null,
      validUntil: "2020-01-31",
    };
    expect((await savePractitionerWeek(ana.practitionerId, [expired])).ok).toBe(true);
    // archiveRoom lo permite (la franja ya no está vigente); acá directo.
    await db.room.update({ where: { id: old.roomId }, data: { active: false } });

    const view = await getPractitionerSchedule(ana.practitionerId);
    const r = await savePractitionerWeek(
      ana.practitionerId,
      [expired, { dow: 3, startMin: 540, endMin: 600, locationId: locA, roomId: live.roomId }],
      view!.version
    );
    expect(r).toMatchObject({ ok: true });
    expect(
      (await rowsOf(ana.practitionerId)).map((x) => [x.roomId, x.validUntil?.toISOString().slice(0, 10) ?? null])
    ).toEqual([
      [old.roomId, "2020-01-31"],
      [live.roomId, null],
    ]);

    // Vigente con la sala archivada: sigue rechazada.
    const still = await savePractitionerWeek(ana.practitionerId, [{ ...expired, validUntil: null }]);
    expect(still).toEqual({ ok: false, error: "Revisá las franjas marcadas.", fieldErrors: { "ranges.0": [BAD_ROOM] } });

    // Vencida pero con sala de OTRA sede o de OTRO consultorio: error por fila
    // (sin esto saltaba la FK compuesta con un 23503 → "No pudimos guardar").
    const other = await addRoom(db, A, { locationId: locA2, name: "Box Palermo 2" });
    const foreign = await addRoom(db, B, { name: "Consultorio de B 2" });
    const bad = await savePractitionerWeek(ana.practitionerId, [
      { ...expired, roomId: other.roomId },
      { ...expired, dow: 4, roomId: foreign.roomId },
    ]);
    expect(bad).toEqual({
      ok: false,
      error: "Revisá las franjas marcadas.",
      fieldErrors: { "ranges.0": [BAD_ROOM], "ranges.1": [BAD_ROOM] },
    });
    expect((await rowsOf(ana.practitionerId)).map((x) => x.roomId)).toEqual([old.roomId, live.roomId]);
    await db.practitionerSchedule.deleteMany({ where: { tenantId: A.tenantId } });
  });

  it("[SR-FX1] consultorio sin salas activas: getPractitionerSchedule no consulta el uso de salas", async () => {
    const C = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    try {
      const locC = (await db.location.create({ data: { tenantId: C.tenantId, name: "Única", isPrimary: true } })).id;
      const other = await addPractitioner(db, C, "PRACTITIONER");
      asUser(C.userId);
      expect(
        (await savePractitionerWeek(other.practitionerId, [{ dow: 1, startMin: 540, endMin: 780, locationId: locC }])).ok
      ).toBe(true);
      const scheduleReads = (ev: QueryEvent[]) => ev.filter((e) => e.query.includes('FROM "public"."PractitionerSchedule"'));
      const recorded = () =>
        (globalThis as unknown as { __kineQueryRecorder: { events: QueryEvent[] } }).__kineQueryRecorder.events;

      const none = await measure(() => getPractitionerSchedule(C.practitionerId));
      expect(none.result?.roomUsage).toEqual([]);
      // Solo la lectura de MIS franjas: la de `roomUsage` (franjas de los demás) no corre.
      expect(scheduleReads(recorded())).toHaveLength(1);
      const baseline = none.m.statements;

      // Una sala ARCHIVADA no cuenta: sigue sin la query.
      await addRoom(db, C, { locationId: locC, name: "Vieja C", active: false });
      const archived = await measure(() => getPractitionerSchedule(C.practitionerId));
      expect(scheduleReads(recorded())).toHaveLength(1);
      expect(archived.m.statements).toBe(baseline);

      // Con una sala activa sí corre y devuelve el uso de los demás. Son +3
      // sentencias, no +1: `loadRoomUsage` trae el nombre del profesional por
      // relación (`practitioner.user`) y Prisma 5 las resuelve en 2 idas aparte.
      const { roomId } = await addRoom(db, C, { locationId: locC, name: "Consultorio C" });
      await db.practitionerSchedule.updateMany({ where: { practitionerId: other.practitionerId }, data: { roomId } });
      const withRoom = await measure(() => getPractitionerSchedule(C.practitionerId));
      expect(scheduleReads(recorded())).toHaveLength(2);
      expect(withRoom.m.statements).toBe(baseline + 3);
      expect(withRoom.result?.roomUsage).toMatchObject([{ roomId, practitionerId: other.practitionerId }]);
    } finally {
      await C.cleanup();
    }
  });

  it("concurrencia: dos guardados simultáneos sobre una sala de capacidad 1 → exactamente uno pasa", async () => {
    const { roomId } = await addRoom(db, A, { locationId: locA, name: "Consultorio 5" });
    const key = `kinesoft:room-schedule:${A.tenantId}`;
    asUser(A.userId);

    // Holder del lock en otra conexión: los dos guardados quedan esperando en
    // la MISMA clave y recién compiten al soltarlo (si el lock no existiera,
    // waitForAdvisoryWaiter tiraría por timeout: no hay falso verde).
    const holder = ownerClient();
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
    try {
      await got;
      const w = [{ dow: 5, startMin: 540, endMin: 600, locationId: locA, roomId }];
      const pending = Promise.all([
        savePractitionerWeek(ana.practitionerId, w),
        savePractitionerWeek(beto.practitionerId, w),
      ]);
      await waitForAdvisoryWaiter(appDb, key, { minWaiters: 2 });
      release();
      await held;
      const results = await pending;
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      const loser = results.find((r) => !r.ok);
      expect(loser && !loser.ok && loser.fieldErrors?.["ranges.0"]?.[0]).toMatch(/^Esa sala ya la usa /);
      expect(await db.practitionerSchedule.count({ where: { tenantId: A.tenantId, roomId } })).toBe(1);
    } finally {
      release();
      await held.catch(() => {});
      await holder.$disconnect();
    }
  });
});
