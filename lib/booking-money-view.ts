/**
 * [TP-P5] Plata online de un turno, como vista pura: el mini-badge de la card de la agenda y las líneas del drawer
 * (§25.10 «Agenda» y «Drawer del turno»).
 *
 * Contrato de la card (TP-UI-D4 + AGENTS §5): solo «Seña» o «Pagado MP», con borde y sin relleno; **el fondo sigue
 * siendo el estado**, así que acá no hay colores: texto, nombre accesible completo y la clave de `data-badge`. La
 * entrada es lo que trae el cable de la agenda (`od` → `onlineDepositCents`, `po` → `paidOnline`, C-TP10), que se
 * omite cuando es 0/false: un turno sin plata online da `null` y la card queda con los mismos nodos que antes de T5.
 *
 * Va en el first load de `/agenda` (techo +0,3 kB, §25.11): nada más que `formatARS` y el copy.
 */
import { formatARS } from "@/lib/format";
import { BOOKING_MONEY_COPY, MONEY_BADGE_COPY } from "@/lib/online-payments-copy";

export type BookingMoneyInput = {
  /** Σ de señas PAID del turno (`Booking.onlineDepositCents`, la escribe solo el trigger de M18). */
  onlineDepositCents?: number | null;
  /** Hay un cobro FULL PAID del turno (pagado entero por Mercado Pago). */
  paidOnline?: boolean | null;
};

export type BookingMoneyBadge = {
  kind: "deposit" | "paid-mp";
  /** Valor de `data-badge` en la card (lo afirman los render tests de TP-3e). */
  dataBadge: "sena" | "mp";
  label: string;
  ariaLabel: string;
};

/** Un monto del cable que no es un entero positivo no es una seña (defensa ante un cable viejo o roto). */
function depositOf(cents: number | null | undefined): number {
  return typeof cents === "number" && Number.isFinite(cents) && cents > 0 ? Math.trunc(cents) : 0;
}

/** «Pagado MP» gana: si el turno se pagó entero online, la seña ya es parte de ese pago. */
export function bookingMoneyBadge(b: BookingMoneyInput): BookingMoneyBadge | null {
  if (b.paidOnline) {
    return { kind: "paid-mp", dataBadge: "mp", label: MONEY_BADGE_COPY.paidMp.label, ariaLabel: MONEY_BADGE_COPY.paidMp.aria };
  }
  const dep = depositOf(b.onlineDepositCents);
  if (dep > 0) {
    return {
      kind: "deposit",
      dataBadge: "sena",
      label: MONEY_BADGE_COPY.deposit.label,
      ariaLabel: MONEY_BADGE_COPY.deposit.aria(formatARS(dep)),
    };
  }
  return null;
}

/**
 * Lo que falta cobrar = max(0, copago − señas). Misma cuenta que `remainingOf` de `lib/online-charge-logic.ts` (TP-P3,
 * server) y que `loosePendingCents` del portal; acá vive aparte porque la card no puede arrastrar el módulo de reglas
 * de cobro al first load de `/agenda`.
 */
export function remainingAfterDepositCents(copagoCents: number | null | undefined, depositCents: number | null | undefined): number {
  const copago = typeof copagoCents === "number" && Number.isFinite(copagoCents) ? copagoCents : 0;
  return Math.max(0, copago - depositOf(depositCents));
}

export type BookingMoneyLines = {
  /** «Seña pagada · $X» */
  depositLine: string | null;
  /** Lo que el modal de cobro cobra; null si no hay copago resuelto o ya está cobrado. */
  remainingCents: number | null;
  /** «Por cobrar · $Y» (nunca «$ 0», §25.5) */
  remainingLine: string | null;
  /** «Pagado por Mercado Pago» / «Reintegrado por Mercado Pago» */
  onlineLine: string | null;
};

export function bookingMoneyLines(
  b: BookingMoneyInput & {
    /** Copago resuelto del turno (el que cobra el modal). null = sin resolver: lo decide el modal. */
    copagoCents: number | null;
    /** `Booking.paymentStatus` (UNPAID / PAID / AUTHORIZED / REFUNDED / FAILED…). */
    paymentStatus?: string | null;
    /** El FULL online del turno se reintegró. */
    refundedOnline?: boolean | null;
  },
): BookingMoneyLines {
  if (b.refundedOnline) {
    return { depositLine: null, remainingCents: null, remainingLine: null, onlineLine: BOOKING_MONEY_COPY.refundedOnline };
  }
  if (b.paidOnline) {
    return { depositLine: null, remainingCents: null, remainingLine: null, onlineLine: BOOKING_MONEY_COPY.paidOnline };
  }
  const dep = depositOf(b.onlineDepositCents);
  const depositLine = dep > 0 ? BOOKING_MONEY_COPY.depositPaid(formatARS(dep)) : null;
  const collected = b.paymentStatus === "PAID" || b.paymentStatus === "REFUNDED";
  if (b.copagoCents == null || collected) {
    return { depositLine, remainingCents: null, remainingLine: null, onlineLine: null };
  }
  const remainingCents = remainingAfterDepositCents(b.copagoCents, dep);
  return {
    depositLine,
    remainingCents,
    remainingLine: remainingCents > 0 ? BOOKING_MONEY_COPY.remaining(formatARS(remainingCents)) : null,
    onlineLine: null,
  };
}
