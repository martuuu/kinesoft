import "server-only";
import { NotificationKind, Prisma } from "@prisma/client";
// Webhook sin Actor → canal service (BYPASSRLS, como la rama legada). `tenantId` A MANO en cada WHERE: es la única barrera.
import { prismaService } from "@/lib/db";
import { mpConnectMode } from "@/lib/env";
import { formatARS } from "@/lib/format";
import { logger } from "@/lib/logger";
import { isHoldingCapacity } from "@/lib/booking-capacity";
import { afterBookingsCommitted } from "@/lib/booking-events-internal";
import { notifyTenantOwners } from "@/lib/notifications-internal";
import { notifyPractitionerOfOnlineBooking } from "@/lib/booking-pro-notify-internal";
import { applyOnlineChargeToBookingInTx } from "@/lib/booking-copago-internal";
import { findAccountByWebhookRef } from "@/lib/mp-connect/accounts-internal";
import { mpExpirePreference, withAccountToken, type MpAccountRef } from "@/lib/mp-connect/account-client";
import { mpFetch, type MpFetchResult } from "@/lib/mp-connect/http";
import {
  bookingEffectFor,
  mapMpStatus,
  nextChargeStatus,
  receiptColumnsFrom,
  type BookingEffect,
  type ChargeKind,
  type ChargeOrigin,
  type ChargeStatus,
  type MpPaymentStatus,
} from "@/lib/online-charge-logic";

/**
 * Consumidor del webhook de las cuentas conectadas (T5, C-TP7 del plan §25.6). Lo llama `handleConnectWebhook` con la
 * firma ya resuelta. Nunca escribe `Payment` (es el checkout legado, §25.2 hallazgo 1).
 *
 * Pasos:
 *   1. Cuenta por `webhookRef` (`?acct=`). Desconocida → 200 ignorado.
 *   2. GET del pago CON EL TOKEN DE LA CUENTA (`withAccountToken`: refresca si hace falta; `invalid_grant` → la cuenta
 *      pasa a REAUTH_REQUIRED y acá 503, MP reintenta). Esto es lo que hace segura a la rama aunque la notificación no
 *      venga firmada (hallazgo 8): el cuerpo del POST no se usa para nada, solo el `data.id`.
 *   3. Chequeos (cualquiera falla → 200 ignorado, no hay nada que reintentar): pago visible para ese token (404 = de otro
 *      vendedor), `collector_id` = la cuenta, `live_mode` según el modo, ARS, `external_reference` = `oc:<id>` de un cobro
 *      de ESA cuenta y ESE consultorio.
 *   4. Tx: `Booking FOR UPDATE` → `OnlineCharge FOR UPDATE` (mismo orden que el cobro a mano; el trigger de la seña
 *      escribe Booking con ese lock ya tomado) → idempotencia por (id, estado, reintegrado) en los intentos → monto ±5
 *      centavos → `nextChargeStatus` → comprobante (`receiptColumnsFrom`) → efecto sobre el turno por el escritor único.
 *   5. Después del commit (nunca adentro: un rollback no puede dejar un aviso de algo que no quedó escrito): la
 *      campana (`notifyTenantOwners`), `afterBookingsCommitted`, el aviso al profesional si el pago confirmó un turno
 *      del turnero, y al pasar a PAID vencer la preferencia (evita un segundo pago).
 */

type ConsumeResult = { ok: boolean; status: number; result: "applied" | "replay" | "ignored" | "mismatch" };

const IGNORED: ConsumeResult = { ok: true, status: 200, result: "ignored" };
const RETRY: ConsumeResult = { ok: false, status: 503, result: "ignored" };

/** `oc:<id del cobro>` (C-TP3); el id es un cuid. Cualquier otra cosa no es un cobro nuestro. */
const OC_RE = /^oc:([A-Za-z0-9_-]{1,64})$/;
/** Tolerancia de redondeo del monto, igual que la rama legada (§5.4). */
const AMOUNT_TOLERANCE_CENTS = 5;
/** Tope del historial de intentos en `rawPayload.attempts` (CHECK de 64 kB de M18). */
const MAX_ATTEMPTS_KEPT = 20;

/**
 * Allow-list de lo que se guarda del pago (`rawPayload`): sin payer, tarjeta, identificación ni metadata. Solo
 * escalares, strings truncados: el CHECK `OnlineCharge_rawPayload_check` (≤64 kB) no puede saltar por lo que mande MP.
 */
const KEEP = [
  "id",
  "status",
  "status_detail",
  "transaction_amount",
  "transaction_amount_refunded",
  "currency_id",
  "external_reference",
  "preference_id",
  "payment_method_id",
  "payment_type_id",
  "installments",
  "date_approved",
  "date_created",
  "date_last_updated",
  "live_mode",
  "collector_id",
] as const;

function redactPayment(p: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const k of KEEP) {
    const v = p[k];
    if (v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) out[k] = v as never;
    else if (typeof v === "string") out[k] = v.slice(0, 120);
  }
  return out;
}

type Attempt = Record<string, unknown> & { receivedAt: string; applied: boolean; refundedCents: number };

function jsonObject(raw: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function priorAttempts(raw: Prisma.JsonValue | null | undefined): Attempt[] {
  const a = jsonObject(raw).attempts;
  return Array.isArray(a) ? (a.filter((x) => x && typeof x === "object") as Attempt[]) : [];
}

/** Decimal de MP → centavos (como la rama legada y `receiptColumnsFrom`); inválido → null. */
function centsOf(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v * 100) : null;
}

/** ¿Es un error de token (`withAccountToken`) y no la respuesta del fetch? */
function isTokenError(r: unknown): r is { error: "reauth" | "no_credential" | "network" } {
  return !!r && typeof r === "object" && "error" in r && !("ok" in r);
}

type FetchOutcome = { kind: "ok"; payment: Record<string, unknown> } | { kind: "ignore"; reason: string } | { kind: "retry"; reason: string };

async function fetchPayment(account: MpAccountRef, paymentId: string): Promise<FetchOutcome> {
  let r: MpFetchResult | { error: "reauth" | "no_credential" | "network" };
  try {
    r = await withAccountToken(account, (token) => mpFetch(`/v1/payments/${encodeURIComponent(paymentId)}`, { token }));
  } catch (err) {
    // `withAccountToken` no debería tirar (devuelve su error), pero si tira no hay token: 503, MP reintenta.
    logger.error("mp_connect.webhook.token_failed", { accountId: account.id, error: err instanceof Error ? err.name : "unknown" });
    return { kind: "retry", reason: "token_failed" };
  }
  if (isTokenError(r)) {
    // `reauth`: la cuenta ya quedó REAUTH_REQUIRED (lo hace `withAccountToken`); MP reintenta y, si el Titular reconecta
    // la MISMA cuenta de MP (conserva el `webhookRef`), el pago entra. `no_credential` = cuenta desconectada y purgada:
    // no hay con qué leer el pago; igual 503 (un 200 lo perdería en silencio) y queda el log para soporte.
    if (r.error === "no_credential") logger.error("mp_connect.webhook.no_credential", { accountId: account.id });
    return { kind: "retry", reason: r.error };
  }
  if (!r.ok) {
    // 404: el pago no es de este vendedor (o no existe). Es la defensa principal contra un POST armado con un id ajeno.
    if (r.kind === "http" && r.status === 404) return { kind: "ignore", reason: "payment_not_found" };
    return { kind: "retry", reason: r.kind === "http" ? `http_${r.status ?? 0}` : r.kind };
  }
  if (!r.json || typeof r.json !== "object" || Array.isArray(r.json)) return { kind: "retry", reason: "bad_response" };
  return { kind: "ok", payment: r.json as Record<string, unknown> };
}

type Notice = { title: string; body: string };

type TxOutcome =
  | { kind: "replay" }
  | {
      kind: "done";
      from: ChargeStatus;
      to: ChargeStatus;
      incoming: MpPaymentStatus;
      amountMismatch: boolean;
      /** Aprobado de OTRO pago sobre un cobro ya PAID, o sobre un turno ya cobrado. */
      duplicate: boolean;
      bookingWritten: boolean;
      /** El pago aplicó el efecto `confirm` (PENDING del turnero → CONFIRMED): el turno online recién quedó reservado. */
      bookingConfirmed: boolean;
      notice: Notice | null;
      charge: { practitionerId: string; patientId: string; createdByUserId: string | null; preferenceId: string | null };
      booking: { id: string; practitionerId: string; scheduledFor: Date; roomId: string | null } | null;
    };

export async function consumeConnectWebhook(o: {
  acct: string;
  paymentId: string;
}): Promise<{ ok: boolean; status: number; result: "applied" | "replay" | "ignored" | "mismatch" }> {
  const account = await findAccountByWebhookRef(o.acct);
  if (!account) {
    logger.warn("mp_connect.webhook.unknown_acct");
    return IGNORED;
  }

  const fetched = await fetchPayment(account, o.paymentId);
  if (fetched.kind === "retry") {
    logger.warn("mp_connect.webhook.retry", { accountId: account.id, reason: fetched.reason });
    return RETRY;
  }
  if (fetched.kind === "ignore") {
    logger.warn("mp_connect.webhook.ignored", { accountId: account.id, reason: fetched.reason });
    return IGNORED;
  }
  const pay = fetched.payment;

  // ── Chequeos: lo que no es un pago de ESTA cuenta para un cobro de ESTE consultorio se ignora ──
  const ignore = (reason: string) => {
    logger.warn("mp_connect.webhook.ignored", { accountId: account.id, reason });
    return IGNORED;
  };
  if (String(pay.id ?? "") !== o.paymentId) return ignore("id_mismatch");
  if (String(pay.collector_id ?? "") !== account.mpUserId) return ignore("collector_mismatch");
  // `live_mode` según el modo: con `live` solo pagos reales; con `sandbox`/`fake`, solo de prueba. Un pago de prueba
  // en prod (o al revés) no es plata que se pueda imputar.
  const wantLive = mpConnectMode() === "live";
  if (pay.live_mode !== wantLive) return ignore("live_mode_mismatch");
  if (pay.currency_id !== "ARS") return ignore("currency");
  const ref = typeof pay.external_reference === "string" ? OC_RE.exec(pay.external_reference.trim()) : null;
  if (!ref) return ignore("not_ours");
  const chargeId = ref[1];
  const head = await prismaService.onlineCharge.findFirst({
    where: { id: chargeId, tenantId: account.tenantId, mpAccountId: account.id },
    select: { id: true, bookingId: true },
  });
  if (!head) return ignore("charge_not_found");

  const mpId = o.paymentId;
  const mpStatusRaw = typeof pay.status === "string" ? pay.status : "";
  const incoming = mapMpStatus(mpStatusRaw);
  const capturedCents = centsOf(pay.transaction_amount);
  const refundedCents = centsOf(pay.transaction_amount_refunded) ?? 0;
  const redacted = redactPayment(pay);
  const now = new Date();
  const tenantId = account.tenantId;

  const outcome = await prismaService.$transaction(async (tx): Promise<TxOutcome> => {
    // Orden de locks de M18: turno → cobro (el cobro a mano también toma el turno primero).
    if (head.bookingId) {
      await tx.$queryRaw`SELECT "id" FROM "Booking" WHERE "id" = ${head.bookingId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    }
    await tx.$queryRaw`SELECT "id" FROM "OnlineCharge" WHERE "id" = ${chargeId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    const c = await tx.onlineCharge.findFirstOrThrow({
      where: { id: chargeId, tenantId },
      select: {
        origin: true,
        kind: true,
        status: true,
        amountCents: true,
        copagoBasisCents: true,
        practitionerId: true,
        patientId: true,
        bookingId: true,
        createdByUserId: true,
        preferenceId: true,
        mpPaymentId: true,
        rawPayload: true,
        patient: { select: { firstName: true, lastName: true } },
      },
    });
    const bk = c.bookingId
      ? await tx.booking.findFirstOrThrow({
          where: { id: c.bookingId, tenantId },
          select: {
            id: true,
            status: true,
            paymentStatus: true,
            copagoPaymentMethod: true,
            copagoCollectedById: true,
            practitionerId: true,
            scheduledFor: true,
            roomId: true,
            createdAt: true,
            patientId: true,
            idempotencyKey: true,
            service: { select: { name: true } },
          },
        })
      : null;

    // Idempotencia por (id, estado, reintegrado): el mismo evento reenviado no escribe, no avisa ni emite. El monto
    // reintegrado entra en la clave porque un reintegro PARCIAL llega como `approved` con el mismo id.
    const attempts = priorAttempts(c.rawPayload);
    const seen = attempts.some((a) => String(a.id) === mpId && a.status === mpStatusRaw && Number(a.refundedCents ?? 0) === refundedCents);
    if (seen) return { kind: "replay" };

    const from = c.status as ChargeStatus;
    const amountMismatch =
      incoming === "approved" && (capturedCents === null || Math.abs(capturedCents - c.amountCents) > AMOUNT_TOLERANCE_CENTS);
    // Un cobro que ya tiene comprobante queda atado a ESE pago: otro pago (un segundo checkout de la misma preferencia)
    // no lo mueve. Un aprobado de otro pago es «duplicado»; un reintegro de otro pago no reintegra este cobro.
    const otherPayment = c.mpPaymentId !== null && c.mpPaymentId !== mpId;
    let to: ChargeStatus = otherPayment ? from : nextChargeStatus(from, incoming, { amountMismatch });
    const receipt = receiptColumnsFrom(pay, now);
    const writesReceipt = c.mpPaymentId === null && (to === "PAID" || to === "REFUNDED");
    // Sin un número de pago o un monto que entren en el CHECK del comprobante no se puede registrar PAID: queda como
    // estaba (el intento se guarda) y el log avisa. No pasa con MP real (ids numéricos, montos decimales).
    if (writesReceipt && (receipt.mpPaymentId === null || receipt.paidAmountCents === null || receipt.mpStatus === null)) {
      logger.error("mp_connect.webhook.bad_receipt", { chargeId });
      to = from;
    }
    const transition = to !== from;

    const history: Attempt[] = [
      ...attempts,
      { ...redacted, refundedCents, receivedAt: now.toISOString(), applied: transition },
    ].slice(-MAX_ATTEMPTS_KEPT);
    const prior = jsonObject(c.rawPayload);
    const rawPayload = { ...prior, ...(transition ? { payment: redacted } : {}), attempts: history } as Prisma.InputJsonValue;

    const data: Prisma.OnlineChargeUpdateManyMutationInput = { rawPayload };
    if (transition) {
      data.status = to;
      if (writesReceipt) {
        data.mpPaymentId = receipt.mpPaymentId;
        data.paidAmountCents = receipt.paidAmountCents;
        data.approvedAt = receipt.approvedAt;
        data.settledAt = receipt.settledAt;
        data.paymentMethodId = receipt.paymentMethodId;
        data.paymentTypeId = receipt.paymentTypeId;
        data.installments = receipt.installments;
      }
      // El estado de MP del comprobante solo cambia junto con una transición (el guard lo rechaza si no).
      data.mpStatus = receipt.mpStatus;
      data.mpStatusDetail = receipt.mpStatusDetail;
      if (to === "REFUNDED") data.refundedAt = now;
    }
    // `updateMany` con tenantId: el canal service no tiene otra barrera. El guard de M18 valida la transición.
    await tx.onlineCharge.updateMany({ where: { id: chargeId, tenantId }, data });

    // ── Efecto sobre el turno (escritor único) ──
    let bookingWritten = false;
    let bookingConfirmed = false;
    const bookingWasPaid = bk?.paymentStatus === "PAID";
    if (bk && transition) {
      // ¿El copago del turno lo pagó ESTE cobro? Solo entonces su reintegro devuelve el turno a REFUNDED: si lo cobró
      // otro cobro FULL (o la recepción, con quién cobró), el reintegro de este no lo toca.
      let paidByMp = false;
      if (from === "PAID" && c.kind === "FULL" && bk.copagoPaymentMethod === "MERCADO_PAGO" && bk.copagoCollectedById === null) {
        const others = await tx.onlineCharge.count({
          where: { tenantId, bookingId: bk.id, kind: "FULL", status: "PAID", id: { not: chargeId } },
        });
        paidByMp = others === 0;
      }
      const effects: BookingEffect[] = bookingEffectFor(
        {
          origin: c.origin as ChargeOrigin,
          kind: c.kind as ChargeKind,
          bookingStatus: bk.status,
          bookingPaymentStatus: bk.paymentStatus,
          paidByMp,
        },
        from,
        to
      );
      for (const effect of effects) {
        const r = await applyOnlineChargeToBookingInTx(tx, { tenantId, bookingId: bk.id, effect, copagoBasisCents: c.copagoBasisCents });
        bookingWritten ||= r.written;
        if (effect === "confirm" && r.written) bookingConfirmed = true;
      }
      // La seña la suma el trigger `online_charge_sync_booking` (mueve `onlineDepositCents` y `updatedAt`).
      if (c.kind === "DEPOSIT" && (from === "PAID" || to === "PAID")) bookingWritten = true;
    }

    // ── Aviso (se manda después del commit) ──
    const amount = formatARS(capturedCents ?? c.amountCents);
    const who = `${c.patient.firstName} ${c.patient.lastName}`.trim();
    const base = bk ? `${bk.service.name} · ${who}` : `Link de pago · ${who}`;
    const dead = bk?.status === "CANCELLED" || bk?.status === "NO_SHOW";
    // TP-ZF1 (B1 del revisor de T5-Z): un aprobado de OTRO pago es duplicado sea cual sea el estado del cobro. Antes
    // exigía `from === "PAID"`: con el cobro ya REFUNDED (o con otro monto), el segundo checkout no movía nada ni avisaba
    // y la plata quedaba en MP sin que nadie se enterara. `otherPayment` implica comprobante (PAID o REFUNDED).
    const duplicate =
      incoming === "approved" && (otherPayment || (!amountMismatch && to === "PAID" && from !== "PAID" && bookingWasPaid));
    let notice: Notice | null = null;
    if (incoming === "approved" && amountMismatch && !otherPayment) {
      notice = { title: `Pago con monto distinto · ${amount}`, body: `${base}. Esperábamos ${formatARS(c.amountCents)}. Revisalo en Mercado Pago.` };
    } else if (duplicate) {
      notice = { title: `Pago duplicado · ${amount}`, body: `${base}. El turno ya estaba cobrado: revisá el reintegro en Mercado Pago.` };
    } else if (to === "PAID" && from !== "PAID") {
      if (dead) {
        notice = {
          title: `Pago de un turno ${bk?.status === "NO_SHOW" ? "con ausencia" : "cancelado"} · ${amount}`,
          body: `${base}. El turno no se reactivó: si corresponde, reintegralo desde Mercado Pago.`,
        };
      } else if (from === "CANCELLED") {
        notice = { title: `Pago de un link anulado · ${amount}`, body: base };
      } else if (c.origin === "TURNERO" && bk?.status === "PENDING" && (from === "EXPIRED" || !isHoldingCapacity(bk, now))) {
        notice = { title: `Pago recibido (reserva vencida) · ${amount}`, body: `${base}. Revisá que el horario siga libre.` };
      } else if (from === "EXPIRED") {
        notice = { title: `Pago de un link vencido · ${amount}`, body: base };
      } else if (c.kind === "DEPOSIT") {
        notice = { title: `Seña recibida · ${amount}`, body: base };
      } else {
        notice = { title: `Pago recibido · ${amount}`, body: base };
      }
    } else if (to === "REFUNDED" && from !== "REFUNDED") {
      notice =
        incoming === "charged_back"
          ? { title: `Pago en disputa · ${amount}`, body: `${base}. Mercado Pago devolvió el pago por un contracargo.` }
          : { title: `Reintegro registrado · ${amount}`, body: base };
    } else if (incoming === "in_mediation" && !otherPayment) {
      notice = { title: `Pago en disputa · ${amount}`, body: base };
    }

    return {
      kind: "done",
      from,
      to,
      incoming,
      amountMismatch,
      duplicate,
      bookingWritten,
      bookingConfirmed,
      notice,
      charge: { practitionerId: c.practitionerId, patientId: c.patientId, createdByUserId: c.createdByUserId, preferenceId: c.preferenceId },
      booking: bk ? { id: bk.id, practitionerId: bk.practitionerId, scheduledFor: bk.scheduledFor, roomId: bk.roomId } : null,
    };
  });

  if (outcome.kind === "replay") return { ok: true, status: 200, result: "replay" };

  // CF2 (brief T.C «Orden»): la campana ANTES del evento realtime. El cliente refresca la campana cuando le llega el
  // evento del turno; con el orden de antes (realtime → notificación) el refresco no encontraba la fila todavía y el
  // aviso del pago aparecía recién en el próximo refresco. Mismo bug y mismo arreglo que en `submitPublicBooking`.
  if (outcome.notice) {
    await notifyTenantOwners({
      tenantId,
      kind: NotificationKind.PAYMENT_RECEIVED,
      title: outcome.notice.title,
      body: outcome.notice.body,
      link: `/pacientes/${outcome.charge.patientId}`,
      alsoPractitionerId: outcome.charge.practitionerId,
      alsoAgendaOperators: true,
      alsoUserId: outcome.charge.createdByUserId ?? undefined,
    });
  }

  // SV/§25.2 hallazgo 6: la agenda se entera por realtime + `updatedAt`. Solo si se escribió el turno.
  if (outcome.bookingWritten && outcome.booking) {
    await afterBookingsCommitted(tenantId, [
      {
        bookingId: outcome.booking.id,
        practitionerId: outcome.booking.practitionerId,
        scheduledFor: outcome.booking.scheduledFor,
        roomId: outcome.booking.roomId,
        kind: "booking",
      },
    ]);
  }

  // Al pasar a PAID se vence la preferencia: un segundo pago del mismo link/checkout sería plata a reintegrar. Best
  // effort y DESPUÉS del commit: si MP falla, el cobro ya quedó PAID y un segundo pago igual se registra como duplicado.
  // CF2-ZF3 (ZA-3): ANTES del aviso al profesional. Ese aviso espera hasta 3 s (mail + push) y, con el orden de antes,
  // durante ese rato el link seguía cobrable; vencer primero achica la ventana del doble pago a la latencia de MP.
  if (outcome.to === "PAID" && outcome.from !== "PAID" && outcome.charge.preferenceId) {
    try {
      const r = await mpExpirePreference(account, outcome.charge.preferenceId);
      if (!r.ok) logger.warn("mp_connect.webhook.expire_failed", { chargeId, error: r.error });
    } catch (err) {
      logger.warn("mp_connect.webhook.expire_failed", { chargeId, error: err instanceof Error ? err.name : "unknown" });
    }
  }

  // CF2 (D-CF2-11): un REQUIRED no avisa al profesional al reservarse (queda PENDING hasta el pago); lo avisa ESTE
  // webhook cuando el pago lo confirma. Solo con el efecto `confirm` escrito en esta transición: el replay corta antes
  // (idempotencia) y un pago sobre un turno ya confirmado (link, duplicado, reintegro) no es un turno nuevo. Sin hint:
  // el notificador lee las preferencias de la base. Se ESPERA (nunca tira, tope de 3 s): Vercel corta las promesas
  // sueltas al responder, y la latencia acá la paga MP, no el paciente.
  if (outcome.bookingConfirmed && outcome.booking) {
    await notifyPractitionerOfOnlineBooking(tenantId, outcome.booking.id);
  }

  if (outcome.amountMismatch) {
    logger.warn("mp_connect.webhook.amount_mismatch", { chargeId, captured: capturedCents });
    return { ok: true, status: 200, result: "mismatch" };
  }
  return { ok: true, status: 200, result: "applied" };
}
