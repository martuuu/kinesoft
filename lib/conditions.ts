"use server";

/**
 * Custom condition catalog — tenant-scoped CRUD over `Condition` rows
 * with `tenantId != null` (Sprint 17).
 *
 * The schema shares the table with the global catalog; visibility is
 * decided per-row by `tenantId`. Custom conditions don't link into
 * anatomy / tag / matching-engine relations — they're a "manual
 * override" surfaced as a pickable diagnosis in the Diagnóstico door
 * (editor de planes, S23).
 *
 * Auth model:
 *   - Any practitioner of the tenant can create / update / delete
 *     custom conditions (everything they create goes into the same
 *     consultorio pool — per the Sprint 17 brief "TODO lo que crea
 *     se va a una sola base de datos para el Consultorio").
 *   - Global rows (tenantId == null) are read-only from the app.
 *   - EV0 (C-EV4): todo esto es del módulo `diagnostico` (un consultorio
 *     General no lo tiene). Las escrituras tiran `ForbiddenError` vía
 *     `requireModule`; la lista compartida (`listCustomConditions`, la usa la
 *     pestaña de Configuración) devuelve `[]` sin el módulo.
 */
import { revalidatePath, revalidateTag } from "next/cache";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { runWithRls } from "@/lib/rls";
import { readOnlyFailure, withReadOnlyResult } from "@/lib/read-only-result";
import { getActor } from "@/lib/session";
import { requireModule } from "@/lib/authz";
import { modulesFor } from "@/lib/tenant-modules";
import { audit } from "@/lib/audit";
import { tags as cacheTags } from "@/lib/cache-tags";
import type { ActionResult } from "@/lib/validation";

export type CustomConditionRow = {
  id: string;
  slug: string;
  name: string;
  cie10: string | null;
  summary: string | null;
  severity: "MILD" | "MODERATE" | "SEVERE" | null;
  redFlags: string | null;
  mechanism: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

const ConditionInput = z.object({
  name: z.string().trim().min(2, "Nombre requerido").max(120),
  cie10: z.string().trim().max(20).optional().or(z.literal("")),
  summary: z.string().trim().max(2000).optional().or(z.literal("")),
  severity: z.enum(["MILD", "MODERATE", "SEVERE"]).optional(),
  redFlags: z.string().trim().max(2000).optional().or(z.literal("")),
  mechanism: z.string().trim().max(200).optional().or(z.literal("")),
});

/**
 * List tenant-scoped custom conditions. Excludes global catalog rows —
 * those are shown alongside in the diagnostico screen via `loadCatalog`.
 */
export async function listCustomConditions(): Promise<CustomConditionRow[]> {
  const actor = await getActor();
  // Lectura compartida: sin el módulo, vacío (no rompe la pantalla).
  if (!modulesFor(actor.entitlements).has("diagnostico")) return [];
  const rows = await runWithRls(actor.tenantId, (tx) => tx.condition.findMany({
    where: { tenantId: actor.tenantId },
    orderBy: { name: "asc" },
    select: {
      id: true,
      slug: true,
      name: true,
      cie10: true,
      summary: true,
      severity: true,
      redFlags: true,
      mechanism: true,
      createdById: true,
      createdAt: true,
      updatedAt: true,
    },
  }));
  return rows;
}

// EV1-E1 (readonly-residual-actions): el cuerpo va en `createCustomConditionImpl`; el wrapper convierte el ReadOnlyModeError
// (modo lectura / soporte) en `{ ok:false, error }` para que en prod Next no redacte el mensaje
// (lib/read-only-result.ts, mismo patrón que BO3-F).
export async function createCustomCondition(...args: Parameters<typeof createCustomConditionImpl>): ReturnType<typeof createCustomConditionImpl> {
  return withReadOnlyResult(() => createCustomConditionImpl(...args));
}

async function createCustomConditionImpl(
  raw: z.input<typeof ConditionInput>
): Promise<ActionResult<{ id: string; slug: string }>> {
  // Módulo antes que la validación: un consultorio sin `diagnostico` recibe
  // Forbidden con cualquier input.
  const actor = await requireModule("diagnostico");
  const parsed = ConditionInput.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Datos inválidos",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const data = parsed.data;
  // Slug uniqueness: append a short suffix derived from createdAt-ish
  // if there's a collision within the tenant. Slug stays globally
  // unique (Prisma constraint) by prefixing with the tenant id.
  const base = slugify(data.name) || "diagnostico";
  const slug = `t-${actor.tenantId.slice(-6)}-${base}-${Date.now().toString(36).slice(-4)}`;
  try {
    const row = await runWithRls(actor.tenantId, (tx) => tx.condition.create({
      data: {
        slug,
        name: data.name,
        cie10: data.cie10 || null,
        summary: data.summary || null,
        severity: data.severity ?? null,
        redFlags: data.redFlags || null,
        mechanism: data.mechanism || null,
        tenantId: actor.tenantId,
        createdById: actor.userId,
      },
      select: { id: true, slug: true },
    }));
    await audit({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: "condition.create",
      entity: "Condition",
      entityId: row.id,
      payload: { name: data.name },
    });
    revalidatePath("/configuracion");
    revalidatePath("/diagnostico");
    revalidateTag(cacheTags.catalog());
    return { ok: true, data: row };
  } catch (e) {
    // EV1-E1: este catch tapaba el ReadOnlyModeError con el copy genérico; el del modo lectura/soporte va primero.
    const ro = readOnlyFailure(e);
    if (ro) return ro;
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, error: "Ya existe un diagnóstico con un slug similar. Cambiale el nombre." };
    }
    return { ok: false, error: "No pudimos crear el diagnóstico." };
  }
}

// EV1-E1 (readonly-residual-actions): el cuerpo va en `updateCustomConditionImpl`; el wrapper convierte el ReadOnlyModeError
// (modo lectura / soporte) en `{ ok:false, error }` para que en prod Next no redacte el mensaje
// (lib/read-only-result.ts, mismo patrón que BO3-F).
export async function updateCustomCondition(...args: Parameters<typeof updateCustomConditionImpl>): ReturnType<typeof updateCustomConditionImpl> {
  return withReadOnlyResult(() => updateCustomConditionImpl(...args));
}

async function updateCustomConditionImpl(
  id: string,
  raw: Partial<z.input<typeof ConditionInput>>
): Promise<ActionResult> {
  const actor = await requireModule("diagnostico");
  const owned = await runWithRls(actor.tenantId, (tx) => tx.condition.findFirst({
    where: { id, tenantId: actor.tenantId },
    select: { id: true },
  }));
  if (!owned) {
    return {
      ok: false,
      error: "Diagnóstico no encontrado o pertenece al catálogo global (no editable).",
    };
  }
  const parsed = ConditionInput.partial().safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Datos inválidos",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const data = parsed.data;
  await runWithRls(actor.tenantId, (tx) => tx.condition.update({
    where: { id },
    data: {
      ...data,
      cie10: data.cie10 === "" ? null : data.cie10,
      summary: data.summary === "" ? null : data.summary,
      redFlags: data.redFlags === "" ? null : data.redFlags,
      mechanism: data.mechanism === "" ? null : data.mechanism,
    },
  }));
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    action: "condition.update",
    entity: "Condition",
    entityId: id,
  });
  revalidatePath("/configuracion");
  revalidatePath("/diagnostico");
  revalidateTag(cacheTags.catalog());
  return { ok: true, data: undefined };
}

// EV1-E1 (readonly-residual-actions): el cuerpo va en `deleteCustomConditionImpl`; el wrapper convierte el ReadOnlyModeError
// (modo lectura / soporte) en `{ ok:false, error }` para que en prod Next no redacte el mensaje
// (lib/read-only-result.ts, mismo patrón que BO3-F).
export async function deleteCustomCondition(...args: Parameters<typeof deleteCustomConditionImpl>): ReturnType<typeof deleteCustomConditionImpl> {
  return withReadOnlyResult(() => deleteCustomConditionImpl(...args));
}

async function deleteCustomConditionImpl(id: string): Promise<ActionResult> {
  const actor = await requireModule("diagnostico");
  const owned = await runWithRls(actor.tenantId, (tx) => tx.condition.findFirst({
    where: { id, tenantId: actor.tenantId },
    select: { id: true, _count: { select: { diagnoses: true } } },
  }));
  if (!owned) {
    return {
      ok: false,
      error: "Diagnóstico no encontrado o pertenece al catálogo global.",
    };
  }
  if (owned._count.diagnoses > 0) {
    return {
      ok: false,
      error: `No se puede borrar: hay ${owned._count.diagnoses} clínica${owned._count.diagnoses === 1 ? "" : "s"} usándolo. Editá el nombre si querés actualizarlo.`,
    };
  }
  await runWithRls(actor.tenantId, (tx) => tx.condition.delete({ where: { id } }));
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    action: "condition.delete",
    entity: "Condition",
    entityId: id,
  });
  revalidatePath("/configuracion");
  revalidatePath("/diagnostico");
  revalidateTag(cacheTags.catalog());
  return { ok: true, data: undefined };
}
