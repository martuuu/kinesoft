/**
 * BO3-E · `getPlatformSystemStatus` contra Postgres real, dos roles: la lectura de `_prisma_migrations` por el canal
 * service funciona (count > 0 y nombre con forma de migración), el ping es el mismo de /api/health y un no
 * superadmin rebota. La garantía de «sin secretos» está en el unit `platform-system.test.ts` (env marcado).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { ForbiddenError } from "@/lib/session";
import { getPlatformSystemStatus } from "@/lib/platform-system-read";
import { asUser } from "@/tests/helpers/actor";
import { ownerClient, createEphemeralTenant, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("[BO3-E] getPlatformSystemStatus", () => {
  let db: PrismaClient;
  let superId: string;
  let A: EphemeralTenant;

  beforeAll(async () => {
    db = ownerClient();
    superId = `test-user-${uniqueSuffix()}`;
    await db.userProfile.create({
      data: { id: superId, email: `${superId}@test.local`, fullName: "Super BO3E", isPlatformAdmin: true },
    });
    A = await createEphemeralTenant(db);
  });
  afterAll(async () => {
    if (!db) return;
    await A?.cleanup();
    await db.userProfile.deleteMany({ where: { id: superId } });
    await db.$disconnect();
  });

  it("[BO3-E] migraciones aplicadas y base OK", async () => {
    asUser(superId);
    const s = await getPlatformSystemStatus();
    const byKey = Object.fromEntries(s.groups.flatMap((g) => g.checks).map((c) => [c.key, c]));
    expect(byKey.health.state).toBe("ok");
    expect(byKey.migrations.state).toBe("value");
    expect(Number(byKey.migrations.value)).toBeGreaterThan(10);
    expect(byKey.migrations.detail).toMatch(/^Última: \d{14}_[a-z0-9_]+$/);
  });

  it("[BO3-E] no superadmin → ForbiddenError", async () => {
    asUser(A.userId);
    await expect(getPlatformSystemStatus()).rejects.toBeInstanceOf(ForbiddenError);
  });
});
