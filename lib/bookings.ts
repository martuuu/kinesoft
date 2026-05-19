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
import { notify } from "@/lib/notifications";
import { NotificationKind } from "@prisma/client";
import {
  BookingCreate,
  BookingUpdate,
  type ActionResult,
  type BookingCreateInput,
  type BookingUpdateInput,
} from "@/lib/validation";

export type BookingRow = {
  id: string;
  scheduledFor: Date;
  durationMin: number;
  status: BookingStatus;
  serviceName: string;
  practitionerId: string;
  patientId: string | null;
  patientName: string;
  patientCondition: string | null;
  notes: string | null;
};

export async function listBookingsInRange(opts: { from: Date; to: Date }): Promise<BookingRow[]> {
  const actor = await getActor();
  const rows = await prisma.booking.findMany({
    where: {
      tenantId: actor.tenantId,
      scheduledFor: { gte: opts.from, lt: opts.to },
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
