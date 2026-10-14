/**
 * SV07a · estado puro del cliente realtime (C-SV7, §18.2 «Cliente»).
 *
 * Lo que se cuida: que un ráfaga de cambios (un batch de 20 turnos, la Secretaria
 * marcando varias llegadas) cueste UN refetch y no veinte; que la reconexión no
 * martille a Supabase (backoff con tope de 30 s); que el polling de 60 s solo corra
 * cuando el canal no está; que el token se renueve antes de vencer; y que un
 * payload inválido se descarte sin tirar (el canal no es confiable: es un «tocá acá»).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKOFF_MAX_MS,
  POLL_INTERVAL_MS,
  TOKEN_REFRESH_MIN_MS,
  backoffDelay,
  createCoalescer,
  deriveConnectionState,
  nextPollDelay,
  nextTokenRefreshAt,
  parseIncoming,
  parseIncomingBatch,
  shouldResync,
} from "@/lib/realtime-client-state";
import type { RealtimeAgendaMessage } from "@/lib/realtime-events";

function msg(i: number, over: Partial<RealtimeAgendaMessage> = {}): RealtimeAgendaMessage {
  return {
    v: 1,
    kind: "booking",
    bookingId: `b${i}`,
    practitionerId: "p1",
    day: "2026-10-13",
    at: "2026-10-13T12:00:00.000Z",
    ...over,
  };
}

describe("createCoalescer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("7 mensajes dentro de 250 ms → 1 solo lote con los 7 en orden", () => {
    const batches: RealtimeAgendaMessage[][] = [];
    const c = createCoalescer(250, (b) => batches.push(b));
    for (let i = 0; i < 7; i++) {
      c.push([msg(i)]);
      vi.advanceTimersByTime(30); // 7 × 30 = 210 ms < 250
    }
    expect(batches).toHaveLength(0);
    vi.advanceTimersByTime(40);
    expect(batches).toHaveLength(1);
    expect(batches[0].map((m) => m.bookingId)).toEqual(["b0", "b1", "b2", "b3", "b4", "b5", "b6"]);
  });

  it("mensajes en ventanas distintas → 2 lotes", () => {
    const batches: RealtimeAgendaMessage[][] = [];
    const c = createCoalescer(250, (b) => batches.push(b));
    c.push([msg(1), msg(2)]);
    vi.advanceTimersByTime(250);
    c.push([msg(3)]);
    vi.advanceTimersByTime(250);
    expect(batches.map((b) => b.length)).toEqual([2, 1]);
  });

  it("ventana fija desde el primer mensaje: un goteo constante igual descarga cada 250 ms", () => {
    // Un debounce puro nunca descargaría si llegan mensajes cada 100 ms; la agenda
    // quedaría congelada justo cuando más cambia.
    const batches: RealtimeAgendaMessage[][] = [];
    const c = createCoalescer(250, (b) => batches.push(b));
    for (let i = 0; i < 10; i++) {
      c.push([msg(i)]);
      vi.advanceTimersByTime(100);
    }
    // A los 1000 ms ya descargó al menos 3 veces aunque el goteo nunca paró.
    expect(batches.length).toBeGreaterThanOrEqual(3);
    vi.advanceTimersByTime(250);
    expect(batches.flat()).toHaveLength(10);
  });

  it("un lote vacío no arma ventana; cancel() descarta lo pendiente; flush() descarga ya", () => {
    const batches: RealtimeAgendaMessage[][] = [];
    const c = createCoalescer(250, (b) => batches.push(b));
    c.push([]);
    vi.advanceTimersByTime(1000);
    expect(batches).toHaveLength(0);

    c.push([msg(1)]);
    c.cancel();
    vi.advanceTimersByTime(1000);
    expect(batches).toHaveLength(0);

    c.push([msg(2)]);
    c.flush();
    expect(batches).toEqual([[msg(2)]]);
    vi.advanceTimersByTime(1000);
    expect(batches).toHaveLength(1);
  });

  it("un onFlush que tira no rompe el coalescer", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const batches: RealtimeAgendaMessage[][] = [];
    let first = true;
    const c = createCoalescer(250, (b) => {
      if (first) {
        first = false;
        throw new Error("consumer roto");
      }
      batches.push(b);
    });
    c.push([msg(1)]);
    expect(() => vi.advanceTimersByTime(250)).not.toThrow();
    c.push([msg(2)]);
    vi.advanceTimersByTime(250);
    expect(batches).toEqual([[msg(2)]]);
    vi.restoreAllMocks();
  });

  it("acepta timers inyectados", () => {
    const pending: Array<{ fn: () => void; ms: number }> = [];
    const timers = {
      setTimeout: (fn: () => void, ms: number) => {
        pending.push({ fn, ms });
        return pending.length;
      },
      clearTimeout: () => {},
    };
    const batches: RealtimeAgendaMessage[][] = [];
    const c = createCoalescer(250, (b) => batches.push(b), timers);
    c.push([msg(1)]);
    c.push([msg(2)]);
    expect(pending).toHaveLength(1);
    expect(pending[0].ms).toBe(250);
    pending[0].fn();
    expect(batches).toEqual([[msg(1), msg(2)]]);
  });
});

describe("backoffDelay", () => {
  it("1, 2, 4, 8, 16, 30, 30 s con jitter neutro (random = 0 → factor 1)", () => {
    const zero = () => 0;
    expect([0, 1, 2, 3, 4, 5, 6].map((n) => backoffDelay(n, zero))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ]);
    expect(BACKOFF_MAX_MS).toBe(30_000);
  });

  it("jitter en [0.5, 1] del valor base", () => {
    expect(backoffDelay(3, () => 0.999999)).toBeGreaterThanOrEqual(4_000);
    expect(backoffDelay(3, () => 0.5)).toBe(6_000);
    for (let i = 0; i < 50; i++) {
      const d = backoffDelay(10);
      expect(d).toBeGreaterThanOrEqual(15_000);
      expect(d).toBeLessThanOrEqual(30_000);
    }
  });

  it("intentos raros (negativo, NaN, enorme) no rompen", () => {
    const zero = () => 0;
    expect(backoffDelay(-3, zero)).toBe(1_000);
    expect(backoffDelay(Number.NaN, zero)).toBe(1_000);
    expect(backoffDelay(10_000, zero)).toBe(30_000);
  });
});

describe("nextPollDelay", () => {
  it("null si el canal está live o si realtime está apagado (off = SR)", () => {
    expect(nextPollDelay("live")).toBeNull();
    expect(nextPollDelay("off")).toBeNull();
  });
  it("60 s si está reconectando o en polling", () => {
    expect(nextPollDelay("reconnecting")).toBe(60_000);
    expect(nextPollDelay("polling")).toBe(60_000);
    expect(POLL_INTERVAL_MS).toBe(60_000);
  });
});

describe("shouldResync", () => {
  it("reconexión, pestaña visible, vuelta de red y pedido manual → resync", () => {
    expect(shouldResync("reconnect")).toBe(true);
    expect(shouldResync("visible")).toBe(true);
    expect(shouldResync("online")).toBe(true);
    expect(shouldResync("manual")).toBe(true);
  });
  it("la primera conexión no: la página ya trae los datos del server", () => {
    expect(shouldResync("connect")).toBe(false);
  });
});

describe("nextTokenRefreshAt", () => {
  it("80 % del TTL restante: token de 600 s → se renueva a los 480 s", () => {
    const now = Date.parse("2026-10-13T12:00:00.000Z");
    const exp = new Date(now + 600_000).toISOString();
    expect(nextTokenRefreshAt(exp, now)).toBe(now + 480_000);
  });

  it("acepta Date en los dos argumentos", () => {
    const now = new Date("2026-10-13T12:00:00.000Z");
    const exp = new Date(now.getTime() + 100_000);
    expect(nextTokenRefreshAt(exp, now)).toBe(now.getTime() + 80_000);
  });

  it("vencido, muy cerca o ilegible → piso de 30 s (un reloj corrido no puede martillar el mint)", () => {
    // Con el reloj del cliente adelantado, el token «ya vencido» haría pedir otro en
    // loop; el rate limit es 30 cada 10 min y el piso deja 20.
    const now = Date.parse("2026-10-13T12:00:00.000Z");
    expect(TOKEN_REFRESH_MIN_MS).toBe(30_000);
    expect(nextTokenRefreshAt(new Date(now - 5_000).toISOString(), now)).toBe(now + 30_000);
    expect(nextTokenRefreshAt(new Date(now + 10_000).toISOString(), now)).toBe(now + 30_000);
    expect(nextTokenRefreshAt("no-es-fecha", now)).toBe(now + 30_000);
  });
});

describe("parseIncoming / parseIncomingBatch", () => {
  it("mensaje válido pasa tal cual", () => {
    expect(parseIncoming(msg(1))).toEqual(msg(1));
    expect(parseIncoming({ ...msg(1), day: null, practitionerId: null })).not.toBeNull();
  });

  it("payload inválido → null, nunca tira", () => {
    const bad: unknown[] = [
      null,
      undefined,
      "texto",
      42,
      [],
      {},
      { ...msg(1), v: 2 },
      { ...msg(1), kind: "otro" },
      { ...msg(1), day: "13/10/2026" },
      // .strict(): una clave de más (posible PHI) descarta el mensaje entero.
      { ...msg(1), patientName: "María" },
    ];
    for (const b of bad) expect(() => parseIncoming(b)).not.toThrow();
    for (const b of bad) expect(parseIncoming(b)).toBeNull();
    const evil = {};
    Object.defineProperty(evil, "v", {
      enumerable: true,
      get() {
        throw new Error("getter hostil");
      },
    });
    expect(() => parseIncoming(evil)).not.toThrow();
    expect(parseIncoming(evil)).toBeNull();
  });

  it("lote: string JSON, array u objeto suelto; descarta los inválidos y conserva el resto", () => {
    expect(parseIncomingBatch(JSON.stringify([msg(1), { basura: 1 }, msg(2)]))).toEqual([msg(1), msg(2)]);
    expect(parseIncomingBatch([msg(1)])).toEqual([msg(1)]);
    expect(parseIncomingBatch(msg(3))).toEqual([msg(3)]);
    expect(parseIncomingBatch("{no es json")).toEqual([]);
    expect(parseIncomingBatch(null)).toEqual([]);
    expect(parseIncomingBatch("")).toEqual([]);
  });
});

describe("deriveConnectionState", () => {
  it("off manda sobre todo", () => {
    expect(deriveConnectionState("off", 5, false)).toBe("off");
  });
  it("live con live", () => {
    expect(deriveConnectionState("live", 0, true)).toBe("live");
  });
  it("1 fallo → reconnecting", () => {
    expect(deriveConnectionState("reconnecting", 1, true)).toBe("reconnecting");
  });
  it("≥ 2 fallos seguidos → polling", () => {
    expect(deriveConnectionState("reconnecting", 2, true)).toBe("polling");
    expect(deriveConnectionState("connecting", 7, true)).toBe("polling");
  });
  it("navegador offline → polling aunque no haya fallos todavía", () => {
    expect(deriveConnectionState("connecting", 0, false)).toBe("polling");
    expect(deriveConnectionState("live", 0, false)).toBe("polling");
  });
  it("arrancando (idle/connecting sin fallos) → reconnecting, nunca polling", () => {
    // El indicador no puede decir «Sin conexión en vivo» durante el primer segundo.
    expect(deriveConnectionState("idle", 0, true)).toBe("reconnecting");
    expect(deriveConnectionState("connecting", 0, true)).toBe("reconnecting");
  });
  it("online indefinido (SSR / sin navigator) se trata como online", () => {
    expect(deriveConnectionState("live", 0, undefined)).toBe("live");
  });
});
