"use server";

/**
 * Links de pago (T5, contrato C-TP9 del plan §25.7). **Stub de TP-K2 (tanda T5c):** firmas congeladas para que el
 * `PaymentLinkDrawer` (TP-3d), Facturación, /cobros y la sala compilen en paralelo con el server. TP-2d las implementa
 * (orden de `createPaymentLink` en el Anexo B: soporte → zod + rate limit → `runWithRls` con FOR UPDATE del turno →
 * `canCollectCopago` → cuenta + delegación → monto → INSERT → audit → preferencia después del commit).
 *
 * Hasta entonces devuelven error **sin tocar la base ni Mercado Pago**: un link a medio crear (fila ACTIVE sin
 * preferencia) le mostraría al paciente un `/pagar` sin checkout.
 *
 * Los tests que TP-2d da vuelta: `tests/integration/tp2l-payment-links.test.ts` (`it.fails("[TP-2l] …")`).
 */
import type { ActionResult } from "@/lib/validation";
import type { ShareContact } from "@/lib/booking-share";
import type { CreatePaymentLinkInput } from "@/lib/payment-links-types";

const NOT_YET = "todavía no disponible";

export async function createPaymentLink(raw: CreatePaymentLinkInput): Promise<
  ActionResult<{
    chargeId: string;
    url: string;
    amountCents: number;
    expiresAt: string;
    accountKind: "PRACTITIONER" | "CLINIC";
  }>
> {
  void raw;
  return { ok: false, error: NOT_YET };
}

export async function cancelPaymentLink(raw: { chargeId: string }): Promise<ActionResult<{ status: "CANCELLED" }>> {
  void raw;
  return { ok: false, error: NOT_YET };
}

/** Contrato: 3 por hora por cobro; el mail va sin concepto ni datos clínicos. */
export async function sendPaymentLinkEmail(raw: { chargeId: string }): Promise<ActionResult<{ sentToMasked: string }>> {
  void raw;
  return { ok: false, error: NOT_YET };
}

export async function getPaymentLinkShare(raw: {
  chargeId: string;
}): Promise<ActionResult<{ url: string; text: string; waUrl: string | null; contact: ShareContact }>> {
  void raw;
  return { ok: false, error: NOT_YET };
}

export async function getPaymentLinkSuggestions(raw: { bookingId: string }): Promise<
  ActionResult<{
    remainingCents: number;
    totalCents: number;
    depositPaidCents: number;
    canTotal: boolean;
    accountKind: "PRACTITIONER" | "CLINIC" | null;
    blocked: string | null;
  }>
> {
  void raw;
  return { ok: false, error: NOT_YET };
}
