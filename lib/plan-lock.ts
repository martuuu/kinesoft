import "server-only";
import { Prisma } from "@prisma/client";
import type { DbClient } from "@/lib/rls";

/**
 * Lock de ESTRUCTURA de los planes de un paciente (Planes S07i, contrato C2 (0);
 * ADR-004, enmienda de AUDIT §5.28).
 *
 * Clave `kinesoft:plan-patient:<tenantId>:<patientId>`, advisory EXCLUSIVO con
 * alcance de transacción y el mismo hash que `lib/booking-cap-lock.ts`
 * (`hashtextextended(k, 0)`, la forma de un bigint que lee
 * `tests/helpers/advisory-wait.ts`).
 *
 * Por qué por paciente y no por programa: crear un plan, adoptar turnos o
 * re-planificar compiten por los MISMOS turnos y slots del paciente aunque
 * sean planes distintos (dos drawers abiertos creando el segundo plan, adoptar
 * un turno que otro plan está por generar). Serializar por paciente cierra esas
 * carreras sin frenar al resto del consultorio.
 *
 * Reglas del contrato (literal en C2):
 *   - Solo lo toman las operaciones que cambian la ESTRUCTURA de un plan:
 *     crear, generar, re-planificar, mover en serie, agregar o archivar
 *     sesiones, cambiar de estado, cambiar el precio, adoptar y sacar.
 *   - SIEMPRE se toma primero, antes que cualquier lock de cupo
 *     (`lockCapacityMany`), de sedes o de filas.
 *   - Ninguna función que corra con un lock de cupo tomado lo pide.
 *     `applyBookingUpdateInTx` nunca lo pide: un "solo este" desde la agenda
 *     toma cupo → sedes → Booking → Session, y si además pidiera este lock
 *     invertiría el orden contra un "mover en serie" (paciente → cupos) y
 *     abriría el ciclo de espera que el orden global evita.
 *
 * Alcance de transacción: se suelta solo en COMMIT/ROLLBACK. Fuera de un
 * `runWithRls(...)` no protege nada.
 */
export const planPatientLockKey = (o: { tenantId: string; patientId: string }) =>
  `kinesoft:plan-patient:${o.tenantId}:${o.patientId}`;

/** Lock exclusivo de la estructura de planes del paciente. Va PRIMERO en la tx. */
export async function lockPlanPatient(tx: DbClient, o: { tenantId: string; patientId: string }): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${planPatientLockKey(o)}, 0))`;
}

/**
 * ¿El error es un conflicto de concurrencia que amerita reintentar la tx
 * completa? (C2, "Reintento: P2034/40P01 → un reintento").
 *   - P2034: Prisma lo tira cuando Postgres aborta por write conflict o
 *     deadlock en una tx interactiva.
 *   - 40P01 (deadlock_detected) desde un `$executeRaw`/`$queryRaw`: llega como
 *     P2010 con `meta.code`, o como error desconocido con el SQLSTATE en el
 *     mensaje según la versión del engine; se miran las dos formas.
 * Con el orden global de C2 no debería haber deadlocks entre caminos del repo;
 * el reintento cubre lo que queda (p. ej. un lock de fila implícito de una FK).
 */
export function isRetryableTxConflict(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (e.code === "P2034") return true;
    const meta = e.meta as { code?: unknown } | undefined;
    if (meta?.code === "40P01") return true;
    return /40P01|deadlock detected/i.test(e.message);
  }
  if (e instanceof Prisma.PrismaClientUnknownRequestError) {
    return /40P01|deadlock detected/i.test(e.message);
  }
  return false;
}

/**
 * Corre `run` (que abre su propia tx completa, típicamente un `runWithRls`) y,
 * si falla por P2034/40P01, lo corre UNA vez más. Un solo reintento a
 * propósito: un segundo conflicto seguido indica contención real o un bug de
 * orden, y tiene que salir como error, no quedar escondido en un loop.
 * `run` tiene que ser re-ejecutable desde cero (todo lo que escribe vive en la
 * tx que se revirtió; nada de efectos post-commit adentro).
 */
export async function withTxConflictRetry<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (!isRetryableTxConflict(e)) throw e;
    return run();
  }
}
