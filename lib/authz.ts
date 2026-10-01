/**
 * Autorización por rol del tenant (B1.7 AUTHZ, B-pre).
 *
 * El `Actor` no lleva el rol (`lib/session.ts`, tipo Actor): se lee de
 * `Membership` acá, una vez por request (`react` `cache`). Antes de esto el
 * mismo findUnique + `role !== "OWNER" && role !== "ADMIN"` estaba copiado en
 * services, insurers, tenant-settings, configuracion/page y patients; cada
 * copia es un lugar donde olvidarse de un rol nuevo.
 *
 * La matriz rol → capabilities vive en `lib/capabilities.ts` (puro, la usa
 * también la UI). Acá solo se resuelve el rol del actor y se tira
 * `ForbiddenError` si falta la capability.
 *
 * Tenant: la lectura va por `runWithRls` y por la clave única
 * (userId, tenantId) del actor — en prod la conexión tiene BYPASSRLS y el
 * `tenantId` explícito es la barrera.
 */
import "server-only";
import { cache } from "react";
import type { Role } from "@prisma/client";
import { runWithRls } from "@/lib/rls";
import { getActor, ForbiddenError, type Actor } from "@/lib/session";
import { capabilitiesFor, type Capability } from "@/lib/capabilities";

// Cacheado por primitivos (no por la identidad del objeto Actor) para que dos
// llamadas con actores equivalentes en el mismo request compartan la query.
const roleFor = cache(async (tenantId: string, userId: string): Promise<Role | null> => {
  const m = await runWithRls(tenantId, (tx) =>
    tx.membership.findUnique({
      where: { userId_tenantId: { userId, tenantId } },
      select: { role: true },
    })
  );
  return m?.role ?? null;
});

/** Rol del actor en su tenant activo; `null` si no tiene membresía (falla cerrado). */
export async function getMembershipRole(actor: Actor): Promise<Role | null> {
  return roleFor(actor.tenantId, actor.userId);
}

/** Capabilities del actor de la sesión. */
export async function getCapabilities(): Promise<ReadonlySet<Capability>> {
  const actor = await getActor();
  return capabilitiesFor(await getMembershipRole(actor));
}

/**
 * Exige una capability; devuelve el actor para encadenar como `getActor()`.
 * Tira `ForbiddenError` (extiende Error, `message` = `message` recibido).
 */
export async function requireCapability(
  cap: Capability,
  message = "No tenés permiso para hacer esta acción."
): Promise<{ actor: Actor; caps: ReadonlySet<Capability> }> {
  const actor = await getActor();
  const caps = capabilitiesFor(await getMembershipRole(actor));
  if (!caps.has(cap)) throw new ForbiddenError(message);
  return { actor, caps };
}

/**
 * OWNER/ADMIN o tira. Equivalente exacto del `requireAdmin` copiado en
 * `lib/tenant-settings.ts` / `requireAdminActor` de services e insurers: misma
 * query, mismo criterio (OWNER|ADMIN; sin membresía = rechazo), tira un Error
 * con el `message` dado (cada caller conserva su texto). Única diferencia:
 * la clase es `ForbiddenError` (subclase de Error), así que los `catch` que
 * leen `e.message` siguen igual.
 */
export async function requireTenantAdmin(
  message = "Solo OWNER/ADMIN pueden cambiar la configuración del consultorio."
): Promise<Actor> {
  const { actor } = await requireCapability("tenant.admin", message);
  return actor;
}
