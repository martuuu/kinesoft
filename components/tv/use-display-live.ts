"use client";

/**
 * TV (T7, §26.4 C-TV): el feed EN VIVO de la pantalla de la sala (`/tv`). Sin Actor y sin el hub de realtime de la
 * app: la TV tiene su cookie de dispositivo, su action de feed (`getDisplayFeed`) y su token (`mintDisplayRealtimeToken`).
 *
 * Por qué un controlador puro (`createDisplayLive`) debajo del hook: la lógica de cuándo pedir (polling con jitter,
 * refetch por realtime con debounce, gap mínimo, desfase de reloj, revocada, build viejo) es la que se rompe en
 * silencio en una TV que nadie mira. El test la maneja con fake timers y un `fetchFeed` falso, sin React ni DOM; el
 * hook solo la cablea al ciclo de vida del componente.
 *
 * Reglas:
 * - Polling cada `FEED_POLL_MS` con ±20 % de jitter: 10 pantallas del mismo consultorio prendidas a la vez no le pegan
 *   al server en el mismo segundo (y el rate limit de `getDisplayFeed` es 30/min por pantalla).
 * - Realtime solo como «tocá acá»: un mensaje del día de la pantalla (o colapsado, `day: null`, o un movimiento cuyo
 *   `prev.day` es hoy) re-pide el feed. Debounce de 300 ms (un «Llamar» genera varios mensajes en ráfaga) y nunca dos
 *   fetch a menos de 2 s: si el último fue hace menos, se corre al cumplirse el gap.
 * - `visible` / `online`: refetch (la TV volvió de un corte de wifi o de standby).
 * - `prevKey` arranca en la key del hero del feed inicial (el SSR): un llamado que ya estaba en pantalla al cargar
 *   NO suena (handoff TV-1k). Sin feed inicial queda `undefined` y el primer feed tampoco suena (`isNewCall`).
 * - Respuestas fuera de orden: cada fetch lleva un número; una respuesta de un fetch viejo se descarta.
 * - `unpaired` / `revoked` → `onUnpaired` una sola vez y se frena todo (el hook hace `router.refresh()`: el server
 *   pinta la pantalla de vincular).
 * - Build viejo (deploy nuevo con la TV abierta días): la action vieja ya no existe y `getDisplayFeed` TIRA con «Failed
 *   to find Server Action» (o devuelve algo que no es `{ok}`). `DisplayFeed` no lleva versión de build (handoff
 *   TV-1k), así que se detecta así. → `onStaleBuild`, como máximo una vez cada 5 min (el hook además lo persiste en
 *   `sessionStorage`, así una recarga que vuelve a caer en el build viejo de un CDN no entra en bucle).
 * - Error de red (`TypeError` de fetch, `AbortError`): transitorio, se sigue con el polling.
 * - `rate_limited`: el próximo poll espera 4× (dejar que se vacíe la ventana del rate limit).
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getDisplayFeed } from "@/lib/display-device";
import { mintDisplayRealtimeToken } from "@/lib/realtime-display-token";
import { isNewCall } from "@/lib/display-feed-state";
import { FEED_POLL_MS, type DeviceFeedResult, type DisplayFeed } from "@/lib/reception-displays-types";
import type { RealtimeBootstrap } from "@/lib/realtime-events";
import type { RealtimeAgendaMessage } from "@/lib/realtime-message-guard";
import type { RealtimeDriver, RealtimeTokenGetter } from "@/lib/realtime-client-types";

export const POLL_JITTER = 0.2;
export const REALTIME_DEBOUNCE_MS = 300;
export const MIN_FETCH_GAP_MS = 2_000;
export const STALE_RELOAD_MIN_MS = 5 * 60_000;
export const RATE_LIMIT_BACKOFF = 4;
/** Sin un feed OK en este tiempo, el pie dice «Reconectando…» en vez de «En vivo». */
export const LIVE_STALE_MS = 3 * FEED_POLL_MS;
const STALE_RELOAD_STORAGE_KEY = "kine_tv:stale-reload-at";

type Timers = { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void };

export type DisplayLiveDeps = {
  fetchFeed: () => Promise<unknown>;
  onFeed: (feed: DisplayFeed, info: { newCall: boolean }) => void;
  onUnpaired: () => void;
  onStaleBuild: () => void;
  timers?: Timers;
  now?: () => number;
  random?: () => number;
};

export type DisplayLiveController = {
  start(): void;
  stop(): void;
  handleVisible(): void;
  handleOnline(): void;
  handleRealtime(msgs: readonly RealtimeAgendaMessage[]): void;
  /** El driver se reconectó: pudo perderse mensajes en el medio. */
  handleReconnected(): void;
  /** `serverNow − reloj local` (ms), medido al punto medio del último fetch OK. */
  clockSkewMs(): number;
  /** ms epoch LOCAL del último feed OK (el inicial cuenta). */
  lastOkAt(): number;
  prevKey(): string | null | undefined;
};

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** ¿El error de la action es la red (transitorio) y no una action que ya no existe en el server? */
export function isTransientFetchError(err: unknown): boolean {
  const name = err instanceof Error ? err.name : "";
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (name === "AbortError") return true;
  return name === "TypeError" && /fetch|network|load failed/i.test(msg);
}

function isDeviceFeedResult(r: unknown): r is DeviceFeedResult {
  return !!r && typeof r === "object" && "ok" in r && typeof (r as { ok: unknown }).ok === "boolean";
}

/** ¿El mensaje toca el día de la pantalla? Colapsado sin día = sí (re-pedir cuesta un fetch). */
export function messageTouchesDay(msg: RealtimeAgendaMessage, dayKey: string): boolean {
  return msg.day == null || msg.day === dayKey || msg.prev?.day === dayKey;
}

export function createDisplayLive(initialFeed: DisplayFeed | null, deps: DisplayLiveDeps): DisplayLiveController {
  const timers = deps.timers ?? defaultTimers;
  const now = deps.now ?? (() => Date.now());
  const random = deps.random ?? Math.random;

  let prevKey: string | null | undefined = initialFeed ? (initialFeed.hero?.key ?? null) : undefined;
  let dayKey: string | null = initialFeed?.dayKey ?? null;
  let skew = initialFeed ? Date.parse(initialFeed.serverNow) - now() : 0;
  let lastOk = initialFeed ? now() : 0;

  let running = false;
  let stopped = false;
  let seq = 0;
  let inFlight = false;
  /** Llegó otro motivo de refetch con un fetch en vuelo: se corre uno más al terminar. */
  let again = false;
  let lastFetchStart = -Infinity;
  let lastStaleAt = -Infinity;
  let backoff = 1;
  let pollTimer: unknown = null;
  let debounceTimer: unknown = null;
  let gapTimer: unknown = null;

  const clear = (h: unknown) => {
    if (h !== null) timers.clearTimeout(h);
  };

  function schedulePoll() {
    clear(pollTimer);
    pollTimer = null;
    if (!running) return;
    const jitter = 1 + (random() * 2 - 1) * POLL_JITTER;
    pollTimer = timers.setTimeout(() => {
      pollTimer = null;
      if (inFlight) {
        again = true;
        return;
      }
      void fetchNow();
    }, Math.round(FEED_POLL_MS * backoff * jitter));
  }

  /** Refetch respetando el gap mínimo entre fetch. */
  function requestFetch() {
    if (!running) return;
    if (inFlight) {
      again = true;
      return;
    }
    const wait = lastFetchStart + MIN_FETCH_GAP_MS - now();
    if (wait <= 0) {
      void fetchNow();
      return;
    }
    if (gapTimer !== null) return;
    gapTimer = timers.setTimeout(() => {
      gapTimer = null;
      requestFetch();
    }, wait);
  }

  async function fetchNow() {
    if (!running) return;
    clear(pollTimer);
    pollTimer = null;
    inFlight = true;
    const mySeq = ++seq;
    const sentAt = now();
    lastFetchStart = sentAt;
    let result: unknown;
    let threw: unknown = undefined;
    let didThrow = false;
    try {
      result = await deps.fetchFeed();
    } catch (err) {
      didThrow = true;
      threw = err;
    }
    inFlight = false;
    if (!running || mySeq !== seq) return;

    if (didThrow || !isDeviceFeedResult(result)) {
      if (didThrow && isTransientFetchError(threw)) {
        backoff = 1;
      } else {
        staleBuild();
        if (!running) return;
      }
    } else if (result.ok) {
      backoff = 1;
      const recvAt = now();
      skew = Date.parse(result.feed.serverNow) - (sentAt + recvAt) / 2;
      lastOk = recvAt;
      dayKey = result.feed.dayKey;
      const newCall = isNewCall(prevKey, result.feed);
      prevKey = result.feed.hero?.key ?? null;
      deps.onFeed(result.feed, { newCall });
    } else if (result.state === "unpaired" || result.state === "revoked") {
      running = false;
      stopped = true;
      clearAll();
      deps.onUnpaired();
      return;
    } else if (result.state === "rate_limited") {
      backoff = RATE_LIMIT_BACKOFF;
    } else {
      backoff = 1;
    }

    if (again) {
      again = false;
      requestFetch();
    }
    // Si `requestFetch` ya arrancó otro fetch, el poll se agenda cuando ese termine (nunca dos en vuelo).
    if (!inFlight) schedulePoll();
  }

  function staleBuild() {
    const t = now();
    if (t - lastStaleAt < STALE_RELOAD_MIN_MS) return;
    lastStaleAt = t;
    deps.onStaleBuild();
  }

  function clearAll() {
    clear(pollTimer);
    clear(debounceTimer);
    clear(gapTimer);
    pollTimer = debounceTimer = gapTimer = null;
  }

  return {
    start() {
      if (running || stopped) return;
      running = true;
      schedulePoll();
    },
    stop() {
      running = false;
      stopped = true;
      clearAll();
    },
    handleVisible: () => requestFetch(),
    handleOnline: () => requestFetch(),
    handleReconnected: () => requestFetch(),
    handleRealtime(msgs) {
      if (!running) return;
      if (dayKey !== null && !msgs.some((m) => messageTouchesDay(m, dayKey!))) return;
      clear(debounceTimer);
      debounceTimer = timers.setTimeout(() => {
        debounceTimer = null;
        requestFetch();
      }, REALTIME_DEBOUNCE_MS);
    },
    clockSkewMs: () => skew,
    lastOkAt: () => lastOk,
    prevKey: () => prevKey,
  };
}

/** ¿Se puede recargar por build viejo? Como máximo una vez cada `STALE_RELOAD_MIN_MS` (persistido entre recargas). */
export function shouldReloadForStaleBuild(lastReloadAt: number | null, nowMs: number): boolean {
  return lastReloadAt == null || !Number.isFinite(lastReloadAt) || nowMs - lastReloadAt >= STALE_RELOAD_MIN_MS;
}

function reloadForStaleBuild() {
  let last: number | null = null;
  try {
    const raw = window.sessionStorage.getItem(STALE_RELOAD_STORAGE_KEY);
    last = raw ? Number(raw) : null;
  } catch {
    last = null;
  }
  const t = Date.now();
  if (!shouldReloadForStaleBuild(last, t)) return;
  try {
    window.sessionStorage.setItem(STALE_RELOAD_STORAGE_KEY, String(t));
  } catch {
    // Sin storage (modo privado de algunas TV): el tope en memoria del controlador sigue valiendo.
  }
  window.location.reload();
}

/**
 * Token del canal para la PANTALLA (no el de la app: `mintRealtimeToken` exige Actor). Misma clasificación que el hub
 * (`tokenGetterFromAction`); `realtime-client-state` entra por `import()` junto con el driver. CF-RT (§28 E): una
 * respuesta sin `{ok}` ya no es «versión nueva» de por sí: es `server_error`, y `stale_build` solo si el server sirve
 * otro build (`x-build-id` ≠ `NEXT_PUBLIC_BUILD_ID`). La action acá ya estaba bien registrada (import estático, arriba).
 */
function displayTokenGetter(state: typeof import("@/lib/realtime-client-state")): RealtimeTokenGetter {
  return state.tokenGetterFromAction(mintDisplayRealtimeToken);
}

export type DisplayLive = {
  feed: DisplayFeed;
  /** Sube con cada llamado NUEVO (nunca por el feed inicial). */
  callSeq: number;
  /** Reloj corregido con `serverNow` (ms epoch). */
  now: () => number;
  live: boolean;
};

export function useDisplayLive(initialFeed: DisplayFeed, bootstrap: RealtimeBootstrap | null): DisplayLive {
  const router = useRouter();
  const [feed, setFeed] = useState(initialFeed);
  const [callSeq, setCallSeq] = useState(0);
  const [live, setLive] = useState(true);
  const ctrlRef = useRef<DisplayLiveController | null>(null);
  // El SSR no conoce el reloj de la TV: hasta montar, «ahora» es el `serverNow` del feed inicial.
  const skewRef = useRef(0);
  const initialRef = useRef(initialFeed);

  useEffect(() => {
    const ctrl = createDisplayLive(initialRef.current, {
      fetchFeed: () => getDisplayFeed(),
      onFeed: (f, { newCall }) => {
        setFeed(f);
        setLive(true);
        skewRef.current = ctrl.clockSkewMs();
        if (newCall) setCallSeq((n) => n + 1);
      },
      // refresh-ok: la TV se desvinculó (auth del dispositivo): el RSC de /tv pasa a la pantalla de vínculo.
      onUnpaired: () => router.refresh(),
      onStaleBuild: reloadForStaleBuild,
    });
    ctrlRef.current = ctrl;
    skewRef.current = ctrl.clockSkewMs();
    ctrl.start();

    const onVisibility = () => {
      if (document.visibilityState === "visible") ctrl.handleVisible();
    };
    const onOnline = () => ctrl.handleOnline();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);

    const liveTimer = window.setInterval(() => {
      setLive(Date.now() - ctrl.lastOkAt() < LIVE_STALE_MS);
    }, FEED_POLL_MS);

    // Realtime: solo con el driver `supabase` (D13: con `local`, solo polling). Todo por `import()` (guard-realtime
    // (e) y bundle `display` ≤ 125 kB): ni el driver ni realtime-js entran al first-load de /tv.
    let driver: RealtimeDriver | null = null;
    let cancelled = false;
    if (bootstrap?.driver === "supabase" && bootstrap.url && bootstrap.anonKey) {
      const { url, anonKey, tenantId } = bootstrap;
      void (async () => {
        try {
          const [{ createSupabaseDriver }, state] = await Promise.all([
            import("@/lib/realtime-client-supabase"),
            import("@/lib/realtime-client-state"),
          ]);
          if (cancelled) return;
          driver = createSupabaseDriver({ url, anonKey, tenantId, getToken: displayTokenGetter(state) });
          driver.onMessage((msgs) => ctrl.handleRealtime(msgs));
          driver.onStatus((s, info) => {
            if (s === "live" && info?.reconnected) ctrl.handleReconnected();
          });
          await driver.connect();
          if (cancelled) driver.close();
        } catch {
          // Sin el chunk del driver (deploy nuevo o red): la TV sigue con polling; el build viejo lo detecta el feed.
        }
      })();
    }

    return () => {
      cancelled = true;
      ctrl.stop();
      driver?.close();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
      window.clearInterval(liveTimer);
    };
    // `bootstrap` es del SSR y no cambia en la vida de la pantalla; `router` es estable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    feed,
    callSeq,
    now: () => Date.now() + skewRef.current,
    live,
  };
}
