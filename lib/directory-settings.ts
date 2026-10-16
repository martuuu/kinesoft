"use server";

/**
 * Directorio público desde Configuración (DIR-2b, contrato C-DIR8; DIR-D9, DIR-D19).
 *
 * - `setDirectoryListed` / `setPublicDescription`: el opt-in del consultorio y su descripción pública. Solo
 *   `tenant.admin` (el Titular o quien tenga «Configuración» delegada, `grantSettings`). **Soporte rechazado** con su
 *   copy (DIR-D9): publicar un consultorio en un directorio público es una decisión del consultorio, no algo con lo
 *   que soporte «ayuda»; por eso NO están en la allowlist de `lib/support-writable.ts` y además se cortan antes de
 *   abrir la tx (sin el corte, `SUPPORT_CAPS` trae `tenant.admin` y el error sería el genérico de solo lectura).
 * - `setPractitionerSpecialties`: especialidades del catálogo global de un profesional (≤ 5). `tenant.admin` o el
 *   propio profesional (como el switch del turnero, `lib/practitioner-public.ts`). Sin audit (C-DIR8: no es un dato
 *   sensible ni cambia quién ve qué).
 *
 * Patrón de cada action: `getActor()` → zod → `where: { tenantId }` a mano (en prod la conexión es BYPASSRLS: es la
 * única barrera) → `runWithRls(actor.tenantId, …)`. Los ids de entrada (profesional, especialidades) se validan
 * contra el tenant / el catálogo antes de escribir: las FK saltean RLS.
 *
 * Caché: `revalidateTag(tags.directory())` DESPUÉS del commit (adentro de la tx, un rollback dejaría el caché
 * invalidado contra datos viejos y otro request lo volvería a llenar con el estado previo) y solo si hubo cambio.
 *
 * Escritor único (`tests/unit/directory-writers.test.ts`): este archivo es el único que escribe `directoryListed*` y
 * `publicDescription`. La moderación (`directoryHidden*`) es de `lib/platform-directory.ts`.
 */
import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";
import { runWithRls } from "@/lib/rls";
import { getActor } from "@/lib/session";
import { capabilitiesForActor } from "@/lib/authz";
import { auditInTx } from "@/lib/audit";
import { isActorPractitioner } from "@/lib/practitioner-scope";
import { withReadOnlyResult } from "@/lib/read-only-result";
import { tags } from "@/lib/cache-tags";
import {
  DIRECTORY_SUPPORT_DENIED,
  MAX_PRACTITIONER_SPECIALTIES,
  PUBLIC_DESCRIPTION_MAX,
} from "@/lib/directory-constants";
import type { ActionResult } from "@/lib/validation";

const ADMIN_ONLY = "Solo el titular o quien tenga permiso de Configuración puede cambiar esto.";
const SPECIALTIES_FORBIDDEN =
  "Solo el titular, quien tenga permiso de Configuración o el propio profesional pueden cambiar las especialidades.";
const NOT_FOUND_TENANT = "No encontramos el consultorio. Recargá la página.";
const NOT_FOUND_PRACTITIONER = "Profesional no encontrado.";
const BAD_SPECIALTY = "Alguna de las especialidades elegidas no existe o ya no está disponible.";
const TOO_MANY = `Podés elegir hasta ${MAX_PRACTITIONER_SPECIALTIES} especialidades.`;

/** Corte común del opt-in: soporte primero (copy propio), después `tenant.admin`. */
async function requireDirectoryAdmin() {
  const actor = await getActor();
  if (actor.support) return { ok: false as const, error: DIRECTORY_SUPPORT_DENIED };
  const caps = await capabilitiesForActor(actor);
  if (!caps.has("tenant.admin")) return { ok: false as const, error: ADMIN_ONLY };
  return { ok: true as const, actor };
}

const ListedInput = z.boolean();

/**
 * Prende/apaga «Mostrar el consultorio en el directorio». Prender estampa `directoryListedAt` (CHECK
 * `Tenant_directoryListed_check`); apagar lo vuelve a null. Mismo valor = sin write, sin audit, sin revalidar.
 * No exige el turnero prendido: el valor queda guardado y el snapshot (C-DIR4) decide si el consultorio aparece.
 */
export async function setDirectoryListed(
  ...args: Parameters<typeof setDirectoryListedImpl>
): ReturnType<typeof setDirectoryListedImpl> {
  return withReadOnlyResult(() => setDirectoryListedImpl(...args));
}

async function setDirectoryListedImpl(listed: boolean): Promise<ActionResult<{ listed: boolean }>> {
  const gate = await requireDirectoryAdmin();
  if (!gate.ok) return gate;
  const { actor } = gate;
  const parsed = ListedInput.safeParse(listed);
  if (!parsed.success) return { ok: false, error: "Valor inválido para el directorio." };
  const value = parsed.data;

  const res = await runWithRls(actor.tenantId, async (tx) => {
    const row = await tx.tenant.findFirst({ where: { id: actor.tenantId }, select: { directoryListed: true } });
    if (!row) return "notFound" as const;
    if (row.directoryListed === value) return "same" as const;
    await tx.tenant.updateMany({
      where: { id: actor.tenantId },
      data: { directoryListed: value, directoryListedAt: value ? new Date() : null },
    });
    await auditInTx(tx, {
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: "tenant.directoryListed",
      entity: "Tenant",
      entityId: actor.tenantId,
      payload: { directoryListed: value },
    });
    return "changed" as const;
  });
  if (res === "notFound") return { ok: false, error: NOT_FOUND_TENANT };
  if (res === "changed") {
    revalidateTag(tags.directory());
    revalidatePath("/configuracion");
  }
  return { ok: true, data: { listed: value } };
}

const DescriptionInput = z
  .string()
  .nullable()
  .transform((v) => {
    const t = (v ?? "").trim();
    return t === "" ? null : t;
  })
  // `char_length` de Postgres cuenta code points: `[...s].length`, no `.length` (un emoji es 2 en UTF-16).
  .refine((v) => v === null || [...v].length <= PUBLIC_DESCRIPTION_MAX, {
    message: `La descripción puede tener hasta ${PUBLIC_DESCRIPTION_MAX} caracteres.`,
  });

/**
 * Descripción pública del consultorio (≤ 800, CHECK `Tenant_publicDescription_check`). Vacía = null. El audit lleva
 * solo si quedó cargada y su largo: el texto ya es público, pero el log no necesita la foto.
 */
export async function setPublicDescription(
  ...args: Parameters<typeof setPublicDescriptionImpl>
): ReturnType<typeof setPublicDescriptionImpl> {
  return withReadOnlyResult(() => setPublicDescriptionImpl(...args));
}

async function setPublicDescriptionImpl(description: string | null): Promise<ActionResult<{ description: string | null }>> {
  const gate = await requireDirectoryAdmin();
  if (!gate.ok) return gate;
  const { actor } = gate;
  const parsed = DescriptionInput.safeParse(description);
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message ?? "Descripción inválida.";
    return { ok: false, error: msg, fieldErrors: { publicDescription: [msg] } };
  }
  const value = parsed.data;

  const res = await runWithRls(actor.tenantId, async (tx) => {
    const row = await tx.tenant.findFirst({ where: { id: actor.tenantId }, select: { publicDescription: true } });
    if (!row) return "notFound" as const;
    if (row.publicDescription === value) return "same" as const;
    await tx.tenant.updateMany({ where: { id: actor.tenantId }, data: { publicDescription: value } });
    await auditInTx(tx, {
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: "tenant.publicDescription",
      entity: "Tenant",
      entityId: actor.tenantId,
      payload: { hasDescription: value !== null, length: value === null ? 0 : [...value].length },
    });
    return "changed" as const;
  });
  if (res === "notFound") return { ok: false, error: NOT_FOUND_TENANT };
  if (res === "changed") {
    revalidateTag(tags.directory());
    revalidatePath("/configuracion");
  }
  return { ok: true, data: { description: value } };
}

const SpecialtiesInput = z.object({
  practitionerId: z.string().trim().min(1).max(64),
  // Se deduplica ANTES del tope: elegir dos veces la misma no cuenta doble.
  specialtyIds: z
    .array(z.string().trim().min(1).max(64))
    .max(50)
    .transform((ids) => [...new Set(ids)])
    .refine((ids) => ids.length <= MAX_PRACTITIONER_SPECIALTIES, { message: TOO_MANY }),
});

/**
 * Reemplaza las especialidades de un profesional por `specialtyIds` (≤ 5, del catálogo global y sin archivar).
 * Un id de otro consultorio = «no encontrado» (no revela que existe). Escribe solo la diferencia; sin cambios no
 * revalida.
 */
export async function setPractitionerSpecialties(
  ...args: Parameters<typeof setPractitionerSpecialtiesImpl>
): ReturnType<typeof setPractitionerSpecialtiesImpl> {
  return withReadOnlyResult(() => setPractitionerSpecialtiesImpl(...args));
}

async function setPractitionerSpecialtiesImpl(
  practitionerId: string,
  specialtyIds: string[]
): Promise<ActionResult<{ specialtyIds: string[] }>> {
  const actor = await getActor();
  const parsed = SpecialtiesInput.safeParse({ practitionerId, specialtyIds });
  if (!parsed.success) {
    const tooMany = parsed.error.issues.some((i) => i.message === TOO_MANY);
    return { ok: false, error: tooMany ? TOO_MANY : "Datos inválidos." };
  }
  const input = parsed.data;
  // El propio profesional sin query; el resto necesita `tenant.admin`.
  if (!isActorPractitioner(actor, input.practitionerId)) {
    const caps = await capabilitiesForActor(actor);
    if (!caps.has("tenant.admin")) return { ok: false, error: SPECIALTIES_FORBIDDEN };
  }

  const res = await runWithRls(actor.tenantId, async (tx) => {
    const prac = await tx.practitioner.findFirst({
      where: { id: input.practitionerId, tenantId: actor.tenantId },
      select: { id: true },
    });
    if (!prac) return { kind: "notFound" as const };
    // Catálogo global (GLOBAL_READONLY: SELECT para todos). Archivada = no se puede elegir más.
    const valid = input.specialtyIds.length
      ? await tx.specialty.findMany({
          where: { id: { in: input.specialtyIds }, archivedAt: null },
          select: { id: true },
        })
      : [];
    if (valid.length !== input.specialtyIds.length) return { kind: "badSpecialty" as const };

    const current = await tx.practitionerSpecialty.findMany({
      where: { practitionerId: prac.id, tenantId: actor.tenantId },
      select: { specialtyId: true },
    });
    const want = new Set(input.specialtyIds);
    const have = new Set(current.map((c) => c.specialtyId));
    const toRemove = [...have].filter((id) => !want.has(id));
    const toAdd = input.specialtyIds.filter((id) => !have.has(id));
    if (toRemove.length === 0 && toAdd.length === 0) return { kind: "same" as const };
    if (toRemove.length) {
      await tx.practitionerSpecialty.deleteMany({
        where: { practitionerId: prac.id, tenantId: actor.tenantId, specialtyId: { in: toRemove } },
      });
    }
    if (toAdd.length) {
      await tx.practitionerSpecialty.createMany({
        data: toAdd.map((specialtyId) => ({ tenantId: actor.tenantId, practitionerId: prac.id, specialtyId })),
        skipDuplicates: true,
      });
    }
    return { kind: "changed" as const };
  });
  if (res.kind === "notFound") return { ok: false, error: NOT_FOUND_PRACTITIONER };
  if (res.kind === "badSpecialty") return { ok: false, error: BAD_SPECIALTY };
  if (res.kind === "changed") {
    revalidateTag(tags.directory());
    revalidatePath("/configuracion");
  }
  return { ok: true, data: { specialtyIds: input.specialtyIds } };
}
