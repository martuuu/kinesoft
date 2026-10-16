import "server-only";
/**
 * PF2-d (C-PF8): sedes del consultorio sobre una `tx` ya abierta (principal primero, `sortOrder`, nombre). La usan
 * `listLocations` (lib/locations.ts, que exige `agenda.viewAll` y abre su `runWithRls`) y el loader de
 * `/configuracion` (mismo chequeo antes de abrir su tx única). Fuera del `"use server"`: recibe `tx`/`tenantId` del
 * llamador y no puede ser un endpoint RPC; la autorización es del llamador. `where: { tenantId }` a mano (prod BYPASSRLS).
 */
import type { Prisma } from "@prisma/client";
import type { DbClient } from "@/lib/rls";
import type { LocationRow } from "@/lib/locations-schemas";

const ROW_SELECT = {
  id: true,
  name: true,
  address: true,
  addressLine2: true,
  city: true,
  province: true,
  postalCode: true,
  phone: true,
  isPrimary: true,
  active: true,
  sortOrder: true,
  _count: { select: { schedules: true } },
} satisfies Prisma.LocationSelect;

function toRow(l: Prisma.LocationGetPayload<{ select: typeof ROW_SELECT }>): LocationRow {
  const { _count, ...rest } = l;
  return { ...rest, scheduleCount: _count.schedules };
}

export async function listLocationsInTx(
  tx: DbClient,
  tenantId: string,
  opts: { includeArchived?: boolean } = {}
): Promise<LocationRow[]> {
  const rows = await tx.location.findMany({
    where: { tenantId, ...(opts.includeArchived ? {} : { active: true }) },
    orderBy: [{ isPrimary: "desc" }, { sortOrder: "asc" }, { name: "asc" }],
    select: ROW_SELECT,
  });
  return rows.map(toRow);
}
