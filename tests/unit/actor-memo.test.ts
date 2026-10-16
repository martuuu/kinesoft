/**
 * PF2-e (C-PF8) · clave de la memo del actor (`lib/session.ts`): todo lo que cambia el actor dentro de un request la
 * invalida. El caso de punta a punta contra Postgres (N llamadas = 1 resolución, concurrencia, switchTenant) está en
 * tests/integration/actor-memo.test.ts; acá van las piezas de la clave que ahí cuestan armar: la cookie de soporte,
 * las de 2FA/step-up, un cambio de sesión a mitad del request, la revalidación de Next (re-render dentro del mismo
 * request) y que un error no quede pegado.
 *
 * Símbolo real: `getActor`/`tryGetActor`. Se reemplazan solo las dependencias externas: la lectura de acceso
 * (`prismaService.$queryRaw`, la red a Postgres), la sesión verificada (`getSessionUser`, la red a Supabase), el
 * frasco de cookies de Next (por request) y `cache()` de React (no existe fuera del build react-server). La
 * revalidación usa el `revalidateTag` REAL de Next sobre su store real.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  (globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;
});

type Store = { jar: Map<string, string>; user: { id: string; sessionId: string | null; aal: "aal1" | "aal2" | null } | null };

const h = vi.hoisted(() => ({
  queries: 0,
  failNext: false,
  tenantName: "Consultorio Uno",
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: <T extends (...a: never[]) => unknown>(fn: T) => fn };
});

vi.mock("next/headers", async () => {
  const { requestAsyncStorage } = await import("next/dist/client/components/request-async-storage.external");
  const jar = (): Map<string, string> => {
    const s = requestAsyncStorage.getStore() as unknown as Store | undefined;
    if (!s) throw new Error("cookies() fuera de un request");
    return s.jar;
  };
  return {
    cookies: () => ({
      get: (name: string) => (jar().has(name) ? { name, value: jar().get(name)! } : undefined),
      set: (name: string, value: string) => void jar().set(name, value),
      delete: (name: string) => void jar().delete(name),
    }),
    headers: () => new Headers({ "x-request-id": "unit-test", "user-agent": "vitest" }),
  };
});

vi.mock("@/lib/session-user", async () => {
  const { requestAsyncStorage } = await import("next/dist/client/components/request-async-storage.external");
  return {
    getSessionUser: async () => {
      const s = requestAsyncStorage.getStore() as unknown as Store | undefined;
      const u = s ? s.user : { id: "user-1", sessionId: "sess-1", aal: "aal1" as const };
      return u ? { ...u, email: `${u.id}@test.local`, fullName: null, avatarUrl: null, verifiedBy: "jwt" } : null;
    },
  };
});

vi.mock("@/lib/db", () => {
  const row = (userId: string) => ({
    fullName: "Ana Memo",
    email: `${userId}@test.local`,
    isPlatformAdmin: false,
    userDisabledAt: null,
    twoFactorTotp: false,
    twoFactorEmail: false,
    tenantId: "tenant-1",
    role: "PRACTITIONER",
    acceptedAt: new Date("2026-01-01T00:00:00Z"),
    membershipDisabledAt: null,
    clinical: true,
    grantSettings: false,
    grantBilling: false,
    slug: "uno",
    name: h.tenantName,
    vertical: "KINESIOLOGY",
    saasPlan: "PRO",
    publicBookingEnabled: false,
    onboardingCompletedAt: new Date("2026-01-01T00:00:00Z"),
    status: "ACTIVE",
    subscriptionStatus: "ACTIVE",
    trialEndsAt: null,
    subscriptionStatusChangedAt: null,
    practitionerId: "prac-1",
  });
  const prismaService = {
    // Tagged template: el primer valor interpolado es el userId de la sesión (`WHERE u."id" = ${userId}`).
    $queryRaw: async (_s: TemplateStringsArray, userId: string) => {
      h.queries++;
      if (h.failNext) {
        h.failNext = false;
        throw new Error("conexión perdida");
      }
      return [row(userId)];
    },
  };
  return { prisma: {}, prismaService };
});

import { requestAsyncStorage } from "next/dist/client/components/request-async-storage.external";
import { staticGenerationAsyncStorage } from "next/dist/client/components/static-generation-async-storage.external";
import { revalidateTag } from "next/dist/server/web/spec-extension/revalidate";
import { getActor, tryGetActor } from "@/lib/session";

function inRequest<T>(fn: (s: Store) => Promise<T>, o: { cookies?: Record<string, string> } = {}): Promise<T> {
  const store: Store = { jar: new Map(Object.entries(o.cookies ?? {})), user: { id: "user-1", sessionId: "sess-1", aal: "aal1" } };
  return requestAsyncStorage.run(store as never, () => fn(store));
}

beforeEach(() => {
  h.queries = 0;
  h.failNext = false;
  h.tenantName = "Consultorio Uno";
});

describe("[PF2-e] memo del actor: la clave", () => {
  it("sin cambios: N llamadas = 1 lectura de acceso", async () => {
    await inRequest(async () => {
      const a = await getActor();
      expect(await getActor()).toBe(a);
      expect(await tryGetActor()).toBe(a);
    });
    expect(h.queries).toBe(1);
  });

  it("fuera de Next (sin store de request): sin memo", async () => {
    await getActor();
    await getActor();
    expect(h.queries).toBe(2);
  });

  for (const cookie of ["kine_tenant", "kine_support", "kine_2fa", "kine_stepup"]) {
    it(`cambiar \`${cookie}\` a mitad del request vuelve a resolver`, async () => {
      await inRequest(async (s) => {
        await getActor();
        s.jar.set(cookie, "valor-nuevo");
        await getActor();
      });
      expect(h.queries).toBe(2);
    });
  }

  it("otra sesión en el mismo request (login a mitad de camino, otro `session_id` o `aal`) vuelve a resolver", async () => {
    await inRequest(async (s) => {
      const a = await getActor();
      s.user = { id: "user-1", sessionId: "sess-2", aal: "aal1" };
      await getActor();
      s.user = { id: "user-1", sessionId: "sess-2", aal: "aal2" };
      await getActor();
      s.user = { id: "user-2", sessionId: "sess-3", aal: "aal1" };
      const other = await getActor();
      expect(other.userId).toBe("user-2");
      expect(a.userId).toBe("user-1");
    });
    expect(h.queries).toBe(4);
  });

  it("revalidar (revalidateTag real de Next) invalida: el re-render del mismo request ve el consultorio actualizado", async () => {
    const sg = { incrementalCache: {}, urlPathname: "/configuracion", isStaticGeneration: false } as never;
    await inRequest(() =>
      staticGenerationAsyncStorage.run(sg, async () => {
        expect((await getActor()).tenantName).toBe("Consultorio Uno");
        h.tenantName = "Consultorio Renombrado"; // la action escribió
        expect((await getActor()).tenantName).toBe("Consultorio Uno"); // misma action, antes de revalidar: memo
        revalidateTag("tenant:tenant-1");
        expect((await getActor()).tenantName).toBe("Consultorio Renombrado"); // re-render tras la action
        await getActor();
      })
    );
    expect(h.queries).toBe(2);
  });

  it("un error en la resolución no queda memoizado", async () => {
    h.failNext = true;
    await inRequest(async () => {
      await expect(getActor()).rejects.toThrow("conexión perdida");
      expect((await getActor()).tenantId).toBe("tenant-1");
    });
    expect(h.queries).toBe(2);
  });

  it("sin sesión no se memoiza nada", async () => {
    await inRequest(async (s) => {
      s.user = null;
      expect(await tryGetActor()).toBeNull();
      expect(await tryGetActor()).toBeNull();
    });
    expect(h.queries).toBe(0);
  });
});
