/**
 * Schemas zod de las mutaciones de Seguimiento/sesiones (Planes P0 · S02s).
 *
 * Viven acá y no en `lib/sessions.ts` porque ese archivo es `"use server"` y
 * solo puede exportar funciones async (AGENTS §4). Tampoco van en
 * `lib/validation.ts`: en esta ola tiene otro dueño (S02a) y estos schemas son
 * de un solo módulo.
 *
 * Por qué hacía falta: `rescheduleSession` y la sesión a medida legacy (retirada en S27b) parseaban la
 * fecha con `new Date(input)` a pelo (cualquier string que `Date` entendiera,
 * incluido "2026-10-06" sin hora, que el host interpreta como 00:00 UTC =
 * 21:00 AR del día anterior) y `bulkAddSessionExercises` validaba a mano solo
 * el largo de la lista. Ahora una fecha tiene que ser ISO con hora y offset
 * explícito (`Z` o `-03:00`): la UI ya manda `localToARIso(...)`, así que no
 * cambia nada para ella y se corta el caso ambiguo.
 */
import { z } from "zod";
import { SessionExerciseUpdate } from "@/lib/validation";

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
    allowRoomConflict: z.boolean().optional(),
    // T3 (C-AS3): pasar el tope por intervalo del profesional (queda sobreturno). Sin esto, `.strict()` rechazaba
    // el reintento del drawer de Seguimiento con el flag nuevo como «input inválido».
    allowIntervalCap: z.boolean().optional(),
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

// S27b (ES3): `AddCustomSessionInput` se retiró con la sesión a medida legacy;
// la sesión a medida va por el motor (`addPlanSessions` en modo `custom`).

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

// PV · HD-3: `addSessionExercise` y `reorderSessionExercises` no validaban nada. Next expone todo export de un
// "use server" como RPC, así que sets/reps negativos o enormes y notas de megas llegaban a la fila, y el reorden
// aceptaba listas de cualquier largo (el filtro `known.has` descartaba el relleno en silencio, pero recorría
// todo). Se reusan los topes de `SessionExerciseUpdate` (`lib/validation.ts`, que esta ola no se edita) para que
// agregar y editar un ejercicio de la sesión acepten lo mismo.
export const SessionExerciseAdd = z.object({
  sessionId: Id,
  exerciseId: Id,
  sets: SessionExerciseUpdate.shape.sets,
  reps: SessionExerciseUpdate.shape.reps,
  notes: SessionExerciseUpdate.shape.notes,
});
export type SessionExerciseAddT = z.input<typeof SessionExerciseAdd>;

/** Una sesión real tiene pocas decenas de ejercicios; 200 deja margen sin aceptar listas arbitrarias. */
export const SESSION_EXERCISE_REORDER_MAX = 200;

export const SessionExerciseReorder = z.object({
  sessionId: Id,
  orderedIds: z
    .array(Id)
    .max(SESSION_EXERCISE_REORDER_MAX, `Demasiados ejercicios (máx. ${SESSION_EXERCISE_REORDER_MAX}).`),
});
export type SessionExerciseReorderT = z.input<typeof SessionExerciseReorder>;
