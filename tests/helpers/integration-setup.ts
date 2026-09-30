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
export const revalidatePathSpy = vi.fn();
export const revalidateTagSpy = vi.fn();
vi.mock("next/cache", () => ({
  unstable_cache: <T extends (...a: never[]) => unknown>(fn: T) => fn,
  revalidatePath: (...args: unknown[]) => revalidatePathSpy(...args),
  revalidateTag: (...args: unknown[]) => revalidateTagSpy(...args),
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
