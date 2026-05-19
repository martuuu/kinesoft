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
import { notify } from "@/lib/notifications";
import type { ActionResult } from "@/lib/validation";
import { NotificationKind, type SessionExerciseStatus } from "@prisma/client";

export type OpenSessionRow = {
  id: string;
  index: number;
  scheduledFor: Date;
  completedAt: Date | null;
  patientId: string;
  patientName: string;
  programTitle: string;
  totalSessions: number;
  exerciseCount: number;
  doneCount: number;
};

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
          sessions: { orderBy: { index: "asc" }, select: { id: true, index: true, completedAt: true } },
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
