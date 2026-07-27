import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { createCheckoutPreference } from "@/lib/mercadopago";
import { audit } from "@/lib/audit";
import { rateLimitHandler } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

const Body = z.object({
  serviceId: z.string().min(1),
  practitionerId: z.string().min(1),
  scheduledFor: z.string().datetime({ offset: true }),
  guestName: z.string().min(1).max(120).optional(),
  guestEmail: z.string().email().optional(),
  guestPhone: z.string().min(6).max(30).optional(),
  tenantSlug: z.string().min(1),
});

/**
 * Creates a PENDING booking + Mercado Pago preference, then redirects the
 * client to the MP checkout URL. The webhook will reconcile state and flip
 * the booking to CONFIRMED on `approved`.
 */
export async function POST(req: Request) {
  // 8 checkout attempts per minute per IP — enough for retries, prevents abuse.
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "anon";
  const limited = await rateLimitHandler(`checkout:${ip}`, { limit: 8, windowMs: 60_000 });
  if (limited) {
    logger.warn("booking.checkout.rate_limited", { ip });
    return limited;
  }

  const form = req.headers.get("content-type")?.includes("form")
    ? Object.fromEntries(await req.formData())
    : await req.json();

  const parse = Body.safeParse(form);
  if (!parse.success) {
    return NextResponse.json({ error: parse.error.flatten() }, { status: 400 });
  }
  const data = parse.data;

  const tenant = await prisma.tenant.findUnique({ where: { slug: data.tenantSlug } });
  if (!tenant) return NextResponse.json({ error: "tenant_not_found" }, { status: 404 });

  const service = await prisma.service.findFirst({
    where: { id: data.serviceId, tenantId: tenant.id },
  });
  if (!service) return NextResponse.json({ error: "service_not_found" }, { status: 404 });

  // Validate the practitioner belongs to this tenant — otherwise a crafted
  // request could attach a booking to a practitioner from another tenant.
  const practitioner = await prisma.practitioner.findFirst({
    where: { id: data.practitionerId, tenantId: tenant.id },
    select: { id: true },
  });
  if (!practitioner) return NextResponse.json({ error: "practitioner_not_found" }, { status: 404 });

  // Idempotency key derived from tenant + slot + payer email (or a random nonce).
  const key = `${tenant.id}:${data.practitionerId}:${data.scheduledFor}:${data.guestEmail ?? ""}`;

  const booking = await prisma.booking.upsert({
    where: { idempotencyKey: key },
    update: {},
    create: {
      tenantId: tenant.id,
      practitionerId: data.practitionerId,
      serviceId: service.id,
      scheduledFor: new Date(data.scheduledFor),
      durationMin: service.durationMin,
      guestName: data.guestName,
      guestEmail: data.guestEmail,
      guestPhone: data.guestPhone,
      idempotencyKey: key,
    },
  });

  const pref = await createCheckoutPreference({
    bookingId: booking.id,
    title: `${service.name} · ${tenant.name}`,
    amountCents: service.priceCents,
    currency: tenant.currency,
    payer: { email: data.guestEmail, name: data.guestName },
  });

  await audit({
    tenantId: tenant.id,
    action: "booking.checkout.start",
    entity: "Booking",
    entityId: booking.id,
    payload: { preferenceId: pref.preferenceId },
  });

  return NextResponse.redirect(pref.initPoint, { status: 303 });
}
