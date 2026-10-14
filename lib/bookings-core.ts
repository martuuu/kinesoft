import "server-only";

/**
 * Core de turnos server-only (S07c, ES2b P2.0; PLANES.md §10 y C8).
 *
 * Por qué existe: hasta S07c todo esto vivía como helpers privados de
 * `lib/bookings.ts` ("use server": no puede exportar nada que no sea una action
 * async) y el cuerpo de la tx de `updateBooking` estaba inline. Planes (P2.1,
 * S12 "este y los siguientes", S11e motor de planes, la sincronía turno↔sesión
 * de C4) necesita mover/editar un turno DENTRO de su propia tx, con los mismos
 * gates, avisos y locks que el drawer. Copiar el cuerpo habría dejado dos
 * caminos que divergen (el gate de la Secretaria salteado al "mover en serie",
 * el cupo contado distinto). Acá queda UNA implementación; `lib/bookings.ts`
 * solo envuelve: `getActor` → zod → `runWithRls(tx => core)` → traducir el
 * outcome → audit / notify / revalidate / `afterBookingsCommitted`.
 *
 * Extracción SIN cambio de comportamiento: mismas queries en el mismo orden
 * (los write-paths tienen techo estricto de statements, tests/perf/compare.ts)
 * y los mismos textos (`lib/bookings-constants.ts`). La prueba de paridad son
 * los tests `bookings-*`, `day-lock`, `patient-coverage` y `authz-matrix`, que
 * no se tocaron.
 *
 * Reglas de este módulo:
 *   - ninguna función abre su propia tx salvo las dos lecturas consultivas que
 *     ya lo hacían (`resolveUniqueViolation`, `suggestNextFreeSlot`: corren
 *     DESPUÉS de que la tx de escritura terminó o falló);
 *   - los `*InTx` DEVUELVEN `BookingChangeRef[]` y nunca llaman
 *     `afterBookingsCommitted` (enmienda Realtime): emitir adentro, con un
 *     rollback posterior, dejaría el cache/evento contra datos que no existen;
 *   - `tenantId` a mano en cada where (prod = BYPASSRLS);
 *   - `applyBookingUpdateInTx` nunca toma `lockPlanPatient` (C2: el lock del
 *     paciente del plan va siempre primero, lo toma el caller de Planes).
 */
import { NotificationKind, Prisma, type BookingStatus } from "@prisma/client";
import type { z } from "zod";
import { runWithRls } from "@/lib/rls";
import { isHoldingCapacity, overlapBlocks, patientDayStatus } from "@/lib/booking-capacity";
import {
  addDays,
  arWallOf,
  classifyInstant,
  dayKeyOf,
  defaultRoomFor,
  dayWindow,
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
import {
  capacityKeysForWindow,
  lockCapacityAndRoomsMany,
  lockCapacityWindow,
  roomKeysForWindow,
} from "@/lib/booking-cap-lock";
import { countRoomOverlapsInTx, lockActiveRoomInTx } from "@/lib/booking-rooms-internal";
import { patientAccessFor } from "@/lib/visibility";
import type { Actor } from "@/lib/session";
import { canOperateBooking, capabilitiesFor, type Capability, type PatientAccessLevel } from "@/lib/capabilities";
import { bookingFieldAccess, type BookingFieldAccess, type BookingFieldMode } from "@/lib/booking-field-access";
import { PLAN_KEY_PREFIX } from "@/lib/plans-constants";
import type { ForceFlags } from "@/lib/booking-force-flags";
import type { BookingChangeRef } from "@/lib/booking-events-internal";
import type { BookingUpdate } from "@/lib/validation";
import { completeSessionInTx, reopenSessionIfUntouchedInTx } from "@/lib/sessions-internal";
import { bookingHasMoney, priorPaidStamp, type PricingBooking } from "@/lib/plan-pricing";
import { planSessionOrdinal } from "@/lib/plan-display";
import { notify } from "@/lib/notifications-internal";
import { logger } from "@/lib/logger";
import { toARDateKey } from "@/lib/datetime-ar";
import { bookablePractitionerWhere } from "@/lib/practitioner-scope";
import {
  BAD_LOCATION_ERROR,
  BASIC_ACCESS_ERROR,
  SERVICE_DISABLED_ERROR,
} from "@/lib/bookings-constants";

export type Tx = Prisma.TransactionClient;

/**
 * IAM-4b: el `practitionerId` del turno no es reservable en este consultorio
 * (Secretaria/Facturación, membresía no aceptada o suspendida, o de otro
 * consultorio: el mismo texto para todos, sin oráculo). Vive acá y no en
 * `bookings-constants.ts` porque esa constante es de otra sesión de la ola.
 */
export const PRACTITIONER_NOT_BOOKABLE_ERROR = "Ese profesional no atiende en este consultorio.";

// ─────────────────────────────────────────────────────────────────────────────
// Guards de acceso compartidos por los write-paths (A2a-S06, E1/S07sb).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Con paciente, exige acceso `full`. Guest (sin paciente): `guestOperable`
 * (P0.Z, H-b3): BILLING no; la Secretaria y los kines, como hasta hoy.
 *
 * Planes E1 (S07sb): ya NO es el gate de create/batch/update/status/cancelar
 * (eso es `bookingGateInTx`). Queda para lo que sigue exigiendo full: borrar
 * el turno, los toggles de cobro (la matriz de cobros es de C0) y la recepción
 * de un PRACTITIONER sobre turnos ajenos.
 */
export async function hasFullAccess(actor: Actor, patientId: string | null, tx: Tx): Promise<boolean> {
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
export function guestOperable(caps: ReadonlySet<Capability>): boolean {
  return caps.has("agenda.operateAll") || caps.has("clinical.read");
}

/**
 * Capabilities del actor leídas DENTRO de la tx abierta. No se usa
 * `getMembershipRole` (lib/authz.ts) porque abre su propia `runWithRls`: desde
 * adentro de otra tx serían dos conexiones del pool a la vez por request.
 */
export async function actorCapsInTx(tx: Tx, actor: Actor): Promise<ReadonlySet<Capability>> {
  const m = await tx.membership.findUnique({
    where: { userId_tenantId: { userId: actor.userId, tenantId: actor.tenantId } },
    select: { role: true },
  });
  return capabilitiesFor(m?.role);
}

/** Lee las capabilities a lo sumo una vez por tx, y solo si hacen falta. */
export function lazyCapsInTx(tx: Tx, actor: Actor): () => Promise<ReadonlySet<Capability>> {
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
export type BookingGate = {
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
export async function bookingGateInTx(
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
export function intersectFields(a: BookingFieldAccess, b: BookingFieldAccess): BookingFieldAccess {
  const m = (x: BookingFieldMode, y: BookingFieldMode): BookingFieldMode => (x === "rw" && y === "rw" ? "rw" : "hidden");
  return { title: m(a.title, b.title), description: m(a.description, b.description), notes: m(a.notes, b.notes) };
}

/**
 * Saca del patch los campos de texto que el actor no puede leer (E1: "un campo
 * se escribe si y solo si se puede leer"). Va ANTES del write y del audit: el
 * drawer con los campos ocultos (null) mandaba vacíos y borraba el título de un
 * guest, o la Secretaria pisaba notas clínicas que no ve.
 */
export function writableFields<P extends { title?: string; description?: string; notes?: string }>(
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
export function hasClinicalText(b: { title: string | null; description: string | null; notes: string | null }): boolean {
  const notes = (b.notes ?? "").replace(/^\[SOBRETURNO\]/, "").trim();
  return !!(b.title?.trim() || b.description?.trim() || notes);
}

/**
 * Nombre del profesional para el aviso de conflicto. Del TENANT (antes era un
 * `findUnique` por id pelado) y nunca el email: el fallback es genérico.
 */
export async function practitionerLabel(tx: Tx, tenantId: string, practitionerId: string): Promise<string> {
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
export function acceptClientKey(k: unknown): string | null {
  if (typeof k !== "string" || k.length < 8 || k.length > 64) return null;
  if (k.startsWith("pub:") || k.startsWith(PLAN_KEY_PREFIX)) return null;
  return k;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cupo y guard del paciente (contrato de AUDIT §5: queries propias, no del motor).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cuántos turnos del MISMO profesional + servicio se superponen con
 * [start, end) y todavía sostienen el cupo (`isHoldingCapacity`: una reserva
 * pública impaga vencida ya no cuenta). Trae los candidatos de la ventana de
 * 240 min hacia atrás (una sesión larga previa igual puede superponerse) y
 * cuenta los solapes reales — un findFirst podía perderlos.
 */
export async function countCapacityOverlaps(
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
export async function checkPatientOverlap(
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
export async function resolveUniqueViolation(
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

export type ServiceForRule = { id: string; durationMin: number; maxConcurrent: number | null; practitionerId: string | null };

/**
 * Regla efectiva del profesional para el servicio (`PractitionerService`):
 * habilitado, duración propia y cupo (override). Sin fila, el default de
 * Configuración: habilitado si el servicio es del consultorio o de ese
 * profesional (`resolvePractitionerService`). Tenant-scoped a mano.
 */
export async function practitionerServiceRule(
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
export const rangesForInput = (input: AvailabilityInput): RangesFor => (pid, dayKey) =>
  scheduledRanges(pid, dayKey, input);

/** Lo que el motor necesita para clasificar [start, end) de un profesional:
 *  el día AR del inicio (y el siguiente si el turno cruza la medianoche). */
export function loadInstantAvailability(
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
export function classifyForWrite(
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
export async function liveBlocksInTx(
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
      // SR (§17.5): un bloqueo de SALA tiene practitionerId null por CHECK
      // pero NO es "todos": bloquea la sala, no al profesional. Sin esto,
      // bloquear el Consultorio 2 reclasificaba como bloqueada cualquier
      // alta de cualquier profesional en esa ventana.
      roomId: null,
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
export function defaultLocationFor(
  input: AvailabilityInput,
  practitionerId: string,
  when: Date,
  durationMin: number
): string | null {
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
export async function lockActiveLocation(tx: Tx, tenantId: string, locationId: string): Promise<boolean> {
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
export async function suggestNextFreeSlot(
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

// ─────────────────────────────────────────────────────────────────────────────
// Alta: validación de refs (create y batch) y datos de la fila (C8, S07c).
// ─────────────────────────────────────────────────────────────────────────────

export type BookingRefsInput = {
  patientId?: string | null;
  serviceId: string;
  practitionerId: string;
  locationId?: string | null;
};

export type BookingRefsRejection =
  | { kind: "foreign-patient" }
  | { kind: "foreign-practitioner" }
  | { kind: "bad-service" }
  | { kind: "bad-location" }
  | { kind: "basic" }
  | { kind: "service-disabled"; serviceName: string };

export type BookingRefsOk = {
  kind: "ok";
  /** Con el diagnóstico por defecto (autocompleta título/descripción del alta). */
  patient: { id: string; diagnosisTitle: string | null; diagnosisNote: string | null } | null;
  service: ServiceForRule & { name: string };
  practitionerId: string;
  rule: ResolvedPractitionerService;
  gate: BookingGate;
};

/**
 * Ids de entrada del alta validados contra el tenant ANTES de escribir, en la
 * tx del caller (dedup de `createBooking` y `createBookingsBatch`, que tenían
 * el mismo bloque copiado). Las FK saltean RLS y en prod la conexión tiene
 * BYPASSRLS, así que un `practitionerId` o un paciente de otro consultorio se
 * persistía tal cual (IDOR, A2a-S06).
 *
 * Orden (igual que antes, por eso las mismas sentencias): las cuatro lecturas
 * en paralelo → rechazos de tenant/sede → gate E1 (`bookingGateInTx`:
 * full || `agenda.operateAll`; guest: `guestOperable`) → regla del
 * profesional para el servicio (deshabilitado = rechazo simple, también para
 * OWNER/ADMIN: el cupo, la duración y el turnero ya leen esta regla, y un turno
 * "por afuera" quedaría inconsistente con todos ellos).
 *
 * La sede se re-valida con lock al escribir (`lockActiveLocation`); acá solo
 * se rechaza una sede ajena o archivada a tiempo.
 */
export async function validateBookingRefsInTx(
  tx: Tx,
  actor: Actor,
  refs: BookingRefsInput
): Promise<BookingRefsRejection | BookingRefsOk> {
  const [patient, service, prac, location] = await Promise.all([
    refs.patientId
      ? tx.patient.findFirst({
          where: { id: refs.patientId, tenantId: actor.tenantId },
          select: { id: true, diagnosisTitle: true, diagnosisNote: true },
        })
      : Promise.resolve(null),
    tx.service.findFirst({
      where: { id: refs.serviceId, tenantId: actor.tenantId },
      select: { id: true, durationMin: true, name: true, maxConcurrent: true, practitionerId: true },
    }),
    // IAM-4b: reservable en ESTE consultorio (rol clínico, membresía aceptada
    // y sin suspender), no solo «del tenant». Antes la Secretaria y
    // Facturación (que tienen fila Practitioner vieja) recibían turnos por RPC
    // o con un id viejo en el cliente. El filtro de membresía es un EXISTS en
    // la MISMA sentencia: 0 statements nuevos (techo de createBooking).
    tx.practitioner.findFirst({
      where: { id: refs.practitionerId, ...bookablePractitionerWhere(actor.tenantId, { includeDisabledFilter: true }) },
      select: { id: true },
    }),
    refs.locationId
      ? tx.location.findFirst({
          where: { id: refs.locationId, tenantId: actor.tenantId, active: true },
          select: { id: true },
        })
      : Promise.resolve(null),
  ]);
  if (refs.patientId && !patient) return { kind: "foreign-patient" };
  if (!prac) return { kind: "foreign-practitioner" };
  if (!service) return { kind: "bad-service" };
  if (refs.locationId && !location) return { kind: "bad-location" };
  // E1 (S07sb): operar = full || `agenda.operateAll` (la Secretaria, que
  // desde PD-13 nunca tiene full). PRACTITIONER en básico y BILLING siguen
  // afuera. Guest: `guestOperable` (P0.Z, H-b3): BILLING tampoco crea guests
  // (antes contaba como full y fijaba copago). El paciente ya se validó
  // contra el tenant arriba. También para el dryRun del batch: el preflight
  // expone la ocupación del paciente.
  const gate = await bookingGateInTx(tx, actor, patient?.id ?? null, lazyCapsInTx(tx, actor));
  if (!gate.canOperate) return { kind: "basic" };
  const rule = await practitionerServiceRule(tx, actor.tenantId, prac.id, service);
  if (!rule.enabled) return { kind: "service-disabled", serviceName: service.name };
  return { kind: "ok", patient, service, practitionerId: prac.id, rule, gate };
}

/** Texto de cada rechazo de `validateBookingRefsInTx` (el mismo en create y batch). */
export function bookingRefsError(r: BookingRefsRejection): string {
  switch (r.kind) {
    case "foreign-patient":
      return "Paciente fuera del tenant.";
    case "foreign-practitioner":
      // IAM-4b: mismo texto para «de otro consultorio» y «no atiende acá»
      // (no se distingue sin otra lectura, y tampoco conviene: sin oráculo).
      return PRACTITIONER_NOT_BOOKABLE_ERROR;
    case "bad-service":
      return "Servicio inválido.";
    case "bad-location":
      return BAD_LOCATION_ERROR;
    case "basic":
      return BASIC_ACCESS_ERROR;
    case "service-disabled":
      return SERVICE_DISABLED_ERROR(r.serviceName);
  }
}

/**
 * Datos de la fila nueva (`create` del upsert por `idempotencyKey`) del alta
 * simple y del batch. Una sola forma para los dos: antes eran dos literales
 * que había que mantener a mano.
 *
 * C4 (Planes): NUNCA escribe `programId`, `sessionId` ni `pricedByPlan` (el
 * único escritor del vínculo es el motor de planes, I8). Estado: con paciente
 * nace CONFIRMED; guest, PENDING (como siempre). `seriesId` solo en el batch.
 */
export function buildBookingCreateData(o: {
  tenantId: string;
  practitionerId: string;
  serviceId: string;
  scheduledFor: Date;
  durationMin: number;
  copagoCents: number | null;
  patientId?: string | null;
  guestName?: string | null;
  guestEmail?: string | null;
  guestPhone?: string | null;
  notes?: string | null;
  isOverbooked: boolean;
  locationId: string | null;
  /**
   * SR: sala ya resuelta y validada por el caller (`defaultRoomFor` +
   * `lockActiveRoomInTx`). Ausente/null = sin sala. Con sala, `locationId`
   * TIENE que ser explícito (SR-D6, CHECK `Booking_room_location_check` de M4):
   * el caller resuelve null → id de la sede principal ANTES de llamar.
   */
  roomId?: string | null;
  isTelemedicine: boolean;
  telemedicineUrl: string | null;
  title: string | null;
  description: string | null;
  idempotencyKey: string;
  seriesId?: string;
}): Prisma.BookingUncheckedCreateInput {
  if (o.roomId && !o.locationId) {
    // Error de programación, no de datos: sin esto el INSERT revienta con un
    // 23514 opaco del CHECK de M4 (y dentro de un batch, la tx entera).
    throw new Error("buildBookingCreateData: un turno con sala necesita la sede explícita (SR-D6)");
  }
  return {
    tenantId: o.tenantId,
    practitionerId: o.practitionerId,
    serviceId: o.serviceId,
    scheduledFor: o.scheduledFor,
    durationMin: o.durationMin,
    copagoCents: o.copagoCents,
    patientId: o.patientId,
    guestName: o.guestName,
    guestEmail: o.guestEmail,
    guestPhone: o.guestPhone,
    notes: o.notes,
    isOverbooked: o.isOverbooked,
    locationId: o.locationId,
    // Solo si viene: la forma de la fila sin sala queda idéntica a la de antes.
    ...(o.roomId ? { roomId: o.roomId } : {}),
    isTelemedicine: o.isTelemedicine,
    telemedicineUrl: o.telemedicineUrl,
    title: o.title,
    description: o.description,
    status: o.patientId ? "CONFIRMED" : "PENDING",
    ...(o.seriesId ? { seriesId: o.seriesId } : {}),
    idempotencyKey: o.idempotencyKey,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Planes · sincronía lado turno (S12, ES2b P2.1; C4, C3, C5 de PLANES.md).
//
// Por qué acá y no en cada write-path: el turno de un plan se toca desde el
// drawer (`updateBooking` → `applyBookingUpdateInTx`), Recepción
// (`markReceptionAction`) y, en P2.2, "este y los siguientes" (plans-move, que
// llama al core por fila). Si cada uno sincronizara la sesión a su manera,
// "Atendido" cerraría la sesión distinto que el drawer. Estas primitivas son
// la única versión; NUNCA toman `lockPlanPatient` (C2 (0): lo pide solo quien
// cambia la estructura del plan, y siempre primero) y nunca emiten: devuelven
// lo que el caller avisa después del commit.
//
// Orden de filas (C2 (3)): Booking → Session → TreatmentProgram. La sesión se
// escribe siempre DESPUÉS del UPDATE del turno (que ya lockeó la fila), o
// después de un `FOR UPDATE` explícito del turno en la reactivación.
// ─────────────────────────────────────────────────────────────────────────────

/** Estados que dejan al turno "activo" para su sesión (I2 / C4): todo menos CANCELLED y NO_SHOW. */
export function activeForSession(s: BookingStatus): boolean {
  return s !== "CANCELLED" && s !== "NO_SHOW";
}

/** Aviso post-commit de alta próxima (PROGRAM_NEARING_DISCHARGE). */
export type PlanDischarge = { programId: string; pending: number; totalLive: number };

/** Lo que la sincronía le devuelve al caller para avisar después del commit. */
export type PlanSyncResult = {
  /** Salió de COMPLETED pero la sesión tenía evolución (C4): quedó realizada. */
  sessionKeptDone: boolean;
  /** Quedan ≤ 1 sesiones vivas pendientes tras cerrar ésta. */
  discharge: PlanDischarge | null;
};

/**
 * "Sesión N" de los rechazos = el ORDINAL (M13: por fecha entre las vivas,
 * empate por `index`), no el `index` crudo. Una archivada no tiene ordinal: cae
 * al `index`. Solo corre en caminos de rechazo (dos lecturas chicas).
 */
export async function planSessionOrdinalInTx(tx: Tx, tenantId: string, sessionId: string): Promise<number> {
  const s = await tx.session.findFirst({
    where: { id: sessionId, program: { tenantId } },
    select: { index: true, programId: true },
  });
  if (!s) return 0;
  const all = await tx.session.findMany({
    where: { programId: s.programId, program: { tenantId } },
    select: { id: true, index: true, scheduledFor: true, archivedAt: true },
  });
  return planSessionOrdinal(all, sessionId) ?? s.index;
}

/**
 * ¿El turno tiene un cobro? Criterio canónico (`bookingHasMoney`, espejo de
 * `bookingHasPaymentWhere` y `cancelBookingsInTx`). El `Payment` de MP se lee
 * solo si las columnas del turno no alcanzan: la consulta extra la paga
 * únicamente un turno de plan que se cancela.
 */
async function planBookingHasMoneyInTx(
  tx: Tx,
  b: { id: string; paymentStatus: PricingBooking["paymentStatus"]; insurerPaidAt: Date | null }
): Promise<boolean> {
  if (bookingHasMoney({ paymentStatus: b.paymentStatus, insurerPaidAt: b.insurerPaidAt, payment: null })) return true;
  // `bookingId` es único y el turno ya se validó contra el tenant (el caller lo leyó con `tenantId`).
  const pay = await tx.payment.findUnique({ where: { bookingId: b.id }, select: { status: true } });
  return bookingHasMoney({ paymentStatus: b.paymentStatus, insurerPaidAt: b.insurerPaidAt, payment: pay });
}

/** Re-estampado de la reactivación (`null` = no se toca la plata). */
export type PlanReactivationStamp = { copagoCents: number | null; pricedByPlan: boolean };

export type PlanReactivationOutcome =
  | { kind: "ok"; stamp: PlanReactivationStamp | null }
  | { kind: "stale" }
  | { kind: "plan-session-not-pending"; ordinal: number };

/**
 * Reactivar un turno de plan (CANCELLED/NO_SHOW → activo; C4), ANTES de
 * escribirlo y con las filas lockeadas en el orden de C2 (3):
 *   1. `Booking FOR UPDATE` y re-chequeo de `updatedAt` (sin escribir: si
 *      cambió, `stale` y el caller no escribió nada);
 *   2. `Session FOR UPDATE` (+ estado del plan): la sesión tiene que estar
 *      viva y no realizada y el plan ACTIVE o PAUSED. Sin el lock, un cierre
 *      en Seguimiento concurrente dejaba un turno activo sobre una sesión
 *      realizada;
 *   3. si `pricedByPlan` y el turno está impago (C5 (a): `paymentStatus`
 *      UNPAID y sin plata), re-estampa la cuota de HOY de la sesión (un
 *      reprecio pudo cambiarla mientras estaba cancelado). Con cobro previo de
 *      la sesión (`priorPaidStamp`, PD-08: cobrado de verdad) va en $0, igual
 *      que el turno nuevo que estampa el motor: si no, la sesión se cobraba dos
 *      veces.
 *
 * Lo llaman `applyBookingUpdateInTx` (drawer, `setBookingStatus`) y Recepción
 * ("Deshacer Ausente"). Corre después de los locks de cupo y de sedes (C2
 * (1)-(2) → (3)). El P2002 del único parcial de sesión (I2) NO se ve acá: lo
 * tira el UPDATE y lo resuelve el caller (`resolveBookingUpdateUniqueViolation`).
 */
export async function lockPlanReactivationInTx(
  tx: Tx,
  o: { tenantId: string; bookingId: string; sessionId: string; expectedUpdatedAt: Date; pricedByPlan: boolean }
): Promise<PlanReactivationOutcome> {
  const bRows = await tx.$queryRaw<
    { updatedAt: Date; paymentStatus: PricingBooking["paymentStatus"]; insurerPaidAt: Date | null; payStatus: PricingBooking["paymentStatus"] | null }[]
  >`
    SELECT b."updatedAt", b."paymentStatus"::text AS "paymentStatus", b."insurerPaidAt", p.status::text AS "payStatus"
    FROM "Booking" b
    LEFT JOIN "Payment" p ON p."bookingId" = b.id
    WHERE b.id = ${o.bookingId} AND b."tenantId" = ${o.tenantId}
    FOR UPDATE OF b`;
  const b = bRows[0];
  if (!b || +b.updatedAt !== +o.expectedUpdatedAt) return { kind: "stale" };

  const sRows = await tx.$queryRaw<
    { completedAt: Date | null; archivedAt: Date | null; priceCents: number | null; programStatus: string; programArchivedAt: Date | null }[]
  >`
    SELECT s."completedAt", s."archivedAt", s."priceCents", tp.status::text AS "programStatus", tp."archivedAt" AS "programArchivedAt"
    FROM "Session" s
    JOIN "TreatmentProgram" tp ON tp.id = s."programId"
    WHERE s.id = ${o.sessionId} AND tp."tenantId" = ${o.tenantId}
    FOR UPDATE OF s`;
  const s = sRows[0];
  const pending =
    !!s &&
    s.completedAt == null &&
    s.archivedAt == null &&
    s.programArchivedAt == null &&
    (s.programStatus === "ACTIVE" || s.programStatus === "PAUSED");
  if (!pending) {
    return { kind: "plan-session-not-pending", ordinal: await planSessionOrdinalInTx(tx, o.tenantId, o.sessionId) };
  }

  if (!o.pricedByPlan) return { kind: "ok", stamp: null };
  const unpaid =
    b.paymentStatus === "UNPAID" &&
    !bookingHasMoney({
      paymentStatus: b.paymentStatus,
      insurerPaidAt: b.insurerPaidAt,
      payment: b.payStatus ? { status: b.payStatus } : null,
    });
  if (!unpaid) return { kind: "ok", stamp: null };

  // Turnos previos de la sesión (cancelados/ausentes) para el cobro previo.
  const prev = await tx.booking.findMany({
    where: { tenantId: o.tenantId, sessionId: o.sessionId, id: { not: o.bookingId }, status: { in: ["CANCELLED", "NO_SHOW"] } },
    select: {
      id: true,
      status: true,
      paymentStatus: true,
      insurerPaidAt: true,
      copagoCents: true,
      pricedByPlan: true,
      scheduledFor: true,
      payment: { select: { status: true } },
    },
  });
  const st = priorPaidStamp({ priceCents: s.priceCents }, prev);
  return { kind: "ok", stamp: { copagoCents: st.copagoCents, pricedByPlan: st.pricedByPlan } };
}

/** Datos del UPDATE del turno para el re-estampado (I8: nunca escribe `pricedByPlan=true`; ya lo era). */
export function planStampData(stamp: PlanReactivationStamp | null): Prisma.BookingUncheckedUpdateInput {
  if (!stamp) return {};
  return stamp.pricedByPlan
    ? { copagoCents: stamp.copagoCents }
    : { copagoCents: stamp.copagoCents, pricedByPlan: false };
}

/**
 * La sesión después de que el UPDATE del turno ya se escribió (Booking → Session):
 *   - write-through I3: con el turno activo movido o reactivado,
 *     `Session.scheduledFor` = turno (`where {id, program:{tenantId}}`);
 *   - entra a COMPLETED → `completeSessionInTx({source:'booking'})`: SOLO
 *     `completedAt`, sin ejercicios ni EVA, y no autocompleta (D22: S12b
 *     sugiere el alta). Si quedan ≤ 1 vivas pendientes, `discharge` para el
 *     aviso post-commit;
 *   - sale de COMPLETED → `reopenSessionIfUntouchedInTx`; con evolución la
 *     sesión queda realizada y `sessionKeptDone` lo avisa;
 *   - CANCELLED / NO_SHOW (desde un estado no COMPLETED): nada, la sesión queda
 *     "sin turno" con su cuota y su fecha planificada.
 * No gatea (el gate del turno ya corrió en el caller, C8): marcar "Atendido"
 * es administrativo y no escribe HC.
 */
export async function syncPlanSessionAfterBookingWriteInTx(
  tx: Tx,
  o: {
    tenantId: string;
    actorId: string | null;
    sessionId: string;
    beforeStatus: BookingStatus;
    finalStatus: BookingStatus;
    /** Instante al que se alinea la sesión (I3), o null si no corresponde. */
    writeThroughAt: Date | null;
    now: Date;
  }
): Promise<PlanSyncResult> {
  const out: PlanSyncResult = { sessionKeptDone: false, discharge: null };
  if (o.writeThroughAt) {
    await tx.session.updateMany({
      where: { id: o.sessionId, program: { tenantId: o.tenantId } },
      data: { scheduledFor: o.writeThroughAt },
    });
  }
  if (o.beforeStatus !== "COMPLETED" && o.finalStatus === "COMPLETED") {
    const c = await completeSessionInTx(tx, {
      tenantId: o.tenantId,
      sessionId: o.sessionId,
      actorId: o.actorId,
      source: "booking",
      now: o.now,
    });
    if (c.claimed && c.programId) {
      const live = await tx.session.findMany({
        where: { programId: c.programId, archivedAt: null, program: { tenantId: o.tenantId } },
        select: { completedAt: true },
      });
      const pending = live.filter((s) => s.completedAt == null).length;
      if (pending <= 1) out.discharge = { programId: c.programId, pending, totalLive: live.length };
    }
  } else if (o.beforeStatus === "COMPLETED" && o.finalStatus !== "COMPLETED") {
    const r = await reopenSessionIfUntouchedInTx(tx, { tenantId: o.tenantId, sessionId: o.sessionId, now: o.now });
    out.sessionKeptDone = r.reason === "touched";
  }
  return out;
}

/**
 * P2002 de un UPDATE de turno, resuelto por los DATOS en una tx nueva (la que
 * falló quedó abortada; bajo RLS `meta.target` llega null, A1.1). Dos índices
 * únicos puede pisar una edición: el paciente-instante (de siempre) y, desde
 * M1, `Booking_session_active_key` (I2: un turno activo por sesión). Si la
 * sesión del turno ya tiene OTRO turno activo, es ése; si no, el de siempre.
 * El turno suelto paga una lectura solo en este camino de error.
 */
export async function resolveBookingUpdateUniqueViolation(
  tenantId: string,
  bookingId: string
): Promise<{ kind: "plan-session-taken"; ordinal: number } | { kind: "patient-slot" }> {
  return runWithRls(tenantId, async (tx) => {
    const b = await tx.booking.findFirst({ where: { id: bookingId, tenantId }, select: { sessionId: true } });
    if (!b?.sessionId) return { kind: "patient-slot" as const };
    const other = await tx.booking.findFirst({
      where: { tenantId, sessionId: b.sessionId, id: { not: bookingId }, status: { notIn: ["CANCELLED", "NO_SHOW"] } },
      select: { id: true },
    });
    if (!other) return { kind: "patient-slot" as const };
    return { kind: "plan-session-taken" as const, ordinal: await planSessionOrdinalInTx(tx, tenantId, b.sessionId) };
  });
}

/**
 * PROGRAM_NEARING_DISCHARGE post-commit (C4: "Post-commit: … si quedan ≤ 1
 * vivas pendientes"). Va al profesional RESPONSABLE del plan (D17), que es
 * quien decide el alta; si el plan no tiene responsable, al actor. Antes solo
 * lo mandaba el cierre de Seguimiento, al actor: con "Atendido" en Recepción
 * le llegaba a la Secretaria. Abre su propia lectura (después del commit) y
 * nunca tira: el turno ya está escrito.
 */
export async function notifyPlanNearingDischarge(
  tenantId: string,
  d: PlanDischarge,
  fallbackUserId: string | null
): Promise<void> {
  try {
    const p = await runWithRls(tenantId, (tx) =>
      tx.treatmentProgram.findFirst({
        where: { id: d.programId, tenantId },
        select: {
          patientId: true,
          patient: { select: { firstName: true, lastName: true } },
          practitioner: { select: { userId: true, tenantId: true } },
        },
      })
    );
    if (!p) return;
    const owner = p.practitioner && p.practitioner.tenantId === tenantId ? p.practitioner.userId : null;
    const userId = owner ?? fallbackUserId;
    if (!userId) return;
    const name = `${p.patient.firstName} ${p.patient.lastName}`;
    await notify({
      tenantId,
      userId,
      kind: NotificationKind.PROGRAM_NEARING_DISCHARGE,
      title: d.pending === 0 ? `Plan completo · ${name}` : `Última sesión próxima · ${name}`,
      body:
        d.pending === 0
          ? `Completó las ${d.totalLive} sesiones. ¿Le das el alta?`
          : `Sesión ${d.totalLive} de ${d.totalLive} pendiente.`,
      link: `/pacientes/${p.patientId}`,
    });
  } catch (e) {
    logger.warn("plan.discharge_notify_failed", {
      tenantId,
      programId: d.programId,
      err: e instanceof Error ? e.message : String(e),
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Edición: el cuerpo de la tx de `updateBooking` (C8, S07c).
// ─────────────────────────────────────────────────────────────────────────────

/** Lo que la edición lee de la fila antes de decidir (y devuelve al caller para audit/notify/avisos). */
const UPDATE_BEFORE_SELECT = {
  id: true,
  patientId: true,
  status: true,
  scheduledFor: true,
  durationMin: true,
  practitionerId: true,
  serviceId: true,
  locationId: true,
  // SR: escalar (sin sentencia nueva). La sala vieja: si se cambia la sede y
  // no es de la nueva, el UPDATE la recalcula o la limpia (si no, 23503 por la
  // FK compuesta (roomId, locationId) de M4); y `prev.roomId` de los refs.
  roomId: true,
  isTelemedicine: true,
  service: { select: { id: true, durationMin: true, maxConcurrent: true, practitionerId: true } },
  updatedAt: true,
  // S07sb: regla de re-vínculo sin `clinical.read` (¿trae algo clínico?).
  title: true,
  description: true,
  notes: true,
  patient: { select: { firstName: true, lastName: true } },
  // S12 (C4/C5): vínculo y plata del turno de plan. Escalares a propósito: un
  // `select` de relación sumaría una sentencia a TODA edición (techo estricto
  // de `updateBooking` en tests/perf/compare.ts); lo demás se lee solo si el
  // turno es de un plan.
  programId: true,
  sessionId: true,
  pricedByPlan: true,
  paymentStatus: true,
  insurerPaidAt: true,
} satisfies Prisma.BookingSelect;

export type BookingUpdateBefore = Prisma.BookingGetPayload<{ select: typeof UPDATE_BEFORE_SELECT }>;

export type BookingUpdatePatch = z.output<typeof BookingUpdate>;

/** El patch que efectivamente se escribe (y se audita) después de `bookingFieldAccess`. */
export type BookingUpdateWritten = Omit<
  BookingUpdatePatch,
  "id" | "locationId" | "roomId" | "isTelemedicine" | "telemedicineUrl"
>;

/** Datos para los avisos forzables (el caller arma el nombre del profesional y la sugerencia, fuera de la tx). */
export type BookingUpdatePrompt = {
  before: BookingUpdateBefore;
  newWhen: Date;
  newDuration: number;
  cap: number | null;
  finalPatientId: string | null;
};

/**
 * Outcome de `applyBookingUpdateInTx`: la unión que `updateBooking` tenía
 * inline después de ES1 (S07k + S07sb), enumerada por símbolo (C8). S12 (P2.1)
 * solo AGREGA variantes: `plan-session-not-pending` (reactivar sin sesión
 * pendiente o con el plan fuera de ACTIVE/PAUSED), `plan-paid-cancel` (P6) y
 * `plan-patient-change` (I1). `plan-delete` no es de este core (no borra): lo
 * devuelve `deleteBooking` con el mismo nombre.
 *
 * Todo outcome que no es `ok` sale ANTES de cualquier escritura: un caller
 * multi-fila ("este y los siguientes") puede cortar y hacer rollback, o seguir,
 * sin dejar una fila a medias.
 *
 * `ok.plan` (S12): resultado de la sincronía con la sesión (null = turno
 * suelto) para los avisos post-commit (alta próxima, sesión que quedó realizada).
 *
 * `ok.refs` (enmienda Realtime): el turno movido/editado, para que el caller
 * llame `afterBookingsCommitted` DESPUÉS del commit (acá nunca se emite).
 * `ok.written` (S07sb): los campos que se escribieron después del filtrado de
 * `bookingFieldAccess`; es lo que va al audit.
 */
export type BookingUpdateTxOutcome =
  | { kind: "notfound" }
  | { kind: "stale" }
  | { kind: "basic" }
  | { kind: "foreign-patient" }
  | { kind: "clinical-relink" }
  | { kind: "patient-slot" }
  | ({ kind: "blocked"; reason: string | null } & BookingUpdatePrompt)
  | ({ kind: "out-of-hours" } & BookingUpdatePrompt)
  | { kind: "patient-overlap"; existingISO: string }
  | ({ kind: "conflict" } & BookingUpdatePrompt)
  | { kind: "bad-location" }
  // SR (contrato literal de SR-C): la sala final está llena (profesionales
  // DISTINTOS ≥ capacity, SR-D1) o bloqueada (§17.5, `blocked`). Forzable con
  // `allowRoomConflict`, que NO es sobreturno (SR-D2). Copy: ROOM_BUSY_ERROR /
  // ROOM_BLOCKED_ERROR.
  | { kind: "room-busy"; roomName: string; used: number; capacity: number; blocked?: { reason: string | null } | null }
  // SR: la sala elegida no es de la sede final del turno, es de otro tenant,
  // está archivada o su sede lo está. Copy: BAD_ROOM_ERROR.
  | { kind: "bad-room" }
  | { kind: "plan-session-not-pending"; ordinal: number }
  | { kind: "plan-paid-cancel" }
  | { kind: "plan-patient-change" }
  // IAM-4b: mover (o reactivar / cambiar de sede) un turno cuyo profesional ya
  // no es reservable (turno viejo de la Secretaria, profesional suspendido).
  // Copy: PRACTITIONER_NOT_BOOKABLE_ERROR. Editar notas o cancelar sigue
  // andando: no re-clasifica.
  | { kind: "practitioner-not-bookable" }
  | {
      kind: "ok";
      before: BookingUpdateBefore;
      updatedAt: Date;
      written: BookingUpdateWritten;
      refs: BookingChangeRef[];
      plan: PlanSyncResult | null;
      /**
       * SR: la sala que quedó escrita si la edición la cambió (undefined = no
       * se tocó; null = quedó sin sala). Para el audit del caller: `written`
       * no la trae porque la sala no es un campo del patch que se copie tal
       * cual (se recalcula, se valida y se limpia).
       */
      roomId?: string | null;
    };

/**
 * Edita/mueve/cambia el estado de UN turno dentro de la tx del caller (C8):
 * lookup por tenant → lock optimista → gate E1 → re-vínculo → guard del
 * paciente → lock de cupo (+ sala) + franjas/bloqueos (motor) → cupo → sede →
 * sala (validar + ocupación, SR) → update.
 *
 * Sala (corrida SR, enmienda C2 (1b): paciente → cupo → SALA → sedes → filas):
 *   - con la sala conocida de antemano (elegida o la que tenía) la clave va en
 *     la MISMA sentencia que el cupo (`lockCapacityAndRoomsMany`); la por
 *     defecto sale de las franjas, que se leen después del lock de cupo, y va
 *     en una segunda sentencia, solo si hay sala;
 *   - sin sala: `lockCapacityWindow` como siempre, 0 statements nuevos (techo
 *     estricto de `updateBooking`); con sala, +2 (clave de sala y conteo; la
 *     validación de la sala reemplaza la de la sede por defecto);
 *   - `room-busy` sale último de los avisos (FORCE_PROMPT_ORDER) y se fuerza
 *     con `allowRoomConflict`, que no marca `isOverbooked` (SR-D2);
 *   - `capLocksHeld` (SR-D3) estampa la sala por defecto sin chequear ni
 *     tomar la clave de sala.
 *
 * Contrato Secretaria (E1, literal de C8): el gate `canOperateBooking(caps,
 * access)` y el filtrado de `bookingFieldAccess` viven ACÁ adentro, no solo en
 * el wrapper `updateBooking`. Así "mover", "este y los siguientes" y la
 * sincronía no lo saltean. Un campo no permitido se saca del patch ANTES del
 * write y del audit. El re-vínculo de paciente sin `clinical.read` sigue la
 * regla de S07sb.
 *
 * Errores:
 *   - P2002 (índice único parcial paciente+instante, una carrera que el guard
 *     del paciente no vio) ABORTA la tx de Postgres: se propaga y lo resuelve
 *     el caller, por los datos y en una tx nueva (`updateBooking` lo traduce a
 *     `patient-slot`). No se puede atrapar acá: la tx ya no admite queries;
 *   - P2025 del update con `updatedAt` en el where (alguien escribió entre la
 *     lectura y el update) → `stale`. No es un error de Postgres (el UPDATE
 *     matcheó 0 filas y Prisma lo informa), así que la tx sigue sana y no se
 *     escribió nada; un caller multi-fila decide si sigue o hace rollback.
 *
 * `opts.capLocksHeld`: el caller ya tomó los locks de cupo de los días del
 * horario NUEVO (C2: "este y los siguientes" los toma todos ordenados antes
 * de llamar al core por fila); acá no se vuelven a pedir. Sin el flag, se
 * toman como siempre. Nunca toma `lockPlanPatient` (C2).
 * `opts.now`: el "ahora" de la clasificación y del cupo (una reserva pública
 * impaga vencida deja de contar); el wrapper lo fija antes de abrir la tx.
 */
export async function applyBookingUpdateInTx(
  tx: Tx,
  actor: Actor,
  input: { patch: BookingUpdatePatch; expectedUpdatedAt?: string; force: ForceFlags },
  opts: { now: Date; capLocksHeld?: boolean }
): Promise<BookingUpdateTxOutcome> {
  const {
    id,
    locationId: patchLocationId,
    roomId: patchRoomId,
    isTelemedicine: patchTele,
    telemedicineUrl: patchTeleUrl,
    ...patch
  } = input.patch;
  const { force } = input;
  const { now } = opts;

  const before = await tx.booking.findFirst({
    where: { id, tenantId: actor.tenantId },
    select: UPDATE_BEFORE_SELECT,
  });
  if (!before) return { kind: "notfound" };
  // Optimistic concurrency (AUDIT §5.7): reject if the row changed since the
  // client (e.g. the BookingDrawer) loaded it — prevents acting on a stale view.
  if (input.expectedUpdatedAt && +before.updatedAt !== +new Date(input.expectedUpdatedAt)) {
    return { kind: "stale" };
  }
  // E1 (S07sb, contrato Secretaria de C8): operar = full ||
  // `agenda.operateAll`. Acceso básico sin operateAll (PRACTITIONER ajeno,
  // BILLING) = solo ver: ni estado, ni reprogramar, ni notas.
  const caps = lazyCapsInTx(tx, actor);
  const gate = await bookingGateInTx(tx, actor, before.patientId, caps);
  if (!gate.canOperate) return { kind: "basic" };
  // Tenant-scope + access check on the re-bound patient (`undefined` = leave
  // alone) — atomic with the update. S07sb: el destino pasa por el MISMO
  // gate (no `hasFullAccess`): la Secretaria asigna paciente a un guest.
  const patientChanged = patch.patientId !== undefined && patch.patientId !== before.patientId;
  // S12 (I1): un turno de plan es del paciente del plan. La FK compuesta
  // `Booking_plan_patient_fkey` lo frena igual, pero con un 500; acá, mensaje.
  const isPlan = before.programId != null && before.sessionId != null;
  if (isPlan && patientChanged) return { kind: "plan-patient-change" };
  let fields = gate.fields;
  if (patientChanged) {
    const owned = await tx.patient.findFirst({
      where: { id: patch.patientId, tenantId: actor.tenantId },
      select: { id: true },
    });
    if (!owned) return { kind: "foreign-patient" };
    const target = await bookingGateInTx(tx, actor, owned.id, caps);
    if (!target.canOperate) return { kind: "basic" };
    // Sin `clinical.read`: guest → paciente sí; paciente → paciente solo si
    // el turno no trae nada clínico (lo arrastraría a otra HC sin verlo).
    if (!gate.clinical && before.patientId && hasClinicalText(before)) {
      return { kind: "clinical-relink" };
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
  // FX1b (SV): las estampas de Recepción (`arrivedAt`, `calledAt`,
  // `attendingAt`) son de ESE día. Un turno «llamado» o «en sala» movido a
  // mañana seguía con las estampas de hoy: mañana aparecía en la Sala de
  // Espera como si el paciente ya hubiera llegado (y avisaba «llamado» con la
  // hora de ayer). Cambiar de día AR (`toARDateKey`, nunca el día del host:
  // un 22:30 AR es otro día en UTC) las limpia; mover dentro del mismo día no
  // las toca (el paciente sigue en la sala, solo cambió el horario).
  // Cancelar / Ausente NO las limpian: el estado gana en Recepción
  // (`receptionStateOf`: cancelado/ausente antes que cualquier estampa) y
  // «Deshacer» vuelve al estado previo con sus estampas.
  const dayChanged = slotChanged && toARDateKey(newWhen) !== toARDateKey(before.scheduledFor);
  const durationChanged = patch.durationMin != null && patch.durationMin !== before.durationMin;
  const reactivating = before.status === "CANCELLED" && finalStatus !== "CANCELLED";
  const windowChanged = slotChanged || durationChanged || reactivating;
  const locationChanged = patchLocationId !== undefined && patchLocationId !== before.locationId;

  // ── SR: sala final del turno ──────────────────────────────────────────────
  // Tres fuentes (lib/validation.ts `bookingRoomId`):
  //   - elegida (`roomPinned`, un id): esa, validada contra la sede FINAL. Elegir
  //     sala nunca cambia la sede: sin `locationId` en el patch, la sede queda la
  //     que tenía (no se recalcula la de la franja), y una sala de otra sede es
  //     `bad-room`;
  //   - "Sin sala" (null): ninguna, sin chequeos;
  //   - por defecto (ausente): si se mueve el horario o cambia la sede, la de la
  //     franja que contiene el turno en la sede final (`defaultRoomFor`, SR1a);
  //     si no, la que ya tenía (`before.roomId`).
  // Por qué recalcular al mover: la sala sale de la franja (SR §17.1). Un turno
  // movido de las 10 (Consultorio 1) a las 16 (Gimnasio) que se quedara en el
  // Consultorio 1 ocuparía una sala que a esa hora es de otro profesional. Y al
  // cambiar de sede, la sala vieja no puede quedar: la FK compuesta
  // (roomId, locationId) de M4 revienta con 23503 (contrato de SR0).
  const roomPinned = typeof patchRoomId === "string";
  const roomDefaulted = patchRoomId === undefined && (slotChanged || locationChanged);
  /** Sala que va a quedar en la fila (provisional: la por defecto se decide después de cargar las franjas). */
  let targetRoomId: string | null = patchRoomId !== undefined ? patchRoomId : before.roomId;
  /** ¿El UPDATE escribe `roomId`? (solo si cambia: sin sala, la sentencia queda idéntica a la de antes). */
  // El drawer reenvía la sala que ya tenía al guardar notas: misma sala, misma
  // sede → nada que validar ni escribir (la fila ya cumple las FKs).
  let roomTouched =
    roomDefaulted || (patchRoomId !== undefined && !(patchRoomId === before.roomId && !locationChanged));
  // SR-D1/D2/D3: la ocupación se chequea en el alta/edición suelta con sala, no
  // en un turno cancelado, no con `capLocksHeld` (Planes, "este y los
  // siguientes": estampan sin chequear ni tomar la clave de sala) y no si el
  // usuario ya confirmó "Asignar igual" (`allowRoomConflict`).
  const roomCheckable = finalStatus !== "CANCELLED" && !opts.capLocksHeld && !force.allowRoomConflict;
  /** Ya se tomó la clave de sala de la ventana nueva (fusionada con el cupo o sola). */
  let roomKeyHeld = false;
  /** La sala validada (`lockActiveRoomInTx`) con su capacidad y nombre, para el conteo. */
  let roomRow: { id: string; capacity: number; name: string; locationId: string } | null = null;
  let avail: Awaited<ReturnType<typeof loadInstantAvailability>> | null = null;
  const roomKeys = (roomId: string) => roomKeysForWindow({ tenantId: actor.tenantId, roomId, start: newWhen, end });

  // S12 (C4, P6): cancelar un turno de plan con cobro deja la plata colgada de
  // una sesión "sin turno"; se reprograma. Ausente con cobro SÍ se permite (la
  // sesión queda "con cobro previo" y su próximo turno va en $0, C5).
  if (
    isPlan &&
    finalStatus === "CANCELLED" &&
    before.status !== "CANCELLED" &&
    (await planBookingHasMoneyInTx(tx, before))
  ) {
    return { kind: "plan-paid-cancel" };
  }
  // S12 (C4): reactivar = volver a ocupar la sesión (inactivo → activo para I2).
  // Distinto de `reactivating` (solo CANCELLED: un NO_SHOW ya retenía el cupo).
  const planReactivating = isPlan && !activeForSession(before.status) && activeForSession(finalStatus);

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
    if (pat?.sameInstant) return { kind: "patient-slot" };

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
      // sedes (`lockActiveLocation` más abajo). Con `capLocksHeld` el caller
      // ya los tomó (ordenados, C2).
      if (!opts.capLocksHeld) {
        const capWindow = {
          tenantId: actor.tenantId,
          practitionerId: before.practitionerId,
          serviceId: before.serviceId,
          start: newWhen,
          end,
        };
        if (roomCheckable && !roomDefaulted && targetRoomId) {
          // SR, enmienda C2 (1b): la sala ya se conoce (elegida o la que tenía)
          // → cupo y sala en UNA sentencia (cupo → sala → sedes → filas). Misma
          // cantidad de statements que `lockCapacityWindow`.
          await lockCapacityAndRoomsMany(tx, capacityKeysForWindow(capWindow), roomKeys(targetRoomId));
          roomKeyHeld = true;
        } else {
          // Sin sala (o la por defecto, que sale de las franjas que se cargan
          // DESPUÉS de este lock): lo de siempre, 0 statements nuevos.
          await lockCapacityWindow(tx, capWindow);
        }
      }
      const rule = await practitionerServiceRule(tx, actor.tenantId, before.practitionerId, before.service);
      cap = rule.cap;
      avail = await loadInstantAvailability(tx, {
        tenantId: actor.tenantId,
        practitionerId: before.practitionerId,
        serviceId: before.serviceId,
        start: newWhen,
        end,
      });
      // IAM-4b: el loader solo arma plantilla para profesionales reservables
      // (`bookablePractitionerWhere`), así que «sin plantilla para este id» =
      // no atiende en este consultorio. Sin sentencia nueva: es la carga que
      // ya corría. Sin esto el turno se movía por el horario de fallback y,
      // con «Cargar igual», a cualquier hora.
      if (!avail.templates.some((t) => t.practitionerId === before.practitionerId)) {
        return { kind: "practitioner-not-bookable" };
      }
      const cls = classifyForWrite(avail, {
        when: newWhen,
        durationMin: newDuration,
        practitionerId: before.practitionerId,
        serviceId: before.serviceId,
        // SR: con sala elegida la sede no se recalcula (ver arriba): se
        // clasifica en la que va a quedar.
        locationId: patchLocationId ?? (slotChanged && !roomPinned ? null : before.locationId),
        cap,
        now,
        excludeBookingId: id,
      });
      const prompt = { before, newWhen, newDuration, cap, finalPatientId };
      if (cls.blocked && !force.allowBlocked) {
        return { kind: "blocked", reason: cls.blockReason, ...prompt };
      }
      if (cls.outOfHours && !force.allowOutOfHours) return { kind: "out-of-hours", ...prompt };
      blocked = cls.blocked;
      if (patchLocationId === undefined && slotChanged && !roomPinned) {
        newLocationId = defaultLocationFor(avail, before.practitionerId, newWhen, newDuration);
      }
      if (roomDefaulted) {
        // Sede final (la elegida, la por defecto recién calculada o la que
        // tenía); null = la principal, que `defaultRoomFor` ya resuelve.
        const roomLoc = patchLocationId ?? (newLocationId !== undefined ? newLocationId : before.locationId);
        targetRoomId = defaultRoomFor(avail, before.practitionerId, newWhen, newDuration, roomLoc);
        if (targetRoomId && roomCheckable && !opts.capLocksHeld) {
          // La sala por defecto depende de las franjas, que se leen DESPUÉS del
          // lock de cupo (así ven un `applyDayLock` commiteado en el medio). Por
          // eso acá no se puede fusionar: la clave de sala va en una segunda
          // sentencia, recién ahora y solo si hay sala. El orden global sigue
          // siendo C2 (1b) (todo el cupo de esta tx ya está tomado, las sedes
          // todavía no), así que no hay ciclo posible con el alta, que las toma
          // fusionadas. Los +2 statements con sala se mantienen porque la
          // validación de la sala reemplaza a la de la sede (ver abajo).
          await lockCapacityAndRoomsMany(tx, [], roomKeys(targetRoomId));
          roomKeyHeld = true;
        }
      }
    }
    if (roomCheckable && !roomKeyHeld && targetRoomId && targetRoomId !== before.roomId) {
      // Solo cambia la sala (mismo horario, misma sede): el cupo no se mueve,
      // así que solo la clave de sala (C2 (1b): sigue antes de las sedes).
      await lockCapacityAndRoomsMany(tx, [], roomKeys(targetRoomId));
      roomKeyHeld = true;
    }

    if (pat?.overlapISO && !force.allowPatientOverlap) {
      return { kind: "patient-overlap", existingISO: pat.overlapISO };
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
      if (capacityReached && !force.allowOverbooking) {
        return { kind: "conflict", before, newWhen, newDuration, cap, finalPatientId };
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
  if (finalStatus === "CANCELLED" && roomDefaulted) {
    // Cancelado: no se cargaron franjas (no ocupa nada). Con cambio de sede la
    // sala vieja no puede quedar (23503); con solo un cambio de horario, queda.
    if (locationChanged) targetRoomId = null;
    else roomTouched = false;
  }
  let sedesLocked = false;
  if (patchLocationId !== undefined) {
    if (!(await lockActiveLocation(tx, actor.tenantId, patchLocationId))) return { kind: "bad-location" };
    newLocationId = patchLocationId;
    sedesLocked = true;
  } else if (newLocationId) {
    if (roomDefaulted && targetRoomId) {
      // SR: la sala por defecto de la sede por defecto. `lockActiveRoomInTx`
      // exige sala activa DE esa sede y sede activa: valida las dos en una
      // query (reemplaza a la de la sede, por eso con sala son +2 y no +3).
      await lockTenantLocationsShared(tx, actor.tenantId);
      sedesLocked = true;
      roomRow = await lockActiveRoomInTx(tx, {
        tenantId: actor.tenantId,
        roomId: targetRoomId,
        locationId: newLocationId,
      });
      if (!roomRow) {
        // Sala archivada en el medio (o su sede): el turno queda sin sala,
        // como el turnero (SR2b); la sede se valida sola, como siempre.
        targetRoomId = null;
        const loc = await tx.location.findFirst({
          where: { id: newLocationId, tenantId: actor.tenantId, active: true },
          select: { id: true },
        });
        if (!loc) newLocationId = undefined;
      }
    } else {
      if (!(await lockActiveLocation(tx, actor.tenantId, newLocationId))) newLocationId = undefined;
      sedesLocked = true;
    }
  }

  // SR: validar la sala que todavía no se validó (elegida, la que tenía con
  // el horario cambiado, o la por defecto con la sede elegida o la de antes),
  // DESPUÉS del lock compartido de sedes (`archiveRoom` toma el exclusivo: con
  // el compartido tomado, la sala no se archiva antes del UPDATE).
  if (roomTouched || roomKeyHeld) {
    if (targetRoomId && !roomRow) {
      let roomLoc = newLocationId !== undefined ? newLocationId : before.locationId;
      let stampedPrimary = false;
      if (!roomLoc) {
        // SR-D6: turno con sala ⇒ sede explícita (CHECK de M4). null = la
        // principal: se resuelve y se ESTAMPA.
        roomLoc =
          avail?.primaryLocationId ??
          (
            await tx.location.findFirst({
              where: { tenantId: actor.tenantId, isPrimary: true },
              select: { id: true },
            })
          )?.id ??
          null;
        stampedPrimary = roomLoc != null;
      }
      if (!sedesLocked) {
        await lockTenantLocationsShared(tx, actor.tenantId);
        sedesLocked = true;
      }
      roomRow = roomLoc
        ? await lockActiveRoomInTx(tx, { tenantId: actor.tenantId, roomId: targetRoomId, locationId: roomLoc })
        : null;
      if (!roomRow) {
        // Elegida → rechazo sin escribir. La por defecto o la que tenía
        // (archivada, o la franja apunta a una sala de otra sede) → sin sala.
        if (roomPinned) return { kind: "bad-room" };
        targetRoomId = null;
        roomTouched = true;
      } else if (stampedPrimary) {
        newLocationId = roomLoc;
      }
    }
    // Ocupación (SR-D1/D2): después de cupo+sala (claves tomadas) y de validar
    // la sala. Profesionales DISTINTOS en la sala que se solapan, o un bloqueo
    // de sala (§17.5) → aviso forzable; el mismo profesional nunca choca
    // consigo mismo (sus pacientes en paralelo son el cupo del servicio).
    if (roomKeyHeld && roomRow) {
      const occ = await countRoomOverlapsInTx(tx, {
        tenantId: actor.tenantId,
        roomId: roomRow.id,
        practitionerId: before.practitionerId,
        start: newWhen,
        end,
        now,
        capacity: roomRow.capacity,
        excludeId: id,
      });
      if (occ.atCapacity) {
        return {
          kind: "room-busy",
          roomName: roomRow.name,
          used: occ.used,
          capacity: occ.capacity,
          blocked: occ.blocked ? { reason: occ.blocked.reason } : null,
        };
      }
    }
  }
  const finalRoomId = roomTouched ? targetRoomId : before.roomId;
  const roomWrite = roomTouched && targetRoomId !== before.roomId;

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

  // S12 (C4): reactivar un turno de plan, con Booking → Session lockeados
  // DESPUÉS de cupo y sedes (C2) y antes de escribir nada.
  let stamp: PlanReactivationStamp | null = null;
  if (planReactivating) {
    const r = await lockPlanReactivationInTx(tx, {
      tenantId: actor.tenantId,
      bookingId: id,
      sessionId: before.sessionId!,
      expectedUpdatedAt: before.updatedAt,
      pricedByPlan: before.pricedByPlan,
    });
    if (r.kind === "stale") return { kind: "stale" };
    if (r.kind === "plan-session-not-pending") return { kind: "plan-session-not-pending", ordinal: r.ordinal };
    stamp = r.stamp;
  }

  // `updatedAt` in the where makes the optimistic lock atomic: a concurrent
  // write between the read above and here → P2025 → "stale", instead of
  // last-write-wins.
  let after: { updatedAt: Date };
  try {
    after = await tx.booking.update({
      where: { id, tenantId: actor.tenantId, updatedAt: before.updatedAt },
      data: {
        ...written,
        ...(promoteGuest ? { status: "CONFIRMED" as const } : {}),
        ...(newLocationId !== undefined ? { locationId: newLocationId } : {}),
        // SR: en el MISMO UPDATE que la sede (si no, 23503 por la FK compuesta
        // (roomId, locationId)). Solo si cambia: sin sala, la sentencia es la
        // de antes. Forzar la sala NO toca `isOverbooked` (SR-D2).
        ...(roomWrite ? { roomId: targetRoomId } : {}),
        ...(isOverbooked !== undefined ? { isOverbooked } : {}),
        ...tele,
        ...planStampData(stamp),
        // FX1b: en el MISMO UPDATE (sin sentencia nueva). Las tres juntas:
        // el CHECK de M5 (`calledAt` exige `arrivedAt`) no admite limpiar
        // `arrivedAt` dejando `calledAt`.
        ...(dayChanged ? { arrivedAt: null, calledAt: null, attendingAt: null } : {}),
      },
      select: { updatedAt: true },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") return { kind: "stale" };
    throw e;
  }
  // S12 (C4): la sesión, después del turno (Booking → Session). I3 solo con
  // el turno activo: uno cancelado que se mueve no arrastra la fecha planificada.
  const plan = isPlan
    ? await syncPlanSessionAfterBookingWriteInTx(tx, {
        tenantId: actor.tenantId,
        actorId: actor.userId ?? null,
        sessionId: before.sessionId!,
        beforeStatus: before.status,
        finalStatus,
        writeThroughAt: activeForSession(finalStatus) && (slotChanged || planReactivating) ? newWhen : null,
        now,
      })
    : null;
  // El profesional de un turno no cambia por edición (BookingUpdate no lo
  // trae): `prev` solo cuando se movió de horario o de sala, para que SV avise
  // también a la franja (y a la sala) vieja.
  const refs: BookingChangeRef[] = [
    {
      bookingId: id,
      practitionerId: before.practitionerId,
      scheduledFor: newWhen,
      roomId: finalRoomId,
      prev:
        slotChanged || roomWrite
          ? { practitionerId: before.practitionerId, scheduledFor: before.scheduledFor, roomId: before.roomId }
          : null,
      kind: "booking",
    },
  ];
  return {
    kind: "ok",
    before,
    updatedAt: after.updatedAt,
    written,
    refs,
    plan,
    ...(roomWrite ? { roomId: targetRoomId } : {}),
  };
}
