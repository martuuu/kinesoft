import type { Discipline } from "@/lib/plans-constants";

export type ServiceRow = {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  durationMin: number;
  priceCents: number;
  practitionerId: string | null;
  practitionerName: string | null;
  /** Cupos simultáneos por horario; null = ilimitado. */
  maxConcurrent: number | null;
  bookingsCount: number;
  /** Práctica del catálogo global que representa (B1.4); null = servicio libre. */
  practiceId: string | null;
  practiceName: string | null;
  /** Planes M1 (D10): disciplina del servicio; null = sin disciplina. */
  discipline: Discipline | null;
  /**
   * S13 · PQ-11: disciplina que sugiere el catálogo por la práctica
   * (`suggestDisciplineFromSpecialties`). Solo se ofrece en la UI; nunca se
   * guarda sola. null = la práctica no la implica (o es ambigua).
   */
  suggestedDiscipline: Discipline | null;
};
