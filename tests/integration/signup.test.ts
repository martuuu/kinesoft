/**
 * Signup verificado + reset con cookie de recovery (A3c-S-signup, 2026-09-30).
 *
 * - `signUpPractitioner` NO crea tenant, membresía ni perfil: solo pide a
 *   Supabase la identidad (que manda el mail) con
 *   `emailRedirectTo = <APP_URL>/onboarding` (destino final; la plantilla lo pone en `next` de /auth/confirm). Antes (H5) creaba el
 *   usuario auto-confirmado con el admin client y armaba el tenant en el acto;
 * - un email de paciente con portal no se registra (misma respuesta, sin mail);
 * - signup de unión: email fijo de la invitación, sin tenant, vuelve a
 *   `/invite/<token>`;
 * - `/reset` sin la cookie `ks_recovery` exige la contraseña actual; con la
 *   cookie firmada del MISMO usuario, no, y la cookie es de un solo uso.
 *
 * Actions REALES contra Postgres; solo se mockea el cliente de Supabase (la
 * red) y cookies/headers de Next (integration-setup.ts).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { cookies } from "next/headers";
import { signUpPractitioner, sendPasswordReset, updatePasswordWithRecoverySession } from "@/lib/auth";
import { hashInviteToken } from "@/lib/invitations-tokens";
import { RECOVERY_COOKIE, makeRecoveryCookieValue } from "@/lib/recovery-cookie";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { env } from "@/lib/env";
import { ownerClient, createEphemeralTenant, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const sb = vi.hoisted(() => ({
  user: null as null | { id: string; email: string; email_confirmed_at: string | null },
  signUp: vi.fn(),
  signInWithPassword: vi.fn(),
  updateUser: vi.fn(),
  resetPasswordForEmail: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: sb.user }, error: null }),
      signUp: sb.signUp,
      signInWithPassword: sb.signInWithPassword,
      updateUser: sb.updateUser,
      resetPasswordForEmail: sb.resetPasswordForEmail,
    },
  }),
}));

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("signup verificado · reset", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  const extraUsers: string[] = [];

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
  });
  afterAll(async () => {
    await A?.cleanup();
    if (extraUsers.length) {
      await db?.patient.updateMany({ where: { userId: { in: extraUsers } }, data: { userId: null } });
      await db?.userProfile.deleteMany({ where: { id: { in: extraUsers } } });
    }
    await db?.$disconnect();
  });
  beforeEach(() => {
    __rateLimitInternals.reset();
    sb.user = null;
    sb.signUp.mockReset().mockResolvedValue({ data: { user: { id: "x" }, session: null }, error: null });
    sb.signInWithPassword.mockReset();
    sb.updateUser.mockReset().mockResolvedValue({ data: {}, error: null });
    sb.resetPasswordForEmail.mockReset().mockResolvedValue({ data: {}, error: null });
    cookies().delete(RECOVERY_COOKIE);
  });

  const counts = async (email: string) => ({
    tenants: await db.tenant.count(),
    profiles: await db.userProfile.count({ where: { email } }),
    memberships: await db.membership.count({ where: { user: { email } } }),
  });

  it("sin verificar no hay tenant: signUp manda el mail con destino /onboarding y no crea nada", async () => {
    const email = `nuevo-${uniqueSuffix()}@test.local`;
    const before = await counts(email);

    const r = await signUpPractitioner({ fullName: "Camila Rossi", email: email.toUpperCase(), password: "clave1234" });

    expect(r).toEqual({
      ok: true,
      data: { email, joining: false, message: "Te mandamos un email para confirmar tu cuenta." },
    });
    expect(sb.signUp).toHaveBeenCalledTimes(1);
    expect(sb.signUp).toHaveBeenCalledWith({
      email,
      password: "clave1234",
      options: {
        emailRedirectTo: `${env.NEXT_PUBLIC_APP_URL}/onboarding`,
        data: { full_name: "Camila Rossi" },
      },
    });
    expect(await counts(email)).toEqual(before);
  });

  it("un email de paciente con portal no se registra: misma respuesta, sin mail, sin tenant", async () => {
    const uid = `test-user-pac-${uniqueSuffix()}`;
    const email = `${uid}@test.local`;
    extraUsers.push(uid);
    await db.userProfile.create({ data: { id: uid, email } });
    await db.patient.create({
      data: { tenantId: A.tenantId, firstName: "Pac", lastName: "Portal", email, userId: uid, documentId: `DNI-${uid}` },
    });
    const before = await counts(email);

    const r = await signUpPractitioner({ fullName: "Pac Portal", email, password: "clave1234" });

    expect(r.ok).toBe(true);
    expect(sb.signUp).not.toHaveBeenCalled();
    expect(await counts(email)).toEqual(before);
  });

  it("signup de unión: email fijo de la invitación, no crea tenant, vuelve a /invite/<token>", async () => {
    const raw = randomBytes(24).toString("base64url");
    const invited = `invitado-${uniqueSuffix()}@test.local`;
    await db.invitation.create({
      data: {
        tenantId: A.tenantId,
        email: invited,
        firstName: "Inv",
        lastName: "Itado",
        token: hashInviteToken(raw),
        invitedById: A.userId,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const tenantsBefore = await db.tenant.count();

    const r = await signUpPractitioner({
      fullName: "Inv Itado",
      email: "otro-email@evil.test",
      password: "clave1234",
      inviteToken: raw,
    });

    expect(r).toMatchObject({ ok: true, data: { email: invited, joining: true } });
    expect(sb.signUp).toHaveBeenCalledWith(
      expect.objectContaining({
        email: invited,
        options: expect.objectContaining({
          emailRedirectTo: `${env.NEXT_PUBLIC_APP_URL}/invite/${raw}`,
        }),
      })
    );
    expect(await db.tenant.count()).toBe(tenantsBefore);
    expect(await db.membership.count({ where: { user: { email: invited } } })).toBe(0);
  });

  it("signup de unión con token inválido o vencido: rechazado sin llamar a Supabase", async () => {
    const r1 = await signUpPractitioner({ fullName: "X Y", email: "a@b.test", password: "clave1234", inviteToken: "no-existe" });
    expect(r1.ok).toBe(false);

    const raw = randomBytes(24).toString("base64url");
    await db.invitation.create({
      data: {
        tenantId: A.tenantId,
        email: `vencida-${uniqueSuffix()}@test.local`,
        firstName: "V",
        lastName: "V",
        token: hashInviteToken(raw),
        invitedById: A.userId,
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    const r2 = await signUpPractitioner({ fullName: "X Y", email: "a@b.test", password: "clave1234", inviteToken: raw });
    expect(r2.ok).toBe(false);
    expect(sb.signUp).not.toHaveBeenCalled();
  });

  it("forgot: redirectTo = /reset (la plantilla de recovery pasa por /auth/confirm)", async () => {
    const r = await sendPasswordReset({ email: "Alguien@Test.local" });
    expect(r.ok).toBe(true);
    expect(sb.resetPasswordForEmail).toHaveBeenCalledWith("alguien@test.local", {
      redirectTo: `${env.NEXT_PUBLIC_APP_URL}/reset`,
    });
  });

  describe("reset", () => {
    const uid = "test-user-reset-1";
    beforeEach(() => {
      sb.user = { id: uid, email: `${uid}@test.local`, email_confirmed_at: new Date(0).toISOString() };
    });

    it("sin la cookie de recovery y sin contraseña actual: rechazado, no cambia la clave", async () => {
      const r = await updatePasswordWithRecoverySession({ password: "nueva1234" });
      expect(r.ok).toBe(false);
      expect(sb.signInWithPassword).not.toHaveBeenCalled();
      expect(sb.updateUser).not.toHaveBeenCalled();
    });

    it("sin la cookie, con contraseña actual incorrecta: rechazado", async () => {
      sb.signInWithPassword.mockResolvedValue({ data: {}, error: { message: "Invalid login credentials", status: 400 } });
      const r = await updatePasswordWithRecoverySession({ password: "nueva1234", currentPassword: "mala" });
      expect(r).toMatchObject({ ok: false, error: "La contraseña actual no es correcta." });
      expect(sb.updateUser).not.toHaveBeenCalled();
    });

    it("sin la cookie, con la contraseña actual correcta: cambia la clave", async () => {
      sb.signInWithPassword.mockResolvedValue({ data: { user: { id: uid } }, error: null });
      const r = await updatePasswordWithRecoverySession({ password: "nueva1234", currentPassword: "vieja1234" });
      expect(r.ok).toBe(true);
      expect(sb.signInWithPassword).toHaveBeenCalledWith({ email: `${uid}@test.local`, password: "vieja1234" });
      expect(sb.updateUser).toHaveBeenCalledWith({ password: "nueva1234" });
    });

    it("una cookie de recovery de OTRO usuario no sirve", async () => {
      cookies().set(RECOVERY_COOKIE, makeRecoveryCookieValue("test-user-otro"));
      const r = await updatePasswordWithRecoverySession({ password: "nueva1234" });
      expect(r.ok).toBe(false);
      expect(sb.updateUser).not.toHaveBeenCalled();
    });

    it("con la cookie de recovery propia: sin contraseña actual, y la cookie es de un solo uso", async () => {
      cookies().set(RECOVERY_COOKIE, makeRecoveryCookieValue(uid));
      const r = await updatePasswordWithRecoverySession({ password: "nueva1234" });
      expect(r.ok).toBe(true);
      expect(sb.signInWithPassword).not.toHaveBeenCalled();
      expect(sb.updateUser).toHaveBeenCalledWith({ password: "nueva1234" });
      expect(cookies().get(RECOVERY_COOKIE)).toBeUndefined();

      // Segundo uso: ya no hay cookie → vuelve a pedir la actual.
      __rateLimitInternals.reset();
      const again = await updatePasswordWithRecoverySession({ password: "otra12345" });
      expect(again.ok).toBe(false);
      expect(sb.updateUser).toHaveBeenCalledTimes(1);
    });
  });
});
