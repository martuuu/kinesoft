/**
 * Helper for running a tenant-scoped transaction with RLS enforced.
 *
 * Wraps a Prisma `$transaction` and sets the `app.current_tenant_id` GUC
 * so any RLS policy compiled by `prisma/migrations/policies.sql` sees the
 * active tenant. Use this for queries that absolutely must be governed by
 * RLS (eg. delete cascades or raw SQL); ordinary reads can keep using the
 * application-layer filter from `lib/db.ts#getTenantPrisma`.
 *
 * Example:
 *
 *     await runWithRls(tenantId, async (tx) => {
 *       return tx.patient.findMany({});
 *     });
 */
import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";

export async function runWithRls<T>(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    // `set_config('app.current_tenant_id', $1, true)` — `true` makes it
    // local to the transaction, so the GUC is automatically reset when
    // the connection returns to the pool.
    await tx.$executeRawUnsafe(
      `SELECT set_config('app.current_tenant_id', $1, true)`,
      tenantId
    );
    return fn(tx);
  });
}
