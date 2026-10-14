"use server";

/**
 * /plataforma consultorios — la única escritura (EV0 · EV-P1, plan §15.4): el
 * Drawer "Editar suscripción" de EV-P3 cambia vertical, plan, estado de la
 * suscripción, fin del trial y el switch del turnero (EV-D6). Las lecturas viven
 * en `lib/platform-tenants-read.ts` (server-only, no son actions).
 *
 * Orden: `requirePlatformAdmin("tenant.entitlements.update")` (BO2-D: antes
 * `requireSuperAdmin()`, que pasaba por `buildActor` y exigía un consultorio
 * «casa»; handoff BO1-B) → zod `.strict()` → tx del canal service →
 * `applyTenantEntitlementsInTx` (escritor único C-EV5: allowlist, FOR UPDATE,
 * CAS, audit `platform.tenant.entitlements` en el tenant AFECTADO) → revalidar
 * después del commit y solo si algo cambió.
 *
 * Por qué `prismaService.$transaction` y no `runWithRls`: el superadmin edita un
 * tenant que no es el suyo; bajo el rol app la fila ajena es invisible
 * (`not-found`). El canal service bypassa RLS, así que `requirePlatformAdmin` es
 * la única barrera y va primero, antes incluso de parsear.
 */
import { revalidatePath, revalidateTag } from "next/cache";
import { prismaService } from "@/lib/db";
import { requirePlatformAdmin } from "@/lib/platform-actor";
import { tenantEntitlementTags } from "@/lib/cache-tags";
import {
  applyTenantEntitlementsInTx,
  type EntitlementPatchFor,
} from "@/lib/tenant-entitlements-internal";
import { UpdatePlatformTenant, trialEndsOnToDate } from "@/lib/platform-tenants-schemas";
import type { ActionResult } from "@/lib/validation";

export async function updatePlatformTenant(raw: unknown): Promise<ActionResult<{ updatedAt: string }>> {
  const actor = await requirePlatformAdmin("tenant.entitlements.update");

  const parsed = UpdatePlatformTenant.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(parsed.error.flatten().fieldErrors)) if (v) fieldErrors[k] = v;
    return { ok: false, error: "Datos inválidos", fieldErrors };
  }
  const { tenantId, expectedUpdatedAt, trialEndsOn, vertical, plan, subscriptionStatus, publicBookingEnabled } =
    parsed.data;

  // Solo las keys presentes: ausente = no tocar (el escritor ignora undefined,
  // pero así el patch que llega al audit es exactamente lo que pidió el Drawer).
  const patch: EntitlementPatchFor<"platform"> = {};
  if (vertical !== undefined) patch.vertical = vertical;
  if (plan !== undefined) patch.plan = plan;
  if (subscriptionStatus !== undefined) patch.subscriptionStatus = subscriptionStatus;
  if (publicBookingEnabled !== undefined) patch.publicBookingEnabled = publicBookingEnabled;
  if (trialEndsOn !== undefined) patch.trialEndsAt = trialEndsOn === null ? null : trialEndsOnToDate(trialEndsOn);

  const res = await prismaService.$transaction((tx) =>
    applyTenantEntitlementsInTx(tx, {
      tenantId,
      source: "platform",
      patch,
      expectedUpdatedAt: new Date(expectedUpdatedAt),
      // PlatformActorRef (C-BO5) desde el PlatformActor (C-BO2): `homeTenantId` null = sin consultorio propio.
      actor: { userId: actor.userId, email: actor.email, homeTenantId: actor.homeTenantId },
    })
  );

  if (!res.ok) {
    if (res.reason === "stale") return { ok: false, error: "Otro cambio se guardó antes. Recargá y revisá." };
    if (res.reason === "not-found") {
      return { ok: false, error: "No encontramos ese consultorio. Puede que se haya dado de baja: volvé a la lista." };
    }
    // `onboarding-closed` solo aplica a source "onboarding"; defensivo.
    return { ok: false, error: "No se pudo guardar el cambio. Recargá y probá de nuevo." };
  }

  if (res.changed.length > 0) {
    // Después del commit (C-EV7): catálogo/ejercicios/dashboard del tenant
    // afectado dependen del plan y la vertical. El layout de /plataforma muestra
    // tipo y plan; "/" cubre además el shell del propio superadmin si editó su
    // home (los módulos del Actor se resuelven por request, el router cache no).
    for (const tag of tenantEntitlementTags(tenantId)) revalidateTag(tag);
    revalidatePath("/plataforma", "layout");
    revalidatePath("/", "layout");
  }

  return { ok: true, data: { updatedAt: res.updatedAt.toISOString() } };
}
