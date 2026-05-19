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
};
