/**
 * SV04a · publisher realtime (C-SV4). Corre el `publishBookingChanges` /
 * `publishAvailability` reales; se mockean solo la red (`fetch` fake inyectado),
 * el env (driver, URL, service key) y el logger (para afirmar qué deja en el log).
 *
 * Contrato (§18.2/§18.8): `off` no hace nada; `supabase` hace UN POST por
 * commit con topic privado; timeout de 1,5 s; breaker 3 fallos → 30 s sin POST;
 * nunca tira; el log jamás lleva la service key; `local` emite al bus del tenant.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SERVICE_KEY = "sb_secret_TESTKEY_abcdefghijklmnopqrstuvwxyz0123";
const URL_BASE = "https://proj.supabase.test";

const envMock = vi.hoisted(() => ({
  REALTIME_DRIVER: "off" as "off" | "local" | "supabase",
  NEXT_PUBLIC_SUPABASE_URL: undefined as string | undefined,
  SUPABASE_SERVICE_ROLE_KEY: undefined as string | undefined,
  // Para el logger real del describe de redacción.
  LOG_LEVEL: "debug" as const,
  NODE_ENV: "production" as const,
}));
// Registro a mano (no vi.fn que pueda tirar a través del mock; vitest 2.1.9).
const warns = vi.hoisted(() => [] as Array<{ msg: string; ctx: unknown }>);

vi.mock("@/lib/env", () => ({ env: envMock }));
vi.mock("@/lib/logger", () => ({
  logger: {
    warn: (msg: string, ctx: unknown) => void warns.push({ msg, ctx }),
    info: () => {},
    error: () => {},
    debug: () => {},
  },
}));

import type { BookingChangeRef } from "@/lib/booking-events-internal";
import { MAX_MESSAGES_PER_POST, REALTIME_PUBLISH_TIMEOUT_MS, topicFor } from "@/lib/realtime-constants";
import { RealtimeAgendaMessageSchema } from "@/lib/realtime-events-schema";
import { listenerCount, subscribe } from "@/lib/realtime-local-bus";
import {
  BREAKER,
  __realtimePublisherInternals as internals,
  publishAvailability,
  publishBookingChanges,
} from "@/lib/realtime-publisher-internal";
import { makeFetchFake } from "@/tests/helpers/fetch-fake";

function refs(n: number, practitioners = 1): BookingChangeRef[] {
  return Array.from({ length: n }, (_, i) => ({
    bookingId: `b${i}`,
    practitionerId: `p${i % practitioners}`,
    // Un día distinto por turno: fuerza el colapso más allá de (profesional, día).
    scheduledFor: new Date(Date.UTC(2026, 9, 1 + (i % 28), 13, 0)),
    roomId: null,
  }));
}

function supabaseOn() {
  envMock.REALTIME_DRIVER = "supabase";
  envMock.NEXT_PUBLIC_SUPABASE_URL = URL_BASE;
  envMock.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
}

type PostBody = { messages: Array<{ topic: string; event: string; payload: unknown; private: boolean }> };

beforeEach(() => {
  internals.reset();
  warns.length = 0;
  envMock.REALTIME_DRIVER = "off";
  envMock.NEXT_PUBLIC_SUPABASE_URL = undefined;
  envMock.SUPABASE_SERVICE_ROLE_KEY = undefined;
});
afterEach(() => {
  vi.useRealTimers();
  internals.reset();
});

describe("driver off", () => {
  it("no hace ningún fetch y devuelve reason off", async () => {
    const f = makeFetchFake();
    internals.setFetch(f.fetch);
    // Aunque la config esté completa: off manda.
    envMock.NEXT_PUBLIC_SUPABASE_URL = URL_BASE;
    envMock.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
    expect(await publishBookingChanges("t1", refs(1))).toEqual({ ok: false, reason: "off" });
    expect(await publishAvailability("t1", { practitionerId: null, day: "2026-10-13" })).toEqual({
      ok: false,
      reason: "off",
    });
    expect(f.calls).toHaveLength(0);
    expect(warns).toHaveLength(0);
  });
});

describe("driver supabase", () => {
  beforeEach(supabaseOn);

  it("1 POST a la REST de Broadcast con headers, topic privado y evento", async () => {
    const f = makeFetchFake({ status: 202 });
    internals.setFetch(f.fetch);
    const r = await publishBookingChanges("t1", refs(1));
    expect(r).toEqual({ ok: true, messages: 1 });
    expect(f.calls).toHaveLength(1);
    const call = f.calls[0];
    expect(call.url).toBe(`${URL_BASE}/realtime/v1/api/broadcast`);
    expect(call.init.method).toBe("POST");
    expect(call.headers.apikey).toBe(SERVICE_KEY);
    expect(call.headers.authorization).toBe(`Bearer ${SERVICE_KEY}`);
    expect(call.headers["content-type"]).toBe("application/json");
    const body = call.body as PostBody;
    expect(body.messages).toHaveLength(1);
    const m = body.messages[0];
    expect(m).toMatchObject({ topic: topicFor("t1"), event: "agenda", private: true });
    expect(Object.keys(m).sort()).toEqual(["event", "payload", "private", "topic"]);
    // El payload pasa el schema estricto (sin PHI ni claves extra).
    expect(RealtimeAgendaMessageSchema.safeParse(m.payload).success).toBe(true);
    expect(m.payload).toMatchObject({ kind: "booking", bookingId: "b0", practitionerId: "p0", day: "2026-10-01" });
  });

  it("URL con barra final no duplica la barra", async () => {
    envMock.NEXT_PUBLIC_SUPABASE_URL = `${URL_BASE}/`;
    const f = makeFetchFake();
    internals.setFetch(f.fetch);
    await publishBookingChanges("t1", refs(1));
    expect(f.calls[0].url).toBe(`${URL_BASE}/realtime/v1/api/broadcast`);
  });

  it("20 refs → 1 POST con 20 mensajes", async () => {
    const f = makeFetchFake();
    internals.setFetch(f.fetch);
    const r = await publishBookingChanges("t1", refs(20, 5));
    expect(r).toEqual({ ok: true, messages: 20 });
    expect(f.calls).toHaveLength(1);
    expect((f.calls[0].body as PostBody).messages).toHaveLength(20);
  });

  it("60 refs de 25 profesionales → 1 POST colapsado (≤ 20, sin bookingId)", async () => {
    const f = makeFetchFake();
    internals.setFetch(f.fetch);
    const r = await publishBookingChanges("t1", refs(60, 25));
    expect(f.calls).toHaveLength(1);
    const msgs = (f.calls[0].body as PostBody).messages;
    expect(msgs.length).toBeLessThanOrEqual(MAX_MESSAGES_PER_POST);
    expect(r).toEqual({ ok: true, messages: msgs.length });
    for (const m of msgs) {
      expect(m.topic).toBe(topicFor("t1"));
      expect(m.payload).not.toHaveProperty("bookingId");
    }
  });

  it("refs vacío → ok sin fetch", async () => {
    const f = makeFetchFake();
    internals.setFetch(f.fetch);
    expect(await publishBookingChanges("t1", [])).toEqual({ ok: true, messages: 0 });
    expect(f.calls).toHaveLength(0);
  });

  it("availability → 1 POST con 1 mensaje availability", async () => {
    const f = makeFetchFake();
    internals.setFetch(f.fetch);
    const r = await publishAvailability("t1", { practitionerId: "p1", day: "2026-10-13" });
    expect(r).toEqual({ ok: true, messages: 1 });
    const msgs = (f.calls[0].body as PostBody).messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].payload).toMatchObject({ kind: "availability", practitionerId: "p1", day: "2026-10-13" });
  });

  it("[FX1b] availability con day null → 1 POST con day null", async () => {
    const f = makeFetchFake();
    internals.setFetch(f.fetch);
    expect(await publishAvailability("t1", { practitionerId: null, day: null })).toEqual({ ok: true, messages: 1 });
    expect(f.calls).toHaveLength(1);
    expect((f.calls[0].body as PostBody).messages[0].payload).toMatchObject({ kind: "availability", day: null });
  });

  it("timeout (fake timers) → resuelve con reason timeout al tope, sin tirar", async () => {
    vi.useFakeTimers();
    const f = makeFetchFake({ delayMs: Infinity });
    internals.setFetch(f.fetch);
    let settled: unknown = "pending";
    const p = publishBookingChanges("t1", refs(1)).then((r) => (settled = r));
    await vi.advanceTimersByTimeAsync(REALTIME_PUBLISH_TIMEOUT_MS - 1);
    expect(settled).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(settled).toEqual({ ok: false, reason: "timeout" });
    expect(warns).toEqual([
      { msg: "realtime.publish_failed", ctx: expect.objectContaining({ tenantId: "t1", refs: 1, reason: "timeout" }) },
    ]);
  });

  it("500 → loguea con status, no tira", async () => {
    internals.setFetch(makeFetchFake({ status: 500 }).fetch);
    await expect(publishBookingChanges("t1", refs(2))).resolves.toEqual({
      ok: false,
      reason: "http",
      status: 500,
    });
    expect(warns).toEqual([
      {
        msg: "realtime.publish_failed",
        ctx: expect.objectContaining({ tenantId: "t1", refs: 2, status: 500, reason: "http" }),
      },
    ]);
  });

  it("fetch que rechaza o que tira sincrónico → reason error, nunca tira", async () => {
    internals.setFetch(makeFetchFake({ rejectWith: new TypeError("fetch failed") }).fetch);
    await expect(publishBookingChanges("t1", refs(1))).resolves.toEqual({ ok: false, reason: "error" });
    internals.setFetch((() => {
      throw new Error("sync boom");
    }) as unknown as typeof fetch);
    await expect(publishAvailability("t1", { practitionerId: null, day: "2026-10-13" })).resolves.toEqual({
      ok: false,
      reason: "error",
    });
  });

  it("el log se limita a una línea por minuto por motivo", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-13T12:00:00Z") });
    internals.setFetch(makeFetchFake({ status: 503 }).fetch);
    await publishBookingChanges("t1", refs(1));
    await publishBookingChanges("t1", refs(1));
    expect(warns).toHaveLength(1);
    // El 3.º fallo abre el breaker: motivo distinto, su propia línea.
    await publishBookingChanges("t1", refs(1));
    await publishBookingChanges("t1", refs(1));
    expect(warns.map((w) => (w.ctx as { reason: string }).reason)).toEqual(["http", "breaker"]);
  });

  it("3 fallos seguidos → breaker abierto 30 s sin fetch; después prueba y un éxito lo cierra", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-13T12:00:00Z") });
    const bad = makeFetchFake({ status: 500 });
    internals.setFetch(bad.fetch);
    for (let i = 0; i < BREAKER.failures; i++) await publishBookingChanges("t1", refs(1));
    expect(bad.calls).toHaveLength(3);

    expect(await publishBookingChanges("t1", refs(1))).toEqual({ ok: false, reason: "breaker" });
    vi.advanceTimersByTime(BREAKER.openMs - 1);
    expect(await publishAvailability("t1", { practitionerId: null, day: "2026-10-13" })).toEqual({
      ok: false,
      reason: "breaker",
    });
    expect(bad.calls).toHaveLength(3);

    vi.advanceTimersByTime(1);
    const good = makeFetchFake({ status: 202 });
    internals.setFetch(good.fetch);
    expect(await publishBookingChanges("t1", refs(1))).toEqual({ ok: true, messages: 1 });
    expect(good.calls).toHaveLength(1);
    expect(internals.breaker()).toEqual({ failures: 0, openUntil: 0 });
  });

  it("vencido el breaker, un fallo más lo vuelve a abrir enseguida (half-open)", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-13T12:00:00Z") });
    const bad = makeFetchFake({ status: 500 });
    internals.setFetch(bad.fetch);
    for (let i = 0; i < 3; i++) await publishBookingChanges("t1", refs(1));
    vi.advanceTimersByTime(BREAKER.openMs);
    await publishBookingChanges("t1", refs(1));
    expect(bad.calls).toHaveLength(4);
    expect(await publishBookingChanges("t1", refs(1))).toEqual({ ok: false, reason: "breaker" });
    expect(bad.calls).toHaveLength(4);
  });

  it.each([
    ["sin URL", "NEXT_PUBLIC_SUPABASE_URL"],
    ["sin service key", "SUPABASE_SERVICE_ROLE_KEY"],
  ] as const)("config incompleta (%s) → reason config, sin fetch, breaker 300 s", async (_n, key) => {
    vi.useFakeTimers({ now: new Date("2026-10-13T12:00:00Z") });
    envMock[key] = undefined;
    const f = makeFetchFake();
    internals.setFetch(f.fetch);
    expect(await publishBookingChanges("t1", refs(1))).toEqual({ ok: false, reason: "config" });
    expect(f.calls).toHaveLength(0);
    expect(internals.breaker().openUntil).toBe(Date.now() + BREAKER.openMsOnConfigError);
    // Arreglada la config, igual espera a que venza (no reintenta en cada action).
    supabaseOn();
    vi.advanceTimersByTime(BREAKER.openMs);
    expect(await publishBookingChanges("t1", refs(1))).toEqual({ ok: false, reason: "breaker" });
    vi.advanceTimersByTime(BREAKER.openMsOnConfigError - BREAKER.openMs);
    expect(await publishBookingChanges("t1", refs(1))).toEqual({ ok: true, messages: 1 });
  });

  it("el log nunca contiene la service key, el Authorization ni el body", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-13T12:00:00Z") });
    // Un error cuyo mensaje trae la key (p. ej. un proxy que la eco-ea).
    internals.setFetch(makeFetchFake({ rejectWith: new Error(`bad apikey ${SERVICE_KEY}`) }).fetch);
    await publishBookingChanges("t1", refs(1));
    vi.advanceTimersByTime(60_000);
    internals.setFetch(makeFetchFake({ status: 401 }).fetch);
    await publishBookingChanges("t1", refs(1));
    vi.advanceTimersByTime(60_000);
    internals.reset(); // cierra el breaker (2 fallos + este = 3) para que el timeout llegue al fetch
    internals.setFetch(makeFetchFake({ delayMs: Infinity }).fetch);
    const p = publishBookingChanges("t1", refs(1));
    await vi.advanceTimersByTimeAsync(REALTIME_PUBLISH_TIMEOUT_MS);
    await p;
    expect(warns.length).toBeGreaterThanOrEqual(3);
    const dump = JSON.stringify(warns);
    expect(dump).not.toContain(SERVICE_KEY);
    expect(dump).not.toContain("Bearer");
    expect(dump).not.toContain("messages");
    expect(dump).not.toContain(topicFor("t1"));
  });
});

describe("driver local", () => {
  it("emite al bus SOLO del tenant y sin fetch; la baja limpia", async () => {
    envMock.REALTIME_DRIVER = "local";
    const f = makeFetchFake();
    internals.setFetch(f.fetch);
    const got: Record<string, unknown[][]> = { t1: [], t2: [] };
    const off1 = subscribe("t1", (m) => got.t1.push(m));
    const off2 = subscribe("t2", (m) => got.t2.push(m));
    // Un listener que tira no corta la entrega ni la action.
    const offBad = subscribe("t1", () => {
      throw new Error("stream cerrado");
    });

    expect(await publishBookingChanges("t1", refs(3))).toEqual({ ok: true, messages: 3 });
    expect(await publishAvailability("t1", { practitionerId: null, day: "2026-10-13" })).toEqual({
      ok: true,
      messages: 1,
    });
    expect(got.t1).toHaveLength(2);
    expect(got.t1[0]).toHaveLength(3);
    expect(got.t1[1]).toEqual([expect.objectContaining({ kind: "availability", practitionerId: null })]);
    expect(got.t2).toHaveLength(0);
    expect(f.calls).toHaveLength(0);

    off1();
    off1(); // idempotente
    offBad();
    off2();
    expect(listenerCount("t1")).toBe(0);
    expect(listenerCount("t2")).toBe(0);
  });

  it("el bus vive en globalThis (sobrevive al HMR)", () => {
    const off = subscribe("t9", () => {});
    expect(globalThis.__kinesoftRealtimeBus?.get("t9")?.size).toBe(1);
    off();
  });
});

describe("logger · redacción de secretos de Supabase (SV04a)", () => {
  it("la línea serializada no lleva sb_secret_/sb_publishable_ ni JWT, a cualquier profundidad", async () => {
    const { logger: realLogger } = await vi.importActual<typeof import("@/lib/logger")>("@/lib/logger");
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.x";
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    try {
      realLogger.warn(`falló con ${SERVICE_KEY}`, {
        detail: { nested: [`key sb_publishable_ABCdef-123_x y ${jwt}`] },
        plain: jwt,
      });
    } finally {
      spy.mockRestore();
    }
    const line = out.join("");
    expect(line).toContain("falló con [token]");
    expect(line).not.toContain("sb_secret_");
    expect(line).not.toContain("sb_publishable_");
    expect(line).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  it("scrubSecrets no toca ids, cuids ni fechas", async () => {
    const { scrubSecrets } = await vi.importActual<typeof import("@/lib/logger")>("@/lib/logger");
    const s = "booking ckx1a2b3c4d5e6f7g8h9 tenant t_sb_1 el 2026-10-13T12:00:00.000Z";
    expect(scrubSecrets(s)).toBe(s);
    expect(scrubSecrets("x sb_secret_abc-DEF_1 y")).toBe("x [token] y");
  });
});
