/**
 * Mercado Pago integration — server-only.
 *
 * Security model (post-Sprint 11):
 *   - `verifyWebhookSignature` is **always required** when MP_WEBHOOK_SECRET
 *     is set. The route handler refuses unsigned requests regardless of
 *     NODE_ENV (the previous prod-only bypass was a staging vulnerability).
 *   - `verifyWebhookSignature` also rejects timestamps older than 5 min
 *     to defeat replay.
 *   - `consumeWebhook` is idempotent: if the linked `Payment` row already
 *     stores the same `externalId` AND status, side effects (notifications,
 *     transitions) are skipped.
 *   - The MP `transaction_amount` is compared against the linked
 *     `Service.priceCents` before flipping the booking to PAID — an
 *     adversary cannot pay $1 and have the system mark a $50 session
 *     CONFIRMED.
 *   - `rawPayload` is redacted to a known-safe subset before persisting
 *     (no cardholder name / document / device fingerprint).
 */
import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { MercadoPagoConfig, Preference, Payment as MpPayment } from "mercadopago";
import { env } from "@/lib/env";
import { prisma } from "@/lib/db";
import { notifyTenantOwners } from "@/lib/notifications-internal";
import { NotificationKind } from "@prisma/client";
import { logger } from "@/lib/logger";

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

/** Webhook payloads must arrive with a timestamp no older than this. */
const SIGNATURE_MAX_AGE_MS = 5 * 60_000;

export type SignatureVerification =
  | { ok: true }
  | { ok: false; reason: "no_secret" | "missing" | "stale" | "mismatch" };

/**
 * Validates Mercado Pago's x-signature header against the request body.
 * MP signs `id={dataId};request-id={req};ts={ts}` with HMAC-SHA256(secret).
 *
 * Returns a typed reason on failure so the route can log without leaking.
 */
export function verifyWebhookSignature(opts: {
  signature: string | null;
  requestId: string | null;
  dataId: string | null;
}): SignatureVerification {
  if (!env.MP_WEBHOOK_SECRET) return { ok: false, reason: "no_secret" };
  if (!opts.signature || !opts.dataId) return { ok: false, reason: "missing" };

  const parts = Object.fromEntries(
    opts.signature.split(",").map((p) => p.split("=").map((s) => s.trim()))
  );
  const ts = parts.ts;
  const v1 = parts.v1;
  if (!ts || !v1) return { ok: false, reason: "missing" };

  // Replay defence — reject signatures older than 5 min.
  const tsMs = Number(ts);
  if (!Number.isFinite(tsMs)) return { ok: false, reason: "missing" };
  // MP `ts` is seconds; allow either seconds or ms by sniffing magnitude.
  const tsAsMs = tsMs > 1e12 ? tsMs : tsMs * 1000;
  if (Math.abs(Date.now() - tsAsMs) > SIGNATURE_MAX_AGE_MS) {
    return { ok: false, reason: "stale" };
  }

  const manifest = `id:${opts.dataId};request-id:${opts.requestId ?? ""};ts:${ts};`;
  const hmac = crypto.createHmac("sha256", env.MP_WEBHOOK_SECRET).update(manifest).digest("hex");
  const a = Buffer.from(hmac);
  const b = Buffer.from(v1);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true };
}

/**
 * Strip Mercado Pago detail down to fields that are useful for support
 * + audit, without persisting cardholder PII / device fingerprints.
 */
function redactPayload(detail: Record<string, unknown>): Record<string, unknown> {
  const keep = [
    "id",
    "status",
    "status_detail",
    "transaction_amount",
    "currency_id",
    "external_reference",
    "preference_id",
    "payment_method_id",
    "payment_type_id",
    "date_approved",
    "date_created",
    "date_last_updated",
  ];
  const out: Record<string, unknown> = {};
  for (const k of keep) if (k in detail) out[k] = detail[k];
  return out;
}

export async function consumeWebhook(paymentId: string) {
  const pay = new MpPayment(client());
  const detail = await pay.get({ id: paymentId });
  const bookingId = detail.external_reference ?? detail.metadata?.bookingId;
  if (!bookingId) return { ok: false, reason: "no external_reference" };

  // Pull the booking up-front so we can verify amount + tenant scope.
  const booking = await prisma.booking.findUnique({
    where: { id: String(bookingId) },
    include: {
      service: { select: { name: true, priceCents: true } },
      patient: { select: { firstName: true, lastName: true } },
      payment: { select: { externalId: true, status: true, amountCents: true } },
    },
  });
  if (!booking) {
    logger.warn("mp.webhook.booking_missing", { bookingId, paymentId });
    return { ok: false, reason: "booking_missing" };
  }

  const statusMap = {
    approved: "PAID",
    pending: "AUTHORIZED",
    in_process: "AUTHORIZED",
    rejected: "FAILED",
    refunded: "REFUNDED",
    cancelled: "FAILED",
  } as const;
  const mapped = statusMap[detail.status as keyof typeof statusMap] ?? "FAILED";

  // Amount verification — refuse to mark a booking PAID if the captured
  // amount doesn't match the configured Service price. Allow a 5-cent
  // tolerance for rounding.
  const capturedCents = Math.round((detail.transaction_amount ?? 0) * 100);
  if (mapped === "PAID" && Math.abs(capturedCents - booking.service.priceCents) > 5) {
    logger.warn("mp.webhook.amount_mismatch", {
      bookingId,
      expected: booking.service.priceCents,
      captured: capturedCents,
    });
    return { ok: false, reason: "amount_mismatch" };
  }

  const externalId = String(detail.id);
  const alreadyProcessed =
    booking.payment?.externalId === externalId &&
    booking.payment?.status === mapped;

  if (alreadyProcessed) {
    // Idempotent replay — short-circuit without re-firing notifications.
    return { ok: true, bookingId, status: mapped, replay: true };
  }

  await prisma.$transaction(async (tx) => {
    await tx.payment.upsert({
      where: { bookingId: String(bookingId) },
      create: {
        bookingId: String(bookingId),
        provider: "mercadopago",
        externalId,
        status: mapped,
        amountCents: capturedCents,
        currency: detail.currency_id ?? "ARS",
        rawPayload: redactPayload(detail as unknown as Record<string, unknown>) as Prisma.InputJsonValue,
      },
      update: {
        externalId,
        status: mapped,
        amountCents: capturedCents,
        rawPayload: redactPayload(detail as unknown as Record<string, unknown>) as Prisma.InputJsonValue,
      },
    });
    await tx.booking.update({
      where: { id: String(bookingId) },
      data: {
        paymentStatus: mapped,
        status: mapped === "PAID" ? "CONFIRMED" : undefined,
      },
    });
  });

  if (mapped === "PAID") {
    const amountArs = new Intl.NumberFormat("es-AR", {
      style: "currency",
      currency: "ARS",
      maximumFractionDigits: 0,
    }).format(capturedCents / 100);
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

  return { ok: true, bookingId, status: mapped };
}
