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
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { runWithRls, type DbClient } from "@/lib/rls";
import { requireCapability } from "@/lib/authz";
import { audit } from "@/lib/audit";
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
} from "@/lib/schedule-validate";
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
import { FALLBACK_WORKING_DOWS, type ScheduleRange } from "@/lib/availability/types";
import type { ActionResult } from "@/lib/validation";

const WRITE_MSG = "Solo OWNER/ADMIN pueden configurar sedes y horarios.";
const READ_MSG = "No tenés permiso para ver la agenda del consultorio.";
const PRAC_NOT_FOUND = "Profesional no encontrado.";

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
function parseStoredRanges(v: Prisma.JsonValue | null): ScheduleRange[] | null {
  if (!Array.isArray(v)) return null;
  return v.flatMap((r) => {
    if (!r || typeof r !== "object" || Array.isArray(r)) return [];
    const o = r as Record<string, unknown>;
    return typeof o.startMin === "number" && typeof o.endMin === "number" && typeof o.locationId === "string"
      ? [{ startMin: o.startMin, endMin: o.endMin, locationId: o.locationId }]
      : [];
  });
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
        validFrom: true,
        validUntil: true,
        updatedAt: true,
      },
    });
    const version = rows.length
      ? new Date(Math.max(...rows.map((r) => r.updatedAt.getTime()))).toISOString()
      : null;
    return {
      practitionerId: id.data,
      ranges: rows.map((r) => ({
        id: r.id,
        dow: r.dow,
        startMin: r.startMin,
        endMin: r.endMin,
        locationId: r.locationId,
        validFrom: r.validFrom ? dbDateToDayKey(r.validFrom) : null,
        validUntil: r.validUntil ? dbDateToDayKey(r.validUntil) : null,
      })),
      version,
      isFallback: rows.length === 0,
      tenantHours: await tenantHours(tx, actor.tenantId),
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
 * Las franjas guardadas acá no llevan vigencia (`validFrom/validUntil` null):
 * el editor de B3.4 edita la plantilla vigente. Reemplazar borra también
 * franjas con vigencia que hubiera (hoy nadie las escribe).
 */
export async function savePractitionerWeek(
  practitionerId: string,
  ranges: ReadonlyArray<{ dow: number; startMin: number; endMin: number; locationId: string }>,
  expectedUpdatedAt?: string | null
): Promise<ActionResult<{ version: string | null }>> {
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

  try {
    const res = await runWithRls(actor.tenantId, async (tx) => {
      await lockTenantLocationsShared(tx, actor.tenantId);
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
      if (!full.ok) {
        throw new Abort({
          ok: false,
          error: "Revisá las franjas marcadas.",
          fieldErrors: rangeErrorsToFieldErrors(full.errors),
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
          dow: r.dow,
          startMin: r.startMin,
          endMin: r.endMin,
        })),
      });
      return { before, version: await versionOf(tx, actor.tenantId, input.practitionerId) };
    });
    await audit({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: "schedule.saveWeek",
      entity: "Practitioner",
      entityId: input.practitionerId,
      payload: {
        before: summarizeWeek(res.before),
        after: summarizeWeek(input.ranges),
        locations: [...new Set(input.ranges.map((r) => r.locationId))],
      },
    });
    revalidateAll();
    return { ok: true, data: { version: res.version } };
  } catch (e) {
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
        where: {
          tenantId: actor.tenantId,
          user: { memberships: { some: { tenantId: actor.tenantId, acceptedAt: { not: null } } } },
        },
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
        name: p.user.fullName ?? p.user.email,
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
export async function upsertException(raw: UpsertExceptionRaw): Promise<ActionResult<{ id: string }>> {
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

  try {
    const res = await runWithRls(actor.tenantId, async (tx) => {
      await lockTenantLocationsShared(tx, actor.tenantId);
      await lockKey(tx, `kinesoft:schedexc:${actor.tenantId}:${input.practitionerId ?? "*"}:${input.date}`);
      if (input.practitionerId && !(await findPractitioner(tx, actor.tenantId, input.practitionerId))) {
        throw new Abort({ ok: false, error: PRAC_NOT_FOUND });
      }
      if (ranges) {
        const active = await activeLocationSet(tx, actor.tenantId, ranges.map((r) => r.locationId));
        const full = validateDayRanges(ranges, { activeLocationIds: active });
        if (!full.ok) {
          throw new Abort({
            ok: false,
            error: "Revisá las franjas marcadas.",
            fieldErrors: rangeErrorsToFieldErrors(full.errors),
          });
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
    await audit({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: res.created ? "scheduleException.create" : "scheduleException.update",
      entity: "ScheduleException",
      entityId: res.id,
      payload: {
        practitionerId: input.practitionerId,
        date: input.date,
        kind: input.kind,
        ...(ranges ? { ranges } : {}),
      },
    });
    revalidateAll();
    return { ok: true, data: { id: res.id } };
  } catch (e) {
    if (e instanceof Abort) return e.result;
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, error: "Ya hay una excepción para ese día. Recargá y editala." };
    }
    logger.error("scheduleException.upsert.failed", { err: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: "No pudimos guardar la excepción." };
  }
}

export async function deleteException(id: string): Promise<ActionResult> {
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
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    action: "scheduleException.delete",
    entity: "ScheduleException",
    entityId: deleted.id,
    payload: { practitionerId: deleted.practitionerId, date: dbDateToDayKey(deleted.date), kind: deleted.kind },
  });
  revalidateAll();
  return { ok: true, data: undefined };
}
