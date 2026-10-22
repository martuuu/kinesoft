import "server-only";
import type { Prisma } from "@prisma/client";
import type { ChargeCancelReason } from "@/lib/online-payments-types";

/**
 * Internos de los links de pago (T5, C-TP9 del plan §25.7): lo que `lib/payment-links.ts` ("use server") y otros
 * escritores (cobro a mano de TP-2e, cron de TP-2h, desconectar de TP-2b) comparten sin exportar funciones sync desde un
 * archivo de actions.
 *
 * **Stub de TP-K3 (tanda T5c):** firmas congeladas. TP-2d lo implementa:
 *   - token público de 128 bits (`randomBytes(16).base64url` = 22 caracteres, CHECK de M18);
 *   - anular los links vivos de un turno en la tx del caller (un `updateMany` ACTIVE → CANCELLED con el motivo; las
 *     preferencias se vencen DESPUÉS del commit con `expirePreferencesBestEffort`);
 *   - abrir la preferencia después del commit (vence con el link; `back_urls` `/pagar/<token>?r=ok|failed|pending`); si MP
 *     falla → CANCELLED(`preference_failed`) + error.
 *
 * Hasta entonces: el token tira (un link sin token no se puede pagar), anular no anula nada y la preferencia falla.
 */

export async function newPaymentLinkToken(): Promise<string> {
  throw new Error("[TP-K3] lib/payment-links-internal.ts: no implementado (lo implementa TP-2d)");
}

export async function cancelLiveLinksForBookingInTx(
  tx: Prisma.TransactionClient,
  o: { tenantId: string; bookingId: string; reason: ChargeCancelReason; byUserId: string | null }
): Promise<{ cancelledChargeIds: string[] }> {
  void tx;
  void o;
  return { cancelledChargeIds: [] };
}

export async function openPaymentLinkPreference(o: {
  tenantId: string;
  chargeId: string;
}): Promise<{ ok: true; checkoutUrl: string } | { ok: false; error: "preference_failed" }> {
  void o;
  return { ok: false, error: "preference_failed" };
}
