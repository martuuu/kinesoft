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
    A = await createEphemeralTenant(owner);
    B = await createEphemeralTenant(owner);
    C = await createEphemeralTenant(owner);
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

  it("practitionerIds explícito: valida contra el tenant, no exige membresía aceptada; [] = ninguno", async () => {
    const r = await loadBoth({ tenantId: A.tenantId, practitionerIds: [pPending], from: FROM, to: TO });
    expect(r.templates.map((t) => t.practitionerId)).toEqual([pPending]);
    expect(r.blocks.map((b) => b.id)).toContain(ids.blkPending);
    const none = await loadBoth({ tenantId: A.tenantId, practitionerIds: [], from: FROM, to: TO });
    expect(none.templates).toEqual([]);
    expect(none.bookings).toEqual([]);
  });

  it("rechaza ventanas inválidas", async () => {
    await expect(loadAvailabilityInputs(prismaService, { tenantId: A.tenantId, from: "2027-02-30", to: TO })).rejects.toThrow(/from inválido/);
    await expect(loadAvailabilityInputs(prismaService, { tenantId: A.tenantId, from: TO, to: FROM })).rejects.toThrow(/from .* > to/);
  });
});
