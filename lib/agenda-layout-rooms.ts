/**
 * Layout de la vista "Por sala" (SR-U4, plan §17), puro como
 * `lib/agenda-layout.ts` (sin DB, sin React, sin reloj propio).
 *
 * Por qué es un módulo aparte (SRZ FX2a, handoff de SR-U6 §4a): `agenda-layout`
 * está en el first load de /agenda (Día, Semana, filas bloqueadas) y webpack
 * no separa un módulo por export, así que `buildRoomColumns` viajaba a todos
 * los consultorios aunque solo lo llame `RoomDayPanel`, que va con `dynamic()`.
 * SR-U6 lo midió con un proxy de esbuild: ~0,83 kB gz menos. Reglas para que
 * siga así:
 *   • solo lo importan `components/agenda/views/room-day-panel.tsx` y
 *     `room-day-view.tsx` (los dos diferidos) y los tests;
 *   • `agenda-layout.ts` NO lo re-exporta (hay un test que lo afirma);
 *   • los helpers comunes (span, carriles, filas, cupo) se importan de
 *     `agenda-layout.ts`, no se duplican.
 *
 * Mismas convenciones y reglas 1-5 que `agenda-layout.ts`, salvo lo que dice
 * el comentario de `buildRoomColumns`.
 */
import { FALLBACK_TENANT_HOURS, type DayKey } from "@/lib/availability/types";
import { NO_ROOM_LABEL, type RoomKind } from "@/lib/rooms-constants";
import {
  assignLanes,
  blockSpan,
  bookingSpan,
  capLabel,
  holdsCapacity,
  normalizeZoom,
  peakConcurrency,
  rowsOf,
  touchesDay,
  visibleWindow,
  type AgendaRow,
  type AgendaZoom,
  type LaneAssignment,
  type LayoutBlock,
  type LayoutBooking,
  type MinuteWindow,
  type SlotCell,
  type SlotState,
} from "@/lib/agenda-layout";

/** Turno con sala. `roomId` ausente (proyección sin sala) se trata como "Sin sala". */
export type RoomLayoutBooking = LayoutBooking & { roomId?: string | null };

/** Sala de la columna (forma de `RoomOption` del bootstrap de la agenda). */
export type LayoutRoom = {
  id: string;
  name: string;
  kind: RoomKind;
  /** Profesionales a la vez (SR-D1, §17.5). */
  capacity: number;
  locationId?: string | null;
};

/** Franja con sala de un profesional (`RoomAssignment` de `getAgendaAvailability`). */
export type LayoutRoomAssignment = { practitionerId: string; startMin: number; endMin: number };

/** Bloqueo de SALA (`TimeBlock.roomId`, §17.5; forma de `AgendaRoomBlockView`). */
export type LayoutRoomBlock = {
  id: string;
  roomId: string;
  startsAt: Date | string;
  endsAt: Date | string;
  reason?: string | null;
};

/** Id de la columna de turnos sin sala (mismo valor que el filtro `roomId: "none"`). */
export const NO_ROOM_COLUMN_ID = "none" as const;

export type RoomColumn<T extends LayoutBooking = LayoutBooking> = {
  roomId: string | typeof NO_ROOM_COLUMN_ID;
  name: string;
  /** null en la columna "Sin sala". */
  kind: RoomKind | null;
  /** Profesionales a la vez; null en "Sin sala" (no tiene tope). */
  capacity: number | null;
  slots: SlotCell<T>[];
  lanes: Record<string, LaneAssignment>;
  maxLanes: number;
  /** Turnos del día no cancelados de la columna. */
  bookingCount: number;
  /** Quién tiene asignada la sala ese día, por (startMin, practitionerId). [] en "Sin sala". */
  assignments: LayoutRoomAssignment[];
};

export type RoomDayLayout<T extends LayoutBooking = LayoutBooking> = {
  window: MinuteWindow;
  rows: AgendaRow[];
  columns: RoomColumn<T>[];
};

/** Pico de PROFESIONALES DISTINTOS a la vez dentro de [from, to) (SR-D1). */
function peakDistinctPractitioners(
  spans: ReadonlyArray<{ start: number; end: number; pid: string }>,
  from: number,
  to: number
): number {
  const clipped = spans
    .map((s) => ({ start: Math.max(s.start, from), end: Math.min(s.end, to), pid: s.pid }))
    .filter((s) => s.start < s.end);
  let peak = 0;
  for (const p of clipped) {
    const here = new Set(clipped.filter((s) => s.start <= p.start && p.start < s.end).map((s) => s.pid));
    if (here.size > peak) peak = here.size;
  }
  return peak;
}

/**
 * Columnas de la vista "Por sala" (SR-U4, §17): un día, una columna por sala
 * en el ORDEN DE ENTRADA (el bootstrap ya viene por sede y `sortOrder`), más
 * "Sin sala" al final SOLO si hay turnos del día sin sala (y
 * `includeUnassigned` no es false). Devuelve el mismo `SlotCell<T>` que la
 * vista por profesional, así la celda se dibuja con el mismo componente.
 *
 * Reglas propias (las 1-5 de la cabecera valen salvo esto):
 *   • `used` = PICO de profesionales DISTINTOS con turno que sostiene cupo
 *     (regla 2) en la celda; `cap` = `capacity` de la sala = profesionales a
 *     la vez (SR-D1, §17.5). El mismo profesional con 4 pacientes en el
 *     gimnasio cuenta 1: nunca choca consigo mismo (misma regla que
 *     `roomOccupancyAt` del motor). `byService` va vacío: el cupo de
 *     pacientes es de la vista por profesional.
 *   • Estado: bloqueado > "fuera-de-horario" (= ningún profesional tiene la
 *     sala asignada en la celda) > sobreturno (`used > capacity`) > lleno
 *     (`used == capacity`) > parcial > libre. `isOverbooked` del turno NO
 *     marca la sala: es sobreturno del cupo de pacientes, otra cosa (SR-D2).
 *   • Bloqueado: un bloqueo de SALA (`roomBlocks`, §17.5) de esa sala, o un
 *     bloqueo de TODOS (`blocks` con `practitionerId` null) de la sede de la
 *     sala o de todas las sedes. Los bloqueos de un profesional no pintan la
 *     sala (la sala sigue libre para otro).
 *   • "Sin sala": nunca "fuera de horario" (no hay asignación que mirar),
 *     `cap` null, sin etiqueta de ocupación, `used` = pico de turnos.
 *   • Turnos con una sala que no está en `rooms` (otra sede, sala archivada)
 *     no se dibujan: el caller decide qué salas entran.
 */
export function buildRoomColumns<T extends RoomLayoutBooking>(
  rooms: ReadonlyArray<LayoutRoom>,
  bookings: ReadonlyArray<T>,
  opts: {
    dayKey: DayKey;
    zoom: AgendaZoom;
    now: Date;
    window?: MinuteWindow;
    fallback?: MinuteWindow;
    /** Franjas con sala del día por `roomId` (`AgendaAvailabilityDay.roomAssignments`). */
    assignments: Readonly<Record<string, ReadonlyArray<LayoutRoomAssignment>>>;
    /** Bloqueos de profesionales/consultorio: solo cuentan los de TODOS. */
    blocks?: ReadonlyArray<LayoutBlock>;
    /** Bloqueos de sala (`AgendaAvailability.roomBlocks`). */
    roomBlocks?: ReadonlyArray<LayoutRoomBlock>;
    /** false = nunca agrega "Sin sala" (p. ej. con el filtro en una sala). */
    includeUnassigned?: boolean;
    /** Sede de "Sin sala" para los bloqueos de todos (null = todas). */
    locationId?: string | null;
  }
): RoomDayLayout<T> {
  const { dayKey, now } = opts;
  const zoom = normalizeZoom(opts.zoom);
  const roomIds = new Set(rooms.map((r) => r.id));
  const dayBookings = bookings.filter((b) => touchesDay(dayKey, b));
  const byRoom = new Map<string, T[]>();
  const unassigned: T[] = [];
  for (const b of dayBookings) {
    const rid = b.roomId ?? null;
    if (rid == null) unassigned.push(b);
    else if (roomIds.has(rid)) byRoom.set(rid, [...(byRoom.get(rid) ?? []), b]);
  }
  const withNone = opts.includeUnassigned !== false && unassigned.length > 0;
  const assignmentsOf = (roomId: string) =>
    (opts.assignments[roomId] ?? [])
      .filter((a) => a.startMin < a.endMin)
      .slice()
      .sort((a, b) => a.startMin - b.startMin || a.practitionerId.localeCompare(b.practitionerId));

  const window =
    opts.window ??
    visibleWindow(
      Object.fromEntries(rooms.map((r) => [r.id, assignmentsOf(r.id)])),
      opts.fallback ?? FALLBACK_TENANT_HOURS,
      { zoom, dayKey, bookings: [...rooms.flatMap((r) => byRoom.get(r.id) ?? []), ...(withNone ? unassigned : [])] }
    );
  const rows = rowsOf(window, zoom);

  const tenantBlocks = (opts.blocks ?? []).filter((b) => b.practitionerId == null);
  const spanOfBlock = (block: LayoutBlock) => ({ block, ...blockSpan(dayKey, block) });

  function column(
    id: string,
    name: string,
    kind: RoomKind | null,
    capacity: number | null,
    mine: T[],
    assignments: LayoutRoomAssignment[],
    blocks: Array<{ block: LayoutBlock; start: number; end: number }>
  ): RoomColumn<T> {
    const lanes = assignLanes(dayKey, mine);
    const spans = mine.map((b) => ({ b, ...bookingSpan(dayKey, b), pid: b.practitionerId, holds: holdsCapacity(b, now) }));
    const live = blocks.filter((x) => x.start < x.end);
    const slots = rows.map(({ startMin, endMin, time }): SlotCell<T> => {
      const touching = spans.filter((s) => s.start < endMin && s.end > startMin);
      const starting = touching
        .filter((s) => s.start >= startMin)
        .sort((a, b) => lanes[a.b.id].lane - lanes[b.b.id].lane || a.start - b.start)
        .map((s) => s.b);
      const continuing = touching.filter((s) => s.start < startMin).map((s) => s.b);
      const holding = touching.filter((s) => s.holds);
      const used =
        capacity == null ? peakConcurrency(holding, startMin, endMin) : peakDistinctPractitioners(holding, startMin, endMin);
      const cap = capacity;
      const overbooked = cap != null && used > cap;
      const outOfHours = capacity != null && !assignments.some((a) => a.startMin < endMin && a.endMin > startMin);
      const hits = live.filter((x) => x.start < endMin && x.end > startMin);
      const blocked = hits.length > 0;

      let state: SlotState;
      if (blocked) state = "bloqueado";
      else if (outOfHours) state = "fuera-de-horario";
      else if (overbooked) state = "sobreturno";
      else if (cap != null && used >= cap && used > 0) state = "lleno";
      else if (used > 0) state = "parcial";
      else state = "libre";

      return {
        startMin,
        endMin,
        time,
        bookings: starting,
        continuing,
        used,
        cap,
        label: cap != null && used > 0 ? capLabel(used, cap) : null,
        state,
        byService: [],
        total: holding.length,
        overbooked,
        outOfHours,
        blocked,
        blockIds: hits.map((x) => x.block.id),
        blockReason: hits.find((x) => x.block.reason)?.block.reason ?? null,
      };
    });
    return {
      roomId: id,
      name,
      kind,
      capacity,
      slots,
      lanes,
      maxLanes: Object.values(lanes).reduce((n, l) => Math.max(n, l.laneCount), 0),
      bookingCount: mine.filter((b) => b.status !== "CANCELLED").length,
      assignments,
    };
  }

  const columns = rooms.map((r) => {
    const loc = r.locationId ?? null;
    const blocks = [
      ...(opts.roomBlocks ?? [])
        .filter((rb) => rb.roomId === r.id)
        .map((rb) =>
          spanOfBlock({ id: rb.id, practitionerId: null, startsAt: rb.startsAt, endsAt: rb.endsAt, reason: rb.reason ?? null })
        ),
      ...tenantBlocks.filter((b) => b.locationId == null || loc == null || b.locationId === loc).map(spanOfBlock),
    ];
    return column(r.id, r.name, r.kind, r.capacity, byRoom.get(r.id) ?? [], assignmentsOf(r.id), blocks);
  });
  if (withNone) {
    const loc = opts.locationId ?? null;
    const blocks = tenantBlocks.filter((b) => b.locationId == null || loc == null || b.locationId === loc).map(spanOfBlock);
    columns.push(column(NO_ROOM_COLUMN_ID, NO_ROOM_LABEL, null, null, unassigned, [], blocks));
  }
  return { window, rows, columns };
}
