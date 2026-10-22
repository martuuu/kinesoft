/**
 * Tipos compartidos de los cobros online (T5, TP-K1; contratos C-TP7, C-TP9 y C-TP14 del plan §25, Anexo B). DTOs
 * CONGELADOS: los importan en paralelo las actions (TP-K2), los internos (TP-K3) y la UI (TP-K4); cambiar una forma acá
 * es cambiar un contrato, no un detalle.
 *
 * Client-safe: solo tipos y constantes. Los unions de estado/origen/tipo NO se redefinen: salen de
 * `lib/online-charge-logic.ts` (TP-P3), que es la fuente de las reglas. Que coincidan con los enums de Prisma de M18
 * (`OnlineChargeStatus`, `OnlineChargeOrigin`, `OnlineChargeKind`, `MpAccountKind`, `MpAccountStatus`) lo afirma
 * `tests/unit/tp-k1-types.test.ts` en tipo y en runtime: un valor nuevo en el enum sin tocar acá rompe ese test.
 */
import type { ChargeKind, ChargeOrigin, ChargeStatus } from "@/lib/online-charge-logic";

export type { BookingEffect, ChargeKind, ChargeOrigin, ChargeStatus, MpPaymentStatus } from "@/lib/online-charge-logic";

/** Valores de `OnlineChargeStatus` (M18), en el orden del enum. */
export const CHARGE_STATUSES = ["ACTIVE", "AUTHORIZED", "PAID", "REFUNDED", "EXPIRED", "CANCELLED"] as const satisfies readonly ChargeStatus[];
/** Valores de `OnlineChargeOrigin` (M18). */
export const CHARGE_ORIGINS = ["TURNERO", "LINK"] as const satisfies readonly ChargeOrigin[];
/** Valores de `OnlineChargeKind` (M18). */
export const CHARGE_KINDS = ["FULL", "DEPOSIT", "FREE"] as const satisfies readonly ChargeKind[];

/** `MpAccountKind` (M18): de un profesional o del consultorio (`practitionerId` NULL). */
export type MpAccountKind = "PRACTITIONER" | "CLINIC";
export const MP_ACCOUNT_KINDS = ["PRACTITIONER", "CLINIC"] as const satisfies readonly MpAccountKind[];

/** `MpAccountStatus` (M18). La vista suma «NONE» (sin fila): ver `MpAccountView` en `lib/mp-connect-types.ts`. */
export type MpAccountStatus = "ACTIVE" | "REAUTH_REQUIRED" | "DISCONNECTED";
export const MP_ACCOUNT_STATUSES = ["ACTIVE", "REAUTH_REQUIRED", "DISCONNECTED"] as const satisfies readonly MpAccountStatus[];

/**
 * Motivo de anulación (`OnlineCharge.cancelReason`, CHECK `OnlineCharge_cancel_check` de M18). Lo escriben:
 * `manual` (anular el link), `collected` (cobro a mano, C-TP10), `preference_failed` (MP no creó la preferencia),
 * `account_disconnected` (desconectar la cuenta) y `booking_cancelled` (cron, link de un turno cancelado).
 */
export type ChargeCancelReason = "manual" | "collected" | "preference_failed" | "account_disconnected" | "booking_cancelled";
export const CHARGE_CANCEL_REASONS = [
  "manual",
  "collected",
  "preference_failed",
  "account_disconnected",
  "booking_cancelled",
] as const satisfies readonly ChargeCancelReason[];

/** Avisos de un cobro que la UI muestra como chip/nota (C-TP9, `OnlineChargeView.notices`). */
export type OnlineChargeNotice = "duplicate" | "late-after-cancel" | "partial-refund" | "disputed" | "amount-mismatch";

/**
 * Un cobro online como lo ven el drawer del turno, Facturación del paciente y `/cobros` (C-TP9, literal; los campos
 * que el Anexo B deja sin tipo se fijan acá). Fechas en ISO (cruzan el borde server → cliente); los `*Label` ya vienen
 * en hora AR desde el server. Nunca trae `publicToken` suelto (solo la URL armada en `link`), `rawPayload`,
 * `idempotencyKey` ni nada de la credencial.
 */
export type OnlineChargeView = {
  id: string;
  origin: ChargeOrigin;
  kind: ChargeKind;
  status: ChargeStatus;
  statusLabel: string;
  amountCents: number;
  concept: string | null;
  createdAt: string;
  expiresAt: string;
  practitionerName: string | null;
  accountKind: "PRACTITIONER" | "CLINIC";
  receipt: null | OnlineChargeReceiptView;
  link: null | { url: string; canCancel: boolean; canResend: boolean };
  notices: OnlineChargeNotice[];
};

/** Comprobante de un cobro PAID/REFUNDED (TP-D20). `approvedAt` en ISO; `approvedAtLabel` ya formateado en hora AR. */
export type OnlineChargeReceiptView = {
  operationId: string;
  approvedAt: string;
  approvedAtLabel: string;
  paidAmountCents: number;
  methodLabel: string;
  statusLabel: string;
  refundedAt: string | null;
};

/** Input de `listOnlineCharges` (C-TP9, `/cobros`): filtros de la URL. `status`/`period` llegan como texto y los valida el server. */
export type ListOnlineChargesInput = {
  origin?: "TURNERO" | "LINK";
  status?: string;
  period?: string;
  practitionerId?: string;
  cursor?: string;
};

/** Resultado de `listOnlineCharges` (C-TP9, literal). */
export type ListOnlineChargesResult = {
  rows: OnlineChargeView[];
  nextCursor: string | null;
  summary: { paidCents: number; liveCount: number; liveCents: number };
};

/**
 * Acciones de auditoría de T5 (C-TP14). Todas van con `auditInTx` en la tx del write: NINGUNA entra en
 * `SECURITY_EVENT_ACTIONS` ni en `SUPPORT_WRITABLE_ACTIONS` (por eso `lib/audit.ts` no cambia). `booking.copago_paid`
 * ya existe; T5 le suma `depositCents` al payload. Constantes para que los call sites no tipeen el string a mano.
 */
export const ONLINE_PAYMENTS_AUDIT = {
  mpAccountConnect: "mpAccount.connect",
  mpAccountDisconnect: "mpAccount.disconnect",
  mpAccountDelegation: "mpAccount.delegation",
  mpAccountReauthRequired: "mpAccount.reauth_required",
  paymentPolicyUpdate: "bookingPaymentPolicy.update",
  paymentLinkCreate: "paymentLink.create",
  paymentLinkCancel: "paymentLink.cancel",
  bookingCopagoPaid: "booking.copago_paid",
  bookingCopagoPaidOnline: "booking.copago_paid_online",
  onlineChargeRefunded: "onlineCharge.refunded",
} as const;
export type OnlinePaymentsAuditAction = (typeof ONLINE_PAYMENTS_AUDIT)[keyof typeof ONLINE_PAYMENTS_AUDIT];
