/**
 * Clase de un instante (B2.1b) — puro, sin DB ni reloj propio (`now` lo pasa
 * el caller). Lo usan el alta suelta (avisos blandos `outOfHours`/`blocked`),
 * el batch (`classifyBatchInstant`), `nextFreeSlot` y, más adelante, Planes.
 *
 * Precedencia (contrato `InstantClass` de `types.ts`):
 *   duplicado > bloqueado > fuera-de-horario > paciente-superpuesto > sobreturno > libre
 * "paciente-superpuesto" antes que "sobreturno" porque así lo chequea el
 * clasificador del batch de hoy (`classifyBatchSlot`: primero el paciente,
 * después el cupo) y el batch los muestra a los dos como "sobreturno".
 *
 * Reglas (heredadas de `classifyBatchSlot`, `lib/booking-schedule.ts`):
 *   • duplicado: el paciente ya tiene un turno que arranca EN ese instante,
 *     cualquier fila no cancelada (incluso una reserva pública vencida: el
 *     índice único parcial la sigue rechazando).
 *   • paciente-superpuesto: el paciente tiene otro turno solapado, cualquier
 *     profesional/servicio. Sin paciente (guest) no se chequea.
 *   • cupo: profesional + servicio (decisión 5), contando solo lo que
 *     `isHoldingCapacity` sostiene y decidido por `overlapBlocks` — preservar
 *     AUDIT §5.18, sin lógica de cupo propia.
 *   • Solape = intervalos semiabiertos: tocarse en el borde no es solape.
 * Nuevo respecto del batch:
 *   • bloqueado: un TimeBlock del profesional (o de todos, practitionerId
 *     null) que pisa [when, when + duración), aunque sea en parte. Sede: un
 *     bloqueo de todas las sedes (locationId null) aplica siempre; uno de una
 *     sede concreta solo a esa sede. Sin sede pedida, la sede sale de las
 *     franjas donde entra el turno (bloqueado solo si TODAS esas sedes están
 *     bloqueadas); fuera de horario, cualquier bloqueo cuenta (conservador).
 *     `NO_LOCATION_ID` ("", sin sede principal) es una sede más: un bloqueo de
 *     sede concreta no la tapa, uno de todas las sedes sí (acuerdo de B2.2).
 *   • fuera-de-horario: [when, when + duración) no entra ENTERO en las franjas
 *     de UNA sede del día AR de `when` (franjas contiguas de la misma sede se
 *     unen, de sedes distintas no: el turno lleva una sede). Un turno que
 *     cruza la medianoche AR siempre queda fuera.
 *
 * Franjas: `rangesFor(practitionerId, dayKey)` inyectada — normalmente
 * `workingRanges` de `ranges.ts` (B2.1a) sobre el `AvailabilityInput`. OJO:
 * para que los flags salgan bien tiene que devolver las franjas SIN restarles
 * los bloqueos (plantilla + excepción); si se las pasa ya restadas, la clase
 * no cambia (bloqueado gana), pero `outOfHours` sale true también para un
 * instante bloqueado dentro del horario.
 */
import { isHoldingCapacity, overlapBlocks } from "@/lib/booking-capacity";
import type { BatchSlotStatus } from "@/lib/booking-schedule";
import { toARDateKey, toARMinutes } from "@/lib/datetime-ar";
import { dayKeyOf, dayWindow } from "@/lib/availability/day";
import type {
  AvailabilityBooking,
  DayKey,
  InstantClassification,
  ScheduleRange,
  TimeBlockInput,
} from "@/lib/availability/types";

/** Franjas de trabajo de un profesional en un día AR (sin restar bloqueos). */
export type RangesFor = (practitionerId: string, dayKey: DayKey) => ReadonlyArray<ScheduleRange>;

export type ClassifyInstantInput = {
  when: Date;
  durationMin: number;
  /** null/undefined = guest: sin chequeos de duplicado ni superposición. */
  patientId?: string | null;
  practitionerId: string;
  serviceId: string;
  /** Sede del turno. null/undefined = cualquiera (la deciden las franjas, ver
   *  cabecera). `NO_LOCATION_ID` ("") es un valor concreto, no "cualquiera". */
  locationId?: string | null;
  /** Cupo efectivo del profesional + servicio; null = ilimitado. */
  cap: number | null;
  rangesFor: RangesFor;
  /** Bloqueos vigentes (el loader ya excluyó `deletedAt`). */
  blocks: ReadonlyArray<TimeBlockInput>;
  /** Turnos no cancelados (de cualquier profesional: el chequeo del paciente
   *  los necesita a todos). */
  bookings: ReadonlyArray<AvailabilityBooking>;
  now: Date;
  /** Turno que se está editando: no cuenta contra sí mismo. */
  excludeBookingId?: string | null;
};

const MIN_MS = 60_000;

const overlapsWindow = (b: { scheduledFor: Date; durationMin: number }, start: Date, end: Date) =>
  b.scheduledFor < end && new Date(b.scheduledFor.getTime() + b.durationMin * MIN_MS) > start;

/**
 * ¿[startMin, startMin + durationMin) entra entero en una franja? `startMin`
 * puede ser fraccionario (segundos). Las franjas de la MISMA sede que se tocan
 * o pisan se toman como una sola (igual que `normalize` de `ranges.ts`); dos
 * sedes nunca se unen: el turno lleva una sede. Con `locationId`, solo esa sede.
 */
export function fitsInRanges(
  ranges: ReadonlyArray<ScheduleRange>,
  startMin: number,
  durationMin: number,
  locationId?: string | null
): boolean {
  const endMin = startMin + durationMin;
  const pool = locationId == null ? ranges : ranges.filter((r) => r.locationId === locationId);
  // Camino rápido: entra en una franja tal cual viene.
  if (pool.some((r) => r.startMin <= startMin && endMin <= r.endMin)) return true;
  // Si no, extender por sede encadenando franjas contiguas desde la que contiene el inicio.
  for (const r of pool) {
    if (!(r.startMin <= startMin && startMin < r.endMin)) continue;
    let reach = r.endMin;
    let grew = true;
    while (grew && reach < endMin) {
      grew = false;
      for (const o of pool) {
        if (o.locationId === r.locationId && o.startMin <= reach && o.endMin > reach) {
          reach = o.endMin;
          grew = true;
        }
      }
    }
    if (endMin <= reach) return true;
  }
  return false;
}

/**
 * Intervalo efectivo de un bloqueo, con la misma regla que `ranges.ts`: un
 * `allDay` cubre los días AR completos que toca aunque las horas guardadas
 * vengan corridas (lo que el usuario ve marcado "todo el día"). Así la grilla
 * (`buildSlots` sobre `workingRanges`) y la clase coinciden.
 */
function blockInterval(b: TimeBlockInput): { start: Date; end: Date } {
  if (!b.allDay) return { start: b.startsAt, end: b.endsAt };
  return {
    start: dayWindow(dayKeyOf(b.startsAt)).start,
    end: dayWindow(dayKeyOf(new Date(Math.max(b.startsAt.getTime(), b.endsAt.getTime() - 1)))).end,
  };
}

/** Bloqueos que pisan [start, end) para ese profesional (y sede, si se dice),
 *  en el orden de entrada. */
export function blocksHitting(
  blocks: ReadonlyArray<TimeBlockInput>,
  q: { practitionerId: string; locationId?: string | null; start: Date; end: Date }
): TimeBlockInput[] {
  return blocks.filter((b) => {
    if (b.practitionerId != null && b.practitionerId !== q.practitionerId) return false;
    if (b.locationId != null && q.locationId != null && b.locationId !== q.locationId) return false;
    const { start, end } = blockInterval(b);
    return start < q.end && end > q.start;
  });
}

/**
 * Turnos del paciente que se superponen con [when, when + duración)
 * (semiabierto: tocarse en el borde no es solape), de cualquier profesional o
 * servicio, en el orden de entrada. Sin paciente (guest) → vacío.
 *
 * Aditivo de S07p (Planes, ES1): el preview del plan muestra CON QUÉ turnos
 * choca la fila ("Se superpone con otro turno del paciente") y `classifyInstant`
 * solo dice si hay alguno. Es el mismo predicado que usa `evaluate` para
 * `patientOverlap`; se deja `evaluate` sin tocar para no mover la paridad del
 * batch (AUDIT §5.27).
 */
export function patientConflictsAt<B extends { id: string; patientId: string | null; scheduledFor: Date; durationMin: number }>(
  bookings: ReadonlyArray<B>,
  q: { patientId: string | null | undefined; when: Date; durationMin: number; excludeBookingId?: string | null }
): B[] {
  if (!q.patientId) return [];
  const end = new Date(q.when.getTime() + q.durationMin * MIN_MS);
  return bookings.filter(
    (b) => b.patientId === q.patientId && b.id !== q.excludeBookingId && overlapsWindow(b, q.when, end)
  );
}

/** Minutos de pared AR de `d`, con los segundos como fracción. El offset AR es
 *  de horas enteras, así que los segundos UTC son los AR. */
function arMinutesExact(d: Date): number {
  const subMinuteMs = ((d.getTime() % MIN_MS) + MIN_MS) % MIN_MS;
  return toARMinutes(d) + subMinuteMs / MIN_MS;
}

type Parts = {
  duplicate: boolean;
  patientOverlap: boolean;
  outOfHours: boolean;
  blockIds: string[];
  used: number;
  atCapacity: boolean;
};

/** Reloj de pared AR de `when`, ya calculado (ver `classifyInstantAt`). */
export type ArWall = { dayKey: DayKey; startMin: number };

/** `ArWall` de un instante (dos `Intl` por llamada: para un barrido usar
 *  `classifyInstantAt` con el reloj ya calculado). */
export function arWallOf(when: Date): ArWall {
  return { dayKey: toARDateKey(when), startMin: arMinutesExact(when) };
}

function evaluate(input: ClassifyInstantInput, wall: ArWall): Parts {
  const { when, durationMin, patientId, practitionerId, serviceId, now } = input;
  const end = new Date(when.getTime() + durationMin * MIN_MS);
  const rows = input.excludeBookingId
    ? input.bookings.filter((b) => b.id !== input.excludeBookingId)
    : input.bookings;

  let duplicate = false;
  let patientOverlap = false;
  if (patientId) {
    // Paciente: todas las filas (el índice único rechaza aunque esté vencida).
    duplicate = rows.some((b) => b.patientId === patientId && +b.scheduledFor === +when);
    patientOverlap = rows.some((b) => b.patientId === patientId && overlapsWindow(b, when, end));
  }

  const used = rows.filter(
    (b) =>
      b.practitionerId === practitionerId &&
      b.serviceId === serviceId &&
      isHoldingCapacity(b, now) &&
      overlapsWindow(b, when, end)
  ).length;

  const ranges = input.rangesFor(practitionerId, wall.dayKey);
  const { startMin } = wall;
  const outOfHours = !fitsInRanges(ranges, startMin, durationMin, input.locationId);

  const hit = (locationId: string | null | undefined) =>
    blocksHitting(input.blocks, { practitionerId, locationId, start: when, end });
  let blockIds: string[];
  if (input.locationId != null) {
    blockIds = hit(input.locationId).map((b) => b.id);
  } else {
    // Sin sede pedida: la sede la deciden las franjas donde el turno entra. Si
    // alguna de esas sedes queda libre de bloqueos, no está bloqueado (un
    // bloqueo de la sede B no tapa la franja de la sede A, ni la franja
    // fallback `NO_LOCATION_ID`). Fuera de horario no hay sede que inferir:
    // cualquier bloqueo cuenta (conservador).
    const sedes = Array.from(new Set(ranges.map((r) => r.locationId))).filter((loc) =>
      fitsInRanges(ranges, startMin, durationMin, loc)
    );
    if (sedes.length === 0) {
      blockIds = hit(undefined).map((b) => b.id);
    } else {
      const perSede = sedes.map((loc) => hit(loc));
      const ids = perSede.some((h) => h.length === 0) ? new Set<string>() : new Set(perSede.flat().map((b) => b.id));
      blockIds = input.blocks.filter((b) => ids.has(b.id)).map((b) => b.id); // orden de entrada
    }
  }

  return { duplicate, patientOverlap, outOfHours, blockIds, used, atCapacity: overlapBlocks(used, input.cap) };
}

/**
 * Clase de un instante con sus flags (ver cabecera). `used` = turnos que
 * sostienen cupo y solapan (mismo profesional + servicio); `cap` = el pedido.
 */
export function classifyInstant(input: ClassifyInstantInput): InstantClassification {
  return classifyInstantAt(input, arWallOf(input.when));
}

/**
 * `classifyInstant` con el reloj de pared AR ya calculado. Para barridos
 * (`nextFreeSlot`): `toARDateKey`/`toARMinutes` usan `Intl` y, llamados en
 * cada paso de 15 min × 14 días × N profesionales, dominaban el costo. `wall`
 * TIENE que corresponder a `input.when` (no se verifica).
 */
export function classifyInstantAt(input: ClassifyInstantInput, wall: ArWall): InstantClassification {
  const p = evaluate(input, wall);
  const blocked = p.blockIds.length > 0;
  const cls = p.duplicate
    ? "duplicado"
    : blocked
      ? "bloqueado"
      : p.outOfHours
        ? "fuera-de-horario"
        : p.patientOverlap
          ? "paciente-superpuesto"
          : p.atCapacity
            ? "sobreturno"
            : "libre";
  return { class: cls, outOfHours: p.outOfHours, blocked, blockIds: p.blockIds, used: p.used, cap: input.cap };
}

/** Lo que el batch necesita por fecha: el status de hoy + los flags nuevos. */
export type BatchInstantClassification = {
  status: BatchSlotStatus;
  outOfHours: boolean;
  blocked: boolean;
  blockIds: ReadonlyArray<string>;
  used: number;
  cap: number | null;
};

/**
 * Para el multi-turno (B3.1): `status` es EXACTAMENTE el de `classifyBatchSlot`
 * cuando no hay bloqueos (paridad en el test), cualesquiera sean las franjas:
 *   • fuera de horario NO cambia el status — es el flag `outOfHours`, solo
 *     aviso (decisión 2; el diseño pide un flag, no un BatchSlotStatus nuevo);
 *   • un bloqueo sube "libre" a "sobreturno": el staff lo puede crear, pero
 *     confirmándolo como sobreturno (decisión 1). "duplicado" no se toca.
 */
export function classifyBatchInstant(input: ClassifyInstantInput): BatchInstantClassification {
  const p = evaluate(input, arWallOf(input.when));
  const blocked = p.blockIds.length > 0;
  const status: BatchSlotStatus = p.duplicate
    ? "duplicado"
    : p.patientOverlap || p.atCapacity || blocked
      ? "sobreturno"
      : "libre";
  return { status, outOfHours: p.outOfHours, blocked, blockIds: p.blockIds, used: p.used, cap: input.cap };
}
