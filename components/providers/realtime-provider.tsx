"use client";

/**
 * Provider del canal realtime de la agenda (SV07b, §18.2 «Cliente», C-SV7).
 *
 * Lo monta `AppShell` sobre todo el workspace con el DTO de `realtimeBootstrap`
 * (layout `(app)`). Las pantallas lo consumen con `useRealtime()`:
 * - `subscribe(fn)` recibe LOTES de `RealtimeAgendaMessage` ya validados y
 *   coalescidos (250 ms): una ráfaga = un re-pedido.
 * - `onResync(fn)` avisa cuándo re-pedir TODO porque se pudieron perder mensajes
 *   (reconexión, pestaña que vuelve a verse, vuelve la red, botón manual) o porque
 *   no hay canal y toca el polling de respaldo cada 60 s (`"poll"`).
 * - `state` alimenta al `LiveIndicator`.
 *
 * Por qué así:
 * - Bundle (§18.10 punto 7, FX3): este archivo va en el first-load de TODAS las
 *   rutas del workspace, así que acá queda solo el cableado. El hub
 *   (`components/realtime/realtime-hub`, con `lib/realtime-client-state`, el
 *   schema zod de `lib/realtime-events` y la action del token) entra por
 *   `import()` dinámico en el effect, y nunca con `driver:"off"`. El gate de SV
 *   midió +11 kB gz por ruta con hub y avisos estáticos; los drivers (y por ellos
 *   `@supabase/realtime-js`) van un `import()` más abajo, en el hub.
 * - Los listeners viven ACÁ (no en el hub): las pantallas se suscriben en su
 *   effect antes de que el `import()` resuelva, y el hub, al cargar, entrega a
 *   estos sets. Así `subscribe`/`onResync`/`resync` son estables y valen desde el
 *   primer render, haya hub o no.
 * - Toda la lógica vive en `createRealtimeHub` (sin React, sin DOM): los render
 *   tests corren sin jsdom (no hay effects), así que el hub se testea directo con
 *   un driver fake y timers fake; el provider es solo cableado de eventos del DOM.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
// Solo tipos: `import type` se borra al compilar y no arrastra el módulo al bundle.
import type { ConnectionState } from "@/lib/realtime-client-types";
import type { RealtimeAgendaMessage, RealtimeBootstrap } from "@/lib/realtime-events";

/**
 * Por qué hay que re-pedir. `"connect"` no está: la primera conexión llega con la
 * página recién renderizada por el server (`shouldResync("connect") === false`).
 */
export type RealtimeResyncReason = "reconnect" | "visible" | "online" | "manual" | "poll";

export type RealtimeBatchListener = (batch: RealtimeAgendaMessage[]) => void;
export type RealtimeResyncListener = (reason: RealtimeResyncReason) => void;

export type RealtimeContextValue = {
  state: ConnectionState;
  subscribe(fn: RealtimeBatchListener): () => void;
  onResync(fn: RealtimeResyncListener): () => void;
  resync(): void;
};

/**
 * Estado inicial antes de que el driver hable (SSR incluido). Inlineado a
 * propósito: es `deriveConnectionState("idle", 0, undefined)` = `"reconnecting"`
 * (no «Sin conexión» mientras carga), pero importarlo de
 * `lib/realtime-client-state` metería ese módulo (y zod) en el first-load. Un
 * test ata los dos valores.
 */
export function initialRealtimeState(bootstrap: RealtimeBootstrap): ConnectionState {
  return bootstrap.driver === "off" ? "off" : "reconnecting";
}

/** Entrega a cada listener en su try: un consumer roto no corta a los demás. */
function fanOut<A>(set: Set<(a: A) => void>, arg: A) {
  for (const fn of Array.from(set)) {
    try {
      fn(arg);
    } catch {
      // idem
    }
  }
}

// ─── React ───────────────────────────────────────────────────────────────────

const noopUnsub = () => {};

/**
 * Fuera del provider (tests de componentes, superficies sin workspace) todo
 * funciona como realtime apagado: SR tal cual.
 */
const OFF_VALUE: RealtimeContextValue = {
  state: "off",
  subscribe: () => noopUnsub,
  onResync: () => noopUnsub,
  resync: () => {},
};

const RealtimeContext = createContext<RealtimeContextValue>(OFF_VALUE);

/** Lo que el provider necesita del hub cargado (subconjunto de `RealtimeHub`). */
type LoadedHub = {
  resync(): void;
};

export function RealtimeProvider({
  bootstrap,
  children,
}: {
  bootstrap: RealtimeBootstrap;
  children: ReactNode;
}) {
  // Listeners y puente al hub: un objeto por instancia del provider, estable
  // entre renders (useState con inicializador, no se recrea).
  const [bridge] = useState(() => {
    const batch = new Set<RealtimeBatchListener>();
    const resync = new Set<RealtimeResyncListener>();
    const b = {
      hub: null as LoadedHub | null,
      batch,
      resync,
      subscribe(fn: RealtimeBatchListener) {
        batch.add(fn);
        return () => {
          batch.delete(fn);
        };
      },
      onResync(fn: RealtimeResyncListener) {
        resync.add(fn);
        return () => {
          resync.delete(fn);
        };
      },
      /**
       * Con hub: descarga lo pendiente del coalescer y avisa `"manual"`. Sin hub
       * (driver off, o el `import()` todavía no resolvió) avisa `"manual"` igual,
       * como hacía el hub sin sesión: el botón «Actualizar» re-pide siempre.
       */
      requestResync() {
        if (b.hub) b.hub.resync();
        else fanOut(resync, "manual" as RealtimeResyncReason);
      },
    };
    return b;
  });
  const [state, setState] = useState<ConnectionState>(() => initialRealtimeState(bootstrap));

  const { driver, url, anonKey, tenantId } = bootstrap;
  // Dependencias primitivas: un `router.refresh()` re-renderiza el layout y trae
  // otro objeto bootstrap igual; reconectar por identidad sería un socket nuevo por refresh.
  useEffect(() => {
    if (driver === "off") {
      setState("off");
      return;
    }
    // Primer paint de un driver vivo: «reconnecting» hasta que el hub hable.
    setState(initialRealtimeState({ driver, url, anonKey, tenantId }));
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    import("@/components/realtime/realtime-hub").then(
      ({ createRealtimeHub }) => {
        if (cancelled) return;
        const hub = createRealtimeHub();
        const offState = hub.onState(setState);
        const offBatch = hub.subscribe((msgs) => fanOut(bridge.batch, msgs));
        const offResync = hub.onResync((reason) => fanOut(bridge.resync, reason));
        const stop = hub.start({ driver, url, anonKey, tenantId });
        bridge.hub = hub;
        setState(hub.getState());

        const onVisibility = () => hub.handleVisibility(document.visibilityState === "visible");
        const onOnline = () => hub.handleOnline(true);
        const onOffline = () => hub.handleOnline(false);
        document.addEventListener("visibilitychange", onVisibility);
        window.addEventListener("online", onOnline);
        window.addEventListener("offline", onOffline);
        cleanup = () => {
          document.removeEventListener("visibilitychange", onVisibility);
          window.removeEventListener("online", onOnline);
          window.removeEventListener("offline", onOffline);
          stop();
          offState();
          offBatch();
          offResync();
          if (bridge.hub === hub) bridge.hub = null;
        };
      },
      () => {
        // Chunk que no cargó (deploy nuevo, red): mismo criterio que un driver que
        // no carga en el hub — sin canal, polling de 60 s (la sala no se congela).
        // 60 s literal = `POLL_INTERVAL_MS`: importarlo traería el módulo que no cargó.
        if (cancelled) return;
        setState("polling");
        const id = setInterval(() => fanOut(bridge.resync, "poll" as RealtimeResyncReason), 60_000);
        cleanup = () => clearInterval(id);
      },
    );

    return () => {
      cancelled = true;
      cleanup?.();
      cleanup = null;
    };
  }, [bridge, driver, url, anonKey, tenantId]);

  const value = useMemo<RealtimeContextValue>(
    () => ({
      state,
      subscribe: bridge.subscribe,
      onResync: bridge.onResync,
      resync: bridge.requestResync,
    }),
    [bridge, state],
  );

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): RealtimeContextValue {
  return useContext(RealtimeContext);
}
