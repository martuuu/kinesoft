import "server-only";

import { withTenantDb, type DbClient } from "@/lib/rls";

/**
 * Normalize a free-form obra-social name and dedup it against the tenant
 * Insurer catalogue. Trims + collapses internal whitespace; if the result
 * case-insensitively matches an existing Insurer, returns that row's id +
 * canonical name so the Coverage LINKS to the catalogue instead of storing a
 * near-duplicate string ("OSDE" vs "osde" vs "  OSDE "). Otherwise returns the
 * cleaned free-form name with a null insurerId.
 *
 * Pass `tx` to run inside a transaction (coverage writes do).
 */
export async function resolveInsurerName(
  tenantId: string,
  raw: string,
  tx?: DbClient
): Promise<{ insurerId: string | null; name: string }> {
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name) return { insurerId: null, name: "" };
  // Insurer is RLS-governed (Ola B2): self-prime a tenant tx when called
  // standalone; reuse the caller's `tx` when threaded from a coverage write.
  const match = await withTenantDb(tenantId, tx, (c) =>
    c.insurer.findFirst({
      where: { tenantId, name: { equals: name, mode: "insensitive" } },
      select: { id: true, name: true },
    })
  );
  return match ? { insurerId: match.id, name: match.name } : { insurerId: null, name };
}
