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
};
