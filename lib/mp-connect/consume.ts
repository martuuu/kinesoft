import "server-only";

/**
 * Consumidor del webhook de las cuentas conectadas (T5, C-TP7 del plan §25.6).
 *
 * **Stub de TP-K3 (tanda T5c):** firma literal de C-TP7 para que la ruta (`webhook-route.ts`), el simulador y los tests
 * compilen en paralelo. TP-2a lo implementa: cuenta por `webhookRef` → `withAccountToken` → GET del pago → chequeos
 * (`collector_id`, `live_mode`, ARS, `oc:` de un cobro de esa cuenta y ese consultorio) → tx `Booking FOR UPDATE` →
 * `OnlineCharge FOR UPDATE` → idempotencia → monto ±5 centavos → `nextChargeStatus` → comprobante → efecto por el
 * escritor único `lib/booking-copago-internal.ts` → después del commit, avisos y `afterBookingsCommitted`.
 *
 * Hasta entonces responde 503 sin leer nada: MP reintenta (no se pierde la notificación) y nada se marca pagado.
 */
export async function consumeConnectWebhook(o: {
  acct: string;
  paymentId: string;
}): Promise<{ ok: boolean; status: number; result: "applied" | "replay" | "ignored" | "mismatch" }> {
  void o;
  return { ok: false, status: 503, result: "ignored" };
}
