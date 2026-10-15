/**
 * Planes P0.1 · S02t — gates de plantillas, re-afirmados en P3.Z.0 (S27b)
 * sobre la puerta NUEVA antes de retirar el "aplicar" viejo (que creaba plan
 * + N sesiones a mano, sin turnos ni locks).
 *
 * Aplicar una plantilla hoy = `getTemplatePrefill` (borrador del editor) →
 * `previewPlan` → `createPlan` con `templateId` (el motor, única alta de
 * planes). Lo que S02t había cerrado y que la puerta nueva tiene que cumplir:
 *  - acceso full al paciente + rol que lee clínica y crea planes (PD-09: la
 *    Secretaria no crea planes), dentro de la tx que escribe; antes un
 *    profesional en básico le armaba un plan a un paciente ajeno;
 *  - plantillas solo con el módulo `plantillas` (FREE no aplica);
 *  - ejercicios `assignable` (visibilidad del plan SaaS y no archivados) y,
 *    en el prefill, el orden de la plantilla compactado sin los que cayeron;
 *  - dosis `?? 3/12` (un ejercicio sin dosis por defecto hacía explotar el
 *    create: `SessionExercise.sets/reps` son NOT NULL);
 *  - tope `PLAN_MAX_SESSIONS` (60) y día AR;
 *  - plantilla o paciente de otro consultorio → rechazo;
 *  - `deletePlanTemplate`: solo el autor o un OWNER/ADMIN.
 *
 * Corre con los dos roles de DB (kinesoft_app y owner BYPASSRLS): bajo owner
 * el `where: { tenantId }` a mano es la única barrera.
 */
import { SAAS_PLAN_OF_LEGACY } from "@/lib/saas-plans-logic";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient, TenantPlan } from "@prisma/client";
import { deletePlanTemplate, getTemplatePrefill } from "@/lib/plan-templates";
import { createPlan, previewPlan } from "@/lib/plans";
import type { PlanCreateInput, PlanPreview, PlanRowResolution } from "@/lib/plans-types";
import { toARDateKey } from "@/lib/datetime-ar";
import { PLAN_MAX_SESSIONS } from "@/lib/plans-constants";
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

/** Martes y viernes 10:00 AR (C6: 0=Dom). Las plantillas viejas no guardan horario: lo pone el editor. */
const MAR_VIE_10 = {
  v: 1 as const,
  frequency: "weekly" as const,
  slots: [
    { dow: 2 as const, startMin: 600 },
    { dow: 5 as const, startMin: 600 },
  ],
};

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

describe.skipIf(!RUN)("[P0-S02t] gates de plantillas (sobre createPlan con templateId, P3.Z.0)", () => {
  let db: PrismaClient;
  let T: EphemeralTenant; // STARTER: puede usar plantillas
  let TFree: EphemeralTenant; // FREE: no
  let TOther: EphemeralTenant; // otro consultorio
  let kineAssigned: { userId: string; practitionerId: string };
  let kineBasic: { userId: string; practitionerId: string };
  let assistant: { userId: string; practitionerId: string };
  let svc: string; // Kine, sin dueño (habilitado para todos los profesionales de T)
  let exFull: string; // con dosis 4×10
  let exNullDose: string; // dosis null
  let exArchived: string;
  let exOtherTenant: string;
  let tplFull: string;
  let startDay = 0;

  /** Un lunes distinto por alta (2030), para que dos planes no compitan por el mismo hueco. */
  const nextStartDayKey = () => {
    startDay += 1;
    return toARDateKey(new Date(Date.parse("2030-01-07T15:00:00Z") + startDay * 7 * 86_400_000));
  };

  async function setPlan(t: EphemeralTenant, plan: TenantPlan) {
    // PL-1: la app lee `saasPlan`; se escriben los dos como el escritor único (espejo PL-D1).
    await db.tenant.update({ where: { id: t.tenantId }, data: { plan, saasPlan: SAAS_PLAN_OF_LEGACY[plan] } });
  }

  async function addExercise(
    tenantId: string,
    data: { defaultSets?: number | null; defaultReps?: number | null; archivedAt?: Date | null } = {}
  ): Promise<string> {
    const s = uniqueSuffix();
    const ex = await db.exercise.create({
      data: {
        tenantId,
        slug: `s02t-${s}`,
        name: `Ejercicio ${s}`,
        defaultSets: data.defaultSets ?? null,
        defaultReps: data.defaultReps ?? null,
        archivedAt: data.archivedAt ?? null,
      },
    });
    return ex.id;
  }

  /** Plantilla "vieja" (sin servicio ni horario), por insert directo. */
  async function addTemplate(
    t: EphemeralTenant,
    authorId: string,
    exerciseIds: string[],
    totalSessions = 4,
    frequency = 2
  ): Promise<string> {
    const row = await db.planTemplate.create({
      data: {
        tenantId: t.tenantId,
        authorId,
        name: `Plantilla ${uniqueSuffix()}`,
        totalSessions,
        frequency,
        exerciseIds,
      },
    });
    return row.id;
  }

  /**
   * Lo que hace el editor al "aplicar": prefill → borrador C10 (lo que la
   * plantilla no guarda lo completa el editor: responsable, horario, día).
   */
  async function draftFromTemplate(templateId: string, patientId: string, over: Partial<PlanCreateInput> = {}) {
    const pre = await getTemplatePrefill(templateId);
    if (!pre.ok) throw new Error(`prefill: ${pre.error}`);
    const p = pre.data.prefill;
    const draft: PlanCreateInput = {
      idempotencyKey: randomUUID(),
      patientId,
      discipline: p.discipline ?? "KINESIOLOGY",
      practitionerId: kineAssigned.practitionerId,
      serviceId: p.serviceId ?? svc,
      locationId: null,
      ...(p.durationMin != null ? { durationMin: p.durationMin } : {}),
      schedule: p.schedule ?? MAR_VIE_10,
      startDayKey: nextStartDayKey(),
      totalSessions: p.totalSessions ?? 4,
      pricing: p.pricing ?? null,
      ...(p.templateId ? { templateId: p.templateId } : {}),
      title: pre.data.title,
      exercises: pre.data.exercises.map(({ exerciseId, sets, reps }) => ({ exerciseId, sets, reps })),
      rows: [],
      stateToken: "x",
      ...over,
    };
    return { draft, prefill: pre.data };
  }

  /** preview real → borrador con stateToken y resoluciones por defecto. */
  async function ready(p: PlanCreateInput): Promise<PlanCreateInput> {
    const r = await previewPlan(p);
    if (!r.ok) throw new Error(`preview: ${r.error}`);
    return { ...p, stateToken: r.preview.stateToken, rows: acceptDefaults(r.preview) };
  }

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
    TFree = await createEphemeralTenant(db);
    TOther = await createEphemeralTenant(db);
    await setPlan(T, "STARTER");
    await setPlan(TOther, "STARTER");
    kineAssigned = await addPractitioner(db, T, "PRACTITIONER");
    kineBasic = await addPractitioner(db, T, "PRACTITIONER");
    assistant = await addPractitioner(db, T, "ASSISTANT");
    svc = (
      await db.service.create({
        data: { tenantId: T.tenantId, practitionerId: null, name: `Kine ${uniqueSuffix()}`, durationMin: 45, discipline: "KINESIOLOGY" },
      })
    ).id;

    exFull = await addExercise(T.tenantId, { defaultSets: 4, defaultReps: 10 });
    exNullDose = await addExercise(T.tenantId);
    exArchived = await addExercise(T.tenantId, { defaultSets: 2, defaultReps: 8, archivedAt: new Date() });
    exOtherTenant = await addExercise(TOther.tenantId, { defaultSets: 5, defaultReps: 5 });
    tplFull = await addTemplate(T, kineAssigned.practitionerId, [exFull]);
  });

  afterAll(async () => {
    await T?.cleanup();
    await TFree?.cleanup();
    await TOther?.cleanup();
    await db?.$disconnect();
  });

  const programsOf = (patientId: string) => db.treatmentProgram.count({ where: { patientId } });
  const myPatient = () => addPatient(db, T, { assignedPractitionerId: kineAssigned.practitionerId });

  describe("aplicar = prefill + createPlan con templateId", () => {
    it("[P0-S02t] básico no aplica plantilla", async () => {
      asUser(kineAssigned.userId);
      const pat = await myPatient();
      const draft = await ready((await draftFromTemplate(tplFull, pat)).draft);
      asUser(kineBasic.userId);
      const r = await createPlan(draft);
      expect(r.ok).toBe(false);
      expect(await programsOf(pat)).toBe(0);
    });

    it("[P0-S02t] FREE no prellena (sin `plantillas`)", async () => {
      const tpl = await addTemplate(TFree, TFree.practitionerId, []);
      asUser(TFree.userId); // OWNER: acceso full, solo lo frena el plan SaaS
      expect(await getTemplatePrefill(tpl)).toMatchObject({ ok: false, error: expect.stringMatching(/Mejorá tu plan/) });
    });

    // P3.Z (F1): el motor validaba que la plantilla fuera del consultorio y no
    // estuviera archivada, pero no miraba el módulo `plantillas`; un FREE (o un
    // STARTER que bajó de plan) con filas viejas la "aplicaba" por RPC. Era una
    // barrera perdida al retirar el "aplicar" viejo. Ahora `validatePlanRefsInTx`
    // exige `canBuildTemplates` con `templateId` (enmienda EV0, literal).
    it("[P3-S27b] FREE: createPlan con templateId → rechazo sin crear plan", async () => {
      const tpl = await addTemplate(TFree, TFree.practitionerId, []);
      asUser(TFree.userId);
      const patFree = await addPatient(db, TFree);
      const base: PlanCreateInput = {
        idempotencyKey: randomUUID(),
        patientId: patFree,
        discipline: "KINESIOLOGY",
        practitionerId: TFree.practitionerId,
        serviceId: TFree.serviceId,
        locationId: null,
        schedule: MAR_VIE_10,
        startDayKey: nextStartDayKey(),
        totalSessions: 2,
        pricing: null,
        templateId: tpl,
        rows: [],
        stateToken: "x",
      };
      const pv = await previewPlan(base);
      const r = pv.ok
        ? await createPlan({ ...base, stateToken: pv.preview.stateToken, rows: acceptDefaults(pv.preview) })
        : pv;
      expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/plantillas.*plan Consultorio/) });
      expect(await programsOf(patFree)).toBe(0);
      // Y el commit directo (sin pasar por el preview) también rechaza por el módulo.
      const direct = await createPlan({ ...base, idempotencyKey: randomUUID() });
      expect(direct).toMatchObject({ ok: false, error: expect.stringMatching(/plantillas.*plan Consultorio/) });
      expect(await programsOf(patFree)).toBe(0);
    });

    it("[P0-S02t] plantilla con dosis null crea 3×12 (el prefill propone la dosis; el orden de la plantilla se respeta)", async () => {
      const tpl = await addTemplate(T, kineAssigned.practitionerId, [exNullDose, exFull], 2, 1);
      asUser(kineAssigned.userId);
      const pat = await myPatient();
      const r = await createPlan(await ready((await draftFromTemplate(tpl, pat)).draft));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const rows = await db.sessionExercise.findMany({
        where: { session: { programId: r.programId } },
        select: { exerciseId: true, order: true, sets: true, reps: true },
        orderBy: [{ session: { index: "asc" } }, { order: "asc" }],
      });
      expect(rows).toEqual([
        { exerciseId: exNullDose, order: 1, sets: 3, reps: 12 },
        { exerciseId: exFull, order: 2, sets: 4, reps: 10 },
        { exerciseId: exNullDose, order: 1, sets: 3, reps: 12 },
        { exerciseId: exFull, order: 2, sets: 4, reps: 10 },
      ]);
      expect((await db.treatmentProgram.findUniqueOrThrow({ where: { id: r.programId } })).templateId).toBe(tpl);
    });

    // P3.Z (F1): sin `exercises` en el borrador, el motor tomaba los de la
    // plantilla con 3×12 FIJO, ignorando la dosis por defecto del ejercicio. El
    // "aplicar" viejo hacía `defaultSets ?? 3` / `defaultReps ?? 12` (C8). La UI
    // manda siempre los ejercicios del prefill, así que solo pegaba por RPC.
    it("[P3-S27b] createPlan con templateId y sin exercises usa la dosis por defecto del ejercicio (?? 3×12)", async () => {
      const tpl = await addTemplate(T, kineAssigned.practitionerId, [exNullDose, exFull], 1, 1);
      asUser(kineAssigned.userId);
      const pat = await myPatient();
      const { draft } = await draftFromTemplate(tpl, pat);
      const r = await createPlan(await ready({ ...draft, exercises: undefined }));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const rows = await db.sessionExercise.findMany({
        where: { session: { programId: r.programId } },
        select: { exerciseId: true, order: true, sets: true, reps: true },
        orderBy: { order: "asc" },
      });
      expect(rows).toEqual([
        { exerciseId: exNullDose, order: 1, sets: 3, reps: 12 },
        { exerciseId: exFull, order: 2, sets: 4, reps: 10 },
      ]);
    });

    it("[P3-Z] ejercicio de la plantilla archivado DESPUÉS: el alta entra (con el vínculo) y lo saltea; el del cliente sí se rechaza", async () => {
      // Antes: con `templateId`, `validatePlanRefsInTx` re-validaba TODOS los ids
      // guardados en la plantilla → un ejercicio archivado después de guardarla
      // mataba el alta entera, y por eso el prefill omitía `templateId` (se
      // perdía el vínculo `TreatmentProgram.templateId`). Ahora los ids de la
      // plantilla se filtran por asignables y solo se rechazan los del cliente.
      const exLater = await addExercise(T.tenantId, { defaultSets: 2, defaultReps: 15 });
      const tpl = await addTemplate(T, kineAssigned.practitionerId, [exLater, exFull], 1, 1);
      await db.exercise.update({ where: { id: exLater }, data: { archivedAt: new Date() } });
      asUser(kineAssigned.userId);

      // Camino de la UI: prefill (con templateId) → ejercicios del prefill.
      const pat = await myPatient();
      const { draft, prefill } = await draftFromTemplate(tpl, pat);
      expect(prefill.droppedExercises).toBe(1);
      expect(prefill.prefill.templateId).toBe(tpl);
      const r = await createPlan(await ready(draft));
      expect(r).toMatchObject({ ok: true });
      if (!r.ok) return;
      expect((await db.treatmentProgram.findUniqueOrThrow({ where: { id: r.programId } })).templateId).toBe(tpl);
      expect(
        await db.sessionExercise.findMany({ where: { session: { programId: r.programId } }, select: { exerciseId: true, order: true } })
      ).toEqual([{ exerciseId: exFull, order: 1 }]);

      // RPC sin `exercises`: los de la plantilla, sin el archivado y con su dosis.
      const pat2 = await myPatient();
      const r2 = await createPlan(await ready({ ...draft, idempotencyKey: randomUUID(), patientId: pat2, startDayKey: nextStartDayKey(), exercises: undefined }));
      expect(r2).toMatchObject({ ok: true });
      if (!r2.ok) return;
      expect(
        await db.sessionExercise.findMany({ where: { session: { programId: r2.programId } }, select: { exerciseId: true, order: true, sets: true, reps: true } })
      ).toEqual([{ exerciseId: exFull, order: 1, sets: 4, reps: 10 }]);

      // El archivado mandado por el cliente → rechazo por ejercicios, sin plan.
      const pat3 = await myPatient();
      const r3 = await createPlan({ ...draft, idempotencyKey: randomUUID(), patientId: pat3, exercises: [{ exerciseId: exLater, sets: 3, reps: 12 }] });
      expect(r3).toMatchObject({ ok: false, error: "Hay ejercicios que no se pueden asignar." });
      expect(await programsOf(pat3)).toBe(0);
    });

    it("ASSISTANT (sin clinical.read ni plans.manage) no aplica aunque el tenant tenga sharedPatientView", async () => {
      asUser(kineAssigned.userId);
      const pat = await myPatient();
      const draft = await ready((await draftFromTemplate(tplFull, pat)).draft);
      await db.tenant.update({ where: { id: T.tenantId }, data: { sharedPatientView: true } });
      try {
        asUser(assistant.userId);
        expect((await getTemplatePrefill(tplFull)).ok).toBe(false);
        const r = await createPlan(draft);
        expect(r.ok).toBe(false);
        expect(await programsOf(pat)).toBe(0);
      } finally {
        await db.tenant.update({ where: { id: T.tenantId }, data: { sharedPatientView: false } });
      }
    });

    it("ejercicio archivado o de otro consultorio no entra al plan; el orden se compacta", async () => {
      const tpl = await addTemplate(T, kineAssigned.practitionerId, [exArchived, exOtherTenant, exFull], 1, 1);
      asUser(kineAssigned.userId);
      const pat = await myPatient();
      const { draft, prefill } = await draftFromTemplate(tpl, pat);
      expect(prefill.droppedExercises).toBe(2);
      expect(draft.exercises).toEqual([{ exerciseId: exFull, sets: 4, reps: 10 }]);
      const r = await createPlan(await ready(draft));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const rows = await db.sessionExercise.findMany({
        where: { session: { programId: r.programId } },
        select: { exerciseId: true, order: true },
      });
      expect(rows).toEqual([{ exerciseId: exFull, order: 1 }]);
      // Y por RPC no se cuelan: un borrador con el archivado o el ajeno → rechazo.
      for (const bad of [exArchived, exOtherTenant]) {
        const p2 = await myPatient();
        const r2 = await createPlan({ ...draft, idempotencyKey: randomUUID(), patientId: p2, exercises: [{ exerciseId: bad, sets: 3, reps: 12 }] });
        expect(r2.ok, bad).toBe(false);
        // Rechazo por el ejercicio (refs), no por el token viejo del borrador.
        expect(r2).not.toMatchObject({ kind: "stale-preview" });
        expect(await programsOf(p2)).toBe(0);
      }
    });

    it("tope PLAN_MAX_SESSIONS: una plantilla con 75 sesiones prellena 60 y el alta crea 60", async () => {
      const tpl = await addTemplate(T, kineAssigned.practitionerId, [exFull], 75, 7);
      asUser(kineAssigned.userId);
      const pat = await myPatient();
      const { draft } = await draftFromTemplate(tpl, pat);
      expect(draft.totalSessions).toBe(PLAN_MAX_SESSIONS);
      const r = await createPlan(await ready(draft));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const prog = await db.treatmentProgram.findUniqueOrThrow({
        where: { id: r.programId },
        select: { totalSessions: true, _count: { select: { sessions: true } } },
      });
      expect(prog.totalSessions).toBe(PLAN_MAX_SESSIONS);
      expect(prog._count.sessions).toBe(PLAN_MAX_SESSIONS);
      // Y 61 por RPC → rechazo (zod).
      const p2 = await myPatient();
      expect((await createPlan({ ...draft, idempotencyKey: randomUUID(), patientId: p2, totalSessions: 61 })).ok).toBe(false);
    });

    it("día AR: inicio martes 2030-01-08 mar/vie 10:00 → 08, 11, 15 y 18/01 a las 13:00Z; responsable en las sesiones", async () => {
      asUser(kineAssigned.userId);
      const pat = await myPatient();
      const { draft } = await draftFromTemplate(tplFull, pat, { startDayKey: "2030-01-08" });
      const r = await createPlan(await ready(draft));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const sessions = await db.session.findMany({
        where: { programId: r.programId },
        orderBy: { index: "asc" },
        select: { index: true, scheduledFor: true, practitionerId: true },
      });
      expect(sessions.map((s) => toARDateKey(s.scheduledFor))).toEqual([
        "2030-01-08",
        "2030-01-11",
        "2030-01-15",
        "2030-01-18",
      ]);
      // 10:00 AR = 13:00Z, no la medianoche UTC (que en AR es el día anterior).
      expect(sessions[0].scheduledFor.toISOString()).toBe("2030-01-08T13:00:00.000Z");
      expect(sessions.every((s) => s.practitionerId === kineAssigned.practitionerId)).toBe(true);
      const prog = await db.treatmentProgram.findUniqueOrThrow({ where: { id: r.programId } });
      expect(toARDateKey(prog.startDate)).toBe("2030-01-08");
    });

    it("fecha inválida → error de validación, no 500", async () => {
      asUser(kineAssigned.userId);
      const pat = await myPatient();
      const { draft } = await draftFromTemplate(tplFull, pat);
      for (const startDayKey of ["2026-13-40", "06/10/2026", ""]) {
        const r = await createPlan({ ...draft, startDayKey });
        expect(r.ok, startDayKey).toBe(false);
      }
      expect(await programsOf(pat)).toBe(0);
    });

    it("plantilla archivada → rechazo (ni prefill ni alta)", async () => {
      const tpl = await addTemplate(T, kineAssigned.practitionerId, [exFull]);
      asUser(kineAssigned.userId);
      const pat = await myPatient();
      const { draft } = await draftFromTemplate(tpl, pat);
      await db.planTemplate.update({ where: { id: tpl }, data: { archivedAt: new Date() } });
      expect((await getTemplatePrefill(tpl)).ok).toBe(false);
      expect(await createPlan(draft)).toMatchObject({ ok: false, error: "Plantilla inválida." });
      expect(await programsOf(pat)).toBe(0);
    });

    it("cross-tenant: plantilla o paciente de otro consultorio → rechazo", async () => {
      const tplOther = await addTemplate(TOther, TOther.practitionerId, [exOtherTenant]);
      const patOther = await addPatient(db, TOther);
      asUser(T.userId); // OWNER de T
      expect((await getTemplatePrefill(tplOther)).ok).toBe(false);
      const pat = await addPatient(db, T);
      const { draft } = await draftFromTemplate(tplFull, pat, { practitionerId: T.practitionerId, exercises: undefined });
      const a = await createPlan({ ...draft, templateId: tplOther });
      expect(a).toMatchObject({ ok: false, error: "Plantilla inválida." });
      expect(await programsOf(pat)).toBe(0);
      const b = await createPlan({ ...draft, idempotencyKey: randomUUID(), patientId: patOther });
      expect(b.ok).toBe(false);
      expect(b).not.toMatchObject({ kind: "stale-preview" });
      expect(await programsOf(patOther)).toBe(0);
    });
  });

  describe("deletePlanTemplate", () => {
    it("[P0-S02t] deletePlanTemplate ajeno sin ser admin → rechazo", async () => {
      const tpl = await addTemplate(T, kineAssigned.practitionerId, [exFull]);
      asUser(kineBasic.userId);
      const r = await deletePlanTemplate(tpl);
      expect(r.ok).toBe(false);
      expect(await db.planTemplate.count({ where: { id: tpl } })).toBe(1);
    });

    it("control positivo: el autor borra la suya", async () => {
      const tpl = await addTemplate(T, kineBasic.practitionerId, [exFull]);
      asUser(kineBasic.userId);
      expect((await deletePlanTemplate(tpl)).ok).toBe(true);
      expect(await db.planTemplate.count({ where: { id: tpl } })).toBe(0);
    });

    it("control positivo: OWNER borra la de otro", async () => {
      const tpl = await addTemplate(T, kineAssigned.practitionerId, [exFull]);
      asUser(T.userId);
      expect((await deletePlanTemplate(tpl)).ok).toBe(true);
      expect(await db.planTemplate.count({ where: { id: tpl } })).toBe(0);
    });

    it("cross-tenant: OWNER de otro consultorio no la borra", async () => {
      const tpl = await addTemplate(T, kineAssigned.practitionerId, [exFull]);
      asUser(TOther.userId);
      expect((await deletePlanTemplate(tpl)).ok).toBe(false);
      expect(await db.planTemplate.count({ where: { id: tpl } })).toBe(1);
    });
  });
});
