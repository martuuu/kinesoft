/**
 * Diagnosis types re-exported from the pure engine for ergonomic
 * importing. Kept separate from `lib/diagnosis.ts` (which is "use server"
 * and shouldn't pull non-async runtime exports).
 */
import type { ProgramPhase } from "@prisma/client";
import type { CaseSelection, Ranking, RampStep } from "@/lib/diagnosis-engine";
import type { CreatePlanResult, PlanCreateInput } from "@/lib/plans-types";

export type {
  CaseSelection,
  CatalogConditionDTO,
  CatalogDTO,
  ChipChoice,
  Ranking,
  RampExercise,
  RampStep,
  RegionDTO,
} from "@/lib/diagnosis-engine";

// ──────────────────────────────────────────────────────────────────────
// Puerta Diagnóstico → Plan (S17d, ES2b P2.2)
// ──────────────────────────────────────────────────────────────────────

/** Entrada de `getDiagnosisPlanPrefill`. Sin `exerciseIds` = los de la condición. */
export type DiagnosisPlanPrefillInput = {
  conditionSlug: string;
  exerciseIds?: string[];
  /** Cantidad para la que se arma la rampa de ejemplo (default 10, tope 60). */
  totalSessions?: number;
};

export type DiagnosisPrefillExercise = {
  exerciseId: string;
  name: string;
  /** Fase del vínculo condición↔ejercicio (sin vínculo = ACTIVATION). */
  phase: ProgramPhase;
  /** Dosis inicial: la del ejercicio o 3×12 (C8 · `?? 3/12`). */
  sets: number;
  reps: number;
};

/**
 * Prefill del editor de planes desde Diagnóstico (C10 `diagnosis?`). Solo
 * catálogo (condición + ejercicios asignables): nada del paciente. La rampa
 * se recalcula en el cliente con `diagnosisRamp` / `diagnosisRampSteps`
 * (`lib/diagnosis-engine.ts`, puro) si cambia la cantidad.
 */
export type DiagnosisPlanPrefill = {
  conditionSlug: string;
  conditionName: string;
  discipline: "KINESIOLOGY";
  title: string;
  totalSessions: number;
  /** Ordenados por fase (el orden en que se escriben en cada sesión). */
  exercises: DiagnosisPrefillExercise[];
  ramp: RampStep[];
};

export type DiagnosisPlanPrefillResult =
  | { ok: true; data: DiagnosisPlanPrefill }
  | { ok: false; error: string };

/**
 * Entrada de `createPlanFromDiagnosis`: el MISMO borrador que `createPlan`
 * (`plan`, con `stateToken` del `previewPlan` y las resoluciones elegidas;
 * al menos un ejercicio) + el caso clínico (`diagnosis`). El borrador no se
 * toca en el server (el `stateToken` lo cubre entero): la rampa se aplica
 * después de escribir, sobre los mismos ejercicios.
 */
export type CreatePlanFromDiagnosisInput = {
  plan: PlanCreateInput;
  diagnosis: {
    conditionSlug: string;
    selection: CaseSelection;
  };
};

export type CreatePlanFromDiagnosisResult =
  | { ok: true; programId: string; caseId: string | null; idempotent: boolean }
  | Exclude<CreatePlanResult, { ok: true }>;

export type AssignInput = {
  patientId: string;
  conditionSlug: string;
  selection: CaseSelection;
  topRankings: Ranking[];
  exerciseIds: string[];
  totalSessions: number;
  frequency: number;
  startDate: string;
  programTitle?: string;
  /**
   * Días de la semana elegidos en el wizard, 0=Lun … 6=Dom (la convención de
   * `expandDates`, no la de `Date#getDay`). Opcional y aditivo (P0-Ck). Con
   * días, `assignDiagnosisAndCreateProgram` genera las sesiones solo esos días
   * AR (`expandDates` weekly, a las 00:00 AR; S02d); sin días (o vacío) reparte
   * por `frequency` desde `startDate`, como antes.
   */
  daysOfWeek?: number[];
};
