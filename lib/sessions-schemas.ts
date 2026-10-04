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

/** Ids cuid/uuid: acotados para no aceptar basura arbitraria por RPC. */
const Id = z.string().min(1).max(64);

/** ISO 8601 con hora y offset explícito ("…T14:00:00-03:00" o "…Z"). */
const IsoInstant = z.string().datetime({ offset: true, message: "Fecha inválida." });

export const RescheduleSessionInput = z.object({
  sessionId: Id,
  scheduledFor: IsoInstant,
  practitionerId: Id.optional(),
});
export type RescheduleSessionInputT = z.input<typeof RescheduleSessionInput>;

export const AddCustomSessionInput = z.object({
  programId: Id,
  // Conducta previa preservada: el título se recorta y se trunca a 4000 (no
  // se rechaza); vacío = sin título.
  title: z
    .string()
    .optional()
    .transform((t) => (t?.trim() ? t.trim().slice(0, 4000) : null)),
  scheduledFor: IsoInstant.optional(),
});
export type AddCustomSessionInputT = z.input<typeof AddCustomSessionInput>;

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
