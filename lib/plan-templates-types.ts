/**
 * Tipos y zod de las plantillas de plan (S17t, ES3 P3.1).
 *
 * Puro (sin `server-only`, no es `"use server"`): `lib/plan-templates.ts` es
 * un archivo de actions y solo puede exportar funciones async, así que el
 * schema vive acá. Lo importan las actions y la UI de plantillas (S21t) para
 * validar antes de mandar.
 *
 * Por qué cada regla:
 *   - Las piezas (schedule C6, pricing, duración, ids) son las MISMAS de
 *     `lib/plans-schemas.ts`: una plantilla es un borrador del editor, y un
 *     valor que el motor rechazaría al crear el plan tiene que morir acá, no
 *     cuando alguien la aplica meses después.
 *   - Los rangos espejan los CHECK de M1 sobre `PlanTemplate`
 *     (`plans_booking_link`): pricing coherente (modo + un solo precio),
 *     precios >= 0, duración 15..240, schedule objeto. Sin esto el error era
 *     un 23514 dentro de la tx.
 *   - Los ids son solo forma. Que el servicio y los ejercicios sean del
 *     tenant lo valida la action en la tx (`validatePlanRefsInTx`): las FK
 *     saltean RLS y en prod la conexión tiene BYPASSRLS.
 */
import { z } from "zod";
import { DISCIPLINES, PLAN_MAX_DURATION, PLAN_MAX_SESSIONS, PLAN_MIN_DURATION, type Discipline } from "@/lib/plans-constants";
import {
  PlanEntityId,
  PlanPricingSchema,
  PlanScheduleV1Schema,
} from "@/lib/plans-schemas";
import type { PlanEditorPrefill } from "@/lib/plans-deeplink";
import type { PlanPricingInput, PlanScheduleV1 } from "@/lib/plans-types";

/** Tope de ejercicios por plantilla (= `PlanCreateInput.exercises`). */
export const PLAN_TEMPLATE_MAX_EXERCISES = 100;

/** Texto opcional recortado: "" o solo espacios = vacío (null en la base). */
const nullableText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label}: como máximo ${max} caracteres`)
    .nullable()
    .optional()
    .transform((v) => (v === "" ? null : v));

/**
 * Campos editables. En el alta los ausentes quedan vacíos; en la edición
 * (`PlanTemplateUpdateSchema`) ausente = se mantiene y `null` = se limpia.
 */
const PlanTemplateFields = {
  name: z.string().trim().min(1, "Poné un nombre").max(120, "El nombre es demasiado largo"),
  description: nullableText(500, "Descripción"),
  discipline: z.enum(DISCIPLINES).nullable().optional(),
  serviceId: PlanEntityId.nullable().optional(),
  /** null = sigue la duración del servicio / profesional. */
  durationMin: z
    .number()
    .int()
    .min(PLAN_MIN_DURATION, `La duración mínima es ${PLAN_MIN_DURATION} minutos`)
    .max(PLAN_MAX_DURATION, `La duración máxima es ${PLAN_MAX_DURATION} minutos`)
    .nullable()
    .optional(),
  totalSessions: z
    .number()
    .int()
    .min(1, "Al menos 1 sesión")
    .max(PLAN_MAX_SESSIONS, `Como máximo ${PLAN_MAX_SESSIONS} sesiones`),
  /**
   * Legacy (sesiones por semana, NOT NULL en la base, lo lee el modal viejo
   * de aplicar plantilla). Con horario se ignora y se deriva de él
   * (`legacyFrequency`, la misma regla del motor).
   */
  frequency: z.number().int().min(1).max(7).optional(),
  /** Horario C6. null = sin horario (se limpia con `Prisma.DbNull`). */
  schedule: PlanScheduleV1Schema.nullable().optional(),
  /** null = "Sin precio · sigue la cobertura". */
  pricing: PlanPricingSchema.optional(),
  notes: nullableText(4000, "Notas"),
  /** Orden canónico; repetidos = error (la UI no debería mandarlos). */
  exerciseIds: z
    .array(PlanEntityId)
    .max(PLAN_TEMPLATE_MAX_EXERCISES, `Como máximo ${PLAN_TEMPLATE_MAX_EXERCISES} ejercicios`)
    .refine((ids) => new Set(ids).size === ids.length, "Hay ejercicios repetidos"),
};

export const PlanTemplateCreateSchema = z
  .object({
    ...PlanTemplateFields,
    exerciseIds: PlanTemplateFields.exerciseIds.optional(),
  })
  .strict();

export const PlanTemplateUpdateSchema = z
  .object({
    id: PlanEntityId,
    /**
     * CAS opcional: el `updatedAt` (ISO) que mostró el drawer. Si otra
     * persona la editó en el medio → `stale` y no se pisa.
     */
    expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
    name: PlanTemplateFields.name.optional(),
    description: PlanTemplateFields.description,
    discipline: PlanTemplateFields.discipline,
    serviceId: PlanTemplateFields.serviceId,
    durationMin: PlanTemplateFields.durationMin,
    totalSessions: PlanTemplateFields.totalSessions.optional(),
    frequency: PlanTemplateFields.frequency,
    schedule: PlanTemplateFields.schedule,
    pricing: PlanTemplateFields.pricing,
    notes: PlanTemplateFields.notes,
    exerciseIds: PlanTemplateFields.exerciseIds.optional(),
  })
  .strict();

export const PlanTemplatePrefillInputSchema = z
  .object({
    templateId: PlanEntityId,
  })
  .strict();

export type PlanTemplateCreateInput = z.input<typeof PlanTemplateCreateSchema>;
export type PlanTemplateUpdateInput = z.input<typeof PlanTemplateUpdateSchema>;

/** Fila del listado (también la consume el modal legacy de aplicar plantilla). */
export type PlanTemplateRow = {
  id: string;
  name: string;
  description: string | null;
  totalSessions: number;
  /** Legacy (sesiones por semana); con horario se deriva de él. */
  frequency: number;
  exerciseCount: number;
  discipline: Discipline | null;
  serviceId: string | null;
  serviceName: string | null;
  durationMin: number | null;
  schedule: PlanScheduleV1 | null;
  pricing: PlanPricingInput;
  /** Hay notas (el texto va en el detalle, no en el listado). */
  hasNotes: boolean;
  authorId: string;
  authorName: string | null;
  /** El actor puede editar, archivar y borrar (autor o OWNER/ADMIN, con `plans.manage`). */
  canEdit: boolean;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Detalle para el drawer de edición (S21t). */
export type PlanTemplateDetail = PlanTemplateRow & {
  notes: string | null;
  /**
   * Ejercicios en el orden de la plantilla, con nombre. `assignable: false` =
   * hoy no se puede asignar (archivado o fuera del catálogo del plan SaaS):
   * la UI lo marca y al guardar se saca.
   */
  exercises: Array<{ id: string; name: string; assignable: boolean }>;
};

/**
 * Resultado de `getTemplatePrefill`: el borrador del editor (C10) más lo que
 * no viaja en la URL (texto libre y ejercicios con dosis). Aplicar una
 * plantilla NO crea el plan: el editor abre prellenado y el alta va por el
 * motor (`previewPlan` → `createPlan` con `templateId`).
 */
export type PlanTemplatePrefill = {
  templateId: string;
  /** `discipline`, `serviceId`, `durationMin`, `totalSessions`, `schedule`, `pricing`, `templateId`. */
  prefill: PlanEditorPrefill;
  /** Título sugerido (= nombre de la plantilla). */
  title: string;
  notes: string | null;
  /** Solo los asignables hoy, en orden; dosis = la del ejercicio ?? 3×12. */
  exercises: Array<{ exerciseId: string; name: string; sets: number; reps: number }>;
  /** Ejercicios de la plantilla que se descartaron (archivados / fuera del catálogo). */
  droppedExercises: number;
  /** El servicio de la plantilla ya no existe o es de otra disciplina: se omitió del prefill. */
  serviceDropped: boolean;
};
