/**
 * BO2-B → PL-1c · cupos del plan en el equipo, POR TIPO (plan §20.5.3, PL-D3; decisión 1 de Martin del 15-oct):
 * Individual 1 usuario · Consultorio 4 profesionales + 1 no clínico (total 5) · Clínica 10 de cualquier tipo ·
 * Libre a medida. Ocupan lugar todos los miembros ACTIVOS (el Titular según atienda) + las invitaciones pendientes
 * vigentes (reservan el lugar del tipo de su rol). Lo piden invitar, cambiar de rol o «¿Atiende?» a otro tipo,
 * reactivar y reabrir una invitación vencida. Antes (BO-D7) solo contaban los roles clínicos.
 *
 * Símbolos REALES (`lib/invitations.ts` y `lib/platform-team.ts` sobre `lib/team-internal.ts`) contra Postgres en
 * los dos roles. Se reemplazan solo la sesión, el despacho del mail y GoTrue.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { PrismaClient, Role, SaasPlan } from "@prisma/client";
import { LEGACY_PLAN_OF, PLAN_DEFAULTS } from "@/lib/saas-plans-logic";
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
import {
  changeMemberRoleInTx,
  checkSeatForJoinInTx,
  INVITE_ADMIN_CLINICAL_MESSAGE,
  runTeamTx,
  SeatLimitError,
  SEAT_LIMIT_JOIN_MESSAGE,
  setMemberClinicalInTx,
  setMemberGrantsInTx,
  type TeamActorCtx,
} from "@/lib/team-internal";
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
  addPatient,
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

describe.skipIf(!RUN)("[BO2-B → PL-1c] cupos del plan por tipo (PL-D3)", () => {
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

  /**
   * PL-Z a3#1: los overrides de cupo solo valen en Libre. Un «Consultorio con tope por tipo a medida» se arma como
   * Libre con el total del plan pedido (`maxUsersOverride` = el del plan, salvo que el test lo fije), que es como
   * Plataforma lo pactaría hoy.
   */
  async function tenant(requested: SaasPlan, overrides: Partial<Record<"maxUsersOverride" | "maxProfessionalsOverride" | "maxStaffOverride", number>> = {}) {
    const custom = Object.keys(overrides).length > 0;
    const saasPlan: SaasPlan = custom ? "LIBRE" : requested;
    const t = await createEphemeralTenant(db, { saasPlan, plan: LEGACY_PLAN_OF[saasPlan] });
    if (custom) {
      const maxUsers = PLAN_DEFAULTS[requested].limits.maxUsers;
      await db.tenant.update({
        where: { id: t.tenantId },
        data: { ...(maxUsers != null ? { maxUsersOverride: maxUsers } : {}), ...overrides },
      });
    }
    tenants.push(t);
    asUser(t.userId);
    return t;
  }

  /**
   * Pasar a ADMIN por el núcleo con el ctx del Titular: desde PL-Z (a2#7) la action `changeMemberRole` pide step-up
   * para ADMIN (lo cubre pl3b-team.test.ts con la sesión de 2FA); acá se fija el cupo y el bloqueo, no el step-up.
   */
  const toAdmin = (t: EphemeralTenant, membershipId: string) => {
    const ctx: TeamActorCtx = { via: "tenant", tenantId: t.tenantId, actorUserId: t.userId, actorRole: "OWNER", actorRef: null };
    return runTeamTx(ctx, (tx) => changeMemberRoleInTx(tx, ctx, { membershipId, role: "ADMIN" }));
  };

  async function staff(t: EphemeralTenant, role: Role, disabled = false, clinical?: boolean) {
    const id = `test-user-${uniqueSuffix()}`;
    users.push(id);
    await db.userProfile.create({ data: { id, email: `${id}@test.local`, fullName: `Staff ${role}` } });
    return db.membership.create({
      data: {
        userId: id,
        tenantId: t.tenantId,
        role,
        clinical: clinical ?? (role !== "ASSISTANT" && role !== "BILLING"),
        acceptedAt: new Date(),
        disabledAt: disabled ? new Date() : null,
      },
    });
  }

  const invite = (role: "PRACTITIONER" | "ADMIN" | "ASSISTANT" | "BILLING", extra: { clinical?: boolean } = {}) =>
    createInvitation({ email: `seat-${uniqueSuffix()}@test.local`, firstName: "S", lastName: "T", role, ...extra });

  const tenantCtx = (t: EphemeralTenant, actorUserId = t.userId, actorRole: Role = "OWNER"): TeamActorCtx => ({
    via: "tenant",
    tenantId: t.tenantId,
    actorUserId,
    actorRole,
    actorRef: null,
  });

  it("[PL-1c] Individual (1 usuario, lo ocupa el Titular): no se invita a NADIE, tampoco a la Secretaria", async () => {
    const t = await tenant("INDIVIDUAL");
    for (const role of ["PRACTITIONER", "ADMIN", "ASSISTANT", "BILLING"] as const) {
      const r = await invite(role);
      expect(r).toEqual({ ok: false, error: expect.stringContaining("Tu plan tiene 1 usuario") });
    }
    expect(await db.invitation.count({ where: { tenantId: t.tenantId } })).toBe(0);
    expect(mail.sent).toHaveLength(0);
  });

  // §20.17 (Martin, 15-oct): Consultorio = 5 usuarios de CUALQUIER tipo. `PLAN_DEFAULTS` ya lo dice, pero los límites
  // salen de la fila de `SaasPlanConfig`, que M8 sembró con 4 + 1 y corrige la migración M8b (inicio de PL-2:
  // `20261015200000_pl_admin_consultorio`, límites por tipo a NULL). Estos tres arrancaron como `it.fails("[M8b] …")`
  // y M8b los dio vuelta: dependen de que la base tenga M8b aplicada.
  it("[M8b] Consultorio: 5 usuarios de cualquier tipo (entra el 5.º profesional; frena el 6.º usuario)", async () => {
    const t = await tenant("CONSULTORIO");
    await addPractitioner(db, t);
    await addPractitioner(db, t);
    await addPractitioner(db, t); // Titular + 3 = 4 profesionales
    expect((await invite("PRACTITIONER")).ok).toBe(true); // 5 profesionales: Martin, 15-oct (cada uno autogestiona)
    const sixth = await invite("ASSISTANT");
    expect(sixth).toEqual({ ok: false, error: expect.stringContaining("Tu plan tiene 5 usuarios y están ocupados") });
    expect(await db.invitation.count({ where: { tenantId: t.tenantId } })).toBe(1);
  });

  it("[M8b] Consultorio: sin tope por tipo, también entran varias personas no clínicas", async () => {
    const t = await tenant("CONSULTORIO");
    await staff(t, "ASSISTANT"); // Titular + Secretaria = 2 de 5
    expect((await invite("BILLING")).ok).toBe(true);
    expect((await invite("ADMIN")).ok).toBe(true);
    expect((await invite("PRACTITIONER")).ok).toBe(true); // 5 de 5
    expect((await invite("PRACTITIONER")).ok).toBe(false);
  });

  it("[PL-1c] un tope por tipo a medida rige aunque sobre total (Libre/excepción)", async () => {
    const t = await tenant("CONSULTORIO", { maxStaffOverride: 1 });
    await staff(t, "ASSISTANT"); // no clínicos 1 de 1
    const r = await invite("BILLING");
    expect(r).toEqual({ ok: false, error: expect.stringContaining("Tu plan tiene 1 lugar para Secretaría o administración") });
    expect((await invite("PRACTITIONER")).ok).toBe(true);
  });

  it("[M8b] Titular que no atiende igual ocupa uno de los 5 lugares del Consultorio", async () => {
    const t = await tenant("CONSULTORIO");
    await db.membership.updateMany({ where: { tenantId: t.tenantId, userId: t.userId }, data: { clinical: false } });
    expect((await invite("ASSISTANT")).ok).toBe(true);
    for (let i = 0; i < 3; i++) expect((await invite("PRACTITIONER")).ok).toBe(true);
    expect((await invite("PRACTITIONER")).ok).toBe(false);
  });

  it("una invitación pendiente reserva el lugar; anularla lo libera; re-invitar el mismo email no cuenta doble", async () => {
    const t = await tenant("CONSULTORIO", { maxProfessionalsOverride: 3 });
    await addPractitioner(db, t); // Titular + 1 = 2
    const first = await invite("PRACTITIONER"); // 3 (reservado)
    if (!first.ok) throw new Error(first.error);
    expect((await invite("PRACTITIONER")).ok).toBe(false);

    // Re-invitar el MISMO email (mismo tipo de lugar, datos nuevos) no ocupa otro lugar.
    __rateLimitInternals.reset();
    const row = await db.invitation.findUniqueOrThrow({ where: { id: first.data.id } });
    const again = await createInvitation({ email: row.email, firstName: "Otro", lastName: "Nombre", role: "PRACTITIONER" });
    expect(again.ok).toBe(true);

    expect((await revokeInvitation(first.data.id)).ok).toBe(true);
    expect((await invite("PRACTITIONER")).ok).toBe(true);
  });

  it("un suspendido no ocupa; reactivar pide lugar de SU tipo", async () => {
    // Topes por tipo a medida: desde §20.17 el Consultorio no topea por tipo.
    const t = await tenant("CONSULTORIO", { maxProfessionalsOverride: 3, maxStaffOverride: 1 });
    const k1 = await staff(t, "PRACTITIONER", true); // suspendido: no cuenta
    await addPractitioner(db, t);
    await addPractitioner(db, t); // Titular + 2 activos = 3 (lleno)
    const sec = await staff(t, "ASSISTANT", true);
    const r = await reactivateMember(k1.id);
    expect(r).toEqual({ ok: false, error: expect.stringContaining("están ocupados") });
    expect((await db.membership.findUniqueOrThrow({ where: { id: k1.id } })).disabledAt).not.toBeNull();
    expect(await reactivateMember(sec.id)).toEqual({ ok: true, data: undefined });
    // Ahora la Secretaria ocupa el único no clínico: otra no clínica suspendida no vuelve.
    const bil = await staff(t, "BILLING", true);
    expect((await reactivateMember(bil.id)).ok).toBe(false);
  });

  it("ascender a la Secretaria a profesional pide lugar de profesional; a ADMIN deja de atender", async () => {
    // Clínica (sin tope por tipo) con tope de profesionales a medida.
    const t = await tenant("CLINICA", { maxProfessionalsOverride: 1 });
    const sec = await staff(t, "ASSISTANT");
    const r = await changeMemberRole(sec.id, "PRACTITIONER");
    expect(r.ok).toBe(false);
    expect((await db.membership.findUniqueOrThrow({ where: { id: sec.id } })).role).toBe("ASSISTANT");
    expect(await db.practitioner.count({ where: { tenantId: t.tenantId, userId: sec.userId } })).toBe(0);
    // §20.17: PRACTITIONER → ADMIN es pasar a NO clínico (el Administrador/a nunca atiende): ocupa un lugar no
    // clínico (sin tope por tipo en Consultorio) y deja de atender (sin turnos ni pacientes: no hay bloqueo).
    const kine = await addPractitioner(db, t);
    const km = await db.membership.findFirstOrThrow({ where: { tenantId: t.tenantId, userId: kine.userId } });
    expect(await toAdmin(t, km.id)).toEqual({ ok: true, data: undefined });
    expect((await db.membership.findUniqueOrThrow({ where: { id: km.id } })).clinical).toBe(false);
  });

  it("[§20.17] pasar a ADMIN a alguien con pacientes asignados se frena (mismo bloqueo que a otro rol no clínico)", async () => {
    const t = await tenant("CLINICA");
    const kine = await addPractitioner(db, t);
    await addPatient(db, t, { assignedPractitionerId: kine.practitionerId });
    const km = await db.membership.findFirstOrThrow({ where: { tenantId: t.tenantId, userId: kine.userId } });
    const r = await toAdmin(t, km.id);
    expect(r.ok).toBe(false);
    expect(await db.membership.findUniqueOrThrow({ where: { id: km.id } })).toMatchObject({ role: "PRACTITIONER", clinical: true });
  });

  it("reabrir (reenviar) una invitación VENCIDA pide lugar; una vigente no", async () => {
    const t = await tenant("CONSULTORIO", { maxProfessionalsOverride: 2 });
    const ok = await invite("PRACTITIONER"); // Titular + 1 pendiente = 2 (lleno)
    if (!ok.ok) throw new Error(ok.error);
    __rateLimitInternals.reset();
    expect((await resendInvitation(ok.data.id)).ok).toBe(true);
    await db.invitation.update({ where: { id: ok.data.id }, data: { expiresAt: new Date(Date.now() - DAY) } });
    await addPractitioner(db, t);
    __rateLimitInternals.reset();
    const r = await resendInvitation(ok.data.id);
    expect(r).toEqual({ ok: false, error: expect.stringContaining("Tu plan tiene 2 lugares para profesionales") });
    expect((await db.invitation.findUniqueOrThrow({ where: { id: ok.data.id } })).expiresAt.getTime()).toBeLessThan(Date.now());
  });

  it("los overrides del consultorio ganan sobre el plan (Libre a medida)", async () => {
    await tenant("LIBRE", { maxUsersOverride: 3 });
    expect((await invite("PRACTITIONER")).ok).toBe(true);
    expect((await invite("ASSISTANT")).ok).toBe(true);
    expect((await invite("PRACTITIONER")).ok).toBe(false);
  });

  it("Clínica: 10 de cualquier tipo", async () => {
    await tenant("CLINICA");
    for (let i = 0; i < 9; i++) expect((await invite(i % 2 ? "ASSISTANT" : "PRACTITIONER")).ok).toBe(true);
    expect(await invite("BILLING")).toEqual({ ok: false, error: expect.stringContaining("10 usuarios") });
  });

  it("dos invitaciones simultáneas por el último lugar: entra una sola (FOR UPDATE sobre el Tenant)", async () => {
    const t = await tenant("CONSULTORIO", { maxProfessionalsOverride: 2 });
    const results = await Promise.all([invite("PRACTITIONER"), invite("PRACTITIONER"), invite("PRACTITIONER")]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await db.invitation.count({ where: { tenantId: t.tenantId, revokedAt: null, acceptedAt: null } })).toBe(1);
  });

  it("[PL-1c] dos activaciones simultáneas con 1 lugar: entra una sola", async () => {
    const t = await tenant("CONSULTORIO", { maxProfessionalsOverride: 2 });
    const mk = async () => {
      const raw = randomBytes(24).toString("base64url");
      await db.invitation.create({
        data: {
          tenantId: t.tenantId,
          email: `seat-race-${randomBytes(4).toString("hex")}@example.com`,
          firstName: "Ana",
          lastName: "Pérez",
          role: "PRACTITIONER",
          token: hashInviteToken(raw),
          invitedById: t.userId,
          expiresAt: new Date(Date.now() + DAY),
        },
      });
      return raw;
    };
    const [a, b] = [await mk(), await mk()]; // sembradas por fuera: las dos «reservaron» (el plan bajó en el medio)
    asAnonymous();
    const form = (token: string) => ({ token, firstName: "Ana", lastName: "Pérez", password: "clave-segura-1", passwordConfirm: "clave-segura-1" });
    const rs = await Promise.all([activateInvitation(form(a), { ip: "203.0.113.10" }), activateInvitation(form(b), { ip: "203.0.113.11" })]);
    for (const r of rs) if (r.ok) users.push(r.userId);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(rs.find((r) => !r.ok)).toMatchObject({ code: "seat_limit" });
    expect(await db.membership.count({ where: { tenantId: t.tenantId, disabledAt: null } })).toBe(2);
  });

  it("bajar de plan por fuera del flujo no saca a nadie: los que están siguen y el uso queda por encima del cupo", async () => {
    const t = await tenant("CLINICA");
    await addPractitioner(db, t);
    await addPractitioner(db, t);
    const before = (await listTeamMembers()).map((m) => m.membershipId).sort();
    await db.tenant.update({ where: { id: t.tenantId }, data: { saasPlan: "INDIVIDUAL", plan: "FREE" } });
    expect((await listTeamMembers()).map((m) => m.membershipId).sort()).toEqual(before);
    expect(await db.membership.count({ where: { tenantId: t.tenantId, disabledAt: null } })).toBe(3);
    expect((await invite("PRACTITIONER")).ok).toBe(false);
    expect((await invite("ASSISTANT")).ok).toBe(false);

    const su = `test-user-${uniqueSuffix()}`;
    users.push(su);
    await db.userProfile.create({ data: { id: su, email: `${su}@test.local`, isPlatformAdmin: true } });
    asUser(su);
    const team = await getTenantTeamForPlatform(t.tenantId);
    expect(team!.seats.total).toEqual({ used: 3, limit: 1, remaining: 0, full: true });
    expect(team!.seats.professional.used).toBe(3);
  });

  it("desde Plataforma rige el mismo cupo (copy del superadmin)", async () => {
    const t = await tenant("INDIVIDUAL");
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
    expect(r).toEqual({ ok: false, error: expect.stringContaining("El plan del consultorio tiene 1 usuario") });
  });

  it("checkSeatForJoinInTx: frena al que no está adentro (por tipo y total), deja pasar a quien ya ocupa", async () => {
    const t = await tenant("CONSULTORIO", { maxProfessionalsOverride: 1 });
    const join = (userId: string, role: Role, clinical = role !== "ASSISTANT" && role !== "BILLING") =>
      prismaService.$transaction((tx) => checkSeatForJoinInTx(tx, { tenantId: t.tenantId, userId, role, clinical }));
    await expect(join(`nadie-${uniqueSuffix()}`, "PRACTITIONER")).rejects.toBeInstanceOf(SeatLimitError);
    await expect(join(`nadie-${uniqueSuffix()}`, "ASSISTANT")).resolves.toBeUndefined();
    await expect(join(`nadie-${uniqueSuffix()}`, "ADMIN", false)).resolves.toBeUndefined();
    // El Titular re-aceptando no ocupa un lugar nuevo.
    await expect(join(t.userId, "ADMIN")).resolves.toBeUndefined();
    await db.tenant.update({ where: { id: t.tenantId }, data: { maxProfessionalsOverride: 2 } });
    await expect(join(`nadie-${uniqueSuffix()}`, "PRACTITIONER")).resolves.toBeUndefined();
  });

  it("[§20.17] invitar a un ADMIN: entra SIN atender (sin Practitioner) y con «Configuración»; «atiende» se frena", async () => {
    const t = await tenant("CLINICA");
    const r = await invite("ADMIN", { clinical: true });
    expect(r).toEqual({ ok: false, error: INVITE_ADMIN_CLINICAL_MESSAGE });
    const raw = randomBytes(24).toString("base64url");
    const email = `seat-admin-${randomBytes(4).toString("hex")}@example.com`;
    await db.invitation.create({
      data: {
        tenantId: t.tenantId,
        email,
        firstName: "Ada",
        lastName: "Admin",
        role: "ADMIN",
        token: hashInviteToken(raw),
        invitedById: t.userId,
        expiresAt: new Date(Date.now() + DAY),
      },
    });
    asAnonymous();
    const a = await activateInvitation(
      { token: raw, firstName: "Ada", lastName: "Admin", password: "clave-segura-1", passwordConfirm: "clave-segura-1" },
      { ip: "203.0.113.12" }
    );
    if (!a.ok) throw new Error(a.error);
    users.push(a.userId);
    expect(await db.membership.findFirstOrThrow({ where: { tenantId: t.tenantId, userId: a.userId } })).toMatchObject({
      role: "ADMIN",
      clinical: false,
      grantSettings: true,
      grantBilling: false,
    });
    expect(await db.practitioner.count({ where: { tenantId: t.tenantId, userId: a.userId } })).toBe(0);
  });

  it("[PL-1c] invitar a la Secretaria: entra sin Practitioner, no clínica y sin permisos delegados", async () => {
    const t = await tenant("CLINICA");
    const raw = randomBytes(24).toString("base64url");
    await db.invitation.create({
      data: {
        tenantId: t.tenantId,
        email: `seat-sec-${randomBytes(4).toString("hex")}@example.com`,
        firstName: "Sec",
        lastName: "Re",
        role: "ASSISTANT",
        token: hashInviteToken(raw),
        invitedById: t.userId,
        expiresAt: new Date(Date.now() + DAY),
      },
    });
    asAnonymous();
    const a = await activateInvitation(
      { token: raw, firstName: "Sec", lastName: "Re", password: "clave-segura-1", passwordConfirm: "clave-segura-1" },
      { ip: "203.0.113.13" }
    );
    if (!a.ok) throw new Error(a.error);
    users.push(a.userId);
    expect(await db.membership.findFirstOrThrow({ where: { tenantId: t.tenantId, userId: a.userId } })).toMatchObject({
      clinical: false,
      grantSettings: false,
    });
    expect(await db.practitioner.count({ where: { tenantId: t.tenantId, userId: a.userId } })).toBe(0);
  });

  describe("[PL-1c] setMemberClinicalInTx («¿Atiende?»)", () => {
    it("el Titular deja de atender: libera el lugar de profesional y ocupa el no clínico", async () => {
      // M8b: la fila de Consultorio ya no tiene tope por tipo, así que los dos topes van a medida (antes el de no
      // clínicos salía de la fila: 1).
      const t = await tenant("CONSULTORIO", { maxProfessionalsOverride: 1, maxStaffOverride: 1 });
      // Sin turnos ni pacientes del Titular (la factory crea un servicio pero no turnos).
      const own = await db.membership.findFirstOrThrow({ where: { tenantId: t.tenantId, userId: t.userId } });
      expect((await invite("PRACTITIONER")).ok).toBe(false);
      const ctx = tenantCtx(t);
      const r = await runTeamTx(ctx, (tx) => setMemberClinicalInTx(tx, ctx, { membershipId: own.id, clinical: false }));
      expect(r).toEqual({ ok: true, data: undefined });
      expect((await db.membership.findUniqueOrThrow({ where: { id: own.id } })).clinical).toBe(false);
      expect((await invite("PRACTITIONER")).ok).toBe(true);
      expect((await invite("ASSISTANT")).ok).toBe(false); // el no clínico lo ocupa el Titular
      expect(await db.auditEvent.count({ where: { tenantId: t.tenantId, action: "membership.clinical.change" } })).toBe(1);
    });

    it("no deja de atender con pacientes asignados (mismo bloqueo que pasar a un rol no clínico)", async () => {
      const t = await tenant("CLINICA");
      await addPatient(db, t); // asignado al Titular
      const own = await db.membership.findFirstOrThrow({ where: { tenantId: t.tenantId, userId: t.userId } });
      const ctx = tenantCtx(t);
      const r = await runTeamTx(ctx, (tx) => setMemberClinicalInTx(tx, ctx, { membershipId: own.id, clinical: false }));
      expect(r.ok).toBe(false);
      expect((await db.membership.findUniqueOrThrow({ where: { id: own.id } })).clinical).toBe(true);
    });

    it("el Titular vuelve a atender: pide lugar de profesional (con tope por tipo a medida)", async () => {
      const t = await tenant("CONSULTORIO", { maxProfessionalsOverride: 1 });
      const own = await db.membership.findFirstOrThrow({ where: { tenantId: t.tenantId, userId: t.userId } });
      const ctx = tenantCtx(t);
      expect(await runTeamTx(ctx, (tx) => setMemberClinicalInTx(tx, ctx, { membershipId: own.id, clinical: false }))).toEqual({
        ok: true,
        data: undefined,
      });
      await addPractitioner(db, t); // ocupa el único lugar de profesional
      const full = await runTeamTx(ctx, (tx) => setMemberClinicalInTx(tx, ctx, { membershipId: own.id, clinical: true }));
      expect(full.ok).toBe(false);
      await db.tenant.update({ where: { id: t.tenantId }, data: { maxProfessionalsOverride: 2 } });
      const ok = await runTeamTx(ctx, (tx) => setMemberClinicalInTx(tx, ctx, { membershipId: own.id, clinical: true }));
      expect(ok).toEqual({ ok: true, data: undefined });
      const prac = await db.practitioner.findFirstOrThrow({ where: { tenantId: t.tenantId, userId: t.userId } });
      expect(await db.practitionerSchedule.count({ where: { tenantId: t.tenantId, practitionerId: prac.id } })).toBeGreaterThan(0);
    });

    it("[§20.17] un ADMIN no pasa a atender (ni con lugar); uno legado con clinical=true sí se puede apagar", async () => {
      const t = await tenant("CLINICA");
      const ctx = tenantCtx(t);
      const adm = await staff(t, "ADMIN", false, false);
      const on = await runTeamTx(ctx, (tx) => setMemberClinicalInTx(tx, ctx, { membershipId: adm.id, clinical: true }));
      expect(on).toEqual({ ok: false, error: expect.stringContaining("El Administrador/a no atiende") });
      expect(await db.practitioner.count({ where: { tenantId: t.tenantId, userId: adm.userId } })).toBe(0);
      const legacy = await staff(t, "ADMIN", false, true); // fila de antes de §20.17 (la normaliza M8b)
      const off = await runTeamTx(ctx, (tx) => setMemberClinicalInTx(tx, ctx, { membershipId: legacy.id, clinical: false }));
      expect(off).toEqual({ ok: true, data: undefined });
      expect((await db.membership.findUniqueOrThrow({ where: { id: legacy.id } })).clinical).toBe(false);
    });

    it("solo el Titular elige; un ADMIN no toca al Titular ni a sí mismo", async () => {
      const t = await tenant("CLINICA");
      const adm = await staff(t, "ADMIN");
      const kine = await staff(t, "PRACTITIONER");
      const own = await db.membership.findFirstOrThrow({ where: { tenantId: t.tenantId, userId: t.userId } });
      const actx = tenantCtx(t, adm.userId, "ADMIN");
      const run = (id: string) => runTeamTx(actx, (tx) => setMemberClinicalInTx(tx, actx, { membershipId: id, clinical: false }));
      expect((await run(kine.id)).ok).toBe(false);
      expect((await run(own.id)).ok).toBe(false);
      expect((await run(adm.id)).ok).toBe(false);
    });
  });

  describe("[PL-1c] setMemberGrantsInTx (permisos delegados)", () => {
    it("solo el Titular delega; nunca sobre el Titular", async () => {
      const t = await tenant("CLINICA");
      const adm = await staff(t, "ADMIN");
      const sec = await staff(t, "ASSISTANT");
      const own = await db.membership.findFirstOrThrow({ where: { tenantId: t.tenantId, userId: t.userId } });
      const actx = tenantCtx(t, adm.userId, "ADMIN");
      expect(
        (await runTeamTx(actx, (tx) => setMemberGrantsInTx(tx, actx, { membershipId: sec.id, grantSettings: true, grantBilling: true }))).ok
      ).toBe(false);
      const octx = tenantCtx(t);
      expect(
        (await runTeamTx(octx, (tx) => setMemberGrantsInTx(tx, octx, { membershipId: own.id, grantSettings: false, grantBilling: false }))).ok
      ).toBe(false);
      expect(
        await runTeamTx(octx, (tx) => setMemberGrantsInTx(tx, octx, { membershipId: sec.id, grantSettings: false, grantBilling: true }))
      ).toEqual({ ok: true, data: undefined });
      expect(await db.membership.findUniqueOrThrow({ where: { id: sec.id } })).toMatchObject({ grantSettings: false, grantBilling: true });
      expect(await db.auditEvent.count({ where: { tenantId: t.tenantId, action: "membership.grants.change" } })).toBe(1);
    });
  });

  /**
   * La invitación reservó el lugar, pero si el plan bajó entre la invitación y la aceptación, activar no tiene que
   * meter a alguien por encima del cupo. `checkSeatForJoinInTx` (lib/team-internal.ts, `FOR UPDATE` sobre el Tenant)
   * va en `joinTenantInTx` antes del CAS de la invitación. Arrancó como it.fails; lo dio vuelta el integrador de BO2.
   */
  it("[BO2-B] activar una invitación clínica con el cupo lleno no crea la membresía", async () => {
    const t = await tenant("CLINICA");
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
    // El plan baja a Individual con la invitación pendiente: el Titular ya ocupa el único lugar.
    await db.tenant.update({ where: { id: t.tenantId }, data: { saasPlan: "INDIVIDUAL", plan: "FREE" } });
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
