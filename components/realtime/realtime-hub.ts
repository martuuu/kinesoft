/**
 * Hub del canal realtime (SV07b; FX3 lo sacó del provider por bundle).
 *
 * Sin React y sin DOM: coalescer, polling de respaldo, resync y ciclo de vida
 * del driver. `RealtimeProvider` lo carga por `import()` dinámico SOLO cuando el
 * bootstrap trae un driver (`supabase`/`local`): con `driver:"off"` (el deploy
 * de prod arranca así) ni este módulo, ni `lib/realtime-client-state`, ni zod de
 * `lib/realtime-events`, ni la referencia a la action del token entran al
 * first-load de las rutas del workspace (§18.10 punto 7: el gate midió +11 kB gz
 * por ruta con todo esto estático en `(app)/layout`).
 *
 * Los drivers (y por ellos `@supabase/realtime-js`) siguen un nivel más abajo:
 * entran por otro `import()` dentro de `defaultLoadDriver`.
 *
 * Nunca se loguea nada del token: el `getToken` solo lo pasa al driver.
 */
import {
  createCoalescer,
  defaultTimers,
  deriveConnectionState,
  nextPollDelay,
  shouldResync,
  COALESCE_WINDOW_MS,
} from "@/lib/realtime-client-state";
import type { ConnectionState, DriverStatus, RealtimeDriver, Timers } from "@/lib/realtime-client-types";
import type { RealtimeBootstrap } from "@/lib/realtime-events";
import { mintRealtimeToken } from "@/lib/realtime-token";
import type {
  RealtimeBatchListener,
  RealtimeResyncListener,
  RealtimeResyncReason,
} from "@/components/providers/realtime-provider";

/** Crea el driver del bootstrap; `null` = no hay transporte posible (queda `off`). */
export type DriverLoader = (bootstrap: RealtimeBootstrap) => Promise<RealtimeDriver | null>;

export type RealtimeHubOptions = {
  timers?: Timers;
  /** `navigator.onLine`; `undefined` (SSR) cuenta como online. */
  isOnline?: () => boolean | undefined;
};

export type RealtimeHub = {
  getState(): ConnectionState;
  onState(fn: (s: ConnectionState) => void): () => void;
  subscribe(fn: RealtimeBatchListener): () => void;
  onResync(fn: RealtimeResyncListener): () => void;
  /** Resync manual: descarga lo pendiente del coalescer y pide re-pedir todo. */
  resync(): void;
  /**
   * Arranca una sesión con el bootstrap (cierra la anterior si la había).
   * Devuelve el stop: cierra el driver, cancela coalescer y polling. Es
   * idempotente y seguro aunque el `import()` del driver todavía no resolvió.
   */
  start(bootstrap: RealtimeBootstrap, loadDriver?: DriverLoader): () => void;
  /** `visibilitychange`: solo actúa cuando la pestaña vuelve a verse. */
  handleVisibility(visible: boolean): void;
  /** Eventos `online`/`offline` de `window`. */
  handleOnline(online: boolean): void;
};

function defaultIsOnline(): boolean | undefined {
  return typeof navigator !== "undefined" && typeof navigator.onLine === "boolean"
    ? navigator.onLine
    : undefined;
}

/** Token del canal: la action devuelve `{ok:false}` con driver ≠ supabase o sin permiso. */
async function getRealtimeToken() {
  try {
    const r = await mintRealtimeToken();
    return r.ok ? r.data : null;
  } catch {
    // Red caída o action rota: el driver lo trata como «no hay token» y reintenta con backoff.
    return null;
  }
}

/** Import dinámico: ni los drivers ni realtime-js entran al first-load (§18.10 punto 7). */
export const defaultLoadDriver: DriverLoader = async (b) => {
  if (b.driver === "local") {
    const { createLocalDriver } = await import("@/lib/realtime-client-local");
    return createLocalDriver();
  }
  if (b.driver === "supabase" && b.url && b.anonKey) {
    const { createSupabaseDriver } = await import("@/lib/realtime-client-supabase");
    return createSupabaseDriver({
      url: b.url,
      anonKey: b.anonKey,
      tenantId: b.tenantId,
      getToken: getRealtimeToken,
    });
  }
  return null;
};

export function createRealtimeHub(opts: RealtimeHubOptions = {}): RealtimeHub {
  const timers = opts.timers ?? defaultTimers;
  const isOnline = opts.isOnline ?? defaultIsOnline;

  const batchListeners = new Set<RealtimeBatchListener>();
  const resyncListeners = new Set<RealtimeResyncListener>();
  const stateListeners = new Set<(s: ConnectionState) => void>();

  let state: ConnectionState = "off";
  // Sesión vigente (una por `start`). Los callbacks de una sesión vieja se ignoran
  // comparando contra `session`: un driver cerrado puede emitir `off` al cerrarse,
  // y un `import()` lento puede resolver después del stop.
  let session: object | null = null;
  let driver: RealtimeDriver | null = null;
  let driverStatus: DriverStatus = "idle";
  let failures = 0;
  let pollHandle: unknown = null;

  const coalescer = createCoalescer(
    COALESCE_WINDOW_MS,
    (batch) => {
      for (const fn of Array.from(batchListeners)) {
        try {
          fn(batch);
        } catch {
          // Un consumer roto no corta la entrega a los demás.
        }
      }
    },
    timers,
  );

  function setState(next: ConnectionState) {
    if (next === state) return;
    state = next;
    for (const fn of Array.from(stateListeners)) {
      try {
        fn(next);
      } catch {
        // idem
      }
    }
    schedulePoll();
  }

  function recompute() {
    if (!session) return setState("off");
    setState(deriveConnectionState(driverStatus, failures, isOnline()));
  }

  function clearPoll() {
    if (pollHandle !== null) timers.clearTimeout(pollHandle);
    pollHandle = null;
  }

  /**
   * Polling de respaldo: mientras `nextPollDelay(state)` no sea null, cada 60 s se
   * avisa `"poll"`. Si el timer ya corre, un cambio reconnecting→polling no lo
   * reinicia (si no, un canal que flapea no pollearía nunca).
   */
  function schedulePoll() {
    const delay = nextPollDelay(state);
    if (delay === null) return clearPoll();
    if (pollHandle !== null) return;
    pollHandle = timers.setTimeout(() => {
      pollHandle = null;
      emitResync("poll");
    }, delay);
  }

  function emitResync(reason: RealtimeResyncReason) {
    // Después de un re-pedido completo, el próximo poll cuenta desde acá: dos
    // refetch seguidos (visible + poll) no aportan nada.
    clearPoll();
    for (const fn of Array.from(resyncListeners)) {
      try {
        fn(reason);
      } catch {
        // idem
      }
    }
    schedulePoll();
  }

  function stopSession() {
    const d = driver;
    session = null;
    driver = null;
    driverStatus = "idle";
    failures = 0;
    coalescer.cancel();
    clearPoll();
    if (d) {
      try {
        d.close();
      } catch {
        // el contrato dice que no tira; igual el stop tiene que terminar
      }
    }
    setState("off");
  }

  return {
    getState: () => state,
    onState(fn) {
      stateListeners.add(fn);
      return () => {
        stateListeners.delete(fn);
      };
    },
    subscribe(fn) {
      batchListeners.add(fn);
      return () => {
        batchListeners.delete(fn);
      };
    },
    onResync(fn) {
      resyncListeners.add(fn);
      return () => {
        resyncListeners.delete(fn);
      };
    },
    resync() {
      coalescer.flush();
      if (shouldResync("manual")) emitResync("manual");
      driver?.nudge("manual");
    },

    start(bootstrap, loadDriver = defaultLoadDriver) {
      if (session) stopSession();
      if (bootstrap.driver === "off") return () => {};
      const mine = {};
      session = mine;
      driverStatus = "idle";
      failures = 0;
      recompute();

      void (async () => {
        let d: RealtimeDriver | null = null;
        try {
          d = await loadDriver(bootstrap);
        } catch {
          d = null; // chunk que no cargó (deploy nuevo, red): queda en polling/off
        }
        if (session !== mine) {
          d?.close();
          return;
        }
        if (!d) {
          // Sin transporte: «off» apagaría el polling, y la sala quedaría congelada.
          // Se trata como un canal caído (2 fallos) → polling de 60 s.
          driverStatus = "reconnecting";
          failures = 2;
          recompute();
          return;
        }
        driver = d;
        d.onMessage((msgs) => {
          if (session === mine) coalescer.push(msgs);
        });
        d.onStatus((status, info) => {
          if (session !== mine) return;
          driverStatus = status;
          failures = info?.failures ?? (status === "live" ? 0 : failures);
          recompute();
          // Mientras el canal no estuvo se pudieron perder mensajes: re-pedir todo.
          if (status === "live" && info?.reconnected && shouldResync("reconnect")) {
            emitResync("reconnect");
          }
        });
        await d.connect();
      })();

      return () => {
        if (session === mine) stopSession();
      };
    },

    handleVisibility(visible) {
      if (!visible || !session) return;
      driver?.nudge("visible");
      if (shouldResync("visible")) emitResync("visible");
    },

    handleOnline(online) {
      if (!session) return;
      recompute();
      if (!online) return;
      driver?.nudge("online");
      if (shouldResync("online")) emitResync("online");
    },
  };
}
