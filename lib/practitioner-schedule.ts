"use server";

/**
 * Franjas semanales por profesional y excepciones por día (B2.4a CFG-api-1,
 * B-pre). Tablas de `agenda_foundations`: `PractitionerSchedule` y
 * `ScheduleException`. Las consume el motor de disponibilidad vía
 * `lib/availability-loader.ts`; acá solo se configuran.
 *
 * Authz: leer = `agenda.viewAll`; escribir = `schedule.configure` (hoy solo
 * OWNER/ADMIN: las franjas abren o cierran disponibilidad en el turnero
 * público y en el batch de Planes). `lib/capabilities.ts`.
 *
 * Tenant: `where: { tenantId }` a mano en cada query (BYPASSRLS en prod) y
 * los ids de entrada (profesional, sede) se validan contra el tenant DENTRO
 * de la tx que escribe: las FK saltean RLS, así que sin esto se podría colgar
 * una franja de la sede de otro consultorio.
 *
 * Concurrencia:
 *   • Guardar la semana es un REEMPLAZO ATÓMICO (deleteMany + createMany en una
 *     tx) con optimistic lock opcional: `version` = ISO del último `updatedAt`
 *     de las franjas del profesional (null = no tenía). Advisory lock por
 *     profesional para que dos guardados no se intercalen entre el chequeo de
 *     versión y el reemplazo.
 *   • Las escrituras que referencian sedes toman COMPARTIDO el lock de sedes
 *     del tenant (`lib/locations.ts` lo toma exclusivo al archivar): una
 *     franja nueva no puede caer en una sede que se está archivando.
 *
 * Fechas: `ScheduleException.date` es `@db.Date` → DayKey con
 * `dayKeyToDbDate`/`dbDateToDayKey` de `lib/schedule-validate.ts` (etiqueta de
 * día por UTC, ver ahí por qué). "Hoy" siempre con `toARDateKey`.
 */
import { displayMemberName } from "@/lib/display-name";
import { withSupportWritable } from "@/lib/support-writable";
import { readOnlyFailure, withReadOnlyResult } from "@/lib/read-only-result";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { runWithRls, type DbClient } from "@/lib/rls";
import { requireCapability } from "@/lib/authz";
import { logger } from "@/lib/logger";
import { toARDateKey } from "@/lib/datetime-ar";
// Lock compartido de sedes (ver cabecera); módulo único desde el integrador B2.
import { lockTenantLocationsShared } from "@/lib/location-lock";
import {
  dayKeyDiff,
  dayKeyToDbDate,
  dbDateToDayKey,
  rangeErrorsToFieldErrors,
  summarizeWeek,
  validateDayRanges,
  validateWeekRanges,
  type RangeRowError,
} from "@/lib/schedule-validate";
import {
  dayKeyShortLabel,
  effectiveRoomRowsOn,
  formatClock,
  roomConflictsToRowErrors,
  roomScheduleConflicts,
  type RoomUsageRow,
} from "@/lib/room-schedule-validate";
import { BAD_ROOM_ERROR } from "@/lib/bookings-constants";
import { dowOfDayKey } from "@/lib/availability/day";
import {
  EntityId,
  ExceptionRangeInput,
  MAX_EXCEPTION_WINDOW_DAYS,
  SaveWeekInput,
  UpsertExceptionInput,
  type PractitionerScheduleSummaryRow,
  type PractitionerScheduleView,
  type ScheduleExceptionRow,
  type UpsertExceptionRaw,
} from "@/lib/practitioner-schedule-schemas";
import { FALLBACK_WORKING_DOWS, type DayKey, type ScheduleRange } from "@/lib/availability/types";
import type { ActionResult } from "@/lib/validation";
import { bookablePractitionerWhere } from "@/lib/practitioner-scope";

const WRITE_MSG = "Solo OWNER/ADMIN pueden configurar sedes y horarios.";
const READ_MSG = "No tenés permiso para ver la agenda del consultorio.";
const PRAC_NOT_FOUND = "Profesional no encontrado.";
const TENANT_WIDE_ROOM_ERROR =
  "Un horario especial de todo el consultorio no lleva sala. Asignala en el horario especial de cada profesional.";

// ─────────────────────────────────────────────────────────────────────────────
// Internos (no exportados: un "use server" solo exporta actions)
// ─────────────────────────────────────────────────────────────────────────────

async function lockKey(tx: DbClient, key: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

async function findPractitioner(tx: DbClient, tenantId: string, id: string) {
  return tx.practitioner.findFirst({ where: { id, tenantId }, select: { id: true } });
}

/** Ids de sedes ACTIVAS del tenant dentro de `ids`. */
async function activeLocationSet(tx: DbClient, tenantId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await tx.location.findMany({
    where: { tenantId, active: true, id: { in: [...new Set(ids)] } },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

async function tenantHours(tx: DbClient, tenantId: string) {
  const t = await tx.tenant.findFirst({
    where: { id: tenantId },
    select: { businessHoursStart: true, businessHoursEnd: true },
  });
  return {
    startMin: (t?.businessHoursStart ?? 8) * 60,
    endMin: (t?.businessHoursEnd ?? 19) * 60,
  };
}

/**
 * `tenantHours` + "¿el consultorio tiene alguna sala activa?" en UNA sentencia
 * (el `_count` de Prisma va como subconsulta agregada del mismo SELECT).
 *
 * SRZ (FX1): `getPractitionerSchedule` corría `loadRoomUsage` siempre, +1 query
 * aunque el consultorio no tuviera salas (revisión (a) de SR). Con esto, un
 * consultorio sin salas lee lo mismo que antes de SR (0 sentencias nuevas) y
 * uno con salas paga solo la de `roomUsage`. Una sala ARCHIVADA no cuenta:
 * `archiveRoom` se niega mientras haya franjas vigentes en ella (SR-D8) y
 * `loadRoomUsage` solo trae vigentes, así que no habría nada que mostrar.
 */
async function tenantHoursAndRooms(tx: DbClient, tenantId: string) {
  const t = await tx.tenant.findFirst({
    where: { id: tenantId },
    select: {
      businessHoursStart: true,
      businessHoursEnd: true,
      _count: { select: { rooms: { where: { tenantId, active: true } } } },
    },
  });
  return {
    hours: {
      startMin: (t?.businessHoursStart ?? 8) * 60,
      endMin: (t?.businessHoursEnd ?? 19) * 60,
    },
    hasActiveRooms: (t?._count.rooms ?? 0) > 0,
  };
}

async function versionOf(tx: DbClient, tenantId: string, practitionerId: string): Promise<string | null> {
  const agg = await tx.practitionerSchedule.aggregate({
    where: { tenantId, practitionerId },
    _max: { updatedAt: true },
  });
  return agg._max.updatedAt?.toISOString() ?? null;
}

/** Corta y revierte la tx con un resultado ya armado para la UI. */
class Abort extends Error {
  constructor(public result: { ok: false; error: string; fieldErrors?: Record<string, string[]> }) {
    super(result.error);
  }
}

/** `ranges` JSON de la base → forma tipada (defensivo: la base solo garantiza "array"). */
function parseStoredRanges(
  v: Prisma.JsonValue | null
): Array<ScheduleRange & { roomId: string | null }> | null {
  if (!Array.isArray(v)) return null;
  return v.flatMap((r) => {
    if (!r || typeof r !== "object" || Array.isArray(r)) return [];
    const o = r as Record<string, unknown>;
    return typeof o.startMin === "number" && typeof o.endMin === "number" && typeof o.locationId === "string"
      ? [
          {
            startMin: o.startMin,
            endMin: o.endMin,
            locationId: o.locationId,
            // SR1c: las excepciones previas a SR no lo traen = sin sala.
            roomId: typeof o.roomId === "string" && o.roomId ? o.roomId : null,
          },
        ]
      : [];
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Salas en franjas y excepciones (SR1c)
// ─────────────────────────────────────────────────────────────────────────────
//
// Lock `kinesoft:room-schedule:<tenantId>` (EXCLUSIVO, alcance de tx): serializa
// las escrituras de Configuración que ASIGNAN sala (semana y excepciones), para
// que dos profesionales no tomen la misma sala a la vez entre el "leo las
// franjas de los demás" y el "escribo la mía" (sin él, dos guardados
// simultáneos ven la sala libre y entran los dos). Orden fijo, sin ciclos:
//   sedes COMPARTIDO → room-schedule → `schedule:<pracId>` / `schedexc:…`.
// Solo se toma si el payload trae alguna sala: guardar un horario sin salas no
// se serializa contra el resto del consultorio. NINGÚN write-path de turnos lo
// toma (enmienda C2 1b): no entra en el orden paciente → cupo → sala → sedes.
// `archiveRoom` (SR1b) toma el de sedes EXCLUSIVO, así que la sala validada acá
// (después del compartido) no se archiva antes del COMMIT.

const roomScheduleLockKey = (tenantId: string) => `kinesoft:room-schedule:${tenantId}`;

type RoomInfoRow = { id: string; locationId: string; capacity: number; name: string };

/** Salas ACTIVAS del tenant (en sede activa) dentro de `ids`. Va DESPUÉS del lock compartido de sedes. */
async function activeRoomMap(tx: DbClient, tenantId: string, ids: string[]): Promise<Map<string, RoomInfoRow>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.room.findMany({
    where: { tenantId, active: true, location: { active: true }, id: { in: [...new Set(ids)] } },
    select: { id: true, locationId: true, capacity: true, name: true },
  });
  return new Map(rows.map((r) => [r.id, r]));
}

/** Franja VENCIDA: su `validUntil` (inclusive) ya pasó en el día AR de hoy. */
function isExpiredRange(r: { validUntil?: DayKey | null }, today: DayKey): boolean {
  return r.validUntil != null && r.validUntil < today;
}

/**
 * Sede de las salas del tenant dentro de `ids`, ACTIVAS O NO (solo para
 * franjas vencidas, ver `badRoomErrors`). Solo corre si hay alguna franja
 * vencida con una sala que no está activa: guardar una semana normal no suma
 * sentencias.
 */
async function tenantRoomLocations(tx: DbClient, tenantId: string, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.room.findMany({
    where: { tenantId, id: { in: [...new Set(ids)] } },
    select: { id: true, locationId: true },
  });
  return new Map(rows.map((r) => [r.id, r.locationId]));
}

/**
 * Errores por fila de sala: inexistente, ajena, archivada o de OTRA sede que
 * la franja (las FKs compuestas también lo frenarían, pero con un 23503 en vez
 * del error por fila).
 *
 * SRZ (FX1): una franja VENCIDA (`validUntil` < hoy AR) no se valida contra las
 * salas ACTIVAS. El bug: el editor re-manda todas las franjas (reemplazo
 * atómico), así que una franja vieja cuya sala se archivó después (archiveRoom
 * lo permite: ya no está vigente) dejaba la semana sin poder guardarse nunca
 * más. La vencida no rige ni choca con nadie (`roomScheduleConflicts` la
 * saltea). Igual se exige que la sala sea del tenant y de la misma sede
 * (`expiredRooms`): si no, la FK compuesta tira un 23503 → "No pudimos guardar".
 * El cliente hace lo mismo en `validateDraft` (FX3).
 */
function badRoomErrors(
  ranges: ReadonlyArray<{ locationId: string; roomId?: string | null; validUntil?: DayKey | null }>,
  rooms: ReadonlyMap<string, RoomInfoRow>,
  expired?: { today: DayKey; roomLocations: ReadonlyMap<string, string> }
): RangeRowError[] {
  const out: RangeRowError[] = [];
  ranges.forEach((r, index) => {
    if (!r.roomId) return;
    const locationId =
      rooms.get(r.roomId)?.locationId ??
      (expired && isExpiredRange(r, expired.today) ? expired.roomLocations.get(r.roomId) : undefined);
    if (locationId !== r.locationId) out.push({ index, message: BAD_ROOM_ERROR });
  });
  return out;
}

function nameOfUser(u: { fullName: string | null; email: string }): string {
  return displayMemberName(u.fullName); // DIR-0: nunca el email
}

const ROOM_USAGE_SELECT = {
  practitionerId: true,
  roomId: true,
  dow: true,
  startMin: true,
  endMin: true,
  validFrom: true,
  validUntil: true,
  practitioner: { select: { user: { select: { fullName: true, email: true } } } },
} satisfies Prisma.PractitionerScheduleSelect;

/**
 * Franjas con sala de los DEMÁS profesionales, vigentes hoy o a futuro (las
 * vencidas no chocan con nada). `roomIds` acota a esas salas (validación);
 * omitido = todas (lectura para la UI).
 */
async function loadRoomUsage(
  tx: DbClient,
  tenantId: string,
  o: { excludePractitionerId: string; today: DayKey; roomIds?: string[] }
): Promise<RoomUsageRow[]> {
  const rows = await tx.practitionerSchedule.findMany({
    where: {
      tenantId,
      practitionerId: { not: o.excludePractitionerId },
      roomId: o.roomIds ? { in: o.roomIds } : { not: null },
      OR: [{ validUntil: null }, { validUntil: { gte: dayKeyToDbDate(o.today) } }],
    },
    orderBy: [{ dow: "asc" }, { startMin: "asc" }, { practitionerId: "asc" }],
    select: ROOM_USAGE_SELECT,
  });
  return rows.map((r) => ({
    roomId: r.roomId!,
    practitionerId: r.practitionerId,
    practitionerName: nameOfUser(r.practitioner.user),
    dow: r.dow,
    startMin: r.startMin,
    endMin: r.endMin,
    validFrom: r.validFrom ? dbDateToDayKey(r.validFrom) : null,
    validUntil: r.validUntil ? dbDateToDayKey(r.validUntil) : null,
  }));
}

/** Nombres de profesionales del tenant (para el copy de choques con excepciones). */
async function practitionerNames(tx: DbClient, tenantId: string, ids: string[]): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  const rows = await tx.practitioner.findMany({
    where: { tenantId, id: { in: [...new Set(ids)] } },
    select: { id: true, user: { select: { fullName: true, email: true } } },
  });
  return Object.fromEntries(rows.map((r) => [r.id, nameOfUser(r.user)]));
}

/** Tope de excepciones futuras de otros que se revisan para avisos (perf de Configuración). */
const WARN_EXCEPTIONS_MAX = 200;

/**
 * SR-D4: una plantilla contra EXCEPCIONES futuras de otros profesionales no es
 * error, es aviso (la excepción es puntual y la puede haber cargado otro; el
 * día efectivo de cada uno lo vuelve a validar `upsertException`). Para cada
 * fecha con una excepción con sala de las mías, se arma el día efectivo de
 * los demás (excepción > consultorio > plantilla) y se cruzan mis franjas de
 * ese dow vigentes ese día.
 */
async function futureExceptionWarnings(
  tx: DbClient,
  tenantId: string,
  o: {
    practitionerId: string;
    today: DayKey;
    mine: ReadonlyArray<{ dow: number; startMin: number; endMin: number; roomId: string | null; validFrom: DayKey | null; validUntil: DayKey | null }>;
    rooms: ReadonlyMap<string, RoomInfoRow>;
    templates: ReadonlyArray<RoomUsageRow>;
  }
): Promise<string[]> {
  const roomIds = [...new Set(o.mine.flatMap((r) => (r.roomId ? [r.roomId] : [])))];
  if (roomIds.length === 0) return [];
  const withRoom = await tx.scheduleException.findMany({
    where: {
      tenantId,
      kind: "CUSTOM_HOURS",
      date: { gte: dayKeyToDbDate(o.today) },
      practitionerId: { not: o.practitionerId },
      AND: [{ practitionerId: { not: null } }],
      OR: roomIds.map((id) => ({ ranges: { array_contains: [{ roomId: id }] } })),
    },
    orderBy: { date: "asc" },
    take: WARN_EXCEPTIONS_MAX,
    select: { date: true },
  });
  const dates = [...new Set(withRoom.map((e) => dbDateToDayKey(e.date)))];
  if (dates.length === 0) return [];
  const sameDays = await tx.scheduleException.findMany({
    where: { tenantId, date: { in: dates.map(dayKeyToDbDate) } },
    select: { date: true, practitionerId: true, kind: true, ranges: true },
  });
  const names = await practitionerNames(
    tx,
    tenantId,
    sameDays.flatMap((e) => (e.practitionerId ? [e.practitionerId] : []))
  );
  const capacities = new Map([...o.rooms.values()].map((r) => [r.id, r.capacity]));
  const warnings: string[] = [];
  for (const date of dates) {
    const dayExc = sameDays
      .filter((e) => dbDateToDayKey(e.date) === date && e.practitionerId !== o.practitionerId)
      .map((e) => ({ practitionerId: e.practitionerId, kind: e.kind, ranges: parseStoredRanges(e.ranges) }));
    // Si yo tengo excepción ese día, mi plantilla no rige: la valida upsertException.
    if (sameDays.some((e) => dbDateToDayKey(e.date) === date && e.practitionerId === o.practitionerId)) continue;
    // Ni la plantilla de nadie si el consultorio entero tiene excepción ese día.
    if (dayExc.some((e) => e.practitionerId == null)) continue;
    const others = effectiveRoomRowsOn(date, o.templates, dayExc, {
      excludePractitionerId: o.practitionerId,
      names,
    });
    // Solo interesan los choques en los que entra una EXCEPCIÓN (plantilla vs
    // plantilla ya es error duro).
    const fromExceptions = new Set(dayExc.flatMap((e) => (e.practitionerId ? [e.practitionerId] : [])));
    // Mi franja "ese día": la ventana de un solo día si su vigencia lo contiene;
    // si no, sin sala (no participa del cruce).
    const mineThatDay = o.mine.map((r) =>
      (r.validFrom == null || r.validFrom <= date) && (r.validUntil == null || date <= r.validUntil)
        ? { ...r, validFrom: date, validUntil: date }
        : { ...r, roomId: null }
    );
    const conflicts = roomScheduleConflicts(
      mineThatDay,
      others,
      capacities,
      { practitionerId: o.practitionerId, mode: "day" }
    );
    for (const c of conflicts) {
      if (!c.practitionerIds.some((p) => fromExceptions.has(p))) continue;
      const room = o.rooms.get(c.roomId);
      warnings.push(
        `El ${dayKeyShortLabel(date)}, ${room?.name ?? "esa sala"} ya la ${c.practitionerNames.length > 1 ? "usan" : "usa"} ${c.practitionerNames.join(" y ")} de ${formatClock(c.startMin)} a ${formatClock(c.endMin)} (horario especial). Revisá ese día.`
      );
    }
  }
  return [...new Set(warnings)];
}

function revalidateAll() {
  revalidatePath("/configuracion");
  revalidatePath("/agenda");
}

// ─────────────────────────────────────────────────────────────────────────────
// Franjas semanales
// ─────────────────────────────────────────────────────────────────────────────

/** Semana de un profesional del tenant; null si no existe (o es de otro tenant). */
export async function getPractitionerSchedule(
  practitionerId: string
): Promise<PractitionerScheduleView | null> {
  const { actor } = await requireCapability("agenda.viewAll", READ_MSG);
  const id = EntityId.safeParse(practitionerId);
  if (!id.success) return null;
  return runWithRls(actor.tenantId, async (tx) => {
    if (!(await findPractitioner(tx, actor.tenantId, id.data))) return null;
    const rows = await tx.practitionerSchedule.findMany({
      where: { tenantId: actor.tenantId, practitionerId: id.data },
      orderBy: [{ dow: "asc" }, { startMin: "asc" }],
      select: {
        id: true,
        dow: true,
        startMin: true,
        endMin: true,
        locationId: true,
        roomId: true,
        validFrom: true,
        validUntil: true,
        updatedAt: true,
      },
    });
    const version = rows.length
      ? new Date(Math.max(...rows.map((r) => r.updatedAt.getTime()))).toISOString()
      : null;
    const tenant = await tenantHoursAndRooms(tx, actor.tenantId);
    return {
      practitionerId: id.data,
      ranges: rows.map((r) => ({
        id: r.id,
        dow: r.dow,
        startMin: r.startMin,
        endMin: r.endMin,
        locationId: r.locationId,
        roomId: r.roomId,
        validFrom: r.validFrom ? dbDateToDayKey(r.validFrom) : null,
        validUntil: r.validUntil ? dbDateToDayKey(r.validUntil) : null,
      })),
      version,
      isFallback: rows.length === 0,
      tenantHours: tenant.hours,
      // SR1c: para que la UI valide la sala en el cliente con roomScheduleConflicts.
      // SRZ (FX1): sin salas activas no se consulta (ver `tenantHoursAndRooms`).
      roomUsage: tenant.hasActiveRooms
        ? await loadRoomUsage(tx, actor.tenantId, {
            excludePractitionerId: id.data,
            today: toARDateKey(new Date()),
          })
        : [],
    };
  });
}

/**
 * Reemplaza la semana completa del profesional (lo que no viene, se borra).
 * Errores de negocio por fila en `fieldErrors["ranges.<i>"]`.
 *
 * Semana vacía: se rechaza. Un profesional sin franjas NO queda "sin
 * atención": el motor le aplica el horario del consultorio lun-sáb (red de
 * seguridad permanente de B-pre), así que guardar "nada" haría lo contrario
 * de lo que el usuario cree. Para no atender un día: excepción CLOSED.
 *
 * SR1c: cada franja lleva `roomId` y vigencia (`validFrom`/`validUntil`)
 * opcionales; omitidos = sin sala y siempre (lo que mandaban el editor y el
 * onboarding antes de SR: reemplazar sigue borrando lo que no viene). Con sala:
 *   • la sala es del tenant, está activa y es de la MISMA sede que la franja
 *     (error por fila `BAD_ROOM_ERROR`);
 *   • SR-D4: choque DURO contra las plantillas de los demás profesionales
 *     (mismo dow, horario que se pisa, vigencias que se cruzan desde hoy) si
 *     los profesionales distintos a la vez superan `Room.capacity`; error por
 *     fila "Esa sala ya la usa …";
 *   • contra excepciones futuras de otros: solo `warnings` (se guarda igual).
 */
export async function savePractitionerWeek(...args: Parameters<typeof savePractitionerWeekImpl>): ReturnType<typeof savePractitionerWeekImpl> {
  return withReadOnlyResult(() => withSupportWritable("lib/practitioner-schedule.ts#savePractitionerWeek", () => savePractitionerWeekImpl(...args)));
}

async function savePractitionerWeekImpl(
  practitionerId: string,
  ranges: ReadonlyArray<{
    dow: number;
    startMin: number;
    endMin: number;
    locationId: string;
    roomId?: string | null;
    validFrom?: string | null;
    validUntil?: string | null;
  }>,
  expectedUpdatedAt?: string | null
): Promise<ActionResult<{ version: string | null; warnings?: string[] }>> {
  const { actor } = await requireCapability("schedule.configure", WRITE_MSG);
  const parsed = SaveWeekInput.safeParse({ practitionerId, ranges, expectedUpdatedAt });
  if (!parsed.success) {
    return { ok: false, error: "Datos inválidos", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const input = parsed.data;
  if (input.ranges.length === 0) {
    return {
      ok: false,
      error:
        "Cargá al menos una franja. Sin franjas, el profesional hereda el horario del consultorio; para no atender un día usá una excepción.",
    };
  }
  const shape = validateWeekRanges(input.ranges);
  if (!shape.ok) {
    return { ok: false, error: "Revisá las franjas marcadas.", fieldErrors: rangeErrorsToFieldErrors(shape.errors) };
  }

  const roomIds = [...new Set(input.ranges.flatMap((r) => (r.roomId ? [r.roomId] : [])))];
  const today = toARDateKey(new Date());

  try {
    const res = await runWithRls(actor.tenantId, async (tx) => {
      await lockTenantLocationsShared(tx, actor.tenantId);
      // Orden fijo: sedes compartido → room-schedule → schedule:<prac> (ver "Salas en franjas").
      if (roomIds.length > 0) await lockKey(tx, roomScheduleLockKey(actor.tenantId));
      await lockKey(tx, `kinesoft:schedule:${input.practitionerId}`);
      if (!(await findPractitioner(tx, actor.tenantId, input.practitionerId))) {
        throw new Abort({ ok: false, error: PRAC_NOT_FOUND });
      }
      const active = await activeLocationSet(
        tx,
        actor.tenantId,
        input.ranges.map((r) => r.locationId)
      );
      const full = validateWeekRanges(input.ranges, { activeLocationIds: active });
      // Sala validada DESPUÉS del lock compartido de sedes (archiveRoom toma el exclusivo).
      const rooms = await activeRoomMap(tx, actor.tenantId, roomIds);
      const staleRoomIds = input.ranges.flatMap((r) =>
        r.roomId && !rooms.has(r.roomId) && isExpiredRange(r, today) ? [r.roomId] : []
      );
      const roomErrs = badRoomErrors(input.ranges, rooms, {
        today,
        roomLocations: await tenantRoomLocations(tx, actor.tenantId, staleRoomIds),
      });
      if (!full.ok || roomErrs.length > 0) {
        const shapeErrs = full.ok ? [] : full.errors;
        const taken = new Set(shapeErrs.map((e) => e.index));
        throw new Abort({
          ok: false,
          error: "Revisá las franjas marcadas.",
          fieldErrors: rangeErrorsToFieldErrors([...shapeErrs, ...roomErrs.filter((e) => !taken.has(e.index))]),
        });
      }
      let warnings: string[] = [];
      if (roomIds.length > 0) {
        const others = await loadRoomUsage(tx, actor.tenantId, {
          excludePractitionerId: input.practitionerId,
          today,
          roomIds,
        });
        const capacities = new Map([...rooms.values()].map((r) => [r.id, r.capacity]));
        const conflicts = roomScheduleConflicts(input.ranges, others, capacities, {
          practitionerId: input.practitionerId,
          from: today,
        });
        if (conflicts.length > 0) {
          throw new Abort({
            ok: false,
            error: "Revisá las franjas marcadas.",
            fieldErrors: rangeErrorsToFieldErrors(roomConflictsToRowErrors(conflicts)),
          });
        }
        warnings = await futureExceptionWarnings(tx, actor.tenantId, {
          practitionerId: input.practitionerId,
          today,
          mine: input.ranges,
          rooms,
          templates: others,
        });
      }
      const current = await versionOf(tx, actor.tenantId, input.practitionerId);
      if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== current) {
        throw new Abort({
          ok: false,
          error: "Alguien cambió este horario mientras lo editabas. Recargá para ver la versión actual.",
        });
      }
      const before = await tx.practitionerSchedule.findMany({
        where: { tenantId: actor.tenantId, practitionerId: input.practitionerId },
        select: { dow: true, startMin: true, endMin: true, locationId: true },
      });
      await tx.practitionerSchedule.deleteMany({
        where: { tenantId: actor.tenantId, practitionerId: input.practitionerId },
      });
      await tx.practitionerSchedule.createMany({
        data: input.ranges.map((r) => ({
          tenantId: actor.tenantId,
          practitionerId: input.practitionerId,
          locationId: r.locationId,
          roomId: r.roomId,
          dow: r.dow,
          startMin: r.startMin,
          endMin: r.endMin,
          validFrom: r.validFrom ? dayKeyToDbDate(r.validFrom) : null,
          validUntil: r.validUntil ? dayKeyToDbDate(r.validUntil) : null,
        })),
      });
      return { before, warnings, version: await versionOf(tx, actor.tenantId, input.practitionerId) };
    });
    revalidateAll();
    return {
      ok: true,
      data: { version: res.version, ...(res.warnings.length > 0 ? { warnings: res.warnings } : {}) },
    };
  } catch (e) {
    // EV1-E2 (readonly-residual-actions): modo lectura / soporte → su copy, no el genérico de abajo.
    const ro = readOnlyFailure(e);
    if (ro) return ro;
    if (e instanceof Abort) return e.result;
    logger.error("schedule.saveWeek.failed", { err: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: "No pudimos guardar el horario." };
  }
}

/**
 * Profesionales del tenant (membresía aceptada) con su horario resumido para
 * el listado de Configuración. Franjas vencidas (`validUntil` < hoy AR) no
 * cuentan. Sin franjas → resumen del horario heredado del consultorio.
 */
export async function getPractitionerScheduleSummary(): Promise<PractitionerScheduleSummaryRow[]> {
  const { actor } = await requireCapability("agenda.viewAll", READ_MSG);
  const today = dayKeyToDbDate(toARDateKey(new Date()));
  return runWithRls(actor.tenantId, async (tx) => {
    const [pracs, hours] = await Promise.all([
      tx.practitioner.findMany({
        // IAM-2e: solo quien atiende (rol clínico, sin suspender).
        where: bookablePractitionerWhere(actor.tenantId, { includeDisabledFilter: true }),
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          user: { select: { fullName: true, email: true } },
          schedules: {
            where: { tenantId: actor.tenantId, OR: [{ validUntil: null }, { validUntil: { gte: today } }] },
            select: { dow: true, startMin: true, endMin: true, locationId: true },
          },
        },
      }),
      tenantHours(tx, actor.tenantId),
    ]);
    return pracs.map((p) => {
      const isFallback = p.schedules.length === 0;
      const summary = isFallback
        ? summarizeWeek(FALLBACK_WORKING_DOWS.map((dow) => ({ dow, ...hours })))
        : summarizeWeek(p.schedules);
      return {
        practitionerId: p.id,
        name: displayMemberName(p.user.fullName),
        summary,
        isFallback,
        rangeCount: p.schedules.length,
        locationIds: [...new Set(p.schedules.map((s) => s.locationId))],
      };
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Excepciones por día
// ─────────────────────────────────────────────────────────────────────────────

const EXC_SELECT = {
  id: true,
  practitionerId: true,
  date: true,
  kind: true,
  ranges: true,
  reason: true,
} satisfies Prisma.ScheduleExceptionSelect;

function toExceptionRow(r: Prisma.ScheduleExceptionGetPayload<{ select: typeof EXC_SELECT }>): ScheduleExceptionRow {
  return {
    id: r.id,
    practitionerId: r.practitionerId,
    date: dbDateToDayKey(r.date),
    kind: r.kind,
    ranges: r.kind === "CUSTOM_HOURS" ? parseStoredRanges(r.ranges) : null,
    reason: r.reason,
  };
}

/**
 * Excepciones entre `from` y `to` (DayKeys AR, inclusive). Con
 * `practitionerId`: las de ese profesional + las de todo el consultorio.
 */
export async function listExceptions(range: {
  from: string;
  to: string;
  practitionerId?: string;
}): Promise<ScheduleExceptionRow[]> {
  const { actor } = await requireCapability("agenda.viewAll", READ_MSG);
  const parsed = ExceptionRangeInput.safeParse(range);
  if (!parsed.success) throw new Error("Rango de fechas inválido.");
  const { from, to, practitionerId } = parsed.data;
  const span = dayKeyDiff(from, to);
  if (span < 0 || span > MAX_EXCEPTION_WINDOW_DAYS) throw new Error("Rango de fechas inválido.");
  const rows = await runWithRls(actor.tenantId, (tx) =>
    tx.scheduleException.findMany({
      where: {
        tenantId: actor.tenantId,
        date: { gte: dayKeyToDbDate(from), lte: dayKeyToDbDate(to) },
        ...(practitionerId ? { OR: [{ practitionerId }, { practitionerId: null }] } : {}),
      },
      orderBy: [{ date: "asc" }, { practitionerId: "asc" }],
      select: EXC_SELECT,
    })
  );
  return rows.map(toExceptionRow);
}

/**
 * Crea o reemplaza la excepción de (profesional | consultorio, día). Hay a lo
 * sumo una por clave (índices únicos parciales `ScheduleException_*_key`);
 * como Prisma no puede hacer `upsert` sobre un índice parcial, se busca y se
 * actualiza o crea bajo un advisory lock de la clave.
 */
export async function upsertException(...args: Parameters<typeof upsertExceptionImpl>): ReturnType<typeof upsertExceptionImpl> {
  return withReadOnlyResult(() => withSupportWritable("lib/practitioner-schedule.ts#upsertException", () => upsertExceptionImpl(...args)));
}

async function upsertExceptionImpl(raw: UpsertExceptionRaw): Promise<ActionResult<{ id: string }>> {
  const { actor } = await requireCapability("schedule.configure", WRITE_MSG);
  const parsed = UpsertExceptionInput.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Datos inválidos", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const input = parsed.data;
  const ranges = input.kind === "CUSTOM_HOURS" ? (input.ranges ?? []) : null;
  if (ranges) {
    const shape = validateDayRanges(ranges);
    if (!shape.ok) {
      return { ok: false, error: "Revisá las franjas marcadas.", fieldErrors: rangeErrorsToFieldErrors(shape.errors) };
    }
  }
  const date = dayKeyToDbDate(input.date);
  const roomIds = [...new Set((ranges ?? []).flatMap((r) => (r.roomId ? [r.roomId] : [])))];
  // SR1c: una excepción de TODO el consultorio no asigna sala: la usarían todos
  // los profesionales a la vez y chocaría consigo misma. La sala va en la
  // excepción de cada profesional.
  if (ranges && input.practitionerId == null && roomIds.length > 0) {
    return {
      ok: false,
      error: "Revisá las franjas marcadas.",
      fieldErrors: rangeErrorsToFieldErrors(
        ranges.flatMap((r, index) => (r.roomId ? [{ index, message: TENANT_WIDE_ROOM_ERROR }] : []))
      ),
    };
  }

  try {
    const res = await runWithRls(actor.tenantId, async (tx) => {
      await lockTenantLocationsShared(tx, actor.tenantId);
      // Orden fijo: sedes compartido → room-schedule → schedexc (ver "Salas en franjas").
      if (roomIds.length > 0) await lockKey(tx, roomScheduleLockKey(actor.tenantId));
      await lockKey(tx, `kinesoft:schedexc:${actor.tenantId}:${input.practitionerId ?? "*"}:${input.date}`);
      if (input.practitionerId && !(await findPractitioner(tx, actor.tenantId, input.practitionerId))) {
        throw new Abort({ ok: false, error: PRAC_NOT_FOUND });
      }
      if (ranges) {
        const active = await activeLocationSet(tx, actor.tenantId, ranges.map((r) => r.locationId));
        const full = validateDayRanges(ranges, { activeLocationIds: active });
        const rooms = await activeRoomMap(tx, actor.tenantId, roomIds);
        const roomErrs = badRoomErrors(ranges, rooms);
        if (!full.ok || roomErrs.length > 0) {
          const shapeErrs = full.ok ? [] : full.errors;
          const taken = new Set(shapeErrs.map((e) => e.index));
          throw new Abort({
            ok: false,
            error: "Revisá las franjas marcadas.",
            fieldErrors: rangeErrorsToFieldErrors([...shapeErrs, ...roomErrs.filter((e) => !taken.has(e.index))]),
          });
        }
        if (roomIds.length > 0 && input.practitionerId) {
          // SR-D4: choque DURO contra el día EFECTIVO de los demás (su
          // excepción de ese día > la del consultorio > su plantilla vigente).
          const dow = dowOfDayKey(input.date);
          const [templates, dayExc] = await Promise.all([
            tx.practitionerSchedule.findMany({
              where: {
                tenantId: actor.tenantId,
                practitionerId: { not: input.practitionerId },
                roomId: { in: roomIds },
                dow,
                AND: [
                  { OR: [{ validFrom: null }, { validFrom: { lte: date } }] },
                  { OR: [{ validUntil: null }, { validUntil: { gte: date } }] },
                ],
              },
              select: ROOM_USAGE_SELECT,
            }),
            tx.scheduleException.findMany({
              // OR explícito: `{ not: X }` en SQL también descarta los NULL (la del consultorio).
              where: {
                tenantId: actor.tenantId,
                date,
                OR: [{ practitionerId: null }, { practitionerId: { not: input.practitionerId } }],
              },
              select: { practitionerId: true, kind: true, ranges: true },
            }),
          ]);
          const tplRows: RoomUsageRow[] = templates.map((r) => ({
            roomId: r.roomId!,
            practitionerId: r.practitionerId,
            practitionerName: nameOfUser(r.practitioner.user),
            dow: r.dow,
            startMin: r.startMin,
            endMin: r.endMin,
            validFrom: r.validFrom ? dbDateToDayKey(r.validFrom) : null,
            validUntil: r.validUntil ? dbDateToDayKey(r.validUntil) : null,
          }));
          const exc = dayExc.map((e) => ({
            practitionerId: e.practitionerId,
            kind: e.kind,
            ranges: parseStoredRanges(e.ranges),
          }));
          const names = await practitionerNames(
            tx,
            actor.tenantId,
            exc.flatMap((e) => (e.practitionerId && e.ranges?.some((r) => r.roomId) ? [e.practitionerId] : []))
          );
          const others = effectiveRoomRowsOn(input.date, tplRows, exc, {
            excludePractitionerId: input.practitionerId,
            names,
          });
          const conflicts = roomScheduleConflicts(
            ranges.map((r) => ({ ...r, dow, validFrom: input.date, validUntil: input.date })),
            others,
            new Map([...rooms.values()].map((r) => [r.id, r.capacity])),
            { practitionerId: input.practitionerId, mode: "day" }
          );
          if (conflicts.length > 0) {
            throw new Abort({
              ok: false,
              error: "Revisá las franjas marcadas.",
              fieldErrors: rangeErrorsToFieldErrors(roomConflictsToRowErrors(conflicts)),
            });
          }
        }
      }
      const data = {
        kind: input.kind,
        // Json nullable: null de SQL es `Prisma.DbNull` (un `null` JS sería JSON null).
        ranges: ranges ? (ranges as Prisma.InputJsonValue) : Prisma.DbNull,
        reason: input.reason,
      };
      const existing = await tx.scheduleException.findFirst({
        where: { tenantId: actor.tenantId, practitionerId: input.practitionerId, date },
        select: { id: true },
      });
      if (existing) {
        await tx.scheduleException.updateMany({
          where: { id: existing.id, tenantId: actor.tenantId },
          data,
        });
        return { id: existing.id, created: false };
      }
      const row = await tx.scheduleException.create({
        data: {
          tenantId: actor.tenantId,
          practitionerId: input.practitionerId,
          date,
          createdById: actor.userId,
          ...data,
        },
        select: { id: true },
      });
      return { id: row.id, created: true };
    });
    revalidateAll();
    return { ok: true, data: { id: res.id } };
  } catch (e) {
    // EV1-E2 (readonly-residual-actions): modo lectura / soporte → su copy, no el genérico de abajo.
    const ro = readOnlyFailure(e);
    if (ro) return ro;
    if (e instanceof Abort) return e.result;
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, error: "Ya hay una excepción para ese día. Recargá y editala." };
    }
    logger.error("scheduleException.upsert.failed", { err: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: "No pudimos guardar la excepción." };
  }
}

export async function deleteException(...args: Parameters<typeof deleteExceptionImpl>): ReturnType<typeof deleteExceptionImpl> {
  return withReadOnlyResult(() => withSupportWritable("lib/practitioner-schedule.ts#deleteException", () => deleteExceptionImpl(...args)));
}

async function deleteExceptionImpl(id: string): Promise<ActionResult> {
  const { actor } = await requireCapability("schedule.configure", WRITE_MSG);
  const idOk = EntityId.safeParse(id);
  if (!idOk.success) return { ok: false, error: "Excepción no encontrada." };
  const deleted = await runWithRls(actor.tenantId, async (tx) => {
    const row = await tx.scheduleException.findFirst({
      where: { id: idOk.data, tenantId: actor.tenantId },
      select: { id: true, practitionerId: true, date: true, kind: true },
    });
    if (!row) return null;
    await tx.scheduleException.deleteMany({ where: { id: row.id, tenantId: actor.tenantId } });
    return row;
  });
  if (!deleted) return { ok: false, error: "Excepción no encontrada." };
  revalidateAll();
  return { ok: true, data: undefined };
}
