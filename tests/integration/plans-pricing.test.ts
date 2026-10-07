/**
 * S16b · Reprecio C5 de dos ramas (`lib/plans-edit.ts` → `repricePlan`,
 * `previewRepricePlan`; motor de plata en `lib/plan-pricing-internal.ts`).
 *
 * Base real + `getActor()` real (integration-setup). Planes con el alta real
 * de S11e (ola anterior). Las filas "bloqueadas" (C5: cobradas, pasadas,
 * copago manual, FAILED, realizadas) se fabrican por update directo con el
 * owner: es el estado que dejaría la agenda/Facturación, no lo que se testea.
 *
 * Carreras (C14): "reprecio ∥ Cobrado" usa la barrera de advisory exacta
 * (`waitForAdvisoryWaiter` sobre la clave de `lockPlanPatient`); "reprecio ∥
 * applyDayLock" retiene la fila del turno en otra tx y espera a que las DOS
 * escrituras estén bloqueadas por ese pid (`pg_blocking_pids`) antes de soltar.
 *
 * Dos roles (app + owner BYPASSRLS). TZ=UTC. Fechas 2030-2031 (futuro), salvo
 * la fila "pasada" (2020).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { createPlan, previewPlan } from "@/lib/plans";
import type { PlanCreateInput, PlanPreview, PlanRowResolution } from "@/lib/plans-types";
import { previewRepricePlan, repricePlan } from "@/lib/plans-edit";
import { setBookingCopagoPaid } from "@/lib/bookings";
import { applyDayLock, previewDayLock } from "@/lib/time-blocks";
import { setPatientDefaultCopago } from "@/lib/patients";
import { updateInsurer } from "@/lib/insurers";
import { planPatientLockKey } from "@/lib/plan-lock";
import { waitForAdvisoryWaiter } from "@/tests/helpers/advisory-wait";
import { ownerClient, createEphemeralTenant, addPatient, addInsurer, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

const LUN_JUE_10 = {
  v: 1 as const,
  frequency: "weekly" as const,
  slots: [
    { dow: 1 as const, startMin: 600 },
    { dow: 4 as const, startMin: 600 },
  ],
};

function acceptDefaults(p: PlanPreview): PlanRowResolution[] {
  return p.rows.map((r) =>
    r.defaultResolution === "move"
      ? { index: r.index, kind: "move", at: r.suggestion }
      : r.defaultResolution === "adopt"
        ? { index: r.index, kind: "adopt", bookingId: r.flags.duplicate!.bookingId, expectedUpdatedAt: r.flags.duplicate!.updatedAt }
        : { index: r.index, kind: r.defaultResolution }
  );
}

/** Una tx del owner que toma algo y lo retiene hasta `release()`. */
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

async function waitBlockedBy(db: PrismaClient, pid: number, n: number, timeoutMs = 10_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    // Transitivo: el segundo que espera la MISMA fila queda en la cola detrás
    // del primero (pg_blocking_pids lo reporta bloqueado por ese waiter, no por
    // el holder).
    const [{ c }] = await db.$queryRaw<{ c: number }[]>`
      SELECT count(*)::int AS c FROM pg_stat_activity a
      WHERE ${pid}::int = ANY(pg_blocking_pids(a.pid))
         OR EXISTS (
           SELECT 1 FROM pg_stat_activity b
           WHERE b.pid = ANY(pg_blocking_pids(a.pid)) AND ${pid}::int = ANY(pg_blocking_pids(b.pid)))`;
    if (c >= n) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`solo ${c}/${n} bloqueados por ${pid}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe.skipIf(!RUN)("S16b · reprecio C5 (plans-pricing)", () => {
  let db: PrismaClient;
  let K: EphemeralTenant;

  async function makePlan(over: Partial<PlanCreateInput> = {}) {
    const patientId = over.patientId ?? (await addPatient(db, K));
    const input: PlanCreateInput = {
      idempotencyKey: randomUUID(),
      patientId,
      discipline: "KINESIOLOGY",
      practitionerId: K.practitionerId,
      serviceId: K.serviceId,
      locationId: null,
      schedule: LUN_JUE_10,
      startDayKey: "2030-01-07",
      totalSessions: 4,
      pricing: { mode: "PER_SESSION", pricePerSessionCents: 10_000_00 },
      rows: [],
      stateToken: "x",
      ...over,
    };
    const p = await previewPlan(input);
    if (!p.ok) throw new Error(`preview: ${p.error}`);
    const r = await createPlan({ ...input, stateToken: p.preview.stateToken, rows: acceptDefaults(p.preview) });
    if (!r.ok) throw new Error("createPlan");
    return { programId: r.programId, patientId };
  }

  async function state(programId: string) {
    const program = await db.treatmentProgram.findUniqueOrThrow({ where: { id: programId } });
    const live = await db.session.findMany({
      where: { programId, archivedAt: null },
      orderBy: { index: "asc" },
      include: { bookings: { orderBy: { id: "asc" } } },
    });
    const booking = (i: number) => live[i].bookings.find((b) => b.status !== "CANCELLED" && b.status !== "NO_SHOW")!;
    return { program, live, booking };
  }

  const iso = (d: Date) => d.toISOString();

  beforeAll(async () => {
    db = ownerClient();
    K = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "PRO" });
    asUser(K.userId);
  });

  afterAll(async () => {
    await K?.cleanup();
    await db?.$disconnect();
  });

  it("reprecio solo en futuros impagos: cobrado, pasado, copago manual y FAILED quedan como están", async () => {
    const { programId } = await makePlan({ totalSessions: 5 });
    const s = await state(programId);
    await db.booking.update({ where: { id: s.booking(0).id }, data: { paymentStatus: "PAID" } });
    const past = new Date("2020-03-02T13:00:00Z");
    await db.booking.update({ where: { id: s.booking(1).id }, data: { scheduledFor: past } });
    await db.session.update({ where: { id: s.live[1].id }, data: { scheduledFor: past } }); // I3
    await db.booking.update({ where: { id: s.booking(2).id }, data: { copagoCents: 7_777_00 } });
    await db.booking.update({ where: { id: s.booking(3).id }, data: { paymentStatus: "FAILED" } });
    const s1 = await state(programId);

    const input = { programId, expectedUpdatedAt: iso(s1.program.updatedAt), pricing: { mode: "PER_SESSION" as const, pricePerSessionCents: 12_000_00 } };
    const pv = await previewRepricePlan(input);
    expect(pv).toMatchObject({ ok: true, preview: { bookingsToStamp: 1, bookingsKept: 4, sessionsChanged: 1 } });

    const r = await repricePlan(input);
    expect(r).toMatchObject({ ok: true, data: { stampedBookings: 1, sessionsChanged: 1 } });
    const a = await state(programId);
    expect(a.program.pricePerSessionCents).toBe(12_000_00);
    expect(a.live.map((x) => x.priceCents)).toEqual([10_000_00, 10_000_00, 10_000_00, 10_000_00, 12_000_00]);
    expect([0, 1, 2, 3, 4].map((i) => a.booking(i).copagoCents)).toEqual([10_000_00, 10_000_00, 7_777_00, 10_000_00, 12_000_00]);
    expect(a.booking(0).paymentStatus).toBe("PAID");
    const audit = await db.auditEvent.findFirstOrThrow({ where: { tenantId: K.tenantId, action: "program.reprice", entityId: programId } });
    expect(audit.payload).toMatchObject({ before: { pricingMode: "PER_SESSION", pricePerSessionCents: 10_000_00 }, after: { pricePerSessionCents: 12_000_00 } });

    // CAS: el mismo expectedUpdatedAt ya es viejo.
    expect(await repricePlan(input)).toMatchObject({ ok: false, kind: "stale" });
  });

  it("de 'sin precio' a 'por sesión' estampa por primera vez; y de vuelta a 'sin precio' desestampa", async () => {
    const { programId } = await makePlan({ totalSessions: 3, pricing: null });
    const s = await state(programId);
    expect(s.booking(0)).toMatchObject({ copagoCents: null, pricedByPlan: false });
    const r = await repricePlan({ programId, expectedUpdatedAt: iso(s.program.updatedAt), pricing: { mode: "PER_SESSION", pricePerSessionCents: 8_000_00 } });
    expect(r).toMatchObject({ ok: true, data: { stampedBookings: 3 } });
    const a = await state(programId);
    for (let i = 0; i < 3; i++) expect(a.booking(i)).toMatchObject({ copagoCents: 8_000_00, pricedByPlan: true });
    expect(a.live.every((x) => x.priceCents === 8_000_00)).toBe(true);

    const back = await repricePlan({ programId, expectedUpdatedAt: iso(a.program.updatedAt), pricing: null });
    expect(back).toMatchObject({ ok: true, data: { stampedBookings: 3 } });
    const b = await state(programId);
    for (let i = 0; i < 3; i++) expect(b.booking(i)).toMatchObject({ copagoCents: null, pricedByPlan: false });
    expect(b.program.pricingMode).toBeNull();
  });

  it("PACKAGE: Σ = total con lo bloqueado intacto; por debajo de lo devengado → error; sin filas libres → error", async () => {
    const { programId } = await makePlan({ pricing: { mode: "PACKAGE", totalPriceCents: 100_000_00 } });
    const s = await state(programId);
    // Sesión 1 realizada (devengada) y sesión 2 cobrada: 50.000 bloqueados.
    await db.session.update({ where: { id: s.live[0].id }, data: { completedAt: s.live[0].scheduledFor } });
    await db.booking.update({ where: { id: s.booking(0).id }, data: { status: "COMPLETED" } });
    await db.booking.update({ where: { id: s.booking(1).id }, data: { paymentStatus: "PAID" } });
    const s1 = await state(programId);
    const at = iso(s1.program.updatedAt);

    const below = { programId, expectedUpdatedAt: at, pricing: { mode: "PACKAGE" as const, totalPriceCents: 40_000_00 } };
    const pv = await previewRepricePlan(below);
    expect(pv.ok && pv.preview.error).toMatch(/menor que lo ya cobrado o realizado/);
    expect((await repricePlan(below)).ok).toBe(false);
    expect((await state(programId)).program.totalPriceCents).toBe(100_000_00);

    const ok = await repricePlan({ programId, expectedUpdatedAt: at, pricing: { mode: "PACKAGE", totalPriceCents: 110_000_00 } });
    expect(ok.ok).toBe(true);
    const a = await state(programId);
    expect(a.live.map((x) => x.priceCents)).toEqual([25_000_00, 25_000_00, 30_000_00, 30_000_00]);
    expect(a.booking(2).copagoCents).toBe(30_000_00);
    expect(a.booking(1).copagoCents).toBe(25_000_00);

    // Sin filas libres: las otras dos también cobradas.
    await db.booking.updateMany({ where: { id: { in: [a.booking(2).id, a.booking(3).id] } }, data: { paymentStatus: "PAID" } });
    const a2 = await state(programId);
    const none = await repricePlan({ programId, expectedUpdatedAt: iso(a2.program.updatedAt), pricing: { mode: "PACKAGE", totalPriceCents: 120_000_00 } });
    expect(none).toMatchObject({ ok: false, error: "No quedan sesiones sin cobrar para repartir la diferencia" });
  });

  it("[P2-Z] 'sin precio' con 1 realizada → PACKAGE: preview y commit rechazan con copy accionable (antes: preview OK y 500 por I6)", async () => {
    const { programId } = await makePlan({ totalSessions: 3, pricing: null });
    const s = await state(programId);
    await db.session.update({ where: { id: s.live[0].id }, data: { completedAt: s.live[0].scheduledFor } });
    await db.booking.update({ where: { id: s.booking(0).id }, data: { status: "COMPLETED" } });
    const s1 = await state(programId);
    const input = { programId, expectedUpdatedAt: iso(s1.program.updatedAt), pricing: { mode: "PACKAGE" as const, totalPriceCents: 90_000_00 } };

    const pv = await previewRepricePlan(input);
    expect(pv.ok && pv.preview.error).toMatch(/precio por sesión/);
    const r = await repricePlan(input);
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.error).toMatch(/precio por sesión/);
    const a = await state(programId);
    expect(a.program.pricingMode).toBeNull();
    expect(a.live.map((x) => x.priceCents)).toEqual([null, null, null]);

    // La salida que propone el copy funciona: por sesión, la realizada queda sin cuota.
    const per = await repricePlan({ ...input, pricing: { mode: "PER_SESSION", pricePerSessionCents: 9_000_00 } });
    expect(per).toMatchObject({ ok: true, data: { stampedBookings: 2 } });
    expect((await state(programId)).live.map((x) => x.priceCents)).toEqual([null, 9_000_00, 9_000_00]);
  });

  it("[P2-Z] el verificador (ProgramInvariantViolation) llega como {ok:false} con copy, no como 500, y no escribe nada", async () => {
    const { programId } = await makePlan({ totalSessions: 3 });
    // Dato roto a mano (I5: totalSessions ≠ vivas): el reprecio no lo toca y el verificador lo ve al final.
    await db.treatmentProgram.update({ where: { id: programId }, data: { totalSessions: 7 } });
    const s = await state(programId);
    const r = await repricePlan({ programId, expectedUpdatedAt: iso(s.program.updatedAt), pricing: { mode: "PER_SESSION", pricePerSessionCents: 12_000_00 } });
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/datos inconsistentes/) });
    const a = await state(programId);
    expect(a.program.pricePerSessionCents).toBe(10_000_00);
    expect(a.live.every((x) => x.priceCents === 10_000_00)).toBe(true);
  });

  it("reprecio ∥ Cobrado: el cobro que entra mientras el reprecio espera conserva su monto", async () => {
    const { programId, patientId } = await makePlan();
    const s = await state(programId);
    const key = planPatientLockKey({ tenantId: K.tenantId, patientId });
    const h = hold(db, (tx) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    await h.ready;
    const rp = repricePlan({ programId, expectedUpdatedAt: iso(s.program.updatedAt), pricing: { mode: "PER_SESSION", pricePerSessionCents: 15_000_00 } });
    await waitForAdvisoryWaiter(db, key);
    // "Cobrado" real (no toma el lock del paciente): commitea mientras el reprecio espera.
    const paid = await setBookingCopagoPaid(s.booking(2).id, true);
    expect(paid.ok).toBe(true);
    h.release();
    await h.done;
    const r = await rp;
    expect(r).toMatchObject({ ok: true, data: { stampedBookings: 3 } });
    const a = await state(programId);
    expect(a.booking(2)).toMatchObject({ paymentStatus: "PAID", copagoCents: 10_000_00 });
    expect(a.live[2].priceCents).toBe(10_000_00);
    expect([0, 1, 3].map((i) => a.booking(i).copagoCents)).toEqual([15_000_00, 15_000_00, 15_000_00]);
  });

  it("reprecio ∥ applyDayLock sobre el mismo turno: sin 40P01", async () => {
    const { programId } = await makePlan({ startDayKey: "2031-03-03" });
    const s = await state(programId);
    const target = s.booking(1);
    const dayKey = "2031-03-06"; // jueves de la sesión 2
    const pv = await previewDayLock({ dayKey, practitionerIds: [K.practitionerId], allDay: true });
    if (!pv.ok) throw new Error(pv.error);
    expect(pv.data.affected.map((x) => x.id)).toContain(target.id);

    const h = hold(db, (tx) => tx.$queryRaw`SELECT id FROM "Booking" WHERE id = ${target.id} FOR UPDATE`);
    const pid = await h.ready;
    const both = Promise.allSettled([
      repricePlan({ programId, expectedUpdatedAt: iso(s.program.updatedAt), pricing: { mode: "PER_SESSION", pricePerSessionCents: 11_000_00 } }),
      applyDayLock({
        dayKey,
        practitionerIds: [K.practitionerId],
        allDay: true,
        bookingsDecision: "cancel",
        expectedAffectedIds: pv.data.affected.map((x) => x.id),
      }),
    ]);
    await waitBlockedBy(db, pid, 2);
    h.release();
    await h.done;
    const [rp, dl] = await both;
    expect(rp.status).toBe("fulfilled");
    expect(dl.status).toBe("fulfilled");
    if (rp.status === "fulfilled") expect(rp.value.ok).toBe(true);
    if (dl.status === "fulfilled") expect(dl.value.ok).toBe(true);
    const a = await db.booking.findUniqueOrThrow({ where: { id: target.id } });
    expect(a.status).toBe("CANCELLED");
  });

  it("caracterización: setPatientDefaultCopago y updateInsurer no mueven turnos de plan con precio", async () => {
    const insurerId = await addInsurer(db, K, { copagoCents: 3_000_00 });
    const { programId, patientId } = await makePlan();
    await db.coverage.create({ data: { patientId, insurer: "OS", insurerId, copagoCents: null } });
    const before = await state(programId);
    expect((await setPatientDefaultCopago({ patientId, copagoCents: 1_234_00 })).ok).toBe(true);
    expect((await updateInsurer(insurerId, { copagoCents: 9_999_00 })).ok).toBe(true);
    const after = await state(programId);
    for (let i = 0; i < 4; i++) {
      expect(after.booking(i)).toMatchObject({ copagoCents: before.booking(i).copagoCents, pricedByPlan: true, updatedAt: before.booking(i).updatedAt });
    }
  });
});
