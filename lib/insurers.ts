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
import { withSupportWritable } from "@/lib/support-writable";
import { readOnlyFailure, withReadOnlyResult } from "@/lib/read-only-result";
import { revalidatePath, revalidateTag, unstable_cache } from "next/cache";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { runWithRls } from "@/lib/rls";
import { getActor } from "@/lib/session";
import { requireTenantAdmin } from "@/lib/authz";
import { findActivePayer } from "@/lib/catalog-validate";
import { enableInsurerForPractitioners } from "@/lib/agenda-defaults";
import { CatalogId, InsurerPayerLink, type AddFromCatalogResult } from "@/lib/catalog-schemas";
import { auditInTx } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { tags, ttl } from "@/lib/cache-tags";
import type { ActionResult } from "@/lib/validation";
import type { InsurerRow } from "@/lib/insurers-types";

const ADMIN_MSG = "Solo OWNER/ADMIN pueden modificar el catálogo de obras sociales.";

/**
 * `unstable_cache` notes:
 *
 *   - It cannot wrap a function that reads `cookies()`/`headers()` —
 *     hence the `getActor()` call lives OUTSIDE the cached fetcher.
 *   - `keyParts` is the cache disambiguator; we include tenantId so each
 *     tenant has its own slice.
 *   - `tags` is the invalidation handle; we include the tenant prefix so
 *     `revalidateTag(tags.insurers(tenantId))` only invalidates this
 *     tenant. Other tenants stay warm.
 */
export async function listInsurers(opts: { onlyActive?: boolean } = {}): Promise<InsurerRow[]> {
  const actor = await getActor();
  const onlyActive = !!opts.onlyActive;
  const fetcher = unstable_cache(
    async (tenantId: string, active: boolean): Promise<InsurerRow[]> => {
      const rows = await runWithRls(tenantId, (tx) => tx.insurer.findMany({
        where: {
          tenantId,
          ...(active ? { active: true } : {}),
        },
        orderBy: [{ active: "desc" }, { name: "asc" }],
        include: {
          _count: { select: { coverages: true } },
          payer: { select: { name: true } },
        },
      }));
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        copagoCents: r.copagoCents,
        fixedFeeCents: r.fixedFeeCents,
        isParticular: r.isParticular,
        active: r.active,
        notes: r.notes,
        payerId: r.payerId,
        payerName: r.payer?.name ?? null,
        patientsCount: r._count.coverages,
        createdAt: r.createdAt,
      }));
    },
    ["insurers:list", actor.tenantId, String(onlyActive)],
    { tags: [tags.insurers(actor.tenantId)], revalidate: ttl.short }
  );
  return fetcher(actor.tenantId, onlyActive);
}

const InsurerInput = z.object({
  name: z.string().trim().min(1, "Nombre requerido").max(80),
  copagoCents: z.coerce.number().int().min(0).max(10_000_000),
  fixedFeeCents: z.coerce.number().int().min(0).max(10_000_000),
  active: z.boolean().optional().default(true),
  notes: z.string().trim().max(500).optional().or(z.literal("")),
  // Vínculo opcional al catálogo global; se valida contra la DB en la tx.
  payerId: InsurerPayerLink.optional(),
});

export async function createInsurer(...args: Parameters<typeof createInsurerImpl>): ReturnType<typeof createInsurerImpl> {
  return withReadOnlyResult(() => withSupportWritable("lib/insurers.ts#createInsurer", () => createInsurerImpl(...args)));
}

async function createInsurerImpl(
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
  const actor = await requireTenantAdmin(ADMIN_MSG);
  try {
    const row = await runWithRls(actor.tenantId, async (tx) => {
      // La FK payerId saltea RLS: prestadora existente y no archivada, acá.
      if (parsed.data.payerId && !(await findActivePayer(tx, parsed.data.payerId))) {
        return null;
      }
      const created = await tx.insurer.create({
        data: {
          tenantId: actor.tenantId,
          name: parsed.data.name,
          copagoCents: parsed.data.copagoCents,
          fixedFeeCents: parsed.data.fixedFeeCents,
          active: parsed.data.active ?? true,
          notes: parsed.data.notes || null,
          payerId: parsed.data.payerId ?? null,
        },
      });
      // B2.3 (decisión 7): la OS nueva la aceptan todos los profesionales
      // aceptados, en la misma tx. Solo si nace activa (= backfill (4)); una
      // inactiva recibe las filas al reactivarse (updateInsurer).
      if (created.active) {
        await enableInsurerForPractitioners(tx, { tenantId: actor.tenantId, insurerId: created.id });
      }
      // PL-A2 (§20.5.9): plata (el copago de la OS entra en lib/copago.ts) → audit en la
      // misma tx: el evento existe si y solo si la OS existe.
      await auditInTx(tx, {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "insurer.create",
        entity: "Insurer",
        entityId: created.id,
        payload: { name: created.name, ...(created.payerId ? { payerId: created.payerId } : {}) },
      });
      return created;
    });
    if (!row) return { ok: false, error: "Prestadora no encontrada en el catálogo." };
    revalidatePath("/configuracion");
    revalidateTag(tags.insurers(actor.tenantId));
    return { ok: true, data: { id: row.id } };
  } catch (e) {
    // EV1-E2 (readonly-residual-actions): modo lectura / soporte → su copy, no el genérico de abajo.
    const ro = readOnlyFailure(e);
    if (ro) return ro;
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, error: "Ya existe una obra social con ese nombre." };
    }
    logger.error("insurer.create.failed", { err: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: "No pudimos crear la obra social." };
  }
}

export async function updateInsurer(...args: Parameters<typeof updateInsurerImpl>): ReturnType<typeof updateInsurerImpl> {
  return withReadOnlyResult(() => withSupportWritable("lib/insurers.ts#updateInsurer", () => updateInsurerImpl(...args)));
}

async function updateInsurerImpl(
  id: string,
  raw: Partial<z.input<typeof InsurerInput>>
): Promise<ActionResult> {
  const actor = await requireTenantAdmin(ADMIN_MSG);
  const owned = await runWithRls(actor.tenantId, (tx) => tx.insurer.findFirst({
    where: { id, tenantId: actor.tenantId },
    select: { id: true },
  }));
  if (!owned) return { ok: false, error: "Obra social no encontrada." };

  const parsed = InsurerInput.partial().safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Datos inválidos",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  try {
    // "Antes", update y audit en la misma transacción: el antes/después
    // (A2b-S-cfg) describe exactamente lo que pisó este update, y (PL-A2,
    // §20.5.9) si la tx se revierte no queda un audit de algo que no pasó.
    await runWithRls(actor.tenantId, async (tx) => {
      const { isParticular, active: wasActive, ...before } = await tx.insurer.findFirstOrThrow({
        where: { id, tenantId: actor.tenantId },
        select: {
          name: true,
          copagoCents: true,
          fixedFeeCents: true,
          payerId: true,
          isParticular: true,
          active: true,
        },
      });
      // "Particular" es el pago de bolsillo: no es ninguna prestadora.
      if (isParticular && parsed.data.payerId) {
        throw new PayerNotFound("«Particular» no se vincula a una prestadora.");
      }
      // La FK payerId saltea RLS: prestadora existente y no archivada, acá.
      // Solo si CAMBIA: una prestadora archivada después de vincularla no
      // puede bloquear la edición del copago.
      if (
        parsed.data.payerId &&
        parsed.data.payerId !== before.payerId &&
        !(await findActivePayer(tx, parsed.data.payerId))
      ) {
        throw new PayerNotFound("Prestadora no encontrada en el catálogo.");
      }
      const { active: isActive, ...after } = await tx.insurer.update({
        where: { id },
        data: {
          ...parsed.data,
          notes: parsed.data.notes ? parsed.data.notes : parsed.data.notes === "" ? null : undefined,
        },
        select: { name: true, copagoCents: true, fixedFeeCents: true, payerId: true, active: true },
      });
      // B2.3: una OS que se REACTIVA vuelve a quedar aceptada por todos los
      // profesionales aceptados (como una nueva). Solo en la transición
      // inactiva → activa: idempotente, y no re-agrega en cada edición una
      // fila que un profesional haya quitado a propósito.
      if (!wasActive && isActive) {
        await enableInsurerForPractitioners(tx, { tenantId: actor.tenantId, insurerId: id });
      }
      const changes = auditDiff(before, after);
      await auditInTx(tx, {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "insurer.update",
        entity: "Insurer",
        entityId: id,
        // Solo nombre y montos, y solo si cambiaron: el copago de la OS entra en
        // la precedencia de lib/copago.ts de todos los turnos no cobrados sin
        // copago propio, así que "de cuánto a cuánto" tiene que quedar asentado.
        ...(changes ? { payload: changes } : {}),
      });
    });
  } catch (e) {
    // EV1-E2 (readonly-residual-actions): modo lectura / soporte → su copy, no el genérico de abajo.
    const ro = readOnlyFailure(e);
    if (ro) return ro;
    if (e instanceof PayerNotFound) return { ok: false, error: e.message };
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, error: "Ya existe una obra social con ese nombre." };
    }
    logger.error("insurer.update.failed", { err: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: "No pudimos guardar la obra social." };
  }
  revalidatePath("/configuracion");
  revalidateTag(tags.insurers(actor.tenantId));
  return { ok: true, data: undefined };
}

/** Corta (y revierte) la tx de update cuando el `payerId` pedido no es utilizable. */
class PayerNotFound extends Error {}

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

export async function deleteInsurer(...args: Parameters<typeof deleteInsurerImpl>): ReturnType<typeof deleteInsurerImpl> {
  return withReadOnlyResult(() => withSupportWritable("lib/insurers.ts#deleteInsurer", () => deleteInsurerImpl(...args)));
}

async function deleteInsurerImpl(id: string): Promise<ActionResult> {
  const actor = await requireTenantAdmin(ADMIN_MSG);
  const owned = await runWithRls(actor.tenantId, (tx) => tx.insurer.findFirst({
    where: { id, tenantId: actor.tenantId },
    include: { _count: { select: { coverages: true } } },
  }));
  if (!owned) return { ok: false, error: "Obra social no encontrada." };
  // "Particular" is the default out-of-pocket row every tenant needs — it
  // can be renamed/repriced but never deleted.
  if (owned.isParticular) {
    return { ok: false, error: "«Particular» no se puede eliminar; podés ajustar su precio." };
  }
  // Soft-delete when in use: deactivate but keep the row so historical
  // Coverages still resolve. Hard-delete only when zero references.
  if (owned._count.coverages > 0) {
    await runWithRls(actor.tenantId, async (tx) => {
      await tx.insurer.update({ where: { id }, data: { active: false } });
      await auditInTx(tx, {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "insurer.deactivate",
        entity: "Insurer",
        entityId: id,
      });
    });
    revalidatePath("/configuracion");
    revalidateTag(tags.insurers(actor.tenantId));
    return { ok: true, data: undefined };
  }
  await runWithRls(actor.tenantId, async (tx) => {
    await tx.insurer.delete({ where: { id } });
    await auditInTx(tx, {
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: "insurer.delete",
      entity: "Insurer",
      entityId: id,
    });
  });
  revalidatePath("/configuracion");
  revalidateTag(tags.insurers(actor.tenantId));
  return { ok: true, data: undefined };
}

/**
 * "Agregar del catálogo" (B1.4): crea una obra social del consultorio a partir
 * de una prestadora del catálogo global, con su nombre y `payerId`. Copago y
 * monto fijo nacen en 0: siguen siendo del Insurer (precedencia de
 * `lib/copago.ts` intacta) y la UI abre el editor para cargarlos.
 *
 * Si ya hay un Insurer con ese nombre (`@@unique([tenantId, name])`) no se
 * pisa nada: devuelve `status: "exists"` y la UI ofrece vincularlo.
 */
export async function addInsurerFromCatalog(...args: Parameters<typeof addInsurerFromCatalogImpl>): ReturnType<typeof addInsurerFromCatalogImpl> {
  return withReadOnlyResult(() => withSupportWritable("lib/insurers.ts#addInsurerFromCatalog", () => addInsurerFromCatalogImpl(...args)));
}

async function addInsurerFromCatalogImpl(
  rawPayerId: string
): Promise<ActionResult<AddFromCatalogResult>> {
  const payerId = CatalogId.safeParse(rawPayerId);
  if (!payerId.success) return { ok: false, error: "Prestadora inválida." };
  const actor = await requireTenantAdmin(ADMIN_MSG);
  try {
    const r = await runWithRls(actor.tenantId, async (tx) => {
      // La FK payerId saltea RLS: prestadora existente y no archivada, acá.
      const payer = await findActivePayer(tx, payerId.data);
      if (!payer) return null;
      const existing = await tx.insurer.findFirst({
        where: { tenantId: actor.tenantId, name: payer.name },
        select: { id: true, payerId: true },
      });
      if (existing) {
        return { status: "exists" as const, insurerId: existing.id, linkedPayerId: existing.payerId };
      }
      const row = await tx.insurer.create({
        data: { tenantId: actor.tenantId, name: payer.name, payerId: payer.id },
        select: { id: true, name: true },
      });
      // B2.3 (decisión 7): nace activa → la aceptan todos los profesionales
      // aceptados, en la misma tx (igual que createInsurer).
      await enableInsurerForPractitioners(tx, { tenantId: actor.tenantId, insurerId: row.id });
      await auditInTx(tx, {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "insurer.create",
        entity: "Insurer",
        entityId: row.id,
        payload: { name: row.name, payerId: payer.id, from: "catalog" },
      });
      return { status: "created" as const, insurerId: row.id, name: row.name };
    });
    if (!r) return { ok: false, error: "Prestadora no encontrada en el catálogo." };
    if (r.status === "exists") return { ok: true, data: r };
    revalidatePath("/configuracion");
    revalidateTag(tags.insurers(actor.tenantId));
    return { ok: true, data: { status: "created", insurerId: r.insurerId } };
  } catch (e) {
    // EV1-E2 (readonly-residual-actions): modo lectura / soporte → su copy, no el genérico de abajo.
    const ro = readOnlyFailure(e);
    if (ro) return ro;
    // Carrera con otro alta del mismo nombre entre el findFirst y el create.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, error: "Ya existe una obra social con ese nombre." };
    }
    logger.error("insurer.addFromCatalog.failed", { err: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: "No pudimos agregar la obra social." };
  }
}

/**
 * Vincula (`payerId` = id) o desvincula (`null`) una obra social del
 * consultorio con una prestadora del catálogo. No toca nombre ni montos.
 * Varias OS del consultorio pueden apuntar a la misma prestadora (p. ej.
 * "OSDE 210" y "OSDE 310" con copagos distintos: el precio por plan es D).
 */
export async function linkInsurerToPayer(...args: Parameters<typeof linkInsurerToPayerImpl>): ReturnType<typeof linkInsurerToPayerImpl> {
  return withReadOnlyResult(() => withSupportWritable("lib/insurers.ts#linkInsurerToPayer", () => linkInsurerToPayerImpl(...args)));
}

async function linkInsurerToPayerImpl(
  insurerId: string,
  rawPayerId: string | null
): Promise<ActionResult> {
  const parsed = InsurerPayerLink.safeParse(rawPayerId);
  if (!parsed.success) return { ok: false, error: "Prestadora inválida." };
  const payerId = parsed.data;
  const actor = await requireTenantAdmin(ADMIN_MSG);
  const r = await runWithRls(actor.tenantId, async (tx) => {
    const owned = await tx.insurer.findFirst({
      where: { id: insurerId, tenantId: actor.tenantId },
      select: { id: true, payerId: true, isParticular: true },
    });
    if (!owned) return { ok: false as const, error: "Obra social no encontrada." };
    // "Particular" es el pago de bolsillo: no es ninguna prestadora.
    if (owned.isParticular && payerId) {
      return { ok: false as const, error: "«Particular» no se vincula a una prestadora." };
    }
    if (payerId && !(await findActivePayer(tx, payerId))) {
      return { ok: false as const, error: "Prestadora no encontrada en el catálogo." };
    }
    await tx.insurer.update({ where: { id: owned.id }, data: { payerId } });
    if (owned.payerId !== payerId) {
      await auditInTx(tx, {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: payerId ? "insurer.linkPayer" : "insurer.unlinkPayer",
        entity: "Insurer",
        entityId: insurerId,
        payload: { before: { payerId: owned.payerId }, after: { payerId } },
      });
    }
    return { ok: true as const };
  });
  if (!r.ok) return r;
  revalidatePath("/configuracion");
  revalidateTag(tags.insurers(actor.tenantId));
  return { ok: true, data: undefined };
}
