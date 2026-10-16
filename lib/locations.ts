"use server";

/**
 * Sedes del consultorio (B2.4a CFG-api-1, B-pre). `Location` la crea la
 * migración `agenda_foundations` (backfill: una "Principal" por tenant).
 *
 * Authz: leer = `agenda.viewAll` (la agenda filtra por sede); escribir =
 * `schedule.configure` (solo admin hoy: la sede define dónde hay
 * disponibilidad en el turnero). Ver `lib/capabilities.ts`.
 *
 * Tenant: TODA query lleva `where: { tenantId }` a mano dentro de
 * `runWithRls` — en prod la conexión tiene BYPASSRLS y ese filtro es la única
 * barrera. Un id de sede de otro tenant se responde igual que uno inexistente.
 *
 * Concurrencia: las escrituras que cambian QUÉ sedes están activas o cuál es
 * la principal toman un advisory lock exclusivo por tenant; las que USAN una
 * sede (franjas, excepciones en `lib/practitioner-schedule.ts`) lo toman
 * compartido. Así "archivar" no puede intercalarse entre el conteo de
 * franjas y una franja nueva en esa sede (el conteo quedaría viejo).
 *
 * Archivar = `active = false` (nunca DELETE): `Booking.locationId` es
 * RESTRICT y el historial de turnos tiene que seguir diciendo dónde fue.
 *
 * Sin AuditEvent (PL-A2, §20.5.9): sedes, salas, horarios y bloqueos son
 * configuración operativa (ruido en el registro); se audita plata y acceso.
 */
import { withSupportWritable } from "@/lib/support-writable";
import { readOnlyFailure, withReadOnlyResult } from "@/lib/read-only-result";
import { revalidatePath, revalidateTag } from "next/cache";
import { Prisma } from "@prisma/client";
import { runWithRls, type DbClient } from "@/lib/rls";
import { requireCapability } from "@/lib/authz";
import { logger } from "@/lib/logger";
import { toARDateKey } from "@/lib/datetime-ar";
import { dayKeyToDbDate } from "@/lib/schedule-validate";
// Lock exclusivo de sedes (ver cabecera); módulo único desde el integrador B2.
import { lockTenantLocations } from "@/lib/location-lock";
import { liveProgramWhere } from "@/lib/plan-predicates";
import { listLocationsInTx } from "@/lib/locations-read";
import { provinceName } from "@/lib/ar-provinces";
import { tags } from "@/lib/cache-tags";
import {
  LocationId,
  LocationInput,
  type ArchiveLocationResult,
  type LocationArchiveBlockers,
  type LocationInputRaw,
  type LocationRow,
} from "@/lib/locations-schemas";
import type { ActionResult } from "@/lib/validation";

const WRITE_MSG = "Solo OWNER/ADMIN pueden configurar sedes y horarios.";
const READ_MSG = "No tenés permiso para ver la agenda del consultorio.";
const NOT_FOUND = "Sede no encontrada.";

function revalidateAll() {
  revalidatePath("/configuracion");
  revalidatePath("/agenda");
  // DIR-3c: el directorio público muestra sede, ciudad y provincia (`/consultorios/<slug>`, filtro por provincia). Sin
  // esto un cambio de sede tardaba hasta 10 min (el `revalidate` del snapshot) en verse. Después del commit (acá ya
  // terminó la tx): adentro, un rollback dejaría el caché invalidado contra datos viejos.
  revalidateTag(tags.directory());
}

/**
 * DIR-3c (DIR-D16): con una provincia elegida, `province` pasa a ser su nombre (lo que leen turnero, agenda y
 * export). Sin código (o sacándolo) `province` NO se toca: el texto libre viejo («Bs As») queda hasta que alguien
 * elija la provincia, en vez de borrarse por guardar otra cosa de la sede.
 */
function withProvinceName<T extends { provinceCode?: string | null; province?: string | null }>(data: T): T {
  const name = data.provinceCode ? provinceName(data.provinceCode) : null;
  return name ? { ...data, province: name } : data;
}

/** Sedes del tenant: principal primero, después `sortOrder` y nombre. */
export async function listLocations(
  opts: { includeArchived?: boolean } = {}
): Promise<LocationRow[]> {
  const { actor } = await requireCapability("agenda.viewAll", READ_MSG);
  // PF2-d: la consulta vive en lib/locations-read.ts (el loader de `/configuracion` la corre en su tx única).
  return runWithRls(actor.tenantId, (tx) => listLocationsInTx(tx, actor.tenantId, opts));
}

/**
 * Alta de sede. Si el tenant no tiene principal (tenant creado entre el
 * deploy de la migración y B2.3, o datos viejos), la nueva nace principal:
 * el motor necesita una (`Booking.locationId` null = principal).
 */
export async function createLocation(...args: Parameters<typeof createLocationImpl>): ReturnType<typeof createLocationImpl> {
  return withReadOnlyResult(() => withSupportWritable("lib/locations.ts#createLocation", () => createLocationImpl(...args)));
}

async function createLocationImpl(raw: LocationInputRaw): Promise<ActionResult<{ id: string }>> {
  const { actor } = await requireCapability("schedule.configure", WRITE_MSG);
  const parsed = LocationInput.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Datos inválidos", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  try {
    const row = await runWithRls(actor.tenantId, async (tx) => {
      await lockTenantLocations(tx, actor.tenantId);
      const hasPrimary = await tx.location.count({
        where: { tenantId: actor.tenantId, isPrimary: true },
      });
      return tx.location.create({
        data: { tenantId: actor.tenantId, ...withProvinceName(parsed.data), isPrimary: hasPrimary === 0 },
        select: { id: true, name: true, isPrimary: true },
      });
    });
    revalidateAll();
    return { ok: true, data: { id: row.id } };
  } catch (e) {
    // EV1-E2 (readonly-residual-actions): modo lectura / soporte → su copy, no el genérico de abajo.
    const ro = readOnlyFailure(e);
    if (ro) return ro;
    logger.error("location.create.failed", { err: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: "No pudimos crear la sede." };
  }
}

/** Edición de datos de la sede (no toca `isPrimary` ni `active`: tienen su action). */
export async function updateLocation(...args: Parameters<typeof updateLocationImpl>): ReturnType<typeof updateLocationImpl> {
  return withReadOnlyResult(() => withSupportWritable("lib/locations.ts#updateLocation", () => updateLocationImpl(...args)));
}

async function updateLocationImpl(
  id: string,
  raw: Partial<LocationInputRaw>
): Promise<ActionResult> {
  const { actor } = await requireCapability("schedule.configure", WRITE_MSG);
  const idOk = LocationId.safeParse(id);
  if (!idOk.success) return { ok: false, error: NOT_FOUND };
  // `.partial()` sobre el objeto con transforms: un campo omitido queda
  // `undefined` (no se toca) y "" queda null (se borra).
  const parsed = LocationInput.partial().safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Datos inválidos", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const data = withProvinceName(
    Object.fromEntries(Object.entries(parsed.data).filter(([k]) => k in raw)) as {
      provinceCode?: string | null;
      province?: string | null;
    }
  ) as Prisma.LocationUpdateInput;
  try {
    const changed = await runWithRls(actor.tenantId, async (tx) => {
      const before = await tx.location.findFirst({
        where: { id: idOk.data, tenantId: actor.tenantId },
        select: { id: true, name: true },
      });
      if (!before) return null;
      // updateMany con tenantId: la barrera explícita también en la escritura.
      await tx.location.updateMany({ where: { id: before.id, tenantId: actor.tenantId }, data });
      return before;
    });
    if (!changed) return { ok: false, error: NOT_FOUND };
    revalidateAll();
    return { ok: true, data: undefined };
  } catch (e) {
    // EV1-E2 (readonly-residual-actions): modo lectura / soporte → su copy, no el genérico de abajo.
    const ro = readOnlyFailure(e);
    if (ro) return ro;
    logger.error("location.update.failed", { err: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: "No pudimos guardar la sede." };
  }
}

/**
 * Marca la sede principal. En una tx con lock exclusivo: primero baja la
 * anterior y después sube la nueva (el índice único parcial
 * `Location_tenantId_primary_key` exige ese orden). La sede tiene que estar
 * activa: la principal no se puede archivar.
 *
 * Efecto a saber: `Booking.locationId` null se lee como "la principal", así
 * que los turnos sin sede pasan a mostrarse en la nueva (el backfill de
 * `agenda_foundations` les puso sede a todos los existentes).
 */
export async function setPrimaryLocation(...args: Parameters<typeof setPrimaryLocationImpl>): ReturnType<typeof setPrimaryLocationImpl> {
  return withReadOnlyResult(() => withSupportWritable("lib/locations.ts#setPrimaryLocation", () => setPrimaryLocationImpl(...args)));
}

async function setPrimaryLocationImpl(id: string): Promise<ActionResult> {
  const { actor } = await requireCapability("schedule.configure", WRITE_MSG);
  const idOk = LocationId.safeParse(id);
  if (!idOk.success) return { ok: false, error: NOT_FOUND };
  try {
    const res = await runWithRls(actor.tenantId, async (tx) => {
      await lockTenantLocations(tx, actor.tenantId);
      const target = await tx.location.findFirst({
        where: { id: idOk.data, tenantId: actor.tenantId },
        select: { id: true, active: true, isPrimary: true },
      });
      if (!target) return { error: NOT_FOUND };
      if (!target.active) return { error: "No se puede marcar como principal una sede archivada." };
      if (target.isPrimary) return { previous: target.id };
      const prev = await tx.location.findFirst({
        where: { tenantId: actor.tenantId, isPrimary: true },
        select: { id: true },
      });
      await tx.location.updateMany({
        where: { tenantId: actor.tenantId, isPrimary: true },
        data: { isPrimary: false },
      });
      await tx.location.updateMany({
        where: { id: target.id, tenantId: actor.tenantId },
        data: { isPrimary: true },
      });
      return { previous: prev?.id ?? null };
    });
    if ("error" in res) return { ok: false, error: res.error as string };
    revalidateAll();
    return { ok: true, data: undefined };
  } catch (e) {
    // EV1-E2 (readonly-residual-actions): modo lectura / soporte → su copy, no el genérico de abajo.
    const ro = readOnlyFailure(e);
    if (ro) return ro;
    // P2002 = el índice parcial único frenó una carrera que el lock no cubrió
    // (no debería pasar: está para fallar cerrado, no para pisar).
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, error: "Otro cambio de sede principal se cruzó con este. Probá de nuevo." };
    }
    logger.error("location.setPrimary.failed", { err: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: "No pudimos cambiar la sede principal." };
  }
}

/**
 * Archiva (desactiva) una sede. Se niega, devolviendo conteos para que la UI
 * diga qué falta mover, si: es la principal, tiene franjas vigentes, turnos
 * futuros no cancelados, excepciones de horario futuras que la usan o planes
 * ACTIVE vivos con esa sede (S13g).
 * Conteos y archivado en la misma tx con lock exclusivo (ver cabecera).
 */
export async function archiveLocation(...args: Parameters<typeof archiveLocationImpl>): ReturnType<typeof archiveLocationImpl> {
  return withReadOnlyResult(() => withSupportWritable("lib/locations.ts#archiveLocation", () => archiveLocationImpl(...args)));
}

async function archiveLocationImpl(id: string): Promise<ArchiveLocationResult> {
  const { actor } = await requireCapability("schedule.configure", WRITE_MSG);
  const idOk = LocationId.safeParse(id);
  if (!idOk.success) return { ok: false, error: NOT_FOUND };
  const now = new Date();
  const today = dayKeyToDbDate(toARDateKey(now));
  try {
    const res = await runWithRls(actor.tenantId, async (tx) => {
      await lockTenantLocations(tx, actor.tenantId);
      const loc = await tx.location.findFirst({
        where: { id: idOk.data, tenantId: actor.tenantId },
        select: { id: true, name: true, isPrimary: true, active: true },
      });
      if (!loc) return { kind: "notFound" as const };
      if (!loc.active) return { kind: "done" as const, name: loc.name, already: true };
      if (loc.isPrimary) return { kind: "primary" as const };
      const [activeSchedules, futureBookings, futureExceptions, activePlans] = await Promise.all([
        tx.practitionerSchedule.count({
          where: {
            tenantId: actor.tenantId,
            locationId: loc.id,
            OR: [{ validUntil: null }, { validUntil: { gte: today } }],
          },
        }),
        tx.booking.count({
          where: {
            tenantId: actor.tenantId,
            locationId: loc.id,
            scheduledFor: { gte: now },
            status: { not: "CANCELLED" },
          },
        }),
        tx.scheduleException.count({
          where: {
            tenantId: actor.tenantId,
            kind: "CUSTOM_HOURS",
            date: { gte: today },
            ranges: { array_contains: [{ locationId: loc.id }] },
          },
        }),
        // S13g (I7): `TreatmentProgram.locationId` es RESTRICT desde M1, pero
        // archivar no borra la sede, así que la FK no frena nada. Sin esta
        // guarda un plan ACTIVE quedaba atado a una sede donde el motor ya no
        // ofrece slots (sus sesiones "sin turno" no se podrían agendar). Solo
        // ACTIVE y vivos (`liveProgramWhere`): cerrados y archivados son historia.
        tx.treatmentProgram.count({
          where: { tenantId: actor.tenantId, locationId: loc.id, ...liveProgramWhere, status: "ACTIVE" },
        }),
      ]);
      const blockers: LocationArchiveBlockers = { activeSchedules, futureBookings, futureExceptions };
      if (activeSchedules + futureBookings + futureExceptions + activePlans > 0) {
        return { kind: "blocked" as const, blockers, activePlans };
      }
      await tx.location.updateMany({
        where: { id: loc.id, tenantId: actor.tenantId },
        data: { active: false },
      });
      return { kind: "done" as const, name: loc.name, already: false };
    });
    switch (res.kind) {
      case "notFound":
        return { ok: false, error: NOT_FOUND };
      case "primary":
        return {
          ok: false,
          error: "No se puede archivar la sede principal. Marcá otra como principal primero.",
        };
      case "blocked": {
        const b = res.blockers;
        const parts = [
          b.activeSchedules ? `${b.activeSchedules} franja${b.activeSchedules === 1 ? "" : "s"} de horario` : null,
          b.futureBookings ? `${b.futureBookings} turno${b.futureBookings === 1 ? "" : "s"} a futuro` : null,
          b.futureExceptions
            ? `${b.futureExceptions} día${b.futureExceptions === 1 ? "" : "s"} con horario especial`
            : null,
          res.activePlans
            ? `${res.activePlans} plan${res.activePlans === 1 ? "" : "es"} activo${res.activePlans === 1 ? "" : "s"}`
            : null,
        ].filter(Boolean);
        // `activePlans` va en el mensaje y no en `blockers`: el tipo vive en
        // `locations-schemas.ts` (otra sesión); el handoff de S13g lo suma.
        const others = b.activeSchedules + b.futureBookings + b.futureExceptions > 0;
        const action = !res.activePlans
          ? "Movelos a otra sede primero."
          : others
            ? "Movelos a otra sede y cambiá la sede de esos planes (o cerralos) primero."
            : "Cambiá la sede de esos planes (o cerralos) primero.";
        return {
          ok: false,
          error: `No se puede archivar: la sede todavía tiene ${parts.join(", ")}. ${action}`,
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
    logger.error("location.archive.failed", { err: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: "No pudimos archivar la sede." };
  }
}

/** Reactiva una sede archivada (sin esto, archivar por error no tiene vuelta). */
export async function restoreLocation(...args: Parameters<typeof restoreLocationImpl>): ReturnType<typeof restoreLocationImpl> {
  return withReadOnlyResult(() => withSupportWritable("lib/locations.ts#restoreLocation", () => restoreLocationImpl(...args)));
}

async function restoreLocationImpl(id: string): Promise<ActionResult> {
  const { actor } = await requireCapability("schedule.configure", WRITE_MSG);
  const idOk = LocationId.safeParse(id);
  if (!idOk.success) return { ok: false, error: NOT_FOUND };
  const n = await runWithRls(actor.tenantId, async (tx) => {
    await lockTenantLocations(tx, actor.tenantId);
    const r = await tx.location.updateMany({
      where: { id: idOk.data, tenantId: actor.tenantId, active: false },
      data: { active: true },
    });
    return r.count;
  });
  if (n === 0) {
    // Inexistente / de otro tenant / ya activa: no se distingue hacia afuera.
    const exists = await runWithRls(actor.tenantId, (tx) =>
      tx.location.count({ where: { id: idOk.data, tenantId: actor.tenantId } })
    );
    return exists ? { ok: true, data: undefined } : { ok: false, error: NOT_FOUND };
  }
  revalidateAll();
  return { ok: true, data: undefined };
}
