import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

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
  tx?: Prisma.TransactionClient
): Promise<{ insurerId: string | null; name: string }> {
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name) return { insurerId: null, name: "" };
  const client = tx ?? prisma;
  const match = await client.insurer.findFirst({
    where: { tenantId, name: { equals: name, mode: "insensitive" } },
    select: { id: true, name: true },
  });
  return match ? { insurerId: match.id, name: match.name } : { insurerId: null, name };
}
