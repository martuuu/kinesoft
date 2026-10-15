/**
 * Tipos de los cobros de la suscripción (PL-2b, C-PL7..10 sin Mercado Pago). Client-safe (solo tipos y una constante
 * de copy): los comparten el núcleo (`lib/saas-billing-internal.ts`), las actions de Configuración →
 * Facturación (`lib/saas-billing.ts`, "use server": no puede exportar tipos) y de Plataforma
 * (`lib/platform-billing.ts`), y la UI de PL-3a/3c.
 *
 * Fechas: los períodos y vencimientos van como clave civil AR «YYYY-MM-DD» (se muestran tal cual, sin pasar por el TZ
 * del navegador); los instantes (pago, revisión) como ISO.
 */
import type {
  SaasChargeStatus,
  SaasPaymentSource,
  SaasPaymentStatus,
  SaasPlan,
  SubscriptionStatus,
} from "@prisma/client";
import type { SaasBillingMode } from "@/lib/env";

export type { SaasBillingMode };

export type BillingChargeRow = {
  id: string;
  plan: SaasPlan;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  amountCents: number;
  /** Pagos aprobados imputados a este cargo. */
  paidCents: number;
  /** Lo que falta (0 si no está OPEN). */
  remainingCents: number;
  status: SaasChargeStatus;
  overdue: boolean;
  paidAt: string | null;
  note: string | null;
};

export type BillingPaymentRow = {
  id: string;
  chargeId: string | null;
  /** Período del cargo imputado («YYYY-MM-DD»), para mostrarlo sin buscar el cargo. */
  chargePeriodStart: string | null;
  source: SaasPaymentSource;
  status: SaasPaymentStatus;
  amountCents: number;
  paidAt: string | null;
  createdAt: string;
  hasReceipt: boolean;
  receiptMimeType: string | null;
  note: string | null;
  /** Motivo del rechazo (o nota de la aprobación) que escribió Plataforma. */
  reviewNote: string | null;
  reviewedAt: string | null;
};

/** Lo que se cobra en el próximo período (o null si no se cobra: plan en «Consultá» y sin precio a medida). */
export type BillingNextCharge = { periodStart: string; amountCents: number | null };

export type BillingLedger = {
  tenantId: string;
  plan: SaasPlan;
  planLabel: string;
  /** Precio de lista del plan (null = «Consultá»). */
  planPriceCents: number | null;
  /** Precio a medida del consultorio (null = el del plan). */
  customPriceCents: number | null;
  /** Lo que se cobra por mes: a medida > lista; null = no se cobra. */
  effectivePriceCents: number | null;
  subscriptionStatus: SubscriptionStatus;
  trialEndsAt: string | null;
  /** Día del mes en que arranca cada período (1..28); null si todavía no hay suscripción creada. */
  anchorDay: number | null;
  nextCharge: BillingNextCharge | null;
  /** > 0 = debe; < 0 = saldo a favor. Centavos. */
  balanceCents: number;
  /** Pagos aprobados sin cargo (a cuenta). */
  creditCents: number;
  overdueCount: number;
  pendingReviewCount: number;
  charges: BillingChargeRow[];
  payments: BillingPaymentRow[];
};

/** Configuración → Facturación (C-PL9 `getBillingOverview`). */
export type BillingOverview = BillingLedger & {
  mode: SaasBillingMode;
  /** ¿Puede subir comprobantes? (modo distinto de off y con datos para transferir). */
  canSubmitReceipt: boolean;
  /** Datos para transferir (`SAAS_BILLING_TRANSFER_INFO`); null = no configurados. */
  transferInfo: string | null;
};

export type SubmitPaymentReceiptResult = { paymentId: string };

/** Copy común de errores de cobro (consultorio y Plataforma). */
export const BILLING_COPY = {
  stale: "Otro cambio se guardó antes. Recargá y revisá.",
  modeOff: "El cobro de la suscripción todavía no está habilitado.",
  receiptRequired: "Adjuntá el comprobante (PDF, JPG, PNG o WEBP de hasta 4 MB).",
  amountInvalid: "Ingresá un monto mayor a cero.",
  chargeNotOpen: "Ese cargo ya no está pendiente. Recargá y revisá.",
  chargeNotFound: "No encontramos ese cargo.",
  paymentNotFound: "No encontramos ese pago.",
  alreadyReviewed: "Ese comprobante ya se revisó.",
  reasonRequired: "Escribí el motivo del rechazo (lo va a ver el consultorio).",
  hasPayments: "El cargo tiene pagos aprobados: condonalo en vez de anularlo.",
  noReceipt: "Ese pago no tiene comprobante.",
} as const;

/** Resultado de `applyPlanChange` / `platformApplyPlanChange`: en el error va la razón para que el drawer reaccione. */
export type PlanChangeActionResult =
  | { ok: true; data: { disabled: number; reactivated: number; revokedInvites: number } }
  | {
      ok: false;
      error: string;
      reason?: "stale" | "not_found" | "does_not_fit" | "owner_selected" | "self_selected" | "invalid_selection" | "libre_platform_only" | "invalid_input";
      detail?: string;
    };

export const PLAN_CHANGE_COPY = {
  stale: BILLING_COPY.stale,
  not_found: "No encontramos el consultorio.",
  does_not_fit: "Con ese plan sobran usuarios: elegí a quiénes deshabilitar.",
  owner_selected: "El titular no puede perder el acceso.",
  self_selected: "No podés quitarte el acceso a vos mismo.",
  invalid_selection: "Revisá la selección y probá de nuevo.",
  libre_platform_only: "El plan Libre se arma a medida. Escribinos desde Soporte y lo vemos juntos.",
  invalid_input: "Datos inválidos.",
  /** PL-Z a3#1: `detail: "custom_limits"` (Libre con cupos a medida): el cambio de plan lo hace Plataforma. */
  custom_limits: "Tu consultorio tiene cupos a medida: escribinos para cambiar el plan.",
  /** PL-Z a3#2: elegir a quién se le corta el acceso exige también `tenant.admin`. */
  needs_settings: "Para elegir a quién deshabilitar necesitás también permiso de Configuración.",
} as const;
