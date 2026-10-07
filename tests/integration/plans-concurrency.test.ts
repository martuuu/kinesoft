/**
 * P2-S11x · Carreras del motor de Planes (ES2b, ola P2.2; solo tests).
 *
 * Todo lo que corre acá viene de olas anteriores: el alta (`createPlan`, S11e),
 * agregar/reprecio (S16b), la agenda (`createBooking`/`updateBooking`/
 * `setBookingCopagoPaid`, S07c/S12) y el candado/bloqueos (`applyDayLock`,
 * `createTimeBlock`). Se ejecutan los símbolos REALES con el `getActor()` real
 * (integration-setup mockea solo la sesión de Supabase, headers y `next/cache`).
 *
 * Barreras deterministas (C14), nada de sleeps:
 *   - un "holder" (tx del owner) toma la clave/fila por la que se compite y la
 *     retiene;
 *   - advisory: `waitForAdvisoryWaiter(db, clave, {minWaiters})` filtra la
 *     clave exacta (`hashtextextended`) → la carrera quedó armada;
 *   - filas: `waitBlockedBy(pid, n)` sobre `pg_blocking_pids`, TRANSITIVO (nota
 *     C14 de S16b: el segundo que espera la MISMA fila figura bloqueado por el
 *     primer waiter, no por el holder).
 * Recién con todos los competidores esperando se suelta el holder. Se lanzan
 * de a uno y cada uno entra a la cola antes de lanzar el siguiente
 * (`raceBehind`): la cola de un lock exclusivo es FIFO, así que cada orden de
 * llegada es un caso determinista (`it.each`) y se afirman los DOS lados de la
 * carrera (quién gana, que el otro no escribió nada, ningún error genérico),
 * además de los invariantes que valen para cualquier orden (cupo 1, sin
 * turnos duplicados del paciente).
 *
 * "Sin 40P01": `applyDayLock`, `createTimeBlock`, `createBooking` y
 * `updateBooking` NO reintentan y enmascaran cualquier excepción como error
 * genérico ("No pudimos …"): que terminen con un resultado de dominio prueba
 * que ningún deadlock los tocó. Las escrituras de Planes reintentan UNA vez
 * (`withTxConflictRetry`, C2); que terminen bien cubre "40P01 no persistente".
 *
 * Tenant propio con UN profesional y UN servicio con cupo 1 (`maxConcurrent`),
 * así todas las acciones compiten por la misma clave de cupo
 * `(profesional, servicio, día AR)` y la primera clave que pide cada una es la
 * del día más temprano. Días distintos por test (2031, futuro). Dos roles de
 * DB (app con RLS y owner BYPASSRLS = prod). TZ=UTC: 10:00 AR = 13:00Z.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { createPlan, previewPlan } from "@/lib/plans";
import type { CreatePlanResult, PlanCreateInput, PlanPreview, PlanRowResolution } from "@/lib/plans-types";
import { addPlanSessions, previewAddPlanSessions, repricePlan } from "@/lib/plans-edit";
import { createBooking, setBookingCopagoPaid, updateBooking } from "@/lib/bookings";
import { STALE_ERROR } from "@/lib/bookings-constants";
import { applyDayLock, createTimeBlock } from "@/lib/time-blocks";
import { capacityLockKey } from "@/lib/booking-cap-lock";
import { dayKeyOf } from "@/lib/availability/day";
import { planPatientLockKey } from "@/lib/plan-lock";
import { waitForAdvisoryWaiter } from "@/tests/helpers/advisory-wait";
import { ownerClient, createEphemeralTenant, addPatient, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

/** Lunes y jueves 10:00 AR (C6: 0=Dom). */
const LUN_JUE_10 = {
  v: 1 as const,
  frequency: "weekly" as const,
  slots: [
    { dow: 1 as const, startMin: 600 },
    { dow: 4 as const, startMin: 600 },
  ],
};

/** 10:00 AR del día → instante (AR = UTC-3 sin DST). */
const at10 = (dayKey: string) => new Date(`${dayKey}T13:00:00.000Z`);

/** Las resoluciones por defecto del preview, como las mandaría el editor. */
function acceptDefaults(p: PlanPreview): PlanRowResolution[] {
  return p.rows.map((r) =>
    r.defaultResolution === "move"
      ? { index: r.index, kind: "move", at: r.suggestion }
      : r.defaultResolution === "adopt"
        ? { index: r.index, kind: "adopt", bookingId: r.flags.duplicate!.bookingId, expectedUpdatedAt: r.flags.duplicate!.updatedAt }
        : { index: r.index, kind: r.defaultResolution }
  );
}

/** Una tx del owner que toma algo y lo retiene hasta `release()`; `ready` = su pid. */
function hold(db: PrismaClient, take: (tx: Prisma.TransactionClient) => Promise<unknown>) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let ready!: (pid: number) => void;
  const readyP = new Promise<number>((r) => (ready = r));
  const done = db.$transaction(
    async (tx) => {
      await take(tx);
      const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      ready(pid);
      await gate;
    },
    { timeout: 30_000, maxWait: 10_000 }
  );
  return { ready: readyP, release, done };
}

/** Advisory exclusivo con alcance de tx (la misma forma que toman los locks del repo). */
const advisory = (key: string) => (tx: Prisma.TransactionClient) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;

/**
 * Espera a que haya ≥ n sesiones bloqueadas por `pid`, directa o
 * transitivamente (una cola de waiters sobre la misma fila se reporta en
 * cadena: el segundo, bloqueado por el primero).
 */
async function waitBlockedBy(db: PrismaClient, pid: number, n: number, timeoutMs = 10_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const [{ c }] = await db.$queryRaw<{ c: number }[]>`
      SELECT count(*)::int AS c FROM pg_stat_activity a
      WHERE ${pid}::int = ANY(pg_blocking_pids(a.pid))
         OR EXISTS (
           SELECT 1 FROM pg_stat_activity b
           WHERE b.pid = ANY(pg_blocking_pids(a.pid)) AND ${pid}::int = ANY(pg_blocking_pids(b.pid)))`;
    if (c >= n) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitBlockedBy: solo ${c}/${n} bloqueados por ${pid}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Mensajes con los que las acciones de agenda enmascaran una excepción (p. ej. un 40P01). */
const GENERIC_ERRORS = [
  "No pudimos bloquear el día. No se cambió nada.",
  "No pudimos crear el bloqueo.",
  "No pudimos crear el turno.",
];

/** Ninguna promesa tiró; devuelve los valores. */
function allFulfilled<T extends readonly unknown[]>(settled: { [K in keyof T]: PromiseSettledResult<T[K]> }): T {
  const reasons = (settled as readonly PromiseSettledResult<unknown>[])
    .filter((s): s is PromiseRejectedResult => s.status === "rejected")
    .map((s) => String((s.reason as Error)?.message ?? s.reason));
  expect(reasons).toEqual([]);
  return (settled as readonly PromiseSettledResult<unknown>[]).map((s) => (s as PromiseFulfilledResult<unknown>).value) as unknown as T;
}

/**
 * Carrera con ORDEN de llegada fijo detrás del advisory `key`: un holder lo
 * toma; se lanza cada competidor y se espera a que quede en la cola
 * (`waitForAdvisoryWaiter` con `minWaiters = i+1`) antes de lanzar el
 * siguiente; recién ahí se suelta. La cola de espera de un lock exclusivo de
 * Postgres es FIFO, así que el orden en que entran es `racers` — cada orden
 * es un caso determinista y se pueden afirmar los dos lados de la carrera.
 * Devuelve los valores en el mismo orden; falla si alguno TIRÓ.
 */
async function raceBehind<T extends readonly unknown[]>(
  db: PrismaClient,
  key: string,
  racers: { [K in keyof T]: () => Promise<T[K]> }
): Promise<T> {
  const h = hold(db, advisory(key));
  await h.ready;
  const started: Promise<unknown>[] = [];
  try {
    for (const run of racers as readonly (() => Promise<unknown>)[]) {
      const p = run();
      p.catch(() => {}); // se reporta abajo (allSettled), no como unhandled
      started.push(p);
      await waitForAdvisoryWaiter(db, key, { minWaiters: started.length, timeoutMs: 10_000 });
    }
  } finally {
    h.release();
    await h.done;
  }
  return allFulfilled<T>((await Promise.allSettled(started)) as never);
}

/** Resultado de `createPlan` aceptable en una carrera: alta o stale-preview (nunca un error). */
function expectPlanOkOrStale(r: CreatePlanResult): "ok" | "stale" {
  if (r.ok) return "ok";
  expect(r).toMatchObject({ ok: false, kind: "stale-preview" });
  return "stale";
}

describe.skipIf(!RUN)("P2-S11x · carreras del motor de planes", () => {
  let db: PrismaClient;
  let K: EphemeralTenant;

  const capKey = (dayKey: string) =>
    capacityLockKey({ tenantId: K.tenantId, practitionerId: K.practitionerId, serviceId: K.serviceId, dayKey });

  const planInput = (patientId: string, over: Partial<PlanCreateInput> = {}): PlanCreateInput => ({
    idempotencyKey: randomUUID(),
    patientId,
    discipline: "KINESIOLOGY",
    practitionerId: K.practitionerId,
    serviceId: K.serviceId,
    locationId: null,
    schedule: LUN_JUE_10,
    startDayKey: "2031-03-03",
    totalSessions: 2,
    pricing: null,
    rows: [],
    stateToken: "x",
    ...over,
  });

  /** preview → input de commit con las resoluciones por defecto (sin commitear). */
  async function prepared(input: PlanCreateInput): Promise<{ commit: PlanCreateInput; preview: PlanPreview }> {
    const p = await previewPlan(input);
    if (!p.ok) throw new Error(`preview: ${p.error}`);
    return { preview: p.preview, commit: { ...input, stateToken: p.preview.stateToken, rows: acceptDefaults(p.preview) } };
  }

  async function makePlan(input: PlanCreateInput): Promise<string> {
    const { commit } = await prepared(input);
    const r = await createPlan(commit);
    if (!r.ok) throw new Error(`createPlan: ${"error" in r ? r.error : r.kind}`);
    return r.programId;
  }

  /** Turno suelto (fixture, insert directo del owner): el estado que dejaría la agenda. */
  async function looseBooking(patientId: string, when: Date): Promise<{ id: string; updatedAt: Date }> {
    return db.booking.create({
      data: {
        tenantId: K.tenantId,
        patientId,
        practitionerId: K.practitionerId,
        serviceId: K.serviceId,
        scheduledFor: when,
        durationMin: 45,
        idempotencyKey: randomUUID(),
        status: "CONFIRMED",
      },
      select: { id: true, updatedAt: true },
    });
  }

  /** Turnos activos (ocupan cupo) que arrancan en el instante. */
  const activeAt = (when: Date) =>
    db.booking.findMany({
      where: { tenantId: K.tenantId, scheduledFor: when, status: { in: ["PENDING", "CONFIRMED", "COMPLETED"] } },
      select: { id: true, patientId: true, programId: true, isOverbooked: true },
    });

  const activeOnDay = (dayKey: string) =>
    db.booking.count({
      where: {
        tenantId: K.tenantId,
        scheduledFor: { gte: new Date(`${dayKey}T03:00:00.000Z`), lt: new Date(+new Date(`${dayKey}T03:00:00.000Z`) + 86_400_000) },
        status: { in: ["PENDING", "CONFIRMED", "COMPLETED"] },
      },
    });

  beforeAll(async () => {
    db = ownerClient();
    K = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "PRO" });
    // Cupo 1 en el único servicio del tenant: todas las acciones compiten por
    // la misma clave (profesional, servicio, día) y nadie toma otra antes.
    await db.service.update({ where: { id: K.serviceId }, data: { maxConcurrent: 1 } });
    expect(await db.service.count({ where: { tenantId: K.tenantId } })).toBe(1);
    expect(await db.practitioner.count({ where: { tenantId: K.tenantId } })).toBe(1);
    asUser(K.userId);
  });

  afterAll(async () => {
    await K?.cleanup();
    await db?.$disconnect();
  });

  // ─── §10 S11x (literal del plan) ───────────────────────────────────────────

  // Los dos órdenes de llegada a la clave de cupo del lunes (FIFO, ver raceBehind).
  it.each([
    { first: "plan" as const, D1: "2031-03-03" },
    { first: "booking" as const, D1: "2031-07-07" },
  ])("plan ∥ createBooking en cupo 1 → gana el primero ($first); el otro: conflicto o stale-preview sin escribir", async ({ first, D1: start }) => {
    const patientId = await addPatient(db, K);
    const other = await addPatient(db, K);
    const { commit, preview } = await prepared(planInput(patientId, { startDayKey: start }));
    expect(preview.rows.map((r) => r.defaultResolution)).toEqual(["create", "create"]);
    const slot = new Date(preview.rows[0].at);
    const day = dayKeyOf(slot);

    const runPlan = () => createPlan(commit);
    const runBooking = () =>
      createBooking({
        patientId: other,
        serviceId: K.serviceId,
        practitionerId: K.practitionerId,
        scheduledFor: slot.toISOString(),
        durationMin: 45,
        idempotencyKey: randomUUID(),
        allowOutOfHours: true,
      });
    type BookingR = Awaited<ReturnType<typeof createBooking>>;
    let plan: CreatePlanResult;
    let booking: BookingR;
    if (first === "plan") [plan, booking] = await raceBehind<[CreatePlanResult, BookingR]>(db, capKey(day), [runPlan, runBooking]);
    else [booking, plan] = await raceBehind<[BookingR, CreatePlanResult]>(db, capKey(day), [runBooking, runPlan]);

    expect(GENERIC_ERRORS).not.toContain(booking.ok ? "" : booking.error);
    const rows = await activeAt(slot);
    expect(rows).toHaveLength(1); // cupo 1: exactamente uno
    expect(rows[0].isOverbooked).toBe(false);
    if (first === "plan") {
      expect(plan).toMatchObject({ ok: true, idempotent: false });
      expect(booking).toMatchObject({ ok: false, conflict: expect.anything() });
      expect(rows[0].patientId).toBe(patientId);
    } else {
      expect(booking.ok).toBe(true);
      expect(plan).toMatchObject({ ok: false, kind: "stale-preview" });
      if (!plan.ok && "preview" in plan) expect(plan.preview.rows[0].flags.capacityFull).toBe(true);
      expect(rows[0].patientId).toBe(other);
      // Nada a medias: ni plan, ni sesiones, ni turnos del paciente del plan.
      expect(await db.treatmentProgram.count({ where: { tenantId: K.tenantId, patientId } })).toBe(0);
      expect(await db.booking.count({ where: { tenantId: K.tenantId, patientId } })).toBe(0);
    }
  });

  it.each([
    { order: ["plan", "dayLock", "block"] as const, D1: "2031-03-10", D2: "2031-03-13" },
    { order: ["block", "dayLock", "plan"] as const, D1: "2031-06-02", D2: "2031-06-05" },
  ])("plan ∥ applyDayLock 'todos' ∥ createTimeBlock multi-día ($order) → los tres terminan, sin deadlock", async ({ order, D1, D2 }) => {
    const patientId = await addPatient(db, K);
    const { commit } = await prepared(planInput(patientId, { startDayKey: D1 }));
    const tag = randomUUID().slice(0, 8);

    const runners = {
      plan: () => createPlan(commit),
      dayLock: () =>
        applyDayLock({
          dayKey: D1,
          practitionerIds: null,
          allDay: true,
          reason: `Feriado ${tag}`,
          bookingsDecision: "keep",
          expectedAffectedIds: [],
        }),
      block: () =>
        createTimeBlock({
          practitionerId: null,
          startsAt: `${D1}T00:00:00-03:00`,
          endsAt: `${D2}T23:59:00-03:00`,
          allDay: true,
          reason: `Congreso ${tag}`,
        }),
    };
    // La primera clave de las tres es la del lunes (único profesional y servicio).
    const out = await raceBehind<unknown[]>(db, capKey(D1), order.map((n) => runners[n]));
    const byName = Object.fromEntries(order.map((n, i) => [n, out[i]]));
    const plan = byName.plan as CreatePlanResult;
    const dayLock = byName.dayLock as Awaited<ReturnType<typeof applyDayLock>>;
    const block = byName.block as Awaited<ReturnType<typeof createTimeBlock>>;

    // Ningún 40P01 enmascarado: el bloqueo siempre entra; el candado entra o
    // "la agenda cambió" (dominio), nunca el error genérico.
    expect(block).toMatchObject({ ok: true });
    if (!dayLock.ok) expect(dayLock).toMatchObject({ ok: false, changed: true });
    if (order[0] === "plan") {
      // El plan entró antes: el candado (keep, esperaba 0 afectados) ve su turno.
      expect(plan).toMatchObject({ ok: true });
      expect(dayLock).toMatchObject({ ok: false, changed: true });
      expect(await activeOnDay(D1)).toBe(1);
    } else {
      // Bloqueado nunca se fuerza: stale y nada escrito.
      expect(dayLock.ok).toBe(true);
      expect(plan).toMatchObject({ ok: false, kind: "stale-preview" });
      expect(await db.treatmentProgram.count({ where: { tenantId: K.tenantId, patientId } })).toBe(0);
      expect(await activeOnDay(D1)).toBe(0);
    }
    const blocks = await db.timeBlock.findMany({
      where: { tenantId: K.tenantId, deletedAt: null, reason: { in: [`Feriado ${tag}`, `Congreso ${tag}`] } },
      select: { reason: true },
    });
    expect(blocks.map((b) => b.reason).sort()).toEqual(
      dayLock.ok ? [`Congreso ${tag}`, `Feriado ${tag}`] : [`Congreso ${tag}`]
    );
  });

  it("2 commits del mismo paciente → serializados por lockPlanPatient: el primero entra, el segundo stale-preview", async () => {
    const D1 = "2031-03-24";
    const patientId = await addPatient(db, K);
    // Dos drawers del mismo paciente con el mismo horario (keys distintas).
    const a = await prepared(planInput(patientId, { startDayKey: D1 }));
    const b = await prepared(planInput(patientId, { startDayKey: D1 }));

    // Los DOS quedan en la cola del lock del paciente (raceBehind lo exige):
    // la serialización está probada ahí, no inferida del resultado.
    const key = planPatientLockKey({ tenantId: K.tenantId, patientId });
    const [ra, rb] = await raceBehind<[CreatePlanResult, CreatePlanResult]>(db, key, [
      () => createPlan(a.commit),
      () => createPlan(b.commit),
    ]);
    expect(ra).toMatchObject({ ok: true, idempotent: false });
    // El segundo re-clasifica con el plan del primero ya escrito: sus filas
    // chocan con turnos del mismo paciente → stale, no un segundo plan encimado.
    expect(rb).toMatchObject({ ok: false, kind: "stale-preview" });

    const programs = await db.treatmentProgram.findMany({ where: { tenantId: K.tenantId, patientId }, select: { id: true } });
    expect(programs.map((p) => p.id)).toEqual([ra.ok ? ra.programId : "?"]);
    // Ningún turno duplicado del paciente: los 2 del plan ganador, nada más.
    const bookings = await db.booking.findMany({ where: { tenantId: K.tenantId, patientId }, select: { programId: true } });
    expect(bookings).toHaveLength(2);
    expect(bookings.every((x) => x.programId === programs[0].id)).toBe(true);
  });

  it("P2002 de carrera (turno del paciente que el lock de cupo no serializa) → 0 programas, sesiones y turnos", async () => {
    const D1 = "2031-03-31";
    const patientId = await addPatient(db, K);
    const { commit } = await prepared(planInput(patientId, { startDayKey: D1 }));

    // Otra escritura del MISMO paciente en el instante de la fila 1, todavía sin
    // COMMIT: no toma el lock de cupo ni el del paciente (p. ej. un alta sin
    // pasar por el motor). El motor clasifica sin verla (MVCC) y su INSERT queda
    // esperando el índice único paciente-instante hasta que esta commitee.
    const h = hold(db, (tx) =>
      tx.booking.create({
        data: {
          tenantId: K.tenantId,
          patientId,
          practitionerId: K.practitionerId,
          serviceId: K.serviceId,
          scheduledFor: at10(D1),
          durationMin: 45,
          idempotencyKey: `s11x-p2002-${randomUUID()}`,
          status: "CONFIRMED",
        },
      })
    );
    const pid = await h.ready;
    const p = createPlan(commit);
    try {
      await waitBlockedBy(db, pid, 1);
    } finally {
      h.release();
      await h.done;
    }
    const r = await p;
    expect(r).toMatchObject({ ok: false, kind: "stale-preview" });

    expect(await db.treatmentProgram.count({ where: { tenantId: K.tenantId, patientId } })).toBe(0);
    expect(await db.session.count({ where: { program: { tenantId: K.tenantId, patientId } } })).toBe(0);
    expect(await db.auditEvent.count({ where: { tenantId: K.tenantId, action: "program.create", payload: { path: ["patientId"], equals: patientId } } })).toBe(0);
    const left = await db.booking.findMany({ where: { tenantId: K.tenantId, patientId }, select: { programId: true, idempotencyKey: true } });
    // Solo el turno de la otra escritura; ninguno con key `plan:`.
    expect(left).toHaveLength(1);
    expect(left[0].programId).toBeNull();
    expect(left[0].idempotencyKey.startsWith("s11x-p2002-")).toBe(true);
  });

  // ─── Pedidos del orquestador (ES2b) ────────────────────────────────────────

  it("dos createPlan con la misma idempotencyKey en paralelo → 1 plan (el segundo, éxito idempotente)", async () => {
    const D1 = "2031-04-07";
    const patientId = await addPatient(db, K);
    const { commit } = await prepared(planInput(patientId, { startDayKey: D1, totalSessions: 3 }));

    const key = planPatientLockKey({ tenantId: K.tenantId, patientId });
    const [ra, rb] = await raceBehind<[CreatePlanResult, CreatePlanResult]>(db, key, [
      () => createPlan(commit),
      () => createPlan(commit),
    ]);
    expect(ra).toMatchObject({ ok: true, idempotent: false });
    expect(rb).toMatchObject({ ok: true, idempotent: true });
    if (!ra.ok || !rb.ok) return;
    expect(rb.programId).toBe(ra.programId);
    expect(await db.treatmentProgram.count({ where: { tenantId: K.tenantId, idempotencyKey: commit.idempotencyKey } })).toBe(1);
    expect(await db.session.count({ where: { programId: ra.programId } })).toBe(3);
    expect(await db.booking.count({ where: { programId: ra.programId } })).toBe(3);
    expect(await db.booking.count({ where: { tenantId: K.tenantId, patientId } })).toBe(3);
    expect(await db.auditEvent.count({ where: { tenantId: K.tenantId, action: "program.create", entityId: ra.programId } })).toBe(1);
  });

  it("orden inverso: el reprecio commitea primero y el 'Cobrado' en vuelo queda stale por su CAS de updatedAt", async () => {
    const patientId = await addPatient(db, K);
    const programId = await makePlan(
      planInput(patientId, { startDayKey: "2031-10-06", totalSessions: 4, pricing: { mode: "PER_SESSION", pricePerSessionCents: 10_000_00 } })
    );
    const program0 = await db.treatmentProgram.findUniqueOrThrow({ where: { id: programId }, select: { updatedAt: true } });
    const target = await db.booking.findFirstOrThrow({
      where: { programId, status: "CONFIRMED" },
      orderBy: { scheduledFor: "asc" },
      skip: 1,
      select: { id: true, updatedAt: true, copagoCents: true },
    });
    expect(target.copagoCents).toBe(10_000_00);

    // El holder retiene la fila del PLAN: el reprecio toma Booking → Session
    // (C2 (3)) y se frena en TreatmentProgram CON los turnos ya lockeados.
    const h = hold(db, (tx) => tx.$queryRaw`SELECT id FROM "TreatmentProgram" WHERE id = ${programId} FOR UPDATE`);
    const pid = await h.ready;
    const rp = repricePlan({
      programId,
      expectedUpdatedAt: program0.updatedAt.toISOString(),
      pricing: { mode: "PER_SESSION", pricePerSessionCents: 15_000_00 },
    });
    let cobrado: ReturnType<typeof setBookingCopagoPaid> | undefined;
    try {
      await waitBlockedBy(db, pid, 1);
      // "Cobrado" con la versión que ve la UI: lee la fila vieja (MVCC), pasa su
      // chequeo de expectedUpdatedAt y su UPDATE … WHERE updatedAt queda
      // esperando la fila que tiene el reprecio.
      cobrado = setBookingCopagoPaid(target.id, true, target.updatedAt.toISOString());
      await waitBlockedBy(db, pid, 2);
    } finally {
      h.release();
      await h.done;
    }
    const [r, c] = await Promise.all([rp, cobrado!]);
    expect(r).toMatchObject({ ok: true, data: { stampedBookings: 4 } });
    // El reprecio re-estampó la fila (updatedAt nuevo): el CAS del cobro no
    // matchea al re-evaluar el WHERE → stale, no un cobro con el monto viejo.
    expect(c).toEqual({ ok: false, error: STALE_ERROR });
    const after = await db.booking.findUniqueOrThrow({ where: { id: target.id } });
    expect(after).toMatchObject({ paymentStatus: "UNPAID", copagoCents: 15_000_00, pricedByPlan: true });
    expect(await db.auditEvent.count({ where: { tenantId: K.tenantId, action: "booking.copago_paid", entityId: target.id } })).toBe(0);

    // Con la versión nueva (lo que hace la UI tras "refrescá"), cobra el monto nuevo.
    const again = await setBookingCopagoPaid(target.id, true, after.updatedAt.toISOString());
    expect(again.ok).toBe(true);
    expect(await db.booking.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({
      paymentStatus: "PAID",
      copagoCents: 15_000_00,
    });
  });

  it.each([
    { first: "add" as const, A: "2031-05-05", next: "2031-05-12" },
    { first: "plan" as const, A: "2031-08-04", next: "2031-08-11" },
  ])("agregar sesiones ∥ createPlan que adoptan el MISMO turno suelto del paciente ($first primero) → adopta el primero, el otro stale-preview; sin deadlock", async ({ first, A, next: nextDay }) => {
    const patientId = await addPatient(db, K);
    // Plan A: lunes y jueves de esa semana. El próximo del horario es el lunes siguiente 10:00 AR.
    const programA = await makePlan(planInput(patientId, { startDayKey: A, totalSessions: 2 }));
    const next = at10(nextDay);
    const loose = await looseBooking(patientId, next);

    // Los dos previews ven el turno suelto del paciente en esa fila → "adoptar".
    const pvAdd = await previewAddPlanSessions({ programId: programA, kind: "append", count: 1 });
    if (!pvAdd.ok) throw new Error(`previewAdd: ${pvAdd.error}`);
    const addRows = acceptDefaults(pvAdd.preview);
    const b = await prepared(planInput(patientId, { startDayKey: nextDay, totalSessions: 1 }));
    expect(addRows).toEqual([expect.objectContaining({ kind: "adopt", bookingId: loose.id })]);
    expect(b.commit.rows).toEqual([expect.objectContaining({ kind: "adopt", bookingId: loose.id })]);

    type AddR = Awaited<ReturnType<typeof addPlanSessions>>;
    const runAdd = () => addPlanSessions({ programId: programA, kind: "append", count: 1, rows: addRows, stateToken: pvAdd.preview.stateToken });
    const runPlan = () => createPlan(b.commit);
    const key = planPatientLockKey({ tenantId: K.tenantId, patientId });
    let add: AddR;
    let plan: CreatePlanResult;
    if (first === "add") [add, plan] = await raceBehind<[AddR, CreatePlanResult]>(db, key, [runAdd, runPlan]);
    else [plan, add] = await raceBehind<[CreatePlanResult, AddR]>(db, key, [runPlan, runAdd]);

    const l = await db.booking.findUniqueOrThrow({ where: { id: loose.id }, select: { programId: true, sessionId: true, status: true } });
    expect(l.status).toBe("CONFIRMED");
    expect(l.sessionId).not.toBeNull();
    const programs = await db.treatmentProgram.findMany({
      where: { tenantId: K.tenantId, patientId },
      select: { id: true, totalSessions: true, sessions: { where: { archivedAt: null }, select: { id: true } } },
    });
    const a = programs.find((p) => p.id === programA)!;
    if (first === "add") {
      expect(add).toMatchObject({ ok: true, data: { totalSessions: 3, createdBookings: 0 } });
      expect(plan).toMatchObject({ ok: false, kind: "stale-preview" });
      expect(l.programId).toBe(programA);
      expect(programs).toHaveLength(1);
      expect(a.totalSessions).toBe(3);
      expect(a.sessions).toHaveLength(3);
    } else {
      expect(plan).toMatchObject({ ok: true, idempotent: false });
      expect(add).toMatchObject({ ok: false, kind: "stale-preview" });
      expect(l.programId).toBe(plan.ok ? plan.programId : "?");
      expect(programs).toHaveLength(2);
      expect(a.totalSessions).toBe(2);
      expect(a.sessions).toHaveLength(2);
    }
    // El paciente no quedó con dos turnos activos en el mismo instante.
    expect((await activeAt(next)).filter((x) => x.patientId === patientId)).toHaveLength(1);
  });

  // Pendiente de S16b ("locks de agregar en dos tandas ordenadas, no orden
  // global"): agregar toma el adoptado `FOR UPDATE` (tanda 1, motor) y después
  // TODOS los turnos del plan id asc (tanda 2). Un "solo este" de la agenda
  // sobre un turno del MISMO plan no toma el lock del paciente (C2 (0)): acá
  // se cruzan en la fila de ese turno, en los dos órdenes.
  it.each([
    { first: "add" as const, A: "2031-10-20", next: "2031-10-27" },
    { first: "move" as const, A: "2031-11-03", next: "2031-11-10" },
  ])("agregar sesiones (adopta) ∥ reprogramar 'solo este' un turno del mismo plan ($first primero) → los dos terminan, sin deadlock", async ({ first, A, next: nextDay }) => {
    const patientId = await addPatient(db, K);
    const programA = await makePlan(planInput(patientId, { startDayKey: A, totalSessions: 2 }));
    const loose = await looseBooking(patientId, at10(nextDay));
    const [b1, b2] = await db.booking.findMany({
      where: { programId: programA, status: "CONFIRMED" },
      orderBy: { scheduledFor: "asc" },
      select: { id: true, updatedAt: true, sessionId: true, scheduledFor: true },
    });
    expect(b1 && b2).toBeTruthy();
    // El jueves de la sesión 2, de 10:00 a 12:00 AR: misma clave de cupo (ese día), ajena a la de agregar.
    const movedTo = new Date(+b2.scheduledFor + 2 * 3_600_000);

    const pvAdd = await previewAddPlanSessions({ programId: programA, kind: "append", count: 1 });
    if (!pvAdd.ok) throw new Error(`previewAdd: ${pvAdd.error}`);
    const addRows = acceptDefaults(pvAdd.preview);
    expect(addRows).toEqual([expect.objectContaining({ kind: "adopt", bookingId: loose.id })]);

    type AddR = Awaited<ReturnType<typeof addPlanSessions>>;
    type MoveR = Awaited<ReturnType<typeof updateBooking>>;
    const runAdd = () => addPlanSessions({ programId: programA, kind: "append", count: 1, rows: addRows, stateToken: pvAdd.preview.stateToken });
    const runMove = () =>
      updateBooking({ id: b2.id, scheduledFor: movedTo.toISOString(), expectedUpdatedAt: b2.updatedAt.toISOString(), allowOutOfHours: true });

    // Barrera de fila: el holder retiene el turno 2; el primero queda esperándolo
    // y el segundo en la cola detrás (pg_blocking_pids transitivo).
    const h = hold(db, (tx) => tx.$queryRaw`SELECT id FROM "Booking" WHERE id = ${b2.id} FOR UPDATE`);
    const pid = await h.ready;
    const started: Promise<unknown>[] = [];
    try {
      for (const run of first === "add" ? [runAdd, runMove] : [runMove, runAdd]) {
        const p = run();
        p.catch(() => {});
        started.push(p);
        await waitBlockedBy(db, pid, started.length);
      }
    } finally {
      h.release();
      await h.done;
    }
    const settled = await Promise.allSettled(started);
    const [x, y] = allFulfilled<[unknown, unknown]>(settled as never);
    const add = (first === "add" ? x : y) as AddR;
    const move = (first === "add" ? y : x) as MoveR;

    // La reprogramación no depende del plan: entra siempre (y sincroniza la sesión, I3).
    expect(move).toMatchObject({ ok: true });
    const s2 = await db.session.findUniqueOrThrow({ where: { id: b2.sessionId! }, select: { scheduledFor: true } });
    expect(+s2.scheduledFor).toBe(+movedTo);
    // Agregar entra en los dos órdenes: la reprogramación de la sesión 2 no
    // cambia ni el `updatedAt` del plan ni la fila nueva (el próximo lunes), así
    // que su relectura bajo lock coincide con el preview y adopta el suelto.
    expect(add).toMatchObject({ ok: true, data: { totalSessions: 3, createdBookings: 0 } });
    const l = await db.booking.findUniqueOrThrow({ where: { id: loose.id }, select: { programId: true } });
    expect(l.programId).toBe(programA);
    const prog = await db.treatmentProgram.findUniqueOrThrow({ where: { id: programA }, select: { totalSessions: true } });
    expect(prog.totalSessions).toBe(3);
  });

  it.each([
    { order: ["plan", "dayLock", "move"] as const, D1: "2031-03-17", D2: "2031-03-20" },
    { order: ["move", "dayLock", "plan"] as const, D1: "2031-09-01", D2: "2031-09-04" },
    { order: ["dayLock", "move", "plan"] as const, D1: "2031-09-15", D2: "2031-09-18" },
  ])("createPlan ∥ applyDayLock ∥ reprogramación sobre los mismos cupos ($order) → todos terminan sin 40P01; cupo 1 respetado", async ({ order, D1, D2 }) => {
    const patientId = await addPatient(db, K);
    const other = await addPatient(db, K);
    const { commit } = await prepared(planInput(patientId, { startDayKey: D1 }));
    // Turno de otro paciente el jueves 11:00 AR, que la recepción mueve al lunes 10:00 AR (la fila 1 del plan).
    const moving = await looseBooking(other, new Date(`${D2}T14:00:00.000Z`));

    const runners = {
      plan: () => createPlan(commit),
      dayLock: () =>
        applyDayLock({
          dayKey: D1,
          practitionerIds: null,
          allDay: true,
          reason: "Candado S11x",
          bookingsDecision: "keep",
          expectedAffectedIds: [],
        }),
      move: () =>
        updateBooking({
          id: moving.id,
          scheduledFor: at10(D1).toISOString(),
          expectedUpdatedAt: moving.updatedAt.toISOString(),
          allowOutOfHours: true,
        }),
    };
    // Las tres piden primero la clave del lunes (D1 < D2; único profesional y servicio).
    const out = await raceBehind<unknown[]>(db, capKey(D1), order.map((n) => runners[n]));
    const byName = Object.fromEntries(order.map((n, i) => [n, out[i]]));
    const plan = byName.plan as CreatePlanResult;
    const dayLock = byName.dayLock as Awaited<ReturnType<typeof applyDayLock>>;
    const move = byName.move as Awaited<ReturnType<typeof updateBooking>>;

    // Resultados de dominio, nunca el genérico que enmascara un 40P01.
    if (!dayLock.ok) expect(dayLock).toMatchObject({ ok: false, changed: true });
    if (!move.ok) expect(move.conflict ?? move.blocked).toBeTruthy();
    // Cupo 1: a lo sumo un turno activo a las 10:00 del lunes, y sin sobreturno.
    const atSlot = await activeAt(at10(D1));
    expect(atSlot.length).toBeLessThanOrEqual(1);
    expect(atSlot.every((x) => !x.isOverbooked)).toBe(true);

    switch (order[0]) {
      case "plan":
        expect(plan).toMatchObject({ ok: true });
        expect(dayLock).toMatchObject({ ok: false, changed: true });
        expect(move).toMatchObject({ ok: false, conflict: expect.anything() });
        expect(atSlot.map((x) => x.patientId)).toEqual([patientId]);
        break;
      case "move":
        expect(move.ok).toBe(true);
        expect(dayLock).toMatchObject({ ok: false, changed: true });
        expect(plan).toMatchObject({ ok: false, kind: "stale-preview" });
        expect(atSlot.map((x) => x.patientId)).toEqual([other]);
        break;
      case "dayLock":
        // El candado (esperaba 0 afectados) entra con el lunes vacío; después nada entra debajo.
        expect(dayLock.ok).toBe(true);
        expect(move).toMatchObject({ ok: false, blocked: expect.anything() });
        expect(plan).toMatchObject({ ok: false, kind: "stale-preview" });
        expect(await activeOnDay(D1)).toBe(0);
        break;
    }
    if (!plan.ok) expect(await db.treatmentProgram.count({ where: { tenantId: K.tenantId, patientId } })).toBe(0);
    const m = await db.booking.findUniqueOrThrow({ where: { id: moving.id }, select: { scheduledFor: true, status: true } });
    expect(m.status).toBe("CONFIRMED");
    expect(m.scheduledFor.toISOString()).toBe(move.ok ? at10(D1).toISOString() : `${D2}T14:00:00.000Z`);
  });
});
