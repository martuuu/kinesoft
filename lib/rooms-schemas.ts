/**
 * Zod de Salas (corrida SR, M4) y re-export de sus tipos. Fuera del archivo
 * `"use server"` (`lib/rooms.ts`, SR1b, exporta solo funciones async). Mismo
 * patrón que `lib/locations-schemas.ts`.
 *
 * Los topes son los CHECK de M4 (`Room_name_check` 1..60 con btrim,
 * `Room_capacity_check` 1..50, `Room_sortOrder_check` >= 0): el zod los repite
 * para dar un error legible antes de que la base tire 23514.
 */
import { z } from "zod";
import { ROOM_CAPACITY_MAX, ROOM_CAPACITY_MIN, ROOM_KINDS, ROOM_NAME_MAX, type RoomKind } from "@/lib/rooms-constants";

export type { RoomArchiveBlockers, ArchiveRoomResult, RoomOption, RoomRow, RoomKind } from "@/lib/rooms-types";

export const RoomId = z.string().trim().min(1).max(64);

const RoomName = z
  .string()
  .trim()
  .min(1, "Nombre requerido")
  .max(ROOM_NAME_MAX, `Máximo ${ROOM_NAME_MAX} caracteres`);

const RoomKindZ = z.enum(ROOM_KINDS as [RoomKind, ...RoomKind[]]);

/** Profesionales a la vez (SR-D1). `coerce`: el input del drawer llega como string. */
const RoomCapacity = z.coerce
  .number({ invalid_type_error: "Ingresá un número" })
  .int("Tiene que ser un número entero")
  .min(ROOM_CAPACITY_MIN, `Mínimo ${ROOM_CAPACITY_MIN}`)
  .max(ROOM_CAPACITY_MAX, `Máximo ${ROOM_CAPACITY_MAX}`);

/** Alta. La sede se valida contra el tenant (y activa) en el server, bajo el lock exclusivo de sedes. */
export const RoomCreate = z.object({
  locationId: z.string().trim().min(1).max(64),
  name: RoomName,
  kind: RoomKindZ.default("CONSULTORIO"),
  capacity: RoomCapacity.default(1),
});
export type RoomCreateInput = z.input<typeof RoomCreate>;

/**
 * Edición parcial. La sede NO se cambia: las franjas y los turnos apuntan a la
 * sala con FK compuesta (roomId, locationId); mudarla de sede es archivarla y
 * crear otra. `sortOrder` lo usan "Subir"/"Bajar" (el server puede renumerar).
 */
export const RoomUpdate = z
  .object({
    id: RoomId,
    name: RoomName.optional(),
    kind: RoomKindZ.optional(),
    capacity: RoomCapacity.optional(),
    sortOrder: z.coerce.number().int().min(0).max(9999).optional(),
  })
  .refine((v) => v.name !== undefined || v.kind !== undefined || v.capacity !== undefined || v.sortOrder !== undefined, {
    message: "Nada para guardar.",
  });
export type RoomUpdateInput = z.input<typeof RoomUpdate>;

/** Archivar y restaurar (mismo input). */
export const RoomArchive = z.object({ id: RoomId });
export type RoomArchiveInput = z.input<typeof RoomArchive>;

/** `listRooms`: sin `locationId` = todas las sedes; `includeArchived` para Configuración. */
export const RoomListQuery = z
  .object({
    locationId: z.string().trim().min(1).max(64).optional(),
    includeArchived: z.boolean().optional(),
  })
  .default({});
export type RoomListQueryInput = z.input<typeof RoomListQuery>;
