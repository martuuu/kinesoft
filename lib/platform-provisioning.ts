"use server";

/**
 * /plataforma · alta de consultorio + titular (BO2-A, plan §19.5). La consume el Drawer
 * «Nuevo consultorio» (BO3-B).
 *
 * `requirePlatformAdmin("tenant.create")` va PRIMERO, antes de parsear: el núcleo escribe
 * por el canal service (BYPASSRLS) y crea cuentas de Auth, así que es la única barrera
 * (invariante del gate de BO: un `requirePlatformAdmin` por export de `lib/platform-*`).
 * Quien no es superadmin recibe el `ForbiddenError` sin que se haya leído ni escrito nada.
 *
 * El flujo entero (y el porqué de cada paso) vive en `lib/platform-provisioning-internal.ts`.
 */
import { requirePlatformAdmin } from "@/lib/platform-actor";
import { provisionTenantWithOwner } from "@/lib/platform-provisioning-internal";
import {
  CreateTenantWithOwnerInput,
  type CreateTenantWithOwnerInputType,
  type CreateTenantWithOwnerResult,
} from "@/lib/platform-provisioning-schemas";
import type { ActionResult } from "@/lib/validation";

export async function createTenantWithOwner(
  raw: CreateTenantWithOwnerInputType
): Promise<ActionResult<CreateTenantWithOwnerResult>> {
  // Política + rate limit de la acción. El núcleo vuelve a exigir superadmin (sin consumir cupo).
  await requirePlatformAdmin("tenant.create");

  const parsed = CreateTenantWithOwnerInput.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(parsed.error.flatten().fieldErrors)) if (v) fieldErrors[k] = v;
    return { ok: false, error: "Revisá los datos del consultorio.", fieldErrors };
  }
  return provisionTenantWithOwner(parsed.data);
}
