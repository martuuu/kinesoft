import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { BRAND_NAME } from "@/lib/brand";
import { env, fakeMpAllowed } from "@/lib/env";
import { formatARS, parseARS } from "@/lib/format";
import { MP_FAKE_PATH, mpRedirectUri } from "@/lib/mp-connect/constants";
import { mpAppUrl } from "@/lib/mp-connect/http";
import { signMpNotification } from "@/lib/mp-connect/signature";

/**
 * Mercado Pago FALSO y simulador (T5 TP-P4, C-TP12, brief §25.9; TP-D21 + decisión 4 de Martin).
 *
 * Para qué: probar de punta a punta (dev, vitest, el `next start` del E2E) la conexión por OAuth, las preferencias y
 * el webhook SIN tocar Mercado Pago real ni el sandbox (regla de T5: nunca MP real desde un agente). El pago simulado
 * entra por la RUTA REAL del webhook, firmado con `MP_CONNECT_WEBHOOK_SECRET` y con el mismo manifiesto que MP
 * (`signMpNotification`), y el consumidor vuelve a pedir el pago a este fake con el token del vendedor: lo mismo que
 * hará con MP de verdad.
 *
 * Barreras para que nunca llegue a prod (§25.2 #11; se guarda por Vercel, no por NODE_ENV, porque el E2E corre
 * `next start` en production):
 *   1. `lib/env.ts` rechaza `MP_CONNECT_MODE=fake` en el boot con `VERCEL_ENV` o `VERCEL`;
 *   2. `fakeMpAllowed()` se mira en CADA request (`fakeMpHandle`) y en `simulateFakePayment`: fuera de fake o en
 *      Vercel → 404 / error, aunque el módulo esté en el bundle del server;
 *   3. el webhook simulado solo se POSTea al mismo origen que `NEXT_PUBLIC_APP_URL` (no es un cliente HTTP abierto).
 *
 * Estado en `globalThis` (un solo proceso: `next dev`, vitest o `next start`). Reiniciar el server lo vacía; por eso
 * los ids de pago llevan la hora (no chocan con los que ya quedaron en la base local).
 *
 * El HTML es deliberadamente simple (0 kB de bundle, TP-UI-D10); el pulido del copy y del estilo es de TP-3j.
 */

export { fakeMpAllowed };

export const FAKE_MP_SELLERS = [
  { n: 1, userId: "900000001", nickname: "VENDEDOR_PRUEBA_1", label: "Vendedor de prueba 1", publicKey: "FAKE-pk-900000001" },
  { n: 2, userId: "900000002", nickname: "VENDEDOR_PRUEBA_2", label: "Vendedor de prueba 2", publicKey: "FAKE-pk-900000002" },
] as const;

/** Vida de un código de autorización (MP: 10 min) y de un access token (MP: 180 días). */
const CODE_TTL_MS = 10 * 60_000;
const ACCESS_TTL_S = 180 * 24 * 3600;

export type FakeMpOutcome = "approved" | "rejected" | "pending" | "refunded";
export type FakeMpMethod = "credit_card" | "debit_card" | "account_money" | "ticket";

type CodeRec = { sellerUserId: string; clientId: string; redirectUri: string; challenge: string; expMs: number; used: boolean };
type RefreshRec = { sellerUserId: string; clientId: string; used: boolean };
type PrefRec = {
  id: string;
  collectorId: string;
  body: Record<string, unknown>;
  amountCents: number;
  binary: boolean;
  notificationUrl: string | null;
  backUrls: { success?: string; failure?: string; pending?: string };
  externalReference: string | null;
  createdAt: string;
};
type PaymentRec = {
  id: string;
  preferenceId: string;
  collectorId: string;
  status: "approved" | "rejected" | "pending" | "refunded";
  statusDetail: string;
  amountCents: number;
  refundedCents: number;
  methodId: string;
  typeId: FakeMpMethod;
  createdAt: string;
  approvedAt: string | null;
  updatedAt: string;
  externalReference: string | null;
  metadata: unknown;
};
type Store = {
  codes: Map<string, CodeRec>;
  tokens: Map<string, { sellerUserId: string; expMs: number }>;
  refresh: Map<string, RefreshRec>;
  prefs: Map<string, PrefRec>;
  payments: Map<string, PaymentRec>;
  /** «Forzar reconexión»: el refresh de estos vendedores responde invalid_grant hasta un canje de código nuevo. */
  reauth: Set<string>;
  seq: number;
};

const STORE_KEY = "__kinesoftFakeMpStore";

function freshStore(): Store {
  return { codes: new Map(), tokens: new Map(), refresh: new Map(), prefs: new Map(), payments: new Map(), reauth: new Set(), seq: 0 };
}

function store(): Store {
  const g = globalThis as unknown as Record<string, Store | undefined>;
  return (g[STORE_KEY] ??= freshStore());
}

/** Vacía el estado del fake (tests). */
export function resetFakeMp(): void {
  (globalThis as unknown as Record<string, Store | undefined>)[STORE_KEY] = freshStore();
}

export class FakeMpError extends Error {
  constructor(
    public code: "not_allowed" | "not_found" | "preference_expired" | "nothing_to_refund" | "no_notification_url" | "notification_url_foreign" | "bad_amount"
  ) {
    super(`fake_mp:${code}`);
    this.name = "FakeMpError";
  }
}

function rand(bytes = 18): string {
  return randomBytes(bytes).toString("base64url");
}
function nowIso(): string {
  return new Date().toISOString();
}
function sellerBy(userId: string) {
  return FAKE_MP_SELLERS.find((s) => s.userId === userId) ?? null;
}
function fakeBase(): string {
  return `${mpAppUrl().replace(/\/+$/, "")}${MP_FAKE_PATH}`;
}

// ── Atajos para tests y helpers (tests/helpers/mp-connect-fake.ts) ──────────────────────────────────────────────

function issueTokens(sellerUserId: string, clientId: string) {
  const s = store();
  const seller = sellerBy(sellerUserId);
  const accessToken = `FAKE-${sellerUserId}-${rand()}`;
  const refreshToken = `FAKE-TG-${sellerUserId}-${rand()}`;
  s.tokens.set(accessToken, { sellerUserId, expMs: Date.now() + ACCESS_TTL_S * 1000 });
  s.refresh.set(refreshToken, { sellerUserId, clientId, used: false });
  return {
    access_token: accessToken,
    token_type: "bearer",
    expires_in: ACCESS_TTL_S,
    scope: "offline_access read write",
    user_id: Number(sellerUserId),
    refresh_token: refreshToken,
    public_key: seller?.publicKey ?? null,
    // El fake se comporta como una cuenta de prueba: `live_mode` false (igual que sandbox con test_token).
    live_mode: false,
  };
}

/**
 * Tokens de un vendedor sin pasar por la pantalla de autorización (para `connectFakeAccount` de los tests). El
 * `clientId` tiene que ser el que después use el refresh (el de `oauth-client.ts`).
 */
export function fakeMpIssueTokens(seller: 1 | 2, clientId = process.env.MP_OAUTH_CLIENT_ID?.trim() || "kinesoft-fake-app") {
  const sel = FAKE_MP_SELLERS[seller - 1];
  const t = issueTokens(sel.userId, clientId);
  return { accessToken: t.access_token, refreshToken: t.refresh_token, userId: sel.userId, publicKey: sel.publicKey, nickname: sel.nickname };
}

/** «Forzar reconexión»: invalida los refresh vivos del vendedor (prueba `invalid_grant` → REAUTH_REQUIRED). */
export function fakeMpForceReauth(sellerUserId: string): void {
  const s = store();
  s.reauth.add(sellerUserId);
  for (const r of s.refresh.values()) if (r.sellerUserId === sellerUserId) r.used = true;
}

export function fakeMpGetPreference(id: string): (PrefRec & { expired: boolean }) | null {
  const p = store().prefs.get(id);
  return p ? { ...p, expired: prefExpired(p) } : null;
}
export function fakeMpGetPayment(id: string): PaymentRec | null {
  return store().payments.get(id) ?? null;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const NO_STORE = { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...NO_STORE } });
}
function mpError(status: number, error: string, message: string): Response {
  return json({ error, message, status }, status);
}
function notFound(): Response {
  return new Response("Not found", { status: 404, headers: NO_STORE });
}
function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location, ...NO_STORE } });
}

function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const BANNER =
  '<div class="banner"><strong>Simulador de Mercado Pago (solo desarrollo)</strong>' +
  "<p>Nada de esto toca Mercado Pago real. El pago pasa por el webhook de verdad, firmado con el secreto de prueba.</p></div>";

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="es-AR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>
body{font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:16px;color:#0f1f33;background:#f6f8fb}
.banner{background:#fff4d6;border:1px solid #e8c766;border-radius:8px;padding:12px;margin-bottom:16px}.banner p{margin:4px 0 0;font-size:14px}
h1{font-size:20px}form{margin:8px 0}button{min-height:44px;padding:0 16px;font-size:15px;border-radius:8px;border:1px solid #9fb3c8;background:#fff;cursor:pointer}
button.primary{background:#009ee3;border-color:#009ee3;color:#fff}button:disabled{opacity:.5;cursor:not-allowed}
.card{background:#fff;border:1px solid #dde4ec;border-radius:8px;padding:12px;margin:12px 0}.muted{color:#5b6b7d;font-size:14px}
input{min-height:40px;font-size:15px;padding:0 8px;border:1px solid #9fb3c8;border-radius:6px}
</style></head><body>${BANNER}${body}</body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", ...NO_STORE } });
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const ct = req.headers.get("content-type") ?? "";
  try {
    if (ct.includes("application/json")) return ((await req.json()) ?? {}) as Record<string, unknown>;
    if (ct.includes("form")) return Object.fromEntries((await req.formData()).entries());
    const text = await req.text();
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function bearerSeller(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return null;
  const t = store().tokens.get(m[1].trim());
  if (!t || t.expMs < Date.now()) return null;
  return t.sellerUserId;
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}
const PKCE_RE = /^[A-Za-z0-9._~-]{43,128}$/;

function prefExpired(p: PrefRec): boolean {
  if (p.body.expires !== true) return false;
  const to = typeof p.body.expiration_date_to === "string" ? Date.parse(p.body.expiration_date_to) : NaN;
  return Number.isFinite(to) && to <= Date.now();
}

/** Router del fake. Lo monta `app/api/mp/fake/[...path]/route.ts`; acá adentro se vuelve a mirar el guard. */
export async function fakeMpHandle(req: Request): Promise<Response> {
  if (!fakeMpAllowed()) return notFound();
  const url = new URL(req.url);
  const at = url.pathname.indexOf(MP_FAKE_PATH);
  const sub = at >= 0 ? url.pathname.slice(at + MP_FAKE_PATH.length) : url.pathname;
  const parts = sub.split("/").filter(Boolean).map(decodeURIComponent);
  const method = req.method.toUpperCase();
  const [a, b, c] = parts;

  if (method === "GET" && (parts.length === 0 || (a === "panel" && parts.length === 1))) return panelPage();
  if (method === "POST" && a === "panel" && b === "reconectar") return panelReauth(req);
  if (a === "authorization" && parts.length === 1) return method === "GET" ? authorizationPage(url) : authorizationDecide(req);
  if (method === "POST" && a === "oauth" && b === "token") return tokenEndpoint(req);
  if (method === "GET" && a === "users" && b === "me") return usersMe(req);
  if (a === "checkout" && b === "preferences") {
    if (method === "POST" && !c) return createPreference(req);
    if (c && (method === "PUT" || method === "GET")) return preferenceById(req, c, method);
  }
  if (method === "GET" && a === "v1" && b === "payments" && c) return paymentById(req, c);
  if (a === "checkout" && b && b !== "preferences") {
    if (method === "GET" && !c) return checkoutPage(b);
    if (method === "POST" && c === "simulate") return checkoutSimulate(req, b);
  }
  return mpError(404, "not_found", "Ruta del simulador inexistente");
}

// ── OAuth ────────────────────────────────────────────────────────────────────────────────────────────────────────

function authorizationPage(url: URL): Response {
  const q = url.searchParams;
  const clientId = q.get("client_id") ?? "";
  const redirectUri = q.get("redirect_uri") ?? "";
  const challenge = q.get("code_challenge") ?? "";
  const challengeMethod = q.get("code_challenge_method") ?? "";
  const state = q.get("state") ?? "";
  const problems: string[] = [];
  if (!clientId) problems.push("Falta client_id.");
  if (q.get("response_type") !== "code") problems.push("response_type tiene que ser code.");
  // `redirect_uri` exacta: la «registrada» en el fake es la del callback de esta misma app.
  if (redirectUri !== mpRedirectUri(mpAppUrl())) problems.push("La redirect_uri no coincide con la registrada.");
  if (!challenge || challengeMethod !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
    problems.push("PKCE obligatorio: code_challenge con code_challenge_method=S256.");
  }
  if (problems.length) {
    return page("Autorización inválida", `<h1>No se puede autorizar</h1><ul>${problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>`, 400);
  }
  const hidden = [
    ["client_id", clientId],
    ["redirect_uri", redirectUri],
    ["state", state],
    ["code_challenge", challenge],
  ]
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`)
    .join("");
  const buttons = FAKE_MP_SELLERS.map(
    (s) => `<p><button class="primary" type="submit" name="seller" value="${s.userId}">Autorizar como ${esc(s.label)}</button></p>`
  ).join("");
  return page(
    `Autorizar ${BRAND_NAME}`,
    `<h1>${esc(BRAND_NAME)} quiere cobrar con tu cuenta</h1><form method="post" action="${MP_FAKE_PATH}/authorization">${hidden}${buttons}<p><button type="submit" name="seller" value="cancel">Cancelar</button></p></form>`
  );
}

async function authorizationDecide(req: Request): Promise<Response> {
  const b = await readBody(req);
  const redirectUri = String(b.redirect_uri ?? "");
  if (redirectUri !== mpRedirectUri(mpAppUrl())) return page("Autorización inválida", "<h1>La redirect_uri no coincide con la registrada.</h1>", 400);
  const target = new URL(redirectUri);
  const state = String(b.state ?? "");
  if (state) target.searchParams.set("state", state);
  const sellerUserId = String(b.seller ?? "");
  if (sellerUserId === "cancel" || !sellerBy(sellerUserId)) {
    target.searchParams.set("error", "access_denied");
    return redirect(target.toString());
  }
  const challenge = String(b.code_challenge ?? "");
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) return page("Autorización inválida", "<h1>Falta el code_challenge (PKCE).</h1>", 400);
  const code = `FAKE-CODE-${rand()}`;
  store().codes.set(code, {
    sellerUserId,
    clientId: String(b.client_id ?? ""),
    redirectUri,
    challenge,
    expMs: Date.now() + CODE_TTL_MS,
    used: false,
  });
  target.searchParams.set("code", code);
  return redirect(target.toString());
}

async function tokenEndpoint(req: Request): Promise<Response> {
  const s = store();
  const b = await readBody(req);
  const clientId = String(b.client_id ?? "");
  if (!clientId || !String(b.client_secret ?? "")) return mpError(401, "invalid_client", "Faltan client_id o client_secret");
  if (b.grant_type === "authorization_code") {
    const code = s.codes.get(String(b.code ?? ""));
    if (!code) return mpError(400, "invalid_grant", "Código inexistente");
    if (code.used) return mpError(400, "invalid_grant", "Código ya usado");
    // Un uso: cualquier presentación lo consume, aun si falla después (no se reintenta un código con otro verifier).
    code.used = true;
    if (code.expMs < Date.now()) return mpError(400, "invalid_grant", "Código vencido");
    if (code.clientId !== clientId) return mpError(400, "invalid_grant", "El código es de otra aplicación");
    if (String(b.redirect_uri ?? "") !== code.redirectUri) return mpError(400, "invalid_grant", "redirect_uri distinta de la autorizada");
    const verifier = String(b.code_verifier ?? "");
    if (!PKCE_RE.test(verifier) || s256(verifier) !== code.challenge) {
      return mpError(400, "invalid_grant", "PKCE: code_verifier inválido");
    }
    s.reauth.delete(code.sellerUserId);
    return json(issueTokens(code.sellerUserId, clientId));
  }
  if (b.grant_type === "refresh_token") {
    const r = s.refresh.get(String(b.refresh_token ?? ""));
    if (!r || r.used || r.clientId !== clientId || s.reauth.has(r.sellerUserId)) {
      return mpError(400, "invalid_grant", "Refresh token inválido, usado o revocado");
    }
    // Rotativo: el refresh usado no sirve más.
    r.used = true;
    return json(issueTokens(r.sellerUserId, clientId));
  }
  return mpError(400, "unsupported_grant_type", "grant_type no soportado");
}

function usersMe(req: Request): Response {
  const sellerUserId = bearerSeller(req);
  const seller = sellerUserId ? sellerBy(sellerUserId) : null;
  if (!seller) return mpError(401, "unauthorized", "invalid access token");
  return json({ id: Number(seller.userId), nickname: seller.nickname, site_id: "MLA", email: `vendedor${seller.n}@simulador.invalid` });
}

// ── Preferencias y pagos ─────────────────────────────────────────────────────────────────────────────────────────

async function createPreference(req: Request): Promise<Response> {
  const collectorId = bearerSeller(req);
  if (!collectorId) return mpError(401, "unauthorized", "invalid access token");
  const body = await readBody(req);
  const items = Array.isArray(body.items) ? (body.items as Record<string, unknown>[]) : [];
  const item = items[0];
  const unitCents = typeof item?.unit_price === "number" ? parseARS(item.unit_price) : null;
  const qty = typeof item?.quantity === "number" && Number.isInteger(item.quantity) && item.quantity > 0 ? item.quantity : 1;
  if (!item || unitCents === null || unitCents <= 0 || (item.currency_id ?? "ARS") !== "ARS") {
    return mpError(400, "invalid_items", "items[0] necesita unit_price > 0 en ARS");
  }
  const s = store();
  const id = `${collectorId}-fake-${rand(9)}`;
  const backUrls = (body.back_urls ?? {}) as PrefRec["backUrls"];
  const pm = body.payment_methods as { excluded_payment_types?: { id: string }[] } | undefined;
  const rec: PrefRec = {
    id,
    collectorId,
    body,
    amountCents: unitCents * qty,
    binary: body.binary_mode === true,
    notificationUrl: typeof body.notification_url === "string" ? body.notification_url : null,
    backUrls,
    externalReference: typeof body.external_reference === "string" ? body.external_reference : null,
    createdAt: nowIso(),
  };
  void pm; // las exclusiones se guardan en `body`; el simulador no las aplica (QA del monto y del estado, no del medio)
  s.prefs.set(id, rec);
  return json(prefJson(rec), 201);
}

function prefJson(p: PrefRec) {
  const init = `${fakeBase()}/checkout/${encodeURIComponent(p.id)}`;
  return { ...p.body, id: p.id, collector_id: Number(p.collectorId), init_point: init, sandbox_init_point: init, date_created: p.createdAt };
}

async function preferenceById(req: Request, id: string, method: string): Promise<Response> {
  const collectorId = bearerSeller(req);
  if (!collectorId) return mpError(401, "unauthorized", "invalid access token");
  const p = store().prefs.get(id);
  if (!p || p.collectorId !== collectorId) return mpError(404, "not_found", "Preference not found");
  if (method === "PUT") {
    const b = await readBody(req);
    // Solo lo que usa T5 para vencer una preferencia (`mpExpirePreference`).
    if (typeof b.expires === "boolean") p.body.expires = b.expires;
    if (typeof b.expiration_date_to === "string") p.body.expiration_date_to = b.expiration_date_to;
  }
  return json(prefJson(p));
}

function paymentJson(p: PaymentRec) {
  return {
    id: Number(p.id),
    status: p.status,
    status_detail: p.statusDetail,
    transaction_amount: p.amountCents / 100,
    transaction_amount_refunded: p.refundedCents / 100,
    currency_id: "ARS",
    external_reference: p.externalReference,
    preference_id: p.preferenceId,
    collector_id: Number(p.collectorId),
    payment_method_id: p.methodId,
    payment_type_id: p.typeId,
    installments: 1,
    date_created: p.createdAt,
    date_approved: p.approvedAt,
    date_last_updated: p.updatedAt,
    live_mode: false,
    metadata: p.metadata ?? {},
    card: p.typeId === "credit_card" || p.typeId === "debit_card" ? { last_four_digits: "4242" } : {},
    payer: { email: "comprador@simulador.invalid" },
  };
}

function paymentById(req: Request, id: string): Response {
  const sellerUserId = bearerSeller(req);
  if (!sellerUserId) return mpError(401, "unauthorized", "invalid access token");
  const p = store().payments.get(id);
  // 404 (no 403) si el pago es de otro vendedor: como MP, no se confirma que exista.
  if (!p || p.collectorId !== sellerUserId) return mpError(404, "not_found", "Payment not found");
  return json(paymentJson(p));
}

// ── Simulador ────────────────────────────────────────────────────────────────────────────────────────────────────

const METHOD_IDS: Record<FakeMpMethod, string> = {
  credit_card: "visa",
  debit_card: "debvisa",
  account_money: "account_money",
  ticket: "pagofacil",
};

/**
 * Crea (o reintegra) un pago de la preferencia y POSTea la notificación FIRMADA a su `notification_url` real (con su
 * `?acct=`), agregando `data.id` y `type=payment` como MP. Devuelve el status HTTP con que respondió el webhook (0 si
 * no respondió) y, si la ruta lo informa, su `result`.
 */
export async function simulateFakePayment(o: {
  preferenceId: string;
  outcome: FakeMpOutcome;
  amountCents?: number;
  method?: FakeMpMethod;
}): Promise<{ paymentId: string; webhookStatus: number; webhookResult?: string }> {
  if (!fakeMpAllowed()) throw new FakeMpError("not_allowed");
  const s = store();
  const pref = s.prefs.get(o.preferenceId);
  if (!pref) throw new FakeMpError("not_found");
  const now = nowIso();
  let pay: PaymentRec;
  if (o.outcome === "refunded") {
    const approved = [...s.payments.values()].filter((p) => p.preferenceId === pref.id && p.status === "approved").pop();
    if (!approved) throw new FakeMpError("nothing_to_refund");
    approved.status = "refunded";
    approved.statusDetail = "refunded";
    approved.refundedCents = approved.amountCents;
    approved.updatedAt = now;
    pay = approved;
  } else {
    // MP no deja pagar una preferencia vencida: el simulador tampoco (QA de la expiración).
    if (prefExpired(pref)) throw new FakeMpError("preference_expired");
    const amountCents = o.amountCents ?? pref.amountCents;
    if (!Number.isInteger(amountCents) || amountCents <= 0) throw new FakeMpError("bad_amount");
    // `binary_mode`: MP nunca deja un pago en pending, lo resuelve aprobado o rechazado.
    const status = o.outcome === "pending" && pref.binary ? "rejected" : o.outcome;
    const typeId: FakeMpMethod = o.method ?? (status === "pending" ? "ticket" : "credit_card");
    s.seq += 1;
    pay = {
      id: `${Date.now()}${String(s.seq % 1000).padStart(3, "0")}`,
      preferenceId: pref.id,
      collectorId: pref.collectorId,
      status,
      statusDetail: status === "approved" ? "accredited" : status === "rejected" ? "cc_rejected_other_reason" : "pending_waiting_payment",
      amountCents,
      refundedCents: 0,
      methodId: METHOD_IDS[typeId],
      typeId,
      createdAt: now,
      approvedAt: status === "approved" ? now : null,
      updatedAt: now,
      externalReference: pref.externalReference,
      metadata: pref.body.metadata ?? {},
    };
    s.payments.set(pay.id, pay);
  }
  const hook = await postWebhook(pref, pay, o.outcome === "refunded" ? "payment.updated" : "payment.created");
  return { paymentId: pay.id, ...hook };
}

async function postWebhook(pref: PrefRec, pay: PaymentRec, action: string): Promise<{ webhookStatus: number; webhookResult?: string }> {
  if (!pref.notificationUrl) throw new FakeMpError("no_notification_url");
  let target: URL;
  try {
    target = new URL(pref.notificationUrl);
  } catch {
    throw new FakeMpError("no_notification_url");
  }
  // Solo a esta misma app: el simulador no es un cliente HTTP para pegarle a cualquier host con una firma válida.
  if (target.origin !== new URL(mpAppUrl()).origin) throw new FakeMpError("notification_url_foreign");
  target.searchParams.set("data.id", pay.id);
  target.searchParams.set("type", "payment");

  const requestId = randomUUID();
  const headers: Record<string, string> = { "content-type": "application/json", "x-request-id": requestId };
  const secret = process.env.MP_CONNECT_WEBHOOK_SECRET?.trim() || env.MP_CONNECT_WEBHOOK_SECRET;
  // Sin secreto va sin firma: con `MP_CONNECT_WEBHOOK_SIGNATURE=required` la ruta lo rechaza (401) y eso se ve en el
  // resultado, que es justo lo que hay que notar en QA.
  if (secret) {
    headers["x-signature"] = signMpNotification({ dataId: pay.id, secret, ts: Math.floor(Date.now() / 1000), requestId });
  }
  const body = {
    action,
    api_version: "v1",
    data: { id: pay.id },
    date_created: nowIso(),
    id: Date.now(),
    live_mode: false,
    type: "payment",
    user_id: pref.collectorId,
  };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  try {
    const res = await globalThis.fetch(target.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ac.signal,
      cache: "no-store",
    });
    let webhookResult: string | undefined;
    try {
      const j = (await res.json()) as { result?: unknown };
      if (typeof j?.result === "string") webhookResult = j.result;
    } catch {
      /* la ruta puede responder sin cuerpo */
    }
    return { webhookStatus: res.status, webhookResult };
  } catch {
    return { webhookStatus: 0 };
  } finally {
    clearTimeout(timer);
  }
}

// ── Páginas del simulador ────────────────────────────────────────────────────────────────────────────────────────

function checkoutPage(prefId: string): Response {
  const s = store();
  const p = s.prefs.get(prefId);
  if (!p) return page("Pago inexistente", "<h1>No encontramos este pago</h1>", 404);
  const expired = prefExpired(p);
  const hasApproved = [...s.payments.values()].some((x) => x.preferenceId === p.id && x.status === "approved");
  const title = String((p.body.items as { title?: string }[] | undefined)?.[0]?.title ?? "Pago");
  const action = `${MP_FAKE_PATH}/checkout/${encodeURIComponent(p.id)}/simulate`;
  const dis = (off: boolean) => (off ? " disabled" : "");
  const back = p.backUrls.failure ?? p.backUrls.success ?? null;
  return page(
    "Pagar · Simulador",
    `<h1>${esc(title)}</h1>
<div class="card"><p><strong>${esc(formatARS(p.amountCents))}</strong></p>
${expired ? "<p><strong>Este cobro venció: Mercado Pago no deja pagarlo.</strong></p>" : ""}
<form method="post" action="${esc(action)}">
<p><button class="primary" type="submit" name="outcome" value="approved"${dis(expired)}>Simular pago aprobado</button></p>
<p><button type="submit" name="outcome" value="rejected"${dis(expired)}>Simular pago rechazado</button></p>
<p><button type="submit" name="outcome" value="pending"${dis(expired || p.binary)}>Simular pago pendiente</button>${p.binary ? ' <span class="muted">(este cobro no admite pagos pendientes)</span>' : ""}</p>
<p><button type="submit" name="outcome" value="refunded"${dis(!hasApproved)}>Simular reintegro</button></p>
</form>
<form method="post" action="${esc(action)}"><input type="hidden" name="outcome" value="approved">
<p><label>Monto <input name="amount" inputmode="decimal" required aria-label="Otro monto en pesos"></label>
<button type="submit"${dis(expired)}>Simular con otro monto</button></p></form></div>
${back ? `<p><a href="${esc(back)}">Volver al sitio</a></p>` : ""}`,
    expired ? 410 : 200
  );
}

async function checkoutSimulate(req: Request, prefId: string): Promise<Response> {
  const b = await readBody(req);
  const outcome = String(b.outcome ?? "");
  if (!["approved", "rejected", "pending", "refunded"].includes(outcome)) return page("Simulación inválida", "<h1>Opción inválida</h1>", 400);
  let amountCents: number | undefined;
  if (typeof b.amount === "string" && b.amount.trim() !== "") {
    const c = parseARS(b.amount);
    if (c === null || c <= 0) return page("Monto inválido", "<h1>Monto inválido</h1>", 400);
    amountCents = c;
  }
  const pref = store().prefs.get(prefId);
  let r: Awaited<ReturnType<typeof simulateFakePayment>>;
  try {
    r = await simulateFakePayment({ preferenceId: prefId, outcome: outcome as FakeMpOutcome, amountCents });
  } catch (e) {
    const code = e instanceof FakeMpError ? e.code : "error";
    const msg =
      code === "preference_expired"
        ? "Este cobro venció: Mercado Pago no deja pagarlo."
        : code === "nothing_to_refund"
          ? "No hay un pago aprobado para reintegrar."
          : `No se pudo simular (${code}).`;
    return page("No se pudo simular", `<h1>${esc(msg)}</h1>`, code === "preference_expired" ? 410 : 409);
  }
  const resultLine = `Webhook enviado · respuesta ${r.webhookStatus} · ${resultLabel(r.webhookResult)}`;
  const status = fakeMpGetPayment(r.paymentId)?.status ?? outcome;
  const back = status === "approved" ? pref?.backUrls.success : status === "pending" ? pref?.backUrls.pending : status === "rejected" ? pref?.backUrls.failure : null;
  if (back && outcome !== "refunded") {
    // Mismos parámetros que agrega MP al volver (la página de resultado los ignora salvo para mostrar el estado).
    try {
      const u = new URL(back);
      u.searchParams.set("payment_id", r.paymentId);
      u.searchParams.set("collection_id", r.paymentId);
      u.searchParams.set("status", status);
      u.searchParams.set("collection_status", status);
      u.searchParams.set("preference_id", prefId);
      if (pref?.externalReference) u.searchParams.set("external_reference", pref.externalReference);
      return redirect(u.toString());
    } catch {
      /* back_url inválida: se muestra el resultado */
    }
  }
  const backAny = pref?.backUrls.success ?? pref?.backUrls.failure ?? null;
  return page(
    "Resultado · Simulador",
    `<h1>${esc(resultLine)}</h1><p class="muted">Pago ${esc(r.paymentId)} · ${esc(status)}</p>${backAny ? `<p><a href="${esc(backAny)}">Volver al sitio</a></p>` : ""}`
  );
}

function resultLabel(result: string | undefined): string {
  if (result === "applied") return "aplicado";
  if (result === "replay") return "repetido";
  if (result === "mismatch") return "monto distinto";
  if (result === "ignored") return "ignorado";
  return result ?? "sin detalle";
}

function panelPage(): Response {
  const s = store();
  const rows = FAKE_MP_SELLERS.map((sel) => {
    const live = [...s.tokens.values()].filter((t) => t.sellerUserId === sel.userId && t.expMs > Date.now()).length;
    const prefs = [...s.prefs.values()].filter((p) => p.collectorId === sel.userId).length;
    return `<div class="card"><strong>${esc(sel.label)}</strong> <span class="muted">(${esc(sel.nickname)} · ${sel.userId})</span>
<p class="muted">${live} tokens vivos · ${prefs} cobros${s.reauth.has(sel.userId) ? " · reconexión forzada" : ""}</p>
<form method="post" action="${MP_FAKE_PATH}/panel/reconectar"><input type="hidden" name="seller" value="${sel.userId}"><button type="submit">Forzar reconexión</button></form></div>`;
  }).join("");
  const pays = [...s.payments.values()]
    .slice(-10)
    .reverse()
    .map((p) => `<li>${esc(p.id)} · ${esc(p.status)} · ${esc(formatARS(p.amountCents))}</li>`)
    .join("");
  return page("Simulador de Mercado Pago", `<h1>Cuentas de prueba</h1>${rows}<h2>Últimos pagos</h2><ul>${pays || "<li>Sin pagos todavía</li>"}</ul>`);
}

async function panelReauth(req: Request): Promise<Response> {
  const b = await readBody(req);
  const sellerUserId = String(b.seller ?? "");
  if (sellerBy(sellerUserId)) fakeMpForceReauth(sellerUserId);
  return redirect(`${MP_FAKE_PATH}/panel`);
}
