import "server-only";
import { env, mpConnectMode } from "@/lib/env";
import { logger } from "@/lib/logger";
import { MP_HTTP_TIMEOUT_MS, mpHostsFor } from "@/lib/mp-connect/constants";

/**
 * Cliente HTTP de Mercado Pago para la rama «cuenta del vendedor» (T5 TP-P4, C-TP3). Lo usan `oauth-client.ts` y
 * `account-client.ts`; nadie más arma fetches a MP en T5.
 *
 * Por qué un cliente propio y no el SDK que usa `lib/mercadopago.ts`: el SDK se configura con UN token global (el de
 * la plataforma, AUDIT `turnero-mp-cuenta-plataforma`) y acá cada llamada lleva el token de una cuenta distinta. Además
 * el SDK loguea el request con headers en algunos errores; acá el token no sale nunca de esta función.
 *
 * El host sale del modo (`mpConnectMode()`, en cada llamada): `fake` → el MP falso de la propia app
 * (`${APP_URL}/api/mp/fake`, C-TP12); `sandbox`/`live` → `api.mercadopago.com`; `off` → no se llama a nadie (devuelve
 * `network` sin tocar la red: con el modo apagado ningún camino debería llegar acá, y si llega no habla con MP).
 * Se usa `globalThis.fetch` a propósito: el helper de tests (`installFakeMp`) lo reemplaza para enrutar al fake.
 */
export type MpFetchOk = { ok: true; status: number; json: unknown };
export type MpFetchErr = {
  ok: false;
  kind: "network" | "timeout" | "http";
  status?: number;
  /** Cuerpo de error de MP (p. ej. `{ error: "invalid_grant" }`), para que el caller clasifique. Nunca se loguea. */
  json?: unknown;
};
export type MpFetchResult = MpFetchOk | MpFetchErr;

export type MpFetchOptions = {
  token?: string;
  method?: "GET" | "POST" | "PUT";
  body?: unknown;
  timeoutMs?: number;
  /** `X-Idempotency-Key` (MP lo acepta en POST de preferencias): un reintento no crea dos preferencias. */
  idempotencyKey?: string;
  /**
   * MPS-1b (C-MPS3): base de la API fija, en vez de la que sale de `mpConnectMode()`. La usa el puerto de la suscripción
   * (`lib/mercadopago-saas.ts`), que habla con MP con el token de la PLATAFORMA y decide su host con su propio modo
   * (`SAAS_BILLING_MODE`): sin esto, con `MP_CONNECT_MODE=off` (cobros online apagados) la suscripción tampoco podría
   * hablar con MP. Sin `apiBase` el comportamiento es el de T5, byte a byte.
   */
  apiBase?: string;
};

/** URL de la app vigente: los tests la cambian en caliente y `env` se congela al importar. */
export function mpAppUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL?.trim() || env.NEXT_PUBLIC_APP_URL;
}

/** Base de la API según el modo, o null con el modo apagado. */
export function mpApiBase(): string | null {
  const mode = mpConnectMode();
  if (mode === "off") return null;
  return mpHostsFor(mode, mpAppUrl()).apiBase;
}

/**
 * Path para logs: sin query (puede traer `access_token` en APIs viejas de MP) y con ids largos acortados. El token
 * nunca está en el path (va en el header), pero un caller futuro podría ponerlo en la query.
 */
function logPath(path: string): string {
  return path.split("?")[0].replace(/[A-Za-z0-9_-]{24,}/g, "…");
}

export async function mpFetch(path: string, o: MpFetchOptions = {}): Promise<MpFetchResult> {
  const base = o.apiBase ? o.apiBase.replace(/\/+$/, "") : mpApiBase();
  const method = o.method ?? "GET";
  if (!base) {
    logger.warn("mp_connect.http.mode_off", { path: logPath(path), method });
    return { ok: false, kind: "network" };
  }
  const headers: Record<string, string> = { accept: "application/json" };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  if (o.idempotencyKey) headers["x-idempotency-key"] = o.idempotencyKey;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? MP_HTTP_TIMEOUT_MS);
  let res: Response;
  try {
    res = await globalThis.fetch(`${base}${path.startsWith("/") ? path : `/${path}`}`, {
      method,
      headers,
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
      signal: ac.signal,
      cache: "no-store",
    });
  } catch (err) {
    clearTimeout(timer);
    const kind = ac.signal.aborted ? "timeout" : "network";
    // Solo el nombre del error: el mensaje de undici puede traer la URL completa.
    logger.warn("mp_connect.http.failed", { path: logPath(path), method, kind, error: (err as Error)?.name });
    return { ok: false, kind };
  }

  // El timer sigue corriendo mientras se lee el cuerpo: un MP que manda headers y se cuelga en el body también corta.
  let json: unknown = null;
  try {
    const text = await res.text();
    json = text ? JSON.parse(text) : null;
  } catch {
    if (ac.signal.aborted) {
      logger.warn("mp_connect.http.failed", { path: logPath(path), method, kind: "timeout" });
      return { ok: false, kind: "timeout" };
    }
    json = null; // HTML de un proxy, cuerpo cortado: el caller lo trata como respuesta inválida
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    logger.warn("mp_connect.http.status", { path: logPath(path), method, status: res.status });
    return { ok: false, kind: "http", status: res.status, json };
  }
  return { ok: true, status: res.status, json };
}
