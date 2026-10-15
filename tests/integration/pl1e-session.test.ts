/**
 * PL-1e · sesión v2: `Actor.membership` de la foto, corte de 2FA y escrituras de cuenta en solo lectura.
 *
 * Símbolos REALES (`getActor`, `tryGetActor`, `getAccessSnapshot`, `withAccountWritable`, `runWithRls`,
 * `assertWritable`) contra Postgres en los dos roles. Se mockea solo lo externo: la sesión de Supabase (este archivo
 * pisa el mock del setup para poder darle un access token con `session_id`/`aal`; sin `SUPABASE_JWT_SECRET` la
 * verificación local cae a GoTrue = `getUser(token)` del mock, que es lo que pasa en prod con un secreto distinto),
 * las cookies (`next/headers` del setup) y `next/cache`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { cookies } from "next/headers";
import type { PrismaClient } from "@prisma/client";
import { asUser } from "@/tests/helpers/actor";
import { ownerClient, createEphemeralTenant, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

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
        // Sin claims configurados: como el mock del setup (sin getSession → camino de GoTrue sin token).
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

import { getAccessSnapshot, getActor, tryGetActor, assertWritable, UnauthenticatedError, ReadOnlyModeError } from "@/lib/session";
import { runWithRls } from "@/lib/rls";
import { withAccountWritable } from "@/lib/account-writable";
import { getMemberAccess } from "@/lib/authz";
import { TWO_FACTOR_COOKIE, makeTwoFactorProofValue, setStepUpCookie } from "@/lib/two-factor-cookie";
import { startSupport } from "@/lib/platform-support";
import { SUPPORT_COOKIE } from "@/lib/support-session-internal";

const RUN = process.env.INTEGRATION === "1";
const ACCOUNT_ACTION = "lib/support-threads.ts#createSupportThread";

describe.skipIf(!RUN)("[PL-1e] sesión v2", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db, { saasPlan: "CONSULTORIO" });
  });
  afterAll(async () => {
    await A?.cleanup();
    await db?.$disconnect();
  });
  beforeEach(() => {
    tok.claims = null;
    cookies().delete(TWO_FACTOR_COOKIE);
    asUser(A.userId);
  });

  describe("Actor.membership y plan SaaS", () => {
    afterEach(async () => {
      await db.membership.update({
        where: { userId_tenantId: { userId: A.userId, tenantId: A.tenantId } },
        data: { clinical: true, grantSettings: false, grantBilling: false },
      });
    });

    it("Titular que atiende: membership de la foto, con profesional, plan = saasPlan", async () => {
      const actor = await getActor();
      expect(actor.membership).toEqual({ role: "OWNER", clinical: true, grantSettings: false, grantBilling: false });
      expect(actor.practitionerId).toBe(A.practitionerId);
      expect(actor.entitlements.plan).toBe("CONSULTORIO");
      // `getMemberAccess` devuelve lo del Actor (sin query: el techo de createBooking lo vigila aparte).
      expect(await getMemberAccess(actor)).toEqual(actor.membership);
    });

    it("Titular NO clínico (clinical=false): membership refleja la fila y no «es» profesional", async () => {
      await db.membership.update({
        where: { userId_tenantId: { userId: A.userId, tenantId: A.tenantId } },
        data: { clinical: false, grantBilling: true },
      });
      const actor = await getActor();
      expect(actor.membership).toEqual({ role: "OWNER", clinical: false, grantSettings: false, grantBilling: true });
      // Tiene una fila Practitioner (la factory la crea), pero un no clínico nunca la usa.
      expect(actor.practitionerId).toBeNull();
    });
  });

  describe("corte de 2FA", () => {
    afterEach(async () => {
      await db.userProfile.update({ where: { id: A.userId }, data: { twoFactorEmail: false, twoFactorTotp: false } });
    });

    it("sin 2FA: entra, estado not_enabled", async () => {
      expect((await getAccessSnapshot())?.twoFactor).toEqual({ methods: { totp: false, email: false }, state: "not_enabled" });
      expect((await getActor()).tenantId).toBe(A.tenantId);
    });

    it("2FA por email prendida y sin prueba → getActor tira two_factor; tryGetActor null", async () => {
      await db.userProfile.update({ where: { id: A.userId }, data: { twoFactorEmail: true } });
      tok.claims = { session_id: "sess-1", aal: "aal1" };
      expect((await getAccessSnapshot())?.twoFactor.state).toBe("required");
      const err = await getActor().catch((e) => e);
      expect(err).toBeInstanceOf(UnauthenticatedError);
      expect((err as UnauthenticatedError).reason).toBe("two_factor");
      expect(await tryGetActor()).toBeNull();
    });

    it("sin session_id (camino sin token) la 2FA prendida corta igual: nunca abre por descarte", async () => {
      await db.userProfile.update({ where: { id: A.userId }, data: { twoFactorEmail: true } });
      cookies().set(TWO_FACTOR_COOKIE, makeTwoFactorProofValue("session", A.userId, "sess-1"));
      const err = await getActor().catch((e) => e);
      expect((err as UnauthenticatedError).reason).toBe("two_factor");
    });

    it("con la cookie kine_2fa de ESTA sesión → entra; la de otra sesión → no", async () => {
      await db.userProfile.update({ where: { id: A.userId }, data: { twoFactorEmail: true } });
      tok.claims = { session_id: "sess-1", aal: "aal1" };
      cookies().set(TWO_FACTOR_COOKIE, makeTwoFactorProofValue("session", A.userId, "sess-1"));
      expect((await getAccessSnapshot())?.twoFactor.state).toBe("satisfied");
      expect((await getActor()).tenantId).toBe(A.tenantId);

      tok.claims = { session_id: "sess-2", aal: "aal1" };
      expect(((await getActor().catch((e) => e)) as UnauthenticatedError).reason).toBe("two_factor");
    });

    it("TOTP con sesión AAL2 → entra sin cookie; con AAL1 → corta", async () => {
      await db.userProfile.update({ where: { id: A.userId }, data: { twoFactorTotp: true } });
      tok.claims = { session_id: "sess-3", aal: "aal2" };
      expect((await getActor()).tenantId).toBe(A.tenantId);
      tok.claims = { session_id: "sess-3", aal: "aal1" };
      expect(((await getActor().catch((e) => e)) as UnauthenticatedError).reason).toBe("two_factor");
    });
  });

  describe("solo lectura + withAccountWritable", () => {
    let H: EphemeralTenant;
    const prev = process.env.TENANT_ACCESS_ENFORCEMENT;
    const writePatient = (tag: string) =>
      runWithRls(A.tenantId, (tx) =>
        tx.patient.create({ data: { tenantId: A.tenantId, firstName: "Cuenta", lastName: tag }, select: { id: true } })
      );

    beforeAll(async () => {
      H = await createEphemeralTenant(db);
      await db.userProfile.update({ where: { id: H.userId }, data: { isPlatformAdmin: true } });
      // Suscripción cancelada → `read_only` con el modo efectivo `enforce` (molde readonly-config).
      await db.tenant.update({ where: { id: A.tenantId }, data: { subscriptionStatus: "CANCELLED" } });
      process.env.TENANT_ACCESS_ENFORCEMENT = "enforce";
    });
    afterAll(async () => {
      if (prev === undefined) delete process.env.TENANT_ACCESS_ENFORCEMENT;
      else process.env.TENANT_ACCESS_ENFORCEMENT = prev;
      if (db) {
        await db.tenant.update({ where: { id: A.tenantId }, data: { subscriptionStatus: "ACTIVE" } });
        await db.supportSession.deleteMany({ where: { superadminId: H?.userId } });
      }
      cookies().delete(SUPPORT_COOKIE);
      await H?.cleanup();
    });

    it("el Titular: fuera de la allowlist NO escribe; dentro de withAccountWritable SÍ (y assertWritable lo deja)", async () => {
      const actor = await getActor();
      await expect(writePatient("fuera")).rejects.toBeInstanceOf(ReadOnlyModeError);
      expect(() => assertWritable(actor)).toThrow(ReadOnlyModeError);

      const row = await withAccountWritable(ACCOUNT_ACTION, async () => {
        assertWritable(await getActor());
        return writePatient("dentro");
      });
      expect(await db.patient.count({ where: { id: row.id, tenantId: A.tenantId } })).toBe(1);
      expect(await db.patient.count({ where: { tenantId: A.tenantId, lastName: "fuera" } })).toBe(0);

      // El flag no se filtra a lo que el request haga después.
      await expect(writePatient("despues")).rejects.toBeInstanceOf(ReadOnlyModeError);
    });

    it("el soporte: withAccountWritable no le abre nada", async () => {
      cookies().delete(SUPPORT_COOKIE);
      // PL-Z (a2#4): `support.start` es high y con MFA off pide el step-up de la 2FA del superadmin: TOTP + AAL2 +
      // step-up fresco de esta sesión (molde de pl3b-team `withStepUp`).
      await db.userProfile.update({ where: { id: H.userId }, data: { twoFactorTotp: true } });
      tok.claims = { session_id: "sess-support", aal: "aal2" };
      asUser(H.userId);
      setStepUpCookie(H.userId, "sess-support");
      const r = await startSupport(A.tenantId, "Ayuda con el pago del consultorio");
      if (!r.ok) throw new Error(r.error);
      const actor = await getActor();
      expect(actor.support).not.toBeNull();
      expect(actor.membership).toBeNull();
      await expect(
        withAccountWritable(ACCOUNT_ACTION, async () => {
          expect(() => assertWritable(actor)).toThrow(ReadOnlyModeError);
          return writePatient("soporte");
        })
      ).rejects.toBeInstanceOf(ReadOnlyModeError);
      expect(await db.patient.count({ where: { tenantId: A.tenantId, lastName: "soporte" } })).toBe(0);
      cookies().delete(SUPPORT_COOKIE);
    });
  });
});
