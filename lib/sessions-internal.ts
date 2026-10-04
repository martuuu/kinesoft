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
 *   - NO autocompletan el plan: el autocompletado por conteo sigue en
 *     `completeSessionFromSeguimiento` hasta P2 (D22 lo reemplaza por "sugerir
 *     el alta").
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
    if (post != null) {
      await tx.evaScore.create({
        data: { patientId: s.program.patientId, value: post, source: `session-${s.index}-post`, takenAt: p.now },
      });
    }
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

export type ReopenSessionReason = "not-found" | "not-completed" | "touched";

/**
 * Reabre una sesión realizada SOLO si nadie le cargó evolución ("untouched",
 * C4): `notes`, `rpe`, `paInPre` y `paInPost` en null y ningún
 * `SessionExercise` en un estado distinto de PENDING. Desde P2 (S12b) suma
 * "sin EvaScore con ese `sessionId`" (la columna llega con M1).
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
 * `now` es parte de la firma congelada (C8) para los chequeos de P2; hoy no se usa.
 */
export async function reopenSessionIfUntouchedInTx(
  tx: DbClient,
  p: { tenantId: string; sessionId: string; now: Date }
): Promise<{ reopened: boolean; reason?: ReopenSessionReason }> {
  const rows = await tx.$queryRaw<
    { completedAt: Date | null; notes: string | null; rpe: number | null; paInPre: number | null; paInPost: number | null }[]
  >`
    SELECT s."completedAt", s.notes, s.rpe, s."paInPre", s."paInPost"
    FROM "Session" s
    JOIN "TreatmentProgram" tp ON tp.id = s."programId"
    WHERE s.id = ${p.sessionId} AND tp."tenantId" = ${p.tenantId}
    FOR UPDATE OF s`;
  const s = rows[0];
  if (!s) return { reopened: false, reason: "not-found" };
  if (s.completedAt === null) return { reopened: false, reason: "not-completed" };
  if (s.notes !== null || s.rpe !== null || s.paInPre !== null || s.paInPost !== null) {
    return { reopened: false, reason: "touched" };
  }
  const worked = await tx.sessionExercise.count({
    where: { sessionId: p.sessionId, status: { not: "PENDING" } },
  });
  if (worked > 0) return { reopened: false, reason: "touched" };

  await tx.session.update({ where: { id: p.sessionId }, data: { completedAt: null } });
  return { reopened: true };
}
