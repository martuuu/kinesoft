/**
 * Planes P0.1 · S02t — gates de plantillas (`lib/plan-templates.ts`).
 *
 * Qué se cierra (PLANES.md §8, S02t):
 *  - `applyPlanTemplate` creaba un plan con solo chequear el tenant del
 *    paciente: un profesional en acceso básico (no asignado, sin share) le
 *    armaba un plan a un paciente ajeno. Ahora exige acceso full (+ rol que
 *    lee clínica y crea planes: PD-09), dentro de la misma tx que escribe.
 *  - Ejercicios `assignable` (visibilidad del plan SaaS **y** no archivados).
 *  - Dosis `?? 3/12`: un ejercicio con `defaultSets/defaultReps` null hacía
 *    explotar el create (`SessionExercise.sets/reps` son NOT NULL).
 *  - Tope `PLAN_MAX_SESSIONS` (60) y día AR (sesión 1 = el día elegido en AR).
 *  - `deletePlanTemplate` lo borraba cualquier miembro del tenant: ahora solo
 *    el autor o un OWNER/ADMIN.
 *
 * Corre con los dos roles de DB (kinesoft_app y owner BYPASSRLS): bajo owner
 * el `where: { tenantId }` a mano es la única barrera, así que los casos
 * cross-tenant tienen que dar "no encontrada" también ahí.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient, TenantPlan } from "@prisma/client";
import { applyPlanTemplate, deletePlanTemplate } from "@/lib/plan-templates";
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

describe.skipIf(!RUN)("[P0-S02t] gates de plantillas", () => {
  let db: PrismaClient;
  let T: EphemeralTenant; // STARTER: puede usar plantillas
  let TFree: EphemeralTenant; // FREE: no
  let TOther: EphemeralTenant; // otro consultorio
  let kineAssigned: { userId: string; practitionerId: string };
  let kineBasic: { userId: string; practitionerId: string };
  let assistant: { userId: string; practitionerId: string };
  let pat: string;
  let patFree: string;
  let exFull: string; // con dosis 4×10
  let exNullDose: string; // dosis null
  let exArchived: string;
  let exOtherTenant: string;
  let tplFull: string;

  async function setPlan(t: EphemeralTenant, plan: TenantPlan) {
    await db.tenant.update({ where: { id: t.tenantId }, data: { plan } });
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
    pat = await addPatient(db, T, { assignedPractitionerId: kineAssigned.practitionerId });
    patFree = await addPatient(db, TFree);

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

  describe("applyPlanTemplate", () => {
    it("[P0-S02t] básico no aplica plantilla", async () => {
      asUser(kineBasic.userId);
      const before = await programsOf(pat);
      const r = await applyPlanTemplate({ templateId: tplFull, patientId: pat, startDate: "2026-10-06" });
      expect(r.ok).toBe(false);
      expect(await programsOf(pat)).toBe(before);
    });

    // Ya pasaba antes de S02t (`canBuildTemplates` = TEMPLATES_PLANS): se deja
    // como `it` de regresión, no como it.fails (C14: it.fails solo para bugs vivos).
    it("[P0-S02t] FREE no aplica", async () => {
      const tpl = await addTemplate(TFree, TFree.practitionerId, []);
      asUser(TFree.userId); // OWNER: acceso full, solo lo frena el plan SaaS
      const r = await applyPlanTemplate({ templateId: tpl, patientId: patFree, startDate: "2026-10-06" });
      expect(r.ok).toBe(false);
      expect(await programsOf(patFree)).toBe(0);
    });

    it("[P0-S02t] plantilla con dosis null crea 3×12 (hoy crashea)", async () => {
      const tpl = await addTemplate(T, kineAssigned.practitionerId, [exNullDose, exFull], 2, 1);
      asUser(kineAssigned.userId);
      const r = await applyPlanTemplate({ templateId: tpl, patientId: pat, startDate: "2026-10-06" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const rows = await db.sessionExercise.findMany({
        where: { session: { programId: r.data.programId } },
        select: { exerciseId: true, order: true, sets: true, reps: true },
        orderBy: [{ session: { index: "asc" } }, { order: "asc" }],
      });
      expect(rows).toEqual([
        { exerciseId: exNullDose, order: 1, sets: 3, reps: 12 },
        { exerciseId: exFull, order: 2, sets: 4, reps: 10 },
        { exerciseId: exNullDose, order: 1, sets: 3, reps: 12 },
        { exerciseId: exFull, order: 2, sets: 4, reps: 10 },
      ]);
    });

    it("ASSISTANT (sin clinical.read ni plans.manage) no aplica aunque el tenant tenga sharedPatientView", async () => {
      await db.tenant.update({ where: { id: T.tenantId }, data: { sharedPatientView: true } });
      try {
        asUser(assistant.userId);
        const before = await programsOf(pat);
        const r = await applyPlanTemplate({ templateId: tplFull, patientId: pat, startDate: "2026-10-06" });
        expect(r.ok).toBe(false);
        expect(await programsOf(pat)).toBe(before);
      } finally {
        await db.tenant.update({ where: { id: T.tenantId }, data: { sharedPatientView: false } });
      }
    });

    it("ejercicio archivado o de otro consultorio no entra al plan; el orden se compacta", async () => {
      const tpl = await addTemplate(T, kineAssigned.practitionerId, [exArchived, exOtherTenant, exFull], 1, 1);
      asUser(kineAssigned.userId);
      const r = await applyPlanTemplate({ templateId: tpl, patientId: pat, startDate: "2026-10-06" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const rows = await db.sessionExercise.findMany({
        where: { session: { programId: r.data.programId } },
        select: { exerciseId: true, order: true },
      });
      expect(rows).toEqual([{ exerciseId: exFull, order: 1 }]);
    });

    it("tope PLAN_MAX_SESSIONS: una plantilla con 75 sesiones crea 60", async () => {
      const tpl = await addTemplate(T, kineAssigned.practitionerId, [exFull], 75, 7);
      asUser(kineAssigned.userId);
      const r = await applyPlanTemplate({ templateId: tpl, patientId: pat, startDate: "2026-10-06" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const prog = await db.treatmentProgram.findUniqueOrThrow({
        where: { id: r.data.programId },
        select: { totalSessions: true, _count: { select: { sessions: true } } },
      });
      expect(prog.totalSessions).toBe(PLAN_MAX_SESSIONS);
      expect(prog._count.sessions).toBe(PLAN_MAX_SESSIONS);
    });

    it("día AR: startDate 2026-10-06 → sesión 1 el 06/10 AR; frecuencia 2 → cada 3/4 días AR", async () => {
      asUser(kineAssigned.userId);
      const r = await applyPlanTemplate({ templateId: tplFull, patientId: pat, startDate: "2026-10-06" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const sessions = await db.session.findMany({
        where: { programId: r.data.programId },
        orderBy: { index: "asc" },
        select: { index: true, scheduledFor: true, practitionerId: true },
      });
      expect(sessions.map((s) => toARDateKey(s.scheduledFor!))).toEqual([
        "2026-10-06",
        "2026-10-09",
        "2026-10-13",
        "2026-10-16",
      ]);
      // 00:00 AR = 03:00Z, no la medianoche UTC (que en AR es el día anterior).
      expect(sessions[0].scheduledFor!.toISOString()).toBe("2026-10-06T03:00:00.000Z");
      expect(sessions.every((s) => s.practitionerId === kineAssigned.practitionerId)).toBe(true);
      const prog = await db.treatmentProgram.findUniqueOrThrow({ where: { id: r.data.programId } });
      expect(toARDateKey(prog.startDate)).toBe("2026-10-06");
    });

    it("fecha inválida → error de validación, no 500", async () => {
      asUser(kineAssigned.userId);
      const before = await programsOf(pat);
      for (const startDate of ["2026-13-40", "06/10/2026", ""]) {
        const r = await applyPlanTemplate({ templateId: tplFull, patientId: pat, startDate });
        expect(r.ok).toBe(false);
      }
      expect(await programsOf(pat)).toBe(before);
    });

    it("cross-tenant: plantilla o paciente de otro consultorio → no encontrada", async () => {
      const tplOther = await addTemplate(TOther, TOther.practitionerId, [exOtherTenant]);
      const patOther = await addPatient(db, TOther);
      asUser(T.userId); // OWNER de T
      const a = await applyPlanTemplate({ templateId: tplOther, patientId: pat, startDate: "2026-10-06" });
      expect(a.ok).toBe(false);
      const b = await applyPlanTemplate({ templateId: tplFull, patientId: patOther, startDate: "2026-10-06" });
      expect(b.ok).toBe(false);
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
