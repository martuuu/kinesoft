import type { Discipline } from "@/lib/plans-constants";

export type OpenSessionRow = {
  id: string;
  index: number;
  scheduledFor: Date;
  completedAt: Date | null;
  patientId: string;
  patientName: string;
  programTitle: string;
  totalSessions: number;
  exerciseCount: number;
  doneCount: number;
  /**
   * P2-C2 (aditivo, opcional): "Sesión n de N" por ORDINAL entre las vivas
   * (M13, `planSessionOrdinals`), no por `index` ni `totalSessions`. S12b los
   * llena; ausentes = la UI sigue con `index`/`totalSessions` como hoy.
   */
  ordinal?: number;
  totalLive?: number;
};

/**
 * Landing de Seguimiento por buckets (A2a-S03). Antes era una sola query con
 * `take: 80` global ordenada por `completedAt asc`: con muchas realizadas, las
 * pendientes de hoy quedaban afuera del corte sin aviso. Ahora cada bucket es
 * su propia query con su propio tope y `total` real para decir "N de M".
 */
export type OpenSessionBucket = { rows: OpenSessionRow[]; total: number };

export type OpenSessionBuckets = {
  /** Programadas antes de hoy (día AR) y nunca cerradas, de planes ACTIVE. */
  overdue: OpenSessionBucket;
  today: OpenSessionBucket;
  upcoming: OpenSessionBucket;
  /** Cerradas en los últimos 14 días (planes no cancelados). */
  recent: OpenSessionBucket;
  /*
   * P2-C2 · buckets nuevos de S12b, OPCIONALES: hasta que S12b los llene, los
   * callers y la UI de hoy siguen compilando y mostrando los cuatro de arriba.
   */
  /**
   * "Sin turno" (C4): vivas, no realizadas, sin turno con `sessionId` y
   * `status ∉ {CANCELLED, NO_SHOW}` (`sessionWithoutActiveBookingWhere`), de
   * planes ACTIVE **vinculados** (R-LEGACY: un legacy no tiene turnos que
   * faltar) y no archivados.
   */
  sinTurno?: OpenSessionBucket;
  /** Realizadas sin evolución cargada (tag "Sin evolución" → "Cargar evolución"). */
  realizadasSinEvolucion?: OpenSessionBucket;
  /**
   * D22 / PQ-09: planes ACTIVE con todas sus sesiones vivas realizadas →
   * "Completó las 10 sesiones. ¿Le das el alta?". Se SUGIERE, nunca se
   * autocompleta.
   */
  suggestDischarge?: { rows: DischargeSuggestionRow[]; total: number };
};

/** Fila de "¿Le das el alta?" (D22). Solo para acceso `full` (lleva el título). */
export type DischargeSuggestionRow = {
  programId: string;
  patientId: string;
  patientName: string;
  programTitle: string;
  discipline: Discipline | null;
  /** Sesiones vivas (= realizadas, por definición de la sugerencia). */
  totalLive: number;
  /** Fecha de la última sesión realizada. */
  lastCompletedAt: Date;
};

/** Tope por bucket del landing. */
export const OPEN_SESSIONS_BUCKET_LIMIT = 100;

/** Resultado de reprogramar: el turno del paciente ese día AR, si hay, para linkear a la agenda. */
export type RescheduleSessionResult = {
  bookingOnDay: { id: string; scheduledFor: Date; dateKey: string } | null;
};

/** Resultado del cierre: `alreadyCompleted` = el cierre fue un no-op idempotente. */
export type CompleteSessionResult = {
  alreadyCompleted: boolean;
  programCompleted: boolean;
  /**
   * P2-C2 (aditivo, opcional) · D22: el cierre dejó todas las sesiones vivas
   * realizadas → la UI pregunta "¿Le das el alta?". Con D22, S12b deja de
   * autocompletar (`programCompleted` pasa a ser siempre false).
   */
  suggestDischarge?: boolean;
};
