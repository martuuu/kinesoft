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
import { notify } from "@/lib/notifications-internal";
import { visibilityForActor } from "@/lib/visibility";
import { NotificationKind } from "@prisma/client";
import {
  PatientCreate,
  PatientUpdate,
  type ActionResult,
  type PatientCreateInput,
  type PatientUpdateInput,
} from "@/lib/validation";

import type { PatientRow, PatientSort } from "@/lib/patients-types";

export async function listPatients(opts: {
  q?: string;
  filter?: "all" | "active" | "no-program" | "archived";
  sort?: PatientSort;
  insurer?: string;
} = {}): Promise<PatientRow[]> {
  const actor = await getActor();
  const v = await visibilityForActor(actor);
  const q = opts.q?.trim();
  const sort = opts.sort ?? "lastName.asc";
  const where: Prisma.PatientWhereInput = {
    tenantId: actor.tenantId,
    ...v.patientWhere,
    ...(opts.filter === "archived"
      ? { archivedAt: { not: null } }
      : { archivedAt: null }),
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
    ...(opts.insurer
      ? { coverages: { some: { insurer: { contains: opts.insurer, mode: "insensitive" } } } }
      : {}),
  };

  // Map sort directly when supported by Prisma; for upcoming/lastVisit we
  // sort in-memory after the read since they depend on related rows.
  const orderBy: Prisma.PatientOrderByWithRelationInput[] =
    sort === "lastName.asc"
      ? [{ lastName: "asc" }, { firstName: "asc" }]
      : sort === "lastName.desc"
        ? [{ lastName: "desc" }, { firstName: "desc" }]
        : sort === "createdAt.desc"
          ? [{ createdAt: "desc" }]
          : sort === "createdAt.asc"
            ? [{ createdAt: "asc" }]
            : [{ lastName: "asc" }];

  const rows = await prisma.patient.findMany({
    where,
    orderBy,
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
  })
    .sort((a, b) => {
      // Secondary in-memory sort for fields that depend on joined data.
      if (sort === "upcoming.asc") {
        const va = a.upcomingAt ? +a.upcomingAt : Number.POSITIVE_INFINITY;
        const vb = b.upcomingAt ? +b.upcomingAt : Number.POSITIVE_INFINITY;
        return va - vb;
      }
      if (sort === "lastVisit.desc") {
        const va = a.lastVisit ? +a.lastVisit : 0;
        const vb = b.lastVisit ? +b.lastVisit : 0;
        return vb - va;
      }
      return 0;
    });
}

export async function setPatientArchived(input: {
  id: string;
  archived: boolean;
}): Promise<ActionResult> {
  const actor = await getActor();
  const owned = await prisma.patient.findFirst({
    where: { id: input.id, tenantId: actor.tenantId },
    select: { id: true },
  });
  if (!owned) return { ok: false, error: "Paciente no encontrado." };
  await prisma.patient.update({
    where: { id: input.id },
    data: { archivedAt: input.archived ? new Date() : null },
  });
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: input.archived ? "patient.archive" : "patient.unarchive",
    entity: "Patient",
    entityId: input.id,
  });
  revalidatePath("/pacientes");
  revalidatePath(`/pacientes/${input.id}`);
  return { ok: true, data: undefined };
}

/**
 * Build CSV rows for export. Server-only — never sends PII over the
 * wire as a string until the route handler streams it.
 */
export async function exportPatientsCsv(): Promise<string> {
  const rows = await listPatients({ filter: "all" });
  const header = [
    "ID",
    "Apellido",
    "Nombre",
    "DNI",
    "Email",
    "Telefono",
    "Plan activo",
    "Sesiones",
    "Proximo turno",
    "Alta",
  ].join(",");
  const body = rows
    .map((p) =>
      [
        p.id,
        csv(p.lastName),
        csv(p.firstName),
        csv(p.documentId ?? ""),
        csv(p.email ?? ""),
        csv(p.phone ?? ""),
        csv(p.activeProgramTitle ?? ""),
        p.sessionsTotal ? `${p.sessionsDone}/${p.sessionsTotal}` : "",
        p.upcomingAt ? p.upcomingAt.toISOString() : "",
        p.createdAt.toISOString(),
      ].join(",")
    )
    .join("\n");
  return header + "\n" + body + "\n";
}

function csv(s: string) {
  if (s == null) return "";
  const needsQuote = /[",\n]/.test(s);
  const esc = s.replace(/"/g, '""');
  return needsQuote ? `"${esc}"` : esc;
}

export async function getPatient(id: string) {
  const actor = await getActor();
  const v = await visibilityForActor(actor);
  const patient = await prisma.patient.findFirst({
    where: { id, tenantId: actor.tenantId, ...v.patientWhere },
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
      data: {
        ...parsed.data,
        tenantId: actor.tenantId,
        // Auto-assign the new patient to the kine creating them, so the
        // per-kine visibility mode works out of the box. OWNER/ADMIN can
        // later re-assign or set null for "consultorio común".
        assignedPractitionerId: actor.practitionerId,
      },
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

// ──────────────────────────────────────────────────────────────────────
// Coverage (Obra Social) management
// ──────────────────────────────────────────────────────────────────────

/**
 * Set (replace) the patient's primary coverage. Either `insurerId`
 * resolves to a tenant Insurer row, OR `insurerName` writes a free-form
 * name (when the practitioner hasn't created the Insurer yet).
 *
 * Strategy: delete the patient's existing coverages and create one new
 * row. Coverage history is currently denormalised — when we need it we
 * can introduce an "active" flag instead.
 */
export async function setPatientCoverage(input: {
  patientId: string;
  insurerId?: string;
  insurerName?: string;
  planName?: string;
  memberId?: string;
}): Promise<ActionResult> {
  const actor = await getActor();
  const owned = await prisma.patient.findFirst({
    where: { id: input.patientId, tenantId: actor.tenantId },
    select: { id: true },
  });
  if (!owned) return { ok: false, error: "Paciente no encontrado." };

  let resolvedName = input.insurerName?.trim() || "";
  let resolvedInsurerId: string | null = null;
  if (input.insurerId) {
    const ins = await prisma.insurer.findFirst({
      where: { id: input.insurerId, tenantId: actor.tenantId },
      select: { id: true, name: true },
    });
    if (!ins) return { ok: false, error: "Obra social no encontrada." };
    resolvedInsurerId = ins.id;
    resolvedName = ins.name;
  }
  if (!resolvedName) {
    // Clearing coverage — delete all rows.
    await prisma.coverage.deleteMany({ where: { patientId: input.patientId } });
    revalidatePath(`/pacientes/${input.patientId}`);
    return { ok: true, data: undefined };
  }

  await prisma.$transaction([
    prisma.coverage.deleteMany({ where: { patientId: input.patientId } }),
    prisma.coverage.create({
      data: {
        patientId: input.patientId,
        insurer: resolvedName,
        insurerId: resolvedInsurerId,
        planName: input.planName?.trim() || null,
        memberId: input.memberId?.trim() || null,
      },
    }),
  ]);
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "patient.coverage.update",
    entity: "Patient",
    entityId: input.patientId,
    payload: { insurer: resolvedName, insurerId: resolvedInsurerId },
  });
  revalidatePath(`/pacientes/${input.patientId}`);
  return { ok: true, data: undefined };
}

/**
 * Re-assign a patient to another practitioner of the same tenant — or
 * unassign (set to `null` = "consultorio común").
 *
 * Auth: OWNER + ADMIN only (PRACTITIONER could only see their own
 * patients in per-kine mode and shouldn't be able to give them away).
 * The visibility filter already enforces who sees what, so we just
 * enforce the role on write.
 */
export async function assignPatientToPractitioner(input: {
  patientId: string;
  practitionerId: string | null;
}): Promise<ActionResult> {
  const actor = await getActor();
  const membership = await prisma.membership.findUnique({
    where: { userId_tenantId: { userId: actor.userId, tenantId: actor.tenantId } },
    select: { role: true },
  });
  if (!membership || (membership.role !== "OWNER" && membership.role !== "ADMIN")) {
    return { ok: false, error: "Solo OWNER/ADMIN pueden re-asignar pacientes." };
  }

  const owned = await prisma.patient.findFirst({
    where: { id: input.patientId, tenantId: actor.tenantId },
    select: { id: true, assignedPractitionerId: true },
  });
  if (!owned) return { ok: false, error: "Paciente no encontrado." };

  if (input.practitionerId) {
    const prac = await prisma.practitioner.findFirst({
      where: { id: input.practitionerId, tenantId: actor.tenantId },
      select: { id: true },
    });
    if (!prac) return { ok: false, error: "Profesional fuera del tenant." };
  }

  await prisma.patient.update({
    where: { id: input.patientId },
    data: { assignedPractitionerId: input.practitionerId },
  });
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "patient.reassign",
    entity: "Patient",
    entityId: input.patientId,
    payload: {
      from: owned.assignedPractitionerId,
      to: input.practitionerId,
    },
  });
  revalidatePath(`/pacientes/${input.patientId}`);
  revalidatePath("/pacientes");
  return { ok: true, data: undefined };
}
