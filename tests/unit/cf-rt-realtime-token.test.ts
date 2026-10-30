/**
 * CF-RT (§28 ítem E) · «Hay una versión nueva · Recargá» en prod sin que hubiera deploy nuevo.
 *
 * Causa (verificada en el `.next/` local del 27-oct): `mintRealtimeToken` solo era alcanzable por un `import()` dinámico
 * (provider → `import("@/components/realtime/realtime-hub")` → import estático de la action). Next 14.2 no registra en
 * `server-reference-manifest.json` las actions que el cliente solo alcanza por `import()` (AUDIT:2333): el chunk del hub
 * llamaba el id `528c3df5…`, el server respondía «Failed to find Server Action», el router del cliente resolvía
 * `undefined` y el hub lo clasificaba `stale_build` aunque el build fuera EL MISMO. Recargar no lo arreglaba nunca.
 *
 * Lo que se fija:
 * - [CF-RT1] el provider importa la action ESTÁTICA (así Next la registra) y se la pasa al hub; el hub ya no la importa
 *   y usa la que recibe. La referencia es `lib/realtime-token-action` (delega en `mintRealtimeToken` al llamarla): un
 *   import estático de `lib/realtime-token` rompía la colección de los tests de render que usan `useRealtime`.
 * - [CF-RT2] una respuesta sin `ok` (o la action que tira algo que no es red) es `server_error`; `stale_build` solo si
 *   el server sirve OTRO build (header `x-build-id` ≠ `NEXT_PUBLIC_BUILD_ID` horneado en el cliente).
 *
 * Símbolos reales: `createRealtimeHub`, `defaultLoadDriver`, `createSupabaseDriver`, `tokenGetterFromAction`,
 * `createBuildChangedProbe`. Lo mockeado es la frontera: la server action, `@supabase/realtime-js` (socket) y `fetch`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Si el hub todavía usara su propio import de la action, esto contaría.
const actionMod = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/lib/realtime-token", () => ({
  mintRealtimeToken: async () => {
    actionMod.calls++;
    return { ok: false, error: "realtime-off" };
  },
}));

// Socket fake: el driver real lo carga con `await import("@supabase/realtime-js")` dentro de `connect()`.
const sock = vi.hoisted(() => ({ subscribes: 0 }));
vi.mock("@supabase/realtime-js", () => {
  class RealtimeClient {
    constructor(_e: string, _o: unknown) {}
    channel() {
      const ch = {
        on() {
          return ch;
        },
        subscribe(cb: (s: string) => void) {
          sock.subscribes++;
          cb("SUBSCRIBED");
          return ch;
        },
      };
      return ch;
    }
    async setAuth() {}
    async removeChannel() {
      return "ok";
    }
    async disconnect() {}
  }
  return { RealtimeClient };
});

import { createRealtimeHub, defaultLoadDriver } from "@/components/realtime/realtime-hub";
import {
  BUILD_ID_HEADER,
  BUILD_PROBE_PATH,
  classifyMintThrow,
  createBuildChangedProbe,
  tokenGetterFromAction,
} from "@/lib/realtime-client-state";
import type { RealtimeBootstrap } from "@/lib/realtime-events";

const SUPA: RealtimeBootstrap = { driver: "supabase", tenantId: "t1", url: "https://proj.supabase.co", anonKey: "k" };
const NOW = Date.parse("2026-10-30T12:00:00.000Z");

async function settle() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

const read = (f: string) => readFileSync(resolve(process.cwd(), f), "utf8");
/** Import de VALOR (no `import type`) desde `mod`. Mismo detector que el [FX3] del provider. */
function staticValueImport(src: string, mod: string): boolean {
  const m = mod.replace(/[/.@-]/g, (c) => `\\${c}`);
  return new RegExp(`^\\s*import\\s+(?!type\\b)[^;]*?from\\s+["']${m}["']`, "m").test(src);
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  actionMod.calls = 0;
  sock.subscribes = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("[CF-RT1] la action del token entra ESTÁTICA por el provider y el hub usa la que recibe", () => {
  it("[CF-RT1] provider: import estático de la action y `createRealtimeHub({ getToken: mintRealtimeTokenAction })`", () => {
    const src = read("components/providers/realtime-provider.tsx");
    expect(staticValueImport(src, "@/lib/realtime-token-action")).toBe(true);
    expect(src).toMatch(/createRealtimeHub\(\s*\{\s*getToken:\s*mintRealtimeTokenAction\s*\}\s*\)/);
    // Es `"use server"` (al cliente llega la referencia) y delega en la action real con su barrera.
    const ref = read("lib/realtime-token-action.ts");
    expect(ref).toMatch(/^"use server";/);
    expect(ref).toMatch(/await import\("@\/lib\/realtime-token"\)/);
    // El hub sigue dinámico (bundle §18.10 punto 7).
    expect(staticValueImport(src, "@/components/realtime/realtime-hub")).toBe(false);
    expect(src).toMatch(/import\(\s*["']@\/components\/realtime\/realtime-hub["']\s*\)/);
  });

  it("[CF-RT1] el hub ya no importa la action (solo alcanzable por import() = no registrada por Next 14.2)", () => {
    const hub = read("components/realtime/realtime-hub.ts");
    expect(staticValueImport(hub, "@/lib/realtime-token")).toBe(false);
    expect(staticValueImport(hub, "@/lib/realtime-token-action")).toBe(false);
  });

  it("[CF-RT1] la referencia delega en mintRealtimeToken (mismo resultado)", async () => {
    const { mintRealtimeTokenAction } = await import("@/lib/realtime-token-action");
    expect(await mintRealtimeTokenAction()).toEqual({ ok: false, error: "realtime-off" });
    expect(actionMod.calls).toBe(1);
  });

  it("[CF-RT1] hub.start con el loader por defecto pide el token a la action INYECTADA", async () => {
    const injected = { calls: 0 };
    const hub = createRealtimeHub({
      isOnline: () => true,
      getToken: async () => {
        injected.calls++;
        return { ok: true as const, data: { token: "tok", expiresAt: new Date(Date.now() + 600_000).toISOString() } };
      },
    });
    const stop = hub.start(SUPA);
    for (let i = 0; i < 10 && hub.getState() !== "live"; i++) {
      await new Promise((r) => setTimeout(r, 5));
      await settle();
    }
    expect(injected.calls).toBeGreaterThanOrEqual(1);
    expect(actionMod.calls).toBe(0);
    expect(sock.subscribes).toBe(1);
    expect(hub.getState()).toBe("live");
    stop();
  });

  it("[CF-RT1] defaultLoadDriver(b, getToken) arma el driver con esa action", async () => {
    const injected = { calls: 0 };
    const d = await defaultLoadDriver(SUPA, async () => {
      injected.calls++;
      return { ok: false as const, error: "realtime-off" };
    });
    expect(d).not.toBeNull();
    await d!.connect();
    await settle();
    expect(injected.calls).toBe(1);
    expect(actionMod.calls).toBe(0);
    d!.close();
  });
});

describe("[CF-RT2] action sin respuesta ≠ versión nueva", () => {
  const same = async () => false;
  const unknown = async () => null;
  const changed = async () => true;

  it("[CF-RT2] resultado `undefined` (Failed to find Server Action) con el MISMO build → server_error", async () => {
    const r = await tokenGetterFromAction(async () => undefined, same)();
    expect(r).toMatchObject({ code: "server_error" });
  });

  it("[CF-RT2] sin forma de saber el build (sin header o sin id horneado) → server_error, nunca stale_build", async () => {
    expect(await tokenGetterFromAction(async () => undefined, unknown)()).toMatchObject({ code: "server_error" });
    expect(await tokenGetterFromAction(async () => ({ foo: 1 }), unknown)()).toMatchObject({ code: "server_error" });
  });

  it("[CF-RT2] la action tira (500 / action no encontrada) → server_error si el build es el mismo", async () => {
    const thrower = async () => {
      throw new Error('Failed to find Server Action "528c3df5". This request might be from an older or newer deployment.');
    };
    expect(classifyMintThrow(new Error("An error occurred in the Server Components render."))).toMatchObject({
      code: "server_error",
    });
    expect(await tokenGetterFromAction(thrower, same)()).toMatchObject({ code: "server_error" });
  });

  it("[CF-RT2] el server sirve OTRO build → stale_build (lo único que pide recargar)", async () => {
    expect(await tokenGetterFromAction(async () => undefined, changed)()).toMatchObject({ code: "stale_build" });
    const thrower = async () => {
      throw new Error("Failed to find Server Action");
    };
    expect(await tokenGetterFromAction(thrower, changed)()).toMatchObject({ code: "stale_build" });
  });

  it("[CF-RT2] red caída sigue transitoria (null) y no consulta el build; {ok} sigue igual", async () => {
    const probe = { calls: 0 };
    const counting = async () => {
      probe.calls++;
      return true;
    };
    const offline = async () => {
      throw new TypeError("Failed to fetch");
    };
    expect(await tokenGetterFromAction(offline, counting)()).toBeNull();
    expect(await tokenGetterFromAction(async () => ({ ok: false, error: "realtime-off" }), counting)()).toMatchObject({
      code: "off",
    });
    const data = { token: "t", expiresAt: "2026-10-30T12:10:00.000Z" };
    expect(await tokenGetterFromAction(async () => ({ ok: true, data }), counting)()).toEqual(data);
    expect(probe.calls).toBe(0);
  });

  it("[CF-RT2] hub + driver reales: `undefined` del mint → diag server_error, no «versión nueva»", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    // Sin NEXT_PUBLIC_BUILD_ID en el test: el probe por defecto no puede saber el build → server_error.
    const hub = createRealtimeHub({ isOnline: () => true, getToken: async () => undefined as never });
    hub.start(SUPA);
    // El hub carga el driver con un `import()` real: bajo carga (suite entera en paralelo) tarda más que 20 vueltas
    // y el test salía en rojo intermitente. Se espera a que haya diag, con tope, en vez de un número fijo de vueltas.
    for (let i = 0; i < 500 && hub.getDiag()?.step !== "mint"; i++) {
      await vi.advanceTimersByTimeAsync(10);
      await settle();
    }
    expect(hub.getDiag()).toMatchObject({ step: "mint", code: "server_error" });
    expect(hub.getDiag()?.code).not.toBe("stale_build");
  });

  it("[CF-RT2] la TV usa la misma clasificación (sin un `stale_build` propio en el token)", () => {
    const src = read("components/tv/use-display-live.ts");
    expect(src).toMatch(/tokenGetterFromAction\(\s*mintDisplayRealtimeToken\s*\)/);
    expect(src).not.toMatch(/code:\s*"stale_build"/);
  });
});

describe("[CF-RT2] createBuildChangedProbe · header x-build-id vs NEXT_PUBLIC_BUILD_ID", () => {
  function fakeFetch(header: string | null, opts: { throws?: boolean } = {}) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const f = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (opts.throws) throw new TypeError("Failed to fetch");
      return { headers: { get: (k: string) => (k.toLowerCase() === BUILD_ID_HEADER ? header : null) } };
    };
    return { calls, f: f as unknown as typeof fetch };
  }

  it("mismo id → false; distinto → true; con HEAD sin caché a un estático fuera del middleware", async () => {
    const a = fakeFetch("abc123");
    expect(await createBuildChangedProbe({ bakedId: "abc123", fetch: a.f })()).toBe(false);
    expect(a.calls[0].url).toBe(BUILD_PROBE_PATH);
    expect(a.calls[0].init).toMatchObject({ method: "HEAD", cache: "no-store" });
    const b = fakeFetch("def456");
    expect(await createBuildChangedProbe({ bakedId: "abc123", fetch: b.f })()).toBe(true);
  });

  it("sin id horneado no pide nada; sin header o con la red caída → null (no se sabe)", async () => {
    const a = fakeFetch("abc123");
    expect(await createBuildChangedProbe({ bakedId: "", fetch: a.f })()).toBeNull();
    expect(a.calls).toHaveLength(0);
    expect(await createBuildChangedProbe({ bakedId: "abc123", fetch: fakeFetch(null).f })()).toBeNull();
    expect(await createBuildChangedProbe({ bakedId: "abc123", fetch: fakeFetch("x", { throws: true }).f })()).toBeNull();
  });
});

describe("[CF-RT2] next.config.mjs · el mismo id horneado y en el header", () => {
  it("buildIdFrom: sha de Vercel → hash corto estable; sin sha → vacío (sin header)", async () => {
    const { buildIdFrom } = await import("../../next.config.mjs");
    const a = buildIdFrom({ VERCEL_GIT_COMMIT_SHA: "0123456789abcdef0123456789abcdef01234567" });
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toContain("0123456789abcdef");
    expect(buildIdFrom({ VERCEL_GIT_COMMIT_SHA: "0123456789abcdef0123456789abcdef01234567" })).toBe(a);
    expect(buildIdFrom({ VERCEL_GIT_COMMIT_SHA: "ffff" })).not.toBe(a);
    expect(buildIdFrom({})).toBe("");
  });

  it("con id: `env.NEXT_PUBLIC_BUILD_ID` y el header `x-build-id` de `/(.*)` llevan el mismo valor", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "aaaabbbbccccddddeeeeffff0000111122223333");
    vi.resetModules();
    try {
      const mod = await import("../../next.config.mjs");
      const cfg = mod.default as { env?: Record<string, string>; headers: () => Promise<Array<{ source: string; headers: Array<{ key: string; value: string }> }>> };
      const id = mod.buildIdFrom({ VERCEL_GIT_COMMIT_SHA: "aaaabbbbccccddddeeeeffff0000111122223333" });
      expect(cfg.env?.NEXT_PUBLIC_BUILD_ID).toBe(id);
      const rules = await cfg.headers();
      const hit = rules.find((r) => r.source === "/(.*)" && r.headers.some((h) => h.key === BUILD_ID_HEADER));
      expect(hit?.headers.find((h) => h.key === BUILD_ID_HEADER)?.value).toBe(id);
      // El índice 0 sigue siendo la global de seguridad (lo leen observability/realtime/CSP).
      expect(rules[0].headers.some((h) => h.key === "X-Frame-Options")).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
