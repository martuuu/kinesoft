/**
 * [MPS-3a] Actions del consultorio para la suscripción con Mercado Pago (C-MPS10, brief §26.6; MPS-D10/D11/D18/D19/
 * D21): `lib/saas-billing.ts` (preview con `billing`, subida atómica con proporcional por el canal service, bajada
 * programada) y `lib/saas-billing-mp.ts` (cómo pagás, débito automático, «Pagar con Mercado Pago», vuelta del
 * checkout, baja, deshacer, reactivar, anular la bajada).
 *
 * Símbolos REALES contra Postgres en los dos roles: `requireAccountBilling`, `requireStepUp`, `withAccountWritable`, el
 * escritor de cobros, la programación (MPS-2c), la sync (MPS-2b2) y los consumidores (MPS-2b1). Se reemplaza solo lo
 * externo:
 *  - la sesión de Supabase (access token con `session_id`/`aal`, molde de saas-billing.test.ts) para que la 2FA y el
 *    step-up corran de verdad;
 *  - la red de Mercado Pago: `installSaasFakeMp` (el MP FALSO local; nunca MP real ni sandbox);
 *  - el transporte de mails;
 *  - UNA inyección de falla en `addUpgradeProrationInTx` (envuelve el real) para probar que la subida es atómica: si el
 *    proporcional falla después de cambiar el plan, no queda nada escrito (MPS-D10).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { cookies } from "next/headers";
import type { PrismaClient, Role, SaasPlan, SubscriptionStatus } from "@prisma/client";

const tok = vi.hoisted(() => ({ claims: null as null | { session_id: string; aal: string } }));
vi.mock("@/lib/supabase/server", async () => {
  const { currentTestUser } = await import("@/tests/helpers/actor");
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const token = (): string | null => {
    const u = currentTestUser();
    if (!u || !tok.claims) return null;
    const payload = {
      sub: u.id,
      email: u.email,
      role: "authenticated",
      aud: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...tok.claims,
    };
    return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.firma-que-verifica-gotrue`;
  };
  return {
    getSupabaseServerClient: () => ({
      auth: {
        getSession: async () => {
          const t = token();
          if (!t) throw new Error("sin getSession");
          return { data: { session: { access_token: t } }, error: null };
        },
        getUser: async () => ({ data: { user: currentTestUser() }, error: null }),
        getClaims: async () => ({ data: null, error: { message: "sin JWKS" } }),
      },
    }),
  };
});

/** Falla inyectada DESPUÉS de que `applyPlanChangeInTx` escribió el plan (la tx tiene que revertir todo). */
const fault = vi.hoisted(() => ({ proration: false }));
vi.mock("@/lib/saas-billing-schedule-internal", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/saas-billing-schedule-internal")>();
  return {
    ...real,
    addUpgradeProrationInTx: async (...a: Parameters<typeof real.addUpgradeProrationInTx>) => {
      const r = await real.addUpgradeProrationInTx(...a);
      if (fault.proration) throw new Error("fallo inyectado en el proporcional");
      return r;
    },
  };
});

import { ForbiddenError, getActor } from "@/lib/session";
import { classifyStepUpError } from "@/lib/two-factor-logic";
import { setStepUpCookie, STEP_UP_COOKIE, TWO_FACTOR_COOKIE } from "@/lib/two-factor-cookie";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { __setEmailTransportForTests, type SendEmailInput, type SendEmailResult } from "@/lib/email";
import { prismaService } from "@/lib/db";
import { applyPlanChange, previewPlanChange } from "@/lib/saas-billing";
import {
  cancelScheduledPlanChange,
  confirmCheckoutReturn,
  payChargeWithMp,
  reactivateSubscription,
  refreshAutoDebit,
  scheduleCancel,
  setCollectionMethod,
  startAutoDebit,
  undoCancel,
} from "@/lib/saas-billing-mp";
import { applyDueCancelInTx } from "@/lib/saas-billing-schedule-internal";
import { startSupport } from "@/lib/platform-support";
import { SUPPORT_COOKIE } from "@/lib/support-session-internal";
import { __resetSaasMpMemoForTests } from "@/lib/mercadopago-saas";
import { SAAS_MP_COPY } from "@/lib/saas-billing-types";
import {
  addMonthsKey,
  arMidnight,
  dbDateFromKey,
  keyFromDbDate,
  periodFor,
  periodStartOnOrBefore,
  prorate,
} from "@/lib/saas-billing-logic";
import { toARDateKey } from "@/lib/datetime-ar";
import { LEGACY_PLAN_OF } from "@/lib/saas-plans-logic";
import { asUser } from "@/tests/helpers/actor";
import { payFake } from "@/tests/helpers/mp-connect-fake";
import { fakeMpGetPreapproval, installSaasFakeMp, walkFakeSubscriptionCheckout, type InstalledSaasFakeMp } from "@/tests/helpers/mp-saas-fake";
import { ownerClient, createEphemeralTenant, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const DAY = 86_400_000;

const mail = {
  sent: [] as SendEmailInput[],
  transport: async (i: SendEmailInput): Promise<SendEmailResult> => {
    mail.sent.push(i);
    return { ok: true, transport: "resend", providerId: `re_${mail.sent.length}` };
  },
};

describe.skipIf(!RUN)("[MPS-3a] actions de la suscripción con Mercado Pago", () => {
  let db: PrismaClient;
  let fake: InstalledSaasFakeMp | null = null;
  const tenants: EphemeralTenant[] = [];
  const users: string[] = [];

  const today = () => toARDateKey(new Date());
  /** Período vigente (ancla 4) y el cobro siguiente. */
  const period = () => periodFor(periodStartOnOrBefore(4, today()));

  beforeAll(() => {
    db = ownerClient();
  });
  afterAll(async () => {
    __setEmailTransportForTests(null);
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
    mail.sent.length = 0;
    __setEmailTransportForTests(mail.transport);
    __rateLimitInternals.reset();
    __resetSaasMpMemoForTests();
    fault.proration = false;
    tok.claims = null;
    cookies().delete(TWO_FACTOR_COOKIE);
    cookies().delete(STEP_UP_COOKIE);
    cookies().delete(SUPPORT_COOKIE);
    vi.stubEnv("SAAS_BILLING_MODE", "manual");
  });
  afterEach(() => {
    fake?.uninstall();
    fake = null;
    vi.unstubAllEnvs();
  });

  async function tenant(saasPlan: SaasPlan = "CONSULTORIO", status: SubscriptionStatus = "ACTIVE", o: { statusChangedAt?: Date } = {}) {
    const t = await createEphemeralTenant(db, { saasPlan, plan: LEGACY_PLAN_OF[saasPlan] });
    tenants.push(t);
    await db.tenant.update({
      where: { id: t.tenantId },
      data: { subscriptionStatus: status, trialEndsAt: null, subscriptionStatusChangedAt: o.statusChangedAt ?? new Date() },
    });
    return t;
  }

  /** Suscripción anclada en el 4 con el próximo cobro al fin del período vigente. */
  async function subscribe(
    t: EphemeralTenant,
    o: { customPriceCents?: number; customPricePlan?: SaasPlan; extra?: Record<string, unknown> } = {}
  ) {
    const p = period();
    return db.saasSubscription.upsert({
      where: { tenantId: t.tenantId },
      create: {
        tenantId: t.tenantId,
        anchorDay: 4,
        nextChargeAt: arMidnight(p.periodEnd),
        billableFrom: dbDateFromKey(addMonthsKey(p.periodStart, -1)),
        customPriceCents: o.customPriceCents ?? null,
        customPricePlan: o.customPricePlan ?? null,
        ...(o.extra ?? {}),
      },
      update: { customPriceCents: o.customPriceCents ?? null, customPricePlan: o.customPricePlan ?? null, ...(o.extra ?? {}) },
    });
  }

  async function charge(t: EphemeralTenant, plan: SaasPlan, baseCents: number, periodStart = period().periodStart) {
    const p = periodFor(periodStart);
    return db.saasCharge.create({
      data: {
        tenantId: t.tenantId,
        plan,
        periodStart: dbDateFromKey(p.periodStart),
        periodEnd: dbDateFromKey(p.periodEnd),
        dueDate: dbDateFromKey(p.dueDate),
        amountCents: baseCents,
        baseAmountCents: baseCents,
      },
    });
  }

  async function member(t: EphemeralTenant, role: Role) {
    const id = `test-user-${uniqueSuffix()}`;
    users.push(id);
    await db.userProfile.create({ data: { id, email: `${id}@test.local`, fullName: `Miembro ${role}` } });
    return db.membership.create({
      data: { userId: id, tenantId: t.tenantId, role, clinical: role === "PRACTITIONER", acceptedAt: new Date() },
    });
  }

  /** 2FA + step-up fresco para `userId` (la frontera es la sesión de Supabase y la cookie). */
  async function stepUp(userId: string) {
    await db.userProfile.update({ where: { id: userId }, data: { twoFactorTotp: true } });
    tok.claims = { session_id: `sess-${userId}`, aal: "aal2" };
    setStepUpCookie(userId, `sess-${userId}`);
  }

  const sub = (t: EphemeralTenant) => db.saasSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } });
  const tenantRow = (t: EphemeralTenant) => db.tenant.findUniqueOrThrow({ where: { id: t.tenantId } });
  const planInput = async (t: EphemeralTenant, to: SaasPlan, disable: string[] = []) => ({
    to,
    disableMembershipIds: disable,
    reactivateMembershipIds: [],
    expectedUpdatedAt: (await tenantRow(t)).updatedAt.toISOString(),
  });

  /** Todas las actions nuevas (las de step-up primero). */
  const ALL = () => [
    () => setCollectionMethod({ method: "TRANSFER" }),
    () => startAutoDebit({ payerEmail: "titular@test.local" }),
    () => scheduleCancel(),
    () => reactivateSubscription(),
    () => refreshAutoDebit(),
    () => payChargeWithMp({}),
    () => confirmCheckoutReturn({ paymentId: "123456" }),
    () => undoCancel(),
    () => cancelScheduledPlanChange(),
  ];

  // ── Barreras ────────────────────────────────────────────────────────────────────────────────────────────────

  it("[MPS-3a] step-up: cómo pagás, activar el débito, programar la baja y reactivar lo exigen; lo demás no; nada cambia", async () => {
    const t = await tenant();
    await subscribe(t);
    asUser(t.userId);
    const needStepUp = ALL().slice(0, 4);
    for (const fn of needStepUp) expect(classifyStepUpError(await fn().catch((e) => e))).toEqual({ kind: "setup" });
    await db.userProfile.update({ where: { id: t.userId }, data: { twoFactorTotp: true } });
    tok.claims = { session_id: "sess-sin-step-up", aal: "aal2" };
    for (const fn of needStepUp) expect(classifyStepUpError(await fn().catch((e) => e))).toEqual({ kind: "step_up" });
    expect(await sub(t)).toMatchObject({ collectionMethod: null, cancelAtPeriodEnd: false, mpPendingPreapprovalId: null });
    // Sin step-up: contestan por la regla de negocio, no por la 2FA.
    expect(await undoCancel()).toMatchObject({ ok: false, reason: "not_cancelled" });
    expect(await cancelScheduledPlanChange()).toMatchObject({ ok: false, reason: "no_pending_plan" });
    expect(await refreshAutoDebit()).toMatchObject({ ok: true, data: { status: "none" } });
  });

  it("[MPS-3a] sin «Planes y pagos» (Secretaria) → 403 en todas y nada se escribe", async () => {
    const t = await tenant();
    await subscribe(t);
    const sec = await member(t, "ASSISTANT");
    asUser(sec.userId);
    await stepUp(sec.userId);
    for (const fn of ALL()) await expect(fn()).rejects.toBeInstanceOf(ForbiddenError);
    expect(await sub(t)).toMatchObject({ collectionMethod: null, cancelAtPeriodEnd: false, mpPendingPreapprovalId: null });
  });

  it("[MPS-3a] soporte → 403 en todas (nunca `account.*`)", async () => {
    const t = await tenant();
    await subscribe(t);
    const H = await createEphemeralTenant(db);
    tenants.push(H);
    await db.userProfile.update({ where: { id: H.userId }, data: { isPlatformAdmin: true } });
    asUser(H.userId);
    await stepUp(H.userId);
    const s = await startSupport(t.tenantId, "Ayuda con el débito del consultorio");
    if (!s.ok) throw new Error(s.error);
    try {
      for (const fn of ALL()) await expect(fn()).rejects.toBeInstanceOf(ForbiddenError);
      expect(await sub(t)).toMatchObject({ collectionMethod: null, cancelAtPeriodEnd: false });
    } finally {
      cookies().delete(SUPPORT_COOKIE);
      await db.supportSession.deleteMany({ where: { superadminId: H.userId } });
    }
  });

  it("[MPS-3a] modo off → mode_off en todas; manual: transferencia y baja sí, Mercado Pago no", async () => {
    const t = await tenant();
    await subscribe(t);
    asUser(t.userId);
    await stepUp(t.userId);
    vi.stubEnv("SAAS_BILLING_MODE", "off");
    for (const fn of ALL()) expect(await fn()).toMatchObject({ ok: false, reason: "mode_off" });
    vi.stubEnv("SAAS_BILLING_MODE", "manual");
    expect(await setCollectionMethod({ method: "MP_CHECKOUT" })).toMatchObject({ ok: false, reason: "mode_off" });
    expect(await startAutoDebit({ payerEmail: "titular@test.local" })).toMatchObject({ ok: false, reason: "mode_off" });
    expect(await payChargeWithMp({})).toMatchObject({ ok: false, reason: "mode_off" });
    expect(await confirmCheckoutReturn({ paymentId: "123" })).toMatchObject({ ok: false, reason: "mode_off" });
    expect(await setCollectionMethod({ method: "TRANSFER" })).toEqual({ ok: true, data: { collectionMethod: "TRANSFER" } });
    expect(await sub(t)).toMatchObject({ collectionMethod: "TRANSFER", autoDebitEnabled: false });
    const ev = await db.auditEvent.findFirstOrThrow({ where: { tenantId: t.tenantId, action: "billing.collection_method" } });
    expect(ev.payload).toMatchObject({ from: null, to: "TRANSFER" });
    expect(await setCollectionMethod({ method: "AUTO_DEBIT" })).toMatchObject({ ok: false, reason: "invalid_input" });
  });

  // ── Cambio de plan (lib/saas-billing.ts) ────────────────────────────────────────────────────────────────────

  it("[MPS-3a] previewPlanChange suma billing: subida con proporcional, bajada al próximo cobro, inmediata sin cargo", async () => {
    const p = period();
    const up = await tenant("INDIVIDUAL");
    await subscribe(up, { customPriceCents: 3_000_000, customPricePlan: "CONSULTORIO" });
    await charge(up, "INDIVIDUAL", 1_000_000);
    asUser(up.userId);
    const pr = prorate({ diffCents: 2_000_000, fromKey: today(), periodStart: p.periodStart, periodEnd: p.periodEnd })!;
    const a = await previewPlanChange("CONSULTORIO");
    expect(a.ok && a.data.billing).toEqual({
      kind: "upgrade_prorated",
      effectiveOn: today(),
      prorationCents: pr.amountCents,
      days: pr.days,
      periodDays: pr.periodDays,
    });

    const down = await tenant("CONSULTORIO");
    await subscribe(down);
    await charge(down, "CONSULTORIO", 2_500_000);
    asUser(down.userId);
    const b = await previewPlanChange("INDIVIDUAL");
    expect(b.ok && b.data.billing).toEqual({ kind: "scheduled_downgrade", effectiveOn: p.periodEnd, prorationCents: 0, days: 0, periodDays: 0 });

    const free = await tenant("CONSULTORIO");
    asUser(free.userId);
    const c = await previewPlanChange("INDIVIDUAL");
    expect(c.ok && c.data.billing).toMatchObject({ kind: "immediate", effectiveOn: today(), prorationCents: 0 });
  });

  it("[MPS-3a] subida con proporcional: plan + PRORATION en UNA tx del canal service; si falla a mitad no queda nada", async () => {
    const p = period();
    const t = await tenant("INDIVIDUAL");
    await subscribe(t, { customPriceCents: 3_000_000, customPricePlan: "CONSULTORIO" });
    await charge(t, "INDIVIDUAL", 1_000_000);
    asUser(t.userId);
    await stepUp(t.userId);
    const before = await db.auditEvent.count({ where: { tenantId: t.tenantId } });

    fault.proration = true;
    await expect(applyPlanChange(await planInput(t, "CONSULTORIO"))).rejects.toThrow(/fallo inyectado/);
    expect((await tenantRow(t)).saasPlan).toBe("INDIVIDUAL");
    expect(await db.saasAdjustment.count({ where: { tenantId: t.tenantId } })).toBe(0);
    expect(await db.auditEvent.count({ where: { tenantId: t.tenantId } })).toBe(before);

    fault.proration = false;
    const pr = prorate({ diffCents: 2_000_000, fromKey: today(), periodStart: p.periodStart, periodEnd: p.periodEnd })!;
    const r = await applyPlanChange(await planInput(t, "CONSULTORIO"));
    expect(r).toEqual({
      ok: true,
      data: {
        disabled: 0,
        reactivated: 0,
        revokedInvites: 0,
        billing: { kind: "upgrade_prorated", effectiveOn: today(), prorationCents: pr.amountCents, days: pr.days, periodDays: pr.periodDays },
      },
    });
    expect((await tenantRow(t)).saasPlan).toBe("CONSULTORIO");
    const adj = await db.saasAdjustment.findMany({ where: { tenantId: t.tenantId } });
    expect(adj).toHaveLength(1);
    expect(adj[0]).toMatchObject({ kind: "PRORATION", amountCents: pr.amountCents, planFrom: "INDIVIDUAL", planTo: "CONSULTORIO", createdById: t.userId });
    expect(keyFromDbDate(adj[0].effectiveOn)).toBe(p.periodEnd);
    const ev = await db.auditEvent.findFirstOrThrow({ where: { tenantId: t.tenantId, action: "tenant.entitlements" }, orderBy: { createdAt: "desc" } });
    expect(ev.payload).toMatchObject({ source: "billing", changed: ["saasPlan"] });
    expect(await db.auditEvent.count({ where: { tenantId: t.tenantId, action: "billing.plan_change.upgraded" } })).toBe(1);
    expect(mail.sent.some((m) => m.kind === "billing_plan_change")).toBe(true);
  });

  it("[MPS-3a] bajada programada: hoy no cambia nada del equipo; se anula con cancelScheduledPlanChange", async () => {
    const p = period();
    const t = await tenant("CONSULTORIO");
    await subscribe(t);
    await charge(t, "CONSULTORIO", 2_500_000);
    const kine = await member(t, "PRACTITIONER");
    asUser(t.userId);
    await stepUp(t.userId);

    expect(await applyPlanChange(await planInput(t, "INDIVIDUAL"))).toMatchObject({ ok: false, reason: "does_not_fit" });
    expect(await applyPlanChange({ ...(await planInput(t, "INDIVIDUAL", [kine.id])), reactivateMembershipIds: [kine.id] })).toMatchObject({
      ok: false,
      reason: "invalid_selection",
    });
    const r = await applyPlanChange(await planInput(t, "INDIVIDUAL", [kine.id]));
    expect(r).toEqual({
      ok: true,
      data: { disabled: 0, reactivated: 0, revokedInvites: 0, billing: { kind: "scheduled_downgrade", effectiveOn: p.periodEnd, prorationCents: 0, days: 0, periodDays: 0 } },
    });
    expect((await tenantRow(t)).saasPlan).toBe("CONSULTORIO");
    expect((await db.membership.findUniqueOrThrow({ where: { id: kine.id } })).disabledAt).toBeNull();
    const s = await sub(t);
    expect(s).toMatchObject({ pendingPlan: "INDIVIDUAL", pendingPlanDisableIds: [kine.id], pendingPlanRequestedById: t.userId });
    expect(keyFromDbDate(s.pendingPlanEffectiveOn!)).toBe(p.periodEnd);
    expect(await db.auditEvent.count({ where: { tenantId: t.tenantId, action: "billing.plan_change.scheduled" } })).toBe(1);
    expect(mail.sent.some((m) => m.kind === "billing_plan_change")).toBe(true);

    expect(await cancelScheduledPlanChange()).toEqual({ ok: true, data: { cancelled: true } });
    expect(await sub(t)).toMatchObject({ pendingPlan: null, pendingPlanEffectiveOn: null, pendingPlanDisableIds: [] });
    expect(await cancelScheduledPlanChange()).toMatchObject({ ok: false, reason: "no_pending_plan" });
  });

  it("[MPS-3a] con la baja programada no hay cambio de plan (blocked_cancel_pending), ni preview que lo ofrezca", async () => {
    const t = await tenant("CONSULTORIO");
    await subscribe(t, { extra: { cancelAtPeriodEnd: true, cancelEffectiveOn: dbDateFromKey(period().periodEnd), cancelRequestedAt: new Date() } });
    asUser(t.userId);
    await stepUp(t.userId);
    const pv = await previewPlanChange("CLINICA");
    expect(pv.ok && pv.data.billing.kind).toBe("blocked_cancel_pending");
    const r = await applyPlanChange(await planInput(t, "CLINICA"));
    expect(r).toMatchObject({ ok: false, reason: "cancel_pending" });
    expect((await tenantRow(t)).saasPlan).toBe("CONSULTORIO");
  });

  // ── Baja, deshacer, reactivar ───────────────────────────────────────────────────────────────────────────────

  it("[MPS-3a] baja a fin de período (anula la bajada pendiente) y deshacer", async () => {
    const p = period();
    const t = await tenant("CONSULTORIO");
    await subscribe(t, {
      extra: { pendingPlan: "INDIVIDUAL", pendingPlanEffectiveOn: dbDateFromKey(p.periodEnd), pendingPlanRequestedAt: new Date() },
    });
    asUser(t.userId);
    await stepUp(t.userId);
    expect(await scheduleCancel()).toEqual({ ok: true, data: { effectiveOn: p.periodEnd } });
    const s = await sub(t);
    expect(s).toMatchObject({ cancelAtPeriodEnd: true, cancelRequestedById: t.userId, pendingPlan: null });
    expect(keyFromDbDate(s.cancelEffectiveOn!)).toBe(p.periodEnd);
    expect(mail.sent.some((m) => m.kind === "billing_cancel_scheduled")).toBe(true);
    expect(await db.auditEvent.count({ where: { tenantId: t.tenantId, action: "billing.cancel.scheduled" } })).toBe(1);
    expect(await scheduleCancel()).toMatchObject({ ok: false, reason: "cancel_pending" });

    expect(await undoCancel()).toEqual({ ok: true, data: { undone: true } });
    expect(await sub(t)).toMatchObject({ cancelAtPeriodEnd: false, cancelEffectiveOn: null });
    expect(await db.auditEvent.count({ where: { tenantId: t.tenantId, action: "billing.cancel.undone" } })).toBe(1);
    expect(await undoCancel()).toMatchObject({ ok: false, reason: "not_cancelled" });
  });

  it("[MPS-3a] reactivar (en solo lectura): propia y sin deuda → ACTIVE; con deuda no; baja de Plataforma no", async () => {
    vi.stubEnv("TENANT_ACCESS_ENFORCEMENT", "enforce");
    const t = await tenant("CONSULTORIO");
    await subscribe(t);
    asUser(t.userId);
    await stepUp(t.userId);
    expect((await scheduleCancel()).ok).toBe(true);
    // El día de la baja: la aplica la etapa 2b del cron (el símbolo real, actor null = sistema).
    await db.saasSubscription.update({ where: { tenantId: t.tenantId }, data: { cancelEffectiveOn: dbDateFromKey(today()) } });
    expect(await prismaService.$transaction((tx) => applyDueCancelInTx(tx, { tenantId: t.tenantId, actor: null, now: new Date() }))).toEqual({
      cancelled: true,
    });
    expect((await getActor()).access.mode).toBe("read_only");

    const debt = await charge(t, "CONSULTORIO", 2_500_000, addMonthsKey(period().periodStart, -1));
    expect(await reactivateSubscription()).toEqual({ ok: false, error: SAAS_MP_COPY.has_debt, reason: "has_debt" });
    await db.saasCharge.update({ where: { id: debt.id }, data: { status: "VOID" } });
    expect(await reactivateSubscription()).toEqual({ ok: true, data: { status: "ACTIVE" } });
    expect((await tenantRow(t)).subscriptionStatus).toBe("ACTIVE");

    // Dada de baja por Plataforma (acá: a mano, sin el registro de la baja propia) → no se auto-reactiva.
    const o = await tenant("CONSULTORIO", "CANCELLED");
    await subscribe(o);
    asUser(o.userId);
    await stepUp(o.userId);
    expect(await reactivateSubscription()).toEqual({ ok: false, error: SAAS_MP_COPY.reactivate_not_own, reason: "not_cancelled" });
    expect((await tenantRow(o)).subscriptionStatus).toBe("CANCELLED");
  });

  // ── Mercado Pago ────────────────────────────────────────────────────────────────────────────────────────────

  it("[MPS-3a] «Pagar con Mercado Pago»: el último impago por default, reusa el link, en solo lectura también; otro consultorio no", async () => {
    vi.stubEnv("TENANT_ACCESS_ENFORCEMENT", "enforce");
    const t = await tenant("CONSULTORIO", "PAST_DUE", { statusChangedAt: new Date(Date.now() - 60 * DAY) });
    await subscribe(t, { customPriceCents: 2_500_000, customPricePlan: "CONSULTORIO" });
    const old = await charge(t, "CONSULTORIO", 2_500_000, addMonthsKey(period().periodStart, -1));
    const cur = await charge(t, "CONSULTORIO", 2_500_000);
    const other = await tenant("CONSULTORIO");
    const foreign = await charge(other, "CONSULTORIO", 2_500_000);
    fake = installSaasFakeMp();
    asUser(t.userId);
    expect((await getActor()).access.mode).toBe("read_only");

    const a = await payChargeWithMp({});
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.data).toMatchObject({ chargeId: cur.id, reused: false });
    expect(a.data.initPoint).toMatch(/^http/);
    expect((await db.saasCharge.findUniqueOrThrow({ where: { id: cur.id } })).mpCheckoutPreferenceId).not.toBeNull();
    expect(await payChargeWithMp({})).toEqual({ ok: true, data: { ...a.data, reused: true } });
    expect(await payChargeWithMp({ chargeId: old.id })).toMatchObject({ ok: true, data: { chargeId: old.id } });
    expect(await payChargeWithMp({ chargeId: foreign.id })).toMatchObject({ ok: false, reason: "not_found" });
    expect((await db.saasCharge.findUniqueOrThrow({ where: { id: foreign.id } })).mpCheckoutPreferenceId).toBeNull();
  });

  it("[MPS-3a] vuelta del checkout: el pago de otro consultorio se rechaza sin imputar; el propio se imputa", async () => {
    const A = await tenant("CONSULTORIO");
    await subscribe(A);
    const B = await tenant("CONSULTORIO");
    await subscribe(B);
    const c = await charge(B, "CONSULTORIO", 2_500_000);
    fake = installSaasFakeMp();
    asUser(B.userId);
    expect((await payChargeWithMp({ chargeId: c.id })).ok).toBe(true);
    const pref = (await db.saasCharge.findUniqueOrThrow({ where: { id: c.id } })).mpCheckoutPreferenceId!;
    // El webhook no está enchufado (el fake solo lo registra): la imputación tiene que venir de la vuelta.
    const paid = await payFake(pref, "approved");

    asUser(A.userId);
    expect(await confirmCheckoutReturn({ paymentId: paid.paymentId })).toMatchObject({ ok: false, reason: "not_found" });
    expect(await confirmCheckoutReturn({ paymentId: "no-numerico" })).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await db.saasPayment.count({ where: { tenantId: { in: [A.tenantId, B.tenantId] } } })).toBe(0);

    asUser(B.userId);
    expect(await confirmCheckoutReturn({ paymentId: paid.paymentId, chargeId: c.id })).toEqual({
      ok: true,
      data: { outcome: "approved", chargePaid: true },
    });
    const [p] = await db.saasPayment.findMany({ where: { tenantId: B.tenantId } });
    expect(p).toMatchObject({ source: "MP_CHECKOUT", status: "APPROVED", chargeId: c.id, mpPaymentId: paid.paymentId });
    // Replay de la vuelta (F5): no duplica.
    expect((await confirmCheckoutReturn({ paymentId: paid.paymentId })).ok).toBe(true);
    expect(await db.saasPayment.count({ where: { tenantId: B.tenantId } })).toBe(1);
  });

  it("[MPS-3a] débito automático: startAutoDebit → initPoint, autorizar, refreshAutoDebit → activo; pasar a transferencia lo cancela", async () => {
    const t = await tenant("CONSULTORIO");
    await subscribe(t, { customPriceCents: 2_500_000, customPricePlan: "CONSULTORIO" });
    fake = installSaasFakeMp();
    asUser(t.userId);
    await stepUp(t.userId);
    expect(await startAutoDebit({ payerEmail: "no-es-un-email" })).toMatchObject({ ok: false, reason: "invalid_input" });
    const s1 = await startAutoDebit({ payerEmail: "Titular@Test.local" });
    expect(s1.ok).toBe(true);
    if (!s1.ok) return;
    expect(s1.data.reused).toBe(false);
    expect((await sub(t)).mpPendingPayerEmail).toBe("titular@test.local");
    expect(await startAutoDebit({ payerEmail: "titular@test.local" })).toEqual({ ok: true, data: { initPoint: s1.data.initPoint, reused: true } });
    expect(await db.auditEvent.count({ where: { tenantId: t.tenantId, action: "billing.auto_debit.started" } })).toBe(2);

    await walkFakeSubscriptionCheckout(s1.data.initPoint, "authorize");
    expect(await refreshAutoDebit()).toEqual({ ok: true, data: { status: "active" } });
    const s = await sub(t);
    expect(s).toMatchObject({ collectionMethod: "AUTO_DEBIT", autoDebitEnabled: true, mpPendingPreapprovalId: null });
    const preId = s.mpPreapprovalId!;

    expect(await setCollectionMethod({ method: "TRANSFER" })).toEqual({ ok: true, data: { collectionMethod: "TRANSFER" } });
    expect(await sub(t)).toMatchObject({ collectionMethod: "TRANSFER", autoDebitEnabled: false });
    expect(fakeMpGetPreapproval(preId)?.status).toBe("cancelled");
  });
});
