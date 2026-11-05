"use server";

/**
 * /plataforma → Facturación y Precios (PL-2b, C-PL10 recortado: SIN Mercado Pago, decisión de Martin del 16-oct; plan
 * §20.5.6). Estado contable por consultorio, imputar pagos manuales con recibo, revisar comprobantes, anular/condonar
 * cargos, precio a medida, precios de lista con vigencia e historial, y cambiar el plan (mismo núcleo que el
 * consultorio, con Libre permitido).
 *
 * Barrera: `requirePlatformAdmin(<clave>)` al principio de CADA export (invariante del gate de BO,
 * tests/unit/platform-admin-guard.test.ts): todo corre por el canal service (BYPASSRLS) y cruza consultorios. Claves:
 * `billing.read` (lecturas), `billing.write` (imputar, revisar, anular, condonar), `billing.price` (precio a medida y
 * de lista), `tenant.plan.change`. Las de plata son `high`: con MFA de Plataforma en enforce piden código reciente.
 *
 * Audit DOBLE (C-BO5): `auditPlatformInTx` deja la fila global `platform.billing.*` y el `AuditEvent` del consultorio
 * AFECTADO en la misma tx que el cambio (existe si y solo si el cambio existe). Los precios de lista no son de un
 * consultorio: `auditPlatformGlobalInTx`. Sin PHI: ids, montos, estados.
 *
 * Mails (después del commit, nunca tiran): pago acreditado al imputar/aprobar; rechazo con el motivo.
 */
import { randomUUID } from "node:crypto";
import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { requirePlatformAdmin, type PlatformActor } from "@/lib/platform-actor";
import { auditPlatformGlobalInTx, auditPlatformInTx, type PlatformActorRef } from "@/lib/audit";
import { SAAS_PLANS_TAG, tags, tenantEntitlementTags } from "@/lib/cache-tags";
import { toARDateKey } from "@/lib/datetime-ar";
import { runTeamTx, type TeamActorCtx } from "@/lib/team-internal";
import {
  applyPlanChangeInTx,
  previewPlanChangeInTx,
  PlanChangeRaceError,
  type PlanChangePreview,
} from "@/lib/saas-plan-change-internal";
import {
  notifyPaymentReceived,
  notifyPaymentRejected,
  readLedger,
  recordPaymentInTx,
  reviewPaymentInTx,
  schedulePlanPriceInTx,
  ensureSubscriptionInTx,
  setChargeStatusInTx,
  setCustomPriceInTx,
} from "@/lib/saas-billing-internal";
import { addAdjustmentInTx } from "@/lib/saas-adjustments-internal";
import { cancelPendingPlanInTx, undoCancelInTx } from "@/lib/saas-billing-schedule-internal";
import { applyReanchorInTx, planReanchorInTx, type ReanchorRow } from "@/lib/saas-reanchor-internal";
import { syncSaasMpAfterCommit } from "@/lib/saas-mp-sync-internal";
import { getPreapproval, saasMpEnabled } from "@/lib/mercadopago-saas";
import { maskEmail } from "@/lib/email/transport";
import { parsePaymentForm, readReceiptFile, removeReceipt, signReceipt, uploadReceipt } from "@/lib/saas-receipts-internal";
import {
  arMidnight,
  balanceCents,
  chargeAmountFor,
  isDateKey,
  isOverdue,
  keyFromDbDate,
  type ChargeForBalance,
} from "@/lib/saas-billing-logic";
import { PLAN_DEFAULTS, SAAS_PLANS } from "@/lib/saas-plans-logic";
import {
  BILLING_COPY,
  PLAN_CHANGE_COPY,
  type AddAdjustmentData,
  type PlanChangeActionResult,
  type PlatformMpSubscriptionStatus,
} from "@/lib/saas-billing-types";
import type {
  PlatformAccountRow,
  PlatformAccountsFilter,
  PlatformAccountsPage,
  PlatformPlanPriceRow,
  PlatformPriceHistoryRow,
  PlatformReanchorPreview,
  PlatformReanchorResult,
  PlatformSubscriptionActionResult,
  PlatformTenantLedger,
  SetAutoDebitAllowedData,
} from "@/lib/platform-billing-types";
import type { ActionResult } from "@/lib/validation";

const SAAS_PLAN = z.enum(["INDIVIDUAL", "CONSULTORIO", "CLINICA", "LIBRE"]);
const ID = z.string().min(1).max(64);
const NOTE = z.string().trim().max(500).optional().nullable();
const PAGE = 50;
/**
 * Tope de un precio (centavos) = el máximo de un `INTEGER` de Postgres (`amountCents`, `priceCents`,
 * `customPriceCents`): ~$ 21.474.836 por mes. PL-Z a1#6: el tope anterior (10.000.000.000) pasaba zod y reventaba
 * en la base con un 22003 opaco (o generaba un cargo que no entraba en la columna).
 */
const MAX_PRICE_CENTS = 2_147_483_647;

function refOf(a: PlatformActor): PlatformActorRef {
  return { userId: a.userId, email: a.email, homeTenantId: a.homeTenantId };
}

function invalid(error = "Datos inválidos"): { ok: false; error: string } {
  return { ok: false, error };
}

function revalidateBilling(tenantId?: string): void {
  revalidatePath("/plataforma/facturacion");
  if (tenantId) revalidatePath(`/plataforma/consultorios/${tenantId}`);
}

// ── Lecturas ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Cuentas con su estado contable. Filtros: con deuda, comprobantes a revisar, vencidas; búsqueda por nombre/slug. */
export async function listAccounts(filter: PlatformAccountsFilter = {}): Promise<PlatformAccountsPage> {
  await requirePlatformAdmin("billing.read");
  const f = z
    .object({
      view: z.enum(["all", "debt", "to_review", "past_due"]).optional(),
      q: z.string().trim().max(100).optional(),
      cursor: ID.optional().nullable(),
      plan: SAAS_PLAN.optional(),
      subscriptionStatus: z.enum(["TRIALING", "ACTIVE", "PAST_DUE", "CANCELLED"]).optional(),
    })
    .strict()
    .safeParse(filter ?? {});
  const view = f.success ? f.data.view ?? "all" : "all";
  const q = f.success ? f.data.q : undefined;
  const cursor = f.success ? f.data.cursor ?? null : null;
  const now = new Date();
  const todayKey = toARDateKey(now);

  const where: Prisma.TenantWhereInput = {
    ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { slug: { contains: q, mode: "insensitive" } }] } : {}),
    // PL-3: plan y estado en el server (antes se filtraban sobre la página de 50 en el cliente y una página podía
    // venir corta). Van antes de la vista: `past_due` pisa el estado elegido.
    ...(f.success && f.data.plan ? { saasPlan: f.data.plan } : {}),
    ...(f.success && f.data.subscriptionStatus ? { subscriptionStatus: f.data.subscriptionStatus } : {}),
    ...(view === "debt" ? { saasCharges: { some: { status: "OPEN" } } } : {}),
    ...(view === "to_review" ? { saasPayments: { some: { status: "PENDING_REVIEW" } } } : {}),
    ...(view === "past_due" ? { subscriptionStatus: "PAST_DUE" } : {}),
  };
  const tenants = await prismaService.tenant.findMany({
    where,
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: PAGE + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      name: true,
      slug: true,
      status: true,
      saasPlan: true,
      subscriptionStatus: true,
      saasSubscription: { select: { customPriceCents: true, nextChargeAt: true } },
    },
  });
  const page = tenants.slice(0, PAGE);
  const ids = page.map((t) => t.id);
  const [charges, approvedByCharge, credits, pending, lastPayments, prices] = await Promise.all([
    prismaService.saasCharge.findMany({
      where: { tenantId: { in: ids }, status: "OPEN" },
      select: { id: true, tenantId: true, status: true, amountCents: true, dueDate: true },
    }),
    prismaService.saasPayment.groupBy({
      by: ["chargeId"],
      where: { tenantId: { in: ids }, status: "APPROVED", chargeId: { not: null }, charge: { status: "OPEN" } },
      _sum: { amountCents: true },
    }),
    prismaService.saasPayment.groupBy({
      by: ["tenantId"],
      where: { tenantId: { in: ids }, status: "APPROVED", chargeId: null },
      _sum: { amountCents: true },
    }),
    prismaService.saasPayment.groupBy({
      by: ["tenantId"],
      where: { tenantId: { in: ids }, status: "PENDING_REVIEW" },
      _count: { _all: true },
    }),
    prismaService.saasPayment.groupBy({
      by: ["tenantId"],
      where: { tenantId: { in: ids }, status: "APPROVED" },
      _max: { paidAt: true },
    }),
    prismaService.saasPlanConfig.findMany({ select: { plan: true, priceCents: true } }),
  ]);
  const paidOf = new Map(approvedByCharge.map((a) => [a.chargeId, a._sum.amountCents ?? 0]));
  const priceOf = new Map(prices.map((p) => [p.plan, p.priceCents]));
  const rows: PlatformAccountRow[] = page.map((t) => {
    const mine: ChargeForBalance[] = charges
      .filter((c) => c.tenantId === t.id)
      .map((c) => ({ status: c.status, amountCents: c.amountCents, approvedCents: paidOf.get(c.id) ?? 0, dueDate: keyFromDbDate(c.dueDate) }));
    const credit = credits.find((c) => c.tenantId === t.id)?._sum.amountCents ?? 0;
    const custom = t.saasSubscription?.customPriceCents ?? null;
    return {
      tenantId: t.id,
      name: t.name,
      slug: t.slug,
      status: t.status,
      saasPlan: t.saasPlan,
      subscriptionStatus: t.subscriptionStatus,
      customPriceCents: custom,
      effectivePriceCents: chargeAmountFor({ customPriceCents: custom, planPriceCents: priceOf.get(t.saasPlan) ?? PLAN_DEFAULTS[t.saasPlan].priceCents }),
      balanceCents: balanceCents(mine, credit),
      openCharges: mine.length,
      overdueCharges: mine.filter((c) => isOverdue(c, todayKey)).length,
      pendingReviews: pending.find((p) => p.tenantId === t.id)?._count._all ?? 0,
      nextChargeOn: t.saasSubscription?.nextChargeAt ? toARDateKey(t.saasSubscription.nextChargeAt) : null,
      lastPaymentAt: lastPayments.find((p) => p.tenantId === t.id)?._max.paidAt?.toISOString() ?? null,
    };
  });
  return { rows, nextCursor: tenants.length > PAGE ? page[page.length - 1].id : null };
}

/** Ledger de un consultorio: suscripción, cargos, pagos y saldo. */
export async function getTenantLedger(tenantId: unknown): Promise<PlatformTenantLedger | null> {
  await requirePlatformAdmin("billing.read");
  const id = ID.safeParse(tenantId);
  if (!id.success) return null;
  const t = await prismaService.tenant.findUnique({
    where: { id: id.data },
    select: { name: true, slug: true, status: true, updatedAt: true },
  });
  if (!t) return null;
  const ledger = await readLedger(prismaService, id.data, new Date());
  if (!ledger) return null;
  return { ...ledger, tenantName: t.name, tenantSlug: t.slug, tenantStatus: t.status, tenantUpdatedAt: t.updatedAt.toISOString() };
}

/** URL firmada (60 s) de un comprobante (Plataforma lo abre para revisarlo). */
export async function getPlatformReceiptUrl(paymentId: unknown): Promise<ActionResult<{ url: string }>> {
  await requirePlatformAdmin("billing.read");
  const id = ID.safeParse(paymentId);
  if (!id.success) return invalid(BILLING_COPY.paymentNotFound);
  const row = await prismaService.saasPayment.findUnique({ where: { id: id.data }, select: { receiptPath: true } });
  if (!row) return invalid(BILLING_COPY.paymentNotFound);
  if (!row.receiptPath) return invalid(BILLING_COPY.noReceipt);
  const signed = await signReceipt(row.receiptPath);
  return signed.ok ? { ok: true, data: { url: signed.url } } : invalid(signed.error);
}

// ── Pagos ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Imputar un pago manual CON recibo (decisión de Martin): queda APPROVED, se imputa al cargo elegido (la UI sugiere el
 * último impago; sin cargo queda a cuenta y se aplica a los pendientes del más viejo) y recalcula el estado. FormData:
 * `tenantId`, `file`, `amount` (obligatorio), `method` (obligatorio, PL-F1a: va a la columna), `chargeId?`,
 * `paidOn?`, `note?`. El archivo se valida (tamaño + magic bytes) ANTES de Storage.
 */
export async function recordManualPayment(form: FormData): Promise<ActionResult<{ paymentId: string }>> {
  const actor = await requirePlatformAdmin("billing.write");
  const now = new Date();
  const tenantId = ID.safeParse(form.get("tenantId"));
  if (!tenantId.success) return invalid();
  const parsed = parsePaymentForm(form, now);
  if (!parsed.ok) return { ok: false, error: parsed.error, fieldErrors: { [parsed.field]: [parsed.error] } };
  const f = parsed.data;
  if (f.amountCents === null) return { ok: false, error: BILLING_COPY.amountInvalid, fieldErrors: { amount: [BILLING_COPY.amountInvalid] } };
  if (!f.file) return { ok: false, error: BILLING_COPY.receiptRequired, fieldErrors: { file: [BILLING_COPY.receiptRequired] } };
  const receipt = await readReceiptFile(f.file);
  if (!receipt.ok) return { ok: false, error: receipt.error, fieldErrors: { file: [receipt.error] } };
  const exists = await prismaService.tenant.findUnique({ where: { id: tenantId.data }, select: { id: true } });
  if (!exists) return invalid("No encontramos el consultorio.");

  const paymentId = randomUUID();
  const up = await uploadReceipt({ tenantId: tenantId.data, paymentId, ext: receipt.ext, bytes: receipt.bytes, mimeType: receipt.mimeType });
  if (!up.ok) return invalid(up.error);
  let r;
  try {
    r = await prismaService.$transaction(async (tx) => {
      const res = await recordPaymentInTx(tx, {
        id: paymentId,
        tenantId: tenantId.data,
        chargeId: f.chargeId,
        amountCents: f.amountCents!,
        status: "APPROVED",
        paidAt: f.paidAt,
        receipt: { path: up.path, mimeType: receipt.mimeType, sizeBytes: receipt.sizeBytes },
        note: f.note,
        method: f.method,
        submittedById: actor.userId,
        reviewedById: actor.userId,
        now,
      });
      if (res.ok) {
        await auditPlatformInTx(tx, {
          actor: refOf(actor),
          affectedTenantId: tenantId.data,
          action: "platform.billing.payment.recorded",
          entity: "SaasPayment",
          entityId: paymentId,
          payload: { amountCents: f.amountCents, method: f.method, chargeId: res.chargeId, chargePaid: res.chargePaid, statusChanged: res.statusChanged },
        });
      }
      return res;
    });
  } catch (err) {
    await removeReceipt(up.path);
    throw err;
  }
  if (!r.ok) {
    await removeReceipt(up.path);
    return invalid(r.reason === "charge_not_open" ? BILLING_COPY.chargeNotOpen : r.reason === "amount_invalid" ? BILLING_COPY.amountInvalid : BILLING_COPY.chargeNotFound);
  }
  if (r.statusChanged) for (const t of tenantEntitlementTags(tenantId.data)) revalidateTag(t);
  revalidateBilling(tenantId.data);
  await notifyPaymentReceived(tenantId.data, paymentId, f.amountCents);
  return { ok: true, data: { paymentId } };
}

const ReviewInput = z
  .object({
    paymentId: ID,
    decision: z.enum(["approve", "reject"]),
    reason: NOTE,
    chargeId: ID.optional().nullable(),
  })
  .strict();

/** Aprobar (imputa y recalcula) o rechazar con motivo un comprobante `PENDING_REVIEW`. */
export async function reviewPayment(raw: unknown): Promise<ActionResult<{ chargePaid: boolean }>> {
  const actor = await requirePlatformAdmin("billing.write");
  const parsed = ReviewInput.safeParse(raw);
  if (!parsed.success) return invalid();
  const { paymentId, decision, reason, chargeId } = parsed.data;
  const pay = await prismaService.saasPayment.findUnique({ where: { id: paymentId }, select: { tenantId: true } });
  if (!pay) return invalid(BILLING_COPY.paymentNotFound);
  const now = new Date();
  const r = await prismaService.$transaction(async (tx) => {
    const res = await reviewPaymentInTx(tx, {
      tenantId: pay.tenantId,
      paymentId,
      decision,
      reviewNote: reason ?? null,
      chargeId: chargeId ?? null,
      reviewerId: actor.userId,
      now,
    });
    if (res.ok) {
      await auditPlatformInTx(tx, {
        actor: refOf(actor),
        affectedTenantId: pay.tenantId,
        action: decision === "approve" ? "platform.billing.payment.approved" : "platform.billing.payment.rejected",
        entity: "SaasPayment",
        entityId: paymentId,
        payload: { amountCents: res.amountCents, chargeId: res.chargeId, chargePaid: res.chargePaid, statusChanged: res.statusChanged },
      });
    }
    return res;
  });
  if (!r.ok) {
    const copy = {
      not_found: BILLING_COPY.paymentNotFound,
      already_reviewed: BILLING_COPY.alreadyReviewed,
      reason_required: BILLING_COPY.reasonRequired,
      charge_not_found: BILLING_COPY.chargeNotFound,
    } as const;
    return invalid(copy[r.reason]);
  }
  if (r.statusChanged) for (const t of tenantEntitlementTags(pay.tenantId)) revalidateTag(t);
  revalidateBilling(pay.tenantId);
  if (r.decision === "approve") await notifyPaymentReceived(pay.tenantId, paymentId, r.amountCents);
  else await notifyPaymentRejected(pay.tenantId, paymentId, r.amountCents, (reason ?? "").trim());
  return { ok: true, data: { chargePaid: r.chargePaid } };
}

const ChargeInput = z.object({ chargeId: ID, note: NOTE }).strict();

async function changeCharge(actor: PlatformActor, raw: unknown, to: "VOID" | "WAIVED"): Promise<ActionResult> {
  const parsed = ChargeInput.safeParse(raw);
  if (!parsed.success) return invalid();
  const charge = await prismaService.saasCharge.findUnique({ where: { id: parsed.data.chargeId }, select: { tenantId: true } });
  if (!charge) return invalid(BILLING_COPY.chargeNotFound);
  const now = new Date();
  const r = await prismaService.$transaction(async (tx) => {
    const res = await setChargeStatusInTx(tx, {
      tenantId: charge.tenantId,
      chargeId: parsed.data.chargeId,
      to,
      note: parsed.data.note ?? null,
      actorId: actor.userId,
      now,
    });
    if (res.ok) {
      await auditPlatformInTx(tx, {
        actor: refOf(actor),
        affectedTenantId: charge.tenantId,
        action: to === "VOID" ? "platform.billing.charge.voided" : "platform.billing.charge.waived",
        entity: "SaasCharge",
        entityId: parsed.data.chargeId,
        payload: { statusChanged: res.statusChanged },
      });
    }
    return res;
  });
  if (!r.ok) {
    return invalid(r.reason === "has_payments" ? BILLING_COPY.hasPayments : r.reason === "charge_not_open" ? BILLING_COPY.chargeNotOpen : BILLING_COPY.chargeNotFound);
  }
  if (r.statusChanged) for (const t of tenantEntitlementTags(charge.tenantId)) revalidateTag(t);
  revalidateBilling(charge.tenantId);
  return { ok: true, data: undefined };
}

/** Anular un cargo que no correspondía (sin pagos aprobados). */
export async function voidCharge(raw: unknown): Promise<ActionResult> {
  const actor = await requirePlatformAdmin("billing.write");
  return changeCharge(actor, raw, "VOID");
}

/** Condonar lo que falta de un cargo. */
export async function waiveCharge(raw: unknown): Promise<ActionResult> {
  const actor = await requirePlatformAdmin("billing.write");
  return changeCharge(actor, raw, "WAIVED");
}

// ── Precios ─────────────────────────────────────────────────────────────────────────────────────────────────────

const PRICE = z.number().int().min(0).max(MAX_PRICE_CENTS);

const CustomPriceInput = z.object({ tenantId: ID, priceCents: PRICE.nullable(), plan: SAAS_PLAN.optional() }).strict();

/**
 * Precio a medida del consultorio (centavos; null = el del plan). Rige desde el próximo cargo. MPS-D14: queda ATADO a
 * un plan (`customPricePlan`): si el consultorio sube o baja, paga el precio del plan nuevo (un descuento de
 * Consultorio no viaja a Clínica). Sin `plan` se ata al plan ACTUAL del consultorio: guardar desde Plataforma es lo
 * que convierte un precio legado (sin plan, vale para cualquiera) en uno atado. Acepta la forma posicional de PL-2b
 * (`tenantId, priceCents, plan?`, la usa la UI actual) y la de C-MPS11 (`SetCustomPriceInput`).
 * Después del commit, el sync lleva el monto del débito al precio nuevo (fuera de la tx: MP nunca adentro).
 */
export async function setCustomPrice(tenantIdOrInput: unknown, priceCents?: unknown, plan?: unknown): Promise<ActionResult> {
  const actor = await requirePlatformAdmin("billing.price");
  const raw =
    tenantIdOrInput && typeof tenantIdOrInput === "object"
      ? tenantIdOrInput
      : { tenantId: tenantIdOrInput, priceCents, ...(plan === undefined || plan === null ? {} : { plan }) };
  const parsed = CustomPriceInput.safeParse(raw);
  if (!parsed.success) return invalid();
  const { tenantId: id, priceCents: price } = parsed.data;
  const now = new Date();
  const r = await prismaService.$transaction(async (tx) => {
    // Lock Tenant → Subscription antes de leer el plan anterior (setCustomPriceInTx vuelve a pedirlos: misma tx).
    const sub = await ensureSubscriptionInTx(tx, id, now);
    if (!sub) return { ok: false as const, reason: "not_found" as const };
    const t = await tx.tenant.findUniqueOrThrow({ where: { id }, select: { saasPlan: true } });
    const planAfter = price === null ? null : parsed.data.plan ?? t.saasPlan;
    const res = await setCustomPriceInTx(tx, { tenantId: id, priceCents: price, plan: planAfter, now });
    if (res.ok && (res.before !== res.after || sub.customPricePlan !== planAfter)) {
      await auditPlatformInTx(tx, {
        actor: refOf(actor),
        affectedTenantId: id,
        action: "platform.billing.custom_price",
        entity: "SaasSubscription",
        entityId: id,
        payload: { before: res.before, after: res.after, planBefore: sub.customPricePlan, planAfter },
      });
    }
    return res;
  });
  if (!r.ok) return invalid(r.reason === "not_found" ? "No encontramos el consultorio." : "Precio inválido.");
  revalidateBilling(id);
  await syncSaasMpAfterCommit(id);
  return { ok: true, data: undefined };
}

const PlanPriceInput = z
  .object({
    plan: SAAS_PLAN,
    priceCents: PRICE.nullable(),
    /** Día AR desde el que rige («YYYY-MM-DD»). Hoy o antes = ya. */
    effectiveFrom: z.string().refine(isDateKey, "Fecha inválida"),
    note: NOTE,
  })
  .strict();

/**
 * Precio de lista con vigencia (PL-D8): siempre queda en el historial; si la fecha es hoy o anterior se aplica ya,
 * si no, lo aplica el cron diario. Revalida el catálogo público (`SAAS_PLANS_TAG`) si se aplicó.
 */
export async function updatePlanPrice(raw: unknown): Promise<ActionResult<{ changeId: string; appliedNow: boolean }>> {
  const actor = await requirePlatformAdmin("billing.price");
  const parsed = PlanPriceInput.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(parsed.error.flatten().fieldErrors)) if (v) fieldErrors[k] = v;
    return { ok: false, error: "Datos inválidos", fieldErrors };
  }
  const { plan, priceCents, effectiveFrom, note } = parsed.data;
  const now = new Date();
  const r = await prismaService.$transaction(async (tx) => {
    const res = await schedulePlanPriceInTx(tx, {
      plan,
      priceCents,
      effectiveFrom: arMidnight(effectiveFrom),
      note: note ?? null,
      actorId: actor.userId,
      now,
    });
    await auditPlatformGlobalInTx(tx, {
      actor: refOf(actor),
      action: "platform.billing.plan_price",
      entity: "SaasPlanPriceChange",
      entityId: res.changeId,
      payload: { plan, priceCents, previousPriceCents: res.previousPriceCents, effectiveFrom, appliedNow: res.appliedNow },
    });
    return res;
  });
  if (r.appliedNow) revalidateTag(SAAS_PLANS_TAG);
  revalidatePath("/plataforma/precios");
  return { ok: true, data: { changeId: r.changeId, appliedNow: r.appliedNow } };
}

/** Historial de precios de un plan (o de todos), el más nuevo primero. */
export async function listPriceHistory(plan?: unknown): Promise<PlatformPriceHistoryRow[]> {
  await requirePlatformAdmin("billing.read");
  const p = plan === undefined || plan === null ? null : SAAS_PLAN.safeParse(plan);
  if (p && !p.success) return [];
  const rows = await prismaService.saasPlanPriceChange.findMany({
    where: p ? { plan: p.data } : {},
    orderBy: [{ createdAt: "desc" }],
    take: 100,
  });
  const ids = [...new Set(rows.map((r) => r.createdById).filter((x): x is string => !!x))];
  const emails = ids.length
    ? new Map((await prismaService.userProfile.findMany({ where: { id: { in: ids } }, select: { id: true, email: true } })).map((u) => [u.id, u.email]))
    : new Map<string, string>();
  return rows.map((r) => ({
    id: r.id,
    plan: r.plan,
    priceCents: r.priceCents,
    previousPriceCents: r.previousPriceCents,
    effectiveFrom: toARDateKey(r.effectiveFrom),
    appliedAt: r.appliedAt?.toISOString() ?? null,
    note: r.note,
    createdAt: r.createdAt.toISOString(),
    createdByEmail: r.createdById ? emails.get(r.createdById) ?? null : null,
  }));
}

/** Precios de lista vigentes + el próximo cambio pendiente de cada plan (editor de /plataforma/precios). */
export async function listPlanPrices(): Promise<PlatformPlanPriceRow[]> {
  await requirePlatformAdmin("billing.read");
  const [cfg, pending] = await Promise.all([
    prismaService.saasPlanConfig.findMany({ select: { plan: true, label: true, priceCents: true } }),
    prismaService.saasPlanPriceChange.findMany({
      where: { appliedAt: null },
      orderBy: [{ effectiveFrom: "asc" }],
      select: { plan: true, priceCents: true, effectiveFrom: true },
    }),
  ]);
  return SAAS_PLANS.map((plan) => {
    const c = cfg.find((x) => x.plan === plan);
    const next = pending.find((x) => x.plan === plan);
    return {
      plan,
      label: c?.label ?? PLAN_DEFAULTS[plan].label,
      priceCents: c ? c.priceCents : PLAN_DEFAULTS[plan].priceCents,
      pending: next ? { priceCents: next.priceCents, effectiveFrom: toARDateKey(next.effectiveFrom) } : null,
    };
  });
}

// ── Cambio de plan ──────────────────────────────────────────────────────────────────────────────────────────────

function platformCtx(actor: PlatformActor, tenantId: string): TeamActorCtx {
  return { via: "platform", tenantId, actorUserId: actor.userId, actorRole: "SUPERADMIN", actorRef: refOf(actor) };
}

/** Lo que pasaría al cambiar el plan de un consultorio (mismo núcleo que el consultorio; Libre incluido). */
export async function platformPreviewPlanChange(tenantId: unknown, to: unknown): Promise<ActionResult<PlanChangePreview>> {
  const actor = await requirePlatformAdmin("billing.read");
  const id = ID.safeParse(tenantId);
  const plan = SAAS_PLAN.safeParse(to);
  if (!id.success || !plan.success) return invalid();
  const preview = await runTeamTx(platformCtx(actor, id.data), (tx) =>
    // CT-INT (fix M): Plataforma sí puede elegir al co-titular (D1: lo gestionan el principal y Plataforma).
    previewPlanChangeInTx(tx, { tenantId: id.data, to: plan.data, now: new Date(), actorUserId: actor.userId, via: "platform" })
  );
  return preview ? { ok: true, data: preview } : invalid(PLAN_CHANGE_COPY.not_found);
}

const PlatformApplyInput = z
  .object({
    tenantId: ID,
    to: SAAS_PLAN,
    disableMembershipIds: z.array(ID).max(500),
    reactivateMembershipIds: z.array(ID).max(500),
    expectedUpdatedAt: z.string().datetime(),
  })
  .strict();

/**
 * Cambiar el plan desde Plataforma (source `platform`, audit doble del núcleo). Libre permitido. MPS-D20: sigue
 * INMEDIATO y SIN proporcional automático (no pasa por `planChangeKind` ni `addUpgradeProrationInTx` como la subida
 * del consultorio): Plataforma cambia el plan por acuerdo, negociación o corrección, y si corresponde cobrar o
 * bonificar la diferencia lo carga a mano con `addAdjustment`. El débito se re-sincroniza después del commit (el
 * monto del próximo 4 es la base del plan nuevo).
 */
export async function platformApplyPlanChange(raw: unknown): Promise<PlanChangeActionResult> {
  const actor = await requirePlatformAdmin("tenant.plan.change");
  const parsed = PlatformApplyInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: PLAN_CHANGE_COPY.invalid_input, reason: "invalid_input" };
  const d = parsed.data;
  const ctx = platformCtx(actor, d.tenantId);
  let res;
  try {
    res = await runTeamTx(ctx, (tx) =>
      applyPlanChangeInTx(tx, {
        tenantId: d.tenantId,
        to: d.to,
        disableMembershipIds: d.disableMembershipIds,
        reactivateMembershipIds: d.reactivateMembershipIds,
        expectedUpdatedAt: new Date(d.expectedUpdatedAt),
        ctx,
        now: new Date(),
      })
    );
  } catch (err) {
    if (err instanceof PlanChangeRaceError) return { ok: false, error: PLAN_CHANGE_COPY.stale, reason: "stale" };
    throw err;
  }
  if (!res.ok) return { ok: false, error: PLAN_CHANGE_COPY[res.reason], reason: res.reason, detail: res.detail };
  for (const t of tenantEntitlementTags(d.tenantId)) revalidateTag(t);
  revalidateTag(tags.practitioners(d.tenantId));
  revalidateBilling(d.tenantId);
  await syncSaasMpAfterCommit(d.tenantId);
  return { ok: true, data: { disabled: res.disabled, reactivated: res.reactivated, revokedInvites: res.revokedInvites } };
}


// ── Suscripción con Mercado Pago (MPS-3b, C-MPS11) ──────────────────────────────────────────────────────────────
//
// Claves (sin claves nuevas en PLATFORM_ACTION_POLICY: se reusa la clasificación existente, que ya decide el
// step-up): `billing.read` (estado en vivo, preview del re-anclaje), `billing.write` (permitir/bloquear el débito,
// ajustes, re-anclar, deshacer la baja: tocan plata o el cobro y son `high`) y `tenant.plan.change` (anular la bajada
// programada: es un cambio de plan, el mismo peso que `platformApplyPlanChange`). Todas por el canal service:
// `SaasSubscription`/`SaasAdjustment` son TENANT_READONLY. MP nunca adentro de una tx: el sync va después del commit.

const SUB_COPY = {
  not_found: "No encontramos el consultorio.",
  no_subscription: "Este consultorio todavía no tiene suscripción.",
  not_cancel_pending: "El consultorio no tiene una baja programada.",
  stale: "La baja rige hoy: ya no se puede deshacer. Reactivá la suscripción.",
  no_pending_plan: "El consultorio no tiene una bajada de plan programada.",
  mp_unavailable: "No pudimos consultar Mercado Pago. Probá de nuevo en un rato.",
} as const;

function subFail<T>(reason: keyof typeof SUB_COPY): PlatformSubscriptionActionResult<T> {
  return { ok: false, error: SUB_COPY[reason], reason };
}

const TenantOnly = z.object({ tenantId: ID }).strict();

const AutoDebitAllowedInput = z.object({ tenantId: ID, allowed: z.boolean() }).strict();

/**
 * Permitir o bloquear el débito automático de un consultorio (MPS-D24: permitido por defecto). Bloquear NO toca el
 * método elegido: `desiredDebit` da `cancelled/not_allowed` y el sync, DESPUÉS del commit, cancela en MP el
 * preapproval vigente y el pendiente (si MP no contesta, la conciliación diaria lo reintenta: la fila ya dice
 * «bloqueado»). Volver a permitirlo no revive nada (`cancelled` es terminal en MP): el titular lo autoriza de nuevo.
 */
export async function setAutoDebitAllowed(raw: unknown): Promise<PlatformSubscriptionActionResult<SetAutoDebitAllowedData>> {
  const actor = await requirePlatformAdmin("billing.write");
  const parsed = AutoDebitAllowedInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Datos inválidos", reason: "invalid_input" };
  const { tenantId, allowed } = parsed.data;
  const now = new Date();
  const r = await prismaService.$transaction(async (tx) => {
    const sub = await ensureSubscriptionInTx(tx, tenantId, now);
    if (!sub) return null;
    const cur = await tx.saasSubscription.findUniqueOrThrow({ where: { tenantId }, select: { autoDebitAllowed: true } });
    if (cur.autoDebitAllowed === allowed) return { changed: false };
    await tx.saasSubscription.update({ where: { tenantId }, data: { autoDebitAllowed: allowed } });
    await auditPlatformInTx(tx, {
      actor: refOf(actor),
      affectedTenantId: tenantId,
      action: "platform.billing.auto_debit_allowed",
      entity: "SaasSubscription",
      entityId: tenantId,
      payload: { before: cur.autoDebitAllowed, after: allowed },
    });
    return { changed: true };
  });
  if (!r) return subFail("not_found");
  revalidateBilling(tenantId);
  if (r.changed && !allowed) await syncSaasMpAfterCommit(tenantId);
  return { ok: true, data: { autoDebitAllowed: allowed, changed: r.changed } };
}

const AdjustmentInput = z
  .object({
    tenantId: ID,
    kind: z.enum(["CREDIT", "DEBIT"]),
    /** POSITIVO: el signo lo pone el tipo (CREDIT → negativo, CHECK de M16). */
    amountCents: z.number().int().min(1).max(MAX_PRICE_CENTS),
    effectiveOn: z.string().refine(isDateKey, "Fecha inválida").optional(),
    description: z.string().trim().min(1).max(300),
    idempotencyKey: z.string().uuid(),
  })
  .strict();

/**
 * Crédito o débito manual (C-MPS11). Entra en el próximo cargo (`composeCharge`: un crédito nunca deja el cargo en
 * negativo; lo que sobra pasa al siguiente). Sin fecha rige desde el PRÓXIMO COBRO guardado (`nextChargeAt`) y no
 * desde hoy: con el cron atrasado (cobro de ayer todavía sin cargo) «hoy» quedaría fuera de ese cargo, que es el que
 * Plataforma quiso tocar. Idempotente por `idempotencyKey` (UUID por instancia del diálogo, UNIQUE de M16): un
 * doble clic devuelve el mismo ajuste y no audita dos veces. La descripción la ve el consultorio; no va al audit.
 */
export async function addAdjustment(raw: unknown): Promise<PlatformSubscriptionActionResult<AddAdjustmentData>> {
  const actor = await requirePlatformAdmin("billing.write");
  const parsed = AdjustmentInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Datos inválidos", reason: "invalid_input" };
  const d = parsed.data;
  const now = new Date();
  const r = await prismaService.$transaction(async (tx) => {
    const sub = await ensureSubscriptionInTx(tx, d.tenantId, now);
    if (!sub) return null;
    const effectiveOn = d.effectiveOn ?? (sub.nextChargeAt ? toARDateKey(sub.nextChargeAt) : toARDateKey(now));
    const amountCents = d.kind === "CREDIT" ? -d.amountCents : d.amountCents;
    const res = await addAdjustmentInTx(tx, {
      tenantId: d.tenantId,
      kind: d.kind,
      amountCents,
      effectiveOn,
      description: d.description,
      idempotencyKey: `platform:${d.idempotencyKey}`,
      createdById: actor.userId,
    });
    if (res.created) {
      await auditPlatformInTx(tx, {
        actor: refOf(actor),
        affectedTenantId: d.tenantId,
        action: "platform.billing.adjustment.added",
        entity: "SaasAdjustment",
        entityId: res.adjustmentId,
        payload: { kind: d.kind, amountCents, effectiveOn },
      });
    }
    return res;
  });
  if (!r) return subFail("not_found");
  revalidateBilling(d.tenantId);
  return { ok: true, data: r };
}

/**
 * Foto del débito: lo guardado + un GET EN VIVO del preapproval por el puerto (fuera de cualquier tx; con el cobro
 * por MP apagado no se llama y `liveStatus` queda null). Nunca datos de tarjeta: el puerto no los mapea y el email del
 * pagador sale enmascarado (es dato del titular, no viaja completo al cliente). `drift` = MP dice otro estado o monto
 * que lo guardado: lo corrige la conciliación diaria (no se compara contra `desiredDebit`, que necesita la proyección
 * del cargo y es del sync).
 */
export async function getMpSubscriptionStatus(raw: unknown): Promise<PlatformSubscriptionActionResult<PlatformMpSubscriptionStatus>> {
  await requirePlatformAdmin("billing.read");
  const parsed = TenantOnly.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Datos inválidos", reason: "invalid_input" };
  const tenantId = parsed.data.tenantId;
  const sub = await prismaService.saasSubscription.findUnique({
    where: { tenantId },
    select: {
      collectionMethod: true,
      autoDebitAllowed: true,
      autoDebitEnabled: true,
      mpPreapprovalId: true,
      mpPreapprovalStatus: true,
      mpPayerEmail: true,
      mpPreapprovalAmountCents: true,
      mpPreapprovalNextAt: true,
      mpPreapprovalSyncedAt: true,
      mpPendingPreapprovalId: true,
      mpPendingCreatedAt: true,
      mpRetiredPreapprovalId: true,
    },
  });
  if (!sub) {
    const exists = await prismaService.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    return subFail(exists ? "no_subscription" : "not_found");
  }
  let liveStatus: string | null = null;
  let liveAmountCents: number | null = null;
  let liveNext: Date | null = null;
  if (sub.mpPreapprovalId && saasMpEnabled()) {
    const live = await getPreapproval(sub.mpPreapprovalId);
    if (live.ok) {
      liveStatus = live.data.status;
      liveAmountCents = live.data.amountCents;
      liveNext = live.data.nextPaymentDate;
    }
  }
  const drift =
    liveStatus !== null &&
    (liveStatus !== sub.mpPreapprovalStatus || (liveAmountCents !== null && liveAmountCents !== sub.mpPreapprovalAmountCents));
  const nextDebit = liveNext ?? sub.mpPreapprovalNextAt;
  return {
    ok: true,
    data: {
      tenantId,
      collectionMethod: sub.collectionMethod,
      autoDebitAllowed: sub.autoDebitAllowed,
      autoDebitEnabled: sub.autoDebitEnabled,
      preapprovalId: sub.mpPreapprovalId,
      storedStatus: sub.mpPreapprovalStatus,
      liveStatus,
      payerEmailMasked: sub.mpPayerEmail ? maskEmail(sub.mpPayerEmail) : null,
      amountCents: sub.mpPreapprovalAmountCents,
      liveAmountCents,
      nextDebitAt: nextDebit ? nextDebit.toISOString() : null,
      syncedAt: sub.mpPreapprovalSyncedAt?.toISOString() ?? null,
      pendingPreapprovalId: sub.mpPendingPreapprovalId,
      pendingCreatedAt: sub.mpPendingCreatedAt?.toISOString() ?? null,
      retiredPreapprovalId: sub.mpRetiredPreapprovalId,
      drift,
    },
  };
}

/** Fila del núcleo de re-anclaje → DTO de Plataforma (sin el nombre del consultorio: la pantalla ya lo tiene). */
function reanchorPreviewOf(row: ReanchorRow): PlatformReanchorPreview {
  return {
    tenantId: row.tenantId,
    fromAnchorDay: row.oldAnchorDay,
    toAnchorDay: row.newAnchorDay,
    stubFrom: row.billableFrom,
    stubTo: row.newNextChargeOn,
    stubCents: row.stub?.amountCents ?? 0,
    days: row.stub?.days ?? 0,
    periodDays: row.stub?.periodDays ?? 0,
    noop: row.action === "skip",
    oldNextChargeOn: row.oldNextChargeOn,
    newNextChargeOn: row.newNextChargeOn,
    hasCharges: row.hasCharges,
    // ZF1: sin `reenablesAutoDebit`. Re-anclar ya no toca el bloqueo del débito (lo conserva el núcleo), así que no
    // hay nada que avisar.
  };
}

/** «Re-anclar al 4» (MPS-D7), solo lectura: lo que haría `applyReanchor` con este consultorio. */
export async function previewReanchor(raw: unknown): Promise<PlatformSubscriptionActionResult<PlatformReanchorPreview>> {
  await requirePlatformAdmin("billing.read");
  const parsed = TenantOnly.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Datos inválidos", reason: "invalid_input" };
  const rows = await prismaService.$transaction((tx) => planReanchorInTx(tx, { now: new Date(), tenantIds: [parsed.data.tenantId] }));
  return rows.length === 1 ? { ok: true, data: reanchorPreviewOf(rows[0]) } : subFail("no_subscription");
}

/**
 * Aplica el re-anclaje de un consultorio (el mismo núcleo que `scripts/saas-reanchor.ts`, con locks Tenant →
 * Subscription y relectura adentro). Idempotente: ya anclado → `updated: false` sin audit. No toca cargos, pagos ni
 * ajustes: el tramo corto lo cobra el primer cargo como proporcional (stub). El sync del débito va después del commit
 * (la fecha del próximo débito cambia).
 */
export async function applyReanchor(raw: unknown): Promise<PlatformSubscriptionActionResult<PlatformReanchorResult>> {
  const actor = await requirePlatformAdmin("billing.write");
  const parsed = TenantOnly.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Datos inválidos", reason: "invalid_input" };
  const tenantId = parsed.data.tenantId;
  const r = await prismaService.$transaction(async (tx) => {
    const res = await applyReanchorInTx(tx, { now: new Date(), tenantIds: [tenantId] });
    const row = res.rows[0];
    if (!row) return null;
    if (res.updated > 0) {
      await auditPlatformInTx(tx, {
        actor: refOf(actor),
        affectedTenantId: tenantId,
        action: "platform.billing.reanchor",
        entity: "SaasSubscription",
        entityId: tenantId,
        payload: {
          fromAnchorDay: row.oldAnchorDay,
          toAnchorDay: row.newAnchorDay,
          oldNextChargeOn: row.oldNextChargeOn,
          newNextChargeOn: row.newNextChargeOn,
          billableFrom: row.billableFrom,
          stubCents: row.stub?.amountCents ?? 0,
          autoDebitAllowedBefore: row.oldAutoDebitAllowed,
        },
      });
    }
    return { row, updated: res.updated > 0 };
  });
  if (!r) return subFail("no_subscription");
  revalidateBilling(tenantId);
  if (r.updated) await syncSaasMpAfterCommit(tenantId);
  return { ok: true, data: { preview: reanchorPreviewOf(r.row), updated: r.updated } };
}

/**
 * «Deshacer baja» desde Plataforma (`undoCancelInTx`): solo antes del día en que rige (ese día la aplica el cron;
 * después se reactiva). Sin la regla «propia» del consultorio: Plataforma deshace cualquier baja programada. Después
 * del commit, el sync reanuda el débito (con baja programada estaba en pausa).
 */
export async function undoCancelFor(raw: unknown): Promise<PlatformSubscriptionActionResult<{ undone: boolean }>> {
  const actor = await requirePlatformAdmin("billing.write");
  const parsed = TenantOnly.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Datos inválidos", reason: "invalid_input" };
  const tenantId = parsed.data.tenantId;
  const r = await prismaService.$transaction(async (tx) => {
    const before = await tx.saasSubscription.findUnique({ where: { tenantId }, select: { cancelEffectiveOn: true } });
    const res = await undoCancelInTx(tx, { tenantId, actorUserId: actor.userId, now: new Date() });
    if (res.ok) {
      await auditPlatformInTx(tx, {
        actor: refOf(actor),
        affectedTenantId: tenantId,
        action: "platform.billing.cancel_undone",
        entity: "SaasSubscription",
        entityId: tenantId,
        payload: { cancelEffectiveOn: before?.cancelEffectiveOn ? keyFromDbDate(before.cancelEffectiveOn) : null },
      });
    }
    return res;
  });
  if (!r.ok) return subFail(r.reason === "stale" ? "stale" : r.reason === "not_cancel_pending" ? "not_cancel_pending" : "not_found");
  revalidateBilling(tenantId);
  await syncSaasMpAfterCommit(tenantId);
  return { ok: true, data: { undone: true } };
}

/**
 * «Anular bajada» desde Plataforma: limpia la bajada de plan programada (`pendingPlan*`); el consultorio sigue con su
 * plan y el cargo del próximo 4 sale con ese. El UPDATE es `cancelPendingPlanInTx` del núcleo de programación (el
 * mismo que usa el consultorio; ZF1 sacó la copia que vivía acá). Después del commit, el sync lleva el débito a la base
 * del plan que sigue.
 */
export async function cancelScheduledPlanFor(raw: unknown): Promise<PlatformSubscriptionActionResult<{ cancelled: boolean }>> {
  const actor = await requirePlatformAdmin("tenant.plan.change");
  const parsed = TenantOnly.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Datos inválidos", reason: "invalid_input" };
  const tenantId = parsed.data.tenantId;
  const r = await prismaService.$transaction(async (tx) => {
    const c = await cancelPendingPlanInTx(tx, { tenantId });
    if (!c.ok) return c.reason;
    await auditPlatformInTx(tx, {
      actor: refOf(actor),
      affectedTenantId: tenantId,
      action: "platform.billing.plan_change_cancelled",
      entity: "SaasSubscription",
      entityId: tenantId,
      payload: { pendingPlan: c.pendingPlan, effectiveOn: c.effectiveOn, disableCount: c.disableCount, requestedById: c.requestedById },
    });
    return "ok" as const;
  });
  if (r !== "ok") return subFail(r);
  revalidateBilling(tenantId);
  await syncSaasMpAfterCommit(tenantId);
  return { ok: true, data: { cancelled: true } };
}
