/**
 * Signup verificado, olvidé mi contraseña, reenviar verificación y reset con cookie de recovery.
 *
 * Historia:
 * - A3c-S-signup (30-sep): el signup dejó de crear tenant (H5); el consultorio se arma en /onboarding
 *   después de verificar el email.
 * - IAM-2c (14-oct): «la app manda los mails; Supabase solo emite tokens» (plan §19.4). El signup y el
 *   olvidé-mi-contraseña ya no usan el signUp ni el reset por mail de supabase-js: piden el token con
 *   `admin.generateLink` (puerto `lib/identity/auth-admin.ts`) y mandan el mail propio (`lib/email`).
 *   Bug que motivó la sesión (QA de Martin, §19.1 #4): `signUp` sobre un email que YA tenía cuenta no
 *   mandaba nada y la pantalla decía «Te mandamos un email»: la persona quedaba colgada.
 * - Sin oráculo de cuentas: la respuesta al navegador es la misma con email nuevo, con cuenta real, con
 *   cuenta sin confirmar y con email de paciente; lo que cambia es QUÉ mail llega (o ninguno).
 *
 * Actions REALES contra Postgres. Se reemplazan solo las fronteras de red: el puerto de Auth admin por
 * el fake de GoTrue (`tests/helpers/gotrue-fake.ts`), el despacho del mail por un transporte de registro
 * (`__setEmailTransportForTests`: validación, sink de EmailLog y log siguen siendo los reales) y el
 * cliente de Supabase del server (sesión del /reset).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { cookies } from "next/headers";
import { signUpPractitioner, sendPasswordReset, resendVerification, updatePasswordWithRecoverySession } from "@/lib/auth";
import { hashInviteToken } from "@/lib/invitations-tokens";
import { RECOVERY_COOKIE, makeRecoveryCookieValue } from "@/lib/recovery-cookie";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { __setAuthAdminForTests } from "@/lib/identity/auth-admin";
import { __setEmailTransportForTests, type SendEmailInput } from "@/lib/email";
import { emailToHash } from "@/lib/email/log";
import { env } from "@/lib/env";
import { GotrueFake } from "@/tests/helpers/gotrue-fake";
import { ownerClient, createEphemeralTenant, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

// Registro a mano de lo que NO se tiene que llamar más (signUp / reset por mail de supabase-js) y de la
// sesión que usa /reset. vi.fn sin throw: alcanza para contar llamadas.
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
const SIGNUP_SENT = "Te mandamos un email para confirmar tu cuenta.";
const APP = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");

/** El primer link /auth/confirm del texto del mail, desarmado. */
function confirmLink(mail: SendEmailInput | undefined) {
  const m = mail?.text.match(/https?:\/\/\S*\/auth\/confirm\?\S+/);
  if (!m) return null;
  const u = new URL(m[0]);
  return { origin: u.origin, path: u.pathname, q: Object.fromEntries(u.searchParams) };
}

describe.skipIf(!RUN)("signup · forgot · reenviar verificación · reset (IAM-2c)", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let fake: GotrueFake;
  let sent: SendEmailInput[];
  const extraUsers: string[] = [];
  const mailed = new Set<string>();

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
    // El sink real de EmailLog dejó una fila por mail (sin tenant): se limpian por hash del destinatario.
    if (mailed.size) await db?.emailLog.deleteMany({ where: { toHash: { in: [...mailed].map(emailToHash) } } });
    await db?.$disconnect();
  });
  beforeEach(() => {
    __rateLimitInternals.reset();
    fake = new GotrueFake();
    __setAuthAdminForTests(fake);
    sent = [];
    __setEmailTransportForTests(async (i) => {
      sent.push(i);
      mailed.add(i.to);
      return { ok: true, transport: "resend", providerId: `t-${sent.length}` };
    });
    sb.user = null;
    sb.signUp.mockReset().mockResolvedValue({ data: { user: { id: "x" }, session: null }, error: null });
    sb.signInWithPassword.mockReset();
    sb.updateUser.mockReset().mockResolvedValue({ data: {}, error: null });
    sb.resetPasswordForEmail.mockReset().mockResolvedValue({ data: {}, error: null });
    cookies().delete(RECOVERY_COOKIE);
  });
  afterEach(() => {
    __setAuthAdminForTests(null);
    __setEmailTransportForTests(null);
  });

  const counts = async (email: string) => ({
    tenants: await db.tenant.count(),
    profiles: await db.userProfile.count({ where: { email } }),
    memberships: await db.membership.count({ where: { user: { email } } }),
  });
  const fresh = (tag: string) => `${tag}-${uniqueSuffix()}@test.local`;
  const seed = async (email: string, confirmed: boolean, password = "vieja1234") => {
    const r = await fake.createUser({ email, password, emailConfirm: confirmed });
    if (!r.ok) throw new Error(r.code);
    fake.calls.length = 0;
    return r.data;
  };

  describe("signup", () => {
    it("[IAM-2c] el signup no llama auth.signUp: generateLink(signup) con la contraseña + mail propio de verificación a /onboarding", async () => {
      const email = fresh("nuevo");
      const before = await counts(email);

      const r = await signUpPractitioner({ fullName: "Camila Rossi", email: email.toUpperCase(), password: "clave1234" });

      expect(r).toEqual({ ok: true, data: { email, joining: false, message: SIGNUP_SENT } });
      expect(sb.signUp).not.toHaveBeenCalled();
      // La cuenta queda creada SIN confirmar, con la contraseña elegida y el nombre.
      const users = [...fake.users.values()].filter((u) => u.email === email);
      expect(users).toHaveLength(1);
      expect(users[0]).toMatchObject({ emailConfirmedAt: null, password: "clave1234", fullName: "Camila Rossi" });
      expect(fake.links).toHaveLength(1);
      expect(fake.links[0]).toMatchObject({ type: "signup", email });

      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ kind: "email_verification", to: email });
      const link = confirmLink(sent[0]);
      expect(link).toEqual({
        origin: new URL(APP).origin,
        path: "/auth/confirm",
        q: { token_hash: fake.links[0].hashedToken, type: "signup", next: "/onboarding" },
      });
      // No crea tenant, perfil ni membresía: eso es /onboarding después de verificar (H5).
      expect(await counts(email)).toEqual(before);
    });

    it("[IAM-2c] signup con email existente no queda colgado: le llega «ya tenés cuenta» con login y recovery", async () => {
      const email = fresh("existe");
      await seed(email, true);

      const r = await signUpPractitioner({ fullName: "Otra Persona", email, password: "clave1234" });

      // Misma respuesta que un alta nueva (sin oráculo).
      expect(r).toEqual({ ok: true, data: { email, joining: false, message: SIGNUP_SENT } });
      expect(sb.signUp).not.toHaveBeenCalled();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ kind: "account_exists", to: email });
      expect(sent[0].text).toContain(`${APP}/login`);
      const link = confirmLink(sent[0]);
      expect(link?.q).toMatchObject({ type: "recovery", next: "/reset" });
      expect(link?.q.token_hash).toBe(fake.links.at(-1)?.hashedToken);
      // No se toca la cuenta existente desde un pedido sin autenticar: ni clave ni nombre.
      const u = [...fake.users.values()].find((x) => x.email === email);
      expect(u).toMatchObject({ password: "vieja1234", fullName: null });
      expect(fake.calls.map((c) => c.method)).not.toContain("updateUserById");
    });

    it("cuenta sin confirmar (zombie): se re-emite la verificación sin pisar la contraseña", async () => {
      const email = fresh("zombie");
      await seed(email, false);

      const r = await signUpPractitioner({ fullName: "Zom Bie", email, password: "clave1234" });

      expect(r).toEqual({ ok: true, data: { email, joining: false, message: SIGNUP_SENT } });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ kind: "email_verification", to: email });
      expect(confirmLink(sent[0])?.q).toMatchObject({ type: "signup", next: "/onboarding" });
      const gen = fake.calls.find((c) => c.method === "generateLink");
      expect(gen?.args[0]).toEqual({ type: "signup", email });
      const u = [...fake.users.values()].find((x) => x.email === email);
      expect(u?.password).toBe("vieja1234");
    });

    it("un email de paciente con portal no se registra: misma respuesta, sin mail, sin cuenta, sin tenant", async () => {
      const uid = `test-user-pac-${uniqueSuffix()}`;
      const email = `${uid}@test.local`;
      extraUsers.push(uid);
      await db.userProfile.create({ data: { id: uid, email } });
      await db.patient.create({
        data: { tenantId: A.tenantId, firstName: "Pac", lastName: "Portal", email, userId: uid, documentId: `DNI-${uid}` },
      });
      const before = await counts(email);

      const r = await signUpPractitioner({ fullName: "Pac Portal", email, password: "clave1234" });

      expect(r).toEqual({ ok: true, data: { email, joining: false, message: SIGNUP_SENT } });
      expect(sent).toHaveLength(0);
      expect(fake.calls).toHaveLength(0);
      expect(sb.signUp).not.toHaveBeenCalled();
      expect(await counts(email)).toEqual(before);
    });

    it("con invitación: no crea nada ni manda mail, devuelve el redirect a /invite/<token> (la activación es de /invite)", async () => {
      const raw = randomBytes(24).toString("base64url");
      await db.invitation.create({
        data: {
          tenantId: A.tenantId,
          email: fresh("invitado"),
          firstName: "Inv",
          lastName: "Itado",
          token: hashInviteToken(raw),
          invitedById: A.userId,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      const tenantsBefore = await db.tenant.count();

      const r = await signUpPractitioner({ fullName: "Inv Itado", email: "otro@evil.test", password: "clave1234", inviteToken: raw });

      expect(r).toEqual({ ok: true, data: { email: "", joining: true, message: "", redirectTo: `/invite/${raw}` } });
      expect(fake.calls).toHaveLength(0);
      expect(sent).toHaveLength(0);
      expect(await db.tenant.count()).toBe(tenantsBefore);
    });

    it("con invitación, aunque el resto del form venga vacío o el token traiga caracteres raros: el path sale codificado", async () => {
      const r = await signUpPractitioner({ fullName: "", email: "", password: "", inviteToken: "../a b?c" });
      expect(r).toMatchObject({ ok: true, data: { redirectTo: `/invite/${encodeURIComponent("../a b?c")}` } });
    });

    it("rate limit: el 4º pedido se frena y no manda mail (IP 3/10 min y email 3/h; el header de IP es fijo en el harness)", async () => {
      const email = fresh("rl");
      await seed(email, true);
      for (let i = 0; i < 3; i++) {
        expect((await signUpPractitioner({ fullName: "R L", email, password: "clave1234" })).ok).toBe(true);
      }
      const r = await signUpPractitioner({ fullName: "R L", email, password: "clave1234" });
      expect(r.ok).toBe(false);
      expect(sent).toHaveLength(3);
    });

    it("contraseña que GoTrue rechaza por débil (política del proyecto más estricta) → error de campo, sin mail", async () => {
      const strict = new GotrueFake({ minPasswordLength: 20 });
      __setAuthAdminForTests(strict);
      const r = await signUpPractitioner({ fullName: "Dé Bil", email: fresh("debil"), password: "clave1234" });
      expect(r).toMatchObject({ ok: false, fieldErrors: { password: expect.any(Array) } });
      expect(sent).toHaveLength(0);
    });

    it("si el servicio de cuentas falla: error genérico (no depende de si la cuenta existe), sin mail", async () => {
      fake.failNext("error", "findUserByEmail");
      const r = await signUpPractitioner({ fullName: "Fa Lla", email: fresh("falla"), password: "clave1234" });
      expect(r.ok).toBe(false);
      expect(sent).toHaveLength(0);
    });

    it("[BO-Z] SIGNUP_MODE=assisted: sin invitación no crea cuenta ni manda mail; con invitación sigue al /invite", async () => {
      const prev = process.env.SIGNUP_MODE;
      process.env.SIGNUP_MODE = "assisted";
      try {
        const email = fresh("asistido");
        const r = await signUpPractitioner({ fullName: "A Sistido", email, password: "clave1234" });
        expect(r).toEqual({ ok: false, error: expect.stringContaining("Por ahora damos de alta los consultorios nosotros") });
        expect(fake.calls).toHaveLength(0);
        expect(sent).toHaveLength(0);
        const inv = await signUpPractitioner({ fullName: "", email: "", password: "", inviteToken: "tok-asistido" });
        expect(inv).toMatchObject({ ok: true, data: { joining: true, redirectTo: "/invite/tok-asistido" } });
      } finally {
        if (prev === undefined) delete process.env.SIGNUP_MODE;
        else process.env.SIGNUP_MODE = prev;
      }
    });
  });

  describe("olvidé mi contraseña", () => {
    it("[IAM-2c] olvidé mi contraseña no llama resetPasswordForEmail: recovery propio a /reset", async () => {
      const email = fresh("forgot");
      await seed(email, true);

      const r = await sendPasswordReset({ email: email.toUpperCase() });

      expect(r).toEqual({ ok: true, data: undefined });
      expect(sb.resetPasswordForEmail).not.toHaveBeenCalled();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ kind: "password_reset", to: email });
      expect(confirmLink(sent[0])?.q).toEqual({
        token_hash: fake.links[0].hashedToken,
        type: "recovery",
        next: "/reset",
      });
    });

    it("sin cuenta: misma respuesta, no manda nada y no crea a nadie", async () => {
      const r = await sendPasswordReset({ email: fresh("nadie") });
      expect(r).toEqual({ ok: true, data: undefined });
      expect(sent).toHaveLength(0);
      expect(fake.users.size).toBe(0);
    });

    it("rate limit por email (3/h)", async () => {
      const email = fresh("forgot-rl");
      for (let i = 0; i < 3; i++) expect((await sendPasswordReset({ email })).ok).toBe(true);
      expect((await sendPasswordReset({ email })).ok).toBe(false);
    });
  });

  describe("reenviar verificación (C-IAM6)", () => {
    const fd = (email: string) => {
      const f = new FormData();
      f.set("email", email);
      return f;
    };

    it("cuenta sin confirmar: re-emite la verificación a /onboarding", async () => {
      const email = fresh("resend");
      await seed(email, false);
      const r = await resendVerification(fd(email));
      expect(r).toEqual({ ok: true, data: undefined });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ kind: "email_verification", to: email });
      expect(confirmLink(sent[0])?.q).toMatchObject({ type: "signup", next: "/onboarding" });
      expect(sb.signUp).not.toHaveBeenCalled();
    });

    it("cuenta confirmada o inexistente: misma respuesta, sin mail, sin crear cuentas", async () => {
      const email = fresh("resend-ok");
      await seed(email, true);
      expect(await resendVerification(fd(email))).toEqual({ ok: true, data: undefined });
      expect(await resendVerification(fd(fresh("resend-nadie")))).toEqual({ ok: true, data: undefined });
      expect(sent).toHaveLength(0);
      expect(fake.users.size).toBe(1);
    });

    it("email inválido → error de campo", async () => {
      const r = await resendVerification(fd("no-es-email"));
      expect(r).toMatchObject({ ok: false, fieldErrors: { email: expect.any(Array) } });
    });

    it("rate limit por hash del email", async () => {
      const email = fresh("resend-rl");
      await seed(email, false);
      for (let i = 0; i < 3; i++) expect((await resendVerification(fd(email))).ok).toBe(true);
      expect((await resendVerification(fd(email))).ok).toBe(false);
      expect(sent).toHaveLength(3);
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
