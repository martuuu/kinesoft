/**
 * Helper for running a tenant-scoped transaction with RLS enforced.
 *
 * Wraps a Prisma `$transaction` and sets the `app.current_tenant_id` GUC
 * so any RLS policy compiled by `prisma/migrations/policies.sql` sees the
 * active tenant. Because prod uses Supavisor transaction-mode pooling, the
 * GUC MUST be transaction-local — so EVERY RLS-governed read and write has
 * to run inside a `runWithRls` transaction. This is the sole GUC setter.
 *
 * Example:
 *
 *     await runWithRls(tenantId, async (tx) => {
 *       return tx.patient.findMany({});
 *     });
 */
import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";

/**
 * A Prisma client usable for tenant-scoped work: either the base client
 * (`prisma`) or a `$transaction` client (`tx`). `Prisma.TransactionClient`
 * is the common surface — the base `PrismaClient` is assignable to it.
 */
export type DbClient = Prisma.TransactionClient;

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

/**
 * Thread-or-prime helper for SHARED functions that run either standalone
 * (server component / `unstable_cache` body) or inside an existing
 * `runWithRls` transaction:
 *
 *   - Pass the caller's `tx` as `db` when already inside a transaction —
 *     the query joins that transaction (avoids nesting, which Prisma
 *     forbids and which would throw even on the current bypass role).
 *   - Pass `undefined` (the default) to open a fresh tenant-scoped
 *     transaction here.
 *
 * This keeps Phase-1 wrapping inert on the bypass role: a standalone call
 * opens exactly one transaction; an in-tx call reuses the caller's.
 */
export async function withTenantDb<T>(
  tenantId: string,
  db: DbClient | undefined,
  fn: (db: DbClient) => Promise<T>
): Promise<T> {
  return db ? fn(db) : runWithRls(tenantId, fn);
}
