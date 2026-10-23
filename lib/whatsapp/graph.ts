import "server-only";
import { env, whatsappGraphVersion, whatsappMode } from "@/lib/env";
import { logger } from "@/lib/logger";
import { classifyGraphError } from "@/lib/whatsapp/logic";
import type { WaBuiltTemplate, WaTemplateSpec } from "@/lib/whatsapp/templates";
import type { WaErrorClass } from "@/lib/whatsapp/types";

/**
 * WA-P3 (T6, C-WA4, brief §26.5) · Cliente de la Graph API de Meta (WhatsApp Cloud API). Es el ÚNICO archivo que
 * conoce `graph.facebook.com` (lo fija `tests/unit/whatsapp-guard.test.ts`, de INT): la cuenta, la cola, el webhook y
 * el cron hablan con Meta solo a través de estas funciones.
 *
 * Reglas:
 *   - NUNCA tira. Red, timeout, HTTP de error, cuerpo inválido y el modo apagado vuelven como `GraphErr` con la
 *     clasificación de `classifyGraphError` (WA-P1), así el caller decide reintento / culpa sin un try/catch propio.
 *   - Timeout de 8 s, o de 2,5 s con `inline` (el envío inline del hook post-commit, C-WA8: no puede colgar la
 *     respuesta de la action que creó el turno).
 *   - Base por modo, en cada llamada (`whatsappMode()`): `fake` → `${APP_URL}/api/whatsapp/fake` (el simulador de la
 *     propia app, C-WA5); `sandbox`/`live` → Meta; `off` → no se llama a nadie (`kind: "off"`).
 *   - Cada envío lleva `biz_opaque_callback_data = message.id` (el nuestro): Meta lo devuelve en cada webhook de
 *     estado, así que un timeout no duplica el mensaje. Si Meta sí lo aceptó, el `sent` llega con nuestro id y la
 *     cola lo reconcilia en vez de mandarlo de nuevo.
 *   - El token va en el header, nunca en la URL; el teléfono va en el cuerpo, nunca en la URL. Los logs llevan solo
 *     método, path SIN query (`debug_token` y `oauth/access_token` llevan el token/secreto en la query, como pide
 *     Meta) y el código de error. Nunca el cuerpo de la respuesta ni el `message` de Meta (puede citar el número).
 *   - `globalThis.fetch` a propósito: el helper de tests (`installFakeGraph`) lo reemplaza para enrutar al fake.
 *   - Nunca dentro de una transacción de DB (regla de T6): el caller llama acá antes o después, nunca adentro.
 */

export const GRAPH_TIMEOUT_MS = 8_000;
export const GRAPH_INLINE_TIMEOUT_MS = 2_500;
export const WA_FAKE_PATH = "/api/whatsapp/fake";
const META_GRAPH_HOST = "https://graph.facebook.com";
/** Origen del popup del Embedded Signup (el SDK de Facebook lo abre ahí y el `postMessage` llega desde ahí). */
const META_DIALOG_ORIGIN = "https://www.facebook.com";

export type GraphErrKind = "off" | "network" | "timeout" | "http" | "invalid";

export type GraphErr = {
  ok: false;
  kind: GraphErrKind;
  status?: number;
  /** `error.code` / `error.error_subcode` de Meta, si vinieron. */
  code: number | null;
  subcode: number | null;
  errorClass: WaErrorClass;
  /** Para `errorCode`/`lastErrorCode` (CHECK `^[a-z_]{1,40}(:[0-9]{1,7})?$`). Nunca el mensaje de Meta. */
  errorCode: string;
  retryable: boolean;
};
export type GraphOk<T> = { ok: true; status: number; data: T };
export type GraphResult<T> = GraphOk<T> | GraphErr;

export type GraphCallOptions = {
  /** Envío inline (hook post-commit): 2,5 s en vez de 8 s. */
  inline?: boolean;
  /** Override del timeout (tests y el cron con presupuesto propio). */
  timeoutMs?: number;
};

export type GraphFetchOptions = GraphCallOptions & {
  token?: string;
  method?: "GET" | "POST" | "DELETE";
  query?: Record<string, string | number | undefined>;
  json?: unknown;
  form?: FormData;
  /** Cuerpo binario crudo (WA-S6: la Resumable Upload API recibe los bytes tal cual, no multipart). */
  binary?: { bytes: Uint8Array; contentType?: string };
  /** Headers extra (WA-S6: `file_offset`). Nunca el token: va por `token` + `authScheme`. */
  headers?: Record<string, string>;
  /** `Bearer` (default) u `OAuth` (lo que pide `POST /{upload_id}` de la Resumable Upload API). */
  authScheme?: "Bearer" | "OAuth";
};

/** URL de la app vigente: los tests la cambian en caliente y `env` se congela al importar. */
function waAppUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL?.trim() || env.NEXT_PUBLIC_APP_URL).replace(/\/+$/, "");
}

/** Base de la Graph API según el modo (sin la versión), o null con el modo apagado. */
export function graphApiBase(): string | null {
  const mode = whatsappMode();
  if (mode === "off") return null;
  if (mode === "fake") return `${waAppUrl()}${WA_FAKE_PATH}`;
  return META_GRAPH_HOST;
}

/**
 * A dónde abre el cliente el popup del alta y de qué origen tiene que aceptar el `postMessage` (WA-U1). Con `fake`
 * es la página del simulador de la propia app; en sandbox/live el popup lo abre el SDK de Facebook (`FB.login` con
 * `config_id`) y el mensaje llega desde `www.facebook.com`. Lo arma el server (este módulo es server-only) y se le pasa
 * al client component como dato.
 */
export function signupDialogTarget(): { mode: "fake"; dialogUrl: string; origin: string } | { mode: "meta"; origin: string } | null {
  const mode = whatsappMode();
  if (mode === "off") return null;
  if (mode === "fake") {
    const app = waAppUrl();
    return { mode: "fake", dialogUrl: `${app}${WA_FAKE_PATH}/dialog/signup`, origin: new URL(app).origin };
  }
  return { mode: "meta", origin: META_DIALOG_ORIGIN };
}

/** Path para logs: sin query y con ids largos acortados (los ids de Meta no son PHI, pero no aportan al log). */
function logPath(path: string): string {
  return path.split("?")[0].replace(/[0-9]{8,}/g, "…").replace(/[A-Za-z0-9_-]{32,}/g, "…");
}

function fail(kind: GraphErrKind, o: { status?: number; code?: number | null; subcode?: number | null } = {}): GraphErr {
  const code = o.code ?? null;
  const c =
    kind === "timeout"
      ? classifyGraphError({ timeout: true })
      : kind === "network"
        ? classifyGraphError({ network: true })
        : kind === "off"
          ? { errorClass: "account" as const, errorCode: "mode_off", retryable: false }
          : kind === "invalid"
            ? { errorClass: "retry" as const, errorCode: "invalid_response", retryable: true }
            : classifyGraphError({ code, httpStatus: o.status ?? null });
  return { ok: false, kind, status: o.status, code, subcode: o.subcode ?? null, ...c };
}

function metaError(json: unknown): { code: number | null; subcode: number | null } {
  const e = (json as { error?: { code?: unknown; error_subcode?: unknown } } | null)?.error;
  const num = (v: unknown) => (typeof v === "number" && Number.isInteger(v) ? v : null);
  return { code: num(e?.code), subcode: num(e?.error_subcode) };
}

/**
 * Llamada cruda a la Graph API. `path` sin la versión (`/123/messages`): se le antepone `whatsappGraphVersion()`.
 * Devuelve el JSON tal cual; las funciones de abajo lo validan y lo pasan a camelCase.
 */
export async function graphFetch(path: string, o: GraphFetchOptions = {}): Promise<GraphResult<unknown>> {
  const method = o.method ?? "GET";
  const base = graphApiBase();
  if (!base) {
    logger.warn("whatsapp.graph.mode_off", { path: logPath(path), method });
    return fail("off");
  }
  const url = new URL(`${base}/${whatsappGraphVersion()}${path.startsWith("/") ? path : `/${path}`}`);
  for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));

  const headers: Record<string, string> = { accept: "application/json" };
  for (const [k, v] of Object.entries(o.headers ?? {})) if (k.toLowerCase() !== "authorization") headers[k.toLowerCase()] = v;
  if (o.token) headers.authorization = `${o.authScheme ?? "Bearer"} ${o.token}`;
  let body: BodyInit | undefined;
  if (o.form) body = o.form; // el content-type multipart con boundary lo pone fetch
  else if (o.binary) {
    headers["content-type"] = o.binary.contentType ?? "application/octet-stream";
    body = new Uint8Array(o.binary.bytes); // copia propia (mismo motivo que en `uploadMedia`)
  } else if (o.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(o.json);
  }

  const timeoutMs = o.timeoutMs ?? (o.inline ? GRAPH_INLINE_TIMEOUT_MS : GRAPH_TIMEOUT_MS);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res: Response;
  try {
    res = await globalThis.fetch(url.toString(), { method, headers, body, signal: ac.signal, cache: "no-store" });
  } catch (err) {
    clearTimeout(timer);
    const kind = ac.signal.aborted ? "timeout" : "network";
    // Solo el nombre del error: el mensaje de undici puede traer la URL completa (con la query).
    logger.warn("whatsapp.graph.failed", { path: logPath(path), method, kind, error: (err as Error)?.name });
    return fail(kind);
  }

  // El timer sigue corriendo mientras se lee el cuerpo: un Graph que manda headers y se cuelga en el body también corta.
  let json: unknown = null;
  try {
    const text = await res.text();
    json = text ? JSON.parse(text) : null;
  } catch {
    if (ac.signal.aborted) {
      logger.warn("whatsapp.graph.failed", { path: logPath(path), method, kind: "timeout" });
      return fail("timeout");
    }
    json = null;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const e = metaError(json);
    const r = fail("http", { status: res.status, ...e });
    logger.warn("whatsapp.graph.status", { path: logPath(path), method, status: res.status, errorCode: r.errorCode });
    return r;
  }
  return { ok: true, status: res.status, data: json };
}

// ── Helpers de forma ───────────────────────────────────────────────────────────────────────────────────────────

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : typeof v === "number" ? String(v) : null);
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

function shape<T>(r: GraphResult<unknown>, path: string, pick: (j: Record<string, unknown>) => T | null): GraphResult<T> {
  if (!r.ok) return r;
  const j = obj(r.data);
  const v = j ? pick(j) : null;
  if (v === null) {
    logger.warn("whatsapp.graph.invalid", { path: logPath(path) });
    return fail("invalid", { status: r.status });
  }
  return { ok: true, status: r.status, data: v };
}

function appCreds(): { appId: string; appSecret: string } | null {
  const appId = process.env.WHATSAPP_APP_ID?.trim() || env.WHATSAPP_APP_ID;
  const appSecret = process.env.WHATSAPP_APP_SECRET?.trim() || env.WHATSAPP_APP_SECRET;
  return appId && appSecret ? { appId, appSecret } : null;
}

const toDigits = (to: string) => to.replace(/^\+/, "");

// ── Alta (Embedded Signup v4) ──────────────────────────────────────────────────────────────────────────────────

/**
 * Canjea el `code` del Embedded Signup por el token del system user del negocio (business integration token). El
 * `code` vive 30 s y es de un solo uso: el cliente lo manda a la action apenas llega. `client_secret` en la query es
 * lo que pide Meta para este endpoint (GET); no se loguea (`logPath` corta la query).
 */
export async function exchangeCode(
  code: string,
  o: GraphCallOptions = {}
): Promise<GraphResult<{ accessToken: string; expiresIn: number | null }>> {
  const creds = appCreds();
  if (!creds) return { ...fail("off"), errorCode: "app_not_configured" };
  const path = "/oauth/access_token";
  const r = await graphFetch(path, { ...o, query: { client_id: creds.appId, client_secret: creds.appSecret, code } });
  return shape(r, path, (j) => {
    const accessToken = str(j.access_token);
    if (!accessToken) return null;
    return { accessToken, expiresIn: typeof j.expires_in === "number" ? j.expires_in : null };
  });
}

export type GraphGranularScope = { scope: string; targetIds: string[] };
export type GraphTokenInfo = {
  appId: string | null;
  isValid: boolean;
  /** Epoch s; 0 = no vence (token de system user). */
  expiresAt: number | null;
  scopes: string[];
  granularScopes: GraphGranularScope[];
};

/**
 * `debug_token` con el app token (`appId|appSecret`, en el header): de quién es el token, si es válido y sobre qué
 * WABAs da permiso (`granular_scopes[].target_ids`). C-WA6 exige el `app_id` propio y el WABA en los dos scopes.
 */
export async function debugToken(inputToken: string, o: GraphCallOptions = {}): Promise<GraphResult<GraphTokenInfo>> {
  const creds = appCreds();
  if (!creds) return { ...fail("off"), errorCode: "app_not_configured" };
  const path = "/debug_token";
  const r = await graphFetch(path, { ...o, token: `${creds.appId}|${creds.appSecret}`, query: { input_token: inputToken } });
  return shape(r, path, (j) => {
    const d = obj(j.data);
    if (!d) return null;
    const scopes = Array.isArray(d.scopes) ? d.scopes.filter((s): s is string => typeof s === "string") : [];
    const granularScopes = (Array.isArray(d.granular_scopes) ? d.granular_scopes : [])
      .map((g) => obj(g))
      .filter((g): g is Record<string, unknown> => g !== null && typeof g.scope === "string")
      .map((g) => ({
        scope: g.scope as string,
        targetIds: (Array.isArray(g.target_ids) ? g.target_ids : []).map(str).filter((s): s is string => s !== null),
      }));
    return {
      appId: str(d.app_id),
      isValid: d.is_valid === true,
      expiresAt: typeof d.expires_at === "number" ? d.expires_at : null,
      scopes,
      granularScopes,
    };
  });
}

export type GraphPhone = {
  id: string;
  displayPhone: string | null;
  verifiedName: string | null;
  qualityRating: string | null;
  nameStatus: string | null;
  messagingLimit: string | null;
};

const PHONE_FIELDS = "id,display_phone_number,verified_name,quality_rating,name_status,messaging_limit_tier";

function toPhone(p: Record<string, unknown>): GraphPhone | null {
  const id = str(p.id);
  if (!id) return null;
  return {
    id,
    displayPhone: str(p.display_phone_number),
    verifiedName: str(p.verified_name),
    qualityRating: str(p.quality_rating),
    nameStatus: str(p.name_status),
    messagingLimit: str(p.messaging_limit_tier),
  };
}

export async function listPhoneNumbers(token: string, wabaId: string, o: GraphCallOptions = {}): Promise<GraphResult<GraphPhone[]>> {
  const path = `/${encodeURIComponent(wabaId)}/phone_numbers`;
  const r = await graphFetch(path, { ...o, token, query: { fields: PHONE_FIELDS } });
  return shape(r, path, (j) =>
    Array.isArray(j.data) ? j.data.map(obj).filter((p): p is Record<string, unknown> => p !== null).map(toPhone).filter((p): p is GraphPhone => p !== null) : null
  );
}

export async function getPhone(token: string, phoneNumberId: string, o: GraphCallOptions = {}): Promise<GraphResult<GraphPhone>> {
  const path = `/${encodeURIComponent(phoneNumberId)}`;
  const r = await graphFetch(path, { ...o, token, query: { fields: PHONE_FIELDS } });
  return shape(r, path, toPhone);
}

const success = (j: Record<string, unknown>) => (j.success === true ? { success: true as const } : null);

/** Suscribe la app al WABA: sin esto Meta no manda los webhooks de ese WABA. */
export async function subscribeApp(token: string, wabaId: string, o: GraphCallOptions = {}): Promise<GraphResult<{ success: true }>> {
  const path = `/${encodeURIComponent(wabaId)}/subscribed_apps`;
  return shape(await graphFetch(path, { ...o, token, method: "POST" }), path, success);
}

/** Desconectar (C-WA6): deja de recibir webhooks. NO desregistra el número (se puede volver a conectar). */
export async function unsubscribeApp(token: string, wabaId: string, o: GraphCallOptions = {}): Promise<GraphResult<{ success: true }>> {
  const path = `/${encodeURIComponent(wabaId)}/subscribed_apps`;
  return shape(await graphFetch(path, { ...o, token, method: "DELETE" }), path, success);
}

/**
 * Registra el número en la Cloud API con el PIN de verificación en dos pasos (6 dígitos, aleatorio, sellado en la
 * credencial). Si el número ya tenía un PIN de otro alta, Meta responde 133005 y la cuenta queda en el paso REGISTERED.
 */
export async function registerPhone(
  token: string,
  phoneNumberId: string,
  pin: string,
  o: GraphCallOptions = {}
): Promise<GraphResult<{ success: true }>> {
  const path = `/${encodeURIComponent(phoneNumberId)}/register`;
  return shape(await graphFetch(path, { ...o, token, method: "POST", json: { messaging_product: "whatsapp", pin } }), path, success);
}

// ── Plantillas ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Componentes del ALTA de una plantilla en Meta a partir de `TEMPLATE_SPECS` (WA-P1). El header DOCUMENT exige en Meta
 * un `example.header_handle` de la Resumable Upload API (`POST /{app_id}/uploads`): `headerHandle` lo recibe ya
 * subido (hallazgo WA-P3: falta quién lo sube; el simulador no lo exige).
 */
export function templateCreateComponents(spec: WaTemplateSpec, o: { headerHandle?: string } = {}): unknown[] {
  const c: unknown[] = [];
  if (spec.header === "DOCUMENT") {
    c.push({ type: "HEADER", format: "DOCUMENT", ...(o.headerHandle ? { example: { header_handle: [o.headerHandle] } } : {}) });
  }
  c.push({ type: "BODY", text: spec.body, ...(spec.example.length ? { example: { body_text: [spec.example] } } : {}) });
  c.push({ type: "FOOTER", text: spec.footer });
  if (spec.buttons.length) c.push({ type: "BUTTONS", buttons: spec.buttons.map((text) => ({ type: "QUICK_REPLY", text })) });
  return c;
}

/**
 * WA-S6 (hallazgo 1 de WA-P3) · Muestra del header DOCUMENT para el ALTA de `cs_documento_v1`. Meta revisa la plantilla
 * con un ejemplo del documento: es un PDF de una página, generado acá, sin datos de nadie (nunca una ficha real: lo
 * guarda Meta y lo ve su equipo de revisión). Offsets del xref calculados, así cualquier lector lo abre.
 */
export function documentHeaderSamplePdf(): Uint8Array {
  const text = "Documento de ejemplo";
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xrefAt = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

/** Id de sesión de la Resumable Upload API: `upload:<base64url>` y, en Meta real, `?sig=<firma>` pegado. */
const UPLOAD_SESSION_RE = /^upload:[A-Za-z0-9_=+/.%-]{1,1024}(\?sig=[A-Za-z0-9_=+/.%-]{1,1024})?$/;
const APP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * WA-S6 (hallazgo 1 de WA-P3) · Resumable Upload API: sube un archivo de ejemplo y devuelve el `h` que va en
 * `example.header_handle` del alta de una plantilla con header DOCUMENT. Dos pasos (doc de Meta):
 *   1. `POST /{app_id}/uploads?file_name&file_length&file_type` → `{ id: "upload:…" }` (abre la sesión);
 *   2. `POST /{upload_id}` con `Authorization: OAuth <token>`, `file_offset: 0` y los bytes crudos → `{ h }`.
 * El `app_id` es el de la app de la plataforma (no el WABA): la sesión es de la app. Nunca tira (como todo este módulo); el
 * id de sesión no se loguea (`logPath` corta el `?sig=` y acorta el resto).
 */
export async function uploadHeaderSample(
  token: string,
  appId: string,
  f: { bytes: Uint8Array; mimeType: string; filename: string },
  o: GraphCallOptions = {}
): Promise<GraphResult<{ handle: string }>> {
  if (!APP_ID_RE.test(appId)) return { ...fail("off"), errorCode: "app_not_configured" };
  const startPath = `/${encodeURIComponent(appId)}/uploads`;
  const start = shape(
    await graphFetch(startPath, {
      ...o,
      token,
      method: "POST",
      query: { file_name: f.filename, file_length: f.bytes.byteLength, file_type: f.mimeType },
    }),
    startPath,
    (j) => {
      const id = str(j.id);
      return id && UPLOAD_SESSION_RE.test(id) ? id : null;
    }
  );
  if (!start.ok) return start;
  // Sin `encodeURIComponent`: el id trae `:` y, en Meta, el `?sig=` que tiene que viajar como query tal cual.
  const sessionPath = `/${start.data}`;
  const r = await graphFetch(sessionPath, {
    ...o,
    token,
    authScheme: "OAuth",
    method: "POST",
    headers: { file_offset: "0" },
    binary: { bytes: f.bytes, contentType: f.mimeType },
  });
  return shape(r, sessionPath, (j) => {
    const h = str(j.h);
    return h ? { handle: h } : null;
  });
}

export async function createTemplate(
  token: string,
  wabaId: string,
  t: { name: string; language: string; category: string; components: unknown[] },
  o: GraphCallOptions = {}
): Promise<GraphResult<{ id: string; status: string | null }>> {
  const path = `/${encodeURIComponent(wabaId)}/message_templates`;
  const r = await graphFetch(path, { ...o, token, method: "POST", json: t });
  return shape(r, path, (j) => {
    const id = str(j.id);
    return id ? { id, status: str(j.status) } : null;
  });
}

export type GraphTemplate = { id: string | null; name: string; language: string; status: string; rejectedReason: string | null };

export async function listTemplates(token: string, wabaId: string, o: GraphCallOptions = {}): Promise<GraphResult<GraphTemplate[]>> {
  const path = `/${encodeURIComponent(wabaId)}/message_templates`;
  const r = await graphFetch(path, { ...o, token, query: { fields: "id,name,language,status,rejected_reason", limit: 200 } });
  return shape(r, path, (j) => {
    if (!Array.isArray(j.data)) return null;
    const out: GraphTemplate[] = [];
    for (const raw of j.data) {
      const t = obj(raw);
      const name = t ? str(t.name) : null;
      const language = t ? str(t.language) : null;
      const status = t ? str(t.status) : null;
      if (!t || !name || !language || !status) continue;
      const reason = str(t.rejected_reason);
      out.push({ id: str(t.id), name, language, status, rejectedReason: reason && reason !== "NONE" ? reason.slice(0, 200) : null });
    }
    return out;
  });
}

// ── Media y mensajes ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * Sube un PDF como media del número (C-WA9: el documento compartido viaja como media, NUNCA como URL: una URL firmada
 * en un mensaje de WhatsApp queda en el chat y en los servidores de Meta, y se puede reenviar).
 */
export async function uploadMedia(
  token: string,
  phoneNumberId: string,
  f: { bytes: Uint8Array; filename: string; mimeType?: string },
  o: GraphCallOptions = {}
): Promise<GraphResult<{ id: string }>> {
  const path = `/${encodeURIComponent(phoneNumberId)}/media`;
  const type = f.mimeType ?? "application/pdf";
  const form = new FormData();
  form.set("messaging_product", "whatsapp");
  form.set("type", type);
  // Copia a un ArrayBuffer propio: `BlobPart` no acepta un Uint8Array sobre SharedArrayBuffer (tipo de TS 5.7+).
  form.set("file", new Blob([new Uint8Array(f.bytes)], { type }), f.filename);
  const r = await graphFetch(path, { ...o, token, method: "POST", form });
  return shape(r, path, (j) => {
    const id = str(j.id);
    return id ? { id } : null;
  });
}

/**
 * Componentes del ENVÍO a partir de `buildTemplateParams` (la única entrada de parámetros, WA-D16): body con los
 * params, header DOCUMENT con el media id (nunca un link) y el payload de cada botón quick reply
 * (`wa1.c|x.<messageId>`, `buttonPayload` de WA-P1).
 */
export function templateSendComponents(
  built: WaBuiltTemplate,
  o: { documentMediaId?: string; documentFilename?: string; buttonPayloads?: string[] } = {}
): unknown[] {
  const c: unknown[] = [];
  if (built.header === "DOCUMENT") {
    c.push({
      type: "header",
      parameters: [{ type: "document", document: { id: o.documentMediaId, ...(o.documentFilename ? { filename: o.documentFilename } : {}) } }],
    });
  }
  if (built.bodyParams.length) c.push({ type: "body", parameters: built.bodyParams.map((text) => ({ type: "text", text })) });
  (o.buttonPayloads ?? []).forEach((payload, i) => {
    c.push({ type: "button", sub_type: "quick_reply", index: String(i), parameters: [{ type: "payload", payload }] });
  });
  return c;
}

export type GraphSent = { wamid: string; waId: string | null };

function sentShape(j: Record<string, unknown>): GraphSent | null {
  const m = Array.isArray(j.messages) ? obj(j.messages[0]) : null;
  const wamid = m ? str(m.id) : null;
  if (!wamid) return null;
  const c = Array.isArray(j.contacts) ? obj(j.contacts[0]) : null;
  return { wamid, waId: c ? str(c.wa_id) : null };
}

/** Plantilla a un E.164. `callbackData` = nuestro `WhatsAppMessage.id` (`biz_opaque_callback_data`, C-WA4). */
export async function sendTemplate(
  token: string,
  phoneNumberId: string,
  m: { to: string; name: string; language: string; components: unknown[]; callbackData: string },
  o: GraphCallOptions = {}
): Promise<GraphResult<GraphSent>> {
  const path = `/${encodeURIComponent(phoneNumberId)}/messages`;
  const json = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: toDigits(m.to),
    type: "template",
    template: { name: m.name, language: { code: m.language }, components: m.components },
    biz_opaque_callback_data: m.callbackData,
  };
  return shape(await graphFetch(path, { ...o, token, method: "POST", json }), path, sentShape);
}

/**
 * Texto libre (agradecimiento después de un botón, respuesta automática al texto, C-WA9). Meta solo lo deja dentro de
 * las 24 h desde el último mensaje del paciente (fuera → 131047, clase `recipient`).
 */
export async function sendText(
  token: string,
  phoneNumberId: string,
  m: { to: string; body: string; callbackData?: string },
  o: GraphCallOptions = {}
): Promise<GraphResult<GraphSent>> {
  const path = `/${encodeURIComponent(phoneNumberId)}/messages`;
  const json = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: toDigits(m.to),
    type: "text",
    text: { preview_url: false, body: m.body },
    ...(m.callbackData ? { biz_opaque_callback_data: m.callbackData } : {}),
  };
  return shape(await graphFetch(path, { ...o, token, method: "POST", json }), path, sentShape);
}
