"use server";

/**
 * Bloqueos de horario (B2.4b CFG-api-2, B-pre): franjas en las que un
 * profesional (o "todos") no atiende. El motor (`lib/availability/ranges.ts`)
 * los RESTA de las franjas; el turnero y Planes los tratan como bloqueo duro y
 * el staff puede confirmar encima como sobreturno (decisión 1, `allowBlocked`).
 *
 * Crear, listar y borrar (soft, `deletedAt`): `createTimeBlock` **no cancela
 * ni toca ningún turno**, devuelve los activos que quedaron debajo para que la
 * UI decida. El candado de día (B4.4: `previewDayLock` / `applyDayLock` /
 * `removeDayLock`, al final del archivo) es el único camino que cancela, con
 * preview recalculado y cancelación en la MISMA tx que crea el bloqueo.
 *
 * Authz (`lib/capabilities.ts#canManageBlocksFor`):
 *   - PRACTITIONER (`agenda.manageOwnBlocks`): solo su propia agenda;
 *   - "todos" (fila con practitionerId null, decisión 8) o agendas ajenas:
 *     `agenda.manageBlocks` (OWNER/ADMIN/ASSISTANT);
 *   - listar: `agenda.viewAll`.
 * Las capabilities fallan cerrado con `ForbiddenError` (como `requireCapability`).
 *
 * Aislamiento: `where: { tenantId }` a mano en todo (en prod la conexión tiene
 * BYPASSRLS) y profesional/sede de entrada validados contra el tenant en la tx
 * que escribe — las FK de TimeBlock saltean RLS.
 *
 * Sede (integrador B2, handoff de B2.4a): con `locationId`, lock COMPARTIDO de
 * sedes del tenant (`lib/location-lock.ts`) y DESPUÉS validar que la sede sea
 * del tenant y esté activa — así `archiveLocation` (exclusivo) no se intercala
 * y no nace un bloqueo colgado de una sede archivada.
 *
 * Bloqueo de SALA (SR-B, §17.5 "Bloquear sala"): `roomId` en `createTimeBlock`
 * y en el candado (preview / apply / desbloquear).
 *   - Una fila con `roomId`, `locationId` = sede de la sala y `practitionerId`
 *     null (CHECK `TimeBlock_room_scope_check` de M4). Bloquea SOLO la sala:
 *     para el alta cuenta como sala llena (aviso + forzar, SR1d/SR2a), nunca
 *     saca slots a un profesional (el loader, SR1a, lo excluye de "todos").
 *   - Authz: la regla del candado para "todos" (`canManageBlocksFor(…, null)`
 *     = `agenda.manageBlocks`: OWNER/ADMIN/Secretaria). El profesional no
 *     bloquea salas: una sala es de todo el equipo.
 *   - Locks (C2 1b, handoff de SR-C): la clave de sala de CADA día AR de la
 *     ventana (`lockCapacityAndRoomsMany(tx, [], roomKeysForWindow(…))`, una
 *     sentencia, deduplicada y ordenada) ANTES del compartido de sedes; recién
 *     después se valida la sala (activa, de la sede, del tenant) — el mismo
 *     orden que el alta con sala (paciente → cupo → sala → sedes → filas), y
 *     `archiveRoom` toma el exclusivo de sedes. Sin claves de cupo: un bloqueo
 *     de sala no cambia la disponibilidad de nadie, solo la ocupación de la
 *     sala, que el alta cuenta con la clave de sala tomada.
 *   - Afectados: los turnos activos de ESA sala (mismo `DayLockAffected`).
 *     Mantener o cancelar sigue la regla del candado; mantener NO les saca la
 *     sala.
 *   - Todo lo que interpreta `practitionerId: null` como "todos" (listar,
 *     desbloquear, el reuso del candado) suma `NOT_ROOM_BLOCK`.
 */
import { withReadOnlyResult } from "@/lib/read-only-result";
import { ReadOnlyModeError } from "@/lib/tenant-access";
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { runWithRls, type DbClient } from "@/lib/rls";
import { getActor, ForbiddenError } from "@/lib/session";
import { getMembershipRole, requireCapability } from "@/lib/authz";
import { canManageBlocksFor, capabilitiesFor, type Capability } from "@/lib/capabilities";
import { isHoldingCapacity } from "@/lib/booking-capacity";
import { lockTenantLocationsShared } from "@/lib/location-lock";
import { lockCapacity, lockCapacityAndRoomsMany, roomKeysForWindow } from "@/lib/booking-cap-lock";
import { BAD_ROOM_ERROR } from "@/lib/bookings-constants";
import { dayKeyOf, dayKeyRange } from "@/lib/availability/day";
import { cancelBookingsInTx } from "@/lib/bookings-cancel-internal";
import {
  afterAvailabilityCommitted,
  afterBookingsCommitted,
  type BookingChangeRef,
} from "@/lib/booking-events-internal";
import { logger } from "@/lib/logger";
import type { ActionResult } from "@/lib/validation";
import {
  AFFECTED_LIST_LIMIT,
  DayLockApply,
  DayLockPreviewQuery,
  DayLockRemove,
  NOT_ROOM_BLOCK,
  TIME_BLOCK_MAX_DAYS,
  TimeBlockCreate,
  TimeBlockDelete,
  TimeBlockList,
  arDayStart,
  dayLockWindow,
  normalizeBlockWindow,
  type AffectedBooking,
  type ApplyDayLockResult,
  type CreateTimeBlockResult,
  type DayLockAffected,
  type DayLockApplyData,
  type DayLockApplyInput,
  type DayLockPreview,
  type DayLockPreviewInput,
  type DayLockRemoveInput,
  type RemoveDayLockData,
  type TimeBlockCreateInput,
  type TimeBlockDeleteInput,
  type TimeBlockListInput,
  type TimeBlockRow,
} from "@/lib/time-blocks-schemas";

const DAY_MS = 24 * 60 * 60_000;
const FORBIDDEN_OTHERS = "Solo podés bloquear tu propia agenda.";
const FORBIDDEN_DELETE = "Solo podés quitar bloqueos de tu propia agenda.";
const VIEW_MSG = "No tenés permiso para ver la agenda del equipo.";
const FORBIDDEN_ROOM = "Solo el equipo de administración o recepción puede bloquear una sala.";
// Ventana hacia atrás para encontrar turnos que EMPEZARON antes del bloqueo y
// lo pisan: el tope de duración de un servicio (`Service.durationMin` ≤ 480).
const MAX_BOOKING_MIN = 480;

/**
 * Aviso realtime de "cambió la disponibilidad" (SV-D12) por un bloqueo que se
 * creó, borró o des-bloqueó. Se llama SIEMPRE después del commit y fuera de
 * `runWithRls` (mismas reglas que el hook de turnos) y nunca tira.
 * `practitionerId: null` = todo el consultorio (bloqueo de "todos", de sala o de
 * varios profesionales).
 *
 * UNA sola llamada por commit (FX1b, §18.2 «1 commit = 1 POST»): SV06b mandaba
 * un `afterAvailabilityCommitted` por día AR (hasta 7 en paralelo) = 7 POST a
 * Broadcast y 7 `revalidateTag` del mismo `bookingDays` (que es por tenant, no
 * por día) para un solo bloqueo de una semana. Ahora:
 *   - la ventana cae en UN día AR → ese día (`dayKeyOf` = `toARDateKey`; con el
 *     día del host, un bloqueo de 22 h AR caía en el día siguiente en Vercel);
 *   - cae en más de uno → `day: null`, que el cliente ya trata como «re-pedí lo
 *     que estés mirando». El último instante es `endsAt - 1 ms`: un bloqueo de
 *     día completo termina a las 00:00 AR del día siguiente y no lo toca.
 */
async function emitAvailability(
  tenantId: string,
  practitionerId: string | null,
  startsAt: Date,
  endsAt: Date
): Promise<void> {
  const first = dayKeyOf(startsAt);
  const last = dayKeyOf(new Date(Math.max(startsAt.getTime(), endsAt.getTime() - 1)));
  await afterAvailabilityCommitted(tenantId, { practitionerId, day: first === last ? first : null });
}

/** Un solo profesional concreto → su id; "todos", sala o varios → null. */
function availabilityScopeOf(practitionerIds: readonly (string | null)[], roomId: string | null): string | null {
  if (roomId) return null;
  const uniq = [...new Set(practitionerIds)];
  return uniq.length === 1 ? uniq[0] : null;
}

async function actorWithCaps() {
  const actor = await getActor();
  const caps = capabilitiesFor(await getMembershipRole(actor));
  return { actor, caps };
}

function toRow(b: {
  id: string;
  practitionerId: string | null;
  locationId: string | null;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  reason: string | null;
  groupId: string | null;
  roomId: string | null;
  createdById: string;
}): TimeBlockRow {
  return {
    id: b.id,
    practitionerId: b.practitionerId,
    locationId: b.locationId,
    startsAt: b.startsAt.toISOString(),
    endsAt: b.endsAt.toISOString(),
    allDay: b.allDay,
    reason: b.reason,
    groupId: b.groupId,
    roomId: b.roomId,
    createdById: b.createdById,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers internos (NO exportados: este archivo es "use server" y todo export
// sería una action invocable desde el cliente — y estos reciben un `tx`).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lock COMPARTIDO de sedes y RECIÉN DESPUÉS validar la sede (patrón obligatorio
 * de `lib/location-lock.ts`: validar antes deja abierta la carrera con
 * `archiveLocation`).
 */
async function lockAndCheckLocation(
  tx: DbClient,
  tenantId: string,
  locationId: string
): Promise<{ ok: true; isPrimary: boolean } | { ok: false; error: string }> {
  await lockTenantLocationsShared(tx, tenantId);
  const loc = await tx.location.findFirst({
    where: { id: locationId, tenantId },
    select: { isPrimary: true, active: true },
  });
  if (!loc) return { ok: false, error: "Sede no encontrada." };
  if (!loc.active) return { ok: false, error: "La sede está archivada." };
  return { ok: true, isPrimary: loc.isPrimary };
}

/**
 * Sala de un bloqueo de sala (SR-B): activa, de una sede activa, del tenant y
 * — si el caller mandó sede — de ESA sede. Devuelve la sede de la sala, que es
 * la que se guarda (CHECK de M4: sala ⇒ sede). Sala ajena, archivada o de otra
 * sede: el mismo `BAD_ROOM_ERROR` (no se distingue "no existe" de "no es tuya").
 */
async function findActiveRoom(
  tx: DbClient,
  o: { tenantId: string; roomId: string; locationId: string | null }
): Promise<{ ok: true; locationId: string } | { ok: false; error: string }> {
  const room = await tx.room.findFirst({
    where: { id: o.roomId, tenantId: o.tenantId, active: true, location: { active: true } },
    select: { locationId: true },
  });
  if (!room || (o.locationId !== null && room.locationId !== o.locationId)) {
    return { ok: false, error: BAD_ROOM_ERROR };
  }
  return { ok: true, locationId: room.locationId };
}

/**
 * Locks de un bloqueo de sala y RECIÉN DESPUÉS validar la sala (ver cabecera):
 *   1. la clave de sala de CADA día AR de [start, end) en UNA sentencia
 *      (`lockCapacityAndRoomsMany` con cupo vacío: dedup + orden de C2 1b).
 *      Es la clave que toma el alta con sala ANTES de contar la ocupación:
 *      o el alta entró antes (la esperamos y sale en los afectados) o espera
 *      nuestro COMMIT y su conteo ve el bloqueo (`room-busy` con `blocked`);
 *   2. el compartido de sedes (`archiveRoom` / `archiveLocation` toman el
 *      exclusivo: la sala no se archiva entre la validación y el INSERT).
 */
async function lockAndCheckRoom(
  tx: DbClient,
  o: { tenantId: string; roomId: string; locationId: string | null; start: Date; end: Date }
): Promise<{ ok: true; locationId: string } | { ok: false; error: string }> {
  await lockCapacityAndRoomsMany(
    tx,
    [],
    roomKeysForWindow({ tenantId: o.tenantId, roomId: o.roomId, start: o.start, end: o.end })
  );
  await lockTenantLocationsShared(tx, o.tenantId);
  return findActiveRoom(tx, o);
}

/** Bloquear / desbloquear una sala: la regla del candado para "todos" (`agenda.manageBlocks`). */
function assertCanManageRoom(caps: ReadonlySet<Capability>, actorPractitionerId: string | null): void {
  if (!canManageBlocksFor(caps, actorPractitionerId, null)) {
    throw new ForbiddenError(caps.has("agenda.manageOwnBlocks") ? FORBIDDEN_ROOM : "No tenés permiso para bloquear la agenda.");
  }
}

/**
 * Locks de cupo (`lib/booking-cap-lock.ts`) de TODO el alcance de un bloqueo:
 * cada (profesional, servicio del tenant, día AR) — la misma clave que toman
 * create/update/batch de la agenda y el submit del turnero ANTES de contar y
 * escribir. Ver "Carrera bloqueo vs alta" en la cabecera del candado.
 * Orden fijo (profesional, servicio, día), ids con `sort()` por defecto: un
 * alta toma UNA clave (profesional, servicio) en días ascendentes y el
 * candado un solo día, así que ningún par de transacciones se espera en ciclo.
 * Va ANTES del lock de sedes (orden cupo → sedes de `lib/bookings.ts`).
 * Costo: profesionales × servicios × días — un bloqueo de 31 días para todos
 * en un consultorio chico son cientos de `pg_advisory_xact_lock` (baratos,
 * una ida y vuelta cada uno) en una acción rara; preferible a dejar entrar
 * un turno sin marca.
 */
async function lockCapacityScope(
  tx: DbClient,
  o: { tenantId: string; practitionerIds: string[]; dayKeys: string[] }
): Promise<void> {
  const serviceIds = (await tx.service.findMany({ where: { tenantId: o.tenantId }, select: { id: true } }))
    .map((x) => x.id)
    .sort();
  const days = [...o.dayKeys].sort();
  for (const practitionerId of [...o.practitionerIds].sort()) {
    for (const serviceId of serviceIds) {
      for (const dayKey of days) {
        await lockCapacity(tx, { tenantId: o.tenantId, practitionerId, serviceId, dayKey });
      }
    }
  }
}

// Mismo criterio de "cobro registrado" que `cancelBookingsInTx` (H1): acá solo
// sirve para AVISAR en el preview; la barrera real es la de la cancelación.
const MONEY = new Set(["PAID", "AUTHORIZED", "REFUNDED"]);

/**
 * Turnos ACTIVOS (PENDING/CONFIRMED que siguen ocupando cupo, §5.18) que caen,
 * aunque sea en parte, en [startsAt, endsAt). Extraído de `createTimeBlock`
 * (handoff de B2.4b) para que `applyDayLock` lo RECALCULE dentro de su tx.
 *   - `practitionerIds` null = todos los profesionales;
 *   - `locationId` acota a esa sede (`Booking.locationId` null = principal,
 *     contrato de M-agenda); null = todas;
 *   - `roomId` (SR-B): SOLO los turnos de esa sala, de cualquier profesional
 *     (ignora `practitionerIds` y la sede: un turno con sala tiene su sede
 *     explícita por el CHECK de M4).
 * Ordenados por hora e id. Sin límite: el caller recorta si muestra.
 */
async function findAffectedBookings(
  tx: DbClient,
  o: {
    tenantId: string;
    startsAt: Date;
    endsAt: Date;
    practitionerIds: string[] | null;
    locationId: string | null;
    locationIsPrimary: boolean;
    roomId?: string | null;
    now: Date;
  }
): Promise<DayLockAffected[]> {
  const where: Prisma.BookingWhereInput = {
    tenantId: o.tenantId,
    status: { in: ["PENDING", "CONFIRMED"] },
    scheduledFor: {
      gte: new Date(o.startsAt.getTime() - MAX_BOOKING_MIN * 60_000),
      lt: o.endsAt,
    },
    ...(o.roomId
      ? { roomId: o.roomId }
      : {
          ...(o.practitionerIds ? { practitionerId: { in: o.practitionerIds } } : {}),
          ...(o.locationId
            ? {
                OR: [{ locationId: o.locationId }, ...(o.locationIsPrimary ? [{ locationId: null }] : [])],
              }
            : {}),
        }),
  };
  const candidates = await tx.booking.findMany({
    where,
    orderBy: [{ scheduledFor: "asc" }, { id: "asc" }],
    select: {
      id: true,
      practitionerId: true,
      scheduledFor: true,
      durationMin: true,
      status: true,
      paymentStatus: true,
      insurerPaidAt: true,
      createdAt: true,
      patientId: true,
      idempotencyKey: true,
      guestName: true,
      // S18b H2 (P3.Z): solo para `inPlan`; no sale al cable.
      programId: true,
      patient: { select: { firstName: true, lastName: true } },
      payment: { select: { status: true } },
    },
  });
  return candidates
    .filter(
      (b) =>
        b.scheduledFor.getTime() + b.durationMin * 60_000 > o.startsAt.getTime() &&
        // Una reserva pública impaga y vencida ya no ocupa el horario (§5.18).
        isHoldingCapacity(b, o.now)
    )
    .map((b) => ({
      id: b.id,
      practitionerId: b.practitionerId,
      scheduledFor: b.scheduledFor.toISOString(),
      durationMin: b.durationMin,
      patientName: b.patient ? `${b.patient.firstName} ${b.patient.lastName}`.trim() : (b.guestName ?? null),
      status: b.status as "PENDING" | "CONFIRMED",
      hasPayment:
        MONEY.has(b.paymentStatus) ||
        b.insurerPaidAt != null ||
        (b.payment != null && MONEY.has(b.payment.status)),
      inPlan: b.programId != null,
    }));
}

export async function listTimeBlocks(
  raw: TimeBlockListInput
): Promise<ActionResult<TimeBlockRow[]>> {
  const { actor } = await requireCapability("agenda.viewAll", VIEW_MSG);
  const parsed = TimeBlockList.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Datos inválidos", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const { from, to, practitionerIds, locationId, roomIds } = parsed.data;
  const tenantId = actor.tenantId;
  const fromStart = arDayStart(from);
  const toEnd = new Date(arDayStart(to).getTime() + DAY_MS);

  const and: Prisma.TimeBlockWhereInput[] = [];
  // SR-B: o solo los de esas salas, o ninguno de sala (con practitionerId null
  // se leerían como "todo el equipo").
  and.push(roomIds ? { roomId: { in: roomIds } } : NOT_ROOM_BLOCK);
  // "todos" (null) aplica a cualquier profesional pedido; idem "todas las sedes".
  if (practitionerIds && !roomIds) {
    and.push({ OR: [{ practitionerId: { in: practitionerIds } }, { practitionerId: null }] });
  }
  if (locationId) {
    and.push({ OR: [{ locationId }, { locationId: null }] });
  }
  const rows = await runWithRls(tenantId, (tx) =>
    tx.timeBlock.findMany({
      where: {
        tenantId,
        deletedAt: null,
        startsAt: { lt: toEnd },
        endsAt: { gt: fromStart },
        AND: and,
      },
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    })
  );
  return { ok: true, data: rows.map(toRow) };
}

// BO3-F: el cuerpo va en `createTimeBlockImpl`; el wrapper convierte el ReadOnlyModeError (modo lectura / soporte)
// en `{ ok:false, error }` para que en prod Next no redacte el mensaje (lib/read-only-result.ts).
export async function createTimeBlock(...args: Parameters<typeof createTimeBlockImpl>): Promise<ActionResult<CreateTimeBlockResult>> {
  return withReadOnlyResult(() => createTimeBlockImpl(...args));
}

async function createTimeBlockImpl(
  raw: TimeBlockCreateInput
): Promise<ActionResult<CreateTimeBlockResult>> {
  const parsed = TimeBlockCreate.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Datos inválidos", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const input = parsed.data;
  const { actor, caps } = await actorWithCaps();
  const tenantId = actor.tenantId;
  // SR-B: bloqueo de sala = una fila con practitionerId null (no es "todos").
  const roomId = input.roomId ?? null;

  // Destinos: null = "todos" (una sola fila). Duplicados colapsados.
  const targets: (string | null)[] = roomId
    ? [null]
    : input.practitionerIds
      ? [...new Set(input.practitionerIds)]
      : [input.practitionerId ?? null];
  if (roomId) {
    assertCanManageRoom(caps, actor.practitionerId);
  } else {
    for (const t of targets) {
      if (!canManageBlocksFor(caps, actor.practitionerId, t)) {
        throw new ForbiddenError(
          caps.has("agenda.manageOwnBlocks") ? FORBIDDEN_OTHERS : "No tenés permiso para bloquear la agenda."
        );
      }
    }
  }

  const win = normalizeBlockWindow({
    startsAt: new Date(input.startsAt),
    endsAt: new Date(input.endsAt),
    allDay: input.allDay,
  });
  if (win.endsAt.getTime() - win.startsAt.getTime() > TIME_BLOCK_MAX_DAYS * DAY_MS) {
    return {
      ok: false,
      error: `Un bloqueo puede durar como máximo ${TIME_BLOCK_MAX_DAYS} días.`,
      fieldErrors: { endsAt: [`Máximo ${TIME_BLOCK_MAX_DAYS} días.`] },
    };
  }
  // Grupo solo para 2+ filas: un bloqueo suelto se borra por id.
  const groupId = targets.length > 1 ? randomUUID() : null;
  const pracIds = targets.filter((t): t is string => t !== null);
  const now = new Date();

  type TxOut =
    | { kind: "error"; error: string }
    | {
        kind: "ok";
        ids: string[];
        locationId: string | null;
        affected: CreateTimeBlockResult["affected"];
      };
  let out: TxOut;
  try {
    out = await runWithRls(tenantId, async (tx): Promise<TxOut> => {
      let locationId = input.locationId ?? null;
      let locationIsPrimary = false;
      if (roomId) {
        // Sala → sedes → validar (ver `lockAndCheckRoom`). Sin locks de cupo:
        // el bloqueo de sala no toca la disponibilidad de ningún profesional.
        const room = await lockAndCheckRoom(tx, {
          tenantId,
          roomId,
          locationId,
          start: win.startsAt,
          end: win.endsAt,
        });
        if (!room.ok) return { kind: "error", error: room.error };
        locationId = room.locationId;
      } else {
        if (pracIds.length) {
          const found = await tx.practitioner.count({ where: { tenantId, id: { in: pracIds } } });
          if (found !== pracIds.length) return { kind: "error", error: "Profesional no encontrado." };
        }
        // Revisión de B-pre: los locks de cupo del alcance, como `applyDayLock`.
        // Sin ellos, un alta EN VUELO (ya re-chequeó bloqueos con su lock
        // tomado, todavía sin COMMIT) no veía este bloqueo y este bloqueo no la
        // veía a ella: el turno entraba sin marca de sobreturno y sin figurar en
        // `affected`. Con ellos: o el alta entró antes (esperamos su COMMIT y
        // `findAffectedBookings` la reporta) o espera el nuestro y ve el bloqueo.
        await lockCapacityScope(tx, {
          tenantId,
          practitionerIds: targets.includes(null)
            ? (await tx.practitioner.findMany({ where: { tenantId }, select: { id: true } })).map((p) => p.id)
            : pracIds,
          dayKeys: dayKeyRange(
            dayKeyOf(win.startsAt),
            dayKeyOf(new Date(Math.max(win.startsAt.getTime(), win.endsAt.getTime() - 1)))
          ),
        });
        if (locationId) {
          const loc = await lockAndCheckLocation(tx, tenantId, locationId);
          if (!loc.ok) return { kind: "error", error: loc.error };
          locationIsPrimary = loc.isPrimary;
        }
      }

      const ids: string[] = [];
      for (const practitionerId of targets) {
        const row = await tx.timeBlock.create({
          data: {
            tenantId,
            practitionerId,
            locationId,
            roomId,
            startsAt: win.startsAt,
            endsAt: win.endsAt,
            allDay: input.allDay,
            reason: input.reason,
            groupId,
            createdById: actor.userId,
          },
          select: { id: true },
        });
        ids.push(row.id);
      }

      // Turnos activos debajo del bloqueo — SOLO lectura (el candado B4.4 decide).
      const hit = await findAffectedBookings(tx, {
        tenantId,
        startsAt: win.startsAt,
        endsAt: win.endsAt,
        practitionerIds: targets.includes(null) ? null : pracIds,
        locationId,
        locationIsPrimary,
        roomId,
        now,
      });
      const bookings: AffectedBooking[] = hit.slice(0, AFFECTED_LIST_LIMIT).map((b) => ({
        id: b.id,
        practitionerId: b.practitionerId,
        scheduledFor: b.scheduledFor,
        durationMin: b.durationMin,
        patientName: b.patientName,
      }));
      return { kind: "ok", ids, locationId, affected: { count: hit.length, bookings } };
    });
  } catch (e) {
    // BO3-F: el modo lectura / soporte sube al wrapper con su copy (no el genérico de acá).
    if (e instanceof ReadOnlyModeError) throw e;
    logger.error("timeBlock.create.failed", { err: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: "No pudimos crear el bloqueo." };
  }
  if (out.kind === "error") return { ok: false, error: out.error };

  revalidatePath("/agenda");
  // SV06b: el alta no toca turnos, pero cambia los slots (o la ocupación de la
  // sala): las agendas abiertas hacen `router.refresh()` al recibirlo.
  await emitAvailability(tenantId, availabilityScopeOf(targets, roomId), win.startsAt, win.endsAt);
  return {
    ok: true,
    data: {
      ids: out.ids,
      groupId,
      startsAt: win.startsAt.toISOString(),
      endsAt: win.endsAt.toISOString(),
      affected: out.affected,
    },
  };
}

/**
 * Borrado soft (`deletedAt`) de un bloqueo (`{ id }`) o de todo su grupo
 * (`{ groupId }`). Todas las filas tienen que estar autorizadas para el actor;
 * si una no lo está, no se borra ninguna.
 */
// BO3-F: el cuerpo va en `deleteTimeBlockImpl`; el wrapper convierte el ReadOnlyModeError (modo lectura / soporte)
// en `{ ok:false, error }` para que en prod Next no redacte el mensaje (lib/read-only-result.ts).
export async function deleteTimeBlock(...args: Parameters<typeof deleteTimeBlockImpl>): Promise<ActionResult<{ deleted: number }>> {
  return withReadOnlyResult(() => deleteTimeBlockImpl(...args));
}

async function deleteTimeBlockImpl(
  raw: TimeBlockDeleteInput
): Promise<ActionResult<{ deleted: number }>> {
  const parsed = TimeBlockDelete.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Datos inválidos" };
  const { actor, caps } = await actorWithCaps();
  const tenantId = actor.tenantId;
  const key = parsed.data;

  type TxOut =
    | { kind: "notFound" }
    | { kind: "forbidden" }
    | { kind: "ok"; ids: string[]; scope: string | null; startsAt: Date; endsAt: Date };
  let out: TxOut;
  try {
    out = await runWithRls(tenantId, async (tx): Promise<TxOut> => {
      const rows = await tx.timeBlock.findMany({
        where: {
          tenantId,
          deletedAt: null,
          ...("id" in key ? { id: key.id } : { groupId: key.groupId }),
        },
        select: { id: true, practitionerId: true, roomId: true, startsAt: true, endsAt: true },
      });
      if (rows.length === 0) return { kind: "notFound" };
      if (rows.some((r) => !canManageBlocksFor(caps, actor.practitionerId, r.practitionerId))) {
        return { kind: "forbidden" };
      }
      const ids = rows.map((r) => r.id);
      await tx.timeBlock.updateMany({
        where: { tenantId, id: { in: ids }, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      // Ventana y alcance del aviso realtime (SV06b): unión de las filas del
      // grupo (todas comparten ventana, pero no se asume).
      return {
        kind: "ok",
        ids,
        scope: availabilityScopeOf(
          rows.map((r) => r.practitionerId),
          rows.find((r) => r.roomId)?.roomId ?? null
        ),
        startsAt: new Date(Math.min(...rows.map((r) => r.startsAt.getTime()))),
        endsAt: new Date(Math.max(...rows.map((r) => r.endsAt.getTime()))),
      };
    });
  } catch (e) {
    // BO3-F: el modo lectura / soporte sube al wrapper con su copy (no el genérico de acá).
    if (e instanceof ReadOnlyModeError) throw e;
    logger.error("timeBlock.delete.failed", { err: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: "No pudimos quitar el bloqueo." };
  }
  if (out.kind === "notFound") return { ok: false, error: "Bloqueo no encontrado." };
  if (out.kind === "forbidden") throw new ForbiddenError(FORBIDDEN_DELETE);

  revalidatePath("/agenda");
  // SV06b: quitar un bloqueo vuelve a ofrecer esos slots.
  await emitAvailability(tenantId, out.scope, out.startsAt, out.endsAt);
  return { ok: true, data: { deleted: out.ids.length } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Candado de día (B4.4 AG-lock, plan §11.3): preview → aplicar → desbloquear.
//
// Flujo de la UI (`components/agenda/day-lock/day-lock-dialog.tsx`):
//   1. `previewDayLock` lista los turnos activos que quedarían debajo;
//   2. el staff elige mantenerlos o cancelarlos y `applyDayLock` manda los ids
//      que VIO (`expectedAffectedIds`);
//   3. `applyDayLock`, en UNA tx: locks → recalcula afectados → si difieren de
//      lo que vio el usuario NO aplica (`changed`, la UI re-muestra) → crea
//      el/los TimeBlock → si eligió cancelar, `cancelBookingsInTx` (los que
//      tienen cobro NO se cancelan: H1, se resuelven a mano).
//
// Carrera bloqueo vs alta (riesgo del diseño de B-pre). Recalcular dentro de
// la tx cubre el turno que se COMMITEÓ entre el preview y el apply. Para el
// que está EN VUELO a la vez, se toman los locks de cupo
// (`lib/booking-cap-lock.ts`) de cada (profesional, servicio) del alcance en
// ese día AR — la misma clave que toman create/update/batch de la agenda y el
// submit del turnero ANTES de contar y escribir:
//   - si el alta entró primero, este tx espera su COMMIT y el recálculo (READ
//     COMMITTED: snapshot nuevo por sentencia) ya la ve → `changed`;
//   - si entró el candado primero, el turnero espera nuestro COMMIT, recarga
//     la disponibilidad dentro de su tx y ve el bloqueo → rechaza el slot.
// El alta de la AGENDA re-chequea los bloqueos DENTRO de su tx, después del
// lock de cupo (`liveBlocksInTx` en `lib/bookings.ts`), así que también ve un
// candado commiteado mientras esperaba. `createTimeBlock` (bloqueo suelto)
// toma los mismos locks (`lockCapacityScope`) desde la revisión de B-pre.
// Orden de locks = el de `lib/bookings.ts` y `lib/public-booking.ts`: cupo →
// sedes. Las claves de cupo en orden fijo (profesional, servicio): dos
// candados simultáneos no se esperan en ciclo, y un alta toma una sola clave
// por día.
// ─────────────────────────────────────────────────────────────────────────────

const FORBIDDEN_ALL = "Solo el equipo de administración o recepción puede bloquear la agenda de todos.";

function assertCanManageTargets(
  caps: ReadonlySet<Capability>,
  actorPractitionerId: string | null,
  targets: (string | null)[]
): void {
  for (const t of targets) {
    if (!canManageBlocksFor(caps, actorPractitionerId, t)) {
      throw new ForbiddenError(
        t === null && caps.has("agenda.manageOwnBlocks")
          ? FORBIDDEN_ALL
          : caps.has("agenda.manageOwnBlocks")
            ? FORBIDDEN_OTHERS
            : "No tenés permiso para bloquear la agenda."
      );
    }
  }
}

/** null = "todos" (una fila null); lista = una fila por profesional, sin duplicados. */
function dayLockTargets(practitionerIds: string[] | null): (string | null)[] {
  return practitionerIds ? [...new Set(practitionerIds)] : [null];
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const id of sa) if (!sb.has(id)) return false;
  return true;
}

export async function previewDayLock(raw: DayLockPreviewInput): Promise<ActionResult<DayLockPreview>> {
  const parsed = DayLockPreviewQuery.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Datos inválidos", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const input = parsed.data;
  const { actor, caps } = await actorWithCaps();
  const tenantId = actor.tenantId;
  const roomId = input.roomId ?? null;
  const targets = dayLockTargets(input.practitionerIds);
  if (roomId) assertCanManageRoom(caps, actor.practitionerId);
  else assertCanManageTargets(caps, actor.practitionerId, targets);
  const pracIds = targets.filter((t): t is string => t !== null);
  const win = dayLockWindow(input.dayKey, input);

  type TxOut = { kind: "error"; error: string } | { kind: "ok"; affected: DayLockAffected[] };
  let out: TxOut;
  try {
    out = await runWithRls(tenantId, async (tx): Promise<TxOut> => {
      if (roomId) {
        // Solo lectura: sin locks (el apply los toma y vuelve a validar).
        const room = await findActiveRoom(tx, { tenantId, roomId, locationId: input.locationId ?? null });
        if (!room.ok) return { kind: "error", error: room.error };
        const affected = await findAffectedBookings(tx, {
          tenantId,
          startsAt: win.startsAt,
          endsAt: win.endsAt,
          practitionerIds: null,
          locationId: room.locationId,
          locationIsPrimary: false,
          roomId,
          now: new Date(),
        });
        return { kind: "ok", affected };
      }
      if (pracIds.length) {
        const found = await tx.practitioner.count({ where: { tenantId, id: { in: pracIds } } });
        if (found !== pracIds.length) return { kind: "error", error: "Profesional no encontrado." };
      }
      let locationIsPrimary = false;
      if (input.locationId) {
        // Solo lectura: sin lock (el apply lo toma y vuelve a validar).
        const loc = await tx.location.findFirst({
          where: { id: input.locationId, tenantId },
          select: { isPrimary: true, active: true },
        });
        if (!loc) return { kind: "error", error: "Sede no encontrada." };
        if (!loc.active) return { kind: "error", error: "La sede está archivada." };
        locationIsPrimary = loc.isPrimary;
      }
      const affected = await findAffectedBookings(tx, {
        tenantId,
        startsAt: win.startsAt,
        endsAt: win.endsAt,
        practitionerIds: input.practitionerIds ? pracIds : null,
        locationId: input.locationId ?? null,
        locationIsPrimary,
        now: new Date(),
      });
      return { kind: "ok", affected };
    });
  } catch (e) {
    logger.error("dayLock.preview.failed", { err: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: "No pudimos revisar los turnos de ese día." };
  }
  if (out.kind === "error") return { ok: false, error: out.error };
  return {
    ok: true,
    data: {
      dayKey: input.dayKey,
      startsAt: win.startsAt.toISOString(),
      endsAt: win.endsAt.toISOString(),
      allDay: input.allDay,
      affected: out.affected,
    },
  };
}

// BO3-F: el cuerpo va en `applyDayLockImpl`; el wrapper convierte el ReadOnlyModeError (modo lectura / soporte)
// en `{ ok:false, error }` para que en prod Next no redacte el mensaje (lib/read-only-result.ts).
export async function applyDayLock(...args: Parameters<typeof applyDayLockImpl>): Promise<ApplyDayLockResult> {
  return withReadOnlyResult(() => applyDayLockImpl(...args));
}

async function applyDayLockImpl(raw: DayLockApplyInput): Promise<ApplyDayLockResult> {
  const parsed = DayLockApply.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Datos inválidos", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const input = parsed.data;
  const { actor, caps } = await actorWithCaps();
  const tenantId = actor.tenantId;
  const roomId = input.roomId ?? null;
  const targets = dayLockTargets(input.practitionerIds);
  if (roomId) assertCanManageRoom(caps, actor.practitionerId);
  else assertCanManageTargets(caps, actor.practitionerId, targets);
  const pracIds = targets.filter((t): t is string => t !== null);
  const win = dayLockWindow(input.dayKey, input);
  // Con sala se reemplaza por la sede de la sala (validada en la tx).
  let locationId = input.locationId ?? null;
  const now = new Date();

  type TxOut =
    | { kind: "error"; error: string }
    | { kind: "changed"; affected: DayLockAffected[] }
    | { kind: "ok"; data: DayLockApplyData; refs: BookingChangeRef[] };
  let out: TxOut;
  try {
    out = await runWithRls(tenantId, async (tx): Promise<TxOut> => {
      let locationIsPrimary = false;
      if (roomId) {
        // 1-3 (sala, SR-B): clave de sala del día → sedes → validar la sala.
        const room = await lockAndCheckRoom(tx, {
          tenantId,
          roomId,
          locationId,
          start: win.startsAt,
          end: win.endsAt,
        });
        if (!room.ok) return { kind: "error", error: room.error };
        locationId = room.locationId;
      } else {
        // 1. Profesionales del alcance (validados contra el tenant: las FK saltean RLS).
        let lockPracIds: string[];
        if (pracIds.length) {
          const found = await tx.practitioner.findMany({
            where: { tenantId, id: { in: pracIds } },
            select: { id: true },
          });
          if (found.length !== pracIds.length) return { kind: "error", error: "Profesional no encontrado." };
          lockPracIds = found.map((p) => p.id);
        } else {
          lockPracIds = (
            await tx.practitioner.findMany({ where: { tenantId }, select: { id: true } })
          ).map((p) => p.id);
        }

        // 2. Locks de cupo del día (ver cabecera de la sección), en orden fijo.
        await lockCapacityScope(tx, { tenantId, practitionerIds: lockPracIds, dayKeys: [input.dayKey] });

        // 3. Sede: lock compartido y después validar.
        if (locationId) {
          const loc = await lockAndCheckLocation(tx, tenantId, locationId);
          if (!loc.ok) return { kind: "error", error: loc.error };
          locationIsPrimary = loc.isPrimary;
        }
      }

      // 4. Recalcular afectados: si no es lo que vio el usuario, no aplicar.
      const affected = await findAffectedBookings(tx, {
        tenantId,
        startsAt: win.startsAt,
        endsAt: win.endsAt,
        practitionerIds: input.practitionerIds ? pracIds : null,
        locationId,
        locationIsPrimary,
        roomId,
        now,
      });
      if (!sameIds(affected.map((a) => a.id), input.expectedAffectedIds)) {
        return { kind: "changed", affected };
      }

      // 5. Bloqueo(s). Idempotente: si cada destino ya tiene un bloqueo vivo
      //    idéntico (doble click, reintento tras un timeout), se reusa.
      //    SR-B: `roomId` en el filtro — sin él, un candado "todos" de una
      //    sede reusaría el bloqueo de UNA sala (también practitionerId null).
      const existing = await tx.timeBlock.findMany({
        where: {
          tenantId,
          deletedAt: null,
          startsAt: win.startsAt,
          endsAt: win.endsAt,
          locationId,
          roomId,
          practitionerId: input.practitionerIds ? { in: pracIds } : null,
        },
        select: { id: true, practitionerId: true, groupId: true },
        orderBy: { createdAt: "asc" },
      });
      const byTarget = new Map<string | null, { id: string; groupId: string | null }>();
      for (const e of existing) if (!byTarget.has(e.practitionerId)) byTarget.set(e.practitionerId, e);
      const reused = targets.every((t) => byTarget.has(t));

      let ids: string[];
      let groupId: string | null;
      if (reused) {
        ids = targets.map((t) => byTarget.get(t)!.id);
        groupId = targets.length > 1 ? (byTarget.get(targets[0])!.groupId ?? null) : null;
      } else {
        // Decisión 8: "todos" = una fila null; subconjunto = N filas con groupId.
        groupId = targets.length > 1 ? randomUUID() : null;
        ids = [];
        for (const practitionerId of targets) {
          const row = await tx.timeBlock.create({
            data: {
              tenantId,
              practitionerId,
              locationId,
              roomId,
              startsAt: win.startsAt,
              endsAt: win.endsAt,
              allDay: input.allDay,
              reason: input.reason,
              groupId,
              createdById: actor.userId,
            },
            select: { id: true },
          });
          ids.push(row.id);
        }
      }

      // 6. Turnos de debajo.
      const byId = new Map(affected.map((a) => [a.id, a]));
      let kept: DayLockAffected[] = affected;
      let cancelled: DayLockAffected[] = [];
      let skipped: DayLockApplyData["skipped"] = [];
      // SV06b: refs del publish realtime armados con lo que devolvió
      // `cancelBookingsInTx` bajo lock (fechas `Date` y sala de la fila), no
      // con `DayLockAffected` (ISO, pensado para la UI, sin sala).
      let refs: BookingChangeRef[] = [];
      if (input.bookingsDecision === "cancel" && affected.length > 0) {
        const res = await cancelBookingsInTx(tx, {
          tenantId,
          bookingIds: affected.map((a) => a.id),
          reason: `${roomId ? "Bloqueo de sala" : "Candado"} del día ${input.dayKey}${input.reason ? `: ${input.reason}` : ""}`,
          actorId: actor.userId,
          auditAction: "booking.cancel.dayLock",
        });
        cancelled = res.cancelled.map((c) => byId.get(c.id)!).filter(Boolean);
        refs = res.cancelled.map((c) => ({
          bookingId: c.id,
          practitionerId: c.practitionerId,
          scheduledFor: c.scheduledFor,
          roomId: c.roomId,
        }));
        skipped = res.skipped
          .filter((s) => byId.has(s.id))
          .map((s) => ({ booking: byId.get(s.id)!, reason: s.reason }));
        kept = [];
      }
      return {
        kind: "ok",
        data: {
          ids,
          groupId,
          startsAt: win.startsAt.toISOString(),
          endsAt: win.endsAt.toISOString(),
          reused,
          decision: input.bookingsDecision,
          kept,
          cancelled,
          skipped,
        },
        refs,
      };
    });
  } catch (e) {
    // BO3-F: el modo lectura / soporte sube al wrapper con su copy (no el genérico de acá).
    if (e instanceof ReadOnlyModeError) throw e;
    logger.error("dayLock.apply.failed", { err: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: "No pudimos bloquear el día. No se cambió nada." };
  }
  if (out.kind === "error") return { ok: false, error: out.error };
  if (out.kind === "changed") {
    return {
      ok: false,
      changed: true,
      error: "La agenda cambió mientras decidías: revisá la lista actualizada de turnos.",
      affected: {
        dayKey: input.dayKey,
        startsAt: win.startsAt.toISOString(),
        endsAt: win.endsAt.toISOString(),
        allDay: input.allDay,
        affected: out.affected,
      },
    };
  }

  const data = out.data;
  revalidatePath("/agenda");
  // SV06b: antes acá se revalidaban `bookingDays`/`dashboard` inline y no se
  // avisaba a nadie (§18.1: el candado era un write-path de Booking fuera del
  // hook). Ahora, después del commit:
  //   1. `afterBookingsCommitted` invalida `bookingDays` + `dashboard` (cancelar
  //      mueve los conteos y los días con turnos) y publica los cancelados con
  //      su sala. «Mantener» → `refs: []` → invalida igual pero NO publica
  //      turnos (SV-D12: ninguno cambió);
  //   2. `afterAvailabilityCommitted` avisa el bloqueo en sí (el día ya no
  //      ofrece slots). Un candado de varios profesionales, de "todos" o de
  //      sala va con `practitionerId: null`. No re-invalida `bookingDays`: ya
  //      lo hizo el paso 1 en este mismo request.
  await afterBookingsCommitted(tenantId, out.refs);
  await afterAvailabilityCommitted(
    tenantId,
    { practitionerId: availabilityScopeOf(targets, roomId), day: input.dayKey },
    { invalidateCaches: false }
  );
  return { ok: true, data };
}

/**
 * Desbloquear un día: soft-delete (`deletedAt`) de los bloqueos CONTENIDOS en
 * ese día AR del alcance (`practitionerId`: sus filas; null: todas las del
 * día). No toca:
 *   - bloqueos de varios días (vacaciones): quitarlos desbloquearía también
 *     los otros días → se informan en `remaining` con `multiDay`;
 *   - visto desde un profesional, el bloqueo de "todos" (alcanza al resto del
 *     equipo) → se informa en `remaining`;
 *   - los no tildados (`blockIds`) → `remaining`.
 * Si algún bloqueo a borrar no es del actor (PRACTITIONER), no se borra
 * ninguno (`ForbiddenError`).
 */
// BO3-F: el cuerpo va en `removeDayLockImpl`; el wrapper convierte el ReadOnlyModeError (modo lectura / soporte)
// en `{ ok:false, error }` para que en prod Next no redacte el mensaje (lib/read-only-result.ts).
export async function removeDayLock(...args: Parameters<typeof removeDayLockImpl>): Promise<ActionResult<RemoveDayLockData>> {
  return withReadOnlyResult(() => removeDayLockImpl(...args));
}

async function removeDayLockImpl(raw: DayLockRemoveInput): Promise<ActionResult<RemoveDayLockData>> {
  const parsed = DayLockRemove.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Datos inválidos", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const { dayKey, practitionerId, blockIds } = parsed.data;
  const roomId = parsed.data.roomId ?? null;
  const { actor, caps } = await actorWithCaps();
  const tenantId = actor.tenantId;
  if (roomId) assertCanManageRoom(caps, actor.practitionerId);
  else assertCanManageTargets(caps, actor.practitionerId, [practitionerId]);
  const dayStart = arDayStart(dayKey);
  const dayEnd = new Date(dayStart.getTime() + DAY_MS);

  type TxOut =
    | { kind: "none" }
    | { kind: "forbidden" }
    | { kind: "ok"; deletedIds: string[]; remaining: RemoveDayLockData["remaining"] };
  let out: TxOut;
  try {
    out = await runWithRls(tenantId, async (tx): Promise<TxOut> => {
      const touching = await tx.timeBlock.findMany({
        where: {
          tenantId,
          deletedAt: null,
          startsAt: { lt: dayEnd },
          endsAt: { gt: dayStart },
          // SR-B: o ESA sala, o nada de salas (no son de la agenda de nadie).
          ...(roomId ? { roomId } : NOT_ROOM_BLOCK),
          ...(practitionerId ? { OR: [{ practitionerId }, { practitionerId: null }] } : {}),
        },
        orderBy: [{ startsAt: "asc" }, { id: "asc" }],
      });
      if (touching.length === 0) return { kind: "none" };
      const pick = blockIds ? new Set(blockIds) : null;
      const isMultiDay = (b: { startsAt: Date; endsAt: Date }) =>
        b.startsAt.getTime() < dayStart.getTime() || b.endsAt.getTime() > dayEnd.getTime();
      const toDelete = touching.filter(
        (b) =>
          !isMultiDay(b) &&
          (practitionerId === null || b.practitionerId === practitionerId) &&
          (pick === null || pick.has(b.id))
      );
      if (toDelete.some((b) => !canManageBlocksFor(caps, actor.practitionerId, b.practitionerId))) {
        return { kind: "forbidden" };
      }
      const deletedIds = toDelete.map((b) => b.id);
      if (deletedIds.length) {
        await tx.timeBlock.updateMany({
          where: { tenantId, id: { in: deletedIds }, deletedAt: null },
          data: { deletedAt: new Date() },
        });
      }
      const gone = new Set(deletedIds);
      const remaining = touching
        .filter((b) => !gone.has(b.id))
        .map((b) => ({ ...toRow(b), multiDay: isMultiDay(b) }));
      return { kind: "ok", deletedIds, remaining };
    });
  } catch (e) {
    // BO3-F: el modo lectura / soporte sube al wrapper con su copy (no el genérico de acá).
    if (e instanceof ReadOnlyModeError) throw e;
    logger.error("dayLock.remove.failed", { err: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: "No pudimos desbloquear el día." };
  }
  if (out.kind === "none") return { ok: false, error: "Ese día no tiene bloqueos." };
  if (out.kind === "forbidden") throw new ForbiddenError(FORBIDDEN_DELETE);

  if (out.deletedIds.length) {
    revalidatePath("/agenda");
    // SV06b: desbloquear devuelve los slots del día. Solo si se borró algo: sin
    // cambios no hay nada que avisar. Alcance = el pedido (sala → null).
    await afterAvailabilityCommitted(tenantId, {
      practitionerId: roomId ? null : practitionerId,
      day: dayKey,
    });
  }
  return { ok: true, data: { deleted: out.deletedIds.length, remaining: out.remaining } };
}
