/**
 * [TP-P5] Vista pura del comprobante de un pago de Mercado Pago (TP-D20: lo cobrado queda imputado al turno con su
 * comprobante; TP-UI-D11: plegable en el drawer, Modal en Facturación y /cobros; también `/pagar` y el resultado del
 * turnero).
 *
 * Entrada = las columnas de comprobante de `OnlineCharge` (M18: `mpPaymentId`, `approvedAt`, `paidAmountCents`,
 * `paymentMethodId`, `paymentTypeId`, `installments`, `mpStatus`, `refundedAt`), que el CHECK
 * `OnlineCharge_receipt_check` escribe todas juntas al pasar a PAID/REFUNDED. Salida = filas ya formateadas, para que
 * las cinco superficies muestren lo mismo y ninguna formatee fechas por su cuenta.
 *
 * Por qué la fecha va por `lib/datetime-ar.ts` y no por `toLocaleString` del host: el comprobante también se arma en
 * el server (`OnlineChargeView.receipt.approvedAtLabel`, `PublicPaymentLink.receipt`), que en Vercel corre en UTC; un
 * pago de las 23:30 AR saldría con el día siguiente. Lo fija `tests/unit/mp-receipt.test.ts` en TZ=UTC y TZ=AR.
 *
 * Client-safe y liviano (va diferido en el drawer de `/agenda`, §25.11): solo `datetime-ar`, `format` y el copy.
 */
import { toARDateKey, toARMinutes } from "@/lib/datetime-ar";
import { formatARS } from "@/lib/format";
import {
  MP_CARD_BRAND_LABEL,
  MP_METHOD_FALLBACK,
  MP_PAYMENT_TYPE_LABEL,
  MP_STATUS_LABEL,
  MP_STATUS_UNKNOWN,
  RECEIPT_COPY,
} from "@/lib/online-payments-copy";

export type MpReceiptInput = {
  mpPaymentId: string | null;
  approvedAt: Date | string | null;
  paidAmountCents: number | null;
  paymentMethodId?: string | null;
  paymentTypeId?: string | null;
  installments?: number | null;
  mpStatus?: string | null;
  refundedAt?: Date | string | null;
  /** Cuenta que recibió la plata (opcional): suma la fila «Acreditado en». */
  account?: { kind: "PRACTITIONER" | "CLINIC"; practitionerName?: string | null } | null;
};

export type MpReceiptRowKey = "operation" | "date" | "amount" | "method" | "installments" | "status" | "account" | "refunded";
export type MpReceiptRow = { key: MpReceiptRowKey; label: string; value: string };

export type MpReceiptView = {
  operationId: string;
  /** ISO UTC (para ordenar o volver a formatear); la UI muestra `approvedAtLabel`. */
  approvedAt: string;
  approvedAtLabel: string;
  paidAmountCents: number;
  amountLabel: string;
  methodLabel: string;
  installmentsLabel: string;
  statusLabel: string;
  refundedAt: string | null;
  refundedAtLabel: string | null;
  rows: MpReceiptRow[];
};

function toDate(d: Date | string | null | undefined): Date | null {
  if (d == null) return null;
  const date = typeof d === "string" ? new Date(d) : d;
  return Number.isNaN(date.getTime()) ? null : date;
}

/** «20/10/2026, 23:30» en hora de Argentina, cualquiera sea la TZ del host. Inválida o vacía → "". */
export function formatArDateTime(d: Date | string | null | undefined): string {
  const date = toDate(d);
  if (!date) return "";
  const [yyyy, mm, dd] = toARDateKey(date).split("-");
  const min = toARMinutes(date);
  const hh = String(Math.floor(min / 60)).padStart(2, "0");
  const mi = String(min % 60).padStart(2, "0");
  return `${dd}/${mm}/${yyyy}, ${hh}:${mi}`;
}

/**
 * «Tarjeta de crédito Visa». La marca solo acompaña a las tarjetas (en `account_money` el `payment_method_id` repite el
 * tipo). Un tipo que MP sume mañana cae a «Mercado Pago»: nunca se muestra el id crudo («digital_currency»).
 */
export function mpMethodLabel(paymentTypeId: string | null | undefined, paymentMethodId: string | null | undefined): string {
  const type = paymentTypeId ? MP_PAYMENT_TYPE_LABEL[paymentTypeId] : undefined;
  const isCard = paymentTypeId === "credit_card" || paymentTypeId === "debit_card" || paymentTypeId === "prepaid_card";
  const brand = isCard && paymentMethodId ? MP_CARD_BRAND_LABEL[paymentMethodId] : undefined;
  if (type) return brand ? `${type} ${brand}` : type;
  return MP_METHOD_FALLBACK;
}

export function mpInstallmentsLabel(n: number | null | undefined): string {
  return n != null && Number.isInteger(n) && n > 1 ? RECEIPT_COPY.manyInstallments(n) : RECEIPT_COPY.oneInstallment;
}

export function mpStatusLabel(s: string | null | undefined): string {
  return (s && MP_STATUS_LABEL[s]) || MP_STATUS_UNKNOWN;
}

/**
 * Comprobante listo para mostrar, o `null` si el cobro no tiene comprobante (no se pagó) o la fila está rota: mejor no
 * mostrar un comprobante que mostrar uno con «Invalid Date» o un número de operación que no es de MP (el CHECK de M18
 * exige `^[0-9]{1,20}$`).
 */
export function buildMpReceipt(input: MpReceiptInput): MpReceiptView | null {
  const approved = toDate(input.approvedAt);
  if (!input.mpPaymentId || !/^[0-9]{1,20}$/.test(input.mpPaymentId) || !approved) return null;
  if (input.paidAmountCents == null || !Number.isFinite(input.paidAmountCents) || input.paidAmountCents < 0) return null;

  const approvedAtLabel = formatArDateTime(approved);
  const amountLabel = formatARS(input.paidAmountCents);
  const methodLabel = mpMethodLabel(input.paymentTypeId, input.paymentMethodId);
  const installmentsLabel = mpInstallmentsLabel(input.installments);
  const statusLabel = mpStatusLabel(input.mpStatus);
  const refunded = toDate(input.refundedAt);
  const refundedAtLabel = refunded ? formatArDateTime(refunded) : null;

  const rows: MpReceiptRow[] = [
    { key: "operation", label: RECEIPT_COPY.operation, value: input.mpPaymentId },
    { key: "date", label: RECEIPT_COPY.date, value: approvedAtLabel },
    { key: "amount", label: RECEIPT_COPY.amount, value: amountLabel },
    { key: "method", label: RECEIPT_COPY.method, value: methodLabel },
    { key: "installments", label: RECEIPT_COPY.installments, value: installmentsLabel },
    { key: "status", label: RECEIPT_COPY.status, value: statusLabel },
  ];
  if (input.account) {
    const name = input.account.practitionerName?.trim();
    rows.push({
      key: "account",
      label: RECEIPT_COPY.account,
      value:
        input.account.kind === "PRACTITIONER" && name ? RECEIPT_COPY.practitionerAccount(name) : RECEIPT_COPY.clinicAccount,
    });
  }
  if (refundedAtLabel) rows.push({ key: "refunded", label: RECEIPT_COPY.refunded, value: refundedAtLabel });

  return {
    operationId: input.mpPaymentId,
    approvedAt: approved.toISOString(),
    approvedAtLabel,
    paidAmountCents: input.paidAmountCents,
    amountLabel,
    methodLabel,
    installmentsLabel,
    statusLabel,
    refundedAt: refunded ? refunded.toISOString() : null,
    refundedAtLabel,
    rows,
  };
}

/** Forma corta de las superficies públicas (C-TP8 `PublicBookingStatus.onlineCharge.receipt`, C-TP9 `/pagar`). */
export function mpReceiptSummary(v: MpReceiptView): { operationId: string; approvedAtLabel: string; methodLabel: string } {
  return { operationId: v.operationId, approvedAtLabel: v.approvedAtLabel, methodLabel: v.methodLabel };
}

/** Forma de `OnlineChargeView.receipt` (C-TP9), para el staff. */
export function chargeReceiptOf(v: MpReceiptView): {
  operationId: string;
  approvedAt: string;
  approvedAtLabel: string;
  paidAmountCents: number;
  methodLabel: string;
  statusLabel: string;
  refundedAt: string | null;
} {
  return {
    operationId: v.operationId,
    approvedAt: v.approvedAt,
    approvedAtLabel: v.approvedAtLabel,
    paidAmountCents: v.paidAmountCents,
    methodLabel: v.methodLabel,
    statusLabel: v.statusLabel,
    refundedAt: v.refundedAt,
  };
}
