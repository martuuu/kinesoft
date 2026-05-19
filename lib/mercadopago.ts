/**
 * Mercado Pago integration — server-only.
 *
 * Flow:
 *   1. Practitioner site creates a PENDING booking (`createBooking`)
 *   2. `createCheckoutPreference` builds a Mercado Pago preference and
 *      returns `init_point` for the client redirect.
 *   3. MP posts a webhook to /api/webhooks/mercadopago when the payment
 *      changes state. `consumeWebhook` validates the signature, pulls the
 *      payment, and reconciles Booking.status + Payment.status.
 */
import crypto from "node:crypto";
import { MercadoPagoConfig, Preference, Payment as MpPayment } from "mercadopago";
import { env } from "@/lib/env";
import { prisma } from "@/lib/db";
import { notifyTenantOwners, NotificationKind } from "@/lib/notifications";

function client() {
  if (!env.MP_ACCESS_TOKEN) throw new Error("MP_ACCESS_TOKEN not configured");
  return new MercadoPagoConfig({
    accessToken: env.MP_ACCESS_TOKEN,
    options: { timeout: 10_000 },
  });
}

export type CreatePreferenceInput = {
  bookingId: string;
  title: string;
  amountCents: number;
  currency?: string;
  payer?: { email?: string; name?: string };
};

export async function createCheckoutPreference(input: CreatePreferenceInput) {
  const pref = new Preference(client());
  const result = await pref.create({
    body: {
      items: [
        {
          id: input.bookingId,
          title: input.title,
          quantity: 1,
          unit_price: input.amountCents / 100,
          currency_id: input.currency ?? "ARS",
        },
      ],
      payer: input.payer?.email ? { email: input.payer.email, name: input.payer.name } : undefined,
      external_reference: input.bookingId,
      notification_url: `${env.NEXT_PUBLIC_APP_URL}/api/webhooks/mercadopago`,
      back_urls: {
        success: `${env.NEXT_PUBLIC_APP_URL}/booking/${input.bookingId}/ok`,
        failure: `${env.NEXT_PUBLIC_APP_URL}/booking/${input.bookingId}/failed`,
        pending: `${env.NEXT_PUBLIC_APP_URL}/booking/${input.bookingId}/pending`,
      },
      auto_return: "approved",
      statement_descriptor: "KineSoft",
      metadata: { bookingId: input.bookingId },
    },
  });
  return {
    preferenceId: result.id!,
    initPoint: result.init_point!,
    sandboxInitPoint: result.sandbox_init_point,
  };
}

/**
 * Validates Mercado Pago's x-signature header against the request body.
 * MP signs `id={dataId};request-id={req};ts={ts}` with HMAC-SHA256(secret).
 */
export function verifyWebhookSignature(opts: {
  signature: string | null;
  requestId: string | null;
  dataId: string | null;
}): boolean {
  if (!env.MP_WEBHOOK_SECRET) return false;
  if (!opts.signature || !opts.dataId) return false;

  const parts = Object.fromEntries(
    opts.signature.split(",").map((p) => p.split("=").map((s) => s.trim()))
  );
  const ts = parts.ts;
  const v1 = parts.v1;
  if (!ts || !v1) return false;

  const manifest = `id:${opts.dataId};request-id:${opts.requestId ?? ""};ts:${ts};`;
  const hmac = crypto.createHmac("sha256", env.MP_WEBHOOK_SECRET).update(manifest).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(v1));
}

export async function consumeWebhook(paymentId: string) {
  const pay = new MpPayment(client());
  const detail = await pay.get({ id: paymentId });
  const bookingId = detail.external_reference ?? detail.metadata?.bookingId;
  if (!bookingId) return { ok: false, reason: "no external_reference" };

  const statusMap = {
    approved: "PAID",
    pending: "AUTHORIZED",
    in_process: "AUTHORIZED",
    rejected: "FAILED",
    refunded: "REFUNDED",
    cancelled: "FAILED",
  } as const;
  const mapped = statusMap[detail.status as keyof typeof statusMap] ?? "FAILED";

  await prisma.$transaction(async (tx) => {
    await tx.payment.upsert({
      where: { bookingId },
      create: {
        bookingId,
        provider: "mercadopago",
        externalId: String(detail.id),
        status: mapped,
        amountCents: Math.round((detail.transaction_amount ?? 0) * 100),
        currency: detail.currency_id ?? "ARS",
        rawPayload: detail as unknown as object,
      },
      update: {
        externalId: String(detail.id),
        status: mapped,
        rawPayload: detail as unknown as object,
      },
    });
    await tx.booking.update({
      where: { id: bookingId },
      data: {
        paymentStatus: mapped,
        status: mapped === "PAID" ? "CONFIRMED" : undefined,
      },
    });
  });

  if (mapped === "PAID") {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        patient: { select: { firstName: true, lastName: true } },
        service: { select: { name: true, priceCents: true } },
      },
    });
    if (booking) {
      const amountArs = new Intl.NumberFormat("es-AR", {
        style: "currency",
        currency: "ARS",
        maximumFractionDigits: 0,
      }).format((detail.transaction_amount ?? booking.service.priceCents / 100) as number);
      const who = booking.patient
        ? `${booking.patient.firstName} ${booking.patient.lastName}`
        : booking.guestName ?? "Reserva externa";
      await notifyTenantOwners({
        tenantId: booking.tenantId,
        kind: NotificationKind.PAYMENT_RECEIVED,
        title: `Pago recibido · ${amountArs}`,
        body: `${booking.service.name} · ${who}`,
        link: `/pacientes/${booking.patientId ?? ""}`,
        alsoPractitionerId: booking.practitionerId,
      });
    }
  }

  return { ok: true, bookingId, status: mapped };
}
