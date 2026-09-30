import { PrismaClient } from "@prisma/client";

/**
 * Does the APP connection (DATABASE_URL) bypass RLS? `test:integration` runs
 * with `kinesoft_app` (false); `test:integration:owner` with the owner (true,
 * = prod today). Some behaviors legitimately differ between the two — e.g.
 * under RLS Postgres hides which unique index a P2002 violated
 * (`meta.target === null`) — so a few tests branch on it.
 */
export async function appRoleBypassesRls(): Promise<boolean> {
  const app = new PrismaClient();
  try {
    const rows = await app.$queryRaw<{ bypass: boolean }[]>`
      SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user`;
    return rows[0]?.bypass ?? true;
  } finally {
    await app.$disconnect();
  }
}
