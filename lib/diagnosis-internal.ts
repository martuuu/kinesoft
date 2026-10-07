import "server-only";

/**
 * Puerta Diagnóstico → Plan, server-only (S17d, ES2b P2.2). Lo usan las
 * actions de `lib/diagnosis.ts` (un "use server" solo exporta async, AUDIT
 * §5.12): zod de la entrada, el hook `clinicalCase` del motor, la carga de
 * fases de los ejercicios y la escritura de la rampa.
 *
 * Por qué la rampa se aplica DESPUÉS de `createPlanInTx` y no pasándole al
 * motor una lista por sesión: el motor escribe la MISMA lista en cada sesión
 * (plantilla = misma lista, PQ-12) y su `stateToken` cubre el borrador entero
 * (incluido el orden de `exercises`), así que el server no puede tocar el
 * input sin que el commit dé "stale". Se le pasa el borrador tal cual (el
 * motor valida los ejercicios asignables con el resto de las refs) y, en la
 * MISMA tx, se reescriben los `SessionExercise` del plan recién creado con la
 * rampa (subconjunto de los ya validados). Cambiar la firma del motor iría
 * por handoff (C8: S17d solo consume).
 */
import { z } from "zod";
import type { ProgramPhase } from "@prisma/client";
import type { DbClient } from "@/lib/rls";
import type { Actor } from "@/lib/session";
import { PlanCreateInputSchema } from "@/lib/plans-schemas";
import { PLAN_MAX_SESSIONS } from "@/lib/plans-constants";
import { assignableExerciseWhere, gatingForActor } from "@/lib/plan-gating";
import { RAMP_PHASES, diagnosisRamp, type Ranking } from "@/lib/diagnosis-engine";

export const DIAGNOSIS_COPY = {
  noExercises: "El plan necesita al menos un ejercicio.",
  unknownCondition: "Diagnóstico desconocido.",
  exercises: "Hay ejercicios que no están disponibles en tu plan o fueron archivados.",
} as const;

/** Dosis por defecto del alta (C8 · `?? 3/12`). */
export const DEFAULT_SETS = 3;
export const DEFAULT_REPS = 12;

/** Total de sesiones de la rampa de ejemplo del prefill (el modal viejo arrancaba en 10). */
export const PREFILL_DEFAULT_SESSIONS = 10;

const Slug = z.string().trim().min(1).max(120);
const SlugList = z.array(z.string().trim().min(1).max(120)).max(200);

/** `CaseSelection` (lib/diagnosis-engine.ts). Se persiste en `ClinicalCase` (Json): con topes. */
export const CaseSelectionSchema = z
  .object({
    regions: SlugList,
    symptoms: SlugList,
    triggers: SlugList,
    phase: z.string().trim().min(1).max(120).nullable(),
    intensity: z.number().min(0).max(10),
  })
  .strict();

/**
 * `createPlanFromDiagnosis`: el borrador de `createPlan` (mismo zod, mismas
 * reglas) + el caso. Regla de la puerta: ≥ 1 ejercicio (el alta vieja la
 * tenía; la rampa no tiene sentido sin ejercicios).
 */
export const CreatePlanFromDiagnosisSchema = z
  .object({
    plan: PlanCreateInputSchema,
    diagnosis: z.object({ conditionSlug: Slug, selection: CaseSelectionSchema }).strict(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.plan.exercises?.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["plan", "exercises"], message: DIAGNOSIS_COPY.noExercises });
    }
  });

export const DiagnosisPlanPrefillInputSchema = z
  .object({
    conditionSlug: Slug,
    exerciseIds: z.array(z.string().min(1).max(64)).max(100).optional(),
    totalSessions: z.number().int().min(1).max(PLAN_MAX_SESSIONS).optional(),
  })
  .strict();

/** Condición global o del tenant, filtrada a mano (`Condition.slug` es único global y prod es BYPASSRLS). */
export async function findConditionInTx(
  tx: DbClient,
  tenantId: string,
  slug: string
): Promise<{ id: string; name: string } | null> {
  return tx.condition.findFirst({
    where: { slug, OR: [{ tenantId: null }, { tenantId }] },
    select: { id: true, name: true },
  });
}

const PHASE_RANK = new Map<ProgramPhase, number>(RAMP_PHASES.map((p, i) => [p, i]));

/** La fase más temprana de los vínculos (un ejercicio puede tener uno por relación); sin vínculo = ACTIVATION. */
function earliestPhase(links: ReadonlyArray<{ phase: ProgramPhase }>): ProgramPhase {
  let best: ProgramPhase = links[0]?.phase ?? "ACTIVATION";
  for (const l of links) if (PHASE_RANK.get(l.phase)! < PHASE_RANK.get(best)!) best = l.phase;
  return best;
}

export type PhasedExercise = {
  exerciseId: string;
  name: string;
  phase: ProgramPhase;
  defaultSets: number | null;
  defaultReps: number | null;
};

/**
 * Ejercicios pedidos, con su fase para la condición, SOLO si todos son
 * asignables (`assignableExerciseWhere` con el plan del tenant leído en ESTA
 * tx: un cambio de plan concurrente se ve en la misma foto que la
 * escritura). Si falta cualquiera devuelve `null` (rechazo total: con uno
 * válido al lado no se cuela un ajeno / PRO en FREE / archivado, S02d).
 * Respeta el orden de `ids`.
 */
export async function loadPhasedExercisesInTx(
  tx: DbClient,
  conditionId: string,
  ids: ReadonlyArray<string>
): Promise<PhasedExercise[] | null> {
  const unique = Array.from(new Set(ids));
  if (!unique.length) return [];
  const gate = await gatingForActor(tx);
  const rows = await tx.exercise.findMany({
    where: { AND: [{ id: { in: unique } }, assignableExerciseWhere(gate)] },
    select: {
      id: true,
      name: true,
      defaultSets: true,
      defaultReps: true,
      conditions: { where: { conditionId }, select: { phase: true } },
    },
  });
  if (rows.length !== unique.length) return null;
  const byId = new Map(rows.map((r) => [r.id, r]));
  return unique.map((id) => {
    const r = byId.get(id)!;
    return {
      exerciseId: r.id,
      name: r.name,
      phase: earliestPhase(r.conditions),
      defaultSets: r.defaultSets,
      defaultReps: r.defaultReps,
    };
  });
}

/**
 * Ejercicios sugeridos para la condición (sin elección del profesional):
 * los vínculos asignables, en el orden de `exercisesFor` (DIRECT → INDIRECT,
 * fase, peso) y con la fase más temprana por ejercicio.
 */
export async function loadConditionExercisesInTx(tx: DbClient, conditionId: string): Promise<PhasedExercise[]> {
  const gate = await gatingForActor(tx);
  const links = await tx.conditionExerciseLink.findMany({
    where: { conditionId, exercise: assignableExerciseWhere(gate) },
    select: {
      relation: true,
      phase: true,
      weight: true,
      exercise: { select: { id: true, name: true, defaultSets: true, defaultReps: true } },
    },
  });
  const RELATION = { DIRECT: 0, INDIRECT: 1, ANTAGONIST: 2, PREVENTIVE: 3 } as const;
  links.sort(
    (a, b) =>
      RELATION[a.relation] - RELATION[b.relation] ||
      PHASE_RANK.get(a.phase)! - PHASE_RANK.get(b.phase)! ||
      b.weight - a.weight ||
      a.exercise.id.localeCompare(b.exercise.id)
  );
  const out = new Map<string, PhasedExercise>();
  for (const l of links) {
    const prev = out.get(l.exercise.id);
    if (prev) {
      if (PHASE_RANK.get(l.phase)! < PHASE_RANK.get(prev.phase)!) prev.phase = l.phase;
      continue;
    }
    out.set(l.exercise.id, {
      exerciseId: l.exercise.id,
      name: l.exercise.name,
      phase: l.phase,
      defaultSets: l.exercise.defaultSets,
      defaultReps: l.exercise.defaultReps,
    });
  }
  return Array.from(out.values()).slice(0, 100);
}

/**
 * Hook `clinicalCase` de `createPlanInTx`: corre DENTRO de la tx del alta,
 * después de los locks y de la re-clasificación (un stale no llega acá y, si
 * algo tira después, el rollback se lo lleva). Crea el ClinicalCase y los
 * Diagnosis rankeados (top 4 del ranking del server, `confirmed` = el elegido).
 *
 * Decisión S17d: si la condición confirmada no está en el top 4 (p. ej. una
 * custom del tenant, que no participa del matching), se agrega igual como
 * fila confirmada al final con su score (0 si no rankeó): antes el caso
 * quedaba sin ningún Diagnosis confirmado.
 */
export function clinicalCaseHook(o: {
  actor: Actor;
  patientId: string;
  condition: { id: string };
  ranked: ReadonlyArray<Ranking>;
  selection: z.output<typeof CaseSelectionSchema>;
}): (tx: DbClient) => Promise<string> {
  return async (tx) => {
    const c = await tx.clinicalCase.create({
      data: {
        tenantId: o.actor.tenantId,
        authorId: o.actor.practitionerId,
        patientId: o.patientId,
        selectedZones: o.selection.regions,
        refinements: {
          symptoms: o.selection.symptoms,
          triggers: o.selection.triggers,
          phase: o.selection.phase,
          intensity: o.selection.intensity,
        },
      },
      select: { id: true },
    });
    const top = o.ranked.slice(0, 4);
    const rows = top.map((r, i) => ({
      caseId: c.id,
      conditionId: r.conditionId,
      matchScore: r.matchScore,
      confirmed: r.conditionId === o.condition.id,
      rank: i + 1,
    }));
    if (!rows.some((r) => r.confirmed)) {
      const scored = o.ranked.find((r) => r.conditionId === o.condition.id);
      rows.push({
        caseId: c.id,
        conditionId: o.condition.id,
        matchScore: scored?.matchScore ?? 0,
        confirmed: true,
        rank: rows.length + 1,
      });
    }
    await tx.diagnosis.createMany({ data: rows });
    return c.id;
  };
}

/**
 * Reescribe los ejercicios de las sesiones del plan recién creado con la
 * rampa por fase (`diagnosisRamp`): la sesión k (por `index`) lleva los de
 * fase ≤ su escalón, ordenados por fase. Dosis = la del borrador. 3
 * sentencias fijas (sesiones, delete, createMany). `program: { tenantId }`:
 * Session no tiene tenantId propio.
 */
export async function applyDiagnosisRampInTx(
  tx: DbClient,
  o: {
    tenantId: string;
    programId: string;
    exercises: ReadonlyArray<{ exerciseId: string; phase: ProgramPhase; sets: number; reps: number }>;
  }
): Promise<void> {
  const sessions = await tx.session.findMany({
    where: { programId: o.programId, program: { tenantId: o.tenantId }, archivedAt: null },
    orderBy: { index: "asc" },
    select: { id: true },
  });
  if (!sessions.length) return;
  const ramp = diagnosisRamp(o.exercises, sessions.length);
  const ids = sessions.map((s) => s.id);
  await tx.sessionExercise.deleteMany({ where: { sessionId: { in: ids } } });
  const data = sessions.flatMap((s, i) =>
    ramp[i].map((e, k) => ({ sessionId: s.id, exerciseId: e.exerciseId, order: k + 1, sets: e.sets, reps: e.reps }))
  );
  if (data.length) await tx.sessionExercise.createMany({ data });
}
