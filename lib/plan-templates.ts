"use server";

/**
 * Plan templates ("mis planes") — reusable scaffolds a practitioner can
 * apply to any patient to spin up a `TreatmentProgram` quickly.
 *
 * Storage: tenant-scoped, author-stamped. The ordered exercise list is
 * persisted as JSON on the template row so applying is one read +
 * `createProgram`-style write.
 *
 * Gated by plan: FREE tenants can't build templates (STARTER+ unlocks).
 */
import { revalidatePath } from "next/cache";
import { ProgramStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getActor } from "@/lib/session";
import { audit } from "@/lib/audit";
import { localToARIso } from "@/lib/datetime-ar";
import { gatingForActor } from "@/lib/plan-gating";
import type { ActionResult } from "@/lib/validation";

import type { PlanTemplateRow } from "@/lib/plan-templates-types";

export async function listPlanTemplates(): Promise<PlanTemplateRow[]> {
  const actor = await getActor();
  const rows = await prisma.planTemplate.findMany({
    where: { tenantId: actor.tenantId },
    orderBy: { updatedAt: "desc" },
  });
  return rows.map((r) => {
    const ids = Array.isArray(r.exerciseIds) ? (r.exerciseIds as string[]) : [];
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      totalSessions: r.totalSessions,
      frequency: r.frequency,
      exerciseCount: ids.length,
      createdAt: r.createdAt,
    };
  });
}

export async function createPlanTemplate(input: {
  name: string;
  description?: string;
  totalSessions: number;
  frequency: number;
  exerciseIds: string[];
}): Promise<ActionResult<{ id: string }>> {
  const actor = await getActor();
  const gate = await gatingForActor();
  if (!gate.canBuildTemplates) {
    return { ok: false, error: "Mejorá tu plan para crear plantillas." };
  }
  const name = input.name.trim();
  if (!name) return { ok: false, error: "Nombre requerido." };
  if (input.exerciseIds.length === 0) {
    return { ok: false, error: "Agregá al menos un ejercicio." };
  }
  // Validate that every exercise is visible to this tenant.
  const visible = await prisma.exercise.findMany({
    where: { AND: [{ id: { in: input.exerciseIds } }, gate.visibility] },
    select: { id: true },
  });
  const visibleIds = new Set(visible.map((e) => e.id));
  const orderedValid = input.exerciseIds.filter((id) => visibleIds.has(id));
  if (orderedValid.length === 0) {
    return { ok: false, error: "Ningún ejercicio es accesible en este plan." };
  }

  const row = await prisma.planTemplate.create({
    data: {
      tenantId: actor.tenantId,
      authorId: actor.practitionerId,
      name,
      description: input.description?.trim() || null,
      totalSessions: Math.min(48, Math.max(1, input.totalSessions)),
      frequency: Math.min(7, Math.max(1, input.frequency)),
      exerciseIds: orderedValid,
    },
  });
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "planTemplate.create",
    entity: "PlanTemplate",
    entityId: row.id,
  });
  revalidatePath("/biblioteca");
  return { ok: true, data: { id: row.id } };
}

export async function deletePlanTemplate(id: string): Promise<ActionResult> {
  const actor = await getActor();
  const owned = await prisma.planTemplate.findFirst({
    where: { id, tenantId: actor.tenantId },
    select: { id: true },
  });
  if (!owned) return { ok: false, error: "Plantilla no encontrada." };
  await prisma.planTemplate.delete({ where: { id } });
  revalidatePath("/biblioteca");
  return { ok: true, data: undefined };
}

/**
 * Apply a template to a patient — creates a `TreatmentProgram` with N
 * sessions, each scaffolded with the template's exercises in order.
 * Mirrors the diagnosis-assign distribution: every session gets every
 * exercise (no phase ramp — the practitioner can edit per session).
 */
export async function applyPlanTemplate(input: {
  templateId: string;
  patientId: string;
  startDate: string; // YYYY-MM-DD
  programTitle?: string;
}): Promise<ActionResult<{ programId: string }>> {
  const actor = await getActor();
  const gate = await gatingForActor();
  if (!gate.canBuildTemplates) {
    return { ok: false, error: "Mejorá tu plan para aplicar plantillas." };
  }

  const tpl = await prisma.planTemplate.findFirst({
    where: { id: input.templateId, tenantId: actor.tenantId },
  });
  if (!tpl) return { ok: false, error: "Plantilla no encontrada." };

  const owned = await prisma.patient.findFirst({
    where: { id: input.patientId, tenantId: actor.tenantId },
    select: { id: true },
  });
  if (!owned) return { ok: false, error: "Paciente fuera del tenant." };

  // `input.startDate` is "YYYY-MM-DD"; anchor to AR local midnight so
  // session 1 doesn't roll back a day (a bare parse reads it as UTC
  // midnight = 21:00 the previous day in AR). The `setDate` arithmetic
  // below stays correct — Argentina has no DST.
  const startDate = new Date(localToARIso(`${input.startDate}T00:00:00`));
  if (Number.isNaN(startDate.getTime())) return { ok: false, error: "Fecha inválida." };

  const ids = Array.isArray(tpl.exerciseIds) ? (tpl.exerciseIds as string[]) : [];
  const exercises = await prisma.exercise.findMany({
    where: { AND: [{ id: { in: ids } }, gate.visibility] },
    select: { id: true, defaultSets: true, defaultReps: true },
  });
  const byId = new Map(exercises.map((e) => [e.id, e]));

  // Build session schedule: every `7 / frequency` days from startDate.
  const program = await prisma.treatmentProgram.create({
    data: {
      tenantId: actor.tenantId,
      patientId: input.patientId,
      title: input.programTitle ?? tpl.name,
      totalSessions: tpl.totalSessions,
      frequency: tpl.frequency,
      startDate,
      status: ProgramStatus.ACTIVE,
      sessions: {
        create: Array.from({ length: tpl.totalSessions }).map((_, i) => {
          const sched = new Date(startDate);
          sched.setDate(sched.getDate() + Math.floor((i * 7) / tpl.frequency));
          return {
            practitionerId: actor.practitionerId,
            index: i + 1,
            scheduledFor: sched,
            exercises: {
              create: ids
                .map((id, order) => {
                  const ex = byId.get(id);
                  if (!ex) return null;
                  return {
                    exerciseId: ex.id,
                    order: order + 1,
                    sets: ex.defaultSets,
                    reps: ex.defaultReps,
                  };
                })
                .filter(
                  (v): v is { exerciseId: string; order: number; sets: number; reps: number } =>
                    v !== null
                ),
            },
          };
        }),
      },
    },
  });

  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "planTemplate.apply",
    entity: "TreatmentProgram",
    entityId: program.id,
    payload: { templateId: tpl.id, patientId: input.patientId },
  });
  revalidatePath(`/pacientes/${input.patientId}`);
  revalidatePath("/dashboard");
  return { ok: true, data: { programId: program.id } };
}

