/**
 * PF2 (C-PF8, brief-pf §2.4) · presupuesto de transacciones por camino. Este archivo es de PF2-e: el caso «server
 * action cualquiera → ≤ 1 resolución de actor (≤ 1 query de servicio)». Las demás sesiones de PF2 ponen su caso en
 * `pf2-<area>-budget.test.ts`.
 *
 * Símbolos REALES: la action `createSupportThread` (lib/support-threads.ts) y `getActor`/`requireModule`/
 * `getCapabilities` contra Postgres, en los dos roles (`test:integration` y `:owner`). Contador real
 * (`tests/helpers/query-counter.ts`) sobre `prisma`/`prismaService`. Lo único que se arma a mano es el store de
 * `requestAsyncStorage` que Next abre por request (sin él no hay request: es el caso «fuera de Next»).
 *
 * `createSupportThread` pide el actor DOS veces por diseño (`withAccountWritable` → `tryGetActor`, y adentro
 * `requireSupportWriter` → `getActor`): sin la memo eran 2 lecturas de acceso por el canal de servicio (se fija abajo
 * como línea de base fuera de un request, así el test no queda verde por un camino que pide el actor una sola vez).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// `next start` instala `globalThis.AsyncLocalStorage`; el store de Next lo necesita para `run`.
vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  (globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;
});

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { installQueryCounter } = await import("@/tests/helpers/query-counter");
  return { ...actual, ...installQueryCounter() };
});

import { requestAsyncStorage } from "next/dist/client/components/request-async-storage.external";
import type { PrismaClient } from "@prisma/client";
import { getActor, tryGetActor } from "@/lib/session";
import { getCapabilities, requireModule } from "@/lib/authz";
import { createSupportThread } from "@/lib/support-threads";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { measure } from "@/tests/helpers/query-counter";
import { asUser } from "@/tests/helpers/actor";
import { ownerClient, createEphemeralTenant, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

// El registro global del contador (`measure` lo vacía al empezar y lo deja lleno al terminar).
const rec = (globalThis as unknown as { __kineQueryRecorder: { events: Array<{ query: string; client: string }> } })
  .__kineQueryRecorder;

/** La lectura de acceso de `loadAccessMemberships` (lib/session.ts): una por resolución de actor. */
function actorResolutions(): number {
  return rec.events.filter((e) => e.client === "service" && /FROM "UserProfile" u\s/.test(e.query)).length;
}

/** Corre `fn` como un request de Next (store propio de `requestAsyncStorage`, igual que una server action). */
function inRequest<T>(fn: () => Promise<T>): Promise<T> {
  return requestAsyncStorage.run({} as never, fn);
}


describe.skipIf(!RUN)("[PF2-e] presupuesto: ≤ 1 resolución de actor por server action", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  const prevInbox = process.env.PLATFORM_INBOX_EMAIL;

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    // Sin bandeja de Plataforma el aviso no sale (`notifyPlatform` lo saltea): el test no depende del mail.
    delete process.env.PLATFORM_INBOX_EMAIL;
  });

  afterAll(async () => {
    if (prevInbox !== undefined) process.env.PLATFORM_INBOX_EMAIL = prevInbox;
    await A?.cleanup();
    await db?.$disconnect();
  });

  beforeEach(() => {
    __rateLimitInternals.reset();
    asUser(A.userId);
  });

  it("línea de base fuera de un request (scripts/unit): createSupportThread resuelve el actor 2 veces", async () => {
    const { result } = await measure(() => createSupportThread({ subject: `Base ${uniqueSuffix()}`, body: "Hola" }));
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(actorResolutions()).toBe(2);
  });

  it("dentro de un request: la MISMA action resuelve el actor 1 vez (1 query de servicio de acceso)", async () => {
    const { result } = await measure(() =>
      inRequest(() => createSupportThread({ subject: `Memo ${uniqueSuffix()}`, body: "Hola" }))
    );
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(actorResolutions()).toBe(1);
    // El hilo quedó escrito por el actor correcto (el efecto no cambia con la memo).
    if (result.ok) {
      const t = await db.supportThread.findUniqueOrThrow({ where: { id: result.data.threadId } });
      expect(t).toMatchObject({ tenantId: A.tenantId, createdById: A.userId });
    }
  });

  it("N llamadas al actor (getActor, tryGetActor, requireModule, getCapabilities) en un request = 1 resolución", async () => {
    const { result } = await measure(() =>
      inRequest(async () => {
        const a = await getActor();
        const b = await tryGetActor();
        const c = await requireModule("pacientes");
        await getCapabilities();
        const [d, e] = await Promise.all([getActor(), getActor()]);
        return [a, b, c, d, e];
      })
    );
    expect(actorResolutions()).toBe(1);
    for (const x of result) expect(x).toBe(result[0]);
    expect(result[0]).toMatchObject({ tenantId: A.tenantId, userId: A.userId });
  });
});
