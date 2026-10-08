/**
 * Salas del motor de disponibilidad (corrida SR, SR1a). Puro: sin DB, `now`
 * inyectado, reloj de pared por `lib/availability/day.ts` / `classify.ts`
 * (nunca `getDay`/`getHours` del host: Vercel es UTC).
 *
 *   defaultRoomFor      sala que toma un turno según la franja que lo contiene
 *   roomOccupancyAt     ocupación de una sala en [when, when + dur)
 *   roomAssignmentsFor  quién tiene asignada cada sala un día (vista "Por sala")
 *
 * Reglas (plan §17 / §17.5, contratos de SR-C):
 *   • `capacity` = PROFESIONALES a la vez (SR-D1). El cupo de pacientes sigue en
 *     `Service.maxConcurrent`; el mismo profesional nunca choca consigo mismo en
 *     su sala (sus pacientes en paralelo los gobierna el cupo del servicio).
 *   • La sala por defecto sale de las franjas CRUDAS (`roomRangesFor`), nunca de
 *     `scheduledRanges`: `normalize` fusiona por sede y descarta `roomId`, y así
 *     tiene que seguir (paridad de AUDIT §5.27).
 *   • Un bloqueo de sala (`RoomBlock`, TimeBlock con `roomId`) NO cambia la sala
 *     por defecto ni bloquea profesionales: para la ocupación cuenta como sala
 *     llena (aviso forzable con `allowRoomConflict`, que no es sobreturno).
 *   • La ocupación usa el MISMO predicado que el cupo: no cancelado e
 *     `isHoldingCapacity` (§5.18: la reserva pública impaga y vencida no
 *     cuenta), solape semiabierto (tocarse en el borde no choca) y
 *     `overlapBlocks(used, capacity)`. `countRoomOverlapsInTx` (SR1d) filtra con
 *     esta función, para que la agenda y el write-path digan lo mismo.
 */
import { isHoldingCapacity, overlapBlocks } from "@/lib/booking-capacity";
import { arWallOf } from "@/lib/availability/classify";
import { roomRangesFor, type RangesInput } from "@/lib/availability/ranges";
import {
  NO_LOCATION_ID,
  type AvailabilityBooking,
  type DayKey,
  type RoomBlock,
  type RoomOccupancy,
} from "@/lib/availability/types";

const MIN_MS = 60_000;

/**
 * Sala que toma un turno de `practitionerId` en [when, when + durationMin)
 * según sus franjas crudas de ESE día AR (plantilla vigente o la excepción que
 * manda) en la sede `locationId` (ya resuelta por el caller; null = la
 * principal, o `NO_LOCATION_ID` si el tenant no tiene).
 *
 * Con las franjas de esa sede ordenadas por (startMin, roomId; null al final):
 *   1. la primera que contiene el turno ENTERO;
 *   2. si ninguna, la primera que contiene el inicio;
 *   3. si ninguna, null.
 * La franja elegida da su `roomId` (null si no tiene sala). El fallback del
 * tenant nunca tiene sala → null. Un turno que cruza la medianoche AR no entra
 * entero en ninguna franja del día (que terminan a las 24:00): cae al paso 2.
 * Los bloqueos (de profesional o de sala) no la afectan (§17.5).
 */
export function defaultRoomFor(
  input: RangesInput,
  practitionerId: string,
  when: Date,
  durationMin: number,
  locationId: string | null /* sede ya resuelta; null = principal */
): string | null {
  const { dayKey, startMin } = arWallOf(when);
  const endMin = startMin + durationMin;
  const loc = locationId ?? input.primaryLocationId ?? NO_LOCATION_ID;
  const pool = roomRangesFor(input, practitionerId, dayKey)
    .filter((r) => r.locationId === loc)
    // Estable: dentro del mismo (startMin, roomId) conserva el orden de roomRangesFor.
    .sort((a, b) => a.startMin - b.startMin || compareNullLast(a.roomId, b.roomId));
  const hit =
    pool.find((r) => r.startMin <= startMin && endMin <= r.endMin) ??
    pool.find((r) => r.startMin <= startMin && startMin < r.endMin);
  return hit?.roomId ?? null;
}

function compareNullLast(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a.localeCompare(b);
}

export type RoomOccupancyQuery = {
  roomId: string;
  /** El profesional del turno que se evalúa: sus propios turnos no cuentan. */
  practitionerId: string;
  when: Date;
  durationMin: number;
  /** `Room.capacity` (1..50): profesionales a la vez. */
  capacity: number;
  now: Date;
  /** Edición: el turno que se mueve no cuenta contra sí mismo. */
  excludeBookingId?: string | null;
  /** Reintento de un alta: la fila con esta `idempotencyKey` no cuenta. */
  excludeKey?: string | null;
};

/**
 * Ocupación de `q.roomId` en [when, when + durationMin):
 *   • used = profesionales DISTINTOS de `q.practitionerId` con un turno en la
 *     sala que no está cancelado, `isHoldingCapacity` (§5.18) y solapa
 *     (semiabierto: tocarse en el borde no choca);
 *   • practitionerIds = esos profesionales, ordenados;
 *   • blocked = el primer `RoomBlock` de la sala (por startsAt, id) que solapa,
 *     o null;
 *   • atCapacity = blocked !== null || overlapBlocks(used, capacity).
 * `bookings` puede traer turnos de otras salas o sin sala: se filtran acá.
 */
export function roomOccupancyAt(
  bookings: ReadonlyArray<AvailabilityBooking & { roomId: string | null }>,
  q: RoomOccupancyQuery,
  roomBlocks?: ReadonlyArray<RoomBlock>
): RoomOccupancy {
  const start = q.when;
  const end = new Date(q.when.getTime() + q.durationMin * MIN_MS);
  const others = new Set<string>();
  for (const b of bookings) {
    if (b.roomId !== q.roomId) continue;
    if (b.practitionerId === q.practitionerId) continue;
    if (q.excludeBookingId && b.id === q.excludeBookingId) continue;
    if (q.excludeKey && b.idempotencyKey === q.excludeKey) continue;
    // El loader ya excluye CANCELLED; se repite acá porque `isHoldingCapacity`
    // deja ese filtro al caller (§5.18) y SR1d llama con sus propias filas.
    if (b.status === "CANCELLED") continue;
    if (!isHoldingCapacity(b, q.now)) continue;
    const bEnd = b.scheduledFor.getTime() + b.durationMin * MIN_MS;
    if (!(b.scheduledFor < end && bEnd > start.getTime())) continue;
    others.add(b.practitionerId);
  }
  const practitionerIds = Array.from(others).sort();
  const used = practitionerIds.length;

  const hit = (roomBlocks ?? [])
    .filter((r) => r.roomId === q.roomId && r.startsAt < end && r.endsAt > start)
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.id.localeCompare(b.id))[0];
  const blocked = hit ? { blockId: hit.id, reason: hit.reason } : null;

  return {
    used,
    capacity: q.capacity,
    atCapacity: blocked !== null || overlapBlocks(used, q.capacity),
    practitionerIds,
    blocked,
  };
}

/**
 * Una franja con sala de un profesional en un día (minutos de pared AR,
 * semiabierta). Estructuralmente idéntica a `RoomAssignment` de
 * `lib/availability-actions-types.ts` (contrato de SR-C); se repite acá para
 * que el motor no dependa del módulo de las actions.
 */
export type RoomAssignmentRange = { practitionerId: string; startMin: number; endMin: number };

/**
 * Para `getAgendaAvailability` (SR3a) y la vista "Por sala" (SR-U4): por
 * `roomId`, las franjas CRUDAS con sala de ese día AR (`roomRangesFor`: la
 * plantilla vigente o la excepción que manda; sin restar bloqueos) de los
 * profesionales pedidos (default: todos los de `input.templates`), ordenadas
 * por (startMin, practitionerId, endMin). Las franjas sin sala no aparecen;
 * nadie con sala → `{}`. No filtra por sede: la sala ya es de una sede (el
 * loader con `locationId` ya acotó las franjas a esa sede).
 */
export function roomAssignmentsFor(
  input: RangesInput,
  dayKey: DayKey,
  practitionerIds?: ReadonlyArray<string>
): Record<string, RoomAssignmentRange[]> {
  const ids = practitionerIds ?? input.templates.map((t) => t.practitionerId);
  const out: Record<string, RoomAssignmentRange[]> = {};
  for (const practitionerId of ids) {
    for (const r of roomRangesFor(input, practitionerId, dayKey)) {
      if (r.roomId == null) continue;
      (out[r.roomId] ??= []).push({ practitionerId, startMin: r.startMin, endMin: r.endMin });
    }
  }
  for (const list of Object.values(out)) {
    list.sort(
      (a, b) =>
        a.startMin - b.startMin || a.practitionerId.localeCompare(b.practitionerId) || a.endMin - b.endMin
    );
  }
  return out;
}
