/**
 * Zod y tipos de franjas y excepciones (B2.4a CFG-api-1). Fuera del archivo
 * `"use server"` (`lib/practitioner-schedule.ts` exporta solo funciones async).
 *
 * Zod valida FORMA (enteros, tipos, topes de tamaño); las reglas de negocio
 * (rango, múltiplos de 5, solapes, sede activa) las aplica
 * `lib/schedule-validate.ts` para poder devolver un error POR FILA.
 */
import { z } from "zod";
import type { DayKey } from "@/lib/availability/types";
import { isValidDayKey, MAX_RANGES_PER_DAY, MAX_RANGES_PER_WEEK } from "@/lib/schedule-validate";

export const EntityId = z.string().trim().min(1).max(64);

export const DayKeySchema = z
  .string()
  .refine((s) => isValidDayKey(s), "Fecha inválida (AAAA-MM-DD).");

const Minute = z.coerce.number().int("Minutos enteros");

export const ScheduleRangeSchema = z.object({
  startMin: Minute,
  endMin: Minute,
  locationId: z.string().trim().max(64),
});

export const WeekRangeSchema = ScheduleRangeSchema.extend({
  dow: z.coerce.number().int(),
});

export const SaveWeekInput = z.object({
  practitionerId: EntityId,
  ranges: z.array(WeekRangeSchema).max(MAX_RANGES_PER_WEEK, `Máximo ${MAX_RANGES_PER_WEEK} franjas por semana`),
  /** `version` que devolvió `getPractitionerSchedule`; null = "estaba vacía". Omitido = sin lock. */
  expectedUpdatedAt: z.union([z.string().datetime(), z.null()]).optional(),
});

/** Ventana de `listExceptions` (inclusive); tope 400 días. */
export const ExceptionRangeInput = z.object({
  from: DayKeySchema,
  to: DayKeySchema,
  /** Filtra a un profesional (+ las de consultorio). Omitido = todas. */
  practitionerId: EntityId.optional(),
});
export const MAX_EXCEPTION_WINDOW_DAYS = 400;

export const UpsertExceptionInput = z
  .object({
    /** null = todo el consultorio. */
    practitionerId: z.union([EntityId, z.null()]),
    date: DayKeySchema,
    kind: z.enum(["CLOSED", "CUSTOM_HOURS"]),
    ranges: z.array(ScheduleRangeSchema).max(MAX_RANGES_PER_DAY).optional().nullable(),
    reason: z
      .union([z.string(), z.null()])
      .optional()
      .transform((v) => (typeof v === "string" && v.trim() ? v.trim() : null))
      .pipe(z.string().max(200, "Máximo 200 caracteres").nullable()),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "CUSTOM_HOURS" && (!v.ranges || v.ranges.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ranges"],
        message: "Cargá al menos una franja (o marcá el día como cerrado).",
      });
    }
  });
export type UpsertExceptionRaw = z.input<typeof UpsertExceptionInput>;

// ─────────────────────────────────────────────────────────────────────────────
// Salidas
// ─────────────────────────────────────────────────────────────────────────────

export type ScheduleRangeRow = {
  id: string;
  dow: number;
  startMin: number;
  endMin: number;
  locationId: string;
  validFrom: DayKey | null;
  validUntil: DayKey | null;
};

export type PractitionerScheduleView = {
  practitionerId: string;
  ranges: ScheduleRangeRow[];
  /** Token del optimistic lock (ISO del último `updatedAt`); null = sin franjas. */
  version: string | null;
  /** Sin franjas: el motor usa el horario del consultorio lun-sáb en la sede principal. */
  isFallback: boolean;
  tenantHours: { startMin: number; endMin: number };
};

export type PractitionerScheduleSummaryRow = {
  practitionerId: string;
  name: string;
  /** "Lun-Vie 8-13, 15-19 · Sáb 9-12"; si `isFallback`, el horario heredado. */
  summary: string;
  isFallback: boolean;
  rangeCount: number;
  /** Sedes donde atiende (ids, sin repetir). */
  locationIds: string[];
};

export type ScheduleExceptionRow = {
  id: string;
  practitionerId: string | null;
  date: DayKey;
  kind: "CLOSED" | "CUSTOM_HOURS";
  ranges: Array<{ startMin: number; endMin: number; locationId: string }> | null;
  reason: string | null;
};
