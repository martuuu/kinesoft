/**
 * A3a-S-rl — rate-limit endurecido. Corre el `rateLimit` real; se mockean
 * solo la red (`fetch`), el env (Upstash on/off, VERCEL_ENV) y el logger
 * (para afirmar que el fallback deja rastro).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const envMock = vi.hoisted(() => ({
  UPSTASH_REDIS_REST_URL: undefined as string | undefined,
  UPSTASH_REDIS_REST_TOKEN: undefined as string | undefined,
  VERCEL_ENV: undefined as string | undefined,
}));
const warn = vi.hoisted(() => vi.fn());

vi.mock("@/lib/env", () => ({ env: envMock }));
vi.mock("@/lib/logger", () => ({ logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import {
  rateLimit,
  rateLimitAll,
  hashKeyPart,
  rateLimitedMessage,
  MEMORY_MAX_KEYS,
  UPSTASH_TIMEOUT_MS,
  __rateLimitInternals,
} from "@/lib/rate-limit";
import { clientIp } from "@/lib/client-ip";

const W = { limit: 2, windowMs: 60_000 };

function upstashOn() {
  envMock.UPSTASH_REDIS_REST_URL = "https://upstash.test";
  envMock.UPSTASH_REDIS_REST_TOKEN = "tok";
}

function okPipeline(count: number, ttl = 30_000) {
  return new Response(JSON.stringify([{ result: count }, { result: 1 }, { result: ttl }]), {
    status: 200,
  });
}

beforeEach(() => {
  __rateLimitInternals.reset();
  envMock.UPSTASH_REDIS_REST_URL = undefined;
  envMock.UPSTASH_REDIS_REST_TOKEN = undefined;
  envMock.VERCEL_ENV = undefined;
  warn.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("memoria", () => {
  it("cuenta por ventana y devuelve retryAfter", async () => {
    expect((await rateLimit("a", W)).ok).toBe(true);
    expect((await rateLimit("a", W)).ok).toBe(true);
    const third = await rateLimit("a", W);
    expect(third.ok).toBe(false);
    expect(third.retryAfterMs).toBeGreaterThan(0);
    expect(third.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it("la ventana vence y se reabre", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T12:00:00Z"));
    await rateLimit("b", W);
    await rateLimit("b", W);
    expect((await rateLimit("b", W)).ok).toBe(false);
    vi.setSystemTime(new Date("2026-09-30T12:01:01Z"));
    expect((await rateLimit("b", W)).ok).toBe(true);
  });

  it("purga: el Map no pasa del tope y las vencidas se barren", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T12:00:00Z"));
    for (let i = 0; i < MEMORY_MAX_KEYS + 50; i++) {
      await rateLimit(`flood:${i}`, { limit: 1, windowMs: 1_000 });
    }
    expect(__rateLimitInternals.size()).toBeLessThanOrEqual(MEMORY_MAX_KEYS);
    // Todo vencido: la próxima llamada con el Map lleno barre las vencidas.
    vi.setSystemTime(new Date("2026-09-30T12:00:05Z"));
    for (let i = 0; i < 600; i++) await rateLimit(`fresh:${i}`, { limit: 1, windowMs: 60_000 });
    expect(__rateLimitInternals.size()).toBeLessThanOrEqual(600);
  });
});

describe("rateLimitAll (claves compuestas)", () => {
  it("pasa solo si todas pasan y devuelve el retryAfter máximo", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T12:00:00Z"));
    const checks = [
      { key: "actor:u1", limit: 10, windowMs: 3_600_000 },
      { key: "to:h1", limit: 1, windowMs: 600_000 },
    ];
    expect((await rateLimitAll(checks)).ok).toBe(true);
    const second = await rateLimitAll(checks);
    expect(second.ok).toBe(false);
    expect(second.retryAfterMs).toBe(600_000);
    // Otro destinatario con el mismo actor sigue pasando.
    const other = await rateLimitAll([checks[0], { ...checks[1], key: "to:h2" }]);
    expect(other.ok).toBe(true);
    expect(other.remaining).toBe(0);
  });

  it("toma el máximo cuando fallan varias", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T12:00:00Z"));
    const checks = [
      { key: "x", limit: 0, windowMs: 10_000 },
      { key: "y", limit: 0, windowMs: 90_000 },
    ];
    const r = await rateLimitAll(checks);
    expect(r.ok).toBe(false);
    expect(r.retryAfterMs).toBe(90_000);
  });
});

describe("Upstash", () => {
  it("usa el pipeline con prefijo por entorno y timeout", async () => {
    upstashOn();
    envMock.VERCEL_ENV = "preview";
    const fetchMock = vi.fn().mockResolvedValue(okPipeline(3, 12_000));
    vi.stubGlobal("fetch", fetchMock);
    const r = await rateLimit("login:ip:1.2.3.4", W);
    expect(r).toEqual({ ok: false, remaining: 0, retryAfterMs: 12_000 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://upstash.test/pipeline");
    const body = JSON.parse(init.body);
    expect(body[0]).toEqual(["INCR", "rl:preview:login:ip:1.2.3.4"]);
    expect(body[1]).toEqual(["PEXPIRE", "rl:preview:login:ip:1.2.3.4", "60000", "NX"]);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("sin VERCEL_ENV el prefijo es dev", async () => {
    upstashOn();
    const fetchMock = vi.fn().mockResolvedValue(okPipeline(1));
    vi.stubGlobal("fetch", fetchMock);
    expect((await rateLimit("k", W)).ok).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)[0][1]).toBe("rl:dev:k");
  });

  it("error de red → fallback a memoria con log (no tira)", async () => {
    upstashOn();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    expect((await rateLimit("net", W)).ok).toBe(true);
    expect((await rateLimit("net", W)).ok).toBe(true);
    // El fallback cuenta de verdad: el tercero se corta en memoria.
    expect((await rateLimit("net", W)).ok).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      "rate_limit.upstash_fallback",
      expect.objectContaining({ reason: "network" })
    );
    // Log throttleado: una línea, no una por request.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("timeout → fallback", async () => {
    upstashOn();
    // Simula el fetch respetando la señal: se rechaza cuando AbortSignal.timeout dispara.
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
        });
      })
    );
    const started = Date.now();
    const r = await rateLimit("slow", W);
    expect(r.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(UPSTASH_TIMEOUT_MS + 1000);
    expect(warn).toHaveBeenCalledWith(
      "rate_limit.upstash_fallback",
      expect.objectContaining({ reason: "timeout" })
    );
  });

  it("HTTP no-OK → fallback", async () => {
    upstashOn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 500 })));
    expect((await rateLimit("h", W)).ok).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      "rate_limit.upstash_fallback",
      expect.objectContaining({ reason: "http" })
    );
  });

  it.each([
    ["no es array", { error: "WRONGPASS" }],
    ["largo incorrecto", [{ result: 1 }]],
    ["comando con error", [{ error: "ERR" }, { result: 1 }, { result: 1000 }]],
    ["count no numérico", [{ result: "5" }, { result: 1 }, { result: 1000 }]],
    ["count 0", [{ result: 0 }, { result: 1 }, { result: 1000 }]],
  ])("respuesta inválida (%s) → fallback, nunca 'pasa siempre'", async (_n, payload) => {
    upstashOn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => new Response(JSON.stringify(payload), { status: 200 }))
    );
    // Si la respuesta inválida se leyera como count 0, las 3 pasarían.
    await rateLimit("inv", W);
    await rateLimit("inv", W);
    expect((await rateLimit("inv", W)).ok).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it("PTTL negativo no da retryAfter negativo", async () => {
    upstashOn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okPipeline(9, -1)));
    const r = await rateLimit("neg", W);
    expect(r.ok).toBe(false);
    expect(r.retryAfterMs).toBe(W.windowMs);
  });
});

describe("helpers", () => {
  it("hashKeyPart normaliza y no deja el email en claro", () => {
    const h = hashKeyPart(" Ana@Mail.com ");
    expect(h).toBe(hashKeyPart("ana@mail.com"));
    expect(h).toMatch(/^[0-9a-f]{32}$/);
    expect(h).not.toContain("ana");
  });

  it("rateLimitedMessage redondea hacia arriba a segundos", () => {
    expect(rateLimitedMessage(1)).toBe("Demasiados intentos. Probá de nuevo en 1 s.");
    expect(rateLimitedMessage(59_001)).toBe("Demasiados intentos. Probá de nuevo en 60 s.");
  });

  it("clientIp: primera entrada de XFF, x-real-ip, basura → fallback", () => {
    const h = (o: Record<string, string>) => new Headers(o);
    expect(clientIp(h({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" }))).toBe("1.2.3.4");
    expect(clientIp(h({ "x-forwarded-for": "2001:db8::1" }))).toBe("2001:db8::1");
    expect(clientIp(h({ "x-real-ip": "5.6.7.8" }))).toBe("5.6.7.8");
    expect(clientIp(h({ "x-forwarded-for": "<script>" }))).toBe("unknown");
    expect(clientIp(h({}))).toBe("unknown");
    expect(clientIp(h({}), null)).toBeNull();
  });
});
