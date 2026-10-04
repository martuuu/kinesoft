/**
 * Seguimiento y sesiones (A2a-S03, 2026-09-30).
 *
 * Contrato del plan (§12.1 A2a-S03 · Tests):
 *   - cierre atómico con meta;
 *   - doble cierre sin duplicar EVA ni notificación;
 *   - reprogramar no toca turnos;
 *   - los buckets incluyen las vencidas y excluyen los planes CANCELLED;
 *   - un actor básico recibe rechazo.
 *
 * Llama a las server actions REALES de `lib/sessions.ts` (getActor real, solo
 * la sesión de Supabase mockeada). Las fixtures (programa, sesiones,
 * ejercicios, turnos) se crean con el owner client: `tenant-factory` no tiene
 * builder de programas y la sesión no lo modifica.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient, ProgramStatus } from "@prisma/client";
import {
  addCustomSession,
  addSessionExercise,
  bulkAddSessionExercises,
  completeSessionFromSeguimiento,
  getSessionDetail,
  listOpenSessions,
  rescheduleSession,
  substituteSessionExercise,
  updateSessionExercise,
  updateSessionMeta,
} from "@/lib/sessions";
import { completeSessionInTx, reopenSessionIfUntouchedInTx } from "@/lib/sessions-internal";
import { runWithRls } from "@/lib/rls";
import { planPatientLockKey } from "@/lib/plan-lock";
import { waitForAdvisoryWaiter } from "@/tests/helpers/advisory-wait";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";
const DAY = 86_400_000;

describe.skipIf(!RUN)("sesiones · Seguimiento (A2a-S03)", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let exerciseId: string;

  /** Programa con `n` sesiones (índices 1..n) espaciadas un día desde `start`. */
  async function makeProgram(
    patientId: string,
    opts: { n?: number; status?: ProgramStatus; start?: Date; totalSessions?: number } = {}
  ) {
    const n = opts.n ?? 3;
    const start = opts.start ?? new Date(Date.now() + 30 * DAY);
    const program = await db.treatmentProgram.create({
      data: {
        tenantId: A.tenantId,
        patientId,
        title: `Plan ${uniqueSuffix()}`,
        totalSessions: opts.totalSessions ?? n,
        frequency: 2,
        startDate: start,
        status: opts.status ?? "ACTIVE",
      },
    });
    const sessions = [];
    for (let i = 1; i <= n; i++) {
      sessions.push(
        await db.session.create({
          data: {
            programId: program.id,
            practitionerId: A.practitionerId,
            index: i,
            scheduledFor: new Date(start.getTime() + (i - 1) * DAY),
          },
        })
      );
    }
    return { program, sessions };
  }

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    const ex = await db.exercise.create({
      data: { slug: `test-ex-${uniqueSuffix()}`, name: "Puente de glúteo", tenantId: A.tenantId },
    });
    exerciseId = ex.id;
    asUser(A.userId);
  });

  afterAll(async () => {
    await A?.cleanup();
    await db?.$disconnect();
  });

  it("cierre atómico: guarda la meta que llega, marca ejercicios y crea la EVA post con ese valor", async () => {
    asUser(A.userId);
    const p = await addPatient(db, A);
    const { sessions } = await makeProgram(p);
    const s = sessions[0];
    // Meta vieja persistida: el cierre tiene que usar la NUEVA (H3).
    await db.session.update({ where: { id: s.id }, data: { paInPost: 9, notes: "vieja" } });
    await db.sessionExercise.createMany({
      data: [
        { sessionId: s.id, exerciseId, order: 1, sets: 3, reps: 10, status: "PENDING" },
        { sessionId: s.id, exerciseId, order: 2, sets: 3, reps: 10, status: "SKIPPED" },
      ],
    });

    const r = await completeSessionFromSeguimiento(s.id, { notes: "Respondió bien", paInPre: 6, paInPost: 3, rpe: 5 });
    expect(r).toEqual({ ok: true, data: { alreadyCompleted: false, programCompleted: false } });

    const row = await db.session.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.completedAt).not.toBeNull();
    expect(row).toMatchObject({ notes: "Respondió bien", paInPre: 6, paInPost: 3, rpe: 5 });
    const exs = await db.sessionExercise.findMany({ where: { sessionId: s.id }, orderBy: { order: "asc" } });
    expect(exs.map((e) => e.status)).toEqual(["DONE", "SKIPPED"]);
    const evas = await db.evaScore.findMany({ where: { patientId: p } });
    expect(evas).toHaveLength(1);
    expect(evas[0]).toMatchObject({ value: 3, source: "session-1-post" });
  });

  it("cierre con meta inválida (EVA 11) → rechaza sin cerrar", async () => {
    asUser(A.userId);
    const p = await addPatient(db, A);
    const { sessions } = await makeProgram(p);
    const r = await completeSessionFromSeguimiento(sessions[0].id, { paInPost: 11 });
    expect(r.ok).toBe(false);
    expect((await db.session.findUniqueOrThrow({ where: { id: sessions[0].id } })).completedAt).toBeNull();
  });

  it("doble cierre (secuencial y concurrente) no duplica EVA ni notificación", async () => {
    asUser(A.userId);
    const p = await addPatient(db, A);
    // 2 sesiones: cerrar la 1ª deja 1 pendiente → dispara la notificación.
    const { sessions } = await makeProgram(p, { n: 2 });
    const s = sessions[0];
    const before = await db.notification.count({ where: { tenantId: A.tenantId, link: `/pacientes/${p}` } });

    const [r1, r2] = await Promise.all([
      completeSessionFromSeguimiento(s.id, { paInPost: 4 }),
      completeSessionFromSeguimiento(s.id, { paInPost: 4 }),
    ]);
    const r3 = await completeSessionFromSeguimiento(s.id, { paInPost: 8, notes: "no debería pisar" });

    expect([r1, r2, r3].every((r) => r.ok)).toBe(true);
    const already = [r1, r2, r3].map((r) => (r.ok ? r.data.alreadyCompleted : null));
    expect(already.filter((x) => x === false)).toHaveLength(1);
    expect(await db.evaScore.count({ where: { patientId: p } })).toBe(1);
    expect(
      await db.notification.count({ where: { tenantId: A.tenantId, link: `/pacientes/${p}` } })
    ).toBe(before + 1);
    const row = await db.session.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.paInPost).toBe(4);
    expect(row.notes).toBeNull();
  });

  it("el plan se autocompleta por CONTEO de sesiones cerradas, no por index == total", async () => {
    asUser(A.userId);
    const p = await addPatient(db, A);
    const { program, sessions } = await makeProgram(p, { n: 3 });
    // Cerrar la última primero: antes esto completaba el plan con 2 pendientes.
    const last = await completeSessionFromSeguimiento(sessions[2].id);
    expect(last.ok && last.data.programCompleted).toBe(false);
    expect((await db.treatmentProgram.findUniqueOrThrow({ where: { id: program.id } })).status).toBe("ACTIVE");

    await completeSessionFromSeguimiento(sessions[0].id);
    const fin = await completeSessionFromSeguimiento(sessions[1].id);
    expect(fin.ok && fin.data.programCompleted).toBe(true);
    expect((await db.treatmentProgram.findUniqueOrThrow({ where: { id: program.id } })).status).toBe("COMPLETED");
  });

  it("un plan CANCELLED no se revive como COMPLETED al cerrar su última sesión", async () => {
    asUser(A.userId);
    const p = await addPatient(db, A);
    const { program, sessions } = await makeProgram(p, { n: 1, status: "CANCELLED" });
    const r = await completeSessionFromSeguimiento(sessions[0].id);
    expect(r.ok && r.data.programCompleted).toBe(false);
    expect((await db.treatmentProgram.findUniqueOrThrow({ where: { id: program.id } })).status).toBe("CANCELLED");
  });

  it("reprogramar mueve solo la sesión: el turno cercano queda donde estaba y se informa el del día", async () => {
    asUser(A.userId);
    const p = await addPatient(db, A);
    const { sessions } = await makeProgram(p, { n: 1, start: new Date("2027-03-10T10:00:00-03:00") });
    const s = sessions[0];
    // Turno a +1 h de la sesión (dentro de la vieja ventana ±2 h).
    const bookingAt = new Date(s.scheduledFor.getTime() + 3_600_000);
    const b = await db.booking.create({
      data: {
        tenantId: A.tenantId,
        practitionerId: A.practitionerId,
        serviceId: A.serviceId,
        patientId: p,
        scheduledFor: bookingAt,
        durationMin: 45,
        idempotencyKey: randomUUID(),
      },
    });

    // A otro día sin turnos → sin aviso.
    const to = new Date(s.scheduledFor.getTime() + 3 * DAY);
    const r = await rescheduleSession({ sessionId: s.id, scheduledFor: to.toISOString() });
    expect(r).toEqual({ ok: true, data: { bookingOnDay: null } });
    expect((await db.session.findUniqueOrThrow({ where: { id: s.id } })).scheduledFor.toISOString()).toBe(to.toISOString());
    const after = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.scheduledFor.toISOString()).toBe(bookingAt.toISOString());
    expect(after.updatedAt.toISOString()).toBe(b.updatedAt.toISOString());

    // Volver al día del turno → lo informa (sin moverlo).
    const back = await rescheduleSession({ sessionId: s.id, scheduledFor: s.scheduledFor.toISOString() });
    expect(back.ok && back.data.bookingOnDay?.id).toBe(b.id);
    expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).scheduledFor.toISOString()).toBe(
      bookingAt.toISOString()
    );
  });

  it("updateSessionMeta valida 0-10, permite vaciar las notas y audita", async () => {
    asUser(A.userId);
    const p = await addPatient(db, A);
    const { sessions } = await makeProgram(p, { n: 1 });
    const s = sessions[0];

    expect((await updateSessionMeta({ sessionId: s.id, rpe: 12 })).ok).toBe(false);
    expect((await updateSessionMeta({ sessionId: s.id, notes: "algo", paInPre: 7 })).ok).toBe(true);
    expect(await db.session.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ notes: "algo", paInPre: 7 });

    expect((await updateSessionMeta({ sessionId: s.id, notes: null, paInPre: null })).ok).toBe(true);
    expect(await db.session.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ notes: null, paInPre: null });

    const audits = await db.auditEvent.count({
      where: { tenantId: A.tenantId, action: "session.meta.update", entityId: s.id },
    });
    expect(audits).toBe(2);
  });

  it("buckets: incluye vencidas sin cerrar; excluye planes CANCELLED y PAUSED de los abiertos", async () => {
    asUser(A.userId);
    const now = Date.now();
    const p = await addPatient(db, A);
    // ACTIVE: vencida (ayer), hoy (ahora), próxima (+2 d) y una realizada ayer.
    const active = await makeProgram(p, { n: 4, start: new Date(now - DAY) });
    await db.session.update({ where: { id: active.sessions[1].id }, data: { scheduledFor: new Date(now) } });
    await db.session.update({ where: { id: active.sessions[2].id }, data: { scheduledFor: new Date(now + 2 * DAY) } });
    await db.session.update({
      where: { id: active.sessions[3].id },
      data: { scheduledFor: new Date(now - DAY), completedAt: new Date(now - DAY) },
    });
    const cancelled = await makeProgram(p, { n: 1, status: "CANCELLED", start: new Date(now - DAY) });
    const paused = await makeProgram(p, { n: 1, status: "PAUSED", start: new Date(now + 2 * DAY) });

    const b = await listOpenSessions();
    const ids = (k: keyof typeof b) => b[k].rows.map((r) => r.id);
    expect(ids("overdue")).toContain(active.sessions[0].id);
    expect(ids("today")).toContain(active.sessions[1].id);
    expect(ids("upcoming")).toContain(active.sessions[2].id);
    expect(ids("recent")).toContain(active.sessions[3].id);
    const everywhere = [...ids("overdue"), ...ids("today"), ...ids("upcoming"), ...ids("recent")];
    expect(everywhere).not.toContain(cancelled.sessions[0].id);
    expect(everywhere).not.toContain(paused.sessions[0].id);
    for (const k of ["overdue", "today", "upcoming", "recent"] as const) {
      expect(b[k].total).toBeGreaterThanOrEqual(b[k].rows.length);
    }
  });

  it("actor básico: no ve el detalle, no aparece en el landing y toda mutación rechaza sin escribir", async () => {
    asUser(A.userId);
    const p = await addPatient(db, A); // asignado al OWNER
    const { program, sessions } = await makeProgram(p, { n: 2, start: new Date(Date.now() + DAY) });
    const s = sessions[0];
    const sx = await db.sessionExercise.create({
      data: { sessionId: s.id, exerciseId, order: 1, sets: 3, reps: 10 },
    });
    const basic = await addPractitioner(db, A, "PRACTITIONER");
    asUser(basic.userId);

    expect(await getSessionDetail(s.id)).toBeNull();
    const b = await listOpenSessions();
    expect(b.upcoming.rows.map((r) => r.id)).not.toContain(s.id);

    const results = [
      await completeSessionFromSeguimiento(s.id, { paInPost: 2 }),
      await updateSessionMeta({ sessionId: s.id, notes: "intruso" }),
      await rescheduleSession({ sessionId: s.id, scheduledFor: new Date(Date.now() + 5 * DAY).toISOString() }),
      await updateSessionExercise({ sessionExerciseId: sx.id, status: "DONE" }),
      await addCustomSession({ programId: program.id, title: "x" }),
    ];
    for (const r of results) expect(r).toMatchObject({ ok: false });

    const row = await db.session.findUniqueOrThrow({ where: { id: s.id } });
    expect(row).toMatchObject({ completedAt: null, notes: null, paInPost: null });
    expect(row.scheduledFor.toISOString()).toBe(s.scheduledFor.toISOString());
    expect((await db.sessionExercise.findUniqueOrThrow({ where: { id: sx.id } })).status).toBe("PENDING");
    expect(await db.session.count({ where: { programId: program.id } })).toBe(2);
    expect(await db.evaScore.count({ where: { patientId: p } })).toBe(0);
    asUser(A.userId);
  });
  // ────────────────────────────────────────────────────────────────────
  // Planes P0 · S02s — internos (C8) y carreras
  // ────────────────────────────────────────────────────────────────────

  it("[P0-S02s] 2 addCustomSession concurrentes no duplican index", async () => {
    asUser(A.userId);
    const p = await addPatient(db, A);
    const { program } = await makeProgram(p, { n: 2 });

    // Un holder externo toma la fila del programa y el lock de estructura del
    // paciente. Antes del fix (it.fails, verificado esperando a los backends bloqueados por el holder): las
    // dos altas leían el último index y se frenaban recién en el INSERT (la FK
    // de Session toma FOR KEY SHARE sobre el programa); al soltar, las dos
    // insertaban index 3 ([1,2,3,3]). Ahora las dos esperan en
    // `lockPlanPatient` ANTES de leer, y se serializan.
    const key = planPatientLockKey({ tenantId: A.tenantId, patientId: p });
    let calls: Promise<unknown>[] = [];
    await db.$transaction(
      async (htx) => {
        await htx.$queryRaw`SELECT id FROM "TreatmentProgram" WHERE id = ${program.id} FOR UPDATE`;
        await htx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
        calls = [
          addCustomSession({ programId: program.id, title: "Extra A" }),
          addCustomSession({ programId: program.id, title: "Extra B" }),
        ];
        await waitForAdvisoryWaiter(db, key, { minWaiters: 2 });
      },
      { timeout: 20_000 }
    );
    const results = await Promise.all(calls);
    expect(results.every((r) => (r as { ok: boolean }).ok)).toBe(true);

    const idx = (await db.session.findMany({ where: { programId: program.id }, select: { index: true } }))
      .map((s) => s.index)
      .sort((a, b) => a - b);
    expect(idx).toEqual([1, 2, 3, 4]);
    expect((await db.treatmentProgram.findUniqueOrThrow({ where: { id: program.id } })).totalSessions).toBe(4);
  });

  it("[P0-S02s] add/substitute/bulk rechazan ejercicios archivados", async () => {
    asUser(A.userId);
    const p = await addPatient(db, A);
    const { program, sessions } = await makeProgram(p, { n: 1 });
    const archived = await db.exercise.create({
      data: { slug: `test-arch-${uniqueSuffix()}`, name: "Archivado", tenantId: A.tenantId, archivedAt: new Date() },
    });
    const sx = await db.sessionExercise.create({
      data: { sessionId: sessions[0].id, exerciseId, order: 1, sets: 3, reps: 10 },
    });

    const add = await addSessionExercise({ sessionId: sessions[0].id, exerciseId: archived.id });
    const sub = await substituteSessionExercise({ sessionExerciseId: sx.id, newExerciseId: archived.id });
    const bulk = await bulkAddSessionExercises({
      programId: program.id,
      exerciseIds: [archived.id],
      range: { kind: "all" },
    });
    expect(add.ok).toBe(false);
    expect(sub.ok).toBe(false);
    expect(bulk.ok).toBe(false);
    expect(await db.sessionExercise.count({ where: { exerciseId: archived.id } })).toBe(0);
    // El substitute rechazado no se llevó el ejercicio original.
    expect(await db.sessionExercise.findUnique({ where: { id: sx.id } })).not.toBeNull();
  });

  it("[P0-S02s] bulk no toca completadas", async () => {
    asUser(A.userId);
    const p = await addPatient(db, A);
    const { program, sessions } = await makeProgram(p, { n: 2 });
    await db.session.update({ where: { id: sessions[0].id }, data: { completedAt: new Date() } });

    const r = await bulkAddSessionExercises({ programId: program.id, exerciseIds: [exerciseId], range: { kind: "all" } });
    expect(r).toEqual({ ok: true, data: { created: 1, skipped: 0 } });
    expect(await db.sessionExercise.count({ where: { sessionId: sessions[0].id } })).toBe(0);
    expect(await db.sessionExercise.count({ where: { sessionId: sessions[1].id } })).toBe(1);
  });

  it("[P0-S02s] reschedule en plan CANCELLED → rechazo", async () => {
    asUser(A.userId);
    const p = await addPatient(db, A);
    for (const status of ["CANCELLED", "COMPLETED"] as const) {
      const { sessions } = await makeProgram(p, { n: 1, status });
      const s = sessions[0];
      const r = await rescheduleSession({
        sessionId: s.id,
        scheduledFor: new Date(s.scheduledFor.getTime() + 2 * DAY).toISOString(),
      });
      expect(r.ok).toBe(false);
      expect((await db.session.findUniqueOrThrow({ where: { id: s.id } })).scheduledFor.toISOString()).toBe(
        s.scheduledFor.toISOString()
      );
    }
  });

  it("rescheduleSession valida con zod: fecha sin hora/offset → rechazo sin escribir", async () => {
    asUser(A.userId);
    const p = await addPatient(db, A);
    const { sessions } = await makeProgram(p, { n: 1 });
    const s = sessions[0];
    // "2027-03-10" a pelo el host lo lee como 00:00 UTC = 21:00 AR del día anterior.
    for (const scheduledFor of ["2027-03-10", "mañana", ""]) {
      expect(await rescheduleSession({ sessionId: s.id, scheduledFor })).toMatchObject({ ok: false });
    }
    expect((await db.session.findUniqueOrThrow({ where: { id: s.id } })).scheduledFor.toISOString()).toBe(
      s.scheduledFor.toISOString()
    );
  });

  it("completeSessionInTx 'booking': solo completedAt (sin ejercicios, EVA ni meta), sin autocompletar, idempotente", async () => {
    const p = await addPatient(db, A);
    const { program, sessions } = await makeProgram(p, { n: 1 });
    const s = sessions[0];
    await db.session.update({ where: { id: s.id }, data: { paInPost: 5 } });
    await db.sessionExercise.create({ data: { sessionId: s.id, exerciseId, order: 1, sets: 3, reps: 10 } });
    const now = new Date();

    const r1 = await runWithRls(A.tenantId, (tx) =>
      completeSessionInTx(tx, {
        tenantId: A.tenantId,
        sessionId: s.id,
        actorId: A.userId,
        source: "booking",
        meta: { notes: "no se escribe", paInPost: 9 },
        now,
      })
    );
    expect(r1).toEqual({ claimed: true, programId: program.id });
    const row = await db.session.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.completedAt?.toISOString()).toBe(now.toISOString());
    expect(row).toMatchObject({ notes: null, paInPost: 5 });
    expect((await db.sessionExercise.findFirstOrThrow({ where: { sessionId: s.id } })).status).toBe("PENDING");
    expect(await db.evaScore.count({ where: { patientId: p } })).toBe(0);
    // 1/1 sesiones cerradas y el plan sigue ACTIVE: el helper no autocompleta.
    expect((await db.treatmentProgram.findUniqueOrThrow({ where: { id: program.id } })).status).toBe("ACTIVE");
    expect(
      await db.auditEvent.count({ where: { tenantId: A.tenantId, action: "session.complete", entityId: s.id } })
    ).toBe(1);

    const r2 = await runWithRls(A.tenantId, (tx) =>
      completeSessionInTx(tx, { tenantId: A.tenantId, sessionId: s.id, actorId: A.userId, source: "booking", now })
    );
    expect(r2).toEqual({ claimed: false, programId: program.id });
    expect(
      await db.auditEvent.count({ where: { tenantId: A.tenantId, action: "session.complete", entityId: s.id } })
    ).toBe(1);
  });

  it("completeSessionInTx: sesión de otro tenant → no la encuentra y no escribe", async () => {
    const B = await createEphemeralTenant(db);
    try {
      const p = await addPatient(db, A);
      const { sessions } = await makeProgram(p, { n: 1 });
      const r = await runWithRls(B.tenantId, (tx) =>
        completeSessionInTx(tx, {
          tenantId: B.tenantId,
          sessionId: sessions[0].id,
          actorId: B.userId,
          source: "seguimiento",
          now: new Date(),
        })
      );
      expect(r).toEqual({ claimed: false, programId: null });
      expect((await db.session.findUniqueOrThrow({ where: { id: sessions[0].id } })).completedAt).toBeNull();
    } finally {
      await B.cleanup();
    }
  });

  it("reopenSessionIfUntouchedInTx: reabre la untouched; la tocada queda realizada; otro tenant no la ve", async () => {
    const p = await addPatient(db, A);
    const { sessions } = await makeProgram(p, { n: 4 });
    const done = new Date();
    for (const s of sessions) await db.session.update({ where: { id: s.id }, data: { completedAt: done } });
    // [0] untouched (ejercicio PENDING no cuenta) · [1] con notas · [2] con un ejercicio DONE · [3] abierta.
    await db.sessionExercise.create({ data: { sessionId: sessions[0].id, exerciseId, order: 1, sets: 3, reps: 10 } });
    await db.session.update({ where: { id: sessions[1].id }, data: { notes: "evolución" } });
    await db.sessionExercise.create({
      data: { sessionId: sessions[2].id, exerciseId, order: 1, sets: 3, reps: 10, status: "DONE" },
    });
    await db.session.update({ where: { id: sessions[3].id }, data: { completedAt: null } });

    const reopen = (tenantId: string, sessionId: string) =>
      runWithRls(tenantId, (tx) => reopenSessionIfUntouchedInTx(tx, { tenantId, sessionId, now: new Date() }));

    expect(await reopen(A.tenantId, sessions[0].id)).toEqual({ reopened: true });
    expect(await reopen(A.tenantId, sessions[1].id)).toEqual({ reopened: false, reason: "touched" });
    expect(await reopen(A.tenantId, sessions[2].id)).toEqual({ reopened: false, reason: "touched" });
    expect(await reopen(A.tenantId, sessions[3].id)).toEqual({ reopened: false, reason: "not-completed" });

    const rows = await db.session.findMany({ where: { id: { in: sessions.map((s) => s.id) } } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(sessions[0].id)?.completedAt).toBeNull();
    expect(byId.get(sessions[1].id)?.completedAt).not.toBeNull();
    expect(byId.get(sessions[2].id)?.completedAt).not.toBeNull();

    const B = await createEphemeralTenant(db);
    try {
      expect(await reopen(B.tenantId, sessions[1].id)).toEqual({ reopened: false, reason: "not-found" });
    } finally {
      await B.cleanup();
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // Planes P0 · cierre de ES1 (P0.Z) — carreras de Seguimiento
  // ────────────────────────────────────────────────────────────────────

  /**
   * Espera a que `n` backends estén bloqueados en un lock de FILA con una
   * sentencia que matchea `pattern`. `advisory-wait` filtra por clave de
   * advisory; acá los locks son de fila, que en `pg_locks` no tienen clave
   * legible, así que se mira `pg_stat_activity` (wait_event_type = 'Lock').
   * Si no se llega a bloquear en el plazo, tira: la carrera no se probó.
   */
  async function waitForRowLockWaiters(pattern: string, n: number, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    let last = 0;
    for (;;) {
      const rows = await db.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE ${pattern}`;
      last = rows[0]?.n ?? 0;
      if (last >= n) return;
      if (Date.now() >= deadline) throw new Error(`waitForRowLockWaiters: ${last}/${n} en ${pattern}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it("[P0-Z] dos cierres concurrentes de las últimas sesiones autocompletan el plan", async () => {
    asUser(A.userId);
    const p = await addPatient(db, A);
    const { program, sessions } = await makeProgram(p, { n: 3 });
    await db.session.update({ where: { id: sessions[0].id }, data: { completedAt: new Date() } });
    const last2 = [sessions[1], sessions[2]];
    for (const s of last2) {
      await db.sessionExercise.create({ data: { sessionId: s.id, exerciseId, order: 1, sets: 3, reps: 10 } });
    }

    // Barrera: un holder lockea los ejercicios de las dos sesiones. Cada cierre
    // reclama su sesión y se frena en el UPDATE de sus ejercicios; al soltar,
    // los dos siguen a la vez. Antes del fix cada uno contaba las realizadas
    // sin ver el cierre (sin commitear) del otro → 2/3 en los dos → el plan
    // quedaba ACTIVE con 3/3. Con el FOR UPDATE del programa antes del conteo,
    // el segundo espera el commit del primero y cuenta 3/3.
    let calls: Promise<Awaited<ReturnType<typeof completeSessionFromSeguimiento>>>[] = [];
    await db.$transaction(
      async (htx) => {
        await htx.$queryRaw`SELECT id FROM "SessionExercise" WHERE "sessionId" IN (${last2[0].id}, ${last2[1].id}) FOR UPDATE`;
        calls = last2.map((s) => completeSessionFromSeguimiento(s.id));
        await waitForRowLockWaiters('%"SessionExercise"%', 2);
      },
      { timeout: 20_000 }
    );
    const results = await Promise.all(calls);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.ok && r.data.programCompleted)).toHaveLength(1);
    expect((await db.treatmentProgram.findUniqueOrThrow({ where: { id: program.id } })).status).toBe("COMPLETED");
    expect(
      await db.auditEvent.count({ where: { tenantId: A.tenantId, action: "program.status", entityId: program.id } })
    ).toBe(1);
  });

  it("[P0-Z] reprogramar vs. cierre concurrente: una sesión realizada no se mueve", async () => {
    asUser(A.userId);
    const p = await addPatient(db, A);
    const { sessions } = await makeProgram(p, { n: 1 });
    const s = sessions[0];

    // El holder cierra la sesión y la tiene lockeada. Antes del fix el
    // reprogramar leía `completedAt` null (snapshot), pasaba el chequeo y su
    // UPDATE por id esperaba el lock; al commitear el cierre, lo pisaba igual:
    // sesión realizada con la fecha movida. Ahora lee con FOR UPDATE y re-chequea.
    let call: ReturnType<typeof rescheduleSession> | undefined;
    await db.$transaction(
      async (htx) => {
        await htx.session.update({ where: { id: s.id }, data: { completedAt: new Date() } });
        call = rescheduleSession({ sessionId: s.id, scheduledFor: new Date(s.scheduledFor.getTime() + 2 * DAY).toISOString() });
        await waitForRowLockWaiters('%"Session"%', 1);
      },
      { timeout: 20_000 }
    );
    const r = await call!;
    expect(r.ok).toBe(false);
    const row = await db.session.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.scheduledFor.toISOString()).toBe(s.scheduledFor.toISOString());
    expect(row.completedAt).not.toBeNull();
  });

  it("[P0-Z] reprogramar vs. cancelar el plan en paralelo: espera el estado del plan y rechaza", async () => {
    asUser(A.userId);
    const p = await addPatient(db, A);
    const { program, sessions } = await makeProgram(p, { n: 1 });
    const s = sessions[0];

    let call: ReturnType<typeof rescheduleSession> | undefined;
    await db.$transaction(
      async (htx) => {
        await htx.treatmentProgram.update({ where: { id: program.id }, data: { status: "CANCELLED" } });
        call = rescheduleSession({ sessionId: s.id, scheduledFor: new Date(s.scheduledFor.getTime() + 2 * DAY).toISOString() });
        await waitForRowLockWaiters('%"TreatmentProgram"%FOR UPDATE%', 1);
      },
      { timeout: 20_000 }
    );
    const r = await call!;
    expect(r.ok).toBe(false);
    expect((await db.session.findUniqueOrThrow({ where: { id: s.id } })).scheduledFor.toISOString()).toBe(
      s.scheduledFor.toISOString()
    );
  });
});
