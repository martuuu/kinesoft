import "server-only";
/**
 * Sync de la suscripción con Mercado Pago (C-MPS8, brief §26.6; MPS-D16/D17/D21; ADR-027). Implementa MPS-2b2.
 *
 * Modelo: la base guarda el estado DESEADO (plan, método, baja, ajustes → `desiredDebit` de `lib/saas-mp-logic.ts`) y
 * MP converge a él. Este módulo es el único que mueve un preapproval o un link de pago hacia lo que dice la base:
 *   - `startPreapprovalFlow`: crea (o reusa) el preapproval PENDIENTE sin tarjeta y devuelve su `init_point`.
 *   - `refreshPendingPreapproval`: la vuelta del back_url / «Ya autoricé»; si MP dice `authorized`, promueve.
 *   - `createOrReuseChargeCheckout`: «Pagar con Mercado Pago» un cargo OPEN.
 *   - `syncSaasMpAfterCommit`: después de un cambio de plan/baja/método, lleva el preapproval al monto/estado deseado.
 *   - `runSaasMpReconcile`: la etapa 4b del cron (modo `mp`).
 *
 * Reglas (por qué el módulo tiene esta forma):
 *   - **MP SIEMPRE fuera de una transacción.** Una llamada dura hasta 8 s: adentro de una tx retendría el lock del
 *     Tenant/Subscription todo ese tiempo y frenaría el webhook y las actions del consultorio. Patrón: leer → llamar a MP
 *     → escribir con un UPDATE condicional corto (`updateMany` con el id que se leyó, un CAS): si otro proceso cambió el
 *     preapproval o el link en el medio, la escritura no pisa nada y lo nuestro se deshace en MP (best effort).
 *     Una sola fila por UPDATE ⇒ no hace falta el par Tenant → Subscription del escritor (no hay dos locks que ordenar).
 *   - **NO importa el escritor** (`lib/saas-billing-internal.ts`): el escritor importa este módulo (etapa 4b del cron) y el
 *     ciclo rompería el orden de evaluación. Por eso el precio del plan y la proyección del cargo se recalculan acá con
 *     la lógica pura (`composeCharge`, `stubFor`, `effectiveCustomPrice`), igual que lo hace `createPeriodChargeInTx`.
 *     La promoción del pendiente (`consumeSaasPreapproval`, MPS-2b1) se pide por `import()` dinámico por la misma razón.
 *   - Canal service (`prismaService`): `SaasSubscription`/`SaasCharge` son TENANT_READONLY para el rol app. Este
 *     módulo no tiene Actor: lo llaman las actions de MPS-3a (que ya validaron tenant + permisos + step-up) y el cron.
 *     Tampoco audita: el caller audita (mismo criterio que el escritor).
 *   - **Nunca tira** hacia el caller: un MP caído no puede tumbar un request ni el cron. Todo vuelve como resultado.
 *   - Plata en centavos `Int`; fechas civiles AR (`toARDateKey`) — en Vercel el host está en UTC.
 */
import { createHash, randomUUID } from "node:crypto";
import type { SaasCollectionMethod, SaasPlan, SubscriptionStatus, TenantStatus } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { BRAND_NAME } from "@/lib/brand";
import { mpMinDebitCents, saasBillingMode } from "@/lib/env";
import { logger } from "@/lib/logger";
import { toARDateKey } from "@/lib/datetime-ar";
import { mpAppUrl } from "@/lib/mp-connect/http";
import { PLAN_DEFAULTS } from "@/lib/saas-plans-logic";
import {
  chargeAmountFor,
  composeCharge,
  dayOfKey,
  dbDateFromKey,
  effectiveCustomPrice,
  keyFromDbDate,
  nextAnchorKey,
  SAAS_ANCHOR_DAY,
  stubFor,
  type DateKey,
  type PendingAdjustment,
} from "@/lib/saas-billing-logic";
import { debitStartInstant, desiredDebit, saasExternalReference, type DesiredDebit } from "@/lib/saas-mp-logic";
import {
  createChargeCheckout,
  createPreapproval,
  expireCheckout,
  getChargeCheckout,
  getPreapproval,
  saasMpEnabled,
  updatePreapproval,
  type SaasPreapproval,
} from "@/lib/mercadopago-saas";
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

/** C-MPS8 / MPS-D16: tope de suscripciones por corrida (cada una es un GET y a lo sumo un PUT, ≤ 8 s cada uno). */
export const SAAS_MP_RECONCILE_MAX = 50;
/**
 * Cuántas filas se miran para elegir las ≤ 50 (la prioridad se calcula en memoria con la proyección de cada una).
 * Holgado para el volumen esperado (los consultorios con débito); por encima, los que quedan afuera son los de sync más
 * reciente (orden `mpPreapprovalSyncedAt` ascendente), que son los que menos lo necesitan.
 */
const RECONCILE_CANDIDATES = 500;
/** MPS-D17: un preapproval pendiente sin autorizar se cancela a los 7 días (el link de MP quedó abandonado). */
const PENDING_TTL_MS = 7 * 86_400_000;
/** C-MPS8: el link de pago de un cargo se reusa durante 24 h si el monto es el mismo (vive 72 h en MP). */
const CHECKOUT_REUSE_MS = 24 * 3600_000;
/** Margen para no devolver un link que vence mientras el usuario lo abre. */
const CHECKOUT_MIN_LIFE_MS = 30 * 60_000;
/** El retirado (preapproval reemplazado) se re-chequea a lo sumo una vez por semana (ver `pickFocus`). */
const RETIRED_RECHECK_MS = 7 * 86_400_000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── Contexto ────────────────────────────────────────────────────────────────────────────────────────────────────

const SUB_SELECT = {
  tenantId: true,
  customPriceCents: true,
  customPricePlan: true,
  nextChargeAt: true,
  autoDebitAllowed: true,
  collectionMethod: true,
  billableFrom: true,
  cancelAtPeriodEnd: true,
  pendingPlan: true,
  pendingPlanEffectiveOn: true,
  mpPreapprovalId: true,
  mpPreapprovalStatus: true,
  mpPreapprovalAmountCents: true,
  mpPayerEmail: true,
  mpPendingPreapprovalId: true,
  mpPendingInitPoint: true,
  mpPendingPayerEmail: true,
  mpPendingCreatedAt: true,
  mpRetiredPreapprovalId: true,
  mpPreapprovalSyncedAt: true,
  tenant: { select: { saasPlan: true, subscriptionStatus: true, status: true, trialEndsAt: true } },
} as const;

type SubCtx = {
  tenantId: string;
  customPriceCents: number | null;
  customPricePlan: SaasPlan | null;
  nextChargeAt: Date | null;
  autoDebitAllowed: boolean;
  collectionMethod: SaasCollectionMethod | null;
  billableFrom: Date | null;
  cancelAtPeriodEnd: boolean;
  pendingPlan: SaasPlan | null;
  pendingPlanEffectiveOn: Date | null;
  mpPreapprovalId: string | null;
  mpPreapprovalStatus: string | null;
  mpPreapprovalAmountCents: number | null;
  mpPayerEmail: string | null;
  mpPendingPreapprovalId: string | null;
  mpPendingInitPoint: string | null;
  mpPendingPayerEmail: string | null;
  mpPendingCreatedAt: Date | null;
  mpRetiredPreapprovalId: string | null;
  mpPreapprovalSyncedAt: Date | null;
  tenant: { saasPlan: SaasPlan; subscriptionStatus: SubscriptionStatus; status: TenantStatus; trialEndsAt: Date | null };
};

async function loadCtx(tenantId: string): Promise<SubCtx | null> {
  return prismaService.saasSubscription.findUnique({ where: { tenantId }, select: SUB_SELECT });
}

/** Precio de lista del plan. Copia deliberada de `planPriceCents` del escritor (no se importa: ver cabecera). */
async function planPrices(): Promise<Map<SaasPlan, number | null>> {
  const rows = await prismaService.saasPlanConfig.findMany({ select: { plan: true, priceCents: true } });
  const m = new Map<SaasPlan, number | null>();
  for (const [plan, d] of Object.entries(PLAN_DEFAULTS) as [SaasPlan, (typeof PLAN_DEFAULTS)[SaasPlan]][]) m.set(plan, d.priceCents);
  for (const r of rows) m.set(r.plan, r.priceCents);
  return m;
}

/** Plan que rige el período que empieza en `key`: la bajada programada aplica desde su fecha (C-MPS9). */
function planOn(c: SubCtx, key: DateKey): SaasPlan {
  if (c.pendingPlan && c.pendingPlanEffectiveOn && keyFromDbDate(c.pendingPlanEffectiveOn) <= key) return c.pendingPlan;
  return c.tenant.saasPlan;
}

function baseOn(c: SubCtx, key: DateKey, prices: Map<SaasPlan, number | null>): number | null {
  const plan = planOn(c, key);
  const custom = effectiveCustomPrice({ customPriceCents: c.customPriceCents, customPricePlan: c.customPricePlan, plan });
  return chargeAmountFor({ customPriceCents: custom, planPriceCents: prices.get(plan) ?? null });
}

/**
 * Lo que va a salir el cargo del período `periodStart` si el cron lo crea hoy (misma receta que
 * `createPeriodChargeInTx`: stub del primer período + ajustes pendientes con `composeCharge`), menos el saldo a favor
 * que `applyCreditInTx` le aplicaría. 0 si ese período no se cobra (prueba en curso, consultorio inactivo).
 */
async function projectedChargeCents(c: SubCtx, periodStart: DateKey, prices: Map<SaasPlan, number | null>): Promise<number | null> {
  const t = c.tenant;
  if (t.subscriptionStatus === "TRIALING" && t.trialEndsAt && toARDateKey(t.trialEndsAt) >= periodStart) return 0;
  if (t.status !== "ACTIVE") return 0;
  const base = baseOn(c, periodStart, prices);
  if (base === null) return null;
  const [rows, chargeCount, credit] = await Promise.all([
    prismaService.saasAdjustment.findMany({
      where: { tenantId: c.tenantId, appliedChargeId: null, effectiveOn: { lte: dbDateFromKey(periodStart) } },
      orderBy: [{ effectiveOn: "asc" }, { createdAt: "asc" }],
      select: { id: true, kind: true, amountCents: true, idempotencyKey: true },
    }),
    prismaService.saasCharge.count({ where: { tenantId: c.tenantId } }),
    prismaService.saasPayment.aggregate({ where: { tenantId: c.tenantId, status: "APPROVED", chargeId: null }, _sum: { amountCents: true } }),
  ]);
  const pending: PendingAdjustment[] = rows.map((r) => ({ id: r.id, kind: r.kind, amountCents: r.amountCents }));
  // El stub (alta a mitad de mes) lo crea el cron recién con el primer cargo: si todavía no existe, se proyecta.
  if (chargeCount === 0 && c.billableFrom) {
    const stub = stubFor({ billableFrom: keyFromDbDate(c.billableFrom), periodStart, priceCents: base });
    if (stub && !rows.some((r) => r.idempotencyKey === stub.idempotencyKey)) {
      pending.unshift({ id: stub.idempotencyKey, kind: "PRORATION", amountCents: stub.amountCents });
    }
  }
  const amount = composeCharge({ baseCents: base, pending }).amountCents;
  return Math.max(0, amount - (credit._sum.amountCents ?? 0));
}

/**
 * Estado deseado del preapproval HOY (`desiredDebit`): la base del próximo período fuera de la ventana; los días 3 y 4
 * la proyección del cargo del 4 (el 4, si el cron ya creó el cargo, lo que falta pagar de ese cargo).
 */
async function desiredFor(c: SubCtx, now: Date, prices: Map<SaasPlan, number | null>, forceMethod?: SaasCollectionMethod): Promise<DesiredDebit | null> {
  try {
    const today = toARDateKey(now);
    const nextKey = c.nextChargeAt ? toARDateKey(c.nextChargeAt) : nextAnchorKey(today);
    const nextBaseCents = baseOn(c, nextKey > today ? nextKey : nextAnchorKey(today), prices);
    const day = dayOfKey(today);
    let projectedCents: number | null = null;
    if (day === SAAS_ANCHOR_DAY - 1 || day === SAAS_ANCHOR_DAY) {
      const periodStart = day === SAAS_ANCHOR_DAY ? today : nextAnchorKey(today);
      const charge =
        day === SAAS_ANCHOR_DAY
          ? await prismaService.saasCharge.findUnique({
              where: { tenantId_periodStart: { tenantId: c.tenantId, periodStart: dbDateFromKey(periodStart) } },
              select: { id: true, status: true, amountCents: true },
            })
          : null;
      if (charge) {
        if (charge.status !== "OPEN") projectedCents = 0;
        else {
          const paid = await prismaService.saasPayment.aggregate({
            where: { tenantId: c.tenantId, chargeId: charge.id, status: "APPROVED" },
            _sum: { amountCents: true },
          });
          projectedCents = Math.max(0, charge.amountCents - (paid._sum.amountCents ?? 0));
        }
      } else projectedCents = await projectedChargeCents(c, periodStart, prices);
    }
    return desiredDebit({
      today,
      subscriptionStatus: c.tenant.subscriptionStatus,
      collectionMethod: forceMethod ?? c.collectionMethod,
      autoDebitAllowed: c.autoDebitAllowed,
      cancelAtPeriodEnd: c.cancelAtPeriodEnd,
      nextBaseCents,
      projectedCents,
      minDebitCents: mpMinDebitCents() ?? undefined,
    });
  } catch (err) {
    logger.error("saas_mp_sync.desired_failed", { tenantId: c.tenantId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** ¿Lo guardado del preapproval vigente difiere de lo deseado? (sin red: lo usa la prioridad de la conciliación). */
function storedDiffers(c: SubCtx, d: DesiredDebit): boolean {
  const st = c.mpPreapprovalStatus;
  if (d.status === "cancelled") return st !== "cancelled";
  if (st === "cancelled") return false; // lo cancelado no se revive por PUT (terminal en MP): hace falta un flujo nuevo
  if (d.status === "paused") return st !== "paused";
  return st !== "authorized" || c.mpPreapprovalAmountCents !== d.amountCents;
}

// ── Escrituras (UPDATE condicional corto, fuera de MP) ───────────────────────────────────────────────────────────

/** Foto del preapproval VIGENTE tal como lo dejó MP. CAS por id: si en el medio se promovió otro, no se pisa. */
async function writeCurrentSnapshot(tenantId: string, p: SaasPreapproval, now: Date): Promise<void> {
  await prismaService.saasSubscription.updateMany({
    where: { tenantId, mpPreapprovalId: p.id },
    data: {
      mpPreapprovalStatus: p.status,
      mpPreapprovalAmountCents: p.amountCents,
      mpPreapprovalNextAt: p.nextPaymentDate,
      mpPreapprovalSyncedAt: now,
      autoDebitEnabled: p.status !== "cancelled",
      ...(p.payerEmail ? { mpPayerEmail: p.payerEmail.toLowerCase() } : {}),
    },
  });
}

async function clearPending(tenantId: string, pendingId: string): Promise<void> {
  await prismaService.saasSubscription.updateMany({
    where: { tenantId, mpPendingPreapprovalId: pendingId },
    data: { mpPendingPreapprovalId: null, mpPendingInitPoint: null, mpPendingPayerEmail: null, mpPendingCreatedAt: null },
  });
}

async function touchSynced(tenantId: string, now: Date): Promise<void> {
  await prismaService.saasSubscription.updateMany({ where: { tenantId }, data: { mpPreapprovalSyncedAt: now } });
}

/** Promoción del pendiente autorizado: la hace el consumidor de MPS-2b1 (una sola implementación con su mail y audit). */
async function promote(preapprovalId: string, now: Date, source: "reconcile" | "return"): Promise<boolean> {
  try {
    const { consumeSaasPreapproval } = await import("@/lib/saas-billing-mp-internal");
    const r = await consumeSaasPreapproval(preapprovalId, { now, source });
    return r.ok;
  } catch (err) {
    logger.error("saas_mp_sync.promote_failed", { preapprovalId, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

// ── Pasos por preapproval (cada uno: un GET y a lo sumo un PUT) ──────────────────────────────────────────────────

type StepResult = { ok: boolean; changed: boolean };

/** Lleva el preapproval VIGENTE al deseado. */
async function stepCurrent(c: SubCtx, desired: DesiredDebit | null, now: Date, source: "reconcile" | "return"): Promise<StepResult> {
  const id = c.mpPreapprovalId;
  if (!id) return { ok: true, changed: false };
  if (!desired) return { ok: false, changed: false };
  const g = await getPreapproval(id);
  if (!g.ok) return { ok: false, changed: false };
  let p = g.data;
  if (p.status === "cancelled") {
    // Cancelado desde MP con la base esperando un débito: lo apaga el consumidor (apaga el débito + mail, C-MPS7).
    if (desired.status !== "cancelled" && c.mpPreapprovalStatus !== "cancelled") {
      const ok = await promote(id, now, source);
      return { ok, changed: ok };
    }
    await writeCurrentSnapshot(c.tenantId, p, now);
    return { ok: true, changed: false };
  }
  const patch: { status?: "authorized" | "paused" | "cancelled"; amountCents?: number } = {};
  if (desired.status === "cancelled") patch.status = "cancelled";
  else if (p.status === "pending") {
    // El vigente nunca debería estar pendiente (se promueve autorizado); MP solo deja cancelarlo. No se toca.
  } else if (desired.status === "paused") {
    if (p.status !== "paused") patch.status = "paused";
  } else {
    if (p.status !== "authorized") patch.status = "authorized";
    if (p.amountCents !== desired.amountCents) patch.amountCents = desired.amountCents;
  }
  let changed = false;
  if (patch.status !== undefined || patch.amountCents !== undefined) {
    const u = await updatePreapproval(id, patch);
    if (!u.ok) return { ok: false, changed: false };
    p = u.data;
    changed = true;
  }
  await writeCurrentSnapshot(c.tenantId, p, now);
  return { ok: true, changed };
}

/**
 * Preapproval PENDIENTE: autorizado → se promueve; cancelado o inexistente en MP → se limpia; pendiente con más de 7
 * días, débito bloqueado o suscripción cancelada → se cancela en MP y se limpia (MPS-D17).
 */
async function stepPending(c: SubCtx, now: Date, source: "reconcile" | "return"): Promise<StepResult> {
  const id = c.mpPendingPreapprovalId;
  if (!id) return { ok: true, changed: false };
  const g = await getPreapproval(id);
  if (!g.ok) {
    if (g.kind === "http" && g.status === 404) {
      await clearPending(c.tenantId, id);
      return { ok: true, changed: true };
    }
    return { ok: false, changed: false };
  }
  const p = g.data;
  if (p.status === "authorized" || p.status === "paused") {
    const ok = await promote(id, now, source);
    return { ok, changed: ok };
  }
  if (p.status === "cancelled") {
    await clearPending(c.tenantId, id);
    return { ok: true, changed: true };
  }
  const stale = !c.mpPendingCreatedAt || now.getTime() - c.mpPendingCreatedAt.getTime() > PENDING_TTL_MS;
  if (stale || !c.autoDebitAllowed || c.tenant.subscriptionStatus === "CANCELLED") {
    const u = await updatePreapproval(id, { status: "cancelled" });
    if (!u.ok) return { ok: false, changed: false };
    await clearPending(c.tenantId, id);
    return { ok: true, changed: true };
  }
  return { ok: true, changed: false };
}

/** Preapproval RETIRADO (reemplazado por uno nuevo): tiene que quedar cancelado en MP para que no debite dos veces. */
async function stepRetired(c: SubCtx): Promise<StepResult> {
  const id = c.mpRetiredPreapprovalId;
  if (!id) return { ok: true, changed: false };
  const g = await getPreapproval(id);
  if (!g.ok) return g.kind === "http" && g.status === 404 ? { ok: true, changed: false } : { ok: false, changed: false };
  if (g.data.status === "cancelled") return { ok: true, changed: false };
  const u = await updatePreapproval(id, { status: "cancelled" });
  return u.ok ? { ok: true, changed: true } : { ok: false, changed: false };
}

// ── API ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function modeFailure(): SaasMpSyncFailure | null {
  if (saasBillingMode() !== "mp") return "mode_off";
  if (!saasMpEnabled()) return "mp_unavailable";
  return null;
}

function preapprovalBackUrl(): string {
  return `${mpAppUrl().replace(/\/+$/, "")}/configuracion?tab=facturacion&debito=1`;
}

/** Crea (o reusa) el preapproval PENDIENTE sin tarjeta y devuelve su `init_point`; el vigente sigue cobrando hasta que MP autorice el nuevo. */
export async function startPreapprovalFlow(p: {
  tenantId: string;
  payerEmail: string;
  /** Solo para el log; el audit lo hace la action (MPS-3a). */
  actorUserId: string | null;
  now: Date;
}): Promise<StartPreapprovalResult> {
  try {
    const off = modeFailure();
    if (off) return { ok: false, reason: off };
    const c = await loadCtx(p.tenantId);
    if (!c) return { ok: false, reason: "not_found" };
    if (!c.autoDebitAllowed || c.tenant.subscriptionStatus === "CANCELLED" || c.cancelAtPeriodEnd) return { ok: false, reason: "not_allowed" };
    // MPS-D21: el email lo tipea el usuario (la action lo valida con zod); acá se normaliza para comparar y guardar.
    const email = String(p.payerEmail ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254) return { ok: false, reason: "not_allowed" };

    const prices = await planPrices();
    const d = await desiredFor(c, p.now, prices, "AUTO_DEBIT");
    if (!d || d.status === "cancelled") return { ok: false, reason: "not_allowed" };
    // `paused` (proyección 0 hoy): el preapproval se crea igual con la base, y la conciliación lo pausa ese ciclo.
    let amountCents: number | null = d.status === "authorized" ? d.amountCents : null;
    if (amountCents === null) {
      const today = toARDateKey(p.now);
      const base = baseOn(c, c.nextChargeAt ? toARDateKey(c.nextChargeAt) : nextAnchorKey(today), prices);
      const min = mpMinDebitCents() ?? 0;
      amountCents = base && base > 0 ? Math.max(base, min) : null;
    }
    if (amountCents === null) return { ok: false, reason: "below_minimum" };

    // Reuso: el pendiente vigente (< 7 días), del mismo email y monto, que MP todavía tiene como pendiente.
    const prevPending = c.mpPendingPreapprovalId;
    if (prevPending) {
      const fresh = c.mpPendingCreatedAt && p.now.getTime() - c.mpPendingCreatedAt.getTime() <= PENDING_TTL_MS;
      const g = await getPreapproval(prevPending);
      if (!g.ok && !(g.kind === "http" && g.status === 404)) return { ok: false, reason: "mp_unavailable" };
      if (g.ok && (g.data.status === "authorized" || g.data.status === "paused")) {
        // Ya lo autorizó (el webhook no llegó todavía): se promueve en vez de pedir otra autorización.
        await promote(prevPending, p.now, "return");
        return { ok: true, initPoint: c.mpPendingInitPoint ?? g.data.initPoint ?? "", preapprovalId: prevPending, reused: true };
      }
      const reusable =
        g.ok && g.data.status === "pending" && fresh && c.mpPendingPayerEmail === email && g.data.amountCents === amountCents;
      const initPoint = (g.ok && g.data.initPoint) || c.mpPendingInitPoint;
      if (reusable && initPoint) return { ok: true, initPoint, preapprovalId: prevPending, reused: true };
      if (g.ok && g.data.status === "pending") {
        const u = await updatePreapproval(prevPending, { status: "cancelled" });
        if (!u.ok) logger.warn("saas_mp_sync.pending_cancel_failed", { tenantId: p.tenantId, kind: u.kind });
      }
    }

    const nextKey = c.nextChargeAt ? toARDateKey(c.nextChargeAt) : nextAnchorKey(toARDateKey(p.now));
    const startDate = new Date(debitStartInstant(p.now, nextKey));
    const emailHash = createHash("sha256").update(email).digest("hex").slice(0, 16);
    // Clave estable por (tenant, email, monto, inicio, día): un doble click devuelve el MISMO preapproval de MP.
    const idem = `saas-pre:${p.tenantId}:${emailHash}:${amountCents}:${startDate.getTime()}:${toARDateKey(p.now)}`;
    const input = {
      reason: `Suscripción ${BRAND_NAME}`,
      externalReference: saasExternalReference(p.tenantId),
      payerEmail: email,
      amountCents,
      startDate,
      backUrl: preapprovalBackUrl(),
    };
    let created = await createPreapproval({ ...input, idempotencyKey: idem });
    // La clave estable puede devolver uno que ya se canceló hoy (el usuario reintentó): entonces uno nuevo de verdad.
    if (created.ok && (created.data.status !== "pending" || created.data.id === prevPending)) {
      created = await createPreapproval({ ...input, idempotencyKey: `${idem}:${randomUUID()}` });
    }
    if (!created.ok || created.data.status !== "pending" || !created.data.initPoint) return { ok: false, reason: "mp_unavailable" };
    const pre = created.data;
    const initPoint = pre.initPoint as string;

    const w = await prismaService.saasSubscription.updateMany({
      where: { tenantId: p.tenantId, mpPendingPreapprovalId: prevPending },
      data: { mpPendingPreapprovalId: pre.id, mpPendingInitPoint: initPoint.slice(0, 1000), mpPendingPayerEmail: email, mpPendingCreatedAt: p.now },
    });
    if (w.count === 0) {
      // Otro pedido ganó en el medio: se cancela el nuestro y se devuelve el que quedó.
      const u = await updatePreapproval(pre.id, { status: "cancelled" });
      if (!u.ok) logger.warn("saas_mp_sync.race_cancel_failed", { tenantId: p.tenantId, kind: u.kind });
      const now = await loadCtx(p.tenantId);
      if (now?.mpPendingPreapprovalId && now.mpPendingInitPoint) {
        return { ok: true, initPoint: now.mpPendingInitPoint, preapprovalId: now.mpPendingPreapprovalId, reused: true };
      }
      return { ok: false, reason: "mp_unavailable" };
    }
    logger.info("saas_mp_sync.preapproval_started", { tenantId: p.tenantId, actorUserId: p.actorUserId, amountCents });
    return { ok: true, initPoint, preapprovalId: pre.id, reused: false };
  } catch (err) {
    logger.error("saas_mp_sync.start_failed", { tenantId: p.tenantId, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, reason: "mp_unavailable" };
  }
}

/** Estado del débito que ve el consultorio, desde lo guardado (C-MPS5/UI). */
async function statusOf(c: SubCtx | null): Promise<BillingAutoDebitStatus> {
  if (!c) return "none";
  if (!c.autoDebitAllowed) return "blocked";
  if (c.mpPendingPreapprovalId) return "pending_authorization";
  if (!c.mpPreapprovalId) return "none";
  switch (c.mpPreapprovalStatus) {
    case "paused":
      return "paused";
    case "cancelled":
      return "cancelled";
    case "authorized": {
      const last = await prismaService.saasPayment.findFirst({
        where: { tenantId: c.tenantId, source: "MP_AUTO", mpPreapprovalId: c.mpPreapprovalId, status: { in: ["APPROVED", "REJECTED"] } },
        orderBy: { createdAt: "desc" },
        select: { status: true },
      });
      return last?.status === "REJECTED" ? "failed" : "active";
    }
    default:
      return "pending_authorization";
  }
}

/** Re-lee el preapproval pendiente en MP (botón «Ya autoricé» / vuelta del checkout) y devuelve el estado resultante. Idempotente. */
export async function refreshPendingPreapproval(p: { tenantId: string; now: Date }): Promise<{ status: BillingAutoDebitStatus }> {
  try {
    let c = await loadCtx(p.tenantId);
    if (!c || modeFailure()) return { status: await statusOf(c) };
    if (c.mpPendingPreapprovalId) {
      const r = await stepPending(c, p.now, "return");
      if (r.changed) c = await loadCtx(p.tenantId);
    }
    if (c && !c.mpPendingPreapprovalId) {
      // Recién promovido (o sin pendiente): el viejo se cancela ya y el vigente se alinea al monto deseado.
      if (c.mpRetiredPreapprovalId) await stepRetired(c);
      if (c.mpPreapprovalId) {
        const d = await desiredFor(c, p.now, await planPrices());
        const r = await stepCurrent(c, d, p.now, "return");
        if (r.changed || r.ok) c = await loadCtx(p.tenantId);
      }
    }
    return { status: await statusOf(c) };
  } catch (err) {
    logger.error("saas_mp_sync.refresh_failed", { tenantId: p.tenantId, error: err instanceof Error ? err.message : String(err) });
    try {
      return { status: await statusOf(await loadCtx(p.tenantId)) };
    } catch {
      return { status: "none" };
    }
  }
}

function arDateLabel(key: DateKey): string {
  return `${key.slice(8, 10)}/${key.slice(5, 7)}/${key.slice(0, 4)}`;
}

/** «Pagar con Mercado Pago» un cargo OPEN: reusa el checkout de las últimas 24 h si el monto es el mismo; si no, lo crea (`saas:t:c`, `?scope=saas`). */
export async function createOrReuseChargeCheckout(p: { tenantId: string; chargeId: string; now: Date }): Promise<ChargeCheckoutResult> {
  try {
    const off = modeFailure();
    if (off) return { ok: false, reason: off };
    const load = () =>
      prismaService.saasCharge.findFirst({
        where: { id: p.chargeId, tenantId: p.tenantId },
        select: { id: true, status: true, amountCents: true, periodStart: true, mpCheckoutPreferenceId: true, mpCheckoutExpectedCents: true, mpCheckoutCreatedAt: true },
      });
    const charge = await load();
    if (!charge) return { ok: false, reason: "not_found" };
    if (charge.status !== "OPEN") return { ok: false, reason: "charge_not_open" };
    const paid = await prismaService.saasPayment.aggregate({
      where: { tenantId: p.tenantId, chargeId: charge.id, status: "APPROVED" },
      _sum: { amountCents: true },
    });
    const remaining = charge.amountCents - (paid._sum.amountCents ?? 0);
    if (remaining <= 0) return { ok: false, reason: "charge_not_open" };

    const prev = charge.mpCheckoutPreferenceId;
    const recent = charge.mpCheckoutCreatedAt && p.now.getTime() - charge.mpCheckoutCreatedAt.getTime() < CHECKOUT_REUSE_MS;
    if (prev && recent && charge.mpCheckoutExpectedCents === remaining) {
      const g = await getChargeCheckout(prev);
      // La vida del link la mide MP con SU reloj (el real), no con el `now` del caller.
      if (g.ok && (!g.data.expiresAt || g.data.expiresAt.getTime() - Date.now() > CHECKOUT_MIN_LIFE_MS)) {
        return { ok: true, initPoint: g.data.initPoint, preferenceId: prev, reused: true };
      }
    }

    const sub = await prismaService.saasSubscription.findUnique({ where: { tenantId: p.tenantId }, select: { mpPayerEmail: true, mpPendingPayerEmail: true } });
    const created = await createChargeCheckout({
      tenantId: p.tenantId,
      chargeId: charge.id,
      title: `Suscripción ${BRAND_NAME} · período del ${arDateLabel(keyFromDbDate(charge.periodStart))}`,
      amountCents: remaining,
      payerEmail: sub?.mpPayerEmail ?? sub?.mpPendingPayerEmail ?? "",
      idempotencyKey: `saas-chk:${charge.id}:${remaining}:${p.now.getTime()}`,
    });
    if (!created.ok) return { ok: false, reason: "mp_unavailable" };
    const w = await prismaService.saasCharge.updateMany({
      where: { id: charge.id, tenantId: p.tenantId, status: "OPEN", mpCheckoutPreferenceId: prev },
      data: { mpCheckoutPreferenceId: created.data.preferenceId, mpCheckoutExpectedCents: remaining, mpCheckoutCreatedAt: p.now },
    });
    if (w.count === 0) {
      // Otro pedido guardó su link (o el cargo se pagó) en el medio: el nuestro se vence y se devuelve el que quedó.
      await expireCheckout(created.data.preferenceId);
      const again = await load();
      if (!again || again.status !== "OPEN") return { ok: false, reason: "charge_not_open" };
      if (again.mpCheckoutPreferenceId) {
        const g = await getChargeCheckout(again.mpCheckoutPreferenceId);
        if (g.ok) return { ok: true, initPoint: g.data.initPoint, preferenceId: again.mpCheckoutPreferenceId, reused: true };
      }
      return { ok: false, reason: "mp_unavailable" };
    }
    // El link viejo (otro monto o más de 24 h) se vence: si el consultorio lo tenía abierto, no paga un monto viejo.
    if (prev && prev !== created.data.preferenceId) {
      const e = await expireCheckout(prev);
      if (!e.ok) logger.warn("saas_mp_sync.checkout_expire_failed", { tenantId: p.tenantId, chargeId: charge.id, kind: e.kind });
    }
    return { ok: true, initPoint: created.data.initPoint, preferenceId: created.data.preferenceId, reused: false };
  } catch (err) {
    logger.error("saas_mp_sync.checkout_failed", { tenantId: p.tenantId, chargeId: p.chargeId, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, reason: "mp_unavailable" };
  }
}

/** Después del commit de un cambio de plan/baja/método: lleva el preapproval al `desiredDebit`. Nunca tira (loguea). */
export async function syncSaasMpAfterCommit(tenantId: string): Promise<void> {
  try {
    if (modeFailure()) return;
    const c = await loadCtx(tenantId);
    if (!c) return;
    const now = new Date();
    if (c.mpRetiredPreapprovalId) await stepRetired(c);
    if (c.mpPendingPreapprovalId && (!c.autoDebitAllowed || c.tenant.subscriptionStatus === "CANCELLED")) await stepPending(c, now, "reconcile");
    if (c.mpPreapprovalId) {
      const r = await stepCurrent(c, await desiredFor(c, now, await planPrices()), now, "reconcile");
      if (!r.ok) logger.warn("saas_mp_sync.after_commit_failed", { tenantId });
    }
  } catch (err) {
    logger.error("saas_mp_sync.after_commit_error", { tenantId, error: err instanceof Error ? err.message : String(err) });
  }
}

type Focus = "current" | "pending" | "retired";

/**
 * Prioridad de la conciliación (C-MPS8): 0 = ventana del día 3-4 (el PUT del monto proyectado; uno por día), 1 = desvío
 * de monto/estado entre lo guardado y lo deseado (incluye la restauración del 5), 2 = pendiente de más de 7 días
 * (cancelar, MPS-D17), 3 = retirado sin chequear hace una semana (cancelar), 4 = el resto, los de sync más viejo primero.
 * Cada suscripción se procesa sobre UN preapproval (`focus`): un GET y a lo sumo un PUT.
 * Por qué el retirado solo con una semana sin sync: queda guardado (sus débitos tardíos se siguen imputando) y no hay
 * columna que diga «ya está cancelado en MP»; sin ese freno ocuparía la prioridad 3 en todas las corridas.
 */
function pickFocus(c: SubCtx, d: DesiredDebit | null, now: Date): { tier: number; focus: Focus } | null {
  const today = toARDateKey(now);
  const day = dayOfKey(today);
  const inWindow = day === SAAS_ANCHOR_DAY - 1 || day === SAAS_ANCHOR_DAY;
  const current = c.mpPreapprovalId && c.mpPreapprovalStatus !== "cancelled" ? c.mpPreapprovalId : null;
  if (current && inWindow && (!c.mpPreapprovalSyncedAt || toARDateKey(c.mpPreapprovalSyncedAt) !== today)) return { tier: 0, focus: "current" };
  if (c.mpPreapprovalId && d && storedDiffers(c, d)) return { tier: 1, focus: "current" };
  if (c.mpPendingPreapprovalId && (!c.mpPendingCreatedAt || now.getTime() - c.mpPendingCreatedAt.getTime() > PENDING_TTL_MS)) {
    return { tier: 2, focus: "pending" };
  }
  if (c.mpRetiredPreapprovalId && (!c.mpPreapprovalSyncedAt || now.getTime() - c.mpPreapprovalSyncedAt.getTime() > RETIRED_RECHECK_MS)) {
    return { tier: 3, focus: "retired" };
  }
  if (current) return { tier: 4, focus: "current" };
  if (c.mpPendingPreapprovalId) return { tier: 4, focus: "pending" };
  return null;
}

/** Etapa 4b del cron (modo `mp`): ≤ 50 suscripciones, un GET cada una y un PUT solo si difiere, dentro de `budgetMs` (≤ 10 s). */
export async function runSaasMpReconcile(now: Date, budgetMs: number, scope?: SaasMpReconcileScope): Promise<SaasMpReconcileResult> {
  const started = Date.now();
  const res: SaasMpReconcileResult = { scanned: 0, updated: 0, failed: 0, timedOut: false };
  const outOfTime = () => Date.now() - started >= budgetMs;
  try {
    if (modeFailure()) return res;
    if (outOfTime()) {
      res.timedOut = true;
      return res;
    }
    const limit = Math.max(0, Math.min(SAAS_MP_RECONCILE_MAX, Math.floor(scope?.limit ?? SAAS_MP_RECONCILE_MAX)));
    if (limit === 0) return res;
    const rows: SubCtx[] = await prismaService.saasSubscription.findMany({
      where: {
        ...(scope?.tenantIds ? { tenantId: { in: scope.tenantIds } } : {}),
        OR: [{ mpPreapprovalId: { not: null } }, { mpPendingPreapprovalId: { not: null } }, { mpRetiredPreapprovalId: { not: null } }],
      },
      orderBy: [{ mpPreapprovalSyncedAt: { sort: "asc", nulls: "first" } }, { tenantId: "asc" }],
      take: RECONCILE_CANDIDATES,
      select: SUB_SELECT,
    });
    const prices = await planPrices();
    const queue: { c: SubCtx; d: DesiredDebit | null; tier: number; focus: Focus; order: number }[] = [];
    for (const [order, c] of rows.entries()) {
      const d = c.mpPreapprovalId ? await desiredFor(c, now, prices) : null;
      const f = pickFocus(c, d, now);
      if (f) queue.push({ c, d, ...f, order });
    }
    queue.sort((a, b) => a.tier - b.tier || a.order - b.order);
    for (const item of queue.slice(0, limit)) {
      if (outOfTime()) {
        res.timedOut = true;
        break;
      }
      res.scanned++;
      let r: StepResult;
      try {
        if (item.focus === "current") r = await stepCurrent(item.c, item.d, now, "reconcile");
        else if (item.focus === "pending") r = await stepPending(item.c, now, "reconcile");
        else r = await stepRetired(item.c);
        // El sync de un pendiente/retirado también cuenta como visita (si no, vuelve primero en cada corrida).
        if (r.ok && item.focus !== "current") await touchSynced(item.c.tenantId, now);
      } catch (err) {
        logger.error("saas_mp_sync.reconcile_item_failed", { tenantId: item.c.tenantId, error: err instanceof Error ? err.message : String(err) });
        r = { ok: false, changed: false };
      }
      if (!r.ok) res.failed++;
      else if (r.changed) res.updated++;
    }
  } catch (err) {
    logger.error("saas_mp_sync.reconcile_failed", { error: err instanceof Error ? err.message : String(err) });
  }
  return res;
}
