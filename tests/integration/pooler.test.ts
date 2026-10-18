/**
 * OPS-1b (plan §21.3) · lo que el código supone del pooler en modo TRANSACCIÓN, probado con un pgbouncer real en el
 * medio (perfil `pooler` de docker-compose.yml, :6433, `pool_mode=transaction`, sin prepared statements).
 *
 * Por qué: prod va por el pooler de Supabase en 6543. Ahí una conexión del cliente NO es una sesión: cada transacción
 * puede caer en otro backend y un backend atiende transacciones de otros requests (y de otros tenants). El repo se
 * apoya en cuatro cosas que solo valen si son locales a la transacción, y toda la suite corría contra Postgres directo:
 *   1. el GUC `app.current_tenant_id` de `runWithRls` (`set_config(..., true)`): si se filtrara, un request vería las
 *      filas de otro consultorio bajo `kinesoft_app`;
 *   2. `pg_advisory_xact_lock` (cupo, sala, día): un lock de SESIÓN quedaría pegado al backend del pool;
 *   3. `SET LOCAL`;
 *   4. `transaction_read_only` (modo lectura, C-BO3): si persistiera, el request siguiente de otro tenant no podría
 *      escribir.
 * Anti-false-green: el control del principio prueba que el pool REUSA el backend (el estado de sesión sí sobrevive
 * entre transacciones); sin eso, «no se filtró» podría ser solo «cayó en otra conexión».
 *
 * Se corre con `npm run test:pooler` (los dos roles, exige el pooler arriba). Dentro de `test:integration` se saltea
 * con aviso si el pooler local está apagado: `docker compose --profile pooler up -d pgbouncer`.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createEphemeralTenant, addPatient, ownerClient, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { POOLER_POOL_SIZE, poolerClient, poolerHolder, probePooler } from "@/tests/helpers/pooler";
import { waitForAdvisoryWaiter } from "@/tests/helpers/advisory-wait";
import { appRoleBypassesRls } from "@/tests/helpers/db-role";
import { runWithRls } from "@/lib/rls";
import { runWithRequestContext } from "@/lib/request-context";
import { ReadOnlyModeError } from "@/lib/tenant-access";
import { capacityLockKey, lockCapacity } from "@/lib/booking-cap-lock";

// Se reemplaza SOLO el transporte (el cliente Prisma de la app pasa a ir por el pgbouncer); `runWithRls`,
// `lockCapacity` y el modo lectura corren tal cual. `prismaService` queda el real (directo).
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { poolerHolder: holder } = await import("@/tests/helpers/pooler");
  const prisma = new Proxy({} as PrismaClient, {
    get(_t, key) {
      const c = holder.current;
      if (!c) throw new Error("[pooler.test] poolerHolder.current sin setear");
      const v = Reflect.get(c, key);
      return typeof v === "function" ? v.bind(c) : v;
    },
  });
  return { ...actual, prisma };
});

const RUN = process.env.INTEGRATION === "1";
const REQUIRED = process.env.POOLER_REQUIRED === "1";
const APP_URL = process.env.DATABASE_URL;

const unavailable = RUN ? await probePooler(APP_URL) : null;
const HINT = "docker compose --profile pooler up -d pgbouncer";
if (RUN && unavailable && !REQUIRED) {
  console.warn(`[pooler.test] SALTEADO: el pooler local no responde (${unavailable}). Para correrlo: ${HINT}`);
}

type Probe = { guc: string | null; pid: number };
const empty = (g: string | null) => g === null || g === "";

// Solo se declara el bloque que aplica (con `runIf` los otros dos sumaban «skipped» aunque el pooler estuviera arriba).
if (RUN && unavailable) {
  describe("[OPS-1b] pooler local", () => {
    if (REQUIRED) {
      it("npm run test:pooler exige el pgbouncer local arriba", () => {
        throw new Error(`el pooler local no responde (${unavailable}). Levantalo con: ${HINT}`);
      });
    } else {
      it.skip(`SALTEADO: pooler local apagado (${HINT})`, () => {});
    }
  });
}

describe.runIf(RUN && !unavailable)("[OPS-1b] pooler en modo transacción", () => {
  let owner: PrismaClient;
  let main: PrismaClient;
  let single: PrismaClient;
  let a: EphemeralTenant;
  let b: EphemeralTenant;
  let patientA: string;
  let patientB: string;
  let bypass: boolean;

  beforeAll(async () => {
    owner = ownerClient();
    // Más conexiones del lado del cliente (6) que del server (3): el pgbouncer TIENE que multiplexar.
    main = poolerClient(APP_URL!, "kinesoft", 6);
    single = poolerClient(APP_URL!, "kinesoft_single", 2);
    bypass = await appRoleBypassesRls();
    a = await createEphemeralTenant(owner, {});
    b = await createEphemeralTenant(owner, {});
    patientA = await addPatient(owner, a);
    patientB = await addPatient(owner, b);
  });

  afterAll(async () => {
    poolerHolder.current = null;
    await a?.cleanup();
    await b?.cleanup();
    await Promise.all([owner?.$disconnect(), main?.$disconnect(), single?.$disconnect()]);
  });

  /** GUC y backend de una sentencia suelta (fuera de toda transacción, autocommit por el pool). */
  async function bare(c: PrismaClient): Promise<Probe> {
    const [r] = await c.$queryRaw<Probe[]>`
      SELECT current_setting('app.current_tenant_id', true) AS guc, pg_backend_pid() AS pid`;
    return r!;
  }

  it("control: el estado de SESIÓN sí sobrevive en el backend del pool (si no, el resto no probaría nada)", async () => {
    const sentinel = `ops1b-${uniqueSuffix()}`;
    try {
      const [s1] = await single.$queryRaw<Probe[]>`
        SELECT set_config('app.current_tenant_id', ${sentinel}, false) AS guc, pg_backend_pid() AS pid`;
      await single.$executeRawUnsafe(`SET statement_timeout = '4321ms'`);
      const s2 = await bare(single);
      const [t] = await single.$queryRaw<{ v: string }[]>`SELECT current_setting('statement_timeout') AS v`;
      expect(s2.pid).toBe(s1!.pid);
      expect(s2.guc).toBe(sentinel);
      expect(t!.v).toBe("4321ms");
    } finally {
      await single.$queryRaw`SELECT set_config('app.current_tenant_id', '', false)`;
      await single.$executeRawUnsafe(`RESET statement_timeout`);
    }
    expect(empty((await bare(single)).guc)).toBe(true);
  });

  it("runWithRls: el GUC es de la transacción y no queda en el backend que la atendió", async () => {
    poolerHolder.current = single;
    const inTx = await runWithRls(a.tenantId, (tx) =>
      tx.$queryRaw<Probe[]>`SELECT current_setting('app.current_tenant_id', true) AS guc, pg_backend_pid() AS pid`
    );
    const after = await bare(single);
    expect(inTx[0]!.guc).toBe(a.tenantId);
    expect(after.pid).toBe(inTx[0]!.pid);
    expect(empty(after.guc)).toBe(true);
  });

  it("runWithRls: 24 transacciones concurrentes de dos tenants sobre 3 backends, sin cruzarse", async () => {
    poolerHolder.current = main;
    const tenants = [a, b];
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, i) => {
        const t = tenants[i % 2]!;
        return runWithRls(
          t.tenantId,
          async (tx) => {
            const [first] = await tx.$queryRaw<Probe[]>`
              SELECT current_setting('app.current_tenant_id', true) AS guc, pg_backend_pid() AS pid`;
            // Un respiro distinto por transacción para que se intercalen en el pool.
            await tx.$executeRaw`SELECT pg_sleep(${(i % 5) * 0.01}::float8)`;
            const seen = await tx.patient.findMany({
              where: { id: { in: [patientA, patientB] } },
              select: { tenantId: true },
            });
            const [last] = await tx.$queryRaw<Probe[]>`
              SELECT current_setting('app.current_tenant_id', true) AS guc, pg_backend_pid() AS pid`;
            return { tenantId: t.tenantId, first: first!, last: last!, seen: seen.map((p) => p.tenantId) };
          },
          { timeout: 20_000, maxWait: 15_000 }
        );
      })
    );

    for (const r of results) {
      expect(r.first.guc).toBe(r.tenantId);
      expect(r.last.guc).toBe(r.tenantId);
      expect(r.last.pid).toBe(r.first.pid); // una transacción = un backend, aun en modo transacción
      // Bajo kinesoft_app la policy filtra por el GUC: cada tx ve SOLO su paciente. El owner (BYPASSRLS) ve los dos.
      if (!bypass) expect(r.seen).toEqual([r.tenantId]);
      else expect(r.seen.sort()).toEqual([a.tenantId, b.tenantId].sort());
    }
    const pids = new Set(results.map((r) => r.first.pid));
    expect(pids.size).toBeLessThanOrEqual(POOLER_POOL_SIZE.kinesoft); // 24 tx en ≤ 3 backends: hubo reuso

    // Después, las sentencias sueltas caen en esos mismos backends y ninguno quedó con un tenant puesto.
    const bares = await Promise.all(Array.from({ length: 12 }, () => bare(main)));
    for (const s of bares) expect(empty(s.guc)).toBe(true);
    expect(bares.some((s) => pids.has(s.pid))).toBe(true);
  });

  it("SET LOCAL muere con la transacción aunque el backend siga en el pool", async () => {
    const inTx = await single.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '4321ms'`);
      const [r] = await tx.$queryRaw<{ v: string; pid: number }[]>`
        SELECT current_setting('statement_timeout') AS v, pg_backend_pid() AS pid`;
      return r!;
    });
    const [after] = await single.$queryRaw<{ v: string; pid: number }[]>`
      SELECT current_setting('statement_timeout') AS v, pg_backend_pid() AS pid`;
    expect(inTx.v).toBe("4321ms");
    expect(after!.pid).toBe(inTx.pid);
    expect(after!.v).not.toBe("4321ms");
  });

  it("pg_advisory_xact_lock (lockCapacity real) serializa a través del pool y se suelta con el commit", async () => {
    poolerHolder.current = main;
    const key = {
      tenantId: a.tenantId,
      practitionerId: a.practitionerId,
      serviceId: a.serviceId,
      dayKey: `2099-01-${String(Math.floor(Math.random() * 28) + 1).padStart(2, "0")}`,
    };
    const order: string[] = [];
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const aHeld = new Promise<void>((r) => (held = r));

    const txA = runWithRls(
      a.tenantId,
      async (tx) => {
        await lockCapacity(tx, key);
        order.push("A:lock");
        held();
        await released;
        order.push("A:fin");
      },
      { timeout: 20_000 }
    );
    await aHeld;
    const txB = runWithRls(
      a.tenantId,
      async (tx) => {
        await lockCapacity(tx, key);
        order.push("B:lock");
      },
      { timeout: 20_000 }
    );
    // B tiene que quedar ESPERANDO ese lock (filtrado por clave: otro waiter de la base no cuenta).
    await waitForAdvisoryWaiter(owner, capacityLockKey(key));
    expect(order).toEqual(["A:lock"]);
    release();
    await Promise.all([txA, txB]);
    expect(order).toEqual(["A:lock", "A:fin", "B:lock"]);

    // xact-level: después del commit nadie lo tiene, y cada transacción siguiente (en el backend que le toque) lo
    // toma al toque. En serie a propósito: dos `pg_try_` concurrentes se lo disputarían entre ellas.
    const [granted] = await owner.$queryRaw<{ n: number }[]>`
      WITH k AS (SELECT hashtextextended(${capacityLockKey(key)}, 0) AS v)
      SELECT count(*)::int AS n FROM pg_locks l, k
      WHERE l.locktype = 'advisory' AND l.objsubid = 1
        AND l.classid = ((k.v >> 32) & 4294967295)::oid AND l.objid = (k.v & 4294967295)::oid`;
    expect(granted!.n).toBe(0);
    const tries: boolean[] = [];
    for (let i = 0; i < 6; i++) {
      const [r] = await main.$transaction((tx) =>
        tx.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtextextended(${capacityLockKey(key)}, 0)) AS ok`
      );
      tries.push(r!.ok);
    }
    expect(tries).toEqual([true, true, true, true, true, true]);
  });

  it("transaction_read_only de runWithRls rechaza la escritura y no queda en el backend", async () => {
    poolerHolder.current = single;
    let ro: { v: string; pid: number } | undefined;
    const err = await Promise.resolve(
      runWithRequestContext({ tenantId: a.tenantId, userId: null, practitionerId: null, readOnly: true }, () =>
        runWithRls(a.tenantId, async (tx) => {
          [ro] = await tx.$queryRaw<{ v: string; pid: number }[]>`
            SELECT current_setting('transaction_read_only') AS v, pg_backend_pid() AS pid`;
          await tx.patient.update({ where: { id: patientA }, data: { phone: "ro-no-entra" } });
        })
      )
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReadOnlyModeError);
    expect(ro!.v).toBe("on");

    // Mismo backend (pool de 1), transacción siguiente de escritura: pasa.
    const phone = `ops1b-${uniqueSuffix()}`;
    const rw = await runWithRls(a.tenantId, async (tx) => {
      const [r] = await tx.$queryRaw<{ v: string; pid: number }[]>`
        SELECT current_setting('transaction_read_only') AS v, pg_backend_pid() AS pid`;
      await tx.patient.update({ where: { id: patientA }, data: { phone } });
      return r!;
    });
    expect(rw.pid).toBe(ro!.pid);
    expect(rw.v).toBe("off");
    const row = await owner.patient.findUniqueOrThrow({ where: { id: patientA }, select: { phone: true } });
    expect(row.phone).toBe(phone);
  });
});
