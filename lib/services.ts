"use server";

/**
 * Service catalogue — tenant-scoped CRUD.
 *
 * Pre-Sprint 13, `Service` rows could only be created via the seed. The
 * `/configuracion` Servicios tab now exposes full CRUD. `listServices`
 * (the read) keeps living in `lib/bookings.ts` so existing call sites
 * don't break; mutations live here.
 *
 * Auth: `tenant.admin` («Configuración») para todo el catálogo. CF3 (§30, D-CF3-6; decisión de Martin del 04-nov
 * «Todo + crear servicios»): además, un miembro clínico con `Practitioner` y SIN «Configuración» crea, edita y borra
 * servicios PROPIOS (`Service.practitionerId = él`, decidido por el Actor y nunca por el input) desde «Mi agenda». Los
 * del consultorio (practitionerId null) y los de otro profesional siguen pidiendo `tenant.admin`, con el mismo
 * `ForbiddenError` de siempre. Un servicio propio habilita SOLO a su dueño (`enableServiceForPractitioners` con
 * profesional, y el implícito de `lib/availability/next-free.ts:162-185` solo cubre al dueño): a los demás no se les
 * aparece en la agenda ni en el turnero. Tope de `OWN_SERVICES_MAX` por la vía propia. El audit lleva `via: "self"`
 * solo por esa vía (el de «Configuración» queda igual que antes, como en `lib/practitioner-self-scope.ts`).
 *
 * CF3b · sesión SV (decisión de Martin del 05-nov, reemplaza D-CF3-6 en el ALTA): el Titular y los profesionales
 * eligen al crear si el servicio es «Para todo el consultorio» (`forClinic`, regla en `lib/services-schemas.ts`):
 *   • por la vía propia, marcado → del consultorio (practitionerId null). Para no meterle un servicio en el turnero a
 *     un colega sin que lo decida, el creador queda habilitado y PUBLIC y el resto habilitados pero PRIVATE (se da
 *     en la agenda; en el turnero de cada uno aparece si lo publica). Después de creado, ese servicio es del
 *     catálogo del consultorio: lo edita y borra SOLO quien tiene «Configuración» (update/delete no cambian: por la
 *     vía propia, practitionerId null = ajeno). El tope de `OWN_SERVICES_MAX` cuenta solo los propios;
 *   • con «Configuración», marcado → del consultorio (todos PUBLIC, decisión 7 como siempre); desmarcado → del propio
 *     usuario si atiende, o del profesional del selector; sin agenda propia, siempre del consultorio;
 *   • el audit del alta lleva `scope: "clinic" | "own"` (además de `via: "self"` por la vía propia).
 */
import { withSupportWritable } from "@/lib/support-writable";
import { readOnlyFailure, withReadOnlyResult } from "@/lib/read-only-result";
import { revalidatePath, revalidateTag, unstable_cache } from "next/cache";
import { Prisma } from "@prisma/client";
import type { z } from "zod";
import { runWithRls, type DbClient } from "@/lib/rls";
import { getActor } from "@/lib/session";
import type { Actor } from "@/lib/session";
import { ForbiddenError } from "@/lib/session";
import { assertSelfOrCapability, writablePractitionerWhere, type SelfScopeVia } from "@/lib/practitioner-self-scope";
import { modulesFor, MODULE_DENIED_COPY } from "@/lib/tenant-modules";
import { listServicesWithCountsInTx } from "@/lib/services-read";
import { findActivePractice } from "@/lib/catalog-validate";
import { enableServiceForPractitioners } from "@/lib/agenda-defaults";
import { auditInTx } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { tags, ttl } from "@/lib/cache-tags";
import { ServiceInput, type ActionResult } from "@/lib/validation";
import { OWN_SERVICES_MAX, SERVICES_COPY, type ServiceRow } from "@/lib/services-types";
import { ServiceCreateInput, serviceOwnerFor, serviceScopeOf } from "@/lib/services-schemas";
import { PRACTITIONER_NOT_BOOKABLE, bookablePractitionerWhere, isActorPractitioner } from "@/lib/practitioner-scope";

// CF3 ZF1: sin roles en inglés («Solo OWNER/ADMIN…»): el gate es `tenant.admin`, que hoy es el Titular o quien
// tenga el permiso «Configuración» (CONFIG_DELEGATED). El profesional sigue editando SUS servicios (D-CF3-6).
const ADMIN_MSG = "Solo el titular o quien tenga el permiso «Configuración» puede modificar los servicios del consultorio.";

/**
 * CF3 (D-CF3-6): `tenant.admin` → `"config"` (todo el catálogo, como siempre); si no, el profesional del actor →
 * `"self"` (solo lo suyo); si no (Secretaria, Facturación, soporte sin el permiso) → `ForbiddenError(ADMIN_MSG)`, el
 * contrato de siempre. Se le pasa el `practitionerId` del propio Actor: «propio» nunca sale del input.
 */
async function serviceWriteScope(): Promise<{ actor: Actor; via: SelfScopeVia }> {
  const actor = await getActor();
  const { via } = await assertSelfOrCapability(actor, actor.practitionerId, "tenant.admin", ADMIN_MSG);
  return { actor, via };
}

/** Revalidaciones post-commit de toda escritura del catálogo (la sede `/<slug>` y el directorio muestran servicios). */
function revalidateServices(tenantId: string): void {
  revalidatePath("/configuracion");
  revalidatePath("/agenda");
  revalidateTag(tags.services(tenantId));
  revalidateTag(tags.sites());
  revalidateTag(tags.directory());
}

/** Corta la tx de un alta propia cuando el profesional ya tiene `OWN_SERVICES_MAX` servicios. */
class OwnServiceLimit extends Error {}
/** Corta la tx de una escritura propia cuando el `Practitioner` del Actor ya no es reservable / no es del usuario. */
class OwnPractitionerGone extends Error {}

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
      // PF2-d: la consulta y el mapeo viven en lib/services-read.ts (el loader de `/configuracion` la corre dentro de
      // su tx única); acá sigue su propia tx y el cache por tag de siempre.
      return runWithRls(tenantId, (tx) => listServicesWithCountsInTx(tx, tenantId));
    },
    // v2 (S13): la fila suma `discipline`/`suggestedDiscipline`. La data cache
    // de Vercel sobrevive al deploy: con la clave vieja se servirían filas sin
    // esos campos hasta el TTL.
    ["services:list-counts:v2", actor.tenantId],
    { tags: [tags.services(actor.tenantId)], revalidate: ttl.short }
  );
  return fetcher(actor.tenantId);
}

export async function createService(...args: Parameters<typeof createServiceImpl>): ReturnType<typeof createServiceImpl> {
  return withReadOnlyResult(() => withSupportWritable("lib/services.ts#createService", () => createServiceImpl(...args)));
}

async function createServiceImpl(
  raw: z.input<typeof ServiceCreateInput>
): Promise<ActionResult<{ id: string }>> {
  const parsed = ServiceCreateInput.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Datos inválidos",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const { actor, via } = await serviceWriteScope();
  // Vía propia: pedir a nombre de otro profesional (o de uno de otro consultorio) es pedir lo del consultorio → mismo
  // corte que sin permiso, sin escribir. Vale también con «Para todo el consultorio» marcado: la UI nunca manda las
  // dos cosas, así que esa mezcla es un input armado y no se «arregla» en silencio.
  if (via === "self" && parsed.data.practitionerId && !isActorPractitioner(actor, parsed.data.practitionerId)) {
    throw new ForbiddenError(SERVICES_COPY.ownOnly);
  }
  // Por la vía propia el gate garantizó el profesional del actor (IAM-4a: nunca null como dueño ni como «yo»).
  const selfPid = via === "self" ? actor.practitionerId : null;
  if (via === "self" && !selfPid) throw new ForbiddenError(ADMIN_MSG);
  // CF3b (SV): el dueño sale del checkbox «Para todo el consultorio» y de la vía (regla pura en services-schemas).
  const ownerId = serviceOwnerFor(actor, {
    via,
    forClinic: parsed.data.forClinic,
    practitionerId: parsed.data.practitionerId || null,
  });
  const deniedCreate = disciplineDenied(actor, parsed.data.discipline);
  if (deniedCreate) return { ok: false, error: deniedCreate };
  // T3c-1s (AS-1s, §23.2): el dueño tiene que ser RESERVABLE, no solo del tenant. Antes se le podía asignar un
  // servicio a un profesional suspendido, deshabilitado en Plataforma o a la Secretaria (fila `Practitioner` vieja):
  // el servicio quedaba colgado de alguien que no atiende y sin nadie a quien reservarle. CF3b: se valida el dueño
  // RESUELTO (el elegido o, desmarcado, el del propio usuario), no solo el del input.
  if (via === "config" && ownerId) {
    const owned = await runWithRls(actor.tenantId, (tx) => tx.practitioner.findFirst({
      where: { id: ownerId, ...bookablePractitionerWhere(actor.tenantId, { includeDisabledFilter: true }) },
      select: { id: true },
    }));
    if (!owned) return { ok: false, error: PRACTITIONER_NOT_BOOKABLE };
  }
  const scope = serviceScopeOf(ownerId);
  try {
    const row = await runWithRls(actor.tenantId, async (tx) => {
      // La FK practiceId saltea RLS: práctica existente y no archivada, acá.
      if (parsed.data.practiceId && !(await findActivePractice(tx, parsed.data.practiceId))) {
        return null;
      }
      if (selfPid) {
        // Propio: profesional válido + tope (cuenta SOLO los propios). Para todo el consultorio: sin tope (no es suyo
        // y no suma a su cuenta), pero el profesional tiene que seguir siendo del usuario y reservable, porque queda
        // habilitado y público en su turnero.
        if (ownerId) await assertOwnCreateAllowed(tx, actor, ownerId);
        else await assertOwnPractitioner(tx, actor, selfPid);
      }
      const created = await tx.service.create({
        data: {
          tenantId: actor.tenantId,
          name: parsed.data.name,
          description: parsed.data.description || null,
          color: parsed.data.color || null,
          durationMin: parsed.data.durationMin,
          priceCents: parsed.data.priceCents,
          practitionerId: ownerId,
          maxConcurrent: parsed.data.maxConcurrent ?? null,
          practiceId: parsed.data.practiceId ?? null,
          discipline: parsed.data.discipline ?? null,
        },
      });
      // B2.3 (decisión 7, = backfill (3)): con profesional → solo ese; sin
      // profesional (compartido) → todos los aceptados. Misma tx; el
      // practitionerId ya se validó contra el tenant arriba.
      // CF3b (SV): compartido por la vía propia → los demás quedan PRIVATE (en el mismo INSERT, ver agenda-defaults).
      await enableServiceForPractitioners(tx, {
        tenantId: actor.tenantId,
        serviceId: created.id,
        practitionerId: created.practitionerId,
        ...(selfPid && !created.practitionerId ? { publicOnlyFor: selfPid } : {}),
      });
      // PL-A2 (§20.5.9): el precio es plata (fallback del copago) → audit en la misma tx. CF3b: con el alcance.
      await auditInTx(tx, {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "service.create",
        entity: "Service",
        entityId: created.id,
        payload: { name: created.name, priceCents: created.priceCents, scope, ...(via === "self" ? { via } : {}) },
      });
      return created;
    });
    if (!row) return { ok: false, error: "Práctica no encontrada en el catálogo." };
    revalidateServices(actor.tenantId);
    return { ok: true, data: { id: row.id } };
  } catch (e) {
    // EV1-E2 (readonly-residual-actions): modo lectura / soporte → su copy, no el genérico de abajo.
    const ro = readOnlyFailure(e);
    if (ro) return ro;
    if (e instanceof OwnServiceLimit) return { ok: false, error: SERVICES_COPY.ownLimit };
    if (e instanceof OwnPractitionerGone) return { ok: false, error: SERVICES_COPY.notBookable };
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, error: "Ya existe un servicio con ese nombre." };
    }
    logger.error("service.create.failed", { err: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: "No pudimos crear el servicio." };
  }
}

export async function updateService(...args: Parameters<typeof updateServiceImpl>): ReturnType<typeof updateServiceImpl> {
  return withReadOnlyResult(() => withSupportWritable("lib/services.ts#updateService", () => updateServiceImpl(...args)));
}

async function updateServiceImpl(
  id: string,
  raw: Partial<z.input<typeof ServiceInput>>
): Promise<ActionResult> {
  const { actor, via } = await serviceWriteScope();
  const owned = await runWithRls(actor.tenantId, (tx) => tx.service.findFirst({
    where: { id, tenantId: actor.tenantId },
    select: { id: true, practitionerId: true },
  }));
  if (!owned) return { ok: false, error: "Servicio no encontrado." };
  // Vía propia: solo un servicio cuyo dueño es el profesional del actor. Uno del consultorio o de otro = lo de siempre.
  if (via === "self" && !isActorPractitioner(actor, owned.practitionerId)) throw new ForbiddenError(ADMIN_MSG);

  const parsed = ServiceInput.partial().safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Datos inválidos",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  // …y no lo regala: pasarlo a compartido ("") o a otro profesional es tocar el catálogo del consultorio.
  if (via === "self" && parsed.data.practitionerId !== undefined && !isActorPractitioner(actor, parsed.data.practitionerId)) {
    throw new ForbiddenError(SERVICES_COPY.ownOnly);
  }
  const deniedUpdate = disciplineDenied(actor, parsed.data.discipline);
  if (deniedUpdate) return { ok: false, error: deniedUpdate };
  // T3c-1s (AS-1s): pasar el servicio a OTRO profesional exige que sea reservable (como en `createService`). Si el
  // pedido trae el MISMO dueño que ya tiene, no se re-valida: el formulario manda todos los campos, y un servicio
  // de un profesional que después se suspendió no podría ni corregir su precio hasta reasignarlo. Ese dueño ya es
  // del tenant (salió de la fila de arriba, filtrada por `tenantId`).
  if (parsed.data.practitionerId && parsed.data.practitionerId !== owned.practitionerId) {
    const ownedPrac = await runWithRls(actor.tenantId, (tx) => tx.practitioner.findFirst({
      where: { id: parsed.data.practitionerId, ...bookablePractitionerWhere(actor.tenantId, { includeDisabledFilter: true }) },
      select: { id: true },
    }));
    if (!ownedPrac) return { ok: false, error: PRACTITIONER_NOT_BOOKABLE };
  }
  try {
    // Lectura del "antes", update y audit en la misma transacción: el audit
    // antes/después (A2b-S-cfg) tiene que describir exactamente lo que
    // pisó este update, no lo que otro guardado dejó un instante antes, y
    // (PL-A2, §20.5.9) un rollback no deja audit de un cambio de precio que no pasó.
    const ownPid = via === "self" ? actor.practitionerId : null;
    await runWithRls(actor.tenantId, async (tx) => {
      // Vía propia: la pertenencia se vuelve a exigir DENTRO de la tx (si el Titular lo reasignó entre la lectura de
      // arriba y acá, no se pisa) y el profesional tiene que seguir siendo reservable y del usuario.
      if (via === "self" && actor.practitionerId) await assertOwnPractitioner(tx, actor, actor.practitionerId);
      const beforeRow = await tx.service.findFirst({
        // IAM-4a: por la vía propia el gate garantizó `actor.practitionerId`; `ownPid` nunca es null acá (sin `null === null`).
        where: { id, tenantId: actor.tenantId, ...(via === "self" && ownPid ? { practitionerId: ownPid } : {}) },
        select: { name: true, priceCents: true, practiceId: true, discipline: true, practitionerId: true },
      });
      if (!beforeRow) throw new ServiceGone();
      const { practitionerId: ownerBefore, ...before } = beforeRow;
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
      // CF3 ZF1 (B4): la pertenencia va TAMBIÉN en el WHERE del UPDATE (no solo en la lectura de arriba, que no
      // lockea): si el Titular reasignó el servicio y commiteó entre las dos sentencias, Postgres re-evalúa el WHERE
      // sobre la versión nueva de la fila (READ COMMITTED), no matchea y Prisma tira P2025 → «Servicio no
      // encontrado.». Sin esto, el propio pisaba el precio de un servicio que ya era de otro. `tenantId` a mano
      // (BYPASSRLS en prod). Misma sentencia: +0.
      const { practitionerId: ownerAfter, ...after } = await tx.service.update({
        where: { id, tenantId: actor.tenantId, ...(via === "self" && ownPid ? { practitionerId: ownPid } : {}) },
        data: {
          ...parsed.data,
          description: parsed.data.description === "" ? null : parsed.data.description,
          color: parsed.data.color === "" ? null : parsed.data.color,
          practitionerId:
            parsed.data.practitionerId === "" ? null : parsed.data.practitionerId,
        },
        select: { name: true, priceCents: true, practiceId: true, discipline: true, practitionerId: true },
      });
      // CF3 ZF3 (M): en un servicio PROPIO el precio se edita solo en «Editar» (el Drawer); un `priceCents` viejo en
      // la fila del dueño (PractitionerService) ganaría en la escalera y el cambio del Drawer no tendría efecto. Si el
      // dueño cambia el precio del servicio, se limpia su override para que cobre el precio nuevo. `tenantId` a mano.
      if (via === "self" && ownPid && after.priceCents !== before.priceCents) {
        await tx.practitionerService.updateMany({
          where: { tenantId: actor.tenantId, serviceId: id, practitionerId: ownPid, priceCents: { not: null } },
          data: { priceCents: null },
        });
      }
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
      const changes = auditDiff(before, after);
      await auditInTx(tx, {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "service.update",
        entity: "Service",
        entityId: id,
        // Solo nombre, monto, práctica y disciplina (S13), y solo si cambiaron: el precio es plata (entra en
        // el fallback del copago) y hasta A2 el audit no decía de cuánto a cuánto.
        ...(changes ? { payload: via === "self" ? { ...changes, via } : changes } : via === "self" ? { payload: { via } } : {}),
      });
    });
  } catch (e) {
    // EV1-E2 (readonly-residual-actions): modo lectura / soporte → su copy, no el genérico de abajo.
    const ro = readOnlyFailure(e);
    if (ro) return ro;
    if (e instanceof PracticeNotFound) return { ok: false, error: e.message };
    if (e instanceof ServiceGone) return { ok: false, error: "Servicio no encontrado." };
    // B4: el UPDATE con la pertenencia en el WHERE no encontró la fila (reasignada o borrada en el medio).
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") return { ok: false, error: "Servicio no encontrado." };
    if (e instanceof OwnPractitionerGone) return { ok: false, error: SERVICES_COPY.notBookable };
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, error: "Ya existe un servicio con ese nombre." };
    }
    logger.error("service.update.failed", { err: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: "No pudimos guardar el servicio." };
  }
  revalidateServices(actor.tenantId);
  return { ok: true, data: undefined };
}

/** Corta (y revierte) la tx de update cuando el `practiceId` pedido no es utilizable. */
class PracticeNotFound extends Error {}
/** Corta la tx de update cuando el servicio ya no existe (o, por la vía propia, dejó de ser del actor). */
class ServiceGone extends Error {}

/**
 * Vía propia: el `Practitioner` del Actor sigue siendo del USUARIO, del tenant y reservable (`writablePractitionerWhere`;
 * defensa en profundidad ante un `practitionerId` de sesión viejo). Lo tira como `OwnPractitionerGone`.
 */
async function assertOwnPractitioner(tx: DbClient, actor: Actor, practitionerId: string): Promise<void> {
  const me = await tx.practitioner.findFirst({ where: writablePractitionerWhere(actor, practitionerId, "self"), select: { id: true } });
  if (!me) throw new OwnPractitionerGone();
}

/**
 * Alta propia: profesional válido + tope. El `FOR UPDATE` sobre la fila del profesional serializa dos altas
 * simultáneas del mismo profesional (sin él, las dos cuentan 29 y quedan 31).
 */
async function assertOwnCreateAllowed(tx: DbClient, actor: Actor, practitionerId: string): Promise<void> {
  await assertOwnPractitioner(tx, actor, practitionerId);
  await tx.$queryRaw`SELECT "id" FROM "Practitioner" WHERE "id" = ${practitionerId} AND "tenantId" = ${actor.tenantId} FOR UPDATE`;
  const count = await tx.service.count({ where: { tenantId: actor.tenantId, practitionerId } });
  if (count >= OWN_SERVICES_MAX) throw new OwnServiceLimit();
}

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

export async function deleteService(...args: Parameters<typeof deleteServiceImpl>): ReturnType<typeof deleteServiceImpl> {
  return withReadOnlyResult(() => withSupportWritable("lib/services.ts#deleteService", () => deleteServiceImpl(...args)));
}

async function deleteServiceImpl(id: string): Promise<ActionResult> {
  const { actor, via } = await serviceWriteScope();
  // ES2a → S13: M1 dejó `TreatmentProgram.serviceId` en RESTRICT (un plan no
  // puede quedar sin servicio en silencio) y `Booking.serviceId` ya lo era.
  // Antes se contaban solo los turnos: un servicio con planes y sin turnos
  // llegaba al DELETE y Postgres lo rechazaba (P2003 → 500 genérico). Se
  // cuentan todos los planes, archivados y cancelados incluidos: la FK no mira
  // el estado. `PlanTemplate.serviceId` es SET NULL: una plantilla no bloquea,
  // queda sin servicio y el editor lo pide al usarla.
  let outcome: "not-found" | "in-use" | "deleted";
  // Por la vía propia el gate garantizó `actor.practitionerId` (IAM-4a: nunca `null` como dueño).
  const ownPid = via === "self" ? actor.practitionerId : null;
  try {
    outcome = await runWithRls(actor.tenantId, async (tx) => {
      const owned = await tx.service.findFirst({
        where: { id, tenantId: actor.tenantId },
        select: { practitionerId: true, _count: { select: { bookings: true, programs: true } } },
      });
      if (!owned) return "not-found" as const;
      // CF3 (D-CF3-6): por la vía propia, solo un servicio suyo (el del consultorio o el de otro = lo de siempre).
      if (via === "self" && !isActorPractitioner(actor, owned.practitionerId)) throw new ForbiddenError(ADMIN_MSG);
      if (owned._count.bookings > 0 || owned._count.programs > 0) return "in-use" as const;
      // CF3 ZF1 (B4): pertenencia también en el WHERE del DELETE (la lectura de arriba no lockea): un servicio
      // reasignado en el medio no lo borra el profesional anterior (P2025 → «Servicio no encontrado.»).
      await tx.service.delete({
        where: { id, tenantId: actor.tenantId, ...(via === "self" && ownPid ? { practitionerId: ownPid } : {}) },
      });
      await auditInTx(tx, {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "service.delete",
        entity: "Service",
        entityId: id,
        ...(via === "self" ? { payload: { via } } : {}),
      });
      return "deleted" as const;
    });
  } catch (e) {
    // Conteo y DELETE van en la misma tx pero sin lock: un turno o plan creado
    // entre los dos igual dispara la FK. Mismo mensaje en vez de un 500.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003") {
      outcome = "in-use";
    } else {
      // CF3 ZF1: el `ForbiddenError` es el contrato (se tira, como en create/update); el modo lectura/soporte sale con
      // su copy; cualquier otra falla (P2025 de un borrado concurrente, red) daba un 500 que en prod Next redacta.
      if (e instanceof ForbiddenError) throw e;
      const ro = readOnlyFailure(e);
      if (ro) return ro;
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") return { ok: false, error: "Servicio no encontrado." };
      logger.error("service.delete.failed", { err: e instanceof Error ? e.message : String(e) });
      return { ok: false, error: "No pudimos borrar el servicio." };
    }
  }
  if (outcome === "not-found") return { ok: false, error: "Servicio no encontrado." };
  if (outcome === "in-use") return { ok: false, error: DELETE_IN_USE_MSG };
  revalidateServices(actor.tenantId);
  return { ok: true, data: undefined };
}
