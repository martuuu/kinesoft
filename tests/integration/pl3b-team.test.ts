/**
 * [PL-3b] Equipo: lo que solo hace el Titular (C-PL5, PL-D11; decisiones de Martin del 15-oct) contra Postgres en los
 * dos roles (`kinesoft_app` con RLS y owner BYPASSRLS).
 *
 * Símbolos REALES: `setMemberClinical`, `setMemberGrants`, `transferOwnership`, `changeMemberRole`,
 * `listTeamMembers` (lib/invitations.ts), `platformSetMemberClinical` / `platformSetMemberGrants`
 * (lib/platform-team.ts), `assignPatientToPractitioner` (lib/patients.ts), `requireAccountOwner` y `requireStepUp`
 * con la cookie de step-up de verdad. Se mockea solo la sesión de Supabase con un access token con `session_id`/`aal`
 * (molde de saas-billing.test.ts) para que la 2FA y el step-up corran.
 *
 * Se fija: no Titular → Forbidden (también el Administrador/a, y soporte nunca llega); el Administrador/a no se hace
 * clínico; sin 2FA → digest de setup, sin step-up → digest de step-up, y nada cambia; `setMemberGrants` nunca sobre el
 * Titular; transferir solo por `transferOwnership` (el selector de rol ya no lo hace sin step-up); dos transferencias
 * simultáneas → un solo Titular; la reasignación de pacientes y la gestión del equipo por `tenant.admin` del miembro.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { cookies } from "next/headers";
import type { PrismaClient, Role } from "@prisma/client";

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

import { ForbiddenError } from "@/lib/session";
import { classifyStepUpError } from "@/lib/two-factor-logic";
import { setStepUpCookie, STEP_UP_COOKIE, TWO_FACTOR_COOKIE } from "@/lib/two-factor-cookie";
import {
  changeMemberRole,
  createInvitation,
  listTeamMembers,
  reactivateMember,
  setMemberClinical,
  setMemberGrants,
  transferOwnership,
} from "@/lib/invitations";
import { platformSetMemberClinical, platformSetMemberGrants } from "@/lib/platform-team";
import { CLINICAL_ASSIGN_MESSAGE } from "@/lib/team-internal";
import { assignPatientToPractitioner } from "@/lib/patients";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { asUser } from "@/tests/helpers/actor";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  addPatient,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("[PL-3b] equipo: Titular, «¿Atiende?», permisos delegados y titularidad", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  const users: string[] = [];

  const membershipOf = (t: EphemeralTenant, userId: string) =>
    db.membership.findUniqueOrThrow({ where: { userId_tenantId: { userId, tenantId: t.tenantId } } });

  /** Miembro sin `Practitioner` (Secretaría, Facturación, Administrador/a de §20.17). */
  async function staff(t: EphemeralTenant, role: Role, grants: { grantSettings?: boolean; grantBilling?: boolean } = {}) {
    const id = `test-user-${uniqueSuffix()}`;
    users.push(id);
    await db.userProfile.create({ data: { id, email: `${id}@test.local`, fullName: `Staff ${role}` } });
    await db.membership.create({
      data: { userId: id, tenantId: t.tenantId, role, clinical: false, acceptedAt: new Date(), ...grants },
    });
    return id;
  }

  /** El Titular (u otro) con 2FA y un step-up fresco de esta sesión. */
  async function withStepUp(userId: string, sessionId = `sess-${uniqueSuffix()}`) {
    await db.userProfile.update({ where: { id: userId }, data: { twoFactorTotp: true } });
    tok.claims = { session_id: sessionId, aal: "aal2" };
    asUser(userId);
    setStepUpCookie(userId, sessionId);
  }

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    B = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
  });

  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    if (db) {
      if (users.length) await db.userProfile.deleteMany({ where: { id: { in: users } } });
      await db.$disconnect();
    }
  });

  beforeEach(async () => {
    __rateLimitInternals.reset();
    tok.claims = null;
    cookies().delete(TWO_FACTOR_COOKIE);
    cookies().delete(STEP_UP_COOKIE);
    await db.userProfile.update({ where: { id: A.userId }, data: { twoFactorTotp: false, twoFactorEmail: false } });
    asUser(A.userId);
  });

  // ── Quién ───────────────────────────────────────────────────────────────────────────────────────────────────

  it("no Titular → Forbidden en las tres (Administrador/a con Configuración, Profesional), sin escribir nada", async () => {
    const adminId = await staff(A, "ADMIN", { grantSettings: true });
    const kine = await addPractitioner(db, A);
    const ownerMem = await membershipOf(A, A.userId);
    const kineMem = await membershipOf(A, kine.userId);
    for (const u of [adminId, kine.userId]) {
      await withStepUp(u); // ni con step-up: la barrera es `account.owner`
      const self = await membershipOf(A, u);
      await expect(setMemberClinical({ membershipId: self.id, clinical: true })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(setMemberGrants({ membershipId: kineMem.id, grantSettings: true, grantBilling: true })).rejects.toBeInstanceOf(
        ForbiddenError
      );
      await expect(transferOwnership(kineMem.id)).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await membershipOf(A, A.userId)).toMatchObject({ id: ownerMem.id, role: "OWNER" });
    expect(await membershipOf(A, kine.userId)).toMatchObject({ role: "PRACTITIONER", grantSettings: false, grantBilling: false });
    expect(await membershipOf(A, adminId)).toMatchObject({ role: "ADMIN", clinical: false });
  });

  it("el Administrador/a no se hace clínico (ni pidiéndolo él, ni el Titular sobre él)", async () => {
    const adminId = await staff(A, "ADMIN", { grantSettings: true });
    const adminMem = await membershipOf(A, adminId);
    await withStepUp(adminId);
    await expect(setMemberClinical({ membershipId: adminMem.id, clinical: true })).rejects.toBeInstanceOf(ForbiddenError);
    await withStepUp(A.userId);
    expect(await setMemberClinical({ membershipId: adminMem.id, clinical: true })).toEqual({
      ok: false,
      error: "Solo podés elegir si atendés vos. El de los demás lo define su rol.",
    });
    expect(await membershipOf(A, adminId)).toMatchObject({ role: "ADMIN", clinical: false });
    expect(await db.practitioner.count({ where: { tenantId: A.tenantId, userId: adminId } })).toBe(0);
  });

  // ── Step-up ─────────────────────────────────────────────────────────────────────────────────────────────────

  it("sin 2FA → digest de setup; con 2FA y sin step-up → digest de step-up; nada cambia", async () => {
    const secId = await staff(A, "ASSISTANT");
    const secMem = await membershipOf(A, secId);
    const ownerMem = await membershipOf(A, A.userId);
    const kine = await addPractitioner(db, A);
    const kineMem = await membershipOf(A, kine.userId);
    const calls = [
      () => setMemberClinical({ membershipId: ownerMem.id, clinical: false }),
      () => setMemberGrants({ membershipId: secMem.id, grantSettings: true, grantBilling: true }),
      () => transferOwnership(kineMem.id),
    ];
    for (const call of calls) expect(classifyStepUpError(await call().catch((e) => e))).toEqual({ kind: "setup" });
    await db.userProfile.update({ where: { id: A.userId }, data: { twoFactorTotp: true } });
    tok.claims = { session_id: "sess-sin-stepup", aal: "aal2" };
    for (const call of calls) expect(classifyStepUpError(await call().catch((e) => e))).toEqual({ kind: "step_up" });
    // Un step-up de OTRA sesión no vale para esta.
    setStepUpCookie(A.userId, "otra-sesion");
    expect(classifyStepUpError(await calls[1]().catch((e) => e))).toEqual({ kind: "step_up" });

    expect(await membershipOf(A, A.userId)).toMatchObject({ role: "OWNER", clinical: true });
    expect(await membershipOf(A, secId)).toMatchObject({ grantSettings: false, grantBilling: false });
    expect(await membershipOf(A, kine.userId)).toMatchObject({ role: "PRACTITIONER" });
  });

  // ── «Atiendo pacientes» ─────────────────────────────────────────────────────────────────────────────────────

  it("el Titular deja de atender y vuelve (con step-up), con audit en tx; sobre otro miembro, no", async () => {
    const T = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    try {
      const ownerMem = await membershipOf(T, T.userId);
      const kine = await addPractitioner(db, T);
      const kineMem = await membershipOf(T, kine.userId);
      await withStepUp(T.userId);
      expect(await setMemberClinical({ membershipId: kineMem.id, clinical: false })).toEqual({
        ok: false,
        error: "Solo podés elegir si atendés vos. El de los demás lo define su rol.",
      });
      expect(await setMemberClinical({ membershipId: ownerMem.id, clinical: false })).toEqual({ ok: true, data: undefined });
      expect(await membershipOf(T, T.userId)).toMatchObject({ role: "OWNER", clinical: false });
      const ev = await db.auditEvent.findFirstOrThrow({
        where: { tenantId: T.tenantId, action: "membership.clinical.change", entityId: ownerMem.id },
        orderBy: { createdAt: "desc" },
      });
      expect(ev).toMatchObject({ actorId: T.userId });
      expect(ev.payload).toMatchObject({ role: "OWNER", clinical: false });
      // La lista del equipo lo refleja: sin ficha de profesional ni turnero.
      const me = (await listTeamMembers()).find((m) => m.isYou)!;
      expect(me).toMatchObject({ clinical: false, hasAgenda: false, practitionerId: null, publicBookingEnabled: false });

      expect(await setMemberClinical({ membershipId: ownerMem.id, clinical: true })).toEqual({ ok: true, data: undefined });
      expect(await membershipOf(T, T.userId)).toMatchObject({ clinical: true });
      const back = (await listTeamMembers()).find((m) => m.isYou)!;
      expect(back).toMatchObject({ clinical: true, practitionerId: T.practitionerId, publicBookingEnabled: true });
    } finally {
      await T.cleanup();
    }
  });

  it("un id de otro consultorio = no encontrado", async () => {
    await withStepUp(A.userId);
    const bMem = await membershipOf(B, B.userId);
    expect(await setMemberClinical({ membershipId: bMem.id, clinical: false })).toEqual({ ok: false, error: "Miembro no encontrado." });
    expect(await setMemberGrants({ membershipId: bMem.id, grantSettings: true, grantBilling: true })).toEqual({
      ok: false,
      error: "Miembro no encontrado.",
    });
    expect(await membershipOf(B, B.userId)).toMatchObject({ role: "OWNER", clinical: true });
  });

  // ── Permisos delegados ──────────────────────────────────────────────────────────────────────────────────────

  it("setMemberGrants: el Titular delega a cualquier rol (audit de/a) y nunca sobre el Titular", async () => {
    const secId = await staff(A, "ASSISTANT");
    const secMem = await membershipOf(A, secId);
    await withStepUp(A.userId);
    expect(await setMemberGrants({ membershipId: secMem.id, grantSettings: true, grantBilling: true })).toEqual({
      ok: true,
      data: undefined,
    });
    expect(await membershipOf(A, secId)).toMatchObject({ role: "ASSISTANT", grantSettings: true, grantBilling: true });
    const ev = await db.auditEvent.findFirstOrThrow({
      where: { tenantId: A.tenantId, action: "membership.grants.change", entityId: secMem.id },
    });
    expect(ev.payload).toMatchObject({
      from: { grantSettings: false, grantBilling: false },
      to: { grantSettings: true, grantBilling: true },
    });

    const ownerMem = await membershipOf(A, A.userId);
    expect(await setMemberGrants({ membershipId: ownerMem.id, grantSettings: false, grantBilling: false })).toEqual({
      ok: false,
      error: "El titular ya tiene todos los permisos.",
    });
    expect(await membershipOf(A, A.userId)).toMatchObject({ role: "OWNER" });
    // Datos inválidos: no llega a la base.
    expect(await setMemberGrants({ membershipId: secMem.id, grantSettings: "si", grantBilling: true } as never)).toEqual({
      ok: false,
      error: "Datos inválidos",
    });
  });

  // ── Titularidad ─────────────────────────────────────────────────────────────────────────────────────────────

  it("el selector de rol ya no transfiere (sin step-up); `transferOwnership` sí, y el anterior queda Profesional con «Configuración»", async () => {
    const T = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    try {
      const kine = await addPractitioner(db, T);
      const kineMem = await membershipOf(T, kine.userId);
      asUser(T.userId);
      expect(await changeMemberRole(kineMem.id, "OWNER")).toEqual({
        ok: false,
        error: "Para transferir la titularidad usá «Transferir titularidad»: pide confirmar con tu código.",
      });
      expect(await membershipOf(T, kine.userId)).toMatchObject({ role: "PRACTITIONER" });

      await withStepUp(T.userId);
      expect(await transferOwnership(kineMem.id)).toEqual({ ok: true, data: undefined });
      expect(await membershipOf(T, kine.userId)).toMatchObject({ role: "OWNER", clinical: true });
      expect(await membershipOf(T, T.userId)).toMatchObject({ role: "PRACTITIONER", clinical: true, grantSettings: true });
      expect(await db.membership.count({ where: { tenantId: T.tenantId, role: "OWNER" } })).toBe(1);
      // El anterior ya no es Titular: no puede volver a transferir ni delegar.
      await expect(transferOwnership(kineMem.id)).rejects.toBeInstanceOf(ForbiddenError);
    } finally {
      await T.cleanup();
    }
  });

  it("[BO-Z B1] dos transferencias simultáneas del mismo Titular (a X y a Y) → exactamente un Titular", async () => {
    const T = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    try {
      const x = await addPractitioner(db, T);
      const y = await addPractitioner(db, T);
      const mx = await membershipOf(T, x.userId);
      const my = await membershipOf(T, y.userId);
      await withStepUp(T.userId);
      const results = await Promise.all([transferOwnership(mx.id), transferOwnership(my.id)]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.find((r) => !r.ok)).toEqual({ ok: false, error: "El rol cambió mientras tanto. Recargá y probá de nuevo." });
      const owners = await db.membership.findMany({ where: { tenantId: T.tenantId, role: "OWNER" }, select: { userId: true } });
      expect(owners).toHaveLength(1);
      expect([x.userId, y.userId]).toContain(owners[0].userId);
      expect((await membershipOf(T, T.userId)).role).toBe("PRACTITIONER");
    } finally {
      await T.cleanup();
    }
  });

  // ── Por miembro, no por rol ─────────────────────────────────────────────────────────────────────────────────

  it("gestionar el equipo y reasignar pacientes es de quien tiene «Configuración» (`tenant.admin`), no del rol", async () => {
    const kine = await addPractitioner(db, A);
    const patientId = await addPatient(db, A, { firstName: "Reasig", lastName: "Nable" });
    const secWithSettings = await staff(A, "ASSISTANT", { grantSettings: true });
    const adminWithout = await staff(A, "ADMIN", { grantSettings: false });

    // Secretaria con «Configuración»: ve el equipo y reasigna.
    asUser(secWithSettings);
    expect((await listTeamMembers()).some((m) => m.isYou)).toBe(true);
    expect(await assignPatientToPractitioner({ patientId, practitionerId: kine.practitionerId })).toEqual({
      ok: true,
      data: undefined,
    });
    expect((await db.patient.findUniqueOrThrow({ where: { id: patientId } })).assignedPractitionerId).toBe(kine.practitionerId);
    // PL-Z (pendiente b): una sola tx, el audit con el `from` leído bajo lock; y el input es estricto.
    const ev = await db.auditEvent.findFirstOrThrow({
      where: { tenantId: A.tenantId, action: "patient.reassign", entityId: patientId },
      orderBy: { createdAt: "desc" },
    });
    expect(ev.payload).toMatchObject({ to: kine.practitionerId });
    expect(
      await assignPatientToPractitioner({ patientId, practitionerId: A.practitionerId, extra: 1 } as never)
    ).toEqual({ ok: false, error: "Datos inválidos" });
    expect(await assignPatientToPractitioner({ patientId: "no-existe", practitionerId: A.practitionerId })).toEqual({
      ok: false,
      error: "Paciente no encontrado.",
    });
    expect((await db.patient.findUniqueOrThrow({ where: { id: patientId } })).assignedPractitionerId).toBe(kine.practitionerId);

    // Administrador/a al que el Titular le sacó «Configuración»: ni equipo ni reasignación.
    asUser(adminWithout);
    await expect(listTeamMembers()).rejects.toBeInstanceOf(ForbiddenError);
    const r = await assignPatientToPractitioner({ patientId, practitionerId: A.practitionerId });
    expect(r.ok).toBe(false);
    expect((await db.patient.findUniqueOrThrow({ where: { id: patientId } })).assignedPractitionerId).toBe(kine.practitionerId);
  });

  // ── PL-Z: escalada a la HC y step-up para Administrador/a ──────────────────────────────────────────────────

  it("[PL-Z] a3#5: quien gestiona el equipo sin atender ni ser Titular no suma a nadie que atiende", async () => {
    const T = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    try {
      const secWithSettings = await staff(T, "ASSISTANT", { grantSettings: true });
      const otherSec = await staff(T, "ASSISTANT");
      const otherSecMem = await membershipOf(T, otherSec);
      const kine = await addPractitioner(db, T);
      const kineMem = await membershipOf(T, kine.userId);
      await db.membership.update({
        where: { id: kineMem.id },
        data: { disabledAt: new Date(), disabledById: T.userId, disabledReason: "MANUAL" },
      });

      asUser(secWithSettings);
      const email = `esc-${uniqueSuffix()}@test.local`;
      expect(await createInvitation({ email, firstName: "Mi", lastName: "Otra", role: "PRACTITIONER" })).toEqual({
        ok: false,
        error: CLINICAL_ASSIGN_MESSAGE,
      });
      expect(await db.invitation.count({ where: { tenantId: T.tenantId, email } })).toBe(0);
      expect(await changeMemberRole(otherSecMem.id, "PRACTITIONER")).toEqual({ ok: false, error: CLINICAL_ASSIGN_MESSAGE });
      expect(await membershipOf(T, otherSec)).toMatchObject({ role: "ASSISTANT", clinical: false });
      expect(await reactivateMember(kineMem.id)).toEqual({ ok: false, error: CLINICAL_ASSIGN_MESSAGE });
      expect((await membershipOf(T, kine.userId)).disabledAt).not.toBeNull();
      // Lo no clínico lo sigue gestionando.
      expect(await changeMemberRole(otherSecMem.id, "BILLING")).toEqual({ ok: true, data: undefined });

      // Un Profesional con «Configuración» sí (él mismo ve HC).
      const kine2 = await addPractitioner(db, T);
      await db.membership.update({ where: { userId_tenantId: { userId: kine2.userId, tenantId: T.tenantId } }, data: { grantSettings: true } });
      asUser(kine2.userId);
      expect(await reactivateMember(kineMem.id)).toEqual({ ok: true, data: undefined });
      expect((await membershipOf(T, kine.userId)).disabledAt).toBeNull();
    } finally {
      await T.cleanup();
    }
  });

  it("[PL-Z] a2#7: pasar a alguien a Administrador/a pide step-up (sin él, nada cambia)", async () => {
    const T = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    try {
      await db.userProfile.update({ where: { id: T.userId }, data: { twoFactorTotp: false, twoFactorEmail: false } });
      const secId = await staff(T, "ASSISTANT");
      const secMem = await membershipOf(T, secId);
      asUser(T.userId);
      expect(classifyStepUpError(await changeMemberRole(secMem.id, "ADMIN").catch((e) => e))).toEqual({ kind: "setup" });
      expect(await membershipOf(T, secId)).toMatchObject({ role: "ASSISTANT" });
      // Otro rol no clínico: sin step-up, como siempre.
      expect(await changeMemberRole(secMem.id, "BILLING")).toEqual({ ok: true, data: undefined });
      await withStepUp(T.userId);
      expect(await changeMemberRole(secMem.id, "ADMIN")).toEqual({ ok: true, data: undefined });
      expect(await membershipOf(T, secId)).toMatchObject({ role: "ADMIN", clinical: false });
    } finally {
      await T.cleanup();
    }
  });

  // ── Plataforma ──────────────────────────────────────────────────────────────────────────────────────────────

  describe("desde /plataforma (superadmin, último recurso)", () => {
    let superadminId: string;
    beforeAll(async () => {
      superadminId = `test-user-${uniqueSuffix()}`;
      users.push(superadminId);
      await db.userProfile.create({
        data: { id: superadminId, email: `${superadminId}@test.local`, fullName: "Súper", isPlatformAdmin: true },
      });
    });

    it("un Titular de consultorio no usa las actions de Plataforma", async () => {
      const secMem = await membershipOf(A, await staff(A, "BILLING"));
      asUser(A.userId);
      await expect(
        platformSetMemberGrants({ tenantId: A.tenantId, membershipId: secMem.id, grantSettings: true, grantBilling: true })
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(platformSetMemberClinical({ tenantId: A.tenantId, membershipId: secMem.id, clinical: true })).rejects.toBeInstanceOf(
        ForbiddenError
      );
      expect(await db.membership.findUniqueOrThrow({ where: { id: secMem.id } })).toMatchObject({ grantSettings: false });
    });

    it("permisos y «¿Atiende?» del Titular; nunca permisos sobre el Titular ni «atiende» a un no Titular; audit de plataforma", async () => {
      const T = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
      try {
        const billId = await staff(T, "BILLING");
        const billMem = await membershipOf(T, billId);
        const ownerMem = await membershipOf(T, T.userId);
        // PL-Z (a2#4): las acciones `high` de Plataforma piden step-up si PLATFORM_MFA_ENFORCEMENT != enforce.
        await withStepUp(superadminId);
        expect(
          await platformSetMemberGrants({ tenantId: T.tenantId, membershipId: billMem.id, grantSettings: false, grantBilling: true })
        ).toEqual({ ok: true, data: undefined });
        expect(await membershipOf(T, billId)).toMatchObject({ grantBilling: true, grantSettings: false });
        expect(
          await platformSetMemberGrants({ tenantId: T.tenantId, membershipId: ownerMem.id, grantSettings: false, grantBilling: false })
        ).toEqual({ ok: false, error: "El titular ya tiene todos los permisos." });
        expect((await platformSetMemberClinical({ tenantId: T.tenantId, membershipId: billMem.id, clinical: true })).ok).toBe(false);
        expect(await platformSetMemberClinical({ tenantId: T.tenantId, membershipId: ownerMem.id, clinical: false })).toEqual({
          ok: true,
          data: undefined,
        });
        expect(await membershipOf(T, T.userId)).toMatchObject({ role: "OWNER", clinical: false });
        const ev = await db.auditEvent.findFirstOrThrow({
          where: { tenantId: T.tenantId, action: "platform.membership.grants.change", entityId: billMem.id },
        });
        expect(ev.payload).toMatchObject({ to: { grantBilling: true } });
        // Datos de más → inválido (strict).
        expect(
          (await platformSetMemberGrants({ tenantId: T.tenantId, membershipId: billMem.id, grantSettings: true, grantBilling: true, x: 1 })).ok
        ).toBe(false);
      } finally {
        await T.cleanup();
      }
    });
  });
});
