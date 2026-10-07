/**
 * Tipos de Planes (P2-C1, ES2b) — contrato C7 de `.docs/PLANES.md` §4.
 *
 * NO define tipos propios del motor: RE-EXPORTA los puros que publicó S07p en
 * ES1 (`lib/availability/plan.ts`). Hay una sola fuente: si los redefiniéramos
 * acá, un cambio del motor podría compilar contra una copia vieja y el editor
 * (UI) y el commit (server) terminarían hablando dos dialectos distintos del
 * mismo `PlanCreateInput`.
 *
 * Puro (sin `server-only`): lo importan las actions finas, el motor
 * server-only y la UI del editor. Los zod de estos tipos viven en
 * `lib/plans-schemas.ts`.
 */
export type {
  PlanScheduleSlot,
  PlanScheduleV1,
  PlanResolutionKind,
  PlanForceFlags,
  PlanRowResolution,
  PlanRowFlags,
  PlanAuthorizationInput,
  PlanPricingInput,
  PlanCreateInput,
  PlanPreviewRow,
  PlanPreviewSummary,
  PlanPreview,
  CreatePlanResult,
  PlanRowClass,
  PlanRowClassification,
  PlanRowStaleReason,
  PlanAvailabilityBooking,
  PlanClassifyRow,
  ClassifyPlanRowsInput,
  PlanExpandedRow,
  ExpandPlanDatesInput,
} from "@/lib/availability/plan";

export type { Discipline } from "@/lib/plans-constants";
export type { LinkedPlanDiscipline } from "@/lib/plan-display";
