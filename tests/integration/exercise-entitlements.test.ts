/**
 * EV-G (EV0, contrato C-EV9) — catálogo de ejercicios, condiciones y ⌘K por
 * módulos del consultorio, sobre las actions REALES y el `getActor()` real.
 *
 * Decisión de Martin (07-oct): Kine base (FREE/STARTER) = solo ejercicios
 * propios (deja de ver los globales `isBasic`); Kine PRO/ENT = propios + todo
 * el catálogo global; GENERAL = ninguno. Antes de EV0 un FREE veía y asignaba
 * los globales `isBasic`, y un consultorio General (que no existía) habría
 * heredado todo lo de Kine.
 *
 * Se afirma el efecto observable: qué ids devuelve la lista, qué filas quedan
 * (o no) en `Session`/`SessionExercise`/`Favorite`/`Condition`. Los globales
 * del test se crean con nombre único y se borran en el afterAll (la base local
 * puede tener el catálogo importado: se compara por id, nunca por conteo).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { ForbiddenError } from "@/lib/session";
import { listExercises, getExercise } from "@/lib/exercises";
import { toggleFavourite } from "@/lib/favourites";
import { getTemplatePrefill } from "@/lib/plan-templates";
import { createPlanFromDiagnosis } from "@/lib/diagnosis";
import { createPlan, previewPlan } from "@/lib/plans";
import type { PlanCreateInput, PlanPreview, PlanRowResolution } from "@/lib/plans-types";
import { addSessionExercise, bulkAddSessionExercises } from "@/lib/sessions";
import {
  createCustomCondition,
  updateCustomCondition,
  deleteCustomCondition,
  listCustomConditions,
} from "@/lib/conditions";
import { globalSearch } from "@/lib/search";
import { gatingForActor } from "@/lib/plan-gating";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser, asAnonymous } from "@/tests/helpers/actor";

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

describe.skipIf(!RUN)("EV-G · catálogo y ejercicios por módulos", () => {
  let db: PrismaClient;
  let KFree: EphemeralTenant;
  let KStarter: EphemeralTenant;
  let KPro: EphemeralTenant;
  let G: EphemeralTenant;
  /** Término único del run: lo llevan los nombres de ejercicios, condiciones y pacientes. */
  let term: string;
  let gBasic: { id: string; slug: string }; // global `isBasic` (antes visible a FREE/STARTER)
  let gPro: string; // global no-basic
  const own: Record<string, string> = {}; // ejercicio propio por tenantId

  async function ownExercise(t: EphemeralTenant): Promise<string> {
    const ex = await db.exercise.create({
      data: { tenantId: t.tenantId, slug: `evg-own-${uniqueSuffix()}`, name: `Propio ${term}` },
    });
    return ex.id;
  }

  async function template(t: EphemeralTenant, exerciseIds: string[]): Promise<string> {
    const row = await db.planTemplate.create({
      data: {
        tenantId: t.tenantId,
        authorId: t.practitionerId,
        name: `Plantilla ${uniqueSuffix()}`,
        totalSessions: 2,
        frequency: 2,
        exerciseIds,
      },
    });
    return row.id;
  }

  async function programWithSession(t: EphemeralTenant, patientId: string) {
    const program = await db.treatmentProgram.create({
      data: {
        tenantId: t.tenantId,
        patientId,
        title: `Plan ${uniqueSuffix()}`,
        totalSessions: 1,
        frequency: 1,
        startDate: new Date(Date.now() + 30 * 86_400_000),
        status: "ACTIVE",
      },
    });
    const session = await db.session.create({
      data: {
        programId: program.id,
        practitionerId: t.practitionerId,
        index: 1,
        scheduledFor: new Date(Date.now() + 30 * 86_400_000),
      },
    });
    return { programId: program.id, sessionId: session.id };
  }

  /**
   * Borrador del motor (P3.Z.0: las altas viejas de Diagnóstico y de
   * plantillas se retiraron; todo plan nace por `createPlan` /
   * `createPlanFromDiagnosis`).
   */
  const planDraft = (t: EphemeralTenant, patientId: string, over: Partial<PlanCreateInput> = {}): PlanCreateInput => ({
    idempotencyKey: randomUUID(),
    patientId,
    discipline: "KINESIOLOGY",
    practitionerId: t.practitionerId,
    serviceId: t.serviceId,
    locationId: null,
    schedule: LUN_JUE_10,
    startDayKey: "2030-01-07",
    totalSessions: 2,
    pricing: null,
    rows: [],
    stateToken: "x",
    ...over,
  });

  /** preview real → borrador con stateToken y resoluciones por defecto. */
  async function ready(p: PlanCreateInput): Promise<PlanCreateInput> {
    const r = await previewPlan(p);
    if (!r.ok) throw new Error(`preview: ${r.error}`);
    return { ...p, stateToken: r.preview.stateToken, rows: acceptDefaults(r.preview) };
  }

  /** "Aplicar plantilla" como el editor: prefill → preview → createPlan. */
  async function applyTemplate(t: EphemeralTenant, templateId: string, patientId: string) {
    const pre = await getTemplatePrefill(templateId);
    if (!pre.ok) return pre;
    const draft = planDraft(t, patientId, {
      totalSessions: pre.data.prefill.totalSessions ?? 2,
      ...(pre.data.prefill.templateId ? { templateId: pre.data.prefill.templateId } : {}),
      exercises: pre.data.exercises.map(({ exerciseId, sets, reps }) => ({ exerciseId, sets, reps })),
    });
    return createPlan(await ready(draft));
  }

  const exerciseIdsOf = async (patientId: string) =>
    (
      await db.sessionExercise.findMany({
        where: { session: { program: { patientId } } },
        select: { exerciseId: true },
      })
    ).map((r) => r.exerciseId);

  beforeAll(async () => {
    db = ownerClient();
    term = `evg${uniqueSuffix().replace(/[^a-z0-9]/g, "")}`;
    KFree = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "FREE" });
    KStarter = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "STARTER" });
    KPro = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "PRO" });
    G = await createEphemeralTenant(db, { vertical: "GENERAL", plan: "PRO" });

    const b = await db.exercise.create({
      data: { slug: `evg-gbasic-${uniqueSuffix()}`, name: `Global básico ${term}`, isBasic: true },
    });
    gBasic = { id: b.id, slug: b.slug };
    gPro = (
      await db.exercise.create({
        data: { slug: `evg-gpro-${uniqueSuffix()}`, name: `Global pro ${term}`, isBasic: false },
      })
    ).id;
    for (const t of [KFree, KStarter, KPro, G]) own[t.tenantId] = await ownExercise(t);
  });

  afterAll(async () => {
    asAnonymous();
    // Primero los tenants (sus sesiones referencian a los globales), después los globales.
    await KFree?.cleanup();
    await KStarter?.cleanup();
    await KPro?.cleanup();
    await G?.cleanup();
    if (gBasic) await db.exercise.delete({ where: { id: gBasic.id } }).catch(() => {});
    if (gPro) await db.exercise.delete({ where: { id: gPro } }).catch(() => {});
    await db?.$disconnect();
  });

  // ── Kine FREE / STARTER: solo propios ────────────────────────────────

  it("KINE FREE: un global isBasic no se lista ni se abre; el propio sí", async () => {
    asUser(KFree.userId);
    expect((await gatingForActor()).catalogScope).toBe("own");
    const ids = (await listExercises({ kind: "all", q: term })).map((e) => e.id);
    expect(ids).toEqual([own[KFree.tenantId]]);
    expect(await getExercise(gBasic.slug)).toBeNull();
  });

  it("KINE FREE: Diagnóstico con un global isBasic → rechazo sin crear caso ni plan", async () => {
    asUser(KFree.userId);
    const pat = await addPatient(db, KFree);
    const s = uniqueSuffix();
    await db.condition.create({ data: { slug: `evg-cond-${s}`, name: `Cond ${s}`, tenantId: KFree.tenantId } });
    const diagnosis = {
      conditionSlug: `evg-cond-${s}`,
      selection: { regions: [], symptoms: [], triggers: [], phase: null, intensity: 5 },
    };
    const ex = (id: string) => ({ exerciseId: id, sets: 3, reps: 12 });
    const r = await createPlanFromDiagnosis({
      plan: planDraft(KFree, pat, { exercises: [ex(own[KFree.tenantId]), ex(gBasic.id)] }),
      diagnosis,
    });
    expect(r.ok).toBe(false);
    expect(r).not.toMatchObject({ kind: "stale-preview" }); // por el global, no por el token
    expect(await db.clinicalCase.count({ where: { patientId: pat } })).toBe(0);
    expect(await db.treatmentProgram.count({ where: { patientId: pat } })).toBe(0);

    // Control: solo con el propio, pasa (el rechazo de arriba es por el global).
    const ok = await createPlanFromDiagnosis({
      plan: await ready(planDraft(KFree, pat, { exercises: [ex(own[KFree.tenantId])] })),
      diagnosis,
    });
    expect(ok.ok).toBe(true);
  });

  it("KINE FREE: sesión (add / bulk) con un global isBasic → rechazo sin escribir", async () => {
    asUser(KFree.userId);
    const pat = await addPatient(db, KFree);
    const { programId, sessionId } = await programWithSession(KFree, pat);
    const add = await addSessionExercise({ sessionId, exerciseId: gBasic.id });
    const bulk = await bulkAddSessionExercises({
      programId,
      exerciseIds: [gBasic.id],
      range: { kind: "all" },
    });
    expect(add.ok).toBe(false);
    expect(bulk.ok).toBe(false);
    expect(await exerciseIdsOf(pat)).toEqual([]);

    // Control: el propio sí se asigna.
    const addOwn = await addSessionExercise({ sessionId, exerciseId: own[KFree.tenantId] });
    expect(addOwn.ok).toBe(true);
    expect(await exerciseIdsOf(pat)).toEqual([own[KFree.tenantId]]);
  });

  it("[PL-1, C-PL1] KINE CONSULTORIO (ex STARTER): la plantilla aplica propios + globales (catálogo completo)", async () => {
    // Matriz de PL: Consultorio suma plantillas, favoritos y ejercicios globales; el «solo propios» quedó en Individual.
    asUser(KStarter.userId);
    expect((await gatingForActor()).catalogScope).toBe("full");
    const pat = await addPatient(db, KStarter);
    const tpl = await template(KStarter, [gBasic.id, own[KStarter.tenantId]]);
    const pre = await getTemplatePrefill(tpl);
    expect(pre.ok && pre.data.droppedExercises).toBe(0);
    const r = await applyTemplate(KStarter, tpl, pat);
    expect(r.ok).toBe(true);
    expect(new Set(await exerciseIdsOf(pat))).toEqual(new Set([gBasic.id, own[KStarter.tenantId]]));
  });

  // ── Kine PRO: + catálogo global ──────────────────────────────────────

  it("KINE PRO: lista propios + globales (básico y no básico) y la plantilla los aplica", async () => {
    asUser(KPro.userId);
    expect((await gatingForActor()).catalogScope).toBe("full");
    const ids = new Set((await listExercises({ kind: "all", q: term })).map((e) => e.id));
    expect(ids).toEqual(new Set([own[KPro.tenantId], gBasic.id, gPro]));
    expect((await getExercise(gBasic.slug))?.id).toBe(gBasic.id);

    const pat = await addPatient(db, KPro);
    const tpl = await template(KPro, [gBasic.id, gPro]);
    const r = await applyTemplate(KPro, tpl, pat);
    expect(r.ok).toBe(true);
    if (r.ok) expect((await db.treatmentProgram.findUniqueOrThrow({ where: { id: r.programId } })).templateId).toBe(tpl);
    expect(new Set(await exerciseIdsOf(pat))).toEqual(new Set([gBasic.id, gPro]));
  });

  it("gatingForActor(tx) lee plan y vertical en la tx: coincide con el de la sesión", async () => {
    const { runWithRls } = await import("@/lib/rls");
    for (const t of [KFree, KPro, G]) {
      asUser(t.userId);
      const inTx = await runWithRls(t.tenantId, (tx) => gatingForActor(tx));
      expect(inTx).toEqual(await gatingForActor());
    }
  });

  // ── GENERAL: sin ejercicios, sin condiciones ─────────────────────────

  it("GENERAL: listas de ejercicios vacías (aunque haya una fila propia)", async () => {
    asUser(G.userId);
    expect((await gatingForActor()).catalogScope).toBe("none");
    expect(await listExercises({ kind: "all" })).toEqual([]);
    expect(await listExercises({ kind: "all", q: term })).toEqual([]);
    expect(await getExercise(gBasic.slug)).toBeNull();
  });

  it("GENERAL: toggleFavourite rechazado sin escribir", async () => {
    asUser(G.userId);
    for (const id of [own[G.tenantId], gBasic.id]) {
      const r = await toggleFavourite(id);
      expect(r.ok).toBe(false);
    }
    expect(await db.favorite.count({ where: { tenantId: G.tenantId } })).toBe(0);
  });

  it("GENERAL: aplicar plantilla (prefill o createPlan con templateId) rechazado sin crear plan", async () => {
    asUser(G.userId);
    const pat = await addPatient(db, G);
    const tpl = await template(G, [own[G.tenantId]]);
    expect((await getTemplatePrefill(tpl)).ok).toBe(false);
    const r = await createPlan(planDraft(G, pat, { templateId: tpl }));
    expect(r.ok).toBe(false);
    expect(await db.treatmentProgram.count({ where: { patientId: pat } })).toBe(0);
  });

  it("GENERAL: createCustomCondition / update / delete → Forbidden sin escribir", async () => {
    asUser(G.userId);
    const existing = await db.condition.create({
      data: { slug: `evg-gcond-${uniqueSuffix()}`, name: `Condición ${term}`, tenantId: G.tenantId },
    });
    const before = await db.condition.count({ where: { tenantId: G.tenantId } });

    await expect(createCustomCondition({ name: `Nueva ${term}` })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateCustomCondition(existing.id, { name: "Cambiada" })).rejects.toBeInstanceOf(
      ForbiddenError
    );
    await expect(deleteCustomCondition(existing.id)).rejects.toBeInstanceOf(ForbiddenError);

    expect(await db.condition.count({ where: { tenantId: G.tenantId } })).toBe(before);
    expect((await db.condition.findUniqueOrThrow({ where: { id: existing.id } })).name).toBe(
      `Condición ${term}`
    );
  });

  it("GENERAL: listCustomConditions → [] aunque haya filas del tenant", async () => {
    asUser(G.userId);
    expect(await db.condition.count({ where: { tenantId: G.tenantId } })).toBeGreaterThan(0);
    expect(await listCustomConditions()).toEqual([]);
  });

  it("GENERAL: ⌘K sin ejercicios, sin condiciones y sin atajo Diagnóstico (pacientes sí)", async () => {
    asUser(G.userId);
    await addPatient(db, G, { firstName: term });
    const hits = await globalSearch(term);
    const cats = new Set(hits.map((h) => h.category));
    expect(cats.has("exercise")).toBe(false);
    expect(cats.has("condition")).toBe(false);
    expect(cats.has("patient")).toBe(true); // control: la búsqueda corrió

    const empty = await globalSearch("");
    const ids = empty.map((h) => h.id);
    expect(ids).not.toContain("nav:diagnostico");
    expect(ids).not.toContain("nav:seguimiento");
    expect(ids).not.toContain("nav:biblioteca");
    expect(ids).toContain("nav:agenda");

    const diag = await globalSearch("Diagn");
    expect(diag.some((h) => h.id === "nav:diagnostico")).toBe(false);
  });

  // Bug vivo encontrado en EV-G: la query de condiciones de `globalSearch` no
  // filtraba por tenant. Con `kinesoft_app` RLS lo tapaba; con el owner
  // BYPASSRLS (= prod) el ⌘K mostraba las condiciones custom de OTRO
  // consultorio (nombre + CIE-10). Se dio vuelta en la misma sesión.
  it("[EV0-EV-G] ⌘K no trae condiciones custom de otro consultorio", async () => {
    const foreign = await db.condition.create({
      data: { slug: `evg-foreign-${uniqueSuffix()}`, name: `Ajena ${term}`, tenantId: KPro.tenantId },
    });
    asUser(KFree.userId);
    const hits = await globalSearch(term);
    expect(hits.some((h) => h.id === `condition:${foreign.id}`)).toBe(false);
  });

  // ── Controles en Kine (anti falso verde) ─────────────────────────────

  it("KINE: crea y lista condiciones propias; ⌘K trae ejercicios, condiciones y el atajo", async () => {
    asUser(KFree.userId);
    const c = await createCustomCondition({ name: `Custom ${term}` });
    expect(c.ok).toBe(true);
    expect((await listCustomConditions()).map((r) => r.name)).toContain(`Custom ${term}`);

    const hits = await globalSearch(term);
    expect(hits.some((h) => h.category === "exercise" && h.id === `exercise:${own[KFree.tenantId]}`)).toBe(true);
    // FREE: el global isBasic tampoco aparece en ⌘K.
    expect(hits.some((h) => h.id === `exercise:${gBasic.id}`)).toBe(false);
    expect(hits.some((h) => h.category === "condition")).toBe(true);

    expect((await globalSearch("")).map((h) => h.id)).toContain("nav:diagnostico");
    expect((await globalSearch("Diagn")).some((h) => h.id === "nav:diagnostico")).toBe(true);
  });
});
