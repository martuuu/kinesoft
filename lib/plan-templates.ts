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
import { z } from "zod";
import { runWithRls } from "@/lib/rls";
import { getActor } from "@/lib/session";
import { modulesFor } from "@/lib/tenant-modules";
import { getMembershipRole } from "@/lib/authz";
import { capabilitiesFor, canWriteClinical, isTenantAdminRole } from "@/lib/capabilities";
import { audit, auditInTx } from "@/lib/audit";
import { localToARIso, toARDateKey } from "@/lib/datetime-ar";
import { assignableExerciseWhere, gatingForActor } from "@/lib/plan-gating";
import { hcAccessError } from "@/lib/patient-access-internal";
import { PLAN_MAX_SESSIONS } from "@/lib/plans-constants";
import type { ActionResult } from "@/lib/validation";

import type { PlanTemplateRow } from "@/lib/plan-templates-types";

export async function listPlanTemplates(): Promise<PlanTemplateRow[]> {
  const actor = await getActor();
  // P2-Z · B-L2: lectura sin el módulo `plantillas` → vacío (convención de
  // VERTICALES: escrituras rechazan, lecturas devuelven []). Antes listaba las
  // plantillas de un consultorio que bajó de plan o es General, y la UI
  // ofrecía aplicarlas aunque `applyPlanTemplate` después lo rechace.
  if (!modulesFor(actor.entitlements).has("plantillas")) return [];
  const rows = await runWithRls(actor.tenantId, (tx) => tx.planTemplate.findMany({
    where: { tenantId: actor.tenantId },
    orderBy: { updatedAt: "desc" },
  }));
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
  // Validate that every exercise is visible to this tenant. P0-S02t:
  // `assignable` (visible **y** no archivado), el mismo filtro que aplica
  // `applyPlanTemplate`; guardar un archivado solo dejaba un id muerto.
  const visible = await runWithRls(actor.tenantId, (tx) => tx.exercise.findMany({
    where: { AND: [{ id: { in: input.exerciseIds } }, assignableExerciseWhere(gate)] },
    select: { id: true },
  }));
  const visibleIds = new Set(visible.map((e) => e.id));
  const orderedValid = input.exerciseIds.filter((id) => visibleIds.has(id));
  if (orderedValid.length === 0) {
    return { ok: false, error: "Ningún ejercicio es accesible en este plan." };
  }

  const row = await runWithRls(actor.tenantId, (tx) => tx.planTemplate.create({
    data: {
      tenantId: actor.tenantId,
      authorId: actor.practitionerId,
      name,
      description: input.description?.trim() || null,
      // PD-04: un solo tope (60) para planes, plantillas, Diagnóstico y editor.
      totalSessions: Math.min(PLAN_MAX_SESSIONS, Math.max(1, input.totalSessions)),
      frequency: Math.min(7, Math.max(1, input.frequency)),
      exerciseIds: orderedValid,
    },
  }));
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

/**
 * P0-S02t: solo el autor o un OWNER/ADMIN. Antes bastaba con ser miembro del
 * tenant, así que cualquier profesional (o la Secretaria) borraba por id las
 * plantillas de un colega. El chequeo y el borrado van en la misma tx y el
 * `deleteMany` repite el filtro (tenant + autor si no es admin): aunque la
 * fila cambiara entre la lectura y el delete, nunca borra una ajena. En prod
 * la conexión tiene BYPASSRLS, así que el `tenantId` a mano es la barrera.
 */
export async function deletePlanTemplate(id: string): Promise<ActionResult> {
  const actor = await getActor();
  if (typeof id !== "string" || !id) return { ok: false, error: "Plantilla no encontrada." };
  const isAdmin = isTenantAdminRole(await getMembershipRole(actor));

  const result = await runWithRls(actor.tenantId, async (tx) => {
    const tpl = await tx.planTemplate.findFirst({
      where: { id, tenantId: actor.tenantId },
      select: { id: true, authorId: true },
    });
    if (!tpl) return "not_found" as const;
    if (!isAdmin && tpl.authorId !== actor.practitionerId) return "forbidden" as const;
    const del = await tx.planTemplate.deleteMany({
      where: {
        id,
        tenantId: actor.tenantId,
        ...(isAdmin ? {} : { authorId: actor.practitionerId }),
      },
    });
    if (del.count === 0) return "not_found" as const;
    await auditInTx(tx, {
      tenantId: actor.tenantId,
      actorId: actor.userId ?? undefined,
      action: "planTemplate.delete",
      entity: "PlanTemplate",
      entityId: id,
      payload: { authorId: tpl.authorId, byAdmin: tpl.authorId !== actor.practitionerId },
    });
    return "ok" as const;
  });

  if (result === "not_found") return { ok: false, error: "Plantilla no encontrada." };
  if (result === "forbidden") {
    return { ok: false, error: "Solo quien creó la plantilla o un administrador puede borrarla." };
  }
  revalidatePath("/biblioteca");
  return { ok: true, data: undefined };
}

// P0-S02t: input de `applyPlanTemplate`. No exportado (archivo "use server":
// solo funciones async). `startDate` se valida con formato Y como fecha real
// (abajo, round-trip por el día AR): "2026-13-40" era un 500.
const ApplyPlanTemplateInput = z.object({
  templateId: z.string().min(1).max(64),
  patientId: z.string().min(1).max(64),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida."),
  programTitle: z.string().trim().max(200).optional(),
});

/** Dosis por defecto cuando el ejercicio no trae series/reps (el picker de sesión hace lo mismo). */
const DEFAULT_SETS = 3;
const DEFAULT_REPS = 12;
const DAY_MS = 86_400_000;

/**
 * Apply a template to a patient — creates a `TreatmentProgram` with N
 * sessions, each scaffolded with the template's exercises in order.
 * Mirrors the diagnosis-assign distribution: every session gets every
 * exercise (no phase ramp — the practitioner can edit per session).
 *
 * P0-S02t (gates, PLANES.md §8):
 *  - acceso **full** al paciente (`hcAccessError`) y rol que lee clínica y
 *    crea planes (`plans.manage` + `canWriteClinical`, PD-09: la Secretaria
 *    no crea planes). Antes alcanzaba con que el paciente fuera del tenant:
 *    un profesional en básico le armaba un plan a un paciente ajeno. El gate
 *    corre DENTRO de la tx que escribe, no en una lectura previa;
 *  - `TEMPLATES_PLANS` (`canBuildTemplates`), leído en la misma tx;
 *  - ejercicios `assignable` (visibles en el plan SaaS y no archivados);
 *  - dosis `?? 3/12`: `SessionExercise.sets/reps` son NOT NULL y un
 *    ejercicio sin dosis por defecto hacía explotar el create;
 *  - tope `PLAN_MAX_SESSIONS` (60) y frecuencia 1..7 (una fila vieja con 0
 *    dividía por cero);
 *  - día AR: sesión 1 a las 00:00 AR del día elegido; las siguientes suman
 *    días en ms (AR no tiene DST), sin depender de la TZ del host.
 */
export async function applyPlanTemplate(input: {
  templateId: string;
  patientId: string;
  startDate: string; // YYYY-MM-DD
  programTitle?: string;
}): Promise<ActionResult<{ programId: string }>> {
  const actor = await getActor();
  const parsed = ApplyPlanTemplateInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Datos inválidos." };
  }
  const { templateId, patientId, programTitle } = parsed.data;

  // `startDate` "YYYY-MM-DD" anclado a 00:00 AR: un parse pelado lo lee como
  // medianoche UTC = 21:00 del día anterior en AR. El round-trip por el día
  // AR descarta fechas imposibles (JS normaliza "2026-02-30" al 2 de marzo).
  const startDate = new Date(localToARIso(`${parsed.data.startDate}T00:00:00`));
  if (Number.isNaN(startDate.getTime()) || toARDateKey(startDate) !== parsed.data.startDate) {
    return { ok: false, error: "Fecha inválida." };
  }

  // Rol fuera de la tx (query cacheada por request en `lib/authz.ts`).
  const caps = capabilitiesFor(await getMembershipRole(actor));

  const result = await runWithRls(actor.tenantId, async (tx) => {
    const gate = await gatingForActor(tx);
    if (!gate.canBuildTemplates) {
      return { ok: false as const, error: "Mejorá tu plan para aplicar plantillas." };
    }

    const tpl = await tx.planTemplate.findFirst({
      where: { id: templateId, tenantId: actor.tenantId },
    });
    if (!tpl) return { ok: false as const, error: "Plantilla no encontrada." };

    // Paciente de otro tenant → "none" → "Paciente no encontrado." (el
    // `tenantId` lo compara `patientAccessFor`; bajo BYPASSRLS es la barrera).
    const accessError = await hcAccessError(actor, patientId, tx);
    if (accessError) return { ok: false as const, error: accessError };
    if (!caps.has("plans.manage") || !canWriteClinical(caps, "full")) {
      return { ok: false as const, error: "Tu rol no puede crear planes de tratamiento." };
    }

    const ids = Array.isArray(tpl.exerciseIds)
      ? (tpl.exerciseIds as unknown[]).filter((v): v is string => typeof v === "string")
      : [];
    const exercises = ids.length
      ? await tx.exercise.findMany({
          where: { AND: [{ id: { in: ids } }, assignableExerciseWhere(gate)] },
          select: { id: true, defaultSets: true, defaultReps: true },
        })
      : [];
    const byId = new Map(exercises.map((e) => [e.id, e]));
    // Orden de la plantilla, sin los que ya no se pueden asignar, y con
    // `order` compacto (1..n): antes quedaban huecos donde había uno filtrado.
    const scaffold = ids
      .map((id) => byId.get(id))
      .filter((e): e is NonNullable<typeof e> => e !== undefined)
      .map((ex, i) => ({
        exerciseId: ex.id,
        order: i + 1,
        sets: ex.defaultSets ?? DEFAULT_SETS,
        reps: ex.defaultReps ?? DEFAULT_REPS,
      }));

    const totalSessions = Math.min(PLAN_MAX_SESSIONS, Math.max(1, tpl.totalSessions));
    const frequency = Math.min(7, Math.max(1, tpl.frequency));

    // Una sesión cada `7 / frequency` días desde startDate.
    const program = await tx.treatmentProgram.create({
      data: {
        tenantId: actor.tenantId,
        patientId,
        title: programTitle || tpl.name,
        totalSessions,
        frequency,
        startDate,
        status: ProgramStatus.ACTIVE,
        sessions: {
          create: Array.from({ length: totalSessions }, (_, i) => ({
            practitionerId: actor.practitionerId,
            index: i + 1,
            scheduledFor: new Date(startDate.getTime() + Math.floor((i * 7) / frequency) * DAY_MS),
            exercises: { create: scaffold },
          })),
        },
      },
      select: { id: true },
    });

    await auditInTx(tx, {
      tenantId: actor.tenantId,
      actorId: actor.userId ?? undefined,
      action: "planTemplate.apply",
      entity: "TreatmentProgram",
      entityId: program.id,
      payload: { templateId: tpl.id, patientId, totalSessions },
    });
    return { ok: true as const, data: { programId: program.id } };
  });

  if (!result.ok) return result;
  revalidatePath(`/pacientes/${patientId}`);
  revalidatePath("/dashboard");
  return result;
}
