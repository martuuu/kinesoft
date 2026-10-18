/**
 * [AS-0c] Campana en vivo: polling de 60 s con la pestaña visible, foco y eventos de la agenda en vivo
 * (`createBellLive`, lib/notifications-live.ts). Fake timers: el símbolo real con el reloj de vitest.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BELL_MIN_GAP_MS,
  BELL_POLL_MS,
  BELL_REALTIME_DEBOUNCE_MS,
  createBellLive,
  type BellRefreshReason,
} from "@/lib/notifications-live";

describe("[AS-0c] createBellLive", () => {
  let visible = true;
  let calls: BellRefreshReason[] = [];
  const mk = () => createBellLive({ refresh: (r) => calls.push(r), isVisible: () => visible });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-18T12:00:00Z"));
    visible = true;
    calls = [];
  });
  afterEach(() => vi.useRealTimers());

  it("cada 60 s con la pestaña visible", () => {
    const live = mk();
    live.start();
    vi.advanceTimersByTime(BELL_POLL_MS - 1);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual(["poll"]);
    vi.advanceTimersByTime(BELL_POLL_MS * 2);
    expect(calls).toEqual(["poll", "poll", "poll"]);
    live.stop();
    vi.advanceTimersByTime(BELL_POLL_MS * 3);
    expect(calls).toHaveLength(3);
  });

  it("oculta no pide; al volver a verse pide en seguida y re-arranca la cuenta", () => {
    const live = mk();
    live.start();
    visible = false;
    live.handleVisibility(false);
    vi.advanceTimersByTime(BELL_POLL_MS * 5);
    expect(calls).toEqual([]);
    visible = true;
    live.handleVisibility(true);
    expect(calls).toEqual(["visible"]);
    vi.advanceTimersByTime(BELL_POLL_MS);
    expect(calls).toEqual(["visible", "poll"]);
    live.stop();
  });

  it("foco: pide, pero foco + visibilidad juntos cuentan como uno", () => {
    const live = mk();
    live.start();
    vi.advanceTimersByTime(BELL_MIN_GAP_MS + 1);
    live.handleFocus();
    expect(calls).toEqual(["focus"]);
    live.handleVisibility(true);
    expect(calls).toEqual(["focus"]);
    vi.advanceTimersByTime(BELL_MIN_GAP_MS);
    live.handleFocus();
    expect(calls).toEqual(["focus", "focus"]);
    // Foco con la pestaña oculta (no pasa en la práctica, pero no debe pedir).
    visible = false;
    vi.advanceTimersByTime(BELL_MIN_GAP_MS);
    live.handleFocus();
    expect(calls).toEqual(["focus", "focus"]);
    live.stop();
  });

  it("eventos de la agenda en vivo: una ráfaga = un pedido, después del debounce", () => {
    const live = mk();
    live.start();
    live.handleRealtime();
    vi.advanceTimersByTime(500);
    live.handleRealtime();
    live.handleRealtime();
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(BELL_REALTIME_DEBOUNCE_MS);
    expect(calls).toEqual(["realtime"]);
    // Un evento después de parar no pide.
    live.handleRealtime();
    live.stop();
    vi.advanceTimersByTime(BELL_REALTIME_DEBOUNCE_MS * 2);
    expect(calls).toEqual(["realtime"]);
  });

  it("antes de start no hace nada", () => {
    const live = mk();
    live.handleFocus();
    live.handleRealtime();
    vi.advanceTimersByTime(BELL_POLL_MS * 2);
    expect(calls).toEqual([]);
  });
});
