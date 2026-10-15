import "server-only";

/**
 * Primitivas de sesión que corren DENTRO de la tx del caller (Planes P0 · S02s,
 * firmas congeladas en C8 de `.docs/PLANES.md`).
 *
 * Por qué existen: cerrar una sesión hoy lo hace solo Seguimiento, pero desde
 * P2 también la cierra la agenda ("Atendido" en Recepción, o pasar el turno a
 * COMPLETED en el drawer) y la reabre "Deshacer Atendido". Si cada camino
 * escribiera la sesión a su manera, el cierre idempotente (CAS sobre
 * `completedAt IS NULL`), el criterio de "untouched" y el orden de filas
 * (Booking → Session, C2 (3)) se bifurcarían. Acá hay una sola versión.
 *
 * Reglas (C8, literal):
 *   - NO gatean: el acceso `full` / `canOperateBooking` lo chequea el caller,
 *     en la misma tx, antes de llamar.
 *   - NO tocan Booking: la sincronía turno↔sesión (C4) la orquesta el caller,
 *     que ya tiene el Booking lockeado si corresponde (Booking → Session).
 *   - NO autocompletan el plan. Desde P2 (S12b, D22/PQ-09) nadie lo hace:
 *     `completeSessionFromSeguimiento` SUGIERE el alta y el kine decide.
 *   - Todo `where` lleva `program: { tenantId }` a mano: en prod la conexión
 *     es BYPASSRLS y esa es la única barrera (AUDIT §5.1).
 *
 * Server-only (AUDIT §5.12): no es una server action; no se puede llamar por RPC.
 */
import type { z } from "zod";
import type { DbClient } from "@/lib/rls";
import { auditInTx } from "@/lib/audit";
import type { SessionMeta } from "@/lib/validation";

export type SessionMetaParsed = z.output<typeof SessionMeta>;

export type CompleteSessionInTxParams = {
  tenantId: string;
  sessionId: string;
  /** Quién cierra (para el audit). `null` = sin usuario (no debería pasar con un Actor real). */
  actorId: string | null;
  /**
   * `'seguimiento'`: el cierre clínico de hoy (meta en el mismo UPDATE,
   * ejercicios PENDING → DONE y EvaScore post).
   * `'booking'`: el turno pasó a COMPLETED. Escribe SOLO `completedAt`: marcar
   * "Atendido" en Recepción no es cargar la evolución, así que no inventa
   * ejercicios hechos ni EVA (C4).
   */
  source: "seguimiento" | "booking";
  /** Solo con `'seguimiento'`; ya validada con `SessionMeta`. Se ignora con `'booking'`. */
  meta?: SessionMetaParsed;
  now: Date;
};

export type CompleteSessionInTxResult = {
  /** `true` si ESTA llamada cerró la sesión; `false` si ya estaba cerrada (no-op) o no existe. */
  claimed: boolean;
  /** Programa de la sesión; `null` solo si la sesión no existe en el tenant. */
  programId: string | null;
};

/**
 * Cierra la sesión si está abierta. Idempotente: el claim es un
 * `updateMany … WHERE completedAt IS NULL`; con dos tx concurrentes Postgres
 * re-evalúa el WHERE de la segunda después del commit de la primera (READ
 * COMMITTED), así que solo una gana y la otra devuelve `claimed:false` sin
 * efectos (ni meta, ni ejercicios, ni EVA, ni audit). Es el mismo mecanismo
 * que fijó H3 (doble click duplicaba EvaScore y notificación).
 */
export async function completeSessionInTx(
  tx: DbClient,
  p: CompleteSessionInTxParams
): Promise<CompleteSessionInTxResult> {
  const s = await tx.session.findFirst({
    where: { id: p.sessionId, program: { tenantId: p.tenantId } },
    select: { index: true, programId: true, program: { select: { patientId: true } } },
  });
  if (!s) return { claimed: false, programId: null };

  const m = p.source === "seguimiento" ? (p.meta ?? {}) : {};
  const claimed = await tx.session.updateMany({
    // Filtros escalares a propósito: con un filtro de relación Prisma puede
    // resolver primero los ids y después actualizar por id, y el WHERE ya no
    // se re-evalúa bajo el lock de fila (se perdería el CAS). El tenant ya lo
    // validó el findFirst de arriba con el mismo id.
    where: { id: p.sessionId, completedAt: null },
    data:
      p.source === "booking"
        ? { completedAt: p.now }
        : { completedAt: p.now, notes: m.notes, paInPre: m.paInPre, paInPost: m.paInPost, rpe: m.rpe },
  });
  if (claimed.count === 0) return { claimed: false, programId: s.programId };

  if (p.source === "seguimiento") {
    // Los PENDING quedan DONE salvo que el kine los haya salteado explícitamente.
    await tx.sessionExercise.updateMany({
      where: { sessionId: p.sessionId, status: "PENDING" },
      data: { status: "DONE" },
    });

    // EVA post: lo que llegó en el cierre; si no vino, lo último guardado. Se
    // relee DESPUÉS del claim (la fila ya está lockeada por el UPDATE): leerlo
    // antes dejaba una ventana en la que un "Guardar anotaciones" concurrente
    // quedaba afuera de la EvaScore.
    let post = m.paInPost;
    if (post === undefined) {
      const fresh = await tx.session.findUniqueOrThrow({ where: { id: p.sessionId }, select: { paInPost: true } });
      post = fresh.paInPost;
    }
    if (post != null) await createSessionEvaInTx(tx, { patientId: s.program.patientId, sessionId: p.sessionId, index: s.index, value: post, now: p.now });
  }

  // En la misma tx: el evento existe si y solo si el cierre existe. Puntajes
  // sí (ya se auditaban); el texto de las notas es HC y no se copia.
  await auditInTx(tx, {
    tenantId: p.tenantId,
    actorId: p.actorId ?? undefined,
    action: "session.complete",
    entity: "Session",
    entityId: p.sessionId,
    payload: {
      source: p.source,
      ...(p.source === "seguimiento" ? { paInPre: m.paInPre, paInPost: m.paInPost, rpe: m.rpe } : {}),
    },
  });

  return { claimed: true, programId: s.programId };
}

/**
 * EVA post de una sesión. S12b: además del `source` de siempre
 * (`session-<index>-post`, que nadie lee por index y es ambiguo si el plan se
 * re-planifica) llena `EvaScore.sessionId` (M1): es lo que mira "untouched" y
 * lo que va a leer la curva de EVA por sesión. `note` queda null a propósito:
 * es el texto del check-in del paciente (portal, S24); copiar ahí las notas de
 * la sesión sacaría HC del registro clínico a un dato que ve el paciente.
 */
async function createSessionEvaInTx(
  tx: DbClient,
  o: { patientId: string; sessionId: string; index: number; value: number; now: Date }
): Promise<void> {
  await tx.evaScore.create({
    data: { patientId: o.patientId, value: o.value, source: `session-${o.index}-post`, sessionId: o.sessionId, takenAt: o.now },
  });
}

export type ReopenSessionReason = "not-found" | "not-completed" | "touched";

/**
 * Estado de "evolución" de una sesión, con la fila de Session lockeada
 * (`FOR UPDATE`; el caller ya tiene el Booking si corresponde, orden C2 (3)).
 *
 * "Untouched" (C4, literal): `notes`, `rpe`, `paInPre` y `paInPost` en null,
 * sin EvaScore con ese `sessionId` (desde P2, S12b) y sin `SessionExercise` en
 * un estado distinto de PENDING. Una sola sentencia (los `EXISTS` van en
 * la misma fila): `reopenSessionIfUntouchedInTx` corre dentro de
 * `updateBooking`/Recepción, que tienen techo estricto de sentencias.
 *
 * EV2-2d (EV2-D18): también cuenta una evolución de HC (`ClinicalNote`) RAÍZ
 * VIVA (no enmienda, no anulada) del turno ACTIVO de la sesión (el del índice
 * `Booking_session_active_key`: status fuera de CANCELLED/NO_SHOW). Va como un
 * `EXISTS` más en esta misma sentencia (0 sentencias nuevas: el techo de
 * `updateBooking*` no se mueve), por `Booking_sessionId_idx` y
 * `ClinicalNote_bookingId_idx` (M9). Sin filtro de tenant propio: el turno
 * cuelga de la sesión ya acotada por `tp.tenantId` y la FK compuesta
 * (bookingId, tenantId, patientId) ata la nota al tenant del turno.
 * Consecuencia del «turno ACTIVO»: este lock corre DESPUÉS del UPDATE del
 * turno, así que COMPLETED → CANCELLED/NO_SHOW ya no ve la evolución de ese
 * turno y la sesión se reabre (queda «sin turno»; la evolución sigue en la HC,
 * colgada del turno cancelado). «Deshacer Atendido» (→ CONFIRMED/ARRIVED) sí la
 * ve y no reabre.
 * `Session.title` NO cuenta: es el nombre de la sesión, no evolución.
 */
async function lockSessionEvolutionStateInTx(
  tx: DbClient,
  tenantId: string,
  sessionId: string
): Promise<{ completedAt: Date | null; touched: boolean } | null> {
  const rows = await tx.$queryRaw<{ completedAt: Date | null; touched: boolean }[]>`
    SELECT s."completedAt",
      (s.notes IS NOT NULL OR s.rpe IS NOT NULL OR s."paInPre" IS NOT NULL OR s."paInPost" IS NOT NULL
        OR EXISTS (SELECT 1 FROM "EvaScore" e WHERE e."sessionId" = s.id)
        OR EXISTS (SELECT 1 FROM "SessionExercise" x WHERE x."sessionId" = s.id AND x.status <> 'PENDING')
        OR EXISTS (SELECT 1 FROM "Booking" b JOIN "ClinicalNote" cn ON cn."bookingId" = b.id
                   WHERE b."sessionId" = s.id AND b.status NOT IN ('CANCELLED','NO_SHOW')
                     AND cn."amendsNoteId" IS NULL AND cn."voidedAt" IS NULL)      -- touched (EV2-D18)
      ) AS touched
    FROM "Session" s
    JOIN "TreatmentProgram" tp ON tp.id = s."programId"
    WHERE s.id = ${sessionId} AND tp."tenantId" = ${tenantId}
    FOR UPDATE OF s`;
  return rows[0] ?? null;
}

/**
 * Reabre una sesión realizada SOLO si nadie le cargó evolución ("untouched",
 * C4; ver `lockSessionEvolutionStateInTx`). Desde P2 (S12b) una EvaScore con
 * ese `sessionId` también cuenta como evolución.
 *
 * Por qué no reabre siempre: "Deshacer Atendido" o pasar un turno COMPLETED a
 * CANCELLED desde el drawer no pueden borrar una evolución clínica cargada. Si
 * la sesión está tocada, queda realizada y el caller avisa.
 *
 * Concurrencia: lockea la fila de Session (`FOR UPDATE`) antes de mirar; el
 * caller ya tiene el Booking (orden C2: Booking → Session). Un "Guardar
 * anotaciones" concurrente espera ese lock y escribe sobre la sesión ya
 * reabierta (estado válido: sesión abierta con notas). Un ejercicio marcado
 * DONE en paralelo no toma el lock de Session; en el peor caso queda una
 * sesión abierta con un ejercicio hecho, que también es un estado válido.
 *
 * `now` es parte de la firma congelada (C8); hoy no se usa.
 */
export async function reopenSessionIfUntouchedInTx(
  tx: DbClient,
  p: { tenantId: string; sessionId: string; now: Date }
): Promise<{ reopened: boolean; reason?: ReopenSessionReason }> {
  const s = await lockSessionEvolutionStateInTx(tx, p.tenantId, p.sessionId);
  if (!s) return { reopened: false, reason: "not-found" };
  if (s.completedAt === null) return { reopened: false, reason: "not-completed" };
  if (s.touched) return { reopened: false, reason: "touched" };

  await tx.session.update({ where: { id: p.sessionId }, data: { completedAt: null } });
  return { reopened: true };
}

export type RecordEvolutionReason = "not-found" | "not-completed" | "touched";

/**
 * "Cargar evolución" (S12b, C4: "Si ya estaba realizada → Cargar evolución").
 * Una sesión que cerró la agenda ("Atendido", o el turno a COMPLETED en el
 * drawer) quedó realizada con SOLO `completedAt` (`source:'booking'`). Esto
 * le carga lo que el cierre de Seguimiento hubiera escrito: meta, ejercicios
 * PENDING → DONE y EVA post (con `sessionId`), en la tx del caller.
 *
 * Solo sobre una sesión realizada y "untouched": si ya tiene evolución, no
 * pisa nada (`touched`) — se edita por "Guardar anotaciones". Eso también la
 * hace idempotente: un doble click o un reintento no duplica la EVA (el
 * primero la deja tocada, y el segundo espera el lock de la fila y lo ve).
 *
 * Mismas reglas que `completeSessionInTx`: no gatea, no toca Booking, no
 * autocompleta; el audit (`session.evolution`) va en la misma tx.
 */
export async function recordSessionEvolutionInTx(
  tx: DbClient,
  p: { tenantId: string; sessionId: string; actorId: string | null; meta: SessionMetaParsed; now: Date }
): Promise<{ recorded: boolean; reason?: RecordEvolutionReason }> {
  const st = await lockSessionEvolutionStateInTx(tx, p.tenantId, p.sessionId);
  if (!st) return { recorded: false, reason: "not-found" };
  if (st.completedAt === null) return { recorded: false, reason: "not-completed" };
  if (st.touched) return { recorded: false, reason: "touched" };

  const s = await tx.session.findFirstOrThrow({
    where: { id: p.sessionId, program: { tenantId: p.tenantId } },
    select: { index: true, program: { select: { patientId: true } } },
  });
  const m = p.meta;
  const hasMeta = m.notes != null || m.paInPre != null || m.paInPost != null || m.rpe != null;
  if (hasMeta) {
    await tx.session.update({
      where: { id: p.sessionId },
      data: { notes: m.notes, paInPre: m.paInPre, paInPost: m.paInPost, rpe: m.rpe },
    });
  }
  const ex = await tx.sessionExercise.updateMany({
    where: { sessionId: p.sessionId, status: "PENDING" },
    data: { status: "DONE" },
  });
  // Untouched ⇒ `paInPost` guardado es null: la EVA sale solo de lo que llegó.
  if (m.paInPost != null) {
    await createSessionEvaInTx(tx, { patientId: s.program.patientId, sessionId: p.sessionId, index: s.index, value: m.paInPost, now: p.now });
  }
  // Nada que cargar (sin meta ni ejercicios): no-op, sin audit.
  if (!hasMeta && ex.count === 0) return { recorded: false };

  await auditInTx(tx, {
    tenantId: p.tenantId,
    actorId: p.actorId ?? undefined,
    action: "session.evolution",
    entity: "Session",
    entityId: p.sessionId,
    payload: { paInPre: m.paInPre, paInPost: m.paInPost, rpe: m.rpe, exercisesDone: ex.count },
  });
  return { recorded: true };
}
