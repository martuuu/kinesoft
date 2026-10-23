"use server";

/**
 * Configuración → Facturación (PL-2b, contrato C-PL9 recortado: SIN Mercado Pago, decisión de Martin del 16-oct).
 * Plan, precio, prueba, saldo, próximo cargo, cargos y pagos; subir el comprobante de una transferencia; ver el
 * comprobante; cambiar de plan (elegir quiénes pierden el acceso si sobran).
 *
 * Barrera: `requireAccountBilling` en CADA export (el Titular o quien tenga «Planes y pagos»; soporte nunca:
 * `SUPPORT_CAPS` no tiene `account.*`). Cambiar de plan además pide step-up (`requireStepUp`, PL-D11: 2FA
 * obligatoria para plan y medio de pago).
 *
 * Solo lectura: subir el comprobante y cambiar de plan corren en `withAccountWritable` (C-PL10): un consultorio con
 * la prueba vencida o con deuda está en modo lectura justamente cuando tiene que poder pagar y elegir plan. Nunca en
 * soporte (doble red: `requireAccountBilling` y `withAccountWritable`).
 *
 * Canal: los cobros son TENANT_READONLY. Las LECTURAS van con `runWithRls` (la policy de lectura por tenant); las
 * ESCRITURAS de cobro por el canal service desde `lib/saas-billing-internal.ts` (único escritor), siempre con el
 * `tenantId` del Actor. El cambio de plan inmediato va por `runTeamTx` (rol app + RLS, como el resto del equipo).
 *
 * MPS-3a (C-MPS10, MPS-D10/D11/D18): el cambio de plan ahora depende de la plata (`planChangeKind`):
 *  - `upgrade_prorated` (subida con el período ya cobrado): plan + ajuste PRORATION al próximo cargo en UNA tx del canal
 *    service. Por qué service: `SaasAdjustment` es TENANT_READONLY y el rol app no la puede escribir (hallazgo 3 de
 *    §26.6). Por qué una sola tx: si el proporcional fallara después de cambiar el plan, el consultorio quedaría con el
 *    plan nuevo gratis hasta el próximo período. `applyPlanChangeInTx` corre igual que siempre (ctx `tenant`, mismo
 *    audit `tenant.plan.change`, escritor único con source `billing`); solo cambia la conexión.
 *  - `scheduled_downgrade` (bajada con el período ya cobrado): no se toca el equipo hoy; se guarda la bajada y la
 *    selección (`scheduleDowngradeInTx`) y la aplica la etapa 2b del cron el día del próximo cobro (si ya no entra, se
 *    anula y se avisa, MPS-D12).
 *  - `immediate`: como hasta ahora.
 *  - `blocked_cancel_pending`: con la baja programada (o ya dada de baja) no hay cambio de plan (MPS-D18).
 * El tipo se decide DOS veces: afuera (para elegir el camino) y adentro de la tx, después de los locks; si cambió en el
 * medio (se generó el cargo, se programó una baja) → `stale` y el drawer recarga.
 * Mercado Pago y los mails van DESPUÉS del commit (nunca dentro de una tx: retendrían los locks lo que tarde la red).
 */
import { randomUUID } from "node:crypto";
import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";
import { prismaService } from "@/lib/db";
import { runWithRls } from "@/lib/rls";
import { requireAccountBilling } from "@/lib/authz";
import { assertWritable } from "@/lib/session";
import { withAccountWritable } from "@/lib/account-writable";
import { requireStepUp } from "@/lib/two-factor-step-up";
import { rateLimit, rateLimitedMessage } from "@/lib/rate-limit";
import { auditInTx } from "@/lib/audit";
import { saasBillingMode, saasBillingTransferInfo } from "@/lib/env";
import { tags, tenantEntitlementTags } from "@/lib/cache-tags";
import { runTeamTx, type TeamActorCtx } from "@/lib/team-internal";
import type { DbClient } from "@/lib/rls";
import { applyPlanChangeInTx, previewPlanChangeInTx, PlanChangeRaceError } from "@/lib/saas-plan-change-internal";
import type { ApplyPlanChangeResult } from "@/lib/saas-plan-change-types";
import { billingActive, ensureSubscriptionInTx, readLedger, recordPaymentInTx } from "@/lib/saas-billing-internal";
import { addUpgradeProrationInTx, scheduleDowngradeInTx, type ScheduleFailure } from "@/lib/saas-billing-schedule-internal";
import { syncSaasMpAfterCommit } from "@/lib/saas-mp-sync-internal";
import { sendSaasBillingMpMail } from "@/lib/saas-billing-mail-internal";
import { parsePaymentForm, readReceiptFile, removeReceipt, signReceipt, uploadReceipt } from "@/lib/saas-receipts-internal";
import {
  chargeAmountFor,
  dbDateFromKey,
  effectiveCustomPrice,
  keyFromDbDate,
  nextAnchorKey,
  planChangeKind,
  prorate,
  remainingCents,
} from "@/lib/saas-billing-logic";
import { PLAN_DEFAULTS } from "@/lib/saas-plans-logic";
import { toARDateKey } from "@/lib/datetime-ar";
import {
  BILLING_COPY,
  PLAN_CHANGE_COPY,
  type BillingOverview,
  type PlanChangeActionResult,
  type PlanChangeBilling,
  type PlanChangePreviewWithBilling,
  type SubmitPaymentReceiptResult,
} from "@/lib/saas-billing-types";
import type { Prisma, SaasPlan } from "@prisma/client";
import type { Actor } from "@/lib/session";
import type { ActionResult } from "@/lib/validation";

const SAAS_PLAN = z.enum(["INDIVIDUAL", "CONSULTORIO", "CLINICA", "LIBRE"]);
const ID = z.string().min(1).max(64);

const ApplyPlanChangeInput = z
  .object({
    to: SAAS_PLAN,
    disableMembershipIds: z.array(ID).max(200),
    reactivateMembershipIds: z.array(ID).max(200),
    expectedUpdatedAt: z.string().datetime(),
    /** MPS-3a: UUID por instancia del drawer; la clave del proporcional es `upgrade:<uuid>` (un reintento = el mismo ajuste). */
    idempotencyKey: z.string().uuid().optional(),
  })
  .strict();

function teamCtx(actor: Actor): TeamActorCtx {
  return {
    via: "tenant",
    tenantId: actor.tenantId,
    actorUserId: actor.userId,
    // `requireAccountBilling` ya garantizó membresía (soporte no tiene `account.*`).
    actorRole: actor.membership?.role ?? "BILLING",
    actorRef: null,
  };
}

/** Estado contable del consultorio activo. Se puede leer en solo lectura (las lecturas no se cortan nunca). */
export async function getBillingOverview(): Promise<BillingOverview> {
  const { actor } = await requireAccountBilling();
  const now = new Date();
  const ledger = await runWithRls(actor.tenantId, (tx) => readLedger(tx, actor.tenantId, now));
  if (!ledger) throw new Error("[saas-billing] consultorio inexistente");
  const mode = saasBillingMode();
  const transferInfo = saasBillingTransferInfo();
  // PL-Z (A2): sin datos para transferir no se ofrece «Informar pago» (el consultorio no sabría a dónde pagar).
  return { ...ledger, mode, transferInfo, canSubmitReceipt: mode !== "off" && transferInfo !== null };
}

// ── Cambio de plan con la plata (MPS-3a) ─────────────────────────────────────────────────────────────────────────

type PlanChangeSituation = { from: SaasPlan; pendingPlan: SaasPlan | null; billing: PlanChangeBilling };

const NO_PRORATION = { prorationCents: 0, days: 0, periodDays: 0 } as const;

/**
 * Qué tipo de cambio es y qué pasa con la plata (C-MPS10 `billing`). Solo lee: sirve en el preview (rol app + RLS,
 * las tablas de cobro tienen policy de lectura) y adentro de la tx de la escritura (después de los locks).
 * Los números son los MISMOS que escribe `addUpgradeProrationInTx` (MPS-2c): la base del cargo del período si es del
 * plan actual (lo que de verdad pagó) o el precio del plan actual si ya subió una vez en el período; el precio del plan
 * destino con el precio a medida atado al plan (MPS-D14); días AR contando hoy, half-up (`prorate`). Si el drawer
 * mostrara otra cuenta que la que se escribe, el consultorio vería un número y pagaría otro.
 */
async function planChangeSituationInTx(tx: DbClient, tenantId: string, to: SaasPlan, now: Date): Promise<PlanChangeSituation | null> {
  const t = await tx.tenant.findFirst({ where: { id: tenantId }, select: { saasPlan: true, subscriptionStatus: true } });
  if (!t) return null;
  const sub = await tx.saasSubscription.findFirst({
    where: { tenantId },
    select: { nextChargeAt: true, cancelAtPeriodEnd: true, customPriceCents: true, customPricePlan: true, pendingPlan: true },
  });
  const today = toARDateKey(now);
  const charge = await tx.saasCharge.findFirst({
    where: { tenantId, status: { not: "VOID" }, periodStart: { lte: dbDateFromKey(today) }, periodEnd: { gt: dbDateFromKey(today) } },
    orderBy: { periodStart: "desc" },
    select: { plan: true, amountCents: true, baseAmountCents: true, periodStart: true, periodEnd: true },
  });
  const custom = { customPriceCents: sub?.customPriceCents ?? null, customPricePlan: sub?.customPricePlan ?? null };
  const monthly = async (plan: SaasPlan): Promise<number | null> => {
    const cfg = await tx.saasPlanConfig.findUnique({ where: { plan }, select: { priceCents: true } });
    return chargeAmountFor({
      customPriceCents: effectiveCustomPrice({ ...custom, plan }),
      planPriceCents: cfg ? cfg.priceCents : PLAN_DEFAULTS[plan].priceCents,
    });
  };
  const toPrice = await monthly(to);
  const fromPrice = charge && charge.plan === t.saasPlan ? (charge.baseAmountCents ?? charge.amountCents) : await monthly(t.saasPlan);
  const diffCents = toPrice !== null && fromPrice !== null ? toPrice - fromPrice : null;
  const kind = planChangeKind({
    from: t.saasPlan,
    to,
    subscriptionStatus: t.subscriptionStatus,
    cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
    hasPeriodCharge: charge !== null,
    diffCents,
  });
  let billing: PlanChangeBilling = { kind, effectiveOn: today, ...NO_PRORATION };
  if (kind === "upgrade_prorated" && charge && diffCents !== null) {
    const pr = prorate({ diffCents, fromKey: today, periodStart: keyFromDbDate(charge.periodStart), periodEnd: keyFromDbDate(charge.periodEnd) });
    if (pr) billing = { kind, effectiveOn: today, prorationCents: pr.amountCents, days: pr.days, periodDays: pr.periodDays };
  } else if (kind === "scheduled_downgrade") {
    // Misma fecha que `scheduleDowngradeInTx`: el próximo cobro guardado si es futuro; si no, el próximo 4.
    const next = sub?.nextChargeAt ? toARDateKey(sub.nextChargeAt) : null;
    billing = { kind, effectiveOn: next && next > today ? next : nextAnchorKey(today), ...NO_PRORATION };
  }
  return { from: t.saasPlan, pendingPlan: sub?.pendingPlan ?? null, billing };
}

/** Lo que se limpia de la suscripción cuando el plan cambia hoy: una bajada programada ya no aplica. */
const CLEAR_PENDING_PLAN: Prisma.SaasSubscriptionUpdateInput = {
  pendingPlan: null,
  pendingPlanEffectiveOn: null,
  pendingPlanDisableIds: [],
  pendingPlanRequestedById: null,
  pendingPlanRequestedAt: null,
};

/** Resultado de error ya armado que sale de la tx tirando (para que la tx revierta lo que hubiera escrito antes). */
class PlanChangeRollback extends Error {
  constructor(readonly result: PlanChangeActionResult) {
    super("plan_change_rollback");
    this.name = "PlanChangeRollback";
  }
}

const planFail = (reason: NonNullable<Extract<PlanChangeActionResult, { ok: false }>["reason"]>, detail?: string): PlanChangeActionResult => {
  const error =
    reason === "cancel_pending"
      ? detail === "cancelled"
        ? PLAN_CHANGE_COPY.cancelled
        : PLAN_CHANGE_COPY.cancel_pending
      : detail === "custom_limits"
        ? PLAN_CHANGE_COPY.custom_limits
        : PLAN_CHANGE_COPY[reason];
  return detail ? { ok: false, error, reason, detail } : { ok: false, error, reason };
};

function fromApplyFailure(res: Extract<ApplyPlanChangeResult, { ok: false }>): PlanChangeActionResult {
  return planFail(res.reason, res.detail);
}

/** Rechazos de `scheduleDowngradeInTx` → los del drawer (`owner_selected`/`self_selected` vuelven a su razón de siempre). */
function fromScheduleFailure(reason: ScheduleFailure, detail?: string): PlanChangeActionResult {
  switch (reason) {
    case "not_found":
      return planFail("not_found");
    case "does_not_fit":
      return planFail("does_not_fit", detail);
    case "invalid_selection":
      if (detail === "owner_selected" || detail === "self_selected") return planFail(detail);
      return planFail("invalid_selection", detail);
    case "cancel_pending":
    case "already_cancel_pending":
      return planFail("cancel_pending", detail);
    default:
      // `not_downgrade` (el plan cambió en el medio) y cualquier otro: que el drawer recargue.
      return planFail("stale");
  }
}

function revalidatePlan(tenantId: string): void {
  for (const t of tenantEntitlementTags(tenantId)) revalidateTag(t);
  revalidateTag(tags.practitioners(tenantId));
  revalidatePath("/configuracion");
}

/** Lo que pasaría al cambiar a `to` (para el drawer) + qué pasa con la plata (`billing`, C-MPS10). Solo lectura. */
export async function previewPlanChange(to: unknown): Promise<ActionResult<PlanChangePreviewWithBilling>> {
  const { actor } = await requireAccountBilling();
  const parsed = SAAS_PLAN.safeParse(to);
  if (!parsed.success) return { ok: false, error: PLAN_CHANGE_COPY.invalid_input };
  const now = new Date();
  const out = await runTeamTx(teamCtx(actor), async (tx) => {
    const preview = await previewPlanChangeInTx(tx, { tenantId: actor.tenantId, to: parsed.data, now, actorUserId: actor.userId });
    if (!preview) return null;
    const sit = await planChangeSituationInTx(tx, actor.tenantId, parsed.data, now);
    return sit ? { ...preview, billing: sit.billing } : null;
  });
  if (!out) return { ok: false, error: PLAN_CHANGE_COPY.not_found };
  return { ok: true, data: out };
}

/**
 * Cambiar de plan (C-PL4 desde el consultorio + C-MPS10): `requireAccountBilling` → step-up → zod → el camino según
 * `planChangeKind` (ver la cabecera). Libre no (se arma desde Plataforma). El CAS contra `expectedUpdatedAt` vale en
 * los tres caminos (en la bajada lo chequea esta action: `scheduleDowngradeInTx` no cambia el Tenant).
 */
export async function applyPlanChange(raw: unknown): Promise<PlanChangeActionResult> {
  return withAccountWritable("lib/saas-billing.ts#applyPlanChange", async (): Promise<PlanChangeActionResult> => {
    const { actor, caps } = await requireAccountBilling();
    // Tira `StepUpRequiredError` / `TwoFactorSetupRequiredError` (digest): `useStepUpAction` pide el código y reintenta.
    await requireStepUp(actor);
    assertWritable(actor);
    const parsed = ApplyPlanChangeInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: PLAN_CHANGE_COPY.invalid_input, reason: "invalid_input" };
    // PL-Z a3#2: «Planes y pagos» alcanza para cambiar el plan, pero elegir A QUIÉN se le corta (o se le devuelve) el
    // acceso es gestión del equipo: la misma barrera que deshabilitar/reactivar desde Usuarios. Sin esto, alguien con
    // solo «Planes y pagos» podía dejar afuera a cualquier miembro bajando de plan. T3 (C-AS1): esa barrera pasó a
    // `tenant.sensitive` (`requireTeamManager`); hoy nadie llega acá con `tenant.admin` sin `tenant.sensitive` (la
    // Secretaria y Facturación pierden «Planes y pagos» por el corte de staff), pero las dos barreras tienen que ser
    // la misma para que un cambio de la matriz no abra una sin la otra. Vale igual para la bajada programada: la
    // selección se guarda hoy y se aplica el 4 a nombre de quien la eligió.
    if ((parsed.data.disableMembershipIds.length > 0 || parsed.data.reactivateMembershipIds.length > 0) && !caps.has("tenant.sensitive")) {
      return { ok: false, error: PLAN_CHANGE_COPY.needs_settings, reason: "invalid_selection" };
    }
    const tenantId = actor.tenantId;
    const ctx = teamCtx(actor);
    const now = new Date();
    const { to, disableMembershipIds, reactivateMembershipIds } = parsed.data;
    const expectedUpdatedAt = new Date(parsed.data.expectedUpdatedAt);
    const base = { tenantId, to, disableMembershipIds, reactivateMembershipIds, expectedUpdatedAt, ctx, now };

    const sit = await runTeamTx(ctx, (tx) => planChangeSituationInTx(tx, tenantId, to, now));
    if (!sit) return planFail("not_found");
    const kind = sit.billing.kind;
    if (kind === "blocked_cancel_pending") {
      const status = (await runTeamTx(ctx, (tx) => tx.tenant.findFirst({ where: { id: tenantId }, select: { subscriptionStatus: true } })))
        ?.subscriptionStatus;
      return planFail("cancel_pending", status === "CANCELLED" ? "cancelled" : undefined);
    }

    try {
      if (kind === "scheduled_downgrade") {
        // Reactivar a alguien en una bajada no tiene sentido (el plan destino tiene menos lugares).
        if (reactivateMembershipIds.length > 0) return planFail("invalid_selection", "reactivate_on_downgrade");
        const r = await prismaService.$transaction(async (tx) => {
          if (!(await ensureSubscriptionInTx(tx, tenantId, now))) throw new PlanChangeRollback(planFail("not_found"));
          const t = await tx.tenant.findUnique({ where: { id: tenantId }, select: { updatedAt: true } });
          if (!t || t.updatedAt.getTime() !== expectedUpdatedAt.getTime()) throw new PlanChangeRollback(planFail("stale"));
          const again = await planChangeSituationInTx(tx, tenantId, to, now);
          if (!again || again.billing.kind !== "scheduled_downgrade") throw new PlanChangeRollback(planFail("stale"));
          const s = await scheduleDowngradeInTx(tx, { tenantId, to, disableMembershipIds, requestedById: actor.userId, now });
          if (!s.ok) throw new PlanChangeRollback(fromScheduleFailure(s.reason, s.detail));
          await auditInTx(tx, {
            tenantId,
            actorId: actor.userId,
            action: "billing.plan_change.scheduled",
            entity: "SaasSubscription",
            entityId: tenantId,
            payload: { from: again.from, to, effectiveOn: s.effectiveOn, disableCount: disableMembershipIds.length },
          });
          return { from: again.from, billing: { ...again.billing, effectiveOn: s.effectiveOn } };
        });
        revalidatePath("/configuracion");
        await sendSaasBillingMpMail("billing_plan_change", tenantId, {
          entity: "SaasSubscription",
          entityId: tenantId,
          planFrom: r.from,
          planTo: to,
          planChangeOutcome: "scheduled",
          effectiveOn: r.billing.effectiveOn,
          idempotencyKey: `billing_plan_change:scheduled:${tenantId}:${now.getTime()}`,
        });
        // El monto del débito del día del cambio se proyecta con el plan nuevo (`desiredDebit`).
        await syncSaasMpAfterCommit(tenantId);
        return { ok: true, data: { disabled: 0, reactivated: 0, revokedInvites: 0, billing: r.billing } };
      }

      if (kind === "upgrade_prorated") {
        const key = parsed.data.idempotencyKey ?? randomUUID();
        const r = await prismaService.$transaction(async (tx) => {
          // Tenant → Subscription primero (orden del escritor); `applyPlanChangeInTx` re-pide el Tenant en la misma tx.
          if (!(await ensureSubscriptionInTx(tx, tenantId, now))) throw new PlanChangeRollback(planFail("not_found"));
          const again = await planChangeSituationInTx(tx, tenantId, to, now);
          if (!again || again.billing.kind !== "upgrade_prorated") throw new PlanChangeRollback(planFail("stale"));
          const res = await applyPlanChangeInTx(tx, base);
          if (!res.ok) throw new PlanChangeRollback(fromApplyFailure(res));
          const pr = await addUpgradeProrationInTx(tx, { tenantId, from: again.from, to, createdById: actor.userId, idempotencyKey: key, now });
          if (again.pendingPlan) await tx.saasSubscription.update({ where: { tenantId }, data: CLEAR_PENDING_PLAN });
          await auditInTx(tx, {
            tenantId,
            actorId: actor.userId,
            action: "billing.plan_change.upgraded",
            entity: "SaasSubscription",
            entityId: tenantId,
            payload: {
              from: again.from,
              to,
              adjustmentId: pr.adjustmentId,
              prorationCents: pr.prorationCents,
              days: pr.days,
              periodDays: pr.periodDays,
              clearedPendingPlan: again.pendingPlan,
            },
          });
          const billing: PlanChangeBilling = {
            kind: "upgrade_prorated",
            effectiveOn: again.billing.effectiveOn,
            prorationCents: pr.prorationCents,
            days: pr.days,
            periodDays: pr.periodDays,
          };
          return { res, from: again.from, billing };
        });
        revalidatePlan(tenantId);
        await sendSaasBillingMpMail("billing_plan_change", tenantId, {
          entity: "SaasSubscription",
          entityId: tenantId,
          planFrom: r.from,
          planTo: to,
          planChangeOutcome: "upgraded",
          amountCents: r.billing.prorationCents,
          effectiveOn: r.billing.effectiveOn,
          idempotencyKey: `billing_plan_change:upgraded:${tenantId}:${key}`,
        });
        await syncSaasMpAfterCommit(tenantId);
        return {
          ok: true,
          data: { disabled: r.res.disabled, reactivated: r.res.reactivated, revokedInvites: r.res.revokedInvites, billing: r.billing },
        };
      }

      // `immediate`: como hasta ahora (rol app + RLS). Si había una bajada programada (rara: un cargo anulado después de
      // programarla) la tx va por el canal service para limpiarla en el mismo commit (`SaasSubscription` es
      // TENANT_READONLY); si no, quedaría una bajada vieja que el cron aplicaría sobre el plan nuevo.
      const clearPending = sit.pendingPlan !== null;
      const work = async (tx: DbClient): Promise<ApplyPlanChangeResult> => {
        const again = await planChangeSituationInTx(tx, tenantId, to, now);
        if (!again) return { ok: false, reason: "not_found" };
        if (again.billing.kind !== "immediate") throw new PlanChangeRollback(planFail("stale"));
        const res = await applyPlanChangeInTx(tx, base);
        if (res.ok && clearPending) await tx.saasSubscription.update({ where: { tenantId }, data: CLEAR_PENDING_PLAN });
        return res;
      };
      const res = clearPending ? await prismaService.$transaction(work) : await runTeamTx(ctx, work);
      if (!res.ok) return fromApplyFailure(res);
      revalidatePlan(tenantId);
      await syncSaasMpAfterCommit(tenantId);
      return {
        ok: true,
        data: { disabled: res.disabled, reactivated: res.reactivated, revokedInvites: res.revokedInvites, billing: sit.billing },
      };
    } catch (err) {
      if (err instanceof PlanChangeRollback) return err.result;
      if (err instanceof PlanChangeRaceError) return planFail("stale");
      throw err;
    }
  });
}

/**
 * Subir el comprobante de una transferencia (queda `PENDING_REVIEW` hasta que Plataforma lo apruebe). Campos del
 * FormData: `file` (obligatorio), `method` (obligatorio, PL-F1a: valor de `SAAS_PAYMENT_METHODS`, va a la columna),
 * `chargeId` (opcional: la UI sugiere el último impago; sin cargo queda a cuenta y, al aprobarse, se aplica a los
 * pendientes del más viejo), `amount` (vacío con cargo = lo que falta), `paidOn` (YYYY-MM-DD), `note`.
 *
 * Orden: barrera → modo → rate limit → validación del formulario y del ARCHIVO (tamaño + magic bytes) → cargo del
 * consultorio → Storage → fila (+ audit) en una tx; si la tx falla se borra el objeto subido.
 */
export async function submitPaymentReceipt(form: FormData): Promise<ActionResult<SubmitPaymentReceiptResult>> {
  return withAccountWritable("lib/saas-billing.ts#submitPaymentReceipt", async (): Promise<ActionResult<SubmitPaymentReceiptResult>> => {
    const { actor } = await requireAccountBilling();
    assertWritable(actor);
    if (!billingActive()) return { ok: false, error: BILLING_COPY.modeOff };
    const rl = await rateLimit(`billing-receipt:${actor.userId}`, { limit: 10, windowMs: 10 * 60_000 });
    if (!rl.ok) return { ok: false, error: rateLimitedMessage(rl.retryAfterMs) };

    const now = new Date();
    const parsed = parsePaymentForm(form, now);
    if (!parsed.ok) return { ok: false, error: parsed.error, fieldErrors: { [parsed.field]: [parsed.error] } };
    const f = parsed.data;
    if (!f.file) return { ok: false, error: BILLING_COPY.receiptRequired, fieldErrors: { file: [BILLING_COPY.receiptRequired] } };
    const receipt = await readReceiptFile(f.file);
    if (!receipt.ok) return { ok: false, error: receipt.error, fieldErrors: { file: [receipt.error] } };

    let amountCents = f.amountCents;
    if (f.chargeId) {
      // El cargo tiene que ser de ESTE consultorio (BYPASSRLS en prod: el where es la barrera) y estar pendiente.
      const c = await runWithRls(actor.tenantId, async (tx) => {
        const row = await tx.saasCharge.findFirst({
          where: { id: f.chargeId!, tenantId: actor.tenantId },
          select: { status: true, amountCents: true, dueDate: true },
        });
        if (!row) return null;
        const paid = await tx.saasPayment.aggregate({
          where: { chargeId: f.chargeId!, tenantId: actor.tenantId, status: "APPROVED" },
          _sum: { amountCents: true },
        });
        return { ...row, approvedCents: paid._sum.amountCents ?? 0 };
      });
      if (!c) return { ok: false, error: BILLING_COPY.chargeNotFound };
      if (c.status !== "OPEN") return { ok: false, error: BILLING_COPY.chargeNotOpen };
      if (amountCents === null) {
        amountCents = remainingCents({ status: c.status, amountCents: c.amountCents, approvedCents: c.approvedCents, dueDate: "" });
      }
    }
    if (amountCents === null || amountCents <= 0) {
      return { ok: false, error: BILLING_COPY.amountInvalid, fieldErrors: { amount: [BILLING_COPY.amountInvalid] } };
    }

    const paymentId = randomUUID();
    const up = await uploadReceipt({ tenantId: actor.tenantId, paymentId, ext: receipt.ext, bytes: receipt.bytes, mimeType: receipt.mimeType });
    if (!up.ok) return { ok: false, error: up.error };
    let result;
    try {
      result = await prismaService.$transaction(async (tx) => {
        const r = await recordPaymentInTx(tx, {
          id: paymentId,
          tenantId: actor.tenantId,
          chargeId: f.chargeId,
          amountCents: amountCents!,
          status: "PENDING_REVIEW",
          paidAt: f.paidAt,
          receipt: { path: up.path, mimeType: receipt.mimeType, sizeBytes: receipt.sizeBytes },
          note: f.note,
          method: f.method,
          submittedById: actor.userId,
          now,
        });
        if (r.ok) {
          await auditInTx(tx, {
            tenantId: actor.tenantId,
            actorId: actor.userId,
            action: "billing.payment.submitted",
            entity: "SaasPayment",
            entityId: paymentId,
            payload: { amountCents: amountCents!, chargeId: f.chargeId, method: f.method, mimeType: receipt.mimeType, sizeBytes: receipt.sizeBytes },
          });
        }
        return r;
      });
    } catch (err) {
      await removeReceipt(up.path);
      throw err;
    }
    if (!result.ok) {
      await removeReceipt(up.path);
      const error =
        result.reason === "charge_not_open"
          ? BILLING_COPY.chargeNotOpen
          : result.reason === "amount_invalid"
            ? BILLING_COPY.amountInvalid
            : BILLING_COPY.chargeNotFound;
      return { ok: false, error };
    }
    revalidatePath("/configuracion");
    return { ok: true, data: { paymentId } };
  });
}

/** URL firmada (60 s) del comprobante de un pago de ESTE consultorio. */
export async function getReceiptUrl(paymentId: unknown): Promise<ActionResult<{ url: string }>> {
  const { actor } = await requireAccountBilling();
  const id = ID.safeParse(paymentId);
  if (!id.success) return { ok: false, error: BILLING_COPY.paymentNotFound };
  const row = await runWithRls(actor.tenantId, (tx) =>
    tx.saasPayment.findFirst({ where: { id: id.data, tenantId: actor.tenantId }, select: { receiptPath: true } })
  );
  if (!row) return { ok: false, error: BILLING_COPY.paymentNotFound };
  if (!row.receiptPath) return { ok: false, error: BILLING_COPY.noReceipt };
  const signed = await signReceipt(row.receiptPath);
  if (!signed.ok) return { ok: false, error: signed.error };
  return { ok: true, data: { url: signed.url } };
}
