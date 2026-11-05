"use server";

/**
 * /plataforma consultorios — la única escritura (EV0 · EV-P1, plan §15.4): el
 * Drawer "Editar suscripción" de EV-P3 cambia vertical, plan, estado de la
 * suscripción, fin del trial y el switch del turnero (EV-D6); BO3-B sumó el cupo
 * de profesionales a medida y PL-1d lo reemplaza por el plan SaaS (`saasPlan`) y
 * los cupos a medida por tipo (`maxUsersOverride` / `maxProfessionalsOverride` /
 * `maxStaffOverride`, Libre y excepciones). Las lecturas viven
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
import { CLINIC_SITES_TAG, tags, tenantEntitlementTags } from "@/lib/cache-tags";
import { auditPlatformInTx } from "@/lib/audit";
import {
  applyTenantEntitlementsInTx,
  type EntitlementPatchFor,
} from "@/lib/tenant-entitlements-internal";
import { SetPlatformTenantSite, UpdatePlatformTenant, trialEndsOnToDate } from "@/lib/platform-tenants-schemas";
import { getSeatUsageInTx } from "@/lib/team-internal";
import { PLAN_DEFAULTS, effectiveLimits } from "@/lib/saas-plans-logic";
import { limitsShrinkBelowUsage, type SeatCounts } from "@/lib/platform-tenants-logic";
import type { PlanLimitOverrides, PlanLimits } from "@/lib/saas-plans-types";
import type { ActionResult } from "@/lib/validation";
import type { Prisma, SaasPlan } from "@prisma/client";

/** Corta la tx: el plan o el cupo nuevo dejaría afuera a gente que hoy tiene acceso. */
class LimitsDoNotFit extends Error {
  constructor(public detail: string) {
    super("limits_do_not_fit");
    this.name = "LimitsDoNotFit";
  }
}

async function limitsOf(tx: Prisma.TransactionClient, plan: SaasPlan, o: PlanLimitOverrides): Promise<PlanLimits> {
  const cfg = await tx.saasPlanConfig.findUnique({
    where: { plan },
    select: { maxUsers: true, maxProfessionals: true, maxStaff: true },
  });
  return effectiveLimits(cfg ?? PLAN_DEFAULTS[plan].limits, o, plan);
}

export async function updatePlatformTenant(raw: unknown): Promise<ActionResult<{ updatedAt: string }>> {
  const actor = await requirePlatformAdmin("tenant.entitlements.update");

  const parsed = UpdatePlatformTenant.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(parsed.error.flatten().fieldErrors)) if (v) fieldErrors[k] = v;
    return { ok: false, error: "Datos inválidos", fieldErrors };
  }
  const {
    tenantId,
    expectedUpdatedAt,
    trialEndsOn,
    vertical,
    saasPlan,
    subscriptionStatus,
    publicBookingEnabled,
    maxUsersOverride,
    maxProfessionalsOverride,
    maxStaffOverride,
  } = parsed.data;

  // Solo las keys presentes: ausente = no tocar (el escritor ignora undefined,
  // pero así el patch que llega al audit es exactamente lo que pidió el Drawer).
  const patch: EntitlementPatchFor<"platform"> = {};
  if (vertical !== undefined) patch.vertical = vertical;
  // PL-1d: el escritor escribe `saasPlan` y espeja el `plan` legado (PL-D1).
  if (saasPlan !== undefined) patch.saasPlan = saasPlan;
  if (subscriptionStatus !== undefined) patch.subscriptionStatus = subscriptionStatus;
  if (publicBookingEnabled !== undefined) patch.publicBookingEnabled = publicBookingEnabled;
  // PL-1d: cupos a medida por tipo (el escritor los acepta solo para `platform`).
  if (maxUsersOverride !== undefined) patch.maxUsersOverride = maxUsersOverride;
  if (maxProfessionalsOverride !== undefined) patch.maxProfessionalsOverride = maxProfessionalsOverride;
  if (maxStaffOverride !== undefined) patch.maxStaffOverride = maxStaffOverride;
  if (trialEndsOn !== undefined) patch.trialEndsAt = trialEndsOn === null ? null : trialEndsOnToDate(trialEndsOn);

  const touchesLimits =
    saasPlan !== undefined ||
    maxUsersOverride !== undefined ||
    maxProfessionalsOverride !== undefined ||
    maxStaffOverride !== undefined;

  let res: Awaited<ReturnType<typeof applyTenantEntitlementsInTx>>;
  try {
    res = await prismaService.$transaction(async (tx) => {
      if (touchesLimits) {
        // PL-1d: este Drawer no elige quiénes pierden el acceso (eso es «Cambiar de plan», PL-3c, sobre
        // `applyPlanChangeInTx`). Si el plan o el cupo nuevo achica un límite por debajo de lo que ya se usa, se
        // rechaza en vez de dejar un consultorio pasado de cupo en silencio. Subir, o tocar un límite que ya estaba
        // pasado sin achicarlo (datos viejos), se deja. `getSeatUsageInTx` toma el FOR UPDATE de Tenant primero
        // (mismo orden que invitar/aceptar), así nadie se suma entre el recuento y la escritura.
        const usage = await getSeatUsageInTx(tx, tenantId, { now: new Date(), lock: true });
        const cur = await tx.tenant.findUnique({
          where: { id: tenantId },
          select: { saasPlan: true, maxUsersOverride: true, maxProfessionalsOverride: true, maxStaffOverride: true },
        });
        if (usage && cur) {
          const before = await limitsOf(tx, cur.saasPlan, cur);
          const after = await limitsOf(tx, saasPlan ?? cur.saasPlan, {
            maxUsersOverride: maxUsersOverride !== undefined ? maxUsersOverride : cur.maxUsersOverride,
            maxProfessionalsOverride:
              maxProfessionalsOverride !== undefined ? maxProfessionalsOverride : cur.maxProfessionalsOverride,
            maxStaffOverride: maxStaffOverride !== undefined ? maxStaffOverride : cur.maxStaffOverride,
          });
          const counts: SeatCounts = {
            total: usage.total.used,
            professional: usage.professional.used,
            staff: usage.staff.used,
          };
          const detail = limitsShrinkBelowUsage(counts, before, after);
          if (detail) throw new LimitsDoNotFit(detail);
        }
        // Sin fila: sigue y el escritor devuelve `not-found`.
      }
      return applyTenantEntitlementsInTx(tx, {
        tenantId,
        source: "platform",
        patch,
        expectedUpdatedAt: new Date(expectedUpdatedAt),
        // PlatformActorRef (C-BO5) desde el PlatformActor (C-BO2): `homeTenantId` null = sin consultorio propio.
        actor: { userId: actor.userId, email: actor.email, homeTenantId: actor.homeTenantId },
      });
    });
  } catch (e) {
    if (e instanceof LimitsDoNotFit) {
      return {
        ok: false,
        error: `${e.detail} Para bajar el plan usá «Cambiar de plan», que te deja elegir quiénes pierden el acceso.`,
      };
    }
    throw e;
  }

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

/**
 * CF3 (SD-S, D-CF3-10): el superadmin prende o apaga la sede digital `/<slug>` de un consultorio (p. ej. a pedido del
 * Titular por soporte, o para bajarla rápido si publica algo que no debe). Mismo molde que el resto de /plataforma:
 * `requirePlatformAdmin` primero (canal service = única barrera), zod `.strict()`, FOR UPDATE + CAS obligatorio contra
 * `expectedUpdatedAt`, diff (mismo valor = no-op sin audit) y audit DOBLE `platform.tenant.site` en la misma tx
 * (C-BO5: el `platform.*` en el log del consultorio afectado y la fila global). Clave `tenant.profile.update` (riesgo
 * medio, la de «Editar datos»): no se crea una clave nueva para un booleano del perfil público.
 * `siteEnabledAt` = ahora solo al prender (como «Sitio web»); apagar no lo borra.
 * Después del commit: snapshot de la sede (`CLINIC_SITES_TAG`), directorio (que enlaza a la sede) y `/<slug>`.
 *
 * BR-P: también los colores del sitio y del turnero (`palette`, cualquiera de `ALL_PALETTES`: Plataforma es quien
 * le asigna su paleta de marca a un consultorio). Mismo CAS, mismo diff por campo (solo lo que cambia entra al audit,
 * con su antes y después) y, si cambió la paleta, además el turnero (`/c/<slug>/booking`, que la pinta) y el
 * workspace del consultorio (`/`, layout: Apariencia ofrece la de marca según `Tenant.palette`).
 */
export async function setPlatformTenantSite(raw: unknown): Promise<ActionResult<{ updatedAt: string }>> {
  const actor = await requirePlatformAdmin("tenant.profile.update");
  const parsed = SetPlatformTenantSite.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(parsed.error.flatten().fieldErrors)) if (v) fieldErrors[k] = v;
    return { ok: false, error: "Datos inválidos", fieldErrors };
  }
  const { tenantId, expectedUpdatedAt, siteEnabled, palette } = parsed.data;
  const expected = new Date(expectedUpdatedAt);

  const res = await prismaService.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Tenant" WHERE "id" = ${tenantId} FOR UPDATE`;
    if (locked.length === 0) return { ok: false as const, reason: "not-found" as const };
    const cur = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { slug: true, siteEnabled: true, palette: true, updatedAt: true },
    });
    if (cur.updatedAt.getTime() !== expected.getTime()) return { ok: false as const, reason: "stale" as const };
    const siteChanged = siteEnabled !== undefined && cur.siteEnabled !== siteEnabled;
    const paletteChanged = palette !== undefined && cur.palette !== palette;
    if (!siteChanged && !paletteChanged) {
      return { ok: true as const, changed: false, paletteChanged: false, slug: cur.slug, updatedAt: cur.updatedAt };
    }
    const now = new Date();
    // Estrictamente mayor que el anterior: dos writes en el mismo ms dejarían pasar un CAS viejo (tenant-profile-internal).
    const updatedAt = new Date(Math.max(now.getTime(), cur.updatedAt.getTime() + 1));
    await tx.tenant.update({
      where: { id: tenantId },
      data: {
        ...(siteChanged ? { siteEnabled, ...(siteEnabled ? { siteEnabledAt: now } : {}) } : {}),
        ...(paletteChanged ? { palette } : {}),
        updatedAt,
      },
      select: { id: true },
    });
    // Solo lo que cambió, con antes y después (la paleta no es PII: el valor ayuda a soporte a ver qué se asignó).
    const changed: string[] = [];
    const before: Record<string, string | boolean> = {};
    const after: Record<string, string | boolean> = {};
    if (siteChanged && siteEnabled !== undefined) {
      changed.push("siteEnabled");
      before.siteEnabled = cur.siteEnabled;
      after.siteEnabled = siteEnabled;
    }
    if (paletteChanged && palette !== undefined) {
      changed.push("palette");
      before.palette = cur.palette;
      after.palette = palette;
    }
    await auditPlatformInTx(tx, {
      actor: { userId: actor.userId, email: actor.email, homeTenantId: actor.homeTenantId },
      affectedTenantId: tenantId,
      action: "platform.tenant.site",
      entity: "Tenant",
      entityId: tenantId,
      payload: { changed, before, after },
    });
    return { ok: true as const, changed: true, paletteChanged, slug: cur.slug, updatedAt };
  });

  if (!res.ok) {
    return {
      ok: false,
      error:
        res.reason === "stale"
          ? "Otro cambio se guardó antes. Recargá y revisá."
          : "No encontramos ese consultorio. Volvé a la lista.",
    };
  }
  if (res.changed) {
    revalidateTag(CLINIC_SITES_TAG);
    revalidateTag(tags.directory());
    revalidatePath(`/${res.slug}`);
    revalidatePath("/plataforma", "layout");
    if (res.paletteChanged) {
      revalidatePath(`/c/${res.slug}/booking`);
      revalidatePath("/", "layout");
    }
  }
  return { ok: true, data: { updatedAt: res.updatedAt.toISOString() } };
}
