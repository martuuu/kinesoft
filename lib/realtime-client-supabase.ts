/**
 * Driver Supabase Broadcast del canal de la agenda (SV07a, §18.2 «Cliente»).
 *
 * Por qué así:
 * - `@supabase/realtime-js` entra SOLO por `await import()` dentro de `connect()`:
 *   el provider va en todas las rutas del workspace y el bundle de first-load no
 *   puede cargar el SDK (ni para un consultorio con realtime `off`). El guard (e)
 *   de §18.9 lo verifica. Ni siquiera hay `import type` arriba: las formas mínimas
 *   del SDK están acá abajo, con un chequeo de tipos contra el SDK real.
 * - Canal PRIVADO `tenant:<id>:agenda`: la policy de M5 decide por los claims del
 *   token (`tenant_id`) quién lee. `broadcast.self: false` porque el cliente nunca
 *   publica (no hay `send` en el driver ni policy INSERT en M5).
 * - El token lo pide el caller (`getToken` → `mintRealtimeToken()` cableado por
 *   SV07b); este archivo no importa la action para no mezclar "use server" con el
 *   driver y para poder testearlo con fakes. Se fija con `setAuth(token)` explícito
 *   antes de cada suscripción y se renueva al 80 % del TTL: un token manual el SDK
 *   lo conserva entre resubscribes y no llama al callback `accessToken`, que queda
 *   como respaldo devolviendo el token vigente (sin mintear de más: el mint tiene
 *   rate limit de 30 cada 10 min por usuario).
 * - Caída (`CHANNEL_ERROR`/`TIMED_OUT`/`CLOSED`): se saca el canal (así el SDK no
 *   lo re-une por su cuenta con un token quizás vencido), se espera el backoff, se
 *   re-mintea y se suscribe un canal nuevo sobre el mismo cliente. Cada intento
 *   tiene una generación: los callbacks de un canal viejo (incluido el `CLOSED`
 *   que dispara el propio `removeChannel`) se ignoran, si no cada caída armaría
 *   dos reconexiones en cadena.
 * - Nunca tira: todo error termina en `reconnecting` + backoff, y los logs son
 *   `console.warn` solo en dev, con un código fijo y nunca el token.
 */
import { REALTIME_EVENT, topicFor } from "@/lib/realtime-constants";
import {
  TOKEN_REFRESH_MIN_MS,
  backoffDelay,
  createDriverEvents,
  defaultTimers,
  devWarn,
  nextTokenRefreshAt,
  parseIncoming,
} from "@/lib/realtime-client-state";
import type {
  DriverDeps,
  RealtimeDriver,
  RealtimeTokenGetter,
} from "@/lib/realtime-client-types";

// ─── Formas mínimas del SDK (lo único que el driver usa) ─────────────────────

type ChannelConfig = { config: { private: boolean; broadcast: { self: boolean } } };

export type RealtimeChannelLike = {
  on(type: "broadcast", filter: { event: string }, callback: (msg: { payload?: unknown }) => void): unknown;
  subscribe(callback: (status: `${SubscribeStatus}`, err?: Error) => void): unknown;
};

type SubscribeStatus = "SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR";

export type RealtimeClientLike = {
  channel(topic: string, params: ChannelConfig): RealtimeChannelLike;
  setAuth(token?: string | null): Promise<void>;
  removeChannel(channel: RealtimeChannelLike): Promise<unknown>;
  disconnect(): Promise<unknown> | void;
};

export type RealtimeClientCtor = new (
  endpoint: string,
  options: { params: { apikey: string }; accessToken: () => Promise<string | null> }
) => RealtimeClientLike;

/**
 * Chequeo de compilación: el `RealtimeClient` real tiene que encajar en
 * `RealtimeClientCtor`. Si una versión nueva del SDK cambia una firma que usamos,
 * `tsc` falla acá y no en runtime en el browser. Es solo de tipos: el
 * `typeof import()` se borra al compilar y no carga el paquete.
 */
type _SdkFits = typeof import("@supabase/realtime-js")["RealtimeClient"] extends RealtimeClientCtor ? true : false;
const _sdkFits: _SdkFits = true;
void _sdkFits;

export type SupabaseDriverDeps = DriverDeps & {
  /** Fake en tests; en el browser se omite y se carga el SDK con `import()`. */
  RealtimeClient?: RealtimeClientCtor;
};

export type SupabaseDriverOptions = {
  /** `NEXT_PUBLIC_SUPABASE_URL` (sin `/realtime/v1`). */
  url: string;
  /** Clave publishable/anon: va como `apikey`, no autoriza nada por sí sola. */
  anonKey: string;
  tenantId: string;
  getToken: RealtimeTokenGetter;
  deps?: SupabaseDriverDeps;
};

type Token = { token: string; expiresAt: string };

/** Margen para no reusar en el callback `accessToken` un token a punto de vencer. */
const TOKEN_REUSE_MARGIN_MS = 5_000;

export function createSupabaseDriver(opts: SupabaseDriverOptions): RealtimeDriver {
  const { anonKey, tenantId, getToken, deps } = opts;
  const endpoint = `${opts.url.replace(/\/+$/, "")}/realtime/v1`;
  const timers = deps?.timers ?? defaultTimers;
  const now = deps?.now ?? (() => Date.now());
  const random = deps?.random ?? Math.random;
  const events = createDriverEvents();

  let started = false;
  let closed = false;
  /** Generación del intento vigente; todo callback de una generación vieja se ignora. */
  let gen = 0;
  let failures = 0;
  /** Hubo una caída (o un primer intento fallido) desde el último `live`: el próximo `live` es reconexión. */
  let dropped = false;
  let client: RealtimeClientLike | null = null;
  let channel: RealtimeChannelLike | null = null;
  let current: Token | null = null;
  let retryTimer: unknown = null;
  let refreshTimer: unknown = null;
  let refreshAt: number | null = null;
  let refreshing = false;

  const isStale = (myGen: number) => closed || myGen !== gen;

  async function loadCtor(): Promise<RealtimeClientCtor> {
    if (deps?.RealtimeClient) return deps.RealtimeClient;
    const mod = await import("@supabase/realtime-js");
    return mod.RealtimeClient as unknown as RealtimeClientCtor;
  }

  async function mint(): Promise<Token | null> {
    try {
      const t = await getToken();
      if (!t || typeof t.token !== "string" || t.token.length === 0) return null;
      return { token: t.token, expiresAt: t.expiresAt };
    } catch (err) {
      devWarn("realtime.token_failed", err);
      return null;
    }
  }

  function clearRetry() {
    if (retryTimer !== null) timers.clearTimeout(retryTimer);
    retryTimer = null;
  }

  function clearRefresh() {
    if (refreshTimer !== null) timers.clearTimeout(refreshTimer);
    refreshTimer = null;
    refreshAt = null;
  }

  function scheduleRefresh(at: number) {
    clearRefresh();
    if (closed) return;
    refreshAt = at;
    refreshTimer = timers.setTimeout(() => {
      refreshTimer = null;
      void refreshToken();
    }, Math.max(0, at - now()));
  }

  /** Renueva el token sin tocar el canal: `setAuth(nuevo)` lo empuja a los canales unidos. */
  async function refreshToken() {
    if (closed || refreshing) return;
    refreshing = true;
    try {
      const t = await mint();
      if (closed) return;
      if (!t) {
        // Se conserva el token actual; si vence, el server cierra el canal y entra
        // por el camino de reconexión.
        scheduleRefresh(now() + TOKEN_REFRESH_MIN_MS);
        return;
      }
      current = t;
      try {
        await client?.setAuth(t.token);
      } catch (err) {
        devWarn("realtime.set_auth_failed", err);
      }
      if (closed) return;
      scheduleRefresh(nextTokenRefreshAt(t.expiresAt, now()));
    } finally {
      refreshing = false;
    }
  }

  function removeChannelQuietly(ch: RealtimeChannelLike | null) {
    if (!ch || !client) return;
    try {
      void Promise.resolve(client.removeChannel(ch)).catch((err) => devWarn("realtime.remove_channel_failed", err));
    } catch (err) {
      devWarn("realtime.remove_channel_failed", err);
    }
  }

  function fail(myGen: number) {
    if (isStale(myGen)) return;
    // Invalida primero: el CLOSED que dispara removeChannel ya no es de esta generación.
    gen++;
    failures++;
    dropped = true;
    const ch = channel;
    channel = null;
    removeChannelQuietly(ch);
    events.setStatus("reconnecting", { failures, reconnected: false });
    clearRetry();
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      void attempt();
    }, backoffDelay(failures - 1, random));
  }

  async function attempt(): Promise<void> {
    if (closed) return;
    clearRetry();
    const myGen = ++gen;
    try {
      if (!client) {
        const Ctor = await loadCtor();
        if (isStale(myGen)) return;
        client = new Ctor(endpoint, {
          params: { apikey: anonKey },
          // Respaldo: el SDK solo lo llama si no hay token manual. Devuelve el
          // vigente y mintea solo si no hay o está por vencer.
          accessToken: async () => {
            if (current && Date.parse(current.expiresAt) - now() > TOKEN_REUSE_MARGIN_MS) return current.token;
            const t = await mint();
            if (t && !closed) current = t;
            return t?.token ?? null;
          },
        });
      }

      const t = await mint();
      if (isStale(myGen)) return;
      if (!t) {
        fail(myGen);
        return;
      }
      current = t;
      await client.setAuth(t.token);
      if (isStale(myGen)) return;
      scheduleRefresh(nextTokenRefreshAt(t.expiresAt, now()));

      const ch = client.channel(topicFor(tenantId), {
        config: { private: true, broadcast: { self: false } },
      });
      channel = ch;
      ch.on("broadcast", { event: REALTIME_EVENT }, (m) => {
        if (isStale(myGen)) return;
        const parsed = parseIncoming(m?.payload);
        if (parsed) events.emitMessages([parsed]);
        else devWarn("realtime.invalid_payload");
      });
      ch.subscribe((status, err) => {
        if (isStale(myGen)) return;
        if (status === "SUBSCRIBED") {
          const reconnected = dropped;
          dropped = false;
          failures = 0;
          events.setStatus("live", { failures: 0, reconnected });
          return;
        }
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          devWarn(`realtime.channel_${status.toLowerCase()}`, err);
          fail(myGen);
        }
      });
    } catch (err) {
      devWarn("realtime.connect_failed", err);
      fail(myGen);
    }
  }

  return {
    async connect() {
      if (started || closed) return;
      started = true;
      events.setStatus("connecting", { failures, reconnected: false });
      await attempt();
    },

    close() {
      if (closed) return;
      closed = true;
      gen++;
      clearRetry();
      clearRefresh();
      const ch = channel;
      channel = null;
      removeChannelQuietly(ch);
      if (client) {
        try {
          void Promise.resolve(client.disconnect()).catch((err) => devWarn("realtime.disconnect_failed", err));
        } catch (err) {
          devWarn("realtime.disconnect_failed", err);
        }
      }
      client = null;
      current = null;
      events.setStatus("off", { failures, reconnected: false });
    },

    onMessage: events.onMessage,
    onStatus: events.onStatus,

    nudge() {
      if (closed || !started) return;
      if (events.status === "live") {
        // Pestaña que vuelve de segundo plano: el navegador congela los timers y el
        // refresh pudo no haber corrido. Si ya tocaba, se renueva ahora.
        if (refreshAt !== null && now() >= refreshAt) {
          clearRefresh();
          void refreshToken();
        }
        return;
      }
      // Esperando el backoff → se reintenta ya. Si hay un intento en curso, no se
      // pisa (ya está probando).
      if (retryTimer !== null) {
        clearRetry();
        void attempt();
      }
    },
  };
}
