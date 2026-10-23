/**
 * [MPS-3b] Plataforma sobre la suscripción con Mercado Pago (C-MPS11, plan §26.6; MPS-D14/D20/D24):
 * `setAutoDebitAllowed`, `addAdjustment`, `getMpSubscriptionStatus`, `previewReanchor`/`applyReanchor`,
 * `undoCancelFor`, `cancelScheduledPlanFor`, `setCustomPrice` con `customPricePlan` y `platformApplyPlanChange` sin
 * proporcional automático.
 *
 * Símbolos REALES (`lib/platform-billing.ts` con `requirePlatformAdmin`, núcleo de cobros/ajustes/programación/
 * re-anclaje, el sync después del commit y el puerto de MP) contra Postgres en los dos roles y el Mercado Pago FALSO
 * (`tests/helpers/mp-saas-fake.ts`: lo único reemplazado es la red). El step-up de la 2FA se da por hecho (el corte
 * real se prueba en two-factor.test.ts, «Plataforma»): se reemplaza la dependencia, no la action bajo test.
 *
 * Fechas: el débito se crea con `now` fijo en 2030 (el fake exige `start_date` futuro); las actions de Plataforma usan
 * el reloj real, así que las suscripciones de prueba tienen el próximo cobro en 2030 (siempre futuro).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient, SaasPlan } from "@prisma/client";

vi.mock("@/lib/two-factor-step-up", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/two-factor-step-up")>()),
  requireStepUp: async () => {},
}));

import { ForbiddenError } from "@/lib/session";
import { prismaService } from "@/lib/db";
import {
  addAdjustment,
  applyReanchor,
  cancelScheduledPlanFor,
  getMpSubscriptionStatus,
  platformApplyPlanChange,
  previewReanchor,
  setAutoDebitAllowed,
  setCustomPrice,
  undoCancelFor,
} from "@/lib/platform-billing";
import { createPeriodChargeInTx } from "@/lib/saas-billing-internal";
import { startPreapprovalFlow } from "@/lib/saas-mp-sync-internal";
import { arMidnight, dayOfKey, dbDateFromKey, keyFromDbDate } from "@/lib/saas-billing-logic";
import { toARDateKey } from "@/lib/datetime-ar";
import { LEGACY_PLAN_OF } from "@/lib/saas-plans-logic";
import { authorizeFakePreapproval, fakeMpGetPreapproval, installSaasFakeMp, type InstalledSaasFakeMp } from "@/tests/helpers/mp-saas-fake";
import { asUser } from "@/tests/helpers/actor";
import { ownerClient, createEphemeralTenant, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
/** 20/3/2030 12:00 AR (alta del débito en el fake). */
const MID = new Date("2030-03-20T15:00:00Z");
/** 4/4/2030 12:00 AR (el cron arma el cargo del período 4/4 → 4/5). */
const DAY4 = new Date("2030-04-04T15:00:00Z");
const BASE = 2_000_000; // $20.000, precio a medida atado al plan (no depende de SaasPlanConfig)
const PAYER = "titular.mps3b@test.local";

/** Claves que no pueden aparecer en un DTO de Plataforma (PHI o datos de tarjeta). */
const FORBIDDEN_KEYS = /patient|paciente|dni|card|tarjeta|cvv|first_six|last_four|cardholder|identification/i;

function keysDeep(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) keysDeep(x, out);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      keysDeep(x, out);
    }
  }
  return out;
}

describe.skipIf(!RUN)("[MPS-3b] Plataforma → suscripción con Mercado Pago", () => {
  let db: PrismaClient;
  let S: EphemeralTenant; // home del superadmin
  const tenants: EphemeralTenant[] = [];
  let mp: InstalledSaasFakeMp | null = null;

  beforeAll(async () => {
    db = ownerClient();
    S = await createEphemeralTenant(db);
    await db.userProfile.update({ where: { id: S.userId }, data: { isPlatformAdmin: true } });
  });
  afterAll(async () => {
    for (const t of tenants) await t.cleanup();
    await S?.cleanup();
    await db?.$disconnect();
  });
  beforeEach(() => {
    vi.stubEnv("SAAS_BILLING_MODE", "manual");
    asUser(S.userId);
  });
  afterEach(() => {
    mp?.uninstall();
    mp = null;
    vi.unstubAllEnvs();
  });

  /** Consultorio ACTIVO con suscripción anclada al 4 y próximo cobro el 4/4/2030. */
  async function subscribed(o: { saasPlan?: SaasPlan; next?: string; anchorDay?: number; extra?: Record<string, unknown> } = {}) {
    const saasPlan = o.saasPlan ?? "INDIVIDUAL";
    const t = await createEphemeralTenant(db, { saasPlan, plan: LEGACY_PLAN_OF[saasPlan] });
    tenants.push(t);
    await db.tenant.update({ where: { id: t.tenantId }, data: { subscriptionStatus: "ACTIVE", trialEndsAt: null } });
    await db.saasSubscription.create({
      data: {
        tenantId: t.tenantId,
        anchorDay: o.anchorDay ?? 4,
        nextChargeAt: arMidnight(o.next ?? "2030-04-04"),
        // billableFrom = el primer 4: sin stub de primer período (el cargo es solo base + ajustes).
        billableFrom: dbDateFromKey(o.next ?? "2030-04-04"),
        customPriceCents: BASE,
        customPricePlan: saasPlan,
        ...(o.extra ?? {}),
      },
    });
    return t;
  }

  /** Débito ACTIVO: preapproval del flujo real, autorizado en el fake y promovido a mano (sin depender del webhook). */
  async function withActiveDebit(t: EphemeralTenant) {
    const r = await startPreapprovalFlow({ tenantId: t.tenantId, payerEmail: PAYER, actorUserId: t.userId, now: MID });
    if (!r.ok) throw new Error(`startPreapprovalFlow: ${r.reason}`);
    await authorizeFakePreapproval(r.preapprovalId);
    await db.saasSubscription.update({
      where: { tenantId: t.tenantId },
      data: {
        collectionMethod: "AUTO_DEBIT",
        autoDebitEnabled: true,
        mpPreapprovalId: r.preapprovalId,
        mpPreapprovalStatus: "authorized",
        mpPreapprovalAmountCents: BASE,
        mpPayerEmail: PAYER,
        mpPendingPreapprovalId: null,
        mpPendingInitPoint: null,
        mpPendingPayerEmail: null,
        mpPendingCreatedAt: null,
        mpPreapprovalSyncedAt: MID,
      },
    });
    return r.preapprovalId;
  }

  /** Audit doble (C-BO5): la fila global y el AuditEvent del consultorio afectado. */
  async function expectAudited(tenantId: string, action: string, n = 1) {
    expect(await db.platformAuditEvent.count({ where: { tenantId, action } })).toBe(n);
    expect(await db.auditEvent.count({ where: { tenantId, action } })).toBe(n);
  }

  it("[MPS-3b] sin superadmin → 403 en todas las actions nuevas", async () => {
    const t = await subscribed();
    asUser(t.userId);
    await expect(setAutoDebitAllowed({ tenantId: t.tenantId, allowed: false })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      addAdjustment({ tenantId: t.tenantId, kind: "CREDIT", amountCents: 100, description: "x", idempotencyKey: randomUUID() })
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getMpSubscriptionStatus({ tenantId: t.tenantId })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(previewReanchor({ tenantId: t.tenantId })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(applyReanchor({ tenantId: t.tenantId })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(undoCancelFor({ tenantId: t.tenantId })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(cancelScheduledPlanFor({ tenantId: t.tenantId })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setCustomPrice(t.tenantId, 100, "INDIVIDUAL")).rejects.toBeInstanceOf(ForbiddenError);
    const sub = await db.saasSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } });
    expect(sub.autoDebitAllowed).toBe(true);
    expect(await db.saasAdjustment.count({ where: { tenantId: t.tenantId } })).toBe(0);
  });

  it("[MPS-3b] crédito de Plataforma: negativo en la base, idempotente, audit doble y se descuenta en el próximo cargo", async () => {
    const t = await subscribed();
    const key = randomUUID();
    const r = await addAdjustment({ tenantId: t.tenantId, kind: "CREDIT", amountCents: 300_000, description: "Bonificación por el corte", idempotencyKey: key });
    expect(r).toMatchObject({ ok: true, data: { created: true } });
    if (!r.ok) return;
    const again = await addAdjustment({ tenantId: t.tenantId, kind: "CREDIT", amountCents: 300_000, description: "Bonificación por el corte", idempotencyKey: key });
    expect(again).toEqual({ ok: true, data: { adjustmentId: r.data.adjustmentId, created: false } });

    const rows = await db.saasAdjustment.findMany({ where: { tenantId: t.tenantId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "CREDIT", amountCents: -300_000, createdById: S.userId, appliedChargeId: null });
    expect(keyFromDbDate(rows[0].effectiveOn)).toBe("2030-04-04");
    await expectAudited(t.tenantId, "platform.billing.adjustment.added");

    const c = await prismaService.$transaction((tx) => createPeriodChargeInTx(tx, { tenantId: t.tenantId, now: DAY4 }));
    expect(c).toMatchObject({ kind: "created", baseCents: BASE, adjustmentsCents: -300_000, amountCents: BASE - 300_000 });
    expect((await db.saasAdjustment.findUniqueOrThrow({ where: { id: r.data.adjustmentId } })).appliedChargeId).not.toBeNull();
  });

  it("[MPS-3b] débito de Plataforma positivo; montos o tipos inválidos se rechazan sin escribir", async () => {
    const t = await subscribed();
    const ok = await addAdjustment({ tenantId: t.tenantId, kind: "DEBIT", amountCents: 50_000, description: "Cargo por migración", idempotencyKey: randomUUID(), effectiveOn: "2030-05-04" });
    expect(ok.ok).toBe(true);
    expect((await db.saasAdjustment.findFirstOrThrow({ where: { tenantId: t.tenantId } })).amountCents).toBe(50_000);
    for (const bad of [
      { kind: "CREDIT", amountCents: 0 },
      { kind: "CREDIT", amountCents: -5 },
      { kind: "DEBIT", amountCents: 10.5 },
      { kind: "PRORATION", amountCents: 100 },
      { kind: "CARRYOVER", amountCents: 100 },
    ]) {
      const r = await addAdjustment({ tenantId: t.tenantId, description: "x", idempotencyKey: randomUUID(), ...bad } as never);
      expect(r.ok).toBe(false);
    }
    const noDesc = await addAdjustment({ tenantId: t.tenantId, kind: "DEBIT", amountCents: 100, description: "   ", idempotencyKey: randomUUID() });
    expect(noDesc.ok).toBe(false);
    const ghost = await addAdjustment({ tenantId: randomUUID(), kind: "DEBIT", amountCents: 100, description: "x", idempotencyKey: randomUUID() });
    expect(ghost.ok).toBe(false);
    expect(await db.saasAdjustment.count({ where: { tenantId: t.tenantId } })).toBe(1);
  });

  it("[MPS-3b] estado en vivo del débito: GET al simulador, email enmascarado, sin datos de tarjeta ni PHI", async () => {
    mp = installSaasFakeMp();
    const t = await subscribed();
    const id = await withActiveDebit(t);
    const r = await getMpSubscriptionStatus({ tenantId: t.tenantId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toMatchObject({
      tenantId: t.tenantId,
      collectionMethod: "AUTO_DEBIT",
      autoDebitAllowed: true,
      autoDebitEnabled: true,
      preapprovalId: id,
      storedStatus: "authorized",
      liveStatus: "authorized",
      amountCents: BASE,
      liveAmountCents: BASE,
      drift: false,
    });
    expect(r.data.payerEmailMasked).toBeTruthy();
    const json = JSON.stringify(r.data);
    expect(json).not.toContain(PAYER);
    expect(keysDeep(r.data).filter((k) => FORBIDDEN_KEYS.test(k))).toEqual([]);

    // Sin MP (modo manual): no hay GET; la foto guardada sigue.
    mp.uninstall();
    mp = null;
    const off = await getMpSubscriptionStatus({ tenantId: t.tenantId });
    expect(off).toMatchObject({ ok: true, data: { storedStatus: "authorized", liveStatus: null } });
  });

  it("[MPS-3b] bloquear el débito cancela el preapproval en el simulador (después del commit) y permitirlo no lo revive", async () => {
    mp = installSaasFakeMp();
    const t = await subscribed();
    const id = await withActiveDebit(t);
    const r = await setAutoDebitAllowed({ tenantId: t.tenantId, allowed: false });
    expect(r).toEqual({ ok: true, data: { autoDebitAllowed: false, changed: true } });
    expect((await db.saasSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } })).autoDebitAllowed).toBe(false);
    expect(fakeMpGetPreapproval(id)!.status).toBe("cancelled");
    await expectAudited(t.tenantId, "platform.billing.auto_debit_allowed");

    // Repetir no audita de nuevo.
    expect(await setAutoDebitAllowed({ tenantId: t.tenantId, allowed: false })).toEqual({ ok: true, data: { autoDebitAllowed: false, changed: false } });
    await expectAudited(t.tenantId, "platform.billing.auto_debit_allowed");

    const back = await setAutoDebitAllowed({ tenantId: t.tenantId, allowed: true });
    expect(back).toEqual({ ok: true, data: { autoDebitAllowed: true, changed: true } });
    expect(fakeMpGetPreapproval(id)!.status).toBe("cancelled"); // cancelled es terminal: el titular lo vuelve a autorizar
    await expectAudited(t.tenantId, "platform.billing.auto_debit_allowed", 2);
  });

  it("[MPS-3b] re-anclar al 4: preview sin escribir, apply una vez (audit) y el segundo es no-op", async () => {
    // Ancla vieja (día 15) sin cargos.
    const t = await subscribed({ anchorDay: 15, next: "2030-04-15", extra: { billableFrom: null, autoDebitAllowed: false } });
    const p = await previewReanchor({ tenantId: t.tenantId });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.data).toMatchObject({ tenantId: t.tenantId, fromAnchorDay: 15, toAnchorDay: 4, noop: false, reenablesAutoDebit: true });
    expect(dayOfKey(p.data.newNextChargeOn)).toBe(4);
    const untouched = await db.saasSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } });
    expect(untouched.anchorDay).toBe(15);

    const a = await applyReanchor({ tenantId: t.tenantId });
    expect(a).toMatchObject({ ok: true, data: { updated: true, preview: { newNextChargeOn: p.data.newNextChargeOn } } });
    const sub = await db.saasSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } });
    expect(sub.anchorDay).toBe(4);
    expect(toARDateKey(sub.nextChargeAt!)).toBe(p.data.newNextChargeOn);
    expect(keyFromDbDate(sub.billableFrom!)).toBe(p.data.stubFrom);
    expect(sub.autoDebitAllowed).toBe(true);
    await expectAudited(t.tenantId, "platform.billing.reanchor");

    const again = await applyReanchor({ tenantId: t.tenantId });
    expect(again).toMatchObject({ ok: true, data: { updated: false, preview: { noop: true } } });
    expect(await db.saasSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } })).toMatchObject({
      nextChargeAt: sub.nextChargeAt,
      billableFrom: sub.billableFrom,
    });
    await expectAudited(t.tenantId, "platform.billing.reanchor");
    expect(await previewReanchor({ tenantId: t.tenantId })).toMatchObject({ ok: true, data: { noop: true } });

    // Sin suscripción: error claro, sin escribir.
    const bare = await createEphemeralTenant(db);
    tenants.push(bare);
    expect((await applyReanchor({ tenantId: bare.tenantId })).ok).toBe(false);
  });

  it("[MPS-3b] deshacer la baja programada desde Plataforma (audit doble); sin baja pendiente → error", async () => {
    const t = await subscribed({ extra: { cancelAtPeriodEnd: true, cancelEffectiveOn: dbDateFromKey("2030-04-04"), cancelRequestedAt: new Date() } });
    const r = await undoCancelFor({ tenantId: t.tenantId });
    expect(r).toEqual({ ok: true, data: { undone: true } });
    expect(await db.saasSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } })).toMatchObject({ cancelAtPeriodEnd: false, cancelEffectiveOn: null });
    await expectAudited(t.tenantId, "platform.billing.cancel_undone");
    const again = await undoCancelFor({ tenantId: t.tenantId });
    expect(again).toMatchObject({ ok: false, reason: "not_cancel_pending" });
    await expectAudited(t.tenantId, "platform.billing.cancel_undone");
  });

  it("[MPS-3b] anular la bajada programada desde Plataforma (audit doble); sin bajada → no_pending_plan", async () => {
    const t = await subscribed({
      saasPlan: "CONSULTORIO",
      extra: { pendingPlan: "INDIVIDUAL", pendingPlanEffectiveOn: dbDateFromKey("2030-04-04"), pendingPlanRequestedAt: new Date() },
    });
    const r = await cancelScheduledPlanFor({ tenantId: t.tenantId });
    expect(r).toEqual({ ok: true, data: { cancelled: true } });
    expect(await db.saasSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } })).toMatchObject({
      pendingPlan: null,
      pendingPlanEffectiveOn: null,
      pendingPlanDisableIds: [],
    });
    expect((await db.tenant.findUniqueOrThrow({ where: { id: t.tenantId } })).saasPlan).toBe("CONSULTORIO");
    await expectAudited(t.tenantId, "platform.billing.plan_change_cancelled");
    expect(await cancelScheduledPlanFor({ tenantId: t.tenantId })).toMatchObject({ ok: false, reason: "no_pending_plan" });
  });

  it("[MPS-3b] precio a medida atado al plan (MPS-D14): guarda customPricePlan y lo audita", async () => {
    const t = await subscribed({ saasPlan: "CONSULTORIO" });
    expect(await setCustomPrice(t.tenantId, 1_234_500, "CLINICA")).toEqual({ ok: true, data: undefined });
    expect(await db.saasSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } })).toMatchObject({
      customPriceCents: 1_234_500,
      customPricePlan: "CLINICA",
    });
    // Mismo precio, otro plan: también es un cambio (y se audita).
    expect(await setCustomPrice({ tenantId: t.tenantId, priceCents: 1_234_500, plan: "CONSULTORIO" })).toEqual({ ok: true, data: undefined });
    expect((await db.saasSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } })).customPricePlan).toBe("CONSULTORIO");
    await expectAudited(t.tenantId, "platform.billing.custom_price", 2);
    // Sin plan: el del consultorio.
    expect(await setCustomPrice(t.tenantId, 999_900)).toEqual({ ok: true, data: undefined });
    expect((await db.saasSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } })).customPricePlan).toBe("CONSULTORIO");
    // null limpia los dos.
    expect(await setCustomPrice(t.tenantId, null)).toEqual({ ok: true, data: undefined });
    expect(await db.saasSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } })).toMatchObject({ customPriceCents: null, customPricePlan: null });
    expect((await setCustomPrice(t.tenantId, 100, "PREMIUM")).ok).toBe(false);
  });

  it("[MPS-3b] el cambio de plan desde Plataforma es inmediato y sin proporcional automático (MPS-D20)", async () => {
    const t = await subscribed();
    await db.saasCharge.create({
      data: {
        tenantId: t.tenantId,
        plan: "INDIVIDUAL",
        periodStart: dbDateFromKey("2030-03-04"),
        periodEnd: dbDateFromKey("2030-04-04"),
        dueDate: dbDateFromKey("2030-03-09"),
        amountCents: BASE,
        baseAmountCents: BASE,
        adjustmentsCents: 0,
      },
    });
    const t0 = await db.tenant.findUniqueOrThrow({ where: { id: t.tenantId } });
    const r = await platformApplyPlanChange({
      tenantId: t.tenantId,
      to: "CONSULTORIO",
      disableMembershipIds: [],
      reactivateMembershipIds: [],
      expectedUpdatedAt: t0.updatedAt.toISOString(),
    });
    expect(r.ok).toBe(true);
    expect((await db.tenant.findUniqueOrThrow({ where: { id: t.tenantId } })).saasPlan).toBe("CONSULTORIO");
    expect(await db.saasAdjustment.count({ where: { tenantId: t.tenantId } })).toBe(0);
  });
});
