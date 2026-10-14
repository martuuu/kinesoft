/**
 * BO1-A · actor de plataforma (C-BO2, plan §19.1 «el superadmin necesita un consultorio casa» y §19.5).
 *
 * Símbolos REALES: `requirePlatformAdmin` (lib/platform-actor.ts) y el alias deprecado `requireSuperAdmin`
 * (lib/session.ts) contra Postgres en los dos roles. Se mockea solo la sesión de Supabase (integration-setup).
 * El rate limit corre en memoria (`.env.local` no trae Upstash).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { ForbiddenError, UnauthenticatedError, requireSuperAdmin } from "@/lib/session";
import {
  PLATFORM_ACTION_POLICY,
  PLATFORM_MFA_ENFORCED,
  PlatformRateLimitedError,
  requirePlatformAdmin,
} from "@/lib/platform-actor";
import { asAnonymous, asUser } from "@/tests/helpers/actor";
import { ownerClient, createEphemeralTenant, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("[BO1-A] requirePlatformAdmin", () => {
  let db: PrismaClient;
  const tenants: EphemeralTenant[] = [];
  const users: string[] = [];

  beforeAll(async () => {
    db = ownerClient();
  });

  afterAll(async () => {
    for (const t of tenants) await t.cleanup();
    if (db) {
      if (users.length) await db.userProfile.deleteMany({ where: { id: { in: users } } });
      await db.$disconnect();
    }
  });

  async function superadmin(o: { disabled?: boolean } = {}): Promise<string> {
    const id = `test-user-${uniqueSuffix()}`;
    await db.userProfile.create({
      data: {
        id,
        email: `${id}@test.local`,
        fullName: "Super Admin",
        isPlatformAdmin: true,
        disabledAt: o.disabled ? new Date() : null,
      },
    });
    users.push(id);
    return id;
  }

  // Arrancó como `it.fails` con `requireSuperAdmin()` (pasa por `buildActor`: un superadmin sin membresía tiraba
  // `UnauthenticatedError` y no llegaba a /plataforma). Se dio vuelta con `requirePlatformAdmin`.
  it("[BO1-A] superadmin sin consultorio no llega a /plataforma", async () => {
    const u = await superadmin();
    asUser(u);
    await expect(requirePlatformAdmin()).resolves.toEqual({ userId: u, email: `${u}@test.local`, homeTenantId: null });
    await expect(requirePlatformAdmin("platform.read")).resolves.toMatchObject({ userId: u, homeTenantId: null });
    // El alias deprecado delega el chequeo pero sigue armando un Actor: sin consultorio todavía no alcanza (BO2-F lo
    // retira de los módulos de catálogo).
    await expect(requireSuperAdmin()).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("superadmin con consultorio: homeTenantId = su consultorio, y el alias devuelve el Actor de siempre", async () => {
    const t = await createEphemeralTenant(db);
    tenants.push(t);
    await db.userProfile.update({ where: { id: t.userId }, data: { isPlatformAdmin: true } });
    asUser(t.userId);
    await expect(requirePlatformAdmin()).resolves.toMatchObject({ userId: t.userId, homeTenantId: t.tenantId });
    await expect(requireSuperAdmin()).resolves.toMatchObject({ tenantId: t.tenantId, isPlatformAdmin: true });
  });

  it("superadmin con su consultorio SUSPENDED igual entra a Plataforma (homeTenantId null)", async () => {
    const t = await createEphemeralTenant(db, { status: "SUSPENDED" });
    tenants.push(t);
    await db.userProfile.update({ where: { id: t.userId }, data: { isPlatformAdmin: true } });
    asUser(t.userId);
    await expect(requirePlatformAdmin()).resolves.toMatchObject({ userId: t.userId, homeTenantId: null });
  });

  it("sin sesión → UnauthenticatedError; no superadmin → ForbiddenError", async () => {
    asAnonymous();
    await expect(requirePlatformAdmin()).rejects.toBeInstanceOf(UnauthenticatedError);
    const t = await createEphemeralTenant(db);
    tenants.push(t);
    asUser(t.userId);
    await expect(requirePlatformAdmin()).rejects.toBeInstanceOf(ForbiddenError);
    await expect(requireSuperAdmin()).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("superadmin deshabilitado (UserProfile.disabledAt) → ForbiddenError, también por el alias", async () => {
    const u = await superadmin({ disabled: true });
    asUser(u);
    await expect(requirePlatformAdmin()).rejects.toBeInstanceOf(ForbiddenError);
    await expect(requireSuperAdmin()).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("acción fuera de la política → falla cerrado", async () => {
    const u = await superadmin();
    asUser(u);
    await expect(requirePlatformAdmin("tenant.borrar_todo")).rejects.toMatchObject({ reason: "unknown_platform_action" });
  });

  it("rate limit por superadmin y acción: el (limit+1)-ésimo llamado tira PlatformRateLimitedError", async () => {
    const u = await superadmin();
    const other = await superadmin();
    const { limit } = PLATFORM_ACTION_POLICY["user.superadmin.update"].rateLimit;
    asUser(u);
    for (let i = 0; i < limit; i++) await requirePlatformAdmin("user.superadmin.update");
    const err = await requirePlatformAdmin("user.superadmin.update").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlatformRateLimitedError);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as Error).message).toMatch(/Demasiados intentos/);
    // Otra acción y otro superadmin no comparten el cupo.
    await expect(requirePlatformAdmin("platform.read")).resolves.toMatchObject({ userId: u });
    asUser(other);
    await expect(requirePlatformAdmin("user.superadmin.update")).resolves.toMatchObject({ userId: other });
  });

  it("toda acción tiene riesgo y rate limit; MFA queda apagado hasta BO4", () => {
    for (const [key, p] of Object.entries(PLATFORM_ACTION_POLICY)) {
      expect(["low", "medium", "high"], key).toContain(p.risk);
      expect(p.rateLimit.limit, key).toBeGreaterThan(0);
      expect(p.rateLimit.windowMs, key).toBeGreaterThan(0);
    }
    expect(PLATFORM_MFA_ENFORCED).toBe(false);
  });
});
