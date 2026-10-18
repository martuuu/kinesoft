/**
 * HF-1b (§22.2 H-RT1, §22.4) · diagnóstico y rechazo permanente del cliente realtime.
 *
 * Lo que se cuida:
 * - El motivo del mint fallido y del CHANNEL_ERROR ya no se pierde (antes solo `devWarn`, no-op en prod): el driver lo
 *   manda en `StatusInfo.diag` y el hub lo guarda (`getDiag`/`onDiag`) para el indicador y el beacon.
 * - Un rechazo de auth es permanente: tras 3 intentos el driver se estaciona (reintento cada 5 min, o ante
 *   visible/online si ya pasaron 5 min, o ya con «Reconectar»). Meta ≤4 mints en 10 min: el bucle de antes pedía uno
 *   por backoff (1, 2, 4… 30 s) y agotaba el rate limit de 30 cada 10 min.
 *
 * Fakes a mano (brief SV: `vi.fn` que tira a través de un mock rompe vitest 2.1.9). Se testean los símbolos reales:
 * `createSupabaseDriver`, `createRealtimeHub` y el `getRealtimeToken` que el hub cablea en prod; lo único mockeado es
 * la server action (frontera de red).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DriverStatus, RealtimeDiag, StatusInfo } from "@/lib/realtime-client-types";
import { createSupabaseDriver, type RealtimeClientCtor } from "@/lib/realtime-client-supabase";
import {
  PARKED_RETRY_MS,
  classifyJoinError,
  classifyMintError,
  clipDiagReason,
} from "@/lib/realtime-client-state";

const mintAction = vi.hoisted(() => ({
  calls: 0,
  next: { ok: false, error: "realtime-error" } as unknown,
  throws: null as unknown,
}));
vi.mock("@/lib/realtime-token", () => ({
  mintRealtimeToken: async () => {
    mintAction.calls++;
    if (mintAction.throws) throw mintAction.throws;
    return mintAction.next;
  },
}));

import { createRealtimeHub, getRealtimeToken } from "@/components/realtime/realtime-hub";

const NOW = Date.parse("2026-10-18T12:00:00.000Z");

async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

type SubCb = (status: "SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR", err?: Error) => void;

function makeFake() {
  const reg = { channels: [] as Array<{ cb: SubCb | null; removed: boolean }> };
  class FakeClient {
    constructor(_e: string, _o: unknown) {}
    channel() {
      const ch = {
        cb: null as SubCb | null,
        removed: false,
        on() {
          return ch;
        },
        subscribe(cb: SubCb) {
          ch.cb = cb;
          return ch;
        },
      };
      reg.channels.push(ch);
      return ch;
    }
    async setAuth() {}
    async removeChannel(ch: { cb: SubCb | null; removed: boolean }) {
      ch.removed = true;
      ch.cb?.("CLOSED");
      return "ok";
    }
    async disconnect() {}
  }
  return { reg, FakeClient: FakeClient as unknown as RealtimeClientCtor };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mintAction.calls = 0;
  mintAction.next = { ok: false, error: "realtime-error" };
  mintAction.throws = null;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("[HF-1b] clasificación pura", () => {
  it("CHANNEL_ERROR con JWT/Unauthorized = auth permanente; TIMED_OUT/CLOSED transitorios", () => {
    expect(classifyJoinError("CHANNEL_ERROR", new Error("Unauthorized: invalid JWT signature"))).toMatchObject({
      step: "join",
      code: "auth",
      permanent: true,
    });
    expect(classifyJoinError("CHANNEL_ERROR", new Error("boom"))).toMatchObject({ code: "channel_error", permanent: false });
    expect(classifyJoinError("TIMED_OUT")).toMatchObject({ step: "join", code: "timeout", permanent: false });
    expect(classifyJoinError("CLOSED")).toMatchObject({ step: "socket", code: "closed", permanent: false });
  });

  it("mint {ok:false}: cada error conocido a su código", () => {
    expect(classifyMintError("realtime-off").code).toBe("off");
    expect(classifyMintError("realtime-unconfigured").code).toBe("unconfigured");
    expect(classifyMintError("realtime-error").code).toBe("server_error");
    expect(classifyMintError("Tu sesión venció.").code).toBe("session");
    expect(classifyMintError("Demasiados intentos. Probá de nuevo en 40 s.").code).toBe("rate_limited");
    expect(classifyMintError("No tenés acceso a la sala de espera en vivo.").code).toBe("no_access");
  });

  it("el reason se recorta a 160 y nunca lleva un JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJ0ZW5hbnRfaWQiOiJ4In0.c2lnbmF0dXJh";
    const r = clipDiagReason(`bad token ${jwt} ${"x".repeat(400)}`);
    expect(r.length).toBeLessThanOrEqual(160);
    expect(r).not.toContain("eyJ");
  });
});

describe("[HF-1b] driver supabase · rechazo permanente", () => {
  function setup(getToken?: () => Promise<{ token: string; expiresAt: string } | { code: never; reason: string } | null>) {
    const fake = makeFake();
    const tok = { calls: 0 };
    const driver = createSupabaseDriver({
      url: "https://proj.supabase.co",
      anonKey: "sb_publishable_test",
      tenantId: "t1",
      getToken:
        getToken ??
        (async () => {
          tok.calls++;
          return { token: `tok-${tok.calls}`, expiresAt: new Date(Date.now() + 600_000).toISOString() };
        }),
      deps: { RealtimeClient: fake.FakeClient, random: () => 0 },
    });
    const log: Array<{ s: DriverStatus; info?: StatusInfo }> = [];
    driver.onStatus((s, info) => log.push({ s, info }));
    return { fake, tok, driver, log };
  }

  /** El server rechaza cada join con el motivo de H-RT1. */
  function rejectEveryJoin(fake: ReturnType<typeof makeFake>) {
    let seen = 0;
    return () => {
      for (; seen < fake.reg.channels.length; seen++) {
        fake.reg.channels[seen].cb?.("CHANNEL_ERROR", new Error("Unauthorized: invalid JWT signature"));
      }
    };
  }

  it("[HF-1b] 3 CHANNEL_ERROR de auth → polling sin re-mint en bucle (≤4 mints en 10 min)", async () => {
    const { fake, tok, driver, log } = setup();
    const reject = rejectEveryJoin(fake);
    await driver.connect();
    await settle();
    reject();
    // 10 min con la pestaña yendo y viniendo cada 30 s: ni el backoff ni los `visible` re-mintean en bucle.
    for (let t = 0; t < 600_000 - 4_000; t += 1_000) {
      await vi.advanceTimersByTimeAsync(1_000);
      if (t % 30_000 === 0) driver.nudge("visible");
      await settle();
      reject();
    }
    expect(tok.calls).toBeLessThanOrEqual(4);
    const last = log.at(-1)!;
    expect(last.s).toBe("reconnecting");
    expect(last.info?.failures).toBeGreaterThanOrEqual(3);
    expect(last.info?.diag).toMatchObject({ step: "join", code: "auth", permanent: true });
    expect(last.info?.diag?.reason).toContain("Unauthorized");
    driver.close();
  });

  it("estacionado: «Reconectar» reintenta YA; si entra, vuelve a live y limpia el contador", async () => {
    const { fake, tok, driver, log } = setup();
    const reject = rejectEveryJoin(fake);
    await driver.connect();
    await settle();
    for (let i = 0; i < 10; i++) {
      reject();
      await vi.advanceTimersByTimeAsync(5_000);
      await settle();
    }
    const before = tok.calls;
    expect(before).toBe(3);
    driver.nudge("visible"); // < 5 min desde el último intento: no gasta mint
    await settle();
    expect(tok.calls).toBe(before);
    driver.nudge("reconnect");
    await settle();
    expect(tok.calls).toBe(before + 1);
    fake.reg.channels.at(-1)!.cb?.("SUBSCRIBED");
    expect(log.at(-1)).toMatchObject({ s: "live", info: { failures: 0, reconnected: true } });
    driver.close();
  });

  it("estacionado: cada 5 min un intento solo", async () => {
    const { fake, tok, driver } = setup();
    const reject = rejectEveryJoin(fake);
    await driver.connect();
    await settle();
    for (let i = 0; i < 10; i++) {
      reject();
      await vi.advanceTimersByTimeAsync(5_000);
      await settle();
    }
    expect(tok.calls).toBe(3);
    await vi.advanceTimersByTimeAsync(PARKED_RETRY_MS);
    await settle();
    expect(tok.calls).toBe(4);
    driver.close();
  });
});

describe("[HF-1b] hub · motivo del mint", () => {
  function hubWithRealGetter() {
    const fake = makeFake();
    const hub = createRealtimeHub({ isOnline: () => true });
    const diags: Array<RealtimeDiag | null> = [];
    hub.onDiag((d) => diags.push(d));
    hub.start({ driver: "supabase", tenantId: "t1", url: "https://proj.supabase.co", anonKey: "k" }, async (b) =>
      createSupabaseDriver({
        url: b.url!,
        anonKey: b.anonKey!,
        tenantId: b.tenantId,
        getToken: getRealtimeToken,
        deps: { RealtimeClient: fake.FakeClient, random: () => 0 },
      }),
    );
    return { hub, diags, fake };
  }

  it("[HF-1b] el hub conserva el motivo del último mint fallido", async () => {
    mintAction.next = { ok: false, error: "No tenés acceso a la sala de espera en vivo." };
    const { hub } = hubWithRealGetter();
    await settle();
    expect(hub.getDiag()).toMatchObject({
      step: "mint",
      code: "no_access",
      reason: "No tenés acceso a la sala de espera en vivo.",
      permanent: true,
    });
    // Tres {ok:false} y se estaciona: en 10 min no pasa de 4 mints (antes: uno por backoff hasta el rate limit).
    for (let i = 0; i < 600; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
      await settle();
    }
    expect(mintAction.calls).toBeLessThanOrEqual(4);
    expect(hub.getState()).toBe("polling");
  });

  it("action que ya no existe (deploy nuevo, PWA vieja) → stale_build y se estaciona al toque", async () => {
    mintAction.throws = new Error(
      'Failed to find Server Action "abc". This request might be from an older or newer deployment.',
    );
    const { hub } = hubWithRealGetter();
    await settle();
    expect(hub.getDiag()).toMatchObject({ step: "mint", code: "stale_build", permanent: true });
    for (let i = 0; i < 120; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
      await settle();
    }
    expect(mintAction.calls).toBe(1);
  });

  it("red caída en el mint = transitorio (sigue el backoff corto)", async () => {
    mintAction.throws = new TypeError("Failed to fetch");
    expect(await getRealtimeToken()).toBeNull();
  });

  it("live limpia el diagnóstico", async () => {
    mintAction.next = { ok: true, data: { token: "t", expiresAt: new Date(NOW + 600_000).toISOString() } };
    const { hub, fake, diags } = hubWithRealGetter();
    await settle();
    fake.reg.channels[0].cb?.("CHANNEL_ERROR", new Error("boom"));
    expect(hub.getDiag()).toMatchObject({ code: "channel_error" });
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    fake.reg.channels.at(-1)!.cb?.("SUBSCRIBED");
    expect(hub.getState()).toBe("live");
    expect(hub.getDiag()).toBeNull();
    expect(diags.at(-1)).toBeNull();
  });
});
