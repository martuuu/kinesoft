/**
 * PF-0a: el acumulador de `lib/server-timing.ts`. Se prueba el símbolo real (sin mocks del módulo): con el flag
 * prendido junta marcas, tx y ops por scope y entrega UNA línea; apagado no toca nada y devuelve lo mismo que `fn`.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  FLUSH_IDLE_MS,
  __setPerfTimingForTests,
  beginTx,
  mark,
  perfTimingEnabled,
  recordStatement,
  serverTimingHeader,
  summaryServerTiming,
  timeAsync,
  withTimingScope,
  type TimingSummary,
} from "@/lib/server-timing";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => __setPerfTimingForTests(false));

describe("server-timing apagado (default)", () => {
  it("el flag arranca apagado sin PERF_TIMING", () => {
    expect(perfTimingEnabled()).toBe(false);
  });

  it("timeAsync devuelve la MISMA promesa de fn (sin envolver) y no hay resumen", async () => {
    const p = Promise.resolve(42);
    expect(timeAsync("x", () => p)).toBe(p);
    const lines: TimingSummary[] = [];
    const { result, summary } = await withTimingScope("GET /x", async () => {
      mark("auth", 5);
      recordStatement(3);
      expect(beginTx()).toBeNull();
      return "ok";
    }, (s) => lines.push(s));
    expect(result).toBe("ok");
    expect(summary).toBeNull();
    expect(lines).toHaveLength(0);
  });

  it("timeAsync propaga la excepción tal cual", async () => {
    const err = new Error("boom");
    await expect(timeAsync("x", () => Promise.reject(err))).rejects.toBe(err);
  });
});

describe("server-timing prendido", () => {
  it("acumula auth/actor/tx/ops del scope y entrega una sola línea", async () => {
    __setPerfTimingForTests(true);
    const lines: TimingSummary[] = [];
    const { result, summary } = await withTimingScope("GET /agenda", async () => {
      await timeAsync("auth", () => sleep(5));
      mark("actor", 12);
      // Dos tx en paralelo con ops adentro, como un loader de página.
      await Promise.all(
        [0, 1].map(async () => {
          const end = beginTx();
          recordStatement(2);
          recordStatement(3);
          await sleep(2);
          end?.();
        })
      );
      return "listo";
    }, (s) => lines.push(s));

    expect(result).toBe("listo");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(summary);
    expect(summary).toMatchObject({ route: "GET /agenda", actorMs: 12, txCount: 2, stmtCount: 4, dbMs: 10 });
    expect(summary!.authMs).toBeGreaterThanOrEqual(4);
    expect(summary!.marks.auth.count).toBe(1);
    // 4 ops + (BEGIN, set_config, COMMIT) por tx.
    expect(summary!.roundTrips).toBe(4 + 3 * 2);
    expect(summary!.txMs).toBeGreaterThan(0);
    expect(summary!.spanMs).toBeGreaterThan(0);
  });

  it("los scopes concurrentes no se mezclan", async () => {
    __setPerfTimingForTests(true);
    const [a, b] = await Promise.all([
      withTimingScope("GET /a", async () => {
        await sleep(3);
        recordStatement(1);
      }, () => {}),
      withTimingScope("GET /b", async () => {
        recordStatement(1);
        await sleep(1);
        recordStatement(1);
      }, () => {}),
    ]);
    expect(a.summary!.stmtCount).toBe(1);
    expect(b.summary!.stmtCount).toBe(2);
  });

  it("un scope no se corta por inactividad: una pausa larga entre ops entra en la misma línea", async () => {
    __setPerfTimingForTests(true);
    const lines: TimingSummary[] = [];
    const { summary } = await withTimingScope("GET /lento", async () => {
      recordStatement(1);
      await sleep(FLUSH_IDLE_MS + 30);
      await timeAsync("auth", () => sleep(1));
      recordStatement(1);
    }, (s) => lines.push(s));
    expect(lines).toHaveLength(1);
    expect(summary!.stmtCount).toBe(2);
    expect(summary!.marks.auth.count).toBe(1);
  });

  it("fuera de un request/scope no hace nada (cron, script)", () => {
    __setPerfTimingForTests(true);
    expect(beginTx()).toBeNull();
    expect(() => mark("auth", 1)).not.toThrow();
  });

  it("arma la cabecera Server-Timing con nombres saneados", () => {
    expect(serverTimingHeader({ auth: 12.345, "mw session": 1 })).toBe("auth;dur=12.3, mw_session;dur=1");
    const s = {
      route: "GET /x", spanMs: 50, authMs: 10, accessMs: 3, actorMs: 15, txCount: 1, txMs: 20,
      stmtCount: 2, dbMs: 8, roundTrips: 5, marks: {},
    } satisfies TimingSummary;
    expect(summaryServerTiming(s)).toBe("auth;dur=10, actor;dur=15, tx;dur=20, db;dur=8, span;dur=50");
  });
});
