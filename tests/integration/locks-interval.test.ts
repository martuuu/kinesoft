/**
 * [AS-2k] T3 (C-AS3, enmienda C2 (1c)) — `lockAgendaKeysMany` contra Postgres real, con los dos roles:
 * paciente → cupo → HORA del profesional → sala → sedes → filas, con cupo + hora + sala en UNA sentencia.
 *
 * Lo que se protege (el orden es el invariante anti-deadlock, ADR-004):
 *   - una sola sentencia para las tres familias (el alta no suma idas por el lock nuevo: perf 35 / 186 intactos) y
 *     quedan todas las claves tomadas, deduplicadas;
 *   - quien espera la clave de HORA tiene TODO su cupo y NINGUNA sala (ni tomada ni pedida);
 *   - quien espera la última clave de cupo no tiene ninguna hora ni sala;
 *   - quien espera la primera sala ya tiene todas sus horas.
 * Se mira `pg_locks` por pid y la espera por clave exacta (`waitForAdvisoryWaiter`), no un conteo global. Las
 * claves son sintéticas (tenant con sufijo único): un advisory lock no necesita filas, y así no se cruza con otras
 * suites. El patrón es el de `locks-room.test.ts`.
 *
 * Los write-paths que TOMAN la clave de hora (alta, lote, edición, turnero) son de T3d-2w / T3c-2l: sus carreras
 * están en `tests/integration/as2-interval-cap.test.ts` (`[AS-2w]`, `it.fails` hasta que se implementen).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  lockAgendaKeysMany,
  orderedCapacityLockKeys,
  orderedHourLockKeys,
  orderedRoomLockKeys,
  type CapacityLockKey,
  type HourLockKey,
  type RoomLockKey,
} from "@/lib/booking-cap-lock";
import { ownerClient, uniqueSuffix } from "@/tests/helpers/tenant-factory";
import { waitForAdvisoryWaiter, countAdvisoryWaiters } from "@/tests/helpers/advisory-wait";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("[AS-2k] lock de cupo + hora + sala en una sentencia (C2 (1c))", () => {
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
    tenantId = `test-lk-${uniqueSuffix()}`;
  });
  afterAll(async () => {
    await Promise.all([db?.$disconnect(), holderDb?.$disconnect(), workerDb?.$disconnect()]);
  });

  // Ids de largo distinto a propósito ("p" / "p1"): el orden es por componente (unit test), y acá se ve en Postgres.
  const PRACS = ["p", "p1"];
  const SERVICES = ["s1", "s2"];
  const ROOMS = ["r1", "r2"];

  function keysFor(day: string, hours: string[]) {
    const cap: CapacityLockKey[] = [];
    for (const practitionerId of PRACS)
      for (const serviceId of SERVICES) cap.push({ tenantId, practitionerId, serviceId, dayKey: day });
    const hour: HourLockKey[] = [];
    for (const practitionerId of PRACS) for (const h of hours) hour.push({ tenantId, practitionerId, hourKey: `${day}T${h}` });
    const rooms: RoomLockKey[] = ROOMS.map((roomId) => ({ tenantId, roomId, dayKey: day }));
    return { cap, hour, rooms };
  }

  /** Mezcla determinística (no queremos un test que pase "por suerte"). */
  function scramble<T>(xs: T[]): T[] {
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
  async function startWorker(k: { cap: CapacityLockKey[]; hour: HourLockKey[]; rooms: RoomLockKey[] }) {
    let pid = 0;
    let gotPid!: () => void;
    const pidReady = new Promise<void>((r) => (gotPid = r));
    const done = workerDb.$transaction(
      async (tx) => {
        pid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid;
        gotPid();
        await lockAgendaKeysMany(tx, { cap: scramble(k.cap), hour: scramble(k.hour), rooms: scramble(k.rooms) });
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

  it("1 sentencia para cupo + hora + sala, y quedan todas las claves tomadas (deduplicadas)", async () => {
    const counted = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
    const queries: string[] = [];
    let recording = false;
    counted.$on("query" as never, (e: { query: string }) => {
      if (recording) queries.push(e.query);
    });
    try {
      const k = keysFor("2027-07-05", ["10", "11"]);
      const held = await counted.$transaction(
        async (tx) => {
          recording = true;
          await lockAgendaKeysMany(tx, {
            cap: scramble([...k.cap, ...k.cap]),
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
      expect(held).toBe(k.cap.length + k.hour.length + k.rooms.length);
    } finally {
      recording = false;
      await counted.$disconnect();
    }
  });

  it("quien espera la clave de HORA tiene todo su cupo y ninguna sala", async () => {
    const k = keysFor("2027-07-06", ["09", "10"]);
    const capOrdered = orderedCapacityLockKeys(k.cap);
    const hourOrdered = orderedHourLockKeys(k.hour);
    const roomOrdered = orderedRoomLockKeys(k.rooms);
    const firstHour = hourOrdered[0];
    const h = await hold(firstHour);
    const w = await startWorker(k);
    try {
      await waitForAdvisoryWaiter(db, firstHour);
      await expectGranted(w.pid(), capOrdered, true);
      await expectGranted(w.pid(), hourOrdered, false);
      await expectGranted(w.pid(), roomOrdered, false);
      // Ni siquiera las pidió: espera en la primera hora, no en una posterior ni en una sala.
      for (const key of [...hourOrdered.slice(1), ...roomOrdered]) expect(await countAdvisoryWaiters(db, key)).toBe(0);
    } finally {
      h.release();
      await h.done;
    }
    expect(await w.done).toBe("ok");
  });

  it("última clave de cupo ocupada: ninguna hora ni sala tomada ni pedida (cupo antes que hora)", async () => {
    const k = keysFor("2027-07-07", ["10"]);
    const capOrdered = orderedCapacityLockKeys(k.cap);
    const lastCap = capOrdered[capOrdered.length - 1];
    const h = await hold(lastCap);
    const w = await startWorker(k);
    try {
      await waitForAdvisoryWaiter(db, lastCap);
      await expectGranted(w.pid(), capOrdered.slice(0, -1), true);
      await expectGranted(w.pid(), [...orderedHourLockKeys(k.hour), ...orderedRoomLockKeys(k.rooms)], false);
      for (const key of [...orderedHourLockKeys(k.hour), ...orderedRoomLockKeys(k.rooms)]) {
        expect(await countAdvisoryWaiters(db, key)).toBe(0);
      }
    } finally {
      h.release();
      await h.done;
    }
    expect(await w.done).toBe("ok");
  });

  it("primera sala ocupada: ya tiene todo el cupo y todas las horas (hora antes que sala)", async () => {
    const k = keysFor("2027-07-08", ["10", "11"]);
    const roomOrdered = orderedRoomLockKeys(k.rooms);
    const firstRoom = roomOrdered[0];
    const h = await hold(firstRoom);
    const w = await startWorker(k);
    try {
      await waitForAdvisoryWaiter(db, firstRoom);
      await expectGranted(w.pid(), [...orderedCapacityLockKeys(k.cap), ...orderedHourLockKeys(k.hour)], true);
      await expectGranted(w.pid(), roomOrdered, false);
    } finally {
      h.release();
      await h.done;
    }
    expect(await w.done).toBe("ok");
  });
});
