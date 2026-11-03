/**
 * [CF2-S2X] CF2 (§29, D-CF2-12; brief T.C «Sign-out»): al cerrar sesión se borra el dispositivo de push de ESTE
 * navegador (cookie `ks_push_sub`) y se limpia la cookie. Si no, el teléfono de una PC/celular compartido seguía
 * recibiendo los avisos de turnos de la persona que ya se fue. Cubre también el cierre por inactividad: el cliente
 * (`components/layout/idle-logout.tsx`) postea a esta misma ruta.
 *
 * La ruta REAL `POST /api/auth/sign-out` contra Postgres, con `prismaService` y la tabla `PushSubscription` reales
 * (M21, SERVICE_ONLY: corre igual en `test:integration` y en `:owner`). Se mockea solo lo externo: la red de Supabase
 * (quién es el usuario; `signOut` OK) y `next/headers` (un jar que registra las opciones de cada `set`).
 *
 *   [CF2-S2X-6] Cookie con el id de un dispositivo propio → se borra ESE (los otros del usuario quedan) y la cookie se
 *               limpia con las mismas opciones con que se escribió (httpOnly, lax, path=/).
 *   [CF2-S2X-7] Cookie con el id de un dispositivo AJENO → no se toca; la cookie se limpia igual.
 *   [CF2-S2X-8] La base falla → el sign-out sigue (303 al login, sesión cerrada, cookie limpia) y el log no trae el
 *               endpoint (es una URL-capacidad).
 *   [CF2-S2X-9] Sin sesión (token vencido) → no borra nada; la cookie se limpia.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Opts = Record<string, unknown>;
const jar = vi.hoisted(() => ({
  values: new Map<string, string>(),
  sets: [] as Array<{ name: string; value: string; options: Opts }>,
}));
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) => (jar.values.has(name) ? { name, value: jar.values.get(name)! } : undefined),
    getAll: () => [...jar.values].map(([name, value]) => ({ name, value })),
    has: (name: string) => jar.values.has(name),
    set: (name: string, value: string, options: Opts = {}) => {
      jar.sets.push({ name, value, options });
      if (options.maxAge === 0) jar.values.delete(name);
      else jar.values.set(name, value);
    },
    delete: (name: string) => void jar.values.delete(name),
  }),
  headers: () => new Headers({ "x-request-id": "integration-test", "user-agent": "vitest" }),
}));
const sb = vi.hoisted(() => ({ signOuts: 0 }));
vi.mock("@/lib/supabase/server", async () => {
  const { currentTestUser: who } = await import("@/tests/helpers/actor");
  return {
    getSupabaseServerClient: () => ({
      auth: {
        getUser: async () => ({ data: { user: who() }, error: null }),
        signOut: async () => {
          sb.signOuts++;
          return { error: null };
        },
      },
    }),
  };
});

import type { PrismaClient } from "@prisma/client";
import { POST as signOut } from "@/app/api/auth/sign-out/route";
import { prismaService } from "@/lib/db";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { PUSH_SUB_COOKIE } from "@/lib/web-push-types";
import { asAnonymous, asUser } from "@/tests/helpers/actor";
import { addPractitioner, createEphemeralTenant, ownerClient, sweepOrphanTestTenants, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const ORIGIN = new URL(env.NEXT_PUBLIC_APP_URL).origin;

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const P256DH = b64url(Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 9)]));
const AUTH = b64url(Buffer.alloc(16, 3));

describe.skipIf(!RUN)("[CF2-S2X] sign-out borra el dispositivo de push de este navegador", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let me: { userId: string };
  let other: { userId: string };

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    T = await createEphemeralTenant(db);
    me = await addPractitioner(db, T, "PRACTITIONER");
    other = await addPractitioner(db, T, "PRACTITIONER");
  });
  afterAll(async () => {
    await prismaService.pushSubscription.deleteMany({ where: { userId: { in: [me?.userId, other?.userId].filter(Boolean) as string[] } } });
    await T?.cleanup();
    await db?.$disconnect();
  });
  beforeEach(() => {
    jar.values.clear();
    jar.sets.length = 0;
    sb.signOuts = 0;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    asAnonymous();
    await prismaService.pushSubscription.deleteMany({ where: { userId: { in: [me.userId, other.userId] } } });
  });

  async function addDevice(userId: string) {
    return prismaService.pushSubscription.create({
      data: { userId, endpoint: `https://fcm.googleapis.com/fcm/send/cf2s2x-out-${uniqueSuffix()}`, p256dh: P256DH, auth: AUTH },
      select: { id: true, endpoint: true },
    });
  }
  const post = () => signOut(new Request(`${ORIGIN}/api/auth/sign-out`, { method: "POST", headers: { origin: ORIGIN } }));
  const exists = async (id: string) => (await prismaService.pushSubscription.count({ where: { id } })) === 1;
  /** La cookie quedó borrada con las opciones con que la escribe `savePushSubscription` (si no, el navegador no la pisa). */
  function expectCookieCleared() {
    expect(jar.values.has(PUSH_SUB_COOKIE)).toBe(false);
    const set = jar.sets.find((x) => x.name === PUSH_SUB_COOKIE);
    expect(set).toBeDefined();
    expect(set!.value).toBe("");
    expect(set!.options).toMatchObject({ maxAge: 0, path: "/", httpOnly: true, sameSite: "lax" });
  }

  it("[CF2-S2X-6] cookie con un dispositivo propio → borra solo ese, limpia la cookie y cierra la sesión", async () => {
    const here = await addDevice(me.userId);
    const phone = await addDevice(me.userId);
    asUser(me.userId);
    jar.values.set(PUSH_SUB_COOKIE, here.id);

    const res = await post();
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
    expect(sb.signOuts).toBe(1);
    expect(await exists(here.id)).toBe(false);
    expect(await exists(phone.id)).toBe(true);
    expectCookieCleared();
  });

  it("[CF2-S2X-7] cookie con el id de un dispositivo ajeno → no se toca; la cookie se limpia igual", async () => {
    const theirs = await addDevice(other.userId);
    const mine = await addDevice(me.userId);
    asUser(me.userId);
    jar.values.set(PUSH_SUB_COOKIE, theirs.id);

    const res = await post();
    expect(res.status).toBe(303);
    expect(await exists(theirs.id)).toBe(true);
    expect(await exists(mine.id)).toBe(true);
    expectCookieCleared();
  });

  it("[CF2-S2X-8] la base falla → el sign-out sigue (303, signOut, cookie limpia) y el log no trae el endpoint", async () => {
    const here = await addDevice(me.userId);
    asUser(me.userId);
    jar.values.set(PUSH_SUB_COOKIE, here.id);
    // A mano y no con `vi.spyOn`: el delegate de Prisma es un proxy y `restoreAllMocks` lo dejaba sin `deleteMany`
    // (rompía el resto del fork, que es uno solo). Se restaura en el `finally`.
    const delegate = prismaService.pushSubscription;
    const original = delegate.deleteMany;
    let attempts = 0;
    delegate.deleteMany = (() => {
      attempts += 1;
      return Promise.reject(new Error(`boom ${here.endpoint}`));
    }) as never;
    const logs: unknown[] = [];
    for (const lvl of ["info", "warn", "error"] as const) {
      vi.spyOn(logger, lvl).mockImplementation(((msg: string, ctx?: unknown) => void logs.push({ msg, ctx })) as never);
    }

    let res: Response;
    try {
      res = await post();
    } finally {
      delegate.deleteMany = original;
    }
    expect(attempts).toBe(1);
    expect(typeof prismaService.pushSubscription.deleteMany).toBe("function");
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
    expect(sb.signOuts).toBe(1);
    expectCookieCleared();
    expect(JSON.stringify(logs)).toContain("push.sign_out_cleanup_failed");
    expect(JSON.stringify(logs)).not.toContain(here.endpoint);
    expect(JSON.stringify(logs)).not.toContain("fcm.googleapis.com");
  });

  it("[CF2-S2X-9] sin sesión → no borra nada; la cookie se limpia", async () => {
    const here = await addDevice(me.userId);
    asAnonymous();
    jar.values.set(PUSH_SUB_COOKIE, here.id);

    const res = await post();
    expect(res.status).toBe(303);
    expect(await exists(here.id)).toBe(true);
    expectCookieCleared();
  });
});
