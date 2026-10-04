/**
 * Diagnosis types re-exported from the pure engine for ergonomic
 * importing. Kept separate from `lib/diagnosis.ts` (which is "use server"
 * and shouldn't pull non-async runtime exports).
 */
import type { CaseSelection, Ranking } from "@/lib/diagnosis-engine";

export type {
  CaseSelection,
  CatalogConditionDTO,
  CatalogDTO,
  ChipChoice,
  Ranking,
  RegionDTO,
} from "@/lib/diagnosis-engine";

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
