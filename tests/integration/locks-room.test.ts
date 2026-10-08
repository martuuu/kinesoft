/**
 * SR1.0 (SR-C) — `lockCapacityAndRoomsMany` contra Postgres real, con los dos
 * roles (enmienda C2 (1b): paciente → cupo → SALA → sedes → filas).
 *
 * Lo que se protege:
 *   - cupo + sala = UNA sentencia (el alta con sala no suma idas por el lock) y
 *     quedan todas las claves tomadas, deduplicadas;
 *   - el orden es TODO el cupo y DESPUÉS las salas, aunque el caller pase las
 *     listas desordenadas: con la primera sala ocupada, la tx espera ahí con
 *     todo el cupo tomado y ninguna sala; con la última clave de cupo ocupada,
 *     no tiene ninguna sala tomada ni pedida (se mira `pg_locks` por pid y la
 *     espera por clave exacta con `waitForAdvisoryWaiter`, no un conteo global).
 *
 * Salas reales (M4, `addRoom`) y días lejanos (2027) para no cruzarse con otras
 * suites. El patrón es el de `locks-order.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  lockCapacityAndRoomsMany,
  orderedCapacityLockKeys,
  orderedRoomLockKeys,
  type CapacityLockKey,
  type RoomLockKey,
} from "@/lib/booking-cap-lock";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  addService,
  addRoom,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { waitForAdvisoryWaiter, countAdvisoryWaiters } from "@/tests/helpers/advisory-wait";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("lock de cupo + sala en una sentencia (SR, C2 (1b))", () => {
  let db: PrismaClient;
  let holderDb: PrismaClient;
  let workerDb: PrismaClient;
  let A: EphemeralTenant;
  let pracIds: string[];
  let serviceIds: string[];
  let roomIds: string[];

  beforeAll(async () => {
    db = ownerClient();
    // Conexiones propias para el holder y la tx bajo test (si compartieran
    // pool con `db`, una espera podría comerse la conexión del polling).
    holderDb = ownerClient();
    workerDb = new PrismaClient(); // DATABASE_URL: kinesoft_app u owner según el modo
    A = await createEphemeralTenant(db);
    await addPractitioner(db, A, "PRACTITIONER");
    await addService(db, A);
    const r1 = await addRoom(db, A, { name: "Consultorio 1" });
    const r2 = await addRoom(db, A, { name: "Consultorio 2", locationId: r1.locationId });
    roomIds = [r1.roomId, r2.roomId].sort();
    pracIds = (await db.practitioner.findMany({ where: { tenantId: A.tenantId }, select: { id: true } }))
      .map((p) => p.id)
      .sort();
    serviceIds = (await db.service.findMany({ where: { tenantId: A.tenantId }, select: { id: true } }))
      .map((s) => s.id)
      .sort();
  });
  afterAll(async () => {
    await A?.cleanup();
    await Promise.all([db?.$disconnect(), holderDb?.$disconnect(), workerDb?.$disconnect()]);
  });

  function capKeys(days: string[]): CapacityLockKey[] {
    const out: CapacityLockKey[] = [];
    for (const practitionerId of pracIds)
      for (const serviceId of serviceIds)
        for (const dayKey of days) out.push({ tenantId: A.tenantId, practitionerId, serviceId, dayKey });
    return out;
  }
  function roomKeys(days: string[]): RoomLockKey[] {
    const out: RoomLockKey[] = [];
    for (const roomId of roomIds) for (const dayKey of days) out.push({ tenantId: A.tenantId, roomId, dayKey });
    return out;
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

  /**
   * Corre `lockCapacityAndRoomsMany` (listas desordenadas) en una tx de
   * `workerDb` y devuelve su pid apenas lo tiene, más la promesa del final.
   */
  async function startWorker(cap: CapacityLockKey[], rooms: RoomLockKey[]) {
    let pid = 0;
    let gotPid!: () => void;
    const pidReady = new Promise<void>((r) => (gotPid = r));
    const done = workerDb.$transaction(
      async (tx) => {
        pid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid;
        gotPid();
        await lockCapacityAndRoomsMany(tx, scramble(cap), scramble(rooms));
        return "ok" as const;
      },
      { timeout: 20_000 }
    );
    await pidReady;
    return { pid: () => pid, done };
  }

  it("1 sentencia para cupo + sala, y quedan todas las claves tomadas (deduplicadas)", async () => {
    const counted = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
    const queries: string[] = [];
    let recording = false;
    counted.$on("query" as never, (e: { query: string }) => {
      if (recording) queries.push(e.query);
    });
    try {
      const days = ["2027-06-01", "2027-06-02"];
      const cap = capKeys(days); // profesionales × servicios × 2 días
      const rooms = roomKeys(days); // 2 salas × 2 días
      expect(pracIds.length).toBeGreaterThanOrEqual(2);
      expect(rooms.length).toBe(4);
      const held = await counted.$transaction(
        async (tx) => {
          recording = true;
          await lockCapacityAndRoomsMany(tx, scramble([...cap, ...cap]), scramble([...rooms, ...rooms]));
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
      expect(held).toBe(cap.length + rooms.length);
    } finally {
      recording = false;
      await counted.$disconnect();
    }
  });

  it("primera sala ocupada: espera ahí con TODO el cupo tomado y ninguna sala", async () => {
    const days = ["2027-06-08", "2027-06-09"];
    const cap = capKeys(days);
    const rooms = roomKeys(days);
    const capOrdered = orderedCapacityLockKeys(cap);
    const roomOrdered = orderedRoomLockKeys(rooms);
    const firstRoom = roomOrdered[0];
    const h = await hold(firstRoom);
    const w = await startWorker(cap, rooms);
    try {
      await waitForAdvisoryWaiter(db, firstRoom);
      for (const k of capOrdered) expect({ k, granted: await grantedTo(w.pid(), k) }).toEqual({ k, granted: true });
      for (const k of roomOrdered) expect({ k, granted: await grantedTo(w.pid(), k) }).toEqual({ k, granted: false });
      for (const k of roomOrdered.slice(1)) expect(await countAdvisoryWaiters(db, k)).toBe(0);
    } finally {
      h.release();
      await h.done;
    }
    expect(await w.done).toBe("ok");
  });

  it("última clave de cupo ocupada: ninguna sala tomada ni pedida (cupo antes que sala)", async () => {
    const days = ["2027-06-15"];
    const cap = capKeys(days);
    const rooms = roomKeys(days);
    const capOrdered = orderedCapacityLockKeys(cap);
    const roomOrdered = orderedRoomLockKeys(rooms);
    const lastCap = capOrdered[capOrdered.length - 1];
    const h = await hold(lastCap);
    const w = await startWorker(cap, rooms);
    try {
      await waitForAdvisoryWaiter(db, lastCap);
      for (const k of capOrdered.slice(0, -1)) expect(await grantedTo(w.pid(), k)).toBe(true);
      for (const k of roomOrdered) {
        expect(await grantedTo(w.pid(), k)).toBe(false);
        expect(await countAdvisoryWaiters(db, k)).toBe(0);
      }
    } finally {
      h.release();
      await h.done;
    }
    expect(await w.done).toBe("ok");
  });
});
