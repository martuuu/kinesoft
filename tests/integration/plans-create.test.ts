/**
 * S11e · Motor de Planes: preview + commit (`lib/plans.ts` → `previewPlan`,
 * `createPlan`; ES2b P2.1).
 *
 * Contra la base real con el `getActor()` real (solo se mockean la sesión de
 * Supabase, `next/headers` y el runtime de cache de Next). `@/lib/db` se
 * instrumenta con `installQueryCounter` (solo suma un listener de `query` a
 * los clientes) para medir el presupuesto de statements del commit.
 *
 * Corre con los dos roles de DB: `kinesoft_app` (RLS) y el owner BYPASSRLS
 * (`test:integration:owner`, = prod): los rechazos por ids de otro consultorio
 * tienen que salir por el `where {tenantId}` a mano, no por RLS.
 *
 * Fechas en 2030 (futuro) salvo el caso "pasadas" (2020): nada depende del
 * reloj de hoy. TZ=UTC (lo fija el script): un `getDay`/`toISOString().slice`
 * del host correría los días.
 *
 * Post-integración (NO en el gate de S11e): la corrida contra el verificador
 * real de S11v (`assertProgramInvariantsInTx`) y la sincronía de S12.
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
import { isPublicReservation } from "@/lib/booking-capacity";
import { dbDateToDayKey, dayKeyOf } from "@/lib/availability/day";
import { PLAN_FORBIDDEN_COPY } from "@/lib/plan-authz-internal";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  addService,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { measure } from "@/tests/helpers/query-counter";

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

/** Las resoluciones por defecto del preview, tal como las mandaría el editor. */
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

describe.skipIf(!RUN)("S11e · motor de planes (preview + commit)", () => {
  let db: PrismaClient;
  let K: EphemeralTenant;
  let O: EphemeralTenant;
  let pro: { userId: string; practitionerId: string };
  let assistant: { userId: string; practitionerId: string };
  let foreign: { serviceId: string; locationId: string; templateId: string; exerciseId: string };

  const base = (patientId: string, over: Partial<PlanCreateInput> = {}): PlanCreateInput => ({
    idempotencyKey: randomUUID(),
    patientId,
    discipline: "KINESIOLOGY",
    practitionerId: K.practitionerId,
    serviceId: K.serviceId,
    locationId: null,
    schedule: LUN_JUE_10,
    startDayKey: "2030-01-07",
    totalSessions: 10,
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

  /** preview → commit con las resoluciones por defecto. */
  async function previewAndCreate(input: PlanCreateInput) {
    const p = await preview(input);
    return createPlan({ ...input, stateToken: p.stateToken, rows: acceptDefaults(p) });
  }

  beforeAll(async () => {
    db = ownerClient();
    K = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "PRO" });
    O = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "PRO" });
    pro = await addPractitioner(db, K, "PRACTITIONER");
    assistant = await addPractitioner(db, K, "ASSISTANT");
    const loc = await db.location.create({ data: { tenantId: O.tenantId, name: "Sede ajena" } });
    const tpl = await db.planTemplate.create({
      data: { tenantId: O.tenantId, authorId: O.practitionerId, name: "Ajena", exerciseIds: [] },
    });
    const ex = await db.exercise.create({
      data: { tenantId: O.tenantId, slug: `ex-ajeno-${uniqueSuffix()}`, name: "Ajeno" },
    });
    foreign = { serviceId: O.serviceId, locationId: loc.id, templateId: tpl.id, exerciseId: ex.id };
    asUser(K.userId);
  });

  afterAll(async () => {
    await K?.cleanup();
    await O?.cleanup();
    await db?.$disconnect();
  });

  it("10 sesiones lun/jue en TZ=UTC → fechas AR, vínculo, keys plan: y audit en la tx", async () => {
    const patientId = await addPatient(db, K);
    const input = base(patientId);
    const r = await previewAndCreate(input);
    expect(r).toMatchObject({ ok: true, idempotent: false });
    if (!r.ok) return;

    const program = await db.treatmentProgram.findUniqueOrThrow({
      where: { id: r.programId },
      include: { sessions: { orderBy: { index: "asc" } }, bookings: { orderBy: { scheduledFor: "asc" } } },
    });
    expect(program.tenantId).toBe(K.tenantId);
    expect(program.totalSessions).toBe(10);
    expect(program.discipline).toBe("KINESIOLOGY");
    expect(program.practitionerId).toBe(K.practitionerId);
    expect(program.idempotencyKey).toBe(input.idempotencyKey);
    expect(program.schedule).toEqual(LUN_JUE_10);
    const days = ["07", "10", "14", "17", "21", "24", "28", "31"].map((d) => `2030-01-${d}`).concat(["2030-02-04", "2030-02-07"]);
    // 10:00 AR = 13:00Z. En TZ=UTC un `setHours(10)` daría 10:00Z.
    expect(program.sessions.map((s) => s.scheduledFor.toISOString())).toEqual(days.map((d) => `${d}T13:00:00.000Z`));
    expect(program.sessions.map((s) => dayKeyOf(s.scheduledFor))).toEqual(days);
    expect(program.bookings).toHaveLength(10);
    const genIds = new Set<string>();
    program.bookings.forEach((b, i) => {
      expect(b.sessionId).toBe(program.sessions[i].id);
      expect(b.programId).toBe(program.id);
      expect(b.patientId).toBe(patientId);
      expect(b.status).toBe("CONFIRMED");
      expect(+b.scheduledFor).toBe(+program.sessions[i].scheduledFor);
      const m = /^plan:([^:]+):(\d+)$/.exec(b.idempotencyKey);
      expect(m).not.toBeNull();
      expect(Number(m![2])).toBe(program.sessions[i].index);
      genIds.add(m![1]);
      expect(b.seriesId).toBe(m![1]);
      // §5.18: una key de plan nunca parece reserva pública (no vence a los 30 min).
      expect(isPublicReservation({ idempotencyKey: b.idempotencyKey, patientId: b.patientId })).toBe(false);
    });
    expect(genIds.size).toBe(1);
    const audits = await db.auditEvent.findMany({ where: { tenantId: K.tenantId, entityId: program.id } });
    expect(audits.map((a) => a.action)).toContain("program.create");
  });

  it("misma key ×2 → 1 plan (el segundo es éxito idempotente)", async () => {
    const patientId = await addPatient(db, K);
    const input = base(patientId, { totalSessions: 3 });
    const p = await preview(input);
    const commit = { ...input, stateToken: p.stateToken, rows: acceptDefaults(p) };
    const a = await createPlan(commit);
    const b = await createPlan(commit);
    expect(a).toMatchObject({ ok: true, idempotent: false });
    expect(b).toMatchObject({ ok: true, idempotent: true });
    if (!a.ok || !b.ok) return;
    expect(b.programId).toBe(a.programId);
    expect(await db.treatmentProgram.count({ where: { tenantId: K.tenantId, idempotencyKey: input.idempotencyKey } })).toBe(1);
    expect(await db.booking.count({ where: { programId: a.programId } })).toBe(3);
  });

  it("bloqueado nunca se fuerza: force sobre una fila bloqueada → stale y nada escrito", async () => {
    const patientId = await addPatient(db, K);
    const input = base(patientId, { totalSessions: 2, startDayKey: "2030-03-04" });
    await db.timeBlock.create({
      data: {
        tenantId: K.tenantId,
        practitionerId: K.practitionerId,
        startsAt: new Date("2030-03-04T12:00:00Z"),
        endsAt: new Date("2030-03-04T15:00:00Z"),
        reason: "Congreso",
        createdById: K.userId,
      },
    });
    const p = await preview(input);
    expect(p.rows[0].flags.blocked).toBe(true);
    expect(p.rows[0].allowedResolutions).not.toContain("force");
    expect(p.rows[0].allowedResolutions).not.toContain("create");
    const rows = acceptDefaults(p);
    rows[0] = { index: 1, kind: "force", force: { capacity: true, outOfHours: true, patientOverlap: true } };
    const r = await createPlan({ ...input, stateToken: p.stateToken, rows });
    expect(r).toMatchObject({ ok: false, kind: "stale-preview" });
    expect(await db.treatmentProgram.count({ where: { tenantId: K.tenantId, patientId } })).toBe(0);
  });

  it("stale por resolución faltante: la fila se llenó entre el preview y el commit", async () => {
    const patientId = await addPatient(db, K);
    const other = await addPatient(db, K);
    const svc = await addService(db, K, { name: `Cupo1 ${uniqueSuffix()}`, durationMin: 45, maxConcurrent: 1 });
    const input = base(patientId, { serviceId: svc, totalSessions: 2, startDayKey: "2030-04-01" });
    const p = await preview(input);
    expect(p.rows[0].defaultResolution).toBe("create");
    // Otro paciente toma el cupo (1) de la fila 1 después del preview.
    await db.booking.create({
      data: {
        tenantId: K.tenantId,
        patientId: other,
        practitionerId: K.practitionerId,
        serviceId: svc,
        scheduledFor: new Date(p.rows[0].at),
        durationMin: 45,
        idempotencyKey: randomUUID(),
        status: "CONFIRMED",
      },
    });
    // Sin resolución explícita (faltante) y con la "create" vieja: las dos son stale.
    for (const rows of [[], acceptDefaults(p)]) {
      const r = await createPlan({ ...input, stateToken: p.stateToken, rows });
      expect(r).toMatchObject({ ok: false, kind: "stale-preview" });
      if (!r.ok && "preview" in r) expect(r.preview.rows[0].flags.capacityFull).toBe(true);
    }
    expect(await db.treatmentProgram.count({ where: { tenantId: K.tenantId, patientId } })).toBe(0);
  });

  it("stale por un adoptado que cambió; con el preview nuevo adopta y estampa la cuota", async () => {
    const patientId = await addPatient(db, K);
    const at = new Date("2030-05-06T13:00:00Z"); // lunes 10:00 AR
    const loose = await db.booking.create({
      data: {
        tenantId: K.tenantId,
        patientId,
        practitionerId: K.practitionerId,
        serviceId: K.serviceId,
        scheduledFor: at,
        durationMin: 45,
        idempotencyKey: randomUUID(),
        status: "CONFIRMED",
        copagoCents: null,
      },
    });
    const input = base(patientId, {
      totalSessions: 2,
      startDayKey: "2030-05-06",
      pricing: { mode: "PER_SESSION", pricePerSessionCents: 500_000 },
    });
    const p1 = await preview(input);
    expect(p1.rows[0].defaultResolution).toBe("adopt");
    expect(p1.rows[0].flags.duplicate).toMatchObject({ bookingId: loose.id, adoptable: true });
    await db.booking.update({ where: { id: loose.id }, data: { notes: "tocado" } });
    const stale = await createPlan({ ...input, stateToken: p1.stateToken, rows: acceptDefaults(p1) });
    expect(stale).toMatchObject({ ok: false, kind: "stale-preview" });

    const p2 = await preview(input);
    const r = await createPlan({ ...input, stateToken: p2.stateToken, rows: acceptDefaults(p2) });
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    const adopted = await db.booking.findUniqueOrThrow({ where: { id: loose.id } });
    const s1 = await db.session.findFirstOrThrow({ where: { programId: r.programId, index: 1 } });
    expect(adopted.programId).toBe(r.programId);
    expect(adopted.sessionId).toBe(s1.id);
    expect(adopted.idempotencyKey).toBe(loose.idempotencyKey);
    // Primer estampado (C5 rama b): sin copago previo, futuro e impago → espejo de la cuota.
    expect(adopted.copagoCents).toBe(500_000);
    expect(adopted.pricedByPlan).toBe(true);
    expect(+s1.scheduledFor).toBe(+at);
    expect(await db.booking.count({ where: { programId: r.programId } })).toBe(2);
  });

  it("PACKAGE 100.000/3 → 33.334 + 33.333 + 33.333 con espejo en el turno y Σ = total", async () => {
    const patientId = await addPatient(db, K);
    const input = base(patientId, {
      totalSessions: 3,
      startDayKey: "2030-06-03",
      pricing: { mode: "PACKAGE", totalPriceCents: 10_000_000 },
    });
    const p = await preview(input);
    expect(p.rows.map((r) => r.priceCents)).toEqual([3_333_400, 3_333_300, 3_333_300]);
    const r = await createPlan({ ...input, stateToken: p.stateToken, rows: acceptDefaults(p) });
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    const sessions = await db.session.findMany({
      where: { programId: r.programId },
      orderBy: { index: "asc" },
      include: { bookings: true },
    });
    expect(sessions.map((s) => s.priceCents)).toEqual([3_333_400, 3_333_300, 3_333_300]);
    expect(sessions.reduce((a, s) => a + (s.priceCents ?? 0), 0)).toBe(10_000_000);
    for (const s of sessions) {
      expect(s.bookings).toHaveLength(1);
      expect(s.bookings[0].copagoCents).toBe(s.priceCents);
      expect(s.bookings[0].pricedByPlan).toBe(true);
    }
    const prog = await db.treatmentProgram.findUniqueOrThrow({ where: { id: r.programId } });
    expect(prog).toMatchObject({ pricingMode: "PACKAGE", totalPriceCents: 10_000_000, pricePerSessionCents: null });
  });

  it("sin precio → cuota null y turnos con copago null / pricedByPlan false (sigue la cobertura)", async () => {
    const patientId = await addPatient(db, K);
    const r = await previewAndCreate(base(patientId, { totalSessions: 2, startDayKey: "2030-06-10" }));
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    const sessions = await db.session.findMany({ where: { programId: r.programId }, include: { bookings: true } });
    for (const s of sessions) {
      expect(s.priceCents).toBeNull();
      expect(s.bookings[0]).toMatchObject({ copagoCents: null, pricedByPlan: false });
    }
  });

  it("ids de otro consultorio (servicio, profesional, sede, plantilla, ejercicio) → rechazo, nada escrito", async () => {
    const patientId = await addPatient(db, K);
    const cases: Array<Partial<PlanCreateInput>> = [
      { serviceId: foreign.serviceId },
      { practitionerId: O.practitionerId },
      { locationId: foreign.locationId },
      { templateId: foreign.templateId },
      { exercises: [{ exerciseId: foreign.exerciseId, sets: 3, reps: 12 }] },
    ];
    for (const over of cases) {
      const input = base(patientId, { totalSessions: 2, startDayKey: "2030-07-01", ...over });
      const pv = await previewPlan(input);
      expect(pv.ok).toBe(false);
      const r = await createPlan({ ...input, stateToken: "x", rows: [] });
      expect(r.ok).toBe(false);
      expect(r).not.toHaveProperty("kind");
    }
    // Paciente de otro consultorio: mismo rechazo que sin permiso (sin oráculo).
    const foreignPatient = await addPatient(db, O);
    const r = await createPlan(base(foreignPatient));
    expect(r).toMatchObject({ ok: false, error: PLAN_FORBIDDEN_COPY.manage });
    expect(await db.treatmentProgram.count({ where: { tenantId: K.tenantId, patientId } })).toBe(0);
    expect(await db.treatmentProgram.count({ where: { tenantId: O.tenantId } })).toBe(0);
  });

  it("básico, Secretaria, PS deshabilitada o membresía no aceptada → rechazo; PRIVATE → ok", async () => {
    const patientId = await addPatient(db, K);
    // Básico: el PRACTITIONER `pro` no tiene asignado al paciente (sharedPatientView off).
    asUser(pro.userId);
    expect(await previewPlan(base(patientId))).toMatchObject({ ok: false, error: PLAN_FORBIDDEN_COPY.manage });
    asUser(assistant.userId);
    expect(await createPlan(base(patientId))).toMatchObject({ ok: false, error: PLAN_FORBIDDEN_COPY.manage });
    asUser(K.userId);

    await db.practitionerService.create({
      data: { tenantId: K.tenantId, practitionerId: pro.practitionerId, serviceId: K.serviceId, enabled: false },
    });
    const off = await previewPlan(base(patientId, { practitionerId: pro.practitionerId }));
    expect(off.ok).toBe(false);

    const pending = await addPractitioner(db, K, "PRACTITIONER");
    await db.membership.update({
      where: { userId_tenantId: { userId: pending.userId, tenantId: K.tenantId } },
      data: { acceptedAt: null },
    });
    const notAccepted = await previewPlan(base(patientId, { practitionerId: pending.practitionerId }));
    expect(notAccepted.ok).toBe(false);

    const priv = await addPractitioner(db, K, "PRACTITIONER");
    await db.practitionerService.create({
      data: { tenantId: K.tenantId, practitionerId: priv.practitionerId, serviceId: K.serviceId, enabled: true, visibility: "PRIVATE" },
    });
    const r = await previewAndCreate(base(patientId, { practitionerId: priv.practitionerId, totalSessions: 2, startDayKey: "2030-07-08" }));
    expect(r).toMatchObject({ ok: true });
  });

  it("servicio de 300 min → 'La duración supera 4 h'; con duración propia del plan, ok", async () => {
    const patientId = await addPatient(db, K);
    const svc = await addService(db, K, { name: `Largo ${uniqueSuffix()}`, durationMin: 300 });
    const r = await previewPlan(base(patientId, { serviceId: svc }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/La duración supera 4 h/);
    const ok = await previewAndCreate(base(patientId, { serviceId: svc, durationMin: 60, totalSessions: 1, startDayKey: "2030-07-15" }));
    expect(ok).toMatchObject({ ok: true });
    if (!ok.ok) return;
    const b = await db.booking.findFirstOrThrow({ where: { programId: ok.programId } });
    expect(b.durationMin).toBe(60);
  });

  it("fromBookingId + contar como sesión 1: adopta el turno COMPLETED y la sesión 1 nace realizada", async () => {
    const patientId = await addPatient(db, K);
    const at = new Date("2020-03-02T13:00:00Z");
    const evalBooking = await db.booking.create({
      data: {
        tenantId: K.tenantId,
        patientId,
        practitionerId: K.practitionerId,
        serviceId: K.serviceId,
        scheduledFor: at,
        durationMin: 45,
        idempotencyKey: randomUUID(),
        status: "COMPLETED",
        paymentStatus: "PAID",
        copagoCents: 300_000,
      },
    });
    const input = base(patientId, {
      totalSessions: 3,
      startDayKey: "2030-10-07",
      pricing: { mode: "PER_SESSION", pricePerSessionCents: 500_000 },
      fromBookingId: evalBooking.id,
      countBookingAsSession1: true,
    });
    const p = await preview(input);
    expect(p.rows).toHaveLength(3);
    expect(p.rows[0]).toMatchObject({ at: at.toISOString(), defaultResolution: "adopt" });
    const r = await createPlan({ ...input, stateToken: p.stateToken, rows: acceptDefaults(p) });
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    const s1 = await db.session.findFirstOrThrow({ where: { programId: r.programId, index: 1 } });
    expect(+s1.completedAt!).toBe(+at);
    const b = await db.booking.findUniqueOrThrow({ where: { id: evalBooking.id } });
    // Lo cobrado no se re-estampa: queda su copago y pricedByPlan=false.
    expect(b).toMatchObject({ programId: r.programId, sessionId: s1.id, copagoCents: 300_000, pricedByPlan: false });
    // Un turno de otro paciente como origen → rechazo.
    const other = await addPatient(db, K);
    const bad = await previewPlan(base(other, { fromBookingId: evalBooking.id, countBookingAsSession1: true }));
    expect(bad.ok).toBe(false);
  });

  it("fechas pasadas → sesiones sin turno", async () => {
    const patientId = await addPatient(db, K);
    const input = base(patientId, { totalSessions: 3, startDayKey: "2020-01-06" });
    const p = await preview(input);
    expect(p.rows.every((r) => r.flags.past && r.defaultResolution === "none")).toBe(true);
    const r = await createPlan({ ...input, stateToken: p.stateToken, rows: acceptDefaults(p) });
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    expect(await db.session.count({ where: { programId: r.programId } })).toBe(3);
    expect(await db.booking.count({ where: { programId: r.programId } })).toBe(0);
  });

  it("≤ 60 statements para un plan de 20 filas", async () => {
    const patientId = await addPatient(db, K);
    const input = base(patientId, { totalSessions: 20, startDayKey: "2030-08-05", pricing: { mode: "PER_SESSION", pricePerSessionCents: 400_000 } });
    const p = await preview(input);
    const { result, m } = await measure(() => createPlan({ ...input, stateToken: p.stateToken, rows: acceptDefaults(p) }));
    expect(result).toMatchObject({ ok: true });
    expect(m.statements).toBeLessThanOrEqual(60);
  });

  it("autorización de la OS: round-trip, overAuthorization en la 11 de 10 y vencimiento por dayKey AR", async () => {
    const patientId = await addPatient(db, K);
    const input = base(patientId, {
      totalSessions: 12,
      startDayKey: "2030-09-02",
      authorization: { code: "ORD-123", authorizedSessions: 10, startsOnDayKey: "2030-09-02", expiresOnDayKey: "2030-12-31" },
    });
    const p = await preview(input);
    expect(p.rows.map((r) => r.flags.overAuthorization)).toEqual([...Array(10).fill(false), true, true]);
    const r = await createPlan({ ...input, stateToken: p.stateToken, rows: acceptDefaults(p) });
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    const auths = await db.programAuthorization.findMany({ where: { programId: r.programId } });
    expect(auths).toHaveLength(1);
    expect(auths[0]).toMatchObject({ tenantId: K.tenantId, code: "ORD-123", authorizedSessions: 10, supersededAt: null });
    expect(dbDateToDayKey(auths[0].startsOn)).toBe("2030-09-02");
    expect(dbDateToDayKey(auths[0].expiresOn)).toBe("2030-12-31");

    // Lunes 23:00 AR = martes 02:00Z: en TZ=UTC una comparación de instantes
    // daría "vencida" la sesión del mismo día del vencimiento.
    const late = base(await addPatient(db, K), {
      schedule: { v: 1, frequency: "weekly", slots: [{ dow: 1, startMin: 23 * 60 }] },
      totalSessions: 2,
      startDayKey: "2030-11-25",
      authorization: { startsOnDayKey: "2030-11-25", expiresOnDayKey: "2030-11-25" },
    });
    const pl = await preview(late);
    expect(pl.rows[0].dayKey).toBe("2030-11-25");
    expect(pl.rows[0].flags.afterAuthorizationExpiry).toBe(false);
    expect(pl.rows[1].flags.afterAuthorizationExpiry).toBe(true);
  });
});
