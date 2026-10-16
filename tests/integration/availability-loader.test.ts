/**
 * `loadAvailabilityInputs` (B-pre B2.2 AV-loader) contra Postgres real.
 *
 * Qué se testea: el símbolo real del loader con los dos canales con que lo
 * llaman en prod — el `tx` de `runWithRls` (rol de la app; en
 * `test:integration` es `kinesoft_app` con RLS, en `:owner` el owner
 * BYPASSRLS = prod hoy) y `prismaService` (turnero público, BYPASSRLS
 * siempre). Que los dos devuelvan EXACTAMENTE lo mismo prueba que el
 * aislamiento no depende de RLS: cada query lleva `where: { tenantId }`.
 *
 * Fixtures: tenant-factory + filas creadas con el owner client (el código bajo
 * test no siembra). Ventana fija lun 01/03/2027 → dom 07/03/2027 (AR), lejos
 * de "hoy" para que nada dependa del reloj.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  addPatient,
  addService,
  addInsurer,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { runWithRls } from "@/lib/rls";
import { prismaService } from "@/lib/db";
import {
  loadAvailabilityInputs,
  NO_LOCATION_ID,
  type LoadAvailabilityParams,
  type LoadedAvailabilityInput,
} from "@/lib/availability-loader";
import {
  BOOKING_LOOKBACK_MIN,
  FALLBACK_TENANT_HOURS,
  type AvailabilityInput,
} from "@/lib/availability/types";
import { eligiblePractitioners, resolvePractitionerService } from "@/lib/availability/next-free";
import { dayLockState, scheduledRanges, workingRanges } from "@/lib/availability/ranges";
import { buildSlots } from "@/lib/availability/slots";
import { dayKeyRange } from "@/lib/availability/day";
import { defaultRoomFor, roomOccupancyAt } from "@/lib/availability/rooms";
import { addRoom } from "@/tests/helpers/tenant-factory";
import { PrismaClient as RawPrismaClient } from "@prisma/client";

const RUN = process.env.INTEGRATION === "1";

const FROM = "2027-03-01"; // lunes
const TO = "2027-03-07"; // domingo
const WINDOW_START = new Date("2027-03-01T00:00:00-03:00");
const WINDOW_END = new Date("2027-03-08T00:00:00-03:00");
const ar = (local: string) => new Date(`${local}:00-03:00`);
const minutesBefore = (d: Date, m: number) => new Date(d.getTime() - m * 60_000);

/** Carga por los dos canales y exige que coincidan. */
async function loadBoth(p: LoadAvailabilityParams): Promise<LoadedAvailabilityInput> {
  const viaRls = await runWithRls(p.tenantId, (tx) => loadAvailabilityInputs(tx, p));
  const viaService = await loadAvailabilityInputs(prismaService, p);
  expect(viaService).toEqual(viaRls);
  return viaRls;
}

describe.skipIf(!RUN)("loadAvailabilityInputs (B2.2)", () => {
  let owner: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let C: EphemeralTenant; // sin sede principal ni franjas
  let p2: string; // A: aceptado, sin franjas → fallback
  let pPending: string; // A: membresía pendiente
  let svc2: string; // A: segundo servicio
  let svcShared: string; // A: servicio del consultorio (practitionerId null), sin filas PS
  let osA: string; // A: obra social con fila PP inactiva para A.practitionerId
  let patientA: string;
  let patientB: string;
  const L: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const bIds = new Set<string>();

  async function booking(
    t: EphemeralTenant,
    data: {
      practitionerId?: string;
      serviceId?: string;
      patientId: string | null;
      scheduledFor: Date;
      locationId?: string | null;
      status?: "PENDING" | "CONFIRMED" | "CANCELLED";
      durationMin?: number;
    }
  ): Promise<string> {
    const b = await owner.booking.create({
      data: {
        tenantId: t.tenantId,
        practitionerId: data.practitionerId ?? t.practitionerId,
        serviceId: data.serviceId ?? t.serviceId,
        patientId: data.patientId,
        scheduledFor: data.scheduledFor,
        durationMin: data.durationMin ?? 45,
        status: data.status ?? "CONFIRMED",
        locationId: data.locationId ?? null,
        idempotencyKey: randomUUID(),
      },
    });
    return b.id;
  }

  beforeAll(async () => {
    owner = ownerClient();
    // PL-2f (C-PL1): salas y Sala de Espera son de Clínica / Libre; sin el plan, el motor ignora las salas.
    A = await createEphemeralTenant(owner, { saasPlan: "CLINICA" });
    B = await createEphemeralTenant(owner, { saasPlan: "CLINICA" });
    C = await createEphemeralTenant(owner, { saasPlan: "CLINICA" });
    await owner.tenant.update({ where: { id: A.tenantId }, data: { businessHoursStart: 9, businessHoursEnd: 17 } });
    // Horario inválido (invertido): el fallback usa el default 8-19.
    await owner.tenant.update({ where: { id: C.tenantId }, data: { businessHoursStart: 20, businessHoursEnd: 10 } });

    p2 = (await addPractitioner(owner, A)).practitionerId;
    // Membresía pendiente: no entra en "todos", sí si se lo pide por id.
    const s = uniqueSuffix();
    const pendingUser = `test-user-${s}`;
    await owner.userProfile.create({ data: { id: pendingUser, email: `${pendingUser}@test.local`, fullName: "Pend" } });
    pPending = (await owner.practitioner.create({ data: { tenantId: A.tenantId, userId: pendingUser } })).id;
    await owner.membership.create({ data: { userId: pendingUser, tenantId: A.tenantId, role: "PRACTITIONER" } });

    svc2 = await addService(owner, A, { durationMin: 60, maxConcurrent: 2 });
    patientA = await addPatient(owner, A);
    patientB = await addPatient(owner, B);

    // ── Sedes ──
    const loc = (t: EphemeralTenant, name: string, isPrimary: boolean, active = true) =>
      owner.location.create({ data: { tenantId: t.tenantId, name, isPrimary, active } }).then((l) => l.id);
    L.a1 = await loc(A, "Principal", true);
    L.a2 = await loc(A, "Norte", false);
    L.a3 = await loc(A, "Cerrada", false, false);
    L.b1 = await loc(B, "Principal B", true);
    bIds.add(L.b1);

    // ── Franjas ──
    const sched = (t: EphemeralTenant, practitionerId: string, locationId: string, dow: number, startMin: number, endMin: number, extra: { validFrom?: Date; validUntil?: Date } = {}) =>
      owner.practitionerSchedule.create({ data: { tenantId: t.tenantId, practitionerId, locationId, dow, startMin, endMin, ...extra } });
    await sched(A, A.practitionerId, L.a1, 1, 540, 780); // lun 9-13 principal
    await sched(A, A.practitionerId, L.a2, 2, 840, 1080); // mar 14-18 Norte
    await sched(A, A.practitionerId, L.a3, 3, 540, 720); // mié en sede inactiva → afuera
    await sched(A, A.practitionerId, L.a1, 4, 540, 600, { validUntil: new Date("2027-02-15T00:00:00Z") }); // vencida → afuera
    await sched(A, A.practitionerId, L.a1, 5, 540, 600, { validFrom: new Date("2027-03-05T00:00:00Z") }); // vigente desde el viernes
    const sb = await sched(B, B.practitionerId, L.b1, 1, 0, 1440);
    bIds.add(sb.id);

    // ── Excepciones ──
    const exA = await owner.scheduleException.create({
      data: { tenantId: A.tenantId, practitionerId: A.practitionerId, date: new Date("2027-03-02T00:00:00Z"), kind: "CLOSED", reason: "Congreso", createdById: A.userId },
    });
    ids.exClosed = exA.id;
    const exCustom = await owner.scheduleException.create({
      data: {
        tenantId: A.tenantId, practitionerId: null, date: new Date("2027-03-07T00:00:00Z"), kind: "CUSTOM_HOURS",
        // sin locationId → principal
        ranges: [{ startMin: 600, endMin: 720 }, { startMin: 780, endMin: 840, locationId: L.a2 }],
        reason: "Domingo especial", createdById: A.userId,
      },
    });
    ids.exCustom = exCustom.id;
    ids.exOutside = (await owner.scheduleException.create({
      data: { tenantId: A.tenantId, practitionerId: null, date: new Date("2027-03-08T00:00:00Z"), kind: "CLOSED", createdById: A.userId },
    })).id;
    const exB = await owner.scheduleException.create({
      data: { tenantId: B.tenantId, practitionerId: null, date: new Date("2027-03-03T00:00:00Z"), kind: "CLOSED", createdById: B.userId },
    });
    bIds.add(exB.id);

    // ── Bloqueos ──
    const block = (t: EphemeralTenant, data: { practitionerId?: string | null; locationId?: string | null; startsAt: Date; endsAt: Date; deletedAt?: Date }) =>
      owner.timeBlock.create({ data: { tenantId: t.tenantId, createdById: t.userId, practitionerId: data.practitionerId ?? null, locationId: data.locationId ?? null, startsAt: data.startsAt, endsAt: data.endsAt, deletedAt: data.deletedAt ?? null, reason: "Test" } }).then((b) => b.id);
    ids.blkAll = await block(A, { startsAt: ar("2027-03-04T10:00"), endsAt: ar("2027-03-04T12:00") });
    ids.blkPracNorte = await block(A, { practitionerId: A.practitionerId, locationId: L.a2, startsAt: ar("2027-03-02T14:00"), endsAt: ar("2027-03-02T15:00") });
    // Arranca antes de la ventana y la pisa: entra.
    ids.blkStraddle = await block(A, { practitionerId: p2, startsAt: ar("2027-02-28T20:00"), endsAt: ar("2027-03-01T10:00") });
    ids.blkDeleted = await block(A, { startsAt: ar("2027-03-03T10:00"), endsAt: ar("2027-03-03T11:00"), deletedAt: new Date() });
    ids.blkOutside = await block(A, { startsAt: ar("2027-03-08T00:00"), endsAt: ar("2027-03-08T10:00") }); // borde: no toca
    ids.blkPending = await block(A, { practitionerId: pPending, startsAt: ar("2027-03-05T10:00"), endsAt: ar("2027-03-05T11:00") });
    bIds.add(await block(B, { startsAt: ar("2027-03-01T10:00"), endsAt: ar("2027-03-01T12:00") }));

    // ── Turnos ──
    ids.bNullLoc = await booking(A, { patientId: patientA, scheduledFor: ar("2027-03-01T10:00"), locationId: null });
    ids.bNorte = await booking(A, { patientId: null, scheduledFor: ar("2027-03-02T15:00"), locationId: L.a2, status: "PENDING" });
    ids.bLookIn = await booking(A, { patientId: patientA, scheduledFor: minutesBefore(WINDOW_START, BOOKING_LOOKBACK_MIN - 40), durationMin: 300 });
    ids.bLookEdge = await booking(A, { patientId: patientA, scheduledFor: minutesBefore(WINDOW_START, BOOKING_LOOKBACK_MIN) });
    ids.bLookOut = await booking(A, { patientId: patientA, scheduledFor: minutesBefore(WINDOW_START, BOOKING_LOOKBACK_MIN + 1) });
    ids.bCancelled = await booking(A, { patientId: patientA, scheduledFor: ar("2027-03-03T10:00"), status: "CANCELLED" });
    ids.bLastMinute = await booking(A, { patientId: patientA, scheduledFor: ar("2027-03-07T23:15"), serviceId: svc2 });
    ids.bAfter = await booking(A, { patientId: patientA, scheduledFor: WINDOW_END });
    // Turno del paciente con OTRO profesional (p2): entra si se pide p2 o el paciente.
    ids.bPatientOther = await booking(A, { practitionerId: p2, patientId: patientA, scheduledFor: ar("2027-03-05T11:00") });
    bIds.add(await booking(B, { patientId: patientB, scheduledFor: ar("2027-03-01T10:00"), locationId: L.b1 }));
    ids.bC = await booking(C, { patientId: null, scheduledFor: ar("2027-03-02T09:00") });

    // ── PractitionerService ──
    await owner.practitionerService.create({ data: { tenantId: A.tenantId, practitionerId: A.practitionerId, serviceId: A.serviceId } });
    await owner.practitionerService.create({
      data: { tenantId: A.tenantId, practitionerId: A.practitionerId, serviceId: svc2, enabled: true, visibility: "PRIVATE", durationMin: 50, minLeadMinutes: 120, maxLeadDays: 30, concurrencyOverride: true, maxConcurrent: null },
    });
    await owner.practitionerService.create({ data: { tenantId: A.tenantId, practitionerId: p2, serviceId: A.serviceId, enabled: false } });
    // Servicio del consultorio SIN filas PractitionerService (alta entre el
    // deploy de M-agenda y B2.3): el default lo resuelve el motor.
    svcShared = (
      await owner.service.create({
        data: { tenantId: A.tenantId, practitionerId: null, name: "Compartido", durationMin: 30, priceCents: 1000 },
      })
    ).id;

    // ── PractitionerPayer ──
    osA = await addInsurer(owner, A, { name: "OS Loader" });
    await owner.practitionerPayer.create({ data: { tenantId: A.tenantId, practitionerId: A.practitionerId, insurerId: osA, active: false } });
    // Particular inactiva (dato viejo/roto): el loader la fuerza activa.
    await owner.practitionerPayer.create({ data: { tenantId: A.tenantId, practitionerId: A.practitionerId, insurerId: A.particularInsurerId, active: false } });
    const ppB = await owner.practitionerPayer.create({ data: { tenantId: B.tenantId, practitionerId: B.practitionerId, insurerId: B.particularInsurerId } });
    bIds.add(ppB.id);
    bIds.add(B.particularInsurerId);

    const psB = await owner.practitionerService.create({ data: { tenantId: B.tenantId, practitionerId: B.practitionerId, serviceId: B.serviceId } });
    bIds.add(psB.id);
    bIds.add(B.practitionerId);
    bIds.add(B.serviceId);
    bIds.add(patientB);
  });

  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await C?.cleanup();
    await owner?.$disconnect();
  });

  it("los dos canales devuelven lo mismo y nada del otro tenant", async () => {
    const r = await loadBoth({ tenantId: A.tenantId, from: FROM, to: TO });
    expect(r.tenantId).toBe(A.tenantId);
    expect(r.primaryLocationId).toBe(L.a1);
    expect(r.tenantHours).toEqual({ startMin: 540, endMin: 1020 });
    // Solo los aceptados, en orden de alta; el pendiente queda afuera.
    expect(r.templates.map((t) => t.practitionerId)).toEqual([A.practitionerId, p2]);
    const json = JSON.stringify(r);
    for (const id of bIds) expect(json).not.toContain(id);
    expect(r.services.map((s) => s.id).sort()).toEqual([A.serviceId, svc2, svcShared].sort());
    expect(r.services.find((s) => s.id === svc2)).toEqual({ id: svc2, durationMin: 60, maxConcurrent: 2, practitionerId: A.practitionerId });
    expect(r.services.find((s) => s.id === svcShared)).toMatchObject({ practitionerId: null });
    // Unificado con el contrato (integrador B2): el resultado ES un AvailabilityInput.
    const asContract: AvailabilityInput = r;
    expect(asContract.practitionerPayers).toBeDefined();
  });

  it("plantilla: sede inactiva y vigencias fuera de la ventana afuera; @db.Date → DayKey", async () => {
    const r = await loadBoth({ tenantId: A.tenantId, from: FROM, to: TO });
    const t = r.templates.find((x) => x.practitionerId === A.practitionerId)!;
    expect(t.isFallback).toBe(false);
    expect(t.ranges).toEqual([
      { dow: 1, startMin: 540, endMin: 780, locationId: L.a1, validFrom: null, validUntil: null },
      { dow: 2, startMin: 840, endMin: 1080, locationId: L.a2, validFrom: null, validUntil: null },
      { dow: 5, startMin: 540, endMin: 600, locationId: L.a1, validFrom: "2027-03-05", validUntil: null },
    ]);
  });

  it("profesional sin franjas → fallback lun-sáb con el horario del tenant en la principal", async () => {
    const r = await loadBoth({ tenantId: A.tenantId, from: FROM, to: TO });
    const t = r.templates.find((x) => x.practitionerId === p2)!;
    expect(t.isFallback).toBe(true);
    expect(t.ranges.map((x) => x.dow)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const x of t.ranges) {
      expect(x).toMatchObject({ startMin: 540, endMin: 1020, locationId: L.a1, validFrom: null, validUntil: null });
    }
  });

  it("tenant sin sede principal: primaryLocationId null, fallback y turnos con NO_LOCATION_ID; horario inválido → 8-19", async () => {
    const r = await loadBoth({ tenantId: C.tenantId, from: FROM, to: TO });
    expect(r.primaryLocationId).toBeNull();
    expect(r.tenantHours).toEqual({ ...FALLBACK_TENANT_HOURS });
    expect(r.templates).toHaveLength(1);
    expect(r.templates[0].isFallback).toBe(true);
    expect(r.templates[0].ranges.every((x) => x.locationId === NO_LOCATION_ID && x.startMin === 480 && x.endMin === 1140)).toBe(true);
    expect(r.bookings.map((b) => [b.id, b.locationId])).toEqual([[ids.bC, NO_LOCATION_ID]]);
  });

  it("turnos: no cancelados, lookback de 240 min, fin de ventana exclusivo, locationId null → principal", async () => {
    const r = await loadBoth({ tenantId: A.tenantId, practitionerIds: [A.practitionerId], from: FROM, to: TO });
    const got = r.bookings.map((b) => b.id);
    expect(got).toEqual([ids.bLookEdge, ids.bLookIn, ids.bNullLoc, ids.bNorte, ids.bLastMinute]);
    expect(got).not.toContain(ids.bLookOut);
    expect(got).not.toContain(ids.bCancelled);
    expect(got).not.toContain(ids.bAfter);
    const nullLoc = r.bookings.find((b) => b.id === ids.bNullLoc)!;
    expect(nullLoc).toMatchObject({
      locationId: L.a1,
      practitionerId: A.practitionerId,
      serviceId: A.serviceId,
      patientId: patientA,
      status: "CONFIRMED",
      paymentStatus: "UNPAID",
      durationMin: 45,
    });
    expect(nullLoc.scheduledFor).toBeInstanceOf(Date);
    expect(nullLoc.createdAt).toBeInstanceOf(Date);
    expect(typeof nullLoc.idempotencyKey).toBe("string");
    expect(r.bookings.find((b) => b.id === ids.bNorte)).toMatchObject({ locationId: L.a2, patientId: null, status: "PENDING" });
    // El turno del paciente con p2 no entra si no se pidió ni el profesional ni el paciente.
    expect(got).not.toContain(ids.bPatientOther);
  });

  it("patientId suma los turnos del paciente con otros profesionales", async () => {
    const r = await loadBoth({ tenantId: A.tenantId, practitionerIds: [A.practitionerId], patientId: patientA, from: FROM, to: TO });
    expect(r.bookings.map((b) => b.id)).toContain(ids.bPatientOther);
  });

  it("excepciones del rango (profesional + consultorio); CUSTOM normaliza la sede", async () => {
    const r = await loadBoth({ tenantId: A.tenantId, from: FROM, to: TO });
    expect(r.exceptions).toEqual([
      { id: ids.exClosed, practitionerId: A.practitionerId, date: "2027-03-02", kind: "CLOSED", ranges: null, reason: "Congreso" },
      {
        id: ids.exCustom, practitionerId: null, date: "2027-03-07", kind: "CUSTOM_HOURS", reason: "Domingo especial",
        ranges: [
          { startMin: 600, endMin: 720, locationId: L.a1 },
          { startMin: 780, endMin: 840, locationId: L.a2 },
        ],
      },
    ]);
    // Sin el profesional pedido, su excepción no viaja; la de consultorio sí.
    const only2 = await loadBoth({ tenantId: A.tenantId, practitionerIds: [p2], from: FROM, to: TO });
    expect(only2.exceptions.map((e) => e.id)).toEqual([ids.exCustom]);
  });

  it("bloqueos: los que tocan la ventana, sin borrados; null = todos", async () => {
    const r = await loadBoth({ tenantId: A.tenantId, from: FROM, to: TO });
    expect(r.blocks.map((b) => b.id)).toEqual([ids.blkStraddle, ids.blkPracNorte, ids.blkAll]);
    expect(r.blocks.find((b) => b.id === ids.blkAll)).toMatchObject({ practitionerId: null, locationId: null, allDay: false, reason: "Test", groupId: null });
    const only2 = await loadBoth({ tenantId: A.tenantId, practitionerIds: [p2], from: FROM, to: TO });
    expect(only2.blocks.map((b) => b.id)).toEqual([ids.blkStraddle, ids.blkAll]);
  });

  it("locationId acota franjas, CUSTOM y bloqueos (no los turnos)", async () => {
    const r = await loadBoth({ tenantId: A.tenantId, locationId: L.a2, from: FROM, to: TO });
    const t = r.templates.find((x) => x.practitionerId === A.practitionerId)!;
    expect(t.ranges.map((x) => x.locationId)).toEqual([L.a2]);
    // El fallback vive en la principal: en Norte no abre.
    expect(r.templates.find((x) => x.practitionerId === p2)!.ranges).toEqual([]);
    expect(r.exceptions.find((e) => e.id === ids.exCustom)!.ranges).toEqual([{ startMin: 780, endMin: 840, locationId: L.a2 }]);
    expect(r.blocks.map((b) => b.id)).toEqual([ids.blkStraddle, ids.blkPracNorte, ids.blkAll]);
    expect(r.bookings.map((b) => b.id)).toContain(ids.bNullLoc);
  });

  it("serviceId acota services y practitionerServices", async () => {
    const r = await loadBoth({ tenantId: A.tenantId, serviceId: svc2, from: FROM, to: TO });
    expect(r.services).toEqual([{ id: svc2, durationMin: 60, maxConcurrent: 2, practitionerId: A.practitionerId }]);
    expect(r.practitionerServices).toEqual([
      {
        practitionerId: A.practitionerId, serviceId: svc2, enabled: true, visibility: "PRIVATE", durationMin: 50,
        minLeadMinutes: 120, maxLeadDays: 30, concurrencyOverride: true, maxConcurrent: null,
      },
    ]);
    const all = await loadBoth({ tenantId: A.tenantId, from: FROM, to: TO });
    expect(all.practitionerServices).toHaveLength(3);
    expect(all.practitionerServices.find((x) => x.practitionerId === p2)).toMatchObject({ serviceId: A.serviceId, enabled: false });
  });

  // Integrador B2 (handoffs de B2.1b y B2.4b).
  it("practitionerPayers: filas del tenant y de los profesionales pedidos; Particular forzada activa", async () => {
    const r = await loadBoth({ tenantId: A.tenantId, from: FROM, to: TO });
    const rows = [...r.practitionerPayers].sort((a, b) => a.insurerId.localeCompare(b.insurerId));
    expect(rows).toEqual(
      [
        { practitionerId: A.practitionerId, insurerId: osA, active: false },
        { practitionerId: A.practitionerId, insurerId: A.particularInsurerId, active: true },
      ].sort((a, b) => a.insurerId.localeCompare(b.insurerId))
    );
    const only2 = await loadBoth({ tenantId: A.tenantId, practitionerIds: [p2], from: FROM, to: TO });
    expect(only2.practitionerPayers).toEqual([]);
    // Sin fila = aceptada: p2 (sin filas) acepta osA; A.practitionerId la tiene inactiva.
    expect(
      eligiblePractitioners({
        practitionerIds: [A.practitionerId, p2],
        serviceId: svcShared,
        insurerId: osA,
        practitionerServices: r.practitionerServices,
        practitionerPayers: r.practitionerPayers,
        services: r.services,
      })
    ).toEqual([p2]);
    expect(
      eligiblePractitioners({
        practitionerIds: [A.practitionerId, p2],
        serviceId: svcShared,
        insurerId: A.particularInsurerId,
        practitionerServices: r.practitionerServices,
        practitionerPayers: r.practitionerPayers,
        services: r.services,
      })
    ).toEqual([A.practitionerId, p2]);
  });

  it("servicio sin fila PS: del consultorio → habilitado para todos; de un profesional → solo él (criterio de Configuración)", async () => {
    const r = await loadBoth({ tenantId: A.tenantId, from: FROM, to: TO });
    const shared = r.services.find((s) => s.id === svcShared)!;
    for (const pid of [A.practitionerId, p2]) {
      expect(r.practitionerServices.some((x) => x.practitionerId === pid && x.serviceId === svcShared)).toBe(false);
      expect(resolvePractitionerService(undefined, shared, pid)).toMatchObject({ enabled: true, visibility: "PUBLIC", durationMin: 30 });
    }
    expect(
      eligiblePractitioners({
        practitionerIds: [A.practitionerId, p2],
        serviceId: svcShared,
        practitionerServices: r.practitionerServices,
        services: r.services,
        publicOnly: true,
      })
    ).toEqual([A.practitionerId, p2]);
    // svc2 es de A.practitionerId: p2 no tiene fila → deshabilitado (ajeno).
    expect(
      eligiblePractitioners({
        practitionerIds: [A.practitionerId, p2],
        serviceId: svc2,
        practitionerServices: r.practitionerServices,
        services: r.services,
      })
    ).toEqual([A.practitionerId]);
    // Fila explícita gana: p2 tiene A.serviceId deshabilitado aunque no sea suyo.
    expect(
      eligiblePractitioners({
        practitionerIds: [A.practitionerId, p2],
        serviceId: A.serviceId,
        practitionerServices: r.practitionerServices,
        services: r.services,
      })
    ).toEqual([A.practitionerId]);
  });

  it("aislamiento: ids de otro tenant se descartan (profesional, servicio, sede, paciente)", async () => {
    const r = await loadBoth({
      tenantId: A.tenantId,
      practitionerIds: [B.practitionerId, A.practitionerId],
      serviceId: B.serviceId,
      patientId: patientB,
      from: FROM,
      to: TO,
    });
    expect(r.templates.map((t) => t.practitionerId)).toEqual([A.practitionerId]);
    expect(r.services).toEqual([]);
    expect(r.practitionerServices).toEqual([]);
    expect(r.practitionerPayers.every((p) => p.practitionerId === A.practitionerId)).toBe(true);
    const json = JSON.stringify(r);
    for (const id of bIds) expect(json).not.toContain(id);

    const foreignLoc = await loadBoth({ tenantId: A.tenantId, locationId: L.b1, from: FROM, to: TO });
    expect(foreignLoc.templates.every((t) => t.ranges.length === 0)).toBe(true);
    expect(foreignLoc.blocks.every((b) => b.locationId === null)).toBe(true);
    expect(JSON.stringify(foreignLoc)).not.toContain(L.b1);

    // Solo ids ajenos → ningún profesional, y ningún turno de B.
    const onlyB = await loadBoth({ tenantId: A.tenantId, practitionerIds: [B.practitionerId], from: FROM, to: TO });
    expect(onlyB.templates).toEqual([]);
    expect(onlyB.bookings).toEqual([]);
  });

  // IAM-4b: cambia el contrato de B2.2 («con ids explícitos no exige membresía
  // aceptada»). Un id explícito pasa por `bookablePractitionerWhere`, igual que
  // «todos»: la Secretaria, un suspendido o un pendiente pedidos por id
  // ofrecían slots con el horario de fallback del consultorio.
  it("[IAM-4b] practitionerIds explícito: solo reservables (un pendiente no trae plantilla ni bloqueos); [] = ninguno", async () => {
    const r = await loadBoth({ tenantId: A.tenantId, practitionerIds: [pPending], from: FROM, to: TO });
    expect(r.templates).toEqual([]);
    expect(r.blocks.map((b) => b.id)).not.toContain(ids.blkPending);
    const none = await loadBoth({ tenantId: A.tenantId, practitionerIds: [], from: FROM, to: TO });
    expect(none.templates).toEqual([]);
    expect(none.bookings).toEqual([]);
  });

  it("rechaza ventanas inválidas", async () => {
    await expect(loadAvailabilityInputs(prismaService, { tenantId: A.tenantId, from: "2027-02-30", to: TO })).rejects.toThrow(/from inválido/);
    await expect(loadAvailabilityInputs(prismaService, { tenantId: A.tenantId, from: TO, to: FROM })).rejects.toThrow(/from .* > to/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SR1a (corrida SR, M4): salas en el loader. Tenant propio para no mover los
// fixtures de arriba. Misma ventana lun 01/03/2027 → dom 07/03/2027.
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!RUN)("loadAvailabilityInputs: salas (SR1a)", () => {
  let owner: PrismaClient;
  let D: EphemeralTenant;
  let p2: string;
  const L: Record<string, string> = {};
  const R: Record<string, string> = {};
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    owner = ownerClient();
    D = await createEphemeralTenant(owner, { saasPlan: "CLINICA" });
    p2 = (await addPractitioner(owner, D)).practitionerId;
    L.main = (await owner.location.create({ data: { tenantId: D.tenantId, name: "Principal", isPrimary: true } })).id;
    L.norte = (await owner.location.create({ data: { tenantId: D.tenantId, name: "Norte", isPrimary: false } })).id;
    R.c1 = (await addRoom(owner, D, { locationId: L.main, name: "Consultorio 1" })).roomId;
    R.c2 = (await addRoom(owner, D, { locationId: L.main, name: "Consultorio 2" })).roomId;
    R.n1 = (await addRoom(owner, D, { locationId: L.norte, name: "Box Norte" })).roomId;

    const sched = (practitionerId: string, locationId: string, dow: number, startMin: number, endMin: number, roomId: string | null) =>
      owner.practitionerSchedule.create({ data: { tenantId: D.tenantId, practitionerId, locationId, dow, startMin, endMin, roomId } });
    await sched(D.practitionerId, L.main, 1, 540, 780, R.c1); // lun 9-13 Consultorio 1
    await sched(D.practitionerId, L.main, 1, 900, 1140, null); // lun 15-19 sin sala
    await sched(p2, L.main, 1, 540, 780, R.c2); // lun 9-13 Consultorio 2
    await sched(p2, L.norte, 4, 540, 780, R.n1); // jue 9-13 Box Norte

    const exception = (practitionerId: string | null, date: string, ranges: unknown) =>
      owner.scheduleException
        .create({
          data: { tenantId: D.tenantId, practitionerId, date: new Date(`${date}T00:00:00Z`), kind: "CUSTOM_HOURS", ranges: ranges as object, createdById: D.userId },
        })
        .then((e) => e.id);
    ids.exRoom = await exception(D.practitionerId, "2027-03-02", [
      { startMin: 600, endMin: 720, locationId: L.main, roomId: R.c2 },
      { startMin: 780, endMin: 840 },
    ]);
    // roomId con forma inválida (escritor viejo / dato roto): el día NO se cierra, la franja queda sin sala.
    ids.exBadRoom = await exception(D.practitionerId, "2027-03-03", [{ startMin: 600, endMin: 720, roomId: 123 }]);

    const booking = (practitionerId: string, at: Date, roomId: string | null, locationId: string | null) =>
      owner.booking
        .create({
          data: {
            tenantId: D.tenantId, practitionerId, serviceId: D.serviceId, patientId: null, scheduledFor: at, durationMin: 60,
            status: "CONFIRMED", locationId, roomId, idempotencyKey: randomUUID(),
          },
        })
        .then((b) => b.id);
    ids.bRoom = await booking(D.practitionerId, ar("2027-03-01T10:00"), R.c1, L.main);
    ids.bOtherRoom = await booking(p2, ar("2027-03-01T10:00"), R.c2, L.main);
    ids.bNoRoom = await booking(p2, ar("2027-03-01T11:00"), null, null);

    // Bloqueo "de todos" común (no de sala): tiene que seguir en `blocks`.
    ids.blkAll = await owner.timeBlock
      .create({ data: { tenantId: D.tenantId, createdById: D.userId, startsAt: ar("2027-03-03T10:00"), endsAt: ar("2027-03-03T11:00"), reason: "Reunión" } })
      .then((b) => b.id);
  });

  afterAll(async () => {
    await D?.cleanup();
    await owner?.$disconnect();
  });

  /** Bloqueo de SALA (CHECK: locationId explícito, practitionerId null). */
  const roomBlock = (roomId: string, locationId: string, startsAt: Date, endsAt: Date, reason: string | null) =>
    owner.timeBlock
      .create({ data: { tenantId: D.tenantId, createdById: D.userId, practitionerId: null, locationId, roomId, startsAt, endsAt, reason } })
      .then((b) => b.id);

  it("roomId en franjas (solo si tiene sala), en las excepciones y en los turnos", async () => {
    const r = await loadBoth({ tenantId: D.tenantId, from: FROM, to: TO });
    expect(r.templates.find((t) => t.practitionerId === D.practitionerId)!.ranges).toEqual([
      { dow: 1, startMin: 540, endMin: 780, locationId: L.main, roomId: R.c1, validFrom: null, validUntil: null },
      { dow: 1, startMin: 900, endMin: 1140, locationId: L.main, validFrom: null, validUntil: null },
    ]);
    expect(r.exceptions.find((e) => e.id === ids.exRoom)!.ranges).toEqual([
      { startMin: 600, endMin: 720, locationId: L.main, roomId: R.c2 },
      { startMin: 780, endMin: 840, locationId: L.main },
    ]);
    // Dato roto en roomId: la franja sigue abierta, sin sala.
    expect(r.exceptions.find((e) => e.id === ids.exBadRoom)!.ranges).toEqual([{ startMin: 600, endMin: 720, locationId: L.main }]);
    expect(r.bookings.map((b) => [b.id, b.roomId])).toEqual([
      [ids.bRoom, R.c1],
      [ids.bOtherRoom, R.c2],
      [ids.bNoRoom, null],
    ]);
    expect(r.roomBlocks).toEqual([]);

    // De punta a punta con el motor: sala por defecto y ocupación.
    expect(defaultRoomFor(r, D.practitionerId, ar("2027-03-01T10:00"), 45, null)).toBe(R.c1);
    expect(defaultRoomFor(r, D.practitionerId, ar("2027-03-02T10:30"), 45, L.main)).toBe(R.c2); // la excepción manda
    expect(defaultRoomFor(r, D.practitionerId, ar("2027-03-01T16:00"), 45, null)).toBeNull();
    const occ = roomOccupancyAt(r.bookings, {
      roomId: R.c2, practitionerId: D.practitionerId, when: ar("2027-03-01T10:30"), durationMin: 60, capacity: 1, now: WINDOW_START,
    });
    expect(occ).toMatchObject({ used: 1, atCapacity: true, practitionerIds: [p2], blocked: null });
  });

  it("bloqueo de sala: sale de `blocks`, va a `roomBlocks` y no cambia los slots de NINGÚN profesional (no regresión §17.5)", async () => {
    const before = await loadBoth({ tenantId: D.tenantId, from: FROM, to: TO });
    const rb = await roomBlock(R.c1, L.main, ar("2027-03-01T09:00"), ar("2027-03-01T13:00"), "Mantenimiento");
    const rbAllDay = await roomBlock(R.n1, L.norte, ar("2027-03-04T00:00"), ar("2027-03-05T00:00"), null);
    try {
      const after = await loadBoth({ tenantId: D.tenantId, from: FROM, to: TO });
      // Los bloqueos de profesionales/consultorio, idénticos (y el de "todos" sigue).
      expect(after.blocks).toEqual(before.blocks);
      expect(after.blocks.map((b) => b.id)).toEqual([ids.blkAll]);
      expect(after.roomBlocks).toEqual([
        { id: rb, roomId: R.c1, startsAt: ar("2027-03-01T09:00"), endsAt: ar("2027-03-01T13:00"), reason: "Mantenimiento" },
        { id: rbAllDay, roomId: R.n1, startsAt: ar("2027-03-04T00:00"), endsAt: ar("2027-03-05T00:00"), reason: null },
      ]);
      // Nada de la fila de sala se cuela en `blocks` (practitionerId null = "todos").
      expect(JSON.stringify(after.blocks)).not.toContain(rb);

      // Franjas, candado y grilla de turnos de todos, día por día: idénticos.
      for (const day of dayKeyRange(FROM, TO)) {
        for (const pid of [D.practitionerId, p2]) {
          expect(scheduledRanges(pid, day, after)).toEqual(scheduledRanges(pid, day, before));
          expect(workingRanges(pid, day, after)).toEqual(workingRanges(pid, day, before));
          expect(dayLockState(pid, day, after)).toEqual(dayLockState(pid, day, before));
          const slots = (input: LoadedAvailabilityInput) =>
            buildSlots({
              dayKey: day, ranges: workingRanges(pid, day, input), stepMin: 15, durationMin: 45,
              lead: { minMinutes: 0, maxDays: null }, now: WINDOW_START,
              bookings: input.bookings.filter((b) => b.practitionerId === pid), cap: 1,
            });
          expect(slots(after)).toEqual(slots(before));
        }
        expect(dayLockState(null, day, after)).toEqual(dayLockState(null, day, before));
      }
      // Y la sala sí queda llena por el bloqueo; la sala por defecto no se mueve.
      expect(defaultRoomFor(after, D.practitionerId, ar("2027-03-01T10:00"), 45, null)).toBe(R.c1);
      expect(
        roomOccupancyAt([], { roomId: R.c1, practitionerId: D.practitionerId, when: ar("2027-03-01T10:00"), durationMin: 45, capacity: 5, now: WINDOW_START }, after.roomBlocks)
      ).toMatchObject({ atCapacity: true, blocked: { blockId: rb, reason: "Mantenimiento" } });

      // Con filtro de sede: solo los bloqueos de sala de esa sede.
      const norte = await loadBoth({ tenantId: D.tenantId, locationId: L.norte, from: FROM, to: TO });
      expect(norte.roomBlocks!.map((b) => b.id)).toEqual([rbAllDay]);
      expect(norte.blocks.map((b) => b.id)).toEqual([ids.blkAll]);
    } finally {
      await owner.timeBlock.deleteMany({ where: { id: { in: [rb, rbAllDay] } } });
    }
  });

  it("no suma statements: las salas viajan como columnas de las mismas sentencias y nadie consulta Room", async () => {
    const url = process.env.DATABASE_URL_SERVICE ?? process.env.DIRECT_URL ?? process.env.DATABASE_URL;
    const counted = new RawPrismaClient({ ...(url ? { datasources: { db: { url } } } : {}), log: [{ emit: "event", level: "query" }] });
    const sql: string[] = [];
    counted.$on("query" as never, (e: { query: string }) => sql.push(e.query));
    const rb = await roomBlock(R.c1, L.main, ar("2027-03-01T09:00"), ar("2027-03-01T13:00"), "Conteo");
    try {
      // PF-Z: los eventos `query` del engine de Prisma llegan por un canal aparte y pueden entregarse DESPUÉS de que
      // resuelve la promesa de la query. Con `sql.length = 0` a secas, el último evento de una corrida caía en la
      // siguiente (11 vs 10, intermitente; visto en `test:integration:owner` el 16-oct, sin cambios en el loader ni
      // en este test desde PL-Z). Se delimita cada corrida con una sentencia marcadora y se espera a verla en el log.
      const marker = async (tag: string) => {
        await counted.$queryRawUnsafe(`SELECT '${tag}' AS marker`);
        for (let i = 0; i < 200 && !sql.some((q) => q.includes(`'${tag}'`)); i++) await new Promise((r) => setTimeout(r, 5));
      };
      let seq = 0;
      const count = async (p: LoadAvailabilityParams) => {
        const start = `count-start-${++seq}`;
        const end = `count-end-${seq}`;
        await marker(start);
        await loadAvailabilityInputs(counted, p);
        await marker(end);
        const from = sql.findIndex((q) => q.includes(`'${start}'`));
        const to = sql.findIndex((q) => q.includes(`'${end}'`));
        expect(from).toBeGreaterThanOrEqual(0);
        expect(to).toBeGreaterThan(from);
        return sql.slice(from + 1, to);
      };
      const full = await count({ tenantId: D.tenantId, from: FROM, to: TO });
      // Ninguna sentencia a la tabla Room (ni join ni query de relación).
      expect(full.some((q) => /"Room"/.test(q))).toBe(false);
      // roomId se pide en las sentencias que ya existían.
      const roomIdIn = (table: string) => full.filter((q) => q.includes(`FROM "public"."${table}"`) && q.includes(`"${table}"."roomId"`)).length;
      expect(roomIdIn("PractitionerSchedule")).toBe(1);
      expect(roomIdIn("TimeBlock")).toBe(1);
      expect(roomIdIn("Booking")).toBe(1);
      // Una sentencia por tabla de la fase 2 (con el bloqueo de sala adentro, igual que sin él).
      for (const table of ["PractitionerSchedule", "ScheduleException", "TimeBlock", "Booking"]) {
        expect(full.filter((q) => q.includes(`FROM "public"."${table}"`)).length).toBe(1);
      }
      // Mismo número que sin bloqueos de sala: el bloqueo de sala no agrega nada.
      await owner.timeBlock.update({ where: { id: rb }, data: { deletedAt: new Date() } });
      const withoutRoomBlock = await count({ tenantId: D.tenantId, from: FROM, to: TO });
      expect(withoutRoomBlock.length).toBe(full.length);
    } finally {
      await owner.timeBlock.deleteMany({ where: { id: rb } });
      await counted.$disconnect();
    }
  });
});
