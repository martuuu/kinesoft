/**
 * IAM-4c · administración del equipo (plan §19.4 fila 4c; IAM-D3: OWNER y ADMIN gestionan el equipo; IAM-D7:
 * suspender ≠ quitar).
 *
 *  - Cambio de rol que crea / frena el `Practitioner`: desde IAM-4a la Secretaria entra sin profesional, así que
 *    ascenderla a un rol clínico sin crearle `Practitioner` + agenda la dejaba sin acceso (`missing_practitioner`).
 *    Bajar a un rol no clínico a alguien con turnos futuros o pacientes asignados los dejaba colgados de alguien
 *    que ya no es reservable: se frena con conteo, igual que `removeMember`.
 *  - Suspender / reactivar (`Membership.disabledAt`): el suspendido no entra a ESE consultorio (cae a otro usable o
 *    a `/sin-acceso`) y no aparece en la agenda; reactivar le devuelve el acceso. Nadie se suspende a sí mismo ni
 *    suspende al dueño.
 *  - «Mandar link para nueva contraseña»: un mail `admin_password_reset` con un link de recovery; quien lo pide
 *    NUNCA ve el link (ni en el resultado ni en el audit).
 *  - Aceptar una invitación nueva reactiva una membresía suspendida del mismo consultorio (handoff de IAM-2b).
 *
 * Actions REALES contra Postgres (corre en los dos roles: `test:integration` y `:owner`). Se reemplazan solo el
 * despacho del mail (`__setEmailTransportForTests`: el sink a EmailLog sigue corriendo) y el puerto de Auth (fake).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import type { PrismaClient, Role } from "@prisma/client";
import {
  changeMemberRole,
  suspendMember,
  reactivateMember,
  sendMemberPasswordReset,
  listTeamMembers,
  createInvitation,
} from "@/lib/invitations";
import { getActor, getAccessSnapshot } from "@/lib/session";
import { listPractitioners } from "@/lib/bookings";
import { acceptInvite } from "@/app/invite/[token]/accept-action";
import { hashInviteToken } from "@/lib/invitations-tokens";
import { __setEmailTransportForTests, type SendEmailInput, type SendEmailResult } from "@/lib/email";
import { __setAuthAdminForTests } from "@/lib/identity/auth-admin";
import { emailToHash } from "@/lib/email/log";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { ACTIVE_TENANT_COOKIE } from "@/lib/active-tenant-cookie";
import { tags } from "@/lib/cache-tags";
import { GotrueFake } from "@/tests/helpers/gotrue-fake";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  addPatient,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { revalidateTagSpy } from "@/tests/helpers/integration-setup";

const RUN = process.env.INTEGRATION === "1";
const DAY = 86_400_000;

/** Registro a mano (no `vi.fn`: vitest 2.1.9 rompe con un fn que tira a través de un mock). */
const mail = {
  sent: [] as SendEmailInput[],
  transport: async (i: SendEmailInput): Promise<SendEmailResult> => {
    mail.sent.push(i);
    return { ok: true, transport: "resend", providerId: `re_${mail.sent.length}` };
  },
};

describe.skipIf(!RUN)("[IAM-4c] administración del equipo", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  /** Otro consultorio, para el «cae al otro consultorio usable». */
  let B: EphemeralTenant;
  let gotrue: GotrueFake;
  const extraUsers: string[] = [];

  const membershipOf = (t: EphemeralTenant, userId: string) =>
    db.membership.findUniqueOrThrow({ where: { userId_tenantId: { userId, tenantId: t.tenantId } } });

  async function staffWithoutPractitioner(t: EphemeralTenant, role: Role): Promise<string> {
    const id = `test-user-${uniqueSuffix()}`;
    extraUsers.push(id);
    await db.userProfile.create({ data: { id, email: `${id}@test.local`, fullName: `Staff ${role}` } });
    await db.membership.create({ data: { userId: id, tenantId: t.tenantId, role, acceptedAt: new Date() } });
    return id;
  }

  /** Usuario de Auth (fake) con el MISMO id que el UserProfile, como en Supabase. */
  function seedAuthUser(userId: string) {
    const now = new Date().toISOString();
    gotrue.users.set(userId, {
      id: userId,
      email: `${userId}@test.local`,
      emailConfirmedAt: now,
      lastSignInAt: now,
      createdAt: now,
      bannedUntil: null,
      password: "clave-vieja-1",
      fullName: null,
    });
  }

  const addBooking = (t: EphemeralTenant, practitionerId: string, at: Date, status: "CONFIRMED" | "PENDING" | "COMPLETED" = "CONFIRMED") =>
    db.booking.create({
      data: {
        tenantId: t.tenantId,
        practitionerId,
        serviceId: t.serviceId,
        scheduledFor: at,
        durationMin: 45,
        status,
        idempotencyKey: randomUUID(),
      },
    });

  beforeAll(async () => {
    db = ownerClient();
    // BO2-B (BO-D7): PRO = 10 lugares. Estos casos invitan / ascienden / reactivan profesionales; el cupo se prueba en seats.test.ts.
    A = await createEphemeralTenant(db, { plan: "PRO", saasPlan: "LIBRE" });
    B = await createEphemeralTenant(db);
  });
  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    if (db) {
      if (extraUsers.length) {
        await db.userPreferences.deleteMany({ where: { userId: { in: extraUsers } } });
        await db.userProfile.deleteMany({ where: { id: { in: extraUsers }, practitioners: { none: {} } } });
      }
      await db.$disconnect();
    }
  });
  beforeEach(() => {
    __rateLimitInternals.reset();
    mail.sent.length = 0;
    gotrue = new GotrueFake();
    __setAuthAdminForTests(gotrue);
    __setEmailTransportForTests(mail.transport);
    revalidateTagSpy.mockClear();
    cookies().delete(ACTIVE_TENANT_COOKIE);
    asUser(A.userId);
  });
  afterEach(() => {
    __setAuthAdminForTests(null);
    __setEmailTransportForTests(null);
  });

  // ── Cambio de rol ─────────────────────────────────────────────────────────

  it("ascender a una Secretaria sin Practitioner le crea el profesional con agenda, en la misma action, y entra como profesional", async () => {
    const sec = await staffWithoutPractitioner(A, "ASSISTANT");
    const m = await membershipOf(A, sec);
    expect(await changeMemberRole(m.id, "PRACTITIONER")).toEqual({ ok: true, data: undefined });

    const prac = await db.practitioner.findUniqueOrThrow({ where: { tenantId_userId: { tenantId: A.tenantId, userId: sec } } });
    expect(prac.specialty).toBeNull();
    expect(await db.practitionerSchedule.count({ where: { tenantId: A.tenantId, practitionerId: prac.id } })).toBeGreaterThan(0);
    // Coberturas activas (la Particular de la factory) habilitadas, como en un alta por invitación.
    expect(await db.practitionerPayer.count({ where: { tenantId: A.tenantId, practitionerId: prac.id } })).toBeGreaterThan(0);
    expect((await listPractitioners()).map((p) => p.id)).toContain(prac.id);
    expect(revalidateTagSpy).toHaveBeenCalledWith(tags.practitioners(A.tenantId));

    asUser(sec);
    const actor = await getActor();
    expect(actor.tenantId).toBe(A.tenantId);
    expect(actor.practitionerId).toBe(prac.id);
  });

  it("ascender a alguien que ya tenía Practitioner lo reusa (no duplica ni pisa la especialidad)", async () => {
    const vieja = await addPractitioner(db, A, "ASSISTANT"); // fila vieja de antes de IAM-4a, specialty "Test"
    const m = await membershipOf(A, vieja.userId);
    expect((await changeMemberRole(m.id, "ADMIN")).ok).toBe(true);
    const rows = await db.practitioner.findMany({ where: { tenantId: A.tenantId, userId: vieja.userId } });
    expect(rows.map((r) => [r.id, r.specialty])).toEqual([[vieja.practitionerId, "Test"]]);
  });

  it("bajar a un rol no clínico con turnos futuros o pacientes asignados se rechaza con conteo y no cambia nada", async () => {
    const kine = await addPractitioner(db, A);
    await addBooking(A, kine.practitionerId, new Date(Date.now() + 2 * DAY));
    await addBooking(A, kine.practitionerId, new Date(Date.now() + 3 * DAY), "PENDING");
    await addBooking(A, kine.practitionerId, new Date(Date.now() - 2 * DAY), "COMPLETED"); // pasado: no cuenta
    await addPatient(db, A, { assignedPractitionerId: kine.practitionerId });
    const m = await membershipOf(A, kine.userId);

    for (const role of ["ASSISTANT", "BILLING"] as const) {
      const r = await changeMemberRole(m.id, role);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain("Reasigná sus 2 turnos futuros y 1 paciente asignado antes de cambiarle el rol");
      }
    }
    expect((await membershipOf(A, kine.userId)).role).toBe("PRACTITIONER");
    expect(await db.auditEvent.count({ where: { tenantId: A.tenantId, action: "membership.role.change", entityId: m.id } })).toBe(0);
    // §20.17: el Administrador/a no atiende: pasar a ADMIN tiene los mismos bloqueos.
    const admin = await changeMemberRole(m.id, "ADMIN");
    expect(admin.ok).toBe(false);
    if (!admin.ok) expect(admin.error).toContain("Reasigná sus 2 turnos futuros y 1 paciente asignado");
    expect((await membershipOf(A, kine.userId)).role).toBe("PRACTITIONER");
  });

  it("bajar a un rol no clínico sin turnos ni pacientes: OK, la fila Practitioner queda pero deja de ser reservable", async () => {
    const kine = await addPractitioner(db, A);
    await addBooking(A, kine.practitionerId, new Date(Date.now() - 5 * DAY), "COMPLETED");
    const m = await membershipOf(A, kine.userId);
    expect(await changeMemberRole(m.id, "ASSISTANT")).toEqual({ ok: true, data: undefined });
    expect(await db.practitioner.count({ where: { id: kine.practitionerId } })).toBe(1);
    expect((await listPractitioners()).map((p) => p.id)).not.toContain(kine.practitionerId);
    asUser(kine.userId);
    expect((await getActor()).practitionerId).toBeNull();
  });

  // ── Suspender / reactivar ─────────────────────────────────────────────────

  it("suspender saca el acceso (sin otro consultorio → no_access all_disabled) y la agenda; reactivar lo devuelve", async () => {
    const kine = await addPractitioner(db, A);
    const m = await membershipOf(A, kine.userId);

    expect(await suspendMember(m.id)).toMatchObject({ ok: true });
    const row = await membershipOf(A, kine.userId);
    expect(row.disabledAt).not.toBeNull();
    expect(row.disabledById).toBe(A.userId);
    expect((await listPractitioners()).map((p) => p.id)).not.toContain(kine.practitionerId);
    const listed = (await listTeamMembers()).find((t) => t.membershipId === m.id);
    expect(listed?.disabledAt).toBeInstanceOf(Date);
    expect(listed?.hasAgenda).toBe(true);
    expect(await db.auditEvent.count({ where: { tenantId: A.tenantId, action: "membership.suspend", entityId: m.id } })).toBe(1);
    expect(revalidateTagSpy).toHaveBeenCalledWith(tags.practitioners(A.tenantId));

    asUser(kine.userId);
    await expect(getActor()).rejects.toMatchObject({ name: "UnauthenticatedError" });
    expect((await getAccessSnapshot())?.state).toEqual({ kind: "no_access", reason: "all_disabled" });

    asUser(A.userId);
    expect(await reactivateMember(m.id)).toEqual({ ok: true, data: undefined });
    const back = await membershipOf(A, kine.userId);
    expect(back.disabledAt).toBeNull();
    expect(back.disabledById).toBeNull();
    expect((await listPractitioners()).map((p) => p.id)).toContain(kine.practitionerId);
    expect((await listTeamMembers()).find((t) => t.membershipId === m.id)?.disabledAt).toBeNull();
    expect(await db.auditEvent.count({ where: { tenantId: A.tenantId, action: "membership.reactivate", entityId: m.id } })).toBe(1);

    asUser(kine.userId);
    expect((await getActor()).tenantId).toBe(A.tenantId);
  });

  it("un suspendido en A que es miembro de B cae a B aunque la cookie apunte a A", async () => {
    const kine = await addPractitioner(db, A);
    await db.practitioner.create({ data: { tenantId: B.tenantId, userId: kine.userId } });
    await db.membership.create({ data: { userId: kine.userId, tenantId: B.tenantId, role: "PRACTITIONER", acceptedAt: new Date() } });
    try {
      const m = await membershipOf(A, kine.userId);
      expect((await suspendMember(m.id)).ok).toBe(true);
      asUser(kine.userId);
      cookies().set(ACTIVE_TENANT_COOKIE, A.tenantId);
      expect((await getActor()).tenantId).toBe(B.tenantId);
    } finally {
      await db.membership.deleteMany({ where: { userId: kine.userId, tenantId: B.tenantId } });
      await db.practitioner.deleteMany({ where: { userId: kine.userId, tenantId: B.tenantId } });
    }
  });

  it("nadie se suspende a sí mismo, nadie suspende al dueño, y el ADMIN no toca al dueño", async () => {
    const own = await membershipOf(A, A.userId);
    expect((await suspendMember(own.id)).ok).toBe(false);

    const admin = await addPractitioner(db, A, "ADMIN");
    const adminMem = await membershipOf(A, admin.userId);
    asUser(admin.userId);
    expect((await suspendMember(adminMem.id)).ok).toBe(false);
    expect((await suspendMember(own.id)).ok).toBe(false);
    expect((await sendMemberPasswordReset(own.id)).ok).toBe(false);
    expect((await membershipOf(A, A.userId)).disabledAt).toBeNull();
    expect((await membershipOf(A, admin.userId)).disabledAt).toBeNull();
    expect(mail.sent).toHaveLength(0);

    // El ADMIN sí suspende y reactiva a un profesional.
    const kine = await addPractitioner(db, A);
    const km = await membershipOf(A, kine.userId);
    expect((await suspendMember(km.id)).ok).toBe(true);
    expect((await reactivateMember(km.id)).ok).toBe(true);
  });

  it("no suspende un miembro de otro consultorio", async () => {
    const memB = await membershipOf(B, B.userId);
    expect((await suspendMember(memB.id)).ok).toBe(false);
    expect((await membershipOf(B, B.userId)).disabledAt).toBeNull();
  });

  it("PRACTITIONER/ASSISTANT no gestionan: suspender, reactivar y mandar link → Forbidden", async () => {
    const kine = await addPractitioner(db, A);
    const target = await membershipOf(A, kine.userId);
    for (const role of ["PRACTITIONER", "ASSISTANT"] as const) {
      const u = role === "ASSISTANT" ? await staffWithoutPractitioner(A, role) : (await addPractitioner(db, A, role)).userId;
      asUser(u);
      await expect(suspendMember(target.id)).rejects.toMatchObject({ name: "ForbiddenError" });
      await expect(reactivateMember(target.id)).rejects.toMatchObject({ name: "ForbiddenError" });
      await expect(sendMemberPasswordReset(target.id)).rejects.toMatchObject({ name: "ForbiddenError" });
    }
    expect((await membershipOf(A, kine.userId)).disabledAt).toBeNull();
    expect(mail.sent).toHaveLength(0);
  });

  it("re-invitar a un miembro suspendido se rechaza con la salida correcta (Reactivar)", async () => {
    const kine = await addPractitioner(db, A);
    const m = await membershipOf(A, kine.userId);
    expect((await suspendMember(m.id)).ok).toBe(true);
    const r = await createInvitation({ email: `${kine.userId}@test.local`, firstName: "K", lastName: "S" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Reactivar");
  });

  it("suspender anula las invitaciones pendientes a ese email (una vieja no puede reactivarlo sola)", async () => {
    const kine = await addPractitioner(db, A);
    const inv = await db.invitation.create({
      data: {
        tenantId: A.tenantId,
        email: `${kine.userId}@test.local`,
        firstName: "K",
        lastName: "S",
        token: hashInviteToken(randomBytes(24).toString("base64url")),
        invitedById: A.userId,
        expiresAt: new Date(Date.now() + DAY),
      },
    });
    const m = await membershipOf(A, kine.userId);
    expect((await suspendMember(m.id)).ok).toBe(true);
    const after = await db.invitation.findUniqueOrThrow({ where: { id: inv.id } });
    expect(after.revokedAt).not.toBeNull();
    expect(after.revokedById).toBe(A.userId);
  });

  it("aceptar una invitación NUEVA reactiva la membresía suspendida (con el rol invitado)", async () => {
    const kine = await addPractitioner(db, A);
    const m = await membershipOf(A, kine.userId);
    expect((await suspendMember(m.id)).ok).toBe(true);

    const raw = randomBytes(24).toString("base64url");
    await db.invitation.create({
      data: {
        tenantId: A.tenantId,
        email: `${kine.userId}@test.local`,
        firstName: "K",
        lastName: "S",
        role: "ADMIN",
        token: hashInviteToken(raw),
        invitedById: A.userId,
        expiresAt: new Date(Date.now() + DAY),
      },
    });
    asUser(kine.userId);
    expect(await acceptInvite(raw)).toMatchObject({ ok: true });
    const row = await membershipOf(A, kine.userId);
    expect(row.disabledAt).toBeNull();
    expect(row.disabledById).toBeNull();
    expect(row.role).toBe("ADMIN");
    const ev = await db.auditEvent.findFirstOrThrow({
      where: { tenantId: A.tenantId, action: "invitation.accept", actorId: kine.userId },
      orderBy: { createdAt: "desc" },
    });
    expect(ev.payload).toMatchObject({ reactivated: true });
    expect((await getActor()).tenantId).toBe(A.tenantId);
  });

  // ── Link para nueva contraseña ────────────────────────────────────────────

  it("manda 1 mail admin_password_reset con un link de recovery; el resultado y el audit no traen el link; queda EmailLog", async () => {
    const kine = await addPractitioner(db, A);
    seedAuthUser(kine.userId);
    const m = await membershipOf(A, kine.userId);

    const r = await sendMemberPasswordReset(m.id);
    expect(r).toEqual({ ok: true, data: { emailSent: true, transport: "resend", emailStatus: "sent", emailReason: null } });
    expect(JSON.stringify(r)).not.toContain("token_hash");

    expect(mail.sent).toHaveLength(1);
    const sent = mail.sent[0];
    expect(sent).toMatchObject({ kind: "admin_password_reset", to: `${kine.userId}@test.local`, tenantId: A.tenantId, entity: "Membership", entityId: m.id, actorId: A.userId });
    const link = gotrue.links.at(-1);
    expect(link).toMatchObject({ type: "recovery", email: `${kine.userId}@test.local` });
    // El link va en el mail (a /auth/confirm con type=recovery y next=/reset), con el nombre del consultorio.
    expect(sent.text).toContain(`token_hash=${link!.hashedToken}`);
    expect(sent.text).toContain("type=recovery");
    expect(sent.text).toContain("next=%2Freset");
    expect(sent.text).toContain(`Test ${A.slug.replace("test-", "")}`);

    const log = await db.emailLog.findFirstOrThrow({ where: { tenantId: A.tenantId, entity: "Membership", entityId: m.id } });
    expect(log).toMatchObject({ kind: "admin_password_reset", status: "sent", toHash: emailToHash(`${kine.userId}@test.local`) });

    const ev = await db.auditEvent.findFirstOrThrow({ where: { tenantId: A.tenantId, action: "membership.password_reset.send", entityId: m.id } });
    expect(JSON.stringify(ev.payload)).not.toContain(link!.hashedToken);
    expect(JSON.stringify(ev.payload)).not.toContain("/auth/confirm");

    const listed = (await listTeamMembers()).find((t) => t.membershipId === m.id);
    expect(listed?.lastPasswordResetEmail).toMatchObject({ status: "sent", transport: "resend" });

    // Rate limit por destinatario: el segundo pedido seguido no manda otro mail.
    const again = await sendMemberPasswordReset(m.id);
    expect(again.ok).toBe(false);
    expect(mail.sent).toHaveLength(1);
  });

  it("el ADMIN también manda el link (sin verlo); sin cuenta de Auth o suspendido no se manda nada", async () => {
    const admin = await addPractitioner(db, A, "ADMIN");
    const kine = await addPractitioner(db, A);
    seedAuthUser(kine.userId);
    const km = await membershipOf(A, kine.userId);
    asUser(admin.userId);
    const r = await sendMemberPasswordReset(km.id);
    expect(r).toMatchObject({ ok: true, data: { emailSent: true } });
    expect(JSON.stringify(r)).not.toContain("auth/confirm");

    // Sin usuario de Auth (nunca activó): error claro y ningún mail.
    const sinCuenta = await addPractitioner(db, A);
    const sm = await membershipOf(A, sinCuenta.userId);
    const r2 = await sendMemberPasswordReset(sm.id);
    expect(r2.ok).toBe(false);

    // Suspendido: primero reactivar.
    const susp = await addPractitioner(db, A);
    seedAuthUser(susp.userId);
    const spm = await membershipOf(A, susp.userId);
    expect((await suspendMember(spm.id)).ok).toBe(true);
    const r3 = await sendMemberPasswordReset(spm.id);
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.error).toContain("suspendid");
    expect(mail.sent).toHaveLength(1);
  });
});
