/**
 * Planes · contratos de P2.2 (P2-C2, ES2b · P2.2.0): inputs (zod) y
 * resultados de ciclo de vida (S15), mover y re-planificar (S16a), cantidad,
 * precio y autorización de la OS (S16b), y adopción / generar turnos (S25a).
 *
 * Puro (sin `server-only`, no es `"use server"`): las actions finas solo
 * pueden exportar funciones async, así que los zod y los tipos viven acá; la
 * UI de ES3 (PlanCard, diálogos D7, S22e) valida con los mismos schemas.
 *
 * Convención: `XxxSchema` = zod; `Xxx` = `z.input` (lo que manda el cliente,
 * el tipo del parámetro de la action); `XxxParsed` = `z.output`.
 *
 * Dos familias de escritura, y por qué el CAS es distinto:
 *   - **Por el motor** (generar, mover en serie, re-planificar, agregar
 *     sesiones): preview → commit. El commit manda `rows` (resoluciones de
 *     "Revisá los turnos") y `stateToken` del preview. El token de un plan
 *     existente ya incluye `program.updatedAt` (`programStateToken` de
 *     `plans-engine-internal`), así que ES el CAS del plan: si el plan cambió,
 *     `reclassifyOrThrowStaleInTx` tira `StalePlanPreview` y la action
 *     devuelve `{kind:'stale-preview', preview}`. No llevan
 *     `expectedUpdatedAt`: la Secretaria agenda desde el modal con
 *     `listSchedulablePlanSessions`, que no expone el `updatedAt` del plan.
 *   - **Sin motor** (estado, título y notas, archivar, restaurar, archivar
 *     sesiones, reprecio, vincular, adoptar serie): `expectedUpdatedAt` =
 *     `TreatmentProgram.updatedAt` ISO tal como lo mostró la UI; CAS al final
 *     de la tx (C2 (3)) → `{kind:'stale'}`. La renovación de la autorización
 *     usa `expectedCurrentId` (literal E2) y sacar del plan, el `updatedAt` del
 *     turno.
 *
 * Los ids son SOLO forma (como en `plans-schemas`): que el plan, la sesión o
 * el turno sean del tenant lo valida la action dentro de la tx con
 * `where {tenantId}` a mano (prod = BYPASSRLS).
 */
import { z } from "zod";
import {
  DayKeySchema,
  PlanEntityId,
  PlanPricingSchema,
  PlanRowResolutionSchema,
  PlanScheduleV1Schema,
} from "@/lib/plans-schemas";
import { PLAN_MAX_DURATION, PLAN_MAX_SESSIONS, PLAN_MIN_DURATION } from "@/lib/plans-constants";
import type { PlanPreview } from "@/lib/plans-types";
import {
  FUTURE_BOOKINGS_ACTIONS,
  PROGRAM_STATUSES,
  type FutureBookingsAction,
  type ProgramStatusValue,
} from "@/lib/plans-lifecycle-state";

export type { FutureBookingsAction, ProgramStatusValue };

// ─── Piezas ──────────────────────────────────────────────────────────────────

/** Instante ISO con zona (el `updatedAt` que mostró la UI, o un destino). */
const IsoInstant = z.string().datetime({ offset: true, message: "Fecha y hora inválidas" });

/** CAS del plan: `TreatmentProgram.updatedAt` ISO. */
const ExpectedUpdatedAt = IsoInstant;

/** Lista de ids sin repetidos (1..60, el tope de sesiones). */
const UniqueIds = z
  .array(PlanEntityId)
  .min(1, "Elegí al menos una sesión")
  .max(PLAN_MAX_SESSIONS)
  .refine((ids) => new Set(ids).size === ids.length, { message: "Hay ids repetidos" });

/**
 * Campos del preview / commit por el motor. Preview: opcionales (`rows` →
 * `[]`); commit: obligatorios. Mismo tope que `PlanCreateInputSchema`.
 */
const PreviewFields = {
  rows: z.array(PlanRowResolutionSchema).max(PLAN_MAX_SESSIONS).default([]),
  stateToken: z.string().min(1).max(64).optional(),
};
const CommitFields = {
  rows: z.array(PlanRowResolutionSchema).max(PLAN_MAX_SESSIONS),
  stateToken: z.string().min(1).max(64),
};

/** Resoluciones repetidas por `index` (misma regla que el alta). */
function noRepeatedRows(p: { rows: ReadonlyArray<{ index: number }> }, ctx: z.RefinementCtx): void {
  const seen = new Set<number>();
  for (const r of p.rows) {
    if (seen.has(r.index)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rows"], message: `La fila ${r.index} está repetida` });
    }
    seen.add(r.index);
  }
}

// ─── Resultados comunes ──────────────────────────────────────────────────────

/** Rechazo de datos o permisos (mismo shape que `ActionResult` / `CreatePlanResult`). */
export type PlanFail = { ok: false; error: string; fieldErrors?: Record<string, string[]> };
/** CAS perdido (`expectedUpdatedAt` / `expectedCurrentId` viejo). Copy: `PLAN_LIFECYCLE_COPY.stale`. */
export type PlanStaleFail = { ok: false; kind: "stale"; error: string };
/** El motor re-clasificó y el borrador ya no vale (C7). Mismo shape que `CreatePlanResult`. */
export type PlanStalePreviewFail = { ok: false; kind: "stale-preview"; preview: PlanPreview };
/** Falta una confirmación explícita (reabrir un COMPLETED). La UI pregunta y reenvía con `confirm`. */
export type PlanNeedsConfirmationFail = { ok: false; kind: "needs-confirmation"; error: string };

/** Escritura sin motor. `notice` = aviso no bloqueante (p. ej. "2 turnos con cobro quedaron"). */
export type PlanWriteResult<T = void> =
  | { ok: true; data: T; notice?: string }
  | PlanStaleFail
  | PlanNeedsConfirmationFail
  | PlanFail;

/** Escritura por el motor: suma el stale con preview fresco. */
export type PlanEngineWriteResult<T = void> = PlanWriteResult<T> | PlanStalePreviewFail;

/** Preview por el motor (mismo shape que `previewPlan`). Los títulos van redactados sin `clinical.read`. */
export type PlanPreviewResult = { ok: true; preview: PlanPreview } | PlanFail;

/** Qué pasó con los turnos futuros (D7, reducir sesiones, archivar). */
export type PlanBookingsOutcome = {
  /** Futuros impagos cancelados en la tx. */
  cancelled: number;
  /** Futuros que quedaron en la agenda por "mantener". */
  kept: number;
  /** Con cobro registrado: nunca se tocan (C13 "no se tocan"). */
  withPayment: number;
};

// ─── S15 · ciclo de vida ─────────────────────────────────────────────────────

/** Preview del diálogo D7: "¿Qué hacemos con los 6 turnos que quedan? · 2 tienen un cobro…". */
export const PlanStatusChangePreviewSchema = z
  .object({ programId: PlanEntityId, to: z.enum(PROGRAM_STATUSES) })
  .strict();
export type PlanStatusChangePreviewInput = z.input<typeof PlanStatusChangePreviewSchema>;

export type PlanStatusChangePreview = {
  from: ProgramStatusValue;
  to: ProgramStatusValue;
  /** false si la transición no está en la tabla (la UI no la ofrece). */
  allowed: boolean;
  asksFutureBookings: boolean;
  requiresConfirmation: boolean;
  /** Turnos futuros activos del plan: impagos (se pueden cancelar) y con cobro (no se tocan). */
  futureBookings: { unpaid: number; withPayment: number };
  /** Para el CAS del commit. */
  expectedUpdatedAt: string;
};

/**
 * Cambio de estado (D7). `futureBookings` solo cuenta en las transiciones que
 * preguntan (`asksFutureBookings`); ausente = `DEFAULT_FUTURE_BOOKINGS_ACTION`
 * ("cancelar", PD-10). `confirm` = COMPLETED → ACTIVE.
 */
export const ChangePlanStatusSchema = z
  .object({
    programId: PlanEntityId,
    expectedUpdatedAt: ExpectedUpdatedAt,
    to: z.enum(PROGRAM_STATUSES),
    futureBookings: z.enum(FUTURE_BOOKINGS_ACTIONS).optional(),
    confirm: z.literal(true).optional(),
  })
  .strict();
export type ChangePlanStatusInput = z.input<typeof ChangePlanStatusSchema>;
export type ChangePlanStatusInputParsed = z.output<typeof ChangePlanStatusSchema>;

export type ChangePlanStatusData = {
  status: ProgramStatusValue;
  /** `updatedAt` nuevo (ISO), para encadenar el próximo CAS sin recargar. */
  updatedAt: string;
  /** null = la transición no tocó turnos (o fue no-op). */
  bookings: PlanBookingsOutcome | null;
  /** Mismo estado que el pedido: no se escribió ni se auditó. */
  noop: boolean;
};
export type ChangePlanStatusResult = PlanWriteResult<ChangePlanStatusData>;

/**
 * `updatePlanDetails` (PD-10): SOLO título y notas, con CAS. Strict: un
 * `totalSessions` (o cualquier otro campo estructural) se rechaza — cantidad
 * va por `plans-edit`, horario/profesional/servicio/sede por re-planificar.
 * El título es NOT NULL (vacío = rechazo); las notas se limpian con "" o null.
 */
export const UpdatePlanDetailsSchema = z
  .object({
    programId: PlanEntityId,
    expectedUpdatedAt: ExpectedUpdatedAt,
    title: z.string().trim().min(1, "El plan necesita un título").max(120).optional(),
    notes: z
      .string()
      .trim()
      .max(4000)
      .nullable()
      .optional()
      .transform((v) => (v === "" ? null : v)),
  })
  .strict()
  .refine((p) => p.title !== undefined || p.notes !== undefined, { message: "No hay cambios para guardar" });
export type UpdatePlanDetailsInput = z.input<typeof UpdatePlanDetailsSchema>;
export type UpdatePlanDetailsInputParsed = z.output<typeof UpdatePlanDetailsSchema>;
export type UpdatePlanDetailsResult = PlanWriteResult<{ updatedAt: string; changed: boolean }>;

/**
 * Archivar el plan (§2.4): directo si está CANCELLED/COMPLETED. Si está
 * ACTIVE/PAUSED, `cancelOpen: true` = la transición D7 a CANCELLED en la misma
 * tx (con `futureBookings`, default cancelar); sin él → rechazo
 * (`decideProgramArchive`).
 */
export const ArchivePlanSchema = z
  .object({
    programId: PlanEntityId,
    expectedUpdatedAt: ExpectedUpdatedAt,
    cancelOpen: z.literal(true).optional(),
    futureBookings: z.enum(FUTURE_BOOKINGS_ACTIONS).optional(),
  })
  .strict();
export type ArchivePlanInput = z.input<typeof ArchivePlanSchema>;
export type ArchivePlanResult = PlanWriteResult<{
  updatedAt: string;
  /** Estado final (CANCELLED si hubo `cancelOpen`). */
  status: ProgramStatusValue;
  /** null = no hubo transición previa. */
  bookings: PlanBookingsOutcome | null;
}>;

/** Restaurar (OWNER/ADMIN): limpia `archivedAt`; el estado queda como estaba. */
export const RestorePlanSchema = z
  .object({ programId: PlanEntityId, expectedUpdatedAt: ExpectedUpdatedAt })
  .strict();
export type RestorePlanInput = z.input<typeof RestorePlanSchema>;
export type RestorePlanResult = PlanWriteResult<{ updatedAt: string; status: ProgramStatusValue }>;

// L9: `plansAction?: PatientArchivePlansAction` (default `pause`) se suma a
// `setPatientArchived` / `bulkArchivePatients` en `lib/patients.ts` (S15); el
// tipo y la regla viven en `lib/plans-lifecycle-state.ts`.

// ─── S16a · mover en serie (D23) y re-planificar (L7) ────────────────────────

/**
 * D23 "este y los siguientes" (mismo desfase): `at` = instante NUEVO de la
 * sesión `fromSessionId`; el desfase (at − fecha actual) se aplica a ella y a
 * las siguientes vivas no realizadas. Absoluto y no un delta: reenviar el
 * mismo commit da desfase 0 (idempotente). Gate `plans.schedule`.
 */
const MovePlanSeriesBase = {
  programId: PlanEntityId,
  fromSessionId: PlanEntityId,
  at: IsoInstant,
};
export const MovePlanSeriesPreviewSchema = z
  .object({ ...MovePlanSeriesBase, ...PreviewFields })
  .strict()
  .superRefine(noRepeatedRows);
export const MovePlanSeriesCommitSchema = z
  .object({ ...MovePlanSeriesBase, ...CommitFields })
  .strict()
  .superRefine(noRepeatedRows);
export type MovePlanSeriesPreviewInput = z.input<typeof MovePlanSeriesPreviewSchema>;
export type MovePlanSeriesInput = z.input<typeof MovePlanSeriesCommitSchema>;
export type MovePlanSeriesInputParsed = z.output<typeof MovePlanSeriesCommitSchema>;
export type MovePlanSeriesResult = PlanEngineWriteResult<{
  /** Turnos movidos por el core (`capLocksHeld:true`). */
  movedBookings: number;
  /** Sesiones sin turno que solo cambiaron de fecha. */
  movedSessions: number;
}>;

/**
 * L7 "Editar desde la sesión N": cancela los futuros impagos desde
 * `fromSessionId` y recrea por el motor (`commitPlanRowsInTx` modo `replan`)
 * con el horario nuevo. Cambiar profesional, servicio o sede = cancelar y
 * recrear (todo por `validatePlanRefsInTx`). Ausente = se mantiene el del
 * plan; `locationId: null` = sede por franja; `durationMin: null` = sin
 * override. Gate `plans.manage`.
 */
const ReplanPlanBase = {
  programId: PlanEntityId,
  fromSessionId: PlanEntityId,
  schedule: PlanScheduleV1Schema,
  startDayKey: DayKeySchema,
  practitionerId: PlanEntityId.optional(),
  serviceId: PlanEntityId.optional(),
  locationId: PlanEntityId.nullable().optional(),
  durationMin: z.number().int().min(PLAN_MIN_DURATION).max(PLAN_MAX_DURATION).nullable().optional(),
};
export const ReplanPlanPreviewSchema = z
  .object({ ...ReplanPlanBase, ...PreviewFields })
  .strict()
  .superRefine(noRepeatedRows);
export const ReplanPlanCommitSchema = z
  .object({ ...ReplanPlanBase, ...CommitFields })
  .strict()
  .superRefine(noRepeatedRows);
export type ReplanPlanPreviewInput = z.input<typeof ReplanPlanPreviewSchema>;
export type ReplanPlanInput = z.input<typeof ReplanPlanCommitSchema>;
export type ReplanPlanInputParsed = z.output<typeof ReplanPlanCommitSchema>;
export type ReplanPlanResult = PlanEngineWriteResult<{
  /** Futuros impagos cancelados antes de recrear. */
  cancelledBookings: number;
  /** Con cobro: quedan intactos (se reprograman a mano). */
  keptWithPayment: number;
  createdBookings: number;
  adoptedBookings: number;
}>;

// ─── S16b · cantidad, precio y autorización de la OS ─────────────────────────

/**
 * PACKAGE al cambiar la cantidad (C13 S22e): "¿Mantenemos el total o el
 * precio por sesión?". Ignorado en PER_SESSION y sin precio.
 */
export const PACKAGE_COUNT_PRICING = ["keep-total", "keep-per-session"] as const;
export type PackageCountPricing = (typeof PACKAGE_COUNT_PRICING)[number];

/**
 * `addPlanSessions`: `append` = N al final siguiendo el horario del plan;
 * `custom` = UNA sesión "a medida" (título, fecha y hora opcionales; sin `at`
 * queda "sin turno"). La cuota la decide el plan (C5/I6), nunca el cliente.
 * Reabre un COMPLETED solo con `confirmReopen`. Gate `plans.manage`.
 */
const AddPlanSessionsBase = {
  programId: PlanEntityId,
  kind: z.enum(["append", "custom"]),
  count: z.number().int().min(1).max(PLAN_MAX_SESSIONS).optional(),
  title: z
    .string()
    .trim()
    .max(120)
    .optional()
    .transform((v) => (v === "" ? undefined : v)),
  at: IsoInstant.optional(),
  packagePricing: z.enum(PACKAGE_COUNT_PRICING).optional(),
  confirmReopen: z.literal(true).optional(),
};
function addSessionsShape(
  p: { kind: "append" | "custom"; count?: number; title?: string; at?: string },
  ctx: z.RefinementCtx
): void {
  if (p.kind === "append") {
    if (p.count === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["count"], message: "¿Cuántas sesiones agregamos?" });
    if (p.title !== undefined || p.at !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["kind"], message: "Título y fecha son solo para una sesión a medida" });
    }
  } else if (p.count !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["count"], message: "Una sesión a medida se agrega de a una" });
  }
}
export const AddPlanSessionsPreviewSchema = z
  .object({ ...AddPlanSessionsBase, ...PreviewFields })
  .strict()
  .superRefine((p, ctx) => {
    addSessionsShape(p, ctx);
    noRepeatedRows(p, ctx);
  });
export const AddPlanSessionsCommitSchema = z
  .object({ ...AddPlanSessionsBase, ...CommitFields })
  .strict()
  .superRefine((p, ctx) => {
    addSessionsShape(p, ctx);
    noRepeatedRows(p, ctx);
  });
export type AddPlanSessionsPreviewInput = z.input<typeof AddPlanSessionsPreviewSchema>;
export type AddPlanSessionsInput = z.input<typeof AddPlanSessionsCommitSchema>;
export type AddPlanSessionsInputParsed = z.output<typeof AddPlanSessionsCommitSchema>;
export type AddPlanSessionsResult = PlanEngineWriteResult<{
  sessionIds: string[];
  createdBookings: number;
  totalSessions: number;
  /** El plan estaba COMPLETED y volvió a ACTIVE (con `confirmReopen`). */
  reopened: boolean;
}>;

/**
 * Archivar sesiones / reducir la cantidad: `sessionIds` explícitos, o
 * `totalSessions` = la cantidad nueva (se archivan las ÚLTIMAS sin cobro).
 * Exactamente uno de los dos. Realizada, con turno COMPLETED o con cobro →
 * rechazo; turno activo impago → se cancela en la tx (§2.4).
 */
export const ArchivePlanSessionsSchema = z
  .object({
    programId: PlanEntityId,
    expectedUpdatedAt: ExpectedUpdatedAt,
    sessionIds: UniqueIds.optional(),
    totalSessions: z.number().int().min(1).max(PLAN_MAX_SESSIONS).optional(),
    packagePricing: z.enum(PACKAGE_COUNT_PRICING).optional(),
  })
  .strict()
  .refine((p) => (p.sessionIds === undefined) !== (p.totalSessions === undefined), {
    message: "Elegí las sesiones o la cantidad nueva, no las dos",
    path: ["sessionIds"],
  });
export type ArchivePlanSessionsInput = z.input<typeof ArchivePlanSessionsSchema>;
export type ArchivePlanSessionsResult = PlanWriteResult<{
  updatedAt: string;
  archivedSessionIds: string[];
  cancelledBookings: number;
  totalSessions: number;
}>;

/** `restoreSession`: falla con "Ya hay una sesión N viva" si otra tomó su index (M13). */
export const RestorePlanSessionSchema = z
  .object({ programId: PlanEntityId, sessionId: PlanEntityId, expectedUpdatedAt: ExpectedUpdatedAt })
  .strict();
export type RestorePlanSessionInput = z.input<typeof RestorePlanSessionSchema>;
export type RestorePlanSessionResult = PlanWriteResult<{ updatedAt: string; totalSessions: number }>;

/**
 * Reprecio C5 (dos ramas + desestampado). `pricing` = el mismo zod del alta
 * (null = "sin precio · sigue la cobertura"). El preview usa el mismo input
 * (sin escribir) y devuelve `RepricePlanPreview` para el copy C13.
 */
export const RepricePlanSchema = z
  .object({ programId: PlanEntityId, expectedUpdatedAt: ExpectedUpdatedAt, pricing: PlanPricingSchema })
  .strict();
export type RepricePlanInput = z.input<typeof RepricePlanSchema>;
export type RepricePlanInputParsed = z.output<typeof RepricePlanSchema>;
export type PlanPricingValue = z.output<typeof PlanPricingSchema>;

/** C13: "Cambiar precio: de $X a $Y en N turnos · M quedan como están (cobrados o pasados)". */
export type RepricePlanPreview = {
  current: PlanPricingValue;
  next: PlanPricingValue;
  /** Turnos futuros impagos que se re-estampan / estampan por primera vez / desestampan. */
  bookingsToStamp: number;
  /** Turnos que quedan como están (cobrados, pasados, copago manual, COMPLETED). */
  bookingsKept: number;
  /** Sesiones vivas cuya cuota cambia. */
  sessionsChanged: number;
  /** Suma de las cuotas bloqueadas (PACKAGE: el piso del total nuevo). */
  lockedCents: number;
  /** El reprecio no es posible (`repricePlan` → `below-locked` / `no-free-rows`); copy literal de C5. */
  error?: string;
};
export type RepricePlanPreviewResult = { ok: true; preview: RepricePlanPreview } | PlanFail;
export type RepricePlanResult = PlanWriteResult<{ updatedAt: string; stampedBookings: number; sessionsChanged: number }>;

/**
 * E2 (literal de §10 P2-C2): `RenewAuthorizationInput = {programId,
 * expectedCurrentId: string|null, code?, authorizedSessions?, startsOnDayKey,
 * expiresOnDayKey?}`. `expectedCurrentId` = id de la vigente que mostró la UI
 * (null = no había); si cambió → stale. Mismas reglas que
 * `PlanAuthorizationSchema` (espejo de los CHECK de `ProgramAuthorization`;
 * hay test de paridad). Gate `plans.authorize`.
 */
export const RenewAuthorizationSchema = z
  .object({
    programId: PlanEntityId,
    expectedCurrentId: PlanEntityId.nullable(),
    code: z
      .string()
      .trim()
      .max(64)
      .optional()
      .transform((v) => (v === "" ? undefined : v)),
    authorizedSessions: z
      .number()
      .int()
      .min(1, "Autorizá al menos 1 sesión")
      .max(200, "Como máximo 200 sesiones autorizadas")
      .optional(),
    startsOnDayKey: DayKeySchema,
    expiresOnDayKey: DayKeySchema.optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
    // dayKeys `YYYY-MM-DD`: el orden lexicográfico es el cronológico.
    if (a.expiresOnDayKey !== undefined && a.expiresOnDayKey < a.startsOnDayKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresOnDayKey"],
        message: "El vencimiento no puede ser anterior al inicio",
      });
    }
  });
export type RenewAuthorizationInput = z.input<typeof RenewAuthorizationSchema>;
export type RenewAuthorizationInputParsed = z.output<typeof RenewAuthorizationSchema>;
export type RenewAuthorizationResult = PlanWriteResult<{
  authorizationId: string;
  /** La que pasó al historial (`supersededAt`); null si no había vigente. */
  supersededId: string | null;
}>;

// ─── S25a · adopción y generar turnos ────────────────────────────────────────

/**
 * Generar turnos para sesiones pendientes ("sin turno"): `previewProgramRowsInTx`
 * con `target: {sessionIds}` + commit modo `generate` (cobro previo → $0).
 * `sessionIds` ausente = todas las pendientes; con ids = agendar una sesión
 * puntual (E1: la Secretaria desde el modal de agenda). Gate `plans.schedule`.
 */
const GenerateBase = {
  programId: PlanEntityId,
  sessionIds: UniqueIds.optional(),
};
export const GeneratePlanBookingsPreviewSchema = z
  .object({ ...GenerateBase, ...PreviewFields })
  .strict()
  .superRefine(noRepeatedRows);
export const GeneratePlanBookingsCommitSchema = z
  .object({ ...GenerateBase, ...CommitFields })
  .strict()
  .superRefine(noRepeatedRows);
/** El input del preview (rows/stateToken opcionales): `{programId, sessionIds?: string[]}`. */
export type GeneratePlanBookingsInput = z.input<typeof GeneratePlanBookingsPreviewSchema>;
export type GeneratePlanBookingsCommitInput = z.input<typeof GeneratePlanBookingsCommitSchema>;
export type GeneratePlanBookingsCommitInputParsed = z.output<typeof GeneratePlanBookingsCommitSchema>;
export type GeneratePlanBookingsResult = PlanEngineWriteResult<{ createdBookings: number; adoptedBookings: number }>;

/**
 * Vincular un turno suelto a una sesión (la sesión toma la fecha del turno,
 * I3). CAS doble: el turno (`expectedBookingUpdatedAt`, con
 * `adoptableBookingWhere`) y el plan. Nunca re-estampa lo cobrado. Gate
 * `plans.manage`.
 */
export const LinkBookingToSessionSchema = z
  .object({
    programId: PlanEntityId,
    sessionId: PlanEntityId,
    bookingId: PlanEntityId,
    expectedBookingUpdatedAt: IsoInstant,
    expectedUpdatedAt: ExpectedUpdatedAt,
  })
  .strict();
export type LinkBookingToSessionInput = z.input<typeof LinkBookingToSessionSchema>;
export type LinkBookingToSessionResult = PlanWriteResult<{ updatedAt: string; sessionId: string }>;

/**
 * Adoptar una serie de turnos sueltos. `sessionId` por turno = a qué sesión
 * pendiente va; ausente = la action asigna (pendientes por fecha, o sesiones
 * nuevas). Un turno que ya es de otro plan, cambió o es una reserva pública
 * impaga → stale entero (ninguno se adopta). Gate `plans.manage`.
 */
export const AdoptBookingSeriesSchema = z
  .object({
    programId: PlanEntityId,
    expectedUpdatedAt: ExpectedUpdatedAt,
    bookings: z
      .array(z.object({ bookingId: PlanEntityId, expectedUpdatedAt: IsoInstant, sessionId: PlanEntityId.optional() }).strict())
      .min(1, "Elegí al menos un turno")
      .max(PLAN_MAX_SESSIONS),
  })
  .strict()
  .superRefine((p, ctx) => {
    const ids = p.bookings.map((b) => b.bookingId);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bookings"], message: "Hay turnos repetidos" });
    }
    const sids = p.bookings.flatMap((b) => (b.sessionId ? [b.sessionId] : []));
    if (new Set(sids).size !== sids.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bookings"], message: "Dos turnos a la misma sesión" });
    }
  });
export type AdoptBookingSeriesInput = z.input<typeof AdoptBookingSeriesSchema>;
export type AdoptBookingSeriesResult = PlanWriteResult<{
  updatedAt: string;
  adopted: Array<{ bookingId: string; sessionId: string }>;
  totalSessions: number;
}>;

/**
 * Sacar un turno del plan (C4): con cobro → rechazo; si no, CAS de
 * desestampado (`programId`/`sessionId` null, `pricedByPlan=false`,
 * `copagoCents=null`). La sesión queda "sin turno". Gate `plans.manage`.
 */
export const RemoveBookingFromPlanSchema = z
  .object({ bookingId: PlanEntityId, expectedUpdatedAt: IsoInstant })
  .strict();
export type RemoveBookingFromPlanInput = z.input<typeof RemoveBookingFromPlanSchema>;
export type RemoveBookingFromPlanResult = PlanWriteResult<{ bookingUpdatedAt: string; sessionId: string }>;
