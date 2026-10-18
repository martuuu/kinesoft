/**
 * Cobro online del turnero público — reglas PURAS (TP-0, plan §22.5). Sin DB, sin `env`, sin reloj: el caller
 * (`lib/public-booking.ts`) pasa el switch y si Mercado Pago está configurado. Unit test:
 * tests/unit/public-booking-payment.test.ts.
 *
 * Por qué existe (H-TP0, cliente principal 17-oct): `submitPublicBooking` creaba SIEMPRE la preferencia de Checkout
 * Pro con `Service.priceCents` crudo. Los servicios de arranque valen $0 (`lib/tenant-starter-services.ts`) y en prod
 * no hay token del consultorio (la única cuenta es la de la plataforma, H-TP1): MP rechazaba, el turno quedaba
 * PENDING 30 min y cada reintento volvía a fallar. Nadie podía terminar una reserva.
 */

/** Por debajo de $1 no se manda a pagar: MP no acepta un ítem de $0 y un cobro de centavos no tiene sentido. */
export const MIN_ONLINE_CHARGE_CENTS = 100;

/**
 * `TURNERO_CHECKOUT` (lib/env.ts, HF-1a). `off` (default) = el turnero nunca cobra online; `platform` = cobra con la
 * cuenta MP de la plataforma (`MP_ACCESS_TOKEN`), el comportamiento previo a TP-0. TP-2 suma la cuenta de cada
 * profesional/consultorio por OAuth; hasta entonces el default es no cobrar.
 */
export type TurneroCheckoutMode = "off" | "platform";

export type PublicCheckoutDecision =
  | { kind: "checkout"; amountCents: number }
  | { kind: "none"; reason: "zero-amount" | "checkout-off" | "mp-missing" };

/**
 * ¿Este submit manda a pagar? Solo si se cumplen las TRES: switch en `platform`, MP configurado y monto ≥ $1
 * (entero: la plata va en centavos `Int`; un no-entero es un bug aguas arriba y no se cobra). Si no, el turno se
 * reserva sin cobro (CONFIRMED/UNPAID): el consultorio nunca eligió el pago obligatorio.
 *
 * Precedencia del motivo (solo para el log): switch → MP → monto, del más estructural al más puntual.
 * El switch se compara exacto (`"platform"`): un valor raro nunca prende el cobro (ante la duda, no se cobra).
 */
export function decidePublicCheckout(o: {
  amountCents: number;
  mode: TurneroCheckoutMode | string | undefined;
  mpConfigured: boolean;
}): PublicCheckoutDecision {
  if (o.mode !== "platform") return { kind: "none", reason: "checkout-off" };
  if (!o.mpConfigured) return { kind: "none", reason: "mp-missing" };
  if (!Number.isInteger(o.amountCents) || o.amountCents < MIN_ONLINE_CHARGE_CENTS) {
    return { kind: "none", reason: "zero-amount" };
  }
  return { kind: "checkout", amountCents: o.amountCents };
}

/**
 * `PublicClinic.onlineCheckout`: ¿el checkout PODRÍA ocurrir en este deploy? (switch + MP; sin mirar el monto, que
 * es por servicio y lo cruza el wizard con `MIN_ONLINE_CHARGE_CENTS`). Es solo para el copy del wizard: quien decide
 * en cada submit es `decidePublicCheckout`.
 */
export function isOnlineCheckoutAvailable(o: {
  mode: TurneroCheckoutMode | string | undefined;
  mpConfigured: boolean;
}): boolean {
  return o.mode === "platform" && o.mpConfigured;
}

/**
 * Monto de la pantalla de estado (H-TP2). Antes: `payment?.amountCents ?? price`, y `Payment.amountCents` vale 0
 * hasta que el webhook acredita (lo crea así `createCheckoutPreference`): con el pago pendiente se leía «$ 0».
 *   - con pago online: lo cobrado si está PAID; si no, lo que se espera cobrar (`expectedAmountCents`, el ancla de la
 *     preferencia), o el precio en una fila legada sin ancla;
 *   - sin pago online (reservado): el precio del servicio, lo que se paga en el consultorio.
 */
export function publicStatusAmountCents(o: {
  priceCents: number;
  payment: { status: string; amountCents: number; expectedAmountCents: number | null } | null;
}): number {
  if (!o.payment) return o.priceCents;
  if (o.payment.status === "PAID") return o.payment.amountCents;
  return o.payment.expectedAmountCents ?? o.priceCents;
}
