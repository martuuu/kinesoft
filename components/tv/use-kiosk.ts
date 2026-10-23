"use client";

/**
 * TV (T7, §26.4 C-TV): modo kiosco de la pantalla de la sala (`/tv`).
 *
 * - Cursor oculto a los 3 s sin movimiento (una flecha quieta en el medio de la TV se lee como «se colgó»).
 * - `wakeLock("screen")`, re-adquirido al volver a `visible`: el navegador lo suelta solo cada vez que la pestaña se
 *   oculta (standby del televisor, cambio de entrada HDMI) y sin esto la TV se apaga a los 10-15 min.
 * - Recarga diaria a las 04:00 AR (TV-D14), con hasta 5 min de jitter para que las pantallas de un consultorio no
 *   recarguen en el mismo segundo: limpia memoria de un navegador de Smart TV que corre semanas y trae el build nuevo.
 * - Sonido: la política de autoplay no deja sonar nada sin un gesto. La pantalla muestra «Tocá OK para activar el
 *   sonido» hasta la primera tecla (el OK del control remoto llega como `keydown` Enter) o toque; ese mismo gesto
 *   desbloquea el chime (`installChimeUnlock` escucha en captura desde el montaje, así el `AudioContext` nace dentro
 *   del gesto), pide pantalla completa y deja `soundUnlocked` en true para que `youtube-pip` desmutee si la
 *   pantalla no está configurada en silencio (`mediaMuted`).
 *
 * Igual que `use-display-live`: un controlador puro con deps inyectables (`createKiosk`) y el hook que lo cablea.
 */
import { useEffect, useState } from "react";
import { installChimeUnlock } from "@/lib/arrival-chime";

export const CURSOR_IDLE_MS = 3_000;
export const DAILY_RELOAD_AR_HOUR = 4;
export const DAILY_RELOAD_JITTER_MS = 5 * 60_000;
const DAY_MS = 86_400_000;
/** AR es UTC−3 fijo (sin horario de verano desde 2009; `lib/datetime-ar.ts`, `AR_OFFSET`). */
const AR_OFFSET_MS = 3 * 3_600_000;

/** ms hasta las próximas 04:00 AR desde `nowMs` (nunca 0: si son exactamente las 04:00, la de mañana). */
export function msUntilNextDailyReload(nowMs: number): number {
  const arNow = nowMs - AR_OFFSET_MS;
  const arDayStart = Math.floor(arNow / DAY_MS) * DAY_MS;
  let target = arDayStart + DAILY_RELOAD_AR_HOUR * 3_600_000 + AR_OFFSET_MS;
  if (target <= nowMs) target += DAY_MS;
  return target - nowMs;
}

type Listenable = {
  addEventListener(type: string, fn: () => void, opts?: AddEventListenerOptions | boolean): void;
  removeEventListener(type: string, fn: () => void, opts?: EventListenerOptions | boolean): void;
};
type Timers = { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void };
type WakeLockSentinelLike = { release(): Promise<void>; addEventListener?(type: "release", fn: () => void): void };

export type KioskDeps = {
  /** `window`: `mousemove`, `keydown`, `pointerdown`. */
  win: Listenable;
  /** `document`: `visibilitychange`. */
  doc: Listenable & { visibilityState: string };
  requestWakeLock: (() => Promise<WakeLockSentinelLike>) | null;
  requestFullscreen: (() => Promise<void> | void) | null;
  unlockChime: () => void;
  reload: () => void;
  onCursorHidden: (hidden: boolean) => void;
  onSoundUnlocked: () => void;
  timers?: Timers;
  /** Reloj corregido con el server (la hora de la recarga es la del consultorio, no la de la TV). */
  now?: () => number;
  random?: () => number;
};

export type Kiosk = { start(): void; stop(): void };

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

export function createKiosk(deps: KioskDeps): Kiosk {
  const timers = deps.timers ?? defaultTimers;
  const now = deps.now ?? (() => Date.now());
  const random = deps.random ?? Math.random;
  let cursorTimer: unknown = null;
  let reloadTimer: unknown = null;
  let cursorHidden = false;
  let unlocked = false;
  let lock: WakeLockSentinelLike | null = null;
  let running = false;

  const setCursor = (hidden: boolean) => {
    if (hidden === cursorHidden) return;
    cursorHidden = hidden;
    deps.onCursorHidden(hidden);
  };

  const armCursor = () => {
    if (cursorTimer !== null) timers.clearTimeout(cursorTimer);
    cursorTimer = timers.setTimeout(() => {
      cursorTimer = null;
      setCursor(true);
    }, CURSOR_IDLE_MS);
  };

  const onMove = () => {
    setCursor(false);
    armCursor();
  };

  async function acquireWakeLock() {
    if (!deps.requestWakeLock || !running || lock) return;
    try {
      const l = await deps.requestWakeLock();
      if (!running) {
        void l.release().catch(() => {});
        return;
      }
      lock = l;
      l.addEventListener?.("release", () => {
        if (lock === l) lock = null;
      });
    } catch {
      // Sin permiso (Permissions-Policy, batería baja, navegador viejo): la TV sigue, con el ahorro de energía del equipo.
    }
  }

  const onVisibility = () => {
    if (deps.doc.visibilityState === "visible") {
      lock = null; // el navegador lo soltó al ocultarse aunque el evento `release` no haya llegado
      void acquireWakeLock();
    }
  };

  const onGesture = () => {
    if (unlocked) return;
    unlocked = true;
    deps.win.removeEventListener("keydown", onGesture, true);
    deps.win.removeEventListener("pointerdown", onGesture, true);
    deps.onSoundUnlocked();
    try {
      const p = deps.requestFullscreen?.();
      if (p && typeof (p as Promise<void>).catch === "function") (p as Promise<void>).catch(() => {});
    } catch {
      // Fullscreen negado: no es grave (el kiosco del sistema suele ya estar a pantalla completa).
    }
    // Tras el desbloqueo un toque puede ser para pedir el sonido otra vez; también vuelve a pedir el wake lock.
    void acquireWakeLock();
  };

  const scheduleReload = () => {
    const wait = msUntilNextDailyReload(now()) + Math.floor(random() * DAILY_RELOAD_JITTER_MS);
    reloadTimer = timers.setTimeout(() => {
      reloadTimer = null;
      deps.reload();
    }, wait);
  };

  return {
    start() {
      if (running) return;
      running = true;
      // El chime escucha el primer gesto en captura ANTES que nosotros: el AudioContext se crea dentro del gesto.
      deps.unlockChime();
      deps.win.addEventListener("mousemove", onMove, { passive: true });
      deps.win.addEventListener("keydown", onGesture, true);
      deps.win.addEventListener("pointerdown", onGesture, true);
      deps.doc.addEventListener("visibilitychange", onVisibility);
      armCursor();
      scheduleReload();
      void acquireWakeLock();
    },
    stop() {
      running = false;
      if (cursorTimer !== null) timers.clearTimeout(cursorTimer);
      if (reloadTimer !== null) timers.clearTimeout(reloadTimer);
      cursorTimer = reloadTimer = null;
      deps.win.removeEventListener("mousemove", onMove);
      deps.win.removeEventListener("keydown", onGesture, true);
      deps.win.removeEventListener("pointerdown", onGesture, true);
      deps.doc.removeEventListener("visibilitychange", onVisibility);
      if (lock) void lock.release().catch(() => {});
      lock = null;
    },
  };
}

export function useKiosk(opts: { now: () => number }): { cursorHidden: boolean; soundUnlocked: boolean } {
  const [cursorHidden, setCursorHidden] = useState(false);
  const [soundUnlocked, setSoundUnlocked] = useState(false);
  const { now } = opts;

  useEffect(() => {
    const nav = navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> } };
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
    const fullscreen = el.requestFullscreen
      ? () => (document.fullscreenElement ? undefined : el.requestFullscreen())
      : el.webkitRequestFullscreen
        ? () => el.webkitRequestFullscreen!()
        : null;
    const kiosk = createKiosk({
      win: window,
      doc: document,
      requestWakeLock: nav.wakeLock ? () => nav.wakeLock!.request("screen") : null,
      requestFullscreen: fullscreen,
      unlockChime: installChimeUnlock,
      reload: () => window.location.reload(),
      onCursorHidden: setCursorHidden,
      onSoundUnlocked: () => setSoundUnlocked(true),
      now,
    });
    kiosk.start();
    return () => kiosk.stop();
    // `now` lee un ref del hook del feed: estable en la práctica; el kiosco no se re-arma por un render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { cursorHidden, soundUnlocked };
}
