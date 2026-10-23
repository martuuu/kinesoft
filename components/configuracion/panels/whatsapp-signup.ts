/**
 * [WA-U1] (T6, C-WA5/C-WA6, brief §26.5) · El alta embebida de WhatsApp en el navegador: el popup de Meta (o del
 * simulador), el SDK de Facebook y el armado de lo que vuelve.
 *
 * Por qué un módulo aparte del panel: es lógica con efectos de navegador (ventanas, `postMessage`, un `<script>`) que el
 * repo no puede ejercitar con DOM en los tests; acá cada pieza recibe sus dependencias (la ventana, el documento, la
 * action) y `tests/unit/render/wa-u1-panel.test.tsx` llama al MISMO código que el botón. Lo importa solo
 * `whatsapp-panel.tsx` (estático): los dos viajan en UN chunk diferido de Configuración, nada en el primer load.
 *
 * Cómo llega cada dato (Embedded Signup v4; el `code` vive 30 s y es de un solo uso):
 *   - Meta: `waba_id` y `phone_number_id` llegan por `postMessage` (`WA_EMBEDDED_SIGNUP`, un string JSON desde un
 *     origen `*.facebook.com`) y el `code` por el callback de `FB.login`. Llegan en cualquier orden: el colector
 *     espera los dos y llama `completeWhatsAppConnect` en el mismo tick en que tiene el segundo.
 *   - Simulador: el popup es del MISMO origen (`/api/whatsapp/fake/dialog/signup`) y manda todo junto en el mensaje,
 *     `code` incluido (WA-P3).
 *
 * El SDK (`connect.facebook.net`) se carga SOLO al tocar «Conectar» en sandbox/live: nunca en el simulador y nunca al
 * abrir la pestaña (ni peso ni un tercero que vea a quien solo mira la configuración).
 */
import type { WaConnectStart, WaSetupOutcome } from "@/lib/whatsapp/account-types";
import type { ActionResult } from "@/lib/validation";

/** Lo que el loader de Configuración saca de `signupDialogTarget()` (lib/whatsapp/graph.ts, server-only). */
export type WaDialogTarget = { mode: "fake"; dialogUrl: string; origin: string } | { mode: "meta"; origin: string };

/** SDK de Facebook. Host que la CSP de `/configuracion` tiene que dejar en `script-src` (lo aplica INT). */
export const FB_SDK_SRC = "https://connect.facebook.net/es_LA/sdk.js";

/** Nombre de la ventana: un segundo click reusa el mismo popup en vez de abrir otro. */
export const WA_SIGNUP_WINDOW = "kinesoft-wa-signup";
export const WA_SIGNUP_WINDOW_FEATURES = "popup,width=560,height=760";

// Meta postea desde www.facebook.com, y según la cuenta también desde web. o business.facebook.com: se acepta
// cualquier subdominio de facebook.com por https, pero con regex anclada y no `endsWith("facebook.com")` del ejemplo
// de Meta, que también deja pasar `evilfacebook.com`.
const META_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*facebook\.com$/;

/** ¿El mensaje viene del popup del alta? Simulador: origen exacto (el de la app). Meta: `https://*.facebook.com`. */
export function isSignupOrigin(origin: string, target: WaDialogTarget): boolean {
  if (target.mode === "fake") return origin === target.origin;
  return origin === target.origin || META_ORIGIN.test(origin);
}

/** Mismo formato que valida `completeWhatsAppConnect` (zod): un id que no lo cumple ni se manda. */
const META_ID = /^[0-9]{5,25}$/;

export type WaSignupMessage =
  | { event: "FINISH"; wabaId: string; phoneNumberId: string; code: string | null }
  /** Terminó sin número (`FINISH_ONLY_WABA`, o un FINISH sin ids válidos): no hay qué conectar. */
  | { event: "NO_PHONE" }
  | { event: "CANCEL" }
  | { event: "ERROR" };

/**
 * Lee un mensaje de la ventana del alta. Meta (y el simulador, WA-P3) mandan un STRING JSON; se acepta también el
 * objeto por si Meta lo cambia. Cualquier otra cosa (otro `postMessage` de la página, de una extensión) → null.
 */
export function parseSignupMessage(raw: unknown): WaSignupMessage | null {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object") return null;
  const m = v as { type?: unknown; event?: unknown; data?: unknown; code?: unknown };
  if (m.type !== "WA_EMBEDDED_SIGNUP" || typeof m.event !== "string") return null;
  if (m.event === "CANCEL") return { event: "CANCEL" };
  if (m.event === "ERROR") return { event: "ERROR" };
  if (!m.event.startsWith("FINISH")) return null;
  const d = (m.data && typeof m.data === "object" ? m.data : {}) as { waba_id?: unknown; phone_number_id?: unknown };
  const wabaId = typeof d.waba_id === "string" ? d.waba_id : "";
  const phoneNumberId = typeof d.phone_number_id === "string" ? d.phone_number_id : "";
  if (!META_ID.test(wabaId) || !META_ID.test(phoneNumberId)) return { event: "NO_PHONE" };
  const code = typeof m.code === "string" && m.code.length > 0 ? m.code : null;
  return { event: "FINISH", wabaId, phoneNumberId, code };
}

/** URL del popup del simulador (WA-P3: valida `app_id` y `config_id` contra los de la app). */
export function fakeDialogHref(start: Pick<WaConnectStart, "fakeDialogUrl" | "appId" | "configId">): string | null {
  if (!start.fakeDialogUrl) return null;
  const q = new URLSearchParams({ app_id: start.appId, config_id: start.configId });
  return `${start.fakeDialogUrl}?${q.toString()}`;
}

export type FbLoginResponse = { authResponse?: { code?: string } | null; status?: string };
export type FbSdk = {
  init: (o: { appId: string; autoLogAppEvents?: boolean; xfbml?: boolean; version: string }) => void;
  login: (cb: (r: FbLoginResponse) => void, opts: FbLoginOptions) => void;
};
export type FbLoginOptions = {
  config_id: string;
  response_type: "code";
  override_default_response_type: true;
  extras: { setup: Record<string, never>; sessionInfoVersion: "3"; version: "v4"; featureType?: string };
};

/** Opciones de `FB.login` del Embedded Signup v4 (`featureType` solo con coexistencia, `WHATSAPP_SIGNUP_FEATURE`). */
export function metaLoginOptions(start: Pick<WaConnectStart, "configId" | "feature">): FbLoginOptions {
  return {
    config_id: start.configId,
    response_type: "code",
    override_default_response_type: true,
    extras: { setup: {}, sessionInfoVersion: "3", version: "v4", ...(start.feature ? { featureType: start.feature } : {}) },
  };
}

type SdkWindow = { FB?: FbSdk; fbAsyncInit?: () => void };
type SdkDocument = {
  getElementById: (id: string) => unknown;
  createElement: (tag: "script") => {
    id: string;
    src: string;
    async: boolean;
    defer: boolean;
    crossOrigin: string | null;
    onerror: ((...a: unknown[]) => unknown) | null;
  };
  body: { appendChild: (n: unknown) => unknown };
};

const SDK_SCRIPT_ID = "facebook-jssdk";
const SDK_TIMEOUT_MS = 15_000;
let sdkPromise: Promise<FbSdk> | null = null;

/** Solo para los tests: el SDK se cachea por página, y cada test arma su propio documento falso. */
export function resetFacebookSdkForTests(): void {
  sdkPromise = null;
}

/**
 * Carga el SDK de Facebook una sola vez por página y lo inicializa con la app y la versión de Graph de la action.
 * Si falla (bloqueador de anuncios, sin red, CSP), la promesa se rechaza y el siguiente intento vuelve a probar.
 */
export function loadFacebookSdk(
  start: Pick<WaConnectStart, "appId" | "graphVersion">,
  deps: { win: SdkWindow; doc: SdkDocument; timeoutMs?: number }
): Promise<FbSdk> {
  if (sdkPromise) return sdkPromise;
  const { win, doc } = deps;
  const init = (fb: FbSdk) => {
    fb.init({ appId: start.appId, autoLogAppEvents: true, xfbml: false, version: start.graphVersion });
    return fb;
  };
  if (win.FB) {
    sdkPromise = Promise.resolve(init(win.FB));
    return sdkPromise;
  }
  sdkPromise = new Promise<FbSdk>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fb_sdk_timeout")), deps.timeoutMs ?? SDK_TIMEOUT_MS);
    win.fbAsyncInit = () => {
      clearTimeout(timer);
      if (win.FB) resolve(init(win.FB));
      else reject(new Error("fb_sdk_missing"));
    };
    if (doc.getElementById(SDK_SCRIPT_ID)) return;
    const s = doc.createElement("script");
    s.id = SDK_SCRIPT_ID;
    s.src = FB_SDK_SRC;
    s.async = true;
    s.defer = true;
    s.crossOrigin = "anonymous";
    s.onerror = () => {
      clearTimeout(timer);
      reject(new Error("fb_sdk_load"));
    };
    doc.body.appendChild(s);
  }).catch((err: unknown) => {
    sdkPromise = null;
    throw err;
  });
  return sdkPromise;
}

export type WaSignupResult =
  | { kind: "done"; outcome: WaSetupOutcome }
  | { kind: "error"; error: string }
  | { kind: "cancelled" }
  | { kind: "no_phone" };

export type WaSignupSession = {
  /** El `code` del callback de `FB.login` (Meta real). */
  setCode: (code: string) => void;
  /** El usuario cerró sin terminar (callback de `FB.login` sin code, o «Cancelar» del panel). */
  cancel: () => void;
  /** Saca el listener (al desmontar o al terminar). */
  dispose: () => void;
};

type MessageLike = { origin: string; data: unknown };

/**
 * Una sesión de alta: escucha la ventana, junta `code` + `waba_id` + `phone_number_id` y llama `complete` APENAS los
 * tiene (el code vence a los 30 s: nada de esperar otro click). Termina una sola vez: lo que llegue después se ignora.
 */
export function startSignupSession(deps: {
  start: Pick<WaConnectStart, "nonce">;
  target: WaDialogTarget;
  /** `window.addEventListener("message", …)`; devuelve cómo sacarlo. */
  listen: (fn: (e: MessageLike) => void) => () => void;
  complete: (input: { code: string; wabaId: string; phoneNumberId: string; nonce: string }) => Promise<ActionResult<WaSetupOutcome>>;
  onResult: (r: WaSignupResult) => void;
  /** Error de red de la action (para el copy). */
  networkError: string;
}): WaSignupSession {
  let code: string | null = null;
  let ids: { wabaId: string; phoneNumberId: string } | null = null;
  let finished = false;
  let unlisten: (() => void) | null = null;

  const finish = (r: WaSignupResult) => {
    if (finished) return;
    finished = true;
    unlisten?.();
    unlisten = null;
    deps.onResult(r);
  };

  const fire = () => {
    if (finished || !code || !ids) return;
    finished = true;
    unlisten?.();
    unlisten = null;
    const input = { code, ...ids, nonce: deps.start.nonce };
    void deps
      .complete(input)
      .then((r) => deps.onResult(r.ok ? { kind: "done", outcome: r.data } : { kind: "error", error: r.error }))
      .catch(() => deps.onResult({ kind: "error", error: deps.networkError }));
  };

  unlisten = deps.listen((e) => {
    if (finished || !isSignupOrigin(e.origin, deps.target)) return;
    const msg = parseSignupMessage(e.data);
    if (!msg) return;
    if (msg.event === "CANCEL") return finish({ kind: "cancelled" });
    if (msg.event === "NO_PHONE") return finish({ kind: "no_phone" });
    // ERROR: Meta lo muestra en su ventana y el usuario puede reintentar ahí mismo; acá no se corta la sesión.
    if (msg.event === "ERROR") return;
    ids = { wabaId: msg.wabaId, phoneNumberId: msg.phoneNumberId };
    if (msg.code && !code) code = msg.code;
    fire();
  });

  return {
    setCode: (c: string) => {
      if (finished || code || !c) return;
      code = c;
      fire();
    },
    cancel: () => finish({ kind: "cancelled" }),
    dispose: () => {
      finished = true;
      unlisten?.();
      unlisten = null;
    },
  };
}

/** `FB.login` del alta: el `code` va a la sesión; sin code (cerró la ventana) = cancelado. */
export function runFacebookLogin(fb: FbSdk, start: Pick<WaConnectStart, "configId" | "feature">, session: WaSignupSession): void {
  fb.login((r) => {
    const c = r?.authResponse?.code;
    if (c) session.setCode(c);
    else session.cancel();
  }, metaLoginOptions(start));
}
