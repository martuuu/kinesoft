/**
 * BO2-B · cupos del plan en el equipo (BO-D7, plan §19.10: Free 1 · Base 3 · PRO 10 profesionales · Enterprise a
 * medida; Secretaria y Facturación no ocupan; bajar de plan no saca a nadie).
 *
 * Antes de BO2 el plan solo decidía módulos: un Free invitaba profesionales sin límite. Ahora ocupan lugar los
 * miembros clínicos ACTIVOS + las invitaciones clínicas pendientes (reservan el lugar), y lo piden invitar,
 * ascender de no clínico a clínico, reactivar a un clínico y reabrir una invitación clínica vencida.
 *
 * Símbolos REALES (`lib/invitations.ts` y `lib/platform-team.ts` sobre `lib/team-internal.ts`) contra Postgres en
 * los dos roles. Se reemplazan solo la sesión, el despacho del mail y GoTrue.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { PrismaClient, Role, TenantPlan } from "@prisma/client";
import {
  changeMemberRole,
  createInvitation,
  listTeamMembers,
  reactivateMember,
  resendInvitation,
  revokeInvitation,
} from "@/lib/invitations";
import { platformInviteTeamMember } from "@/lib/platform-team";
import { getTenantTeamForPlatform } from "@/lib/platform-team-read";
import { activateInvitation } from "@/lib/invite-activation-internal";
import { checkSeatForJoinInTx, SeatLimitError, SEAT_LIMIT_JOIN_MESSAGE } from "@/lib/team-internal";
import { prismaService } from "@/lib/db";
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

const mail = {
  sent: [] as SendEmailInput[],
  transport: async (i: SendEmailInput): Promise<SendEmailResult> => {
    mail.sent.push(i);
    return { ok: true, transport: "resend", providerId: `re_${mail.sent.length}` };
  },
};

describe.skipIf(!RUN)("[BO2-B] cupos del plan (BO-D7)", () => {
  let db: PrismaClient;
  const tenants: EphemeralTenant[] = [];
  const users: string[] = [];
  let gotrue: GotrueFake;

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

  async function tenant(plan: TenantPlan, seatLimitOverride: number | null = null) {
    const t = await createEphemeralTenant(db, { plan, seatLimitOverride });
    tenants.push(t);
    asUser(t.userId);
    return t;
  }

  async function staff(t: EphemeralTenant, role: Role, disabled = false) {
    const id = `test-user-${uniqueSuffix()}`;
    users.push(id);
    await db.userProfile.create({ data: { id, email: `${id}@test.local`, fullName: `Staff ${role}` } });
    return db.membership.create({
      data: { userId: id, tenantId: t.tenantId, role, acceptedAt: new Date(), disabledAt: disabled ? new Date() : null },
    });
  }

  const invite = (role: "PRACTITIONER" | "ADMIN" | "ASSISTANT" | "BILLING") =>
    createInvitation({ email: `seat-${uniqueSuffix()}@test.local`, firstName: "S", lastName: "T", role });

  it("Free (1 lugar, lo ocupa el dueño): no se invita a un profesional; Secretaria y Facturación sí", async () => {
    const t = await tenant("FREE");
    const r = await invite("PRACTITIONER");
    expect(r).toEqual({ ok: false, error: expect.stringContaining("Tu plan tiene 1 lugar para profesionales") });
    // [BO-Z] C8: sin «pedí ampliar el plan» (no hay ese canal en la app): dice a quién escribir.
    if (!r.ok) {
      expect(r.error).not.toContain("ampliar el plan");
      expect(r.error).toContain("el titular puede escribirle al equipo de KineSoft");
    }
    expect((await invite("ADMIN")).ok).toBe(false);
    expect(await db.invitation.count({ where: { tenantId: t.tenantId, role: { in: ["PRACTITIONER", "ADMIN"] } } })).toBe(0);
    expect((await invite("ASSISTANT")).ok).toBe(true);
    expect((await invite("BILLING")).ok).toBe(true);
    expect(mail.sent).toHaveLength(2);
  });

  it("Base (3): una invitación pendiente reserva el lugar; anularla lo libera; re-invitar el mismo email no cuenta doble", async () => {
    const t = await tenant("STARTER");
    await addPractitioner(db, t); // dueño + 1 = 2
    const first = await invite("PRACTITIONER"); // 3 (reservado)
    if (!first.ok) throw new Error(first.error);
    expect((await invite("PRACTITIONER")).ok).toBe(false);

    // Re-invitar el MISMO email (cambia el rol a otro clínico) no ocupa otro lugar.
    __rateLimitInternals.reset();
    const row = await db.invitation.findUniqueOrThrow({ where: { id: first.data.id } });
    const again = await createInvitation({ email: row.email, firstName: "S", lastName: "T", role: "ADMIN" });
    expect(again.ok).toBe(true);

    expect((await revokeInvitation(first.data.id)).ok).toBe(true);
    expect((await invite("PRACTITIONER")).ok).toBe(true);
  });

  it("un suspendido no ocupa; reactivar a un clínico pide lugar, a la Secretaria no", async () => {
    const t = await tenant("STARTER");
    const k1 = await staff(t, "PRACTITIONER", true); // suspendido: no cuenta
    await addPractitioner(db, t);
    await addPractitioner(db, t); // dueño + 2 activos = 3 (lleno)
    const sec = await staff(t, "ASSISTANT", true);
    const r = await reactivateMember(k1.id);
    expect(r).toEqual({ ok: false, error: expect.stringContaining("están ocupados") });
    expect((await db.membership.findUniqueOrThrow({ where: { id: k1.id } })).disabledAt).not.toBeNull();
    expect(await reactivateMember(sec.id)).toEqual({ ok: true, data: undefined });
  });

  it("ascender a la Secretaria a profesional pide lugar; entre roles clínicos no", async () => {
    const t = await tenant("FREE");
    const sec = await staff(t, "ASSISTANT");
    const r = await changeMemberRole(sec.id, "PRACTITIONER");
    expect(r.ok).toBe(false);
    expect((await db.membership.findUniqueOrThrow({ where: { id: sec.id } })).role).toBe("ASSISTANT");
    expect(await db.practitioner.count({ where: { tenantId: t.tenantId, userId: sec.userId } })).toBe(0);
    // Bajar a no clínico y volver: entre clínicos (PRACTITIONER → ADMIN) no pide lugar aunque esté lleno.
    const kine = await addPractitioner(db, t); // dueño + 1 en un Free: por encima del cupo (dato heredado)
    const km = await db.membership.findFirstOrThrow({ where: { tenantId: t.tenantId, userId: kine.userId } });
    expect(await changeMemberRole(km.id, "ADMIN")).toEqual({ ok: true, data: undefined });
  });

  it("reabrir (reenviar) una invitación clínica VENCIDA pide lugar; una vigente no", async () => {
    const t = await tenant("FREE", 2);
    const ok = await invite("PRACTITIONER"); // dueño + 1 pendiente = 2 (lleno)
    if (!ok.ok) throw new Error(ok.error);
    __rateLimitInternals.reset();
    expect((await resendInvitation(ok.data.id)).ok).toBe(true);
    // Vence (deja de reservar) y otro ocupa el lugar.
    await db.invitation.update({ where: { id: ok.data.id }, data: { expiresAt: new Date(Date.now() - DAY) } });
    await addPractitioner(db, t);
    __rateLimitInternals.reset();
    const r = await resendInvitation(ok.data.id);
    expect(r).toEqual({ ok: false, error: expect.stringContaining("Tu plan tiene 2 lugares") });
    expect((await db.invitation.findUniqueOrThrow({ where: { id: ok.data.id } })).expiresAt.getTime()).toBeLessThan(Date.now());
  });

  it("el cupo a medida (seatLimitOverride) gana sobre el del plan", async () => {
    await tenant("FREE", 3);
    expect((await invite("PRACTITIONER")).ok).toBe(true);
    expect((await invite("PRACTITIONER")).ok).toBe(true);
    expect((await invite("PRACTITIONER")).ok).toBe(false);
  });

  it("dos invitaciones simultáneas por el último lugar: entra una sola (FOR UPDATE sobre el Tenant)", async () => {
    const t = await tenant("FREE", 2);
    const results = await Promise.all([invite("PRACTITIONER"), invite("PRACTITIONER"), invite("PRACTITIONER")]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await db.invitation.count({ where: { tenantId: t.tenantId, revokedAt: null, acceptedAt: null } })).toBe(1);
  });

  it("bajar de plan no saca a nadie: los que están siguen y el uso queda por encima del cupo", async () => {
    const t = await tenant("PRO");
    await addPractitioner(db, t);
    await addPractitioner(db, t);
    const before = (await listTeamMembers()).map((m) => m.membershipId).sort();
    await db.tenant.update({ where: { id: t.tenantId }, data: { plan: "FREE" } });
    expect((await listTeamMembers()).map((m) => m.membershipId).sort()).toEqual(before);
    expect(await db.membership.count({ where: { tenantId: t.tenantId, disabledAt: null } })).toBe(3);
    expect((await invite("PRACTITIONER")).ok).toBe(false);
    expect((await invite("ASSISTANT")).ok).toBe(true);

    const su = `test-user-${uniqueSuffix()}`;
    users.push(su);
    await db.userProfile.create({ data: { id: su, email: `${su}@test.local`, isPlatformAdmin: true } });
    asUser(su);
    const team = await getTenantTeamForPlatform(t.tenantId);
    expect(team!.seats).toEqual({ used: 3, limit: 1, remaining: 0, full: true });
  });

  it("desde Plataforma rige el mismo cupo (copy del superadmin)", async () => {
    const t = await tenant("FREE");
    const su = `test-user-${uniqueSuffix()}`;
    users.push(su);
    await db.userProfile.create({ data: { id: su, email: `${su}@test.local`, isPlatformAdmin: true } });
    asUser(su);
    const r = await platformInviteTeamMember({
      tenantId: t.tenantId,
      email: `seat-p-${uniqueSuffix()}@test.local`,
      firstName: "P",
      lastName: "T",
      role: "PRACTITIONER",
    });
    expect(r).toEqual({ ok: false, error: expect.stringContaining("El plan del consultorio tiene 1 lugar") });
    const s = await platformInviteTeamMember({
      tenantId: t.tenantId,
      email: `seat-s-${uniqueSuffix()}@test.local`,
      firstName: "S",
      lastName: "T",
      role: "ASSISTANT",
    });
    expect(s.ok).toBe(true);
  });

  it("checkSeatForJoinInTx (el chequeo del handoff): frena al que no está adentro, deja pasar a quien ya ocupa y a la Secretaria", async () => {
    const t = await tenant("FREE");
    const join = (userId: string, role: Role) =>
      prismaService.$transaction((tx) => checkSeatForJoinInTx(tx, { tenantId: t.tenantId, userId, role }));
    await expect(join(`nadie-${uniqueSuffix()}`, "PRACTITIONER")).rejects.toBeInstanceOf(SeatLimitError);
    await expect(join(`nadie-${uniqueSuffix()}`, "ASSISTANT")).resolves.toBeUndefined();
    // El dueño re-aceptando (ya es miembro clínico activo) no ocupa un lugar nuevo.
    await expect(join(t.userId, "ADMIN")).resolves.toBeUndefined();
    await db.tenant.update({ where: { id: t.tenantId }, data: { seatLimitOverride: 2 } });
    await expect(join(`nadie-${uniqueSuffix()}`, "PRACTITIONER")).resolves.toBeUndefined();
  });

  /**
   * La invitación reservó el lugar, pero si el plan bajó entre la invitación y la aceptación, activar no tiene que
   * meter a alguien por encima del cupo. `checkSeatForJoinInTx` (lib/team-internal.ts, `FOR UPDATE` sobre el Tenant)
   * va en `joinTenantInTx` antes del CAS de la invitación. Arrancó como it.fails; lo dio vuelta el integrador de BO2.
   */
  it("[BO2-B] activar una invitación clínica con el cupo lleno no crea la membresía", async () => {
    const t = await tenant("PRO");
    const raw = randomBytes(24).toString("base64url");
    const email = `seat-act-${randomBytes(4).toString("hex")}@example.com`;
    const inv = await db.invitation.create({
      data: {
        tenantId: t.tenantId,
        email,
        firstName: "Ana",
        lastName: "Pérez",
        role: "PRACTITIONER",
        token: hashInviteToken(raw),
        invitedById: t.userId,
        expiresAt: new Date(Date.now() + DAY),
      },
    });
    // El plan baja a Free con la invitación pendiente: el dueño ya ocupa el único lugar.
    await db.tenant.update({ where: { id: t.tenantId }, data: { plan: "FREE" } });
    asAnonymous();
    const r = await activateInvitation(
      { token: raw, firstName: "Ana", lastName: "Pérez", password: "clave-segura-1", passwordConfirm: "clave-segura-1" },
      { ip: "203.0.113.9" }
    );
    if (r.ok) users.push(r.userId);
    expect(r).toMatchObject({ ok: false, code: "seat_limit", error: SEAT_LIMIT_JOIN_MESSAGE });
    expect(await db.membership.count({ where: { tenantId: t.tenantId, user: { email } } })).toBe(0);
    expect((await db.invitation.findUniqueOrThrow({ where: { id: inv.id } })).acceptedAt).toBeNull();
  });
});
