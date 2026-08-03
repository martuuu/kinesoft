"use server";

/**
 * Public booking — server actions used by the unauthenticated turnero
 * at `/c/[slug]/booking`. Everything reachable from a stranger lives
 * here, with explicit tenant resolution by slug (no actor context).
 *
 * Security model:
 *   - All inputs are rate-limited (per IP).
 *   - `submitPublicBooking` does not overwrite PII on an existing Patient
 *     row — at most it fills `null` fields, never replaces existing data.
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
import { localToARIso, toARDow } from "@/lib/datetime-ar";
import { overlapBlocks } from "@/lib/booking-capacity";
import type { ActionResult } from "@/lib/validation";
import {
  SubmitSchema,
  type PublicClinic,
  type PublicSlot,
  type PublicBookingStatus,
  type SubmitPublicBookingInput,
} from "@/lib/public-booking-types";

function callerIp(): string {
  const h = headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
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

// Fallback defaults — used when the tenant lookup fails or returns
// null. Each tenant's actual window comes from
// `Tenant.businessHoursStart/End` (Sprint 17), read in `listPublicSlots`.
const DEFAULT_OPEN_HOUR = 8;
const DEFAULT_CLOSE_HOUR = 19;
const SLOT_MIN = 45;

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
    select: {
      id: true,
      businessHoursStart: true,
      businessHoursEnd: true,
    },
  });
  if (!tenant) return [];

  const service = await prisma.service.findFirst({
    where: { id: input.serviceId, tenantId: tenant.id },
    select: { durationMin: true, maxConcurrent: true },
  });
  if (!service) return [];

  // Anchor the day to AR wall-clock, not the host's. On a UTC host (Vercel),
  // `new Date(date+"T00:00:00")` is 21:00 AR the day before, and building slots
  // with `setHours` would persist e.g. an "08:00" pick as 08:00 UTC = 05:00 AR.
  const dayStart = new Date(localToARIso(`${input.date}T00:00:00`));
  if (Number.isNaN(dayStart.getTime())) return [];
  // Argentina has no DST, so the next AR midnight is exactly +24h.
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  if (toARDow(dayStart) === 0) return []; // Sundays closed

  const existing = await prisma.booking.findMany({
    where: {
      tenantId: tenant.id,
      practitionerId: input.practitionerId,
      serviceId: input.serviceId,
      status: { notIn: ["CANCELLED"] },
      scheduledFor: { gte: dayStart, lt: dayEnd },
    },
    select: { scheduledFor: true, durationMin: true },
  });

  const openHour = tenant.businessHoursStart ?? DEFAULT_OPEN_HOUR;
  const closeHour = tenant.businessHoursEnd ?? DEFAULT_CLOSE_HOUR;
  const slots: PublicSlot[] = [];
  const total = service.durationMin;
  for (let m = openHour * 60; m + total <= closeHour * 60; m += SLOT_MIN) {
    const hh = String(Math.floor(m / 60)).padStart(2, "0");
    const mm = String(m % 60).padStart(2, "0");
    // Build the slot as the AR instant for this wall-clock time.
    const slot = new Date(localToARIso(`${input.date}T${hh}:${mm}:00`));
    const slotEnd = new Date(slot.getTime() + total * 60_000);
    const inPast = slot.getTime() < Date.now() + 60 * 60_000;
    const overlapCount = existing.filter((b) => {
      const bEnd = new Date(b.scheduledFor.getTime() + b.durationMin * 60_000);
      return b.scheduledFor < slotEnd && bEnd > slot;
    }).length;
    const full = overlapBlocks(overlapCount, service.maxConcurrent);
    slots.push({
      // The label IS the AR wall-clock time we just built the slot from.
      iso: slot.toISOString(),
      time: `${hh}:${mm}`,
      available: !full && !inPast,
    });
  }
  return slots;
}

// ──────────────────────────────────────────────────────────────────────
// Submit booking
// ──────────────────────────────────────────────────────────────────────

/**
 * Creates the Patient + Booking + Mercado Pago preference.
 *
 *   - Patient: upsert by (tenantId, email). If a row exists, **only fills
 *     null fields** — never overwrites existing PII. This prevents an
 *     attacker who knows a target's email from rewriting their HC.
 *   - Coverage / EmergencyContact: created when supplied + not already
 *     present for this patient.
 *   - Booking: created PENDING / UNPAID with an idempotency key derived
 *     from (tenant, practitioner, slot, patient).
 *   - Mercado Pago: a Checkout Pro preference is built and `init_point`
 *     returned so the client redirects.
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

  const tenant = await prisma.tenant.findUnique({ where: { slug: data.tenantSlug } });
  if (!tenant) return { ok: false, error: "Centro no encontrado." };

  const service = await prisma.service.findFirst({
    where: { id: data.serviceId, tenantId: tenant.id },
  });
  if (!service) return { ok: false, error: "Servicio no encontrado." };

  const practitioner = await prisma.practitioner.findFirst({
    where: { id: data.practitionerId, tenantId: tenant.id },
    select: { id: true },
  });
  if (!practitioner) return { ok: false, error: "Profesional no encontrado." };

  const scheduledFor = new Date(data.scheduledFor);
  if (Number.isNaN(scheduledFor.getTime())) {
    return { ok: false, error: "Horario inválido." };
  }
  if (scheduledFor.getTime() < Date.now() - 60_000) {
    return { ok: false, error: "El horario ya pasó." };
  }

  // Last-mile capacity check (same practitioner + same service). Overlaps are
  // allowed up to Service.maxConcurrent (null = ilimitado).
  const end = new Date(scheduledFor.getTime() + service.durationMin * 60_000);
  const clashes = await prisma.booking.findMany({
    where: {
      tenantId: tenant.id,
      practitionerId: data.practitionerId,
      serviceId: service.id,
      status: { notIn: ["CANCELLED"] },
      scheduledFor: { lt: end, gte: new Date(scheduledFor.getTime() - 4 * 60 * 60_000) },
    },
    select: { scheduledFor: true, durationMin: true },
  });
  const overlapCount = clashes.filter(
    (c) =>
      c.scheduledFor < end &&
      new Date(c.scheduledFor.getTime() + c.durationMin * 60_000) > scheduledFor
  ).length;
  if (overlapBlocks(overlapCount, service.maxConcurrent)) {
    return { ok: false, error: "Ese horario se acaba de ocupar. Elegí otro." };
  }

  const dob = new Date(data.patient.dateOfBirth);
  const emailLc = data.patient.email.trim().toLowerCase();

  // Look up an existing Patient by email OR documentId. If we find one,
  // we will **never overwrite** existing fields — only fill in null gaps.
  const existingPatient = await prisma.patient.findFirst({
    where: {
      tenantId: tenant.id,
      OR: [
        { email: { equals: emailLc, mode: "insensitive" } },
        { documentId: data.patient.documentId },
      ],
    },
    include: { coverages: true, emergency: true },
  });

  let patient = existingPatient;
  if (!patient) {
    patient = await prisma.patient.create({
      data: {
        tenantId: tenant.id,
        firstName: data.patient.firstName,
        lastName: data.patient.lastName,
        email: emailLc,
        phone: data.patient.phone,
        documentId: data.patient.documentId,
        dateOfBirth: dob,
      },
      include: { coverages: true, emergency: true },
    });
  } else {
    // Fill ONLY null/empty fields. Never overwrite existing PII — that
    // would let an attacker who guessed the email rewrite the HC.
    const patch: {
      email?: string;
      phone?: string;
      documentId?: string;
      dateOfBirth?: Date;
    } = {};
    if (!patient.email) patch.email = emailLc;
    if (!patient.phone) patch.phone = data.patient.phone;
    if (!patient.documentId) patch.documentId = data.patient.documentId;
    if (!patient.dateOfBirth) patch.dateOfBirth = dob;
    if (Object.keys(patch).length > 0) {
      await prisma.patient.update({ where: { id: patient.id }, data: patch });
    }
    // First/last name are NEVER touched on existing patients.
  }

  // Coverage — only seed one when the patient has NO coverage on file yet.
  // The app treats coverage as single-active (setPatientCoverage replaces it),
  // so we must NOT append a second row for a returning patient who self-reports
  // a different obra social — the EHR coverage is the source of truth.
  if (data.patient.coverageInsurer && patient.coverages.length === 0) {
    await prisma.coverage.create({
      data: {
        patientId: patient.id,
        insurer: data.patient.coverageInsurer.trim().replace(/\s+/g, " "),
        planName: data.patient.coveragePlan || null,
      },
    });
  }
  if (data.patient.emergencyName && data.patient.emergencyPhone) {
    const exists = patient.emergency.find(
      (e) => e.phone === data.patient.emergencyPhone
    );
    if (!exists) {
      await prisma.emergencyContact.create({
        data: {
          patientId: patient.id,
          name: data.patient.emergencyName,
          phone: data.patient.emergencyPhone,
        },
      });
    }
  }

  const idempotencyKey = `${tenant.id}:${data.practitionerId}:${scheduledFor.toISOString()}:${patient.id}`;
  const booking = await prisma.booking
    .upsert({
      where: { idempotencyKey },
      update: {},
      create: {
        tenantId: tenant.id,
        practitionerId: data.practitionerId,
        serviceId: service.id,
        patientId: patient.id,
        scheduledFor,
        durationMin: service.durationMin,
        notes: data.patient.notes || null,
        title: data.patient.title || null,
        description: data.patient.description || null,
        idempotencyKey,
      },
    })
    // The patient already has an active turno at this exact slot (booked from
    // the agenda with a different key) → partial unique index rejects the dup.
    .catch((e) => {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return null;
      throw e;
    });
  if (!booking) {
    return { ok: false, error: "Ya tenés un turno reservado en ese horario." };
  }

  const pref = await createCheckoutPreference({
    bookingId: booking.id,
    title: `${service.name} · ${tenant.name}`,
    amountCents: service.priceCents,
    currency: tenant.currency,
    payer: { email: emailLc, name: data.patient.firstName },
  });

  await audit({
    tenantId: tenant.id,
    action: "booking.public.create",
    entity: "Booking",
    entityId: booking.id,
    payload: {
      patientId: patient.id,
      preferenceId: pref.preferenceId,
      amountCents: service.priceCents,
    },
  });
  logger.info("booking.public.create", { bookingId: booking.id, tenant: tenant.slug });

  revalidatePath("/agenda");
  revalidatePath("/dashboard");

  return {
    ok: true,
    data: { bookingId: booking.id, initPoint: pref.initPoint },
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
