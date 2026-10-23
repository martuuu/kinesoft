import "server-only";
/**
 * Re-anclaje de las suscripciones al día 4 (MPS-D7, plan §22.6 y §26.6 «Scripts»): núcleo de `scripts/saas-reanchor.ts`
 * (lo corre Martin después del deploy, con `SAAS_BILLING_MODE` en `off` o `manual`) y de «Re-anclar al 4» de Plataforma
 * (`previewReanchor`/`applyReanchor`, MPS-3b, con `planReanchorInTx`/`applyReanchorInTx` y un solo tenant).
 *
 * Por qué existe: M16 cambió el default de `anchorDay` a 4 SIN backfill (una migración no decide el período de un
 * cliente con cargos), así que las suscripciones previas siguen cobrando el día que se anclaron (el siguiente al fin
 * de la prueba). El débito automático necesita una fecha fija para todos y un único ajuste del monto el día 3.
 *
 * Regla (literal del brief):
 *  - SIN cargos: `anchorDay = 4`, `billableFrom = max(inicio del cobro, hoy)` (inicio = el día siguiente a la prueba
 *    si sigue en prueba, si no el alta; igual que `ensureSubscriptionInTx`) y `nextChargeAt` = el primer 4 ≥ eso.
 *  - CON cargos: `billableFrom` = el `nextChargeAt` viejo (lo ya cobrado no se toca: el período en curso termina
 *    donde terminaba) y `nextChargeAt` = el primer 4 ≥ eso. El tramo entre los dos lo cobra el primer cargo como
 *    proporcional (stub `stub:<billableFrom>`, MPS-D13; lo arma `createPeriodChargeInTx`): acá solo se PROYECTA.
 *  - Siempre `autoDebitAllowed = true` (MPS-D24: el débito queda permitido salvo que Plataforma lo apague; antes de
 *    M16 la columna nacía false y nadie la usaba, hallazgo 5 de §26.6).
 *  - Idempotente: una suscripción ya anclada al 4 (día 4, próximo cobro un 4, `billableFrom` cargado y débito
 *    permitido) se SALTEA. Sin esto, la segunda corrida tomaría el `nextChargeAt` nuevo como `billableFrom` y
 *    borraría el stub del primer cargo.
 *
 * Canal: TENANT_READONLY → conexión con BYPASSRLS (el script aborta sin ella: bajo RLS se verían 0 suscripciones =
 * falso «nada que re-anclar»). Locks: Tenant → Subscription por consultorio, en orden de id. No toca cargos, pagos ni
 * ajustes. No usa `lib/saas-billing-internal.ts` (arrastra `next/cache`, env y mail, que el script no tiene).
 */
import type { Prisma, PrismaClient, SaasPlan, SubscriptionStatus } from "@prisma/client";
import { toARDateKey } from "@/lib/datetime-ar";
import { PLAN_DEFAULTS } from "@/lib/saas-plans-logic";
import {
  SAAS_ANCHOR_DAY,
  arMidnight,
  billingStartKey,
  chargeAmountFor,
  dayOfKey,
  dbDateFromKey,
  effectiveCustomPrice,
  firstPeriodStartKey,
  keyFromDbDate,
  stubFor,
  type DateKey,
} from "@/lib/saas-billing-logic";

type Tx = Prisma.TransactionClient;

/** `"all"` = todos los consultorios con suscripción; si no, la lista de ids. */
export type ReanchorScope = "all" | string[];

export type ReanchorRow = {
  tenantId: string;
  tenantName: string;
  saasPlan: SaasPlan;
  subscriptionStatus: SubscriptionStatus;
  hasCharges: boolean;
  oldAnchorDay: number;
  newAnchorDay: number;
  oldNextChargeOn: DateKey | null;
  newNextChargeOn: DateKey;
  oldBillableFrom: DateKey | null;
  billableFrom: DateKey;
  oldAutoDebitAllowed: boolean;
  /** Proporcional proyectado del primer cargo (null = arranca justo el 4 o el plan no tiene precio). */
  stub: { amountCents: number; days: number; periodDays: number } | null;
  action: "update" | "skip";
};

/** Lo que el cálculo necesita de la fila (sin DB: es la parte pura). */
export type ReanchorInput = {
  tenantId: string;
  tenantName: string;
  saasPlan: SaasPlan;
  subscriptionStatus: SubscriptionStatus;
  trialEndsAt: Date | null;
  createdAt: Date;
  anchorDay: number;
  nextChargeAt: Date | null;
  billableFrom: Date | null;
  autoDebitAllowed: boolean;
  /** `periodEnd` del último cargo (cualquier estado); null = sin cargos. */
  lastChargePeriodEnd: Date | null;
  /** Precio mensual del plan actual para este consultorio (null = «Consultá»). */
  priceCents: number | null;
};

/** Cálculo puro de una fila (ver la regla en la cabecera). */
export function planReanchorRow(i: ReanchorInput, now: Date): ReanchorRow {
  const today = toARDateKey(now);
  const oldNext = i.nextChargeAt ? toARDateKey(i.nextChargeAt) : null;
  const oldBillable = i.billableFrom ? keyFromDbDate(i.billableFrom) : null;
  const hasCharges = i.lastChargePeriodEnd !== null;
  const base = {
    tenantId: i.tenantId,
    tenantName: i.tenantName,
    saasPlan: i.saasPlan,
    subscriptionStatus: i.subscriptionStatus,
    hasCharges,
    oldAnchorDay: i.anchorDay,
    newAnchorDay: SAAS_ANCHOR_DAY,
    oldNextChargeOn: oldNext,
    oldBillableFrom: oldBillable,
    oldAutoDebitAllowed: i.autoDebitAllowed,
  };
  const anchored =
    i.anchorDay === SAAS_ANCHOR_DAY && oldNext !== null && dayOfKey(oldNext) === SAAS_ANCHOR_DAY && oldBillable !== null && i.autoDebitAllowed;
  if (anchored) {
    return { ...base, newNextChargeOn: oldNext!, billableFrom: oldBillable!, stub: projectStub(oldBillable!, oldNext!, i.priceCents), action: "skip" };
  }
  let billableFrom: DateKey;
  if (!hasCharges) {
    const start = billingStartKey({ trialEndsAt: i.subscriptionStatus === "TRIALING" ? i.trialEndsAt : null, createdAt: i.createdAt });
    billableFrom = start > today ? start : today;
  } else {
    // Sin cursor (no debería pasar con cargos) el período cobrado termina donde terminó el último cargo.
    billableFrom = oldNext ?? keyFromDbDate(i.lastChargePeriodEnd!);
  }
  const next = firstPeriodStartKey(billableFrom, SAAS_ANCHOR_DAY);
  return { ...base, newNextChargeOn: next, billableFrom, stub: projectStub(billableFrom, next, i.priceCents), action: "update" };
}

function projectStub(billableFrom: DateKey, periodStart: DateKey, priceCents: number | null): ReanchorRow["stub"] {
  const s = stubFor({ billableFrom, periodStart, priceCents });
  return s ? { amountCents: s.amountCents, days: s.days, periodDays: s.periodDays } : null;
}

function assertScope(scope: ReanchorScope): void {
  if (scope === "all") return;
  if (!Array.isArray(scope) || scope.length === 0 || scope.some((id) => typeof id !== "string" || id.length === 0 || id.length > 64)) {
    throw new Error("[saas-reanchor] alcance inválido: `all` o una lista de ids de consultorio");
  }
}

async function scopedTenantIds(tx: Tx, scope: ReanchorScope): Promise<string[]> {
  const rows = await tx.saasSubscription.findMany({
    where: scope === "all" ? {} : { tenantId: { in: scope } },
    select: { tenantId: true },
    orderBy: { tenantId: "asc" },
  });
  return rows.map((r) => r.tenantId);
}

async function loadInputInTx(tx: Tx, tenantId: string): Promise<ReanchorInput | null> {
  const sub = await tx.saasSubscription.findUnique({
    where: { tenantId },
    select: {
      anchorDay: true,
      nextChargeAt: true,
      billableFrom: true,
      autoDebitAllowed: true,
      customPriceCents: true,
      customPricePlan: true,
      tenant: { select: { name: true, saasPlan: true, subscriptionStatus: true, trialEndsAt: true, createdAt: true } },
    },
  });
  if (!sub) return null;
  const last = await tx.saasCharge.findFirst({ where: { tenantId }, orderBy: { periodEnd: "desc" }, select: { periodEnd: true } });
  const plan = sub.tenant.saasPlan;
  const cfg = await tx.saasPlanConfig.findUnique({ where: { plan }, select: { priceCents: true } });
  const priceCents = chargeAmountFor({
    customPriceCents: effectiveCustomPrice({ customPriceCents: sub.customPriceCents, customPricePlan: sub.customPricePlan, plan }),
    planPriceCents: cfg ? cfg.priceCents : PLAN_DEFAULTS[plan].priceCents,
  });
  return {
    tenantId,
    tenantName: sub.tenant.name,
    saasPlan: plan,
    subscriptionStatus: sub.tenant.subscriptionStatus,
    trialEndsAt: sub.tenant.trialEndsAt,
    createdAt: sub.tenant.createdAt,
    anchorDay: sub.anchorDay,
    nextChargeAt: sub.nextChargeAt,
    billableFrom: sub.billableFrom,
    autoDebitAllowed: sub.autoDebitAllowed,
    lastChargePeriodEnd: last?.periodEnd ?? null,
    priceCents,
  };
}

/** Dry-run: la tabla consultorio / ancla vieja → nueva / billableFrom / stub proyectado. Solo lectura, sin locks. */
export async function planReanchorInTx(tx: Tx, p: { now: Date; tenantIds: ReanchorScope }): Promise<ReanchorRow[]> {
  assertScope(p.tenantIds);
  const out: ReanchorRow[] = [];
  for (const id of await scopedTenantIds(tx, p.tenantIds)) {
    const input = await loadInputInTx(tx, id);
    if (input) out.push(planReanchorRow(input, p.now));
  }
  return out;
}

/** Aplica el re-anclaje. Por consultorio: lock Tenant → Subscription, relee, calcula y escribe solo si no está anclado. */
export async function applyReanchorInTx(tx: Tx, p: { now: Date; tenantIds: ReanchorScope }): Promise<{ rows: ReanchorRow[]; updated: number }> {
  assertScope(p.tenantIds);
  const rows: ReanchorRow[] = [];
  let updated = 0;
  for (const id of await scopedTenantIds(tx, p.tenantIds)) {
    await tx.$queryRaw`SELECT "id" FROM "Tenant" WHERE "id" = ${id} FOR UPDATE`;
    await tx.$queryRaw`SELECT "tenantId" FROM "SaasSubscription" WHERE "tenantId" = ${id} FOR UPDATE`;
    const input = await loadInputInTx(tx, id);
    if (!input) continue;
    const row = planReanchorRow(input, p.now);
    rows.push(row);
    if (row.action === "skip") continue;
    await tx.saasSubscription.update({
      where: { tenantId: id },
      data: {
        anchorDay: row.newAnchorDay,
        nextChargeAt: arMidnight(row.newNextChargeOn),
        billableFrom: dbDateFromKey(row.billableFrom),
        autoDebitAllowed: true,
      },
    });
    updated++;
  }
  return { rows, updated };
}

/** Sin BYPASSRLS las tablas TENANT_READONLY se ven vacías: el dry-run diría «nada que re-anclar» (falso verde). */
export async function assertReanchorBypassRls(db: PrismaClient): Promise<void> {
  const [role] = await db.$queryRaw<{ bypass: boolean }[]>`
    SELECT (rolbypassrls OR rolsuper) AS bypass FROM pg_roles WHERE rolname = current_user`;
  if (!role?.bypass) {
    throw new Error(
      "[saas-reanchor] la conexión no tiene BYPASSRLS: SaasSubscription es TENANT_READONLY y se vería vacía (falso \"nada que re-anclar\"). Usá DIRECT_URL (owner)."
    );
  }
}

/**
 * Corrida del script: dry-run en una tx READ ONLY por defecto (Postgres rechaza cualquier write, también uno que se
 * cuele por un bug), `apply` en una tx normal con `lock_timeout` (no se queda colgado detrás del cron).
 */
export async function runSaasReanchor(opts: {
  db: PrismaClient;
  tenantIds: ReanchorScope;
  apply: boolean;
  now?: Date;
}): Promise<{ applied: boolean; rows: ReanchorRow[]; updated: number }> {
  assertScope(opts.tenantIds);
  await assertReanchorBypassRls(opts.db);
  const now = opts.now ?? new Date();
  return opts.db.$transaction(
    async (tx) => {
      if (!opts.apply) {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        return { applied: false, rows: await planReanchorInTx(tx, { now, tenantIds: opts.tenantIds }), updated: 0 };
      }
      await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
      const r = await applyReanchorInTx(tx, { now, tenantIds: opts.tenantIds });
      return { applied: true, ...r };
    },
    { timeout: 120_000, maxWait: 10_000 }
  );
}
