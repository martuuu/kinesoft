import "server-only";
import type { Prisma } from "@prisma/client";
import type { BookingEffect } from "@/lib/online-charge-logic";

/**
 * Escritor ÚNICO del copago pagado online (T5, C-TP7 del plan §25.6). No toca `lib/bookings.ts` (serial, de TP-2e): el
 * webhook (TP-2a) aplica acá el efecto que decidió `bookingEffectFor`, dentro de su tx y con el turno ya bloqueado
 * (`Booking FOR UPDATE`).
 *
 * **Stub de TP-K3 (tanda T5c):** firma literal de C-TP7. TP-2a lo implementa:
 *   - `confirm`: PENDING → CONFIRMED (REQUIRED);
 *   - `mark-paid`: `{ paymentStatus PAID, copagoPaymentMethod MERCADO_PAGO, copagoCollectedById NULL,
 *     copagoCents COALESCE(copagoCents, basis) }`; `copagoPaidAt` intacto (TP-D28: es la fecha del cobro «a mano», M3a);
 *   - `mark-refunded`: turno REFUNDED con el medio puesto (el CHECK de M12 lo admite);
 *   - DEPOSIT no escribe el copago (TP-D7: la seña la suma el trigger de M18).
 *
 * Hasta entonces tira: aplicar «a medias» el efecto de un pago es peor que no aplicarlo (la tx del caller vuelve atrás).
 */
export async function applyOnlineChargeToBookingInTx(
  tx: Prisma.TransactionClient,
  o: { tenantId: string; bookingId: string; effect: BookingEffect; copagoBasisCents: number | null }
): Promise<{ written: boolean }> {
  void tx;
  if (o.effect === "none") return { written: false };
  throw new Error("[TP-K3] lib/booking-copago-internal.ts: no implementado (lo implementa TP-2a)");
}
