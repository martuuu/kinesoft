import { existsSync, rmSync } from "node:fs";
import { deleteTenantDeep, ownerClient } from "../helpers/tenant-factory";
import { E2E_FIXTURE_FILE, E2E_USERS_FILE } from "./support/e2e-constants.mjs";
import { readFixture } from "./support/fixture";

/**
 * Borra el tenant efímero de la corrida con el teardown ordenado de la factory (HC incluida, en modo réplica local).
 * `E2E_KEEP_DATA=1` lo deja para mirar a mano un fallo (lo barre la próxima corrida a los 30').
 */
export default async function globalTeardown(): Promise<void> {
  if (!existsSync(E2E_FIXTURE_FILE) || process.env.E2E_KEEP_DATA === "1") return;
  const fx = readFixture();
  const db = ownerClient();
  try {
    await deleteTenantDeep(db, fx.tenantId);
    // La usuaria del portal no tiene Membership: `deleteTenantDeep` no la ve. Su paciente ya se borró con el tenant.
    await db.userProfile.deleteMany({ where: { id: fx.portal.userId } });
  } finally {
    await db.$disconnect();
  }
  rmSync(E2E_FIXTURE_FILE, { force: true });
  rmSync(E2E_USERS_FILE, { force: true });
}
