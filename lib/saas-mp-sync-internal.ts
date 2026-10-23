import "server-only";
/**
 * Sync de la suscripción con Mercado Pago (C-MPS8). MPS-K: STUBS con la firma de contrato; los implementa MPS-2b2.
 * NO importa el escritor (`lib/saas-billing-internal.ts`): habla con MP por `lib/mercadopago-saas.ts` SIEMPRE fuera de
 * una tx y después guarda las columnas `mp*` de `SaasSubscription`/`SaasCharge` en una tx corta del canal service
 * (locks: Tenant → Subscription → Charge).
 */
import type { BillingAutoDebitStatus } from "@/lib/saas-billing-types";

export type SaasMpSyncFailure = "mode_off" | "mp_unavailable" | "not_allowed" | "not_found" | "charge_not_open" | "below_minimum";

export type StartPreapprovalResult =
  | { ok: true; initPoint: string; preapprovalId: string; reused: boolean }
  | { ok: false; reason: SaasMpSyncFailure };

export type ChargeCheckoutResult =
  | { ok: true; initPoint: string; preferenceId: string; reused: boolean }
  | { ok: false; reason: SaasMpSyncFailure };

export type SaasMpReconcileScope = { tenantIds?: string[]; limit?: number };

export type SaasMpReconcileResult = {
  scanned: number;
  updated: number;
  failed: number;
  /** Cortó por `budgetMs` antes de recorrer todo. */
  timedOut: boolean;
};

/** Crea (o reusa) el preapproval PENDIENTE sin tarjeta y devuelve su `init_point`; el vigente sigue cobrando hasta que MP autorice el nuevo. */
export async function startPreapprovalFlow(p: {
  tenantId: string;
  payerEmail: string;
  actorUserId: string | null;
  now: Date;
}): Promise<StartPreapprovalResult> {
  void p;
  throw new Error("not implemented: startPreapprovalFlow");
}

/** Re-lee el preapproval pendiente en MP (botón «Ya autoricé» / vuelta del checkout) y devuelve el estado resultante. */
export async function refreshPendingPreapproval(p: { tenantId: string; now: Date }): Promise<{ status: BillingAutoDebitStatus }> {
  void p;
  throw new Error("not implemented: refreshPendingPreapproval");
}

/** «Pagar con Mercado Pago» un cargo OPEN: reusa el checkout de las últimas 24 h si el monto es el mismo; si no, lo crea (`saas:t:c`, `?scope=saas`). */
export async function createOrReuseChargeCheckout(p: { tenantId: string; chargeId: string; now: Date }): Promise<ChargeCheckoutResult> {
  void p;
  throw new Error("not implemented: createOrReuseChargeCheckout");
}

/** Después del commit de un cambio de plan/baja/método: lleva el preapproval al `desiredDebit`. Nunca tira (loguea). */
export async function syncSaasMpAfterCommit(tenantId: string): Promise<void> {
  void tenantId;
  throw new Error("not implemented: syncSaasMpAfterCommit");
}

/** Etapa 4b del cron (modo `mp`): ≤ 50 suscripciones, un GET cada una y un PUT solo si difiere, dentro de `budgetMs` (≤ 10 s). */
export async function runSaasMpReconcile(now: Date, budgetMs: number, scope?: SaasMpReconcileScope): Promise<SaasMpReconcileResult> {
  void now;
  void budgetMs;
  void scope;
  throw new Error("not implemented: runSaasMpReconcile");
}
