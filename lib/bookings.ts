"use server";

/**
 * Booking domain — server-only queries + Server Actions used by the
 * Agenda calendar.
 *
 * `listBookingsInRange` is the workhorse for week/day views — returns
 * everything between [from, to) for the active tenant with patient info
 * joined. Mutations are intentionally narrow: create, reschedule, change
 * status (confirm / cancel / mark no-show / complete).
 */
import { revalidatePath, revalidateTag, unstable_cache } from "next/cache";
import { Prisma, type BookingStatus } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { runWithRls } from "@/lib/rls";
import { getActor } from "@/lib/session";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { notify } from "@/lib/notifications-internal";
import { getParticularCopagoCents, resolveBookingCopagoCents } from "@/lib/billing-internal";
import { isHoldingCapacity, isPublicReservation, overlapBlocks, patientDayStatus } from "@/lib/booking-capacity";
import { toARDateKey } from "@/lib/datetime-ar";
import type { BatchSlotStatus } from "@/lib/booking-schedule";
import {
  addDays,
  arWallOf,
  classifyBatchInstant,
  classifyInstant,
  dayKeyOf,
  dayWindow,
  expandDates,
  fitsInRanges,
  nextFreeSlot,
  resolvePractitionerService,
  scheduledRanges,
  NEXT_FREE_HORIZON_DAYS,
  NO_LOCATION_ID,
  type AvailabilityInput,
  type InstantClassification,
  type RangesFor,
  type ResolvedPractitionerService,
} from "@/lib/availability";
import { loadAvailabilityInputs } from "@/lib/availability-loader";
import { lockTenantLocationsShared } from "@/lib/location-lock";
import { lockCapacityWindow } from "@/lib/booking-cap-lock";
import { bulkPatientAccess, patientAccessFor } from "@/lib/visibility";
import { ForbiddenError, type Actor } from "@/lib/session";
import { getMembershipRole, requireCapability } from "@/lib/authz";
import {
  canOperateBooking,
  canWriteClinical,
  capabilitiesFor,
  type Capability,
  type PatientAccessLevel,
} from "@/lib/capabilities";
import { bookingFieldAccess, type BookingFieldAccess, type BookingFieldMode } from "@/lib/booking-field-access";
import { PLAN_KEY_PREFIX } from "@/lib/plans-constants";
import { applyReceptionAction, RECEPTION_ACTION_LABEL } from "@/lib/reception-state";
import type { ForceFlags } from "@/lib/booking-force-flags";
import { tags, ttl } from "@/lib/cache-tags";
import { NotificationKind } from "@prisma/client";

/**
 * Wipe every booking-derived cache slot for a tenant. Called after any
 * create/update/delete of a Booking — both the agenda calendar dots and
 * the dashboard KPIs depend on bookings, so invalidating one without
 * the other surfaces stale data.
 */
function invalidateBookingDerivedCaches(tenantId: string) {
  revalidateTag(tags.bookingDays(tenantId));
  revalidateTag(tags.dashboard(tenantId));
}
import {
  BookingBatchCreate,
  BookingCreate,
  BookingUpdate,
  type ActionResult,
  type BookingBatchCreateInput,
  type BookingCreateInput,
  type BookingUpdateInput,
} from "@/lib/validation";

import {
  AgendaBookingsQuery,
  ReceptionActionInput,
  type AgendaBookingRow,
  type AgendaBookingsQueryInput,
  type BatchDateOutcome,
  type BookingBlockedPrompt,
  type BookingOutOfHoursPrompt,
  type BookingRow,
  type ReceptionActionResult,
} from "@/lib/bookings-types";
import type { ReceptionAction } from "@/lib/reception-state";

type Tx = Prisma.TransactionClient;

// ─────────────────────────────────────────────────────────────────────────────
// Guards compartidos por los write-paths (A2a-S06). Privados: un archivo
// "use server" solo exporta funciones async, y estos no son actions.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Acceso básico = solo ver (decisión del dueño, 30-sep). Un PRACTITIONER sin
 * acceso completo al paciente VE el turno pero no lo modifica: ni estado,
 * reprogramación, borrado, cobros o notas, ni crea turnos para ese paciente.
 * Antes solo lo "reflejaba" la UI (y ni eso: el drawer mostraba Editar), y el
 * servidor aceptaba todo — un kine con acceso básico podía pisar las notas o
 * borrar el turno de un paciente ajeno.
 */
const BASIC_ACCESS_ERROR =
  "Tenés acceso básico a este paciente: podés ver el turno pero no modificarlo. Pedile al profesional a cargo que te lo comparta.";

const SAME_INSTANT_ERROR =
  "El paciente ya tiene un turno que arranca exactamente a esa hora. Movelo aunque sea unos minutos para poder cargarlo.";

const STALE_ERROR = "El turno cambió en otra sesión. Refrescá la agenda y reintentá.";

/**
 * Con paciente, exige acceso `full`. Guest (sin paciente): `guestOperable`
 * (P0.Z, H-b3): BILLING no; la Secretaria y los kines, como hasta hoy.
 *
 * Planes E1 (S07sb): ya NO es el gate de create/batch/update/status/cancelar
 * (eso es `bookingGateInTx`). Queda para lo que sigue exigiendo full: borrar
 * el turno, los toggles de cobro (la matriz de cobros es de C0) y la recepción
 * de un PRACTITIONER sobre turnos ajenos.
 */
async function hasFullAccess(actor: Actor, patientId: string | null, tx: Tx): Promise<boolean> {
  if (!patientId) return guestOperable(await actorCapsInTx(tx, actor));
  return (await patientAccessFor(actor, patientId, tx)) === "full";
}

/**
 * ¿Opera (crea, mueve, cambia estado, borra, marca cobros de) un turno guest?
 * P0.Z (H-b3, revisor (b) de ES1): antes el guest se evaluaba como "full" para
 * cualquier rol, así que BILLING (sin `agenda.operateAll` ni `clinical.read`)
 * creaba turnos guest con copago arbitrario, los borraba y les marcaba cobros.
 * Ahora: `agenda.operateAll` (OWNER, ADMIN, Secretaria) o `clinical.read`
 * (cualquier kine: hoy opera los guest de todos y la recepción de un guest
 * ajeno sigue igual). Que la Secretaria fije el copago de un guest es
 * intencional (lo cobra en recepción). Una sola regla para el gate de escritura
 * (`bookingGateInTx`), `hasFullAccess` y el `canOperate` de la agenda.
 */
function guestOperable(caps: ReadonlySet<Capability>): boolean {
  return caps.has("agenda.operateAll") || caps.has("clinical.read");
}

/**
 * Re-vínculo de paciente sin `clinical.read` (E1, PLANES §S07sb): mover un
 * turno de un paciente a otro arrastra su título, descripción y notas, que
 * pueden ser clínicos y que la Secretaria ni ve. Solo se permite si están
 * vacíos; si no, que lo cambie el profesional.
 */
const CLINICAL_RELINK_ERROR = "Este turno tiene datos clínicos: pedile al profesional que lo cambie";

/**
 * Capabilities del actor leídas DENTRO de la tx abierta. No se usa
 * `getMembershipRole` (lib/authz.ts) porque abre su propia `runWithRls`: desde
 * adentro de otra tx serían dos conexiones del pool a la vez por request.
 */
async function actorCapsInTx(tx: Tx, actor: Actor): Promise<ReadonlySet<Capability>> {
  const m = await tx.membership.findUnique({
    where: { userId_tenantId: { userId: actor.userId, tenantId: actor.tenantId } },
    select: { role: true },
  });
  return capabilitiesFor(m?.role);
}

/** Lee las capabilities a lo sumo una vez por tx, y solo si hacen falta. */
function lazyCapsInTx(tx: Tx, actor: Actor): () => Promise<ReadonlySet<Capability>> {
  let p: Promise<ReadonlySet<Capability>> | undefined;
  return () => (p ??= actorCapsInTx(tx, actor));
}

/**
 * Qué puede hacer el actor sobre un turno (o un alta) de `patientId`.
 * - `canOperate`: crear, mover, cambiar estado y cancelar
 *   (`canOperateBooking` = full || `agenda.operateAll`; E1/C8).
 * - `fields`: qué campos de texto escribe (`bookingFieldAccess`, la MISMA regla
 *   con la que `listAgendaBookings` los lee).
 * - `full`: acceso full real (guest: cuenta como full si `guestOperable`,
 *   igual que `hasFullAccess(actor, null)`). Decide si el `copagoCents` del
 *   actor vale.
 * - `clinical`: el rol tiene `clinical.read` (regla de re-vínculo).
 */
type BookingGate = {
  level: PatientAccessLevel;
  canOperate: boolean;
  fields: BookingFieldAccess;
  full: boolean;
  clinical: boolean;
};

/**
 * `patientId` null = guest: se opera si `guestOperable` (P0.Z: BILLING no) y los campos
 * salen de la regla de guest (título/descripción con `clinical.read`; las notas
 * son del staff). El paciente tiene que venir YA validado contra el tenant
 * (`patientAccessFor` devuelve "none" para uno ajeno, y `agenda.operateAll` no
 * mira el nivel: el chequeo de tenant es del caller, antes de esto).
 *
 * Sin query de rol cuando el acceso es full: por PD-13 (S02p, `isAdminOnlyRole`
 * en lib/visibility.ts, derivado de la matriz) `full` solo lo alcanza un rol
 * CON `clinical.read`, y con full `canOperateBooking` no mira capabilities. El
 * camino de siempre (profesional con su paciente) no suma ni una sentencia:
 * `createBooking`/`updateBooking`/el batch tienen techo estricto de statements
 * (tests/perf/compare.ts, C14).
 */
async function bookingGateInTx(
  tx: Tx,
  actor: Actor,
  patientId: string | null,
  caps: () => Promise<ReadonlySet<Capability>>
): Promise<BookingGate> {
  const level: PatientAccessLevel = patientId ? await patientAccessFor(actor, patientId, tx) : "full";
  if (patientId && level === "full") {
    return {
      level,
      canOperate: true,
      fields: bookingFieldAccess({ clinical: true, access: "full", hasPatient: true }),
      full: true,
      clinical: true,
    };
  }
  const c = await caps();
  const clinical = c.has("clinical.read");
  // Guest: `level` vale "full" solo para `bookingFieldAccess` (la regla de
  // guest no mira el nivel); operar y el copago propio van por `guestOperable`.
  const canOperate = patientId ? canOperateBooking(c, level) : guestOperable(c);
  return {
    level,
    canOperate,
    fields: bookingFieldAccess({ clinical, access: level, hasPatient: !!patientId }),
    full: patientId ? level === "full" : canOperate,
    clinical,
  };
}

/** Un campo es escribible solo si lo es en los dos lados (re-vínculo: el turno antes y después). */
function intersectFields(a: BookingFieldAccess, b: BookingFieldAccess): BookingFieldAccess {
  const m = (x: BookingFieldMode, y: BookingFieldMode): BookingFieldMode => (x === "rw" && y === "rw" ? "rw" : "hidden");
  return { title: m(a.title, b.title), description: m(a.description, b.description), notes: m(a.notes, b.notes) };
}

/**
 * Saca del patch los campos de texto que el actor no puede leer (E1: "un campo
 * se escribe si y solo si se puede leer"). Va ANTES del write y del audit: el
 * drawer con los campos ocultos (null) mandaba vacíos y borraba el título de un
 * guest, o la Secretaria pisaba notas clínicas que no ve.
 */
function writableFields<P extends { title?: string; description?: string; notes?: string }>(
  patch: P,
  fields: BookingFieldAccess
): P {
  const out = { ...patch };
  if (fields.title !== "rw") delete out.title;
  if (fields.description !== "rw") delete out.description;
  if (fields.notes !== "rw") delete out.notes;
  return out;
}

/** ¿El turno trae algo clínico? Notas = sin el prefijo automático "[SOBRETURNO]". */
function hasClinicalText(b: { title: string | null; description: string | null; notes: string | null }): boolean {
  const notes = (b.notes ?? "").replace(/^\[SOBRETURNO\]/, "").trim();
  return !!(b.title?.trim() || b.description?.trim() || notes);
}

/**
 * Nombre del profesional para el aviso de conflicto. Del TENANT (antes era un
 * `findUnique` por id pelado) y nunca el email: el fallback es genérico.
 */
async function practitionerLabel(tx: Tx, tenantId: string, practitionerId: string): Promise<string> {
  const prac = await tx.practitioner.findFirst({
    where: { id: practitionerId, tenantId },
    select: { user: { select: { fullName: true } } },
  });
  return prac?.user.fullName ?? "El profesional";
}

/**
 * Key de idempotencia que manda el cliente (UUID por instancia de modal), o
 * null si no sirve (el caller cae a una al azar). Se descarta también una key
 * con prefijo `pub:`: es el espacio de las reservas públicas y
 * `isPublicReservation` (lib/booking-capacity.ts) la usa para saber qué turno
 * puede vencer a los 30 min — un turno de la agenda nunca tiene que parecerlo.
 *
 * Planes C3 (S07k): tampoco `plan:` (`PLAN_KEY_PREFIX`), el espacio de los
 * turnos que genera un plan (`plan:<generationId>:<index>`). La key es
 * `@unique` global: aceptarla haría que el upsert de `createBooking` encuentre
 * el turno del plan y entre a su rama `update` (resetea copago, status, notas
 * y sede de un turno que el cliente no creó). Igual que con `pub:`, se descarta
 * y el alta cae a una key al azar: fila nueva, el turno del plan intacto. Un
 * cliente legítimo manda UUIDs, así que descartar no le cambia nada.
 */
function acceptClientKey(k: unknown): string | null {
  if (typeof k !== "string" || k.length < 8 || k.length > 64) return null;
  if (k.startsWith("pub:") || k.startsWith(PLAN_KEY_PREFIX)) return null;
  return k;
}

/**
 * Cuántos turnos del MISMO profesional + servicio se superponen con
 * [start, end) y todavía sostienen el cupo (`isHoldingCapacity`: una reserva
 * pública impaga vencida ya no cuenta). Trae los candidatos de la ventana de
 * 240 min hacia atrás (una sesión larga previa igual puede superponerse) y
 * cuenta los solapes reales — un findFirst podía perderlos.
 */
async function countCapacityOverlaps(
  tx: Tx,
  o: {
    tenantId: string;
    practitionerId: string;
    serviceId: string;
    start: Date;
    end: Date;
    now: Date;
    excludeId?: string;
    excludeKey?: string | null;
  }
): Promise<number> {
  const candidates = await tx.booking.findMany({
    where: {
      tenantId: o.tenantId,
      practitionerId: o.practitionerId,
      serviceId: o.serviceId,
      status: { notIn: ["CANCELLED"] },
      scheduledFor: { lt: o.end, gte: new Date(o.start.getTime() - 240 * 60_000) },
      ...(o.excludeId ? { id: { not: o.excludeId } } : {}),
      // Un reintento idempotente (misma key) no choca consigo mismo.
      ...(o.excludeKey ? { idempotencyKey: { not: o.excludeKey } } : {}),
    },
    select: {
      scheduledFor: true,
      durationMin: true,
      status: true,
      paymentStatus: true,
      createdAt: true,
      patientId: true,
      idempotencyKey: true,
    },
  });
  return candidates.filter(
    (c) =>
      isHoldingCapacity(c, o.now) &&
      c.scheduledFor < o.end &&
      new Date(c.scheduledFor.getTime() + c.durationMin * 60_000) > o.start
  ).length;
}

/**
 * Guard a nivel PACIENTE, ortogonal al cupo del profesional. Mira los turnos
 * no cancelados del paciente (de cualquier profesional) en el día AR del nuevo
 * turno UNIDO a 240 min hacia atrás, así una sesión larga que cruza la
 * medianoche AR igual se detecta. Lo usan createBooking y (desde A2a-S06)
 * updateBooking, que antes reprogramaba o cambiaba de paciente sin mirarlo.
 *
 *   - `sameInstant`: arranca exactamente a la misma hora → el índice único
 *     parcial lo rechaza igual; no se ofrece confirmar.
 *   - `overlapISO`: el primer turno propio que se superpone (confirmable:
 *     dos servicios en paralelo es normal en kinesiología).
 *   - `sameDayStarts`: turnos del mismo día AR (para el aviso suave de create).
 * Excluye la fila propia (`excludeId` al editar, `excludeKey` en un reintento).
 */
async function checkPatientOverlap(
  tx: Tx,
  o: {
    tenantId: string;
    patientId: string;
    start: Date;
    end: Date;
    excludeId?: string;
    excludeKey?: string | null;
  }
): Promise<{ sameInstant: boolean; overlapISO: string | null; sameDayStarts: Date[] }> {
  // Día AR del turno como instantes. B3.1: antes era el literal
  // `${dayKey}T03:00:00Z` (medianoche AR a mano); ahora el único puente día ↔
  // instante del motor (`dayWindow`, sobre `lib/datetime-ar.ts`).
  const { start: dayStart, end: dayEnd } = dayWindow(dayKeyOf(o.start));
  const windowStart = new Date(Math.min(dayStart.getTime(), o.start.getTime() - 240 * 60_000));
  // Hasta el fin del día AR o del turno nuevo (un turno de 23:30 que cruza la
  // medianoche también puede pisar uno del día siguiente).
  const windowEnd = new Date(Math.max(dayEnd.getTime(), o.end.getTime()));
  const rows = await tx.booking.findMany({
    where: {
      tenantId: o.tenantId,
      patientId: o.patientId,
      status: { notIn: ["CANCELLED"] },
      scheduledFor: { gte: windowStart, lt: windowEnd },
      ...(o.excludeId ? { id: { not: o.excludeId } } : {}),
      ...(o.excludeKey ? { idempotencyKey: { not: o.excludeKey } } : {}),
    },
    select: { scheduledFor: true, durationMin: true },
  });
  const sameInstant = rows.some((c) => +c.scheduledFor === +o.start);
  let overlapISO: string | null = null;
  if (patientDayStatus(rows, o.start, o.end) === "overlap") {
    const first = rows
      .filter(
        (c) =>
          c.scheduledFor < o.end &&
          new Date(c.scheduledFor.getTime() + c.durationMin * 60_000) > o.start
      )
      .sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime())[0];
    overlapISO = first.scheduledFor.toISOString();
  }
  // Aviso suave solo para un segundo turno del MISMO día AR; un arrastre del
  // día anterior que trajo la ventana hacia atrás no lo dispara.
  const sameDayStarts = rows
    .map((c) => c.scheduledFor)
    .filter((d) => d >= dayStart && d < dayEnd)
    .sort((a, b) => a.getTime() - b.getTime());
  return { sameInstant, overlapISO, sameDayStarts };
}

/**
 * P2002 al escribir un turno, resuelto sin depender de `meta.target`.
 *
 * Bajo RLS (rol `kinesoft_app`: local hoy, prod tras el flip) Postgres NO
 * informa qué índice violó el INSERT: `meta.target` llega `null` y el catch
 * viejo caía a "Turno duplicado." (hallazgo A1.1). Por eso se decide por los
 * DATOS, en una transacción NUEVA (la que falló quedó abortada, no admite más
 * queries):
 *   - existe una fila VIVA de este tenant con esta `idempotencyKey` → es el
 *     mismo intento (reintento, doble click o dos upserts concurrentes con la
 *     misma key que se cruzaron en el índice del paciente) → éxito idempotente
 *     con esa fila;
 *   - si no, target `null` o el índice paciente+instante → el paciente ya
 *     tiene un turno activo que arranca exactamente a esa hora;
 *   - cualquier otra cosa → error genérico (el caller loguea).
 * Una fila con la key pero CANCELLED no es éxito: el upsert quiso reactivarla
 * y chocó con otro turno del paciente en ese instante.
 */
async function resolveUniqueViolation(
  tenantId: string,
  e: unknown,
  idempotencyKey: string
): Promise<{ kind: "existing"; id: string } | { kind: "patient-slot" } | { kind: "other" }> {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") {
    return { kind: "other" };
  }
  const row = await runWithRls(tenantId, (tx) =>
    tx.booking.findFirst({
      where: { tenantId, idempotencyKey },
      select: { id: true, status: true },
    })
  );
  if (row && row.status !== "CANCELLED") return { kind: "existing", id: row.id };
  const rawTarget = e.meta?.target;
  const target = Array.isArray(rawTarget) ? rawTarget.join(",") : String(rawTarget ?? "");
  if (
    rawTarget == null ||
    target === "" ||
    target.includes("patient_slot") ||
    (target.includes("patientId") && target.includes("scheduledFor"))
  ) {
    return { kind: "patient-slot" };
  }
  return { kind: "other" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Motor de disponibilidad (B3.1 AV-bookings). La lógica es pura
// (`lib/availability/*`); acá solo la carga (`loadAvailabilityInputs` con el tx
// de runWithRls) y la traducción a los avisos blandos del alta/edición.
// Lo que NO se movió al motor, a propósito: el cupo del write
// (`countCapacityOverlaps`) y el guard del paciente (`checkPatientOverlap`)
// siguen con sus queries propias — son el contrato de AUDIT §5 (preservar) y
// los cubre la caracterización de bookings-write; el motor aporta franjas,
// bloqueos, la regla por profesional y la sugerencia.
// ─────────────────────────────────────────────────────────────────────────────

const SERVICE_DISABLED_ERROR = (serviceName: string) =>
  `Este profesional no tiene habilitado el servicio «${serviceName}». Elegí otro profesional o habilitalo en Configuración → Profesionales.`;
const BAD_LOCATION_ERROR = "Sede inválida o archivada. Elegí otra sede.";
const OUT_OF_HOURS_ERROR =
  "Ese horario está fuera del horario de atención del profesional. Podés elegir el próximo libre o cargarlo igual.";
const BLOCKED_ERROR = (reason: string | null) =>
  `La agenda del profesional está bloqueada en ese horario${reason ? ` (${reason})` : ""}. Podés elegir el próximo libre o cargarlo igual como sobreturno.`;

type ServiceForRule = { id: string; durationMin: number; maxConcurrent: number | null; practitionerId: string | null };

/**
 * Regla efectiva del profesional para el servicio (`PractitionerService`):
 * habilitado, duración propia y cupo (override). Sin fila, el default de
 * Configuración: habilitado si el servicio es del consultorio o de ese
 * profesional (`resolvePractitionerService`). Tenant-scoped a mano.
 */
async function practitionerServiceRule(
  tx: Tx,
  tenantId: string,
  practitionerId: string,
  service: ServiceForRule
): Promise<ResolvedPractitionerService> {
  const row = await tx.practitionerService.findFirst({
    where: { tenantId, practitionerId, serviceId: service.id },
    select: {
      practitionerId: true,
      serviceId: true,
      enabled: true,
      visibility: true,
      durationMin: true,
      minLeadMinutes: true,
      maxLeadDays: true,
      concurrencyOverride: true,
      maxConcurrent: true,
    },
  });
  return resolvePractitionerService(row ?? undefined, service, practitionerId);
}

/** Franjas SIN restar bloqueos (contrato de `classify`: si recibiera
 *  `workingRanges`, un instante bloqueado saldría además fuera de horario). */
const rangesForInput = (input: AvailabilityInput): RangesFor => (pid, dayKey) => scheduledRanges(pid, dayKey, input);

/** Lo que el motor necesita para clasificar [start, end) de un profesional:
 *  el día AR del inicio (y el siguiente si el turno cruza la medianoche). */
function loadInstantAvailability(
  tx: Tx,
  o: { tenantId: string; practitionerId: string; serviceId: string; start: Date; end: Date }
) {
  const from = dayKeyOf(o.start);
  const to = dayKeyOf(new Date(Math.max(o.start.getTime(), o.end.getTime() - 1)));
  return loadAvailabilityInputs(tx, {
    tenantId: o.tenantId,
    practitionerIds: [o.practitionerId],
    serviceId: o.serviceId,
    from,
    to,
  });
}

/** Franjas/bloqueos del instante. `locationId` null = cualquier sede (la
 *  deciden las franjas). Patient = null: el guard del paciente es aparte. */
function classifyForWrite(
  input: AvailabilityInput,
  o: {
    when: Date;
    durationMin: number;
    practitionerId: string;
    serviceId: string;
    locationId: string | null;
    cap: number | null;
    now: Date;
    excludeBookingId?: string;
  }
): InstantClassification & { blockReason: string | null } {
  const c = classifyInstant({
    ...o,
    patientId: null,
    rangesFor: rangesForInput(input),
    blocks: input.blocks,
    bookings: input.bookings,
  });
  const blockReason = input.blocks.find((b) => c.blockIds.includes(b.id) && b.reason)?.reason ?? null;
  return { ...c, blockReason };
}

/**
 * Bloqueos vivos que pueden pisar [start, end) del profesional, leídos DENTRO
 * del tx de escritura (integrador final de B-pre, handoff de B4.4).
 *
 * El bug: el alta y el batch clasificaban el bloqueo en un tx PREVIO (y la
 * edición, antes del lock de cupo), así que un `applyDayLock` que commiteaba
 * en el medio dejaba entrar el turno como normal: sin aviso `blocked` y sin
 * marcarlo sobreturno. `applyDayLock` toma los locks de cupo
 * (`lib/booking-cap-lock.ts`) de cada (profesional, servicio) del día; el
 * write-path toma el mismo lock y RECIÉN DESPUÉS llama a esto: en READ
 * COMMITTED la sentencia ve el bloqueo ya commiteado (o el candado espera a
 * que commiteemos y su recálculo de afectados ve nuestro turno → `changed`).
 *
 * Mismo filtro y ventana que `loadAvailabilityInputs` sin sede (los días AR
 * que toca el turno), para que la re-clasificación sea idéntica a la del
 * motor salvo por los bloqueos nuevos. Una sola query: no se recarga todo.
 */
async function liveBlocksInTx(
  tx: Tx,
  o: { tenantId: string; practitionerId: string; start: Date; end: Date }
): Promise<AvailabilityInput["blocks"]> {
  const from = dayKeyOf(o.start);
  const to = dayKeyOf(new Date(Math.max(o.start.getTime(), o.end.getTime() - 1)));
  return tx.timeBlock.findMany({
    where: {
      tenantId: o.tenantId,
      deletedAt: null,
      startsAt: { lt: dayWindow(to).end },
      endsAt: { gt: dayWindow(from).start },
      OR: [{ practitionerId: null }, { practitionerId: o.practitionerId }],
    },
    select: {
      id: true,
      practitionerId: true,
      locationId: true,
      startsAt: true,
      endsAt: true,
      allDay: true,
      reason: true,
      groupId: true,
    },
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
  });
}

/**
 * Sede por defecto de un turno sin sede elegida: la de la franja del
 * profesional donde entra el turno (o la que contiene el inicio); si no cae en
 * ninguna, la principal. null = sin sede principal (tenant sin Location: el
 * turno queda con null = "principal" como hasta ahora).
 */
function defaultLocationFor(input: AvailabilityInput, practitionerId: string, when: Date, durationMin: number): string | null {
  const { dayKey, startMin } = arWallOf(when);
  const ranges = scheduledRanges(practitionerId, dayKey, input);
  const hit =
    ranges.find((r) => fitsInRanges(ranges, startMin, durationMin, r.locationId)) ??
    ranges.find((r) => r.startMin <= startMin && startMin < r.endMin);
  const loc = hit?.locationId ?? input.primaryLocationId;
  return loc && loc !== NO_LOCATION_ID ? loc : null;
}

/**
 * Lock COMPARTIDO de las sedes del tenant y RECIÉN DESPUÉS la validación (patrón
 * de `lib/location-lock.ts`): así `archiveLocation` no puede intercalarse
 * entre "la sede está activa" y la fila que la referencia. Dentro del tx.
 */
async function lockActiveLocation(tx: Tx, tenantId: string, locationId: string): Promise<boolean> {
  await lockTenantLocationsShared(tx, tenantId);
  const loc = await tx.location.findFirst({
    where: { id: locationId, tenantId, active: true },
    select: { id: true },
  });
  return !!loc;
}

/**
 * Próximo hueco libre para la sugerencia de los avisos (`conflict`,
 * `outOfHours`, `blocked`). B3.1: `nextFreeSlot` del motor en vez de
 * `findNextFreeSlot` (lun-sáb + businessHours del tenant). Ahora respeta las
 * franjas del profesional, excepciones y bloqueos, y ve los turnos EN CURSO
 * (el loader trae desde `from − BOOKING_LOOKBACK_MIN`; el suggest viejo
 * cargaba desde `from + 15` y podía proponer un hueco ocupado, hallazgo de
 * B1.6). Con `patientId` tampoco propone un horario donde el paciente ya está.
 * Lectura consultiva: su propio runWithRls, fuera del tx del write.
 */
async function suggestNextFreeSlot(
  tenantId: string,
  o: {
    practitionerId: string;
    serviceId: string;
    from: Date;
    durationMin: number;
    cap: number | null;
    patientId?: string | null;
    locationId?: string | null;
    excludeBookingId?: string;
  }
): Promise<string | null> {
  const fromKey = dayKeyOf(o.from);
  const input = await runWithRls(tenantId, (tx) =>
    loadAvailabilityInputs(tx, {
      tenantId,
      practitionerIds: [o.practitionerId],
      serviceId: o.serviceId,
      patientId: o.patientId ?? undefined,
      from: fromKey,
      // +1: el horizonte (14 días) corre desde `from + 15 min`.
      to: addDays(fromKey, NEXT_FREE_HORIZON_DAYS + 1),
    })
  );
  return nextFreeSlot({
    from: o.from,
    durationMin: o.durationMin,
    patientId: o.patientId ?? null,
    practitionerId: o.practitionerId,
    serviceId: o.serviceId,
    locationId: o.locationId ?? null,
    cap: o.cap,
    rangesFor: rangesForInput(input),
    blocks: input.blocks,
    bookings: input.bookings,
    now: new Date(),
    excludeBookingId: o.excludeBookingId ?? null,
  });
}

export async function listBookingsInRange(opts: {
  from: Date;
  to: Date;
  practitionerId?: string;
}): Promise<BookingRow[]> {
  const actor = await getActor();
  // Sprint 16: agenda shows every booking in the tenant; per-row access
  // tier is resolved below. The diagnosis chip is hidden when the actor
  // only has BASIC access to that booking's patient.
  const rows = await runWithRls(actor.tenantId, (tx) => tx.booking.findMany({
    where: {
      tenantId: actor.tenantId,
      scheduledFor: { gte: opts.from, lt: opts.to },
      ...(opts.practitionerId ? { practitionerId: opts.practitionerId } : {}),
    },
    orderBy: { scheduledFor: "asc" },
    include: {
      service: true,
      patient: {
        include: {
          // Active coverage → insurer name + copago for the billing
          // subtitle/columns. `take: 1` mirrors the single-coverage model
          // (setPatientCoverage replaces rather than appends).
          coverages: {
            include: { insurerRef: true },
            orderBy: { id: "desc" },
            take: 1,
          },
          programs: {
            where: { status: "ACTIVE" },
            include: { case: { include: { diagnoses: { include: { condition: true }, take: 1, orderBy: { rank: "asc" } } } } },
            // S07k: con dos ACTIVE (legacy de prod; el único parcial llega con
            // M1) el chip mostraba el que Postgres devolviera primero. Gana el
            // más reciente, igual que el resto de las lecturas del plan activo.
            orderBy: { createdAt: "desc" },
            take: 1,
          },
        },
      },
    },
  }));

  const patientIds = rows
    .map((b) => b.patientId)
    .filter((id): id is string => !!id);
  const [accessMap, particularCopago, role] = await Promise.all([
    bulkPatientAccess(actor, patientIds),
    getParticularCopagoCents(actor.tenantId),
    getMembershipRole(actor),
  ]);
  // E0 (S07k): esta server action se puede llamar por RPC aunque la agenda ya
  // use `listAgendaBookings`. Gateaba solo full/basic, así que la Secretaria
  // (ASSISTANT, sin `clinical.read`) con `sharedPatientView` leía título,
  // descripción, notas y diagnóstico. Ahora: la misma regla que la agenda
  // (`bookingFieldAccess`) y el chip de diagnóstico solo con clinical + full.
  const clinical = capabilitiesFor(role).has("clinical.read");

  return rows.map((b): BookingRow => {
    const level = b.patientId ? (accessMap.get(b.patientId) ?? "basic") : "none";
    // `BookingRow.patientAccess` solo conoce full/basic/none: cualquier otro
    // nivel (el `admin` de PD-13, S02p) viaja como "basic" = sin link a la HC
    // (decisión de S07sb, ver el tipo en lib/bookings-types.ts). El gate de
    // campos usa el nivel real (`bookingFieldAccess` exige "full").
    const access: BookingRow["patientAccess"] = level === "full" || level === "none" ? level : "basic";
    const fields = bookingFieldAccess({ clinical, access: level, hasPatient: !!b.patientId });
    // Chip de diagnóstico = HC: solo clinical.read + full (= `canWriteClinical`
    // en lectura). Un guest no tiene plan.
    const cond =
      clinical && access === "full"
        ? b.patient?.programs[0]?.case?.diagnoses[0]?.condition?.name ?? null
        : null;
    const name = b.patient
      ? `${b.patient.firstName} ${b.patient.lastName}`
      : b.guestName ?? "Sin asignar";
    // Billing: resolve obra social + copago from the patient's active
    // coverage. Particular (no insurer / no coverage / guest) falls back
    // to "Particular" with the service price as the amount the patient
    // pays out of pocket. Gated to full access — basic-access rows hide
    // billing PHI (consistent with notes/condition above). PD-13 (S07sb):
    // el nivel `admin` (Secretaria/Facturación) ve obra social, cobertura y
    // estado de cobro — SOLO esto; título/descripción/notas siguen con
    // `bookingFieldAccess` y el diagnóstico con clinical + full.
    const seesBilling = level === "full" || level === "admin";
    const coverage = seesBilling ? b.patient?.coverages[0] : undefined;
    const insurer = coverage?.insurerRef;
    const obraSocial =
      seesBilling
        ? insurer?.name ?? coverage?.insurer ?? "Particular"
        : "Particular";
    // Copago precedence: per-turno override → per-patient override →
    // insurer → Particular → service price. Basic-access rows hide billing
    // and just show the service price.
    const copagoCents =
      seesBilling
        ? resolveBookingCopagoCents({
            bookingOverride: b.copagoCents,
            coverageOverride: coverage?.copagoCents ?? null,
            hasCoverage: !!coverage,
            insurerCopago: insurer ? insurer.copagoCents : null,
            particularCopago,
            servicePriceCents: b.service.priceCents,
          })
        : b.service.priceCents;
    return {
      id: b.id,
      scheduledFor: b.scheduledFor,
      durationMin: b.durationMin,
      status: b.status,
      serviceId: b.serviceId,
      serviceName: b.service.name,
      serviceColor: b.service.color,
      practitionerId: b.practitionerId,
      patientId: b.patientId,
      patientName: name,
      patientCondition: cond,
      obraSocial,
      copagoCents,
      updatedAt: b.updatedAt,
      // A2 integrador: la agenda los usa para "Pendiente de pago · vencida".
      paymentStatus: b.paymentStatus,
      createdAt: b.createdAt,
      // Revisión A2: la etiqueta "Pendiente de pago" es solo de la reserva
      // pública (por la key, no por tener paciente). La key no viaja al cliente.
      publicReservation: isPublicReservation(b),
      // Notes, title and description can carry clinical context — hidden on
      // basic (A2a-S06: title/description leaked before) and, since E0, also
      // without `clinical.read` (`bookingFieldAccess`, same rule as
      // `listAgendaBookings`). Guest rows keep their notes (the front desk
      // wrote them: administrative); title/description of a guest still need
      // `clinical.read`.
      notes: fields.notes === "rw" ? b.notes : null,
      title: fields.title === "rw" ? b.title : null,
      description: fields.description === "rw" ? b.description : null,
      patientAccess: access,
    };
  });
}

/**
 * Proyección LIVIANA de la agenda (B4.1 AV-bookings-2). La consume la agenda
 * multi-profesional (B4.3 la adopta en `app/(app)/agenda/page.tsx`; hasta
 * entonces `listBookingsInRange` sigue igual para quien la usa hoy) y la vista
 * Recepción (B4.5).
 *
 * Por qué una función nueva y no un flag en `listBookingsInRange`: la completa
 * incluye, POR FILA, paciente → coberturas → programas → caso → diagnósticos
 * (hecho 6 de bpre-design: el cuello de botella con 5+ profesionales en una
 * semana). Acá:
 *   - sin programa/caso/diagnóstico: `patientCondition` siempre null (el chip
 *     de la card lo cubre `title`, el mini-diagnóstico del turno);
 *   - la cobertura NO va por fila: UNA query plana para los pacientes
 *     distintos con acceso `full` o `admin` (los únicos a los que se les
 *     muestra billing; `admin` desde PD-13/S07sb), con la misma precedencia de copago (`resolveBookingCopagoCents`,
 *     AUDIT §5.5) — `obraSocial`/`copagoCents` dan igual que en la completa
 *     (lo afirma bookings-reception.test.ts);
 *   - service/patient con `select` de lo que se muestra, no `include` entero.
 *
 * Gate `clinical.read` (lib/capabilities.ts): sin ella (ASSISTANT, BILLING)
 * title/description van null y `notes` solo queda en turnos SIN paciente (la
 * carga el staff: es administrativa, p. ej. el teléfono de una reserva
 * externa). Se suma al gate por paciente de siempre (acceso `basic` →
 * title/description/notes null). `clinicalHidden` lo informa por fila, y
 * `canOperate` / `clinicalWritable` (S07sb) dicen qué puede hacer el actor
 * con el turno: son la fuente para la UI, calculadas con los mismos
 * predicados que los write-paths.
 * `agenda.viewAll` (hoy la tienen todos los roles): sin ella, solo la agenda
 * propia — falla cerrado si C0 crea un rol sin esa capability.
 *
 * Filtros: `practitionerIds[]` (vacío = todos) y `locationId` (la principal
 * incluye los turnos con `locationId` null, contrato de M-agenda; una sede que
 * no es del tenant → []). Rango ≤ 62 días; input inválido → tira ZodError
 * (server action de lectura, como `listBookingsInRange`).
 */
export async function listAgendaBookings(raw: AgendaBookingsQueryInput): Promise<AgendaBookingRow[]> {
  const actor = await getActor();
  const q = AgendaBookingsQuery.parse(raw);
  const caps = capabilitiesFor(await getMembershipRole(actor));
  const clinical = caps.has("clinical.read");
  let practitionerIds = q.practitionerIds?.length ? [...new Set(q.practitionerIds)] : undefined;
  if (!caps.has("agenda.viewAll")) {
    practitionerIds = (practitionerIds ?? [actor.practitionerId]).filter((id) => id === actor.practitionerId);
  }
  const tenantId = actor.tenantId;

  const loaded = await runWithRls(tenantId, async (tx) => {
    // Las sedes del tenant son pocas: una query sirve para el filtro (¿es la
    // principal?) y para `locationName` (null = principal).
    const locations = await tx.location.findMany({
      where: { tenantId },
      select: { id: true, name: true, isPrimary: true },
    });
    let locationWhere: Prisma.BookingWhereInput = {};
    if (q.locationId) {
      const loc = locations.find((l) => l.id === q.locationId);
      if (!loc) return null;
      locationWhere = loc.isPrimary
        ? { OR: [{ locationId: loc.id }, { locationId: null }] }
        : { locationId: loc.id };
    }
    const rows = await tx.booking.findMany({
      where: {
        tenantId,
        scheduledFor: { gte: q.from, lt: q.to },
        ...(practitionerIds ? { practitionerId: { in: practitionerIds } } : {}),
        ...(q.includeCancelled === false ? { status: { not: "CANCELLED" as const } } : {}),
        ...locationWhere,
      },
      orderBy: [{ scheduledFor: "asc" }, { id: "asc" }],
      select: {
        id: true,
        scheduledFor: true,
        durationMin: true,
        status: true,
        serviceId: true,
        practitionerId: true,
        patientId: true,
        guestName: true,
        copagoCents: true,
        notes: true,
        title: true,
        description: true,
        updatedAt: true,
        paymentStatus: true,
        createdAt: true,
        idempotencyKey: true,
        isOverbooked: true,
        locationId: true,
        isTelemedicine: true,
        telemedicineUrl: true,
        arrivedAt: true,
        attendingAt: true,
        service: { select: { name: true, color: true, priceCents: true } },
        patient: { select: { firstName: true, lastName: true } },
      },
    });
    const patientIds = [...new Set(rows.map((b) => b.patientId).filter((id): id is string => !!id))];
    const access = await bulkPatientAccess(actor, patientIds, tx);
    // PD-13 (S07sb): cobertura/copago también para `admin` (Secretaria y
    // Facturación ven obra social y estado de cobro); nunca para `basic`.
    const billingIds = patientIds.filter((id) => {
      const l = access.get(id);
      return l === "full" || l === "admin";
    });
    const [coverages, particularCopago] = await Promise.all([
      billingIds.length
        ? tx.coverage.findMany({
            where: { patientId: { in: billingIds }, patient: { tenantId } },
            // = `orderBy id desc, take 1` por paciente de la proyección completa.
            orderBy: { id: "desc" },
            select: {
              patientId: true,
              insurer: true,
              copagoCents: true,
              insurerRef: { select: { name: true, copagoCents: true } },
            },
          })
        : Promise.resolve([]),
      getParticularCopagoCents(tenantId, tx),
    ]);
    return { locations, rows, access, coverages, particularCopago };
  });
  if (!loaded) return [];

  const coverageOf = new Map<string, (typeof loaded.coverages)[number]>();
  for (const c of loaded.coverages) if (!coverageOf.has(c.patientId)) coverageOf.set(c.patientId, c);
  const locationName = new Map(loaded.locations.map((l) => [l.id, l.name]));
  const primaryName = loaded.locations.find((l) => l.isPrimary)?.name ?? null;

  return loaded.rows.map((b): AgendaBookingRow => {
    // PD-13: el nivel real puede ser `admin` (rol sin clinical.read). En la fila
    // viaja como basic; los campos de texto salen de `bookingFieldAccess` con el
    // nivel real (forma positiva `=== "full"`), así `admin` nunca ve HC.
    const level = b.patientId ? (loaded.access.get(b.patientId) ?? "basic") : "none";
    const access: "full" | "basic" | "none" = level === "full" || level === "none" ? level : "basic";
    const fields = bookingFieldAccess({ clinical, access: level, hasPatient: !!b.patientId });
    // S07sb (E1): permisos de la fila calculados acá, la UI no los deduce de
    // `patientAccess` (que manda `admin` como "basic"). Guest: `guestOperable`
    // (P0.Z: BILLING no), igual que en los write-paths (`bookingGateInTx`). `clinicalWritable` = el
    // título/descripción se escriben (= se leen): con paciente es
    // `canWriteClinical`; en un guest, `clinical.read`.
    const canOperate = b.patientId ? canOperateBooking(caps, level) : guestOperable(caps);
    const clinicalWritable = b.patientId ? canWriteClinical(caps, level) : fields.title === "rw";
    const seesBilling = level === "full" || level === "admin";
    const coverage = seesBilling && b.patientId ? coverageOf.get(b.patientId) : undefined;
    const insurer = coverage?.insurerRef;
    // Mismo cálculo que `listBookingsInRange` (precedencia §5.5; basic → precio).
    const obraSocial = seesBilling ? insurer?.name ?? coverage?.insurer ?? "Particular" : "Particular";
    const copagoCents =
      seesBilling
        ? resolveBookingCopagoCents({
            bookingOverride: b.copagoCents,
            coverageOverride: coverage?.copagoCents ?? null,
            hasCoverage: !!coverage,
            insurerCopago: insurer ? insurer.copagoCents : null,
            particularCopago: loaded.particularCopago,
            servicePriceCents: b.service.priceCents,
          })
        : b.service.priceCents;
    return {
      id: b.id,
      scheduledFor: b.scheduledFor,
      durationMin: b.durationMin,
      status: b.status,
      serviceId: b.serviceId,
      serviceName: b.service.name,
      serviceColor: b.service.color,
      practitionerId: b.practitionerId,
      patientId: b.patientId,
      patientName: b.patient ? `${b.patient.firstName} ${b.patient.lastName}` : b.guestName ?? "Sin asignar",
      patientCondition: null,
      obraSocial,
      copagoCents,
      notes: fields.notes === "rw" ? b.notes : null,
      title: fields.title === "rw" ? b.title : null,
      description: fields.description === "rw" ? b.description : null,
      updatedAt: b.updatedAt,
      patientAccess: access,
      paymentStatus: b.paymentStatus,
      createdAt: b.createdAt,
      publicReservation: isPublicReservation(b),
      isOverbooked: b.isOverbooked,
      locationId: b.locationId,
      locationName: b.locationId ? locationName.get(b.locationId) ?? null : primaryName,
      isTelemedicine: b.isTelemedicine,
      telemedicineUrl: b.telemedicineUrl,
      arrivedAt: b.arrivedAt,
      attendingAt: b.attendingAt,
      clinicalHidden: fields.title !== "rw",
      canOperate,
      clinicalWritable,
    };
  });
}

export async function getDayCounts(opts: { from: Date; to: Date }) {
  const actor = await getActor();
  // Day-strip dots show every booking in the tenant — counts don't leak
  // PHI so no access gating needed here.
  const rows = await runWithRls(actor.tenantId, (tx) => tx.booking.findMany({
    where: {
      tenantId: actor.tenantId,
      scheduledFor: { gte: opts.from, lt: opts.to },
      status: { not: "CANCELLED" },
    },
    select: { scheduledFor: true },
  }));
  const counts = new Map<string, number>();
  for (const r of rows) {
    // Bucket by the AR calendar day, not the UTC slice — otherwise a late-night
    // turno lands on the wrong day's dot on a UTC host (Vercel).
    const k = toARDateKey(r.scheduledFor);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

export async function listServices() {
  const actor = await getActor();
  const fetcher = unstable_cache(
    async (tenantId: string) =>
      runWithRls(tenantId, (tx) => tx.service.findMany({
        where: { tenantId },
        orderBy: { name: "asc" },
      })),
    ["services:list", actor.tenantId],
    { tags: [tags.services(actor.tenantId)], revalidate: ttl.short }
  );
  return fetcher(actor.tenantId);
}

/**
 * Profesionales del selector de la agenda. Solo los que tienen membresía
 * ACEPTADA en este tenant (A2b-S-cfg): `removeMember` borra la membresía pero
 * deja la fila Practitioner (historial), y antes el removido seguía
 * apareciendo como opción para dar turnos. El tag `practitioners` se invalida
 * al quitar/cambiar de rol (lib/invitations.ts) y al aceptar una invitación.
 */
export async function listPractitioners() {
  const actor = await getActor();
  const fetcher = unstable_cache(
    async (tenantId: string) =>
      runWithRls(tenantId, (tx) => tx.practitioner.findMany({
        where: {
          tenantId,
          user: { memberships: { some: { tenantId, acceptedAt: { not: null } } } },
        },
        include: { user: true },
        orderBy: { createdAt: "asc" },
      })),
    ["practitioners:list", actor.tenantId],
    { tags: [tags.practitioners(actor.tenantId)], revalidate: ttl.short }
  );
  return fetcher(actor.tenantId);
}

export async function createBooking(
  raw: BookingCreateInput & {
    allowOverbooking?: boolean;
    // Front-desk confirmed that a second turno the same day for this patient
    // is intentional (they don't overlap). Skips the same-patient-day prompt.
    allowSamePatientDay?: boolean;
    // Front-desk confirmed the new turno may overlap one the patient already
    // has (two services in parallel is normal in kinesiología). The exact same
    // instant is still refused by the DB unique index.
    allowPatientOverlap?: boolean;
    // B3.1 (decisión 2): el staff confirmó cargarlo fuera de la franja del
    // profesional (o un día que no atiende). Solo aviso, no sobreturno.
    allowOutOfHours?: boolean;
    // B3.1 (decisión 1): el staff confirmó cargarlo sobre un bloqueo de agenda.
    // Queda como sobreturno (`isOverbooked` + prefijo). El turnero y Planes no
    // lo pueden forzar (bloqueo duro allá).
    allowBlocked?: boolean;
    // Stable per-attempt key from the client so a double-submit / retry
    // collapses to one row, while a deliberate new turno gets its own.
    idempotencyKey?: string;
  }
): Promise<
  ActionResult<{ id: string }> & {
    conflict?: {
      practitionerName: string;
      nextFreeISO: string | null;
    };
    // Soft prompt: the patient already has ≥1 non-overlapping turno today.
    samePatientDay?: { count: number; existingISO: string };
    // Soft prompt: the new turno overlaps one the patient already has.
    patientOverlap?: { existingISO: string };
    // B3.1: fuera del horario del profesional (re-llamar con allowOutOfHours).
    outOfHours?: BookingOutOfHoursPrompt;
    // B3.1: sobre un bloqueo de agenda (re-llamar con allowBlocked).
    blocked?: BookingBlockedPrompt;
  }
> {
  const actor = await getActor();
  const parsed = BookingCreate.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Datos inválidos",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const data = parsed.data;
  const now = new Date();

  // Ids de entrada validados contra el tenant ANTES de escribir: las FK
  // saltean RLS y en prod la conexión tiene BYPASSRLS, así que un
  // `practitionerId` de otro consultorio se persistía tal cual (IDOR, A2a-S06).
  // El paciente además tiene que ser de acceso `full` (acceso básico = solo ver).
  // El diagnóstico por defecto del paciente auto-completa title/description
  // del turno cuando el caller no los envía (overridable por turno).
  // B3.1: en el mismo tx, la sede elegida (del tenant y activa; se re-valida
  // con lock al escribir), la regla del profesional para el servicio
  // (`PractitionerService`: habilitado + duración + cupo) y las entradas del
  // motor de disponibilidad para clasificar el horario.
  const pre = await runWithRls(actor.tenantId, async (tx) => {
    const [patient, service, prac, location] = await Promise.all([
      data.patientId
        ? tx.patient.findFirst({
            where: { id: data.patientId, tenantId: actor.tenantId },
            select: { id: true, diagnosisTitle: true, diagnosisNote: true },
          })
        : Promise.resolve(null),
      tx.service.findFirst({
        where: { id: data.serviceId, tenantId: actor.tenantId },
        select: { id: true, durationMin: true, name: true, maxConcurrent: true, practitionerId: true },
      }),
      tx.practitioner.findFirst({
        where: { id: data.practitionerId, tenantId: actor.tenantId },
        select: { id: true },
      }),
      data.locationId
        ? tx.location.findFirst({
            where: { id: data.locationId, tenantId: actor.tenantId, active: true },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);
    if (data.patientId && !patient) return { kind: "foreign-patient" as const };
    if (!prac) return { kind: "foreign-practitioner" as const };
    if (!service) return { kind: "bad-service" as const };
    if (data.locationId && !location) return { kind: "bad-location" as const };
    // E1 (S07sb): operar = full || `agenda.operateAll` (la Secretaria, que
    // desde PD-13 nunca tiene full). PRACTITIONER en básico y BILLING siguen
    // afuera. Guest: `guestOperable` (P0.Z, H-b3): BILLING tampoco crea guests
    // (antes contaba como full y fijaba copago). El paciente ya se validó
    // contra el tenant arriba.
    const gate = await bookingGateInTx(tx, actor, patient?.id ?? null, lazyCapsInTx(tx, actor));
    if (!gate.canOperate) return { kind: "basic" as const };
    // Decisión de B3.1: servicio deshabilitado para ESE profesional → rechazo
    // simple, también para OWNER/ADMIN (se habilita en Configuración). Sin un
    // `allowDisabledService`: el cupo, la duración y el turnero ya leen esta
    // regla, y un turno "por afuera" quedaría inconsistente con todos ellos.
    const rule = await practitionerServiceRule(tx, actor.tenantId, prac.id, service);
    if (!rule.enabled) return { kind: "service-disabled" as const, serviceName: service.name };
    // Duración: la explícita del caller gana; si no, la del profesional para
    // ese servicio (`PractitionerService.durationMin`) o la del servicio.
    const duration = data.durationMin ?? rule.durationMin;
    const end = new Date(data.scheduledFor.getTime() + duration * 60_000);
    const input = await loadInstantAvailability(tx, {
      tenantId: actor.tenantId,
      practitionerId: prac.id,
      serviceId: service.id,
      start: data.scheduledFor,
      end,
    });
    return { kind: "ok" as const, patient, service, rule, duration, end, input, gate };
  });
  if (pre.kind === "foreign-patient") return { ok: false, error: "Paciente fuera del tenant." };
  if (pre.kind === "foreign-practitioner") return { ok: false, error: "Profesional inválido." };
  if (pre.kind === "bad-service") return { ok: false, error: "Servicio inválido." };
  if (pre.kind === "bad-location") return { ok: false, error: BAD_LOCATION_ERROR };
  if (pre.kind === "basic") return { ok: false, error: BASIC_ACCESS_ERROR };
  if (pre.kind === "service-disabled") return { ok: false, error: SERVICE_DISABLED_ERROR(pre.serviceName) };
  const { service, rule, duration, end, input, gate } = pre;
  const patientDiag = pre.patient;
  // E1 (S07sb): lo que el actor no puede leer no lo escribe (título,
  // descripción y notas según `bookingFieldAccess`), y su `copagoCents` solo
  // vale con acceso full: sin full rige la precedencia de lib/copago.ts
  // (AUDIT §5.5) — la Secretaria no fija el precio de la sesión.
  const own = writableFields(data, gate.fields);
  const copagoCents = gate.full ? (data.copagoCents ?? null) : null;

  // Franjas y bloqueos del profesional en ese horario (motor puro). Con una
  // sede elegida se clasifica contra ESA sede; sin elegir, contra cualquiera
  // de sus franjas del día.
  const clsArgs = {
    when: data.scheduledFor,
    durationMin: duration,
    practitionerId: data.practitionerId,
    serviceId: service.id,
    locationId: data.locationId ?? null,
    cap: rule.cap,
    now,
  };
  const cls = classifyForWrite(input, clsArgs);
  const locationId = data.locationId ?? defaultLocationFor(input, data.practitionerId, data.scheduledFor, duration);
  const suggest = () =>
    suggestNextFreeSlot(actor.tenantId, {
      practitionerId: data.practitionerId,
      serviceId: service.id,
      from: data.scheduledFor,
      durationMin: duration,
      cap: rule.cap,
      patientId: data.patientId ?? null,
      locationId: data.locationId ?? null,
    });
  const nameOf = () => runWithRls(actor.tenantId, (tx) => practitionerLabel(tx, actor.tenantId, data.practitionerId));

  // Stable idempotency key for THIS attempt (client-provided, else random).
  // Resolved up-front so the patient-day guard can EXCLUDE this attempt's own
  // row: an idempotent retry (lost response, same key) must not self-conflict.
  const clientKey = acceptClientKey(raw.idempotencyKey);

  // Patient-level guard, orthogonal to the professional's capacity below. Two
  // independent confirmations, each with its own flag: an OVERLAP with the
  // patient's own turno, and a second turno the SAME DAY. Both are prompts, not
  // hard errors (the kine asked for confirm modals). Scoped to the patient
  // across ALL professionals. Skipping the query entirely when both are already
  // confirmed keeps the retry path cheap (the unique index still backstops the
  // exact instant — see resolveUniqueViolation).
  const pat =
    data.patientId && !(raw.allowSamePatientDay && raw.allowPatientOverlap)
      ? await runWithRls(actor.tenantId, (tx) =>
          checkPatientOverlap(tx, {
            tenantId: actor.tenantId,
            patientId: data.patientId!,
            start: data.scheduledFor,
            end,
            excludeKey: clientKey,
          })
        )
      : null;
  // A turno at the EXACT same instant is structurally impossible — the
  // partial unique index (tenant, patient, scheduledFor) rejects it. Say so
  // up front instead of offering a confirmation that can never succeed
  // (the batch path reports this same case as "duplicado").
  if (pat?.sameInstant) return { ok: false, error: SAME_INSTANT_ERROR };

  // B3.1: avisos blandos de agenda, en la precedencia del motor (bloqueado >
  // fuera de horario) y ANTES de los del paciente/cupo: si el horario no se va
  // a usar, preguntar por el paciente o el cupo es ruido.
  if (cls.blocked && !raw.allowBlocked) {
    const [practitionerName, nextFreeISO] = await Promise.all([nameOf(), suggest()]);
    return {
      ok: false,
      error: BLOCKED_ERROR(cls.blockReason),
      blocked: { practitionerName, reason: cls.blockReason, nextFreeISO },
    };
  }
  if (cls.outOfHours && !raw.allowOutOfHours) {
    const [practitionerName, nextFreeISO] = await Promise.all([nameOf(), suggest()]);
    return { ok: false, error: OUT_OF_HOURS_ERROR, outOfHours: { practitionerName, nextFreeISO } };
  }

  if (pat) {
    if (!raw.allowPatientOverlap && pat.overlapISO) {
      return {
        ok: false,
        error: "El paciente ya tiene un turno que se superpone con ese horario.",
        patientOverlap: { existingISO: pat.overlapISO },
      };
    }
    if (!raw.allowSamePatientDay && pat.sameDayStarts.length > 0) {
      return {
        ok: false,
        error: "El paciente ya tiene un turno hoy.",
        samePatientDay: {
          count: pat.sameDayStarts.length,
          existingISO: pat.sameDayStarts[0].toISOString(),
        },
      };
    }
  }

  // Telemedicina (decisión 9): la URL solo se guarda con el flag.
  const isTelemedicine = data.isTelemedicine ?? false;
  const telemedicineUrl = isTelemedicine ? (data.telemedicineUrl ?? null) : null;

  // Auto-fill the per-turno mini-diagnóstico from the patient's default when
  // the caller didn't provide an explicit title/description. S07sb: también
  // cuando el actor no puede escribirlos (Secretaria) — el diagnóstico es del
  // paciente, no lo escribe el actor, y el kine lo ve en su turno.
  const title = own.title ?? patientDiag?.diagnosisTitle ?? null;
  const description = own.description ?? patientDiag?.diagnosisNote ?? null;

  // Idempotency (clientKey resolved above): a double-submit / retry that shares
  // the SAME key collapses to one row via the @unique column; a *deliberate*
  // new turno (fresh modal → new key) gets its own row. This replaced the old
  // deterministic patient+slot key, which silently OVERWROTE an existing turno
  // when the same patient was re-booked at the same instant (the reported data
  // loss — now hard-blocked earlier by the patient-day guard). No client key
  // (or a malformed one) → random. NOTE: this dedups submits that share a key
  // (retry / double-click of ONE modal); two genuinely-concurrent submits from
  // DIFFERENT modal instances (two tabs / two users) carry different keys, so
  // the exact-slot case is caught by the partial unique index (P2002 →
  // resolveUniqueViolation), not the @unique column.
  const idempotencyKey = clientKey ?? randomBytes(16).toString("hex");

  try {
    // upsert on the unique idempotencyKey is atomic (Postgres ON CONFLICT):
    // a same-key retry collapses to one row. `update` resets the mutable
    // fields so a re-book of the same patient+slot (e.g. after cancelling)
    // converges to a single fresh active turno instead of returning a stale one.
    const w = await runWithRls(actor.tenantId, async (tx) => {
      // The key is CLIENT-supplied and globally @unique: with BYPASSRLS (prod)
      // a key that belongs to ANOTHER tenant's row would make the upsert's
      // `update` branch overwrite that row. Refuse it. (Under RLS the row is
      // invisible here and the ON CONFLICT update fails the policy instead.)
      const holder = await tx.booking.findUnique({
        where: { idempotencyKey },
        select: { tenantId: true },
      });
      if (holder && holder.tenantId !== actor.tenantId) return { kind: "foreign-key" as const };

      // Overlap capacity check, scoped to the SAME practitioner + SAME service.
      // Overlaps are allowed up to the cupo (null = ilimitado, el caso normal
      // en kinesiología: varios pacientes en paralelo en la franja). An expired
      // unpaid public reservation no longer holds the slot. B3.1: el cupo es el
      // efectivo del profesional (`PractitionerService.concurrencyOverride`) o
      // `Service.maxConcurrent` — con el backfill, el mismo de antes.
      // B3.1 (TOCTOU): el conteo y el upsert van en ESTE tx, detrás del lock de
      // cupo del día. Antes el conteo corría en otro tx y dos altas
      // simultáneas de pacientes distintos en un cupo 1 pasaban las dos.
      await lockCapacityWindow(tx, {
        tenantId: actor.tenantId,
        practitionerId: data.practitionerId,
        serviceId: service.id,
        start: data.scheduledFor,
        end,
      });
      // Integrador final de B-pre: re-chequeo de bloqueos con el lock de cupo
      // ya tomado (`liveBlocksInTx`). `cls` se calculó en otro tx: un candado
      // commiteado en el medio solo se ve acá. Bloqueado y sin forzar → el
      // mismo aviso `blocked` de antes; forzado → sobreturno (decisión 1).
      const live = classifyForWrite(
        {
          ...input,
          blocks: await liveBlocksInTx(tx, {
            tenantId: actor.tenantId,
            practitionerId: data.practitionerId,
            start: data.scheduledFor,
            end,
          }),
        },
        clsArgs
      );
      if (live.blocked && !raw.allowBlocked) return { kind: "blocked" as const, reason: live.blockReason };
      const overlapCount = await countCapacityOverlaps(tx, {
        tenantId: actor.tenantId,
        practitionerId: data.practitionerId,
        serviceId: service.id,
        start: data.scheduledFor,
        end,
        now,
        excludeKey: clientKey,
      });
      const capacityReached = overlapBlocks(overlapCount, rule.cap);
      // Sin escribir: la UI ofrece el próximo libre o re-llamar con
      // allowOverbooking=true para forzar el sobreturno.
      if (capacityReached && !raw.allowOverbooking) return { kind: "conflict" as const };

      // Sobreturno = cupo lleno forzado o bloqueo forzado (decisión 1). B3.1:
      // `isOverbooked` (M-agenda) es la fuente; el prefijo "[SOBRETURNO]" en
      // notes se sigue escribiendo hasta el contract posterior a B-pre.
      const overbooked = capacityReached || live.blocked;
      const notes = overbooked ? `[SOBRETURNO] ${own.notes ?? ""}`.trim() : own.notes;

      // Sede: lock compartido + activa, en el MISMO tx que el upsert (carrera
      // con archiveLocation). Elegida y ya archivada → rechazo; la de por
      // defecto archivada en el medio → null (= principal).
      let loc = locationId;
      if (loc && !(await lockActiveLocation(tx, actor.tenantId, loc))) {
        if (data.locationId) return { kind: "bad-location" as const };
        loc = null;
      }
      const row = await tx.booking.upsert({
        where: { idempotencyKey },
        update: {
          serviceId: service.id,
          durationMin: duration,
          copagoCents,
          notes,
          isOverbooked: overbooked,
          locationId: loc,
          isTelemedicine,
          telemedicineUrl,
          status: data.patientId ? "CONFIRMED" : "PENDING",
          guestName: data.guestName,
          guestEmail: data.guestEmail,
          guestPhone: data.guestPhone,
        },
        create: {
          tenantId: actor.tenantId,
          practitionerId: data.practitionerId,
          serviceId: service.id,
          scheduledFor: data.scheduledFor,
          durationMin: duration,
          copagoCents,
          patientId: data.patientId,
          guestName: data.guestName,
          guestEmail: data.guestEmail,
          guestPhone: data.guestPhone,
          notes,
          isOverbooked: overbooked,
          locationId: loc,
          isTelemedicine,
          telemedicineUrl,
          title,
          description,
          status: data.patientId ? "CONFIRMED" : "PENDING",
          idempotencyKey,
        },
      });
      return { kind: "ok" as const, row };
    });
    if (w.kind === "conflict") {
      const [practitionerName, suggestion] = await Promise.all([nameOf(), suggest()]);
      return {
        ok: false,
        error: "El profesional ya tiene un turno en ese horario. Podés elegir el próximo libre o forzar un sobreturno.",
        conflict: { practitionerName, nextFreeISO: suggestion },
      };
    }
    if (w.kind === "blocked") {
      const [practitionerName, nextFreeISO] = await Promise.all([nameOf(), suggest()]);
      return {
        ok: false,
        error: BLOCKED_ERROR(w.reason),
        blocked: { practitionerName, reason: w.reason, nextFreeISO },
      };
    }
    if (w.kind === "foreign-key") return { ok: false, error: "No pudimos crear el turno." };
    if (w.kind === "bad-location") return { ok: false, error: BAD_LOCATION_ERROR };
    const b = w.row;
    await audit({
      tenantId: actor.tenantId,
      actorId: actor.userId ?? undefined,
      action: "booking.create",
      entity: "Booking",
      entityId: b.id,
    });
    if (actor.userId) {
      let who: string;
      if (data.patientId) {
        const p = await runWithRls(actor.tenantId, (tx) => tx.patient.findFirst({
          where: { id: data.patientId, tenantId: actor.tenantId },
          select: { firstName: true, lastName: true },
        }));
        who = p ? `${p.firstName} ${p.lastName}` : "Paciente";
      } else {
        who = data.guestName ?? "Reserva externa";
      }
      await notify({
        tenantId: actor.tenantId,
        userId: actor.userId,
        kind: NotificationKind.BOOKING_CREATED,
        title: `Nuevo turno · ${who}`,
        body: data.scheduledFor.toLocaleString("es-AR", {
          weekday: "short",
          day: "2-digit",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeZone: "America/Argentina/Buenos_Aires",
        }),
        link: `/agenda?date=${toARDateKey(data.scheduledFor)}`,
      });
    }
    revalidatePath("/agenda");
    revalidatePath("/dashboard");
    if (data.patientId) revalidatePath(`/pacientes/${data.patientId}`);
    invalidateBookingDerivedCaches(actor.tenantId);
    return { ok: true, data: { id: b.id } };
  } catch (e) {
    // The partial unique index (tenant+patient+slot, non-cancelled) is the
    // race-free backstop for the patient-day guard: a genuinely-concurrent
    // second create at the same slot loses the INSERT race here. Two
    // concurrent upserts with the SAME key can also cross on that index; that
    // one resolves to the row the other one wrote (idempotent success).
    const r = await resolveUniqueViolation(actor.tenantId, e, idempotencyKey);
    if (r.kind === "existing") return { ok: true, data: { id: r.id } };
    if (r.kind === "patient-slot") return { ok: false, error: SAME_INSTANT_ERROR };
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, error: "Turno duplicado." };
    }
    logger.error("booking.create.failed", { err: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: "No pudimos crear el turno." };
  }
}

// Devuelve la nueva versión (`updatedAt`) como los toggles de cobro: el
// caller (drawer, turnos-view, dashboard) la guarda y puede encadenar otra
// mutación sin recargar ni chocar con su propio lock (A2 integrador).
type UpdateBookingResult = ActionResult<{ updatedAt: Date }> & {
  conflict?: { practitionerName: string; nextFreeISO: string | null };
  patientOverlap?: { existingISO: string };
  // B3.1: mismos avisos blandos que createBooking (re-llamar con el flag).
  outOfHours?: BookingOutOfHoursPrompt;
  blocked?: BookingBlockedPrompt;
};

export async function updateBooking(
  raw: BookingUpdateInput & {
    allowOverbooking?: boolean;
    // Same flag as createBooking: the front desk confirmed the patient may
    // have two turnos overlapping (two services in parallel).
    allowPatientOverlap?: boolean;
    // B3.1: mismos flags que createBooking (decisiones 1 y 2).
    allowOutOfHours?: boolean;
    allowBlocked?: boolean;
    expectedUpdatedAt?: string;
  }
): Promise<UpdateBookingResult> {
  const actor = await getActor();
  const parsed = BookingUpdate.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Datos inválidos", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const { id, locationId: patchLocationId, isTelemedicine: patchTele, telemedicineUrl: patchTeleUrl, ...patch } =
    parsed.data;
  const now = new Date();

  // Ownership lookup + optimistic-concurrency check + access + patient re-bind
  // validation + conflict re-check + the write, all under the tenant GUC in
  // one transaction. The prac-name + next-free suggestion (read-only,
  // advisory) are fetched outside on conflict.
  const outcome = await runWithRls(actor.tenantId, async (tx) => {
    const before = await tx.booking.findFirst({
      where: { id, tenantId: actor.tenantId },
      select: {
        id: true,
        patientId: true,
        status: true,
        scheduledFor: true,
        durationMin: true,
        practitionerId: true,
        serviceId: true,
        locationId: true,
        isTelemedicine: true,
        service: { select: { id: true, durationMin: true, maxConcurrent: true, practitionerId: true } },
        updatedAt: true,
        // S07sb: regla de re-vínculo sin `clinical.read` (¿trae algo clínico?).
        title: true,
        description: true,
        notes: true,
        patient: { select: { firstName: true, lastName: true } },
      },
    });
    if (!before) return { kind: "notfound" as const };
    // Optimistic concurrency: reject if the row changed since the client
    // (e.g. the BookingDrawer) loaded it — prevents acting on a stale view.
    if (raw.expectedUpdatedAt && +before.updatedAt !== +new Date(raw.expectedUpdatedAt)) {
      return { kind: "stale" as const };
    }
    // E1 (S07sb, contrato Secretaria de C8): operar = full ||
    // `agenda.operateAll`. Acceso básico sin operateAll (PRACTITIONER ajeno,
    // BILLING) = solo ver: ni estado, ni reprogramar, ni notas. S07c mueve
    // este gate ADENTRO de `applyBookingUpdateInTx`, no al wrapper.
    const caps = lazyCapsInTx(tx, actor);
    const gate = await bookingGateInTx(tx, actor, before.patientId, caps);
    if (!gate.canOperate) return { kind: "basic" as const };
    // Tenant-scope + access check on the re-bound patient (`undefined` = leave
    // alone) — atomic with the update. S07sb: el destino pasa por el MISMO
    // gate (no `hasFullAccess`): la Secretaria asigna paciente a un guest.
    const patientChanged = patch.patientId !== undefined && patch.patientId !== before.patientId;
    let fields = gate.fields;
    if (patientChanged) {
      const owned = await tx.patient.findFirst({
        where: { id: patch.patientId, tenantId: actor.tenantId },
        select: { id: true },
      });
      if (!owned) return { kind: "foreign-patient" as const };
      const target = await bookingGateInTx(tx, actor, owned.id, caps);
      if (!target.canOperate) return { kind: "basic" as const };
      // Sin `clinical.read`: guest → paciente sí; paciente → paciente solo si
      // el turno no trae nada clínico (lo arrastraría a otra HC sin verlo).
      if (!gate.clinical && before.patientId && hasClinicalText(before)) {
        return { kind: "clinical-relink" as const };
      }
      // Escribible solo si lo es antes Y después del re-vínculo: la nota de
      // un guest (del staff) pasa a ser de un paciente (clínica).
      fields = intersectFields(gate.fields, target.fields);
    }
    // Lo que el actor no lee no se escribe ni se audita (E1).
    const written = writableFields(patch, fields);

    // Parity with createBooking (A2a-S06). Before, only a slot MOVE re-checked
    // capacity: lengthening the turno or reactivating a CANCELLED one over a
    // full cupo went through silently, and the patient's own overlap was never
    // looked at on edit.
    const newWhen = patch.scheduledFor ?? before.scheduledFor;
    const newDuration = patch.durationMin ?? before.durationMin;
    const end = new Date(newWhen.getTime() + newDuration * 60_000);
    // Guest (nace PENDING) al que se le asigna paciente → CONFIRMED, paridad con
    // createBooking con paciente (revisión A2). Antes quedaba PENDING/UNPAID
    // con paciente: idéntico a una reserva pública, "vencía" a los 30 min y
    // liberaba el cupo. Solo si el patch no pide otro estado.
    const promoteGuest =
      before.patientId == null && patch.patientId != null && (patch.status ?? before.status) === "PENDING";
    const finalStatus = promoteGuest ? "CONFIRMED" : (patch.status ?? before.status);
    const finalPatientId = patch.patientId ?? before.patientId;
    const slotChanged = patch.scheduledFor != null && +patch.scheduledFor !== +before.scheduledFor;
    const durationChanged = patch.durationMin != null && patch.durationMin !== before.durationMin;
    const reactivating = before.status === "CANCELLED" && finalStatus !== "CANCELLED";
    const windowChanged = slotChanged || durationChanged || reactivating;
    const locationChanged = patchLocationId !== undefined && patchLocationId !== before.locationId;

    // B3.1: lo que la edición escribe además del patch. `undefined` = no se toca.
    let newLocationId: string | null | undefined = undefined;
    let isOverbooked: boolean | undefined = undefined;
    let cap: number | null = before.service.maxConcurrent;

    if (finalStatus !== "CANCELLED") {
      const pat =
        finalPatientId && (windowChanged || patientChanged)
          ? await checkPatientOverlap(tx, {
              tenantId: actor.tenantId,
              patientId: finalPatientId,
              start: newWhen,
              end,
              excludeId: id,
            })
          : null;
      if (pat?.sameInstant) return { kind: "patient-slot" as const };

      // B3.1: franjas y bloqueos (motor), solo si cambia el horario o la sede
      // — editar notas de un turno ya cargado fuera de horario no re-pregunta.
      // Reactivar un CANCELLED también re-pregunta (p. ej. lo canceló un
      // candado de día). Sede de la clasificación: la elegida; si se mueve de
      // horario sin elegir, cualquiera (y se recalcula la de por defecto); si
      // no, la que ya tenía.
      let blocked = false;
      if (windowChanged || locationChanged) {
        // Integrador final de B-pre: el lock de cupo de los días del horario
        // NUEVO se toma ANTES de cargar franjas/bloqueos (antes se tomaba recién
        // para contar el cupo): así la carga de bloqueos de abajo ya ve un
        // `applyDayLock` commiteado en el medio, que toma el mismo lock (ver
        // `liveBlocksInTx`). También con solo cambio de sede: un bloqueo de la
        // sede nueva entra por el mismo camino. Mismo orden de locks: cupo →
        // sedes (`lockActiveLocation` más abajo).
        await lockCapacityWindow(tx, {
          tenantId: actor.tenantId,
          practitionerId: before.practitionerId,
          serviceId: before.serviceId,
          start: newWhen,
          end,
        });
        const rule = await practitionerServiceRule(tx, actor.tenantId, before.practitionerId, before.service);
        cap = rule.cap;
        const input = await loadInstantAvailability(tx, {
          tenantId: actor.tenantId,
          practitionerId: before.practitionerId,
          serviceId: before.serviceId,
          start: newWhen,
          end,
        });
        const cls = classifyForWrite(input, {
          when: newWhen,
          durationMin: newDuration,
          practitionerId: before.practitionerId,
          serviceId: before.serviceId,
          locationId: patchLocationId ?? (slotChanged ? null : before.locationId),
          cap,
          now,
          excludeBookingId: id,
        });
        const prompt = { before, newWhen, newDuration, cap, finalPatientId };
        if (cls.blocked && !raw.allowBlocked) {
          return { kind: "blocked" as const, reason: cls.blockReason, ...prompt };
        }
        if (cls.outOfHours && !raw.allowOutOfHours) return { kind: "out-of-hours" as const, ...prompt };
        blocked = cls.blocked;
        if (patchLocationId === undefined && slotChanged) {
          newLocationId = defaultLocationFor(input, before.practitionerId, newWhen, newDuration);
        }
      }

      if (pat?.overlapISO && !raw.allowPatientOverlap) {
        return { kind: "patient-overlap" as const, existingISO: pat.overlapISO };
      }
      let capacityReached = false;
      if (windowChanged) {
        // B3.1 (TOCTOU): el lock de cupo de los días del horario NUEVO ya se
        // tomó arriba (antes de clasificar); el conteo y el update van en este
        // mismo tx.
        const overlapCount = await countCapacityOverlaps(tx, {
          tenantId: actor.tenantId,
          practitionerId: before.practitionerId,
          serviceId: before.serviceId,
          start: newWhen,
          end,
          now,
          excludeId: id,
        });
        capacityReached = overlapBlocks(overlapCount, cap);
        if (capacityReached && !raw.allowOverbooking) {
          return { kind: "conflict" as const, before, newWhen, newDuration, cap, finalPatientId };
        }
      }
      // B3.1: `isOverbooked` refleja el horario NUEVO: forzado (cupo o
      // bloqueo) → true; movido a un hueco libre → false. Sin cambio de
      // horario no se toca (salvo que un cambio de sede lo deje sobre un
      // bloqueo forzado). El prefijo "[SOBRETURNO]" de notes no se toca acá
      // (como antes: el update nunca lo escribió).
      if (windowChanged) isOverbooked = capacityReached || blocked;
      else if (blocked) isOverbooked = true;
    }

    // Sede elegida: lock compartido + activa en este tx (carrera con
    // archiveLocation); siempre, aunque el turno esté cancelado — la FK saltea
    // RLS. La de por defecto (reprogramación) archivada en el medio → no se toca.
    if (patchLocationId !== undefined) {
      if (!(await lockActiveLocation(tx, actor.tenantId, patchLocationId))) return { kind: "bad-location" as const };
      newLocationId = patchLocationId;
    } else if (newLocationId) {
      if (!(await lockActiveLocation(tx, actor.tenantId, newLocationId))) newLocationId = undefined;
    }

    // Telemedicina: `isTelemedicine: false` borra la URL; la URL solo se
    // guarda si el turno queda como telemedicina.
    const finalTele = patchTele ?? before.isTelemedicine;
    const tele: Prisma.BookingUncheckedUpdateInput = {
      ...(patchTele !== undefined ? { isTelemedicine: patchTele } : {}),
      ...(!finalTele
        ? patchTele === false
          ? { telemedicineUrl: null }
          : {}
        : patchTeleUrl !== undefined
          ? { telemedicineUrl: patchTeleUrl }
          : {}),
    };

    // `updatedAt` in the where makes the optimistic lock atomic: a concurrent
    // write between the read above and here → P2025 → "stale" (below), instead
    // of last-write-wins.
    const after = await tx.booking.update({
      where: { id, tenantId: actor.tenantId, updatedAt: before.updatedAt },
      data: {
        ...written,
        ...(promoteGuest ? { status: "CONFIRMED" as const } : {}),
        ...(newLocationId !== undefined ? { locationId: newLocationId } : {}),
        ...(isOverbooked !== undefined ? { isOverbooked } : {}),
        ...tele,
      },
      select: { updatedAt: true },
    });
    return { kind: "ok" as const, before, updatedAt: after.updatedAt, written };
  }).catch((e) => {
    // A reschedule that lands the turno on a slot the SAME patient already
    // occupies trips the partial unique index (patient+slot, non-cancelled) —
    // the only unique an update can hit (idempotencyKey is never patched), so
    // a P2002 here means that even when RLS hides `meta.target`.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { kind: "patient-slot" as const };
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      return { kind: "stale" as const };
    }
    throw e;
  });

  if (outcome.kind === "notfound") return { ok: false, error: "Turno no encontrado." };
  if (outcome.kind === "basic") return { ok: false, error: BASIC_ACCESS_ERROR };
  if (outcome.kind === "clinical-relink") return { ok: false, error: CLINICAL_RELINK_ERROR };
  if (outcome.kind === "patient-slot") {
    return {
      ok: false,
      error:
        "El paciente ya tiene un turno que se superpone con ese horario: arranca exactamente a esa hora. Movelo aunque sea unos minutos.",
    };
  }
  if (outcome.kind === "patient-overlap") {
    return {
      ok: false,
      error: "El paciente ya tiene un turno que se superpone con ese horario.",
      patientOverlap: { existingISO: outcome.existingISO },
    };
  }
  if (outcome.kind === "stale") return { ok: false, error: STALE_ERROR };
  if (outcome.kind === "foreign-patient") return { ok: false, error: "Paciente fuera del consultorio." };
  if (outcome.kind === "bad-location") return { ok: false, error: BAD_LOCATION_ERROR };
  if (outcome.kind === "conflict" || outcome.kind === "blocked" || outcome.kind === "out-of-hours") {
    const [practitionerName, nextFreeISO] = await Promise.all([
      runWithRls(actor.tenantId, (tx) => practitionerLabel(tx, actor.tenantId, outcome.before.practitionerId)),
      suggestNextFreeSlot(actor.tenantId, {
        practitionerId: outcome.before.practitionerId,
        serviceId: outcome.before.serviceId,
        from: outcome.newWhen,
        durationMin: outcome.newDuration,
        cap: outcome.cap,
        patientId: outcome.finalPatientId,
        locationId: patchLocationId ?? null,
        excludeBookingId: id,
      }),
    ]);
    if (outcome.kind === "blocked") {
      return {
        ok: false,
        error: BLOCKED_ERROR(outcome.reason),
        blocked: { practitionerName, reason: outcome.reason, nextFreeISO },
      };
    }
    if (outcome.kind === "out-of-hours") {
      return { ok: false, error: OUT_OF_HOURS_ERROR, outOfHours: { practitionerName, nextFreeISO } };
    }
    return {
      ok: false,
      error: "El profesional ya tiene un turno en ese horario.",
      conflict: { practitionerName, nextFreeISO },
    };
  }

  const before = outcome.before;
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "booking.update",
    entity: "Booking",
    entityId: id,
    // El patch YA filtrado (S07sb): un campo sacado no aparece ni en el audit.
    payload: outcome.written as Record<string, unknown>,
  });
  // Surface status transitions in the bell.
  if (patch.status && patch.status !== before.status && actor.userId) {
    const who = before.patient
      ? `${before.patient.firstName} ${before.patient.lastName}`
      : "Reserva externa";
    const niceWhen = before.scheduledFor.toLocaleString("es-AR", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "America/Argentina/Buenos_Aires",
    });
    if (patch.status === "CANCELLED") {
      await notify({
        tenantId: actor.tenantId,
        userId: actor.userId,
        kind: NotificationKind.BOOKING_CANCELLED,
        title: `Turno cancelado · ${who}`,
        body: niceWhen,
        link: `/agenda?date=${toARDateKey(before.scheduledFor)}`,
      });
    } else if (patch.status === "NO_SHOW") {
      await notify({
        tenantId: actor.tenantId,
        userId: actor.userId,
        kind: NotificationKind.BOOKING_CANCELLED,
        title: `Ausente · ${who}`,
        body: niceWhen,
        link: `/agenda?date=${toARDateKey(before.scheduledFor)}`,
      });
    }
  }
  revalidatePath("/agenda");
  revalidatePath("/dashboard");
  if (before.patientId) revalidatePath(`/pacientes/${before.patientId}`);
  if (patch.patientId && patch.patientId !== before.patientId) {
    revalidatePath(`/pacientes/${patch.patientId}`);
  }
  invalidateBookingDerivedCaches(actor.tenantId);
  return { ok: true, data: { updatedAt: outcome.updatedAt } };
}

/**
 * Status change = an `updateBooking` with only `status`. Reactivating a
 * CANCELLED turno re-checks capacity and the patient's own overlap (A2a-S06),
 * so the result can carry `conflict` / `patientOverlap` like a reschedule; the
 * caller re-sends with the matching `allow*` flag to force it.
 */
export async function setBookingStatus(
  id: string,
  status: BookingStatus,
  expectedUpdatedAt?: string,
  // B5.7: `ForceFlags` (incluye allowOutOfHours / allowBlocked de B3.1, que ya
  // se esparcían a updateBooking pero el tipo no lo decía).
  force?: ForceFlags
): Promise<UpdateBookingResult> {
  // Revisión A2: volver a PENDING no es una transición de la agenda (ver
  // BookingUpdate). La firma sigue aceptando `BookingStatus` por los callers.
  if (status === "PENDING") return { ok: false, error: "Datos inválidos" };
  return updateBooking({ id, status, expectedUpdatedAt, ...force });
}

const RECEPTION_FORBIDDEN_ERROR = "No tenés permiso para operar la recepción.";
const RECEPTION_OTHER_PRACTITIONER_ERROR =
  "Solo podés marcar la recepción de tus turnos o de pacientes que tenés a cargo.";

/**
 * Recepción (B4.1; decisión 3 de B-pre: timestamps, no BookingStatus nuevos).
 * Una sola action para las cinco acciones de la sala de espera — llegó, en
 * atención, atendido, ausente, deshacer — porque la transición válida depende
 * del estado ACTUAL de la fila, no del botón: `applyReceptionAction`
 * (lib/reception-state.ts, puro) la valida y arma el patch, y acá se escribe
 * en una tx con el lock optimista atómico (`where { id, tenantId, updatedAt }`
 * → P2025 = stale), así dos personas marcando el mismo turno no pisan una a la
 * otra ("Llegó" y "Ausente" con la misma versión: gana una).
 *
 * Autorización: capability `agenda.reception` (OWNER, ADMIN, PRACTITIONER,
 * ASSISTANT; no BILLING). DECISIÓN B4.1: la recepción es ADMINISTRATIVA, así
 * que NO exige acceso `full` al paciente (a diferencia de `setBookingStatus`):
 * la Secretaria (ASSISTANT) tiene acceso básico a casi todos los pacientes y
 * su trabajo es justamente marcar llegadas y ausentes. No expone ni toca
 * contenido clínico; el turno tiene que ser del tenant (IDOR) y guest ok.
 * Revisión de B-pre: sin `agenda.manageBlocks` (= PRACTITIONER, el rol que no
 * opera la agenda de todos) solo sus turnos o los de pacientes con acceso
 * `full` (guest ok): si no, un profesional podía marcar ausente a pacientes
 * de un colega que ni ve. La Secretaria y el admin siguen operando todo.
 * "Atendido"/"Ausente" escriben `status` (COMPLETED / NO_SHOW) igual que el
 * drawer; deshacer vuelve al status de origen (`undoStatus`: PENDING para
 * guest y reserva pública impaga, CONFIRMED el resto). `expectedUpdatedAt`
 * es obligatorio.
 *
 * Devuelve el `updatedAt` nuevo (ISO) para el próximo click sin refetch.
 */
export async function markReceptionAction(
  bookingId: string,
  action: ReceptionAction,
  expectedUpdatedAt: string
): Promise<ActionResult<ReceptionActionResult>> {
  let actor: Actor;
  let caps: ReadonlySet<Capability>;
  try {
    ({ actor, caps } = await requireCapability("agenda.reception", RECEPTION_FORBIDDEN_ERROR));
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, error: e.message };
    throw e;
  }
  const parsed = ReceptionActionInput.safeParse({ bookingId, action, expectedUpdatedAt });
  if (!parsed.success) {
    return { ok: false, error: "Datos inválidos", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const input = parsed.data;
  const expected = new Date(input.expectedUpdatedAt);
  const now = new Date();

  const outcome = await runWithRls(actor.tenantId, async (tx) => {
    const row = await tx.booking.findFirst({
      where: { id: input.bookingId, tenantId: actor.tenantId },
      select: {
        id: true,
        scheduledFor: true,
        durationMin: true,
        status: true,
        arrivedAt: true,
        attendingAt: true,
        updatedAt: true,
        patientId: true,
        practitionerId: true,
        // `undoStatus`: guest / reserva pública impaga vuelven a PENDING.
        paymentStatus: true,
        idempotencyKey: true,
        patient: { select: { firstName: true, lastName: true } },
      },
    });
    if (!row) return { kind: "notfound" as const };
    if (
      !caps.has("agenda.manageBlocks") &&
      row.practitionerId !== actor.practitionerId &&
      !(await hasFullAccess(actor, row.patientId, tx))
    ) {
      return { kind: "forbidden" as const };
    }
    if (+row.updatedAt !== +expected) return { kind: "stale" as const };
    const t = applyReceptionAction(row, input.action, now);
    if (!t.ok) return { kind: "invalid" as const, error: t.error };
    const after = await tx.booking.update({
      where: { id: row.id, tenantId: actor.tenantId, updatedAt: row.updatedAt },
      data: t.patch,
      select: { updatedAt: true, status: true, arrivedAt: true, attendingAt: true },
    });
    return { kind: "ok" as const, row, transition: t, after };
  }).catch((e) => {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      return { kind: "stale" as const };
    }
    throw e;
  });

  if (outcome.kind === "notfound") return { ok: false, error: "Turno no encontrado." };
  if (outcome.kind === "forbidden") return { ok: false, error: RECEPTION_OTHER_PRACTITIONER_ERROR };
  if (outcome.kind === "stale") return { ok: false, error: STALE_ERROR };
  if (outcome.kind === "invalid") return { ok: false, error: outcome.error };

  const { row, transition, after } = outcome;
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: `booking.reception.${input.action}`,
    entity: "Booking",
    entityId: row.id,
    payload: { from: transition.from, to: transition.to, label: RECEPTION_ACTION_LABEL[input.action] },
  });
  // Paridad con el drawer (`updateBooking`): un "Ausente" sale en la campana.
  if (transition.patch.status === "NO_SHOW" && actor.userId) {
    await notify({
      tenantId: actor.tenantId,
      userId: actor.userId,
      kind: NotificationKind.BOOKING_CANCELLED,
      title: `Ausente · ${row.patient ? `${row.patient.firstName} ${row.patient.lastName}` : "Reserva externa"}`,
      body: row.scheduledFor.toLocaleString("es-AR", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "America/Argentina/Buenos_Aires",
      }),
      link: `/agenda?date=${toARDateKey(row.scheduledFor)}`,
    });
  }
  revalidatePath("/agenda");
  if (transition.patch.status) {
    // El estado (atendido/ausente) cuenta en el dashboard y en la ficha.
    revalidatePath("/dashboard");
    if (row.patientId) revalidatePath(`/pacientes/${row.patientId}`);
    invalidateBookingDerivedCaches(actor.tenantId);
  }
  return {
    ok: true,
    data: {
      updatedAt: after.updatedAt.toISOString(),
      status: after.status,
      arrivedAt: after.arrivedAt?.toISOString() ?? null,
      attendingAt: after.attendingAt?.toISOString() ?? null,
      state: transition.to,
    },
  };
}

export async function deleteBooking(
  id: string,
  expectedUpdatedAt?: string
): Promise<ActionResult> {
  const actor = await getActor();
  // RLS Etapa 2: lookup + delete share the tx so policies guard the
  // destructive side too. The optimistic-concurrency check rejects a delete
  // when the row changed since the client loaded it.
  const outcome = await runWithRls(actor.tenantId, async (tx) => {
    const row = await tx.booking.findFirst({
      where: { id, tenantId: actor.tenantId },
      select: {
        id: true,
        patientId: true,
        updatedAt: true,
        paymentStatus: true,
        insurerPaidAt: true,
        payment: { select: { status: true } },
      },
    });
    if (!row) return { kind: "notfound" as const };
    if (expectedUpdatedAt && +row.updatedAt !== +new Date(expectedUpdatedAt)) {
      return { kind: "stale" as const };
    }
    if (!(await hasFullAccess(actor, row.patientId, tx))) return { kind: "basic" as const };
    // Payment FK is onDelete: Restrict, so a paid turno can't be silently
    // wiped. Refuse the delete if a real payment is attached; for an
    // abandoned checkout (UNPAID/FAILED) clean up the orphan payment first
    // so the Restrict constraint is satisfied.
    const pay = row.payment;
    if (pay && (pay.status === "AUTHORIZED" || pay.status === "PAID" || pay.status === "REFUNDED")) {
      return { kind: "has-payment" as const };
    }
    // H1: a copago collected BY HAND (Facturación toggle → paymentStatus, no
    // Payment row) or a confirmed obra social payment (insurerPaidAt) is a
    // money record too. Deleting the turno used to erase it with no trace.
    if (
      row.paymentStatus === "PAID" ||
      row.paymentStatus === "AUTHORIZED" ||
      row.paymentStatus === "REFUNDED" ||
      row.insurerPaidAt != null
    ) {
      return { kind: "has-billing" as const };
    }
    if (pay) {
      await tx.payment.delete({ where: { bookingId: id } });
    }
    // `updatedAt` in the where: a concurrent edit → P2025 → rollback (the
    // orphan-payment cleanup above too) → "stale".
    await tx.booking.delete({ where: { id, tenantId: actor.tenantId, updatedAt: row.updatedAt } });
    return { kind: "ok" as const, patientId: row.patientId };
  }).catch((e) => {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      return { kind: "stale" as const };
    }
    throw e;
  });
  if (outcome.kind === "notfound") return { ok: false, error: "Turno no encontrado." };
  if (outcome.kind === "stale") return { ok: false, error: STALE_ERROR };
  if (outcome.kind === "basic") return { ok: false, error: BASIC_ACCESS_ERROR };
  if (outcome.kind === "has-payment") {
    return {
      ok: false,
      error: "Este turno tiene un pago registrado. Cancelalo en vez de eliminarlo para conservar el comprobante.",
    };
  }
  if (outcome.kind === "has-billing") {
    return {
      ok: false,
      error: "Este turno tiene un cobro registrado (copago u OS): cancelalo en vez de eliminarlo.",
    };
  }
  const owned = { patientId: outcome.patientId };
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "booking.delete",
    entity: "Booking",
    entityId: id,
  });
  revalidatePath("/agenda");
  if (owned.patientId) revalidatePath(`/pacientes/${owned.patientId}`);
  invalidateBookingDerivedCaches(actor.tenantId);
  return { ok: true, data: undefined };
}

/**
 * Shared body of the two Facturación toggles (A2a-S06). Before: lookup and
 * update in two separate transactions, `where: { id }` only on the write, no
 * optimistic lock and no access check — a second quick toggle (or another
 * tab) silently overwrote the first, and a basic-access kine could mark a
 * foreign patient's copago as cobrado. Now: one transaction, tenant-scoped
 * write guarded by `updatedAt`, and the new `updatedAt` goes back to the
 * client so its next toggle isn't stale.
 */
async function toggleBilling(
  id: string,
  data: Prisma.BookingUpdateManyMutationInput,
  expectedUpdatedAt: string | undefined,
  action: string
): Promise<ActionResult<{ updatedAt: Date }>> {
  const actor = await getActor();
  const outcome = await runWithRls(actor.tenantId, async (tx) => {
    const row = await tx.booking.findFirst({
      where: { id, tenantId: actor.tenantId },
      select: { id: true, patientId: true, updatedAt: true },
    });
    if (!row) return { kind: "notfound" as const };
    if (expectedUpdatedAt && +row.updatedAt !== +new Date(expectedUpdatedAt)) {
      return { kind: "stale" as const };
    }
    if (!(await hasFullAccess(actor, row.patientId, tx))) return { kind: "basic" as const };
    const res = await tx.booking.updateMany({
      where: { id, tenantId: actor.tenantId, updatedAt: row.updatedAt },
      data,
    });
    if (res.count === 0) return { kind: "stale" as const };
    const after = await tx.booking.findFirst({
      where: { id, tenantId: actor.tenantId },
      select: { updatedAt: true },
    });
    return { kind: "ok" as const, patientId: row.patientId, updatedAt: after!.updatedAt };
  });
  if (outcome.kind === "notfound") return { ok: false, error: "Turno no encontrado." };
  if (outcome.kind === "stale") return { ok: false, error: STALE_ERROR };
  if (outcome.kind === "basic") return { ok: false, error: BASIC_ACCESS_ERROR };
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action,
    entity: "Booking",
    entityId: id,
  });
  if (outcome.patientId) revalidatePath(`/pacientes/${outcome.patientId}`);
  invalidateBookingDerivedCaches(actor.tenantId);
  return { ok: true, data: { updatedAt: outcome.updatedAt } };
}

/**
 * Confirm / un-confirm that the obra social reimbursement for a turno was
 * received. Backs the "Confirmar pago Obra social" action in the patient's
 * Facturación tab. Tenant-scoped; `paid=false` clears the confirmation.
 * `expectedUpdatedAt` is optional only for legacy callers; the Facturación
 * tab always sends it and patches the returned `updatedAt`.
 */
export async function setBookingInsurerPaid(
  id: string,
  paid: boolean,
  expectedUpdatedAt?: string
): Promise<ActionResult<{ updatedAt: Date }>> {
  return toggleBilling(
    id,
    { insurerPaidAt: paid ? new Date() : null },
    expectedUpdatedAt,
    paid ? "booking.insurer_paid" : "booking.insurer_unpaid"
  );
}

/**
 * Mark a turno's copago as collected / pending (in-person payments) by
 * flipping `Booking.paymentStatus` between PAID and UNPAID. Complements the
 * OS confirmation so the Facturación tab tracks both sides. Same lock
 * contract as `setBookingInsurerPaid`.
 */
export async function setBookingCopagoPaid(
  id: string,
  paid: boolean,
  expectedUpdatedAt?: string
): Promise<ActionResult<{ updatedAt: Date }>> {
  return toggleBilling(
    id,
    { paymentStatus: paid ? "PAID" : "UNPAID" },
    expectedUpdatedAt,
    paid ? "booking.copago_paid" : "booking.copago_unpaid"
  );
}

/**
 * Multi-turno batch — creates N INDIVIDUAL bookings (turnos) on the chosen
 * weekdays, in Argentina time. NO TreatmentProgram/Session is created: these
 * are plain turnos. A future "plan" entity can regroup a batch via the shared
 * `seriesId` we stamp on every row.
 *
 * Model: the practitioner picks an anchor date+time (the slot time + where to
 * start), a set of weekdays (`daysOfWeek`, 0=Mon…6=Sun), and `count` (how many
 * turnos). We walk forward day-by-day from the anchor and emit a turno on each
 * matching weekday until we have `count` candidate dates. Example: anchor on a
 * Wednesday, count=3, days={Thu,Fri,Tue} → next Thu, Fri, Tue (Wed excluded).
 *
 * Day-of-week is read with `toARDow` (AR-local, correct on any host); the
 * +24h step preserves the AR wall-clock because Argentina has no DST. This
 * replaces the old createBookingSeries, which used UTC weekday math and put
 * turnos on the wrong days / next month.
 */
// `BatchSlotStatus` vive en lib/booking-schedule.ts (B1.6 S07); se re-exporta
// acá para no romper `import type { … } from "@/lib/bookings"` (solo tipo: un
// archivo "use server" no puede exportar valores que no sean funciones async).
export type { BatchSlotStatus } from "@/lib/booking-schedule";

export type BatchOutcome = {
  /** True when nothing was written (preflight). */
  dryRun: boolean;
  requested: number;
  /** B3.1: cada fecha trae además `outOfHours` / `blocked` (flags, no
   *  cambian `status` ni los conteos; un bloqueo ya sube el status a
   *  "sobreturno"). */
  dates: BatchDateOutcome[];
  free: number;
  conflicted: number;
  duplicates: number;
  /** Rows actually written (0 on a dry run). */
  created: number;
  /** How many of `created` were forced through as sobreturno. */
  sobreturnos: number;
  /** Conflicting slots deliberately left out (allowOverbooking = false). */
  omitted: number;
};

/**
 * Multi-turno batch with a PREFLIGHT mode.
 *
 * `dryRun: true` classifies every date without writing, so the UI can warn
 * ("3 de 10 caen como sobreturno") and let the user choose. Then:
 *   · `allowOverbooking: true`  → creates everything, tagging the conflicting
 *     rows `[SOBRETURNO]` + `isOverbooked` like the single-create path does.
 *   · `allowOverbooking: false` → creates only the free slots (an explicit
 *     choice now, not the silent skip it used to be).
 * `duplicado` slots are never creatable and are always reported separately.
 *
 * B3.1: fechas con `expandDates` del motor (`frequency` weekly — default,
 * paridad exacta con la expansión de antes, tope de 58 incluido — biweekly o
 * monthly) y clasificación con `classifyBatchInstant` (mismo status que
 * `classifyBatchSlot` sin bloqueos; un bloqueo lo sube a "sobreturno";
 * fuera de horario es solo el flag `outOfHours`, decisión 2). `count` validado
 * con zod (antes un NaN reventaba).
 */
export async function createBookingsBatch(
  raw: BookingBatchCreateInput & {
    idempotencyKey?: string;
    dryRun?: boolean;
    allowOverbooking?: boolean;
  }
): Promise<ActionResult<BatchOutcome>> {
  const actor = await getActor();
  const parsed = BookingBatchCreate.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Datos inválidos", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const data = parsed.data;
  const { count } = data;
  // Ids de entrada validados contra el tenant ANTES de escribir (A2a-S06): el
  // paciente solo se usaba para leer el diagnóstico — si era de otro tenant la
  // lectura daba null y el batch creaba igual N turnos apuntando a él (las FK
  // saltean RLS). Mismo contrato que createBooking: profesional del tenant y
  // paciente con acceso `full`. Un dryRun también se rechaza: el preflight
  // expone la ocupación del paciente. B3.1: + sede elegida y servicio
  // habilitado para el profesional (mismo rechazo que createBooking).
  const pre = await runWithRls(actor.tenantId, async (tx) => {
    const [patient, service, prac, location] = await Promise.all([
      data.patientId
        ? tx.patient.findFirst({
            where: { id: data.patientId, tenantId: actor.tenantId },
            select: { id: true, diagnosisTitle: true, diagnosisNote: true },
          })
        : Promise.resolve(null),
      tx.service.findFirst({
        where: { id: data.serviceId, tenantId: actor.tenantId },
        select: { id: true, name: true, durationMin: true, maxConcurrent: true, practitionerId: true },
      }),
      tx.practitioner.findFirst({
        where: { id: data.practitionerId, tenantId: actor.tenantId },
        select: { id: true },
      }),
      data.locationId
        ? tx.location.findFirst({
            where: { id: data.locationId, tenantId: actor.tenantId, active: true },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);
    if (data.patientId && !patient) return { kind: "foreign-patient" as const };
    if (!prac) return { kind: "foreign-practitioner" as const };
    if (!service) return { kind: "bad-service" as const };
    if (data.locationId && !location) return { kind: "bad-location" as const };
    // E1 (S07sb): mismo gate que createBooking (también para el dryRun).
    const gate = await bookingGateInTx(tx, actor, patient?.id ?? null, lazyCapsInTx(tx, actor));
    if (!gate.canOperate) return { kind: "basic" as const };
    const rule = await practitionerServiceRule(tx, actor.tenantId, prac.id, service);
    if (!rule.enabled) return { kind: "service-disabled" as const, serviceName: service.name };
    return { kind: "ok" as const, patient, service, rule, gate };
  });
  if (pre.kind === "foreign-patient") return { ok: false, error: "Paciente fuera del tenant." };
  if (pre.kind === "foreign-practitioner") return { ok: false, error: "Profesional inválido." };
  if (pre.kind === "bad-service") return { ok: false, error: "Servicio inválido." };
  if (pre.kind === "bad-location") return { ok: false, error: BAD_LOCATION_ERROR };
  if (pre.kind === "basic") return { ok: false, error: BASIC_ACCESS_ERROR };
  if (pre.kind === "service-disabled") return { ok: false, error: SERVICE_DISABLED_ERROR(pre.serviceName) };
  const { service, rule, gate } = pre;
  const duration = data.durationMin ?? rule.durationMin;
  // E1 (S07sb): mismas reglas que createBooking — campos que el actor no lee
  // fuera, y su copago solo con full (si no, precedencia de lib/copago.ts).
  const own = writableFields(data, gate.fields);
  const copagoCents = gate.full ? (data.copagoCents ?? null) : null;

  // Diagnóstico por defecto del paciente para auto-completar title/description
  // de cada turno del batch cuando el caller no los envía.
  const patientDiag = pre.patient;
  const title = own.title ?? patientDiag?.diagnosisTitle ?? null;
  const description = own.description ?? patientDiag?.diagnosisNote ?? null;
  const isTelemedicine = data.isTelemedicine ?? false;
  const telemedicineUrl = isTelemedicine ? (data.telemedicineUrl ?? null) : null;

  // AR-correct date expansion. `data.scheduledFor` is a real instant tagged
  // -03:00 by `localToARIso` on the client. Empty weekday selection → repeat
  // on the anchor's own AR weekday. count ≥ 1 (zod) → al menos una fecha.
  const dates = expandDates({
    anchor: data.scheduledFor,
    count,
    daysOfWeek: data.daysOfWeek,
    frequency: data.frequency,
  });

  // Tag the batch so it can be regrouped into a "plan" later.
  const seriesId = randomBytes(12).toString("hex");
  // Per-slot idempotency base. Prefer the client's stable key (so a
  // double-submitted batch converges to the same turnos instead of
  // duplicating), else the fresh seriesId. Either way it's SCOPED to this
  // batch — it can never collide with a pre-existing single turno's key (the
  // old `tenant:prof:slot:patient` shape did, silently mapping onto it).
  const keyBase = acceptClientKey(raw.idempotencyKey) ?? seriesId;

  // Una carga para todo el rango (loader del motor): franjas, excepciones,
  // bloqueos y los turnos que pueden chocar — del profesional (cupo) o del
  // paciente (solape propio / duplicado), con 240 min hacia atrás.
  const last = dates[dates.length - 1];
  const input = await runWithRls(actor.tenantId, (tx) =>
    loadAvailabilityInputs(tx, {
      tenantId: actor.tenantId,
      practitionerIds: [data.practitionerId],
      serviceId: service.id,
      patientId: data.patientId,
      from: dayKeyOf(dates[0]),
      to: dayKeyOf(new Date(last.getTime() + duration * 60_000 - 1)),
    })
  );
  const now = new Date();
  const rangesFor = rangesForInput(input);

  const plan = dates.map((when) => {
    const c = classifyBatchInstant({
      when,
      durationMin: duration,
      patientId: data.patientId ?? null,
      practitionerId: data.practitionerId,
      serviceId: service.id,
      locationId: data.locationId ?? null,
      cap: rule.cap,
      rangesFor,
      blocks: input.blocks,
      bookings: input.bookings,
      now,
    });
    return {
      when,
      status: c.status,
      outOfHours: c.outOfHours,
      blocked: c.blocked,
      locationId: data.locationId ?? defaultLocationFor(input, data.practitionerId, when, duration),
    };
  });
  const free = plan.filter((p) => p.status === "libre").length;
  const conflicted = plan.filter((p) => p.status === "sobreturno").length;
  const duplicates = plan.filter((p) => p.status === "duplicado").length;
  const datesOut: BatchDateOutcome[] = plan.map((p) => ({
    iso: p.when.toISOString(),
    status: p.status,
    outOfHours: p.outOfHours,
    blocked: p.blocked,
  }));

  if (raw.dryRun) {
    return {
      ok: true,
      data: {
        dryRun: true,
        requested: count,
        dates: datesOut,
        free,
        conflicted,
        duplicates,
        created: 0,
        sobreturnos: 0,
        omitted: 0,
      },
    };
  }

  let created = 0;
  let sobreturnos = 0;
  let omitted = 0;
  let duplicatesHit = duplicates;

  for (const slot of plan) {
    const { when } = slot;
    // Never creatable — the DB index would reject it anyway.
    if (slot.status === "duplicado") continue;
    // Conflicting slot the caller chose NOT to force.
    if (slot.status === "sobreturno" && !raw.allowOverbooking) {
      omitted++;
      continue;
    }
    const idempotencyKey = `${keyBase}:${when.toISOString()}`;
    const end = new Date(when.getTime() + duration * 60_000);
    try {
      // Una tx por fecha (un P2002 aborta la tx entera; así cada fecha se
      // resuelve sola, como antes). B3.1 (TOCTOU): dentro, lock de cupo de los
      // días de ESTA fecha (en orden) y re-conteo: si entre el preflight y acá
      // alguien llenó el cupo, la fecha pasa a sobreturno (forzada solo con
      // allowOverbooking; si no, se omite).
      const w = await runWithRls(actor.tenantId, async (tx) => {
        await lockCapacityWindow(tx, {
          tenantId: actor.tenantId,
          practitionerId: data.practitionerId,
          serviceId: service.id,
          start: when,
          end,
        });
        // Integrador final de B-pre: re-chequeo de bloqueos con el lock tomado
        // (`liveBlocksInTx`): un candado commiteado después del preflight
        // vuelve la fecha sobreturno (= omitida sin allowOverbooking), igual
        // que si el preflight la hubiera visto bloqueada.
        const liveBlocked = classifyBatchInstant({
          when,
          durationMin: duration,
          patientId: null,
          practitionerId: data.practitionerId,
          serviceId: service.id,
          locationId: data.locationId ?? null,
          cap: rule.cap,
          rangesFor,
          blocks: await liveBlocksInTx(tx, {
            tenantId: actor.tenantId,
            practitionerId: data.practitionerId,
            start: when,
            end,
          }),
          bookings: [],
          now,
        }).blocked;
        const used = await countCapacityOverlaps(tx, {
          tenantId: actor.tenantId,
          practitionerId: data.practitionerId,
          serviceId: service.id,
          start: when,
          end,
          now,
          excludeKey: idempotencyKey,
        });
        const isOverbook = slot.status === "sobreturno" || liveBlocked || overlapBlocks(used, rule.cap);
        if (isOverbook && !raw.allowOverbooking) return { kind: "omitted" as const };
        // Sede: elegida o la de la franja de ese día; archivada en el medio →
        // la elegida omite la fecha, la de por defecto cae a null (= principal).
        let loc = slot.locationId;
        if (loc && !(await lockActiveLocation(tx, actor.tenantId, loc))) {
          if (data.locationId) return { kind: "omitted" as const };
          loc = null;
        }
        // Same tagging the single-create path uses, so reports can tell them apart.
        const notes = isOverbook ? `[SOBRETURNO] ${own.notes ?? ""}`.trim() : own.notes;
        await tx.booking.upsert({
          where: { idempotencyKey },
          update: {},
          create: {
            tenantId: actor.tenantId,
            practitionerId: data.practitionerId,
            serviceId: service.id,
            scheduledFor: when,
            durationMin: duration,
            copagoCents,
            patientId: data.patientId,
            guestName: data.guestName,
            guestEmail: data.guestEmail,
            guestPhone: data.guestPhone,
            notes,
            isOverbooked: isOverbook,
            locationId: loc,
            isTelemedicine,
            telemedicineUrl,
            title,
            description,
            status: data.patientId ? "CONFIRMED" : "PENDING",
            seriesId,
            idempotencyKey,
          },
        });
        return { kind: "ok" as const, isOverbook };
      });
      if (w.kind === "omitted") {
        omitted++;
        continue;
      }
      created++;
      if (w.isOverbook) sobreturnos++;
    } catch (e) {
      // A patient+instant collision that the preflight missed (someone else
      // booked it in between) is a DUPLICATE, not a mystery failure — the old
      // catch-all lumped it into "omitidos por conflicto" with no explanation.
      // Same resolver as the single-create path, so it also works under RLS
      // (`meta.target` null) and a same-key concurrent double submit of the
      // batch counts the slot as created instead of duplicated.
      const r = await resolveUniqueViolation(actor.tenantId, e, idempotencyKey);
      if (r.kind === "existing") {
        created++;
        if (slot.status === "sobreturno") sobreturnos++;
        continue;
      }
      if (r.kind === "patient-slot") {
        duplicatesHit++;
        continue;
      }
      logger.error("createBookingsBatch: slot creation failed", {
        tenantId: actor.tenantId,
        practitionerId: data.practitionerId,
        scheduledFor: when.toISOString(),
        err: e instanceof Error ? e.message : String(e),
      });
      omitted++;
    }
  }
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "booking.batch.create",
    entity: "Booking",
    payload: {
      created,
      sobreturnos,
      omitted,
      duplicates: duplicatesHit,
      requested: count,
      frequency: data.frequency,
      seriesId,
    },
  });
  revalidatePath("/agenda");
  if (data.patientId) revalidatePath(`/pacientes/${data.patientId}`);
  invalidateBookingDerivedCaches(actor.tenantId);
  return {
    ok: true,
    data: {
      dryRun: false,
      requested: count,
      dates: datesOut,
      free,
      conflicted,
      duplicates: duplicatesHit,
      created,
      sobreturnos,
      omitted,
    },
  };
}
