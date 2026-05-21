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
import { revalidatePath } from "next/cache";
import { Prisma, type BookingStatus } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { getActor } from "@/lib/session";
import { audit } from "@/lib/audit";
import { notify } from "@/lib/notifications-internal";
import { visibilityForActor } from "@/lib/visibility";
import { NotificationKind } from "@prisma/client";
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
  const v = await visibilityForActor(actor);
  const rows = await prisma.booking.findMany({
    where: {
      tenantId: actor.tenantId,
      ...v.bookingWhere,
      scheduledFor: { gte: opts.from, lt: opts.to },
      ...(opts.practitionerId ? { practitionerId: opts.practitionerId } : {}),
    },
    orderBy: { scheduledFor: "asc" },
    include: {
      service: true,
      patient: {
        include: {
          programs: {
            where: { status: "ACTIVE" },
            include: { case: { include: { diagnoses: { include: { condition: true }, take: 1, orderBy: { rank: "asc" } } } } },
            take: 1,
          },
        },
      },
    },
  });
  return rows.map((b): BookingRow => {
    const cond =
      b.patient?.programs[0]?.case?.diagnoses[0]?.condition?.name ?? null;
    const name =
      b.patient
        ? `${b.patient.firstName} ${b.patient.lastName}`
        : b.guestName ?? "Sin asignar";
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
      notes: b.notes,
    };
  });
}

export async function getDayCounts(opts: { from: Date; to: Date }) {
  const actor = await getActor();
  const v = await visibilityForActor(actor);
  const rows = await prisma.booking.findMany({
    where: {
      tenantId: actor.tenantId,
      ...v.bookingWhere,
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
  return prisma.service.findMany({
    where: { tenantId: actor.tenantId },
    orderBy: { name: "asc" },
  });
}

export async function listPractitioners() {
  const actor = await getActor();
  return prisma.practitioner.findMany({
    where: { tenantId: actor.tenantId },
    include: { user: true },
    orderBy: { createdAt: "asc" },
  });
}

export async function createBooking(
  raw: BookingCreateInput
): Promise<ActionResult<{ id: string }>> {
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

  // Conflict check for the same practitioner.
  const clash = await prisma.booking.findFirst({
    where: {
      tenantId: actor.tenantId,
      practitionerId: data.practitionerId,
      status: { notIn: ["CANCELLED"] },
      scheduledFor: { lt: end },
      AND: [
        {
          // overlapping window
          scheduledFor: { gte: new Date(data.scheduledFor.getTime() - 240 * 60_000) },
        },
      ],
    },
    select: { id: true, scheduledFor: true, durationMin: true },
  });
  if (clash) {
    const clashEnd = new Date(clash.scheduledFor.getTime() + clash.durationMin * 60_000);
    if (clash.scheduledFor < end && clashEnd > data.scheduledFor) {
      return { ok: false, error: "El profesional ya tiene un turno en ese horario." };
    }
  }

  try {
    const b = await prisma.booking.create({
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
        notes: data.notes,
        status: data.patientId ? "CONFIRMED" : "PENDING",
        idempotencyKey: randomBytes(16).toString("hex"),
      },
    });
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
          timeZone: "America/Argentina/Buenos_Aires",
        }),
        link: `/agenda?date=${data.scheduledFor.toISOString().slice(0, 10)}`,
      });
    }
    revalidatePath("/agenda");
    revalidatePath("/dashboard");
    if (data.patientId) revalidatePath(`/pacientes/${data.patientId}`);
    return { ok: true, data: { id: b.id } };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, error: "Turno duplicado." };
    }
    return { ok: false, error: "No pudimos crear el turno." };
  }
}

export async function updateBooking(
  raw: BookingUpdateInput
): Promise<ActionResult> {
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
      patient: { select: { firstName: true, lastName: true } },
    },
  });
  if (!before) return { ok: false, error: "Turno no encontrado." };
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
  const owned = await prisma.booking.findFirst({
    where: { id, tenantId: actor.tenantId },
    select: { id: true, patientId: true },
  });
  if (!owned) return { ok: false, error: "Turno no encontrado." };
  await prisma.booking.delete({ where: { id } });
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "booking.delete",
    entity: "Booking",
    entityId: id,
  });
  revalidatePath("/agenda");
  if (owned.patientId) revalidatePath(`/pacientes/${owned.patientId}`);
  return { ok: true, data: undefined };
}

/**
 * Recurring booking helper — creates the same booking weekly for
 * `repeatWeeks` occurrences. Conflicts skip silently (returns the count
 * of created vs. skipped). Idempotency key derived per occurrence.
 */
export async function createBookingSeries(
  raw: BookingCreateInput & { repeatWeeks: number }
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

  let created = 0;
  let skipped = 0;
  for (let i = 0; i < weeks; i++) {
    const when = new Date(data.scheduledFor.getTime() + i * 7 * 86_400_000);
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
