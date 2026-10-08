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
 * Deadlocks (Planes S07i, contrato C2 / ADR-004; enmienda de AUDIT §5.28):
 * el invariante es un ORDEN GLOBAL de las claves, no "una transacción toma los
 * días de un solo turno" (lo que decía este comentario antes, y que ya era
 * falso: el candado de día y los bloqueos multi-día de `lib/time-blocks.ts`
 * toman profesionales × servicios × días en una tx). Toda tx que tome más de
 * una clave de cupo las toma ordenadas por (tenantId, practitionerId,
 * serviceId, dayKey), cada componente con el compare de strings por defecto
 * de JS — el mismo orden que los `for` anidados con `sort()` de
 * `lockCapacityScope` (time-blocks) y que `lockCapacityWindow` (un par
 * profesional+servicio, días ascendentes). Con un orden total compartido, dos
 * transacciones nunca se esperan en ciclo: una tx puede tomar los días de N
 * turnos (un plan, "este y los siguientes") SI LOS ORDENA, y para eso está
 * `lockCapacityMany`.
 *
 * Orden respecto de los otros locks (C2): `lockPlanPatient` (lib/plan-lock.ts)
 * SIEMPRE antes que el cupo; el cupo antes que la SALA (SR, enmienda C2 (1b),
 * ver el bloque de salas abajo); la sala antes que `lockTenantLocationsShared`;
 * y recién después las filas (Booking FOR UPDATE id asc → Session →
 * TreatmentProgram).
 *
 * Alcance de transacción: se suelta solo en COMMIT/ROLLBACK. Llamarlo fuera
 * de un `runWithRls(...)` / `$transaction` no protege nada.
 */

/** Una clave de cupo: (profesional, servicio, día AR) dentro de un tenant. */
export type CapacityLockKey = {
  tenantId: string;
  practitionerId: string;
  serviceId: string;
  dayKey: string;
};

/** La clave textual del advisory lock (exportada para los tests de carrera). */
export const capacityLockKey = (o: CapacityLockKey) =>
  `kinesoft:cap:${o.tenantId}:${o.practitionerId}:${o.serviceId}:${o.dayKey}`;

/** Compare de strings por defecto de JS (code units UTF-16), el de `Array#sort()`. */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Claves deduplicadas y en el orden global del contrato C2, como strings
 * listas para el advisory lock. Se ordena POR COMPONENTE y no por el string
 * concatenado a propósito: así coincide exactamente con los `for` anidados de
 * `lockCapacityScope` aunque algún id tuviera largo distinto (con largos
 * distintos, ordenar "a:…" vs "a1:…" concatenado puede invertir el orden de
 * los componentes, porque ':' va después de los dígitos).
 */
export function orderedCapacityLockKeys(keys: readonly CapacityLockKey[]): string[] {
  const sorted = [...keys].sort(
    (a, b) =>
      cmp(a.tenantId, b.tenantId) ||
      cmp(a.practitionerId, b.practitionerId) ||
      cmp(a.serviceId, b.serviceId) ||
      cmp(a.dayKey, b.dayKey)
  );
  const out: string[] = [];
  const seen = new Set<string>();
  for (const k of sorted) {
    const s = capacityLockKey(k);
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * Las claves de cupo que necesita una ventana [start, end): el día AR del
 * inicio y, si la fila cruza la medianoche AR, el siguiente (C2 (1)). Para N
 * filas: `rows.flatMap(capacityKeysForWindow)` y después `lockCapacityMany`.
 */
export function capacityKeysForWindow(o: {
  tenantId: string;
  practitionerId: string;
  serviceId: string;
  start: Date;
  end: Date;
}): CapacityLockKey[] {
  const from = dayKeyOf(o.start);
  const to = dayKeyOf(new Date(Math.max(o.start.getTime(), o.end.getTime() - 1)));
  return dayKeyRange(from, to).map((dayKey) => ({
    tenantId: o.tenantId,
    practitionerId: o.practitionerId,
    serviceId: o.serviceId,
    dayKey,
  }));
}

/** Lock exclusivo del cupo de (profesional, servicio) en un día AR. */
export async function lockCapacity(tx: DbClient, o: CapacityLockKey): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${capacityLockKey(o)}, 0))`;
}

/**
 * Toma TODAS las claves de cupo en UNA sentencia (C2 (1); C8, firma congelada).
 *
 * Por qué una sola sentencia: el commit de un plan toma los días de hasta 60
 * turnos y el presupuesto es ≤ 60 statements para 20 filas; una ida y vuelta
 * por clave se lo comería. El orden lo fija JS (`orderedCapacityLockKeys`) y
 * la sentencia lo respeta: `WITH ORDINALITY … ORDER BY o` en la subconsulta
 * hace que `pg_advisory_xact_lock` se evalúe fila por fila en ese orden, así
 * que la tx espera en la primera clave ocupada SIN tener tomadas las
 * posteriores (lo que prueba `locks-order.test.ts` mirando `pg_locks`).
 * Sentencia literal del contrato; no se cambia sin enmendar C2.
 *
 * Lista vacía: no-op sin ida a la base.
 */
export async function lockCapacityMany(tx: DbClient, keys: readonly CapacityLockKey[]): Promise<void> {
  await lockOrderedKeys(tx, orderedCapacityLockKeys(keys));
}

/**
 * La sentencia literal de C2 (1) sobre un array YA ordenado. Privada: el único
 * lugar donde vive el SQL, para que `lockCapacityMany` y
 * `lockCapacityAndRoomsMany` (SR, enmienda C2 (1b)) no puedan divergir.
 * Lista vacía: no-op sin ida a la base.
 */
async function lockOrderedKeys(tx: DbClient, ordered: string[]): Promise<void> {
  if (ordered.length === 0) return;
  await tx.$executeRaw`SELECT count(pg_advisory_xact_lock(hashtextextended(k, 0))) FROM (SELECT k FROM unnest(${ordered}::text[]) WITH ORDINALITY u(k, o) ORDER BY o) s`;
}

/**
 * Lockea, en orden, todos los días AR que toca [start, end) (el del inicio y,
 * si el turno cruza la medianoche AR, el siguiente). Es lo que usan los
 * write-paths de un turno: uno de 23:30 a 00:30 compite con los dos días.
 * Delega en `lockCapacityMany` (S07i): mismas claves y mismo orden que antes
 * (un par profesional+servicio, días ascendentes), en una sola sentencia.
 */
export async function lockCapacityWindow(
  tx: DbClient,
  o: { tenantId: string; practitionerId: string; serviceId: string; start: Date; end: Date }
): Promise<void> {
  await lockCapacityMany(tx, capacityKeysForWindow(o));
}

// ─────────────────────────────────────────────────────────────────────────────
// Salas (corrida SR, enmienda C2 (1b)): paciente → cupo → SALA → sedes → filas
// ─────────────────────────────────────────────────────────────────────────────
//
// El bug que evita: `Room.capacity` = cuántos PROFESIONALES atienden a la vez
// en la sala (SR-D1). El chequeo (`countRoomOverlapsInTx`, SR1d) es un SELECT
// seguido del INSERT/UPDATE, igual que el cupo: dos altas simultáneas de
// profesionales DISTINTOS en un consultorio de capacidad 1 leían las dos "0
// ocupados" y escribían las dos. El lock de cupo no las serializa porque su
// clave es por profesional + servicio, y acá los profesionales son distintos.
//
// Por eso hay una clave por (tenant, sala, día AR), con el mismo razonamiento
// de días que el cupo: si dos turnos se solapan en la sala, comparten al menos
// un día AR de los que cubren.
//
// Orden (C2 (1b)): la sala va DESPUÉS del cupo y ANTES de las sedes. Cupo y
// sala se toman en UNA sola sentencia (`lockCapacityAndRoomsMany`): el array
// es `orderedCapacityLockKeys(cap) ++ orderedRoomLockKeys(rooms)`, con la
// misma SQL `WITH ORDINALITY … ORDER BY o`. Así el statement count del alta con
// sala no suma una ida por el lock, y el orden global (todo cupo antes que toda
// sala) es el mismo para cualquier tx: dos tx nunca se esperan en ciclo.
//
// Sin sala, los callers siguen con `lockCapacityWindow`: 0 statements nuevos
// (perf estricto de createBooking/updateBooking/batch intacto). Los prefijos
// "kinesoft:cap:" y "kinesoft:room:" no se pisan, y tampoco con
// "kinesoft:room-schedule:<tenantId>" (Configuración, SR1c), que NUNCA toma un
// write-path de turnos.
//
// Quién NO toma la clave de sala (SR-D3): Planes, "este y los siguientes" y el
// turnero estampan la sala por defecto sin chequear ocupación.

/** Una clave de sala: (sala, día AR) dentro de un tenant. */
export type RoomLockKey = { tenantId: string; roomId: string; dayKey: string };

/** La clave textual del advisory lock de sala (exportada para los tests de carrera). */
export const roomLockKey = (o: RoomLockKey) => `kinesoft:room:${o.tenantId}:${o.roomId}:${o.dayKey}`;

/**
 * Las claves de sala de una ventana [start, end): el día AR del inicio y, si
 * cruza la medianoche AR, el siguiente (mismo criterio que
 * `capacityKeysForWindow`).
 */
export function roomKeysForWindow(o: { tenantId: string; roomId: string; start: Date; end: Date }): RoomLockKey[] {
  const from = dayKeyOf(o.start);
  const to = dayKeyOf(new Date(Math.max(o.start.getTime(), o.end.getTime() - 1)));
  return dayKeyRange(from, to).map((dayKey) => ({ tenantId: o.tenantId, roomId: o.roomId, dayKey }));
}

/**
 * Claves de sala deduplicadas y ordenadas por (tenantId, roomId, dayKey),
 * POR COMPONENTE (mismo motivo que `orderedCapacityLockKeys`: ids de largo
 * distinto no invierten el orden).
 */
export function orderedRoomLockKeys(keys: readonly RoomLockKey[]): string[] {
  const sorted = [...keys].sort(
    (a, b) => cmp(a.tenantId, b.tenantId) || cmp(a.roomId, b.roomId) || cmp(a.dayKey, b.dayKey)
  );
  const out: string[] = [];
  const seen = new Set<string>();
  for (const k of sorted) {
    const s = roomLockKey(k);
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * El array exacto que bloquea `lockCapacityAndRoomsMany`: todo el cupo
 * ordenado y después todas las salas ordenadas. Exportado para el unit test
 * de orden y para los tests de carrera (`pg_locks`).
 */
export function orderedCapacityAndRoomLockKeys(
  cap: readonly CapacityLockKey[],
  rooms: readonly RoomLockKey[]
): string[] {
  return [...orderedCapacityLockKeys(cap), ...orderedRoomLockKeys(rooms)];
}

/**
 * Cupo + sala en UNA sentencia (enmienda C2 (1b)). Lo usan los write-paths que
 * chequean ocupación de sala (alta y edición sueltas, `rescheduleSession` vía
 * el core) SOLO cuando el turno tiene sala; sin sala, `lockCapacityWindow`.
 * También sirve con `cap` vacío (p. ej. un bloqueo de sala que tiene que
 * serializarse contra las altas en esa sala): sigue siendo una sentencia.
 * Ambas listas vacías: no-op sin ida a la base.
 */
export async function lockCapacityAndRoomsMany(
  tx: DbClient,
  cap: readonly CapacityLockKey[],
  rooms: readonly RoomLockKey[]
): Promise<void> {
  await lockOrderedKeys(tx, orderedCapacityAndRoomLockKeys(cap, rooms));
}
