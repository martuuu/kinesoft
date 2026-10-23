import "server-only";
import { randomBytes } from "node:crypto";
import { BRAND_NAME } from "@/lib/brand";
import { fakeMpAllowed } from "@/lib/env";
import { formatARS, parseARS } from "@/lib/format";
import { toARDateKey } from "@/lib/datetime-ar";
import { MP_FAKE_PATH } from "@/lib/mp-connect/constants";
import { mpAppUrl } from "@/lib/mp-connect/http";
import { FAKE_MP_PLATFORM, fakeMpKit, type FakeMpPaymentRec } from "@/lib/mp-connect/fake-mp";

/**
 * Mercado Pago FALSO · suscripción de la plataforma (T6 MPS-1b, C-MPS4, brief §26.6; MPS-D8: el MISMO simulador de T5,
 * extendido). Lo monta el router de `fake-mp.ts` (`fakeMpSaasHandle`), así que hereda sus barreras: 404 salvo
 * `MP_CONNECT_MODE=fake` y fuera de Vercel (`fakeMpAllowed()` en cada request y en cada simulación), y las
 * notificaciones solo van al origen de `NEXT_PUBLIC_APP_URL`.
 *
 * Qué imita (lo que usa el puerto `lib/mercadopago-saas.ts`; los supuestos sin consola se verifican con
 * `scripts/diagnose-mp-subscriptions.ts` S1-S10 en sandbox, que corre Martin):
 *   - `POST /preapproval` sin `card_token_id` → `pending` con `init_point` a la página de autorización (un preapproval
 *     «sin plan»). Valida `auto_recurring` mensual en ARS, `start_date` futuro y `billing_day` 1..28 si viene (MPS-D23:
 *     el puerto no lo manda). `X-Idempotency-Key` repetida → el mismo preapproval.
 *   - `GET|PUT /preapproval/:id`: pausar/reanudar y cambiar el monto. `pending` no se autoriza por API (hace falta la
 *     tarjeta) y `cancelled` es TERMINAL: cualquier PUT → 400, como MP. Los PUT por API no notifican (el que cambia ya
 *     sabe; ver el hallazgo del reporte: MP real sí podría avisar, y los consumidores tienen que ser idempotentes).
 *   - `GET /authorized_payments/:id`: el débito mensual, con su `payment` (el pago real, que además se lee en
 *     `/v1/payments/:id` porque vive en el store de pagos de T5 con `collector_id` de la plataforma).
 *   - Página `/subscriptions/checkout?preapproval_id=…`: «Autorizar débito (tarjeta de prueba)» / «Cancelar y volver»,
 *     las dos al `back_url` con `?preapproval_id=` (como MP).
 *   - Panel «Suscripciones» (dentro de `/panel`): débito aprobado o rechazado, reintento aprobado, reintegro y
 *     «Cancelar desde Mercado Pago».
 *   - Notificaciones FIRMADAS con `MP_WEBHOOK_SECRET` a `/api/webhooks/mercadopago?data.id=…&type=…`
 *     (`subscription_preapproval`, `subscription_authorized_payment` y `payment`), SIN `?scope=`: en MP real las de
 *     suscripción llegan al webhook configurado en la aplicación, no a una `notification_url` propia. Por eso la ruta
 *     (C-MPS6) rutea por topic, y el `payment` de un débito llega por el camino legado y se delega por la referencia
 *     `saas:`.
 *
 * Estado en `globalThis` aparte del de T5 (`resetFakeMp` vacía los dos). Los ids de preapproval son 32 hex en
 * minúscula, como los de MP: el manifiesto de la firma usa el `data.id` tal cual y MP pide minúsculas para los
 * alfanuméricos (ver `signature.ts`), así que con minúsculas no hay ambigüedad.
 */

export { FAKE_MP_PLATFORM };

export type FakePreapprovalStatus = "pending" | "authorized" | "paused" | "cancelled";
/** `retry_approved` = el reintento de MP sobre el último débito rechazado (mismo authorized_payment, pago nuevo). */
export type FakeDebitOutcome = "approved" | "rejected" | "retry_approved" | "refunded";

type PreRec = {
  id: string;
  collectorId: string;
  status: FakePreapprovalStatus;
  /** Body tal cual lo mandó el puerto (los tests afirman lo que salió: sin tarjeta, sin `billing_day`). */
  body: Record<string, unknown>;
  reason: string;
  externalReference: string | null;
  payerEmail: string;
  backUrl: string;
  amountCents: number;
  startDate: string;
  billingDay: number | null;
  nextPaymentDate: string | null;
  chargedQuantity: number;
  lastChargedDate: string | null;
  cardId: string | null;
  createdAt: string;
  updatedAt: string;
};

type AuthPayStatus = "scheduled" | "processed" | "recycling" | "cancelled";
type AuthPayRec = {
  id: string;
  preapprovalId: string;
  status: AuthPayStatus;
  amountCents: number;
  debitDate: string;
  retryAttempt: number;
  /** Último pago del débito (cada reintento crea uno nuevo, como MP). */
  paymentId: string | null;
  createdAt: string;
  updatedAt: string;
};

type SaasStore = {
  preapprovals: Map<string, PreRec>;
  authorized: Map<string, AuthPayRec>;
  /** `X-Idempotency-Key` → id del preapproval creado. */
  idem: Map<string, string>;
  seq: number;
  /** Lo último que hizo el panel, para que quien prueba vea qué respondió el webhook. */
  lastResult: string | null;
};

const SAAS_STORE_KEY = "__kinesoftFakeMpSaasStore";

function freshSaasStore(): SaasStore {
  return { preapprovals: new Map(), authorized: new Map(), idem: new Map(), seq: 0, lastResult: null };
}
function saasStore(): SaasStore {
  const g = globalThis as unknown as Record<string, SaasStore | undefined>;
  return (g[SAAS_STORE_KEY] ??= freshSaasStore());
}

/** Vacía el estado de la suscripción falsa (lo llama `resetFakeMp`). */
export function resetFakeMpSaas(): void {
  (globalThis as unknown as Record<string, SaasStore | undefined>)[SAAS_STORE_KEY] = freshSaasStore();
}

export class FakeMpSaasError extends Error {
  constructor(public code: "not_allowed" | "not_found" | "not_pending" | "not_authorized" | "nothing_to_retry" | "nothing_to_refund" | "bad_amount") {
    super(`fake_mp_saas:${code}`);
    this.name = "FakeMpSaasError";
  }
}

// ── Atajos para tests ────────────────────────────────────────────────────────────────────────────────────────────

export function fakeMpGetPreapproval(id: string): PreRec | null {
  return saasStore().preapprovals.get(id) ?? null;
}
export function fakeMpGetAuthorizedPayment(id: string): AuthPayRec | null {
  return saasStore().authorized.get(id) ?? null;
}

// ── Formato ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Un mes calendario más (día del mes conservado; si no existe, el último del mes). Suficiente para el simulador. */
function addMonth(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = d.getUTCDate();
  const n = new Date(d.getTime());
  n.setUTCDate(1);
  n.setUTCMonth(n.getUTCMonth() + 1);
  const last = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 0)).getUTCDate();
  n.setUTCDate(Math.min(day, last));
  return n.toISOString();
}

function initPointOf(id: string): string {
  return `${fakeMpKit.fakeBase()}/subscriptions/checkout?preapproval_id=${encodeURIComponent(id)}`;
}

function preJson(p: PreRec) {
  const auto: Record<string, unknown> = {
    frequency: 1,
    frequency_type: "months",
    transaction_amount: p.amountCents / 100,
    currency_id: "ARS",
    start_date: p.startDate,
  };
  if (p.billingDay !== null) auto.billing_day = p.billingDay;
  return {
    id: p.id,
    payer_id: null,
    payer_email: p.payerEmail,
    back_url: p.backUrl,
    collector_id: Number(p.collectorId),
    application_id: 1,
    status: p.status,
    reason: p.reason,
    external_reference: p.externalReference,
    date_created: p.createdAt,
    last_modified: p.updatedAt,
    init_point: initPointOf(p.id),
    sandbox_init_point: initPointOf(p.id),
    auto_recurring: auto,
    next_payment_date: p.nextPaymentDate,
    payment_method_id: p.cardId ? "visa" : null,
    card_id: p.cardId,
    summarized: {
      quotas: null,
      charged_quantity: p.chargedQuantity,
      pending_charge_quantity: null,
      last_charged_date: p.lastChargedDate,
    },
  };
}

function authJson(a: AuthPayRec, p: PreRec | null) {
  const pay = a.paymentId ? fakeMpKit.getPayment(a.paymentId) : null;
  return {
    id: Number(a.id),
    preapproval_id: a.preapprovalId,
    type: "scheduled",
    status: a.status,
    date_created: a.createdAt,
    last_modified: a.updatedAt,
    transaction_amount: a.amountCents / 100,
    currency_id: "ARS",
    reason: p?.reason ?? null,
    external_reference: p?.externalReference ?? null,
    debit_date: a.debitDate,
    retry_attempt: a.retryAttempt,
    next_retry_date: a.status === "recycling" ? new Date(Date.now() + 86_400_000).toISOString() : null,
    payment: pay ? { id: Number(pay.id), status: pay.status, status_detail: pay.statusDetail } : null,
  };
}

const PRE_STATUS_ES: Record<FakePreapprovalStatus, string> = {
  pending: "falta autorizar",
  authorized: "débito activo",
  paused: "en pausa",
  cancelled: "cancelado",
};
const AUTH_STATUS_ES: Record<AuthPayStatus, string> = {
  scheduled: "programado",
  processed: "cobrado",
  recycling: "rechazado, con reintento",
  cancelled: "anulado",
};

// ── HTTP ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Rutas de la suscripción. Devuelve null si la ruta no es de acá (sigue el router de T5). El guard ya se miró en
 * `fakeMpHandle`; se vuelve a mirar por si alguien llama a esto directo.
 */
export async function fakeMpSaasHandle(req: Request, url: URL, parts: string[], method: string): Promise<Response | null> {
  const [a, b, c] = parts;
  const ours =
    a === "preapproval" ||
    a === "authorized_payments" ||
    (a === "subscriptions" && b === "checkout") ||
    (a === "panel" && b === "suscripciones");
  if (!ours) return null;
  if (!fakeMpAllowed()) return fakeMpKit.notFound();

  if (a === "preapproval") {
    if (method === "POST" && !b) return createPreapproval(req);
    if (b && !c && (method === "GET" || method === "PUT")) return preapprovalById(req, b, method);
  }
  if (a === "authorized_payments" && b && !c && method === "GET") return authorizedPaymentById(req, b);
  if (a === "subscriptions" && b === "checkout" && !c) {
    if (method === "GET") return checkoutPage(url.searchParams.get("preapproval_id") ?? "");
    if (method === "POST") return checkoutDecide(req);
  }
  if (a === "panel" && b === "suscripciones" && !c && method === "POST") return panelAction(req);
  return fakeMpKit.mpError(404, "not_found", "Ruta del simulador inexistente");
}

function bad(message: string): Response {
  return fakeMpKit.mpError(400, "bad_request", message);
}

function isHttpUrl(v: unknown): v is string {
  if (typeof v !== "string") return false;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

async function createPreapproval(req: Request): Promise<Response> {
  const collectorId = fakeMpKit.bearerSeller(req);
  if (!collectorId) return fakeMpKit.mpError(401, "unauthorized", "invalid access token");
  const s = saasStore();
  const idemKey = req.headers.get("x-idempotency-key")?.trim() || null;
  const scopedKey = idemKey ? `${collectorId}:${idemKey}` : null;
  if (scopedKey) {
    const prev = s.preapprovals.get(s.idem.get(scopedKey) ?? "");
    if (prev) return fakeMpKit.json(preJson(prev), 201);
  }

  const body = await fakeMpKit.readBody(req);
  if (typeof body.reason !== "string" || !body.reason.trim()) return bad("reason is required");
  if (typeof body.payer_email !== "string" || !/^[^\s@]+@[^\s@]+$/.test(body.payer_email)) return bad("payer_email is invalid");
  if (!isHttpUrl(body.back_url)) return bad("back_url is invalid");
  // Sin tarjeta, MP solo crea el preapproval pendiente: autorizarlo pide `card_token_id`.
  if (body.status !== undefined && body.status !== "pending") return bad("card_token_id is required");

  const ar = (body.auto_recurring ?? {}) as Record<string, unknown>;
  if (ar.frequency !== 1 || ar.frequency_type !== "months") return bad("auto_recurring: only monthly frequency is supported");
  if (ar.currency_id !== "ARS") return bad("auto_recurring.currency_id must be ARS");
  const amountCents = typeof ar.transaction_amount === "number" ? parseARS(ar.transaction_amount) : null;
  if (amountCents === null || amountCents <= 0) return bad("auto_recurring.transaction_amount must be positive");
  const start = typeof ar.start_date === "string" ? Date.parse(ar.start_date) : NaN;
  if (!Number.isFinite(start) || start <= Date.now()) return bad("auto_recurring.start_date must be in the future");
  let billingDay: number | null = null;
  if (ar.billing_day !== undefined) {
    if (typeof ar.billing_day !== "number" || !Number.isInteger(ar.billing_day) || ar.billing_day < 1 || ar.billing_day > 28) {
      return bad("auto_recurring.billing_day must be between 1 and 28");
    }
    billingDay = ar.billing_day;
  }

  const now = fakeMpKit.nowIso();
  const rec: PreRec = {
    id: randomBytes(16).toString("hex"),
    collectorId,
    status: "pending",
    body,
    reason: body.reason.trim(),
    externalReference: typeof body.external_reference === "string" ? body.external_reference : null,
    payerEmail: body.payer_email,
    backUrl: body.back_url,
    amountCents,
    startDate: new Date(start).toISOString(),
    billingDay,
    nextPaymentDate: null,
    chargedQuantity: 0,
    lastChargedDate: null,
    cardId: null,
    createdAt: now,
    updatedAt: now,
  };
  s.preapprovals.set(rec.id, rec);
  if (scopedKey) s.idem.set(scopedKey, rec.id);
  return fakeMpKit.json(preJson(rec), 201);
}

async function preapprovalById(req: Request, id: string, method: string): Promise<Response> {
  const collectorId = fakeMpKit.bearerSeller(req);
  if (!collectorId) return fakeMpKit.mpError(401, "unauthorized", "invalid access token");
  const p = saasStore().preapprovals.get(id);
  // 404 (no 403) si es de otro collector: como MP, no se confirma que exista.
  if (!p || p.collectorId !== collectorId) return fakeMpKit.mpError(404, "not_found", "Preapproval not found");
  if (method === "GET") return fakeMpKit.json(preJson(p));

  const body = await fakeMpKit.readBody(req);
  if (p.status === "cancelled") return bad("Cannot modify a cancelled preapproval");
  const nextStatus = body.status;
  const ar = (body.auto_recurring ?? null) as Record<string, unknown> | null;
  let amountCents: number | null = null;
  if (ar && ar.transaction_amount !== undefined) {
    amountCents = typeof ar.transaction_amount === "number" ? parseARS(ar.transaction_amount) : null;
    if (amountCents === null || amountCents <= 0) return bad("auto_recurring.transaction_amount must be positive");
    if (ar.currency_id !== undefined && ar.currency_id !== "ARS") return bad("auto_recurring.currency_id must be ARS");
  }
  if (nextStatus === undefined && amountCents === null) return bad("Nothing to update");
  if (nextStatus !== undefined) {
    if (nextStatus !== "authorized" && nextStatus !== "paused" && nextStatus !== "cancelled") return bad("Invalid status");
    // Pendiente: solo se cancela. Autorizarlo pide la tarjeta (la página) y pausar algo sin tarjeta no tiene sentido.
    if (p.status === "pending" && nextStatus !== "cancelled") return bad("card_token_id is required");
  }
  if (amountCents !== null) p.amountCents = amountCents;
  if (nextStatus !== undefined) p.status = nextStatus as FakePreapprovalStatus;
  p.updatedAt = fakeMpKit.nowIso();
  return fakeMpKit.json(preJson(p));
}

function authorizedPaymentById(req: Request, id: string): Response {
  const collectorId = fakeMpKit.bearerSeller(req);
  if (!collectorId) return fakeMpKit.mpError(401, "unauthorized", "invalid access token");
  const s = saasStore();
  const a = s.authorized.get(id);
  const p = a ? (s.preapprovals.get(a.preapprovalId) ?? null) : null;
  if (!a || !p || p.collectorId !== collectorId) return fakeMpKit.mpError(404, "not_found", "Authorized payment not found");
  return fakeMpKit.json(authJson(a, p));
}

// ── Simulador (exports para tests y el panel) ─────────────────────────────────────────────────────────────────────

type HookResult = { webhookStatus: number; webhookResult?: string };

function hookUrl(dataId: string, type: string): URL {
  const u = new URL(`${mpAppUrl().replace(/\/+$/, "")}/api/webhooks/mercadopago`);
  u.searchParams.set("data.id", dataId);
  u.searchParams.set("type", type);
  return u;
}

/** Notificación de la plataforma con el cuerpo que manda MP para cada topic, firmada con `MP_WEBHOOK_SECRET`. */
function notify(dataId: string, type: "subscription_preapproval" | "subscription_authorized_payment" | "payment", action: string): Promise<HookResult> {
  const s = saasStore();
  s.seq += 1;
  const entity = type === "subscription_preapproval" ? "preapproval" : type === "subscription_authorized_payment" ? "authorized_payment" : undefined;
  const body: Record<string, unknown> = {
    action,
    api_version: "v1",
    application_id: 1,
    data: { id: dataId },
    date_created: fakeMpKit.nowIso(),
    id: Date.now() * 1000 + (s.seq % 1000),
    live_mode: false,
    type,
    user_id: FAKE_MP_PLATFORM.userId,
    version: s.seq,
  };
  if (entity) body.entity = entity;
  return fakeMpKit.postSignedNotification({ url: hookUrl(dataId, type), dataId, secret: fakeMpKit.platformHookSecret(), body });
}

/**
 * Lo que hace la página con «Autorizar débito (tarjeta de prueba)»: `pending` → `authorized` con una tarjeta de prueba,
 * primer débito en `start_date`, y avisa `subscription_preapproval`.
 */
export async function authorizeFakePreapproval(id: string): Promise<HookResult> {
  if (!fakeMpAllowed()) throw new FakeMpSaasError("not_allowed");
  const p = saasStore().preapprovals.get(id);
  if (!p) throw new FakeMpSaasError("not_found");
  if (p.status !== "pending") throw new FakeMpSaasError("not_pending");
  p.status = "authorized";
  p.cardId = `fake-card-${randomBytes(4).toString("hex")}`;
  p.nextPaymentDate = p.startDate;
  p.updatedAt = fakeMpKit.nowIso();
  return notify(p.id, "subscription_preapproval", "updated");
}

/** «Cancelar desde Mercado Pago» (el titular da de baja el débito desde su cuenta): `cancelled` + aviso. */
export async function cancelFakePreapprovalFromMp(id: string): Promise<HookResult> {
  if (!fakeMpAllowed()) throw new FakeMpSaasError("not_allowed");
  const p = saasStore().preapprovals.get(id);
  if (!p) throw new FakeMpSaasError("not_found");
  if (p.status === "cancelled") throw new FakeMpSaasError("not_authorized");
  p.status = "cancelled";
  p.nextPaymentDate = null;
  p.updatedAt = fakeMpKit.nowIso();
  return notify(p.id, "subscription_preapproval", "updated");
}

function newDebitPayment(p: PreRec, a: AuthPayRec, status: "approved" | "rejected", amountCents: number): FakeMpPaymentRec {
  const now = fakeMpKit.nowIso();
  const pay: FakeMpPaymentRec = {
    id: fakeMpKit.nextPaymentId(),
    preferenceId: "",
    collectorId: p.collectorId,
    status,
    statusDetail: status === "approved" ? "accredited" : "cc_rejected_insufficient_amount",
    amountCents,
    refundedCents: 0,
    methodId: "visa",
    typeId: "credit_card",
    createdAt: now,
    approvedAt: status === "approved" ? now : null,
    updatedAt: now,
    externalReference: p.externalReference,
    metadata: { preapproval_id: p.id },
    pointOfInteraction: { type: "SUBSCRIPTIONS", transaction_data: { subscription_id: p.id, invoice_id: a.id } },
  };
  fakeMpKit.putPayment(pay);
  return pay;
}

function markCharged(p: PreRec, at: string): void {
  p.chargedQuantity += 1;
  p.lastChargedDate = at;
  p.nextPaymentDate = addMonth(p.nextPaymentDate ?? p.startDate);
  p.updatedAt = at;
}

/**
 * Débito simulado de un preapproval autorizado:
 *   - `approved` / `rejected`: un authorized_payment nuevo (processed / recycling) con su pago;
 *   - `retry_approved`: el reintento del último rechazado (mismo authorized_payment, pago nuevo aprobado);
 *   - `refunded`: reintegra el último pago aprobado y avisa SOLO por `payment` (MP no re-notifica el débito).
 * Avisa `subscription_authorized_payment` (y además `payment` con `alsoPaymentTopic`: MP manda los dos y en orden
 * libre; el consumidor tiene que aguantar cualquiera primero).
 */
export async function simulateFakeDebit(o: {
  preapprovalId: string;
  outcome: FakeDebitOutcome;
  amountCents?: number;
  alsoPaymentTopic?: boolean;
}): Promise<{ authorizedPaymentId: string; paymentId: string | null; webhookStatus: number; webhookResult?: string; paymentWebhookStatus?: number }> {
  if (!fakeMpAllowed()) throw new FakeMpSaasError("not_allowed");
  const s = saasStore();
  const p = s.preapprovals.get(o.preapprovalId);
  if (!p) throw new FakeMpSaasError("not_found");
  if (o.amountCents !== undefined && (!Number.isInteger(o.amountCents) || o.amountCents <= 0)) throw new FakeMpSaasError("bad_amount");
  const debits = [...s.authorized.values()].filter((a) => a.preapprovalId === p.id);
  const now = fakeMpKit.nowIso();

  if (o.outcome === "refunded") {
    const a = debits.filter((x) => x.paymentId && fakeMpKit.getPayment(x.paymentId)?.status === "approved").pop();
    const pay = a?.paymentId ? fakeMpKit.getPayment(a.paymentId) : null;
    if (!a || !pay) throw new FakeMpSaasError("nothing_to_refund");
    pay.status = "refunded";
    pay.statusDetail = "refunded";
    pay.refundedCents = pay.amountCents;
    pay.updatedAt = now;
    const hook = await notify(pay.id, "payment", "payment.updated");
    return { authorizedPaymentId: a.id, paymentId: pay.id, ...hook };
  }

  // MP solo debita un preapproval autorizado (pausado o cancelado no se cobra, tampoco los reintentos).
  if (p.status !== "authorized") throw new FakeMpSaasError("not_authorized");
  let a: AuthPayRec;
  let pay: FakeMpPaymentRec;
  if (o.outcome === "retry_approved") {
    const pendingRetry = debits.filter((x) => x.status === "recycling").pop();
    if (!pendingRetry) throw new FakeMpSaasError("nothing_to_retry");
    a = pendingRetry;
    pay = newDebitPayment(p, a, "approved", o.amountCents ?? a.amountCents);
    a.status = "processed";
    a.retryAttempt += 1;
  } else {
    s.seq += 1;
    a = {
      id: `${Date.now()}${String(s.seq % 1000).padStart(3, "0")}`,
      preapprovalId: p.id,
      status: o.outcome === "approved" ? "processed" : "recycling",
      amountCents: o.amountCents ?? p.amountCents,
      debitDate: now,
      retryAttempt: 0,
      paymentId: null,
      createdAt: now,
      updatedAt: now,
    };
    s.authorized.set(a.id, a);
    pay = newDebitPayment(p, a, o.outcome, a.amountCents);
  }
  a.paymentId = pay.id;
  a.updatedAt = now;
  if (pay.status === "approved") markCharged(p, now);

  const hook = await notify(a.id, "subscription_authorized_payment", o.outcome === "retry_approved" ? "updated" : "created");
  const out: Awaited<ReturnType<typeof simulateFakeDebit>> = { authorizedPaymentId: a.id, paymentId: pay.id, ...hook };
  if (o.alsoPaymentTopic) out.paymentWebhookStatus = (await notify(pay.id, "payment", "payment.created")).webhookStatus;
  return out;
}

// ── Páginas ──────────────────────────────────────────────────────────────────────────────────────────────────────

function arDate(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = toARDateKey(iso).split("-");
  return `${d}/${m}/${y}`;
}

function backTo(p: PreRec): string | null {
  try {
    const u = new URL(p.backUrl);
    // Como MP: vuelve con el id del preapproval (la app lo usa para refrescar el estado).
    u.searchParams.set("preapproval_id", p.id);
    return u.toString();
  } catch {
    return null;
  }
}

function checkoutPage(id: string): Response {
  const { page, esc } = fakeMpKit;
  const p = saasStore().preapprovals.get(id);
  if (!p) return page("Débito inexistente · Simulador", "<h1>No encontramos esta suscripción</h1>", 404);
  const action = `${MP_FAKE_PATH}/subscriptions/checkout`;
  const back = backTo(p);
  const summary = `<div class="card"><p class="amount">${esc(formatARS(p.amountCents))} <span class="muted">por mes</span></p>
<p class="muted">${esc(p.reason)}</p>
<p class="muted">Cobra: ${esc(FAKE_MP_PLATFORM.label)} · Primer débito: ${esc(arDate(p.startDate))} · ${esc(p.payerEmail)}</p></div>`;
  if (p.status !== "pending") {
    return page(
      "Débito automático · Simulador",
      `<h1>Este débito ya no está esperando autorización</h1>${summary}<p>Estado: ${esc(PRE_STATUS_ES[p.status])}.</p>${back ? `<p><a href="${esc(back)}">Volver a ${esc(BRAND_NAME)}</a></p>` : ""}`,
      409
    );
  }
  return page(
    "Débito automático · Simulador",
    `<h1>Autorizá el débito automático de ${esc(BRAND_NAME)}</h1>${summary}
<form method="post" action="${esc(action)}"><input type="hidden" name="preapproval_id" value="${esc(p.id)}">
<p><button class="primary" type="submit" name="decision" value="authorize">Autorizar débito (tarjeta de prueba)</button></p>
<p><button type="submit" name="decision" value="cancel">Cancelar y volver</button></p></form>
<p class="muted">La tarjeta de prueba termina en 4242. Autorizar avisa al webhook de la app, firmado con el secreto de la plataforma.</p>`
  );
}

async function checkoutDecide(req: Request): Promise<Response> {
  const { page, esc, redirect } = fakeMpKit;
  const b = await fakeMpKit.readBody(req);
  const p = saasStore().preapprovals.get(String(b.preapproval_id ?? ""));
  if (!p) return page("Débito inexistente · Simulador", "<h1>No encontramos esta suscripción</h1>", 404);
  const back = backTo(p);
  if (b.decision === "authorize") {
    let line: string;
    try {
      const r = await authorizeFakePreapproval(p.id);
      line = `Webhook enviado · respuesta ${r.webhookStatus} · ${fakeMpKit.resultLabel(r.webhookResult)}`;
    } catch (e) {
      const code = e instanceof FakeMpSaasError ? e.code : "error";
      return page("No se pudo autorizar", `<h1>${esc(code === "not_pending" ? "Este débito ya no está esperando autorización." : `No se pudo autorizar (${code}).`)}</h1>`, 409);
    }
    saasStore().lastResult = line;
  } else if (b.decision !== "cancel") {
    return page("Opción inválida", "<h1>Opción inválida</h1>", 400);
  }
  if (back) return redirect(back);
  return page("Listo · Simulador", "<h1>Listo</h1><p class=\"muted\">La suscripción no tiene una dirección de vuelta válida.</p>");
}

const PANEL_ACTIONS = ["approved", "rejected", "retry_approved", "refunded", "cancel"] as const;

async function panelAction(req: Request): Promise<Response> {
  const { page, esc, redirect } = fakeMpKit;
  const b = await fakeMpKit.readBody(req);
  const id = String(b.preapproval_id ?? "");
  const action = String(b.action ?? "") as (typeof PANEL_ACTIONS)[number];
  if (!PANEL_ACTIONS.includes(action)) return page("Opción inválida", "<h1>Opción inválida</h1>", 400);
  let amountCents: number | undefined;
  if (typeof b.amount === "string" && b.amount.trim() !== "") {
    const c = parseARS(b.amount);
    if (c === null || c <= 0) return page("Monto inválido", "<h1>Monto inválido</h1>", 400);
    amountCents = c;
  }
  let r: HookResult;
  try {
    r = action === "cancel" ? await cancelFakePreapprovalFromMp(id) : await simulateFakeDebit({ preapprovalId: id, outcome: action, amountCents, alsoPaymentTopic: true });
  } catch (e) {
    const code = e instanceof FakeMpSaasError ? e.code : "error";
    const msg =
      code === "not_authorized"
        ? "El débito no está activo: Mercado Pago no lo cobra."
        : code === "nothing_to_retry"
          ? "No hay un débito rechazado para reintentar."
          : code === "nothing_to_refund"
            ? "No hay un débito cobrado para reintegrar."
            : `No se pudo simular (${code}).`;
    return page("No se pudo simular", `<h1>${esc(msg)}</h1><p><a href="${MP_FAKE_PATH}/panel">Volver al panel</a></p>`, 409);
  }
  saasStore().lastResult = `Webhook enviado · respuesta ${r.webhookStatus} · ${fakeMpKit.resultLabel(r.webhookResult)}`;
  return redirect(`${MP_FAKE_PATH}/panel`);
}

/** Sección «Suscripciones» del panel del simulador (la arma `panelPage` de `fake-mp.ts`). */
export function fakeMpSaasPanelSection(): string {
  const { esc } = fakeMpKit;
  const s = saasStore();
  const action = `${MP_FAKE_PATH}/panel/suscripciones`;
  const dis = (off: boolean) => (off ? " disabled" : "");
  const rows = [...s.preapprovals.values()]
    .slice(-10)
    .reverse()
    .map((p) => {
      const debits = [...s.authorized.values()].filter((a) => a.preapprovalId === p.id);
      const canRetry = debits.some((a) => a.status === "recycling");
      const canRefund = debits.some((a) => a.paymentId && fakeMpKit.getPayment(a.paymentId)?.status === "approved");
      const active = p.status === "authorized";
      const last = debits.slice(-3).reverse();
      const lastHtml = last.length
        ? `<ul>${last
            .map((a) => {
              const pay = a.paymentId ? fakeMpKit.getPayment(a.paymentId) : null;
              return `<li>${esc(arDate(a.debitDate))} · ${esc(formatARS(a.amountCents))} · ${esc(AUTH_STATUS_ES[a.status])}${pay ? ` · pago ${esc(pay.id)} ${esc(fakeMpKit.paymentStatusEs(pay.status))}` : ""}</li>`;
            })
            .join("")}</ul>`
        : '<p class="muted">Sin débitos todavía.</p>';
      const btn = (value: string, label: string, off: boolean) =>
        `<button type="submit" name="action" value="${value}"${dis(off)}>${esc(label)}</button>`;
      return `<div class="card"><strong>${esc(p.reason)}</strong> <span class="muted">(${esc(p.externalReference ?? "sin referencia")} · ${esc(formatARS(p.amountCents))} por mes · ${esc(PRE_STATUS_ES[p.status])})</span>
<p class="muted">Próximo débito: ${esc(arDate(p.nextPaymentDate))} · ${esc(p.payerEmail)}</p>${lastHtml}
<form method="post" action="${esc(action)}"><input type="hidden" name="preapproval_id" value="${esc(p.id)}">
<div class="row">${btn("approved", "Simular débito aprobado", !active)}${btn("rejected", "Simular débito rechazado", !active)}${btn("retry_approved", "Simular reintento aprobado", !active || !canRetry)}${btn("refunded", "Simular reintegro", !canRefund)}${btn("cancel", "Cancelar desde Mercado Pago", p.status === "cancelled")}</div>
<div class="row"><label>Otro monto del débito (en pesos, opcional)<input name="amount" inputmode="decimal" autocomplete="off"></label></div></form></div>`;
    })
    .join("");
  return `<h2>Suscripciones</h2><p class="muted">Débitos automáticos de la plataforma. Cada simulación avisa al webhook de la app firmada con el secreto de la plataforma.</p>${s.lastResult ? `<p role="status"><strong>${esc(s.lastResult)}</strong></p>` : ""}${rows || '<p class="muted">Sin suscripciones todavía.</p>'}`;
}
