import "server-only";
/**
 * Programación de la suscripción: bajadas de plan, bajas a fin de período, proporcional de la subida y reactivación
 * (C-MPS9, plan §26.6; MPS-D11/D12/D13/D18/D19). Corren en una tx del canal service que abre el caller (action,
 * Plataforma o la etapa 2b del cron): `SaasSubscription`/`SaasCharge`/`SaasAdjustment` son TENANT_READONLY, el rol app
 * no las puede escribir (hallazgo 3 de §26.6, MPS-D10). Nunca llaman a MP: el sync del débito va después del commit
 * (`syncSaasMpAfterCommit`), porque una llamada de red adentro de la tx retiene los locks mientras MP tarda.
 *
 * Orden de locks: Tenant → Subscription → Charge → Payment → Adjustment (`lockTenant`/`lockSubscription` del núcleo;
 * `ensureSubscriptionInTx` toma los dos en ese orden). `applyPlanChangeInTx` vuelve a pedir el Tenant (misma tx: no
 * espera) y después las membresías; nadie toma Membership antes que Subscription, así que no hay ciclo.
 *
 * El estado de la suscripción (CANCELLED / ACTIVE) lo escribe SOLO el escritor único de entitlements
 * (`applyTenantEntitlementsInTx`): source `billing` con el actor del consultorio o null (cron), source `platform` con
 * un `PlatformActorRef`. Este módulo no audita aparte: el escritor audita el cambio de estado y `applyPlanChangeInTx`
 * el de plan, en la misma tx; lo demás (programar, deshacer) lo audita la action que llama.
 *
 * Decisiones con default de MPS-2c (reportadas):
 *  - La fecha de la bajada programada es el próximo COBRO (`nextChargeAt`, que después del re-anclaje es el próximo
 *    4), no el 4 a secas: un consultorio todavía con ancla vieja (no re-anclado) paga el período que ya empezó con el
 *    plan que eligió; bajarlo el 4 en medio de su período le daría días pagos con menos usuarios. Es la misma regla
 *    que `cancelEffectiveOnFor` para la baja.
 *  - Programar una baja anula la bajada de plan pendiente: si se va, no hay plan que bajar; «Deshacer baja» no la
 *    revive (se vuelve a pedir).
 *  - «La baja fue propia» (MPS-D19) se decide por el registro del escritor único: el ÚLTIMO paso a CANCELLED tiene que
 *    haber sido `source: billing` (solo `applyDueCancelInTx` escribe CANCELLED con esa source). Una baja de Plataforma
 *    (o una fila tocada a mano, sin audit) no se auto-reactiva: falla cerrado.
 */
import type { Prisma, Role, SaasPlan, SubscriptionStatus } from "@prisma/client";
import {
  applyTenantEntitlementsInTx,
  type EntitlementActor,
  type TenantEntitlementActor,
} from "@/lib/tenant-entitlements-internal";
import type { PlatformActorRef } from "@/lib/platform-audit-types";
import { ensureSubscriptionInTx, lockSubscription, lockTenant } from "@/lib/saas-billing-internal";
import { addAdjustmentInTx } from "@/lib/saas-adjustments-internal";
import { applyPlanChangeInTx, previewPlanChangeInTx } from "@/lib/saas-plan-change-internal";
import type { ApplyPlanChangeReason } from "@/lib/saas-plan-change-types";
import type { TeamActorCtx } from "@/lib/team-internal";
import { mustDisableFor } from "@/lib/plan-catalog";
import { PLAN_DEFAULTS, hasCustomLimits } from "@/lib/saas-plans-logic";
import { toARDateKey } from "@/lib/datetime-ar";
import {
  PLAN_ORDER,
  SAAS_ANCHOR_DAY,
  arMidnight,
  cancelEffectiveOnFor,
  chargeAmountFor,
  dbDateFromKey,
  effectiveCustomPrice,
  firstPeriodStartKey,
  keyFromDbDate,
  nextAnchorKey,
  prorate,
  type DateKey,
} from "@/lib/saas-billing-logic";

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

/** Resultado de `applyDuePlanChangeInTx`. Con `annulled`, lo que necesita el mail `billing_plan_change` (MPS-D12). */
export type DuePlanChangeResult = {
  outcome: "none" | "applied" | "annulled";
  /** Plan con el que queda el consultorio (null = no existe). */
  plan: SaasPlan | null;
  /** El plan que estaba programado (applied/annulled). */
  pendingPlan?: SaasPlan;
  /** Plan anterior (applied). */
  from?: SaasPlan;
  /** Fecha AR en que vencía la bajada. */
  effectiveOn?: DateKey;
  /** Por qué se anuló (`does_not_fit`, `owner_selected`, …) y el detalle del recuento. */
  reason?: ApplyPlanChangeReason | "same_plan";
  detail?: string;
  /** Quién la había pedido (para el mail y el audit de la action). */
  requestedById?: string | null;
};

const fail = <T>(reason: ScheduleFailure, detail?: string): ScheduleResult<T> =>
  detail ? { ok: false, reason, detail } : { ok: false, reason };

const rank = (p: SaasPlan) => PLAN_ORDER.indexOf(p);

function isPlatformActor(a: EntitlementActor): a is PlatformActorRef {
  return a !== null && "email" in a;
}

/** Escritor único con la source que corresponde al actor (ver cabecera). */
function writeStatusInTx(tx: Tx, tenantId: string, subscriptionStatus: SubscriptionStatus, actor: EntitlementActor) {
  if (isPlatformActor(actor)) {
    return applyTenantEntitlementsInTx(tx, { tenantId, source: "platform", patch: { subscriptionStatus }, actor });
  }
  return applyTenantEntitlementsInTx(tx, { tenantId, source: "billing", patch: { subscriptionStatus }, actor: actor as TenantEntitlementActor });
}

/** Clave AR del próximo cobro guardado (`nextChargeAt`), o null. */
function nextChargeKeyOf(nextChargeAt: Date | null): DateKey | null {
  return nextChargeAt ? toARDateKey(nextChargeAt) : null;
}

/** Día en que rige una bajada pedida hoy: el próximo cobro si es futuro; si no, el próximo 4 (ver cabecera). */
function downgradeEffectiveOn(today: DateKey, nextChargeKey: DateKey | null): DateKey {
  return nextChargeKey && nextChargeKey > today ? nextChargeKey : nextAnchorKey(today);
}

const CLEAR_PENDING_PLAN = {
  pendingPlan: null,
  pendingPlanEffectiveOn: null,
  pendingPlanDisableIds: [],
  pendingPlanRequestedById: null,
  pendingPlanRequestedAt: null,
} as const satisfies Prisma.SaasSubscriptionUpdateInput;

const CLEAR_CANCEL = {
  cancelAtPeriodEnd: false,
  cancelEffectiveOn: null,
  cancelRequestedAt: null,
  cancelRequestedById: null,
} as const satisfies Prisma.SaasSubscriptionUpdateInput;

async function readSubInTx(tx: Tx, tenantId: string) {
  return tx.saasSubscription.findUnique({
    where: { tenantId },
    select: {
      nextChargeAt: true,
      cancelAtPeriodEnd: true,
      cancelEffectiveOn: true,
      pendingPlan: true,
      pendingPlanEffectiveOn: true,
      pendingPlanDisableIds: true,
      pendingPlanRequestedById: true,
      customPriceCents: true,
      customPricePlan: true,
    },
  });
}

/** Precio mensual de `plan` para este consultorio (precio a medida atado al plan, MPS-D14). null = «Consultá». */
async function monthlyPriceInTx(
  tx: Tx,
  plan: SaasPlan,
  sub: { customPriceCents: number | null; customPricePlan: SaasPlan | null }
): Promise<number | null> {
  const cfg = await tx.saasPlanConfig.findUnique({ where: { plan }, select: { priceCents: true } });
  return chargeAmountFor({
    customPriceCents: effectiveCustomPrice({ customPriceCents: sub.customPriceCents, customPricePlan: sub.customPricePlan, plan }),
    planPriceCents: cfg ? cfg.priceCents : PLAN_DEFAULTS[plan].priceCents,
  });
}

// ── Bajada programada ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * Programa la bajada al próximo cobro (`pendingPlan*`). Valida la selección contra el preview REAL
 * (`previewPlanChangeInTx`, el mismo recuento que el drawer): sin repetidos, solo miembros activos, nunca el Titular
 * ni quien la pide, y con los elegidos afuera tiene que entrar en el plan destino. Reprogramar pisa la anterior.
 * Que sea una bajada «programable» (período ya cobrado) lo decide el caller con `planChangeKind`; acá solo se exige
 * que sea hacia abajo en `PLAN_ORDER` y que no haya baja pendiente.
 */
export async function scheduleDowngradeInTx(
  tx: Tx,
  p: { tenantId: string; to: SaasPlan; disableMembershipIds: string[]; requestedById: string | null; now: Date }
): Promise<ScheduleResult<{ effectiveOn: string }>> {
  const s = await ensureSubscriptionInTx(tx, p.tenantId, p.now);
  if (!s) return fail("not_found");
  const t = await tx.tenant.findUnique({
    where: { id: p.tenantId },
    select: { saasPlan: true, subscriptionStatus: true, maxUsersOverride: true, maxProfessionalsOverride: true, maxStaffOverride: true },
  });
  const sub = await readSubInTx(tx, p.tenantId);
  if (!t || !sub) return fail("not_found");
  if (sub.cancelAtPeriodEnd || t.subscriptionStatus === "CANCELLED") return fail("cancel_pending");
  if (rank(p.to) >= rank(t.saasPlan)) return fail("not_downgrade");
  // Mismo criterio que `applyPlanChangeInTx` desde el consultorio (PL-Z a3#1): con cupos a medida lo hace Plataforma.
  if (hasCustomLimits(t.saasPlan, t)) return fail("invalid_selection", "custom_limits");

  const ids = p.disableMembershipIds;
  if (ids.length > 200) return fail("invalid_selection", "too_many");
  if (new Set(ids).size !== ids.length) return fail("invalid_selection", "duplicated");
  const preview = await previewPlanChangeInTx(tx, {
    tenantId: p.tenantId,
    to: p.to,
    now: p.now,
    ...(p.requestedById ? { actorUserId: p.requestedById } : {}),
  });
  if (!preview) return fail("not_found");
  const byId = new Map(preview.candidates.map((c) => [c.membershipId, c]));
  for (const id of ids) {
    const c = byId.get(id);
    if (!c) return fail("invalid_selection", "disable_not_active");
    if (c.isOwner) return fail("invalid_selection", "owner_selected");
    if (c.isSelf) return fail("invalid_selection", "self_selected");
  }
  const chosen = new Set(ids);
  const final = { professional: 0, staff: 0 };
  for (const c of preview.candidates) if (!chosen.has(c.membershipId)) final[c.kind]++;
  const short = mustDisableFor(final, preview.limits);
  if (short.total > 0) {
    return fail("does_not_fit", `professional:${short.professional},staff:${short.staff},total:${short.total}`);
  }

  const effectiveOn = downgradeEffectiveOn(toARDateKey(p.now), nextChargeKeyOf(sub.nextChargeAt));
  await tx.saasSubscription.update({
    where: { tenantId: p.tenantId },
    data: {
      pendingPlan: p.to,
      pendingPlanEffectiveOn: dbDateFromKey(effectiveOn),
      pendingPlanDisableIds: ids,
      pendingPlanRequestedById: p.requestedById,
      pendingPlanRequestedAt: p.now,
    },
  });
  return { ok: true, effectiveOn };
}

/**
 * El ctx de equipo para `applyPlanChangeInTx` (adaptación EntitlementActor → TeamActorCtx, handoff de MPS-K):
 *  - Plataforma → via `platform` con su ref (audit doble).
 *  - Cron (actor null) o consultorio → via `tenant` a nombre de quien PIDIÓ la bajada: es su decisión, y así el audit
 *    `tenant.plan.change` y `disabledById` dicen quién eligió a los que pierden el acceso. Sin solicitante (no debería
 *    pasar: solo el consultorio programa) → via `platform` como sistema (`userId` null).
 */
async function planChangeCtxInTx(tx: Tx, tenantId: string, actor: EntitlementActor, requestedById: string | null): Promise<TeamActorCtx> {
  if (isPlatformActor(actor)) {
    return { via: "platform", tenantId, actorUserId: actor.userId ?? requestedById ?? "", actorRole: "SUPERADMIN", actorRef: actor };
  }
  const userId = requestedById ?? actor?.userId ?? null;
  if (!userId) {
    return { via: "platform", tenantId, actorUserId: "", actorRole: "SUPERADMIN", actorRef: { userId: null, email: null, homeTenantId: null } };
  }
  const m = await tx.membership.findFirst({ where: { tenantId, userId }, select: { role: true } });
  return { via: "tenant", tenantId, actorUserId: userId, actorRole: (m?.role ?? "BILLING") as Role, actorRef: null };
}

/**
 * Aplica la bajada que vence hoy (`pendingPlanEffectiveOn ≤ hoy` AR) con `applyPlanChangeInTx` (recuenta con la
 * selección guardada, deshabilita, anula invitaciones y audita). Si ya no entra (se sumó gente, el elegido ya no está
 * activo, o cualquier rechazo del recuento) se ANULA: se limpia lo programado, el consultorio sigue con su plan (el
 * cargo de hoy sale con ese) y se devuelve lo necesario para el mail (MPS-D12). `applyPlanChangeInTx` valida ANTES
 * de escribir, así que un rechazo no deja nada a medias.
 */
export async function applyDuePlanChangeInTx(
  tx: Tx,
  p: { tenantId: string; actor: EntitlementActor; now: Date }
): Promise<DuePlanChangeResult> {
  if (!(await lockTenant(tx, p.tenantId))) return { outcome: "none", plan: null };
  await lockSubscription(tx, p.tenantId);
  const t = await tx.tenant.findUnique({ where: { id: p.tenantId }, select: { saasPlan: true, updatedAt: true } });
  const sub = await readSubInTx(tx, p.tenantId);
  if (!t) return { outcome: "none", plan: null };
  if (!sub || !sub.pendingPlan || !sub.pendingPlanEffectiveOn) return { outcome: "none", plan: t.saasPlan };
  const effectiveOn = keyFromDbDate(sub.pendingPlanEffectiveOn);
  if (effectiveOn > toARDateKey(p.now)) return { outcome: "none", plan: t.saasPlan };

  const pendingPlan = sub.pendingPlan;
  const requestedById = sub.pendingPlanRequestedById;
  const annul = async (reason: DuePlanChangeResult["reason"], detail?: string): Promise<DuePlanChangeResult> => {
    await tx.saasSubscription.update({ where: { tenantId: p.tenantId }, data: CLEAR_PENDING_PLAN });
    return { outcome: "annulled", plan: t.saasPlan, pendingPlan, effectiveOn, reason, ...(detail ? { detail } : {}), requestedById };
  };
  // Plataforma ya cambió el plan en el medio: lo programado no aplica más.
  if (t.saasPlan === pendingPlan || rank(pendingPlan) >= rank(t.saasPlan)) return annul("same_plan");

  const ctx = await planChangeCtxInTx(tx, p.tenantId, p.actor, requestedById);
  const r = await applyPlanChangeInTx(tx, {
    tenantId: p.tenantId,
    to: pendingPlan,
    disableMembershipIds: sub.pendingPlanDisableIds,
    reactivateMembershipIds: [],
    expectedUpdatedAt: t.updatedAt,
    ctx,
    now: p.now,
  });
  if (!r.ok) {
    if (r.reason === "not_found") return { outcome: "none", plan: null };
    return annul(r.reason, r.detail);
  }
  await tx.saasSubscription.update({ where: { tenantId: p.tenantId }, data: CLEAR_PENDING_PLAN });
  return { outcome: "applied", plan: pendingPlan, pendingPlan, from: t.saasPlan, effectiveOn, requestedById };
}

// ── Subida con proporcional ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Proporcional de una subida (ajuste PRORATION al próximo cargo, MPS-D4/D11): solo si el período en curso ya tiene su
 * cargo (no VOID) y no está en prueba; si no, el próximo cargo ya sale con el plan nuevo y no hay nada que sumar.
 * Diferencia mensual = precio de `to` − lo que se cobró por `from`: la base del cargo del período si el cargo es de
 * `from` (lo que de verdad pagó), o el precio de `from` si ya hubo otra subida en el período (si no, la segunda
 * subida volvería a cobrar la diferencia de la primera). Días AR contando hoy, half-up (`prorate`).
 * `idempotencyKey` = el UUID de la action (instancia del drawer); la clave del ajuste es `upgrade:<uuid>` (un
 * reintento devuelve el mismo ajuste). `effectiveOn` = el fin del período (= inicio del próximo): el ajuste se imputa
 * al primer cargo con `periodStart ≥ effectiveOn`, que tiene que ser el PRÓXIMO. Con «hoy» fallaba el borde del día
 * 4: el cargo del período nuevo tiene `periodStart = hoy` y ya está creado (no se recompone), así que la imputación
 * dependía de cómo lea el escritor un cargo existente. La fecha de la subida va en la descripción.
 */
export async function addUpgradeProrationInTx(
  tx: Tx,
  p: { tenantId: string; from: SaasPlan; to: SaasPlan; createdById: string | null; idempotencyKey: string; now: Date }
): Promise<{ adjustmentId: string | null; prorationCents: number; days: number; periodDays: number }> {
  const none = { adjustmentId: null, prorationCents: 0, days: 0, periodDays: 0 };
  if (rank(p.to) <= rank(p.from)) return none;
  const s = await ensureSubscriptionInTx(tx, p.tenantId, p.now);
  if (!s) return none;
  const t = await tx.tenant.findUnique({ where: { id: p.tenantId }, select: { subscriptionStatus: true } });
  const sub = await readSubInTx(tx, p.tenantId);
  if (!t || !sub || t.subscriptionStatus === "TRIALING") return none;
  const today = toARDateKey(p.now);
  const charge = await tx.saasCharge.findFirst({
    where: {
      tenantId: p.tenantId,
      status: { not: "VOID" },
      periodStart: { lte: dbDateFromKey(today) },
      periodEnd: { gt: dbDateFromKey(today) },
    },
    orderBy: { periodStart: "desc" },
    select: { plan: true, amountCents: true, baseAmountCents: true, periodStart: true, periodEnd: true },
  });
  if (!charge) return none;
  const toPrice = await monthlyPriceInTx(tx, p.to, sub);
  const fromPrice = charge.plan === p.from ? (charge.baseAmountCents ?? charge.amountCents) : await monthlyPriceInTx(tx, p.from, sub);
  if (toPrice === null || fromPrice === null) return none;
  const pr = prorate({
    diffCents: toPrice - fromPrice,
    fromKey: today,
    periodStart: keyFromDbDate(charge.periodStart),
    periodEnd: keyFromDbDate(charge.periodEnd),
  });
  if (!pr) return none;
  const periodEnd = keyFromDbDate(charge.periodEnd);
  const [, mm, dd] = today.split("-");
  const key = p.idempotencyKey.startsWith("upgrade:") ? p.idempotencyKey : `upgrade:${p.idempotencyKey}`;
  const r = await addAdjustmentInTx(tx, {
    tenantId: p.tenantId,
    kind: "PRORATION",
    amountCents: pr.amountCents,
    effectiveOn: periodEnd,
    description: `Proporcional por pasar de ${PLAN_DEFAULTS[p.from].label} a ${PLAN_DEFAULTS[p.to].label} el ${Number(dd)}/${Number(mm)} (${pr.days} de ${pr.periodDays} días)`,
    idempotencyKey: key,
    planFrom: p.from,
    planTo: p.to,
    days: pr.days,
    periodDays: pr.periodDays,
    createdById: p.createdById,
  });
  if (!r.created) {
    // Reintento: se devuelve el ajuste que ya existía (con sus números, no los de hoy).
    const a = await tx.saasAdjustment.findUniqueOrThrow({
      where: { id: r.adjustmentId },
      select: { amountCents: true, days: true, periodDays: true },
    });
    return { adjustmentId: r.adjustmentId, prorationCents: a.amountCents, days: a.days ?? 0, periodDays: a.periodDays ?? 0 };
  }
  return { adjustmentId: r.adjustmentId, prorationCents: pr.amountCents, days: pr.days, periodDays: pr.periodDays };
}

// ── Baja ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Baja a fin de período (`cancelAtPeriodEnd` + `cancelEffectiveOn` = `cancelEffectiveOnFor`; en prueba, el día
 * siguiente al fin, MPS-D18). Acceso completo hasta ese día. Con la baja pendiente no hay cambio de plan
 * (`planChangeKind` → `blocked_cancel_pending`) y se anula la bajada que hubiera programada (ver cabecera).
 */
export async function scheduleCancelInTx(
  tx: Tx,
  p: { tenantId: string; requestedById: string | null; now: Date }
): Promise<ScheduleResult<{ effectiveOn: string; clearedPendingPlan: SaasPlan | null }>> {
  const s = await ensureSubscriptionInTx(tx, p.tenantId, p.now);
  if (!s) return fail("not_found");
  const t = await tx.tenant.findUnique({ where: { id: p.tenantId }, select: { subscriptionStatus: true, trialEndsAt: true } });
  const sub = await readSubInTx(tx, p.tenantId);
  if (!t || !sub) return fail("not_found");
  if (t.subscriptionStatus === "CANCELLED") return fail("already_cancel_pending", "cancelled");
  if (sub.cancelAtPeriodEnd) return fail("already_cancel_pending");
  const effectiveOn = cancelEffectiveOnFor({
    today: p.now,
    subscriptionStatus: t.subscriptionStatus,
    trialEndsAt: t.trialEndsAt,
    nextChargeKey: nextChargeKeyOf(sub.nextChargeAt),
  });
  await tx.saasSubscription.update({
    where: { tenantId: p.tenantId },
    data: {
      cancelAtPeriodEnd: true,
      cancelEffectiveOn: dbDateFromKey(effectiveOn),
      cancelRequestedAt: p.now,
      cancelRequestedById: p.requestedById,
      ...CLEAR_PENDING_PLAN,
    },
  });
  return { ok: true, effectiveOn, clearedPendingPlan: sub.pendingPlan };
}

/**
 * Anula la bajada de plan programada (`pendingPlan*`, todos juntos: el CHECK `SaasSubscription_pendingPlan_check`
 * exige los dos o ninguno). Locks del escritor (Tenant → Subscription) para no cruzarse con la etapa 2b del cron que la
 * aplica ese día: si ya se aplicó, no queda nada pendiente → `no_pending_plan`. Único escritor (ZF1): antes estaba
 * duplicado en «Anular bajada» del consultorio (`lib/saas-billing-mp.ts`) y de Plataforma (`lib/platform-billing.ts`).
 * Devuelve lo que había, para el audit de cada caller. El sync con MP va después del commit (lo hace el caller).
 */
export async function cancelPendingPlanInTx(
  tx: Tx,
  p: { tenantId: string }
): Promise<
  | { ok: true; pendingPlan: SaasPlan; effectiveOn: DateKey | null; disableCount: number; requestedById: string | null }
  | { ok: false; reason: "not_found" | "no_subscription" | "no_pending_plan" }
> {
  if (!(await lockTenant(tx, p.tenantId))) return { ok: false, reason: "not_found" };
  await lockSubscription(tx, p.tenantId);
  const sub = await tx.saasSubscription.findUnique({
    where: { tenantId: p.tenantId },
    select: { pendingPlan: true, pendingPlanEffectiveOn: true, pendingPlanDisableIds: true, pendingPlanRequestedById: true },
  });
  if (!sub) return { ok: false, reason: "no_subscription" };
  if (!sub.pendingPlan) return { ok: false, reason: "no_pending_plan" };
  await tx.saasSubscription.update({ where: { tenantId: p.tenantId }, data: CLEAR_PENDING_PLAN });
  return {
    ok: true,
    pendingPlan: sub.pendingPlan,
    effectiveOn: sub.pendingPlanEffectiveOn ? keyFromDbDate(sub.pendingPlanEffectiveOn) : null,
    disableCount: sub.pendingPlanDisableIds.length,
    requestedById: sub.pendingPlanRequestedById,
  };
}

/**
 * Deshace la baja programada. Solo ANTES del día en que rige: ese día la aplica el cron (etapa 2b) y deshacerla en
 * paralelo dejaría una carrera entre «sigue» y CANCELLED → `stale` (después se reactiva).
 */
export async function undoCancelInTx(
  tx: Tx,
  p: { tenantId: string; actorUserId: string | null; now: Date }
): Promise<ScheduleResult<Record<never, never>>> {
  if (!(await lockTenant(tx, p.tenantId))) return fail("not_found");
  await lockSubscription(tx, p.tenantId);
  const sub = await readSubInTx(tx, p.tenantId);
  if (!sub) return fail("not_found");
  if (!sub.cancelAtPeriodEnd || !sub.cancelEffectiveOn) return fail("not_cancel_pending");
  if (keyFromDbDate(sub.cancelEffectiveOn) <= toARDateKey(p.now)) return fail("stale");
  await tx.saasSubscription.update({ where: { tenantId: p.tenantId }, data: CLEAR_CANCEL });
  return { ok: true };
}

/**
 * Aplica la baja que vence hoy: CANCELLED por el escritor único (source `billing` con actor null = cron; `platform`
 * si llama Plataforma) → `tenantAccessFor` da solo lectura (las lecturas no se cortan nunca). `cancelAtPeriodEnd`
 * vuelve a false pero `cancelEffectiveOn`/`cancelRequested*` quedan de historia (la UI muestra «Se dio de baja el…»).
 * Una bajada de plan pendiente se descarta.
 */
export async function applyDueCancelInTx(
  tx: Tx,
  p: { tenantId: string; actor: EntitlementActor; now: Date }
): Promise<{ cancelled: boolean }> {
  if (!(await lockTenant(tx, p.tenantId))) return { cancelled: false };
  await lockSubscription(tx, p.tenantId);
  const sub = await readSubInTx(tx, p.tenantId);
  if (!sub || !sub.cancelAtPeriodEnd || !sub.cancelEffectiveOn) return { cancelled: false };
  if (keyFromDbDate(sub.cancelEffectiveOn) > toARDateKey(p.now)) return { cancelled: false };
  const w = await writeStatusInTx(tx, p.tenantId, "CANCELLED", p.actor);
  if (!w.ok) return { cancelled: false };
  await tx.saasSubscription.update({ where: { tenantId: p.tenantId }, data: { cancelAtPeriodEnd: false, ...CLEAR_PENDING_PLAN } });
  return { cancelled: w.changed.includes("subscriptionStatus") };
}

/** ¿El último paso a CANCELLED fue la baja programada del propio consultorio? (ver cabecera, MPS-D19). */
async function lastCancelWasOwnInTx(tx: Tx, tenantId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ action: string; source: string | null }[]>`
    SELECT "action", "payload"->>'source' AS "source" FROM "AuditEvent"
    WHERE "tenantId" = ${tenantId}
      AND "action" IN ('tenant.entitlements', 'platform.tenant.entitlements')
      AND "payload"->'after'->>'subscriptionStatus' = 'CANCELLED'
    ORDER BY "createdAt" DESC, "id" DESC
    LIMIT 1`;
  return rows.length === 1 && rows[0].action === "tenant.entitlements" && rows[0].source === "billing";
}

/** ¿Debe algo? Cargos OPEN con saldo (lo que falta pagar de cada uno, con los pagos APROBADOS imputados). */
async function hasDebtInTx(tx: Tx, tenantId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS "n" FROM "SaasCharge" c
    WHERE c."tenantId" = ${tenantId} AND c."status" = 'OPEN'
      AND c."amountCents" > COALESCE((
        SELECT sum(p."amountCents") FROM "SaasPayment" p
        WHERE p."chargeId" = c."id" AND p."tenantId" = ${tenantId} AND p."status" = 'APPROVED'), 0)`;
  return Number(rows[0]?.n ?? 0) > 0;
}

/**
 * Reactiva una suscripción CANCELLED → ACTIVE y RE-ANCLA el período (§21.7): `billableFrom = max(hoy, fin del último
 * cargo no VOID)` (ZF1), ancla 4 y `nextChargeAt` = el primer 4 ≥ eso; el tramo hasta ese 4 lo cobra el primer cargo como proporcional (stub,
 * MPS-D13). Desde el consultorio solo si la baja fue propia y no hay deuda (MPS-D19); Plataforma reactiva cualquier
 * baja pero tampoco con deuda (primero se condona o se paga: si no, el cron la mandaría a PAST_DUE al otro día).
 * Un consultorio suspendido o cerrado no se reactiva por acá (su `status` es de Plataforma).
 */
export async function reactivateInTx(
  tx: Tx,
  p: { tenantId: string; actor: EntitlementActor; now: Date }
): Promise<ScheduleResult<{ status: SubscriptionStatus }>> {
  if (!(await lockTenant(tx, p.tenantId))) return fail("not_found");
  await lockSubscription(tx, p.tenantId);
  const t = await tx.tenant.findUnique({ where: { id: p.tenantId }, select: { subscriptionStatus: true, status: true } });
  if (!t) return fail("not_found");
  if (t.subscriptionStatus !== "CANCELLED") return fail("not_cancelled");
  if (t.status !== "ACTIVE") return fail("not_cancelled", "tenant_inactive");
  if (!isPlatformActor(p.actor) && !(await lastCancelWasOwnInTx(tx, p.tenantId))) return fail("not_cancelled", "not_own");
  if (await hasDebtInTx(tx, p.tenantId)) return fail("has_debt");

  const w = await writeStatusInTx(tx, p.tenantId, "ACTIVE", p.actor);
  if (!w.ok) return fail(w.reason === "stale" ? "stale" : "not_found");
  // ZF1 (revisor ZA de T6+T7): se factura desde hoy o desde el fin del último período cobrado, lo que sea más tarde.
  // Una baja inmediata de Plataforma a mitad de un período ya pagado, reactivada antes de que termine, dejaba
  // `billableFrom = hoy` y el primer cargo sumaba un proporcional por días que ya estaban pagos. Un cargo VOID no
  // cuenta (se anuló: ese período no se cobró); uno WAIVED sí (se perdonó, pero el período quedó saldado).
  const today = toARDateKey(p.now);
  const lastCharge = await tx.saasCharge.findFirst({
    where: { tenantId: p.tenantId, status: { not: "VOID" } },
    orderBy: { periodEnd: "desc" },
    select: { periodEnd: true },
  });
  const paidUntil = lastCharge ? keyFromDbDate(lastCharge.periodEnd) : null;
  const billableFrom = paidUntil && paidUntil > today ? paidUntil : today;
  const next = firstPeriodStartKey(billableFrom, SAAS_ANCHOR_DAY);
  await tx.saasSubscription.upsert({
    where: { tenantId: p.tenantId },
    create: { tenantId: p.tenantId, anchorDay: SAAS_ANCHOR_DAY, nextChargeAt: arMidnight(next), billableFrom: dbDateFromKey(billableFrom) },
    update: {
      anchorDay: SAAS_ANCHOR_DAY,
      nextChargeAt: arMidnight(next),
      billableFrom: dbDateFromKey(billableFrom),
      ...CLEAR_CANCEL,
      ...CLEAR_PENDING_PLAN,
    },
  });
  return { ok: true, status: "ACTIVE" };
}
