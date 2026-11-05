/**
 * CT-I (CF3b, integrador del co-titular) — los handoffs de CT-K1/CT-K2/CT-U que quedaron fuera de sus sesiones, contra
 * Postgres en los dos roles (`npm run test:integration -- ct-i-co-owner` con kinesoft_app/RLS y `:owner` = BYPASSRLS).
 *
 *   [CT-I-1] H5 `notifyTenantOwners`: el co-titular recibe lo mismo que el Titular; el profesional común y el
 *            co-titular suspendido no.
 *   [CT-I-2] H1 supervisión (`lib/visibility.ts`): el co-titular ve todo el consultorio y tiene acceso `full` a un
 *            paciente asignado a otro profesional; el profesional común sigue en `basic`.
 *   [CT-I-3] H2 dashboard: el scope de los counts del co-titular es el de todo el consultorio (`todayCount` cuenta el
 *            turno de otro profesional), como el del Titular.
 *   [CT-I-4] fix M (`lib/saas-plan-change-internal.ts`): al bajar de plan, un Administrador/a con «Planes y pagos» no
 *            puede elegir al co-titular (preview `isOwner`, apply y bajada programada → `owner_selected`, sin
 *            escribir); el Titular principal y Plataforma sí.
 *   [CT-I-5] B «Plan y uso» (`getTenantPlanUsage`): solo `account.billing`; el co-titular (con un `grantBilling` viejo)
 *            y el Administrador/a con «Configuración» sin «Planes y pagos» → rechazo.
 *   [CT-I-6] B cupo lleno: a quien no ve «Plan y uso» (co-titular) el copy le dice que le pida al titular; al
 *            principal, «Configuración → Plan y uso».
 *
 * Símbolos REALES; se mockea solo el step-up de 2FA (frontera externa: TOTP) para que los rechazos sean de la regla.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import type { Prisma, PrismaClient, SaasPlan } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { getActor } from "@/lib/session";
import { notifyTenantOwners } from "@/lib/notifications-internal";
import { patientAccessFor, visibilityForActor } from "@/lib/visibility";
import { getDashboardData } from "@/lib/dashboard";
import { applyPlanChangeInTx, previewPlanChangeInTx } from "@/lib/saas-plan-change-internal";
import { scheduleDowngradeInTx } from "@/lib/saas-billing-schedule-internal";
import { runTeamTx, type TeamActorCtx } from "@/lib/team-internal";
import { PLAN_USAGE_FORBIDDEN, getTenantPlanUsage } from "@/lib/tenant-plan-usage";
import { createInvitation } from "@/lib/invitations";
import { LEGACY_PLAN_OF } from "@/lib/saas-plans-logic";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { SUPPORT_COOKIE } from "@/lib/support-session-internal";
import { asUser } from "@/tests/helpers/actor";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  addStaff,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

vi.mock("@/lib/two-factor-step-up", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/two-factor-step-up")>()),
  requireStepUp: async () => {},
}));

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("[CT-I] co-titular: avisos, supervisión, dashboard, bajar de plan, Plan y uso y cupo", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  /** Co-titular de A con un `grantBilling` VIEJO (no le tiene que abrir nada de la suscripción). */
  let co: { userId: string; practitionerId: string };
  /** Co-titular de A suspendido: no recibe avisos. */
  let coOff: { userId: string; practitionerId: string };
  let pro: { userId: string; practitionerId: string };
  let adminSettings: { userId: string };
  let patientOfPro = "";
  const tenants: EphemeralTenant[] = [];

  const mem = (userId: string, tenantId: string) =>
    db.membership.findUniqueOrThrow({ where: { userId_tenantId: { userId, tenantId } } });
  const setCoOwner = (userId: string, tenantId: string, extra: Prisma.MembershipUpdateInput = {}) =>
    db.membership.update({ where: { userId_tenantId: { userId, tenantId } }, data: { grantCoOwner: true, ...extra } });

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db, { saasPlan: "CONSULTORIO", plan: LEGACY_PLAN_OF.CONSULTORIO });
    tenants.push(A);
    co = await addPractitioner(db, A, "PRACTITIONER");
    await setCoOwner(co.userId, A.tenantId, { grantBilling: true });
    coOff = await addPractitioner(db, A, "PRACTITIONER");
    await setCoOwner(coOff.userId, A.tenantId, { disabledAt: new Date() });
    pro = await addPractitioner(db, A, "PRACTITIONER");
    adminSettings = await addStaff(db, A, "ADMIN", { grantSettings: true, grantBilling: false });
    patientOfPro = await addPatient(db, A, { assignedPractitionerId: pro.practitionerId });
    // Turno de HOY de otro profesional: el scope «todo el consultorio» lo cuenta, el propio del co-titular no.
    await db.booking.create({
      data: {
        tenantId: A.tenantId,
        patientId: patientOfPro,
        practitionerId: pro.practitionerId,
        serviceId: A.serviceId,
        scheduledFor: new Date(),
        durationMin: 45,
        idempotencyKey: randomUUID(),
        status: "CONFIRMED",
      },
    });
  }, 60_000);

  afterAll(async () => {
    if (db) {
      for (const t of tenants) await t.cleanup();
      await db.$disconnect();
    }
  });

  beforeEach(() => {
    cookies().delete(SUPPORT_COOKIE);
    cookies().delete("kine_tenant");
    __rateLimitInternals.reset();
  });

  it("[CT-I-1] H5: notifyTenantOwners llega al co-titular activo (como al Titular), no al profesional común ni al co-titular suspendido", async () => {
    const title = `cti-notify-${uniqueSuffix()}`;
    await notifyTenantOwners({ tenantId: A.tenantId, kind: "PAYMENT_RECEIVED", title });
    const got = new Set(
      (await db.notification.findMany({ where: { tenantId: A.tenantId, title }, select: { userId: true } })).map((r) => r.userId)
    );
    // Afirma también el Titular: un throw tragado (fire-and-forget) no pasa por verde.
    expect(got.has(A.userId)).toBe(true);
    expect(got.has(co.userId)).toBe(true);
    expect(got.has(pro.userId)).toBe(false);
    expect(got.has(coOff.userId)).toBe(false);
  });

  it("[CT-I-2] H1: el co-titular supervisa (ve todo y `full` sobre el paciente de otro); el profesional común no", async () => {
    asUser(co.userId);
    const coActor = await getActor();
    expect((await visibilityForActor(coActor)).seesAll).toBe(true);
    expect(await patientAccessFor(coActor, patientOfPro)).toBe("full");

    // Mismo consultorio, sin la marca: el paciente de otro le queda en `basic` (sin vista compartida).
    const other = await addPractitioner(db, A, "PRACTITIONER");
    asUser(other.userId);
    const otherActor = await getActor();
    expect((await visibilityForActor(otherActor)).seesAll).toBe(false);
    expect(await patientAccessFor(otherActor, patientOfPro)).toBe("basic");
  });

  it("[CT-I-3] H2: el dashboard del co-titular cuenta los turnos de hoy de todo el consultorio, igual que el del Titular", async () => {
    asUser(A.userId);
    const owner = await getDashboardData();
    asUser(co.userId);
    const coData = await getDashboardData();
    expect(owner.todayCount).toBeGreaterThanOrEqual(1);
    expect(coData.todayCount).toBe(owner.todayCount);
    // El profesional común (sin vista compartida) no ve el turno de `pro` en su scope.
    const other = await addPractitioner(db, A, "PRACTITIONER");
    asUser(other.userId);
    expect((await getDashboardData()).todayCount).toBe(0);
  });

  // ── Fix M: bajar de plan ─────────────────────────────────────────────────────────────────────────────────────

  async function planWorld() {
    const t = await createEphemeralTenant(db, { saasPlan: "CONSULTORIO", plan: LEGACY_PLAN_OF.CONSULTORIO });
    tenants.push(t);
    const c = await addPractitioner(db, t, "PRACTITIONER");
    await setCoOwner(c.userId, t.tenantId);
    const admin = await addStaff(db, t, "ADMIN", { grantSettings: true, grantBilling: true });
    return { t, co: await mem(c.userId, t.tenantId), admin: await mem(admin.userId, t.tenantId) };
  }

  const tenantCtx = (t: EphemeralTenant, actorUserId: string, actorRole: "OWNER" | "ADMIN"): TeamActorCtx => ({
    via: "tenant",
    tenantId: t.tenantId,
    actorUserId,
    actorRole,
    actorRef: null,
  });
  const platformCtx = (t: EphemeralTenant): TeamActorCtx => ({
    via: "platform",
    tenantId: t.tenantId,
    actorUserId: `superadmin-${uniqueSuffix()}`,
    actorRole: "SUPERADMIN",
    actorRef: { userId: null, email: "soporte@test.local", homeTenantId: null },
  });
  const preview = (ctx: TeamActorCtx, to: SaasPlan) =>
    runTeamTx(ctx, (tx) =>
      previewPlanChangeInTx(tx, { tenantId: ctx.tenantId, to, now: new Date(), actorUserId: ctx.actorUserId, via: ctx.via })
    );
  const apply = (ctx: TeamActorCtx, to: SaasPlan, disable: string[]) =>
    runTeamTx(ctx, async (tx) =>
      applyPlanChangeInTx(tx, {
        tenantId: ctx.tenantId,
        to,
        disableMembershipIds: disable,
        reactivateMembershipIds: [],
        expectedUpdatedAt: (await tx.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId } })).updatedAt,
        ctx,
        now: new Date(),
      })
    );

  it("[CT-I-4a] fix M: el Administrador/a con «Planes y pagos» no puede elegir al co-titular (preview sin casilla, apply → owner_selected sin escribir)", async () => {
    const w = await planWorld();
    const ctx = tenantCtx(w.t, w.admin.userId, "ADMIN");
    const p = await preview(ctx, "INDIVIDUAL");
    expect(p!.candidates.find((c) => c.membershipId === w.co.id)).toMatchObject({ isOwner: true, coOwner: true });

    const before = await db.tenant.findUniqueOrThrow({ where: { id: w.t.tenantId } });
    expect(await apply(ctx, "INDIVIDUAL", [w.co.id])).toEqual({ ok: false, reason: "owner_selected" });
    const after = await db.tenant.findUniqueOrThrow({ where: { id: w.t.tenantId } });
    expect(after.saasPlan).toBe("CONSULTORIO");
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(await mem(w.co.userId, w.t.tenantId)).toMatchObject({ disabledAt: null, grantCoOwner: true });
  });

  it("[CT-I-4b] fix M: la bajada PROGRAMADA tampoco deja al Administrador/a elegir al co-titular", async () => {
    const w = await planWorld();
    await db.saasSubscription.create({
      data: { tenantId: w.t.tenantId, anchorDay: 4, nextChargeAt: new Date("2030-04-04T03:00:00Z") },
    });
    const r = await prismaService.$transaction((tx) =>
      scheduleDowngradeInTx(tx, {
        tenantId: w.t.tenantId,
        to: "INDIVIDUAL",
        disableMembershipIds: [w.co.id],
        requestedById: w.admin.userId,
        now: new Date("2030-03-20T15:00:00Z"),
      })
    );
    expect(r).toEqual({ ok: false, reason: "invalid_selection", detail: "owner_selected" });
    expect((await db.saasSubscription.findUniqueOrThrow({ where: { tenantId: w.t.tenantId } })).pendingPlan).toBeNull();
  });

  it("[CT-I-4c] fix M: Plataforma y el Titular principal sí lo pueden elegir", async () => {
    const w = await planWorld();
    const plat = await preview(platformCtx(w.t), "INDIVIDUAL");
    expect(plat!.candidates.find((c) => c.membershipId === w.co.id)).toMatchObject({ isOwner: false, coOwner: true });

    const ctx = tenantCtx(w.t, w.t.userId, "OWNER");
    const p = await preview(ctx, "INDIVIDUAL");
    expect(p!.candidates.find((c) => c.membershipId === w.co.id)).toMatchObject({ isOwner: false, coOwner: true });
    const r = await apply(ctx, "INDIVIDUAL", [w.co.id, w.admin.id]);
    expect(r).toMatchObject({ ok: true, disabled: 2 });
    expect(await mem(w.co.userId, w.t.tenantId)).toMatchObject({ disabledReason: "PLAN_DOWNGRADE" });
  });

  it("[CT-I-5] B: «Plan y uso» es solo de `account.billing`: el co-titular (con grantBilling viejo) y el Administrador/a sin «Planes y pagos» no la leen; el Titular sí", async () => {
    asUser(A.userId);
    expect((await getTenantPlanUsage()).plan).toBe("CONSULTORIO");
    for (const u of [co.userId, adminSettings.userId]) {
      asUser(u);
      await expect(getTenantPlanUsage()).rejects.toThrow(PLAN_USAGE_FORBIDDEN);
    }
  });

  it("[CT-I-6] B cupo lleno: al co-titular le dice que le pida al titular; al principal lo manda a «Plan y uso»", async () => {
    const t = await createEphemeralTenant(db, { saasPlan: "CONSULTORIO", plan: LEGACY_PLAN_OF.CONSULTORIO });
    tenants.push(t);
    const c = await addPractitioner(db, t, "PRACTITIONER");
    await setCoOwner(c.userId, t.tenantId);
    // Cupos a medida: rigen solo en Libre (`effectiveLimits`). Lleno con los que ya están.
    const used = await db.membership.count({ where: { tenantId: t.tenantId, disabledAt: null } });
    await db.tenant.update({ where: { id: t.tenantId }, data: { saasPlan: "LIBRE", maxUsersOverride: used } });
    const invite = () =>
      createInvitation({ email: `cti-full-${uniqueSuffix()}@example.com`, firstName: "No", lastName: "Entra", role: "ASSISTANT" });

    asUser(c.userId);
    const asCo = await invite();
    expect(asCo.ok).toBe(false);
    if (!asCo.ok) {
      expect(asCo.error).toMatch(/^Tu plan tiene /);
      expect(asCo.error).toContain("pedile al titular que amplíe el plan");
      expect(asCo.error).not.toContain("Plan y uso");
    }

    __rateLimitInternals.reset();
    asUser(t.userId);
    const asOwner = await invite();
    expect(asOwner.ok).toBe(false);
    if (!asOwner.ok) expect(asOwner.error).toContain("Configuración → Plan y uso");
    expect(await db.invitation.count({ where: { tenantId: t.tenantId } })).toBe(0);
  });
});
