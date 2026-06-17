"use server";

/**
 * Service catalogue — tenant-scoped CRUD.
 *
 * Pre-Sprint 13, `Service` rows could only be created via the seed. The
 * `/configuracion` Servicios tab now exposes full CRUD. `listServices`
 * (the read) keeps living in `lib/bookings.ts` so existing call sites
 * don't break; mutations live here.
 *
 * Auth: every action requires OWNER/ADMIN. PRACTITIONER can read.
 */
import { revalidatePath, revalidateTag, unstable_cache } from "next/cache";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getActor } from "@/lib/session";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { tags, ttl } from "@/lib/cache-tags";
import type { ActionResult } from "@/lib/validation";
import type { ServiceRow } from "@/lib/services-types";

async function requireAdminActor() {
  const actor = await getActor();
  const m = await prisma.membership.findUnique({
    where: { userId_tenantId: { userId: actor.userId, tenantId: actor.tenantId } },
    select: { role: true },
  });
  if (!m || (m.role !== "OWNER" && m.role !== "ADMIN")) {
    throw new Error("Solo OWNER/ADMIN pueden modificar el catálogo de servicios.");
  }
  return actor;
}

export async function listServicesWithCounts(): Promise<ServiceRow[]> {
  const actor = await getActor();
  const fetcher = unstable_cache(
    async (tenantId: string): Promise<ServiceRow[]> => {
      const rows = await prisma.service.findMany({
        where: { tenantId },
        orderBy: { name: "asc" },
        include: {
          practitioner: { include: { user: { select: { fullName: true, email: true } } } },
          _count: { select: { bookings: true } },
        },
      });
      return rows.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        durationMin: s.durationMin,
        priceCents: s.priceCents,
        practitionerId: s.practitionerId,
        practitionerName: s.practitioner
          ? (s.practitioner.user.fullName ?? s.practitioner.user.email)
          : null,
        bookingsCount: s._count.bookings,
      }));
    },
    ["services:list-counts", actor.tenantId],
    { tags: [tags.services(actor.tenantId)], revalidate: ttl.short }
  );
  return fetcher(actor.tenantId);
}

const ServiceInput = z.object({
  name: z.string().trim().min(1, "Nombre requerido").max(80),
  description: z.string().trim().max(500).optional().or(z.literal("")),
  durationMin: z.coerce.number().int().min(5).max(480).default(45),
  priceCents: z.coerce.number().int().min(0).max(100_000_000).default(0),
  practitionerId: z.string().optional().or(z.literal("")),
});

export async function createService(
  raw: z.input<typeof ServiceInput>
): Promise<ActionResult<{ id: string }>> {
  const parsed = ServiceInput.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Datos inválidos",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const actor = await requireAdminActor();
  // Validate practitioner belongs to the tenant if supplied.
  if (parsed.data.practitionerId) {
    const owned = await prisma.practitioner.findFirst({
      where: { id: parsed.data.practitionerId, tenantId: actor.tenantId },
      select: { id: true },
    });
    if (!owned) return { ok: false, error: "Profesional fuera del tenant." };
  }
  try {
    const row = await prisma.service.create({
      data: {
        tenantId: actor.tenantId,
        name: parsed.data.name,
        description: parsed.data.description || null,
        durationMin: parsed.data.durationMin,
        priceCents: parsed.data.priceCents,
        practitionerId: parsed.data.practitionerId || null,
      },
    });
    await audit({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: "service.create",
      entity: "Service",
      entityId: row.id,
      payload: { name: row.name },
    });
    revalidatePath("/configuracion");
    revalidatePath("/agenda");
    revalidateTag(tags.services(actor.tenantId));
    return { ok: true, data: { id: row.id } };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, error: "Ya existe un servicio con ese nombre." };
    }
    logger.error("service.create.failed", { err: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: "No pudimos crear el servicio." };
  }
}

export async function updateService(
  id: string,
  raw: Partial<z.input<typeof ServiceInput>>
): Promise<ActionResult> {
  const actor = await requireAdminActor();
  const owned = await prisma.service.findFirst({
    where: { id, tenantId: actor.tenantId },
    select: { id: true },
  });
  if (!owned) return { ok: false, error: "Servicio no encontrado." };

  const parsed = ServiceInput.partial().safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Datos inválidos",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  if (parsed.data.practitionerId) {
    const ownedPrac = await prisma.practitioner.findFirst({
      where: { id: parsed.data.practitionerId, tenantId: actor.tenantId },
      select: { id: true },
    });
    if (!ownedPrac) return { ok: false, error: "Profesional fuera del tenant." };
  }
  await prisma.service.update({
    where: { id },
    data: {
      ...parsed.data,
      description: parsed.data.description === "" ? null : parsed.data.description,
      practitionerId:
        parsed.data.practitionerId === "" ? null : parsed.data.practitionerId,
    },
  });
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    action: "service.update",
    entity: "Service",
    entityId: id,
  });
  revalidatePath("/configuracion");
  revalidatePath("/agenda");
  revalidateTag(tags.services(actor.tenantId));
  return { ok: true, data: undefined };
}

export async function deleteService(id: string): Promise<ActionResult> {
  const actor = await requireAdminActor();
  const owned = await prisma.service.findFirst({
    where: { id, tenantId: actor.tenantId },
    include: { _count: { select: { bookings: true } } },
  });
  if (!owned) return { ok: false, error: "Servicio no encontrado." };
  if (owned._count.bookings > 0) {
    return {
      ok: false,
      error: "No se puede borrar: hay turnos asociados. Editá el nombre/precio si querés actualizarlo.",
    };
  }
  await prisma.service.delete({ where: { id } });
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    action: "service.delete",
    entity: "Service",
    entityId: id,
  });
  revalidatePath("/configuracion");
  revalidatePath("/agenda");
  revalidateTag(tags.services(actor.tenantId));
  return { ok: true, data: undefined };
}
