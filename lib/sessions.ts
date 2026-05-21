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
import { prisma } from "@/lib/db";
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

  const rows = await prisma.session.findMany({
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
  });

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
  return prisma.session.findFirst({
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
  });
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
  const sx = await prisma.sessionExercise.findFirst({
    where: {
      id: input.sessionExerciseId,
      session: { program: { tenantId: actor.tenantId } },
    },
    select: { id: true, sessionId: true, session: { select: { program: { select: { patientId: true } } } } },
  });
  if (!sx) return { ok: false, error: "Ejercicio no encontrado." };

  const data: { status?: SessionExerciseStatus; sets?: number; reps?: number; notes?: string } = {};
  if (input.status !== undefined) data.status = input.status;
  if (input.sets !== undefined) data.sets = input.sets;
  if (input.reps !== undefined) data.reps = input.reps;
  if (input.notes !== undefined) data.notes = input.notes;

  await prisma.sessionExercise.update({ where: { id: input.sessionExerciseId }, data });
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
  const session = await prisma.session.findFirst({
    where: { id: input.sessionId, program: { tenantId: actor.tenantId } },
    include: {
      program: { select: { id: true, patientId: true, tenantId: true } },
    },
  });
  if (!session) return { ok: false, error: "Sesión no encontrada." };

  const newDate = new Date(input.scheduledFor);
  if (Number.isNaN(newDate.getTime())) {
    return { ok: false, error: "Fecha inválida." };
  }

  const targetPractitioner = input.practitionerId ?? session.practitionerId;
  if (targetPractitioner !== session.practitionerId) {
    const ownedPrac = await prisma.practitioner.findFirst({
      where: { id: targetPractitioner, tenantId: actor.tenantId },
      select: { id: true },
    });
    if (!ownedPrac) return { ok: false, error: "Profesional fuera del tenant." };
  }

  // Look for a companion booking within ±2h of the original session time
  // belonging to the same patient + practitioner.
  const originalTime = session.scheduledFor.getTime();
  const window = 2 * 3_600_000;
  const companion = await prisma.booking.findFirst({
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
  });

  await prisma.$transaction(async (tx) => {
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
  const s = await prisma.session.findFirst({
    where: { id: input.sessionId, program: { tenantId: actor.tenantId } },
    select: { id: true, program: { select: { patientId: true } } },
  });
  if (!s) return { ok: false, error: "Sesión no encontrada." };

  await prisma.session.update({
    where: { id: input.sessionId },
    data: {
      notes: input.notes,
      paInPre: input.paInPre,
      paInPost: input.paInPost,
      rpe: input.rpe,
    },
  });
  revalidatePath(`/seguimiento/${input.sessionId}`);
  return { ok: true, data: undefined };
}

export async function completeSessionFromSeguimiento(sessionId: string): Promise<ActionResult> {
  const actor = await getActor();
  const s = await prisma.session.findFirst({
    where: { id: sessionId, program: { tenantId: actor.tenantId } },
    include: {
      program: { include: { patient: { select: { firstName: true, lastName: true } } } },
      exercises: true,
    },
  });
  if (!s) return { ok: false, error: "Sesión no encontrada." };

  await prisma.session.update({
    where: { id: sessionId },
    data: { completedAt: new Date() },
  });
  // Mark any remaining "PENDING" exercises as DONE for consistency unless the
  // practitioner explicitly skipped them.
  await prisma.sessionExercise.updateMany({
    where: { sessionId, status: "PENDING" },
    data: { status: "DONE" },
  });
  if (s.paInPost != null) {
    await prisma.evaScore.create({
      data: {
        patientId: s.program.patientId,
        value: s.paInPost,
        source: `session-${s.index}-post`,
      },
    });
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
    await prisma.treatmentProgram.update({
      where: { id: s.program.id },
      data: { status: "COMPLETED" },
    });
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
  const sess = await prisma.session.findFirst({
    where: { id: input.sessionId, program: { tenantId: actor.tenantId } },
    include: { exercises: { select: { id: true } } },
  });
  if (!sess) return { ok: false, error: "Sesión no encontrada." };
  const known = new Set(sess.exercises.map((e) => e.id));
  const valid = input.orderedIds.filter((id) => known.has(id));
  if (valid.length !== sess.exercises.length) {
    return { ok: false, error: "Lista incompleta." };
  }
  await prisma.$transaction([
    ...sess.exercises.map((e, i) =>
      prisma.sessionExercise.update({
        where: { id: e.id },
        data: { order: -(i + 1) },
      })
    ),
    ...valid.map((id, i) =>
      prisma.sessionExercise.update({ where: { id }, data: { order: i + 1 } })
    ),
  ]);
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
  const sess = await prisma.session.findFirst({
    where: { id: input.sessionId, program: { tenantId: actor.tenantId } },
    select: { id: true, program: { select: { patientId: true } } },
  });
  if (!sess) return { ok: false, error: "Sesión no encontrada." };

  // Gate by plan — a FREE tenant can't sneak a PRO-only exercise by
  // POSTing its id directly.
  const gate = await gatingForActor();
  const ex = await prisma.exercise.findFirst({
    where: { AND: [{ id: input.exerciseId }, gate.visibility] },
    select: { id: true, defaultSets: true, defaultReps: true },
  });
  if (!ex) return { ok: false, error: "Ejercicio no disponible en este plan." };

  const lastOrder = await prisma.sessionExercise.aggregate({
    where: { sessionId: input.sessionId },
    _max: { order: true },
  });
  const nextOrder = (lastOrder._max.order ?? 0) + 1;

  const row = await prisma.sessionExercise.create({
    data: {
      sessionId: input.sessionId,
      exerciseId: ex.id,
      order: nextOrder,
      sets: input.sets ?? ex.defaultSets,
      reps: input.reps ?? ex.defaultReps,
      notes: input.notes,
    },
  });
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
  const sx = await prisma.sessionExercise.findFirst({
    where: { id, session: { program: { tenantId: actor.tenantId } } },
    select: { id: true, sessionId: true, session: { select: { program: { select: { patientId: true } } } } },
  });
  if (!sx) return { ok: false, error: "Ejercicio no encontrado." };
  await prisma.sessionExercise.delete({ where: { id } });
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
  const program = await prisma.treatmentProgram.findFirst({
    where: { id: input.programId, tenantId: actor.tenantId },
    include: { sessions: { orderBy: { index: "desc" }, take: 1 } },
  });
  if (!program) return { ok: false, error: "Plan no encontrado." };

  const lastIndex = program.sessions[0]?.index ?? 0;
  const lastSched = program.sessions[0]?.scheduledFor ?? program.startDate;
  const cadenceDays = Math.max(1, Math.floor(7 / program.frequency));
  const fallback = new Date(lastSched);
  fallback.setDate(fallback.getDate() + cadenceDays);
  const scheduledFor = input.scheduledFor ? new Date(input.scheduledFor) : fallback;

  const sess = await prisma.session.create({
    data: {
      programId: program.id,
      practitionerId: actor.practitionerId,
      index: lastIndex + 1,
      scheduledFor,
      notes: input.title ?? null,
    },
  });
  await prisma.treatmentProgram.update({
    where: { id: program.id },
    data: { totalSessions: { increment: 1 } },
  });
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
  const sx = await prisma.sessionExercise.findFirst({
    where: {
      id: input.sessionExerciseId,
      session: { program: { tenantId: actor.tenantId } },
    },
    include: { session: { include: { program: true } } },
  });
  if (!sx) return { ok: false, error: "Ejercicio no encontrado." };

  const gate = await gatingForActor();
  const replacement = await prisma.exercise.findFirst({
    where: { AND: [{ id: input.newExerciseId }, gate.visibility] },
    select: { id: true, defaultSets: true, defaultReps: true },
  });
  if (!replacement) return { ok: false, error: "Ejercicio destino no disponible." };

  const order = sx.order;
  // Two-step: bump the old row to a negative order to bypass the unique
  // constraint, then create the new one in the same slot.
  await prisma.$transaction([
    prisma.sessionExercise.update({
      where: { id: sx.id },
      data: { order: -order },
    }),
    prisma.sessionExercise.create({
      data: {
        sessionId: sx.sessionId,
        exerciseId: replacement.id,
        order,
        sets: replacement.defaultSets,
        reps: replacement.defaultReps,
      },
    }),
    prisma.sessionExercise.delete({ where: { id: sx.id } }),
  ]);

  revalidatePath(`/seguimiento/${sx.sessionId}`);
  revalidatePath(`/pacientes/${sx.session.program.patientId}`);
  return { ok: true, data: { id: input.newExerciseId } };
}
