/**
 * Global mocks for the integration project (vitest.integration.config.ts).
 *
 * Anti-false-green rule (.docs/TESTING.md): mock the EXTERNAL dependency —
 * the cookie/header APIs, the Supabase network call, Next's cache runtime —
 * never the function under test. Server actions from lib/*.ts run for real
 * against Postgres, through `runWithRls` and the real `getActor()`.
 */
import { vi } from "vitest";

// React's `cache()` only exists in the react-server build that Next bundles;
// the plain `react` package used by vitest doesn't export it. Pass-through:
// every call resolves fresh, which is also what lets a test switch actors.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: <T extends (...a: never[]) => unknown>(fn: T) => fn };
});

// Next's data cache needs the incremental-cache runtime ("Invariant:
// incrementalCache missing" outside Next). Pass-through + spies so tests can
// assert which paths/tags an action invalidated.
//
// SR-D5I: el pass-through hace que un test NUNCA vea una fuga por clave de
// cache (dos actores con la misma clave y datos distintos): cada llamada
// recalcula. Con `useRealUnstableCache()` el mock guarda en un Map real con la
// clave que arma Next 14.2 (`unstable-cache.js`: `${fn}-${keyParts}-${JSON
// args}`), serializa a JSON como Next (las fechas vuelven string) y
// `revalidateTag` borra las entradas de ese tag. Es OPT-IN: un cache real en
// toda la suite volvería stale las lecturas de los tests que escriben y leen
// sin pasar por una mutación que revalide. `usePassthroughUnstableCache()`
// (o el `afterEach` del test) lo apaga.
//
// SRZ (FX1): además devuelve el registro de los `keyParts` de cada llamada
// (hit o miss), en orden. Motivo: la clave del mock también lleva los args
// serializados y `practitionerId` viaja como arg, así que un test que solo mira
// "cada actor ve su número" sigue verde aunque se borre el scope de los
// `keyParts` (revisión (a) de SR). Con el registro, el test fija el contrato
// "la clave lleva el scope" (`own:<pid>` / `tenant`) sin depender de los args.
const realCache = vi.hoisted(() => ({
  store: null as Map<string, { json: string; tags: string[] }> | null,
  keyParts: [] as string[][],
}));
export function useRealUnstableCache(): { keyParts: ReadonlyArray<readonly string[]> } {
  realCache.store = new Map();
  realCache.keyParts = [];
  return { keyParts: realCache.keyParts };
}
export function usePassthroughUnstableCache(): void {
  realCache.store = null;
  realCache.keyParts = [];
}
export const revalidatePathSpy = vi.fn();
export const revalidateTagSpy = vi.fn();
vi.mock("next/cache", () => ({
  unstable_cache:
    <T extends (...a: never[]) => unknown>(
      fn: T,
      keyParts?: string[],
      opts?: { tags?: string[]; revalidate?: number | false }
    ) =>
    (...args: Parameters<T>) => {
      const store = realCache.store;
      if (!store) return fn(...args);
      realCache.keyParts.push([...(keyParts ?? [])]);
      const key = `${fn.toString()}-${Array.isArray(keyParts) && keyParts.join(",")}-${JSON.stringify(args)}`;
      const hit = store.get(key);
      if (hit) return Promise.resolve(JSON.parse(hit.json));
      return Promise.resolve(fn(...args)).then((v) => {
        store.set(key, { json: JSON.stringify(v), tags: opts?.tags ?? [] });
        return JSON.parse(JSON.stringify(v));
      });
    },
  revalidatePath: (...args: unknown[]) => revalidatePathSpy(...args),
  revalidateTag: (...args: unknown[]) => {
    const store = realCache.store;
    if (store) for (const [k, e] of store) if (e.tags.includes(String(args[0]))) store.delete(k);
    return revalidateTagSpy(...args);
  },
  unstable_noStore: () => {},
}));

vi.mock("next/headers", () => {
  const jar = new Map<string, string>();
  return {
    cookies: () => ({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
      has: (name: string) => jar.has(name),
    }),
    headers: () => new Headers({ "x-request-id": "integration-test", "user-agent": "vitest" }),
  };
});

// The Supabase session: returns whichever user tests/helpers/actor.ts set.
vi.mock("@/lib/supabase/server", async () => {
  const { currentTestUser } = await import("./actor");
  return {
    getSupabaseServerClient: () => ({
      auth: {
        getUser: async () => ({ data: { user: currentTestUser() }, error: null }),
      },
    }),
  };
});

// SAFETY: the local `.env` may carry the service-role key of a REAL Supabase
// project (Prisma loads it into process.env). An integration test calling an
// invite/storage action must never send a real email or touch real Storage.
// `null` is the documented "not configured" contract (callers skip/degrade);
// tests that need the admin client mock it explicitly.
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdminClient: () => null }));
