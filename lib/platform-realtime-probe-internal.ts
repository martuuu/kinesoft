import "server-only";
import { topicFor } from "@/lib/realtime-constants";
import { realtimeSecretFingerprint, signRealtimeToken } from "@/lib/realtime-token-internal";

/**
 * HF-1a (H-RT1, plan §22.4) · núcleo de «Probar desde el servidor» en `/plataforma/sistema`.
 *
 * Por qué existe: cuando la agenda no entraba en vivo, el motivo real (`phx_reply` con `reason`) quedaba en el
 * DevTools del navegador de quien lo viera, y en prod nadie lo veía. Esto firma un token con el MISMO código y el MISMO
 * secreto que `mintRealtimeToken` y se une al canal privado desde el server de este deploy: si dice SUBSCRIBED, el
 * secreto, el `kid`, la URL y la anon key de Vercel están bien; si no, muestra el motivo que da Supabase.
 *
 * Decisiones:
 *  - Tenant SINTÉTICO (`PROBE_TENANT_ID`, con forma de cuid pero inexistente): la policy de M5 compara el topic contra
 *    el claim, no contra la tabla Tenant (V2 de `scripts/realtime-verify.ts` se apoya en lo mismo), así que prueba la
 *    firma y la policy sin abrir el canal de ningún consultorio real. Nadie publica en ese topic.
 *  - Protocolo Phoenix (vsn 1.0.0, JSON) a mano sobre el `WebSocket` global y NO `@supabase/realtime-js`: el guard
 *    (e) de `scripts/guard-realtime.mjs` permite realtime-js solo en `lib/realtime-client-supabase.ts` (para que no
 *    entre a ningún bundle), y para un `phx_join` + `phx_reply` alcanzan veinte líneas. Es el mismo mensaje que arma
 *    `RealtimeChannel.subscribe` (config broadcast/presence/postgres_changes/private + `access_token`).
 *  - Sin `WebSocket` global (Node 20, el runtime de hoy en Vercel salvo que se elija 22) → «no disponible en este
 *    runtime». No se agrega `ws` como dependencia de prod para un botón de diagnóstico.
 *  - Nunca devuelve el token: el `reason` se recorta y se le tapa cualquier JWT (algunos errores de Supabase repiten
 *    el token) y la anon key. Tampoco se loguea (guard (d)).
 *  - Las dependencias llegan inyectadas (config ya leída de `env`, el constructor del socket, el tope) para que el
 *    unit test use un transporte falso: lo único que se mockea es la red.
 *
 * Exporta una función que DEVUELVE una promesa (no `async function`): no tiene barrera propia a propósito; la barrera
 * es `requirePlatformAdmin` en la action (`lib/platform-realtime-probe.ts`), que es lo que el guard estático de
 * Plataforma (`tests/unit/platform-admin-guard.test.ts`) verifica en cada export async. Este módulo no lee sesión,
 * base ni `env`: sin la action no tiene con qué conectarse.
 */

/** cuid sintético: 25 caracteres, `c` + minúsculas/dígitos. No existe como Tenant. */
export const PROBE_TENANT_ID = "ckrealtimeprobe0000000001";
export const PROBE_TIMEOUT_MS = 8_000;
const REASON_MAX = 240;

export type RealtimeProbeStatus =
  | "SUBSCRIBED"
  | "CHANNEL_ERROR"
  | "TIMED_OUT"
  | "CLOSED"
  | "UNAVAILABLE"
  | "UNCONFIGURED"
  | "ERROR";

export type RealtimeProbeReport = {
  ok: boolean;
  status: RealtimeProbeStatus;
  /** Motivo legible (de Supabase o nuestro), sin token ni claves. null con SUBSCRIBED. */
  reason: string | null;
  /** Desde abrir el socket hasta la respuesta. null si no se llegó a abrir. */
  ms: number | null;
  /** Huella del secreto con el que se firmó (la misma de Sistema y del script). */
  fingerprint: string | null;
  /** Si el token llevó `kid` en el header (no el valor: ya está en Sistema). */
  kid: boolean;
};

/** Lo mínimo del `WebSocket` del estándar que usa el probe (el global de Node 22 / undici lo cumple). */
export interface ProbeSocket {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
export type ProbeSocketCtor = new (url: string) => ProbeSocket;

export type RealtimeProbeInput = {
  url: string | undefined;
  anonKey: string | undefined;
  secret: string | undefined;
  kid: string | undefined;
  WebSocketCtor: ProbeSocketCtor | undefined;
  timeoutMs?: number;
  now?: () => number;
};

/** Tapa JWTs, la anon key y el token puntual; recorta. Exportada para el test. */
export function scrubProbeReason(reason: string, secrets: readonly string[]): string {
  let out = reason;
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join("[oculto]");
  out = out.replace(/eyJ[\w-]*\.[\w-]*\.?[\w-]*/g, "[jwt]").replace(/sb_(secret|publishable)_[\w-]+/g, "[clave]");
  return out.replace(/\s+/g, " ").trim().slice(0, REASON_MAX) || "sin motivo";
}

function reasonOf(response: unknown): string {
  if (response && typeof response === "object") {
    const vals = Object.values(response as Record<string, unknown>).map((v) =>
      typeof v === "string" ? v : JSON.stringify(v)
    );
    if (vals.length) return vals.join(", ");
  }
  return typeof response === "string" ? response : "error";
}

export function runRealtimeProbe(input: RealtimeProbeInput): Promise<RealtimeProbeReport> {
  const kid = !!input.kid?.trim();
  const base = { fingerprint: input.secret ? realtimeSecretFingerprint(input.secret) : null, kid };
  const url = input.url?.trim().replace(/\/+$/, "");
  const anonKey = input.anonKey?.trim();
  if (!url || !anonKey || !input.secret) {
    const missing = [!url && "URL de Supabase", !anonKey && "clave pública", !input.secret && "secreto de firma"]
      .filter(Boolean)
      .join(", ");
    return Promise.resolve({ ok: false, status: "UNCONFIGURED", reason: `Falta configurar: ${missing}.`, ms: null, ...base });
  }
  const Ctor = input.WebSocketCtor;
  if (typeof Ctor !== "function") {
    return Promise.resolve({
      ok: false,
      status: "UNAVAILABLE",
      reason: "WebSocket no disponible en este runtime (Node sin WebSocket global): probá con scripts/realtime-verify.ts.",
      ms: null,
      ...base,
    });
  }

  const now = input.now ?? Date.now;
  const timeoutMs = input.timeoutMs ?? PROBE_TIMEOUT_MS;
  let token: string;
  try {
    token = signRealtimeToken({ tenantId: PROBE_TENANT_ID, now: new Date(now()), secret: input.secret, kid: input.kid }).token;
  } catch (e) {
    return Promise.resolve({ ok: false, status: "ERROR", reason: e instanceof Error ? e.message : "no se pudo firmar", ms: null, ...base });
  }
  const hidden = [token, token.split(".")[2] ?? "", anonKey, input.secret];
  const topic = `realtime:${topicFor(PROBE_TENANT_ID)}`;
  const wsUrl = `${url.replace(/^http/i, "ws")}/realtime/v1/websocket?apikey=${encodeURIComponent(anonKey)}&vsn=1.0.0`;

  return new Promise<RealtimeProbeReport>((resolve) => {
    const t0 = now();
    let opened: number | null = null;
    let done = false;
    let sock: ProbeSocket | null = null;
    const finish = (status: RealtimeProbeStatus, reason: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        if (sock && sock.readyState === 1) {
          sock.send(JSON.stringify({ topic, event: "phx_leave", payload: {}, ref: "2", join_ref: "1" }));
        }
        sock?.close(1000, "probe");
      } catch {
        // cierre best-effort
      }
      resolve({
        ok: status === "SUBSCRIBED",
        status,
        reason: reason === null ? null : scrubProbeReason(reason, hidden),
        ms: opened === null ? null : now() - t0,
        ...base,
      });
    };
    const timer = setTimeout(
      () => finish("TIMED_OUT", `Sin respuesta de Supabase en ${Math.round(timeoutMs / 1000)} s.`),
      timeoutMs
    );
    try {
      sock = new Ctor(wsUrl);
    } catch (e) {
      finish("ERROR", e instanceof Error ? e.message : "no se pudo abrir el socket");
      return;
    }
    sock.onopen = () => {
      opened = now();
      const join = {
        topic,
        event: "phx_join",
        payload: {
          config: {
            broadcast: { self: false, ack: false },
            presence: { key: "", enabled: false },
            postgres_changes: [],
            private: true,
          },
          access_token: token,
        },
        ref: "1",
        join_ref: "1",
      };
      try {
        sock?.send(JSON.stringify(join));
      } catch (e) {
        finish("ERROR", e instanceof Error ? e.message : "no se pudo enviar el join");
      }
    };
    sock.onmessage = (ev) => {
      let msg: { topic?: unknown; event?: unknown; ref?: unknown; payload?: unknown };
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (msg.topic !== topic) return;
      const payload = (msg.payload ?? {}) as { status?: unknown; response?: unknown; message?: unknown };
      if (msg.event === "phx_reply" && msg.ref === "1") {
        if (payload.status === "ok") finish("SUBSCRIBED", null);
        else finish("CHANNEL_ERROR", reasonOf(payload.response));
        return;
      }
      if (msg.event === "phx_error") return finish("CHANNEL_ERROR", reasonOf(payload));
      if (msg.event === "phx_close") return finish("CLOSED", "Supabase cerró el canal.");
      // Realtime avisa algunos rechazos de auth como mensaje `system` con status error.
      if (msg.event === "system" && payload.status === "error") {
        return finish("CHANNEL_ERROR", typeof payload.message === "string" ? payload.message : reasonOf(payload));
      }
    };
    sock.onerror = () => {
      // El cierre llega después con código; si no llega, el timeout corta.
      if (opened === null) finish("CLOSED", "No se pudo abrir el socket (red, URL o anon key).");
    };
    sock.onclose = (ev) => {
      finish("CLOSED", `Socket cerrado${ev?.code ? ` (código ${ev.code})` : ""}${ev?.reason ? `: ${ev.reason}` : ""}.`);
    };
  });
}
