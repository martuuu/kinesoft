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
 *
 * HF-1b (§22.2 H-RT1): el hub guarda el último diagnóstico (`getDiag`/`onDiag`: paso, código y motivo ≤160) y lo
 * limpia al quedar en vivo. Antes el motivo del mint fallido y el `err` del canal solo iban a `devWarn` (no-op en
 * prod) y desde afuera era imposible saber por qué una cuenta nunca pasaba a «En vivo». El provider lo publica al
 * indicador y lo manda una vez por código al beacon de errores del cliente.
 */
import {
  classifyMintError,
  classifyMintThrow,
  createCoalescer,
  defaultTimers,
  deriveConnectionState,
  makeDiag,
  nextPollDelay,
  shouldResync,
  COALESCE_WINDOW_MS,
} from "@/lib/realtime-client-state";
import type {
  ConnectionState,
  DriverStatus,
  RealtimeDiag,
  RealtimeDriver,
  RealtimeTokenGetter,
  Timers,
} from "@/lib/realtime-client-types";
import { importWithRetry, isStaleBuildError } from "@/lib/chunk-retry";
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
  /** HF-1b: último fallo de la sesión; `null` en vivo, sin sesión o antes del primer fallo. */
  getDiag(): RealtimeDiag | null;
  onDiag(fn: (d: RealtimeDiag | null) => void): () => void;
  /** HF-1b: botón «Reconectar» del detalle: reintenta ya aunque el driver esté estacionado, y re-pide los datos. */
  reconnect(): void;
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

/**
 * Token del canal. HF-1b: el `{ok:false}` ya no se aplana a `null` — vuelve clasificado (`classifyMintError`) para que
 * el driver lo cuente como permanente y el indicador diga por qué. Que la action TIRE (por contrato no tira) es red
 * (`null`, transitorio) o una action que ya no existe en el server (`stale_build`: deploy nuevo con la PWA vieja).
 */
export const getRealtimeToken: RealtimeTokenGetter = async () => {
  let r: unknown;
  try {
    r = await mintRealtimeToken();
  } catch (err) {
    return classifyMintThrow(err);
  }
  // Una respuesta sin `ok` no salió de la action (Next devolvió otra cosa: id de action de otro build).
  if (!r || typeof r !== "object" || !("ok" in r)) {
    return { code: "stale_build", reason: "La action del token no respondió" };
  }
  const res = r as Awaited<ReturnType<typeof mintRealtimeToken>>;
  return res.ok ? res.data : classifyMintError(res.error);
};

/**
 * Import dinámico: ni los drivers ni realtime-js entran al first-load (§18.10 punto 7). HF-1b: con un reintento
 * (`importWithRetry`); si el chunk tampoco está a los 5 s, tira `StaleBuildError` y el hub lo marca versión nueva.
 */
export const defaultLoadDriver: DriverLoader = async (b) => {
  if (b.driver === "local") {
    const { createLocalDriver } = await importWithRetry(() => import("@/lib/realtime-client-local"));
    return createLocalDriver();
  }
  if (b.driver === "supabase" && b.url && b.anonKey) {
    const { createSupabaseDriver } = await importWithRetry(() => import("@/lib/realtime-client-supabase"));
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
  const diagListeners = new Set<(d: RealtimeDiag | null) => void>();
  let diag: RealtimeDiag | null = null;

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

  function setDiag(next: RealtimeDiag | null) {
    if (next === diag) return;
    diag = next;
    for (const fn of Array.from(diagListeners)) {
      try {
        fn(next);
      } catch {
        // idem
      }
    }
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
    setDiag(null);
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
    getDiag: () => diag,
    onDiag(fn) {
      diagListeners.add(fn);
      return () => {
        diagListeners.delete(fn);
      };
    },
    reconnect() {
      coalescer.flush();
      if (shouldResync("manual")) emitResync("manual");
      driver?.nudge("reconnect");
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
        let loadErr: unknown = null;
        try {
          d = await loadDriver(bootstrap);
        } catch (err) {
          d = null; // chunk que no cargó (deploy nuevo, red): queda en polling/off
          loadErr = err ?? new Error("import");
        }
        if (session !== mine) {
          d?.close();
          return;
        }
        if (!d) {
          setDiag(
            loadErr
              ? makeDiag("import", isStaleBuildError(loadErr) ? "stale_build" : "network", loadErr, Date.now())
              : makeDiag("bootstrap", "no_transport", `driver ${bootstrap.driver} sin URL o clave`, Date.now()),
          );
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
          if (status === "live") setDiag(null);
          else if (info?.diag) setDiag(info.diag);
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
