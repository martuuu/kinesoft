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
  SaasAdjustmentKind as PrismaSaasAdjustmentKind,
  SaasChargeStatus,
  SaasCollectionMethod as PrismaSaasCollectionMethod,
  SaasPaymentMethod,
  SaasPaymentSource,
  SaasPaymentStatus,
  SaasPlan,
  SubscriptionStatus,
} from "@prisma/client";
import type { SaasBillingMode } from "@/lib/env";

export type { SaasBillingMode };

/**
 * Medio de pago de un `SaasPayment` (PL-F1a sobre M8c; decisión de Martin del 16-oct: «la columna y los medios de pago
 * típicos»). Antes de M8c el medio viajaba como prefijo de la nota («Medio: Transferencia. …»): ahora va en la columna
 * y la nota queda como la escribió la persona. El orden es el de los selects. Mismo set que el enum de Postgres
 * (tests/integration/pl-m8c.test.ts lo fija contra `pg_enum`).
 */
export const SAAS_PAYMENT_METHODS = ["TRANSFER", "CASH", "CARD", "WALLET", "MERCADO_PAGO", "OTHER"] as const satisfies readonly SaasPaymentMethod[];

/*
 * T3 (C-AS2): las etiquetas y «Sin informar» viven en `lib/payment-method.ts`, compartidas con el cobro del turno
 * (`BookingPaymentMethod` de M12 tiene los mismos valores). Se re-exportan con los nombres de siempre para no tocar a
 * los importadores de la suscripción; el orden de los selects de acá (`SAAS_PAYMENT_METHODS`) no cambia.
 * `SAAS_PAYMENT_METHOD_UNKNOWN`: pagos de antes de M8c (columna NULL).
 */
export {
  PAYMENT_METHOD_LABEL as SAAS_PAYMENT_METHOD_LABEL,
  PAYMENT_METHOD_UNKNOWN as SAAS_PAYMENT_METHOD_UNKNOWN,
  paymentMethodLabel,
} from "@/lib/payment-method";

export function isSaasPaymentMethod(v: unknown): v is SaasPaymentMethod {
  return typeof v === "string" && (SAAS_PAYMENT_METHODS as readonly string[]).includes(v);
}

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
  /** null = pago de antes de M8c («Sin informar»). */
  method: SaasPaymentMethod | null;
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
export type BillingNextCharge = {
  periodStart: string;
  amountCents: number | null;
  /** MPS (C-MPS5): desglose `{base, adjustments, credit, amount}`; ausente en el ledger previo a M16. */
  breakdown?: BillingNextChargeBreakdown;
};

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
} & BillingLedgerMps;

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
  methodRequired: "Elegí el medio de pago.",
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

// ── MPS (T6, §26.6 · C-MPS5..C-MPS11): Mercado Pago en la suscripción ─────────────────────────────────────────────
/*
 * MPS-K publica estos tipos como CONTRATO para las sesiones de X2-X4 (MPS-2a escritor, MPS-2b webhook/sync, MPS-2c
 * programación, MPS-3a/3b actions, MPS-4a/4b UI). Todo lo nuevo del ledger entra como campo OPCIONAL: `readLedger`
 * (MPS-2a) y los fixtures de render existentes siguen compilando sin tocarlos; cuando MPS-2a los llene siempre, la UI
 * puede tratarlos como presentes (la ausencia = «ledger previo a M16», se muestra como sin MP).
 */

/** Cómo paga el consultorio (M16 `SaasCollectionMethod`). null en la suscripción = todavía no eligió (sin preselección). */
export type SaasCollectionMethod = "AUTO_DEBIT" | "MP_CHECKOUT" | "TRANSFER";
/** Orden del selector «Cómo pagás» (§26.6 UI). `satisfies` ata la unión al enum de Prisma: si M16 cambia, no compila. */
export const SAAS_COLLECTION_METHODS = ["AUTO_DEBIT", "MP_CHECKOUT", "TRANSFER"] as const satisfies readonly PrismaSaasCollectionMethod[];

/** Tipo de ajuste (M16 `SaasAdjustmentKind`): CREDIT es el único con monto negativo (CHECK de la base). */
export type SaasAdjustmentKind = "PRORATION" | "CREDIT" | "DEBIT" | "CARRYOVER";
export const SAAS_ADJUSTMENT_KINDS = ["PRORATION", "CREDIT", "DEBIT", "CARRYOVER"] as const satisfies readonly PrismaSaasAdjustmentKind[];

/** Resultado de `planChangeKind` (C-MPS2, `lib/saas-billing-logic.ts`). */
export type PlanChangeKind = "immediate" | "upgrade_prorated" | "scheduled_downgrade" | "blocked_cancel_pending";

/**
 * C-MPS10: lo que `previewPlanChange` suma como `billing`. `effectiveOn` = clave AR del día en que rige (hoy en una
 * subida, el próximo 4 en una bajada); `prorationCents` = lo que se suma al próximo cargo (0 si no hay proporcional,
 * MPS-D11); `days`/`periodDays` = días cobrados / días del período (para el copy «N de M días»).
 */
export type PlanChangeBilling = {
  kind: PlanChangeKind;
  effectiveOn: string;
  prorationCents: number;
  days: number;
  periodDays: number;
};

/** Un ajuste tal como lo ve el consultorio o Plataforma (C-MPS5 `readLedger`). Montos con signo, en centavos. */
export type BillingAdjustmentRow = {
  id: string;
  kind: SaasAdjustmentKind;
  amountCents: number;
  /** Clave AR «YYYY-MM-DD»: se imputa al primer cargo con periodStart ≥ esta fecha. */
  effectiveOn: string;
  description: string;
  planFrom: SaasPlan | null;
  planTo: SaasPlan | null;
  days: number | null;
  periodDays: number | null;
  /** null = pendiente (todavía no entró en un cargo). */
  appliedChargeId: string | null;
  appliedAt: string | null;
  createdAt: string;
};

/**
 * Proyección del próximo cargo con desglose (C-MPS5): `amountCents` = max(0, base + ajustes + crédito), nunca
 * negativo (`composeCharge`). `creditCents` ≤ 0 (saldo a favor que se aplica). null en los campos = plan sin precio.
 */
export type BillingNextChargeBreakdown = {
  baseCents: number | null;
  adjustmentsCents: number;
  creditCents: number;
  amountCents: number | null;
};

/**
 * Estado del débito automático (C-MPS5/§26.6 UI):
 *  - `none`: sin preapproval;
 *  - `pending_authorization`: «Falta autorizar…» (hay `initPoint`);
 *  - `active`: «Débito activo · m***@… · próximo 4/12 por $X»;
 *  - `paused`: MP no debita este mes (proyección 0 o baja programada, `desiredDebit`);
 *  - `failed`: «No pudimos debitar…» (último débito rechazado);
 *  - `cancelled`: cancelado (desde MP o por cambiar de método);
 *  - `blocked`: Plataforma no lo permite (`autoDebitAllowed = false`).
 */
export type BillingAutoDebitStatus = "none" | "pending_authorization" | "active" | "paused" | "failed" | "cancelled" | "blocked";

export type BillingAutoDebitState = {
  status: BillingAutoDebitStatus;
  /** Plataforma lo permite (`autoDebitAllowed`, MPS-D24 default true). */
  allowed: boolean;
  /** Email del pagador ENMASCARADO («m***@gmail.com»): el completo nunca sale del server. */
  payerEmailMasked: string | null;
  /** Monto que tiene el preapproval en MP (centavos). */
  amountCents: number | null;
  /** Próximo débito, clave AR «YYYY-MM-DD». */
  nextDebitOn: string | null;
  /** Link de autorización del preapproval pendiente (solo en `pending_authorization`). */
  initPoint: string | null;
  /** Último sync con MP (ISO). */
  syncedAt: string | null;
};

/** Baja programada a fin de período (C-MPS9): acceso completo hasta `effectiveOn` («Deshacer baja»). */
export type BillingCancelState = {
  effectiveOn: string;
  requestedAt: string | null;
};

/** Bajada de plan programada (C-MPS9): «Tu plan pasa a Individual el 4/12…». */
export type BillingPendingPlan = {
  plan: SaasPlan;
  planLabel: string;
  effectiveOn: string;
  /** Cuántos usuarios se deshabilitan al aplicarla (los ids no viajan al cliente). */
  disableCount: number;
};

/** Desglose MPS por cargo (se suma a `BillingChargeRow` en el ledger nuevo). */
export type BillingChargeBreakdown = {
  /** Precio del plan del período (null = cargo previo a M16). */
  baseAmountCents: number | null;
  /** Suma con signo de los ajustes imputados. */
  adjustmentsCents: number;
  adjustments: BillingAdjustmentRow[];
  /** Hay un «Pagar con Mercado Pago» vigente para este cargo. */
  hasCheckout: boolean;
};

/**
 * Campos que C-MPS5 suma al ledger (todos opcionales: ver la cabecera de esta sección). El desglose del próximo cargo
 * va en `nextCharge.breakdown`.
 */
export type BillingLedgerMps = {
  collectionMethod?: SaasCollectionMethod | null;
  pendingAdjustments?: BillingAdjustmentRow[];
  appliedAdjustments?: BillingAdjustmentRow[];
  /** Por id de cargo. */
  chargeBreakdown?: Record<string, BillingChargeBreakdown>;
  autoDebit?: BillingAutoDebitState | null;
  cancel?: BillingCancelState | null;
  pendingPlan?: BillingPendingPlan | null;
  /** Fecha civil desde la que se factura (MPS-D13, alta a mitad de mes). */
  billableFrom?: string | null;
};

// ── DTOs de las actions del consultorio (C-MPS10, `lib/saas-billing-mp.ts`) ──

/** Motivos de error comunes de las actions de MP (la UI elige el copy; `error` ya viene en voseo). */
export type SaasMpActionReason =
  | "mode_off"
  | "mp_unavailable"
  | "not_allowed"
  | "invalid_input"
  | "stale"
  | "not_found"
  | "charge_not_open"
  | "below_minimum"
  | "cancel_pending"
  | "not_cancelled"
  | "has_debt"
  | "no_pending_plan"
  | "rate_limited";

export type SaasMpActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string; reason?: SaasMpActionReason };

/** `setCollectionMethod` (step-up). */
export type SetCollectionMethodInput = { method: SaasCollectionMethod };
export type SetCollectionMethodData = { collectionMethod: SaasCollectionMethod };

/** `startAutoDebit` (step-up). El email lo tipea el usuario (MPS-D21). */
export type StartAutoDebitInput = { payerEmail: string };
export type StartAutoDebitData = { initPoint: string; reused: boolean };

/** `refreshAutoDebit`: re-lee el preapproval pendiente/vigente en MP. */
export type RefreshAutoDebitData = { status: BillingAutoDebitStatus };

/** `payChargeWithMp`: sin `chargeId` = el último impago. */
export type PayChargeWithMpInput = { chargeId?: string };
export type PayChargeWithMpData = { chargeId: string; initPoint: string; reused: boolean };

/** `confirmCheckoutReturn`: la vuelta del checkout (`payment_id` y `status` de la query de MP; se re-pide el pago). */
export type ConfirmCheckoutReturnInput = { chargeId?: string; paymentId?: string };
export type ConfirmCheckoutReturnData = { outcome: "approved" | "pending" | "rejected" | "unknown"; chargePaid: boolean };

/** `scheduleCancel` (step-up). */
export type ScheduleCancelData = { effectiveOn: string };
/** `undoCancel`. */
export type UndoCancelData = { undone: boolean };
/** `reactivateSubscription` (step-up). */
export type ReactivateSubscriptionData = { status: SubscriptionStatus };
/** `cancelScheduledPlanChange`. */
export type CancelScheduledPlanChangeData = { cancelled: boolean };

// ── DTOs de Plataforma (C-MPS11, `lib/platform-billing.ts`) ──

export type SetAutoDebitAllowedInput = { tenantId: string; allowed: boolean };

/** `addAdjustment`: monto POSITIVO; el signo lo pone el tipo (CREDIT → negativo). */
export type AddAdjustmentInput = {
  tenantId: string;
  kind: "CREDIT" | "DEBIT";
  amountCents: number;
  /** Clave AR; sin fecha = el próximo período. */
  effectiveOn?: string;
  description: string;
  /** UUID por instancia del diálogo (reintento = mismo ajuste, UNIQUE de M16). */
  idempotencyKey: string;
};
export type AddAdjustmentData = { adjustmentId: string; created: boolean };

/** `getMpSubscriptionStatus`: foto del preapproval en MP vs. lo guardado. */
export type PlatformMpSubscriptionStatus = {
  tenantId: string;
  collectionMethod: SaasCollectionMethod | null;
  autoDebitAllowed: boolean;
  autoDebitEnabled: boolean;
  preapprovalId: string | null;
  /** Estado guardado (`mpPreapprovalStatus`) y el que devolvió MP ahora (null = no se pudo leer). */
  storedStatus: string | null;
  liveStatus: string | null;
  payerEmailMasked: string | null;
  amountCents: number | null;
  liveAmountCents: number | null;
  nextDebitAt: string | null;
  syncedAt: string | null;
  pendingPreapprovalId: string | null;
  pendingCreatedAt: string | null;
  retiredPreapprovalId: string | null;
  /** Monto o estado de MP distintos de lo deseado (`desiredDebit`): el reconcile lo corrige. */
  drift: boolean;
};

/** `previewReanchor`: el stub PRORATION que deja el consultorio anclado en el 4 (MPS-D7). */
export type ReanchorPreview = {
  tenantId: string;
  fromAnchorDay: number;
  toAnchorDay: number;
  /** Período corto que se cobra proporcional («YYYY-MM-DD», fin exclusivo). */
  stubFrom: string;
  stubTo: string;
  stubCents: number;
  days: number;
  periodDays: number;
  /** Ya está en el 4: `applyReanchor` no hace nada. */
  noop: boolean;
};
export type ApplyReanchorInput = { tenantId: string; expectedUpdatedAt: string };
export type ApplyReanchorData = { adjustmentId: string | null; anchorDay: number };

export type UndoCancelForInput = { tenantId: string };
export type CancelScheduledPlanForInput = { tenantId: string };
/** `setCustomPrice` con `customPricePlan` (MPS-D14): el precio a medida queda atado a ese plan. */
export type SetCustomPriceInput = { tenantId: string; priceCents: number | null; plan: SaasPlan };
