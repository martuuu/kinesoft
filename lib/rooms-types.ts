/**
 * Tipos de salida de Salas (corrida SR, M4). Solo tipos: sin zod, sin Prisma,
 * apto cliente. El server es `lib/rooms.ts` (SR1b, `"use server"`: solo
 * exporta funciones async, por eso los tipos viven acá). `lib/rooms-schemas.ts`
 * los re-exporta junto al zod.
 */
import type { RoomKind } from "@/lib/rooms-constants";

export type { RoomKind } from "@/lib/rooms-constants";

/** Fila de Configuración › Sedes › Salas (`listRooms`, incluye archivadas a pedido). */
export type RoomRow = {
  id: string;
  locationId: string;
  name: string;
  kind: RoomKind;
  /** Profesionales a la vez (SR-D1). */
  capacity: number;
  active: boolean;
  sortOrder: number;
  /** Franjas semanales VIGENTES con esta sala ("3 franjas asignadas"). */
  scheduleCount: number;
};

/**
 * Sala del catálogo de la agenda (`AgendaBootstrapProps.rooms`): solo activas
 * de sedes activas, por sede y `sortOrder`. El cliente resuelve con esto el
 * nombre de `roomId` (no viaja en cada turno).
 */
export type RoomOption = {
  id: string;
  locationId: string;
  name: string;
  kind: RoomKind;
  capacity: number;
};

/** Lo que impide archivar una sala (SR-D8). Los bloqueos de sala NO bloquean: se borran en la misma tx. */
export type RoomArchiveBlockers = {
  /** Franjas vigentes (sin `validUntil` o con `validUntil` >= hoy AR) con esta sala. */
  activeSchedules: number;
  /** Turnos no cancelados desde ahora en adelante en esta sala. */
  futureBookings: number;
  /** Excepciones CUSTOM_HOURS de hoy en adelante cuyo `ranges` usa la sala. */
  futureExceptions: number;
};

export type ArchiveRoomResult =
  | { ok: true; data: undefined }
  | { ok: false; error: string; blockers?: RoomArchiveBlockers };
