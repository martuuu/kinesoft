/**
 * BO3-E · visor del registro de Plataforma (`listPlatformAudit`, `lib/platform-audit-read.ts`) contra Postgres real,
 * con los dos roles (`test:integration` = kinesoft_app; `:owner` = BYPASSRLS = prod). Símbolo real; solo se mockea
 * la sesión de Supabase (`asUser`) y `next/cache`.
 *
 * Se fija:
 *   - filtros por acción (prefijo), consultorio, email del actor, usuario afectado y días AR;
 *   - cursor `(createdAt, id)`: 55 filas → 50 + 5, sin repetir ni saltear, aun con timestamps empatados;
 *   - un no superadmin rebota con `ForbiddenError`;
 *   - un payload con PHI no sale: solo claves (y valores de la allowlist).
 *
 * Aislamiento: todas las filas llevan la acción `platform.test<sufijo>.*` y cada consulta filtra por ese prefijo, así
 * el registro real de la base local no ensucia los conteos. `PlatformAuditEvent` es solo inserción: la limpieza usa el
 * modo réplica, como `platform-audit.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { ForbiddenError } from "@/lib/session";
import { listPlatformAudit } from "@/lib/platform-audit-read";
import { asUser } from "@/tests/helpers/actor";
import { ownerClient, createEphemeralTenant, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("[BO3-E] listPlatformAudit · filtros, cursor, barrera y sin PHI", () => {
  let db: PrismaClient;
  let superId: string;
  let A: EphemeralTenant;
  const prefix = `platform.test${uniqueSuffix().replace(/[^a-z0-9]/gi, "")}`;
  const superEmail = () => `${superId}@test.local`;

  // 13-oct 23:30 AR = 14-oct 02:30 UTC: cae en el día AR 13 (en UTC sería el 14).
  const LATE_AR_13 = new Date("2026-10-14T02:30:00.000Z");
  const PHI = { email: "juana.paciente@test.local", reason: "Juana Pérez, hernia L4-L5", dni: "30111222" };

  beforeAll(async () => {
    db = ownerClient();
    superId = `test-user-${uniqueSuffix()}`;
    await db.userProfile.create({
      data: { id: superId, email: `${superId}@test.local`, fullName: "Super BO3E", isPlatformAdmin: true },
    });
    A = await createEphemeralTenant(db);

    // 55 filas «bulk» en el día AR 2026-10-10, de a pares con el MISMO createdAt (prueba el desempate por id).
    const base = Date.parse("2026-10-10T15:00:00.000Z");
    const bulk = Array.from({ length: 55 }, (_, i) => ({
      action: `${prefix}.bulk`,
      actorId: superId,
      actorEmail: superEmail(),
      entity: "Test",
      entityId: `bulk-${i}`,
      createdAt: new Date(base - Math.floor(i / 2) * 1000),
    }));
    await db.platformAuditEvent.createMany({ data: bulk });

    await db.platformAuditEvent.create({
      data: {
        action: `${prefix}.tenant.status`,
        actorId: superId,
        actorEmail: "Otro.Super@Test.Local",
        tenantId: A.tenantId,
        targetUserId: A.userId,
        entity: "Tenant",
        entityId: A.tenantId,
        payload: { ...PHI, changed: ["status"], before: { status: "ACTIVE" }, after: { status: "SUSPENDED" } },
        ip: "203.0.113.9",
        userAgent: "UA-SECRETO",
        createdAt: LATE_AR_13,
      },
    });
  });

  afterAll(async () => {
    if (!db) return;
    await db.$transaction([
      db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
      db.$executeRaw`DELETE FROM "PlatformAuditEvent" WHERE "action" LIKE ${prefix + ".%"}`,
    ]);
    await A?.cleanup();
    await db.userProfile.deleteMany({ where: { id: superId } });
    await db.$disconnect();
  });

  it("[BO3-E] no superadmin → ForbiddenError", async () => {
    asUser(A.userId);
    await expect(listPlatformAudit({ action: prefix })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("[BO3-E] cursor: 56 filas del prefijo → 50 + 6, orden desc, sin repetidas ni salteadas", async () => {
    asUser(superId);
    const p1 = await listPlatformAudit({ action: prefix });
    expect(p1.rows).toHaveLength(50);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await listPlatformAudit({ action: prefix, cursor: p1.nextCursor! });
    expect(p2.rows).toHaveLength(6);
    expect(p2.nextCursor).toBeNull();

    const all = [...p1.rows, ...p2.rows];
    expect(new Set(all.map((r) => r.id)).size).toBe(56);
    // La más nueva es la del 13-oct AR (14-oct UTC).
    expect(all[0].action).toBe(`${prefix}.tenant.status`);
    for (let i = 1; i < all.length; i++) {
      const prev = all[i - 1];
      const cur = all[i];
      const ok = prev.createdAt > cur.createdAt || (prev.createdAt === cur.createdAt && prev.id > cur.id);
      expect(ok, `${prev.createdAt}/${prev.id} → ${cur.createdAt}/${cur.id}`).toBe(true);
    }
  });

  it("[BO3-E] filtros: acción exacta, consultorio, email (sin mayúsculas), usuario afectado", async () => {
    asUser(superId);
    const byAction = await listPlatformAudit({ action: `${prefix}.tenant.status` });
    expect(byAction.rows.map((r) => r.action)).toEqual([`${prefix}.tenant.status`]);

    const byTenant = await listPlatformAudit({ action: prefix, tenantId: A.tenantId });
    expect(byTenant.rows).toHaveLength(1);
    expect(byTenant.rows[0].tenant).toEqual({ id: A.tenantId, name: expect.any(String) });

    const byEmail = await listPlatformAudit({ action: prefix, actorEmail: "otro.super@test" });
    expect(byEmail.rows).toHaveLength(1);

    const byTarget = await listPlatformAudit({ action: prefix, targetUserId: A.userId });
    expect(byTarget.rows).toHaveLength(1);
    expect(byTarget.rows[0].targetUserId).toBe(A.userId);
  });

  it("[BO3-E] fechas en día AR: el 13 AR incluye las 23:30 AR (14 UTC); el 14 AR no la trae", async () => {
    asUser(superId);
    const d13 = await listPlatformAudit({ action: prefix, from: "2026-10-13", to: "2026-10-13" });
    expect(d13.rows.map((r) => r.action)).toEqual([`${prefix}.tenant.status`]);
    const d14 = await listPlatformAudit({ action: prefix, from: "2026-10-14", to: "2026-10-14" });
    expect(d14.rows).toHaveLength(0);
    const d10 = await listPlatformAudit({ action: prefix, from: "2026-10-10", to: "2026-10-10" });
    expect(d10.rows).toHaveLength(50);
    expect(d10.nextCursor).toBeTruthy();
  });

  it("[BO3-E] payload con PHI: salen las claves, no los valores; tampoco IP ni user agent", async () => {
    asUser(superId);
    const { rows } = await listPlatformAudit({ action: `${prefix}.tenant.status` });
    const json = JSON.stringify(rows);
    for (const leak of ["juana.paciente", "Juana", "hernia", "30111222", "203.0.113.9", "UA-SECRETO"]) {
      expect(json, leak).not.toContain(leak);
    }
    expect(Object.keys(rows[0]).sort()).toEqual(
      ["action", "actorEmail", "createdAt", "id", "payload", "targetUserId", "tenant"].sort()
    );
    const byKey = Object.fromEntries(rows[0].payload.map((p) => [p.key, p.value]));
    expect(byKey).toMatchObject({
      email: null,
      reason: null,
      dni: null,
      changed: "status",
      "before.status": "ACTIVE",
      "after.status": "SUSPENDED",
    });
  });
});
