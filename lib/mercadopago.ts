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
 *   - A2b-S-pub: never downgrades a PAID (only → REFUNDED), keeps every
 *     event in `rawPayload.attempts`, never reactivates a CANCELLED /
 *     NO_SHOW / COMPLETED turno, and serializes concurrent webhooks.
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
// Webhook + checkout preference run without an Actor → service channel (BYPASSRLS). See lib/db.ts#prismaService.
import { prismaService as prisma } from "@/lib/db";
import { notifyTenantOwners } from "@/lib/notifications-internal";
import { NotificationKind } from "@prisma/client";
import { logger } from "@/lib/logger";
import { formatARS } from "@/lib/format";
import { isHoldingCapacity } from "@/lib/booking-capacity";

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
  // Anchor the expected amount now, so the webhook validates the captured
  // amount against what the patient agreed to pay at checkout (see
  // consumeWebhook). Both checkout entry points funnel through here.
  await prisma.payment.upsert({
    where: { bookingId: input.bookingId },
    create: {
      bookingId: input.bookingId,
      provider: "mercadopago",
      status: "UNPAID",
      expectedAmountCents: input.amountCents,
      amountCents: 0,
      currency: input.currency ?? "ARS",
    },
    update: { expectedAmountCents: input.amountCents },
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

type PayStatus = "UNPAID" | "AUTHORIZED" | "PAID" | "REFUNDED" | "FAILED";

/**
 * Transición del estado de cobro ante un evento del webhook (A2b-S-pub). Pura.
 *
 * MP manda eventos fuera de orden y de varios intentos del mismo checkout
 * (tarjeta rechazada → otra aprobada; un `pending` de Rapipago que llega
 * después del `approved`). Antes el último evento ganaba siempre: un
 * `rejected` tardío bajaba un turno PAID a FAILED y la agenda lo mostraba
 * impago con la plata ya cobrada.
 *   - PAID solo sale hacia REFUNDED (o se queda PAID);
 *   - REFUNDED no vuelve a FAILED/AUTHORIZED;
 *   - todo lo demás toma el estado entrante.
 */
export function nextPaymentStatus(current: PayStatus | null, incoming: PayStatus): PayStatus {
  if (current === "PAID" && incoming !== "PAID" && incoming !== "REFUNDED") return "PAID";
  if (current === "REFUNDED" && (incoming === "FAILED" || incoming === "AUTHORIZED")) return "REFUNDED";
  return incoming;
}

/** Tope del historial de intentos guardado en `Payment.rawPayload.attempts`. */
const MAX_ATTEMPTS_KEPT = 20;

type Attempt = Record<string, unknown> & { receivedAt: string; applied: boolean };

function priorAttempts(raw: Prisma.JsonValue | null | undefined): Attempt[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const a = (raw as Record<string, unknown>).attempts;
  return Array.isArray(a) ? (a as Attempt[]) : [];
}

/** Top-level de `rawPayload` sin el historial (el último detalle APLICADO). */
function priorTopLevel(raw: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const { attempts: _drop, ...rest } = raw as Record<string, unknown>;
  return rest;
}

type WebhookOutcome =
  | { kind: "replay"; status: PayStatus }
  | {
      kind: "done";
      status: PayStatus;
      incoming: PayStatus;
      applied: boolean;
      amountMismatch: boolean;
      duplicatePaid: boolean;
      bookingStatus: string;
      holdExpired: boolean;
    };

function isP2002(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

/**
 * Procesa una notificación de pago de MP.
 *
 * Contratos que se PRESERVAN (AUDIT §5.4): la firma HMAC + ventana anti-replay
 * las valida la ruta con `verifyWebhookSignature` antes de llegar acá; el
 * consumo es idempotente por `(externalId, status)` (un reenvío no re-dispara
 * efectos ni notificaciones); `rawPayload` guarda solo la allow-list de
 * `redactPayload`; el monto se valida contra el anclado en el checkout.
 *
 * A2b-S-pub:
 *   - nunca baja un PAID (ver `nextPaymentStatus`); un segundo pago aprobado
 *     de un turno ya pagado no pisa el primero: se registra y se avisa;
 *   - cada evento queda en `rawPayload.attempts` (redactado, últimos 20),
 *     aplicado o no, como historial para soporte;
 *   - un turno CANCELLED / NO_SHOW / COMPLETED no se reactiva: se registra el
 *     pago y se notifica para que el consultorio revise el reembolso. Solo un
 *     PENDING pasa a CONFIRMED;
 *   - todo corre en una tx con `FOR UPDATE` sobre el turno (dos webhooks del
 *     mismo turno se serializan) y el chequeo de idempotencia va ADENTRO;
 *     un P2002 del create concurrente de `Payment` se reintenta (la segunda
 *     vuelta ve la fila y actualiza).
 */
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
  const mapped: PayStatus = statusMap[detail.status as keyof typeof statusMap] ?? "FAILED";
  const externalId = String(detail.id);
  const capturedCents = Math.round((detail.transaction_amount ?? 0) * 100);
  const redacted = redactPayload(detail as unknown as Record<string, unknown>);
  const id = String(bookingId);

  const apply = () =>
    prisma.$transaction(async (tx): Promise<WebhookOutcome> => {
      // Serializa webhooks concurrentes del mismo turno.
      await tx.$queryRaw`SELECT "id" FROM "Booking" WHERE "id" = ${id} FOR UPDATE`;
      const cur = await tx.payment.findUnique({
        where: { bookingId: id },
        select: { externalId: true, status: true, expectedAmountCents: true, rawPayload: true },
      });
      const bk = await tx.booking.findUniqueOrThrow({
        where: { id },
        select: { status: true, paymentStatus: true, createdAt: true, patientId: true, idempotencyKey: true },
      });
      const attempts = priorAttempts(cur?.rawPayload);

      // Idempotencia por (externalId, status), dentro de la tx: el mismo
      // evento reenviado no escribe ni notifica. También cuenta un evento ya
      // registrado en el historial sin aplicarse (p. ej. un rejected tardío).
      const seen =
        (cur?.externalId === externalId && cur?.status === mapped) ||
        attempts.some((a) => String(a.id) === externalId && a.status === detail.status);
      if (seen) return { kind: "replay", status: (cur?.status ?? mapped) as PayStatus };

      // Amount verification — refuse to mark a booking PAID unless the captured
      // amount matches what the checkout preference was created for (anchored on
      // `Payment.expectedAmountCents`), NOT the live `Service.priceCents`, which
      // may have changed between checkout-start and settlement. Legacy rows
      // without an anchored amount fall back to the service price. 5-cent
      // rounding tolerance. A mismatch is recorded as FAILED (auditable trace).
      const expectedCents = cur?.expectedAmountCents ?? booking.service.priceCents;
      const amountMismatch = mapped === "PAID" && Math.abs(capturedCents - expectedCents) > 5;
      const incoming: PayStatus = amountMismatch ? "FAILED" : mapped;
      if (amountMismatch) {
        logger.warn("mp.webhook.amount_mismatch", {
          bookingId: id,
          expected: expectedCents,
          captured: capturedCents,
        });
      }

      // "Ya pagado" mira las dos puntas: el Payment de MP y el cobro a mano
      // que el kine marca en la agenda (Booking.paymentStatus).
      const current: PayStatus | null =
        cur?.status === "PAID" || bk.paymentStatus === "PAID"
          ? "PAID"
          : cur?.status === "REFUNDED" || bk.paymentStatus === "REFUNDED"
            ? "REFUNDED"
            : ((cur?.status as PayStatus | undefined) ?? null);
      const next = nextPaymentStatus(current, incoming);
      const duplicatePaid = incoming === "PAID" && current === "PAID" && cur?.externalId !== externalId;
      // Otro pago de MP ya liquidó este turno: no se pisa su externalId/monto.
      const keepsOtherMpPayment =
        cur?.status === "PAID" && !!cur.externalId && cur.externalId !== externalId;
      const applied = next === incoming && !keepsOtherMpPayment;

      const history: Attempt[] = [
        ...attempts,
        { ...redacted, receivedAt: new Date().toISOString(), applied },
      ].slice(-MAX_ATTEMPTS_KEPT);
      const rawPayload = {
        ...(applied ? redacted : priorTopLevel(cur?.rawPayload)),
        attempts: history,
      } as Prisma.InputJsonValue;

      if (!cur) {
        await tx.payment.create({
          data: {
            bookingId: id,
            provider: "mercadopago",
            externalId: applied ? externalId : null,
            status: applied ? next : "UNPAID",
            expectedAmountCents: expectedCents,
            amountCents: applied ? capturedCents : 0,
            currency: detail.currency_id ?? "ARS",
            rawPayload,
          },
        });
      } else if (applied) {
        await tx.payment.update({
          where: { bookingId: id },
          data: { externalId, status: next, amountCents: capturedCents, rawPayload },
        });
      } else {
        await tx.payment.update({ where: { bookingId: id }, data: { rawPayload } });
      }

      if (applied && next !== bk.paymentStatus) {
        await tx.booking.update({
          where: { id },
          data: {
            paymentStatus: next,
            // Solo un PENDING se confirma al pagarse. Un turno CANCELLED /
            // NO_SHOW / COMPLETED no se reactiva (antes volvía a CONFIRMED y
            // ocupaba un cupo que la agenda ya había liberado).
            status: next === "PAID" && bk.status === "PENDING" ? "CONFIRMED" : undefined,
          },
        });
      }

      return {
        kind: "done",
        status: next,
        incoming,
        applied,
        amountMismatch,
        duplicatePaid,
        bookingStatus: bk.status,
        holdExpired: bk.status === "PENDING" && !isHoldingCapacity(bk, new Date()),
      };
    });

  let outcome: WebhookOutcome;
  try {
    outcome = await apply();
  } catch (e) {
    if (!isP2002(e)) throw e;
    // Dos webhooks crearon el Payment a la vez: la segunda vuelta lo ve y actualiza.
    outcome = await apply();
  }

  if (outcome.kind === "replay") {
    // Idempotent replay — short-circuit without re-firing notifications.
    return { ok: true, bookingId, status: outcome.status, replay: true };
  }
  if (outcome.amountMismatch) return { ok: false, reason: "amount_mismatch" };

  if (outcome.incoming === "PAID") {
    const amount = formatARS(capturedCents);
    const who = booking.patient
      ? `${booking.patient.firstName} ${booking.patient.lastName}`
      : booking.guestName ?? "Reserva externa";
    const inactiveLabel: Record<string, string> = {
      CANCELLED: "cancelado",
      NO_SHOW: "con ausencia",
      COMPLETED: "ya atendido",
    };
    let title = `Pago recibido · ${amount}`;
    let body = `${booking.service.name} · ${who}`;
    if (outcome.duplicatePaid) {
      title = `Pago duplicado · ${amount}`;
      body = `${booking.service.name} · ${who}. El turno ya estaba pagado: revisá el reembolso.`;
    } else if (inactiveLabel[outcome.bookingStatus]) {
      title = `Pago de un turno ${inactiveLabel[outcome.bookingStatus]} · ${amount}`;
      body = `${booking.service.name} · ${who}. El turno no se reactivó: revisá si corresponde reembolsar.`;
    } else if (outcome.holdExpired) {
      title = `Pago recibido (reserva vencida) · ${amount}`;
      body = `${booking.service.name} · ${who}. Pagó pasados los 30 min de la reserva: revisá que el horario siga libre.`;
    }
    await notifyTenantOwners({
      tenantId: booking.tenantId,
      kind: NotificationKind.PAYMENT_RECEIVED,
      title,
      body,
      link: `/pacientes/${booking.patientId ?? ""}`,
      alsoPractitionerId: booking.practitionerId,
    });
  }

  return { ok: true, bookingId, status: outcome.status, applied: outcome.applied };
}
