import "server-only";
/**
 * Consumidores de Mercado Pago de la suscripción (C-MPS7). MPS-K: STUBS con la firma de contrato; los implementa
 * MPS-2b1. Todos vuelven a pedir el recurso a MP con el token de la PLATAFORMA (`lib/mercadopago-saas.ts`) antes de
 * confiar en el webhook, y nunca llaman a MP dentro de una tx: GET afuera → tx del canal service adentro.
 *
 * Orden de locks: Tenant → Subscription → Charge → Payment → Adjustment (`lockTenant`/`lockSubscription` del núcleo).
 */
import type { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

/** Quién disparó el consumo (cambia solo logs/audit). */
export type SaasMpConsumeSource = "webhook" | "legacy" | "reconcile" | "return";

export type SaasMpConsumeOpts = { now?: Date; source?: SaasMpConsumeSource };

/**
 * `applied|replay|mismatch|ignored` igual que la rama `?acct=` (el simulador lee `result`). `retry` = MP caído o base
 * ocupada: la ruta contesta 503 y MP reintenta.
 */
export type SaasMpConsumeResult =
  | { ok: true; result: "applied" | "replay" | "mismatch" | "ignored"; tenantId: string | null }
  | { ok: false; reason: "retry" | "db_error"; tenantId: string | null };

/** Pago de MP (checkout `saas:t:c` o débito): re-fetch, valida collector/ARS/tenant, imputa o deja a cuenta, reintegra; P2002 → 1 reintento. */
export async function consumeSaasMpPayment(mpPaymentId: string, opts?: SaasMpConsumeOpts): Promise<SaasMpConsumeResult> {
  void mpPaymentId;
  void opts;
  throw new Error("not implemented: consumeSaasMpPayment");
}

/** Cobro de un preapproval (authorized_payment): busca por preapproval actual/pendiente/retirado y apunta a `periodStartForDebit`. */
export async function consumeSaasAuthorizedPayment(
  authorizedPaymentId: string,
  opts?: SaasMpConsumeOpts
): Promise<SaasMpConsumeResult> {
  void authorizedPaymentId;
  void opts;
  throw new Error("not implemented: consumeSaasAuthorizedPayment");
}

/** Preapproval: `authorized` del pendiente → lo promueve (el viejo a retirado, AUTO_DEBIT); `cancelled` desde MP → apaga el débito + mail. */
export async function consumeSaasPreapproval(preapprovalId: string, opts?: SaasMpConsumeOpts): Promise<SaasMpConsumeResult> {
  void preapprovalId;
  void opts;
  throw new Error("not implemented: consumeSaasPreapproval");
}

/**
 * Imputa un pago recién APROBADO al cargo `targetChargeId` (o a cuenta si es null o no está OPEN) y aplica el saldo
 * a cuenta; el resto partido lleva `splitFromId = raíz`. Locks: el caller tiene Tenant → Subscription.
 * Hallazgo MPS-K: el núcleo ya tiene una versión PRIVADA posicional en `lib/saas-billing-internal.ts`
 * (`imputeApprovedPaymentInTx(tx, tenantId, paymentId, target, now)`): MPS-2a la exporta y esta la delega.
 */
export async function imputeApprovedPaymentInTx(
  tx: Tx,
  p: { tenantId: string; paymentId: string; targetChargeId: string | null; now: Date }
): Promise<{ chargeId: string | null; chargePaid: boolean }> {
  void tx;
  void p;
  throw new Error("not implemented: imputeApprovedPaymentInTx");
}

/** Reintegro: pasa a REFUNDED la raíz `rootId` y sus hermanos (`splitFromId = rootId`), reabre los cargos y recalcula el estado. Locks: el caller tiene Tenant → Subscription. */
export async function refundPaymentTreeInTx(
  tx: Tx,
  p: { tenantId: string; rootId: string; now: Date }
): Promise<{ refundedIds: string[]; reopenedChargeIds: string[] }> {
  void tx;
  void p;
  throw new Error("not implemented: refundPaymentTreeInTx");
}
