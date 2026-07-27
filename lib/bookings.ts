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
import { prisma } from "@/lib/db";
import { runWithRls } from "@/lib/rls";
import { getActor } from "@/lib/session";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { notify } from "@/lib/notifications-internal";
import { getParticularCopagoCents, resolveBookingCopagoCents } from "@/lib/billing-internal";
import { toARDow, toARHour, toARDateKey } from "@/lib/datetime-ar";
import { visibilityForActor, bulkPatientAccess } from "@/lib/visibility";
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

export async function listBookingsInRange(opts: {
  from: Date;
  to: Date;
  practitionerId?: string;
}): Promise<BookingRow[]> {
  const actor = await getActor();
  // Sprint 16: agenda shows every booking in the tenant; per-row access
  // tier is resolved below. The diagnosis chip is hidden when the actor
  // only has BASIC access to that booking's patient.
  const rows = await prisma.booking.findMany({
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
  });

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
      serviceName: b.service.name,
      practitionerId: b.practitionerId,
      patientId: b.patientId,
      patientName: name,
      patientCondition: cond,
      obraSocial,
      copagoCents,
      updatedAt: b.updatedAt,
      // Notes can carry clinical context — hide on basic too.
      notes: access === "full" ? b.notes : null,
      patientAccess: access,
    };
  });
}

export async function getDayCounts(opts: { from: Date; to: Date }) {
  const actor = await getActor();
  // Day-strip dots show every booking in the tenant — counts don't leak
  // PHI so no access gating needed here.
  const rows = await prisma.booking.findMany({
    where: {
      tenantId: actor.tenantId,
      scheduledFor: { gte: opts.from, lt: opts.to },
      status: { not: "CANCELLED" },
    },
    select: { scheduledFor: true },
  });
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
      prisma.service.findMany({
        where: { tenantId },
        orderBy: { name: "asc" },
      }),
    ["services:list", actor.tenantId],
    { tags: [tags.services(actor.tenantId)], revalidate: ttl.short }
  );
  return fetcher(actor.tenantId);
}

export async function listPractitioners() {
  const actor = await getActor();
  const fetcher = unstable_cache(
    async (tenantId: string) =>
      prisma.practitioner.findMany({
        where: { tenantId },
        include: { user: true },
        orderBy: { createdAt: "asc" },
      }),
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
  durationMin: number
): Promise<string | null> {
  const STEP_MIN = 15;
  const HORIZON_MS = 14 * 86_400_000;
  const start = new Date(from.getTime() + STEP_MIN * 60_000);
  // Resolve business hours alongside the bookings preload so we don't
  // do two sequential roundtrips.
  const [bookings, tenant] = await Promise.all([
    prisma.booking.findMany({
      where: {
        tenantId,
        practitionerId,
        status: { notIn: ["CANCELLED"] },
        scheduledFor: {
          gte: start,
          lt: new Date(start.getTime() + HORIZON_MS),
        },
      },
      select: { scheduledFor: true, durationMin: true },
    }),
    prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { businessHoursStart: true, businessHoursEnd: true },
    }),
  ]);
  const openHour = tenant?.businessHoursStart ?? 8;
  const closeHour = tenant?.businessHoursEnd ?? 19;
  const overlaps = (slot: Date, end: Date) =>
    bookings.some((b) => {
      const bEnd = new Date(b.scheduledFor.getTime() + b.durationMin * 60_000);
      return b.scheduledFor < end && bEnd > slot;
    });
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
      if (!overlaps(cursor, end)) {
        return cursor.toISOString();
      }
    }
    cursor.setTime(cursor.getTime() + STEP_MIN * 60_000);
  }
  return null;
}

export async function createBooking(
  raw: BookingCreateInput & { allowOverbooking?: boolean }
): Promise<
  ActionResult<{ id: string }> & {
    conflict?: {
      practitionerName: string;
      nextFreeISO: string | null;
    };
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

  if (data.patientId) {
    const owned = await prisma.patient.findFirst({
      where: { id: data.patientId, tenantId: actor.tenantId },
      select: { id: true },
    });
    if (!owned) return { ok: false, error: "Paciente fuera del tenant." };
  }
  const service = await prisma.service.findFirst({
    where: { id: data.serviceId, tenantId: actor.tenantId },
    select: { id: true, durationMin: true, name: true },
  });
  if (!service) return { ok: false, error: "Servicio inválido." };

  const duration = data.durationMin ?? service.durationMin;
  const end = new Date(data.scheduledFor.getTime() + duration * 60_000);

  // Conflict check for the SAME practitioner (other kines in the same
  // hour are fine — multiple boxes / kines in the same consultorio).
  // Fetch every candidate in the window (a turno starting up to 4h before
  // could still overlap a long session) and test them all — a single
  // unordered findFirst could return a non-overlapping row and miss the clash.
  const candidates = await prisma.booking.findMany({
    where: {
      tenantId: actor.tenantId,
      practitionerId: data.practitionerId,
      status: { notIn: ["CANCELLED"] },
      scheduledFor: {
        lt: end,
        gte: new Date(data.scheduledFor.getTime() - 240 * 60_000),
      },
    },
    select: { id: true, scheduledFor: true, durationMin: true },
  });
  const overlapping = candidates.some(
    (c) =>
      c.scheduledFor < end &&
      new Date(c.scheduledFor.getTime() + c.durationMin * 60_000) > data.scheduledFor
  );
  if (overlapping && !raw.allowOverbooking) {
    // Compute a suggestion + tell the UI it can re-call with
    // allowOverbooking=true to force a sobreturno.
    const [prac, suggestion] = await Promise.all([
      prisma.practitioner.findUnique({
        where: { id: data.practitionerId },
        include: { user: { select: { fullName: true, email: true } } },
      }),
      suggestNextFreeSlot(actor.tenantId, data.practitionerId, data.scheduledFor, duration),
    ]);
    return {
      ok: false,
      error: "El profesional ya tiene un turno en ese horario. Podés elegir el próximo libre o forzar un sobreturno.",
      conflict: {
        practitionerName: prac?.user.fullName ?? prac?.user.email ?? "El profesional",
        nextFreeISO: suggestion,
      },
    };
  }

  // Tag overbooked rows so the UI / reports can distinguish them. Until
  // we add a column, we prepend "[SOBRETURNO]" to the notes field.
  const notes =
    overlapping && raw.allowOverbooking
      ? `[SOBRETURNO] ${data.notes ?? ""}`.trim()
      : data.notes;

  // Deterministic idempotency key so a double-click / network retry converges
  // to ONE turno instead of two overlapping rows (the random key never
  // collided, so the @unique column gave no protection). Keyed by the stable
  // identity of the booking (patient, or the guest's email/phone). A real
  // sobreturno is a *different* patient at the same slot → different key →
  // still creates a separate row, so overbooking is preserved. A truly
  // anonymous booking (no patient, no guest contact) can't be deduped, so it
  // keeps a random key.
  const identity = data.patientId ?? data.guestEmail ?? data.guestPhone ?? null;
  const idempotencyKey = identity
    ? `${actor.tenantId}:${data.practitionerId}:${data.scheduledFor.toISOString()}:${identity}`
    : randomBytes(16).toString("hex");

  try {
    // RLS Etapa 2: the write itself runs under the GUC. The
    // preceding ownership / conflict checks already filter by
    // `tenantId` at the app layer (so they're safe outside the tx);
    // wrapping the write is enough to enforce policies on the row
    // that gets committed.
    // upsert on the unique idempotencyKey is atomic (Postgres ON CONFLICT):
    // concurrent submits collapse to one row. `update` resets the mutable
    // fields so a re-book of the same patient+slot (e.g. after cancelling)
    // converges to a single fresh active turno instead of returning a stale one.
    const b = await runWithRls(actor.tenantId, async (tx) =>
      tx.booking.upsert({
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
          status: data.patientId ? "CONFIRMED" : "PENDING",
          idempotencyKey,
        },
      })
    );
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
        const p = await prisma.patient.findUnique({
          where: { id: data.patientId },
          select: { firstName: true, lastName: true },
        });
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
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, error: "Turno duplicado." };
    }
    logger.error("booking.create.failed", { err: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: "No pudimos crear el turno." };
  }
}

export async function updateBooking(
  raw: BookingUpdateInput & { allowOverbooking?: boolean; expectedUpdatedAt?: string }
): Promise<
  ActionResult & {
    conflict?: { practitionerName: string; nextFreeISO: string | null };
  }
> {
  const actor = await getActor();
  const parsed = BookingUpdate.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Datos inválidos", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const { id, ...patch } = parsed.data;

  // Ownership lookup + optimistic-concurrency check + patient re-bind
  // validation + conflict re-check + the write, all under the tenant GUC in
  // one transaction. The conflict here uses `tx`; the prac-name + next-free
  // suggestion (read-only, advisory) are fetched outside on conflict.
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
    // Tenant-scope check on the re-bound patient (`null` = clear to guest;
    // `undefined` = leave alone) — atomic with the update.
    if (patch.patientId !== undefined && patch.patientId !== null) {
      const owned = await tx.patient.findFirst({
        where: { id: patch.patientId, tenantId: actor.tenantId },
        select: { id: true },
      });
      if (!owned) return { kind: "foreign-patient" as const };
    }
    // Re-check conflicts only when the slot actually moves.
    const newWhen = patch.scheduledFor ?? before.scheduledFor;
    const newDuration = patch.durationMin ?? before.durationMin;
    const slotChanged =
      patch.scheduledFor != null && +patch.scheduledFor !== +before.scheduledFor;
    if (slotChanged && patch.status !== "CANCELLED") {
      const end = new Date(newWhen.getTime() + newDuration * 60_000);
      const candidates = await tx.booking.findMany({
        where: {
          tenantId: actor.tenantId,
          practitionerId: before.practitionerId,
          id: { not: id },
          status: { notIn: ["CANCELLED"] },
          scheduledFor: {
            lt: end,
            gte: new Date(newWhen.getTime() - 240 * 60_000),
          },
        },
        select: { id: true, scheduledFor: true, durationMin: true },
      });
      const overlapping = candidates.some(
        (c) =>
          c.scheduledFor < end &&
          new Date(c.scheduledFor.getTime() + c.durationMin * 60_000) > newWhen
      );
      if (overlapping && !raw.allowOverbooking) {
        return { kind: "conflict" as const, before, newWhen, newDuration };
      }
    }
    await tx.booking.update({ where: { id }, data: patch });
    return { kind: "ok" as const, before };
  });

  if (outcome.kind === "notfound") return { ok: false, error: "Turno no encontrado." };
  if (outcome.kind === "stale") {
    return { ok: false, error: "El turno cambió en otra sesión. Refrescá la agenda y reintentá." };
  }
  if (outcome.kind === "foreign-patient") return { ok: false, error: "Paciente fuera del consultorio." };
  if (outcome.kind === "conflict") {
    const [prac, suggestion] = await Promise.all([
      prisma.practitioner.findUnique({
        where: { id: outcome.before.practitionerId },
        include: { user: { select: { fullName: true, email: true } } },
      }),
      suggestNextFreeSlot(actor.tenantId, outcome.before.practitionerId, outcome.newWhen, outcome.newDuration),
    ]);
    return {
      ok: false,
      error: "El profesional ya tiene un turno en ese horario.",
      conflict: {
        practitionerName: prac?.user.fullName ?? prac?.user.email ?? "El profesional",
        nextFreeISO: suggestion,
      },
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
  invalidateBookingDerivedCaches(actor.tenantId);
  return { ok: true, data: undefined };
}

export async function setBookingStatus(
  id: string,
  status: BookingStatus,
  expectedUpdatedAt?: string
): Promise<ActionResult> {
  return updateBooking({ id, status, expectedUpdatedAt });
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
        payment: { select: { status: true } },
      },
    });
    if (!row) return { kind: "notfound" as const };
    if (expectedUpdatedAt && +row.updatedAt !== +new Date(expectedUpdatedAt)) {
      return { kind: "stale" as const };
    }
    // Payment FK is onDelete: Restrict, so a paid turno can't be silently
    // wiped. Refuse the delete if a real payment is attached; for an
    // abandoned checkout (UNPAID/FAILED) clean up the orphan payment first
    // so the Restrict constraint is satisfied.
    const pay = row.payment;
    if (pay && (pay.status === "AUTHORIZED" || pay.status === "PAID" || pay.status === "REFUNDED")) {
      return { kind: "has-payment" as const };
    }
    if (pay) {
      await tx.payment.delete({ where: { bookingId: id } });
    }
    await tx.booking.delete({ where: { id } });
    return { kind: "ok" as const, patientId: row.patientId };
  });
  if (outcome.kind === "notfound") return { ok: false, error: "Turno no encontrado." };
  if (outcome.kind === "stale") {
    return { ok: false, error: "El turno cambió en otra sesión. Refrescá la agenda y reintentá." };
  }
  if (outcome.kind === "has-payment") {
    return {
      ok: false,
      error: "Este turno tiene un pago registrado. Cancelalo en vez de eliminarlo para conservar el comprobante.",
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
 * Confirm / un-confirm that the obra social reimbursement for a turno was
 * received. Backs the "Confirmar pago Obra social" action in the patient's
 * Facturación tab. Tenant-scoped; `paid=false` clears the confirmation.
 */
export async function setBookingInsurerPaid(
  id: string,
  paid: boolean
): Promise<ActionResult> {
  const actor = await getActor();
  const owned = await prisma.booking.findFirst({
    where: { id, tenantId: actor.tenantId },
    select: { id: true, patientId: true },
  });
  if (!owned) return { ok: false, error: "Turno no encontrado." };
  await prisma.booking.update({
    where: { id },
    data: { insurerPaidAt: paid ? new Date() : null },
  });
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: paid ? "booking.insurer_paid" : "booking.insurer_unpaid",
    entity: "Booking",
    entityId: id,
  });
  if (owned.patientId) revalidatePath(`/pacientes/${owned.patientId}`);
  invalidateBookingDerivedCaches(actor.tenantId);
  return { ok: true, data: undefined };
}

/**
 * Mark a turno's copago as collected / pending (in-person payments) by
 * flipping `Booking.paymentStatus` between PAID and UNPAID. Complements the
 * OS confirmation so the Facturación tab tracks both sides.
 */
export async function setBookingCopagoPaid(
  id: string,
  paid: boolean
): Promise<ActionResult> {
  const actor = await getActor();
  const owned = await prisma.booking.findFirst({
    where: { id, tenantId: actor.tenantId },
    select: { id: true, patientId: true },
  });
  if (!owned) return { ok: false, error: "Turno no encontrado." };
  await prisma.booking.update({
    where: { id },
    data: { paymentStatus: paid ? "PAID" : "UNPAID" },
  });
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: paid ? "booking.copago_paid" : "booking.copago_unpaid",
    entity: "Booking",
    entityId: id,
  });
  if (owned.patientId) revalidatePath(`/pacientes/${owned.patientId}`);
  invalidateBookingDerivedCaches(actor.tenantId);
  return { ok: true, data: undefined };
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
export async function createBookingsBatch(
  raw: BookingCreateInput & { count: number; daysOfWeek?: number[] }
): Promise<ActionResult<{ created: number; skipped: number; requested: number }>> {
  const actor = await getActor();
  const parsed = BookingCreate.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Datos inválidos", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const data = parsed.data;
  const count = Math.min(60, Math.max(1, Math.floor(raw.count ?? 1)));
  const service = await prisma.service.findFirst({
    where: { id: data.serviceId, tenantId: actor.tenantId },
    select: { id: true, durationMin: true },
  });
  if (!service) return { ok: false, error: "Servicio inválido." };
  const duration = data.durationMin ?? service.durationMin;

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
  // Stable identity for the per-slot idempotency key (same rationale as
  // createBooking): a double-submitted batch converges to the same turnos
  // instead of duplicating them. Anonymous batches keep a random key.
  const identity = data.patientId ?? data.guestEmail ?? data.guestPhone ?? null;

  let created = 0;
  let skipped = 0;
  for (const when of dates) {
    const end = new Date(when.getTime() + duration * 60_000);
    const candidates = await prisma.booking.findMany({
      where: {
        tenantId: actor.tenantId,
        practitionerId: data.practitionerId,
        status: { notIn: ["CANCELLED"] },
        scheduledFor: {
          gte: new Date(when.getTime() - 240 * 60_000),
          lt: end,
        },
      },
      select: { id: true, scheduledFor: true, durationMin: true },
    });
    const overlap = candidates.some(
      (c) =>
        c.scheduledFor < end &&
        new Date(c.scheduledFor.getTime() + c.durationMin * 60_000) > when
    );
    if (overlap) {
      skipped++;
      continue;
    }
    const idempotencyKey = identity
      ? `${actor.tenantId}:${data.practitionerId}:${when.toISOString()}:${identity}`
      : randomBytes(16).toString("hex");
    try {
      await prisma.booking.upsert({
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
          notes: data.notes,
          status: data.patientId ? "CONFIRMED" : "PENDING",
          seriesId,
          idempotencyKey,
        },
      });
      created++;
    } catch (e) {
      // Genuine conflicts are already filtered out by the overlap check
      // above, so a failure here is unexpected (DB/RLS/transient). Log it
      // so it's diagnosable, then skip the slot to keep the batch going.
      logger.error("createBookingsBatch: slot creation failed", {
        tenantId: actor.tenantId,
        practitionerId: data.practitionerId,
        scheduledFor: when.toISOString(),
        err: e instanceof Error ? e.message : String(e),
      });
      skipped++;
    }
  }
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "booking.batch.create",
    entity: "Booking",
    payload: { created, skipped, requested: count, seriesId },
  });
  revalidatePath("/agenda");
  if (data.patientId) revalidatePath(`/pacientes/${data.patientId}`);
  invalidateBookingDerivedCaches(actor.tenantId);
  return { ok: true, data: { created, skipped, requested: count } };
}

/**
 * Build a minimal `.ics` representation of every booking in a window.
 * The route handler stamps the right Content-Type / filename.
 */
export async function exportBookingsIcs(opts: { from: Date; to: Date }): Promise<string> {
  const actor = await getActor();
  const rows = await prisma.booking.findMany({
    where: {
      tenantId: actor.tenantId,
      scheduledFor: { gte: opts.from, lt: opts.to },
      status: { notIn: ["CANCELLED"] },
    },
    include: { patient: true, service: true },
    orderBy: { scheduledFor: "asc" },
  });
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//KineSoft//ES//ES",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];
  for (const b of rows) {
    const end = new Date(b.scheduledFor.getTime() + b.durationMin * 60_000);
    const who = b.patient ? `${b.patient.firstName} ${b.patient.lastName}` : b.guestName ?? "Reserva";
    lines.push(
      "BEGIN:VEVENT",
      `UID:${b.id}@kinesoft`,
      `DTSTAMP:${ics(new Date())}`,
      `DTSTART:${ics(b.scheduledFor)}`,
      `DTEND:${ics(end)}`,
      `SUMMARY:${escapeIcs(b.service.name + " · " + who)}`,
      b.notes ? `DESCRIPTION:${escapeIcs(b.notes)}` : "",
      `STATUS:${b.status === "CONFIRMED" ? "CONFIRMED" : "TENTATIVE"}`,
      "END:VEVENT"
    );
  }
  lines.push("END:VCALENDAR");
  return lines.filter(Boolean).join("\r\n") + "\r\n";
}

function ics(d: Date) {
  return d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

function escapeIcs(s: string) {
  // Per RFC 5545: backslash, comma, semicolon must be escaped; newlines
  // become literal "\n". Backslashes must be escaped FIRST so we don't
  // double-escape the ones we add.
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}
