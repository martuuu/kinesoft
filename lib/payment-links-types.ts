/**
 * Links de pago (T5, TP-K1; contrato C-TP9 del plan §25, Anexo B). Vive fuera de `lib/payment-links.ts` y
 * `lib/public-payment-link.ts` porque esos archivos son `"use server"` y solo exportan funciones async.
 *
 * Client-safe: el `PaymentLinkDrawer` (TP-3d) valida con el mismo schema que la action. El copy de los errores vive en
 * `lib/online-payments-copy.ts` (`PAYMENT_LINK_COPY`, TP-P5): acá no se repite.
 */
import { z } from "zod";
import type { ShareContact } from "@/lib/booking-share";
import { MAX_ONLINE_CHARGE_CENTS, MIN_ONLINE_CHARGE_CENTS } from "@/lib/online-charge-logic";

export type { ShareContact } from "@/lib/booking-share";

/**
 * Para qué es el link (C-TP9): `REST` = lo que falta (copago − señas), `TOTAL` = todo (sin seña pagada), `DEPOSIT` =
 * una seña menor que lo que falta, los tres con turno; `FREE` = sin turno, siempre de un paciente (decisión 3).
 */
export type PaymentLinkPurpose = "REST" | "TOTAL" | "DEPOSIT" | "FREE";
export const PAYMENT_LINK_PURPOSES = ["REST", "TOTAL", "DEPOSIT", "FREE"] as const satisfies readonly PaymentLinkPurpose[];

/** Vencimientos permitidos en días (C-TP9); 7 es el default. El CHECK de M18 topea en 31 días. */
export type PaymentLinkExpiryDays = 1 | 3 | 7 | 15 | 30;
export const PAYMENT_LINK_EXPIRY_DAYS = [1, 3, 7, 15, 30] as const satisfies readonly PaymentLinkExpiryDays[];
export const PAYMENT_LINK_DEFAULT_EXPIRY_DAYS: PaymentLinkExpiryDays = 7;

/** Concepto 3..120 (CHECK `OnlineCharge_concept_check`, medido sobre el texto recortado). */
export const PAYMENT_LINK_CONCEPT_MIN = 3;
export const PAYMENT_LINK_CONCEPT_MAX = 120;

/** C-TP9, literal. `amountCents` solo hace falta con `DEPOSIT`/`FREE` (con `REST`/`TOTAL` lo calcula el server). */
export type CreatePaymentLinkInput = {
  patientId: string;
  bookingId?: string;
  practitionerId: string;
  purpose: "REST" | "TOTAL" | "DEPOSIT" | "FREE";
  amountCents?: number;
  concept: string;
  expiresInDays?: 1 | 3 | 7 | 15 | 30;
  idempotencyKey: string;
};

/**
 * Validación de forma de `CreatePaymentLinkInput` (la de negocio — permisos, cuenta, delegación, lo que falta — es del
 * server). Espeja los CHECK de M18: monto $1..$1.000.000 (`OnlineCharge_amount_check`), concepto 3..120 recortado e
 * `idempotencyKey` 8..100 (la UI manda un UUID por instancia del drawer). TP-ZF1 (B6): el server la guarda como
 * `link:<key>` (+5) y el CHECK `OnlineCharge_idempotencyKey_check` es 8..120: con el tope en 120 una key de 116..120
 * pasaba acá y rompía el INSERT. 100 deja margen para el prefijo.
 */
export const CreatePaymentLinkSchema = z
  .object({
    patientId: z.string().min(1).max(40),
    bookingId: z.string().min(1).max(40).optional(),
    practitionerId: z.string().min(1).max(40),
    purpose: z.enum(PAYMENT_LINK_PURPOSES),
    amountCents: z.number().int().min(MIN_ONLINE_CHARGE_CENTS).max(MAX_ONLINE_CHARGE_CENTS).optional(),
    concept: z.string().trim().min(PAYMENT_LINK_CONCEPT_MIN).max(PAYMENT_LINK_CONCEPT_MAX),
    expiresInDays: z
      .union([z.literal(1), z.literal(3), z.literal(7), z.literal(15), z.literal(30)])
      .optional(),
    idempotencyKey: z.string().min(8).max(100),
  })
  .superRefine((v, ctx) => {
    if (v.purpose === "FREE" && v.bookingId !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bookingId"], message: "Un link sin turno no lleva turno." });
    }
    if (v.purpose !== "FREE" && v.bookingId === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bookingId"], message: "Elegí el turno." });
    }
    if ((v.purpose === "DEPOSIT" || v.purpose === "FREE") && v.amountCents === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["amountCents"], message: "Poné el monto." });
    }
  });

/** Resultado de `createPaymentLink` (C-TP9, literal). `expiresAt` en ISO. */
export type CreatePaymentLinkResult = {
  chargeId: string;
  url: string;
  amountCents: number;
  expiresAt: string;
  accountKind: "PRACTITIONER" | "CLINIC";
};

export type PaymentLinkChargeInput = { chargeId: string };
export type CancelPaymentLinkResult = { status: "CANCELLED" };
/** `sentToMasked`: el email enmascarado (como M-3 de T4), nunca el completo. Tope 3 por hora por cobro. */
export type SendPaymentLinkEmailResult = { sentToMasked: string };

/** Resultado de `getPaymentLinkShare` (C-TP9, literal): texto para copiar, `wa.me` (null sin celular válido) y contacto. */
export type PaymentLinkShare = { url: string; text: string; waUrl: string | null; contact: ShareContact };

/**
 * Resultado de `getPaymentLinkSuggestions` (C-TP9, literal; tipos fijados acá): montos que ofrece «¿Cuánto?» del drawer.
 * `blocked`: motivo legible por el que no se puede generar (sin cuenta, sin delegación, turno cobrado, link vivo…); null
 * = se puede.
 */
export type PaymentLinkSuggestions = {
  remainingCents: number;
  totalCents: number;
  depositPaidCents: number;
  canTotal: boolean;
  accountKind: "PRACTITIONER" | "CLINIC" | null;
  blocked: string | null;
};

// ── Página pública `/pagar/[token]` (sin Actor) ─────────────────────────────────────────────────────────────────────

/** Token público del link: 16 bytes en base64url = 22 caracteres (CHECK `OnlineCharge_token_check`). */
export const PUBLIC_PAYMENT_TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
export const PublicPaymentTokenSchema = z.string().regex(PUBLIC_PAYMENT_TOKEN_RE);

export type PublicPaymentLinkStatus = "payable" | "processing" | "paid" | "expired" | "cancelled" | "refunded" | "unavailable";
export const PUBLIC_PAYMENT_LINK_STATUSES = [
  "payable",
  "processing",
  "paid",
  "expired",
  "cancelled",
  "refunded",
  "unavailable",
] as const satisfies readonly PublicPaymentLinkStatus[];

/**
 * C-TP9, literal. Sin NINGÚN dato del paciente: el link se reenvía y lo abren antivirus de mail. `checkoutUrl` solo en
 * `payable`. `expiresAt` en ISO.
 */
export type PublicPaymentLink = {
  status: "payable" | "processing" | "paid" | "expired" | "cancelled" | "refunded" | "unavailable";
  clinicName: string;
  practitionerName: string | null;
  amountCents: number;
  concept: string;
  expiresAt: string;
  checkoutUrl: string | null;
  receipt: { operationId: string; approvedAtLabel: string; methodLabel: string } | null;
};
