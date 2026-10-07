/**
 * P0-S02d (Planes, ola P0.1) — gates de la puerta "Diagnóstico", re-afirmados
 * en P3.Z.0 (S27b) sobre la puerta NUEVA, `createPlanFromDiagnosis` (caso +
 * diagnóstico + plan + sesiones + turnos en una tx del motor), antes de
 * retirar el alta vieja del Plan Builder (que creaba caso + plan + N sesiones
 * a mano, fuera del motor).
 *
 * Lo que S02d había cerrado en el alta vieja, y que la nueva tiene que seguir
 * cumpliendo:
 *  - acceso básico (solo ver) no crea plan ni ClinicalCase;
 *  - ejercicios `assignable` con el plan SaaS del consultorio: uno de otro
 *    tenant, uno global PRO en un consultorio FREE o uno archivado → rechazo
 *    TOTAL aunque haya uno válido al lado;
 *  - condición por slug: la custom de otro consultorio no existe (en prod la
 *    conexión tiene BYPASSRLS: el `where {tenantId}` a mano es la barrera);
 *  - tope de 60 sesiones (PD-04);
 *  - los días elegidos mandan (antes repartía por frecuencia desde el inicio);
 *  - dosis por defecto 3×12 para un ejercicio sin dosis;
 *  - audit en la tx, con ids y sin el nombre del diagnóstico (C8).
 * Mapeo: los "días de la semana" (`daysOfWeek`, 0=Lun) del alta vieja son
 * ahora el horario C6 del borrador (`schedule.slots[].dow`, 0=Dom). La dosis
 * 3×12 la propone el prefill (`getDiagnosisPlanPrefill`) y el alta la guarda.
 *
 * Corre con los dos roles (`kinesoft_app` y owner BYPASSRLS = prod): los casos
 * de otro consultorio tienen que caer por el filtro a mano, no por RLS.
 *
 * Datos: tenants efímeros (tenant-factory) — T es Kinesiología FREE (default
 * del schema: tiene `planes` y `diagnostico`, solo ejercicios propios) — y un
 * ejercicio global no-basic propio del test que se borra en el afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import * as diagnosisModule from "@/lib/diagnosis";
import { createPlanFromDiagnosis, getDiagnosisPlanPrefill } from "@/lib/diagnosis";
import { previewPlan } from "@/lib/plans";
import type { CreatePlanFromDiagnosisInput } from "@/lib/diagnosis-types";
import type { PlanCreateInput, PlanPreview, PlanRowResolution } from "@/lib/plans-types";
import { toARDateKey, toARDow } from "@/lib/datetime-ar";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
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

describe.skipIf(!RUN)("P0-S02d · gates de Diagnóstico (sobre createPlanFromDiagnosis, P3.Z.0)", () => {
  let db: PrismaClient;
  let T: EphemeralTenant; // Kinesiología FREE (default del schema)
  let T2: EphemeralTenant; // otro consultorio
  let kineB: { userId: string; practitionerId: string }; // básico sobre los pacientes del OWNER
  let condSlug: string; // condición custom de T
  let foreignCondSlug: string; // condición custom de T2
  let exOwn: string; // ejercicio propio de T, sin dosis por defecto
  let exForeign: string; // ejercicio propio de T2
  let exArchived: string; // ejercicio propio de T, archivado
  let exGlobalPro: string; // global no-basic (solo PRO/ENTERPRISE)

  /** Borrador del motor (C10), 4 sesiones lun/jue desde el martes 08/01/2030. */
  const plan = (patientId: string, over: Partial<PlanCreateInput> = {}): PlanCreateInput => ({
    idempotencyKey: randomUUID(),
    patientId,
    discipline: "KINESIOLOGY",
    practitionerId: T.practitionerId,
    serviceId: T.serviceId,
    locationId: null,
    schedule: LUN_JUE_10,
    startDayKey: "2030-01-08", // martes
    totalSessions: 4,
    pricing: null,
    exercises: [{ exerciseId: exOwn, sets: 3, reps: 12 }],
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

  const countPlans = (patientId: string) =>
    Promise.all([
      db.clinicalCase.count({ where: { patientId } }),
      db.treatmentProgram.count({ where: { patientId } }),
    ]);

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
    T2 = await createEphemeralTenant(db);
    kineB = await addPractitioner(db, T, "PRACTITIONER");

    const s = uniqueSuffix();
    condSlug = `cond-s02d-${s}`;
    foreignCondSlug = `cond-s02d-foreign-${s}`;
    await db.condition.create({ data: { slug: condSlug, name: "Lumbalgia S02d", tenantId: T.tenantId } });
    await db.condition.create({ data: { slug: foreignCondSlug, name: "Ajena S02d", tenantId: T2.tenantId } });

    exOwn = (
      await db.exercise.create({ data: { slug: `ex-own-${s}`, name: "Puente", tenantId: T.tenantId } })
    ).id;
    exForeign = (
      await db.exercise.create({ data: { slug: `ex-foreign-${s}`, name: "Ajeno", tenantId: T2.tenantId } })
    ).id;
    exArchived = (
      await db.exercise.create({
        data: { slug: `ex-arch-${s}`, name: "Archivado", tenantId: T.tenantId, archivedAt: new Date() },
      })
    ).id;
    exGlobalPro = (
      await db.exercise.create({ data: { slug: `ex-global-pro-${s}`, name: "Global PRO", isBasic: false } })
    ).id;
  });

  afterAll(async () => {
    await T?.cleanup();
    await T2?.cleanup();
    if (exGlobalPro) await db.exercise.delete({ where: { id: exGlobalPro } }).catch(() => {});
    await db?.$disconnect();
  });

  it("[P0-S02d] acceso básico no crea plan ni ClinicalCase", async () => {
    asUser(T.userId);
    const pat = await addPatient(db, T); // asignado al OWNER
    const draft = await ready(plan(pat));
    asUser(kineB.userId);
    const r = await createPlanFromDiagnosis(input(draft));
    expect(r.ok).toBe(false);
    expect(await countPlans(pat)).toEqual([0, 0]);
  });

  it("[P0-S02d] ejercicio de otro tenant / PRO en FREE / archivado → rechazo", async () => {
    asUser(T.userId);
    const pat = await addPatient(db, T);
    for (const bad of [exForeign, exGlobalPro, exArchived]) {
      // Con uno válido al lado: antes solo se rechazaba si no quedaba ninguno.
      const r = await createPlanFromDiagnosis(
        input(plan(pat, { exercises: [{ exerciseId: exOwn, sets: 3, reps: 12 }, { exerciseId: bad, sets: 3, reps: 12 }] }))
      );
      expect(r.ok, `ejercicio ${bad}`).toBe(false);
      expect(r).not.toMatchObject({ kind: "stale-preview" }); // por el ejercicio, no por el token
    }
    expect(await countPlans(pat)).toEqual([0, 0]);
  });

  it("[P0-S02d] condición por slug de otro tenant → no encontrada", async () => {
    asUser(T.userId);
    const pat = await addPatient(db, T);
    const draft = await ready(plan(pat));
    const r = await createPlanFromDiagnosis(input(draft, foreignCondSlug));
    expect(r).toMatchObject({ ok: false, error: "Diagnóstico desconocido." });
    expect(await countPlans(pat)).toEqual([0, 0]);
  });

  it("[P0-S02d] totalSessions 61 → rechazo", async () => {
    asUser(T.userId);
    const pat = await addPatient(db, T);
    const r = await createPlanFromDiagnosis(input(plan(pat, { totalSessions: 61 })));
    expect(r.ok).toBe(false);
    expect(await countPlans(pat)).toEqual([0, 0]);
  });

  it("[P0-S02d] la superficie RPC de Diagnóstico es solo la nueva (sin el alta vieja ni saveDiagnosisDraft)", () => {
    // Lista blanca: un export nuevo de este "use server" es una RPC pública y
    // tiene que pasar por acá a propósito.
    expect(Object.keys(diagnosisModule).sort()).toEqual([
      "createPlanFromDiagnosis",
      "getDiagnosisPlanPrefill",
      "loadCatalog",
      "searchPatientsForAssignment",
    ]);
  });

  it("[P0-S02d] Asignar plan lun/jue → sesiones solo lun/jue AR", async () => {
    asUser(T.userId);
    const patLJ = await addPatient(db, T);
    const r = await createPlanFromDiagnosis(input(await ready(plan(patLJ, { startDayKey: "2030-01-15" }))));
    expect(r.ok).toBe(true);
    const sessions = await db.session.findMany({
      where: { program: { patientId: patLJ } },
      orderBy: { index: "asc" },
      select: { index: true, scheduledFor: true },
    });
    // Arranca el martes 15/01: la primera es el jueves 17, no el martes.
    expect(sessions.map((x) => toARDateKey(x.scheduledFor))).toEqual([
      "2030-01-17",
      "2030-01-21",
      "2030-01-24",
      "2030-01-28",
    ]);
    // 1=Lun, 4=Jue en la convención de Date#getDay (0=Dom) que usa toARDow.
    expect(sessions.every((x) => [1, 4].includes(toARDow(x.scheduledFor)))).toBe(true);
    // A la hora del horario en AR (10:00 AR = 13:00Z), sin depender de la TZ del host.
    expect(sessions.every((x) => x.scheduledFor.toISOString().endsWith("T13:00:00.000Z"))).toBe(true);
  });

  // ── Funcionalidad y controles (no son bugs vivos: `it`) ────────────────

  it("control positivo: el OWNER (full) crea caso + plan con dosis 3×12 por defecto (vía prefill)", async () => {
    asUser(T.userId);
    const patOk = await addPatient(db, T);
    // El prefill propone la dosis: `exOwn` no tiene dosis por defecto → 3×12.
    const pre = await getDiagnosisPlanPrefill({ conditionSlug: condSlug, exerciseIds: [exOwn], totalSessions: 4 });
    expect(pre.ok).toBe(true);
    if (!pre.ok) return;
    expect(pre.data.exercises.map((e) => [e.exerciseId, e.sets, e.reps])).toEqual([[exOwn, 3, 12]]);

    const draft = await ready(
      plan(patOk, {
        startDayKey: "2030-02-05",
        title: pre.data.title,
        exercises: pre.data.exercises.map(({ exerciseId, sets, reps }) => ({ exerciseId, sets, reps })),
      })
    );
    const r = await createPlanFromDiagnosis(input(draft));
    expect(r).toMatchObject({ ok: true, idempotent: false });
    if (!r.ok) return;
    expect(await countPlans(patOk)).toEqual([1, 1]);
    const program = await db.treatmentProgram.findFirstOrThrow({
      where: { patientId: patOk },
      include: { sessions: { orderBy: { index: "asc" }, include: { exercises: true } } },
    });
    expect(program.tenantId).toBe(T.tenantId);
    expect(program.caseId).toBe(r.caseId);
    expect(program.title).toBe("Plan Lumbalgia S02d");
    expect(program.totalSessions).toBe(4);
    expect(program.sessions).toHaveLength(4);
    // Día AR del inicio (no la medianoche UTC, que en AR es el día anterior).
    expect(toARDateKey(program.startDate)).toBe("2030-02-05");
    const ex = program.sessions[0].exercises[0];
    expect([ex.exerciseId, ex.sets, ex.reps]).toEqual([exOwn, 3, 12]);
    // Audit en la misma tx (auditInTx), con ids y sin el nombre del diagnóstico.
    const ev = await db.auditEvent.findFirstOrThrow({
      where: { tenantId: T.tenantId, action: "diagnosis.assign", entityId: r.caseId! },
    });
    expect(ev.payload).toMatchObject({ programId: r.programId, totalSessions: 4, exerciseCount: 1 });
    expect(ev.payload).not.toHaveProperty("condition");
    expect(JSON.stringify(ev.payload)).not.toContain("Lumbalgia");
  });

  it("días inválidos (fuera de 0..6 o no enteros) → rechazo sin escribir", async () => {
    asUser(T.userId);
    const patBad = await addPatient(db, T);
    for (const dow of [7, -1, 1.5]) {
      const r = await createPlanFromDiagnosis(
        input(plan(patBad, { schedule: { v: 1, frequency: "weekly", slots: [{ dow, startMin: 600 }] } as never }))
      );
      expect(r.ok, String(dow)).toBe(false);
    }
    expect(await countPlans(patBad)).toEqual([0, 0]);
  });

  it("paciente de otro tenant → rechazo (no se revela)", async () => {
    asUser(T.userId);
    const patForeign = await addPatient(db, T2);
    const r = await createPlanFromDiagnosis(input(plan(patForeign)));
    expect(r.ok).toBe(false);
    expect(r).not.toMatchObject({ kind: "stale-preview" });
    expect(await countPlans(patForeign)).toEqual([0, 0]);
  });
});
