/**
 * Medio de pago (T3, C-AS2; decisión 5 de Martin del 19-oct: «un cobro por turno con medio de pago»).
 *
 * Puro y client-safe (solo `import type` de Prisma): lo importan el picker de /sala y del drawer del turno, la
 * action del cobro (`setBookingCopagoPaid`), la facturación y, re-exportado con alias, la suscripción
 * (`lib/saas-billing-types.ts`). Un solo set de etiquetas para los dos enums de Postgres que comparten valores:
 * `BookingPaymentMethod` (M12, el cobro del turno) y `SaasPaymentMethod` (M8c, el pago de la suscripción). Antes de
 * T3 las etiquetas vivían solo en la suscripción; copiarlas para el turno era la segunda copia que diverge.
 *
 * El ORDEN de `PAYMENT_METHODS` es el del picker del turno: Efectivo primero (lo más común en la recepción). La
 * suscripción conserva el suyo (`SAAS_PAYMENT_METHODS`, Transferencia primero). La paridad con los dos enums se fija
 * en `tests/unit/payment-method.test.ts` (tipos con tsc, valores contra el runtime de Prisma, como conjunto).
 */
import type { BookingPaymentMethod, SaasPaymentMethod } from "@prisma/client";

export const PAYMENT_METHODS = ["CASH", "TRANSFER", "CARD", "WALLET", "MERCADO_PAGO", "OTHER"] as const satisfies readonly (BookingPaymentMethod & SaasPaymentMethod)[];

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABEL: Readonly<Record<PaymentMethod, string>> = {
  CASH: "Efectivo",
  TRANSFER: "Transferencia",
  CARD: "Tarjeta",
  WALLET: "Billetera virtual",
  MERCADO_PAGO: "Mercado Pago",
  OTHER: "Otro",
};

/** Sin medio: cobros de antes de M12 / pagos de la suscripción de antes de M8c (columna NULL). */
export const PAYMENT_METHOD_UNKNOWN = "Sin informar";

export function paymentMethodLabel(m: PaymentMethod | null | undefined): string {
  return m ? PAYMENT_METHOD_LABEL[m] : PAYMENT_METHOD_UNKNOWN;
}

/** Guard para lo que llega del cliente o del wire de la agenda (`pm`): solo los valores del enum. */
export function isPaymentMethod(v: unknown): v is PaymentMethod {
  return typeof v === "string" && (PAYMENT_METHODS as readonly string[]).includes(v);
}
