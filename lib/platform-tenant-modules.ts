"use server";

/**
 * T3c-1p (plan §23.6) · módulos a medida de un consultorio desde Plataforma → consultorio → Suscripción → «Módulos».
 *
 * Orden: `requirePlatformAdmin("tenant.modules.update")` (clave HIGH: step-up de la 2FA por usuario o re-verificación
 * TOTP con `enforce`; va primero, antes de parsear: el canal service bypassa RLS y esta es la única barrera) → zod
 * `.strict()` (núcleo, turnero, repetidos e intersección se rechazan sin tocar la base) → tx del canal service →
 * lock de la fila + vertical (un módulo que no existe en la vertical se rechaza con copy) → escritor único
 * `applyTenantEntitlementsInTx` con source `platform` (CAS, normaliza las listas, regla de dependencias, audit DOBLE
 * `platform.tenant.entitlements` en el consultorio y en `PlatformAuditEvent`) → revalidar después del commit y solo
 * si algo cambió.
 *
 * Por qué `prismaService.$transaction` y no `runWithRls`: el superadmin edita un consultorio que no es el suyo; bajo
 * el rol app la fila ajena es invisible y `PlatformAuditEvent` es SERVICE_ONLY (el INSERT del audit doble rebota).
 *
 * Las dos listas viajan SIEMPRE (`SetTenantModuleOverrides`): el Drawer manda el estado completo y el escritor compara
 * por contenido; mandar lo mismo es un no-op (ni UPDATE ni audit ni revalidate).
 */
import { revalidatePath, revalidateTag } from "next/cache";
import { prismaService } from "@/lib/db";
import { requirePlatformAdmin } from "@/lib/platform-actor";
import { tenantEntitlementTags } from "@/lib/cache-tags";
import { applyTenantEntitlementsInTx } from "@/lib/tenant-entitlements-internal";
import { isModuleOverridable } from "@/lib/tenant-modules";
import { ModuleDependencyError, moduleDependencyCopy } from "@/lib/tenant-module-deps";
import { MODULE_OVERRIDE_COPY, SetTenantModuleOverrides } from "@/lib/platform-tenant-modules-schemas";
import { moduleName } from "@/components/plataforma/tenants/labels";
import type { ActionResult } from "@/lib/validation";

/** Corta la tx con un rechazo que se le muestra al superadmin tal cual (sin escribir nada). */
class OverrideRejected extends Error {
  constructor(public copy: string) {
    super("module_override_rejected");
    this.name = "OverrideRejected";
  }
}

export async function setTenantModuleOverrides(
  raw: unknown
): Promise<ActionResult<{ updatedAt: string; changed: boolean }>> {
  const actor = await requirePlatformAdmin("tenant.modules.update");

  const parsed = SetTenantModuleOverrides.safeParse(raw);
  if (!parsed.success) {
    // El primer mensaje propio (núcleo, turnero, repetido, cruzado) sirve tal cual; lo demás es forma del request.
    const custom = parsed.error.issues.find((i) => i.code === "custom")?.message;
    return { ok: false, error: custom ?? "Datos inválidos. Recargá la página y probá de nuevo." };
  }
  const { tenantId, expectedUpdatedAt, grants, revokes } = parsed.data;
  const expected = new Date(expectedUpdatedAt);

  let res: Awaited<ReturnType<typeof applyTenantEntitlementsInTx>>;
  try {
    res = await prismaService.$transaction(async (tx) => {
      // Lock + vertical antes del escritor (que vuelve a tomar el mismo lock en la misma tx: no espera). Validar la
      // vertical acá y no dejarlo al `programmingError` del escritor: para el superadmin es un rechazo con copy, no
      // un 500. Con la versión vieja no se valida nada: el escritor devuelve `stale` y el Drawer recarga.
      await tx.$queryRaw`SELECT "id" FROM "Tenant" WHERE "id" = ${tenantId} FOR UPDATE`;
      const cur = await tx.tenant.findUnique({ where: { id: tenantId }, select: { vertical: true, updatedAt: true } });
      if (cur && cur.updatedAt.getTime() === expected.getTime()) {
        if ([...grants, ...revokes].some((m) => !isModuleOverridable(m, cur.vertical))) {
          throw new OverrideRejected(MODULE_OVERRIDE_COPY.vertical);
        }
      }
      return applyTenantEntitlementsInTx(tx, {
        tenantId,
        source: "platform",
        patch: { moduleGrants: grants, moduleRevokes: revokes },
        expectedUpdatedAt: expected,
        actor: { userId: actor.userId, email: actor.email, homeTenantId: actor.homeTenantId },
      });
    });
  } catch (e) {
    if (e instanceof OverrideRejected) return { ok: false, error: e.copy };
    if (e instanceof ModuleDependencyError) {
      return { ok: false, error: e.violations.map((v) => moduleDependencyCopy(v, moduleName)).join(" ") };
    }
    throw e;
  }

  if (!res.ok) {
    if (res.reason === "stale") return { ok: false, error: MODULE_OVERRIDE_COPY.stale };
    if (res.reason === "not-found") return { ok: false, error: MODULE_OVERRIDE_COPY.notFound };
    return { ok: false, error: "No se pudo guardar el cambio. Recargá y probá de nuevo." };
  }

  if (res.changed.length > 0) {
    // Después del commit (C-EV7), como `updatePlatformTenant`: catálogo, ejercicios y dashboard del consultorio
    // dependen de sus módulos; el layout de /plataforma muestra los chips; "/" cubre el shell del propio superadmin si
    // tocó su consultorio «casa» (los módulos del Actor se resuelven por request, el router cache no).
    for (const tag of tenantEntitlementTags(tenantId)) revalidateTag(tag);
    revalidatePath("/plataforma", "layout");
    revalidatePath("/", "layout");
  }

  return { ok: true, data: { updatedAt: res.updatedAt.toISOString(), changed: res.changed.length > 0 } };
}
