/**
 * S17d · Puerta Diagnóstico server (ES2b P2.2): `createPlanFromDiagnosis`,
 * `getDiagnosisPlanPrefill`, el gate de módulo `diagnostico` de todos los
 * exports de `lib/diagnosis.ts` y la firma aditiva de
 * `searchPatientsForAssignment`.
 *
 * Contra la base real con el `getActor()` real (solo se mockean la sesión de
 * Supabase, `next/headers` y el runtime de cache de Next). Corre con los dos
 * roles (`kinesoft_app` y owner BYPASSRLS = prod): condición, ejercicios y
 * paciente de otro consultorio tienen que caer por el `where {tenantId}` a
 * mano, no por RLS.
 *
 * `afterBookingsCommitted` se envuelve (spy sobre la real) solo para contar
 * que el alta emite UNA vez después del commit; la función bajo test es la
 * action real.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

const emitted = vi.hoisted(() => ({ calls: [] as Array<{ tenantId: string; refs: unknown[] }> }));
vi.mock("@/lib/booking-events-internal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/booking-events-internal")>();
  return {
    ...actual,
    afterBookingsCommitted: async (tenantId: string, refs: unknown[], opts?: { invalidateCaches?: boolean }) => {
      emitted.calls.push({ tenantId, refs });
      return actual.afterBookingsCommitted(tenantId, refs as never, opts);
    },
  };
});

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  createPlanFromDiagnosis,
  getDiagnosisPlanPrefill,
  loadCatalog,
  searchPatientsForAssignment,
} from "@/lib/diagnosis";
import { previewPlan } from "@/lib/plans";
import type { CreatePlanFromDiagnosisInput } from "@/lib/diagnosis-types";
import type { PlanCreateInput, PlanPreview, PlanRowResolution } from "@/lib/plans-types";
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

const EMPTY_SELECTION = { regions: [], symptoms: [], triggers: [], phase: null, intensity: 5 };

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

describe.skipIf(!RUN)("S17d · puerta Diagnóstico → plan", () => {
  let db: PrismaClient;
  let K: EphemeralTenant; // Kinesiología PRO
  let O: EphemeralTenant; // otro consultorio
  let G: EphemeralTenant; // General (sin diagnostico ni planes)
  let kineB: { userId: string; practitionerId: string }; // básico sobre los pacientes del OWNER
  let assistant: { userId: string; practitionerId: string };
  let condSlug: string;
  let foreignCondSlug: string;
  let exA: string; // ACTIVATION, sin dosis por defecto
  let exS: string; // STABILITY
  let exL: string; // LOAD, dosis 4×10
  let exForeign: string;
  let exArchived: string;

  const plan = (patientId: string, over: Partial<PlanCreateInput> = {}): PlanCreateInput => ({
    idempotencyKey: randomUUID(),
    patientId,
    discipline: "KINESIOLOGY",
    practitionerId: K.practitionerId,
    serviceId: K.serviceId,
    locationId: null,
    schedule: LUN_JUE_10,
    startDayKey: "2030-01-07",
    totalSessions: 4,
    pricing: null,
    // A propósito en orden "carga primero": la rampa ordena por fase.
    exercises: [
      { exerciseId: exL, sets: 4, reps: 10 },
      { exerciseId: exA, sets: 3, reps: 12 },
    ],
    rows: [],
    stateToken: "x",
    ...over,
  });

  const input = (p: PlanCreateInput, slug = condSlug): CreatePlanFromDiagnosisInput => ({
    plan: p,
    diagnosis: { conditionSlug: slug, selection: EMPTY_SELECTION },
  });

  /** preview real (`previewPlan`) → borrador con stateToken y resoluciones por defecto. */
  async function ready(p: PlanCreateInput): Promise<PlanCreateInput> {
    const r = await previewPlan(p);
    if (!r.ok) throw new Error(`preview falló: ${r.error}`);
    return { ...p, stateToken: r.preview.stateToken, rows: acceptDefaults(r.preview) };
  }

  const footprint = async (patientId: string) => {
    const [cases, dx, programs, bookings] = await Promise.all([
      db.clinicalCase.count({ where: { patientId } }),
      db.diagnosis.count({ where: { case: { patientId } } }),
      db.treatmentProgram.count({ where: { patientId } }),
      db.booking.count({ where: { patientId } }),
    ]);
    return { cases, dx, programs, bookings };
  };
  const NOTHING = { cases: 0, dx: 0, programs: 0, bookings: 0 };

  beforeAll(async () => {
    db = ownerClient();
    K = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "PRO" });
    O = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "PRO" });
    G = await createEphemeralTenant(db, { vertical: "GENERAL" });
    kineB = await addPractitioner(db, K, "PRACTITIONER");
    assistant = await addPractitioner(db, K, "ASSISTANT");

    const s = uniqueSuffix();
    condSlug = `cond-s17d-${s}`;
    foreignCondSlug = `cond-s17d-foreign-${s}`;
    const cond = await db.condition.create({ data: { slug: condSlug, name: "Lumbalgia S17d", tenantId: K.tenantId } });
    await db.condition.create({ data: { slug: foreignCondSlug, name: "Ajena S17d", tenantId: O.tenantId } });

    const mk = (data: { slug: string; name: string; tenantId: string; defaultSets?: number; defaultReps?: number; archivedAt?: Date }) =>
      db.exercise.create({ data }).then((e) => e.id);
    exA = await mk({ slug: `s17d-a-${s}`, name: "Activación", tenantId: K.tenantId });
    exS = await mk({ slug: `s17d-s-${s}`, name: "Estabilidad", tenantId: K.tenantId });
    exL = await mk({ slug: `s17d-l-${s}`, name: "Carga", tenantId: K.tenantId, defaultSets: 4, defaultReps: 10 });
    exForeign = await mk({ slug: `s17d-f-${s}`, name: "Ajeno", tenantId: O.tenantId });
    exArchived = await mk({ slug: `s17d-x-${s}`, name: "Archivado", tenantId: K.tenantId, archivedAt: new Date() });
    await db.conditionExerciseLink.createMany({
      data: [
        { conditionId: cond.id, exerciseId: exL, relation: "DIRECT", phase: "LOAD" },
        { conditionId: cond.id, exerciseId: exA, relation: "DIRECT", phase: "ACTIVATION" },
        // Mismo ejercicio con otra relación y fase más tardía: manda la más temprana.
        { conditionId: cond.id, exerciseId: exA, relation: "INDIRECT", phase: "PROGRESSION" },
        { conditionId: cond.id, exerciseId: exS, relation: "INDIRECT", phase: "STABILITY" },
        { conditionId: cond.id, exerciseId: exArchived, relation: "DIRECT", phase: "ACTIVATION" },
      ],
    });
  });

  afterAll(async () => {
    await K?.cleanup();
    await O?.cleanup();
    await G?.cleanup();
    await db?.$disconnect();
  });

  beforeEach(() => {
    emitted.calls.length = 0;
  });

  it("alta completa: caso + diagnóstico + plan + turnos en una tx, rampa por fase, un solo emit", async () => {
    asUser(K.userId);
    const patientId = await addPatient(db, K);
    const draft = await ready(plan(patientId));
    const r = await createPlanFromDiagnosis(input(draft));
    expect(r).toMatchObject({ ok: true, idempotent: false });
    if (!r.ok) return;
    expect(r.caseId).toBeTruthy();

    const program = await db.treatmentProgram.findUniqueOrThrow({
      where: { id: r.programId },
      include: {
        sessions: { orderBy: { index: "asc" }, include: { exercises: { orderBy: { order: "asc" } } } },
        bookings: true,
      },
    });
    expect(program.tenantId).toBe(K.tenantId);
    expect(program.caseId).toBe(r.caseId);
    expect(program.totalSessions).toBe(4);
    expect(program.bookings).toHaveLength(4);
    expect(program.bookings.every((b) => b.programId === program.id && b.status === "CONFIRMED")).toBe(true);

    // Rampa (N=4: escalones 0,1,2,3): activación sola hasta que entra carga en la 3.
    expect(program.sessions.map((s) => s.exercises.map((e) => e.exerciseId))).toEqual([
      [exA],
      [exA],
      [exA, exL],
      [exA, exL],
    ]);
    // Orden 1..n y la dosis del borrador.
    const s3 = program.sessions[2].exercises;
    expect(s3.map((e) => e.order)).toEqual([1, 2]);
    expect(s3.map((e) => [e.sets, e.reps])).toEqual([[3, 12], [4, 10]]);

    const kase = await db.clinicalCase.findUniqueOrThrow({ where: { id: r.caseId! }, include: { diagnoses: true } });
    expect(kase.tenantId).toBe(K.tenantId);
    expect(kase.patientId).toBe(patientId);
    expect(kase.authorId).toBe(K.practitionerId);
    // La condición custom no rankea (sin tags/anatomía): igual queda confirmada.
    expect(kase.diagnoses.filter((d) => d.confirmed)).toHaveLength(1);

    const audits = await db.auditEvent.findMany({ where: { tenantId: K.tenantId, entityId: { in: [program.id, kase.id] } } });
    const actions = audits.map((a) => a.action);
    expect(actions).toContain("program.create");
    expect(actions).toContain("diagnosis.assign");
    const pc = audits.find((a) => a.action === "program.create")!;
    expect((pc.payload as { origin?: string }).origin).toBe("diagnosis");
    // Sin PHI en el audit del caso: ids y conteos.
    expect(JSON.stringify(audits.find((a) => a.action === "diagnosis.assign")!.payload)).not.toContain("Lumbalgia");

    expect(emitted.calls).toHaveLength(1);
    expect(emitted.calls[0].tenantId).toBe(K.tenantId);
    expect(emitted.calls[0].refs).toHaveLength(4);
  });

  it("misma key ×2 → un solo caso y un solo plan; el segundo es idempotente y no emite", async () => {
    asUser(K.userId);
    const patientId = await addPatient(db, K);
    const draft = await ready(plan(patientId, { totalSessions: 2, startDayKey: "2030-02-04" }));
    const a = await createPlanFromDiagnosis(input(draft));
    emitted.calls.length = 0;
    const b = await createPlanFromDiagnosis(input(draft));
    expect(a).toMatchObject({ ok: true, idempotent: false });
    expect(b).toMatchObject({ ok: true, idempotent: true });
    if (!a.ok || !b.ok) return;
    expect(b.programId).toBe(a.programId);
    expect(b.caseId).toBe(a.caseId);
    expect(await footprint(patientId)).toMatchObject({ cases: 1, programs: 1, bookings: 2 });
    expect(emitted.calls).toHaveLength(0);
  });

  it("un stale (borrador cambiado) no deja nada: ni caso, ni diagnóstico, ni plan, ni turnos", async () => {
    asUser(K.userId);
    const patientId = await addPatient(db, K);
    const r = await createPlanFromDiagnosis(input(plan(patientId, { stateToken: "no-es-el-token" })));
    expect(r).toMatchObject({ ok: false, kind: "stale-preview" });
    expect(await footprint(patientId)).toEqual(NOTHING);
    expect(emitted.calls).toHaveLength(0);
  });

  it("un stale por fila (el cupo se llenó después del preview) no deja nada", async () => {
    asUser(K.userId);
    const patientId = await addPatient(db, K);
    const other = await addPatient(db, K);
    const svc = await addService(db, K, { name: `Cupo1 ${uniqueSuffix()}`, durationMin: 45, maxConcurrent: 1 });
    const draft = await ready(plan(patientId, { serviceId: svc, totalSessions: 2, startDayKey: "2030-03-04" }));
    await db.booking.create({
      data: {
        tenantId: K.tenantId,
        patientId: other,
        practitionerId: K.practitionerId,
        serviceId: svc,
        scheduledFor: new Date("2030-03-04T13:00:00Z"),
        durationMin: 45,
        idempotencyKey: randomUUID(),
        status: "CONFIRMED",
      },
    });
    const r = await createPlanFromDiagnosis(input(draft));
    expect(r).toMatchObject({ ok: false, kind: "stale-preview" });
    expect(await footprint(patientId)).toEqual(NOTHING);
  });

  it("acceso básico → rechazo y nada escrito", async () => {
    asUser(K.userId);
    const patientId = await addPatient(db, K);
    const draft = await ready(plan(patientId, { startDayKey: "2030-04-01" }));
    asUser(kineB.userId);
    const r = await createPlanFromDiagnosis(input(draft));
    expect(r.ok).toBe(false);
    expect(await footprint(patientId)).toEqual(NOTHING);
  });

  it("Secretaria (sin plans.manage) → rechazo", async () => {
    asUser(K.userId);
    const patientId = await addPatient(db, K);
    const draft = await ready(plan(patientId, { startDayKey: "2030-04-08" }));
    asUser(assistant.userId);
    expect((await createPlanFromDiagnosis(input(draft))).ok).toBe(false);
    expect((await getDiagnosisPlanPrefill({ conditionSlug: condSlug })).ok).toBe(false);
    expect(await footprint(patientId)).toEqual(NOTHING);
  });

  it("sin ejercicios → rechazo (regla ≥ 1)", async () => {
    asUser(K.userId);
    const patientId = await addPatient(db, K);
    for (const exercises of [[], undefined]) {
      const r = await createPlanFromDiagnosis(input(plan(patientId, { exercises })));
      expect(r).toMatchObject({ ok: false, error: "El plan necesita al menos un ejercicio." });
    }
    expect(await footprint(patientId)).toEqual(NOTHING);
  });

  it("ejercicio de otro consultorio / archivado, con uno válido al lado → rechazo total", async () => {
    asUser(K.userId);
    const patientId = await addPatient(db, K);
    for (const bad of [exForeign, exArchived]) {
      const p = plan(patientId, {
        exercises: [
          { exerciseId: exA, sets: 3, reps: 12 },
          { exerciseId: bad, sets: 3, reps: 12 },
        ],
      });
      const r = await createPlanFromDiagnosis(input(p));
      expect(r.ok, `ejercicio ${bad}`).toBe(false);
    }
    expect(await footprint(patientId)).toEqual(NOTHING);
  });

  it("condición custom de otro consultorio → «Diagnóstico desconocido.»", async () => {
    asUser(K.userId);
    const patientId = await addPatient(db, K);
    const draft = await ready(plan(patientId, { startDayKey: "2030-05-06" }));
    const r = await createPlanFromDiagnosis(input(draft, foreignCondSlug));
    expect(r).toMatchObject({ ok: false, error: "Diagnóstico desconocido." });
    expect(await footprint(patientId)).toEqual(NOTHING);
  });

  it("paciente de otro consultorio → rechazo", async () => {
    asUser(K.userId);
    const foreignPatient = await addPatient(db, O);
    const r = await createPlanFromDiagnosis(input(plan(foreignPatient)));
    expect(r.ok).toBe(false);
    expect(await footprint(foreignPatient)).toEqual(NOTHING);
  });

  it("prefill: fases de los vínculos (la más temprana), orden por fase, dosis ?? 3×12 y rampa", async () => {
    asUser(K.userId);
    const r = await getDiagnosisPlanPrefill({ conditionSlug: condSlug });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.discipline).toBe("KINESIOLOGY");
    expect(r.data.title).toBe("Plan Lumbalgia S17d");
    expect(r.data.totalSessions).toBe(10);
    // El archivado no se sugiere; exA tiene ACTIVATION y PROGRESSION → ACTIVATION.
    expect(r.data.exercises.map((e) => [e.exerciseId, e.phase, e.sets, e.reps])).toEqual([
      [exA, "ACTIVATION", 3, 12],
      [exS, "STABILITY", 3, 12],
      [exL, "LOAD", 4, 10],
    ]);
    expect(r.data.ramp).toEqual([
      { phase: "ACTIVATION", fromSession: 1, toSession: 3, exerciseCount: 1 },
      { phase: "STABILITY", fromSession: 4, toSession: 5, exerciseCount: 2 },
      { phase: "LOAD", fromSession: 6, toSession: 10, exerciseCount: 3 },
    ]);

    const chosen = await getDiagnosisPlanPrefill({ conditionSlug: condSlug, exerciseIds: [exL], totalSessions: 4 });
    expect(chosen).toMatchObject({ ok: true, data: { totalSessions: 4, exercises: [{ exerciseId: exL, phase: "LOAD" }] } });

    expect(await getDiagnosisPlanPrefill({ conditionSlug: condSlug, exerciseIds: [exA, exForeign] })).toMatchObject({ ok: false });
    expect(await getDiagnosisPlanPrefill({ conditionSlug: foreignCondSlug })).toEqual({ ok: false, error: "Diagnóstico desconocido." });
  });

  it("consultorio General: sin `diagnostico` todo cierra (vacío o rechazo) y no escribe", async () => {
    asUser(G.userId);
    const patientId = await addPatient(db, G);
    expect(await loadCatalog()).toEqual({ regions: [], conditions: [], symptoms: [], triggers: [], phases: [] });
    expect(await searchPatientsForAssignment("")).toEqual([]);
    expect(await searchPatientsForAssignment("", { requireFull: true })).toEqual([]);
    expect((await getDiagnosisPlanPrefill({ conditionSlug: condSlug })).ok).toBe(false);
    const r = await createPlanFromDiagnosis(
      input(plan(patientId, { practitionerId: G.practitionerId, serviceId: G.serviceId }))
    );
    expect(r).toMatchObject({ ok: false });
    expect(await footprint(patientId)).toEqual(NOTHING);
  });

  it("searchPatientsForAssignment: firma aditiva; las dos ramas devuelven solo filas full (H-b4)", async () => {
    asUser(K.userId);
    const mine = await addPatient(db, K, { lastName: `Mio ${uniqueSuffix()}` });
    const def = await searchPatientsForAssignment("Mio");
    const full = await searchPatientsForAssignment("Mio", { requireFull: true });
    expect(def.map((p) => p.id)).toContain(mine);
    expect(full).toEqual(def);
    // El kine básico no ve los pacientes del OWNER en ninguna de las dos ramas.
    asUser(kineB.userId);
    expect((await searchPatientsForAssignment("Mio")).map((p) => p.id)).not.toContain(mine);
    expect((await searchPatientsForAssignment("Mio", { requireFull: false })).map((p) => p.id)).not.toContain(mine);
  });
});
