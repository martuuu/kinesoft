/**
 * zod de Planes (P2-C1, ES2b) — contratos C6 (schedule v1) y C7 (entrada del
 * motor), incluida la autorización de la obra social (E2).
 *
 * Puro (sin `server-only`, no es `"use server"`): lo importan las actions
 * finas (`lib/plans.ts` y compañía, que solo pueden exportar funciones async)
 * y el editor del cliente para validar antes de mandar.
 *
 * Por qué cada tope:
 *   - Los tipos de salida tienen que ser asignables a los tipos PUROS del
 *     motor (`lib/availability/plan.ts`, re-exportados por `lib/plans-types.ts`):
 *     el chequeo de tipos de abajo (`_outputIsPlanCreateInput`) rompe tsc si
 *     alguien cambia uno sin el otro.
 *   - El schedule delega en `planScheduleError` (la guarda pura del motor) en
 *     vez de repetir las reglas: si zod y el motor discreparan, un horario
 *     "válido" para la API tiraría RangeError adentro de `expandPlanDates`.
 *   - Los rangos espejan los CHECK de M1 (`plans_booking_link`): un valor que
 *     la base rechaza tiene que morir acá con un mensaje en castellano y no
 *     como un 23514 dentro de la tx.
 *   - Los ids son SOLO forma. Que paciente, profesional, servicio, sede,
 *     plantilla o ejercicio sean del tenant lo valida la action dentro de la
 *     tx (`validatePlanRefsInTx`, S11e): las FK saltean RLS y en prod la
 *     conexión tiene BYPASSRLS.
 */
import { z } from "zod";
import { planScheduleError, type PlanScheduleV1 } from "@/lib/availability/plan";
import { isDayKey } from "@/lib/availability/day";
import type { Dow } from "@/lib/availability/types";
import {
  DISCIPLINES,
  PLAN_KEY_PREFIX,
  PLAN_MAX_DURATION,
  PLAN_MAX_SESSIONS,
  PLAN_MIN_DURATION,
} from "@/lib/plans-constants";
import type { PlanCreateInput } from "@/lib/plans-types";

// ─── Piezas ──────────────────────────────────────────────────────────────────

/** Id de fila del tenant (cuid). El tope evita payloads absurdos en el where. */
export const PlanEntityId = z.string().trim().min(1).max(64);

/** `YYYY-MM-DD` de calendario AR, validado como fecha real (no 2026-02-30). */
export const DayKeySchema = z
  .string()
  .refine((s) => isDayKey(s), { message: "Fecha inválida" });

/** Instante ISO (con zona). Lo que viaja en `at` / `expectedUpdatedAt`. */
const IsoInstant = z.string().datetime({ offset: true, message: "Fecha y hora inválidas" });

/**
 * Plata en centavos `Int` (AGENTS §4). 0 es válido (CHECK `>= 0` de M1);
 * el tope es el máximo de un `int4` de Postgres: más arriba la escritura
 * fallaría con un overflow en vez de un mensaje.
 */
export const CentsSchema = z.number().int("Monto inválido").min(0, "El monto no puede ser negativo").max(2_147_483_647, "Monto demasiado grande");

/** Texto opcional recortado: "" o solo espacios (input vacío) = ausente. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v === "" ? undefined : v));

/**
 * Key de idempotencia del plan (C3): UUID del cliente por instancia del
 * drawer. Mismas reglas que `acceptClientKey` de `lib/bookings.ts` (8..64,
 * nunca `pub:` ni `plan:`), pero acá se RECHAZA en vez de descartarse: crear
 * un plan sin key no es idempotente y el doble click crearía dos planes.
 */
export const PlanIdempotencyKey = z
  .string()
  .min(8, "Clave de idempotencia inválida")
  .max(64, "Clave de idempotencia inválida")
  .refine((k) => !k.startsWith("pub:") && !k.startsWith(PLAN_KEY_PREFIX), {
    message: "Clave de idempotencia reservada",
  });

// ─── C6 · Schedule v1 ────────────────────────────────────────────────────────

export const PlanScheduleSlotSchema = z
  .object({
    dow: z
      .number()
      .int()
      .min(0)
      .max(6)
      .transform((n) => n as Dow),
    startMin: z.number().int().min(0).max(1439),
  })
  .strict();

/**
 * C6 (literal):
 * PlanScheduleV1 = { v: 1, frequency: 'weekly' | 'monthly', everyNWeeks?: 1|2|3|4 (solo weekly; default 1),
 *                    slots: [{ dow: 0-6 (0=Dom, como PractitionerSchedule), startMin: 0..1439 (minutos AR) }] }
 * Las reglas cruzadas (1..7 slots con `dow` distintos en weekly, 1 en
 * monthly, `everyNWeeks` solo en weekly) las decide `planScheduleError`.
 */
export const PlanScheduleV1Schema = z
  .object({
    v: z.literal(1),
    frequency: z.enum(["weekly", "monthly"]),
    everyNWeeks: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
    slots: z.array(PlanScheduleSlotSchema).min(1).max(7),
  })
  .strict()
  .superRefine((s, ctx) => {
    const problem = planScheduleError(s);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  });

// ─── E2 · Autorización de la obra social ─────────────────────────────────────

/**
 * Autorización de la OS (PQ-01, PD-16). Espejo de los CHECK de
 * `ProgramAuthorization`: `code` 1..64 (vacío = sin código), `authorizedSessions`
 * 1..200, `expiresOn >= startsOn`. Las fechas son dayKeys AR (la columna es
 * `DATE`; se escriben con `dayKeyToDbDate`). Lo usan `createPlan` (S11e) y
 * la renovación (S16b, `RenewAuthorizationInput` de P2-C2).
 */
export const PlanAuthorizationSchema = z
  .object({
    code: optionalText(64),
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

// ─── C7 · Entrada del motor ──────────────────────────────────────────────────

export const PlanForceFlagsSchema = z
  .object({
    capacity: z.literal(true).optional(),
    outOfHours: z.literal(true).optional(),
    patientOverlap: z.literal(true).optional(),
  })
  .strict();

/**
 * Resolución de una fila de "Revisá los turnos". Las combinaciones que no
 * tienen sentido mueren acá (un `move` sin destino, un `adopt` sin el
 * `updatedAt` que mostró el preview, un `force` sin flags); el resto (si la
 * resolución está permitida para la clase de la fila) lo decide el motor y
 * termina en stale por fila (C7).
 */
export const PlanRowResolutionSchema = z
  .object({
    index: z.number().int().min(1).max(PLAN_MAX_SESSIONS),
    kind: z.enum(["create", "move", "force", "adopt", "none", "mark-done"]),
    at: IsoInstant.optional(),
    force: PlanForceFlagsSchema.optional(),
    bookingId: PlanEntityId.optional(),
    expectedUpdatedAt: IsoInstant.optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.kind === "move" && !r.at) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["at"], message: "Falta el horario de destino" });
    }
    if (r.kind === "adopt" && (!r.bookingId || !r.expectedUpdatedAt)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bookingId"], message: "Falta el turno a usar" });
    }
    if (r.kind === "force" && (!r.force || Object.keys(r.force).length === 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["force"], message: "Falta qué se fuerza" });
    }
  });

export const PlanPricingSchema = z
  .discriminatedUnion("mode", [
    z.object({ mode: z.literal("PER_SESSION"), pricePerSessionCents: CentsSchema }).strict(),
    z.object({ mode: z.literal("PACKAGE"), totalPriceCents: CentsSchema }).strict(),
  ])
  .nullable();

export const PlanExerciseSchema = z
  .object({
    exerciseId: PlanEntityId,
    // Mismo rango que la dosis de `lib/validation.ts` (sesiones).
    sets: z.number().int().min(0).max(200),
    reps: z.number().int().min(0).max(200),
  })
  .strict();

/**
 * Forma base (sin reglas cruzadas) de `PlanCreateInput`. No se exporta: el
 * commit y el preview la refinan con `refinePlanCreate`, así las dos entradas
 * no pueden divergir en una regla.
 */
const PlanCreateInputObject = z
  .object({
    idempotencyKey: PlanIdempotencyKey,
    patientId: PlanEntityId,
    discipline: z.enum(DISCIPLINES),
    practitionerId: PlanEntityId,
    serviceId: PlanEntityId,
    locationId: PlanEntityId.nullable(),
    title: optionalText(120),
    notes: optionalText(4000),
    durationMin: z.number().int().min(PLAN_MIN_DURATION).max(PLAN_MAX_DURATION).optional(),
    schedule: PlanScheduleV1Schema,
    startDayKey: DayKeySchema,
    totalSessions: z.number().int().min(1).max(PLAN_MAX_SESSIONS),
    pricing: PlanPricingSchema,
    templateId: PlanEntityId.optional(),
    exercises: z.array(PlanExerciseSchema).max(100).optional(),
    origin: z.object({ kind: z.enum(["diagnosis", "template", "booking", "manual"]) }).strict().optional(),
    fromBookingId: PlanEntityId.optional(),
    countBookingAsSession1: z.boolean().optional(),
    authorization: PlanAuthorizationSchema.optional(),
    rows: z.array(PlanRowResolutionSchema).max(PLAN_MAX_SESSIONS),
    stateToken: z.string().min(1).max(64),
  })
  .strict();

function refinePlanCreate(
  p: { rows: ReadonlyArray<{ index: number }>; totalSessions: number; countBookingAsSession1?: boolean; fromBookingId?: string },
  ctx: z.RefinementCtx
): void {
  const seen = new Set<number>();
  for (const r of p.rows) {
    if (r.index > p.totalSessions) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rows"], message: `La fila ${r.index} no existe en el plan` });
    }
    if (seen.has(r.index)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rows"], message: `La fila ${r.index} está repetida` });
    }
    seen.add(r.index);
  }
  if (p.countBookingAsSession1 && !p.fromBookingId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["countBookingAsSession1"],
      message: "Falta el turno que cuenta como sesión 1",
    });
  }
}

/** C7 · `PlanCreateInput` (literal en `lib/availability/plan.ts`). */
export const PlanCreateInputSchema = PlanCreateInputObject.superRefine(refinePlanCreate);

export type PlanCreateInputParsed = z.output<typeof PlanCreateInputSchema>;

/**
 * Entrada de `previewPlan` (P2-C2, handoff de S11e): el MISMO borrador que el
 * commit, con `idempotencyKey` y `stateToken` opcionales (el preview no
 * escribe ni compara token) y `rows` con default `[]` (primer preview, sin
 * resoluciones elegidas). Antes `previewPlan` rellenaba "preview-only" a mano
 * para reusar el zod del commit; con esto el editor (ES3) también valida el
 * borrador antes de pedir el preview. Si vienen, se validan igual que en el
 * commit (una key `plan:` sigue siendo rechazo).
 */
export const PlanPreviewInputSchema = PlanCreateInputObject.extend({
  idempotencyKey: PlanIdempotencyKey.optional(),
  stateToken: z.string().min(1).max(64).optional(),
  rows: z.array(PlanRowResolutionSchema).max(PLAN_MAX_SESSIONS).default([]),
})
  .strict()
  .superRefine(refinePlanCreate);

export type PlanPreviewInput = z.input<typeof PlanPreviewInputSchema>;
export type PlanPreviewInputParsed = z.output<typeof PlanPreviewInputSchema>;

// Ancla de tipos: la salida de zod tiene que ser un `PlanCreateInput` del motor
// (y el schedule, un `PlanScheduleV1`). Si alguien cambia un lado sin el otro,
// esto deja de compilar.
const _outputIsPlanCreateInput = (x: PlanCreateInputParsed): PlanCreateInput => x;
const _outputIsSchedule = (x: z.output<typeof PlanScheduleV1Schema>): PlanScheduleV1 => x;
void _outputIsPlanCreateInput;
void _outputIsSchedule;
