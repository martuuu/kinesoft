import "server-only";
import { createHash } from "node:crypto";
import { BRAND_NAME } from "@/lib/brand";
import { fakeMpAllowed, saasBillingMode, saasMpCheckoutNotify } from "@/lib/env";
import { parseARS } from "@/lib/format";
import { AR_OFFSET } from "@/lib/datetime-ar";
import { MP_API_BASE, MP_FAKE_PATH, MP_USERS_ME_PATH } from "@/lib/mp-connect/constants";
import { mpAppUrl, mpFetch, type MpFetchResult } from "@/lib/mp-connect/http";

/**
 * Puerto de Mercado Pago de la SUSCRIPCIÓN SaaS (T6 MPS-1b, C-MPS3, brief §26.6; ADR-027). Lo único del repo que habla
 * con MP con el token de la PLATAFORMA para cobrarle a los consultorios: preapprovals (débito automático), sus débitos
 * (`authorized_payments`), los pagos y el checkout de un cargo puntual («Pagar con Mercado Pago»).
 *
 * Reglas del contrato:
 *   - **Nunca tira.** Todo vuelve como `R<T>`: `{ ok: true, data }` o `{ ok: false, kind }`. Los callers (actions, cron,
 *     webhook) deciden; un MP caído no puede tumbar un request ni el cron diario.
 *   - **Nunca adentro de una transacción.** Una llamada a MP dura hasta 8 s (`MP_HTTP_TIMEOUT_MS`): adentro de una tx
 *     retendría locks del Tenant y de la suscripción todo ese tiempo. El patrón es leer → llamar a MP afuera → escribir
 *     en una tx corta (y ante un webhook, volver a pedir el recurso acá antes de confiar en él).
 *   - **Token de la plataforma leído en vivo** (`process.env.MP_ACCESS_TOKEN` en cada llamada: los tests y la rotación
 *     lo cambian en caliente; `env` se congela al importar). En modo fake se usa SIEMPRE el token falso de la plataforma
 *     del simulador y nunca el de `.env*`: así un token real no viaja ni a localhost.
 *   - **Host:** `${APP}/api/mp/fake` si `fakeMpAllowed()` (MP_CONNECT_MODE=fake y fuera de Vercel; MPS-D8: el mismo
 *     simulador de T5); si no, la API real. Por eso `mpFetch` recibe `apiBase`: el modo de T5 (`MP_CONNECT_MODE=off`, sin
 *     cobros online) no tiene por qué apagar la suscripción.
 *   - **Apagado** (`SAAS_BILLING_MODE` ≠ `mp`, o sin token fuera del fake) → `{ ok: false, kind: "off" }` sin tocar la red.
 *
 * Plata: centavos `Int` adentro; MP recibe el decimal `cents / 100` (el double exacto que produce `JSON.parse`, igual que
 * `lib/mp-connect/preference.ts`) y lo que vuelve se convierte con `parseARS` (nunca `Number()*100`). Fechas hacia MP con
 * el offset de AR explícito: con el reloj del host, en Vercel (UTC) «el 4 a las 08:00» saldría corrido.
 *
 * Los ids que vienen de afuera (webhook, base) se validan antes de armar un path: un `data.id` con `/` o `..` no puede
 * apuntar a otro endpoint de MP con el token de la plataforma.
 */

export type SaasMpErrorKind = "off" | "network" | "timeout" | "http" | "invalid";
export type R<T> = { ok: true; data: T } | { ok: false; kind: SaasMpErrorKind; status?: number };

export type SaasPreapprovalStatus = "pending" | "authorized" | "paused" | "cancelled";

export type SaasPreapproval = {
  id: string;
  /** Estado de MP. Uno desconocido (MP sumó otro) vuelve como `invalid`: el caller no adivina. */
  status: SaasPreapprovalStatus;
  /** URL de la página de MP donde el titular carga la tarjeta (solo tiene sentido en `pending`). */
  initPoint: string | null;
  payerEmail: string | null;
  externalReference: string | null;
  collectorId: string | null;
  /** Monto mensual vigente del débito. */
  amountCents: number | null;
  startDate: Date | null;
  nextPaymentDate: Date | null;
  lastModified: Date | null;
};

export type SaasAuthorizedPayment = {
  id: string;
  preapprovalId: string;
  /** Crudo de MP: `scheduled` | `processed` | `recycling` | `cancelled` (otros pasan tal cual). */
  status: string;
  amountCents: number;
  debitDate: Date | null;
  payment: { id: string; status: string } | null;
};

export type SaasPayment = {
  id: string;
  /** Crudo de MP (`approved`, `rejected`, `refunded`, `pending`…): lo mapea `saas-mp-logic` (MPS-1a). */
  status: string;
  amountCents: number;
  collectorId: string | null;
  externalReference: string | null;
  /** El preapproval de un débito automático; null en un pago de checkout. */
  preapprovalId: string | null;
  approvedAt: Date | null;
  /** C-MPS7 exige ARS: se expone para que el consumidor lo chequee (MPS-1b lo suma al contrato). */
  currencyId: string | null;
  refundedCents: number;
};

export type SaasChargeCheckout = { preferenceId: string; initPoint: string; expiresAt: Date };

/** Vida del link de pago de un cargo (C-MPS3: 72 h). */
export const SAAS_CHECKOUT_TTL_MS = 72 * 3600_000;
/** Memo del collector de la plataforma (C-MPS3: 10′). */
const COLLECTOR_MEMO_MS = 10 * 60_000;

/**
 * Literal del token falso de la plataforma. Duplicado A PROPÓSITO de `FAKE_MP_PLATFORM` (`lib/mp-connect/fake-mp.ts`):
 * importar el fake acá lo metería en el bundle de cada server action que use el puerto. El unit de MPS-1b afirma que el
 * fake lo reconoce (si cambia uno solo, el test cae).
 */
const FAKE_PLATFORM_ACCESS_TOKEN = "FAKE-PLATFORM-ACCESS-TOKEN";

function fakeMode(): boolean {
  return fakeMpAllowed();
}

function platformToken(): string | null {
  if (fakeMode()) return FAKE_PLATFORM_ACCESS_TOKEN;
  const t = process.env.MP_ACCESS_TOKEN?.trim();
  return t ? t : null;
}

function apiBase(): string {
  return fakeMode() ? `${mpAppUrl().replace(/\/+$/, "")}${MP_FAKE_PATH}` : MP_API_BASE;
}

/** ¿Está prendido el cobro de la suscripción por Mercado Pago? `SAAS_BILLING_MODE=mp` y (fake o token de la plataforma). */
export function saasMpEnabled(): boolean {
  return saasBillingMode() === "mp" && platformToken() !== null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────

const OFF = { ok: false, kind: "off" } as const;
const INVALID = { ok: false, kind: "invalid" } as const;

/** Ids de MP (numéricos, hex de preapproval, `<collector>-<uuid>` de preferencia). Nada de `/`, `?`, `#` ni `..`. */
const MP_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

function errOf(r: Exclude<MpFetchResult, { ok: true }>): { ok: false; kind: SaasMpErrorKind; status?: number } {
  return r.kind === "http" ? { ok: false, kind: "http", status: r.status } : { ok: false, kind: r.kind };
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
/** MP manda ids numéricos como number y alfanuméricos como string: se normalizan a string. */
function idOf(v: unknown): string | null {
  if (typeof v === "number" && Number.isSafeInteger(v) && v > 0) return String(v);
  if (typeof v === "string" && MP_ID_RE.test(v)) return v;
  return null;
}
function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}
function dateOrNull(v: unknown): Date | null {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
function centsOf(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? parseARS(v) : null;
}

/** Centavos `Int` > 0 → decimal de MP. */
function unitPrice(cents: number): number | null {
  return Number.isInteger(cents) && cents > 0 ? cents / 100 : null;
}

/** `2026-12-04T08:00:00.000-03:00`: el instante en hora AR con el offset explícito (AR no tiene horario de verano). */
function arIso(d: Date): string {
  const offsetMin = Number(AR_OFFSET.slice(0, 3)) * 60;
  return `${new Date(d.getTime() + offsetMin * 60_000).toISOString().slice(0, 23)}${AR_OFFSET}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Envoltorio común: apagado → off; cualquier excepción inesperada (un bug de parseo, no la red: `mpFetch` ya no tira) →
 * `invalid`. Así se cumple «nunca tira» aunque el mapeo tenga un caso que no se previó.
 */
async function call<T>(fn: (token: string, base: string) => Promise<R<T>>): Promise<R<T>> {
  if (saasBillingMode() !== "mp") return OFF;
  const token = platformToken();
  if (!token) return OFF;
  try {
    return await fn(token, apiBase());
  } catch {
    return INVALID;
  }
}

// ── Collector de la plataforma ───────────────────────────────────────────────────────────────────────────────────

let collectorMemo: { key: string; id: string; expMs: number } | null = null;

/**
 * `user_id` de la cuenta de la plataforma (GET /users/me), memorizado 10′ por host + token. El consumidor del webhook
 * exige que el pago sea de este collector (C-MPS7): un pago de otro vendedor con una referencia `saas:` no se imputa.
 */
export async function platformCollectorId(): Promise<R<string>> {
  return call(async (token, base) => {
    const key = `${base}|${createHash("sha256").update(token).digest("hex").slice(0, 16)}`;
    if (collectorMemo && collectorMemo.key === key && collectorMemo.expMs > Date.now()) return { ok: true, data: collectorMemo.id };
    const r = await mpFetch(MP_USERS_ME_PATH, { token, apiBase: base });
    if (!r.ok) return errOf(r);
    const id = idOf(obj(r.json)?.id);
    if (!id) return INVALID;
    collectorMemo = { key, id, expMs: Date.now() + COLLECTOR_MEMO_MS };
    return { ok: true, data: id };
  });
}

// ── Preapprovals ─────────────────────────────────────────────────────────────────────────────────────────────────

const PRE_STATUSES = new Set<string>(["pending", "authorized", "paused", "cancelled"]);

function toPreapproval(json: unknown): SaasPreapproval | null {
  const o = obj(json);
  const id = idOf(o?.id);
  if (!o || !id || typeof o.status !== "string" || !PRE_STATUSES.has(o.status)) return null;
  const ar = obj(o.auto_recurring);
  return {
    id,
    status: o.status as SaasPreapprovalStatus,
    initPoint: strOrNull(o.init_point),
    payerEmail: strOrNull(o.payer_email),
    externalReference: strOrNull(o.external_reference),
    collectorId: idOf(o.collector_id),
    amountCents: centsOf(ar?.transaction_amount),
    startDate: dateOrNull(ar?.start_date),
    nextPaymentDate: dateOrNull(o.next_payment_date),
    lastModified: dateOrNull(o.last_modified),
  };
}

/**
 * Crea el preapproval PENDIENTE (sin tarjeta, «sin plan»): el titular lo autoriza en `initPoint` cargando la tarjeta en
 * MP. Mensual, ARS, primer débito en `startDate` (el próximo 4 a las 08:00 AR lo calcula `debitStartInstant`, MPS-1a).
 * Sin `billing_day` (MPS-D23: solo si S1 lo exige). `idempotencyKey` = `X-Idempotency-Key`: un reintento no crea dos.
 */
export async function createPreapproval(input: {
  reason: string;
  externalReference: string;
  payerEmail: string;
  amountCents: number;
  startDate: Date;
  backUrl: string;
  idempotencyKey: string;
}): Promise<R<SaasPreapproval>> {
  return call(async (token, base) => {
    const amount = unitPrice(input.amountCents);
    const reason = String(input.reason ?? "").trim().slice(0, 255);
    const email = String(input.payerEmail ?? "").trim();
    if (amount === null || !reason || !EMAIL_RE.test(email) || !input.externalReference) return INVALID;
    if (!(input.startDate instanceof Date) || Number.isNaN(input.startDate.getTime())) return INVALID;
    if (!input.idempotencyKey || !/^https?:\/\//.test(input.backUrl)) return INVALID;
    const body = {
      reason,
      external_reference: input.externalReference,
      payer_email: email,
      back_url: input.backUrl,
      status: "pending",
      auto_recurring: {
        frequency: 1,
        frequency_type: "months",
        transaction_amount: amount,
        currency_id: "ARS",
        start_date: arIso(input.startDate),
      },
    };
    const r = await mpFetch("/preapproval", { token, apiBase: base, method: "POST", body, idempotencyKey: input.idempotencyKey });
    if (!r.ok) return errOf(r);
    const p = toPreapproval(r.json);
    return p ? { ok: true, data: p } : INVALID;
  });
}

export async function getPreapproval(id: string): Promise<R<SaasPreapproval>> {
  return call(async (token, base) => {
    if (!MP_ID_RE.test(String(id ?? ""))) return INVALID;
    const r = await mpFetch(`/preapproval/${encodeURIComponent(id)}`, { token, apiBase: base });
    if (!r.ok) return errOf(r);
    const p = toPreapproval(r.json);
    return p ? { ok: true, data: p } : INVALID;
  });
}

/**
 * Pausa / reanuda / cancela y cambia el monto del débito. `cancelled` es terminal en MP (un PUT posterior → 400). Sin
 * cambios → `invalid` sin llamar (un PUT vacío no tiene sentido y MP lo rechaza igual).
 */
export async function updatePreapproval(
  id: string,
  patch: { status?: "authorized" | "paused" | "cancelled"; amountCents?: number }
): Promise<R<SaasPreapproval>> {
  return call(async (token, base) => {
    if (!MP_ID_RE.test(String(id ?? ""))) return INVALID;
    const body: Record<string, unknown> = {};
    if (patch.status !== undefined) {
      if (patch.status !== "authorized" && patch.status !== "paused" && patch.status !== "cancelled") return INVALID;
      body.status = patch.status;
    }
    if (patch.amountCents !== undefined) {
      const amount = unitPrice(patch.amountCents);
      if (amount === null) return INVALID;
      body.auto_recurring = { transaction_amount: amount, currency_id: "ARS" };
    }
    if (Object.keys(body).length === 0) return INVALID;
    const r = await mpFetch(`/preapproval/${encodeURIComponent(id)}`, { token, apiBase: base, method: "PUT", body });
    if (!r.ok) return errOf(r);
    const p = toPreapproval(r.json);
    return p ? { ok: true, data: p } : INVALID;
  });
}

// ── Débitos y pagos ──────────────────────────────────────────────────────────────────────────────────────────────

export async function getAuthorizedPayment(id: string): Promise<R<SaasAuthorizedPayment>> {
  return call(async (token, base) => {
    if (!MP_ID_RE.test(String(id ?? ""))) return INVALID;
    const r = await mpFetch(`/authorized_payments/${encodeURIComponent(id)}`, { token, apiBase: base });
    if (!r.ok) return errOf(r);
    const o = obj(r.json);
    const apId = idOf(o?.id);
    const preapprovalId = idOf(o?.preapproval_id);
    const amountCents = centsOf(o?.transaction_amount);
    if (!o || !apId || !preapprovalId || amountCents === null || typeof o.status !== "string") return INVALID;
    const pay = obj(o.payment);
    const payId = idOf(pay?.id);
    return {
      ok: true,
      data: {
        id: apId,
        preapprovalId,
        status: o.status,
        amountCents,
        debitDate: dateOrNull(o.debit_date),
        payment: pay && payId && typeof pay.status === "string" ? { id: payId, status: pay.status } : null,
      },
    };
  });
}

/**
 * Pago de la cuenta de la plataforma (GET /v1/payments/:id con su token). El preapproval de un débito sale de
 * `metadata.preapproval_id` o de `point_of_interaction.transaction_data.subscription_id` (MP lo documenta en el segundo;
 * el primero lo traen los pagos de suscripción en la práctica: S-diagnóstico lo confirma en sandbox).
 */
export async function getSaasPayment(id: string): Promise<R<SaasPayment>> {
  return call(async (token, base) => {
    if (!MP_ID_RE.test(String(id ?? ""))) return INVALID;
    const r = await mpFetch(`/v1/payments/${encodeURIComponent(id)}`, { token, apiBase: base });
    if (!r.ok) return errOf(r);
    const o = obj(r.json);
    const payId = idOf(o?.id);
    const amountCents = centsOf(o?.transaction_amount);
    if (!o || !payId || amountCents === null || typeof o.status !== "string") return INVALID;
    const meta = obj(o.metadata);
    const poi = obj(obj(o.point_of_interaction)?.transaction_data);
    return {
      ok: true,
      data: {
        id: payId,
        status: o.status,
        amountCents,
        collectorId: idOf(o.collector_id),
        externalReference: strOrNull(o.external_reference),
        preapprovalId: idOf(meta?.preapproval_id) ?? idOf(poi?.subscription_id),
        approvedAt: dateOrNull(o.date_approved),
        currencyId: strOrNull(o.currency_id),
        refundedCents: centsOf(o.transaction_amount_refunded) ?? 0,
      },
    };
  });
}

// ── Checkout de un cargo («Pagar con Mercado Pago») ──────────────────────────────────────────────────────────────

/**
 * `notification_url` del checkout de un cargo: la ruta de siempre con `?scope=saas` (MPS-D9) para que la ruta
 * (C-MPS6) la mande a la rama de la suscripción y verifique con `MP_WEBHOOK_SECRET`. `SAAS_MP_CHECKOUT_NOTIFY=panel` la
 * omite (MP avisa entonces al webhook configurado en el panel de la aplicación, sin `scope`, y el camino legado delega
 * por la referencia `saas:`): la salida por si S-diagnóstico muestra que MP no firma las notificaciones de una
 * `notification_url` propia. MPS-2b2: se lee por el getter de `lib/env.ts` (`scope|panel`, validado al boot); MPS-1b
 * había leído un `on|off` propio que el schema de ENV rechaza (conflicto del cierre de X1).
 */
function checkoutNotificationUrl(): string | null {
  if (saasMpCheckoutNotify() === "panel") return null;
  return `${mpAppUrl().replace(/\/+$/, "")}/api/webhooks/mercadopago?scope=saas`;
}

/** Vuelta del checkout: Configuración → Plan, con el cargo (lo lee `confirmCheckoutReturn`, MPS-3a). */
function checkoutBackUrl(chargeId: string): string {
  return `${mpAppUrl().replace(/\/+$/, "")}/configuracion?tab=facturacion&cargo=${encodeURIComponent(chargeId)}`;
}

/**
 * Link de pago de un cargo SaaS, cobrado por la PLATAFORMA. `binary_mode` (aprobado o rechazado: un «pendiente» dejaría
 * el cargo en el aire días), sin efectivo/cajero, vence a las 72 h, referencia `saas:<tenantId>:<chargeId>`. El título lo
 * arma el caller (sin datos de salud: es la suscripción de software).
 */
export async function createChargeCheckout(input: {
  tenantId: string;
  chargeId: string;
  title: string;
  amountCents: number;
  payerEmail: string;
  idempotencyKey: string;
  /** Default: Configuración → Plan con `?cargo=`. */
  backUrl?: string;
}): Promise<R<SaasChargeCheckout>> {
  return call(async (token, base) => {
    const amount = unitPrice(input.amountCents);
    const title = String(input.title ?? "").trim().slice(0, 120);
    // La referencia lleva `:` como separador: un id con `:` la volvería ambigua.
    const idOk = (v: string) => /^[A-Za-z0-9_-]{1,64}$/.test(String(v ?? ""));
    if (amount === null || !title || !idOk(input.tenantId) || !idOk(input.chargeId) || !input.idempotencyKey) return INVALID;
    const email = String(input.payerEmail ?? "").trim();
    const back = input.backUrl ?? checkoutBackUrl(input.chargeId);
    if (!/^https?:\/\//.test(back)) return INVALID;
    const expiresAt = new Date(Date.now() + SAAS_CHECKOUT_TTL_MS);
    const notificationUrl = checkoutNotificationUrl();
    const body: Record<string, unknown> = {
      items: [{ id: input.chargeId, title, quantity: 1, unit_price: amount, currency_id: "ARS" }],
      external_reference: `saas:${input.tenantId}:${input.chargeId}`,
      binary_mode: true,
      payment_methods: { excluded_payment_types: [{ id: "ticket" }, { id: "atm" }] },
      expires: true,
      expiration_date_to: arIso(expiresAt),
      back_urls: { success: back, failure: back, pending: back },
      auto_return: "approved",
      statement_descriptor: BRAND_NAME.normalize("NFD").replace(/[^A-Za-z0-9 ]+/g, "").slice(0, 22) || undefined,
      metadata: { tenantId: input.tenantId, chargeId: input.chargeId },
    };
    if (notificationUrl) body.notification_url = notificationUrl;
    // MPS-D21: el email lo tipea el usuario; uno inválido no frena el pago (MP lo pide en su checkout).
    if (EMAIL_RE.test(email)) body.payer = { email };
    const r = await mpFetch("/checkout/preferences", { token, apiBase: base, method: "POST", body, idempotencyKey: input.idempotencyKey });
    if (!r.ok) return errOf(r);
    const o = obj(r.json);
    const preferenceId = typeof o?.id === "string" && MP_ID_RE.test(o.id) ? o.id : null;
    // Con el token de producción el link es `init_point`; `sandbox_init_point` solo existe para cuentas de prueba.
    const initPoint = strOrNull(o?.init_point);
    if (!preferenceId || !initPoint) return INVALID;
    return { ok: true, data: { preferenceId, initPoint, expiresAt: new Date(Date.parse(String(body.expiration_date_to))) } };
  });
}

/**
 * Relee el link de pago de un cargo (MPS-2b2, `createOrReuseChargeCheckout`): la base guarda solo el id de la
 * preferencia, el monto esperado y cuándo se creó (M16), no el `init_point`, y el link no se arma a mano (el formato de
 * la URL es de MP). `expiresAt` null = la preferencia no vence. Una preferencia de otro collector → `http` 404.
 */
export async function getChargeCheckout(preferenceId: string): Promise<R<Omit<SaasChargeCheckout, "expiresAt"> & { expiresAt: Date | null }>> {
  return call(async (token, base) => {
    if (!MP_ID_RE.test(String(preferenceId ?? ""))) return INVALID;
    const r = await mpFetch(`/checkout/preferences/${encodeURIComponent(preferenceId)}`, { token, apiBase: base });
    if (!r.ok) return errOf(r);
    const o = obj(r.json);
    const id = typeof o?.id === "string" && MP_ID_RE.test(o.id) ? o.id : null;
    const initPoint = strOrNull(o?.init_point);
    if (!o || !id || !initPoint) return INVALID;
    const expiresAt = o.expires === true ? dateOrNull(o.expiration_date_to) : null;
    return { ok: true, data: { preferenceId: id, initPoint, expiresAt } };
  });
}

/** Vence el link de pago de un cargo (ya pagado, anulado, reemplazado): `expires` un minuto para atrás, como T5. */
export async function expireCheckout(preferenceId: string): Promise<R<true>> {
  return call(async (token, base) => {
    if (!MP_ID_RE.test(String(preferenceId ?? ""))) return INVALID;
    // Un minuto para atrás: el reloj de MP no tiene por qué coincidir con el nuestro al milisegundo.
    const body = { expires: true, expiration_date_to: arIso(new Date(Date.now() - 60_000)) };
    const r = await mpFetch(`/checkout/preferences/${encodeURIComponent(preferenceId)}`, { token, apiBase: base, method: "PUT", body });
    if (!r.ok) return errOf(r);
    return { ok: true, data: true };
  });
}

/** Solo tests: vacía el memo del collector. */
export function __resetSaasMpMemoForTests(): void {
  collectorMemo = null;
}
