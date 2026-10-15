/**
 * EV1-E1 · `readonly-residual-actions` (AUDIT, clase A) + ILIKE clínico sin escapar.
 *
 * 1) Solo lectura: las actions clínicas que BO3-F no había envuelto (diagnóstico, condiciones propias, ejercicios
 *    propios, plantillas, adopción de turnos, planes legacy, favoritos y la propuesta de planes del catálogo) con el
 *    consultorio en `enforce` + modo lectura DEVUELVEN `{ ok:false, error: READ_ONLY_MESSAGE }` (no tiran: en prod Next
 *    redacta el mensaje de toda excepción; y las que tenían catch lo tapaban con su copy genérico) y no escriben nada.
 *    Mismo patrón que `[BO3-F]` de tenant-access.test.ts. Los datos se arman con el consultorio ACTIVO y con las
 *    actions reales (createPlan, createPlanTemplate, previewPlan) y recién después se lo pasa a solo lectura.
 *    `ensureTag` queda afuera a propósito: devuelve `{slug,label}` (no `ActionResult`) y su contrato es tirar (C-EV4).
 *    `deleteSession` no escribe (devuelve siempre el copy legacy), no necesita wrapper.
 *
 * 2) ILIKE: Prisma 5 compila `contains`/`equals` + `mode: "insensitive"` a `ILIKE` con el valor TAL CUAL (verificado
 *    contra Postgres el 14-oct: `contains: "a%_b"` → `ILIKE '%a%_b%'`), así que `_` y `%` del usuario eran comodines.
 *    Cada búsqueda se prueba con un señuelo que SOLO matchea si el comodín no está escapado.
 *
 * Símbolos reales contra Postgres, en los dos roles (`npm run test:integration` y `:owner`).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { getActor } from "@/lib/session";
import { READ_ONLY_MESSAGE } from "@/lib/tenant-access";
import { createPlan, previewPlan } from "@/lib/plans";
import type { PlanCreateInput, PlanPreview, PlanRowResolution } from "@/lib/plans-types";
import { createPlanFromDiagnosis, searchPatientsForAssignment } from "@/lib/diagnosis";
import { createCustomCondition, deleteCustomCondition, updateCustomCondition } from "@/lib/conditions";
import { createExercise, ensureTag, listExercises } from "@/lib/exercises";
import { createPlanTemplate, deletePlanTemplate, setPlanTemplateArchived, updatePlanTemplate } from "@/lib/plan-templates";
import {
  adoptBookingSeries,
  generatePlanBookings,
  linkBookingToSession,
  previewGeneratePlanBookings,
  removeBookingFromPlan,
} from "@/lib/plans-adopt";
import { deleteProgram, setProgramStatus } from "@/lib/programs";
import { toggleFavourite } from "@/lib/favourites";
import { proposePayerPlan, searchPayers, searchPractices } from "@/lib/catalog";
import { matchKey } from "@/lib/catalog/normalize";
import { asUser } from "@/tests/helpers/actor";
import { addPlanBooking } from "@/tests/helpers/plan-factory";
import { ownerClient, createEphemeralTenant, addPatient, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

/** Lunes 10:00 AR. */
const LUN_10 = { v: 1 as const, frequency: "weekly" as const, slots: [{ dow: 1 as const, startMin: 600 }] };
const EMPTY_SELECTION = { regions: [], symptoms: [], triggers: [], phase: null, intensity: 5 };

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
const allNone = (p: PlanPreview): PlanRowResolution[] => p.rows.map((r) => ({ index: r.index, kind: "none" }));

describe.skipIf(!RUN)("[EV1-E1] solo lectura en actions clínicas + ILIKE escapado", () => {
  let db: PrismaClient;
  const tenants: EphemeralTenant[] = [];
  const payerIds: string[] = [];
  const practiceIds: string[] = [];
  const prevEnforcement = process.env.TENANT_ACCESS_ENFORCEMENT;

  beforeAll(async () => {
    db = ownerClient();
  });

  afterAll(async () => {
    for (const t of tenants) await t.cleanup();
    if (db) {
      await db.payerPlan.deleteMany({ where: { payerId: { in: payerIds } } });
      await db.payer.deleteMany({ where: { id: { in: payerIds } } });
      await db.practice.deleteMany({ where: { id: { in: practiceIds } } });
      await db.$disconnect();
    }
  });

  afterEach(() => {
    if (prevEnforcement === undefined) delete process.env.TENANT_ACCESS_ENFORCEMENT;
    else process.env.TENANT_ACCESS_ENFORCEMENT = prevEnforcement;
  });

  async function kineTenant(): Promise<EphemeralTenant> {
    const t = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "PRO" });
    tenants.push(t);
    return t;
  }

  it("enforce + read_only: las actions clínicas residuales DEVUELVEN el copy del modo lectura y no escriben", async () => {
    delete process.env.TENANT_ACCESS_ENFORCEMENT; // armado con el consultorio activo
    const K = await kineTenant();
    const s = uniqueSuffix();
    asUser(K.userId);

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
      pricing: null,
      rows: [],
      stateToken: "x",
      ...over,
    });
    async function ready(p: PlanCreateInput, rowsOf: (p: PlanPreview) => PlanRowResolution[]) {
      const r = await previewPlan(p);
      if (!r.ok) throw new Error(`preview: ${r.error}`);
      return { ...p, stateToken: r.preview.stateToken, rows: rowsOf(r.preview) };
    }
    async function newPlan(patientId: string, rowsOf: (p: PlanPreview) => PlanRowResolution[]) {
      const r = await createPlan(await ready(planInput(patientId), rowsOf));
      if (!r.ok) throw new Error(`createPlan: ${JSON.stringify(r)}`);
      return r.programId;
    }

    // Plan sin turnos (link / adopt / generate / status) y plan con turnos (sacar del plan).
    const patientId = await addPatient(db, K);
    const pendingPlan = await newPlan(patientId, allNone);
    const bookedPlan = await newPlan(await addPatient(db, K), acceptDefaults);
    const cancelledPlan = await newPlan(await addPatient(db, K), allNone);
    // deleteProgram (archivar) rechaza un plan abierto sin escribir: este tiene que estar cerrado para llegar a la tx.
    await db.treatmentProgram.update({ where: { id: cancelledPlan }, data: { status: "CANCELLED" } });
    const sessions = await db.session.findMany({ where: { programId: pendingPlan }, orderBy: { index: "asc" } });
    const loose1 = await db.booking.findUniqueOrThrow({
      where: { id: await addPlanBooking(db, K, { patientId, scheduledFor: new Date("2030-01-08T14:00:00.000Z"), copagoCents: null }) },
    });
    const loose2 = await db.booking.findUniqueOrThrow({
      where: { id: await addPlanBooking(db, K, { patientId, scheduledFor: new Date("2030-01-09T14:00:00.000Z"), copagoCents: null }) },
    });
    const planBooking = await db.booking.findFirstOrThrow({ where: { programId: bookedPlan }, orderBy: { scheduledFor: "asc" } });

    // Diagnóstico: condición propia con 1 ejercicio vinculado; borrador listo (preview real).
    const cond = await db.condition.create({ data: { slug: `cond-ev1e1-${s}`, name: `Lumbalgia ${s}`, tenantId: K.tenantId } });
    const ex = await db.exercise.create({ data: { slug: `ev1e1-ex-${s}`, name: `Puente ${s}`, tenantId: K.tenantId } });
    await db.conditionExerciseLink.create({ data: { conditionId: cond.id, exerciseId: ex.id, relation: "DIRECT", phase: "ACTIVATION" } });
    const dxPatient = await addPatient(db, K);
    const dxDraft = await ready(planInput(dxPatient, { exercises: [{ exerciseId: ex.id, sets: 3, reps: 10 }] }), acceptDefaults);

    // Plantilla existente (para editar/archivar/borrar).
    const tpl = await createPlanTemplate({ name: `Plantilla ${s}`, discipline: "KINESIOLOGY", totalSessions: 4, exerciseIds: [] });
    if (!tpl.ok) throw new Error(`createPlanTemplate: ${tpl.error}`);
    const tplRow = await db.planTemplate.findUniqueOrThrow({ where: { id: tpl.data.id } });

    // Prestadora global para la propuesta de plan.
    const payer = await db.payer.create({
      data: {
        slug: `test-payer-${s}`,
        name: `Prestadora ${s}`,
        kind: "OBRA_SOCIAL",
        matchKey: matchKey(`Prestadora ${s}`),
        aliases: [],
        source: "CURATED",
        sourceDate: new Date("2026-09-01"),
      },
      select: { id: true },
    });
    payerIds.push(payer.id);

    // ── Pasa a solo lectura ──
    await db.tenant.update({ where: { id: K.tenantId }, data: { subscriptionStatus: "CANCELLED" } });
    process.env.TENANT_ACCESS_ENFORCEMENT = "enforce";
    asUser(K.userId);
    expect((await getActor()).access.mode).toBe("read_only");

    // El preview de generar turnos es lectura: anda en solo lectura y da el stateToken real del commit.
    const genPreview = await previewGeneratePlanBookings({ programId: pendingPlan });
    if (!genPreview.ok) throw new Error(`previewGenerate: ${genPreview.error}`);
    const pendingUpdatedAt = (await db.treatmentProgram.findUniqueOrThrow({ where: { id: pendingPlan } })).updatedAt.toISOString();

    const fingerprint = async () => {
      const where = { tenantId: K.tenantId };
      const [programs, sess, bookings, templates, conditions, exercises, favourites, cases, payerPlans, audits] = await Promise.all([
        db.treatmentProgram.findMany({ where, orderBy: { id: "asc" }, select: { id: true, status: true, updatedAt: true, archivedAt: true } }),
        db.session.findMany({ where: { program: where }, orderBy: { id: "asc" }, select: { id: true, updatedAt: true, scheduledFor: true } }),
        db.booking.findMany({ where, orderBy: { id: "asc" }, select: { id: true, updatedAt: true, programId: true, sessionId: true } }),
        db.planTemplate.findMany({ where, orderBy: { id: "asc" }, select: { id: true, updatedAt: true, archivedAt: true } }),
        db.condition.findMany({ where, orderBy: { id: "asc" }, select: { id: true, name: true, updatedAt: true } }),
        db.exercise.count({ where }),
        db.favorite.count({ where }),
        db.clinicalCase.count({ where }),
        db.payerPlan.count({ where: { payerId: payer.id } }),
        db.auditEvent.count({ where }),
      ]);
      return { programs, sess, bookings, templates, conditions, exercises, favourites, cases, payerPlans, audits };
    };
    const before = await fingerprint();

    const actions: Array<[string, () => Promise<unknown>]> = [
      ["createPlanFromDiagnosis", () => createPlanFromDiagnosis({ plan: dxDraft, diagnosis: { conditionSlug: cond.slug, selection: EMPTY_SELECTION } })],
      ["createCustomCondition", () => createCustomCondition({ name: `Nueva ${s}` })],
      ["updateCustomCondition", () => updateCustomCondition(cond.id, { name: `Renombrada ${s}` })],
      ["deleteCustomCondition", () => deleteCustomCondition(cond.id)],
      ["createExercise", () => createExercise({ name: `Ejercicio RO ${s}` })],
      ["createPlanTemplate", () => createPlanTemplate({ name: `Otra ${s}`, discipline: "KINESIOLOGY", totalSessions: 4, exerciseIds: [] })],
      ["updatePlanTemplate", () => updatePlanTemplate({ id: tplRow.id, name: `Editada ${s}`, expectedUpdatedAt: tplRow.updatedAt.toISOString() })],
      ["setPlanTemplateArchived", () => setPlanTemplateArchived(tplRow.id, true)],
      ["deletePlanTemplate", () => deletePlanTemplate(tplRow.id)],
      [
        "generatePlanBookings",
        () => generatePlanBookings({ programId: pendingPlan, rows: acceptDefaults(genPreview.preview), stateToken: genPreview.preview.stateToken }),
      ],
      [
        "linkBookingToSession",
        () =>
          linkBookingToSession({
            programId: pendingPlan,
            sessionId: sessions[0].id,
            bookingId: loose1.id,
            expectedBookingUpdatedAt: loose1.updatedAt.toISOString(),
            expectedUpdatedAt: pendingUpdatedAt,
          }),
      ],
      [
        "adoptBookingSeries",
        () =>
          adoptBookingSeries({
            programId: pendingPlan,
            expectedUpdatedAt: pendingUpdatedAt,
            bookings: [{ bookingId: loose2.id, expectedUpdatedAt: loose2.updatedAt.toISOString() }],
          }),
      ],
      ["removeBookingFromPlan", () => removeBookingFromPlan({ bookingId: planBooking.id, expectedUpdatedAt: planBooking.updatedAt.toISOString() })],
      ["setProgramStatus", () => setProgramStatus({ id: pendingPlan, status: "CANCELLED" })],
      ["deleteProgram", () => deleteProgram(cancelledPlan)],
      ["toggleFavourite", () => toggleFavourite(ex.id)],
      ["proposePayerPlan", () => proposePayerPlan(payer.id, `Plan RO ${s}`)],
    ];
    const results: Record<string, { kind: string; message: string }> = {};
    for (const [name, act] of actions) {
      try {
        const r = (await act()) as { ok: boolean; error?: string };
        results[name] = { kind: r.ok ? "ok" : "error", message: r.ok ? "" : String(r.error) };
      } catch (e) {
        results[name] = { kind: "throw", message: e instanceof Error ? e.message : String(e) };
      }
    }
    expect(results).toEqual(Object.fromEntries(actions.map(([n]) => [n, { kind: "error", message: READ_ONLY_MESSAGE }])));
    expect(await fingerprint()).toEqual(before);

    // ensureTag: contrato de tirar (C-EV4), no devuelve ActionResult. Se documenta que el corte es el de solo lectura.
    const tagsBefore = await db.tag.count();
    await expect(ensureTag(`RO tag ${s}`, "GOAL")).rejects.toThrow(READ_ONLY_MESSAGE);
    expect(await db.tag.count()).toBe(tagsBefore);
  });

  // ── ILIKE: el comodín del usuario se busca literal ──────────────────────────────────────────────────────────

  it("listExercises: `_` y `%` de la búsqueda son literales (antes matcheaban cualquier carácter/tira)", async () => {
    delete process.env.TENANT_ACCESS_ENFORCEMENT;
    const K = await kineTenant();
    asUser(K.userId);
    const s = uniqueSuffix();
    const mk = (name: string) => db.exercise.create({ data: { slug: `ev1e1-like-${uniqueSuffix()}`, name, tenantId: K.tenantId } }).then((e) => e.id);
    const decoy = await mk(`Plancha ${s} AxB`);
    const underscore = await mk(`Plancha ${s} A_B`);
    const percent = await mk(`Plancha ${s} 50% C`);
    const ids = async (q: string) => new Set((await listExercises({ kind: "all", q })).map((e) => e.id));

    const u = await ids(`${s} A_B`);
    expect(u.has(underscore)).toBe(true);
    expect(u.has(decoy)).toBe(false);
    const p = await ids(`${s} 50%`);
    expect(p.has(percent)).toBe(true);
    const pAll = await ids(`${s} %`);
    expect(pAll.has(decoy)).toBe(false); // sin escapar, «% » matcheaba las tres
    expect(pAll.has(underscore)).toBe(false);
  });

  it("searchPatientsForAssignment: `_` y `%` son literales en nombre, DNI y email", async () => {
    delete process.env.TENANT_ACCESS_ENFORCEMENT;
    const K = await kineTenant();
    asUser(K.userId);
    const s = uniqueSuffix().replace(/-/g, "");
    const decoy = await addPatient(db, K, { lastName: `Q${s}AxB`, documentId: `${s}1`, email: `q${s}axb@test.local` });
    const underscore = await addPatient(db, K, { lastName: `Q${s}A_B`, documentId: `${s}2` });
    const percent = await addPatient(db, K, { lastName: `Q${s}A%B`, documentId: `${s}3` });
    const ids = async (q: string) => new Set((await searchPatientsForAssignment(q)).map((p) => p.id));

    const u = await ids(`Q${s}A_B`);
    expect([u.has(underscore), u.has(decoy), u.has(percent)]).toEqual([true, false, false]);
    const p = await ids(`Q${s}A%`);
    expect([p.has(percent), p.has(decoy), p.has(underscore)]).toEqual([true, false, false]);
    // Email: `q<s>a_b@…` sin escapar matcheaba el del señuelo.
    expect((await ids(`q${s}a_b@`)).has(decoy)).toBe(false);
  });

  it("searchPayers / searchPractices: el nombre y el código exacto no interpretan comodines", async () => {
    delete process.env.TENANT_ACCESS_ENFORCEMENT;
    const K = await kineTenant();
    asUser(K.userId);
    const s = uniqueSuffix();
    const payer = await db.payer.create({
      data: {
        slug: `test-payer-${s}`,
        name: `Prestadora ${s} 100%`,
        kind: "OBRA_SOCIAL",
        matchKey: matchKey(`Prestadora ${s} 100%`),
        aliases: [],
        source: "CURATED",
        sourceDate: new Date("2026-09-01"),
      },
      select: { id: true },
    });
    payerIds.push(payer.id);
    // «%» solo: la `matchKey` de la consulta queda vacía (sin rama de palabras) y sin escapar el ILIKE era `%%%` =
    // todo el catálogo. Escapado devuelve solo nombres con un «%» literal.
    const pct = await searchPayers("%");
    expect(pct.map((p) => p.id)).toContain(payer.id);
    expect(pct.every((p) => p.name.includes("%"))).toBe(true);
    const und = await searchPayers("_");
    expect(und.every((p) => p.name.includes("_"))).toBe(true);

    // Código exacto (`equals` insensible = ILIKE sin `%`): `QZ7_1…` sin escapar matcheaba el código `QZ7X1…`.
    const tail = Date.now().toString(36).toUpperCase();
    const mkPractice = async (code: string) => {
      const name = `Practica ${uniqueSuffix()}`;
      const p = await db.practice.create({
        data: { slug: `test-practice-${uniqueSuffix()}`, name, code, matchKey: matchKey(name), aliases: [], source: "CURATED", sourceDate: new Date("2026-09-01") },
        select: { id: true },
      });
      practiceIds.push(p.id);
      return p.id;
    };
    const decoy = await mkPractice(`QZ7X1${tail}`);
    const exact = await mkPractice(`QZ7_1${tail}`);
    const got = (await searchPractices(`qz7_1${tail.toLowerCase()}`)).map((p) => p.id);
    expect(got).toContain(exact); // sigue sin distinguir mayúsculas
    expect(got).not.toContain(decoy);
  });
});
