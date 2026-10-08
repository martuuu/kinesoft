/**
 * Salas / consultorios (corrida SR, M4): constantes y copy. PURO y apto
 * cliente: sin Prisma, sin `server-only`, sin reloj. Lo importan Configuración
 * (SR-U1), el editor de horarios (SR-U2), la agenda (SR-U3..U6), el zod de
 * `lib/rooms-schemas.ts` y el server (`lib/rooms.ts`, SR1b).
 *
 * Por qué `RoomKind` está escrito acá y no importado de `@prisma/client`: el
 * enum de Prisma arrastra el runtime del cliente al bundle de la agenda. Es el
 * mismo espejo que hace `lib/availability/types.ts` con sus enums; el unit test
 * (`tests/unit/rooms-constants.test.ts`) afirma que coincide con el de Prisma.
 */

/** Espejo de `enum RoomKind` de `prisma/schema.prisma` (M4). */
export type RoomKind = "CONSULTORIO" | "BOX" | "GIMNASIO" | "SALA";

/** En el orden del select de Configuración. */
export const ROOM_KINDS: ReadonlyArray<RoomKind> = ["CONSULTORIO", "BOX", "GIMNASIO", "SALA"];

export const ROOM_KIND_LABEL: Record<RoomKind, string> = {
  CONSULTORIO: "Consultorio",
  BOX: "Box",
  GIMNASIO: "Gimnasio",
  SALA: "Sala",
};

/**
 * `Room.capacity` = PROFESIONALES a la vez en la sala (SR-D1, §17.5), no
 * pacientes: el cupo de pacientes sigue en `Service.maxConcurrent`. Mismos
 * topes que el CHECK `Room_capacity_check` de M4 (1..50).
 */
export const ROOM_CAPACITY_MIN = 1;
export const ROOM_CAPACITY_MAX = 50;
export const ROOM_CAPACITY_DEFAULT = 1;

/** Tope del CHECK `Room_name_check` de M4 (`char_length(btrim(name)) BETWEEN 1 AND 60`). */
export const ROOM_NAME_MAX = 60;

// ─── Copy (voseo; §17.5 manda sobre el relevamiento: "Profesionales a la vez") ───

export const ROOM_CAPACITY_LABEL = "Profesionales a la vez";
export const ROOM_CAPACITY_HELP = "1 para un consultorio. En un gimnasio, cuántos profesionales atienden juntos.";
export const ROOM_NAME_PLACEHOLDER = "Ej.: Consultorio 2";
/** Opción del select de sala (franja, modal, drawer) y del filtro de agenda. */
export const NO_ROOM_LABEL = "Sin sala";

/** P2002 de `Room_locationId_name_active_key` (SR-D9: único por sede entre las activas). */
export const ROOM_NAME_TAKEN_ERROR = "Ya hay una sala activa con ese nombre en esta sede.";

/**
 * Bajada de la fila de una sala en Configuración: "Consultorio · 1 profesional
 * a la vez" / "Gimnasio · hasta 8 profesionales a la vez".
 */
export function roomCapacityText(capacity: number): string {
  return capacity <= 1 ? "1 profesional a la vez" : `hasta ${capacity} profesionales a la vez`;
}

export function roomSummary(room: { kind: RoomKind; capacity: number }): string {
  return `${ROOM_KIND_LABEL[room.kind]} · ${roomCapacityText(room.capacity)}`;
}
