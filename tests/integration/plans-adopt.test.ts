/**
 * S25a · Adopción (ES2b P2.2) — `lib/plans-adopt.ts`: vincular un turno suelto
 * a una sesión, adoptar una serie, sacar un turno del plan y generar turnos
 * para las sesiones pendientes.
 *
 * Contra la base real con el `getActor()` real (el setup mockea la sesión de
 * Supabase, `next/headers` y el runtime de cache). Corre con los dos roles
 * (`kinesoft_app` y el owner BYPASSRLS = prod). Los planes se crean con el
 * motor real (`createPlan`, S11e) para que el vínculo, las keys y el I3 sean
 * los de producción; los turnos sueltos, por insert directo (son el "antes" de
 * la adopción). Fechas en 2030 (nada depende del reloj) salvo el turno atendido
 * de "contar como sesión 1", que es pasado a propósito. TZ=UTC: 10:00 AR =
 * 13:00Z.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { createPlan, previewPlan } from "@/lib/plans";
import {
  adoptBookingSeries,
  generatePlanBookings,
  linkBookingToSession,
  previewGeneratePlanBookings,
  removeBookingFromPlan,
} from "@/lib/plans-adopt";
import type { PlanCreateInput, PlanPreview, PlanRowResolution } from "@/lib/plans-types";
import { PLAN_FORBIDDEN_COPY } from "@/lib/plan-authz-internal";
import { PLAN_KEY_PREFIX } from "@/lib/plans-constants";
import { MODULE_DENIED_COPY } from "@/lib/tenant-modules";
import { ownerClient, createEphemeralTenant, addPatient, addPractitioner, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { addPlanBooking } from "@/tests/helpers/plan-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

/** Lunes 10:00 AR. */
const LUN_10 = { v: 1 as const, frequency: "weekly" as const, slots: [{ dow: 1 as const, startMin: 600 }] };

function acceptDefaults(p: PlanPreview): PlanRowResolution[] {
  return p.rows.map((r) => {
    switch (r.defaultResolution) {
      case "move":
        return { index: r.index, kind: "move", at: r.suggestion };
      case "adopt":
        return { index: r.index, kind: "adopt", bookingId: r.flags.duplicate!.bookingId, expectedUpdatedAt: r.flags.duplicate!.updatedAt };
      default:
        return { index: r.index, kind: r.defaultResolution };
    }
  });
}

/** Todas las filas "sin turno": el plan nace con sus sesiones pendientes. */
const allNone = (p: PlanPreview): PlanRowResolution[] => p.rows.map((r) => ({ index: r.index, kind: "none" }));

describe.skipIf(!RUN)("S25a · adopción y generar turnos", () => {
  let db: PrismaClient;
  let K: EphemeralTenant;
  let OTHER: EphemeralTenant;
  let assistant: { userId: string; practitionerId: string };

  const planInput = (patientId: string, over: Partial<PlanCreateInput> = {}): PlanCreateInput => ({
    idempotencyKey: randomUUID(),
    patientId,
    discipline: "KINESIOLOGY",
    practitionerId: K.practitionerId,
    serviceId: K.serviceId,
    locationId: null,
    schedule: LUN_10,
    startDayKey: "2030-01-07",
    totalSessions: 3,
    pricing: { mode: "PER_SESSION", pricePerSessionCents: 500_000 },
    rows: [],
    stateToken: "x",
    ...over,
  });

  async function newPlan(
    patientId: string,
    over: Partial<PlanCreateInput> = {},
    rowsOf: (p: PlanPreview) => PlanRowResolution[] = acceptDefaults
  ) {
    const input = planInput(patientId, over);
    const p = await previewPlan(input);
    if (!p.ok) throw new Error(p.error);
    const r = await createPlan({ ...input, stateToken: p.preview.stateToken, rows: rowsOf(p.preview) });
    if (!r.ok) throw new Error(`createPlan: ${JSON.stringify(r)}`);
    return { programId: r.programId, ...(await planState(r.programId)) };
  }

  async function planState(programId: string) {
    const program = await db.treatmentProgram.findUniqueOrThrow({ where: { id: programId } });
    const sessions = await db.session.findMany({ where: { programId }, orderBy: { index: "asc" } });
    return { program, sessions, updatedAt: program.updatedAt.toISOString() };
  }

  /** Turno suelto del paciente (sin plan), libre de plata salvo que se pida. */
  async function loose(patientId: string, at: string, over: { status?: "PENDING" | "CONFIRMED" | "COMPLETED"; copagoCents?: number | null } = {}) {
    const id = await addPlanBooking(db, K, { patientId, scheduledFor: new Date(at), copagoCents: null, ...over });
    return db.booking.findUniqueOrThrow({ where: { id } });
  }

  beforeAll(async () => {
    db = ownerClient();
    K = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "PRO" });
    OTHER = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "PRO" });
    assistant = await addPractitioner(db, K, "ASSISTANT");
  });

  afterAll(async () => {
    await K?.cleanup();
    await OTHER?.cleanup();
    await db?.$disconnect();
  });

  // ─── Vincular ──────────────────────────────────────────────────────────────

  it("vincular un suelto libre lo estampa con la cuota; uno cobrado queda como está (nunca re-estampa lo cobrado)", async () => {
    asUser(K.userId);
    const patientId = await addPatient(db, K);
    const plan = await newPlan(patientId, {}, allNone);
    expect(await db.booking.count({ where: { programId: plan.programId } })).toBe(0);

    // Martes 2030-01-08 11:00 AR: otra fecha que la planificada (la sesión toma la del turno, I3).
    const free = await loose(patientId, "2030-01-08T14:00:00.000Z");
    const r1 = await linkBookingToSession({
      programId: plan.programId,
      sessionId: plan.sessions[0].id,
      bookingId: free.id,
      expectedBookingUpdatedAt: free.updatedAt.toISOString(),
      expectedUpdatedAt: plan.updatedAt,
    });
    expect(r1).toMatchObject({ ok: true, data: { sessionId: plan.sessions[0].id } });
    const b1 = await db.booking.findUniqueOrThrow({ where: { id: free.id } });
    expect(b1).toMatchObject({ programId: plan.programId, sessionId: plan.sessions[0].id, pricedByPlan: true, copagoCents: 500_000 });
    expect(b1.scheduledFor.toISOString()).toBe("2030-01-08T14:00:00.000Z");
    const s1 = await db.session.findUniqueOrThrow({ where: { id: plan.sessions[0].id } });
    expect(s1.scheduledFor.toISOString()).toBe("2030-01-08T14:00:00.000Z"); // I3

    // Cobrado: copago 3.000 PAID. Se vincula, pero el copago y el pago quedan.
    const paid = await loose(patientId, "2030-01-15T14:00:00.000Z", { copagoCents: 300_000 });
    await db.booking.update({ where: { id: paid.id }, data: { paymentStatus: "PAID" } });
    const paidNow = await db.booking.findUniqueOrThrow({ where: { id: paid.id } });
    const after1 = await planState(plan.programId);
    // El CAS del plan: con el `updatedAt` viejo → stale, nada escrito.
    const stale = await linkBookingToSession({
      programId: plan.programId,
      sessionId: plan.sessions[1].id,
      bookingId: paid.id,
      expectedBookingUpdatedAt: paidNow.updatedAt.toISOString(),
      expectedUpdatedAt: plan.updatedAt,
    });
    expect(stale).toMatchObject({ ok: false, kind: "stale" });
    expect((await db.booking.findUniqueOrThrow({ where: { id: paid.id } })).programId).toBeNull();

    const r2 = await linkBookingToSession({
      programId: plan.programId,
      sessionId: plan.sessions[1].id,
      bookingId: paid.id,
      expectedBookingUpdatedAt: paidNow.updatedAt.toISOString(),
      expectedUpdatedAt: after1.updatedAt,
    });
    expect(r2).toMatchObject({ ok: true });
    const b2 = await db.booking.findUniqueOrThrow({ where: { id: paid.id } });
    expect(b2).toMatchObject({
      programId: plan.programId,
      sessionId: plan.sessions[1].id,
      pricedByPlan: false,
      copagoCents: 300_000,
      paymentStatus: "PAID",
    });

    // Una sesión que ya tiene turno no recibe otro.
    const third = await loose(patientId, "2030-01-22T14:00:00.000Z");
    const after2 = await planState(plan.programId);
    const busy = await linkBookingToSession({
      programId: plan.programId,
      sessionId: plan.sessions[0].id,
      bookingId: third.id,
      expectedBookingUpdatedAt: third.updatedAt.toISOString(),
      expectedUpdatedAt: after2.updatedAt,
    });
    expect(busy).toMatchObject({ ok: false, error: "La sesión 1 ya tiene un turno." });

    const audits = await db.auditEvent.findMany({ where: { tenantId: K.tenantId, entityId: plan.programId, action: "program.link_booking" } });
    expect(audits).toHaveLength(2);
  });

  it("no adopta una reserva pública impaga", async () => {
    asUser(K.userId);
    const patientId = await addPatient(db, K);
    const plan = await newPlan(patientId, {}, allNone);
    const pub = await loose(patientId, "2030-01-08T14:00:00.000Z", {
      status: "PENDING",
    });
    await db.booking.update({ where: { id: pub.id }, data: { idempotencyKey: `pub:${randomUUID()}:${patientId}` } });
    const pubNow = await db.booking.findUniqueOrThrow({ where: { id: pub.id } });
    const r = await linkBookingToSession({
      programId: plan.programId,
      sessionId: plan.sessions[0].id,
      bookingId: pub.id,
      expectedBookingUpdatedAt: pubNow.updatedAt.toISOString(),
      expectedUpdatedAt: plan.updatedAt,
    });
    expect(r.ok).toBe(false);
    const series = await adoptBookingSeries({
      programId: plan.programId,
      expectedUpdatedAt: plan.updatedAt,
      bookings: [{ bookingId: pub.id, expectedUpdatedAt: pubNow.updatedAt.toISOString() }],
    });
    expect(series).toMatchObject({ ok: false, kind: "stale" });
    const b = await db.booking.findUniqueOrThrow({ where: { id: pub.id } });
    expect(b).toMatchObject({ programId: null, sessionId: null, pricedByPlan: false, copagoCents: null });
  });

  it("un turno de otro consultorio no se vincula (no se distingue de uno inexistente)", async () => {
    asUser(K.userId);
    const patientId = await addPatient(db, K);
    const plan = await newPlan(patientId, {}, allNone);
    const otherPatient = await addPatient(db, OTHER);
    const foreignId = await addPlanBooking(db, OTHER, { patientId: otherPatient, scheduledFor: new Date("2030-01-08T14:00:00.000Z"), copagoCents: null });
    const foreign = await db.booking.findUniqueOrThrow({ where: { id: foreignId } });
    const r = await linkBookingToSession({
      programId: plan.programId,
      sessionId: plan.sessions[0].id,
      bookingId: foreignId,
      expectedBookingUpdatedAt: foreign.updatedAt.toISOString(),
      expectedUpdatedAt: plan.updatedAt,
    });
    expect(r).toMatchObject({ ok: false, error: "Turno no encontrado." });
    expect((await db.booking.findUniqueOrThrow({ where: { id: foreignId } })).programId).toBeNull();
  });

  // ─── Adoptar una serie ─────────────────────────────────────────────────────

  it("adoptar una serie: asigna las pendientes por fecha y, si sobran turnos, suma sesiones (I3, I5)", async () => {
    asUser(K.userId);
    const patientId = await addPatient(db, K);
    const plan = await newPlan(patientId, {}, allNone);
    const ats = ["2030-01-09T14:00:00.000Z", "2030-01-16T14:00:00.000Z", "2030-01-23T14:00:00.000Z", "2030-01-30T14:00:00.000Z"];
    // Insertados fuera de orden: la asignación es por fecha, no por orden de llegada.
    const bs = [];
    for (const at of [ats[2], ats[0], ats[3], ats[1]]) bs.push(await loose(patientId, at));
    const r = await adoptBookingSeries({
      programId: plan.programId,
      expectedUpdatedAt: plan.updatedAt,
      bookings: bs.map((b) => ({ bookingId: b.id, expectedUpdatedAt: b.updatedAt.toISOString() })),
    });
    expect(r).toMatchObject({ ok: true, data: { totalSessions: 4 } });

    const after = await planState(plan.programId);
    expect(after.program.totalSessions).toBe(4);
    expect(after.sessions).toHaveLength(4);
    const linked = await db.booking.findMany({ where: { programId: plan.programId }, include: { session: true }, orderBy: { scheduledFor: "asc" } });
    expect(linked.map((b) => b.scheduledFor.toISOString())).toEqual(ats);
    expect(linked.map((b) => b.session!.index)).toEqual([1, 2, 3, 4]);
    for (const b of linked) {
      expect(+b.session!.scheduledFor).toBe(+b.scheduledFor); // I3
      expect(b).toMatchObject({ pricedByPlan: true, copagoCents: 500_000 });
    }
    expect(after.sessions[3].priceCents).toBe(500_000);
  });

  it("adoptar una serie que incluye un turno de otro plan → stale y nada se toca (el otro plan intacto)", async () => {
    asUser(K.userId);
    const patientId = await addPatient(db, K);
    const plan = await newPlan(patientId, {}, allNone);
    const otherPlan = await newPlan(patientId, { startDayKey: "2030-03-04", totalSessions: 2 });
    const otherBookings = await db.booking.findMany({ where: { programId: otherPlan.programId }, orderBy: { id: "asc" } });
    expect(otherBookings).toHaveLength(2);
    const a = await loose(patientId, "2030-01-09T14:00:00.000Z");
    const r = await adoptBookingSeries({
      programId: plan.programId,
      expectedUpdatedAt: plan.updatedAt,
      bookings: [
        { bookingId: a.id, expectedUpdatedAt: a.updatedAt.toISOString() },
        { bookingId: otherBookings[0].id, expectedUpdatedAt: otherBookings[0].updatedAt.toISOString() },
      ],
    });
    expect(r).toMatchObject({ ok: false, kind: "stale", error: "Ese turno ya es de un plan." });
    expect((await db.booking.findUniqueOrThrow({ where: { id: a.id } })).programId).toBeNull();
    const still = await db.booking.findMany({ where: { programId: otherPlan.programId }, orderBy: { id: "asc" } });
    expect(still.map((b) => [b.id, b.sessionId, b.copagoCents, b.updatedAt.toISOString()])).toEqual(
      otherBookings.map((b) => [b.id, b.sessionId, b.copagoCents, b.updatedAt.toISOString()])
    );
    expect((await planState(plan.programId)).updatedAt).toBe(plan.updatedAt);
  });

  // ─── "Crealo como plan" desde un turno ─────────────────────────────────────

  it("fromBookingId + contar como sesión 1: un turno COMPLETED hace nacer realizada la sesión 1", async () => {
    asUser(K.userId);
    const patientId = await addPatient(db, K);
    // Atendido el lunes 28/09/2026 10:00 AR (pasado: la evaluación ya hecha).
    const done = await loose(patientId, "2026-09-28T13:00:00.000Z", { status: "COMPLETED" });
    const plan = await newPlan(patientId, { fromBookingId: done.id, countBookingAsSession1: true, totalSessions: 3 });
    const s1 = plan.sessions[0];
    expect(s1.scheduledFor.toISOString()).toBe("2026-09-28T13:00:00.000Z");
    expect(s1.completedAt).not.toBeNull();
    const b = await db.booking.findUniqueOrThrow({ where: { id: done.id } });
    expect(b).toMatchObject({ programId: plan.programId, sessionId: s1.id, status: "COMPLETED" });
    // Las otras dos siguen el horario (lunes 10:00 AR de 2030), sin realizar.
    expect(plan.sessions.slice(1).map((s) => [s.scheduledFor.toISOString(), s.completedAt])).toEqual([
      ["2030-01-07T13:00:00.000Z", null],
      ["2030-01-14T13:00:00.000Z", null],
    ]);
  });

  // ─── Sacar del plan ────────────────────────────────────────────────────────

  it("sacar del plan: con cobro → rechazo (PD-08); sin cobro → desestampado y la sesión queda sin turno", async () => {
    asUser(K.userId);
    const patientId = await addPatient(db, K);
    const plan = await newPlan(patientId, { totalSessions: 2 });
    const [b1, b2] = await db.booking.findMany({ where: { programId: plan.programId }, orderBy: { scheduledFor: "asc" } });
    expect(b1).toMatchObject({ pricedByPlan: true, copagoCents: 500_000 });

    await db.booking.update({ where: { id: b2.id }, data: { paymentStatus: "PAID" } });
    const b2Now = await db.booking.findUniqueOrThrow({ where: { id: b2.id } });
    const withMoney = await removeBookingFromPlan({ bookingId: b2.id, expectedUpdatedAt: b2Now.updatedAt.toISOString() });
    expect(withMoney).toMatchObject({ ok: false, error: "Tiene un cobro registrado: no se puede sacar del plan." });
    expect((await db.booking.findUniqueOrThrow({ where: { id: b2.id } })).programId).toBe(plan.programId);

    // CAS del turno: con un `updatedAt` viejo → stale.
    const old = await removeBookingFromPlan({ bookingId: b1.id, expectedUpdatedAt: new Date(+b1.updatedAt - 1000).toISOString() });
    expect(old).toMatchObject({ ok: false, kind: "stale" });

    const r = await removeBookingFromPlan({ bookingId: b1.id, expectedUpdatedAt: b1.updatedAt.toISOString() });
    expect(r).toMatchObject({ ok: true, data: { sessionId: plan.sessions[0].id } });
    const out = await db.booking.findUniqueOrThrow({ where: { id: b1.id } });
    expect(out).toMatchObject({ programId: null, sessionId: null, pricedByPlan: false, copagoCents: null, status: "CONFIRMED" });
    const s1 = await db.session.findUniqueOrThrow({ where: { id: plan.sessions[0].id } });
    expect(s1.archivedAt).toBeNull();
    expect(s1.completedAt).toBeNull();
    const audit = await db.auditEvent.findMany({ where: { tenantId: K.tenantId, entityId: b1.id, action: "booking.plan_remove" } });
    expect(audit).toHaveLength(1);
  });

  // ─── Generar turnos de sesiones pendientes ─────────────────────────────────

  it("generar regenera una sesión cancelada con otra key; con cobro previo el turno nuevo sale en $0", async () => {
    asUser(K.userId);
    const patientId = await addPatient(db, K);
    const plan = await newPlan(patientId, { totalSessions: 2 });
    const [b1, b2] = await db.booking.findMany({ where: { programId: plan.programId }, orderBy: { scheduledFor: "asc" } });
    // Sesión 1: cancelada impaga. Sesión 2: ausente con la cuota cobrada.
    await db.booking.update({ where: { id: b1.id }, data: { status: "CANCELLED" } });
    await db.booking.update({ where: { id: b2.id }, data: { status: "NO_SHOW", paymentStatus: "PAID" } });

    const p = await previewGeneratePlanBookings({ programId: plan.programId });
    if (!p.ok) throw new Error(p.error);
    expect(p.preview.rows.map((r) => r.sessionId)).toEqual([plan.sessions[0].id, plan.sessions[1].id]);
    expect(p.preview.rows[1].flags.priorPaid?.bookingId).toBe(b2.id);

    // La ausencia ocupa el mismo instante del paciente: se re-agenda una hora después.
    const rows = acceptDefaults(p.preview).map((r) =>
      r.index === 2 ? { index: 2, kind: "move" as const, at: "2030-01-14T14:00:00.000Z" } : r
    );
    const r = await generatePlanBookings({ programId: plan.programId, rows, stateToken: p.preview.stateToken });
    expect(r).toMatchObject({ ok: true, data: { createdBookings: 2, adoptedBookings: 0 } });

    const fresh = await db.booking.findMany({
      where: { programId: plan.programId, status: "CONFIRMED" },
      orderBy: { scheduledFor: "asc" },
      include: { session: true },
    });
    expect(fresh).toHaveLength(2);
    expect(fresh[0].sessionId).toBe(plan.sessions[0].id);
    expect(fresh[0].idempotencyKey).not.toBe(b1.idempotencyKey);
    expect(fresh[0].idempotencyKey.startsWith(PLAN_KEY_PREFIX)).toBe(true);
    expect(fresh[0]).toMatchObject({ pricedByPlan: true, copagoCents: 500_000 });
    expect(fresh[1]).toMatchObject({ sessionId: plan.sessions[1].id, pricedByPlan: true, copagoCents: 0 });
    for (const b of fresh) expect(+b.session!.scheduledFor).toBe(+b.scheduledFor); // I3
    // El cancelado conserva su key (C3).
    expect((await db.booking.findUniqueOrThrow({ where: { id: b1.id } })).idempotencyKey).toBe(b1.idempotencyKey);

    // Reenviar el mismo commit: el plan cambió (token) → stale-preview sin turnos de más.
    const again = await generatePlanBookings({ programId: plan.programId, rows, stateToken: p.preview.stateToken });
    expect(again).toMatchObject({ ok: false });
    expect(await db.booking.count({ where: { programId: plan.programId, status: "CONFIRMED" } })).toBe(2);

    // Sin pendientes: rechazo claro.
    const none = await previewGeneratePlanBookings({ programId: plan.programId });
    expect(none).toMatchObject({ ok: false, error: "No hay sesiones sin turno para agendar." });
  });

  it("ASSISTANT (Secretaria) agenda una sesión puntual con sessionIds, pero no vincula ni saca del plan", async () => {
    asUser(K.userId);
    const patientId = await addPatient(db, K);
    const plan = await newPlan(patientId, {}, allNone);
    const loosePending = await loose(patientId, "2030-02-05T14:00:00.000Z");

    asUser(assistant.userId);
    const p = await previewGeneratePlanBookings({ programId: plan.programId, sessionIds: [plan.sessions[1].id] });
    if (!p.ok) throw new Error(p.error);
    expect(p.preview.rows).toHaveLength(1);
    // Nada clínico ni de gestión en lo que ve: ni "adoptar" ni "marcar realizada".
    for (const row of p.preview.rows) {
      expect(row.allowedResolutions).not.toContain("adopt");
      expect(row.allowedResolutions).not.toContain("mark-done");
    }
    const r = await generatePlanBookings({
      programId: plan.programId,
      sessionIds: [plan.sessions[1].id],
      rows: acceptDefaults(p.preview),
      stateToken: p.preview.stateToken,
    });
    expect(r).toMatchObject({ ok: true, data: { createdBookings: 1 } });
    const created = await db.booking.findFirstOrThrow({ where: { programId: plan.programId, sessionId: plan.sessions[1].id } });
    expect(created).toMatchObject({ status: "CONFIRMED", pricedByPlan: true, copagoCents: 500_000 });
    // Solo esa: las otras dos siguen sin turno.
    expect(await db.booking.count({ where: { programId: plan.programId } })).toBe(1);

    const removed = await removeBookingFromPlan({ bookingId: created.id, expectedUpdatedAt: created.updatedAt.toISOString() });
    expect(removed).toMatchObject({ ok: false, error: PLAN_FORBIDDEN_COPY.manage });
    expect((await db.booking.findUniqueOrThrow({ where: { id: created.id } })).programId).toBe(plan.programId);

    const st = await planState(plan.programId);
    const link = await linkBookingToSession({
      programId: plan.programId,
      sessionId: plan.sessions[0].id,
      bookingId: loosePending.id,
      expectedBookingUpdatedAt: loosePending.updatedAt.toISOString(),
      expectedUpdatedAt: st.updatedAt,
    });
    expect(link).toMatchObject({ ok: false, error: PLAN_FORBIDDEN_COPY.manage });
    expect((await db.booking.findUniqueOrThrow({ where: { id: loosePending.id } })).programId).toBeNull();
    asUser(K.userId);
  });

  it("consultorio General (sin módulo planes) → Forbidden sin tocar nada", async () => {
    const G = await createEphemeralTenant(db, { vertical: "GENERAL" });
    try {
      asUser(G.userId);
      // El módulo se chequea antes de buscar nada: el error es el del módulo, no "no encontrado".
      const r = await previewGeneratePlanBookings({ programId: randomUUID() });
      expect(r).toMatchObject({ ok: false, error: MODULE_DENIED_COPY.planes });
      const rm = await removeBookingFromPlan({ bookingId: randomUUID(), expectedUpdatedAt: new Date().toISOString() });
      expect(rm).toMatchObject({ ok: false, error: MODULE_DENIED_COPY.planes });
    } finally {
      asUser(K.userId);
      await G.cleanup();
    }
  });
});
