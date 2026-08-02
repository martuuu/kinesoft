"use server";

/**
 * Custom condition catalog — tenant-scoped CRUD over `Condition` rows
 * with `tenantId != null` (Sprint 17).
 *
 * The schema shares the table with the global catalog; visibility is
 * decided per-row by `tenantId`. Custom conditions don't link into
 * anatomy / tag / matching-engine relations — they're a "manual
 * override" surfaced in the diagnostico AssignPlanModal.
 *
 * Auth model:
 *   - Any practitioner of the tenant can create / update / delete
 *     custom conditions (everything they create goes into the same
 *     consultorio pool — per the Sprint 17 brief "TODO lo que crea
 *     se va a una sola base de datos para el Consultorio").
 *   - Global rows (tenantId == null) are read-only from the app.
 */
import { revalidatePath, revalidateTag } from "next/cache";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { runWithRls } from "@/lib/rls";
import { getActor } from "@/lib/session";
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

export async function createCustomCondition(
  raw: z.input<typeof ConditionInput>
): Promise<ActionResult<{ id: string; slug: string }>> {
  const parsed = ConditionInput.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Datos inválidos",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const actor = await getActor();
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
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, error: "Ya existe un diagnóstico con un slug similar. Cambiale el nombre." };
    }
    return { ok: false, error: "No pudimos crear el diagnóstico." };
  }
}

export async function updateCustomCondition(
  id: string,
  raw: Partial<z.input<typeof ConditionInput>>
): Promise<ActionResult> {
  const actor = await getActor();
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

export async function deleteCustomCondition(id: string): Promise<ActionResult> {
  const actor = await getActor();
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
