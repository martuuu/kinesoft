import "server-only";
import type { DbClient } from "@/lib/rls";
import { dayKeyOf, dayKeyRange } from "@/lib/availability/day";

/**
 * Lock de CUPO de un profesional + servicio por día AR (B3.1, pedido del
 * orquestador: TOCTOU de cupo).
 *
 * El bug: el chequeo de cupo (`countCapacityOverlaps` en `lib/bookings.ts`,
 * el equivalente del turnero en `lib/public-booking.ts`) es un SELECT seguido
 * de un INSERT. Dos altas simultáneas de pacientes DISTINTOS en un slot de
 * cupo 1 leían las dos "0 ocupados" y escribían las dos: el índice único
 * parcial solo frena al MISMO paciente en el mismo instante, no el cupo.
 *
 * El arreglo: `pg_advisory_xact_lock` con clave
 * `kinesoft:cap:<tenantId>:<practitionerId>:<serviceId>:<dayKey AR>`, tomado
 * DENTRO de la misma transacción que cuenta y escribe, ANTES de contar. El
 * segundo espera al COMMIT del primero y, en READ COMMITTED (cada sentencia
 * con snapshot nuevo), su conteo ya ve la fila del primero.
 *
 * Por qué por día AR y no por instante: dos turnos se pisan aunque arranquen a
 * horas distintas (10:00 de 60 min vs 10:30). Si se solapan, comparten al
 * menos un día AR de los que cubren, así que lockeando TODOS los días que toca
 * [start, end) (dos como mucho: la duración tope es 240 min) cualquier par que
 * compita por el cupo se serializa. El costo es serializar altas del mismo
 * profesional + servicio en el mismo día, que no compiten en volumen.
 *
 * Deadlocks: los días se lockean SIEMPRE en orden ascendente (y una
 * transacción solo toma los días de UN turno), así que dos transacciones no
 * pueden esperarse en ciclo. El batch usa una transacción por fecha.
 *
 * Alcance de transacción: se suelta solo en COMMIT/ROLLBACK. Llamarlo fuera
 * de un `runWithRls(...)` / `$transaction` no protege nada.
 */
const key = (o: { tenantId: string; practitionerId: string; serviceId: string; dayKey: string }) =>
  `kinesoft:cap:${o.tenantId}:${o.practitionerId}:${o.serviceId}:${o.dayKey}`;

/** Lock exclusivo del cupo de (profesional, servicio) en un día AR. */
export async function lockCapacity(
  tx: DbClient,
  o: { tenantId: string; practitionerId: string; serviceId: string; dayKey: string }
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key(o)}, 0))`;
}

/**
 * Lockea, en orden, todos los días AR que toca [start, end) (el del inicio y,
 * si el turno cruza la medianoche AR, el siguiente). Es lo que usan los
 * write-paths: un turno de 23:30 a 00:30 compite con los dos días.
 */
export async function lockCapacityWindow(
  tx: DbClient,
  o: { tenantId: string; practitionerId: string; serviceId: string; start: Date; end: Date }
): Promise<void> {
  const from = dayKeyOf(o.start);
  const to = dayKeyOf(new Date(Math.max(o.start.getTime(), o.end.getTime() - 1)));
  for (const dayKey of dayKeyRange(from, to)) {
    await lockCapacity(tx, { tenantId: o.tenantId, practitionerId: o.practitionerId, serviceId: o.serviceId, dayKey });
  }
}
