/**
 * Planes S07i (P0.1) — orden de locks, contrato C2 (enmienda de AUDIT §5.28;
 * ADR-004), contra Postgres real con los dos roles.
 *
 * Lo que se protege:
 *   - `lockCapacityMany` toma N claves en UNA sentencia (presupuesto del commit
 *     de un plan: ≤ 60 statements para 20 filas);
 *   - las toma deduplicadas y en el orden global (por componente, como
 *     `lockCapacityScope` de time-blocks) AUNQUE el caller las pase
 *     desordenadas: si una clave intermedia está ocupada, la tx espera ahí con
 *     las anteriores tomadas y NINGUNA de las posteriores (se mira `pg_locks`
 *     por pid, no un conteo global);
 *   - carrera de tres: `lockCapacityMany` desordenado ∥ `applyDayLock` "todos"
 *     ∥ `createTimeBlock` multi-día terminan los tres, sin 40P01. La espera se
 *     sincroniza con `waitForAdvisoryWaiter` (clave exacta, no `count(*)`
 *     global), así que el test falla si la carrera no llegó a armarse;
 *   - `lockPlanPatient`: clave `kinesoft:plan-patient:<t>:<p>`, exclusiva por
 *     paciente, y se suelta al terminar la tx;
 *   - `withTxConflictRetry`: un solo reintento ante P2034/40P01.
 *
 * Las acciones de agenda corren REALES (getActor real con la sesión mockeada).
 * Días lejanos (2027) para no cruzarse con otras suites.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  capacityKeysForWindow,
  capacityLockKey,
  lockCapacityMany,
  orderedCapacityLockKeys,
  type CapacityLockKey,
} from "@/lib/booking-cap-lock";
import { lockPlanPatient, planPatientLockKey, withTxConflictRetry, isRetryableTxConflict } from "@/lib/plan-lock";
import { applyDayLock, createTimeBlock } from "@/lib/time-blocks";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  addService,
  addPatient,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { waitForAdvisoryWaiter, countAdvisoryWaiters } from "@/tests/helpers/advisory-wait";

const RUN = process.env.INTEGRATION === "1";

describe("booking-cap-lock: claves puras (C2 (1))", () => {
  const T = "t1";
  it("orderedCapacityLockKeys deduplica y ordena por componente (tenant, profesional, servicio, día)", () => {
    const keys: CapacityLockKey[] = [
      { tenantId: T, practitionerId: "p2", serviceId: "s1", dayKey: "2027-01-02" },
      { tenantId: T, practitionerId: "p1", serviceId: "s2", dayKey: "2027-01-01" },
      { tenantId: T, practitionerId: "p1", serviceId: "s1", dayKey: "2027-01-02" },
      { tenantId: T, practitionerId: "p1", serviceId: "s1", dayKey: "2027-01-01" },
      { tenantId: T, practitionerId: "p2", serviceId: "s1", dayKey: "2027-01-02" }, // duplicada
    ];
    expect(orderedCapacityLockKeys(keys)).toEqual([
      "kinesoft:cap:t1:p1:s1:2027-01-01",
      "kinesoft:cap:t1:p1:s1:2027-01-02",
      "kinesoft:cap:t1:p1:s2:2027-01-01",
      "kinesoft:cap:t1:p2:s1:2027-01-02",
    ]);
  });

  it("el orden es el de los for anidados con sort() de lockCapacityScope, aun con ids de largo distinto", () => {
    // Concatenado, "kinesoft:cap:t1:ab1:…" < "kinesoft:cap:t1:ab:…" ('1' < ':'),
    // pero los for anidados con sort() ponen "ab" antes que "ab1".
    const keys: CapacityLockKey[] = [
      { tenantId: T, practitionerId: "ab1", serviceId: "s", dayKey: "2027-01-01" },
      { tenantId: T, practitionerId: "ab", serviceId: "s", dayKey: "2027-01-01" },
    ];
    const nested: string[] = [];
    for (const p of ["ab1", "ab"].sort()) nested.push(capacityLockKey({ tenantId: T, practitionerId: p, serviceId: "s", dayKey: "2027-01-01" }));
    expect(orderedCapacityLockKeys(keys)).toEqual(nested);
  });

  it("capacityKeysForWindow incluye el día siguiente si la fila cruza la medianoche AR (y solo entonces)", () => {
    const base = { tenantId: T, practitionerId: "p", serviceId: "s" };
    const cross = capacityKeysForWindow({
      ...base,
      start: new Date("2027-03-09T23:30:00-03:00"),
      end: new Date("2027-03-10T00:30:00-03:00"),
    });
    expect(cross.map((k) => k.dayKey)).toEqual(["2027-03-09", "2027-03-10"]);
    // Termina justo a la medianoche AR: [start, end) no toca el día siguiente.
    const edge = capacityKeysForWindow({
      ...base,
      start: new Date("2027-03-09T23:00:00-03:00"),
      end: new Date("2027-03-10T00:00:00-03:00"),
    });
    expect(edge.map((k) => k.dayKey)).toEqual(["2027-03-09"]);
    // 22:00 AR = 01:00 UTC del día siguiente: el día es el AR, no el del host.
    const late = capacityKeysForWindow({
      ...base,
      start: new Date("2027-03-09T22:00:00-03:00"),
      end: new Date("2027-03-09T22:45:00-03:00"),
    });
    expect(late.map((k) => k.dayKey)).toEqual(["2027-03-09"]);
  });

  it("isRetryableTxConflict: P2034 y 40P01 sí; P2002 y errores comunes no", () => {
    const known = (code: string, meta?: Record<string, unknown>, message = "x") =>
      new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: "test", meta });
    expect(isRetryableTxConflict(known("P2034"))).toBe(true);
    expect(isRetryableTxConflict(known("P2010", { code: "40P01" }))).toBe(true);
    expect(isRetryableTxConflict(known("P2010", undefined, "ERROR: deadlock detected"))).toBe(true);
    expect(isRetryableTxConflict(known("P2002"))).toBe(false);
    expect(isRetryableTxConflict(new Error("deadlock detected"))).toBe(false);
  });

  it("withTxConflictRetry reintenta UNA vez ante P2034 y propaga el segundo conflicto", async () => {
    const conflict = () => new Prisma.PrismaClientKnownRequestError("conflict", { code: "P2034", clientVersion: "test" });
    let n = 0;
    await expect(
      withTxConflictRetry(async () => {
        n += 1;
        if (n === 1) throw conflict();
        return "ok";
      })
    ).resolves.toBe("ok");
    expect(n).toBe(2);

    let m = 0;
    await expect(
      withTxConflictRetry(async () => {
        m += 1;
        throw conflict();
      })
    ).rejects.toMatchObject({ code: "P2034" });
    expect(m).toBe(2);

    let k = 0;
    await expect(
      withTxConflictRetry(async () => {
        k += 1;
        throw new Error("otro");
      })
    ).rejects.toThrow("otro");
    expect(k).toBe(1);
  });
});

describe.skipIf(!RUN)("orden de locks contra Postgres (S07i, C2)", () => {
  let db: PrismaClient;
  let holderDb: PrismaClient;
  let workerDb: PrismaClient;
  let A: EphemeralTenant;
  let pracIds: string[];
  let serviceIds: string[];

  beforeAll(async () => {
    db = ownerClient();
    // Conexiones propias para el holder y para la tx bajo test: si
    // compartieran pool con `db`, una espera podría comerse la conexión que
    // usa el polling de `pg_locks`.
    holderDb = ownerClient();
    workerDb = new PrismaClient(); // DATABASE_URL: kinesoft_app o owner según el modo
    A = await createEphemeralTenant(db);
    await addPractitioner(db, A, "PRACTITIONER");
    await addService(db, A);
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

  /** Todas las claves (profesional × servicio × día) del tenant. */
  function allKeys(days: string[]): CapacityLockKey[] {
    const out: CapacityLockKey[] = [];
    for (const practitionerId of pracIds)
      for (const serviceId of serviceIds)
        for (const dayKey of days) out.push({ tenantId: A.tenantId, practitionerId, serviceId, dayKey });
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

  it("lockCapacityMany = 1 statement para N claves, y quedan las N tomadas", async () => {
    const counted = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
    const queries: string[] = [];
    let recording = false;
    counted.$on("query" as never, (e: { query: string }) => {
      if (recording) queries.push(e.query);
    });
    try {
      const keys = allKeys(["2027-05-04", "2027-05-05", "2027-05-06"]); // 2 × 2 × 3 = 12
      expect(keys.length).toBe(12);
      const held = await counted.$transaction(
        async (tx) => {
          recording = true;
          await lockCapacityMany(tx, scramble([...keys, ...keys])); // duplicadas: se deduplican
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
      expect(held).toBe(12);

      // Lista vacía: no-op, sin ida a la base.
      queries.length = 0;
      await counted.$transaction(async (tx) => {
        recording = true;
        await lockCapacityMany(tx, []);
        recording = false;
      });
      expect(queries).toHaveLength(0);
    } finally {
      recording = false;
      await counted.$disconnect();
    }
  });

  it("desordenado: espera en la clave ocupada con las anteriores tomadas y ninguna posterior", async () => {
    const keys = allKeys(["2027-05-11", "2027-05-12"]); // 8 claves
    const ordered = orderedCapacityLockKeys(keys);
    const midIdx = 4;
    const mid = ordered[midIdx];
    const h = await hold(mid);
    let pid = 0;
    let gotPid!: () => void;
    const pidReady = new Promise<void>((r) => (gotPid = r));
    const worker = workerDb.$transaction(
      async (tx) => {
        pid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid;
        gotPid();
        await lockCapacityMany(tx, scramble(keys));
        return "ok" as const;
      },
      { timeout: 20_000 }
    );
    try {
      await pidReady;
      await waitForAdvisoryWaiter(db, mid);
      for (let i = 0; i < ordered.length; i++) {
        // Antes de `mid`: tomadas. `mid` y después: no (ni siquiera intentadas).
        expect({ i, granted: await grantedTo(pid, ordered[i]) }).toEqual({ i, granted: i < midIdx });
      }
      for (const k of ordered.slice(midIdx + 1)) expect(await countAdvisoryWaiters(db, k)).toBe(0);
    } finally {
      h.release();
      await h.done;
    }
    expect(await worker).toBe("ok");
  });

  it("lockCapacityMany desordenado ∥ applyDayLock 'todos' ∥ createTimeBlock multi-día: los tres terminan, sin 40P01", async () => {
    const D1 = "2027-05-18"; // martes
    const D2 = "2027-05-19";
    const keys = allKeys([D1, D2]);
    const ordered = orderedCapacityLockKeys(keys);
    const first = ordered[0]; // la primera que piden applyDayLock y createTimeBlock
    const mid = ordered[Math.floor(ordered.length / 2)];
    expect(first).toBe(capacityLockKey({ tenantId: A.tenantId, practitionerId: pracIds[0], serviceId: serviceIds[0], dayKey: D1 }));

    // 1. Un holder toma una clave del medio.
    const h = await hold(mid);
    // 2. La tx de "plan" pide TODAS desordenadas: toma las anteriores a `mid`
    //    (incluida `first`) y espera en `mid`. Con el orden de C2 nunca tiene
    //    una posterior a `mid` que los otros dos ya tengan → no hay ciclo.
    //    (Sin ordenar —p. ej. en reversa— tomaría las posteriores, los otros
    //    dos tomarían las anteriores, y al soltar `mid` habría 40P01.)
    const plan = workerDb.$transaction(
      async (tx) => {
        await lockCapacityMany(tx, scramble(keys));
        return "ok" as const;
      },
      { timeout: 20_000 }
    );
    let dayLock: ReturnType<typeof applyDayLock> | undefined;
    let block: ReturnType<typeof createTimeBlock> | undefined;
    try {
      await waitForAdvisoryWaiter(db, mid);

      // 3. Las dos acciones reales de agenda, como el dueño. Las dos
      //    lockean (profesional, servicio, día) con `lockCapacityScope` y se
      //    frenan en `first`, que tiene la tx de plan.
      asUser(A.userId);
      dayLock = applyDayLock({
        dayKey: D1,
        practitionerIds: null,
        allDay: true,
        reason: "Feriado S07i",
        bookingsDecision: "keep",
        expectedAffectedIds: [],
      });
      block = createTimeBlock({
        practitionerId: null,
        startsAt: `${D1}T00:00:00-03:00`,
        endsAt: `${D2}T23:59:00-03:00`,
        allDay: true,
        reason: "Congreso S07i",
      });
      await waitForAdvisoryWaiter(db, first, { minWaiters: 2 });
    } finally {
      // 4. Se suelta el holder: la tx de plan termina y después las otras dos.
      h.release();
      await h.done;
    }

    const settled = await Promise.allSettled([plan, dayLock!, block!]);
    const reasons = settled
      .filter((s): s is PromiseRejectedResult => s.status === "rejected")
      .map((s) => String((s.reason as Error)?.message ?? s.reason));
    expect(reasons).toEqual([]);
    const [p, d, b] = settled.map((s) => (s as PromiseFulfilledResult<unknown>).value);
    expect(p).toBe("ok");
    expect(d).toMatchObject({ ok: true });
    expect(b).toMatchObject({ ok: true });
    // Efecto observable: los dos bloqueos quedaron escritos.
    const rows = await db.timeBlock.findMany({
      where: { tenantId: A.tenantId, deletedAt: null, reason: { in: ["Feriado S07i", "Congreso S07i"] } },
      select: { reason: true, practitionerId: true },
    });
    expect(rows.map((r) => r.reason).sort()).toEqual(["Congreso S07i", "Feriado S07i"]);
    expect(rows.every((r) => r.practitionerId === null)).toBe(true);
  });

  it("lockPlanPatient: exclusivo por paciente, no frena a otro paciente y se suelta con la tx", async () => {
    const p1 = await addPatient(db, A, { firstName: "Lock", lastName: "Uno" });
    const p2 = await addPatient(db, A, { firstName: "Lock", lastName: "Dos" });
    const k1 = planPatientLockKey({ tenantId: A.tenantId, patientId: p1 });
    expect(k1).toBe(`kinesoft:plan-patient:${A.tenantId}:${p1}`);

    const h = await hold(k1);
    const waiting = workerDb.$transaction(
      async (tx) => {
        await lockPlanPatient(tx, { tenantId: A.tenantId, patientId: p1 });
        return "p1" as const;
      },
      { timeout: 20_000 }
    );
    try {
      await waitForAdvisoryWaiter(db, k1);
      // Otro paciente no espera.
      const other = await db.$transaction(async (tx) => {
        await lockPlanPatient(tx, { tenantId: A.tenantId, patientId: p2 });
        return "p2" as const;
      });
      expect(other).toBe("p2");
    } finally {
      h.release();
      await h.done;
    }
    expect(await waiting).toBe("p1");
    // Commit → lock suelto: tomarlo de nuevo no espera.
    expect(
      await db.$transaction(async (tx) => {
        await lockPlanPatient(tx, { tenantId: A.tenantId, patientId: p1 });
        return "again" as const;
      })
    ).toBe("again");
  });
});
