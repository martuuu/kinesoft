/**
 * B3.1 AV-bookings — los write-paths de turnos conectados al motor de
 * disponibilidad (`lib/availability/*` + `lib/availability-loader.ts`).
 *
 * Contrato (bpre-design §C "Consumidores" + decisiones 1 y 2):
 *   • Alta / edición: avisos BLANDOS. Fuera de la franja del profesional →
 *     `{ ok:false, outOfHours }` salvo `allowOutOfHours`; sobre un bloqueo →
 *     `{ ok:false, blocked }` (con el motivo) salvo `allowBlocked`, y forzado
 *     queda como sobreturno (`isOverbooked` + prefijo `[SOBRETURNO]`).
 *   • Sugerencia (`nextFreeISO`) = `nextFreeSlot` del motor: respeta franjas,
 *     bloqueos y ve el turno EN CURSO (el suggest viejo no lo veía).
 *   • Batch: `count` validado con zod (1..60 entero), `frequency`
 *     weekly|biweekly|monthly, flags `outOfHours`/`blocked` por fecha.
 *   • Se escriben `isOverbooked`, `locationId` (validada contra el tenant y
 *     activa) y telemedicina (URL https).
 *   • `PractitionerService`: deshabilitado → rechazo; `durationMin` propio se
 *     usa cuando el caller no manda duración.
 *
 * Fixture: tenant con sede principal "Centro" + "Norte" + una archivada; el
 * profesional atiende lun-vie 9-13 en Centro y jue 14-18 en Norte.
 * Corre con los dos roles (kinesoft_app con RLS y owner BYPASSRLS).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { createBooking, createBookingsBatch, updateBooking } from "@/lib/bookings";
import { localToARIso } from "@/lib/datetime-ar";
import { lockCapacity } from "@/lib/booking-cap-lock";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  addService,
  sweepOrphanTestTenants,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

const ar = (day: string, hhmm: string) => new Date(localToARIso(`${day}T${hhmm}:00`)).toISOString();
const key = () => randomUUID();

describe.skipIf(!RUN)("turnos · motor de disponibilidad (B3.1)", () => {
  let db: PrismaClient;
  let C: EphemeralTenant;
  let D: EphemeralTenant;
  let centro: string;
  let norte: string;
  let archivada: string;
  let foreignLocation: string;
  /** Cupo 1, 60 min. */
  let osteoId: string;

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    C = await createEphemeralTenant(db);
    D = await createEphemeralTenant(db);
    osteoId = await addService(db, C, { name: "Osteopatía", durationMin: 60, maxConcurrent: 1 });
    centro = (await db.location.create({ data: { tenantId: C.tenantId, name: "Centro", isPrimary: true } })).id;
    norte = (await db.location.create({ data: { tenantId: C.tenantId, name: "Norte" } })).id;
    archivada = (await db.location.create({ data: { tenantId: C.tenantId, name: "Vieja", active: false } })).id;
    foreignLocation = (await db.location.create({ data: { tenantId: D.tenantId, name: "Ajena", isPrimary: true } })).id;
    await db.practitionerSchedule.createMany({
      data: [
        ...[1, 2, 3, 4, 5].map((dow) => ({
          tenantId: C.tenantId,
          practitionerId: C.practitionerId,
          locationId: centro,
          dow,
          startMin: 9 * 60,
          endMin: 13 * 60,
        })),
        { tenantId: C.tenantId, practitionerId: C.practitionerId, locationId: norte, dow: 4, startMin: 14 * 60, endMin: 18 * 60 },
      ],
    });
    asUser(C.userId);
  });

  afterAll(async () => {
    await C?.cleanup();
    await D?.cleanup();
    await db?.$disconnect();
  });

  const base = (patientId: string, when: string, extra: Record<string, unknown> = {}) => ({
    patientId,
    serviceId: C.serviceId,
    practitionerId: C.practitionerId,
    scheduledFor: when,
    durationMin: 45,
    idempotencyKey: key(),
    ...extra,
  });

  const block = (startsAt: string, endsAt: string, extra: Record<string, unknown> = {}) =>
    db.timeBlock.create({
      data: {
        tenantId: C.tenantId,
        practitionerId: C.practitionerId,
        startsAt: new Date(startsAt),
        endsAt: new Date(endsAt),
        createdById: C.userId,
        ...extra,
      },
    });

  // ── Fuera de horario (decisión 2: solo avisa) ─────────────────────────────
  it("fuera de la franja → outOfHours con sugerencia y sin escribir; con allowOutOfHours crea en la sede principal", async () => {
    const p = await addPatient(db, C);
    const when = ar("2027-09-06", "15:00"); // lunes, la franja es 9-13
    const r = await createBooking(base(p, when));
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(/fuera del horario/);
    expect("outOfHours" in r && r.outOfHours).toMatchObject({ nextFreeISO: ar("2027-09-07", "09:00") });
    expect("outOfHours" in r ? r.outOfHours?.practitionerName : "").not.toMatch(/@/);
    expect(await db.booking.count({ where: { patientId: p } })).toBe(0);

    const forced = await createBooking(base(p, when, { allowOutOfHours: true }));
    if (!forced.ok) throw new Error(forced.error);
    const row = await db.booking.findUniqueOrThrow({ where: { id: forced.data.id } });
    expect(row).toMatchObject({ locationId: centro, isOverbooked: false });
    expect(row.notes ?? "").not.toMatch(/SOBRETURNO/);

    // Editar solo las notas de un turno fuera de horario no vuelve a preguntar.
    expect((await updateBooking({ id: row.id, notes: "ok" })).ok).toBe(true);
  });

  it("domingo (sin franjas) → outOfHours", async () => {
    const p = await addPatient(db, C);
    const r = await createBooking(base(p, ar("2027-09-12", "10:00")));
    expect(r.ok).toBe(false);
    expect("outOfHours" in r && r.outOfHours).toBeTruthy();
  });

  it("dentro de la franja de otra sede → crea sin preguntar y la sede por defecto es la de la franja", async () => {
    const p = await addPatient(db, C);
    const r = await createBooking(base(p, ar("2027-09-09", "15:00"))); // jueves 14-18 en Norte
    if (!r.ok) throw new Error(r.error);
    expect((await db.booking.findUniqueOrThrow({ where: { id: r.data.id } })).locationId).toBe(norte);
  });

  // ── Bloqueos (decisión 1: confirmar como sobreturno) ──────────────────────
  it("sobre un bloqueo → blocked con el motivo; con allowBlocked crea como sobreturno (isOverbooked + prefijo)", async () => {
    const p = await addPatient(db, C);
    await block(ar("2027-09-14", "09:00"), ar("2027-09-14", "11:00"), { reason: "Congreso" });
    const when = ar("2027-09-14", "10:00");
    const r = await createBooking(base(p, when, { notes: "nota" }));
    expect(r.ok).toBe(false);
    expect("blocked" in r && r.blocked).toMatchObject({ reason: "Congreso", nextFreeISO: ar("2027-09-14", "11:00") });
    // Dentro del horario: no hay aviso de fuera de horario.
    expect("outOfHours" in r ? r.outOfHours : undefined).toBeUndefined();
    expect(await db.booking.count({ where: { patientId: p } })).toBe(0);

    // Solo allowBlocked alcanza (el bloqueo no se cuenta además como fuera de horario).
    const forced = await createBooking(base(p, when, { notes: "nota", allowBlocked: true }));
    if (!forced.ok) throw new Error(forced.error);
    const row = await db.booking.findUniqueOrThrow({ where: { id: forced.data.id } });
    expect(row.isOverbooked).toBe(true);
    expect(row.notes).toBe("[SOBRETURNO] nota");
  });

  it("un bloqueo de OTRO profesional no afecta", async () => {
    const other = await addPractitioner(db, C);
    const p = await addPatient(db, C);
    await block(ar("2027-09-16", "09:00"), ar("2027-09-16", "13:00"), { practitionerId: other.practitionerId, reason: "Ajeno" });
    const r = await createBooking(base(p, ar("2027-09-16", "10:00")));
    expect(r.ok).toBe(true);
  });

  // ── Sugerencia: motor nuevo ───────────────────────────────────────────────
  it("la sugerencia ve el turno EN CURSO y salta el bloqueo", async () => {
    const [p1, p2] = [await addPatient(db, C), await addPatient(db, C)];
    const osteo = (p: string, when: string) => base(p, when, { serviceId: osteoId, durationMin: 60 });
    expect((await createBooking(osteo(p1, ar("2027-09-15", "09:00")))).ok).toBe(true); // 9-10, cupo 1
    await block(ar("2027-09-15", "10:00"), ar("2027-09-15", "11:00"), { reason: "Reunión" });
    // 09:00-10:00 no toca el bloqueo (10-11): el aviso es de cupo.
    const r = await createBooking(osteo(p2, ar("2027-09-15", "09:00")));
    expect(r.ok).toBe(false);
    // El suggest viejo cargaba turnos desde 09:15 (from + 15): no veía el de
    // las 9 (en curso) y proponía 09:15. Ahora: 09:15-09:45 ocupados, 10:00
    // bloqueado → 11:00.
    expect("conflict" in r && r.conflict?.nextFreeISO).toBe(ar("2027-09-15", "11:00"));
  });

  // ── TOCTOU de cupo (lock de cupo por día, lib/booking-cap-lock.ts) ─────────
  it("dos altas concurrentes de pacientes DISTINTOS en un cupo 1 → exactamente una ok y la otra conflict", async () => {
    const [p1, p2] = [await addPatient(db, C), await addPatient(db, C)];
    const when = ar("2027-10-04", "10:00"); // lunes, dentro de la franja
    const osteo = (p: string) => base(p, when, { serviceId: osteoId, durationMin: 60 });
    const [r1, r2] = await Promise.all([createBooking(osteo(p1)), createBooking(osteo(p2))]);
    expect([r1.ok, r2.ok].filter(Boolean)).toHaveLength(1);
    const loser = r1.ok ? r2 : r1;
    expect("conflict" in loser && loser.conflict).toBeTruthy();
    expect(
      await db.booking.count({ where: { tenantId: C.tenantId, serviceId: osteoId, scheduledFor: new Date(when) } })
    ).toBe(1);
  });

  it("dos altas concurrentes que se SOLAPAN sin arrancar juntas (10:00 y 10:30, cupo 1) → una sola", async () => {
    const [p1, p2] = [await addPatient(db, C), await addPatient(db, C)];
    const osteo = (p: string, when: string) => base(p, when, { serviceId: osteoId, durationMin: 60 });
    const [r1, r2] = await Promise.all([
      createBooking(osteo(p1, ar("2027-10-06", "10:00"))),
      createBooking(osteo(p2, ar("2027-10-06", "10:30"))),
    ]);
    expect([r1.ok, r2.ok].filter(Boolean)).toHaveLength(1);
  });

  // ── updateBooking ─────────────────────────────────────────────────────────
  it("reprogramar sobre un bloqueo avisa; forzado queda isOverbooked y al moverlo a un hueco libre se limpia", async () => {
    const p = await addPatient(db, C);
    const r = await createBooking(base(p, ar("2027-09-17", "09:00")));
    if (!r.ok) throw new Error(r.error);
    await block(ar("2027-09-17", "12:00"), ar("2027-09-17", "13:00"), { practitionerId: null, reason: "Feriado" });

    const u = await updateBooking({ id: r.data.id, scheduledFor: ar("2027-09-17", "12:00") });
    expect(u.ok).toBe(false);
    expect("blocked" in u && u.blocked?.reason).toBe("Feriado");
    expect(+(await db.booking.findUniqueOrThrow({ where: { id: r.data.id } })).scheduledFor).toBe(+new Date(ar("2027-09-17", "09:00")));

    const forced = await updateBooking({ id: r.data.id, scheduledFor: ar("2027-09-17", "12:00"), allowBlocked: true });
    expect(forced.ok).toBe(true);
    expect((await db.booking.findUniqueOrThrow({ where: { id: r.data.id } })).isOverbooked).toBe(true);

    const back = await updateBooking({ id: r.data.id, scheduledFor: ar("2027-09-17", "10:00") });
    expect(back.ok).toBe(true);
    expect((await db.booking.findUniqueOrThrow({ where: { id: r.data.id } })).isOverbooked).toBe(false);
  });

  it("reprogramar fuera de horario avisa; con allowOutOfHours pasa", async () => {
    const p = await addPatient(db, C);
    const r = await createBooking(base(p, ar("2027-09-20", "09:00")));
    if (!r.ok) throw new Error(r.error);
    const u = await updateBooking({ id: r.data.id, scheduledFor: ar("2027-09-20", "18:00") });
    expect(u.ok).toBe(false);
    expect("outOfHours" in u && u.outOfHours).toBeTruthy();
    const forced = await updateBooking({ id: r.data.id, scheduledFor: ar("2027-09-20", "18:00"), allowOutOfHours: true });
    expect(forced.ok).toBe(true);
  });

  it("alargar un turno de cupo 1 no choca consigo mismo (excludeBookingId)", async () => {
    const p = await addPatient(db, C);
    const r = await createBooking(base(p, ar("2027-09-20", "11:00"), { serviceId: osteoId, durationMin: 60 }));
    if (!r.ok) throw new Error(r.error);
    expect((await updateBooking({ id: r.data.id, durationMin: 90 })).ok).toBe(true);
  });

  // ── Batch ─────────────────────────────────────────────────────────────────
  it("batch mensual: mismo día del mes ajustado al último, con flag outOfHours por fecha", async () => {
    const p = await addPatient(db, C);
    const payload = {
      ...base(p, ar("2027-01-31", "10:00")), // domingo
      count: 3,
      frequency: "monthly" as const,
    };
    const pre = await createBookingsBatch({ ...payload, dryRun: true });
    if (!pre.ok) throw new Error(pre.error);
    expect(pre.data.dates.map((d) => d.iso)).toEqual([
      ar("2027-01-31", "10:00"),
      ar("2027-02-28", "10:00"), // feb no tiene 31
      ar("2027-03-31", "10:00"), // vuelve al 31
    ]);
    expect(pre.data.dates.map((d) => d.outOfHours)).toEqual([true, true, false]); // dos domingos
    expect(pre.data.dates.map((d) => d.status)).toEqual(["libre", "libre", "libre"]);
    expect(pre.data).toMatchObject({ free: 3, conflicted: 0, duplicates: 0 });

    const run = await createBookingsBatch(payload);
    if (!run.ok) throw new Error(run.error);
    expect(run.data).toMatchObject({ created: 3, sobreturnos: 0 });
    const rows = await db.booking.findMany({ where: { patientId: p }, orderBy: { scheduledFor: "asc" } });
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.seriesId)).size).toBe(1);
    expect(rows.every((r) => r.locationId === centro)).toBe(true);
  });

  it("batch: una fecha sobre un bloqueo sale sobreturno con blocked; forzado escribe isOverbooked", async () => {
    const p = await addPatient(db, C);
    await block(ar("2027-10-05", "09:00"), ar("2027-10-05", "13:00"), { reason: "Licencia" });
    const payload = { ...base(p, ar("2027-10-05", "10:00")), count: 2 }; // martes, semanal (default)
    const pre = await createBookingsBatch({ ...payload, dryRun: true });
    if (!pre.ok) throw new Error(pre.error);
    expect(pre.data.dates.map((d) => [d.status, d.blocked, d.outOfHours])).toEqual([
      ["sobreturno", true, false],
      ["libre", false, false],
    ]);
    const run = await createBookingsBatch({ ...payload, allowOverbooking: true });
    if (!run.ok) throw new Error(run.error);
    expect(run.data).toMatchObject({ created: 2, sobreturnos: 1 });
    const rows = await db.booking.findMany({ where: { patientId: p }, orderBy: { scheduledFor: "asc" } });
    expect(rows.map((r) => r.isOverbooked)).toEqual([true, false]);
    expect(rows[0].notes).toMatch(/^\[SOBRETURNO\]/);
  });

  it("batch: count inválido (NaN, 0, 61, 1.5) o frecuencia desconocida → rechaza sin escribir", async () => {
    const p = await addPatient(db, C);
    for (const count of [Number.NaN, 0, 61, 1.5]) {
      const r = await createBookingsBatch({ ...base(p, ar("2027-10-11", "10:00")), count });
      expect(r.ok).toBe(false);
      expect(r.ok ? {} : r.fieldErrors).toHaveProperty("count");
    }
    const f = await createBookingsBatch({
      ...base(p, ar("2027-10-11", "10:00")),
      count: 2,
      frequency: "daily" as never,
    });
    expect(f.ok).toBe(false);
    expect(await db.booking.count({ where: { patientId: p } })).toBe(0);
  });

  it("batch cada 2 semanas: una semana sí y una no", async () => {
    const p = await addPatient(db, C);
    const pre = await createBookingsBatch({
      ...base(p, ar("2027-10-12", "10:00")), // martes
      count: 3,
      frequency: "biweekly",
      dryRun: true,
    });
    if (!pre.ok) throw new Error(pre.error);
    expect(pre.data.dates.map((d) => d.iso)).toEqual([
      ar("2027-10-12", "10:00"),
      ar("2027-10-26", "10:00"),
      ar("2027-11-09", "10:00"),
    ]);
  });

  // ── Sede ──────────────────────────────────────────────────────────────────
  it("locationId explícita: de otro tenant o archivada → rechaza sin escribir; válida → se guarda y se clasifica contra ESA sede", async () => {
    const p = await addPatient(db, C);
    const thu = ar("2027-09-23", "15:00"); // jueves 14-18 en Norte
    for (const locationId of [foreignLocation, archivada, "no-existe"]) {
      const r = await createBooking(base(p, thu, { locationId }));
      expect(r.ok).toBe(false);
      expect(r.ok ? "" : r.error).toMatch(/[Ss]ede/);
    }
    expect(await db.booking.count({ where: { patientId: p } })).toBe(0);

    // Lunes a la mañana trabaja en Centro: pedido en Norte es fuera de horario.
    const mon = await createBooking(base(p, ar("2027-09-27", "10:00"), { locationId: norte }));
    expect(mon.ok).toBe(false);
    expect("outOfHours" in mon && mon.outOfHours).toBeTruthy();

    const ok = await createBooking(base(p, thu, { locationId: norte }));
    if (!ok.ok) throw new Error(ok.error);
    expect((await db.booking.findUniqueOrThrow({ where: { id: ok.data.id } })).locationId).toBe(norte);
  });

  it("updateBooking con locationId de otro tenant → rechaza sin escribir", async () => {
    const p = await addPatient(db, C);
    const r = await createBooking(base(p, ar("2027-09-28", "09:00")));
    if (!r.ok) throw new Error(r.error);
    const u = await updateBooking({ id: r.data.id, locationId: foreignLocation });
    expect(u.ok).toBe(false);
    expect((await db.booking.findUniqueOrThrow({ where: { id: r.data.id } })).locationId).toBe(centro);
  });

  // ── Telemedicina ──────────────────────────────────────────────────────────
  it("telemedicina: URL https se guarda; http/javascript se rechazan; sin el flag la URL no se guarda", async () => {
    const p = await addPatient(db, C);
    const url = "https://meet.example.com/abc-def";
    const ok = await createBooking(base(p, ar("2027-09-29", "09:00"), { isTelemedicine: true, telemedicineUrl: url }));
    if (!ok.ok) throw new Error(ok.error);
    expect(await db.booking.findUniqueOrThrow({ where: { id: ok.data.id } })).toMatchObject({
      isTelemedicine: true,
      telemedicineUrl: url,
    });
    for (const bad of ["http://meet.example.com/x", "javascript:alert(1)", "no es url"]) {
      const r = await createBooking(base(p, ar("2027-09-29", "11:00"), { isTelemedicine: true, telemedicineUrl: bad }));
      expect(r.ok).toBe(false);
      expect(r.ok ? {} : r.fieldErrors).toHaveProperty("telemedicineUrl");
    }
    const noFlag = await createBooking(base(p, ar("2027-09-29", "12:00"), { telemedicineUrl: url, allowSamePatientDay: true }));
    if (!noFlag.ok) throw new Error(noFlag.error);
    expect(await db.booking.findUniqueOrThrow({ where: { id: noFlag.data.id } })).toMatchObject({
      isTelemedicine: false,
      telemedicineUrl: null,
    });
  });

  // ── PractitionerService ───────────────────────────────────────────────────
  it("servicio deshabilitado para el profesional → rechaza (alta y batch) sin escribir", async () => {
    const p = await addPatient(db, C);
    const svc = await addService(db, C, { name: "Drenaje", durationMin: 30 });
    await db.practitionerService.create({
      data: { tenantId: C.tenantId, practitionerId: C.practitionerId, serviceId: svc, enabled: false },
    });
    const r = await createBooking(base(p, ar("2027-09-30", "09:00"), { serviceId: svc }));
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(/no tiene habilitad/);
    const b = await createBookingsBatch({ ...base(p, ar("2027-09-30", "09:00"), { serviceId: svc }), count: 2 });
    expect(b.ok).toBe(false);
    expect(await db.booking.count({ where: { patientId: p } })).toBe(0);
  });

  it("duración propia del profesional (PractitionerService.durationMin) cuando el caller no manda duración", async () => {
    const p = await addPatient(db, C);
    const svc = await addService(db, C, { name: "RPG", durationMin: 60 });
    await db.practitionerService.create({
      data: { tenantId: C.tenantId, practitionerId: C.practitionerId, serviceId: svc, durationMin: 30 },
    });
    const { durationMin: _omit, ...noDuration } = base(p, ar("2027-10-01", "09:00"), { serviceId: svc });
    void _omit;
    const r = await createBooking(noDuration);
    if (!r.ok) throw new Error(r.error);
    expect((await db.booking.findUniqueOrThrow({ where: { id: r.data.id } })).durationMin).toBe(30);
    // Una duración explícita gana.
    const r2 = await createBooking(base(p, ar("2027-10-01", "11:00"), { serviceId: svc, durationMin: 45, allowSamePatientDay: true }));
    if (!r2.ok) throw new Error(r2.error);
    expect((await db.booking.findUniqueOrThrow({ where: { id: r2.data.id } })).durationMin).toBe(45);
  });
  // ── Carrera alta vs candado (integrador final de B-pre, handoff de B4.4) ──
  // El alta/edición/batch de la agenda clasificaba el bloqueo ANTES de tomar
  // el lock de cupo: un `applyDayLock` que commiteaba en el medio dejaba entrar
  // el turno como normal (sin `blocked`, sin sobreturno). Para reproducirlo sin
  // timing: este test toma el MISMO lock de cupo (profesional, servicio, día AR)
  // que toman `applyDayLock` y los write-paths, arranca la escritura (que ya
  // clasificó "libre" y queda esperando el lock), commitea el bloqueo y suelta.
  // Con el re-chequeo dentro del tx, la escritura ve el bloqueo.
  async function whileCapLockHeld<T>(dayKey: string, start: () => Promise<T>, meanwhile: () => Promise<unknown>) {
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let acquired!: () => void;
    const got = new Promise<void>((r) => (acquired = r));
    const holder = db.$transaction(
      async (t) => {
        await lockCapacity(t, { tenantId: C.tenantId, practitionerId: C.practitionerId, serviceId: C.serviceId, dayKey });
        acquired();
        await released;
      },
      { timeout: 20_000 }
    );
    await got;
    const pending = start();
    // Esperar a que la escritura esté BLOQUEADA en el advisory lock (ya pasó
    // la clasificación previa) antes de commitear el bloqueo.
    let waiting = false;
    for (let i = 0; i < 200 && !waiting; i++) {
      const [{ n }] = await db.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`;
      waiting = n > 0;
      if (!waiting) await new Promise((r) => setTimeout(r, 25));
    }
    expect(waiting).toBe(true);
    await meanwhile();
    release();
    await holder;
    return pending;
  }

  it("carrera: un bloqueo commiteado mientras el alta espera el lock de cupo → blocked, sin escribir", async () => {
    const p = await addPatient(db, C);
    const when = ar("2027-11-02", "10:00"); // martes, dentro de la franja
    const r = await whileCapLockHeld(
      "2027-11-02",
      () => createBooking(base(p, when)),
      () => block(ar("2027-11-02", "09:00"), ar("2027-11-02", "12:00"), { reason: "Candado" })
    );
    expect(r.ok).toBe(false);
    expect("blocked" in r && r.blocked).toMatchObject({ reason: "Candado" });
    expect(await db.booking.count({ where: { patientId: p } })).toBe(0);
    // Forzado queda como sobreturno (decisión 1).
    const forced = await createBooking(base(p, when, { allowBlocked: true }));
    if (!forced.ok) throw new Error(forced.error);
    expect((await db.booking.findUniqueOrThrow({ where: { id: forced.data.id } })).isOverbooked).toBe(true);
  });

  it("carrera: forzado con allowBlocked y el bloqueo aparece en vuelo → queda como sobreturno", async () => {
    const p = await addPatient(db, C);
    const when = ar("2027-11-03", "10:00");
    const r = await whileCapLockHeld(
      "2027-11-03",
      () => createBooking(base(p, when, { allowBlocked: true, notes: "n" })),
      () => block(ar("2027-11-03", "09:00"), ar("2027-11-03", "12:00"))
    );
    if (!r.ok) throw new Error(r.error);
    const row = await db.booking.findUniqueOrThrow({ where: { id: r.data.id } });
    expect(row.isOverbooked).toBe(true);
    expect(row.notes).toBe("[SOBRETURNO] n");
  });

  it("carrera: reprogramar mientras se commitea un bloqueo en el horario nuevo → blocked, sin mover", async () => {
    const p = await addPatient(db, C);
    const r0 = await createBooking(base(p, ar("2027-11-04", "09:00")));
    if (!r0.ok) throw new Error(r0.error);
    const u = await whileCapLockHeld(
      "2027-11-04",
      () => updateBooking({ id: r0.data.id, scheduledFor: ar("2027-11-04", "11:00") }),
      () => block(ar("2027-11-04", "10:30"), ar("2027-11-04", "12:30"), { reason: "Reunión" })
    );
    expect(u.ok).toBe(false);
    expect("blocked" in u && u.blocked).toMatchObject({ reason: "Reunión" });
    expect((await db.booking.findUniqueOrThrow({ where: { id: r0.data.id } })).scheduledFor.toISOString()).toBe(
      ar("2027-11-04", "09:00")
    );
  });

  it("carrera: batch con una fecha que se bloquea en vuelo → esa fecha se omite (sin allowOverbooking)", async () => {
    const p = await addPatient(db, C);
    const r = await whileCapLockHeld(
      "2027-11-05",
      () => createBookingsBatch({ ...base(p, ar("2027-11-05", "10:00")), count: 1, frequency: "weekly" as const }),
      () => block(ar("2027-11-05", "09:00"), ar("2027-11-05", "12:00"))
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.data).toMatchObject({ created: 0, omitted: 1 });
    expect(await db.booking.count({ where: { patientId: p } })).toBe(0);
  });
});
