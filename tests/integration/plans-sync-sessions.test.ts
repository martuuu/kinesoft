/**
 * S12b · Sincronía lado sesión (ES2b P2.2; PLANES.md C4 "Escrituras de sesión
 * que propagan al turno", C2 (3), D22/PQ-09, I5/M13, R-LEGACY).
 *
 * Qué afirma (efecto observable en la base, no en el resumen de la action):
 *   - cerrar en Seguimiento lockea el turno activo vinculado y lo pasa a
 *     COMPLETED en la MISMA tx (CAS), y emite `afterBookingsCommitted` una vez;
 *   - "Atendido" (Recepción) ∥ "Cerrar sesión" no se traban (mismo orden de
 *     filas Booking → Session) y la sesión se cierra una sola vez;
 *   - `rescheduleSession` de una sesión con turno activo mueve turno y sesión
 *     por el core (L5); sin turno mueve solo la sesión; nunca cambia el
 *     profesional;
 *   - D22: cerrar la última sesión viva SUGIERE el alta, no completa el plan;
 *   - buckets "Sin turno" (vinculados, sin legacy ni archivadas), "Realizadas
 *     sin evolución" y la sugerencia de alta; ordinal M13 entre las vivas;
 *   - "Cargar evolución" sobre una sesión realizada por "Atendido";
 *   - `reopenSessionIfUntouchedInTx` mira la EVA por `sessionId`;
 *   - `addCustomSession` guarda el título en `Session.title` (antes `notes`:
 *     nunca quedaba "untouched" y "Deshacer Atendido" no la reabría);
 *   - `listAssignablePrograms` / `bulkAddSessionExercises` excluyen archivados;
 *   - sin el módulo `sesiones` (consultorio General) todo export rechaza o
 *     devuelve vacío.
 *
 * Se mockea solo la sesión de Supabase y `next/cache`; las actions corren
 * reales contra Postgres, en los dos roles (kinesoft_app y owner).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { UPDATE_SAME_INSTANT_ERROR } from "@/lib/bookings-constants";
import {
  addCustomSession,
  bulkAddSessionExercises,
  completeSessionFromSeguimiento,
  getSessionDetail,
  listAssignablePrograms,
  listOpenSessions,
  loadSessionEvolution,
  rescheduleSession,
  updateSessionMeta,
} from "@/lib/sessions";
import { markReceptionAction } from "@/lib/bookings";
import { reopenSessionIfUntouchedInTx } from "@/lib/sessions-internal";
import { runWithRls } from "@/lib/rls";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { createPlan, createLegacyPlan, addPlanBooking, addPlanSession, nextSlot } from "@/tests/helpers/plan-factory";
import { asUser } from "@/tests/helpers/actor";
import { waitForAdvisoryWaiter } from "@/tests/helpers/advisory-wait";
import { planPatientLockKey } from "@/lib/plan-lock";
import { revalidateTagSpy } from "@/tests/helpers/integration-setup";

const RUN = process.env.INTEGRATION === "1";
const DAY = 86_400_000;
const FORCE = { allowOverbooking: true, allowPatientOverlap: true, allowOutOfHours: true, allowBlocked: true };

describe.skipIf(!RUN)("S12b · sincronía sesión → turno", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let exerciseId: string;

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
    exerciseId = (
      await db.exercise.create({ data: { slug: `s12b-ex-${uniqueSuffix()}`, name: "Puente", tenantId: T.tenantId } })
    ).id;
  });

  beforeEach(() => {
    asUser(T.userId);
    revalidateTagSpy.mockReset();
  });

  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });

  const booking = (id: string) => db.booking.findUniqueOrThrow({ where: { id } });
  const session = (id: string) => db.session.findUniqueOrThrow({ where: { id } });
  const program = (id: string) => db.treatmentProgram.findUniqueOrThrow({ where: { id } });
  const ver = async (id: string) => (await booking(id)).updatedAt.toISOString();

  /** Un instante de HOY (Recepción solo opera turnos del día AR). */
  let todayMinute = 0;
  const todaySlot = () => {
    todayMinute += 1;
    const d = new Date(Date.now() - 90 * 60_000 + todayMinute * 60_000);
    d.setUTCSeconds(0, 0);
    return d;
  };

  /** Espera `n` backends bloqueados en un lock de FILA cuya sentencia matchea `pattern`. */
  async function waitForRowLockWaiters(pattern: string, n: number, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = await db.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE ${pattern}`;
      if ((rows[0]?.n ?? 0) >= n) return;
      if (Date.now() >= deadline) throw new Error(`waitForRowLockWaiters: ${rows[0]?.n ?? 0}/${n} en ${pattern}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  // ── Cerrar en Seguimiento → turno ───────────────────────────────────────────

  it("[P2-S12b] cerrar en Seguimiento completa el turno", async () => {
    const p = await createPlan(db, T, { sessions: 2, bookings: 1 });
    const [b] = p.bookingIds;
    // I3: la fixture pone el turno en otro instante que la sesión; se alinea
    // (si no, el verificador del cierre hace rollback, que es lo correcto).
    await db.session.update({ where: { id: p.sessionIds[0] }, data: { scheduledFor: (await booking(b)).scheduledFor } });
    const before = await booking(b);

    const r = await completeSessionFromSeguimiento(p.sessionIds[0], { notes: "Bien", paInPost: 3 });
    expect(r).toMatchObject({ ok: true, data: { alreadyCompleted: false, programCompleted: false } });

    const after = await booking(b);
    expect(after.status).toBe("COMPLETED");
    // CAS real: el `updatedAt` se movió (el drawer abierto con la versión vieja da stale).
    expect(+after.updatedAt).toBeGreaterThan(+before.updatedAt);
    const s = await session(p.sessionIds[0]);
    expect(s.completedAt).not.toBeNull();
    expect(s.notes).toBe("Bien");
    // EVA con su sesión (M1: `EvaScore.sessionId`), además del `source` de siempre.
    const evas = await db.evaScore.findMany({ where: { patientId: p.patientId } });
    expect(evas).toHaveLength(1);
    expect(evas[0]).toMatchObject({ value: 3, sessionId: p.sessionIds[0], source: "session-1-post" });
    // Realtime: el turno cambió de estado → una invalidación post-commit.
    expect(revalidateTagSpy).toHaveBeenCalled();
    expect(
      await db.auditEvent.count({ where: { tenantId: T.tenantId, action: "booking.update", entityId: b } })
    ).toBe(1);
  });

  it("cerrar con el turno ya CANCELLED no lo toca (la sesión queda realizada sin turno activo)", async () => {
    const p = await createPlan(db, T, { sessions: 2, bookings: 1, bookingStatus: "CANCELLED" });
    const before = await booking(p.bookingIds[0]);
    const r = await completeSessionFromSeguimiento(p.sessionIds[0]);
    expect(r.ok).toBe(true);
    const after = await booking(p.bookingIds[0]);
    expect(after.status).toBe("CANCELLED");
    expect(+after.updatedAt).toBe(+before.updatedAt);
    expect((await session(p.sessionIds[0])).completedAt).not.toBeNull();
  });

  it("Atendido ∥ Cerrar sin deadlock", async () => {
    const p = await createPlan(db, T, { sessions: 3, bookings: 0 });
    const b = await addPlanBooking(db, T, {
      patientId: p.patientId,
      programId: p.programId,
      sessionId: p.sessionIds[0],
      scheduledFor: todaySlot(),
    });
    await db.session.update({ where: { id: p.sessionIds[0] }, data: { scheduledFor: (await booking(b)).scheduledFor } });
    const llego = await markReceptionAction(b, "llego", await ver(b));
    expect(llego.ok).toBe(true);
    const v = llego.ok ? llego.data.updatedAt : "";

    // Barrera: un holder lockea la sesión. Los dos caminos toman el turno
    // primero (C2 (3)) y se encolan detrás de la sesión o del turno; con el
    // orden invertido en uno de los dos, Postgres abortaría uno con 40P01.
    let calls: [ReturnType<typeof markReceptionAction>, ReturnType<typeof completeSessionFromSeguimiento>] | null = null;
    await db.$transaction(
      async (htx) => {
        await htx.$queryRaw`SELECT id FROM "Session" WHERE id = ${p.sessionIds[0]} FOR UPDATE`;
        calls = [markReceptionAction(b, "atendido", v), completeSessionFromSeguimiento(p.sessionIds[0], { notes: "Evolución" })];
        await waitForRowLockWaiters("%", 1);
        await new Promise((r) => setTimeout(r, 150));
      },
      { timeout: 20_000 }
    );
    const [at, close] = await Promise.all(calls!);
    // Ninguno es un 500 (deadlock): el cierre siempre sale bien; "Atendido"
    // sale bien o como stale si el cierre ganó y ya completó el turno.
    expect(close.ok).toBe(true);
    if (!at.ok) expect(at.error).toMatch(/cambió/i);
    expect((await booking(b)).status).toBe("COMPLETED");
    const s = await session(p.sessionIds[0]);
    expect(s.completedAt).not.toBeNull();
    // La evolución tipeada no se pierde gane quien gane ("Cargar evolución").
    expect(s.notes).toBe("Evolución");
    expect(
      await db.auditEvent.count({ where: { tenantId: T.tenantId, action: "session.complete", entityId: p.sessionIds[0] } })
    ).toBe(1);
  });

  // ── Cargar evolución ────────────────────────────────────────────────────────

  it("'Cargar evolución' sobre una sesión realizada por Atendido: meta, ejercicios y EVA; una sola vez", async () => {
    const p = await createPlan(db, T, { sessions: 2, bookings: 1, bookingStatus: "COMPLETED" });
    const sid = p.sessionIds[0];
    await db.session.update({ where: { id: sid }, data: { completedAt: new Date() } });
    await db.sessionExercise.create({ data: { sessionId: sid, exerciseId, order: 1, sets: 3, reps: 10 } });

    const r1 = await loadSessionEvolution(sid, { notes: "Evolución", paInPre: 6, paInPost: 2 });
    expect(r1).toEqual({ ok: true, data: { loaded: true } });
    const s = await session(sid);
    expect(s).toMatchObject({ notes: "Evolución", paInPre: 6, paInPost: 2 });
    expect((await db.sessionExercise.findFirstOrThrow({ where: { sessionId: sid } })).status).toBe("DONE");
    expect(await db.evaScore.count({ where: { sessionId: sid } })).toBe(1);

    // Ya tiene evolución: no pisa ni duplica EVA (se edita por "Guardar anotaciones").
    const r2 = await loadSessionEvolution(sid, { notes: "otra", paInPost: 9 });
    expect(r2).toEqual({ ok: true, data: { loaded: false } });
    expect((await session(sid)).notes).toBe("Evolución");
    expect(await db.evaScore.count({ where: { sessionId: sid } })).toBe(1);

    // Sobre una sesión abierta no corre: eso es "Cerrar sesión".
    const open = await loadSessionEvolution(p.sessionIds[1], { notes: "x" });
    expect(open.ok).toBe(false);
    expect((await session(p.sessionIds[1])).notes).toBeNull();
  });

  it("reopenSessionIfUntouchedInTx: una EVA con ese sessionId cuenta como evolución", async () => {
    const p = await createPlan(db, T, { sessions: 1 });
    const sid = p.sessionIds[0];
    await db.session.update({ where: { id: sid }, data: { completedAt: new Date() } });
    await db.evaScore.create({ data: { patientId: p.patientId, value: 4, sessionId: sid } });
    const r = await runWithRls(T.tenantId, (tx) =>
      reopenSessionIfUntouchedInTx(tx, { tenantId: T.tenantId, sessionId: sid, now: new Date() })
    );
    expect(r).toEqual({ reopened: false, reason: "touched" });
    expect((await session(sid)).completedAt).not.toBeNull();
  });

  it("addCustomSession guarda el título en Session.title y 'Deshacer Atendido' la reabre", async () => {
    const p = await createPlan(db, T, { sessions: 1 });
    const r = await addCustomSession({ programId: p.programId, title: "Control post-alta" });
    expect(r.ok).toBe(true);
    const sid = r.ok ? r.data.sessionId : "";
    const s = await session(sid);
    expect(s.title).toBe("Control post-alta");
    expect(s.notes).toBeNull();

    const b = await addPlanBooking(db, T, {
      patientId: p.patientId,
      programId: p.programId,
      sessionId: sid,
      scheduledFor: todaySlot(),
    });
    await db.session.update({ where: { id: sid }, data: { scheduledFor: (await booking(b)).scheduledFor } });
    const llego = await markReceptionAction(b, "llego", await ver(b));
    const at = await markReceptionAction(b, "atendido", llego.ok ? llego.data.updatedAt : "");
    expect(at.ok).toBe(true);
    expect((await session(sid)).completedAt).not.toBeNull();
    const undo = await markReceptionAction(b, "deshacer", at.ok ? at.data.updatedAt : "");
    expect(undo.ok).toBe(true);
    expect((await session(sid)).completedAt).toBeNull();
  });

  // ── Reprogramar (L5) ────────────────────────────────────────────────────────

  it("reschedule vinculado mueve ambos", async () => {
    const p = await createPlan(db, T, { sessions: 2, bookings: 1 });
    const [b] = p.bookingIds;
    await db.session.update({ where: { id: p.sessionIds[0] }, data: { scheduledFor: (await booking(b)).scheduledFor } });
    const to = nextSlot();

    const r = await rescheduleSession({ sessionId: p.sessionIds[0], scheduledFor: to.toISOString(), force: FORCE });
    // El turno se movió con la sesión: no hay "turno que quedó en el día" que avisar.
    expect(r).toEqual({ ok: true, data: { bookingOnDay: null } });
    expect((await booking(b)).scheduledFor.toISOString()).toBe(to.toISOString());
    expect((await session(p.sessionIds[0])).scheduledFor.toISOString()).toBe(to.toISOString());
    expect(revalidateTagSpy).toHaveBeenCalled();
  });

  it("reschedule vinculado: el rechazo del core (paciente ya tiene turno a esa hora) no mueve nada", async () => {
    const p = await createPlan(db, T, { sessions: 1, bookings: 1 });
    const [b] = p.bookingIds;
    const at = (await booking(b)).scheduledFor;
    await db.session.update({ where: { id: p.sessionIds[0] }, data: { scheduledFor: at } });
    // Turno suelto del mismo paciente en el destino: el core rechaza (no forzable).
    const to = nextSlot();
    await addPlanBooking(db, T, { patientId: p.patientId, scheduledFor: to });
    const r = await rescheduleSession({ sessionId: p.sessionIds[0], scheduledFor: to.toISOString(), force: FORCE });
    expect(r.ok).toBe(false);
    expect(+(await booking(b)).scheduledFor).toBe(+at);
    expect(+(await session(p.sessionIds[0])).scheduledFor).toBe(+at);
  });

  it("cerrar con I3 roto (fecha de sesión ≠ turno) → rollback total y error controlado (verificador)", async () => {
    const p = await createPlan(db, T, { sessions: 2, bookings: 1 });
    const r = await completeSessionFromSeguimiento(p.sessionIds[0], { notes: "x" });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/inconsistente/) });
    expect((await session(p.sessionIds[0])).completedAt).toBeNull();
    expect((await booking(p.bookingIds[0])).status).toBe("CONFIRMED");
  });

  it("reschedule nunca cambia el profesional; sin turno mueve solo la sesión", async () => {
    const p = await createPlan(db, T, { sessions: 1 });
    const other = await addPractitioner(db, T, "PRACTITIONER");
    const before = await session(p.sessionIds[0]);
    const to = new Date(before.scheduledFor.getTime() + 2 * DAY);

    const bad = await rescheduleSession({
      sessionId: p.sessionIds[0],
      scheduledFor: to.toISOString(),
      practitionerId: other.practitionerId,
    });
    expect(bad.ok).toBe(false);
    expect(+(await session(p.sessionIds[0])).scheduledFor).toBe(+before.scheduledFor);

    const ok = await rescheduleSession({ sessionId: p.sessionIds[0], scheduledFor: to.toISOString() });
    expect(ok.ok).toBe(true);
    const after = await session(p.sessionIds[0]);
    expect(after.scheduledFor.toISOString()).toBe(to.toISOString());
    expect(after.practitionerId).toBe(before.practitionerId);
  });

  // ── D22: sugerir el alta ────────────────────────────────────────────────────

  it("la sesión 10/10 no completa el plan", async () => {
    const p = await createPlan(db, T, { sessions: 10 });
    // Una archivada de más no cuenta (I5 sobre vivas): 10 vivas + 1 archivada.
    await addPlanSession(db, p.programId, { index: 11, practitionerId: T.practitionerId, archivedAt: new Date() });
    await db.session.updateMany({ where: { id: { in: p.sessionIds.slice(0, 9) } }, data: { completedAt: new Date() } });

    const r = await completeSessionFromSeguimiento(p.sessionIds[9]);
    expect(r).toEqual({ ok: true, data: { alreadyCompleted: false, programCompleted: false, suggestDischarge: true } });
    expect((await program(p.programId)).status).toBe("ACTIVE");
    const n = await db.notification.findMany({
      where: { tenantId: T.tenantId, kind: "PROGRAM_NEARING_DISCHARGE", link: `/pacientes/${p.patientId}` },
    });
    expect(n).toHaveLength(1);
    expect(n[0].body).toMatch(/10 sesiones/);

    const b = await listOpenSessions();
    const sug = b.suggestDischarge?.rows.find((x) => x.programId === p.programId);
    expect(sug).toMatchObject({ patientId: p.patientId, totalLive: 10, discipline: "KINESIOLOGY" });
  });

  it("cerrar una que no es la última no sugiere el alta", async () => {
    const p = await createPlan(db, T, { sessions: 3 });
    const r = await completeSessionFromSeguimiento(p.sessionIds[0]);
    expect(r).toEqual({ ok: true, data: { alreadyCompleted: false, programCompleted: false, suggestDischarge: false } });
  });

  // ── Buckets ─────────────────────────────────────────────────────────────────

  it("Sin turno excluye legacy y archivadas", async () => {
    const now = Date.now();
    // Vinculado (tiene un turno): s1 con turno activo, s2 sin turno, s3 con turno cancelado, s4 archivada.
    const p = await createPlan(db, T, { sessions: 3, bookings: 1, startDate: new Date(now + 3 * DAY) });
    const cancelled = await addPlanBooking(db, T, {
      patientId: p.patientId,
      programId: p.programId,
      sessionId: p.sessionIds[2],
      status: "CANCELLED",
    });
    const archived = await addPlanSession(db, p.programId, {
      index: 4,
      practitionerId: T.practitionerId,
      archivedAt: new Date(),
      scheduledFor: new Date(now + 5 * DAY),
    });
    const legacy = await createLegacyPlan(db, T);
    // Plan vinculado archivado: no aparece aunque sus sesiones estén sin turno.
    const archivedPlan = await createPlan(db, T, { sessions: 1, data: { archivedAt: new Date(), schedule: { v: 1 } } });

    const b = await listOpenSessions();
    const ids = (b.sinTurno?.rows ?? []).map((r) => r.id);
    expect(ids).toContain(p.sessionIds[1]);
    expect(ids).toContain(p.sessionIds[2]); // turno CANCELLED = sin turno (C4)
    expect(ids).not.toContain(p.sessionIds[0]);
    expect(ids).not.toContain(archived);
    for (const s of legacy.sessionIds) expect(ids).not.toContain(s);
    expect(ids).not.toContain(archivedPlan.sessionIds[0]);
    expect(cancelled).toBeTruthy();

    // Ordinal M13 entre las vivas (la archivada no corre la cuenta).
    const row = b.sinTurno!.rows.find((r) => r.id === p.sessionIds[2])!;
    expect(row).toMatchObject({ ordinal: 3, totalLive: 3 });
    // Ningún bucket muestra la sesión archivada.
    for (const k of ["overdue", "today", "upcoming", "recent"] as const) {
      expect(b[k].rows.map((r) => r.id)).not.toContain(archived);
    }
  });

  it("Realizadas sin evolución: realizada untouched sí; con notas, EVA o ejercicio hecho no", async () => {
    const p = await createPlan(db, T, { sessions: 4 });
    const done = new Date(Date.now() - DAY);
    await db.session.updateMany({ where: { id: { in: p.sessionIds } }, data: { completedAt: done } });
    await db.session.update({ where: { id: p.sessionIds[1] }, data: { notes: "evolución" } });
    await db.evaScore.create({ data: { patientId: p.patientId, value: 3, sessionId: p.sessionIds[2] } });
    await db.sessionExercise.create({
      data: { sessionId: p.sessionIds[3], exerciseId, order: 1, sets: 3, reps: 10, status: "DONE" },
    });

    const b = await listOpenSessions();
    const ids = (b.realizadasSinEvolucion?.rows ?? []).map((r) => r.id);
    expect(ids).toContain(p.sessionIds[0]);
    for (const s of p.sessionIds.slice(1)) expect(ids).not.toContain(s);
  });

  it("buckets: los totales cuentan y un paciente sin acceso full no aparece en ninguno", async () => {
    const p = await createPlan(db, T, { sessions: 1, data: { schedule: { v: 1 } } });
    const basic = await addPractitioner(db, T, "PRACTITIONER");
    asUser(basic.userId);
    const b = await listOpenSessions();
    expect((b.sinTurno?.rows ?? []).map((r) => r.id)).not.toContain(p.sessionIds[0]);
    expect((b.suggestDischarge?.rows ?? []).map((r) => r.programId)).not.toContain(p.programId);
    asUser(T.userId);
  });

  // ── Bulk / asignables ───────────────────────────────────────────────────────

  it("listAssignablePrograms excluye archivados", async () => {
    const live = await createPlan(db, T, { sessions: 2 });
    const arch = await createPlan(db, T, { sessions: 2, data: { status: "CANCELLED", archivedAt: new Date() } });
    await addPlanSession(db, live.programId, { index: 3, practitionerId: T.practitionerId, archivedAt: new Date() });
    await db.session.update({ where: { id: live.sessionIds[0] }, data: { completedAt: new Date() } });

    const rows = await listAssignablePrograms();
    expect(rows.map((r) => r.id)).toContain(live.programId);
    expect(rows.map((r) => r.id)).not.toContain(arch.programId);
    expect(rows.find((r) => r.id === live.programId)).toMatchObject({ completedSessions: 1 });

    // bulk: el archivado no se toca; en el vivo, la sesión archivada tampoco.
    const r1 = await bulkAddSessionExercises({ programId: arch.programId, exerciseIds: [exerciseId], range: { kind: "all" } });
    expect(r1.ok).toBe(false);
    const r2 = await bulkAddSessionExercises({ programId: live.programId, exerciseIds: [exerciseId], range: { kind: "all" } });
    expect(r2).toEqual({ ok: true, data: { created: 1, skipped: 0 } });
  });

  // ── P2.Z (fixer de Seguimiento): hallazgos H-a1..H-a4 de la revisión ES2b ──

  /**
   * Una action que TIRA (el 500 que se está cazando) se vuelve un resultado
   * marcado: si no, la promesa rechaza mientras el holder todavía espera y
   * vitest lo reporta como "unhandled rejection" en vez de como el fallo del test.
   */
  const thrown = (e: unknown) => ({
    ok: false as const,
    error: `THROWN ${(e as { code?: string })?.code ?? String(e)}`,
  });

  /** Un turno ACTIVO del plan por insert directo, dentro de la tx del holder. */
  const holderBooking = (
    htx: Prisma.TransactionClient,
    o: { patientId: string; scheduledFor: Date; programId?: string; sessionId?: string }
  ) =>
    htx.booking.create({
      data: {
        tenantId: T.tenantId,
        patientId: o.patientId,
        practitionerId: T.practitionerId,
        serviceId: T.serviceId,
        scheduledFor: o.scheduledFor,
        durationMin: 45,
        idempotencyKey: randomUUID(),
        status: "CONFIRMED",
        copagoCents: 0,
        programId: o.programId ?? null,
        sessionId: o.sessionId ?? null,
      },
    });

  it("[P2-Z] cierre ∥ turno que aparece después de leerlo: no queda sesión realizada con turno activo", async () => {
    // H-a1 (lado Seguimiento): el cierre leía el turno activo ANTES del claim
    // y no lo releía. Barrera: el holder lockea la sesión, el cierre lee "sin
    // turno" y queda esperando en el claim; el holder vincula un turno activo
    // a esa sesión y commitea. Antes: la sesión quedaba realizada con un turno
    // CONFIRMED futuro (para cobrar / marcar ausente). Ahora: rechazo
    // controlado y rollback total.
    const p = await createPlan(db, T, { sessions: 2, data: { schedule: { v: 1 } } });
    const sid = p.sessionIds[0];
    const at = nextSlot();
    // I3: misma fecha que el turno que va a aparecer (si no, el verificador
    // haría rollback por otra razón y el test no probaría nada).
    await db.session.update({ where: { id: sid }, data: { scheduledFor: at } });

    let call: ReturnType<typeof completeSessionFromSeguimiento> | null = null;
    await db.$transaction(
      async (htx) => {
        await htx.$queryRaw`SELECT id FROM "Session" WHERE id = ${sid} FOR UPDATE`;
        call = completeSessionFromSeguimiento(sid, { notes: "Evolución" }).catch(thrown);
        await waitForRowLockWaiters('%UPDATE "public"."Session"%', 1);
        await holderBooking(htx, { patientId: p.patientId, scheduledFor: at, programId: p.programId, sessionId: sid });
      },
      { timeout: 20_000 }
    );
    const r = await call!;

    const s = await session(sid);
    const active = await db.booking.count({ where: { sessionId: sid, status: { notIn: ["CANCELLED", "NO_SHOW"] } } });
    expect(active).toBe(1);
    // El invariante que importa: nunca "realizada" con un turno activo sin cerrar.
    const open = await db.booking.count({ where: { sessionId: sid, status: { in: ["PENDING", "CONFIRMED"] } } });
    expect(s.completedAt !== null && open > 0).toBe(false);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/cambió/) });
    expect(s).toMatchObject({ completedAt: null, notes: null });
  });

  it("[P2-Z] cierre ∥ escritura en orden Program → Session (replan): ninguno es un 500", async () => {
    // H-a2: Seguimiento lockea Session → TreatmentProgram; replan/vincular/
    // adoptar escriben el plan antes que la sesión. Holder = ese orden: UPDATE
    // del plan, espera a que el cierre quede trabado en el plan y pide la
    // sesión → 40P01. Postgres aborta al que esperaba primero (el cierre):
    // sin `withTxConflictRetry` era un 500; con el reintento, la segunda
    // vuelta encuentra el camino libre.
    const p = await createPlan(db, T, { sessions: 2 });
    const sid = p.sessionIds[0];
    let call: ReturnType<typeof completeSessionFromSeguimiento> | null = null;
    try {
      await db.$transaction(
        async (htx) => {
          await htx.$executeRaw`UPDATE "TreatmentProgram" SET title = title WHERE id = ${p.programId}`;
          call = completeSessionFromSeguimiento(sid, { notes: "Evolución" }).catch(thrown);
          await waitForRowLockWaiters('%FROM "TreatmentProgram"%FOR%UPDATE%', 1);
          await htx.$queryRaw`SELECT id FROM "Session" WHERE id = ${sid} FOR UPDATE`;
        },
        { timeout: 20_000 }
      );
    } catch {
      // El holder puede ser la víctima del 40P01: da igual, lo que se afirma es el cierre.
    }
    const r = await call!;
    expect(r.ok).toBe(true);
    const s = await session(sid);
    expect(s.completedAt).not.toBeNull();
    expect(s.notes).toBe("Evolución");
    expect(
      await db.auditEvent.count({ where: { tenantId: T.tenantId, action: "session.complete", entityId: sid } })
    ).toBe(1);
  });

  it("[P2-Z] reprogramar sin turno ∥ escritura en orden Program → Session: ninguno es un 500", async () => {
    const p = await createPlan(db, T, { sessions: 2 });
    const sid = p.sessionIds[0];
    const to = new Date((await session(sid)).scheduledFor.getTime() + 2 * DAY);
    let call: ReturnType<typeof rescheduleSession> | null = null;
    try {
      await db.$transaction(
        async (htx) => {
          await htx.$executeRaw`UPDATE "TreatmentProgram" SET title = title WHERE id = ${p.programId}`;
          call = rescheduleSession({ sessionId: sid, scheduledFor: to.toISOString() }).catch(thrown);
          await waitForRowLockWaiters('%FROM "TreatmentProgram"%FOR%UPDATE%', 1);
          await htx.$queryRaw`SELECT id FROM "Session" WHERE id = ${sid} FOR UPDATE`;
        },
        { timeout: 20_000 }
      );
    } catch {
      // Ídem: el holder puede ser la víctima.
    }
    const r = await call!;
    expect(r.ok).toBe(true);
    expect((await session(sid)).scheduledFor.toISOString()).toBe(to.toISOString());
  });

  it("[P2-Z] reprogramar con turno: P2002 de la carrera paciente+instante → mensaje, no 500", async () => {
    // H-a4: el core chequea "mismo paciente, mismo instante" con una lectura;
    // un turno del paciente insertado en paralelo (sin commitear) no se ve, el
    // UPDATE espera el índice único y al commit del otro tira P2002. Antes se
    // propagaba (500); `updateBooking` ya lo traducía.
    const p = await createPlan(db, T, { sessions: 1, bookings: 1 });
    const [b] = p.bookingIds;
    const from = (await booking(b)).scheduledFor;
    await db.session.update({ where: { id: p.sessionIds[0] }, data: { scheduledFor: from } });
    const to = nextSlot();

    let call: ReturnType<typeof rescheduleSession> | null = null;
    await db.$transaction(
      async (htx) => {
        await holderBooking(htx, { patientId: p.patientId, scheduledFor: to });
        call = rescheduleSession({ sessionId: p.sessionIds[0], scheduledFor: to.toISOString(), force: FORCE }).catch(thrown);
        await waitForRowLockWaiters('%UPDATE "public"."Booking"%', 1);
      },
      { timeout: 20_000 }
    );
    const r = await call!;
    expect(r).toEqual({ ok: false, error: UPDATE_SAME_INSTANT_ERROR });
    expect(+(await booking(b)).scheduledFor).toBe(+from);
    expect(+(await session(p.sessionIds[0])).scheduledFor).toBe(+from);
  });

  it("[P2-Z] PACKAGE + 'agregar sesión a medida' sin elegir el precio: rechazo accionable, I6 sano y el plan sigue operable", async () => {
    // H-a3 / B-M1: `addCustomSession` creaba la sesión sin cuota en un
    // paquete vinculado → I6 roto → toda escritura posterior del plan (cerrar,
    // reprogramar, agregar) hacía rollback en el verificador: plan trabado.
    const p = await createPlan(db, T, {
      sessions: 2,
      data: { schedule: { v: 1 }, pricingMode: "PACKAGE", pricePerSessionCents: null, totalPriceCents: 1_000_000 },
    });
    const r = await addCustomSession({ programId: p.programId, title: "Extra" });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/Agregar sesión a medida/) });
    expect(await db.session.count({ where: { programId: p.programId, archivedAt: null } })).toBe(2);

    const c = await completeSessionFromSeguimiento(p.sessionIds[0]);
    expect(c.ok).toBe(true);
  });

  it("[P2-Z] PACKAGE con packagePricing: delega en el motor, Σ cuotas vivas = total y el plan sigue operable", async () => {
    const p = await createPlan(db, T, {
      sessions: 2,
      data: { schedule: { v: 1 }, pricingMode: "PACKAGE", pricePerSessionCents: null, totalPriceCents: 1_000_000 },
    });
    const r = await addCustomSession({ programId: p.programId, title: "Extra", packagePricing: "keep-total" });
    expect(r.ok).toBe(true);
    const sid = r.ok ? r.data.sessionId : "";
    const live = await db.session.findMany({ where: { programId: p.programId, archivedAt: null } });
    expect(live).toHaveLength(3);
    expect(live.reduce((a, s) => a + (s.priceCents ?? NaN), 0)).toBe(1_000_000);
    expect(live.find((s) => s.id === sid)).toMatchObject({ title: "Extra", notes: null });
    expect((await program(p.programId)).totalSessions).toBe(3);
    // Sin fecha: queda "sin turno" (no crea turno).
    expect(await db.booking.count({ where: { sessionId: sid } })).toBe(0);
    expect(
      await db.auditEvent.count({ where: { tenantId: T.tenantId, action: "program.sessions.add", entityId: p.programId } })
    ).toBe(1);
    expect((await completeSessionFromSeguimiento(p.sessionIds[0])).ok).toBe(true);
  });

  it("[P2-Z] PER_SESSION: la sesión a medida nace con la cuota del plan", async () => {
    const p = await createPlan(db, T, { sessions: 1, data: { schedule: { v: 1 } } });
    const r = await addCustomSession({ programId: p.programId, title: "Control" });
    expect(r.ok).toBe(true);
    const s = await session(r.ok ? r.data.sessionId : "");
    expect(s).toMatchObject({ priceCents: 500_000, title: "Control", index: 2 });
  });

  it("[P2-Z] 2 'a medida' concurrentes por el motor: las dos entran, sin index repetido ni stale espurio", async () => {
    // El preview corre BAJO `lockPlanPatient`: la segunda alta espera y
    // previsualiza con la primera adentro, así el `stateToken` coincide.
    const p = await createPlan(db, T, { sessions: 2, data: { schedule: { v: 1 } } });
    const key = planPatientLockKey({ tenantId: T.tenantId, patientId: p.patientId });
    let calls: Array<ReturnType<typeof addCustomSession>> = [];
    await db.$transaction(
      async (htx) => {
        await htx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
        calls = [
          addCustomSession({ programId: p.programId, title: "A" }).catch(thrown),
          addCustomSession({ programId: p.programId, title: "B" }).catch(thrown),
        ];
        await waitForAdvisoryWaiter(db, key, { minWaiters: 2 });
      },
      { timeout: 20_000 }
    );
    const rs = await Promise.all(calls);
    expect(rs.map((r) => r.ok)).toEqual([true, true]);
    const idx = (await db.session.findMany({ where: { programId: p.programId }, select: { index: true } }))
      .map((s) => s.index)
      .sort((a, b) => a - b);
    expect(idx).toEqual([1, 2, 3, 4]);
    expect((await program(p.programId)).totalSessions).toBe(4);
  });

  it("[P2-Z] legacy: plan CANCELLED o archivado rechaza; agregar audita en la tx", async () => {
    const cancelled = await createLegacyPlan(db, T);
    await db.treatmentProgram.update({ where: { id: cancelled.programId }, data: { status: "CANCELLED" } });
    const r1 = await addCustomSession({ programId: cancelled.programId, title: "x" });
    expect(r1.ok).toBe(false);
    expect(await db.session.count({ where: { programId: cancelled.programId } })).toBe(3);

    const archived = await createLegacyPlan(db, T);
    await db.treatmentProgram.update({ where: { id: archived.programId }, data: { archivedAt: new Date() } });
    const r2 = await addCustomSession({ programId: archived.programId, title: "x" });
    expect(r2.ok).toBe(false);
    expect(await db.session.count({ where: { programId: archived.programId } })).toBe(3);

    const ok = await createLegacyPlan(db, T);
    const r3 = await addCustomSession({ programId: ok.programId, title: "Extra" });
    expect(r3.ok).toBe(true);
    const sid = r3.ok ? r3.data.sessionId : "";
    expect(await session(sid)).toMatchObject({ index: 4, title: "Extra" });
    expect(await db.auditEvent.count({ where: { tenantId: T.tenantId, action: "session.create", entityId: sid } })).toBe(1);
  });

  // ── Módulo `sesiones` (EV0) ─────────────────────────────────────────────────

  it("sin el módulo sesiones (consultorio General): lecturas vacías y escrituras rechazadas", async () => {
    const G = await createEphemeralTenant(db, { vertical: "GENERAL" });
    try {
      const p = await createPlan(db, G, { sessions: 1 });
      asUser(G.userId);
      const b = await listOpenSessions();
      for (const k of ["overdue", "today", "upcoming", "recent"] as const) expect(b[k]).toEqual({ rows: [], total: 0 });
      expect(await getSessionDetail(p.sessionIds[0])).toBeNull();
      expect(await listAssignablePrograms()).toEqual([]);
      const writes = [
        await completeSessionFromSeguimiento(p.sessionIds[0]),
        await updateSessionMeta({ sessionId: p.sessionIds[0], notes: "x" }),
        await rescheduleSession({ sessionId: p.sessionIds[0], scheduledFor: new Date(Date.now() + DAY).toISOString() }),
        await addCustomSession({ programId: p.programId, title: "x" }),
        await loadSessionEvolution(p.sessionIds[0], { notes: "x" }),
      ];
      for (const w of writes) expect(w).toMatchObject({ ok: false, error: expect.stringMatching(/seguimiento/i) });
      const s = await session(p.sessionIds[0]);
      expect(s).toMatchObject({ completedAt: null, notes: null });
      expect(await db.session.count({ where: { programId: p.programId } })).toBe(1);
    } finally {
      asUser(T.userId);
      await G.cleanup();
    }
  });
});
