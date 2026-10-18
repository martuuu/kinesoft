/**
 * [AS-0c] Campana en vivo, sin migración (plan §21.4 punto 8). Antes el contador se pedía UNA vez al montar el shell:
 * un turno reservado por el turnero (que notifica al profesional) no aparecía hasta recargar. Ahora la campana se
 * re-pide sola:
 * - cada 60 s con la pestaña visible (oculta no pide: una pestaña olvidada no martilla el server) y en seguida al
 *   volver a verse. Es el mismo `createVisiblePoller` del respaldo del realtime (HF-1b), no una copia;
 * - al volver el foco a la ventana (otra app adelante con la pestaña visible no dispara `visibilitychange`). Foco y
 *   visibilidad suelen llegar juntos: dentro de `BELL_MIN_GAP_MS` cuenta como uno;
 * - con cada lote de la agenda en vivo (`useRealtime().subscribe`), con un debounce: un turno nuevo trae su
 *   notificación en la misma operación, y los lotes llegan en ráfagas (mover un plan son N eventos).
 * Puro (timers y `isVisible`/`now` inyectables): los render tests no corren effects y esto se testea con fake timers.
 * Vive en lib/ y no al lado de la campana: el grafo del shell (pf1-shell.test) admite de components/dashboard solo
 * la campana. Va sin "use server" ni `server-only`: corre en el cliente.
 */
import { createVisiblePoller } from "@/components/providers/realtime-provider";

export const BELL_POLL_MS = 60_000;
export const BELL_REALTIME_DEBOUNCE_MS = 1_500;
export const BELL_MIN_GAP_MS = 5_000;

type Timers = { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void };
const hostTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

export type BellRefreshReason = "poll" | "visible" | "focus" | "realtime";

export function createBellLive(o: {
  refresh: (reason: BellRefreshReason) => void;
  isVisible: () => boolean;
  now?: () => number;
  timers?: Timers;
}) {
  const timers = o.timers ?? hostTimers;
  const now = o.now ?? (() => Date.now());
  let running = false;
  let last = -Infinity;
  let debounce: unknown = null;

  const fire = (reason: BellRefreshReason) => {
    last = now();
    o.refresh(reason);
  };
  const poller = createVisiblePoller({
    intervalMs: BELL_POLL_MS,
    timers,
    isVisible: o.isVisible,
    onPoll: (r) => {
      // «visible» y «focus» llegan juntos al volver a la pestaña: el segundo no repite el pedido.
      if (r === "visible" && now() - last < BELL_MIN_GAP_MS) return;
      fire(r === "visible" ? "visible" : "poll");
    },
  });
  const clearDebounce = () => {
    if (debounce !== null) timers.clearTimeout(debounce);
    debounce = null;
  };

  return {
    start() {
      running = true;
      poller.start();
    },
    stop() {
      running = false;
      poller.stop();
      clearDebounce();
    },
    handleVisibility(visible: boolean) {
      poller.handleVisibility(visible);
    },
    handleFocus() {
      if (!running || !o.isVisible() || now() - last < BELL_MIN_GAP_MS) return;
      fire("focus");
    },
    handleRealtime() {
      if (!running) return;
      clearDebounce();
      debounce = timers.setTimeout(() => {
        debounce = null;
        if (running) fire("realtime");
      }, BELL_REALTIME_DEBOUNCE_MS);
    },
  };
}
