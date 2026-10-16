"use server";

/**
 * Salas / consultorios de cada sede (corrida SR, sesión SR1b; M4 crea `Room`).
 *
 * Authz:
 *   - Leer las salas ACTIVAS: cualquier miembro del consultorio (`getActor`).
 *     Son datos operativos que la agenda necesita en todos los roles (el
 *     nombre de `Booking.roomId` se resuelve en el cliente desde este catálogo,
 *     SR "UI"), igual que los nombres de las sedes. No hay PHI.
 *   - `includeArchived` (Configuración) y toda escritura: `schedule.configure`
 *     (OWNER/ADMIN), como sedes y horarios: la sala define dónde se atiende.
 *   - PL-2f (C-PL1, PL-D7): módulo `salas` (Clínica / Libre, las dos verticales). Sin él, las escrituras tiran
 *     `ForbiddenError(MODULE_DENIED_COPY.salas)` y las lecturas devuelven `[]` (regla de `lib/authz.ts`: una
 *     lectura compartida no rompe la pantalla). Las salas que el consultorio cargó en Clínica «duermen»: no se
 *     borran ni se archivan, y vuelven tal cual si vuelve a Clínica.
 *
 * Tenant: TODA query lleva `where: { tenantId }` a mano dentro de `runWithRls`:
 * en prod la conexión es BYPASSRLS y ese filtro es la única barrera. Una sala o
 * sede de otro tenant se responde igual que una inexistente. Las FK compuestas
 * de M4 (`Room_location_tenant_fkey`) frenan además una sala de B en una sede
 * de A, pero solo como red: el error legible lo da la validación de acá.
 *
 * Concurrencia: TODA escritura toma `lockTenantLocations` EXCLUSIVO (la misma
 * clave de sedes, `lib/location-lock.ts`) y RECIÉN DESPUÉS valida sede/sala.
 * Los write-paths que USAN una sala (franjas y excepciones en
 * `lib/practitioner-schedule.ts`, turnos vía `lockActiveRoomInTx`, bloqueos de
 * sala en `lib/time-blocks.ts`) toman esa clave COMPARTIDA y validan la sala
 * activa adentro. Así "archivar" no puede intercalarse entre el conteo de
 * bloqueantes y una franja/turno nuevo en esa sala, y "restaurar"/"crear" no
 * pueden cruzarse con un archivado de la sede. No se inventa una clave nueva:
 * archivar una sede y archivar una sala se serializan entre sí, que es lo que
 * se quiere (la sala vive en la sede).
 *
 * Archivar = `active = false` (nunca DELETE): `Booking.roomId` es RESTRICT y el
 * historial tiene que seguir diciendo en qué sala fue. El índice parcial
 * `Room_locationId_name_active_key` (SR-D9) hace el nombre único por sede
 * SOLO entre activas: archivar libera el nombre y restaurar puede chocar.
 */
import { withSupportWritable } from "@/lib/support-writable";
import { readOnlyFailure, withReadOnlyResult } from "@/lib/read-only-result";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { runWithRls } from "@/lib/rls";
import { assertModule, requireCapability } from "@/lib/authz";
import { roomsEnabled } from "@/lib/tenant-modules";
import { getActor } from "@/lib/session";
import { logger } from "@/lib/logger";
import { lockTenantLocations } from "@/lib/location-lock";
import { ROOM_NAME_TAKEN_ERROR } from "@/lib/rooms-constants";
import { ROOM_ORDER, listRoomsInTx, todayDb } from "@/lib/rooms-read";
import {
  RoomArchive,
  RoomCreate,
  RoomListQuery,
  RoomUpdate,
  type ArchiveRoomResult,
  type RoomArchiveBlockers,
  type RoomArchiveInput,
  type RoomCreateInput,
  type RoomListQueryInput,
  type RoomOption,
  type RoomRow,
  type RoomUpdateInput,
} from "@/lib/rooms-schemas";
import type { ActionResult } from "@/lib/validation";

const WRITE_MSG = "Solo OWNER/ADMIN pueden configurar las salas.";
const NOT_FOUND = "Sala no encontrada.";
const BAD_LOCATION = "La sede no existe o está archivada.";
const LOCATION_ARCHIVED = "La sede de esta sala está archivada. Restaurá la sede primero.";

function revalidateAll() {
  revalidatePath("/configuracion");
  revalidatePath("/agenda");
}

/**
 * P2002 de una escritura de `Room`. Los únicos índices únicos de la tabla son
 * la PK (cuid), `Room_id_tenantId_key`, `Room_id_locationId_key` (ninguno
 * colisiona con un id nuevo) y el parcial del nombre: cualquier P2002 es el
 * nombre. No se mira `meta.target`: bajo `kinesoft_app` llega null (hallazgo
 * A1.1, ver `resolveUniqueViolation` en `lib/bookings-core.ts`).
 */
function isNameTaken(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

function nameTaken(): { ok: false; error: string; fieldErrors: Record<string, string[]> } {
  return { ok: false, error: ROOM_NAME_TAKEN_ERROR, fieldErrors: { name: [ROOM_NAME_TAKEN_ERROR] } };
}

// PF2-d: `todayDb`, `ROOM_ORDER` y la lectura de Configuración viven en lib/rooms-read.ts (la usa también el loader
// de `/configuracion` dentro de su tx única).

/**
 * Salas del consultorio para Configuración (`RoomRow`, con `scheduleCount`).
 * Sin `includeArchived`: solo activas, cualquier miembro. Con
 * `includeArchived`: `schedule.configure` (tira `ForbiddenError` si falta).
 * `scheduleCount` = franjas VIGENTES con la sala (sin fin o con fin >= hoy AR),
 * en la MISMA sentencia (conteo filtrado de la relación). Input inválido → [].
 */
export async function listRooms(query: RoomListQueryInput = {}): Promise<RoomRow[]> {
  const parsed = RoomListQuery.safeParse(query);
  const q = parsed.success ? parsed.data : null;
  const actor = q?.includeArchived
    ? (await requireCapability("schedule.configure", WRITE_MSG)).actor
    : await getActor();
  if (!q) return [];
  if (!roomsEnabled(actor.entitlements)) return [];
  return runWithRls(actor.tenantId, (tx) => listRoomsInTx(tx, actor.tenantId, q));
}

/**
 * Catálogo de salas para el bootstrap de la agenda (`AgendaBootstrapProps.rooms`):
 * solo activas de sedes activas, por sede y `sortOrder`. Cualquier miembro.
 * Una sola query; tenant sin salas → [].
 */
export async function listRoomOptions(): Promise<RoomOption[]> {
  const actor = await getActor();
  // PL-2f: sin el módulo, la agenda, `/sala` y los avisos arrancan sin catálogo = sin «Por sala» ni filtro de sala.
  if (!roomsEnabled(actor.entitlements)) return [];
  return runWithRls(actor.tenantId, (tx) =>
    tx.room.findMany({
      where: { tenantId: actor.tenantId, active: true, location: { tenantId: actor.tenantId, active: true } },
      orderBy: ROOM_ORDER,
      select: { id: true, locationId: true, name: true, kind: true, capacity: true },
    })
  );
}

/**
 * Alta de sala en una sede ACTIVA del tenant. Va al final de la sede
 * (`sortOrder` = máximo + 1, contando archivadas para no reusar posiciones).
 * Nombre repetido entre las activas de la sede → `fieldErrors.name`.
 */
export async function createRoom(...args: Parameters<typeof createRoomImpl>): ReturnType<typeof createRoomImpl> {
  return withReadOnlyResult(() => withSupportWritable("lib/rooms.ts#createRoom", () => createRoomImpl(...args)));
}

async function createRoomImpl(raw: RoomCreateInput): Promise<ActionResult<{ id: string }>> {
  const { actor } = await requireCapability("schedule.configure", WRITE_MSG);
  assertModule(actor, "salas");
  const parsed = RoomCreate.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Datos inválidos", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const d = parsed.data;
  try {
    const row = await runWithRls(actor.tenantId, async (tx) => {
      await lockTenantLocations(tx, actor.tenantId);
      // Validar la sede DESPUÉS del lock (ver cabecera de lib/location-lock.ts).
      const loc = await tx.location.findFirst({
        where: { id: d.locationId, tenantId: actor.tenantId, active: true },
        select: { id: true },
      });
      if (!loc) return null;
      const max = await tx.room.aggregate({
        where: { tenantId: actor.tenantId, locationId: loc.id },
        _max: { sortOrder: true },
      });
      const sortOrder = max._max.sortOrder === null ? 0 : max._max.sortOrder + 1;
      const room = await tx.room.create({
        data: {
          tenantId: actor.tenantId,
          locationId: loc.id,
          name: d.name,
          kind: d.kind,
          capacity: d.capacity,
          sortOrder,
        },
        select: { id: true },
      });
      return room;
    });
    if (!row) return { ok: false, error: BAD_LOCATION, fieldErrors: { locationId: [BAD_LOCATION] } };
    revalidateAll();
    return { ok: true, data: { id: row.id } };
  } catch (e) {
    // EV1-E2 (readonly-residual-actions): modo lectura / soporte → su copy, no el genérico de abajo.
    const ro = readOnlyFailure(e);
    if (ro) return ro;
    if (isNameTaken(e)) return nameTaken();
    logger.error("room.create.failed", { err: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: "No pudimos crear la sala." };
  }
}

/**
 * Edición parcial (nombre, tipo, capacidad, orden). La sede NO cambia
 * (`RoomUpdate` no la acepta: las FK compuestas atan franjas y turnos a la
 * sala de esa sede). Una sala archivada también se puede editar (no choca de
 * nombre: el índice es solo entre activas). Toma el lock exclusivo porque
 * `capacity` lo leen las altas de turno bajo el compartido (`lockActiveRoomInTx`):
 * una baja de capacidad no se intercala entre leerla y contar la ocupación.
 */
export async function updateRoom(...args: Parameters<typeof updateRoomImpl>): ReturnType<typeof updateRoomImpl> {
  return withReadOnlyResult(() => withSupportWritable("lib/rooms.ts#updateRoom", () => updateRoomImpl(...args)));
}

async function updateRoomImpl(raw: RoomUpdateInput): Promise<ActionResult> {
  const { actor } = await requireCapability("schedule.configure", WRITE_MSG);
  assertModule(actor, "salas");
  const parsed = RoomUpdate.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Datos inválidos", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const { id, ...rest } = parsed.data;
  const data = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as Prisma.RoomUpdateManyMutationInput;
  try {
    const found = await runWithRls(actor.tenantId, async (tx) => {
      await lockTenantLocations(tx, actor.tenantId);
      // updateMany con tenantId: la barrera explícita también en la escritura.
      const r = await tx.room.updateMany({ where: { id, tenantId: actor.tenantId }, data });
      if (r.count === 0) return false;
      return true;
    });
    if (!found) return { ok: false, error: NOT_FOUND };
    revalidateAll();
    return { ok: true, data: undefined };
  } catch (e) {
    // EV1-E2 (readonly-residual-actions): modo lectura / soporte → su copy, no el genérico de abajo.
    const ro = readOnlyFailure(e);
    if (ro) return ro;
    if (isNameTaken(e)) return nameTaken();
    logger.error("room.update.failed", { err: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: "No pudimos guardar la sala." };
  }
}

/**
 * Archiva una sala (SR-D8). Se niega, con conteos para que la UI diga qué
 * falta mover, si la sala tiene franjas vigentes, turnos futuros no
 * cancelados o excepciones CUSTOM_HOURS de hoy en adelante que la usan
 * (`ranges` con `array_contains [{roomId}]`, mismo patrón que
 * `archiveLocation`). Los bloqueos de sala (`TimeBlock.roomId`) NO bloquean:
 * los que terminan después de ahora se borran (soft delete) en la misma tx
 * (§17.5: un bloqueo de una sala archivada no tiene sentido; los pasados
 * quedan como historia). Ya archivada → ok idempotente.
 */
export async function archiveRoom(...args: Parameters<typeof archiveRoomImpl>): ReturnType<typeof archiveRoomImpl> {
  return withReadOnlyResult(() => withSupportWritable("lib/rooms.ts#archiveRoom", () => archiveRoomImpl(...args)));
}

async function archiveRoomImpl(raw: RoomArchiveInput): Promise<ArchiveRoomResult> {
  const { actor } = await requireCapability("schedule.configure", WRITE_MSG);
  assertModule(actor, "salas");
  const parsed = RoomArchive.safeParse(raw);
  if (!parsed.success) return { ok: false, error: NOT_FOUND };
  const id = parsed.data.id;
  const now = new Date();
  const today = todayDb(now);
  try {
    const res = await runWithRls(actor.tenantId, async (tx) => {
      await lockTenantLocations(tx, actor.tenantId);
      const room = await tx.room.findFirst({
        where: { id, tenantId: actor.tenantId },
        select: { id: true, name: true, active: true },
      });
      if (!room) return { kind: "notFound" as const };
      if (!room.active) return { kind: "done" as const };
      const [activeSchedules, futureBookings, futureExceptions] = await Promise.all([
        tx.practitionerSchedule.count({
          where: {
            tenantId: actor.tenantId,
            roomId: room.id,
            OR: [{ validUntil: null }, { validUntil: { gte: today } }],
          },
        }),
        tx.booking.count({
          where: {
            tenantId: actor.tenantId,
            roomId: room.id,
            scheduledFor: { gte: now },
            status: { not: "CANCELLED" },
          },
        }),
        tx.scheduleException.count({
          where: {
            tenantId: actor.tenantId,
            kind: "CUSTOM_HOURS",
            date: { gte: today },
            ranges: { array_contains: [{ roomId: room.id }] },
          },
        }),
      ]);
      const blockers: RoomArchiveBlockers = { activeSchedules, futureBookings, futureExceptions };
      if (activeSchedules + futureBookings + futureExceptions > 0) {
        return { kind: "blocked" as const, blockers };
      }
      await tx.room.updateMany({ where: { id: room.id, tenantId: actor.tenantId }, data: { active: false } });
      await tx.timeBlock.updateMany({
        where: { tenantId: actor.tenantId, roomId: room.id, deletedAt: null, endsAt: { gt: now } },
        data: { deletedAt: now },
      });
      return { kind: "done" as const };
    });
    switch (res.kind) {
      case "notFound":
        return { ok: false, error: NOT_FOUND };
      case "blocked": {
        const b = res.blockers;
        const parts = [
          b.activeSchedules ? `${b.activeSchedules} franja${b.activeSchedules === 1 ? "" : "s"} de horario` : null,
          b.futureBookings ? `${b.futureBookings} turno${b.futureBookings === 1 ? "" : "s"} a futuro` : null,
          b.futureExceptions
            ? `${b.futureExceptions} día${b.futureExceptions === 1 ? "" : "s"} con horario especial`
            : null,
        ].filter(Boolean);
        return {
          ok: false,
          error: `No se puede archivar: la sala todavía tiene ${parts.join(", ")}. Sacala de esos horarios y turnos primero.`,
          blockers: b,
        };
      }
      case "done":
        revalidateAll();
        return { ok: true, data: undefined };
    }
  } catch (e) {
    // EV1-E2 (readonly-residual-actions): modo lectura / soporte → su copy, no el genérico de abajo.
    const ro = readOnlyFailure(e);
    if (ro) return ro;
    logger.error("room.archive.failed", { err: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: "No pudimos archivar la sala." };
  }
}

/**
 * Reactiva una sala archivada. La sede tiene que estar activa; si otra sala
 * activa de la sede ya usa el nombre, el índice parcial tira P2002 →
 * `fieldErrors.name` (hay que renombrar una de las dos). Ya activa → ok.
 * Los bloqueos borrados al archivar no vuelven.
 */
export async function restoreRoom(...args: Parameters<typeof restoreRoomImpl>): ReturnType<typeof restoreRoomImpl> {
  return withReadOnlyResult(() => withSupportWritable("lib/rooms.ts#restoreRoom", () => restoreRoomImpl(...args)));
}

async function restoreRoomImpl(raw: RoomArchiveInput): Promise<ActionResult> {
  const { actor } = await requireCapability("schedule.configure", WRITE_MSG);
  assertModule(actor, "salas");
  const parsed = RoomArchive.safeParse(raw);
  if (!parsed.success) return { ok: false, error: NOT_FOUND };
  const id = parsed.data.id;
  try {
    const res = await runWithRls(actor.tenantId, async (tx) => {
      await lockTenantLocations(tx, actor.tenantId);
      const room = await tx.room.findFirst({
        where: { id, tenantId: actor.tenantId },
        select: { id: true, active: true, location: { select: { active: true } } },
      });
      if (!room) return "notFound" as const;
      if (room.active) return "done" as const;
      if (!room.location.active) return "locationArchived" as const;
      await tx.room.updateMany({ where: { id: room.id, tenantId: actor.tenantId, active: false }, data: { active: true } });
      return "done" as const;
    });
    if (res === "notFound") return { ok: false, error: NOT_FOUND };
    if (res === "locationArchived") return { ok: false, error: LOCATION_ARCHIVED };
    revalidateAll();
    return { ok: true, data: undefined };
  } catch (e) {
    // EV1-E2 (readonly-residual-actions): modo lectura / soporte → su copy, no el genérico de abajo.
    const ro = readOnlyFailure(e);
    if (ro) return ro;
    if (isNameTaken(e)) return nameTaken();
    logger.error("room.restore.failed", { err: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: "No pudimos restaurar la sala." };
  }
}
