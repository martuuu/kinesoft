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
 * Re-exports the engine types so existing imports keep working.
 */
import { revalidatePath } from "next/cache";
import { ProgramPhase, ProgramStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getActor } from "@/lib/session";
import { audit } from "@/lib/audit";
import { gatingForActor } from "@/lib/plan-gating";
import { visibilityForActor } from "@/lib/visibility";
import type { ActionResult } from "@/lib/validation";
import { rankSelection } from "@/lib/diagnosis-engine";
import type {
  AssignInput,
  CaseSelection,
  CatalogDTO,
  Ranking,
} from "@/lib/diagnosis-types";

// ──────────────────────────────────────────────────────────────────────
// Catalog loader
// ──────────────────────────────────────────────────────────────────────

export async function loadCatalog(): Promise<CatalogDTO> {
  const gate = await gatingForActor();
  const [regions, conditions, symptoms, triggers, phases] = await Promise.all([
    prisma.anatomicalRegion.findMany({ orderBy: [{ view: "asc" }, { sortOrder: "asc" }] }),
    prisma.condition.findMany({
      include: {
        tags: { include: { tag: true } },
        anatomy: true,
        // Filter included exercises by the tenant's plan — FREE/STARTER
        // tenants only see basic + own private exercises through the
        // diagnosis suggestions.
        exercises: {
          where: { exercise: gate.visibility },
          include: { exercise: true },
        },
      },
    }),
    prisma.tag.findMany({ where: { kind: "SYMPTOM" }, orderBy: { label: "asc" } }),
    prisma.tag.findMany({ where: { kind: "TRIGGER" }, orderBy: { label: "asc" } }),
    prisma.tag.findMany({ where: { kind: "PHASE" }, orderBy: { label: "asc" } }),
  ]);

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
        defaultSets: l.exercise.defaultSets,
        defaultReps: l.exercise.defaultReps,
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


/**
 * Writes ClinicalCase → top-N Diagnosis → TreatmentProgram → N Sessions →
 * SessionExercises in a single transaction. Re-ranks server-side so the
 * persisted match scores are authoritative.
 */
export async function assignDiagnosisAndCreateProgram(
  input: AssignInput
): Promise<ActionResult<{ caseId: string; programId: string }>> {
  const actor = await getActor();

  if (!input.patientId) return { ok: false, error: "Elegí un paciente." };
  if (!input.conditionSlug) return { ok: false, error: "Elegí un diagnóstico." };
  if (!input.exerciseIds.length)
    return { ok: false, error: "El plan necesita al menos un ejercicio." };
  if (input.totalSessions < 1 || input.totalSessions > 64)
    return { ok: false, error: "Las sesiones deben estar entre 1 y 64." };
  if (input.frequency < 1 || input.frequency > 7)
    return { ok: false, error: "La frecuencia debe estar entre 1 y 7 por semana." };

  const owned = await prisma.patient.findFirst({
    where: { id: input.patientId, tenantId: actor.tenantId },
    select: { id: true },
  });
  if (!owned) return { ok: false, error: "Paciente fuera del tenant." };

  const condition = await prisma.condition.findUnique({
    where: { slug: input.conditionSlug },
    select: { id: true, name: true },
  });
  if (!condition) return { ok: false, error: "Diagnóstico desconocido." };

  // Re-rank server-side as the authoritative source for persisted scores.
  const catalog = await loadCatalog();
  const ranked = rankSelection(input.selection, catalog).slice(0, 4);

  const exercises = await prisma.exercise.findMany({
    where: { id: { in: input.exerciseIds } },
    include: { conditions: { where: { conditionId: condition.id } } },
  });
  if (exercises.length === 0) return { ok: false, error: "Ejercicios inválidos." };

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

  const startDate = new Date(input.startDate);
  if (Number.isNaN(startDate.getTime())) return { ok: false, error: "Fecha inválida." };

  const N = input.totalSessions;
  const sessionsData = Array.from({ length: N }).map((_, i) => {
    const phaseIdx = Math.min(3, Math.floor((i / N) * 4));
    const phasePool = [
      ...byPhase.ACTIVATION,
      ...(phaseIdx >= 1 ? byPhase.STABILITY : []),
      ...(phaseIdx >= 2 ? byPhase.LOAD : []),
      ...(phaseIdx >= 3 ? byPhase.PROGRESSION : []),
    ];
    const seen = new Set<string>();
    const unique = phasePool.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
    const scheduledFor = new Date(startDate);
    scheduledFor.setDate(scheduledFor.getDate() + Math.floor((i * 7) / input.frequency));
    return { unique, scheduledFor };
  });

  const result = await prisma.$transaction(async (tx) => {
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
        totalSessions: input.totalSessions,
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
                sets: ex.defaultSets,
                reps: ex.defaultReps,
              })),
            },
          })),
        },
      },
    });

    return { caseId: c.id, programId: program.id };
  });

  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "diagnosis.assign",
    entity: "ClinicalCase",
    entityId: result.caseId,
    payload: {
      condition: condition.name,
      programId: result.programId,
      totalSessions: input.totalSessions,
      exerciseCount: exercises.length,
    },
  });

  revalidatePath("/diagnostico");
  revalidatePath(`/pacientes/${input.patientId}`);
  revalidatePath("/pacientes");
  revalidatePath("/dashboard");

  return { ok: true, data: result };
}

// ──────────────────────────────────────────────────────────────────────
// Plan Builder — patient picker
// ──────────────────────────────────────────────────────────────────────

export async function searchPatientsForAssignment(q: string) {
  const actor = await getActor();
  const v = await visibilityForActor(actor);
  const term = q.trim();
  const where = {
    tenantId: actor.tenantId,
    ...v.patientWhere,
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
  const rows = await prisma.patient.findMany({
    where,
    take: 12,
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    select: {
      id: true,
      firstName: true,
      lastName: true,
      dateOfBirth: true,
      documentId: true,
      programs: { where: { status: "ACTIVE" }, take: 1, select: { id: true } },
    },
  });
  return rows.map((p) => ({
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

/**
 * Save the current selections as a patient-agnostic draft case. The
 * practitioner can later open it from the patient profile + click
 * "Asignar" to materialise the program.
 */
export async function saveDiagnosisDraft(input: {
  conditionSlug?: string;
  selection: CaseSelection;
  topRankings: Ranking[];
  notes?: string;
}): Promise<ActionResult<{ caseId: string }>> {
  const actor = await getActor();
  const caseRow = await prisma.clinicalCase.create({
    data: {
      tenantId: actor.tenantId,
      authorId: actor.practitionerId,
      patientId: null,
      selectedZones: input.selection.regions,
      refinements: {
        symptoms: input.selection.symptoms,
        triggers: input.selection.triggers,
        phase: input.selection.phase,
        intensity: input.selection.intensity,
      },
      notes: input.notes ?? null,
      diagnoses: {
        create: input.topRankings.slice(0, 4).map((r, i) => ({
          conditionId: r.conditionId,
          matchScore: r.matchScore,
          confirmed: r.slug === input.conditionSlug,
          rank: i + 1,
        })),
      },
    },
  });
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "diagnosis.draft.create",
    entity: "ClinicalCase",
    entityId: caseRow.id,
  });
  revalidatePath("/diagnostico");
  return { ok: true, data: { caseId: caseRow.id } };
}
