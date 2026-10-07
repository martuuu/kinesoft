/**
 * Schemas zod de las mutaciones de Seguimiento/sesiones (Planes P0 · S02s).
 *
 * Viven acá y no en `lib/sessions.ts` porque ese archivo es `"use server"` y
 * solo puede exportar funciones async (AGENTS §4). Tampoco van en
 * `lib/validation.ts`: en esta ola tiene otro dueño (S02a) y estos schemas son
 * de un solo módulo.
 *
 * Por qué hacía falta: `rescheduleSession` y `addCustomSession` parseaban la
 * fecha con `new Date(input)` a pelo (cualquier string que `Date` entendiera,
 * incluido "2026-10-06" sin hora, que el host interpreta como 00:00 UTC =
 * 21:00 AR del día anterior) y `bulkAddSessionExercises` validaba a mano solo
 * el largo de la lista. Ahora una fecha tiene que ser ISO con hora y offset
 * explícito (`Z` o `-03:00`): la UI ya manda `localToARIso(...)`, así que no
 * cambia nada para ella y se corta el caso ambiguo.
 */
import { z } from "zod";
import { PACKAGE_COUNT_PRICING } from "@/lib/plans-edit-types";

/** Ids cuid/uuid: acotados para no aceptar basura arbitraria por RPC. */
const Id = z.string().min(1).max(64);

/** ISO 8601 con hora y offset explícito ("…T14:00:00-03:00" o "…Z"). */
const IsoInstant = z.string().datetime({ offset: true, message: "Fecha inválida." });

/**
 * S12b (L5): con turno activo, reprogramar la sesión mueve el turno por el core
 * de la agenda (`applyBookingUpdateInTx`), que puede pedir confirmación
 * (sobreturno, fuera de horario, bloqueo, superposición del paciente). Mismos
 * flags que `updateBooking`; ausentes = no se fuerza nada. Sin turno no se usan.
 */
const RescheduleForce = z
  .object({
    allowOverbooking: z.boolean().optional(),
    allowPatientOverlap: z.boolean().optional(),
    allowOutOfHours: z.boolean().optional(),
    allowBlocked: z.boolean().optional(),
  })
  .strict();

export const RescheduleSessionInput = z.object({
  sessionId: Id,
  scheduledFor: IsoInstant,
  /**
   * Compatibilidad: se acepta, pero reprogramar NUNCA cambia el profesional
   * (C4). Si viene distinto del de la sesión, rechazo: el profesional de un
   * turno se cambia desde la agenda.
   */
  practitionerId: Id.optional(),
  force: RescheduleForce.optional(),
});
export type RescheduleSessionInputT = z.input<typeof RescheduleSessionInput>;

export const AddCustomSessionInput = z.object({
  programId: Id,
  // Conducta previa preservada: el título se recorta y se trunca a 4000 (no
  // se rechaza); vacío = sin título. S12b: se guarda en `Session.title`.
  title: z
    .string()
    .optional()
    .transform((t) => (t?.trim() ? t.trim().slice(0, 4000) : null)),
  scheduledFor: IsoInstant.optional(),
  /**
   * P2.Z (H-a3 / B-M1): en un plan por PAQUETE agregar una sesión obliga a
   * decidir la plata (C13 S22e: "¿mantenemos el total o el precio por
   * sesión?", D5: la cuota la decide el plan, nunca el cliente). Opcional y
   * aditivo: la UI vieja (`plan-view.tsx`) no lo manda y en un paquete recibe
   * un rechazo accionable en vez de una sesión sin cuota que rompía I6.
   */
  packagePricing: z.enum(PACKAGE_COUNT_PRICING).optional(),
});
export type AddCustomSessionInputT = z.input<typeof AddCustomSessionInput>;

/** "Cargar evolución" (S12b): la sesión; la meta se valida con `SessionMeta` (`lib/validation.ts`). */
export const LoadSessionEvolutionInput = z.object({ sessionId: Id });

export const BULK_MAX_EXERCISES = 50;

export const BulkAddSessionExercisesInput = z.object({
  programId: Id,
  exerciseIds: z
    .array(Id)
    .min(1, "No seleccionaste ejercicios.")
    .max(BULK_MAX_EXERCISES, `Demasiados ejercicios (máx. ${BULK_MAX_EXERCISES} por operación).`),
  range: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("all") }),
    z.object({ kind: z.literal("fromIndex"), fromIndex: z.number().int().min(1) }),
  ]),
});
export type BulkAddSessionExercisesInputT = z.input<typeof BulkAddSessionExercisesInput>;
