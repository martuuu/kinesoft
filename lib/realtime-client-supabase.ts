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
 * - HF-1b (H-RT1): cada fallo viaja como `StatusInfo.diag` (paso, código, motivo ≤160): en prod el `devWarn` es no-op
 *   y el motivo se perdía. Un rechazo permanente (auth del canal, mint `{ok:false}`, action vieja) cuenta aparte: a
 *   los `PERMANENT_FAILURES_TO_PARK` seguidos el driver se ESTACIONA — un intento cada `PARKED_RETRY_MS`, un
 *   `visible`/`online` solo si ya pasó ese plazo, y «Reconectar» (`nudge("reconnect")`) ya. Antes el backoff re-minteaba
 *   cada ≤30 s para siempre y agotaba el rate limit del mint (30 cada 10 min, compartido con las otras pestañas).
 */
import { REALTIME_EVENT, topicFor } from "@/lib/realtime-constants";
import {
  PARKED_RETRY_MS,
  PERMANENT_FAILURES_TO_PARK,
  TOKEN_REFRESH_MIN_MS,
  backoffDelay,
  classifyJoinError,
  makeDiag,
  createDriverEvents,
  defaultTimers,
  devWarn,
  nextTokenRefreshAt,
  parseIncoming,
} from "@/lib/realtime-client-state";
import type {
  DriverDeps,
  RealtimeDiag,
  RealtimeDriver,
  RealtimeTokenFailure,
  RealtimeTokenGetter,
} from "@/lib/realtime-client-types";
import { importWithRetry, isStaleBuildError } from "@/lib/chunk-retry";

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
  /** HF-1b: fallos permanentes SEGUIDOS (se cortan con un transitorio o con `live`). */
  let permanentFailures = 0;
  /** ms epoch del último `attempt()`: estacionado, un `visible`/`online` solo reintenta si ya pasó `PARKED_RETRY_MS`. */
  let lastAttemptAt = 0;

  const isParked = () => permanentFailures >= PERMANENT_FAILURES_TO_PARK;

  const isStale = (myGen: number) => closed || myGen !== gen;

  async function loadCtor(): Promise<RealtimeClientCtor> {
    if (deps?.RealtimeClient) return deps.RealtimeClient;
    // HF-1b: un reintento a los 5 s; si el chunk tampoco está, es un deploy nuevo (`StaleBuildError`). El
    // `async () => await import(` es a propósito: el guard (e) de §18.9 busca ese literal para saber que el driver carga
    // el SDK de forma dinámica.
    const mod = await importWithRetry(async () => await import("@supabase/realtime-js"));
    return mod.RealtimeClient as unknown as RealtimeClientCtor;
  }

  /** Token, o el motivo por el que no hay (HF-1b: `null` del getter = red, transitorio). */
  async function mint(): Promise<Token | RealtimeTokenFailure> {
    try {
      const t = await getToken();
      if (t && "code" in t) return t;
      if (!t || typeof t.token !== "string" || t.token.length === 0) {
        return { code: "network", reason: "No se pudo pedir el token" };
      }
      return { token: t.token, expiresAt: t.expiresAt };
    } catch (err) {
      devWarn("realtime.token_failed", err);
      return { code: "network", reason: err instanceof Error ? err.message : "No se pudo pedir el token" };
    }
  }

  const isToken = (t: Token | RealtimeTokenFailure): t is Token => "token" in t;

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
      if (!isToken(t)) {
        // Se conserva el token actual; si vence, el server cierra el canal y entra
        // por el camino de reconexión. HF-1b: un rechazo permanente (sesión vencida, rate limit) no se re-pide cada
        // 30 s (eran 20 mints cada 10 min por pestaña): espera lo mismo que un canal estacionado.
        const d = makeDiag("mint", t.code, t.reason, now());
        scheduleRefresh(now() + (d.permanent ? PARKED_RETRY_MS : TOKEN_REFRESH_MIN_MS));
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

  function fail(myGen: number, diag: RealtimeDiag) {
    if (isStale(myGen)) return;
    // Invalida primero: el CLOSED que dispara removeChannel ya no es de esta generación.
    gen++;
    failures++;
    dropped = true;
    // Una versión vieja no se arregla con 3 intentos: se estaciona de una.
    if (diag.code === "stale_build") permanentFailures = Math.max(permanentFailures + 1, PERMANENT_FAILURES_TO_PARK);
    else permanentFailures = diag.permanent ? permanentFailures + 1 : 0;
    const ch = channel;
    channel = null;
    removeChannelQuietly(ch);
    events.setStatus("reconnecting", { failures, reconnected: false, diag });
    clearRetry();
    retryTimer = timers.setTimeout(
      () => {
        retryTimer = null;
        void attempt();
      },
      isParked() ? PARKED_RETRY_MS : backoffDelay(failures - 1, random),
    );
  }

  async function attempt(): Promise<void> {
    if (closed) return;
    clearRetry();
    const myGen = ++gen;
    lastAttemptAt = now();
    try {
      if (!client) {
        let Ctor: RealtimeClientCtor;
        try {
          Ctor = await loadCtor();
        } catch (err) {
          if (isStale(myGen)) return;
          fail(myGen, makeDiag("import", isStaleBuildError(err) ? "stale_build" : "network", err, now()));
          return;
        }
        if (isStale(myGen)) return;
        client = new Ctor(endpoint, {
          params: { apikey: anonKey },
          // Respaldo: el SDK solo lo llama si no hay token manual. Devuelve el
          // vigente y mintea solo si no hay o está por vencer.
          accessToken: async () => {
            if (current && Date.parse(current.expiresAt) - now() > TOKEN_REUSE_MARGIN_MS) return current.token;
            const t = await mint();
            if (!isToken(t)) return null;
            if (!closed) current = t;
            return t.token;
          },
        });
      }

      const t = await mint();
      if (isStale(myGen)) return;
      if (!isToken(t)) {
        fail(myGen, makeDiag("mint", t.code, t.reason, now()));
        return;
      }
      current = t;
      try {
        await client.setAuth(t.token);
      } catch (err) {
        if (isStale(myGen)) return;
        fail(myGen, makeDiag("socket", "network", err, now()));
        return;
      }
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
          permanentFailures = 0;
          events.setStatus("live", { failures: 0, reconnected });
          return;
        }
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          devWarn(`realtime.channel_${status.toLowerCase()}`, err);
          fail(myGen, classifyJoinError(status, err, now()));
        }
      });
    } catch (err) {
      devWarn("realtime.connect_failed", err);
      fail(myGen, makeDiag("socket", "network", err, now()));
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

    nudge(reason) {
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
      if (retryTimer === null) return;
      // HF-1b: estacionado, solo «Reconectar» reintenta ya; `visible`/`online`/«Actualizar», si ya pasó el plazo (el
      // timer de 5 min pudo quedar congelado con la pestaña oculta). Si no, cada vuelta a la pestaña gastaba un mint.
      if (isParked() && reason !== "reconnect" && now() - lastAttemptAt < PARKED_RETRY_MS) return;
      clearRetry();
      void attempt();
    },
  };
}
