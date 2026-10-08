/**
 * S12 · Sincronía lado turno (ES2b P2.1; PLANES.md C4, C3, C5 y Q8).
 *
 * Qué afirma, una fila de C4 por test (efecto observable en la base, no en el
 * resumen de la action):
 *   - reprogramar "solo este" escribe `Session.scheduledFor` = turno (I3);
 *   - COMPLETED (drawer) / "Atendido" (Recepción) cierra la sesión con SOLO
 *     `completedAt` (sin autocompletar el plan) y avisa PROGRAM_NEARING_DISCHARGE;
 *   - salir de COMPLETED reabre la sesión si está "untouched"; si tiene
 *     evolución queda realizada y se avisa;
 *   - CANCELLED / NO_SHOW no tocan la sesión (queda "sin turno");
 *   - reactivar exige sesión pendiente y plan ACTIVE/PAUSED, re-estampa la
 *     cuota si `pricedByPlan` e impago, y el P2002 del único parcial de sesión
 *     da mensaje (drawer y "Deshacer Ausente"), no 500;
 *   - rechazos: cambiar el paciente, borrar, cancelar con cobro; Ausente con
 *     cobro se permite; "sacar" no es posible por `updateBooking`;
 *   - C3: el reintento de alta sobre un turno adoptado no lo modifica;
 *   - Q8: marcar "Cobrado" congela el copago resuelto;
 *   - el turno suelto no cambia (paridad) y la agenda trae los campos C9.
 *
 * Se mockea solo la sesión de Supabase y `next/cache`; las actions corren
 * reales contra Postgres, en los dos roles (kinesoft_app y owner).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  createBooking,
  updateBooking,
  setBookingStatus,
  deleteBooking,
  setBookingCopagoPaid,
  markReceptionAction,
  listAgendaBookings,
} from "@/lib/bookings";
import { getParticularCopagoCents } from "@/lib/billing-internal";
import { ownerClient, createEphemeralTenant, addPractitioner, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { createPlan, addPlanBooking, nextSlot } from "@/tests/helpers/plan-factory";
import { asUser } from "@/tests/helpers/actor";
import { revalidateTagSpy } from "@/tests/helpers/integration-setup";
import { dayWindow } from "@/lib/availability/day";
import { toARDateKey } from "@/lib/datetime-ar";

const RUN = process.env.INTEGRATION === "1";

/** Todos los avisos forzables: estos tests miden la sincronía, no la franja ni el cupo. */
const FORCE = { allowOverbooking: true, allowPatientOverlap: true, allowOutOfHours: true, allowBlocked: true };

describe.skipIf(!RUN)("S12 · sincronía turno → sesión", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
  });

  beforeEach(() => {
    asUser(T.userId);
    revalidateTagSpy.mockReset();
  });

  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });

  const booking = (id: string) => db.booking.findUniqueOrThrow({ where: { id } });
  const session = (id: string) => db.session.findUniqueOrThrow({ where: { id } });
  const ver = async (id: string) => (await booking(id)).updatedAt.toISOString();

  /** Un instante de HOY (Recepción solo marca la llegada de turnos del día AR). */
  let todayMinute = 0;
  const todaySlot = () => {
    todayMinute += 1;
    // Gate de SR: "una hora antes de ahora" caía AYER entre las 00:00 y las
    // 01:30 AR y Recepción (con razón) rechazaba el turno. Piso = inicio del día AR.
    const dayStart = +dayWindow(toARDateKey(new Date())).start;
    const d = new Date(Math.max(Date.now() - 60 * 60_000, dayStart) + todayMinute * 60_000);
    d.setUTCSeconds(0, 0);
    return d;
  };

  // ── Reprogramar (I3) ────────────────────────────────────────────────────────

  it("reprogramar 'solo este' escribe la fecha de la sesión (I3) y emite una vez", async () => {
    const p = await createPlan(db, T, { sessions: 2, bookings: 1 });
    const [b] = p.bookingIds;
    const to = nextSlot();
    const r = await updateBooking({ id: b, scheduledFor: to.toISOString(), expectedUpdatedAt: await ver(b), ...FORCE });
    expect(r.ok).toBe(true);
    expect((await booking(b)).scheduledFor.toISOString()).toBe(to.toISOString());
    expect((await session(p.sessionIds[0])).scheduledFor.toISOString()).toBe(to.toISOString());
    // La otra sesión no se mueve.
    expect(+(await session(p.sessionIds[1])).scheduledFor).not.toBe(+to);
    expect(revalidateTagSpy).toHaveBeenCalled();
  });

  it("mover un turno de plan CANCELADO (sigue cancelado) no mueve la sesión", async () => {
    const p = await createPlan(db, T, { sessions: 1, bookings: 1, bookingStatus: "CANCELLED" });
    const before = (await session(p.sessionIds[0])).scheduledFor;
    const r = await updateBooking({
      id: p.bookingIds[0],
      scheduledFor: nextSlot().toISOString(),
      expectedUpdatedAt: await ver(p.bookingIds[0]),
      ...FORCE,
    });
    expect(r.ok).toBe(true);
    expect(+(await session(p.sessionIds[0])).scheduledFor).toBe(+before);
  });

  // ── COMPLETED / Atendido ────────────────────────────────────────────────────

  it("COMPLETED (drawer) cierra la sesión con solo completedAt, no autocompleta y avisa el alta", async () => {
    const p = await createPlan(db, T, { sessions: 1, bookings: 1 });
    const r = await setBookingStatus(p.bookingIds[0], "COMPLETED", await ver(p.bookingIds[0]));
    expect(r.ok).toBe(true);
    const s = await session(p.sessionIds[0]);
    expect(s.completedAt).not.toBeNull();
    expect(s.notes).toBeNull();
    expect(s.paInPost).toBeNull();
    // D22: no autocompleta (sugerir el alta es de S12b).
    expect((await db.treatmentProgram.findUniqueOrThrow({ where: { id: p.programId } })).status).toBe("ACTIVE");
    const n = await db.notification.findMany({
      where: { tenantId: T.tenantId, kind: "PROGRAM_NEARING_DISCHARGE", link: `/pacientes/${p.patientId}` },
    });
    expect(n).toHaveLength(1);
    expect(n[0].userId).toBe(T.userId);
  });

  it("COMPLETED con más de una pendiente no avisa el alta", async () => {
    const p = await createPlan(db, T, { sessions: 3, bookings: 1 });
    expect((await setBookingStatus(p.bookingIds[0], "COMPLETED", await ver(p.bookingIds[0]))).ok).toBe(true);
    expect((await session(p.sessionIds[0])).completedAt).not.toBeNull();
    const n = await db.notification.count({
      where: { tenantId: T.tenantId, kind: "PROGRAM_NEARING_DISCHARGE", link: `/pacientes/${p.patientId}` },
    });
    expect(n).toBe(0);
  });

  it("'Atendido' en Recepción cierra la sesión y 'Deshacer' la reabre si está untouched", async () => {
    const p = await createPlan(db, T, { sessions: 2, bookings: 0 });
    const b = await addPlanBooking(db, T, {
      patientId: p.patientId,
      programId: p.programId,
      sessionId: p.sessionIds[0],
      scheduledFor: todaySlot(),
    });
    const llego = await markReceptionAction(b, "llego", await ver(b));
    expect(llego.ok).toBe(true);
    const at = await markReceptionAction(b, "atendido", llego.ok ? llego.data.updatedAt : "");
    expect(at.ok).toBe(true);
    expect((await session(p.sessionIds[0])).completedAt).not.toBeNull();

    const undo = await markReceptionAction(b, "deshacer", at.ok ? at.data.updatedAt : "");
    expect(undo.ok).toBe(true);
    if (undo.ok) expect(undo.data.notice ?? null).toBeNull();
    expect((await session(p.sessionIds[0])).completedAt).toBeNull();
  });

  it("'Deshacer Atendido' con evolución cargada deja la sesión realizada y avisa", async () => {
    const p = await createPlan(db, T, { sessions: 2, bookings: 0 });
    const b = await addPlanBooking(db, T, {
      patientId: p.patientId,
      programId: p.programId,
      sessionId: p.sessionIds[0],
      scheduledFor: todaySlot(),
      status: "COMPLETED",
    });
    await db.session.update({ where: { id: p.sessionIds[0] }, data: { completedAt: new Date(), notes: "Evolución" } });
    const undo = await markReceptionAction(b, "deshacer", await ver(b));
    expect(undo.ok).toBe(true);
    if (undo.ok) expect(undo.data.notice).toMatch(/evolución/i);
    expect((await session(p.sessionIds[0])).completedAt).not.toBeNull();
    expect((await booking(b)).status).toBe("CONFIRMED");
  });

  it("COMPLETED → NO_SHOW reabre la sesión", async () => {
    const p = await createPlan(db, T, { sessions: 2, bookings: 1, bookingStatus: "COMPLETED" });
    await db.session.update({ where: { id: p.sessionIds[0] }, data: { completedAt: new Date() } });
    const r = await setBookingStatus(p.bookingIds[0], "NO_SHOW", await ver(p.bookingIds[0]));
    expect(r.ok).toBe(true);
    expect((await session(p.sessionIds[0])).completedAt).toBeNull();
  });

  it("COMPLETED → CANCELLED con evolución: cancela, la sesión queda realizada y se avisa", async () => {
    const p = await createPlan(db, T, { sessions: 2, bookings: 1, bookingStatus: "COMPLETED" });
    await db.session.update({ where: { id: p.sessionIds[0] }, data: { completedAt: new Date(), rpe: 5 } });
    const r = await setBookingStatus(p.bookingIds[0], "CANCELLED", await ver(p.bookingIds[0]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.notice).toMatch(/evolución/i);
    expect((await booking(p.bookingIds[0])).status).toBe("CANCELLED");
    expect((await session(p.sessionIds[0])).completedAt).not.toBeNull();
  });

  // ── CANCELLED / NO_SHOW: nada ──────────────────────────────────────────────

  it("CANCELLED y Ausente no tocan la sesión (queda sin turno con su fecha)", async () => {
    const p = await createPlan(db, T, { sessions: 2, bookings: 2 });
    const s0 = await session(p.sessionIds[0]);
    expect((await setBookingStatus(p.bookingIds[0], "CANCELLED", await ver(p.bookingIds[0]))).ok).toBe(true);
    expect((await setBookingStatus(p.bookingIds[1], "NO_SHOW", await ver(p.bookingIds[1]))).ok).toBe(true);
    const s0b = await session(p.sessionIds[0]);
    expect(+s0b.scheduledFor).toBe(+s0.scheduledFor);
    expect(s0b.completedAt).toBeNull();
    expect(+s0b.updatedAt).toBe(+s0.updatedAt);
  });

  // ── Reactivar ───────────────────────────────────────────────────────────────

  it("reactivar tras reprecio re-estampa la cuota", async () => {
    const p = await createPlan(db, T, { sessions: 1, bookings: 0 });
    const b = await addPlanBooking(db, T, {
      patientId: p.patientId,
      programId: p.programId,
      sessionId: p.sessionIds[0],
      status: "CANCELLED",
      pricedByPlan: true,
      copagoCents: 500_000,
    });
    await db.session.update({ where: { id: p.sessionIds[0] }, data: { priceCents: 600_000 } });
    const r = await setBookingStatus(b, "CONFIRMED", await ver(b), FORCE);
    expect(r.ok).toBe(true);
    const row = await booking(b);
    expect(row.status).toBe("CONFIRMED");
    expect(row.copagoCents).toBe(600_000);
    expect(row.pricedByPlan).toBe(true);
  });

  it("reactivar con cobro previo de la sesión estampa $0 (C5)", async () => {
    const p = await createPlan(db, T, { sessions: 1, bookings: 0 });
    const link = { patientId: p.patientId, programId: p.programId, sessionId: p.sessionIds[0] };
    const paid = await addPlanBooking(db, T, { ...link, status: "NO_SHOW", pricedByPlan: true, copagoCents: 500_000 });
    await db.booking.update({ where: { id: paid }, data: { paymentStatus: "PAID" } });
    const b = await addPlanBooking(db, T, { ...link, status: "CANCELLED", pricedByPlan: true, copagoCents: 500_000 });
    const r = await setBookingStatus(b, "CONFIRMED", await ver(b), FORCE);
    expect(r.ok).toBe(true);
    expect((await booking(b)).copagoCents).toBe(0);
  });

  it("reactivar un turno ya cobrado no lo re-estampa", async () => {
    const p = await createPlan(db, T, { sessions: 1, bookings: 0 });
    const b = await addPlanBooking(db, T, {
      patientId: p.patientId,
      programId: p.programId,
      sessionId: p.sessionIds[0],
      status: "NO_SHOW",
      pricedByPlan: true,
      copagoCents: 500_000,
    });
    await db.booking.update({ where: { id: b }, data: { paymentStatus: "PAID" } });
    await db.session.update({ where: { id: p.sessionIds[0] }, data: { priceCents: 700_000 } });
    expect((await setBookingStatus(b, "CONFIRMED", await ver(b), FORCE)).ok).toBe(true);
    expect((await booking(b)).copagoCents).toBe(500_000);
  });

  it("reactivar re-alinea la fecha de la sesión con el turno (I3, sesión movida sin turno)", async () => {
    const p = await createPlan(db, T, { sessions: 1, bookings: 1, bookingStatus: "CANCELLED" });
    // Como `rescheduleSession` sin turno: la sesión se movió mientras el turno estaba cancelado.
    await db.session.update({ where: { id: p.sessionIds[0] }, data: { scheduledFor: nextSlot() } });
    expect(+(await session(p.sessionIds[0])).scheduledFor).not.toBe(+(await booking(p.bookingIds[0])).scheduledFor);
    expect((await setBookingStatus(p.bookingIds[0], "CONFIRMED", await ver(p.bookingIds[0]), FORCE)).ok).toBe(true);
    expect(+(await session(p.sessionIds[0])).scheduledFor).toBe(+(await booking(p.bookingIds[0])).scheduledFor);
  });

  it("reactivar con sesión archivada → rechazo 'ya no está pendiente'", async () => {
    const p = await createPlan(db, T, { sessions: 2, bookings: 1, bookingStatus: "CANCELLED" });
    await db.session.update({ where: { id: p.sessionIds[0] }, data: { archivedAt: new Date() } });
    const v = await ver(p.bookingIds[0]);
    const r = await setBookingStatus(p.bookingIds[0], "CONFIRMED", v, FORCE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^La sesión \d+ ya no está pendiente/);
    expect((await booking(p.bookingIds[0])).status).toBe("CANCELLED");
    expect(await ver(p.bookingIds[0])).toBe(v);
  });

  it("reactivar con sesión realizada o plan cancelado → rechazo", async () => {
    const a = await createPlan(db, T, { sessions: 2, bookings: 1, bookingStatus: "NO_SHOW" });
    await db.session.update({ where: { id: a.sessionIds[0] }, data: { completedAt: new Date() } });
    const ra = await setBookingStatus(a.bookingIds[0], "CONFIRMED", await ver(a.bookingIds[0]), FORCE);
    expect(ra.ok).toBe(false);
    if (!ra.ok) expect(ra.error).toBe("La sesión 1 ya no está pendiente");

    const c = await createPlan(db, T, { sessions: 2, bookings: 1, bookingStatus: "CANCELLED" });
    await db.treatmentProgram.update({ where: { id: c.programId }, data: { status: "CANCELLED" } });
    const rc = await setBookingStatus(c.bookingIds[0], "CONFIRMED", await ver(c.bookingIds[0]), FORCE);
    expect(rc.ok).toBe(false);
    if (!rc.ok) expect(rc.error).toBe("La sesión 1 ya no está pendiente");

    // PAUSED sí se puede.
    const q = await createPlan(db, T, { sessions: 2, bookings: 1, bookingStatus: "CANCELLED" });
    await db.treatmentProgram.update({ where: { id: q.programId }, data: { status: "PAUSED" } });
    expect((await setBookingStatus(q.bookingIds[0], "CONFIRMED", await ver(q.bookingIds[0]), FORCE)).ok).toBe(true);
  });

  it("reactivar con otro turno activo en la sesión (P2002) → mensaje, no 500", async () => {
    const p = await createPlan(db, T, { sessions: 1, bookings: 1, bookingStatus: "CANCELLED" });
    await addPlanBooking(db, T, { patientId: p.patientId, programId: p.programId, sessionId: p.sessionIds[0] });
    const r = await setBookingStatus(p.bookingIds[0], "CONFIRMED", await ver(p.bookingIds[0]), FORCE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("La sesión 1 ya tiene otro turno activo");
  });

  it("deshacer Ausente con otro activo da mensaje y no 500", async () => {
    const p = await createPlan(db, T, { sessions: 1, bookings: 0 });
    const link = { patientId: p.patientId, programId: p.programId, sessionId: p.sessionIds[0] };
    const absent = await addPlanBooking(db, T, { ...link, status: "NO_SHOW", scheduledFor: todaySlot() });
    await addPlanBooking(db, T, link);
    const r = await markReceptionAction(absent, "deshacer", await ver(absent));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("La sesión 1 ya tiene otro turno activo");
    expect((await booking(absent)).status).toBe("NO_SHOW");
  });

  it("deshacer Ausente sobre una sesión realizada → rechazo", async () => {
    const p = await createPlan(db, T, { sessions: 2, bookings: 0 });
    const absent = await addPlanBooking(db, T, {
      patientId: p.patientId,
      programId: p.programId,
      sessionId: p.sessionIds[0],
      status: "NO_SHOW",
      scheduledFor: todaySlot(),
    });
    await db.session.update({ where: { id: p.sessionIds[0] }, data: { completedAt: new Date(), notes: "hecha" } });
    const r = await markReceptionAction(absent, "deshacer", await ver(absent));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("La sesión 1 ya no está pendiente");
  });

  // ── Rechazos ────────────────────────────────────────────────────────────────

  it("cambiar el paciente de un turno de plan → rechazo", async () => {
    const p = await createPlan(db, T, { sessions: 1, bookings: 1 });
    const other = await createPlan(db, T, { sessions: 1 });
    const r = await updateBooking({
      id: p.bookingIds[0],
      patientId: other.patientId,
      expectedUpdatedAt: await ver(p.bookingIds[0]),
      ...FORCE,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/plan/);
    expect((await booking(p.bookingIds[0])).patientId).toBe(p.patientId);
  });

  it("deleteBooking de un turno de plan → rechazo literal", async () => {
    const p = await createPlan(db, T, { sessions: 1, bookings: 1 });
    const r = await deleteBooking(p.bookingIds[0], await ver(p.bookingIds[0]));
    expect(r).toEqual({ ok: false, error: "Este turno es de un plan: cancelalo y la sesión queda sin turno" });
    expect(await db.booking.count({ where: { id: p.bookingIds[0] } })).toBe(1);
  });

  it("cancelar un turno de plan con cobro → rechazo; sin cobro → ok", async () => {
    const p = await createPlan(db, T, { sessions: 2, bookings: 2 });
    await db.booking.update({ where: { id: p.bookingIds[0] }, data: { paymentStatus: "PAID" } });
    const r = await setBookingStatus(p.bookingIds[0], "CANCELLED", await ver(p.bookingIds[0]));
    expect(r).toEqual({ ok: false, error: "Tiene un cobro registrado: reprogramalo" });
    expect((await booking(p.bookingIds[0])).status).toBe("CONFIRMED");

    await db.booking.update({ where: { id: p.bookingIds[1] }, data: { insurerPaidAt: new Date() } });
    const r2 = await setBookingStatus(p.bookingIds[1], "CANCELLED", await ver(p.bookingIds[1]));
    expect(r2.ok).toBe(false);

    const q = await createPlan(db, T, { sessions: 1, bookings: 1 });
    expect((await setBookingStatus(q.bookingIds[0], "CANCELLED", await ver(q.bookingIds[0]))).ok).toBe(true);
  });

  it("Ausente de un turno de plan con cobro se permite (drawer y Recepción)", async () => {
    const p = await createPlan(db, T, { sessions: 2, bookings: 1 });
    await db.booking.update({ where: { id: p.bookingIds[0] }, data: { paymentStatus: "PAID" } });
    expect((await setBookingStatus(p.bookingIds[0], "NO_SHOW", await ver(p.bookingIds[0]))).ok).toBe(true);

    const b = await addPlanBooking(db, T, {
      patientId: p.patientId,
      programId: p.programId,
      sessionId: p.sessionIds[1],
      scheduledFor: todaySlot(),
    });
    await db.booking.update({ where: { id: b }, data: { paymentStatus: "PAID" } });
    expect((await markReceptionAction(b, "ausente", await ver(b))).ok).toBe(true);
    expect((await booking(b)).status).toBe("NO_SHOW");
  });

  it("'sacar del plan' no es posible por updateBooking (zod no acepta el vínculo)", async () => {
    const p = await createPlan(db, T, { sessions: 1, bookings: 1 });
    const r = await updateBooking({
      id: p.bookingIds[0],
      notes: "x",
      expectedUpdatedAt: await ver(p.bookingIds[0]),
      ...({ programId: null, sessionId: null, pricedByPlan: false } as Record<string, unknown>),
    });
    expect(r.ok).toBe(true);
    const row = await booking(p.bookingIds[0]);
    expect(row.programId).toBe(p.programId);
    expect(row.sessionId).toBe(p.sessionIds[0]);
  });

  // ── C3: holder del upsert con programId ─────────────────────────────────────

  it("reintento de alta sobre un turno adoptado no lo modifica", async () => {
    const p = await createPlan(db, T, { sessions: 1 });
    const k = randomUUID();
    const when = nextSlot();
    const created = await createBooking({
      patientId: p.patientId,
      serviceId: T.serviceId,
      practitionerId: T.practitionerId,
      scheduledFor: when.toISOString(),
      idempotencyKey: k,
      ...FORCE,
      allowSamePatientDay: true,
    });
    expect(created.ok).toBe(true);
    const id = created.ok ? created.data.id : "";
    // Adopción (lo hará el motor): vínculo + cuota.
    await db.booking.update({
      where: { id },
      data: { programId: p.programId, sessionId: p.sessionIds[0], pricedByPlan: true, copagoCents: 500_000, notes: "plan" },
    });
    const snap = await booking(id);
    revalidateTagSpy.mockReset();
    const retry = await createBooking({
      patientId: p.patientId,
      serviceId: T.serviceId,
      practitionerId: T.practitionerId,
      scheduledFor: when.toISOString(),
      idempotencyKey: k,
      copagoCents: 1,
      ...FORCE,
      allowSamePatientDay: true,
    });
    expect(retry).toEqual({ ok: true, data: { id } });
    const after = await booking(id);
    expect(after.updatedAt.toISOString()).toBe(snap.updatedAt.toISOString());
    expect(after.copagoCents).toBe(500_000);
    expect(after.pricedByPlan).toBe(true);
    // Éxito idempotente: no emite.
    expect(revalidateTagSpy).not.toHaveBeenCalled();
  });

  // ── Q8 ─────────────────────────────────────────────────────────────────────

  it("Q8: marcar 'Cobrado' con copago null congela el copago resuelto", async () => {
    const p = await createPlan(db, T, { sessions: 1 });
    const b = await addPlanBooking(db, T, { patientId: p.patientId, copagoCents: null });
    const r = await setBookingCopagoPaid(b, true, await ver(b));
    expect(r.ok).toBe(true);
    const row = await booking(b);
    expect(row.paymentStatus).toBe("PAID");
    const particular = await getParticularCopagoCents(T.tenantId, db);
    const svc = await db.service.findUniqueOrThrow({ where: { id: T.serviceId } });
    expect(row.copagoCents).toBe(particular ?? svc.priceCents);

    // Un copago ya fijado no se pisa.
    const b2 = await addPlanBooking(db, T, { patientId: p.patientId, copagoCents: 1234 });
    expect((await setBookingCopagoPaid(b2, true, await ver(b2))).ok).toBe(true);
    expect((await booking(b2)).copagoCents).toBe(1234);
  });

  // ── Paridad del turno suelto ────────────────────────────────────────────────

  it("turno suelto: paridad (COMPLETED, reactivar, mover y borrar como siempre)", async () => {
    const p = await createPlan(db, T, { sessions: 1 });
    const b = await addPlanBooking(db, T, { patientId: p.patientId, copagoCents: null });
    expect((await setBookingStatus(b, "COMPLETED", await ver(b))).ok).toBe(true);
    expect((await session(p.sessionIds[0])).completedAt).toBeNull();
    expect((await setBookingStatus(b, "CANCELLED", await ver(b))).ok).toBe(true);
    expect((await setBookingStatus(b, "CONFIRMED", await ver(b), FORCE)).ok).toBe(true);
    expect((await booking(b)).copagoCents).toBeNull();
    expect((await updateBooking({ id: b, scheduledFor: nextSlot().toISOString(), expectedUpdatedAt: await ver(b), ...FORCE })).ok).toBe(true);
    expect((await deleteBooking(b, await ver(b))).ok).toBe(true);
  });

  // ── Secretaria (contrato C8: el gate vive en el core) ─────────────────────

  it("la Secretaria marca COMPLETED un turno de plan y la sesión se cierra (sin escribir HC)", async () => {
    const assistant = await addPractitioner(db, T, "ASSISTANT");
    const p = await createPlan(db, T, { sessions: 3, bookings: 1 });
    asUser(assistant.userId);
    expect((await setBookingStatus(p.bookingIds[0], "COMPLETED", await ver(p.bookingIds[0]))).ok).toBe(true);
    const s = await session(p.sessionIds[0]);
    expect(s.completedAt).not.toBeNull();
    expect(s.notes).toBeNull();
  });

  // ── Agenda (C9) ─────────────────────────────────────────────────────────────

  it("listAgendaBookings trae los campos C9 en cada fila", async () => {
    const p = await createPlan(db, T, { sessions: 1, bookings: 1 });
    const b = await booking(p.bookingIds[0]);
    const rows = await listAgendaBookings({
      from: new Date(+b.scheduledFor - 60_000),
      to: new Date(+b.scheduledFor + 60_000),
    });
    const row = rows.find((r) => r.id === b.id);
    expect(row).toBeDefined();
    expect(row!.programId).toBe(p.programId);
    expect(row!.sessionId).toBe(p.sessionIds[0]);
    for (const r of rows) {
      expect(r).toHaveProperty("pricedByPlan");
      expect(r).toHaveProperty("plan");
      expect(r).toHaveProperty("serviceDiscipline");
      expect(Array.isArray(r.patientActiveLinkedPlanDisciplines)).toBe(true);
    }
  });
});
