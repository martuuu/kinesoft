/**
 * [BO4] Actions del segundo paso de Plataforma (lib/platform-mfa-actions.ts) contra Postgres (registro de
 * plataforma) y el puerto MFA fake (la red de GoTrue es lo único reemplazado; supuestos [M1]…[M6] del puerto).
 * La cookie de re-verificación va por el jar de `next/headers` del setup de integración.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { cookies } from "next/headers";
import type { PrismaClient } from "@prisma/client";
import { ForbiddenError } from "@/lib/session";
import {
  confirmPlatformMfaEnrollment,
  startPlatformMfaEnrollment,
  verifyPlatformMfaLogin,
  verifyPlatformReauth,
} from "@/lib/platform-mfa-actions";
import { PlatformReauthRequiredError, requirePlatformAdmin } from "@/lib/platform-actor";
import { __setPlatformMfaForTests } from "@/lib/platform-mfa";
import { PLATFORM_REAUTH_COOKIE, verifyPlatformReauthValue } from "@/lib/platform-reauth";
import { PlatformMfaFake } from "@/tests/helpers/platform-mfa-fake";
import { asUser } from "@/tests/helpers/actor";
import { ownerClient, createEphemeralTenant, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("[BO4] lib/platform-mfa-actions", () => {
  let db: PrismaClient;
  const users: string[] = [];
  const tenants: EphemeralTenant[] = [];

  beforeAll(() => {
    db = ownerClient();
  });
  afterAll(async () => {
    for (const t of tenants) await t.cleanup();
    if (db) {
      if (users.length) await db.userProfile.deleteMany({ where: { id: { in: users } } });
      await db.$disconnect();
    }
  });
  beforeEach(() => cookies().delete(PLATFORM_REAUTH_COOKIE));
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
  const reauthCookie = () => cookies().get(PLATFORM_REAUTH_COOKIE)?.value;

  it("enrolamiento completo con el flag en off: QR → código malo → código bueno (factor verificado, AAL2, registro, cookie)", async () => {
    const fake = new PlatformMfaFake();
    __setPlatformMfaForTests(fake);
    const u = await superadmin();

    const start = await startPlatformMfaEnrollment();
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    expect(start.data.qrCode).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    expect(start.data.secret).toBeTruthy();

    const bad = await confirmPlatformMfaEnrollment(start.data.factorId, "000000");
    expect(bad).toMatchObject({ ok: false, error: expect.stringMatching(/no es correcto/) });
    expect(fake.factors[0].status).toBe("unverified");
    expect(reauthCookie()).toBeUndefined();

    const good = await confirmPlatformMfaEnrollment(start.data.factorId, "123 456");
    expect(good).toEqual({ ok: true, data: undefined });
    expect(fake.factors[0].status).toBe("verified");
    expect(fake.level).toBe("aal2");
    expect(verifyPlatformReauthValue(reauthCookie(), u)).toBe(true);

    const ev = await db.platformAuditEvent.findFirst({ where: { action: "platform.mfa.enroll", actorId: u } });
    expect(ev).toMatchObject({ entity: "UserProfile", entityId: u, targetUserId: u, tenantId: null });
    expect(ev?.payload).toMatchObject({ factorType: "totp" });
  });

  it("un enrolamiento a medias se reemplaza (el QR viejo deja de servir); con uno verificado no se crea otro", async () => {
    const fake = new PlatformMfaFake();
    __setPlatformMfaForTests(fake);
    await superadmin();
    const first = await startPlatformMfaEnrollment();
    const second = await startPlatformMfaEnrollment();
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(fake.factors.map((f) => f.id)).toEqual([second.data.factorId]);
    expect(await confirmPlatformMfaEnrollment(first.data.factorId, "123456")).toMatchObject({ ok: false });

    expect(await confirmPlatformMfaEnrollment(second.data.factorId, "123456")).toMatchObject({ ok: true });
    expect(await startPlatformMfaEnrollment()).toMatchObject({ ok: false, error: expect.stringMatching(/Ya tenés/) });
    expect(fake.factors).toHaveLength(1);
  });

  it("código con formato inválido no llega a GoTrue", async () => {
    const fake = PlatformMfaFake.withVerifiedFactor("aal1");
    __setPlatformMfaForTests(fake);
    await superadmin();
    expect(await verifyPlatformMfaLogin("12ab56")).toMatchObject({ ok: false, error: expect.stringMatching(/6 números/) });
    expect(fake.calls.filter((c) => c.method === "verify")).toEqual([]);
  });

  it("login con enforce: AAL1 → código → AAL2 y Plataforma abre", async () => {
    process.env.PLATFORM_MFA_ENFORCEMENT = "enforce";
    const fake = PlatformMfaFake.withVerifiedFactor("aal1");
    __setPlatformMfaForTests(fake);
    await superadmin();
    await expect(requirePlatformAdmin()).rejects.toMatchObject({ step: "verify" });
    expect(await verifyPlatformMfaLogin("123456")).toEqual({ ok: true, data: undefined });
    await expect(requirePlatformAdmin("platform.read")).resolves.toMatchObject({ mfa: true });
  });

  it("re-verificación: código malo no deja cookie; el bueno la deja y la acción high pasa", async () => {
    process.env.PLATFORM_MFA_ENFORCEMENT = "enforce";
    __setPlatformMfaForTests(PlatformMfaFake.withVerifiedFactor("aal2"));
    const u = await superadmin();
    await expect(requirePlatformAdmin("team.transfer_owner")).rejects.toBeInstanceOf(PlatformReauthRequiredError);

    expect(await verifyPlatformReauth("654321")).toMatchObject({ ok: false });
    expect(reauthCookie()).toBeUndefined();

    expect(await verifyPlatformReauth("123456")).toEqual({ ok: true, data: undefined });
    expect(verifyPlatformReauthValue(reauthCookie(), u)).toBe(true);
    await expect(requirePlatformAdmin("team.transfer_owner")).resolves.toMatchObject({ userId: u, mfa: true });
  });

  it("re-verificación sin factor configurado → error claro", async () => {
    __setPlatformMfaForTests(new PlatformMfaFake());
    await superadmin();
    expect(await verifyPlatformReauth("123456")).toMatchObject({ ok: false, error: expect.stringMatching(/Todavía no configuraste/) });
  });

  it("un usuario de consultorio no puede usar ninguna (ForbiddenError, sin tocar GoTrue)", async () => {
    const fake = new PlatformMfaFake();
    __setPlatformMfaForTests(fake);
    const t = await createEphemeralTenant(db);
    tenants.push(t);
    asUser(t.userId);
    await expect(startPlatformMfaEnrollment()).rejects.toBeInstanceOf(ForbiddenError);
    await expect(verifyPlatformReauth("123456")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(verifyPlatformMfaLogin("123456")).rejects.toBeInstanceOf(ForbiddenError);
    expect(fake.calls).toEqual([]);
  });
});
