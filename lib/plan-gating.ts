/**
 * Plan gating — single source of truth for what each subscription tier
 * can see and do.
 *
 * The product rule:
 *   - **FREE / STARTER**: only see exercises flagged `isBasic = true`
 *     (the curated tiny "starter library") + any exercises the tenant
 *     created itself.
 *   - **PRO / ENTERPRISE**: full global catalog (`tenantId IS NULL`) +
 *     own tenant-private exercises.
 *
 * Other capabilities differentiate similarly: templates/favourites are
 * locked on FREE; STARTER+ unlocks them.
 *
 * Everything goes through `gatingForActor()` so the rules can evolve in
 * one place without hunting through the codebase.
 */
import type { Prisma, TenantPlan } from "@prisma/client";
import { withTenantDb, type DbClient } from "@/lib/rls";
import { getActor } from "@/lib/session";

export type ExerciseCapabilities = {
  plan: TenantPlan;
  /** Prisma where fragment to OR into any Exercise query. */
  visibility: Prisma.ExerciseWhereInput;
  /** Whether the tenant can create custom exercises. Always true today. */
  canCreate: boolean;
  /** Whether the tenant can mark exercises as favourites. */
  canFavourite: boolean;
  /** Whether the tenant can build / apply plan templates. */
  canBuildTemplates: boolean;
  /** Whether the tenant can see globally-managed exercises with videos. */
  hasFullCatalog: boolean;
};

const FULL_CATALOG_PLANS: TenantPlan[] = ["PRO", "ENTERPRISE"];
const TEMPLATES_PLANS: TenantPlan[] = ["STARTER", "PRO", "ENTERPRISE"];

export async function gatingForActor(db?: DbClient): Promise<ExerciseCapabilities> {
  const actor = await getActor();
  const tenant = await withTenantDb(actor.tenantId, db, (c) =>
    c.tenant.findUnique({
      where: { id: actor.tenantId },
      select: { plan: true },
    })
  );
  return resolveCapabilities(tenant?.plan ?? "FREE", actor.tenantId);
}

export function resolveCapabilities(
  plan: TenantPlan,
  tenantId: string
): ExerciseCapabilities {
  const hasFullCatalog = FULL_CATALOG_PLANS.includes(plan);
  const visibility: Prisma.ExerciseWhereInput = {
    OR: [
      // Always: this tenant's private exercises
      { tenantId },
      // FREE/STARTER: only the basic curated subset of the global catalog
      // PRO/ENTERPRISE: anything tenant-less (i.e. the full global catalog)
      hasFullCatalog ? { tenantId: null } : { tenantId: null, isBasic: true },
    ],
  };
  return {
    plan,
    visibility,
    canCreate: true,
    canFavourite: plan !== "FREE",
    canBuildTemplates: TEMPLATES_PLANS.includes(plan),
    hasFullCatalog,
  };
}
