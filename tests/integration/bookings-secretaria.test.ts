/**
 * Secretaria en turnos (Planes E1, sesión S07sb, ola P0.2).
 *
 * Contrato (PLANES.md §P0.2, C8 "contrato Secretaria"):
 *   - gate de create / batch / update / status / cancelación =
 *     `canOperateBooking(caps, access)` = `full || agenda.operateAll` (un turno
 *     guest sigue operable);
 *   - `bookingFieldAccess` saca del patch los campos que el actor no puede
 *     leer ANTES del write y del audit ("un campo se escribe si y solo si se
 *     puede leer");
 *   - el `copagoCents` de un actor sin full se ignora (rige lib/copago.ts);
 *   - re-vínculo sin `clinical.read`: guest → paciente sí; paciente → paciente
 *     solo si título, descripción y notas (sin `[SOBRETURNO]`) están vacíos;
 *   - `deleteBooking` y los toggles de cobro siguen exigiendo full.
 *
 * Desde PD-13 (S02p) la Secretaria (ASSISTANT) tiene SIEMPRE el nivel `admin`
 * sobre los pacientes del tenant: nunca full. Antes de S07sb eso la dejaba en
 * solo lectura en toda la agenda.
 *
 * Este archivo entra en la prueba de paridad de S07c (ES2b): tiene que pasar
 * SIN cambios cuando el cuerpo de `updateBooking` se mude a
 * `applyBookingUpdateInTx`. Por eso afirma sobre la fila y el audit, no sobre
 * detalles internos.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  createBooking,
  createBookingsBatch,
  updateBooking,
  setBookingStatus,
  deleteBooking,
  setBookingCopagoPaid,
  setBookingInsurerPaid,
  listAgendaBookings,
  listBookingsInRange,
} from "@/lib/bookings";
import { localToARIso } from "@/lib/datetime-ar";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

const ar = (day: string, hhmm: string) => new Date(localToARIso(`${day}T${hhmm}:00`)).toISOString();
const key = () => randomUUID();

describe.skipIf(!RUN)("Secretaria en turnos (P0-S07sb)", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  /** Profesional con el paciente a cargo (acceso full). */
  let kine: { userId: string; practitionerId: string };
  /** Otro profesional, sin asignación ni share (acceso basic). */
  let other: { userId: string; practitionerId: string };
  let assistant: { userId: string; practitionerId: string };
  let billing: { userId: string; practitionerId: string };
  let pat: string;
  let pat2: string;

  beforeAll(async () => {
    db = ownerClient();
    // Sin "Consultorio común": el acceso sale de la asignación (y del nivel admin de PD-13).
    T = await createEphemeralTenant(db);
    kine = await addPractitioner(db, T, "PRACTITIONER");
    other = await addPractitioner(db, T, "PRACTITIONER");
    assistant = await addPractitioner(db, T, "ASSISTANT");
    billing = await addPractitioner(db, T, "BILLING");
    pat = await addPatient(db, T, { assignedPractitionerId: kine.practitionerId });
    pat2 = await addPatient(db, T, { assignedPractitionerId: kine.practitionerId });
    await db.patient.update({
      where: { id: pat },
      data: { diagnosisTitle: "Lumbalgia", diagnosisNote: "Dolor lumbar crónico" },
    });
    await db.coverage.create({ data: { patientId: pat, insurer: "OSDE", copagoCents: 777 } });
  });

  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });

  /** Turno sembrado con el owner client (no pasa por ningún gate). */
  async function seedBooking(data: {
    patientId?: string | null;
    day: string;
    hhmm?: string;
    title?: string | null;
    description?: string | null;
    notes?: string | null;
    guestName?: string;
    status?: "PENDING" | "CONFIRMED";
  }) {
    return db.booking.create({
      data: {
        tenantId: T.tenantId,
        patientId: data.patientId ?? null,
        guestName: data.guestName,
        practitionerId: T.practitionerId,
        serviceId: T.serviceId,
        scheduledFor: new Date(ar(data.day, data.hhmm ?? "10:00")),
        durationMin: 45,
        status: data.status ?? (data.patientId ? "CONFIRMED" : "PENDING"),
        title: data.title ?? null,
        description: data.description ?? null,
        notes: data.notes ?? null,
        idempotencyKey: key(),
      },
    });
  }

  const v = (d: Date) => d.toISOString();

  it("[P0-S07sb] ASSISTANT con acceso básico reprograma, cambia estado y cancela", async () => {
    const b = await seedBooking({ patientId: pat, day: "2031-03-03", title: "Lumbalgia", notes: "dolor al flexionar" });
    asUser(assistant.userId);

    const moved = await updateBooking({ id: b.id, scheduledFor: ar("2031-03-03", "11:00"), expectedUpdatedAt: v(b.updatedAt) });
    expect(moved).toMatchObject({ ok: true });
    const v1 = moved.ok ? v(moved.data.updatedAt) : "";

    const done = await setBookingStatus(b.id, "NO_SHOW", v1);
    expect(done).toMatchObject({ ok: true });
    const v2 = done.ok ? v(done.data.updatedAt) : "";

    const cancelled = await setBookingStatus(b.id, "CANCELLED", v2);
    expect(cancelled).toMatchObject({ ok: true });

    const row = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(row.scheduledFor.toISOString()).toBe(ar("2031-03-03", "11:00"));
    expect(row.status).toBe("CANCELLED");
    // Lo clínico no se tocó (ni lo ve).
    expect(row.title).toBe("Lumbalgia");
    expect(row.notes).toBe("dolor al flexionar");
  });

  it("[P0-S07sb] ASSISTANT crea turno y batch para un paciente en `admin`: el título sale del diagnóstico, sus notas no se escriben", async () => {
    asUser(assistant.userId);
    const r = await createBooking({
      patientId: pat,
      serviceId: T.serviceId,
      practitionerId: T.practitionerId,
      scheduledFor: ar("2031-03-04", "10:00"),
      title: "Pisado",
      description: "Pisado",
      notes: "nota de la Secretaria",
      idempotencyKey: key(),
    });
    expect(r).toMatchObject({ ok: true });
    const row = await db.booking.findUniqueOrThrow({ where: { id: r.ok ? r.data.id : "" } });
    // El auto-completado es del diagnóstico del paciente, no del actor.
    expect(row.title).toBe("Lumbalgia");
    expect(row.description).toBe("Dolor lumbar crónico");
    expect(row.notes).toBeNull();
    expect(row.status).toBe("CONFIRMED");

    const batch = await createBookingsBatch({
      patientId: pat2,
      serviceId: T.serviceId,
      practitionerId: T.practitionerId,
      scheduledFor: ar("2031-03-05", "10:00"),
      count: 2,
      notes: "nota batch",
      title: "Pisado",
      idempotencyKey: key(),
    });
    expect(batch).toMatchObject({ ok: true, data: { created: 2 } });
    const rows = await db.booking.findMany({ where: { patientId: pat2, tenantId: T.tenantId } });
    expect(rows).toHaveLength(2);
    for (const x of rows) {
      expect(x.notes).toBeNull();
      expect(x.title).toBeNull();
    }
  });

  it("[P0-S07sb] un guest con título oculto no se pisa", async () => {
    const b = await seedBooking({
      day: "2031-03-10",
      guestName: "Reserva telefónica",
      title: "Contractura",
      description: "Trapecio",
      notes: "tel 1155550000",
    });
    asUser(assistant.userId);
    // El drawer con los campos ocultos (null) mandaba vacíos: borraba el título.
    const r = await updateBooking({
      id: b.id,
      title: "",
      description: "",
      notes: "llamar antes",
      expectedUpdatedAt: v(b.updatedAt),
    });
    expect(r).toMatchObject({ ok: true });
    const row = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(row.title).toBe("Contractura");
    expect(row.description).toBe("Trapecio");
    // Las notas de un guest son administrativas: la Secretaria las escribe.
    expect(row.notes).toBe("llamar antes");
    // Ni el audit registra los campos sacados.
    const ev = await db.auditEvent.findFirstOrThrow({
      where: { tenantId: T.tenantId, action: "booking.update", entityId: b.id },
      orderBy: { createdAt: "desc" },
    });
    const payload = (ev.payload ?? {}) as Record<string, unknown>;
    expect(payload).not.toHaveProperty("title");
    expect(payload).not.toHaveProperty("description");
    expect(payload.notes).toBe("llamar antes");
  });

  it("[P0-S07sb] re-vínculo con notas → rechazo", async () => {
    const b = await seedBooking({ patientId: pat, day: "2031-03-11", notes: "dolor lumbar irradiado" });
    asUser(assistant.userId);
    const r = await updateBooking({ id: b.id, patientId: pat2, expectedUpdatedAt: v(b.updatedAt) });
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toBe("Este turno tiene datos clínicos: pedile al profesional que lo cambie");
    const row = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(row.patientId).toBe(pat);
    expect(+row.updatedAt).toBe(+b.updatedAt);
  });

  it("[P0-S07sb] re-vínculo sin datos clínicos: paciente → paciente (solo [SOBRETURNO]) y guest → paciente se permiten", async () => {
    asUser(assistant.userId);
    const a = await seedBooking({ patientId: pat, day: "2031-03-14", notes: "[SOBRETURNO]" });
    const ra = await updateBooking({ id: a.id, patientId: pat2, expectedUpdatedAt: v(a.updatedAt) });
    expect(ra).toMatchObject({ ok: true });
    expect((await db.booking.findUniqueOrThrow({ where: { id: a.id } })).patientId).toBe(pat2);

    const g = await seedBooking({ day: "2031-03-12", hhmm: "15:00", guestName: "Sin ficha", title: "Cervicalgia", notes: "vino por recomendación" });
    const rg = await updateBooking({ id: g.id, patientId: pat, expectedUpdatedAt: v(g.updatedAt) });
    expect(rg).toMatchObject({ ok: true });
    const row = await db.booking.findUniqueOrThrow({ where: { id: g.id } });
    expect(row.patientId).toBe(pat);
    // Guest con paciente → CONFIRMED (revisión A2), y nada de lo que tenía se borró.
    expect(row.status).toBe("CONFIRMED");
    expect(row.title).toBe("Cervicalgia");
    expect(row.notes).toBe("vino por recomendación");
  });

  it("[P0-S07sb] copago de ASSISTANT ignorado", async () => {
    asUser(assistant.userId);
    const r = await createBooking({
      patientId: pat,
      serviceId: T.serviceId,
      practitionerId: T.practitionerId,
      scheduledFor: ar("2031-03-17", "10:00"),
      copagoCents: 1,
      idempotencyKey: key(),
    });
    expect(r).toMatchObject({ ok: true });
    expect((await db.booking.findUniqueOrThrow({ where: { id: r.ok ? r.data.id : "" } })).copagoCents).toBeNull();

    const batch = await createBookingsBatch({
      patientId: pat,
      serviceId: T.serviceId,
      practitionerId: T.practitionerId,
      scheduledFor: ar("2031-03-18", "10:00"),
      count: 1,
      copagoCents: 1,
      idempotencyKey: key(),
    });
    expect(batch).toMatchObject({ ok: true, data: { created: 1 } });
    const fromBatch = await db.booking.findFirstOrThrow({
      where: { patientId: pat, tenantId: T.tenantId, scheduledFor: new Date(ar("2031-03-18", "10:00")) },
    });
    expect(fromBatch.copagoCents).toBeNull();

    // Control: el profesional con full sí fija el copago del turno.
    asUser(kine.userId);
    const k = await createBooking({
      patientId: pat,
      serviceId: T.serviceId,
      practitionerId: T.practitionerId,
      scheduledFor: ar("2031-03-19", "10:00"),
      copagoCents: 1234,
      idempotencyKey: key(),
    });
    expect(k).toMatchObject({ ok: true });
    expect((await db.booking.findUniqueOrThrow({ where: { id: k.ok ? k.data.id : "" } })).copagoCents).toBe(1234);
  });

  for (const who of ["PRACTITIONER básico", "BILLING"] as const) {
    it(`[P0-S07sb] PRACTITIONER básico sigue rechazado; BILLING rechazado — ${who} (create, batch, update, status, cancel)`, async () => {
      const b = await seedBooking({ patientId: pat, day: who === "BILLING" ? "2031-03-24" : "2031-03-25", title: "Original" });
      asUser(who === "BILLING" ? billing.userId : other.userId);
      const day = who === "BILLING" ? "2031-04-01" : "2031-04-02";

      const c = await createBooking({
        patientId: pat,
        serviceId: T.serviceId,
        practitionerId: T.practitionerId,
        scheduledFor: ar(day, "10:00"),
        idempotencyKey: key(),
      });
      expect(c.ok).toBe(false);
      const bt = await createBookingsBatch({
        patientId: pat,
        serviceId: T.serviceId,
        practitionerId: T.practitionerId,
        scheduledFor: ar(day, "12:00"),
        count: 2,
        idempotencyKey: key(),
      });
      expect(bt.ok).toBe(false);
      const dry = await createBookingsBatch({
        patientId: pat,
        serviceId: T.serviceId,
        practitionerId: T.practitionerId,
        scheduledFor: ar(day, "12:00"),
        count: 2,
        dryRun: true,
      });
      expect(dry.ok).toBe(false);
      const u = await updateBooking({ id: b.id, scheduledFor: ar(day, "16:00"), title: "Pisado", expectedUpdatedAt: v(b.updatedAt) });
      expect(u.ok).toBe(false);
      const s = await setBookingStatus(b.id, "COMPLETED", v(b.updatedAt));
      expect(s.ok).toBe(false);
      const x = await setBookingStatus(b.id, "CANCELLED", v(b.updatedAt));
      expect(x.ok).toBe(false);

      const row = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
      expect(row.status).toBe("CONFIRMED");
      expect(row.title).toBe("Original");
      expect(+row.updatedAt).toBe(+b.updatedAt);
      expect(
        await db.booking.count({
          where: {
            tenantId: T.tenantId,
            scheduledFor: { gte: new Date(ar(day, "00:00")), lt: new Date(ar(day, "23:59")) },
          },
        })
      ).toBe(0);
    });
  }

  it("[P0-S07sb] ASSISTANT no borra ni marca cobros", async () => {
    const b = await seedBooking({ patientId: pat, day: "2031-04-07" });
    asUser(assistant.userId);
    expect((await deleteBooking(b.id, v(b.updatedAt))).ok).toBe(false);
    expect((await setBookingCopagoPaid(b.id, true, v(b.updatedAt))).ok).toBe(false);
    expect((await setBookingInsurerPaid(b.id, true, v(b.updatedAt))).ok).toBe(false);
    const row = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(row.paymentStatus).toBe("UNPAID");
    expect(row.insurerPaidAt).toBeNull();
    expect(+row.updatedAt).toBe(+b.updatedAt);
  });

  it("listAgendaBookings: canOperate / clinicalWritable por fila y cobertura visible para `admin` (PD-13)", async () => {
    const withPat = await seedBooking({ patientId: pat, day: "2031-04-14", title: "Lumbalgia", notes: "clínica" });
    const guest = await seedBooking({ day: "2031-04-14", hhmm: "12:00", guestName: "Externa", title: "Contractura", notes: "tel" });
    const range = { from: new Date(ar("2031-04-14", "00:00")), to: new Date(ar("2031-04-15", "00:00")) };
    const pick = <T extends { id: string }>(rows: T[], id: string) => rows.find((r) => r.id === id)!;

    asUser(assistant.userId);
    let rows = await listAgendaBookings(range);
    let p = pick(rows, withPat.id);
    expect(p).toMatchObject({ canOperate: true, clinicalWritable: false, title: null, notes: null, patientAccess: "basic" });
    // PD-13: `admin` ve obra social y copago (estado de cobro), nunca lo clínico.
    expect(p.obraSocial).toBe("OSDE");
    expect(p.copagoCents).toBe(777);
    let g = pick(rows, guest.id);
    expect(g).toMatchObject({ canOperate: true, clinicalWritable: false, title: null, notes: "tel" });

    asUser(billing.userId);
    rows = await listAgendaBookings(range);
    p = pick(rows, withPat.id);
    expect(p).toMatchObject({ canOperate: false, clinicalWritable: false, title: null, obraSocial: "OSDE", copagoCents: 777 });

    asUser(other.userId);
    rows = await listAgendaBookings(range);
    p = pick(rows, withPat.id);
    expect(p).toMatchObject({ canOperate: false, clinicalWritable: false, title: null, obraSocial: "Particular" });
    g = pick(rows, guest.id);
    expect(g).toMatchObject({ canOperate: true, clinicalWritable: true, title: "Contractura" });

    asUser(kine.userId);
    rows = await listAgendaBookings(range);
    p = pick(rows, withPat.id);
    expect(p).toMatchObject({ canOperate: true, clinicalWritable: true, title: "Lumbalgia", patientAccess: "full" });
  });

  it("listBookingsInRange: `admin` ve cobertura y copago, sin título/notas/diagnóstico", async () => {
    const b = await seedBooking({ patientId: pat, day: "2031-04-21", title: "Lumbalgia", notes: "clínica" });
    asUser(assistant.userId);
    const rows = await listBookingsInRange({ from: new Date(ar("2031-04-21", "00:00")), to: new Date(ar("2031-04-22", "00:00")) });
    const r = rows.find((x) => x.id === b.id)!;
    expect(r).toMatchObject({
      obraSocial: "OSDE",
      copagoCents: 777,
      title: null,
      description: null,
      notes: null,
      patientCondition: null,
      patientAccess: "basic",
    });
  });
});
