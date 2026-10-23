import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { env, fakeGraphAllowed } from "@/lib/env";
import { maskPhone, signMetaPayload } from "@/lib/whatsapp/crypto";
import { WA_FAKE_PATH } from "@/lib/whatsapp/graph";
import { TEST_TEMPLATE } from "@/lib/whatsapp/templates";
import { DEV_WAFAKE_LITERALS } from "@/scripts/lib/dev-mp-fake-env.mjs";
import {
  FAKE_SIGNUP_GRANTS,
  panelHtml,
  signupDoneHtml,
  signupPageHtml,
  type FakePanelView,
  type FakeSignupGrant,
} from "@/lib/whatsapp/fake-graph-html";

/**
 * Meta FALSO: simulador de la Graph API de WhatsApp (T6 WA-P3, C-WA5, brief §26.5). Molde: `lib/mp-connect/fake-mp.ts`.
 *
 * Para qué: probar de punta a punta (dev, vitest, el `next start` del E2E) el alta por Embedded Signup, las
 * plantillas, el envío, los estados y las respuestas del paciente SIN tocar Meta real ni el sandbox (regla de T6:
 * nunca Meta real desde un agente). Los avisos entran por la RUTA REAL del webhook (`/api/webhooks/whatsapp`, de
 * WA-S3), firmados con `WHATSAPP_APP_SECRET` igual que Meta (`X-Hub-Signature-256`).
 *
 * Barreras para que nunca llegue a prod (mismo esquema que el de MP):
 *   1. `lib/env.ts` rechaza `WHATSAPP_MODE=fake` en el boot con `VERCEL_ENV` o `VERCEL`;
 *   2. `fakeGraphAllowed()` se mira en CADA request (`fakeGraphHandle`) y en cada atajo que manda un webhook;
 *   3. los webhooks salen solo a `/api/webhooks/whatsapp` del MISMO origen que `NEXT_PUBLIC_APP_URL`.
 *
 * Qué emula (lo que usa la app; lo demás → 404 del simulador):
 *   - `GET  /dialog/signup` (popup «Simulador de Meta (solo desarrollo)») → `postMessage` `WA_EMBEDDED_SIGNUP` FINISH
 *     `{waba_id, phone_number_id}` + `code` al opener. El `code` vive 30 s y es de un solo uso (como Meta en v4);
 *   - `GET  /oauth/access_token`, `GET /debug_token` (con `granular_scopes`: los dos scopes con `target_ids`);
 *   - `GET  /{waba}/phone_numbers`, `GET /{phone}`, `POST|DELETE|GET /{waba}/subscribed_apps`, `POST /{phone}/register`;
 *   - `POST|GET /{waba}/message_templates` (aprobación automática con webhook o a mano desde el panel);
 *   - `POST /{phone}/media` (verifica que sea un PDF por los magic bytes);
 *   - Resumable Upload API (WA-S6): `POST /{app_id}/uploads` abre la sesión y `POST /upload:<id>?sig=…` (con
 *     `Authorization: OAuth`, `file_offset: 0` y los bytes) devuelve el `h`; el alta de una plantilla con header
 *     DOCUMENT EXIGE ese handle en `example.header_handle` (como Meta: sin él, `cs_documento_v1` no se da de alta);
 *   - `POST /{phone}/messages` (valida plantilla APPROVED, cantidad de params, media del header; el texto libre solo
 *     dentro de las 24 h del último mensaje del paciente) y la cadena sent → delivered → read por webhook firmado,
 *     con `biz_opaque_callback_data`;
 *   - números mágicos del DESTINATARIO: `…0001` → 131026 (no tiene WhatsApp), `…0002` → 131042 (problema de pago del
 *     consultorio en Meta), `…0003` → timeout (se cuelga; Meta igual lo registra, como en la vida real), `…0004` →
 *     130429 (rate limit);
 *   - `/panel`: Confirmo, No puedo ir, BAJA, ALTA, texto, calidad y PARTNER_REMOVED.
 *
 * Estado en `globalThis` (un solo proceso). Los ids llevan la hora: reiniciar el server no choca con las cuentas que
 * quedaron en la base local (índice único parcial de `phoneNumberId`).
 *
 * Nunca se loguea un teléfono ni un token: este módulo no loguea nada.
 */

export { fakeGraphAllowed };

const CODE_TTL_MS = 30_000;
const TEXT_WINDOW_MS = 24 * 3600_000;
const HANG_MS = 12_000;
const WEBHOOK_PATH = "/api/webhooks/whatsapp";

export const FAKE_WA_MAGIC = { undeliverable: "0001", payment: "0002", timeout: "0003", rateLimit: "0004" } as const;

const MANAGEMENT = "whatsapp_business_management";
const MESSAGING = "whatsapp_business_messaging";

export type FakeTemplateStatus = "PENDING" | "APPROVED" | "REJECTED" | "PAUSED" | "DISABLED";
export type FakeMessageStatus = "accepted" | "sent" | "delivered" | "read" | "failed";

type FakePhone = {
  id: string;
  wabaId: string;
  displayPhone: string;
  verifiedName: string;
  qualityRating: "GREEN" | "YELLOW" | "RED";
  messagingLimit: string;
  registered: boolean;
  pin: string | null;
};
type FakeTemplate = {
  id: string;
  name: string;
  language: string;
  category: string;
  status: FakeTemplateStatus;
  rejectedReason: string | null;
  bodyParams: number;
  header: "DOCUMENT" | null;
  buttons: number;
};
type FakeWaba = { id: string; businessId: string; subscribed: boolean; phoneIds: string[]; templates: Map<string, FakeTemplate> };
type FakeCode = { wabaId: string; phoneNumberId: string; grant: FakeSignupGrant; expMs: number; used: boolean };
type FakeToken = { wabaId: string; grant: FakeSignupGrant; revoked: boolean };
type FakeMedia = { id: string; phoneNumberId: string; size: number; sha256: string; mimeType: string };
type FakeUploadSession = { sig: string; token: string; length: number; type: string; used: boolean };
export type FakeGraphMessage = {
  wamid: string;
  wabaId: string;
  phoneNumberId: string;
  /** Dígitos sin `+` (como lo manda Meta en `recipient_id`). */
  to: string;
  type: "template" | "text";
  templateName: string | null;
  bodyParams: string[];
  documentMediaId: string | null;
  callbackData: string | null;
  buttonPayloads: string[];
  status: FakeMessageStatus;
  createdAt: string;
};
export type FakeGraphHook = {
  at: string;
  field: string;
  body: Record<string, unknown>;
  status: number;
  result: string | null;
};
export type FakeGraphConfig = {
  /** `auto`: cada plantilla nueva se aprueba sola con webhook después de `autoApproveDelayMs`. */
  templateApproval: "auto" | "manual";
  autoApproveDelayMs: number;
  /** Cadena sent → delivered → read automática después de cada envío (cada `statusDelayMs`). */
  autoStatuses: boolean;
  statusDelayMs: number;
};
type Store = {
  gen: number;
  seq: number;
  codes: Map<string, FakeCode>;
  tokens: Map<string, FakeToken>;
  wabas: Map<string, FakeWaba>;
  phones: Map<string, FakePhone>;
  media: Map<string, FakeMedia>;
  /** Resumable Upload API (WA-S6): sesiones abiertas y handles emitidos (los que acepta `example.header_handle`). */
  uploads: Map<string, FakeUploadSession>;
  headerHandles: Set<string>;
  messages: Map<string, FakeGraphMessage>;
  /** `${phoneNumberId}|${from}` → último entrante (ventana de 24 h del texto libre). */
  lastInbound: Map<string, number>;
  hooks: FakeGraphHook[];
  config: FakeGraphConfig;
};

const STORE_KEY = "__waFakeGraphStore";
const DEFAULT_CONFIG: FakeGraphConfig = { templateApproval: "auto", autoApproveDelayMs: 1500, autoStatuses: true, statusDelayMs: 800 };

function freshStore(gen: number): Store {
  return {
    gen,
    seq: 0,
    codes: new Map(),
    tokens: new Map(),
    wabas: new Map(),
    phones: new Map(),
    media: new Map(),
    uploads: new Map(),
    headerHandles: new Set(),
    messages: new Map(),
    lastInbound: new Map(),
    hooks: [],
    config: { ...DEFAULT_CONFIG },
  };
}
function store(): Store {
  const g = globalThis as unknown as Record<string, Store | undefined>;
  return (g[STORE_KEY] ??= freshStore(1));
}

/** Vacía el estado (tests). Los timers pendientes de la generación anterior no hacen nada. */
export function resetFakeGraph(): void {
  const g = globalThis as unknown as Record<string, Store | undefined>;
  g[STORE_KEY] = freshStore((g[STORE_KEY]?.gen ?? 0) + 1);
}

export function configureFakeGraph(c: Partial<FakeGraphConfig>): FakeGraphConfig {
  const s = store();
  s.config = { ...s.config, ...c };
  return s.config;
}

export class FakeGraphError extends Error {
  constructor(public code: "not_allowed" | "not_found" | "no_buttons" | "webhook_foreign") {
    super(`fake_graph:${code}`);
    this.name = "FakeGraphError";
  }
}

// ── Config de la app (las mismas claves que lee graph.ts; sin env, los literales de dev) ─────────────────────────

const appId = () => process.env.WHATSAPP_APP_ID?.trim() || env.WHATSAPP_APP_ID || DEV_WAFAKE_LITERALS.WHATSAPP_APP_ID;
const appSecret = () => process.env.WHATSAPP_APP_SECRET?.trim() || env.WHATSAPP_APP_SECRET || DEV_WAFAKE_LITERALS.WHATSAPP_APP_SECRET;
const configId = () => process.env.WHATSAPP_CONFIG_ID?.trim() || env.WHATSAPP_CONFIG_ID || DEV_WAFAKE_LITERALS.WHATSAPP_CONFIG_ID;
const appUrl = () => (process.env.NEXT_PUBLIC_APP_URL?.trim() || env.NEXT_PUBLIC_APP_URL).replace(/\/+$/, "");
const fakeBase = () => `${appUrl()}${WA_FAKE_PATH}`;

// ── Utilidades ─────────────────────────────────────────────────────────────────────────────────────────────────

const NO_STORE = { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer" };
const nowIso = () => new Date().toISOString();
const nowS = () => String(Math.floor(Date.now() / 1000));
const rand = (bytes = 18) => randomBytes(bytes).toString("base64url");

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...NO_STORE } });
}
function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...NO_STORE } });
}
/** Error con la forma de Graph (`{error:{message,type,code,error_subcode,fbtrace_id}}`). */
function graphError(status: number, code: number, message: string, subcode?: number): Response {
  return json({ error: { message, type: code === 190 ? "OAuthException" : "GraphMethodException", code, ...(subcode ? { error_subcode: subcode } : {}), fbtrace_id: rand(8) } }, status);
}
function notFound(): Response {
  return new Response("Not found", { status: 404, headers: NO_STORE });
}

/** Id numérico de 16 dígitos con la hora (no choca con los que quedaron en la base local de corridas anteriores). */
function nextId(prefix: "1" | "2" | "3" | "4" | "5"): string {
  const s = store();
  s.seq = (s.seq + 1) % 10_000;
  return `${prefix}${String(Date.now()).slice(-11)}${String(s.seq).padStart(4, "0")}`;
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

function bearer(req: Request): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
  return m ? m[1].trim() : null;
}
function tokenRec(req: Request): FakeToken | null {
  const t = bearer(req);
  const rec = t ? store().tokens.get(t) : undefined;
  return rec && !rec.revoked ? rec : null;
}

/** Cuerpo de un mensaje del template: `{{n}}` distintos. */
function countParams(text: string): number {
  return new Set(Array.from(text.matchAll(/\{\{(\d+)\}\}/g), (m) => m[1])).size;
}

const tplKey = (name: string, language: string) => `${name}|${language}`;

// ── Cuentas (alta) ─────────────────────────────────────────────────────────────────────────────────────────────

function createAccount(): { waba: FakeWaba; phone: FakePhone } {
  const s = store();
  const waba: FakeWaba = { id: nextId("1"), businessId: nextId("3"), subscribed: false, phoneIds: [], templates: new Map() };
  // Meta da de alta `hello_world` (en_US) aprobada en toda WABA nueva: la prueba de envío la usa (WA-D28).
  waba.templates.set(tplKey(TEST_TEMPLATE.name, TEST_TEMPLATE.language), {
    id: nextId("5"),
    name: TEST_TEMPLATE.name,
    language: TEST_TEMPLATE.language,
    category: "UTILITY",
    status: "APPROVED",
    rejectedReason: null,
    bodyParams: 0,
    header: null,
    buttons: 0,
  });
  const last4 = String(s.seq).padStart(4, "0");
  const phone: FakePhone = {
    id: nextId("2"),
    wabaId: waba.id,
    displayPhone: `+54 9 11 5555-${last4}`,
    verifiedName: "Consultorio de prueba",
    qualityRating: "GREEN",
    messagingLimit: "TIER_250",
    registered: false,
    pin: null,
  };
  waba.phoneIds.push(phone.id);
  s.wabas.set(waba.id, waba);
  s.phones.set(phone.id, phone);
  return { waba, phone };
}

export type FakeSignupResult = { code: string; wabaId: string; phoneNumberId: string; businessId: string; displayPhone: string };

/** Lo mismo que el botón del popup: cuenta + número nuevos y un `code` de 30 s y un solo uso. */
export function fakeGraphSignup(o: { grant?: FakeSignupGrant } = {}): FakeSignupResult {
  if (!fakeGraphAllowed()) throw new FakeGraphError("not_allowed");
  const { waba, phone } = createAccount();
  const code = `FAKEWA-CODE-${rand()}`;
  store().codes.set(code, { wabaId: waba.id, phoneNumberId: phone.id, grant: o.grant ?? "both", expMs: Date.now() + CODE_TTL_MS, used: false });
  return { code, wabaId: waba.id, phoneNumberId: phone.id, businessId: waba.businessId, displayPhone: phone.displayPhone };
}

/**
 * Cuenta ya conectada, sin pasar por el popup ni el canje (para `connectFakeWhatsApp` de los tests): token emitido,
 * app suscripta, número registrado con `pin` y, si se pide, las plantillas dadas de alta en el estado indicado.
 */
export function fakeGraphProvision(o: {
  pin: string;
  templates?: { name: string; language: string; body: string; header: "DOCUMENT" | null; buttons: number; status: FakeTemplateStatus }[];
}): { wabaId: string; phoneNumberId: string; businessId: string; displayPhone: string; token: string } {
  if (!fakeGraphAllowed()) throw new FakeGraphError("not_allowed");
  const { waba, phone } = createAccount();
  const token = `FAKEWA-${rand(24)}`;
  store().tokens.set(token, { wabaId: waba.id, grant: "both", revoked: false });
  waba.subscribed = true;
  phone.registered = true;
  phone.pin = o.pin;
  for (const t of o.templates ?? []) {
    waba.templates.set(tplKey(t.name, t.language), {
      id: nextId("5"),
      name: t.name,
      language: t.language,
      category: "UTILITY",
      status: t.status,
      rejectedReason: null,
      bodyParams: countParams(t.body),
      header: t.header,
      buttons: t.buttons,
    });
  }
  return { wabaId: waba.id, phoneNumberId: phone.id, businessId: waba.businessId, displayPhone: phone.displayPhone, token };
}

// ── Webhooks ───────────────────────────────────────────────────────────────────────────────────────────────────

export type FakeHookResult = { webhookStatus: number; webhookResult?: string; skipped?: "not_subscribed" };

/**
 * POST firmado (`X-Hub-Signature-256` sobre los bytes exactos que se mandan) a `/api/webhooks/whatsapp` de ESTA app.
 * Si la app no está suscripta al WABA (desconectó, o PARTNER_REMOVED), Meta no avisa: el simulador tampoco.
 */
async function postWebhook(wabaId: string, field: string, value: Record<string, unknown>): Promise<FakeHookResult> {
  if (!fakeGraphAllowed()) throw new FakeGraphError("not_allowed");
  const s = store();
  const waba = s.wabas.get(wabaId);
  if (!waba?.subscribed && field !== "account_update") return { webhookStatus: 0, skipped: "not_subscribed" };
  const app = appUrl();
  const target = new URL(`${app}${WEBHOOK_PATH}`);
  // Solo a esta misma app: el simulador no es un cliente HTTP para pegarle a cualquier host con una firma válida.
  if (target.origin !== new URL(app).origin) throw new FakeGraphError("webhook_foreign");
  const body = { object: "whatsapp_business_account", entry: [{ id: wabaId, time: Number(nowS()), changes: [{ field, value }] }] };
  const raw = JSON.stringify(body);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  let status = 0;
  let result: string | undefined;
  try {
    const res = await globalThis.fetch(target.toString(), {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": signMetaPayload(raw, appSecret()) },
      body: raw,
      signal: ac.signal,
      cache: "no-store",
    });
    status = res.status;
    try {
      const j = (await res.json()) as { result?: unknown };
      if (typeof j?.result === "string") result = j.result;
    } catch {
      /* la ruta puede responder sin cuerpo */
    }
  } catch {
    status = 0;
  } finally {
    clearTimeout(timer);
  }
  s.hooks.unshift({ at: nowIso(), field, body, status, result: result ?? null });
  s.hooks.length = Math.min(s.hooks.length, 50);
  return { webhookStatus: status, webhookResult: result };
}

/** Timer que no sobrevive a un `resetFakeGraph` ni deja vivo el proceso. */
function later(ms: number, fn: () => Promise<unknown>): void {
  const gen = store().gen;
  const t = setTimeout(() => {
    if (store().gen !== gen || !fakeGraphAllowed()) return;
    void fn().catch(() => undefined);
  }, ms);
  (t as { unref?: () => void }).unref?.();
}

function metadata(phoneNumberId: string) {
  const p = store().phones.get(phoneNumberId);
  return { display_phone_number: (p?.displayPhone ?? "").replace(/\D/g, ""), phone_number_id: phoneNumberId };
}

const ORDER: FakeMessageStatus[] = ["accepted", "sent", "delivered", "read"];

/** Un webhook de estado del mensaje (con `biz_opaque_callback_data`). `failed` lleva el código en `errors[]`. */
export async function fakeGraphEmitStatus(
  wamid: string,
  status: Exclude<FakeMessageStatus, "accepted">,
  o: { errorCode?: number } = {}
): Promise<FakeHookResult> {
  const m = store().messages.get(wamid);
  if (!m) throw new FakeGraphError("not_found");
  m.status = status;
  const st: Record<string, unknown> = {
    id: m.wamid,
    status,
    timestamp: nowS(),
    recipient_id: m.to,
    ...(m.callbackData ? { biz_opaque_callback_data: m.callbackData } : {}),
  };
  if (status === "sent" || status === "delivered") {
    st.conversation = { id: `conv-${m.wamid.slice(-10)}`, origin: { type: "utility" } };
    st.pricing = { billable: true, pricing_model: "PMP", category: "utility" };
  }
  if (status === "failed") st.errors = [{ code: o.errorCode ?? 131026, title: "Simulated failure" }];
  return postWebhook(m.wabaId, "messages", { messaging_product: "whatsapp", metadata: metadata(m.phoneNumberId), statuses: [st] });
}

/** Avanza la cadena hasta `upTo` (sent → delivered → read), un webhook por paso, en orden. */
export async function fakeGraphAdvance(wamid: string, upTo: "sent" | "delivered" | "read" = "read"): Promise<FakeHookResult[]> {
  const m = store().messages.get(wamid);
  if (!m) throw new FakeGraphError("not_found");
  const out: FakeHookResult[] = [];
  if (m.status === "failed") return out;
  for (let i = ORDER.indexOf(m.status) + 1; i <= ORDER.indexOf(upTo); i++) {
    out.push(await fakeGraphEmitStatus(wamid, ORDER[i] as "sent" | "delivered" | "read"));
  }
  return out;
}

/** Aprueba / rechaza / pausa plantillas (todas las PENDING del WABA si no se dan nombres) con su webhook. */
export async function fakeGraphDecideTemplates(o: {
  wabaId?: string;
  names?: string[];
  language?: string;
  decision?: Exclude<FakeTemplateStatus, "PENDING">;
  reason?: string;
}): Promise<{ name: string; hook: FakeHookResult }[]> {
  const s = store();
  const decision = o.decision ?? "APPROVED";
  const out: { name: string; hook: FakeHookResult }[] = [];
  const wabas = o.wabaId ? [s.wabas.get(o.wabaId)].filter((w): w is FakeWaba => !!w) : [...s.wabas.values()];
  for (const w of wabas) {
    for (const t of w.templates.values()) {
      if (o.names ? !o.names.includes(t.name) : t.status !== "PENDING") continue;
      if (o.language && t.language !== o.language) continue;
      t.status = decision;
      t.rejectedReason = decision === "REJECTED" ? (o.reason ?? "INVALID_FORMAT") : null;
      const hook = await postWebhook(w.id, "message_template_status_update", {
        event: decision,
        message_template_id: Number(t.id),
        message_template_name: t.name,
        message_template_language: t.language,
        reason: decision === "REJECTED" ? t.rejectedReason : "NONE",
      });
      out.push({ name: t.name, hook });
    }
  }
  return out;
}

function inboundBase(phoneNumberId: string, from: string, message: Record<string, unknown>) {
  const s = store();
  s.lastInbound.set(`${phoneNumberId}|${from}`, Date.now());
  return {
    messaging_product: "whatsapp",
    metadata: metadata(phoneNumberId),
    contacts: [{ profile: { name: "Paciente de prueba" }, wa_id: from }],
    messages: [{ from, id: `wamid.IN${rand(16)}`, timestamp: nowS(), ...message }],
  };
}

/** El paciente aprieta un botón del recordatorio («Confirmo» = `c`, «No puedo ir» = `x`) de ESE mensaje. */
export async function fakeGraphPressButton(wamid: string, kind: "c" | "x"): Promise<FakeHookResult> {
  const m = store().messages.get(wamid);
  if (!m) throw new FakeGraphError("not_found");
  const payload = m.buttonPayloads.find((p) => p.startsWith(`wa1.${kind}.`)) ?? m.buttonPayloads[kind === "c" ? 0 : 1];
  if (!payload) throw new FakeGraphError("no_buttons");
  const value = inboundBase(m.phoneNumberId, m.to, {
    type: "button",
    button: { payload, text: kind === "c" ? "Confirmo" : "No puedo ir" },
    context: { from: metadata(m.phoneNumberId).display_phone_number, id: m.wamid },
  });
  return postWebhook(m.wabaId, "messages", value);
}

/**
 * El paciente escribe texto libre (BAJA, ALTA o cualquier cosa) al número del consultorio. `from` en E.164 o dígitos;
 * sin `phoneNumberId`, el número del primer WABA del simulador.
 */
export async function fakeGraphInboundText(o: { from: string; text: string; phoneNumberId?: string }): Promise<FakeHookResult> {
  const s = store();
  const pnid = o.phoneNumberId ?? [...s.phones.keys()][0];
  const phone = pnid ? s.phones.get(pnid) : undefined;
  if (!phone) throw new FakeGraphError("not_found");
  const from = o.from.replace(/^\+/, "");
  return postWebhook(phone.wabaId, "messages", inboundBase(phone.id, from, { type: "text", text: { body: o.text } }));
}

/** Aviso de calidad del número (`phone_number_quality_update`). */
export async function fakeGraphQuality(phoneNumberId: string, event: "FLAGGED" | "UNFLAGGED" | "DOWNGRADE" | "UPGRADE"): Promise<FakeHookResult> {
  const p = store().phones.get(phoneNumberId);
  if (!p) throw new FakeGraphError("not_found");
  p.qualityRating = event === "FLAGGED" || event === "DOWNGRADE" ? (event === "FLAGGED" ? "YELLOW" : "RED") : "GREEN";
  if (event === "DOWNGRADE") p.messagingLimit = "TIER_50";
  return postWebhook(p.wabaId, "phone_number_quality_update", {
    display_phone_number: metadata(p.id).display_phone_number,
    event,
    current_limit: p.messagingLimit,
  });
}

/** El consultorio sacó la app desde Meta (`account_update` PARTNER_REMOVED): se revocan los tokens y la suscripción. */
export async function fakeGraphPartnerRemoved(wabaId: string): Promise<FakeHookResult> {
  const s = store();
  const w = s.wabas.get(wabaId);
  if (!w) throw new FakeGraphError("not_found");
  const hook = await postWebhook(wabaId, "account_update", {
    event: "PARTNER_REMOVED",
    waba_info: { waba_id: wabaId, owner_business_id: w.businessId },
  });
  w.subscribed = false;
  for (const t of s.tokens.values()) if (t.wabaId === wabaId) t.revoked = true;
  return hook;
}

// ── Lectura (tests y panel) ────────────────────────────────────────────────────────────────────────────────────

export function fakeGraphGetMessage(wamid: string): FakeGraphMessage | null {
  return store().messages.get(wamid) ?? null;
}
export function fakeGraphMessages(): FakeGraphMessage[] {
  return [...store().messages.values()];
}
/** WA-S6: el media que subió la app (tamaño + sha256 de los bytes que recibió el simulador), para afirmar que el PDF
 * que salió es exactamente el compartido. */
export function fakeGraphMedia(id: string): Readonly<FakeMedia> | null {
  return store().media.get(id) ?? null;
}

export function fakeGraphMessageByCallback(callbackData: string): FakeGraphMessage | null {
  return fakeGraphMessages().find((m) => m.callbackData === callbackData) ?? null;
}
export function fakeGraphHooks(): FakeGraphHook[] {
  return [...store().hooks].reverse();
}
export function fakeGraphWaba(wabaId: string) {
  const w = store().wabas.get(wabaId);
  if (!w) return null;
  return {
    id: w.id,
    businessId: w.businessId,
    subscribed: w.subscribed,
    phones: w.phoneIds.map((id) => ({ ...store().phones.get(id)! })),
    templates: [...w.templates.values()].map((t) => ({ ...t })),
  };
}

// ── Router ─────────────────────────────────────────────────────────────────────────────────────────────────────

const VERSION_RE = /^v\d{1,3}\.\d$/;
const ID_RE = /^[0-9]{5,25}$/;

/** Router del fake. Lo monta `app/api/whatsapp/fake/[...path]/route.ts`; acá adentro se vuelve a mirar el guard. */
export async function fakeGraphHandle(req: Request): Promise<Response> {
  if (!fakeGraphAllowed()) return notFound();
  const url = new URL(req.url);
  const at = url.pathname.indexOf(WA_FAKE_PATH);
  const sub = at >= 0 ? url.pathname.slice(at + WA_FAKE_PATH.length) : url.pathname;
  let parts = sub.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length && VERSION_RE.test(parts[0])) parts = parts.slice(1);
  const method = req.method.toUpperCase();
  const [a, b] = parts;

  if (method === "GET" && (parts.length === 0 || (a === "panel" && parts.length === 1))) return panelPage(null);
  if (a === "panel" && method === "POST" && b && parts.length === 2) return panelAction(req, b);
  if (a === "dialog" && b === "signup" && parts.length === 2) return method === "GET" ? signupPage(url) : signupDecide(req);
  if (method === "GET" && a === "oauth" && b === "access_token") return accessToken(url);
  if (method === "GET" && a === "debug_token" && parts.length === 1) return debugToken(req, url);

  // Resumable Upload API (WA-S6). El id de la app no es numérico en el fake (`DEV_WAFAKE_LITERALS`): va antes del ruteo
  // por id de WABA/número.
  if (method === "POST" && a === appId() && b === "uploads" && parts.length === 2) return uploadSessionStart(req, url);
  if (method === "POST" && a?.startsWith("upload:") && parts.length === 1) return uploadSessionData(req, a, url);

  if (a && ID_RE.test(a)) {
    const s = store();
    const waba = s.wabas.get(a);
    const phone = s.phones.get(a);
    if (waba) {
      if (b === "phone_numbers" && method === "GET") return phoneNumbers(req, waba);
      if (b === "subscribed_apps") return subscribedApps(req, waba, method);
      if (b === "message_templates" && method === "POST") return createTemplate(req, waba);
      if (b === "message_templates" && method === "GET") return listTemplates(req, waba);
    }
    if (phone) {
      if (!b && method === "GET") return phoneById(req, phone);
      if (b === "register" && method === "POST") return register(req, phone);
      if (b === "media" && method === "POST") return uploadMedia(req, phone);
      if (b === "messages" && method === "POST") return sendMessage(req, phone);
    }
    if (!waba && !phone) return graphError(400, 100, "Unsupported request - object does not exist", 33);
  }
  return graphError(404, 100, "Ruta del simulador inexistente");
}

// ── Alta ───────────────────────────────────────────────────────────────────────────────────────────────────────

function signupPage(url: URL): Response {
  const q = url.searchParams;
  const action = `${fakeBase()}/dialog/signup`;
  if (q.get("app_id") !== appId() || q.get("config_id") !== configId()) {
    return html(signupPageHtml({ action, appId: "", configId: "", error: "El app_id o el config_id no son los de la app (WHATSAPP_APP_ID / WHATSAPP_CONFIG_ID)." }), 400);
  }
  return html(signupPageHtml({ action, appId: appId(), configId: configId() }));
}

async function signupDecide(req: Request): Promise<Response> {
  const b = await readBody(req);
  const targetOrigin = new URL(appUrl()).origin;
  if (b.app_id !== appId() || b.config_id !== configId()) {
    return html(signupPageHtml({ action: "", appId: "", configId: "", error: "El app_id o el config_id no son los de la app." }), 400);
  }
  if (b.decision === "cancel") {
    return html(signupDoneHtml({ message: { type: "WA_EMBEDDED_SIGNUP", event: "CANCEL", data: { current_step: "PHONE_NUMBER_SETUP" } }, targetOrigin, cancelled: true }));
  }
  const grant = FAKE_SIGNUP_GRANTS.some((g) => g.value === b.grant) ? (b.grant as FakeSignupGrant) : "both";
  const r = fakeGraphSignup({ grant });
  return html(
    signupDoneHtml({
      message: {
        type: "WA_EMBEDDED_SIGNUP",
        event: "FINISH",
        version: 4,
        data: { waba_id: r.wabaId, phone_number_id: r.phoneNumberId, business_id: r.businessId },
        // Solo en el simulador: en Meta real el `code` llega por el callback de `FB.login`.
        code: r.code,
      },
      targetOrigin,
      cancelled: false,
    })
  );
}

function accessToken(url: URL): Response {
  const q = url.searchParams;
  if (q.get("client_id") !== appId() || q.get("client_secret") !== appSecret()) {
    return graphError(400, 101, "Error validating client secret.");
  }
  const code = q.get("code") ?? "";
  const s = store();
  const rec = s.codes.get(code);
  if (!rec) return graphError(400, 100, "Invalid verification code format.", 36008);
  if (rec.used) return graphError(400, 100, "This authorization code has been used.", 36009);
  if (rec.expMs <= Date.now()) return graphError(400, 100, "This authorization code has expired.", 36007);
  rec.used = true;
  const token = `FAKEWA-${rand(24)}`;
  s.tokens.set(token, { wabaId: rec.wabaId, grant: rec.grant, revoked: false });
  return json({ access_token: token, token_type: "bearer" });
}

function debugToken(req: Request, url: URL): Response {
  if (bearer(req) !== `${appId()}|${appSecret()}`) return graphError(400, 190, "Invalid OAuth access token - Cannot parse access token");
  const input = url.searchParams.get("input_token") ?? "";
  const rec = store().tokens.get(input);
  if (!rec || rec.revoked) {
    return json({ data: { app_id: appId(), type: "SYSTEM_USER", is_valid: false, scopes: [], granular_scopes: [] } });
  }
  const target = rec.grant === "other_waba" ? "100000000000001" : rec.wabaId;
  const granular: { scope: string; target_ids: string[] }[] = [];
  if (rec.grant !== "messaging_only") granular.push({ scope: MANAGEMENT, target_ids: [target] });
  if (rec.grant !== "management_only") granular.push({ scope: MESSAGING, target_ids: [target] });
  return json({
    data: {
      app_id: appId(),
      type: "SYSTEM_USER",
      application: "App de prueba",
      expires_at: 0,
      data_access_expires_at: 0,
      is_valid: true,
      scopes: [...granular.map((g) => g.scope), "public_profile"],
      granular_scopes: granular,
      user_id: "100000000000999",
    },
  });
}

// ── WABA y número ──────────────────────────────────────────────────────────────────────────────────────────────

/** El token tiene que ser de ese WABA (como Meta: un token del alta solo ve la cuenta que se concedió). */
function authFor(req: Request, wabaId: string): FakeToken | Response {
  const rec = tokenRec(req);
  if (!rec) return graphError(401, 190, "Invalid OAuth access token.");
  if (rec.wabaId !== wabaId) return graphError(403, 200, "Permissions error");
  return rec;
}

function phoneJson(p: FakePhone) {
  return {
    id: p.id,
    display_phone_number: p.displayPhone,
    verified_name: p.verifiedName,
    quality_rating: p.qualityRating,
    name_status: "APPROVED",
    code_verification_status: "VERIFIED",
    messaging_limit_tier: p.messagingLimit,
    platform_type: p.registered ? "CLOUD_API" : "NOT_APPLICABLE",
  };
}

function phoneNumbers(req: Request, w: FakeWaba): Response {
  const auth = authFor(req, w.id);
  if (auth instanceof Response) return auth;
  return json({ data: w.phoneIds.map((id) => phoneJson(store().phones.get(id)!)) });
}

function phoneById(req: Request, p: FakePhone): Response {
  const auth = authFor(req, p.wabaId);
  if (auth instanceof Response) return auth;
  return json(phoneJson(p));
}

function subscribedApps(req: Request, w: FakeWaba, method: string): Response {
  const auth = authFor(req, w.id);
  if (auth instanceof Response) return auth;
  if (method === "POST") w.subscribed = true;
  else if (method === "DELETE") w.subscribed = false;
  else if (method === "GET") return json({ data: w.subscribed ? [{ whatsapp_business_api_data: { id: appId(), name: "App de prueba" } }] : [] });
  else return graphError(400, 100, "Unsupported method");
  return json({ success: true });
}

async function register(req: Request, p: FakePhone): Promise<Response> {
  const auth = authFor(req, p.wabaId);
  if (auth instanceof Response) return auth;
  const b = await readBody(req);
  if (b.messaging_product !== "whatsapp") return graphError(400, 100, "Param messaging_product is required");
  if (typeof b.pin !== "string" || !/^[0-9]{6}$/.test(b.pin)) return graphError(400, 100, "Param pin must be 6 digits");
  // Un número ya registrado con OTRO PIN (alta anterior desde otro lado): Meta pide el PIN viejo.
  if (p.registered && p.pin && p.pin !== b.pin) return graphError(400, 133005, "Two step verification PIN Mismatch");
  p.registered = true;
  p.pin = b.pin;
  return json({ success: true });
}

// ── Plantillas ─────────────────────────────────────────────────────────────────────────────────────────────────

async function createTemplate(req: Request, w: FakeWaba): Promise<Response> {
  const auth = authFor(req, w.id);
  if (auth instanceof Response) return auth;
  const b = await readBody(req);
  const name = typeof b.name === "string" ? b.name : "";
  const language = typeof b.language === "string" ? b.language : "";
  const category = typeof b.category === "string" ? b.category : "";
  if (!/^[a-z0-9_]{1,512}$/.test(name)) return graphError(400, 100, "Invalid parameter: name");
  if (!/^[a-z]{2}(_[A-Z]{2})?$/.test(language)) return graphError(400, 100, "Invalid parameter: language");
  if (!["UTILITY", "MARKETING", "AUTHENTICATION"].includes(category)) return graphError(400, 100, "Invalid parameter: category");
  const comps = Array.isArray(b.components) ? (b.components as Record<string, unknown>[]) : [];
  const body = comps.find((c) => c?.type === "BODY");
  if (!body || typeof body.text !== "string") return graphError(400, 100, "Invalid parameter: components (BODY)");
  if (w.templates.has(tplKey(name, language))) return graphError(400, 100, "Message template already exists", 2388024);
  const header = comps.find((c) => c?.type === "HEADER");
  // WA-S6: como Meta, el header DOCUMENT necesita un ejemplo subido por la Resumable Upload API (el `h` de la sesión).
  if (header?.format === "DOCUMENT") {
    const ex = header.example as { header_handle?: unknown } | undefined;
    const h = Array.isArray(ex?.header_handle) ? ex.header_handle[0] : undefined;
    if (typeof h !== "string" || !store().headerHandles.has(h)) return graphError(400, 100, "Invalid parameter: example.header_handle is required for DOCUMENT headers");
  }
  const buttons = comps.find((c) => c?.type === "BUTTONS");
  const t: FakeTemplate = {
    id: nextId("5"),
    name,
    language,
    category,
    status: "PENDING",
    rejectedReason: null,
    bodyParams: countParams(body.text),
    header: header?.format === "DOCUMENT" ? "DOCUMENT" : null,
    buttons: Array.isArray(buttons?.buttons) ? (buttons.buttons as unknown[]).length : 0,
  };
  w.templates.set(tplKey(name, language), t);
  const cfg = store().config;
  if (cfg.templateApproval === "auto") {
    later(cfg.autoApproveDelayMs, () => fakeGraphDecideTemplates({ wabaId: w.id, names: [name], language, decision: "APPROVED" }));
  }
  return json({ id: t.id, status: t.status, category: t.category });
}

function listTemplates(req: Request, w: FakeWaba): Response {
  const auth = authFor(req, w.id);
  if (auth instanceof Response) return auth;
  return json({
    data: [...w.templates.values()].map((t) => ({
      id: t.id,
      name: t.name,
      language: t.language,
      status: t.status,
      category: t.category,
      rejected_reason: t.rejectedReason ?? "NONE",
    })),
    paging: { cursors: { before: "a", after: "b" } },
  });
}

// ── Media ──────────────────────────────────────────────────────────────────────────────────────────────────────

async function uploadMedia(req: Request, p: FakePhone): Promise<Response> {
  const auth = authFor(req, p.wabaId);
  if (auth instanceof Response) return auth;
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return graphError(400, 100, "Invalid multipart body");
  }
  if (form.get("messaging_product") !== "whatsapp") return graphError(400, 100, "Param messaging_product is required");
  const file = form.get("file");
  if (!file || typeof file === "string") return graphError(400, 100, "Param file is required");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = String(form.get("type") ?? file.type ?? "");
  // Solo PDF (lo único que manda la app, `cs_documento_v1`): por los magic bytes, no por el content-type que dice el
  // cliente. Un HTML con `type=application/pdf` no pasa.
  const isPdf = bytes.length > 5 && Buffer.from(bytes.subarray(0, 5)).toString("latin1") === "%PDF-";
  if (type !== "application/pdf" || !isPdf) return graphError(400, 131053, "Media upload error: not a valid PDF");
  if (bytes.length > 100 * 1024 * 1024) return graphError(400, 131053, "Media upload error: file too large");
  const id = nextId("4");
  store().media.set(id, { id, phoneNumberId: p.id, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), mimeType: type });
  return json({ id });
}

// ── Resumable Upload API (WA-S6) ───────────────────────────────────────────────────────────────────────────────

function uploadSessionStart(req: Request, url: URL): Response {
  const rec = tokenRec(req);
  if (!rec) return graphError(401, 190, "Invalid OAuth access token.");
  const q = url.searchParams;
  const length = Number(q.get("file_length"));
  const type = q.get("file_type") ?? "";
  if (!q.get("file_name") || !Number.isInteger(length) || length <= 0 || !type) return graphError(400, 100, "Invalid parameter: file_name, file_length y file_type");
  if (!["application/pdf", "image/jpeg", "image/png", "video/mp4"].includes(type)) return graphError(400, 100, "Invalid parameter: file_type");
  const id = `upload:${rand(18)}`;
  const sig = rand(12);
  store().uploads.set(id, { sig, token: bearer(req)!, length, type, used: false });
  // Como Meta: el id viene con la firma pegada como query.
  return json({ id: `${id}?sig=${sig}` });
}

async function uploadSessionData(req: Request, id: string, url: URL): Promise<Response> {
  const m = /^OAuth\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
  const tok = m?.[1].trim() ?? "";
  const rec = store().tokens.get(tok);
  if (!rec || rec.revoked) return graphError(401, 190, "Invalid OAuth access token.");
  const ses = store().uploads.get(id);
  if (!ses || ses.used || ses.token !== tok || url.searchParams.get("sig") !== ses.sig) return graphError(400, 100, "Invalid upload session");
  if (req.headers.get("file_offset") !== "0") return graphError(400, 100, "Invalid parameter: file_offset");
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length !== ses.length) return graphError(400, 100, "Invalid parameter: file_length no coincide con los bytes");
  if (ses.type === "application/pdf" && Buffer.from(bytes.subarray(0, 5)).toString("latin1") !== "%PDF-") return graphError(400, 100, "Invalid file: not a PDF");
  ses.used = true;
  const h = `4:${rand(24)}`;
  store().headerHandles.add(h);
  return json({ h });
}

// ── Mensajes ───────────────────────────────────────────────────────────────────────────────────────────────────

function waitAbort(signal: AbortSignal | undefined, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

type Comp = { type?: unknown; sub_type?: unknown; parameters?: unknown };

async function sendMessage(req: Request, p: FakePhone): Promise<Response> {
  const auth = authFor(req, p.wabaId);
  if (auth instanceof Response) return auth;
  const s = store();
  const w = s.wabas.get(p.wabaId)!;
  const b = await readBody(req);
  if (b.messaging_product !== "whatsapp") return graphError(400, 100, "Param messaging_product is required");
  if (!p.registered) return graphError(400, 133010, "Phone number not registered");
  const to = typeof b.to === "string" ? b.to.replace(/^\+/, "") : "";
  if (!/^[0-9]{8,15}$/.test(to)) return graphError(400, 100, "Invalid parameter: to");

  // Números mágicos del destinatario (C-WA5).
  if (to.endsWith(FAKE_WA_MAGIC.undeliverable)) return graphError(400, 131026, "Message undeliverable");
  if (to.endsWith(FAKE_WA_MAGIC.payment)) return graphError(400, 131042, "Business eligibility payment issue");
  if (to.endsWith(FAKE_WA_MAGIC.rateLimit)) return graphError(429, 130429, "Rate limit hit");

  const callbackData = typeof b.biz_opaque_callback_data === "string" ? b.biz_opaque_callback_data.slice(0, 512) : null;
  const rec: FakeGraphMessage = {
    wamid: `wamid.${rand(24)}`,
    wabaId: w.id,
    phoneNumberId: p.id,
    to,
    type: "text",
    templateName: null,
    bodyParams: [],
    documentMediaId: null,
    callbackData,
    buttonPayloads: [],
    status: "accepted",
    createdAt: nowIso(),
  };

  if (b.type === "template") {
    const tp = (b.template ?? {}) as { name?: unknown; language?: { code?: unknown }; components?: unknown };
    const name = typeof tp.name === "string" ? tp.name : "";
    const lang = typeof tp.language?.code === "string" ? tp.language.code : "";
    const t = w.templates.get(tplKey(name, lang));
    if (!t || t.status === "PENDING" || t.status === "REJECTED") return graphError(400, 132001, "Template name does not exist in the translation");
    if (t.status === "PAUSED") return graphError(400, 132015, "Template is paused");
    if (t.status === "DISABLED") return graphError(400, 132016, "Template has been disabled");
    const comps = (Array.isArray(tp.components) ? tp.components : []) as Comp[];
    const bodyC = comps.find((c) => c.type === "body");
    const bodyParams = (Array.isArray(bodyC?.parameters) ? bodyC!.parameters : []) as { type?: unknown; text?: unknown }[];
    if (bodyParams.length !== t.bodyParams || bodyParams.some((x) => x.type !== "text" || typeof x.text !== "string" || !x.text.trim())) {
      return graphError(400, 132000, "Number of parameters does not match the expected number of params");
    }
    if (t.header === "DOCUMENT") {
      const h = comps.find((c) => c.type === "header");
      const doc = (Array.isArray(h?.parameters) ? (h!.parameters as { type?: unknown; document?: { id?: unknown; link?: unknown } }[]) : [])[0];
      if (doc?.document?.link !== undefined) return graphError(400, 132012, "Parameter format does not match: use a media id");
      const media = typeof doc?.document?.id === "string" ? s.media.get(doc.document.id) : undefined;
      if (doc?.type !== "document" || !media || media.phoneNumberId !== p.id) return graphError(400, 131053, "Media not found");
      rec.documentMediaId = media.id;
    }
    const buttonComps = comps.filter((c) => c.type === "button");
    if (buttonComps.length > t.buttons) return graphError(400, 132000, "Too many button parameters");
    for (const bc of buttonComps) {
      const prm = (Array.isArray(bc.parameters) ? bc.parameters : [])[0] as { type?: unknown; payload?: unknown } | undefined;
      if (bc.sub_type !== "quick_reply" || prm?.type !== "payload" || typeof prm.payload !== "string" || prm.payload.length > 256) {
        return graphError(400, 132000, "Invalid button parameter");
      }
      rec.buttonPayloads.push(prm.payload);
    }
    rec.type = "template";
    rec.templateName = t.name;
    rec.bodyParams = bodyParams.map((x) => String(x.text));
  } else if (b.type === "text") {
    const body = (b.text as { body?: unknown } | undefined)?.body;
    if (typeof body !== "string" || !body.trim() || body.length > 4096) return graphError(400, 100, "Invalid parameter: text.body");
    const last = s.lastInbound.get(`${p.id}|${to}`);
    if (!last || Date.now() - last > TEXT_WINDOW_MS) {
      return graphError(400, 131047, "Re-engagement message: more than 24 hours have passed since the customer last replied");
    }
  } else {
    return graphError(400, 100, "Unsupported message type");
  }

  s.messages.set(rec.wamid, rec);
  // `…0003`: Meta lo aceptó pero la respuesta no llega a tiempo (el caso que `biz_opaque_callback_data` resuelve).
  if (to.endsWith(FAKE_WA_MAGIC.timeout)) await waitAbort(req.signal, HANG_MS);
  if (s.config.autoStatuses) {
    const d = s.config.statusDelayMs;
    later(d, () => fakeGraphEmitStatus(rec.wamid, "sent"));
    later(2 * d, () => fakeGraphEmitStatus(rec.wamid, "delivered"));
    later(3 * d, () => fakeGraphEmitStatus(rec.wamid, "read"));
  }
  return json({ messaging_product: "whatsapp", contacts: [{ input: b.to, wa_id: to }], messages: [{ id: rec.wamid, message_status: "accepted" }] });
}

// ── Panel ──────────────────────────────────────────────────────────────────────────────────────────────────────

function panelView(flash: string | null): FakePanelView {
  const s = store();
  return {
    base: fakeBase(),
    flash,
    approval: s.config.templateApproval,
    autoStatuses: s.config.autoStatuses,
    wabas: [...s.wabas.values()].map((w) => ({
      id: w.id,
      subscribed: w.subscribed,
      phones: w.phoneIds.map((id) => {
        const p = s.phones.get(id)!;
        return { id: p.id, displayPhone: p.displayPhone, qualityRating: p.qualityRating, registered: p.registered };
      }),
      templates: [...w.templates.values()].map((t) => ({ name: t.name, language: t.language, status: t.status })),
    })),
    messages: [...s.messages.values()]
      .reverse()
      .slice(0, 30)
      .map((m) => ({
        wamid: m.wamid,
        toMasked: maskPhone(`+${m.to}`),
        label: m.type === "template" ? `Plantilla ${m.templateName}` : "Texto",
        status: m.status,
        hasButtons: m.buttonPayloads.length > 0,
      })),
    hooks: s.hooks.slice(0, 20).map((h) => ({ at: h.at, field: h.field, status: h.status, result: h.result })),
  };
}

function panelPage(flash: string | null, status = 200): Response {
  return html(panelHtml(panelView(flash)), status);
}

function hookFlash(h: FakeHookResult): string {
  if (h.skipped) return "No se mandó el webhook: la app no está suscripta a esa cuenta.";
  return `Webhook enviado · respuesta ${h.webhookStatus} · ${h.webhookResult ?? "sin resultado"}`;
}

async function panelAction(req: Request, action: string): Promise<Response> {
  const b = await readBody(req);
  const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : "");
  try {
    switch (action) {
      case "button": {
        const kind = str("kind") === "x" ? "x" : "c";
        return panelPage(hookFlash(await fakeGraphPressButton(str("wamid"), kind)));
      }
      case "inbound": {
        const m = store().messages.get(str("wamid"));
        if (!m) throw new FakeGraphError("not_found");
        const text = str("text").slice(0, 200) || "Hola";
        return panelPage(hookFlash(await fakeGraphInboundText({ from: m.to, text, phoneNumberId: m.phoneNumberId })));
      }
      case "status": {
        const hooks = await fakeGraphAdvance(str("wamid"), nextStatus(str("wamid")));
        return panelPage(hooks.length ? hookFlash(hooks[hooks.length - 1]) : "El mensaje ya no cambia de estado.");
      }
      case "quality": {
        const ev = str("event");
        const event = ev === "UNFLAGGED" || ev === "DOWNGRADE" || ev === "UPGRADE" ? ev : "FLAGGED";
        return panelPage(hookFlash(await fakeGraphQuality(str("phone_number_id"), event)));
      }
      case "partner-removed":
        return panelPage(hookFlash(await fakeGraphPartnerRemoved(str("waba_id"))));
      case "template": {
        const d = str("decision");
        const decision = d === "REJECTED" || d === "PAUSED" || d === "DISABLED" ? d : "APPROVED";
        const r = await fakeGraphDecideTemplates({ wabaId: str("waba_id"), names: [str("name")], language: str("language") || undefined, decision });
        return panelPage(r.length ? hookFlash(r[0].hook) : "No hay una plantilla con ese nombre.");
      }
      case "approval":
        configureFakeGraph({ templateApproval: str("mode") === "manual" ? "manual" : "auto" });
        return panelPage("Listo.");
      case "auto-statuses":
        configureFakeGraph({ autoStatuses: str("on") === "1" });
        return panelPage("Listo.");
      default:
        return panelPage("Acción del panel inexistente.", 404);
    }
  } catch (e) {
    if (e instanceof FakeGraphError) return panelPage(e.code === "no_buttons" ? "Ese mensaje no tiene botones." : "No existe ese mensaje o esa cuenta.", 404);
    throw e;
  }
}

function nextStatus(wamid: string): "sent" | "delivered" | "read" {
  const m = store().messages.get(wamid);
  const i = m ? ORDER.indexOf(m.status) : -1;
  return (ORDER[Math.min(Math.max(i + 1, 1), 3)] ?? "read") as "sent" | "delivered" | "read";
}
