import "server-only";
/**
 * Programación de la suscripción: bajadas de plan, bajas a fin de período, proporcional de la subida y reactivación
 * (C-MPS9). MPS-K: STUBS con la firma de contrato; los implementa MPS-2c. Corren en una tx del canal service que abre
 * el caller (action, Plataforma o la etapa 2b del cron); nunca llaman a MP (el sync va después del commit,
 * `syncSaasMpAfterCommit`).
 *
 * Orden de locks: Tenant → Subscription → Charge → Payment → Adjustment (`lockTenant`/`lockSubscription` del núcleo).
 */
import type { Prisma, SaasPlan, SubscriptionStatus } from "@prisma/client";
import type { EntitlementActor } from "@/lib/tenant-entitlements-internal";

type Tx = Prisma.TransactionClient;

export type ScheduleFailure =
  | "not_found"
  | "not_downgrade"
  | "invalid_selection"
  | "does_not_fit"
  | "cancel_pending"
  | "already_cancel_pending"
  | "not_cancel_pending"
  | "not_cancelled"
  | "has_debt"
  | "no_pending_plan"
  | "stale";

export type ScheduleResult<T> = ({ ok: true } & T) | { ok: false; reason: ScheduleFailure; detail?: string };

/** Programa la bajada al próximo 4 (`pendingPlan*`); valida que la selección de `disableMembershipIds` haga entrar al plan. */
export async function scheduleDowngradeInTx(
  tx: Tx,
  p: { tenantId: string; to: SaasPlan; disableMembershipIds: string[]; requestedById: string | null; now: Date }
): Promise<ScheduleResult<{ effectiveOn: string }>> {
  void tx;
  void p;
  throw new Error("not implemented: scheduleDowngradeInTx");
}

/** Aplica la bajada que vence hoy; si la selección ya no entra se anula, se manda mail y se cobra el plan actual (MPS-D12). */
export async function applyDuePlanChangeInTx(
  tx: Tx,
  p: { tenantId: string; actor: EntitlementActor; now: Date }
): Promise<{ outcome: "none" | "applied" | "annulled"; plan: SaasPlan | null }> {
  void tx;
  void p;
  throw new Error("not implemented: applyDuePlanChangeInTx");
}

/** Proporcional de una subida (ajuste PRORATION al próximo cargo), solo si hay cargo del período (MPS-D11). */
export async function addUpgradeProrationInTx(
  tx: Tx,
  p: { tenantId: string; from: SaasPlan; to: SaasPlan; createdById: string | null; idempotencyKey: string; now: Date }
): Promise<{ adjustmentId: string | null; prorationCents: number; days: number; periodDays: number }> {
  void tx;
  void p;
  throw new Error("not implemented: addUpgradeProrationInTx");
}

/** Baja a fin de período (`cancelAtPeriodEnd` + `cancelEffectiveOn`; en prueba, al día siguiente del fin, MPS-D18). */
export async function scheduleCancelInTx(
  tx: Tx,
  p: { tenantId: string; requestedById: string | null; now: Date }
): Promise<ScheduleResult<{ effectiveOn: string }>> {
  void tx;
  void p;
  throw new Error("not implemented: scheduleCancelInTx");
}

/** Deshace la baja programada (antes de `cancelEffectiveOn`). */
export async function undoCancelInTx(
  tx: Tx,
  p: { tenantId: string; actorUserId: string | null; now: Date }
): Promise<ScheduleResult<Record<never, never>>> {
  void tx;
  void p;
  throw new Error("not implemented: undoCancelInTx");
}

/** Aplica la baja que vence hoy: CANCELLED (solo lectura) por el escritor único de entitlements. */
export async function applyDueCancelInTx(
  tx: Tx,
  p: { tenantId: string; actor: EntitlementActor; now: Date }
): Promise<{ cancelled: boolean }> {
  void tx;
  void p;
  throw new Error("not implemented: applyDueCancelInTx");
}

/** Reactiva una suscripción CANCELLED (auto solo si la baja fue propia y no hay deuda, MPS-D19). */
export async function reactivateInTx(
  tx: Tx,
  p: { tenantId: string; actor: EntitlementActor; now: Date }
): Promise<ScheduleResult<{ status: SubscriptionStatus }>> {
  void tx;
  void p;
  throw new Error("not implemented: reactivateInTx");
}
