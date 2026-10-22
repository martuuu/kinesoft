/**
 * Cobro online del turnero público — reglas PURAS. Sin DB, sin `env`, sin reloj: el caller (`lib/public-booking.ts`)
 * pasa lo que leyó. Unit test: tests/unit/public-booking-payment.test.ts.
 *
 * Historia:
 *   - TP-0 (H-TP0, cliente principal 17-oct): `submitPublicBooking` creaba SIEMPRE la preferencia de Checkout Pro con
 *     `Service.priceCents` crudo y la cuenta de la PLATAFORMA. Los servicios de arranque valen $0 y en prod no había
 *     token del consultorio (H-TP1): nadie podía terminar una reserva. TP-0 lo apagó detrás de `TURNERO_CHECKOUT`.
 *   - T5 (TP-2c, C-TP8): el turnero cobra con la cuenta de Mercado Pago del PROFESIONAL (o la del consultorio con
 *     `useClinicAccount`), según la política del consultorio. Quién cobra y cuánto lo decide `decideOnlineCharge`
 *     (`lib/online-charge-logic.ts`, TP-P3); acá queda lo propio del turnero: el vencimiento del cobro, qué hacer con
 *     un reintento del mismo intento y la vista pública del cobro. `decidePublicCheckout`/`isOnlineCheckoutAvailable`
 *     (la regla de `TURNERO_CHECKOUT=platform`) se borraron: la cuenta de la plataforma no cobra turnos nunca más.
 */
import type { ChargeStatus } from "@/lib/online-charge-logic";
import { remainingOf } from "@/lib/online-charge-logic";
import { buildMpReceipt, mpReceiptSummary, type MpReceiptInput } from "@/lib/mp-receipt";
import type { PublicBookingOnlineCharge } from "@/lib/public-booking-types";

/** Por debajo de $1 no se manda a pagar (el piso es el de TP-P3; se re-exporta para el wizard y sus tests). */
export { MIN_ONLINE_CHARGE_CENTS } from "@/lib/online-charge-logic";

/** El hold de un PENDING público (`PENDING_PUBLIC_HOLD_MS` de lib/booking-capacity.ts): lo repite el vencimiento. */
const HOLD_MS = 30 * 60_000;
/** OPTIONAL (TP-D16): el link del «Pagar ahora» vale 48 h o hasta que empieza el turno, lo que llegue antes. */
const OPTIONAL_CHARGE_MS = 48 * 3_600_000;

/**
 * `OnlineCharge.expiresAt` de un cobro del turnero (C-TP8):
 *   - REQUIRED: el fin del hold (alta + 30 min). La preferencia vence con él: pasado el hold el cupo se puede dar a
 *     otro y un pago tardío entra como «reserva vencida» (TP-D24), no como un turno que el paciente creía tener.
 *   - OPTIONAL: min(alta + 48 h, inicio del turno). El turno ya está reservado; pagar después de que empezó no tiene
 *     sentido online (se cobra en el consultorio).
 * `createdAt` es el de la fila del turno (la misma tx que el cobro), así el CHECK `expiresAt > createdAt` de M18 se
 * cumple aunque el reloj del host y el de Postgres difieran.
 */
export function turneroChargeExpiresAt(o: { required: boolean; createdAt: Date; scheduledFor: Date }): Date {
  if (o.required) return new Date(o.createdAt.getTime() + HOLD_MS);
  return new Date(Math.min(o.createdAt.getTime() + OPTIONAL_CHARGE_MS, o.scheduledFor.getTime()));
}

/**
 * Monto de la pantalla de estado para el checkout LEGADO (H-TP2): `Payment.amountCents` vale 0 hasta que el webhook
 * acredita, así que con el pago pendiente se mostraba «$ 0».
 *   - con pago legado: lo cobrado si está PAID; si no, lo que se espera cobrar (`expectedAmountCents`), o el precio en
 *     una fila sin ancla;
 *   - sin pago online (reservado): el precio del servicio, lo que se paga en el consultorio.
 * Un turno con cobro de T5 no pasa por acá: muestra el monto del cobro (`publicOnlineChargeView`).
 */
export function publicStatusAmountCents(o: {
  priceCents: number;
  payment: { status: string; amountCents: number; expectedAmountCents: number | null } | null;
}): number {
  if (!o.payment) return o.priceCents;
  if (o.payment.status === "PAID") return o.payment.amountCents;
  return o.payment.expectedAmountCents ?? o.priceCents;
}

/**
 * Qué hace `submitPublicBooking` con un turno que YA existe para la misma key (doble click, el paciente volvió de
 * Mercado Pago, reintento tras un error) o con el gemelo de un P2002. Nunca crea otro turno ni otro cobro:
 *   - `checkout`: el cobro vivo ya tiene preferencia → el MISMO `initPoint` (replay de C-TP8).
 *   - `open-preference`: cobro vivo sin preferencia (MP estaba caído) → se reintenta con EL MISMO cobro (TP-D29).
 *   - `hold-expired`: REQUIRED cuyo hold pasó (o cuyo cobro ya venció): el cupo se pudo dar a otro.
 *   - `payment-in-flight`: MP está reteniendo un pago (AUTHORIZED) de un turno que todavía espera confirmarse.
 *   - `preference-error`: REQUIRED cuyo cobro se anuló sin pagarse (la preferencia no se pudo armar, se desconectó la
 *     cuenta): no hay con qué cobrar y el turno no se confirma sin pago; vence solo con el hold.
 *   - `promote`: PENDING SIN cobro de T5 (nació con el checkout legado o antes de TP-0) → la promoción de TP-0.
 *   - `reserved` / `reserved-notice`: ya está reservado (OPTIONAL, pagado, confirmado por la recepción…); con
 *     `-notice` si el «Pagar ahora» se cayó (`preference_failed`), para que el resultado repita el aviso.
 */
export type TurneroReplayStep =
  | "cancelled"
  | "checkout"
  | "open-preference"
  | "hold-expired"
  | "payment-in-flight"
  | "preference-error"
  | "promote"
  | "reserved"
  | "reserved-notice";

export function turneroReplayStep(o: {
  bookingStatus: string;
  /** `isHoldingCapacity` del turno en `now` (solo importa con PENDING). */
  holdAlive: boolean;
  charge: { status: ChargeStatus; hasPreference: boolean; cancelReason: string | null } | null;
}): TurneroReplayStep {
  if (o.bookingStatus === "CANCELLED") return "cancelled";
  const pending = o.bookingStatus === "PENDING";
  const c = o.charge;
  if (!c) return pending ? "promote" : "reserved";
  switch (c.status) {
    case "ACTIVE":
      if (pending && !o.holdAlive) return "hold-expired";
      return c.hasPreference ? "checkout" : "open-preference";
    case "AUTHORIZED":
      return pending ? "payment-in-flight" : "reserved";
    case "PAID":
    case "REFUNDED":
      // El webhook confirma el turno en la MISMA tx que el PAID; un PENDING acá sería una carrera de lectura.
      return "reserved";
    case "EXPIRED":
      return pending ? "hold-expired" : "reserved";
    case "CANCELLED":
      if (pending) return "preference-error";
      return c.cancelReason === "preference_failed" ? "reserved-notice" : "reserved";
  }
}

/**
 * `PublicBookingStatus.onlineCharge` (C-TP8). Endpoint sin auth: solo montos y el comprobante resumido.
 *   - `amountCents`: lo que se cobra online (≥ $1 por el CHECK de M18: nunca «$ 0» pendiente).
 *   - `remainingCents`: lo que falta pagar en el consultorio. FULL pagado (o reintegrado: la plata se devuelve por MP y
 *     el turno ya no espera otro cobro online) → 0; FULL sin pagar → el monto del cobro; seña → copago − señas
 *     pagadas (`remainingOf`, la misma cuenta que la agenda y la Sala).
 *   - `receipt`: solo con PAID/REFUNDED y un comprobante sano (`buildMpReceipt` devuelve null si la fila está rota).
 */
export function publicOnlineChargeView(o: {
  kind: "FULL" | "DEPOSIT";
  status: ChargeStatus;
  amountCents: number;
  /** Copago del turno (solo se usa con DEPOSIT). */
  copagoCents: number;
  onlineDepositCents: number;
  receipt: MpReceiptInput | null;
}): PublicBookingOnlineCharge {
  const settled = o.status === "PAID" || o.status === "REFUNDED";
  const remainingCents =
    o.kind === "FULL"
      ? settled
        ? 0
        : o.amountCents
      : remainingOf({ resolvedCopagoCents: o.copagoCents, onlineDepositCents: o.onlineDepositCents });
  const view = settled && o.receipt ? buildMpReceipt(o.receipt) : null;
  return {
    kind: o.kind,
    status: o.status,
    amountCents: o.amountCents,
    remainingCents,
    receipt: view ? mpReceiptSummary(view) : null,
  };
}
