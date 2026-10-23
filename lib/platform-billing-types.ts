/**
 * Tipos de /plataforma → Facturación y Precios (PL-2b, C-PL10 sin Mercado Pago). Client-safe: `lib/platform-billing.ts`
 * es "use server" y no puede exportar tipos.
 */
import type { SaasPlan, SubscriptionStatus, TenantStatus } from "@prisma/client";
import type { BillingLedger, ReanchorPreview } from "@/lib/saas-billing-types";

export type PlatformAccountsFilter = {
  /** all = todas; debt = con saldo deudor; to_review = con comprobantes a revisar; past_due = vencidas. */
  view?: "all" | "debt" | "to_review" | "past_due";
  /** Nombre o slug (contiene, sin distinguir mayúsculas). */
  q?: string;
  /** PL-3: plan SaaS del consultorio (filtro server-side; la página trae solo esas cuentas). */
  plan?: SaasPlan;
  /** PL-3: estado de la suscripción. La vista `past_due` lo pisa (vencidas = PAST_DUE). */
  subscriptionStatus?: SubscriptionStatus;
  /** Paginación por id (orden por nombre e id). */
  cursor?: string | null;
};

export type PlatformAccountRow = {
  tenantId: string;
  name: string;
  slug: string;
  status: TenantStatus;
  saasPlan: SaasPlan;
  subscriptionStatus: SubscriptionStatus;
  customPriceCents: number | null;
  /** Precio que se cobra por mes (a medida > lista); null = no se cobra. */
  effectivePriceCents: number | null;
  balanceCents: number;
  openCharges: number;
  overdueCharges: number;
  pendingReviews: number;
  nextChargeOn: string | null;
  lastPaymentAt: string | null;
};

export type PlatformAccountsPage = { rows: PlatformAccountRow[]; nextCursor: string | null };

export type PlatformTenantLedger = BillingLedger & {
  tenantName: string;
  tenantSlug: string;
  tenantStatus: TenantStatus;
  /** `Tenant.updatedAt` (para el CAS del cambio de plan desde Plataforma). */
  tenantUpdatedAt: string;
};

export type PlatformPriceHistoryRow = {
  id: string;
  plan: SaasPlan;
  priceCents: number | null;
  previousPriceCents: number | null;
  effectiveFrom: string;
  appliedAt: string | null;
  note: string | null;
  createdAt: string;
  createdByEmail: string | null;
};

export type PlatformPlanPriceRow = {
  plan: SaasPlan;
  label: string;
  priceCents: number | null;
  /** Próximo cambio pendiente (sin aplicar), si hay. */
  pending: { priceCents: number | null; effectiveFrom: string } | null;
};

// ── MPS-3b (C-MPS11): suscripción con Mercado Pago desde Plataforma ──
// Los inputs y `PlatformMpSubscriptionStatus` / `AddAdjustmentData` los publicó MPS-K en `lib/saas-billing-types.ts`;
// acá van los que el código real necesitó distintos (ver cada uno). Sin PHI ni datos de tarjeta: ids, montos, fechas.

export type PlatformSubscriptionReason =
  | "invalid_input"
  | "not_found"
  | "no_subscription"
  | "not_cancel_pending"
  | "stale"
  | "no_pending_plan"
  | "mp_unavailable";

export type PlatformSubscriptionActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; reason: PlatformSubscriptionReason };

/** `setAutoDebitAllowed`: `changed: false` = ya estaba así (no audita ni llama a MP). */
export type SetAutoDebitAllowedData = { autoDebitAllowed: boolean; changed: boolean };

/**
 * `previewReanchor`: `ReanchorPreview` de MPS-K + lo que el núcleo real (`lib/saas-reanchor-internal.ts`) sabe y la
 * pantalla tiene que mostrar. `stubFrom`/`stubTo` = `billableFrom` → el primer 4 (stub del primer cargo; `stubCents`
 * 0 si arranca justo el 4 o el plan no tiene precio).
 */
export type PlatformReanchorPreview = ReanchorPreview & {
  oldNextChargeOn: string | null;
  newNextChargeOn: string;
  hasCharges: boolean;
};

/**
 * `applyReanchor`. Distinto de `ApplyReanchorData` de MPS-K (`adjustmentId`): el núcleo NO crea un ajuste (el stub lo
 * arma el primer cargo) y es idempotente sin CAS, así que tampoco pide `expectedUpdatedAt`.
 */
export type PlatformReanchorResult = { preview: PlatformReanchorPreview; updated: boolean };
