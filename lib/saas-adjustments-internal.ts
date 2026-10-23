import "server-only";
/**
 * Ajustes de la suscripción (M16 `SaasAdjustment`, C-MPS5). MPS-K: STUBS con la firma de contrato; los implementa
 * MPS-2a. Único escritor de la tabla (TENANT_READONLY, canal service; el trigger `saas_adjustment_guard` la deja SOLO
 * INSERCIÓN salvo la imputación `appliedChargeId` NULL → valor).
 *
 * Orden de locks (fijo, el de `lib/saas-billing-internal.ts`): Tenant → Subscription → Charge → Payment → Adjustment.
 * Cada `*InTx` asume que el caller ya tiene Tenant y Subscription (`lockTenant`/`lockSubscription`, exportados del
 * núcleo) y toma los ajustes al final.
 */
import type { Prisma, SaasPlan } from "@prisma/client";
import type { SaasAdjustmentKind } from "@/lib/saas-billing-types";

type Tx = Prisma.TransactionClient;

export type AddAdjustmentParams = {
  tenantId: string;
  kind: SaasAdjustmentKind;
  /** Con signo: CREDIT < 0, el resto > 0 (CHECK de la base). */
  amountCents: number;
  /** Clave AR «YYYY-MM-DD»: se imputa al primer cargo con periodStart ≥ esta fecha. */
  effectiveOn: string;
  /** La ve el consultorio. */
  description: string;
  /** UNIQUE (tenantId, idempotencyKey): un reintento devuelve el mismo ajuste (`created: false`). */
  idempotencyKey: string;
  planFrom?: SaasPlan | null;
  planTo?: SaasPlan | null;
  days?: number | null;
  periodDays?: number | null;
  /** CREDIT partido por `composeCharge` (el resto que cruza el 0). */
  splitFromId?: string | null;
  /** null = sistema (cron, webhook). */
  createdById?: string | null;
};

export type AddAdjustmentResult = { adjustmentId: string; created: boolean };

export type PendingAdjustment = {
  id: string;
  kind: SaasAdjustmentKind;
  amountCents: number;
  effectiveOn: string;
  description: string;
};

/** Inserta un ajuste (idempotente por `idempotencyKey`). Locks: el caller tiene Tenant → Subscription. */
export async function addAdjustmentInTx(tx: Tx, p: AddAdjustmentParams): Promise<AddAdjustmentResult> {
  void tx;
  void p;
  throw new Error("not implemented: addAdjustmentInTx");
}

/** Ajustes pendientes (`appliedChargeId IS NULL`) con effectiveOn ≤ `upTo`, FOR UPDATE, del más viejo. Último lock del orden. */
export async function listPendingAdjustmentsForUpdateInTx(
  tx: Tx,
  p: { tenantId: string; upTo: string }
): Promise<PendingAdjustment[]> {
  void tx;
  void p;
  throw new Error("not implemented: listPendingAdjustmentsForUpdateInTx");
}

/** Marca la imputación (NULL → `chargeId`, `appliedAt = now`), lo único que el trigger deja actualizar. Devuelve cuántos marcó. */
export async function markAdjustmentsAppliedInTx(
  tx: Tx,
  p: { tenantId: string; adjustmentIds: string[]; chargeId: string; now: Date }
): Promise<number> {
  void tx;
  void p;
  throw new Error("not implemented: markAdjustmentsAppliedInTx");
}
