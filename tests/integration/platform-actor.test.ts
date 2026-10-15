/**
 * BO1-A · actor de plataforma (C-BO2, plan §19.1 «el superadmin necesita un consultorio casa» y §19.5).
 *
 * Símbolo REAL: `requirePlatformAdmin` (lib/platform-actor.ts) contra Postgres en los dos roles (el alias deprecado
 * `requireSuperAdmin` de lib/session.ts se borró en EV1-E2: no lo usaba nadie más que este test).
 * Se mockea solo la sesión de Supabase (integration-setup).
 * El rate limit corre en memoria (`.env.local` no trae Upstash).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

// PL-Z (a2#4): con MFA != enforce, las acciones `high` piden el step-up de la 2FA por usuario (`requireStepUp`). Acá
// corre el REAL salvo en los tests que prueban otra cosa (rate limit, soporte con off), que lo dan por hecho con
// `stepUp.pass = true`. El step-up con 2FA y cookie de verdad se prueba en two-factor.test.ts («Plataforma»).
const stepUp = vi.hoisted(() => ({ pass: false, calls: 0 }));
vi.mock("@/lib/two-factor-step-up", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/two-factor-step-up")>();
  return {
    ...real,
    requireStepUp: async (a: { userId: string }) => {
      stepUp.calls++;
      if (!stepUp.pass) await real.requireStepUp(a);
    },
  };
});
import { cookies } from "next/headers";
import type { PrismaClient } from "@prisma/client";
import { ForbiddenError, UnauthenticatedError } from "@/lib/session";
import {
  PLATFORM_ACTION_POLICY,
  PlatformMfaRequiredError,
  PlatformRateLimitedError,
  PlatformReauthRequiredError,
  requirePlatformAdmin,
} from "@/lib/platform-actor";
import { __setPlatformMfaForTests } from "@/lib/platform-mfa";
import { PLATFORM_REAUTH_COOKIE, makePlatformReauthValue } from "@/lib/platform-reauth";
import { PLATFORM_ERROR_DIGEST, PLATFORM_REAUTH_TTL_S } from "@/lib/platform-mfa-logic";
import { classifyStepUpError } from "@/lib/two-factor-logic";
import { PlatformMfaFake } from "@/tests/helpers/platform-mfa-fake";
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
    await expect(requirePlatformAdmin()).resolves.toEqual({ userId: u, email: `${u}@test.local`, homeTenantId: null, mfa: false });
    await expect(requirePlatformAdmin("platform.read")).resolves.toMatchObject({ userId: u, homeTenantId: null });
  });

  it("superadmin con consultorio: homeTenantId = su consultorio", async () => {
    const t = await createEphemeralTenant(db);
    tenants.push(t);
    await db.userProfile.update({ where: { id: t.userId }, data: { isPlatformAdmin: true } });
    asUser(t.userId);
    await expect(requirePlatformAdmin()).resolves.toMatchObject({ userId: t.userId, homeTenantId: t.tenantId });
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
  });

  it("superadmin deshabilitado (UserProfile.disabledAt) → ForbiddenError", async () => {
    const u = await superadmin({ disabled: true });
    asUser(u);
    await expect(requirePlatformAdmin()).rejects.toBeInstanceOf(ForbiddenError);
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
    stepUp.pass = true;
    asUser(u);
    for (let i = 0; i < limit; i++) await requirePlatformAdmin("user.superadmin.update");
    const err = await requirePlatformAdmin("user.superadmin.update").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlatformRateLimitedError);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as Error).message).toMatch(/Demasiados intentos\. Probá de nuevo en \d+ s\./);
    // BO4: en prod Next tapa el mensaje; el digest lleva los segundos para que la UI arme el mismo copy.
    expect((err as { digest?: string }).digest).toMatch(new RegExp(`^${PLATFORM_ERROR_DIGEST.rateLimited}:\\d+$`));
    // Otra acción y otro superadmin no comparten el cupo.
    await expect(requirePlatformAdmin("platform.read")).resolves.toMatchObject({ userId: u });
    asUser(other);
    await expect(requirePlatformAdmin("user.superadmin.update")).resolves.toMatchObject({ userId: other });
    stepUp.pass = false;
  });

  it("toda acción tiene riesgo y rate limit", () => {
    for (const [key, p] of Object.entries(PLATFORM_ACTION_POLICY)) {
      expect(["low", "medium", "high"], key).toContain(p.risk);
      expect(p.rateLimit.limit, key).toBeGreaterThan(0);
      expect(p.rateLimit.windowMs, key).toBeGreaterThan(0);
    }
  });
});

/**
 * BO4 (BO-D6): `requirePlatformAdmin` real con el puerto MFA fake (lib/platform-mfa.ts; la red de GoTrue es lo único
 * reemplazado). El flag se cambia en caliente (`platformMfaEnforcement()` lee process.env en cada llamada). La cookie
 * de re-verificación va por el jar de `next/headers` del setup de integración.
 */
describe.skipIf(!RUN)("[BO4] requirePlatformAdmin · segundo paso", () => {
  let db: PrismaClient;
  const users: string[] = [];

  beforeAll(async () => {
    db = ownerClient();
  });
  afterAll(async () => {
    if (db) {
      if (users.length) await db.userProfile.deleteMany({ where: { id: { in: users } } });
      await db.$disconnect();
    }
  });
  beforeEach(() => {
    cookies().delete(PLATFORM_REAUTH_COOKIE);
    stepUp.pass = false;
    stepUp.calls = 0;
  });
  afterEach(() => {
    delete process.env.PLATFORM_MFA_ENFORCEMENT;
    __setPlatformMfaForTests(null);
    cookies().delete(PLATFORM_REAUTH_COOKIE);
  });

  async function superadmin(): Promise<string> {
    const id = `test-user-${uniqueSuffix()}`;
    await db.userProfile.create({ data: { id, email: `${id}@test.local`, fullName: "Super Admin", isPlatformAdmin: true } });
    users.push(id);
    asUser(id);
    return id;
  }
  const enforce = () => (process.env.PLATFORM_MFA_ENFORCEMENT = "enforce");

  it("off (default): low/medium y sin acción pasan sin factor y sin consultar a GoTrue", async () => {
    const fake = new PlatformMfaFake();
    __setPlatformMfaForTests(fake);
    const u = await superadmin();
    await expect(requirePlatformAdmin("platform.read")).resolves.toMatchObject({ userId: u, mfa: false });
    await expect(requirePlatformAdmin("team.manage")).resolves.toMatchObject({ userId: u, mfa: false });
    await expect(requirePlatformAdmin()).resolves.toMatchObject({ userId: u });
    expect(fake.calls).toEqual([]);
    expect(stepUp.calls).toBe(0);
  });

  it("[PL-Z] a2#4 off: una acción high pide el step-up de la 2FA por usuario (sin 2FA → setup, digest)", async () => {
    const fake = new PlatformMfaFake();
    __setPlatformMfaForTests(fake);
    await superadmin();
    // Antes: resolvía { mfa: false } sin pedir nada (una sesión de superadmin robada hacía todo).
    const err = await requirePlatformAdmin("user.disable").catch((e: unknown) => e);
    expect(classifyStepUpError(err)).toEqual({ kind: "setup" });
    expect(stepUp.calls).toBe(1);
    expect(fake.calls).toEqual([]);
  });

  it("[PL-Z] a2#4 enforce: la re-verificación TOTP de BO4 manda y el step-up por usuario no corre", async () => {
    enforce();
    __setPlatformMfaForTests(PlatformMfaFake.withVerifiedFactor("aal2"));
    await superadmin();
    await expect(requirePlatformAdmin("user.disable")).rejects.toBeInstanceOf(PlatformReauthRequiredError);
    expect(stepUp.calls).toBe(0);
  });

  it("enforce sin factor → PlatformMfaRequiredError(setup) con copy claro y digest", async () => {
    enforce();
    __setPlatformMfaForTests(new PlatformMfaFake());
    await superadmin();
    const err = await requirePlatformAdmin("platform.read").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlatformMfaRequiredError);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err).toMatchObject({ step: "setup", reason: "mfa_setup_required", digest: PLATFORM_ERROR_DIGEST.mfaSetup });
    expect((err as Error).message).toMatch(/configurar la verificación en dos pasos/);
  });

  it("enforce con factor y sesión AAL1 → PlatformMfaRequiredError(verify)", async () => {
    enforce();
    __setPlatformMfaForTests(PlatformMfaFake.withVerifiedFactor("aal1"));
    await superadmin();
    await expect(requirePlatformAdmin()).rejects.toMatchObject({ step: "verify", digest: PLATFORM_ERROR_DIGEST.mfaVerify });
  });

  it("enforce y GoTrue caído → falla cerrado (unavailable)", async () => {
    enforce();
    const fake = PlatformMfaFake.withVerifiedFactor("aal2");
    fake.failAssurance = true;
    __setPlatformMfaForTests(fake);
    await superadmin();
    await expect(requirePlatformAdmin("platform.read")).rejects.toMatchObject({ step: "unavailable" });
  });

  it("enforce y AAL2: low/medium pasan con mfa:true sin re-verificación", async () => {
    enforce();
    __setPlatformMfaForTests(PlatformMfaFake.withVerifiedFactor("aal2"));
    const u = await superadmin();
    await expect(requirePlatformAdmin("platform.read")).resolves.toEqual({ userId: u, email: `${u}@test.local`, homeTenantId: null, mfa: true });
    await expect(requirePlatformAdmin("team.manage")).resolves.toMatchObject({ mfa: true });
  });

  it("enforce, AAL2 y acción high sin re-verificación → reauth_required; con la cookie firmada → ok", async () => {
    enforce();
    __setPlatformMfaForTests(PlatformMfaFake.withVerifiedFactor("aal2"));
    const u = await superadmin();
    const err = await requirePlatformAdmin("user.disable").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlatformReauthRequiredError);
    expect(err).toMatchObject({ reason: "reauth_required", digest: PLATFORM_ERROR_DIGEST.reauth });

    cookies().set(PLATFORM_REAUTH_COOKIE, makePlatformReauthValue(u));
    await expect(requirePlatformAdmin("user.disable")).resolves.toMatchObject({ userId: u, mfa: true });
  });

  it("enforce: la re-verificación vencida (>10 min) o de otro superadmin no sirve", async () => {
    enforce();
    __setPlatformMfaForTests(PlatformMfaFake.withVerifiedFactor("aal2"));
    const other = await superadmin();
    const u = await superadmin();
    cookies().set(PLATFORM_REAUTH_COOKIE, makePlatformReauthValue(u, Date.now() - (PLATFORM_REAUTH_TTL_S + 1) * 1000));
    await expect(requirePlatformAdmin("tenant.status.update")).rejects.toBeInstanceOf(PlatformReauthRequiredError);
    cookies().set(PLATFORM_REAUTH_COOKIE, makePlatformReauthValue(other));
    await expect(requirePlatformAdmin("tenant.status.update")).rejects.toBeInstanceOf(PlatformReauthRequiredError);
  });

  it("el rate limit va ANTES del MFA (una sesión robada no martilla GoTrue)", async () => {
    enforce();
    const fake = new PlatformMfaFake();
    __setPlatformMfaForTests(fake);
    await superadmin();
    const { limit } = PLATFORM_ACTION_POLICY["user.superadmin.update"].rateLimit;
    for (let i = 0; i < limit; i++) await requirePlatformAdmin("user.superadmin.update").catch(() => undefined);
    const before = fake.calls.length;
    await expect(requirePlatformAdmin("user.superadmin.update")).rejects.toBeInstanceOf(PlatformRateLimitedError);
    expect(fake.calls.length).toBe(before);
  });

  describe("«Entrar como soporte» (support.start)", () => {
    it("enforce: exige AAL2 (AAL1 → verificar) y además re-verificación (high)", async () => {
      enforce();
      const fake = PlatformMfaFake.withVerifiedFactor("aal1");
      __setPlatformMfaForTests(fake);
      const u = await superadmin();
      await expect(requirePlatformAdmin("support.start")).rejects.toMatchObject({ step: "verify" });
      fake.level = "aal2";
      await expect(requirePlatformAdmin("support.start")).rejects.toBeInstanceOf(PlatformReauthRequiredError);
      cookies().set(PLATFORM_REAUTH_COOKIE, makePlatformReauthValue(u));
      await expect(requirePlatformAdmin("support.start")).resolves.toMatchObject({ mfa: true });
    });

    it("off: permitido (desarrollo) y `mfa` dice la verdad para el registro", async () => {
      stepUp.pass = true; // high: con off pide el step-up por usuario (PL-Z); acá se prueba el `mfa` del registro.
      const fake = new PlatformMfaFake();
      __setPlatformMfaForTests(fake);
      await superadmin();
      await expect(requirePlatformAdmin("support.start")).resolves.toMatchObject({ mfa: false });
      expect(fake.calls.map((c) => c.method)).toEqual(["getAssurance"]);
      __setPlatformMfaForTests(PlatformMfaFake.withVerifiedFactor("aal2"));
      await expect(requirePlatformAdmin("support.start")).resolves.toMatchObject({ mfa: true });
    });

    it("off con el puerto real sin GoTrue (mock de integración sin getSession) → permitido con mfa:false, no tira", async () => {
      stepUp.pass = true;
      await superadmin();
      await expect(requirePlatformAdmin("support.start")).resolves.toMatchObject({ mfa: false });
    });
  });

  it("{ mfaStep: true }: no exige AAL2 (es la puerta para llegar), pero sí superadmin y rate limit", async () => {
    enforce();
    __setPlatformMfaForTests(new PlatformMfaFake());
    const u = await superadmin();
    await expect(requirePlatformAdmin("mfa.verify", { mfaStep: true })).resolves.toMatchObject({ userId: u, mfa: false });
    await expect(requirePlatformAdmin(undefined, { mfaStep: true })).resolves.toMatchObject({ userId: u });
    // Una acción de admin no puede saltearse el MFA pasando la opción: falla cerrado antes de mirar nada.
    await expect(requirePlatformAdmin("user.disable", { mfaStep: true })).rejects.toMatchObject({ reason: "mfa_step_misuse" });
    const t = await createEphemeralTenant(db);
    asUser(t.userId);
    await expect(requirePlatformAdmin("mfa.verify", { mfaStep: true })).rejects.toBeInstanceOf(ForbiddenError);
    await t.cleanup();
  });
});
