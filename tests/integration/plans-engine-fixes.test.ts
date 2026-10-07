/**
 * P2-Z (fixer del motor, ES2b) · Bugs del motor de Planes encontrados por S16a,
 * S25a y el revisor (a) de concurrencia.
 *
 *   1. BUG MOTOR `moved`/`currentAt` (handoff S16a/S25a): en `replan`,
 *      `commitPlanRowsInTx` comparaba el instante efectivo de la fila contra el
 *      `at` PLANIFICADO de la misma fila (que en replan ya es la fecha nueva),
 *      no contra la fecha ACTUAL de la sesión: una fila "libre" creaba el turno
 *      y dejaba la sesión en la fecha vieja (I3 roto; S16a y S25a lo tapaban con
 *      un workaround en el caller). Se prueba contra las primitivas del motor
 *      DIRECTO, sin el caller, para que el workaround no lo esconda.
 *   2. H-a1 (lado motor): generar turnos ∥ cerrar esa sesión en Seguimiento.
 *      Generar elige las sesiones "sin turno" bajo `lockPlanPatient`, pero
 *      Seguimiento no toma ese lock; el INSERT del turno solo pide FOR KEY SHARE
 *      sobre la sesión (compatible con el UPDATE de `completedAt`), así que nada
 *      los serializaba → sesión realizada con un turno activo futuro (plata C4).
 *      Fix: el commit lockea `FOR UPDATE` las sesiones que escribe y exige que
 *      sigan abiertas.
 *   3. H-a2.2: re-planificar con cambio de refs escribía el plan
 *      (`writeRefsKeepingStampInTx`) ANTES de tocar las sesiones; Seguimiento
 *      lockea Session → TreatmentProgram → ciclo (40P01). Fix: las sesiones de
 *      la selección `FOR UPDATE` id asc antes de escribir el plan.
 *
 * Barreras deterministas (C14), sin sleeps: un holder (tx del owner) retiene
 * la fila de la sesión; se espera con `pg_blocking_pids` a que el competidor
 * quede bloqueado POR el holder — o a que termine sin bloquearse, que es
 * justamente el bug. Fechas en 2030; TZ=UTC (10:00 AR = 13:00Z). Corre con los
 * dos roles (`kinesoft_app` y owner BYPASSRLS = prod).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { createPlan, previewPlan } from "@/lib/plans";
import { generatePlanBookings, linkBookingToSession, previewGeneratePlanBookings } from "@/lib/plans-adopt";
import { previewReplanPlan, replanPlan } from "@/lib/plans-move";
import { commitPlanRowsInTx, reclassifyOrThrowStaleInTx } from "@/lib/plans-engine-internal";
import { lockPlanPatient } from "@/lib/plan-lock";
import { getActor } from "@/lib/session";
import { runWithRls } from "@/lib/rls";
import type { PlanCreateInput, PlanPreview, PlanRowResolution } from "@/lib/plans-types";
import { ownerClient, createEphemeralTenant, addPatient, addPractitioner, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { addPlanBooking } from "@/tests/helpers/plan-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

/** Lunes 10:00 AR. */
const LUN_10 = { v: 1 as const, frequency: "weekly" as const, slots: [{ dow: 1 as const, startMin: 600 }] };

function acceptDefaults(p: PlanPreview): PlanRowResolution[] {
  return p.rows.map((r) => {
    switch (r.defaultResolution) {
      case "move":
        return { index: r.index, kind: "move", at: r.suggestion };
      case "adopt":
        return { index: r.index, kind: "adopt", bookingId: r.flags.duplicate!.bookingId, expectedUpdatedAt: r.flags.duplicate!.updatedAt };
      default:
        return { index: r.index, kind: r.defaultResolution };
    }
  });
}

const allNone = (p: PlanPreview): PlanRowResolution[] => p.rows.map((r) => ({ index: r.index, kind: "none" }));

const ACTIVE = ["PENDING", "CONFIRMED", "COMPLETED"] as const;

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

/**
 * Espera a que alguna sesión quede bloqueada por `pid` (directo o transitivo)
 * o a que `stop()` sea true (el competidor terminó SIN bloquearse: el bug).
 * Devuelve qué pasó; nunca queda un poll colgado.
 */
async function blockedByOrStopped(db: PrismaClient, pid: number, stop: () => boolean, timeoutMs = 10_000): Promise<"blocked" | "stopped"> {
  const t0 = Date.now();
  for (;;) {
    if (stop()) return "stopped";
    const [{ c }] = await db.$queryRaw<{ c: number }[]>`
      SELECT count(*)::int AS c FROM pg_stat_activity a
      WHERE ${pid}::int = ANY(pg_blocking_pids(a.pid))
         OR EXISTS (
           SELECT 1 FROM pg_stat_activity b
           WHERE b.pid = ANY(pg_blocking_pids(a.pid)) AND ${pid}::int = ANY(pg_blocking_pids(b.pid)))`;
    if (c >= 1) return "blocked";
    if (Date.now() - t0 > timeoutMs) throw new Error(`blockedByOrStopped: nadie bloqueado por ${pid}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe.skipIf(!RUN)("P2-Z · fixes del motor de planes", () => {
  let db: PrismaClient;
  let K: EphemeralTenant;
  let pro2: { userId: string; practitionerId: string };

  const planInput = (patientId: string, over: Partial<PlanCreateInput> = {}): PlanCreateInput => ({
    idempotencyKey: randomUUID(),
    patientId,
    discipline: "KINESIOLOGY",
    practitionerId: K.practitionerId,
    serviceId: K.serviceId,
    locationId: null,
    schedule: LUN_10,
    startDayKey: "2030-01-07",
    totalSessions: 2,
    pricing: { mode: "PER_SESSION", pricePerSessionCents: 500_000 },
    rows: [],
    stateToken: "x",
    ...over,
  });

  async function newPlan(patientId: string, over: Partial<PlanCreateInput> = {}, rowsOf: (p: PlanPreview) => PlanRowResolution[] = acceptDefaults) {
    const input = planInput(patientId, over);
    const p = await previewPlan(input);
    if (!p.ok) throw new Error(p.error);
    const r = await createPlan({ ...input, stateToken: p.preview.stateToken, rows: rowsOf(p.preview) });
    if (!r.ok) throw new Error(`createPlan: ${JSON.stringify(r)}`);
    const sessions = await db.session.findMany({ where: { programId: r.programId }, orderBy: { index: "asc" } });
    return { programId: r.programId, sessions };
  }

  beforeAll(async () => {
    db = ownerClient();
    K = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "PRO" });
    pro2 = await addPractitioner(db, K, "PRACTITIONER");
    await db.practitionerService.create({
      data: { tenantId: K.tenantId, practitionerId: pro2.practitionerId, serviceId: K.serviceId, enabled: true },
    });
    asUser(K.userId);
  });

  afterAll(async () => {
    await K?.cleanup();
    await db?.$disconnect();
  });

  // ─── 1. moved / currentAt ──────────────────────────────────────────────────

  it("[P2-Z] motor en modo replan: una sesión existente con fila 'libre' (o 'sin turno') queda en la fecha NUEVA (I3), sin workaround del caller", async () => {
    const patientId = await addPatient(db, K);
    const { programId, sessions } = await newPlan(patientId, {}, allNone);
    // Planificadas: 2030-01-07 y 2030-01-14. Se re-planifican a 2030-01-21 (crea turno) y 2030-01-28 (sin turno).
    const at1 = new Date("2030-01-21T13:00:00.000Z");
    const at2 = new Date("2030-01-28T13:00:00.000Z");
    const actor = await getActor();
    const now = new Date();
    const out = await runWithRls(K.tenantId, async (tx) => {
      await lockPlanPatient(tx, { tenantId: K.tenantId, patientId });
      const target = { newRows: [{ at: at1, sessionId: sessions[0].id }, { at: at2, sessionId: sessions[1].id }] };
      const rc = await reclassifyOrThrowStaleInTx(tx, actor, {
        programId,
        rows: target,
        resolutions: [{ index: sessions[1].index, kind: "none" }],
        now,
        mode: "replan",
      });
      return commitPlanRowsInTx(tx, actor, {
        program: {
          id: programId,
          patientId,
          practitionerId: rc.refs.practitioner.id,
          serviceId: rc.refs.service.id,
          locationId: rc.refs.locationId,
          durationMin: rc.refs.durationMin,
        },
        rows: rc,
        mode: "replan",
        now,
      });
    });
    expect(out.createdBookings).toBe(1);
    const s = await db.session.findMany({ where: { programId }, orderBy: { index: "asc" } });
    expect(s[0].scheduledFor.toISOString()).toBe(at1.toISOString());
    expect(s[1].scheduledFor.toISOString()).toBe(at2.toISOString());
    const b = await db.booking.findFirstOrThrow({ where: { sessionId: sessions[0].id } });
    expect(+b.scheduledFor).toBe(+at1);
  });

  // ─── 2. H-a1: generar ∥ cierre en Seguimiento ──────────────────────────────

  it("[P2-Z] generar ∥ cierre de esa sesión en Seguimiento (cierre primero): la sesión cerrada nunca termina con un turno activo", async () => {
    const patientId = await addPatient(db, K);
    const { programId, sessions } = await newPlan(patientId, { startDayKey: "2030-03-04" }, allNone);
    const p = await previewGeneratePlanBookings({ programId });
    if (!p.ok) throw new Error(p.error);
    expect(p.preview.rows).toHaveLength(2);

    // Seguimiento "reclamó" la sesión 1 (el UPDATE de completedAt de
    // completeSessionInTx) y todavía no commiteó.
    const h = hold(db, (tx) => tx.$executeRaw`UPDATE "Session" SET "completedAt" = now() WHERE id = ${sessions[0].id}`);
    const pid = await h.ready;
    let finished = false;
    const gen = generatePlanBookings({ programId, rows: acceptDefaults(p.preview), stateToken: p.preview.stateToken }).finally(
      () => (finished = true)
    );
    gen.catch(() => {});
    let seen: "blocked" | "stopped";
    try {
      seen = await blockedByOrStopped(db, pid, () => finished);
    } finally {
      h.release();
      await h.done;
    }
    const r = await gen;

    // Sin el fix, generar no espera a nadie (el INSERT pide FOR KEY SHARE, compatible).
    expect(seen).toBe("blocked");
    const s1 = await db.session.findUniqueOrThrow({ where: { id: sessions[0].id } });
    expect(s1.completedAt).not.toBeNull();
    expect(await db.booking.count({ where: { sessionId: sessions[0].id, status: { in: [...ACTIVE] } } })).toBe(0);
    // Todo o nada: la sesión 2 tampoco recibió turno; el usuario ve el preview fresco.
    expect(await db.booking.count({ where: { programId } })).toBe(0);
    expect(r).toMatchObject({ ok: false, kind: "stale-preview" });
    if (!r.ok && "preview" in r && r.preview) expect(r.preview.rows.map((x) => x.sessionId)).toEqual([sessions[1].id]);
  });

  it("lock de sesiones del commit: vincular un turno ATENDIDO a una sesión ya realizada sigue permitido (única excepción a 'abierta')", async () => {
    const patientId = await addPatient(db, K);
    const { programId, sessions } = await newPlan(patientId, { startDayKey: "2030-04-01" }, allNone);
    // Seguimiento la cerró sin turno (realizada a mano).
    await db.session.update({ where: { id: sessions[0].id }, data: { completedAt: new Date("2030-04-01T14:00:00.000Z") } });
    const id = await addPlanBooking(db, K, { patientId, scheduledFor: new Date("2030-04-02T13:00:00.000Z"), copagoCents: null, status: "COMPLETED" });
    const b = await db.booking.findUniqueOrThrow({ where: { id } });
    const program = await db.treatmentProgram.findUniqueOrThrow({ where: { id: programId } });
    const r = await linkBookingToSession({
      programId,
      sessionId: sessions[0].id,
      bookingId: b.id,
      expectedBookingUpdatedAt: b.updatedAt.toISOString(),
      expectedUpdatedAt: program.updatedAt.toISOString(),
    });
    expect(r).toMatchObject({ ok: true });
    const s1 = await db.session.findUniqueOrThrow({ where: { id: sessions[0].id } });
    expect(s1.completedAt).not.toBeNull();
    expect(+s1.scheduledFor).toBe(+b.scheduledFor); // I3 por el motor (sin workaround del caller)
    expect((await db.booking.findUniqueOrThrow({ where: { id } })).sessionId).toBe(sessions[0].id);
  });

  // ─── 3. H-a2.2: replan lockea Session antes de escribir el plan ────────────

  it("[P2-Z] re-planificar con cambio de profesional espera la sesión ANTES de escribir el plan (Session → Program, sin ciclo con Seguimiento)", async () => {
    const patientId = await addPatient(db, K);
    const { programId, sessions } = await newPlan(patientId, { startDayKey: "2030-05-06", totalSessions: 2 });
    const req = { programId, fromSessionId: sessions[0].id, schedule: LUN_10, startDayKey: "2030-05-20", practitionerId: pro2.practitionerId };
    const p = await previewReplanPlan(req);
    if (!p.ok) throw new Error(p.error);

    // Seguimiento tiene la sesión `FOR UPDATE` (paso Session de su orden Session → Program).
    const h = hold(db, (tx) => tx.$queryRaw`SELECT id FROM "Session" WHERE id = ${sessions[1].id} FOR UPDATE`);
    const pid = await h.ready;
    let finished = false;
    const rp = replanPlan({ ...req, rows: acceptDefaults(p.preview), stateToken: p.preview.stateToken }).finally(() => (finished = true));
    rp.catch(() => {});
    let seen: "blocked" | "stopped" = "stopped";
    let programFree: boolean | null = null;
    try {
      seen = await blockedByOrStopped(db, pid, () => finished);
      if (seen === "blocked") {
        // Lo siguiente que pediría Seguimiento: el plan. Si el replan ya lo
        // tiene (escribió las refs antes de esperar la sesión) → 55P03 = ciclo.
        try {
          await db.$queryRaw`SELECT id FROM "TreatmentProgram" WHERE id = ${programId} FOR UPDATE NOWAIT`;
          programFree = true;
        } catch {
          programFree = false;
        }
      }
    } finally {
      h.release();
      await h.done;
    }
    const r = await rp;
    expect(seen).toBe("blocked");
    expect(programFree).toBe(true);
    expect(r).toMatchObject({ ok: true, data: { cancelledBookings: 2, createdBookings: 2 } });
    const ss = await db.session.findMany({ where: { programId }, orderBy: { index: "asc" } });
    expect(ss.map((s) => s.practitionerId)).toEqual([pro2.practitionerId, pro2.practitionerId]);
    const active = await db.booking.findMany({ where: { programId, status: { not: "CANCELLED" } }, include: { session: true } });
    for (const b of active) expect(+b.session!.scheduledFor).toBe(+b.scheduledFor); // I3
  });
});
