/**
 * [CF-L4] CF (ADR-032, enmienda C2 (1d)) — `lockAgendaKeysMany` con la clave de DÍA del profesional contra Postgres
 * real, con los dos roles: paciente → cupo → DÍA → hora → sala → sedes → filas, las cuatro familias en UNA sentencia.
 *
 * Lo que se protege (el orden es el invariante anti-deadlock, ADR-004):
 *   - una sola sentencia para cupo + día + hora + sala (el alta no suma idas por el lock nuevo: techos de perf
 *     intactos) y quedan todas las claves tomadas, deduplicadas;
 *   - quien espera la primera clave de DÍA tiene TODO su cupo y NINGUNA hora ni sala (ni tomada ni pedida);
 *   - quien espera la primera HORA ya tiene todos sus días (día antes que hora);
 *   - Planes (cupo + día, sin hora): quien espera el día ya tiene el cupo.
 * Se mira `pg_locks` por pid y la espera por clave exacta (`waitForAdvisoryWaiter`), no un conteo global. Claves
 * sintéticas (tenant con sufijo único): un advisory lock no necesita filas. Patrón de `locks-interval.test.ts`.
 *
 * Los write-paths que TOMAN la clave de día son de CF-W1/W2 (agenda), CF-P (turnero) y CF-PL (Planes): sus carreras
 * están en `tests/integration/cf-race-two-services.test.ts` (`[CF-R*]`, `it.fails` hasta que se implementen).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  lockAgendaKeysMany,
  orderedCapacityLockKeys,
  orderedHourLockKeys,
  orderedPractitionerDayLockKeys,
  orderedRoomLockKeys,
  pdayKeysFromCapacityKeys,
  type AgendaLockKeys,
  type CapacityLockKey,
  type HourLockKey,
  type PractitionerDayLockKey,
  type RoomLockKey,
} from "@/lib/booking-cap-lock";
import { ownerClient, uniqueSuffix } from "@/tests/helpers/tenant-factory";
import { waitForAdvisoryWaiter, countAdvisoryWaiters } from "@/tests/helpers/advisory-wait";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("[CF-L4] lock de cupo + día + hora + sala en una sentencia (C2 (1d))", () => {
  let db: PrismaClient;
  let holderDb: PrismaClient;
  let workerDb: PrismaClient;
  let tenantId: string;

  beforeAll(() => {
    db = ownerClient();
    // Conexiones propias para el holder y la tx bajo test (si compartieran pool con `db`, una espera podría comerse
    // la conexión del polling).
    holderDb = ownerClient();
    workerDb = new PrismaClient(); // DATABASE_URL: kinesoft_app u owner según el modo
    tenantId = `test-pd-${uniqueSuffix()}`;
  });
  afterAll(async () => {
    await Promise.all([db?.$disconnect(), holderDb?.$disconnect(), workerDb?.$disconnect()]);
  });

  // Ids de largo distinto a propósito ("p" / "p1"): el orden es por componente (unit test), y acá se ve en Postgres.
  const PRACS = ["p", "p1"];
  const SERVICES = ["s1", "s2"];
  const ROOMS = ["r1", "r2"];

  type Keys = { cap: CapacityLockKey[]; pday: PractitionerDayLockKey[]; hour: HourLockKey[]; rooms: RoomLockKey[] };

  /** Un turno que cruza la medianoche AR toca dos días: por eso `days` es una lista. */
  function keysFor(days: string[], hours: string[]): Keys {
    const cap: CapacityLockKey[] = [];
    const pday: PractitionerDayLockKey[] = [];
    const hour: HourLockKey[] = [];
    for (const practitionerId of PRACS) {
      for (const dayKey of days) {
        for (const serviceId of SERVICES) cap.push({ tenantId, practitionerId, serviceId, dayKey });
        pday.push({ tenantId, practitionerId, dayKey });
      }
      for (const h of hours) hour.push({ tenantId, practitionerId, hourKey: `${days[0]}T${h}` });
    }
    const rooms: RoomLockKey[] = ROOMS.flatMap((roomId) => days.map((dayKey) => ({ tenantId, roomId, dayKey })));
    return { cap, pday, hour, rooms };
  }

  /** Mezcla determinística (no queremos un test que pase "por suerte"). */
  function scramble<T>(xs: readonly T[]): T[] {
    const odd = xs.filter((_, i) => i % 2 === 1).reverse();
    const even = xs.filter((_, i) => i % 2 === 0);
    return [...odd, ...even];
  }

  /** Toma `key` en una tx abierta hasta `release()`. */
  async function hold(key: string) {
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let acquired!: () => void;
    const got = new Promise<void>((r) => (acquired = r));
    const done = holderDb.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
        acquired();
        await released;
      },
      { timeout: 20_000 }
    );
    await got;
    return { release, done };
  }

  /** ¿La sesión `pid` tiene CONCEDIDO el advisory lock de `key`? */
  async function grantedTo(pid: number, key: string): Promise<boolean> {
    const rows = await db.$queryRaw<{ n: number }[]>`
      WITH k AS (SELECT hashtextextended(${key}, 0) AS v)
      SELECT count(*)::int AS n FROM pg_locks l, k
      WHERE l.locktype = 'advisory' AND l.granted AND l.pid = ${pid}
        AND l.objsubid = 1
        AND l.classid = ((k.v >> 32) & 4294967295)::oid
        AND l.objid = (k.v & 4294967295)::oid`;
    return (rows[0]?.n ?? 0) > 0;
  }

  /** Corre `lockAgendaKeysMany` (listas desordenadas) en una tx de `workerDb`; devuelve su pid y el final. */
  async function startWorker(k: AgendaLockKeys) {
    let pid = 0;
    let gotPid!: () => void;
    const pidReady = new Promise<void>((r) => (gotPid = r));
    const done = workerDb.$transaction(
      async (tx) => {
        pid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid;
        gotPid();
        await lockAgendaKeysMany(tx, {
          cap: scramble(k.cap ?? []),
          pday: scramble(k.pday ?? []),
          hour: scramble(k.hour ?? []),
          rooms: scramble(k.rooms ?? []),
        });
        return "ok" as const;
      },
      { timeout: 20_000 }
    );
    await pidReady;
    return { pid: () => pid, done };
  }

  async function expectGranted(pid: number, keys: string[], granted: boolean) {
    for (const k of keys) expect({ k, granted: await grantedTo(pid, k) }).toEqual({ k, granted });
  }

  it("[CF-L4] 1 sentencia para cupo + día + hora + sala, y quedan todas las claves tomadas (deduplicadas)", async () => {
    const counted = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
    const queries: string[] = [];
    let recording = false;
    counted.$on("query" as never, (e: { query: string }) => {
      if (recording) queries.push(e.query);
    });
    try {
      const k = keysFor(["2027-07-12", "2027-07-13"], ["23"]);
      const held = await counted.$transaction(
        async (tx) => {
          recording = true;
          await lockAgendaKeysMany(tx, {
            cap: scramble([...k.cap, ...k.cap]),
            pday: scramble([...k.pday, ...k.pday]),
            hour: scramble([...k.hour, ...k.hour]),
            rooms: scramble([...k.rooms, ...k.rooms]),
          });
          recording = false;
          const rows = await tx.$queryRaw<{ n: number }[]>`
            SELECT count(*)::int AS n FROM pg_locks
            WHERE locktype = 'advisory' AND granted AND pid = pg_backend_pid()`;
          return rows[0]?.n ?? 0;
        },
        { timeout: 10_000 }
      );
      expect(queries).toHaveLength(1);
      expect(queries[0]).toMatch(/unnest/);
      expect(queries[0]).toMatch(/WITH ORDINALITY/);
      // 2 prof × 2 días × 2 servicios + 2 prof × 2 días + 2 prof × 1 hora + 2 salas × 2 días.
      expect(held).toBe(k.cap.length + k.pday.length + k.hour.length + k.rooms.length);
      expect(held).toBe(8 + 4 + 2 + 4);
    } finally {
      recording = false;
      await counted.$disconnect();
    }
  });

  it("[CF-L4] quien espera el primer DÍA tiene todo su cupo y ninguna hora ni sala (ni tomadas ni pedidas)", async () => {
    const k = keysFor(["2027-07-14"], ["09", "10"]);
    const capOrdered = orderedCapacityLockKeys(k.cap);
    const dayOrdered = orderedPractitionerDayLockKeys(k.pday);
    const hourOrdered = orderedHourLockKeys(k.hour);
    const roomOrdered = orderedRoomLockKeys(k.rooms);
    const firstDay = dayOrdered[0];
    const h = await hold(firstDay);
    const w = await startWorker(k);
    try {
      await waitForAdvisoryWaiter(db, firstDay);
      await expectGranted(w.pid(), capOrdered, true);
      await expectGranted(w.pid(), [...dayOrdered, ...hourOrdered, ...roomOrdered], false);
      // Ni siquiera las pidió: espera en el primer día, no en uno posterior, una hora o una sala.
      for (const key of [...dayOrdered.slice(1), ...hourOrdered, ...roomOrdered]) {
        expect(await countAdvisoryWaiters(db, key)).toBe(0);
      }
    } finally {
      h.release();
      await h.done;
    }
    expect(await w.done).toBe("ok");
  });

  it("[CF-L4] última clave de cupo ocupada: ningún día, hora ni sala tomado ni pedido (cupo antes que día)", async () => {
    const k = keysFor(["2027-07-15"], ["10"]);
    const capOrdered = orderedCapacityLockKeys(k.cap);
    const lastCap = capOrdered[capOrdered.length - 1];
    const rest = [...orderedPractitionerDayLockKeys(k.pday), ...orderedHourLockKeys(k.hour), ...orderedRoomLockKeys(k.rooms)];
    const h = await hold(lastCap);
    const w = await startWorker(k);
    try {
      await waitForAdvisoryWaiter(db, lastCap);
      await expectGranted(w.pid(), capOrdered.slice(0, -1), true);
      await expectGranted(w.pid(), rest, false);
      for (const key of rest) expect(await countAdvisoryWaiters(db, key)).toBe(0);
    } finally {
      h.release();
      await h.done;
    }
    expect(await w.done).toBe("ok");
  });

  it("[CF-L4] primera HORA ocupada: ya tiene todo el cupo y todos los días, ninguna sala (día antes que hora)", async () => {
    const k = keysFor(["2027-07-16"], ["10", "11"]);
    const hourOrdered = orderedHourLockKeys(k.hour);
    const roomOrdered = orderedRoomLockKeys(k.rooms);
    const firstHour = hourOrdered[0];
    const h = await hold(firstHour);
    const w = await startWorker(k);
    try {
      await waitForAdvisoryWaiter(db, firstHour);
      await expectGranted(w.pid(), [...orderedCapacityLockKeys(k.cap), ...orderedPractitionerDayLockKeys(k.pday)], true);
      await expectGranted(w.pid(), [...hourOrdered, ...roomOrdered], false);
      for (const key of roomOrdered) expect(await countAdvisoryWaiters(db, key)).toBe(0);
    } finally {
      h.release();
      await h.done;
    }
    expect(await w.done).toBe("ok");
  });

  it("[CF-L4] Planes (cupo + día de pdayKeysFromCapacityKeys, sin hora): quien espera el día ya tiene el cupo", async () => {
    const k = keysFor(["2027-07-19", "2027-07-26"], []);
    const pday = pdayKeysFromCapacityKeys(k.cap);
    const capOrdered = orderedCapacityLockKeys(k.cap);
    const dayOrdered = orderedPractitionerDayLockKeys(pday);
    expect(dayOrdered).toEqual(orderedPractitionerDayLockKeys(k.pday));
    const lastDay = dayOrdered[dayOrdered.length - 1];
    const h = await hold(lastDay);
    const w = await startWorker({ cap: k.cap, pday });
    try {
      await waitForAdvisoryWaiter(db, lastDay);
      await expectGranted(w.pid(), [...capOrdered, ...dayOrdered.slice(0, -1)], true);
      await expectGranted(w.pid(), [lastDay], false);
    } finally {
      h.release();
      await h.done;
    }
    expect(await w.done).toBe("ok");
  });
});
