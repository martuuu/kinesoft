/**
 * Lógica pura de los cobros de la suscripción (PL-2b, contratos C-PL7..10; ampliada en MPS-1a con C-MPS2, plan §26.6
 * y la enmienda §22.6). Sin DB, sin env, sin `next/*`: la usan `lib/saas-billing-internal.ts` (canal service), los
 * escritores de MPS (`saas-adjustments-internal`, `saas-billing-schedule-internal`), las actions de Configuración y de
 * Plataforma y los unit tests en TZ=UTC y TZ=AR.
 *
 * Fechas: un período es «del 4 de este mes al 4 del que viene» en Argentina, no un instante UTC. Por eso todo se
 * calcula sobre CLAVES de fecha civil AR («YYYY-MM-DD», `toARDateKey`) con aritmética `Date.UTC` (no depende del TZ
 * del host: en Vercel corre en UTC y en la máquina de Martin en AR, y los dos tienen que dar lo mismo). Las columnas
 * `SaasCharge.periodStart/periodEnd/dueDate` son `DATE`: Prisma las lee y escribe como medianoche UTC del día, así
 * que la conversión clave ↔ Date de esas columnas es la UTC (`dbDateFromKey` / `keyFromDbDate`); el resto de los
 * instantes (`trialEndsAt`, `createdAt`, `now`) pasan por `toARDateKey`.
 *
 * Decisiones con default (PL-2b, y lo que cambió con MPS):
 *  - PL2b-D1 (REEMPLAZADA por MPS-D7, §22.6, decisión de Martin): todos los consultorios cobran el día
 *    `SAAS_ANCHOR_DAY` (4), sea cual sea el medio de pago. Antes el ancla era el día siguiente al fin de la prueba
 *    (tope 28); eso dejaba un día de cobro distinto por consultorio y hacía imposible un débito automático con una
 *    fecha fija y un único ajuste del monto el día 3. El alta a mitad de mes ya no regala días: el tramo hasta el
 *    primer 4 se cobra como proporcional en el primer cargo (`stubFor`, MPS-D4/D13). Las suscripciones viejas se
 *    re-anclan con `scripts/saas-reanchor.ts` (lo corre Martin).
 *  - PL2b-D2 el cargo vence `CHARGE_DUE_DAYS` (5) días después de empezar el período: vence el 9, PAST_DUE desde el
 *    10, y desde ahí corren los 10 días de gracia de `tenantAccessFor` (BO-D3) antes del modo lectura.
 *  - PL2b-D3 un consultorio en prueba con la prueba vencida y sin pagar NO pasa a PAST_DUE: sigue TRIALING y lo corta
 *    la regla de la prueba (7 días de gracia, BO-D2), que es más corta. Pasa a ACTIVE cuando salda un cargo.
 *  - PL2b-D4 CANCELLED lo pone Plataforma o la baja programada que vence (MPS-D6); el cobro de cargos nunca lo toca.
 */
import type { SaasAdjustmentKind, SaasChargeStatus, SaasPlan, SubscriptionStatus } from "@prisma/client";
import { toARDateKey } from "@/lib/datetime-ar";
import { PLAN_ORDER } from "@/lib/tenant-modules";

/** «YYYY-MM-DD» de una fecha civil en Argentina. */
export type DateKey = string;

const DAY_MS = 86_400_000;
const KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** El día de anclaje existe en todos los meses (CHECK 1..28 de `SaasSubscription.anchorDay`). */
export const MAX_ANCHOR_DAY = 28;
/**
 * MPS-D7 (§22.6): el día de cobro de TODAS las suscripciones. Es también el default de la columna
 * `SaasSubscription.anchorDay` desde M16; si alguna vez cambia, cambia en los dos lados.
 */
export const SAAS_ANCHOR_DAY = 4;
/** PL2b-D2: días entre el inicio del período y el vencimiento del cargo. */
export const CHARGE_DUE_DAYS = 5;

function parseKey(key: DateKey): [number, number, number] {
  const m = KEY_RE.exec(key);
  if (!m) throw new Error(`[saas-billing-logic] clave de fecha inválida: ${key}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function keyOfUtc(ms: number): DateKey {
  // `toISOString` sobre un instante armado con `Date.UTC` (medianoche UTC del día): es aritmética de calendario, no
  // reloj del host. Única excepción documentada a «nunca toISOString().slice» (AGENTS.md §4).
  return new Date(ms).toISOString().slice(0, 10);
}

export function isDateKey(v: unknown): v is DateKey {
  if (typeof v !== "string") return false;
  const m = KEY_RE.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  return keyOfUtc(ms) === v;
}

export function addDaysKey(key: DateKey, days: number): DateKey {
  const [y, m, d] = parseKey(key);
  return keyOfUtc(Date.UTC(y, m - 1, d) + days * DAY_MS);
}

/** Suma meses conservando el día; si el mes destino es más corto, el último día (con anclaje ≤ 28 no pasa). */
export function addMonthsKey(key: DateKey, months: number): DateKey {
  const [y, m, d] = parseKey(key);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return keyOfUtc(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d, lastDay)));
}

export function dayOfKey(key: DateKey): number {
  return parseKey(key)[2];
}

/** Diferencia en días civiles (b − a). */
export function diffDaysKey(a: DateKey, b: DateKey): number {
  const [ay, am, ad] = parseKey(a);
  const [by, bm, bd] = parseKey(b);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / DAY_MS);
}

/** Columna `DATE` de Prisma (medianoche UTC del día) desde una clave. */
export function dbDateFromKey(key: DateKey): Date {
  const [y, m, d] = parseKey(key);
  return new Date(Date.UTC(y, m - 1, d));
}

/** Clave desde una columna `DATE` leída por Prisma (medianoche UTC del día). */
export function keyFromDbDate(d: Date): DateKey {
  return keyOfUtc(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Medianoche AR de una clave, como instante (para `SaasSubscription.nextChargeAt`, que es TIMESTAMP). */
export function arMidnight(key: DateKey): Date {
  return new Date(`${key}T00:00:00-03:00`);
}

// ── Anclaje y períodos ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * Primer día que se factura (`billableFrom`, MPS-D13): el siguiente al último día de prueba (en AR), o el día del alta si no hubo
 * prueba. `trialEndsAt` es el FIN del último día de prueba (molde de `tenantAccessFor`: su día AR es el último día).
 */
export function billingStartKey(t: { trialEndsAt: Date | null; createdAt: Date }): DateKey {
  if (t.trialEndsAt) return addDaysKey(toARDateKey(t.trialEndsAt), 1);
  return toARDateKey(t.createdAt);
}

/**
 * Día de anclaje de una suscripción nueva. Desde MPS-D7 es siempre `SAAS_ANCHOR_DAY`: el parámetro queda por firma
 * (lo llaman `ensureSubscriptionInTx` y `readLedger`, y el día que vuelva a depender del alta no hay que tocarlos).
 */
export function anchorDayFor(_startKey: DateKey): number {
  return SAAS_ANCHOR_DAY;
}

/** `Date` (instante) o clave AR → clave AR. Los instantes pasan por `toARDateKey`, nunca por el reloj del host. */
function keyOf(d: DateKey | Date): DateKey {
  return typeof d === "string" ? (parseKey(d), d) : toARDateKey(d);
}

/**
 * El próximo día de cobro ESTRICTAMENTE posterior a hoy (en AR). El mismo 4 cuenta como «ya pasó»: ese día el cron
 * crea el cargo del período que empieza hoy, así que lo próximo es el 4 del mes siguiente. Acepta un instante: a las
 * 23:59 AR del 3 (02:59Z del 4) todavía devuelve el 4 de ese mes.
 */
export function nextAnchorKey(today: DateKey | Date): DateKey {
  const key = keyOf(today);
  const [y, m] = parseKey(key);
  const sameMonth = keyOfUtc(Date.UTC(y, m - 1, SAAS_ANCHOR_DAY));
  return sameMonth > key ? sameMonth : addMonthsKey(sameMonth, 1);
}

/** La primera fecha con día `anchorDay` que no es anterior a `startKey`. */
export function firstPeriodStartKey(startKey: DateKey, anchorDay: number): DateKey {
  const [y, m] = parseKey(startKey);
  const sameMonth = keyOfUtc(Date.UTC(y, m - 1, anchorDay));
  return sameMonth >= startKey ? sameMonth : addMonthsKey(sameMonth, 1);
}

/** El inicio del período que contiene a `todayKey` (la última fecha con día `anchorDay` que no es posterior). */
export function periodStartOnOrBefore(anchorDay: number, todayKey: DateKey): DateKey {
  const [y, m] = parseKey(todayKey);
  const sameMonth = keyOfUtc(Date.UTC(y, m - 1, anchorDay));
  return sameMonth <= todayKey ? sameMonth : addMonthsKey(sameMonth, -1);
}

export type BillingPeriod = { periodStart: DateKey; periodEnd: DateKey; dueDate: DateKey };

/** Período mensual que empieza en `periodStart` (fin exclusivo = mismo día del mes siguiente). */
export function periodFor(periodStart: DateKey): BillingPeriod {
  return { periodStart, periodEnd: addMonthsKey(periodStart, 1), dueDate: addDaysKey(periodStart, CHARGE_DUE_DAYS) };
}

// ── Orden de planes y precio a medida ──────────────────────────────────────────────────────────────────────────

/**
 * Orden de los planes, de menor a mayor (MPS-D11: la dirección de un cambio sale de acá, no del precio). Se reexporta
 * el de `lib/tenant-modules.ts` para que haya una sola fuente: los módulos por plan y el cobro no pueden discrepar.
 */
export { PLAN_ORDER };

function planIndex(p: SaasPlan): number {
  const i = PLAN_ORDER.indexOf(p);
  if (i < 0) throw new Error(`[saas-billing-logic] plan desconocido: ${String(p)}`);
  return i;
}

/**
 * MPS-D14: el precio a medida queda atado al plan para el que se pactó (`customPricePlan`): si el consultorio sube o
 * baja de plan, paga el precio del plan nuevo (un descuento de Consultorio no viaja a Clínica). `customPricePlan`
 * NULL con precio = precio fijado antes de M16 (legado): vale para cualquier plan, como antes, hasta que Plataforma lo
 * vuelva a guardar. Devuelve el precio a medida que corresponde o `null` (= el del plan); se pasa tal cual a
 * `chargeAmountFor`.
 */
export function effectiveCustomPrice(p: {
  customPriceCents: number | null;
  customPricePlan: SaasPlan | null;
  plan: SaasPlan;
}): number | null {
  if (p.customPriceCents === null || p.customPriceCents === undefined) return null;
  if (p.customPricePlan === null || p.customPricePlan === undefined) return p.customPriceCents;
  return p.customPricePlan === p.plan ? p.customPriceCents : null;
}

// ── Proporcionales (SaasAdjustment PRORATION) ──────────────────────────────────────────────────────────────────

function assertCents(v: number, what: string): void {
  if (!Number.isSafeInteger(v)) throw new Error(`[saas-billing-logic] ${what} inválido: ${String(v)}`);
}

/**
 * `cents · days / periodDays` redondeado half-up en enteros (sin flotantes: 0,5 sube siempre, nunca el redondeo
 * bancario de `Math.round` sobre un producto que ya perdió precisión). Solo para montos ≥ 0.
 */
function halfUpShare(cents: number, days: number, periodDays: number): number {
  return Math.floor((2 * cents * days + periodDays) / (2 * periodDays));
}

export type Proration = { amountCents: number; days: number; periodDays: number };

/**
 * Proporcional de una subida de plan (MPS-D4): la diferencia mensual por los días que faltan del período, contando el
 * día de la subida (rige ya) y sin contar `periodEnd` (exclusivo, es el inicio del próximo). Días civiles AR.
 * `null` = no hay nada que sumar: sin diferencia o bajada, la fecha ya está fuera del período o el monto redondea a 0
 * (la tabla exige `amountCents > 0`). Una fecha anterior al período (no debería pasar) cobra el período entero.
 */
export function prorate(p: { diffCents: number; fromKey: DateKey; periodStart: DateKey; periodEnd: DateKey }): Proration | null {
  assertCents(p.diffCents, "diffCents");
  if (p.diffCents <= 0) return null;
  const periodDays = diffDaysKey(p.periodStart, p.periodEnd);
  if (periodDays <= 0) return null;
  const days = Math.min(periodDays, diffDaysKey(p.fromKey, p.periodEnd));
  if (days <= 0) return null;
  const amountCents = halfUpShare(p.diffCents, days, periodDays);
  return amountCents > 0 ? { amountCents, days, periodDays } : null;
}

export type StubProration = Proration & { effectiveOn: DateKey; idempotencyKey: string };

/**
 * Proporcional del primer período (MPS-D13, «stub»): el alta (o el fin de la prueba) cae a mitad de mes y el primer
 * cargo completo arranca el 4 siguiente (`periodStart`). El tramo `[billableFrom, periodStart)` se cobra como
 * PRORATION en ese primer cargo, sobre los días del período que termina en `periodStart` (21/10 → 4/11 = 14/31).
 * Clave de idempotencia `stub:<billableFrom>` (UNIQUE por tenant: el cron puede correr dos veces). `null` = no hay
 * tramo (arranca justo el 4), no hay precio («Consultá» o $0) o `billableFrom` es posterior al período.
 */
export function stubFor(p: { billableFrom: DateKey; periodStart: DateKey; priceCents: number | null }): StubProration | null {
  if (p.priceCents === null || p.priceCents === undefined) return null;
  assertCents(p.priceCents, "priceCents");
  if (p.priceCents <= 0) return null;
  const prevStart = addMonthsKey(p.periodStart, -1);
  const periodDays = diffDaysKey(prevStart, p.periodStart);
  const days = Math.min(periodDays, diffDaysKey(p.billableFrom, p.periodStart));
  if (days <= 0) return null;
  const amountCents = halfUpShare(p.priceCents, days, periodDays);
  if (amountCents <= 0) return null;
  return { amountCents, days, periodDays, effectiveOn: p.billableFrom, idempotencyKey: `stub:${p.billableFrom}` };
}

// ── Cambio de plan y baja ──────────────────────────────────────────────────────────────────────────────────────

/** Mismo literal que `PlanChangeKind` de `lib/saas-billing-types.ts` (MPS-K); acá para no depender del archivo de tipos. */
export type PlanChangeKindResult = "immediate" | "upgrade_prorated" | "scheduled_downgrade" | "blocked_cancel_pending";

/**
 * Qué tipo de cambio de plan es (MPS-D4/D5/D11/D18):
 *  - baja pendiente (o CANCELLED, que ya es solo lectura) → `blocked_cancel_pending`: primero se deshace la baja.
 *  - subida (por `PLAN_ORDER`) → rige hoy; lleva proporcional solo si el período ya tiene su cargo (`hasPeriodCharge`),
 *    no está en prueba y la diferencia mensual es > 0. Si no, `immediate` (el próximo cargo ya sale con el plan nuevo).
 *  - bajada → `scheduled_downgrade` al próximo 4 (el período pagado se respeta); en prueba o sin ningún cargo del
 *    período no hay nada pagado que respetar y rige ya (`immediate`).
 *  - mismo plan → `immediate` (no-op; anula una bajada programada si la había).
 * `diffCents` = precio mensual nuevo − actual (null si alguno es «Consultá»).
 */
export function planChangeKind(p: {
  from: SaasPlan;
  to: SaasPlan;
  subscriptionStatus: SubscriptionStatus;
  cancelAtPeriodEnd: boolean;
  hasPeriodCharge: boolean;
  diffCents: number | null;
}): PlanChangeKindResult {
  if (p.cancelAtPeriodEnd || p.subscriptionStatus === "CANCELLED") return "blocked_cancel_pending";
  const dir = planIndex(p.to) - planIndex(p.from);
  if (dir === 0) return "immediate";
  const billed = p.hasPeriodCharge && p.subscriptionStatus !== "TRIALING";
  if (dir > 0) return billed && p.diffCents !== null && p.diffCents > 0 ? "upgrade_prorated" : "immediate";
  return billed ? "scheduled_downgrade" : "immediate";
}

/**
 * Día en que rige una baja pedida hoy (MPS-D6/D18): acceso completo hasta ese día, ese día el cron pone CANCELLED.
 *  - En prueba: el día siguiente al fin de la prueba (no se le cobra un período que no quiere), nunca hoy ni antes
 *    (una prueba vencida y sin pagar todavía TRIALING → mañana).
 *  - Si no: el fin del período = el próximo cobro (`nextChargeKey`, de `SaasSubscription.nextChargeAt`, que respeta
 *    un ancla legada sin re-anclar). Si falta o no es posterior a hoy (el 4 antes de que corra el cron), el próximo 4.
 */
export function cancelEffectiveOnFor(p: {
  today: DateKey | Date;
  subscriptionStatus: SubscriptionStatus;
  trialEndsAt: Date | null;
  nextChargeKey: DateKey | null;
}): DateKey {
  const today = keyOf(p.today);
  if (p.subscriptionStatus === "TRIALING" && p.trialEndsAt) {
    const dayAfterTrial = addDaysKey(toARDateKey(p.trialEndsAt), 1);
    const tomorrow = addDaysKey(today, 1);
    return dayAfterTrial > tomorrow ? dayAfterTrial : tomorrow;
  }
  if (p.nextChargeKey && p.nextChargeKey > today) return p.nextChargeKey;
  return nextAnchorKey(today);
}

// ── Composición del cargo (base + ajustes) ─────────────────────────────────────────────────────────────────────

export type PendingAdjustment = { id: string; kind: SaasAdjustmentKind; amountCents: number };

export type ComposedCharge = {
  baseCents: number;
  /** Suma con signo de los ajustes imputados + el CARRYOVER: `baseCents + adjustmentsCents = amountCents` (CHECK). */
  adjustmentsCents: number;
  amountCents: number;
  /** Ajustes que se marcan imputados a este cargo (`appliedChargeId`). */
  appliedIds: string[];
  /** CARRYOVER(+) que se crea imputado a este cargo para neutralizar el sobrante del CREDIT que cruzó 0. */
  carryover: { amountCents: number; splitFromId: string } | null;
  /** CREDIT(−) nuevo, pendiente, con lo que sobró (`splitFromId` = el CREDIT original). */
  remainingCredit: { amountCents: number; splitFromId: string } | null;
  /** Ajustes que no hicieron falta (créditos con el cargo ya en 0): siguen pendientes para el próximo. */
  leftPendingIds: string[];
};

/**
 * Arma el cargo del período (C-MPS5 paso 3): base + todos los positivos (PRORATION, DEBIT, CARRYOVER) y después los
 * CREDIT en el orden en que llegan (el escritor los lee `ORDER BY effectiveOn, createdAt`). El cargo nunca da menos
 * de 0. `SaasAdjustment` es solo-inserción salvo la imputación (trigger `saas_adjustment_guard`), así que un CREDIT
 * que cruza el 0 no se puede achicar: se imputa entero, se suma un CARRYOVER(+) por el sobrante (el cargo queda en 0)
 * y nace un CREDIT(−) nuevo, pendiente, por ese mismo sobrante. Los créditos que llegan con el cargo ya en 0 quedan
 * pendientes sin tocar. Signos inválidos tiran (son los de `SaasAdjustment_sign_check`).
 */
export function composeCharge(p: { baseCents: number; pending: readonly PendingAdjustment[] }): ComposedCharge {
  assertCents(p.baseCents, "baseCents");
  if (p.baseCents < 0) throw new Error(`[saas-billing-logic] baseCents negativo: ${p.baseCents}`);
  for (const a of p.pending) {
    assertCents(a.amountCents, `ajuste ${a.id}`);
    const ok = a.kind === "CREDIT" ? a.amountCents < 0 : a.amountCents > 0;
    if (!ok) throw new Error(`[saas-billing-logic] signo inválido en el ajuste ${a.id} (${a.kind} ${a.amountCents})`);
  }
  let running = p.baseCents;
  const appliedIds: string[] = [];
  const leftPendingIds: string[] = [];
  for (const a of p.pending) {
    if (a.kind === "CREDIT") continue;
    running += a.amountCents;
    appliedIds.push(a.id);
  }
  let carryover: ComposedCharge["carryover"] = null;
  let remainingCredit: ComposedCharge["remainingCredit"] = null;
  for (const a of p.pending) {
    if (a.kind !== "CREDIT") continue;
    if (running === 0) {
      leftPendingIds.push(a.id);
      continue;
    }
    appliedIds.push(a.id);
    const after = running + a.amountCents;
    if (after >= 0) {
      running = after;
      continue;
    }
    carryover = { amountCents: -after, splitFromId: a.id };
    remainingCredit = { amountCents: after, splitFromId: a.id };
    running = 0;
  }
  return { baseCents: p.baseCents, adjustmentsCents: running - p.baseCents, amountCents: running, appliedIds, carryover, remainingCredit, leftPendingIds };
}

// ── Montos y saldo ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Monto del cargo: el precio a medida del consultorio gana sobre el del plan. `null` = no se cobra (el plan está en
 * «Consultá», PL-D19, y no hay precio a medida). Un 0 explícito sí es un precio (bonificado): genera un cargo de $0
 * que nace pagado (ver `chargeInitialState`).
 */
export function chargeAmountFor(p: { customPriceCents: number | null; planPriceCents: number | null }): number | null {
  const v = p.customPriceCents ?? p.planPriceCents;
  if (v === null || v === undefined) return null;
  if (!Number.isInteger(v) || v < 0) throw new Error(`[saas-billing-logic] precio inválido: ${String(v)}`);
  return v;
}

/** Un cargo de $0 nace PAID (no hay nada que cobrar ni que vencer). */
export function chargeInitialState(amountCents: number): { status: SaasChargeStatus; paid: boolean } {
  return amountCents === 0 ? { status: "PAID", paid: true } : { status: "OPEN", paid: false };
}

export type ChargeForBalance = {
  status: SaasChargeStatus;
  amountCents: number;
  /** Pagos APROBADOS imputados a este cargo. */
  approvedCents: number;
  dueDate: DateKey;
};

/** Lo que falta pagar de un cargo abierto (nunca negativo). */
export function remainingCents(c: ChargeForBalance): number {
  if (c.status !== "OPEN") return 0;
  return Math.max(0, c.amountCents - c.approvedCents);
}

/** Saldo de la cuenta: deuda de los cargos abiertos menos los pagos aprobados sin cargo (a cuenta). > 0 = debe. */
export function balanceCents(charges: readonly ChargeForBalance[], unappliedCreditCents: number): number {
  return charges.reduce((s, c) => s + remainingCents(c), 0) - unappliedCreditCents;
}

/** Cargo abierto, con algo por pagar y con el vencimiento ya pasado (el día del vencimiento todavía está al día). */
export function isOverdue(c: ChargeForBalance, todayKey: DateKey): boolean {
  return remainingCents(c) > 0 && c.dueDate < todayKey;
}

/** ¿Los pagos aprobados alcanzan para saldar el cargo? */
export function settles(amountCents: number, approvedCents: number): boolean {
  return approvedCents >= amountCents;
}

// ── Estado de la suscripción ────────────────────────────────────────────────────────────────────────────────────

/**
 * Estado que corresponde según los cargos, o `null` si no cambia. Reglas (PL2b-D2/D3/D4):
 *  - CANCELLED: nunca lo toca el cobro.
 *  - con un cargo vencido: ACTIVE → PAST_DUE (la gracia de 10 días la cuenta `tenantAccessFor` desde
 *    `subscriptionStatusChangedAt`, que el escritor único estampa solo si el estado cambia de verdad).
 *  - sin vencidos: PAST_DUE → ACTIVE; TRIALING con la prueba terminada y al menos un cargo saldado → ACTIVE.
 * Una prueba en curso, o vencida sin pagar, queda como está (la corta la regla de la prueba).
 */
export function nextSubscriptionStatus(p: {
  current: SubscriptionStatus;
  trialEndsAt: Date | null;
  now: Date;
  hasOverdue: boolean;
  hasSettledCharge: boolean;
}): SubscriptionStatus | null {
  if (p.current === "CANCELLED") return null;
  if (p.hasOverdue) return p.current === "ACTIVE" ? "PAST_DUE" : null;
  if (p.current === "PAST_DUE") return "ACTIVE";
  if (p.current === "TRIALING") {
    const trialOver = !p.trialEndsAt || toARDateKey(p.trialEndsAt) < toARDateKey(p.now);
    return trialOver && p.hasSettledCharge ? "ACTIVE" : null;
  }
  return null;
}

// ── Claves de idempotencia de los mails del cron (van a `PlatformAuditEvent.idempotencyKey`, UNIQUE) ──────────

export function chargeCreatedMailKey(chargeId: string): string {
  return `cron.billing_charge_created:${chargeId}`;
}

/** Un aviso por cada vez que el consultorio pasa a PAST_DUE (la fecha del cambio va en la clave). */
export function pastDueMailKey(tenantId: string, statusChangedAt: Date): string {
  return `cron.billing_past_due:${tenantId}:${statusChangedAt.toISOString()}`;
}

export function priceChangeMailKey(priceChangeId: string, tenantId: string): string {
  return `cron.billing_price_change:${priceChangeId}:${tenantId}`;
}

// ── Cargo sugerido al pagar (PL-F1a) ───────────────────────────────────────────────────────────────────────────
//
// Decisión de Martin (16-oct): «deberíamos poder seleccionar qué paga, pero sí, debería ser el último impago (por
// deducción, no se puede deber dos meses: cuando se debe uno solo la plataforma se bloquea)». Antes los drawers
// sugerían el cargo pendiente MÁS VIEJO; ahora el más reciente. Esto es solo el default de la UI: la imputación
// automática del saldo a cuenta (`applyCreditInTx`) sigue yendo del más viejo al más nuevo, que es lo correcto
// contablemente cuando no se eligió cargo.

export type PayableChargeLike = { id: string; status: SaasChargeStatus; periodStart: DateKey; remainingCents: number };

/** Cargos que se pueden pagar (OPEN con saldo), del período más reciente al más viejo (el primero es el sugerido). */
export function payableChargesNewestFirst<T extends PayableChargeLike>(charges: readonly T[]): T[] {
  return charges
    .filter((c) => c.status === "OPEN" && c.remainingCents > 0)
    .sort((a, b) => (a.periodStart > b.periodStart ? -1 : a.periodStart < b.periodStart ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Id del último impago (el período OPEN con saldo más reciente); "" = no hay, se paga a cuenta. */
export function suggestedChargeId(charges: readonly PayableChargeLike[]): string {
  return payableChargesNewestFirst(charges)[0]?.id ?? "";
}

// ── Comprobantes (PL-D22) ───────────────────────────────────────────────────────────────────────────────────────

export const RECEIPT_MAX_BYTES = 4 * 1024 * 1024;
export const RECEIPT_MIME_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp"] as const;
export type ReceiptMimeType = (typeof RECEIPT_MIME_TYPES)[number];
export const RECEIPT_EXT: Record<ReceiptMimeType, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/**
 * Tipo REAL del archivo por sus primeros bytes (no por el nombre ni por el `type` que manda el navegador, que el
 * cliente controla). `null` = no es ninguno de los cuatro permitidos.
 */
export function sniffReceiptType(b: Uint8Array): ReceiptMimeType | null {
  const at = (i: number, ...bytes: number[]) => bytes.every((x, k) => b[i + k] === x);
  if (b.length >= 5 && at(0, 0x25, 0x50, 0x44, 0x46, 0x2d)) return "application/pdf"; // %PDF-
  if (b.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (b.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (b.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp"; // RIFF….WEBP
  return null;
}

export type ReceiptCheck =
  | { ok: true; mimeType: ReceiptMimeType; ext: string; sizeBytes: number }
  | { ok: false; reason: "empty" | "too_large" | "type_not_allowed" | "type_mismatch" };

/**
 * Validación completa ANTES de Storage: tamaño (1 B..4 MB), tipo declarado permitido, y que los bytes digan lo mismo
 * que el tipo declarado (un `.exe` renombrado a `.pdf` o un PNG declarado como PDF se rechazan).
 */
export function checkReceipt(p: { declaredType: string; sizeBytes: number; head: Uint8Array }): ReceiptCheck {
  if (p.sizeBytes <= 0) return { ok: false, reason: "empty" };
  if (p.sizeBytes > RECEIPT_MAX_BYTES) return { ok: false, reason: "too_large" };
  const declared = p.declaredType.trim().toLowerCase();
  if (!(RECEIPT_MIME_TYPES as readonly string[]).includes(declared)) return { ok: false, reason: "type_not_allowed" };
  const real = sniffReceiptType(p.head);
  if (real !== declared) return { ok: false, reason: "type_mismatch" };
  return { ok: true, mimeType: real, ext: RECEIPT_EXT[real], sizeBytes: p.sizeBytes };
}

export const RECEIPT_ERROR_COPY: Record<Exclude<ReceiptCheck, { ok: true }>["reason"], string> = {
  empty: "El archivo está vacío.",
  too_large: "El comprobante pesa más de 4 MB. Probá con una foto más liviana o un PDF.",
  type_not_allowed: "Subí el comprobante en PDF, JPG, PNG o WEBP.",
  type_mismatch: "El archivo no es lo que dice ser. Subí el comprobante original en PDF, JPG, PNG o WEBP.",
};

/** Clave del objeto en el bucket privado: siempre la arma el server (nunca viene del cliente). */
export function receiptStorageKey(tenantId: string, paymentId: string, ext: string): string {
  return `${tenantId}/${paymentId}.${ext}`;
}
