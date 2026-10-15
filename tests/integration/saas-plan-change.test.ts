/**
 * [PL-1c] Cambio de plan SaaS con cupos por tipo (C-PL4, plan §20.5.3; decisión 5 de Martin del 15-oct: quien cambia
 * el plan elige quiénes pierden el acceso; se deshabilitan con motivo `PLAN_DOWNGRADE`, nunca se borran; al subir se
 * reactivan; el Titular nunca es candidato, ni uno mismo; Libre solo desde Plataforma).
 *
 * Símbolos REALES (`previewPlanChangeInTx` / `applyPlanChangeInTx` sobre `runTeamTx`, el escritor único de
 * entitlements y el audit) contra Postgres en los dos roles (`kinesoft_app` con RLS y owner BYPASSRLS). No se mockea
 * nada: estos núcleos no tocan sesión, red ni cache.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient, Role, SaasPlan } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { applyPlanChangeInTx, previewPlanChangeInTx } from "@/lib/saas-plan-change-internal";
import { runTeamTx, type TeamActorCtx } from "@/lib/team-internal";
import { LEGACY_PLAN_OF } from "@/lib/saas-plans-logic";
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

describe.skipIf(!RUN)("[PL-1c] cambio de plan con cupos por tipo", () => {
  let db: PrismaClient;
  const tenants: EphemeralTenant[] = [];
  const users: string[] = [];

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

  async function tenant(saasPlan: SaasPlan) {
    const t = await createEphemeralTenant(db, { saasPlan, plan: LEGACY_PLAN_OF[saasPlan] });
    tenants.push(t);
    return t;
  }

  async function member(t: EphemeralTenant, role: Role, o: { clinical?: boolean; disabledReason?: string } = {}) {
    const id = `test-user-${uniqueSuffix()}`;
    users.push(id);
    await db.userProfile.create({ data: { id, email: `${id}@test.local`, fullName: `Miembro ${role}` } });
    return db.membership.create({
      data: {
        userId: id,
        tenantId: t.tenantId,
        role,
        clinical: o.clinical ?? (role !== "ASSISTANT" && role !== "BILLING"),
        acceptedAt: new Date(),
        ...(o.disabledReason ? { disabledAt: new Date(Date.now() - DAY), disabledReason: o.disabledReason } : {}),
      },
    });
  }

  async function membershipOf(t: EphemeralTenant, userId: string) {
    return db.membership.findFirstOrThrow({ where: { tenantId: t.tenantId, userId } });
  }

  async function pendingInvite(t: EphemeralTenant, role: Role, email = `inv-${uniqueSuffix()}@test.local`, ageMs = 0) {
    return db.invitation.create({
      data: {
        tenantId: t.tenantId,
        email,
        firstName: "I",
        lastName: "N",
        role,
        token: `tok-${randomUUID()}`,
        invitedById: t.userId,
        invitedAt: new Date(Date.now() - ageMs),
        expiresAt: new Date(Date.now() + DAY),
      },
    });
  }

  const ownerCtx = (t: EphemeralTenant, actorUserId = t.userId, actorRole: Role = "OWNER"): TeamActorCtx => ({
    via: "tenant",
    tenantId: t.tenantId,
    actorUserId,
    actorRole,
    actorRef: null,
  });

  const updatedAt = async (t: EphemeralTenant) => (await db.tenant.findUniqueOrThrow({ where: { id: t.tenantId } })).updatedAt;

  const preview = (ctx: TeamActorCtx, to: SaasPlan) =>
    runTeamTx(ctx, (tx) => previewPlanChangeInTx(tx, { tenantId: ctx.tenantId, to, now: new Date(), actorUserId: ctx.actorUserId }));

  const apply = async (
    ctx: TeamActorCtx,
    to: SaasPlan,
    sel: { disable?: string[]; reactivate?: string[]; expectedUpdatedAt?: Date } = {}
  ) =>
    runTeamTx(ctx, async (tx) =>
      applyPlanChangeInTx(tx, {
        tenantId: ctx.tenantId,
        to,
        disableMembershipIds: sel.disable ?? [],
        reactivateMembershipIds: sel.reactivate ?? [],
        expectedUpdatedAt: sel.expectedUpdatedAt ?? (await tx.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId } })).updatedAt,
        ctx,
        now: new Date(),
      })
    );

  it("preview Consultorio → Individual: mínimo a deshabilitar, candidatos con su carga, invitaciones, módulos", async () => {
    const t = await tenant("CONSULTORIO");
    const kine = await addPractitioner(db, t);
    await addPatient(db, t, { assignedPractitionerId: kine.practitionerId });
    await db.booking.create({
      data: {
        tenantId: t.tenantId,
        practitionerId: kine.practitionerId,
        serviceId: t.serviceId,
        scheduledFor: new Date(Date.now() + 3 * DAY),
        durationMin: 45,
        status: "CONFIRMED",
        idempotencyKey: randomUUID(),
      },
    });
    const sec = await member(t, "ASSISTANT");
    const inv = await pendingInvite(t, "PRACTITIONER");

    const p = await preview(ownerCtx(t), "INDIVIDUAL");
    expect(p).not.toBeNull();
    expect(p!.from).toBe("CONSULTORIO");
    expect(p!.limits).toEqual({ maxUsers: 1, maxProfessionals: 1, maxStaff: 1 });
    // Titular + kine (profesionales 2 > 1) + Secretaria: total 3 > 1 → hay que sacar 2.
    expect(p!.mustDisable).toEqual({ professional: 1, staff: 0, total: 2 });
    expect(p!.usage.total.used).toBe(4); // 3 miembros + 1 invitación
    const owner = p!.candidates.find((c) => c.userId === t.userId)!;
    expect(owner).toMatchObject({ isOwner: true, isSelf: true, kind: "professional" });
    const k = p!.candidates.find((c) => c.userId === kine.userId)!;
    expect(k).toMatchObject({ isOwner: false, isSelf: false, kind: "professional", futureBookings: 1, assignedPatients: 1, activePlans: 0 });
    expect(k.name).not.toContain("@");
    expect(p!.candidates.find((c) => c.membershipId === sec.id)).toMatchObject({ kind: "staff", clinical: false });
    expect(p!.invitesToRevoke).toEqual([{ invitationId: inv.id, email: inv.email, role: "PRACTITIONER" }]);
    expect(p!.modulesLost).toEqual(expect.arrayContaining(["plantillas", "favoritos", "ejerciciosGlobales"]));
    expect(p!.modulesGained).toEqual([]);
    expect(p!.priceCents).toBeNull();
    expect(new Date(p!.tenantUpdatedAt).getTime()).toBe((await updatedAt(t)).getTime());
  });

  it("bajar: deshabilita a los elegidos con motivo, anula invitaciones (suyas y sobrantes), no cancela turnos, audita", async () => {
    const t = await tenant("CONSULTORIO");
    const kine = await addPractitioner(db, t);
    const km = await membershipOf(t, kine.userId);
    const booking = await db.booking.create({
      data: {
        tenantId: t.tenantId,
        practitionerId: kine.practitionerId,
        serviceId: t.serviceId,
        scheduledFor: new Date(Date.now() + 2 * DAY),
        durationMin: 45,
        status: "CONFIRMED",
        idempotencyKey: randomUUID(),
      },
    });
    const sec = await member(t, "ASSISTANT");
    const secEmail = (await db.userProfile.findUniqueOrThrow({ where: { id: sec.userId } })).email;
    const secInvite = await pendingInvite(t, "ASSISTANT", secEmail); // invitación viva del deshabilitado
    const other = await pendingInvite(t, "PRACTITIONER"); // ya no entra en Individual

    const r = await apply(ownerCtx(t), "INDIVIDUAL", { disable: [km.id, sec.id] });
    expect(r).toEqual({ ok: true, disabled: 2, reactivated: 0, revokedInvites: 2 });

    const tenantRow = await db.tenant.findUniqueOrThrow({ where: { id: t.tenantId } });
    expect(tenantRow).toMatchObject({ saasPlan: "INDIVIDUAL", plan: "FREE" });
    for (const id of [km.id, sec.id]) {
      expect(await db.membership.findUniqueOrThrow({ where: { id } })).toMatchObject({
        disabledReason: "PLAN_DOWNGRADE",
        disabledById: t.userId,
      });
    }
    expect((await membershipOf(t, t.userId)).disabledAt).toBeNull();
    for (const id of [secInvite.id, other.id]) {
      expect((await db.invitation.findUniqueOrThrow({ where: { id } })).revokedAt).not.toBeNull();
    }
    expect((await db.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe("CONFIRMED");
    expect(await db.membership.count({ where: { tenantId: t.tenantId } })).toBe(3); // nadie borrado
    const audit = await db.auditEvent.findFirstOrThrow({ where: { tenantId: t.tenantId, action: "tenant.plan.change" } });
    expect(audit.payload).toMatchObject({ from: "CONSULTORIO", to: "INDIVIDUAL", revokedInvites: 2 });
    expect(await db.auditEvent.count({ where: { tenantId: t.tenantId, action: "tenant.entitlements" } })).toBe(1);
  });

  it("nunca el Titular ni uno mismo; si no alcanza, does_not_fit; y en ningún caso se escribe nada", async () => {
    const t = await tenant("CLINICA");
    const owner = await membershipOf(t, t.userId);
    const adm = await member(t, "ADMIN", { clinical: false }); // delegado de «Planes y pagos» que cambia el plan
    const kine = await addPractitioner(db, t);
    const km = await membershipOf(t, kine.userId);
    const before = await updatedAt(t);
    const actx = ownerCtx(t, adm.userId, "ADMIN");

    expect(await apply(actx, "INDIVIDUAL", { disable: [owner.id, km.id] })).toEqual({ ok: false, reason: "owner_selected" });
    expect(await apply(actx, "INDIVIDUAL", { disable: [adm.id, km.id] })).toEqual({ ok: false, reason: "self_selected" });
    const nf = await apply(actx, "INDIVIDUAL", { disable: [km.id] });
    expect(nf).toMatchObject({ ok: false, reason: "does_not_fit", detail: "professional:0,staff:0,total:1" });
    expect(await apply(actx, "INDIVIDUAL", { disable: [km.id, km.id] })).toMatchObject({ ok: false, reason: "invalid_selection" });

    expect((await db.tenant.findUniqueOrThrow({ where: { id: t.tenantId } })).saasPlan).toBe("CLINICA");
    expect((await updatedAt(t)).getTime()).toBe(before.getTime());
    expect(await db.membership.count({ where: { tenantId: t.tenantId, disabledAt: { not: null } } })).toBe(0);
    expect(await db.auditEvent.count({ where: { tenantId: t.tenantId, action: "tenant.plan.change" } })).toBe(0);
  });

  it("stale: el CAS contra el updatedAt que vio el drawer", async () => {
    const t = await tenant("CLINICA");
    const seen = await updatedAt(t);
    await db.tenant.update({ where: { id: t.tenantId }, data: { name: "Otro nombre" } });
    expect(await apply(ownerCtx(t), "CONSULTORIO", { expectedUpdatedAt: seen })).toEqual({ ok: false, reason: "stale" });
    expect((await db.tenant.findUniqueOrThrow({ where: { id: t.tenantId } })).saasPlan).toBe("CLINICA");
  });

  it("dos cambios simultáneos con el mismo updatedAt: uno entra, el otro stale", async () => {
    const t = await tenant("CLINICA");
    const seen = await updatedAt(t);
    const rs = await Promise.all([
      apply(ownerCtx(t), "CONSULTORIO", { expectedUpdatedAt: seen }),
      apply(ownerCtx(t), "INDIVIDUAL", { expectedUpdatedAt: seen }),
    ]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(rs.find((r) => !r.ok)).toEqual({ ok: false, reason: "stale" });
  });

  it("Libre lo elige solo Plataforma", async () => {
    const t = await tenant("CLINICA");
    expect(await apply(ownerCtx(t), "LIBRE")).toEqual({ ok: false, reason: "libre_platform_only" });
    const su = `test-user-${uniqueSuffix()}`;
    users.push(su);
    await db.userProfile.create({ data: { id: su, email: `${su}@test.local`, isPlatformAdmin: true } });
    const pctx: TeamActorCtx = {
      via: "platform",
      tenantId: t.tenantId,
      actorUserId: su,
      actorRole: "SUPERADMIN",
      actorRef: { userId: su, email: `${su}@test.local`, homeTenantId: null },
    };
    const r = await apply(pctx, "LIBRE");
    expect(r).toEqual({ ok: true, disabled: 0, reactivated: 0, revokedInvites: 0 });
    expect((await db.tenant.findUniqueOrThrow({ where: { id: t.tenantId } })).saasPlan).toBe("LIBRE");
    expect(await prismaService.platformAuditEvent.count({ where: { tenantId: t.tenantId, action: "platform.tenant.plan.change" } })).toBe(1);
  });

  it("[PL-Z] a3#1: Libre con cupos a medida no cambia de plan desde el consultorio; un override inerte en otro plan no traba", async () => {
    const t = await tenant("LIBRE");
    await db.tenant.update({ where: { id: t.tenantId }, data: { maxUsersOverride: 20 } });
    const before = await updatedAt(t);
    expect(await apply(ownerCtx(t), "CLINICA")).toEqual({ ok: false, reason: "invalid_selection", detail: "custom_limits" });
    expect((await db.tenant.findUniqueOrThrow({ where: { id: t.tenantId } })).saasPlan).toBe("LIBRE");
    expect((await updatedAt(t)).getTime()).toBe(before.getTime());

    // Legado de M8: Clínica con el seatLimitOverride copiado. El override no rige (effectiveLimits) y no traba el cambio.
    const legacy = await tenant("CLINICA");
    await db.tenant.update({ where: { id: legacy.tenantId }, data: { maxUsersOverride: 20 } });
    const pv = await preview(ownerCtx(legacy), "CONSULTORIO");
    expect(pv?.limits.maxUsers).toBe(5);
    expect(await apply(ownerCtx(legacy), "CONSULTORIO")).toMatchObject({ ok: true });
  });

  it("subir: reactiva a los PLAN_DOWNGRADE elegidos (con Practitioner si atiende); a un suspendido a mano no", async () => {
    const t = await tenant("INDIVIDUAL");
    const down = await member(t, "PRACTITIONER", { disabledReason: "PLAN_DOWNGRADE" });
    const manual = await member(t, "PRACTITIONER", { disabledReason: "MANUAL" });

    const p = await preview(ownerCtx(t), "CONSULTORIO");
    expect(p!.reactivatable.map((x) => x.membershipId)).toEqual([down.id]);
    expect(p!.modulesGained).toEqual(expect.arrayContaining(["plantillas"]));

    expect(await apply(ownerCtx(t), "CONSULTORIO", { reactivate: [manual.id] })).toMatchObject({
      ok: false,
      reason: "invalid_selection",
    });
    const r = await apply(ownerCtx(t), "CONSULTORIO", { reactivate: [down.id] });
    expect(r).toEqual({ ok: true, disabled: 0, reactivated: 1, revokedInvites: 0 });
    expect(await db.membership.findUniqueOrThrow({ where: { id: down.id } })).toMatchObject({ disabledAt: null, disabledReason: null });
    expect(await db.practitioner.count({ where: { tenantId: t.tenantId, userId: down.userId } })).toBe(1);
    expect((await db.membership.findUniqueOrThrow({ where: { id: manual.id } })).disabledReason).toBe("MANUAL");
  });

  it("subir no reactiva por encima del cupo del plan nuevo", async () => {
    const t = await tenant("INDIVIDUAL");
    // M8b (§20.17): Consultorio = 5 de cualquier tipo, sin tope por tipo. Titular + 5 reactivados = 6: sobra 1 por
    // total (antes el caso era 2 no clínicos contra el tope de 1 que tenía la fila de M8).
    const ids: string[] = [];
    for (const role of ["ASSISTANT", "ASSISTANT", "BILLING", "BILLING", "PRACTITIONER"] as const) {
      ids.push((await member(t, role, { disabledReason: "PLAN_DOWNGRADE" })).id);
    }
    const r = await apply(ownerCtx(t), "CONSULTORIO", { reactivate: ids });
    expect(r).toMatchObject({ ok: false, reason: "does_not_fit", detail: "professional:0,staff:0,total:1" });
    expect((await db.tenant.findUniqueOrThrow({ where: { id: t.tenantId } })).saasPlan).toBe("INDIVIDUAL");
  });
});
