import "server-only";
import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { resolveBookingCopagoCents } from "@/lib/copago";
import { getParticularCopagoCents } from "@/lib/billing-internal";
import { logger } from "@/lib/logger";
import { mpCreatePreference, mpExpirePreference, type MpAccountRef } from "@/lib/mp-connect/account-client";
import { mpAppUrl } from "@/lib/mp-connect/http";
import { buildChargePreference, connectNotificationUrl } from "@/lib/mp-connect/preference";
import type { ChargeCancelReason } from "@/lib/online-payments-types";
import { runWithRls } from "@/lib/rls";

/**
 * Internos de los links de pago (T5, C-TP9 del plan §25.7): lo que `lib/payment-links.ts` ("use server") y otros
 * escritores (cobro a mano de TP-2e, cron de TP-2h, desconectar de TP-2b) comparten sin exportar funciones sync desde
 * un archivo de actions. Implementación de TP-2d sobre las firmas congeladas de TP-K3.
 *
 * Reglas:
 *   - token público de 128 bits (`randomBytes(16).base64url` = 22 caracteres, CHECK `OnlineCharge_token_check`);
 *   - anular los links vivos de un turno es UNA sentencia en la tx del caller (techo de `toggleBilling`: +1 solo si hay
 *     links, §25.8); las preferencias se vencen DESPUÉS del commit (`expirePreferencesBestEffort`);
 *   - la preferencia se abre DESPUÉS del commit (vence con el link; `back_urls` a `/pagar/<token>?r=…`). Si Mercado
 *     Pago falla, el cobro pasa a CANCELLED(`preference_failed`): un link sin checkout no se puede pagar y dejarlo ACTIVE
 *     bloquearía el turno («un link vivo por turno») sin que nadie pueda usarlo.
 */

/** 16 bytes al azar en base64url = 22 caracteres `[A-Za-z0-9_-]` (CHECK de M18 y `PUBLIC_PAYMENT_TOKEN_RE`). */
export async function newPaymentLinkToken(): Promise<string> {
  return randomBytes(16).toString("base64url");
}

/** URL pública del link. `mpAppUrl()` y no `env`: los tests cambian `NEXT_PUBLIC_APP_URL` en caliente. */
export function paymentLinkUrl(token: string): string {
  return `${mpAppUrl().replace(/\/+$/, "")}/pagar/${token}`;
}

/**
 * Anula los cobros ACTIVE de un turno en la tx del caller (cobro a mano → `collected`, cancelar / ausente →
 * `booking_cancelled`). Una sola sentencia con RETURNING: el caller necesita los ids para vencer las preferencias
 * después del commit, y el techo de `toggleBilling` (as1c-cobros ≤ 12) no admite un SELECT + UPDATE.
 *
 * TP-ZF1 (M2/M3 del revisor de T5-Z): con `includeTurnero` también anula el cobro TURNERO vivo. Antes solo LINK: un
 * «Pagar ahora» OPTIONAL (checkout de 48 h) de un turno cobrado a mano o cancelado seguía pagable → doble cobro o pago de
 * un turno cancelado. El caller decide cuándo: al cobrar a mano, solo si el turno NO está PENDING (con REQUIRED el cobro
 * ES la reserva y su hold lo resuelve el turnero); al cancelar / ausente, siempre. El caller ya tiene el turno
 * bloqueado (orden de locks Booking → OnlineCharge, §25.3).
 *
 * Solo ACTIVE: un AUTHORIZED es Mercado Pago reteniendo un pago (el guard de M18 no deja anularlo, y el caller ya lo
 * rechazó con «hay un pago en proceso»). `tenantId` a mano: en prod la conexión es BYPASSRLS. Fechas en UTC explícito
 * (`timestamp` sin zona): un `CURRENT_TIMESTAMP` depende del TimeZone de la sesión.
 */
export async function cancelLiveLinksForBookingInTx(
  tx: Prisma.TransactionClient,
  o: { tenantId: string; bookingId: string; reason: ChargeCancelReason; byUserId: string | null; includeTurnero?: boolean }
): Promise<{ cancelledChargeIds: string[] }> {
  const withTurnero = o.includeTurnero === true;
  const nowIso = new Date().toISOString();
  const rows = await tx.$queryRaw<{ id: string }[]>`
    UPDATE "OnlineCharge"
       SET "status" = 'CANCELLED',
           "cancelledAt" = (${nowIso}::timestamptz AT TIME ZONE 'UTC'),
           "cancelledByUserId" = ${o.byUserId},
           "cancelReason" = ${o.reason},
           "updatedAt" = (${nowIso}::timestamptz AT TIME ZONE 'UTC')
     WHERE "tenantId" = ${o.tenantId} AND "bookingId" = ${o.bookingId}
       AND ("origin" = 'LINK' OR (${withTurnero} AND "origin" = 'TURNERO')) AND "status" = 'ACTIVE'
    RETURNING "id"`;
  return { cancelledChargeIds: rows.map((r) => r.id).sort() };
}

/**
 * Copago del turno con la MISMA precedencia que la agenda y el cobro a mano (`resolveBookingCopagoCents`, AUDIT §5.5):
 * override del turno → cobertura → obra social → Particular → precio del servicio. Copia de la lectura de
 * `toggleBilling` (lib/bookings.ts, serial y de TP-2e): un link por «lo que falta» tiene que cobrar exactamente lo que
 * la Secretaría cobraría a mano. Sin congelar nada: el link no marca el copago (eso lo hace el webhook al pagarse).
 */
export async function resolveLinkCopagoInTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
  b: { copagoCents: number | null; patientId: string | null; serviceId: string }
): Promise<number> {
  if (b.copagoCents != null) return b.copagoCents;
  const [coverage, particularCopago, service] = await Promise.all([
    b.patientId
      ? tx.coverage.findFirst({
          where: { patientId: b.patientId, patient: { tenantId } },
          orderBy: { id: "desc" },
          select: { insurer: true, copagoCents: true, insurerRef: { select: { copagoCents: true } } },
        })
      : Promise.resolve(null),
    getParticularCopagoCents(tenantId, tx),
    tx.service.findFirst({ where: { id: b.serviceId, tenantId }, select: { priceCents: true } }),
  ]);
  return resolveBookingCopagoCents({
    bookingOverride: null,
    coverageOverride: coverage?.copagoCents ?? null,
    hasCoverage: !!coverage,
    insurerCopago: coverage?.insurerRef ? coverage.insurerRef.copagoCents : null,
    particularCopago,
    servicePriceCents: service?.priceCents ?? 0,
  });
}

const CHECKOUT_URL_RE = /^https?:\/\//;

/**
 * Abre la preferencia del link con el token del VENDEDOR (`mpCreatePreference`, nunca la cuenta de la plataforma) y la
 * guarda en el cobro. Corre DESPUÉS del commit del INSERT: una llamada de red adentro de la tx tendría el turno
 * bloqueado (FOR UPDATE) hasta 8 s.
 *
 * Idempotente: si el cobro ya tiene preferencia la devuelve (replay del drawer). Si Mercado Pago falla, o devuelve
 * algo que no entra en los CHECK de M18, el cobro pasa a CANCELLED(`preference_failed`) y se devuelve el error; la
 * escritura del checkout es condicional (`preferenceId` NULL) porque el guard de M18 la deja escribir una sola vez.
 */
export async function openPaymentLinkPreference(o: {
  tenantId: string;
  chargeId: string;
}): Promise<{ ok: true; checkoutUrl: string } | { ok: false; error: "preference_failed" }> {
  const c = await runWithRls(o.tenantId, (tx) =>
    tx.onlineCharge.findFirst({
      where: { id: o.chargeId, tenantId: o.tenantId, origin: "LINK" },
      select: {
        id: true,
        status: true,
        amountCents: true,
        expiresAt: true,
        publicToken: true,
        preferenceId: true,
        checkoutUrl: true,
        tenant: { select: { name: true } },
        mpAccount: { select: { id: true, tenantId: true, kind: true, status: true, mpUserId: true, webhookRef: true } },
      },
    })
  );
  if (!c || !c.publicToken) return { ok: false, error: "preference_failed" };
  if (c.preferenceId && c.checkoutUrl) return { ok: true, checkoutUrl: c.checkoutUrl };
  if (c.status !== "ACTIVE") return { ok: false, error: "preference_failed" };

  const account: MpAccountRef = {
    id: c.mpAccount.id,
    tenantId: c.mpAccount.tenantId,
    kind: c.mpAccount.kind,
    status: c.mpAccount.status,
    mpUserId: c.mpAccount.mpUserId,
    webhookRef: c.mpAccount.webhookRef,
  };
  let created: { preferenceId: string; initPoint: string } | null = null;
  if (account.status === "ACTIVE") {
    try {
      const url = paymentLinkUrl(c.publicToken);
      const body = buildChargePreference({
        charge: { id: c.id, amountCents: c.amountCents },
        tenantName: c.tenant.name,
        mode: "LINK",
        notificationUrl: connectNotificationUrl(mpAppUrl(), account.webhookRef),
        backUrls: { success: `${url}?r=ok`, failure: `${url}?r=failed`, pending: `${url}?r=pending` },
        expiresAt: c.expiresAt,
      });
      const r = await mpCreatePreference(account, body as unknown as Record<string, unknown>);
      if (r.ok && r.preferenceId.length >= 1 && r.preferenceId.length <= 100 && CHECKOUT_URL_RE.test(r.initPoint) && r.initPoint.length <= 500) {
        created = { preferenceId: r.preferenceId, initPoint: r.initPoint };
      } else {
        logger.warn("payment_link.preference_failed", { tenantId: o.tenantId, chargeId: c.id, error: r.ok ? "bad_response" : r.error });
      }
    } catch (e) {
      // `buildChargePreference` tira ante un input inválido (TP-P3): es un bug, pero el cobro no puede quedar ACTIVE.
      logger.warn("payment_link.preference_failed", { tenantId: o.tenantId, chargeId: c.id, error: e instanceof Error ? e.name : "unknown" });
    }
  }

  if (created) {
    // TP-ZF1 (B2 del revisor de T5-Z): el CAS exige ACTIVE. Antes solo `preferenceId` NULL: si en el medio (la llamada a
    // MP tarda) el link se anuló (cobro a mano, cancelar el turno, «Anular»), se guardaba la preferencia en un cobro
    // CANCELLED y se devolvía su checkout: el paciente podía pagar un link anulado.
    const saved = await runWithRls(o.tenantId, (tx) =>
      tx.onlineCharge.updateMany({
        where: { id: c.id, tenantId: o.tenantId, status: "ACTIVE", preferenceId: null },
        data: { preferenceId: created.preferenceId, checkoutUrl: created.initPoint },
      })
    );
    if (saved.count === 1) return { ok: true, checkoutUrl: created.initPoint };
    // Perdimos el CAS: NUESTRA preferencia quedó huérfana en MP (nadie la guarda ni la vence después). Se vence ya,
    // best effort, como `openTurneroPreference`; si falla, el consumidor igual rechaza un pago de un cobro anulado.
    try {
      const expired = await mpExpirePreference(account, created.preferenceId);
      if (!expired.ok) logger.warn("payment_link.orphan_preference", { tenantId: o.tenantId, chargeId: c.id, error: expired.error });
    } catch (e) {
      logger.warn("payment_link.orphan_preference", { tenantId: o.tenantId, chargeId: c.id, error: e instanceof Error ? e.name : "unknown" });
    }
    // Otro request (doble click del drawer con la misma key) ya guardó la suya: se devuelve esa.
    const again = await runWithRls(o.tenantId, (tx) =>
      tx.onlineCharge.findFirst({ where: { id: c.id, tenantId: o.tenantId }, select: { checkoutUrl: true, status: true } })
    );
    if (again?.checkoutUrl && again.status === "ACTIVE") return { ok: true, checkoutUrl: again.checkoutUrl };
    return { ok: false, error: "preference_failed" };
  }

  // Sin preferencia: se anula para que el turno no quede bloqueado por un link que nadie puede pagar. Condicional a
  // ACTIVE sin preferencia: si en el medio otro request la creó, gana esa.
  await runWithRls(o.tenantId, (tx) =>
    tx.onlineCharge.updateMany({
      where: { id: c.id, tenantId: o.tenantId, status: "ACTIVE", preferenceId: null },
      data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: "preference_failed" },
    })
  );
  return { ok: false, error: "preference_failed" };
}
