/**
 * BO2-B · equipo de cualquier consultorio desde /plataforma (contrato C-BO8, plan §19.5).
 *
 * Símbolos REALES: los exports de `lib/platform-team.ts` (server actions del superadmin) y
 * `getTenantTeamForPlatform` (`lib/platform-team-read.ts`), sobre los núcleos compartidos de `lib/team-internal.ts`,
 * contra Postgres en los dos roles (`test:integration` y `:owner`). Se reemplazan solo la sesión (integration-setup),
 * el despacho del mail (`__setEmailTransportForTests`: el sink de EmailLog sigue corriendo) y GoTrue (fake).
 *
 * Arrancó como `it.fails("[BO2-B] …")` con `lib/platform-team.ts` inexistente (el superadmin no tenía cómo tocar el
 * equipo de otro consultorio sin ir a la base); quedó dado vuelta en los casos de abajo.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  platformChangeMemberRole,
  platformInviteTeamMember,
  platformReactivateMember,
  platformRemoveMember,
  platformResendInvitation,
  platformRevokeInvitation,
  platformSendMemberPasswordReset,
  platformSuspendMember,
  platformTransferOwnership,
} from "@/lib/platform-team";
import { getTenantTeamForPlatform } from "@/lib/platform-team-read";
import { ForbiddenError } from "@/lib/session";
import { __setEmailTransportForTests, type SendEmailInput, type SendEmailResult } from "@/lib/email";
import { __setAuthAdminForTests } from "@/lib/identity/auth-admin";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { tags } from "@/lib/cache-tags";
import { GotrueFake } from "@/tests/helpers/gotrue-fake";
import { asUser } from "@/tests/helpers/actor";
import { revalidateTagSpy } from "@/tests/helpers/integration-setup";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  addPatient,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

/** Registro a mano (no `vi.fn`: vitest 2.1.9 rompe con un fn que tira a través de un mock). */
const mail = {
  sent: [] as SendEmailInput[],
  /** [BO-Z] C4: el próximo envío falla (rebote): ahí el superadmin sí recibe la URL para copiar. */
  failNext: false,
  transport: async (i: SendEmailInput): Promise<SendEmailResult> => {
    mail.sent.push(i);
    if (mail.failNext) {
      mail.failNext = false;
      return { ok: false, transport: "resend", skipped: false, reason: "bounce" } as SendEmailResult;
    }
    return { ok: true, transport: "resend", providerId: `re_${mail.sent.length}` };
  },
};

describe.skipIf(!RUN)("[BO2-B] equipo de un consultorio desde /plataforma", () => {
  let db: PrismaClient;
  /**
   * Consultorio sobre el que actúa el superadmin (Clínica: 10 usuarios de cualquier tipo; los cupos se prueban en
   * seats.test.ts). PL-1d: la factory no espeja `plan`↔`saasPlan`, se pasan los dos.
   */
  let T: EphemeralTenant;
  /** Otro consultorio: su OWNER no puede usar las actions de Plataforma. */
  let O: EphemeralTenant;
  let superadminId: string;
  let gotrue: GotrueFake;
  const users: string[] = [];

  const PHI = { firstName: "Zulema-PHI", lastName: "Quintana-PHI", documentId: "DNI-PHI-99887766", notes: "Lumbalgia PHI" };

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db, { plan: "PRO", saasPlan: "CLINICA" });
    O = await createEphemeralTenant(db, { plan: "PRO", saasPlan: "CLINICA" });
    // Fixture de PHI en el consultorio: no tiene que aparecer en nada que devuelva Plataforma.
    await addPatient(db, T, { ...PHI, email: `phi-${uniqueSuffix()}@test.local` });
    superadminId = `test-user-${uniqueSuffix()}`;
    users.push(superadminId);
    // Superadmin SIN consultorio «casa» (el caso que motivó el actor de plataforma, §19.1).
    await db.userProfile.create({
      data: { id: superadminId, email: `${superadminId}@test.local`, fullName: "Súper Admin Nombre", isPlatformAdmin: true },
    });
  });

  afterAll(async () => {
    await T?.cleanup();
    await O?.cleanup();
    if (db) {
      if (users.length) await db.userProfile.deleteMany({ where: { id: { in: users } } });
      await db.$disconnect();
    }
  });

  beforeEach(() => {
    __rateLimitInternals.reset();
    mail.sent = [];
    __setEmailTransportForTests(mail.transport);
    gotrue = new GotrueFake();
    __setAuthAdminForTests(gotrue);
    revalidateTagSpy.mockClear();
    asUser(superadminId);
  });

  afterEach(() => {
    __setEmailTransportForTests(null);
    __setAuthAdminForTests(null);
  });

  const membershipOf = (t: EphemeralTenant, userId: string) =>
    db.membership.findUniqueOrThrow({ where: { userId_tenantId: { userId, tenantId: t.tenantId } } });

  /** Las dos filas de `auditPlatformInTx`: el `platform.*` en el log del consultorio y la fila global. */
  async function expectPlatformAudit(action: string, entityId: string) {
    const local = await db.auditEvent.findFirst({
      where: { tenantId: T.tenantId, action, entityId },
      orderBy: { createdAt: "desc" },
    });
    expect(local, `AuditEvent ${action}`).not.toBeNull();
    expect(local!.actorId).toBe(superadminId);
    const global = await db.platformAuditEvent.findFirst({
      where: { tenantId: T.tenantId, action, entityId },
      orderBy: { createdAt: "desc" },
    });
    expect(global, `PlatformAuditEvent ${action}`).not.toBeNull();
    expect(global!.actorId).toBe(superadminId);
    expect(global!.actorEmail).toBe(`${superadminId}@test.local`);
    return { local: local!, global: global! };
  }

  async function ownerCount(t: EphemeralTenant) {
    return db.membership.count({ where: { tenantId: t.tenantId, role: "OWNER" } });
  }

  it("un OWNER de otro consultorio (o cualquiera sin superadmin) recibe Forbidden en todo, sin escribir nada", async () => {
    const kine = await addPractitioner(db, T);
    const mem = await membershipOf(T, kine.userId);
    const inv = await db.invitation.create({
      data: {
        tenantId: T.tenantId,
        email: `fb-${uniqueSuffix()}@test.local`,
        firstName: "F",
        lastName: "B",
        token: `fb-${uniqueSuffix()}`,
        invitedById: T.userId,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const before = { mem: await membershipOf(T, kine.userId), inv: await db.invitation.findUniqueOrThrow({ where: { id: inv.id } }) };
    for (const who of [O.userId, T.userId]) {
      asUser(who);
      const m = { tenantId: T.tenantId, membershipId: mem.id };
      const i = { tenantId: T.tenantId, invitationId: inv.id };
      await expect(getTenantTeamForPlatform(T.tenantId)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        platformInviteTeamMember({ tenantId: T.tenantId, email: `x-${uniqueSuffix()}@test.local`, firstName: "X", lastName: "Y" })
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(platformResendInvitation(i)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(platformRevokeInvitation(i)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(platformChangeMemberRole({ ...m, role: "ADMIN" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(platformTransferOwnership(m)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(platformSuspendMember(m)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(platformReactivateMember(m)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(platformRemoveMember(m)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(platformSendMemberPasswordReset(m)).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await membershipOf(T, kine.userId)).toEqual(before.mem);
    expect(await db.invitation.findUniqueOrThrow({ where: { id: inv.id } })).toEqual(before.inv);
    expect(mail.sent).toHaveLength(0);
  });

  it("lista miembros, invitaciones y cupos de cualquier consultorio, con lista cerrada de campos y sin PHI", async () => {
    const team = await getTenantTeamForPlatform(T.tenantId);
    expect(team).not.toBeNull();
    expect(Object.keys(team!).sort()).toEqual(["invitations", "members", "seats", "tenantId"]);
    expect(team!.members.length).toBeGreaterThan(0);
    for (const m of team!.members) {
      expect(Object.keys(m).sort()).toEqual(
        ["disabledAt", "email", "fullName", "hasAgenda", "joinedAt", "membershipId", "role", "userId"].sort()
      );
    }
    for (const i of team!.invitations) {
      expect(Object.keys(i).sort()).toEqual(
        ["email", "expiresAt", "firstName", "id", "invitedAt", "lastEmailStatus", "lastName", "lastSentAt", "role", "sendCount", "status"].sort()
      );
    }
    // PL-1d: cupos por tipo (C-PL3).
    expect(Object.keys(team!.seats).sort()).toEqual(["professional", "staff", "total"]);
    expect(Object.keys(team!.seats.total).sort()).toEqual(["full", "limit", "remaining", "used"]);
    expect(team!.seats.total.limit).toBe(10);
    const owner = team!.members.find((m) => m.userId === T.userId)!;
    expect(owner).toMatchObject({ role: "OWNER", hasAgenda: true, disabledAt: null });
    const json = JSON.stringify(team);
    for (const v of Object.values(PHI)) expect(json).not.toContain(v);
    // Ningún token ni URL de invitación.
    expect(json).not.toMatch(/\/invite\//);
    expect(await getTenantTeamForPlatform("no-existe")).toBeNull();
  });

  it("invita en nombre del consultorio: mail a nombre del consultorio, URL para copiar, doble audit sin email", async () => {
    const email = `pt-inv-${uniqueSuffix()}@test.local`;
    const r = await platformInviteTeamMember({ tenantId: T.tenantId, email, firstName: "Ana", lastName: "Paz", role: "ASSISTANT" });
    if (!r.ok) throw new Error(r.error);
    // [BO-Z] C4: con el mail enviado, ni el superadmin recibe la URL (la credencial ya está en la casilla).
    expect(r.data.url).toBeNull();
    expect(r.data.emailSent).toBe(true);
    const row = await db.invitation.findUniqueOrThrow({ where: { id: r.data.id } });
    expect(row).toMatchObject({ tenantId: T.tenantId, email, role: "ASSISTANT", invitedById: superadminId, sendCount: 1 });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toBe(email);
    expect(mail.sent[0].fromName).toBe(`Test ${T.slug.slice("test-".length)}`);
    // El invitado no conoce al superadmin: la invitación es del consultorio.
    expect(mail.sent[0].text).not.toContain("Súper Admin");
    const { local, global } = await expectPlatformAudit("platform.invitation.create", r.data.id);
    expect(JSON.stringify(global.payload)).not.toContain(email);
    expect(local.payload).toMatchObject({ role: "ASSISTANT" });
    // Ninguna fila `invitation.create` «del consultorio» a nombre del superadmin: es una acción de plataforma.
    expect(await db.auditEvent.count({ where: { tenantId: T.tenantId, action: "invitation.create", entityId: r.data.id } })).toBe(0);
    const listed = await getTenantTeamForPlatform(T.tenantId);
    expect(listed!.invitations.find((i) => i.id === r.data.id)).toMatchObject({ status: "pending", sendCount: 1, lastEmailStatus: "sent" });
  });

  it("[BO-Z] C4: si el mail NO sale, el superadmin sí recibe la URL para copiar", async () => {
    mail.failNext = true;
    const r = await platformInviteTeamMember({
      tenantId: T.tenantId,
      email: `pt-fail-${uniqueSuffix()}@test.local`,
      firstName: "Bo",
      lastName: "Rebote",
      role: "ASSISTANT",
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.data.emailSent).toBe(false);
    expect(r.data.url).toMatch(/\/invite\//);
  });

  it("reenvía y anula una invitación de otro consultorio, con doble audit", async () => {
    const r = await platformInviteTeamMember({
      tenantId: T.tenantId,
      email: `pt-re-${uniqueSuffix()}@test.local`,
      firstName: "Re",
      lastName: "Envío",
      role: "BILLING",
    });
    if (!r.ok) throw new Error(r.error);
    __rateLimitInternals.reset();
    const again = await platformResendInvitation({ tenantId: T.tenantId, invitationId: r.data.id });
    expect(again.ok).toBe(true);
    expect((await db.invitation.findUniqueOrThrow({ where: { id: r.data.id } })).sendCount).toBe(2);
    await expectPlatformAudit("platform.invitation.resend", r.data.id);

    expect(await platformRevokeInvitation({ tenantId: T.tenantId, invitationId: r.data.id })).toEqual({ ok: true, data: undefined });
    const row = await db.invitation.findUniqueOrThrow({ where: { id: r.data.id } });
    expect(row.revokedAt).not.toBeNull();
    expect(row.revokedById).toBe(superadminId);
    await expectPlatformAudit("platform.invitation.revoke", r.data.id);
    // Otro consultorio en el input: no la encuentra (tenantId explícito en el where).
    expect((await platformRevokeInvitation({ tenantId: O.tenantId, invitationId: r.data.id })).ok).toBe(false);
  });

  it("cambia el rol (crea el profesional al pasar a clínico) y audita; el rol OWNER solo por transferencia", async () => {
    const kine = await addPractitioner(db, T);
    const mem = await membershipOf(T, kine.userId);
    expect(await platformChangeMemberRole({ tenantId: T.tenantId, membershipId: mem.id, role: "ADMIN" })).toEqual({ ok: true, data: undefined });
    expect((await membershipOf(T, kine.userId)).role).toBe("ADMIN");
    expect(revalidateTagSpy).toHaveBeenCalledWith(tags.practitioners(T.tenantId));
    const { local } = await expectPlatformAudit("platform.membership.role.change", mem.id);
    expect(local.payload).toMatchObject({ from: "PRACTITIONER", role: "ADMIN" });
    // OWNER no entra por acá (zod): se transfiere.
    const r = await platformChangeMemberRole({ tenantId: T.tenantId, membershipId: mem.id, role: "OWNER" });
    expect(r.ok).toBe(false);
    // Al dueño no se le cambia el rol sin transferir: el consultorio quedaría sin OWNER.
    const ownerMem = await membershipOf(T, T.userId);
    const d = await platformChangeMemberRole({ tenantId: T.tenantId, membershipId: ownerMem.id, role: "ADMIN" });
    expect(d.ok).toBe(false);
    expect(await ownerCount(T)).toBe(1);
    // Entradas con claves de más: inválidas (.strict()).
    expect((await platformChangeMemberRole({ tenantId: T.tenantId, membershipId: mem.id, role: "ADMIN", extra: 1 })).ok).toBe(false);
  });

  it("transfiere el OWNER: el anterior queda Profesional (atendía; §20.17), siempre exactamente un OWNER, doble audit", async () => {
    const X = await createEphemeralTenant(db, { plan: "PRO", saasPlan: "CLINICA" });
    try {
      const kine = await addPractitioner(db, X);
      const mem = await membershipOf(X, kine.userId);
      // A un suspendido no.
      await db.membership.update({ where: { id: mem.id }, data: { disabledAt: new Date() } });
      expect((await platformTransferOwnership({ tenantId: X.tenantId, membershipId: mem.id })).ok).toBe(false);
      await db.membership.update({ where: { id: mem.id }, data: { disabledAt: null } });

      expect(await platformTransferOwnership({ tenantId: X.tenantId, membershipId: mem.id })).toEqual({ ok: true, data: undefined });
      const roles = await db.membership.findMany({ where: { tenantId: X.tenantId }, select: { userId: true, role: true } });
      expect(roles.find((x) => x.userId === kine.userId)?.role).toBe("OWNER");
      expect(roles.find((x) => x.userId === X.userId)?.role).toBe("PRACTITIONER");
      expect(await ownerCount(X)).toBe(1);
      const local = await db.auditEvent.findFirst({ where: { tenantId: X.tenantId, action: "platform.membership.owner.transfer", entityId: mem.id } });
      const global = await db.platformAuditEvent.findFirst({ where: { tenantId: X.tenantId, action: "platform.membership.owner.transfer", entityId: mem.id } });
      expect(local?.payload).toMatchObject({ from: "PRACTITIONER", role: "OWNER", previousOwnersDemoted: 1 });
      expect(global).not.toBeNull();

      // Consultorio heredado con dos OWNER: transferir deja uno solo.
      await db.membership.update({ where: { userId_tenantId: { userId: X.userId, tenantId: X.tenantId } }, data: { role: "OWNER" } });
      expect(await ownerCount(X)).toBe(2);
      const third = await addPractitioner(db, X);
      const thirdMem = await membershipOf(X, third.userId);
      expect((await platformTransferOwnership({ tenantId: X.tenantId, membershipId: thirdMem.id })).ok).toBe(true);
      expect(await ownerCount(X)).toBe(1);
      expect((await membershipOf(X, third.userId)).role).toBe("OWNER");

      // No se quita ni se suspende al dueño.
      expect((await platformRemoveMember({ tenantId: X.tenantId, membershipId: thirdMem.id })).ok).toBe(false);
      expect((await platformSuspendMember({ tenantId: X.tenantId, membershipId: thirdMem.id })).ok).toBe(false);
      expect(await ownerCount(X)).toBe(1);
    } finally {
      await X.cleanup();
    }
  });

  it("suspende, reactiva y quita, con doble audit en cada paso", async () => {
    const sec = await addPractitioner(db, T, "ASSISTANT");
    const mem = await membershipOf(T, sec.userId);
    const s = await platformSuspendMember({ tenantId: T.tenantId, membershipId: mem.id });
    expect(s).toEqual({ ok: true, data: { futureBookings: 0 } });
    const after = await membershipOf(T, sec.userId);
    expect(after.disabledAt).not.toBeNull();
    expect(after.disabledById).toBe(superadminId);
    await expectPlatformAudit("platform.membership.suspend", mem.id);

    expect(await platformReactivateMember({ tenantId: T.tenantId, membershipId: mem.id })).toEqual({ ok: true, data: undefined });
    expect((await membershipOf(T, sec.userId)).disabledAt).toBeNull();
    await expectPlatformAudit("platform.membership.reactivate", mem.id);

    expect(await platformRemoveMember({ tenantId: T.tenantId, membershipId: mem.id })).toEqual({ ok: true, data: undefined });
    expect(await db.membership.count({ where: { id: mem.id } })).toBe(0);
    await expectPlatformAudit("platform.membership.remove", mem.id);
  });

  it("quitar se frena con conteo si atiende pacientes (mismas reglas que Configuración)", async () => {
    const kine = await addPractitioner(db, T);
    await addPatient(db, T, { assignedPractitionerId: kine.practitionerId });
    const mem = await membershipOf(T, kine.userId);
    const r = await platformRemoveMember({ tenantId: T.tenantId, membershipId: mem.id });
    expect(r).toEqual({ ok: false, error: expect.stringContaining("1 paciente asignado") });
    expect(await db.membership.count({ where: { id: mem.id } })).toBe(1);
  });

  it("manda el link de contraseña sin mostrárselo al superadmin; doble audit sin el link", async () => {
    const kine = await addPractitioner(db, T);
    const now = new Date().toISOString();
    gotrue.users.set(kine.userId, {
      id: kine.userId,
      email: `${kine.userId}@test.local`,
      emailConfirmedAt: now,
      lastSignInAt: now,
      createdAt: now,
      bannedUntil: null,
      password: "clave-vieja-1",
      fullName: null,
    });
    const mem = await membershipOf(T, kine.userId);
    const r = await platformSendMemberPasswordReset({ tenantId: T.tenantId, membershipId: mem.id });
    if (!r.ok) throw new Error(r.error);
    expect(r.data).toEqual({ emailSent: true, transport: "resend", emailStatus: "sent", emailReason: null });
    expect(JSON.stringify(r)).not.toMatch(/https?:\/\//);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].kind).toBe("admin_password_reset");
    const { global } = await expectPlatformAudit("platform.membership.password_reset.send", mem.id);
    expect(JSON.stringify(global.payload)).not.toMatch(/https?:\/\//);
  });

  it("consultorio inexistente → error, sin escribir", async () => {
    const r = await platformInviteTeamMember({ tenantId: "no-existe", email: `n-${uniqueSuffix()}@test.local`, firstName: "N", lastName: "E" });
    expect(r.ok).toBe(false);
    expect(mail.sent).toHaveLength(0);
  });
});
