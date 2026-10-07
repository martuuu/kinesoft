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
 */
import { randomUUID } from "node:crypto";
import { revalidatePath, revalidateTag } from "next/cache";
import type { Prisma } from "@prisma/client";
import { runWithRls, type DbClient } from "@/lib/rls";
import { getActor, ForbiddenError } from "@/lib/session";
import { getMembershipRole, requireCapability } from "@/lib/authz";
import { canManageBlocksFor, capabilitiesFor, type Capability } from "@/lib/capabilities";
import { isHoldingCapacity } from "@/lib/booking-capacity";
import { lockTenantLocationsShared } from "@/lib/location-lock";
import { lockCapacity } from "@/lib/booking-cap-lock";
import { dayKeyOf, dayKeyRange } from "@/lib/availability/day";
import { cancelBookingsInTx } from "@/lib/bookings-cancel-internal";
import { tags } from "@/lib/cache-tags";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import type { ActionResult } from "@/lib/validation";
import {
  AFFECTED_LIST_LIMIT,
  DayLockApply,
  DayLockPreviewQuery,
  DayLockRemove,
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
// Ventana hacia atrás para encontrar turnos que EMPEZARON antes del bloqueo y
// lo pisan: el tope de duración de un servicio (`Service.durationMin` ≤ 480).
const MAX_BOOKING_MIN = 480;

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
 *     contrato de M-agenda); null = todas.
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
    ...(o.practitionerIds ? { practitionerId: { in: o.practitionerIds } } : {}),
    ...(o.locationId
      ? {
          OR: [{ locationId: o.locationId }, ...(o.locationIsPrimary ? [{ locationId: null }] : [])],
        }
      : {}),
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
  const { from, to, practitionerIds, locationId } = parsed.data;
  const tenantId = actor.tenantId;
  const fromStart = arDayStart(from);
  const toEnd = new Date(arDayStart(to).getTime() + DAY_MS);

  const and: Prisma.TimeBlockWhereInput[] = [];
  // "todos" (null) aplica a cualquier profesional pedido; idem "todas las sedes".
  if (practitionerIds) {
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

export async function createTimeBlock(
  raw: TimeBlockCreateInput
): Promise<ActionResult<CreateTimeBlockResult>> {
  const parsed = TimeBlockCreate.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Datos inválidos", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const input = parsed.data;
  const { actor, caps } = await actorWithCaps();
  const tenantId = actor.tenantId;

  // Destinos: null = "todos" (una sola fila). Duplicados colapsados.
  const targets: (string | null)[] = input.practitionerIds
    ? [...new Set(input.practitionerIds)]
    : [input.practitionerId ?? null];
  for (const t of targets) {
    if (!canManageBlocksFor(caps, actor.practitionerId, t)) {
      throw new ForbiddenError(
        caps.has("agenda.manageOwnBlocks") ? FORBIDDEN_OTHERS : "No tenés permiso para bloquear la agenda."
      );
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
    | { kind: "ok"; ids: string[]; affected: CreateTimeBlockResult["affected"] };
  let out: TxOut;
  try {
    out = await runWithRls(tenantId, async (tx): Promise<TxOut> => {
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
      let locationIsPrimary = false;
      if (input.locationId) {
        const loc = await lockAndCheckLocation(tx, tenantId, input.locationId);
        if (!loc.ok) return { kind: "error", error: loc.error };
        locationIsPrimary = loc.isPrimary;
      }

      const ids: string[] = [];
      for (const practitionerId of targets) {
        const row = await tx.timeBlock.create({
          data: {
            tenantId,
            practitionerId,
            locationId: input.locationId ?? null,
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
        locationId: input.locationId ?? null,
        locationIsPrimary,
        now,
      });
      const bookings: AffectedBooking[] = hit.slice(0, AFFECTED_LIST_LIMIT).map((b) => ({
        id: b.id,
        practitionerId: b.practitionerId,
        scheduledFor: b.scheduledFor,
        durationMin: b.durationMin,
        patientName: b.patientName,
      }));
      return { kind: "ok", ids, affected: { count: hit.length, bookings } };
    });
  } catch (e) {
    logger.error("timeBlock.create.failed", { err: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: "No pudimos crear el bloqueo." };
  }
  if (out.kind === "error") return { ok: false, error: out.error };

  await audit({
    tenantId,
    actorId: actor.userId,
    action: "timeBlock.create",
    entity: "TimeBlock",
    entityId: groupId ?? out.ids[0],
    payload: {
      ids: out.ids,
      groupId,
      practitionerIds: targets,
      locationId: input.locationId ?? null,
      startsAt: win.startsAt.toISOString(),
      endsAt: win.endsAt.toISOString(),
      allDay: input.allDay,
      reason: input.reason,
      affectedCount: out.affected.count,
    },
  });
  revalidatePath("/agenda");
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
export async function deleteTimeBlock(
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
    | { kind: "ok"; ids: string[] };
  let out: TxOut;
  try {
    out = await runWithRls(tenantId, async (tx): Promise<TxOut> => {
      const rows = await tx.timeBlock.findMany({
        where: {
          tenantId,
          deletedAt: null,
          ...("id" in key ? { id: key.id } : { groupId: key.groupId }),
        },
        select: { id: true, practitionerId: true },
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
      return { kind: "ok", ids };
    });
  } catch (e) {
    logger.error("timeBlock.delete.failed", { err: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: "No pudimos quitar el bloqueo." };
  }
  if (out.kind === "notFound") return { ok: false, error: "Bloqueo no encontrado." };
  if (out.kind === "forbidden") throw new ForbiddenError(FORBIDDEN_DELETE);

  await audit({
    tenantId,
    actorId: actor.userId,
    action: "timeBlock.delete",
    entity: "TimeBlock",
    entityId: "id" in key ? key.id : key.groupId,
    payload: { ids: out.ids, ...("groupId" in key ? { groupId: key.groupId } : {}) },
  });
  revalidatePath("/agenda");
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
  actorPractitionerId: string,
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
  const targets = dayLockTargets(input.practitionerIds);
  assertCanManageTargets(caps, actor.practitionerId, targets);
  const pracIds = targets.filter((t): t is string => t !== null);
  const win = dayLockWindow(input.dayKey, input);

  type TxOut = { kind: "error"; error: string } | { kind: "ok"; affected: DayLockAffected[] };
  let out: TxOut;
  try {
    out = await runWithRls(tenantId, async (tx): Promise<TxOut> => {
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

export async function applyDayLock(raw: DayLockApplyInput): Promise<ApplyDayLockResult> {
  const parsed = DayLockApply.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Datos inválidos", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const input = parsed.data;
  const { actor, caps } = await actorWithCaps();
  const tenantId = actor.tenantId;
  const targets = dayLockTargets(input.practitionerIds);
  assertCanManageTargets(caps, actor.practitionerId, targets);
  const pracIds = targets.filter((t): t is string => t !== null);
  const win = dayLockWindow(input.dayKey, input);
  const locationId = input.locationId ?? null;
  const now = new Date();

  type TxOut =
    | { kind: "error"; error: string }
    | { kind: "changed"; affected: DayLockAffected[] }
    | { kind: "ok"; data: DayLockApplyData };
  let out: TxOut;
  try {
    out = await runWithRls(tenantId, async (tx): Promise<TxOut> => {
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
      let locationIsPrimary = false;
      if (locationId) {
        const loc = await lockAndCheckLocation(tx, tenantId, locationId);
        if (!loc.ok) return { kind: "error", error: loc.error };
        locationIsPrimary = loc.isPrimary;
      }

      // 4. Recalcular afectados: si no es lo que vio el usuario, no aplicar.
      const affected = await findAffectedBookings(tx, {
        tenantId,
        startsAt: win.startsAt,
        endsAt: win.endsAt,
        practitionerIds: input.practitionerIds ? pracIds : null,
        locationId,
        locationIsPrimary,
        now,
      });
      if (!sameIds(affected.map((a) => a.id), input.expectedAffectedIds)) {
        return { kind: "changed", affected };
      }

      // 5. Bloqueo(s). Idempotente: si cada destino ya tiene un bloqueo vivo
      //    idéntico (doble click, reintento tras un timeout), se reusa.
      const existing = await tx.timeBlock.findMany({
        where: {
          tenantId,
          deletedAt: null,
          startsAt: win.startsAt,
          endsAt: win.endsAt,
          locationId,
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
      if (input.bookingsDecision === "cancel" && affected.length > 0) {
        const res = await cancelBookingsInTx(tx, {
          tenantId,
          bookingIds: affected.map((a) => a.id),
          reason: `Candado del día ${input.dayKey}${input.reason ? `: ${input.reason}` : ""}`,
          actorId: actor.userId,
          auditAction: "booking.cancel.dayLock",
        });
        cancelled = res.cancelled.map((c) => byId.get(c.id)!).filter(Boolean);
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
      };
    });
  } catch (e) {
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
  await audit({
    tenantId,
    actorId: actor.userId,
    action: "timeBlock.dayLock",
    entity: "TimeBlock",
    entityId: data.groupId ?? data.ids[0],
    payload: {
      dayKey: input.dayKey,
      ids: data.ids,
      groupId: data.groupId,
      reused: data.reused,
      practitionerIds: targets,
      locationId,
      allDay: input.allDay,
      startsAt: data.startsAt,
      endsAt: data.endsAt,
      reason: input.reason,
      decision: data.decision,
      keptIds: data.kept.map((b) => b.id),
      cancelledIds: data.cancelled.map((b) => b.id),
      skipped: data.skipped.map((s) => ({ id: s.booking.id, reason: s.reason })),
    },
  });
  revalidatePath("/agenda");
  // Cancelar mueve los conteos del dashboard y los días con turnos del mini-calendario.
  revalidateTag(tags.bookingDays(tenantId));
  revalidateTag(tags.dashboard(tenantId));
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
export async function removeDayLock(raw: DayLockRemoveInput): Promise<ActionResult<RemoveDayLockData>> {
  const parsed = DayLockRemove.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Datos inválidos", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const { dayKey, practitionerId, blockIds } = parsed.data;
  const { actor, caps } = await actorWithCaps();
  const tenantId = actor.tenantId;
  assertCanManageTargets(caps, actor.practitionerId, [practitionerId]);
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
    logger.error("dayLock.remove.failed", { err: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: "No pudimos desbloquear el día." };
  }
  if (out.kind === "none") return { ok: false, error: "Ese día no tiene bloqueos." };
  if (out.kind === "forbidden") throw new ForbiddenError(FORBIDDEN_DELETE);

  if (out.deletedIds.length) {
    await audit({
      tenantId,
      actorId: actor.userId,
      action: "timeBlock.dayUnlock",
      entity: "TimeBlock",
      entityId: out.deletedIds[0],
      payload: {
        dayKey,
        practitionerId,
        ids: out.deletedIds,
        remainingIds: out.remaining.map((b) => b.id),
      },
    });
    revalidatePath("/agenda");
  }
  return { ok: true, data: { deleted: out.deletedIds.length, remaining: out.remaining } };
}
