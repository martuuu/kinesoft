import "server-only";
/**
 * Mails de Mercado Pago de la suscripción (C-MPS12). MPS-K dejó la firma; la implementa MPS-3c (los `EmailKind` en
 * `lib/email/types.ts` y las plantillas en `lib/email/templates-billing.ts`). Se manda SIEMPRE después del commit
 * (nunca dentro de una tx: el envío es red y una tx abierta esperando a Resend bloquea el lock del consultorio) y
 * nunca tira: devuelve los contadores como `sendBillingMail`. Sin PHI: solo montos, fechas y nombres de plan.
 *
 * Idempotencia: misma reserva que los mails del cron (`claimMail` del núcleo, que no se exporta): una fila de
 * `PlatformAuditEvent` con `idempotencyKey` UNIQUE ANTES de mandar. Es «a lo sumo una vez»: si Resend falla después
 * de reservar, ese mail no se reintenta (igual que el cargo nuevo o el vencido); preferimos eso a un webhook de MP que
 * llega tres veces y manda tres «no pudimos debitar». Sin destinatarios no se reserva (molde de `mailStage`): si
 * aparece un titular activo, el próximo disparo sí avisa.
 */
import type { SaasPlan } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { auditPlatformGlobalInTx, type PlatformActorRef } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { toARDateKey } from "@/lib/datetime-ar";
import { PLAN_DEFAULTS } from "@/lib/saas-plans-logic";
import { billingRecipients, billingUrl, sendBillingMail } from "@/lib/saas-billing-internal";
import type { RenderedEmail } from "@/lib/email/types";
import {
  billingCancelScheduledEmail,
  billingCancelledEmail,
  billingDebitActivatedEmail,
  billingDebitCancelledEmail,
  billingDebitFailedEmail,
  billingPlanChangeEmail,
} from "@/lib/email/templates-billing";

/** Los EmailKind nuevos de C-MPS12 (literales del brief), más el de HD-11 (débito cancelado desde Mercado Pago). */
export type SaasBillingMpMailKind =
  | "billing_debit_activated"
  | "billing_debit_failed"
  | "billing_cancel_scheduled"
  | "billing_cancelled"
  | "billing_plan_change"
  | "billing_debit_cancelled";

export const SAAS_BILLING_MP_MAIL_KINDS = [
  "billing_debit_activated",
  "billing_debit_failed",
  "billing_cancel_scheduled",
  "billing_cancelled",
  "billing_plan_change",
  "billing_debit_cancelled",
] as const satisfies readonly SaasBillingMpMailKind[];

/** Datos del mail (cada plantilla usa los suyos; todo opcional salvo la entidad para el log/idempotencia). */
export type SaasBillingMpMailData = {
  /** Para `EmailLog` (entity/entityId) y la clave de idempotencia. */
  entity: string;
  entityId: string;
  amountCents?: number | null;
  /**
   * Clave AR «YYYY-MM-DD». Según el kind: `billing_debit_failed` = vencimiento del cargo (el 9);
   * `billing_cancel_scheduled` = hasta cuándo hay acceso completo; `billing_plan_change` = fecha del cambio.
   * También es la «fecha» de las claves `cron.billing_*` (sin ella, el día AR de hoy).
   */
  effectiveOn?: string | null;
  planFrom?: SaasPlan | null;
  planTo?: SaasPlan | null;
  /**
   * `billing_plan_change`: bajada programada, aplicada o anulada porque la selección ya no entraba (MPS-D12), o subida.
   * `not_applied` (brief de MPS-3c) y `annulled` (stub de MPS-K) son el mismo mail.
   */
  planChangeOutcome?: "applied" | "annulled" | "not_applied" | "scheduled" | "upgraded";
  /** `billing_debit_failed`: motivo corto ya traducido (nunca el payload de MP). Hoy NO va al mail (ver plantilla). */
  reason?: string | null;
  /** `billing_debit_failed`: id del pago de MP del intento (la clave es por autorización + pago). */
  paymentId?: string | null;
  /** Override de la clave (p. ej. una baja que se deshace y se vuelve a pedir para la misma fecha). */
  idempotencyKey?: string | null;
};

const NONE = { sent: 0, notSent: 0 } as const;

/** Lo manda el sistema (webhook, cron, la action después del commit): sin persona en el registro de Plataforma. */
const SYSTEM_ACTOR: PlatformActorRef = { userId: null, email: null, homeTenantId: null };

/**
 * Clave de idempotencia (C-MPS12):
 *  - `billing_debit_failed:<authId>:<paymentId>`: un aviso por intento de cobro, no por webhook. El débito rechazado
 *    (`lib/saas-billing-mp-internal.ts`) lo pisa con `idempotencyKey = billing_debit_failed:<preapproval>:<período>`
 *    (ZF1): uno por período, porque MP recicla el rechazado varios días y cada intento es otro pago;
 *  - `billing_debit_activated:<preapprovalId>`: un aviso por autorización;
 *  - `billing_debit_cancelled:<preapprovalId>` (HD-11): un aviso por autorización cancelada desde MP. Sin fecha en la
 *    clave a propósito: MP repite el aviso (y la conciliación puede volver a verlo otro día) y un preapproval
 *    cancelado es terminal, así que no hay un «segundo» cancelado legítimo del mismo id;
 *  - `cron.billing_<kind>:<tenant>:<fecha>`: baja programada, baja aplicada y cambio de plan (con el resultado en el
 *    kind, para que «programado» y «aplicado» del mismo día no se pisen).
 */
export function saasMpMailKey(kind: SaasBillingMpMailKind, tenantId: string, data: SaasBillingMpMailData, now: Date = new Date()): string {
  if (data.idempotencyKey) return data.idempotencyKey;
  const day = data.effectiveOn ?? toARDateKey(now);
  switch (kind) {
    case "billing_debit_failed":
      return `billing_debit_failed:${data.entityId}:${data.paymentId ?? "-"}`;
    case "billing_debit_activated":
      return `billing_debit_activated:${data.entityId}`;
    case "billing_debit_cancelled":
      return `billing_debit_cancelled:${data.entityId}`;
    case "billing_plan_change":
      return `cron.billing_plan_change_${normalizeOutcome(data.planChangeOutcome) ?? "unknown"}:${tenantId}:${day}`;
    default:
      return `cron.${kind}:${tenantId}:${day}`;
  }
}

function normalizeOutcome(o: SaasBillingMpMailData["planChangeOutcome"]) {
  return o === "annulled" ? "not_applied" : o;
}

function planLabel(plan: SaasPlan | null | undefined): string | null {
  return plan ? (PLAN_DEFAULTS[plan]?.label ?? plan) : null;
}

/** Arma el mail o null si faltan datos obligatorios (mejor no mandar que mandar «No pudimos debitar $ 0»). */
function buildMail(kind: SaasBillingMpMailKind, tenantName: string, data: SaasBillingMpMailData): RenderedEmail | null {
  const url = billingUrl();
  switch (kind) {
    case "billing_debit_activated":
      return billingDebitActivatedEmail({ tenantName, url });
    case "billing_debit_cancelled":
      // Sin monto ni fecha (HD-11): no hubo intento de cobro ni vencimiento nuevo; solo cambia cómo se paga.
      return billingDebitCancelledEmail({ tenantName, url });
    case "billing_debit_failed":
      if (data.amountCents == null || data.amountCents <= 0 || !data.effectiveOn) return null;
      return billingDebitFailedEmail({ tenantName, amountCents: data.amountCents, dueDate: data.effectiveOn, url });
    case "billing_cancel_scheduled":
      if (!data.effectiveOn) return null;
      return billingCancelScheduledEmail({ tenantName, accessUntil: data.effectiveOn, url });
    case "billing_cancelled":
      return billingCancelledEmail({ tenantName, url });
    case "billing_plan_change": {
      const outcome = data.planChangeOutcome;
      const to = planLabel(data.planTo);
      if (!outcome || !to) return null;
      return billingPlanChangeEmail({
        tenantName,
        outcome,
        planToLabel: to,
        effectiveOn: data.effectiveOn ?? null,
        prorationCents: outcome === "upgraded" ? (data.amountCents ?? null) : null,
        url,
      });
    }
  }
}

/** Manda uno de los mails de C-MPS12 a los destinatarios de facturación del consultorio. Nunca tira. */
export async function sendSaasBillingMpMail(
  kind: SaasBillingMpMailKind,
  tenantId: string,
  data: SaasBillingMpMailData
): Promise<{ sent: number; notSent: number }> {
  try {
    const recipients = await billingRecipients(tenantId);
    if (recipients.length === 0) return { ...NONE };
    const t = await prismaService.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
    if (!t) return { ...NONE };
    const mail = buildMail(kind, t.name, data);
    if (!mail) {
      logger.warn("billing.mp_mail_incomplete", { kind, tenantId });
      return { ...NONE };
    }
    const key = saasMpMailKey(kind, tenantId, data);
    const claim = await prismaService.$transaction((tx) =>
      auditPlatformGlobalInTx(tx, {
        actor: SYSTEM_ACTOR,
        action: `platform.mail.${kind}`,
        entity: data.entity,
        entityId: data.entityId,
        tenantId,
        payload: { kind, recipients: recipients.length, effectiveOn: data.effectiveOn ?? null, outcome: data.planChangeOutcome ?? null },
        idempotencyKey: key,
      })
    );
    if (!claim.inserted) return { ...NONE };
    return await sendBillingMail(tenantId, kind, mail, { entity: data.entity, entityId: data.entityId });
  } catch (err) {
    logger.warn("billing.mail_failed", { kind, tenantId, error: err instanceof Error ? err.name : "unknown" });
    return { ...NONE };
  }
}
