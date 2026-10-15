import "server-only";
/**
 * Núcleo de los cobros de la suscripción (PL-2b, C-PL7..10 SIN Mercado Pago: decisión de Martin del 16-oct, plan
 * §20.5.6 y nota final de §20.18). Cargos mensuales del período, pagos MANUALES con comprobante (los sube el
 * consultorio y los aprueba Plataforma, o los imputa Plataforma directo), estado contable y precios con vigencia.
 *
 * Canal: `SaasSubscription`/`SaasCharge`/`SaasPayment` son TENANT_READONLY (el consultorio las LEE con RLS, nadie las
 * escribe con el rol app) y `SaasPlanPriceChange` es SERVICE_ONLY. Este módulo es el ÚNICO que las escribe: cada
 * función `*InTx` corre en una tx del canal service (`prismaService.$transaction`) que abre el caller; la barrera de
 * quién puede es del caller (`requireAccountBilling` / `requirePlatformAdmin`), y acá se filtra SIEMPRE por
 * `tenantId` a mano (la conexión service saltea RLS).
 *
 * Locks (orden fijo para no cruzarse con nadie): Tenant → SaasSubscription → SaasCharge → SaasPayment. Tenant
 * primero porque el escritor único de entitlements (`applyTenantEntitlementsInTx`, que cambia el estado de la
 * suscripción) y los cupos ya lo toman primero; volverlo a pedir en la misma tx no espera.
 *
 * Estado de la suscripción: lo escribe SOLO `applyTenantEntitlementsInTx` con source `billing` (escritor único,
 * C-EV5); `recomputeSubscriptionStatusInTx` decide (`nextSubscriptionStatus`) y le pasa el patch. El escritor estampa
 * `subscriptionStatusChangedAt` solo si el estado cambia de verdad: la gracia de PAST_DUE no se estira con corridas
 * repetidas.
 *
 * `SAAS_BILLING_MODE` (PL-D16, `saasBillingMode()`): `off` = el cron no genera cargos ni cambia estados, y el
 * recálculo de estado no escribe. `manual` = todo lo de acá. `mp` = igual que `manual` (Mercado Pago quedó fuera de
 * esta etapa; el enum ya aceptaba `mp` y se trata como `manual` hasta que vuelva al roadmap).
 *
 * Auditoría: este módulo NO audita; el caller audita en la MISMA tx (consultorio: `auditInTx`; Plataforma: doble con
 * `auditPlatformInTx`; cron: el registro de plataforma de los mails). Así cada caller dice quién fue.
 */
import { randomUUID } from "node:crypto";
import type { Prisma, SaasChargeStatus, SaasPaymentSource, SaasPlan, SubscriptionStatus } from "@prisma/client";
import { revalidateTag } from "next/cache";
import { prismaService } from "@/lib/db";
import type { DbClient } from "@/lib/rls";
import { env, saasBillingMode, saasBillingTransferInfo } from "@/lib/env";
import { formatARS } from "@/lib/format";
import { logger } from "@/lib/logger";
import { toARDateKey } from "@/lib/datetime-ar";
import { SAAS_PLANS_TAG } from "@/lib/cache-tags";
import { PLAN_DEFAULTS } from "@/lib/saas-plans-logic";
import { PAST_DUE_GRACE_DAYS } from "@/lib/tenant-access";
import {
  applyTenantEntitlementsInTx,
  type TenantEntitlementActor,
} from "@/lib/tenant-entitlements-internal";
import { auditPlatformGlobalInTx, type PlatformActorRef } from "@/lib/audit";
import { sendEmail } from "@/lib/email";
import "@/lib/email/log";
import type { RenderedEmail, EmailKind } from "@/lib/email/types";
import {
  billingChargeCreatedEmail,
  billingPastDueEmail,
  billingPaymentReceivedEmail,
  billingPaymentRejectedEmail,
  billingPriceChangeEmail,
} from "@/lib/email/templates-billing";
import {
  anchorDayFor,
  arMidnight,
  balanceCents,
  billingStartKey,
  chargeAmountFor,
  chargeCreatedMailKey,
  chargeInitialState,
  dbDateFromKey,
  firstPeriodStartKey,
  isOverdue,
  keyFromDbDate,
  nextSubscriptionStatus,
  pastDueMailKey,
  periodFor,
  priceChangeMailKey,
  remainingCents,
  settles,
  type ChargeForBalance,
  type DateKey,
} from "@/lib/saas-billing-logic";
import type { BillingChargeRow, BillingLedger, BillingPaymentRow } from "@/lib/saas-billing-types";

type Tx = Prisma.TransactionClient;

/** `mp` se trata como `manual` en esta etapa (ver cabecera). */
export function billingActive(): boolean {
  return saasBillingMode() !== "off";
}

// ── Locks ───────────────────────────────────────────────────────────────────────────────────────────────────────

async function lockTenant(tx: Tx, tenantId: string): Promise<boolean> {
  const r = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Tenant" WHERE "id" = ${tenantId} FOR UPDATE`;
  return r.length > 0;
}

async function lockSubscription(tx: Tx, tenantId: string): Promise<void> {
  await tx.$queryRaw`SELECT "tenantId" FROM "SaasSubscription" WHERE "tenantId" = ${tenantId} FOR UPDATE`;
}

async function lockCharge(tx: Tx, chargeId: string, tenantId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "SaasCharge" WHERE "id" = ${chargeId} AND "tenantId" = ${tenantId} FOR UPDATE`;
}

async function lockPayment(tx: Tx, paymentId: string, tenantId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "SaasPayment" WHERE "id" = ${paymentId} AND "tenantId" = ${tenantId} FOR UPDATE`;
}

async function planPriceCents(tx: DbClient, plan: SaasPlan): Promise<{ priceCents: number | null; label: string }> {
  const cfg = await tx.saasPlanConfig.findUnique({ where: { plan }, select: { priceCents: true, label: true } });
  return cfg ?? { priceCents: PLAN_DEFAULTS[plan].priceCents, label: PLAN_DEFAULTS[plan].label };
}

// ── Suscripción ─────────────────────────────────────────────────────────────────────────────────────────────────

export type SubscriptionRow = {
  tenantId: string;
  customPriceCents: number | null;
  anchorDay: number;
  nextChargeAt: Date | null;
};

const SUB_SELECT = { tenantId: true, customPriceCents: true, anchorDay: true, nextChargeAt: true } as const;

/**
 * Crea la suscripción del consultorio si no existe (anclaje PL2b-D1). Toma el lock del Tenant. `null` = el consultorio
 * no existe.
 *
 * El primer período nunca arranca antes de HOY: un consultorio que ya existía cuando se prendió el cobro (o con la
 * prueba vencida hace meses) no recibe cargos retroactivos; queda anclado al día en que se crea la suscripción.
 * Mientras siga en prueba y sin cargos, se RE-ANCLA si cambió la prueba (Plataforma la extendió): el primer cobro se
 * corre con ella. Fuera de la prueba, o con algún cargo generado, el anclaje queda fijo.
 */
export async function ensureSubscriptionInTx(tx: Tx, tenantId: string, now: Date): Promise<SubscriptionRow | null> {
  if (!(await lockTenant(tx, tenantId))) return null;
  const t = await tx.tenant.findUnique({
    where: { id: tenantId },
    select: { trialEndsAt: true, createdAt: true, subscriptionStatus: true },
  });
  if (!t) return null;
  const trialing = t.subscriptionStatus === "TRIALING";
  const today = toARDateKey(now);
  const computed = billingStartKey({ trialEndsAt: trialing ? t.trialEndsAt : null, createdAt: t.createdAt });
  const start = computed > today ? computed : today;
  const anchorDay = anchorDayFor(start);
  const first = firstPeriodStartKey(start, anchorDay);
  await lockSubscription(tx, tenantId);
  const sub = await tx.saasSubscription.findUnique({ where: { tenantId }, select: SUB_SELECT });
  if (!sub) {
    return tx.saasSubscription.create({
      data: { tenantId, anchorDay, nextChargeAt: arMidnight(first) },
      select: SUB_SELECT,
    });
  }
  if (!trialing || !t.trialEndsAt) return sub;
  const nextKey = sub.nextChargeAt ? toARDateKey(sub.nextChargeAt) : null;
  // Solo si la prueba se corrió MÁS ALLÁ del próximo cobro (extensión): acortarla no adelanta el cobro.
  if (nextKey !== null && first <= nextKey) return sub;
  const anyCharge = await tx.saasCharge.findFirst({ where: { tenantId }, select: { id: true } });
  if (anyCharge) return sub;
  return tx.saasSubscription.update({
    where: { tenantId },
    data: { anchorDay, nextChargeAt: arMidnight(first) },
    select: SUB_SELECT,
  });
}

// ── Cargos del período ──────────────────────────────────────────────────────────────────────────────────────────

export type CreateChargeResult =
  | { kind: "created"; chargeId: string; periodStart: DateKey; amountCents: number }
  | { kind: "not_due" | "exists" | "no_price" | "tenant_inactive" | "cancelled" | "in_trial" | "not_found"; periodStart?: DateKey };

/**
 * Genera el cargo del período que marca `nextChargeAt` (si ya llegó) y avanza el cursor un mes. Idempotente: el
 * UNIQUE (tenantId, periodStart) hace que una segunda corrida (o dos crons a la vez) no duplique: `ON CONFLICT DO
 * NOTHING` → `exists`. Sin precio (plan en «Consultá» y sin precio a medida), consultorio suspendido/dado de baja o
 * suscripción cancelada: no se cobra ese período, pero el cursor avanza igual (no se acumulan cargos para cuando se
 * reactive: sin prorrateo ni retroactivos, PL-D9).
 */
export async function createPeriodChargeInTx(tx: Tx, p: { tenantId: string; now: Date }): Promise<CreateChargeResult> {
  const sub = await ensureSubscriptionInTx(tx, p.tenantId, p.now);
  if (!sub) return { kind: "not_found" };
  if (!sub.nextChargeAt || sub.nextChargeAt.getTime() > p.now.getTime()) return { kind: "not_due" };
  const t = await tx.tenant.findUniqueOrThrow({
    where: { id: p.tenantId },
    select: { status: true, subscriptionStatus: true, trialEndsAt: true, saasPlan: true },
  });
  const periodStart = toARDateKey(sub.nextChargeAt);
  const period = periodFor(periodStart);
  const advance = () =>
    tx.saasSubscription.update({ where: { tenantId: p.tenantId }, data: { nextChargeAt: arMidnight(period.periodEnd) } });

  // Prueba en curso (re-anclada arriba si se extendió): no se cobra todavía.
  if (t.subscriptionStatus === "TRIALING" && t.trialEndsAt && toARDateKey(t.trialEndsAt) >= periodStart) {
    return { kind: "in_trial", periodStart };
  }
  if (t.status !== "ACTIVE") {
    await advance();
    return { kind: "tenant_inactive", periodStart };
  }
  if (t.subscriptionStatus === "CANCELLED") {
    await advance();
    return { kind: "cancelled", periodStart };
  }
  const price = await planPriceCents(tx, t.saasPlan);
  const amountCents = chargeAmountFor({ customPriceCents: sub.customPriceCents, planPriceCents: price.priceCents });
  if (amountCents === null) {
    await advance();
    return { kind: "no_price", periodStart };
  }
  const init = chargeInitialState(amountCents);
  const rows = await tx.saasCharge.createManyAndReturn({
    data: [
      {
        tenantId: p.tenantId,
        plan: t.saasPlan,
        periodStart: dbDateFromKey(period.periodStart),
        periodEnd: dbDateFromKey(period.periodEnd),
        dueDate: dbDateFromKey(period.dueDate),
        amountCents,
        status: init.status,
        paidAt: init.paid ? p.now : null,
      },
    ],
    skipDuplicates: true,
    select: { id: true },
  });
  await advance();
  if (rows.length === 0) return { kind: "exists", periodStart };
  // PL-Z a1#1: si hay saldo a cuenta, el cargo nuevo se cobra de ahí (no vence ni manda a PAST_DUE con plata a favor).
  if (init.status === "OPEN") await applyCreditInTx(tx, p.tenantId, p.now);
  return { kind: "created", chargeId: rows[0].id, periodStart, amountCents };
}

// ── Pagos ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Suma de pagos APROBADOS de un cargo. */
async function approvedCentsOf(tx: Tx, chargeId: string, tenantId: string): Promise<number> {
  const agg = await tx.saasPayment.aggregate({
    where: { chargeId, tenantId, status: "APPROVED" },
    _sum: { amountCents: true },
  });
  return agg._sum.amountCents ?? 0;
}

/** Si los pagos aprobados alcanzan, el cargo abierto pasa a PAID. Devuelve si cambió. */
async function settleChargeIfPaidInTx(tx: Tx, chargeId: string, tenantId: string, now: Date): Promise<boolean> {
  const c = await tx.saasCharge.findFirst({ where: { id: chargeId, tenantId }, select: { status: true, amountCents: true } });
  if (!c || c.status !== "OPEN") return false;
  if (!settles(c.amountCents, await approvedCentsOf(tx, chargeId, tenantId))) return false;
  await tx.saasCharge.update({ where: { id: chargeId }, data: { status: "PAID", paidAt: now, statusChangedAt: now } });
  return true;
}

// ── Saldo a cuenta (PL-Z a1#1 / a1#2) ───────────────────────────────────────────────────────────────────────────
//
// Antes de PL-Z, un pago APROBADO sin cargo (pagó por adelantado, o el cargo elegido se condonó mientras se revisaba)
// quedaba a cuenta PARA SIEMPRE: `balanceCents` lo restaba, pero el cargo siguiente nacía OPEN, vencía y el
// consultorio caía en PAST_DUE con saldo a favor. Y un pago por más de lo que faltaba de un cargo se imputaba entero a
// ese cargo: el excedente no figuraba en ningún lado (ni a cuenta ni en otro cargo).
//
// Ahora la plata siempre queda en un solo lugar: cada pago APROBADO está imputado a UN cargo por, como mucho, lo que
// le faltaba; lo que sobra se parte en un pago HERMANO (APROBADO, sin cargo, mismo comprobante y misma fecha) y el
// saldo a cuenta se aplica a los cargos abiertos del más viejo al más nuevo (`applyCreditInTx`). Se parte en vez de
// agregar una tabla de imputaciones porque `SaasPayment.chargeId` ya es la imputación que leen el ledger, el estado y
// Plataforma (sin migración nueva en PL-Z). La suma de los pagos aprobados no cambia nunca al partir.

type PaymentForSplit = {
  id: string;
  amountCents: number;
  source: SaasPaymentSource;
  paidAt: Date | null;
  receiptPath: string | null;
  receiptMimeType: string | null;
  receiptSizeBytes: number | null;
  submittedById: string | null;
  reviewedById: string | null;
  reviewedAt: Date | null;
};

const SPLIT_SELECT = {
  id: true,
  amountCents: true,
  source: true,
  paidAt: true,
  receiptPath: true,
  receiptMimeType: true,
  receiptSizeBytes: true,
  submittedById: true,
  reviewedById: true,
  reviewedAt: true,
} as const;

/**
 * Imputa un pago APROBADO al cargo `chargeId`, por como mucho `needCents`. Si el pago es mayor, el pago queda por
 * `needCents` y el resto pasa a un pago hermano a cuenta (devuelve su id). `needCents` ≤ 0 → el pago entero queda a
 * cuenta. El caller tiene los locks (Tenant → SaasSubscription → SaasCharge).
 */
async function allocatePaymentInTx(
  tx: Tx,
  tenantId: string,
  pay: PaymentForSplit,
  chargeId: string,
  needCents: number
): Promise<{ usedCents: number; leftover: PaymentForSplit | null }> {
  if (needCents <= 0) {
    await tx.saasPayment.update({ where: { id: pay.id }, data: { chargeId: null } });
    return { usedCents: 0, leftover: pay };
  }
  if (pay.amountCents <= needCents) {
    await tx.saasPayment.update({ where: { id: pay.id }, data: { chargeId } });
    return { usedCents: pay.amountCents, leftover: null };
  }
  const restCents = pay.amountCents - needCents;
  await tx.saasPayment.update({ where: { id: pay.id }, data: { chargeId, amountCents: needCents } });
  const sibling = await tx.saasPayment.create({
    data: {
      tenantId,
      chargeId: null,
      source: pay.source,
      status: "APPROVED",
      amountCents: restCents,
      paidAt: pay.paidAt,
      // Mismo comprobante: es la misma transferencia, partida para imputarla.
      receiptPath: pay.receiptPath,
      receiptMimeType: pay.receiptMimeType,
      receiptSizeBytes: pay.receiptSizeBytes,
      note: `Saldo a favor: resto de un pago de ${formatARS(pay.amountCents)}.`,
      submittedById: pay.submittedById,
      reviewedById: pay.reviewedById,
      reviewedAt: pay.reviewedAt,
    },
    select: SPLIT_SELECT,
  });
  return { usedCents: needCents, leftover: sibling };
}

/** Lo que le falta a un cargo abierto, mirando los pagos aprobados ya imputados. */
async function chargeNeedCents(tx: Tx, chargeId: string, tenantId: string): Promise<number> {
  const c = await tx.saasCharge.findFirst({ where: { id: chargeId, tenantId }, select: { status: true, amountCents: true } });
  if (!c || c.status !== "OPEN") return 0;
  return Math.max(0, c.amountCents - (await approvedCentsOf(tx, chargeId, tenantId)));
}

/**
 * Aplica el saldo a cuenta (pagos APROBADOS sin cargo, del más viejo) a los cargos abiertos (del período más viejo),
 * partiendo pagos cuando sobra, y salda los cargos que quedan cubiertos. Lo llaman: el cron al generar un cargo, y
 * imputar/aprobar un pago (cuando el pago, o su resto, queda a cuenta). El caller tiene el lock del Tenant y de la
 * suscripción; acá se toman los de los cargos y los pagos en ese orden. Devuelve los cargos que pasaron a PAID.
 */
export async function applyCreditInTx(tx: Tx, tenantId: string, now: Date): Promise<{ paidChargeIds: string[] }> {
  const open = await tx.$queryRaw<{ id: string; amountCents: number }[]>`
    SELECT "id", "amountCents" FROM "SaasCharge"
    WHERE "tenantId" = ${tenantId} AND "status" = 'OPEN'
    ORDER BY "periodStart" ASC, "id" ASC
    FOR UPDATE`;
  if (open.length === 0) return { paidChargeIds: [] };
  const lockedCredits = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "SaasPayment"
    WHERE "tenantId" = ${tenantId} AND "status" = 'APPROVED' AND "chargeId" IS NULL
    ORDER BY COALESCE("paidAt", "createdAt") ASC, "createdAt" ASC, "id" ASC
    FOR UPDATE`;
  if (lockedCredits.length === 0) return { paidChargeIds: [] };
  const byId = new Map(
    (
      await tx.saasPayment.findMany({ where: { tenantId, id: { in: lockedCredits.map((c) => c.id) } }, select: SPLIT_SELECT })
    ).map((p) => [p.id, p])
  );
  const sums = await tx.saasPayment.groupBy({
    by: ["chargeId"],
    where: { tenantId, status: "APPROVED", chargeId: { in: open.map((c) => c.id) } },
    _sum: { amountCents: true },
  });
  const paid = new Map(sums.map((s) => [s.chargeId, s._sum.amountCents ?? 0]));
  const need = open.map((c) => ({ id: c.id, cents: Math.max(0, c.amountCents - (paid.get(c.id) ?? 0)) }));

  const touched = new Set<string>();
  let ci = 0;
  for (const { id } of lockedCredits) {
    let pay: PaymentForSplit | null = byId.get(id) ?? null;
    while (pay && ci < need.length) {
      if (need[ci].cents <= 0) {
        ci++;
        continue;
      }
      const r = await allocatePaymentInTx(tx, tenantId, pay, need[ci].id, need[ci].cents);
      touched.add(need[ci].id);
      need[ci].cents -= r.usedCents;
      pay = r.leftover;
    }
    if (ci >= need.length) break;
  }
  const paidChargeIds: string[] = [];
  for (const chargeId of touched) {
    if (await settleChargeIfPaidInTx(tx, chargeId, tenantId, now)) paidChargeIds.push(chargeId);
  }
  return { paidChargeIds };
}

/**
 * Imputa un pago recién APROBADO: al cargo `target` por lo que le falta (el resto, a cuenta) o, sin cargo, a cuenta;
 * y después aplica el saldo a cuenta a los cargos abiertos. Devuelve el cargo donde quedó el pago (el original, no el
 * hermano) y si se saldó algún cargo.
 */
async function imputeApprovedPaymentInTx(
  tx: Tx,
  tenantId: string,
  paymentId: string,
  target: string | null,
  now: Date
): Promise<{ chargeId: string | null; chargePaid: boolean }> {
  const pay = await tx.saasPayment.findFirstOrThrow({ where: { id: paymentId, tenantId }, select: SPLIT_SELECT });
  let chargePaid = false;
  if (target) {
    await allocatePaymentInTx(tx, tenantId, pay, target, await chargeNeedCents(tx, target, tenantId));
    chargePaid = await settleChargeIfPaidInTx(tx, target, tenantId, now);
  }
  const credit = await applyCreditInTx(tx, tenantId, now);
  const after = await tx.saasPayment.findFirstOrThrow({ where: { id: paymentId, tenantId }, select: { chargeId: true } });
  return { chargeId: after.chargeId, chargePaid: chargePaid || credit.paidChargeIds.length > 0 };
}

export type ReceiptRef = { path: string; mimeType: string; sizeBytes: number };

export type RecordPaymentResult =
  | { ok: true; paymentId: string; chargeId: string | null; chargePaid: boolean; statusChanged: SubscriptionStatus | null }
  | { ok: false; reason: "not_found" | "charge_not_found" | "charge_not_open" | "amount_invalid" };

/**
 * Pago MANUAL (transferencia con comprobante). Dos caminos:
 *  - el consultorio lo sube → `PENDING_REVIEW` (no imputa nada hasta que Plataforma lo apruebe);
 *  - Plataforma lo imputa → `APPROVED` directo (al cargo elegido por lo que le falta, o a los abiertos del más viejo;
 *    lo que sobra queda a cuenta, partido en un pago hermano: PL-Z a1#1/#2) y recalcula el estado de la suscripción.
 * `id` lo trae el caller porque la clave del comprobante en Storage ya lo usa (`<tenantId>/<paymentId>.<ext>`).
 */
export async function recordPaymentInTx(
  tx: Tx,
  p: {
    id?: string;
    tenantId: string;
    chargeId: string | null;
    amountCents: number;
    status: "PENDING_REVIEW" | "APPROVED";
    paidAt: Date | null;
    receipt: ReceiptRef | null;
    note: string | null;
    submittedById: string | null;
    reviewedById?: string | null;
    now: Date;
  }
): Promise<RecordPaymentResult> {
  if (!Number.isInteger(p.amountCents) || p.amountCents <= 0) return { ok: false, reason: "amount_invalid" };
  if (!(await lockTenant(tx, p.tenantId))) return { ok: false, reason: "not_found" };
  await lockSubscription(tx, p.tenantId);

  const chargeId = p.chargeId;
  if (chargeId) {
    await lockCharge(tx, chargeId, p.tenantId);
    // FK compuesta (chargeId, tenantId) también lo frena, pero un 23503 aborta la tx con un error opaco.
    const c = await tx.saasCharge.findFirst({ where: { id: chargeId, tenantId: p.tenantId }, select: { status: true } });
    if (!c) return { ok: false, reason: "charge_not_found" };
    if (c.status !== "OPEN") return { ok: false, reason: "charge_not_open" };
  }

  const paymentId = p.id ?? randomUUID();
  await tx.saasPayment.create({
    data: {
      id: paymentId,
      tenantId: p.tenantId,
      // APROBADO: nace a cuenta y lo imputa `imputeApprovedPaymentInTx` (al cargo elegido por lo que falta; sin cargo,
      // a los abiertos del más viejo). PENDIENTE: guarda el cargo que eligió el consultorio, para la revisión.
      chargeId: p.status === "APPROVED" ? null : chargeId,
      source: "MANUAL",
      status: p.status,
      amountCents: p.amountCents,
      paidAt: p.paidAt ?? (p.status === "APPROVED" ? p.now : null),
      receiptPath: p.receipt?.path ?? null,
      receiptMimeType: p.receipt?.mimeType ?? null,
      receiptSizeBytes: p.receipt?.sizeBytes ?? null,
      note: p.note,
      submittedById: p.submittedById,
      ...(p.status === "APPROVED" ? { reviewedById: p.reviewedById ?? null, reviewedAt: p.now } : {}),
    },
  });
  if (p.status !== "APPROVED") return { ok: true, paymentId, chargeId, chargePaid: false, statusChanged: null };
  const imp = await imputeApprovedPaymentInTx(tx, p.tenantId, paymentId, chargeId, p.now);
  const st = await recomputeSubscriptionStatusInTx(tx, p.tenantId, p.now, null);
  return { ok: true, paymentId, chargeId: imp.chargeId, chargePaid: imp.chargePaid, statusChanged: st.changedTo };
}

export type ReviewPaymentResult =
  | {
      ok: true;
      decision: "approve" | "reject";
      amountCents: number;
      chargeId: string | null;
      chargePaid: boolean;
      statusChanged: SubscriptionStatus | null;
    }
  | { ok: false; reason: "not_found" | "already_reviewed" | "reason_required" | "charge_not_found" };

/**
 * Plataforma revisa un comprobante `PENDING_REVIEW`. Aprobar imputa al cargo elegido (o al del pago) por lo que le
 * falta; sin cargo, si ese cargo ya no está abierto, o con excedente, la plata queda a cuenta y se aplica a los cargos
 * abiertos del más viejo (PL-Z a1#1/#2). Después recalcula el estado; rechazar exige motivo (lo ve
 * el consultorio y le llega por mail). Solo se revisa una vez: la segunda → `already_reviewed` (doble clic, dos
 * superadmins a la vez: el lock del pago serializa y el segundo ve el estado nuevo).
 */
export async function reviewPaymentInTx(
  tx: Tx,
  p: {
    tenantId: string;
    paymentId: string;
    decision: "approve" | "reject";
    reviewNote: string | null;
    chargeId?: string | null;
    reviewerId: string | null;
    now: Date;
  }
): Promise<ReviewPaymentResult> {
  if (p.decision === "reject" && !(p.reviewNote && p.reviewNote.trim().length >= 3)) {
    return { ok: false, reason: "reason_required" };
  }
  if (!(await lockTenant(tx, p.tenantId))) return { ok: false, reason: "not_found" };
  await lockSubscription(tx, p.tenantId);
  const peek = await tx.saasPayment.findFirst({ where: { id: p.paymentId, tenantId: p.tenantId }, select: { chargeId: true } });
  if (!peek) return { ok: false, reason: "not_found" };

  let target: string | null = null;
  if (p.decision === "approve") {
    if (p.chargeId) {
      const c = await tx.saasCharge.findFirst({ where: { id: p.chargeId, tenantId: p.tenantId }, select: { id: true } });
      if (!c) return { ok: false, reason: "charge_not_found" };
      target = c.id;
    } else {
      // Sin cargo: queda a cuenta y `applyCreditInTx` lo reparte entre los abiertos (del más viejo).
      target = peek.chargeId;
    }
    if (target) await lockCharge(tx, target, p.tenantId);
  } else if (peek.chargeId) {
    await lockCharge(tx, peek.chargeId, p.tenantId);
  }
  await lockPayment(tx, p.paymentId, p.tenantId);
  const pay = await tx.saasPayment.findFirst({
    where: { id: p.paymentId, tenantId: p.tenantId },
    select: { status: true, amountCents: true, paidAt: true, chargeId: true },
  });
  if (!pay) return { ok: false, reason: "not_found" };
  if (pay.status !== "PENDING_REVIEW") return { ok: false, reason: "already_reviewed" };

  const note = p.reviewNote?.trim() ? p.reviewNote.trim().slice(0, 500) : null;
  if (p.decision === "reject") {
    await tx.saasPayment.update({
      where: { id: p.paymentId },
      data: { status: "REJECTED", reviewedById: p.reviewerId, reviewedAt: p.now, reviewNote: note },
    });
    return { ok: true, decision: "reject", amountCents: pay.amountCents, chargeId: pay.chargeId, chargePaid: false, statusChanged: null };
  }

  if (target) {
    const c = await tx.saasCharge.findFirst({ where: { id: target, tenantId: p.tenantId }, select: { status: true } });
    // Cargo anulado/condonado/pagado mientras tanto: el pago no se pierde, queda a cuenta.
    if (!c || c.status !== "OPEN") target = null;
  }
  await tx.saasPayment.update({
    where: { id: p.paymentId },
    data: {
      status: "APPROVED",
      chargeId: null,
      paidAt: pay.paidAt ?? p.now,
      reviewedById: p.reviewerId,
      reviewedAt: p.now,
      reviewNote: note,
    },
  });
  // Al cargo por lo que le falta; el resto (o todo, si no hay cargo) a cuenta y aplicado a los abiertos.
  const imp = await imputeApprovedPaymentInTx(tx, p.tenantId, p.paymentId, target, p.now);
  const st = await recomputeSubscriptionStatusInTx(tx, p.tenantId, p.now, null);
  // `amountCents` = el del comprobante entero (para el mail), aunque se haya partido.
  return { ok: true, decision: "approve", amountCents: pay.amountCents, chargeId: imp.chargeId, chargePaid: imp.chargePaid, statusChanged: st.changedTo };
}

// ── Anular / condonar ───────────────────────────────────────────────────────────────────────────────────────────

export type ChargeStatusChangeResult =
  | { ok: true; statusChanged: SubscriptionStatus | null }
  | { ok: false; reason: "not_found" | "charge_not_open" | "has_payments" };

/**
 * VOID (el cargo no correspondía: se generó por error) o WAIVED (correspondía y se perdona lo que falte). Solo sobre
 * cargos OPEN. Anular un cargo con pagos aprobados se rechaza (la plata ya está imputada: se condona el resto).
 */
export async function setChargeStatusInTx(
  tx: Tx,
  p: { tenantId: string; chargeId: string; to: Extract<SaasChargeStatus, "VOID" | "WAIVED">; note: string | null; actorId: string | null; now: Date }
): Promise<ChargeStatusChangeResult> {
  if (!(await lockTenant(tx, p.tenantId))) return { ok: false, reason: "not_found" };
  await lockSubscription(tx, p.tenantId);
  await lockCharge(tx, p.chargeId, p.tenantId);
  const c = await tx.saasCharge.findFirst({ where: { id: p.chargeId, tenantId: p.tenantId }, select: { status: true } });
  if (!c) return { ok: false, reason: "not_found" };
  if (c.status !== "OPEN") return { ok: false, reason: "charge_not_open" };
  if (p.to === "VOID" && (await approvedCentsOf(tx, p.chargeId, p.tenantId)) > 0) return { ok: false, reason: "has_payments" };
  await tx.saasCharge.update({
    where: { id: p.chargeId },
    data: {
      status: p.to,
      statusChangedAt: p.now,
      statusChangedById: p.actorId,
      note: p.note?.trim() ? p.note.trim().slice(0, 500) : null,
    },
  });
  const st = await recomputeSubscriptionStatusInTx(tx, p.tenantId, p.now, null);
  return { ok: true, statusChanged: st.changedTo };
}

export const voidChargeInTx = (tx: Tx, p: Omit<Parameters<typeof setChargeStatusInTx>[1], "to">) =>
  setChargeStatusInTx(tx, { ...p, to: "VOID" });
export const waiveChargeInTx = (tx: Tx, p: Omit<Parameters<typeof setChargeStatusInTx>[1], "to">) =>
  setChargeStatusInTx(tx, { ...p, to: "WAIVED" });

// ── Estado de la suscripción ────────────────────────────────────────────────────────────────────────────────────

/**
 * Recalcula ACTIVE / PAST_DUE según los cargos (`nextSubscriptionStatus`) y, si cambia, lo escribe el escritor
 * único con source `billing`. `actor` null = cron o Plataforma (el escritor exige que un actor `billing` sea del
 * mismo consultorio; el audit de Plataforma ya lo escribe su action). Con `SAAS_BILLING_MODE=off` no escribe.
 */
export async function recomputeSubscriptionStatusInTx(
  tx: Tx,
  tenantId: string,
  now: Date,
  actor: TenantEntitlementActor
): Promise<{ changedTo: SubscriptionStatus | null }> {
  if (!billingActive()) return { changedTo: null };
  const t = await tx.tenant.findUnique({
    where: { id: tenantId },
    select: { subscriptionStatus: true, trialEndsAt: true, status: true },
  });
  if (!t || t.status === "CLOSED") return { changedTo: null };
  const charges = await chargesForBalance(tx, tenantId, { onlyOpenOrSettled: true });
  const today = toARDateKey(now);
  const next = nextSubscriptionStatus({
    current: t.subscriptionStatus,
    trialEndsAt: t.trialEndsAt,
    now,
    hasOverdue: charges.some((c) => isOverdue(c, today)),
    hasSettledCharge: charges.some((c) => c.status === "PAID" || c.status === "WAIVED"),
  });
  if (!next || next === t.subscriptionStatus) return { changedTo: null };
  const r = await applyTenantEntitlementsInTx(tx, { tenantId, source: "billing", patch: { subscriptionStatus: next }, actor });
  return { changedTo: r.ok && r.changed.length ? next : null };
}

async function chargesForBalance(
  tx: DbClient,
  tenantId: string,
  o: { onlyOpenOrSettled?: boolean } = {}
): Promise<(ChargeForBalance & { id: string })[]> {
  const rows = await tx.saasCharge.findMany({
    where: { tenantId, ...(o.onlyOpenOrSettled ? { status: { in: ["OPEN", "PAID", "WAIVED"] } } : {}) },
    select: { id: true, status: true, amountCents: true, dueDate: true },
  });
  if (rows.length === 0) return [];
  const sums = await tx.saasPayment.groupBy({
    by: ["chargeId"],
    where: { tenantId, status: "APPROVED", chargeId: { in: rows.map((r) => r.id) } },
    _sum: { amountCents: true },
  });
  const paid = new Map(sums.map((s) => [s.chargeId, s._sum.amountCents ?? 0]));
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    amountCents: r.amountCents,
    approvedCents: paid.get(r.id) ?? 0,
    dueDate: keyFromDbDate(r.dueDate),
  }));
}

// ── Precio a medida y precios del plan ──────────────────────────────────────────────────────────────────────────

/** Precio a medida del consultorio (null = el del plan). Rige desde el próximo cargo (sin prorrateo, PL-D9). */
export async function setCustomPriceInTx(
  tx: Tx,
  p: { tenantId: string; priceCents: number | null; now: Date }
): Promise<{ ok: true; before: number | null; after: number | null } | { ok: false; reason: "not_found" | "invalid" }> {
  if (p.priceCents !== null && !(Number.isInteger(p.priceCents) && p.priceCents >= 0)) return { ok: false, reason: "invalid" };
  const sub = await ensureSubscriptionInTx(tx, p.tenantId, p.now);
  if (!sub) return { ok: false, reason: "not_found" };
  if (sub.customPriceCents === p.priceCents) return { ok: true, before: sub.customPriceCents, after: p.priceCents };
  await tx.saasSubscription.update({ where: { tenantId: p.tenantId }, data: { customPriceCents: p.priceCents } });
  return { ok: true, before: sub.customPriceCents, after: p.priceCents };
}

async function lockPlanConfig(tx: Tx, plan: SaasPlan): Promise<void> {
  await tx.$queryRaw`SELECT "plan" FROM "SaasPlanConfig" WHERE "plan" = ${plan}::"SaasPlan" FOR UPDATE`;
}

/**
 * Precio nuevo de un plan con vigencia (PL-D8): siempre deja la fila en el historial `SaasPlanPriceChange` (solo
 * inserción por trigger). Si `effectiveFrom` ya pasó, se aplica en la misma tx (`appliedAt`); si no, lo aplica el
 * cron diario cuando llegue. `previousPriceCents` = el precio vigente al programarlo (para el mail y el historial).
 * El caller revalida `SAAS_PLANS_TAG` después del commit si `appliedNow`.
 */
export async function schedulePlanPriceInTx(
  tx: Tx,
  p: { plan: SaasPlan; priceCents: number | null; effectiveFrom: Date; note: string | null; actorId: string | null; now: Date }
): Promise<{ changeId: string; appliedNow: boolean; previousPriceCents: number | null }> {
  if (p.priceCents !== null && !(Number.isInteger(p.priceCents) && p.priceCents >= 0)) {
    throw new Error("[saas-billing] priceCents inválido");
  }
  await lockPlanConfig(tx, p.plan);
  const cur = await tx.saasPlanConfig.findUnique({ where: { plan: p.plan }, select: { priceCents: true } });
  if (!cur) throw new Error(`[saas-billing] falta la fila de SaasPlanConfig de ${p.plan}`);
  const appliedNow = p.effectiveFrom.getTime() <= p.now.getTime();
  const change = await tx.saasPlanPriceChange.create({
    data: {
      plan: p.plan,
      priceCents: p.priceCents,
      previousPriceCents: cur.priceCents,
      effectiveFrom: p.effectiveFrom,
      appliedAt: appliedNow ? p.now : null,
      note: p.note?.trim() ? p.note.trim().slice(0, 500) : null,
      createdById: p.actorId,
    },
    select: { id: true },
  });
  if (appliedNow) {
    await tx.saasPlanConfig.update({ where: { plan: p.plan }, data: { priceCents: p.priceCents, updatedById: p.actorId } });
    // PL-Z a1#4: los pendientes del mismo plan que ya entraron en vigencia (el cron todavía no los aplicó) quedan
    // pisados por este, que es más nuevo: se marcan aplicados para que el cron de mañana no vuelva al precio viejo.
    // (El trigger de la tabla solo deja escribir `appliedAt` NULL → valor.) Los de vigencia futura siguen pendientes.
    await tx.saasPlanPriceChange.updateMany({
      where: { plan: p.plan, appliedAt: null, effectiveFrom: { lte: p.now }, id: { not: change.id } },
      data: { appliedAt: p.now },
    });
  }
  return { changeId: change.id, appliedNow, previousPriceCents: cur.priceCents };
}

/** Aplica UN cambio pendiente que ya entró en vigencia. Idempotente: si otro lo aplicó, `false`. */
async function applyPriceChangeInTx(tx: Tx, changeId: string, now: Date): Promise<boolean> {
  const peek = await tx.saasPlanPriceChange.findUnique({ where: { id: changeId }, select: { plan: true } });
  if (!peek) return false;
  await lockPlanConfig(tx, peek.plan);
  const ch = await tx.saasPlanPriceChange.findUnique({
    where: { id: changeId },
    select: { appliedAt: true, effectiveFrom: true, priceCents: true, createdById: true, createdAt: true },
  });
  if (!ch || ch.appliedAt || ch.effectiveFrom.getTime() > now.getTime()) return false;
  // PL-Z a1#4: si ya rige un cambio del mismo plan programado DESPUÉS que este y con vigencia igual o posterior, este
  // quedó pisado: se marca aplicado (no se reintenta cada día) pero no toca el precio.
  const newer = await tx.saasPlanPriceChange.findFirst({
    where: {
      plan: peek.plan,
      id: { not: changeId },
      appliedAt: { not: null },
      createdAt: { gt: ch.createdAt },
      effectiveFrom: { gte: ch.effectiveFrom },
    },
    select: { id: true },
  });
  if (newer) {
    await tx.saasPlanPriceChange.update({ where: { id: changeId }, data: { appliedAt: now } });
    return false;
  }
  await tx.saasPlanConfig.update({ where: { plan: peek.plan }, data: { priceCents: ch.priceCents, updatedById: ch.createdById } });
  await tx.saasPlanPriceChange.update({ where: { id: changeId }, data: { appliedAt: now } });
  return true;
}

// ── Lectura: ledger ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Estado contable de un consultorio. Lo usan Configuración → Facturación (en `runWithRls`: las tres tablas tienen
 * policy de lectura por tenant) y Plataforma (canal service). Filtra por `tenantId` a mano igual (BYPASSRLS en prod).
 * Sin suscripción creada todavía (`off`, o antes del primer cron) el próximo cargo se calcula sin escribir.
 */
export async function readLedger(db: DbClient, tenantId: string, now: Date): Promise<BillingLedger | null> {
  const t = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { saasPlan: true, subscriptionStatus: true, trialEndsAt: true, createdAt: true },
  });
  if (!t) return null;
  const [sub, price, charges, payments] = await Promise.all([
    db.saasSubscription.findUnique({ where: { tenantId }, select: SUB_SELECT }),
    planPriceCents(db, t.saasPlan),
    db.saasCharge.findMany({
      where: { tenantId },
      orderBy: [{ periodStart: "desc" }],
      take: 36,
      select: {
        id: true,
        plan: true,
        periodStart: true,
        periodEnd: true,
        dueDate: true,
        amountCents: true,
        status: true,
        paidAt: true,
        note: true,
      },
    }),
    db.saasPayment.findMany({
      where: { tenantId },
      orderBy: [{ createdAt: "desc" }],
      take: 60,
      select: {
        id: true,
        chargeId: true,
        source: true,
        status: true,
        amountCents: true,
        paidAt: true,
        createdAt: true,
        receiptPath: true,
        receiptMimeType: true,
        note: true,
        reviewNote: true,
        reviewedAt: true,
      },
    }),
  ]);
  const today = toARDateKey(now);
  const forBalance = await chargesForBalance(db, tenantId, { onlyOpenOrSettled: true });
  const credit = await db.saasPayment.aggregate({
    where: { tenantId, status: "APPROVED", chargeId: null },
    _sum: { amountCents: true },
  });
  const creditCents = credit._sum.amountCents ?? 0;
  // PL-Z a1#7: contado en la base (la lista de pagos se corta en 60; el aviso «tenés N a revisar» no).
  const pendingReviewCount = await db.saasPayment.count({ where: { tenantId, status: "PENDING_REVIEW" } });
  const paidBy = new Map(forBalance.map((c) => [c.id, c.approvedCents]));
  const periodOf = new Map(charges.map((c) => [c.id, keyFromDbDate(c.periodStart)]));

  const chargeRows: BillingChargeRow[] = charges.map((c) => {
    const cb: ChargeForBalance = {
      status: c.status,
      amountCents: c.amountCents,
      approvedCents: paidBy.get(c.id) ?? 0,
      dueDate: keyFromDbDate(c.dueDate),
    };
    return {
      id: c.id,
      plan: c.plan,
      periodStart: keyFromDbDate(c.periodStart),
      periodEnd: keyFromDbDate(c.periodEnd),
      dueDate: cb.dueDate,
      amountCents: c.amountCents,
      paidCents: cb.approvedCents,
      remainingCents: remainingCents(cb),
      status: c.status,
      overdue: isOverdue(cb, today),
      paidAt: c.paidAt?.toISOString() ?? null,
      note: c.note,
    };
  });
  const paymentRows: BillingPaymentRow[] = payments.map((p) => ({
    id: p.id,
    chargeId: p.chargeId,
    chargePeriodStart: p.chargeId ? periodOf.get(p.chargeId) ?? null : null,
    source: p.source,
    status: p.status,
    amountCents: p.amountCents,
    paidAt: p.paidAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
    hasReceipt: !!p.receiptPath,
    receiptMimeType: p.receiptMimeType,
    note: p.note,
    reviewNote: p.reviewNote,
    reviewedAt: p.reviewedAt?.toISOString() ?? null,
  }));

  const customPriceCents = sub?.customPriceCents ?? null;
  const effectivePriceCents = chargeAmountFor({ customPriceCents, planPriceCents: price.priceCents });
  let nextKey: DateKey | null = sub?.nextChargeAt ? toARDateKey(sub.nextChargeAt) : null;
  if (!sub) {
    const start = billingStartKey({
      trialEndsAt: t.subscriptionStatus === "TRIALING" ? t.trialEndsAt : null,
      createdAt: t.createdAt,
    });
    nextKey = firstPeriodStartKey(start, anchorDayFor(start));
  }
  return {
    tenantId,
    plan: t.saasPlan,
    planLabel: price.label,
    planPriceCents: price.priceCents,
    customPriceCents,
    effectivePriceCents,
    subscriptionStatus: t.subscriptionStatus,
    trialEndsAt: t.trialEndsAt?.toISOString() ?? null,
    anchorDay: sub?.anchorDay ?? null,
    nextCharge: nextKey && t.subscriptionStatus !== "CANCELLED" ? { periodStart: nextKey, amountCents: effectivePriceCents } : null,
    balanceCents: balanceCents(forBalance, creditCents),
    creditCents,
    overdueCount: forBalance.filter((c) => isOverdue(c, today)).length,
    pendingReviewCount,
    charges: chargeRows,
    payments: paymentRows,
  };
}

// ── Mails ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** El cron no es una persona (molde de `lib/cron-jobs-internal.ts`). */
const CRON_ACTOR: PlatformActorRef = { userId: null, email: null, homeTenantId: null };

export function billingUrl(): string {
  return `${env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}/configuracion?tab=facturacion`;
}

/** Titular y quien tenga «Planes y pagos», activos (molde de los recordatorios de prueba). */
export async function billingRecipients(tenantId: string): Promise<{ userId: string; email: string }[]> {
  const rows = await prismaService.membership.findMany({
    where: {
      tenantId,
      acceptedAt: { not: null },
      disabledAt: null,
      user: { disabledAt: null },
      OR: [{ role: "OWNER" }, { grantBilling: true }],
    },
    select: { userId: true, user: { select: { email: true } } },
    orderBy: { userId: "asc" },
  });
  return rows.map((r) => ({ userId: r.userId, email: r.user.email }));
}

/** Manda un mail a los destinatarios de cobros. `sendEmail` nunca tira; devuelve cuántos salieron. */
export async function sendBillingMail(
  tenantId: string,
  kind: EmailKind,
  mail: RenderedEmail,
  entity: { entity: string; entityId: string }
): Promise<{ sent: number; notSent: number }> {
  const out = { sent: 0, notSent: 0 };
  for (const r of await billingRecipients(tenantId)) {
    const res = await sendEmail({ ...mail, kind, to: r.email, tenantId, entity: entity.entity, entityId: entity.entityId });
    if (res.ok) out.sent++;
    else out.notSent++;
  }
  return out;
}

/** Mail «pago acreditado» después del commit de Plataforma (aprobar / imputar). Nunca tira. */
export async function notifyPaymentReceived(tenantId: string, paymentId: string, amountCents: number): Promise<void> {
  try {
    const t = await prismaService.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
    if (!t) return;
    await sendBillingMail(tenantId, "billing_payment_received", billingPaymentReceivedEmail({ tenantName: t.name, amountCents, url: billingUrl() }), {
      entity: "SaasPayment",
      entityId: paymentId,
    });
  } catch (err) {
    logger.warn("billing.mail_failed", { kind: "billing_payment_received", tenantId, error: err instanceof Error ? err.name : "unknown" });
  }
}

/** Mail «comprobante rechazado» con el motivo, después del commit. Nunca tira. */
export async function notifyPaymentRejected(tenantId: string, paymentId: string, amountCents: number, reason: string): Promise<void> {
  try {
    const t = await prismaService.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
    if (!t) return;
    await sendBillingMail(
      tenantId,
      "billing_payment_rejected",
      billingPaymentRejectedEmail({ tenantName: t.name, amountCents, reason, url: billingUrl() }),
      { entity: "SaasPayment", entityId: paymentId }
    );
  } catch (err) {
    logger.warn("billing.mail_failed", { kind: "billing_payment_rejected", tenantId, error: err instanceof Error ? err.name : "unknown" });
  }
}

/** Reserva idempotente de un mail del cron (molde de los recordatorios de prueba: fila con `idempotencyKey` UNIQUE). */
async function claimMail(p: { key: string; action: `platform.${string}`; tenantId: string; entity: string; entityId: string; payload: Record<string, unknown> }): Promise<boolean> {
  const claim = await prismaService.$transaction((tx) =>
    auditPlatformGlobalInTx(tx, {
      actor: CRON_ACTOR,
      action: p.action,
      entity: p.entity,
      entityId: p.entityId,
      tenantId: p.tenantId,
      payload: p.payload,
      idempotencyKey: p.key,
    })
  );
  return claim.inserted;
}

// ── Cron ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Techo por etapa y corrida (hoy son decenas de consultorios; con más, el resto sale al día siguiente). */
const SCAN_LIMIT = 500;
/** Períodos atrasados que se generan por consultorio y corrida (si el cron estuvo caído más de un mes). */
const MAX_CATCH_UP = 3;
/** Ventana de los mails «por las dudas no salió»: un cargo/vencimiento de hace más no se avisa (ya es viejo). */
const MAIL_WINDOW_MS = 3 * 86_400_000;
/** Ventana del aviso de precio nuevo: cambios programados en los últimos 40 días. */
const PRICE_NOTICE_WINDOW_MS = 40 * 86_400_000;

export type SaasBillingRunResult = {
  mode: "off" | "manual" | "mp";
  skipped: boolean;
  truncated: boolean;
  pricesApplied: number;
  subscriptionsCreated: number;
  chargesCreated: number;
  chargesSkipped: number;
  statusChanged: number;
  mailsClaimed: number;
  mailsSent: number;
  mailsNotSent: number;
  errors: number;
};

/**
 * Etapas de cobro del cron diario (H-PL4, PL-D18), cada una idempotente y con techo; entre consultorios se mira el
 * presupuesto (`budgetMs`): si se termina, se corta y lo que falte sale en la próxima corrida (`truncated`).
 *   1. precios con vigencia vencida → `SaasPlanConfig` (+ revalidar el catálogo público);
 *   2. suscripciones que faltan (consultorios sin fila) → se crean ancladas;
 *   3. cargos del período (`nextChargeAt` ≤ ahora), hasta `MAX_CATCH_UP` por consultorio;
 *   4. estado: PAST_DUE / ACTIVE según cargos vencidos;
 *   5. mails idempotentes (cargo nuevo, vencido, precio nuevo), con reserva en `PlatformAuditEvent`.
 * Un consultorio que falla suma a `errors` y se sigue con el siguiente. `SAAS_BILLING_MODE=off` → no hace nada.
 *
 * `scope.tenantIds`: acota las etapas por consultorio (2..5) a esos ids. La usan los tests de integración (la base
 * local es compartida: un cron sin acotar le crearía suscripciones y mandaría mails a consultorios ajenos) y sirve
 * para reintentar uno a mano. Los precios de lista (etapa 1) son globales y no se acotan.
 */
export async function runSaasBilling(
  now: Date,
  budgetMs: number,
  scope: { tenantIds?: readonly string[] } = {}
): Promise<SaasBillingRunResult> {
  const only = scope.tenantIds ? { in: [...scope.tenantIds] } : undefined;
  const tenantScope: Prisma.TenantWhereInput = only ? { id: only } : {};
  const mode = saasBillingMode();
  const r: SaasBillingRunResult = {
    mode,
    skipped: false,
    truncated: false,
    pricesApplied: 0,
    subscriptionsCreated: 0,
    chargesCreated: 0,
    chargesSkipped: 0,
    statusChanged: 0,
    mailsClaimed: 0,
    mailsSent: 0,
    mailsNotSent: 0,
    errors: 0,
  };
  if (mode === "off") return { ...r, skipped: true };
  const startedAt = Date.now();
  const outOfBudget = () => {
    if (Date.now() - startedAt <= budgetMs) return false;
    r.truncated = true;
    return true;
  };
  const fail = (stage: string, tenantId: string | null, err: unknown) => {
    r.errors++;
    logger.warn("cron.billing.failed", { stage, tenantId, error: err instanceof Error ? err.name : "unknown" });
  };

  // 1. Precios con vigencia.
  const due = await prismaService.saasPlanPriceChange.findMany({
    where: { appliedAt: null, effectiveFrom: { lte: now } },
    orderBy: [{ effectiveFrom: "asc" }, { createdAt: "asc" }],
    select: { id: true },
    take: 50,
  });
  for (const ch of due) {
    try {
      if (await prismaService.$transaction((tx) => applyPriceChangeInTx(tx, ch.id, now))) r.pricesApplied++;
    } catch (err) {
      fail("price", null, err);
    }
  }
  if (r.pricesApplied > 0) {
    try {
      revalidateTag(SAAS_PLANS_TAG);
    } catch (err) {
      // Fuera de un request de Next (script) no hay cache que invalidar; el TTL lo cubre.
      logger.warn("cron.billing.revalidate_failed", { error: err instanceof Error ? err.name : "unknown" });
    }
  }

  // 2. Suscripciones faltantes (consultorios no dados de baja).
  const missing = await prismaService.tenant.findMany({
    where: { ...tenantScope, status: { not: "CLOSED" }, saasSubscription: { is: null } },
    select: { id: true },
    orderBy: { id: "asc" },
    take: SCAN_LIMIT,
  });
  for (const t of missing) {
    if (outOfBudget()) return r;
    try {
      const created = await prismaService.$transaction(async (tx) => {
        const had = await tx.saasSubscription.findUnique({ where: { tenantId: t.id }, select: { tenantId: true } });
        await ensureSubscriptionInTx(tx, t.id, now);
        return !had;
      });
      if (created) r.subscriptionsCreated++;
    } catch (err) {
      fail("subscription", t.id, err);
    }
  }

  // 3. Cargos del período.
  const dueSubs = await prismaService.saasSubscription.findMany({
    where: { ...(only ? { tenantId: only } : {}), nextChargeAt: { lte: now }, tenant: { status: { not: "CLOSED" } } },
    select: { tenantId: true },
    orderBy: { nextChargeAt: "asc" },
    take: SCAN_LIMIT,
  });
  for (const s of dueSubs) {
    if (outOfBudget()) return r;
    try {
      for (let i = 0; i < MAX_CATCH_UP; i++) {
        const c = await prismaService.$transaction((tx) => createPeriodChargeInTx(tx, { tenantId: s.tenantId, now }));
        if (c.kind === "created") r.chargesCreated++;
        else if (c.kind !== "not_due") r.chargesSkipped++;
        if (c.kind === "not_due" || c.kind === "in_trial" || c.kind === "not_found") break;
      }
    } catch (err) {
      fail("charge", s.tenantId, err);
    }
  }

  // 4. Estado (vencidos → PAST_DUE; al día → ACTIVE). Candidatos: con cargos abiertos, en PAST_DUE, o en prueba con
  //    algún cargo saldado.
  const today = dbDateFromKey(toARDateKey(now));
  const candidates = await prismaService.tenant.findMany({
    where: {
      ...tenantScope,
      status: { not: "CLOSED" },
      subscriptionStatus: { not: "CANCELLED" },
      OR: [
        { subscriptionStatus: "PAST_DUE" },
        { saasCharges: { some: { status: "OPEN", dueDate: { lt: today } } } },
        { subscriptionStatus: "TRIALING", saasCharges: { some: { status: { in: ["PAID", "WAIVED"] } } } },
      ],
    },
    select: { id: true },
    orderBy: { id: "asc" },
    take: SCAN_LIMIT,
  });
  for (const t of candidates) {
    if (outOfBudget()) return r;
    try {
      const st = await prismaService.$transaction(async (tx) => {
        await lockTenant(tx, t.id);
        return recomputeSubscriptionStatusInTx(tx, t.id, now, null);
      });
      if (st.changedTo) r.statusChanged++;
    } catch (err) {
      fail("status", t.id, err);
    }
  }

  // 5. Mails.
  const mailStage = async (tenantId: string, key: string, action: `platform.${string}`, entity: { entity: string; entityId: string }, payload: Record<string, unknown>, build: () => Promise<{ kind: EmailKind; mail: RenderedEmail } | null>) => {
    const recipients = await billingRecipients(tenantId);
    // Sin destinatarios no se reserva: si aparece un titular activo, sale en la próxima corrida (molde trial).
    if (recipients.length === 0) return;
    const built = await build();
    if (!built) return;
    if (!(await claimMail({ key, action, tenantId, ...entity, payload: { ...payload, recipients: recipients.length } }))) return;
    r.mailsClaimed++;
    const s = await sendBillingMail(tenantId, built.kind, built.mail, entity);
    r.mailsSent += s.sent;
    r.mailsNotSent += s.notSent;
  };

  const since = new Date(now.getTime() - MAIL_WINDOW_MS);
  const newCharges = await prismaService.saasCharge.findMany({
    where: { ...(only ? { tenantId: only } : {}), createdAt: { gte: since }, status: "OPEN", amountCents: { gt: 0 } },
    select: { id: true, tenantId: true, amountCents: true, periodStart: true, periodEnd: true, dueDate: true, tenant: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
    take: SCAN_LIMIT,
  });
  for (const c of newCharges) {
    if (outOfBudget()) return r;
    try {
      await mailStage(
        c.tenantId,
        chargeCreatedMailKey(c.id),
        "platform.cron.billing_charge_created",
        { entity: "SaasCharge", entityId: c.id },
        { periodStart: keyFromDbDate(c.periodStart), amountCents: c.amountCents },
        async () => ({
          kind: "billing_charge_created",
          mail: billingChargeCreatedEmail({
            tenantName: c.tenant.name,
            amountCents: c.amountCents,
            periodStart: keyFromDbDate(c.periodStart),
            periodEnd: keyFromDbDate(c.periodEnd),
            dueDate: keyFromDbDate(c.dueDate),
            url: billingUrl(),
            transferInfo: saasBillingTransferInfo(),
          }),
        })
      );
    } catch (err) {
      fail("mail_charge", c.tenantId, err);
    }
  }

  const pastDue = await prismaService.tenant.findMany({
    where: { ...tenantScope, status: "ACTIVE", subscriptionStatus: "PAST_DUE", subscriptionStatusChangedAt: { gte: since } },
    select: { id: true, name: true, subscriptionStatusChangedAt: true },
    take: SCAN_LIMIT,
  });
  for (const t of pastDue) {
    if (outOfBudget()) return r;
    try {
      const changedAt = t.subscriptionStatusChangedAt as Date;
      await mailStage(
        t.id,
        pastDueMailKey(t.id, changedAt),
        "platform.cron.billing_past_due",
        { entity: "Tenant", entityId: t.id },
        { since: changedAt.toISOString() },
        async () => {
          const ledger = await readLedger(prismaService, t.id, now);
          return {
            kind: "billing_past_due",
            mail: billingPastDueEmail({
              tenantName: t.name,
              balanceCents: ledger?.balanceCents ?? 0,
              graceDays: PAST_DUE_GRACE_DAYS,
              url: billingUrl(),
              transferInfo: saasBillingTransferInfo(),
            }),
          };
        }
      );
    } catch (err) {
      fail("mail_past_due", t.id, err);
    }
  }

  const changes = await prismaService.saasPlanPriceChange.findMany({
    where: { createdAt: { gte: new Date(now.getTime() - PRICE_NOTICE_WINDOW_MS) }, priceCents: { not: null } },
    select: { id: true, plan: true, priceCents: true, previousPriceCents: true, effectiveFrom: true, createdAt: true },
    orderBy: { createdAt: "asc" },
    take: 20,
  });
  for (const ch of changes) {
    // Si después se programó otro cambio del mismo plan PARA LA MISMA FECHA, este ya no es el precio que va a regir:
    // no se avisa. PL-Z a1#5: antes bastaba cualquier cambio con vigencia posterior, y un aumento del 1/11 seguido de
    // otro programado para el 1/12 dejaba sin avisar el del 1/11 (que sí rige un mes).
    const superseded = await prismaService.saasPlanPriceChange.count({
      where: { plan: ch.plan, effectiveFrom: ch.effectiveFrom, id: { not: ch.id }, createdAt: { gt: ch.createdAt } },
    });
    if (superseded > 0 || ch.priceCents === ch.previousPriceCents) continue;
    const label = (await planPriceCents(prismaService, ch.plan)).label;
    const affected = await prismaService.tenant.findMany({
      where: {
        ...tenantScope,
        saasPlan: ch.plan,
        status: "ACTIVE",
        subscriptionStatus: { not: "CANCELLED" },
        // Con precio a medida, el precio del plan no le cambia nada.
        OR: [{ saasSubscription: { is: null } }, { saasSubscription: { is: { customPriceCents: null } } }],
      },
      select: { id: true, name: true },
      orderBy: { id: "asc" },
      take: SCAN_LIMIT,
    });
    for (const t of affected) {
      if (outOfBudget()) return r;
      try {
        await mailStage(
          t.id,
          priceChangeMailKey(ch.id, t.id),
          "platform.cron.billing_price_change",
          { entity: "SaasPlanPriceChange", entityId: ch.id },
          { plan: ch.plan, priceCents: ch.priceCents },
          async () => ({
            kind: "billing_price_change",
            mail: billingPriceChangeEmail({
              tenantName: t.name,
              planLabel: label,
              priceCents: ch.priceCents as number,
              previousPriceCents: ch.previousPriceCents,
              effectiveFrom: toARDateKey(ch.effectiveFrom),
              url: billingUrl(),
            }),
          })
        );
      } catch (err) {
        fail("mail_price", t.id, err);
      }
    }
  }
  return r;
}
