/**
 * [CT-K2] «Co-titular» en el equipo (CF3b, M23 `Membership.grantCoOwner`; decisión de Martin del 05-nov) contra
 * Postgres en los dos roles (`kinesoft_app` con RLS y owner BYPASSRLS).
 *
 * Contrato: el co-titular tiene lo del Titular SALVO tocar el rol, los permisos o la cuenta del Titular principal,
 * transferir la titularidad, dar o quitar «Co-titular» y todo lo de la suscripción (nunca «Planes y pagos», ni para él
 * ni para otro). La base exige `grantCoOwner ⇒ role = PRACTITIONER` (CHECK `Membership_coOwner_role_check`): cambiarle
 * el rol a un co-titular o transferirle la titularidad tiene que limpiar la marca en la MISMA escritura.
 * Default de CT-K2: a un co-titular lo gestiona (rol, permisos, suspender, reactivar, quitar) solo el principal; si no,
 * otro co-titular o un Administrador/a deshacían por la puerta de atrás lo que decidió el principal.
 *
 * Símbolos reales: las actions de `lib/invitations.ts` con el `getActor()` real, `platformTransferOwnership` /
 * `platformSetMemberGrants` (lib/platform-team.ts), `activateInvitation` con el fake de GoTrue y `setMemberCoOwnerInTx`
 * por `runTeamTx` para los contextos que la UI no arma (soporte, un ctx forjado). Se mockea la sesión (`asUser`), el
 * step-up de 2FA (frontera TOTP/cookie; con contador y un modo que lo niega), el transporte de mail y GoTrue.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

const stepUp = vi.hoisted(() => ({ calls: 0, deny: false }));
vi.mock("@/lib/two-factor-step-up", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/two-factor-step-up")>()),
  requireStepUp: async () => {
    stepUp.calls++;
    if (stepUp.deny) throw new Error("step_up_required (test)");
  },
}));

import { ForbiddenError } from "@/lib/session";
import {
  changeMemberRole,
  createInvitation,
  listTeamMembers,
  reactivateMember,
  removeMember,
  resendInvitation,
  revokeInvitation,
  sendMemberPasswordReset,
  setMemberCoOwner,
  setMemberGrants,
  suspendMember,
  transferOwnership,
} from "@/lib/invitations";
import { platformSetMemberGrants, platformTransferOwnership } from "@/lib/platform-team";
import {
  CO_OWNER_BILLING_MESSAGE,
  CO_OWNER_TARGET_MESSAGE,
  PRINCIPAL_ONLY_MESSAGE,
  runTeamTx,
  setMemberCoOwnerInTx,
  type TeamActorCtx,
} from "@/lib/team-internal";
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

const RUN = process.env.INTEGRATION === "1";

const mail = {
  sent: [] as SendEmailInput[],
  transport: async (i: SendEmailInput): Promise<SendEmailResult> => {
    mail.sent.push(i);
    return { ok: true, transport: "resend", providerId: `re_${mail.sent.length}` };
  },
};

describe.skipIf(!RUN)("[CT-K2] «Co-titular»: lo del Titular salvo el principal, la titularidad, la marca y la suscripción", () => {
  let db: PrismaClient;
  let gotrue: GotrueFake;
  const tenants: EphemeralTenant[] = [];
  const users: string[] = [];
  let ipSeq = 0;

  /**
   * Consultorio Clínica con: principal (OWNER que atiende), dos co-titulares (Profesionales con la marca, SIN
   * «Configuración»: la gestión del equipo les sale de ser co-titulares), un Profesional común, otro Profesional, un
   * Administrador/a con «Configuración» y «Planes y pagos» y una Secretaria con «Configuración».
   */
  async function world() {
    const t = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    tenants.push(t);
    const mem = (userId: string) =>
      db.membership.findUniqueOrThrow({ where: { userId_tenantId: { userId, tenantId: t.tenantId } } });
    const coOwner = await addPractitioner(db, t);
    const coOwner2 = await addPractitioner(db, t);
    await db.membership.updateMany({
      where: { tenantId: t.tenantId, userId: { in: [coOwner.userId, coOwner2.userId] } },
      data: { grantCoOwner: true },
    });
    const pro = await addPractitioner(db, t);
    const pro2 = await addPractitioner(db, t);
    const admin = await addStaff(db, t, "ADMIN", { grantSettings: true, grantBilling: true });
    const sec = await addStaff(db, t, "ASSISTANT", { grantSettings: true });
    return {
      t,
      mem,
      owner: { userId: t.userId, membershipId: (await mem(t.userId)).id },
      coOwner: { userId: coOwner.userId, membershipId: (await mem(coOwner.userId)).id },
      coOwner2: { userId: coOwner2.userId, membershipId: (await mem(coOwner2.userId)).id },
      pro: { userId: pro.userId, membershipId: (await mem(pro.userId)).id },
      pro2: { userId: pro2.userId, membershipId: (await mem(pro2.userId)).id },
      admin,
      sec,
    };
  }

  const tenantCtx = (tenantId: string, actorUserId: string, extra: Partial<TeamActorCtx> = {}): TeamActorCtx => ({
    via: "tenant",
    tenantId,
    actorUserId,
    actorRole: "ADMIN",
    actorRef: null,
    ...extra,
  });

  const coOwnerAudits = (tenantId: string, entityId: string) =>
    db.auditEvent.findMany({ where: { tenantId, action: "membership.coOwner.change", entityId }, orderBy: { createdAt: "asc" } });

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
    stepUp.calls = 0;
    stepUp.deny = false;
    mail.sent = [];
    __setEmailTransportForTests(mail.transport);
    gotrue = new GotrueFake();
    __setAuthAdminForTests(gotrue);
  });
  afterEach(() => {
    __setEmailTransportForTests(null);
    __setAuthAdminForTests(null);
  });

  // ── Dar y quitar «Co-titular» ───────────────────────────────────────────────────────────────────────────────

  it("[CT-K2-1] el principal lo prende (y apaga «Planes y pagos» en la misma escritura) y lo apaga; step-up; audit en tx", async () => {
    const w = await world();
    await db.membership.update({ where: { id: w.pro.membershipId }, data: { grantSettings: true, grantBilling: true } });
    asUser(w.owner.userId);

    stepUp.deny = true;
    await expect(setMemberCoOwner(w.pro.membershipId, true)).rejects.toThrow(/step_up_required/);
    expect(await w.mem(w.pro.userId)).toMatchObject({ grantCoOwner: false, grantBilling: true });
    stepUp.deny = false;

    expect(await setMemberCoOwner(w.pro.membershipId, true)).toEqual({ ok: true, data: undefined });
    expect(stepUp.calls).toBe(2);
    expect(await w.mem(w.pro.userId)).toMatchObject({
      role: "PRACTITIONER",
      grantCoOwner: true,
      grantBilling: false,
      grantSettings: true,
    });
    let evs = await coOwnerAudits(w.t.tenantId, w.pro.membershipId);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ actorId: w.owner.userId, entity: "Membership" });
    expect(evs[0].payload).toEqual({ userId: w.pro.userId, coOwner: true, grantBillingCleared: true });

    // Idempotente: ya está así, no escribe ni audita.
    expect(await setMemberCoOwner(w.pro.membershipId, true)).toEqual({ ok: true, data: undefined });
    expect(await coOwnerAudits(w.t.tenantId, w.pro.membershipId)).toHaveLength(1);

    // Apagar: solo la marca («Configuración» se queda; «Planes y pagos» no vuelve sola).
    expect(await setMemberCoOwner(w.pro.membershipId, false)).toEqual({ ok: true, data: undefined });
    expect(await w.mem(w.pro.userId)).toMatchObject({ grantCoOwner: false, grantSettings: true, grantBilling: false });
    evs = await coOwnerAudits(w.t.tenantId, w.pro.membershipId);
    expect(evs).toHaveLength(2);
    expect(evs[1].payload).toEqual({ userId: w.pro.userId, coOwner: false });
  });

  it("[CT-K2-2] solo el principal: co-titular, Administrador/a, Profesional y Secretaria con «Configuración» → Forbidden; soporte y ctx forjado → rechazo en el núcleo", async () => {
    const w = await world();
    const proSettings = await addPractitioner(db, w.t);
    await db.membership.updateMany({
      where: { tenantId: w.t.tenantId, userId: proSettings.userId },
      data: { grantSettings: true },
    });
    for (const actor of [w.coOwner.userId, w.admin.userId, w.sec.userId, proSettings.userId]) {
      asUser(actor);
      await expect(setMemberCoOwner(w.pro.membershipId, true), actor).rejects.toBeInstanceOf(ForbiddenError);
      await expect(setMemberCoOwner(w.coOwner2.membershipId, false), actor).rejects.toThrow(PRINCIPAL_ONLY_MESSAGE);
    }
    // Ni sobre sí mismo (quitarse la marca también es «dar o quitar»: lo decide el principal).
    asUser(w.coOwner.userId);
    await expect(setMemberCoOwner(w.coOwner.membershipId, false)).rejects.toBeInstanceOf(ForbiddenError);
    expect(stepUp.calls).toBe(0);

    // El núcleo no confía en el ctx: soporte, un ADMIN, y un «OWNER» forjado que en la base es el co-titular.
    for (const ctx of [
      tenantCtx(w.t.tenantId, w.admin.userId, { support: true }),
      tenantCtx(w.t.tenantId, w.admin.userId),
      tenantCtx(w.t.tenantId, w.coOwner.userId, { actorRole: "OWNER" }),
    ]) {
      expect(await runTeamTx(ctx, (tx) => setMemberCoOwnerInTx(tx, ctx, { membershipId: w.pro.membershipId, enabled: true }))).toEqual({
        ok: false,
        error: PRINCIPAL_ONLY_MESSAGE,
      });
    }
    expect(await w.mem(w.pro.userId)).toMatchObject({ grantCoOwner: false });
    expect(await w.mem(w.coOwner2.userId)).toMatchObject({ grantCoOwner: true });
    expect(await db.auditEvent.count({ where: { tenantId: w.t.tenantId, action: "membership.coOwner.change" } })).toBe(0);
  });

  it("[CT-K2-3] destino: solo un Profesional activo de ESTE consultorio; apagarlo a un suspendido sí se puede", async () => {
    const w = await world();
    const other = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    tenants.push(other);
    const otherPro = await addPractitioner(db, other);
    const otherMem = await db.membership.findUniqueOrThrow({
      where: { userId_tenantId: { userId: otherPro.userId, tenantId: other.tenantId } },
    });
    const pending = await addPractitioner(db, w.t);
    await db.membership.updateMany({ where: { tenantId: w.t.tenantId, userId: pending.userId }, data: { acceptedAt: null } });
    const pendingMem = await w.mem(pending.userId);
    await db.membership.update({ where: { id: w.pro2.membershipId }, data: { disabledAt: new Date(), disabledReason: "MANUAL" } });

    asUser(w.owner.userId);
    for (const id of [w.admin.membershipId, w.sec.membershipId, w.owner.membershipId]) {
      expect(await setMemberCoOwner(id, true)).toEqual({ ok: false, error: CO_OWNER_TARGET_MESSAGE });
    }
    expect(await setMemberCoOwner(pendingMem.id, true)).toEqual({ ok: false, error: CO_OWNER_TARGET_MESSAGE });
    expect(await setMemberCoOwner(w.pro2.membershipId, true)).toEqual({ ok: false, error: CO_OWNER_TARGET_MESSAGE });
    expect(await setMemberCoOwner(otherMem.id, true)).toEqual({ ok: false, error: "Miembro no encontrado." });
    expect(await db.membership.count({ where: { tenantId: w.t.tenantId, grantCoOwner: true } })).toBe(2);
    expect((await db.membership.findUniqueOrThrow({ where: { id: otherMem.id } })).grantCoOwner).toBe(false);

    // El principal suspende a un co-titular y le saca la marca igual.
    expect((await suspendMember(w.coOwner.membershipId)).ok).toBe(true);
    expect(await setMemberCoOwner(w.coOwner.membershipId, false)).toEqual({ ok: true, data: undefined });
    expect(await w.mem(w.coOwner.userId)).toMatchObject({ grantCoOwner: false });
  });

  // ── Lo que el co-titular (y el Administrador/a) NO hacen sobre el principal ──────────────────────────────────

  it("[CT-K2-4] sobre el principal: co-titular y Administrador/a no cambian rol, permisos, suspenden, quitan, transfieren ni piden link", async () => {
    const w = await world();
    for (const actor of [w.coOwner.userId, w.admin.userId]) {
      asUser(actor);
      expect(await changeMemberRole(w.owner.membershipId, "PRACTITIONER"), actor).toEqual({ ok: false, error: PRINCIPAL_ONLY_MESSAGE });
      expect(await changeMemberRole(w.owner.membershipId, "ADMIN"), actor).toEqual({ ok: false, error: PRINCIPAL_ONLY_MESSAGE });
      expect(await suspendMember(w.owner.membershipId), actor).toEqual({ ok: false, error: PRINCIPAL_ONLY_MESSAGE });
      expect(await removeMember(w.owner.membershipId), actor).toEqual({ ok: false, error: PRINCIPAL_ONLY_MESSAGE });
      expect(await sendMemberPasswordReset(w.owner.membershipId), actor).toEqual({ ok: false, error: PRINCIPAL_ONLY_MESSAGE });
      await expect(transferOwnership(w.pro.membershipId), actor).rejects.toBeInstanceOf(ForbiddenError);
      await expect(transferOwnership(w.coOwner.membershipId), actor).rejects.toBeInstanceOf(ForbiddenError);
    }
    asUser(w.coOwner.userId);
    expect(
      await setMemberGrants({ membershipId: w.owner.membershipId, grantSettings: false, grantBilling: false })
    ).toEqual({ ok: false, error: PRINCIPAL_ONLY_MESSAGE });
    expect(await w.mem(w.owner.userId)).toMatchObject({ role: "OWNER", disabledAt: null, grantCoOwner: false });
    expect(await w.mem(w.coOwner.userId)).toMatchObject({ role: "PRACTITIONER", grantCoOwner: true });
    expect(await db.membership.count({ where: { tenantId: w.t.tenantId, role: "OWNER" } })).toBe(1);
    expect(mail.sent).toHaveLength(0);
  });

  // ── Lo que el co-titular SÍ hace, como el Titular ────────────────────────────────────────────────────────────

  it("[CT-K2-5] el co-titular invita, reenvía, anula, cambia roles y «Configuración», suspende, reactiva y quita a los demás; con el cupo del plan", async () => {
    const w = await world();
    asUser(w.coOwner.userId);
    const email = `ctk2-${randomBytes(4).toString("hex")}@example.com`;
    const inv = await createInvitation({ email, firstName: "Nueva", lastName: "Kine", role: "PRACTITIONER" });
    expect(inv.ok).toBe(true);
    if (!inv.ok) return;
    // El link (credencial) lo ve solo el principal; el mail salió igual.
    expect(inv.data).toMatchObject({ url: null, emailSent: true });
    __rateLimitInternals.reset();
    expect((await resendInvitation(inv.data.id)).ok).toBe(true);
    expect(await revokeInvitation(inv.data.id)).toEqual({ ok: true, data: undefined });

    expect(await changeMemberRole(w.sec.membershipId, "BILLING")).toEqual({ ok: true, data: undefined });
    expect(await w.mem(w.sec.userId)).toMatchObject({ role: "BILLING" });
    expect(await setMemberGrants({ membershipId: w.pro.membershipId, grantSettings: true, grantBilling: false })).toEqual({
      ok: true,
      data: undefined,
    });
    expect(await w.mem(w.pro.userId)).toMatchObject({ grantSettings: true, grantBilling: false });
    expect((await suspendMember(w.pro2.membershipId)).ok).toBe(true);
    expect(await reactivateMember(w.pro2.membershipId)).toEqual({ ok: true, data: undefined });
    expect(await w.mem(w.pro2.userId)).toMatchObject({ disabledAt: null });
    expect(await removeMember(w.sec.membershipId)).toEqual({ ok: true, data: undefined });
    expect(await db.membership.count({ where: { id: w.sec.membershipId } })).toBe(0);

    // Cupo: el mismo que para el Titular (lleno → copy del plan, sin escribir). Los cupos a medida rigen solo en Libre
    // (`effectiveLimits`); el cupo se lee de `saasPlan` (readTenantSeatRowInTx).
    const used = await db.membership.count({ where: { tenantId: w.t.tenantId, disabledAt: null } });
    await db.tenant.update({ where: { id: w.t.tenantId }, data: { saasPlan: "LIBRE", maxUsersOverride: used } });
    const invitesBefore = await db.invitation.count({ where: { tenantId: w.t.tenantId } });
    __rateLimitInternals.reset();
    const full = await createInvitation({ email: `ctk2-full-${uniqueSuffix()}@example.com`, firstName: "No", lastName: "Entra", role: "ASSISTANT" });
    expect(full.ok).toBe(false);
    if (!full.ok) expect(full.error).toMatch(/^Tu plan tiene /);
    expect(await db.invitation.count({ where: { tenantId: w.t.tenantId } })).toBe(invitesBefore);
  });

  // ── «Planes y pagos» y «Co-titular»: nunca por el co-titular ─────────────────────────────────────────────────

  it("[CT-K2-6] el co-titular no da ni quita «Planes y pagos» (a mano, pasando a ADMIN, ni invitando) ni toca a otro co-titular; el Administrador/a tampoco", async () => {
    const w = await world();
    asUser(w.coOwner.userId);
    expect(await setMemberGrants({ membershipId: w.pro.membershipId, grantSettings: false, grantBilling: true })).toEqual({
      ok: false,
      error: PRINCIPAL_ONLY_MESSAGE,
    });
    expect(await setMemberGrants({ membershipId: w.admin.membershipId, grantSettings: true, grantBilling: false })).toEqual({
      ok: false,
      error: PRINCIPAL_ONLY_MESSAGE,
    });
    // Pasar a ADMIN: entra con «Configuración», sin «Planes y pagos» (el default del rol no es un atajo).
    expect(await changeMemberRole(w.pro.membershipId, "ADMIN")).toEqual({ ok: true, data: undefined });
    expect(await w.mem(w.pro.userId)).toMatchObject({ role: "ADMIN", grantSettings: true, grantBilling: false });

    // Otro co-titular (y él mismo): lo gestiona solo el principal.
    for (const target of [w.coOwner2.membershipId, w.coOwner.membershipId]) {
      expect(await setMemberGrants({ membershipId: target, grantSettings: true, grantBilling: false })).toEqual({
        ok: false,
        error: PRINCIPAL_ONLY_MESSAGE,
      });
    }
    expect(await changeMemberRole(w.coOwner2.membershipId, "ADMIN")).toEqual({ ok: false, error: PRINCIPAL_ONLY_MESSAGE });
    expect(await suspendMember(w.coOwner2.membershipId)).toEqual({ ok: false, error: PRINCIPAL_ONLY_MESSAGE });
    expect(await removeMember(w.coOwner2.membershipId)).toEqual({ ok: false, error: PRINCIPAL_ONLY_MESSAGE });

    asUser(w.admin.userId);
    expect(await changeMemberRole(w.coOwner.membershipId, "ASSISTANT")).toEqual({ ok: false, error: PRINCIPAL_ONLY_MESSAGE });
    expect(await suspendMember(w.coOwner.membershipId)).toEqual({ ok: false, error: PRINCIPAL_ONLY_MESSAGE });
    expect(await removeMember(w.coOwner.membershipId)).toEqual({ ok: false, error: PRINCIPAL_ONLY_MESSAGE });
    for (const u of [w.coOwner.userId, w.coOwner2.userId]) {
      expect(await w.mem(u)).toMatchObject({ role: "PRACTITIONER", grantCoOwner: true, disabledAt: null, grantSettings: false });
    }
    expect(await w.mem(w.admin.userId)).toMatchObject({ grantBilling: true });

    // Un ADMIN invitado por el co-titular entra sin «Planes y pagos» (se resuelve al activar con quien invitó).
    asUser(w.coOwner.userId);
    const before = mail.sent.length;
    const inv = await createInvitation({ email: `ctk2-adm-${randomBytes(4).toString("hex")}@example.com`, firstName: "Ad", lastName: "Min", role: "ADMIN" });
    expect(inv.ok).toBe(true);
    const token = /\/invite\/([A-Za-z0-9_-]+)/.exec(mail.sent.slice(before).at(-1)?.text ?? "")?.[1];
    expect(token).toBeTruthy();
    asAnonymous();
    const a = await activateInvitation(
      { token: token!, firstName: "Ad", lastName: "Min", password: "clave-segura-1", passwordConfirm: "clave-segura-1", acceptLegal: true },
      { ip: `203.0.113.${(++ipSeq % 200) + 20}` }
    );
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    users.push(a.userId);
    expect(await w.mem(a.userId)).toMatchObject({ role: "ADMIN", grantSettings: true, grantBilling: false, grantCoOwner: false });
  });

  // ── CHECK de M23: cambiar el rol o transferir limpia la marca en la misma escritura ──────────────────────────

  it("[CT-K2-7] el principal le cambia el rol a un co-titular → grantCoOwner false en la MISMA escritura (sin 23514), con audit", async () => {
    const w = await world();
    asUser(w.owner.userId);
    expect(await changeMemberRole(w.coOwner.membershipId, "ADMIN")).toEqual({ ok: true, data: undefined });
    expect(await w.mem(w.coOwner.userId)).toMatchObject({ role: "ADMIN", grantCoOwner: false, grantSettings: true });
    expect(await changeMemberRole(w.coOwner2.membershipId, "ASSISTANT")).toEqual({ ok: true, data: undefined });
    expect(await w.mem(w.coOwner2.userId)).toMatchObject({ role: "ASSISTANT", grantCoOwner: false, grantBilling: false });
    const ev = await db.auditEvent.findFirstOrThrow({
      where: { tenantId: w.t.tenantId, action: "membership.role.change", entityId: w.coOwner.membershipId },
    });
    expect(ev.payload).toMatchObject({ from: "PRACTITIONER", role: "ADMIN", coOwnerCleared: true });
  });

  it("[CT-K2-8] transferir la titularidad a un co-titular (Configuración y Plataforma): el nuevo Titular y el ex-Titular quedan sin la marca", async () => {
    const w = await world();
    asUser(w.owner.userId);
    expect(await transferOwnership(w.coOwner.membershipId)).toEqual({ ok: true, data: undefined });
    expect(await w.mem(w.coOwner.userId)).toMatchObject({ role: "OWNER", grantCoOwner: false });
    expect(await w.mem(w.owner.userId)).toMatchObject({ role: "PRACTITIONER", grantCoOwner: false, grantSettings: true });
    expect(await db.membership.count({ where: { tenantId: w.t.tenantId, role: "OWNER" } })).toBe(1);

    const w2 = await world();
    const superadminId = `test-user-${uniqueSuffix()}`;
    users.push(superadminId);
    await db.userProfile.create({ data: { id: superadminId, email: `${superadminId}@test.local`, fullName: "Súper", isPlatformAdmin: true } });
    asUser(superadminId);
    expect(await platformTransferOwnership({ tenantId: w2.t.tenantId, membershipId: w2.coOwner2.membershipId })).toEqual({
      ok: true,
      data: undefined,
    });
    expect(await w2.mem(w2.coOwner2.userId)).toMatchObject({ role: "OWNER", grantCoOwner: false });
    expect(await w2.mem(w2.owner.userId)).toMatchObject({ role: "PRACTITIONER", grantCoOwner: false });
    expect(await w2.mem(w2.coOwner.userId)).toMatchObject({ role: "PRACTITIONER", grantCoOwner: true });
  });

  it("[CT-K2-9] un co-titular nunca tiene «Planes y pagos»: ni el principal ni Plataforma se lo dan; «Configuración» sí", async () => {
    const w = await world();
    asUser(w.owner.userId);
    expect(await setMemberGrants({ membershipId: w.coOwner.membershipId, grantSettings: true, grantBilling: true })).toEqual({
      ok: false,
      error: CO_OWNER_BILLING_MESSAGE,
    });
    expect(await setMemberGrants({ membershipId: w.coOwner.membershipId, grantSettings: true, grantBilling: false })).toEqual({
      ok: true,
      data: undefined,
    });
    const superadminId = `test-user-${uniqueSuffix()}`;
    users.push(superadminId);
    await db.userProfile.create({ data: { id: superadminId, email: `${superadminId}@test.local`, fullName: "Súper", isPlatformAdmin: true } });
    asUser(superadminId);
    expect(
      await platformSetMemberGrants({ tenantId: w.t.tenantId, membershipId: w.coOwner2.membershipId, grantSettings: false, grantBilling: true })
    ).toEqual({ ok: false, error: CO_OWNER_BILLING_MESSAGE });
    expect(await w.mem(w.coOwner.userId)).toMatchObject({ grantCoOwner: true, grantSettings: true, grantBilling: false });
    expect(await w.mem(w.coOwner2.userId)).toMatchObject({ grantCoOwner: true, grantBilling: false });
  });

  it("[CT-K2-10] el núcleo relee al co-titular en la tx: si el principal se la sacó, el ctx viejo no delega; la lista marca al co-titular", async () => {
    const w = await world();
    await db.membership.update({ where: { id: w.coOwner.membershipId }, data: { grantCoOwner: false } });
    const { setMemberGrantsInTx } = await import("@/lib/team-internal");
    const ctx = tenantCtx(w.t.tenantId, w.coOwner.userId);
    expect(
      await runTeamTx(ctx, (tx) => setMemberGrantsInTx(tx, ctx, { membershipId: w.pro.membershipId, grantSettings: true, grantBilling: false }))
    ).toEqual({ ok: false, error: "Solo el titular puede delegar permisos." });
    expect(await w.mem(w.pro.userId)).toMatchObject({ grantSettings: false });

    asUser(w.owner.userId);
    const rows = await listTeamMembers();
    const by = new Map(rows.map((r) => [r.membershipId, r]));
    expect(by.get(w.coOwner2.membershipId)?.grantCoOwner).toBe(true);
    expect(by.get(w.coOwner.membershipId)?.grantCoOwner).toBe(false);
    expect(by.get(w.owner.membershipId)?.grantCoOwner).toBe(false);
  });
});
