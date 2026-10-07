/**
 * S16b · Cantidad y autorización de la OS (`lib/plans-edit.ts`; ES2b P2.2).
 *
 * Contra la base real con el `getActor()` real (solo se mockean la sesión de
 * Supabase, `next/headers` y el runtime de cache: integration-setup). Los
 * planes se arman con el alta REAL de S11e (`previewPlan` → `createPlan`), que
 * es de una ola anterior: así el plan es "vinculado" (R-LEGACY) y el
 * verificador real (S11v) corre I5/I6 al final de cada escritura de S16b.
 *
 * Corre con los dos roles (`kinesoft_app` y el owner BYPASSRLS = prod): el
 * rechazo de un plan de otro consultorio sale por el `where {tenantId}` a mano.
 * Fechas en 2030 (futuro); TZ=UTC lo fija el script.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { createPlan, previewPlan } from "@/lib/plans";
import type { PlanCreateInput, PlanPreview, PlanRowResolution } from "@/lib/plans-types";
import {
  addPlanSessions,
  archivePlanSessions,
  previewAddPlanSessions,
  renewPlanAuthorization,
  restoreSession,
} from "@/lib/plans-edit";
import { PLAN_LIFECYCLE_COPY } from "@/lib/plans-lifecycle-state";
import { PLAN_FORBIDDEN_COPY } from "@/lib/plan-authz-internal";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

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
        return { index: r.index, kind: "adopt", bookingId: r.flags.duplicate!.bookingId, expectedUpdatedAt: r.flags.duplicate!.updatedAt };
      default:
        return { index: r.index, kind: r.defaultResolution };
    }
  });
}

describe.skipIf(!RUN)("S16b · cantidad y autorización (plans-edit)", () => {
  let db: PrismaClient;
  let K: EphemeralTenant;
  let O: EphemeralTenant;
  let assistant: { userId: string; practitionerId: string };
  let billing: { userId: string; practitionerId: string };
  let practitioner: { userId: string; practitionerId: string };

  async function makePlan(over: Partial<PlanCreateInput> = {}): Promise<{ programId: string; patientId: string }> {
    const patientId = over.patientId ?? (await addPatient(db, K));
    const input: PlanCreateInput = {
      idempotencyKey: randomUUID(),
      patientId,
      discipline: "KINESIOLOGY",
      practitionerId: K.practitionerId,
      serviceId: K.serviceId,
      locationId: null,
      schedule: LUN_JUE_10,
      startDayKey: "2030-01-07",
      totalSessions: 4,
      pricing: { mode: "PER_SESSION", pricePerSessionCents: 10_000_00 },
      rows: [],
      stateToken: "x",
      ...over,
    };
    const p = await previewPlan(input);
    if (!p.ok) throw new Error(`preview: ${p.error}`);
    const r = await createPlan({ ...input, stateToken: p.preview.stateToken, rows: acceptDefaults(p.preview) });
    if (!r.ok) throw new Error(`createPlan: ${"error" in r ? r.error : r.kind}`);
    return { programId: r.programId, patientId };
  }

  async function state(programId: string) {
    const program = await db.treatmentProgram.findUniqueOrThrow({
      where: { id: programId },
      select: { updatedAt: true, totalSessions: true, status: true, pricingMode: true, pricePerSessionCents: true, totalPriceCents: true },
    });
    const sessions = await db.session.findMany({
      where: { programId },
      orderBy: { index: "asc" },
      select: {
        id: true,
        index: true,
        title: true,
        scheduledFor: true,
        archivedAt: true,
        priceCents: true,
        bookings: { select: { id: true, status: true, copagoCents: true, pricedByPlan: true, scheduledFor: true } },
      },
    });
    return { program, sessions, live: sessions.filter((s) => s.archivedAt == null) };
  }

  const activeOf = <B extends { status: string }>(s: { bookings: B[] }): B | undefined =>
    s.bookings.find((b) => b.status === "PENDING" || b.status === "CONFIRMED" || b.status === "COMPLETED");

  beforeAll(async () => {
    db = ownerClient();
    K = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "PRO" });
    O = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "PRO" });
    assistant = await addPractitioner(db, K, "ASSISTANT");
    billing = await addPractitioner(db, K, "BILLING");
    practitioner = await addPractitioner(db, K, "PRACTITIONER");
  });

  afterAll(async () => {
    await K?.cleanup();
    await O?.cleanup();
    await db?.$disconnect();
  });

  // ─── Agregar ───────────────────────────────────────────────────────────────

  it("10→12 agrega 2 al final por el motor: turnos del horario, cuota del plan y caché totalSessions", async () => {
    asUser(K.userId);
    const { programId } = await makePlan({ totalSessions: 10 });
    const before = await state(programId);
    const lastAt = Math.max(...before.live.map((s) => +s.scheduledFor));

    const pv = await previewAddPlanSessions({ programId, kind: "append", count: 2 });
    expect(pv.ok).toBe(true);
    if (!pv.ok) return;
    expect(pv.preview.rows).toHaveLength(2);
    expect(pv.preview.rows.every((r) => r.priceCents === 10_000_00)).toBe(true);

    const r = await addPlanSessions({ programId, kind: "append", count: 2, rows: acceptDefaults(pv.preview), stateToken: pv.preview.stateToken });
    expect(r).toMatchObject({ ok: true, data: { totalSessions: 12, createdBookings: 2, reopened: false } });

    const after = await state(programId);
    expect(after.program.totalSessions).toBe(12);
    expect(after.live).toHaveLength(12);
    const added = after.live.filter((s) => !before.sessions.some((b) => b.id === s.id));
    expect(added.map((s) => s.index)).toEqual([11, 12]);
    for (const s of added) {
      expect(+s.scheduledFor).toBeGreaterThan(lastAt);
      expect(s.priceCents).toBe(10_000_00);
      const b = activeOf(s)!;
      expect(b).toMatchObject({ status: "CONFIRMED", copagoCents: 10_000_00, pricedByPlan: true });
      expect(+b.scheduledFor).toBe(+s.scheduledFor); // I3
    }
    // La 10ª es el jue 07/02/2030: siguen lun 11/02 y jue 14/02 a las 10:00 AR = 13:00Z (el horario del plan).
    expect(added.map((s) => s.scheduledFor.toISOString())).toEqual(["2030-02-11T13:00:00.000Z", "2030-02-14T13:00:00.000Z"]);
    const audit = await db.auditEvent.findFirst({ where: { tenantId: K.tenantId, action: "program.sessions.add", entityId: programId } });
    expect(audit).not.toBeNull();
  });

  it("una sesión a medida sin fecha queda sin turno y con su título", async () => {
    asUser(K.userId);
    const { programId } = await makePlan();
    const pv = await previewAddPlanSessions({ programId, kind: "custom", title: "Control" });
    expect(pv.ok).toBe(true);
    if (!pv.ok) return;
    const r = await addPlanSessions({ programId, kind: "custom", title: "Control", rows: [], stateToken: pv.preview.stateToken });
    expect(r).toMatchObject({ ok: true, data: { totalSessions: 5, createdBookings: 0 } });
    const after = await state(programId);
    const s = after.live.find((x) => x.index === 5)!;
    expect(s.title).toBe("Control");
    expect(s.bookings).toHaveLength(0);
    expect(s.priceCents).toBe(10_000_00);
  });

  it("un plan COMPLETED se reabre solo con confirmación", async () => {
    asUser(K.userId);
    const { programId } = await makePlan();
    await db.treatmentProgram.update({ where: { id: programId }, data: { status: "COMPLETED" } });
    const pv = await previewAddPlanSessions({ programId, kind: "append", count: 1 });
    if (!pv.ok) throw new Error(pv.error);
    const commit = { programId, kind: "append" as const, count: 1, rows: acceptDefaults(pv.preview), stateToken: pv.preview.stateToken };
    const no = await addPlanSessions(commit);
    expect(no).toMatchObject({ ok: false, kind: "needs-confirmation", error: PLAN_LIFECYCLE_COPY.confirmReopen });
    expect((await state(programId)).live).toHaveLength(4);
    const yes = await addPlanSessions({ ...commit, confirmReopen: true });
    expect(yes).toMatchObject({ ok: true, data: { reopened: true, totalSessions: 5 } });
    expect((await state(programId)).program.status).toBe("ACTIVE");
  });

  it("PACKAGE al agregar: pregunta; 'mantener el total' reparte entre libres y nuevas (Σ = total); 'precio por sesión' suma", async () => {
    asUser(K.userId);
    const { programId } = await makePlan({ pricing: { mode: "PACKAGE", totalPriceCents: 100_000_00 } });
    const s0 = await state(programId);
    // La sesión 1 cobrada: su cuota queda (fila bloqueada, C5).
    await db.booking.update({ where: { id: activeOf(s0.live[0])!.id }, data: { paymentStatus: "PAID" } });

    const ask = await previewAddPlanSessions({ programId, kind: "append", count: 1 });
    expect(ask.ok).toBe(false);
    if (!ask.ok) expect(ask.fieldErrors?.packagePricing?.[0]).toMatch(/total/);

    const pv = await previewAddPlanSessions({ programId, kind: "append", count: 1, packagePricing: "keep-total" });
    if (!pv.ok) throw new Error(pv.error);
    const r = await addPlanSessions({ programId, kind: "append", count: 1, packagePricing: "keep-total", rows: acceptDefaults(pv.preview), stateToken: pv.preview.stateToken });
    expect(r.ok).toBe(true);
    const a = await state(programId);
    expect(a.program.totalPriceCents).toBe(100_000_00);
    expect(a.live.reduce((acc, s) => acc + (s.priceCents ?? 0), 0)).toBe(100_000_00);
    expect(a.live[0].priceCents).toBe(25_000_00);
    expect(a.live.slice(1).map((s) => s.priceCents)).toEqual([18_750_00, 18_750_00, 18_750_00, 18_750_00]);
    // Espejo: los turnos libres se re-estamparon; el cobrado conserva su monto.
    expect(activeOf(a.live[0])!.copagoCents).toBe(25_000_00);
    for (const s of a.live.slice(1)) expect(activeOf(s)!.copagoCents).toBe(18_750_00);

    const pv2 = await previewAddPlanSessions({ programId, kind: "append", count: 1, packagePricing: "keep-per-session" });
    if (!pv2.ok) throw new Error(pv2.error);
    const r2 = await addPlanSessions({ programId, kind: "append", count: 1, packagePricing: "keep-per-session", rows: acceptDefaults(pv2.preview), stateToken: pv2.preview.stateToken });
    expect(r2.ok).toBe(true);
    const b = await state(programId);
    expect(b.program.totalPriceCents).toBe(118_750_00);
    expect(b.live.reduce((acc, s) => acc + (s.priceCents ?? 0), 0)).toBe(118_750_00);
  });

  // ─── Archivar y restaurar ──────────────────────────────────────────────────

  it("reducir archiva las últimas sin cobro y cancela su turno impago en la tx", async () => {
    asUser(K.userId);
    const { programId } = await makePlan({ totalSessions: 6 });
    const s0 = await state(programId);
    const paid = activeOf(s0.live[5])!;
    await db.booking.update({ where: { id: paid.id }, data: { paymentStatus: "PAID" } });

    const r = await archivePlanSessions({ programId, expectedUpdatedAt: s0.program.updatedAt.toISOString(), totalSessions: 4 });
    expect(r).toMatchObject({ ok: true, data: { totalSessions: 4, cancelledBookings: 2 } });
    const a = await state(programId);
    expect(a.program.totalSessions).toBe(4);
    expect(a.live.map((s) => s.index)).toEqual([1, 2, 3, 6]);
    for (const idx of [4, 5]) {
      const s = a.sessions.find((x) => x.index === idx)!;
      expect(s.archivedAt).not.toBeNull();
      expect(s.bookings.every((b) => b.status === "CANCELLED")).toBe(true);
    }
    expect(activeOf(a.live[3])).toMatchObject({ status: "CONFIRMED" });
  });

  it("archivar una sesión con cobro → rechazo y nada cambia; expectedUpdatedAt viejo → stale", async () => {
    asUser(K.userId);
    const { programId } = await makePlan();
    const s0 = await state(programId);
    await db.booking.update({ where: { id: activeOf(s0.live[1])!.id }, data: { paymentStatus: "PAID" } });
    const r = await archivePlanSessions({ programId, expectedUpdatedAt: s0.program.updatedAt.toISOString(), sessionIds: [s0.live[1].id] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/cobro/);
    const a = await state(programId);
    expect(a.live).toHaveLength(4);

    const old = await archivePlanSessions({ programId, expectedUpdatedAt: new Date(+s0.program.updatedAt - 60_000).toISOString(), sessionIds: [s0.live[3].id] });
    expect(old).toMatchObject({ ok: false, kind: "stale" });
  });

  it("restoreSession: vuelve viva sin turno; si otra tomó su index → 'Ya hay una sesión N viva'; PRACTITIONER no restaura", async () => {
    asUser(K.userId);
    const { programId } = await makePlan();
    const s0 = await state(programId);
    const r = await archivePlanSessions({ programId, expectedUpdatedAt: s0.program.updatedAt.toISOString(), sessionIds: [s0.live[3].id, s0.live[2].id] });
    expect(r.ok).toBe(true);
    const s1 = await state(programId);

    asUser(practitioner.userId);
    const denied = await restoreSession({ programId, sessionId: s0.live[3].id, expectedUpdatedAt: s1.program.updatedAt.toISOString() });
    expect(denied.ok).toBe(false);

    asUser(K.userId);
    const ok = await restoreSession({ programId, sessionId: s0.live[3].id, expectedUpdatedAt: s1.program.updatedAt.toISOString() });
    expect(ok).toMatchObject({ ok: true, data: { totalSessions: 3 } });
    const s2 = await state(programId);
    const restored = s2.live.find((s) => s.id === s0.live[3].id)!;
    expect(restored.priceCents).toBe(10_000_00);
    expect(activeOf(restored)).toBeUndefined();

    // Otra sesión viva toma el index 3 (como si se hubiera agregado a mano).
    await db.session.create({
      data: { programId, practitionerId: K.practitionerId, index: 3, scheduledFor: new Date("2030-06-03T13:00:00Z"), priceCents: 10_000_00 },
    });
    await db.treatmentProgram.update({ where: { id: programId }, data: { totalSessions: 4 } });
    const s3 = await state(programId);
    const clash = await restoreSession({ programId, sessionId: s0.live[2].id, expectedUpdatedAt: s3.program.updatedAt.toISOString() });
    expect(clash).toMatchObject({ ok: false, error: "Ya hay una sesión 3 viva" });
  });

  // ─── Autorización de la OS (E2) ────────────────────────────────────────────

  it("renovar deja 1 vigente y la anterior en el historial; audit solo con ids", async () => {
    asUser(K.userId);
    const { programId } = await makePlan({ authorization: { code: "A-1", authorizedSessions: 10, startsOnDayKey: "2030-01-01" } });
    const first = await db.programAuthorization.findFirstOrThrow({ where: { programId, supersededAt: null } });
    const r = await renewPlanAuthorization({ programId, expectedCurrentId: first.id, code: "A-2", authorizedSessions: 8, startsOnDayKey: "2030-03-01", expiresOnDayKey: "2030-05-31" });
    expect(r).toMatchObject({ ok: true, data: { supersededId: first.id } });
    const all = await db.programAuthorization.findMany({ where: { programId }, orderBy: { createdAt: "asc" } });
    expect(all).toHaveLength(2);
    expect(all.filter((a) => a.supersededAt == null).map((a) => a.code)).toEqual(["A-2"]);
    expect(all[0].supersededAt).not.toBeNull();
    const audit = await db.auditEvent.findFirstOrThrow({ where: { tenantId: K.tenantId, action: "program.authorization.renew", entityId: programId } });
    expect(JSON.stringify(audit.payload)).not.toMatch(/A-2/);
  });

  it("dos renovaciones concurrentes → una stale", async () => {
    asUser(K.userId);
    const { programId } = await makePlan({ authorization: { authorizedSessions: 10, startsOnDayKey: "2030-01-01" } });
    const cur = await db.programAuthorization.findFirstOrThrow({ where: { programId, supersededAt: null } });
    const input = { programId, expectedCurrentId: cur.id, authorizedSessions: 12, startsOnDayKey: "2030-02-01" };
    const res = await Promise.all([renewPlanAuthorization(input), renewPlanAuthorization(input)]);
    expect(res.filter((x) => x.ok)).toHaveLength(1);
    expect(res.filter((x) => !x.ok && "kind" in x && x.kind === "stale")).toHaveLength(1);
    expect(await db.programAuthorization.count({ where: { programId, supersededAt: null } })).toBe(1);
  });

  it("ASSISTANT renueva (sin vigente previa); BILLING no", async () => {
    const { programId } = await (async () => {
      asUser(K.userId);
      return makePlan();
    })();
    asUser(billing.userId);
    const no = await renewPlanAuthorization({ programId, expectedCurrentId: null, authorizedSessions: 5, startsOnDayKey: "2030-01-01" });
    expect(no).toMatchObject({ ok: false, error: PLAN_FORBIDDEN_COPY.authorize });
    asUser(assistant.userId);
    const yes = await renewPlanAuthorization({ programId, expectedCurrentId: null, authorizedSessions: 5, startsOnDayKey: "2030-01-01" });
    expect(yes).toMatchObject({ ok: true, data: { supersededId: null } });
    // La Secretaria no gestiona la cantidad (plans.manage).
    const add = await previewAddPlanSessions({ programId, kind: "append", count: 1 });
    expect(add).toMatchObject({ ok: false, error: PLAN_FORBIDDEN_COPY.manage });
  });

  it("plan de otro consultorio → rechazo (también con el rol owner BYPASSRLS)", async () => {
    asUser(O.userId);
    const foreign = await (async () => {
      const patientId = await addPatient(db, O);
      const input: PlanCreateInput = {
        idempotencyKey: randomUUID(), patientId, discipline: "KINESIOLOGY", practitionerId: O.practitionerId, serviceId: O.serviceId,
        locationId: null, schedule: LUN_JUE_10, startDayKey: "2030-01-07", totalSessions: 2, pricing: null, rows: [], stateToken: "x",
      };
      const p = await previewPlan(input);
      if (!p.ok) throw new Error(p.error);
      const r = await createPlan({ ...input, stateToken: p.preview.stateToken, rows: acceptDefaults(p.preview) });
      if (!r.ok) throw new Error("alta ajena");
      return r.programId;
    })();
    const before = await state(foreign);
    asUser(K.userId);
    const iso = before.program.updatedAt.toISOString();
    expect((await previewAddPlanSessions({ programId: foreign, kind: "append", count: 1 })).ok).toBe(false);
    expect((await archivePlanSessions({ programId: foreign, expectedUpdatedAt: iso, totalSessions: 1 })).ok).toBe(false);
    expect((await renewPlanAuthorization({ programId: foreign, expectedCurrentId: null, startsOnDayKey: "2030-01-01" })).ok).toBe(false);
    const after = await state(foreign);
    expect(after.live).toHaveLength(2);
    expect(await db.programAuthorization.count({ where: { programId: foreign } })).toBe(0);
  });
});
