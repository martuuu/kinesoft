/**
 * [AS-1i] Escalada indirecta a «Planes y pagos» (T3c-1i, seguridad alta; plan §23.3 + handoff «Seguridad» de T3c).
 *
 * El bug: desde T3 (decisión 2 del 19-oct) el Administrador/a entra con «Configuración» Y «Planes y pagos»
 * (`grantsOnEnterRole`), en la invitación y al pasar a ADMIN. Pero gestionar el equipo pide `tenant.sensitive`, que
 * tienen también un Admin al que el Titular le sacó «Planes y pagos» y un Profesional con «Configuración». Cualquiera
 * de los dos podía invitar (o pasar) a OTRA cuenta suya como ADMIN y quedarse por la puerta de atrás con lo que el
 * Titular le negó: cambiar el plan, ver la facturación y subir comprobantes. Y `setMemberGrantsInTx` (delegar) es solo
 * del Titular: el default del rol no puede ser un atajo para lo que delegar a mano no permite.
 *
 * Contrato del fix: el «Planes y pagos» por default al ENTRAR a ADMIN vale solo si quien actúa es el Titular (o el
 * superadmin desde Plataforma, que actúa como Titular) o tiene `account.billing` en ESE consultorio. En la invitación
 * se resuelve AL ACTIVAR con las capacidades de quien la invitó (o la re-invitó por última vez), leídas en la misma tx
 * de la unión. Soporte nunca: no tiene `account.*`.
 *
 * Símbolos reales: `createInvitation` / `changeMemberRole` (lib/invitations.ts) con el `getActor()` real,
 * `activateInvitation` con el fake de GoTrue, `createInvitationInTx` por el canal de Plataforma. Se mockea la cookie de
 * sesión (`asUser`), el step-up de 2FA (frontera TOTP, como authz-matrix), el transporte de mail y GoTrue.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type { PrismaClient, Role } from "@prisma/client";
import { changeMemberRole, createInvitation } from "@/lib/invitations";
import { createInvitationInTx, runTeamTx, type TeamActorCtx } from "@/lib/team-internal";
import { activateInvitation } from "@/lib/invite-activation-internal";
import { __setEmailTransportForTests, type SendEmailInput, type SendEmailResult } from "@/lib/email";
import { __setAuthAdminForTests } from "@/lib/identity/auth-admin";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { GotrueFake } from "@/tests/helpers/gotrue-fake";
import { asAnonymous, asUser } from "@/tests/helpers/actor";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  addStaff,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

// Pasar a ADMIN pide step-up (PL-Z a2#7): frontera externa (TOTP/cookie). La barrera bajo test es real.
vi.mock("@/lib/two-factor-step-up", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/two-factor-step-up")>()),
  requireStepUp: async () => {},
}));

const RUN = process.env.INTEGRATION === "1";

const mail = {
  sent: [] as SendEmailInput[],
  transport: async (i: SendEmailInput): Promise<SendEmailResult> => {
    mail.sent.push(i);
    return { ok: true, transport: "resend", providerId: `re_${mail.sent.length}` };
  },
};

describe.skipIf(!RUN)("[AS-1i] «Planes y pagos» por default al entrar a ADMIN: solo si quien actúa lo puede dar", () => {
  let db: PrismaClient;
  let gotrue: GotrueFake;
  const tenants: EphemeralTenant[] = [];
  const users: string[] = [];
  let ipSeq = 0;

  /** Consultorio Clínica (lugares de sobra para estos 3-4 miembros): se mide el permiso, no el cupo. */
  async function clinic(): Promise<EphemeralTenant> {
    const t = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    tenants.push(t);
    return t;
  }

  /** Profesional (atiende, con `Practitioner`) con «Configuración»: gestiona el equipo (decisión 4), sin «Planes y pagos». */
  async function proWithSettings(t: EphemeralTenant): Promise<string> {
    const p = await addPractitioner(db, t, "PRACTITIONER");
    await db.membership.update({ where: { userId_tenantId: { userId: p.userId, tenantId: t.tenantId } }, data: { grantSettings: true } });
    return p.userId;
  }

  /** Invita por la action real como `actorUserId` y devuelve el token crudo del mail (quien no es Titular no ve la URL). */
  async function invite(t: EphemeralTenant, actorUserId: string, role: Role, email = `as1i-${randomBytes(4).toString("hex")}@example.com`) {
    asUser(actorUserId);
    const before = mail.sent.length;
    const r = await createInvitation({ email, firstName: "In", lastName: "Vitada", role: role as "ADMIN" });
    if (!r.ok) throw new Error(`createInvitation: ${r.error}`);
    const m = /\/invite\/([A-Za-z0-9_-]+)/.exec(mail.sent.slice(before).at(-1)?.text ?? "");
    if (!m) throw new Error("el mail de la invitación no trae el link");
    return { email, rawToken: m[1] };
  }

  async function activate(t: EphemeralTenant, rawToken: string) {
    asAnonymous();
    const a = await activateInvitation(
      { token: rawToken, firstName: "In", lastName: "Vitada", password: "clave-segura-1", passwordConfirm: "clave-segura-1", acceptLegal: true },
      { ip: `203.0.113.${(++ipSeq % 200) + 20}` }
    );
    if (!a.ok) throw new Error(`activateInvitation: ${a.error}`);
    users.push(a.userId);
    return db.membership.findFirstOrThrow({ where: { tenantId: t.tenantId, userId: a.userId } });
  }

  const membershipOf = (t: EphemeralTenant, userId: string) =>
    db.membership.findUniqueOrThrow({ where: { userId_tenantId: { userId, tenantId: t.tenantId } } });

  beforeAll(() => {
    db = ownerClient();
  });
  afterAll(async () => {
    for (const t of tenants) await t.cleanup();
    if (db) {
      if (users.length) {
        await db.userPreferences.deleteMany({ where: { userId: { in: users } } });
        await db.userProfile.deleteMany({ where: { id: { in: users }, practitioners: { none: {} } } });
      }
      await db.$disconnect();
    }
  });
  beforeEach(() => {
    __rateLimitInternals.reset();
    mail.sent = [];
    __setEmailTransportForTests(mail.transport);
    gotrue = new GotrueFake();
    __setAuthAdminForTests(gotrue);
  });
  afterEach(() => {
    __setEmailTransportForTests(null);
    __setAuthAdminForTests(null);
  });

  // ── Invitación ────────────────────────────────────────────────────────────────────────────────────────────

  it("[AS-1i] un Admin SIN «Planes y pagos» invita un Admin → el invitado entra con «Configuración» y sin «Planes y pagos»", async () => {
    const T = await clinic();
    const admin = await addStaff(db, T, "ADMIN", { grantSettings: true, grantBilling: false });
    const { rawToken } = await invite(T, admin.userId, "ADMIN");
    expect(await activate(T, rawToken)).toMatchObject({ role: "ADMIN", clinical: false, grantSettings: true, grantBilling: false });
  });

  it("[AS-1i] un Profesional con «Configuración» invita un Admin → sin «Planes y pagos»", async () => {
    const T = await clinic();
    const pro = await proWithSettings(T);
    const { rawToken } = await invite(T, pro, "ADMIN");
    expect(await activate(T, rawToken)).toMatchObject({ role: "ADMIN", grantSettings: true, grantBilling: false });
  });

  it("[AS-1i] el Titular invita un Admin → con las dos delegaciones (decisión 2)", async () => {
    const T = await clinic();
    const { rawToken } = await invite(T, T.userId, "ADMIN");
    expect(await activate(T, rawToken)).toMatchObject({ role: "ADMIN", grantSettings: true, grantBilling: true });
  });

  it("[AS-1i] un Admin CON «Planes y pagos» invita un Admin → con las dos (ya maneja la cuenta)", async () => {
    const T = await clinic();
    const admin = await addStaff(db, T, "ADMIN", { grantSettings: true, grantBilling: true });
    const { rawToken } = await invite(T, admin.userId, "ADMIN");
    expect(await activate(T, rawToken)).toMatchObject({ role: "ADMIN", grantSettings: true, grantBilling: true });
  });

  it("[AS-1i] se decide AL ACTIVAR: si a quien invitó le sacaron «Planes y pagos» antes de que se acepte, el invitado entra sin", async () => {
    const T = await clinic();
    const admin = await addStaff(db, T, "ADMIN", { grantSettings: true, grantBilling: true });
    const { rawToken } = await invite(T, admin.userId, "ADMIN");
    await db.membership.update({ where: { id: admin.membershipId }, data: { grantBilling: false } });
    expect(await activate(T, rawToken)).toMatchObject({ role: "ADMIN", grantBilling: false });
  });

  it("[AS-1i] quien invitó ya no está activo (suspendido) → el invitado entra sin «Planes y pagos» (falla cerrado)", async () => {
    const T = await clinic();
    const admin = await addStaff(db, T, "ADMIN", { grantSettings: true, grantBilling: true });
    const { rawToken } = await invite(T, admin.userId, "ADMIN");
    await db.membership.update({ where: { id: admin.membershipId }, data: { disabledAt: new Date(), disabledReason: "MANUAL" } });
    expect(await activate(T, rawToken)).toMatchObject({ role: "ADMIN", grantBilling: false });
  });

  it("[AS-1i] re-invitar cambia quién decide: el Titular invitó como Secretaria y un Admin sin «Planes y pagos» la re-invita como Admin → sin", async () => {
    const T = await clinic();
    const admin = await addStaff(db, T, "ADMIN", { grantSettings: true, grantBilling: false });
    const email = `as1i-re-${randomBytes(4).toString("hex")}@example.com`;
    await invite(T, T.userId, "ASSISTANT", email);
    __rateLimitInternals.reset(); // el tope por destinatario de `inviteRateLimit` no es lo que se mide acá
    // Mismo email, invitación viva: `createInvitationInTx` la actualiza (rol y token nuevo; el link viejo sigue valiendo).
    const { rawToken } = await invite(T, admin.userId, "ADMIN", email);
    expect(await activate(T, rawToken)).toMatchObject({ role: "ADMIN", grantSettings: true, grantBilling: false });
  });

  it("[AS-1i] el superadmin desde Plataforma invita un Admin → con las dos (actúa como Titular)", async () => {
    const T = await clinic();
    const sa = `test-user-${uniqueSuffix()}`;
    users.push(sa);
    await db.userProfile.create({ data: { id: sa, email: `${sa}@test.local`, fullName: "Super", isPlatformAdmin: true } });
    const ctx: TeamActorCtx = {
      via: "platform",
      tenantId: T.tenantId,
      actorUserId: sa,
      actorRole: "SUPERADMIN",
      actorRef: { userId: sa, email: `${sa}@test.local`, homeTenantId: null },
    };
    const rawToken = randomBytes(24).toString("base64url");
    const r = await runTeamTx(ctx, (tx) =>
      createInvitationInTx(tx, ctx, {
        email: `as1i-pl-${randomBytes(4).toString("hex")}@example.com`,
        firstName: "In",
        lastName: "Vitada",
        role: "ADMIN",
        specialty: null,
        rawToken,
        now: new Date(),
      })
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(await activate(T, rawToken)).toMatchObject({ role: "ADMIN", grantSettings: true, grantBilling: true });
  });

  it("[AS-1i] la Secretaria invitada por el Titular sigue sin delegaciones (el fix no toca los otros roles)", async () => {
    const T = await clinic();
    const { rawToken } = await invite(T, T.userId, "ASSISTANT");
    expect(await activate(T, rawToken)).toMatchObject({ role: "ASSISTANT", grantSettings: false, grantBilling: false });
  });

  // ── Cambio de rol ─────────────────────────────────────────────────────────────────────────────────────────

  it("[AS-1i] un Admin SIN «Planes y pagos» pasa una Secretaria a Admin → «Configuración» sí, «Planes y pagos» no (audit con lo que quedó)", async () => {
    const T = await clinic();
    const admin = await addStaff(db, T, "ADMIN", { grantSettings: true, grantBilling: false });
    const sec = await addStaff(db, T, "ASSISTANT");
    asUser(admin.userId);
    expect(await changeMemberRole(sec.membershipId, "ADMIN")).toEqual({ ok: true, data: undefined });
    expect(await membershipOf(T, sec.userId)).toMatchObject({ role: "ADMIN", grantSettings: true, grantBilling: false });
    const ev = await db.auditEvent.findFirstOrThrow({
      where: { tenantId: T.tenantId, action: "membership.role.change", entityId: sec.membershipId },
      orderBy: { createdAt: "desc" },
    });
    expect(ev.payload).toMatchObject({ from: "ASSISTANT", role: "ADMIN", grants: { grantSettings: true, grantBilling: false } });
  });

  it("[AS-1i] un Profesional con «Configuración» pasa a Facturación a Admin → sin «Planes y pagos»", async () => {
    const T = await clinic();
    const pro = await proWithSettings(T);
    const fac = await addStaff(db, T, "BILLING");
    asUser(pro);
    expect(await changeMemberRole(fac.membershipId, "ADMIN")).toEqual({ ok: true, data: undefined });
    expect(await membershipOf(T, fac.userId)).toMatchObject({ role: "ADMIN", grantSettings: true, grantBilling: false });
  });

  it("[AS-1i] el Titular pasa una Secretaria a Admin → con las dos; un Admin con «Planes y pagos» también", async () => {
    const T = await clinic();
    const sec1 = await addStaff(db, T, "ASSISTANT");
    asUser(T.userId);
    expect(await changeMemberRole(sec1.membershipId, "ADMIN")).toEqual({ ok: true, data: undefined });
    expect(await membershipOf(T, sec1.userId)).toMatchObject({ role: "ADMIN", grantSettings: true, grantBilling: true });

    const admin = await addStaff(db, T, "ADMIN", { grantSettings: true, grantBilling: true });
    const sec2 = await addStaff(db, T, "ASSISTANT");
    asUser(admin.userId);
    expect(await changeMemberRole(sec2.membershipId, "ADMIN")).toEqual({ ok: true, data: undefined });
    expect(await membershipOf(T, sec2.userId)).toMatchObject({ role: "ADMIN", grantSettings: true, grantBilling: true });
  });

  it("[AS-1i] pasar a Admin no le SACA «Planes y pagos» a quien el Titular ya se lo había delegado", async () => {
    const T = await clinic();
    const admin = await addStaff(db, T, "ADMIN", { grantSettings: true, grantBilling: false });
    // Un Profesional sin agenda a cargo (sin turnos ni pacientes) con «Planes y pagos» delegado por el Titular.
    const p = await addPractitioner(db, T, "PRACTITIONER");
    await db.membership.update({ where: { userId_tenantId: { userId: p.userId, tenantId: T.tenantId } }, data: { grantBilling: true } });
    const mem = await membershipOf(T, p.userId);
    asUser(admin.userId);
    expect(await changeMemberRole(mem.id, "ADMIN")).toEqual({ ok: true, data: undefined });
    expect(await membershipOf(T, p.userId)).toMatchObject({ role: "ADMIN", grantSettings: true, grantBilling: true });
  });
});
