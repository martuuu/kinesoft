/**
 * SV07b · ruta SSE del driver local (`app/api/realtime/local/route.ts`) contra
 * Postgres real (§18.8 fila SV07b).
 *
 * Corre el `tryGetActor()` REAL (rol leído de Membership) y el bus en memoria
 * REAL. Lo único que se toca es `REALTIME_DRIVER` vía un Proxy sobre `@/lib/env`
 * (molde `realtime-token.test.ts`); nunca se lee un valor del `.env` real.
 *
 * Corre igual con `test:integration` (kinesoft_app) y `test:integration:owner`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

// El 401 real: en dev/test `.env.local` habilita el actor demo y `tryGetActor()`
// caería al tenant demo en vez de devolver null (ver availability-actions.test).
// `DEMO_ALLOWED` se lee al cargar `lib/session`, así que se apaga ANTES de los
// imports (vi.hoisted) y solo en este archivo (cada archivo tiene su registro de
// módulos). Así el «sin actor» es el de prod, donde el demo nunca está.
const demo = vi.hoisted(() => {
  const prev = process.env.KINESOFT_ALLOW_DEMO_ACTOR;
  process.env.KINESOFT_ALLOW_DEMO_ACTOR = "0";
  return { prev };
});
const over = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));
vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  const env = new Proxy(actual.env, {
    get: (t, k: string) => (k in over.values ? over.values[k] : (t as Record<string, unknown>)[k]),
  });
  return { ...actual, env };
});

// FX1b · gate de módulo: `salaEspera` es CORE en todas las verticales, así que
// no hay tenant real sin él. Se envuelve `modulesFor` (la matriz, no la función
// bajo test) para sacarle módulos a pedido; con `drop` vacío es el real.
const mods = vi.hoisted(() => ({ drop: new Set<string>() }));
vi.mock("@/lib/tenant-modules", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenant-modules")>();
  return {
    ...actual,
    modulesFor: (e: Parameters<typeof actual.modulesFor>[0]) => {
      const s = new Set(actual.modulesFor(e));
      for (const m of mods.drop) s.delete(m as never);
      return s;
    },
  };
});

import { GET } from "@/app/api/realtime/local/route";
import { emit, listenerCount } from "@/lib/realtime-local-bus";
import type { RealtimeAgendaMessage } from "@/lib/realtime-events";
import { asAnonymous, asUser } from "@/tests/helpers/actor";
import {
  addPractitioner,
  createEphemeralTenant,
  ownerClient,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

function req(ctrl = new AbortController()) {
  return new Request("http://localhost:3000/api/realtime/local", { signal: ctrl.signal });
}

const MSG: RealtimeAgendaMessage = {
  v: 1,
  kind: "reception",
  bookingId: "b1",
  practitionerId: null,
  day: "2026-10-13",
  at: "2026-10-13T12:00:00.000Z",
};

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const r = await Promise.race([
    reader.read(),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout leyendo el stream")), 2000)),
  ]);
  return r.done ? "" : new TextDecoder().decode(r.value);
}

describe.skipIf(!RUN)("SV07b · GET /api/realtime/local", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let billingId: string;

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db, { saasPlan: "CLINICA" }); // PL-1: sala de espera y equipo son de Clínica
    B = await createEphemeralTenant(db, { saasPlan: "CLINICA" }); // PL-1: sala de espera y equipo son de Clínica
    billingId = (await addPractitioner(db, A, "BILLING")).userId;
  });
  afterAll(async () => {
    over.values = {};
    if (demo.prev === undefined) delete process.env.KINESOFT_ALLOW_DEMO_ACTOR;
    else process.env.KINESOFT_ALLOW_DEMO_ACTOR = demo.prev;
    await A?.cleanup();
    await B?.cleanup();
    await db?.$disconnect();
  });
  beforeEach(() => {
    over.values = { REALTIME_DRIVER: "local" };
    mods.drop.clear();
  });

  it("driver off → 404 (aunque haya sesión)", async () => {
    over.values = { REALTIME_DRIVER: "off" };
    asUser(A.userId);
    expect((await GET(req())).status).toBe(404);
    over.values = { REALTIME_DRIVER: "supabase" };
    expect((await GET(req())).status).toBe(404);
  });

  it("sin actor → 401", async () => {
    asAnonymous();
    expect((await GET(req())).status).toBe(401);
  });

  it("BILLING (sin agenda.reception) → 403, sin suscribirse al bus", async () => {
    asUser(billingId);
    const before = listenerCount(A.tenantId);
    expect((await GET(req())).status).toBe(403);
    expect(listenerCount(A.tenantId)).toBe(before);
  });

  it("[FX1b] tenant sin el módulo salaEspera → 403, sin suscribirse al bus", async () => {
    asUser(A.userId);
    const before = listenerCount(A.tenantId);
    mods.drop.add("salaEspera");
    try {
      expect((await GET(req())).status).toBe(403);
    } finally {
      mods.drop.clear();
    }
    expect(listenerCount(A.tenantId)).toBe(before);
  });

  it("actor válido → 200 text/event-stream; un emit de SU consultorio llega, el de otro no; abort desuscribe", async () => {
    asUser(A.userId);
    const ctrl = new AbortController();
    const res = await GET(req(ctrl));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    expect(listenerCount(A.tenantId)).toBe(1);

    const reader = res.body!.getReader();
    // Primer byte inmediato (abre el EventSource) y es un comentario SSE.
    expect(await readChunk(reader)).toBe(": open\n\n");

    // Otro consultorio primero: si se filtrara, sería el próximo chunk.
    emit(B.tenantId, [{ ...MSG, bookingId: "de-otro-consultorio" }]);
    emit(A.tenantId, [MSG]);
    const chunk = await readChunk(reader);
    expect(chunk).toBe(`data: ${JSON.stringify([MSG])}\n\n`);
    expect(chunk).not.toContain("de-otro-consultorio");

    ctrl.abort();
    expect(listenerCount(A.tenantId)).toBe(0);
    // El stream queda cerrado.
    expect((await reader.read()).done).toBe(true);
  });

  it("cancel del lector (pestaña cerrada) también desuscribe", async () => {
    asUser(A.userId);
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(listenerCount(A.tenantId)).toBe(1);
    await res.body!.cancel();
    expect(listenerCount(A.tenantId)).toBe(0);
  });
});
