/**
 * PL-2a · 2FA por usuario (C-PL6, plan §20.5.5): código por email, códigos de recuperación, TOTP con el fake de
 * GoTrue, step-up, corte de Plataforma y reset del superadmin.
 *
 * Símbolos REALES (`lib/two-factor.ts`, `lib/two-factor-internal.ts`, `lib/two-factor-step-up.ts`,
 * `requirePlatformAdmin`, `resetPlatformUserTwoFactor`) contra Postgres en los dos roles. Se reemplaza solo lo
 * externo: la sesión de Supabase (este archivo pisa el mock del setup para darle un access token con
 * `session_id`/`aal`, como `pl1e-session.test.ts`), las cookies (`next/headers` del setup), el despacho del mail
 * (`__setEmailTransportForTests`: el sink a EmailLog sigue corriendo), el puerto MFA del usuario
 * (`PlatformMfaFake`) y el MFA admin de GoTrue (`GotrueFake`).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { cookies } from "next/headers";
import type { PrismaClient } from "@prisma/client";
import { asUser } from "@/tests/helpers/actor";
import { ownerClient, uniqueSuffix } from "@/tests/helpers/tenant-factory";
import { PlatformMfaFake } from "@/tests/helpers/platform-mfa-fake";
import { GotrueFake } from "@/tests/helpers/gotrue-fake";

const tok = vi.hoisted(() => ({ claims: null as null | { session_id: string; aal: string } }));
vi.mock("@/lib/supabase/server", async () => {
  const { currentTestUser } = await import("@/tests/helpers/actor");
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const token = (): string | null => {
    const u = currentTestUser();
    if (!u || !tok.claims) return null;
    const payload = {
      sub: u.id,
      email: u.email,
      role: "authenticated",
      aud: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...tok.claims,
    };
    return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.firma-que-verifica-gotrue`;
  };
  return {
    getSupabaseServerClient: () => ({
      auth: {
        getSession: async () => {
          const t = token();
          if (!t) throw new Error("sin getSession");
          return { data: { session: { access_token: t } }, error: null };
        },
        getUser: async () => ({ data: { user: currentTestUser() }, error: null }),
        getClaims: async () => ({ data: null, error: { message: "sin JWKS" } }),
      },
    }),
  };
});

import { getAccessSnapshot, UnauthenticatedError } from "@/lib/session";
import { __setEmailTransportForTests, type SendEmailInput, type SendEmailResult } from "@/lib/email";
import { __setMfaPortForTests } from "@/lib/mfa-port";
import { __setAuthAdminMfaForTests } from "@/lib/identity/auth-admin";
import { STEP_UP_COOKIE, TWO_FACTOR_COOKIE } from "@/lib/two-factor-cookie";
import { classifyStepUpError } from "@/lib/two-factor-logic";
import { requireStepUp } from "@/lib/two-factor-step-up";
import { issueEmailChallenge } from "@/lib/two-factor-internal";
import {
  confirmTotpEnrollment,
  disableMethod,
  enableEmailMethod,
  regenerateRecoveryCodes,
  requestEmailCode,
  startTotpEnrollment,
  useRecoveryCode as redeemRecoveryCode,
  verifyEmailCode,
  verifyLoginTotp,
  verifyStepUpTotp,
} from "@/lib/two-factor";
import { requirePlatformAdmin } from "@/lib/platform-actor";
import { resetPlatformUserTwoFactor } from "@/lib/platform-users";
import { confirmPlatformMfaEnrollment, startPlatformMfaEnrollment } from "@/lib/platform-mfa-actions";
import { saveOnboardingClinic } from "@/lib/onboarding";
import { acceptInvite } from "@/app/invite/[token]/accept-action";

const RUN = process.env.INTEGRATION === "1";

const mail = {
  sent: [] as SendEmailInput[],
  transport: async (i: SendEmailInput): Promise<SendEmailResult> => {
    mail.sent.push(i);
    return { ok: true, transport: "resend", providerId: `re_${mail.sent.length}` };
  },
};

/** El código del último mail `two_factor_code` (del cuerpo de texto: «Código: 123 456»). */
function lastCode(): string {
  const m = [...mail.sent].reverse().find((x) => x.kind === "two_factor_code");
  const hit = m?.text.match(/Código: (\d{3}) (\d{3})/);
  if (!hit) throw new Error("no hay mail de código");
  return `${hit[1]}${hit[2]}`;
}

function wrong(code: string): string {
  return code === "000000" ? "111111" : "000000";
}

describe.skipIf(!RUN)("[PL-2a] 2FA por usuario", () => {
  let db: PrismaClient;
  const users: string[] = [];
  let mfa: PlatformMfaFake;
  let gotrue: GotrueFake;

  async function profile(o: { admin?: boolean } = {}): Promise<string> {
    const id = `test-user-${uniqueSuffix()}`;
    await db.userProfile.create({ data: { id, email: `${id}@test.local`, fullName: `Dos Pasos ${id}`, isPlatformAdmin: o.admin ?? false } });
    users.push(id);
    return id;
  }

  /** Sesión de Supabase de `userId` con `session_id` propio. */
  function session(userId: string, sessionId = `sess-${uniqueSuffix()}`, aal: "aal1" | "aal2" = "aal1") {
    asUser(userId);
    tok.claims = { session_id: sessionId, aal };
    return sessionId;
  }

  beforeAll(() => {
    db = ownerClient();
  });
  afterAll(async () => {
    if (!db) return;
    if (users.length) {
      // Registros solo inserción: la limpieza de TEST los saltea en modo réplica (como deleteTenantDeep).
      await db.$transaction([
        db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
        db.$executeRaw`DELETE FROM "UserSecurityEvent" WHERE "userId" = ANY(${users}::text[])`,
        db.$executeRaw`DELETE FROM "PlatformAuditEvent" WHERE "targetUserId" = ANY(${users}::text[]) OR "actorId" = ANY(${users}::text[])`,
      ]);
      await db.emailLog.deleteMany({ where: { entityId: { in: users } } });
      await db.userProfile.deleteMany({ where: { id: { in: users } } });
    }
    await db.$disconnect();
  });
  beforeEach(() => {
    mail.sent.length = 0;
    __setEmailTransportForTests(mail.transport);
    mfa = new PlatformMfaFake();
    __setMfaPortForTests(mfa);
    gotrue = new GotrueFake();
    __setAuthAdminMfaForTests(gotrue);
    cookies().delete(TWO_FACTOR_COOKIE);
    cookies().delete(STEP_UP_COOKIE);
  });
  afterEach(() => {
    __setEmailTransportForTests(null);
    __setMfaPortForTests(null);
    __setAuthAdminMfaForTests(null);
    tok.claims = null;
  });

  /** Activa el email (enroll) y deja la sesión probada; devuelve los códigos de recuperación. */
  async function enableEmail(userId: string): Promise<string[]> {
    session(userId);
    expect(await requestEmailCode("enroll_email")).toMatchObject({ ok: true });
    const r = await enableEmailMethod(lastCode());
    if (!r.ok) throw new Error(r.error);
    return r.data.recoveryCodes ?? [];
  }

  /** Corre el desafío más reciente del usuario 2 minutos para atrás (pasa la espera de 60 s del reenvío). */
  async function ageChallenges(userId: string) {
    await db.$executeRaw`UPDATE "TwoFactorChallenge" SET "createdAt" = "createdAt" - interval '2 minutes', "expiresAt" = "expiresAt" - interval '2 minutes' WHERE "userId" = ${userId}`;
  }

  describe("código por email", () => {
    it("el código nunca queda en claro: ni en EmailLog, ni en el asunto, ni en el desafío", async () => {
      const U = await profile();
      session(U);
      const r = await requestEmailCode("enroll_email");
      expect(r).toMatchObject({ ok: true, data: { expiresInS: 600 } });
      const code = lastCode();
      const m = mail.sent.find((x) => x.kind === "two_factor_code")!;
      expect(m.subject).not.toContain(code.slice(0, 3));
      expect(m.html).toContain(`${code.slice(0, 3)} ${code.slice(3)}`);

      const logs = await db.emailLog.findMany({ where: { entityId: U, kind: "two_factor_code" } });
      expect(logs).toHaveLength(1);
      expect(logs[0].linkHost).toBeNull();
      expect(JSON.stringify(logs[0])).not.toContain(code);

      const ch = await db.twoFactorChallenge.findFirstOrThrow({ where: { userId: U } });
      expect(ch.codeHash).not.toContain(code);
      expect(ch.purpose).toBe("ENROLL_EMAIL");
      expect(ch.closedAt).toBeNull();
    });

    it("activar por email: flag, 10 códigos de recuperación, sesión probada, evento y aviso", async () => {
      const U = await profile();
      const codes = await enableEmail(U);
      expect(codes).toHaveLength(10);
      const p = await db.userProfile.findUniqueOrThrow({ where: { id: U } });
      expect(p.twoFactorEmail).toBe(true);
      expect(await db.twoFactorRecoveryCode.count({ where: { userId: U, usedAt: null } })).toBe(10);
      // Hash, nunca el código.
      const stored = await db.twoFactorRecoveryCode.findMany({ where: { userId: U } });
      for (const c of codes) expect(stored.some((s) => s.codeHash.includes(c.replace("-", "")))).toBe(false);
      expect(cookies().get(TWO_FACTOR_COOKIE)).toBeDefined();
      expect((await getAccessSnapshot())?.twoFactor.state).toBe("satisfied");
      expect(await db.userSecurityEvent.count({ where: { userId: U, kind: "two_factor.email_enabled" } })).toBe(1);
      expect(mail.sent.some((x) => x.kind === "two_factor_changed")).toBe(true);
      const ch = await db.twoFactorChallenge.findFirstOrThrow({ where: { userId: U } });
      expect(ch.closedReason).toBe("VERIFIED");
    });

    it("reenvío: uno cada 60 s; pedir otro cierra el anterior como REPLACED", async () => {
      const U = await profile();
      session(U);
      expect(await requestEmailCode("enroll_email")).toMatchObject({ ok: true });
      const again = await requestEmailCode("enroll_email");
      expect(again).toEqual({ ok: false, error: expect.stringMatching(/Podés pedir otro en \d+ s/) });
      await ageChallenges(U);
      expect(await requestEmailCode("enroll_email")).toMatchObject({ ok: true });
      const rows = await db.twoFactorChallenge.findMany({ where: { userId: U }, orderBy: { createdAt: "asc" } });
      expect(rows.map((r) => r.closedReason)).toEqual(["REPLACED", null]);
    });

    it("5 por hora por usuario, aunque sean sesiones distintas", async () => {
      const U = await profile();
      const now = new Date();
      for (let i = 0; i < 5; i++) {
        expect((await issueEmailChallenge({ userId: U, purpose: "LOGIN", sessionId: `s${i}`, now })).kind).toBe("issued");
      }
      expect(await issueEmailChallenge({ userId: U, purpose: "LOGIN", sessionId: "s9", now })).toMatchObject({ kind: "hourly_limit" });
    });

    it("login: 5 intentos fallidos → LOCKED y el código bueno ya no sirve; uso único", async () => {
      const U = await profile();
      await enableEmail(U);
      // Sesión nueva: la 2FA queda pendiente.
      session(U);
      cookies().delete(TWO_FACTOR_COOKIE);
      expect((await getAccessSnapshot())?.twoFactor.state).toBe("required");
      await ageChallenges(U);
      expect(await requestEmailCode("login")).toMatchObject({ ok: true });
      const code = lastCode();
      for (let left = 4; left >= 1; left--) {
        const r = await verifyEmailCode("login", wrong(code));
        expect(r).toEqual({ ok: false, error: expect.stringContaining(left === 1 ? "queda 1 intento" : `quedan ${left} intentos`) });
      }
      expect(await verifyEmailCode("login", wrong(code))).toEqual({ ok: false, error: expect.stringMatching(/demasiadas veces/) });
      expect(await verifyEmailCode("login", code)).toEqual({ ok: false, error: expect.stringMatching(/No hay un código pendiente/) });
      const locked = await db.twoFactorChallenge.findFirstOrThrow({ where: { userId: U, purpose: "LOGIN" } });
      expect(locked).toMatchObject({ closedReason: "LOCKED", attempts: 5 });
      expect(await db.userSecurityEvent.count({ where: { userId: U, kind: "two_factor.email_code_locked" } })).toBe(1);
      expect(cookies().get(TWO_FACTOR_COOKIE)).toBeUndefined();

      // Otro código, bien puesto: entra; el mismo código otra vez ya no sirve.
      await ageChallenges(U);
      expect(await requestEmailCode("login")).toMatchObject({ ok: true });
      const good = lastCode();
      expect(await verifyEmailCode("login", good)).toEqual({ ok: true, data: undefined });
      expect((await getAccessSnapshot())?.twoFactor.state).toBe("satisfied");
      cookies().delete(TWO_FACTOR_COOKIE);
      expect(await verifyEmailCode("login", good)).toEqual({ ok: false, error: expect.stringMatching(/No hay un código pendiente/) });
    });

    it("vencido (10 min) → EXPIRED", async () => {
      const U = await profile();
      await enableEmail(U);
      session(U);
      cookies().delete(TWO_FACTOR_COOKIE);
      await ageChallenges(U);
      expect(await requestEmailCode("login")).toMatchObject({ ok: true });
      const code = lastCode();
      await db.$executeRaw`UPDATE "TwoFactorChallenge" SET "createdAt" = now() - interval '20 minutes', "expiresAt" = now() - interval '10 minutes' WHERE "userId" = ${U} AND "closedAt" IS NULL`;
      expect(await verifyEmailCode("login", code)).toEqual({ ok: false, error: "El código venció. Pedí uno nuevo." });
      expect((await db.twoFactorChallenge.findFirstOrThrow({ where: { userId: U, purpose: "LOGIN" } })).closedReason).toBe("EXPIRED");
    });

    it("atado a la sesión: el código de una sesión no sirve en otra (ni la cookie)", async () => {
      const U = await profile();
      await enableEmail(U);
      const A = session(U);
      cookies().delete(TWO_FACTOR_COOKIE);
      await ageChallenges(U);
      expect(await requestEmailCode("login")).toMatchObject({ ok: true });
      const code = lastCode();
      session(U); // otra sesión del mismo usuario
      expect(await verifyEmailCode("login", code)).toEqual({ ok: false, error: expect.stringMatching(/No hay un código pendiente/) });
      // De vuelta en A sí sirve; la cookie que deja no vale en otra sesión.
      session(U, A);
      expect(await verifyEmailCode("login", code)).toEqual({ ok: true, data: undefined });
      expect((await getAccessSnapshot())?.twoFactor.state).toBe("satisfied");
      session(U);
      expect((await getAccessSnapshot())?.twoFactor.state).toBe("required");
    });
  });

  describe("códigos de recuperación", () => {
    it("un uso: pone la cookie de sesión, avisa por mail y no sirve dos veces", async () => {
      const U = await profile();
      const codes = await enableEmail(U);
      session(U);
      cookies().delete(TWO_FACTOR_COOKIE);
      expect((await getAccessSnapshot())?.twoFactor.state).toBe("required");
      mail.sent.length = 0;
      expect(await redeemRecoveryCode(codes[3].toUpperCase())).toEqual({ ok: true, data: { remaining: 9 } });
      expect((await getAccessSnapshot())?.twoFactor.state).toBe("satisfied");
      expect(mail.sent.map((m) => m.kind)).toEqual(["recovery_codes_used"]);
      expect(await redeemRecoveryCode(codes[3])).toEqual({ ok: false, error: expect.stringMatching(/no es válido o ya se usó/) });
      expect(await redeemRecoveryCode("zzzzz-zzzzz")).toMatchObject({ ok: false });
      expect(await db.userSecurityEvent.count({ where: { userId: U, kind: "two_factor.recovery_used" } })).toBe(1);
    });

    it("regenerar exige step-up y anula los anteriores", async () => {
      const U = await profile();
      const codes = await enableEmail(U);
      cookies().delete(STEP_UP_COOKIE);
      const err = await regenerateRecoveryCodes().catch((e) => e);
      expect(classifyStepUpError(err)).toEqual({ kind: "step_up" });
      // Step-up por email.
      await ageChallenges(U);
      expect(await requestEmailCode("step_up")).toMatchObject({ ok: true });
      expect(await verifyEmailCode("step_up", lastCode())).toEqual({ ok: true, data: undefined });
      const r = await regenerateRecoveryCodes();
      if (!r.ok) throw new Error(r.error);
      expect(r.data.recoveryCodes).toHaveLength(10);
      expect(await redeemRecoveryCode(codes[0])).toMatchObject({ ok: false });
      expect(await redeemRecoveryCode(r.data.recoveryCodes[0])).toMatchObject({ ok: true });
    });
  });

  describe("TOTP (fake de GoTrue)", () => {
    it("enrolar, entrar con el código y step-up", async () => {
      const U = await profile();
      session(U);
      const st = await startTotpEnrollment();
      if (!st.ok) throw new Error(st.error);
      expect(st.data).toMatchObject({ existing: false, qrCode: expect.stringMatching(/^data:image\/svg\+xml/) });
      expect(await confirmTotpEnrollment(st.data.factorId, "000000")).toMatchObject({ ok: false });
      expect((await db.userProfile.findUniqueOrThrow({ where: { id: U } })).twoFactorTotp).toBe(false);
      const ok = await confirmTotpEnrollment(st.data.factorId, mfa.goodCode);
      expect(ok).toMatchObject({ ok: true, data: { recoveryCodes: expect.any(Array) } });
      expect((await db.userProfile.findUniqueOrThrow({ where: { id: U } })).twoFactorTotp).toBe(true);

      // Login nuevo (AAL1): pendiente; con el código de la app pasa a AAL2 (GoTrue reescribe el token).
      session(U, `sess-${uniqueSuffix()}`, "aal1");
      expect((await getAccessSnapshot())?.twoFactor.state).toBe("required");
      expect(await startTotpEnrollment()).toEqual({ ok: false, error: expect.stringMatching(/terminá de verificar/) });
      expect(await verifyLoginTotp("123 455")).toMatchObject({ ok: false });
      expect(await verifyLoginTotp(mfa.goodCode)).toEqual({ ok: true, data: undefined });
      tok.claims = { ...tok.claims!, aal: "aal2" };
      expect((await getAccessSnapshot())?.twoFactor.state).toBe("satisfied");

      cookies().delete(STEP_UP_COOKIE);
      await expect(requireStepUp({ userId: U })).rejects.toMatchObject({ digest: "KINE_STEP_UP_REQUIRED" });
      expect(await verifyStepUpTotp(mfa.goodCode)).toEqual({ ok: true, data: undefined });
      await expect(requireStepUp({ userId: U })).resolves.toBeUndefined();
    });

    it("apagar TOTP exige step-up; borra el factor, el flag y (último método) los códigos", async () => {
      const U = await profile();
      session(U);
      const st = await startTotpEnrollment();
      if (!st.ok) throw new Error(st.error);
      await confirmTotpEnrollment(st.data.factorId, mfa.goodCode);
      cookies().delete(STEP_UP_COOKIE);
      session(U, `sess-${uniqueSuffix()}`, "aal2");
      expect(classifyStepUpError(await disableMethod("totp").catch((e) => e))).toEqual({ kind: "step_up" });
      expect(await verifyStepUpTotp(mfa.goodCode)).toMatchObject({ ok: true });
      const r = await disableMethod("totp");
      expect(r).toEqual({ ok: true, data: { changed: true, signedOut: false } });
      expect(mfa.factors).toHaveLength(0);
      const p = await db.userProfile.findUniqueOrThrow({ where: { id: U } });
      expect(p.twoFactorTotp).toBe(false);
      // Era el último método: sin códigos de recuperación.
      expect(await db.twoFactorRecoveryCode.count({ where: { userId: U } })).toBe(0);
    });
  });

  describe("requireStepUp (contrato para PL-2b/PL-3)", () => {
    it("sin método → KINE_2FA_SETUP_REQUIRED; con método y sin cookie → KINE_STEP_UP_REQUIRED; con cookie pasa", async () => {
      const U = await profile();
      session(U);
      const e1 = await requireStepUp({ userId: U }).catch((e) => e);
      expect(classifyStepUpError(e1)).toEqual({ kind: "setup" });
      await enableEmail(U); // deja step-up fresco
      await expect(requireStepUp({ userId: U })).resolves.toBeUndefined();
      cookies().delete(STEP_UP_COOKIE);
      expect(classifyStepUpError(await requireStepUp({ userId: U }).catch((e) => e))).toEqual({ kind: "step_up" });
      // Otro usuario no hereda nada.
      await expect(requireStepUp({ userId: "otro" })).rejects.toBeInstanceOf(UnauthenticatedError);
    });
  });

  describe("Plataforma", () => {
    it("requirePlatformAdmin corta con two_factor si la 2FA del superadmin está pendiente", async () => {
      const S = await profile({ admin: true });
      session(S);
      await expect(requirePlatformAdmin()).resolves.toMatchObject({ userId: S });
      await db.userProfile.update({ where: { id: S }, data: { twoFactorEmail: true } });
      const err = await requirePlatformAdmin("platform.read").catch((e) => e);
      expect(err).toBeInstanceOf(UnauthenticatedError);
      expect((err as UnauthenticatedError).reason).toBe("two_factor");
      // Tampoco por la puerta del segundo paso de Plataforma (sumar un TOTP propio salteando el email).
      expect(((await requirePlatformAdmin("mfa.enroll", { mfaStep: true }).catch((e) => e)) as UnauthenticatedError).reason).toBe("two_factor");
    });

    it("el superadmin resetea la 2FA de otra persona: flags, códigos, factores, evento, registro y mail", async () => {
      const S = await profile({ admin: true });
      const U = await profile();
      await enableEmail(U);
      await db.userProfile.update({ where: { id: U }, data: { twoFactorTotp: true } });
      gotrue.factors.set(U, [{ id: "f-1", factorType: "totp", status: "verified" }]);

      // PL-Z (a2#4): `user.two_factor.reset` es high; con MFA off pide el step-up de la 2FA del superadmin. Sin 2FA →
      // setup; activarla deja el step-up fresco de esta sesión.
      session(S);
      expect(classifyStepUpError(await resetPlatformUserTwoFactor({ userId: U }).catch((e) => e))).toEqual({ kind: "setup" });
      expect((await db.userProfile.findUniqueOrThrow({ where: { id: U } })).twoFactorEmail).toBe(true);
      await enableEmail(S);
      mail.sent.length = 0;
      const r = await resetPlatformUserTwoFactor({ userId: U });
      expect(r).toEqual({ ok: true, data: { hadAny: true, factorsRemoved: 1, authSynced: true } });
      const p = await db.userProfile.findUniqueOrThrow({ where: { id: U } });
      expect(p).toMatchObject({ twoFactorEmail: false, twoFactorTotp: false });
      expect(await db.twoFactorRecoveryCode.count({ where: { userId: U } })).toBe(0);
      expect(gotrue.factors.get(U)).toEqual([]);
      const ev = await db.userSecurityEvent.findFirstOrThrow({ where: { userId: U, kind: "two_factor.reset_by_platform" } });
      expect(ev.payload).toMatchObject({ byUserId: S });
      expect(await db.platformAuditEvent.count({ where: { targetUserId: U, action: "platform.user.two_factor_reset" } })).toBe(1);
      expect(mail.sent.map((m) => ({ kind: m.kind, to: m.to }))).toEqual([{ kind: "two_factor_changed", to: `${U}@test.local` }]);

      // A sí mismo no; un no superadmin rebota sin escribir.
      expect(await resetPlatformUserTwoFactor({ userId: S })).toMatchObject({ ok: false });
      session(U);
      await expect(resetPlatformUserTwoFactor({ userId: S })).rejects.toThrow();
    });

    it("[PL-Z] a2#4 acción high con MFA off: sin step-up fresco → digest de step-up; con step-up pasa; low no lo pide", async () => {
      const S = await profile({ admin: true });
      await enableEmail(S);
      await expect(requirePlatformAdmin("user.disable")).resolves.toMatchObject({ userId: S });
      cookies().delete(STEP_UP_COOKIE);
      expect(classifyStepUpError(await requirePlatformAdmin("user.disable").catch((e) => e))).toEqual({ kind: "step_up" });
      await expect(requirePlatformAdmin("platform.read")).resolves.toMatchObject({ userId: S });
      await ageChallenges(S);
      expect(await requestEmailCode("step_up")).toMatchObject({ ok: true });
      expect(await verifyEmailCode("step_up", lastCode())).toEqual({ ok: true, data: undefined });
      await expect(requirePlatformAdmin("user.disable")).resolves.toMatchObject({ userId: S });
    });

    it("[PL-Z] a2#8 un superadmin no resetea la 2FA de otro superadmin (nada cambia)", async () => {
      const S = await profile({ admin: true });
      const S2 = await profile({ admin: true });
      await enableEmail(S2);
      await enableEmail(S);
      mail.sent.length = 0;
      const r = await resetPlatformUserTwoFactor({ userId: S2 });
      expect(r).toEqual({ ok: false, error: expect.stringMatching(/otro superadmin/) });
      expect((await db.userProfile.findUniqueOrThrow({ where: { id: S2 } })).twoFactorEmail).toBe(true);
      expect(await db.twoFactorRecoveryCode.count({ where: { userId: S2, usedAt: null } })).toBe(10);
      expect(await db.platformAuditEvent.count({ where: { targetUserId: S2, action: "platform.user.two_factor_reset" } })).toBe(0);
      expect(mail.sent).toHaveLength(0);
    });

    it("[PL-Z] a2#3 /plataforma-mfa/configurar: con 2FA por usuario, sumar el TOTP de Plataforma pide step-up", async () => {
      const S = await profile({ admin: true });
      await enableEmail(S);
      cookies().delete(STEP_UP_COOKIE);
      expect(classifyStepUpError(await startPlatformMfaEnrollment().catch((e) => e))).toEqual({ kind: "step_up" });
      expect(classifyStepUpError(await confirmPlatformMfaEnrollment("f-x", mfa.goodCode).catch((e) => e))).toEqual({ kind: "step_up" });
      expect(mfa.factors).toHaveLength(0);
      await ageChallenges(S);
      expect(await requestEmailCode("step_up")).toMatchObject({ ok: true });
      expect(await verifyEmailCode("step_up", lastCode())).toMatchObject({ ok: true });
      const st = await startPlatformMfaEnrollment();
      expect(st).toMatchObject({ ok: true });
    });
  });

  describe("[PL-Z] cortes de la 2FA pendiente", () => {
    it("a2#1 aal2 de un TOTP enrolado directo contra GoTrue (sin el flag) no saltea el código por email", async () => {
      const U = await profile();
      await enableEmail(U);
      // Login nuevo con solo la contraseña + un factor propio verificado por la API de GoTrue → AAL2, sin `kine_2fa`.
      session(U, `sess-${uniqueSuffix()}`, "aal2");
      expect((await getAccessSnapshot())?.twoFactor.state).toBe("required");
      // Con el flag de la app prendido (el TOTP es el suyo), AAL2 sí alcanza.
      await db.userProfile.update({ where: { id: U }, data: { twoFactorTotp: true } });
      expect((await getAccessSnapshot())?.twoFactor.state).toBe("satisfied");
    });

    it("a2#3 con el email prendido, enrolar la app pide step-up (start y confirm); con step-up fresco anda", async () => {
      const U = await profile();
      await enableEmail(U);
      cookies().delete(STEP_UP_COOKIE);
      expect(classifyStepUpError(await startTotpEnrollment().catch((e) => e))).toEqual({ kind: "step_up" });
      expect(classifyStepUpError(await confirmTotpEnrollment("f-x", mfa.goodCode).catch((e) => e))).toEqual({ kind: "step_up" });
      expect(mfa.factors).toHaveLength(0);
      await ageChallenges(U);
      expect(await requestEmailCode("step_up")).toMatchObject({ ok: true });
      expect(await verifyEmailCode("step_up", lastCode())).toMatchObject({ ok: true });
      const st = await startTotpEnrollment();
      if (!st.ok) throw new Error(st.error);
      expect(await confirmTotpEnrollment(st.data.factorId, mfa.goodCode)).toMatchObject({ ok: true, data: { recoveryCodes: null } });
      expect((await db.userProfile.findUniqueOrThrow({ where: { id: U } })).twoFactorTotp).toBe(true);
    });

    it("a2#6 onboarding y aceptar invitación cortan con la 2FA pendiente, sin escribir", async () => {
      const U = await profile();
      await enableEmail(U);
      session(U); // sesión nueva, sin `kine_2fa`
      expect((await getAccessSnapshot())?.twoFactor.state).toBe("required");
      const r1 = await saveOnboardingClinic({ name: "Consultorio PLZ" } as Parameters<typeof saveOnboardingClinic>[0]);
      expect(r1).toEqual({ ok: false, error: "Primero terminá de verificar tu acceso." });
      expect(await db.membership.count({ where: { userId: U } })).toBe(0);
      expect(await acceptInvite("token-que-no-existe")).toEqual({ ok: false, error: "Primero terminá de verificar tu acceso." });
    });
  });
});
