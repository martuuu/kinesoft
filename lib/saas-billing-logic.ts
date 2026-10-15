/**
 * Lógica pura de los cobros de la suscripción (PL-2b, contratos C-PL7..10 recortados: SIN Mercado Pago, decisión de
 * Martin del 16-oct; plan §20.5.6 y la nota final de §20.18). Sin DB, sin env, sin `next/*`: la usan
 * `lib/saas-billing-internal.ts` (canal service), las actions de Configuración y de Plataforma y los unit tests en
 * TZ=UTC y TZ=AR.
 *
 * Fechas: un período es «del 5 de este mes al 5 del que viene» en Argentina, no un instante UTC. Por eso todo se
 * calcula sobre CLAVES de fecha civil AR («YYYY-MM-DD», `toARDateKey`) con aritmética `Date.UTC` (no depende del TZ
 * del host: en Vercel corre en UTC y en la máquina de Martin en AR, y los dos tienen que dar lo mismo). Las columnas
 * `SaasCharge.periodStart/periodEnd/dueDate` son `DATE`: Prisma las lee y escribe como medianoche UTC del día, así
 * que la conversión clave ↔ Date de esas columnas es la UTC (`dbDateFromKey` / `keyFromDbDate`); el resto de los
 * instantes (`trialEndsAt`, `createdAt`, `now`) pasan por `toARDateKey`.
 *
 * Decisiones con default (anotadas en el reporte de PL-2b):
 *  - PL2b-D1 día de anclaje = el día siguiente al fin de la prueba (o el día del alta si no hubo prueba), con tope
 *    28 para que exista en todos los meses. Si ese día es 29..31, el primer período arranca el 28 SIGUIENTE (unos días
 *    de regalo, nunca un cobro superpuesto con la prueba; sin prorrateo, PL-D9).
 *  - PL2b-D2 el cargo vence `CHARGE_DUE_DAYS` (5) días después de empezar el período; vencido y sin pagar → PAST_DUE,
 *    y desde ahí corren los 10 días de gracia de `tenantAccessFor` (BO-D3) antes del modo lectura.
 *  - PL2b-D3 un consultorio en prueba con la prueba vencida y sin pagar NO pasa a PAST_DUE: sigue TRIALING y lo corta
 *    la regla de la prueba (7 días de gracia, BO-D2), que es más corta. Pasa a ACTIVE cuando salda un cargo.
 *  - PL2b-D4 CANCELLED lo pone y lo saca solo Plataforma: el cobro nunca lo toca.
 */
import type { SaasChargeStatus, SubscriptionStatus } from "@prisma/client";
import { toARDateKey } from "@/lib/datetime-ar";

/** «YYYY-MM-DD» de una fecha civil en Argentina. */
export type DateKey = string;

const DAY_MS = 86_400_000;
const KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** PL2b-D1: el día de anclaje existe en todos los meses (CHECK 1..28 de `SaasSubscription.anchorDay`). */
export const MAX_ANCHOR_DAY = 28;
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
 * Primer día que se cobra (PL2b-D1): el siguiente al último día de prueba (en AR), o el día del alta si no hubo
 * prueba. `trialEndsAt` es el FIN del último día de prueba (molde de `tenantAccessFor`: su día AR es el último día).
 */
export function billingStartKey(t: { trialEndsAt: Date | null; createdAt: Date }): DateKey {
  if (t.trialEndsAt) return addDaysKey(toARDateKey(t.trialEndsAt), 1);
  return toARDateKey(t.createdAt);
}

export function anchorDayFor(startKey: DateKey): number {
  return Math.min(dayOfKey(startKey), MAX_ANCHOR_DAY);
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
