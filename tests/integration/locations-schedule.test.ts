/**
 * B2.4a CFG-api-1 — sedes, franjas y excepciones contra la DB real (rol app
 * con RLS y owner BYPASSRLS = prod).
 *
 * Lo que se protege:
 *   • authz: escribir exige `schedule.configure` (solo OWNER/ADMIN); leer,
 *     `agenda.viewAll` (PRACTITIONER sí lee);
 *   • IDOR: las FK de PractitionerSchedule/ScheduleException saltean RLS → un
 *     id de sede o profesional de OTRO tenant tiene que rechazarse y no dejar
 *     ninguna fila (en owner BYPASSRLS el `where tenantId` es la única barrera);
 *   • una sola sede principal (índice único parcial), también con carrera;
 *   • archivar bloqueado con conteos (principal / franjas / turnos / excepciones);
 *   • reemplazo atómico de la semana + optimistic lock;
 *   • excepción del consultorio vs del profesional (índices parciales).
 * Cada caso afirma el efecto observable en la base, no solo el `ok`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  listLocations,
  createLocation,
  updateLocation,
  setPrimaryLocation,
  archiveLocation,
  restoreLocation,
} from "@/lib/locations";
import {
  getPractitionerSchedule,
  savePractitionerWeek,
  getPractitionerScheduleSummary,
  listExceptions,
  upsertException,
  deleteException,
} from "@/lib/practitioner-schedule";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  addPatient,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";
const FORBIDDEN = "Solo OWNER/ADMIN pueden configurar sedes y horarios.";

const week = (locationId: string, dows = [1, 2, 3, 4, 5]) =>
  dows.flatMap((dow) => [
    { dow, startMin: 480, endMin: 780, locationId },
    { dow, startMin: 900, endMin: 1140, locationId },
  ]);

describe.skipIf(!RUN)("sedes, franjas y excepciones (B2.4a)", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let pracA: { userId: string; practitionerId: string };
  let locA1: string; // principal de A
  let locA2: string;
  let locB: string; // principal de B

  async function mustCreate(name: string): Promise<string> {
    const r = await createLocation({ name });
    if (!r.ok) throw new Error(r.error);
    return r.data.id;
  }

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
    pracA = await addPractitioner(db, A, "PRACTITIONER");

    asUser(A.userId);
    locA1 = await mustCreate("Centro");
    locA2 = await mustCreate("Palermo");
    asUser(B.userId);
    locB = await mustCreate("Sede B");
    const sb = await savePractitionerWeek(B.practitionerId, week(locB));
    expect(sb.ok).toBe(true);
  });

  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await db?.$disconnect();
  });

  // ── sedes ───────────────────────────────────────────────────────────────
  it("la primera sede de un tenant sin principal nace principal; la segunda no", async () => {
    const rows = await db.location.findMany({ where: { tenantId: A.tenantId }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.id, r.isPrimary])).toEqual([
      [locA1, true],
      [locA2, false],
    ]);
    asUser(A.userId);
    const list = await listLocations();
    expect(list.map((l) => l.id)).toEqual([locA1, locA2]);
    expect(list.map((l) => l.id)).not.toContain(locB);
  });

  it("updateLocation: edita campos pedidos, '' borra, lo omitido queda; IDOR → no encontrada", async () => {
    asUser(A.userId);
    expect((await updateLocation(locA2, { address: "Av. Santa Fe 1234", city: "CABA", phone: "11-5555" })).ok).toBe(true);
    expect((await updateLocation(locA2, { phone: "" })).ok).toBe(true);
    const row = await db.location.findUniqueOrThrow({ where: { id: locA2 } });
    expect([row.name, row.address, row.city, row.phone]).toEqual(["Palermo", "Av. Santa Fe 1234", "CABA", null]);

    const r = await updateLocation(locB, { name: "Hackeada" });
    expect(r).toEqual({ ok: false, error: "Sede no encontrada." });
    expect((await db.location.findUniqueOrThrow({ where: { id: locB } })).name).toBe("Sede B");
  });

  it("setPrimaryLocation: una sola principal, también con dos pedidos en carrera", async () => {
    asUser(A.userId);
    expect((await setPrimaryLocation(locA2)).ok).toBe(true);
    let prim = await db.location.findMany({ where: { tenantId: A.tenantId, isPrimary: true } });
    expect(prim.map((p) => p.id)).toEqual([locA2]);

    const results = await Promise.all([setPrimaryLocation(locA1), setPrimaryLocation(locA2)]);
    expect(results.every((r) => r.ok)).toBe(true);
    prim = await db.location.findMany({ where: { tenantId: A.tenantId, isPrimary: true } });
    expect(prim).toHaveLength(1);

    // Dejar A1 como principal para el resto.
    expect((await setPrimaryLocation(locA1)).ok).toBe(true);
    // IDOR: la principal de B no se toca.
    expect(await setPrimaryLocation(locB)).toEqual({ ok: false, error: "Sede no encontrada." });
    expect((await db.location.findUniqueOrThrow({ where: { id: locB } })).isPrimary).toBe(true);
    expect(await db.location.count({ where: { tenantId: A.tenantId, isPrimary: true } })).toBe(1);
  });

  // ── authz ───────────────────────────────────────────────────────────────
  it("PRACTITIONER lee pero no escribe sedes, franjas ni excepciones (y no se escribe nada)", async () => {
    asUser(pracA.userId);
    expect((await listLocations()).length).toBe(2);
    expect((await getPractitionerScheduleSummary()).length).toBeGreaterThanOrEqual(2);
    expect(await getPractitionerSchedule(pracA.practitionerId)).not.toBeNull();

    await expect(createLocation({ name: "Prac" })).rejects.toThrow(FORBIDDEN);
    await expect(updateLocation(locA2, { name: "Prac" })).rejects.toThrow(FORBIDDEN);
    await expect(setPrimaryLocation(locA2)).rejects.toThrow(FORBIDDEN);
    await expect(archiveLocation(locA2)).rejects.toThrow(FORBIDDEN);
    await expect(savePractitionerWeek(pracA.practitionerId, week(locA1))).rejects.toThrow(FORBIDDEN);
    await expect(
      upsertException({ practitionerId: pracA.practitionerId, date: "2030-01-07", kind: "CLOSED" })
    ).rejects.toThrow(FORBIDDEN);

    expect(await db.location.count({ where: { tenantId: A.tenantId } })).toBe(2);
    expect((await db.location.findUniqueOrThrow({ where: { id: locA2 } })).name).toBe("Palermo");
    expect(await db.practitionerSchedule.count({ where: { practitionerId: pracA.practitionerId } })).toBe(0);
    expect(await db.scheduleException.count({ where: { tenantId: A.tenantId } })).toBe(0);
  });

  // ── franjas ─────────────────────────────────────────────────────────────
  it("savePractitionerWeek: guarda, resume y reemplaza atómicamente con optimistic lock", async () => {
    asUser(A.userId);
    const empty = await getPractitionerSchedule(pracA.practitionerId);
    expect(empty).toMatchObject({ ranges: [], version: null, isFallback: true });

    const s1 = await savePractitionerWeek(pracA.practitionerId, week(locA1), null);
    expect(s1.ok).toBe(true);
    const v1 = await getPractitionerSchedule(pracA.practitionerId);
    expect(v1?.ranges).toHaveLength(10);
    expect(v1?.isFallback).toBe(false);
    expect(s1.ok && s1.data.version).toBe(v1?.version);

    const sum = (await getPractitionerScheduleSummary()).find((p) => p.practitionerId === pracA.practitionerId);
    expect(sum).toMatchObject({ summary: "Lun-Vie 8-13, 15-19", isFallback: false, rangeCount: 10, locationIds: [locA1] });
    // El OWNER sin franjas: horario heredado del consultorio (8-19 lun-sáb).
    const owner = (await getPractitionerScheduleSummary()).find((p) => p.practitionerId === A.practitionerId);
    expect(owner).toMatchObject({ isFallback: true, summary: "Lun-Sáb 8-19" });

    // Versión vieja (null) → conflicto, nada cambia.
    const stale = await savePractitionerWeek(pracA.practitionerId, week(locA2, [6]), null);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error).toMatch(/cambió este horario/);
    expect(await db.practitionerSchedule.count({ where: { practitionerId: pracA.practitionerId } })).toBe(10);

    // Reemplazo válido con la versión actual: queda EXACTAMENTE lo nuevo.
    const s2 = await savePractitionerWeek(
      pracA.practitionerId,
      [
        { dow: 1, startMin: 480, endMin: 780, locationId: locA1 },
        { dow: 1, startMin: 840, endMin: 1080, locationId: locA2 },
      ],
      v1!.version
    );
    expect(s2.ok).toBe(true);
    const rows = await db.practitionerSchedule.findMany({
      where: { practitionerId: pracA.practitionerId },
      orderBy: { startMin: "asc" },
    });
    expect(rows.map((r) => [r.dow, r.startMin, r.endMin, r.locationId, r.tenantId])).toEqual([
      [1, 480, 780, locA1, A.tenantId],
      [1, 840, 1080, locA2, A.tenantId],
    ]);
    expect(
      await db.auditEvent.count({ where: { tenantId: A.tenantId, action: "schedule.saveWeek", entityId: pracA.practitionerId } })
    ).toBe(2);
  });

  it("errores por fila (solape entre sedes, múltiplos de 5) y semana vacía: no tocan lo guardado", async () => {
    asUser(A.userId);
    const before = await db.practitionerSchedule.count({ where: { practitionerId: pracA.practitionerId } });
    const r = await savePractitionerWeek(pracA.practitionerId, [
      { dow: 2, startMin: 480, endMin: 780, locationId: locA1 },
      { dow: 2, startMin: 720, endMin: 900, locationId: locA2 },
      { dow: 3, startMin: 481, endMin: 600, locationId: locA1 },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(Object.keys(r.fieldErrors ?? {}).sort()).toEqual(["ranges.0", "ranges.1", "ranges.2"]);
      expect(r.fieldErrors?.["ranges.1"]?.[0]).toMatch(/otra sede/);
    }
    const empty = await savePractitionerWeek(pracA.practitionerId, []);
    expect(empty.ok).toBe(false);
    expect(await db.practitionerSchedule.count({ where: { practitionerId: pracA.practitionerId } })).toBe(before);
  });

  it("IDOR: sede o profesional de otro tenant → rechazo y ninguna fila escrita en ningún tenant", async () => {
    asUser(A.userId);
    const beforeA = await db.practitionerSchedule.findMany({ where: { practitionerId: pracA.practitionerId } });
    const beforeB = await db.practitionerSchedule.count({ where: { practitionerId: B.practitionerId } });

    const crossLoc = await savePractitionerWeek(pracA.practitionerId, [
      { dow: 1, startMin: 480, endMin: 600, locationId: locA1 },
      { dow: 2, startMin: 480, endMin: 600, locationId: locB },
    ]);
    expect(crossLoc.ok).toBe(false);
    if (!crossLoc.ok) expect(crossLoc.fieldErrors).toEqual({ "ranges.1": ["La sede no existe o está archivada."] });

    const crossPrac = await savePractitionerWeek(B.practitionerId, week(locA1));
    expect(crossPrac).toEqual({ ok: false, error: "Profesional no encontrado." });

    expect(await getPractitionerSchedule(B.practitionerId)).toBeNull();
    expect((await getPractitionerScheduleSummary()).map((p) => p.practitionerId)).not.toContain(B.practitionerId);

    const exc = await upsertException({ practitionerId: B.practitionerId, date: "2030-01-07", kind: "CLOSED" });
    expect(exc).toEqual({ ok: false, error: "Profesional no encontrado." });
    const excLoc = await upsertException({
      practitionerId: null,
      date: "2030-01-07",
      kind: "CUSTOM_HOURS",
      ranges: [{ startMin: 540, endMin: 720, locationId: locB }],
    });
    expect(excLoc.ok).toBe(false);

    expect(await archiveLocation(locB)).toEqual({ ok: false, error: "Sede no encontrada." });
    expect((await db.location.findUniqueOrThrow({ where: { id: locB } })).active).toBe(true);

    const afterA = await db.practitionerSchedule.findMany({ where: { practitionerId: pracA.practitionerId } });
    expect(afterA.map((r) => r.id).sort()).toEqual(beforeA.map((r) => r.id).sort());
    expect(await db.practitionerSchedule.count({ where: { practitionerId: B.practitionerId } })).toBe(beforeB);
    expect(await db.practitionerSchedule.count({ where: { locationId: locB, tenantId: A.tenantId } })).toBe(0);
    expect(await db.scheduleException.count({ where: { tenantId: { in: [A.tenantId, B.tenantId] } } })).toBe(0);
  });

  // ── excepciones ─────────────────────────────────────────────────────────
  it("excepción del consultorio y del profesional conviven el mismo día; upsert reemplaza; delete", async () => {
    asUser(A.userId);
    const day = "2030-03-04";
    const tw = await upsertException({ practitionerId: null, date: day, kind: "CLOSED", reason: "Feriado" });
    const pr = await upsertException({
      practitionerId: pracA.practitionerId,
      date: day,
      kind: "CUSTOM_HOURS",
      ranges: [{ startMin: 540, endMin: 720, locationId: locA2 }],
    });
    expect(tw.ok && pr.ok).toBe(true);

    // Mismo key → actualiza la misma fila (no duplica).
    const tw2 = await upsertException({ practitionerId: null, date: day, kind: "CLOSED", reason: "Paro" });
    expect(tw2.ok && tw.ok && tw2.data.id === tw.data.id).toBe(true);
    // Otro profesional del tenant, mismo día: otra fila.
    const own = await upsertException({ practitionerId: A.practitionerId, date: day, kind: "CLOSED" });
    expect(own.ok).toBe(true);

    const rows = await db.scheduleException.findMany({ where: { tenantId: A.tenantId }, orderBy: { createdAt: "asc" } });
    expect(rows).toHaveLength(3);
    const twRow = rows.find((r) => r.practitionerId === null)!;
    expect(twRow.reason).toBe("Paro");
    expect(twRow.ranges).toBeNull(); // SQL NULL, no JSON null
    expect(twRow.date.toISOString()).toBe(`${day}T00:00:00.000Z`);
    expect(twRow.createdById).toBe(A.userId);

    // listExceptions con profesional: las suyas + las del consultorio, no las de otro profesional.
    const forPrac = await listExceptions({ from: "2030-03-01", to: "2030-03-31", practitionerId: pracA.practitionerId });
    expect(forPrac.map((e) => e.practitionerId).sort()).toEqual([null, pracA.practitionerId].sort());
    const prRow = forPrac.find((e) => e.practitionerId === pracA.practitionerId)!;
    expect(prRow).toMatchObject({ date: day, kind: "CUSTOM_HOURS", ranges: [{ startMin: 540, endMin: 720, locationId: locA2 }] });
    expect(await listExceptions({ from: "2030-03-05", to: "2030-03-31" })).toEqual([]);

    // CUSTOM_HOURS sin franjas → rechazo.
    const bad = await upsertException({ practitionerId: null, date: "2030-03-05", kind: "CUSTOM_HOURS", ranges: [] });
    expect(bad.ok).toBe(false);

    // delete: la de B no se borra desde A; la propia sí.
    asUser(B.userId);
    const bExc = await upsertException({ practitionerId: null, date: day, kind: "CLOSED" });
    expect(bExc.ok).toBe(true);
    asUser(A.userId);
    if (bExc.ok) {
      expect(await deleteException(bExc.data.id)).toEqual({ ok: false, error: "Excepción no encontrada." });
      expect(await db.scheduleException.count({ where: { id: bExc.data.id } })).toBe(1);
    }
    if (own.ok) {
      expect((await deleteException(own.data.id)).ok).toBe(true);
      expect(await db.scheduleException.count({ where: { id: own.data.id } })).toBe(0);
    }
  });

  // ── archivar ────────────────────────────────────────────────────────────
  it("archiveLocation: bloqueado con conteos (principal, franjas, turnos, excepciones); después archiva y restaura", async () => {
    asUser(A.userId);
    const prim = await archiveLocation(locA1);
    expect(prim.ok).toBe(false);
    if (!prim.ok) expect(prim.error).toMatch(/principal/);

    // locA2 tiene: 1 franja de pracA (dow 1) + la excepción CUSTOM del 2030-03-04 + un turno futuro.
    const patientId = await addPatient(db, A);
    const booking = await db.booking.create({
      data: {
        tenantId: A.tenantId,
        patientId,
        practitionerId: pracA.practitionerId,
        serviceId: A.serviceId,
        scheduledFor: new Date("2030-03-05T13:00:00Z"),
        durationMin: 45,
        idempotencyKey: `test-${uniqueSuffix()}`,
        locationId: locA2,
        status: "CONFIRMED",
      },
    });
    const blocked = await archiveLocation(locA2);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.blockers).toEqual({ activeSchedules: 1, futureBookings: 1, futureExceptions: 1 });
      expect(blocked.error).toMatch(/1 franja de horario, 1 turno a futuro, 1 día con horario especial/);
    }
    expect((await db.location.findUniqueOrThrow({ where: { id: locA2 } })).active).toBe(true);

    // Un turno CANCELADO no bloquea; mover franja y excepción a locA1 → archiva.
    await db.booking.update({ where: { id: booking.id }, data: { status: "CANCELLED" } });
    const cur = await getPractitionerSchedule(pracA.practitionerId);
    expect(
      (await savePractitionerWeek(pracA.practitionerId, week(locA1, [1]), cur!.version)).ok
    ).toBe(true);
    expect(
      (
        await upsertException({
          practitionerId: pracA.practitionerId,
          date: "2030-03-04",
          kind: "CUSTOM_HOURS",
          ranges: [{ startMin: 540, endMin: 720, locationId: locA1 }],
        })
      ).ok
    ).toBe(true);
    expect((await archiveLocation(locA2)).ok).toBe(true);
    expect((await db.location.findUniqueOrThrow({ where: { id: locA2 } })).active).toBe(false);
    expect((await listLocations()).map((l) => l.id)).toEqual([locA1]);
    expect((await listLocations({ includeArchived: true })).map((l) => l.id).sort()).toEqual([locA1, locA2].sort());

    // Sede archivada: no se pueden cargar franjas ni hacerla principal.
    const onArchived = await savePractitionerWeek(pracA.practitionerId, week(locA2, [2]));
    expect(onArchived.ok).toBe(false);
    expect((await setPrimaryLocation(locA2)).ok).toBe(false);

    expect((await restoreLocation(locA2)).ok).toBe(true);
    expect((await db.location.findUniqueOrThrow({ where: { id: locA2 } })).active).toBe(true);
    expect(
      await db.auditEvent.count({ where: { tenantId: A.tenantId, action: { in: ["location.archive", "location.restore"] } } })
    ).toBe(2);
  });
});
