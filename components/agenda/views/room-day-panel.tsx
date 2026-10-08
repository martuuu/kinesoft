"use client";

import { useMemo } from "react";
import type { AgendaZoom, LayoutBlock, MinuteWindow } from "@/lib/agenda-layout";
// Módulo aparte (SRZ FX2a): solo este panel diferido lo importa, así no entra al first load.
import { buildRoomColumns } from "@/lib/agenda-layout-rooms";
import type { AgendaAvailability } from "@/lib/availability-actions-types";
import type { AgendaHighlight } from "@/lib/agenda-highlight";
import { ROOM_FILTER_NONE, matchesLocation } from "@/lib/agenda-client-state";
import type { RoomOption } from "@/lib/rooms-types";
import type { BookingDTO } from "../agenda-utils";
import { RoomDayView } from "./room-day-view";

/**
 * Vista "Por sala" ya cableada (SR-U6): arma el layout (`buildRoomColumns`,
 * SR-U4) y monta `RoomDayView`. Vive aparte de `agenda-client` para que el
 * cálculo y la vista viajen en el chunk diferido (`dynamic()`): solo la usan
 * los consultorios con salas y el first load de /agenda no paga por ella.
 *
 * Columnas: las salas de la sede en pantalla (`scopeRooms`, D4) en el orden de
 * Configuración; con el filtro de una sala, solo esa. "Sin sala" va al final
 * con todas o con el filtro "Sin sala", y solo si hay turnos sin sala.
 *
 * Turnos (SRZ, revisión b):
 *   • M2: el caller pasa los de TODOS los profesionales (todos los filtros
 *     menos el de profesionales). La ocupación de una sala no puede depender
 *     de qué chips eligió la Secretaria: con "AP" puesto, la sala que ocupa BF
 *     se veía libre y el aviso recién llegaba del server al guardar.
 *   • M4: acá se recortan a la sede del alcance (`locationId ??
 *     primaryLocationId`, la misma de `scopeRooms`), con `matchesLocation`
 *     como el filtro de sede. Con "Todas las sedes", "Sin sala" mezclaba los
 *     turnos sin sala de otra sede con los de la principal.
 *   • B5: un turno con una sala que no está en el catálogo (archivada) no se
 *     dibuja en ninguna columna (`buildRoomColumns` lo descarta). Es a
 *     propósito: `archiveRoom` rechaza salas con turnos futuros (SR-D8), así
 *     que solo pasa en días pasados, y una columna "Sala archivada" sin
 *     capacidad ni asignación no responde nada útil. Día, Lista, Recepción y
 *     el drawer sí dicen "Sala archivada".
 */
export type RoomDayPanelProps = {
  dayKey: string;
  /** Salas visibles (`roomsInScope`), en orden de `sortOrder`. */
  scopeRooms: readonly RoomOption[];
  /** Filtro de sala efectivo (`effectiveRoomFilter`): id, "none" o null. */
  roomId: string | null;
  /**
   * Turnos con todos los filtros MENOS el de profesionales (M2) y con la
   * visibilidad aplicada. El panel los recorta a la sede del alcance (M4).
   */
  bookings: readonly BookingDTO[];
  availability: AgendaAvailability | null;
  /** `layoutBlocks(availability)`: solo pintan la sala los de `practitionerId` null. */
  blocks: readonly LayoutBlock[];
  locationId: string | null;
  /** Sede principal: alcance con "Todas las sedes" y sede de un turno con `locationId` null. */
  primaryLocationId: string | null;
  zoom: AgendaZoom;
  density: "comfortable" | "compact";
  /** Reloj de la línea de "ahora" (cada minuto). */
  now: Date;
  /** Reloj de la grilla (B4.6): no recalcula columnas en cada tick. */
  layoutNow: Date;
  fallback: MinuteWindow;
  highlight: AgendaHighlight | null;
  practitionerById: Readonly<Record<string, { initials: string; name: string }>>;
  fallbackLocationName: string | null;
  /** Copy del vacío (SRZ B3): `tenant.admin` o `schedule.configure`. */
  canConfigureRooms: boolean;
  onSlotClick: (roomId: string, iso: string) => void;
  onBookingClick: (b: BookingDTO) => void;
};

export function RoomDayPanel({
  dayKey,
  scopeRooms,
  roomId,
  bookings,
  availability,
  blocks,
  locationId,
  primaryLocationId,
  zoom,
  density,
  now,
  layoutNow,
  fallback,
  highlight,
  practitionerById,
  fallbackLocationName,
  canConfigureRooms,
  onSlotClick,
  onBookingClick,
}: RoomDayPanelProps) {
  // M4: la sede del alcance es la de `scopeRooms` (`roomsInScope`).
  const scopeLocationId = locationId ?? primaryLocationId;
  const inScope = useMemo(
    () => (scopeLocationId ? bookings.filter((b) => matchesLocation(b, scopeLocationId, primaryLocationId)) : bookings),
    [bookings, scopeLocationId, primaryLocationId]
  );
  const layout = useMemo(
    () =>
      buildRoomColumns(
        roomId && roomId !== ROOM_FILTER_NONE ? scopeRooms.filter((r) => r.id === roomId) : scopeRooms,
        inScope,
        {
          dayKey,
          zoom,
          now: layoutNow,
          fallback,
          // La clave del día de `AgendaAvailabilityDay` es `dayKey` (SR3a).
          assignments: availability?.days.find((d) => d.dayKey === dayKey)?.roomAssignments ?? {},
          blocks: blocks as LayoutBlock[],
          // Omitidos por el server si están vacíos (SR3a).
          roomBlocks: availability?.roomBlocks ?? [],
          includeUnassigned: roomId == null || roomId === ROOM_FILTER_NONE,
          // "Sin sala" es de la sede del alcance (M4): los bloqueos de otra sede no la pintan.
          locationId: scopeLocationId,
        }
      ),
    [roomId, scopeRooms, inScope, dayKey, zoom, layoutNow, fallback, availability, blocks, scopeLocationId]
  );
  return (
    <RoomDayView<BookingDTO>
      dayKey={dayKey}
      layout={layout}
      zoom={zoom}
      density={density}
      now={now}
      onSlotClick={onSlotClick}
      onBookingClick={onBookingClick}
      highlight={highlight}
      practitionerById={practitionerById}
      fallbackLocationName={fallbackLocationName}
      canConfigureRooms={canConfigureRooms}
    />
  );
}
