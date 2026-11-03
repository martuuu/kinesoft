/**
 * [CF2-ZF3] Fixer ZF3 de CF2 (revisor ZA, hallazgos 1, 4, 5 y 8) · reparto de % y equipo, en los dos roles
 * (`test:integration` = `kinesoft_app` con RLS; `:owner` = BYPASSRLS, como prod). Símbolos REALES: las actions de
 * equipo (`suspendMember`, `removeMember`, `changeMemberRole`), el núcleo del cambio de plan (`applyPlanChangeInTx`
 * sobre `runTeamTx`), `setPlatformUserDisabled` (Plataforma), `listRevenueShares`, `collectedGroupsInTx` /
 * `revenueSharesForPeriodInTx` y `isRevenueShareConflict` contra errores REALES de Postgres. Se mockean solo la sesión
 * (`asUser` + cookie de soporte), `next/cache` (integration-setup), el puerto de Auth (fake de GoTrue) y el step-up de
 * la 2FA de Plataforma (dependencia, no la action bajo test).
 *
 *   [CF2-ZF3-1a] suspender al RECEPTOR cierra en `now` su regla vigente (closedById = quien suspende, audit
 *                `revenueShare.end` con el motivo); la caja descuenta lo cobrado antes y deja de descontar desde ese
 *                instante; una regla ya cerrada y la de otro par quedan intactas.
 *   [CF2-ZF3-1b] suspender al que DESTINA también la cierra.
 *   [CF2-ZF3-1c] quitarlo del equipo la cierra.
 *   [CF2-ZF3-1d] pasarlo a un rol que no atiende (Secretaria) la cierra.
 *   [CF2-ZF3-1e] deshabilitarlo al bajar de plan (`PLAN_DOWNGRADE`) la cierra.
 *   [CF2-ZF3-1f] Plataforma deshabilita al usuario → se cierran sus reglas en TODOS sus consultorios.
 *   [CF2-ZF3-4]  soporte (sesión real por cookie) no lee el reparto, como no ve la caja.
 *   [CF2-ZF3-5]  «Creada por» de la caja: null si quien la creó ya no es miembro (mismo criterio que el editor).
 *   [CF2-ZF3-8]  `isRevenueShareConflict`: el trigger de solo cierre → conflicto; un CHECK cualquiera (23514) → no.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import type { PrismaClient } from "@prisma/client";

vi.mock("@/lib/two-factor-step-up", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/two-factor-step-up")>()),
  requireStepUp: async () => {},
}));

import { changeMemberRole, removeMember, suspendMember } from "@/lib/invitations";
import { setPlatformUserDisabled } from "@/lib/platform-users";
import { listRevenueShares } from "@/lib/revenue-share";
import { isRevenueShareConflict } from "@/lib/revenue-share-internal";
import { collectedGroupsInTx, revenueSharesForPeriodInTx } from "@/lib/caja-internal";
import { applyPlanChangeInTx } from "@/lib/saas-plan-change-internal";
import { runTeamTx, type TeamActorCtx } from "@/lib/team-internal";
import { runWithRls } from "@/lib/rls";
import { LEGACY_PLAN_OF } from "@/lib/saas-plans-logic";
import { SUPPORT_COOKIE, makeSupportCookieValue } from "@/lib/support-session-internal";
import { __setAuthAdminForTests } from "@/lib/identity/auth-admin";
import { GotrueFake } from "@/tests/helpers/gotrue-fake";
import { asAnonymous, asUser } from "@/tests/helpers/actor";
import {
  addPractitioner,
  addRevenueShare,
  createEphemeralTenant,
  ownerClient,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const HOUR = 3_600_000;
type Pro = { userId: string; practitionerId: string };

describe.skipIf(!RUN)("[CF2-ZF3] reparto: se cierra al sacar a un profesional; soporte; «creada por»; conflicto", () => {
  let db: PrismaClient;
  const tenants: EphemeralTenant[] = [];
  const users: string[] = [];
  let S: string;
  let gotrue: GotrueFake;

  async function tenant(saasPlan: "CLINICA" | "CONSULTORIO" = "CLINICA") {
    const t = await createEphemeralTenant(db, { saasPlan, plan: LEGACY_PLAN_OF[saasPlan] });
    tenants.push(t);
    return t;
  }
  const membershipOf = (t: EphemeralTenant, userId: string) =>
    db.membership.findFirstOrThrow({ where: { tenantId: t.tenantId, userId }, select: { id: true } });
  const rule = (id: string) => db.practitionerRevenueShare.findUniqueOrThrow({ where: { id } });
  const closeAudits = (t: EphemeralTenant, since: Date) =>
    db.auditEvent.findMany({
      where: { tenantId: t.tenantId, action: "revenueShare.end", createdAt: { gte: since } },
      orderBy: { createdAt: "asc" },
    });

  /** Copago cobrado a mano por `pid` en `paidAt` (como lo deja `setBookingCopagoPaid`). */
  async function paid(t: EphemeralTenant, pid: string, paidAt: Date, cents: number) {
    await db.booking.create({
      data: {
        tenantId: t.tenantId,
        practitionerId: pid,
        serviceId: t.serviceId,
        scheduledFor: new Date(paidAt.getTime() - HOUR + Math.floor(Math.random() * 1000)),
        durationMin: 45,
        idempotencyKey: randomUUID(),
        status: "COMPLETED",
        copagoCents: cents,
        paymentStatus: "PAID",
        copagoPaidAt: paidAt,
        copagoPaymentMethod: "CASH",
        copagoCollectedById: t.userId,
      },
    });
  }

  /** Giver → receiver vigente desde hace 2 h + una vieja ya cerrada + la de otro par (testigos de «intacto»). */
  async function fixture(t: EphemeralTenant) {
    const giver = await addPractitioner(db, t);
    const receiver = await addPractitioner(db, t);
    const third = await addPractitioner(db, t);
    const fourth = await addPractitioner(db, t);
    const oldClosedAt = new Date(Date.now() - 3 * HOUR);
    const old = await addRevenueShare(db, t, {
      giverPractitionerId: giver.practitionerId,
      receiverPractitionerId: receiver.practitionerId,
      shareBps: 500,
      effectiveFrom: new Date(Date.now() - 5 * HOUR),
      effectiveTo: oldClosedAt,
    });
    const open = await addRevenueShare(db, t, {
      giverPractitionerId: giver.practitionerId,
      receiverPractitionerId: receiver.practitionerId,
      shareBps: 2000,
      effectiveFrom: new Date(Date.now() - 2 * HOUR),
    });
    const other = await addRevenueShare(db, t, {
      giverPractitionerId: third.practitionerId,
      receiverPractitionerId: fourth.practitionerId,
      shareBps: 1000,
    });
    return { giver, receiver, old, oldClosedAt, open, other };
  }

  async function expectClosedByMemberChange(
    t: EphemeralTenant,
    f: Awaited<ReturnType<typeof fixture>>,
    o: { before: Date; after: Date; closedById: string; reason: string },
  ) {
    const r = await rule(f.open);
    expect(r.effectiveTo).not.toBeNull();
    expect(r.effectiveTo!.getTime()).toBeGreaterThanOrEqual(o.before.getTime() - 5);
    expect(r.effectiveTo!.getTime()).toBeLessThanOrEqual(o.after.getTime() + 5);
    expect(r.closedById).toBe(o.closedById);
    // Lo anterior intacto: la vieja con su cierre de siempre y la del otro par sigue vigente.
    expect(await rule(f.old)).toMatchObject({ effectiveTo: f.oldClosedAt, closedById: null });
    expect(await rule(f.other)).toMatchObject({ effectiveTo: null, closedById: null });
    const audits = await closeAudits(t, o.before);
    expect(audits.map((a) => a.entityId)).toEqual([f.open]);
    expect(audits[0]).toMatchObject({ actorId: o.closedById });
    expect(audits[0].payload).toMatchObject({
      giverPractitionerId: f.giver.practitionerId,
      receiverPractitionerId: f.receiver.practitionerId,
      shareBps: 2000,
      reason: o.reason,
    });
  }

  beforeAll(async () => {
    db = ownerClient();
    S = `test-user-${uniqueSuffix()}`;
    users.push(S);
    await db.userProfile.create({ data: { id: S, email: `${S}@test.local`, fullName: "Super ZF3", isPlatformAdmin: true } });
  });
  afterAll(async () => {
    if (!db) return;
    await db.supportSession.deleteMany({ where: { superadminId: S } });
    await db.$transaction([
      db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
      db.$executeRaw`DELETE FROM "PlatformAuditEvent" WHERE "actorId" = ANY(${users}::text[]) OR "targetUserId" = ANY(${users}::text[])`,
    ]);
    for (const t of tenants) await t.cleanup();
    await db.userProfile.deleteMany({ where: { id: { in: users }, practitioners: { none: {} } } });
    await db.$disconnect();
  });
  beforeEach(() => {
    gotrue = new GotrueFake();
    __setAuthAdminForTests(gotrue);
    cookies().delete(SUPPORT_COOKIE);
  });
  afterEach(() => {
    __setAuthAdminForTests(null);
    asAnonymous();
  });

  it("[CF2-ZF3-1a] suspender al receptor cierra su regla en `now`; la caja deja de descontar desde ese instante", async () => {
    const t = await tenant();
    const f = await fixture(t);
    await paid(t, f.giver.practitionerId, new Date(Date.now() - HOUR), 10_000);

    asUser(t.userId);
    const before = new Date();
    const r = await suspendMember((await membershipOf(t, f.receiver.userId)).id);
    const after = new Date();
    expect(r.ok).toBe(true);
    await expectClosedByMemberChange(t, f, { before, after, closedById: t.userId, reason: "member.suspend" });

    // Cobrado DESPUÉS de la suspensión: ya no se le descuenta al que destinaba.
    await paid(t, f.giver.practitionerId, new Date(after.getTime() + 50), 7_000);
    const range = { start: new Date(Date.now() - 4 * HOUR), end: new Date(Date.now() + HOUR) };
    const groups = await runWithRls(t.tenantId, (tx) => collectedGroupsInTx(tx, t.tenantId, range, { includeInsurer: true }));
    const mine = groups.filter((g) => g.practitionerId === f.giver.practitionerId);
    expect(mine.map((g) => ({ ruleId: g.ruleId, amountCents: g.amountCents })).sort((a, b) => a.amountCents - b.amountCents)).toEqual([
      { ruleId: null, amountCents: 7_000 },
      { ruleId: f.open, amountCents: 10_000 },
    ]);
  });

  it("[CF2-ZF3-1b] suspender al que destina también cierra la regla", async () => {
    const t = await tenant();
    const f = await fixture(t);
    asUser(t.userId);
    const before = new Date();
    expect((await suspendMember((await membershipOf(t, f.giver.userId)).id)).ok).toBe(true);
    await expectClosedByMemberChange(t, f, { before, after: new Date(), closedById: t.userId, reason: "member.suspend" });
  });

  it("[CF2-ZF3-1c] quitar al receptor del equipo cierra la regla", async () => {
    const t = await tenant();
    const f = await fixture(t);
    asUser(t.userId);
    const before = new Date();
    expect(await removeMember((await membershipOf(t, f.receiver.userId)).id)).toMatchObject({ ok: true });
    await expectClosedByMemberChange(t, f, { before, after: new Date(), closedById: t.userId, reason: "member.remove" });
  });

  it("[CF2-ZF3-1d] pasar al receptor a un rol que no atiende cierra la regla", async () => {
    const t = await tenant();
    const f = await fixture(t);
    asUser(t.userId);
    const before = new Date();
    expect(await changeMemberRole((await membershipOf(t, f.receiver.userId)).id, "ASSISTANT")).toMatchObject({ ok: true });
    await expectClosedByMemberChange(t, f, { before, after: new Date(), closedById: t.userId, reason: "member.nonClinical" });
  });

  it("[CF2-ZF3-1e] deshabilitar al receptor al bajar de plan cierra la regla", async () => {
    const t = await tenant("CLINICA");
    const f = await fixture(t);
    // Clínica → Consultorio (5 usuarios): Titular + 4 entran; quien cambia el plan elige deshabilitar al receptor igual.
    const ctx: TeamActorCtx = { via: "tenant", tenantId: t.tenantId, actorUserId: t.userId, actorRole: "OWNER", actorRef: null };
    const before = new Date();
    const res = await runTeamTx(ctx, async (tx) =>
      applyPlanChangeInTx(tx, {
        tenantId: t.tenantId,
        to: "CONSULTORIO",
        disableMembershipIds: [(await membershipOf(t, f.receiver.userId)).id],
        reactivateMembershipIds: [],
        expectedUpdatedAt: (await tx.tenant.findUniqueOrThrow({ where: { id: t.tenantId } })).updatedAt,
        ctx,
        now: new Date(),
      }),
    );
    expect(res).toMatchObject({ ok: true });
    const r = await rule(f.open);
    expect(r.effectiveTo).not.toBeNull();
    expect(r.effectiveTo!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 5);
    expect(r.closedById).toBe(t.userId);
    expect(await rule(f.old)).toMatchObject({ effectiveTo: f.oldClosedAt });
    expect(await rule(f.other)).toMatchObject({ effectiveTo: null });
    const audits = await closeAudits(t, before);
    expect(audits.map((a) => a.entityId)).toEqual([f.open]);
    expect(audits[0].payload).toMatchObject({ reason: "plan.downgrade" });
  });

  it("[CF2-ZF3-1f] Plataforma deshabilita al usuario → se cierran sus reglas en todos sus consultorios", async () => {
    const t1 = await tenant();
    const t2 = await tenant();
    const f1 = await fixture(t1);
    // El MISMO usuario (receptor en t1) atiende también en t2, donde destina.
    const userId = f1.receiver.userId;
    await db.membership.create({ data: { userId, tenantId: t2.tenantId, role: "PRACTITIONER", clinical: true, acceptedAt: new Date() } });
    const p2 = await db.practitioner.create({ data: { tenantId: t2.tenantId, userId }, select: { id: true } });
    const other2 = await addPractitioner(db, t2);
    const r2 = await addRevenueShare(db, t2, { giverPractitionerId: p2.id, receiverPractitionerId: other2.practitionerId, shareBps: 3000 });

    asUser(S);
    const before = new Date();
    const res = await setPlatformUserDisabled({ userId, disabled: true });
    expect(res).toMatchObject({ ok: true, data: { changed: true } });
    const a = await rule(f1.open);
    const b = await rule(r2);
    for (const r of [a, b]) {
      expect(r.effectiveTo).not.toBeNull();
      expect(r.effectiveTo!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 5);
      expect(r.closedById).toBe(S);
    }
    expect(await rule(f1.other)).toMatchObject({ effectiveTo: null });
    expect((await closeAudits(t1, before)).map((x) => x.payload)).toEqual([expect.objectContaining({ reason: "user.disable" })]);
    expect((await closeAudits(t2, before)).map((x) => x.entityId)).toEqual([r2]);
    // Volver a habilitar no reabre nada (D-CF2-18: una regla cerrada no se reabre; se crea otra si hace falta).
    expect((await setPlatformUserDisabled({ userId, disabled: false })).ok).toBe(true);
    expect((await rule(f1.open)).effectiveTo).not.toBeNull();
    await db.membership.deleteMany({ where: { userId, tenantId: t2.tenantId } });
  });

  it("[CF2-ZF3-4] soporte no lee el reparto (como no ve la caja)", async () => {
    const t = await tenant();
    await fixture(t);
    asUser(t.userId);
    expect((await listRevenueShares()).ok).toBe(true);

    const session = await db.supportSession.create({ data: { tenantId: t.tenantId, superadminId: S, reason: "ZF3: soporte y reparto" } });
    asUser(S);
    cookies().set(SUPPORT_COOKIE, makeSupportCookieValue(session.id, S));
    const r = await listRevenueShares();
    expect(r.ok).toBe(false);
    await db.supportSession.update({ where: { id: session.id }, data: { endedAt: new Date(), endedReason: "test" } });
  });

  it("[CF2-ZF3-5] «creada por» en la caja: null si quien la creó ya no es miembro del consultorio", async () => {
    const t = await tenant();
    const other = await tenant();
    const giver = await addPractitioner(db, t);
    const receiver = await addPractitioner(db, t);
    // Miembro de OTRO consultorio, nunca de este (o que ya se fue): su nombre no se resuelve acá.
    const outsider = await addPractitioner(db, other);
    await db.userProfile.update({ where: { id: outsider.userId }, data: { fullName: "Ajeno Zeta" } });
    // El trigger no deja cambiar `createdById` después: se crea así (como si la hubiera creado antes de irse).
    const { id } = await db.practitionerRevenueShare.create({
      data: {
        tenantId: t.tenantId,
        giverPractitionerId: giver.practitionerId,
        receiverPractitionerId: receiver.practitionerId,
        shareBps: 1000,
        appliesManual: true,
        appliesOnline: true,
        appliesInsurer: true,
        effectiveFrom: new Date(Date.now() - HOUR),
        createdById: outsider.userId,
      },
      select: { id: true },
    });
    await db.userProfile.update({ where: { id: t.userId }, data: { fullName: "Titular Zeta" } });
    // Creada por el Titular (miembro): el testigo de que el null no es «nunca hay nombre».
    const byMember = await addRevenueShare(db, t, { giverPractitionerId: receiver.practitionerId, receiverPractitionerId: giver.practitionerId, shareBps: 1000 });
    const range = { start: new Date(Date.now() - 4 * HOUR), end: new Date(Date.now() + HOUR) };
    const rows = await runWithRls(t.tenantId, (tx) => revenueSharesForPeriodInTx(tx, t.tenantId, range));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(id)?.createdByName).toBeNull();
    // Quien SÍ es miembro conserva su nombre (anti-false-green del null).
    expect(byId.get(byMember)?.createdByName).toBe("Titular Zeta");
    // Mismo criterio que el editor.
    asUser(t.userId);
    const list = await listRevenueShares();
    expect(list.ok).toBe(true);
    if (list.ok) expect(list.data.rules.find((r) => r.id === id)?.createdByName).toBeNull();
  });

  it("[CF2-ZF3-8] el trigger de solo cierre es conflicto; otro CHECK (23514) no", async () => {
    const t = await tenant();
    const a = await addPractitioner(db, t);
    const b = await addPractitioner(db, t);
    const closed = await addRevenueShare(db, t, {
      giverPractitionerId: a.practitionerId,
      receiverPractitionerId: b.practitionerId,
      shareBps: 1000,
      effectiveFrom: new Date(Date.now() - 2 * HOUR),
      effectiveTo: new Date(Date.now() - HOUR),
    });
    const errorOf = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (e) {
        return e;
      }
      throw new Error("se esperaba un error de la base");
    };
    // Reabrir una cerrada → el trigger (23514 con su mensaje).
    const trig = await errorOf(() =>
      runWithRls(t.tenantId, (tx) =>
        tx.practitionerRevenueShare.updateMany({ where: { id: closed, tenantId: t.tenantId }, data: { effectiveTo: null } }),
      ),
    );
    expect(isRevenueShareConflict(trig)).toBe(true);
    // CHECK de bps (también 23514, pero no es una carrera): error genérico, se loguea.
    const check = await errorOf(() =>
      runWithRls(t.tenantId, (tx) =>
        tx.practitionerRevenueShare.create({
          data: {
            tenantId: t.tenantId,
            giverPractitionerId: b.practitionerId,
            receiverPractitionerId: a.practitionerId,
            shareBps: 0,
            appliesManual: true,
            appliesOnline: true,
            appliesInsurer: true,
            effectiveFrom: new Date(),
          },
        }),
      ),
    );
    expect(isRevenueShareConflict(check)).toBe(false);
    // Período al revés (CHECK `period_check`, 23514): tampoco.
    const period = await errorOf(() =>
      runWithRls(t.tenantId, (tx) =>
        tx.practitionerRevenueShare.create({
          data: {
            tenantId: t.tenantId,
            giverPractitionerId: b.practitionerId,
            receiverPractitionerId: a.practitionerId,
            shareBps: 100,
            appliesManual: true,
            appliesOnline: true,
            appliesInsurer: true,
            effectiveFrom: new Date(),
            effectiveTo: new Date(Date.now() - HOUR),
          },
        }),
      ),
    );
    expect(isRevenueShareConflict(period)).toBe(false);
  });
});
