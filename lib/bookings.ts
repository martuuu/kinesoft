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
import { notify } from "@/lib/notifications-internal";
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
  const accessMap = await bulkPatientAccess(actor, patientIds);

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
    const copagoCents =
      access === "full"
        ? insurer
          ? insurer.copagoCents
          : b.service.priceCents
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
    const k = r.scheduledFor.toISOString().slice(0, 10);
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
    const dow = cursor.getDay(); // 0 Sun..6 Sat
    const hour = cursor.getHours();
    // Slot must fit entirely inside the business window — the end of
    // the proposed booking is hour + minutes/60 + durationMin/60.
    const endMinutes = hour * 60 + cursor.getMinutes() + durationMin;
    if (dow !== 0 && hour >= openHour && endMinutes <= closeHour * 60) {
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
  const clash = await prisma.booking.findFirst({
    where: {
      tenantId: actor.tenantId,
      practitionerId: data.practitionerId,
      status: { notIn: ["CANCELLED"] },
      scheduledFor: { lt: end },
      AND: [
        {
          scheduledFor: { gte: new Date(data.scheduledFor.getTime() - 240 * 60_000) },
        },
      ],
    },
    select: { id: true, scheduledFor: true, durationMin: true },
  });
  const overlapping =
    clash &&
    clash.scheduledFor < end &&
    new Date(clash.scheduledFor.getTime() + clash.durationMin * 60_000) > data.scheduledFor;
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

  try {
    // RLS Etapa 2: the write itself runs under the GUC. The
    // preceding ownership / conflict checks already filter by
    // `tenantId` at the app layer (so they're safe outside the tx);
    // wrapping the write is enough to enforce policies on the row
    // that gets committed.
    const b = await runWithRls(actor.tenantId, async (tx) =>
      tx.booking.create({
        data: {
          tenantId: actor.tenantId,
          practitionerId: data.practitionerId,
          serviceId: service.id,
          scheduledFor: data.scheduledFor,
          durationMin: duration,
          patientId: data.patientId,
          guestName: data.guestName,
          guestEmail: data.guestEmail,
          guestPhone: data.guestPhone,
          notes,
          status: data.patientId ? "CONFIRMED" : "PENDING",
          idempotencyKey: randomBytes(16).toString("hex"),
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
        link: `/agenda?date=${data.scheduledFor.toISOString().slice(0, 10)}`,
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
    return { ok: false, error: "No pudimos crear el turno." };
  }
}

export async function updateBooking(
  raw: BookingUpdateInput & { allowOverbooking?: boolean }
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
  const before = await prisma.booking.findFirst({
    where: { id, tenantId: actor.tenantId },
    select: {
      id: true,
      patientId: true,
      status: true,
      scheduledFor: true,
      durationMin: true,
      practitionerId: true,
      patient: { select: { firstName: true, lastName: true } },
    },
  });
  if (!before) return { ok: false, error: "Turno no encontrado." };

  // Validate the target patient (when changing) — tenant-scope check
  // so a malicious client can't re-bind a booking to a patient from
  // another consultorio. `null` means "clear the link" (back to a
  // guest slot); only `undefined` means "leave it alone".
  if (patch.patientId !== undefined && patch.patientId !== null) {
    const owned = await prisma.patient.findFirst({
      where: { id: patch.patientId, tenantId: actor.tenantId },
      select: { id: true },
    });
    if (!owned) return { ok: false, error: "Paciente fuera del consultorio." };
  }

  // Re-check conflicts only when scheduledFor or durationMin actually
  // change. Status-only updates don't touch the calendar slot.
  const newWhen = patch.scheduledFor ?? before.scheduledFor;
  const newDuration = patch.durationMin ?? before.durationMin;
  const slotChanged =
    patch.scheduledFor != null && +patch.scheduledFor !== +before.scheduledFor;
  if (slotChanged && patch.status !== "CANCELLED") {
    const end = new Date(newWhen.getTime() + newDuration * 60_000);
    const clash = await prisma.booking.findFirst({
      where: {
        tenantId: actor.tenantId,
        practitionerId: before.practitionerId,
        id: { not: id },
        status: { notIn: ["CANCELLED"] },
        scheduledFor: { lt: end },
        AND: [
          {
            scheduledFor: { gte: new Date(newWhen.getTime() - 240 * 60_000) },
          },
        ],
      },
      select: { id: true, scheduledFor: true, durationMin: true },
    });
    const overlapping =
      clash &&
      clash.scheduledFor < end &&
      new Date(clash.scheduledFor.getTime() + clash.durationMin * 60_000) > newWhen;
    if (overlapping && !raw.allowOverbooking) {
      const [prac, suggestion] = await Promise.all([
        prisma.practitioner.findUnique({
          where: { id: before.practitionerId },
          include: { user: { select: { fullName: true, email: true } } },
        }),
        suggestNextFreeSlot(actor.tenantId, before.practitionerId, newWhen, newDuration),
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
  }

  await prisma.booking.update({ where: { id }, data: patch });
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
        link: `/agenda?date=${before.scheduledFor.toISOString().slice(0, 10)}`,
      });
    } else if (patch.status === "NO_SHOW") {
      await notify({
        tenantId: actor.tenantId,
        userId: actor.userId,
        kind: NotificationKind.BOOKING_CANCELLED,
        title: `Ausente · ${who}`,
        body: niceWhen,
        link: `/agenda?date=${before.scheduledFor.toISOString().slice(0, 10)}`,
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
  status: BookingStatus
): Promise<ActionResult> {
  return updateBooking({ id, status });
}

export async function deleteBooking(id: string): Promise<ActionResult> {
  const actor = await getActor();
  // RLS Etapa 2: lookup + delete share the tx so policies guard the
  // destructive side too.
  const owned = await runWithRls(actor.tenantId, async (tx) => {
    const row = await tx.booking.findFirst({
      where: { id, tenantId: actor.tenantId },
      select: { id: true, patientId: true },
    });
    if (!row) return null;
    await tx.booking.delete({ where: { id } });
    return row;
  });
  if (!owned) return { ok: false, error: "Turno no encontrado." };
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
 * Recurring booking helper — creates the same booking weekly for
 * `repeatWeeks` occurrences. Conflicts skip silently (returns the count
 * of created vs. skipped). Idempotency key derived per occurrence.
 *
 * If `daysOfWeek` is provided (0=Mon…6=Sun), each week generates one
 * slot per matching day instead of repeating only the start day.
 */
export async function createBookingSeries(
  raw: BookingCreateInput & { repeatWeeks: number; daysOfWeek?: number[] }
): Promise<ActionResult<{ created: number; skipped: number }>> {
  const actor = await getActor();
  const parsed = BookingCreate.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Datos inválidos", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const data = parsed.data;
  const weeks = Math.min(12, Math.max(1, Math.floor(raw.repeatWeeks ?? 1)));
  const service = await prisma.service.findFirst({
    where: { id: data.serviceId, tenantId: actor.tenantId },
    select: { id: true, durationMin: true },
  });
  if (!service) return { ok: false, error: "Servicio inválido." };
  const duration = data.durationMin ?? service.durationMin;

  // Build list of dates to create. When daysOfWeek is specified we expand
  // each week into one slot per matching weekday (Mon=0…Sun=6 in AR local).
  // Without daysOfWeek we keep the original behaviour: one slot per week
  // on the same weekday as the start date.
  const dates: Date[] = [];
  if (raw.daysOfWeek && raw.daysOfWeek.length > 0) {
    // Normalise to 0..6 and deduplicate.
    const dowSet = new Set(raw.daysOfWeek.map((d) => ((d % 7) + 7) % 7));
    // Iterate day-by-day for `weeks` weeks starting from scheduledFor.
    const totalDays = weeks * 7;
    const startH = data.scheduledFor.getUTCHours();
    const startMin = data.scheduledFor.getUTCMinutes();
    for (let day = 0; day < totalDays; day++) {
      const candidate = new Date(data.scheduledFor);
      candidate.setUTCDate(candidate.getUTCDate() + day);
      candidate.setUTCHours(startH, startMin, 0, 0);
      // Convert UTC weekday to Mon=0 convention used by AR DOW pickers.
      const utcDow = candidate.getUTCDay(); // 0=Sun..6=Sat
      const monDow = (utcDow + 6) % 7; // 0=Mon..6=Sun
      if (dowSet.has(monDow)) dates.push(candidate);
    }
  } else {
    for (let i = 0; i < weeks; i++) {
      dates.push(new Date(data.scheduledFor.getTime() + i * 7 * 86_400_000));
    }
  }

  let created = 0;
  let skipped = 0;
  for (const when of dates) {
    const end = new Date(when.getTime() + duration * 60_000);
    const clash = await prisma.booking.findFirst({
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
    const overlap =
      clash &&
      clash.scheduledFor < end &&
      new Date(clash.scheduledFor.getTime() + clash.durationMin * 60_000) > when;
    if (overlap) {
      skipped++;
      continue;
    }
    try {
      await prisma.booking.create({
        data: {
          tenantId: actor.tenantId,
          practitionerId: data.practitionerId,
          serviceId: service.id,
          scheduledFor: when,
          durationMin: duration,
          patientId: data.patientId,
          guestName: data.guestName,
          guestEmail: data.guestEmail,
          guestPhone: data.guestPhone,
          notes: data.notes,
          status: data.patientId ? "CONFIRMED" : "PENDING",
          idempotencyKey: randomBytes(16).toString("hex"),
        },
      });
      created++;
    } catch {
      skipped++;
    }
  }
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "booking.series.create",
    entity: "Booking",
    payload: { created, skipped, weeks },
  });
  revalidatePath("/agenda");
  invalidateBookingDerivedCaches(actor.tenantId);
  return { ok: true, data: { created, skipped } };
}

/**
 * Create a full TreatmentProgram from the agenda — one `Booking` per
 * scheduled `Session`, all linked to the same program. Used when the
 * practitioner wants to lay out a whole plan from the calendar without
 * going through Diagnóstico.
 *
 * `daysOfWeek` is a 0..6 array (Mon=0..Sun=6). The first session falls
 * on `startScheduledFor`; subsequent sessions advance to the next
 * matching weekday at the same time. Repeats until `totalSessions` is
 * filled (or until we hit the safety cap of 64).
 */
export async function createBookingPlan(input: {
  patientId: string;
  serviceId: string;
  practitionerId: string;
  startScheduledFor: string; // ISO
  durationMin?: number;
  totalSessions: number;
  daysOfWeek: number[]; // 0..6 (Mon..Sun)
  title?: string;
  notes?: string;
}): Promise<ActionResult<{ programId: string; created: number; skipped: number }>> {
  const actor = await getActor();
  if (!input.patientId) return { ok: false, error: "Elegí un paciente." };
  if (!input.daysOfWeek.length) return { ok: false, error: "Elegí al menos un día de la semana." };
  const total = Math.min(64, Math.max(1, Math.floor(input.totalSessions)));

  const [patient, service] = await Promise.all([
    prisma.patient.findFirst({
      where: { id: input.patientId, tenantId: actor.tenantId },
      select: { id: true },
    }),
    prisma.service.findFirst({
      where: { id: input.serviceId, tenantId: actor.tenantId },
      select: { id: true, name: true, durationMin: true },
    }),
  ]);
  if (!patient) return { ok: false, error: "Paciente fuera del tenant." };
  if (!service) return { ok: false, error: "Servicio inválido." };

  const start = new Date(input.startScheduledFor);
  if (Number.isNaN(start.getTime())) return { ok: false, error: "Fecha de inicio inválida." };
  const duration = input.durationMin ?? service.durationMin;
  const dowSet = new Set(input.daysOfWeek.map((d) => ((d % 7) + 7) % 7));

  // Generate dates: keep the time-of-day from `start`, walk forward day
  // by day, emit a session whenever the day-of-week is in dowSet.
  const dates: Date[] = [];
  const cursor = new Date(start);
  // Always include the start date even if its DOW isn't in the set, so
  // the practitioner's chosen "first session" is honoured. After that,
  // pick subsequent matching DOWs.
  dates.push(new Date(cursor));
  cursor.setDate(cursor.getDate() + 1);
  while (dates.length < total) {
    const dow = (cursor.getDay() + 6) % 7; // Mon=0..Sun=6
    if (dowSet.has(dow)) {
      const next = new Date(cursor);
      next.setHours(start.getHours(), start.getMinutes(), 0, 0);
      dates.push(next);
    }
    cursor.setDate(cursor.getDate() + 1);
    // Safety net — at most 365 days lookahead.
    if (cursor.getTime() - start.getTime() > 365 * 86_400_000) break;
  }

  // Per-session conflict check before write.
  const frequency = Math.max(1, dowSet.size);
  const programTitle =
    input.title?.trim() || `Plan ${service.name} · ${total} sesiones`;

  const result = await prisma.$transaction(async (tx) => {
    const program = await tx.treatmentProgram.create({
      data: {
        tenantId: actor.tenantId,
        patientId: input.patientId,
        title: programTitle,
        totalSessions: dates.length,
        frequency,
        startDate: dates[0],
        status: "ACTIVE",
        sessions: {
          create: dates.map((d, i) => ({
            practitionerId: input.practitionerId,
            index: i + 1,
            scheduledFor: d,
          })),
        },
      },
    });
    // Create bookings 1:1 with sessions. Skip on conflict (don't break
    // the whole plan — the practitioner can reschedule the skipped slot
    // manually from the agenda).
    let created = 0;
    let skipped = 0;
    for (const when of dates) {
      const end = new Date(when.getTime() + duration * 60_000);
      const clash = await tx.booking.findFirst({
        where: {
          tenantId: actor.tenantId,
          practitionerId: input.practitionerId,
          status: { notIn: ["CANCELLED"] },
          scheduledFor: {
            gte: new Date(when.getTime() - 240 * 60_000),
            lt: end,
          },
        },
        select: { id: true, scheduledFor: true, durationMin: true },
      });
      const overlap =
        clash &&
        clash.scheduledFor < end &&
        new Date(clash.scheduledFor.getTime() + clash.durationMin * 60_000) > when;
      if (overlap) {
        skipped++;
        continue;
      }
      try {
        await tx.booking.create({
          data: {
            tenantId: actor.tenantId,
            practitionerId: input.practitionerId,
            serviceId: service.id,
            scheduledFor: when,
            durationMin: duration,
            patientId: input.patientId,
            notes: input.notes,
            status: "CONFIRMED",
            idempotencyKey: randomBytes(16).toString("hex"),
          },
        });
        created++;
      } catch {
        skipped++;
      }
    }
    return { programId: program.id, created, skipped };
  });

  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "booking.plan.create",
    entity: "TreatmentProgram",
    entityId: result.programId,
    payload: { totalSessions: dates.length, created: result.created, skipped: result.skipped },
  });

  revalidatePath("/agenda");
  revalidatePath("/dashboard");
  revalidatePath(`/pacientes/${input.patientId}`);
  invalidateBookingDerivedCaches(actor.tenantId);
  return { ok: true, data: result };
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
