"use server";

/**
 * Diagnosis server actions — Phase 3 core IP.
 *
 * The pure matching engine (types, `rankSelection`, `exercisesFor`) lives
 * in `lib/diagnosis-engine.ts` and is import-safe from client code.
 * This file only exports **async server actions**:
 *
 *   1. `loadCatalog` — reads anatomy + conditions + tag-kind chips.
 *   2. `assignDiagnosisAndCreateProgram` — Plan Builder mutation.
 *   3. `searchPatientsForAssignment` — debounced patient picker.
 *
 * P0-S02d borró `saveDiagnosisDraft`: no tenía callers y, como toda export
 * de un "use server", era una RPC pública que creaba ClinicalCase sin gate.
 *
 * Los tipos viven en `lib/diagnosis-types.ts` (un "use server" no exporta tipos).
 */
import { revalidatePath, unstable_cache } from "next/cache";
import { ProgramPhase, ProgramStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { runWithRls } from "@/lib/rls";
import { getActor } from "@/lib/session";
import { auditInTx } from "@/lib/audit";
import { assignableExerciseWhere, gatingForActor } from "@/lib/plan-gating";
import { hcAccessError } from "@/lib/patient-access-internal";
import { PLAN_MAX_SESSIONS } from "@/lib/plans-constants";
import { expandDates } from "@/lib/availability/recurrence";
import { visibilityForActor, bulkPatientAccess } from "@/lib/visibility";
import { tags as cacheTags, ttl } from "@/lib/cache-tags";
import { localToARIso } from "@/lib/datetime-ar";
import type { ActionResult } from "@/lib/validation";
import { rankSelection } from "@/lib/diagnosis-engine";
import type { AssignInput, CatalogDTO } from "@/lib/diagnosis-types";

// ──────────────────────────────────────────────────────────────────────
// Catalog loader
// ──────────────────────────────────────────────────────────────────────

export async function loadCatalog(): Promise<CatalogDTO> {
  const actor = await getActor();
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
          // links but still show up in the AssignPlanModal picker.
          where: {
            OR: [{ tenantId: null }, { tenantId: actor.tenantId }],
          },
          include: {
            tags: { include: { tag: true } },
            anatomy: true,
            // Filter included exercises by the tenant's plan — FREE/STARTER
            // tenants only see basic + own private exercises through the
            // diagnosis suggestions. P0-S02d: `assignable` (además, no
            // archivados), el mismo filtro con que el assign valida los ids;
            // si no, el wizard sugería un archivado y el assign lo rechazaba.
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
    ["diagnosis:catalog", actor.tenantId, gate.hasFullCatalog ? "full" : "basic"],
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
// Plan Builder mutation
// ──────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/**
 * Fechas de las N sesiones, a las 00:00 AR (P0-S02d).
 *
 * - Con `daysOfWeek` (0=Lun … 6=Dom): `expandDates` weekly desde el inicio,
 *   así "lun/jue" genera sesiones solo lunes y jueves AR. Antes el server
 *   ignoraba los días elegidos en el modal y repartía por frecuencia desde
 *   el día de inicio (un inicio en martes daba martes/viernes). OJO: weekly
 *   con un solo día devuelve a lo sumo 58 (tope heredado de
 *   `expandBatchDates`, ver `lib/availability/recurrence.ts`); el caller
 *   rechaza si vuelven menos de N en lugar de crear un plan más corto.
 * - Sin días (el wizard de un solo paso no los manda): reparto legacy por
 *   frecuencia, `inicio + floor(i·7/frecuencia)` días. Se suma en ms (AR no
 *   tiene DST) en vez de `Date#setDate`, que dependía de la TZ del host.
 */
function sessionDates(
  start: Date,
  count: number,
  frequency: number,
  daysOfWeek: number[] | undefined
): Date[] {
  if (daysOfWeek && daysOfWeek.length > 0) {
    return expandDates({ anchor: start, count, frequency: "weekly", daysOfWeek });
  }
  return Array.from(
    { length: count },
    (_, i) => new Date(start.getTime() + Math.floor((i * 7) / frequency) * DAY_MS)
  );
}

/**
 * Writes ClinicalCase → top-N Diagnosis → TreatmentProgram → N Sessions →
 * SessionExercises in a single transaction. Re-ranks server-side so the
 * persisted match scores are authoritative.
 *
 * P0-S02d — gates (antes solo se chequeaba que el paciente fuera del tenant):
 *  - acceso **full** al paciente (`hcAccessError`) DENTRO de la tx del write:
 *    acceso básico = solo ver (decisión A2b-S-vis), y Diagnóstico era la
 *    única puerta de creación de planes que lo salteaba;
 *  - condición global o del tenant, con el filtro a mano: `Condition.slug`
 *    es único global y en prod la conexión tiene BYPASSRLS, así que el slug
 *    de una condición custom de otro consultorio se aceptaba;
 *  - ejercicios `assignableExerciseWhere` (plan SaaS + no archivado). Si
 *    falta CUALQUIERA de los pedidos se rechaza todo: antes, con uno válido,
 *    los de otro tenant / PRO en FREE / archivados se colaban por id;
 *  - tope `PLAN_MAX_SESSIONS` (60, PD-04; antes 64) y días elegidos.
 * El audit va en la misma tx (`auditInTx`): existe si y solo si el plan existe.
 */
export async function assignDiagnosisAndCreateProgram(
  input: AssignInput
): Promise<ActionResult<{ caseId: string; programId: string }>> {
  const actor = await getActor();

  if (!input.patientId) return { ok: false, error: "Elegí un paciente." };
  if (!input.conditionSlug) return { ok: false, error: "Elegí un diagnóstico." };
  const exerciseIds = Array.from(new Set(input.exerciseIds ?? []));
  if (!exerciseIds.length)
    return { ok: false, error: "El plan necesita al menos un ejercicio." };
  if (
    !Number.isInteger(input.totalSessions) ||
    input.totalSessions < 1 ||
    input.totalSessions > PLAN_MAX_SESSIONS
  )
    return { ok: false, error: `Las sesiones deben estar entre 1 y ${PLAN_MAX_SESSIONS}.` };
  if (!Number.isInteger(input.frequency) || input.frequency < 1 || input.frequency > 7)
    return { ok: false, error: "La frecuencia debe estar entre 1 y 7 por semana." };
  const daysOfWeek = input.daysOfWeek
    ? Array.from(new Set(input.daysOfWeek))
    : undefined;
  if (daysOfWeek?.some((d) => !Number.isInteger(d) || d < 0 || d > 6))
    return { ok: false, error: "Días de la semana inválidos." };

  // `input.startDate` is an AR calendar day ("YYYY-MM-DD"). Anchor it to AR
  // midnight so session 1 lands on the intended AR day (parsing it bare
  // yields UTC midnight = the previous day at 21:00 AR).
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate ?? ""))
    return { ok: false, error: "Fecha inválida." };
  const startDate = new Date(localToARIso(`${input.startDate}T00:00:00`));
  if (Number.isNaN(startDate.getTime())) return { ok: false, error: "Fecha inválida." };

  const N = input.totalSessions;
  const dates = sessionDates(startDate, N, input.frequency, daysOfWeek);
  if (dates.length < N)
    return {
      ok: false,
      error: `Con los días elegidos entran hasta ${dates.length} sesiones. Sumá un día o bajá la cantidad.`,
    };

  // Re-rank server-side as the authoritative source for persisted scores.
  // Fuera de la tx: `loadCatalog` abre la suya y va por `unstable_cache`.
  const catalog = await loadCatalog();
  const ranked = rankSelection(input.selection, catalog).slice(0, 4);

  const outcome = await runWithRls(actor.tenantId, async (tx) => {
    const denied = await hcAccessError(actor, input.patientId, tx);
    if (denied) return { ok: false as const, error: denied };

    const condition = await tx.condition.findFirst({
      where: {
        slug: input.conditionSlug,
        OR: [{ tenantId: null }, { tenantId: actor.tenantId }],
      },
      select: { id: true, name: true },
    });
    if (!condition) return { ok: false as const, error: "Diagnóstico desconocido." };

    const gate = await gatingForActor(tx);
    const exercises = await tx.exercise.findMany({
      where: { AND: [{ id: { in: exerciseIds } }, assignableExerciseWhere(gate)] },
      include: { conditions: { where: { conditionId: condition.id } } },
    });
    if (exercises.length !== exerciseIds.length)
      return {
        ok: false as const,
        error: "Hay ejercicios que no están disponibles en tu plan o fueron archivados.",
      };

    // Bucket by phase so we can ramp the program activation → progression.
    const byPhase: Record<ProgramPhase, typeof exercises> = {
      ACTIVATION: [],
      STABILITY: [],
      LOAD: [],
      PROGRESSION: [],
    };
    for (const ex of exercises) {
      const link = ex.conditions[0];
      const phase: ProgramPhase = link?.phase ?? "ACTIVATION";
      byPhase[phase].push(ex);
    }

    const sessionsData = dates.map((scheduledFor, i) => {
      const phaseIdx = Math.min(3, Math.floor((i / N) * 4));
      const phasePool = [
        ...byPhase.ACTIVATION,
        ...(phaseIdx >= 1 ? byPhase.STABILITY : []),
        ...(phaseIdx >= 2 ? byPhase.LOAD : []),
        ...(phaseIdx >= 3 ? byPhase.PROGRESSION : []),
      ];
      const seen = new Set<string>();
      const unique = phasePool.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
      return { unique, scheduledFor };
    });

    const c = await tx.clinicalCase.create({
      data: {
        tenantId: actor.tenantId,
        authorId: actor.practitionerId,
        patientId: input.patientId,
        selectedZones: input.selection.regions,
        refinements: {
          symptoms: input.selection.symptoms,
          triggers: input.selection.triggers,
          phase: input.selection.phase,
          intensity: input.selection.intensity,
        },
      },
    });

    for (let i = 0; i < ranked.length; i++) {
      const r = ranked[i];
      await tx.diagnosis.create({
        data: {
          caseId: c.id,
          conditionId: r.conditionId,
          matchScore: r.matchScore,
          confirmed: r.slug === input.conditionSlug,
          rank: i + 1,
        },
      });
    }

    const program = await tx.treatmentProgram.create({
      data: {
        tenantId: actor.tenantId,
        patientId: input.patientId,
        caseId: c.id,
        title: input.programTitle ?? `Plan ${condition.name}`,
        totalSessions: N,
        frequency: input.frequency,
        startDate,
        status: ProgramStatus.ACTIVE,
        sessions: {
          create: sessionsData.map((s, i) => ({
            practitionerId: actor.practitionerId,
            index: i + 1,
            scheduledFor: s.scheduledFor,
            exercises: {
              create: s.unique.map((ex, order) => ({
                exerciseId: ex.id,
                order: order + 1,
                // Dosis opcional en Exercise: el plan arranca en 3×12.
                sets: ex.defaultSets ?? 3,
                reps: ex.defaultReps ?? 12,
              })),
            },
          })),
        },
      },
    });

    // Payload sin PHI (C8): ids, no el nombre del diagnóstico.
    await auditInTx(tx, {
      tenantId: actor.tenantId,
      actorId: actor.userId ?? undefined,
      action: "diagnosis.assign",
      entity: "ClinicalCase",
      entityId: c.id,
      payload: {
        conditionId: condition.id,
        programId: program.id,
        totalSessions: N,
        exerciseCount: exercises.length,
      },
    });

    return { ok: true as const, data: { caseId: c.id, programId: program.id } };
  });

  if (!outcome.ok) return outcome;

  revalidatePath("/diagnostico");
  revalidatePath(`/pacientes/${input.patientId}`);
  revalidatePath("/pacientes");
  revalidatePath("/dashboard");

  return outcome;
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
 */
export async function searchPatientsForAssignment(q: string) {
  const actor = await getActor();
  const v = await visibilityForActor(actor);
  if (v.adminView) return [];
  const term = q.trim();
  const where = {
    tenantId: actor.tenantId,
    ...v.patientWhere,
    ...(v.seesAll
      ? {}
      : {
          AND: [
            {
              OR: [
                { assignedPractitionerId: actor.practitionerId },
                { shares: { some: { practitionerId: actor.practitionerId } } },
              ],
            },
          ],
        }),
    ...(term
      ? {
          OR: [
            { firstName: { contains: term, mode: "insensitive" as const } },
            { lastName: { contains: term, mode: "insensitive" as const } },
            { documentId: { contains: term, mode: "insensitive" as const } },
            { email: { contains: term, mode: "insensitive" as const } },
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
