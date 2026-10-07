/**
 * S16a · Re-planificar desde la sesión N (L7) — `lib/plans-move.ts` →
 * `previewReplanPlan` / `replanPlan` (ES2b P2.2).
 *
 * Contra la base real con el `getActor()` real; corre con los dos roles
 * (`kinesoft_app` y el owner BYPASSRLS = prod): los rechazos por ids de otro
 * consultorio tienen que salir por `validatePlanRefsInTx` (`where {tenantId}`
 * a mano), no por RLS. Fechas en 2030; TZ=UTC (10:00 AR = 13:00Z).
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
import { previewReplanPlan, replanPlan } from "@/lib/plans-move";
import type { PlanCreateInput, PlanPreview, PlanRowResolution } from "@/lib/plans-types";
import type { ReplanPlanInput } from "@/lib/plans-edit-types";
import { PLAN_FORBIDDEN_COPY } from "@/lib/plan-authz-internal";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { measure } from "@/tests/helpers/query-counter";

const RUN = process.env.INTEGRATION === "1";

const LUN_10 = { v: 1 as const, frequency: "weekly" as const, slots: [{ dow: 1 as const, startMin: 600 }] };
/** Martes y viernes 15:00 AR (C6: 0=Dom). */
const MAR_VIE_15 = {
  v: 1 as const,
  frequency: "weekly" as const,
  slots: [
    { dow: 2 as const, startMin: 900 },
    { dow: 5 as const, startMin: 900 },
  ],
};

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

describe.skipIf(!RUN)("S16a · re-planificar desde la sesión N (L7)", () => {
  let db: PrismaClient;
  let K: EphemeralTenant;
  let O: EphemeralTenant;
  let pro2: { userId: string; practitionerId: string };
  let assistant: { userId: string; practitionerId: string };
  let foreignLocationId: string;

  const planInput = (patientId: string, over: Partial<PlanCreateInput> = {}): PlanCreateInput => ({
    idempotencyKey: randomUUID(),
    patientId,
    discipline: "KINESIOLOGY",
    practitionerId: K.practitionerId,
    serviceId: K.serviceId,
    locationId: null,
    schedule: LUN_10,
    startDayKey: "2030-01-07",
    totalSessions: 6,
    pricing: { mode: "PER_SESSION", pricePerSessionCents: 500_000 },
    rows: [],
    stateToken: "x",
    ...over,
  });

  async function newPlan(patientId: string, over: Partial<PlanCreateInput> = {}) {
    const input = planInput(patientId, over);
    const p = await previewPlan(input);
    if (!p.ok) throw new Error(p.error);
    const r = await createPlan({ ...input, stateToken: p.preview.stateToken, rows: acceptDefaults(p.preview) });
    if (!r.ok) throw new Error(`createPlan: ${JSON.stringify(r)}`);
    const sessions = await db.session.findMany({ where: { programId: r.programId }, orderBy: { index: "asc" } });
    return { programId: r.programId, sessions };
  }

  type ReplanReq = Omit<ReplanPlanInput, "rows" | "stateToken">;

  async function previewAndReplan(req: ReplanReq) {
    const p = await previewReplanPlan(req);
    if (!p.ok) return p;
    return replanPlan({ ...req, rows: acceptDefaults(p.preview), stateToken: p.preview.stateToken });
  }

  beforeAll(async () => {
    db = ownerClient();
    K = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "PRO" });
    O = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "PRO" });
    pro2 = await addPractitioner(db, K, "PRACTITIONER");
    // El servicio de la factory es del profesional de K: para pro2, PS explícita habilitada.
    await db.practitionerService.create({
      data: { tenantId: K.tenantId, practitionerId: pro2.practitionerId, serviceId: K.serviceId, enabled: true },
    });
    assistant = await addPractitioner(db, K, "ASSISTANT");
    foreignLocationId = (await db.location.create({ data: { tenantId: O.tenantId, name: "Sede ajena" } })).id;
    asUser(K.userId);
  });

  afterAll(async () => {
    await K?.cleanup();
    await O?.cleanup();
    await db?.$disconnect();
  });

  it("desde la sesión 3 con horario nuevo: 1-2 intactas, futuros impagos cancelados y recreados por el motor (I3, cuota)", async () => {
    const patientId = await addPatient(db, K);
    const { programId, sessions } = await newPlan(patientId);
    const before = await db.booking.findMany({ where: { programId }, orderBy: { scheduledFor: "asc" } });
    const req: ReplanReq = { programId, fromSessionId: sessions[2].id, schedule: MAR_VIE_15, startDayKey: "2030-01-22" };
    const p = await previewReplanPlan(req);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.preview.rows.map((r) => r.at)).toEqual([
      "2030-01-22T18:00:00.000Z",
      "2030-01-25T18:00:00.000Z",
      "2030-01-29T18:00:00.000Z",
      "2030-02-01T18:00:00.000Z",
    ]);
    const { result: r, m } = await measure(() => replanPlan({ ...req, rows: acceptDefaults(p.preview), stateToken: p.preview.stateToken }));
    console.info(`[S16a] replan 4 filas: ${m.statements} statements`);
    expect(r).toMatchObject({ ok: true, data: { cancelledBookings: 4, keptWithPayment: 0, createdBookings: 4, adoptedBookings: 0 } });

    const all = await db.booking.findMany({ where: { programId }, include: { session: true }, orderBy: { scheduledFor: "asc" } });
    const active = all.filter((b) => b.status !== "CANCELLED");
    expect(active).toHaveLength(6);
    // 1 y 2: el mismo turno, sin tocar.
    expect(active.slice(0, 2).map((b) => b.id)).toEqual(before.slice(0, 2).map((b) => b.id));
    expect(active.slice(2).map((b) => b.scheduledFor.toISOString())).toEqual(p.preview.rows.map((r) => r.at));
    for (const b of active) {
      expect(+b.session!.scheduledFor).toBe(+b.scheduledFor); // I3
      expect(b.copagoCents).toBe(500_000);
      expect(b.pricedByPlan).toBe(true);
    }
    // Los viejos de 3..6 quedaron cancelados (con su key: regenerar usa otro generationId).
    const cancelled = all.filter((b) => b.status === "CANCELLED");
    expect(cancelled.map((b) => b.id).sort()).toEqual(before.slice(2).map((b) => b.id).sort());
    const program = await db.treatmentProgram.findUniqueOrThrow({ where: { id: programId } });
    expect(program.schedule).toEqual(MAR_VIE_15);
    expect(program.totalSessions).toBe(6);
    expect(await db.auditEvent.count({ where: { entityId: programId, action: "program.replan" } })).toBe(1);
  });

  it("cambio de profesional desde la sesión k: plan, sesiones y turnos nuevos con el nuevo; las anteriores quedan", async () => {
    const patientId = await addPatient(db, K);
    const { programId, sessions } = await newPlan(patientId, { startDayKey: "2030-03-04", totalSessions: 4 });
    const r = await previewAndReplan({
      programId,
      fromSessionId: sessions[2].id,
      schedule: LUN_10,
      startDayKey: "2030-03-18",
      practitionerId: pro2.practitionerId,
    });
    expect(r).toMatchObject({ ok: true, data: { cancelledBookings: 2, createdBookings: 2 } });
    const program = await db.treatmentProgram.findUniqueOrThrow({ where: { id: programId } });
    expect(program.practitionerId).toBe(pro2.practitionerId);
    const ss = await db.session.findMany({ where: { programId }, orderBy: { index: "asc" } });
    expect(ss.map((s) => s.practitionerId)).toEqual([K.practitionerId, K.practitionerId, pro2.practitionerId, pro2.practitionerId]);
    const active = await db.booking.findMany({ where: { programId, status: { not: "CANCELLED" } }, orderBy: { scheduledFor: "asc" } });
    expect(active.map((b) => b.practitionerId)).toEqual([K.practitionerId, K.practitionerId, pro2.practitionerId, pro2.practitionerId]);
  });

  it("el cobrado queda intacto: el turno con cobro no se cancela ni se mueve y su sesión no se re-planifica", async () => {
    const patientId = await addPatient(db, K);
    const { programId, sessions } = await newPlan(patientId, { startDayKey: "2030-04-01", totalSessions: 4 });
    const paid = await db.booking.findFirstOrThrow({ where: { sessionId: sessions[3].id } });
    await db.booking.update({ where: { id: paid.id }, data: { paymentStatus: "PAID" } });
    const r = await previewAndReplan({ programId, fromSessionId: sessions[1].id, schedule: MAR_VIE_15, startDayKey: "2030-04-09" });
    expect(r).toMatchObject({ ok: true, data: { cancelledBookings: 2, keptWithPayment: 1, createdBookings: 2 } });
    if (r.ok) expect(r.notice).toMatch(/cobro/);
    const after = await db.booking.findUniqueOrThrow({ where: { id: paid.id } });
    expect(after).toMatchObject({ status: "CONFIRMED", paymentStatus: "PAID", copagoCents: paid.copagoCents });
    expect(+after.scheduledFor).toBe(+paid.scheduledFor);
    expect(+(await db.session.findUniqueOrThrow({ where: { id: sessions[3].id } })).scheduledFor).toBe(+paid.scheduledFor);
  });

  it("servicio, sede o profesional de otro consultorio → rechazo y nada escrito (rol owner incluido)", async () => {
    const patientId = await addPatient(db, K);
    const { programId, sessions } = await newPlan(patientId, { startDayKey: "2030-05-06", totalSessions: 3 });
    const base = { programId, fromSessionId: sessions[1].id, schedule: MAR_VIE_15, startDayKey: "2030-05-14" };
    const program0 = await db.treatmentProgram.findUniqueOrThrow({ where: { id: programId } });
    for (const over of [{ serviceId: O.serviceId }, { locationId: foreignLocationId }, { practitionerId: O.practitionerId }]) {
      const p = await previewReplanPlan({ ...base, ...over });
      expect(p.ok).toBe(false);
      // Commit directo con un token cualquiera: el rechazo es de refs, antes del token.
      const c = await replanPlan({ ...base, ...over, rows: [], stateToken: "0123456789abcdef.0123456789abcdef" });
      expect(c.ok).toBe(false);
      expect(c).not.toHaveProperty("kind", "stale-preview");
    }
    const program1 = await db.treatmentProgram.findUniqueOrThrow({ where: { id: programId } });
    expect(program1).toMatchObject({ serviceId: program0.serviceId, locationId: null, practitionerId: program0.practitionerId });
    expect(+program1.updatedAt).toBe(+program0.updatedAt);
    expect(await db.booking.count({ where: { programId, status: "CANCELLED" } })).toBe(0);
  });

  it("el preview con refs nuevas no escribe; un commit con otro profesional que el del preview → stale-preview", async () => {
    const patientId = await addPatient(db, K);
    const { programId, sessions } = await newPlan(patientId, { startDayKey: "2030-06-03", totalSessions: 3 });
    const program0 = await db.treatmentProgram.findUniqueOrThrow({ where: { id: programId } });
    const req = { programId, fromSessionId: sessions[1].id, schedule: LUN_10, startDayKey: "2030-06-10", practitionerId: pro2.practitionerId };
    const p = await previewReplanPlan(req);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const program1 = await db.treatmentProgram.findUniqueOrThrow({ where: { id: programId } });
    expect(program1.practitionerId).toBe(program0.practitionerId);
    expect(+program1.updatedAt).toBe(+program0.updatedAt);
    const r = await replanPlan({ ...req, practitionerId: K.practitionerId, rows: acceptDefaults(p.preview), stateToken: p.preview.stateToken });
    expect(r).toMatchObject({ ok: false, kind: "stale-preview" });
    expect(await db.booking.count({ where: { programId, status: "CANCELLED" } })).toBe(0);
  });

  it("la Secretaria no re-planifica (plans.manage); inicio en el pasado → rechazo", async () => {
    const patientId = await addPatient(db, K);
    const { programId, sessions } = await newPlan(patientId, { startDayKey: "2030-07-01", totalSessions: 2 });
    asUser(assistant.userId);
    try {
      const r = await previewReplanPlan({ programId, fromSessionId: sessions[0].id, schedule: LUN_10, startDayKey: "2030-07-08" });
      expect(r).toMatchObject({ ok: false, error: PLAN_FORBIDDEN_COPY.manage });
    } finally {
      asUser(K.userId);
    }
    const past = await previewReplanPlan({ programId, fromSessionId: sessions[0].id, schedule: LUN_10, startDayKey: "2020-01-06" });
    expect(past.ok).toBe(false);
  });
});
