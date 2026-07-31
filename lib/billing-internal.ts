import "server-only";

import { withTenantDb, type DbClient } from "@/lib/rls";

// Pure copago logic lives in a framework-free module so it can be unit-tested;
// re-exported here so existing callers keep importing from billing-internal.
export { resolveBookingCopagoCents } from "@/lib/copago";

/**
 * The tenant's "Particular" (out-of-pocket) copago in cents — what a patient
 * WITHOUT an obra social is charged per session. "Particular" is a real
 * per-tenant `Insurer` row (`isParticular = true`); the practitioner sets its
 * price in /configuracion → Obras Sociales.
 *
 * Returns the configured copago **as set, including 0** (0 means "charge
 * nothing" — that's a valid, intentional value). Returns `null` only when the
 * tenant has no Particular row at all; callers then fall back to the service
 * price.
 */
export async function getParticularCopagoCents(
  tenantId: string,
  db?: DbClient
): Promise<number | null> {
  const ins = await withTenantDb(tenantId, db, (c) =>
    c.insurer.findFirst({
      where: { tenantId, isParticular: true },
      select: { copagoCents: true },
    })
  );
  return ins ? ins.copagoCents : null;
}

