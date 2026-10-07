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
import type { z } from "zod";
import { runWithRls } from "@/lib/rls";
import { getActor } from "@/lib/session";
import { requireTenantAdmin } from "@/lib/authz";
import type { Actor } from "@/lib/session";
import { modulesFor, MODULE_DENIED_COPY } from "@/lib/tenant-modules";
import { suggestDisciplineFromSpecialties } from "@/lib/services-discipline";
import { findActivePractice } from "@/lib/catalog-validate";
import { enableServiceForPractitioners } from "@/lib/agenda-defaults";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { tags, ttl } from "@/lib/cache-tags";
import { ServiceInput, type ActionResult } from "@/lib/validation";
import type { ServiceRow } from "@/lib/services-types";

const ADMIN_MSG = "Solo OWNER/ADMIN pueden modificar el catálogo de servicios.";

/**
 * Enmienda EV0 de S13: "disciplina del servicio solo con `planes` (UI y
 * server)". La disciplina solo sirve a Planes (filtro del editor, chip y
 * "Fuera de plan" de la agenda); un consultorio General no la puede fijar ni
 * llamando a la action a mano (la UI esconde el campo, la barrera es esta).
 * Limpiarla (null) sí se deja: no habilita nada y permite sanear un servicio
 * que quedó con disciplina tras un cambio de vertical.
 */
function disciplineDenied(actor: Actor, discipline: string | null | undefined): string | null {
  if (discipline == null) return null;
  return modulesFor(actor.entitlements).has("planes") ? null : MODULE_DENIED_COPY.planes;
}

export async function listServicesWithCounts(): Promise<ServiceRow[]> {
  const actor = await getActor();
  const fetcher = unstable_cache(
    async (tenantId: string): Promise<ServiceRow[]> => {
      const rows = await runWithRls(tenantId, (tx) => tx.service.findMany({
        where: { tenantId },
        orderBy: { name: "asc" },
        include: {
          practitioner: { include: { user: { select: { fullName: true, email: true } } } },
          // S13: las especialidades de la práctica alimentan la disciplina
          // SUGERIDA (PQ-11); solo se lee el catálogo, nunca se guarda sola.
          practice: {
            select: { name: true, specialties: { select: { specialty: { select: { slug: true } } } } },
          },
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
        discipline: s.discipline,
        suggestedDiscipline: s.practice
          ? suggestDisciplineFromSpecialties(s.practice.specialties.map((ps) => ps.specialty.slug))
          : null,
      }));
    },
    // v2 (S13): la fila suma `discipline`/`suggestedDiscipline`. La data cache
    // de Vercel sobrevive al deploy: con la clave vieja se servirían filas sin
    // esos campos hasta el TTL.
    ["services:list-counts:v2", actor.tenantId],
    { tags: [tags.services(actor.tenantId)], revalidate: ttl.short }
  );
  return fetcher(actor.tenantId);
}

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
  const deniedCreate = disciplineDenied(actor, parsed.data.discipline);
  if (deniedCreate) return { ok: false, error: deniedCreate };
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
          discipline: parsed.data.discipline ?? null,
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
  const deniedUpdate = disciplineDenied(actor, parsed.data.discipline);
  if (deniedUpdate) return { ok: false, error: deniedUpdate };
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
        select: { name: true, priceCents: true, practiceId: true, discipline: true, practitionerId: true },
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
        select: { name: true, priceCents: true, practiceId: true, discipline: true, practitionerId: true },
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
    // Solo nombre, monto, práctica y disciplina (S13), y solo si cambiaron: el precio es plata (entra en
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

const DELETE_IN_USE_MSG =
  "No se puede borrar: hay turnos o planes de tratamiento que usan este servicio. Editá el nombre o el precio si querés actualizarlo.";

export async function deleteService(id: string): Promise<ActionResult> {
  const actor = await requireTenantAdmin(ADMIN_MSG);
  // ES2a → S13: M1 dejó `TreatmentProgram.serviceId` en RESTRICT (un plan no
  // puede quedar sin servicio en silencio) y `Booking.serviceId` ya lo era.
  // Antes se contaban solo los turnos: un servicio con planes y sin turnos
  // llegaba al DELETE y Postgres lo rechazaba (P2003 → 500 genérico). Se
  // cuentan todos los planes, archivados y cancelados incluidos: la FK no mira
  // el estado. `PlanTemplate.serviceId` es SET NULL: una plantilla no bloquea,
  // queda sin servicio y el editor lo pide al usarla.
  let outcome: "not-found" | "in-use" | "deleted";
  try {
    outcome = await runWithRls(actor.tenantId, async (tx) => {
      const owned = await tx.service.findFirst({
        where: { id, tenantId: actor.tenantId },
        select: { _count: { select: { bookings: true, programs: true } } },
      });
      if (!owned) return "not-found" as const;
      if (owned._count.bookings > 0 || owned._count.programs > 0) return "in-use" as const;
      await tx.service.delete({ where: { id } });
      return "deleted" as const;
    });
  } catch (e) {
    // Conteo y DELETE van en la misma tx pero sin lock: un turno o plan creado
    // entre los dos igual dispara la FK. Mismo mensaje en vez de un 500.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003") {
      outcome = "in-use";
    } else {
      throw e;
    }
  }
  if (outcome === "not-found") return { ok: false, error: "Servicio no encontrado." };
  if (outcome === "in-use") return { ok: false, error: DELETE_IN_USE_MSG };
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
