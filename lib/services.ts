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
import { runWithRls } from "@/lib/rls";
import { getActor } from "@/lib/session";
import { requireTenantAdmin } from "@/lib/authz";
import { findActivePractice } from "@/lib/catalog-validate";
import { enableServiceForPractitioners } from "@/lib/agenda-defaults";
import { CatalogId } from "@/lib/catalog-schemas";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { tags, ttl } from "@/lib/cache-tags";
import type { ActionResult } from "@/lib/validation";
import type { ServiceRow } from "@/lib/services-types";

const ADMIN_MSG = "Solo OWNER/ADMIN pueden modificar el catálogo de servicios.";

export async function listServicesWithCounts(): Promise<ServiceRow[]> {
  const actor = await getActor();
  const fetcher = unstable_cache(
    async (tenantId: string): Promise<ServiceRow[]> => {
      const rows = await runWithRls(tenantId, (tx) => tx.service.findMany({
        where: { tenantId },
        orderBy: { name: "asc" },
        include: {
          practitioner: { include: { user: { select: { fullName: true, email: true } } } },
          practice: { select: { name: true } },
          _count: { select: { bookings: true } },
        },
      }));
      return rows.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        color: s.color,
        durationMin: s.durationMin,
        priceCents: s.priceCents,
        practitionerId: s.practitionerId,
        practitionerName: s.practitioner
          ? (s.practitioner.user.fullName ?? s.practitioner.user.email)
          : null,
        maxConcurrent: s.maxConcurrent,
        bookingsCount: s._count.bookings,
        practiceId: s.practiceId,
        practiceName: s.practice?.name ?? null,
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
  color: z.string().max(9).optional().or(z.literal("")),
  durationMin: z.coerce.number().int().min(5).max(480).default(45),
  priceCents: z.coerce.number().int().min(0).max(100_000_000).default(0),
  practitionerId: z.string().optional().or(z.literal("")),
  // Cupos simultáneos por horario. Vacío → null = ilimitado (kinesiología).
  maxConcurrent: z
    .preprocess(
      (v) => (v === "" || v === undefined || v === null ? null : v),
      z.coerce.number().int().min(1, "Mínimo 1").max(50).nullable()
    )
    .optional(),
  // Práctica del catálogo global (opcional). "" = sin práctica. Se valida
  // contra la DB dentro de la tx de escritura (la FK saltea RLS).
  practiceId: z
    .union([CatalogId, z.literal(""), z.null()])
    .transform((v) => (v ? v : null))
    .optional(),
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
  const actor = await requireTenantAdmin(ADMIN_MSG);
  // Validate practitioner belongs to the tenant if supplied.
  if (parsed.data.practitionerId) {
    const owned = await runWithRls(actor.tenantId, (tx) => tx.practitioner.findFirst({
      where: { id: parsed.data.practitionerId, tenantId: actor.tenantId },
      select: { id: true },
    }));
    if (!owned) return { ok: false, error: "Profesional fuera del tenant." };
  }
  try {
    const row = await runWithRls(actor.tenantId, async (tx) => {
      // La FK practiceId saltea RLS: práctica existente y no archivada, acá.
      if (parsed.data.practiceId && !(await findActivePractice(tx, parsed.data.practiceId))) {
        return null;
      }
      const created = await tx.service.create({
        data: {
          tenantId: actor.tenantId,
          name: parsed.data.name,
          description: parsed.data.description || null,
          color: parsed.data.color || null,
          durationMin: parsed.data.durationMin,
          priceCents: parsed.data.priceCents,
          practitionerId: parsed.data.practitionerId || null,
          maxConcurrent: parsed.data.maxConcurrent ?? null,
          practiceId: parsed.data.practiceId ?? null,
        },
      });
      // B2.3 (decisión 7, = backfill (3)): con profesional → solo ese; sin
      // profesional (compartido) → todos los aceptados. Misma tx; el
      // practitionerId ya se validó contra el tenant arriba.
      await enableServiceForPractitioners(tx, {
        tenantId: actor.tenantId,
        serviceId: created.id,
        practitionerId: created.practitionerId,
      });
      return created;
    });
    if (!row) return { ok: false, error: "Práctica no encontrada en el catálogo." };
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
  const actor = await requireTenantAdmin(ADMIN_MSG);
  const owned = await runWithRls(actor.tenantId, (tx) => tx.service.findFirst({
    where: { id, tenantId: actor.tenantId },
    select: { id: true },
  }));
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
    const ownedPrac = await runWithRls(actor.tenantId, (tx) => tx.practitioner.findFirst({
      where: { id: parsed.data.practitionerId, tenantId: actor.tenantId },
      select: { id: true },
    }));
    if (!ownedPrac) return { ok: false, error: "Profesional fuera del tenant." };
  }
  let changes: AuditDiff;
  try {
    // Lectura del "antes" y update en la misma transacción: el audit
    // antes/después (A2b-S-cfg) tiene que describir exactamente lo que
    // pisó este update, no lo que otro guardado dejó un instante antes.
    changes = await runWithRls(actor.tenantId, async (tx) => {
      const { practitionerId: ownerBefore, ...before } = await tx.service.findFirstOrThrow({
        where: { id, tenantId: actor.tenantId },
        select: { name: true, priceCents: true, practiceId: true, practitionerId: true },
      });
      // La FK practiceId saltea RLS: práctica existente y no archivada, acá.
      // Solo si CAMBIA: si Plataforma archiva la práctica que el servicio ya
      // tenía, editar el precio no puede empezar a fallar por eso.
      if (
        parsed.data.practiceId &&
        parsed.data.practiceId !== before.practiceId &&
        !(await findActivePractice(tx, parsed.data.practiceId))
      ) {
        throw new PracticeNotFound("Práctica no encontrada en el catálogo.");
      }
      const { practitionerId: ownerAfter, ...after } = await tx.service.update({
        where: { id },
        data: {
          ...parsed.data,
          description: parsed.data.description === "" ? null : parsed.data.description,
          color: parsed.data.color === "" ? null : parsed.data.color,
          practitionerId:
            parsed.data.practitionerId === "" ? null : parsed.data.practitionerId,
        },
        select: { name: true, priceCents: true, practiceId: true, practitionerId: true },
      });
      // B2.3: si el pedido trae el profesional (asignarlo o pasarlo a
      // compartido), el nuevo dueño / todos los aceptados quedan habilitados.
      // Solo AGREGA filas: a quien lo atendía antes no se le quita (eso es el
      // editor por profesional, `enabled`), así un cambio de dueño no deja
      // turnos futuros de otro profesional fuera de lo que "atiende".
      if (parsed.data.practitionerId !== undefined) {
        await enableServiceForPractitioners(tx, {
          tenantId: actor.tenantId,
          serviceId: id,
          practitionerId: ownerAfter,
        });
        // Revisión de B-pre: pasar el servicio a un dueño (de compartido, o de
        // P1 a P2) = antes el turnero lo ofrecía solo con el dueño. Los demás
        // profesionales quedan PRIVATE: la agenda del staff les sigue
        // permitiendo dar el turno (no se toca `enabled`, ver arriba), pero el
        // turnero vuelve al comportamiento de antes. Volver a compartido NO
        // republica: la visibilidad de cada uno es del editor por profesional.
        if (ownerAfter && ownerAfter !== ownerBefore) {
          await tx.practitionerService.updateMany({
            where: {
              tenantId: actor.tenantId,
              serviceId: id,
              practitionerId: { not: ownerAfter },
              visibility: "PUBLIC",
            },
            data: { visibility: "PRIVATE" },
          });
        }
      }
      return auditDiff(before, after);
    });
  } catch (e) {
    if (e instanceof PracticeNotFound) return { ok: false, error: e.message };
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, error: "Ya existe un servicio con ese nombre." };
    }
    logger.error("service.update.failed", { err: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: "No pudimos guardar el servicio." };
  }
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    action: "service.update",
    entity: "Service",
    entityId: id,
    // Solo nombre, monto y práctica, y solo si cambiaron: el precio es plata (entra en
    // el fallback del copago) y hasta A2 el audit no decía de cuánto a cuánto.
    ...(changes ? { payload: changes } : {}),
  });
  revalidatePath("/configuracion");
  revalidatePath("/agenda");
  revalidateTag(tags.services(actor.tenantId));
  return { ok: true, data: undefined };
}

/** Corta (y revierte) la tx de update cuando el `practiceId` pedido no es utilizable. */
class PracticeNotFound extends Error {}

type AuditDiff = { before: Record<string, unknown>; after: Record<string, unknown> } | null;

/** `{ before, after }` con solo los campos que cambiaron; null si ninguno. */
function auditDiff<T extends Record<string, unknown>>(before: T, after: T): AuditDiff {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const k of Object.keys(before)) {
    if (before[k] !== after[k]) {
      b[k] = before[k];
      a[k] = after[k];
    }
  }
  return Object.keys(b).length ? { before: b, after: a } : null;
}

export async function deleteService(id: string): Promise<ActionResult> {
  const actor = await requireTenantAdmin(ADMIN_MSG);
  const owned = await runWithRls(actor.tenantId, (tx) => tx.service.findFirst({
    where: { id, tenantId: actor.tenantId },
    include: { _count: { select: { bookings: true } } },
  }));
  if (!owned) return { ok: false, error: "Servicio no encontrado." };
  if (owned._count.bookings > 0) {
    return {
      ok: false,
      error: "No se puede borrar: hay turnos asociados. Editá el nombre/precio si querés actualizarlo.",
    };
  }
  await runWithRls(actor.tenantId, (tx) => tx.service.delete({ where: { id } }));
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
