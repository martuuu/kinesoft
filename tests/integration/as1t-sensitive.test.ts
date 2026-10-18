/**
 * [AS-1t] Lo delicado de Configuración (`tenant.sensitive`, C-AS1; plan §23.3) y las delegaciones del Administrador/a,
 * contra Postgres en los dos roles (`kinesoft_app` con RLS y owner BYPASSRLS).
 *
 * Por qué: hasta T3 todo Configuración colgaba de `tenant.admin`, así que una Secretaria con «Configuración» invitaba
 * gente, decidía quién ve la HC, prendía el turnero (el del consultorio y el de cualquier profesional) y creaba
 * diagnósticos propios (estos sin gate: solo el módulo). Decisión 3 del 19-oct: con «Configuración» la Secretaria
 * maneja servicios, obras sociales, horarios, sedes y salas, y NUNCA turnero, equipo ni plan. Decisión 4: un
 * Profesional con «Configuración» sí accede a lo delicado. Decisión 2: el Administrador/a trae «Planes y pagos».
 *
 * Símbolos REALES de cada action (lib/tenant-settings.ts, lib/practitioner-public.ts, lib/directory-settings.ts,
 * lib/invitations.ts, lib/conditions.ts, lib/services.ts, lib/insurers.ts, lib/locations.ts, lib/rooms.ts), los
 * núcleos de equipo (`changeMemberRoleInTx`, `setMemberGrantsInTx`; el step-up de sus actions lo fija
 * pl3b-team.test.ts), `activateInvitation` con el fake de GoTrue y `loadConfiguracionPage`. Se mockea solo la cookie
 * de sesión (helper `asUser`), el transporte de mail y GoTrue.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { PrismaClient, Role } from "@prisma/client";
import { ForbiddenError, getActor } from "@/lib/session";
import { capabilitiesForActor } from "@/lib/authz";
import {
  setBusinessHours,
  setPublicBookingEnabled,
  setSharedPatientView,
  updateTenantBasics,
} from "@/lib/tenant-settings";
import { setPractitionerPublicBooking } from "@/lib/practitioner-public";
import { setDirectoryListed, setPublicDescription, setPractitionerSpecialties } from "@/lib/directory-settings";
import {
  changeMemberRole,
  createInvitation,
  listTeamMembers,
  resendInvitation,
  suspendMember,
} from "@/lib/invitations";
import { createCustomCondition, deleteCustomCondition, updateCustomCondition } from "@/lib/conditions";
import { createService } from "@/lib/services";
import { createInsurer } from "@/lib/insurers";
import { createLocation } from "@/lib/locations";
import { createRoom } from "@/lib/rooms";
import { loadConfiguracionPage } from "@/lib/configuracion-page-loader";
import {
  STAFF_BILLING_GRANT_MESSAGE,
  changeMemberRoleInTx,
  runTeamTx,
  setMemberGrantsInTx,
  type TeamActorCtx,
} from "@/lib/team-internal";
import { activateInvitation } from "@/lib/invite-activation-internal";
import { hashInviteToken } from "@/lib/invitations-tokens";
import { __setEmailTransportForTests, type SendEmailInput, type SendEmailResult } from "@/lib/email";
import { __setAuthAdminForTests } from "@/lib/identity/auth-admin";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { GotrueFake } from "@/tests/helpers/gotrue-fake";
import { asAnonymous, asUser } from "@/tests/helpers/actor";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const DAY = 86_400_000;

/** Default de `requireTenantSensitive` (lib/authz.ts). */
const SENSITIVE = "Solo el titular o el administrador (o un profesional con «Configuración») puede cambiar esto.";

const mail = {
  sent: [] as SendEmailInput[],
  transport: async (i: SendEmailInput): Promise<SendEmailResult> => {
    mail.sent.push(i);
    return { ok: true, transport: "resend", providerId: `re_${mail.sent.length}` };
  },
};

describe.skipIf(!RUN)("[AS-1t] lo delicado de Configuración y las delegaciones del Administrador/a", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  const users: string[] = [];
  let gotrue: GotrueFake;

  const membershipOf = (t: EphemeralTenant, userId: string) =>
    db.membership.findUniqueOrThrow({ where: { userId_tenantId: { userId, tenantId: t.tenantId } } });

  /** Miembro sin `Practitioner` (Secretaria, Facturación, Administrador/a de §20.17). */
  async function staff(t: EphemeralTenant, role: Role, grants: { grantSettings?: boolean; grantBilling?: boolean } = {}) {
    const id = `test-user-${uniqueSuffix()}`;
    users.push(id);
    await db.userProfile.create({ data: { id, email: `${id}@test.local`, fullName: `Staff ${role}` } });
    await db.membership.create({
      data: { userId: id, tenantId: t.tenantId, role, clinical: false, acceptedAt: new Date(), ...grants },
    });
    return id;
  }

  const ownerCtx = (t: EphemeralTenant): TeamActorCtx => ({
    via: "tenant",
    tenantId: t.tenantId,
    actorUserId: t.userId,
    actorRole: "OWNER",
    actorRef: null,
  });

  const tenantRow = (t: EphemeralTenant) =>
    db.tenant.findUniqueOrThrow({
      where: { id: t.tenantId },
      select: { publicBookingEnabled: true, sharedPatientView: true, name: true, directoryListed: true, publicDescription: true },
    });

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
  });

  afterAll(async () => {
    await A?.cleanup();
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
    asUser(A.userId);
  });
  afterEach(() => {
    __setEmailTransportForTests(null);
    __setAuthAdminForTests(null);
  });

  // ── Secretaria con «Configuración» (decisión 3) ────────────────────────────────────────────────────────────

  it("[AS-1t] Secretaria con «Configuración»: servicios, obras sociales, horario, sedes y salas sí", async () => {
    const sec = await staff(A, "ASSISTANT", { grantSettings: true });
    asUser(sec);
    const s = uniqueSuffix();
    const svc = await createService({ name: `Svc sec ${s}`, durationMin: 30, priceCents: 1000 });
    expect(svc.ok).toBe(true);
    const ins = await createInsurer({ name: `OS sec ${s}`, copagoCents: 500, fixedFeeCents: 0 });
    expect(ins.ok).toBe(true);
    expect(await setBusinessHours({ start: 8, end: 19 })).toEqual({ ok: true, data: undefined });
    const loc = await createLocation({ name: `Sede sec ${s}` });
    expect(loc.ok).toBe(true);
    if (!loc.ok) return;
    const room = await createRoom({ locationId: loc.data.id, name: `Sala sec ${s}` });
    expect(room.ok).toBe(true);
    expect(await db.service.count({ where: { tenantId: A.tenantId, name: `Svc sec ${s}` } })).toBe(1);
    expect(await db.room.count({ where: { tenantId: A.tenantId, name: `Sala sec ${s}` } })).toBe(1);
  });

  it("[AS-1t] Secretaria con «Configuración»: ni turnero, ni directorio, ni «quién ve la HC», ni datos del consultorio", async () => {
    const sec = await staff(A, "ASSISTANT", { grantSettings: true });
    const kine = await addPractitioner(db, A);
    const before = await tenantRow(A);
    const pracBefore = await db.practitioner.findUniqueOrThrow({ where: { id: kine.practitionerId } });
    const audits = await db.auditEvent.count({ where: { tenantId: A.tenantId } });
    asUser(sec);

    await expect(setPublicBookingEnabled(!before.publicBookingEnabled)).rejects.toThrow(SENSITIVE);
    await expect(setSharedPatientView(!before.sharedPatientView)).rejects.toThrow(SENSITIVE);
    await expect(updateTenantBasics({ name: `Otro nombre ${uniqueSuffix()}` })).rejects.toThrow(SENSITIVE);
    // El turnero de OTRO profesional (el propio sigue libre: se fija abajo con el Profesional).
    const pp = await setPractitionerPublicBooking(kine.practitionerId, !pracBefore.publicBookingEnabled);
    expect(pp.ok).toBe(false);
    for (const r of [
      await setDirectoryListed(!before.directoryListed),
      await setPublicDescription("Descripción de la Secretaria"),
      await setPractitionerSpecialties(kine.practitionerId, []),
    ]) {
      expect(r.ok).toBe(false);
    }

    expect(await tenantRow(A)).toEqual(before);
    expect((await db.practitioner.findUniqueOrThrow({ where: { id: kine.practitionerId } })).publicBookingEnabled).toBe(
      pracBefore.publicBookingEnabled
    );
    expect(await db.auditEvent.count({ where: { tenantId: A.tenantId } })).toBe(audits);
  });

  it("[AS-1t] Secretaria con «Configuración»: no gestiona el equipo (invitar, cambiar rol, suspender, reenviar)", async () => {
    const sec = await staff(A, "ASSISTANT", { grantSettings: true });
    const other = await staff(A, "BILLING");
    const otherMem = await membershipOf(A, other);
    // Una invitación viva de otro (la crea el Titular) para el «Reenviar».
    asUser(A.userId);
    const inv = await createInvitation({ email: `as1t-${uniqueSuffix()}@test.local`, firstName: "In", lastName: "Vi", role: "BILLING" });
    expect(inv.ok).toBe(true);
    if (!inv.ok) return;
    const invitations = await db.invitation.count({ where: { tenantId: A.tenantId } });
    const sends = mail.sent.length;

    asUser(sec);
    await expect(listTeamMembers()).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      createInvitation({ email: `as1t-sec-${uniqueSuffix()}@test.local`, firstName: "No", lastName: "Va", role: "ASSISTANT" })
    ).rejects.toThrow(SENSITIVE);
    await expect(changeMemberRole(otherMem.id, "ASSISTANT")).rejects.toThrow(SENSITIVE);
    await expect(suspendMember(otherMem.id)).rejects.toThrow(SENSITIVE);
    await expect(resendInvitation(inv.data.id)).rejects.toThrow(SENSITIVE);

    expect(await db.invitation.count({ where: { tenantId: A.tenantId } })).toBe(invitations);
    expect(mail.sent.length).toBe(sends);
    expect(await membershipOf(A, other)).toMatchObject({ role: "BILLING", disabledAt: null });
  });

  it("[AS-1t] Secretaria con «Configuración»: no crea, edita ni borra diagnósticos propios", async () => {
    const sec = await staff(A, "ASSISTANT", { grantSettings: true });
    const cond = await db.condition.create({
      data: { slug: `as1t-cond-${uniqueSuffix()}`, name: "Propia del consultorio", tenantId: A.tenantId },
    });
    const before = await db.condition.count({ where: { tenantId: A.tenantId } });
    asUser(sec);
    await expect(createCustomCondition({ name: `Nueva ${uniqueSuffix()}` })).rejects.toThrow(SENSITIVE);
    await expect(updateCustomCondition(cond.id, { name: "Cambiada" })).rejects.toThrow(SENSITIVE);
    await expect(deleteCustomCondition(cond.id)).rejects.toThrow(SENSITIVE);
    expect(await db.condition.count({ where: { tenantId: A.tenantId } })).toBe(before);
    expect((await db.condition.findUniqueOrThrow({ where: { id: cond.id } })).name).toBe("Propia del consultorio");
  });

  it("[AS-1t] un Profesional sin «Configuración» tampoco crea diagnósticos propios; su turnero propio sí", async () => {
    const kine = await addPractitioner(db, A);
    asUser(kine.userId);
    await expect(createCustomCondition({ name: `Del kine ${uniqueSuffix()}` })).rejects.toThrow(SENSITIVE);
    const prev = (await db.practitioner.findUniqueOrThrow({ where: { id: kine.practitionerId } })).publicBookingEnabled;
    expect(await setPractitionerPublicBooking(kine.practitionerId, !prev)).toEqual({ ok: true, data: { enabled: !prev } });
  });

  // ── Profesional y Administrador/a con «Configuración» (decisión 4) ─────────────────────────────────────────

  it("[AS-1t] Profesional con «Configuración»: sí a lo delicado (turnero, HC, datos, diagnósticos, turnero ajeno)", async () => {
    const T = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    try {
      const kine = await addPractitioner(db, T);
      const other = await addPractitioner(db, T);
      await db.membership.update({
        where: { userId_tenantId: { userId: kine.userId, tenantId: T.tenantId } },
        data: { grantSettings: true },
      });
      const before = await tenantRow(T);
      asUser(kine.userId);
      expect(await setPublicBookingEnabled(!before.publicBookingEnabled)).toEqual({ ok: true, data: undefined });
      expect(await setSharedPatientView(!before.sharedPatientView)).toEqual({ ok: true, data: undefined });
      expect(await updateTenantBasics({ name: `Consultorio del kine ${uniqueSuffix()}` })).toEqual({ ok: true, data: undefined });
      const prev = (await db.practitioner.findUniqueOrThrow({ where: { id: other.practitionerId } })).publicBookingEnabled;
      expect(await setPractitionerPublicBooking(other.practitionerId, !prev)).toEqual({ ok: true, data: { enabled: !prev } });
      expect((await setPublicDescription("Consultorio de prueba")).ok).toBe(true);
      const c = await createCustomCondition({ name: `Del kine ${uniqueSuffix()}` });
      expect(c.ok).toBe(true);
      expect((await listTeamMembers()).length).toBeGreaterThan(0);

      const after = await tenantRow(T);
      expect(after.publicBookingEnabled).toBe(!before.publicBookingEnabled);
      expect(after.sharedPatientView).toBe(!before.sharedPatientView);
      expect(after.publicDescription).toBe("Consultorio de prueba");
    } finally {
      await T.cleanup();
    }
  });

  it("[AS-1t] Administrador/a: con «Configuración» sí; sin ella, no (ni equipo, ni turnero, ni diagnósticos)", async () => {
    const T = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    try {
      const withSettings = await staff(T, "ADMIN", { grantSettings: true });
      const without = await staff(T, "ADMIN", { grantSettings: false, grantBilling: true });
      const before = await tenantRow(T);

      asUser(without);
      await expect(setPublicBookingEnabled(!before.publicBookingEnabled)).rejects.toThrow(SENSITIVE);
      await expect(setSharedPatientView(!before.sharedPatientView)).rejects.toThrow(SENSITIVE);
      await expect(createCustomCondition({ name: `Del admin ${uniqueSuffix()}` })).rejects.toThrow(SENSITIVE);
      await expect(listTeamMembers()).rejects.toBeInstanceOf(ForbiddenError);
      expect(await tenantRow(T)).toEqual(before);

      asUser(withSettings);
      expect(await setPublicBookingEnabled(!before.publicBookingEnabled)).toEqual({ ok: true, data: undefined });
      expect(await setSharedPatientView(!before.sharedPatientView)).toEqual({ ok: true, data: undefined });
      expect((await createCustomCondition({ name: `Del admin ${uniqueSuffix()}` })).ok).toBe(true);
      const inv = await createInvitation({ email: `as1t-adm-${uniqueSuffix()}@test.local`, firstName: "Fa", lastName: "Ct", role: "BILLING" });
      expect(inv.ok).toBe(true);
    } finally {
      await T.cleanup();
    }
  });

  // ── Delegaciones del Administrador/a (decisión 2) ──────────────────────────────────────────────────────────

  it("[AS-1t] un Administrador/a invitado entra con «Configuración» y «Planes y pagos»; la Secretaria con ninguna", async () => {
    const T = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    try {
      const accept = async (role: Role, ip: string) => {
        const raw = randomBytes(24).toString("base64url");
        await db.invitation.create({
          data: {
            tenantId: T.tenantId,
            email: `as1t-inv-${randomBytes(4).toString("hex")}@example.com`,
            firstName: "In",
            lastName: "Vitada",
            role,
            token: hashInviteToken(raw),
            invitedById: T.userId,
            expiresAt: new Date(Date.now() + DAY),
          },
        });
        asAnonymous();
        const a = await activateInvitation(
          { token: raw, firstName: "In", lastName: "Vitada", password: "clave-segura-1", passwordConfirm: "clave-segura-1" },
          { ip }
        );
        if (!a.ok) throw new Error(a.error);
        users.push(a.userId);
        return db.membership.findFirstOrThrow({ where: { tenantId: T.tenantId, userId: a.userId } });
      };
      expect(await accept("ADMIN", "203.0.113.41")).toMatchObject({
        role: "ADMIN",
        clinical: false,
        grantSettings: true,
        grantBilling: true,
      });
      expect(await accept("ASSISTANT", "203.0.113.42")).toMatchObject({
        role: "ASSISTANT",
        grantSettings: false,
        grantBilling: false,
      });
    } finally {
      await T.cleanup();
    }
  });

  it("[AS-1t] pasar a Administrador/a setea las dos delegaciones (audit con los permisos); pasar a Secretaria saca «Planes y pagos»", async () => {
    const T = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    try {
      const fac = await staff(T, "BILLING");
      const facMem = await membershipOf(T, fac);
      const ctx = ownerCtx(T);
      expect(await runTeamTx(ctx, (tx) => changeMemberRoleInTx(tx, ctx, { membershipId: facMem.id, role: "ADMIN" }))).toEqual({
        ok: true,
        data: undefined,
      });
      expect(await membershipOf(T, fac)).toMatchObject({ role: "ADMIN", grantSettings: true, grantBilling: true });
      const ev = await db.auditEvent.findFirstOrThrow({
        where: { tenantId: T.tenantId, action: "membership.role.change", entityId: facMem.id },
        orderBy: { createdAt: "desc" },
      });
      expect(ev.payload).toMatchObject({
        from: "BILLING",
        role: "ADMIN",
        grants: { grantSettings: true, grantBilling: true },
      });

      // De vuelta a Secretaria: «Planes y pagos» no le queda colgado en la fila (el corte de staff ya se lo negaba, pero
      // el Titular no podría volver a guardar sus permisos: `setMemberGrantsInTx` lo rechaza). «Configuración» queda.
      expect(await runTeamTx(ctx, (tx) => changeMemberRoleInTx(tx, ctx, { membershipId: facMem.id, role: "ASSISTANT" }))).toEqual({
        ok: true,
        data: undefined,
      });
      expect(await membershipOf(T, fac)).toMatchObject({ role: "ASSISTANT", grantSettings: true, grantBilling: false });
    } finally {
      await T.cleanup();
    }
  });

  it("[AS-1t] el ex Titular que no atendía queda Administrador/a con las dos delegaciones", async () => {
    const T = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    try {
      await db.membership.update({
        where: { userId_tenantId: { userId: T.userId, tenantId: T.tenantId } },
        data: { clinical: false },
      });
      const kine = await addPractitioner(db, T);
      const kineMem = await membershipOf(T, kine.userId);
      const ctx = ownerCtx(T);
      expect(await runTeamTx(ctx, (tx) => changeMemberRoleInTx(tx, ctx, { membershipId: kineMem.id, role: "OWNER" }))).toEqual({
        ok: true,
        data: undefined,
      });
      expect(await membershipOf(T, T.userId)).toMatchObject({
        role: "ADMIN",
        clinical: false,
        grantSettings: true,
        grantBilling: true,
      });
    } finally {
      await T.cleanup();
    }
  });

  it("[AS-1t] «Planes y pagos» a la Secretaria o a Facturación → rechazo sin escribir; «Configuración» sí", async () => {
    const T = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    try {
      const ctx = ownerCtx(T);
      for (const role of ["ASSISTANT", "BILLING"] as const) {
        const id = await staff(T, role);
        const mem = await membershipOf(T, id);
        expect(
          await runTeamTx(ctx, (tx) => setMemberGrantsInTx(tx, ctx, { membershipId: mem.id, grantSettings: false, grantBilling: true }))
        ).toEqual({ ok: false, error: STAFF_BILLING_GRANT_MESSAGE });
        expect(await membershipOf(T, id)).toMatchObject({ grantSettings: false, grantBilling: false });
        expect(
          await runTeamTx(ctx, (tx) => setMemberGrantsInTx(tx, ctx, { membershipId: mem.id, grantSettings: true, grantBilling: false }))
        ).toEqual({ ok: true, data: undefined });
        expect(await membershipOf(T, id)).toMatchObject({ grantSettings: true, grantBilling: false });
      }
      expect(STAFF_BILLING_GRANT_MESSAGE).toBe("La Secretaría y Facturación no pueden tener «Planes y pagos».");
      expect(
        await db.auditEvent.count({ where: { tenantId: T.tenantId, action: "membership.grants.change", payload: { path: ["to", "grantBilling"], equals: true } } })
      ).toBe(0);
    } finally {
      await T.cleanup();
    }
  });

  // ── Loader de /configuracion (para que la UI de T3d esconda lo delicado) ───────────────────────────────────

  it("[AS-1t] loader: `sensitive` en el acceso; la Secretaria con «Configuración» no baja equipo ni directorio", async () => {
    const sec = await staff(A, "ASSISTANT", { grantSettings: true });
    const adm = await staff(A, "ADMIN", { grantSettings: true });

    asUser(sec);
    const sa = await getActor();
    const s = await loadConfiguracionPage(sa, await capabilitiesForActor(sa));
    expect(s.sensitive).toBe(false);
    expect(s.tenant).not.toBeNull(); // General (horario, granularidad) sigue
    expect(s.team).toBeNull();
    expect(s.pending).toBeNull();
    expect(s.directory).toBeNull();

    asUser(adm);
    const aa = await getActor();
    const a = await loadConfiguracionPage(aa, await capabilitiesForActor(aa));
    expect(a.sensitive).toBe(true);
    expect(a.team).not.toBeNull();

    asUser(A.userId);
    const oa = await getActor();
    expect((await loadConfiguracionPage(oa, await capabilitiesForActor(oa))).sensitive).toBe(true);
  });
});
