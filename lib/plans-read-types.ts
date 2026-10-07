/**
 * Lecturas de Planes (S14, ES2b · P2.0): DTOs, zod de entrada y copy.
 *
 * Puro (sin `server-only`, no es `"use server"`): lo importan las actions de
 * `lib/plans-read.ts` (que solo pueden exportar funciones async), la proyección
 * server-only de `lib/plans-read-internal.ts` y la UI de ES3 (PlanCard,
 * `/planes`, modal de agenda).
 *
 * Dos niveles de lectura (PLANES.md §5 "Lecturas"), y por qué los DTOs son
 * explícitos campo por campo en vez de "la fila de Prisma menos lo clínico":
 *   - `full` (acceso full **y** `clinical.read`): el DTO completo.
 *   - `admin` (la Secretaria con `plans.schedule` + `agenda.operateAll`, o
 *     Facturación con `billing.manage`): la proyección administrativa —
 *     ordinal, disciplina, "sin turno", saldo— con título null y SIN notas,
 *     ejercicios, EVA ni cuotas por sesión.
 *   Con una lista negra, una columna nueva de M2+ (p. ej. otra nota clínica)
 *   saldría sola en la proyección admin. Con DTOs armados a mano, una columna
 *   nueva no sale hasta que alguien la agrega acá a propósito.
 *
 * La autorización de la OS (E2) es la propiedad OPCIONAL `authorization`: la
 * clave directamente NO EXISTE en el objeto si el actor no la puede ver
 * (`canSeePlanAuthorization`), y nunca aparece en `PlanListRow` ni en
 * `SchedulablePlanSession` (que alimentan la agenda y `/planes`).
 */
import { z } from "zod";
import type { Discipline } from "@/lib/plans-constants";
import type { PlanBalance } from "@/lib/plan-pricing";
import type { PlanScheduleV1 } from "@/lib/plans-types";
import type { DayKey } from "@/lib/availability/types";

export type { PlanBalance } from "@/lib/plan-pricing";

// ─── Resultado común ─────────────────────────────────────────────────────────

/**
 * Las lecturas devuelven un resultado en vez de tirar: un `throw` en una
 * server action llega al cliente como un error genérico (en prod Next oculta el
 * mensaje) y la UI no puede distinguir "sin permiso" de "se cayó la base".
 */
export type PlanReadResult<T> = { ok: true; data: T } | { ok: false; error: string };

export const PLAN_READ_COPY = {
  forbidden: "No tenés permiso para ver los planes de este paciente.",
  notFound: "No encontramos ese plan.",
  invalid: "Datos inválidos.",
} as const;

// ─── Niveles ─────────────────────────────────────────────────────────────────

export type PlanReadLevel = "full" | "admin";

export type ProgramStatusValue = "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED";
export type PlanPricingModeValue = "PER_SESSION" | "PACKAGE";
export type PlanBookingStatusValue = "PENDING" | "CONFIRMED" | "CANCELLED" | "NO_SHOW" | "COMPLETED";

/**
 * Estado de una sesión en la PlanCard (C13 · "Realizada ✓ / Con turno / Sin
 * turno / Vencida sin cerrar / Archivada"):
 *   - `done`: `completedAt` no nulo.
 *   - `booked`: tiene turno activo (≠ CANCELLED/NO_SHOW) en el futuro.
 *   - `overdue`: tiene turno activo cuyo horario ya pasó y la sesión no se
 *     cerró ("Vencida sin cerrar": falta la evolución o el Atendido).
 *   - `unbooked`: viva, sin cerrar y sin turno activo ("Sin turno", C4: se
 *     DERIVA, `sessionWithoutActiveBookingWhere`).
 *   - `archived`: archivada (la UI la oculta; sin ordinal).
 */
export type PlanSessionState = "done" | "booked" | "overdue" | "unbooked" | "archived";

/** El turno activo de una sesión (el que la ocupa, I2). Sin título ni notas del turno. */
export type PlanSessionBookingRef = {
  id: string;
  scheduledFor: Date;
  status: PlanBookingStatusValue;
  /** Optimistic lock (`expectedUpdatedAt`) para mover/cancelar desde la card. */
  updatedAt: Date;
};

export type PlanSessionDTO = {
  id: string;
  /** `index` fijo (M13): no se muestra; el que se muestra es `ordinal`. */
  index: number;
  /** Ordinal por fecha entre las vivas (M13). `null` = archivada. */
  ordinal: number | null;
  state: PlanSessionState;
  /**
   * "Sin turno" de C4 + R-LEGACY: `state === 'unbooked'` **y** plan vinculado.
   * En un legacy siempre `false` (no se agenda hasta "Completar datos").
   */
  sinTurno: boolean;
  /** Fecha planificada (o la del turno activo, I3). */
  scheduledFor: Date;
  completedAt: Date | null;
  archivedAt: Date | null;
  booking: PlanSessionBookingRef | null;
  // Solo `full` (en `admin` van en null): son datos clínicos o plata por sesión.
  title: string | null;
  notes: string | null;
  priceCents: number | null;
  exerciseCount: number | null;
};

/**
 * Autorización VIGENTE de la OS (E2, §2.6). Fechas `@db.Date` leídas con
 * `dbDateToDayKey` (slice UTC: es una etiqueta de día, no un instante).
 *   - `used` = sesiones realizadas con fecha AR ≥ `startsOn`.
 *   - `scheduled` = sesiones vivas sin cerrar con turno activo con fecha AR ≥
 *     `startsOn` (las que van a consumir la orden).
 */
export type PlanAuthorizationDTO = {
  id: string;
  code: string | null;
  authorizedSessions: number | null;
  startsOn: DayKey;
  expiresOn: DayKey | null;
  used: number;
  scheduled: number;
};

/**
 * Saldo P7 agregado en el server (`planBalance` puro de `lib/plan-pricing.ts`)
 * + `insurerPaidBookings`.
 *
 * Decisión S14 sobre `insurerPaidAt` (handoff de ES1): el saldo del plan es
 * plata del PACIENTE (cuota/copago); lo que paga la obra social es el arancel
 * del prestador, otro concepto con otro circuito (Facturación → liquidación).
 * Por eso `insurerPaidAt` NO suma en `collectedCents` (no se mezclan) y se
 * informa aparte como CANTIDAD de turnos del plan con la OS pagada (sin monto:
 * el arancel no es una columna del turno y no hay cifra honesta que mostrar).
 * Caso borde que queda documentado: un turno CANCELLED/NO_SHOW con la OS pagada
 * hace que el reemplazo se estampe en $0 (`bookingWasCollected`), pero su cuota
 * sigue en "devengado" y puede aparecer como pendiente. Va con el resto de
 * AUDIT:940 (`insurerPaidAt`) a C0.
 */
export type PlanBalanceDTO = PlanBalance & {
  /** Turnos del plan (cualquier estado) con `insurerPaidAt`: solo informativo. */
  insurerPaidBookings: number;
};

/** Próxima sesión con turno activo en el futuro (o `null`). */
export type PlanNextSession = { sessionId: string; ordinal: number; at: Date };

/** Lo común a la PlanCard y a la fila de `/planes`. */
export type PlanHeaderDTO = {
  id: string;
  patientId: string;
  level: PlanReadLevel;
  discipline: Discipline | null;
  status: ProgramStatusValue;
  archivedAt: Date | null;
  /** R-LEGACY: `schedule` no nulo o algún turno con `programId`. */
  linked: boolean;
  /** `planTitleFor`: null sin `clinical.read` + full. */
  title: string | null;
  practitionerId: string | null;
  practitionerName: string | null;
  serviceId: string | null;
  serviceName: string | null;
  locationId: string | null;
  /** Sesiones vivas (no archivadas): el N de "Sesión n de N". */
  totalLive: number;
  /** Realizadas entre las vivas. */
  done: number;
  /** Sesiones "sin turno" (C4 + R-LEGACY; 0 en un legacy). */
  sinTurno: number;
  nextSession: PlanNextSession | null;
  updatedAt: Date;
  createdAt: Date;
};

export type PlanDTO = PlanHeaderDTO & {
  /** Solo `full`. */
  notes: string | null;
  pricingMode: PlanPricingModeValue | null;
  balance: PlanBalanceDTO;
  sessions: PlanSessionDTO[];
  /** E2: la clave NO existe si el actor no puede ver la autorización. `null` = no hay vigente. */
  authorization?: PlanAuthorizationDTO | null;
};

/** `getPlanDetail` (solo `full`): el plan con lo que el editor y la card necesitan. */
export type PlanDetailDTO = PlanDTO & {
  schedule: PlanScheduleV1 | null;
  durationMin: number | null;
  templateId: string | null;
  pricePerSessionCents: number | null;
  totalPriceCents: number | null;
};

/** Fila de `/planes/[disciplina]` (S21). Sin autorización de la OS (E2). */
export type PlanListRow = PlanHeaderDTO & { patientName: string };

export type PlanListResult = {
  rows: PlanListRow[];
  /** `true` = había más planes que el tope (`PLAN_LIST_MAX`) y la lista quedó cortada. */
  truncated: boolean;
};

/** Saldo de un plan del paciente (`getPatientPlanBalances`). */
export type PatientPlanBalanceRow = {
  programId: string;
  discipline: Discipline | null;
  status: ProgramStatusValue;
  title: string | null;
  balance: PlanBalanceDTO;
};

export type PatientPlanBalances = {
  plans: PatientPlanBalanceRow[];
  /** Σ de TODOS los planes del paciente, incluidos cancelados y archivados: un
   *  plan cancelado que todavía debe (o tiene plata a favor) tiene que sumar en
   *  el "Pendiente" de Facturación (S22f). Pendiente y a favor ya recortados por plan. */
  totals: { pendingCents: number; creditCents: number; collectedCents: number; inProcessCents: number };
};

/**
 * `listSchedulablePlanSessions` (E1): ALLOWLIST literal de §10 S14. Sin
 * títulos, notas, ejercicios, precios ni autorización: lo consume el modal de
 * agenda de la Secretaria.
 */
export type SchedulablePlanSession = {
  sessionId: string;
  /** ES3 (S19c/S21): el plan de la sesión. Un id, no PHI; sin él la UI
   *  adivinaba el plan por disciplina + total y elegía mal con 2 planes de la
   *  misma disciplina. El server igual valida sesión ↔ plan al agendar. */
  programId: string;
  ordinal: number;
  totalLive: number;
  discipline: Discipline | null;
  serviceId: string | null;
  practitionerId: string | null;
  locationId: string | null;
  sinTurno: boolean;
};

/** Evento del historial del plan (`getPlanHistory`). El payload va por allowlist. */
export type PlanHistoryEvent = {
  id: string;
  at: Date;
  action: string;
  entity: string;
  entityId: string | null;
  actorId: string | null;
  actorName: string | null;
  /** Solo claves no clínicas (`from`, `to`, `auto`, `index`, `fields`). */
  detail: Record<string, string | number | boolean | string[] | null>;
};

export type PlanAuthorizationHistoryRow = Omit<PlanAuthorizationDTO, "used" | "scheduled"> & {
  createdAt: Date;
  supersededAt: Date | null;
};

export type PlanHistory = {
  events: PlanHistoryEvent[];
  /** E2: la clave NO existe si el actor no puede ver la autorización. */
  authorizations?: PlanAuthorizationHistoryRow[];
};

// ─── Entradas (zod) ──────────────────────────────────────────────────────────

const Id = z.string().trim().min(1).max(64);

export const PLAN_LIST_MAX = 500;
export const PLAN_HISTORY_MAX = 200;

export const ListPlansInput = z
  .object({
    discipline: z.enum(["KINESIOLOGY", "OSTEOPATHY"]).optional(),
    /** Default: ACTIVE y PAUSED (los que se siguen). */
    statuses: z.array(z.enum(["ACTIVE", "PAUSED", "COMPLETED", "CANCELLED"])).min(1).max(4).optional(),
    practitionerId: Id.optional(),
    /** Solo planes con alguna sesión "sin turno" (filtro de S21). */
    onlyWithSinTurno: z.boolean().optional(),
    includeArchived: z.boolean().optional(),
  })
  .strict();
export type ListPlansInputT = z.input<typeof ListPlansInput>;

export const PatientPlansInput = z
  .object({ patientId: Id, includeArchived: z.boolean().optional() })
  .strict();
export type PatientPlansInputT = z.input<typeof PatientPlansInput>;

export const PlanIdInput = z.object({ programId: Id }).strict();
export type PlanIdInputT = z.input<typeof PlanIdInput>;

export const PatientIdInput = z.object({ patientId: Id }).strict();
export type PatientIdInputT = z.input<typeof PatientIdInput>;
