/**
 * SV04b · `mintRealtimeToken` y `realtimeBootstrap` contra Postgres real (plan §18.8
 * fila SV04b, C-SV5).
 *
 * Corre el `getActor()` REAL (rol leído de Membership) y el `rateLimit` REAL (backend
 * en memoria). Lo único que se toca es el ENV: el módulo `@/lib/env` se envuelve en un
 * Proxy que sobreescribe solo las claves de realtime (driver, secreto de TEST, kid,
 * URL/anon públicas) y apaga Upstash para que el contador sea el de memoria. Nunca
 * se lee ni se imprime un valor del `.env` real.
 *
 * Cruce con M5: los claims del token que acuña la action se pasan, tal cual, a
 * `public.kinesoft_realtime_can_read(topic, claims)` por SQL (cliente owner, molde
 * `reception-call-m5.test.ts`). Es lo que garantiza que el token que firmamos es el
 * que la policy de `realtime.messages` deja leer, y solo para su consultorio.
 *
 * Corre igual con `test:integration` (kinesoft_app) y `test:integration:owner`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { Env } from "@/lib/env";

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

// FX1b · error no tipado: el rate limit "se cae" una vez a pedido (registro a
// mano, sin `vi.fn` que tire: vitest 2.1.9). Con `failNext` en false es el real.
const rl = vi.hoisted(() => ({ failNext: false, calls: 0 }));
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return {
    ...actual,
    rateLimit: (...args: Parameters<typeof actual.rateLimit>) => {
      rl.calls++;
      if (rl.failNext) {
        rl.failNext = false;
        return Promise.reject(new Error("redis caído"));
      }
      return actual.rateLimit(...args);
    },
  };
});

import { mintRealtimeToken } from "@/lib/realtime-token";
import { realtimeBootstrap } from "@/lib/realtime-bootstrap";
import { verifyRealtimeToken } from "@/lib/realtime-token-internal";
import { topicFor } from "@/lib/realtime-constants";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { getActor } from "@/lib/session";
import { MODULE_DENIED_COPY } from "@/lib/tenant-modules";
import { asUser } from "@/tests/helpers/actor";
import {
  addPractitioner,
  createEphemeralTenant,
  ownerClient,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

const SECRET = "integration-test-secret-not-a-real-key-0123456789";
const URL_PUB = "https://example-test.supabase.co";
const ANON = "test-anon-key";

function setEnv(v: Partial<Record<keyof Env, unknown>>): void {
  over.values = {
    // Upstash apagado: el contador del rate limit es el de memoria (reseteable).
    UPSTASH_REDIS_REST_URL: undefined,
    UPSTASH_REDIS_REST_TOKEN: undefined,
    REALTIME_DRIVER: "off",
    SUPABASE_JWT_SECRET: undefined,
    SUPABASE_JWT_KID: undefined,
    NEXT_PUBLIC_SUPABASE_URL: URL_PUB,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON,
    ...v,
  };
}
const SUPA = { REALTIME_DRIVER: "supabase", SUPABASE_JWT_SECRET: SECRET } as const;

function claimsOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
}

describe.skipIf(!RUN)("SV04b · mintRealtimeToken", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let assistantId: string;
  let billingId: string;
  let practitionerId: string;

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
    assistantId = (await addPractitioner(db, A, "ASSISTANT")).userId;
    billingId = (await addPractitioner(db, A, "BILLING")).userId;
    practitionerId = (await addPractitioner(db, A, "PRACTITIONER")).userId;
  });
  afterAll(async () => {
    over.values = {};
    await A?.cleanup();
    await B?.cleanup();
    await db?.$disconnect();
  });
  beforeEach(() => {
    __rateLimitInternals.reset();
    mods.drop.clear();
    setEnv({});
  });

  it("driver off → {ok:false, error:'realtime-off'}", async () => {
    asUser(A.userId);
    expect(await mintRealtimeToken()).toEqual({ ok: false, error: "realtime-off" });
  });

  it("driver local → {ok:false, error:'realtime-off'} (local usa SSE, no token)", async () => {
    setEnv({ REALTIME_DRIVER: "local", SUPABASE_JWT_SECRET: SECRET });
    asUser(A.userId);
    expect(await mintRealtimeToken()).toEqual({ ok: false, error: "realtime-off" });
  });

  it("supabase sin secreto → {ok:false} (sin tirar)", async () => {
    setEnv({ REALTIME_DRIVER: "supabase" });
    asUser(A.userId);
    expect(await mintRealtimeToken()).toEqual({ ok: false, error: "realtime-unconfigured" });
  });

  it("OWNER, ASSISTANT y PRACTITIONER obtienen un token válido de SU consultorio", async () => {
    setEnv(SUPA);
    for (const uid of [A.userId, assistantId, practitionerId]) {
      asUser(uid);
      const before = Date.now();
      const r = await mintRealtimeToken();
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      const c = verifyRealtimeToken(r.data.token, SECRET);
      expect(c?.tenant_id).toBe(A.tenantId);
      // expiresAt viaja como ISO y es iat + 600 s.
      const exp = new Date(r.data.expiresAt).getTime();
      expect(r.data.expiresAt).toBe(new Date(exp).toISOString());
      expect(exp).toBe(c!.exp * 1000);
      expect(exp - before).toBeGreaterThan(590_000);
      expect(exp - before).toBeLessThanOrEqual(601_000);
    }
  });

  it("con SUPABASE_JWT_KID lo pone en el header; vacío = sin kid", async () => {
    asUser(A.userId);
    setEnv({ ...SUPA, SUPABASE_JWT_KID: "kid-staging-1" });
    let r = await mintRealtimeToken();
    if (!r.ok) throw new Error(r.error);
    expect(JSON.parse(Buffer.from(r.data.token.split(".")[0], "base64url").toString())).toEqual({
      alg: "HS256",
      typ: "JWT",
      kid: "kid-staging-1",
    });
    setEnv({ ...SUPA, SUPABASE_JWT_KID: "" });
    r = await mintRealtimeToken();
    if (!r.ok) throw new Error(r.error);
    expect(JSON.parse(Buffer.from(r.data.token.split(".")[0], "base64url").toString())).toEqual({
      alg: "HS256",
      typ: "JWT",
    });
  });

  it("[FX1b] tenant sin el módulo salaEspera → {ok:false} con el copy del módulo (aunque el driver sea supabase)", async () => {
    setEnv(SUPA);
    asUser(A.userId);
    mods.drop.add("salaEspera");
    try {
      expect(await mintRealtimeToken()).toEqual({ ok: false, error: MODULE_DENIED_COPY.salaEspera });
    } finally {
      mods.drop.clear();
    }
    // Control: el mismo actor con el módulo sí obtiene token (el rojo es por el módulo).
    expect((await mintRealtimeToken()).ok).toBe(true);
  });

  it("[FX1b] un error no tipado adentro (rate limit caído) → {ok:false, error:'realtime-error'}, sin tirar", async () => {
    setEnv(SUPA);
    asUser(A.userId);
    rl.calls = 0;
    rl.failNext = true;
    try {
      await expect(mintRealtimeToken()).resolves.toEqual({ ok: false, error: "realtime-error" });
      // Llegó al rate limit (no cortó antes por driver o módulo).
      expect(rl.calls).toBe(1);
    } finally {
      rl.failNext = false;
    }
  });

  it("BILLING (sin agenda.reception) → {ok:false}", async () => {
    setEnv(SUPA);
    asUser(billingId);
    // Por el error exacto: un `{ok:false}` por driver o rate limit daría verde igual.
    expect(await mintRealtimeToken()).toEqual({ ok: false, error: "No tenés acceso a la sala de espera en vivo." });
  });

  // BO2-D (C-BO1 `publicSurfacesOpen`, modo EFECTIVO): consultorio en solo lectura bajo `enforce` → sin token
  // (el cliente degrada a polling, que lee igual). Con `banner` (default) el trial vencido solo se avisa.
  it("[BO2-D] trial vencido: token con banner; sin token (y sin gastar cupo) con enforce", async () => {
    setEnv(SUPA);
    asUser(B.userId);
    const prev = process.env.TENANT_ACCESS_ENFORCEMENT;
    try {
      await db.tenant.update({
        where: { id: B.tenantId },
        data: { subscriptionStatus: "TRIALING", trialEndsAt: new Date(Date.now() - 30 * 86_400_000) },
      });
      process.env.TENANT_ACCESS_ENFORCEMENT = "banner";
      expect((await mintRealtimeToken()).ok).toBe(true);
      process.env.TENANT_ACCESS_ENFORCEMENT = "enforce";
      const calls = rl.calls;
      expect(await mintRealtimeToken()).toEqual({ ok: false, error: "realtime-off" });
      expect(rl.calls).toBe(calls);
      // En gracia (vencido hace 2 días) sí.
      await db.tenant.update({ where: { id: B.tenantId }, data: { trialEndsAt: new Date(Date.now() - 2 * 86_400_000) } });
      expect((await mintRealtimeToken()).ok).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.TENANT_ACCESS_ENFORCEMENT;
      else process.env.TENANT_ACCESS_ENFORCEMENT = prev;
      await db.tenant.update({ where: { id: B.tenantId }, data: { subscriptionStatus: "ACTIVE", trialEndsAt: null } });
    }
  });

  it("rate limit: 30 en la ventana pasan, el 31.º → {ok:false}", async () => {
    setEnv(SUPA);
    asUser(assistantId);
    for (let i = 0; i < 30; i++) {
      const r = await mintRealtimeToken();
      expect(r.ok, `llamada ${i + 1}`).toBe(true);
    }
    const r31 = await mintRealtimeToken();
    expect(r31.ok).toBe(false);
    if (!r31.ok) expect(r31.error).toMatch(/^Demasiados intentos/);
    // El cupo es por usuario: otro usuario del mismo consultorio sigue pudiendo.
    asUser(A.userId);
    expect((await mintRealtimeToken()).ok).toBe(true);
  });

  it("cruce con M5: los claims pasan kinesoft_realtime_can_read para su topic y no para otro tenant", async () => {
    setEnv(SUPA);
    asUser(A.userId);
    const r = await mintRealtimeToken();
    if (!r.ok) throw new Error(r.error);
    const claims = JSON.stringify(claimsOf(r.data.token));
    const can = async (topic: string) => {
      const rows = await db.$queryRawUnsafe<{ ok: boolean | null }[]>(
        "select public.kinesoft_realtime_can_read($1, $2::jsonb) as ok",
        topic,
        claims
      );
      return rows[0].ok;
    };
    expect(await can(topicFor(A.tenantId))).toBe(true);
    expect(await can(topicFor(B.tenantId))).toBe(false);
    expect(await can(`tenant:${A.tenantId}:tv`)).toBe(false);
  });
});

describe.skipIf(!RUN)("SV04b · realtimeBootstrap", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let billingId: string;

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    billingId = (await addPractitioner(db, A, "BILLING")).userId;
  });
  afterAll(async () => {
    over.values = {};
    await A?.cleanup();
    await db?.$disconnect();
  });
  beforeEach(() => setEnv({}));

  it("off → {driver:'off', tenantId} sin url ni anonKey", async () => {
    asUser(A.userId);
    expect(await realtimeBootstrap(await getActor())).toEqual({ driver: "off", tenantId: A.tenantId });
  });

  it("local → {driver:'local', tenantId} sin url ni anonKey", async () => {
    setEnv({ REALTIME_DRIVER: "local" });
    asUser(A.userId);
    expect(await realtimeBootstrap(await getActor())).toEqual({ driver: "local", tenantId: A.tenantId });
  });

  it("supabase → url y anonKey públicas (nunca el secreto ni la service key)", async () => {
    setEnv({ ...SUPA, SUPABASE_SERVICE_ROLE_KEY: "service-key-de-test" });
    asUser(A.userId);
    const b = await realtimeBootstrap(await getActor());
    expect(b).toEqual({ driver: "supabase", tenantId: A.tenantId, url: URL_PUB, anonKey: ANON });
    const json = JSON.stringify(b);
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain("service-key-de-test");
  });

  it("supabase sin URL/anon o sin secreto → off (el cliente no tendría con qué conectarse)", async () => {
    asUser(A.userId);
    setEnv({ ...SUPA, NEXT_PUBLIC_SUPABASE_URL: undefined });
    expect((await realtimeBootstrap(await getActor())).driver).toBe("off");
    setEnv({ REALTIME_DRIVER: "supabase" });
    expect((await realtimeBootstrap(await getActor())).driver).toBe("off");
  });

  it("[FX1b] tenant sin el módulo salaEspera → off con supabase y con local", async () => {
    asUser(A.userId);
    mods.drop.add("salaEspera");
    try {
      setEnv(SUPA);
      expect(await realtimeBootstrap(await getActor())).toEqual({ driver: "off", tenantId: A.tenantId });
      setEnv({ REALTIME_DRIVER: "local" });
      expect(await realtimeBootstrap(await getActor())).toEqual({ driver: "off", tenantId: A.tenantId });
    } finally {
      mods.drop.clear();
    }
  });

  it("BILLING → off aunque el driver sea supabase", async () => {
    setEnv(SUPA);
    asUser(billingId);
    expect(await realtimeBootstrap(await getActor())).toEqual({ driver: "off", tenantId: A.tenantId });
  });
});
