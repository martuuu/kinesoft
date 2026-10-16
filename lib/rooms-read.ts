import "server-only";
/**
 * PF2-d (C-PF8): salas del consultorio sobre una `tx` ya abierta. La usan `listRooms` (lib/rooms.ts: authz, módulo
 * `salas` y su `runWithRls`) y el loader de `/configuracion` (mismos chequeos antes de abrir su tx única). Fuera del
 * `"use server"`: recibe `tx`/`tenantId` del llamador y no puede ser un endpoint RPC; la autorización y el módulo son
 * del llamador. `where: { tenantId }` a mano, también en el conteo de franjas (prod BYPASSRLS).
 */
import type { Prisma } from "@prisma/client";
import type { DbClient } from "@/lib/rls";
import { toARDateKey } from "@/lib/datetime-ar";
import { dayKeyToDbDate } from "@/lib/schedule-validate";
import type { RoomRow } from "@/lib/rooms-schemas";

/** Hoy AR como `@db.Date` (vigencia de franjas y fecha de excepciones), como `archiveLocation`. */
export function todayDb(now: Date): Date {
  return dayKeyToDbDate(toARDateKey(now));
}

/** Orden de sede (principal primero, `sortOrder`, nombre) y después de sala. */
export const ROOM_ORDER = [
  { location: { isPrimary: "desc" } },
  { location: { sortOrder: "asc" } },
  { location: { name: "asc" } },
  { locationId: "asc" },
  { sortOrder: "asc" },
  { name: "asc" },
] satisfies Prisma.RoomOrderByWithRelationInput[];

/**
 * `scheduleCount` = franjas VIGENTES con la sala (sin fin o con fin >= hoy AR), en la MISMA sentencia (conteo
 * filtrado de la relación).
 */
export async function listRoomsInTx(
  tx: DbClient,
  tenantId: string,
  q: { locationId?: string; includeArchived?: boolean },
  now: Date = new Date()
): Promise<RoomRow[]> {
  const today = todayDb(now);
  const rows = await tx.room.findMany({
    where: {
      tenantId,
      ...(q.locationId ? { locationId: q.locationId } : {}),
      ...(q.includeArchived ? {} : { active: true }),
    },
    orderBy: ROOM_ORDER,
    select: {
      id: true,
      locationId: true,
      name: true,
      kind: true,
      capacity: true,
      active: true,
      sortOrder: true,
      _count: {
        select: {
          schedules: {
            where: { tenantId, OR: [{ validUntil: null }, { validUntil: { gte: today } }] },
          },
        },
      },
    },
  });
  return rows.map(({ _count, ...r }) => ({ ...r, scheduleCount: _count.schedules }));
}
