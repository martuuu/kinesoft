"use server";

/**
 * Patient domain — server-only queries + Server Actions.
 *
 * Everything is scoped by the actor's tenantId. Reads use `prisma`
 * directly (with an explicit `where: { tenantId }`); writes also go
 * through `prisma` so we can attach computed fields. The Prisma client
 * extension in `lib/db.ts` is reserved for places where we don't want
 * to hand-write the scope (read queries from React Server Components).
 */
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getActor } from "@/lib/session";
import { audit } from "@/lib/audit";
import { notify, NotificationKind } from "@/lib/notifications";
import {
  PatientCreate,
  PatientUpdate,
  type ActionResult,
  type PatientCreateInput,
  type PatientUpdateInput,
} from "@/lib/validation";

export type PatientRow = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  documentId: string | null;
  dateOfBirth: Date | null;
  notes: string | null;
  createdAt: Date;
  activeProgramTitle: string | null;
  sessionsTotal: number;
  sessionsDone: number;
  lastVisit: Date | null;
  upcomingAt: Date | null;
};

export async function listPatients(opts: {
  q?: string;
  filter?: "all" | "active" | "no-program";
} = {}): Promise<PatientRow[]> {
  const actor = await getActor();
  const q = opts.q?.trim();
  const where: Prisma.PatientWhereInput = {
    tenantId: actor.tenantId,
    ...(q
      ? {
          OR: [
            { firstName: { contains: q, mode: "insensitive" } },
            { lastName: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
            { documentId: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
    ...(opts.filter === "active"
      ? { programs: { some: { status: "ACTIVE" } } }
      : opts.filter === "no-program"
        ? { programs: { none: {} } }
        : {}),
  };
  const rows = await prisma.patient.findMany({
    where,
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    include: {
      programs: {
        where: { status: "ACTIVE" },
        take: 1,
        include: {
          sessions: { orderBy: { index: "asc" } },
        },
      },
      bookings: {
        where: { scheduledFor: { gte: new Date() }, status: { not: "CANCELLED" } },
        orderBy: { scheduledFor: "asc" },
        take: 1,
      },
    },
  });
  return rows.map((p): PatientRow => {
    const prog = p.programs[0];
    const sessions = prog?.sessions ?? [];
    const done = sessions.filter((s) => s.completedAt).length;
    const lastDone = sessions
      .filter((s) => s.completedAt)
      .sort((a, b) => +b.completedAt! - +a.completedAt!)[0];
    return {
      id: p.id,
      firstName: p.firstName,
      lastName: p.lastName,
      email: p.email,
      phone: p.phone,
      documentId: p.documentId,
      dateOfBirth: p.dateOfBirth,
      notes: p.notes,
      createdAt: p.createdAt,
      activeProgramTitle: prog?.title ?? null,
      sessionsTotal: prog?.totalSessions ?? 0,
      sessionsDone: done,
      lastVisit: lastDone?.completedAt ?? null,
      upcomingAt: p.bookings[0]?.scheduledFor ?? null,
    };
  });
}

export async function getPatient(id: string) {
  const actor = await getActor();
  const patient = await prisma.patient.findFirst({
    where: { id, tenantId: actor.tenantId },
    include: {
      coverages: true,
      emergency: true,
      programs: {
        include: {
          sessions: {
            orderBy: { index: "asc" },
            include: {
              exercises: { include: { exercise: true }, orderBy: { order: "asc" } },
            },
          },
          case: { include: { diagnoses: { include: { condition: true } } } },
        },
        orderBy: { createdAt: "desc" },
      },
      bookings: { orderBy: { scheduledFor: "desc" }, take: 20 },
      evaScores: { orderBy: { takenAt: "asc" } },
    },
  });
  if (patient) {
    await audit({
      tenantId: actor.tenantId,
      actorId: actor.userId ?? undefined,
      action: "patient.read",
      entity: "Patient",
      entityId: patient.id,
    });
  }
  return patient;
}

export async function createPatient(
  raw: PatientCreateInput
): Promise<ActionResult<{ id: string }>> {
  const actor = await getActor();
  const parsed = PatientCreate.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Datos inválidos",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  try {
    const p = await prisma.patient.create({
      data: { ...parsed.data, tenantId: actor.tenantId },
    });
    await audit({
      tenantId: actor.tenantId,
      actorId: actor.userId ?? undefined,
      action: "patient.create",
      entity: "Patient",
      entityId: p.id,
    });
    if (actor.userId) {
      await notify({
        tenantId: actor.tenantId,
        userId: actor.userId,
        kind: NotificationKind.PATIENT_NEW,
        title: `Nuevo paciente · ${p.firstName} ${p.lastName}`,
        body: p.email ?? p.documentId ?? undefined,
        link: `/pacientes/${p.id}`,
      });
    }
    revalidatePath("/pacientes");
    return { ok: true, data: { id: p.id } };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, error: "Ya existe un paciente con ese DNI en este consultorio." };
    }
    return { ok: false, error: "No pudimos crear el paciente." };
  }
}

export async function updatePatient(
  raw: PatientUpdateInput
): Promise<ActionResult<{ id: string }>> {
  const actor = await getActor();
  const parsed = PatientUpdate.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Datos inválidos",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const { id, ...data } = parsed.data;
  const owned = await prisma.patient.findFirst({
    where: { id, tenantId: actor.tenantId },
    select: { id: true },
  });
  if (!owned) return { ok: false, error: "Paciente no encontrado." };
  await prisma.patient.update({ where: { id }, data });
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "patient.update",
    entity: "Patient",
    entityId: id,
  });
  revalidatePath("/pacientes");
  revalidatePath(`/pacientes/${id}`);
  return { ok: true, data: { id } };
}

export async function deletePatient(id: string): Promise<ActionResult> {
  const actor = await getActor();
  const owned = await prisma.patient.findFirst({
    where: { id, tenantId: actor.tenantId },
    select: { id: true },
  });
  if (!owned) return { ok: false, error: "Paciente no encontrado." };
  await prisma.patient.delete({ where: { id } });
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "patient.delete",
    entity: "Patient",
    entityId: id,
  });
  revalidatePath("/pacientes");
  return { ok: true, data: undefined };
}

export async function createProgram(input: {
  patientId: string;
  title: string;
  totalSessions: number;
  frequency: number;
  startDate: Date;
}): Promise<ActionResult<{ id: string }>> {
  const actor = await getActor();
  const owned = await prisma.patient.findFirst({
    where: { id: input.patientId, tenantId: actor.tenantId },
    select: { id: true },
  });
  if (!owned) return { ok: false, error: "Paciente no encontrado." };
  const program = await prisma.treatmentProgram.create({
    data: {
      tenantId: actor.tenantId,
      patientId: input.patientId,
      title: input.title,
      totalSessions: input.totalSessions,
      frequency: input.frequency,
      startDate: input.startDate,
      sessions: {
        create: Array.from({ length: input.totalSessions }).map((_, i) => ({
          practitionerId: actor.practitionerId,
          index: i + 1,
          scheduledFor: new Date(
            input.startDate.getTime() + Math.floor(i * (7 / input.frequency)) * 86_400_000
          ),
        })),
      },
    },
  });
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "program.create",
    entity: "TreatmentProgram",
    entityId: program.id,
  });
  revalidatePath(`/pacientes/${input.patientId}`);
  return { ok: true, data: { id: program.id } };
}

export async function recordEvaScore(input: {
  patientId: string;
  value: number;
  source?: string;
}): Promise<ActionResult<{ id: string }>> {
  const actor = await getActor();
  const owned = await prisma.patient.findFirst({
    where: { id: input.patientId, tenantId: actor.tenantId },
    select: { id: true },
  });
  if (!owned) return { ok: false, error: "Paciente no encontrado." };
  const row = await prisma.evaScore.create({
    data: { patientId: input.patientId, value: input.value, source: input.source },
  });
  revalidatePath(`/pacientes/${input.patientId}`);
  return { ok: true, data: { id: row.id } };
}

export async function completeSession(input: {
  sessionId: string;
  notes?: string;
  paInPre?: number;
  paInPost?: number;
  rpe?: number;
}): Promise<ActionResult> {
  const actor = await getActor();
  const sess = await prisma.session.findFirst({
    where: {
      id: input.sessionId,
      program: { tenantId: actor.tenantId },
    },
    include: { program: true },
  });
  if (!sess) return { ok: false, error: "Sesión no encontrada." };
  await prisma.session.update({
    where: { id: input.sessionId },
    data: {
      completedAt: new Date(),
      notes: input.notes,
      paInPre: input.paInPre,
      paInPost: input.paInPost,
      rpe: input.rpe,
    },
  });
  if (input.paInPost != null) {
    await prisma.evaScore.create({
      data: {
        patientId: sess.program.patientId,
        value: input.paInPost,
        source: `session-${sess.index}-post`,
      },
    });
  }
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "session.complete",
    entity: "Session",
    entityId: input.sessionId,
  });
  revalidatePath(`/pacientes/${sess.program.patientId}`);
  return { ok: true, data: undefined };
}
