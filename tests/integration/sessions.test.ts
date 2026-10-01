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
  completeSessionFromSeguimiento,
  getSessionDetail,
  listOpenSessions,
  rescheduleSession,
  updateSessionExercise,
  updateSessionMeta,
} from "@/lib/sessions";
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
});
