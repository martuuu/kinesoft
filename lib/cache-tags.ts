/**
 * Centralised cache tag helpers.
 *
 * Two rules to keep tags coherent across the codebase:
 *
 *   1. **Tags are tenant-scoped** by default. `t(tenantId, "exercises")`
 *      → "tenant:abc:exercises". Mutations always include the tenant
 *      prefix so `revalidateTag` only invalidates the calling tenant.
 *
 *   2. **One tag per logical surface**, not per cache key. The
 *      `unstable_cache` key array (last param) is what disambiguates
 *      identical fetches with different args. The tag is what we wipe
 *      from a server action mutation.
 *
 * Usage:
 *
 *     const fetch = unstable_cache(
 *       async (tenantId, q) => prisma.exercise.findMany(...),
 *       ["exercises:list"],
 *       { tags: [tags.exercises(tenantId)], revalidate: 300 }
 *     );
 *
 *     // In the mutation:
 *     revalidateTag(tags.exercises(actor.tenantId));
 *
 * Global (non-tenant) tags are flat strings — used for the global
 * catalog tables that don't change per tenant (conditions, anatomy).
 */

const TENANT_PREFIX = "tenant:";

/**
 * PL-1a (C-PL2): catálogo público de planes SaaS (`getPublicPlanCatalog`, landing y /precios). Global: los precios y
 * cupos de `SaasPlanConfig` son los mismos para todos. Lo revalida quien edita precios o límites en /plataforma
 * (PL-2c) y el cron que aplica un precio con vigencia (PL-D8), después del commit.
 */
export const SAAS_PLANS_TAG = "saas-plans";

function t(tenantId: string, surface: string) {
  return `${TENANT_PREFIX}${tenantId}:${surface}`;
}

export const tags = {
  // tenant-scoped surfaces
  services: (tenantId: string) => t(tenantId, "services"),
  insurers: (tenantId: string) => t(tenantId, "insurers"),
  exercises: (tenantId: string) => t(tenantId, "exercises"),
  exerciseFacets: (tenantId: string) => t(tenantId, "exercise-facets"),
  dashboard: (tenantId: string) => t(tenantId, "dashboard"),
  bookingDays: (tenantId: string) => t(tenantId, "booking-days"),
  practitioners: (tenantId: string) => t(tenantId, "practitioners"),
  conditions: (tenantId: string) => t(tenantId, "conditions"),

  // global (non-tenant) — catalog never changes per tenant
  catalog: () => "global:catalog",
  anatomy: () => "global:anatomy",
  saasPlans: () => SAAS_PLANS_TAG,
} as const;

/**
 * Tags que dependen de los entitlements de un consultorio (EV0, C-EV7):
 * vertical, plan y switch del turnero deciden qué ejercicios ve (propios vs
 * catálogo global), sus facetas, el dashboard y las condiciones. El caller de
 * `applyTenantEntitlementsInTx` los revalida DESPUÉS del commit (adentro de la
 * tx, un rollback dejaría el cache invalidado contra datos viejos y otro
 * request lo volvería a llenar con el estado previo).
 *
 * `catalog()` es global: invalidarlo le cuesta un refetch a todos los tenants,
 * pero es raro (cambio de plan) y el scope del catálogo depende del plan.
 */
export function tenantEntitlementTags(tenantId: string): string[] {
  return [
    tags.exercises(tenantId),
    tags.exerciseFacets(tenantId),
    tags.dashboard(tenantId),
    tags.conditions(tenantId),
    tags.catalog(),
  ];
}

/**
 * Cache TTL presets (seconds). Names map to logical staleness budget:
 *   - micro:   one minute, "near-realtime" dashboards
 *   - short:   five minutes, lookup tables that change with mutations
 *   - long:    one hour, catalog data that almost never changes
 *   - day:     24 hours, immutable references (anatomy regions)
 */
export const ttl = {
  micro: 60,
  short: 300,
  long: 3_600,
  day: 86_400,
} as const;
