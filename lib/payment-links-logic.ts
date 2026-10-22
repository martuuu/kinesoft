/**
 * [TP-2d] Reglas puras de los links de pago (T5, contrato C-TP9 del plan §25.7). Sin DB, sin red, sin reloj propio:
 * lo usan `lib/payment-links.ts` ("use server": crear, sugerir, compartir), `lib/payment-links-internal.ts` y
 * `lib/public-payment-link.ts` (la página `/pagar/[token]`), y lo fija `tests/unit/tp2d-payment-links-logic.test.ts`.
 *
 * Vive aparte porque un archivo `"use server"` solo exporta funciones async (AGENTS.md §4) y porque las mismas reglas
 * deciden dos cosas que no pueden divergir: lo que el drawer ofrece (`getPaymentLinkSuggestions.blocked`) y lo que la
 * action acepta (`createPaymentLink`). Si fueran dos copias, el drawer ofrecería un link que el server rechaza.
 *
 * Plata 100 % en centavos `Int`. Copy en voseo y con el vocabulario de §25.10 (link de pago, seña, Mercado Pago).
 */
import { formatARS } from "@/lib/format";
import { MAX_ONLINE_CHARGE_CENTS, MIN_ONLINE_CHARGE_CENTS, remainingOf } from "@/lib/online-charge-logic";
import { PAYMENT_LINK_COPY } from "@/lib/online-payments-copy";
import { formatArDateTime } from "@/lib/mp-receipt";
import {
  PAYMENT_LINK_DEFAULT_EXPIRY_DAYS,
  type PaymentLinkExpiryDays,
  type PaymentLinkPurpose,
  type PublicPaymentLinkStatus,
} from "@/lib/payment-links-types";

/**
 * Copy que el contrato C-TP9 no fija (los literales del brief están en `PAYMENT_LINK_COPY`). Defaults de TP-2d,
 * anotados en el reporte de la sesión para que Martin los confirme.
 */
export const PAYMENT_LINK_EXTRA_COPY = {
  support: "Una sesión de soporte no puede generar, anular ni mandar links de pago.",
  forbidden: "No tenés permiso para cobrar este turno.",
  forbiddenOwn: "Solo podés generar links de pago de tus turnos y tus pacientes.",
  patientNotFound: "Paciente no encontrado.",
  bookingNotFound: "Turno no encontrado.",
  practitionerMismatch: "El turno es de otro profesional.",
  practitionerNotFound: "Ese profesional no atiende en este consultorio.",
  bookingInactive: "Solo se generan links de pago de turnos confirmados, pendientes o atendidos.",
  publicHold: "Este turno está esperando el pago del turnero: esperá a que se confirme o venza.",
  nothingToCharge: "Este turno no tiene nada para cobrar.",
  connectOff: "Los cobros con Mercado Pago no están disponibles en este momento.",
  linkNotFound: "Link de pago no encontrado.",
  notCancellable: "Este link de pago ya no se puede anular.",
  notShareable: "Este link de pago ya no está activo.",
  emailFailed: "No pudimos mandar el mail. Probá de nuevo en unos minutos.",
  invalid: "Revisá los datos del link de pago.",
} as const;

// ── Turno ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export type LinkBookingFacts = {
  status: "PENDING" | "CONFIRMED" | "CANCELLED" | "NO_SHOW" | "COMPLETED";
  paymentStatus: "UNPAID" | "AUTHORIZED" | "PAID" | "REFUNDED" | "FAILED";
  /** Reserva del turnero todavía impaga (`isUnpaidPublicPending`): el cobro lo maneja el turnero, no un link. */
  publicHold: boolean;
  /** `Payment` legado PAID/AUTHORIZED (checkout de la plataforma, AUDIT §5.4): el turno ya se pagó por ahí. */
  legacyPaid: boolean;
  /** Cobros online del turno que importan (cualquier origen). */
  charges: { origin: "TURNERO" | "LINK"; kind: "FULL" | "DEPOSIT" | "FREE"; status: string }[];
};

/**
 * Por qué no se puede generar un link para este turno (C-TP9: «turno cobrado, cancelado o en hold público →
 * rechazo»; un link vivo por turno; un pago en proceso bloquea), o `null`. El orden decide qué copy ve la Secretaría
 * cuando hay más de un motivo: primero lo definitivo (cobrado), después lo que se resuelve solo (en proceso) y al final
 * lo que resuelve ella (anular el link vivo).
 */
export function bookingLinkBlock(b: LinkBookingFacts): string | null {
  if (b.status === "CANCELLED" || b.status === "NO_SHOW") return PAYMENT_LINK_EXTRA_COPY.bookingInactive;
  const paidOnline = b.charges.some((c) => c.kind === "FULL" && c.status === "PAID");
  if (b.paymentStatus === "PAID" || b.paymentStatus === "REFUNDED" || b.legacyPaid || paidOnline) {
    return PAYMENT_LINK_COPY.alreadyPaid;
  }
  if (b.publicHold) return PAYMENT_LINK_EXTRA_COPY.publicHold;
  // AUTHORIZED (turno o cobro): Mercado Pago retiene un pago que todavía puede acreditarse. Un cobro del turnero
  // ACTIVE es un checkout abierto del paciente: un link encima cobraría dos veces el mismo turno.
  if (
    b.paymentStatus === "AUTHORIZED" ||
    b.charges.some((c) => c.status === "AUTHORIZED") ||
    b.charges.some((c) => c.origin === "TURNERO" && c.status === "ACTIVE")
  ) {
    return PAYMENT_LINK_COPY.inFlight;
  }
  if (b.charges.some((c) => c.origin === "LINK" && c.status === "ACTIVE")) return PAYMENT_LINK_COPY.liveLinkExists;
  return null;
}

// ── Monto ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export type LinkAmountDecision =
  | { ok: true; amountCents: number; kind: "FULL" | "DEPOSIT" | "FREE"; copagoBasisCents: number | null }
  | { ok: false; error: string };

const inRange = (c: number) => Number.isInteger(c) && c >= MIN_ONLINE_CHARGE_CENTS && c <= MAX_ONLINE_CHARGE_CENTS;

/**
 * Monto y tipo del cobro según `purpose` (C-TP9):
 *   - `REST`: lo que falta = copago resuelto − señas PAID (`remainingOf`, el mismo cálculo que la agenda). FULL: al
 *     pagarse cubre el turno y el webhook marca el copago (§23.1 #5: «Pagado» cubre el resto).
 *   - `TOTAL`: el copago entero, solo SIN seña pagada (con seña sería cobrar la seña dos veces). FULL.
 *   - `DEPOSIT`: un monto MENOR que lo que falta (igual o mayor sería un REST mal rotulado: dejaría el turno «señado»
 *     por el total y el copago sin marcar). DEPOSIT: no marca el copago (TP-D7), la suma el trigger de M18.
 *   - `FREE`: sin turno, el monto que escribió el staff. FREE.
 * `copagoBasisCents` = el copago con el que se calculó un FULL con turno (CHECK `OnlineCharge_basis_check` de M18).
 * Rango $1..$1.000.000 (CHECK `OnlineCharge_amount_check`): fuera de rango se rechaza ACÁ, no con un 23514.
 */
export function linkAmountFor(
  purpose: PaymentLinkPurpose,
  o: { resolvedCopagoCents: number | null; onlineDepositCents: number; amountCents?: number | null }
): LinkAmountDecision {
  if (purpose === "FREE") {
    const a = o.amountCents;
    if (a == null || !inRange(a)) return { ok: false, error: PAYMENT_LINK_COPY.amountRange };
    return { ok: true, amountCents: a, kind: "FREE", copagoBasisCents: null };
  }
  const copago = o.resolvedCopagoCents ?? 0;
  const remaining = remainingOf({ resolvedCopagoCents: copago, onlineDepositCents: o.onlineDepositCents });
  if (purpose === "TOTAL") {
    if (o.onlineDepositCents > 0) return { ok: false, error: PAYMENT_LINK_COPY.depositAlreadyPaid };
    if (copago <= 0) return { ok: false, error: PAYMENT_LINK_EXTRA_COPY.nothingToCharge };
    if (!inRange(copago)) return { ok: false, error: PAYMENT_LINK_COPY.amountRange };
    return { ok: true, amountCents: copago, kind: "FULL", copagoBasisCents: copago };
  }
  if (remaining <= 0) return { ok: false, error: PAYMENT_LINK_EXTRA_COPY.nothingToCharge };
  if (purpose === "REST") {
    if (!inRange(remaining)) return { ok: false, error: PAYMENT_LINK_COPY.amountRange };
    return { ok: true, amountCents: remaining, kind: "FULL", copagoBasisCents: copago };
  }
  // DEPOSIT
  const a = o.amountCents;
  if (a == null || !inRange(a)) return { ok: false, error: PAYMENT_LINK_COPY.amountRange };
  if (a >= remaining) return { ok: false, error: PAYMENT_LINK_COPY.depositTooHigh };
  return { ok: true, amountCents: a, kind: "DEPOSIT", copagoBasisCents: null };
}

// ── Cuenta y delegación ─────────────────────────────────────────────────────────────────────────────────────────────

export type LinkAccountFacts = {
  kind: "PRACTITIONER" | "CLINIC";
  practitionerId: string | null;
  linksDelegated: boolean;
};

/**
 * ¿Puede el actor generar un link que cobra a esta cuenta? (§25.7, TP-D12, TP-UI-D8). La plata entra a la cuenta de
 * OTRA persona: sin su autorización (`linksDelegated`) solo la usa su dueño.
 *   - Cuenta de un profesional: el dueño es ese profesional (`actorPractitionerId`). El Titular NO es dueño de la
 *     cuenta de otro profesional (TP-D12: también necesita la delegación).
 *   - Cuenta del consultorio: la conectó el Titular (decisión 1 del 19-oct), su dueño es quien tiene `account.owner`.
 * `null` = sin cuenta usable (el caller ya distinguió «necesita reconectarse» de «no tiene»).
 */
export function linkAccountGate(
  account: LinkAccountFacts | null,
  actor: { practitionerId: string | null; isAccountOwner: boolean },
  ownerName: string
): { ok: true } | { ok: false; error: string } {
  if (!account) return { ok: false, error: PAYMENT_LINK_COPY.noAccount(ownerName) };
  const owns =
    account.kind === "CLINIC"
      ? actor.isAccountOwner
      : actor.practitionerId != null && actor.practitionerId === account.practitionerId;
  if (owns || account.linksDelegated) return { ok: true };
  return { ok: false, error: PAYMENT_LINK_COPY.notDelegated(ownerName) };
}

// ── Vencimiento ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Vencimiento del link (1/3/7/15/30 días; default 7, TP-D13). Mismo instante en la fila y en la preferencia. */
export function linkExpiresAt(now: Date, days: PaymentLinkExpiryDays | undefined): Date {
  return new Date(now.getTime() + (days ?? PAYMENT_LINK_DEFAULT_EXPIRY_DAYS) * 86_400_000);
}

// ── Página pública ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Estado que ve quien abre `/pagar/[token]` (C-TP9). Solo hay checkout en `payable`.
 *   - Consultorio suspendido o dado de baja → `unavailable` (TP-D23), aunque el cobro esté vivo.
 *   - ACTIVE: vencido por reloj (el cron todavía no lo pasó a EXPIRED) → `expired`; turno cancelado/ausente o ya
 *     cobrado (a mano en otra pestaña antes de que se anulara el link) → `cancelled`: pagar ahí sería cobrar algo que
 *     no corresponde. ACTIVE sin checkout (la preferencia todavía no se creó o falló) → `unavailable`.
 *   - AUTHORIZED → `processing`; PAID → `paid`; REFUNDED → `refunded`; EXPIRED → `expired`; CANCELLED → `cancelled`.
 */
export function publicLinkStatus(
  c: {
    status: string;
    expiresAt: Date;
    checkoutUrl: string | null;
    kind: "FULL" | "DEPOSIT" | "FREE";
    booking: { status: string; paymentStatus: string } | null;
  },
  tenantOpen: boolean,
  now: Date
): PublicPaymentLinkStatus {
  if (!tenantOpen) return "unavailable";
  switch (c.status) {
    case "AUTHORIZED":
      return "processing";
    case "PAID":
      return "paid";
    case "REFUNDED":
      return "refunded";
    case "EXPIRED":
      return "expired";
    case "CANCELLED":
      return "cancelled";
    case "ACTIVE":
      break;
    default:
      return "unavailable";
  }
  if (c.expiresAt.getTime() <= now.getTime()) return "expired";
  const b = c.booking;
  if (b && (b.status === "CANCELLED" || b.status === "NO_SHOW")) return "cancelled";
  if (b && (b.paymentStatus === "PAID" || b.paymentStatus === "REFUNDED" || b.paymentStatus === "AUTHORIZED")) {
    return "cancelled";
  }
  if (!c.checkoutUrl) return "unavailable";
  return "payable";
}

// ── Compartir ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Texto para copiar o mandar por WhatsApp. Lleva el concepto (TP-D27: lo escribió el staff con el aviso de no poner
 * datos clínicos); el mail NO lo lleva. Vencimiento en hora AR (`formatArDateTime`): en Vercel (UTC) un link que vence
 * a las 23:30 AR diría el día siguiente.
 */
export function paymentLinkShareText(p: {
  patientFirstName: string;
  clinicName: string;
  amountCents: number;
  concept: string;
  url: string;
  expiresAt: Date;
}): string {
  const hi = p.patientFirstName.trim() ? `Hola ${p.patientFirstName.trim()}, ` : "Hola, ";
  return (
    `${hi}te mandamos el link de pago de ${p.clinicName.trim()} por ${formatARS(p.amountCents)} (${p.concept.trim()}). ` +
    `Lo pagás con Mercado Pago acá: ${p.url} · Vence el ${formatArDateTime(p.expiresAt)} (hora de Argentina).`
  );
}
