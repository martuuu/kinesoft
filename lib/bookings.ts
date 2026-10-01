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
import { toARDow, toARHour, toARDateKey } from "@/lib/datetime-ar";
import { bulkPatientAccess, patientAccessFor } from "@/lib/visibility";
import type { Actor } from "@/lib/session";
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
  BookingCreate,
  BookingUpdate,
  type ActionResult,
  type BookingCreateInput,
  type BookingUpdateInput,
} from "@/lib/validation";

import type { BookingRow } from "@/lib/bookings-types";

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

/** Guest (sin paciente) = operable; con paciente, exige acceso `full`. */
async function hasFullAccess(actor: Actor, patientId: string | null, tx: Tx): Promise<boolean> {
  if (!patientId) return true;
  return (await patientAccessFor(actor, patientId, tx)) === "full";
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
 */
function acceptClientKey(k: unknown): string | null {
  if (typeof k !== "string" || k.length < 8 || k.length > 64) return null;
  if (k.startsWith("pub:")) return null;
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
  // AR calendar-day bounds in UTC: AR midnight = 03:00 UTC (UTC-3, sin DST).
  const dayKey = toARDateKey(o.start);
  const dayStart = new Date(`${dayKey}T03:00:00.000Z`);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60_000);
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
            take: 1,
          },
        },
      },
    },
  }));

  const patientIds = rows
    .map((b) => b.patientId)
    .filter((id): id is string => !!id);
  const [accessMap, particularCopago] = await Promise.all([
    bulkPatientAccess(actor, patientIds),
    getParticularCopagoCents(actor.tenantId),
  ]);

  return rows.map((b): BookingRow => {
    const access: "full" | "basic" | "none" = b.patientId
      ? (accessMap.get(b.patientId) ?? "basic")
      : "none";
    const cond =
      access === "full"
        ? b.patient?.programs[0]?.case?.diagnoses[0]?.condition?.name ?? null
        : null;
    const name = b.patient
      ? `${b.patient.firstName} ${b.patient.lastName}`
      : b.guestName ?? "Sin asignar";
    // Billing: resolve obra social + copago from the patient's active
    // coverage. Particular (no insurer / no coverage / guest) falls back
    // to "Particular" with the service price as the amount the patient
    // pays out of pocket. Gated to full access — basic-access rows hide
    // billing PHI (consistent with notes/condition above).
    const coverage = access === "full" ? b.patient?.coverages[0] : undefined;
    const insurer = coverage?.insurerRef;
    const obraSocial =
      access === "full"
        ? insurer?.name ?? coverage?.insurer ?? "Particular"
        : "Particular";
    // Copago precedence: per-turno override → per-patient override →
    // insurer → Particular → service price. Basic-access rows hide billing
    // and just show the service price.
    const copagoCents =
      access === "full"
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
      // basic (A2a-S06: title/description leaked before). Guest rows
      // ("none", no patient) are the front desk's own turnos: visible and
      // operable, so their notes aren't blanked either (the drawer edit form
      // would show them empty).
      notes: access !== "basic" ? b.notes : null,
      title: access !== "basic" ? b.title : null,
      description: access !== "basic" ? b.description : null,
      patientAccess: access,
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

/**
 * Find the next slot of `durationMin` after `from` for `practitionerId`
 * that doesn't overlap with any non-cancelled booking. Walks in 15-min
 * steps within the tenant's configured business hours, Mon-Sat, capped
 * at 14 days lookahead. Returns null if nothing free within the window.
 *
 * Business hours come from `Tenant.businessHoursStart/End` (Sprint 17).
 */
async function suggestNextFreeSlot(
  tenantId: string,
  practitionerId: string,
  from: Date,
  durationMin: number,
  serviceId: string,
  maxConcurrent: number | null
): Promise<string | null> {
  const STEP_MIN = 15;
  const HORIZON_MS = 14 * 86_400_000;
  const start = new Date(from.getTime() + STEP_MIN * 60_000);
  // Resolve business hours alongside the bookings preload so we don't
  // do two sequential roundtrips.
  const [bookings, tenant] = await Promise.all([
    runWithRls(tenantId, (tx) => tx.booking.findMany({
      where: {
        tenantId,
        practitionerId,
        serviceId,
        status: { notIn: ["CANCELLED"] },
        scheduledFor: {
          gte: start,
          lt: new Date(start.getTime() + HORIZON_MS),
        },
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
    })),
    runWithRls(tenantId, (tx) => tx.tenant.findUnique({
      where: { id: tenantId },
      select: { businessHoursStart: true, businessHoursEnd: true },
    })),
  ]);
  // Same predicate as the capacity checks: an expired unpaid public pending
  // no longer holds the slot, so it mustn't push the suggestion further out.
  const now = new Date();
  const holding = bookings.filter((b) => isHoldingCapacity(b, now));
  const openHour = tenant?.businessHoursStart ?? 8;
  const closeHour = tenant?.businessHoursEnd ?? 19;
  // A slot is "free" when adding this turno wouldn't exceed the service's
  // per-horario capacity — counting SAME-service overlaps only.
  const atCapacity = (slot: Date, end: Date) =>
    overlapBlocks(
      holding.filter((b) => {
        const bEnd = new Date(b.scheduledFor.getTime() + b.durationMin * 60_000);
        return b.scheduledFor < end && bEnd > slot;
      }).length,
      maxConcurrent
    );
  const cursor = new Date(start);
  // Round to next 15-min boundary.
  cursor.setMinutes(Math.ceil(cursor.getMinutes() / STEP_MIN) * STEP_MIN, 0, 0);
  while (cursor.getTime() - from.getTime() < HORIZON_MS) {
    // Gate against the AR wall-clock, not the host's — openHour/closeHour are
    // AR business hours, so on a UTC host `getDay()`/`getHours()` would be
    // 3h off and could skip Saturday or include Sunday. The 15-min rounding
    // above stays on host minutes (AR's offset is whole hours, so identical).
    const dow = toARDow(cursor); // 0 Sun..6 Sat in AR
    const arHour = toARHour(cursor); // fractional AR hour, e.g. 14.5
    // Slot must fit entirely inside the business window.
    const endMinutes = arHour * 60 + durationMin;
    if (dow !== 0 && arHour >= openHour && endMinutes <= closeHour * 60) {
      const end = new Date(cursor.getTime() + durationMin * 60_000);
      if (!atCapacity(cursor, end)) {
        return cursor.toISOString();
      }
    }
    cursor.setTime(cursor.getTime() + STEP_MIN * 60_000);
  }
  return null;
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

  // Ids de entrada validados contra el tenant ANTES de escribir: las FK
  // saltean RLS y en prod la conexión tiene BYPASSRLS, así que un
  // `practitionerId` de otro consultorio se persistía tal cual (IDOR, A2a-S06).
  // El paciente además tiene que ser de acceso `full` (acceso básico = solo ver).
  // El diagnóstico por defecto del paciente auto-completa title/description
  // del turno cuando el caller no los envía (overridable por turno).
  const pre = await runWithRls(actor.tenantId, async (tx) => {
    const [patient, service, prac] = await Promise.all([
      data.patientId
        ? tx.patient.findFirst({
            where: { id: data.patientId, tenantId: actor.tenantId },
            select: { id: true, diagnosisTitle: true, diagnosisNote: true },
          })
        : Promise.resolve(null),
      tx.service.findFirst({
        where: { id: data.serviceId, tenantId: actor.tenantId },
        select: { id: true, durationMin: true, name: true, maxConcurrent: true },
      }),
      tx.practitioner.findFirst({
        where: { id: data.practitionerId, tenantId: actor.tenantId },
        select: { id: true },
      }),
    ]);
    if (data.patientId && !patient) return { kind: "foreign-patient" as const };
    if (!prac) return { kind: "foreign-practitioner" as const };
    if (!service) return { kind: "bad-service" as const };
    if (patient && !(await hasFullAccess(actor, patient.id, tx))) {
      return { kind: "basic" as const };
    }
    return { kind: "ok" as const, patient, service };
  });
  if (pre.kind === "foreign-patient") return { ok: false, error: "Paciente fuera del tenant." };
  if (pre.kind === "foreign-practitioner") return { ok: false, error: "Profesional inválido." };
  if (pre.kind === "bad-service") return { ok: false, error: "Servicio inválido." };
  if (pre.kind === "basic") return { ok: false, error: BASIC_ACCESS_ERROR };
  const { service } = pre;
  const patientDiag = pre.patient;

  const duration = data.durationMin ?? service.durationMin;
  const end = new Date(data.scheduledFor.getTime() + duration * 60_000);
  const now = new Date();

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
  if (data.patientId && !(raw.allowSamePatientDay && raw.allowPatientOverlap)) {
    const pat = await runWithRls(actor.tenantId, (tx) =>
      checkPatientOverlap(tx, {
        tenantId: actor.tenantId,
        patientId: data.patientId!,
        start: data.scheduledFor,
        end,
        excludeKey: clientKey,
      })
    );
    // A turno at the EXACT same instant is structurally impossible — the
    // partial unique index (tenant, patient, scheduledFor) rejects it. Say so
    // up front instead of offering a confirmation that can never succeed
    // (the batch path reports this same case as "duplicado").
    if (pat.sameInstant) return { ok: false, error: SAME_INSTANT_ERROR };
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

  // Overlap capacity check, scoped to the SAME practitioner + SAME service.
  // Overlaps are allowed up to `Service.maxConcurrent` (null = ilimitado, el
  // caso normal en kinesiología: varios pacientes en paralelo en la franja).
  // An expired unpaid public reservation no longer holds the slot.
  const overlapCount = await runWithRls(actor.tenantId, (tx) =>
    countCapacityOverlaps(tx, {
      tenantId: actor.tenantId,
      practitionerId: data.practitionerId,
      serviceId: data.serviceId,
      start: data.scheduledFor,
      end,
      now,
      excludeKey: clientKey,
    })
  );
  const capacityReached = overlapBlocks(overlapCount, service.maxConcurrent);
  if (capacityReached && !raw.allowOverbooking) {
    // Compute a suggestion + tell the UI it can re-call with
    // allowOverbooking=true to force a sobreturno.
    const [practitionerName, suggestion] = await Promise.all([
      runWithRls(actor.tenantId, (tx) => practitionerLabel(tx, actor.tenantId, data.practitionerId)),
      suggestNextFreeSlot(actor.tenantId, data.practitionerId, data.scheduledFor, duration, data.serviceId, service.maxConcurrent),
    ]);
    return {
      ok: false,
      error: "El profesional ya tiene un turno en ese horario. Podés elegir el próximo libre o forzar un sobreturno.",
      conflict: { practitionerName, nextFreeISO: suggestion },
    };
  }

  // Tag overbooked rows so the UI / reports can distinguish them. Until
  // we add a column, we prepend "[SOBRETURNO]" to the notes field.
  const notes =
    capacityReached && raw.allowOverbooking
      ? `[SOBRETURNO] ${data.notes ?? ""}`.trim()
      : data.notes;

  // Auto-fill the per-turno mini-diagnóstico from the patient's default when
  // the caller didn't provide an explicit title/description.
  const title = data.title ?? patientDiag?.diagnosisTitle ?? null;
  const description = data.description ?? patientDiag?.diagnosisNote ?? null;

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
    const b = await runWithRls(actor.tenantId, async (tx) => {
      // The key is CLIENT-supplied and globally @unique: with BYPASSRLS (prod)
      // a key that belongs to ANOTHER tenant's row would make the upsert's
      // `update` branch overwrite that row. Refuse it. (Under RLS the row is
      // invisible here and the ON CONFLICT update fails the policy instead.)
      const holder = await tx.booking.findUnique({
        where: { idempotencyKey },
        select: { tenantId: true },
      });
      if (holder && holder.tenantId !== actor.tenantId) return null;
      return tx.booking.upsert({
        where: { idempotencyKey },
        update: {
          serviceId: service.id,
          durationMin: duration,
          copagoCents: data.copagoCents ?? null,
          notes,
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
          copagoCents: data.copagoCents ?? null,
          patientId: data.patientId,
          guestName: data.guestName,
          guestEmail: data.guestEmail,
          guestPhone: data.guestPhone,
          notes,
          title,
          description,
          status: data.patientId ? "CONFIRMED" : "PENDING",
          idempotencyKey,
        },
      });
    });
    if (!b) return { ok: false, error: "No pudimos crear el turno." };
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
};

export async function updateBooking(
  raw: BookingUpdateInput & {
    allowOverbooking?: boolean;
    // Same flag as createBooking: the front desk confirmed the patient may
    // have two turnos overlapping (two services in parallel).
    allowPatientOverlap?: boolean;
    expectedUpdatedAt?: string;
  }
): Promise<UpdateBookingResult> {
  const actor = await getActor();
  const parsed = BookingUpdate.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Datos inválidos", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const { id, ...patch } = parsed.data;
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
        service: { select: { maxConcurrent: true } },
        updatedAt: true,
        patient: { select: { firstName: true, lastName: true } },
      },
    });
    if (!before) return { kind: "notfound" as const };
    // Optimistic concurrency: reject if the row changed since the client
    // (e.g. the BookingDrawer) loaded it — prevents acting on a stale view.
    if (raw.expectedUpdatedAt && +before.updatedAt !== +new Date(raw.expectedUpdatedAt)) {
      return { kind: "stale" as const };
    }
    // Acceso básico = solo ver: ni estado, ni reprogramar, ni notas.
    if (!(await hasFullAccess(actor, before.patientId, tx))) return { kind: "basic" as const };
    // Tenant-scope + access check on the re-bound patient (`undefined` = leave
    // alone) — atomic with the update.
    const patientChanged = patch.patientId !== undefined && patch.patientId !== before.patientId;
    if (patientChanged) {
      const owned = await tx.patient.findFirst({
        where: { id: patch.patientId, tenantId: actor.tenantId },
        select: { id: true },
      });
      if (!owned) return { kind: "foreign-patient" as const };
      if (!(await hasFullAccess(actor, owned.id, tx))) return { kind: "basic" as const };
    }

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
    if (finalStatus !== "CANCELLED") {
      if (finalPatientId && (windowChanged || patientChanged)) {
        const pat = await checkPatientOverlap(tx, {
          tenantId: actor.tenantId,
          patientId: finalPatientId,
          start: newWhen,
          end,
          excludeId: id,
        });
        if (pat.sameInstant) return { kind: "patient-slot" as const };
        if (pat.overlapISO && !raw.allowPatientOverlap) {
          return { kind: "patient-overlap" as const, existingISO: pat.overlapISO };
        }
      }
      if (windowChanged) {
        const overlapCount = await countCapacityOverlaps(tx, {
          tenantId: actor.tenantId,
          practitionerId: before.practitionerId,
          serviceId: before.serviceId,
          start: newWhen,
          end,
          now,
          excludeId: id,
        });
        if (overlapBlocks(overlapCount, before.service?.maxConcurrent) && !raw.allowOverbooking) {
          return { kind: "conflict" as const, before, newWhen, newDuration };
        }
      }
    }
    // `updatedAt` in the where makes the optimistic lock atomic: a concurrent
    // write between the read above and here → P2025 → "stale" (below), instead
    // of last-write-wins.
    const after = await tx.booking.update({
      where: { id, tenantId: actor.tenantId, updatedAt: before.updatedAt },
      data: promoteGuest ? { ...patch, status: "CONFIRMED" } : patch,
      select: { updatedAt: true },
    });
    return { kind: "ok" as const, before, updatedAt: after.updatedAt };
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
  if (outcome.kind === "conflict") {
    const [practitionerName, suggestion] = await Promise.all([
      runWithRls(actor.tenantId, (tx) => practitionerLabel(tx, actor.tenantId, outcome.before.practitionerId)),
      suggestNextFreeSlot(actor.tenantId, outcome.before.practitionerId, outcome.newWhen, outcome.newDuration, outcome.before.serviceId, outcome.before.service?.maxConcurrent ?? null),
    ]);
    return {
      ok: false,
      error: "El profesional ya tiene un turno en ese horario.",
      conflict: { practitionerName, nextFreeISO: suggestion },
    };
  }

  const before = outcome.before;
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "booking.update",
    entity: "Booking",
    entityId: id,
    payload: patch as Record<string, unknown>,
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
  force?: { allowOverbooking?: boolean; allowPatientOverlap?: boolean }
): Promise<UpdateBookingResult> {
  // Revisión A2: volver a PENDING no es una transición de la agenda (ver
  // BookingUpdate). La firma sigue aceptando `BookingStatus` por los callers.
  if (status === "PENDING") return { ok: false, error: "Datos inválidos" };
  return updateBooking({ id, status, expectedUpdatedAt, ...force });
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
/** Per-date outcome of a multi-turno batch. */
export type BatchSlotStatus =
  /** Nothing in the way — creates cleanly. */
  | "libre"
  /** Capacity reached for the professional, or the patient already has an
   *  overlapping turno. Creatable as an explicit sobreturno. */
  | "sobreturno"
  /** The patient already has an ACTIVE turno at this exact instant — the DB
   *  unique index forbids a second one, so it can never be created. */
  | "duplicado";

export type BatchOutcome = {
  /** True when nothing was written (preflight). */
  dryRun: boolean;
  requested: number;
  dates: { iso: string; status: BatchSlotStatus }[];
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
 *     rows `[SOBRETURNO]` like the single-create path does.
 *   · `allowOverbooking: false` → creates only the free slots (an explicit
 *     choice now, not the silent skip it used to be).
 * `duplicado` slots are never creatable and are always reported separately.
 */
export async function createBookingsBatch(
  raw: BookingCreateInput & {
    count: number;
    daysOfWeek?: number[];
    idempotencyKey?: string;
    dryRun?: boolean;
    allowOverbooking?: boolean;
  }
): Promise<ActionResult<BatchOutcome>> {
  const actor = await getActor();
  const parsed = BookingCreate.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Datos inválidos", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const data = parsed.data;
  const count = Math.min(60, Math.max(1, Math.floor(raw.count ?? 1)));
  // Ids de entrada validados contra el tenant ANTES de escribir (A2a-S06): el
  // paciente solo se usaba para leer el diagnóstico — si era de otro tenant la
  // lectura daba null y el batch creaba igual N turnos apuntando a él (las FK
  // saltean RLS). Mismo contrato que createBooking: profesional del tenant y
  // paciente con acceso `full`. Un dryRun también se rechaza: el preflight
  // expone la ocupación del paciente.
  const pre = await runWithRls(actor.tenantId, async (tx) => {
    const [patient, service, prac] = await Promise.all([
      data.patientId
        ? tx.patient.findFirst({
            where: { id: data.patientId, tenantId: actor.tenantId },
            select: { id: true, diagnosisTitle: true, diagnosisNote: true },
          })
        : Promise.resolve(null),
      tx.service.findFirst({
        where: { id: data.serviceId, tenantId: actor.tenantId },
        select: { id: true, durationMin: true, maxConcurrent: true },
      }),
      tx.practitioner.findFirst({
        where: { id: data.practitionerId, tenantId: actor.tenantId },
        select: { id: true },
      }),
    ]);
    if (data.patientId && !patient) return { kind: "foreign-patient" as const };
    if (!prac) return { kind: "foreign-practitioner" as const };
    if (!service) return { kind: "bad-service" as const };
    if (patient && !(await hasFullAccess(actor, patient.id, tx))) {
      return { kind: "basic" as const };
    }
    return { kind: "ok" as const, patient, service };
  });
  if (pre.kind === "foreign-patient") return { ok: false, error: "Paciente fuera del tenant." };
  if (pre.kind === "foreign-practitioner") return { ok: false, error: "Profesional inválido." };
  if (pre.kind === "bad-service") return { ok: false, error: "Servicio inválido." };
  if (pre.kind === "basic") return { ok: false, error: BASIC_ACCESS_ERROR };
  const { service } = pre;
  const duration = data.durationMin ?? service.durationMin;

  // Diagnóstico por defecto del paciente para auto-completar title/description
  // de cada turno del batch cuando el caller no los envía.
  const patientDiag = pre.patient;
  const title = data.title ?? patientDiag?.diagnosisTitle ?? null;
  const description = data.description ?? patientDiag?.diagnosisNote ?? null;

  // AR-correct date expansion. `data.scheduledFor` is a real instant tagged
  // -03:00 by `localToARIso` on the client. Empty weekday selection → repeat
  // weekly on the anchor's own AR weekday.
  const anchor = data.scheduledFor;
  const dowSet = new Set((raw.daysOfWeek ?? []).map((d) => ((d % 7) + 7) % 7)); // 0=Mon..6=Sun
  if (dowSet.size === 0) dowSet.add((toARDow(anchor) + 6) % 7);

  const dates: Date[] = [];
  let cursor = new Date(anchor);
  let guard = 0;
  while (dates.length < count && guard++ < 400) {
    const monDow = (toARDow(cursor) + 6) % 7; // 0=Mon..6=Sun in AR
    if (dowSet.has(monDow)) dates.push(new Date(cursor));
    cursor = new Date(cursor.getTime() + 86_400_000); // +1 AR day (DST-free)
  }

  // Tag the batch so it can be regrouped into a "plan" later.
  const seriesId = randomBytes(12).toString("hex");
  // Per-slot idempotency base. Prefer the client's stable key (so a
  // double-submitted batch converges to the same turnos instead of
  // duplicating), else the fresh seriesId. Either way it's SCOPED to this
  // batch — it can never collide with a pre-existing single turno's key (the
  // old `tenant:prof:slot:patient` shape did, silently mapping onto it).
  const keyBase = acceptClientKey(raw.idempotencyKey) ?? seriesId;

  // One query for the whole span instead of two per slot: everything that can
  // conflict is either same practitioner+service (capacity) or same patient
  // (own overlap / exact-instant duplicate).
  const spanStart = new Date(dates[0].getTime() - 240 * 60_000);
  const spanEnd = new Date(
    dates[dates.length - 1].getTime() + duration * 60_000 + 240 * 60_000
  );
  const existing = await runWithRls(actor.tenantId, (tx) => tx.booking.findMany({
    where: {
      tenantId: actor.tenantId,
      status: { notIn: ["CANCELLED"] },
      scheduledFor: { gte: spanStart, lt: spanEnd },
      OR: [
        { practitionerId: data.practitionerId, serviceId: data.serviceId },
        ...(data.patientId ? [{ patientId: data.patientId }] : []),
      ],
    },
    select: {
      scheduledFor: true,
      durationMin: true,
      practitionerId: true,
      serviceId: true,
      patientId: true,
      status: true,
      paymentStatus: true,
      createdAt: true,
      idempotencyKey: true,
    },
  }));
  const now = new Date();

  const classify = (when: Date): BatchSlotStatus => {
    const end = new Date(when.getTime() + duration * 60_000);
    const overlaps = (e: { scheduledFor: Date; durationMin: number }) =>
      e.scheduledFor < end && new Date(e.scheduledFor.getTime() + e.durationMin * 60_000) > when;

    if (data.patientId) {
      // Exact instant → the partial unique index makes this uncreatable.
      if (existing.some((e) => e.patientId === data.patientId && +e.scheduledFor === +when)) {
        return "duplicado";
      }
      // The patient is busy elsewhere in this window (any professional/service).
      if (existing.some((e) => e.patientId === data.patientId && overlaps(e))) {
        return "sobreturno";
      }
    }
    // Capacity only: an expired unpaid public pending no longer holds the cupo
    // (isHoldingCapacity). The patient checks above use every row — the unique
    // index still rejects the exact instant of a PENDING row.
    const capacityCount = existing.filter(
      (e) =>
        e.practitionerId === data.practitionerId &&
        e.serviceId === data.serviceId &&
        isHoldingCapacity(e, now) &&
        overlaps(e)
    ).length;
    return overlapBlocks(capacityCount, service.maxConcurrent) ? "sobreturno" : "libre";
  };

  const plan = dates.map((when) => ({ when, status: classify(when) }));
  const free = plan.filter((p) => p.status === "libre").length;
  const conflicted = plan.filter((p) => p.status === "sobreturno").length;
  const duplicates = plan.filter((p) => p.status === "duplicado").length;
  const datesOut = plan.map((p) => ({ iso: p.when.toISOString(), status: p.status }));

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

  for (const { when, status } of plan) {
    // Never creatable — the DB index would reject it anyway.
    if (status === "duplicado") continue;
    // Conflicting slot the caller chose NOT to force.
    if (status === "sobreturno" && !raw.allowOverbooking) {
      omitted++;
      continue;
    }
    const isOverbook = status === "sobreturno";
    // Same tagging the single-create path uses, so reports can tell them apart.
    const notes = isOverbook ? `[SOBRETURNO] ${data.notes ?? ""}`.trim() : data.notes;
    const idempotencyKey = `${keyBase}:${when.toISOString()}`;
    try {
      await runWithRls(actor.tenantId, (tx) => tx.booking.upsert({
        where: { idempotencyKey },
        update: {},
        create: {
          tenantId: actor.tenantId,
          practitionerId: data.practitionerId,
          serviceId: service.id,
          scheduledFor: when,
          durationMin: duration,
          copagoCents: data.copagoCents ?? null,
          patientId: data.patientId,
          guestName: data.guestName,
          guestEmail: data.guestEmail,
          guestPhone: data.guestPhone,
          notes,
          title,
          description,
          status: data.patientId ? "CONFIRMED" : "PENDING",
          seriesId,
          idempotencyKey,
        },
      }));
      created++;
      if (isOverbook) sobreturnos++;
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
        if (isOverbook) sobreturnos++;
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
