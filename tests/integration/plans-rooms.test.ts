/**
 * SR2b · El commit de Planes estampa la sala por defecto de la franja
 * (`commitPlanRowsInTx` → `defaultRoomFor`), SR-D3: sin chequear ocupación ni
 * tomar lock de sala, y sin tocar el preview ni el `stateToken` (C6/C7).
 *
 * Contra la base real con el `getActor()` real; `@/lib/db` se instrumenta con
 * `installQueryCounter` (solo suma un listener de `query`) para medir el costo
 * de la validación de salas: +1 sentencia como máximo, y 0 sin salas.
 *
 * Corre con los dos roles (`kinesoft_app` con RLS y el owner BYPASSRLS = prod).
 * Fechas en 2030+ (nada depende del reloj de hoy). TZ=UTC lo fija el script.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { installQueryCounter } = await import("@/tests/helpers/query-counter");
  return { ...actual, ...installQueryCounter() };
});

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { createPlan, previewPlan } from "@/lib/plans";
import type { PlanCreateInput, PlanPreview, PlanRowResolution } from "@/lib/plans-types";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addRoom,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { measure } from "@/tests/helpers/query-counter";
import { movePlanSeries, previewMovePlanSeries } from "@/lib/plans-move";

const RUN = process.env.INTEGRATION === "1";

/** Lunes y jueves 10:00 AR (C6: 0=Dom). */
const LUN_JUE_10 = {
  v: 1 as const,
  frequency: "weekly" as const,
  slots: [
    { dow: 1 as const, startMin: 600 },
    { dow: 4 as const, startMin: 600 },
  ],
};

function acceptDefaults(p: PlanPreview): PlanRowResolution[] {
  return p.rows.map((r) => {
    switch (r.defaultResolution) {
      case "move":
        return { index: r.index, kind: "move", at: r.suggestion };
      case "adopt":
        return {
          index: r.index,
          kind: "adopt",
          bookingId: r.flags.duplicate!.bookingId,
          expectedUpdatedAt: r.flags.duplicate!.updatedAt,
        };
      default:
        return { index: r.index, kind: r.defaultResolution };
    }
  });
}

describe.skipIf(!RUN)("SR2b · Planes estampan la sala por defecto", () => {
  let db: PrismaClient;
  let K: EphemeralTenant;
  let room: { roomId: string; locationId: string };

  const base = (patientId: string, over: Partial<PlanCreateInput> = {}): PlanCreateInput => ({
    idempotencyKey: randomUUID(),
    patientId,
    discipline: "KINESIOLOGY",
    practitionerId: K.practitionerId,
    serviceId: K.serviceId,
    locationId: null,
    schedule: LUN_JUE_10,
    startDayKey: "2030-01-07",
    totalSessions: 4,
    pricing: null,
    rows: [],
    stateToken: "x",
    ...over,
  });

  async function preview(input: PlanCreateInput): Promise<PlanPreview> {
    const r = await previewPlan(input);
    if (!r.ok) throw new Error(`preview falló: ${r.error}`);
    return r.preview;
  }

  /** Lunes y jueves 9 a 13 en la sede de la sala; con o sin la sala en la franja. */
  async function setFranjaRoom(roomId: string | null) {
    await db.practitionerSchedule.updateMany({
      where: { tenantId: K.tenantId, practitionerId: K.practitionerId },
      data: { roomId },
    });
  }

  beforeAll(async () => {
    db = ownerClient();
    K = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "PRO" });
    room = await addRoom(db, K, { name: "Consultorio 1" });
    await db.practitionerSchedule.createMany({
      data: [1, 4].map((dow) => ({
        tenantId: K.tenantId,
        practitionerId: K.practitionerId,
        locationId: room.locationId,
        roomId: room.roomId,
        dow,
        startMin: 540,
        endMin: 780,
      })),
    });
    asUser(K.userId);
  });

  afterAll(async () => {
    await K?.cleanup();
    await db?.$disconnect();
  });

  it("franjas con sala → cada turno del plan lleva la sala y la sede explícita", async () => {
    const patientId = await addPatient(db, K);
    const input = base(patientId);
    const p = await preview(input);
    const r = await createPlan({ ...input, stateToken: p.stateToken, rows: acceptDefaults(p) });
    expect(r).toMatchObject({ ok: true, idempotent: false });
    if (!r.ok) return;
    const bookings = await db.booking.findMany({ where: { programId: r.programId }, orderBy: { scheduledFor: "asc" } });
    expect(bookings).toHaveLength(4);
    for (const b of bookings) {
      expect(b.roomId).toBe(room.roomId);
      expect(b.locationId).toBe(room.locationId);
      // SR-D2/SR-D3: estampar la sala no es sobreturno.
      expect(b.isOverbooked).toBe(false);
    }
  });

  it("el preview y el stateToken no cambian con o sin sala en la franja (C6/C7)", async () => {
    const patientId = await addPatient(db, K);
    const input = base(patientId, { startDayKey: "2030-03-04" });
    try {
      const withRoom = await preview(input);
      await setFranjaRoom(null);
      const without = await preview(input);
      expect(without.stateToken).toBe(withRoom.stateToken);
      expect(without.rows).toEqual(withRoom.rows);
      // El token del preview CON sala sigue valiendo para el commit sin sala, y al revés.
      const r = await createPlan({ ...input, stateToken: withRoom.stateToken, rows: acceptDefaults(withRoom) });
      expect(r).toMatchObject({ ok: true });
      if (!r.ok) return;
      const rooms = await db.booking.findMany({ where: { programId: r.programId }, select: { roomId: true } });
      expect(rooms.every((b) => b.roomId === null)).toBe(true);
    } finally {
      await setFranjaRoom(room.roomId);
    }
  });

  it("sala archivada entre el preview y el commit → turnos sin sala (sede explícita), sin error", async () => {
    const patientId = await addPatient(db, K);
    const input = base(patientId, { startDayKey: "2030-05-06" });
    const p = await preview(input);
    await db.room.update({ where: { id: room.roomId }, data: { active: false } });
    try {
      const r = await createPlan({ ...input, stateToken: p.stateToken, rows: acceptDefaults(p) });
      expect(r).toMatchObject({ ok: true, idempotent: false });
      if (!r.ok) return;
      const bookings = await db.booking.findMany({ where: { programId: r.programId } });
      expect(bookings).toHaveLength(4);
      for (const b of bookings) {
        expect(b.roomId).toBeNull();
        expect(b.locationId).toBe(room.locationId);
      }
    } finally {
      await db.room.update({ where: { id: room.roomId }, data: { active: true } });
    }
  });

  it("SR-D3: no chequea ocupación — otro profesional ya ocupa la sala y el plan la estampa igual", async () => {
    // Un turno de otro profesional en la misma sala y hora (capacidad 1).
    const s = randomUUID().slice(0, 8);
    const userId = `test-user-${s}`;
    await db.userProfile.create({ data: { id: userId, email: `${userId}@test.local`, fullName: `Kine ${s}` } });
    const p2 = await db.practitioner.create({ data: { tenantId: K.tenantId, userId, specialty: "Test" } });
    await db.membership.create({ data: { userId, tenantId: K.tenantId, role: "PRACTITIONER", acceptedAt: new Date() } });
    const otherPatient = await addPatient(db, K);
    await db.booking.create({
      data: {
        tenantId: K.tenantId,
        practitionerId: p2.id,
        serviceId: K.serviceId,
        patientId: otherPatient,
        scheduledFor: new Date("2030-07-01T13:00:00.000Z"), // lunes 10:00 AR
        durationMin: 45,
        locationId: room.locationId,
        roomId: room.roomId,
        status: "CONFIRMED",
        idempotencyKey: `sr2b-${randomUUID()}`,
      },
    });
    const patientId = await addPatient(db, K);
    const input = base(patientId, { startDayKey: "2030-07-01", totalSessions: 2 });
    const p = await preview(input);
    const r = await createPlan({ ...input, stateToken: p.stateToken, rows: acceptDefaults(p) });
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    const first = await db.booking.findFirstOrThrow({
      where: { programId: r.programId, scheduledFor: new Date("2030-07-01T13:00:00.000Z") },
    });
    expect(first.practitionerId).toBe(K.practitionerId);
    expect(first.roomId).toBe(room.roomId);
    expect(first.isOverbooked).toBe(false);
  });

  // SR-D3: "este y los siguientes" pasa por el core (`applyBookingUpdateInTx`
  // con `capLocksHeld`), que es de SR2a. Cuerpo listo para el integrador en
  // scratchpad/sr2b-move-series-test.ts: plan lun 10:00 con la franja 9-13 en
  // la sala 1 y otra 13-17 en la sala 2 (misma sede) → mover desde la sesión 2
  // a las 14:00 → los turnos movidos llevan la sala 2 (sin chequear ocupación,
  // isOverbooked false) y el primero sigue en la sala 1.
  it("[SR-gate] movePlanSeries: la serie movida estampa la sala de la franja nueva sin chequear ocupación", async () => {
    // Franja de la tarde del lunes (13 a 17) en OTRA sala de la misma sede.
    const r2 = await addRoom(db, K, { name: "Consultorio 2", locationId: room.locationId });
    const extra = await db.practitionerSchedule.create({
      data: {
        tenantId: K.tenantId,
        practitionerId: K.practitionerId,
        locationId: room.locationId,
        roomId: r2.roomId,
        dow: 1,
        startMin: 780,
        endMin: 1020,
      },
    });
    try {
      const patientId = await addPatient(db, K);
      const input = base(patientId, {
        startDayKey: "2031-01-06", // lunes
        totalSessions: 3,
        schedule: { v: 1, frequency: "weekly", slots: [{ dow: 1, startMin: 600 }] },
      });
      const p = await preview(input);
      const c = await createPlan({ ...input, stateToken: p.stateToken, rows: acceptDefaults(p) });
      if (!c.ok) throw new Error(JSON.stringify(c));
      const sessions = await db.session.findMany({ where: { programId: c.programId }, orderBy: { index: "asc" } });
      const at = "2031-01-13T17:00:00.000Z"; // lunes 14:00 AR
      const mp = await previewMovePlanSeries({ programId: c.programId, fromSessionId: sessions[1].id, at });
      if (!mp.ok) throw new Error(mp.error);
      const r = await movePlanSeries({
        programId: c.programId,
        fromSessionId: sessions[1].id,
        at,
        rows: acceptDefaults(mp.preview),
        stateToken: mp.preview.stateToken,
      });
      expect(r).toMatchObject({ ok: true });
      const bs = await db.booking.findMany({ where: { programId: c.programId }, orderBy: { scheduledFor: "asc" } });
      expect(bs.map((b) => b.roomId)).toEqual([room.roomId, r2.roomId, r2.roomId]);
      for (const b of bs) {
        expect(b.locationId).toBe(room.locationId);
        expect(b.isOverbooked).toBe(false);
      }
    } finally {
      await db.practitionerSchedule.delete({ where: { id: extra.id } });
    }
  });

  it("la validación de salas suma a lo sumo 1 sentencia al commit (0 sin salas)", async () => {
    // Mismo plan (4 filas, mismas horas) en dos rangos de fechas disjuntos: sin y con sala.
    const run = async (startDayKey: string) => {
      const patientId = await addPatient(db, K);
      const input = base(patientId, { startDayKey });
      const p = await preview(input);
      const { result, m } = await measure(() => createPlan({ ...input, stateToken: p.stateToken, rows: acceptDefaults(p) }));
      expect(result).toMatchObject({ ok: true });
      return m.statements;
    };
    let without: number;
    try {
      await setFranjaRoom(null);
      without = await run("2030-09-02");
    } finally {
      await setFranjaRoom(room.roomId);
    }
    const withRoom = await run("2030-11-04");
    expect(withRoom - without).toBeGreaterThanOrEqual(0);
    expect(withRoom - without).toBeLessThanOrEqual(1);
  });
});
