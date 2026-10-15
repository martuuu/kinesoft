/**
 * BO3-E (handoff de BO3-A) · «crear categoría» desde el editor de ejercicios de Plataforma (`ensurePlatformTag`,
 * `lib/tags-admin.ts`), contra Postgres real y con los dos roles. Símbolo real; solo se mockea la sesión.
 *
 * El bug: el drawer llamaba a `ensureTag` (`lib/exercises.ts`), que pasa por `getActor`: un superadmin SIN
 * consultorio propio no tiene Actor y no podía crear un tag desde /plataforma/ejercicios. Se fija:
 *   - el superadmin sin consultorio crea el tag (GOAL) y queda UNA fila en `PlatformAuditEvent` (tenantId null);
 *   - repetirlo es idempotente: devuelve el existente y NO audita de nuevo;
 *   - los slugs de disciplina siguen reservados;
 *   - un no superadmin rebota con `ForbiddenError` y no escribe nada;
 *   - control: `ensureTag` del consultorio sigue tirando para ese superadmin (por eso el drawer ya no lo usa).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { ForbiddenError } from "@/lib/session";
import { ensurePlatformTag } from "@/lib/tags-admin";
import { ensureTag } from "@/lib/exercises";
import { asUser } from "@/tests/helpers/actor";
import { ownerClient, createEphemeralTenant, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("[BO3-E] superadmin sin consultorio crea tag desde el drawer", () => {
  let db: PrismaClient;
  let superId: string;
  let A: EphemeralTenant;
  const slugs: string[] = [];

  beforeAll(async () => {
    db = ownerClient();
    superId = `test-user-${uniqueSuffix()}`;
    await db.userProfile.create({
      data: { id: superId, email: `${superId}@test.local`, fullName: "Super Sin Consultorio", isPlatformAdmin: true },
    });
    A = await createEphemeralTenant(db);
  });

  afterAll(async () => {
    if (!db) return;
    await db.tag.deleteMany({ where: { slug: { in: slugs } } });
    await db.$transaction([
      db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
      db.$executeRaw`DELETE FROM "PlatformAuditEvent" WHERE "actorId" = ANY(${[superId, A.userId]})`,
    ]);
    await A?.cleanup();
    await db.userProfile.deleteMany({ where: { id: superId } });
    await db.$disconnect();
  });

  it("[BO3-E] crea el tag GOAL, audita una vez en el registro global y repetir es idempotente", async () => {
    asUser(superId);
    const label = `Movilidad BO3E ${uniqueSuffix()}`;
    const r = await ensurePlatformTag(label);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    slugs.push(r.data.slug);
    expect(r.data.label).toBe(label);

    const row = await db.tag.findUniqueOrThrow({ where: { slug: r.data.slug } });
    expect(row.kind).toBe("GOAL");

    const again = await ensurePlatformTag(`  ${label}  `);
    expect(again).toEqual({ ok: true, data: { slug: r.data.slug, label } });

    const audits = await db.platformAuditEvent.findMany({ where: { actorId: superId, entityId: r.data.slug } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "platform.catalog.tag.create", entity: "Tag", tenantId: null });
    expect(audits[0].payload).toMatchObject({ kind: "GOAL", platform: { actorHomeTenantId: null } });
    expect(await db.auditEvent.count({ where: { actorId: superId } })).toBe(0);
  });

  it("[BO3-E] slugs de disciplina reservados y label vacío → error, sin escribir", async () => {
    asUser(superId);
    const before = await db.platformAuditEvent.count({ where: { actorId: superId } });
    expect((await ensurePlatformTag("Kinesiología")).ok).toBe(false);
    expect((await ensurePlatformTag("   ")).ok).toBe(false);
    expect((await ensurePlatformTag(42)).ok).toBe(false);
    expect(await db.platformAuditEvent.count({ where: { actorId: superId } })).toBe(before);
  });

  it("[BO3-E] no superadmin → ForbiddenError y no crea nada", async () => {
    asUser(A.userId);
    const label = `Ajeno BO3E ${uniqueSuffix()}`;
    await expect(ensurePlatformTag(label)).rejects.toBeInstanceOf(ForbiddenError);
    const slug = label.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    expect(await db.tag.findUnique({ where: { slug } })).toBeNull();
  });

  it("[BO3-E] control: ensureTag del consultorio sigue rechazando al superadmin sin consultorio", async () => {
    asUser(superId);
    await expect(ensureTag(`Control BO3E ${uniqueSuffix()}`)).rejects.toThrow();
  });
});
