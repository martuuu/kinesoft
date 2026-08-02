"use server";

/**
 * Seguimiento domain — session-level workflow.
 *
 * `listOpenSessions` returns the practitioner's upcoming + today + recently-
 * completed sessions across all programs (the Seguimiento landing).
 * `getSessionDetail` returns one session with its program, patient and
 * exercise checklist. `updateSessionExercise` lets the practitioner tick
 * off exercises mid-session, edit sets/reps or leave per-exercise notes.
 */
import { revalidatePath } from "next/cache";
import { runWithRls } from "@/lib/rls";
import { getActor } from "@/lib/session";
import { audit } from "@/lib/audit";
import { notify } from "@/lib/notifications-internal";
import { gatingForActor } from "@/lib/plan-gating";
import type { ActionResult } from "@/lib/validation";
import { NotificationKind, type SessionExerciseStatus } from "@prisma/client";

import type { OpenSessionRow } from "@/lib/sessions-types";

export async function listOpenSessions(): Promise<OpenSessionRow[]> {
  const actor = await getActor();
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - 14);

  const rows = await runWithRls(actor.tenantId, (tx) => tx.session.findMany({
    where: {
      program: { tenantId: actor.tenantId },
      OR: [{ completedAt: null }, { completedAt: { gte: since } }],
    },
    orderBy: [{ completedAt: "asc" }, { scheduledFor: "asc" }],
    include: {
      program: { include: { patient: true } },
      exercises: { select: { status: true } },
    },
    take: 80,
  }));

  return rows.map((s) => ({
    id: s.id,
    index: s.index,
    scheduledFor: s.scheduledFor,
    completedAt: s.completedAt,
    patientId: s.program.patientId,
    patientName: `${s.program.patient.firstName} ${s.program.patient.lastName}`,
    programTitle: s.program.title,
    totalSessions: s.program.totalSessions,
    exerciseCount: s.exercises.length,
    doneCount: s.exercises.filter((e) => e.status === "DONE").length,
  }));
}

export async function getSessionDetail(id: string) {
  const actor = await getActor();
  return runWithRls(actor.tenantId, (tx) => tx.session.findFirst({
    where: { id, program: { tenantId: actor.tenantId } },
    include: {
      program: {
        include: {
          patient: true,
          case: {
            include: { diagnoses: { include: { condition: true }, take: 1, orderBy: { rank: "asc" } } },
          },
          sessions: {
            orderBy: { index: "asc" },
            select: {
              id: true,
              index: true,
              completedAt: true,
              paInPre: true,
              paInPost: true,
            },
          },
        },
      },
      exercises: {
        orderBy: { order: "asc" },
        include: { exercise: true },
      },
    },
  }));
}

export async function updateSessionExercise(input: {
  sessionExerciseId: string;
  status?: SessionExerciseStatus;
  sets?: number;
  reps?: number;
  notes?: string;
}): Promise<ActionResult> {
  const actor = await getActor();
  // Ownership check via the program join.
  const sx = await runWithRls(actor.tenantId, (tx) => tx.sessionExercise.findFirst({
    where: {
      id: input.sessionExerciseId,
      session: { program: { tenantId: actor.tenantId } },
    },
    select: { id: true, sessionId: true, session: { select: { program: { select: { patientId: true } } } } },
  }));
  if (!sx) return { ok: false, error: "Ejercicio no encontrado." };

  const data: { status?: SessionExerciseStatus; sets?: number; reps?: number; notes?: string } = {};
  if (input.status !== undefined) data.status = input.status;
  if (input.sets !== undefined) data.sets = input.sets;
  if (input.reps !== undefined) data.reps = input.reps;
  if (input.notes !== undefined) data.notes = input.notes;

  await runWithRls(actor.tenantId, (tx) => tx.sessionExercise.update({ where: { id: input.sessionExerciseId }, data }));
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "sessionExercise.update",
    entity: "SessionExercise",
    entityId: input.sessionExerciseId,
    payload: data as Record<string, unknown>,
  });

  revalidatePath(`/seguimiento/${sx.sessionId}`);
  revalidatePath(`/pacientes/${sx.session.program.patientId}`);
  return { ok: true, data: undefined };
}

/**
 * Reschedule one session within a plan + sync its companion booking
 * (if any). Used from the patient profile PlanView when the patient
 * can't make the original slot.
 *
 * Strategy for booking sync:
 *   - Look for a booking belonging to the same patient + practitioner
 *     within ±2 h of the original `scheduledFor`. If we find one,
 *     update it to the new datetime + practitioner.
 *   - If there's no companion booking (e.g. the plan was created from
 *     /diagnostico, which doesn't auto-create bookings), the session
 *     just gets the new datetime — the kine can create the booking
 *     manually from /agenda.
 */
export async function rescheduleSession(input: {
  sessionId: string;
  scheduledFor: string; // ISO
  practitionerId?: string;
}): Promise<ActionResult> {
  const actor = await getActor();
  const session = await runWithRls(actor.tenantId, (tx) => tx.session.findFirst({
    where: { id: input.sessionId, program: { tenantId: actor.tenantId } },
    include: {
      program: { select: { id: true, patientId: true, tenantId: true } },
    },
  }));
  if (!session) return { ok: false, error: "Sesión no encontrada." };

  const newDate = new Date(input.scheduledFor);
  if (Number.isNaN(newDate.getTime())) {
    return { ok: false, error: "Fecha inválida." };
  }

  const targetPractitioner = input.practitionerId ?? session.practitionerId;
  if (targetPractitioner !== session.practitionerId) {
    const ownedPrac = await runWithRls(actor.tenantId, (tx) => tx.practitioner.findFirst({
      where: { id: targetPractitioner, tenantId: actor.tenantId },
      select: { id: true },
    }));
    if (!ownedPrac) return { ok: false, error: "Profesional fuera del tenant." };
  }

  // Look for a companion booking within ±2h of the original session time
  // belonging to the same patient + practitioner.
  const originalTime = session.scheduledFor.getTime();
  const window = 2 * 3_600_000;
  const companion = await runWithRls(actor.tenantId, (tx) => tx.booking.findFirst({
    where: {
      tenantId: actor.tenantId,
      patientId: session.program.patientId,
      practitionerId: session.practitionerId,
      scheduledFor: {
        gte: new Date(originalTime - window),
        lt: new Date(originalTime + window),
      },
      status: { notIn: ["CANCELLED"] },
    },
    select: { id: true },
  }));

  await runWithRls(actor.tenantId, async (tx) => {
    await tx.session.update({
      where: { id: input.sessionId },
      data: { scheduledFor: newDate, practitionerId: targetPractitioner },
    });
    if (companion) {
      await tx.booking.update({
        where: { id: companion.id },
        data: { scheduledFor: newDate, practitionerId: targetPractitioner },
      });
    }
  });

  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "session.reschedule",
    entity: "Session",
    entityId: input.sessionId,
    payload: {
      from: session.scheduledFor.toISOString(),
      to: newDate.toISOString(),
      practitionerId: targetPractitioner,
      bookingSynced: !!companion,
    },
  });

  revalidatePath(`/pacientes/${session.program.patientId}`);
  revalidatePath("/agenda");
  return { ok: true, data: undefined };
}

export async function updateSessionMeta(input: {
  sessionId: string;
  notes?: string;
  paInPre?: number;
  paInPost?: number;
  rpe?: number;
}): Promise<ActionResult> {
  const actor = await getActor();
  const s = await runWithRls(actor.tenantId, (tx) => tx.session.findFirst({
    where: { id: input.sessionId, program: { tenantId: actor.tenantId } },
    select: { id: true, program: { select: { patientId: true } } },
  }));
  if (!s) return { ok: false, error: "Sesión no encontrada." };

  await runWithRls(actor.tenantId, (tx) => tx.session.update({
    where: { id: input.sessionId },
    data: {
      notes: input.notes,
      paInPre: input.paInPre,
      paInPost: input.paInPost,
      rpe: input.rpe,
    },
  }));
  revalidatePath(`/seguimiento/${input.sessionId}`);
  return { ok: true, data: undefined };
}

export async function completeSessionFromSeguimiento(sessionId: string): Promise<ActionResult> {
  const actor = await getActor();
  const s = await runWithRls(actor.tenantId, (tx) => tx.session.findFirst({
    where: { id: sessionId, program: { tenantId: actor.tenantId } },
    include: {
      program: { include: { patient: { select: { firstName: true, lastName: true } } } },
      exercises: true,
    },
  }));
  if (!s) return { ok: false, error: "Sesión no encontrada." };

  await runWithRls(actor.tenantId, (tx) => tx.session.update({
    where: { id: sessionId },
    data: { completedAt: new Date() },
  }));
  // Mark any remaining "PENDING" exercises as DONE for consistency unless the
  // practitioner explicitly skipped them.
  await runWithRls(actor.tenantId, (tx) => tx.sessionExercise.updateMany({
    where: { sessionId, status: "PENDING" },
    data: { status: "DONE" },
  }));
  if (s.paInPost != null) {
    await runWithRls(actor.tenantId, (tx) => tx.evaScore.create({
      data: {
        patientId: s.program.patientId,
        value: s.paInPost!,
        source: `session-${s.index}-post`,
      },
    }));
  }
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "session.complete",
    entity: "Session",
    entityId: sessionId,
  });

  // Nearing-discharge signal: notify when we cross the last-2 threshold,
  // and again when the final session is closed.
  const total = s.program.totalSessions;
  const remaining = total - s.index;
  const patientName = `${s.program.patient.firstName} ${s.program.patient.lastName}`;
  if (actor.userId && (remaining === 1 || remaining === 0)) {
    await notify({
      tenantId: actor.tenantId,
      userId: actor.userId,
      kind: NotificationKind.PROGRAM_NEARING_DISCHARGE,
      title:
        remaining === 0
          ? `Plan completado · ${patientName}`
          : `Última sesión próxima · ${patientName}`,
      body:
        remaining === 0
          ? `Programá el alta o la continuidad.`
          : `Sesión ${total} de ${total} pendiente.`,
      link: `/pacientes/${s.program.patientId}`,
    });
  }
  // Auto-complete the program when the last session closes.
  if (remaining === 0) {
    await runWithRls(actor.tenantId, (tx) => tx.treatmentProgram.update({
      where: { id: s.program.id },
      data: { status: "COMPLETED" },
    }));
  }

  revalidatePath(`/seguimiento`);
  revalidatePath(`/seguimiento/${sessionId}`);
  revalidatePath(`/pacientes/${s.program.patientId}`);
  revalidatePath(`/dashboard`);
  return { ok: true, data: undefined };
}

/**
 * Reorder the exercises of a session in one shot. Re-assigns `order`
 * sequentially based on the supplied id array. Uses a transaction so an
 * interrupted update doesn't leave the session with duplicate orders.
 *
 * Workaround for the @@unique([sessionId, order]) constraint: bump
 * everything to negative orders first, then rewrite to the target order.
 */
export async function reorderSessionExercises(input: {
  sessionId: string;
  orderedIds: string[];
}): Promise<ActionResult> {
  const actor = await getActor();
  const sess = await runWithRls(actor.tenantId, (tx) => tx.session.findFirst({
    where: { id: input.sessionId, program: { tenantId: actor.tenantId } },
    include: { exercises: { select: { id: true } } },
  }));
  if (!sess) return { ok: false, error: "Sesión no encontrada." };
  const known = new Set(sess.exercises.map((e) => e.id));
  const valid = input.orderedIds.filter((id) => known.has(id));
  if (valid.length !== sess.exercises.length) {
    return { ok: false, error: "Lista incompleta." };
  }
  await runWithRls(actor.tenantId, async (tx) => {
    for (const [i, e] of sess.exercises.entries()) {
      await tx.sessionExercise.update({
        where: { id: e.id },
        data: { order: -(i + 1) },
      });
    }
    for (const [i, id] of valid.entries()) {
      await tx.sessionExercise.update({ where: { id }, data: { order: i + 1 } });
    }
  });
  revalidatePath(`/seguimiento/${input.sessionId}`);
  return { ok: true, data: undefined };
}

export async function addSessionExercise(input: {
  sessionId: string;
  exerciseId: string;
  sets?: number;
  reps?: number;
  notes?: string;
}): Promise<ActionResult<{ id: string }>> {
  const actor = await getActor();
  const sess = await runWithRls(actor.tenantId, (tx) => tx.session.findFirst({
    where: { id: input.sessionId, program: { tenantId: actor.tenantId } },
    select: { id: true, program: { select: { patientId: true } } },
  }));
  if (!sess) return { ok: false, error: "Sesión no encontrada." };

  // Gate by plan — a FREE tenant can't sneak a PRO-only exercise by
  // POSTing its id directly.
  const gate = await gatingForActor();
  const ex = await runWithRls(actor.tenantId, (tx) => tx.exercise.findFirst({
    where: { AND: [{ id: input.exerciseId }, gate.visibility] },
    select: { id: true, defaultSets: true, defaultReps: true },
  }));
  if (!ex) return { ok: false, error: "Ejercicio no disponible en este plan." };

  const lastOrder = await runWithRls(actor.tenantId, (tx) => tx.sessionExercise.aggregate({
    where: { sessionId: input.sessionId },
    _max: { order: true },
  }));
  const nextOrder = (lastOrder._max.order ?? 0) + 1;

  const row = await runWithRls(actor.tenantId, (tx) => tx.sessionExercise.create({
    data: {
      sessionId: input.sessionId,
      exerciseId: ex.id,
      order: nextOrder,
      sets: input.sets ?? ex.defaultSets,
      reps: input.reps ?? ex.defaultReps,
      notes: input.notes,
    },
  }));
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "sessionExercise.create",
    entity: "SessionExercise",
    entityId: row.id,
  });
  revalidatePath(`/seguimiento/${input.sessionId}`);
  revalidatePath(`/pacientes/${sess.program.patientId}`);
  return { ok: true, data: { id: row.id } };
}

export async function removeSessionExercise(id: string): Promise<ActionResult> {
  const actor = await getActor();
  const sx = await runWithRls(actor.tenantId, (tx) => tx.sessionExercise.findFirst({
    where: { id, session: { program: { tenantId: actor.tenantId } } },
    select: { id: true, sessionId: true, session: { select: { program: { select: { patientId: true } } } } },
  }));
  if (!sx) return { ok: false, error: "Ejercicio no encontrado." };
  await runWithRls(actor.tenantId, (tx) => tx.sessionExercise.delete({ where: { id } }));
  revalidatePath(`/seguimiento/${sx.sessionId}`);
  revalidatePath(`/pacientes/${sx.session.program.patientId}`);
  return { ok: true, data: undefined };
}

/**
 * Append a custom session to an existing program with a free-form name.
 * Date defaults to "next slot in the cadence" if not provided.
 */
export async function addCustomSession(input: {
  programId: string;
  title?: string;
  scheduledFor?: string; // ISO
}): Promise<ActionResult<{ sessionId: string }>> {
  const actor = await getActor();
  const program = await runWithRls(actor.tenantId, (tx) => tx.treatmentProgram.findFirst({
    where: { id: input.programId, tenantId: actor.tenantId },
    include: { sessions: { orderBy: { index: "desc" }, take: 1 } },
  }));
  if (!program) return { ok: false, error: "Plan no encontrado." };

  const lastIndex = program.sessions[0]?.index ?? 0;
  const lastSched = program.sessions[0]?.scheduledFor ?? program.startDate;
  const cadenceDays = Math.max(1, Math.floor(7 / program.frequency));
  const fallback = new Date(lastSched);
  fallback.setDate(fallback.getDate() + cadenceDays);
  const scheduledFor = input.scheduledFor ? new Date(input.scheduledFor) : fallback;

  const sess = await runWithRls(actor.tenantId, (tx) => tx.session.create({
    data: {
      programId: program.id,
      practitionerId: actor.practitionerId,
      index: lastIndex + 1,
      scheduledFor,
      notes: input.title ?? null,
    },
  }));
  await runWithRls(actor.tenantId, (tx) => tx.treatmentProgram.update({
    where: { id: program.id },
    data: { totalSessions: { increment: 1 } },
  }));
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "session.create",
    entity: "Session",
    entityId: sess.id,
  });
  revalidatePath(`/pacientes/${program.patientId}`);
  revalidatePath(`/seguimiento`);
  return { ok: true, data: { sessionId: sess.id } };
}

/**
 * Swap one exercise in a session for another, keeping the order slot
 * and inheriting series/reps from the replacement's defaults (unless
 * the caller overrides). The old SessionExercise row is removed.
 */
export async function substituteSessionExercise(input: {
  sessionExerciseId: string;
  newExerciseId: string;
}): Promise<ActionResult<{ id: string }>> {
  const actor = await getActor();
  const sx = await runWithRls(actor.tenantId, (tx) => tx.sessionExercise.findFirst({
    where: {
      id: input.sessionExerciseId,
      session: { program: { tenantId: actor.tenantId } },
    },
    include: { session: { include: { program: true } } },
  }));
  if (!sx) return { ok: false, error: "Ejercicio no encontrado." };

  const gate = await gatingForActor();
  const replacement = await runWithRls(actor.tenantId, (tx) => tx.exercise.findFirst({
    where: { AND: [{ id: input.newExerciseId }, gate.visibility] },
    select: { id: true, defaultSets: true, defaultReps: true },
  }));
  if (!replacement) return { ok: false, error: "Ejercicio destino no disponible." };

  const order = sx.order;
  // Two-step: bump the old row to a negative order to bypass the unique
  // constraint, then create the new one in the same slot.
  await runWithRls(actor.tenantId, async (tx) => {
    await tx.sessionExercise.update({
      where: { id: sx.id },
      data: { order: -order },
    });
    await tx.sessionExercise.create({
      data: {
        sessionId: sx.sessionId,
        exerciseId: replacement.id,
        order,
        sets: replacement.defaultSets,
        reps: replacement.defaultReps,
      },
    });
    await tx.sessionExercise.delete({ where: { id: sx.id } });
  });

  revalidatePath(`/seguimiento/${sx.sessionId}`);
  revalidatePath(`/pacientes/${sx.session.program.patientId}`);
  return { ok: true, data: { id: input.newExerciseId } };
}

// ──────────────────────────────────────────────────────────────────────
// Bulk-assign — Sprint 16 (D.1)
// ──────────────────────────────────────────────────────────────────────

/**
 * Programs the actor can pick when bulk-assigning exercises from the
 * Biblioteca. We list every ACTIVE / PAUSED program in the tenant the
 * actor has access to (owner or shared); the picker UI filters by
 * patient as the user types.
 */
export async function listAssignablePrograms(): Promise<
  {
    id: string;
    title: string;
    patientId: string;
    patientName: string;
    totalSessions: number;
    completedSessions: number;
    status: "ACTIVE" | "PAUSED";
  }[]
> {
  const actor = await getActor();
  const rows = await runWithRls(actor.tenantId, (tx) => tx.treatmentProgram.findMany({
    where: {
      tenantId: actor.tenantId,
      status: { in: ["ACTIVE", "PAUSED"] },
    },
    select: {
      id: true,
      title: true,
      status: true,
      totalSessions: true,
      patient: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          assignedPractitionerId: true,
        },
      },
      _count: {
        select: { sessions: { where: { completedAt: { not: null } } } },
      },
    },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
  }));

  // Visibility gate: we don't want to leak that other-owner patients
  // exist via the program picker. Filter using the same access model.
  const { bulkPatientAccess } = await import("@/lib/visibility");
  const access = await bulkPatientAccess(
    actor,
    rows.map((r) => r.patient.id)
  );
  return rows
    .filter((r) => access.get(r.patient.id) === "full")
    .map((r) => ({
      id: r.id,
      title: r.title,
      patientId: r.patient.id,
      patientName: `${r.patient.firstName} ${r.patient.lastName}`,
      totalSessions: r.totalSessions,
      completedSessions: r._count.sessions,
      status: r.status as "ACTIVE" | "PAUSED",
    }));
}

/**
 * Append exercises to a contiguous range of sessions in a program. The
 * `range` decides which sessions receive them:
 *
 *   - `"all"`        → every session
 *   - `{ fromIndex }` → from session N to the end
 *   - `{ phases: [...] }` → only sessions whose phase matches (uses
 *     each session's `index` modulo program length to bucket into
 *     ACTIVATION / STABILITY / LOAD / PROGRESSION — same convention as
 *     `assignDiagnosisAndCreateProgram`)
 *
 * For each target session, every chosen exercise is appended at the end
 * (max order + 1). Default sets/reps come from the Exercise row.
 * Returns the number of (session, exercise) pairs created.
 *
 * Plan-gating is enforced: a FREE tenant cannot bulk-assign exercises
 * outside its visibility window.
 */
export async function bulkAddSessionExercises(input: {
  programId: string;
  exerciseIds: string[];
  range: { kind: "all" } | { kind: "fromIndex"; fromIndex: number };
}): Promise<ActionResult<{ created: number; skipped: number }>> {
  const actor = await getActor();
  if (input.exerciseIds.length === 0) {
    return { ok: false, error: "No seleccionaste ejercicios." };
  }
  if (input.exerciseIds.length > 50) {
    return { ok: false, error: "Demasiados ejercicios (máx. 50 por operación)." };
  }

  const program = await runWithRls(actor.tenantId, (tx) => tx.treatmentProgram.findFirst({
    where: { id: input.programId, tenantId: actor.tenantId },
    select: { id: true, patientId: true, totalSessions: true },
  }));
  if (!program) return { ok: false, error: "Plan no encontrado." };

  // Visibility check on the patient — same gate as everywhere else.
  const { patientAccessFor } = await import("@/lib/visibility");
  if ((await patientAccessFor(actor, program.patientId)) !== "full") {
    return { ok: false, error: "No tenés acceso a este paciente." };
  }

  // Plan-gate the exercise selection: drop any id the actor can't see.
  const gate = await gatingForActor();
  const allowed = await runWithRls(actor.tenantId, (tx) => tx.exercise.findMany({
    where: { AND: [{ id: { in: input.exerciseIds } }, gate.visibility] },
    select: { id: true, defaultSets: true, defaultReps: true },
  }));
  if (allowed.length === 0) {
    return { ok: false, error: "Ningún ejercicio disponible en tu plan." };
  }

  // Resolve target sessions.
  const sessions = await runWithRls(actor.tenantId, (tx) => tx.session.findMany({
    where: {
      programId: program.id,
      ...(input.range.kind === "fromIndex"
        ? { index: { gte: input.range.fromIndex } }
        : {}),
    },
    select: { id: true, index: true },
    orderBy: { index: "asc" },
  }));
  if (sessions.length === 0) {
    return { ok: false, error: "Ninguna sesión coincide con el rango." };
  }

  // Pre-compute the max(order) per session so we can append correctly.
  const orderRows = await runWithRls(actor.tenantId, (tx) => tx.sessionExercise.groupBy({
    by: ["sessionId"],
    where: { sessionId: { in: sessions.map((s) => s.id) } },
    _max: { order: true },
  }));
  const maxOrderBySession = new Map(
    orderRows.map((r) => [r.sessionId, r._max.order ?? 0])
  );

  // Build the createMany payload. Each session gets the full exercise
  // list appended; we walk one session at a time so the running counter
  // is per-session.
  const toCreate: {
    sessionId: string;
    exerciseId: string;
    order: number;
    sets: number;
    reps: number;
  }[] = [];
  let skipped = 0;
  for (const s of sessions) {
    let nextOrder = (maxOrderBySession.get(s.id) ?? 0) + 1;
    for (const ex of allowed) {
      toCreate.push({
        sessionId: s.id,
        exerciseId: ex.id,
        order: nextOrder++,
        sets: ex.defaultSets,
        reps: ex.defaultReps,
      });
    }
  }
  skipped = (input.exerciseIds.length - allowed.length) * sessions.length;

  await runWithRls(actor.tenantId, (tx) => tx.sessionExercise.createMany({ data: toCreate, skipDuplicates: true }));
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "sessionExercise.bulkCreate",
    entity: "TreatmentProgram",
    entityId: program.id,
    payload: {
      sessions: sessions.length,
      exercises: allowed.length,
      created: toCreate.length,
      skipped,
    },
  });

  revalidatePath(`/pacientes/${program.patientId}`);
  return { ok: true, data: { created: toCreate.length, skipped } };
}
