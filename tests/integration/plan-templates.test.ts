/**
 * Planes P3.1 · S17t — plantillas en el server (`lib/plan-templates.ts`).
 *
 * Qué se cierra (PLANES.md §11, AUDIT `plantillas-sin-crud`): antes solo había
 * alta (nombre, sesiones, frecuencia, ejercicios), borrado y el "aplicar" que
 * salteaba el motor. Ahora: CRUD con los campos de M1 (disciplina, servicio,
 * duración, horario C6, precio, notas, ejercicios, archivar), autor o admin
 * para editar/archivar/borrar, módulo `plantillas` en la tx (enmienda EV0:
 * `gatingForActor(tx).canBuildTemplates`), y `getTemplatePrefill` = borrador
 * del editor que el MOTOR acepta (se prueba de punta a punta con `previewPlan`).
 *
 * Corre con los dos roles de DB: bajo owner (BYPASSRLS, = prod) el
 * `where: { tenantId }` a mano y `validatePlanRefsInTx` son la única barrera,
 * así que los casos cross-tenant tienen que rechazar también ahí.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  createPlanTemplate,
  deletePlanTemplate,
  getPlanTemplate,
  getTemplatePrefill,
  listPlanTemplates,
  setPlanTemplateArchived,
  updatePlanTemplate,
} from "@/lib/plan-templates";
import { previewPlan } from "@/lib/plans";
import type { PlanTemplateCreateInput } from "@/lib/plan-templates-types";
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

describe.skipIf(!RUN)("[P3-S17t] plantillas en el server", () => {
  let db: PrismaClient;
  let T: EphemeralTenant; // KINESIOLOGY STARTER: con `plantillas`
  let TFree: EphemeralTenant; // FREE: sin
  let TGen: EphemeralTenant; // GENERAL PRO: sin
  let TOther: EphemeralTenant; // otro consultorio con plantillas
  let kine: { userId: string; practitionerId: string };
  let kine2: { userId: string; practitionerId: string };
  let assistant: { userId: string; practitionerId: string };
  let exA: string; // dosis 4×10
  let exNull: string; // sin dosis
  let exArchived: string;
  let exOther: string;
  let svcOsteo: string; // OSTEOPATHY, sin dueño (habilitado para todos)
  let svcKine: string; // KINESIOLOGY, sin dueño
  let svcOther: string; // de TOther

  const schedule = { v: 1 as const, frequency: "weekly" as const, slots: [{ dow: 1, startMin: 9 * 60 }, { dow: 4, startMin: 9 * 60 }] };

  async function addExercise(tenantId: string, d: { sets?: number | null; reps?: number | null; archived?: boolean } = {}) {
    const s = uniqueSuffix();
    const ex = await db.exercise.create({
      data: {
        tenantId,
        slug: `s17t-${s}`,
        name: `Ejercicio ${s}`,
        defaultSets: d.sets ?? null,
        defaultReps: d.reps ?? null,
        archivedAt: d.archived ? new Date() : null,
      },
    });
    return ex.id;
  }

  async function addSvc(t: EphemeralTenant, discipline: "KINESIOLOGY" | "OSTEOPATHY") {
    const s = await db.service.create({
      data: { tenantId: t.tenantId, practitionerId: null, name: `Svc ${uniqueSuffix()}`, durationMin: 45, discipline },
    });
    return s.id;
  }

  function full(over: Partial<PlanTemplateCreateInput> = {}): PlanTemplateCreateInput {
    return {
      name: `Lumbalgia ${uniqueSuffix()}`,
      description: "Dolor lumbar mecánico",
      discipline: "KINESIOLOGY",
      serviceId: svcKine,
      durationMin: 50,
      totalSessions: 10,
      schedule,
      pricing: { mode: "PACKAGE", totalPriceCents: 12_000_00 },
      notes: "Progresar carga en la semana 3",
      exerciseIds: [exA, exNull],
      ...over,
    };
  }

  async function create(over: Partial<PlanTemplateCreateInput> = {}) {
    const r = await createPlanTemplate(full(over));
    if (!r.ok) throw new Error(`create: ${r.error}`);
    return r.data.id;
  }

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "STARTER" });
    TFree = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "FREE" });
    TGen = await createEphemeralTenant(db, { vertical: "GENERAL", plan: "PRO" });
    TOther = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "STARTER" });
    kine = await addPractitioner(db, T, "PRACTITIONER");
    kine2 = await addPractitioner(db, T, "PRACTITIONER");
    assistant = await addPractitioner(db, T, "ASSISTANT");
    exA = await addExercise(T.tenantId, { sets: 4, reps: 10 });
    exNull = await addExercise(T.tenantId);
    exArchived = await addExercise(T.tenantId, { sets: 2, reps: 8, archived: true });
    exOther = await addExercise(TOther.tenantId, { sets: 5, reps: 5 });
    svcOsteo = await addSvc(T, "OSTEOPATHY");
    svcKine = await addSvc(T, "KINESIOLOGY");
    svcOther = await addSvc(TOther, "KINESIOLOGY");
  });

  afterAll(async () => {
    await T?.cleanup();
    await TFree?.cleanup();
    await TGen?.cleanup();
    await TOther?.cleanup();
    await db?.$disconnect();
  });

  describe("alta", () => {
    it("guarda todos los campos de M1 y deja audit en la tx", async () => {
      asUser(kine.userId);
      const id = await create();
      const row = await db.planTemplate.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({
        tenantId: T.tenantId,
        authorId: kine.practitionerId,
        discipline: "KINESIOLOGY",
        serviceId: svcKine,
        durationMin: 50,
        totalSessions: 10,
        frequency: 2, // derivada del horario (2 slots semanales)
        pricingMode: "PACKAGE",
        totalPriceCents: 12_000_00,
        pricePerSessionCents: null,
        notes: "Progresar carga en la semana 3",
        archivedAt: null,
      });
      expect(row.schedule).toEqual(schedule);
      expect(row.exerciseIds).toEqual([exA, exNull]);
      expect(await db.auditEvent.count({ where: { action: "planTemplate.create", entityId: id } })).toBe(1);
    });

    it("sin disciplina toma la del servicio; sin servicio ni horario también se guarda", async () => {
      asUser(kine.userId);
      const a = await create({ discipline: undefined, serviceId: svcOsteo, exerciseIds: [] });
      expect(await db.planTemplate.findUniqueOrThrow({ where: { id: a } })).toMatchObject({ discipline: "OSTEOPATHY" });
      const b = await create({ serviceId: undefined, schedule: undefined, pricing: undefined, frequency: 3 });
      const rb = await db.planTemplate.findUniqueOrThrow({ where: { id: b } });
      expect(rb).toMatchObject({ serviceId: null, schedule: null, pricingMode: null, frequency: 3 });
    });

    it("FREE y GENERAL (sin `plantillas`) → rechazo, sin fila", async () => {
      for (const t of [TFree, TGen]) {
        asUser(t.userId); // OWNER: solo lo frena el módulo
        const before = await db.planTemplate.count({ where: { tenantId: t.tenantId } });
        const r = await createPlanTemplate(full({ serviceId: undefined, exerciseIds: [] }));
        expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/Mejorá tu plan/) });
        expect(await db.planTemplate.count({ where: { tenantId: t.tenantId } })).toBe(before);
      }
    });

    it("la Secretaria (sin plans.manage) no arma plantillas", async () => {
      asUser(assistant.userId);
      const r = await createPlanTemplate(full());
      expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/rol/) });
    });

    it("disciplina distinta a la del servicio → rechazo en serviceId", async () => {
      asUser(kine.userId);
      const r = await createPlanTemplate(full({ discipline: "KINESIOLOGY", serviceId: svcOsteo }));
      expect(r.ok).toBe(false);
      expect(!r.ok && r.fieldErrors?.serviceId).toBeTruthy();
    });

    it("ejercicio archivado o de otro consultorio → rechazo (con y sin servicio)", async () => {
      asUser(kine.userId);
      for (const exerciseIds of [[exA, exArchived], [exOther]]) {
        expect((await createPlanTemplate(full({ exerciseIds }))).ok).toBe(false);
        expect((await createPlanTemplate(full({ serviceId: undefined, exerciseIds }))).ok).toBe(false);
      }
    });

    it("zod: precio negativo, duración fuera de 15..240, horario inválido, repetidos → mensaje, no 23514", async () => {
      asUser(kine.userId);
      const bad: Array<Partial<PlanTemplateCreateInput>> = [
        { pricing: { mode: "PER_SESSION", pricePerSessionCents: -1 } },
        { durationMin: 10 },
        { durationMin: 300 },
        { schedule: { v: 1, frequency: "weekly", slots: [] } },
        { exerciseIds: [exA, exA] },
        { totalSessions: 61 },
        { name: "   " },
      ];
      for (const over of bad) {
        const r = await createPlanTemplate(full(over));
        expect(r.ok, JSON.stringify(over)).toBe(false);
      }
    });
  });

  describe("cross-tenant (owner BYPASSRLS = prod)", () => {
    it("servicio de otro consultorio → rechazo en serviceId", async () => {
      asUser(T.userId);
      const r = await createPlanTemplate(full({ serviceId: svcOther }));
      expect(r.ok).toBe(false);
      expect(!r.ok && r.fieldErrors?.serviceId).toBeTruthy();
    });

    it("OWNER de otro consultorio no lee, no edita, no archiva, no borra, no prellena", async () => {
      asUser(kine.userId);
      const id = await create();
      asUser(TOther.userId);
      expect((await getPlanTemplate(id)).ok).toBe(false);
      expect((await getTemplatePrefill(id)).ok).toBe(false);
      expect((await updatePlanTemplate({ id, name: "pisada" })).ok).toBe(false);
      expect((await setPlanTemplateArchived(id, true)).ok).toBe(false);
      expect((await deletePlanTemplate(id)).ok).toBe(false);
      expect((await listPlanTemplates()).some((t) => t.id === id)).toBe(false);
      expect(await db.planTemplate.findUniqueOrThrow({ where: { id } })).toMatchObject({ archivedAt: null });
      expect((await db.planTemplate.findUniqueOrThrow({ where: { id } })).name).not.toBe("pisada");
    });
  });

  describe("edición", () => {
    it("parcial: ausente se mantiene; null limpia horario (SQL NULL, no JSON null) y precio", async () => {
      asUser(kine.userId);
      const id = await create();
      const r = await updatePlanTemplate({ id, name: "Renombrada", schedule: null, pricing: null, notes: "" });
      expect(r.ok).toBe(true);
      const row = await db.planTemplate.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({
        name: "Renombrada",
        pricingMode: null,
        totalPriceCents: null,
        pricePerSessionCents: null,
        notes: null,
        serviceId: svcKine, // ausente → se mantiene
        durationMin: 50,
      });
      const [{ isNull }] = await db.$queryRaw<Array<{ isNull: boolean }>>`
        SELECT "schedule" IS NULL AS "isNull" FROM "PlanTemplate" WHERE id = ${id}`;
      expect(isNull).toBe(true);
      expect(await db.auditEvent.count({ where: { action: "planTemplate.update", entityId: id } })).toBe(1);
    });

    it("precio PER_SESSION reemplaza al paquete sin violar el CHECK", async () => {
      asUser(kine.userId);
      const id = await create();
      expect((await updatePlanTemplate({ id, pricing: { mode: "PER_SESSION", pricePerSessionCents: 900_00 } })).ok).toBe(true);
      expect(await db.planTemplate.findUniqueOrThrow({ where: { id } })).toMatchObject({
        pricingMode: "PER_SESSION",
        pricePerSessionCents: 900_00,
        totalPriceCents: null,
      });
    });

    it("renombrar no falla aunque un ejercicio guardado se haya archivado después", async () => {
      asUser(kine.userId);
      const ex = await addExercise(T.tenantId, { sets: 3, reps: 3 });
      const id = await create({ exerciseIds: [ex] });
      await db.exercise.update({ where: { id: ex }, data: { archivedAt: new Date() } });
      expect((await updatePlanTemplate({ id, name: "Otra" })).ok).toBe(true);
      // ...pero mandar la lista con el archivado sí se rechaza.
      expect((await updatePlanTemplate({ id, exerciseIds: [ex] })).ok).toBe(false);
    });

    it("cambiar a un servicio de otra disciplina sin cambiar la disciplina → rechazo", async () => {
      asUser(kine.userId);
      const id = await create();
      expect((await updatePlanTemplate({ id, serviceId: svcOsteo })).ok).toBe(false);
      expect((await updatePlanTemplate({ id, serviceId: svcOsteo, discipline: "OSTEOPATHY" })).ok).toBe(true);
    });

    it("otro profesional no edita ni archiva; el OWNER sí", async () => {
      asUser(kine.userId);
      const id = await create();
      asUser(kine2.userId);
      expect(await updatePlanTemplate({ id, name: "ajena" })).toMatchObject({ ok: false, error: expect.stringMatching(/Solo quien creó/) });
      expect((await setPlanTemplateArchived(id, true)).ok).toBe(false);
      asUser(T.userId);
      expect((await updatePlanTemplate({ id, name: "por admin" })).ok).toBe(true);
    });

    it("[P3-Z] un admin que edita el servicio de la plantilla de un colega valida contra el AUTOR, no contra sí mismo", async () => {
      // Antes: `validateTemplateRefsInTx` usaba al actor como responsable → el
      // OWNER no podía poner un servicio que el autor sí tiene habilitado (y
      // podía poner uno que el autor no puede usar, que después el alta rechaza).
      const svcAuthorOnly = await addSvc(T, "KINESIOLOGY");
      await db.practitionerService.create({
        data: { tenantId: T.tenantId, practitionerId: T.practitionerId, serviceId: svcAuthorOnly, enabled: false },
      });
      const svcAdminOnly = await addSvc(T, "KINESIOLOGY");
      await db.practitionerService.create({
        data: { tenantId: T.tenantId, practitionerId: kine.practitionerId, serviceId: svcAdminOnly, enabled: false },
      });
      asUser(kine.userId);
      const id = await create();
      asUser(T.userId); // OWNER: no tiene habilitado svcAuthorOnly; el autor sí
      expect(await updatePlanTemplate({ id, serviceId: svcAuthorOnly })).toMatchObject({ ok: true });
      expect((await db.planTemplate.findUniqueOrThrow({ where: { id } })).serviceId).toBe(svcAuthorOnly);
      // Y al revés: un servicio que el autor tiene deshabilitado → rechazo, sin pisar.
      expect(await updatePlanTemplate({ id, serviceId: svcAdminOnly })).toMatchObject({
        ok: false,
        error: expect.stringMatching(/no está habilitado para el profesional responsable/),
      });
      expect((await db.planTemplate.findUniqueOrThrow({ where: { id } })).serviceId).toBe(svcAuthorOnly);
    });

    it("CAS: expectedUpdatedAt viejo → stale, sin pisar", async () => {
      asUser(kine.userId);
      const id = await create();
      const before = await db.planTemplate.findUniqueOrThrow({ where: { id } });
      expect((await updatePlanTemplate({ id, name: "primera", expectedUpdatedAt: before.updatedAt.toISOString() })).ok).toBe(true);
      const r = await updatePlanTemplate({ id, name: "segunda", expectedUpdatedAt: before.updatedAt.toISOString() });
      expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/Otra persona/) });
      expect((await db.planTemplate.findUniqueOrThrow({ where: { id } })).name).toBe("primera");
    });
  });

  describe("archivar, listar y borrar", () => {
    it("archivada: fuera del listado por defecto, visible con includeArchived, sin prefill; restaurar la devuelve", async () => {
      asUser(kine.userId);
      const id = await create();
      expect((await setPlanTemplateArchived(id, true)).ok).toBe(true);
      expect((await setPlanTemplateArchived(id, true)).ok).toBe(true); // idempotente
      expect((await listPlanTemplates()).some((t) => t.id === id)).toBe(false);
      const all = await listPlanTemplates({ includeArchived: true });
      expect(all.find((t) => t.id === id)?.archivedAt).toBeInstanceOf(Date);
      expect(await getTemplatePrefill(id)).toMatchObject({ ok: false, error: expect.stringMatching(/archivada/) });
      expect(await db.auditEvent.count({ where: { action: "planTemplate.archive", entityId: id } })).toBe(1);
      expect((await setPlanTemplateArchived(id, false)).ok).toBe(true);
      expect((await listPlanTemplates()).some((t) => t.id === id)).toBe(true);
    });

    it("listado: campos de M1, filtro por disciplina y canEdit por autor/admin", async () => {
      asUser(kine.userId);
      const id = await create();
      const mine = (await listPlanTemplates({ discipline: "KINESIOLOGY" })).find((t) => t.id === id)!;
      expect(mine).toMatchObject({
        discipline: "KINESIOLOGY",
        serviceId: svcKine,
        durationMin: 50,
        schedule,
        pricing: { mode: "PACKAGE", totalPriceCents: 12_000_00 },
        hasNotes: true,
        exerciseCount: 2,
        canEdit: true,
      });
      expect((await listPlanTemplates({ discipline: "OSTEOPATHY" })).some((t) => t.id === id)).toBe(false);
      asUser(kine2.userId);
      expect((await listPlanTemplates()).find((t) => t.id === id)?.canEdit).toBe(false);
      asUser(T.userId);
      expect((await listPlanTemplates()).find((t) => t.id === id)?.canEdit).toBe(true);
    });

    it("P2-Z · B-L2 preservado: sin `plantillas` el listado es [] aunque haya filas", async () => {
      await db.planTemplate.create({
        data: { tenantId: TFree.tenantId, authorId: TFree.practitionerId, name: "vieja", exerciseIds: [] },
      });
      asUser(TFree.userId);
      expect(await listPlanTemplates()).toEqual([]);
    });

    it("borrar sin `plantillas` → rechazo (como el resto de las escrituras)", async () => {
      const row = await db.planTemplate.create({
        data: { tenantId: TGen.tenantId, authorId: TGen.practitionerId, name: "general", exerciseIds: [] },
      });
      asUser(TGen.userId);
      expect((await deletePlanTemplate(row.id)).ok).toBe(false);
      expect(await db.planTemplate.count({ where: { id: row.id } })).toBe(1);
    });
  });

  describe("getTemplatePrefill (aplicar = prefill del editor, no crea plan)", () => {
    it("devuelve el borrador C10 + título, notas y ejercicios con dosis ?? 3×12; no escribe nada", async () => {
      asUser(kine.userId);
      const id = await create();
      const programsBefore = await db.treatmentProgram.count({ where: { tenantId: T.tenantId } });
      const r = await getTemplatePrefill(id);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data.prefill).toEqual({
        discipline: "KINESIOLOGY",
        serviceId: svcKine,
        durationMin: 50,
        totalSessions: 10,
        schedule,
        pricing: { mode: "PACKAGE", totalPriceCents: 12_000_00 },
        templateId: id,
      });
      expect(r.data.notes).toBe("Progresar carga en la semana 3");
      expect(r.data.exercises.map((e) => [e.exerciseId, e.sets, e.reps])).toEqual([
        [exA, 4, 10],
        [exNull, 3, 12],
      ]);
      expect(r.data).toMatchObject({ droppedExercises: 0, serviceDropped: false });
      expect(await db.treatmentProgram.count({ where: { tenantId: T.tenantId } })).toBe(programsBefore);
    });

    it("el prefill lo acepta el motor: previewPlan con el borrador da una fila por sesión", async () => {
      asUser(kine.userId);
      const id = await create({ totalSessions: 4 });
      const r = await getTemplatePrefill(id);
      if (!r.ok) throw new Error(r.error);
      const p = r.data.prefill;
      const pat = await addPatient(db, T, { assignedPractitionerId: kine.practitionerId });
      const preview = await previewPlan({
        patientId: pat,
        discipline: p.discipline!,
        practitionerId: kine.practitionerId,
        serviceId: p.serviceId!,
        locationId: null,
        durationMin: p.durationMin,
        schedule: p.schedule!,
        startDayKey: "2030-03-04",
        totalSessions: p.totalSessions!,
        pricing: p.pricing ?? null,
        templateId: p.templateId,
        exercises: r.data.exercises.map(({ exerciseId, sets, reps }) => ({ exerciseId, sets, reps })),
        title: r.data.title,
        rows: [],
      });
      expect(preview.ok, !preview.ok ? preview.error : "").toBe(true);
      expect(preview.ok && preview.preview.rows).toHaveLength(4);
    });

    it("ejercicio archivado después: se descarta y el prefill conserva templateId (P3.Z: el motor filtra los de la plantilla)", async () => {
      // Antes el prefill omitía `templateId` si descartaba un ejercicio, porque
      // el motor re-validaba todos los ids guardados y rechazaba el alta: el
      // plan perdía el vínculo con su plantilla. Ahora el motor saltea los ids
      // de la plantilla que ya no son asignables (alta cubierta en
      // plan-templates-authz.test.ts, "[P3-Z] ejercicio de la plantilla archivado DESPUÉS").
      asUser(kine.userId);
      const ex = await addExercise(T.tenantId, { sets: 1, reps: 1 });
      const id = await create({ exerciseIds: [exA, ex] });
      await db.exercise.update({ where: { id: ex }, data: { archivedAt: new Date() } });
      const r = await getTemplatePrefill(id);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data.exercises.map((e) => e.exerciseId)).toEqual([exA]);
      expect(r.data.droppedExercises).toBe(1);
      expect(r.data.prefill.templateId).toBe(id);
    });

    it("servicio que cambió de disciplina → se omite (serviceDropped)", async () => {
      asUser(kine.userId);
      const svc = await addSvc(T, "KINESIOLOGY");
      const id = await create({ serviceId: svc });
      await db.service.update({ where: { id: svc }, data: { discipline: "OSTEOPATHY" } });
      const r = await getTemplatePrefill(id);
      expect(r.ok && r.data.serviceDropped).toBe(true);
      expect(r.ok && r.data.prefill.serviceId).toBeUndefined();
    });

    it("Secretaria y FREE no prellenan", async () => {
      asUser(kine.userId);
      const id = await create();
      asUser(assistant.userId);
      expect((await getTemplatePrefill(id)).ok).toBe(false);
      const freeTpl = await db.planTemplate.create({
        data: { tenantId: TFree.tenantId, authorId: TFree.practitionerId, name: "f", exerciseIds: [] },
      });
      asUser(TFree.userId);
      expect(await getTemplatePrefill(freeTpl.id)).toMatchObject({ ok: false, error: expect.stringMatching(/Mejorá tu plan/) });
    });
  });

  describe("getPlanTemplate (detalle del drawer)", () => {
    it("trae notas y ejercicios con nombre; marca los que ya no se pueden asignar", async () => {
      asUser(kine.userId);
      const ex = await addExercise(T.tenantId);
      const id = await create({ exerciseIds: [exA, ex] });
      await db.exercise.update({ where: { id: ex }, data: { archivedAt: new Date() } });
      const r = await getPlanTemplate(id);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data.notes).toBe("Progresar carga en la semana 3");
      expect(r.data.exercises.map((e) => [e.id, e.assignable])).toEqual([
        [exA, true],
        [ex, false],
      ]);
    });
  });
});
