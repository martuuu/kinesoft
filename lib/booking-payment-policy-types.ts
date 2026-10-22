/**
 * Política de cobro online del turnero (T5, TP-K1; contrato C-TP5 del plan §25, Anexo B). Vive fuera de
 * `lib/booking-payment-policy.ts` porque ese archivo es `"use server"` y solo exporta funciones async.
 *
 * Client-safe: el panel «Cobros online» (TP-3a) valida con el mismo schema que la action, así el error de forma se ve
 * antes de mandar.
 */
import { z } from "zod";
import type { OnlineChargePolicy } from "@/lib/online-charge-logic";
import { MAX_ONLINE_CHARGE_CENTS, MIN_ONLINE_CHARGE_CENTS } from "@/lib/online-charge-logic";

/** C-TP5, literal. `fixedCents` solo con FIXED, `percentBps` solo con PERCENT (1 bps = 0,01 %). */
export type PaymentPolicyInput = {
  mode: "OFF" | "OPTIONAL" | "REQUIRED";
  chargeKind: "COPAGO" | "FIXED" | "PERCENT";
  fixedCents: number | null;
  percentBps: number | null;
  useClinicAccount: boolean;
  cancellationNote: string | null;
};

// `PaymentPolicyInput` tiene que poder pasarse tal cual a `decideOnlineCharge`/`quoteOnlineCharge` (TP-P3 declara
// `OnlineChargePolicy` como subconjunto estructural para no depender de este archivo). Si alguno de los dos cambia de
// forma, esto deja de compilar.
type _PolicyFitsLogic = PaymentPolicyInput extends OnlineChargePolicy ? true : never;
const _policyFitsLogic: _PolicyFitsLogic = true;
void _policyFitsLogic;

export type BookingPaymentMode = PaymentPolicyInput["mode"];
export type BookingChargeKind = PaymentPolicyInput["chargeKind"];
export const BOOKING_PAYMENT_MODES = ["OFF", "OPTIONAL", "REQUIRED"] as const satisfies readonly BookingPaymentMode[];
export const BOOKING_CHARGE_KINDS = ["COPAGO", "FIXED", "PERCENT"] as const satisfies readonly BookingChargeKind[];

/** Tope de la nota de cancelación (CHECK `BookingPaymentPolicy_note_check`). */
export const CANCELLATION_NOTE_MAX = 280;
/** 100 % en puntos básicos (CHECK `BookingPaymentPolicy_amount_check`). */
export const PERCENT_BPS_MAX = 10_000;

/** Sin fila de política = esto (el default de las columnas de M18): el turnero reserva sin cobro, como TP-0. */
export const DEFAULT_PAYMENT_POLICY: PaymentPolicyInput = {
  mode: "OFF",
  chargeKind: "COPAGO",
  fixedCents: null,
  percentBps: null,
  useClinicAccount: false,
  cancellationNote: null,
};

/**
 * Zod espejo de los CHECK de M18 (`BookingPaymentPolicy_amount_check` y `_note_check`): un input que pasa acá no puede
 * violar la constraint (que sería un 23514 crudo). La nota se recorta y vacía = null, como la mide el CHECK
 * (`char_length(btrim(...)) BETWEEN 1 AND 280`).
 */
export const PaymentPolicySchema = z
  .object({
    mode: z.enum(BOOKING_PAYMENT_MODES),
    chargeKind: z.enum(BOOKING_CHARGE_KINDS),
    fixedCents: z.number().int().min(MIN_ONLINE_CHARGE_CENTS).max(MAX_ONLINE_CHARGE_CENTS).nullable(),
    percentBps: z.number().int().min(1).max(PERCENT_BPS_MAX).nullable(),
    useClinicAccount: z.boolean(),
    cancellationNote: z.preprocess(
      (v) => (typeof v === "string" ? (v.trim() === "" ? null : v.trim()) : v),
      z.string().max(CANCELLATION_NOTE_MAX).nullable()
    ),
  })
  .superRefine((p, ctx) => {
    if (p.chargeKind === "FIXED" && p.fixedCents == null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["fixedCents"], message: "Poné el monto de la seña." });
    }
    if (p.chargeKind === "PERCENT" && p.percentBps == null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["percentBps"], message: "Poné el porcentaje." });
    }
    if (p.chargeKind !== "FIXED" && p.fixedCents != null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["fixedCents"], message: "El monto fijo va solo con «seña fija»." });
    }
    if (p.chargeKind !== "PERCENT" && p.percentBps != null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["percentBps"], message: "El porcentaje va solo con «porcentaje»." });
    }
  });

/** Resultado de `savePaymentPolicy` (C-TP5): el nuevo `updatedAt` (ISO) para el próximo optimistic lock. */
export type SavePaymentPolicyResult = { updatedAt: string };
