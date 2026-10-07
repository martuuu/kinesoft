/**
 * Planes · ciclo de vida (S15, ES2b · P2.2): `lib/plans-lifecycle.ts`, los
 * legacy de `lib/programs.ts` que delegan y L9 en `lib/patients.ts`.
 *
 * Corre las actions REALES (getActor real, solo la sesión de Supabase
 * mockeada) y afirma las filas que quedaron. `afterBookingsCommitted` se
 * envuelve en un spy (pasa por la implementación real) para afirmar el
 * contrato Realtime: una vez, después del commit, con los turnos cancelados.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

vi.mock("@/lib/booking-events-internal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/booking-events-internal")>();
  return { ...actual, afterBookingsCommitted: vi.fn(actual.afterBookingsCommitted) };
});

import type { PrismaClient } from "@prisma/client";
import { afterBookingsCommitted } from "@/lib/booking-events-internal";
import {
  archivePlan,
  changePlanStatus,
  previewPlanStatusChange,
  restoreProgram,
  updatePlanDetails,
} from "@/lib/plans-lifecycle";
import { deleteProgram, setProgramStatus } from "@/lib/programs";
import { bulkArchivePatients, setPatientArchived } from "@/lib/patients";
import { PLAN_LIFECYCLE_COPY } from "@/lib/plans-lifecycle-state";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { createPlan, createLegacyPlan, addPlanBooking } from "@/tests/helpers/plan-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";
const spy = vi.mocked(afterBookingsCommitted);

/** Instantes futuros únicos (lejos del reloj real del test). */
let futureSlot = 0;
const future = () => new Date(Date.UTC(2031, 0, 6, 13) + ++futureSlot * 3_600_000);

describe.skipIf(!RUN)("planes · ciclo de vida (P2-S15)", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let G: EphemeralTenant;

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "PRO" });
    G = await createEphemeralTenant(db, { vertical: "GENERAL" });
  });

  afterAll(async () => {
    await A?.cleanup();
    await G?.cleanup();
    await db?.$disconnect();
  });

  beforeEach(() => {
    asUser(A.userId);
    spy.mockClear();
  });

  /**
   * Plan VINCULADO coherente para el verificador (I3: fecha de la sesión =
   * fecha del turno activo): n sesiones, las primeras `bookings` con un turno
   * futuro en el mismo instante.
   */
  async function linkedPlan(o: { sessions?: number; bookings?: number; tenant?: EphemeralTenant } = {}) {
    const t = o.tenant ?? A;
    const p = await createPlan(db, t, { sessions: o.sessions ?? 4 });
    const bookingIds: string[] = [];
    for (const sessionId of p.sessionIds.slice(0, o.bookings ?? 0)) {
      const at = future();
      await db.session.update({ where: { id: sessionId }, data: { scheduledFor: at } });
      bookingIds.push(
        await addPlanBooking(db, t, { programId: p.programId, sessionId, patientId: p.patientId, scheduledFor: at })
      );
    }
    const prog = await db.treatmentProgram.findUniqueOrThrow({ where: { id: p.programId } });
    return { ...p, bookingIds, updatedAt: prog.updatedAt.toISOString() };
  }

  const statusOf = async (ids: string[]) =>
    (await db.booking.findMany({ where: { id: { in: ids } }, orderBy: { id: "asc" }, select: { id: true, status: true } }))
      .reduce<Record<string, string>>((acc, b) => ({ ...acc, [b.id]: b.status }), {});

  it("cancelar → futuros impagos cancelados y cobrados intactos; un afterBookingsCommitted con esos refs", async () => {
    const p = await linkedPlan({ sessions: 4, bookings: 3 });
    await db.booking.update({ where: { id: p.bookingIds[2] }, data: { paymentStatus: "PAID" } });

    const pre = await previewPlanStatusChange({ programId: p.programId, to: "CANCELLED" });
    expect(pre).toMatchObject({
      ok: true,
      preview: { allowed: true, asksFutureBookings: true, futureBookings: { unpaid: 2, withPayment: 1 } },
    });

    const r = await changePlanStatus({ programId: p.programId, expectedUpdatedAt: p.updatedAt, to: "CANCELLED" });
    expect(r).toMatchObject({ ok: true, data: { status: "CANCELLED", noop: false, bookings: { cancelled: 2, kept: 0, withPayment: 1 } } });
    if (r.ok) expect(r.notice).toMatch(/1 turno tiene un cobro/);

    const st = await statusOf(p.bookingIds);
    expect(st[p.bookingIds[0]]).toBe("CANCELLED");
    expect(st[p.bookingIds[1]]).toBe("CANCELLED");
    expect(st[p.bookingIds[2]]).toBe("CONFIRMED");
    expect((await db.treatmentProgram.findUniqueOrThrow({ where: { id: p.programId } })).status).toBe("CANCELLED");
    expect(await db.auditEvent.count({ where: { tenantId: A.tenantId, action: "booking.cancel.plan" } })).toBeGreaterThanOrEqual(2);

    expect(spy).toHaveBeenCalledTimes(1);
    const [tenantId, refs] = spy.mock.calls[0];
    expect(tenantId).toBe(A.tenantId);
    expect(refs.map((x) => x.bookingId).sort()).toEqual([p.bookingIds[0], p.bookingIds[1]].sort());
  });

  it("pausar con 'mantener' → ningún turno cambia", async () => {
    const p = await linkedPlan({ sessions: 3, bookings: 2 });
    const r = await changePlanStatus({ programId: p.programId, expectedUpdatedAt: p.updatedAt, to: "PAUSED", futureBookings: "keep" });
    expect(r).toMatchObject({ ok: true, data: { status: "PAUSED", bookings: { cancelled: 0, kept: 2, withPayment: 0 } } });
    expect(Object.values(await statusOf(p.bookingIds))).toEqual(["CONFIRMED", "CONFIRMED"]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toEqual([]);
  });

  it("expectedUpdatedAt viejo → stale y nada cambia (ni turnos)", async () => {
    const p = await linkedPlan({ sessions: 2, bookings: 1 });
    const old = new Date(Date.parse(p.updatedAt) - 60_000).toISOString();
    const r = await changePlanStatus({ programId: p.programId, expectedUpdatedAt: old, to: "CANCELLED" });
    expect(r).toEqual({ ok: false, kind: "stale", error: PLAN_LIFECYCLE_COPY.stale });
    expect((await statusOf(p.bookingIds))[p.bookingIds[0]]).toBe("CONFIRMED");
    expect((await db.treatmentProgram.findUniqueOrThrow({ where: { id: p.programId } })).status).toBe("ACTIVE");
    expect(spy).not.toHaveBeenCalled();

    const u = await updatePlanDetails({ programId: p.programId, expectedUpdatedAt: old, title: "Otro" });
    expect(u).toMatchObject({ ok: false, kind: "stale" });
  });

  it("carrera: pausar ∥ cancelar con el mismo updatedAt → uno gana, el otro stale (lockPlanPatient + CAS)", async () => {
    const p = await linkedPlan({ sessions: 2, bookings: 2 });
    const [r1, r2] = await Promise.all([
      changePlanStatus({ programId: p.programId, expectedUpdatedAt: p.updatedAt, to: "PAUSED", futureBookings: "keep" }),
      changePlanStatus({ programId: p.programId, expectedUpdatedAt: p.updatedAt, to: "CANCELLED" }),
    ]);
    const oks = [r1, r2].filter((r) => r.ok);
    const stales = [r1, r2].filter((r) => !r.ok && "kind" in r && r.kind === "stale");
    expect(oks).toHaveLength(1);
    expect(stales).toHaveLength(1);
    const status = (await db.treatmentProgram.findUniqueOrThrow({ where: { id: p.programId } })).status;
    const st = Object.values(await statusOf(p.bookingIds));
    // Coherencia: si ganó cancelar, los turnos se cancelaron; si ganó pausar, quedaron.
    expect(st).toEqual(status === "CANCELLED" ? ["CANCELLED", "CANCELLED"] : ["CONFIRMED", "CONFIRMED"]);
  });

  it("mismo estado = no-op idempotente (sin audit), aun con el updatedAt viejo", async () => {
    const p = await linkedPlan({ sessions: 2 });
    const r1 = await changePlanStatus({ programId: p.programId, expectedUpdatedAt: p.updatedAt, to: "PAUSED", futureBookings: "keep" });
    expect(r1.ok).toBe(true);
    const r2 = await changePlanStatus({ programId: p.programId, expectedUpdatedAt: p.updatedAt, to: "PAUSED" });
    expect(r2).toMatchObject({ ok: true, data: { noop: true } });
    expect(await db.auditEvent.count({ where: { tenantId: A.tenantId, action: "program.status", entityId: p.programId } })).toBe(1);
  });

  it("tabla: CANCELLED terminal; COMPLETED → ACTIVE pide confirmación", async () => {
    const c = await linkedPlan({ sessions: 1 });
    await db.treatmentProgram.update({ where: { id: c.programId }, data: { status: "CANCELLED" } });
    const cu = (await db.treatmentProgram.findUniqueOrThrow({ where: { id: c.programId } })).updatedAt.toISOString();
    expect(await changePlanStatus({ programId: c.programId, expectedUpdatedAt: cu, to: "ACTIVE" })).toEqual({
      ok: false,
      error: PLAN_LIFECYCLE_COPY.terminal,
    });
    // El legacy también pasa por la tabla (antes un CANCELLED volvía a ACTIVE).
    expect(await setProgramStatus({ id: c.programId, status: "ACTIVE" })).toMatchObject({ ok: false });

    const d = await linkedPlan({ sessions: 1 });
    await db.treatmentProgram.update({ where: { id: d.programId }, data: { status: "COMPLETED" } });
    const du = (await db.treatmentProgram.findUniqueOrThrow({ where: { id: d.programId } })).updatedAt.toISOString();
    expect(await changePlanStatus({ programId: d.programId, expectedUpdatedAt: du, to: "ACTIVE" })).toMatchObject({
      ok: false,
      kind: "needs-confirmation",
    });
    expect(await changePlanStatus({ programId: d.programId, expectedUpdatedAt: du, to: "ACTIVE", confirm: true })).toMatchObject({
      ok: true,
      data: { status: "ACTIVE" },
    });
  });

  it("reactivar con la sede archivada o el responsable sin plans.manage → rechazo accionable", async () => {
    const loc = await db.location.create({ data: { tenantId: A.tenantId, name: "Sede vieja", active: true } });
    const p = await linkedPlan({ sessions: 1 });
    await db.treatmentProgram.update({ where: { id: p.programId }, data: { status: "PAUSED", locationId: loc.id } });
    await db.location.update({ where: { id: loc.id }, data: { active: false } });
    let u = (await db.treatmentProgram.findUniqueOrThrow({ where: { id: p.programId } })).updatedAt.toISOString();
    const r = await changePlanStatus({ programId: p.programId, expectedUpdatedAt: u, to: "ACTIVE" });
    expect(r).toMatchObject({ ok: false, fieldErrors: { locationId: [expect.stringMatching(/Re-planificá/)] } });
    expect((await db.treatmentProgram.findUniqueOrThrow({ where: { id: p.programId } })).status).toBe("PAUSED");

    // Responsable que pasó a Secretaria (ASSISTANT no tiene plans.manage).
    const sec = await addPractitioner(db, A, "PRACTITIONER");
    await db.location.update({ where: { id: loc.id }, data: { active: true } });
    await db.treatmentProgram.update({ where: { id: p.programId }, data: { practitionerId: sec.practitionerId } });
    await db.membership.update({
      where: { userId_tenantId: { userId: sec.userId, tenantId: A.tenantId } },
      data: { role: "ASSISTANT" },
    });
    u = (await db.treatmentProgram.findUniqueOrThrow({ where: { id: p.programId } })).updatedAt.toISOString();
    const r2 = await changePlanStatus({ programId: p.programId, expectedUpdatedAt: u, to: "ACTIVE" });
    expect(r2).toMatchObject({ ok: false, fieldErrors: { practitionerId: [expect.stringMatching(/responsable/)] } });

    await db.treatmentProgram.update({ where: { id: p.programId }, data: { practitionerId: A.practitionerId } });
    u = (await db.treatmentProgram.findUniqueOrThrow({ where: { id: p.programId } })).updatedAt.toISOString();
    expect(await changePlanStatus({ programId: p.programId, expectedUpdatedAt: u, to: "ACTIVE" })).toMatchObject({ ok: true });
  });

  it("pausar un legacy (fixture) no falla", async () => {
    const l = await createLegacyPlan(db, A);
    const u = (await db.treatmentProgram.findUniqueOrThrow({ where: { id: l.programId } })).updatedAt.toISOString();
    const r = await changePlanStatus({ programId: l.programId, expectedUpdatedAt: u, to: "PAUSED" });
    expect(r).toMatchObject({ ok: true, data: { status: "PAUSED", bookings: { cancelled: 0, kept: 0, withPayment: 0 } } });
    // Y por el legacy del Tab Plan.
    expect(await setProgramStatus({ id: l.programId, status: "CANCELLED" })).toEqual({ ok: true, data: undefined });
  });

  it("archivar un plan con turnos y autorización → sin P2003; abierto sin cancelOpen → rechazo", async () => {
    const p = await linkedPlan({ sessions: 3, bookings: 2 });
    await db.programAuthorization.create({
      data: { tenantId: A.tenantId, programId: p.programId, code: "X", authorizedSessions: 3, startsOn: new Date("2031-01-01") },
    });
    const no = await archivePlan({ programId: p.programId, expectedUpdatedAt: p.updatedAt });
    expect(no).toEqual({ ok: false, error: PLAN_LIFECYCLE_COPY.archiveNeedsCancel });

    const r = await archivePlan({ programId: p.programId, expectedUpdatedAt: p.updatedAt, cancelOpen: true });
    expect(r).toMatchObject({ ok: true, data: { status: "CANCELLED", bookings: { cancelled: 2 } } });
    const row = await db.treatmentProgram.findUniqueOrThrow({ where: { id: p.programId } });
    expect(row.status).toBe("CANCELLED");
    expect(row.archivedAt).not.toBeNull();
    expect(await db.session.count({ where: { programId: p.programId } })).toBe(3);
    expect(Object.values(await statusOf(p.bookingIds))).toEqual(["CANCELLED", "CANCELLED"]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("deleteProgram (legacy) archiva en vez de borrar: con turnos ya no da P2003", async () => {
    const p = await linkedPlan({ sessions: 2, bookings: 1 });
    await db.treatmentProgram.update({ where: { id: p.programId }, data: { status: "COMPLETED" } });
    const r = await deleteProgram(p.programId);
    expect(r).toEqual({ ok: true, data: undefined });
    const row = await db.treatmentProgram.findUniqueOrThrow({ where: { id: p.programId } });
    expect(row.archivedAt).not.toBeNull();
    expect(row.status).toBe("COMPLETED");
    // Un plan abierto: rechazo accionable, nada se cancela de rebote.
    const q = await linkedPlan({ sessions: 1, bookings: 1 });
    expect(await deleteProgram(q.programId)).toEqual({ ok: false, error: PLAN_LIFECYCLE_COPY.archiveNeedsCancel });
    expect((await statusOf(q.bookingIds))[q.bookingIds[0]]).toBe("CONFIRMED");
  });

  it("restoreProgram: OWNER/ADMIN; vuelve al estado que tenía; un PRACTITIONER → rechazo", async () => {
    const p = await linkedPlan({ sessions: 1 });
    await db.treatmentProgram.update({ where: { id: p.programId }, data: { status: "COMPLETED", archivedAt: new Date() } });
    const u = (await db.treatmentProgram.findUniqueOrThrow({ where: { id: p.programId } })).updatedAt.toISOString();

    const kine = await addPractitioner(db, A, "PRACTITIONER");
    await db.patient.update({ where: { id: p.patientId }, data: { assignedPractitionerId: kine.practitionerId } });
    asUser(kine.userId);
    expect(await restoreProgram({ programId: p.programId, expectedUpdatedAt: u })).toEqual({
      ok: false,
      error: PLAN_LIFECYCLE_COPY.restoreForbidden,
    });

    asUser(A.userId);
    const r = await restoreProgram({ programId: p.programId, expectedUpdatedAt: u });
    expect(r).toMatchObject({ ok: true, data: { status: "COMPLETED" } });
    expect((await db.treatmentProgram.findUniqueOrThrow({ where: { id: p.programId } })).archivedAt).toBeNull();
    expect(await restoreProgram({ programId: p.programId, expectedUpdatedAt: u })).toMatchObject({ ok: false });
  });

  it("updatePlanDetails: título y notas con CAS; un campo estructural → zod (strict)", async () => {
    const p = await linkedPlan({ sessions: 2 });
    const r = await updatePlanDetails({ programId: p.programId, expectedUpdatedAt: p.updatedAt, title: "Rodilla", notes: "Post-op" });
    expect(r).toMatchObject({ ok: true, data: { changed: true } });
    expect(await db.treatmentProgram.findUniqueOrThrow({ where: { id: p.programId } })).toMatchObject({ title: "Rodilla", notes: "Post-op" });
    const bad = await updatePlanDetails({ programId: p.programId, expectedUpdatedAt: p.updatedAt, totalSessions: 9 } as never);
    expect(bad).toMatchObject({ ok: false });
    expect(await db.session.count({ where: { programId: p.programId, archivedAt: null } })).toBe(2);
  });

  it("gate: plan de otro tenant → no encontrado; consultorio GENERAL → Forbidden por módulo", async () => {
    const p = await linkedPlan({ sessions: 1 });
    asUser(G.userId);
    const r = await changePlanStatus({ programId: p.programId, expectedUpdatedAt: p.updatedAt, to: "PAUSED" });
    expect(r).toMatchObject({ ok: false });
    expect((await db.treatmentProgram.findUniqueOrThrow({ where: { id: p.programId } })).status).toBe("ACTIVE");

    const g = await createPlan(db, G, { sessions: 1 });
    const gu = (await db.treatmentProgram.findUniqueOrThrow({ where: { id: g.programId } })).updatedAt.toISOString();
    const rg = await changePlanStatus({ programId: g.programId, expectedUpdatedAt: gu, to: "PAUSED" });
    expect(rg).toMatchObject({ ok: false });
    expect((await db.treatmentProgram.findUniqueOrThrow({ where: { id: g.programId } })).status).toBe("ACTIVE");
  });

  // ── L9 ──────────────────────────────────────────────────────────────────

  it("L9: archivar un paciente con plan ACTIVE → PAUSED sin tocar turnos (default)", async () => {
    const p = await linkedPlan({ sessions: 2, bookings: 1 });
    const r = await setPatientArchived({ id: p.patientId, archived: true });
    expect(r).toEqual({ ok: true, data: undefined });
    expect((await db.treatmentProgram.findUniqueOrThrow({ where: { id: p.programId } })).status).toBe("PAUSED");
    expect((await statusOf(p.bookingIds))[p.bookingIds[0]]).toBe("CONFIRMED");
    expect((await db.patient.findUniqueOrThrow({ where: { id: p.patientId } })).archivedAt).not.toBeNull();
    const ev = await db.auditEvent.findFirst({ where: { tenantId: A.tenantId, action: "program.status", entityId: p.programId } });
    expect(ev?.payload).toMatchObject({ from: "ACTIVE", to: "PAUSED", source: "patient.archive" });
    expect(spy).not.toHaveBeenCalled();
    // Desarchivar no toca planes.
    await setPatientArchived({ id: p.patientId, archived: false });
    expect((await db.treatmentProgram.findUniqueOrThrow({ where: { id: p.programId } })).status).toBe("PAUSED");
  });

  it("L9 bulk con 'cancel': CANCELLED + futuros impagos cancelados; un afterBookingsCommitted", async () => {
    const a = await linkedPlan({ sessions: 2, bookings: 2 });
    const b = await linkedPlan({ sessions: 1, bookings: 1 });
    await db.booking.update({ where: { id: a.bookingIds[1] }, data: { paymentStatus: "PAID" } });
    const r = await bulkArchivePatients({ ids: [b.patientId, a.patientId], archived: true, plansAction: "cancel" });
    expect(r).toEqual({ ok: true, data: { updated: 2 } });
    for (const id of [a.programId, b.programId]) {
      expect((await db.treatmentProgram.findUniqueOrThrow({ where: { id } })).status).toBe("CANCELLED");
    }
    const st = await statusOf([...a.bookingIds, ...b.bookingIds]);
    expect(st[a.bookingIds[0]]).toBe("CANCELLED");
    expect(st[a.bookingIds[1]]).toBe("CONFIRMED");
    expect(st[b.bookingIds[0]]).toBe("CANCELLED");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toHaveLength(2);
  });

  it("L9: plansAction inválido por RPC → rechazo sin archivar", async () => {
    const p = await linkedPlan({ sessions: 1 });
    const r = await setPatientArchived({ id: p.patientId, archived: true, plansAction: "nada" as never });
    expect(r).toMatchObject({ ok: false });
    expect((await db.patient.findUniqueOrThrow({ where: { id: p.patientId } })).archivedAt).toBeNull();
  });
});
