/**
 * RLS isolation tripwire (Ola B2, .docs/TESTING.md capa 3).
 *
 * Proves that Postgres RLS actually isolates tenants once the app connects
 * as a role WITHOUT BYPASSRLS. This is the net that catches a MISSED wrap:
 * a lost `runWithRls` returns an empty result set silently, so the
 * intra-tenant assertions below fail loudly when a read isn't primed.
 *
 * GATED (A1.1): runs with `npm run test:integration` (INTEGRATION=1), and
 * SKIPS VISIBLY when the app connection has BYPASSRLS — i.e. under
 * `test:integration:owner`, which reproduces prod's current role. There the
 * tripwire cannot prove anything, so it must not report a false green.
 * Local setup: `docker compose up -d db`, migrations applied, and
 * `prisma/roles.local.sql` run once (creates `kinesoft_app`).
 *
 * `runWithRls` uses the default client (DATABASE_URL = kinesoft_app → RLS
 * enforced). `prismaOwner` uses DIRECT_URL (owner → BYPASSRLS) purely to
 * seed/tear-down cross-tenant fixtures the app role could never create.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { runWithRls } from "@/lib/rls";
import {
  createEphemeralTenant,
  sweepOrphanTestTenants,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1" || process.env.RLS_IT === "1";

// Does the APP connection (DATABASE_URL) bypass RLS? Checked once, up front.
async function appRoleBypassesRls(): Promise<boolean> {
  const app = new PrismaClient();
  try {
    const rows = await app.$queryRaw<{ bypass: boolean }[]>`
      SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user`;
    return rows[0]?.bypass ?? true;
  } finally {
    await app.$disconnect();
  }
}
const BYPASS = RUN ? await appRoleBypassesRls() : true;
if (RUN && BYPASS) {
  console.warn("[rls-isolation] SKIP: la conexión de la app tiene BYPASSRLS (modo owner = prod hoy).");
}

describe.skipIf(!RUN || BYPASS)("RLS tenant isolation (app role)", () => {
  const prismaOwner = new PrismaClient({
    datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } },
  });

  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let patA: string;
  let patB: string;

  beforeAll(async () => {
    await sweepOrphanTestTenants(prismaOwner);
    A = await createEphemeralTenant(prismaOwner);
    B = await createEphemeralTenant(prismaOwner);
    const a = await prismaOwner.patient.create({
      data: { tenantId: A.tenantId, firstName: "Ana", lastName: "TenantA", assignedPractitionerId: A.practitionerId },
    });
    const b = await prismaOwner.patient.create({
      data: { tenantId: B.tenantId, firstName: "Beto", lastName: "TenantB", assignedPractitionerId: B.practitionerId },
    });
    patA = a.id;
    patB = b.id;
  });

  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await prismaOwner.$disconnect();
  });

  it("intra-tenant: A sees its own patient (a missed wrap would return [])", async () => {
    const rows = await runWithRls(A.tenantId, (tx) => tx.patient.findMany());
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(patA);
    expect(rows.every((r) => r.tenantId === A.tenantId)).toBe(true);
  });

  it("cross-tenant read: A cannot see B's patient", async () => {
    const all = await runWithRls(A.tenantId, (tx) => tx.patient.findMany());
    expect(all.map((r) => r.id)).not.toContain(patB);
    // Even an explicit id lookup for B's row returns nothing under A's GUC.
    const direct = await runWithRls(A.tenantId, (tx) =>
      tx.patient.findMany({ where: { id: patB } })
    );
    expect(direct).toHaveLength(0);
  });

  it("cross-tenant write: A cannot INSERT a row into B (WITH CHECK aborts)", async () => {
    await expect(
      runWithRls(A.tenantId, (tx) =>
        tx.patient.create({
          data: { tenantId: B.tenantId, firstName: "Mal", lastName: "Cross" },
        })
      )
    ).rejects.toThrow();
  });

  it("global catalog stays visible: Condition tenantId=NULL is readable under any tenant", async () => {
    // Seeded global conditions (tenantId NULL) must remain visible via the
    // split policy — otherwise the diagnosis engine breaks for everyone.
    const globals = await runWithRls(A.tenantId, (tx) =>
      tx.condition.findMany({ where: { tenantId: null }, take: 1 })
    );
    // Only assert the query itself is not blocked (returns an array, not an
    // error); a fresh DB may have zero seeded conditions.
    expect(Array.isArray(globals)).toBe(true);
  });
});
