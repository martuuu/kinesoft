"use server";

/**
 * Public booking — server actions used by the unauthenticated turnero
 * at `/c/[slug]/booking`. Everything reachable from a stranger lives
 * here, with explicit tenant resolution by slug (no actor context).
 *
 * Security model:
 *   - All inputs are rate-limited (per IP).
 *   - `submitPublicBooking` NEVER writes to an existing Patient row (H4):
 *     it matches by normalized DNI and puts a differing contact on the
 *     booking snapshot (`guest*`) for the kine to review.
 *   - `getPublicBookingStatus` returns only initials + non-PHI fields
 *     even though the booking id is a 25-char CUID.
 *   - The PII prefill lookup (`findPatientByEmail`) is NOT exported from
 *     this file — it lives in `lib/public-booking-internal.ts` and is
 *     only callable from a server context that has already validated a
 *     Supabase session.
 */
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
// No-Actor surface (anonymous turnero) → service channel (BYPASSRLS). See lib/db.ts#prismaService.
import { Prisma } from "@prisma/client";
import { prismaService as prisma } from "@/lib/db";
import { createCheckoutPreference } from "@/lib/mercadopago";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/client-ip";
import { toARDateKey } from "@/lib/datetime-ar";
import {
  PUBLIC_OVERLAP_LOOKBACK_MS,
  arDayWindow,
  buildPublicSlots,
  checkPublicSlot,
} from "@/lib/public-booking-slots";
import { releaseOwnExpiredPublicHold, resolvePublicPatient } from "@/lib/public-booking-internal";
import type { ActionResult } from "@/lib/validation";
import {
  SubmitSchema,
  normalizeDocumentId,
  type PublicClinic,
  type PublicSlot,
  type PublicBookingStatus,
  type SubmitPublicBookingInput,
} from "@/lib/public-booking-types";

function callerIp(): string {
  const h = headers();
  return clientIp(h);
}

// ──────────────────────────────────────────────────────────────────────
// Public reads
// ──────────────────────────────────────────────────────────────────────

export async function getPublicClinic(slug: string): Promise<PublicClinic | null> {
  const tenant = await prisma.tenant.findUnique({
    where: { slug },
    include: {
      practitioners: { include: { user: true }, orderBy: { createdAt: "asc" } },
      services: { orderBy: { name: "asc" } },
    },
  });
  if (!tenant) return null;
  return {
    slug: tenant.slug,
    name: tenant.name,
    legalName: tenant.legalName,
    palette: tenant.palette,
    practitioners: tenant.practitioners.map((p) => ({
      id: p.id,
      name: p.user.fullName ?? p.user.email,
      specialty: p.specialty,
      licenseNumber: p.licenseNumber,
      yearsExp: p.yearsExp,
      rating: p.rating,
    })),
    services: tenant.services.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      durationMin: s.durationMin,
      priceCents: s.priceCents,
      practitionerId: s.practitionerId,
    })),
  };
}

/**
 * Turnos existentes que cuentan para la grilla de un día: mismo profesional +
 * servicio, no cancelados, con look-back para los que arrancaron antes de la
 * medianoche AR. Trae lo que pide `isHoldingCapacity` (S06): la reserva
 * pública impaga de más de 30 min deja de bloquear.
 */
async function loadDayBookings(
  tenantId: string,
  practitionerId: string,
  serviceId: string,
  dayStart: Date,
  dayEnd: Date
) {
  return prisma.booking.findMany({
    where: {
      tenantId,
      practitionerId,
      serviceId,
      status: { notIn: ["CANCELLED"] },
      scheduledFor: { gte: new Date(dayStart.getTime() - PUBLIC_OVERLAP_LOOKBACK_MS), lt: dayEnd },
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
}

export async function listPublicSlots(input: {
  tenantSlug: string;
  practitionerId: string;
  serviceId: string;
  date: string;
}): Promise<PublicSlot[]> {
  // Rate-limit slot polling so an attacker can't enumerate booking density.
  const rl = await rateLimit(`pub:slots:${callerIp()}`, {
    limit: 60,
    windowMs: 60_000,
  });
  // Signal the throttle distinctly instead of returning [] — otherwise the
  // wizard renders "no atiende este día" when the real cause is "esperá un
  // momento". Leaks no agenda density (no per-slot info in the message).
  if (!rl.ok) throw new Error("RATE_LIMITED");

  const tenant = await prisma.tenant.findUnique({
    where: { slug: input.tenantSlug },
    select: { id: true, businessHoursStart: true, businessHoursEnd: true },
  });
  if (!tenant) return [];

  const service = await prisma.service.findFirst({
    where: { id: input.serviceId, tenantId: tenant.id },
    select: { durationMin: true, maxConcurrent: true },
  });
  if (!service) return [];

  // Día anclado a la pared AR (no al host: en Vercel es UTC). La grilla la
  // arma `buildPublicSlots`, la misma que valida el submit.
  const win = arDayWindow(input.date);
  if (!win) return [];
  const existing = await loadDayBookings(
    tenant.id,
    input.practitionerId,
    input.serviceId,
    win.dayStart,
    win.dayEnd
  );
  return buildPublicSlots({
    date: input.date,
    openHour: tenant.businessHoursStart,
    closeHour: tenant.businessHoursEnd,
    durationMin: service.durationMin,
    maxConcurrent: service.maxConcurrent,
    existing,
    now: new Date(),
  });
}

// ──────────────────────────────────────────────────────────────────────
// Submit booking
// ──────────────────────────────────────────────────────────────────────

const SLOT_UNAVAILABLE_ERROR = "Ese horario se acaba de ocupar o ya no se puede reservar online. Elegí otro.";
const SAME_SLOT_ERROR = "Ya tenés un turno reservado en ese horario.";
const GENERIC_SUBMIT_ERROR = "No pudimos registrar la reserva. Probá de nuevo en unos minutos.";

/**
 * Crea (o reencuentra, si es un reintento) el turno público + la preferencia
 * de Mercado Pago.
 *
 *   - Idempotencia: key POR INSTANCIA del wizard (UUID del cliente), con
 *     prefijo `pub:<tenant>:` para que nunca choque con una key de la agenda
 *     ni de otro tenant. Mismo intento (doble click, reintento tras un error
 *     de MP) → el mismo turno. Un turno CANCELLED nunca se revive: una reserva
 *     nueva trae otra key y crea otro turno.
 *   - Horario: tiene que ser un slot de la grilla del día (`buildPublicSlots`:
 *     horario del consultorio, domingo, anticipación de 1 h) y tener cupo
 *     contando solo lo que sigue reteniendo (`isHoldingCapacity`).
 *   - Re-reserva del propio slot vencido: si el paciente ya tenía en ese
 *     instante SU reserva pública impaga vencida, se cancela y se crea la nueva
 *     en la misma tx (`releaseOwnExpiredPublicHold`, revisión A2).
 *   - Ficha: `resolvePublicPatient` (H4): match por DNI normalizado, nunca
 *     parchea una ficha existente; el contacto distinto va al snapshot
 *     `guest*` del turno + nota para el kine.
 *   - Mercado Pago: preferencia de Checkout Pro; se devuelve `init_point`.
 */
export async function submitPublicBooking(
  raw: SubmitPublicBookingInput
): Promise<ActionResult<{ bookingId: string; initPoint: string }>> {
  // Aggressive rate limit — a single visitor submitting twice in a few
  // seconds is almost always a bot.
  const ip = callerIp();
  const rl = await rateLimit(`pub:submit:${ip}`, {
    limit: 5,
    windowMs: 5 * 60_000,
  });
  if (!rl.ok) {
    return { ok: false, error: "Demasiados intentos. Probá de nuevo en unos minutos." };
  }

  const parsed = SubmitSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Datos inválidos",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const data = parsed.data;
  if (normalizeDocumentId(data.patient.documentId).length < 4) {
    return { ok: false, error: "Datos inválidos", fieldErrors: { documentId: ["DNI inválido"] } };
  }

  const tenant = await prisma.tenant.findUnique({ where: { slug: data.tenantSlug } });
  if (!tenant) return { ok: false, error: "Centro no encontrado." };

  const service = await prisma.service.findFirst({
    where: { id: data.serviceId, tenantId: tenant.id },
  });
  // Un servicio atado a otro profesional no se reserva con este (el wizard ya
  // los filtra; esto cierra el request armado a mano).
  if (!service || (service.practitionerId && service.practitionerId !== data.practitionerId)) {
    return { ok: false, error: "Servicio no encontrado." };
  }

  const practitioner = await prisma.practitioner.findFirst({
    where: { id: data.practitionerId, tenantId: tenant.id },
    select: { id: true },
  });
  if (!practitioner) return { ok: false, error: "Profesional no encontrado." };

  const scheduledFor = new Date(data.scheduledFor);
  if (Number.isNaN(scheduledFor.getTime())) {
    return { ok: false, error: "Horario inválido." };
  }

  const idempotencyKey = `pub:${tenant.id}:${data.idempotencyKey}`;

  // ── Reintento del MISMO intento (doble click, error de MP) → mismo turno.
  const prior = await prisma.booking.findUnique({
    where: { idempotencyKey },
    select: {
      id: true,
      tenantId: true,
      practitionerId: true,
      serviceId: true,
      scheduledFor: true,
      status: true,
      patientId: true,
    },
  });
  let bookingId: string;
  let patientId: string | null;
  if (prior) {
    const sameAttempt =
      prior.tenantId === tenant.id &&
      prior.practitionerId === data.practitionerId &&
      prior.serviceId === service.id &&
      prior.scheduledFor.getTime() === scheduledFor.getTime();
    if (!sameAttempt) {
      return { ok: false, error: "Tu reserva cambió. Recargá la página e intentá de nuevo." };
    }
    // Un CANCELLED no se revive (antes el upsert devolvía el turno cancelado y
    // el paciente pagaba un turno que la agenda ya no mostraba como activo).
    if (prior.status === "CANCELLED") {
      return { ok: false, error: "Ese turno fue cancelado. Recargá la página para reservar de nuevo." };
    }
    bookingId = prior.id;
    patientId = prior.patientId;
  } else {
    // ── Horario: tiene que ser de la grilla y tener cupo (misma función que
    // la lista del wizard). Antes se aceptaba cualquier instante futuro.
    const dateKey = toARDateKey(scheduledFor);
    const win = arDayWindow(dateKey);
    if (!win) return { ok: false, error: "Horario inválido." };
    const existing = await loadDayBookings(
      tenant.id,
      data.practitionerId,
      service.id,
      win.dayStart,
      win.dayEnd
    );
    const slots = buildPublicSlots({
      date: dateKey,
      openHour: tenant.businessHoursStart,
      closeHour: tenant.businessHoursEnd,
      durationMin: service.durationMin,
      maxConcurrent: service.maxConcurrent,
      existing,
      now: new Date(),
    });
    const verdict = checkPublicSlot(scheduledFor, slots);
    if (verdict === "off-grid") {
      return { ok: false, error: "Ese horario no está disponible para reservar online. Elegí otro." };
    }
    if (verdict === "unavailable") return { ok: false, error: SLOT_UNAVAILABLE_ERROR };

    let resolution: Awaited<ReturnType<typeof resolvePublicPatient>>;
    try {
      resolution = await resolvePublicPatient(
        tenant.id,
        {
          firstName: data.patient.firstName,
          lastName: data.patient.lastName,
          email: data.patient.email,
          phone: data.patient.phone,
          documentId: data.patient.documentId,
          dateOfBirth: new Date(data.patient.dateOfBirth),
          coverageInsurer: data.patient.coverageInsurer || undefined,
          coveragePlan: data.patient.coveragePlan || undefined,
          emergencyName: data.patient.emergencyName || undefined,
          emergencyPhone: data.patient.emergencyPhone || undefined,
        },
        { practitionerId: data.practitionerId }
      );
    } catch (e) {
      logger.error("booking.public.patient_failed", {
        tenant: tenant.slug,
        err: e instanceof Error ? e.message : String(e),
      });
      return { ok: false, error: GENERIC_SUBMIT_ERROR };
    }

    const notes = [...resolution.reviewNotes, data.patient.notes || ""]
      .filter((l) => l.trim() !== "")
      .join("\n");
    try {
      // Una reserva pública VENCIDA del mismo paciente en este instante se
      // cancela en la misma tx (ver `releaseOwnExpiredPublicHold`): si no, el
      // índice único parcial rechazaba su propio re-intento.
      const created = await prisma.$transaction(async (tx) => {
        const released = await releaseOwnExpiredPublicHold(tx, {
          tenantId: tenant.id,
          patientId: resolution.patientId,
          scheduledFor,
          now: new Date(),
        });
        const row = await tx.booking.create({
          data: {
            tenantId: tenant.id,
            practitionerId: data.practitionerId,
            serviceId: service.id,
            patientId: resolution.patientId,
            scheduledFor,
            durationMin: service.durationMin,
            notes: notes || null,
            title: data.patient.title || null,
            description: data.patient.description || null,
            guestName: resolution.contactSnapshot?.guestName ?? null,
            guestEmail: resolution.contactSnapshot?.guestEmail ?? null,
            guestPhone: resolution.contactSnapshot?.guestPhone ?? null,
            idempotencyKey,
          },
          select: { id: true, patientId: true },
        });
        return { ...row, released };
      });
      bookingId = created.id;
      patientId = created.patientId;
      if (created.released) {
        // Auditado acá (no tras MP): la cancelación ya se commiteó aunque la
        // preferencia falle después.
        await audit({
          tenantId: tenant.id,
          action: "booking.public.expired_replaced",
          entity: "Booking",
          entityId: created.released,
          payload: { replacedBy: created.id, patientId: created.patientId },
        });
      }
    } catch (e) {
      // P2002 distinguido por los DATOS, no por `meta.target` (que llega null
      // bajo RLS, ver `resolveUniqueViolation` en lib/bookings.ts):
      //   - hay una fila viva con ESTA key → dos submits del mismo intento se
      //     cruzaron → éxito idempotente con esa fila;
      //   - si no → índice parcial paciente+instante: ya tiene un turno activo
      //     que arranca a esa hora (reservado desde la agenda u otra pestaña).
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        const twin = await prisma.booking.findUnique({
          where: { idempotencyKey },
          select: { id: true, status: true, patientId: true },
        });
        if (twin && twin.status !== "CANCELLED") {
          bookingId = twin.id;
          patientId = twin.patientId;
        } else {
          return { ok: false, error: SAME_SLOT_ERROR };
        }
      } else {
        logger.error("booking.public.create_failed", {
          tenant: tenant.slug,
          err: e instanceof Error ? e.message : String(e),
        });
        return { ok: false, error: GENERIC_SUBMIT_ERROR };
      }
    }
  }

  let pref: Awaited<ReturnType<typeof createCheckoutPreference>>;
  try {
    pref = await createCheckoutPreference({
      bookingId,
      title: `${service.name} · ${tenant.name}`,
      amountCents: service.priceCents,
      currency: tenant.currency,
      payer: { email: data.patient.email, name: data.patient.firstName },
    });
  } catch (e) {
    // El turno queda PENDING/UNPAID: retiene el cupo 30 min y un reintento con
    // la misma key lo reencuentra (no duplica).
    logger.error("booking.public.preference_failed", {
      bookingId,
      err: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: "No pudimos iniciar el pago. Probá de nuevo en unos segundos." };
  }

  await audit({
    tenantId: tenant.id,
    action: "booking.public.create",
    entity: "Booking",
    entityId: bookingId,
    payload: {
      patientId,
      preferenceId: pref.preferenceId,
      amountCents: service.priceCents,
      replay: !!prior,
    },
  });
  logger.info("booking.public.create", { bookingId, tenant: tenant.slug, replay: !!prior });


  revalidatePath("/agenda");
  revalidatePath("/dashboard");

  return {
    ok: true,
    data: { bookingId, initPoint: pref.initPoint },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Public status polling
// ──────────────────────────────────────────────────────────────────────

function initials(...parts: (string | null | undefined)[]): string {
  return parts
    .filter(Boolean)
    .map((s) => s!.trim()[0]?.toUpperCase() ?? "")
    .join("");
}

export async function getPublicBookingStatus(
  id: string
): Promise<PublicBookingStatus | null> {
  // Rate-limit status polling — the success page already polls every 3s,
  // attacker scrape attempts should be cheap to reject.
  const rl = await rateLimit(`pub:status:${callerIp()}`, {
    limit: 120,
    windowMs: 60_000,
  });
  if (!rl.ok) return null;

  const b = await prisma.booking.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      paymentStatus: true,
      scheduledFor: true,
      durationMin: true,
      tenant: { select: { slug: true, name: true } },
      service: { select: { name: true, priceCents: true } },
      practitioner: {
        select: {
          user: { select: { fullName: true, email: true } },
        },
      },
      patient: { select: { firstName: true, lastName: true } },
      payment: { select: { amountCents: true } },
      guestName: true,
    },
  });
  if (!b) return null;

  const patientInitials =
    initials(b.patient?.firstName, b.patient?.lastName) ||
    initials(...(b.guestName?.split(/\s+/) ?? [])) ||
    null;

  return {
    bookingId: b.id,
    status: b.status,
    paymentStatus: b.paymentStatus,
    tenantSlug: b.tenant.slug,
    tenantName: b.tenant.name,
    serviceName: b.service.name,
    practitionerName: b.practitioner.user.fullName ?? b.practitioner.user.email,
    scheduledFor: b.scheduledFor.toISOString(),
    durationMin: b.durationMin,
    patientInitials,
    amountCents: b.payment?.amountCents ?? b.service.priceCents,
  };
}

/**
 * Dev-only: pretend MP confirmed the payment so the success page works
 * without a real webhook. Only enabled outside production.
 */
export async function devMarkBookingPaid(id: string): Promise<ActionResult> {
  if (process.env.NODE_ENV === "production") {
    return { ok: false, error: "Sólo disponible en desarrollo." };
  }
  const b = await prisma.booking.findUnique({ where: { id }, select: { id: true, tenantId: true } });
  if (!b) return { ok: false, error: "Booking no encontrado." };
  await prisma.$transaction([
    prisma.booking.update({
      where: { id },
      data: { status: "CONFIRMED", paymentStatus: "PAID" },
    }),
    prisma.payment.upsert({
      where: { bookingId: id },
      create: {
        bookingId: id,
        provider: "dev-stub",
        status: "PAID",
        amountCents: 0,
        currency: "ARS",
      },
      update: { status: "PAID" },
    }),
  ]);
  return { ok: true, data: undefined };
}
