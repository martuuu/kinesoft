"use server";

/**
 * Disponibilidad para el staff (B3.3 AV-actions, B-pre): lo que consumen la
 * agenda multi-profesional (B4.x) y el modal de turnos (B5.x). Solo LECTURA:
 * acá no se escribe nada; las altas validan de nuevo en `lib/bookings.ts`.
 *
 *   getAgendaAvailability  franjas, candado y bloqueos por profesional × día
 *   listAvailableSlots     slots de un día (un profesional o "any")
 *   classifyBookingInstant aviso en vivo del modal antes de enviar
 *   previewRecurrence      fechas + resumen + clase por fecha (modo Sesiones)
 *
 * Patrón de cada action: `requireCapability("agenda.viewAll")` (ForbiddenError
 * si falta; la tienen OWNER/ADMIN/PRACTITIONER/ASSISTANT/BILLING, sin
 * membresía no hay actor) → zod → `runWithRls(tenantId, tx => …)` donde PRIMERO
 * se validan contra el tenant los ids de entrada (profesional, servicio, sede,
 * paciente, cobertura) y DESPUÉS se carga TODO con una sola llamada a
 * `loadAvailabilityInputs(tx, …)` (que también lleva `where: { tenantId }` a
 * mano: en prod la conexión tiene BYPASSRLS). Un id ajeno da error explícito,
 * no una respuesta vacía que parezca "sin disponibilidad" (IDOR visible en
 * los tests).
 *
 * Sin PHI en las respuestas (ver `lib/availability-actions-types.ts`): BILLING
 * ve esto y no tiene `clinical.read`.
 *
 * Sin cache (`unstable_cache`) a propósito: la disponibilidad cambia con cada
 * turno, y un slot "libre" viejo en el modal es un sobreturno sorpresa. Por
 * eso tampoco hay un tag `availability` en `lib/cache-tags.ts` (no habría
 * nada que invalidar). La página de agenda es `force-dynamic`.
 *
 * Reloj: `now = new Date()` acá (instante real); todo cálculo de día/hora va
 * por el motor (`lib/availability/*` sobre `lib/datetime-ar.ts`).
 */
import { requireCapability } from "@/lib/authz";
import { runWithRls, type DbClient } from "@/lib/rls";
import type { ActionResult } from "@/lib/validation";
import { loadAvailabilityInputs, type LoadedAvailabilityInput } from "@/lib/availability-loader";
import {
  NEXT_FREE_HORIZON_DAYS,
  addDays,
  buildSlots,
  classifyBatchInstant,
  classifyInstant,
  dayKeyDiff,
  dayKeyOf,
  dayKeyRange,
  dayLockState,
  dayWindow,
  defaultRoomFor,
  eligiblePractitioners,
  acceptsInsurer,
  expandDates,
  firstFreeAcrossPractitioners,
  resolvePractitionerService,
  roomAssignmentsFor,
  roomOccupancyAt,
  scheduledRanges,
  summarizeRange,
  workingRanges,
  type AvailabilityBooking,
  type ClassifyInstantInput,
  type DayKey,
  type ResolvedPractitionerService,
  type SlotResult,
} from "@/lib/availability";
import { formatWallTime, minutesOfDayAR } from "@/lib/availability/day";
import { defaultLocationFor } from "@/lib/bookings-core";
import { loadRoomBookingsInTx, lockActiveRoomInTx } from "@/lib/booking-rooms-internal";
import { BAD_ROOM_ERROR } from "@/lib/bookings-constants";
import {
  AgendaAvailabilityQuery,
  ClassifyInstantQuery,
  ListSlotsQuery,
  RecurrencePreviewQuery,
  STAFF_SLOT_STEP_MIN,
  type AgendaAvailability,
  type AgendaAvailabilityQueryInput,
  type AgendaBlockView,
  type AgendaRoomBlockView,
  type AnyPractitionerSlot,
  type ClassifyInstantQueryInput,
  type InstantCheck,
  type ListSlotsQueryInput,
  type ListSlotsResult,
  type PractitionerDayAvailability,
  type RecurrencePreview,
  type RecurrencePreviewItem,
  type RecurrencePreviewQueryInput,
  type StaffSlot,
} from "@/lib/availability-actions-types";

const VIEW_MSG = "No tenés permiso para ver la agenda del equipo.";
const MIN_MS = 60_000;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers internos (no exportados: el archivo es "use server")
// ─────────────────────────────────────────────────────────────────────────────

type IdsToCheck = {
  practitionerIds?: ReadonlyArray<string>;
  serviceId?: string;
  locationId?: string | null;
  patientId?: string | null;
  insurerId?: string | null;
};

/**
 * Valida contra el tenant los ids de entrada (las FK y el loader filtran en
 * silencio; acá se rechaza con un mensaje). Devuelve el error o null.
 * Profesional: cualquiera del tenant (uno dado de baja puede tener turnos
 * futuros que la agenda tiene que ubicar). Sede: activa. Paciente: no
 * archivado no se exige (solo marca ocupación).
 */
async function checkTenantIds(tx: DbClient, tenantId: string, ids: IdsToCheck): Promise<string | null> {
  const pracIds = ids.practitionerIds ? Array.from(new Set(ids.practitionerIds)) : [];
  const [pracs, svc, loc, pat, ins] = await Promise.all([
    pracIds.length
      ? tx.practitioner.findMany({ where: { tenantId, id: { in: pracIds } }, select: { id: true } })
      : Promise.resolve([] as { id: string }[]),
    ids.serviceId
      ? tx.service.findFirst({ where: { tenantId, id: ids.serviceId }, select: { id: true } })
      : Promise.resolve(null),
    ids.locationId
      ? tx.location.findFirst({ where: { tenantId, id: ids.locationId, active: true }, select: { id: true } })
      : Promise.resolve(null),
    ids.patientId
      ? tx.patient.findFirst({ where: { tenantId, id: ids.patientId }, select: { id: true } })
      : Promise.resolve(null),
    ids.insurerId
      ? tx.insurer.findFirst({ where: { tenantId, id: ids.insurerId }, select: { id: true } })
      : Promise.resolve(null),
  ]);
  if (pracs.length !== pracIds.length) return "Profesional inválido.";
  if (ids.serviceId && !svc) return "Servicio inválido.";
  if (ids.locationId && !loc) return "Sede inválida.";
  if (ids.patientId && !pat) return "Paciente inválido.";
  if (ids.insurerId && !ins) return "Obra social inválida.";
  return null;
}

function invalid(error: { flatten: () => { fieldErrors: Record<string, string[] | undefined> } }) {
  const fe = error.flatten().fieldErrors;
  const fieldErrors: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(fe)) if (v?.length) fieldErrors[k] = v;
  return { ok: false as const, error: "Datos inválidos", fieldErrors };
}

/** Regla efectiva (duración, cupo, habilitado) de profesional + servicio. */
function ruleFor(input: LoadedAvailabilityInput, practitionerId: string, serviceId: string): ResolvedPractitionerService | null {
  const service = input.services.find((s) => s.id === serviceId);
  if (!service) return null;
  const rule = input.practitionerServices.find((r) => r.practitionerId === practitionerId && r.serviceId === serviceId);
  return resolvePractitionerService(rule, service, practitionerId);
}

function blockReasonsOf(input: LoadedAvailabilityInput, ids: ReadonlyArray<string>): string[] {
  const reasons = ids
    .map((id) => input.blocks.find((b) => b.id === id)?.reason?.trim())
    .filter((r): r is string => !!r);
  return Array.from(new Set(reasons));
}

/** Estado del paciente en [when, when+dur): duplicado / superpuesto / libre. */
function patientConflictAt(
  bookings: ReadonlyArray<AvailabilityBooking>,
  patientId: string | null | undefined,
  whenMs: number,
  durationMin: number
): StaffSlot["patientConflict"] {
  if (!patientId) return null;
  const end = whenMs + durationMin * MIN_MS;
  let overlap = false;
  for (const b of bookings) {
    if (b.patientId !== patientId) continue;
    const s = b.scheduledFor.getTime();
    if (s === whenMs) return "duplicado";
    if (s < end && s + b.durationMin * MIN_MS > whenMs) overlap = true;
  }
  return overlap ? "paciente-superpuesto" : null;
}

function staffSlots(
  input: LoadedAvailabilityInput,
  q: {
    practitionerId: string;
    serviceId: string;
    dayKey: DayKey;
    locationId: string | null;
    patientId: string | null;
    durationMin: number;
    cap: number | null;
    stepMin: number;
    now: Date;
  }
): StaffSlot[] {
  const opts = { locationId: q.locationId };
  const slots: SlotResult[] = buildSlots({
    dayKey: q.dayKey,
    ranges: workingRanges(q.practitionerId, q.dayKey, input, opts),
    stepMin: q.stepMin,
    durationMin: q.durationMin,
    // Staff: sin anticipación mínima ni horizonte (`minLeadMinutes`/`maxLeadDays`
    // de PractitionerService son del canal público). "pasado" sigue valiendo.
    lead: { minMinutes: 0, maxDays: null },
    now: q.now,
    bookings: input.bookings.filter((b) => b.practitionerId === q.practitionerId && b.serviceId === q.serviceId),
    cap: q.cap,
  });
  return slots.map((s) => ({
    ...s,
    patientConflict: patientConflictAt(input.bookings, q.patientId, Date.parse(s.iso), q.durationMin),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Agenda: franjas, candado y bloqueos por profesional × día
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Disponibilidad de la ventana [from, to] (≤ 14 días AR) para la agenda.
 * Sin `practitionerIds` = todos los profesionales con membresía aceptada.
 * Con `locationId`, franjas y bloqueos de esa sede (los turnos no se filtran:
 * eso es `listBookingsInRange`). No devuelve turnos.
 */
export async function getAgendaAvailability(
  raw: AgendaAvailabilityQueryInput
): Promise<ActionResult<AgendaAvailability>> {
  const { actor } = await requireCapability("agenda.viewAll", VIEW_MSG);
  const parsed = AgendaAvailabilityQuery.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);
  const { from, to, practitionerIds } = parsed.data;
  const locationId = parsed.data.locationId ?? null;
  const tenantId = actor.tenantId;

  const loaded = await runWithRls(tenantId, async (tx) => {
    const err = await checkTenantIds(tx, tenantId, { practitionerIds, locationId });
    if (err) return { err, input: null } as const;
    const input = await loadAvailabilityInputs(tx, {
      tenantId,
      practitionerIds,
      locationId: locationId ?? undefined,
      from,
      to,
    });
    return { err: null, input } as const;
  });
  if (loaded.err !== null) return { ok: false, error: loaded.err };
  const { input } = loaded;

  const opts = { locationId };
  const pracIds = input.templates.map((t) => t.practitionerId);
  const days = dayKeyRange(from, to).map((dayKey) => {
    const byPractitioner: Record<string, PractitionerDayAvailability> = {};
    for (const pid of pracIds) {
      const lock = dayLockState(pid, dayKey, input, opts);
      byPractitioner[pid] = {
        scheduledRanges: scheduledRanges(pid, dayKey, input, opts),
        workingRanges: workingRanges(pid, dayKey, input, opts),
        dayLockState: { ...lock, blockIds: [...lock.blockIds] },
      };
    }
    const clinic = dayLockState(null, dayKey, input, opts);
    // SR, vista "Por sala": quién tiene cada sala ese día (franjas CRUDAS con
    // sala, SR1a). Sale del mismo `input` (0 sentencias); ausente = nadie con
    // sala, así un consultorio sin salas recibe la misma forma que antes.
    const roomAssignments = roomAssignmentsFor(input, dayKey, pracIds);
    return {
      dayKey,
      clinic: { ...clinic, blockIds: [...clinic.blockIds] },
      byPractitioner,
      ...(Object.keys(roomAssignments).length ? { roomAssignments } : {}),
    };
  });

  const capOf: AgendaAvailability["capOf"] = {};
  const enabledServiceIds: AgendaAvailability["enabledServiceIds"] = {};
  for (const pid of pracIds) {
    capOf[pid] = {};
    enabledServiceIds[pid] = [];
    for (const s of input.services) {
      const eff = ruleFor(input, pid, s.id)!;
      capOf[pid][s.id] = eff.cap;
      if (eff.enabled) enabledServiceIds[pid].push(s.id);
    }
  }

  const blocks: AgendaBlockView[] = input.blocks.map((b) => ({
    id: b.id,
    practitionerId: b.practitionerId,
    locationId: b.locationId,
    startsAt: b.startsAt.toISOString(),
    endsAt: b.endsAt.toISOString(),
    allDay: b.allDay,
    reason: b.reason,
    groupId: b.groupId,
  }));
  // SR (§17.5): bloqueos de SALA, aparte de `blocks` (no bloquean
  // profesionales). Se eligió `input.roomBlocks` del loader (SR1a, ya separados
  // de `blocks` y filtrados por sede) en vez de los helpers de SR-B
  // (`roomBlocksWhere` + `ROOM_BLOCK_SELECT`): esos son otra query, y esto sale
  // de la MISMA sentencia de TimeBlock que ya corría. Ausente = ninguno.
  const roomBlocks: AgendaRoomBlockView[] = input.roomBlocks.map((b) => ({
    id: b.id,
    roomId: b.roomId,
    startsAt: b.startsAt.toISOString(),
    endsAt: b.endsAt.toISOString(),
    reason: b.reason,
  }));

  return {
    ok: true,
    data: {
      ...(roomBlocks.length ? { roomBlocks } : {}),
      from,
      to,
      locationId,
      primaryLocationId: input.primaryLocationId,
      tenantHours: { ...input.tenantHours },
      practitioners: input.templates.map((t) => ({ practitionerId: t.practitionerId, isFallback: t.isFallback })),
      days,
      blocks,
      capOf,
      enabledServiceIds,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Slots del día (modal)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Slots de UN día AR para un profesional, o con `practitionerId: "any"` el
 * primer hueco del día por cada profesional elegible (servicio habilitado y,
 * con `insurerId`, cobertura aceptada) + el hueco más temprano entre todos
 * (`firstFreeAcrossPractitioners`, que puede caer otro día si este está lleno).
 *
 * Paso: `stepMin` o `STAFF_SLOT_STEP_MIN` (15; ver la decisión en el archivo
 * de tipos). Sin anticipación mínima (es el staff). Profesional puntual con el
 * servicio deshabilitado o sin la cobertura: igual devuelve slots (la grilla
 * informa la ocupación), con `serviceEnabled`/`acceptsInsurer` en false para
 * que la UI avise. Ojo: con el servicio deshabilitado el alta se RECHAZA
 * (`createBooking`/batch, "servicio no habilitado"); la UI manda a habilitarlo
 * en Configuración → Profesionales. La cobertura no aceptada solo avisa. El
 * turnero y "any" no ofrecen ninguno de los dos casos.
 */
export async function listAvailableSlots(raw: ListSlotsQueryInput): Promise<ActionResult<ListSlotsResult>> {
  const { actor } = await requireCapability("agenda.viewAll", VIEW_MSG);
  const parsed = ListSlotsQuery.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);
  const q = parsed.data;
  const tenantId = actor.tenantId;
  const locationId = q.locationId ?? null;
  const patientId = q.patientId ?? null;
  const insurerId = q.insurerId ?? null;
  const stepMin = q.stepMin ?? STAFF_SLOT_STEP_MIN;
  const now = new Date();
  const isAny = q.practitionerId === "any";

  // "any" necesita el horizonte de `nextFreeSlot` (14 días desde el cursor):
  // se carga un día más para no tratar como libre lo que no se cargó.
  const to = isAny ? addDays(q.dayKey, NEXT_FREE_HORIZON_DAYS + 1) : q.dayKey;

  const loaded = await runWithRls(tenantId, async (tx) => {
    const err = await checkTenantIds(tx, tenantId, {
      practitionerIds: isAny ? undefined : [q.practitionerId],
      serviceId: q.serviceId,
      locationId,
      patientId,
      insurerId,
    });
    if (err) return { err, input: null } as const;
    const input = await loadAvailabilityInputs(tx, {
      tenantId,
      practitionerIds: isAny ? undefined : [q.practitionerId],
      serviceId: q.serviceId,
      locationId: locationId ?? undefined,
      patientId: patientId ?? undefined,
      from: q.dayKey,
      to,
    });
    return { err: null, input } as const;
  });
  if (loaded.err !== null) return { ok: false, error: loaded.err };
  const { input } = loaded;

  if (!isAny) {
    const pid = q.practitionerId;
    const eff = ruleFor(input, pid, q.serviceId)!;
    const durationMin = q.durationMin ?? eff.durationMin;
    const lock = dayLockState(pid, q.dayKey, input, { locationId });
    return {
      ok: true,
      data: {
        mode: "practitioner",
        dayKey: q.dayKey,
        practitionerId: pid,
        serviceId: q.serviceId,
        durationMin,
        cap: eff.cap,
        stepMin,
        serviceEnabled: eff.enabled,
        acceptsInsurer: insurerId ? acceptsInsurer(input.practitionerPayers, pid, insurerId) : true,
        isFallbackSchedule: input.templates.find((t) => t.practitionerId === pid)?.isFallback ?? true,
        dayLockState: { ...lock, blockIds: [...lock.blockIds] },
        slots: staffSlots(input, {
          practitionerId: pid,
          serviceId: q.serviceId,
          dayKey: q.dayKey,
          locationId,
          patientId,
          durationMin,
          cap: eff.cap,
          stepMin,
          now,
        }),
      },
    };
  }

  const eligible = eligiblePractitioners({
    practitionerIds: input.templates.map((t) => t.practitionerId),
    serviceId: q.serviceId,
    insurerId,
    practitionerServices: input.practitionerServices,
    practitionerPayers: input.practitionerPayers,
    services: input.services,
  });
  const practitioners: AnyPractitionerSlot[] = eligible.map((pid) => {
    const eff = ruleFor(input, pid, q.serviceId)!;
    const durationMin = q.durationMin ?? eff.durationMin;
    const slots = staffSlots(input, {
      practitionerId: pid,
      serviceId: q.serviceId,
      dayKey: q.dayKey,
      locationId,
      patientId,
      durationMin,
      cap: eff.cap,
      stepMin,
      now,
    });
    const usable = slots.filter((s) => s.available && !s.patientConflict);
    return { practitionerId: pid, durationMin, cap: eff.cap, firstSlot: usable[0] ?? null, availableCount: usable.length };
  });

  // Cursor de `nextFreeSlot` = from + 15 → arrancar 15' antes del inicio del
  // día da exactamente las 00:00 AR; si el día ya empezó, desde ahora.
  const dayStart = dayWindow(q.dayKey).start.getTime();
  const from = new Date(Math.max(now.getTime(), dayStart - 15 * MIN_MS));
  const firstFree = firstFreeAcrossPractitioners({
    practitionerIds: eligible,
    serviceId: q.serviceId,
    insurerId,
    from,
    durationMin: q.durationMin,
    patientId,
    locationId,
    services: input.services,
    practitionerServices: input.practitionerServices,
    practitionerPayers: input.practitionerPayers,
    // `classify`/`nextFreeSlot` esperan franjas SIN restar bloqueos (handoff B2.1b).
    rangesFor: (pid, dayKey) => scheduledRanges(pid, dayKey, input, { locationId }),
    blocks: input.blocks,
    bookings: input.bookings,
    now,
  });

  return {
    ok: true,
    data: {
      mode: "any",
      dayKey: q.dayKey,
      serviceId: q.serviceId,
      stepMin,
      practitioners,
      firstFree,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Clase de un instante (aviso en vivo del modal)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "Libre / sobreturno / fuera de horario / bloqueado / paciente ocupado /
 * duplicado" para el turno que el staff está armando, antes de enviar. Es un
 * aviso: la decisión final la toma `createBooking`/`updateBooking` (B3.1) con
 * sus propios `allowOutOfHours`/`allowBlocked`, dentro de su transacción.
 */
export async function classifyBookingInstant(raw: ClassifyInstantQueryInput): Promise<ActionResult<InstantCheck>> {
  const { actor } = await requireCapability("agenda.viewAll", VIEW_MSG);
  const parsed = ClassifyInstantQuery.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);
  const q = parsed.data;
  const tenantId = actor.tenantId;
  const locationId = q.locationId ?? null;
  const patientId = q.patientId ?? null;
  const when = new Date(q.scheduledFor);

  const now = new Date();

  const loaded = await runWithRls(tenantId, async (tx) => {
    const err = await checkTenantIds(tx, tenantId, {
      practitionerIds: [q.practitionerId],
      serviceId: q.serviceId,
      locationId,
      patientId,
    });
    if (err) return { err, input: null } as const;
    // Día del inicio y, si el turno cruza la medianoche AR, el siguiente
    // (duración ≤ 480: a lo sumo un día más).
    const fromKey = dayKeyOf(when);
    const toKey = dayKeyOf(new Date(when.getTime() + (q.durationMin ?? 480) * MIN_MS));
    const input = await loadAvailabilityInputs(tx, {
      tenantId,
      practitionerIds: [q.practitionerId],
      serviceId: q.serviceId,
      locationId: locationId ?? undefined,
      patientId: patientId ?? undefined,
      from: fromKey,
      to: toKey,
    });
    const eff = ruleFor(input, q.practitionerId, q.serviceId)!;
    const durationMin = q.durationMin ?? eff.durationMin;

    // ── SR: sala ───────────────────────────────────────────────────────────
    // Misma resolución que `createBooking`: sede = la elegida o la de la franja
    // (null = principal); sala por defecto = `defaultRoomFor` en esa sede.
    // `q.roomId` ausente = la por defecto; null/"" = "Sin sala" (no se chequea);
    // un id = esa sala, que tiene que ser de la sede final (si no, el alta daría
    // BAD_ROOM_ERROR: se avisa igual acá).
    const loc = locationId ?? defaultLocationFor(input, q.practitionerId, when, durationMin);
    const roomLoc = loc ?? input.primaryLocationId;
    let defaultRoomId = defaultRoomFor(input, q.practitionerId, when, durationMin, loc);
    const target = q.roomId === undefined ? defaultRoomId : q.roomId;
    // El loader trae solo los turnos de ESTE profesional: la sala la ocupan
    // otros, así que la ocupación sale de una carga propia de la sala
    // (`loadRoomBookingsInTx`, una sentencia con turnos + bloqueos de sala) y
    // del MISMO predicado que el write-path (`roomOccupancyAt`). Solo si hay
    // sala: sin sala, 0 sentencias nuevas. Con sala, +2 (sala + ocupación).
    let roomBusy: InstantCheck["roomBusy"] = null;
    if (target) {
      const room = roomLoc ? await lockActiveRoomInTx(tx, { tenantId, roomId: target, locationId: roomLoc }) : null;
      if (!room) {
        if (q.roomId !== undefined) return { err: BAD_ROOM_ERROR, input: null } as const;
        // La por defecto archivada: el alta la deja sin sala.
        defaultRoomId = null;
      } else {
        const end = new Date(when.getTime() + durationMin * MIN_MS);
        const occ = await loadRoomBookingsInTx(tx, { tenantId, roomId: room.id, from: when, to: end });
        const o = roomOccupancyAt(
          occ.bookings,
          {
            roomId: room.id,
            practitionerId: q.practitionerId,
            when,
            durationMin,
            capacity: room.capacity,
            now,
            excludeBookingId: q.excludeBookingId ?? null,
          },
          occ.blocks
        );
        if (o.atCapacity) {
          roomBusy = { roomName: room.name, blocked: o.blocked ? { reason: o.blocked.reason } : null };
        }
      }
    }
    return { err: null, input, eff, durationMin, defaultRoomId, roomBusy } as const;
  });
  if (loaded.err !== null) return { ok: false, error: loaded.err };
  const { input, eff, durationMin } = loaded;

  const c = classifyInstant({
    when,
    durationMin,
    patientId,
    practitionerId: q.practitionerId,
    serviceId: q.serviceId,
    locationId,
    cap: eff.cap,
    rangesFor: (pid, dayKey) => scheduledRanges(pid, dayKey, input, { locationId }),
    blocks: input.blocks,
    bookings: input.bookings,
    now,
    excludeBookingId: q.excludeBookingId ?? null,
  });
  return {
    ok: true,
    data: {
      class: c.class,
      outOfHours: c.outOfHours,
      blocked: c.blocked,
      blockIds: [...c.blockIds],
      blockReasons: blockReasonsOf(input, c.blockIds),
      used: c.used,
      cap: c.cap,
      durationMin,
      serviceEnabled: eff.enabled,
      defaultRoomId: loaded.defaultRoomId,
      roomBusy: loaded.roomBusy,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Vista previa de una serie (modo Sesiones del modal, B5.3)
// ─────────────────────────────────────────────────────────────────────────────

/** Ventanas de carga de una serie: fechas a ≤ 62 días de la primera de su
 *  grupo van juntas. Mensual × 60 son 5 años: una sola carga traería todos
 *  los turnos del profesional de ese lapso; así son ~30 cargas chicas. */
const PREVIEW_CHUNK_DAYS = 62;

/**
 * Fechas de la serie (`expandDates`, misma regla que el multi-turno), su
 * resumen ("8 sesiones · Semanal 02/03 → 20/04") y, por fecha, el status que
 * daría el batch (`classifyBatchInstant`) más la clase completa y los flags
 * fuera-de-horario/bloqueado. No crea nada.
 */
export async function previewRecurrence(raw: RecurrencePreviewQueryInput): Promise<ActionResult<RecurrencePreview>> {
  const { actor } = await requireCapability("agenda.viewAll", VIEW_MSG);
  const parsed = RecurrencePreviewQuery.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);
  const q = parsed.data;
  const tenantId = actor.tenantId;
  const locationId = q.locationId ?? null;
  const patientId = q.patientId ?? null;
  const anchor = new Date(q.anchor);

  const dates = expandDates({ anchor, count: q.count, daysOfWeek: q.daysOfWeek, frequency: q.frequency });
  // count ≥ 1 siempre da al menos el ancla (o el primer día pedido de su semana).
  if (dates.length === 0) return { ok: false, error: "La serie no tiene fechas." };

  // Agrupa por ventana de carga (fechas ordenadas por construcción).
  const chunks: Date[][] = [];
  for (const d of dates) {
    const last = chunks[chunks.length - 1];
    if (last && dayKeyDiff(dayKeyOf(last[0]), dayKeyOf(d)) <= PREVIEW_CHUNK_DAYS) last.push(d);
    else chunks.push([d]);
  }

  const loaded = await runWithRls(tenantId, async (tx) => {
    const err = await checkTenantIds(tx, tenantId, {
      practitionerIds: [q.practitionerId],
      serviceId: q.serviceId,
      locationId,
      patientId,
    });
    if (err) return { err, inputs: null } as const;
    const inputs: { dates: Date[]; input: LoadedAvailabilityInput }[] = [];
    // Secuencial: es un solo `tx` (Prisma encola igual).
    for (const group of chunks) {
      const lastEnd = new Date(group[group.length - 1].getTime() + (q.durationMin ?? 480) * MIN_MS);
      const input = await loadAvailabilityInputs(tx, {
        tenantId,
        practitionerIds: [q.practitionerId],
        serviceId: q.serviceId,
        locationId: locationId ?? undefined,
        patientId: patientId ?? undefined,
        from: dayKeyOf(group[0]),
        to: dayKeyOf(lastEnd),
      });
      inputs.push({ dates: group, input });
    }
    return { err: null, inputs } as const;
  });
  if (loaded.err !== null) return { ok: false, error: loaded.err };

  // Servicios y reglas no dependen de la ventana: alcanza la primera carga.
  const eff = ruleFor(loaded.inputs[0].input, q.practitionerId, q.serviceId)!;
  const durationMin = q.durationMin ?? eff.durationMin;
  const now = new Date();

  const items: RecurrencePreviewItem[] = [];
  for (const { dates: group, input } of loaded.inputs) {
    const base: Omit<ClassifyInstantInput, "when"> = {
      durationMin,
      patientId,
      practitionerId: q.practitionerId,
      serviceId: q.serviceId,
      locationId,
      cap: eff.cap,
      rangesFor: (pid, dayKey) => scheduledRanges(pid, dayKey, input, { locationId }),
      blocks: input.blocks,
      bookings: input.bookings,
      now,
    };
    for (const when of group) {
      const batch = classifyBatchInstant({ ...base, when });
      const full = classifyInstant({ ...base, when });
      items.push({
        iso: when.toISOString(),
        dayKey: dayKeyOf(when),
        time: formatWallTime(Math.floor(minutesOfDayAR(when))),
        status: batch.status,
        class: full.class,
        outOfHours: batch.outOfHours,
        blocked: batch.blocked,
        blockReasons: blockReasonsOf(input, batch.blockIds),
        used: batch.used,
        cap: batch.cap,
      });
    }
  }

  const counts: RecurrencePreview["counts"] = { libre: 0, sobreturno: 0, duplicado: 0, outOfHours: 0, blocked: 0 };
  for (const it of items) {
    counts[it.status]++;
    if (it.outOfHours) counts.outOfHours++;
    if (it.blocked) counts.blocked++;
  }

  return {
    ok: true,
    data: {
      frequency: q.frequency,
      summary: summarizeRange(dates, q.frequency),
      durationMin,
      requested: q.count,
      items,
      counts,
    },
  };
}
