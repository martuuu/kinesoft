/** HF-1b · `importWithRetry`: un reintento a los 5 s y, si vuelve a fallar, «hay una versión nueva». */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHUNK_RETRY_DELAY_MS, StaleBuildError, importWithRetry, isStaleBuildError } from "@/lib/chunk-retry";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("[HF-1b] chunk-retry", () => {
  it("[HF-1b] importWithRetry reintenta una vez y después marca versión nueva", async () => {
    let calls = 0;
    const load = async () => {
      calls++;
      const e = new Error("Loading chunk 1234 failed.");
      e.name = "ChunkLoadError";
      throw e;
    };
    const p = importWithRetry(load);
    const settled = p.then(
      () => null,
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(CHUNK_RETRY_DELAY_MS - 1);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const err = await settled;
    expect(calls).toBe(2);
    expect(err).toBeInstanceOf(StaleBuildError);
    expect(isStaleBuildError(err)).toBe(true);
    expect((err as Error).message).toContain("Loading chunk 1234 failed.");
    // Un tercer intento no existe: recargar es lo único que trae el chunk nuevo.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(2);
  });

  it("si el reintento entra, devuelve el módulo (una red que parpadeó no es versión nueva)", async () => {
    let calls = 0;
    const p = importWithRetry(async () => {
      calls++;
      if (calls === 1) throw new TypeError("Failed to fetch dynamically imported module");
      return { ok: 1 };
    });
    await vi.advanceTimersByTimeAsync(CHUNK_RETRY_DELAY_MS);
    await expect(p).resolves.toEqual({ ok: 1 });
    expect(calls).toBe(2);
  });

  it("al primer intento no espera nada", async () => {
    await expect(importWithRetry(async () => 7)).resolves.toBe(7);
  });

  it("isStaleBuildError reconoce por name (el error puede venir de otro chunk)", () => {
    const e = new Error("x");
    e.name = "StaleBuildError";
    expect(isStaleBuildError(e)).toBe(true);
    expect(isStaleBuildError(new Error("x"))).toBe(false);
    expect(isStaleBuildError("StaleBuildError")).toBe(false);
  });
});
