/**
 * [TV-2u2] Feed en vivo de la pantalla de la sala (`components/tv/use-display-live.ts`): el controlador real
 * (`createDisplayLive`) con fake timers y un `fetchFeed` falso (la red). Solo se mockean `next/navigation` y las dos
 * actions del dispositivo (red/server), nunca el controlador.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/display-device", () => ({ getDisplayFeed: vi.fn() }));
vi.mock("@/lib/realtime-display-token", () => ({ mintDisplayRealtimeToken: vi.fn() }));

import {
  LIVE_STALE_MS,
  MIN_FETCH_GAP_MS,
  REALTIME_DEBOUNCE_MS,
  STALE_RELOAD_MIN_MS,
  createDisplayLive,
  isTransientFetchError,
  messageTouchesDay,
  shouldReloadForStaleBuild,
  type DisplayLiveDeps,
} from "@/components/tv/use-display-live";
import { FEED_POLL_MS, type DeviceFeedResult, type DisplayFeed, type DisplayFeedItem } from "@/lib/reception-displays-types";
import type { RealtimeAgendaMessage } from "@/lib/realtime-message-guard";

const T0 = Date.parse("2026-10-22T13:00:00.000Z");

const item = (key: string, label = "María G."): DisplayFeedItem => ({
  key: key.padEnd(16, "x").slice(0, 16),
  label,
  room: "Consultorio 2",
  practitioner: "Lic. Ríos",
  calledAt: new Date(T0 - 30_000).toISOString(),
});

function feed(heroKey: string | null, over: Partial<DisplayFeed> = {}): DisplayFeed {
  return {
    v: 1,
    serverNow: new Date(Date.now()).toISOString(),
    dayKey: "2026-10-22",
    clinicName: "Kinesio Centro",
    locationName: null,
    config: {
      nameMode: "SHORT_NAME",
      theme: "DARK",
      mediaKind: "NONE",
      mediaRef: null,
      mediaLayout: "SIDE",
      mediaMuted: true,
      mediaDuringCall: "DUCK",
    },
    hero: heroKey ? item(heroKey) : null,
    recent: [],
    waiting: [],
    waitingCount: 0,
    ...over,
  };
}

const ok = (f: DisplayFeed): DeviceFeedResult => ({ ok: true, feed: f });

const msg = (day: string | null, prevDay?: string): RealtimeAgendaMessage => ({
  v: 1,
  kind: "booking",
  bookingId: "b1",
  practitionerId: "p1",
  day,
  at: new Date(T0).toISOString(),
  ...(prevDay ? { prev: { practitionerId: "p1", day: prevDay } } : {}),
});

function setup(initial: DisplayFeed | null, responses: Array<DeviceFeedResult | (() => Promise<unknown>)>) {
  const fetchFeed = vi.fn(async () => {
    const r = responses.length > 1 ? responses.shift()! : responses[0]!;
    return typeof r === "function" ? r() : r;
  });
  const onFeed = vi.fn<DisplayLiveDeps["onFeed"]>();
  const onUnpaired = vi.fn();
  const onStaleBuild = vi.fn();
  const ctrl = createDisplayLive(initial, {
    fetchFeed,
    onFeed,
    onUnpaired,
    onStaleBuild,
    now: () => Date.now(),
    random: () => 0.5, // jitter 0 → poll exacto
  });
  return { ctrl, fetchFeed, onFeed, onUnpaired, onStaleBuild };
}

/** Deja correr los timers y las promesas pendientes. */
async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("[TV-2u2] polling", () => {
  it("[TV-2u2] pide el feed cada FEED_POLL_MS (con jitter acotado) y no antes", async () => {
    const { ctrl, fetchFeed } = setup(feed(null), [ok(feed(null))]);
    ctrl.start();
    await advance(FEED_POLL_MS - 1);
    expect(fetchFeed).toHaveBeenCalledTimes(0);
    await advance(1);
    expect(fetchFeed).toHaveBeenCalledTimes(1);
    await advance(FEED_POLL_MS);
    expect(fetchFeed).toHaveBeenCalledTimes(2);
    ctrl.stop();
    await advance(FEED_POLL_MS * 3);
    expect(fetchFeed).toHaveBeenCalledTimes(2);
  });

  it("[TV-2u2] el jitter queda en ±20 %: random=0 adelanta, random≈1 atrasa", async () => {
    const early = createDisplayLive(feed(null), {
      fetchFeed: vi.fn(async () => ok(feed(null))),
      onFeed: vi.fn(),
      onUnpaired: vi.fn(),
      onStaleBuild: vi.fn(),
      random: () => 0,
    });
    const spy = vi.spyOn(globalThis, "setTimeout");
    early.start();
    const delay = spy.mock.calls.at(-1)![1] as number;
    expect(delay).toBe(FEED_POLL_MS * 0.8);
    early.stop();
    spy.mockRestore();
  });
});

describe("[TV-2u2] llamado nuevo", () => {
  it("[TV-2u2] no suena el primer feed: el hero del feed inicial (SSR) no es un llamado nuevo", async () => {
    const { ctrl, onFeed } = setup(feed("AAA"), [ok(feed("AAA"))]);
    expect(ctrl.prevKey()).toBe("AAAxxxxxxxxxxxxx");
    ctrl.start();
    await advance(FEED_POLL_MS);
    expect(onFeed).toHaveBeenCalledTimes(1);
    expect(onFeed.mock.calls[0]![1]).toEqual({ newCall: false });
  });

  it("[TV-2u2] sin feed inicial, prevKey es undefined y el primer feed tampoco suena", async () => {
    const { ctrl, onFeed } = setup(null, [ok(feed("AAA")), ok(feed("BBB"))]);
    expect(ctrl.prevKey()).toBeUndefined();
    ctrl.start();
    await advance(FEED_POLL_MS);
    expect(onFeed.mock.calls[0]![1]).toEqual({ newCall: false });
    await advance(FEED_POLL_MS);
    expect(onFeed.mock.calls[1]![1]).toEqual({ newCall: true });
  });

  it("[TV-2u2] un hero distinto es llamado nuevo; el mismo hero en el poll siguiente, no", async () => {
    const { ctrl, onFeed } = setup(feed(null), [ok(feed("AAA")), ok(feed("AAA")), ok(feed("BBB"))]);
    ctrl.start();
    await advance(FEED_POLL_MS * 3);
    expect(onFeed.mock.calls.map((c) => c[1].newCall)).toEqual([true, false, true]);
  });
});

describe("[TV-2u2] realtime", () => {
  it("[TV-2u2] refetch por realtime con debounce de 300 ms (una ráfaga = un fetch)", async () => {
    const { ctrl, fetchFeed } = setup(feed(null), [ok(feed(null))]);
    ctrl.start();
    await advance(MIN_FETCH_GAP_MS); // ya pasó el gap desde «nunca»
    ctrl.handleRealtime([msg("2026-10-22")]);
    await advance(100);
    ctrl.handleRealtime([msg("2026-10-22")]);
    await advance(100);
    ctrl.handleRealtime([msg("2026-10-22")]);
    await advance(REALTIME_DEBOUNCE_MS - 1);
    expect(fetchFeed).toHaveBeenCalledTimes(0);
    await advance(1);
    expect(fetchFeed).toHaveBeenCalledTimes(1);
  });

  it("[TV-2u2] nunca dos fetch a menos de 2 s: el segundo espera a que se cumpla el gap", async () => {
    const { ctrl, fetchFeed } = setup(feed(null), [ok(feed(null))]);
    ctrl.start();
    ctrl.handleRealtime([msg("2026-10-22")]);
    await advance(REALTIME_DEBOUNCE_MS);
    expect(fetchFeed).toHaveBeenCalledTimes(1);
    ctrl.handleRealtime([msg("2026-10-22")]);
    await advance(REALTIME_DEBOUNCE_MS);
    expect(fetchFeed).toHaveBeenCalledTimes(1);
    await advance(MIN_FETCH_GAP_MS - REALTIME_DEBOUNCE_MS - 1);
    expect(fetchFeed).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchFeed).toHaveBeenCalledTimes(2);
  });

  it("[TV-2u2] un mensaje de otro día no re-pide; colapsado (day null) o movimiento desde hoy, sí", async () => {
    expect(messageTouchesDay(msg("2026-10-23"), "2026-10-22")).toBe(false);
    expect(messageTouchesDay(msg(null), "2026-10-22")).toBe(true);
    expect(messageTouchesDay(msg("2026-10-23", "2026-10-22"), "2026-10-22")).toBe(true);

    const { ctrl, fetchFeed } = setup(feed(null), [ok(feed(null))]);
    ctrl.start();
    ctrl.handleRealtime([msg("2026-10-23")]);
    await advance(REALTIME_DEBOUNCE_MS * 2);
    expect(fetchFeed).toHaveBeenCalledTimes(0);
  });

  it("[TV-2u2] visible / online / reconexión re-piden (respetando el gap)", async () => {
    const { ctrl, fetchFeed } = setup(feed(null), [ok(feed(null))]);
    ctrl.start();
    ctrl.handleVisible();
    await advance(0);
    expect(fetchFeed).toHaveBeenCalledTimes(1);
    ctrl.handleOnline();
    ctrl.handleReconnected();
    await advance(MIN_FETCH_GAP_MS);
    expect(fetchFeed).toHaveBeenCalledTimes(2);
  });

  it("[TV-2u2] con un fetch en vuelo, el refetch se encola y corre al terminar (sin solaparse)", async () => {
    let release!: (r: DeviceFeedResult) => void;
    const slow = () => new Promise<DeviceFeedResult>((r) => (release = r));
    const { ctrl, fetchFeed } = setup(feed(null), [slow, ok(feed(null))]);
    ctrl.start();
    ctrl.handleVisible();
    await advance(0);
    expect(fetchFeed).toHaveBeenCalledTimes(1);
    ctrl.handleRealtime([msg("2026-10-22")]);
    await advance(MIN_FETCH_GAP_MS * 2);
    expect(fetchFeed).toHaveBeenCalledTimes(1);
    release(ok(feed(null)));
    await advance(0);
    expect(fetchFeed).toHaveBeenCalledTimes(2);
  });
});

describe("[TV-2u2] estados del dispositivo", () => {
  it("[TV-2u2] refresh en revoked: onUnpaired una vez y se frena el polling", async () => {
    const { ctrl, fetchFeed, onUnpaired, onFeed } = setup(feed(null), [{ ok: false, state: "revoked" }]);
    ctrl.start();
    await advance(FEED_POLL_MS);
    expect(onUnpaired).toHaveBeenCalledTimes(1);
    expect(onFeed).not.toHaveBeenCalled();
    ctrl.handleVisible();
    ctrl.handleRealtime([msg(null)]);
    await advance(FEED_POLL_MS * 3);
    expect(fetchFeed).toHaveBeenCalledTimes(1);
    expect(onUnpaired).toHaveBeenCalledTimes(1);
  });

  it("[TV-2u2] unpaired también refresca", async () => {
    const { ctrl, onUnpaired } = setup(feed(null), [{ ok: false, state: "unpaired" }]);
    ctrl.start();
    await advance(FEED_POLL_MS);
    expect(onUnpaired).toHaveBeenCalledTimes(1);
  });

  it("[TV-2u2] unavailable conserva el feed y sigue el polling; rate_limited espera 4×", async () => {
    const { ctrl, fetchFeed, onFeed } = setup(feed(null), [{ ok: false, state: "unavailable" }, { ok: false, state: "rate_limited" }, ok(feed(null))]);
    ctrl.start();
    await advance(FEED_POLL_MS);
    await advance(FEED_POLL_MS);
    expect(fetchFeed).toHaveBeenCalledTimes(2);
    await advance(FEED_POLL_MS * 4 - 1);
    expect(fetchFeed).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(fetchFeed).toHaveBeenCalledTimes(3);
    expect(onFeed).toHaveBeenCalledTimes(1);
  });

  it("[TV-2u2] build viejo (la action ya no existe) → onStaleBuild como máximo cada 5 min; la red no cuenta", async () => {
    const stale = () => Promise.reject(new Error("Failed to find Server Action \"abc\". This request might be from an older or newer deployment."));
    const net = () => Promise.reject(new TypeError("Failed to fetch"));
    const { ctrl, onStaleBuild } = setup(feed(null), [net, stale, stale]);
    ctrl.start();
    await advance(FEED_POLL_MS);
    expect(onStaleBuild).toHaveBeenCalledTimes(0);
    await advance(FEED_POLL_MS);
    expect(onStaleBuild).toHaveBeenCalledTimes(1);
    await advance(FEED_POLL_MS * 4);
    expect(onStaleBuild).toHaveBeenCalledTimes(1);
    await advance(STALE_RELOAD_MIN_MS);
    expect(onStaleBuild).toHaveBeenCalledTimes(2);
  });

  it("[TV-2u2] una respuesta que no es {ok} (HTML de otro build) también es build viejo", async () => {
    const { ctrl, onStaleBuild } = setup(feed(null), [(() => Promise.resolve(undefined)) as () => Promise<unknown>]);
    ctrl.start();
    await advance(FEED_POLL_MS);
    expect(onStaleBuild).toHaveBeenCalledTimes(1);
  });

  it("[TV-2u2] isTransientFetchError / shouldReloadForStaleBuild", () => {
    expect(isTransientFetchError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isTransientFetchError(new TypeError("Load failed"))).toBe(true);
    expect(isTransientFetchError(Object.assign(new Error("x"), { name: "AbortError" }))).toBe(true);
    expect(isTransientFetchError(new Error("Failed to find Server Action"))).toBe(false);
    expect(shouldReloadForStaleBuild(null, T0)).toBe(true);
    expect(shouldReloadForStaleBuild(T0 - STALE_RELOAD_MIN_MS + 1, T0)).toBe(false);
    expect(shouldReloadForStaleBuild(T0 - STALE_RELOAD_MIN_MS, T0)).toBe(true);
  });
});

describe("[TV-2u2] reloj", () => {
  it("[TV-2u2] corrige el desfase con serverNow al punto medio del fetch", async () => {
    // El server va 90 s adelantado respecto de la TV; el fetch tarda 2 s → punto medio = +1 s.
    const slow = async () => {
      await new Promise((r) => setTimeout(r, 2_000));
      return ok(feed(null, { serverNow: new Date(T0 + FEED_POLL_MS + 1_000 + 90_000).toISOString() }));
    };
    const { ctrl } = setup(null, [slow]);
    expect(ctrl.clockSkewMs()).toBe(0);
    ctrl.start();
    await advance(FEED_POLL_MS + 2_000);
    expect(ctrl.clockSkewMs()).toBe(90_000);
    expect(ctrl.lastOkAt()).toBe(T0 + FEED_POLL_MS + 2_000);
    expect(LIVE_STALE_MS).toBe(3 * FEED_POLL_MS);
  });

  it("[TV-2u2] una respuesta vieja (fuera de orden) se descarta", async () => {
    let releaseOld!: (r: DeviceFeedResult) => void;
    const old = () => new Promise<DeviceFeedResult>((r) => (releaseOld = r));
    const { ctrl, onFeed } = setup(feed(null), [old, ok(feed("NEW"))]);
    ctrl.start();
    ctrl.handleVisible();
    await advance(0);
    // El controlador no solapa fetch: el viejo queda en vuelo; se lo resuelve después de pararlo → descartado.
    ctrl.stop();
    releaseOld(ok(feed("OLD")));
    await advance(0);
    expect(onFeed).not.toHaveBeenCalled();
  });
});
