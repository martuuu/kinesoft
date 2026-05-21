"use server";

/**
 * Insurer (Obras Sociales / Prepagas) — tenant-scoped CRUD.
 *
 * Each row stores the copago (what the patient pays per session) and the
 * fixed fee (what the insurer reimburses the practitioner). Lives under
 * `/configuracion` → Obras Sociales tab, surfaced in the patient/booking
 * coverage dropdown.
 *
 * Auth: every action requires OWNER/ADMIN. PRACTITIONER role can read
 * but not mutate — keeping the catalogue stable across the consultorio.
 */
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getActor } from "@/lib/session";
import { audit } from "@/lib/audit";
import type { ActionResult } from "@/lib/validation";
import type { InsurerRow } from "@/lib/insurers-types";

async function requireAdminActor() {
  const actor = await getActor();
  const m = await prisma.membership.findUnique({
    where: { userId_tenantId: { userId: actor.userId, tenantId: actor.tenantId } },
    select: { role: true },
  });
  if (!m || (m.role !== "OWNER" && m.role !== "ADMIN")) {
    throw new Error("Solo OWNER/ADMIN pueden modificar el catálogo de obras sociales.");
  }
  return actor;
}

export async function listInsurers(opts: { onlyActive?: boolean } = {}): Promise<InsurerRow[]> {
  const actor = await getActor();
  const rows = await prisma.insurer.findMany({
    where: {
      tenantId: actor.tenantId,
      ...(opts.onlyActive ? { active: true } : {}),
    },
    orderBy: [{ active: "desc" }, { name: "asc" }],
    include: { _count: { select: { coverages: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    copagoCents: r.copagoCents,
    fixedFeeCents: r.fixedFeeCents,
    active: r.active,
    notes: r.notes,
    patientsCount: r._count.coverages,
    createdAt: r.createdAt,
  }));
}

const InsurerInput = z.object({
  name: z.string().trim().min(1, "Nombre requerido").max(80),
  copagoCents: z.coerce.number().int().min(0).max(10_000_000),
  fixedFeeCents: z.coerce.number().int().min(0).max(10_000_000),
  active: z.boolean().optional().default(true),
  notes: z.string().trim().max(500).optional().or(z.literal("")),
});

export async function createInsurer(
  raw: z.input<typeof InsurerInput>
): Promise<ActionResult<{ id: string }>> {
  const parsed = InsurerInput.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Datos inválidos",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const actor = await requireAdminActor();
  try {
    const row = await prisma.insurer.create({
      data: {
        tenantId: actor.tenantId,
        name: parsed.data.name,
        copagoCents: parsed.data.copagoCents,
        fixedFeeCents: parsed.data.fixedFeeCents,
        active: parsed.data.active ?? true,
        notes: parsed.data.notes || null,
      },
    });
    await audit({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: "insurer.create",
      entity: "Insurer",
      entityId: row.id,
      payload: { name: row.name },
    });
    revalidatePath("/configuracion");
    return { ok: true, data: { id: row.id } };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, error: "Ya existe una obra social con ese nombre." };
    }
    return { ok: false, error: "No pudimos crear la obra social." };
  }
}

export async function updateInsurer(
  id: string,
  raw: Partial<z.input<typeof InsurerInput>>
): Promise<ActionResult> {
  const actor = await requireAdminActor();
  const owned = await prisma.insurer.findFirst({
    where: { id, tenantId: actor.tenantId },
    select: { id: true },
  });
  if (!owned) return { ok: false, error: "Obra social no encontrada." };

  const parsed = InsurerInput.partial().safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Datos inválidos",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  await prisma.insurer.update({
    where: { id },
    data: {
      ...parsed.data,
      notes: parsed.data.notes ? parsed.data.notes : parsed.data.notes === "" ? null : undefined,
    },
  });
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    action: "insurer.update",
    entity: "Insurer",
    entityId: id,
  });
  revalidatePath("/configuracion");
  return { ok: true, data: undefined };
}

export async function deleteInsurer(id: string): Promise<ActionResult> {
  const actor = await requireAdminActor();
  const owned = await prisma.insurer.findFirst({
    where: { id, tenantId: actor.tenantId },
    include: { _count: { select: { coverages: true } } },
  });
  if (!owned) return { ok: false, error: "Obra social no encontrada." };
  // Soft-delete when in use: deactivate but keep the row so historical
  // Coverages still resolve. Hard-delete only when zero references.
  if (owned._count.coverages > 0) {
    await prisma.insurer.update({ where: { id }, data: { active: false } });
    await audit({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: "insurer.deactivate",
      entity: "Insurer",
      entityId: id,
    });
    revalidatePath("/configuracion");
    return { ok: true, data: undefined };
  }
  await prisma.insurer.delete({ where: { id } });
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    action: "insurer.delete",
    entity: "Insurer",
    entityId: id,
  });
  revalidatePath("/configuracion");
  return { ok: true, data: undefined };
}
