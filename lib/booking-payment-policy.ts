"use server";

/**
 * Política de cobro online del turnero (T5, contrato C-TP5 del plan §25). **Stub de TP-K2 (tanda T5c):** firma
 * congelada para que el panel «Cobros online» (TP-3a) compile en paralelo. TP-2b la implementa: `requireTenantSensitive`,
 * zod espejo de los CHECK de M18, `useClinicAccount` solo con la cuenta del consultorio ACTIVE, optimistic lock con
 * `expectedUpdatedAt` y audit `bookingPaymentPolicy.update {from,to}`. Hasta entonces devuelve error sin tocar la base.
 *
 * El test que TP-2b da vuelta: `tests/integration/tp2o-mp-connect.test.ts` («[TP-2o] Política: …»).
 */
import type { ActionResult } from "@/lib/validation";
import type { PaymentPolicyInput } from "@/lib/booking-payment-policy-types";

const NOT_YET = "todavía no disponible";

export async function savePaymentPolicy(
  input: PaymentPolicyInput,
  expectedUpdatedAt: string | null
): Promise<ActionResult<{ updatedAt: string }>> {
  void input;
  void expectedUpdatedAt;
  return { ok: false, error: NOT_YET };
}
