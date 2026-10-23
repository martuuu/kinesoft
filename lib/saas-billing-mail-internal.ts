import "server-only";
/**
 * Mails de Mercado Pago de la suscripción (C-MPS12). MPS-K: STUB con la firma de contrato; lo implementa MPS-3c (que
 * suma los `EmailKind` a `lib/email/types.ts` y las plantillas a `lib/email/templates-billing.ts`). Se manda SIEMPRE
 * después del commit (nunca dentro de una tx) y nunca tira: devuelve los contadores como `sendBillingMail`.
 * Sin PHI: solo montos, fechas y nombres de plan.
 */
import type { SaasPlan } from "@prisma/client";

/** Los EmailKind nuevos de C-MPS12 (literales del brief). */
export type SaasBillingMpMailKind =
  | "billing_debit_activated"
  | "billing_debit_failed"
  | "billing_cancel_scheduled"
  | "billing_cancelled"
  | "billing_plan_change";

export const SAAS_BILLING_MP_MAIL_KINDS = [
  "billing_debit_activated",
  "billing_debit_failed",
  "billing_cancel_scheduled",
  "billing_cancelled",
  "billing_plan_change",
] as const satisfies readonly SaasBillingMpMailKind[];

/** Datos del mail (cada plantilla usa los suyos; todo opcional salvo la entidad para el log/idempotencia). */
export type SaasBillingMpMailData = {
  /** Para `EmailLog` (entity/entityId) y la clave de idempotencia. */
  entity: string;
  entityId: string;
  amountCents?: number | null;
  /** Clave AR «YYYY-MM-DD» (próximo débito, fecha de la baja o del cambio de plan). */
  effectiveOn?: string | null;
  planFrom?: SaasPlan | null;
  planTo?: SaasPlan | null;
  /** `billing_plan_change`: bajada aplicada o anulada porque la selección ya no entraba (MPS-D12). */
  planChangeOutcome?: "applied" | "annulled" | "scheduled" | "upgraded";
  /** `billing_debit_failed`: motivo corto ya traducido (nunca el payload de MP). */
  reason?: string | null;
};

/** Manda uno de los mails de C-MPS12 a los destinatarios de facturación del consultorio. Nunca tira. */
export async function sendSaasBillingMpMail(
  kind: SaasBillingMpMailKind,
  tenantId: string,
  data: SaasBillingMpMailData
): Promise<{ sent: number; notSent: number }> {
  void kind;
  void tenantId;
  void data;
  throw new Error("not implemented: sendSaasBillingMpMail");
}
