/**
 * Tipos compartidos entre `index.tsx` (orquestación) y las secciones del modal
 * de turno nuevo. Solo tipos: nada de lógica acá (B1.5a partió el archivo
 * único sin cambiar comportamiento).
 */
import type { createBooking, createBookingsBatch, BatchOutcome } from "@/lib/bookings";
import type { BookingBlockedPrompt, BookingOutOfHoursPrompt } from "@/lib/bookings-types";
import type { getPatientBillingPreview } from "@/lib/patients";
import type { Props } from "../agenda-client";

/** Payload de `createBooking` tal cual lo arma `submit` (y lo re-mandan los prompts). */
export type CreatePayload = Parameters<typeof createBooking>[0];
/** Payload de `createBookingsBatch` (Varias sesiones), sin `dryRun`/`allowOverbooking`. */
export type BatchPayload = Parameters<typeof createBookingsBatch>[0];

export type BillingPreview = NonNullable<Awaited<ReturnType<typeof getPatientBillingPreview>>>;

/** Paciente elegido en el picker, o la ficha creada por el alta inline. */
export type PatientRef = { id: string; name: string };

export type ServiceOption = Props["services"][number];
export type PractitionerOption = Props["practitioners"][number];
export type PatientOption = Props["patients"][number];
export type InsurerOption = Props["insurers"][number];

/**
 * Estado de los prompts de confirmación que aparecen debajo del formulario.
 * Cada uno guarda el `payload` original para re-llamar a la action con el
 * flag de confirmación (misma `idempotencyKey`).
 */
export type ConflictState = {
  practitionerName: string;
  nextFreeISO: string | null;
  payload: CreatePayload;
};
export type SamePatientState = {
  count: number;
  existingISO: string;
  payload: CreatePayload;
};
export type PatientOverlapState = {
  existingISO: string;
  payload: CreatePayload;
};
export type BatchConflictState = {
  plan: BatchOutcome;
  payload: BatchPayload;
};
/** B5.1: el horario cae sobre un bloqueo de agenda (re-llamar con `allowBlocked`). */
export type BlockedState = BookingBlockedPrompt & { payload: CreatePayload };
/** B5.1: fuera de la franja del profesional (re-llamar con `allowOutOfHours`). */
export type OutOfHoursState = BookingOutOfHoursPrompt & { payload: CreatePayload };
