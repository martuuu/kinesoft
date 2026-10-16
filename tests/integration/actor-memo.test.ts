/**
 * PF2-e (C-PF8, brief-pf §2.4) · actor memoizado por request: seguridad multi-tenant.
 *
 * Contrato literal: «memo por `requestAsyncStorage.getStore()` + token de sesión + cookie de tenant (`kine_tenant`),
 * como `lib/session-user.ts:205`. Tests: (1) N `getActor()` en una action = 1 resolución; (2) dos requests
 * concurrentes con usuarios/tenants distintos no comparten actor (test de concurrencia con `Promise.all` de dos
 * stores); (3) cambio de tenant dentro de la misma request (switchTenant) invalida la memo; (4) fuera de Next
 * (scripts/unit) sin memo.»
 *
 * Símbolos REALES (`getActor`, `tryGetActor`, `switchTenant`) contra Postgres en los dos roles. Se reemplaza solo lo
 * externo, POR REQUEST: la sesión de Supabase y el frasco de cookies salen del store de `requestAsyncStorage` del
 * request (así dos requests concurrentes pueden ser de usuarios distintos, como en prod). Sin datos en el store se usa
 * lo de `tests/helpers/actor.ts` y un frasco global, como el resto de la suite. La resolución se cuenta con el contador
 * real (`tests/helpers/query-counter.ts`): una lectura de acceso por el canal de servicio = una resolución.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  (globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;
});

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { installQueryCounter } = await import("@/tests/helpers/query-counter");
  return { ...actual, ...installQueryCounter() };
});

type FakeUser = { id: string; email: string; email_confirmed_at: string };
type FakeStore = { __user?: FakeUser | null; __jar?: Map<string, string> };
const globalJar = vi.hoisted(() => new Map<string, string>());

vi.mock("next/headers", async () => {
  const { requestAsyncStorage } = await import("next/dist/client/components/request-async-storage.external");
  const jar = () => ((requestAsyncStorage.getStore() as FakeStore | undefined)?.__jar ?? globalJar) as Map<string, string>;
  return {
    cookies: () => ({
      get: (name: string) => (jar().has(name) ? { name, value: jar().get(name)! } : undefined),
      getAll: () => [...jar().entries()].map(([name, value]) => ({ name, value })),
      set: (name: string, value: string) => void jar().set(name, value),
      delete: (name: string) => void jar().delete(name),
      has: (name: string) => jar().has(name),
    }),
    headers: () => new Headers({ "x-request-id": "integration-test", "user-agent": "vitest" }),
  };
});

vi.mock("@/lib/supabase/server", async () => {
  const { requestAsyncStorage } = await import("next/dist/client/components/request-async-storage.external");
  const { currentTestUser } = await import("@/tests/helpers/actor");
  return {
    getSupabaseServerClient: () => ({
      auth: {
        getUser: async () => {
          const s = requestAsyncStorage.getStore() as FakeStore | undefined;
          return { data: { user: s && "__user" in s ? s.__user : currentTestUser() }, error: null };
        },
      },
    }),
  };
});

import { requestAsyncStorage } from "next/dist/client/components/request-async-storage.external";
import type { PrismaClient } from "@prisma/client";
import { getActor, tryGetActor, UnauthenticatedError, type Actor } from "@/lib/session";
import { switchTenant } from "@/lib/tenant-switch";
import { getRequestContext } from "@/lib/request-context";
import { measure } from "@/tests/helpers/query-counter";
import { asAnonymous, asUser } from "@/tests/helpers/actor";
import { ownerClient, createEphemeralTenant, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const TENANT_COOKIE = "kine_tenant";

const rec = (globalThis as unknown as { __kineQueryRecorder: { events: Array<{ query: string; client: string }> } })
  .__kineQueryRecorder;
/** Lecturas de acceso (`loadAccessMemberships`) del último `measure`: una por resolución de actor. */
function resolutions(): number {
  return rec.events.filter((e) => e.client === "service" && /FROM "UserProfile" u\s/.test(e.query)).length;
}

function fakeUser(id: string): FakeUser {
  return { id, email: `${id}@test.local`, email_confirmed_at: new Date(0).toISOString() };
}

/** Un request de Next: store propio con su usuario de sesión y su frasco de cookies. */
function inRequest<T>(o: { user?: string | null; cookies?: Record<string, string> }, fn: () => Promise<T>): Promise<T> {
  const store: FakeStore = { __jar: new Map(Object.entries(o.cookies ?? {})) };
  if (o.user !== undefined) store.__user = o.user ? fakeUser(o.user) : null;
  return requestAsyncStorage.run(store as never, fn);
}

/** Cede el event loop entre llamadas para que los dos requests se intercalen de verdad. */
const tick = () => new Promise((r) => setTimeout(r, 1));

describe.skipIf(!RUN)("[PF2-e] actor memoizado por request", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  const users: string[] = [];
  const prevEnf = process.env.TENANT_ACCESS_ENFORCEMENT;

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db, { vertical: "GENERAL" });
  });

  afterAll(async () => {
    if (prevEnf === undefined) delete process.env.TENANT_ACCESS_ENFORCEMENT;
    else process.env.TENANT_ACCESS_ENFORCEMENT = prevEnf;
    await A?.cleanup();
    await B?.cleanup();
    if (db) {
      if (users.length) {
        await db.practitioner.deleteMany({ where: { userId: { in: users } } });
        await db.membership.deleteMany({ where: { userId: { in: users } } });
        await db.userPreferences.deleteMany({ where: { userId: { in: users } } });
        await db.userProfile.deleteMany({ where: { id: { in: users } } });
      }
      await db.$disconnect();
    }
  });

  beforeEach(() => {
    globalJar.clear();
    asAnonymous();
  });

  afterEach(() => {
    delete process.env.TENANT_ACCESS_ENFORCEMENT;
  });

  async function newUser(name = "Ana Memo"): Promise<string> {
    const id = `test-user-${uniqueSuffix()}`;
    await db.userProfile.create({ data: { id, email: `${id}@test.local`, fullName: name } });
    users.push(id);
    return id;
  }

  async function join(userId: string, t: EphemeralTenant) {
    await db.practitioner.create({ data: { tenantId: t.tenantId, userId, specialty: "Test" } });
    await db.membership.create({ data: { userId, tenantId: t.tenantId, role: "PRACTITIONER", acceptedAt: new Date() } });
  }

  /** Usuario con membresía en A y en B (el que puede cambiar de consultorio). */
  async function multiUser(): Promise<string> {
    const id = await newUser();
    await join(id, A);
    await join(id, B);
    return id;
  }

  it("(1) N getActor/tryGetActor en un request = 1 resolución, el mismo actor", async () => {
    const { result } = await measure(() =>
      inRequest({ user: A.userId }, async () => {
        const out: Actor[] = [];
        for (let i = 0; i < 5; i++) out.push(await getActor());
        out.push((await tryGetActor())!);
        out.push(...(await Promise.all([getActor(), getActor(), tryGetActor() as Promise<Actor>])));
        return out;
      })
    );
    expect(resolutions()).toBe(1);
    for (const a of result) expect(a).toBe(result[0]);
    expect(result[0]).toMatchObject({ tenantId: A.tenantId, userId: A.userId });
  });

  it("(2) dos requests concurrentes de usuarios/consultorios distintos no comparten actor", async () => {
    const run = (user: string) =>
      inRequest({ user }, async () => {
        const seen: Array<{ tenantId: string; userId: string; practitionerId: string | null }> = [];
        for (let i = 0; i < 4; i++) {
          const a = await getActor();
          seen.push({ tenantId: a.tenantId, userId: a.userId, practitionerId: a.practitionerId });
          // El contexto del request (logs, RLS, auditoría) es el de ESTE actor también en un acierto de la memo.
          expect(getRequestContext()).toMatchObject({ tenantId: a.tenantId, userId: a.userId });
          await tick();
        }
        return seen;
      });
    const { result } = await measure(() => Promise.all([run(A.userId), run(B.userId)]));
    const [ra, rb] = result;
    for (const x of ra) expect(x).toEqual({ tenantId: A.tenantId, userId: A.userId, practitionerId: A.practitionerId });
    for (const x of rb) expect(x).toEqual({ tenantId: B.tenantId, userId: B.userId, practitionerId: B.practitionerId });
    // Una resolución por request: ni se comparte (serían 1) ni se pierde la memo (serían 8).
    expect(resolutions()).toBe(2);
  });

  it("(2b) el MISMO usuario en dos requests concurrentes con otro `kine_tenant` ve su consultorio en cada uno", async () => {
    const u = await multiUser();
    const run = (tenantId: string) =>
      inRequest({ user: u, cookies: { [TENANT_COOKIE]: tenantId } }, async () => {
        const ids: string[] = [];
        for (let i = 0; i < 3; i++) {
          ids.push((await getActor()).tenantId);
          await tick();
        }
        return ids;
      });
    const { result } = await measure(() => Promise.all([run(A.tenantId), run(B.tenantId)]));
    expect(result).toEqual([
      [A.tenantId, A.tenantId, A.tenantId],
      [B.tenantId, B.tenantId, B.tenantId],
    ]);
    expect(resolutions()).toBe(2);
  });

  it("(3) switchTenant dentro del mismo request invalida la memo: el getActor siguiente es del consultorio nuevo", async () => {
    const u = await multiUser();
    const { result } = await measure(() =>
      inRequest({ user: u, cookies: { [TENANT_COOKIE]: A.tenantId } }, async () => {
        const before = await getActor();
        const again = await getActor();
        const r = await switchTenant(B.tenantId);
        const after = await getActor();
        const afterAgain = await getActor();
        return { before, again, r, after, afterAgain };
      })
    );
    expect(result.r).toEqual({ ok: true, data: undefined });
    expect(result.before.tenantId).toBe(A.tenantId);
    expect(result.again).toBe(result.before);
    expect(result.after.tenantId).toBe(B.tenantId);
    expect(result.after.practitionerId).not.toBe(result.before.practitionerId);
    expect(result.afterAgain).toBe(result.after);
  });

  it("otro usuario en el mismo request (sesión nueva a mitad de camino, sin `session_id`): el actor es el del usuario nuevo", async () => {
    const { result } = await measure(() =>
      inRequest({ user: A.userId }, async () => {
        const first = await getActor();
        (requestAsyncStorage.getStore() as unknown as FakeStore).__user = fakeUser(B.userId);
        const second = await getActor();
        return { first, second };
      })
    );
    expect(result.first).toMatchObject({ tenantId: A.tenantId, userId: A.userId });
    expect(result.second).toMatchObject({ tenantId: B.tenantId, userId: B.userId });
    expect(resolutions()).toBe(2);
  });

  it("(4) fuera de Next (sin store): cada getActor resuelve, sin memo", async () => {
    asUser(A.userId);
    await measure(async () => {
      for (let i = 0; i < 3; i++) await getActor();
    });
    expect(resolutions()).toBe(3);
  });

  it("un resultado negativo NO se memoiza: alta de la membresía en el mismo request → el getActor siguiente entra", async () => {
    const u = await newUser("Sin Consultorio");
    const out = await inRequest({ user: u }, async () => {
      const first = await getActor().catch((e: unknown) => e);
      await join(u, A);
      const second = await getActor();
      return { first, second };
    });
    expect(out.first).toBeInstanceOf(UnauthenticatedError);
    expect(out.second).toMatchObject({ tenantId: A.tenantId, userId: u });
  });

  it("sin sesión: nada se memoiza (ni el actor demo de dev, si `KINESOFT_ALLOW_DEMO_ACTOR=1`)", async () => {
    const out = await measure(() => inRequest({ user: null }, async () => [await tryGetActor(), await tryGetActor()]));
    expect(resolutions()).toBe(0);
    const [a, b] = out.result;
    if (a === null) {
      expect(b).toBeNull();
    } else {
      // Demo encendido en `.env.local`: mismo consultorio, pero resuelto de nuevo en cada llamada (sin memo).
      expect(b?.tenantId).toBe(a.tenantId);
      expect(b).not.toBe(a);
    }
  });

  it("membresía deshabilitada: el request siguiente ya no entra (la memo no cruza requests)", async () => {
    const u = await newUser();
    await join(u, A);
    const ok = await inRequest({ user: u }, () => getActor());
    expect(ok.tenantId).toBe(A.tenantId);
    await db.membership.update({ where: { userId_tenantId: { userId: u, tenantId: A.tenantId } }, data: { disabledAt: new Date() } });
    const next = await inRequest({ user: u }, () => getActor().catch((e: unknown) => e));
    expect(next).toBeInstanceOf(UnauthenticatedError);
  });

  it("usuario deshabilitado en la plataforma: el request siguiente ya no entra", async () => {
    const u = await newUser();
    await join(u, A);
    expect((await inRequest({ user: u }, () => getActor())).userId).toBe(u);
    await db.userProfile.update({ where: { id: u }, data: { disabledAt: new Date() } });
    expect(await inRequest({ user: u }, () => tryGetActor())).toBeNull();
  });

  it("modo solo lectura: en un acierto de la memo el request sigue en solo lectura", async () => {
    process.env.TENANT_ACCESS_ENFORCEMENT = "enforce";
    const C = await createEphemeralTenant(db);
    try {
      await db.tenant.update({ where: { id: C.tenantId }, data: { subscriptionStatus: "CANCELLED" } });
      const { result } = await measure(() =>
        inRequest({ user: C.userId }, async () => {
          const a = await getActor();
          const b = await getActor();
          return { a, b, readOnly: getRequestContext()?.readOnly };
        })
      );
      expect(result.b).toBe(result.a);
      expect(result.a.access.mode).toBe("read_only");
      expect(result.readOnly).toBe(true);
      expect(resolutions()).toBe(1);
    } finally {
      await C.cleanup();
    }
  });
});
