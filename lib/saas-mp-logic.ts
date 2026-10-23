/**
 * Lógica pura de la suscripción SaaS con Mercado Pago (MPS-1a, contrato C-MPS2, plan §26.6 y enmienda §22.6: cobro el
 * día 4). Sin DB, sin env, sin red, sin `next/*`: la usan el puerto (`lib/mercadopago-saas.ts`), los consumidores del
 * webhook (`lib/saas-billing-mp-internal.ts`), la conciliación (`lib/saas-mp-sync-internal.ts`) y los unit tests en
 * TZ=UTC y TZ=AR. El mínimo del débito llega por parámetro (el env `MP_MIN_DEBIT_CENTS` lo lee quien llama).
 *
 * Fechas: igual que `lib/saas-billing-logic.ts`, todo sobre claves civiles AR. El único instante que se arma acá es el
 * `start_date` del preapproval, y se arma como literal con `-03:00` (AR no tiene horario de verano desde 2009).
 */
import type { SaasCollectionMethod, SaasPaymentStatus, SubscriptionStatus } from "@prisma/client";
import { toARDateKey } from "@/lib/datetime-ar";
import { addMonthsKey, dayOfKey, isDateKey, SAAS_ANCHOR_DAY, type DateKey } from "@/lib/saas-billing-logic";

/**
 * S5 de `scripts/diagnose-mp-subscriptions.ts`: MP rechaza un preapproval de menos de $15 (ARS). Un débito chico
 * (un cargo casi saldado por un crédito) se sube a este mínimo; lo que sobra queda como saldo a favor.
 */
export const MP_MIN_DEBIT_CENTS = 1500;

/** Margen mínimo entre ahora y el `start_date` del preapproval: MP rechaza fechas pasadas o demasiado cercanas. */
const DEBIT_START_MARGIN_MS = 60 * 60_000;
/** Hora del débito (AR): después del cron del día 4, que crea los cargos de madrugada. */
const DEBIT_HOUR_AR = "08:00:00.000";

function keyOf(d: DateKey | Date): DateKey {
  if (typeof d === "string") {
    if (!isDateKey(d)) throw new Error(`[saas-mp-logic] clave de fecha inválida: ${d}`);
    return d;
  }
  return toARDateKey(d);
}

function anchorOfMonth(key: DateKey): DateKey {
  return `${key.slice(0, 8)}${String(SAAS_ANCHOR_DAY).padStart(2, "0")}`;
}

// ── start_date del preapproval ─────────────────────────────────────────────────────────────────────────────────

/**
 * `start_date` del preapproval (§22.6): el próximo día 4 a las 08:00 −03:00 que esté a ≥ 60′ de `now` y que no sea
 * anterior al primer cargo (`firstChargeKey`: fin de la prueba o el próximo cobro; con un ancla legada que no cae
 * en 4, el primer 4 posterior). Se devuelve el literal que se manda a MP, «YYYY-MM-04T08:00:00.000-03:00».
 * Ejemplos: 23:00 del 3 → el 4 de ese mes; 06:59 del 4 → ese mismo día; 07:30 del 4 → el 4 del mes siguiente.
 */
export function debitStartInstant(now: Date, firstChargeKey: DateKey): string {
  const minKey = keyOf(firstChargeKey);
  let key = anchorOfMonth(toARDateKey(now));
  if (key < minKey) key = anchorOfMonth(minKey);
  if (key < minKey) key = addMonthsKey(key, 1);
  for (;;) {
    const literal = `${key}T${DEBIT_HOUR_AR}-03:00`;
    if (new Date(literal).getTime() - now.getTime() >= DEBIT_START_MARGIN_MS) return literal;
    key = addMonthsKey(key, 1);
  }
}

// ── Monto deseado del débito ───────────────────────────────────────────────────────────────────────────────────

export type DesiredDebit =
  | { status: "authorized"; amountCents: number; basis: "projection" | "base" }
  | { status: "paused"; reason: "zero" | "no_price" | "cancel_scheduled" }
  | { status: "cancelled"; reason: "subscription_cancelled" | "method" | "not_allowed" };

/**
 * Cómo tiene que estar el preapproval hoy (la conciliación lo compara con lo que dice MP y hace un PUT si difiere):
 *  - CANCELLED, débito bloqueado por Plataforma (`autoDebitAllowed`) o método ≠ AUTO_DEBIT → `cancelled`.
 *  - baja programada → `paused` (MPS-D6: el débito se pausa ya; «Deshacer baja» lo reanuda).
 *  - los días 3 y 4 (AR) → la proyección del cargo del 4 (base + ajustes, `composeCharge`): es el único momento en que
 *    el monto del débito refleja proporcionales y créditos («PUT del monto el 3, restaurado el 5», §22.6).
 *  - el resto del mes → la base del próximo período (el monto que MP muestra al consultorio como «próximo débito»).
 * En los dos casos: 0 → `paused` (no hay nada que debitar este ciclo), `null` → `paused` (plan en «Consultá»),
 * 0 < x < mínimo → el mínimo de MP (`minDebitCents`, default `MP_MIN_DEBIT_CENTS`).
 */
export function desiredDebit(p: {
  today: DateKey | Date;
  subscriptionStatus: SubscriptionStatus;
  collectionMethod: SaasCollectionMethod | null;
  autoDebitAllowed: boolean;
  cancelAtPeriodEnd: boolean;
  /** Base del próximo período (precio del plan que rige ese día, con el precio a medida que corresponda). */
  nextBaseCents: number | null;
  /** Proyección del cargo del 4 (base + ajustes pendientes); el día 4, lo que queda por pagar del cargo de hoy. */
  projectedCents: number | null;
  minDebitCents?: number;
}): DesiredDebit {
  if (p.subscriptionStatus === "CANCELLED") return { status: "cancelled", reason: "subscription_cancelled" };
  if (p.collectionMethod !== "AUTO_DEBIT") return { status: "cancelled", reason: "method" };
  if (!p.autoDebitAllowed) return { status: "cancelled", reason: "not_allowed" };
  if (p.cancelAtPeriodEnd) return { status: "paused", reason: "cancel_scheduled" };
  const day = dayOfKey(keyOf(p.today));
  const inWindow = day === SAAS_ANCHOR_DAY - 1 || day === SAAS_ANCHOR_DAY;
  const basis = inWindow ? "projection" : "base";
  const cents = inWindow ? p.projectedCents : p.nextBaseCents;
  if (cents === null || cents === undefined) return { status: "paused", reason: "no_price" };
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error(`[saas-mp-logic] monto inválido: ${String(cents)}`);
  if (cents === 0) return { status: "paused", reason: "zero" };
  const min = p.minDebitCents ?? MP_MIN_DEBIT_CENTS;
  return { status: "authorized", amountCents: Math.max(cents, min), basis };
}

// ── external_reference ─────────────────────────────────────────────────────────────────────────────────────────

const SAAS_REF_PREFIX = "saas:";
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SAAS_REF_RE = /^saas:([A-Za-z0-9_-]{1,64})(?::([A-Za-z0-9_-]{1,64}))?$/;

/**
 * `external_reference` de todo lo que la plataforma le cobra a un consultorio: `saas:<tenantId>` (preapproval) o
 * `saas:<tenantId>:<chargeId>` (checkout de un cargo). El prefijo es lo que el camino legado del webhook
 * (`consumeWebhook`) usa para delegar (C-MPS6): nunca puede chocar con las referencias de turnos.
 */
export function saasExternalReference(tenantId: string, chargeId?: string | null): string {
  if (!ID_RE.test(tenantId)) throw new Error("[saas-mp-logic] tenantId inválido para external_reference");
  if (chargeId === null || chargeId === undefined) return `${SAAS_REF_PREFIX}${tenantId}`;
  if (!ID_RE.test(chargeId)) throw new Error("[saas-mp-logic] chargeId inválido para external_reference");
  return `${SAAS_REF_PREFIX}${tenantId}:${chargeId}`;
}

/** Inversa estricta de `saasExternalReference`; cualquier otra cosa (incluido lo que viene de un turno) → `null`. */
export function parseSaasExternalReference(ref: string | null | undefined): { tenantId: string; chargeId: string | null } | null {
  if (typeof ref !== "string") return null;
  const m = SAAS_REF_RE.exec(ref);
  if (!m) return null;
  return { tenantId: m[1], chargeId: m[2] ?? null };
}

// ── Estados de pago ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Estado de un pago de MP → `SaasPaymentStatus`. MPS-D15: solo aprobado, rechazado y reintegrado crean o cambian
 * filas; todo lo demás (pending, in_process, authorized, in_mediation, desconocido) → `null` y se espera el próximo
 * webhook. `charged_back` (contracargo) se trata como reintegro: la plata ya no está; `cancelled` como rechazo.
 */
export function mapMpPaymentStatus(status: string | null | undefined): SaasPaymentStatus | null {
  switch (status) {
    case "approved":
      return "APPROVED";
    case "rejected":
    case "cancelled":
      return "REJECTED";
    case "refunded":
    case "charged_back":
      return "REFUNDED";
    default:
      return null;
  }
}

/**
 * Transición del estado de un pago de MP ya registrado (`current`, `null` = no hay fila) con lo que dice MP ahora.
 * `null` = no se escribe nada (pendiente, replay sin cambios o transición imposible). Reglas:
 *  - APPROVED → solo REFUNDED (MP no «des-aprueba»; un rechazo tardío de un aprobado es un webhook viejo).
 *  - REJECTED → APPROVED (reintento aprobado); REJECTED → REFUNDED no existe.
 *  - REFUNDED es terminal.
 *  - PENDING_REVIEW es de las transferencias: un pago de MP nunca lo tiene; si apareciera, se trata como «sin fila».
 */
export function nextSaasPaymentStatus(current: SaasPaymentStatus | null, incoming: SaasPaymentStatus | null): SaasPaymentStatus | null {
  if (incoming === null) return null;
  if (current === null || current === "PENDING_REVIEW") return incoming === "PENDING_REVIEW" ? null : incoming;
  if (current === incoming) return null;
  if (current === "APPROVED") return incoming === "REFUNDED" ? "REFUNDED" : null;
  if (current === "REJECTED") return incoming === "APPROVED" ? "APPROVED" : null;
  return null;
}

// ── Período de un débito ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Días antes del 4 en que un débito se considera ADELANTADO (va al período que arranca) y no un reintento tardío del
 * anterior. MP debita el `start_date` (4, 08:00 AR) o reintenta los días siguientes (hasta ~10 días); un débito del
 * 2-3 solo puede ser el del ciclo que viene corrido por el TZ de MP. El 1 y el fin de mes siguen siendo reintentos.
 */
const EARLY_DEBIT_DAYS = 2;

/**
 * Período (su `periodStart`, un 4) al que se imputa un débito automático (C-MPS7): el que contiene su día AR, salvo
 * los débitos adelantados (ver `EARLY_DEBIT_DAYS`). Si el cargo de ese período todavía no existe, el consumidor lo
 * deja como saldo a favor.
 */
export function periodStartForDebit(debitAt: Date | DateKey): DateKey {
  const key = keyOf(debitAt);
  const day = dayOfKey(key);
  const thisMonth = anchorOfMonth(key);
  if (day >= SAAS_ANCHOR_DAY - EARLY_DEBIT_DAYS) return thisMonth;
  return addMonthsKey(thisMonth, -1);
}

// ── mpPayload: allow-list del recurso de MP ─────────────────────────────────────────────────────────────────────

const MAX_STR = 256;
const MAX_PAYLOAD_CHARS = 8_000; // holgado bajo el CHECK de 16 KB (pg_column_size del JSONB)

type Scalar = "s" | "n" | "b";
type Shape = { [k: string]: Scalar | "sn" | Shape };

/**
 * Lo único que se guarda de un pago, preapproval o authorized_payment de MP (`SaasPayment.mpPayload`, auditoría y
 * soporte). Fuera, a propósito: `payer` (email, DNI/CUIT), `card` (últimos 4, titular), `additional_info` (IP),
 * `metadata`, `point_of_interaction` y cualquier campo nuevo que MP agregue. Mejor que falte un dato a guardar PII.
 */
const SHAPE: Shape = {
  id: "sn",
  status: "s",
  status_detail: "s",
  type: "s",
  operation_type: "s",
  transaction_amount: "n",
  transaction_amount_refunded: "n",
  currency_id: "s",
  external_reference: "s",
  collector_id: "sn",
  preapproval_id: "s",
  payment_method_id: "s",
  payment_type_id: "s",
  date_created: "s",
  date_approved: "s",
  date_last_updated: "s",
  last_modified: "s",
  debit_date: "s",
  next_payment_date: "s",
  next_retry_date: "s",
  retry_attempt: "n",
  reason: "s",
  live_mode: "b",
  auto_recurring: { frequency: "n", frequency_type: "s", transaction_amount: "n", currency_id: "s", start_date: "s", end_date: "s" },
  payment: { id: "sn", status: "s", status_detail: "s" },
};

function pick(src: Record<string, unknown>, shape: Shape): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, t] of Object.entries(shape)) {
    const v = src[k];
    if (v === null || v === undefined) continue;
    if (typeof t === "object") {
      if (typeof v === "object" && !Array.isArray(v)) out[k] = pick(v as Record<string, unknown>, t);
      continue;
    }
    if (typeof v === "string" && (t === "s" || t === "sn")) out[k] = v.slice(0, MAX_STR);
    else if (typeof v === "number" && Number.isFinite(v) && (t === "n" || t === "sn")) out[k] = v;
    else if (typeof v === "boolean" && t === "b") out[k] = v;
  }
  return out;
}

/**
 * Allow-list del recurso de MP para `mpPayload` (CHECK: objeto ≤ 16 KB). Nunca tira: basura → `{}`. Si aun así
 * pasara el tope (no debería con strings de ≤ 256), se queda con id y estado.
 */
export function redactMpSaas(resource: unknown): Record<string, unknown> {
  if (resource === null || typeof resource !== "object" || Array.isArray(resource)) return {};
  const out = pick(resource as Record<string, unknown>, SHAPE);
  if (JSON.stringify(out).length <= MAX_PAYLOAD_CHARS) return out;
  return pick(out, { id: "sn", status: "s", status_detail: "s" });
}
