/**
 * SV07a · drivers del cliente realtime con fakes inyectados (Node 20 no tiene
 * `WebSocket` ni `EventSource`; tampoco queremos red en unit).
 *
 * Fakes con registro a mano (`calls`, `fail`) y no `vi.fn` que tire: vitest 2.1.9
 * rompe con un `vi.fn` que tira a través de un mock (brief SV).
 *
 * Lo que se cuida (§18.2 «Cliente», §18.8 fila SV07a):
 * - supabase: canal PRIVADO del topic del consultorio, sin eco propio; token al
 *   conectar y al refrescar (setAuth); caída → re-mint + resubscribe tras el
 *   backoff; SUBSCRIBED tras una caída avisa la reconexión (el provider re-pide);
 *   close() limpia todo; el objeto driver no expone NINGUNA forma de publicar.
 * - local: EventSource, reconecta en onerror con backoff, entrega los lotes.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DriverStatus, StatusInfo } from "@/lib/realtime-client-types";
import { createSupabaseDriver } from "@/lib/realtime-client-supabase";
import { createLocalDriver } from "@/lib/realtime-client-local";
import type { RealtimeAgendaMessage } from "@/lib/realtime-events";
import { REALTIME_EVENT, topicFor } from "@/lib/realtime-constants";

const TENANT = "tenant_abc";
const NOW = Date.parse("2026-10-13T12:00:00.000Z");

function msg(i: number): RealtimeAgendaMessage {
  return {
    v: 1,
    kind: "reception",
    bookingId: `b${i}`,
    practitionerId: "p1",
    day: "2026-10-13",
    at: "2026-10-13T12:00:00.000Z",
  };
}

/** Deja correr las promesas pendientes (imports, getToken, setAuth) sin avanzar el reloj. */
async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

// ─── Fake de @supabase/realtime-js ────────────────────────────────────────────

type SubStatus = "SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR";
type SubscribeCb = (status: SubStatus, err?: Error) => void;
type BroadcastCb = (msg: { type: string; event: string; payload?: unknown }) => void;

class FakeChannel {
  subscribeCb: SubscribeCb | null = null;
  handlers: Array<{ type: string; filter: { event: string }; cb: BroadcastCb }> = [];
  removed = false;
  constructor(
    public topic: string,
    public params: unknown
  ) {}
  on(type: string, filter: { event: string }, cb: BroadcastCb) {
    this.handlers.push({ type, filter, cb });
    return this;
  }
  subscribe(cb: SubscribeCb) {
    this.subscribeCb = cb;
    return this;
  }
  /** Lo que haría el server. */
  emitStatus(status: SubStatus) {
    this.subscribeCb?.(status);
  }
  broadcast(payload: unknown) {
    for (const h of this.handlers) {
      if (h.type === "broadcast" && h.filter.event === REALTIME_EVENT) {
        h.cb({ type: "broadcast", event: REALTIME_EVENT, payload });
      }
    }
  }
}

function makeRealtimeFake() {
  const reg = {
    instances: [] as FakeClient[],
    channels: [] as FakeChannel[],
    setAuthCalls: [] as Array<string | null | undefined>,
    removeCalls: 0,
    disconnectCalls: 0,
    ctorArgs: [] as Array<{ endpoint: string; options: { params?: Record<string, string>; accessToken?: () => Promise<string | null> } }>,
  };
  class FakeClient {
    constructor(endpoint: string, options: { params?: Record<string, string>; accessToken?: () => Promise<string | null> }) {
      reg.ctorArgs.push({ endpoint, options });
      reg.instances.push(this);
    }
    channel(topic: string, params?: unknown) {
      const ch = new FakeChannel(topic, params);
      reg.channels.push(ch);
      return ch;
    }
    async setAuth(token?: string | null) {
      reg.setAuthCalls.push(token);
    }
    async removeChannel(ch: FakeChannel) {
      reg.removeCalls++;
      ch.removed = true;
      // El SDK real dispara CLOSED en el callback del canal que se saca: el driver
      // tiene que ignorarlo (si no, entraría en un loop de reconexión).
      ch.subscribeCb?.("CLOSED");
      return "ok" as const;
    }
    async disconnect() {
      reg.disconnectCalls++;
      return "ok" as const;
    }
  }
  return { reg, FakeClient };
}

function makeTokenFake() {
  const t = {
    calls: 0,
    fail: false,
    ttlMs: 600_000,
    getToken: async () => {
      t.calls++;
      if (t.fail) return null;
      return { token: `tok-${t.calls}`, expiresAt: new Date(Date.now() + t.ttlMs).toISOString() };
    },
  };
  return t;
}

function trackStatus(driver: { onStatus(cb: (s: DriverStatus, info?: StatusInfo) => void): () => void }) {
  const log: Array<{ s: DriverStatus; info?: StatusInfo }> = [];
  driver.onStatus((s, info) => log.push({ s, info }));
  return log;
}

// Los drivers loguean con console.warn en dev (payload inválido, caídas): se
// silencia para que la salida del test sea legible; no se afirma sobre el log.
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("createSupabaseDriver", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  function setup() {
    const rt = makeRealtimeFake();
    const tok = makeTokenFake();
    const driver = createSupabaseDriver({
      url: "https://proj.supabase.co",
      anonKey: "sb_publishable_test",
      tenantId: TENANT,
      getToken: tok.getToken,
      deps: { RealtimeClient: rt.FakeClient, random: () => 0 },
    });
    const status = trackStatus(driver);
    const batches: RealtimeAgendaMessage[][] = [];
    driver.onMessage((b) => batches.push(b));
    return { rt, tok, driver, status, batches };
  }

  it("conecta al canal privado del consultorio, sin eco, con el token recién pedido", async () => {
    const { rt, tok, driver, status } = setup();
    await driver.connect();
    await settle();

    expect(rt.reg.ctorArgs).toHaveLength(1);
    expect(rt.reg.ctorArgs[0].endpoint).toBe("https://proj.supabase.co/realtime/v1");
    expect(rt.reg.ctorArgs[0].options.params).toEqual({ apikey: "sb_publishable_test" });
    expect(typeof rt.reg.ctorArgs[0].options.accessToken).toBe("function");

    expect(tok.calls).toBe(1);
    expect(rt.reg.setAuthCalls).toEqual(["tok-1"]);
    // El callback accessToken del SDK devuelve el token vigente, sin pedir otro.
    await expect(rt.reg.ctorArgs[0].options.accessToken!()).resolves.toBe("tok-1");
    expect(tok.calls).toBe(1);

    expect(rt.reg.channels).toHaveLength(1);
    const ch = rt.reg.channels[0];
    expect(ch.topic).toBe(topicFor(TENANT));
    expect(ch.params).toEqual({ config: { private: true, broadcast: { self: false } } });
    expect(ch.handlers.map((h) => [h.type, h.filter.event])).toEqual([["broadcast", REALTIME_EVENT]]);

    expect(status.map((x) => x.s)).toEqual(["connecting"]);
    ch.emitStatus("SUBSCRIBED");
    expect(status.at(-1)).toEqual({ s: "live", info: { failures: 0, reconnected: false } });
  });

  it("entrega los mensajes válidos de a uno y descarta lo inválido sin tirar", async () => {
    const { rt, driver, batches } = setup();
    await driver.connect();
    await settle();
    const ch = rt.reg.channels[0];
    ch.emitStatus("SUBSCRIBED");
    ch.broadcast(msg(1));
    expect(() => ch.broadcast({ v: 1, kind: "booking", nombre: "María" })).not.toThrow();
    expect(() => ch.broadcast(undefined)).not.toThrow();
    ch.broadcast(msg(2));
    expect(batches).toEqual([[msg(1)], [msg(2)]]);
  });

  it("refresca el token al 80 % del TTL con setAuth(nuevo) y reprograma", async () => {
    const { rt, tok, driver } = setup();
    await driver.connect();
    await settle();
    rt.reg.channels[0].emitStatus("SUBSCRIBED");
    expect(tok.calls).toBe(1);

    vi.advanceTimersByTime(479_999);
    await settle();
    expect(tok.calls).toBe(1);
    vi.advanceTimersByTime(1);
    await settle();
    expect(tok.calls).toBe(2);
    expect(rt.reg.setAuthCalls).toEqual(["tok-1", "tok-2"]);
    // El refresh no recrea el canal.
    expect(rt.reg.channels).toHaveLength(1);

    vi.advanceTimersByTime(480_000);
    await settle();
    expect(tok.calls).toBe(3);
    expect(rt.reg.setAuthCalls.at(-1)).toBe("tok-3");
  });

  it("un refresh fallido conserva el token y reintenta en 30 s", async () => {
    const { rt, tok, driver } = setup();
    await driver.connect();
    await settle();
    rt.reg.channels[0].emitStatus("SUBSCRIBED");
    tok.fail = true;
    vi.advanceTimersByTime(480_000);
    await settle();
    expect(tok.calls).toBe(2);
    expect(rt.reg.setAuthCalls).toEqual(["tok-1"]);
    tok.fail = false;
    vi.advanceTimersByTime(30_000);
    await settle();
    expect(tok.calls).toBe(3);
    expect(rt.reg.setAuthCalls).toEqual(["tok-1", "tok-3"]);
  });

  it("CHANNEL_ERROR → reconnecting, saca el canal, y tras el backoff re-mintea y resubscribe", async () => {
    const { rt, tok, driver, status } = setup();
    await driver.connect();
    await settle();
    const first = rt.reg.channels[0];
    first.emitStatus("SUBSCRIBED");

    first.emitStatus("CHANNEL_ERROR");
    await settle();
    expect(status.at(-1)).toEqual({ s: "reconnecting", info: { failures: 1, reconnected: false } });
    expect(first.removed).toBe(true);
    // El CLOSED que dispara removeChannel no cuenta como otra caída.
    expect(status.filter((x) => x.s === "reconnecting")).toHaveLength(1);

    vi.advanceTimersByTime(999);
    await settle();
    expect(tok.calls).toBe(1);
    expect(rt.reg.channels).toHaveLength(1);

    vi.advanceTimersByTime(1);
    await settle();
    expect(tok.calls).toBe(2);
    expect(rt.reg.setAuthCalls.at(-1)).toBe("tok-2");
    expect(rt.reg.channels).toHaveLength(2);
    expect(rt.reg.channels[1].topic).toBe(topicFor(TENANT));
    // Un solo cliente: se reusa el socket.
    expect(rt.reg.instances).toHaveLength(1);

    // SUBSCRIBED después de la caída → aviso de reconexión (el provider hace resync).
    rt.reg.channels[1].emitStatus("SUBSCRIBED");
    expect(status.at(-1)).toEqual({ s: "live", info: { failures: 0, reconnected: true } });

    // Y una suscripción normal posterior ya no viene marcada como reconexión.
    rt.reg.channels[1].emitStatus("TIMED_OUT");
    await settle();
    vi.advanceTimersByTime(1_000);
    await settle();
    rt.reg.channels[2].emitStatus("SUBSCRIBED");
    expect(status.at(-1)?.info?.reconnected).toBe(true);
  });

  it("fallos seguidos escalan el backoff (1 s, 2 s, 4 s) y cuentan los fallos", async () => {
    const { rt, driver, status } = setup();
    await driver.connect();
    await settle();
    rt.reg.channels[0].emitStatus("CHANNEL_ERROR");
    await settle();
    vi.advanceTimersByTime(1_000);
    await settle();
    expect(rt.reg.channels).toHaveLength(2);

    rt.reg.channels[1].emitStatus("TIMED_OUT");
    await settle();
    vi.advanceTimersByTime(1_999);
    await settle();
    expect(rt.reg.channels).toHaveLength(2);
    vi.advanceTimersByTime(1);
    await settle();
    expect(rt.reg.channels).toHaveLength(3);

    rt.reg.channels[2].emitStatus("CLOSED");
    await settle();
    const failures = status.filter((x) => x.s === "reconnecting").map((x) => x.info?.failures);
    expect(failures).toEqual([1, 2, 3]);
    vi.advanceTimersByTime(3_999);
    await settle();
    expect(rt.reg.channels).toHaveLength(3);
    vi.advanceTimersByTime(1);
    await settle();
    expect(rt.reg.channels).toHaveLength(4);
  });

  it("sin token (mint rechazado) → reconnecting con backoff, sin abrir canal", async () => {
    const { rt, tok, driver, status } = setup();
    tok.fail = true;
    await driver.connect();
    await settle();
    expect(rt.reg.channels).toHaveLength(0);
    expect(status.at(-1)).toEqual({ s: "reconnecting", info: { failures: 1, reconnected: false } });
    tok.fail = false;
    vi.advanceTimersByTime(1_000);
    await settle();
    expect(rt.reg.channels).toHaveLength(1);
    rt.reg.channels[0].emitStatus("SUBSCRIBED");
    expect(status.at(-1)).toEqual({ s: "live", info: { failures: 0, reconnected: true } });
  });

  it("getToken que tira tampoco se propaga", async () => {
    const rt = makeRealtimeFake();
    let calls = 0;
    const driver = createSupabaseDriver({
      url: "https://proj.supabase.co",
      anonKey: "k",
      tenantId: TENANT,
      getToken: async () => {
        calls++;
        throw new Error("network");
      },
      deps: { RealtimeClient: rt.FakeClient, random: () => 0 },
    });
    const status = trackStatus(driver);
    await expect(driver.connect()).resolves.toBeUndefined();
    await settle();
    expect(calls).toBe(1);
    expect(status.at(-1)?.s).toBe("reconnecting");
    driver.close();
  });

  it("nudge('online'|'visible') reintenta ya si no está live; con live no hace nada", async () => {
    const { rt, tok, driver } = setup();
    await driver.connect();
    await settle();
    rt.reg.channels[0].emitStatus("SUBSCRIBED");
    driver.nudge("visible");
    await settle();
    expect(rt.reg.channels).toHaveLength(1);
    expect(tok.calls).toBe(1);

    rt.reg.channels[0].emitStatus("CHANNEL_ERROR");
    await settle();
    driver.nudge("online");
    await settle();
    expect(rt.reg.channels).toHaveLength(2);
    expect(tok.calls).toBe(2);
    // El reintento programado quedó cancelado: no abre un tercer canal.
    vi.advanceTimersByTime(60_000);
    await settle();
    expect(rt.reg.channels).toHaveLength(2);
  });

  it("nudge('visible') con live y el refresh atrasado (pestaña dormida) renueva el token ya", async () => {
    const { rt, tok, driver } = setup();
    await driver.connect();
    await settle();
    rt.reg.channels[0].emitStatus("SUBSCRIBED");
    // Simula timers congelados de una pestaña en segundo plano: el reloj avanza sin
    // que corra el setTimeout del refresh.
    vi.setSystemTime(NOW + 500_000);
    driver.nudge("visible");
    await settle();
    expect(tok.calls).toBe(2);
    expect(rt.reg.setAuthCalls.at(-1)).toBe("tok-2");
  });

  it("close() limpia timers, canal y socket; después no reconecta ni entrega", async () => {
    const { rt, tok, driver, status, batches } = setup();
    await driver.connect();
    await settle();
    const ch = rt.reg.channels[0];
    ch.emitStatus("SUBSCRIBED");
    driver.close();
    await settle();
    expect(ch.removed).toBe(true);
    expect(rt.reg.disconnectCalls).toBe(1);
    expect(status.at(-1)?.s).toBe("off");

    ch.broadcast(msg(1));
    ch.emitStatus("CHANNEL_ERROR");
    vi.advanceTimersByTime(10 * 60_000);
    await settle();
    expect(batches).toEqual([]);
    expect(tok.calls).toBe(1);
    expect(rt.reg.channels).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("close() en medio del connect (antes de que llegue el token) no abre nada", async () => {
    const rt = makeRealtimeFake();
    let resolveToken: (v: { token: string; expiresAt: string }) => void = () => {};
    const driver = createSupabaseDriver({
      url: "https://proj.supabase.co",
      anonKey: "k",
      tenantId: TENANT,
      getToken: () => new Promise((r) => (resolveToken = r)),
      deps: { RealtimeClient: rt.FakeClient, random: () => 0 },
    });
    const p = driver.connect();
    await settle();
    driver.close();
    resolveToken({ token: "t", expiresAt: new Date(NOW + 600_000).toISOString() });
    await p;
    await settle();
    expect(rt.reg.channels).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("connect() dos veces no duplica cliente ni canal", async () => {
    const { rt, driver } = setup();
    await driver.connect();
    await driver.connect();
    await settle();
    expect(rt.reg.instances).toHaveLength(1);
    expect(rt.reg.channels).toHaveLength(1);
  });

  it("un listener que tira no rompe al driver ni a los demás listeners", async () => {
    const { rt, driver, batches } = setup();
    driver.onMessage(() => {
      throw new Error("consumer roto");
    });
    const late: RealtimeAgendaMessage[][] = [];
    driver.onMessage((b) => late.push(b));
    await driver.connect();
    await settle();
    rt.reg.channels[0].emitStatus("SUBSCRIBED");
    expect(() => rt.reg.channels[0].broadcast(msg(1))).not.toThrow();
    expect(batches).toHaveLength(1);
    expect(late).toHaveLength(1);
  });

  it("onMessage/onStatus devuelven la baja", async () => {
    const { rt, driver } = setup();
    const got: RealtimeAgendaMessage[][] = [];
    const off = driver.onMessage((b) => got.push(b));
    await driver.connect();
    await settle();
    off();
    rt.reg.channels[0].broadcast(msg(1));
    expect(got).toEqual([]);
  });

  it("los logs de dev nunca llevan el token", async () => {
    const warn = vi.mocked(console.warn);
    const { rt, tok, driver } = setup();
    await driver.connect();
    await settle();
    rt.reg.channels[0].emitStatus("SUBSCRIBED");
    rt.reg.channels[0].broadcast({ basura: true });
    rt.reg.channels[0].emitStatus("CHANNEL_ERROR");
    await settle();
    tok.fail = true;
    vi.advanceTimersByTime(1_000);
    await settle();
    driver.close();
    expect(warn.mock.calls.length).toBeGreaterThan(0);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/tok-\d/);
  });

  it("el driver no tiene ninguna forma de publicar", () => {
    const { driver } = setup();
    expect(Object.keys(driver).sort()).toEqual(["close", "connect", "nudge", "onMessage", "onStatus"]);
    for (const k of ["send", "publish", "broadcast", "track", "httpSend"]) {
      expect(k in driver).toBe(false);
    }
  });

  it("realtime-js entra solo por import() dinámico (el first-load no lo carga)", () => {
    const src = readFileSync(resolve(process.cwd(), "lib/realtime-client-supabase.ts"), "utf8");
    expect(src).not.toMatch(/^\s*import\s[^;(]*from\s+["']@supabase\/realtime-js["']/m);
    expect(src).toMatch(/await import\(\s*["']@supabase\/realtime-js["']\s*\)/);
  });

  it("el módulo real exporta RealtimeClient (lo que el driver busca en el import dinámico)", async () => {
    const mod = await import("@supabase/realtime-js");
    expect(typeof mod.RealtimeClient).toBe("function");
  });
});

// ─── Fake de EventSource ──────────────────────────────────────────────────────

function makeEventSourceFake() {
  const reg = { instances: [] as FakeES[] };
  class FakeES {
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    closed = false;
    constructor(public url: string) {
      reg.instances.push(this);
    }
    close() {
      this.closed = true;
    }
    open() {
      this.onopen?.({});
    }
    send(data: unknown) {
      this.onmessage?.({ data });
    }
    error() {
      this.onerror?.({});
    }
  }
  return { reg, FakeES };
}

describe("createLocalDriver", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  function setup() {
    const es = makeEventSourceFake();
    const driver = createLocalDriver({ deps: { EventSource: es.FakeES, random: () => 0 } });
    const status = trackStatus(driver);
    const batches: RealtimeAgendaMessage[][] = [];
    driver.onMessage((b) => batches.push(b));
    return { es, driver, status, batches };
  }

  it("abre /api/realtime/local, onopen → live y entrega el lote del evento", async () => {
    const { es, driver, status, batches } = setup();
    await driver.connect();
    expect(es.reg.instances).toHaveLength(1);
    expect(es.reg.instances[0].url).toBe("/api/realtime/local");
    expect(status.map((x) => x.s)).toEqual(["connecting"]);
    es.reg.instances[0].open();
    expect(status.at(-1)).toEqual({ s: "live", info: { failures: 0, reconnected: false } });

    es.reg.instances[0].send(JSON.stringify([msg(1), msg(2)]));
    es.reg.instances[0].send(JSON.stringify([{ basura: true }]));
    es.reg.instances[0].send("{roto");
    expect(batches).toEqual([[msg(1), msg(2)]]);
  });

  it("onerror → cierra, reconnecting y recrea tras el backoff; onopen avisa la reconexión", async () => {
    const { es, driver, status, batches } = setup();
    await driver.connect();
    const first = es.reg.instances[0];
    first.open();
    first.error();
    expect(first.closed).toBe(true);
    expect(status.at(-1)).toEqual({ s: "reconnecting", info: { failures: 1, reconnected: false } });

    vi.advanceTimersByTime(999);
    expect(es.reg.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(es.reg.instances).toHaveLength(2);

    // El EventSource viejo ya no entrega nada aunque el browser dispare algo tarde.
    first.send(JSON.stringify([msg(9)]));
    first.error();
    expect(status.filter((x) => x.s === "reconnecting")).toHaveLength(1);

    const second = es.reg.instances[1];
    second.error();
    vi.advanceTimersByTime(2_000);
    expect(es.reg.instances).toHaveLength(3);
    es.reg.instances[2].open();
    expect(status.at(-1)).toEqual({ s: "live", info: { failures: 0, reconnected: true } });
    es.reg.instances[2].send(JSON.stringify([msg(3)]));
    expect(batches).toEqual([[msg(3)]]);
  });

  it("endpoint configurable; nudge reintenta ya; close() limpia", async () => {
    const es = makeEventSourceFake();
    const driver = createLocalDriver({ endpoint: "/x", deps: { EventSource: es.FakeES, random: () => 0 } });
    const status = trackStatus(driver);
    await driver.connect();
    expect(es.reg.instances[0].url).toBe("/x");
    es.reg.instances[0].error();
    driver.nudge("online");
    expect(es.reg.instances).toHaveLength(2);
    vi.advanceTimersByTime(60_000);
    expect(es.reg.instances).toHaveLength(2);

    driver.close();
    expect(es.reg.instances[1].closed).toBe(true);
    expect(status.at(-1)?.s).toBe("off");
    expect(vi.getTimerCount()).toBe(0);
    es.reg.instances[1].error();
    vi.advanceTimersByTime(60_000);
    expect(es.reg.instances).toHaveLength(2);
  });

  it("sin EventSource en el entorno → off, sin tirar", async () => {
    const driver = createLocalDriver({ deps: { EventSource: undefined } });
    const status = trackStatus(driver);
    const g = globalThis as { EventSource?: unknown };
    const saved = g.EventSource;
    delete g.EventSource;
    try {
      await expect(driver.connect()).resolves.toBeUndefined();
    } finally {
      if (saved !== undefined) g.EventSource = saved;
    }
    expect(status.at(-1)?.s).toBe("off");
  });

  it("el driver local tampoco publica", () => {
    const { driver } = setup();
    expect(Object.keys(driver).sort()).toEqual(["close", "connect", "nudge", "onMessage", "onStatus"]);
  });
});
