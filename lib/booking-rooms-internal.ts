import "server-only";
import type { DbClient } from "@/lib/rls";
import { roomOccupancyAt } from "@/lib/availability/rooms";
import type { AvailabilityBooking, RoomBlock, RoomOccupancy } from "@/lib/availability/types";

/**
 * Lookback de la carga de SALA: el tope de duración de un servicio
 * (`Service.durationMin` ≤ 480, `lib/validation.ts`), el mismo margen que usa
 * `time-blocks.ts` para encontrar turnos que pisan un bloqueo.
 *
 * El bug que evita (revisión (a) de SR, cierre SRZ): con el `BOOKING_LOOKBACK_MIN`
 * de 240 heredado del cupo, un turno de 6 h de otro profesional que arrancó a
 * las 8:00 no entraba en la carga de un alta a las 12:30 y la sala de
 * capacidad 1 se veía libre (pasa en gimnasios). Va SOLO acá y no en el cupo ni
 * en el loader de la agenda (decisión del orquestador): la query de sala va por
 * `Booking_tenantId_roomId_scheduledFor_idx` y una sala tiene pocos turnos por
 * día, así que duplicar la ventana hacia atrás no cambia el costo; el cupo y el
 * loader siguen con 240 (`BOOKING_LOOKBACK_MIN`). Las claves de sala son por
 * día AR y cubren el día siguiente si el turno cruza la medianoche
 * (`roomKeysForWindow`), así que un turno largo que arrancó el día anterior
 * comparte clave con el alta: el conteo bajo lock sigue sin TOCTOU.
 */
export const ROOM_LOOKBACK_MIN = 480;

/**
 * Ocupación de SALA dentro de la transacción de un write-path (corrida SR,
 * sesión SR1d; contrato literal en el scratchpad `sr-contracts.md`).
 *
 * El bug que evita: `Room.capacity` = cuántos PROFESIONALES atienden a la vez
 * en la sala (SR-D1). Sin esto, dos profesionales distintos agendaban a la
 * misma hora en un consultorio de capacidad 1 y nada lo frenaba: el cupo
 * (`countCapacityOverlaps`) es por profesional + servicio, y el índice único
 * parcial es por paciente.
 *
 * Orden de uso en el caller (enmienda C2 (1b), ADR-004):
 *   1. `lockCapacityAndRoomsMany(tx, cap, roomKeysForWindow(...))` — cupo y
 *      sala en UNA sentencia (paciente → cupo → SALA → sedes → filas);
 *   2. `lockTenantLocationsShared` (sedes);
 *   3. `lockActiveRoomInTx` → null = `bad-room` (sala archivada, de otra sede,
 *      de otro tenant o de una sede archivada). Va DESPUÉS del lock compartido
 *      de sedes porque `archiveRoom` toma el exclusivo: con el compartido
 *      tomado, la sala no se archiva entre esta lectura y el INSERT/UPDATE;
 *   4. `countRoomOverlapsInTx` → `atCapacity` = `room-busy` (forzable con
 *      `allowRoomConflict`, que NO es sobreturno: SR-D2).
 * El conteo va después del lock de sala por el mismo motivo que el cupo: en
 * READ COMMITTED cada sentencia toma snapshot nuevo, así que la segunda tx que
 * esperó el lock ya ve la fila de la primera.
 *
 * Quién NO llama a esto (SR-D3): Planes, "este y los siguientes" y el turnero
 * estampan la sala por defecto sin chequear ocupación ni tomar la clave.
 *
 * `tenantId` va a mano en TODAS las queries: en prod la conexión es BYPASSRLS y
 * el `where` es la única barrera (AGENTS §4). Las FKs compuestas de M4 atan
 * sala ↔ sede ↔ tenant, pero eso protege la escritura, no esta lectura.
 */

/**
 * La sala, si está activa, es de esa sede y la sede también está activa.
 * Una sola query (el filtro de relación de Prisma va como subconsulta en la
 * misma sentencia). Precondición: el caller ya tomó `lockTenantLocationsShared`.
 * null → el caller devuelve el outcome `bad-room` (BAD_ROOM_ERROR).
 */
export async function lockActiveRoomInTx(
  tx: DbClient,
  o: { tenantId: string; roomId: string; locationId: string }
): Promise<{ id: string; capacity: number; name: string; locationId: string } | null> {
  return tx.room.findFirst({
    where: {
      id: o.roomId,
      tenantId: o.tenantId,
      locationId: o.locationId,
      active: true,
      location: { active: true, tenantId: o.tenantId },
    },
    select: { id: true, capacity: true, name: true, locationId: true },
  });
}

/** Fila cruda de la sentencia única: turno ('b') o bloqueo de sala ('k'). */
type RoomRow = {
  kind: "b" | "k";
  id: string;
  practitionerId: string | null;
  serviceId: string | null;
  startsAt: Date;
  durationMin: number | null;
  status: string | null;
  paymentStatus: string | null;
  createdAt: Date | null;
  patientId: string | null;
  idempotencyKey: string | null;
  locationId: string | null;
  roomId: string;
  endsAt: Date | null;
  reason: string | null;
};

type RoomBookingRow = AvailabilityBooking & { roomId: string | null };

/**
 * UNA sentencia con los turnos de la sala (lookback de `ROOM_LOOKBACK_MIN` = 480 desde `from`,
 * sin CANCELLED, sin la fila propia) y los bloqueos de sala vigentes que
 * solapan [from, to). Una sola ida a propósito: el alta con sala tiene
 * presupuesto de +2 statements (validar + contar, survey §d) y el batch carga
 * todas sus fechas de una vez.
 *
 * Fechas: las columnas son `timestamp(3)` sin zona y guardan UTC (Prisma). Se
 * pasan como ISO y se convierten con `AT TIME ZONE 'UTC'` para no depender de
 * cómo Prisma tipa un `Date` en un raw ni del `TimeZone` de la sesión.
 *
 * Excluir: `excludeId` (la fila que se edita) y `excludeKey` (un reintento
 * idempotente no choca consigo mismo), igual que `countCapacityOverlaps`. Van
 * como `($x::text IS NULL OR …)` para que el texto de la sentencia sea siempre
 * el mismo (una sola forma en pg_stat_statements).
 */
async function loadRoomRowsInTx(
  tx: DbClient,
  o: {
    tenantId: string;
    roomId: string;
    from: Date;
    to: Date;
    excludeId?: string | null;
    excludeKey?: string | null;
  }
): Promise<{ bookings: RoomBookingRow[]; blocks: RoomBlock[] }> {
  const fromIso = o.from.toISOString();
  const toIso = o.to.toISOString();
  const lookbackIso = new Date(o.from.getTime() - ROOM_LOOKBACK_MIN * 60_000).toISOString();
  const excludeId = o.excludeId ?? null;
  const excludeKey = o.excludeKey ?? null;
  const rows = await tx.$queryRaw<RoomRow[]>`
    SELECT 'b'::text AS "kind", b."id", b."practitionerId", b."serviceId", b."scheduledFor" AS "startsAt",
           b."durationMin", b."status"::text AS "status", b."paymentStatus"::text AS "paymentStatus",
           b."createdAt", b."patientId", b."idempotencyKey", b."locationId", b."roomId",
           NULL::timestamp(3) AS "endsAt", NULL::text AS "reason"
      FROM "Booking" b
     WHERE b."tenantId" = ${o.tenantId}
       AND b."roomId" = ${o.roomId}
       AND b."status" <> 'CANCELLED'
       AND b."scheduledFor" >= (${lookbackIso}::timestamptz AT TIME ZONE 'UTC')
       AND b."scheduledFor" <  (${toIso}::timestamptz AT TIME ZONE 'UTC')
       AND (${excludeId}::text IS NULL OR b."id" <> ${excludeId}::text)
       AND (${excludeKey}::text IS NULL OR b."idempotencyKey" <> ${excludeKey}::text)
    UNION ALL
    SELECT 'k'::text, t."id", NULL::text, NULL::text, t."startsAt",
           NULL::int, NULL::text, NULL::text,
           NULL::timestamp(3), NULL::text, NULL::text, t."locationId", t."roomId",
           t."endsAt", t."reason"
      FROM "TimeBlock" t
     WHERE t."tenantId" = ${o.tenantId}
       AND t."roomId" = ${o.roomId}
       AND t."deletedAt" IS NULL
       AND t."startsAt" < (${toIso}::timestamptz AT TIME ZONE 'UTC')
       AND t."endsAt"   > (${fromIso}::timestamptz AT TIME ZONE 'UTC')`;

  const bookings: RoomBookingRow[] = [];
  const blocks: RoomBlock[] = [];
  for (const r of rows) {
    if (r.kind === "k") {
      blocks.push({ id: r.id, roomId: r.roomId, startsAt: r.startsAt, endsAt: r.endsAt!, reason: r.reason });
    } else {
      bookings.push({
        id: r.id,
        practitionerId: r.practitionerId!,
        serviceId: r.serviceId!,
        scheduledFor: r.startsAt,
        durationMin: r.durationMin!,
        status: r.status!,
        paymentStatus: r.paymentStatus!,
        createdAt: r.createdAt!,
        patientId: r.patientId,
        idempotencyKey: r.idempotencyKey!,
        // Con sala la sede es explícita (Booking_room_location_check, SR-D6).
        locationId: r.locationId!,
        roomId: r.roomId,
      });
    }
  }
  // Orden estable para los consumidores (y para "el primer bloqueo" del predicado).
  bookings.sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  blocks.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { bookings, blocks };
}

/**
 * Ocupación de la sala en [start, end) para `practitionerId`, en UNA
 * sentencia. Va DESPUÉS de `lockCapacityAndRoomsMany` (si no, es un TOCTOU:
 * dos altas leen "0 ocupados" y escriben las dos). El bloqueo de sala cuenta
 * como sala llena (`blocked`, §17.5): aviso forzable, no error duro. El filtro
 * final es `roomOccupancyAt` (lib/availability/rooms.ts), el de la agenda.
 */
export async function countRoomOverlapsInTx(
  tx: DbClient,
  o: {
    tenantId: string;
    roomId: string;
    practitionerId: string;
    start: Date;
    end: Date;
    now: Date;
    capacity: number;
    excludeId?: string;
    excludeKey?: string | null;
  }
): Promise<RoomOccupancy> {
  const { bookings, blocks } = await loadRoomRowsInTx(tx, {
    tenantId: o.tenantId,
    roomId: o.roomId,
    from: o.start,
    to: o.end,
    excludeId: o.excludeId,
    excludeKey: o.excludeKey,
  });
  // MISMO predicado que la agenda (SR1a): la agenda y el write-path no pueden
  // decir cosas distintas sobre la misma sala. Las filas ya vienen sin
  // CANCELLED ni la fila propia; `roomOccupancyAt` igual lo re-filtra.
  return roomOccupancyAt(
    bookings,
    {
      roomId: o.roomId,
      practitionerId: o.practitionerId,
      when: o.start,
      durationMin: (o.end.getTime() - o.start.getTime()) / 60_000,
      capacity: o.capacity,
      now: o.now,
      excludeBookingId: o.excludeId ?? null,
      excludeKey: o.excludeKey ?? null,
    },
    blocks
  );
}

/**
 * Batch (SR-D7): UNA carga para todas las fechas — turnos de la sala desde
 * `from − ROOM_LOOKBACK_MIN` (480) hasta `to` (sin CANCELLED) y los bloqueos de sala vigentes
 * que solapan [from, to). Después el caller evalúa cada fecha con
 * `roomOccupancyAt` (mismo predicado que `countRoomOverlapsInTx`). Pasar como
 * `to` el FIN de la última fecha. Precondición: las claves de sala de todas las
 * fechas ya tomadas (`lockCapacityAndRoomsMany`).
 */
export async function loadRoomBookingsInTx(
  tx: DbClient,
  o: { tenantId: string; roomId: string; from: Date; to: Date }
): Promise<{ bookings: Array<AvailabilityBooking & { roomId: string | null }>; blocks: RoomBlock[] }> {
  return loadRoomRowsInTx(tx, o);
}
