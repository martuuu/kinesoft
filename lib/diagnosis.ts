"use server";

/**
 * Diagnosis server actions — Phase 3 core IP.
 *
 * The pure matching engine (types, `rankSelection`, `exercisesFor`) lives
 * in `lib/diagnosis-engine.ts` and is import-safe from client code.
 * This file only exports **async server actions**:
 *
 *   1. `loadCatalog` — reads anatomy + conditions + tag-kind chips.
 *   2. `searchPatientsForAssignment` — debounced patient picker.
 *   3. `getDiagnosisPlanPrefill` — prefill del editor de planes (rampa por fase).
 *   4. `createPlanFromDiagnosis` — caso + diagnóstico + plan + turnos en UNA
 *      tx, por el motor de Planes (`createPlanInTx` con el hook `clinicalCase`).
 *      Es la ÚNICA alta de planes desde Diagnóstico.
 *
 * P3.Z.0 (S27b) retiró el alta vieja del Plan Builder: creaba caso + plan +
 * N sesiones a mano, fuera del motor (sin disponibilidad, sin conflictos, sin
 * turnos ni locks). Sus gates (acceso full, condición y ejercicios del
 * consultorio, tope de 60, días AR) se re-afirmaron sobre
 * `createPlanFromDiagnosis` en `tests/integration/plans-doors-diagnosis-authz.test.ts`
 * antes de borrarla.
 *
 * Verticales (enmienda S17d): TODOS los exports exigen el módulo
 * `diagnostico` — las lecturas devuelven vacío sin él, las escrituras dan
 * `{ ok:false }`. Un consultorio General no tiene Diagnóstico y un "use
 * server" es una RPC pública: esconder la pantalla no alcanza.
 *
 * P0-S02d borró `saveDiagnosisDraft`: no tenía callers y, como toda export
 * de un "use server", era una RPC pública que creaba ClinicalCase sin gate.
 *
 * Los tipos viven en `lib/diagnosis-types.ts` (un "use server" no exporta tipos).
 */
import { revalidatePath, unstable_cache } from "next/cache";
import { NotificationKind, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { runWithRls } from "@/lib/rls";
import { withReadOnlyResult } from "@/lib/read-only-result";
import { escapeLike } from "@/lib/email-match";
import { ForbiddenError, getActor, type Actor } from "@/lib/session";
import { auditInTx } from "@/lib/audit";
import { modulesFor, MODULE_DENIED_COPY } from "@/lib/tenant-modules";
import { assignableExerciseWhere, gatingForActor } from "@/lib/plan-gating";
import { hcAccessError } from "@/lib/patient-access-internal";
import { visibilityForActor, bulkPatientAccess } from "@/lib/visibility";
import { ownPatientsWhere } from "@/lib/practitioner-scope";
import { tags as cacheTags, ttl } from "@/lib/cache-tags";
import { diagnosisRampSteps, rankSelection } from "@/lib/diagnosis-engine";
import type {
  CatalogDTO,
  CreatePlanFromDiagnosisInput,
  CreatePlanFromDiagnosisResult,
  DiagnosisPlanPrefillInput,
  DiagnosisPlanPrefillResult,
} from "@/lib/diagnosis-types";
import type { PlanPreview } from "@/lib/plans-types";
import { actorCapsInTx } from "@/lib/bookings-core";
import { assertPlanManageInTx, PLAN_FORBIDDEN_COPY } from "@/lib/plan-authz-internal";
import { withTxConflictRetry } from "@/lib/plan-lock";
import { ProgramInvariantViolation } from "@/lib/plan-invariants-internal";
import { afterBookingsCommitted } from "@/lib/booking-events-internal";
import { notify } from "@/lib/notifications-internal";
import { disciplineShortLabel } from "@/lib/plan-display";
import {
  createPlanInTx,
  findProgramByKeyInTx,
  PlanRejected,
  previewNewPlanInTx,
  StalePlanPreview,
} from "@/lib/plans-engine-internal";
import {
  applyDiagnosisRampInTx,
  clinicalCaseHook,
  CreatePlanFromDiagnosisSchema,
  DEFAULT_REPS,
  DEFAULT_SETS,
  DIAGNOSIS_COPY,
  DiagnosisPlanPrefillInputSchema,
  findConditionInTx,
  loadConditionExercisesInTx,
  loadPhasedExercisesInTx,
  PREFILL_DEFAULT_SESSIONS,
} from "@/lib/diagnosis-internal";

/** ¿El consultorio del actor tiene Diagnóstico? (sync, sin query: `actor.entitlements`). */
function hasDiagnosis(actor: Actor): boolean {
  return modulesFor(actor.entitlements).has("diagnostico");
}

/** Catálogo vacío: lo que ve un consultorio sin el módulo (sin queries ni cache). */
const EMPTY_CATALOG: CatalogDTO = { regions: [], conditions: [], symptoms: [], triggers: [], phases: [] };

// ──────────────────────────────────────────────────────────────────────
// Catalog loader
// ──────────────────────────────────────────────────────────────────────

export async function loadCatalog(): Promise<CatalogDTO> {
  const actor = await getActor();
  // S17d (enmienda EV0): sin `diagnostico`, vacío y sin pasar por la cache.
  if (!hasDiagnosis(actor)) return EMPTY_CATALOG;
  const gate = await gatingForActor();
  const fetcher = unstable_cache(
    async (): Promise<CatalogDTO> => {
      const [regions, conditions, symptoms, triggers, phases] = await Promise.all([
        prisma.anatomicalRegion.findMany({
          orderBy: [{ view: "asc" }, { sortOrder: "asc" }],
        }),
        runWithRls(actor.tenantId, (tx) => tx.condition.findMany({
          // Sprint 17: include global rows + this tenant's custom
          // conditions. Custom rows have no anatomy/tag/exercise
          // links but still show up as pickable confirmed diagnoses
          // in the Diagnóstico door (S23, editor de planes).
          where: {
            OR: [{ tenantId: null }, { tenantId: actor.tenantId }],
          },
          include: {
            tags: { include: { tag: true } },
            anatomy: true,
            // Filter included exercises by the tenant's plan — FREE/STARTER
            // tenants only see basic + own private exercises through the
            // diagnosis suggestions. P0-S02d: `assignable` (además, no
            // archivados), el mismo filtro con que el alta valida los ids;
            // si no, el wizard sugería un archivado y el alta lo rechazaba.
            exercises: {
              where: { exercise: assignableExerciseWhere(gate) },
              include: { exercise: true },
            },
          },
        })),
        prisma.tag.findMany({ where: { kind: "SYMPTOM" }, orderBy: { label: "asc" } }),
        prisma.tag.findMany({ where: { kind: "TRIGGER" }, orderBy: { label: "asc" } }),
        prisma.tag.findMany({ where: { kind: "PHASE" }, orderBy: { label: "asc" } }),
      ]);
      return buildCatalogDTO(regions, conditions, symptoms, triggers, phases);
    },
    ["diagnosis:catalog", actor.tenantId, gate.catalogScope],
    {
      // 1h TTL — the catalog (anatomy, conditions, tags) changes only
      // when seed/migration runs. Invalidated when a tenant adds a
      // custom exercise (via revalidateTag on `catalog`).
      tags: [cacheTags.catalog(), cacheTags.anatomy()],
      revalidate: ttl.long,
    }
  );
  return fetcher();
}

type _RegionRow = Awaited<ReturnType<typeof prisma.anatomicalRegion.findMany>>[number];
type _ConditionRow = Awaited<
  ReturnType<typeof prisma.condition.findMany<{
    include: {
      tags: { include: { tag: true } };
      anatomy: true;
      exercises: { include: { exercise: true } };
    };
  }>>
>[number];
type _TagRow = Awaited<ReturnType<typeof prisma.tag.findMany>>[number];

function buildCatalogDTO(
  regions: _RegionRow[],
  conditions: _ConditionRow[],
  symptoms: _TagRow[],
  triggers: _TagRow[],
  phases: _TagRow[]
): CatalogDTO {

  return {
    regions: regions.map((r) => ({
      slug: r.slug,
      label: r.label,
      view: r.view,
      side: r.side,
      parentSlug: r.parentSlug,
      tagSlug: r.tagSlug,
      shape: r.shape,
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      rx: r.rx,
      ry: r.ry,
      path: r.path,
    })),
    conditions: conditions.map((c) => ({
      id: c.id,
      slug: c.slug,
      cie10: c.cie10,
      name: c.name,
      summary: c.summary,
      severity: c.severity,
      recoveryWeeksMin: c.recoveryWeeksMin,
      recoveryWeeksMax: c.recoveryWeeksMax,
      mechanism: c.mechanism,
      redFlags: c.redFlags,
      isCustom: c.tenantId != null,
      tags: c.tags.map((t) => ({
        slug: t.tag.slug,
        label: t.tag.label,
        kind: t.tag.kind,
        weight: t.weight,
      })),
      anatomy: c.anatomy.map((a) => ({ regionSlug: a.regionSlug, role: a.role })),
      exercises: c.exercises.map((l) => ({
        exerciseId: l.exerciseId,
        slug: l.exercise.slug,
        name: l.exercise.name,
        relation: l.relation,
        phase: l.phase,
        weight: l.weight,
        rationale: l.rationale,
        muscleGroups: l.exercise.muscleGroups,
        equipment: l.exercise.equipment,
        // Defaults are now optional on Exercise; the diagnosis engine seeds a
        // starting plan, so fall back to 3×12 when the source has none.
        defaultSets: l.exercise.defaultSets ?? 3,
        defaultReps: l.exercise.defaultReps ?? 12,
        difficulty: l.exercise.difficulty,
      })),
    })),
    symptoms: symptoms.map((s) => ({ slug: s.slug, label: s.label })),
    triggers: triggers.map((s) => ({ slug: s.slug, label: s.label })),
    phases: phases.map((s) => ({ slug: s.slug, label: s.label })),
  };
}

// ──────────────────────────────────────────────────────────────────────
// Plan Builder — patient picker
// ──────────────────────────────────────────────────────────────────────

/**
 * Picker de paciente del Plan Builder.
 *
 * P0.Z (H-b4, revisor (b) de ES1): devolvía edad (de `dateOfBirth`) y "con plan
 * activo" de cualquier paciente del tenant a cualquier rol, y buscaba por
 * email: un kine en básico o la Secretaria/BILLING (PD-13: nunca HC) leían
 * datos clínicos y confirmaban emails. Asignar un plan exige `full` igual
 * (`hcAccessError` en el write), así que el picker devuelve solo filas `full`:
 *  - rol sin `clinical.read` (`adminView`) → [] sin query de pacientes;
 *  - kine sin "ver todo" → el SQL se acota a asignados + compartidos (para que
 *    el `take` no se llene de filas que después se descartan);
 *  - y `bulkPatientAccess` es la decisión final fila por fila (la misma regla
 *    que el resto de la app, no una copia).
 *
 * S17d:
 *  - exige `diagnostico` (enmienda EV0): sin el módulo, `[]` sin queries;
 *  - firma ADITIVA `opts.requireFull` (default false, C13 `PatientPicker
 *    requireFull`). Hoy las dos ramas devuelven solo filas `full`: el filtro
 *    de H-b4 se preserva tal cual (decisión del orquestador de ES2b). La
 *    opción existe para que los pickers de Planes (S18s/S21) la pidan
 *    explícita y no dependan de este default si H-b4 se relaja para la agenda.
 */
export async function searchPatientsForAssignment(
  q: string,
  opts?: { requireFull?: boolean }
) {
  void opts?.requireFull;
  const actor = await getActor();
  if (!hasDiagnosis(actor)) return [];
  const v = await visibilityForActor(actor);
  if (v.adminView) return [];
  const term = q.trim();
  // EV1-E1: Prisma no escapa los comodines de `contains` (ILIKE `'%' || term || '%'`): «_» o «%» matcheaban
  // cualquier paciente visible. `escapeLike` (lib/email-match.ts).
  const like = escapeLike(term);
  const where = {
    tenantId: actor.tenantId,
    // Un paciente archivado no se elige para un plan nuevo (hallazgo de P2-FX1).
    archivedAt: null,
    ...v.patientWhere,
    // IAM-4a: `ownPatientsWhere` (nunca `assignedPractitionerId IS NULL` con un actor sin profesional).
    ...(v.seesAll ? {} : { AND: [ownPatientsWhere(actor)] }),
    ...(term
      ? {
          OR: [
            { firstName: { contains: like, mode: "insensitive" as const } },
            { lastName: { contains: like, mode: "insensitive" as const } },
            { documentId: { contains: like, mode: "insensitive" as const } },
            { email: { contains: like, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };
  const rows = await runWithRls(actor.tenantId, (tx) => tx.patient.findMany({
    where,
    take: 12,
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    select: {
      id: true,
      firstName: true,
      lastName: true,
      dateOfBirth: true,
      documentId: true,
      // P0-S02d: con 2 ACTIVE (legacy) el take 1 sin orden era arbitrario.
      programs: {
        where: { status: "ACTIVE" },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { id: true },
      },
    },
  }));
  const access = await bulkPatientAccess(actor, rows.map((r) => r.id));
  return rows.filter((p) => access.get(p.id) === "full").map((p) => ({
    id: p.id,
    name: `${p.firstName} ${p.lastName}`,
    hc: p.documentId
      ? `HC-${p.documentId.slice(-6).toUpperCase()}`
      : `HC-${p.id.slice(-6).toUpperCase()}`,
    info: p.dateOfBirth
      ? `${Math.floor((Date.now() - +p.dateOfBirth) / (365.25 * 86_400_000))} años${
          p.programs[0] ? " · con plan activo" : ""
        }`
      : p.programs[0]
        ? "Con plan activo"
        : "Sin plan",
  }));
}

// ──────────────────────────────────────────────────────────────────────
// Puerta Diagnóstico → Plan (S17d, ES2b P2.2)
// ──────────────────────────────────────────────────────────────────────

/** Opciones de la tx del commit (las del motor, §5: ≤ 60 statements para 20 filas). */
const COMMIT_TX = { timeout: 15_000, maxWait: 5_000 };

type Fail = { ok: false; error: string; fieldErrors?: Record<string, string[]> };

function invalidInput(err: { issues: { message: string }[]; flatten(): { fieldErrors: unknown } }): Fail {
  return {
    ok: false,
    error: err.issues[0]?.message ?? "Datos inválidos.",
    fieldErrors: err.flatten().fieldErrors as Record<string, string[]>,
  };
}

/** Rechazos esperables → resultado (en prod Next oculta el mensaje de un throw); lo demás se propaga. */
function rejection(e: unknown): Fail | null {
  if (e instanceof PlanRejected) {
    return { ok: false, error: e.message, ...(e.field ? { fieldErrors: { [e.field]: [e.message] } } : {}) };
  }
  if (e instanceof ForbiddenError) return { ok: false, error: e.message };
  // P2-Z · B-M2: el verificador ya reportó a Sentry y la tx hizo rollback;
  // sin esto el throw llegaba al cliente como un 500 genérico.
  if (e instanceof ProgramInvariantViolation) return { ok: false, error: PLAN_INCONSISTENT };
  return null;
}

/** Mismo texto que `plans-lifecycle-internal` / `plans-adopt-internal`. */
const PLAN_INCONSISTENT = "El plan tiene datos inconsistentes y no se pudo guardar el cambio. Ya avisamos al equipo técnico.";

/**
 * Preview fresco del borrador (para devolver junto al stale): mismo gate que
 * el alta (`plans.manage` + full + `clinical.read`, con `planes`).
 */
async function previewDraftInNewTx(
  actor: Actor,
  plan: CreatePlanFromDiagnosisInput["plan"],
  now: Date
): Promise<PlanPreview> {
  return runWithRls(actor.tenantId, async (tx) => {
    const caps = await actorCapsInTx(tx, actor);
    await assertPlanManageInTx(tx, actor, caps, plan.patientId);
    return previewNewPlanInTx(tx, actor, plan, { now });
  });
}

/**
 * Prefill del editor de planes desde Diagnóstico (C10 `diagnosis?`, PQ-12:
 * "Diagnóstico = rampa"): condición, título sugerido, ejercicios con su fase
 * y dosis inicial, y la rampa por tramos para `totalSessions` (default 10).
 * Sin `exerciseIds` sugiere los vínculos asignables de la condición.
 *
 * Solo catálogo, nada del paciente. Gate: `diagnostico` (enmienda EV0) +
 * `plans.manage` (la Secretaria y Facturación no arman planes). Los
 * ejercicios, `assignable` con el plan del tenant leído en la tx; uno no
 * asignable → rechazo (no se descarta en silencio: el editor mostraría una
 * rampa distinta de la que el alta va a aceptar).
 */
export async function getDiagnosisPlanPrefill(
  raw: DiagnosisPlanPrefillInput
): Promise<DiagnosisPlanPrefillResult> {
  const actor = await getActor();
  if (!hasDiagnosis(actor)) return { ok: false, error: MODULE_DENIED_COPY.diagnostico };
  const parsed = DiagnosisPlanPrefillInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Datos inválidos." };
  const input = parsed.data;

  return runWithRls(actor.tenantId, async (tx): Promise<DiagnosisPlanPrefillResult> => {
    const caps = await actorCapsInTx(tx, actor);
    if (!caps.has("plans.manage")) return { ok: false, error: PLAN_FORBIDDEN_COPY.manage };
    const condition = await findConditionInTx(tx, actor.tenantId, input.conditionSlug);
    if (!condition) return { ok: false, error: DIAGNOSIS_COPY.unknownCondition };
    const phased = input.exerciseIds
      ? await loadPhasedExercisesInTx(tx, condition.id, input.exerciseIds)
      : await loadConditionExercisesInTx(tx, condition.id);
    if (!phased) return { ok: false, error: DIAGNOSIS_COPY.exercises };

    const rank = { ACTIVATION: 0, STABILITY: 1, LOAD: 2, PROGRESSION: 3 } as const;
    const exercises = [...phased]
      .sort((a, b) => rank[a.phase] - rank[b.phase])
      .map((e) => ({
        exerciseId: e.exerciseId,
        name: e.name,
        phase: e.phase,
        sets: e.defaultSets ?? DEFAULT_SETS,
        reps: e.defaultReps ?? DEFAULT_REPS,
      }));
    const totalSessions = input.totalSessions ?? PREFILL_DEFAULT_SESSIONS;
    return {
      ok: true,
      data: {
        conditionSlug: input.conditionSlug,
        conditionName: condition.name,
        discipline: "KINESIOLOGY",
        // Mismo título que tenía el alta vieja (S27b la retiró); ≤ 120 (tope de `title` en el zod del plan).
        title: `Plan ${condition.name}`.slice(0, 120),
        totalSessions,
        exercises,
        ramp: diagnosisRampSteps(exercises, totalSessions),
      },
    };
  });
}

/**
 * Alta de un plan desde Diagnóstico: ClinicalCase + Diagnosis rankeados +
 * plan + sesiones (con la rampa de ejercicios por fase) + turnos, en UNA tx
 * (§5 "Commit", con el hook `clinicalCase` del motor).
 *
 * Gates, en orden y DENTRO de la tx:
 *  1. `diagnostico` (enmienda EV0) antes de abrir nada;
 *  2. `hcAccessError`: acceso full al paciente (S02d; básico = solo ver);
 *  3. condición global o del tenant (`where` a mano: prod es BYPASSRLS);
 *  4. ejercicios asignables con el plan del tenant leído en la tx (y ≥ 1, zod);
 *  5. `createPlanInTx` → `assertPlanManageInTx` (`planes`, `plans.manage`,
 *     full + `clinical.read`) y el resto del motor (refs, locks C2,
 *     idempotencia, re-clasificación → stale = rollback total).
 *
 * El ranking que se persiste lo recalcula el server (`rankSelection` sobre el
 * catálogo cacheado, fuera de la tx). El borrador `plan` llega intacto al
 * motor (el `stateToken` lo cubre entero); la rampa reescribe los ejercicios
 * de las sesiones en la misma tx (ver `lib/diagnosis-internal.ts`).
 *
 * Post-commit, una vez y fuera de la tx: `afterBookingsCommitted`, el aviso
 * al responsable (sin PHI) y los revalidate. Un éxito idempotente no emite.
 */
// EV1-E1 (readonly-residual-actions): el cuerpo va en `createPlanFromDiagnosisImpl`; el wrapper convierte el ReadOnlyModeError
// (modo lectura / soporte) en `{ ok:false, error }` para que en prod Next no redacte el mensaje
// (lib/read-only-result.ts, mismo patrón que BO3-F).
export async function createPlanFromDiagnosis(...args: Parameters<typeof createPlanFromDiagnosisImpl>): ReturnType<typeof createPlanFromDiagnosisImpl> {
  return withReadOnlyResult(() => createPlanFromDiagnosisImpl(...args));
}

async function createPlanFromDiagnosisImpl(
  raw: CreatePlanFromDiagnosisInput
): Promise<CreatePlanFromDiagnosisResult> {
  const actor = await getActor();
  if (!hasDiagnosis(actor)) return { ok: false, error: MODULE_DENIED_COPY.diagnostico };
  const parsed = CreatePlanFromDiagnosisSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error);
  const { plan, diagnosis } = parsed.data;
  const exercises = plan.exercises ?? [];
  const now = new Date();
  const tenantId = actor.tenantId;

  // Fuera de la tx: `loadCatalog` abre la suya y va por `unstable_cache`.
  const ranked = rankSelection(diagnosis.selection, await loadCatalog());

  type Out = Awaited<ReturnType<typeof createPlanInTx>> & { caseId: string | null };
  let out: Out;
  try {
    out = await withTxConflictRetry(() =>
      runWithRls(
        tenantId,
        async (tx): Promise<Out> => {
          const denied = await hcAccessError(actor, plan.patientId, tx);
          if (denied) throw new PlanRejected(denied, "patientId");
          const condition = await findConditionInTx(tx, tenantId, diagnosis.conditionSlug);
          if (!condition) throw new PlanRejected(DIAGNOSIS_COPY.unknownCondition, "conditionSlug");
          const phased = await loadPhasedExercisesInTx(tx, condition.id, exercises.map((e) => e.exerciseId));
          if (!phased) throw new PlanRejected(DIAGNOSIS_COPY.exercises, "exercises");

          let caseId: string | null = null;
          const hook = clinicalCaseHook({ actor, patientId: plan.patientId, condition, ranked, selection: diagnosis.selection });
          const created = await createPlanInTx(tx, actor, plan, {
            now,
            caps: await actorCapsInTx(tx, actor),
            origin: "diagnosis",
            clinicalCase: async (t) => (caseId = await hook(t)),
          });
          if (created.idempotent) {
            // Reintento con la misma key: el caso es el del plan que ya existe.
            const p = await tx.treatmentProgram.findFirst({
              where: { id: created.programId, tenantId },
              select: { caseId: true },
            });
            return { ...created, caseId: p?.caseId ?? null };
          }

          const phaseOf = new Map(phased.map((e) => [e.exerciseId, e.phase]));
          await applyDiagnosisRampInTx(tx, {
            tenantId,
            programId: created.programId,
            exercises: exercises.map((e) => ({ ...e, phase: phaseOf.get(e.exerciseId) ?? "ACTIVATION" })),
          });
          // Payload sin PHI (C8): ids y conteos, no el nombre del diagnóstico.
          await auditInTx(tx, {
            tenantId,
            actorId: actor.userId ?? undefined,
            action: "diagnosis.assign",
            entity: "ClinicalCase",
            entityId: caseId!,
            payload: {
              conditionId: condition.id,
              programId: created.programId,
              totalSessions: created.sessions,
              exerciseCount: phased.length,
            },
          });
          return { ...created, caseId };
        },
        COMMIT_TX
      )
    );
  } catch (e) {
    if (e instanceof StalePlanPreview) {
      return { ok: false, kind: "stale-preview", preview: e.preview ?? (await previewDraftInNewTx(actor, plan, now)) };
    }
    const r = rejection(e);
    if (r) return r;
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      // Carrera con otra alta (misma key u otro turno del paciente): la tx
      // quedó abortada; se resuelve por los DATOS en una tx nueva.
      const existing = await runWithRls(tenantId, (tx) => findProgramByKeyInTx(tx, tenantId, plan.idempotencyKey));
      if (existing && existing.patientId === plan.patientId) {
        const p = await runWithRls(tenantId, (tx) =>
          tx.treatmentProgram.findFirst({ where: { id: existing.id, tenantId }, select: { caseId: true } })
        );
        return { ok: true, programId: existing.id, caseId: p?.caseId ?? null, idempotent: true };
      }
      try {
        return { ok: false, kind: "stale-preview", preview: await previewDraftInNewTx(actor, plan, now) };
      } catch (e2) {
        const r2 = rejection(e2);
        if (r2) return r2;
        throw e2;
      }
    }
    throw e;
  }

  if (!out.idempotent) {
    await afterBookingsCommitted(tenantId, out.refs);
    if (out.practitionerUserId && out.practitionerUserId !== actor.userId) {
      // Aviso resumen al responsable, sin PHI (ni nombre, ni título, ni diagnóstico).
      await notify({
        tenantId,
        userId: out.practitionerUserId,
        kind: NotificationKind.SYSTEM,
        title: "Te asignaron un plan nuevo",
        body: `${disciplineShortLabel(plan.discipline)} · ${out.sessions} sesiones · ${out.bookings} turnos`,
        link: `/pacientes/${plan.patientId}?tab=planes&programa=${out.programId}`,
      });
    }
    revalidatePath("/diagnostico");
    revalidatePath(`/pacientes/${plan.patientId}`);
    revalidatePath("/pacientes");
    revalidatePath("/dashboard");
  }
  return { ok: true, programId: out.programId, caseId: out.caseId, idempotent: out.idempotent };
}
