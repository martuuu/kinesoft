/**
 * P0-Ct — `tests/helpers/advisory-wait.ts` contra Postgres real.
 *
 * Lo que importa probar del helper es que NO da falso verde: tiene que ver al
 * waiter de SU clave (exclusivo y shared), ignorar a los de otras claves y al
 * holder (granted), y tirar si nadie se bloquea. Las claves son únicas por
 * corrida (`uniqueSuffix`) para no cruzarse con otra suite en la misma base.
 *
 * Corre con los dos roles: el holder/waiter usan conexiones del owner (no
 * importa quién toma un advisory lock) y las consultas a `pg_locks` se hacen
 * también con el cliente de la APP (`DATABASE_URL`: kinesoft_app en
 * test:integration), porque los tests de carrera la consultan con ese rol.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { ownerClient, uniqueSuffix } from "@/tests/helpers/tenant-factory";
import { countAdvisoryWaiters, waitForAdvisoryWaiter } from "@/tests/helpers/advisory-wait";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("advisory-wait (waiter filtrado por clave)", () => {
  let holderDb: PrismaClient;
  let waiterDb: PrismaClient;
  let appDb: PrismaClient;

  beforeAll(() => {
    // Clientes separados: el holder y el waiter necesitan conexiones propias.
    holderDb = ownerClient();
    waiterDb = ownerClient();
    appDb = new PrismaClient();
  });

  afterAll(async () => {
    await Promise.all([holderDb?.$disconnect(), waiterDb?.$disconnect(), appDb?.$disconnect()]);
  });

  /** Toma el lock de `key` en una tx abierta hasta que se llame `release()`. */
  async function hold(key: string, shared = false) {
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let acquired!: () => void;
    const got = new Promise<void>((r) => (acquired = r));
    const done = holderDb.$transaction(
      async (tx) => {
        if (shared) await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`;
        else await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
        acquired();
        await released;
      },
      { timeout: 20_000 },
    );
    await got;
    return { release, done };
  }

  /** Pide el lock exclusivo de `key` (queda bloqueado si alguien lo tiene). */
  function waitOn(key: string) {
    return waiterDb.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
        return "ok" as const;
      },
      { timeout: 20_000 },
    );
  }

  it("ve al waiter de su clave (y no cuenta al holder)", async () => {
    const key = `kinesoft:test:aw:${uniqueSuffix()}`;
    const h = await hold(key);
    try {
      // Solo el holder (granted): 0 waiters.
      expect(await countAdvisoryWaiters(appDb, key)).toBe(0);
      const pending = waitOn(key);
      await waitForAdvisoryWaiter(appDb, key);
      expect(await countAdvisoryWaiters(appDb, key)).toBe(1);
      h.release();
      await h.done;
      expect(await pending).toBe("ok");
      expect(await countAdvisoryWaiters(appDb, key)).toBe(0);
    } finally {
      h.release();
      await h.done.catch(() => {});
    }
  });

  it("ignora waiters de otra clave: con uno bloqueado en X, esperar Y tira por timeout", async () => {
    const x = `kinesoft:test:aw:x:${uniqueSuffix()}`;
    const y = `kinesoft:test:aw:y:${uniqueSuffix()}`;
    const h = await hold(x);
    try {
      const pending = waitOn(x);
      await waitForAdvisoryWaiter(appDb, x);
      // El patrón global viejo daría > 0 acá; el filtrado por clave no.
      expect(await countAdvisoryWaiters(appDb, y)).toBe(0);
      await expect(waitForAdvisoryWaiter(appDb, y, { timeoutMs: 200 })).rejects.toThrow(/0\/1 waiters/);
      h.release();
      await h.done;
      await pending;
    } finally {
      h.release();
      await h.done.catch(() => {});
    }
  });

  it("ve a un waiter exclusivo detrás de un holder shared (lock_shared)", async () => {
    const key = `kinesoft:test:aw:sh:${uniqueSuffix()}`;
    const h = await hold(key, true);
    try {
      const pending = waitOn(key);
      await waitForAdvisoryWaiter(appDb, key);
      h.release();
      await h.done;
      expect(await pending).toBe("ok");
    } finally {
      h.release();
      await h.done.catch(() => {});
    }
  });

  it("minWaiters: espera a que haya N bloqueados", async () => {
    const key = `kinesoft:test:aw:n:${uniqueSuffix()}`;
    const extra = ownerClient();
    const h = await hold(key);
    try {
      const p1 = waitOn(key);
      const p2 = extra.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      });
      await waitForAdvisoryWaiter(appDb, key, { minWaiters: 2 });
      expect(await countAdvisoryWaiters(appDb, key)).toBe(2);
      h.release();
      await h.done;
      await Promise.all([p1, p2]);
    } finally {
      h.release();
      await h.done.catch(() => {});
      await extra.$disconnect();
    }
  });
});
